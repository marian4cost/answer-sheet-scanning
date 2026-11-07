# SIRENIA na AWS: implantação, migração e operação

Procedimentos atualizados em **07/11/2026**. Para assumir a instalação, comece pelo [roteiro de entrega](ENTREGA-AWS.md) e pelo [catálogo de todas as variáveis](VARIAVEIS-AMBIENTE.md). O inventário abaixo mantém sua data original; o responsável precisa confirmá-lo na conta. A infraestrutura integra a `main` pela [PR #1](https://github.com/GenissonEmilio/enem-leitor/pull/1). O responsável já publicou `https://sirenia.morea-ifs.org`; a primeira verificação HTTP apontou pendências de origem/Auth, detalhadas no roteiro. Os comandos de instalação continuam como referência; preserve a configuração de proxy e os dados que o operador já colocou em uso.

## O que cada serviço faz

- **EC2** é a máquina Linux. Docker executa Next.js (site), NestJS (API + Python/OpenCV), PostgreSQL e GoTrue (autenticação) em contêineres separados. Um quinto contêiner faz a limpeza periódica.
- **S3** guarda as provas e imagens de revisão em um bucket privado. O prefixo definido em `S3_PREFIX` separa os arquivos dos outros projetos do bucket indicado em `S3_BUCKET`.
- **SES** envia os códigos de acesso e os links individuais dos boletins. A aplicação registra o MessageId real aceito pela AWS.
- **Registro.br** administra o DNS. O sistema usará `sirenia.morea-ifs.org`; configure o remetente verificado em `EMAIL_FROM` e o endereço de resposta em `EMAIL_REPLY_TO`, no arquivo privado de ambiente.
- **Nginx e Let's Encrypt**, no servidor, terminam o HTTPS e encaminham somente esse domínio ao Next.js em `127.0.0.1:3080`.

PostgreSQL, GoTrue e Nest não publicam portas na máquina. O navegador usa o mesmo domínio para o site e `/api`. As chaves administrativas permanecem no servidor. Docker facilita reproduzir versões e atualizar; ele não aumenta a memória disponível nem substitui backups.

## Situação verificada em 24/10/2026

Versão compartilhável do inventário: a conta, regiões reais, nomes internos, IPs, IDs e números de chamados ficam no inventário privado do responsável pela AWS. Consulte esse responsável para obter os valores; não os inclua em documentação, exemplos ou screenshots compartilhados.

| Recurso | Resultado |
|---|---|
| Servidor da aplicação | EC2 Linux existente; confirmar endereço, identificação e capacidade pelo inventário privado |
| Acesso à máquina | Bloqueado: a sessão SSO não pode usar SSM nem EC2 Instance Connect; chave SSH não fornecida |
| Banco existente | MySQL de outro projeto; não será reutilizado como PostgreSQL |
| Bucket | Privado; nome e região definidos no ambiente privado. Quatro bloqueios de acesso público ativados |
| DNS do e-mail | DKIM, MX/SPF do MAIL FROM e DMARC configurados no provedor DNS |
| SES | Domínio e MAIL FROM verificados; configuration set definido no ambiente privado e métricas no CloudWatch |
| SES produção | Pedido negado no inventário inicial; o responsável deve consultar o chamado pelo canal privado de suporte |
| Aplicação | Testada localmente em Docker, com banco e Auth próprios, S3 e SES reais |
| Publicação AWS | **Pendente de acesso e avaliação da capacidade do servidor**; a produção anterior permanece preservada |

O papel associado à EC2 precisa de acesso ao prefixo S3 e permissão de envio SES. `infra/aws/instance-policy.json` é um template sem identificadores reais: copie-o para `infra/aws/runtime/instance-policy.json` e substitua os marcadores `__AWS_REGION__`, `__AWS_ACCOUNT_ID__`, `__SES_DOMAIN__`, `__SES_CONFIGURATION_SET__`, `__EMAIL_FROM_ADDRESS__`, `__S3_BUCKET__` e `__S3_PREFIX__` usando o inventário privado. O prefixo deve terminar em `/`, e o endereço de remetente não inclui o nome de exibição. Se não usar configuration set, remova somente a entrada correspondente do array `Resource` na cópia privada. A política com marcadores não deve ser aplicada. Preserve o escopo dos recursos e as permissões existentes de outros sistemas; não use curingas para substituir conta, bucket ou domínio.

## 1. Acesso e capacidade antes de instalar

Peça ao responsável pelo ambiente:

> Preciso de acesso SSH ao servidor Linux reservado ao SIRENIA, ou de uma sessão SSM habilitada. Envie a identificação do servidor e as orientações de acesso por canal privado. Confirme a capacidade disponível e autorize o envio SES pelo papel da instância, limitado ao remetente configurado para a aplicação.

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

Observe os serviços existentes, portas, disco, memória e proxy. Em uma máquina compartilhada de pouca memória, os limites máximos dos contêineres, somados ao sistema operacional e outros projetos, podem exceder a capacidade disponível. **Não iniciar o stack em produção sem medir a folga e confirmar a capacidade com o supervisor.** O teste local não demonstra que uma máquina compartilhada de 2 GB suporta a carga. As imagens devem ser construídas no computador de desenvolvimento, evitando o pico de compilação na EC2.

## 2. Autenticação AWS sem chaves permanentes

No computador de desenvolvimento, defina `AWS_PROFILE` no terminal com o nome do seu perfil SSO autorizado, obtido com o responsável. Para os comandos SES da seção 6, defina também `AWS_REGION` e `SES_DOMAIN` com a região e o domínio verificado do inventário privado. `SES_DOMAIN` é usado apenas nos comandos do operador, não pela aplicação.

```bash
aws sso login --profile "$AWS_PROFILE"
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

O nome do papel não garante todas as permissões: confira as ações necessárias. A saída de `get-caller-identity` contém identificadores da conta e não deve ser publicada.

Na EC2, use o **instance profile**. Não copie a sessão SSO, o arquivo `aws-test.env` ou access keys para produção. O SDK obtém credenciais temporárias pelo papel da máquina; o IMDSv2 já é obrigatório e o hop limit é 2 para permitir o uso em Docker.

## 3. Preparar Docker e os segredos

Instale Docker Engine e Compose a partir da documentação oficial para Debian e a AWS CLI pelo instalador oficial. Não substitua o proxy nem reinstale Docker sobre uma instalação da equipe sem inspecioná-la.

Na cópia do projeto reservada à aplicação:

```bash
node infra/aws/generate-env.mjs
```

Esse comando precisa de Node.js 22.23+ no computador de preparação e cria `infra/aws/runtime/.env`, com permissão 600, senhas aleatórias distintas para PostgreSQL e Auth, chaves do serviço e segredo de cron. Recusa sobrescrever o arquivo existente. Guarde uma cópia segura fora do servidor; o arquivo é ignorado pelo Git e pelo build Docker. Revise domínio e remetente. Antes de validar o Compose, preencha `AWS_REGION`, `S3_REGION` e `S3_BUCKET` no arquivo privado; eles começam vazios. `EMAIL_REPLY_TO` e `SES_CONFIGURATION_SET` também começam vazios. Esses cinco campos podem ser fornecidos ao gerador por variáveis do terminal; valores reais não devem ser incluídos no Git. Não use `source` nesse arquivo: ele segue o formato dotenv e contém valores com espaços. As imagens prontas incluem Node/Python; o host EC2 não precisa desses runtimes para executá-las.

O [catálogo](VARIAVEIS-AMBIENTE.md) diferencia entradas do arquivo e valores fixos. O Compose define `EMAIL_PROVIDER=ses`, `AUTH_BASE_URL=http://auth:9999`, a conexão privada de banco e o worker Python local; acrescentar linhas ao `.env` não sobrescreve esses valores. Uma variável exportada no shell pode, porém, substituir uma interpolação do Compose. Para validar a configuração sem exibir senhas:

```bash
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml config --quiet
```

Não execute `config` sem `--quiet` em logs compartilhados. Não gere novas senhas por cima de um volume existente: `init-db.sh` só cria os papéis na primeira inicialização. A rotação precisa ser coordenada entre banco e clientes.

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

As imagens usam a arquitetura escolhida no build. Confirme que é compatível com a EC2 (o servidor inventariado é x86_64). Se usar `IMAGE_TAG`, acrescente-o ao arquivo AWS antes do build e use a mesma tag no `docker save/load` e no servidor. Não construir outra arquitetura sem verificar as wheels Python e testar as imagens resultantes.

## 5. Migrar os dados preservando usuários e senhas

Faça primeiro um ensaio em um destino vazio, com backup da origem. Durante o corte final, interrompa novas alterações na produção antiga para não criar registros depois do snapshot. A origem permanece intacta nos scripts de migração.

Inicie a API nova apenas para preparar as tabelas públicas; interrompa-a durante a cópia. Não crie usuários no destino antes da migração. O Auth já deve ter criado suas tabelas. Não inicie `cleanup` antes de finalizar a migração e conferir os vencimentos: a primeira limpeza acontece assim que esse serviço sobe.

```bash
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml up -d --wait --wait-timeout 180 api
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml ps
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml stop api
```

O primeiro comando aguarda a API saudável; se falhar, diagnostique antes de migrar. Ela aplica `assets/schema.sql` automaticamente com o papel da aplicação; `auth` prepara seu próprio schema. Não aplicar dump indiscriminado de todos os schemas do Supabase gerenciado sobre esse banco.

Prepare um arquivo privado `infra/aws/runtime/migration.env` com `DATABASE_URL` do PostgreSQL novo e `DATABASE_SSL=false` **somente para conexão pela rede privada Docker ou túnel SSH local**. Para conexões fora desse limite, use TLS e a CA correta. O PostgreSQL não deve ganhar uma porta pública para migrar.

Os scripts abaixo rodam em um ambiente com as dependências Node instaladas (`npm ci`) e acesso às duas conexões, por exemplo no computador de desenvolvimento com um túnel SSH até a EC2. A origem padrão é o `.env` atual, com TLS e CA preservados. O usuário do destino para a migração precisa inserir em `auth` e `public`; não usar `sirenia_app` para isso nem transformar sua credencial no usuário permanente da API. A conexão `db:5432` funciona dentro do Docker, não no computador do operador. Use uma conexão/túnel autorizado ou um contêiner de migração na rede privada, sem publicar 5432 para a internet.

```bash
node scripts/migrate-aws-database.mjs --source-env .env --target-env infra/aws/runtime/migration.env
node scripts/migrate-aws-database.mjs --source-env .env --target-env infra/aws/runtime/migration.env --apply
```

O primeiro comando é uma prévia. O segundo copia apenas as tabelas do SIRENIA e `auth.users`/`auth.identities`, numa transação; recusa destino já preenchido, versões de schema incompatíveis e contas com MFA que precisem de procedimento próprio. Confere contagens, UUIDs, hashes de senha, roles e bloqueios, e ajusta as sequências. Sessões antigas não são copiadas: o usuário entra novamente com sua senha existente.

Os arquivos privados são copiados separadamente:

```bash
node scripts/migrate-aws-storage.mjs
node scripts/migrate-aws-storage.mjs --apply
```

O script percorre o bucket de origem, copia para o prefixo dedicado no S3 e confere SHA-256. Objetos diferentes existentes no destino são recusados. Nenhum arquivo da origem é apagado. Essas operações exigem uma sessão AWS com acesso ao bucket e a compilação da API (`npm run build -w @enem/api`).

Não corte o domínio antes de comparar dados, testar o login das contas migradas e conferir arquivos no S3.

Os scripts preservam UUIDs e as roles da aplicação. O administrador existente poderá criar novos usuários pela interface, com nome/e-mail/senha/role, sem confirmação de cadastro. Não é necessário criar outro administrador nem trocar as senhas dos usuários migrados. Para uma instalação realmente nova, sem migração de contas, ver a seção 11.

## 6. SES e DNS

No console AWS, selecione **a região definida em `AWS_REGION` → Amazon SES**. As identidades, cotas e configurações são regionais.

1. Em **Verified identities**, `mage.dev.br` deve aparecer verificado, com DKIM e MAIL FROM bem-sucedidos.
2. Em **Account dashboard**, confira o estado de produção. No sandbox só é possível enviar para destinatários verificados ou o mailbox simulator da AWS.
3. No inventário inicial, o pedido de produção foi negado. Um responsável com acesso ao suporte deve consultar o chamado correspondente pelo canal privado e responder com informações verdadeiras sobre o uso educacional, destinatários, revisão da planilha, supressão de bounces/reclamações e autenticação do domínio. Não existe liberação automática pelo código.
4. No sandbox, escolha um destinatário de teste autorizado. O titular confirma o endereço pelo link da mensagem da AWS, sem fornecer senha ao SIRENIA. Não publique seu endereço pessoal nas evidências.
5. Depois da aprovação, ajuste `SES_RATE_PER_SECOND` respeitando a cota real. A configuração inicial é 1/s.

Para verificar pelo terminal:

```bash
aws sesv2 get-account --profile "$AWS_PROFILE" --region "$AWS_REGION"
aws sesv2 get-email-identity --profile "$AWS_PROFILE" --region "$AWS_REGION" --email-identity "$SES_DOMAIN"
```

O SES usa a API HTTPS (porta 443), não SMTP: não precisa de `SMTP_USER`, `SMTP_PASS` nem liberar porta 25. As permissões de runtime são diferentes das permissões de administração do console. Revise `infra/aws/instance-policy.json` para permitir ao papel da EC2 o remetente, configuration set e prefixo S3 corretos. Na migração local, o operador usa seu próprio perfil SSO; o nome definido em `AWS_PROFILE` não existe automaticamente em outro computador.

O SES usa HTML e texto simples, remetente estável, autenticação DNS e Reply-To. Isso melhora autenticação e reputação, mas **não garante caixa de entrada nem elimina spam por si só**. A reputação depende também de destinatários corretos, reclamações e volume. Consulte métricas de BOUNCE/COMPLAINT/DELIVERY do configuration set indicado em `SES_CONFIGURATION_SET` no CloudWatch. A supressão de bounces e reclamações havia sido ativada no inventário; revalide seu estado e o alinhamento SPF/DKIM/DMARC na mensagem real recebida.

Uma resposta aceita do SES significa aceitação pelo provedor, não leitura pelo aluno. Timeouts e falhas 5xx permanecem ambíguos e não são reenviados automaticamente; o professor consulta o histórico. Recusas explícitas podem ser revistas e planejadas novamente. Selecionar `EMAIL_PROVIDER=ses` não faz fallback silencioso para EmailJS.

## 7. Publicar o site no domínio

Somente depois da instalação e verificação, crie no Registro.br um registro A de `sirenia.morea-ifs.org` para o IP autorizado da EC2. O IP atual não foi convertido em Elastic IP; confirme sua estabilidade com a equipe antes de usá-lo como endereço definitivo.

Integre `infra/aws/nginx-sirenia.conf` ao proxy existente, em um arquivo de site separado. Emita o certificado Let's Encrypt pelo procedimento já usado pela equipe. Não habilite a configuração HTTPS antes de o certificado existir. Valide com `sudo nginx -t` e recarregue o serviço; não sobrescreva os virtual hosts dos outros projetos.

```bash
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml up -d
curl --fail https://sirenia.morea-ifs.org/api/health
```

Abra o navegador, entre com uma conta migrada, confirme simulados/contatos/arquivos e faça um envio para um destinatário de teste aprovado. Só então encerre a janela de manutenção da produção anterior. Mantenha o ambiente anterior disponível para rollback, sem permitir escrita simultânea em duas bases.

Os links de boletim já enviados continuam apontando ao domínio Vercel original. `WEB_URL` só altera novos links: a migração de banco não redireciona os antigos e só armazena seus hashes. Preserve e teste a rota antiga até o último vencimento, encaminhando ao mesmo ambiente de dados ou planejando reemissão com revisão. O [roteiro de entrega](ENTREGA-AWS.md) detalha esse ponto de corte; não desligue a origem presumindo que o DNS novo resolveu links antigos.

## 8. Testes reproduzíveis

O GitHub executa `ci.yml` para compilar/testar a aplicação e `docker-build.yml` para construir as imagens e fazer smoke tests. O workflow Docker usa permissões somente de leitura, ações fixadas por SHA, `linux/amd64`, um build de imagem por vez e BuildKit limitado a dois trabalhos. Não há push para registry nem deploy automático por esse workflow. O smoke test roda sem rede externa, portas publicadas ou volumes, com limites de CPU/memória, e remove somente o contêiner que criou.

Para repetir o smoke test em imagens de teste já construídas:

```bash
bash scripts/test-docker-image.sh api sirenia-api:aws
bash scripts/test-docker-image.sh web sirenia-web:aws
```

Ele confere usuário sem root, ausência de arquivos privados, servidor standalone, worker OpenCV/PDFium, schema/fontes PDF e bloqueio de acesso/origens não autorizados. O SQLite desse teste é temporário e não substitui o aceite do PostgreSQL, Auth e SES reais.

O incidente GitGuardian `38956690` foi revisado em 02/11: o detector marcou o sufixo literal `?}@db:5432/sirenia` das duas URIs com interpolação de variável no Compose. Classificado no painel como **Not a secret (false positive)**. O arquivo versionado contém referências `${AUTH_DB_PASSWORD:?}`/`${APP_DB_PASSWORD:?}`, e o gerador escreve os valores reais somente no dotenv privado. O scanner permanece ativo; não foram adicionadas exclusões gerais nem alteradas senhas de produção para resolver esse falso positivo.

```bash
npm ci
npm run typecheck
npm run test -w @enem/api
venv/bin/python -m unittest discover -s python/tests -v
node scripts/test-postgres-schema.mjs
npm audit --omit=dev
```

O ensaio `scripts/test-aws-stack.mjs` é exclusivo para o stack Docker local, em `http://localhost:3080`, com dados fictícios. Cria usuários temporários pelo GoTrue, exige S3/SES configurados e envia somente ao mailbox simulator (`success@simulator.amazonses.com`). Os nomes `sirenia-api-1`, a porta e o diretório de saída são fixos no script. **Não executá-lo sobre o banco migrado de produção**. No computador de ensaio, com Python/dependências e Poppler (`pdftotext`) disponíveis:

```bash
venv/bin/python scripts/aws-test-fixtures.py artifacts/aws-migration-2026-10-24
node scripts/test-aws-stack.mjs
```

O stack de teste deve estar saudável antes do segundo comando. Fora da EC2, forneça credenciais AWS temporárias e restritas apenas em override local ignorado, passado explicitamente ao Compose; o arquivo fornecido não encaminha as variáveis AWS do shell para dentro do contêiner. Não copie esse override nem as sessões SSO para produção. O ensaio grava usuários, objetos e tokens de teste localmente; mantenha `artifacts/` privado e fora do Git. A conferência visual de PDFs e telas usa os dados fictícios.

O teste verifica login/cookies/isolamento, PNG, PDF de duas páginas com OCR de matrícula, 50/60 questões, branco/rasura, retomada, contatos, redação XLSX, critérios, tema extra, boletim PDF, exportação, revisão privada no S3, envio real SES e logout. Os testes de provedores verificam também assinatura, imutabilidade, tamanho máximo e falhas sem repetição indevida.

## 9. Backup, retenção e recuperação

O padrão de retenção de novos simulados/contatos é **30 dias**. Envio ou reemissão mantém o simulado e o contato selecionado pelo menos até o vencimento do novo link; não há um limite absoluto de 30 dias desde a criação quando o acesso é renovado. O contêiner `cleanup` remove vencidos a cada seis horas com um segredo interno. Mudar `DATA_RETENTION_DAYS` ou `REPORT_LINK_TTL_DAYS` não reescreve vencimentos existentes.

O template S3 expira objetos de `sirenia/` em 30 dias e backups em 7 dias, pela idade do objeto. Essa idade **não é renovada** ao estender um boletim no banco. O PDF é gerado em memória a partir dos dados, mas a imagem de revisão pode expirar antes de um link renovado. Alinhe a retenção de imagens com a equipe. A expiração do S3 é assíncrona e ocorre por dias completos. CORS/lifecycle do bucket compartilhado precisam ser mesclados às regras existentes; não aplicar o JSON do projeto substituindo regras de outros sistemas.

Faça backup antes de cada migração/upgrade e diariamente:

```bash
bash infra/aws/backup.sh
```

O dump é transmitido diretamente do PostgreSQL para o S3 com criptografia AES256, sem arquivo em texto no disco. Contém contas e hashes de senha: mantenha o bucket privado e limite o acesso ao prefixo. O script usa o papel da instância, sem senhas ou chaves AWS na linha de comando.

Depois de ajustar o caminho `/opt/sirenia` caso necessário, instale os templates do timer systemd no servidor e habilite `sirenia-backup.timer`. O horário é 06:15 UTC, aproximadamente 03:15 no horário de Fortaleza. Teste o serviço manualmente e confira o objeto no S3 antes de considerar o backup operacional.

```bash
sudo install -m 644 infra/aws/sirenia-backup.service /etc/systemd/system/sirenia-backup.service
sudo install -m 644 infra/aws/sirenia-backup.timer /etc/systemd/system/sirenia-backup.timer
sudo systemctl daemon-reload
sudo systemctl start sirenia-backup.service
sudo systemctl enable --now sirenia-backup.timer
sudo systemctl list-timers sirenia-backup.timer
```

Há atraso aleatório de até cinco minutos. O script depende da AWS CLI no host e lê bucket/prefixo/região no dotenv; mantenha esses três valores simples sem aspas, como o gerador escreve. O dump não contém o segredo JWT nem as senhas/chaves do arquivo de configuração: preservar separadamente esse arquivo é parte do plano de recuperação.

Para ensaiar recuperação, crie **um banco separado e vazio** e transmita um backup conhecido para `pg_restore --exit-on-error`. Os roles `postgres`, `sirenia_app` e `supabase_auth_admin` precisam existir antes, pois o dump preserva os donos das tabelas. Compare contagens, contas e respostas e teste login no ambiente restaurado. Não faça restauração destrutiva no banco em uso.

## 10. Atualizações e rollback

Faça backup, registre o commit e a tag das imagens. Construa novas imagens fora da EC2, carregue-as e execute `docker compose up -d` com a mesma configuração e volume. Confira `ps`, logs, `/api/health`, login, leitura e envio de teste.

Se a nova imagem falhar e o schema continuar compatível, carregue a imagem anterior e execute `up -d` novamente. Mudança incompatível de banco exige o plano de restauração ensaiado. Não apague a produção antiga até validar o corte.

Usar infraestrutura existente evita criar outra máquina automaticamente, mas não torna SES, S3, transferência entre regiões ou monitoramento gratuitos. Confirme limites e custos com o supervisor. Compare as regiões do bucket e da aplicação no inventário privado; regiões diferentes podem gerar transferência entre regiões.

## 11. Primeiro administrador, somente em instalação nova

**Pular esta seção se for migrar contas.** A migração conserva os administradores existentes e o destino precisa estar vazio. Para uma instalação nova já saudável, crie no host um arquivo privado `infra/aws/runtime/bootstrap-admin.json`, modo `600`, editado localmente com os dados do titular:

```json
{"email":"admin@example.com","password":"SUBSTITUIR_POR_SENHA_FORTE_UNICA","name":"Administrador"}
```

Não usar a senha de exemplo nem inserir a senha real no comando/histórico. A chamada abaixo só aceita um Auth vazio, acessa a rede privada pelo contêiner da API e não envia e-mail. O provisionamento confirma a conta por decisão administrativa, como a interface faz depois; não abre cadastro público.

```bash
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml exec -T api node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const account = JSON.parse(input);
  if (typeof account.email !== "string" || typeof account.password !== "string" || account.password.length < 8 || account.password.length > 128 || account.password === "SUBSTITUIR_POR_SENHA_FORTE_UNICA") throw Error("Revise o arquivo privado de provisionamento.");
  const base = process.env.AUTH_BASE_URL;
  const headers = {Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json"};
  const existing = await fetch(base + "/admin/users?page=1&per_page=1", {headers});
  if (!existing.ok) throw Error("Falha ao conferir Auth: HTTP " + existing.status);
  const listing = await existing.json();
  if (!Array.isArray(listing.users) || listing.users.length) throw Error("Auth já possui contas; usar administrador existente ou migração.");
  const created = await fetch(base + "/admin/users", {method:"POST", headers, body:JSON.stringify({email:account.email, password:account.password, email_confirm:true, app_metadata:{role:"admin"}, user_metadata:{display_name:account.name || "Administrador"}})});
  if (!created.ok) throw Error("Falha ao provisionar: HTTP " + created.status);
  console.log("Primeiro administrador criado. Teste o login por senha e remova o arquivo privado de provisionamento.");
' < infra/aws/runtime/bootstrap-admin.json
```

Depois de confirmar login no site HTTPS, remova apenas esse JSON privado e crie outras contas em **Configurações → Adicionar usuário**. Não usar esse procedimento para atribuir a si mesmo dados de outro professor ou mudar proprietários dos registros.

## Referências oficiais

- [Docker Engine no Debian](https://docs.docker.com/engine/install/debian/)
- [Autenticação com IAM Identity Center](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)
- [SES: saída do sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [SES: MAIL FROM personalizado](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [SES: SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html)
- [AWS: credenciais do papel da instância pelo IMDS](https://docs.aws.amazon.com/sdkref/latest/guide/feature-imds-credentials.html)
- [EC2: opções IMDSv2 e contêineres](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html)
- [Docker Compose: interpolação e precedência de variáveis](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
- [Supabase Auth auto-hospedado](https://supabase.com/docs/guides/self-hosting/auth/config)
- [Migração para ambiente auto-hospedado](https://supabase.com/docs/guides/self-hosting/restore-from-platform)
