const {test, before, after} = require('./account-fixture.cjs');
const assert = require('node:assert/strict');
const {mkdtempSync, rmSync, writeFileSync, mkdirSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const ExcelJS = require('exceljs');
const {spawnSync} = require('node:child_process');
function pdfText(pdf) {const result=spawnSync('pdftotext',['-','-'],{input:pdf,maxBuffer:2*1024*1024});assert.equal(result.status,0,result.stderr?.toString());return result.stdout.toString();}
const temp = mkdtempSync(join(tmpdir(), 'enem-reports-tests-'));
process.env.DATABASE_PATH = join(temp, 'reports.sqlite3');
process.env.DATABASE_URL = '';
process.env.MEDIA_ROOT = join(temp, 'media');
Object.assign(process.env,{STORAGE_MODE:'local',OMR_REMOTE_URL:'',AUTH_ENABLED:'false',EMAILJS_ENABLED:'false',EMAILJS_SERVICE_ID:'',EMAILJS_TEMPLATE_ID:'',EMAILJS_PUBLIC_KEY:'',EMAILJS_PRIVATE_KEY:'',RESEND_API_KEY:'',SMTP_HOST:'',SMTP_USER:'',SMTP_PASS:'',WEB_URL:'https://ficticio.example.com',REPORT_LINK_TTL_DAYS:'7',CRON_SECRET:''});
delete process.env.VERCEL;
const {DatabaseService} = require('../dist/database.service.js');
const {SimuladosService} = require('../dist/simulados.service.js');
const {ContactsService, validEmail} = require('../dist/contacts.service.js');
const {ReportsService, ReportEmailGateway, reportHtml} = require('../dist/reports.service.js');
const {grade} = require('../dist/grading.js');
const {assetPath} = require('../dist/assets.js');
const key = Object.fromEntries(Array.from({length: 50}, (_, i) => [String(i + 1), 'ABCDE'[i % 5]]));
const themes = [{inicio: 1, fim: 15, tema: 'Linguagens'}, {inicio: 16, fim: 30, tema: 'Ciências da Natureza'}, {inicio: 31, fim: 40, tema: 'Matemática'}, {inicio: 41, fim: 50, tema: 'História e Ciências Humanas'}];
let db, contacts, reports, simulados, result1, result2, result3, simuladoId, gateway;
let sent = [];
before(async () => {
  db = new DatabaseService(); contacts = new ContactsService(db); simulados = new SimuladosService(db, {});
  gateway = {availability: () => ({envio_disponivel: true, envio_motivo: 'Simulador isolado de email.'}), deliver: async (report, accessUrl, idem, expiry) => {sent.push({report, accessUrl, idem, expiry}); return 'fake-' + sent.length;}};
  reports = new ReportsService(db, simulados, contacts, gateway);
  const sim = await db.run("INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas,owner_id) VALUES(?,?,?,?,?,'11111111-1111-4111-8111-111111111111')", 'Simulado fictício de validação', new Date().toISOString(), JSON.stringify(key), 50, JSON.stringify(themes));
  simuladoId = sim.lastInsertRowid;
  const batch = await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)', new Date().toISOString(), simuladoId, JSON.stringify(key));
  async function add(matricula, answers, status) {
    const score = grade(answers, key, status, 50);
    const r = await db.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,imagem_debug,status,lote_id,mensagem_leitura) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, matricula, JSON.stringify(answers), score.total_acertos, score.total_erros, score.total_rasuras, score.total_brancos, score.total_incertas, score.nota_percentual, null, status, batch.lastInsertRowid, '');
    return r.lastInsertRowid;
  }
  result1 = await add('000123', {...key, '1':'E','2':'BNK','3':'RAS','16':'B'}, 'ALERTA_RASURA');
  result2 = await add('000124', {...key, '1':'INC'}, 'ALERTA_REVISAO');
  result3 = await add('000125', {}, 'ERRO_LEITURA');
});
after(async () => {await db?.onModuleDestroy(); rmSync(temp, {recursive:true, force:true});});

