# OMR Enem Reader

Corretor de simulados do **Instituto Federal de Sergipe - Campus Lagarto**: interface Next.js, backend NestJS e processamento Python/OpenCV. Aceita **50 a 60 questões**, alternativas A a E, histórico acumulado, desempenho por tema, Excel e boletins individuais.

O leitor localiza a grade e mede a tinta da própria folha. A chave do professor é usada depois da leitura para comparar respostas e calcular notas. O processamento não escolhe alternativas a partir da chave.

## Instalação local

Requisitos: **Node.js 22.23+** e **Python 3.12+**, com suporte às wheels de `python/requirements.txt`. PDFs usam PDFium/pypdfium2; não é necessário instalar Poppler ou Django.

Na raiz:

```bash
npm ci
python3 -m venv venv
venv/bin/python -m pip install -r python/requirements.txt
npm run build
npm start
```

Abra **http://localhost:3000**. A API local atende em `http://127.0.0.1:3001/api`. `./run_server.sh` também inicia e compila quando o build está ausente; `Ctrl+C` encerra os processos. Para desenvolvimento, use `npm run dev`.

Se precisar configurar caminhos ou portas, copie `.env.example` para `.env` **somente se ainda não houver `.env`**. Preserve os valores de um arquivo existente. O padrão local usa `db.sqlite3`, `media/`, `venv/bin/python` e autenticação desligada apenas em loopback. Uma `DATABASE_URL` preenchida ativa PostgreSQL. Após mudar `API_BASE_URL` ou as portas, recompile: as rewrites do Next.js são definidas no build.

## Gabarito, provas e matrículas

1. Cadastre título e quantidade: qualquer inteiro de **50 a 60**.
2. Envie a folha oficial e use **Ler folha para conferir**, ou escolha **Digitar gabarito**. Confira uma alternativa A a E por questão antes de salvar. Branco, dupla e leitura incerta não são aceitos como chave oficial.
3. Cadastre os intervalos de temas. Exemplo: 1–22 Linguagens e 25–30 Ciências da Natureza. Limites são inclusivos; sobreposições são rejeitadas. Lacunas ficam **Sem tema** e faixas com o mesmo nome têm desempenho agrupado.
4. Envie as provas e confira o campo **Matrícula** de cada arquivo. O nome do arquivo o preenche inicialmente; você pode corrigir antes do envio. Não há OCR de matrícula ou nome.
5. Confira resultados, alertas e espelhos. Envios novos se somam aos anteriores; reenvios da mesma matrícula ficam como provas distintas no histórico.

O cartão impresso tem duas colunas numeradas de cima para baixo: metade à esquerda e metade à direita. Em ímpares, a esquerda tem uma linha a mais: **50 = 25 + 25**, **55 = 28 + 27**, **60 = 30 + 30**. Também é aceito o modelo compatível de bolhas com quatro marcadores. A quantidade cadastrada deve corresponder à folha inteira; não há corte automático nem reconhecimento de todo formulário arbitrário.

Formatos: PDF, JPEG/JPG, PNG, WEBP, BMP e TIFF, até **20 MB/arquivo** e **50 arquivos/envio**. Há um cartão por arquivo; PDF usa a primeira página. Fotografias aplicam orientação EXIF e transparência sobre fundo branco, até 40 megapixels.

Na nuvem com Supabase Storage, a interface envia diretamente ao bucket privado por URLs de upload assinadas. A API recebe identificadores e processa lotes de até três provas por chamada. Lotes concluídos permanecem salvos se uma chamada seguinte falhar. Assim, imagens grandes não precisam passar no corpo das funções Vercel.

## Resultados e histórico

As notas objetivas são `acertos / total de questões × 100`, arredondadas a duas casas decimais. **Não é calculada a TRI do ENEM.** Cada tema considera somente suas questões.

**Nota geral** permanece na tabela junto às abas por tema. A pesquisa por matrícula funciona em todas. O status se refere à leitura da prova inteira:

