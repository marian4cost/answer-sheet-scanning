import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join, basename, extname } from 'node:path';
import { rename, rm, readFile } from 'node:fs/promises';
import type { AnswerKey, DashboardData, Simulado, SimuladoDetail, Envio, Resultado, ResultsData, UploadResult, OMRReading } from '@enem/shared';
import { DatabaseService } from './database.service';
import { OmrService } from './omr.service';
import { MEDIA_ROOT, STORAGE_MODE } from './config';
import { StorageService } from './storage.service';
import { grade, gradeThemes, indicators, invalidQuestions } from './grading';
import { questionCount, themeRanges } from './question-config';

type SimuladoRow = Omit<Simulado, 'gabarito_oficial' | 'gabarito_valido' | 'temas'> & {gabarito_oficial: string; temas: string};
type ResultRow = Omit<Resultado, 'respostas_detectadas' | 'gabarito_do_envio' | 'desempenho_temas'> & {respostas_detectadas: string; gabarito_snapshot: string};
const SIMULADO_SQL = `SELECT s.*, (SELECT CAST(COUNT(*) AS INTEGER) FROM core_lotecorrecao l JOIN core_resultadoaluno r ON r.lote_id=l.id WHERE l.simulado_id=s.id) total_provas,
  (SELECT CAST(COUNT(*) AS INTEGER) FROM core_lotecorrecao l WHERE l.simulado_id=s.id) total_envios FROM core_simulado s`;
const ENVIO_SQL = `SELECT l.id, l.simulado_id, l.criado_em, s.titulo, CAST(COUNT(r.id) AS INTEGER) total_provas
  FROM core_lotecorrecao l JOIN core_simulado s ON s.id=l.simulado_id LEFT JOIN core_resultadoaluno r ON r.lote_id=l.id`;
const RESULT_SQL = `SELECT r.*, l.criado_em, l.gabarito_snapshot FROM core_resultadoaluno r JOIN core_lotecorrecao l ON l.id=r.lote_id`;
function dateISO(value: string) {
  return new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z').toISOString();
}
function simuladoDTO(row: SimuladoRow): Simulado {
  const key = JSON.parse(row.gabarito_oficial) as AnswerKey;
  return {...row, temas: JSON.parse(row.temas), data_criacao: dateISO(row.data_criacao), gabarito_oficial: key,
    gabarito_valido: Object.keys(key).length === row.total_questoes && invalidQuestions(key, row.total_questoes).length === 0};
}
function envioDTO(row: Envio): Envio { return {...row, criado_em: dateISO(row.criado_em)}; }
function resultDTO(row: ResultRow, simulado: Simulado): Resultado {
  const {gabarito_snapshot, ...rest} = row;
  const answers: AnswerKey = JSON.parse(row.respostas_detectadas), key: AnswerKey = JSON.parse(gabarito_snapshot);
  return {...rest, respostas_detectadas: answers,
    gabarito_do_envio: key, criado_em: dateISO(row.criado_em),
    desempenho_temas: gradeThemes(answers, key, row.status, simulado.total_questoes, simulado.temas),
    imagem_debug: row.imagem_debug ? (STORAGE_MODE === 'supabase' ? `/api/resultados/${row.id}/imagem` : '/media/' + row.imagem_debug.replace(/^\/+/, '')) : null};
}

