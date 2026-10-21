import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { extname } from 'node:path';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { DatabaseService } from './database.service';
import { accountId, dataExpiry } from './account-context';
import type { StudentContact, ContactImportPreview } from '@enem/shared/src/reports';

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
    && !value.split('@')[0].startsWith('.') && !value.split('@')[0].endsWith('.') && !value.split('@')[0].includes('..');
}
function header(value: string) {
  const normalized = value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ');
  return ({'email academico': 'email', 'e mail': 'email', 'e mail academico': 'email', 'descricao do curso': 'curso', 'nome completo': 'nome'} as Record<string,string>)[normalized] || normalized;
}
function contactComparable(value?: StudentContact) { return value ? {matricula: value.matricula, email: value.email, nome: value.nome, curso: value.curso || ''} : null; }
@Injectable()
export class ContactsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  async list(): Promise<{contatos: StudentContact[]}> { return {contatos: await this.db.all<StudentContact>('SELECT matricula,email,nome,curso,atualizado_em,expira_em FROM student_contacts WHERE owner_id=? AND (expira_em IS NULL OR expira_em>?) ORDER BY matricula', accountId(), new Date().toISOString())}; }
  async get(matricula: string): Promise<StudentContact | undefined> { return this.db.get<StudentContact>('SELECT matricula,email,nome,curso,atualizado_em,expira_em FROM student_contacts WHERE matricula=? AND owner_id=? AND (expira_em IS NULL OR expira_em>?)', matricula, accountId(), new Date().toISOString()); }
  async update(original: string, raw: unknown): Promise<StudentContact> {
    // A matrícula da URL só identifica contatos da conta autenticada.
    if (!await this.get(original)) throw new NotFoundException('Contato não encontrado.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['matricula','email','nome','curso','atualizado_em'].includes(key))) throw new BadRequestException('Informe matrícula, email, nome e curso do contato.');
    const body = raw as Record<string, unknown>;
    for (const [field, label, max, required] of [['matricula','matrícula',100,true],['nome','nome',150,false],['curso','curso',150,false]] as const) {
      const value = body[field];
      if (typeof value !== 'string' || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value) || (required && !value.trim())) throw new BadRequestException(`Informe ${label} válido (até ${max} caracteres, sem quebras de linha).`);
    }
    if (typeof body.email !== 'string' || !validEmail(body.email.trim().toLowerCase())) throw new BadRequestException('Informe um email válido.');
    if (typeof body.atualizado_em !== 'string' || !body.atualizado_em || body.atualizado_em.length > 100 || /[\x00-\x1f\x7f]/.test(body.atualizado_em)) throw new BadRequestException('Atualize a lista e abra a edição novamente.');
    const contact = {matricula:(body.matricula as string).trim(), email:body.email.trim().toLowerCase(), nome:(body.nome as string).trim(), curso:(body.curso as string).trim()};
    try {
      return await this.db.transaction(async () => {
        if (this.db.dialect === 'postgres') await this.db.get('SELECT matricula FROM student_contacts WHERE owner_id=? AND matricula=? FOR UPDATE', accountId(), original);
        const before = await this.get(original);
        if (!before) throw new NotFoundException('Contato não encontrado.');
        if (before.atualizado_em !== body.atualizado_em) throw new ConflictException('Este contato foi alterado em outra aba ou importação. Feche a edição, atualize a lista e confira os novos dados.');
        if (contact.matricula !== original && await this.db.get('SELECT matricula FROM student_contacts WHERE owner_id=? AND matricula=?', accountId(), contact.matricula)) throw new ConflictException('Já existe um contato com esta matrícula na sua conta. Escolha outra matrícula.');
        if (JSON.stringify(contactComparable(before)) === JSON.stringify(contact)) return before;
        const now = new Date(Math.max(Date.now(), (Date.parse(before.atualizado_em!) || 0) + 1)).toISOString();
        const saved = await this.db.run(`UPDATE student_contacts SET matricula=?,email=?,nome=?,curso=?,atualizado_em=?
          WHERE owner_id=? AND matricula=? AND atualizado_em=? AND (expira_em IS NULL OR expira_em>?)`,
          contact.matricula, contact.email, contact.nome, contact.curso, now, accountId(), original, body.atualizado_em as string, new Date().toISOString());
        if (!saved.changes) throw new ConflictException('O contato mudou ou expirou. Atualize a lista antes de editar novamente.');
        return {...before, ...contact, atualizado_em:now};
      });
    } catch (error) {
      const failure = error as {code?:string;errcode?:number};
      if (failure.code === '23505' || failure.errcode === 1555 || failure.errcode === 2067) throw new ConflictException('Já existe um contato com esta matrícula na sua conta. Escolha outra matrícula.');
      throw error;
    }
  }
  template(): string { return '\uFEFFmatricula,email,nome,curso\r\n000123,aluno@example.com,Aluno de exemplo,Curso de exemplo\r\n'; }
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
    if (extension !== '.xlsx') throw new BadRequestException('Use uma planilha CSV ou XLSX com matrícula, email e nome/curso opcionais.');
    const book = new ExcelJS.Workbook();
    try { await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]); }
    catch { throw new BadRequestException('Não foi possível abrir a planilha XLSX.'); }
    const candidates = book.worksheets.filter(sheet => {
      const headers = Array.from({length: sheet.columnCount}, (_, i) => sheet.getRow(1).getCell(i + 1).value).map(value => typeof value === 'string' ? header(value) : '');
      return headers.includes('matricula') && headers.includes('email');
    });
    if (candidates.length > 1) throw new BadRequestException('Mais de uma aba contém matrícula e email. Mantenha apenas uma aba de contatos para evitar associações ambíguas.');
    if (!candidates.length && book.worksheets.length !== 1) throw new BadRequestException('Nenhuma aba contém as colunas Matrícula e Email/Email Acadêmico na primeira linha.');
    const sheet = candidates[0] || book.worksheets[0];
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
  async preview(buffer: Buffer, filename: string, skipMissingEmails = false): Promise<ContactImportPreview> {
    const parsed = await this.rows(buffer, filename), errors = [...parsed.errors], warnings: string[] = [];
    if (parsed.rows.length < 2) errors.push('Inclua o cabeçalho e pelo menos um contato.');
    if (parsed.rows.length > 10001) throw new BadRequestException('A planilha aceita até 10.000 contatos.');
    const headers = (parsed.rows[0] || []).map(value => typeof value === 'string' ? header(value) : '');
    const matriculaIndex = headers.indexOf('matricula'), emailIndex = headers.indexOf('email'), nameIndex = headers.indexOf('nome'), courseIndex = headers.indexOf('curso');
    if (matriculaIndex < 0 || emailIndex < 0) errors.push('As colunas obrigatórias são matricula e email. Nome e curso são opcionais.');
    if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) errors.push('O cabeçalho contém colunas repetidas.');
    const contacts: StudentContact[] = [], seen = new Set<string>();
    if (matriculaIndex >= 0 && emailIndex >= 0) for (let i = 1; i < parsed.rows.length; i++) {
      const row = parsed.rows[i]; if (row.every(value => value === null || value === undefined || value === '')) continue;
      const rawMatricula = row[matriculaIndex], rawEmail = row[emailIndex], rawName = nameIndex >= 0 ? row[nameIndex] : '';
      const prefix = `Linha ${i + 1}: `;
      if (skipMissingEmails && (rawEmail === null || rawEmail === undefined || (typeof rawEmail === 'string' && ['', '-', '—'].includes(rawEmail.trim())))) {
        warnings.push(prefix + 'sem email. Esta linha não será importada; contatos existentes não são removidos.'); continue;
      }
      if (typeof rawMatricula !== 'string') { errors.push(prefix + 'a matrícula precisa estar como texto. No Excel, use o formato Texto para preservar zeros iniciais.'); continue; }
      const matricula = rawMatricula.trim(), email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
      const nome = rawName === null || rawName === undefined ? '' : typeof rawName === 'string' ? rawName.trim() : '';
      const rawCourse = courseIndex >= 0 ? row[courseIndex] : '', curso = rawCourse === null || rawCourse === undefined ? '' : typeof rawCourse === 'string' ? rawCourse.trim() : '';
      if (!matricula || matricula.length > 100 || /[\r\n\x00-\x1f]/.test(matricula)) { errors.push(prefix + 'matrícula inválida (até 100 caracteres, sem quebras de linha).'); continue; }
      if (!validEmail(email)) { errors.push(prefix + 'email inválido.'); continue; }
      if ((rawName !== null && rawName !== undefined && typeof rawName !== 'string') || nome.length > 150 || /[\r\n\x00-\x1f]/.test(nome)) { errors.push(prefix + 'nome inválido (até 150 caracteres).'); continue; }
      if ((rawCourse !== null && rawCourse !== undefined && typeof rawCourse !== 'string') || curso.length > 150 || /[\r\n\x00-\x1f]/.test(curso)) { errors.push(prefix + 'curso inválido (até 150 caracteres).'); continue; }
      if (seen.has(matricula)) { errors.push(prefix + `matrícula ${matricula} repetida. Mantenha apenas uma linha por matrícula.`); continue; }
      seen.add(matricula); contacts.push({matricula, email, nome, curso});
    }
    const old = new Map((await this.list()).contatos.map(value => [value.matricula, value]));
    for (const contact of contacts) {
      const before = old.get(contact.matricula);
      if (courseIndex < 0) contact.curso = before?.curso || '';
      if (before && (before.email !== contact.email || before.nome !== contact.nome || (before.curso || '') !== contact.curso)) warnings.push(`Matrícula ${contact.matricula}: contato existente será atualizado. Confira email, nome e curso na tabela (${before.email} → ${contact.email}).`);
    }
    const token = randomBytes(32).toString('base64url'), now = new Date(), expiry = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    // Store only validated previews. Invalid files cannot be partially imported.
    if (!errors.length && contacts.length) await this.db.run('INSERT INTO contacts_import_plans(owner_id,token_hash,payload,expira_em,criado_em) VALUES(?,?,?,?,?)', accountId(), sha256(token), JSON.stringify({contacts, fingerprint: await this.fingerprint(contacts)}), expiry, now.toISOString());
    else if (!contacts.length && !errors.length) errors.push('Nenhum contato válido encontrado.');
    return {token: errors.length ? '' : token, contatos: contacts, erros: errors, avisos: warnings, total: contacts.length, expira_em: expiry};
  }
  async import(token: unknown, confirmation: unknown): Promise<{message: string; total: number}> {
    if (confirmation !== 'sim' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BadRequestException('Revise a prévia e confirme a importação.');
    return this.db.transaction(async () => {
      const saved = await this.db.get<{payload: string; expira_em: string}>('SELECT payload,expira_em FROM contacts_import_plans WHERE token_hash=? AND owner_id=?', sha256(token), accountId());
      if (!saved || new Date(saved.expira_em).getTime() <= Date.now()) throw new BadRequestException('A prévia expirou ou já foi utilizada. Envie a planilha novamente.');
      const plan = JSON.parse(saved.payload) as {contacts: StudentContact[]; fingerprint: string};
      if (plan.fingerprint !== await this.fingerprint(plan.contacts)) throw new BadRequestException('Os contatos mudaram após a prévia. Envie a planilha novamente para revisar as alterações.');
      const now = new Date().toISOString();
      for (const contact of plan.contacts) await this.db.run(`INSERT INTO student_contacts(matricula,email,nome,curso,atualizado_em,owner_id,expira_em) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(owner_id,matricula) DO UPDATE SET email=excluded.email,nome=excluded.nome,curso=excluded.curso,atualizado_em=excluded.atualizado_em,expira_em=excluded.expira_em`, contact.matricula, contact.email, contact.nome, contact.curso || '', now, accountId(), dataExpiry());
      await this.db.run('DELETE FROM contacts_import_plans WHERE token_hash=? AND owner_id=?', sha256(token), accountId());
      return {message: `${plan.contacts.length} contatos importados.`, total: plan.contacts.length};
    });
  }
}
