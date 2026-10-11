import { BadRequestException, Body, Controller, Get, Inject, Injectable, Post, Res, Req, Optional, UnauthorizedException, ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { SUPABASE_URL } from './config';
import { DatabaseService } from './database.service';
import { EmailJsService } from './emailjs.service';
import { sha256 } from './contacts.service';

const COOKIE = 'enem_session';
export function authRequired() {
  return true;
}
function cookieSecure() { return !!process.env.VERCEL || authRequired(); }
export function teacherAllowed(user: {email?: string; email_confirmed_at?: string; app_metadata?: {role?: string}}) {
  const allowed = (process.env.TEACHER_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return !!user.email && (allowed.includes(user.email.toLowerCase()) || ['teacher','admin'].includes(user.app_metadata?.role || '') || (process.env.AUTH_REGISTRATION_ENABLED === 'true' && !!user.email_confirmed_at));
}
export function requestToken(request: Request) {
  const bearer = request.get('authorization');
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7);
  const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='));
  return cookie?.slice(COOKIE.length + 1) || '';
}

@Injectable()
export class AuthService {
  constructor(@Optional() @Inject(DatabaseService) private readonly db?: DatabaseService, @Optional() @Inject(EmailJsService) private readonly emailjs?: EmailJsService) {}
  config() { return {required: authRequired(), configured: !!SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY, registration_enabled: process.env.AUTH_REGISTRATION_ENABLED === 'true'}; }
  private async call(path: string, body?: object, token?: string, admin = false) {
    if (!this.config().configured) throw new UnauthorizedException('O acesso dos professores ainda não foi configurado.');
    const key = admin ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY;
    if (!key) throw new ServiceUnavailableException('O serviço de cadastro ainda não foi configurado.');
    let result: globalThis.Response;
    try {
      result = await fetch(SUPABASE_URL + '/auth/v1/' + path, {method: body ? 'POST' : 'GET',
        headers: {apikey: key, 'Content-Type': 'application/json', ...(token || admin ? {Authorization: 'Bearer ' + (token || key)} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(10_000)});
    } catch { throw new UnauthorizedException('O serviço de acesso não respondeu. Tente novamente.'); }
    const data = await result.json().catch(() => null);
    if (!result.ok || !data) throw new UnauthorizedException('Não foi possível validar o acesso. Confira o código ou as credenciais e tente novamente.');
    return data;
  }
  async user(token: string) {
    if (!token || token.length > 8000) throw new UnauthorizedException('Entre com sua conta de professor.');
    const user = await this.call('user', undefined, token);
    if (!teacherAllowed(user)) throw new ForbiddenException('Esta conta não tem acesso aos simulados.');
    return {email: user.email as string};
  }
  private email(value: unknown) {
    if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new BadRequestException('Informe seu e-mail de professor.');
    const email = value.trim().toLowerCase();
    if (!this.config().registration_enabled && !teacherAllowed({email})) throw new ForbiddenException('Esta conta não tem acesso aos simulados.');
    return email;
  }
  private password(value: unknown) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new BadRequestException('A senha deve ter entre 8 e 128 caracteres.');
    return value;
  }
  private async quota(scope: string, milliseconds: number, max: number) {
    if (!this.db) return;
    const now = Date.now(), start = now - milliseconds;
    const row = await this.db.get<{total:number}>(`INSERT INTO auth_attempt_limits(scope_hash,window_at,total) VALUES(?,?,1)
      ON CONFLICT(scope_hash) DO UPDATE SET total=CASE WHEN auth_attempt_limits.window_at<=? THEN 1 ELSE auth_attempt_limits.total+1 END,
      window_at=CASE WHEN auth_attempt_limits.window_at<=? THEN ? ELSE auth_attempt_limits.window_at END
      WHERE auth_attempt_limits.window_at<=? OR auth_attempt_limits.total<? RETURNING total`, sha256(scope), now, start, start, now, start, max);
    if (!row) throw new HttpException('Muitas tentativas. Aguarde antes de solicitar novamente.',429);
  }
  private async sendCode(email: string, params: object, ip: string) {
    if (!this.emailjs?.configured()) throw new ServiceUnavailableException('O envio dos códigos por EmailJS ainda não foi configurado.');
    await this.quota('code-ip:' + ip, 3600_000, 10);
    await this.quota('code-email:' + email, 60_000, 1);
    const generated = await this.call('admin/generate_link', params, undefined, true);
    if (typeof generated.email_otp !== 'string' || !/^\d{6,10}$/.test(generated.email_otp)) throw new ServiceUnavailableException('Não foi possível gerar o código de confirmação.');
    const html = `<div style="font:16px Arial,sans-serif;color:#172033;max-width:600px;margin:auto"><h2>IFS Lagarto - Simulados ENEM</h2><p>Use este código para confirmar seu e-mail:</p><p style="font-size:32px;letter-spacing:5px;font-weight:bold">${generated.email_otp}</p><p>O código é de uso único e expira em até uma hora. Se você não solicitou o acesso, ignore esta mensagem.</p></div>`;
    await this.emailjs.send(email, 'Seu código de confirmação - Simulados ENEM', html);
    return {message:'Confira seu e-mail e informe o código de confirmação. Ele é de uso único.'};
  }
  async signup(rawEmail: unknown, rawPassword: unknown, ip = 'unknown') {
    if (!this.config().registration_enabled) throw new ForbiddenException('O cadastro de novas contas está desativado.');
    const email = this.email(rawEmail), password = this.password(rawPassword);
    return this.sendCode(email, {type:'signup', email, password}, ip);
  }
  async passwordLogin(rawEmail: unknown, rawPassword: unknown, response: Response, ip = 'unknown') {
    const email = this.email(rawEmail), password = this.password(rawPassword);
    await this.quota('password-ip:' + ip, 600_000, 20);
    const session = await this.call('token?grant_type=password', {email,password});
    const user = await this.user(session.access_token);
    if (user.email.toLowerCase() !== email) throw new UnauthorizedException('Credenciais inválidas.');
    this.setCookie(session.access_token, session.expires_in, response);
    return user;
  }
  async requestCode(value: unknown, ip = 'unknown') {
    const email = this.email(value);
    if (this.emailjs?.configured()) return this.sendCode(email, {type:'magiclink',email}, ip);
    const web = process.env.WEB_URL || (process.env.CORS_ORIGINS || '').split(',')[0];
    const redirect = web ? '?redirect_to=' + encodeURIComponent(web.replace(/\/$/, '') + '/login') : '';
    await this.call('otp' + redirect, {email, create_user: true});
    return {message: 'Confira seu e-mail. Use o link de acesso ou informe o código, se ele estiver presente na mensagem.'};
  }
  async login(rawEmail: unknown, rawCode: unknown, response: Response, signup = false) {
    const email = this.email(rawEmail);
    if (typeof rawCode !== 'string' || !/^\d{6,10}$/.test(rawCode.trim())) throw new BadRequestException('Informe o código recebido por e-mail.');
    const session = await this.call('verify', {email, token: rawCode.trim(), type: signup ? 'signup' : 'email'});
    const user = await this.user(session.access_token);
    if (user.email.toLowerCase() !== email) throw new UnauthorizedException('Código inválido para este e-mail.');
    this.setCookie(session.access_token, session.expires_in, response);
    return {email};
  }
  private setCookie(token: string, expires: unknown, response: Response) {
    response.cookie(COOKIE, token, {httpOnly:true, secure:cookieSecure(), sameSite:'lax', path:'/', maxAge:Math.min(Number(expires) || 3600,3600)*1000});
  }
  logout(response: Response) { response.clearCookie(COOKIE, {httpOnly: true, secure: cookieSecure(), sameSite: 'lax', path: '/'}); return {ok: true}; }
  async session(rawToken: unknown, response: Response) {
    if (typeof rawToken !== 'string') throw new BadRequestException('Link de acesso inválido.');
    const user = await this.user(rawToken);
    response.cookie(COOKIE, rawToken, {httpOnly: true, secure: cookieSecure(), sameSite: 'lax', path: '/', maxAge: 3600_000});
    return user;
  }
  middleware() {
    return async (request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Cache-Control','private, no-store');
      const publicReport = (request.method === 'POST' && ['/api/boletim/consultar','/api/boletim/pdf'].includes(request.path)) || (request.method === 'GET' && request.path === '/api/boletim/limpar');
      if (publicReport) { response.setHeader('Referrer-Policy','no-referrer'); response.setHeader('X-Robots-Tag','noindex, nofollow, noarchive'); return next(); }
      if (request.method === 'OPTIONS' || ['/api/health', '/api/auth/config', '/api/auth/codigo', '/api/auth/cadastro', '/api/auth/senha', '/api/auth/login', '/api/auth/session', '/api/auth/logout'].includes(request.path)) return next();
      try { await this.user(requestToken(request)); response.setHeader('Cache-Control', 'private, no-store'); next(); }
      catch (error) {
        const status = error instanceof ForbiddenException ? 403 : 401;
        response.status(status).json({message: status === 403 ? 'Esta conta não tem acesso aos simulados.' : 'Entre com sua conta de professor.'});
      }
    };
  }
}
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get('config') config() { return this.auth.config(); }
  @Post('codigo') code(@Body('email') email: unknown, @Req() request: Request) { return this.auth.requestCode(email, request.ip || 'unknown'); }
  @Post('cadastro') signup(@Body('email') email: unknown, @Body('senha') password: unknown, @Req() request: Request) { return this.auth.signup(email,password,request.ip || 'unknown'); }
  @Post('senha') password(@Body('email') email: unknown, @Body('senha') password: unknown, @Req() request: Request, @Res({passthrough:true}) response: Response) { return this.auth.passwordLogin(email,password,response,request.ip || 'unknown'); }
  @Post('login') login(@Body('email') email: unknown, @Body('codigo') code: unknown, @Body('cadastro') signup: unknown, @Res({passthrough: true}) response: Response) { return this.auth.login(email, code, response, signup === true); }
  @Post('logout') logout(@Res({passthrough: true}) response: Response) { return this.auth.logout(response); }
  @Post('session') session(@Body('access_token') token: unknown, @Res({passthrough: true}) response: Response) { return this.auth.session(token, response); }
}
