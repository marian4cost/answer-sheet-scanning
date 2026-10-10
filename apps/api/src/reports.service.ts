import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import type { AnswerKey, ReadingStatus, ThemeScore } from '@enem/shared';
import type { StudentReport, EssayFeedback, ReportArea, ReportList, DeliveryPlan, DeliveryResult, ReportDelivery } from '@enem/shared/src/reports';
import { DatabaseService } from './database.service';
import { SimuladosService } from './simulados.service';
import { ContactsService, sha256, validEmail } from './contacts.service';
import { grade } from './grading';
import { assetPath } from './assets';

const AREA_NAMES = ['Linguagens', 'Ciências da Natureza', 'Matemática', 'Ciências Humanas'];
const INSTITUTION = () => process.env.REPORT_INSTITUTION || 'Instituto Federal de Sergipe - Campus Lagarto';
type PlanRecord = {resultado_id: number; matricula: string; nome: string; email: string; nota_percentual: number; content_hash: string};
type DeliveryRow = {id: number; resultado_id: number; destinatario: string; status: ReportDelivery['status']; content_hash: string; message_id: string; erro: string};
export function escapeHtml(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!)); }
function plain(value: string): string { return value.replace(/[\u2010-\u2015]/g, '-').replace(/\x00/g, ''); }
function canonicalArea(theme: string): string | undefined {
  const normalized = theme.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/(linguage|literatura|portugues|ingles|espanhol|artes|educacao fisica)/.test(normalized)) return AREA_NAMES[0];
  if (/(natureza|fisica|quimica|biologia)/.test(normalized)) return AREA_NAMES[1];
  if (/(matematica)/.test(normalized)) return AREA_NAMES[2];
  if (/(humana|historia|geografia|sociologia|filosofia)/.test(normalized)) return AREA_NAMES[3];
  return undefined;
}
function areasFromThemes(themes: ThemeScore[], status: ReadingStatus): ReportArea[] {
  return AREA_NAMES.map(area => {
    const rows = themes.filter(theme => canonicalArea(theme.tema) === area);
    const totals = rows.reduce((sum, theme) => ({total_questoes: sum.total_questoes + theme.total_questoes,
      total_acertos: sum.total_acertos + theme.total_acertos, total_erros: sum.total_erros + theme.total_erros,
      total_rasuras: sum.total_rasuras + theme.total_rasuras, total_brancos: sum.total_brancos + theme.total_brancos,
      total_incertas: sum.total_incertas + theme.total_incertas}), {total_questoes: 0, total_acertos: 0, total_erros: 0, total_rasuras: 0, total_brancos: 0, total_incertas: 0});
    const score = totals.total_questoes ? Math.round(totals.total_acertos / totals.total_questoes * 10000) / 100 : 0;
    return {area, ...totals, nota_percentual: score, nota: !totals.total_questoes || status === 'ERRO_LEITURA' ? null : score};
  });
}
export function reportHtml(report: StudentReport): string {
  const themeRows = report.temas.map(theme => `<tr><td style="padding:8px;border-bottom:1px solid #e2e8f0">${escapeHtml(theme.tema)}</td><td>${theme.total_acertos}/${theme.total_questoes}</td><td>${theme.nota_percentual}%</td></tr>`).join('');
  return `<!doctype html><html lang="pt-BR"><body style="font:15px Arial,sans-serif;color:#172033"><main style="max-width:680px;margin:24px auto"><p style="color:#2563eb">${escapeHtml(INSTITUTION())}</p><h1>Boletim do simulado</h1><h2>${escapeHtml(report.titulo)}</h2><p>Olá, ${escapeHtml(report.nome)}.</p><p>Matrícula: <strong>${escapeHtml(report.matricula)}</strong></p><p>Seu desempenho objetivo foi <strong>${report.geral.nota_percentual}%</strong> (${report.geral.total_acertos} de ${report.total_questoes} questões).</p><table style="width:100%;text-align:left"><thead><tr><th>Tema</th><th>Acertos</th><th>Desempenho</th></tr></thead><tbody>${themeRows}</tbody></table><h3>Redação - avaliação manual</h3><p>Nota: ${report.redacao.nota_redacao === null ? 'Não informada' : report.redacao.nota_redacao + ' / 1000'}</p><p style="white-space:pre-wrap">${escapeHtml(report.redacao.feedback_redacao || 'Feedback ainda não informado pelo professor.')}</p><p>O boletim completo está no PDF em anexo.</p><p style="font-size:12px;color:#64748b">${escapeHtml(report.metodologia)}</p></main></body></html>`;
}

