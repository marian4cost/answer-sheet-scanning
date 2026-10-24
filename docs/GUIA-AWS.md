# SIRENIA na AWS: implantação, migração e operação

## O que cada serviço faz

- **EC2** é a máquina Linux. Docker executa Next.js (site), NestJS (API + Python/OpenCV), PostgreSQL e GoTrue (autenticação) em contêineres separados. Um quinto contêiner faz a limpeza periódica.
- **S3** guarda as provas e imagens de revisão em um bucket privado. O prefixo `sirenia/` separa os arquivos dos outros projetos do bucket `morea`.
- **SES** envia os códigos de acesso e os links individuais dos boletins. A aplicação registra o MessageId real aceito pela AWS.
- **Registro.br** administra o DNS. O sistema usará `sirenia.mage.dev.br`; o remetente será `boletins@mage.dev.br`, com resposta para `officegenisson@gmail.com`.
- **Nginx e Let's Encrypt**, no servidor, terminam o HTTPS e encaminham somente esse domínio ao Next.js em `127.0.0.1:3080`.

PostgreSQL, GoTrue e Nest não publicam portas na máquina. O navegador usa o mesmo domínio para o site e `/api`. As chaves administrativas permanecem no servidor. Docker facilita reproduzir versões e atualizar; ele não aumenta a memória disponível nem substitui backups.

## Situação verificada em 24/10/2026

Conta MOREA `924328993642`, região da aplicação `us-east-2` (Ohio).

| Recurso | Resultado |
|---|---|
| Morea-Server03 | EC2 `i-0ae9e50d65f455e35`, Debian 12, t2.small, 2 GB, IP 3.15.182.173 |
| Acesso à máquina | Bloqueado: a sessão SSO não pode usar SSM nem EC2 Instance Connect; chave SSH não fornecida |
| Banco existente | `trancadura-db` é MySQL, pertence a outro projeto e não será reutilizado como PostgreSQL |
| Bucket | `morea`, região `us-east-1`; quatro bloqueios de acesso público ativados |
| DNS do e-mail | Três CNAME DKIM, MX/SPF de `bounce.sirenia` e DMARC salvos no Registro.br |
| SES | Domínio e MAIL FROM verificados; configuração `sirenia`; métricas de envio/entrega/falha no CloudWatch |
| SES produção | Pedido negado; caso `179288506200738`. A sessão atual também não pode consultar os casos do suporte |
| Aplicação | Testada localmente em Docker, com banco e Auth próprios, S3 e SES reais |
| Publicação AWS | **Pendente de acesso e avaliação da capacidade do servidor**; a produção anterior permanece preservada |

A EC2 já possui o papel `AWS-EC2-S3-Role`, compartilhado com outros recursos, com acesso S3. Ele ainda precisa da permissão de envio SES. O arquivo `infra/aws/instance-policy.json` é a política mínima proposta para a aplicação; não remova permissões existentes de outros sistemas sem avaliação do responsável.

## 1. Acesso e capacidade antes de instalar

Peça ao responsável pelo ambiente:

> Preciso de acesso SSH ao Morea-Server03 (i-0ae9e50d65f455e35, Debian, usuário admin), ou de uma sessão SSM habilitada. A conta SSO genisson não possui ec2-instance-connect:SendSSHPublicKey nem acesso SSM. Confirme também que esse é o servidor reservado ao SIRENIA e autorize o envio SES pelo papel da instância, limitado a boletins@mage.dev.br.

Não envie a chave privada no chat ou no Git. Se receber um arquivo, guarde com permissão 600 e valide a identificação do host antes do primeiro SSH.

Depois de obter acesso, execute os comandos de inspeção:

```bash
free -h
df -h
docker ps
docker stats --no-stream
sudo ss -lntp
sudo nginx -T
```

Observe os serviços existentes, portas, disco, memória e proxy. A máquina tem apenas 2 GB; os limites máximos dos contêineres, somados ao sistema operacional e outros projetos, podem exceder isso. **Não iniciar o stack em produção sem medir a folga e confirmar a capacidade com o supervisor.** O teste local não demonstra que uma máquina compartilhada de 2 GB suporta a carga. As imagens devem ser construídas no computador de desenvolvimento, evitando o pico de compilação na EC2.

