import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SimuladoShare, SimuladoSharesData } from '@enem/shared';
import { DatabaseService } from './database.service';
import { SimuladosService } from './simulados.service';
import { AuthService, accountProfile, teacherAllowed } from './auth';
import { accountId, currentAccount } from './account-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_SQL = 'SELECT id,destinatario_id,email,nome,criado_em FROM simulado_shares';

@Injectable()
export class SimuladoSharesService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(SimuladosService) private readonly simulados: SimuladosService,
    @Inject(AuthService) private readonly auth: AuthService) {}

  async list(simuladoId: number): Promise<SimuladoSharesData> {
    const simulado = await this.simulados.get(simuladoId);
    const compartilhamentos = await this.db.all<SimuladoShare>(SHARE_SQL + ' WHERE simulado_id=? AND owner_id=? ORDER BY criado_em,id', simuladoId, accountId());
    return {simulado_id: simuladoId, expira_em: simulado.expira_em || null, compartilhamentos};
  }

  async share(simuladoId: number, raw: unknown): Promise<SimuladoShare> {
    // Autoriza antes de validar o e-mail: destinatários e terceiros não gerenciam acesso.
    await this.simulados.get(simuladoId);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'email')) throw new BadRequestException('Informe somente o e-mail do usuário com quem deseja compartilhar.');
    const input = raw as {email?: unknown};
    if (typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new BadRequestException('Informe um e-mail válido.');
    const email = input.email.trim().toLowerCase(), owner = currentAccount();
    if (email === owner.email.toLowerCase()) throw new BadRequestException('Você já é o proprietário deste simulado.');
    await this.auth.quota('simulado-share:' + owner.id, 3600_000, 60);
    const target = (await this.auth.providerAccounts()).find(user => user.email?.toLowerCase() === email && teacherAllowed(user));
    if (!target || !UUID.test(target.id)) throw new NotFoundException('Nenhum usuário com acesso ativo foi encontrado com este e-mail.');
    if (target.id.toLowerCase() === owner.id.toLowerCase()) throw new BadRequestException('Você já é o proprietário deste simulado.');
    const recipient = accountProfile(target);
    return this.db.transaction(async () => {
      // Usa o mesmo lock da exclusão para não conceder acesso a um simulado removido.
      if (this.db.dialect === 'postgres') await this.db.get('SELECT id FROM core_simulado WHERE id=? AND owner_id=? FOR UPDATE', simuladoId, owner.id);
      await this.simulados.get(simuladoId);
      const existing = await this.db.get<SimuladoShare>(SHARE_SQL + ' WHERE simulado_id=? AND owner_id=? AND destinatario_id=?', simuladoId, owner.id, recipient.id);
      if (existing) return existing;
      const count = await this.db.get<{total: number}>('SELECT COUNT(*) total FROM simulado_shares WHERE simulado_id=? AND owner_id=?', simuladoId, owner.id);
      if (Number(count?.total) >= 50) throw new BadRequestException('Este simulado já foi compartilhado com o limite de 50 usuários. Revogue um acesso para adicionar outro.');
      const grant: SimuladoShare = {id: randomUUID(), destinatario_id: recipient.id, email: recipient.email, nome: recipient.nome || '', criado_em: new Date().toISOString()};
      await this.db.run(`INSERT INTO simulado_shares(id,simulado_id,owner_id,destinatario_id,email,nome,proprietario_email,proprietario_nome,criado_em)
        VALUES(?,?,?,?,?,?,?,?,?)`, grant.id, simuladoId, owner.id, grant.destinatario_id, grant.email, grant.nome, owner.email, owner.nome || '', grant.criado_em);
      return grant;
    });
  }

  async revoke(simuladoId: number, grantId: string) {
    await this.simulados.get(simuladoId);
    if (!UUID.test(grantId)) throw new BadRequestException('Compartilhamento inválido.');
    const deleted = await this.db.run('DELETE FROM simulado_shares WHERE id=? AND simulado_id=? AND owner_id=?', grantId.toLowerCase(), simuladoId, accountId());
    if (!deleted.changes) throw new NotFoundException('Compartilhamento não encontrado.');
    return {message: 'Compartilhamento revogado. O usuário não tem mais acesso a este simulado.'};
  }
}
