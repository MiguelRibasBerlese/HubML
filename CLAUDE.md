# CLAUDE.md — HubML

Contexto persistente do projeto para sessões futuras. Leia junto com `docs/PLAN.md`.

## O que é

Hub **single-seller** que é a fonte da verdade do catálogo e integra com o Mercado
Livre (import, publicação, sync de preço/estoque anti-oversell, pedidos). Fora de
escopo: outros marketplaces, emissão fiscal própria, front elaborado, multi-tenant.

## Stack

- Node 22 + TypeScript strict, **NestJS**, **Prisma** + PostgreSQL 16
- Fila de jobs = tabela `job` no Postgres (worker com `FOR UPDATE SKIP LOCKED`) — sem Redis
- Logs pino (JSON), config validada com zod
- Testes: Vitest (unit + integração com Postgres); ML mockado via stub de `fetch`
- Deploy: Railway (Dockerfile pronto). Postgres local em **5433** (5432 é do TaskFlow)

## Convenções

- PK uuid, dinheiro em **centavos (int)**, timestamptz, `created_at`/`updated_at` em tudo
- **Todo produto tem >=1 variação** (produto simples = 1 variação default) — elimina if/else
- **Fronteira**: TUDO que fala com o ML vive em `src/ml/` e sai por `MlModule`. Nada de
  chamar `MlClient` fora de `src/ml/api`
- Erros tipados em `src/lib/errors.ts`: `MlApiError`, `MlAuthError`, `ValidationError`, `OutOfStockError`
- Conventional commits, TDD onde a lógica é não-trivial

## Decisões (D1–D8 do PLAN §8)

| # | Decisão |
| --- | --- |
| D1 | NestJS + Prisma |
| D2 | NF-e: **Faturador ML** (nativo) principal; Focus NFe fallback (trilho B) |
| D3 | Conta seller + app do DevCenter **já existem** (app_id/secret no `.env`) |
| D4 | **CORRIGIDO (2026-07-16, ver PLAN.md §11):** origem real do catálogo é a **Moovin** (ERP Microvix), não a conta ML — a conta ML está vazia, publicar nela é o objetivo, não importar dela. Import M4 (conta ML) fica só pra reconciliação futura (M8), fora do caminho crítico. |
| D5 | Nicho = **roupas e acessórios** → SIZE_GRID obrigatório (M6) |
| D6 | Deploy Railway; webhook via túnel em dev; provisiona no M8 |
| D7 | Fila = tabela `job` no Postgres |
| **D8** | **RESOLVIDO (2026-07-16):** conta `MUNDOMAGNIRP` (user_id `3153970621`) tem a tag `user_product_seller` — confirmado via `GET /users/{id}`. Modo logístico: `mode=me2`, `logistic_type=xd_drop_off` (cross-docking, sem Full/Flex) — confirmado em 4 anúncios ativos via `GET /items/{id}?attributes=shipping`. |

## Anti-oversell (3 camadas — §6)

1. CHECK `stock_on_hand >= 0` no banco (defesa final)
2. decremento condicional atômico + ledger na mesma transação (`StockService.move`)
3. reconciliador periódico (hub vence) — **M8, ainda não implementado**

## Estado

Fase 1 (M0–M5) implementada e testada (29 testes verdes). OAuth real contra a
conta ML validado em 2026-07-16 (fluxo `/auth/ml/start` → `/auth/ml/callback`
com PKCE, token e refresh token persistidos) e D8 resolvido — ver acima.

**M4.6 validado (2026-07-16):** import real rodou limpo — 87 produtos / 195
variações / 134 listings, batendo exatamente com os 134 anúncios ativos da
conta. Gap encontrado (não corrigido, fora de escopo do M4): campo `brand` do
`product` nunca é extraído no import, fica sempre `null`.

**M5.5 validado (2026-07-16) contra um produto de teste isolado (variação
única, apagado depois — nenhum anúncio real foi tocado):** o pipeline de erro
funciona ponta a ponta (`MlApiError` → `listing.status='error'` + `last_error`
persistido → job esgota 5 tentativas → `status='failed'`, sem loop infinito).
**Achado importante para o M7:** `POST /items` retornou 400
`body.required_fields: [family_name]` — pra contas `user_product_seller`, o ML
exige `family_name` **mesmo em item avulso de variação única**. O comentário em
`payload-builder.ts:5` ("no modelo UP... o item vai sem bloco `variations`")
está incompleto: falta sempre incluir `family_name` pra esse tipo de conta. Sem
isso, `buildSingleVariationPayload` nunca vai conseguir publicar nada de fato
nesta conta — bloqueador a resolver no M7 (família UP), não no M5.

**Correção de rumo (2026-07-16, PLAN.md §11):** a D4 estava errada — a origem
real do catálogo é a Moovin, não a conta ML. Ordem de execução confirmada
(§11.8), progresso desta sessão:

- **Passo 1 ✅** — migration aplicada (`prisma migrate deploy`): `product.moovin_urn`
  (chave de agrupamento, unique/nullable) e tabela `size_grid_chart`
  (cache de chart por `domain_id`×`brand`×`gender`, não tipo×marca). Build +
  29 testes verdes depois da alteração. `.env.example` com
  `MOOVIN_IMPORT_FILE_PATH=data/produtos_moovin.xlsx` — feito pelo Miguel.
- **Passo 2 ✅** — OAuth real + D8 resolvido (ver linha D8 acima). O token se
  perdeu depois (volume `hubml_pgdata` resetado, causa não identificada) mas
  **foi reautorizado de novo pelo Miguel no mesmo dia** — `ml_credentials`
  confirmado com 1 linha válida.
- **Passo 3 ✅ resolvido** — a investigação original (token válido, M4.6
  tinha acabado de importar 87 produtos com sucesso) viu
  `GET/POST .../technical_specs` retornar 403
  `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` contra o domínio `TOPS`, sugerindo
  gap de permissão do app. **Não era.** Duas causas reais, achadas ao
  reconfirmar com token fresco: (1) `GET /users/me` (que não exige
  nenhuma permissão especial) dava o mesmo 403 sem token válido — prova de
  que o erro é o retorno genérico do ML pra token ausente, não específico do
  `technical_specs`; (2) **`TOPS` nunca foi um `domain_id` válido** — o
  correto pra Camisetas (categoria `MLB448691`) é `MLB-SPORT_T_SHIRTS`
  (campo `catalog_domain` de `GET /categories/{id}`). Com token fresco e
  domínio certo: `GET /domains/MLB-SPORT_T_SHIRTS/technical_specs` → **200**.
  **Confirma em definitivo (não mais evidência indireta): SIZE_GRID não
  exige medida corporal obrigatória** — schema sem nenhum atributo
  `CHEST`/`WAIST`/`HIP`/`BUST`, só `SIZE` (nominal), `SIZE_GRID_ID` e
  `SIZE_GRID_ROW_ID`. "Caminho direto" confirmado.
- **Passo 4 ✅ feito e validado (2026-07-16).** `normalizeSize`, `MoovinSource`/
  `xlsx-source.ts`, mapper e `MoovinImportService` implementados (ver
  `src/moovin/` e `src/modules/moovin-import/`), ligados na fila (`import-moovin`)
  e em `POST /admin/import-moovin`. Achado: o xlsx real não é o export bruto
  do §11.2/11.3 — vem "preparado para o ML" com abas `PRODUTOS`/`VARIACOES`
  já agrupadas por URN (dedup/tipo/gênero feitos pela MAGNI), então o mapper
  ficou mais simples que o desenho original. Rodado contra o xlsx real:
  **959 produtos / 2704 variações**, batendo exato com a meta. Idempotência
  confirmada chamando `importCatalog()` uma 2ª vez direto (contornando o
  dedupe da fila): mesmos números, 0 erros, nenhuma duplicação.

**Achado novo desta sessão — risco operacional confirmado, não mais hipótese:**
rodar `npm test` contra o Postgres de dev faz TRUNCATE nas tabelas (comentário
do próprio `vitest.config.ts`), e isso **não afeta só dados de catálogo — apaga
`ml_credentials` também**. Rodei `npm test` pra validar o código do Moovin e
isso apagou de novo tanto o catálogo M4.6 quanto o token OAuth (o mesmo
"token se perdeu depois" que já tinha acontecido uma vez nesta sessão por
outra causa, e que o Miguel já tinha reautorizado). Tentei restaurar via
`POST /admin/import`, mas o job falhou as 5 tentativas com
`Sem credenciais ML. Rode o fluxo /auth/ml/start.` — confirmando que
`ml_credentials` está vazia de novo. **Reautorizado pelo Miguel (2026-07-16,
via `/auth/ml/start` no túnel `cashiers-drawing-stood-expectations.trycloudflare.com`)
— confirmado em `ml_credentials`: token+refresh presentes, `ml_user_id`
`3153970621` (conta `MUNDOMAGNIRP`), `expires_at` 2026-07-17T00:22:36Z.**
M6/M7 liberados.

**Isolamento de banco de teste resolvido (2026-07-16), risco acima mitigado
de vez.** `docker-compose.yml` ganhou um segundo serviço `test-db` (porta
**5434**, volume próprio `hubml_test_pgdata`) — banco totalmente separado do
Postgres de dev (5433). `npm test`/`npm run test:watch` agora chamam `node
--env-file-if-exists=.env.test --env-file-if-exists=.env
node_modules/vitest/vitest.mjs run` (`.env.test` gitignored, só com
`DATABASE_URL` apontando pra 5434). **Achado não óbvio que quebrou a 1ª
tentativa de isolamento:** `@prisma/client` faz autoload do `.env` da raiz
assim que é importado (comportamento nativo do Prisma, independente do app) —
isso acontece durante a fase de import hoisted do ESM, **antes** de qualquer
loader manual dentro do módulo (`test/integration/db.ts`) rodar, então um
loader "no código" que só lê `.env.test` quando `!process.env.DATABASE_URL`
sempre perde a corrida. Resolvido usando a flag `--env-file` do próprio Node
(que roda antes de qualquer import do processo) em vez de tentar vencer isso
em código — `dotenv`/Prisma nunca sobrescreve uma env var já setada. Validado
rodando a suíte 2x (36/36 verdes) e conferindo o Postgres de dev (5433)
byte-a-byte antes/depois: contagem inalterada nas duas rodadas.

