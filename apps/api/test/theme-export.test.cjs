const {test} = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {ExportService} = require('../dist/export.service.js');
const {grade, gradeThemes} = require('../dist/grading.js');
const key = Object.fromEntries(Array.from({length: 10}, (_, i) => [String(i + 1), 'A']));
function result(id, answers = key, status = 'SUCESSO') {
  return {id, lote_id: id, matricula: '000' + id, respostas_detectadas: answers, gabarito_do_envio: key,
    criado_em: '2026-10-08T18:00:00Z', status, mensagem_leitura: '', imagem_debug: null, ...grade(answers, key, status)};
}
async function exportData(temas, rows) {
  const data = {simulado: {total_questoes: 10, temas}, resultados: rows.map(row => ({...row, desempenho_temas: gradeThemes(row.respostas_detectadas, key, row.status, 10, temas)}))};
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await new ExportService().create(data)); return workbook;
}

test('nomes de abas de temas respeitam limites do Excel e não colidem após normalização', async () => {
  const names = ['Linguagens / Literatura: redação [1]', 'Linguagens / Literatura: redação [2]', 'NATUREZA', 'natureza'];
  const themes = names.map((tema, i) => ({inicio: i + 1, fim: i + 1, tema}));
  const book = await exportData(themes, [result(1)]);
  const tabs = book.worksheets.filter(sheet => sheet.name.startsWith('Tema - '));
  assert.equal(tabs.length, 5);
  assert.equal(new Set(tabs.map(sheet => sheet.name.toLowerCase())).size, tabs.length);
  for (const tab of tabs) { assert.ok(tab.name.length <= 31); assert.doesNotMatch(tab.name, /[\\/*?:\[\]]/); }
  assert.deepEqual(tabs.map(sheet => sheet.getCell('D2').value), [...names, 'Sem tema']);
});

test('cada aba preserva provas repetidas, nota local, brancos e marcações duplas', async () => {
  const themes = [{inicio: 1, fim: 5, tema: 'Linguagens'}, {inicio: 6, fim: 10, tema: 'Matemática'}];
  const rows = [result(1, {...key, '1': 'B', '2': 'BNK', '6': 'RAS'}), {...result(2), matricula: '0001'}];
  const book = await exportData(themes, rows);
  const language = book.getWorksheet('Tema - Linguagens');
  assert.equal(language.rowCount, 3); assert.equal(language.getCell('G2').value, .6);
  assert.equal(language.getCell('H2').value, 3); assert.equal(language.getCell('I2').value, 1); assert.equal(language.getCell('K2').value, 1);
  assert.equal(language.getCell('A2').value, language.getCell('A3').value);
  assert.equal(language.getCell('B2').value, 1); assert.equal(language.getCell('B3').value, 2);
  assert.equal(book.getWorksheet('Tema - Matemática').getCell('G2').value, .8);
  assert.equal(book.getWorksheet('Tema - Matemática').getCell('J2').value, 1);
});

test('erros de leitura não viram zero por cento e notas incertas ficam identificadas', async () => {
  const book = await exportData([{inicio: 1, fim: 10, tema: 'Tudo'}], [result(1, {}, 'ERRO_LEITURA'), result(2, {...key, '1': 'INC'}, 'ALERTA_REVISAO')]);
  const tab = book.getWorksheet('Tema - Tudo');
  assert.equal(tab.getCell('G2').value, 'ERRO_LEITURA'); assert.equal(tab.getCell('H2').value, null);
  assert.equal(tab.getCell('G3').value, '90% (provisória)'); assert.equal(tab.getCell('L3').value, 1);
  assert.deepEqual(tab.views.map(view => [view.state, view.xSplit, view.ySplit]), [['frozen', 1, 1]]);
  assert.ok(tab.autoFilter);
});

test('exportação vazia cria abas dos temas e simulado sem temas mantém só os resultados gerais', async () => {
  const book = await exportData([{inicio: 1, fim: 10, tema: 'Linguagens'}], []);
  assert.equal(book.getWorksheet('Tema - Linguagens').rowCount, 1); assert.ok(book.getWorksheet('Resultados_OMR'));
  const general = await exportData([], [result(1)]);
  assert.deepEqual(general.worksheets.map(sheet => sheet.name), ['Resultados_OMR']);
  assert.equal(general.worksheets[0].getCell('A2').value, '0001');
});