@Injectable()
export class SimuladosService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(OmrService) private readonly omr: OmrService, @Inject(StorageService) private readonly storage: StorageService) {}
  async dashboard(): Promise<DashboardData> {
    const simulados = (await this.db.all<SimuladoRow>(SIMULADO_SQL + ' ORDER BY s.data_criacao DESC, s.id DESC')).map(simuladoDTO);
    const envios = (await this.db.all<Envio>(ENVIO_SQL + ' GROUP BY l.id, l.simulado_id, l.criado_em, s.titulo ORDER BY l.criado_em DESC, l.id DESC LIMIT 10')).map(envioDTO);
    return {simulados, envios_recentes: envios, total_simulados: simulados.length, total_provas: simulados.reduce((sum, s) => sum + s.total_provas, 0)};
  }
  async get(id: number): Promise<Simulado> {
    const row = await this.db.get<SimuladoRow>(SIMULADO_SQL + ' WHERE s.id=?', id);
    if (!row) throw new NotFoundException('Simulado não encontrado.');
    return simuladoDTO(row);
  }
  async detail(id: number): Promise<SimuladoDetail> {
    return {simulado: await this.get(id), envios: (await this.db.all<Envio>(ENVIO_SQL + ' WHERE l.simulado_id=? GROUP BY l.id, l.simulado_id, l.criado_em, s.titulo ORDER BY l.criado_em DESC, l.id DESC', id)).map(envioDTO)};
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
  private matriculas(value: unknown, files: Express.Multer.File[]): string[] {
    if (value === undefined || value === '') return files.map(file => basename(file.originalname, extname(file.originalname)).slice(0, 100));
    let entries: unknown = value;
    if (typeof entries === 'string') {
      try { entries = JSON.parse(entries); } catch { throw new BadRequestException('A lista de matrículas é inválida.'); }
    }
    if (!Array.isArray(entries) || entries.length !== files.length || entries.some(entry => typeof entry !== 'string' || !entry.trim() || entry.trim().length > 100)) {
      throw new BadRequestException('Informe uma matrícula de até 100 caracteres para cada prova, na ordem dos arquivos.');
    }
    return entries.map(entry => (entry as string).trim());
  }
  async debugImage(id: number) {
    const row = await this.db.get<{imagem_debug: string | null}>('SELECT imagem_debug FROM core_resultadoaluno WHERE id=?', id);
    if (!row?.imagem_debug) throw new NotFoundException('Imagem de conferência não encontrada.');
    return this.storage.get(row.imagem_debug);
  }
  private async readOfficial(file: Express.Multer.File | undefined, count: number): Promise<AnswerKey> {
    if (!file) throw new BadRequestException('Selecione o PDF ou a imagem do gabarito oficial.');
    const debug = join(MEDIA_ROOT, 'debug_images', randomUUID() + '_official.png');
    try {
      await this.omr.validate([file]);
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
    try {
      if (typeof titulo !== 'string' || !titulo.trim() || titulo.trim().length > 255) {
        throw new BadRequestException('Informe um título de até 255 caracteres.');
      }
      const count = questionCount(rawCount), themes = themeRanges(rawThemes, count);
      const key = rawManualKey === undefined || rawManualKey === '' ? await this.readOfficial(file, count) : this.manualKey(rawManualKey, count);
      const result = await this.db.run('INSERT INTO core_simulado(titulo,data_criacao,gabarito_oficial,total_questoes,temas) VALUES(?,?,?,?,?)', titulo.trim(), new Date().toISOString(), JSON.stringify(key), count, JSON.stringify(themes));
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
    const simulado = await this.get(id);
    const resultados = (await this.db.all<ResultRow>(RESULT_SQL + ' WHERE l.simulado_id=? ORDER BY r.matricula, l.criado_em DESC, r.id DESC', id)).map(row => resultDTO(row, simulado));
    return {simulado, resultados, indicadores: indicators(resultados, simulado.total_envios), envio: null};
  }
  async batch(id: number): Promise<ResultsData> {
    const row = await this.db.get<Envio>(ENVIO_SQL + ' WHERE l.id=? GROUP BY l.id, l.simulado_id, l.criado_em, s.titulo', id);
    if (!row) throw new NotFoundException('Envio não encontrado.');
    const envio = envioDTO(row);
    const simulado = await this.get(envio.simulado_id);
    const resultados = (await this.db.all<ResultRow>(RESULT_SQL + ' WHERE l.id=? ORDER BY r.matricula,r.id', id)).map(row => resultDTO(row, simulado));
    return {simulado, resultados, indicadores: indicators(resultados, 1), envio};
  }
  async result(id: number): Promise<{resultado: Resultado; simulado: Simulado}> {
    const row = await this.db.get<ResultRow>(RESULT_SQL + ' WHERE r.id=?', id);
    if (!row) throw new NotFoundException('Resultado não encontrado.');
    const simuladoId = (await this.db.get<{simulado_id: number}>('SELECT simulado_id FROM core_lotecorrecao WHERE id=?', row.lote_id))!.simulado_id;
    const simulado = await this.get(simuladoId);
    return {resultado: resultDTO(row, simulado), simulado};
  }
  async upload(id: number, files: Express.Multer.File[], rawMatriculas?: unknown, loadFile?: (index: number) => Promise<Express.Multer.File>): Promise<UploadResult> {
    if (!files.length) throw new BadRequestException('Selecione pelo menos uma prova.');
    const staged: {file: Express.Multer.File; reading: OMRReading; input: string; debug: string}[] = [];
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
        const uuid = randomUUID();
        const input = 'uploads/' + uuid + extname(file.originalname).toLowerCase();
        const debug = 'debug_images/' + uuid + '_debug.png';
        const entry = {file, input, debug, reading: {} as OMRReading};
        staged.push(entry);
        await rename(file.path, join(MEDIA_ROOT, input));
        try {
          entry.reading = await this.omr.process(join(MEDIA_ROOT, input), simulado.gabarito_oficial, join(MEDIA_ROOT, debug), simulado.total_questoes);
        } catch {
          entry.reading = {respostas_detectadas: {}, status: 'ERRO_LEITURA', debug_image_path: null,
            erro_msg: 'Não foi possível processar este arquivo. Reenvie uma cópia legível.'};
        }
        if (STORAGE_MODE === 'supabase') {
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
          const matricula = matriculas[index];
          await this.db.run(`INSERT INTO core_resultadoaluno(matricula,respostas_detectadas,total_acertos,total_erros,total_rasuras,total_brancos,total_incertas,nota_percentual,imagem_debug,status,lote_id,mensagem_leitura)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, matricula, JSON.stringify(r.respostas_detectadas), score.total_acertos, score.total_erros,
            score.total_rasuras, score.total_brancos, score.total_incertas, score.nota_percentual,
            r.debug_image_path ? entry.debug : null, r.status, batchId, message || '');
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
      if (!committed || STORAGE_MODE === 'supabase') await Promise.all(staged.flatMap(e => [rm(join(MEDIA_ROOT, e.input), {force: true}), rm(join(MEDIA_ROOT, e.debug), {force: true})]));
      if (!committed && STORAGE_MODE === 'supabase') await Promise.all(staged.flatMap(e => [this.storage.remove(e.input), this.storage.remove(e.debug)]).map(task => task.catch(() => undefined)));
    }
  }
  async delete(id: number, confirmation: unknown) {
    if (confirmation !== 'sim') throw new BadRequestException('Confirme a exclusão do simulado.');
    const simulado = await this.get(id);
    await this.db.transaction(async () => {
      await this.db.run('DELETE FROM core_resultadoaluno WHERE lote_id IN (SELECT id FROM core_lotecorrecao WHERE simulado_id=?)', id);
      await this.db.run('DELETE FROM core_lotecorrecao WHERE simulado_id=?', id);
      await this.db.run('DELETE FROM core_simulado WHERE id=?', id);
    });
    return {message: `Simulado '${simulado.titulo}' e seus resultados foram excluídos.`};
  }
}
