import { BadRequestException, Body, Controller, Get, Inject, Injectable, Post, Res, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { SUPABASE_URL } from './config';

const COOKIE = 'enem_session';
export function authRequired() {
  if (process.env.AUTH_ENABLED === 'false') return false;
  return process.env.AUTH_ENABLED === 'true' || !!process.env.VERCEL;
}
function cookieSecure() { return !!process.env.VERCEL || authRequired(); }
export function teacherAllowed(user: {email?: string; app_metadata?: {role?: string}}) {
  const allowed = (process.env.TEACHER_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return !!user.email && (allowed.includes(user.email.toLowerCase()) || user.app_metadata?.role === 'teacher');
}
export function requestToken(request: Request) {
  const bearer = request.get('authorization');
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7);
  const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='));
  return cookie?.slice(COOKIE.length + 1) || '';
}

@Injectable()
export class AuthService {
  config() { return {required: authRequired(), configured: !!SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY}; }
  private async call(path: string, body?: object, token?: string) {
    if (!this.config().configured) throw new UnauthorizedException('O acesso dos professores ainda não foi configurado.');
    let result: globalThis.Response;
    try {
      result = await fetch(SUPABASE_URL + '/auth/v1/' + path, {method: body ? 'POST' : 'GET',
        headers: {apikey: process.env.SUPABASE_ANON_KEY!, 'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
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
    if (!teacherAllowed({email})) throw new ForbiddenException('Esta conta não tem acesso aos simulados.');
    return email;
  }
  async requestCode(value: unknown) {
    const email = this.email(value);
    const web = process.env.WEB_URL || (process.env.CORS_ORIGINS || '').split(',')[0];
    const redirect = web ? '?redirect_to=' + encodeURIComponent(web.replace(/\/$/, '') + '/login') : '';
    await this.call('otp' + redirect, {email, create_user: true});
    return {message: 'Confira seu e-mail. Use o link de acesso ou informe o código, se ele estiver presente na mensagem.'};
  }
  async login(rawEmail: unknown, rawCode: unknown, response: Response) {
    const email = this.email(rawEmail);
    if (typeof rawCode !== 'string' || !/^\d{6,10}$/.test(rawCode.trim())) throw new BadRequestException('Informe o código recebido por e-mail.');
    const session = await this.call('verify', {email, token: rawCode.trim(), type: 'email'});
    await this.user(session.access_token);
    response.cookie(COOKIE, session.access_token, {httpOnly: true, secure: cookieSecure(), sameSite: 'lax', path: '/', maxAge: Math.min(Number(session.expires_in) || 3600, 3600) * 1000});
    return {email};
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
      if (!authRequired()) { response.setHeader('Cache-Control', 'private, no-store'); return next(); }
      if (request.method === 'OPTIONS' || ['/api/health', '/api/auth/config', '/api/auth/codigo', '/api/auth/login', '/api/auth/session', '/api/auth/logout'].includes(request.path)) return next();
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
  @Post('codigo') code(@Body('email') email: unknown) { return this.auth.requestCode(email); }
  @Post('login') login(@Body('email') email: unknown, @Body('codigo') code: unknown, @Res({passthrough: true}) response: Response) { return this.auth.login(email, code, response); }
  @Post('logout') logout(@Res({passthrough: true}) response: Response) { return this.auth.logout(response); }
  @Post('session') session(@Body('access_token') token: unknown, @Res({passthrough: true}) response: Response) { return this.auth.session(token, response); }
}
