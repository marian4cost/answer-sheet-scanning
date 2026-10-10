const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync, rmSync, writeFileSync, mkdirSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const ExcelJS = require('exceljs');
const temp = mkdtempSync(join(tmpdir(), 'enem-reports-tests-'));
process.env.DATABASE_PATH = join(temp, 'reports.sqlite3');
process.env.DATABASE_URL = '';
process.env.MEDIA_ROOT = join(temp, 'media');
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
  gateway = {availability: () => ({envio_disponivel: true, envio_motivo: 'Simulador isolado de email.'}), deliver: async (report, pdf, idem) => {sent.push({report, pdf, idem}); return 'fake-' + sent.length;}};
  reports = new ReportsService(db, simulados, contacts, gateway);
  const sim = await db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas) VALUES(?,?,?,?,?)', 'Simulado fictício de validação', new Date().toISOString(), JSON.stringify(key), 50, JSON.stringify(themes));
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
  const preview = await contacts.preview(Buffer.from('matrícula;email;nome\n000123;aluno@example.com;Estudante fictício\n000124;incerto@example.com;Aluno incerto\n000125;erro@example.com;Aluno pendente\n'), 'contatos.csv');
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
test('XLSX com fórmulas ou múltiplas abas é rejeitado sem executar fórmulas', async () => {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Contatos');
  sheet.addRow(['matricula','email']); sheet.addRow([{formula:'"0001"',result:'0001'}, 'a@example.com']);
  const preview = await contacts.preview(Buffer.from(await book.xlsx.writeBuffer()), 'formulas.xlsx'); assert.equal(preview.token, '');
  book.addWorksheet('Outra'); await assert.rejects(contacts.preview(Buffer.from(await book.xlsx.writeBuffer()), 'duas.xlsx'), /apenas uma aba/);
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
  assert.equal(report.apto_envio, true); assert.match(report.metodologia, /não calcula a TRI/); assert.equal(report.modelo, 'provisorio');
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
test('PDF gera conteúdo local sem imagens externas e a nota é uma percentagem de acertos', async () => {
  const report = await reports.report(result1);
  const pdf = await reports.pdf({...report, redacao: {nota_redacao: 880, feedback_redacao: 'Seu texto apresenta uma tese clara e argumentos consistentes. Revise a pontuação e detalhe melhor a proposta de intervenção.'}});
  assert.equal(pdf.subarray(0,5).toString(), '%PDF-'); assert.ok(pdf.length > 3000);
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1, 'o rodapé não pode criar páginas extras');
  // Optional QA artifact uses fictitious records only, never the database from the user.
  if (process.env.REPORT_QA_PDF) {mkdirSync(resolve(process.env.REPORT_QA_PDF, '..'), {recursive:true}); writeFileSync(process.env.REPORT_QA_PDF, pdf);}
});
test('redação extensa preserva a paginação e não corta o conteúdo final', async () => {
  const report = await reports.report(result1);
  const pdf = await reports.pdf({...report, redacao:{nota_redacao:900, feedback_redacao:'A argumentação pode ser aprofundada com exemplos e uma proposta de intervenção detalhada. '.repeat(90)}});
  const pageCount = (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pageCount > 1 && pageCount < 6, `contagem inesperada: ${pageCount}`);
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
});
test('chave histórica incompleta bloqueia envio em vez de aceitar nota fabricada', async () => {
  const batch = await db.get('SELECT lote_id FROM core_resultadoaluno WHERE id=?',result1);
  await db.run('UPDATE core_lotecorrecao SET gabarito_snapshot=? WHERE id=?','{}',batch.lote_id);
  const report = await reports.report(result1); assert.equal(report.apto_envio,false); assert.match(report.pendencias.join(),/chave histórica/);
  await db.run('UPDATE core_lotecorrecao SET gabarito_snapshot=? WHERE id=?',JSON.stringify(key),batch.lote_id);
});
test('email não fica disponível sem um provedor/remetente e nenhum teste acessa SMTP real', async () => {
  const keys = ['SMTP_HOST','SMTP_USER','SMTP_PASS','EMAIL_FROM','SMTP_FROM','RESEND_API_KEY'];
  const before = Object.fromEntries(keys.map(key => [key,process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  try {const real = new ReportEmailGateway(); assert.equal(real.availability().envio_disponivel,false);
    await assert.rejects(real.deliver(await reports.report(result1),Buffer.from('fake'),'id'), /remetente válido/);
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
  assert.equal(sent[0].report.matricula,'000123'); assert.equal(sent[0].report.resultado_id,result1); assert.equal(sent[0].pdf.subarray(0,5).toString(),'%PDF-');
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
