const {test,before,after} = require('./account-fixture.cjs');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync,readFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {createHash,randomBytes} = require('node:crypto');
const temp = mkdtempSync(join(tmpdir(),'enem-public-links-'));
Object.assign(process.env,{DATABASE_URL:'',DATABASE_PATH:join(temp,'links.sqlite3'),MEDIA_ROOT:join(temp,'media'),STORAGE_MODE:'local',OMR_REMOTE_URL:'',AUTH_ENABLED:'true',AUTH_REGISTRATION_ENABLED:'false',WEB_URL:'https://ficticio.example.com',REPORT_LINK_TTL_DAYS:'7',EMAILJS_ENABLED:'false',EMAILJS_SERVICE_ID:'',EMAILJS_TEMPLATE_ID:'',EMAILJS_PUBLIC_KEY:'',EMAILJS_PRIVATE_KEY:'',RESEND_API_KEY:'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',CRON_SECRET:''});
const {DatabaseService} = require('../dist/database.service.js');
const {ReportsService,ReportEmailGateway,reportLinkHtml} = require('../dist/reports.service.js');
const {SimuladosService} = require('../dist/simulados.service.js');
const {ContactsService} = require('../dist/contacts.service.js');
const {AuthService} = require('../dist/auth.js');
const {grade} = require('../dist/grading.js');
const hash=value=>createHash('sha256').update(value).digest('hex');
let db,contacts,simulados,sequence=0;
before(()=>{db=new DatabaseService();contacts=new ContactsService(db);simulados=new SimuladosService(db,{});});
after(async()=>{await db?.onModuleDestroy();rmSync(temp,{recursive:true,force:true});});
async function fixture(deliver) {
  const name='FICTICIO'+(++sequence),now=new Date().toISOString();
  const key=Object.fromEntries(Array.from({length:50},(_,i)=>[String(i+1),'ABCDE'[i%5]]));
  const themes=[{inicio:1,fim:15,tema:'Linguagens'},{inicio:16,fim:30,tema:'Ciências da Natureza'},{inicio:31,fim:40,tema:'Matemática'},{inicio:41,fim:50,tema:'Ciências Humanas'}];
  const sim=await db.run("INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas,owner_id) VALUES(?,?,?,?,?,'11111111-1111-4111-8111-111111111111')",'Simulado fictício',now,JSON.stringify(key),50,JSON.stringify(themes));
  const batch=await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',now,sim.lastInsertRowid,JSON.stringify(key));
  const score=grade(key,key,'OK',50);
  const row=await db.run('INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,status,lote_id,mensagem_leitura) VALUES(?,?,?,?,?,?,?,?,?,?,?)',name,JSON.stringify(key),score.total_acertos,0,0,0,0,100,'OK',batch.lastInsertRowid,'');
  await db.run("INSERT INTO student_contacts(matricula,email,nome,curso,atualizado_em,owner_id) VALUES(?,?,?,?,?,'11111111-1111-4111-8111-111111111111')",name,name.toLowerCase()+'@example.com','Estudante fictício','Curso fictício',now);
  const messages=[];
  const gateway={availability:()=>({envio_disponivel:true,envio_motivo:'Provedor fictício.'}),deliver:async(report,url,idem,expiry)=>{messages.push({report,url,idem,expiry});return deliver ? deliver(report,url,idem,expiry) : 'fake-message-'+messages.length;}};
  const reports=new ReportsService(db,simulados,contacts,gateway);
  return {reports,messages,simuladoId:sim.lastInsertRowid,resultId:row.lastInsertRowid,matricula:name};
}
async function issue(f) {const plan=await f.reports.plan(f.simuladoId,[f.resultId]);await f.reports.send(f.simuladoId,plan.token,'sim');return {plan,token:new URL(f.messages.at(-1).url).hash.slice(1),delivery:await db.get('SELECT * FROM report_deliveries WHERE resultado_id=?',f.resultId)};}
const rejectsAccess=(promise)=>assert.rejects(promise,error=>error.getStatus?.()===410 && /expirou|substituído/.test(error.message));

