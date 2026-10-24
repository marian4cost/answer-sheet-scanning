import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join, extname } from 'node:path';
import { rename, rm, readFile } from 'node:fs/promises';
import type { AnswerKey, AnswerReviewEvent, ReadingStatus, DashboardData, Simulado, SimuladoDetail, Envio, Resultado, ResultsData, UploadResult, OMRReading } from '@enem/shared';
import { DatabaseService } from './database.service';
import { OmrService } from './omr.service';
import { MEDIA_ROOT } from './config';
import { StorageService } from './storage.service';
import { grade, gradeThemes, indicators, invalidQuestions } from './grading';
import { questionCount, themeRanges } from './question-config';
import { accountId, currentAccount, dataExpiry, retentionDays, withAccount } from './account-context';

type SimuladoRow = Omit<Simulado, 'gabarito_oficial' | 'gabarito_valido' | 'temas' | 'acesso' | 'pode_editar' | 'compartilhado_por'> & {
  gabarito_oficial: string; temas: string; owner_id: string; proprietario_nome?: string | null; proprietario_email?: string | null;
};
type ResultRow = Omit<Resultado, 'respostas_detectadas' | 'gabarito_do_envio' | 'desempenho_temas'> & {respostas_detectadas: string; gabarito_snapshot: string};
type ReviewRow = Omit<AnswerReviewEvent, 'respostas_antes' | 'respostas_depois' | 'alteracoes' | 'questoes_revisadas'> & {
  resultado_id: number; respostas_antes: string; respostas_depois: string; alteracoes: string; questoes_revisadas: string;
};
type ReviewedResultRow = ResultRow & {revisao_versao?: number | null; revisao_respostas?: string | null; revisao_status?: ReadingStatus | null; revisao_questoes?: string | null};
const SIMULADO_SQL = `SELECT s.*, (SELECT CAST(COUNT(*) AS INTEGER) FROM core_lotecorrecao l JOIN core_resultadoaluno r ON r.lote_id=l.id WHERE l.simulado_id=s.id) total_provas,
  (SELECT CAST(COUNT(*) AS INTEGER) FROM core_lotecorrecao l WHERE l.simulado_id=s.id) total_envios FROM core_simulado s`;
const READABLE_SIMULADO_SQL = SIMULADO_SQL.replace('SELECT s.*,', 'SELECT s.*, c.proprietario_nome,c.proprietario_email,') +
  ' LEFT JOIN simulado_shares c ON c.simulado_id=s.id AND c.owner_id=s.owner_id AND c.destinatario_id=?';
const ENVIO_SQL = `SELECT l.id, l.simulado_id, l.criado_em, s.titulo, CAST(COUNT(r.id) AS INTEGER) total_provas
  FROM core_lotecorrecao l JOIN core_simulado s ON s.id=l.simulado_id LEFT JOIN core_resultadoaluno r ON r.lote_id=l.id`;
const RESULT_SQL = `SELECT r.*, l.criado_em, l.gabarito_snapshot, v.versao AS revisao_versao,
  v.respostas_depois AS revisao_respostas, v.status_depois AS revisao_status, v.questoes_revisadas AS revisao_questoes
  FROM core_resultadoaluno r JOIN core_lotecorrecao l ON l.id=r.lote_id
  LEFT JOIN answer_review_events v ON v.resultado_id=r.id AND v.versao=(SELECT MAX(e.versao) FROM answer_review_events e WHERE e.resultado_id=r.id)`;
