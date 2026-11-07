# Validação da migração AWS — 24/10/2026

## Resultado

O stack Docker local funciona com Next.js, NestJS/Python, PostgreSQL e GoTrue próprios, S3 privado e SES reais. **A publicação no servidor AWS ainda não foi executada**: falta acesso ao servidor reservado e avaliação de sua capacidade. A produção anterior e seus dados foram preservados.

## Verificações executadas

| Verificação | Evidência / resultado |
|---|---|
| API | 333 testes passaram, sem falhas ou testes ignorados |
| Python/OpenCV | 40 testes passaram, incluindo degradações, identidade, PDFs e rejeição de modelos inválidos |
| TypeScript | Typecheck de API e web aprovado |
| Build | Imagens `sirenia-api:aws` e `sirenia-web:aws` construídas; serviços de aplicação saudáveis |
| Dependências | `npm audit --omit=dev`: zero vulnerabilidades informadas na execução |
| Banco | Schema PostgreSQL, permissões de anon/authenticated, rollback e sequências verificados |
| Sessão | Login real por GoTrue, cookies Secure/HttpOnly, refresh de 604800 segundos e logout |
| Isolamento | Outra conta autenticada recebeu 404 ao acessar o simulado privado |
| Gabarito | PNG sintético com respostas aleatórias enviado ao S3 e lido exatamente como a verdade conhecida |
| Upload | URL assinada com criptografia e `If-None-Match`; segunda gravação recusada com HTTP 412 |
| PDF coletivo | Duas páginas, matrículas fictícias `000123` e `000124` extraídas por OCR, sem depender do nome do arquivo |
| Correção | Respostas distintas, branco e dupla preservados; 50 e 60 questões corrigidas |
| Retomada | Repetir o processamento concluído manteve o mesmo envio |
| Contatos | CSV importado com associação exata pela matrícula |
| Redação | XLSX com cinco competências importado; soma 800, feedback preservado |
| Boletim | PDF gerado e renderizado; contagens por área/tema, tema Técnico e competências presentes, sem média geral |
| Excel | Exportação com resultados e redação validada |
| Arquivo privado | Imagem de revisão recuperada do S3 mediante autenticação |
| E-mail integrado | ReportsService → SES real → mailbox simulator, MessageId e estado ENVIADO no histórico |
| E-mail solicitado | SES aceitou um diagnóstico para o destinatário de teste autorizado, somente com dados fictícios |
| Monitoramento | CloudWatch registrou eventos Delivery para a configuração `sirenia`; isso não confirma pasta de entrada/leitura |
| Backup | Dump real transmitido ao S3 com AES256 e restaurado num banco separado; contagens de contas, simulados e resultados coincidiram |
| Migração de contas | Script aplicado entre bancos de ensaio; UUID, hash de senha, role e login no Auth migrado preservados |
| Origem dos arquivos | Prévia identificou 377 objetos no Storage atual; nenhum foi removido ou migrado antes do corte |

Os cartões foram gerados independentemente do localizador OpenCV. O teste completo não substitui o leitor, o Auth, o banco, o S3 nem o SES por mocks. Os testes unitários de falhas do provedor usam simulações para cobrir recusas, timeout, erro 5xx e ausência de confirmação sem provocar mensagens reais duplicadas.

## Auditoria visual

Login e boletins conferidos no Chrome. Screenshots em desktop 1440 × 1000 e celular 390 × 844; a página não ultrapassou a largura do celular. As tabelas têm rolagem horizontal interna. Não foi observada sobreposição nos estados conferidos. O PDF foi renderizado em todas as páginas; o feedback da redação passou a permanecer junto da seção correspondente.

O upload pela interface Chrome não pôde ser concluído porque a extensão não tem a opção “Allow access to file URLs” habilitada. O upload assinado foi validado por HTTP real contra S3. Essa limitação de automação do navegador permanece registrada, sem declarar esse passo visual como aprovado.

Os logs, screenshots, matrizes de respostas, PDF e XLSX de ensaio ficam em `artifacts/aws-migration-2026-10-24/`, ignorado pelo Git. Credenciais e tokens de teste não fazem parte das evidências publicadas no repositório.

## Impedimentos externos

1. A sessão SSO não possui acesso SSM nem `ec2-instance-connect:SendSSHPublicKey`. O usuário solicitou acesso ao supervisor.
2. A EC2 compartilhada precisa de inspeção de capacidade e dos sistemas existentes. Não houve instalação, troca de proxy, mudança de tamanho ou criação de outra máquina.
3. O papel da EC2 precisa de permissão SES limitada ao remetente. A política proposta está em `infra/aws/instance-policy.json`.
4. A AWS negou o acesso SES de produção no inventário inicial; os detalhes do chamado ficam no canal privado de suporte. O papel SSO também não pode consultar o motivo no suporte. Até resolver, só destinatários verificados e o simulador podem receber.
5. O registro A de `sirenia.mage.dev.br` e o HTTPS ainda não foram ativados: o servidor precisa estar preparado antes do corte. Os registros DNS do e-mail já estão salvos e verificados.

Não há garantia de capacidade em produção, entrega em caixa de entrada ou publicação concluída a partir desses testes locais. O procedimento e o checklist de corte estão em `GUIA-AWS.md`.
