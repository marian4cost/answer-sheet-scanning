import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from './database.service';
import { validEmail } from './contacts.service';

@Injectable()
export class EmailJsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  configured() { return process.env.EMAILJS_ENABLED !== 'false' && !!process.env.EMAILJS_SERVICE_ID && !!process.env.EMAILJS_TEMPLATE_ID && !!process.env.EMAILJS_PUBLIC_KEY && !!process.env.EMAILJS_PRIVATE_KEY; }
  async send(to: string, subject: string, html: string, extra: Record<string,string> = {}): Promise<string> {
    if (!this.configured()) throw new ServiceUnavailableException('Configure o serviço, template e as chaves do EmailJS na API.');
    if (!validEmail(to) || /[\r\n]/.test(subject)) throw new ServiceUnavailableException('Destinatário ou assunto inválido.');
    const payload = {service_id: process.env.EMAILJS_SERVICE_ID, template_id: process.env.EMAILJS_TEMPLATE_ID,
      user_id: process.env.EMAILJS_PUBLIC_KEY, accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {...extra, to_email: to, subject, message_html: html}};
    // Reserva compartilhada entre instâncias: o EmailJS aceita uma chamada por segundo.
    const now = Date.now();
    const slot = await this.db.get<{next_at:number}>(`INSERT INTO email_provider_slots(provider,next_at) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET next_at=CASE WHEN email_provider_slots.next_at<? THEN ? ELSE email_provider_slots.next_at+1100 END RETURNING next_at`, 'emailjs', now, now, now);
    const wait = Number(slot!.next_at) - now;
    if (wait > 30_000) throw new ServiceUnavailableException('Muitas mensagens aguardando envio. Tente novamente em alguns instantes.');
    if (Buffer.byteLength(JSON.stringify(payload)) > 49_000) throw new ServiceUnavailableException('A mensagem excede o limite do plano gratuito do EmailJS.');
    if (wait > 0) await delay(wait);
    const result = await fetch('https://api.emailjs.com/api/v1.0/email/send', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:AbortSignal.timeout(20_000)});
    const text = await result.text();
    if (!result.ok || text.trim() !== 'OK') throw new ServiceUnavailableException('O EmailJS não confirmou o envio. Confira o painel antes de repetir.');
    return 'emailjs-accepted';
  }
}