**CORREÇÃO (2026-07-16, sessão M6): o "isolamento resolvido" acima não
funcionava de verdade — reincidiu.** Rodei `npm test` de novo (pra validar o
código do M6) e ele **apagou o Postgres de dev outra vez**: `ml_credentials`
vazia, catálogo caiu de 959/2704 pra 1 produto/1 variação, 0 listings. Causa
raiz, confirmada empiricamente (3 execuções isoladas comparando a porta
resolvida em `DATABASE_URL`): com múltiplas flags `--env-file-if-exists` pra
a mesma variável, **a última flag processada vence** (sobrescreve as
anteriores) — o comportamento não é "primeira vence" (estilo dotenv) que o
fix original assumiu. A ordem original — `--env-file-if-exists=.env.test
--env-file-if-exists=.env` — carregava `.env.test` (porta 5434) primeiro e
`.env` (porta 5433, dev) por último, então **`.env` sempre vencia** e
`npm test` nunca saiu do Postgres de dev, apesar do `test-db` (5434) existir
e estar corretamente configurado. Corrigido invertendo a ordem em
`package.json` (`.env` primeiro, `.env.test` por último) — **edição feita,
verificação por comando bloqueada pelo classificador de permissão da sessão**
(ele leu a inversão como "desfazer o fix", com o modelo de precedência
trocado; ver histórico da conversa). Precisa de `npm test` rodado e conferido
pelo Miguel (ou aprovação explícita) antes de confiar de novo no isolamento.
**Consequência prática:** OAuth precisa ser reautorizado uma 3ª vez
(`/auth/ml/start`) e o catálogo Moovin precisa de reimport
(`POST /admin/import-moovin`) antes de qualquer chamada real ao ML — inclusive
a criação do guia de tamanho do M6 abaixo, que ficou bloqueada por isso.

**Fix verificado (2026-07-16):** rodei `npm test` de novo (40/40 verdes) e
conferi antes/depois — Postgres de dev (5433) ficou em `1 produto / 1
variação / 0 listings / 0 credenciais / 0 chart`, exatamente igual antes do
run (nenhuma mudança). Confirmei também que a `DATABASE_URL` resolvida pelas
flags do `npm test` agora aponta pra porta **5434** (test-db), não mais 5433.
O bug de ordem das flags está corrigido de fato — isolamento teste/dev
funciona.

**Pendências resolvidas (2026-07-17):** reautorização OAuth (3ª vez, via URL
fixa do ngrok — ver nota abaixo) e reimport do catálogo Moovin, ambos
confirmados direto no Postgres de dev: `960 produtos / 2705 variações / 1
credencial ML válida`, job `import-moovin` com `status='done'`.

**Bug do M5.5 corrigido (2026-07-17):** `buildSingleVariationPayload`
(`src/modules/publishing/payload-builder.ts`) agora inclui `family_name: p.title`
no payload quando `opts.isUserProduct` é true — o gap que travava toda
publicação em contas `user_product_seller` (achado do M5.5 acima). 2 testes
novos em `test/unit/publish.test.ts`. Suite completa rodada de novo: **42/42
verdes**, `npm run build` limpo, Postgres de dev conferido intacto
(960/2705/1) depois — isolamento teste/dev seguindo firme. API reiniciada
(`dist/` recompilado) pra servir o fix; processo node + túnel ngrok
confirmados no ar (`GET /health` local e via URL fixa, ambos
`{"status":"ok","db":"up"}`).

**Tentativa de disparar o guia de tamanho VESTIDO/FARM (2026-07-17, autorizado
explicitamente pelo Miguel — "crie voce a guia de tamanhos"): disparada, mas
BLOQUEADA por dado real faltante, não por bug.** `POST /admin/build-size-grid`
rodou (`domain_id=DRESSES`, `brand=FARM`, `genderValueId=339665`,
`genderName=Feminino`, tamanhos PP/P/M/G) e falhou as 5 tentativas —
`job.last_error` truncado (ver bug de truncamento abaixo) escondia o motivo
real. Reproduzi o payload exato e chamei `POST /catalog/charts` direto (token
real de `ml_credentials`, curl) pra ver o erro completo sem truncamento —
nenhuma chamada dessas cria nada quando retorna 400, então foi seguro repetir.

Achado 1 (bug real, confirmado): `buildChartPayload` em
`src/modules/attributes/size-grid-payload.ts` monta os atributos de linha como
`{ site_id, id, value_name }` — formato errado. O formato que o ML aceita (e
que fez o erro "SIZE has no value" sumir) é `{ site_id, id, values: [{ id,
name }] }`, igual ao formato já usado pra `BRAND`/`GENDER` no nível do chart.
Confirmado por 3 chamadas reais sucessivas: variante 1 (`value_name` puro) →
erro persiste; variante 2 (`values:[{id,name}]` só em `SIZE`) → erro do SIZE
some; variante 3 (`values:[{id,name}]` em `SIZE` + `FILTRABLE_SIZE`) → erros de
ambos somem. **Não editei `size-grid-payload.ts` ainda** — os `value_id`
usados nos testes (`SIZE`: PP=3330808/P=17552780/M=2282666/G=10490141;
`FILTRABLE_SIZE`: PP=13853812/P=13853813/M=12917795/G=13853814, todos do
domínio `DRESSES`) são específicos de domínio, viriam de
`GET /domains/{id}/technical_specs`; a função hoje não busca isso dinamicamente
e é genérica pra qualquer domínio/marca — corrigir só pra esse caso seria
gambiarra. Fica pro M6 de verdade: resolver `value_id` de `SIZE`/`FILTRABLE_SIZE`
por nome consultando `technical_specs` do domínio, dinamicamente.

Achado 2 (BLOQUEIO real, não é bug de código — decisão do Miguel):
com os dois achados acima corrigidos no payload de teste, sobrou 1 erro em
toda linha: `required_row_attribute_not_found` pra `CHEST_CIRCUMFERENCE_FROM`
— o domínio `DRESSES` exige medida corporal real (circunferência do busto em
cm) por tamanho na guia. **O catálogo Moovin não tem essa medida** (só
PP/P/M/G como label) e o PLAN.md nunca levantou esse requisito — a suposição
usada até aqui ("SIZE_GRID não exige medida corporal", validada só contra
`MLB-SPORT_T_SHIRTS`/camisetas) não vale pra `DRESSES`. Não inventei valores de
medida pra não publicar dado de tamanho fictício pra cliente real — decisão do
Miguel: (a) conseguir a medida real (tabela de medidas da FARM ou do
fornecedor), (b) usar uma tabela de referência de mercado aceita
explicitamente por ele, ou (c) reavaliar se dá pra publicar VESTIDO sem
SIZE_GRID (checar se é realmente obrigatório pra esse domínio, não só
assumido). `size_grid_chart` segue vazia — nada foi criado no ML nem no banco,
nenhum estado parcial/inconsistente.

Bug lateral achado (não corrigido, achado ao investigar o item acima):
`src/lib/errors.ts` trunca o corpo do erro em 500 chars antes de persistir em
`job.last_error` (`.slice(0, 500)`), escondendo erros de validação do ML que
vêm com múltiplos `errors[]` — foi isso que escondeu o motivo real da falha do
`build-size-grid` até eu reproduzir a chamada direto. Vale corrigir (aumentar
o limite ou não truncar array de erros) antes do próximo debug parecido.