## 2. Autenticação AWS sem chaves permanentes

No computador de desenvolvimento:

```bash
aws sso login --profile sirenia-morea
aws sts get-caller-identity --profile sirenia-morea
```

O perfil SSO foi configurado nesta máquina para a conta MOREA, papel SystemAdministrator e região `us-east-2`. O nome do papel não garante todas as permissões: algumas ações foram recusadas.

Na EC2, use o **instance profile**. Não copie a sessão SSO, o arquivo `aws-test.env` ou access keys para produção. O SDK obtém credenciais temporárias pelo papel da máquina; o IMDSv2 já é obrigatório e o hop limit é 2 para permitir o uso em Docker.

## 3. Preparar Docker e os segredos

Instale Docker Engine e Compose a partir da documentação oficial para Debian e a AWS CLI pelo instalador oficial. Não substitua o proxy nem reinstale Docker sobre uma instalação da equipe sem inspecioná-la.

Na cópia do projeto reservada à aplicação:

```bash
node infra/aws/generate-env.mjs
```

Esse comando cria `infra/aws/runtime/.env`, com permissão 600, senhas aleatórias distintas para PostgreSQL e Auth, chaves do serviço e segredo de cron. Recusa sobrescrever o arquivo existente. Guarde uma cópia segura fora do servidor; o arquivo é ignorado pelo Git e pelo build Docker. Revise domínio, remetente, região e bucket. Não use `source` nesse arquivo: ele segue o formato dotenv e contém valores com espaços.

Os nomes `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` continuam por compatibilidade com o protocolo GoTrue; no stack AWS são chaves novas do **Auth auto-hospedado**, não uma dependência do Supabase gerenciado.

`AUTH_BASE_URL=http://auth:9999` é interno. A API não recebe a senha de superusuário do banco nem a senha do banco de Auth. O prazo máximo da sessão é 168 horas, com JWT de uma hora, renovação, cookies HttpOnly/Secure e contas criadas apenas pelo administrador.

## 4. Construir e transportar as imagens

No computador de desenvolvimento:

```bash
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml build api web
docker save sirenia-api:aws sirenia-web:aws | gzip > /caminho/privado/sirenia-images.tar.gz
```

Copie o arquivo de imagens e a pasta do projeto para `/opt/sirenia` por SSH/SCP, usando o acesso fornecido pela equipe. Copie os segredos separadamente e preserve as permissões. Não transfira `.env` antigo, dados de teste, sessões AWS, `node_modules`, dumps ou a pasta `artifacts` junto com o código.

Na EC2:

```bash
gunzip -c /caminho/privado/sirenia-images.tar.gz | docker load
cd /opt/sirenia
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml up -d db auth
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml ps
```

O volume `sirenia_postgres` é persistente. **Nunca use `docker compose down -v` em produção**: isso apaga o banco. Subir/atualizar os contêineres sem `-v` preserva o volume.

## 5. Migrar os dados preservando usuários e senhas

Faça primeiro um ensaio em um destino vazio, com backup da origem. Durante o corte final, interrompa novas alterações na produção antiga para não criar registros depois do snapshot. A origem permanece intacta nos scripts de migração.

Inicie a API nova apenas para preparar as tabelas públicas; interrompa-a durante a cópia. Não crie usuários no destino antes da migração. O Auth já deve ter criado suas tabelas.

Prepare um arquivo privado `infra/aws/runtime/migration.env` com `DATABASE_URL` do PostgreSQL novo e `DATABASE_SSL=false` **somente para conexão pela rede privada Docker ou túnel SSH local**. Para conexões fora desse limite, use TLS e a CA correta. O PostgreSQL não deve ganhar uma porta pública para migrar.

Os scripts abaixo rodam em um ambiente com as dependências Node instaladas e acesso às duas conexões, por exemplo no computador de desenvolvimento com um túnel SSH até a EC2. A origem padrão é o `.env` atual, com TLS e CA preservados.

```bash
node scripts/migrate-aws-database.mjs --source-env .env --target-env infra/aws/runtime/migration.env
node scripts/migrate-aws-database.mjs --source-env .env --target-env infra/aws/runtime/migration.env --apply
```

