import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { extname } from 'node:path';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import type { EssayImportLine, EssayImportPreview, EssayImportResult } from '@enem/shared/src/essay-import';
import { DatabaseService } from './database.service';
import { SimuladosService } from './simulados.service';

type SourceRow = {linha: number; values: unknown[]};
type StoredEvaluation = {
  id: number; matricula: string; feedback_id: number | null; nota_redacao: number | null;
  feedback_redacao: string | null; competencias_redacao: string | null; avaliador_redacao: string | null;
  situacao_redacao: string | null; origem_redacao: string | null; atualizado_em: string | null;
};
type ImportPlan = {linhas: EssayImportLine[]; fingerprint: string; ignorar_sem_resultado: boolean};
const MAX_ROWS = 1000, MAX_COLUMNS = 40, MAX_BYTES = 2 * 1024 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[_\-\s]+/g, ' ');

export function essayHeader(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = normalize(value);
  const competency = normalized.match(/^(?:competencia|criterio|c)\s*([1-5])(?:\b|:)/);
  if (competency) return `c${competency[1]}`;
  const aliases: Record<string, string> = {
    'matricula': 'matricula', 'matricula do aluno': 'matricula', 'matricula do estudante': 'matricula',
    'nome': 'nome', 'nome do aluno': 'nome', 'nome completo': 'nome', 'nome completo do aluno': 'nome',
    'avaliador': 'avaliador', 'nome do avaliador': 'avaliador', 'professor': 'avaliador',
    'situacao': 'situacao', 'situacao do texto / anulacao': 'situacao', 'situacao do texto': 'situacao',
    'observacoes': 'feedback', 'feedback': 'feedback', 'feedback do professor': 'feedback',
    'observacoes gerais e feedback para o aluno': 'feedback',
    'nota total': 'total', 'nota geral': 'total', 'nota final': 'total', 'nota da redacao': 'total', 'nota redacao': 'total',
  };
  return aliases[normalized] || '';
}

