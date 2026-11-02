import { BadRequestException, Body, Controller, Get, Inject, Injectable, Post, Res, Req, Optional, UnauthorizedException, ForbiddenException, HttpException, ServiceUnavailableException, ConflictException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AUTH_BASE_URL } from './config';
import { DatabaseService } from './database.service';
import { EmailJsService } from './emailjs.service';
import { SesService } from './ses.service';
import { sha256 } from './contacts.service';
import { withAccount, currentAccount, type AccountIdentity, type AccountRole } from './account-context';

const COOKIE = 'enem_session';
const REFRESH_COOKIE = 'enem_refresh';
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
type ProviderSession = {access_token:string;refresh_token:string;expires_in:number};
function credential(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 8000 && !/[\s\x00-\x1f\x7f;,]/.test(value); }
function cookieValue(request: Request, name: string): string {
  const part = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
  try { return part ? decodeURIComponent(part.slice(name.length + 1)) : ''; } catch { return ''; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface SupabaseAccount {
  id: string; email?: string; email_confirmed_at?: string | null; created_at?: string; last_sign_in_at?: string | null;
  banned_until?: string | null; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown>;
}
export function authRequired() { return true; }
function cookieSecure() { return !!process.env.VERCEL || authRequired(); }
export function accountRole(user: Pick<SupabaseAccount, 'app_metadata'>): AccountRole | null {
  const role = user.app_metadata?.role;
  return role === 'admin' ? 'admin' : role === 'professor' || role === 'teacher' ? 'professor' : null;
}
export function teacherAllowed(user: Pick<SupabaseAccount, 'email' | 'email_confirmed_at' | 'app_metadata' | 'banned_until'>) {
  const banned = user.banned_until && new Date(user.banned_until).getTime() > Date.now();
  return !!user.email && !!user.email_confirmed_at && !!accountRole(user) && !banned;
}
export function accountProfile(user: SupabaseAccount): AccountIdentity {
  const role = accountRole(user);
  if (!UUID.test(user.id) || typeof user.email !== 'string' || !role) throw new UnauthorizedException('Identidade da conta inválida.');
  const rawName = user.user_metadata?.display_name;
  // O nome editável é apenas apresentação; role vem dos metadados protegidos do servidor.
  const nome = typeof rawName === 'string' ? rawName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120).trim() : '';
  return {id:user.id, email:user.email.toLowerCase(), role, nome, email_confirmado:!!user.email_confirmed_at,
    criado_em:typeof user.created_at === 'string' ? user.created_at : null,
    ultimo_acesso:typeof user.last_sign_in_at === 'string' ? user.last_sign_in_at : null};
}
export function requestToken(request: Request) {
  const bearer = request.get('authorization');
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7);
  return cookieValue(request, COOKIE);
}

