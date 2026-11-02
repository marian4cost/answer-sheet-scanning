# SIRENIA

**Simulados e Revisões para o Enem corrigidos com Inteligência Artificial**, com a identidade do MOREA.

Corretor de simulados do **Instituto Federal de Sergipe - Campus Lagarto**: interface Next.js, backend NestJS e processamento Python/OpenCV. Aceita **50 a 60 questões**, alternativas A a E, histórico acumulado, desempenho por tema, Excel e boletins individuais.

O leitor localiza a grade e mede a tinta da própria folha. A chave do professor é usada depois da leitura para comparar respostas e calcular notas. O processamento não escolhe alternativas a partir da chave.

**Vai assumir a implantação na AWS?** Comece pelo [roteiro de entrega ao responsável](docs/ENTREGA-AWS.md), pelo [catálogo completo de variáveis](docs/VARIAVEIS-AMBIENTE.md) e pelo [guia operacional](docs/GUIA-AWS.md). A infraestrutura integra a `main` pela [PR #1](https://github.com/GenissonEmilio/enem-leitor/pull/1). Esses arquivos não incluem credenciais reais.

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

Se precisar configurar caminhos ou portas, copie `.env.example` para `.env` **somente se ainda não houver `.env`**. Preserve os valores de um arquivo existente. O padrão local usa `db.sqlite3`, `media/`, `venv/bin/python` e exige autenticação dos professores, inclusive em localhost. Configure o acesso pelo Supabase; não desative a autenticação. Uma `DATABASE_URL` preenchida ativa PostgreSQL. Após mudar `API_BASE_URL` ou as portas, recompile: as rewrites do Next.js são definidas no build.

## Gabarito, provas e matrículas

1. Cadastre título e quantidade: qualquer inteiro de **50 a 60**.
2. Envie a folha oficial e use **Ler folha para conferir**, ou escolha **Digitar gabarito**. Confira uma alternativa A a E por questão antes de salvar. Branco, dupla e leitura incerta não são aceitos como chave oficial.
3. Cadastre os intervalos de temas. Exemplo: 1–22 Linguagens e 25–30 Ciências da Natureza. Limites são inclusivos; sobreposições são rejeitadas. Lacunas ficam **Sem tema** e faixas com o mesmo nome têm desempenho agrupado.
4. Envie imagens individuais ou o PDF completo da turma. Cada página corresponde a um cartão. A prévia lê a matrícula no texto do PDF ou por OCR local no cabeçalho; confira cada página, corrija identificações pendentes e selecione os cartões antes de confirmar. O nome do arquivo nunca é usado como matrícula.
5. Confira resultados, alertas e espelhos. Envios novos se somam aos anteriores; reenvios da mesma matrícula ficam como provas distintas no histórico.

O cartão impresso tem duas colunas numeradas de cima para baixo: metade à esquerda e metade à direita. Em ímpares, a esquerda tem uma linha a mais: **50 = 25 + 25**, **55 = 28 + 27**, **60 = 30 + 30**. Também é aceito o modelo compatível de bolhas com quatro marcadores. A quantidade cadastrada deve corresponder à folha inteira; não há corte automático nem reconhecimento de todo formulário arbitrário.

Formatos: PDF, JPEG/JPG, PNG, WEBP, BMP e TIFF, até **20 MB/arquivo**, **50 arquivos** e **100 páginas por importação**. PDFs são lidos página a página, incluindo documentos digitalizados. Fotografias aplicam orientação EXIF e transparência sobre fundo branco, até 40 megapixels. A matrícula permanece como texto, preservando zeros iniciais; ausência, ambiguidade e baixa confiança exigem conferência na prévia.

Em fotografias, o OCR tolera um único caractere incorreto no rótulo Matrícula, exigindo delimitador e confiança mínima; os dígitos não são corrigidos nem obtidos do nome do arquivo. Fotos pequenas que falham na localização com interpolação cúbica são tentadas novamente com interpolação linear, mantendo a validação de todas as linhas e alternativas.

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

Em **Contatos dos alunos**, cada contato cadastrado tem o botão **Editar** para corrigir matrícula, email, nome e curso sem importar outra planilha. A edição é exclusiva da conta proprietária, preserva o prazo de armazenamento e não envia mensagens. Matrículas duplicadas e versões desatualizadas são rejeitadas. Alterar a matrícula muda a associação do contato e não renomeia provas já enviadas. Depois de editar, confira uma nova prévia de importação ou entrega; as prévias antigas não podem sobrescrever os dados corrigidos.

O botão **Excluir** remove o aluno da base de contatos da própria conta após digitar sua matrícula exata. O servidor confere o proprietário e a versão do cadastro para impedir exclusões de outros usuários ou de dados alterados em outra aba. Provas, correções e redações salvas permanecem no histórico. Sem o contato, novos envios de boletins ficam bloqueados até cadastrá-lo novamente; prévias anteriores de importação ou envio precisam ser refeitas. Excluir não envia mensagens.

Em **Boletins**, revise cada prova. O documento apresenta os acertos por tema e pelas áreas Linguagens, Ciências da Natureza, Matemática e Ciências Humanas, sem média objetiva geral. Temas são associados às áreas por termos conhecidos; temas extras, como **Técnico**, aparecem explicitamente com seus acertos/total no PDF e na página individual. Uma área sem faixas aparece como **Sem questões**, sem acertos inventados.

A redação é corrigida fora da aplicação. O professor salva nota opcional de **0 a 1000** e feedback de até **10.000 caracteres** por prova. Campos vazios continuam não informados. O boletim segue o modelo individual fornecido: identificação com curso, cartões de desempenho por área, interpretação, prioridades de revisão e comparação questão por questão em tabelas coloridas. Textos longos continuam em páginas adicionais. `REPORT_INSTITUTION` configura a instituição.

O boletim apresenta **acertos/total de questões**, como `2/25`, no PDF, na página individual do aluno e nas prévias do professor. A tabela de correção e o Excel conservam os percentuais. Brancos e marcações duplas não pontuam e permanecem no denominador; não foi adicionada anulação de questões oficiais. O detalhamento usa a chave histórica do envio. Falhas ou chaves incompletas deixam os acertos pendentes; leituras incertas são provisórias e bloqueiam envio por email. A redação mantém a avaliação de 0 a 1000 e suas competências. Os dados históricos e hashes dos boletins foram preservados para não invalidar links já enviados por causa dessa mudança de apresentação.

Para enviar, selecione boletins aptos, clique em **Revisar destinatários**, confira matrículas, emails e PDFs e confirme o envio. Importar contatos ou salvar redação não envia mensagens. Incertezas, falhas e chave histórica incompleta bloqueiam o envio. Duplas são respostas anuladas.

O plano dura 15 minutos e está vinculado ao conteúdo e ao contato. Mudanças exigem nova revisão. Entregas do mesmo conteúdo ao mesmo destinatário são idempotentes. Sem confirmação do provedor, o histórico indica a pendência e o sistema não reenvia automaticamente; confira o provedor antes de outra entrega.

Uma recusa explícita do EmailJS por limite de requisições/cota (HTTP 429), ou uma validação local que impede a chamada, fica como **Não enviado — nova revisão necessária**. Após resolver o motivo, prepare e confirme uma nova prévia: a entrega existente é reutilizada sem duplicar o histórico, e o link anterior não enviado permanece revogado. A prévia que falhou não pode repetir a tentativa. Timeouts, falhas 5xx e respostas sem confirmação continuam como **Entrega sem confirmação**, exigindo conferência no provedor.

Em **Histórico de entregas**, use **Revisar nova tentativa** para mensagens que não foram enviadas. Nos casos sem confirmação, **Resolver entrega** exige que o professor confira o provedor e confirme que a mensagem não foi enviada; depois abre uma nova prévia do destinatário. A liberação não envia e-mails, preserva a entrega, revoga links nunca ativados e invalida prévias anteriores daquela prova. Entregas confirmadas, com link ativo ou em andamento há menos de dez minutos não podem ser liberadas. Outra conta, inclusive administrativa, não pode resolver entregas alheias; uma versão desatualizada exige atualizar o histórico.

### Importar avaliações da redação

Na tela **Boletins**, envie o XLSX/CSV exportado das respostas do Google Forms. São reconhecidos os cabeçalhos do modelo institucional: Matrícula do Aluno, Nome Completo do Aluno, Nome do Avaliador, Situação do Texto / Anulação, Competências 1 a 5 e Observações Gerais e Feedback para o Aluno. O modelo recebido em 11/10/2026 contém apenas cabeçalhos; exporte as respostas preenchidas para importar notas.

Cada competência aceita 0 a 200 pontos; a nota geral é a soma de 0 a 1000. Se existir uma coluna de nota total, ela deve corresponder à soma. Fórmulas, critérios ausentes, valores fora da escala e matrículas repetidas ambíguas bloqueiam a importação. Matrículas numéricas inteiras do Forms são convertidas sem acrescentar zeros e com aviso; a associação continua exata. A prévia mostra avaliações anteriores e exige confirmação adicional para substituí-las. Só as correções da mesma matrícula no simulado selecionado são atualizadas, incluindo reenvios explicitados na prévia.

### Acesso temporário do aluno

O email contém `/boletim#TOKEN`: a página remove o fragmento da barra de endereço e consulta a API por POST. O token de 32 bytes não é guardado no navegador nem em texto claro no banco. A autorização dura 30 dias por padrão (`REPORT_LINK_TTL_DAYS`), funciona durante o prazo sem ser consumida no primeiro acesso e bloqueia consultas quando expirada, revogada ou quando o conteúdo foi alterado. A ação **Reemitir link** exige nova revisão e revoga o acesso anterior mantendo a entrega registrada.

A autenticação é sempre obrigatória nos recursos do professor. Apenas os POSTs `/api/boletim/consultar` e `/api/boletim/pdf` aceitam acesso do aluno, sempre com token válido. Respostas usam `private, no-store`, sem referrer e sem indexação. A limpeza diária configurada na API Vercel usa `CRON_SECRET` (mínimo 32 caracteres) às 08h UTC: remove autorizações e prévias expiradas, além dos simulados e contatos com retenção vencida. Resultados, redações, entregas e links acompanham a exclusão do simulado; objetos privados são removidos com uma fila persistente para repetir falhas de armazenamento. Nenhum PDF de boletim é persistido na nuvem.

## Email opcional dos boletins

O envio só fica disponível com provedor configurado **no NestJS**:

| Provedor | Variáveis |
| --- | --- |
| AWS SES | `EMAIL_PROVIDER=ses`, `AWS_REGION`, `EMAIL_FROM`; opcionais `EMAIL_REPLY_TO`, `SES_CONFIGURATION_SET`, `SES_RATE_PER_SECOND`; credenciais pelo papel da instância |
| EmailJS | `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY` |
| SMTP | `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` |
| Resend | `EMAIL_FROM`, `RESEND_API_KEY` |

Use um remetente autorizado pelo provedor. Em `EMAIL_PROVIDER=ses`, somente SES é utilizado, inclusive nos códigos opcionais de acesso, sem fallback para os demais. Em modo `auto` ou ausente, boletins usam EmailJS, depois Resend e SMTP. `SMTP_FROM` é alternativa a `EMAIL_FROM` no modo legado; o SES exige `EMAIL_FROM`. O padrão SMTP é porta 587 com TLS exigido; 465 ou `SMTP_SECURE=true` usa TLS desde a conexão. Credenciais não devem ir ao cliente ou a variáveis `NEXT_PUBLIC_*`.

Quando o provedor escolhido for EmailJS, o template exclusivo usa assunto `{{subject}}`, destinatário `{{to_email}}` e HTML `{{{message_html}}}`. Ative **Allow EmailJS API for non-browser applications** com **Use Private Key**. Depois configure `EMAILJS_ENABLED=true` na API (`false` suspende apenas esse provedor). Ative **Do not save private data** no template para não guardar códigos/notas no histórico do provedor. O backend espaça chamadas em pelo menos 1,1 segundo, inclusive entre instâncias na Vercel. O plano gratuito aceita 200 requisições mensais, dois templates e mensagens de até 50 KB, sem anexo. Todos os provedores enviam uma mensagem curta com um link temporário; notas, respostas e PDF não são colocados no email. O PDF é produzido em memória quando o aluno solicita o download. [Limites EmailJS](https://www.emailjs.com/pricing/) e [API oficial](https://www.emailjs.com/docs/rest-api/send/).

Os testes simulam os provedores, sem enviar emails reais. Importar a planilha não envia mensagens. O relatório institucional com aba **Registros** e cabeçalhos **Matrícula**, **Email Acadêmico**, **Nome** e **Descrição do Curso** é reconhecido diretamente. Abas de filtros são ignoradas; duas abas de contatos ou duas colunas de email reconhecidas são rejeitadas por ambiguidade. Matrículas continuam como texto.

## Login, perfis e administração

O login é sempre obrigatório. Cada conta acessa somente seus próprios simulados, contatos, resultados, importações e entregas. O proprietário vem do UUID verificado no Supabase Auth, nunca de valores enviados pelo navegador. A role é obtida de `app_metadata.role`, controlada pelo servidor: `admin` ou `professor` (`teacher` legado é normalizado para professor). O administrador gerencia contas, mas não acessa automaticamente o histórico dos outros professores.

O proprietário pode abrir **Resultados → Compartilhar**, informar o e-mail de um usuário ativo e liberar acesso àquele simulado. O destinatário o encontra em **Compartilhados comigo** e consulta resultados, respostas, espelhos, temas e planilhas. O acesso é somente para leitura: gabarito, correções, uploads, exclusão, novos compartilhamentos, contatos, redações e boletins continuam exclusivos do proprietário. A exportação compartilhada não inclui avaliações de redação nem nomes de arquivos de origem. Não são enviados e-mails ao compartilhar. O proprietário revoga o acesso na mesma tela; a próxima consulta fica bloqueada. O compartilhamento usa o UUID da conta, mantém o vencimento original do simulado e é removido em cascata na exclusão. Contas recriadas com o mesmo e-mail não herdam acessos antigos.

Não há cadastro público. O administrador abre **Configurações → Adicionar usuário**, informa nome, email, senha inicial de 8 a 128 caracteres e role. A senha é tratada somente pelo Supabase Auth; não fica no banco da aplicação, no EmailJS nem em logs. A nova conta já fica liberada pelo administrador e entra imediatamente com email e senha, sem confirmação por código. A criação não envia mensagens. O acesso por código continua disponível como alternativa opcional para contas existentes.

O código é gerado somente para contas já provisionadas e com role administrativa válida. O fallback OTP usa `create_user:false`. Mantenha o cadastro público desativado também no Supabase Auth. As variáveis legadas `AUTH_REGISTRATION_ENABLED`, `TEACHER_EMAILS` e `AUTH_ENABLED` não concedem privilégios nem desligam a autenticação.

Em **Configurações**, cada usuário consulta suas informações e edita o nome de apresentação. Administradores também listam usuários, criam contas, alteram roles e excluem contas. A exclusão exige digitar o email exato da conta, remove o acesso no Supabase Auth e bloqueia sessões antigas nas próximas requisições. Os registros acadêmicos conservam seu proprietário e o prazo de retenção original; recriar o mesmo email gera outro UUID e não transfere o histórico. O servidor revalida o papel no provedor e serializa essas alterações; o último administrador ativo, a própria conta e a própria permissão ficam protegidos.

A sessão mantém o login por **7 dias entre renovações**, com cookies `HttpOnly`, `Secure` e `SameSite=Lax`. O cookie `enem_session` contém o acesso curto (até uma hora); `enem_refresh` guarda a credencial de renovação por sete dias. Quando o acesso expira, a API troca o refresh token no Supabase, valida a identidade atual e rotaciona ambos os cookies automaticamente, renovando o prazo de sete dias. Tokens não são retornados nos perfis nem persistidos em localStorage. Senha, código e links novos de email usam essa sessão; links legados sem refresh token conservam o acesso curto. Após atualizar, saia e entre novamente uma vez para criar a sessão longa. **Sair** remove ambos os cookies e solicita a revogação da sessão atual no provedor, sem encerrar outros dispositivos. Falhas temporárias do provedor retornam 503 sem apagar os cookies.

Identidade, confirmação de email, bloqueio da conta e role são verificados no Supabase a cada chamada protegida, inclusive após renovar a sessão. Metadados editáveis pelo usuário não concedem acesso. Requisições Bearer inválidas não herdam credenciais de cookies. Solicitações, códigos e tentativas de login têm limites persistentes no banco. O JWT do Supabase não precisa ter sua validade aumentada para sete dias; a renovação segue o [modelo de sessões do Supabase](https://supabase.com/docs/guides/auth/sessions).

1. Configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e as variáveis EmailJS na API.
2. Mantenha a confirmação de email e desative o cadastro público no Supabase Auth. Cadastre a origem real e a rota `/login` nos redirecionamentos autorizados.
3. Provisione o administrador inicial com `app_metadata.role=admin`; novas contas são gerenciadas pela aplicação.

Referências: [Supabase — metadados administrativos](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid) e [login por email e OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless).

### Revisão manual das respostas

No espelho ou em **Boletins → Revisar / redação**, o professor abre **Conferir respostas do cartão**. Leituras incertas (círculos azuis) podem ser filtradas. Ele informa A a E, em branco ou marcação dupla e registra o motivo. A aplicação recalcula notas e temas usando a chave histórica daquele envio, preservando o OCR original e registrando antes/depois, data e revisor.

Revisões concorrentes exigem atualizar o espelho. Uma falha completa de leitura só libera a nota depois de conferir todas as questões, mesmo em etapas. Alterações de conteúdo invalidam prévias e links antigos; o histórico de entregas permanece salvo e nenhum email é reenviado automaticamente.

A página pública **Desenvolvedores**, acessível pelo botão **Conhecer os desenvolvedores**, apresenta Mariana da Costa Lisboa e Genisson Emilio dos Santos, com links para seus portfólios, GitHub e LinkedIn.

### Histórico por conta e retenção

`DATA_RETENTION_DAYS` define de 1 a 365 dias (padrão: 30). O prazo de cada simulado é fixado no cadastro; resultados, redações e histórico de entregas vencem juntos. A interface mostra a data e recomenda exportar os arquivos. Contatos vencem no mesmo prazo contado da última importação. Ao confirmar um envio ou uma reemissão, o simulado e o contato daquele aluno são conservados pelo menos até a expiração do novo link, sem encurtar prazos maiores já existentes. Apenas abrir uma prévia não estende o armazenamento. A extensão ocorre na reserva transacional do envio, inclusive se o provedor posteriormente recusar a mensagem. Os registros ficam inacessíveis quando vencem; a limpeza diária os exclui do banco e remove os arquivos. As contas de acesso não são excluídas por essa limpeza. Links individuais têm 30 dias completos por padrão contados da emissão (`REPORT_LINK_TTL_DAYS`, de 1 a 30). A reemissão revoga o link anterior; a exclusão manual ou alterações no conteúdo/contato continuam bloqueando o acesso imediatamente.

Bancos anteriores à separação mantêm os registros antigos sem dono e sem exposição a contas novas. A migração é explícita, exige uma conta existente com e-mail confirmado e cria um backup privado antes de modificar o banco:

```bash
node scripts/migrate-account-data.mjs --email professor@example.com --days 30
# Após revisar o proprietário e o prazo:
node scripts/migrate-account-data.mjs --email professor@example.com --days 30 --apply
```

Ela atribui somente registros ainda sem proprietário e não altera notas, respostas, IDs ou datas originais. O modo de prévia não executa DDL nem altera registros. Os arquivos de backup precisam seguir a política de retenção da instituição e ficam fora do Git. Uploads temporários, prévias e limites de envio também são limpos; não há mais arquivos de alunos servidos diretamente por `/media`.

### Entrega dos e-mails

O template mantém **Use Default Email Address**, com a conta Gmail autorizada, um nome de remetente reconhecível e um endereço real para respostas. O boletim usa assunto transacional e um link cujo texto mostra o domínio de destino; SMTP e Resend também recebem uma versão texto. No EmailJS, `message_text` fica disponível como parâmetro adicional. As credenciais e o código de confirmação continuam protegidos.

Classificação como spam não pode ser garantida pela aplicação. Confira SPF, DKIM e DMARC em **Mostrar original** da mensagem recebida e a reputação do remetente. Para mensagens legítimas já classificadas como spam, o destinatário pode usar **Não é spam** naquela mensagem. Não desative filtros de segurança nem crie exceções para toda a caixa. Para grandes turmas, use um provedor com domínio próprio autenticado quando houver um domínio autorizado disponível. [Orientações do Gmail](https://support.google.com/mail/answer/81126) e [Serviços pessoais do EmailJS](https://www.emailjs.com/docs/user-guide/connecting-email-services/).

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
AUTH_REGISTRATION_ENABLED=false  legado; cadastro público sempre bloqueado
REPORT_LINK_TTL_DAYS=30      prazo do link individual
CRON_SECRET                 segredo da limpeza diária, mínimo 32 caracteres
app_metadata.role           admin ou professor; papel protegido no Supabase Auth
WEB_URL                     origem da interface usada no callback /login
CORS_ORIGINS                origens HTTPS exatas da interface, separadas por vírgula
REPORT_INSTITUTION          instituição do boletim
```

`WEB_URL` também serve como alternativa a `CORS_ORIGINS` quando há uma origem. Se estiver ausente, o callback de login usa a primeira origem de `CORS_ORIGINS`. Use origens sem barra final e apenas domínios de produção/preview autorizados. Adicione variáveis de email somente para habilitar boletins. A conexão PostgreSQL exige certificado TLS válido e hostname correspondente; obtenha a CA oficial em Database → Settings no Supabase e codifique o PEM em base64. Caracteres reservados da senha devem ser codificados no componente de senha da URI, e o valor completo deve estar entre aspas no `.env`.

O NestJS 12 publica módulos ESM; esta aplicação CommonJS usa o suporte `require(esm)` do Node.js. A Vercel desativa esse recurso por padrão: configure `NODE_OPTIONS=--experimental-require-module` no projeto **API** antes do deployment. [Configuração oficial da Vercel](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration), [migração do NestJS 12](https://docs.nestjs.com/migration-guide).

**Interface:** `API_BASE_URL` = URL HTTPS da API **sem `/api` e sem barra final**. As rewrites encaminham chamadas; senha de banco, chave de serviço e segredo OMR não são enviados ao navegador.

**Python:** `OMR_REMOTE_SECRET` igual ao da API, `SUPABASE_URL` e `SUPABASE_STORAGE_BUCKET`. Recebe URL assinada e não precisa da chave de serviço Supabase. Rejeita origens externas, redirects e chamadas sem segredo. Retorna leitura/espelho; NestJS calcula notas.

Confira o deployment real antes de divulgar um endereço. Faça smoke tests de `/api/health`, `/api/auth/config`, bloqueio do acesso anônimo e login autorizado, chave revisada, provas sintéticas de 50/60 questões, persistência após novo deployment, espelho/PDF e contatos fictícios. Email real depende de destinatário autorizado e confirmação na interface.

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
DATABASE_URL='' STORAGE_MODE=local OMR_REMOTE_URL='' npm test
npm run typecheck
npm run build
node scripts/test-postgres-schema.mjs
PYTHONPATH=python venv/bin/python python/tests/benchmark.py artifacts/omr-benchmark
```

O benchmark desenha fontes e tinta independentes do leitor, sem recortar fotos ou consultar a chave para localizar marcações. `python/tests/benchmark_metrics.json` registra **154 cartões exatos, 8.475 rótulos corretos, zero alternativas incorretas e zero abstenções extras**. O caso deliberadamente incerto continuou `INC`. Inclui 50/55/60 questões, chaves aleatórias, todos A/B/C/D/E, folhas vazias, duplas, tinta parcial, rotação, perspectiva, sombra, ruído, desfoque leve, tinta azul, fontes e margens diferentes.

Esses números são dos casos medidos, **não garantia para toda a população de provas**. Recortes, grande perspectiva, desfoque forte, tinta fraca e borrões podem exigir revisão/nova captura. Os motivos dos ajustes estão em [JUSTIFICATIVAS_OPENCV.txt](./JUSTIFICATIVAS_OPENCV.txt); a montagem sintética está em `python/tests/benchmark_montage.png`.

Fotos pessoais de regressão ficam locais, em diretórios ignorados pelo Git. CI e integração usam cartões gerados sem nomes, emails ou matrículas reais. Testes de acesso, upload e email simulam serviços externos e não enviam mensagens reais.

Há dois workflows no GitHub Actions: [ci.yml](.github/workflows/ci.yml) compila a aplicação e executa os testes; [docker-build.yml](.github/workflows/docker-build.yml) constrói as imagens `api` e `web`, uma por vez, para `linux/amd64`. O segundo carrega as imagens apenas no runner e executa [smoke tests isolados](scripts/test-docker-image.sh), sem publicar portas, usar volumes ou acessar AWS. Confere Next.js standalone, NestJS, OpenCV/PDFium, recursos de PDF, autenticação obrigatória e validação de origem. As imagens recebem o commit no label `org.opencontainers.image.revision`. Esse workflow **não faz deploy nem publica imagens em registry**; Vini precisa reconstruir/atualizar o servidor a partir do commit aprovado.

## Implantação completa na AWS

Documentação de entrega atualizada em **02/11/2026**; domínio publicado pelo responsável: [sirenia.morea-ifs.org](https://sirenia.morea-ifs.org/).

| Documento | Conteúdo |
|---|---|
| [Entrega ao responsável](docs/ENTREGA-AWS.md) | Branch correta, pendências, checklist do corte, links antigos, critérios de aceite e diagnóstico. |
| [Todas as variáveis de ambiente](docs/VARIAVEIS-AMBIENTE.md) | Obrigatoriedade, formato, padrão, origem dos segredos, valores fixos no Docker, build/runtime e migração. |
| [Guia de implantação e operação](docs/GUIA-AWS.md) | Comandos para EC2/Docker, PostgreSQL/GoTrue próprios, S3 privado, SES, DNS/HTTPS, migração, backup, atualização e rollback. |
| [Validação de 24/10](docs/VALIDACAO-AWS-2026-10-24.md) | Evidências e limitações do ensaio Docker/S3/SES; não é confirmação de deploy na EC2. |

Os arquivos de implantação ficam em `infra/aws/`. Next.js, NestJS com Python/OpenCV, PostgreSQL, GoTrue e limpeza rodam no Compose; S3 guarda arquivos privados e SES envia os links. A API e o Auth ficam privados. Login continua obrigatório, contas são criadas pelo administrador e o isolamento por usuário é preservado.

Para preparar a configuração em uma cópia dedicada do projeto, após conferir a infraestrutura com o responsável:

```bash
node infra/aws/generate-env.mjs
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml config --quiet
```

O gerador cria `infra/aws/runtime/.env` uma única vez, com segredos aleatórios e permissão `600`. Revise domínio, regiões, bucket, remetente e Reply-To conforme o catálogo. Não copie o `.env` da Vercel nem envie esse arquivo ao Git. O Compose fixa `EMAIL_PROVIDER=ses`; o envio não volta silenciosamente para EmailJS. A leitura Python é local à imagem da API, sem função OMR remota.

O padrão é **30 dias para novos links de boletim**, com extensão do simulado/contato para cobrir o acesso; registros existentes não são renovados só por trocar uma variável. Sessões têm refresh de sete dias e, no Auth AWS, timebox de 168 horas. Migre os dados preservando UUIDs/roles/senhas, confira o S3 e mantenha a continuidade dos links já enviados antes de mudar o domínio.

**O site já foi publicado na AWS pelo responsável, mas o aceite funcional ainda está pendente.** Na verificação de 02/11, site e `/api/health` responderam, enquanto o login apresentou origem não autorizada e `/api/auth/config` retornou `configured:false`. Depois de atualizar a `main`, é necessário reconstruir as imagens e passar as variáveis ao contêiner: `WEB_URL`/`CORS_ORIGINS` com `https://sirenia.morea-ifs.org`, endpoint Auth e chaves correspondentes. O gerador não sobrescreve o arquivo de ambiente existente; atualizar o código não corrige automaticamente um dotenv antigo. Revalidar migração de dados/contas, capacidade e liberação SES antes de enviar à turma. O [roteiro de entrega](docs/ENTREGA-AWS.md) mantém o checklist de aceite e a continuidade dos links anteriores.

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
infra/aws/                 Docker, Compose, IAM, Nginx, backup e limpeza
docs/ENTREGA-AWS.md         ponto de entrada para o responsável pela AWS
docs/VARIAVEIS-AMBIENTE.md  catálogo das configurações e segredos
docs/GUIA-AWS.md            procedimentos de implantação e operação
scripts/migrate-postgres.mjs
legacy/django/             referência local ignorada pelo Git, sem execução
```
