const {test} = require('./account-fixture.cjs');
const assert = require('node:assert/strict');
const {mkdtempSync,rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const ExcelJS = require('exceljs');
require('reflect-metadata');
process.env.DATABASE_URL = '';
process.env.OMR_REMOTE_URL = '';
process.env.AUTH_ENABLED = 'false';
process.env.STORAGE_MODE = 'local';
for (const key of ['EMAILJS_PUBLIC_KEY','EMAILJS_PRIVATE_KEY','EMAILJS_SERVICE_ID','EMAILJS_TEMPLATE_ID','RESEND_API_KEY','SMTP_PASS']) process.env[key] = '';
const config = require('../dist/config');
const {DatabaseService,postgresPlaceholders} = require('../dist/database.service');
const {SimuladosService} = require('../dist/simulados.service');
const {EssayImportService,essayHeader} = require('../dist/essay-import.service');

const headers = ['Carimbo de data/hora','Nome do Avaliador','Nome Completo do Aluno','Matrícula do Aluno','Situação do Texto / Anulação',
  'Competência 1: Domínio da modalidade escrita formal da língua portuguesa',
  'Competência 2: Compreender o tema e aplicar conceitos das várias áreas do conhecimento',
  'Competência 3: Selecionar, relacionar, organizar e interpretar informações em defesa de um ponto de vista',
  'Competência 4: Demonstrar conhecimento dos mecanismos linguísticos (Coesão)',
  'Competência 5: Elaborar proposta de intervenção que respeite os direitos humanos',
  'Observações Gerais e Feedback para o Aluno'];
const simpleHeaders = ['matricula','c1','c2','c3','c4','c5','feedback'];
function csv(rows, columns = simpleHeaders) {return Buffer.from([columns,...rows].map(row=>row.map(cell=>`"${String(cell ?? '').replaceAll('"','""')}"`).join(';')).join('\r\n'));}
function sourceRow(matricula='000123', grades=[160,120,200,160,120], feedback='Revisar a conexão entre os argumentos.') {return ['10/10/2026 10:20:00','Professora fictícia','Aluno fictício',matricula,'Texto válido',...grades,feedback];}
async function xlsx(rows, options={}) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Respostas ao formulário 1');
  sheet.addRow(options.headers || headers);
  for (const row of rows) sheet.addRow(row);
  if (options.second) {const other=book.addWorksheet('Respostas duplicadas');other.addRow(headers);other.addRow(sourceRow());}
  if (options.extra) {const other=book.addWorksheet('Filtros');other.addRow(['Campo','Valor']);other.addRow(['Sem dados pessoais','Sem dados pessoais']);}
  if (options.gap) {sheet.getRow(3).values=[];sheet.getRow(4).values=sourceRow('000124');}
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function createRecords(db) {
  const date='2026-10-10T12:00:00.000Z', key=JSON.stringify(Object.fromEntries(Array.from({length:50},(_,i)=>[i+1,'ABCDE'[i%5]])));
  const sim=(await db.run("INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas,owner_id) VALUES(?,?,?,?,?,'11111111-1111-4111-8111-111111111111')",'Simulado fictício de importação',date,key,50,'[]')).lastInsertRowid;
  const other=(await db.run("INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas,owner_id) VALUES(?,?,?,?,?,'11111111-1111-4111-8111-111111111111')",'Outro simulado fictício',date,key,50,'[]')).lastInsertRowid;
  const lot=(await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',date,sim,key)).lastInsertRowid;
  const otherLot=(await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',date,other,key)).lastInsertRowid;
  async function add(matricula, batch=lot) {return (await db.run('INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,nota_percentual,status,lote_id) VALUES(?,?,?,?,?,?,?,?,?)',matricula,key,50,0,0,0,100,'SUCESSO',batch)).lastInsertRowid;}
  const ids=[await add('000123'),await add('000123'),await add('000124')],otherId=await add('000123',otherLot);
  return {sim,other,ids,otherId,add};
}
async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'enem-essay-import-'));
  config.DATABASE_URL='';config.DATABASE_PATH=join(dir,'isolated.sqlite');
  const db=new DatabaseService();await db.onModuleInit();
  const existing=await db.all('PRAGMA table_info(report_feedback)');
  for (const [name,defaultValue] of [['competencias_redacao','[]'],['avaliador_redacao',''],['situacao_redacao',''],['origem_redacao','manual']]) if(!existing.some(col=>col.name===name)) await db.run(`ALTER TABLE report_feedback ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${defaultValue}'`);
  await db.run('CREATE TABLE IF NOT EXISTS essay_import_plans(token_hash TEXT PRIMARY KEY,simulado_id INTEGER NOT NULL REFERENCES core_simulado(id) ON DELETE CASCADE,payload TEXT NOT NULL,expira_em TEXT NOT NULL,criado_em TEXT NOT NULL)');
  const records=await createRecords(db),simulados=new SimuladosService(db,{},{}),service=new EssayImportService(db,simulados);
  return {db,service,...records,close:async()=>{await db.onModuleDestroy();rmSync(dir,{recursive:true,force:true});}};
}

