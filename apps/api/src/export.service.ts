import { Injectable, Inject, Optional } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { ResultsData } from '@enem/shared';
import { DatabaseService } from './database.service';

function styleTable(sheet: ExcelJS.Worksheet) {
  sheet.getRow(1).font = {bold: true, color: {argb: 'FFFFFFFF'}};
  sheet.getRow(1).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF2563EB'}};
  sheet.views = [{state: 'frozen', ySplit: 1, xSplit: 1}];
  sheet.autoFilter = {from: {row: 1, column: 1}, to: {row: Math.max(1, sheet.rowCount), column: sheet.columnCount}};
}

function themeSheetName(workbook: ExcelJS.Workbook, theme: string): string {
  // Excel limita os nomes a 31 caracteres e não diferencia maiúsculas.
  const base = ('Tema - ' + theme).replace(/[\\/*?:\[\]\x00-\x1F]/g, '-').replace(/\s+/g, ' ').trim().replace(/'+$/, '') || 'Tema';
  const used = new Set(workbook.worksheets.map(sheet => sheet.name.toLocaleLowerCase()));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? '' : ` (${i})`;
    const candidate = base.slice(0, 31 - suffix.length).replace(/'+$/, '') + suffix;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

function questionIntervals(questions: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const start = questions[i];
    while (i + 1 < questions.length && questions[i + 1] === questions[i] + 1) i++;
    ranges.push(start === questions[i] ? String(start) : `${start}–${questions[i]}`);
  }
  return ranges.join(', ');
}

@Injectable()
export class ExportService {
  constructor(@Optional() @Inject(DatabaseService) private readonly db?: DatabaseService) {}
  async create(data: ResultsData): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'OMR Enem Reader';
    const sheet = workbook.addWorksheet('Resultados_OMR');
    const columns = ['Matrícula', 'Envio', 'Data_Envio', ...Array.from({length: data.simulado.total_questoes}, (_, i) => `Q${i + 1}`),
      'Total_Acertos', 'Total_Erros', 'Total_Anuladas', 'Total_Em_Branco', 'Total_Incertas', 'Status', 'Detalhes_Leitura', 'Pontuacao_Percentual', 'Arquivo_Origem', 'Pagina_Origem', 'Fonte_Matricula'];
    sheet.columns = columns.map(header => ({header, key: header, width: header === 'Detalhes_Leitura' ? 50 : Math.max(12, header.length + 3)}));
    sheet.getRow(1).font = {bold: true, color: {argb: 'FFFFFFFF'}};
    sheet.getRow(1).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF2563EB'}};
    sheet.views = [{state: 'frozen', ySplit: 1, xSplit: 1}];
    for (const r of data.resultados) {
      const row: Record<string, string | number> = {
        'Matrícula': r.matricula, 'Envio': r.lote_id,
        'Data_Envio': new Date(r.criado_em).toLocaleString('pt-BR', {timeZone: 'America/Fortaleza'}),
        'Total_Acertos': r.total_acertos, 'Total_Erros': r.total_erros, 'Total_Anuladas': r.total_rasuras,
        'Total_Em_Branco': r.total_brancos, 'Total_Incertas': r.total_incertas, 'Status': r.status,
        'Detalhes_Leitura': r.mensagem_leitura,
        'Arquivo_Origem': r.arquivo_origem || '', 'Pagina_Origem': r.pagina_origem || '', 'Fonte_Matricula': r.matricula_fonte || '',
        'Pontuacao_Percentual': r.status === 'ERRO_LEITURA' ? 'ERRO_LEITURA' : `${r.nota_percentual}%${r.total_incertas ? ' (provisória)' : ''}`,
      };
      for (let q = 1; q <= data.simulado.total_questoes; q++) {
        const answer = r.respostas_detectadas[String(q)] || 'BNK';
        row[`Q${q}`] = r.status === 'ERRO_LEITURA' ? 'ERRO_LEITURA'
          : answer === 'INC' ? 'INC (revisar)' : ['BNK', 'RAS'].includes(answer) ? answer
          : `${answer} (${answer === r.gabarito_do_envio[String(q)] ? '✓' : '✗'})`;
      }
      sheet.addRow(row);
    }
    sheet.autoFilter = {from: {row: 1, column: 1}, to: {row: Math.max(sheet.rowCount, 1), column: columns.length}};
    if (data.simulado.temas.length) {
      const mapping = workbook.addWorksheet('Temas_por_questao');
      mapping.columns = [{header: 'Questão', key: 'questao', width: 12}, {header: 'Tema', key: 'tema', width: 40}];
      for (let q = 1; q <= data.simulado.total_questoes; q++) {
        mapping.addRow({questao: q, tema: data.simulado.temas.find(range => range.inicio <= q && range.fim >= q)?.tema || 'Sem tema'});
      }
      const themes = workbook.addWorksheet('Desempenho_por_tema');
      themes.columns = ['Matrícula', 'Envio', 'Tema', 'Questões', 'Acertos', 'Erros', 'Duplas', 'Brancos', 'Incertas', 'Percentual', 'Status'].map(header => ({header, width: header === 'Tema' ? 40 : 20}));
      for (const result of data.resultados) {
        for (const score of result.desempenho_temas) themes.addRow([result.matricula, result.lote_id, score.tema, score.total_questoes,
          score.total_acertos, score.total_erros, score.total_rasuras, score.total_brancos, score.total_incertas,
          result.status === 'ERRO_LEITURA' ? 'ERRO_LEITURA' : `${score.nota_percentual}%${result.total_incertas ? ' (provisório)' : ''}`, result.status]);
      }
      for (const tab of [mapping, themes]) styleTable(tab);
      const questionsByTheme = new Map<string, number[]>();
      for (let q = 1; q <= data.simulado.total_questoes; q++) {
        const name = data.simulado.temas.find(range => range.inicio <= q && range.fim >= q)?.tema || 'Sem tema';
        const questions = questionsByTheme.get(name) || [];
        questions.push(q); questionsByTheme.set(name, questions);
      }
      for (const [theme, questions] of questionsByTheme) {
        const tab = workbook.addWorksheet(themeSheetName(workbook, theme));
        tab.columns = ['Matrícula', 'Envio', 'Data_Envio', 'Tema', 'Questoes_do_Tema', 'Quantidade_Questoes', 'Nota_Tema', 'Acertos', 'Erros', 'Duplas', 'Brancos', 'Incertas', 'Status', 'Detalhes_Leitura']
          .map(header => ({header, key: header, width: ['Tema', 'Questoes_do_Tema', 'Detalhes_Leitura'].includes(header) ? 40 : Math.max(16, header.length + 2)}));
        for (const result of data.resultados) {
          const score = result.desempenho_temas.find(score => score.tema === theme);
          const readable = !!score && result.status !== 'ERRO_LEITURA';
          const row = tab.addRow({
            'Matrícula': result.matricula, 'Envio': result.lote_id,
            'Data_Envio': new Date(result.criado_em).toLocaleString('pt-BR', {timeZone: 'America/Fortaleza'}),
            'Tema': theme, 'Questoes_do_Tema': questionIntervals(questions), 'Quantidade_Questoes': questions.length,
            'Nota_Tema': readable ? result.total_incertas ? `${score.nota_percentual}% (provisória)` : score.nota_percentual / 100
              : result.status === 'ERRO_LEITURA' ? 'ERRO_LEITURA' : 'INDISPONÍVEL',
            'Acertos': readable ? score.total_acertos : null, 'Erros': readable ? score.total_erros : null,
            'Duplas': readable ? score.total_rasuras : null, 'Brancos': readable ? score.total_brancos : null,
            'Incertas': readable ? score.total_incertas : null, 'Status': result.status, 'Detalhes_Leitura': result.mensagem_leitura,
          });
          row.getCell('Nota_Tema').numFmt = '0.00%';
        }
        styleTable(tab);
      }
    }
    if (this.db && data.resultados.length) {
      const ids=data.resultados.map(result=>result.id);
      const feedback=await this.db.all<{resultado_id:number;nota_redacao:number|null;feedback_redacao:string;competencias_redacao:string;avaliador_redacao:string;situacao_redacao:string;origem_redacao:string}>(`SELECT * FROM report_feedback WHERE resultado_id IN (${ids.map(()=>'?').join(',')})`,...ids);
      const byResult=new Map(feedback.map(row=>[row.resultado_id,row]));
      const essays=workbook.addWorksheet('Redacoes');
      essays.columns=['Matrícula','Envio','Resultado','Competência 1','Competência 2','Competência 3','Competência 4','Competência 5','Nota Redação','Avaliador','Situação do Texto','Observações e Feedback','Origem'].map(header=>({header,width:header==='Observações e Feedback'?70:header==='Avaliador'?35:24}));
      for(const result of data.resultados) {
        const row=byResult.get(result.id),criteria=row?JSON.parse(row.competencias_redacao) as number[]:[];
        essays.addRow([result.matricula,result.lote_id,result.id,...Array.from({length:5},(_,i)=>criteria[i]??null),row?.nota_redacao??null,row?.avaliador_redacao||'',row?.situacao_redacao||'',row?.feedback_redacao||'',row?.origem_redacao||'Ainda não avaliada']);
      }
      styleTable(essays);
      essays.getColumn(12).alignment={wrapText:true,vertical:'top'};
    }
    for (const tab of workbook.worksheets) {
      tab.getRow(1).eachCell((cell, column) => {
        if (cell.value === 'Matrícula') {
          tab.getColumn(column).numFmt = '@';
          tab.getColumn(column).width = Math.max(tab.getColumn(column).width || 0, 18);
        }
        if (cell.value === 'Data_Envio') tab.getColumn(column).width = 24;
      });
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
}
