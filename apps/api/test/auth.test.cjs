const {test,beforeEach,afterEach} = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL='https://example.supabase.co';
process.env.SUPABASE_ANON_KEY='mock-only-anon-key';
const {AuthService,authRequired,teacherAllowed,requestToken,accountRole}=require('../dist/auth.js');
const {currentAccount}=require('../dist/account-context.js');
const UUID='11111111-1111-4111-8111-111111111111';
const user={id:UUID,email:'teacher@example.com',email_confirmed_at:'2026-10-10T00:00:00Z',app_metadata:{role:'professor'},user_metadata:{display_name:'Professora Teste'}};
const envNames=['AUTH_ENABLED','VERCEL','TEACHER_EMAILS','SUPABASE_ANON_KEY','WEB_URL','CORS_ORIGINS','AUTH_REGISTRATION_ENABLED','SUPABASE_SERVICE_ROLE_KEY'];
let saved;
beforeEach(()=>{saved=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));process.env.AUTH_REGISTRATION_ENABLED='true';process.env.AUTH_ENABLED='false';delete process.env.VERCEL;process.env.TEACHER_EMAILS='teacher@example.com';process.env.SUPABASE_ANON_KEY='mock-only-anon-key';process.env.SUPABASE_SERVICE_ROLE_KEY='fake-server-key';process.env.WEB_URL='';process.env.CORS_ORIGINS='';});
afterEach(()=>{for(const key of envNames)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];});
function request({method='GET',path='/api/simulados',headers={}}={}){return {method,path,headers,get(name){return headers[name.toLowerCase()];}};}
function response(){return {statusCode:200,body:null,headers:{},cookies:[],cleared:[],status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;},setHeader(key,value){this.headers[key]=value;},cookie(...args){this.cookies.push(args);},clearCookie(...args){this.cleared.push(args);}};}
async function middleware(auth,req){const res=response();let calls=0,identity;await auth.middleware()(req,res,()=>{calls++;try{identity=currentAccount();}catch{}});return {...res,nextCalls:calls,identity};}
function provider(t,body,{status=200}={}){const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});});return calls;}
function routerProvider(t,handler){const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});const result=handler(url,options);return new Response(JSON.stringify(result.body??result),{status:result.status??200,headers:{'Content-Type':'application/json'}});});return calls;}

