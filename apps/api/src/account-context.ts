import { AsyncLocalStorage } from 'node:async_hooks';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';

export interface AccountIdentity { id: string; email: string }
const context = new AsyncLocalStorage<AccountIdentity>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A identidade vem exclusivamente do Supabase Auth, nunca do corpo da requisição.
export function withAccount<T>(account: AccountIdentity, work: () => T): T {
  if (!UUID.test(account.id)) throw new UnauthorizedException('Identidade da conta inválida.');
  return context.run(account, work);
}
export function accountId(): string {
  return currentAccount().id;
}
export function currentAccount(): AccountIdentity {
  const account = context.getStore();
  if (!account) throw new UnauthorizedException('Entre com sua conta de professor.');
  return account;
}
export function retentionDays(): number {
  const days = Number(process.env.DATA_RETENTION_DAYS || '90');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new ServiceUnavailableException('Configure um prazo de armazenamento entre 1 e 365 dias.');
  return days;
}
export function dataExpiry(now = Date.now()): string {
  return new Date(now + retentionDays() * 86400_000).toISOString();
}
