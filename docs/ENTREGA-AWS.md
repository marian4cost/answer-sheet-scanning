# Entrega do SIRENIA ao responsável pela AWS

Revisão da documentação: **07/11/2026**. O responsável publicou o site em `https://sirenia.morea-ifs.org`; a validação completa de login, dados e entrega de boletins ainda é necessária.

## Comece aqui

1. Leia o [catálogo de variáveis](VARIAVEIS-AMBIENTE.md): valores gerados, segredos, configurações fixas, migração e diferenças da Vercel.
2. Siga o [guia de implantação e operação](GUIA-AWS.md): instalação, migração, DNS/HTTPS, testes, backup e rollback.
3. Use a [validação histórica de 24/10](VALIDACAO-AWS-2026-10-24.md) como evidência do ensaio, não como aprovação do servidor de produção.

Código: [GenissonEmilio/enem-leitor](https://github.com/GenissonEmilio/enem-leitor), repositório privado. A infraestrutura AWS integra a **`main`** pela [PR #1](https://github.com/GenissonEmilio/enem-leitor/pull/1). O responsável deve atualizar o checkout usado no build e reconstruir as imagens; uma imagem construída da `main` anterior ao merge não reconhece `AUTH_BASE_URL` nem inclui SES/S3. Registre o commit exato do build.

```bash
git clone --branch main --single-branch https://github.com/GenissonEmilio/enem-leitor.git sirenia
cd sirenia
git rev-parse HEAD
```

## O que está entregue e o que falta

| Item | Estado conhecido / próxima ação |
|---|---|
| Aplicação | Next.js, NestJS/Python/OpenCV, PostgreSQL e GoTrue em Docker Compose; S3 e SES integrados. |
| Site AWS | Publicado pelo responsável em `https://sirenia.morea-ifs.org`. Em 02/11, `/api/health` respondeu; login com origem recusada e Auth `configured:false`. Atualizar código/imagens e variáveis antes de considerar funcional. |
| Ambiente anterior | Vercel + Supabase; último envio verificado em 29/10 pelo EmailJS. Preservar até conferir migração e links antigos. |
| Servidor proposto | EC2 Linux existente. Obter identificação, endereço, região e acesso pelo inventário privado; confirmar a reserva da máquina e medir a capacidade compartilhada. |
| Acesso | A sessão do desenvolvedor não tinha SSH/SSM no inventário inicial. O responsável conduziu a publicação com seu acesso; usar esse acesso autorizado para atualizar o servidor. |
| S3 | Bucket privado definido em `S3_BUCKET`, região em `S3_REGION` e prefixo em `S3_PREFIX`. Confirmar permissões, CORS e lifecycle sem substituir regras de outros projetos. |
| SES | Região, identidade, remetente e configuration set definidos no ambiente privado. No inventário inicial o pedido de produção havia sido negado; verificar o estado atual e consultar o chamado pelo canal privado de suporte. |
| Domínio do site | Atual: `https://sirenia.morea-ifs.org`. `WEB_URL`, `CORS_ORIGINS`, CORS de upload no S3 e proxy precisam corresponder ao domínio. O domínio de e-mail continua `mage.dev.br`. |
| Segredos | Gerador disponível; valores reais não estão no Git. Credenciais da origem necessárias à migração devem ser entregues por canal privado. |
| Dados/contas | Scripts de migração disponíveis; conclusão da migração real ainda não verificada pelo desenvolvedor. Não criar contas de teste no destino final antes de migrar. |

O inventário detalhado de recursos/IAM/SES, com IDs, nomes internos, regiões reais, IPs e chamados, deve ser entregue por canal privado e revalidado na conta AWS; não o inclua no Git ou em screenshots compartilhados. As observações HTTP são de 02/11. Não é necessário manter Vercel ou Supabase gerenciado após uma migração completa e o encerramento planejado da compatibilidade dos links antigos.

## Checklist de implantação

Os comandos completos e as explicações estão no guia. Não avançar uma etapa com falha nem testar envio em massa com dados reais.

### 1. Infraestrutura e configuração

- [ ] Confirmar servidor reservado, SSH/SSM, arquitetura das imagens, disco, memória e serviços existentes. Os limites do Compose somam aproximadamente 2,03 GiB, além do sistema e de outros projetos; isso não cabe com folga em uma EC2 compartilhada de 2 GB.
- [ ] Docker Engine/Compose disponíveis; Nginx/proxy da equipe inspecionado. Node.js 22.23+ no computador de preparação para executar gerador e scripts; não precisa instalar Python/Node no host EC2 para executar as imagens prontas.
- [ ] Papel da instância autorizado para S3 e `ses:SendEmail`; revisar `infra/aws/instance-policy.json` preservando outras políticas. Verificar IMDSv2 acessível pelos contêineres.
- [ ] Entrada pública somente 80/443 do proxy; SSH restrito à administração. Não publicar 5432, 9999 ou 3001. Saída HTTPS/DNS para S3/SES e dependências; SES é API HTTPS 443, sem SMTP/porta 25 nesta implantação.
- [ ] S3 com os quatro bloqueios públicos, prefixo dedicado e CORS de PUT para o domínio. Mesclar os templates `s3-cors.json` e `s3-lifecycle.json` às regras existentes, sem substituir a configuração de todo o bucket compartilhado.
- [ ] SES: produção liberada para alunos não verificados, remetente/DKIM/MAIL FROM, suppression e métricas de bounce/complaint verificados na região correta.
- [ ] Gerar **uma vez** `infra/aws/runtime/.env`, preencher `AWS_REGION`, `S3_REGION` e `S3_BUCKET`, revisar remetente, `EMAIL_REPLY_TO` e `SES_CONFIGURATION_SET` no catálogo e guardar uma cópia privada. O gerador não preenche dados reais da infraestrutura. Não copiar `.env` antigo para o runtime.

```bash
node infra/aws/generate-env.mjs
# Preencha as regiões e o bucket no arquivo privado antes de validar.
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml config --quiet
```

### 2. Imagens, banco e arquivos

- [ ] Construir imagens fora da EC2 se a máquina não tiver folga; registrar commit e tag de ambas. Transportar código e imagens, e os segredos separadamente.
- [ ] Iniciar apenas `db auth`; verificar saúde. Iniciar `api` uma vez para preparar `public` e interrompê-la antes da cópia. **Não iniciar `cleanup` durante a migração**, pois ele começa a limpeza imediatamente.
- [ ] Backup da origem e ensaio em destino vazio; definir janela sem novas escritas na produção antiga para o snapshot final. Não interromper os outros sistemas da máquina.
- [ ] Preparar conexão privilegiada do destino por rede privada/túnel, com arquivos privados de migração. Não abrir PostgreSQL para a internet.
- [ ] Executar prévia e aplicação de `migrate-aws-database.mjs`; conferir UUIDs, roles, hashes de senha, contagens, links e sequências. Contas com MFA exigem procedimento próprio; o script aborta.
- [ ] Executar prévia e aplicação de `migrate-aws-storage.mjs`; conferir SHA-256 dos arquivos. Não apagar os objetos de origem.
- [ ] Testar pelo menos uma conta administrativa e uma conta de professor migradas; o login exige nova sessão, preservando a senha. Outra conta não deve ver dados privados sem compartilhamento explícito.

### 3. Domínio, links antigos e entrada em produção

- [ ] Definir IP estável autorizado da EC2, DNS de `sirenia.morea-ifs.org`, certificado válido e virtual host próprio. Ajustar `WEB_BIND_PORT` e Nginx juntos se não usar 3080.
- [ ] Preservar acesso dos boletins já enviados. Links antigos apontam para `enem-leitor-web.vercel.app`, inclusive os renovados por 30 dias; copiar hashes no banco não muda esse endereço nem recupera tokens em claro.
- [ ] Escolher e testar a continuidade: manter temporariamente o frontend antigo apontando para a **mesma API/banco AWS**, ou implementar redirecionamento do `/boletim` preservando `#TOKEN`. Esse redirecionamento **não está configurado pelo Compose**. Nunca colocar tokens em query string, logs ou planilhas.
- [ ] Se optar por frontend Vercel → API AWS, reconstruir com `API_BASE_URL=https://sirenia.morea-ifs.org`, permitir a origem antiga explicitamente e validar o encaminhamento real de headers, incluindo `X-Forwarded-Proto`, cookies e limites. Se precisar alterar o proxy confiável, fazer revisão de segurança; não usar confiança irrestrita. O smoke test é obrigatório antes de adotar essa opção.
- [ ] Validar um link anterior e um novo, com titular/dados de teste autorizado, inclusive download de PDF. Após o corte, evitar duas bases aceitando novas escritas; reemissão de links exige revisão na aplicação.
- [ ] Iniciar a aplicação completa, passar os critérios de aceite abaixo e comunicar o corte. Não excluir a produção anterior até acabar a janela de rollback e a compatibilidade dos links.

```bash
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml up -d
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml ps
curl --fail --silent --show-error https://sirenia.morea-ifs.org/api/health
```

### 4. Operação contínua

- [ ] Backup diário no S3 testado e timer systemd ativo; restauração ensaiada em banco separado. Guardar os segredos/chaves necessários à restauração em canal seguro separado do dump.
- [ ] `cleanup` saudável, rodando a cada seis horas; retenção de dados 30 dias, links novos 30 dias. Envio/reemissão pode estender simulado e contato até o vencimento do link.
- [ ] Lifecycle do S3 alinhado ao prazo desejado para imagens: o template expira objetos por idade de criação, sem renovação automática ao reemitir um boletim. Banco e PDF gerado podem continuar válidos enquanto uma imagem antiga já expirou. Definir a política de imagens com a equipe, sem declarar que a extensão do banco prolonga o S3.
- [ ] Configurar alertas de disco, memória/OOM, falha de backup, erro de saúde, SES bounce/complaint e cota. CloudWatch não substitui a conferência do histórico na aplicação.
- [ ] Registrar responsável, acesso de recuperação, commit/imagens, data do corte, backup inicial e resultado dos testes. Rever custos de EC2, S3, SES e tráfego entre regiões.

## Critérios de aceite do responsável

No GitHub, aguarde os dois workflows: **Verificações do projeto** (`ci.yml`) e **Build e smoke test Docker** (`docker-build.yml`). O segundo constrói `api` e `web`, em sequência, e testa os contêineres sem rede externa/volumes. Não usa credenciais da AWS, não envia e-mail e não publica/deploya imagens. Os labels OCI registram o commit de cada imagem carregada no runner. Depois do merge, a atualização da EC2 continua sendo responsabilidade do operador.

| Fluxo | Resultado esperado |
|---|---|
| Saúde | `/api/health`: HTTP 200, `database: "ok"`, `processor.ok: true`. |
| Segurança | `/api/auth/config` indica autenticação obrigatória; GET anônimo de `/api/simulados` e `/api/contatos` retorna 401. Cadastro público continua bloqueado. |
| Conta/sessão | Admin cria professor diretamente, sem código de cadastro; login por senha, renovação, logout e remoção da conta funcionam. Códigos opcionais usam SES para conta existente. |
| Isolamento | Professores A/B não acessam simulados, contatos e entregas privados um do outro. Compartilhamento libera apenas o simulado escolhido e somente leitura. |
| Leitura | Provas fictícias distintas de 50/60 questões, fotos e PDF multipágina; matrícula por OCR/texto, brancos/duplas/incertas, chave revisada e correção manual. Respostas não podem vir da chave do professor. |
| Persistência | Segundo upload acumula resultados; retomar importação não duplica lote; recriar os contêineres preserva banco e S3. |
| Contatos/redação | Prévia e confirmação CSV/XLSX, edição/exclusão por proprietário, cinco competências e feedback; planilha não envia mensagens por si só. |
| Relatórios | Temas extras como Técnico, acertos/total sem média geral no boletim, PDF e planilha corretos, espelho privado. |
| E-mail | Ensaio com mailbox simulator e depois um destinatário de teste autorizado: plano → confirmação → SES MessageId → histórico → link → PDF. Não enviar toda a turma para testar. |
| Links | Novos links/reemissões com 30 dias; expirados/revogados bloqueados; links anteriores ao corte continuam atendidos no endereço original. |
| Backup/retorno | Restaurar cópia em destino vazio, testar login e dados; ensaiar rollback de imagem sem apagar o volume. |

O teste completo automatizado é para um **stack local isolado e descartável**, não para o banco migrado de produção. Ele cria contas, simulados e arquivos e envia ao mailbox simulator. Caminhos, nomes de contêiner e porta são fixos no script; detalhes no guia. A validação histórica não dispensa repetir o aceite na infraestrutura final.

## Diagnóstico rápido

Todos os comandos partem da raiz da instalação. Logs podem conter dados de operação; compartilhar apenas trechos saneados.

```bash
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml ps
docker compose --env-file infra/aws/runtime/.env -f infra/aws/compose.yaml logs --tail=100 api auth cleanup
docker stats --no-stream
df -h
```

| Sintoma | Conferir antes de alterar algo |
|---|---|
| 502 no site | Nginx, upstream/porta 3080, serviço `web`, saúde da API e memória disponível. |
| Login indisponível | `auth` e `db`, chaves geradas com o mesmo JWT secret, migração de contas/roles, `AUTH_BASE_URL` privado. Não desligar autenticação. |
| `AccessDenied` no S3 | Papel da instância, bucket/região/prefixo e `s3:GetBucketPublicAccessBlock`; CORS se a falha for no upload do navegador. |
| Sem credenciais AWS | IAM instance profile, IMDSv2/hop limit, saída de rede e ausência de credenciais locais antigas sobrepondo o papel. Não resolver criando access keys permanentes na imagem. |
| SES recusa envio | Região, sandbox, identidade, configuration set, IAM, endereço/Reply-To, suppression e cotas. Não há fallback EmailJS no Compose AWS. |
| Envio sem confirmação | Conferir provedor/histórico antes de liberar tentativa revisada. Timeout não comprova falha; repetir cegamente pode duplicar mensagens. |
| Link expirado/inválido | Link do dia correto, prazo, revogação, mudanças no conteúdo/contato e domínio antigo; usar Reemitir link com nova revisão. Não desativar a proteção do boletim. |
| Imagem ausente com boletim válido | Migração do objeto, chave/prefixo, IAM e idade/lifecycle do S3; reemissão do link não renova a idade do objeto. |
| Senha do banco mudou no `.env`, mas não conecta | Volume existente não reexecuta `init-db.sh`; conferir rotação coordenada no banco, API e Auth. Nunca apagar volume para corrigir login. |

## Informações que precisam ser entregues em particular

- Acesso ao repositório e acesso AWS/DNS com a equipe, usando identidades individuais.
- Arquivo AWS gerado ou local seguro em que o responsável o gerará e guardará.
- Conexões de origem com CA e chaves de servidor para a migração; não inserir na documentação.
- Conta administrativa migrada e processo de recuperação de senha autorizado pelo titular.
- Contato responsável pela liberação SES, domínio e decisões de capacidade/custo.

Nenhuma senha de usuário, access key, token de boletim, planilha de contatos ou dump acompanha estes documentos no Git.

## Validação desta documentação em 30/10/2026

O catálogo foi comparado às referências de ambiente do código de aplicação, scripts operacionais, Compose e Dockerfiles: **86 nomes cobertos**, incluindo os valores fixos dos contêineres. As **22 entradas** produzidas pelo gerador estão descritas. Em diretório temporário isolado, foram conferidos modo `600/700`, senhas distintas, assinatura das chaves do Auth e recusa de sobrescrita; o Compose resultante foi validado com os cinco serviços, SES explícito e publicação apenas da porta web em loopback. Os valores do `.env.example` foram preservados; suas alterações são comentários.

Também foram conferidos 19 links locais, sintaxe de 26 blocos Bash, JSON de exemplo e sintaxe JavaScript do provisionamento inicial. **Não foram iniciados serviços, migrados dados, criadas contas ou enviados e-mails nessa revisão documental.** Os testes completos da aplicação e o aceite da EC2 permanecem os procedimentos das seções anteriores.
