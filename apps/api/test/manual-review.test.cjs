const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const temp = mkdtempSync(join(tmpdir(),'sirenia-manual-review-'));
Object.assign(process.env,{DATABASE_URL:'',DATABASE_PATH:join(temp,'reviews.sqlite'),MEDIA_ROOT:join(temp,'media'),STORAGE_MODE:'local',VERCEL:'',WEB_URL:'https://review.example.test',REPORT_LINK_TTL_DAYS:'7',DATA_RETENTION_DAYS:'30'});
const {DatabaseService,postgresPlaceholders} = require('../dist/database.service');
const {SimuladosService} = require('../dist/simulados.service');
const {ReportsService} = require('../dist/reports.service');
const {ContactsService} = require('../dist/contacts.service');
const {ExportService} = require('../dist/export.service');
const {withAccount} = require('../dist/account-context');
const {grade} = require('../dist/grading');
const owner={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'teacher@example.test',role:'professor',nome:'Professora Fictícia'};
const other={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',email:'other@example.test',role:'professor'};
const scope=work=>withAccount(owner,work);
const allAnswers=(answer,count=50)=>Object.fromEntries(Array.from({length:count},(_,i)=>[String(i+1),answer]));
const statusError=(status)=>error=>error.getStatus?.()===status;
let db,simulados,sequence=0;
before(()=>{db=new DatabaseService();simulados=new SimuladosService(db,{},{});});
after(async()=>{await db?.onModuleDestroy();rmSync(temp,{recursive:true,force:true});});
async function fixture(answers=allAnswers('A'),status='SUCESSO',adapter=db,service=simulados,count=50) {
  const key=allAnswers('A',count),now=new Date().toISOString(),name='FICTITIOUS-'+(++sequence);
  const sim=await scope(()=>service.create(name,undefined,count,[{inicio:1,fim:25,tema:'Linguagens'},{inicio:26,fim:count,tema:'Ciências Humanas'}],key));
  const batch=(await adapter.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',now,sim.id,JSON.stringify(key))).lastInsertRowid;
  const score=grade(answers,key,status,count);
  const result=(await adapter.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,status,lote_id,mensagem_leitura)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,name,JSON.stringify(answers),score.total_acertos,score.total_erros,score.total_rasuras,score.total_brancos,score.total_incertas,score.nota_percentual,status,batch,'Mensagem original fictícia.')).lastInsertRowid;
  const original=await adapter.get('SELECT * FROM core_resultadoaluno WHERE id=?',result);
  return {sim,id:Number(result),batch:Number(batch),key,original,adapter,service};
}
const revise=(f,respostas,versao=0,motivo='Conferência no cartão original.')=>scope(()=>f.service.reviewAnswers(f.id,{versao_esperada:versao,respostas,motivo}));

