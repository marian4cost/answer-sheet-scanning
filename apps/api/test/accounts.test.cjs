const {test,before,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const path=mkdtempSync(join(tmpdir(),'sirenia-accounts-'));
process.env.DATABASE_URL='';process.env.DATABASE_PATH=join(path,'test.sqlite3');process.env.MEDIA_ROOT=join(path,'media');process.env.STORAGE_MODE='local';
process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='fake-anon';process.env.SUPABASE_SERVICE_ROLE_KEY='fake-service-role';
const {DatabaseService}=require('../dist/database.service.js');
const {AuthService}=require('../dist/auth.js');
const {AccountsService}=require('../dist/accounts.service.js');
const {withAccount}=require('../dist/account-context.js');
const ADMIN='11111111-1111-4111-8111-111111111111',PROF='22222222-2222-4222-8222-222222222222',SECOND='33333333-3333-4333-8333-333333333333',NEW='44444444-4444-4444-8444-444444444444';
const admin={id:ADMIN,email:'admin@example.com',role:'admin'},professor={id:PROF,email:'prof@example.com',role:'professor'};
function remote(id,email,role,confirmed=true){return {id,email,app_metadata:{role,provider:'email'},email_confirmed_at:confirmed?'2026-10-12T00:00:00Z':null,user_metadata:{display_name:role==='admin'?'Admin teste':'Professora teste',secret:'should-never-return'},created_at:'2026-10-12T00:00:00Z'};}
let db,auth,service,users,calls,app,base;
const originalFetch=globalThis.fetch;
const {createApplication}=require('../dist/bootstrap.js');
before(async()=>{db=new DatabaseService();await db.onModuleInit();auth=new AuthService(db);service=new AccountsService(auth,db);app=await createApplication(false);app.get(AuthService).user=async token=>{if(token==='admin-token')return admin;if(token==='prof-token')return professor;throw Error('Invalid session');};await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port;});
after(async()=>{await app?.close();await db.onModuleDestroy();rmSync(path,{recursive:true,force:true});});
beforeEach(t=>{users=[remote(ADMIN,admin.email,'admin'),remote(PROF,professor.email,'professor')];calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(!String(url).startsWith('https://example.supabase.co/'))return originalFetch(url,options);
  calls.push({url,options});let data,status=200;
  if(url.includes('/admin/users?'))data={users};
  else if(url.endsWith('/admin/users')&&options.method==='POST'){const body=JSON.parse(options.body);data=remote(NEW,body.email,body.app_metadata.role,false);data.user_metadata=body.user_metadata;users.push(data);}
  else {const id=url.split('/').at(-1),found=users.find(user=>user.id===id);if(!found){status=404;data={code:'not_found'};}else if(options.method==='PUT'){const body=JSON.parse(options.body);Object.assign(found,body);data=found;}else data=found;}
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
});});
afterEach(async()=>{await db.run('DELETE FROM auth_attempt_limits');});
const acting=(account,action)=>withAccount(account,action);
const createBody={email:' NEW@example.com ',nome:'Nova professora',senha:'Ficticia-123!',role:'professor'};

