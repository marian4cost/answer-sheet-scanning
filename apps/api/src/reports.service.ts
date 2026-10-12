import { BadRequestException, Inject, Injectable, ServiceUnavailableException, Optional, GoneException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { ReadingStatus, ThemeScore } from '@enem/shared';
import type { StudentReport, EssayFeedback, ReportArea, ReportList, DeliveryPlan, DeliveryResult, ReportDelivery, ReportQuestion, ReportPriority } from '@enem/shared/src/reports';
import { DatabaseService } from './database.service';
import { SimuladosService } from './simulados.service';
import { ContactsService, sha256, validEmail } from './contacts.service';
import { grade } from './grading';
import { renderReportPdf } from './reports.pdf';
import { EmailJsService } from './emailjs.service';
import { ProofImportService } from './proof-import.service';
import { accountId, withAccount } from './account-context';

const AREA_NAMES = ['Linguagens', 'Ciências da Natureza', 'Matemática', 'Ciências Humanas'];
const INSTITUTION = () => process.env.REPORT_INSTITUTION || 'Instituto Federal de Sergipe - Campus Lagarto';
type PlanRecord = {resultado_id: number; matricula: string; nome: string; email: string; nota_percentual: number; content_hash: string};
type AccessRow = {token_hash: string; delivery_id: number; operation_hash: string; criado_em: string; expira_em: string; ativado_em: string | null; revogado_em: string | null};
type ReissuePlan = {modo: 'reemitir'; delivery_id: number; original_content_hash: string; original_destinatario: string; original_operation_hash: string; report: PlanRecord};
export type PublicStudentReport = Omit<StudentReport, 'resultado_id' | 'simulado_id' | 'email' | 'content_hash' | 'apto_envio' | 'pendencias' | 'avisos'>;
export interface PublicReportAccess {boletim: PublicStudentReport; instituicao: string; expira_em: string}
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_ACCESS_MESSAGE = 'Este link de boletim expirou, foi substituído ou é inválido. Solicite um novo link ao professor.';
function linkTtl() {
  const days = Number(process.env.REPORT_LINK_TTL_DAYS || 7);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new ServiceUnavailableException('O prazo de acesso aos boletins deve estar entre 1 e 30 dias.');
  return days * 86400_000;
}
function accessUrl(token: string) {
  const base = process.env.WEB_URL || (process.env.CORS_ORIGINS || '').split(',')[0] || (!process.env.VERCEL ? 'http://localhost:' + (process.env.WEB_PORT || 3000) : '');
  let url: URL;
  try { url = new URL('/boletim', base); } catch { throw new ServiceUnavailableException('Configure WEB_URL para emitir os links dos boletins.'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new ServiceUnavailableException('WEB_URL deve usar HTTPS ou o endereço local do projeto.');
  url.hash = token;
  return url.toString();
}
export function reportLinkHtml(url: string, expiry: string) {
  let link: URL;
  try { link = new URL(url); } catch { throw new BadRequestException('Link de boletim inválido.'); }
  if (link.pathname !== '/boletim' || link.search || !ACCESS_TOKEN_PATTERN.test(link.hash.slice(1)) || link.username || link.password || (link.protocol !== 'https:' && !(link.protocol === 'http:' && ['localhost','127.0.0.1'].includes(link.hostname)))) throw new BadRequestException('Link de boletim inválido.');
  const date = new Intl.DateTimeFormat('pt-BR', {dateStyle:'short',timeStyle:'short',timeZone:'America/Fortaleza'}).format(new Date(expiry));
  return `<!doctype html><html lang="pt-BR"><body style="font:16px Arial,sans-serif;color:#172033;line-height:1.6"><p>Olá,</p><p>O professor responsável disponibilizou seu boletim do simulado ENEM no sistema de correção do ${escapeHtml(INSTITUTION())}.</p><p>Você pode consultar o resultado e baixar o PDF neste endereço:</p><p><a href="${escapeHtml(url)}">${escapeHtml(link.origin)}/boletim</a></p><p>Este acesso individual é válido até ${escapeHtml(date)}. Não compartilhe o link, pois ele permite consultar seu boletim.</p><p>Se tiver dúvidas sobre a avaliação ou precisar de um novo acesso, responda a este e-mail.</p><p>Equipe de simulados ENEM<br>${escapeHtml(INSTITUTION())}</p></body></html>`;
}
export function reportLinkText(url:string,expiry:string) {
  reportLinkHtml(url,expiry); // Mesma validação de URL aplicada às duas versões.
  const date = new Intl.DateTimeFormat('pt-BR', {dateStyle:'short',timeStyle:'short',timeZone:'America/Fortaleza'}).format(new Date(expiry));
  return `Olá,\n\nO professor responsável disponibilizou seu boletim do simulado ENEM no sistema de correção do ${INSTITUTION()}.\n\nConsulte o resultado e baixe o PDF: ${url}\n\nEste acesso individual é válido até ${date}. Não compartilhe o link.\n\nSe tiver dúvidas sobre a avaliação ou precisar de um novo acesso, responda a este e-mail.\n\nEquipe de simulados ENEM\n${INSTITUTION()}`;
}

type DeliveryRow = {id: number; resultado_id: number; destinatario: string; status: ReportDelivery['status']; content_hash: string; message_id: string; erro: string};
type ReservedDelivery = {report: StudentReport; row: DeliveryRow; fresh: boolean; url?: string; expiry?: string; operationHash?: string; planHash?: string};
export function escapeHtml(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!)); }
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
    const note = !totals.total_questoes || status === 'ERRO_LEITURA' ? null : score;
    return {area, ...totals, nota_percentual: score, nota: note, nota_dez: note === null ? null : Math.round(totals.total_acertos / totals.total_questoes * 1000) / 100};
  });
}
export function reportHtml(report: StudentReport, attachment = true): string {
  const areaRows = report.areas.map(area => `<tr><td style="padding:8px;border-bottom:1px solid #e2e8f0">${escapeHtml(area.area)}</td><td>${area.total_acertos}/${area.total_questoes}</td><td>${area.nota_dez === null ? (area.total_questoes ? 'Pendente' : 'Sem questões') : area.nota_dez.toLocaleString('pt-BR',{minimumFractionDigits:2}) + ' / 10'}</td></tr>`).join('');
  const overall = report.nota_geral_dez === null ? 'Pendente' : report.nota_geral_dez.toLocaleString('pt-BR',{minimumFractionDigits:2}) + ' / 10';
  const priorities = attachment ? '' : `<h3>Prioridades de revisão</h3>${report.prioridades.map(p => `<p><strong>${escapeHtml(p.area)}</strong>: incorretas ${p.incorretas.join(', ') || 'nenhuma'}; em branco ${p.brancos.join(', ') || 'nenhuma'}; marcações duplas ${p.duplas.join(', ') || 'nenhuma'}; incertas ${p.incertas.join(', ') || 'nenhuma'}.</p>`).join('')}`;
  const detail = attachment ? '<p>O boletim completo está no PDF em anexo.</p>' : `<h3>Questões</h3><table style="width:100%;text-align:left"><thead><tr><th>Questão</th><th>Área/tema</th><th>Resposta</th><th>Gabarito</th><th>Resultado</th></tr></thead><tbody>${report.questoes.map(q => `<tr><td>${q.numero}</td><td>${escapeHtml(q.tema)}</td><td>${escapeHtml(q.resposta)}</td><td>${escapeHtml(q.gabarito)}</td><td>${escapeHtml(q.resultado)}</td></tr>`).join('')}</tbody></table><p>O professor pode fornecer a versão em PDF pelo site.</p>`;
  return `<!doctype html><html lang="pt-BR"><body style="font:15px Arial,sans-serif;color:#172033"><main style="max-width:680px;margin:24px auto"><p style="color:#2563eb">${escapeHtml(INSTITUTION())}</p><h1>Boletim individual</h1><h2>${escapeHtml(report.titulo)}</h2><p>Olá, ${escapeHtml(report.nome)}.</p><p>Matrícula: <strong>${escapeHtml(report.matricula)}</strong> | Curso: ${escapeHtml(report.curso || 'Não informado')}</p><p>Nota objetiva: <strong>${overall}</strong> (${report.geral.total_acertos} de ${report.total_questoes} questões).</p><table style="width:100%;text-align:left"><thead><tr><th>Área</th><th>Acertos</th><th>Nota</th></tr></thead><tbody>${areaRows}</tbody></table><h3>Leitura do resultado</h3><p>${escapeHtml(report.interpretacao)}</p>${priorities}<h3>Redação - avaliação manual</h3><p>Nota: ${report.redacao.nota_redacao === null ? 'Não informada' : report.redacao.nota_redacao + ' / 1000'}</p><p style="white-space:pre-wrap">${escapeHtml(report.redacao.feedback_redacao || 'Feedback ainda não informado pelo professor.')}</p>${detail}<p style="font-size:12px;color:#64748b">${escapeHtml(report.metodologia)}</p></main></body></html>`;
}