test('somente role protegida e email confirmado permitem acesso; allowlist e flag antiga não autorizam',()=>{
  assert.equal(teacherAllowed(user),true);assert.equal(teacherAllowed({...user,app_metadata:{role:'admin'}}),true);
  assert.equal(teacherAllowed({...user,app_metadata:{role:'teacher'}}),true);
  for(const candidate of [{email:user.email},{...user,email_confirmed_at:null},{...user,app_metadata:{}},{...user,app_metadata:{role:'student'},user_metadata:{role:'admin'}},{...user,banned_until:'2999-01-01T00:00:00Z'},{}])assert.equal(teacherAllowed(candidate),false);
  assert.equal(accountRole({app_metadata:{role:'teacher'}}),'professor');
});
test('cadastro público permanece desativado mesmo com AUTH_REGISTRATION_ENABLED=true',async(t)=>{
  const calls=provider(t,{}),auth=new AuthService();assert.equal(auth.config().registration_enabled,false);
  await assert.rejects(auth.signup('nova@example.com','Ficticia-123!'),error=>error.getStatus()===403);
  await assert.rejects(auth.login(user.email,'123456',response(),true),error=>error.getStatus()===403);assert.equal(calls.length,0);
});
test('login por senha valida identidade atual no Supabase, sem expor senha ou sessão',async(t)=>{
  const calls=routerProvider(t,url=>url.includes('/token?')?{access_token:'private-session',expires_in:3600}:user),res=response();
  const result=await new AuthService().passwordLogin(' TEACHER@example.com ','Ficticia-123!',res);
  assert.match(calls[0].url,/grant_type=password/);assert.deepEqual(JSON.parse(calls[0].options.body),{email:user.email,password:'Ficticia-123!'});
  assert.equal(result.id,UUID);assert.equal(result.role,'professor');assert.equal(result.nome,'Professora Teste');assert.equal(res.cookies[0][2].httpOnly,true);
  assert.doesNotMatch(JSON.stringify(result),/private-session|Ficticia|fake-server-key/);
});
test('login por senha de outra conta ou role removida não cria cookie',async(t)=>{
  for(const identity of [{...user,email:'outra@example.com'},{...user,app_metadata:{}},{...user,email_confirmed_at:null}]){
    t.mock.method(globalThis,'fetch',async url=>new Response(JSON.stringify(url.includes('/token?')?{access_token:'session'}:identity),{status:200}));
    const res=response();await assert.rejects(new AuthService().passwordLogin(user.email,'Ficticia-123!',res));assert.equal(res.cookies.length,0);t.mock.restoreAll();
  }
});
test('OTP consulta conta existente e role antes de gerar código sem criar usuário',async(t)=>{
  const calls=routerProvider(t,url=>url.includes('admin/users?')?{users:[{...user,email_confirmed_at:null}]}:{email_otp:'12345678'}),messages=[];
  const auth=new AuthService(undefined,{configured:()=>true,send:async(...args)=>messages.push(args)}),result=await auth.requestCode(' TEACHER@example.com ');
  assert.match(calls[0].url,/admin\/users\?page=1&per_page=200/);assert.match(calls[1].url,/admin\/generate_link$/);
  assert.deepEqual(JSON.parse(calls[1].options.body),{type:'magiclink',email:user.email});assert.equal(messages[0][0],user.email);assert.match(messages[0][2],/12345678/);assert.doesNotMatch(JSON.stringify(result),/12345678|fake-server-key/);
});
test('email desconhecido ou não administrado não gera magiclink nem envia email',async(t)=>{
  for(const users of [[],[{...user,app_metadata:{role:'student'}}],[{...user,banned_until:'2999-01-01'}]]){
    const calls=provider(t,{users}),messages=[],auth=new AuthService(undefined,{configured:()=>true,send:async(...args)=>messages.push(args)});
    await assert.rejects(auth.requestCode(user.email),error=>error.getStatus()===403);assert.equal(calls.length,1);assert.equal(messages.length,0);assert.match(calls[0].url,/admin\/users/);t.mock.restoreAll();
  }
});
test('OTP fallback usa create_user:false e callback do frontend',async(t)=>{
  process.env.WEB_URL='https://frontend.example.com/';const calls=routerProvider(t,url=>url.includes('admin/users?')?{users:[user]}:{});
  const result=await new AuthService().requestCode(user.email);assert.match(result.message,/link de acesso/);
  const url=new URL(calls[1].url);assert.equal(url.pathname,'/auth/v1/otp');assert.equal(url.searchParams.get('redirect_to'),'https://frontend.example.com/login');assert.deepEqual(JSON.parse(calls[1].options.body),{email:user.email,create_user:false});
});
test('admin-list é paginada; serviço administrativo ausente não usa signup como fallback',async(t)=>{
  const filler=Array.from({length:200},(_,i)=>({...user,id:UUID,email:'conta'+i+'@example.com'}));
  const calls=routerProvider(t,url=>url.includes('page=1')?{users:filler}:{users:[user]});const users=await new AuthService().providerAccounts();assert.equal(users.length,201);assert.equal(calls.length,2);
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;await assert.rejects(new AuthService().requestCode(user.email),error=>error.getStatus()===503);assert.equal(calls.length,2);
});
test('autenticação é obrigatória local e nuvem, independentemente da flag histórica',()=>{
  for(const cloud of [undefined,'1']){if(cloud)process.env.VERCEL=cloud;else delete process.env.VERCEL;for(const value of ['false','true','','FALSE','invalid']){process.env.AUTH_ENABLED=value;assert.equal(authRequired(),true);}}
});
test('proteções privadas e cadastro removido fecham sem sessão antes de consultar dados',async(t)=>{
  const calls=provider(t,user),auth=new AuthService();for(const path of ['/api/simulados','/api/contatos','/api/auth/me','/api/contas','/api/contas/perfil','/api/auth/cadastro','/api/resultados/1/imagem']){const res=await middleware(auth,request({path}));assert.equal(res.nextCalls,0);assert.equal(res.statusCode,401);assert.equal(res.headers['Cache-Control'],'private, no-store');}assert.equal(calls.length,0);
});
test('extração de token usa Bearer e nome exato do cookie',()=>{
  assert.equal(requestToken(request({headers:{authorization:'Bearer token-header',cookie:'enem_session=token-cookie'}})),'token-header');
  assert.equal(requestToken(request({headers:{cookie:'unrelated=1; enem_session=abc.def.ghi; last=2'}})),'abc.def.ghi');assert.equal(requestToken(request({headers:{cookie:'enem_session_evil=bad'}})),'');assert.equal(requestToken(request()),'');
});
test('somente endpoints públicos exatos e OPTIONS passam sem sessão',async(t)=>{
  const calls=provider(t,user),auth=new AuthService();for(const path of ['/api/health','/api/auth/config','/api/auth/codigo','/api/auth/login','/api/auth/session','/api/auth/logout','/api/auth/senha'])assert.equal((await middleware(auth,request({path}))).nextCalls,1,path);
  assert.equal((await middleware(auth,request({method:'OPTIONS'}))).nextCalls,1);assert.equal((await middleware(auth,request({path:'/api/auth/login/extra'}))).statusCode,401);assert.equal(calls.length,0);
});
test('identidade atual validada cria contexto com role; cabeçalhos e user_metadata não alteram permissão',async(t)=>{
  const calls=provider(t,{...user,user_metadata:{role:'admin',display_name:'Nome\nSeguro'}}),res=await middleware(new AuthService(),request({headers:{authorization:'Bearer professor-jwt','x-role':'admin'}}));
  assert.equal(res.nextCalls,1);assert.equal(res.identity.role,'professor');assert.equal(res.identity.nome,'NomeSeguro');assert.equal(calls[0].options.headers.Authorization,'Bearer professor-jwt');
});
test('role removida vale imediatamente para o mesmo token revalidado',async(t)=>{
  let identity=user;const calls=routerProvider(t,()=>identity),auth=new AuthService(),req=request({headers:{authorization:'Bearer old-jwt'}});
  assert.equal((await middleware(auth,req)).nextCalls,1);identity={...user,app_metadata:{role:'student'}};assert.equal((await middleware(auth,req)).statusCode,403);assert.equal(calls.length,2);
});
test('configuração ausente, erro de rede, JWT expirado e JSON inválido sempre fecham acesso',async(t)=>{
  const auth=new AuthService(),req=request({headers:{authorization:'Bearer token'}}),mock=t.mock.method(globalThis,'fetch',async()=>{throw new Error('offline');});assert.equal((await middleware(auth,req)).statusCode,401);
  mock.mock.mockImplementation(async()=>new Response(JSON.stringify({error:'invalid JWT'}),{status:401}));assert.equal((await middleware(auth,req)).statusCode,401);
  mock.mock.mockImplementation(async()=>new Response('not json',{status:200}));assert.equal((await middleware(auth,req)).statusCode,401);
  delete process.env.SUPABASE_ANON_KEY;assert.deepEqual(auth.config(),{required:true,configured:false,registration_enabled:false});assert.equal((await middleware(auth,req)).statusCode,401);
});
test('token vazio, UUID inválido e email/code/password malformados são bloqueados',async(t)=>{
  const calls=provider(t,{...user,id:'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}),auth=new AuthService();await assert.rejects(auth.user(''));await assert.rejects(auth.user('x'.repeat(8001)));assert.equal(calls.length,0);await assert.rejects(auth.user('token'),error=>error.getStatus()===401);
  for(const email of [null,123,'sem-email','x\n@y.com'])await assert.rejects(auth.requestCode(email),error=>error.getStatus()===400);
  for(const code of ['123','abcdef','12345678901',null])await assert.rejects(auth.login(user.email,code,response()),error=>error.getStatus()===400);
  for(const password of ['curta',null,'x'.repeat(129)])await assert.rejects(auth.passwordLogin(user.email,password,response()),error=>error.getStatus()===400);assert.equal(calls.length,1);
});
test('verificação de OTP usa email, identidade correta e cookie Secure HttpOnly com TTL limitado',async(t)=>{
  const calls=routerProvider(t,url=>url.endsWith('/verify')?{access_token:'verified-jwt',expires_in:7200}:user),res=response(),result=await new AuthService().login(user.email,'123456',res);
  assert.equal(result.email,user.email);assert.deepEqual(JSON.parse(calls[0].options.body),{email:user.email,token:'123456',type:'email'});assert.equal(res.cookies.length,1);const [name,value,config]=res.cookies[0];assert.equal(name,'enem_session');assert.equal(value,'verified-jwt');assert.equal(config.httpOnly,true);assert.equal(config.secure,true);assert.equal(config.sameSite,'lax');assert.equal(config.maxAge,3600000);
});
test('OTP de outro email, conta sem role e código rejeitado nunca criam sessão',async(t)=>{
  for(const identity of [{...user,email:'outra@example.com'},{...user,app_metadata:{}}]){routerProvider(t,url=>url.endsWith('/verify')?{access_token:'verified'}:identity);const res=response();await assert.rejects(new AuthService().login(user.email,'123456',res));assert.equal(res.cookies.length,0);t.mock.restoreAll();}
  provider(t,{error:'wrong code'},{status:400});const res=response();await assert.rejects(new AuthService().login(user.email,'123456',res));assert.equal(res.cookies.length,0);
});
test('limites IP e email são aplicados antes de lookup ou verificação remota',async(t)=>{
  const calls=provider(t,user),db={get:async()=>undefined},auth=new AuthService(db);
  for(const action of [()=>auth.requestCode(user.email),()=>auth.passwordLogin(user.email,'Ficticia-123!',response()),()=>auth.login(user.email,'123456',response())])await assert.rejects(action(),error=>error.getStatus()===429);assert.equal(calls.length,0);
});
test('logout e sessão preservam Secure HttpOnly e nunca retornam tokens',async(t)=>{
  provider(t,user);const auth=new AuthService(),res=response(),result=await auth.session('mock-token',res);assert.equal(result.role,'professor');assert.doesNotMatch(JSON.stringify(result),/mock-token/);assert.equal(res.cookies[0][2].secure,true);assert.deepEqual(auth.logout(res),{ok:true});assert.equal(res.cleared[0][1].httpOnly,true);assert.equal(res.cleared[0][1].secure,true);
});