test('conferir círculo azul remove nota provisória, recalcula tema e preserva OCR/espelho',async()=>{
  const f=await fixture({...allAnswers('A'),'1':'INC'},'ALERTA_REVISAO');
  const response=await revise(f,{'1':'A'}),r=response.resultado;
  assert.equal(r.status,'SUCESSO');assert.equal(r.total_incertas,0);assert.equal(r.total_acertos,50);assert.equal(r.nota_percentual,100);
  assert.equal(r.desempenho_temas[0].total_acertos,25);assert.equal(r.respostas_originais['1'],'INC');assert.equal(r.status_original,'ALERTA_REVISAO');
  assert.equal(r.revisao_versao,1);assert.equal(r.revisoes.length,1);assert.equal(r.revisoes[0].revisor_id,owner.id);
  assert.equal(r.revisoes[0].revisor_nome,owner.nome);
  assert.equal(r.revisoes[0].respostas_antes['1'],'INC');assert.equal(r.revisoes[0].respostas_depois['1'],'A');assert.ok(Date.parse(r.revisoes[0].criado_em));
  assert.deepEqual(await db.get('SELECT * FROM core_resultadoaluno WHERE id=?',f.id),f.original);
});
test('conferência pode confirmar erro, branco ou dupla; não marca resposta correta artificialmente',async()=>{
  const f=await fixture({...allAnswers('A'),'1':'INC'},'ALERTA_REVISAO');
  const {resultado:r}=await revise(f,{'1':'B','2':'BNK','3':'RAS'});
  assert.equal(r.status,'ALERTA_RASURA');assert.equal(r.total_acertos,47);assert.equal(r.total_erros,1);assert.equal(r.total_brancos,1);assert.equal(r.total_rasuras,1);assert.equal(r.nota_percentual,94);
  assert.equal(r.desempenho_temas[0].total_acertos,22);assert.equal(r.desempenho_temas[1].total_acertos,25);
});
test('uma revisão parcial mantém as demais INC e a nota provisória',async()=>{
  const f=await fixture({...allAnswers('A'),'1':'INC','26':'INC'},'ALERTA_REVISAO');
  const {resultado:r}=await revise(f,{'1':'A'});
  assert.equal(r.status,'ALERTA_REVISAO');assert.equal(r.total_incertas,1);assert.equal(r.nota_percentual,98);
  assert.equal(r.desempenho_temas[0].total_incertas,0);assert.equal(r.desempenho_temas[1].total_incertas,1);
});
test('nome do revisor vem da identidade verificada e usa email quando não há nome',async()=>{
  const f=await fixture();
  const response=await withAccount({...owner,nome:undefined},()=>simulados.reviewAnswers(f.id,{versao_esperada:0,respostas:{'1':'B'},motivo:'Conferência visual.'}));
  assert.equal(response.resultado.revisoes[0].revisor_nome,owner.email);assert.equal(response.resultado.revisoes[0].revisor_id,owner.id);
});
test('correção utiliza chave histórica do envio após o professor trocar o gabarito geral',async()=>{
  const f=await fixture();await scope(()=>simulados.updateKey(f.sim.id,undefined,undefined,allAnswers('E')));
  const {resultado:r,simulado:current}=await revise(f,{'1':'B'});
  assert.equal(current.gabarito_oficial['1'],'E');assert.equal(r.gabarito_do_envio['1'],'A');assert.equal(r.total_acertos,49);assert.equal(r.nota_percentual,98);
});
test('ERRO_LEITURA vazio somente vira nota após conferir explicitamente todas as questões em etapas',async()=>{
  const f=await fixture({},'ERRO_LEITURA');
  let r=(await revise(f,{'1':'A'})).resultado;
  assert.equal(r.status,'ERRO_LEITURA');assert.equal(r.nota_percentual,0);assert.equal(r.questoes_revisadas.length,1);assert.equal(Object.keys(r.respostas_detectadas).length,1);
  const rest=allAnswers('A');delete rest['1'];r=(await revise(f,rest,1)).resultado;
  assert.equal(r.status,'SUCESSO');assert.equal(r.nota_percentual,100);assert.equal(r.questoes_revisadas.length,50);assert.equal(r.revisoes.length,2);
  assert.deepEqual(r.respostas_originais,{});assert.equal(r.status_original,'ERRO_LEITURA');assert.deepEqual(await db.get('SELECT * FROM core_resultadoaluno WHERE id=?',f.id),f.original);
});
test('ERRO_LEITURA com respostas plausíveis ainda exige confirmar todas; funciona com 60 questões',async()=>{
  const f=await fixture(allAnswers('A',60),'ERRO_LEITURA',db,simulados,60);
  assert.equal((await revise(f,{'1':'A'})).resultado.status,'ERRO_LEITURA');
  const r=(await revise(f,allAnswers('A',60),1)).resultado;
  assert.equal(r.status,'SUCESSO');assert.equal(r.total_acertos,60);assert.equal(r.questoes_revisadas.length,60);
});
test('outra conta e identidade ausente não podem revisar nem conhecer histórico',async()=>{
  const f=await fixture();
  await assert.rejects(withAccount(other,()=>simulados.reviewAnswers(f.id,{versao_esperada:0,respostas:{'1':'B'},motivo:'Conferência.'})),statusError(404));
  await assert.rejects(simulados.reviewAnswers(f.id,{}),statusError(401));
  assert.equal((await db.all('SELECT * FROM answer_review_events WHERE resultado_id=?',f.id)).length,0);
});
test('validação recusa nota, dono, chave arbitrária, INC, índices inválidos e motivo vazio',async()=>{
  const f=await fixture(),valid={versao_esperada:0,respostas:{'1':'A'},motivo:'Conferência.'};
  for(const invalid of [{...valid,nota_percentual:100},{...valid,owner_id:other.id},{...valid,gabarito_oficial:f.key},
    {...valid,versao_esperada:'0'},{...valid,versao_esperada:-1},{...valid,respostas:{}},{...valid,respostas:[]},
    {...valid,respostas:{'1':'INC'}},{...valid,respostas:{'1':null}},{...valid,respostas:{'0':'A'}},{...valid,respostas:{'51':'A'}},
    {...valid,respostas:{'01':'A'}},{...valid,respostas:{'1.0':'A'}},{...valid,respostas:{constructor:'A'}},{...valid,revisor_nome:'Nome forjado'},{...valid,motivo:'  '},{...valid,motivo:'x'.repeat(1001)}]) {
    await assert.rejects(scope(()=>simulados.reviewAnswers(f.id,invalid)),statusError(400));
  }
  assert.equal((await db.all('SELECT * FROM answer_review_events WHERE resultado_id=?',f.id)).length,0);
});
test('duas revisões concorrentes e versão desatualizada nunca sobrescrevem silenciosamente',async()=>{
  const f=await fixture(),settled=await Promise.allSettled([revise(f,{'1':'B'}),revise(f,{'1':'C'})]);
  assert.equal(settled.filter(item=>item.status==='fulfilled').length,1);
  const rejected=settled.find(item=>item.status==='rejected');assert.equal(rejected.reason.getStatus(),409);
  assert.equal((await scope(()=>simulados.result(f.id))).resultado.revisoes.length,1);
  await assert.rejects(revise(f,{'2':'A'},0),statusError(409));
  const r=(await revise(f,{'1':'A'},1)).resultado;assert.equal(r.revisao_versao,2);assert.equal(r.revisoes[0].respostas_antes['1'],settled.find(item=>item.status==='fulfilled').value.resultado.respostas_detectadas['1']);
});
async function reportFixture() {
  const f=await fixture(),contacts=new ContactsService(db),messages=[];
  await db.run('INSERT INTO student_contacts(matricula,email,nome,curso,atualizado_em,owner_id,expira_em) VALUES(?,?,?,?,?,?,?)',f.original.matricula,'student@example.test','Aluno fictício','Curso fictício',new Date().toISOString(),owner.id,new Date(Date.now()+30*86400_000).toISOString());
  const gateway={availability:()=>({envio_disponivel:true,envio_motivo:'Gateway fictício'}),deliver:async(report,url)=>{messages.push({report,url});return 'fake-'+messages.length;}};
  return {...f,reports:new ReportsService(db,simulados,contacts,gateway),messages};
}
test('plano de email criado antes da revisão é rejeitado pelo fingerprint, sem envio automático',async()=>{
  const f=await reportFixture(),plan=await scope(()=>f.reports.plan(f.sim.id,[f.id]));
  await revise(f,{'1':'B'});
  await assert.rejects(scope(()=>f.reports.send(f.sim.id,plan.token,'sim')),statusError(400));assert.equal(f.messages.length,0);
  const newPlan=await scope(()=>f.reports.plan(f.sim.id,[f.id]));assert.equal(newPlan.alunos[0].nota_percentual,98);
});
test('revisão não altera histórico enviado; links antigos com conteúdo divergente retornam 410',async()=>{
  const f=await reportFixture(),plan=await scope(()=>f.reports.plan(f.sim.id,[f.id]));
  await scope(()=>f.reports.send(f.sim.id,plan.token,'sim'));
  const token=new URL(f.messages[0].url).hash.slice(1),delivery=await db.get('SELECT * FROM report_deliveries WHERE resultado_id=?',f.id);
  assert.equal((await f.reports.publicReport(token)).boletim.nota_geral_dez,10);
  await revise(f,{'1':'B'});
  await assert.rejects(f.reports.publicReport(token),statusError(410));assert.equal(f.messages.length,1);
  assert.deepEqual(await db.get('SELECT * FROM report_deliveries WHERE resultado_id=?',f.id),delivery);
});
test('revisão aguarda email com lease ativo e não registra nenhuma decisão parcial',async()=>{
  const f=await fixture();await db.run('INSERT INTO report_deliveries(resultado_id,destinatario,status,content_hash,criado_em) VALUES(?,?,?,?,?)',f.id,'student@example.test','ENVIANDO','fictitious',new Date().toISOString());
  await assert.rejects(revise(f,{'1':'B'}),statusError(409));
  assert.equal((await db.all('SELECT * FROM answer_review_events WHERE resultado_id=?',f.id)).length,0);
  await db.run('UPDATE report_deliveries SET criado_em=? WHERE resultado_id=?',new Date(Date.now()-180_000).toISOString(),f.id);
  assert.equal((await revise(f,{'1':'B'})).resultado.nota_percentual,98);
});
test('planilha Excel exporta respostas e temas revisados com OCR original preservado no banco',async()=>{
  const f=await fixture({...allAnswers('A'),'1':'INC'},'ALERTA_REVISAO');await revise(f,{'1':'B'});
  const data=await scope(()=>simulados.results(f.sim.id)),buffer=await new ExportService(db).create(data);
  const ExcelJS=require('exceljs'),workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);
  const sheet=workbook.getWorksheet('Resultados_OMR'),headers=sheet.getRow(1).values;
  assert.equal(sheet.getCell(2,headers.indexOf('Q1')).value,'B (✗)');assert.equal(sheet.getCell(2,headers.indexOf('Total_Acertos')).value,49);
  assert.equal(sheet.getCell(2,headers.indexOf('Pontuacao_Percentual')).value,'98%');
  assert.deepEqual(await db.get('SELECT * FROM core_resultadoaluno WHERE id=?',f.id),f.original);
});
test('exclusão do simulado remove trilha auditável em cascata com a prova',async()=>{
  const f=await fixture();await revise(f,{'1':'B'});await scope(()=>simulados.delete(f.sim.id,'sim'));
  assert.equal((await db.all('SELECT * FROM answer_review_events WHERE resultado_id=?',f.id)).length,0);
});
test('PostgreSQL real via PGlite aplica revisão, FOR UPDATE, UNIQUE e cascata sem acessar serviços externos',async()=>{
  const {PGlite}=require('@electric-sql/pglite'),{readFile}=require('node:fs/promises'),{resolve}=require('node:path'),{AsyncLocalStorage}=require('node:async_hooks');
  const pg=new PGlite(),context=new AsyncLocalStorage();
  const adapter={dialect:'postgres',all:async(sql,...parameters)=>(await pg.query(postgresPlaceholders(sql),parameters)).rows,
    get:async(sql,...parameters)=>(await adapter.all(sql,...parameters))[0],run:async(sql,...parameters)=>{
      let statement=postgresPlaceholders(sql);if(/^\s*INSERT INTO (core_simulado|core_lotecorrecao|core_resultadoaluno|report_deliveries)\b/.test(sql)&&!sql.includes('RETURNING'))statement+=' RETURNING id';
      const result=await pg.query(statement,parameters);return {changes:result.affectedRows,lastInsertRowid:result.rows[0]?.id};
    },transaction:async work=>{if(context.getStore())return work();await pg.exec('BEGIN');try{const result=await context.run(true,work);await pg.exec('COMMIT');return result;}catch(error){await pg.exec('ROLLBACK');throw error;}}};
  try {
    await pg.exec(await readFile(resolve(__dirname,'../../../infra/sql/001-schema.sql'),'utf8'));
    const service=new SimuladosService(adapter,{},{}),f=await fixture({...allAnswers('A'),'1':'INC'},'ALERTA_REVISAO',adapter,service);
    const r=(await revise(f,{'1':'B'})).resultado;assert.equal(r.total_acertos,49);assert.equal(r.status,'SUCESSO');
    await assert.rejects(revise(f,{'1':'C'},0),statusError(409));
    await assert.rejects(withAccount(other,()=>service.reviewAnswers(f.id,{versao_esperada:1,respostas:{'1':'A'},motivo:'Conferência.'})),statusError(404));
    assert.deepEqual(await adapter.get('SELECT * FROM core_resultadoaluno WHERE id=?',f.id),f.original);
    await pg.exec(await readFile(resolve(__dirname,'../../../infra/sql/001-schema.sql'),'utf8'));
    assert.equal((await adapter.all('SELECT * FROM answer_review_events')).length,1);
    await scope(()=>service.delete(f.sim.id,'sim'));assert.equal((await adapter.all('SELECT * FROM answer_review_events')).length,0);
  } finally {await pg.close();}
});