test('cabeçalhos reais do Forms reconhecem matrícula, cinco competências e feedback sem posição fixa',()=>{
  assert.deepEqual(headers.map(essayHeader),['','avaliador','nome','matricula','situacao','c1','c2','c3','c4','c5','feedback']);
  assert.equal(essayHeader('  NOTA GERAL '),'total');assert.equal(essayHeader('Competência 5'),'c5');assert.equal(essayHeader('C5'),'c5');assert.equal(essayHeader('Nome do Avaliador'),'avaliador');
});
test('modelo de respostas vazio é identificado sem gravar prévia ou inventar notas',async()=>{
  const f=await fixture();try {const preview=await f.service.preview(f.sim,await xlsx([]),'modelo.xlsx');assert.equal(preview.token,'');assert.equal(preview.total,0);assert.match(preview.erros.join(' '),/apenas o cabeçalho/);assert.equal((await f.db.all('SELECT * FROM essay_import_plans')).length,0);assert.equal((await f.db.all('SELECT * FROM report_feedback')).length,0);}finally{await f.close();}
});
test('XLSX do Forms calcula total e guarda critérios, avaliador, situação e observações completas',async()=>{
  const f=await fixture();try {const preview=await f.service.preview(f.sim,await xlsx([sourceRow()]),'respostas.xlsx');assert.deepEqual(preview.erros,[]);assert.equal(preview.linhas[0].nota_redacao,760);assert.deepEqual(preview.linhas[0].competencias,[160,120,200,160,120]);assert.equal(preview.novas,1);assert.equal(preview.total_resultados,2);assert.deepEqual(preview.linhas[0].resultado_ids,f.ids.slice(0,2));assert.equal((await f.db.all('SELECT * FROM report_feedback')).length,0);const imported=await f.service.import(f.sim,preview.token,'sim','nao');assert.equal(imported.total,1);assert.equal(imported.total_resultados,2);const saved=await f.db.get('SELECT * FROM report_feedback WHERE resultado_id=?',f.ids[0]);assert.equal(saved.nota_redacao,760);assert.equal(saved.avaliador_redacao,'Professora fictícia');assert.equal(saved.situacao_redacao,'Texto válido');assert.equal(saved.origem_redacao,'planilha');assert.deepEqual(JSON.parse(saved.competencias_redacao),[160,120,200,160,120]);assert.equal(saved.feedback_redacao,'Revisar a conexão entre os argumentos.');assert.equal(await f.db.get('SELECT * FROM report_feedback WHERE resultado_id=?',f.otherId),undefined);}finally{await f.close();}
});
test('ordem de colunas e aba auxiliar não mudam associação por matrícula',async()=>{
  const f=await fixture();try {const order=[8,3,10,7,1,9,5,6,2,4,0],row=sourceRow();const preview=await f.service.preview(f.sim,await xlsx([order.map(i=>row[i])],{headers:order.map(i=>headers[i]),extra:true}),'reordenada.xlsx');assert.deepEqual(preview.erros,[]);assert.equal(preview.linhas[0].matricula,'000123');assert.equal(preview.linhas[0].nota_redacao,760);}finally{await f.close();}
});
test('CSV preserva zeros, aspas e observações multilinha; nota zero não é ausência',async()=>{
  const f=await fixture();try {const preview=await f.service.preview(f.sim,csv([['000124',0,'0 pontos','0,00',0,0,'Observação: "rever".\nSegunda linha.']]),'avaliacoes.csv');assert.deepEqual(preview.erros,[]);assert.equal(preview.linhas[0].nota_redacao,0);assert.equal(preview.linhas[0].feedback_redacao,'Observação: "rever".\nSegunda linha.');assert.deepEqual(preview.linhas[0].resultado_ids,[f.ids[2]]);}finally{await f.close();}
});
test('nota geral explícita precisa reconciliar com soma das competências',async()=>{
  const f=await fixture();try {const good=await f.service.preview(f.sim,csv([['000124',160,160,160,160,160,'Feedback',800]],[...simpleHeaders,'Nota Geral']),'total.csv');assert.deepEqual(good.erros,[]);const bad=await f.service.preview(f.sim,csv([['000124',160,160,160,160,160,'Feedback',900]],[...simpleHeaders,'Nota Geral']),'total.csv');assert.equal(bad.token,'');assert.match(bad.erros.join(' '),/difere da soma/);}finally{await f.close();}
});
test('faltas, negativos, escalas erradas, infinito e texto em critérios bloqueiam toda a importação',async()=>{
  const f=await fixture();try {for (const value of ['',-1,201,'Infinity','160x','20%']) {const preview=await f.service.preview(f.sim,csv([['000124',value,160,160,160,160,'teste']]),'invalid.csv');assert.equal(preview.token,'',String(value));assert.ok(preview.erros.some(message=>message.includes('Competência 1')),String(value));}assert.equal((await f.db.all('SELECT * FROM report_feedback')).length,0);}finally{await f.close();}
});
test('matrícula textual exata não perde zeros nem se associa por nome',async()=>{
  const f=await fixture();try {const preview=await f.service.preview(f.sim,await xlsx([sourceRow('123')]),'leading.xlsx');assert.equal(preview.token,'');assert.match(preview.erros.join(' '),/sem prova/);assert.deepEqual(preview.linhas[0].resultado_ids,[]);}finally{await f.close();}
});
test('matrícula numérica segura é convertida exatamente, com aviso; valores inseguros são recusados',async()=>{
  const f=await fixture();try {await f.add('20260001');const preview=await f.service.preview(f.sim,await xlsx([sourceRow(20260001)]),'numeric.xlsx');assert.deepEqual(preview.erros,[]);assert.equal(preview.linhas[0].matricula,'20260001');assert.match(preview.avisos.join(' '),/zeros iniciais não foram acrescentados/);for (const value of [1.5,-1,Number.MAX_SAFE_INTEGER+1]) {const bad=await f.service.preview(f.sim,await xlsx([sourceRow(value)]),'unsafe.xlsx');assert.equal(bad.token,'');assert.match(bad.erros.join(' '),/numérica inválida/);}}finally{await f.close();}
});
test('avaliações sem prova requerem escolha explícita de ignorar e nunca são gravadas em outro simulado',async()=>{
  const f=await fixture();try {const file=csv([['000124',160,160,160,160,160,'OK'],['other-only',160,160,160,160,160,'pendente']]);const strict=await f.service.preview(f.sim,file,'missing.csv');assert.equal(strict.token,'');assert.equal(strict.sem_resultado,1);const optional=await f.service.preview(f.sim,file,'missing.csv',true);assert.deepEqual(optional.erros,[]);assert.equal(optional.sem_resultado,1);assert.match(optional.avisos.join(' '),/será ignorada/);const result=await f.service.import(f.sim,optional.token,'sim','nao');assert.equal(result.ignoradas,1);assert.equal(result.total_resultados,1);assert.equal((await f.db.all('SELECT * FROM report_feedback')).length,1);}finally{await f.close();}
});
test('planilha só com matrículas ausentes não permite confirmação vazia',async()=>{
  const f=await fixture();try {const preview=await f.service.preview(f.sim,csv([['missing',0,0,0,0,0,'']]),'missing.csv',true);assert.equal(preview.token,'');assert.match(preview.erros.join(' '),/Nenhuma matrícula/);}finally{await f.close();}
});
test('matrícula duplicada e cabeçalho repetido bloqueiam avaliação ambígua',async()=>{
  const f=await fixture();try {const duplicate=await f.service.preview(f.sim,csv([['000124',160,160,160,160,160,'primeira'],['000124',200,200,200,200,200,'segunda']]),'dup.csv');assert.equal(duplicate.token,'');assert.match(duplicate.erros.join(' '),/Matrícula repetida/);const repeated=await f.service.preview(f.sim,csv([['000124',160,160,160,160,160,'teste',140]],[...simpleHeaders,'Competência 1']),'header.csv');assert.equal(repeated.token,'');assert.match(repeated.erros.join(' '),/colunas reconhecidas repetidas/);}finally{await f.close();}
});
test('fórmula de matrícula, nota ou feedback é recusada mesmo com resultado em cache',async()=>{
  const f=await fixture();try {for (const [index,value] of [[3,{formula:'"000124"',result:'000124'}],[5,{formula:'80+80',result:160}],[10,{formula:'"Falso feedback"',result:'Falso feedback'}]]) {const row=sourceRow('000124');row[index]=value;const preview=await f.service.preview(f.sim,await xlsx([row]),'formula.xlsx');assert.equal(preview.token,'');assert.ok(preview.erros.length);}}finally{await f.close();}
});
test('duas abas de redações e cabeçalhos sem cinco competências são recusados',async()=>{
  const f=await fixture();try {await assert.rejects(f.service.preview(f.sim,await xlsx([sourceRow()],{second:true}),'duas.xlsx'),/Mais de uma aba/);await assert.rejects(f.service.preview(f.sim,await xlsx([['000123',800]],{headers:['matricula','nota total']}),'incompleta.xlsx'),/cinco|Competência 1 a 5/);}finally{await f.close();}
});
test('numeração de linhas XLSX preserva linhas vazias para localizar erros',async()=>{
  const f=await fixture();try {const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Forms');sheet.addRow(headers);sheet.addRow(sourceRow());sheet.getRow(5).values=sourceRow('000124',[201,0,0,0,0]);const preview=await f.service.preview(f.sim,Buffer.from(await book.xlsx.writeBuffer()),'gap.xlsx');assert.equal(preview.token,'');assert.match(preview.erros.join(' '),/Linha 5:/);}finally{await f.close();}
});
test('situação e anulação são mantidas como texto sem inventar nota nem afetar questões objetivas',async()=>{
  const f=await fixture();try {const row=sourceRow('000124',[160,160,160,160,160]);row[4]='Situação registrada pelo professor';const preview=await f.service.preview(f.sim,await xlsx([row]),'situation.xlsx');assert.deepEqual(preview.erros,[]);assert.equal(preview.linhas[0].nota_redacao,800);await f.service.import(f.sim,preview.token,'sim','nao');const feedback=await f.db.get('SELECT * FROM report_feedback WHERE resultado_id=?',f.ids[2]);assert.equal(feedback.situacao_redacao,row[4]);assert.equal((await f.db.get('SELECT total_acertos FROM core_resultadoaluno WHERE id=?',f.ids[2])).total_acertos,50);}finally{await f.close();}
});
test('avaliações já existentes exigem confirmação adicional e mostram valores anteriores',async()=>{
  const f=await fixture();try {const first=await f.service.preview(f.sim,csv([['000124',100,100,100,100,100,'Avaliação antiga']]),'first.csv');await f.service.import(f.sim,first.token,'sim','nao');const next=await f.service.preview(f.sim,csv([['000124',160,160,160,160,160,'Avaliação revisada']]),'next.csv');assert.equal(next.atualizacoes,1);assert.equal(next.linhas[0].anteriores[0].nota_redacao,500);assert.equal(next.linhas[0].anteriores[0].feedback_redacao,'Avaliação antiga');await assert.rejects(f.service.import(f.sim,next.token,'sim','nao'),/Confirme também/);assert.equal((await f.db.get('SELECT nota_redacao FROM report_feedback WHERE resultado_id=?',f.ids[2])).nota_redacao,500);await f.service.import(f.sim,next.token,'sim','sim');assert.equal((await f.db.get('SELECT nota_redacao FROM report_feedback WHERE resultado_id=?',f.ids[2])).nota_redacao,800);}finally{await f.close();}
});
test('mesmo conteúdo importado novamente não sobrescreve data nem gera alterações',async()=>{
  const f=await fixture();try {const file=csv([['000124',100,100,100,100,100,'igual']]);const preview=await f.service.preview(f.sim,file,'same.csv');await f.service.import(f.sim,preview.token,'sim','nao');const before=await f.db.get('SELECT atualizado_em FROM report_feedback WHERE resultado_id=?',f.ids[2]);const again=await f.service.preview(f.sim,file,'same.csv');assert.equal(again.sem_alteracao,1);assert.equal(again.atualizacoes,0);const result=await f.service.import(f.sim,again.token,'sim','nao');assert.equal(result.total,0);assert.equal(result.sem_alteracao,1);assert.deepEqual(await f.db.get('SELECT atualizado_em FROM report_feedback WHERE resultado_id=?',f.ids[2]),before);}finally{await f.close();}
});
test('confirmação inválida, token reutilizado, expirado ou de outro simulado não grava avaliações',async()=>{
  const f=await fixture();try {const file=csv([['000124',160,160,160,160,160,'OK']]);const preview=await f.service.preview(f.sim,file,'auth.csv');await assert.rejects(f.service.import(f.sim,preview.token,'nao','nao'),/confirme/);await assert.rejects(f.service.import(f.other,preview.token,'sim','nao'),/expirou|utilizada/);assert.equal((await f.db.all('SELECT * FROM report_feedback')).length,0);await f.service.import(f.sim,preview.token,'sim','nao');await assert.rejects(f.service.import(f.sim,preview.token,'sim','nao'),/expirou|utilizada/);const expired=await f.service.preview(f.sim,file,'expired.csv');await f.db.run('UPDATE essay_import_plans SET expira_em=?','2000-01-01T00:00:00.000Z');await assert.rejects(f.service.import(f.sim,expired.token,'sim','nao'),/expirou|utilizada/);}finally{await f.close();}
});
test('alteração de nota ou nova prova após prévia invalida a associação anterior',async()=>{
  const f=await fixture();try {const file=csv([['000124',160,160,160,160,160,'OK']]);const preview=await f.service.preview(f.sim,file,'stale.csv');await f.db.run('INSERT INTO report_feedback(resultado_id,nota_redacao,feedback_redacao,atualizado_em) VALUES(?,?,?,?)',f.ids[2],400,'Alteração manual','2026-10-11T12:00:00Z');await assert.rejects(f.service.import(f.sim,preview.token,'sim','sim'),/mudaram após/);assert.equal((await f.db.get('SELECT nota_redacao FROM report_feedback WHERE resultado_id=?',f.ids[2])).nota_redacao,400);const next=await f.service.preview(f.sim,file,'stale-result.csv');await f.add('000124');await assert.rejects(f.service.import(f.sim,next.token,'sim','sim'),/mudaram após/);}finally{await f.close();}
});
test('falha na gravação intermediária desfaz todas avaliações e preserva token para nova tentativa',async()=>{
  const f=await fixture();try {const preview=await f.service.preview(f.sim,csv([['000123',160,160,160,160,160,'OK'],['000124',120,120,120,120,120,'OK']]),'rollback.csv');const original=f.db.run.bind(f.db);let writes=0;f.db.run=async(sql,...args)=>{if(/^INSERT INTO report_feedback/.test(sql) && ++writes===2) throw new Error('falha planejada');return original(sql,...args);};await assert.rejects(f.service.import(f.sim,preview.token,'sim','nao'),/falha planejada/);f.db.run=original;assert.equal((await f.db.all('SELECT * FROM report_feedback')).length,0);assert.equal((await f.db.all('SELECT * FROM essay_import_plans')).length,1);assert.equal((await f.service.import(f.sim,preview.token,'sim','nao')).total_resultados,3);}finally{await f.close();}
});
test('duas confirmações concorrentes aplicam um único token uma vez',async()=>{
  const f=await fixture();try {const preview=await f.service.preview(f.sim,csv([['000124',160,160,160,160,160,'OK']]),'concurrent.csv');const results=await Promise.allSettled([f.service.import(f.sim,preview.token,'sim','nao'),f.service.import(f.sim,preview.token,'sim','nao')]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal((await f.db.all('SELECT * FROM report_feedback')).length,1);assert.equal((await f.db.all('SELECT * FROM essay_import_plans')).length,0);}finally{await f.close();}
});
test('arquivo inválido, vazio, grande e número excessivo de linhas são recusados antes de gravar plano',async()=>{
  const f=await fixture();try {await assert.rejects(f.service.preview(f.sim,Buffer.alloc(0),'empty.xlsx'),/até 2 MB/);await assert.rejects(f.service.preview(f.sim,Buffer.from('bad'),'bad.xls'),/XLSX ou CSV/);await assert.rejects(f.service.preview(f.sim,Buffer.from('not zip'),'broken.xlsx'),/Não foi possível/);await assert.rejects(f.service.preview(f.sim,Buffer.alloc(2*1024*1024+1),'big.csv'),/até 2 MB/);await assert.rejects(f.service.preview(f.sim,csv(Array.from({length:1001},(_,i)=>[String(i),0,0,0,0,0,''])),'rows.csv'),/1.000/);}finally{await f.close();}
});
test('PostgreSQL isolado com PGlite confirma associação, upsert e consumo único do plano',async()=>{
  const {PGlite}=require('@electric-sql/pglite');const pg=new PGlite();
  await pg.exec(`CREATE TABLE core_simulado(owner_id TEXT NOT NULL DEFAULT '',expira_em TEXT,id SERIAL PRIMARY KEY,titulo TEXT,data_criacao TEXT,gabarito_oficial TEXT,total_questoes INTEGER,temas TEXT);
    CREATE TABLE core_lotecorrecao(id SERIAL PRIMARY KEY,criado_em TEXT,simulado_id INTEGER REFERENCES core_simulado(id),gabarito_snapshot TEXT);
    CREATE TABLE core_resultadoaluno(id SERIAL PRIMARY KEY,matricula TEXT,respostas_detectadas TEXT,total_acertos INTEGER,total_erros INTEGER,total_rasuras INTEGER,total_brancos INTEGER,nota_percentual REAL,status TEXT,lote_id INTEGER REFERENCES core_lotecorrecao(id));
    CREATE TABLE report_feedback(resultado_id INTEGER PRIMARY KEY REFERENCES core_resultadoaluno(id),nota_redacao REAL,feedback_redacao TEXT,atualizado_em TEXT,competencias_redacao TEXT NOT NULL DEFAULT '[]',avaliador_redacao TEXT NOT NULL DEFAULT '',situacao_redacao TEXT NOT NULL DEFAULT '',origem_redacao TEXT NOT NULL DEFAULT 'manual');
    CREATE TABLE essay_import_plans(token_hash TEXT PRIMARY KEY,simulado_id INTEGER REFERENCES core_simulado(id),payload TEXT,expira_em TEXT,criado_em TEXT);`);
  const db={all:async(sql,...args)=>(await pg.query(postgresPlaceholders(sql),args)).rows,get:async(sql,...args)=>(await db.all(sql,...args))[0],run:async(sql,...args)=>{let translated=postgresPlaceholders(sql);if(/^INSERT INTO core_/.test(sql)) translated+=' RETURNING id';const result=await pg.query(translated,args);return {changes:result.affectedRows,lastInsertRowid:result.rows[0]?.id};},transaction:async(work)=>{await pg.exec('BEGIN');try {const result=await work();await pg.exec('COMMIT');return result;}catch(error){await pg.exec('ROLLBACK');throw error;}}};
  try {const f=await createRecords(db),service=new EssayImportService(db,{get:async id=>{const value=await db.get('SELECT id FROM core_simulado WHERE id=?',id);if(!value) throw new Error('missing');return value;}});const preview=await service.preview(f.sim,csv([['000123',160,160,160,160,160,'PostgreSQL isolado']]),'pg.csv');assert.deepEqual(preview.erros,[]);const result=await service.import(f.sim,preview.token,'sim','nao');assert.equal(result.total_resultados,2);const rows=await db.all('SELECT * FROM report_feedback ORDER BY resultado_id');assert.equal(rows.length,2);assert.ok(rows.every(row=>row.nota_redacao===800));assert.deepEqual(JSON.parse(rows[0].competencias_redacao),[160,160,160,160,160]);assert.equal((await db.all('SELECT * FROM essay_import_plans')).length,0);await assert.rejects(service.import(f.sim,preview.token,'sim','nao'),/expirou|utilizada/);const next=await service.preview(f.sim,csv([['000123',120,120,120,120,120,'Revisão PostgreSQL']]),'revised.csv');assert.equal(next.atualizacoes,1);assert.equal((await service.import(f.sim,next.token,'sim','sim')).total_resultados,2);assert.ok((await db.all('SELECT * FROM report_feedback')).every(row=>row.nota_redacao===600));assert.equal(await db.get('SELECT * FROM report_feedback WHERE resultado_id=?',f.otherId),undefined);}finally{await pg.close();}
});