@Injectable()
export class ReportEmailGateway {
  constructor(@Optional() @Inject(EmailJsService) private readonly emailjs?: EmailJsService) {}
  availability(): {envio_disponivel: boolean; envio_motivo: string} {
    if (this.emailjs?.configured()) return {envio_disponivel:true, envio_motivo:'Envio configurado por EmailJS. Mensagem com link temporário; boletim e PDF disponíveis no site.'};
    const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || '';
    const fromAddress = from.match(/<([^<>]+)>$/)?.[1] || from;
    if (!validEmail(fromAddress)) return {envio_disponivel: false, envio_motivo: 'Configure EMAIL_FROM com um remetente válido e autorizado.'};
    if (process.env.RESEND_API_KEY) return {envio_disponivel: true, envio_motivo: 'Envio configurado por Resend.'};
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return {envio_disponivel: true, envio_motivo: 'Envio configurado por SMTP.'};
    return {envio_disponivel: false, envio_motivo: 'Configure SMTP_HOST/SMTP_USER/SMTP_PASS ou RESEND_API_KEY para enviar boletins.'};
  }
  async deliver(report: StudentReport, url: string, idempotencyKey: string, expiry = new Date(Date.now() + linkTtl()).toISOString()): Promise<string> {
    const state = this.availability(); if (!state.envio_disponivel) throw new ServiceUnavailableException(state.envio_motivo);
    const from = process.env.EMAIL_FROM || process.env.SMTP_FROM!;
    const subject = 'Boletim do simulado ENEM - IFS Lagarto';
    const html = reportLinkHtml(url, expiry);
    const text = reportLinkText(url,expiry);
    if (this.emailjs?.configured()) return this.emailjs.send(report.email!, subject, html, {message_text:text});
    if (process.env.RESEND_API_KEY) {
      const response = await fetch('https://api.resend.com/emails', {method: 'POST', headers: {Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey},
        body: JSON.stringify({from, to: [report.email], subject, html, text, ...(process.env.EMAIL_REPLY_TO ? {reply_to:process.env.EMAIL_REPLY_TO} : {})}), signal: AbortSignal.timeout(30000)});
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
      const result = await transport.sendMail({from, to: report.email!, subject, html, text, ...(process.env.EMAIL_REPLY_TO ? {replyTo:process.env.EMAIL_REPLY_TO} : {})});
      if (!result.accepted?.length) throw new Error('O servidor de email não confirmou o destinatário.');
      return result.messageId;
    } finally { transport.close(); }
  }
}

