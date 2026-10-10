import { BadRequestException, Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { StorageService } from './storage.service';
import { spawn } from 'node:child_process';
import { basename, dirname, extname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AnswerKey, OMRReading } from '@enem/shared';
import { PYTHON_EXECUTABLE, WORKER_PATH, PROJECT_ROOT, OMR_REMOTE_URL, OMR_REMOTE_SECRET, MAX_FILE_SIZE } from './config';

@Injectable()
export class OmrService {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private async call<T>(payload: object): Promise<T> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return OMR_REMOTE_URL ? await this.remote<T>(payload) : await this.local<T>(payload); }
    finally {
      // Transfere a vaga diretamente: novas requisições não ultrapassam a fila.
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
  private async remote<T>(payload: object): Promise<T> {
    if (!OMR_REMOTE_SECRET) throw new InternalServerErrorException('A autenticação do processador remoto não foi configurada.');
    const temporary: string[] = [];
    const uploadInput = async (file: {name?: string; file_name?: string; file_base64?: string}) => {
      const name = file.name || file.file_name || 'input.png';
      const content = Buffer.from(file.file_base64 || '', 'base64');
      if (!content.length || content.length > MAX_FILE_SIZE) throw new BadRequestException('O arquivo deve conter até 20 MB.');
      const key = 'processing/' + randomUUID() + extname(name).toLowerCase();
      temporary.push(key);
      await this.storage.put(key, content, extname(name).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream');
      return {name, file_url: await this.storage.signedDownloadURL(key, 120)};
    };
    try {
      const input = {...payload} as Record<string, unknown>;
      if (typeof input.file_base64 === 'string') {
        const file = await uploadInput(input as {file_name?: string; file_base64?: string});
        input.file_url = file.file_url; delete input.file_base64;
      }
      if (Array.isArray(input.files)) input.files = await Promise.all(input.files.map(file => uploadInput(file)));
      let response: globalThis.Response;
      try {
        response = await fetch(OMR_REMOTE_URL, {method: 'POST',
          headers: {'Content-Type': 'application/json', 'X-OMR-Secret': OMR_REMOTE_SECRET, Authorization: `Bearer ${OMR_REMOTE_SECRET}`},
          body: JSON.stringify(input), signal: AbortSignal.timeout(60_000)});
      } catch { throw new InternalServerErrorException('O processador remoto não respondeu. Tente novamente.'); }
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new InternalServerErrorException('O processador remoto não retornou uma leitura válida.'); }
      const error = typeof data === 'object' && data !== null && 'error' in data ? (data as {error: unknown}).error : null;
      if (error && typeof error === 'string') throw new BadRequestException(error);
      if (!response.ok) throw new InternalServerErrorException('O processador remoto está indisponível.');
      return data as T;
    } finally { await Promise.all(temporary.map(key => this.storage.remove(key).catch(() => undefined))); }
  }
  private local<T>(payload: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const child = spawn(PYTHON_EXECUTABLE, [WORKER_PATH], {
        cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
      });
      let stdout = '', timedOut = false, oversized = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => { stdout += data; if (stdout.length > 2_000_000) { oversized = true; child.kill('SIGKILL'); } });
      // Consome stderr sem incluir caminhos, dados de alunos ou segredos nas respostas HTTP.
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        reject(new InternalServerErrorException('O processador de imagens não iniciou. Verifique o ambiente Python.'));
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) return reject(new InternalServerErrorException('A leitura excedeu 60 segundos. Envie uma imagem menor ou mais nítida.'));
        if (oversized) return reject(new InternalServerErrorException('A resposta do processador excedeu o limite.'));
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) return reject(new BadRequestException(parsed.error));
          if (code !== 0) throw new Error('worker exit');
          resolve(parsed as T);
        } catch { reject(new InternalServerErrorException('O processador de imagens não retornou uma leitura válida.')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    });
  }
  async validate(files: Express.Multer.File[]) {
    if (!OMR_REMOTE_URL) return this.call<{ok: boolean}>({action: 'validate', files: files.map(file => ({path: file.path, name: file.originalname}))});
    for (const file of files) {
      await this.call<{ok: boolean}>({action: 'validate', files: [{name: file.originalname, file_base64: (await readFile(file.path)).toString('base64')}]});
    }
    return {ok: true};
  }
  async process(filePath: string, key: AnswerKey, debugPath: string, questionCount = 50): Promise<OMRReading> {
    if (!OMR_REMOTE_URL) return this.call<OMRReading>({action: 'process', file_path: filePath, answer_key: key, debug_path: debugPath, question_count: questionCount});
    const result = await this.call<OMRReading & {debug_image_base64?: string}>({action: 'process', file_name: basename(filePath),
      file_base64: (await readFile(filePath)).toString('base64'), answer_key: key, question_count: questionCount, debug: true});
    const {debug_image_base64, ...reading} = result;
    if (debug_image_base64) {
      if (debug_image_base64.length > 60_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(debug_image_base64)) throw new InternalServerErrorException('A imagem de conferência retornada é inválida.');
      await mkdir(dirname(debugPath), {recursive: true});
      await writeFile(debugPath, Buffer.from(debug_image_base64, 'base64'));
      reading.debug_image_path = debugPath;
    } else reading.debug_image_path = null;
    return reading;
  }
  health() { return this.call<{ok: boolean; opencv: string; poppler: boolean}>({action: 'health'}); }
}
