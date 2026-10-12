import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AccountProfile, AccountRole, AccountsData } from '@enem/shared/src/accounts';
import { currentAccount } from './account-context';
import { accountProfile, accountRole, teacherAllowed, AuthService, type SupabaseAccount } from './auth';
import { DatabaseService } from './database.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new BadRequestException('Campos da conta inválidos.');
  return value as Record<string,unknown>;
}
function role(value: unknown): AccountRole {
  if (value !== 'admin' && value !== 'professor') throw new BadRequestException('Escolha o perfil Administrador ou Professor.');
  return value;
}
function name(value: unknown) {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new BadRequestException('Informe um nome de 2 a 120 caracteres.');
  return value.trim();
}
@Injectable()
export class AccountsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(DatabaseService) private readonly db: DatabaseService) {}
  private administrator() {
    const account = currentAccount();
    if (account.role !== 'admin') throw new ForbiddenException('Somente administradores podem gerenciar usuários.');
    return account;
  }
  private async locked<T>(work: () => Promise<T>) {
    return this.db.transaction(async () => {
      // A linha é bloqueada até o fim da transação, também entre instâncias da API.
      const result = await this.db.run("UPDATE account_admin_locks SET revision=revision+1 WHERE scope='roles'");
      if (!result.changes) throw new ServiceUnavailableException('A administração de contas ainda não foi preparada.');
      // Revalida o papel armazenado no provedor após obter o lock; não confia num JWT antigo.
      const acting = this.administrator();
      const live = await this.auth.adminRequest<SupabaseAccount>('admin/users/' + acting.id);
      if (accountRole(live) !== 'admin' || !teacherAllowed(live)) throw new ForbiddenException('Sua permissão de administrador foi alterada. Entre novamente.');
      return work();
    });
  }
  async list(): Promise<AccountsData> {
    this.administrator();
    const users = await this.auth.providerAccounts();
    const usuarios = users.filter(user => accountRole(user)).map(user => accountProfile(user) as AccountProfile)
      .sort((a,b) => a.nome.localeCompare(b.nome,'pt-BR') || a.email.localeCompare(b.email));
    return {usuarios,total:usuarios.length};
  }
  async create(value: unknown): Promise<AccountProfile> {
    const acting = this.administrator(), input = object(value,['email','nome','senha','role']);
    const accountRole = role(input.role), nome = name(input.nome);
    if (typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new BadRequestException('Informe um e-mail válido.');
    const email = input.email.trim().toLowerCase();
    if (typeof input.senha !== 'string' || input.senha.length < 8 || input.senha.length > 128) throw new BadRequestException('A senha inicial deve ter entre 8 e 128 caracteres.');
    const password = input.senha;
    await this.auth.quota('admin-create:' + acting.id,3600_000,20);
    return this.locked(async () => {
      const existing = (await this.auth.providerAccounts()).find(user => user.email?.toLowerCase() === email);
      if (existing) throw new ConflictException('Já existe uma conta com este e-mail. Altere o perfil da conta existente.');
      const created = await this.auth.adminRequest<SupabaseAccount>('admin/users','POST',{
        email,password,email_confirm:false,app_metadata:{role:accountRole},user_metadata:{display_name:nome},
      });
      if (created.email?.toLowerCase() !== email || roleFrom(created) !== accountRole) throw new ServiceUnavailableException('Não foi possível confirmar a criação da conta. Confira a lista antes de tentar novamente.');
      return accountProfile(created) as AccountProfile;
    });
  }
  async changeRole(id: string, value: unknown): Promise<AccountProfile> {
    const acting = this.administrator(), input = object(value,['role']), nextRole = role(input.role);
    if (!UUID.test(id)) throw new BadRequestException('Identidade da conta inválida.');
    if (id === acting.id && nextRole !== 'admin') throw new ConflictException('Você não pode remover sua própria permissão de administrador.');
    await this.auth.quota('admin-role:' + acting.id,3600_000,30);
    return this.locked(async () => {
      const users = await this.auth.providerAccounts(), target = users.find(user => user.id === id);
      if (!target || !roleFrom(target)) throw new NotFoundException('Conta não encontrada.');
      if (roleFrom(target) === 'admin' && nextRole !== 'admin') {
        const remaining = users.filter(user => user.id !== id && roleFrom(user) === 'admin' && !!user.email_confirmed_at && !(user.banned_until && new Date(user.banned_until).getTime() > Date.now()));
        if (!remaining.length) throw new ConflictException('Mantenha ao menos um administrador com e-mail confirmado.');
      }
      const updated = await this.auth.adminRequest<SupabaseAccount>('admin/users/' + id,'PUT',{app_metadata:{...target.app_metadata,role:nextRole}});
      if (updated.id !== id || roleFrom(updated) !== nextRole) throw new ServiceUnavailableException('Não foi possível confirmar a alteração de perfil. Atualize a lista.');
      return accountProfile(updated) as AccountProfile;
    });
  }
  async updateProfile(value: unknown): Promise<AccountProfile> {
    const acting = currentAccount(), input = object(value,['nome']), nome = name(input.nome);
    await this.auth.quota('profile-name:' + acting.id,3600_000,20);
    const previous = await this.auth.adminRequest<SupabaseAccount>('admin/users/' + acting.id);
    if (!teacherAllowed(previous)) throw new ForbiddenException('Esta conta não tem acesso aos simulados.');
    const updated = await this.auth.adminRequest<SupabaseAccount>('admin/users/' + acting.id,'PUT',{user_metadata:{...previous.user_metadata,display_name:nome}});
    if (updated.id !== acting.id) throw new ServiceUnavailableException('Não foi possível atualizar o perfil.');
    return accountProfile(updated) as AccountProfile;
  }
}
function roleFrom(user: SupabaseAccount) { return accountRole(user); }
