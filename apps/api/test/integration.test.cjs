const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync, readdirSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {execFileSync} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const ExcelJS = require('exceljs');
const root = resolve(__dirname, '../../..');
const temp = mkdtempSync(join(tmpdir(), 'enem-nest-tests-'));
process.env.DATABASE_URL = '';
process.env.OMR_REMOTE_URL = '';
process.env.STORAGE_MODE = 'local';
process.env.AUTH_ENABLED = 'false';
delete process.env.VERCEL;
process.env.DATABASE_PATH = join(temp, 'test.sqlite3');
process.env.MEDIA_ROOT = join(temp, 'media');
mkdirSync(process.env.MEDIA_ROOT);
// Todos os cartões e PDFs são gerados independentemente do leitor, sem dados pessoais.
const python = resolve(root, process.env.PYTHON_EXECUTABLE || 'venv/bin/python');
execFileSync(python, ['-c', `from variable_cards import printed_card, degrade
from PIL import Image
import random, sys, json
from pathlib import Path
out=Path(sys.argv[1]); rng=random.Random(1729)
key={str(q):rng.choice('ABCDE') for q in range(1,51)}
image,_=printed_card(50,key)
Image.fromarray(degrade(image,'shadow')[:,:,::-1]).save(out/'photo50.jpeg',quality=90)
(out/'truth50.json').write_text(json.dumps(key))
pattern={str(q):'B' for q in range(1,51)}
printed_card(50,pattern,out/'pattern50.pdf')
student=dict(pattern);student.update({'2':'BNK','3':'RAS'})
printed_card(50,student,out/'student50.pdf')
printed_card(60,output=out/'sixty.png')
student60={str(q):'ABCDE'[(q-1)%5] for q in range(1,61)}
student60.update({'1':'B','2':'BNK','3':'RAS'})
printed_card(60,student60,out/'student60.pdf')
printed_card(60,dict.fromkeys(map(str,range(1,61)),'B'),out/'changed60.pdf')
Image.new('RGB',(1000,1400),'white').save(out/'unknown.png')
`, temp], {env: {...process.env, PYTHONPATH: [join(root, 'python'), join(root, 'python/tests')].join(':')}});
const photo = readFileSync(join(temp, 'photo50.jpeg'));
const pdf = readFileSync(join(temp, 'student50.pdf'));
const patternPdf = readFileSync(join(temp, 'pattern50.pdf'));
const key = JSON.parse(readFileSync(join(temp, 'truth50.json'), 'utf8'));
let app, base, simuladoId, firstBatch;
// Reproduz o esquema legado, com IDs e dados históricos já existentes.
const legacy = new DatabaseSync(process.env.DATABASE_PATH);
legacy.exec(`
CREATE TABLE core_simulado(id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT NOT NULL, data_criacao TEXT NOT NULL, gabarito_oficial TEXT NOT NULL);
CREATE TABLE core_lotecorrecao(id INTEGER PRIMARY KEY AUTOINCREMENT, criado_em TEXT NOT NULL, simulado_id INTEGER NOT NULL REFERENCES core_simulado(id));
CREATE TABLE core_resultadoaluno(id INTEGER PRIMARY KEY AUTOINCREMENT, matricula TEXT NOT NULL, respostas_detectadas TEXT NOT NULL, total_acertos INTEGER NOT NULL, total_erros INTEGER NOT NULL, total_rasuras INTEGER NOT NULL, total_brancos INTEGER NOT NULL, nota_percentual REAL NOT NULL, imagem_debug TEXT, status TEXT NOT NULL, lote_id INTEGER NOT NULL REFERENCES core_lotecorrecao(id), mensagem_leitura TEXT NOT NULL, total_incertas INTEGER NOT NULL);
`);
legacy.prepare('INSERT INTO core_simulado VALUES(?,?,?,?)').run(42, 'Simulado legado', '2026-10-08 17:00:00', JSON.stringify(key));
legacy.prepare('INSERT INTO core_lotecorrecao VALUES(?,?,?)').run(42, '2026-10-08 17:05:00', 42);
legacy.prepare('INSERT INTO core_resultadoaluno VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(42, 'LEGADO', JSON.stringify(key), 50, 0, 0, 0, 100, null, 'SUCESSO', 42, '', 0);
legacy.close();
const {createApplication} = require('../dist/bootstrap.js');
const {grade} = require('../dist/grading.js');
const variablePhotoPath = join(temp, 'sixty.png');
const variablePhoto = readFileSync(variablePhotoPath);
const variableKey = Object.fromEntries(Array.from({length: 60}, (_, i) => [String(i + 1), 'ABCDE'[i % 5]]));
const themeConfig = [{inicio: 1, fim: 22, tema: 'Linguagens'}, {inicio: 25, fim: 30, tema: 'Ciências da Natureza'}];
let variableSimuladoId, variableBatch;

async function request(path, options = {}) {
  const response = await fetch(base + path, {...options, headers: {'X-OMR-Client': 'web', ...options.headers}});
  const json = await response.json();
  return {status: response.status, json};
}
function official(title, buffer = photo, name = 'official.jpeg', field = 'gabarito_pdf') {
  const form = new FormData(); if (title) form.append('titulo', title);
  form.append(field, new Blob([buffer]), name); return form;
}
function proofs(names, buffer = photo) {
  const form = new FormData(); for (const name of names) form.append('pdf_files', new Blob([buffer]), name); return form;
}
before(async () => { app = await createApplication(false); await app.listen(0, '127.0.0.1'); base = `http://127.0.0.1:${app.getHttpServer().address().port}/api`; });
after(async () => { if (app) await app.close(); rmSync(temp, {recursive: true, force: true}); });

test('migra o esquema do SQLite sem perder IDs, notas ou respostas existentes', async () => {
  const {status, json} = await request('/simulados/42/resultados');
  assert.equal(status, 200); assert.equal(json.simulado.titulo, 'Simulado legado');
  assert.equal(json.resultados[0].id, 42); assert.equal(json.resultados[0].nota_percentual, 100);
  assert.deepEqual(json.resultados[0].respostas_detectadas, key);
  assert.deepEqual(json.resultados[0].gabarito_do_envio, key);
  assert.equal(json.simulado.total_questoes, 50); assert.deepEqual(json.simulado.temas, []);
});
test('processador Python funciona sem Django em execução', async () => {
  const {status, json} = await request('/health'); assert.equal(status, 200);
  assert.equal(json.backend, 'NestJS'); assert.equal(json.processor.ok, true);
});
test('cria um simulado real lendo as 50 alternativas de uma foto', async () => {
  const {status, json} = await request('/simulados', {method: 'POST', body: official('Teste de migração')});
  assert.equal(status, 201); assert.deepEqual(json.gabarito_oficial, key); simuladoId = json.id;
});
test('adiciona 3 provas e depois 2, mantendo as cinco e o histórico', async () => {
  let result = await request(`/simulados/${simuladoId}/provas`, {method: 'POST', body: proofs(['001.jpeg', '002.jpeg', '003.jpeg'])});
  assert.equal(result.status, 201); firstBatch = result.json.envio_id; assert.equal(result.json.total_provas, 3);
  result = await request(`/simulados/${simuladoId}/provas`, {method: 'POST', body: proofs(['004.JPEG', '005.jpeg'])});
  assert.equal(result.status, 201); assert.equal(result.json.total_provas, 5);
  const {json} = await request(`/simulados/${simuladoId}/resultados`);
  assert.equal(json.indicadores.total_provas, 5); assert.equal(json.indicadores.media_nota, 100); assert.equal(json.indicadores.total_envios, 2);
  assert.deepEqual(json.resultados.map(r => r.matricula), ['001', '002', '003', '004', '005']);
  assert.equal((await request(`/envios/${firstBatch}`)).json.resultados.length, 3);
});
test('gera espelhos e preserva as matrículas e chaves no detalhe', async () => {
  const {json} = await request(`/simulados/${simuladoId}/resultados`);
  const detail = await request(`/resultados/${json.resultados[0].id}`);
  assert.equal(detail.status, 200); assert.deepEqual(detail.json.resultado.gabarito_do_envio, key);
  const response = await fetch(base.replace('/api', '') + json.resultados[0].imagem_debug);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /image\/png/);
});
test('exporta as 5 provas e seus envios para Excel em Node.js', async () => {
  const response = await fetch(`${base}/simulados/${simuladoId}/exportar`); assert.equal(response.status, 200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.worksheets[0]; assert.equal(sheet.rowCount, 6); assert.equal(sheet.getCell('A2').value, '001');
  assert.equal(sheet.getCell('D2').value, key['1'] + ' (✓)');
});
test('aceita PDF e identifica branco e marcação dupla com a mesma solução OMR', async () => {
  const officialResult = await request('/simulados', {method: 'POST', body: official('PDF', patternPdf, 'official.pdf')});
  assert.equal(officialResult.status, 201);
  const result = await request(`/simulados/${officialResult.json.id}/provas`, {method: 'POST', body: proofs(['123.pdf'], pdf)});
  assert.equal(result.status, 201);
  const {json} = await request(`/simulados/${officialResult.json.id}/resultados`);
  assert.equal(json.resultados[0].total_acertos, 48); assert.equal(json.resultados[0].total_rasuras, 1); assert.equal(json.resultados[0].total_brancos, 1);
});
test('trocar gabarito não muda as notas e a chave dos envios anteriores', async () => {
  const result = await request(`/simulados/${simuladoId}/gabarito`, {method: 'PUT', body: official('', patternPdf, 'new.pdf', 'novo_gabarito_pdf')});
  assert.equal(result.status, 200); assert.notDeepEqual(result.json.gabarito_oficial, key);
  const {json} = await request(`/simulados/${simuladoId}/resultados`);
  assert.equal(json.resultados[0].nota_percentual, 100); assert.deepEqual(json.resultados[0].gabarito_do_envio, key);
});
test('reenvio da mesma matrícula acrescenta uma correção, sem sobrescrever', async () => {
  const result = await request(`/simulados/${simuladoId}/provas`, {method: 'POST', body: proofs(['001.jpeg'])}); assert.equal(result.status, 201);
  const {json} = await request(`/simulados/${simuladoId}/resultados`);
  assert.equal(json.resultados.filter(r => r.matricula === '001').length, 2); assert.equal(json.resultados.length, 6);
});
test('arquivo inválido não cria simulado e limpa os temporários', async () => {
  const result = await request('/simulados', {method: 'POST', body: official('Inválido', Buffer.from('nao e imagem'), 'fake.jpg')});
  assert.equal(result.status, 400); assert.match(result.json.message, /inválida/);
  assert.equal(readdirSync(join(process.env.MEDIA_ROOT, '.staging')).length, 0);
});
test('lote misto inválido não grava envio parcial', async () => {
  const before = (await request(`/simulados/${simuladoId}/resultados`)).json.indicadores.total_envios;
  const form = proofs(['valid.jpeg']); form.append('pdf_files', new Blob(['inválido']), 'bad.png');
  const result = await request(`/simulados/${simuladoId}/provas`, {method: 'POST', body: form}); assert.equal(result.status, 400);
  assert.equal((await request(`/simulados/${simuladoId}/resultados`)).json.indicadores.total_envios, before);
});
test('arquivo não reconhecido registra motivo, sem informar 50 brancos', async () => {
  const unknown = join(temp, 'unknown.png');
  const result = await request(`/simulados/${simuladoId}/provas`, {method: 'POST', body: proofs(['unknown.png'], readFileSync(unknown))}); assert.equal(result.status, 201);
  const {json} = await request(`/simulados/${simuladoId}/resultados`);
  const row = json.resultados.find(r => r.matricula === 'unknown'); assert.equal(row.status, 'ERRO_LEITURA'); assert.equal(row.total_brancos, 0); assert.equal(row.imagem_debug, null);
  assert.ok(row.mensagem_leitura.length > 10, 'falha de leitura precisa ter motivo legível');
});
test('não mistura provas de simulados diferentes', async () => {
  const legacy = (await request('/simulados/42/resultados')).json; assert.equal(legacy.resultados.length, 1);
  assert.equal(legacy.resultados[0].matricula, 'LEGADO');
});
test('exclusão exige confirmação e remove somente o simulado escolhido', async () => {
  let result = await request(`/simulados/${simuladoId}`, {method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: '{}'});
  assert.equal(result.status, 400);
  result = await request(`/simulados/${simuladoId}`, {method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({confirmar: 'sim'})});
  assert.equal(result.status, 200); assert.equal((await request(`/simulados/${simuladoId}`)).status, 404);
  assert.equal((await request(`/envios/${firstBatch}`)).status, 404); assert.equal((await request('/simulados/42')).status, 200);
});
test('protege mutações contra requisições de outros sites', async () => {
  const response = await fetch(base + '/simulados/42', {method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({confirmar: 'sim'})});
  assert.equal(response.status, 403);
  const result = await request('/simulados/42', {method: 'DELETE', headers: {'Origin': 'https://example.com', 'Content-Type': 'application/json'}, body: JSON.stringify({confirmar: 'sim'})}); assert.equal(result.status, 403);
  assert.equal((await request('/simulados/42')).status, 200);
});
test('correção em TypeScript diferencia erro, branco, dupla e leitura incerta', () => {
  const wrong = 'ABCDE'[('ABCDE'.indexOf(key['1']) + 1) % 5];
  const answers = {...key, '1': wrong, '2': 'BNK', '3': 'RAS', '4': 'INC'};
  assert.deepEqual(grade(answers, key, 'ALERTA_REVISAO'), {total_acertos: 46, total_erros: 1, total_rasuras: 1, total_brancos: 1, total_incertas: 1, nota_percentual: 92});
  assert.equal(grade({}, key, 'ERRO_LEITURA').total_brancos, 0);
});

test('cria simulado de 60 questões com intervalos, inclusive espaços sem tema', async () => {
  const form = official('Simulado 60', variablePhoto, 'official.png');
  form.append('total_questoes', '60'); form.append('temas', JSON.stringify(themeConfig));
  const {status, json} = await request('/simulados', {method: 'POST', body: form});
  assert.equal(status, 201, JSON.stringify(json)); variableSimuladoId = json.id;
  assert.equal(json.total_questoes, 60); assert.deepEqual(json.gabarito_oficial, variableKey); assert.deepEqual(json.temas, themeConfig);
});
test('corrige todas as 60 questões e calcula acertos por tema com a chave do envio', async () => {
  const path = join(temp, 'student60.pdf');
  const result = await request(`/simulados/${variableSimuladoId}/provas`, {method: 'POST', body: proofs(['060.pdf'], readFileSync(path))});
  assert.equal(result.status, 201); variableBatch = result.json.envio_id;
  const {json} = await request(`/simulados/${variableSimuladoId}/resultados`);
  const r = json.resultados[0]; assert.equal(r.total_acertos, 57); assert.equal(r.nota_percentual, 95);
  assert.equal(r.total_brancos, 1); assert.equal(r.total_erros, 1); assert.equal(r.total_rasuras, 1);
  assert.equal(r.respostas_detectadas['60'], 'E'); assert.equal(Object.keys(r.respostas_detectadas).length, 60);
  assert.deepEqual(r.desempenho_temas.map(t => [t.tema, t.total_questoes, t.total_acertos]), [['Linguagens', 22, 19], ['Sem tema', 32, 32], ['Ciências da Natureza', 6, 6]]);
  assert.equal(r.desempenho_temas[0].nota_percentual, 86.36);
});
test('Excel inclui Q60, mapeamento das 60 questões e desempenho por tema', async () => {
  const response = await fetch(`${base}/envios/${variableBatch}/exportar`);
  assert.equal(response.status, 200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.worksheets[0]; assert.equal(sheet.getRow(1).getCell(63).value, 'Q60'); assert.equal(sheet.getRow(2).getCell(63).value, 'E (✓)');
  const mapping = workbook.getWorksheet('Temas_por_questao'); assert.equal(mapping.rowCount, 61);
  assert.equal(mapping.getCell('B23').value, 'Linguagens'); assert.equal(mapping.getCell('B24').value, 'Sem tema'); assert.equal(mapping.getCell('B26').value, 'Ciências da Natureza');
  const themes = workbook.getWorksheet('Desempenho_por_tema'); assert.equal(themes.rowCount, 4); assert.equal(themes.getCell('E2').value, 19);
  const language = workbook.getWorksheet('Tema - Linguagens'); assert.equal(language.rowCount, 2);
  assert.equal(language.getCell('A2').value, '060'); assert.equal(language.getCell('E2').value, '1–22');
  assert.equal(language.getCell('F2').value, 22); assert.equal(language.getCell('H2').value, 19);
  assert.equal(language.getCell('G2').value, 0.8636); assert.equal(language.getCell('G2').numFmt, '0.00%');
  const nature = workbook.getWorksheet('Tema - Ciências da Natureza');
  assert.equal(nature.getCell('H2').value, 6); assert.equal(nature.getCell('G2').value, 1);
  const unassigned = workbook.getWorksheet('Tema - Sem tema');
  assert.equal(unassigned.getCell('F2').value, 32); assert.equal(unassigned.getCell('E2').value, '23–24, 31–60');
});
test('edição de temas agrupa faixas do mesmo tema sem alterar notas, histórico ou chave', async () => {
  const themes = [...themeConfig, {inicio: 41, fim: 45, tema: 'Linguagens'}];
  const result = await request(`/simulados/${variableSimuladoId}/temas`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({temas: themes})});
  assert.equal(result.status, 200);
  const {json} = await request(`/envios/${variableBatch}`); const r = json.resultados[0];
  assert.equal(r.nota_percentual, 95); assert.deepEqual(r.gabarito_do_envio, variableKey);
  assert.equal(r.desempenho_temas.find(t => t.tema === 'Linguagens').total_questoes, 27);
  assert.equal(r.desempenho_temas.find(t => t.tema === 'Linguagens').total_acertos, 24);
});
test('bloqueia limites inválidos, temas vazios e intervalos sobrepostos sem gravação parcial', async () => {
  const before = (await request(`/simulados/${variableSimuladoId}`)).json.simulado.temas;
  const invalid = [null, 'json incorreto', [{inicio: 0, fim: 5, tema: 'X'}], [{inicio: 5, fim: 4, tema: 'X'}], [{inicio: 1.5, fim: 10, tema: 'X'}], [{inicio: 1, fim: 61, tema: 'X'}], [{inicio: 1, fim: 5, tema: ' '}], [{inicio: 1, fim: 22, tema: 'X'}, {inicio: 22, fim: 30, tema: 'Y'}]];
  for (const temas of invalid) {
    const result = await request(`/simulados/${variableSimuladoId}/temas`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({temas})});
    assert.equal(result.status, 400, JSON.stringify(temas));
  }
  assert.deepEqual((await request(`/simulados/${variableSimuladoId}`)).json.simulado.temas, before);
});
test('quantidade inválida e folha com quantidade diferente são rejeitadas e limpam temporários', async () => {
  for (const count of ['0', '1', '5', '49', '61', '120', '301', '60.5', 'abc', '50']) {
    const form = official('Quantidade inválida', variablePhoto, 'official.png'); form.append('total_questoes', count);
    const result = await request('/simulados', {method: 'POST', body: form}); assert.equal(result.status, 400, JSON.stringify(result.json));
  }
  const form = official('Tema inválido'); form.append('temas', 'não é JSON');
  assert.equal((await request('/simulados', {method: 'POST', body: form})).status, 400);
  assert.equal(readdirSync(join(process.env.MEDIA_ROOT, '.staging')).length, 0);
});
test('troca de chave em simulado de 60 mantém a classificação histórica por tema', async () => {
  const changedPath = join(temp, 'changed60.pdf');
  const result = await request(`/simulados/${variableSimuladoId}/gabarito`, {method: 'PUT', body: official('', readFileSync(changedPath), 'changed.pdf', 'novo_gabarito_pdf')});
  assert.equal(result.status, 200); assert.equal(result.json.total_questoes, 60);
  const {json} = await request(`/envios/${variableBatch}`);
  assert.deepEqual(json.resultados[0].gabarito_do_envio, variableKey); assert.equal(json.resultados[0].nota_percentual, 95);
  assert.equal(json.resultados[0].desempenho_temas.find(t => t.tema === 'Linguagens').total_acertos, 24);
});
test('arredonda notas pelo total configurado e mantém falhas fora da contagem de temas', () => {
  assert.equal(grade({...variableKey, '60': 'BNK'}, variableKey, 'SUCESSO').nota_percentual, 98.33);
  const {gradeThemes} = require('../dist/grading.js');
  assert.equal(gradeThemes({}, variableKey, 'ERRO_LEITURA', 60, themeConfig).reduce((sum, t) => sum + t.total_brancos, 0), 0);
});
test('abas de tema exportam o desempenho histórico após a troca de chave oficial', async () => {
  const response = await fetch(`${base}/simulados/${variableSimuladoId}/exportar`);
  assert.equal(response.status, 200);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const language = workbook.getWorksheet('Tema - Linguagens');
  assert.equal(language.rowCount, 2); assert.equal(language.getCell('E2').value, '1–22, 41–45');
  assert.equal(language.getCell('F2').value, 27); assert.equal(language.getCell('H2').value, 24);
  assert.equal(language.getCell('G2').value, 0.8889);
  const general = workbook.getWorksheet('Resultados_OMR');
  assert.equal(general.getCell('D2').value, 'B (✗)'); assert.equal(general.getCell('BS2').value, '95%');
});

