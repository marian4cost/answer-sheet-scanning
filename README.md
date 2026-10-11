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
4. Envie imagens individuais ou o PDF completo da turma. Cada página corresponde a um cartão. A prévia lê a matrícula no texto do PDF ou por OCR local no cabeçalho; confira cada página, corrija identificações pendentes e selecione os cartões antes de confirmar. O nome do arquivo nunca é usado como matrícula.
5. Confira resultados, alertas e espelhos. Envios novos se somam aos anteriores; reenvios da mesma matrícula ficam como provas distintas no histórico.

O cartão impresso tem duas colunas numeradas de cima para baixo: metade à esquerda e metade à direita. Em ímpares, a esquerda tem uma linha a mais: **50 = 25 + 25**, **55 = 28 + 27**, **60 = 30 + 30**. Também é aceito o modelo compatível de bolhas com quatro marcadores. A quantidade cadastrada deve corresponder à folha inteira; não há corte automático nem reconhecimento de todo formulário arbitrário.

Formatos: PDF, JPEG/JPG, PNG, WEBP, BMP e TIFF, até **20 MB/arquivo**, **50 arquivos** e **100 páginas por importação**. PDFs são lidos página a página, incluindo documentos digitalizados. Fotografias aplicam orientação EXIF e transparência sobre fundo branco, até 40 megapixels. A matrícula permanece como texto, preservando zeros iniciais; ausência, ambiguidade e baixa confiança exigem conferência na prévia.

A importação dura duas horas e fica salva no banco. A identificação avança em blocos de três páginas e a correção em blocos de duas, respeitando os tempos da hospedagem. Cada página concluída já está armazenada; use **Retomar** após uma interrupção. Matrículas repetidas e páginas excluídas exigem seleção explícita. O gabarito é registrado com o lote e revalidado na confirmação. Os arquivos originais temporários são removidos após conclusão ou expiração; espelhos e resultados continuam salvos. O endpoint antigo de upload aceita somente cartões individuais e exige matrícula explícita ou extração confirmada; nunca trunca PDFs multipágina.

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

Em **Contatos**, baixe o modelo e preencha `matricula`, `email`, `nome` e `curso` (os dois últimos opcionais). Aceita CSV ou XLSX com uma aba, até **2 MB** e **10.000 contatos**. Formate a matrícula como **Texto** no Excel: `000123` é diferente de `123`. Matrículas numéricas em XLSX, fórmulas, emails inválidos e duplicidades são rejeitados. A importação exige prévia e confirmação; nenhum contato é salvo parcialmente quando há erro. Alterações de contatos existentes são avisadas. Uma planilha sem a coluna `curso` preserva o curso já cadastrado.

Exemplo fictício:

```csv
matricula,email,nome,curso
000123,aluno@example.com,Aluno de exemplo,Curso de exemplo
```

Em **Boletins**, revise cada prova. O documento inclui nota objetiva geral, temas e áreas Linguagens, Ciências da Natureza, Matemática e Ciências Humanas. Temas são associados às áreas por termos conhecidos; nomes sem associação ficam no detalhamento. Uma área sem faixas aparece como **Sem questões**, sem nota inventada.

A redação é corrigida fora da aplicação. O professor salva nota opcional de **0 a 1000** e feedback de até **10.000 caracteres** por prova. Campos vazios continuam não informados. O boletim segue o modelo individual fornecido: identificação com curso, cartões de desempenho por área, interpretação, prioridades de revisão e comparação questão por questão em tabelas coloridas. Textos longos continuam em páginas adicionais. `REPORT_INSTITUTION` configura a instituição.

O boletim apresenta notas objetivas de **0 a 10**, calculadas por `acertos / total × 10`. A tabela geral e o Excel conservam os percentuais. Brancos e marcações duplas não pontuam e permanecem no denominador; não foi adicionada anulação de questões oficiais. O detalhamento usa a chave histórica do envio. Falhas ou chaves incompletas deixam a nota pendente; leituras incertas são provisórias e bloqueiam envio por email.