function plainCell(value: unknown): unknown {
  if (value && typeof value === 'object' && 'richText' in value) {
    const richText = (value as {richText: Array<{text: string}>}).richText;
    return richText.map(item => item.text).join('');
  }
  return value;
}
function textCell(value: unknown, max: number, label: string, multiline = false): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${label} deve conter texto, sem fórmulas.`);
  const text = value.trim();
  if (text.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f]/ : /[\x00-\x1f]/).test(text)) throw new Error(`${label} inválido (até ${max.toLocaleString('pt-BR')} caracteres).`);
  return text;
}
function scoreCell(value: unknown, max: number, label: string): number {
  let score: number;
  if (typeof value === 'number') score = value;
  else if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+(?:[.,]\d{1,2})?)(?:\s*pontos?)?$/i);
    if (!match) throw new Error(`${label} deve ser um número de 0 a ${max}; não use fórmulas ou deixe em branco.`);
    score = Number(match[1].replace(',', '.'));
  } else throw new Error(`${label} deve ser um número de 0 a ${max}; não use fórmulas ou deixe em branco.`);
  if (!Number.isFinite(score) || score < 0 || score > max || Math.abs(score * 100 - Math.round(score * 100)) > 1e-7) throw new Error(`${label} deve estar entre 0 e ${max}, com até duas casas decimais.`);
  return score;
}
function storedCompetencies(value: string | null): number[] {
  if (!value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function isEqual(row: StoredEvaluation, entry: EssayImportLine): boolean {
  return row.feedback_id !== null && row.nota_redacao !== null && Number(row.nota_redacao) === entry.nota_redacao
    && (row.feedback_redacao || '') === entry.feedback_redacao
    && JSON.stringify(storedCompetencies(row.competencias_redacao)) === JSON.stringify(entry.competencias)
    && (row.avaliador_redacao || '') === entry.avaliador && (row.situacao_redacao || '') === entry.situacao;
}

@Injectable()
export class EssayImportService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(SimuladosService) private readonly simulados: SimuladosService) {}

  private async source(buffer: Buffer, filename: string): Promise<{rows: SourceRow[]; erros: string[]}> {
    if (!buffer.length || buffer.length > MAX_BYTES) throw new BadRequestException('Envie uma planilha válida de redações com até 2 MB.');
    const extension = extname(filename).toLowerCase();
    if (extension === '.csv') {
      const parsed = Papa.parse<unknown[]>(buffer.toString('utf8').replace(/^\uFEFF/, ''), {dynamicTyping: false, skipEmptyLines: false});
      if (parsed.data.length > MAX_ROWS + 1 || parsed.data.some(row => row.length > MAX_COLUMNS)) throw new BadRequestException('A planilha aceita até 1.000 redações e 40 colunas.');
      return {rows: parsed.data.map((values, index) => ({linha: index + 1, values})), erros: parsed.errors.map(error => `CSV inválido: ${error.message}`)};
    }
    if (extension !== '.xlsx') throw new BadRequestException('Use a planilha XLSX ou CSV exportada do formulário de avaliação de redações.');
    const book = new ExcelJS.Workbook();
    try { await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]); }
    catch { throw new BadRequestException('Não foi possível abrir a planilha XLSX. Exporte o formulário novamente.'); }
    const candidates = book.worksheets.filter(sheet => {
      const headers = Array.from({length: Math.min(sheet.columnCount, MAX_COLUMNS + 1)}, (_, i) => essayHeader(plainCell(sheet.getRow(1).getCell(i + 1).value)));
      return headers.includes('matricula') && ['c1','c2','c3','c4','c5'].every(column => headers.includes(column));
    });
    if (candidates.length > 1) throw new BadRequestException('Mais de uma aba contém avaliações de redação. Mantenha uma única aba com matrícula e as cinco competências.');
    if (!candidates.length) throw new BadRequestException('Nenhuma aba contém Matrícula do Aluno e Competência 1 a 5 na primeira linha. Exporte a aba de respostas do formulário.');
    const sheet = candidates[0];
    if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > MAX_COLUMNS) throw new BadRequestException('A planilha aceita até 1.000 redações e 40 colunas.');
    const rows: SourceRow[] = [];
    sheet.eachRow({includeEmpty: false}, row => rows.push({linha: row.number, values: Array.from({length: sheet.columnCount}, (_, i) => plainCell(row.getCell(i + 1).value))}));
    return {rows, erros: []};
  }

  private async evaluations(simuladoId: number): Promise<StoredEvaluation[]> {
    return this.db.all<StoredEvaluation>(`SELECT r.id,r.matricula,f.resultado_id feedback_id,f.nota_redacao,f.feedback_redacao,
      f.competencias_redacao,f.avaliador_redacao,f.situacao_redacao,f.origem_redacao,f.atualizado_em
      FROM core_resultadoaluno r JOIN core_lotecorrecao l ON l.id=r.lote_id LEFT JOIN report_feedback f ON f.resultado_id=r.id
      WHERE l.simulado_id=? ORDER BY r.id`, simuladoId);
  }

  private fingerprint(state: StoredEvaluation[], entries: EssayImportLine[]): string {
    const identifiers = new Set(entries.map(entry => entry.matricula));
    return digest(JSON.stringify(state.filter(row => identifiers.has(row.matricula)).map(row => ({...row, id: Number(row.id), feedback_id: row.feedback_id === null ? null : Number(row.feedback_id), nota_redacao: row.nota_redacao === null ? null : Number(row.nota_redacao)}))));
  }

  async preview(simuladoId: number, buffer: Buffer, filename: string, skipMissingResults = false): Promise<EssayImportPreview> {
    await this.simulados.get(simuladoId);
    const source = await this.source(buffer, filename), erros = [...source.erros], avisos: string[] = [];
    const headers = (source.rows[0]?.values || []).map(essayHeader), required = ['matricula','c1','c2','c3','c4','c5'];
    if (required.some(column => !headers.includes(column))) erros.push('As colunas obrigatórias são Matrícula do Aluno e Competência 1 a 5.');
    const recognized = headers.filter(Boolean);
    if (new Set(recognized).size !== recognized.length) erros.push('Há colunas reconhecidas repetidas. Mantenha apenas uma matrícula, uma nota por competência e uma nota total.');
    const linhas: EssayImportLine[] = [], seen = new Map<string, number>();
    const cell = (values: unknown[], column: string) => { const index = headers.indexOf(column); return index < 0 ? undefined : values[index]; };
    if (!erros.length) for (const row of source.rows.slice(1)) {
      if (row.values.every(value => value === null || value === undefined || value === '')) continue;
      try {
        const rawId = cell(row.values, 'matricula');
        let matricula: string;
        if (typeof rawId === 'number') {
          if (!Number.isSafeInteger(rawId) || rawId < 0) throw new Error('Matrícula numérica inválida. Use Texto no Excel para preservar todos os dígitos.');
          matricula = String(rawId);
          avisos.push(`Linha ${row.linha}: matrícula numérica convertida exatamente como está; zeros iniciais não foram acrescentados. Confira a associação.`);
        } else matricula = textCell(rawId, 100, 'Matrícula');
        if (!matricula) throw new Error('Informe a matrícula do aluno; ela não será inferida pelo nome.');
        if (seen.has(matricula)) throw new Error(`Matrícula repetida na linha ${seen.get(matricula)}. Mantenha uma única avaliação por aluno; nenhuma versão será escolhida automaticamente.`);
        seen.set(matricula, row.linha);
        const competencias = [1,2,3,4,5].map(index => scoreCell(cell(row.values, `c${index}`), 200, `Competência ${index}`));
        const calculated = Math.round(competencias.reduce((sum, value) => sum + value, 0) * 100) / 100;
        const explicitTotal = headers.includes('total') ? scoreCell(cell(row.values, 'total'), 1000, 'Nota total') : calculated;
        if (Math.abs(explicitTotal - calculated) > 1e-7) throw new Error('A nota total difere da soma das cinco competências. Corrija a avaliação antes de importar.');
        linhas.push({linha: row.linha, matricula, nome: textCell(cell(row.values,'nome'),150,'Nome do aluno'),
          avaliador: textCell(cell(row.values,'avaliador'),150,'Nome do avaliador'), situacao: textCell(cell(row.values,'situacao'),500,'Situação do texto'),
          competencias, nota_redacao: calculated, feedback_redacao: textCell(cell(row.values,'feedback'),10000,'Observações e feedback',true),
          resultado_ids: [], acao:'SEM_RESULTADO'});
      } catch (error) { erros.push(`Linha ${row.linha}: ${error instanceof Error ? error.message : 'Avaliação inválida.'}`); }
    }
    if (!source.rows.slice(1).some(row => row.values.some(value => value !== null && value !== undefined && value !== ''))) erros.push('Esta planilha contém apenas o cabeçalho. Exporte as respostas preenchidas do Google Forms para importar as avaliações.');
    if (!headers.includes('total') && linhas.length) avisos.push('A planilha não possui coluna de nota total. A nota da redação será a soma das cinco competências, de 0 a 1000.');
    if (headers.includes('situacao') && linhas.some(row => row.situacao)) avisos.push('A situação/anulação da redação será preservada como informada. Nenhuma nota objetiva nem nota de redação será alterada por interpretação desse texto.');
    const state = await this.evaluations(simuladoId);
    for (const entry of linhas) {
      const matching = state.filter(row => row.matricula === entry.matricula);
      entry.resultado_ids = matching.map(row => Number(row.id));
      entry.anteriores = matching.filter(row => row.feedback_id !== null).map(row => ({resultado_id:Number(row.id),nota_redacao:row.nota_redacao === null ? null : Number(row.nota_redacao),competencias:storedCompetencies(row.competencias_redacao),feedback_redacao:row.feedback_redacao || ''}));
      if (!matching.length) {
        const message = `Linha ${entry.linha}: matrícula sem prova no simulado selecionado.`;
        if (skipMissingResults) avisos.push(message + ' Esta avaliação será ignorada nesta importação.'); else erros.push(message + ' Envie a prova ou escolha explicitamente ignorar avaliações sem prova.');
      } else {
        entry.acao = matching.every(row => isEqual(row,entry)) ? 'SEM_ALTERACAO' : matching.some(row => row.feedback_id !== null && !isEqual(row,entry)) ? 'ATUALIZAR' : 'NOVA';
        if (matching.length > 1) avisos.push(`Linha ${entry.linha}: ${matching.length} correções da mesma matrícula receberão esta avaliação, somente neste simulado. Confira os números das correções.`);
      }
    }
    const count = (action: EssayImportLine['acao']) => linhas.filter(row => row.acao === action).length;
    if (!linhas.some(row => row.acao !== 'SEM_RESULTADO') && !erros.length) erros.push('Nenhuma matrícula da planilha possui prova neste simulado. Nenhuma avaliação pode ser importada.');
    const now = new Date(), expiry = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const token = erros.length ? '' : randomBytes(32).toString('base64url');
    if (token) await this.db.run('INSERT INTO essay_import_plans(token_hash,simulado_id,payload,expira_em,criado_em) VALUES(?,?,?,?,?)', digest(token), simuladoId,
      JSON.stringify({linhas, fingerprint:this.fingerprint(state,linhas), ignorar_sem_resultado:skipMissingResults} satisfies ImportPlan), expiry, now.toISOString());
    return {token,simulado_id:simuladoId,total:linhas.length,total_resultados:linhas.reduce((sum,row) => sum + row.resultado_ids.length,0),
      novas:count('NOVA'),atualizacoes:count('ATUALIZAR'),sem_alteracao:count('SEM_ALTERACAO'),sem_resultado:count('SEM_RESULTADO'),linhas,erros,avisos,expira_em:expiry};
  }

  async import(simuladoId: number, token: unknown, confirmation: unknown, updateExisting: unknown): Promise<EssayImportResult> {
    if (confirmation !== 'sim' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BadRequestException('Revise a prévia das redações e confirme a importação.');
    return this.db.transaction(async () => {
      await this.simulados.get(simuladoId);
      const saved = await this.db.get<{payload:string;expira_em:string}>('SELECT payload,expira_em FROM essay_import_plans WHERE token_hash=? AND simulado_id=?',digest(token),simuladoId);
      if (!saved || new Date(saved.expira_em).getTime() <= Date.now()) throw new BadRequestException('A prévia expirou ou já foi utilizada. Envie a planilha de redações novamente.');
      const plan = JSON.parse(saved.payload) as ImportPlan;
      const state = await this.evaluations(simuladoId);
      if (plan.fingerprint !== this.fingerprint(state,plan.linhas)) throw new BadRequestException('As provas ou avaliações mudaram após a prévia. Envie a planilha novamente para conferir as associações.');
      if (plan.linhas.some(row => row.acao === 'ATUALIZAR') && updateExisting !== 'sim') throw new BadRequestException('Há avaliações existentes que serão substituídas. Confirme também a atualização após revisar a prévia.');
      // Deleting the plan before writing makes concurrent confirmations single-use in both database dialects.
      const claim = await this.db.run('DELETE FROM essay_import_plans WHERE token_hash=? AND simulado_id=?',digest(token),simuladoId);
      if (claim.changes !== 1) throw new BadRequestException('A prévia já foi utilizada. Atualize os boletins antes de importar novamente.');
      const now = new Date().toISOString(); let changedRows = 0, changedResults = 0;
      for (const entry of plan.linhas) {
        if (entry.acao === 'SEM_RESULTADO' || entry.acao === 'SEM_ALTERACAO') continue;
        let changes = 0;
        for (const resultId of entry.resultado_ids) {
          const before = state.find(row => Number(row.id) === resultId)!;
          if (isEqual(before,entry)) continue;
          const params = [entry.nota_redacao,entry.feedback_redacao,JSON.stringify(entry.competencias),entry.avaliador,entry.situacao,'planilha',now];
          let result;
          if (before.feedback_id === null) result = await this.db.run(`INSERT INTO report_feedback(resultado_id,nota_redacao,feedback_redacao,competencias_redacao,avaliador_redacao,situacao_redacao,origem_redacao,atualizado_em)
            SELECT r.id,?,?,?,?,?,?,? FROM core_resultadoaluno r JOIN core_lotecorrecao l ON l.id=r.lote_id
            WHERE r.id=? AND r.matricula=? AND l.simulado_id=? ON CONFLICT(resultado_id) DO NOTHING`,...params,resultId,entry.matricula,simuladoId);
          else result = await this.db.run(`UPDATE report_feedback SET nota_redacao=?,feedback_redacao=?,competencias_redacao=?,avaliador_redacao=?,situacao_redacao=?,origem_redacao=?,atualizado_em=?
            WHERE resultado_id=? AND atualizado_em=? AND nota_redacao IS NOT DISTINCT FROM ?
            AND feedback_redacao=? AND competencias_redacao=? AND avaliador_redacao=? AND situacao_redacao=? AND origem_redacao=?
            AND EXISTS (SELECT 1 FROM core_resultadoaluno r JOIN core_lotecorrecao l ON l.id=r.lote_id WHERE r.id=report_feedback.resultado_id AND r.matricula=? AND l.simulado_id=?)`,
            ...params,resultId,before.atualizado_em!,before.nota_redacao,before.feedback_redacao || '',before.competencias_redacao || '[]',before.avaliador_redacao || '',before.situacao_redacao || '',before.origem_redacao ?? 'manual',entry.matricula,simuladoId);
          if (result.changes !== 1) throw new BadRequestException('Uma avaliação mudou durante a confirmação. Nenhuma alteração desta importação foi salva; gere uma nova prévia.');
          changes++;
        }
        if (changes) changedRows++;
        changedResults += changes;
      }
      const unchanged = plan.linhas.filter(row => row.acao === 'SEM_ALTERACAO').length;
      const ignored = plan.linhas.filter(row => row.acao === 'SEM_RESULTADO').length;
      return {message:`${changedRows} avaliação(ões) importada(s) em ${changedResults} correção(ões). ${unchanged} sem alteração e ${ignored} sem prova ignorada(s).`,total:changedRows,total_resultados:changedResults,sem_alteracao:unchanged,ignoradas:ignored};
    });
  }
}