function dateISO(value: string) {
  return new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z').toISOString();
}
function simuladoDTO(row: SimuladoRow): Simulado {
  const key = JSON.parse(row.gabarito_oficial) as AnswerKey;
  const {owner_id, proprietario_nome, proprietario_email, ...publicRow} = row;
  const editable = owner_id === accountId();
  return {...publicRow, temas: JSON.parse(row.temas), data_criacao: dateISO(row.data_criacao), gabarito_oficial: key,
    gabarito_valido: Object.keys(key).length === row.total_questoes && invalidQuestions(key, row.total_questoes).length === 0,
    acesso: editable ? 'proprietario' : 'compartilhado', pode_editar: editable,
    ...(!editable ? {compartilhado_por:{nome:proprietario_nome || '',email:proprietario_email || ''}} : {})};
}
function envioDTO(row: Envio): Envio { return {...row, criado_em: dateISO(row.criado_em)}; }
function reviewDTO(row: ReviewRow): AnswerReviewEvent {
  const {resultado_id: _id, ...rest} = row;
  return {...rest, criado_em: dateISO(row.criado_em), respostas_antes: JSON.parse(row.respostas_antes),
    respostas_depois: JSON.parse(row.respostas_depois), alteracoes: JSON.parse(row.alteracoes), questoes_revisadas: JSON.parse(row.questoes_revisadas)};
}
function resultDTO(row: ReviewedResultRow, simulado: Simulado): Resultado {
  const {gabarito_snapshot, revisao_versao, revisao_respostas, revisao_status, revisao_questoes,
    arquivo_origem, pagina_origem, matricula_fonte, ...rest} = row;
  const original: AnswerKey = JSON.parse(row.respostas_detectadas), key: AnswerKey = JSON.parse(gabarito_snapshot);
  const answers: AnswerKey = revisao_respostas ? JSON.parse(revisao_respostas) : original;
  const status = revisao_status || row.status;
  const reviewed: number[] = revisao_questoes ? JSON.parse(revisao_questoes) : [];
  const message = !revisao_versao ? row.mensagem_leitura : status === 'ERRO_LEITURA'
    ? `Revisão manual parcial: ${reviewed.length}/${simulado.total_questoes} questões conferidas. Confira todas para concluir a prova com falha de leitura.`
    : status === 'ALERTA_REVISAO' ? 'Há respostas incertas ainda não conferidas. A nota permanece provisória.'
    : `Leitura conferida pelo professor (revisão ${revisao_versao}). A imagem mostra a leitura original.`;
  return {...rest, ...(revisao_versao ? grade(answers, key, status, simulado.total_questoes) : {}), status, mensagem_leitura: message,
    ...(simulado.pode_editar ? {arquivo_origem, pagina_origem, matricula_fonte} : {}),
    respostas_detectadas: answers, respostas_originais: original, status_original: row.status,
    mensagem_leitura_original: row.mensagem_leitura, revisao_versao: revisao_versao || 0, questoes_revisadas: reviewed,
    gabarito_do_envio: key, criado_em: dateISO(row.criado_em),
    desempenho_temas: gradeThemes(answers, key, status, simulado.total_questoes, simulado.temas),
    imagem_debug: row.imagem_debug ? `/api/resultados/${row.id}/imagem` : null};
}