test('email de boletim contém apenas mensagem curta e link, sem notas, respostas, matrícula ou anexos',async()=>{
  const f=await fixture(),report=await f.reports.report(f.resultId),calls=[];
  const gateway=new ReportEmailGateway({configured:()=>true,send:async(...args)=>{calls.push(args);return 'emailjs-accepted';}});
  const token=randomBytes(32).toString('base64url'),url='https://ficticio.example.com/boletim#'+token;
  await gateway.deliver(report,url,'test-key','2030-01-01T12:00:00.000Z');
  assert.equal(calls[0][0],report.email);assert.match(calls[0][2],/https:\/\/ficticio\.example\.com\/boletim/);assert.ok(calls[0][2].includes(url));
  for(const privateText of [report.matricula,report.nome,report.curso,'100 / 1000','Questões','<table','PDF em anexo']) assert.ok(!calls[0][2].includes(privateText),privateText);
  assert.equal(gateway.availability().envio_disponivel,true);
  assert.throws(()=>reportLinkHtml('javascript:alert(1)','2030-01-01T00:00:00.000Z'),/inválido/);
  assert.throws(()=>reportLinkHtml(url.replace('/boletim#','/boletim?token=')+'#'+token,'2030-01-01T00:00:00.000Z'),/inválido/);
});
test('Resend e SMTP usam a mesma mensagem de link sem anexos e não acessam provedores reais',async()=>{
  const f=await fixture(),report=await f.reports.report(f.resultId),url='https://ficticio.example.com/boletim#'+randomBytes(32).toString('base64url');
  const expiry='2030-01-01T12:00:00.000Z',gateway=new ReportEmailGateway();
  const nodemailer=require('nodemailer'),originalFetch=global.fetch,originalTransport=nodemailer.createTransport;
  const original={EMAIL_FROM:process.env.EMAIL_FROM,RESEND_API_KEY:process.env.RESEND_API_KEY,SMTP_HOST:process.env.SMTP_HOST,SMTP_USER:process.env.SMTP_USER,SMTP_PASS:process.env.SMTP_PASS};
  try {
    process.env.EMAIL_FROM='IFS Fictício <remetente@example.com>';process.env.RESEND_API_KEY='fake-isolated-key';
    let payload,requestOptions;
    global.fetch=async(_url,options)=>{requestOptions=options;payload=JSON.parse(options.body);return new Response(JSON.stringify({id:'fake-resend-id'}),{status:200});};
    assert.equal(await gateway.deliver(report,url,'fake-idem',expiry),'fake-resend-id');assert.ok(!('attachments' in payload));assert.ok(payload.html.includes(url));assert.equal(requestOptions.headers['Idempotency-Key'],'fake-idem');
    process.env.RESEND_API_KEY='';process.env.SMTP_HOST='smtp.example.com';process.env.SMTP_USER='fake-user';process.env.SMTP_PASS='fake-password';
    let message,closed=false;
    nodemailer.createTransport=()=>({sendMail:async value=>{message=value;return {accepted:[report.email],messageId:'fake-smtp-id'};},close:()=>{closed=true;}});
    assert.equal(await gateway.deliver(report,url,'fake-idem',expiry),'fake-smtp-id');assert.ok(!('attachments' in message));assert.ok(message.html.includes(url));assert.ok(closed);
    assert.ok(!message.html.includes(report.matricula));
  } finally {
    global.fetch=originalFetch;nodemailer.createTransport=originalTransport;
    for(const [name,value] of Object.entries(original)) {if(value===undefined)delete process.env[name];else process.env[name]=value;}
  }
});
test('envio simultâneo é idempotente e guarda somente hash do token, sem gerar PDF durante o email',async()=>{
  const f=await fixture();f.reports.pdf=async()=>{throw new Error('O email não pode gerar/anexar PDF.');};
  const plan=await f.reports.plan(f.simuladoId,[f.resultId]);
  const results=await Promise.all([f.reports.send(f.simuladoId,plan.token,'sim'),f.reports.send(f.simuladoId,plan.token,'sim')]);
  assert.equal(results.reduce((sum,value)=>sum+value.total_enviados,0),1);assert.equal(f.messages.length,1);
  const token=new URL(f.messages[0].url).hash.slice(1),links=await db.all('SELECT * FROM report_access_links WHERE delivery_id=(SELECT id FROM report_deliveries WHERE resultado_id=?)',f.resultId);
  assert.equal(Buffer.from(token,'base64url').length,32);assert.equal(links.length,1);assert.equal(links[0].token_hash,hash(token));assert.ok(links[0].ativado_em);
  assert.ok(!JSON.stringify(links).includes(token));assert.ok(!JSON.stringify(results).includes(token));
  assert.equal(Date.parse(links[0].expira_em)-Date.parse(links[0].criado_em),7*86400_000);
});
test('link é reutilizável durante TTL, consulta apenas resultado autorizado e PDF é gerado em memória',async()=>{
  const f=await fixture(),issued=await issue(f);
  const first=await f.reports.publicReport(issued.token),second=await f.reports.publicReport(issued.token);
  assert.equal(first.boletim.matricula,f.matricula);assert.equal(second.boletim.matricula,f.matricula);
  assert.equal(first.boletim.nota_geral_dez,10);assert.equal(first.boletim.questoes.length,50);
  for(const field of ['email','content_hash','resultado_id','simulado_id','apto_envio']) assert.ok(!(field in first.boletim));
  const pdf=await f.reports.publicPdf(issued.token);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  assert.equal((await db.get('SELECT token_hash FROM report_access_links WHERE token_hash=?',hash(issued.token))).token_hash,hash(issued.token));
});
test('tokens malformados, desconhecidos, inativos, expirados e revogados são negados',async()=>{
  const f=await fixture(),issued=await issue(f);
  for(const token of [null,'',issued.token+'x',randomBytes(32).toString('base64url')]) await rejectsAccess(f.reports.publicReport(token));
  const original=await db.get('SELECT * FROM report_access_links WHERE token_hash=?',hash(issued.token));
  await db.run('UPDATE report_access_links SET ativado_em=NULL WHERE token_hash=?',hash(issued.token));await rejectsAccess(f.reports.publicPdf(issued.token));
  await db.run('UPDATE report_access_links SET ativado_em=?,expira_em=? WHERE token_hash=?',original.ativado_em,new Date(Date.now()-1).toISOString(),hash(issued.token));await rejectsAccess(f.reports.publicReport(issued.token));
  await db.run('UPDATE report_access_links SET expira_em=?,revogado_em=? WHERE token_hash=?',original.expira_em,new Date().toISOString(),hash(issued.token));await rejectsAccess(f.reports.publicReport(issued.token));
});
test('mudança de redação invalida versão enviada e reemissão atualiza a mesma entrega',async()=>{
  const f=await fixture(),issued=await issue(f);
  await f.reports.saveEssay(f.resultId,{nota_redacao:880,feedback_redacao:'Feedback fictício.'});
  await rejectsAccess(f.reports.publicReport(issued.token));
  const plan=await f.reports.planReissue(f.simuladoId,issued.delivery.id);assert.equal(plan.alunos[0].email,f.messages[0].report.email);assert.equal(plan.reemissao,true);
  const sent=await f.reports.reissue(f.simuladoId,plan.token,'sim');assert.equal(sent.total_enviados,1);
  const token=new URL(f.messages[1].url).hash.slice(1);assert.equal((await f.reports.publicReport(token)).boletim.redacao.nota_redacao,880);
  await rejectsAccess(f.reports.publicReport(issued.token));assert.equal((await db.all('SELECT * FROM report_deliveries WHERE resultado_id=?',f.resultId)).length,1);
  const again=await f.reports.reissue(f.simuladoId,plan.token,'sim');assert.equal(again.total_ignorados,1);assert.equal(f.messages.length,2);
});
test('reemissão simultânea usa reserva persistente e uma prévia antiga não pode substituir o novo acesso',async()=>{
  const f=await fixture(async()=>{await new Promise(resolve=>setTimeout(resolve,40));return 'confirmed-fake';}),issued=await issue(f);
  const a=await f.reports.planReissue(f.simuladoId,issued.delivery.id),b=await f.reports.planReissue(f.simuladoId,issued.delivery.id);
  const settled=await Promise.allSettled([f.reports.reissue(f.simuladoId,a.token,'sim'),f.reports.reissue(f.simuladoId,b.token,'sim')]);
  assert.equal(settled.filter(row=>row.status==='fulfilled').length,1);assert.equal(f.messages.length,2);
  const failed=settled[0].status==='rejected'?a:b;await assert.rejects(f.reports.reissue(f.simuladoId,failed.token,'sim'),/mudou|atualizada/);
  assert.equal(f.messages.length,2);
});
test('contato alterado após prévia impede reemitir ao endereço anterior',async()=>{
  const f=await fixture(),issued=await issue(f),plan=await f.reports.planReissue(f.simuladoId,issued.delivery.id);
  await db.run('UPDATE student_contacts SET email=? WHERE matricula=?','novo-ficticio@example.com',f.matricula);
  await assert.rejects(f.reports.reissue(f.simuladoId,plan.token,'sim'),/mudou/);assert.equal(f.messages.length,1);
  await rejectsAccess(f.reports.publicReport(issued.token));
});
test('falha ambígua não ativa link nem repete automaticamente a entrega',async()=>{
  const f=await fixture(async()=>{throw new Error('Timeout fictício.');}),plan=await f.reports.plan(f.simuladoId,[f.resultId]);
  const result=await f.reports.send(f.simuladoId,plan.token,'sim');assert.equal(result.resultados[0].status,'AMBIGUO');assert.equal(f.messages.length,1);
  await rejectsAccess(f.reports.publicReport(new URL(f.messages[0].url).hash.slice(1)));
  await f.reports.send(f.simuladoId,plan.token,'sim');assert.equal(f.messages.length,1);
  const row=await db.get('SELECT id FROM report_deliveries WHERE resultado_id=?',f.resultId);await assert.rejects(f.reports.planReissue(f.simuladoId,row.id),/confirmadas/);
});
test('falha de reemissão revoga acesso anterior e deixa novo acesso inativo, sem duplicar registro',async()=>{
  let fail=false;const f=await fixture(async()=>{if(fail) throw new Error('Timeout fictício.');return 'confirmed-fake';}),issued=await issue(f);
  fail=true;const plan=await f.reports.planReissue(f.simuladoId,issued.delivery.id),result=await f.reports.reissue(f.simuladoId,plan.token,'sim');
  assert.equal(result.resultados[0].status,'AMBIGUO');await rejectsAccess(f.reports.publicReport(issued.token));await rejectsAccess(f.reports.publicReport(new URL(f.messages[1].url).hash.slice(1)));
  await f.reports.reissue(f.simuladoId,plan.token,'sim');assert.equal(f.messages.length,2);assert.equal((await db.all('SELECT * FROM report_deliveries WHERE resultado_id=?',f.resultId)).length,1);
});
test('alterações de competências e avaliador invalidam acesso mesmo com a nota total preservada',async()=>{
  const f=await fixture();await f.reports.saveEssay(f.resultId,{nota_redacao:880,feedback_redacao:'Avaliação fictícia.',competencias_redacao:[200,200,160,160,160]});
  const issued=await issue(f);await db.run('UPDATE report_feedback SET competencias_redacao=?,avaliador_redacao=? WHERE resultado_id=?',JSON.stringify([160,200,200,160,160]),'Professor fictício',f.resultId);
  await rejectsAccess(f.reports.publicReport(issued.token));const report=await f.reports.report(f.resultId);assert.deepEqual(report.redacao.competencias_redacao,[160,200,200,160,160]);
  await assert.rejects(f.reports.saveEssay(f.resultId,{nota_redacao:900,feedback_redacao:'Outra nota.'}),/soma/);
  const edited=await f.reports.saveEssay(f.resultId,{nota_redacao:880,feedback_redacao:'Feedback revisado.'});assert.equal(edited.redacao.competencias_redacao.length,5);
  const cleared=await f.reports.saveEssay(f.resultId,{nota_redacao:900,feedback_redacao:'Nota manual.',limpar_competencias:true});assert.deepEqual(cleared.redacao.competencias_redacao,[]);
});
test('limpeza exige segredo próprio e exclui somente autorizações temporárias, preservando resultados',async()=>{
  const active=await fixture(),a=await issue(active),expired=await fixture(),e=await issue(expired),revoked=await fixture(),r=await issue(revoked);
  await db.run('UPDATE report_access_links SET expira_em=? WHERE token_hash=?',new Date(Date.now()-1).toISOString(),hash(e.token));await db.run('UPDATE report_access_links SET revogado_em=? WHERE token_hash=?',new Date().toISOString(),hash(r.token));
  await assert.rejects(active.reports.cleanupAccess('Bearer wrong'),error=>error.getStatus?.()===503);
  process.env.CRON_SECRET='ficticio-cron-secret-32-bytes-minimum';
  await assert.rejects(active.reports.cleanupAccess('Bearer wrong'),error=>error.getStatus?.()===401);
  const before=(await db.get('SELECT COUNT(*) AS total FROM core_resultadoaluno')).total;
  const clean=await active.reports.cleanupAccess('Bearer '+process.env.CRON_SECRET);assert.ok(clean.removidos>=2);
  assert.equal((await db.get('SELECT COUNT(*) AS total FROM core_resultadoaluno')).total,before);assert.equal((await active.reports.publicReport(a.token)).boletim.matricula,active.matricula);
  assert.equal(await db.get('SELECT * FROM report_access_links WHERE token_hash=?',hash(e.token)),undefined);process.env.CRON_SECRET='';
});
test('URLs inseguras e TTL inválido são recusados antes de reservar entregas ou enviar mensagens',async()=>{
  const f=await fixture(),plan=await f.reports.plan(f.simuladoId,[f.resultId]);
  process.env.WEB_URL='http://inseguro.example.com';await assert.rejects(f.reports.send(f.simuladoId,plan.token,'sim'),/HTTPS/);process.env.WEB_URL='https://ficticio.example.com';
  process.env.REPORT_LINK_TTL_DAYS='0';await assert.rejects(f.reports.send(f.simuladoId,plan.token,'sim'),/prazo/);process.env.REPORT_LINK_TTL_DAYS='7';
  assert.equal(f.messages.length,0);assert.equal((await db.all('SELECT * FROM report_deliveries WHERE resultado_id=?',f.resultId)).length,0);
});
test('exceções públicas exigem método e caminho exatos; rotas administrativas permanecem autenticadas',async()=>{
  const auth=new AuthService();let userCalls=0;auth.user=async()=>{userCalls++;throw new Error('Sem sessão.');};
  async function check(method,path) {let called=false,status=200;const headers={};const response={setHeader:(k,v)=>headers[k]=v,clearCookie(){},status:v=>{status=v;return response;},json:()=>{}};const request={method,path,headers:{},get:()=>undefined};await auth.middleware()(request,response,()=>called=true);return {called,status,headers};}
  for(const [method,path] of [['POST','/api/boletim/consultar'],['POST','/api/boletim/pdf'],['GET','/api/boletim/limpar']]) {const state=await check(method,path);assert.equal(state.called,true);assert.equal(state.headers['Referrer-Policy'],'no-referrer');}
  for(const [method,path] of [['GET','/api/boletim/consultar'],['GET','/api/boletim/pdf'],['POST','/api/boletim/limpar'],['POST','/api/boletim/consultar/extra'],['GET','/api/resultados/1/boletim/pdf'],['GET','/api/contatos'],['POST','/api/simulados/1/boletins/enviar']]) {const state=await check(method,path);assert.equal(state.called,false);assert.equal(state.status,401);}
  assert.equal(userCalls,7);
});
test('página pública remove fragmento e transmite credencial somente em POST sem cache/referrer/persistência',()=>{
  const source=readFileSync(join(__dirname,'../../web/src/components/public-report.tsx'),'utf8');
  assert.match(source,/history\.replaceState\(null,'',window\.location\.pathname\)/);assert.match(source,/JSON\.stringify\(\{token:token\.current\}\)/);assert.match(source,/referrerPolicy:'no-referrer'/);assert.match(source,/cache:'no-store'/);
  assert.doesNotMatch(source,/localStorage|sessionStorage|console\.|token=|\.searchParams/);
});

test('edições manuais simultâneas preservam a avaliação mais recente e pedem revisão no conflito',async()=>{
  const f=await fixture();await f.reports.saveEssay(f.resultId,{nota_redacao:800,feedback_redacao:'Original fictício.'});
  const changes=await Promise.allSettled([f.reports.saveEssay(f.resultId,{nota_redacao:800,feedback_redacao:'Primeira edição.'}),f.reports.saveEssay(f.resultId,{nota_redacao:800,feedback_redacao:'Segunda edição.'})]);
  assert.equal(changes.filter(row=>row.status==='fulfilled').length,1);assert.equal(changes.filter(row=>row.status==='rejected').length,1);
  assert.match(changes.find(row=>row.status==='rejected').reason.message,/mudou durante/);
});