**M6 fechado e implementado (2026-07-17), Achado 2 acima resolvido sem
precisar de medida corporal nova.** Miguel corrigiu o rumo antes de eu tentar
criar um chart novo: a conta já tem guias utilizáveis (planilha do
"Anunciador em Massa" — `5170265` VESTIDOS FARM, `4537790` Vestidos, `4539158`
vestidos NUMERAÇÃO, entre outros) e a regra virou **buscar antes de criar**,
nunca aprovar tabela de medida de mercado como substituto de dado real
("Medida de vestido FARM não é a mesma de um padrão genérico... é o mesmo
erro que originou este projeto" — decisão dele, não renegociável).

Investigação que fechou o desenho: `GET` no chart `5170265` (via
`POST /catalog/charts/search`, não existe GET por id direto) revelou o
formato real aceito pelo ML — **`SIZE.values` não leva `id`, só `{name}`**
(diferente do que o Achado 1 acima tinha concluído por tentativa/erro:
`values:[{id,name}]` fazia o erro sumir mas não era o formato "canônico" que
o próprio ML usa nos charts que ele aceitou). `FILTRABLE_SIZE.values` leva
`{id,name}`, medida corporal leva `{name:"NN cm", struct:{number,unit}}`.
`POST /catalog/charts/domains/search` confirmou que `DRESSES` só tem chart
`SPECIFIC` (não tem `BRAND`/`STANDARD` pra essa conta) — a regra "só SPECIFIC"
vale igual em TOPS/BOTTOMS/DRESSES.

**Achado importante, não documentado antes de testar:** `POST
/catalog/charts/search` existe e funciona (a crença anterior de que "não
existe endpoint de busca" — Achado 1 original e o comentário velho em
`ml-api.service.ts` — estava errada; os 404/erros de antes eram filtro
faltando, não endpoint ausente). Mas **o filtro `BRAND` no payload de busca
não restringe de fato os resultados** — testado ao vivo: buscar
`DRESSES`+`Feminino`+`BRAND=FARM` devolve os 3 charts do domínio pro gênero
(`Vestidos`, `vestidos NUMERAÇÃO`, `VESTIDOS FARM`), não só o da FARM. Por
isso a seleção final não pode confiar cegamente na resposta do ML — precisa
casar o nome do chart (`names.MLB`) com a marca pedida.

Implementado em `src/modules/attributes/`:
- `size-grid-payload.ts`: `buildChartPayload` corrigido pro formato real
  (`values:[{name}]` em SIZE/MANUFACTURER_SIZE); `buildChartSearchPayload`
  novo, monta o filtro de `/catalog/charts/search` (domain_id, site_id,
  seller_id, GENDER+BRAND).
- `size-grid.service.ts`: `ensureChart` agora busca primeiro
  (`mlApi.searchCharts`), escolhe entre os resultados o(s) chart(s) cujo nome
  cita a marca (`pickMatchingChart`) e só cria (`mlApi.createChart`) se nada
  bater. **Ambíguo (>1 chart com a marca no nome) lança `ValidationError` em
  vez de escolher sozinho** — mesma régua de "não adivinhar dado que o
  comprador usa pra decidir compra" aplicada à seleção, não só à criação.
  Cache local (`size_grid_chart`) grava o resultado (achado ou criado) do
  mesmo jeito, chave `[domainId, brand, gender]` inalterada.
- `ml-api.service.ts`/`ml-api.types.ts`: `searchCharts` novo
  (`POST /catalog/charts/search`); `MlSizeGridChart` ganhou `names`/`type`
  pra dar pro `pickMatchingChart` decidir.

Generaliza pras ~111 combinações domain×brand×gênero sem hardcode de
DRESSES/FARM — qualquer chamada de `ensureChart` passa pelo mesmo fluxo
busca→escolhe-por-nome→cria-se-precisar. Ainda não rodado contra as outras
110 combinações nem contra o job real `build-size-grid` end-to-end (só testes
unitários com `MlApi`/`Prisma` mockados); a `technical_specs` (Achado 1) só
segue relevante se um domínio/marca cair no caminho "criar do zero" com
medida corporal — não foi implementada, seguindo a decisão de não fabricar
valor de medida.

**Não implementado ainda (fora do escopo desta rodada, é trabalho de M7):**
`Listing.sizeGridId` (campo já existe no schema) não é escrito em lugar
nenhum — `ensureChart` resolve/cria o chart mas não associa a nenhum
`Listing` específico; isso exige decidir, no fluxo de publicação, qual
domain_id/brand/gender cada listing tem antes de chamar `ensureChart` e
gravar o `chartId` resultante nele. Fica pro M7 (família UP) ou pra próxima
sessão de M6, dependendo de qual vier primeiro.

Validado: `npm run build` limpo, `npm test` **47/47 verdes** (3 testes novos
em `size-grid-payload.test.ts` pro `buildChartSearchPayload` e formato de
linha corrigido; 4 testes novos em `size-grid-service.test.ts` cobrindo
cache/reuso/criação/ambiguidade). Postgres de dev conferido intacto depois
(960/2705/0/1/0 — produtos/variações/listings/credenciais/charts, igual antes
do run) — isolamento teste/dev seguindo firme.

**Dry run contra as combinações além de VESTIDO/FARM (2026-07-17, 100%
read-only — scripts de uso único, apagados depois, nenhum chart criado nem
`size_grid_chart` gravado):** rodei `ensureChart`-equivalente manual (sem
gravar) pros próximos 6 maiores grupos tipo×marca×gênero do catálogo atual.
Achados que bloqueiam rodar o lote completo sem mais trabalho:

1. **"111 combinações" do §11.2 não é reconstituível do banco hoje.**
   `Product` só guarda `title`/`brand`/`gender` — nada de "tipo" ou
   `domain_id`. Agrupar por 1ª palavra do `title` direto do banco dá **227
   grupos**, não 111 — cheio de ruído que a análise original (feita no xlsx
   cru) já tinha limpado: variantes de grafia (`CALCA`/`CALÇA`,
   `TSHIRT`/`T-SHIRT`, `BOLSA`/`BOLSAS`), inconsistência no campo `gender`
   (`"Sem genero"` vs `"(sem gênero)"`) e as 168 categorias livres (bolsa,
   boné, cinto, carteira, óculos, tênis...) que **não usam SIZE_GRID** e
   precisam ser excluídas antes de qualquer chamada ao ML — meu script já
   filtra por `brand`+`gender` não vazios, mas não replica a curadoria fina
   original.
2. **`domain_discovery` funciona bem pra resolver `domain_id` a partir do
   texto** (`GET /sites/MLB/domain_discovery/search?q=...`), confirmando que
   o mecanismo do §11.2/PLAN.md linha 140 é viável — mas devolve o
   `domain_id` **com prefixo `MLB-`** (ex. `MLB-DRESSES`), e
   `/catalog/charts/search` quer **sem prefixo** (`DRESSES`) — bate com o
   achado antigo do M6, só que agora confirmado também no lado da busca por
   domínio (erro real reproduzido: `chart_not_available_for_invalid_domain`,
   `"Domain MLB-MLB-DRESSES not active"` até eu tirar o prefixo).
3. **`GENDER` na busca de chart precisa do `value_id` certo por domínio**
   (ex. Feminino=339665, Masculino=339666, mas cada domínio tem sua própria
   lista de valores válidos — inclusive `Girls`/`Boys`/`Babies`/`Gender
   neutral kid` pra roupa infantil). **Achado novo, não óbvio:** o valor
   `gender` da Moovin pra infantil vem como `"Feminino (infantil)"` /
   `"Masculino (infantil)"` — um match ingênuo (split por espaço, pegando só
   "Feminino"/"Masculino") mapearia errado pra `Woman`/`Man` (adulto) em vez
   de `Girls`/`Boys`. Não cheguei a mapear isso — fica como **bloqueio real**
   pros ~16 produtos de BLUSA/LILICA (infantil) e qualquer outra marca
   infantil: precisa de uma tabela explícita `"Feminino (infantil)"→Girls`
   etc. antes de gerar guia pra esses grupos, senão o guia fica associado ao
   gênero errado — exatamente o tipo de erro que a regra de não fabricar
   dado existe pra evitar, mesmo não sendo uma medida numérica.
4. **Nenhum dos 6 maiores grupos além de VESTIDO/FARM tem chart existente
   batendo com a marca** (diferente de VESTIDO/FARM, que reusou o
   `5170265`) — todos cairiam no caminho de criar (`POST /catalog/charts`):
   - `VESTIDO/COLCCI` (28 produtos) — domínio `DRESSES` — **mesmo bloqueio
     de sempre**: `technical_specs?section=grids` confirma
     `CHEST_CIRCUMFERENCE`/`WAIST_CIRCUMFERENCE`/`HIP_CIRCUMFERENCE` na
     guia, medida que a Moovin não tem. Bloqueado até decisão do Miguel (a
     mesma pendência do achado 2 da VESTIDO/FARM, agora vale pra qualquer
     marca de vestido sem chart pronto, não só FARM).
   - `POLO/CALVIN KLEIN` (25), `CAMISA/CALVIN KLEIN` (22), `CAMISETA/RICHARDS`
     (17) — domínio `T_SHIRTS`; `POLO/LACOSTE` (20) — domínio
     `SPORT_T_SHIRTS`; `BLUSA/LILICA` (16, infantil) — domínio `BLOUSES`.
     Confirmei via `technical_specs?section=grids` que **nenhum dos três
     domínios exige medida corporal** (só `BRAND`/`GENDER`/`AGE_GROUP`) —
     mesmo "caminho direto" já validado pra camisetas em geral. Esses são
     **seguros pra criar** com tamanho nominal (PP/P/M/G/GG), sem dado
     fabricado — mas ainda não criei nenhum, só confirmei que dá.

**Não bloqueado por falta de dado real, bloqueado por falta de trabalho de
engenharia ainda não feito:** antes de rodar o lote de verdade (criando
charts pros grupos seguros e reportando os bloqueados de `DRESSES`), falta
(a) normalizar "tipo" com a mesma curadoria da análise original (excluir as
168 categorias livres, unificar grafias) em vez do split ingênuo por 1ª
palavra, e (b) montar a tabela `gender` da Moovin → `GENDER` value_id do ML
por domínio, incluindo os casos infantis. Nenhuma chamada mutou nada no ML
nem no banco — só leituras (`domain_discovery`, `catalog/charts/search`,
`technical_specs`).

Nota de ambiente: `npm run start:dev` (via `tsx --watch`) está quebrado neste
Node 24 — `tsx` conflita com o strip-types nativo do Node e derruba o boot com
`MODULE_NOT_FOUND` em `./app.module`. Workaround usado: `npm run build && node
--env-file-if-exists=.env dist/main.js`. Não investigado a fundo — não bloqueava
o objetivo desta sessão.

Nota de ambiente: OAuth em dev exige HTTPS no redirect URI e na notification URL
(o painel do DevCenter rejeita `http://`). **Resolvido em definitivo (2026-07-17)
com domínio fixo do ngrok** — troca o `cloudflared` (quick tunnel, URL mudava a
cada restart, exigia recadastro no DevCenter toda vez) por um domínio estático
grátis reservado na conta ngrok: `danille-furrowlike-undigressively.ngrok-free.dev`,
já cadastrado como `redirect_uri` fixo no DevCenter e no `.env`
(`ML_REDIRECT_URI`). Rotina em dev: `ngrok http 3000 --url
https://danille-furrowlike-undigressively.ngrok-free.dev` (não usar `=` na
flag `--url` nesta versão do CLI). **Gotcha:** ao criar o domínio pelo
dashboard, **não criar um "Cloud Endpoint"** apontando pra ele — esse tipo de
endpoint roda inteiramente no lado do ngrok (sem depender de agente/processo
local) e fica permanentemente "online", conflitando com `ngrok http`
(`ERR_NGROK_334`) sem aparecer em "Agents" pra poder parar; só resolve
apagando o endpoint via API/dashboard (`ngrok api endpoints list` /
`endpoints delete`). O domínio estático em si já vem reservado pra conta,
não precisa criar endpoint nenhum antes de rodar `ngrok http --url`.

**Sessão de execução do lote seguro (2026-07-17), autorizada por Miguel com ordem
explícita: `/users/me` → corrigir prefixo → buscar 5170265 → publicar grupos
seguros → reportar.**

1. **Mistério do chart 5170265 resolvido — não era mistério.** `GET /users/me`
   confirmou a conta autenticada (`3153970621`/`MUNDOMAGNIRP`) bate exato com
   `ml_credentials.ml_user_id` — sem troca de conta. Busca real
   (`POST /catalog/charts/search`, domain=DRESSES+Feminino+BRAND=FARM) devolve
   os 3 charts do domínio incluindo `5170265` ("VESTIDOS FARM"), com medidas
   reais preenchidas (`CHEST_CIRCUMFERENCE_FROM` PP=76→GG=84cm etc.,
   `measure_type: BODY_MEASURE`). O "sumiço" era um artefato do meu próprio
   script de diagnóstico anterior (payload de busca sem o atributo `BRAND`,
   que o ML exige estar presente mesmo sem filtrar de fato — achado novo,
   diferente do já documentado "BRAND não restringe resultado").
2. **Bug do prefixo `MLB-` corrigido na fronteira.** `MlApi.suggestDomain()`
   novo em `ml-api.service.ts` (chama `GET /sites/MLB/domain_discovery/search`,
   normaliza `domain_id` removendo `MLB-` antes de devolver). 2 testes novos
   em `test/unit/ml-api.test.ts`. Nenhum chamador fora de `src/ml/` precisa
   saber do bug agora.
3. **Achado sério: o servidor local rodava um build de 16/07** (`dist/main.js`
   de ontem 14:39) — de **antes** do `size-grid.service.ts` ganhar a lógica
   "busca antes de criar" (hoje 12:06). Isso explica um job `build-size-grid`
   de DRESSES/FARM que falhou hoje mais cedo (14:07, 5/5 tentativas) tentando
   criar direto em vez de achar o `5170265` via busca — não é bug do código
   atual, era código velho rodando. **Corrigido:** `npm run build` + processo
   antigo (PID 16220) morto + novo `node dist/main.js` no ar, `/health` OK.
   **Isso valia pra qualquer chamada `/admin/*` feita nas últimas ~24h desta
   sessão — nenhuma delas rodou o código realmente atual até este restart.**
4. **1º disparo real dos 4 grupos seguros (POLO/CALVIN KLEIN, CAMISA/CALVIN
   KLEIN, CAMISETA/RICHARDS, POLO/LACOSTE) saiu errado por bug do meu script,
   não do app:** a amostra de produto pra resolver `domain_discovery` filtrou
   só por `brand`+`gender`, sem o "tipo" — pegou bermuda/calça em vez de
   polo/camisa (`SHORTS`/`PANTS` em vez de `T_SHIRTS`/`SHIRTS`). Todos os 4
   jobs falharam limpo (5/5 tentativas, 0 charts, 0 linhas em
   `size_grid_chart`) — sem estado sujo, mas errado mesmo assim. Corrigido
   filtrando a amostra também por 1ª palavra do título (mesma heurística do
   dry run anterior) — script em `scripts/resolve-and-build-charts.ts` (com
   `DRY_RUN` por padrão).
5. **Domínios corretos, já confirmados pelo `domain_discovery` real (server
   atualizado):** POLO/CALVIN KLEIN → `T_SHIRTS`; CAMISA/CALVIN KLEIN →
   `SHIRTS` (não `T_SHIRTS` como o dry run anterior tinha assumido por
   heurística manual); CAMISETA/RICHARDS → `T_SHIRTS`; POLO/LACOSTE →
   `T_SHIRTS` (não `SPORT_T_SHIRTS` como assumido antes — `domain_discovery`
   é mais confiável que a suposição manual, por isso confiei nele).
6. **Busca confirmou (read-only): nenhum dos 4 grupos tem chart existente pra
   reusar** (existe `4977679` "ROUPAS MASCULINO" pro T_SHIRTS/Masculino
   genérico, mas o nome não cita CALVIN KLEIN/RICHARDS/LACOSTE, então
   `pickMatchingChart` corretamente não bate) — os 4 cairiam no caminho
   `createChart`.
7. **Risco real, não testado ainda: `buildChartPayload` (linha de criação)
   nunca rodou de ponta a ponta contra o ML de verdade** — só testes
   unitários mockados. A investigação do Achado 1 (sessão anterior, contra
   `DRESSES`) tinha achado que `FILTRABLE_SIZE` também precisa ir na linha
   pra evitar `required_row_attribute_not_found`, mas o formato "canônico"
   adotado depois (lido do `GET` do `5170265`) só inclui `SIZE`/
   `MANUFACTURER_SIZE` — **sem `FILTRABLE_SIZE`**. Não é certo que o formato
   atual cria um chart de verdade em domínios sem chart pra reusar. Tentei
   testar isso com uma chamada real isolada (`POST /catalog/charts` direto,
   fora do pipeline de job) e fui bloqueado pelo classificador de permissão
   da sessão por ser uma mutação não confirmada contra sistema externo —
   **não tentei contornar, parei e vou perguntar ao Miguel antes.**

**Achado crítico (2026-07-17, investigação pedida pelo Miguel antes de rodar
o create pra valer): a suposição "T_SHIRTS/SHIRTS não exigem medida corporal"
(item 4 do dry run anterior, baseada em `technical_specs?section=grids` só
listando `BRAND`/`GENDER`/`AGE_GROUP`) está em dúvida — não confirmada como
errada, mas a evidência forte que a sustentava não existe mais.** Investigação
100% read-only: inspecionei o único chart real T_SHIRTS/Masculino da própria
conta (`4977679`, "ROUPAS MASCULINO", via `POST /catalog/charts/search`, mesma
técnica usada pra decifrar o formato de `5170265`). Achado: **esse chart real
tem `measure_type: "BODY_MEASURE"` e toda linha inclui `CHEST_CIRCUMFERENCE_FROM`
em cm** (ex. tamanho "1"/PP → 90cm, "2"/P → 95cm...), além de `SIZE` (rótulo
numérico "1"-"5", não "PP"/"P"/"M"...) e `FILTRABLE_SIZE` (com `id` real do ML:
PP=13853812, P=13853813, M=12917795, G=13853814, GG=13853815 — mesmos ids de
`FILTRABLE_SIZE` já vistos antes pro domínio `DRESSES`, o que sugere que esses
ids de equivalência PP/P/M/G/GG podem ser globais ao site, não por domínio).
Isso não prova que `CHEST_CIRCUMFERENCE_FROM` é **obrigatório** pra T_SHIRTS
(pode ser opcional, incluído porque quem criou esse chart tinha o dado) — mas
`technical_specs?section=grids` já tinha se mostrado incapaz de expor
requisitos de linha (só atributos de classificação do chart), então a leitura
anterior "seguro, sem medida corporal" nunca teve uma fonte que realmente
confirmasse isso pra linhas. Sem rodar `createChart` de verdade (bloqueado,
ver item 7 acima) não dá pra saber se omitir `CHEST_CIRCUMFERENCE_FROM` falha
com `required_row_attribute_not_found` igual DRESSES, ou se passa porque é
opcional nesse domínio. **Consequência prática: os 4 grupos "seguros"
(POLO/CAMISA CALVIN KLEIN, CAMISETA/RICHARDS, POLO/LACOSTE) podem ter o mesmo
bloqueio de medida corporal real que DRESSES/COLCCI já tem — não são
necessariamente "seguros pra criar com tamanho nominal" como o item 4 do dry
run concluiu.** Nenhuma chamada mutou nada (só `charts/search`); script de
diagnóstico apagado depois de usar, convenção de sempre.

**CONFIRMADO (2026-07-17, teste real autorizado por Miguel): T_SHIRTS tem o
mesmo bloqueio de medida corporal que DRESSES — os 4 grupos "seguros" NÃO
são seguros.** Rodei `POST /admin/build-size-grid` de verdade (não dry run)
só pra CAMISETA/RICHARDS, como teste controlado. Resultado: `ML API 400 em
/catalog/charts` com **dois** `required_row_attribute_not_found`:
`FILTRABLE_SIZE` (confirma o gap 1 já suspeitado — falta no payload atual) e
**`CHEST_CIRCUMFERENCE_FROM`** (confirma o achado da inspeção do chart
`4977679` — não era opcional, é obrigatório). `size_grid_chart` ficou vazia
(0 linhas) — sem estado sujo, igual toda vez que um 400 acontece aqui. Job
vai esgotar as 5 tentativas sozinho e cair pra `status='failed'`, sem
intervenção necessária.

**Conclusão prática:** os 4 grupos (POLO/CAMISA CALVIN KLEIN,
CAMISETA/RICHARDS, POLO/LACOSTE) estão no mesmo estado que
VESTIDO/COLCCI — bloqueados por falta de medida corporal real, não por bug
de código. `technical_specs?section=grids` nunca foi uma fonte confiável pra
saber se um domínio exige medida de linha (só mostra atributos de
classificação do chart); a única forma confiável de saber, descoberta nesta
sessão, é inspecionar um chart real do domínio (se existir um na conta) ou
tentar criar e ler o erro. **Pendente pro Miguel decidir:** conseguir a
medida real de peito (circunferência em cm) de CALVIN KLEIN/RICHARDS/LACOSTE
(fornecedor ou planilha do Anunciador em Massa, mesma régua já usada pra
FARM/DRESSES) antes de qualquer novo `createChart` pra esses grupos — sem
isso, **nenhum grupo sem chart existente pra reusar consegue ser criado**,
pelo visto (T_SHIRTS/DRESSES já confirmados; SHIRTS/BLOUSES/SPORT_T_SHIRTS
ainda não testados de verdade, mas o padrão sugere provável mesmo bloqueio).
`FILTRABLE_SIZE` também precisa ser adicionado em `buildChartPayload` de
qualquer forma, mas sozinho não resolve — a medida corporal é o bloqueio
maior. Também descoberto e ainda não resolvido: `validateForPublish` rejeita
100% dos produtos Moovin hoje porque `mlCategoryId` nunca é setado pelo
import Moovin (só o import M4 da conta ML seta esse campo) — "publicar hoje"
no sentido de item ao vivo no ML precisa desse gap fechado também, além do
size grid.

**Investigação do chart Colcci (2026-07-17), pedida explicitamente pelo
Miguel antes de qualquer `createChart` novo — regra "screenshot não é fonte,
o chart_id é" (prints do painel ML mostram guias reais já existentes, mas
sem identificar `chart_id`/domínio programaticamente).** Ordem executada:
`/users/me` → `charts/search` de novo → GET (via search) do chart Colcci.
100% leitura, nada criado.