@Injectable()
export class SimuladosService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(OmrService) private readonly omr: OmrService, @Inject(StorageService) private readonly storage: StorageService) {}
  async dashboard(): Promise<DashboardData> {
    const simulados = (await this.db.all<SimuladoRow>(READABLE_SIMULADO_SQL + ' WHERE (s.owner_id=? OR c.id IS NOT NULL) AND (s.expira_em IS NULL OR s.expira_em>?) ORDER BY s.data_criacao DESC, s.id DESC', accountId(), accountId(), new Date().toISOString())).map(simuladoDTO);
    const envios = (await this.db.all<Envio>(ENVIO_SQL + ' WHERE s.owner_id=? AND (s.expira_em IS NULL OR s.expira_em>?) GROUP BY l.id, l.simulado_id, l.criado_em, s.titulo ORDER BY l.criado_em DESC, l.id DESC LIMIT 10', accountId(), new Date().toISOString())).map(envioDTO);
    return {simulados, envios_recentes: envios, total_simulados: simulados.length, total_provas: simulados.reduce((sum, s) => sum + s.total_provas, 0), retencao_dias: retentionDays()};
  }
  async get(id: number): Promise<Simulado> {
    const row = await this.db.get<SimuladoRow>(SIMULADO_SQL + ' WHERE s.id=? AND s.owner_id=? AND (s.expira_em IS NULL OR s.expira_em>?)', id, accountId(), new Date().toISOString());
    if (!row) throw new NotFoundException('Simulado não encontrado.');
    return simuladoDTO(row);
  }
  /** Consulta acadêmica somente leitura. Todas as mutações continuam usando get, exclusivo do dono. */
  async getReadable(id: number): Promise<Simulado> {
    const row = await this.db.get<SimuladoRow>(READABLE_SIMULADO_SQL + ' WHERE s.id=? AND (s.owner_id=? OR c.id IS NOT NULL) AND (s.expira_em IS NULL OR s.expira_em>?)', accountId(), id, accountId(), new Date().toISOString());
    if (!row) throw new NotFoundException('Simulado não encontrado.');
    return simuladoDTO(row);
  }
  async detail(id: number): Promise<SimuladoDetail> {
    return {simulado: await this.getReadable(id), envios: (await this.db.all<Envio>(ENVIO_SQL + ' WHERE l.simulado_id=? GROUP BY l.id, l.simulado_id, l.criado_em, s.titulo ORDER BY l.criado_em DESC, l.id DESC', id)).map(envioDTO)};
  }
  private async cleanup(files: Express.Multer.File[]) {
    await Promise.all(files.map(file => rm(file.path, {force: true})));
  }
  private assertKey(key: AnswerKey, count: number) {
    if (Object.keys(key).length !== count) throw new BadRequestException(`O gabarito deve conter exatamente ${count} questões.`);
    const invalid = invalidQuestions(key, count);
    if (invalid.length) throw new BadRequestException('O gabarito oficial precisa de uma alternativa clara por questão. Confira e reenvie as questões: ' + invalid.join(', ') + '.');
  }
  private manualKey(value: unknown, count: number): AnswerKey {
    let key: unknown = value;
    if (typeof key === 'string') {
      try { key = JSON.parse(key); } catch { throw new BadRequestException('O gabarito manual deve ser um objeto JSON válido.'); }
    }
    if (!key || typeof key !== 'object' || Array.isArray(key)) throw new BadRequestException('Informe as alternativas do gabarito manual.');
    this.assertKey(key as AnswerKey, count);
    return key as AnswerKey;
  }
  private matriculas(value: unknown, files: Express.Multer.File[]): string[] | null {
    if (value === undefined || value === '') return null;
    let entries: unknown = value;
    if (typeof entries === 'string') {
      try { entries = JSON.parse(entries); } catch { throw new BadRequestException('A lista de matrículas é inválida.'); }
    }
    if (!Array.isArray(entries) || entries.length !== files.length || entries.some(entry => typeof entry !== 'string' || !entry.trim() || entry.trim().length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(entry))) {
      throw new BadRequestException('Informe uma matrícula de até 100 caracteres, sem caracteres de controle, para cada prova, na ordem dos arquivos.');
    }
    return entries.map(entry => (entry as string).trim());
  }
  private async assertSinglePage(filePath: string, official = false) {
    // The production processor always exposes documentInfo; lightweight legacy test doubles may omit it.
    if (typeof this.omr.documentInfo !== 'function') return;
    const info = await this.omr.documentInfo(filePath);
    if (!Number.isSafeInteger(info.page_count) || info.page_count < 1) throw new BadRequestException('Não foi possível confirmar a quantidade de páginas do documento. Use a prévia para revisar o arquivo.');
    if (info.page_count !== 1) throw new BadRequestException(official
      ? 'O gabarito do professor deve conter apenas uma página. Separe a página correta antes de cadastrar o simulado.'
      : 'Este PDF contém várias páginas. Use a prévia de importação para identificar e corrigir todos os cartões.');
  }
  private detectedMatricula(reading: OMRReading): string {
    const value = reading.matricula_detectada;
    if (reading.matricula_status !== 'CONFIRMADA' || typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new BadRequestException('Não foi possível confirmar a matrícula no cartão. Use a prévia para revisar a identificação e corrigir a matrícula antes de importar.');
    return value.trim();
  }
  async debugImage(id: number) {
    await this.result(id);
    const row = await this.db.get<{imagem_debug: string | null}>('SELECT imagem_debug FROM core_resultadoaluno WHERE id=?', id);
    if (!row?.imagem_debug) throw new NotFoundException('Imagem de conferência não encontrada.');
    return this.storage.get(row.imagem_debug);
  }
  private async readOfficial(file: Express.Multer.File | undefined, count: number): Promise<AnswerKey> {
    if (!file) throw new BadRequestException('Selecione o PDF ou a imagem do gabarito oficial.');
    const debug = join(MEDIA_ROOT, 'debug_images', randomUUID() + '_official.png');
    try {
      await this.omr.validate([file]);
      await this.assertSinglePage(file.path, true);
      const reading = await this.omr.process(file.path, {}, debug, count);
      if (reading.status === 'ERRO_LEITURA') throw new BadRequestException(reading.erro_msg);
      this.assertKey(reading.respostas_detectadas, count);
      return reading.respostas_detectadas;
    } finally {
      await this.cleanup([file]);
      await rm(debug, {force: true});
    }
  }
  async create(titulo: unknown, file?: Express.Multer.File, rawCount?: unknown, rawThemes?: unknown, rawManualKey?: unknown): Promise<Simulado> {
    const owner = accountId();
    try {
      if (typeof titulo !== 'string' || !titulo.trim() || titulo.trim().length > 255) {
        throw new BadRequestException('Informe um título de até 255 caracteres.');
      }
      const count = questionCount(rawCount), themes = themeRanges(rawThemes, count);
      const key = rawManualKey === undefined || rawManualKey === '' ? await this.readOfficial(file, count) : this.manualKey(rawManualKey, count);
      const result = await this.db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas,owner_id,expira_em) VALUES(?,?,?,?,?,?,?)', titulo.trim(), new Date().toISOString(), JSON.stringify(key), count, JSON.stringify(themes), owner, dataExpiry());
      return this.get(Number(result.lastInsertRowid));
    } finally { if (file) await this.cleanup([file]); }
  }
  async updateKey(id: number, file?: Express.Multer.File, rawThemes?: unknown, rawManualKey?: unknown): Promise<Simulado> {
    try {
      const simulado = await this.get(id);
      const themes = rawThemes === undefined ? simulado.temas : themeRanges(rawThemes, simulado.total_questoes);
      const key = rawManualKey === undefined || rawManualKey === '' ? await this.readOfficial(file, simulado.total_questoes) : this.manualKey(rawManualKey, simulado.total_questoes);
      await this.db.run('UPDATE core_simulado SET gabarito_oficial=?,temas=? WHERE id=?', JSON.stringify(key), JSON.stringify(themes), id);
      return this.get(id);
    } finally { if (file) await this.cleanup([file]); }
  }
  async updateThemes(id: number, rawThemes: unknown): Promise<Simulado> {
    const simulado = await this.get(id);
    if (rawThemes === undefined) throw new BadRequestException('Informe os intervalos de temas.');
    const themes = themeRanges(rawThemes, simulado.total_questoes);
    await this.db.run('UPDATE core_simulado SET temas=? WHERE id=?', JSON.stringify(themes), id);
    return this.get(id);
  }
  async results(id: number): Promise<ResultsData> {
    const simulado = await this.getReadable(id);
    const resultados = (await this.db.all<ResultRow>(RESULT_SQL + ' WHERE l.simulado_id=? ORDER BY r.matricula, l.criado_em DESC, r.id DESC', id)).map(row => resultDTO(row, simulado));
    return {simulado, resultados, indicadores: indicators(resultados, simulado.total_envios), envio: null};
  }
  async batch(id: number): Promise<ResultsData> {
    const row = await this.db.get<Envio>(ENVIO_SQL + ' WHERE l.id=? GROUP BY l.id, l.simulado_id, l.criado_em, s.titulo', id);
    if (!row) throw new NotFoundException('Envio não encontrado.');
    const envio = envioDTO(row);
    const simulado = await this.getReadable(envio.simulado_id);
    const resultados = (await this.db.all<ResultRow>(RESULT_SQL + ' WHERE l.id=? ORDER BY r.matricula,r.id', id)).map(row => resultDTO(row, simulado));
    return {simulado, resultados, indicadores: indicators(resultados, 1), envio};
  }
  async result(id: number): Promise<{resultado: Resultado; simulado: Simulado}> {
    const row = await this.db.get<ResultRow>(RESULT_SQL + ' WHERE r.id=?', id);
    if (!row) throw new NotFoundException('Resultado não encontrado.');
    const simuladoId = (await this.db.get<{simulado_id: number}>('SELECT simulado_id FROM core_lotecorrecao WHERE id=?', row.lote_id))!.simulado_id;
    const simulado = await this.getReadable(simuladoId);
    const revisoes = (await this.db.all<ReviewRow>('SELECT * FROM answer_review_events WHERE resultado_id=? ORDER BY versao DESC', id)).map(reviewDTO);
    return {resultado: {...resultDTO(row, simulado), revisoes}, simulado};
  }
  /** Relatórios, redações e revisão manual nunca herdam uma autorização de leitura compartilhada. */
  async resultOwned(id: number): Promise<{resultado: Resultado; simulado: Simulado}> {
    const row = await this.db.get<{simulado_id:number}>('SELECT l.simulado_id FROM core_resultadoaluno r JOIN core_lotecorrecao l ON l.id=r.lote_id WHERE r.id=?', id);
    if (!row) throw new NotFoundException('Resultado não encontrado.');
    await this.get(row.simulado_id);
    return this.result(id);
  }
  async reviewAnswers(id: number, input: unknown): Promise<{resultado: Resultado; simulado: Simulado}> {
    const reviewer = accountId();
    const reviewerName = currentAccount().nome || currentAccount().email;
    // Authorize before validating details so an unrelated account cannot probe this proof.
    const authorized = await this.resultOwned(id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Informe as questões conferidas e o motivo da revisão.');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(name => !['versao_esperada', 'respostas', 'motivo'].includes(name))) throw new BadRequestException('A revisão aceita somente respostas, motivo e versão esperada.');
    if (!Number.isSafeInteger(body.versao_esperada) || Number(body.versao_esperada) < 0) throw new BadRequestException('Atualize o espelho antes de revisar as respostas.');
    if (typeof body.motivo !== 'string' || body.motivo.trim().length < 3 || body.motivo.trim().length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(body.motivo)) throw new BadRequestException('Informe um motivo de 3 a 1.000 caracteres para registrar a revisão.');
    const reason = body.motivo.trim();
    const changes = body.respostas;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new BadRequestException('Selecione ao menos uma questão para conferir.');
    const count = authorized.simulado.total_questoes;
    for (const [question, answer] of Object.entries(changes)) {
      if (!/^[1-9]\d*$/.test(question) || Number(question) > count || !['A', 'B', 'C', 'D', 'E', 'BNK', 'RAS'].includes(String(answer)) || typeof answer !== 'string') throw new BadRequestException('Informe A, B, C, D, E, em branco ou marcação dupla para questões válidas deste simulado.');
    }
    const patch = changes as AnswerKey;
    try {
      await this.db.transaction(async () => {
        if (this.db.dialect === 'postgres') await this.db.get('SELECT id FROM core_resultadoaluno WHERE id=? FOR UPDATE', id);
        const {resultado, simulado} = await this.resultOwned(id);
        if ((resultado.revisao_versao || 0) !== body.versao_esperada) throw new ConflictException('Outra revisão foi salva após abrir esta prova. Atualize o espelho e confira novamente suas alterações.');
        const active = await this.db.get<{total: number}>(`SELECT COUNT(*) total FROM report_deliveries WHERE resultado_id=?
          AND status='ENVIANDO' AND COALESCE(tentativa_em,criado_em)>?`, id, new Date(Date.now() - 120_000).toISOString());
        if (Number(active?.total)) throw new ConflictException('O boletim está sendo enviado. Aguarde o envio terminar antes de revisar as respostas.');
        if (invalidQuestions(resultado.gabarito_do_envio, count).length) throw new BadRequestException('O gabarito deste envio está incompleto. A revisão manual não pode inventar a chave de correção.');
        const answers = {...resultado.respostas_detectadas, ...patch};
        const reviewed = [...new Set([...(resultado.questoes_revisadas || []), ...Object.keys(patch).map(Number)])].sort((a, b) => a - b);
        const complete = Array.from({length: count}, (_, i) => answers[String(i + 1)]).every(answer => ['A', 'B', 'C', 'D', 'E', 'BNK', 'RAS', 'INC'].includes(answer));
        // A failed OCR must receive a deliberate decision for every question, even if it returned plausible answers.
        const status: ReadingStatus = !complete || (resultado.status_original === 'ERRO_LEITURA' && reviewed.length !== count) ? 'ERRO_LEITURA'
          : Object.values(answers).includes('INC') ? 'ALERTA_REVISAO' : Object.values(answers).includes('RAS') ? 'ALERTA_RASURA' : 'SUCESSO';
        await this.db.run(`INSERT INTO answer_review_events(id,resultado_id,versao,revisor_id,revisor_nome,criado_em,motivo,
          respostas_antes,respostas_depois,questoes_revisadas,alteracoes,status_antes,status_depois) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          randomUUID(), id, (resultado.revisao_versao || 0) + 1, reviewer, reviewerName, new Date().toISOString(), reason,
          JSON.stringify(resultado.respostas_detectadas), JSON.stringify(answers), JSON.stringify(reviewed), JSON.stringify(patch), resultado.status, status);
      });
    } catch (error) {
      const code = (error as {code?: string}).code;
      if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ConflictException('Outra revisão foi salva. Atualize o espelho antes de tentar novamente.');
      throw error;
    }
    return this.result(id);
  }
  async upload(id: number, files: Express.Multer.File[], rawMatriculas?: unknown, loadFile?: (index: number) => Promise<Express.Multer.File>): Promise<UploadResult> {
    if (!files.length) throw new BadRequestException('Selecione pelo menos uma prova.');
    const staged: {file: Express.Multer.File; reading: OMRReading; input: string; debug: string; matricula: string; source: string}[] = [];
    let committed = false;
    const downloaded: Express.Multer.File[] = [];
    try {
      const simulado = await this.get(id);
      this.assertKey(simulado.gabarito_oficial, simulado.total_questoes);
      const matriculas = this.matriculas(rawMatriculas, files);
      if (!loadFile) await this.omr.validate(files);
      for (let index = 0; index < files.length; index++) {
        const file = loadFile ? await loadFile(index) : files[index];
        if (loadFile) { downloaded.push(file); await this.omr.validate([file]); }
        await this.assertSinglePage(file.path);
        const uuid = randomUUID();
        const input = 'uploads/' + uuid + extname(file.originalname).toLowerCase();
        const debug = 'debug_images/' + uuid + '_debug.png';
        const entry = {file, input, debug, reading: {} as OMRReading, matricula: matriculas?.[index] || '', source: matriculas ? 'manual' : 'documento'};
        staged.push(entry);
        await rename(file.path, join(MEDIA_ROOT, input));
        try {
          entry.reading = await this.omr.process(join(MEDIA_ROOT, input), simulado.gabarito_oficial, join(MEDIA_ROOT, debug), simulado.total_questoes, 1, !matriculas);
        } catch {
          entry.reading = {respostas_detectadas: {}, status: 'ERRO_LEITURA', debug_image_path: null,
            erro_msg: 'Não foi possível processar este arquivo. Reenvie uma cópia legível.'};
        }
        if (!matriculas) { entry.matricula = this.detectedMatricula(entry.reading); entry.source = ['pdf_texto','ocr'].includes(entry.reading.matricula_fonte || '') ? entry.reading.matricula_fonte! : 'documento'; }
        if (this.storage.privateCloud) {
          await this.storage.put(entry.input, await readFile(join(MEDIA_ROOT, entry.input)), entry.file.mimetype);
          if (entry.reading.debug_image_path) await this.storage.put(entry.debug, await readFile(join(MEDIA_ROOT, entry.debug)), 'image/png');
          // O lote pode somar 1 GB; mantém no disco somente o cartão atual.
          await Promise.all([rm(join(MEDIA_ROOT, input), {force: true}), rm(join(MEDIA_ROOT, debug), {force: true})]);
        }
      }
      const envioId = await this.db.transaction(async () => {
        // Revalida a existência após o processamento para lidar com exclusões concorrentes.
        await this.get(id);
        const batch = await this.db.run('INSERT INTO core_lotecorrecao(criado_em,simulado_id,gabarito_snapshot) VALUES(?,?,?)', new Date().toISOString(), id, JSON.stringify(simulado.gabarito_oficial));
        const batchId = Number(batch.lastInsertRowid);
        for (let index = 0; index < staged.length; index++) {
          const entry = staged[index];
          const r = entry.reading;
          const score = grade(r.respostas_detectadas, simulado.gabarito_oficial, r.status, simulado.total_questoes);
          const uncertain = Object.entries(r.respostas_detectadas).filter(([, answer]) => answer === 'INC').map(([q]) => q);
          const message = uncertain.length ? 'Nota provisória. Confira as questões ' + uncertain.join(', ') + ' e reenvie uma imagem mais nítida.' : r.erro_msg;
          const matricula = entry.matricula;
          await this.db.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,imagem_debug,status,lote_id,mensagem_leitura,arquivo_origem,pagina_origem,matricula_fonte)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, matricula, JSON.stringify(r.respostas_detectadas), score.total_acertos, score.total_erros,
            score.total_rasuras, score.total_brancos, score.total_incertas, score.nota_percentual,
            r.debug_image_path ? entry.debug : null, r.status, batchId, message || '', entry.file.originalname.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').slice(0,255), 1, entry.source);
        }
        return batchId;
      });
      committed = true;
      const total = (await this.get(id)).total_provas;
      const failed = staged.filter(e => e.reading.status === 'ERRO_LEITURA').length;
      return {envio_id: envioId, simulado_id: id, total_provas: total,
        message: `${files.length - failed} de ${files.length} provas lidas. O simulado agora tem ${total} provas armazenadas.${failed ? ` ${failed} falha(s) de leitura; confira os detalhes.` : ''}`};
    } finally {
      await this.cleanup([...files, ...downloaded]);
      if (!committed || this.storage.privateCloud) await Promise.all(staged.flatMap(e => [rm(join(MEDIA_ROOT, e.input), {force: true}), rm(join(MEDIA_ROOT, e.debug), {force: true})]));
      if (!committed && this.storage.privateCloud) await Promise.all(staged.flatMap(e => [this.storage.remove(e.input), this.storage.remove(e.debug)]).map(task => task.catch(() => undefined)));
    }
  }
  async delete(id: number, confirmation: unknown, expiredOnly = false, deferStorage = false) {
    if (confirmation !== 'sim') throw new BadRequestException('Confirme a exclusão do simulado.');
    const owner = accountId();
    const simulado = expiredOnly ? await this.db.get<SimuladoRow>(SIMULADO_SQL + ' WHERE s.id=? AND s.owner_id=? AND s.expira_em<=?', id, owner, new Date().toISOString()) : await this.get(id);
    if (!simulado) throw new NotFoundException('Simulado não encontrado.');
    await this.db.transaction(async () => {
      const current = await this.db.get<{id:number}>('SELECT id FROM core_simulado WHERE id=? AND owner_id=?' + (expiredOnly ? ' AND expira_em<=?' : '') + (this.db.dialect === 'postgres' ? ' FOR UPDATE' : ''), id, owner, ...(expiredOnly ? [new Date().toISOString()] : []));
      if (!current) throw new NotFoundException('Simulado não encontrado.');
      // Aguarda operações com envio externo ou leitura em andamento antes da limpeza.
      const busy = await this.db.get<{total:number}>(`SELECT COUNT(*) total FROM proof_import_pages p JOIN proof_import_plans i ON i.id=p.plan_id
        WHERE i.simulado_id=? AND p.estado='PROCESSANDO' AND p.claim_at>?`, id, new Date(Date.now()-120_000).toISOString());
      const sending = await this.db.get<{total:number}>(`SELECT COUNT(*) total FROM report_deliveries d JOIN core_resultadoaluno r ON r.id=d.resultado_id
        JOIN core_lotecorrecao l ON l.id=r.lote_id WHERE l.simulado_id=? AND d.status='ENVIANDO' AND COALESCE(d.tentativa_em,d.criado_em)>?`, id, new Date(Date.now()-120_000).toISOString());
      if (Number(busy?.total) || Number(sending?.total)) throw new BadRequestException('Há provas ou e-mails em processamento. Aguarde a operação terminar.');
      const pending = await this.db.all<{payload:string}>('SELECT payload FROM proof_import_plans WHERE simulado_id=?', id);
      const keys = new Set<string>();
      for (const row of pending) {
        const payload = JSON.parse(row.payload) as {files?:Array<{key?:string}>};
        for (const file of payload.files || []) if (typeof file.key === 'string' && /^(importing|incoming)\/[0-9a-f-]+\.[a-z0-9]+$/i.test(file.key)) keys.add(file.key);
      }
      const images = await this.db.all<{imagem_debug:string|null; arquivo_origem:string; matricula_fonte:string}>(`SELECT r.imagem_debug,r.arquivo_origem,r.matricula_fonte FROM core_resultadoaluno r
        JOIN core_lotecorrecao l ON l.id=r.lote_id WHERE l.simulado_id=?`, id);
      for (const image of images) if (image.imagem_debug) {
        keys.add(image.imagem_debug);
        const uuid = image.imagem_debug.match(/^debug_images\/([0-9a-f-]+)_debug\.png$/i)?.[1];
        const extension = extname(image.arquivo_origem || '').toLowerCase();
        if (uuid && /^(\.pdf|\.png|\.jpe?g|\.webp|\.bmp|\.tiff?)$/.test(extension)) keys.add('uploads/' + uuid + extension);
      }
      for (const key of keys) await this.db.run('INSERT INTO storage_deletions(path,criado_em) VALUES(?,?) ON CONFLICT(path) DO NOTHING', key, new Date().toISOString());
      await this.db.run('DELETE FROM core_resultadoaluno WHERE lote_id IN (SELECT id FROM core_lotecorrecao WHERE simulado_id=?)', id);
      await this.db.run('DELETE FROM core_lotecorrecao WHERE simulado_id=?', id);
      await this.db.run('DELETE FROM core_simulado WHERE id=? AND owner_id=?', id, owner);
    });
    if (!deferStorage) await this.cleanStorage();
    return {message: `Simulado '${simulado.titulo}' e seus resultados foram excluídos.`};
  }
  async cleanStorage(deadline = Date.now() + 60_000) {
    const cutoff = new Date().toISOString();
    let removed = 0, afterDate = '', afterPath = '';
    while (Date.now() < deadline) {
      const files = await this.db.all<{path:string;criado_em:string}>(`SELECT path,criado_em FROM storage_deletions
        WHERE criado_em<=? AND (criado_em>? OR (criado_em=? AND path>?)) ORDER BY criado_em,path LIMIT 100`, cutoff, afterDate, afterDate, afterPath);
      if (!files.length) break;
      for (let index = 0; index < files.length; index += 5) {
        if (Date.now() >= deadline) return removed;
        await Promise.all(files.slice(index, index + 5).map(async file => {
          try {
            await this.storage.remove(file.path);
            const deleted = await this.db.run('DELETE FROM storage_deletions WHERE path=? AND criado_em=?', file.path, file.criado_em);
            removed += deleted.changes;
          } catch { /* Failed keys stay durable; the cursor still lets later files progress. */ }
        }));
      }
      afterDate = files.at(-1)!.criado_em; afterPath = files.at(-1)!.path;
    }
    return removed;
  }
  async cleanupExpired() {
    const cutoff = new Date().toISOString();
    let removed = 0, afterExpiry = '', afterId = 0;
    for (;;) {
      const expired = await this.db.all<{id:number;owner_id:string;expira_em:string}>(`SELECT id,owner_id,expira_em FROM core_simulado
        WHERE owner_id<>? AND expira_em<=? AND (expira_em>? OR (expira_em=? AND id>?))
        ORDER BY expira_em,id LIMIT 20`, '', cutoff, afterExpiry, afterExpiry, afterId);
      if (!expired.length) break;
      for (const row of expired) {
        afterExpiry = row.expira_em; afterId = row.id;
        try {
          // Drain academic records first. Storage removal is already queued in
          // the same transaction and is handled by the cron after this pass.
          await withAccount({id:row.owner_id,email:''}, () => this.delete(row.id,'sim',true,true)); removed++;
        } catch { /* Busy/transient records are retried on the next pass, without starving later IDs. */ }
      }
    }
    return removed;
  }
}
