const {test,beforeEach,afterEach} = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'mock-only-anon-key';
const {AuthService,authRequired,teacherAllowed,requestToken} = require('../dist/auth.js');
const envNames = ['AUTH_ENABLED','VERCEL','TEACHER_EMAILS','SUPABASE_ANON_KEY','WEB_URL','CORS_ORIGINS','AUTH_REGISTRATION_ENABLED','SUPABASE_SERVICE_ROLE_KEY'];
let saved;
beforeEach(() => {saved=Object.fromEntries(envNames.map(key=>[key,process.env[key]]));process.env.AUTH_REGISTRATION_ENABLED='false';process.env.AUTH_ENABLED='true';delete process.env.VERCEL;process.env.TEACHER_EMAILS='teacher@example.com, SECOND@example.com';process.env.SUPABASE_ANON_KEY='mock-only-anon-key';process.env.WEB_URL='';process.env.CORS_ORIGINS='';});
afterEach(() => {for(const key of envNames) if(saved[key]===undefined) delete process.env[key];else process.env[key]=saved[key];});
function request({method='GET',path='/api/simulados',headers={}}={}) {return {method,path,headers,get(name){return headers[name.toLowerCase()];}};}
function response() {return {statusCode:200,body:null,headers:{},cookies:[],cleared:[],status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;},setHeader(key,value){this.headers[key]=value;},cookie(...args){this.cookies.push(args);},clearCookie(...args){this.cleared.push(args);}};}
async function middleware(auth,req) {const res=response();let calls=0;await auth.middleware()(req,res,()=>calls++);return {...res,nextCalls:calls};}
function provider(t,body,{status=200}={}) {const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});});return calls;}

