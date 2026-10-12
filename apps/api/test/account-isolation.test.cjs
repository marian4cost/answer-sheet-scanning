const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const config = require('../dist/config');
const {createApplication} = require('../dist/bootstrap');
const {AuthService} = require('../dist/auth');
const {DatabaseService} = require('../dist/database.service');
const {StorageService} = require('../dist/storage.service');
const {OmrService} = require('../dist/omr.service');
const {ReportsService,ReportEmailGateway,reportLinkHtml,reportLinkText} = require('../dist/reports.service');
const {ContactsService} = require('../dist/contacts.service');
const {SimuladosService} = require('../dist/simulados.service');
const {withAccount,accountId} = require('../dist/account-context');
const accounts = {
  a:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'a@example.test'},
  b:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email:'b@example.test'},
};
const key = Object.fromEntries(Array.from({length:50},(_,i)=>[String(i+1),'ABCDE'[i%5]]));
let dir,app,db,base,simA,simB,resultA,batchA,planA,contactsToken,uploadA,deliveryA,accessUrl;
const objects = new Map();
let sends = 0, failRemoval = false;
async function request(who,url,method='GET',body) {
  const response = await fetch(base+url,{method,headers:{...(who?{Authorization:'Bearer '+who}:{}),'X-OMR-Client':'web',...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
  const content = response.headers.get('content-type') || '';
  return {status:response.status,data:content.includes('json')?await response.json():Buffer.from(await response.arrayBuffer())};
}
before(async()=>{
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'enem-accounts-'));
  config.DATABASE_URL='';config.DATABASE_PATH=path.join(dir,'test.sqlite');config.MEDIA_ROOT=path.join(dir,'media');
  Object.assign(process.env,{VERCEL:'',DATA_RETENTION_DAYS:'90',WEB_URL:'https://school.example.test',CRON_SECRET:'test-only-secret-'.repeat(3)});
  app=await createApplication(false);db=app.get(DatabaseService);
  app.get(AuthService).user=async token=>{if(!accounts[token])throw Error('Sessão inválida.');return accounts[token];};
  const storage=app.get(StorageService);storage.privateCloud=true;
  storage.signedUploadURL=async key=>'https://storage.example.test/'+key;
  storage.put=async(key,buffer)=>objects.set(key,buffer);
  storage.get=async key=>({buffer:objects.get(key)||Buffer.from('fixture'),contentType:'image/png'});
  storage.remove=async key=>{if(failRemoval)throw Error('Storage indisponível.');objects.delete(key);};
  const omr=app.get(OmrService);
  omr.documentInfo=async()=>({page_count:1});
  const gateway=app.get(ReportEmailGateway);
  gateway.availability=()=>({envio_disponivel:true,envio_motivo:'Provedor fictício.'});
  gateway.deliver=async(_report,url)=>{sends++;accessUrl=url;return 'fake-'+sends;};
  await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api';
  for(const who of ['a','b']) {
    const created=await request(who,'/simulados','POST',{titulo:'Simulado da conta '+who,total_questoes:50,temas:[{inicio:1,fim:50,tema:'Linguagens'}],gabarito_manual:key,owner_id:accounts[who==='a'?'b':'a'].id});
    assert.equal(created.status,201);if(who==='a')simA=created.data.id;else simB=created.data.id;
  }
  batchA=(await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',new Date().toISOString(),simA,JSON.stringify(key))).lastInsertRowid;
  resultA=(await db.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,nota_percentual,status,lote_id,imagem_debug)
    VALUES(?,?,50,0,0,0,100,'SUCESSO',?,?)`,'000001',JSON.stringify(key),batchA,'debug_images/'+randomUUID()+'_debug.png')).lastInsertRowid;
  for(const who of ['a','b']) {
    const form=new FormData();form.set('arquivo',new Blob(['matricula,email,nome\n000001,'+who+'-student@example.test,Aluno fictício\n']),'contacts.csv');
    const preview=await request(who,'/contatos/preview','POST',form);assert.equal(preview.status,201);
    assert.equal((await request(who,'/contatos/importar','POST',{token:preview.data.token,confirmar:'sim'})).status,201);
  }
  const form=new FormData();form.set('arquivo',new Blob(['matricula,email\n000002,second@example.test\n']),'contacts.csv');
  contactsToken=(await request('a','/contatos/preview','POST',form)).data.token;
  const upload=await request('a','/uploads/preparar','POST',{files:[{name:'sheet.png',size:7,purpose:'gabarito'}]});uploadA=upload.data.uploads[0].id;
  const proofs=new FormData();proofs.set('pdf_files',new Blob(['fixture']),'sheet.png');
  const plan=await request('a',`/simulados/${simA}/provas/importacoes`,'POST',proofs);assert.equal(plan.status,201);planA=plan.data.id;
  const report=(await request('a',`/resultados/${resultA}/boletim`)).data;
  assert.equal(report.email,'a-student@example.test');
  await request('a',`/resultados/${resultA}/redacao`,'PUT',{nota_redacao:800,feedback_redacao:'Avaliação fictícia.'});
  const delivery=await request('a',`/simulados/${simA}/boletins/planejar`,'POST',{resultado_ids:[resultA]});assert.equal(delivery.status,201);
  deliveryA=delivery.data.token;
});
after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true});});

test('identidade ausente falha fechada, UUID inválido é recusado e contextos concorrentes não se misturam',async()=>{
  assert.throws(()=>accountId(),/Entre/);
  assert.throws(()=>withAccount({id:'forged',email:'fake'},()=>accountId()),/inválida/);
  const ids=await Promise.all(['a','b'].map(who=>withAccount(accounts[who],async()=>{await new Promise(resolve=>setTimeout(resolve,who==='a'?15:1));return accountId();})));
  assert.deepEqual(ids,[accounts.a.id,accounts.b.id]);
});
test('cada painel mostra somente seus simulados e seu histórico; owner_id enviado pelo cliente é ignorado',async()=>{
  const a=await request('a','/simulados'),b=await request('b','/simulados');
  assert.deepEqual(a.data.simulados.map(s=>s.id),[simA]);assert.deepEqual(b.data.simulados.map(s=>s.id),[simB]);
  assert.deepEqual(a.data.envios_recentes.map(e=>e.id),[batchA]);assert.equal(b.data.envios_recentes.length,0);
  assert.equal(a.data.retencao_dias,90);assert.ok(Date.parse(a.data.simulados[0].expira_em)>Date.now()+89*86400_000);
  assert.equal((await request(null,'/simulados')).status,401);
  for(const who of ['a','b']) assert.deepEqual((await request(who,'/auth/me')).data,accounts[who]);
  assert.equal((await request(null,'/auth/me')).status,401);
});
test('todas as leituras de simulado, lote, resultado, imagem, redação, PDF, planilha e entrega bloqueiam outra conta',async()=>{
  for(const url of [`/simulados/${simA}`,`/simulados/${simA}/resultados`,`/simulados/${simA}/exportar`,`/simulados/${simA}/boletins`,`/simulados/${simA}/boletins/entregas`,`/simulados/${simA}/provas/importacoes`,`/envios/${batchA}`,`/envios/${batchA}/exportar`,`/resultados/${resultA}`,`/resultados/${resultA}/imagem`,`/resultados/${resultA}/boletim`,`/resultados/${resultA}/boletim/pdf`]) assert.equal((await request('b',url)).status,404,url);
});
test('alterar chave, temas, redação ou excluir simulado de outra conta é bloqueado sem mudar dados',async()=>{
  for(const [url,method,body] of [[`/simulados/${simA}/gabarito`,'PUT',{gabarito_manual:key}],[`/simulados/${simA}/temas`,'PUT',{temas:[]}],[`/resultados/${resultA}/redacao`,'PUT',{nota_redacao:0}],[`/simulados/${simA}`,'DELETE',{confirmar:'sim'}]]) assert.equal((await request('b',url,method,body)).status,404,url);
  assert.equal((await request('a',`/resultados/${resultA}/boletim`)).data.redacao.nota_redacao,800);
});
test('contatos com a mesma matrícula pertencem a contas distintas e prévia não pode ser confirmada por outra conta',async()=>{
  for(const who of ['a','b']) {const response=await request(who,'/contatos');assert.equal(response.data.contatos.length,1);assert.equal(response.data.contatos[0].email,who+'-student@example.test');}
  assert.equal((await request('b','/contatos/importar','POST',{token:contactsToken,confirmar:'sim'})).status,400);
  assert.equal((await request('a','/contatos/importar','POST',{token:contactsToken,confirmar:'sim'})).status,201);
  assert.equal((await request('b','/contatos')).data.contatos.length,1);
});
test('recibo privado não pode ser consumido nem excluído por outra conta',async()=>{
  assert.equal((await request('b','/leituras/gabarito/armazem','POST',{upload_id:uploadA,total_questoes:50})).status,404);
  assert.equal((await db.get('SELECT consumed_at FROM uploaded_files WHERE id=?',uploadA)).consumed_at,null);
});
test('todas as ações e arquivos de importação são privados mesmo com UUID conhecido',async()=>{
  for(const [suffix,method,body] of [['','GET'],['/arquivo/0','GET'],['/identificar','POST',{}],['/processar','POST',{}],['/cancelar','POST',{}],['/confirmar','POST',{confirmar:'sim',paginas:[{id:randomUUID(),incluir:true,matricula:'000001'}]}]]) assert.equal((await request('b',`/provas/importacoes/${planA}${suffix}`,method,body)).status,404,suffix);
  assert.equal((await request('a',`/provas/importacoes/${planA}`)).status,200);
});
test('planilhas de redação e plano de envio de outro professor são bloqueados antes de gravação ou e-mail',async()=>{
  const form=new FormData();form.set('arquivo',new Blob(['matricula,nota total,observacoes\n000001,800,Teste fictício\n']),'essay.csv');
  assert.equal((await request('b',`/simulados/${simA}/redacoes/preview`,'POST',form)).status,404);
  assert.equal((await request('b',`/simulados/${simA}/redacoes/importar`,'POST',{token:contactsToken,confirmar:'sim'})).status,404);
  assert.equal((await request('b',`/simulados/${simA}/boletins/enviar`,'POST',{token:deliveryA,confirmar:'sim'})).status,404);assert.equal(sends,0);
  assert.equal((await request('a',`/simulados/${simA}/boletins/enviar`,'POST',{token:deliveryA,confirmar:'sim'})).status,201);assert.equal(sends,1);
});
test('link individual continua público e consulta somente o contato do proprietário do resultado',async()=>{
  const token=new URL(accessUrl).hash.slice(1);
  const response=await request(null,'/boletim/consultar','POST',{token});assert.equal(response.status,200);assert.equal(response.data.boletim.matricula,'000001');
  assert.equal(response.data.boletim.email,undefined);assert.equal(response.data.boletim.resultado_id,undefined);
  const own=await withAccount(accounts.b,()=>app.get(ReportsService).publicReport(token));assert.equal(own.boletim.matricula,'000001');
});
test('reemissão também exige o proprietário, sem enviar mensagens extras',async()=>{
  const row=await db.get('SELECT id FROM report_deliveries WHERE resultado_id=?',resultA);
  assert.equal((await request('b',`/simulados/${simA}/boletins/reemitir/planejar`,'POST',{delivery_id:row.id})).status,404);assert.equal(sends,1);
});
test('arquivos locais não são expostos por /media para usuários autenticados',async()=>{
  const response=await fetch(base.replace('/api','')+'/media/debug_images/private.png',{headers:{Authorization:'Bearer a'}});assert.equal(response.status,404);
});
test('o prazo do link nunca ultrapassa o prazo do simulado',async()=>{
  const until=new Date(Date.now()+3600_000).toISOString();await db.run('UPDATE core_simulado SET expira_em=? WHERE id=?',until,simA);
  const report=app.get(ReportsService),row=await db.get('SELECT * FROM report_deliveries WHERE resultado_id=?',resultA);
  const access=await withAccount(accounts.a,()=>report.createAccess(row,'fixture-expiry'));assert.equal(access.expiry,until);
});
test('registro vencido fica inacessível antes do cron e invalida o link individual',async()=>{
  await db.run('UPDATE core_simulado SET expira_em=? WHERE id=?',new Date(Date.now()-1).toISOString(),simA);
  assert.equal((await request('a',`/simulados/${simA}/resultados`)).status,404);
  assert.equal((await request('a','/simulados')).data.total_simulados,0);
  assert.equal((await request(null,'/boletim/consultar','POST',{token:new URL(accessUrl).hash.slice(1)})).status,410);
  assert.equal((await request(null,'/boletim/limpar')).status,401);
});
test('cron remove somente registros vencidos, cascata de redações/entregas/links e tenta novamente arquivos que falham',async()=>{
  const debug=(await db.get('SELECT imagem_debug FROM core_resultadoaluno WHERE id=?',resultA)).imagem_debug;objects.set(debug,Buffer.from('fictitious image'));
  await db.run('UPDATE student_contacts SET expira_em=? WHERE owner_id=?',new Date(Date.now()-1).toISOString(),accounts.a.id);
  failRemoval=true;
  const reports=app.get(ReportsService),clean=await reports.cleanupAccess('Bearer '+process.env.CRON_SECRET);
  assert.equal(clean.simulados_removidos,1);assert.ok(clean.contatos_removidos>=1);
  for(const table of ['core_resultadoaluno','report_feedback','report_deliveries','report_access_links']) assert.equal((await db.all('SELECT * FROM '+table)).length,0,table);
  assert.ok((await db.all('SELECT * FROM storage_deletions')).some(row=>row.path===debug));
  assert.equal((await request('b','/simulados')).data.total_simulados,1);assert.equal((await request('b','/contatos')).data.contatos.length,1);
  failRemoval=false;await reports.cleanupAccess('Bearer '+process.env.CRON_SECRET);
  assert.equal(objects.has(debug),false);assert.equal((await db.all('SELECT * FROM storage_deletions')).length,0);
});
test('mensagem transacional expõe domínio de destino, tem versão texto e não contém propaganda ou notas',()=>{
  const url='https://school.example.test/boletim#'+'A'.repeat(43),expiry=new Date(Date.now()+86400_000).toISOString();
  const html=reportLinkHtml(url,expiry),text=reportLinkText(url,expiry);
  assert.match(html,/>https:\/\/school.example.test\/boletim<\/a>/);assert.match(text,/https:\/\/school.example.test\/boletim#/);
  assert.doesNotMatch(html,/background:|<h1|<img|matr[ií]cula|nota objetiva|1000/);assert.match(html,/responda a este e-mail/);
});

test('registros legados sem dono permanecem preservados e invisíveis a ambas as contas',async()=>{
  const id=(await db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial) VALUES(?,?,?)','Legado fictício','2020-01-01T00:00:00.000Z',JSON.stringify(key))).lastInsertRowid;
  for(const who of ['a','b']) assert.equal((await request(who,`/simulados/${id}`)).status,404);
  await app.get(ReportsService).cleanupAccess('Bearer '+process.env.CRON_SECRET);
  assert.ok(await db.get('SELECT id FROM core_simulado WHERE id=?',id));
});

test('limpeza aguarda uma página com lease ativo e remove o simulado após o lease vencer',async()=>{
  const sim=await withAccount(accounts.a,()=>app.get(SimuladosService).create('Retenção fictícia',undefined,50,[],key));
  const plan=randomUUID(),page=randomUUID(),now=new Date().toISOString();
  await db.run('INSERT INTO proof_import_plans(id,simulado_id,payload,estado,criado_em,expira_em) VALUES(?,?,?,?,?,?)',plan,sim.id,JSON.stringify({files:[]}), 'CONFIRMADA',now,new Date(Date.now()+3600_000).toISOString());
  await db.run('INSERT INTO proof_import_pages(id,plan_id,file_index,page_number,estado,claim_id,claim_at) VALUES(?,?,0,1,?,?,?)',page,plan,'PROCESSANDO',randomUUID(),now);
  await db.run('UPDATE core_simulado SET expira_em=? WHERE id=?',new Date(Date.now()-1).toISOString(),sim.id);
  assert.equal(await app.get(SimuladosService).cleanupExpired(),0);assert.ok(await db.get('SELECT id FROM core_simulado WHERE id=?',sim.id));
  await db.run('UPDATE proof_import_pages SET claim_at=? WHERE id=?',new Date(Date.now()-180_000).toISOString(),page);
  assert.equal(await app.get(SimuladosService).cleanupExpired(),1);assert.equal(await db.get('SELECT id FROM core_simulado WHERE id=?',sim.id),undefined);
});

test('PostgreSQL/PGlite executa serviços reais com isolamento, contatos por conta, prévia privada e retenção em cascata',async()=>{
  const {PGlite}=require('@electric-sql/pglite'),{postgresPlaceholders}=require('../dist/database.service'),{AsyncLocalStorage}=require('node:async_hooks');
  const pg=new PGlite(),transaction=new AsyncLocalStorage();
  await pg.exec(await fs.readFile(path.resolve(__dirname,'../../../infra/sql/001-schema.sql'),'utf8'));
  const adapter={dialect:'postgres',all:async(sql,...parameters)=>(await pg.query(postgresPlaceholders(sql),parameters)).rows,
    get:async(sql,...parameters)=>(await adapter.all(sql,...parameters))[0],run:async(sql,...parameters)=>{
      let statement=postgresPlaceholders(sql);
      if(/^\s*INSERT INTO (core_simulado|core_lotecorrecao|core_resultadoaluno|report_deliveries)\b/.test(sql)&&!sql.includes('RETURNING'))statement+=' RETURNING id';
      const result=await pg.query(statement,parameters);return {changes:result.affectedRows,lastInsertRowid:result.rows[0]?.id};
    },transaction:async work=>{if(transaction.getStore())return work();await pg.exec('BEGIN');try{const result=await transaction.run(true,work);await pg.exec('COMMIT');return result;}catch(error){await pg.exec('ROLLBACK');throw error;}}};
  const storage={remove:async()=>{}},simulados=new SimuladosService(adapter,{},storage),contacts=new ContactsService(adapter);
  try {
    const a=await withAccount(accounts.a,()=>simulados.create('Conta A PG',undefined,50,[],key));
    const b=await withAccount(accounts.b,()=>simulados.create('Conta B PG',undefined,50,[],key));
    await assert.rejects(withAccount(accounts.b,()=>simulados.get(a.id)),/não encontrado/);
    for(const who of ['a','b']) await withAccount(accounts[who],async()=>{
      const preview=await contacts.preview(Buffer.from('matricula,email\n000001,'+who+'@example.test\n'),'contacts.csv');
      await contacts.import(preview.token,'sim');assert.equal((await contacts.get('000001')).email,who+'@example.test');
      assert.deepEqual((await simulados.dashboard()).simulados.map(row=>row.id),[who==='a'?a.id:b.id]);
    });
    const preview=await withAccount(accounts.a,()=>contacts.preview(Buffer.from('matricula,email\n000002,next@example.test\n'),'contacts.csv'));
    await assert.rejects(withAccount(accounts.b,()=>contacts.import(preview.token,'sim')),/expirou|utilizada/);
    assert.equal((await adapter.all('SELECT * FROM student_contacts WHERE matricula=?','000001')).length,2);
    await adapter.run('UPDATE core_simulado SET expira_em=? WHERE id=?',new Date(Date.now()-1).toISOString(),a.id);
    assert.equal(await simulados.cleanupExpired(),1);assert.ok(await withAccount(accounts.b,()=>simulados.get(b.id)));
    await pg.exec(await fs.readFile(path.resolve(__dirname,'../../../infra/sql/001-schema.sql'),'utf8'));
    assert.equal((await adapter.all('SELECT * FROM student_contacts')).length,2);
  } finally {await pg.close();}
});
