<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Auditoria visual obrigatória

Após qualquer alteração visual nova na interface, faça uma auditoria real no navegador antes de considerar o trabalho concluído. Abra as telas e os estados afetados, incluindo os formulários, mensagens e componentes compartilhados que a alteração alcançar.

- Confira pelo menos um tamanho de desktop (1280 px ou mais) e um de celular (entre 360 e 390 px de largura). Verifique também os pontos de quebra relevantes quando o layout mudar entre esses tamanhos.
- Inspecione sobreposição, cortes, rolagem horizontal indevida, alinhamento, espaçamento e legibilidade. Confira a apresentação e a interação dos campos, botões, checkboxes e radios, além da indicação de foco ao navegar pelo teclado.
- Capture e examine screenshots dos estados auditados em desktop e celular. Guarde as evidências localmente em uma pasta de artefatos ignorada pelo Git e informe quais telas e tamanhos foram conferidos, corrigindo os problemas encontrados e repetindo a inspeção após a correção. Não exponha senhas, tokens ou dados pessoais nas evidências compartilhadas.
- Build, typecheck, testes automatizados e leitura de código complementam a verificação, mas não substituem a auditoria visual no navegador. Se o navegador estiver indisponível, informe a limitação e não declare a auditoria visual concluída.
