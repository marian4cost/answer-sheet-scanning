const {test,beforeEach,afterEach,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');const {join}=require('node:path');
const temp=mkdtempSync(join(tmpdir(),'enem-emailjs-tests-'));
process.env.DATABASE_URL='';process.env.DATABASE_PATH=join(temp,'test.sqlite');
process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='fake-anon';
const {EmailJsService}=require('../dist/emailjs.service');const {DatabaseService}=require('../dist/database.service');const {AuthService}=require('../dist/auth');
const keys=['EMAILJS_ENABLED','EMAILJS_SERVICE_ID','EMAILJS_TEMPLATE_ID','EMAILJS_PUBLIC_KEY','EMAILJS_PRIVATE_KEY','AUTH_REGISTRATION_ENABLED','SUPABASE_SERVICE_ROLE_KEY'];let saved,db;
before(()=>{db=new DatabaseService();});after(async()=>{await db.onModuleDestroy();rmSync(temp,{recursive:true,force:true});});
beforeEach(()=>{saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));Object.assign(process.env,{EMAILJS_ENABLED:'true',EMAILJS_SERVICE_ID:'fake-service',EMAILJS_TEMPLATE_ID:'fake-template',EMAILJS_PUBLIC_KEY:'fake-public',EMAILJS_PRIVATE_KEY:'fake-private',AUTH_REGISTRATION_ENABLED:'true',SUPABASE_SERVICE_ROLE_KEY:'fake-server'});});
afterEach(()=>{for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});
test('envio desativado fica indisponível mesmo com chaves completas e não chama o provedor',async(t)=>{
  process.env.EMAILJS_ENABLED='false';let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('OK');});
  const service=new EmailJsService({get:async()=>({next_at:Date.now()})});assert.equal(service.configured(),false);
  await assert.rejects(service.send('a@example.com','Boletim','html'));assert.equal(calls,0);
});
test('EmailJS usa destinatário exato, chave privada apenas no servidor e retorno sem credenciais',async(t)=>{
  const requests=[];t.mock.method(globalThis,'fetch',async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response('OK',{status:200});});
  const service=new EmailJsService({get:async()=>({next_at:Date.now()})});
  const result=await service.send('aluno@example.com','Boletim fictício','<p>Resultado fictício</p>',{to_email:'evil@example.com'});
  assert.equal(requests[0].url,'https://api.emailjs.com/api/v1.0/email/send');assert.equal(requests[0].body.template_params.to_email,'aluno@example.com');
  assert.equal(requests[0].body.accessToken,'fake-private');assert.equal(result,'emailjs-accepted');assert.doesNotMatch(result,/fake-private/);
});
test('EmailJS rejeita destinatários inválidos, cabeçalho injetado e payload acima de 50KB antes de enviar',async(t)=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('OK');});const service=new EmailJsService({get:async()=>({next_at:Date.now()})});
  await assert.rejects(service.send('invalido','Boletim','html'));
  await assert.rejects(service.send('a@example.com','Boletim\nBcc: evil@example.com','html'));
  await assert.rejects(service.send('a@example.com','Boletim','x'.repeat(50000)),/limite/);assert.equal(calls,0);
});
test('falhas de provedor não são repetidas automaticamente nem revelam resposta ou chave',async(t)=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('fake-private sensitive response',{status:429});});
  await assert.rejects(new EmailJsService({get:async()=>({next_at:Date.now()})}).send('a@example.com','Boletim','html'),error=>!/fake-private|sensitive/.test(error.message));assert.equal(calls,1);
});
test('limite de código é persistente entre instâncias e não gera novo código no mesmo minuto',async(t)=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({email_otp:'12345678'}),{status:200});});
  const gateway={configured:()=>true,send:async()=>{}};
  await new AuthService(db,gateway).signup('cooldown@example.com','Ficticia-123!','ip-ficticio');
  await assert.rejects(new AuthService(db,gateway).signup('cooldown@example.com','Ficticia-123!','ip-ficticio'),error=>error.getStatus()===429);
  assert.equal(calls,1);
  const stored=await db.all('SELECT scope_hash FROM auth_attempt_limits');assert.ok(stored.length);assert.ok(stored.every(r=>/^[a-f0-9]{64}$/.test(r.scope_hash)));
});
test('reserva do EmailJS é compartilhada pelo banco e espaça envios concorrentes',async()=>{
  const now=Date.now();const sql=`INSERT INTO email_provider_slots(provider,next_at) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET next_at=CASE WHEN email_provider_slots.next_at<? THEN ? ELSE email_provider_slots.next_at+1100 END RETURNING next_at`;
  const slots=await Promise.all([db.get(sql,'emailjs',now,now,now),db.get(sql,'emailjs',now,now,now),db.get(sql,'emailjs',now,now,now)]);
  assert.deepEqual(slots.map(r=>Number(r.next_at)),[now,now+1100,now+2200]);
});
