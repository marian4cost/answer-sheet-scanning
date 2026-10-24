import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from './database.service';
import { validEmail } from './contacts.service';
import { EmailNotSentError } from './email-errors';

@Injectable()
export class SesService {
  private client?: SESv2Client;
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  configured() {
    const from = process.env.EMAIL_FROM || '';
    return !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) && !/[\r\n\x00]/.test(from) && validEmail(from.match(/<([^<>]+)>$/)?.[1] || from);
  }
  async send(to:string, subject:string, html:string, text:string, operation?:string): Promise<string> {
    if (!this.configured()) throw new EmailNotSentError('Configure AWS_REGION e EMAIL_FROM com um remetente verificado no SES.');
    if (!validEmail(to) || !subject.trim() || /[\r\n\x00]/.test(subject) || Buffer.byteLength(html) + Buffer.byteLength(text) > 1_000_000) throw new EmailNotSentError('Destinatário, assunto ou tamanho da mensagem inválido.');
    const reply = process.env.EMAIL_REPLY_TO;
    if (reply && !validEmail(reply)) throw new EmailNotSentError('Configure EMAIL_REPLY_TO com um e-mail válido.');
    const rate = Number(process.env.SES_RATE_PER_SECOND || 1);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) throw new EmailNotSentError('SES_RATE_PER_SECOND deve estar entre 0 e 100, respeitando a cota aprovada pela AWS.');
    const spacing = Math.ceil(1000 / rate), now = Date.now();
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION!;
    let slot: {next_at:number} | undefined;
    try { slot = await this.db.get<{next_at:number}>(`INSERT INTO email_provider_slots(provider,next_at) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET next_at=CASE WHEN email_provider_slots.next_at<? THEN ? ELSE email_provider_slots.next_at+? END
      WHERE email_provider_slots.next_at<=? RETURNING next_at`, 'ses:' + region, now, now, now, spacing, now + 30_000 - spacing); }
    catch { throw new EmailNotSentError('Não foi possível reservar a tentativa de envio no banco. Prepare uma nova prévia.'); }
    if (!slot) throw new EmailNotSentError('A fila de envio atingiu o limite. Aguarde e prepare uma nova prévia.');
    const wait = Number(slot.next_at) - now;
    if (wait > 0) await delay(wait);
    // O SES não oferece chave idempotente em SendEmail. Nunca repetir
    // automaticamente uma transmissão cujo recebimento ficou incerto.
    this.client ??= new SESv2Client({region,maxAttempts:1});
    try {
      const result = await this.client.send(new SendEmailCommand({
        FromEmailAddress:process.env.EMAIL_FROM!,Destination:{ToAddresses:[to]},
        ...(reply ? {ReplyToAddresses:[reply]} : {}),
        ...(process.env.SES_CONFIGURATION_SET ? {ConfigurationSetName:process.env.SES_CONFIGURATION_SET} : {}),
        EmailTags:[{Name:'application',Value:'sirenia'},...(operation && /^[A-Za-z0-9_-]{1,256}$/.test(operation) ? [{Name:'operation',Value:operation}] : [])],
        Content:{Simple:{Subject:{Data:subject,Charset:'UTF-8'},Body:{Html:{Data:html,Charset:'UTF-8'},Text:{Data:text,Charset:'UTF-8'}}}},
      }),{abortSignal:AbortSignal.timeout(20_000)});
      if (!result.MessageId) throw new ServiceUnavailableException('O SES não confirmou a mensagem. Confira o histórico antes de repetir.');
      return result.MessageId;
    } catch (error) {
      const failure = error as {name?:string;$metadata?:{httpStatusCode?:number}};
      if ([400,401,403,404,413,429].includes(failure.$metadata?.httpStatusCode || 0) || failure.name === 'CredentialsProviderError') throw new EmailNotSentError('O SES recusou a mensagem. Confira a identidade do remetente, a região, as permissões e as cotas da conta antes de tentar novamente.');
      throw new ServiceUnavailableException('O SES não confirmou o envio. Confira o provedor e o histórico antes de repetir; a mensagem pode ter sido aceita.');
    }
  }
}
