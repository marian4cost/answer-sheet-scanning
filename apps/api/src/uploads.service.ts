import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { DatabaseService } from './database.service';
import { StorageService } from './storage.service';
import { OmrService } from './omr.service';
import { SimuladosService } from './simulados.service';
import { ALLOWED_EXTENSIONS, MAX_FILE_SIZE, MEDIA_ROOT } from './config';
import { questionCount } from './question-config';

export interface UploadReceipt { id: string; path: string; name: string; size: number; purpose: 'gabarito' | 'prova'; created_at: string; consumed_at: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class UploadsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(OmrService) private readonly omr: OmrService,
    @Inject(SimuladosService) private readonly simulados: SimuladosService) {}

  async prepare(value: unknown) {
    if (!this.storage.privateCloud) throw new BadRequestException('Utilize o envio direto de arquivos no ambiente local.');
    if (!Array.isArray(value) || !value.length || value.length > 50) throw new BadRequestException('Selecione de 1 a 50 arquivos por envio.');
    const now = new Date().toISOString();
    const receipts: UploadReceipt[] = value.map(file => {
      if (!file || typeof file !== 'object') throw new BadRequestException('Arquivo de upload inválido.');
      const {name, size, purpose} = file as {name?: unknown; size?: unknown; purpose?: unknown};
      if (typeof name !== 'string' || !name.trim() || name.length > 255 || !ALLOWED_EXTENSIONS.includes(extname(name).toLowerCase())) {
        throw new BadRequestException('Use arquivos PDF, JPEG/JPG, PNG, WEBP, BMP ou TIFF com nomes de até 255 caracteres.');
      }
      if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_FILE_SIZE) throw new BadRequestException('Cada arquivo deve conter até 20 MB.');
      if (purpose !== 'gabarito' && purpose !== 'prova') throw new BadRequestException('Finalidade de upload inválida.');
      const id = randomUUID();
      return {id, path: `incoming/${id}${extname(name).toLowerCase()}`, name: name.trim(), size, purpose, created_at: now, consumed_at: null};
    });
    const uploads = [];
    for (const receipt of receipts) uploads.push({id: receipt.id, name: receipt.name, url: await this.storage.signedUploadURL(receipt.path)});
    await this.db.transaction(async () => {
      for (const receipt of receipts) await this.db.run('INSERT INTO uploaded_files(id,path,name,size,purpose,created_at,consumed_at) VALUES(?,?,?,?,?,?,?)',
        receipt.id, receipt.path, receipt.name, receipt.size, receipt.purpose, receipt.created_at, null);
    });
    return {uploads};
  }
  private async consume(value: unknown, purpose: UploadReceipt['purpose'], single = false) {
    if (!this.storage.privateCloud) throw new BadRequestException('O upload pelo armazenamento não está configurado.');
    if (!Array.isArray(value) || !value.length || value.length > (single ? 1 : 50) || value.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(value).size !== value.length) {
      throw new BadRequestException('Informe identificadores de upload válidos e sem repetições.');
    }
    return this.db.transaction(async () => {
      const receipts: UploadReceipt[] = [];
      const now = new Date();
      for (const id of value) {
        const receipt = await this.db.get<UploadReceipt>('SELECT * FROM uploaded_files WHERE id=?', id);
        if (!receipt) throw new NotFoundException('Upload não encontrado.');
        if (receipt.purpose !== purpose) throw new BadRequestException('O arquivo foi enviado para outra finalidade.');
        if (receipt.consumed_at) throw new BadRequestException('Este upload já foi utilizado. Envie o arquivo novamente.');
        if (!Number.isFinite(Date.parse(receipt.created_at)) || now.getTime() - Date.parse(receipt.created_at) > 30 * 60_000) throw new BadRequestException('O upload expirou. Envie o arquivo novamente.');
        if (receipt.path !== `incoming/${receipt.id}${extname(receipt.name).toLowerCase()}` || receipt.size <= 0 || receipt.size > MAX_FILE_SIZE) {
          throw new BadRequestException('O recibo do arquivo é inválido.');
        }
        const claim = await this.db.run('UPDATE uploaded_files SET consumed_at=? WHERE id=? AND consumed_at IS NULL', now.toISOString(), id);
        if (claim.changes !== 1) throw new BadRequestException('Este upload já foi utilizado.');
        receipts.push(receipt);
      }
      return receipts;
    });
  }
  async claimProofs(ids: unknown): Promise<UploadReceipt[]> { return this.consume(ids, 'prova'); }
  private async download(receipt: UploadReceipt): Promise<Express.Multer.File> {
    const downloaded = await this.storage.get(receipt.path, receipt.size);
    if (downloaded.buffer.length !== receipt.size) throw new BadRequestException('O arquivo recebido tem um tamanho diferente do informado. Envie-o novamente.');
    const directory = join(MEDIA_ROOT, '.staging');
    await mkdir(directory, {recursive: true});
    const filename = randomUUID() + extname(receipt.name).toLowerCase(), path = join(directory, filename);
    await writeFile(path, downloaded.buffer);
    return {fieldname: 'pdf_files', originalname: receipt.name, encoding: '7bit', mimetype: downloaded.contentType,
      size: downloaded.buffer.length, destination: directory, filename, path} as Express.Multer.File;
  }
  async readOfficial(uploadId: unknown, rawCount: unknown) {
    const count = questionCount(rawCount);
    const receipts = await this.consume([uploadId], 'gabarito', true);
    let file: Express.Multer.File | undefined;
    const debugPath = join(MEDIA_ROOT, 'debug_images', randomUUID() + '_preview.png');
    try {
      file = await this.download(receipts[0]);
      await this.omr.validate([file]);
      const reading = await this.omr.process(file.path, {}, debugPath, count);
      return {...reading, debug_image_path: null};
    } finally {
      if (file) await rm(file.path, {force: true});
      await rm(debugPath, {force: true});
      await this.storage.remove(receipts[0].path).catch(() => undefined);
    }
  }
  async uploadStudents(id: number, uploadIds: unknown, matriculas: unknown) {
    // Evita consumir recibos quando o simulado ou as matrículas não são válidos.
    await this.simulados.get(id);
    if (!Array.isArray(uploadIds) || !Array.isArray(matriculas) || matriculas.length !== uploadIds.length || matriculas.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 100)) {
      throw new BadRequestException('Informe uma matrícula de até 100 caracteres para cada prova.');
    }
    const receipts = await this.consume(uploadIds, 'prova');
    // Os metadados preservam a ordem, mas cada arquivo só chega ao disco na sua vez.
    const files = receipts.map(receipt => ({originalname: receipt.name, size: receipt.size,
      path: join(MEDIA_ROOT, '.staging', receipt.id + extname(receipt.name).toLowerCase())} as Express.Multer.File));
    try {
      return await this.simulados.upload(id, files, matriculas, index => this.download(receipts[index]));
    } finally {
      await Promise.all(receipts.map(receipt => this.storage.remove(receipt.path).catch(() => undefined)));
    }
  }
}