@Injectable()
export class ReportEmailGateway {
  availability(): {envio_disponivel: boolean; envio_motivo: string} {
    const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || '';
    const fromAddress = from.match(/<([^<>]+)>$/)?.[1] || from;
    if (!validEmail(fromAddress)) return {envio_disponivel: false, envio_motivo: 'Configure EMAIL_FROM com um remetente válido e autorizado.'};
    if (process.env.RESEND_API_KEY) return {envio_disponivel: true, envio_motivo: 'Envio configurado por Resend.'};
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return {envio_disponivel: true, envio_motivo: 'Envio configurado por SMTP.'};
    return {envio_disponivel: false, envio_motivo: 'Configure SMTP_HOST/SMTP_USER/SMTP_PASS ou RESEND_API_KEY para enviar boletins.'};
  }
  async deliver(report: StudentReport, pdf: Buffer, idempotencyKey: string): Promise<string> {
    const state = this.availability(); if (!state.envio_disponivel) throw new ServiceUnavailableException(state.envio_motivo);
    const from = process.env.EMAIL_FROM || process.env.SMTP_FROM!;
    const subject = `Boletim - ${report.titulo}`.replace(/[\r\n]/g, ' ');
    const filename = `Boletim_${report.matricula.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
    if (process.env.RESEND_API_KEY) {
      const response = await fetch('https://api.resend.com/emails', {method: 'POST', headers: {Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey},
        body: JSON.stringify({from, to: [report.email], subject, html: reportHtml(report), attachments: [{filename, content: pdf.toString('base64')}]}), signal: AbortSignal.timeout(30000)});
      const body = await response.json() as {id?: string; message?: string};
      if (!response.ok || !body.id) throw new Error('O provedor não confirmou o envio. Consulte o painel de emails antes de tentar novamente.');
      return body.id;
    }
    const port = Number(process.env.SMTP_PORT || 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ServiceUnavailableException('SMTP_PORT inválida.');
    const transport = nodemailer.createTransport({host: process.env.SMTP_HOST!, port, secure: process.env.SMTP_SECURE === 'true' || port === 465,
      requireTLS: process.env.SMTP_SECURE !== 'true' && port !== 465,
      auth: {user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS!}, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000});
    try {
      const result = await transport.sendMail({from, to: report.email!, subject, html: reportHtml(report), attachments: [{filename, content: pdf, contentType: 'application/pdf'}]});
      if (!result.accepted?.length) throw new Error('O servidor de email não confirmou o destinatário.');
      return result.messageId;
    } finally { transport.close(); }
  }
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(SimuladosService) private readonly simulados: SimuladosService,
    @Inject(ContactsService) private readonly contacts: ContactsService, @Inject(ReportEmailGateway) private readonly email: ReportEmailGateway) {}
  async report(id: number): Promise<StudentReport> {
    const {resultado, simulado} = await this.simulados.result(id);
    const contact = await this.contacts.get(resultado.matricula);
    const feedback = await this.db.get<EssayFeedback>('SELECT nota_redacao,feedback_redacao,atualizado_em FROM report_feedback WHERE resultado_id=?', id);
    const redacao: EssayFeedback = feedback ? {...feedback, nota_redacao: feedback.nota_redacao === null ? null : Number(feedback.nota_redacao)} : {nota_redacao: null, feedback_redacao: ''};
    const pending: string[] = [], warnings: string[] = [];
    if (!contact?.email) pending.push('Nenhum email associado a esta matrícula. Importe a planilha de contatos.');
    else if (!validEmail(contact.email)) pending.push('O email associado à matrícula é inválido. Revise a planilha de contatos.');
    if (resultado.status === 'ERRO_LEITURA') pending.push('A leitura do cartão falhou. Reenvie uma imagem legível antes de enviar o boletim.');
    if (resultado.status === 'ALERTA_REVISAO' || resultado.total_incertas || Object.values(resultado.respostas_detectadas).includes('INC')) pending.push('Existem respostas incertas que precisam de revisão antes do envio.');
    const invalid = Array.from({length: simulado.total_questoes}, (_, i) => String(i + 1)).filter(q => !['A', 'B', 'C', 'D', 'E', 'BNK', 'RAS', 'INC'].includes(resultado.respostas_detectadas[q]));
    if (invalid.length && resultado.status !== 'ERRO_LEITURA') pending.push('O resultado não contém uma leitura válida de todas as questões.');
    const invalidKey = Array.from({length: simulado.total_questoes}, (_, i) => String(i + 1)).filter(q => !['A', 'B', 'C', 'D', 'E'].includes(resultado.gabarito_do_envio[q]));
    if (invalidKey.length) pending.push('A chave histórica de correção não está completa. Revise o envio antes de emitir o boletim.');
    if (redacao.nota_redacao === null) warnings.push('A nota da redação ainda não foi informada pelo professor.');
    if (!redacao.feedback_redacao) warnings.push('O feedback da redação ainda não foi informado pelo professor.');
    if (!simulado.temas.length) warnings.push('Configure os intervalos por área no simulado para preencher as áreas do boletim.');
    const unknown = resultado.desempenho_temas.filter(theme => !canonicalArea(theme.tema));
    if (unknown.length) warnings.push('Temas apresentados separadamente, sem associação automática a uma área: ' + unknown.map(theme => theme.tema).join(', ') + '.');
    const score = grade(resultado.respostas_detectadas, resultado.gabarito_do_envio, resultado.status, simulado.total_questoes);
    const report: StudentReport = {resultado_id: id, simulado_id: simulado.id, titulo: simulado.titulo, matricula: resultado.matricula,
      nome: contact?.nome || `Aluno ${resultado.matricula}`, email: contact?.email || null, total_questoes: simulado.total_questoes,
      status: resultado.status, geral: score, temas: resultado.desempenho_temas, areas: areasFromThemes(resultado.desempenho_temas, resultado.status),
      redacao, gerado_em: new Date().toISOString(), apto_envio: !pending.length, pendencias: pending, avisos: warnings,
      modelo: 'provisorio', metodologia: 'Desempenho objetivo = acertos / questões da área × 100. Este boletim não calcula a TRI do ENEM. A redação é avaliada manualmente pelo professor.', content_hash: ''};
    // Include the source answers/key and all visible fields, but not the generation timestamp.
    const {gerado_em, content_hash, ...stable} = report;
    report.content_hash = sha256(JSON.stringify({report: {...stable, redacao: {nota_redacao: redacao.nota_redacao, feedback_redacao: redacao.feedback_redacao}}, respostas: resultado.respostas_detectadas, gabarito: resultado.gabarito_do_envio, institution: INSTITUTION()}));
    return report;
  }
  async list(simuladoId: number): Promise<ReportList> {
    const data = await this.simulados.results(simuladoId);
    const rows = await Promise.all(data.resultados.map(row => this.report(row.id)));
    return {simulado_id: simuladoId, titulo: data.simulado.titulo, total: rows.length, ...this.email.availability(),
      alunos: rows.map(row => ({resultado_id: row.resultado_id, matricula: row.matricula, nome: row.nome, email: row.email,
        nota_percentual: row.status === 'ERRO_LEITURA' ? null : row.geral.nota_percentual, status: row.status, pendencias: row.pendencias,
        avisos: row.avisos, apto_envio: row.apto_envio, redacao: row.redacao, temas: row.temas}))};
  }
  async saveEssay(id: number, raw: unknown): Promise<StudentReport> {
    await this.simulados.result(id);
    if (!raw || typeof raw !== 'object') throw new BadRequestException('Informe a nota e o feedback da redação.');
    const body = raw as {nota_redacao?: unknown; feedback_redacao?: unknown};
    const note = body.nota_redacao === undefined || body.nota_redacao === '' ? null : body.nota_redacao;
    if (note !== null && (typeof note !== 'number' || !Number.isFinite(note) || note < 0 || note > 1000)) throw new BadRequestException('A nota da redação deve ser um número entre 0 e 1000, ou vazia.');
    const feedback = body.feedback_redacao === undefined ? '' : body.feedback_redacao;
    if (typeof feedback !== 'string' || feedback.length > 10000 || feedback.includes('\x00')) throw new BadRequestException('O feedback deve ter até 10.000 caracteres.');
    await this.db.run(`INSERT INTO report_feedback(resultado_id,nota_redacao,feedback_redacao,atualizado_em) VALUES(?,?,?,?)
      ON CONFLICT(resultado_id) DO UPDATE SET nota_redacao=excluded.nota_redacao,feedback_redacao=excluded.feedback_redacao,atualizado_em=excluded.atualizado_em`, id, note, feedback.trim(), new Date().toISOString());
    return this.report(id);
  }
  async pdf(reportOrId: number | StudentReport): Promise<Buffer> {
    const report = typeof reportOrId === 'number' ? await this.report(reportOrId) : reportOrId;
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({size: 'A4', margin: 46, bufferPages: true, info: {Title: `Boletim - ${plain(report.titulo)}`, Author: plain(INSTITUTION())}});
      doc.registerFont('ReportRegular', assetPath('report-fonts/OpenSans-Regular.ttf'));
      doc.registerFont('ReportBold', assetPath('report-fonts/OpenSans-Bold.ttf'));
      const buffers: Buffer[] = []; doc.on('data', buffer => buffers.push(buffer)); doc.on('end', () => resolve(Buffer.concat(buffers))); doc.on('error', reject);
      const width = doc.page.width - 92;
      const ensure = (height: number) => { if (doc.y + height > doc.page.height - 70) doc.addPage(); };
      const paragraph = (text: string, size = 10, color = '#475569') => {
        doc.font('ReportRegular').fontSize(size).fillColor(color);
        const height = doc.heightOfString(plain(text), {width}); ensure(height + 12);
        doc.text(plain(text), 46, doc.y, {width, lineGap: 3}).moveDown(.55);
      };
      const heading = (text: string) => { ensure(34); doc.font('ReportBold').fontSize(12).fillColor('#172033').text(plain(text), 46, doc.y, {width}).moveDown(.6); };
      doc.rect(0, 0, doc.page.width, 12).fill('#2563eb');
      paragraph(INSTITUTION(), 10, '#2563eb');
      doc.font('ReportBold').fontSize(25).fillColor('#172033').text('Boletim do aluno', {width}).moveDown(.35);
      paragraph(report.titulo, 13, '#172033');
      paragraph(`${report.nome}\nMatrícula: ${report.matricula}`, 11, '#172033');
      paragraph('Modelo provisório - aguardando o modelo final do boletim.', 9);
      heading('Desempenho geral');
      const failed = report.status === 'ERRO_LEITURA', provisional = report.status === 'ALERTA_REVISAO';
      paragraph(failed ? 'Leitura pendente - sem nota válida.' : `${report.geral.nota_percentual}%${provisional ? ' (provisório)' : ''} - ${report.geral.total_acertos} de ${report.total_questoes} questões corretas.`, 16, '#2563eb');
      if (!failed) paragraph(`Erros: ${report.geral.total_erros}  |  Em branco: ${report.geral.total_brancos}  |  Marcações duplas: ${report.geral.total_rasuras}  |  Incertas: ${report.geral.total_incertas}`, 9);
      heading('Áreas de conhecimento');
      for (const area of report.areas) {
        ensure(56);
        const y = doc.y;
        doc.font('ReportBold').fontSize(10).fillColor('#172033').text(area.area, 46, y, {width: width - 75});
        doc.font('ReportRegular').fillColor('#475569').text(area.nota === null ? (area.total_questoes ? 'Pendente' : 'Sem questões') : `${area.nota}%`, 46 + width - 75, y, {width: 75, align: 'right'});
        doc.roundedRect(46, y + 18, width, 5, 2).fill('#e2e8f0');
        if (area.nota !== null && area.nota > 0) doc.roundedRect(46, y + 18, width * area.nota / 100, 5, 2).fill('#2563eb');
        doc.y = y + 29;
        paragraph(area.total_questoes ? `${area.total_acertos}/${area.total_questoes} acertos - ${area.total_brancos} em branco - ${area.total_rasuras} duplas` : 'Nenhum intervalo foi associado a esta área.', 8);
      }
      if (report.temas.length) {
        heading('Detalhamento por tema');
        for (const theme of report.temas) paragraph(`${theme.tema}: ${failed ? 'leitura pendente' : `${theme.nota_percentual}% - ${theme.total_acertos}/${theme.total_questoes} acertos`}`, 9);
      }
      heading('Redação - avaliação manual');
      paragraph('Nota: ' + (report.redacao.nota_redacao === null ? 'não informada pelo professor' : report.redacao.nota_redacao + ' / 1000'), 11, '#172033');
      paragraph(report.redacao.feedback_redacao || 'Feedback ainda não informado pelo professor.', 10);
      if (report.pendencias.length) { heading('Pendências'); for (const message of report.pendencias) paragraph(message, 9, '#b45309'); }
      if (report.avisos.length) { heading('Observações'); for (const message of report.avisos) paragraph(message, 9); }
      paragraph(report.metodologia, 8);
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i); const y = doc.page.height - 42;
        // Footers sit below the text margin; disable pagination only while drawing them.
        const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
        doc.font('ReportRegular').fontSize(8).fillColor('#64748b').text(`Matrícula ${plain(report.matricula)} | Boletim ${report.resultado_id}`, 46, y, {width: width - 55, lineBreak: false});
        doc.text(`${i + 1}/${range.count}`, 46 + width - 50, y, {width: 50, align: 'right', lineBreak: false});
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    });
  }
  async plan(simuladoId: number, rawIds: unknown): Promise<DeliveryPlan> {
    await this.simulados.get(simuladoId);
    if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 500 || rawIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(rawIds).size !== rawIds.length) throw new BadRequestException('Selecione de 1 a 500 boletins distintos.');
    const reports = await Promise.all(rawIds.map(id => this.report(id as number)));
    if (reports.some(report => report.simulado_id !== simuladoId)) throw new BadRequestException('Há um boletim de outro simulado na seleção.');
    const blocked = reports.filter(report => !report.apto_envio);
    if (blocked.length) throw new BadRequestException('Resolva as pendências antes de planejar o envio: ' + blocked.map(report => `${report.matricula} (${report.pendencias.join(' ')})`).join('; '));
    const token = randomBytes(32).toString('base64url'), now = new Date(), expiry = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const rows: PlanRecord[] = reports.map(report => ({resultado_id: report.resultado_id, matricula: report.matricula, nome: report.nome, email: report.email!, nota_percentual: report.geral.nota_percentual, content_hash: report.content_hash}));
    await this.db.run('INSERT INTO report_delivery_plans(token_hash,simulado_id,payload,expira_em,criado_em) VALUES(?,?,?,?,?)', sha256(token), simuladoId, JSON.stringify(rows), expiry, now.toISOString());
    return {token, simulado_id: simuladoId, alunos: rows, total: rows.length, expira_em: expiry, ...this.email.availability()};
  }
  async send(simuladoId: number, token: unknown, confirmation: unknown): Promise<DeliveryResult> {
    if (confirmation !== 'sim' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BadRequestException('Revise os destinatários e confirme o envio.');
    const availability = this.email.availability();
    if (!availability.envio_disponivel) throw new ServiceUnavailableException(availability.envio_motivo);
    // Validate every record before reserving or sending any email. Persisted reservations prevent duplicate sends after retries/restarts.
    const reserved = await this.db.transaction(async () => {
      const saved = await this.db.get<{simulado_id: number; payload: string; expira_em: string}>('SELECT simulado_id,payload,expira_em FROM report_delivery_plans WHERE token_hash=?', sha256(token));
      if (!saved || saved.simulado_id !== simuladoId || new Date(saved.expira_em).getTime() <= Date.now()) throw new BadRequestException('O plano de envio expirou ou é inválido. Revise um novo plano.');
      const rows = JSON.parse(saved.payload) as PlanRecord[];
      const reports = await Promise.all(rows.map(row => this.report(row.resultado_id)));
      if (reports.some((report, i) => report.simulado_id !== simuladoId || !report.apto_envio || report.content_hash !== rows[i].content_hash || report.email !== rows[i].email || report.matricula !== rows[i].matricula)) throw new BadRequestException('O boletim, a redação ou o contato mudou após a prévia. Revise um novo plano antes de enviar.');
      const entries: Array<{report: StudentReport; row: DeliveryRow; fresh: boolean}> = [];
      for (const report of reports) {
        const result = await this.db.run(`INSERT INTO report_deliveries(resultado_id,destinatario,status,content_hash,message_id,erro,criado_em) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(resultado_id,destinatario,content_hash) DO NOTHING`, report.resultado_id, report.email!, 'ENVIANDO', report.content_hash, '', '', new Date().toISOString());
        const row = await this.db.get<DeliveryRow>('SELECT * FROM report_deliveries WHERE resultado_id=? AND destinatario=? AND content_hash=?', report.resultado_id, report.email!, report.content_hash);
        if (!row) throw new Error('Falha ao registrar a entrega.');
        entries.push({report, row, fresh: result.changes > 0});
      }
      return entries;
    });
    const results: ReportDelivery[] = []; let sent = 0, ignored = 0;
    for (const {report, row, fresh} of reserved) {
      if (!fresh) { ignored++; results.push({resultado_id: row.resultado_id, matricula: report.matricula, email: row.destinatario, status: row.status, message_id: row.message_id, erro: row.erro}); continue; }
      let messageId = '';
      try {
        const pdf = await this.pdf(report);
        messageId = await this.email.deliver(report, pdf, `boletim-${report.resultado_id}-${report.content_hash}`);
        await this.db.run('UPDATE report_deliveries SET status=?,message_id=?,erro=? WHERE id=?', 'ENVIADO', messageId, '', row.id);
        sent++; results.push({resultado_id: report.resultado_id, matricula: report.matricula, email: report.email!, status: 'ENVIADO', message_id: messageId, erro: ''});
      } catch {
        const error = messageId ? 'O provedor confirmou a mensagem, mas o registro local falhou. Não reenvie automaticamente; confira o provedor.' : 'Não foi possível confirmar a entrega. Confira o provedor de email antes de tentar um novo envio; uma mensagem pode ter sido aceita.';
        try { await this.db.run('UPDATE report_deliveries SET status=?,message_id=?,erro=? WHERE id=?', 'AMBIGUO', messageId, error, row.id); } catch { /* ENVIANDO remains a durable lock if the database is unavailable. */ }
        results.push({resultado_id: report.resultado_id, matricula: report.matricula, email: report.email!, status: 'AMBIGUO', message_id: messageId, erro: error});
      }
    }
    return {total_enviados: sent, total_ignorados: ignored, resultados: results};
  }
  async deliveries(simuladoId: number) {
    await this.simulados.get(simuladoId);
    return {entregas: await this.db.all<DeliveryRow & {matricula: string; criado_em: string}>(`SELECT d.*,r.matricula FROM report_deliveries d JOIN core_resultadoaluno r ON r.id=d.resultado_id
      JOIN core_lotecorrecao l ON l.id=r.lote_id WHERE l.simulado_id=? ORDER BY d.criado_em DESC,d.id DESC`, simuladoId)};
  }
}