test('CSV mantém zeros iniciais, associa email exato e exige confirmação da prévia', async () => {
  const preview = await contacts.preview(Buffer.from('matrícula;email;nome;curso\n000123;aluno@example.com;Estudante fictício;Curso técnico fictício\n000124;incerto@example.com;Aluno incerto;\n000125;erro@example.com;Aluno pendente;\n'), 'contatos.csv');
  assert.deepEqual(preview.erros, []); assert.equal(preview.total, 3); assert.equal(preview.contatos[0].matricula, '000123');
  assert.equal((await contacts.list()).contatos.length, 0);
  await assert.rejects(contacts.import(preview.token, 'nao'), /confirme/);
  const imported = await contacts.import(preview.token, 'sim'); assert.equal(imported.total, 3);
  assert.equal((await contacts.get('000123')).email, 'aluno@example.com'); assert.equal(await contacts.get('123'), undefined);
  await assert.rejects(contacts.import(preview.token, 'sim'), /expirou|utilizada/);
});
test('CSV com matrícula repetida ou email malformado nunca grava contatos parcialmente', async () => {
  const preview = await contacts.preview(Buffer.from('matricula,email,nome\n004,um@example.com,Um\n004,dois@example.com,Dois\n005,nao-email,Cinco\n'), 'bad.csv');
  assert.equal(preview.token, ''); assert.equal(preview.erros.length, 2);
  await assert.rejects(contacts.import(preview.token, 'sim'));
  assert.equal(await contacts.get('004'), undefined);
});
test('CSV aceita vírgula, aspas, nomes com vírgula e preserva todos os caracteres do identificador', async () => {
  const preview = await contacts.preview(Buffer.from('matricula,email,nome\r\n"000006","seis@example.com","Silva, Ana"\r\n'), 'quoted.csv');
  assert.equal(preview.erros.length, 0); assert.equal(preview.contatos[0].nome, 'Silva, Ana'); assert.equal(preview.contatos[0].matricula, '000006');
});
test('XLSX aceita matrícula textual e recusa a numérica para não perder zeros silenciosamente', async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Contatos');
  sheet.addRow(['matricula','email','nome']); sheet.addRow(['000007','sete@example.com','Sete']);
  const preview = await contacts.preview(Buffer.from(await book.xlsx.writeBuffer()), 'contatos.xlsx');
  assert.equal(preview.erros.length, 0); assert.equal(preview.contatos[0].matricula, '000007');
  sheet.addRow([8,'oito@example.com','Oito']); sheet.getCell('A3').numFmt = '000000';
  const wrong = await contacts.preview(Buffer.from(await book.xlsx.writeBuffer()), 'contatos.xlsx');
  assert.equal(wrong.token, ''); assert.match(wrong.erros[0], /matrícula precisa estar como texto/);
});
test('XLSX rejeita fórmulas e mais de uma aba de contatos sem executar fórmulas', async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Contatos');
  sheet.addRow(['matricula','email']); sheet.addRow([{formula:'"0001"',result:'0001'}, 'a@example.com']);
  const preview = await contacts.preview(Buffer.from(await book.xlsx.writeBuffer()), 'formulas.xlsx'); assert.equal(preview.token, '');
  const other=book.addWorksheet('Outra');other.addRow(['matricula','email']);other.addRow(['0002','b@example.com']);
  await assert.rejects(contacts.preview(Buffer.from(await book.xlsx.writeBuffer()), 'duas.xlsx'), /Mais de uma aba/);
});
test('relatório institucional seleciona Registros, reconhece cabeçalhos e ignora aba Filtros', async () => {
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Registros');
  sheet.addRow(['#','Matrícula','Nome','Campus','Descrição do Curso','Email Acadêmico']);
  sheet.addRow([1,'000009','Estudante fictício','Lagarto','Curso fictício','nove@example.com']);
  const filters=book.addWorksheet('Filtros');filters.addRow(['Campo','Valor']);filters.addRow(['Situação no Curso','Matriculado']);
  const preview=await contacts.preview(Buffer.from(await book.xlsx.writeBuffer()),'relatorio.xlsx');
  assert.deepEqual(preview.erros,[]);assert.equal(preview.total,1);assert.deepEqual(preview.contatos[0],{matricula:'000009',email:'nove@example.com',nome:'Estudante fictício',curso:'Curso fictício'});
  assert.equal(await contacts.get('000009'),undefined);
});
test('relatório com duas colunas de email reconhecidas é rejeitado por ambiguidade',async()=>{
  const preview=await contacts.preview(Buffer.from('matricula,email,Email Acadêmico\n000009,a@example.com,b@example.com\n'),'ambiguo.csv');
  assert.equal(preview.token,'');assert.match(preview.erros.join(' '),/repetidas/);
});
test('linhas sem email só são ignoradas com opção explícita e aparecem nos avisos',async()=>{
  const file=Buffer.from('matricula,email\n000001,um@example.com\n000002,-\n000003,\n');
  const strict=await contacts.preview(file,'missing.csv');assert.equal(strict.token,'');assert.equal(strict.erros.length,2);
  const optional=await contacts.preview(file,'missing.csv',true);assert.equal(optional.erros.length,0);assert.equal(optional.total,1);assert.equal(optional.avisos.length,2);assert.ok(optional.token);
  assert.equal(await contacts.get('000002'),undefined);
  const wrong=await contacts.preview(Buffer.from('matricula,email\n000004,invalid-email\n'),'wrong.csv',true);assert.equal(wrong.token,'');assert.equal(wrong.erros.length,1);
});
test('EmailJS envia mensagem curta com link temporário sem notas, respostas ou anexos',async()=>{
  const report=await reports.report(result1),calls=[];
  const gateway=new ReportEmailGateway({configured:()=>true,send:async(...args)=>{calls.push(args);return 'emailjs-accepted';}});
  assert.equal(gateway.availability().envio_disponivel,true);
  const accessUrl='https://ficticio.example.com/boletim#'+require('node:crypto').randomBytes(32).toString('base64url');
  await gateway.deliver(report,accessUrl,'fake-idempotency','2030-01-01T12:00:00.000Z');
  assert.equal(calls.length,1);assert.equal(calls[0][0],report.email);
  assert.match(calls[0][2],/https:\/\/ficticio\.example\.com\/boletim/);assert.ok(calls[0][2].includes(accessUrl));
  assert.doesNotMatch(calls[0][2],/Questões|INCORRETA|PDF em anexo|<table/);
  assert.ok(!calls[0][2].includes(report.matricula));assert.ok(!calls[0][2].includes(report.nome));
});
test('mudanças de contatos são avisadas e prévia antiga não sobrescreve uma atualização posterior', async () => {
  const first = await contacts.preview(Buffer.from('matricula,email,nome\n000123,novo@example.com,Novo\n'), 'update.csv'); assert.equal(first.avisos.length, 1);
  const second = await contacts.preview(Buffer.from('matricula,email,nome\n000123,outro@example.com,Outro\n'), 'another.csv');
  await contacts.import(second.token, 'sim');
  await assert.rejects(contacts.import(first.token, 'sim'), /mudaram/);
  const restore = await contacts.preview(Buffer.from('matricula,email,nome\n000123,aluno@example.com,Estudante fictício\n'), 'restore.csv'); await contacts.import(restore.token, 'sim');
});
test('boletim calcula áreas com respostas reais e mantém duplas anuladas, brancos e percentuais sem TRI', async () => {
  const report = await reports.report(result1);
  assert.equal(report.matricula, '000123'); assert.equal(report.email, 'aluno@example.com'); assert.equal(report.geral.total_acertos, 46); assert.equal(report.geral.nota_percentual, 92);
  assert.equal(report.areas[0].total_acertos, 12); assert.equal(report.areas[0].nota, 80);
  assert.equal(report.areas[1].total_acertos, 14); assert.equal(report.areas[1].nota, 93.33);
  assert.equal(report.areas[2].nota, 100); assert.equal(report.areas[3].nota, 100);
  assert.equal(report.apto_envio, true); assert.match(report.metodologia, /não calcula a TRI/); assert.equal(report.modelo, 'boletim_individual_v2');
  assert.equal(report.nota_geral_dez,9.2); assert.equal(report.areas[0].nota_dez,8); assert.equal(report.areas[1].nota_dez,9.33);
  assert.equal(report.curso,'Curso técnico fictício');assert.equal(report.questoes.length,50);
  assert.deepEqual(report.questoes.slice(0,3).map(q=>q.resultado),['INCORRETA','BRANCO','DUPLA']);
  assert.deepEqual(report.prioridades[0].incorretas,[1]);assert.deepEqual(report.prioridades[0].brancos,[2]);assert.deepEqual(report.prioridades[0].duplas,[3]);
  assert.match(report.interpretacao,/46 acertos em 50 questões/);assert.match(report.metodologia,/permanecem no denominador/);
});
test('boletim bloqueia envio quando há leitura incerta ou erro e não fabrica nota válida', async () => {
  const uncertain = await reports.report(result2), error = await reports.report(result3);
  assert.equal(uncertain.apto_envio, false); assert.match(uncertain.pendencias.join(), /incertas/);
  assert.equal(error.apto_envio, false); assert.ok(error.areas.every(area => area.nota === null));
  await assert.rejects(reports.plan(simuladoId, [result1,result2]), /pendências/);
  assert.equal(sent.length, 0); assert.equal((await db.all('SELECT * FROM report_deliveries')).length, 0);
});
test('feedback e nota manual persistem; valida limites e escapam HTML sem apagar texto do professor', async () => {
  await assert.rejects(reports.saveEssay(result1, {nota_redacao: 1001,feedback_redacao:'X'}), /entre 0 e 1000/);
  await assert.rejects(reports.saveEssay(result1, {nota_redacao:'900'}), /número/);
  const report = await reports.saveEssay(result1, {nota_redacao: 880,feedback_redacao:'Bom argumento.\n<script>alert(1)</script> & "revise a conclusão".'});
  assert.equal(report.redacao.nota_redacao, 880); assert.match(report.redacao.feedback_redacao, /<script>/);
  const html = reportHtml(report); assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/); assert.match(html, /&amp;/);
  assert.equal((await reports.report(result1)).redacao.nota_redacao, 880);
});
test('PDF de 50 questões segue modelo individual com notas de 0 a 10 sem alterar percentual armazenado', async () => {
  const report = await reports.report(result1);
  const pdf = await reports.pdf({...report, redacao: {nota_redacao: 880, feedback_redacao: 'Seu texto apresenta uma tese clara e argumentos consistentes. Revise a pontuação e detalhe melhor a proposta de intervenção.'}});
  assert.equal(pdf.subarray(0,5).toString(), '%PDF-'); assert.ok(pdf.length > 3000);
  const pages=(pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;assert.ok(pages >= 2 && pages <= 3, `paginação inesperada: ${pages}`);
  const content=pdfText(pdf);for(const text of ['BOLETIM INDIVIDUAL','MATRÍCULA','CURSO','AVALIAÇÃO','9,20 / 10','Matemática','Ciências Humanas','Questões 26 a 50','880 / 1000']) assert.ok(content.includes(text),text);
  assert.equal((await simulados.result(result1)).resultado.nota_percentual,92);assert.equal(report.geral.nota_percentual,92);
  // Optional QA artifact uses fictitious records only, never the database from the user.
  if (process.env.REPORT_QA_PDF) {mkdirSync(resolve(process.env.REPORT_QA_PDF, '..'), {recursive:true}); writeFileSync(process.env.REPORT_QA_PDF, pdf);}
});
test('título longo não separa o título da redação de sua nota e competências', async () => {
  const report=await reports.report(result1);
  const pdf=await reports.pdf({...report,nome:'ALUNO FICTÍCIO - TESTE DE FLUXO',curso:'Teste sem dados acadêmicos reais',titulo:'TESTE FICTÍCIO - fluxo completo 50 questões - 11/10/2026',redacao:{nota_redacao:760,competencias_redacao:[200,160,120,160,120],avaliador_redacao:'Professor fictício',situacao_redacao:'Texto válido',feedback_redacao:'Feedback fictício para testar a paginação.'}});
  const pages=pdfText(pdf).split('\f');
  const essay=pages.find(page=>page.includes('Redação - avaliação do professor'));
  assert.ok(essay);assert.match(essay,/760 \/ 1000/);assert.match(essay,/COMPETÊNCIA 1/);assert.match(essay,/COMPETÊNCIA 5/);
});
test('redação extensa preserva a paginação e não corta o conteúdo final', async () => {
  const report = await reports.report(result1);
  const ending=' FINAL FICTÍCIO PRESERVADO',feedback=('A argumentação pode ser aprofundada com exemplos e uma proposta de intervenção detalhada. '.repeat(120)).slice(0,10000-ending.length)+ending;
  assert.equal(feedback.length,10000);
  const pdf = await reports.pdf({...report, redacao:{nota_redacao:900, feedback_redacao:feedback}});
  const pageCount = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pageCount > 2 && pageCount < 8, `contagem inesperada: ${pageCount}`);
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.match(pdfText(pdf),/FINAL FICTÍCIO PRESERVADO/);
  if (process.env.REPORT_QA_PDF) writeFileSync(resolve(process.env.REPORT_QA_PDF,'..','boletim_feedback_extenso_qa.pdf'),pdf);
});
test('chave histórica incompleta bloqueia envio em vez de aceitar nota fabricada', async () => {
  const batch = await db.get('SELECT lote_id FROM core_resultadoaluno WHERE id=?',result1);
  await db.run('UPDATE core_lotecorrecao SET gabarito_snapshot=? WHERE id=?','{}',batch.lote_id);
  const report = await reports.report(result1); assert.equal(report.apto_envio,false); assert.match(report.pendencias.join(),/chave histórica/);assert.equal(report.nota_geral_dez,null);assert.ok(report.areas.every(area=>area.nota_dez===null));assert.ok(report.questoes.every(q=>q.resultado==='PENDENTE'));
  await db.run('UPDATE core_lotecorrecao SET gabarito_snapshot=? WHERE id=?',JSON.stringify(key),batch.lote_id);
});
test('email não fica disponível sem um provedor/remetente e nenhum teste acessa SMTP real', async () => {
  const keys = ['SMTP_HOST','SMTP_USER','SMTP_PASS','EMAIL_FROM','SMTP_FROM','RESEND_API_KEY'];
  const before = Object.fromEntries(keys.map(key => [key,process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  try {const real = new ReportEmailGateway(); assert.equal(real.availability().envio_disponivel,false);
    await assert.rejects(real.deliver(await reports.report(result1),'https://ficticio.example.com/boletim#'+'x'.repeat(43),'id'), /remetente válido/);
  } finally {for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];}
});
test('plano só aceita IDs do simulado, ignora ID duplicado e vincula matrícula/email/hash para confirmação', async () => {
  await assert.rejects(reports.plan(simuladoId,[result1,result1]), /distintos/);
  const plan = await reports.plan(simuladoId,[result1]);
  assert.equal(plan.alunos[0].resultado_id,result1); assert.equal(plan.alunos[0].matricula,'000123'); assert.equal(plan.alunos[0].email,'aluno@example.com');
  await assert.rejects(reports.send(simuladoId,plan.token,'nao'), /confirme/); assert.equal(sent.length,0);
});
test('alteração de redação depois da prévia invalida todo o lote antes de qualquer envio', async () => {
  const plan = await reports.plan(simuladoId,[result1]);
  await reports.saveEssay(result1,{nota_redacao:920,feedback_redacao:'Feedback atualizado após a prévia.'});
  await assert.rejects(reports.send(simuladoId,plan.token,'sim'), /mudou após a prévia/); assert.equal(sent.length,0);
});
test('alteração do email depois da prévia impede mandar um boletim ao destinatário antigo', async () => {
  const plan = await reports.plan(simuladoId,[result1]);
  const update = await contacts.preview(Buffer.from('matricula,email,nome\n000123,novo@example.com,Estudante fictício\n'),'update.csv'); await contacts.import(update.token,'sim');
  await assert.rejects(reports.send(simuladoId,plan.token,'sim'), /mudou após a prévia/); assert.equal(sent.length,0);
  const restore = await contacts.preview(Buffer.from('matricula,email,nome\n000123,aluno@example.com,Estudante fictício\n'),'restore.csv'); await contacts.import(restore.token,'sim');
});
test('envio confirmado usa destinatário exato e é idempotente em novo serviço e repetição concorrente', async () => {
  const plan = await reports.plan(simuladoId,[result1]);
  const [a,b] = await Promise.all([reports.send(simuladoId,plan.token,'sim'),reports.send(simuladoId,plan.token,'sim')]);
  assert.equal(a.total_enviados + b.total_enviados,1); assert.equal(sent.length,1); assert.equal(sent[0].report.email,'aluno@example.com');
  assert.equal(sent[0].report.matricula,'000123'); assert.equal(sent[0].report.resultado_id,result1);
  const access=new URL(sent[0].accessUrl);assert.equal(access.pathname,'/boletim');assert.match(access.hash.slice(1),/^[A-Za-z0-9_-]{43}$/);assert.equal(access.search,'');
  const pdf=await reports.publicPdf(access.hash.slice(1));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  assert.match(pdfText(pdf),/9,20 \/ 10/);
  const reopened = new ReportsService(db,simulados,contacts,gateway); const replay = await reopened.send(simuladoId,plan.token,'sim');
  assert.equal(replay.total_enviados,0); assert.equal(replay.total_ignorados,1); assert.equal(replay.resultados[0].status,'ENVIADO'); assert.equal(sent.length,1);
});
test('salvar feedback idêntico não cria novo conteúdo que permita reenviar a mesma nota', async () => {
  const before = await reports.report(result1);
  await reports.saveEssay(result1, before.redacao); const after = await reports.report(result1); assert.equal(before.content_hash,after.content_hash);
  const plan = await reports.plan(simuladoId,[result1]); const outcome = await reports.send(simuladoId,plan.token,'sim'); assert.equal(outcome.total_ignorados,1); assert.equal(sent.length,1);
});
test('falha de confirmação do provedor fica ambígua persistida e jamais dispara reenvio automático', async () => {
  await reports.saveEssay(result1,{nota_redacao:940,feedback_redacao:'Novo conteúdo para simular erro do provedor.'});
  let attempted = 0; const failing = new ReportsService(db,simulados,contacts,{availability:gateway.availability,deliver:async()=>{attempted++; throw new Error('socket timeout');}});
  const plan = await failing.plan(simuladoId,[result1]); const outcome = await failing.send(simuladoId,plan.token,'sim');
  assert.equal(outcome.resultados[0].status,'AMBIGUO'); assert.match(outcome.resultados[0].erro,/Confira o provedor/);
  const replay = await failing.send(simuladoId,plan.token,'sim'); assert.equal(replay.total_ignorados,1); assert.equal(attempted,1);
});
test('plano expirado, token de outro simulado ou resultado desconhecido não gera envio', async () => {
  const plan = await reports.plan(simuladoId,[result1]);
  await db.run('UPDATE report_delivery_plans SET expira_em=?','2020-01-01T00:00:00Z');
  await assert.rejects(reports.send(simuladoId,plan.token,'sim'), /expirou|inválido/);
  await assert.rejects(reports.report(999999), /não encontrado/); assert.equal(sent.length,1);
});
test('validação de email rejeita cabeçalhos e endereços malformados', () => {
  assert.equal(validEmail('aluno@example.com'), true); assert.equal(validEmail('aluno+turma@example.com'),true);
  for(const invalid of ['x@y','x\r\nBcc: hack@example.com','..x@example.com','.x@example.com','x@-host.com']) assert.equal(validEmail(invalid), false, invalid);
});
test('assets de boletim usam caminho local portável e recusam arquivo externo ou ausente sem revelar pastas', () => {
  assert.ok(assetPath('report-fonts/OpenSans-Regular.ttf').endsWith(join('report-fonts','OpenSans-Regular.ttf')));
  for (const path of ['../.env','/etc/passwd','C:\\private\\secret.txt','report-fonts/../../.env']) assert.throws(()=>assetPath(path),/Recurso interno inválido/);
  assert.throws(()=>assetPath('missing-private-file'),error=>error.message==='Recurso do servidor indisponível. Verifique o empacotamento dos arquivos.');
});

test('curso opcional aceita CSV/XLSX, preserva coluna ausente e recusa valor numérico/fórmula', async () => {
  const csv=await contacts.preview(Buffer.from('matricula,email,nome,curso\n000020,curso@example.com,Aluno fictício,Técnico em Informática\n'),'curso.csv');
  assert.equal(csv.erros.length,0);assert.equal(csv.contatos[0].curso,'Técnico em Informática');await contacts.import(csv.token,'sim');
  const old=await contacts.preview(Buffer.from('matricula,email,nome\n000020,curso@example.com,Aluno fictício\n'),'sem-curso.csv');
  assert.equal(old.contatos[0].curso,'Técnico em Informática');await contacts.import(old.token,'sim');assert.equal((await contacts.get('000020')).curso,'Técnico em Informática');
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Contatos');sheet.addRow(['matricula','email','nome','curso']);sheet.addRow(['000021','planilha@example.com','Aluno fictício','Edificações']);
  const excel=await contacts.preview(Buffer.from(await book.xlsx.writeBuffer()),'curso.xlsx');assert.equal(excel.erros.length,0);assert.equal(excel.contatos[0].curso,'Edificações');await contacts.import(excel.token,'sim');
  sheet.getCell('D2').value=0;const numeric=await contacts.preview(Buffer.from(await book.xlsx.writeBuffer()),'numeric.xlsx');assert.equal(numeric.token,'');assert.match(numeric.erros.join(),/curso inválido/);
  sheet.getCell('D2').value={formula:'"Edificações"',result:'Edificações'};const formula=await contacts.preview(Buffer.from(await book.xlsx.writeBuffer()),'formula.xlsx');assert.equal(formula.token,'');
  const clear=await contacts.preview(Buffer.from('matricula,email,nome,curso\n000020,curso@example.com,Aluno fictício,\n'),'limpar.csv');await contacts.import(clear.token,'sim');assert.equal((await contacts.get('000020')).curso,'');
  assert.match(contacts.template(),/matricula,email,nome,curso/);
});
test('modelo e curso fazem parte do hash e invalidam planos anteriores antes de enviar', async () => {
  const plan=await reports.plan(simuladoId,[result1]);const hash=plan.alunos[0].content_hash;
  await db.run('UPDATE student_contacts SET curso=? WHERE matricula=?','Curso atualizado fictício','000123');
  assert.notEqual((await reports.report(result1)).content_hash,hash);await assert.rejects(reports.send(simuladoId,plan.token,'sim'),/mudou após a prévia/);
  const oldModel=await reports.plan(simuladoId,[result1]);const record=await db.get('SELECT payload FROM report_delivery_plans WHERE token_hash=?',require('../dist/contacts.service.js').sha256(oldModel.token));
  const rows=JSON.parse(record.payload);rows[0].content_hash='hash-do-modelo-antigo';await db.run('UPDATE report_delivery_plans SET payload=? WHERE token_hash=?',JSON.stringify(rows),require('../dist/contacts.service.js').sha256(oldModel.token));
  await assert.rejects(reports.send(simuladoId,oldModel.token,'sim'),/mudou após a prévia/);assert.equal(sent.length,1);
});
test('PDF de 60 questões conserva nomes/cursos longos, última questão, branco, dupla e quatro áreas', async () => {
  const key60=Object.fromEntries(Array.from({length:60},(_,i)=>[String(i+1),'ABCDE'[i%5]]));
  const answers={...key60,'1':'BNK','2':'RAS','59':'B','60':'A'};
  const sim=await db.run("INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas,owner_id) VALUES(?,?,?,?,?,'11111111-1111-4111-8111-111111111111')",'Avaliação fictícia com sessenta questões',new Date().toISOString(),JSON.stringify(key60),60,JSON.stringify([{inicio:1,fim:15,tema:'Linguagens'},{inicio:16,fim:30,tema:'Ciências da Natureza'},{inicio:31,fim:45,tema:'Matemática'},{inicio:46,fim:60,tema:'Ciências Humanas'}]));
  const batch=await db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)',new Date().toISOString(),sim.lastInsertRowid,JSON.stringify(key60));
  const score=grade(answers,key60,'ALERTA_RASURA',60),r=await db.run('INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,imagem_debug,status,lote_id,mensagem_leitura) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)','FICTICIO060',JSON.stringify(answers),score.total_acertos,score.total_erros,score.total_rasuras,score.total_brancos,score.total_incertas,score.nota_percentual,null,'ALERTA_RASURA',batch.lastInsertRowid,'');
  const longName='Estudante Fictício '+('Nome Composto '.repeat(9)),longCourse='Curso Técnico Fictício '+('Área Multidisciplinar '.repeat(5));
  const preview=await contacts.preview(Buffer.from(`matricula,email,nome,curso\nFICTICIO060,ficticio60@example.com,${longName},${longCourse}\n`),'ficticio.csv');assert.equal(preview.erros.length,0);await contacts.import(preview.token,'sim');
  const report=await reports.saveEssay(r.lastInsertRowid,{nota_redacao:840,feedback_redacao:'Feedback fictício: apresente exemplos concretos e desenvolva a conclusão.'});
  assert.equal(report.total_questoes,60);assert.equal(report.nota_geral_dez,9.33);assert.equal(report.questoes.at(-1).numero,60);assert.equal(report.questoes.at(-1).resultado,'INCORRETA');
  const pdf=await reports.pdf(report),content=pdfText(pdf);assert.match(content,/Questões 31 a 60/);assert.match(content,/9,33 \/ 10/);assert.match(content,/840 \/ 1000/);assert.match(content,/Área Multidisciplinar/);assert.match(content,/Estudante Fictício/);
  assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length<=4);
  const standardPdf=await reports.pdf({...report,nome:'Estudante fictício sessenta',curso:'Técnico em Edificações'});
  assert.equal((standardPdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,2);
  if (process.env.REPORT_QA_PDF) {writeFileSync(resolve(process.env.REPORT_QA_PDF,'..','boletim_modelo_60_questoes.pdf'),standardPdf);writeFileSync(resolve(process.env.REPORT_QA_PDF,'..','boletim_nome_curso_longos_qa.pdf'),pdf);}
});
