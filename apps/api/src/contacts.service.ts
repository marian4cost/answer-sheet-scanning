import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { extname } from 'node:path';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { DatabaseService } from './database.service';
import type { StudentContact, ContactImportPreview } from '@enem/shared/src/reports';

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
    && !value.split('@')[0].startsWith('.') && !value.split('@')[0].endsWith('.') && !value.split('@')[0].includes('..');
}
function header(value: string) { return value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function contactComparable(value?: StudentContact) { return value ? {matricula: value.matricula, email: value.email, nome: value.nome} : null; }
@Injectable()
export class ContactsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  async list(): Promise<{contatos: StudentContact[]}> { return {contatos: await this.db.all<StudentContact>('SELECT * FROM student_contacts ORDER BY matricula')}; }
  async get(matricula: string): Promise<StudentContact | undefined> { return this.db.get<StudentContact>('SELECT * FROM student_contacts WHERE matricula=?', matricula); }
  template(): string { return '\uFEFFmatricula,email,nome\r\n000123,aluno@example.com,Aluno de exemplo\r\n'; }
  private async fingerprint(contacts: StudentContact[]) {
    const state = await Promise.all(contacts.map(async contact => contactComparable(await this.get(contact.matricula))));
    return sha256(JSON.stringify(state));
  }
  private async rows(buffer: Buffer, filename: string): Promise<{rows: unknown[][]; errors: string[]}> {
    if (buffer.length > 2 * 1024 * 1024) throw new BadRequestException('A planilha deve ter até 2 MB.');
    const extension = extname(filename).toLowerCase();
    if (extension === '.csv') {
      // Detects comma/semicolon delimiters while retaining every identifier as text.
      const parsed = Papa.parse<unknown[]>(buffer.toString('utf8').replace(/^\uFEFF/, ''), {skipEmptyLines: 'greedy', dynamicTyping: false});
      return {rows: parsed.data, errors: parsed.errors.map(error => 'CSV inválido: ' + error.message)};
    }
    if (extension !== '.xlsx') throw new BadRequestException('Use uma planilha CSV ou XLSX com matrícula, email e nome opcional.');
    const book = new ExcelJS.Workbook();
    try { await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]); }
    catch { throw new BadRequestException('Não foi possível abrir a planilha XLSX.'); }
    if (book.worksheets.length !== 1) throw new BadRequestException('Use uma planilha com apenas uma aba para evitar importar contatos da aba errada.');
    const sheet = book.worksheets[0];
    if (sheet.rowCount > 10001 || sheet.columnCount > 20) throw new BadRequestException('A planilha aceita até 10.000 contatos e 20 colunas.');
    const rows: unknown[][] = [];
    sheet.eachRow({includeEmpty: false}, row => {
      rows.push(Array.from({length: sheet.columnCount}, (_, i) => {
        const value = row.getCell(i + 1).value;
        if (value && typeof value === 'object' && 'richText' in value) return value.richText.map(item => item.text).join('');
        return value;
      }));
    });
    return {rows, errors: []};
  }
  async preview(buffer: Buffer, filename: string): Promise<ContactImportPreview> {
    const parsed = await this.rows(buffer, filename), errors = [...parsed.errors], warnings: string[] = [];
    if (parsed.rows.length < 2) errors.push('Inclua o cabeçalho e pelo menos um contato.');
    if (parsed.rows.length > 10001) throw new BadRequestException('A planilha aceita até 10.000 contatos.');
    const headers = (parsed.rows[0] || []).map(value => typeof value === 'string' ? header(value) : '');
    const matriculaIndex = headers.indexOf('matricula'), emailIndex = headers.indexOf('email'), nameIndex = headers.indexOf('nome');
    if (matriculaIndex < 0 || emailIndex < 0) errors.push('As colunas obrigatórias são matricula e email. A coluna nome é opcional.');
    if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) errors.push('O cabeçalho contém colunas repetidas.');
    const contacts: StudentContact[] = [], seen = new Set<string>();
    if (matriculaIndex >= 0 && emailIndex >= 0) for (let i = 1; i < parsed.rows.length; i++) {
      const row = parsed.rows[i]; if (row.every(value => value === null || value === undefined || value === '')) continue;
      const rawMatricula = row[matriculaIndex], rawEmail = row[emailIndex], rawName = nameIndex >= 0 ? row[nameIndex] : '';
      const prefix = `Linha ${i + 1}: `;
      if (typeof rawMatricula !== 'string') { errors.push(prefix + 'a matrícula precisa estar como texto. No Excel, use o formato Texto para preservar zeros iniciais.'); continue; }
      const matricula = rawMatricula.trim(), email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
      const nome = rawName === null || rawName === undefined ? '' : typeof rawName === 'string' ? rawName.trim() : '';
      if (!matricula || matricula.length > 100 || /[\r\n\x00-\x1f]/.test(matricula)) { errors.push(prefix + 'matrícula inválida (até 100 caracteres, sem quebras de linha).'); continue; }
      if (!validEmail(email)) { errors.push(prefix + 'email inválido.'); continue; }
      if ((rawName && typeof rawName !== 'string') || nome.length > 150 || /[\r\n\x00-\x1f]/.test(nome)) { errors.push(prefix + 'nome inválido (até 150 caracteres).'); continue; }
      if (seen.has(matricula)) { errors.push(prefix + `matrícula ${matricula} repetida. Mantenha apenas uma linha por matrícula.`); continue; }
      seen.add(matricula); contacts.push({matricula, email, nome});
    }
    const old = new Map((await this.list()).contatos.map(value => [value.matricula, value]));
    for (const contact of contacts) {
      const before = old.get(contact.matricula);
      if (before && (before.email !== contact.email || before.nome !== contact.nome)) warnings.push(`Matrícula ${contact.matricula}: contato existente será atualizado (${before.email} → ${contact.email}).`);
    }
    const token = randomBytes(32).toString('base64url'), now = new Date(), expiry = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    // Store only validated previews. Invalid files cannot be partially imported.
    if (!errors.length && contacts.length) await this.db.run('INSERT INTO contacts_import_plans(token_hash,payload,expira_em,criado_em) VALUES(?,?,?,?)', sha256(token), JSON.stringify({contacts, fingerprint: await this.fingerprint(contacts)}), expiry, now.toISOString());
    else if (!contacts.length && !errors.length) errors.push('Nenhum contato válido encontrado.');
    return {token: errors.length ? '' : token, contatos: contacts, erros: errors, avisos: warnings, total: contacts.length, expira_em: expiry};
  }
  async import(token: unknown, confirmation: unknown): Promise<{message: string; total: number}> {
    if (confirmation !== 'sim' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BadRequestException('Revise a prévia e confirme a importação.');
    return this.db.transaction(async () => {
      const saved = await this.db.get<{payload: string; expira_em: string}>('SELECT payload,expira_em FROM contacts_import_plans WHERE token_hash=?', sha256(token));
      if (!saved || new Date(saved.expira_em).getTime() <= Date.now()) throw new BadRequestException('A prévia expirou ou já foi utilizada. Envie a planilha novamente.');
      const plan = JSON.parse(saved.payload) as {contacts: StudentContact[]; fingerprint: string};
      if (plan.fingerprint !== await this.fingerprint(plan.contacts)) throw new BadRequestException('Os contatos mudaram após a prévia. Envie a planilha novamente para revisar as alterações.');
      const now = new Date().toISOString();
      for (const contact of plan.contacts) await this.db.run(`INSERT INTO student_contacts(matricula,email,nome,atualizado_em) VALUES(?,?,?,?)
        ON CONFLICT(matricula) DO UPDATE SET email=excluded.email,nome=excluded.nome,atualizado_em=excluded.atualizado_em`, contact.matricula, contact.email, contact.nome, now);
      await this.db.run('DELETE FROM contacts_import_plans WHERE token_hash=?', sha256(token));
      return {message: `${plan.contacts.length} contatos importados.`, total: plan.contacts.length};
    });
  }
}