@Injectable()
export class ReportsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(SimuladosService) private readonly simulados: SimuladosService,
    @Inject(ContactsService) private readonly contacts: ContactsService, @Inject(ReportEmailGateway) private readonly email: ReportEmailGateway,
    @Optional() @Inject(ProofImportService) private readonly proofImports?: ProofImportService) {}
  private async lockResultsForDelivery(simuladoId: number, rawIds: unknown[]) {
    if (rawIds.some(id => !Number.isSafeInteger(id) || Number(id) <= 0)) throw new BadRequestException('O plano contém provas inválidas. Revise um novo plano.');
    const ids = [...new Set(rawIds as number[])].sort((a, b) => a - b);
    if (!ids.length) return;
    // Share the same row lock as manual answer review. The report must be read and
    // fingerprinted only after this lock, then ENVIANDO is reserved before commit.
    // Consistent order avoids deadlocks between batches containing the same proofs.
    const rows = await this.db.all<{id: number}>(`SELECT r.id FROM core_resultadoaluno r
      JOIN core_lotecorrecao l ON l.id=r.lote_id JOIN core_simulado s ON s.id=l.simulado_id
      WHERE s.id=? AND s.owner_id=? AND r.id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id` +
      (this.db.dialect === 'postgres' ? ' FOR UPDATE OF r' : ''), simuladoId, accountId(), ...ids);
    if (rows.length !== ids.length) throw new BadRequestException('Uma prova deste plano foi removida ou não pertence ao seu simulado. Revise um novo plano.');
  }
  async report(id: number): Promise<StudentReport> {
    const {resultado, simulado} = await this.simulados.result(id);
    const contact = await this.contacts.get(resultado.matricula);
    const feedback = await this.db.get<Omit<EssayFeedback,'competencias_redacao'> & {competencias_redacao?: string}>('SELECT nota_redacao,feedback_redacao,competencias_redacao,avaliador_redacao,situacao_redacao,origem_redacao,atualizado_em FROM report_feedback WHERE resultado_id=?', id);
    let competencies: number[] = [];
    try { competencies = feedback?.competencias_redacao ? JSON.parse(feedback.competencias_redacao) : []; } catch { throw new ServiceUnavailableException('A avaliação de redação precisa ser revisada antes de emitir o boletim.'); }
    if (!Array.isArray(competencies) || ![0,5].includes(competencies.length) || competencies.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 200) || (competencies.length && competencies.reduce((sum,value)=>sum+value,0) !== Number(feedback?.nota_redacao))) throw new ServiceUnavailableException('As competências e a nota da redação precisam ser revisadas.');
    const redacao: EssayFeedback = feedback ? {...feedback, competencias_redacao:competencies, nota_redacao: feedback.nota_redacao === null ? null : Number(feedback.nota_redacao)} : {nota_redacao: null, feedback_redacao: '', competencias_redacao:[], avaliador_redacao:'', situacao_redacao:'', origem_redacao:'manual'};
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
    const unavailable = resultado.status === 'ERRO_LEITURA' || !!invalid.length || !!invalidKey.length;
    const provisional = resultado.status === 'ALERTA_REVISAO' || !!resultado.total_incertas || Object.values(resultado.respostas_detectadas).includes('INC');
    const areas = areasFromThemes(resultado.desempenho_temas, unavailable ? 'ERRO_LEITURA' : resultado.status);
    const questoes: ReportQuestion[] = Array.from({length:simulado.total_questoes},(_,i) => {
      const numero=i+1, resposta=resultado.respostas_detectadas[String(numero)] || '—', gabarito=resultado.gabarito_do_envio[String(numero)] || '—';
      const tema=simulado.temas.find(range=>range.inicio<=numero && range.fim>=numero)?.tema || 'Sem tema';
      const estado: ReportQuestion['resultado'] = resultado.status==='ERRO_LEITURA' || !'ABCDE'.split('').includes(gabarito) ? 'PENDENTE' : resposta==='BNK' ? 'BRANCO' : resposta==='RAS' ? 'DUPLA' : resposta==='INC' ? 'INCERTA' : !'ABCDE'.split('').includes(resposta) ? 'PENDENTE' : resposta===gabarito ? 'CORRETA' : 'INCORRETA';
      return {numero,resposta,gabarito,tema,area:canonicalArea(tema)||null,resultado:estado};
    });
    const prioridades: ReportPriority[] = [...new Set(questoes.map(q=>q.area || q.tema))].map(area=>{
      const rows=questoes.filter(q=>(q.area || q.tema)===area);
      const numbers=(state:ReportQuestion['resultado'])=>rows.filter(q=>q.resultado===state).map(q=>q.numero);
      return {area,incorretas:numbers('INCORRETA'),brancos:numbers('BRANCO'),duplas:numbers('DUPLA'),incertas:numbers('INCERTA')};
    });
    const notaDez=unavailable?null:Math.round(score.total_acertos/simulado.total_questoes*1000)/100;
    const validAreas=areas.filter(area=>area.nota_dez!==null), best=validAreas.length?Math.max(...validAreas.map(area=>area.nota_dez!)):null;
    const bestNames=best===null?[]:validAreas.filter(area=>area.nota_dez===best).map(area=>area.area);
    const interpretacao=notaDez===null?'A leitura ou a chave histórica está incompleta; não há nota válida para este boletim. Confira as pendências antes de emiti-lo.':
      `O estudante obteve ${score.total_acertos} acertos em ${simulado.total_questoes} questões, equivalente à nota ${notaDez.toLocaleString('pt-BR',{minimumFractionDigits:2})} de 10${provisional?' (provisória)':''}. `+
      (best===null?'Configure intervalos por área para comparar os desempenhos. ':`A maior nota entre as áreas com questões foi ${best.toLocaleString('pt-BR',{minimumFractionDigits:2})}, em ${bestNames.join(', ')}. `)+
      `${score.total_brancos} ${score.total_brancos===1?'resposta em branco':'respostas em branco'} e ${score.total_rasuras} ${score.total_rasuras===1?'marcação dupla':'marcações duplas'} não pontuam e permanecem no total. Confira as questões indicadas nas prioridades de revisão.`;
    const report: StudentReport = {resultado_id: id, simulado_id: simulado.id, titulo: simulado.titulo, matricula: resultado.matricula,
      nome: contact?.nome || `Aluno ${resultado.matricula}`, email: contact?.email || null, curso: contact?.curso || '', total_questoes: simulado.total_questoes,
      status: resultado.status, geral: score, nota_geral_dez:notaDez, temas: resultado.desempenho_temas, areas, questoes, prioridades, interpretacao,
      redacao, gerado_em: new Date().toISOString(), apto_envio: !pending.length, pendencias: pending, avisos: warnings,
      modelo: 'boletim_individual_v2', metodologia: 'Nota objetiva = acertos / total de questões × 10. Brancos e duplas não pontuam e permanecem no denominador; não há anulação oficial de questões. Este boletim não calcula a TRI do ENEM. Redação: avaliação manual de 0 a 1000.', content_hash: ''};
    // Include the source answers/key and all visible fields, but not the generation timestamp.
    const {gerado_em, content_hash, ...stable} = report;
    report.content_hash = sha256(JSON.stringify({report: {...stable, redacao: {nota_redacao: redacao.nota_redacao, feedback_redacao: redacao.feedback_redacao, competencias_redacao:redacao.competencias_redacao || [], avaliador_redacao:redacao.avaliador_redacao || '', situacao_redacao:redacao.situacao_redacao || '', origem_redacao:redacao.origem_redacao || 'manual'}}, respostas: resultado.respostas_detectadas, gabarito: resultado.gabarito_do_envio, institution: INSTITUTION()}));
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
    const existing = await this.report(id);
    if (!raw || typeof raw !== 'object') throw new BadRequestException('Informe a nota e o feedback da redação.');
    const body = raw as {nota_redacao?: unknown; feedback_redacao?: unknown; competencias_redacao?: unknown; limpar_competencias?: unknown};
    const note = body.nota_redacao === undefined || body.nota_redacao === '' ? null : body.nota_redacao;
    if (note !== null && (typeof note !== 'number' || !Number.isFinite(note) || note < 0 || note > 1000)) throw new BadRequestException('A nota da redação deve ser um número entre 0 e 1000, ou vazia.');
    const feedback = body.feedback_redacao === undefined ? '' : body.feedback_redacao;
    if (typeof feedback !== 'string' || feedback.length > 10000 || feedback.includes('\x00')) throw new BadRequestException('O feedback deve ter até 10.000 caracteres.');
    let competencies = existing.redacao.competencias_redacao || [];
    if (body.limpar_competencias === true) competencies = [];
    if (body.competencias_redacao !== undefined) {
      if (!Array.isArray(body.competencias_redacao) || ![0,5].includes(body.competencias_redacao.length) || body.competencias_redacao.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 200)) throw new BadRequestException('Informe as cinco competências de 0 a 200, ou uma lista vazia.');
      competencies = body.competencias_redacao as number[];
    }
    if (competencies.length && competencies.reduce((sum,value)=>sum+value,0) !== note) throw new BadRequestException('A nota deve ser igual à soma das cinco competências. Para substituir a nota importada, confirme a remoção das competências.');
    const updated = await this.db.run(`INSERT INTO report_feedback(resultado_id,nota_redacao,feedback_redacao,competencias_redacao,origem_redacao,atualizado_em) VALUES(?,?,?,?,?,?)
      ON CONFLICT(resultado_id) DO UPDATE SET nota_redacao=excluded.nota_redacao,feedback_redacao=excluded.feedback_redacao,competencias_redacao=excluded.competencias_redacao,origem_redacao=excluded.origem_redacao,atualizado_em=excluded.atualizado_em
      WHERE report_feedback.atualizado_em=? AND COALESCE(report_feedback.nota_redacao,-1)=? AND report_feedback.feedback_redacao=? AND report_feedback.competencias_redacao=?`, id, note, feedback.trim(), JSON.stringify(competencies), 'manual', new Date().toISOString(), existing.redacao.atualizado_em || '', existing.redacao.nota_redacao ?? -1, existing.redacao.feedback_redacao, JSON.stringify(existing.redacao.competencias_redacao || []));
    if (!updated.changes) throw new BadRequestException('A avaliação de redação mudou durante a edição. Reabra o boletim para preservar a avaliação atual.');
    return this.report(id);
  }
  async pdf(reportOrId: number | StudentReport): Promise<Buffer> {
    const report = typeof reportOrId === 'number' ? await this.report(reportOrId) : reportOrId;
    return renderReportPdf(report, INSTITUTION());
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
  private async createAccess(row: DeliveryRow, operationHash: string) {
    const token = randomBytes(32).toString('base64url'), now = new Date();
    const {resultado,simulado} = await this.simulados.result(row.resultado_id);
    const contact = await this.contacts.get(resultado.matricula) as {expira_em?:string} | undefined;
    const expiry = new Date(Math.min(now.getTime() + linkTtl(), ...(simulado.expira_em ? [Date.parse(simulado.expira_em)] : []), ...(contact?.expira_em ? [Date.parse(contact.expira_em)] : []))).toISOString();
    const url = accessUrl(token);
    await this.db.run('INSERT INTO report_access_links(token_hash,delivery_id,operation_hash,criado_em,expira_em) VALUES(?,?,?,?,?)', sha256(token), row.id, operationHash, now.toISOString(), expiry);
    return {url, expiry, operationHash};
  }
  private async refreshReserved(entry: ReservedDelivery): Promise<StudentReport> {
    return this.db.transaction(async () => {
      await this.lockResultsForDelivery(entry.report.simulado_id, [entry.row.resultado_id]);
      const current = await this.db.get<DeliveryRow>('SELECT * FROM report_deliveries WHERE id=?', entry.row.id);
      if (!current || current.status !== 'ENVIANDO' || current.resultado_id !== entry.row.resultado_id || current.content_hash !== entry.row.content_hash || current.destinatario !== entry.row.destinatario) throw new BadRequestException('A reserva desta entrega mudou. Revise o histórico antes de preparar um novo envio.');
      let report: StudentReport;
      try { report = await this.report(current.resultado_id); }
      catch { throw new BadRequestException('O boletim não está disponível para envio. Confira a prova, as avaliações e o prazo de armazenamento.'); }
      if (!report.apto_envio || report.content_hash !== current.content_hash || report.email !== current.destinatario || report.simulado_id !== entry.report.simulado_id || report.matricula !== entry.report.matricula) throw new BadRequestException('O boletim ou o destinatário mudou enquanto aguardava a fila. Revise uma nova prévia antes de enviar.');
      const access = await this.db.get<AccessRow>('SELECT * FROM report_access_links WHERE delivery_id=? AND operation_hash=?', current.id, entry.operationHash || '');
      if (!entry.url || !entry.expiry || !access || access.revogado_em || access.ativado_em || !Number.isFinite(Date.parse(access.expira_em)) || Date.parse(access.expira_em) <= Date.now()) throw new BadRequestException('O acesso reservado não está disponível. Revise uma nova prévia antes de enviar.');
      const renewed = await this.db.run('UPDATE report_deliveries SET tentativa_em=? WHERE id=? AND status=? AND destinatario=? AND content_hash=?', new Date().toISOString(), current.id, 'ENVIANDO', current.destinatario, current.content_hash);
      if (!renewed.changes) throw new BadRequestException('A reserva desta entrega mudou. Revise o histórico antes de enviar.');
      return report;
    });
  }
  private async blockReserved(entry: ReservedDelivery, reason: string) {
    await this.db.transaction(async () => {
      const blocked = await this.db.run('UPDATE report_deliveries SET status=?,erro=? WHERE id=? AND status=? AND destinatario=? AND content_hash=?', 'BLOQUEADO', reason, entry.row.id, 'ENVIANDO', entry.row.destinatario, entry.row.content_hash);
      if (blocked.changes) {
        await this.db.run('UPDATE report_access_links SET revogado_em=? WHERE delivery_id=? AND operation_hash=? AND ativado_em IS NULL AND revogado_em IS NULL', new Date().toISOString(), entry.row.id, entry.operationHash || '');
        // The failed preview cannot retry itself. Only a newly prepared and
        // explicitly confirmed plan may reclaim a known pre-provider failure.
        if (entry.planHash) await this.db.run('DELETE FROM report_delivery_plans WHERE token_hash=? AND simulado_id=?', entry.planHash, entry.report.simulado_id);
      }
    });
  }
  private async deliverReserved(entries: ReservedDelivery[]): Promise<DeliveryResult> {
    const results: ReportDelivery[] = []; let sent = 0, ignored = 0;
    for (const entry of entries) {
      const {row, fresh, url, expiry, operationHash} = entry;
      let report = entry.report;
      if (!fresh) { ignored++; results.push({resultado_id: row.resultado_id, matricula: report.matricula, email: row.destinatario, status: row.status, message_id: row.message_id, erro: row.erro}); continue; }
      let messageId = '', providerAttempted = false;
      try {
        // Long batches may outlive the original lease. Re-read the report under
        // its row lock and renew only this exact reservation immediately before
        // calling the gateway; later cards cannot reuse an outdated fingerprint.
        report = await this.refreshReserved(entry);
        providerAttempted = true;
        messageId = await this.email.deliver(report, url!, `boletim-acesso-${operationHash}`, expiry!);
        if (!messageId) throw new Error('Entrega não confirmada.');
        await this.db.transaction(async () => {
          await this.db.run('UPDATE report_deliveries SET status=?,message_id=?,erro=? WHERE id=?', 'ENVIADO', messageId, '', row.id);
          await this.db.run('UPDATE report_access_links SET ativado_em=? WHERE operation_hash=? AND revogado_em IS NULL', new Date().toISOString(), operationHash!);
        });
        sent++; results.push({resultado_id: report.resultado_id, matricula: report.matricula, email: report.email!, status: 'ENVIADO', message_id: messageId, erro: ''});
      } catch (failure) {
        if (!providerAttempted) {
          const detail = failure instanceof BadRequestException ? failure.message : 'Não foi possível validar a reserva. Revise o histórico e prepare uma nova prévia.';
          const error = 'Envio bloqueado antes de chamar o provedor: ' + detail;
          try { await this.blockReserved(entry, error); } catch { /* No provider call occurred; preserve the durable reservation if storage is unavailable. */ }
          results.push({resultado_id: row.resultado_id, matricula: entry.report.matricula, email: row.destinatario, status: 'BLOQUEADO', message_id: '', erro: error});
          continue;
        }
        const error = messageId ? 'O provedor confirmou a mensagem, mas o registro local falhou. Não reenvie automaticamente; confira o provedor.' : 'Não foi possível confirmar a entrega. Confira o provedor de email antes de tentar um novo envio; uma mensagem pode ter sido aceita.';
        try { await this.db.run('UPDATE report_deliveries SET status=?,message_id=?,erro=? WHERE id=?', 'AMBIGUO', messageId, error, row.id); } catch { /* ENVIANDO remains a durable lock if the database is unavailable. */ }
        results.push({resultado_id: report.resultado_id, matricula: report.matricula, email: report.email!, status: 'AMBIGUO', message_id: messageId, erro: error});
      }
    }
    return {total_enviados: sent, total_ignorados: ignored, resultados: results};
  }
  async send(simuladoId: number, token: unknown, confirmation: unknown): Promise<DeliveryResult> {
    if (confirmation !== 'sim' || typeof token !== 'string' || !ACCESS_TOKEN_PATTERN.test(token)) throw new BadRequestException('Revise os destinatários e confirme o envio.');
    await this.simulados.get(simuladoId);
    const availability = this.email.availability();
    if (!availability.envio_disponivel) throw new ServiceUnavailableException(availability.envio_motivo);
    linkTtl(); accessUrl(token);
    // The plaintext access token exists only during this call. A reserved/ambiguous delivery is never retried automatically.
    const reserved = await this.db.transaction(async () => {
      const saved = await this.db.get<{simulado_id: number; payload: string; expira_em: string}>('SELECT simulado_id,payload,expira_em FROM report_delivery_plans WHERE token_hash=?', sha256(token));
      if (!saved || saved.simulado_id !== simuladoId || (!Number.isFinite(Date.parse(saved.expira_em)) || Date.parse(saved.expira_em) <= Date.now())) throw new BadRequestException('O plano de envio expirou ou é inválido. Revise um novo plano.');
      const rows = JSON.parse(saved.payload) as PlanRecord[];
      if (!Array.isArray(rows)) throw new BadRequestException('Este plano não é um plano de envio de boletins.');
      await this.lockResultsForDelivery(simuladoId, rows.map(row => row.resultado_id));
      const reports = await Promise.all(rows.map(row => this.report(row.resultado_id)));
      if (reports.some((report, i) => report.simulado_id !== simuladoId || !report.apto_envio || report.content_hash !== rows[i].content_hash || report.email !== rows[i].email || report.matricula !== rows[i].matricula)) throw new BadRequestException('O boletim, a redação ou o contato mudou após a prévia. Revise um novo plano antes de enviar.');
      const entries: ReservedDelivery[] = [];
      for (const report of reports) {
        const result = await this.db.run(`INSERT INTO report_deliveries(resultado_id,destinatario,status,content_hash,message_id,erro,criado_em) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(resultado_id,destinatario,content_hash) DO NOTHING`, report.resultado_id, report.email!, 'ENVIANDO', report.content_hash, '', '', new Date().toISOString());
        let row = await this.db.get<DeliveryRow>('SELECT * FROM report_deliveries WHERE resultado_id=? AND destinatario=? AND content_hash=?', report.resultado_id, report.email!, report.content_hash);
        if (!row) throw new Error('Falha ao registrar a entrega.');
        let fresh = result.changes > 0;
        if (!fresh && row.status === 'BLOQUEADO' && !row.message_id) {
          const reclaimed = await this.db.run(`UPDATE report_deliveries SET status=?,erro=?,tentativa_em=?
            WHERE id=? AND status=? AND destinatario=? AND content_hash=? AND COALESCE(message_id,'')=''`,
            'ENVIANDO', '', new Date().toISOString(), row.id, 'BLOQUEADO', report.email!, report.content_hash);
          fresh = reclaimed.changes === 1;
          if (fresh) row = {...row, status:'ENVIANDO', erro:''};
        }
        const planHash = sha256(token);
        entries.push({report, row, fresh, planHash, ...(fresh ? await this.createAccess(row, sha256('envio:' + planHash + ':' + row.id)) : {})});
      }
      return entries;
    });
    return this.deliverReserved(reserved);
  }
  async planReissue(simuladoId: number, rawDeliveryId: unknown): Promise<DeliveryPlan & {reemissao: true; delivery_id: number}> {
    await this.simulados.get(simuladoId);
    if (!Number.isSafeInteger(rawDeliveryId) || Number(rawDeliveryId) <= 0) throw new BadRequestException('Selecione uma entrega concluída para reemitir o link.');
    const row = await this.db.get<DeliveryRow>('SELECT * FROM report_deliveries WHERE id=?', rawDeliveryId as number);
    if (!row || row.status !== 'ENVIADO') throw new BadRequestException('Somente entregas confirmadas permitem reemitir um link. Verifique entregas ambíguas no provedor.');
    const report = await this.report(row.resultado_id);
    if (report.simulado_id !== simuladoId) throw new BadRequestException('A entrega pertence a outro simulado.');
    if (!report.apto_envio) throw new BadRequestException('Resolva as pendências do boletim antes de reemitir o link.');
    const previous = await this.db.get<{operation_hash:string}>('SELECT operation_hash FROM report_access_links WHERE delivery_id=? ORDER BY CASE WHEN revogado_em IS NULL THEN 0 ELSE 1 END,criado_em DESC,operation_hash DESC LIMIT 1', row.id);
    const token = randomBytes(32).toString('base64url'), now = new Date(), expiry = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const record: PlanRecord = {resultado_id:report.resultado_id,matricula:report.matricula,nome:report.nome,email:report.email!,nota_percentual:report.geral.nota_percentual,content_hash:report.content_hash};
    const payload: ReissuePlan = {modo:'reemitir',delivery_id:row.id,original_content_hash:row.content_hash,original_destinatario:row.destinatario,original_operation_hash:previous?.operation_hash || '',report:record};
    await this.db.run('INSERT INTO report_delivery_plans(token_hash,simulado_id,payload,expira_em,criado_em) VALUES(?,?,?,?,?)', sha256(token), simuladoId, JSON.stringify(payload), expiry, now.toISOString());
    return {token,simulado_id:simuladoId,alunos:[record],total:1,expira_em:expiry, ...this.email.availability(),reemissao:true,delivery_id:row.id};
  }
  async reissue(simuladoId: number, token: unknown, confirmation: unknown): Promise<DeliveryResult> {
    if (confirmation !== 'sim' || typeof token !== 'string' || !ACCESS_TOKEN_PATTERN.test(token)) throw new BadRequestException('Revise o destinatário e confirme a reemissão do link.');
    await this.simulados.get(simuladoId);
    const availability = this.email.availability();
    if (!availability.envio_disponivel) throw new ServiceUnavailableException(availability.envio_motivo);
    linkTtl(); accessUrl(token);
    const reserved = await this.db.transaction(async () => {
      const saved = await this.db.get<{simulado_id:number;payload:string;expira_em:string}>('SELECT simulado_id,payload,expira_em FROM report_delivery_plans WHERE token_hash=?', sha256(token));
      if (!saved || saved.simulado_id !== simuladoId || (!Number.isFinite(Date.parse(saved.expira_em)) || Date.parse(saved.expira_em) <= Date.now())) throw new BadRequestException('O plano de reemissão expirou ou é inválido. Revise um novo plano.');
      const plan = JSON.parse(saved.payload) as ReissuePlan;
      if (plan.modo !== 'reemitir') throw new BadRequestException('Este plano não é um plano de reemissão.');
      const operationHash = sha256('reemissao:' + sha256(token));
      const row = await this.db.get<DeliveryRow>('SELECT * FROM report_deliveries WHERE id=?', plan.delivery_id);
      if (!row) throw new BadRequestException('A entrega foi removida.');
      await this.lockResultsForDelivery(simuladoId, [row.resultado_id]);
      const report = await this.report(row.resultado_id);
      const already = await this.db.get<AccessRow>('SELECT * FROM report_access_links WHERE operation_hash=?', operationHash);
      if (already) return [{report,row,fresh:false}];
      const previous = await this.db.get<{operation_hash:string}>('SELECT operation_hash FROM report_access_links WHERE delivery_id=? ORDER BY CASE WHEN revogado_em IS NULL THEN 0 ELSE 1 END,criado_em DESC,operation_hash DESC LIMIT 1', row.id);
      if (row.status !== 'ENVIADO' || row.content_hash !== plan.original_content_hash || row.destinatario !== plan.original_destinatario || (previous?.operation_hash || '') !== plan.original_operation_hash || report.simulado_id !== simuladoId || !report.apto_envio || report.content_hash !== plan.report.content_hash || report.email !== plan.report.email || report.matricula !== plan.report.matricula) throw new BadRequestException('O boletim, o destinatário ou a entrega mudou após a prévia. Revise um novo plano antes de reemitir.');
      const conflict = await this.db.get<{id:number}>('SELECT id FROM report_deliveries WHERE resultado_id=? AND destinatario=? AND content_hash=? AND id<>?', report.resultado_id, report.email!, report.content_hash, row.id);
      if (conflict) throw new BadRequestException('Já existe uma entrega dessa versão para este destinatário. Reemita o link da entrega correspondente.');
      const claimed = await this.db.run('UPDATE report_deliveries SET status=?,destinatario=?,content_hash=?,message_id=?,erro=?,tentativa_em=? WHERE id=? AND status=? AND destinatario=? AND content_hash=?', 'ENVIANDO', report.email!, report.content_hash, '', '', new Date().toISOString(), row.id, 'ENVIADO', row.destinatario, row.content_hash);
      if (!claimed.changes) throw new BadRequestException('Esta entrega já está sendo atualizada. Revise a situação antes de reemitir.');
      await this.db.run('UPDATE report_access_links SET revogado_em=? WHERE delivery_id=? AND revogado_em IS NULL', new Date().toISOString(), row.id);
      const updated = {...row,status:'ENVIANDO' as const,destinatario:report.email!,content_hash:report.content_hash,message_id:'',erro:''};
      return [{report,row:updated,fresh:true,planHash:sha256(token),...await this.createAccess(updated,operationHash)}];
    });
    return this.deliverReserved(reserved);
  }
  private async validateAccess(rawToken: unknown): Promise<{report:StudentReport; access:AccessRow}> {
    if (typeof rawToken !== 'string' || !ACCESS_TOKEN_PATTERN.test(rawToken)) throw new GoneException(INVALID_ACCESS_MESSAGE);
    const access = await this.db.get<AccessRow>('SELECT * FROM report_access_links WHERE token_hash=?', sha256(rawToken));
    if (!access || !access.ativado_em || access.revogado_em || (!Number.isFinite(Date.parse(access.expira_em)) || Date.parse(access.expira_em) <= Date.now())) throw new GoneException(INVALID_ACCESS_MESSAGE);
    const delivery = await this.db.get<DeliveryRow>('SELECT * FROM report_deliveries WHERE id=?', access.delivery_id);
    if (!delivery || delivery.status !== 'ENVIADO') throw new GoneException(INVALID_ACCESS_MESSAGE);
    let report: StudentReport;
    try {
      const owner = await this.db.get<{owner_id:string}>(`SELECT s.owner_id FROM core_resultadoaluno r JOIN core_lotecorrecao l ON l.id=r.lote_id
        JOIN core_simulado s ON s.id=l.simulado_id WHERE r.id=?`, delivery.resultado_id);
      if (!owner) throw new GoneException(INVALID_ACCESS_MESSAGE);
      report = await withAccount({id:owner.owner_id,email:''}, () => this.report(delivery.resultado_id));
    } catch { throw new GoneException(INVALID_ACCESS_MESSAGE); }
    if (!report.apto_envio || report.content_hash !== delivery.content_hash || report.email !== delivery.destinatario) throw new GoneException(INVALID_ACCESS_MESSAGE);
    return {report,access};
  }
  async publicReport(token: unknown): Promise<PublicReportAccess> {
    const {report,access} = await this.validateAccess(token);
    const {resultado_id,simulado_id,email,content_hash,apto_envio,pendencias,avisos,...boletim} = report;
    return {boletim,instituicao:INSTITUTION(),expira_em:access.expira_em};
  }
  async publicPdf(token: unknown): Promise<Buffer> {
    const {report} = await this.validateAccess(token);
    return this.pdf(report);
  }
  async cleanupAccess(rawAuthorization: unknown) {
    const secret = process.env.CRON_SECRET;
    if (!secret || secret.length < 32) throw new ServiceUnavailableException('A limpeza dos acessos ainda não foi configurada.');
    const expected = Buffer.from('Bearer ' + secret), provided = Buffer.from(typeof rawAuthorization === 'string' ? rawAuthorization : '');
    if (expected.length !== provided.length || !timingSafeEqual(expected,provided)) throw new UnauthorizedException('Acesso não autorizado.');
    const storageDeadline = Date.now() + 240_000;
    const now = new Date().toISOString();
    const deleted = await this.db.run('DELETE FROM report_access_links WHERE expira_em<=? OR revogado_em IS NOT NULL', now);
    await this.db.run('DELETE FROM essay_import_plans WHERE expira_em<=?', now);
    await this.db.run('DELETE FROM contacts_import_plans WHERE expira_em<=?', now);
    await this.db.run('DELETE FROM report_delivery_plans WHERE expira_em<=?', now);
    const expired = await this.proofImports?.cleanupAllExpired();
    const simuladosRemovidos = await this.simulados.cleanupExpired();
    const contatos = await this.db.run('DELETE FROM student_contacts WHERE expira_em<=?',now);
    // Recibos de upload expiram em 30 min; URLs de upload podem durar 2 h.
    // Não remove arquivos ainda referenciados por importações duráveis.
    const uploads = await this.db.all<{id:string;path:string}>(`SELECT u.id,u.path FROM uploaded_files u WHERE u.created_at<=?
      AND NOT EXISTS (SELECT 1 FROM proof_import_plans p WHERE p.payload LIKE '%' || u.path || '%') LIMIT 100`, new Date(Date.now()-2*3600_000).toISOString());
    await this.db.transaction(async()=>{
      for(const file of uploads) {
        await this.db.run('INSERT INTO storage_deletions(path,criado_em) VALUES(?,?) ON CONFLICT(path) DO NOTHING',file.path,now);
        await this.db.run('DELETE FROM uploaded_files WHERE id=?',file.id);
      }
    });
    await this.db.run('DELETE FROM auth_attempt_limits WHERE window_at<=?',Date.now()-86400_000);
    await this.db.run('DELETE FROM email_provider_slots WHERE next_at<=?',Date.now()-86400_000);
    const arquivosRemovidos = await this.simulados.cleanStorage(storageDeadline);
    return {removidos:deleted.changes,...expired,simulados_removidos:simuladosRemovidos,contatos_removidos:contatos.changes,recibos_removidos:uploads.length,arquivos_removidos:arquivosRemovidos};
  }
  async deliveries(simuladoId: number) {
    await this.simulados.get(simuladoId);
    return {entregas: await this.db.all<DeliveryRow & {matricula: string; criado_em: string}>(`SELECT d.*,r.matricula,(SELECT MAX(a.expira_em) FROM report_access_links a WHERE a.delivery_id=d.id AND a.ativado_em IS NOT NULL AND a.revogado_em IS NULL) AS acesso_expira_em FROM report_deliveries d JOIN core_resultadoaluno r ON r.id=d.resultado_id
      JOIN core_lotecorrecao l ON l.id=r.lote_id WHERE l.simulado_id=? ORDER BY d.criado_em DESC,d.id DESC`, simuladoId)};
  }
}
