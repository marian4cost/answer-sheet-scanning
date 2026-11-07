# Variáveis de ambiente do SIRENIA

Catálogo conferido com o código, Dockerfiles, Compose e scripts; domínio público atualizado em **02/11/2026** para `https://sirenia.morea-ifs.org`. Comece pelo [roteiro de entrega AWS](ENTREGA-AWS.md); os procedimentos estão no [guia operacional](GUIA-AWS.md).

## Onde configurar

| Ambiente | Arquivo/local | Como é utilizado |
|---|---|---|
| Local sem Docker | `.env` na raiz, baseado em `.env.example` | NestJS, configuração de build do Next.js e scripts locais. Preserve um arquivo existente. |
| AWS com Docker | `infra/aws/runtime/.env` | Criado por `node infra/aws/generate-env.mjs`; fornecido a todos os comandos com `--env-file`. O Compose passa a cada contêiner somente as variáveis declaradas em `environment`. |
| Migração de banco | Arquivos privados de origem e destino | `--source-env` e `--target-env` selecionam os arquivos; não são variáveis de ambiente. |
| Migração de arquivos | `.env` da origem e `infra/aws/runtime/.env` do destino | Caminhos fixos em `scripts/migrate-aws-storage.mjs`. |
| Produção Vercel atual | Variáveis dos três projetos Vercel | Interface, API e Python têm configurações distintas; consulte o README. Não copiar essas credenciais para o novo Auth. |