@Injectable()
export class AuthService {
  private readonly renewing = new Map<string,Promise<{session:ProviderSession;user:AccountIdentity}>>();
  constructor(@Optional() @Inject(DatabaseService) private readonly db?: DatabaseService, @Optional() @Inject(EmailJsService) private readonly emailjs?: EmailJsService, @Optional() @Inject(SesService) private readonly ses?: SesService) {}
  config() { return {required:true, configured:!!AUTH_BASE_URL && !!process.env.SUPABASE_ANON_KEY, registration_enabled:false}; }
  private async call(path: string, body?: object, token?: string, admin = false, method?: 'GET'|'POST'|'PUT'|'DELETE') {
    if (!this.config().configured) throw new UnauthorizedException('O acesso dos professores ainda não foi configurado.');
    const key = admin ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY;
    if (!key) throw new ServiceUnavailableException('A administração de contas ainda não foi configurada.');
    let result: globalThis.Response;
    try {
      result = await fetch(AUTH_BASE_URL.replace(/\/$/, '') + '/' + path, {method:method || (body ? 'POST' : 'GET'),
        headers:{apikey:key,'Content-Type':'application/json',...(token || admin ? {Authorization:'Bearer ' + (token || key)} : {})},
        ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(10_000)});
    } catch { throw new ServiceUnavailableException('O serviço de acesso não respondeu. Tente novamente.'); }
    if (result.status === 204 && ((admin && method === 'DELETE') || path === 'logout?scope=local')) return {};
    const data = await result.json().catch(() => null);
    if (result.status >= 500 || result.status === 429 || (result.ok && !data)) throw new ServiceUnavailableException('O serviço de acesso está temporariamente indisponível. Tente novamente.');
    if (!result.ok || !data) {
      if (admin && result.status === 422 && ['email_exists','email_address_not_authorized','user_already_exists'].includes(data?.code)) throw new ConflictException('Já existe uma conta com este e-mail, ou o endereço não pode ser utilizado.');
      if (admin && result.status === 404) throw new BadRequestException('Conta não encontrada.');
      throw new UnauthorizedException('Não foi possível validar o acesso. Confira o código ou as credenciais e tente novamente.');
    }
    return data;
  }
  async adminRequest<T>(path: string, method: 'GET'|'POST'|'PUT'|'DELETE' = 'GET', body?: object): Promise<T> {
    if (!/^admin\/users(?:\/[0-9a-f-]{36}|\?page=\d+&per_page=200)?$/i.test(path)) throw new BadRequestException('Operação de contas inválida.');
    if (method === 'DELETE' && !/^admin\/users\/[0-9a-f-]{36}$/i.test(path)) throw new BadRequestException('Selecione uma conta para excluir.');
    return this.call(path, body, undefined, true, method) as Promise<T>;
  }
  async providerAccounts(): Promise<SupabaseAccount[]> {
    const users: SupabaseAccount[] = [];
    for (let page=1; page<=50; page++) {
      const data = await this.adminRequest<{users:SupabaseAccount[]}>('admin/users?page=' + page + '&per_page=200');
      if (!Array.isArray(data.users)) throw new ServiceUnavailableException('Não foi possível consultar as contas.');
      users.push(...data.users);
      if (data.users.length < 200) return users;
    }
    throw new ServiceUnavailableException('A consulta de contas excedeu o limite. Entre em contato com o administrador.');
  }
  async user(token: string) {
    if (!credential(token)) throw new UnauthorizedException('Entre com sua conta de professor.');
    // Consulta a identidade atual no provedor a cada requisição, incluindo revogação de role.
    const user = await this.call('user', undefined, token) as SupabaseAccount;
    if (!teacherAllowed(user)) throw new ForbiddenException('Esta conta não tem acesso aos simulados.');
    return accountProfile(user);
  }
  private email(value: unknown) {
    if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new BadRequestException('Informe seu e-mail de professor.');
    return value.trim().toLowerCase();
  }
  private password(value: unknown) {
    if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new BadRequestException('A senha deve ter entre 8 e 128 caracteres.');
    return value;
  }
  async quota(scope: string, milliseconds: number, max: number) {
    if (!this.db) return;
    const now = Date.now(), start = now - milliseconds;
    const row = await this.db.get<{total:number}>(`INSERT INTO auth_attempt_limits(scope_hash,window_at,total) VALUES(?,?,1)
      ON CONFLICT(scope_hash) DO UPDATE SET total=CASE WHEN auth_attempt_limits.window_at<=? THEN 1 ELSE auth_attempt_limits.total+1 END,
      window_at=CASE WHEN auth_attempt_limits.window_at<=? THEN ? ELSE auth_attempt_limits.window_at END
      WHERE auth_attempt_limits.window_at<=? OR auth_attempt_limits.total<? RETURNING total`, sha256(scope), now, start, start, now, start, max);
    if (!row) throw new HttpException('Muitas tentativas. Aguarde antes de solicitar novamente.',429);
  }
  private async sendCode(email: string) {
    const generated = await this.call('admin/generate_link', {type:'magiclink',email}, undefined, true);
    if (typeof generated.email_otp !== 'string' || !/^\d{6,10}$/.test(generated.email_otp)) throw new ServiceUnavailableException('Não foi possível gerar o código de confirmação.');
    const html = `<div style="font:16px Arial,sans-serif;color:#172033;max-width:600px;margin:auto"><p>SIRENIA — Instituto Federal de Sergipe - Campus Lagarto</p><p>Use este código para acessar sua conta:</p><p style="font-size:32px;letter-spacing:5px;font-weight:bold">${generated.email_otp}</p><p>O código é de uso único e expira em até uma hora. Se você não solicitou o acesso, ignore esta mensagem.</p></div>`;
    if (process.env.EMAIL_PROVIDER === 'ses') await this.ses!.send(email,'Seu código de acesso - SIRENIA',html,`SIRENIA — Seu código de acesso: ${generated.email_otp}. O código é de uso único e expira em até uma hora. Se você não solicitou o acesso, ignore esta mensagem.`);
    else await this.emailjs!.send(email,'Seu código de acesso - SIRENIA',html);
    return {message:'Confira seu e-mail e informe o código de acesso. Ele é de uso único.'};
  }
  // Mantido somente como rejeição explícita para clientes antigos; não há endpoint de cadastro.
  async signup(_email: unknown, _password: unknown, _ip = 'unknown'): Promise<never> {
    throw new ForbiddenException('Novas contas são criadas pelo administrador em Configurações.');
  }
  async passwordLogin(rawEmail: unknown, rawPassword: unknown, response: Response, ip = 'unknown') {
    const email = this.email(rawEmail), password = this.password(rawPassword);
    await this.quota('password-ip:' + ip,600_000,20);
    await this.quota('password-email:' + email,600_000,10);
    const session = await this.call('token?grant_type=password',{email,password});
    const user = await this.user(session.access_token);
    if (user.email.toLowerCase() !== email) throw new UnauthorizedException('Credenciais inválidas.');
    this.setSessionCookies(session,response);
    return user;
  }
  async requestCode(value: unknown, ip = 'unknown') {
    if (process.env.EMAIL_PROVIDER && !['auto','ses'].includes(process.env.EMAIL_PROVIDER)) throw new ServiceUnavailableException('O provedor de e-mail está configurado incorretamente.');
    const email = this.email(value);
    await this.quota('code-ip:' + ip,3600_000,10);
    await this.quota('code-email:' + email,60_000,1);
    // generate_link pode criar usuários; somente o chamamos após confirmar a conta administrada existente.
    const existing = (await this.providerAccounts()).find(user => user.email?.toLowerCase() === email);
    if (!existing || !accountRole(existing) || (existing.banned_until && new Date(existing.banned_until).getTime() > Date.now())) throw new ForbiddenException('Esta conta não tem acesso aos simulados. Solicite uma conta ao administrador.');
    if (process.env.EMAIL_PROVIDER === 'ses') {
      if (!this.ses?.configured()) throw new ServiceUnavailableException('O Amazon SES ainda não foi configurado para enviar os códigos.');
      return this.sendCode(email);
    }
    if (this.emailjs?.configured()) return this.sendCode(email);
    const web = process.env.WEB_URL || (process.env.CORS_ORIGINS || '').split(',')[0];
    const redirect = web ? '?redirect_to=' + encodeURIComponent(web.replace(/\/$/,'') + '/login') : '';
    await this.call('otp' + redirect,{email,create_user:false});
    return {message:'Confira seu e-mail. Use o link de acesso ou informe o código, se ele estiver presente na mensagem.'};
  }
  async login(rawEmail: unknown, rawCode: unknown, response: Response, signup = false) {
    if (signup) throw new ForbiddenException('Novas contas são criadas pelo administrador.');
    const email = this.email(rawEmail);
    if (typeof rawCode !== 'string' || !/^\d{6,10}$/.test(rawCode.trim())) throw new BadRequestException('Informe o código recebido por e-mail.');
    await this.quota('verify-email:' + email,600_000,10);
    const session = await this.call('verify',{email,token:rawCode.trim(),type:'email'});
    const user = await this.user(session.access_token);
    if (user.email.toLowerCase() !== email) throw new UnauthorizedException('Código inválido para este e-mail.');
    this.setSessionCookies(session,response);
    return user;
  }
  private setCookie(token: string, expires: unknown, response: Response) {
    response.cookie(COOKIE,token,{httpOnly:true,secure:cookieSecure(),sameSite:'lax',path:'/',maxAge:Math.max(1,Math.min(Number(expires) || 3600,3600))*1000});
  }
  private setSessionCookies(session: ProviderSession, response: Response) {
    if (!credential(session.access_token) || !credential(session.refresh_token) || !Number.isFinite(session.expires_in) || session.expires_in <= 0) throw new UnauthorizedException('Sessão de acesso inválida. Entre novamente.');
    this.setCookie(session.access_token,session.expires_in,response);
    response.cookie(REFRESH_COOKIE,session.refresh_token,{httpOnly:true,secure:cookieSecure(),sameSite:'lax',path:'/',maxAge:SESSION_AGE});
  }
  private clearCookies(response: Response) {
    for (const name of [COOKIE,REFRESH_COOKIE]) response.clearCookie(name,{httpOnly:true,secure:cookieSecure(),sameSite:'lax',path:'/'});
  }
  private renew(refresh: string) {
    if (!credential(refresh)) throw new UnauthorizedException('Entre com sua conta de professor.');
    // Une renovações simultâneas nesta instância; o Supabase mantém a rotação
    // e a tolerância documentada de reutilização entre instâncias/abas.
    const key = sha256(refresh), pending = this.renewing.get(key);
    if (pending) return pending;
    const work = (async () => {
      const session = await this.call('token?grant_type=refresh_token',{refresh_token:refresh}) as ProviderSession;
      const user = await this.user(session.access_token);
      if (!credential(session.refresh_token) || !Number.isFinite(session.expires_in) || session.expires_in <= 0) throw new UnauthorizedException('Sessão de acesso inválida. Entre novamente.');
      return {session,user};
    })().finally(() => {this.renewing.delete(key);});
    this.renewing.set(key,work);
    return work;
  }
  async logout(response: Response, request?: Request) {
    this.clearCookies(response);
    if (request) {
      let token = requestToken(request);
      const refresh = request.get('authorization') ? '' : cookieValue(request,REFRESH_COOKIE);
      try {
        if (!credential(token) && credential(refresh)) token = (await this.renew(refresh)).session.access_token;
        if (credential(token)) {
          try {await this.call('logout?scope=local',{},token);}
          catch (error) {
            if (!(error instanceof UnauthorizedException) || !credential(refresh)) throw error;
            await this.call('logout?scope=local',{},(await this.renew(refresh)).session.access_token);
          }
        }
      } catch { /* O navegador é desconectado mesmo se o provedor estiver indisponível. */ }
    }
    return {ok:true};
  }
  async session(rawToken: unknown, response: Response, rawRefresh?: unknown) {
    if (!credential(rawToken)) throw new BadRequestException('Link de acesso inválido.');
    const user = await this.user(rawToken);
    if (rawRefresh !== undefined) {
      if (!credential(rawRefresh)) throw new BadRequestException('Link de acesso inválido.');
      const renewed = await this.renew(rawRefresh);
      if (renewed.user.id !== user.id) throw new UnauthorizedException('As credenciais não pertencem à mesma conta. Entre novamente.');
      this.setSessionCookies(renewed.session,response);
      return renewed.user;
    }
    // Compatibilidade com links antigos sem renovação: não misture a credencial
    // de uma conta anterior com o novo access token.
    response.clearCookie(REFRESH_COOKIE,{httpOnly:true,secure:cookieSecure(),sameSite:'lax',path:'/'});
    this.setCookie(rawToken,3600,response);
    return user;
  }
  private async authenticated(request: Request, response: Response) {
    try { return await this.user(requestToken(request)); }
    catch (error) {
      if (!(error instanceof UnauthorizedException) || request.get('authorization')) throw error;
      const refresh = cookieValue(request,REFRESH_COOKIE);
      if (!refresh) throw error;
      const renewed = await this.renew(refresh);
      this.setSessionCookies(renewed.session,response);
      return renewed.user;
    }
  }
  middleware() {
    return async (request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Cache-Control','private, no-store');
      const publicReport = (request.method === 'POST' && ['/api/boletim/consultar','/api/boletim/pdf'].includes(request.path)) || (request.method === 'GET' && request.path === '/api/boletim/limpar');
      if (publicReport) { response.setHeader('Referrer-Policy','no-referrer'); response.setHeader('X-Robots-Tag','noindex, nofollow, noarchive'); return next(); }
      if (request.method === 'OPTIONS' || ['/api/health','/api/auth/config','/api/auth/codigo','/api/auth/senha','/api/auth/login','/api/auth/session','/api/auth/logout'].includes(request.path)) return next();
      try { const account = await this.authenticated(request,response); withAccount(account,() => next()); }
      catch (error) {
        const status = error instanceof ServiceUnavailableException ? 503 : error instanceof ForbiddenException ? 403 : 401;
        if (status !== 503 && !request.get('authorization')) this.clearCookies(response);
        response.status(status).json({message:status === 503 ? 'O serviço de acesso está temporariamente indisponível. Tente novamente.' : status === 403 ? 'Esta conta não tem acesso aos simulados.' : 'Entre com sua conta de professor.'});
      }
    };
  }
}
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get('config') config() { return this.auth.config(); }
  @Get('me') me() { return currentAccount(); }
  @Post('codigo') code(@Body('email') email: unknown, @Req() request: Request) { return this.auth.requestCode(email,request.ip || 'unknown'); }
  @Post('senha') password(@Body('email') email: unknown, @Body('senha') password: unknown, @Req() request: Request, @Res({passthrough:true}) response: Response) { return this.auth.passwordLogin(email,password,response,request.ip || 'unknown'); }
  @Post('login') login(@Body('email') email: unknown, @Body('codigo') code: unknown, @Body('cadastro') signup: unknown, @Res({passthrough:true}) response: Response) { return this.auth.login(email,code,response,signup === true); }
  @Post('logout') logout(@Req() request: Request, @Res({passthrough:true}) response: Response) { return this.auth.logout(response,request); }
  @Post('session') session(@Body('access_token') token: unknown, @Body('refresh_token') refresh: unknown, @Res({passthrough:true}) response: Response) { return this.auth.session(token,response,refresh); }
}