| Status | Significado |
| --- | --- |
| `SUCESSO` | Leitura concluída; brancos são respostas válidas em branco (`BNK`). |
| `ALERTA_RASURA` | Marcação dupla (`RAS`), contabilizada como anulada. |
| `ALERTA_REVISAO` | Resposta incerta (`INC`); nota provisória. |
| `ERRO_LEITURA` | Grade ou arquivo não reconhecido; não são inventadas respostas. |

Incertezas e falhas ficam fora da média confirmada. O espelho conserva a tinta e a chave usada naquele envio. Alterar o gabarito atual não muda notas ou chaves anteriores. Editar temas reorganiza as provas armazenadas pelos temas atuais, mantendo a correção histórica.

O Excel inclui a tabela geral, todas as questões e uma aba por tema. Quando há temas, inclui também o mapeamento por questão e o desempenho consolidado. Falhas não viram nota confirmada de zero; notas provisórias são identificadas.

Excluir um simulado exige confirmação e remove envios, resultados, feedbacks e registros de boletins vinculados. Faça backups do banco e dos arquivos quando precisar conservar o histórico fora da aplicação.

## Contatos, redação e boletins

Em **Contatos**, baixe o modelo e preencha `matricula`, `email` e `nome` opcional. Aceita CSV ou XLSX com uma aba, até **2 MB** e **10.000 contatos**. Formate a matrícula como **Texto** no Excel: `000123` é diferente de `123`. Matrículas numéricas em XLSX, fórmulas, emails inválidos e duplicidades são rejeitados. A importação exige prévia e confirmação; nenhum contato é salvo parcialmente quando há erro. Alterações de contatos existentes são avisadas.

Exemplo fictício:

```csv
matricula,email,nome
000123,aluno@example.com,Aluno de exemplo
```

Em **Boletins**, revise cada prova. O documento inclui nota objetiva geral, temas e áreas Linguagens, Ciências da Natureza, Matemática e Ciências Humanas. Temas são associados às áreas por termos conhecidos; nomes sem associação ficam no detalhamento. Uma área sem faixas aparece como **Sem questões**, sem nota inventada.

A redação é corrigida fora da aplicação. O professor salva nota opcional de **0 a 1000** e feedback de até **10.000 caracteres** por prova. Campos vazios continuam não informados. O PDF usa um **modelo provisório**, preparado para receber o modelo final. `REPORT_INSTITUTION` configura a instituição.

Para enviar, selecione boletins aptos, clique em **Revisar destinatários**, confira matrículas, emails e PDFs e confirme o envio. Importar contatos ou salvar redação não envia mensagens. Incertezas, falhas e chave histórica incompleta bloqueiam o envio. Duplas são respostas anuladas.

O plano dura 15 minutos e está vinculado ao conteúdo e ao contato. Mudanças exigem nova revisão. Entregas do mesmo conteúdo ao mesmo destinatário são idempotentes. Sem confirmação do provedor, o histórico indica a pendência e o sistema não reenvia automaticamente; confira o provedor antes de outra entrega.

## Email opcional dos boletins

O envio só fica disponível com remetente e provedor configurados **no NestJS**:

| Provedor | Variáveis |
| --- | --- |
| SMTP | `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` |
| Resend | `EMAIL_FROM`, `RESEND_API_KEY` |

Use um remetente autorizado pelo provedor. `SMTP_FROM` é alternativa a `EMAIL_FROM`. O padrão SMTP é porta 587 com TLS exigido; 465 ou `SMTP_SECURE=true` usa TLS desde a conexão. Resend tem precedência quando `RESEND_API_KEY` existe. Credenciais não devem ir ao cliente ou a variáveis `NEXT_PUBLIC_*`.

Os testes simulam os provedores, sem enviar emails reais. Email de **boletim** é separado do email de **login** enviado pelo Supabase Auth.

## Login dos professores

Na Vercel, a API exige autenticação mesmo com `AUTH_ENABLED=false`. Sem configuração válida, o acesso aos dados fica bloqueado.

1. Configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `AUTH_ENABLED=true` e `TEACHER_EMAILS` na API. A allowlist contém emails exatos separados por vírgula; a comparação ignora caixa.
2. Habilite email no Supabase Auth. Ajuste o template **Magic Link** para mostrar **`{{ .Token }}`** (ou `{{.Token}}`): a interface recebe código OTP, não um link. Para contas novas, confira também o template de confirmação de cadastro.
3. Configure o endereço da interface nas URLs do Supabase e o serviço de email do Auth conforme sua conta.

Exemplo de template:

```html
<h2>Acesso do professor</h2>
<p>Informe este código na tela de acesso:</p>
<p><strong>{{ .Token }}</strong></p>
```

A tela `/login` solicita o código; o NestJS valida a sessão no Supabase antes de criar cookie `HttpOnly`, `SameSite=Lax`, seguro na nuvem, até uma hora. Fora da allowlist não é permitido solicitar OTP pela aplicação. Sessões com `app_metadata.role=teacher` validado pelo Supabase também são reconhecidas, mas o fluxo de login por código desta interface exige a allowlist. `user_metadata` editável pelo usuário não concede acesso de professor.

Referências oficiais: [templates Supabase](https://supabase.com/docs/guides/auth/auth-email-templates) e [login por email e OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless).

## Publicação Vercel e Supabase

Use **três projetos Vercel do mesmo repositório**. Os itens abaixo são configuração; substitua por URLs/credenciais da sua conta. Este arquivo não declara uma publicação ativa.

| Projeto | Root Directory | Build/entrada |
| --- | --- | --- |
| Interface | `apps/web` | Preset Next.js, `npm run build -w @enem/web`. |
| API | `apps/api` | `apps/api/vercel.json`, `npm run build -w @enem/api`, função `api/index.ts`. |
| OpenCV | `python` | `python/vercel.json`, `python/requirements.txt`, função `api/omr.py`. |

Use Node.js 22 na API e Python 3.12+ no OpenCV. Nos projetos Node, habilite **Include source files outside of the Root Directory in the Build Step**, para acessar lockfile e `packages/shared`. A API empacota `dist/**` e `assets/**`; preserve schema e fontes do PDF. [Monorepos Vercel](https://vercel.com/docs/monorepos/monorepo-faq).

Prepare Supabase, função OpenCV, API e interface, nessa ordem. Depois de obter a URL da interface, ajuste as origens da API. Mudanças em variáveis usadas no build do Next.js exigem novo deployment.

**Supabase:** obtenha a conexão PostgreSQL e aplique `infra/sql/001-schema.sql` com papel de servidor. O schema habilita RLS e remove acesso de `anon`/`authenticated` às tabelas da aplicação; não há policies públicas para alunos. O NestJS usa conexão de servidor. Configure bucket **privado** `omr-private` ou o nome de `SUPABASE_STORAGE_BUCKET`; o adapter verifica que não é público. Arquivos são acessados pela API autenticada ou URLs assinadas curtas para processamento.

**API NestJS:**

```text
DATABASE_URL                 conexão PostgreSQL real do Supabase
DATABASE_SSL=true
STORAGE_MODE=supabase
SUPABASE_URL                 URL real do projeto
SUPABASE_ANON_KEY            chave usada para consultar Supabase Auth
SUPABASE_SERVICE_ROLE_KEY    chave de servidor para Storage privado
SUPABASE_STORAGE_BUCKET=omr-private
OMR_REMOTE_URL              URL HTTPS do Python terminada em /api/omr
OMR_REMOTE_SECRET           segredo aleatório longo, igual ao do Python
AUTH_ENABLED=true
TEACHER_EMAILS              emails autorizados separados por vírgula
CORS_ORIGINS                origens HTTPS exatas da interface, separadas por vírgula
REPORT_INSTITUTION          instituição do boletim
```

`WEB_URL` é alternativa a `CORS_ORIGINS` para uma origem. Use origens sem barra final e apenas domínios de produção/preview autorizados. Adicione variáveis de email somente para habilitar boletins.

**Interface:** `API_BASE_URL` = URL HTTPS da API **sem `/api` e sem barra final**. As rewrites encaminham chamadas; senha de banco, chave de serviço e segredo OMR não são enviados ao navegador.

**Python:** `OMR_REMOTE_SECRET` igual ao da API, `SUPABASE_URL` e `SUPABASE_STORAGE_BUCKET`. Recebe URL assinada e não precisa da chave de serviço Supabase. Rejeita origens externas, redirects e chamadas sem segredo. Retorna leitura/espelho; NestJS calcula notas.

Confira o deployment real antes de divulgar um endereço. Faça smoke tests de `/api/health`, `/api/auth/config`, acesso anônimo bloqueado, login autorizado, chave revisada, provas sintéticas de 50/60 questões, persistência após novo deployment, espelho/PDF e contatos fictícios. Email real depende de destinatário autorizado e confirmação na interface.

## Migração SQLite para PostgreSQL

Preserve cópia do SQLite e de `media/`. Configure o destino no ambiente do comando:

```bash
npm run build -w @enem/api
node scripts/migrate-postgres.mjs
```

Para copiar também os espelhos referenciados pelos resultados:

```bash
node scripts/migrate-postgres.mjs --include-media
```

Exige `STORAGE_MODE=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e bucket privado. `MIGRATION_MEDIA_ROOT` é a pasta de origem; padrão `media/`. A opção copia os **espelhos referenciados**, não todos os arquivos arbitrários da pasta.

O SQLite não é modificado. IDs, notas, respostas, matrículas e snapshots são preservados; conflitos abortam em vez de sobrescrever. Tabelas são gravadas em transação PostgreSQL. Arquivos já copiados podem permanecer no Storage se uma etapa posterior falhar; uma repetição confere conteúdo antes de reutilizá-los. Não publique banco, contatos, provas, backups ou credenciais no Git.

## Testes e evidências

```bash
npm test
npm run typecheck
npm run build
node scripts/test-postgres-schema.mjs
PYTHONPATH=python venv/bin/python python/tests/benchmark.py artifacts/omr-benchmark
```

O benchmark desenha fontes e tinta independentes do leitor, sem recortar fotos ou consultar a chave para localizar marcações. `python/tests/benchmark_metrics.json` registra **154 cartões exatos, 8.475 rótulos corretos, zero alternativas incorretas e zero abstenções extras**. O caso deliberadamente incerto continuou `INC`. Inclui 50/55/60 questões, chaves aleatórias, todos A/B/C/D/E, folhas vazias, duplas, tinta parcial, rotação, perspectiva, sombra, ruído, desfoque leve, tinta azul, fontes e margens diferentes.

Esses números são dos casos medidos, **não garantia para toda a população de provas**. Recortes, grande perspectiva, desfoque forte, tinta fraca e borrões podem exigir revisão/nova captura. Os motivos dos ajustes estão em [JUSTIFICATIVAS_OPENCV.txt](./JUSTIFICATIVAS_OPENCV.txt); a montagem sintética está em `python/tests/benchmark_montage.png`.

Fotos pessoais de regressão ficam locais, em diretórios ignorados pelo Git. CI e integração usam cartões gerados sem nomes, emails ou matrículas reais. Testes de acesso, upload e email simulam serviços externos e não enviam mensagens reais.

## Estrutura

```text
apps/web/                  interface Next.js e upload privado
apps/api/                  NestJS, banco, comparação, Excel, boletins e acesso
packages/shared/           contratos TypeScript
python/omr/                leitura e decodificação
python/worker.py           worker local JSON
python/api/omr.py           função remota autenticada
python/tests/              gerador, regressões e benchmark
infra/sql/001-schema.sql   schema PostgreSQL e RLS
scripts/migrate-postgres.mjs
legacy/django/             referência local ignorada pelo Git, sem execução
```