Para enviar, selecione boletins aptos, clique em **Revisar destinatários**, confira matrículas, emails e PDFs e confirme o envio. Importar contatos ou salvar redação não envia mensagens. Incertezas, falhas e chave histórica incompleta bloqueiam o envio. Duplas são respostas anuladas.

O plano dura 15 minutos e está vinculado ao conteúdo e ao contato. Mudanças exigem nova revisão. Entregas do mesmo conteúdo ao mesmo destinatário são idempotentes. Sem confirmação do provedor, o histórico indica a pendência e o sistema não reenvia automaticamente; confira o provedor antes de outra entrega.

### Importar avaliações da redação

Na tela **Boletins**, envie o XLSX/CSV exportado das respostas do Google Forms. São reconhecidos os cabeçalhos do modelo institucional: Matrícula do Aluno, Nome Completo do Aluno, Nome do Avaliador, Situação do Texto / Anulação, Competências 1 a 5 e Observações Gerais e Feedback para o Aluno. O modelo recebido em 11/10/2026 contém apenas cabeçalhos; exporte as respostas preenchidas para importar notas.

Cada competência aceita 0 a 200 pontos; a nota geral é a soma de 0 a 1000. Se existir uma coluna de nota total, ela deve corresponder à soma. Fórmulas, critérios ausentes, valores fora da escala e matrículas repetidas ambíguas bloqueiam a importação. Matrículas numéricas inteiras do Forms são convertidas sem acrescentar zeros e com aviso; a associação continua exata. A prévia mostra avaliações anteriores e exige confirmação adicional para substituí-las. Só as correções da mesma matrícula no simulado selecionado são atualizadas, incluindo reenvios explicitados na prévia.

### Acesso temporário do aluno

O email contém `/boletim#TOKEN`: a página remove o fragmento da barra de endereço e consulta a API por POST. O token de 32 bytes não é guardado no navegador nem em texto claro no banco. A autorização dura sete dias por padrão (`REPORT_LINK_TTL_DAYS`), funciona durante o prazo sem ser consumida no primeiro acesso e bloqueia consultas quando expirada, revogada ou quando o conteúdo foi alterado. A ação **Reemitir link** exige nova revisão e revoga o acesso anterior mantendo a entrega registrada.

`AUTH_ENABLED=true` protege os recursos do professor. Apenas os POSTs `/api/boletim/consultar` e `/api/boletim/pdf` aceitam acesso do aluno, sempre com token válido. Respostas usam `private, no-store`, sem referrer e sem indexação. A limpeza diária configurada na API Vercel usa `CRON_SECRET` (mínimo 32 caracteres) às 08h UTC: remove autorizações e prévias expiradas, mantendo resultados acadêmicos. Nenhum PDF de boletim é persistido na nuvem.

## Email opcional dos boletins

O envio só fica disponível com provedor configurado **no NestJS**:

| Provedor | Variáveis |
| --- | --- |
| EmailJS | `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY` |
| SMTP | `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` |
| Resend | `EMAIL_FROM`, `RESEND_API_KEY` |

Use um remetente autorizado pelo provedor. `SMTP_FROM` é alternativa a `EMAIL_FROM`. O padrão SMTP é porta 587 com TLS exigido; 465 ou `SMTP_SECURE=true` usa TLS desde a conexão. Resend tem precedência quando `RESEND_API_KEY` existe. Credenciais não devem ir ao cliente ou a variáveis `NEXT_PUBLIC_*`.