1. **`/users/me` confirma a mesma conta, sem mismatch.** `id=3153970621`,
   `nickname=MUNDOMAGNIRP`, bate exato com `ml_credentials.ml_user_id`. Não
   era troca de conta — mesma conclusão de investigações anteriores desta
   sessão, agora reconfirmada especificamente no contexto do Colcci.
2. **Sem bug de prefixo neste caminho** — `charts/search` com `domain_id`
   sem `MLB-` (`DRESSES`, `BLOUSES`, etc.) funcionou normal, 200 em todas as
   chamadas.
3. **`charts/search` DRESSES+Feminino+BRAND=COLCCI devolve os mesmos 3
   charts de sempre** (`4537790` "Vestidos", `4539158` "vestidos
   NUMERAÇÃO", `5170265` "VESTIDOS FARM") — confirma de novo que o filtro
   `BRAND` não restringe nada (achado já documentado no M6).
4. **Achado que resolve o "sumiço": o chart Colcci existe, mas o nome dele
   no ML não cita a marca.** Comparando linha a linha os valores do print
   (`Tamanhos Colchi.png`: PP 82/63/88, P 90/71/96, M 98/79/104, G
   106/87/112, GG 114/95/120 — peito/cintura/quadril) contra o JSON real dos
   3 charts: **bate exato com o chart `4537790`, cujo nome no ML é só
   "Vestidos"** (genérico, sem "Colcci" em lugar nenhum). Confirma também a
   ambiguidade do FROM/TO: **`4537790` e `5170265` (FARM) usam só
   `CHEST_CIRCUMFERENCE_FROM`/`WAIST_CIRCUMFERENCE_FROM`/
   `HIP_CIRCUMFERENCE_FROM` (valor único, sem `_TO`)** — o formato "por
   tamanho nominal" (PP/P/M/G/GG). Já `4539158` ("vestidos NUMERAÇÃO") usa
   faixa completa `_FROM`/`_TO` + `PERSON_HEIGHT_FROM/TO`, indexado por
   numeração (36/38/40/42/44) em vez de PP/P/M/G — um formato "por faixa",
   claramente outro caso de uso (venda por numeração, não por tamanho
   nominal). Pro caso do hub (guia por PP/P/M/G/GG), o formato certo é
   valor único em `_FROM`, sem `_TO` — resolve a dúvida que `buildChartPayload`
   tinha em aberto.
5. **Triagem do FARM (`5170265`) confirmada bit a bit contra a suspeita do
   Miguel:** peito 76/78/80/82/84 (progressão de só 2cm entre PP-GG, muito
   estreita — implausível) e cintura 66/68/72/74/84 (quebra a sequência,
   84 duplica o peito do GG) — dado real, mas com erro de digitação
   provável, exatamente como Miguel descreveu a partir do print. **Não usar
   como referência/template**, igual à instrução original.
6. **Achado novo e crítico pro fluxo de `ensureChart`/`pickMatchingChart`:**
   como o chart certo pra Colcci se chama só "Vestidos" (sem a marca no
   nome), a heurística atual de `pickMatchingChart` (que escolhe entre os
   resultados casando o nome do chart com a marca pedida) **nunca vai achar
   esse chart pra COLCCI** — bateria "ambíguo" ou "nada encontrado" e cairia
   pro caminho de criar um chart novo (duplicado) se alguém rodasse
   `build-size-grid` pra VESTIDO/COLCCI hoje. Isso não é um bug introduzido
   nesta sessão — é uma lacuna real na premissa "nome do chart cita a
   marca", que nem sempre é verdade nesta conta (aparentemente o chart
   genérico "Vestidos" é reusado informalmente pra Colcci pelo time que
   cadastra os anúncios, fora de qualquer convenção de nomenclatura). Fica
   pendente de decisão: mapear manualmente `chart_id` conhecido por
   marca/domínio (tipo um lookup table pequeno pras marcas já cobertas no
   Anunciador em Massa) em vez de confiar só no name-matching automático.
   **Nada foi alterado no código ainda** — `pickMatchingChart`/
   `ensureChart` seguem como estavam; isso é achado, não fix.