test('professor e contexto ausente não listam, criam nem mudam roles antes de side effects',async()=>{
  for(const action of [()=>service.list(),()=>service.create(createBody),()=>service.changeRole(PROF,{role:'admin'})]){
    await assert.rejects(acting(professor,action),error=>error.getStatus()===403);await assert.rejects(action(),error=>error.getStatus()===401);
  }assert.equal(calls.length,0);
});
test('lista administrativa contém somente perfis próprios do sistema sem segredos do provedor',async()=>{
  users.push(remote(SECOND,'student@example.com','student'));const result=await acting(admin,()=>service.list());assert.equal(result.total,2);assert.equal(result.usuarios[0].role,'admin');assert.doesNotMatch(JSON.stringify(result),/secret|should-never|fake-service-role|app_metadata|user_metadata/);
});
test('criação exige admin atual, usa senha só no provedor e mantém email pendente',async()=>{
  const result=await acting(admin,()=>service.create(createBody));assert.equal(result.id,NEW);assert.equal(result.email,'new@example.com');assert.equal(result.role,'professor');assert.equal(result.email_confirmado,false);assert.equal(result.nome,'Nova professora');
  const mutation=calls.find(call=>call.options.method==='POST');assert.deepEqual(JSON.parse(mutation.options.body),{email:'new@example.com',password:'Ficticia-123!',email_confirm:false,app_metadata:{role:'professor'},user_metadata:{display_name:'Nova professora'}});assert.doesNotMatch(JSON.stringify(result),/Ficticia|fake-service-role/);
  assert.equal((await db.get("SELECT revision FROM account_admin_locks WHERE scope='roles'")).revision>0,true);
});
test('email duplicado bloqueia antes de criar sem alterar credenciais existentes',async()=>{
  await assert.rejects(acting(admin,()=>service.create({...createBody,email:professor.email})),error=>error.getStatus()===409);assert.equal(calls.filter(call=>call.options.method==='POST').length,0);assert.equal(users.length,2);
});
test('role editável, campos extras, senha malformada e identificadores inválidos são bloqueados',async()=>{
  for(const value of [{...createBody,role:'student'},{...createBody,app_metadata:{role:'admin'}},{...createBody,owner_id:PROF},{...createBody,nome:'x'},{...createBody,email:'bad'},{...createBody,senha:'123'}])await assert.rejects(acting(admin,()=>service.create(value)),error=>error.getStatus()===400);
  await assert.rejects(acting(admin,()=>service.changeRole('bad',{role:'admin'})),error=>error.getStatus()===400);
  await assert.rejects(acting(admin,()=>service.changeRole(PROF,{role:'admin',email:'forged@example.com'})),error=>error.getStatus()===400);assert.equal(calls.length,0);
});
test('admin com role revogada após middleware não cria nem altera usuários',async()=>{
  users[0].app_metadata.role='professor';await assert.rejects(acting(admin,()=>service.create(createBody)),error=>error.getStatus()===403);assert.equal(calls.length,1);assert.equal(users.length,2);
});
test('admin não pode remover própria permissão',async()=>{
  await assert.rejects(acting(admin,()=>service.changeRole(ADMIN,{role:'professor'})),error=>error.getStatus()===409);assert.equal(calls.length,0);
});
test('role update preserva demais app_metadata e não toca senha, identidade ou histórico',async()=>{
  const result=await acting(admin,()=>service.changeRole(PROF,{role:'admin'}));assert.equal(result.role,'admin');const mutation=calls.find(call=>call.options.method==='PUT');assert.deepEqual(JSON.parse(mutation.options.body),{app_metadata:{role:'admin',provider:'email'}});
  const secondActor={...professor,role:'admin'};const downgraded=await acting(secondActor,()=>service.changeRole(ADMIN,{role:'professor'}));assert.equal(downgraded.role,'professor');assert.equal(users[1].app_metadata.role,'admin');
});
test('último admin confirmado é preservado mesmo quando outra conta admin ainda está pendente',async()=>{
  users.push(remote(SECOND,'pending-admin@example.com','admin',false));
  const pendingActor={id:SECOND,email:'pending-admin@example.com',role:'admin'};
  await assert.rejects(acting(pendingActor,()=>service.changeRole(ADMIN,{role:'professor'})),error=>error.getStatus()===403);assert.equal(users[0].app_metadata.role,'admin');
});
test('último admin confirmado nunca é rebaixado quando a listagem do provedor está incompleta',async()=>{
  users.push(remote(SECOND,'second-admin@example.com','admin'));
  const original=auth.providerAccounts;auth.providerAccounts=async()=>[remote(PROF,professor.email,'admin')];
  try{await assert.rejects(acting({id:SECOND,email:'second-admin@example.com',role:'admin'},()=>service.changeRole(PROF,{role:'professor'})),error=>error.getStatus()===409);}finally{auth.providerAccounts=original;}
  assert.equal(calls.filter(call=>call.options.method==='PUT').length,0);
});
test('rebaixamentos concorrentes são serializados e preservam um administrador ativo',async()=>{
  users[1].app_metadata.role='admin';
  const other={...professor,role:'admin'};
  const results=await Promise.allSettled([acting(admin,()=>service.changeRole(PROF,{role:'professor'})),acting(other,()=>service.changeRole(ADMIN,{role:'professor'}))]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(users.filter(user=>user.app_metadata.role==='admin').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.getStatus(),403);
});
test('professor pode alterar apenas o próprio nome; payload não pode promover role ou trocar id',async()=>{
  const result=await acting(professor,()=>service.updateProfile({nome:'Professor atualizado'}));assert.equal(result.id,PROF);assert.equal(result.role,'professor');assert.equal(result.nome,'Professor atualizado');
  const mutation=calls.find(call=>call.options.method==='PUT');assert.deepEqual(JSON.parse(mutation.options.body),{user_metadata:{display_name:'Professor atualizado',secret:'should-never-return'}});
  await assert.rejects(acting(professor,()=>service.updateProfile({nome:'Nome teste',role:'admin'})),error=>error.getStatus()===400);await assert.rejects(acting(professor,()=>service.updateProfile({nome:'Nome teste',id:ADMIN})),error=>error.getStatus()===400);
});
test('quotas administrativas limitam abuso antes de consultas ao provedor',async()=>{
  const original=auth.quota;auth.quota=async()=>{const e=new Error('quota');e.getStatus=()=>429;throw e;};try{await assert.rejects(acting(admin,()=>service.create(createBody)),error=>error.getStatus()===429);await assert.rejects(acting(admin,()=>service.changeRole(PROF,{role:'admin'})),error=>error.getStatus()===429);assert.equal(calls.length,0);}finally{auth.quota=original;}
});

test('HTTP professor não lista nem cria contas; papel enviado em payload não promove permissão',async()=>{
  for(const [url,method,body] of [['/api/contas','GET',null],['/api/contas','POST',createBody],['/api/contas/'+ADMIN+'/role','PATCH',{role:'admin'}]]){
    const response=await fetch(base+url,{method,headers:{Authorization:'Bearer prof-token','X-OMR-Client':'web','Content-Type':'application/json',Origin:'http://localhost:3000'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,403);
  }assert.equal(calls.length,0);
});
test('HTTP PATCH role e PUT perfil exigem X-OMR-Client e origem autorizada antes de alterar provedor',async()=>{
  for(const [url,method,body] of [['/api/contas/'+PROF+'/role','PATCH',{role:'admin'}],['/api/contas/perfil','PUT',{nome:'Nome correto'}]])for(const extra of [{Origin:'http://localhost:3000'},{Origin:'https://evil.example','X-OMR-Client':'web'}]){
    const response=await fetch(base+url,{method,headers:{Authorization:'Bearer admin-token','Content-Type':'application/json',...extra},body:JSON.stringify(body)});assert.equal(response.status,403);const data=await response.json();assert.match(data.message,/Requisição/);
  }assert.equal(calls.length,0);
  const preflight=await fetch(base+'/api/contas/'+PROF+'/role',{method:'OPTIONS',headers:{Origin:'http://localhost:3000','Access-Control-Request-Method':'PATCH','Access-Control-Request-Headers':'content-type,x-omr-client'}});assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-methods'),/PATCH/);
});