EmailJS tem precedência. O template exclusivo usa assunto `{{subject}}`, destinatário `{{to_email}}` e HTML `{{{message_html}}}`. Ative **Allow EmailJS API for non-browser applications** com **Use Private Key**. Depois configure `EMAILJS_ENABLED=true` na API (`false` suspende envios). Ative **Do not save private data** no template para não guardar códigos/notas no histórico do provedor. O backend espaça chamadas em pelo menos 1,1 segundo, inclusive entre instâncias na Vercel. O plano gratuito aceita 200 requisições mensais, dois templates e mensagens de até 50 KB, sem anexo. Todos os provedores enviam uma mensagem curta com um link temporário; notas, respostas e PDF não são colocados no email. O PDF é produzido em memória quando o aluno solicita o download. [Limites EmailJS](https://www.emailjs.com/pricing/) e [API oficial](https://www.emailjs.com/docs/rest-api/send/).

Os testes simulam os provedores, sem enviar emails reais. Importar a planilha não envia mensagens. O relatório institucional com aba **Registros** e cabeçalhos **Matrícula**, **Email Acadêmico**, **Nome** e **Descrição do Curso** é reconhecido diretamente. Abas de filtros são ignoradas; duas abas de contatos ou duas colunas de email reconhecidas são rejeitadas por ambiguidade. Matrículas continuam como texto.

## Login dos professores

Configure `AUTH_ENABLED=true` para exigir login por email e senha. `AUTH_REGISTRATION_ENABLED=true` permite cadastro de qualquer email, conforme a escolha do responsável: todas as contas com email confirmado podem acessar os simulados, contatos e boletins. Com a flag de cadastro desativada, valem apenas `TEACHER_EMAILS` ou os papéis `teacher`/`admin` em metadados administrativos do Supabase. Na nuvem, uma flag de login ausente ou com valor diferente de `false` mantém a autenticação exigida.

O cadastro pede email, senha de 8 a 128 caracteres e confirmação da senha. O NestJS gera um OTP de cadastro no **Supabase Auth** e envia o código pelo **EmailJS**. A conta só recebe sessão após o Supabase confirmar o código. Senhas são tratadas pelo Supabase Auth; não são armazenadas em tabelas da aplicação, no EmailJS nem no navegador. Os códigos também não aparecem em respostas da API ou logs. A aplicação limita solicitações por email e IP em banco compartilhado entre deployments.

As duas contas provisionadas pelo responsável usam login por senha. A interface mantém a alternativa de acesso por código. O SMTP padrão do Supabase é apenas uma alternativa legada para login por código quando EmailJS não está configurado; ele não permite atender usuários externos sem um SMTP próprio.

1. Configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_ENABLED=true`, `AUTH_REGISTRATION_ENABLED=true` e as quatro variáveis EmailJS na API.
2. Habilite email no Supabase Auth e mantenha a confirmação de email. Para compatibilidade com links legados, cadastre a origem real em Site URL e a rota `/login` nas URLs de redirecionamento.
3. Na tela `/login`, entre com email e senha ou selecione **Criar conta**, defina a senha e informe o código recebido por email. O fluxo EmailJS usa o Supabase apenas para gerar/verificar o OTP e não depende do SMTP padrão do Supabase.

A sessão usa cookie `HttpOnly`, `SameSite=Lax`, seguro na nuvem, até uma hora. A identidade é validada no Supabase a cada chamada protegida. `user_metadata` editável pelo usuário não concede acesso. Sem sessão válida, contatos, boletins, PDFs e espelhos ficam bloqueados.


Referências oficiais: [templates Supabase](https://supabase.com/docs/guides/auth/auth-email-templates) e [login por email e OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless).

## Publicação Vercel e Supabase

Publicação atual: [interface](https://enem-leitor-web.vercel.app), [health da API](https://enem-leitor-api.vercel.app/api/health) e processador Python em `https://enem-leitor-omr.vercel.app/api/omr`. A interface exige login de professor; o aluno acessa apenas seu boletim com o link temporário recebido. O processador recebe chamadas autenticadas da API. O código está no [repositório privado](https://github.com/GenissonEmilio/enem-leitor).

Use **três projetos Vercel do mesmo repositório**. Para reproduzir a instalação em outra conta, substitua URLs e credenciais nas configurações abaixo.

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
DATABASE_SSL_CA_BASE64       certificado CA oficial em PEM codificado em base64
NODE_OPTIONS=--experimental-require-module
STORAGE_MODE=supabase
SUPABASE_URL                 URL real do projeto
SUPABASE_ANON_KEY            chave usada para consultar Supabase Auth
SUPABASE_SERVICE_ROLE_KEY    chave de servidor para Storage privado
SUPABASE_STORAGE_BUCKET=omr-private
OMR_REMOTE_URL              URL HTTPS do Python terminada em /api/omr
OMR_REMOTE_SECRET           segredo aleatório longo, igual ao do Python
AUTH_ENABLED=true           exige login de professor
AUTH_REGISTRATION_ENABLED=true  cadastro com código por email
REPORT_LINK_TTL_DAYS=7       prazo do link individual
CRON_SECRET                 segredo da limpeza diária, mínimo 32 caracteres
TEACHER_EMAILS              emails autorizados separados por vírgula
WEB_URL                     origem da interface usada no callback /login
CORS_ORIGINS                origens HTTPS exatas da interface, separadas por vírgula
REPORT_INSTITUTION          instituição do boletim
```

`WEB_URL` também serve como alternativa a `CORS_ORIGINS` quando há uma origem. Se estiver ausente, o callback de login usa a primeira origem de `CORS_ORIGINS`. Use origens sem barra final e apenas domínios de produção/preview autorizados. Adicione variáveis de email somente para habilitar boletins. A conexão PostgreSQL exige certificado TLS válido e hostname correspondente; obtenha a CA oficial em Database → Settings no Supabase e codifique o PEM em base64. Caracteres reservados da senha devem ser codificados no componente de senha da URI, e o valor completo deve estar entre aspas no `.env`.

O NestJS 12 publica módulos ESM; esta aplicação CommonJS usa o suporte `require(esm)` do Node.js. A Vercel desativa esse recurso por padrão: configure `NODE_OPTIONS=--experimental-require-module` no projeto **API** antes do deployment. [Configuração oficial da Vercel](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration), [migração do NestJS 12](https://docs.nestjs.com/migration-guide).

**Interface:** `API_BASE_URL` = URL HTTPS da API **sem `/api` e sem barra final**. As rewrites encaminham chamadas; senha de banco, chave de serviço e segredo OMR não são enviados ao navegador.

**Python:** `OMR_REMOTE_SECRET` igual ao da API, `SUPABASE_URL` e `SUPABASE_STORAGE_BUCKET`. Recebe URL assinada e não precisa da chave de serviço Supabase. Rejeita origens externas, redirects e chamadas sem segredo. Retorna leitura/espelho; NestJS calcula notas.

Confira o deployment real antes de divulgar um endereço. Faça smoke tests de `/api/health`, `/api/auth/config`, acesso direto quando `AUTH_ENABLED=false` ou login autorizado quando `true`, chave revisada, provas sintéticas de 50/60 questões, persistência após novo deployment, espelho/PDF e contatos fictícios. Email real depende de destinatário autorizado e confirmação na interface.

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

Confira a cópia independentemente, incluindo SHA-256 dos espelhos, com `node scripts/verify-postgres-migration.mjs`. O certificado configurado também é usado pelos scripts de migração e verificação.

A migração de 10/10/2026 conservou **4 simulados, 4 lotes, 19 resultados e 19 espelhos**, conferidos campo a campo e por SHA-256. O SQLite original e o backup permanecem locais e fora do Git. O fluxo publicado foi validado com provas fictícias de 50/60 questões, incluindo uma mesma prova corrigida com duas chaves, snapshots históricos e persistência após novo deployment. EmailJS foi configurado e validado com mensagens de teste autorizadas. Testes automatizados usam provedores simulados e não enviam mensagens a alunos.

## Testes e evidências

```bash
DATABASE_URL='' STORAGE_MODE=local OMR_REMOTE_URL='' AUTH_ENABLED=false npm test
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