O primeiro comando é uma prévia. O segundo copia apenas as tabelas do SIRENIA e `auth.users`/`auth.identities`, numa transação; recusa destino já preenchido, versões de schema incompatíveis e contas com MFA que precisem de procedimento próprio. Confere contagens, UUIDs, hashes de senha, roles e bloqueios, e ajusta as sequências. Sessões antigas não são copiadas: o usuário entra novamente com sua senha existente.

Os arquivos privados são copiados separadamente:

```bash
AWS_PROFILE=sirenia-morea node scripts/migrate-aws-storage.mjs
AWS_PROFILE=sirenia-morea node scripts/migrate-aws-storage.mjs --apply
```

O script percorre o bucket de origem, copia para o prefixo dedicado no S3 e confere SHA-256. Objetos diferentes existentes no destino são recusados. Nenhum arquivo da origem é apagado. Essas operações exigem uma sessão AWS com acesso ao bucket e a compilação da API (`npm run build -w @enem/api`).

Não corte o domínio antes de comparar dados, testar o login das contas migradas e conferir arquivos no S3.

## 6. SES e DNS

No console AWS, selecione **Ohio / us-east-2 → Amazon SES**. As identidades, cotas e configurações são regionais.

1. Em **Verified identities**, `mage.dev.br` deve aparecer verificado, com DKIM e MAIL FROM bem-sucedidos.
2. Em **Account dashboard**, confira o estado de produção. No sandbox só é possível enviar para destinatários verificados ou o mailbox simulator da AWS.
3. O pedido de produção foi negado. Um responsável com acesso ao suporte deve abrir o caso `179288506200738`, consultar o motivo e responder com informações verdadeiras sobre o uso educacional, destinatários, revisão da planilha, supressão de bounces/reclamações e autenticação do domínio. Não existe liberação automática pelo código.
4. O destinatário de teste solicitado anteriormente foi `genisson.santos121@academico.ifs.edu.br`; a AWS enviou uma mensagem de verificação. O titular confirma clicando no link da mensagem, sem fornecer senha ao SIRENIA.
5. Depois da aprovação, ajuste `SES_RATE_PER_SECOND` respeitando a cota real. A configuração inicial é 1/s.

Para verificar pelo terminal:

```bash
aws sesv2 get-account --profile sirenia-morea --region us-east-2
aws sesv2 get-email-identity --profile sirenia-morea --region us-east-2 --email-identity mage.dev.br
```

O SES usa HTML e texto simples, remetente estável, DKIM/SPF alinhados, DMARC e Reply-To. Isso melhora autenticação e reputação, mas **não garante caixa de entrada nem elimina spam por si só**. A reputação depende também de destinatários corretos, reclamações e volume. Consulte métricas de BOUNCE/COMPLAINT/DELIVERY da configuração `sirenia` no CloudWatch. A supressão de bounces e reclamações está ativada na conta.

Uma resposta aceita do SES significa aceitação pelo provedor, não leitura pelo aluno. Timeouts e falhas 5xx permanecem ambíguos e não são reenviados automaticamente; o professor consulta o histórico. Recusas explícitas podem ser revistas e planejadas novamente. Selecionar `EMAIL_PROVIDER=ses` não faz fallback silencioso para EmailJS.

## 7. Publicar o site no domínio

Somente depois da instalação e verificação, crie no Registro.br um registro A de `sirenia.mage.dev.br` para o IP autorizado da EC2. O IP atual não foi convertido em Elastic IP; confirme sua estabilidade com a equipe antes de usá-lo como endereço definitivo.

Integre `infra/aws/nginx-sirenia.conf` ao proxy existente, em um arquivo de site separado. Emita o certificado Let's Encrypt pelo procedimento já usado pela equipe. Não habilite a configuração HTTPS antes de o certificado existir. Valide com `sudo nginx -t` e recarregue o serviço; não sobrescreva os virtual hosts dos outros projetos.

```bash
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml up -d
curl --fail https://sirenia.mage.dev.br/api/health
```

