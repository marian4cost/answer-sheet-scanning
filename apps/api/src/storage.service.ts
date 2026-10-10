import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { MAX_FILE_SIZE, MEDIA_ROOT, STORAGE_MODE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET } from './config';

@Injectable()
export class StorageService {
  private bucketReady?: Promise<void>;
  readonly privateCloud = STORAGE_MODE === 'supabase';
  private safeKey(key: string) {
    if (!key || key.startsWith('/') || key.split('/').some(segment => !segment || segment === '.' || segment === '..') || /[\\\x00-\x1f]/.test(key)) {
      throw new InternalServerErrorException('Identificador de arquivo inválido.');
    }
    return key.split('/').map(encodeURIComponent).join('/');
  }
  private async request(path: string, init: RequestInit = {}) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new InternalServerErrorException('O armazenamento privado não foi configurado.');
    return fetch(SUPABASE_URL.replace(/\/$/, '') + '/storage/v1/' + path, {
      ...init, headers: {apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, ...init.headers},
      signal: AbortSignal.timeout(30_000),
    });
  }
  private async ensureBucket() {
    this.bucketReady ??= (async () => {
      const response = await this.request('bucket/' + encodeURIComponent(SUPABASE_STORAGE_BUCKET));
      if (response.status === 404 || response.status === 400) {
        const created = await this.request('bucket', {method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({id: SUPABASE_STORAGE_BUCKET, name: SUPABASE_STORAGE_BUCKET, public: false, file_size_limit: MAX_FILE_SIZE})});
        if (!created.ok && created.status !== 409) throw new InternalServerErrorException('Não foi possível preparar o armazenamento privado.');
      } else if (!response.ok) throw new InternalServerErrorException('Não foi possível acessar o armazenamento privado.');
      const check = await this.request('bucket/' + encodeURIComponent(SUPABASE_STORAGE_BUCKET));
      if (!check.ok || (await check.json() as {public?: boolean}).public !== false) {
        throw new InternalServerErrorException('O bucket dos gabaritos precisa ser privado.');
      }
    })();
    try { await this.bucketReady; } catch (error) { this.bucketReady = undefined; throw error; }
  }
  async put(key: string, content: Buffer, contentType = 'application/octet-stream') {
    const encoded = this.safeKey(key);
    if (!this.privateCloud) {
      const path = join(MEDIA_ROOT, key);
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, content); return;
    }
    await this.ensureBucket();
    const response = await this.request(`object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encoded}`, {
      method: 'POST', headers: {'Content-Type': contentType, 'x-upsert': 'false'}, body: new Uint8Array(content),
    });
    if (!response.ok) throw new InternalServerErrorException('Não foi possível guardar o arquivo no armazenamento privado.');
  }
  async get(key: string, maxSize = MAX_FILE_SIZE): Promise<{buffer: Buffer; contentType: string}> {
    const encoded = this.safeKey(key);
    if (!this.privateCloud) {
      try {
        const buffer = await readFile(join(MEDIA_ROOT, key));
        if (buffer.length > maxSize) throw new InternalServerErrorException('O arquivo excedeu o tamanho permitido.');
        const types: Record<string, string> = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.webp': 'image/webp'};
        return {buffer, contentType: types[extname(key).toLowerCase()] || 'application/octet-stream'};
      } catch (error) { if (error instanceof InternalServerErrorException) throw error; throw new NotFoundException('Arquivo não encontrado.'); }
    }
    const response = await this.request(`object/authenticated/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encoded}`);
    if (response.status === 404) throw new NotFoundException('Arquivo não encontrado.');
    // O Storage também devolve HTTP 400 com statusCode 404 para objeto ausente.
    if (response.status === 400) {
      const error = await response.json().catch(() => null) as {statusCode?: string | number; error?: string} | null;
      if (String(error?.statusCode) === '404' && error?.error === 'not_found') throw new NotFoundException('Arquivo não encontrado.');
    }
    if (!response.ok) throw new InternalServerErrorException('Não foi possível abrir o arquivo privado.');
    return {buffer: await this.boundedBody(response, maxSize), contentType: response.headers.get('Content-Type') || 'application/octet-stream'};
  }
  private async boundedBody(response: globalThis.Response, maxSize: number) {
    const length = Number(response.headers.get('Content-Length') || '0');
    if (length > maxSize) { await response.body?.cancel(); throw new InternalServerErrorException('O arquivo excedeu o tamanho permitido.'); }
    const reader = response.body?.getReader();
    if (!reader) throw new InternalServerErrorException('O arquivo não retornou conteúdo.');
    const chunks: Buffer[] = []; let total = 0;
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxSize) { await reader.cancel(); throw new InternalServerErrorException('O arquivo excedeu o tamanho permitido.'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, total);
  }
  private signedURL(path: unknown, expectedPrefix: string) {
    if (typeof path !== 'string' || !path.startsWith(expectedPrefix)) throw new InternalServerErrorException('O armazenamento retornou uma URL inválida.');
    return SUPABASE_URL.replace(/\/$/, '') + '/storage/v1' + path;
  }
  async signedUploadURL(key: string) {
    if (!this.privateCloud) throw new InternalServerErrorException('O upload direto precisa do armazenamento privado.');
    const encoded = this.safeKey(key);
    await this.ensureBucket();
    const prefix = `/object/upload/sign/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/`;
    const response = await this.request(prefix.slice(1) + encoded, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    if (!response.ok) throw new InternalServerErrorException('Não foi possível autorizar o upload direto.');
    return this.signedURL((await response.json() as {url?: unknown}).url, prefix);
  }
  async signedDownloadURL(key: string, expiresIn = 120) {
    if (!this.privateCloud) throw new InternalServerErrorException('O processamento remoto precisa do armazenamento privado.');
    const encoded = this.safeKey(key);
    const response = await this.request(`object/sign/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${encoded}`, {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({expiresIn})});
    if (!response.ok) throw new InternalServerErrorException('Não foi possível autorizar a leitura temporária.');
    return this.signedURL((await response.json() as {signedURL?: unknown}).signedURL, `/object/sign/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/`);
  }
  async remove(key: string) {
    this.safeKey(key);
    if (!this.privateCloud) { await rm(join(MEDIA_ROOT, key), {force: true}); return; }
    const response = await this.request('object/' + encodeURIComponent(SUPABASE_STORAGE_BUCKET), {
      method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({prefixes: [key]}),
    });
    if (!response.ok && response.status !== 404) throw new InternalServerErrorException('Não foi possível remover o arquivo privado.');
  }
}