O arquivo AWS **não é carregado automaticamente pelo NestJS**. Adicionar uma linha a ele não a injeta no contêiner se ela não estiver declarada no Compose. O ambiente exportado no shell tem precedência na interpolação sobre `--env-file`; execute os comandos em um terminal sem variáveis antigas conflitantes. Não use `source` no dotenv. [Interpolação do Compose](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

`docker compose ... config --quiet` valida sem imprimir segredos. `config`, `config --environment`, `docker inspect` e `env` podem exibir senhas/chaves; não publique essas saídas. Os arquivos `runtime/`, `.env`, `.env.cloud`, dumps e artefatos são ignorados pelo Git e pelo build Docker. Transfira segredos por canal privado e restrinja o arquivo a modo `600` e a pasta a `700`.

## Entradas do arquivo AWS

As linhas abaixo são geradas pelo script. Segredos e inventários reais da infraestrutura nunca entram neste documento. Regiões, bucket, endereço de resposta e configuration set começam vazios, a menos que sejam fornecidos ao gerador pelas variáveis correspondentes do terminal; preencha-os no arquivo privado antes de validar o Compose. “Obrigatória” significa necessária à configuração fornecida, mesmo quando o gerador já a preenche.

| Variável | Obrigatória / sigilosa | Valor gerado ou formato | Uso e alteração |
|---|---|---|---|
| `POSTGRES_PASSWORD` | Sim / segredo | Aleatório, 64 caracteres hexadecimais | Senha do superusuário do PostgreSQL; somente `db`. Não é entregue à API. |
| `APP_DB_PASSWORD` | Sim / segredo | Aleatório, 64 caracteres hexadecimais | Senha de `sirenia_app`; `init-db.sh` cria o papel e Compose monta `DATABASE_URL` da API. |
| `AUTH_DB_PASSWORD` | Sim / segredo | Aleatório, 64 caracteres hexadecimais | Senha de `supabase_auth_admin`; Compose monta a conexão privada do GoTrue. |
| `AUTH_JWT_SECRET` | Sim / segredo | Aleatório, 96 caracteres hexadecimais | Assina o Auth auto-hospedado. As duas chaves abaixo são geradas com este mesmo segredo. |
| `SUPABASE_ANON_KEY` | Sim / manter no servidor neste stack | JWT gerado com role `anon` | NestJS chama o GoTrue. Não usar a chave do Supabase de origem no Auth novo. |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim / segredo administrativo | JWT gerado com role `service_role` | Provisionamento de contas e operações administrativas no Auth novo; nunca `NEXT_PUBLIC_*`. |
| `CRON_SECRET` | Sim / segredo | Aleatório, 64 caracteres hexadecimais; mínimo aceito: 32 | Mesmo valor em `api` e `cleanup`; autoriza a limpeza periódica. |
| `WEB_URL` | Sim / não | `https://sirenia.morea-ifs.org` | Origem pública HTTPS, sem `/api`; usada nos links dos alunos e no Auth. |
| `CORS_ORIGINS` | Sim / não | `https://sirenia.morea-ifs.org` | Origens exatas, separadas por vírgula e sem barra final. Atualizar se mudar o domínio. Não usar `*`. |
| `AWS_REGION` | Sim / inventário privado | Vazio; preencher a região do SES | Região do SES e alternativa de região para S3. Identidade, cota e configuration set do SES devem existir nela. |
| `S3_REGION` | Sim / inventário privado | Vazio; usa `AWS_REGION` se ela for fornecida ao gerador e `S3_REGION` não for | Região real do bucket existente; confirmar se é a mesma do SES. |
| `S3_BUCKET` | Sim / inventário privado | Vazio; preencher o nome do bucket | Bucket existente e privado; o código não cria o bucket nem altera a política. |
| `S3_PREFIX` | Sim / não | `sirenia/` | Prefixo exclusivo, terminado em `/`. O adapter aceita segmentos alfanuméricos, `_` e `-`; o script de backup atual exige um único segmento. Mudar exige adaptar IAM, lifecycle, migração e backup. |
| `STORAGE_MODE` | Sim / não | `s3` | Aceita `local`, `supabase` ou `s3`; use `s3` na implantação AWS. Os demais exigem armazenamento próprio correspondente. |
| `EMAIL_PROVIDER` | Intenção do arquivo / não | `ses` | O Compose fornecido fixa `ses` na API, sem interpolar esta linha. Alterar apenas o dotenv não troca o provedor; consulte a seção de valores fixos. |
| `EMAIL_FROM` | Sim / não | `SIRENIA <boletins@mage.dev.br>` | Remetente autorizado pelo domínio verificado e pela condição `ses:FromAddress` da política IAM. |
| `EMAIL_REPLY_TO` | Não / endereço de contato privado | Vazio; preencher o endereço de resposta | Recebe respostas dos alunos; um único endereço válido, sem nome de exibição. Não altera o remetente. |
| `SES_CONFIGURATION_SET` | Recomendado / inventário privado | Vazio; preencher o nome do configuration set | Nome do configuration set existente na região do SES. Se informado e inexistente, o envio é recusado. Vazio omite o campo. |
| `SES_RATE_PER_SECOND` | Não / não | `1` | Número maior que 0 e menor ou igual a 100; respeite a cota aprovada. O banco reserva os intervalos entre envios. Não aumenta a cota da AWS. |
| `REPORT_INSTITUTION` | Não / não | `Instituto Federal de Sergipe - Campus Lagarto` | Nome no boletim. UTF-8 e espaços são permitidos no dotenv. |
| `DATA_RETENTION_DAYS` | Não / não | `30` | Inteiro de 1 a 365. Prazo de novos simulados e contatos; não reescreve vencimentos de registros existentes. |
| `REPORT_LINK_TTL_DAYS` | Não / não | `30` | Inteiro de 1 a 30. Validade de novos links/reemissões; não renova links antigos. Envio/reemissão prolonga o simulado e o contato selecionado para cobrir esse prazo. |

O gerador usa criação exclusiva: uma segunda execução recusa sobrescrever `.env`. Não remova o arquivo para “corrigir a configuração”: perder as chaves/senhas pode impedir login e acesso ao volume existente. O banco aplica as senhas de `init-db.sh` **somente na primeira inicialização de um volume vazio**. Rotação posterior exige alterar os papéis no PostgreSQL e as configurações de seus clientes em conjunto. Rotacionar `AUTH_JWT_SECRET` exige gerar chaves compatíveis e planejar a invalidação das sessões. As chaves de serviço geradas têm validade própria de dez anos; guarde e planeje a rotação, sem confundir esse prazo com o login de sete dias.

### Opcionais reconhecidas pelo Compose

Não são escritas pelo gerador; podem ser acrescentadas ao mesmo arquivo.

| Variável | Padrão | Efeito |
|---|---|---|
| `IMAGE_TAG` | `aws` | Tag de `sirenia-api` e `sirenia-web`, incluindo `cleanup`. Use a mesma tag no build, transporte, atualização e rollback; uma identificação de release facilita voltar à imagem anterior. |
| `WEB_BIND_PORT` | `3080` | Porta publicada **somente em `127.0.0.1`** no host. Se alterar, ajustar o upstream do Nginx e os comandos de verificação. Não muda `WEB_PORT` nem a porta interna do contêiner. |

O nome do projeto Compose é `sirenia`; o volume padrão é `sirenia_postgres`. Não usar `COMPOSE_PROJECT_NAME` ou `-p` diferente sem planejar volumes, backup e testes, que esperam esse nome.

## Valores fixos ou derivados no Docker

Não colocar estas linhas no arquivo AWS esperando sobrescrever o Compose ou os Dockerfiles. Alterações exigem editar os arquivos de implantação, revisar e reconstruir/recriar os serviços afetados.

| Variável | Onde / valor efetivo na AWS | Motivo |
|---|---|---|
| `DATABASE_URL` | Compose/API: `postgres://sirenia_app:<APP_DB_PASSWORD>@db:5432/sirenia` | Rede Docker; banco com usuário separado, sem superusuário na API. |
| `DATABASE_SSL` | Compose/API: `false` | Somente tráfego interno entre contêineres no mesmo host. Em banco remoto/túnel, ver as regras da migração. |
| `AUTH_BASE_URL` | Compose/API: `http://auth:9999` | Endpoint GoTrue privado; não há gateway Supabase nessa instalação. |
| `EMAIL_PROVIDER` | Compose/API: `ses` | Nenhum fallback silencioso para EmailJS, SMTP ou Resend. |
| `TRUST_PROXY_CIDRS` | Compose/API: `loopback,uniquelocal` | API não publicada; confia nos proxies da rede privada. Revise se a topologia mudar. |
| `OMR_REMOTE_URL`, `OMR_REMOTE_SECRET` | Compose/API: vazios | Python/OpenCV roda dentro da imagem da API por stdin/stdout; não usa função Vercel. |
| `API_HOST`, `API_PORT` | Dockerfile/API: `0.0.0.0`, `3001` | Acesso apenas pela rede Docker. `EXPOSE` não publica a porta no host. |
| `PYTHON_EXECUTABLE` | Dockerfile/API: `/opt/venv/bin/python` | Ambiente Python da própria imagem. |
| `MEDIA_ROOT` | Dockerfile/API: `/app/media` | `tmpfs` temporário; os arquivos persistentes ficam no S3. Não guardar banco/backup aqui. |
| `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS` | Dockerfile/API: `1` | Contém a concorrência dos cálculos na máquina compartilhada. |
| `NODE_ENV` | Dockerfiles: `production` | Execução do build de produção. |
| `PYTHONUNBUFFERED` | Definida pelo NestJS ao iniciar o worker: `1` | Comunicação imediata com o worker, sem configuração manual. |
| `API_BASE_URL` | Dockerfile/web, **build**: `http://api:3001` | Rewrites de `/api` e `/media`. Precisa rebuild se o endpoint interno mudar. |
| `NEXT_STANDALONE` | Dockerfile/web, **build**: `true` | Produz a saída standalone do Next.js. |
| `NEXT_TELEMETRY_DISABLED` | Dockerfile/web: `1` | Telemetria de build/runtime desativada na imagem. |
| `HOSTNAME`, `PORT` | Dockerfile/web: `0.0.0.0`, `3000` | Servidor Next.js standalone. Não substituem a porta do host `WEB_BIND_PORT`. |
| `POSTGRES_DB`, `POSTGRES_USER` | Compose/db: `sirenia`, `postgres` | Banco e usuário usados por inicialização e backup. Alterar exige revisar os scripts. |

### GoTrue (Auth auto-hospedado)

Todas são passadas pelo Compose ao serviço `auth`; mantenha a versão e o digest fixados no arquivo. A chave de servidor não é uma senha de usuário. [Configuração oficial do Auth](https://supabase.com/docs/guides/self-hosting/auth/config).

| Variáveis | Valores no Compose / finalidade |
|---|---|
| `GOTRUE_API_HOST`, `GOTRUE_API_PORT` | `0.0.0.0`, `9999`, apenas rede Docker. |
| `API_EXTERNAL_URL`, `GOTRUE_SITE_URL` | Derivadas de `WEB_URL`. Não publica os endpoints GoTrue pelo Nginx. |
| `GOTRUE_DB_DRIVER`, `GOTRUE_DB_NAMESPACE` | `postgres`, `auth`. |
| `GOTRUE_DB_DATABASE_URL` | `postgres://supabase_auth_admin:<AUTH_DB_PASSWORD>@db:5432/sirenia`. |
| `GOTRUE_JWT_SECRET` | Derivada de `AUTH_JWT_SECRET`. |
| `GOTRUE_JWT_EXP` | `3600` segundos; access token curto, renovado pelo refresh token. |
| `GOTRUE_JWT_AUD`, `GOTRUE_JWT_DEFAULT_GROUP_NAME` | `authenticated`. A role da aplicação continua em `app_metadata.role`. |
| `GOTRUE_JWT_ADMIN_ROLES` | `service_role`; não é a role de professor/admin da interface. |
| `GOTRUE_DISABLE_SIGNUP` | `true`; sem cadastro público. |
| `GOTRUE_EXTERNAL_EMAIL_ENABLED` | `true`; login por e-mail/senha habilitado. |
| `GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED` | `false`; sem contas anônimas. |
| `GOTRUE_MAILER_AUTOCONFIRM` | `false`; o administrador confirma a conta ao provisioná-la (`email_confirm:true`). Não é necessário configurar SMTP GoTrue para login por senha ou para códigos enviados pelo NestJS via SES. |
| `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED` | `true`; renovação rotativa. |
| `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL` | `10` segundos de tolerância de reutilização. |
| `GOTRUE_SESSIONS_TIMEBOX` | `168h`; no stack AWS há limite absoluto de sete dias da sessão no provedor. O cookie de refresh da aplicação também tem sete dias entre renovações; a timebox pode exigir novo login mesmo com uso contínuo. |
| `GOTRUE_LOG_LEVEL` | `warn`; não elevar para diagnóstico indiscriminado em produção. |

## Variáveis fora do stack AWS completo

Servem à execução local, à produção Vercel atual ou à migração. **Não são necessárias no runtime AWS fornecido**, exceto nos arquivos de migração indicados. Padrões abaixo são os do código quando não há substituição pelo Docker.

| Variável | Padrão / formato / finalidade |
|---|---|
| `DATABASE_URL` | Vazia usa SQLite. Preenchida ativa PostgreSQL e tem precedência sobre `DATABASE_PATH`. URI com usuário/senha; sigilosa. Escape caracteres reservados no componente da senha. |
| `DATABASE_SSL` | `true` habilita TLS com validação de certificado; ausente/`false` não usa TLS. Usar `true` para o Supabase de origem e banco remoto com TLS. |
| `DATABASE_SSL_CA_BASE64` | Opcional, CA oficial PEM codificada em base64; mantém validação de hostname/cadeia. Nunca usar `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| `DATABASE_PATH` | `db.sqlite3`, relativo à raiz; só SQLite ou scripts de migração SQLite. |
| `MEDIA_ROOT` | `media/` local; `/tmp/enem-media` na Vercel. Diretório temporário quando Storage remoto. |
| `PYTHON_EXECUTABLE` | `venv/bin/python`, relativo à raiz; worker local. |
| `API_HOST`, `API_PORT`, `WEB_PORT` | `127.0.0.1`, `3001`, `3000`. Portas locais; não usar como forma de alterar a publicação do Compose. |
| `API_BASE_URL` | URL da API sem `/api` ou barra final; padrão `http://127.0.0.1:<API_PORT>`. Lida pelo Next.js no **build**; recompile após alterar. |
| `OMR_REMOTE_URL` | Vazia usa worker local. Na Vercel, HTTPS da função Python terminada em `/api/omr`. |
| `OMR_REMOTE_SECRET` | Segredo compartilhado entre API e função Python remota; não necessário ao worker local. |
| `SUPABASE_URL` | Origem HTTPS do Supabase gerenciado. Deriva `AUTH_BASE_URL=<SUPABASE_URL>/auth/v1` quando não há endpoint explícito; usada pelo Storage de origem. |
| `AUTH_BASE_URL` | Opcional; endpoint GoTrue completo que substitui a derivação de `SUPABASE_URL`. |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Chaves do projeto gerenciado **de origem**, apenas nesses ambientes. A segunda é administrativa e sigilosa. Na migração de arquivos, precisa ler o bucket privado de origem. |
| `SUPABASE_STORAGE_BUCKET` | `omr-private`; bucket Supabase privado. Usado também na migração dos arquivos e validação da função Python remota. |
| `TRUST_PROXY_CIDRS` | Fora da Vercel, padrão `loopback`; lista de proxies confiáveis. Não expor a API diretamente ao confiar em redes privadas. |
| `WEB_URL`, `CORS_ORIGINS` | Origem pública e allowlist, como descritas no arquivo AWS; na Vercel, use URLs reais da instalação atual. |
| `REPORT_INSTITUTION`, `DATA_RETENTION_DAYS`, `REPORT_LINK_TTL_DAYS`, `CRON_SECRET` | Mesmas regras das entradas AWS. Na Vercel, cron configurado às 08h UTC; no Docker, `cleanup` a cada seis horas. |
| `EMAIL_PROVIDER` | `auto` ou ausente: EmailJS → Resend → SMTP para boletins. `ses`: somente SES para boletins e códigos. Qualquer outro valor é rejeitado. Login por código em modo `auto` usa EmailJS ou fallback do Auth, não Resend/SMTP dos boletins. |
| `EMAILJS_ENABLED` | Somente a string `false` suspende EmailJS; sem ela, precisa das quatro variáveis seguintes para ficar configurado. Não suspende login por senha nem desativa autenticação. |
| `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID` | Identificadores do serviço e template. Necessários somente ao EmailJS. |
| `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY` | Credenciais do EmailJS; manter ambas no servidor. Template recebe `subject`, `to_email`, `message_html`; permitir chamadas não navegador com chave privada. |
| `RESEND_API_KEY` | Segredo da API Resend; habilita boletins em modo `auto` se EmailJS não estiver configurado. |
| `EMAIL_FROM` | Remetente; necessário a SES, Resend ou SMTP. |
| `SMTP_FROM` | Alternativa a `EMAIL_FROM` no modo legado; não substitui `EMAIL_FROM` no SES. |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | Servidor e credenciais SMTP dos boletins; senha sigilosa. Não configuram o SMTP interno do Supabase/GoTrue. |
| `SMTP_PORT`, `SMTP_SECURE` | `587`, `false`; STARTTLS obrigatório. Porta `465` ou `SMTP_SECURE=true` usa TLS desde a conexão. |
| `EMAIL_REPLY_TO` | Opcional para SES, SMTP e Resend; não é configuração do template EmailJS. |
| `AWS_DEFAULT_REGION` | Alternativa a `AWS_REGION` no SES; no Compose usar explicitamente `AWS_REGION`. Para S3, configure `S3_REGION` de forma explícita. |
| `MIGRATION_MEDIA_ROOT` | `media/`; origem dos espelhos para migração SQLite `--include-media`. Não participa da cópia Supabase → S3. |
| `PGLITE_MODULE_PATH` | Opcional; caminho alternativo do módulo PGlite para `scripts/test-postgres-schema.mjs`; normalmente não precisa configurar. |
| `NEXT_STANDALONE` | Somente `true` ativa saída standalone no build Next.js; já fixada no Docker. |
| `NODE_OPTIONS` | API Vercel: `--experimental-require-module`, para compatibilidade CommonJS/NestJS 12. Não necessário no Docker com o Node fixado. |
| `VERCEL` | Definida pela plataforma; altera pool, proxy, cookies e diretório temporário. Não definir manualmente na AWS. |
| `AUTH_ENABLED`, `AUTH_REGISTRATION_ENABLED`, `TEACHER_EMAILS` | Legadas, sem poder de desativar autenticação, abrir cadastro ou conceder role. Não adicionar ao arquivo AWS. |

## Credenciais AWS e variáveis da ferramenta

Na EC2, use o papel da instância com IMDSv2; a aplicação utiliza a cadeia padrão de credenciais do SDK. Não colocar chaves permanentes nos arquivos ou imagens. O Compose não encaminha credenciais do shell para os contêineres. [Credenciais IMDS](https://docs.aws.amazon.com/sdkref/latest/guide/feature-imds-credentials.html).

| Variáveis | Regra operacional |
|---|---|
| `AWS_PROFILE` | Perfil SSO **do computador do operador**, definido em `AWS_PROFILE` no terminal privado. Não existe automaticamente em outra máquina; o responsável usa o próprio perfil autorizado. Não precisa estar no contêiner de produção. |
| `SES_DOMAIN` | Domínio verificado usado somente nos comandos AWS CLI do guia. Obter do inventário privado; não é uma variável da API nem é injetada no Compose. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | Apenas credenciais temporárias para um ensaio local autorizado, se necessário, por override privado e ignorado. Não são entradas do gerador nem do Compose de produção. |
| `AWS_EC2_METADATA_DISABLED` | Não definir `true` na EC2: impediria o SDK de obter o papel da instância. Conferir IMDSv2 e o hop limit adequado ao Docker com o responsável. |
| `COMPOSE_PROJECT_NAME` | Não sobrescrever `sirenia` na instalação fornecida; scripts de backup e teste dependem dos nomes resultantes. |
| `BASH_SOURCE` | Variável automática do Bash usada pelo backup para localizar o projeto. Não preencher no dotenv. |

### Variáveis internas do workflow Docker

Não são entradas de produção nem devem ser colocadas no dotenv AWS.

| Variável | Origem / finalidade |
|---|---|
| `DOCKER_BUILD_RECORD_UPLOAD` | Workflow: `false`, evita guardar o empacotamento binário do build como artefato. O cache mínimo de camadas continua disponível para builds seguintes. |
| `IMAGE`, `SERVICE` | Workflow: tag local `sirenia-api:ci`/`sirenia-web:ci` e serviço `api`/`web`, definidos pela matriz estática. |
| `EXPECTED_REVISION` | Workflow: commit do GitHub, comparado ao label OCI da imagem recém-construída. |
| `TEST_SERVICE` | Script de smoke test: repassado ao processo Node do contêiner para selecionar as verificações da API ou web. |

## Arquivos de migração e preservação de acesso

Banco de origem: `DATABASE_URL`, `DATABASE_SSL=true`, `DATABASE_SSL_CA_BASE64` quando exigida pela CA. Banco de destino: `DATABASE_URL` com privilégios para inserir em `auth` e `public`, `DATABASE_SSL` e CA conforme a conexão. Esse usuário privilegiado é exclusivo da migração; não substituir a credencial restrita da API.

Os scripts não fazem `source` nem carregam automaticamente variáveis exportadas no lugar dos arquivos selecionados. A migração de Storage lê `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_STORAGE_BUCKET` do `.env` de origem; lê `AWS_REGION`, `S3_REGION`, `S3_BUCKET` e `S3_PREFIX` do dotenv AWS. Use uma cópia dedicada do projeto para esse procedimento, preservando o `.env` local existente.

O domínio dos links enviados anteriormente **não muda ao migrar o banco ou alterar `WEB_URL`**. Preserve a rota antiga de boletim até o último vencimento ou planeje reemissão revisada. Não descarte a produção anterior antes de validar essa continuidade; detalhes no [roteiro de entrega](ENTREGA-AWS.md).