Abra o navegador, entre com uma conta migrada, confirme simulados/contatos/arquivos e faça um envio para um destinatário de teste aprovado. Só então encerre a janela de manutenção da produção anterior. Mantenha o ambiente anterior disponível para rollback, sem permitir escrita simultânea em duas bases.

## 8. Testes reproduzíveis

```bash
npm ci
npm run typecheck
npm run test -w @enem/api
venv/bin/python -m unittest discover -s python/tests -v
node scripts/test-postgres-schema.mjs
npm audit --omit=dev
```

O ensaio `scripts/test-aws-stack.mjs` é exclusivo para o stack Docker local, em `http://localhost:3080`, com dados fictícios. Cria usuários temporários pelo GoTrue, exige S3/SES configurados e envia somente ao mailbox simulator (`success@simulator.amazonses.com`). Gere antes os arquivos com `venv/bin/python scripts/aws-test-fixtures.py artifacts/aws-migration-2026-10-24`. As credenciais temporárias da AWS devem ser fornecidas apenas no override local ignorado; ele não faz parte do deploy.

O teste verifica login/cookies/isolamento, PNG, PDF de duas páginas com OCR de matrícula, 50/60 questões, branco/rasura, retomada, contatos, redação XLSX, critérios, tema extra, boletim PDF, exportação, revisão privada no S3, envio real SES e logout. Os testes de provedores verificam também assinatura, imutabilidade, tamanho máximo e falhas sem repetição indevida.

## 9. Backup, retenção e recuperação

A aplicação remove registros vencidos após **30 dias**. O contêiner `cleanup` executa a limpeza a cada seis horas com um segredo interno. O S3 tem regras específicas de `sirenia/` para expirar objetos em 30 dias e backups em 7 dias. A expiração do S3 é assíncrona e ocorre por dias completos; ela complementa a limpeza da aplicação.

Faça backup antes de cada migração/upgrade e diariamente:

```bash
bash infra/aws/backup.sh
```

O dump é transmitido diretamente do PostgreSQL para o S3 com criptografia AES256, sem arquivo em texto no disco. Contém contas e hashes de senha: mantenha o bucket privado e limite o acesso ao prefixo. O script usa o papel da instância, sem senhas ou chaves AWS na linha de comando.

Depois de ajustar o caminho `/opt/sirenia` caso necessário, instale os templates do timer systemd no servidor e habilite `sirenia-backup.timer`. O horário é 06:15 UTC, aproximadamente 03:15 no horário de Fortaleza. Teste o serviço manualmente e confira o objeto no S3 antes de considerar o backup operacional.

Para ensaiar recuperação, crie **um banco separado e vazio** e transmita um backup conhecido para `pg_restore --exit-on-error`. Os roles `postgres`, `sirenia_app` e `supabase_auth_admin` precisam existir antes, pois o dump preserva os donos das tabelas. Compare contagens, contas e respostas e teste login no ambiente restaurado. Não faça restauração destrutiva no banco em uso.

## 10. Atualizações e rollback

Faça backup, registre o commit e a tag das imagens. Construa novas imagens fora da EC2, carregue-as e execute `docker compose up -d` com a mesma configuração e volume. Confira `ps`, logs, `/api/health`, login, leitura e envio de teste.

Se a nova imagem falhar e o schema continuar compatível, carregue a imagem anterior e execute `up -d` novamente. Mudança incompatível de banco exige o plano de restauração ensaiado. Não apague a produção antiga até validar o corte.

Usar infraestrutura existente evita criar outra máquina automaticamente, mas não torna SES, S3, transferência entre regiões ou monitoramento gratuitos. Confirme limites e custos com o supervisor. O bucket existente está em `us-east-1`, enquanto a máquina está em `us-east-2`; essa diferença pode gerar transferência entre regiões.

## Referências oficiais

- [Docker Engine no Debian](https://docs.docker.com/engine/install/debian/)
- [Autenticação com IAM Identity Center](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)
- [SES: saída do sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [SES: MAIL FROM personalizado](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [SES: SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)
- [Supabase Auth auto-hospedado](https://supabase.com/docs/guides/self-hosting/auth/config)
- [Migração para ambiente auto-hospedado](https://supabase.com/docs/guides/self-hosting/restore-from-platform)