test('allowlist ignora diferenças de caixa e espaços do cadastro, mas bloqueia aluno e email ausente',()=>{
  assert.equal(teacherAllowed({email:'TEACHER@EXAMPLE.COM'}),true);assert.equal(teacherAllowed({email:'second@example.com'}),true);
  assert.equal(teacherAllowed({email:'aluno@example.com'}),false);assert.equal(teacherAllowed({}),false);assert.equal(teacherAllowed({email:'teacher@example.com.evil'}),false);
});
test('cadastro aberto permite apenas identidades com email confirmado pelo Supabase',()=>{
  process.env.AUTH_REGISTRATION_ENABLED='true';
  assert.equal(teacherAllowed({email:'nova@example.com'}),false);
  assert.equal(teacherAllowed({email:'nova@example.com',email_confirmed_at:'2026-10-10T00:00:00Z'}),true);
  assert.equal(teacherAllowed({email:'nova@example.com',user_metadata:{email_confirmed_at:'forged'}}),false);
});
test('login por senha valida credenciais no Supabase e nunca retorna senha ou token',async(t)=>{
  process.env.AUTH_REGISTRATION_ENABLED='true';
  const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('/token?')?{access_token:'private-session',expires_in:3600}:{email:'nova@example.com',email_confirmed_at:'confirmed'}),{status:200});});
  const res=response(),result=await new AuthService().passwordLogin('Nova@example.com','Ficticia-123!',res);
  assert.match(calls[0].url,/grant_type=password/);assert.deepEqual(JSON.parse(calls[0].options.body),{email:'nova@example.com',password:'Ficticia-123!'});
  assert.deepEqual(result,{email:'nova@example.com'});assert.equal(res.cookies[0][2].httpOnly,true);
});
test('cadastro gera OTP no servidor e envia somente o código pelo EmailJS, sem senha',async(t)=>{
  process.env.AUTH_REGISTRATION_ENABLED='true';process.env.SUPABASE_SERVICE_ROLE_KEY='fake-server-key';
  const calls=provider(t,{email_otp:'12345678'}),messages=[];
  const auth=new AuthService(undefined,{configured:()=>true,send:async(...args)=>messages.push(args)});
  const result=await auth.signup('nova@example.com','Ficticia-123!');
  assert.match(calls[0].url,/admin\/generate_link$/);assert.equal(JSON.parse(calls[0].options.body).type,'signup');
  assert.equal(messages[0][0],'nova@example.com');assert.match(messages[0][2],/12345678/);assert.doesNotMatch(JSON.stringify(messages),/Ficticia/);assert.doesNotMatch(JSON.stringify(result),/12345678|fake-server-key/);
});
test('confirmação de cadastro usa tipo signup e não aceita sessão de outro email',async(t)=>{
  process.env.AUTH_REGISTRATION_ENABLED='true';const calls=[];
  const mock=t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/verify')?{access_token:'verified'}:{email:'nova@example.com',email_confirmed_at:'confirmed'}),{status:200});});
  await new AuthService().login('nova@example.com','12345678',response(),true);assert.equal(JSON.parse(calls[0].options.body).type,'signup');
  mock.mock.mockImplementation(async(url)=>new Response(JSON.stringify(url.endsWith('/verify')?{access_token:'verified'}:{email:'outra@example.com',email_confirmed_at:'confirmed'}),{status:200}));
  const res=response();await assert.rejects(new AuthService().login('nova@example.com','12345678',res,true));assert.equal(res.cookies.length,0);
});
test('cadastro com senha curta ou serviço ausente não gera código nem envia mensagem',async(t)=>{
  process.env.AUTH_REGISTRATION_ENABLED='true';const calls=provider(t,{}),auth=new AuthService();
  await assert.rejects(auth.signup('nova@example.com','curta'),error=>error.getStatus()===400);
  await assert.rejects(auth.signup('nova@example.com','Ficticia-123!'),error=>error.getStatus()===503);assert.equal(calls.length,0);
});
test('role teacher usa apenas app_metadata validado e não aceita metadados editáveis pelo aluno',()=>{
  assert.equal(teacherAllowed({email:'outra@example.com',app_metadata:{role:'teacher'}}),true);
  assert.equal(teacherAllowed({email:'outra@example.com',user_metadata:{role:'teacher'}}),false);
  assert.equal(teacherAllowed({email:'outra@example.com',app_metadata:{role:'student'}}),false);
});
test('flag false desativa login explicitamente, inclusive na nuvem; demais valores preservam o padrão',()=>{
  process.env.AUTH_ENABLED='false';delete process.env.VERCEL;assert.equal(authRequired(),false);
  process.env.VERCEL='1';assert.equal(authRequired(),false);
  for (const value of ['true','','FALSE','invalid']) {process.env.AUTH_ENABLED=value;assert.equal(authRequired(),true);}
  delete process.env.AUTH_ENABLED;assert.equal(authRequired(),true);
});
test('login desativado libera leitura e gravação sem sessão ou consulta ao Supabase',async(t)=>{
  process.env.VERCEL='1';process.env.AUTH_ENABLED='false';
  const calls=provider(t,{email:'teacher@example.com'}),auth=new AuthService();assert.equal(auth.config().required,false);
  for(const [method,path] of [['GET','/api/simulados'],['POST','/api/simulados'],['GET','/api/contatos'],['GET','/api/resultados/1/boletim/pdf']]) {
    const res=await middleware(auth,request({method,path}));assert.equal(res.nextCalls,1);assert.equal(res.headers['Cache-Control'],'private, no-store');
  }
  assert.equal(calls.length,0);
});
test('extração de token respeita Bearer e o nome exato do cookie, sem usar outros cookies',()=>{
  assert.equal(requestToken(request({headers:{authorization:'Bearer token-header',cookie:'enem_session=token-cookie'}})),'token-header');
  assert.equal(requestToken(request({headers:{cookie:'unrelated=1; enem_session=abc.def.ghi; last=2'}})),'abc.def.ghi');
  assert.equal(requestToken(request({headers:{cookie:'enem_session_evil=bad; other=x'}})),'');
  assert.equal(requestToken(request()),'');
});
test('middleware bloqueia contatos, boletins, PDFs e imagens sem token antes de ler dados',async(t)=>{
  const calls=provider(t,{email:'teacher@example.com'});const auth=new AuthService();
  for(const path of ['/api/contatos','/api/simulados/1/boletins','/api/resultados/1/boletim/pdf','/media/debug_images/private.png']) {
    const res=await middleware(auth,request({path}));assert.equal(res.statusCode,401,path);assert.equal(res.nextCalls,0,path);
  }
  assert.equal(calls.length,0);
});
test('somente rotas públicas de autenticação/health e OPTIONS passam sem sessão',async(t)=>{
  const calls=provider(t,{email:'teacher@example.com'});const auth=new AuthService();
  for(const path of ['/api/health','/api/auth/config','/api/auth/codigo','/api/auth/login','/api/auth/session','/api/auth/logout']) assert.equal((await middleware(auth,request({path}))).nextCalls,1,path);
  assert.equal((await middleware(auth,request({method:'OPTIONS'}))).nextCalls,1);
  assert.equal((await middleware(auth,request({path:'/api/auth/login/extra'}))).statusCode,401);assert.equal(calls.length,0);
});
test('conta válida de professor libera a rota e define cache privado sem armazenamento',async(t)=>{
  const calls=provider(t,{email:'teacher@example.com'});const result=await middleware(new AuthService(),request({headers:{cookie:'enem_session=mock-jwt'}}));
  assert.equal(result.nextCalls,1);assert.equal(result.headers['Cache-Control'],'private, no-store');
  assert.equal(calls[0].options.headers.Authorization,'Bearer mock-jwt');assert.match(calls[0].url,/\/auth\/v1\/user$/);
});
test('conta autenticada de aluno recebe 403 e nunca acessa dados dos simulados',async(t)=>{
  provider(t,{email:'student@example.com',user_metadata:{role:'teacher'}});
  const result=await middleware(new AuthService(),request({headers:{authorization:'Bearer student-jwt'}}));assert.equal(result.statusCode,403);assert.equal(result.nextCalls,0);
});
test('nuvem sem configuração de acesso fecha a rota em vez de permitir acesso anônimo',async(t)=>{
  process.env.VERCEL='1';delete process.env.AUTH_ENABLED;delete process.env.SUPABASE_ANON_KEY;
  const calls=provider(t,{email:'teacher@example.com'});const auth=new AuthService();assert.deepEqual(auth.config(),{required:true,configured:false,registration_enabled:false});
  const result=await middleware(auth,request({headers:{authorization:'Bearer mock-jwt'}}));assert.equal(result.statusCode,401);assert.equal(result.nextCalls,0);assert.equal(calls.length,0);
});
test('erro de rede, JWT expirado e corpo de autenticação inválido nunca liberam a rota',async(t)=>{
  const auth=new AuthService(),req=request({headers:{authorization:'Bearer mock-jwt'}});
  const mocked=t.mock.method(globalThis,'fetch',async()=>{throw new Error('network offline');});
  assert.equal((await middleware(auth,req)).statusCode,401);
  mocked.mock.mockImplementation(async()=>new Response(JSON.stringify({error:'invalid JWT'}),{status:401}));assert.equal((await middleware(auth,req)).statusCode,401);
  mocked.mock.mockImplementation(async()=>new Response('not json',{status:200}));assert.equal((await middleware(auth,req)).statusCode,401);
});
test('token vazio ou excessivo é rejeitado antes de consultar o provedor',async(t)=>{
  const calls=provider(t,{email:'teacher@example.com'});const auth=new AuthService();
  await assert.rejects(auth.user(''),/Entre/);await assert.rejects(auth.user('x'.repeat(8001)),/Entre/);assert.equal(calls.length,0);
});
test('pedido de OTP bloqueia email fora da allowlist antes de enviar qualquer mensagem',async(t)=>{
  const calls=provider(t,{});await assert.rejects(new AuthService().requestCode('student@example.com'),error=>error.getStatus()===403);assert.equal(calls.length,0);
});
test('pedido de OTP autorizado usa apenas o endereço da allowlist normalizado',async(t)=>{
  const calls=provider(t,{});const result=await new AuthService().requestCode(' TEACHER@EXAMPLE.COM ');
  assert.match(result.message,/Confira/);assert.equal(calls.length,1);assert.match(calls[0].url,/\/otp$/);assert.deepEqual(JSON.parse(calls[0].options.body),{email:'teacher@example.com',create_user:true});
});
test('emails/códigos malformados e conta não autorizada são bloqueados antes da verificação',async(t)=>{
  const calls=provider(t,{});const auth=new AuthService();
  for(const email of [null,123,'sem-email','x\n@y.com']) await assert.rejects(auth.requestCode(email),error=>error.getStatus()===400);
  for(const code of ['123','abcdef','12345678901',null]) await assert.rejects(auth.login('teacher@example.com',code,response()),error=>error.getStatus()===400);
  await assert.rejects(auth.login('student@example.com','123456',response()),error=>error.getStatus()===403);assert.equal(calls.length,0);
});
test('login valida código e identidade com o provedor antes de criar cookie seguro HttpOnly',async(t)=>{
  const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/verify')?{access_token:'verified-jwt',expires_in:7200}:{email:'teacher@example.com'}),{status:200});});
  const res=response(),result=await new AuthService().login('teacher@example.com','123456',res);
  assert.equal(result.email,'teacher@example.com');assert.equal(calls.length,2);assert.equal(res.cookies.length,1);
  const [name,value,config]=res.cookies[0];assert.equal(name,'enem_session');assert.equal(value,'verified-jwt');assert.equal(config.httpOnly,true);assert.equal(config.secure,true);assert.equal(config.sameSite,'lax');assert.equal(config.maxAge,3600000);
});
test('login não cria sessão se a verificação do código falha ou retorna conta sem permissão',async(t)=>{
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'wrong code'}),{status:400}));
  const auth=new AuthService(),res=response();await assert.rejects(auth.login('teacher@example.com','123456',res));assert.equal(res.cookies.length,0);
  mock.mock.mockImplementation(async(url)=>new Response(JSON.stringify(url.endsWith('/verify')?{access_token:'student-jwt'}:{email:'student@example.com'}),{status:200}));
  await assert.rejects(auth.login('teacher@example.com','123456',res),error=>error.getStatus()===403);assert.equal(res.cookies.length,0);
});
test('logout limpa o mesmo cookie com proteção de transporte e sem divulgar token',()=>{
  const res=response();assert.deepEqual(new AuthService().logout(res),{ok:true});assert.equal(res.cleared[0][0],'enem_session');assert.equal(res.cleared[0][1].httpOnly,true);assert.equal(res.cleared[0][1].secure,true);
});
test('cookies continuam Secure na nuvem quando o login está temporariamente desativado',async(t)=>{
  process.env.VERCEL='1';process.env.AUTH_ENABLED='false';provider(t,{email:'teacher@example.com'});
  const auth=new AuthService(),res=response();await auth.session('mock-magic-link-token',res);auth.logout(res);
  assert.equal(res.cookies[0][2].secure,true);assert.equal(res.cleared[0][1].secure,true);
});
test('pedido de link mágico usa callback /login da interface configurada e mantém allowlist',async(t)=>{
  process.env.WEB_URL='https://frontend.example.com/';const calls=provider(t,{});
  const result=await new AuthService().requestCode('TEACHER@EXAMPLE.COM');
  const url=new URL(calls[0].url);assert.equal(url.pathname,'/auth/v1/otp');assert.equal(url.searchParams.get('redirect_to'),'https://frontend.example.com/login');
  assert.match(result.message,/link de acesso/);assert.deepEqual(JSON.parse(calls[0].options.body),{email:'teacher@example.com',create_user:true});
  delete process.env.WEB_URL;process.env.CORS_ORIGINS='https://fallback.example.com,https://preview.example.com';
  await new AuthService().requestCode('teacher@example.com');assert.equal(new URL(calls[1].url).searchParams.get('redirect_to'),'https://fallback.example.com/login');
});
test('sessão de link mágico valida professor no Supabase antes de criar cookie e não retorna token',async(t)=>{
  const calls=provider(t,{email:'teacher@example.com'}),res=response();
  const result=await new AuthService().session('mock-magic-link-token',res);
  assert.deepEqual(result,{email:'teacher@example.com'});assert.equal(calls[0].options.headers.Authorization,'Bearer mock-magic-link-token');assert.match(calls[0].url,/\/user$/);
  assert.equal(res.cookies.length,1);const [name,token,config]=res.cookies[0];assert.equal(name,'enem_session');assert.equal(token,'mock-magic-link-token');assert.equal(config.httpOnly,true);assert.equal(config.secure,true);assert.equal(config.sameSite,'lax');assert.equal(config.maxAge,3600000);
  assert.doesNotMatch(JSON.stringify(result),/mock-magic-link-token/);
});
test('sessão de link mágico recusa token inválido, expirado ou de aluno sem criar cookie',async(t)=>{
  const calls=provider(t,{email:'student@example.com'}),auth=new AuthService(),res=response();
  await assert.rejects(auth.session(null,res),error=>error.getStatus()===400);
  await assert.rejects(auth.session('',res),error=>error.getStatus()===401);
  await assert.rejects(auth.session('x'.repeat(8001),res),error=>error.getStatus()===401);assert.equal(calls.length,0);
  await assert.rejects(auth.session('mock-student-token',res),error=>error.getStatus()===403);assert.equal(res.cookies.length,0);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'expired JWT'}),{status:401}));
  await assert.rejects(auth.session('mock-expired-token',res),error=>error.getStatus()===401);assert.equal(res.cookies.length,0);
});
