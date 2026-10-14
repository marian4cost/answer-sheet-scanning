const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const config=require('../dist/config');
const {createApplication}=require('../dist/bootstrap');
const {AuthService}=require('../dist/auth');
const {DatabaseService,postgresPlaceholders}=require('../dist/database.service');
const {StorageService}=require('../dist/storage.service');
const {SimuladosService}=require('../dist/simulados.service');
const {SimuladoSharesService}=require('../dist/simulado-shares.service');
const {ReportEmailGateway}=require('../dist/reports.service');
const {withAccount}=require('../dist/account-context');
const ExcelJS=require('exceljs');
const JSZip=require('jszip');
const accounts={
  owner:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'owner@example.test',role:'professor',nome:'Dona fictícia'},
  reader:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email:'reader@example.test',role:'professor',nome:'Leitora fictícia'},
  third:{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',email:'third@example.test',role:'admin',nome:'Terceira fictícia'},
};
const key=Object.fromEntries(Array.from({length:50},(_,i)=>[String(i+1),'ABCDE'[i%5]]));
const users=Object.values(accounts).map(account=>({id:account.id,email:account.email,email_confirmed_at:'2026-10-01T00:00:00Z',app_metadata:{role:account.role},user_metadata:{display_name:account.nome}}));
users.push({id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',email:'pending@example.test',app_metadata:{role:'professor'}},
  {id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',email:'blocked@example.test',email_confirmed_at:'2026-10-01T00:00:00Z',banned_until:'2099-01-01T00:00:00Z',app_metadata:{role:'professor'}},
  {id:'ffffffff-ffff-4fff-8fff-ffffffffffff',email:'unmanaged@example.test',email_confirmed_at:'2026-10-01T00:00:00Z',app_metadata:{}});
let dir,app,db,base,simulado,batch,result,grant,expiry,secretPlan;
let messages=0;
async function request(who,url,method='GET',body,extra={}) {
  const response=await fetch(base+url,{method,headers:{...(who?{Authorization:'Bearer '+who}:{}),'X-OMR-Client':'web',...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...extra},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});
  const type=response.headers.get('content-type')||'';
  return {status:response.status,data:type.includes('json')?await response.json():Buffer.from(await response.arrayBuffer())};
}
before(async()=>{
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'sirenia-sharing-'));
  config.DATABASE_URL='';config.DATABASE_PATH=path.join(dir,'test.sqlite3');config.MEDIA_ROOT=path.join(dir,'media');
  Object.assign(process.env,{VERCEL:'',DATA_RETENTION_DAYS:'30'});
  app=await createApplication(false);db=app.get(DatabaseService);
  const auth=app.get(AuthService);
  auth.user=async token=>{if(!accounts[token])throw Error('Sessão fictícia inválida.');return accounts[token];};
  auth.providerAccounts=async()=>users;
  const storage=app.get(StorageService);storage.get=async()=>({buffer:Buffer.from('fake image'),contentType:'image/png'});storage.remove=async()=>{};
  const gateway=app.get(ReportEmailGateway);gateway.availability=()=>({envio_disponivel:true,envio_motivo:'Fake'});gateway.deliver=async()=>{messages++;return 'fake';};
  await app.listen(0,'127.0.0.1');base='http://127.0.0.1:'+app.getHttpServer().address().port+'/api';
  const response=await request('owner','/simulados','POST',{titulo:'Simulado compartilhável fictício',total_questoes:50,gabarito_manual:key,temas:[{inicio:1,fim:25,tema:'Linguagens'},{inicio:26,fim:50,tema:'Matemática'}]});
  assert.equal(response.status,201);simulado=response.data.id;expiry=response.data.expira_em;
  batch=(await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',new Date().toISOString(),simulado,JSON.stringify(key))).lastInsertRowid;
  result=(await db.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,nota_percentual,status,lote_id,imagem_debug) VALUES(?,?,50,0,0,0,100,'SUCESSO',?,?)`,'000001',JSON.stringify(key),batch,'debug_images/'+randomUUID()+'_debug.png')).lastInsertRowid;
  await db.run('INSERT INTO student_contacts(owner_id,matricula,email,nome,atualizado_em,expira_em) VALUES(?,?,?,?,?,?)',accounts.owner.id,'000001','private-student@example.test','Aluno privado',new Date().toISOString(),expiry);
  secretPlan=randomUUID();await db.run('INSERT INTO proof_import_plans(id,simulado_id,payload,estado,criado_em,expira_em) VALUES(?,?,?,?,?,?)',secretPlan,simulado,JSON.stringify({files:[]}),'PENDENTE',new Date().toISOString(),expiry);
});
after(async()=>{await app?.close();await fs.rm(dir,{recursive:true,force:true});});

test('somente o proprietário gerencia compartilhamentos, nenhum admin global herda acesso e autenticação é obrigatória',async()=>{
  for(const who of ['reader','third',null])for(const [method,suffix,body] of [['GET',''],['POST','',{email:accounts.reader.email}],['DELETE','/'+randomUUID()]])assert.equal((await request(who,`/simulados/${simulado}/compartilhamentos${suffix}`,method,body)).status,who?404:401);
  assert.equal((await request('owner',`/simulados/${simulado}/compartilhamentos`)).data.compartilhamentos.length,0);
});
test('destinatário precisa ter acesso ativo; proprietário, desconhecido, pendente e bloqueado são recusados sem e-mail',async()=>{
  for(const email of ['owner@example.test','not-found@example.test','pending@example.test','blocked@example.test','unmanaged@example.test','invalid']) {
    const response=await request('owner',`/simulados/${simulado}/compartilhamentos`,'POST',{email});assert.ok([400,404].includes(response.status),email);
  }
  for(const body of [{email:accounts.reader.email,owner_id:accounts.third.id},{email:accounts.reader.email,destinatario_id:accounts.third.id},{email:accounts.reader.email,role:'admin'}])assert.equal((await request('owner',`/simulados/${simulado}/compartilhamentos`,'POST',body)).status,400);
  assert.equal((await db.all('SELECT * FROM simulado_shares')).length,0);assert.equal(messages,0);
});
test('compartilhar pelo e-mail preserva vencimento, não duplica acesso e inclui metadata no painel do destinatário',async()=>{
  const response=await request('owner',`/simulados/${simulado}/compartilhamentos`,'POST',{email:'  READER@EXAMPLE.TEST  '});assert.equal(response.status,201);grant=response.data;
  assert.equal(grant.email,accounts.reader.email);assert.equal(grant.destinatario_id,accounts.reader.id);
  const duplicate=await request('owner',`/simulados/${simulado}/compartilhamentos`,'POST',{email:accounts.reader.email});assert.equal(duplicate.status,201);assert.equal(duplicate.data.id,grant.id);
  assert.equal((await db.all('SELECT * FROM simulado_shares')).length,1);
  const own=(await request('owner',`/simulados/${simulado}`)).data.simulado;
  const shared=(await request('reader','/simulados')).data;
  assert.equal(own.acesso,'proprietario');assert.equal(own.pode_editar,true);
  assert.equal(shared.simulados.length,1);assert.equal(shared.simulados[0].acesso,'compartilhado');assert.equal(shared.simulados[0].pode_editar,false);
  assert.deepEqual(shared.simulados[0].compartilhado_por,{nome:accounts.owner.nome,email:accounts.owner.email});
  assert.equal(shared.simulados[0].expira_em,expiry);assert.equal(shared.envios_recentes.length,0);
  assert.equal((await request('third','/simulados')).data.simulados.length,0);assert.equal(messages,0);
});
test('destinatário vê respostas, gabarito, espelho e exportações somente do simulado concedido',async()=>{
  for(const url of [`/simulados/${simulado}`,`/simulados/${simulado}/resultados`,`/simulados/${simulado}/exportar`,`/envios/${batch}`,`/envios/${batch}/exportar`,`/resultados/${result}`,`/resultados/${result}/imagem`])assert.equal((await request('reader',url)).status,200,url);
  const read=(await request('reader',`/resultados/${result}`)).data;
  assert.deepEqual(read.resultado.respostas_detectadas,key);assert.deepEqual(read.resultado.gabarito_do_envio,key);assert.equal(read.resultado.total_acertos,50);
  for(const url of [`/simulados/${simulado}`,`/simulados/${simulado}/resultados`,`/resultados/${result}`])assert.equal((await request('third',url)).status,404,url);
});
test('uma nova conta com o mesmo e-mail não herda o grant vinculado ao UUID anterior',async()=>{
  accounts.recreated={...accounts.reader,id:'12121212-1212-4212-8212-121212121212'};
  for(const url of [`/simulados/${simulado}`,`/resultados/${result}`,`/envios/${batch}`])assert.equal((await request('recreated',url)).status,404,url);
  assert.equal((await request('recreated','/simulados')).data.simulados.length,0);
});
test('XLSX compartilhado não consulta nem inclui redação, contato ou nome/email do arquivo; o XLSX do dono preserva a avaliação',async()=>{
  const privateFeedback='FEEDBACK-PRIVADO-9B23: informe somente ao aluno confidential-student@example.test';
  const privateAssessor='AVALIADOR-PRIVADO-7C42';
  const privateSituation='SITUACAO-PRIVADA-8D12';
  const privateSource='NOME-PRIVADO-3E41-source-student@example.test.png';
  await db.run(`INSERT INTO report_feedback(resultado_id,nota_redacao,feedback_redacao,competencias_redacao,avaliador_redacao,situacao_redacao,atualizado_em)
    VALUES(?,?,?,?,?,?,?)`,result,740,privateFeedback,'[160,180,120,200,80]',privateAssessor,privateSituation,new Date().toISOString());
  await db.run('UPDATE core_resultadoaluno SET arquivo_origem=? WHERE id=?',privateSource,result);
  const originalAll=db.all.bind(db),queries=[];
  db.all=async(sql,...args)=>{queries.push(sql);return originalAll(sql,...args);};
  const xml=async buffer=>{const zip=await JSZip.loadAsync(buffer);return (await Promise.all(Object.values(zip.files).filter(file=>file.name.endsWith('.xml')).map(file=>file.async('string')))).join('\n');};
  try {
    for(const url of [`/resultados/${result}`,`/simulados/${simulado}/resultados`,`/envios/${batch}`]) {
      const response=await request('reader',url);assert.equal(response.status,200);
      const rows=response.data.resultados || [response.data.resultado];
      for(const row of rows)for(const field of ['arquivo_origem','pagina_origem','matricula_fonte'])assert.equal(field in row,false,`${url}: ${field}`);
      assert.ok(!JSON.stringify(response.data).includes(privateSource));
    }
    assert.equal((await request('owner',`/resultados/${result}`)).data.resultado.arquivo_origem,privateSource);
    for(const url of [`/simulados/${simulado}/exportar`,`/envios/${batch}/exportar`]) {
      queries.length=0;
      const response=await request('reader',url);assert.equal(response.status,200);
      assert.ok(!queries.some(sql=>/report_feedback|student_contacts/i.test(sql)),'A exportação recebida não consulta dados privados.');
      const book=new ExcelJS.Workbook();await book.xlsx.load(response.data);
      assert.equal(book.getWorksheet('Redacoes'),undefined);assert.ok(book.getWorksheet('Resultados_OMR'));assert.ok(book.getWorksheet('Desempenho_por_tema'));
      const cells=[];book.eachSheet(sheet=>sheet.eachRow(row=>row.eachCell(cell=>cells.push(cell.value))));
      for(const header of ['Arquivo_Origem','Pagina_Origem','Fonte_Matricula','Avaliador','Observações e Feedback','Competência 1','Nota Redação'])assert.ok(!cells.includes(header),header);
      assert.ok(!cells.includes(740));
      const contents=await xml(response.data);
      for(const marker of [privateFeedback,privateAssessor,privateSituation,privateSource,'private-student@example.test','Aluno privado','Redacoes'])assert.ok(!contents.includes(marker),marker);
    }
    const own=await request('owner',`/simulados/${simulado}/exportar`);assert.equal(own.status,200);
    const book=new ExcelJS.Workbook();await book.xlsx.load(own.data);
    assert.ok(book.getWorksheet('Redacoes'));assert.equal(book.getWorksheet('Redacoes').getCell('I2').value,740);
    assert.equal(book.getWorksheet('Redacoes').getCell('D2').value,160);assert.equal(book.getWorksheet('Redacoes').getCell('J2').value,privateAssessor);
    assert.equal(book.getWorksheet('Redacoes').getCell('L2').value,privateFeedback);
    const contents=await xml(own.data);for(const marker of [privateFeedback,privateAssessor,privateSituation,privateSource])assert.ok(contents.includes(marker),marker);
  } finally {
    db.all=originalAll;
    await db.run('DELETE FROM report_feedback WHERE resultado_id=?',result);
    await db.run("UPDATE core_resultadoaluno SET arquivo_origem='' WHERE id=?",result);
  }
});
test('compartilhamento não permite alterar chave, temas, revisar respostas, excluir, carregar provas ou gerir destinatários',async()=>{
  const attempts=[
    [`/simulados/${simulado}/gabarito`,'PUT',{gabarito_manual:key}],
    [`/simulados/${simulado}/temas`,'PUT',{temas:[]}],
    [`/resultados/${result}/revisao`,'PUT',{versao_esperada:0,respostas:{'1':'B'},motivo:'Tentativa fictícia'}],
    [`/simulados/${simulado}`,'DELETE',{confirmar:'sim'}],
    [`/simulados/${simulado}/compartilhamentos`,'POST',{email:accounts.third.email}],
    [`/simulados/${simulado}/compartilhamentos/${grant.id}`,'DELETE'],
  ];
  for(const [url,method,body] of attempts)assert.equal((await request('reader',url,method,body)).status,404,url);
  for(const url of [`/simulados/${simulado}/provas`,`/simulados/${simulado}/provas/importacoes`]) {
    const form=new FormData();form.set('pdf_files',new Blob(['fake']),'sheet.png');assert.equal((await request('reader',url,'POST',form)).status,404,url);
  }
  assert.equal((await db.all('SELECT * FROM answer_review_events')).length,0);assert.equal((await request('owner',`/simulados/${simulado}`)).data.simulado.total_provas,1);
});
test('contatos, avaliações de redação, PDF de boletim, envio de e-mails e arquivos de importação continuam exclusivos do dono',async()=>{
  for(const url of [`/simulados/${simulado}/boletins`,`/simulados/${simulado}/boletins/entregas`,`/resultados/${result}/boletim`,`/resultados/${result}/boletim/pdf`,`/simulados/${simulado}/provas/importacoes`,`/provas/importacoes/${secretPlan}`,`/provas/importacoes/${secretPlan}/arquivo/0`])assert.equal((await request('reader',url)).status,404,url);
  assert.equal((await request('reader','/contatos')).data.contatos.length,0);
  for(const [url,body] of [[`/resultados/${result}/redacao`,{nota_redacao:0}],[`/simulados/${simulado}/boletins/planejar`,{resultado_ids:[result]}],[`/simulados/${simulado}/boletins/enviar`,{token:'fake',confirmar:'sim'}],[`/simulados/${simulado}/redacoes/importar`,{token:'fake',confirmar:'sim'}]])assert.equal((await request('reader',url,url.includes('/redacao')&&!url.includes('/redacoes')?'PUT':'POST',body)).status,404,url);
  const form=new FormData();form.set('arquivo',new Blob(['matricula,nota total\n000001,800\n']),'essay.csv');assert.equal((await request('reader',`/simulados/${simulado}/redacoes/preview`,'POST',form)).status,404);
  for(const who of ['reader','third',null])assert.equal((await request(who,'/media/debug_images/fake.png')).status,who?404:401);
  assert.equal(messages,0);assert.equal((await db.all('SELECT * FROM report_feedback')).length,0);
});
test('CSRF continua obrigatório para conceder e revogar; revogar não altera provas e bloqueia a próxima consulta',async()=>{
  assert.equal((await request('owner',`/simulados/${simulado}/compartilhamentos/${grant.id}`,'DELETE',undefined,{'X-OMR-Client':''})).status,403);
  assert.equal((await request('owner',`/simulados/${simulado}/compartilhamentos`,'POST',{email:accounts.third.email},{Origin:'https://evil.example.test'})).status,403);
  assert.equal((await request('owner',`/simulados/${simulado}/compartilhamentos/${randomUUID()}`,'DELETE')).status,404);
  assert.equal((await request('owner',`/simulados/${simulado}/compartilhamentos/${grant.id}`,'DELETE')).status,200);
  for(const url of [`/simulados/${simulado}`,`/resultados/${result}`,`/resultados/${result}/imagem`,`/envios/${batch}`,`/simulados/${simulado}/exportar`])assert.equal((await request('reader',url)).status,404,url);
  assert.equal((await request('reader','/simulados')).data.simulados.length,0);assert.equal((await request('owner',`/resultados/${result}`)).data.resultado.total_acertos,50);
});
test('vencimento original bloqueia compartilhado antes da limpeza e cascata remove a concessão',async()=>{
  const response=await request('owner',`/simulados/${simulado}/compartilhamentos`,'POST',{email:accounts.reader.email});assert.equal(response.status,201);
  await db.run('UPDATE core_simulado SET expira_em=? WHERE id=?',new Date(Date.now()-1).toISOString(),simulado);
  for(const who of ['owner','reader'])assert.equal((await request(who,`/simulados/${simulado}/resultados`)).status,404);
  assert.equal((await request('reader','/simulados')).data.simulados.length,0);
  assert.equal((await request('owner',`/simulados/${simulado}/compartilhamentos`)).status,404);
  assert.equal((await request('owner',`/simulados/${simulado}/compartilhamentos`,'POST',{email:accounts.third.email})).status,404);
  assert.equal(await app.get(SimuladosService).cleanupExpired(),1);assert.equal((await db.all('SELECT * FROM simulado_shares')).length,0);
});
test('exclusão pelo dono remove somente o grant daquele simulado e um id de grant não funciona em outro simulado',async()=>{
  const simulados=app.get(SimuladosService),shares=app.get(SimuladoSharesService);
  await withAccount(accounts.owner,async()=>{
    const first=await simulados.create('Excluir fictício',undefined,50,[],key),second=await simulados.create('Preservar fictício',undefined,50,[],key);
    const grant=await shares.share(first.id,{email:accounts.reader.email});await shares.share(second.id,{email:accounts.reader.email});
    await assert.rejects(shares.revoke(second.id,grant.id),/não encontrado/);
    await simulados.delete(first.id,'sim');assert.equal((await shares.list(second.id)).compartilhamentos.length,1);
    await withAccount(accounts.reader,async()=>{await assert.rejects(simulados.getReadable(first.id),/não encontrado/);assert.equal((await simulados.getReadable(second.id)).pode_editar,false);});
  });
});
test('PostgreSQL real/WASM executa grants, leitura restrita, migração idempotente e RLS/cascata sem serviços externos',async()=>{
  const {PGlite}=require('@electric-sql/pglite'),{AsyncLocalStorage}=require('node:async_hooks');
  const pg=new PGlite(),transaction=new AsyncLocalStorage(),schema=await fs.readFile(path.resolve(__dirname,'../../../infra/sql/001-schema.sql'),'utf8');
  await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated;');await pg.exec(schema);
  const adapter={dialect:'postgres',all:async(sql,...parameters)=>(await pg.query(postgresPlaceholders(sql),parameters)).rows,get:async(sql,...parameters)=>(await adapter.all(sql,...parameters))[0],run:async(sql,...parameters)=>{let statement=postgresPlaceholders(sql);if(/^\s*INSERT INTO (core_simulado|core_lotecorrecao|core_resultadoaluno|report_deliveries)\b/.test(sql)&&!sql.includes('RETURNING'))statement+=' RETURNING id';const result=await pg.query(statement,parameters);return {changes:result.affectedRows,lastInsertRowid:result.rows[0]?.id};},transaction:async work=>{if(transaction.getStore())return work();await pg.exec('BEGIN');try{const result=await transaction.run(true,work);await pg.exec('COMMIT');return result;}catch(error){await pg.exec('ROLLBACK');throw error;}}};
  const simulados=new SimuladosService(adapter,{},{remove:async()=>{}}),shares=new SimuladoSharesService(adapter,simulados,{quota:async()=>{},providerAccounts:async()=>users});
  try {
    let sim,grant;
    await withAccount(accounts.owner,async()=>{sim=await simulados.create('PostgreSQL compartilhado',undefined,50,[],key);grant=await shares.share(sim.id,{email:accounts.reader.email});assert.equal((await shares.share(sim.id,{email:accounts.reader.email})).id,grant.id);});
    await pg.exec(schema);assert.equal((await adapter.all('SELECT * FROM simulado_shares')).length,1);
    await withAccount(accounts.reader,async()=>{assert.equal((await simulados.getReadable(sim.id)).acesso,'compartilhado');await assert.rejects(simulados.get(sim.id),/não encontrado/);await assert.rejects(shares.list(sim.id),/não encontrado/);});
    await pg.exec('SET ROLE anon;');await assert.rejects(pg.query('SELECT * FROM simulado_shares'),/permission denied/);await pg.exec('RESET ROLE; SET ROLE authenticated;');await assert.rejects(pg.query('SELECT * FROM simulado_shares'),/permission denied/);await pg.exec('RESET ROLE;');
    await withAccount(accounts.owner,()=>shares.revoke(sim.id,grant.id));await withAccount(accounts.reader,()=>assert.rejects(simulados.getReadable(sim.id),/não encontrado/));
    await withAccount(accounts.owner,async()=>{await shares.share(sim.id,{email:accounts.reader.email});await simulados.delete(sim.id,'sim');});assert.equal((await adapter.all('SELECT * FROM simulado_shares')).length,0);
  } finally {await pg.close();}
});