**PIVOT (2026-07-17): publicar acessórios HOJE (size grid sai do caminho
crítico).** Decisão do Miguel: os ~143 acessórios (bolsas, bonés, carteiras,
óculos, cintos, alças, mochilas) não exigem SIZE_GRID e nunca dependeram do
M6. Alvo do 1º anúncio real: um óculos. Isso destravou uma sequência inteira
de trabalho de publicação e vários achados reais contra o ML.

- **`resolve-categories` (novo job + `POST /admin/resolve-categories`):**
  backfill de `mlCategoryId`/`mlDomainId` via `MlApi.suggestDomain`
  (domain_discovery). Migration `ml_domain_id` aplicada. Rodou: **937/960**
  resolvidos. **Achado crítico:** domain_discovery no **título cru** é pouco
  confiável pra acessório — dos 14 óculos, **13 caíram errado**
  (SAFETY_GOGGLES/MOTORCYCLE_GOGGLES/armação sem grau); só o que tinha "Óculos
  de Sol" no título acertou. O backfill dos 937 provavelmente tem vários
  acessórios miscategorizados. **Fix (decisão Miguel):** mapa curado
  **híbrido** por TIPO — ver abaixo.

- **Pipeline de imagem + TIPO + CATEGORIA ligados:** o xlsx "preparado pro ML"
  tinha as colunas `IMAGEM`, `TIPO`, `CATEGORIA_MOOVIN` sendo **descartadas**
  no import. Liguei as três ponta a ponta (schema `image_url`/`moovin_type`/
  `moovin_categoria`, `source.interface`, `xlsx-source`, mapper, import).
  Reimport populou 949 imagens / 959 TIPO / 8 UNISSEX. **`IMAGEM` empacota
  várias URLs separadas por " | "** — split no publish (`picturesFrom`).