test('preview do professor identifica branco e dupla sem forçar as respostas da chave', async () => {
  const form = official('', pdf, 'teacher-with-ambiguity.pdf'); form.append('total_questoes', '50');
  const result = await request('/leituras/gabarito', {method: 'POST', body: form});
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.equal(result.json.respostas_detectadas['2'], 'BNK');
  assert.equal(result.json.respostas_detectadas['3'], 'RAS');
  assert.equal(Object.keys(result.json.respostas_detectadas).length, 50);
  assert.equal(result.json.debug_image_path, null);
  assert.equal(readdirSync(join(process.env.MEDIA_ROOT, '.staging')).length, 0);
});

test('chave manual revisada é comparada com outra prova e matrícula explícita supera o nome do arquivo', async () => {
  const manual = Object.fromEntries(Array.from({length: 50}, (_, index) => [String(index + 1), 'B']));
  const created = await request('/simulados', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({titulo: 'Professor revisou a chave', total_questoes: 50, gabarito_manual: manual, temas: [{inicio: 1, fim: 50, tema: 'Área de teste'}]})});
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.gabarito_oficial, manual);
  const form = proofs(['fotografia-sem-matricula.jpeg']); form.append('matriculas', JSON.stringify(['00000741']));
  const uploaded = await request(`/simulados/${created.json.id}/provas`, {method: 'POST', body: form});
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
  const results = (await request(`/simulados/${created.json.id}/resultados`)).json.resultados;
  const matched = Object.values(key).filter(answer => answer === 'B').length;
  assert.equal(results[0].matricula, '00000741');
  assert.deepEqual(results[0].respostas_detectadas, key);
  assert.equal(results[0].total_acertos, matched);
  assert.equal(results[0].total_erros, 50 - matched);
  assert.equal(results[0].nota_percentual, matched * 2);
  assert.equal(results[0].desempenho_temas[0].total_acertos, matched);
  assert.notEqual(results[0].nota_percentual, 100);
});

test('gabarito manual incompleto/ambíguo e matrículas em quantidade errada não criam registros parciais', async () => {
  const before = (await request('/simulados')).json.total_simulados;
  for (const manual of [{}, {...key, '1': 'RAS'}, {...key, '2': 'INC'}, Array(50).fill('A'), {...key, '51': 'A'}]) {
    const result = await request('/simulados', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({titulo: 'Inválido manual', total_questoes: 50, gabarito_manual: manual})});
    assert.equal(result.status, 400, JSON.stringify(result.json));
  }
  assert.equal((await request('/simulados')).json.total_simulados, before);
  const form = proofs(['student.jpeg']); form.append('matriculas', '[]');
  const result = await request('/simulados/42/provas', {method: 'POST', body: form});
  assert.equal(result.status, 400);
  assert.equal((await request('/simulados/42/resultados')).json.resultados.length, 1);
});
