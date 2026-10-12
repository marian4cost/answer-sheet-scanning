export type AccountRole = 'admin' | 'professor';
export interface AccountProfile {
  id: string; email: string; nome: string; role: AccountRole;
  email_confirmado: boolean; criado_em: string | null; ultimo_acesso: string | null;
}
export interface AccountsData { usuarios: AccountProfile[]; total: number }
export interface CreateAccount { email: string; nome: string; senha: string; role: AccountRole }