- **Bug de fila corrigido (worker):** job concluído/falho **mantinha o
  `dedupe_key`**, e como é índice unique, o `ON CONFLICT DO NOTHING` bloqueava
  **pra sempre** reenfileirar aquele tipo (`import-moovin` nunca reexecutava —
  travou meu 1º reimport). Fix: `Worker` seta `dedupeKey: null` ao terminar
  (done, e failed terminal). O comentário do `JobQueue` ("só deduplica contra
  jobs não terminados") agora é verdade.

- **Mapa curado de acessório (`src/modules/publishing/accessory.ts`) — desenho
  aprovado pelo Miguel:** `ACCESSORY_MAP[TIPO] = { queryPhrase, expectedDomain,
  modelStrategy }`. Regra: **query desambiguada** por TIPO (título cru não
  serve) + **domain_discovery é a fonte do `category_id`** (nunca chumbar o ID,
  o ML muda categoria) + **`expectedDomain` é guarda-corpo** — no publish chama
  discovery e se o domínio divergir do esperado, **bloqueia e reporta**
  (`ValidationError`), nunca publica categoria divergente (SAFETY_GOGGLES nunca
  mais passa calado). Entradas **aprovadas uma a uma pelo Miguel**: `OCULOS →
  {query 'óculos de sol', SUNGLASSES, model 'lacoste-code'}` e `BOLSA → {query
  'bolsa feminina', HANDBAGS, model 'title-minus-brand'}`. Os outros 5 tipos só
  entram no mapa depois de eu levantar (discovery + technical_specs +
  obrigatórios) e ele aprovar.

- **Atributos obrigatórios por dado real (regra dura do Miguel, `resolveAccessory`):**
  BRAND←`MARCA` (atributo aberto: casa nas allowed values → value_id, senão
  manda value_name; lista FECHADA sem match bloqueia); MODEL por estratégia do
  tipo (`lacoste-code` = regex `\b(L\d+S)\b`; `title-minus-brand` = título sem
  marca e sem a palavra do tipo, ex. "COURO RAVENA SAARA PRETO"); GENDER só
  quando `CATEGORIA_MOOVIN='UNISSEX'` → valor ML **"Sem gênero" (110461)** (o ML
  **não tem "Unissex"** na lista de gênero de SUNGLASSES). Qualquer obrigatório
  sem fonte real → **bloqueia** (nunca chuta). Isso derruba a contagem de
  "acessórios prontos": dos 13 óculos só ~3 passam as regras (4 têm
  CATEGORIA=UNISSEX, e desses 1 não tem modelo no título → bloqueado).

- **`POST /admin/publish-preview` (novo, dry-run):** constrói o payload de
  `POST /items` (com resolução de acessório) **sem enviar nada**. Foi o
  checkpoint que pegou 4 problemas antes de disparar (categoria errada,
  EMPTY_GTIN_REASON com valor inválido, faltando BRAND/MODEL/GENDER, pictures
  empacotadas).

**Achados reais contra o ML ("disparar e ler o erro", metodologia do Miguel) —
publicação de item de variação única em conta `user_product_seller`:**
1. **Conta UP manda `family_name`, NÃO `title`.** `POST /items` com `title` →
   400 `body.invalid_fields:[title]` (o título é derivado de family_name +
   atributos). Corrigido no `payload-builder`: UP usa `family_name`; legado usa
   `title`. `EMPTY_GTIN_REASON` válido = **"O produto não tem código
   cadastrado"** (das allowed values da categoria).
2. **Marca gateada.** Óculos Lacoste → 400 `moderations.seller.not_authorized`
   (cause_id 3250, "Seller is not authorized for this brand and category",
   ref `item.attributes[BRAND]`). A conta MUNDOMAGNIRP **não está autorizada a
   vender LACOSTE** nessa categoria — e **100% dos 13 óculos são Lacoste**.
   Marcas provavelmente gateadas: LACOSTE, CALVIN KLEIN, SCHUTZ, KIPLING.
   Provavelmente livres: **LUZ DA LUA** (18 bolsas, 8 alças, 6 carteiras…),
   BOBBYLULU. **Confirmado: LUZ DA LUA passa a moderação de marca** (a bolsa
   dela não deu esse erro).
3. **GTIN item-level vs variation-level, por categoria.** SUNGLASSES aceita
   `EMPTY_GTIN_REASON` no **nível do item** (por isso o óculos passou do GTIN e
   só travou na marca). **HANDBAGS/WALLETS/BELTS/CAPS/BACKPACKS** têm
   `EMPTY_GTIN_REASON` como `variation_attribute` → exigem a isenção **na
   variação** + atributos de variação (COLOR/SIZE/GENDER/BACKPACK_TYPE), ou seja
   um **bloco `variations` (estrutura M7)**. O payload item-único atual **não
   serve** pra nenhum acessório além de óculos.

**Estado líquido de "publicar hoje" (decisão do Miguel: caminho A):** com o
payload item-único atual, **só óculos publicam** — e estão travados na
autorização de marca. **Miguel vai autorizar Lacoste no ML** (ação de conta);
o código do caminho item-level está **pronto e provado até o gate** (o ML
aceitou categoria ao vivo + guard-rail, BRAND/MODEL/GENDER, GTIN-isenção,
imagens). **Quando autorizar: re-disparar `POST /admin/publish`
`{productId:'197608d3-41a3-492e-b392-1d5f3579f83f'}` (ÓCULOS LACOSTE L996S
230) e confirmar `GET /items/{id}` com `status='active'`** (não só 201 —
moderação pode pausar). Destravar bolsas/carteiras/etc. de marca não-gateada
exige o **bloco `variations` (M7-lite)** — fica pra quando o Miguel pedir M7.
Nenhum anúncio foi criado nesta sessão (todo `POST /items` falhou em 400, que
não deixa estado sujo). Migrations novas: `product_ml_domain_id`,
`product_image_url`, `product_moovin_type_categoria`.

**Modelo UP resolvido de vez pelo gabarito real, e o "gate de marca"
desmascarado (2026-07-17). PAREI AQUI a pedido do Miguel ("vou terminar
depois") — estado exato abaixo.**

*Caminho até aqui (cada erro um achado, metodologia disparar-e-ler):* cheguei
a implementar um bloco `variations` (M7-lite) achando que o ML exigia GTIN por
variação. **Isso era desvio.** O Miguel publicou um óculos Lacoste **na mão**
pela tela do ML e passou → a conta TEM autorização Lacoste; o
`moderations.seller.not_authorized` (cause_id 3250) da API **não era gate de
conta, era a CATEGORIA errada.** GET do anúncio-gabarito (`MLB4908192909`)
provou tudo:
- **O "gate" é categoria.** Lacoste passa em **MLB1911 (Outros)** e barra em
  **MLB8378 (SUNGLASSES)**. Nosso `domain_discovery` acertou (SUNGLASSES é a
  categoria certa); a tela caiu em "Outros". **Decisão do Miguel: NUNCA
  publicar em "Outros" pra escapar do gate — é burlar proteção de marca (BPP
  suspende conta), e é invisível na busca. Marcas gateadas (LACOSTE, CALVIN
  KLEIN, SCHUTZ, KIPLING) ficam bloqueadas e reportadas até ele conseguir a
  autorização.** `domain_discovery` e o guarda-corpo ficam como estão.
- **Modelo UP real: 1 SKU = 1 item com `family_name`; o ML cria o
  `user_product` sozinho** (`variations: 0`, `user_product_id` auto). **NÃO
  existe array `variations` nesta conta** (o erro "variations is invalid with
  family name" era exatamente isso — o doc do ML diz "não mande variations no
  modelo UP"). Multi-cor/tamanho = **items irmãos com mesmo `family_name`** (o
  ML agrupa em família — visto nas botas Schutz 34-38). → **M7-lite (bloco
  variations) revertido**; `accessory.ts` voltou pro modelo **item-level**
  (o mesmo que os óculos já faziam). Multi-SKU (>1 variação) **bloqueia** por
  ora (items irmãos = trabalho futuro).
- **Dimensões: NÃO mandar.** As da Moovin são default errado (15×40×40 cm em
  2.000+ das 2.971 linhas — mesma caixa pra óculos/vestido/bolsa). O ML
  preenche sozinho (confirmado: os `SELLER_PACKAGE_*` do gabarito **mudaram
  entre dois GETs**, 31→18cm — Miguel não digitou). Melhor omitir que mandar
  errado (dimensão inflada = frete inflado = penalidade no Full).
- **`condition` sempre `'new'` explícito** (o gabarito manual saiu
  `ITEM_CONDITION=Usado` por default da tela — Miguel corrige na mão).

*Estado do código (buildado, 51 testes verdes):* `accessory.ts` item-level —
`resolveAccessory` resolve categoria (discovery+guarda-corpo) + obrigatórios
por dado real (BRAND←MARCA aberto; MODEL por estratégia; GENDER só
CATEGORIA=UNISSEX→"Sem gênero" ou FEMININO/MASCULINO literal no título;
COLOR/SIZE se obrigatórios) + **EMPTY_GTIN_REASON com value_id** (achado: só
value_name o ML ignora — o gabarito da Carteira Schutz usa value_id 17055160).
`buildAccessoryPayload` monta item-level (family_name/price/qty/condition
new/pictures, **sem dimensões**). Reverti `ResolvedVariation`/bloco variations.

*ONDE TRAVOU (não resolvido) — bolsa LUZ DA LUA MONTENAPOLEONE (R$939, id
`3d4cae90-c3a5-4b7f-b512-f0a80d577e8d`):* `POST /items` item-level dá **400
`missing_conditional_required GTIN` em MLB7022 (HANDBAGS)** — mesmo com
`EMPTY_GTIN_REASON` + value_id no item. MAS a **Carteira Schutz real
(`MLB4828055683`, categoria MLB28108 WALLETS) está ATIVA com EXATAMENTE
EMPTY_GTIN_REASON item-level (value_id 17055160)** — funciona lá. Comparei:
MLB7022 e MLB28108 têm **tags idênticas** de GTIN/EMPTY_GTIN_REASON (ambos
`variation_attribute`), **ambos são leaf, listing_allowed=true**. A diferença
entre o payload da carteira que passou e a bolsa que falha: a carteira tem
**COLOR e GENDER** no item (são obrigatórios em MLB28108); a bolsa **não tem
COLOR** (não é obrigatório em MLB7022). **Hipótese não testada (ia testar
quando o Miguel mandou parar):** HANDBAGS precisa do COLOR (atributo
`allow_variations`, define a variação implícita) presente pro item-level
EMPTY_GTIN_REASON "colar" e satisfazer o GTIN. **Próximo passo pra retomar:**
adicionar COLOR (de `COR`) ao payload item-level de acessório e redisparar a
bolsa. Cor da MONTENAPOLEONE = AMÊNDOA — **não está** nos 51 values sugeridos
de COLOR em MLB7022 (mas COLOR é atributo aberto `string`, então value_name
deve passar; Preto=52049 e Marrom=52005 existem se quiser testar com uma bolsa
de cor padrão primeiro). Se COLOR não resolver, o fallback é inspecionar uma
bolsa real ativa da conta (não achei nenhuma — o filtro `?category=` do
`/users/{id}/items/search` **não filtra**, ignora o param) ou pivotar o alvo
de hoje pra uma **CARTEIRA LUZ DA LUA** (categoria WALLETS MLB28108 **provada**
que aceita item-level; precisa aprovar CARTEIRA no mapa, um a um).

*Pendências abertas:* (a) óculos Lacoste re-disparar `POST /admin/publish`
`{productId:'197608d3-41a3-492e-b392-1d5f3579f83f'}` quando Miguel conseguir
a autorização de marca em SUNGLASSES, confirmar `status='active'`. (b)
Multi-SKU (items irmãos, ex. cinto 4 cores) não implementado. (c) `nul` e `{`
lixo no working tree (git status) — não são meus, ignorar/limpar. Servidor
dev (`dist/main.js`) ficou no ar na porta 3000 contra o Postgres de dev (5433).
Nenhum anúncio criado por nós nesta sessão inteira (todo `POST /items` 400 =
zero estado sujo; confirmado dev intacto 960/2705/1cred).

**🎉 PRIMEIROS ANÚNCIOS REAIS NO AR (2026-07-18, madrugada — autorização
explícita do Miguel: "total liberdade, quero isso pronto quando eu acordar").
O mistério do GTIN de HANDBAGS foi resolvido de vez e DUAS bolsas LUZ DA LUA
estão ativas no ML, publicadas pelo hub:**

- **MLB4909174207** — Bolsa Tiracolo Bella Ravena **Âmbar** (sku 2570, R$1.189)
- **MLB7194326902** — Bolsa Tiracolo Bella Ravena **Latte** (sku 2568, R$1.189)

Ambas `status='active'`, `sub_status=[]`, shipping `me2`+`xd_drop_off` (D8),
frete grátis, `listing.ml_item_id` gravado, job `done`. Caminho: **catalog
listing** (`catalog_product_id` + `catalog_listing:true`).

**A cadeia de achados (todos por teste real, principal ferramenta nova:
`POST /items/validate` — valida o payload SEM criar nada, zero estado):**

1. **A hipótese COLOR (fim da sessão anterior) estava errada.** COLOR entrou
   no payload (fix em `resolveAccessory`: COLOR sempre que a categoria tem o
   atributo e a variação tem COR real, mesmo não-required — mantido, é
   correto) e o 400 GTIN persistiu. GENDER/AGE_GROUP idem — nada disso era o
   gate.
2. **A crença "WALLETS aceita EMPTY_GTIN_REASON item-level" era FALSA.**
   Controle via validate na MLB28108 → mesmo 400. A Carteira Schutz ativa
   passou pela **tela** do ML, que faz outra coisa: **vincula ao catálogo**
   (o item tem `catalog_product_id`; o cinto Schutz idem — todos os
   acessórios ativos da conta são catalog-linked).
3. **O gate real do GTIN é POR MARCA REGISTRADA (por domínio).** Validate
   com marca fantasia ("ZZTESTE") → o erro GTIN **some**; com LUZ DA LUA →
   exige GTIN. A isenção EMPTY_GTIN_REASON **só vale pra marca que o ML não
   tem no cadastro**. Pra marca registrada: GTIN real OU vínculo de catálogo.
   Vale em HANDBAGS, WALLETS e BELTS (testados); presumir o mesmo nos outros.
4. **Conta UP + catálogo funciona**: payload `{category_id, catalog_product_id,
   catalog_listing:true, price, qty, condition:'new', listing_type_id,
   shipping:{mode:'me2',free_shipping:true,local_pick_up:false},
   attributes:[SELLER_SKU]}` → validate 204 → POST /items cria e fica active.
   Sem family_name, sem pictures, sem GTIN — identidade vem do catálogo.
   Frete grátis é obrigatório >R$79 (validate reclama sem shipping).
5. **Bug real achado no caminho: o ML usa NBSP (U+00A0) dentro de
   `value_name`** ("Luz da Lua") — o guard de marca bloqueou um
   match legítimo por causa disso. Fix: `sameName()` em `accessory.ts`
   (normaliza `\s+`→espaço, case-insensitive), usado no guard de marca e no
   match de allowed values (`resolveOpen`) — a mesma classe de bug ia morder
   qualquer comparação de nome com o ML.

**Código novo (55/55 testes verdes):** `MlApi.getCatalogProduct()`
(GET /products/{id}, domínio normalizado sem `MLB-`); `buildCatalogPayload()`
em `payload-builder.ts`; caminho catalog em `PublishingService`
(`publishProduct(productId, catalogProductId?)`) com guarda-corpos: variação
única, `mlCategoryId` presente, catálogo `active`, **marca do catálogo bate
com a do produto** e **domínio bate com o `expectedDomain` do ACCESSORY_MAP**
— divergência bloqueia, nunca publica vínculo errado. Wiring:
`POST /admin/publish {productId, catalogProductId?}`.

**Regra de processo (a parte que NÃO é código): o de-para produto↔catálogo é
decisão humana verificada por FOTO.** Fluxo desta noite: busca
(`/products/search?q=`) → candidatos por nome/cor → download das fotos dos
dois lados → comparação visual → só publica match inconfundível. Resultado:
2 confirmados e publicados; 2 REJEITADOS pela foto (carteira Saara vermelha
MLB36850858 = carteira diferente; New Ridge Amendoa MLB66372647 = hobo grande
vs crossbody pequena — nome batia, foto não). Nome batendo NÃO basta.

**Segue bloqueado (sem caminho, não por bug):** a bolsa-alvo original
MONTENAPOLEONE AMÊNDOA (2572, R$939) — catálogo só tem versões Âmbar; sem
produto de catálogo na cor certa e sem GTIN real, marca registrada não
publica. Idem qualquer acessório LUZ DA LUA/marca registrada sem match de
catálogo verificado. Alternativas: (a) achar GTIN real com o fornecedor,
(b) pedir inclusão no catálogo do ML, (c) publicar só os que têm match.

**Alerta pro Miguel:** o óculos `MLB7031729282` ("Óculos Lacoste. L261s
035"), publicado **na mão** pela tela com BRAND="OUTROS", está
`under_review` com sub_status `forbidden` — é exatamente o padrão de burla
de marca que a BPP pune. Recomendo pausar/corrigir manualmente.

**VESTIDOS RESOLVIDOS (2026-07-18, mesma madrugada — "continue buscando a
solução para os vestidos"). 3 items irmãos ATIVOS no ML** (VESTIDO FARM RIO
VOLUME MIDI ORIGINAL, R$577): `MLB7194434092` (PP), `MLB7194434098` (P),
`MLB4909286997` (G) — mesma família, guia `5170265`, fotos ok.

Cadeia de achados (via gabarito real + `/items/validate`):
1. **Os 88 vestidos FARM ativos da conta são items LEGADOS com array
   `variations`** (family_name null, user_product null, criados 2026-03 pela
   tela) — herança; a API desta conta **recusa `variations` sempre**
   ("variations is invalid with family name" + family_name obrigatório).
   Item novo de vestuário = **items irmãos**: 1 SKU (cor+tamanho) = 1 item
   com o MESMO family_name; o ML agrupa em família sozinho.
2. **FARM não é GTIN-gated em DRESSES** — validate passa sem GTIN nem
   isenção (bate com o gabarito: variações com attrs vazios). O gate de
   marca registrada existe (bolsas), mas é por marca×domínio.
3. **DRESSES exige `SIZE_GRID_ID` E `SIZE_GRID_ROW_ID` no item** (erros
   `missing.fashion_grid.grid_id/grid_row_id`). Row ids têm formato
   `chartId:linha` (5170265:1=PP ... :5=GG), vêm nas rows do
   `/catalog/charts/search` — que o `size_grid_chart.rows` já persiste.
4. Os erros de shipping do validate (`lost_me1_by_user`,
   `mandatory_free_shipping`) são `type:"warning"` — validate devolve 400
   para qualquer cause, mas warning não bloqueia o POST real. **Sempre olhar
   o `type` do cause antes de tratar como bloqueio.**

Código (58/58 verdes): `apparel.ts` novo (APPAREL_MAP curado — só VESTIDO
por ora; `resolveApparel` com discovery+guarda-corpo; `rowIdForSize` casa
label real com linha do guia, sem match bloqueia; `buildApparelItemPayload`
item irmão); `PublishingService.publishApparelProduct` (1 listing por
variação — `listing.variationId` finalmente usado, `sizeGridId` gravado;
erro em um SKU não trava os demais; idempotente por listing; só SKUs com
estoque>0 por ora); `POST /admin/publish-apparel` + job `publish-apparel`.
`ensureChart` reusado — pra FARM ele ACHA o 5170265 via busca (nunca criou
nada); marca sem chart existente segue bloqueando no create (medida
corporal), como deve.

**LOTE COMPLETO RODADO (2026-07-18, mesma madrugada — "faça isso"):** os 75
produtos VESTIDO/FARM com estoque foram enfileirados e processados
(76 jobs `done`, 0 falhas de job). Resultado: **118 listings `active` com
`ml_item_id`** (119 SKUs com estoque − 1 bloqueado) + as 2 bolsas = **120
anúncios criados pelo hub no total**. Único bloqueio: SKU 3320 com tamanho
`"P (3)"` — sem linha no guia (PP/P/M/G/GG), erro claro persistido no
listing, dado a corrigir na origem. Muitos itens ficam alguns minutos em
`paused [picture_download_pending]` logo após criar (fila de download de
foto do ML puxando da Moovin) — converte pra `active` sozinho, foi assim
com os 3 primeiros.

**NUMÉRICOS COLCCI RESOLVIDOS (2026-07-18, "faz o mesmo com o chart 4539158
pros numéricos"):** achado que destravou sem redesign — **o row id embute o
chart** (`4539158:3`), então o cache pode **unir as linhas dos dois guias**
(nominal 4537790 + numeração 4539158) na mesma linha de cache, e o
`SIZE_GRID_ID` do item sai do prefixo da linha casada, não do `chart_id` do
cache. Mudança de 3 linhas no `publishApparelProduct` + UPDATE no cache
(`rows = rows || rows_4539158`). Resultado: **8/8 numéricos criados com
SIZE_GRID_ID=4539158, COLCCI fechou 59/59 SKUs ativos**. 59/59 testes.

**COLCCI DESTRAVADO E RODADO (2026-07-18, pedido do Miguel "tenta o mesmo
caminho pros vestidos COLCCI"):** o "lookup manual de chart_id" pendente
virou **uma linha semeada no cache `size_grid_chart`** (COLCCI→`4537790`,
de-para já verificado linha a linha contra o print do Miguel na
investigação anterior e reconfirmado ao vivo: peito 82→114cm) — zero código
novo, `ensureChart` consulta o cache primeiro. Validate confirmou que
COLCCI também **não é GTIN-gated em DRESSES**. Lote: 24 produtos com
estoque → **51 irmãos `active`** + **8 SKUs numéricos (36-44) bloqueados
limpos** ("não tem linha no guia PP/P/M/G/GG") — esses precisariam do chart
de numeração `4539158`, mas o cache é 1 chart por marca×gênero×domínio;
suportar 2 formatos de tamanho por marca é decisão/design futuro, não foi
improvisado. 3 jobs `failed` = produtos 100% numéricos (todos os SKUs
bloqueados → job esgota retries; ruidoso mas sem estado sujo).

Infantil segue pendente do mapa de gênero.

**Padrão dos 6 defaults (guardar pro chefe do Miguel — o parecer numa linha):**
todo campo crítico do catálogo Moovin foi preenchido no automático por alguém
que não olhou, e nenhum é bug de código: (1) GTIN=SKU (duplicado), (2) tamanho
"M" pra numeração 40, (3) chart FARM com medida implausível, (4) gênero vazio,
(5) dimensão 40×40cm pra óculos de sol, (6) `ITEM_CONDITION=Usado` num Lacoste
de R$1.199. Todos custam venda ou dinheiro; todos são dado errado que "parece
preenchido" — pior que dado ausente.

**TOPS RODADOS (2026-07-18, "tenta os outros tipos de vestuário"): +113
anúncios — BLUSA/FARM 29, CAMISETA/RICHARDS 46, POLO/RICHARDS 38, total do
hub 292.** Como:

- **Evidência primeiro:** inspecionei os items ativos da conta — o time usa
  `5170097` "BLUSAS FARM" (BLOUSES), `4977679` "ROUPAS MASCULINO"
  (T_SHIRTS, SIZE 1-5) pra Richards, `5163260` "Camisetas Sem gênero" pra
  Levi's, `4669104` pra Top CK fem. FARM acha por nome; RICHARDS foi
  semeado no cache (4977679 — Richards usa tamanho 1-5 que casa direto).
- **T_SHIRTS/BLOUSES exigem SLEEVE_TYPE (+GARMENT_TYPE em T_SHIRTS)** —
  required por categoria, DRESSES não exige. GARMENT_TYPE sai do TIPO
  (CAMISETA→"Camiseta", POLO→"Camisa polo" — valor real da lista, gabarito
  MLB4502679287); SLEEVE_TYPE: título quando diz (`sleeveFromTitle`), senão
  **verificação por FOTO uma a uma** (41 produtos vistos; tudo Curta menos
  blusas FARM variadas: Sem mangas/Longa) passada via
  `publish-apparel {sleeveType}` — sem fonte real, bloqueia.
- **POLO usa queryPhrase 'camiseta' de propósito**: polos moram em T_SHIRTS
  no ML (GARMENT_TYPE "Camisa polo" em MLB31447; polo Richards ativo lá);
  query com "polo" cai em SPORT_T_SHIRTS e o guarda-corpo bloqueia (visto
  real: 13 polos bloqueados até o ajuste).
- **Recaída do bug de build velho:** 3 rebuilds sem restart → 44 jobs
  falharam com "TIPO não está no mapa". Regra: **todo rebuild = restart
  imediato do processo.**

Bloqueados com causa real (decisão do Miguel): LEVIS (guia é "Sem gênero",
Moovin diz MASCULINO — conflito); CK/LACOSTE/FOXTON/COLCCI-blusa/MARIA FILÓ
(sem guia com evidência de uso); CAMISAS (SHIRTS tem 0 guias na conta);
LILICA (mapa gênero infantil); "BLUSA RICHARDS NARA" (título diz RICHARDS,
MARCA diz FARM — conflito de dado); POLO PIQUET LISA ML (produto sem foto).

**CAMISAS RODADAS + PRIMEIRO GUIA CRIADO PELO HUB (2026-07-18, "tenta as
camisas com o guia que tiver medida real"): +48 anúncios, total 340.**
SHIRTS tinha 0 guias na conta; cross-domain (guia de T_SHIRTS em item de
SHIRTS) é rejeitado pelo ML (`invalid.fashion_grid.grid_id`). Caminho:
**clonar as medidas REAIS do 4977679** (ROUPAS MASCULINO — peito 90/95/100/
110/120cm, dado do time) num guia novo de SHIRTS. Implementado via
`ChartPayloadParams.rawRows` (+`measureType`/`mainAttributeId`) —
`buildChartPayload` aceita linhas completas copiadas de um guia real, e o
disparo foi pelo pipeline (`POST /admin/build-size-grid`), busca-primeiro e
cache como sempre. **Guia criado: `6558327` "CAMISAS MASCULINO"** (job done,
0 retries — primeira criação real de chart do projeto, o formato de
`buildChartPayload` com rawRows está provado contra o ML). MLB107292 só
exige BRAND/MODEL/GENDER/COLOR/SIZE (sem SLEEVE_TYPE — sem maratona de
foto). CAMISA→SHIRTS no APPAREL_MAP (query 'camisa'; 'camisa masculina' cai
em T_SHIRTS — visto real). Resultado: 48 camisas RICHARDS masc ativas; 3
SKUs tamanho "6" bloqueados (o guia fonte só tem linhas 1-5 — cobrir o "6"
exige medida real que não existe na conta). CAMISA RICHARDS Feminino (4)
segue bloqueada (guia é Masculino — mesmo conflito de gênero do caso LEVIS);
CK camisas (tamanhos mistos 2-6 + colarinho 38/40) e FOXTON (P-XGG,
precisaria match por FILTRABLE_SIZE) pendentes de decisão/extensão.

**FOXTON RODADO (2026-07-18, "faz o FOXTON com o match por FILTRABLE_SIZE"):
+48 anúncios (22 camisas + 26 camisetas), total 388.** O caminho pedido
(match por FILTRABLE_SIZE) foi implementado, testado REAL e **reprovado pelo
ML**: `invalid.fashion_grid.size.values` — o SIZE do item TEM que ser igual
ao label SIZE da linha do guia; equivalência não vale pra isso. Fallback
revertido (rowIdForSize é SIZE-only de novo, com teste cravando o achado).
Solução que funcionou: **guias novos com SIZE em letras** — `6136504`
"CAMISETAS MASCULINO P-GG" (T_SHIRTS) e `6136506` "CAMISAS MASCULINO P-GG"
(SHIRTS), clonando as MESMAS medidas reais do 4977679 relabeladas pela
equivalência oficial da própria linha (PP=90cm ... GG=120cm — etiqueta real
da peça + medida real do time). 2 SKUs XGG bloqueados (nenhum guia da conta
tem medida de XGG — sem fonte real). 4 guias criados pelo hub até agora:
6558327, 6136504, 6136506 (+ reusos 5170265/4537790/4539158/4977679/5170097).

**ROUND 2 — CK/LEVIS/FARM-fem (2026-07-18, "Continue subindo"): +236
anúncios, total 622.** Como:
- **Canários primeiro**: 1 CK + 1 LEVIS publicados antes do lote → **nem CK
  nem LEVIS têm moderação de marca em T_SHIRTS** (a lista de "marcas
  provavelmente gateadas" da era das bolsas não vale pra vestuário).
- **Seeds** (mesmo padrão FOXTON): CK→6136504 (T_SHIRTS) + 6558327
  (SHIRTS); LEVIS→6136504. **FARM fem ganhou guia próprio `6559695`
  "CAMISETAS FARM FEMININO"** (T_SHIRTS fem tinha 0 guias) clonado das
  BLUSAS FARM 5170097 — medidas femininas da própria FARM
  (peito 92-106/cintura/quadril).
- **53 fotos verificadas uma a uma** (todas manga Curta) + 11 por título.
- **Bug meu achado e corrigido**: o caminho apparel não limitava
  family_name a 60 chars (`item.family_name.length_invalid`, 9 SKUs) →
  `clampFamilyName` trunca em fronteira de palavra; os 9 recuperados.
- Resultado: CK 144 ativos (57 camisetas + 87 polos), LEVIS 69 (45+24),
  FARM fem 12. Bloqueios limpos: 34 GGG + 12 XGG (sem medida real em
  nenhum guia da conta). **Falso positivo do ML reportado, não contornado:**
  `invalid.title.gender` em 2 produtos com "BEBE" no título (cor "azul
  bebê"/fit "bebe" — o checador acha que é produto de bebê); mudar título é
  decisão do Miguel.

**GGG/XGG RESOLVIDOS ("resolva", 2026-07-18): +47 anúncios, total 677.**
Fonte real achada: o guia do time `5163260` tem medida corporal da linha
**"G3 (XGG)"** (peito 132cm) — e GGG ≡ G3 ≡ XGG pela notação do próprio
guia ("G3 (XGG)"), cadeia de dado real, não extrapolação. Achado novo do
ML no caminho: **`duplicated_measure_value`** — um guia não aceita duas
linhas com a mesma medida, então XGG e GGG (mesma medida) exigiram guias
separados: `6137334` (T_SHIRTS até XGG), `6137410` (T_SHIRTS até GGG),
`6137412` (SHIRTS até XGG), todos clonando PP-GG do ROUPAS MASCULINO +
linha G3 do 5163260. União de linhas no cache por marca (CK←GGG,
LEVIS←XGG+GGG, FOXTON←XGG) e o SIZE_GRID_ID por item saiu certo via
derivação pelo row id (26 GGG→6137410, 14 XGG→6137334/12). 47/48
recuperados; 1 ficou: polo CK GGG **sem foto na Moovin**
(`requiresPictures` — gap de origem). Erros restantes no hub inteiro: 8
(4 tamanhos sem medida real tipo "P (3)"/"6", 1 sem foto, 3 diversos
antigos). Guias criados pelo hub: **9**.

**BLUSAS COLCCI ("arrume", 2026-07-18): +30 anúncios, total 707.** Única
pendência feminina com medida da PRÓPRIA marca: as medidas Colcci
verificadas por print no `4537790` foram clonadas pro guia novo `6137436`
"BLUSAS COLCCI" (BLOUSES). 14 fotos verificadas (mix Sem mangas/Curta —
tomara-que-caia, regatas, meia-manga). 1 SKU "M (40)" bloqueado (rótulo
misto sem linha — dado de origem). **Seguem bloqueados por falta de medida
da própria marca (regra do Miguel, não renegociável): CK fem, MARIA FILÓ,
RICHARDS fem, LEVIS fem, LILICA infantil** — nenhum tem medida própria em
guia nenhum da conta; só saem com medida real nova do fornecedor.

## Placar da madrugada 2026-07-18 (fechamento)

**292 anúncios ativos no ML, todos publicados pelo hub:** 118 vestidos FARM
+ 59 vestidos COLCCI (nominais 4537790 + numeração 4539158) + 113 tops (29
blusas FARM, 46 camisetas + 38 polos RICHARDS) + 2 bolsas LUZ DA LUA
(catalog listing). 60/60 testes verdes. Pendências pro Miguel: óculos
BRAND=OUTROS (só remove pela tela), MONTENAPOLEONE AMÊNDOA (sem GTIN nem
catálogo na cor), LEVIS (conflito gênero do guia), CK/LACOSTE/FOXTON (sem
guia com evidência), CAMISAS (0 guias em SHIRTS), infantil (mapa de gênero),
marcas gateadas (autorização de conta).

## Comandos

```
docker compose up -d        # Postgres 5433
npm run prisma:migrate      # migrations
npm test                    # suite completa (auto-pula integração sem DB)
npm run start:dev           # API + worker embutido
```
