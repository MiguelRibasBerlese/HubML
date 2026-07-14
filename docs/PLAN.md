# PLAN — Hub de Integração Mercado Livre

> Status: **aprovado e em execução** — Fase 1 (M0–M5) implementada e testada em 2026-07-14 (29 testes verdes, 0 vulnerabilidades de produção). Pendente: validações reais contra a conta ML (M1.5/M4.6/M5.5, dependem das credenciais no `.env` + OAuth) e o gate para M6–M10. Ver `README.md` e `CLAUDE.md`.
> Data: 2026-07-13 (plano) · 2026-07-14 (execução Fase 1) · Autor: Claude + Miguel

---

## 1. Entendimento do escopo

Hub **single-seller** que é a fonte da verdade do catálogo e conversa com o Mercado Livre em quatro fluxos:

0. **Import inicial (bootstrap)** — a conta ML já existe e já tem anúncios: o hub importa os itens da conta (`GET /users/{user_id}/items/search` + multiget de `/items`) e popula `product`/`variation`/`listing` com os `ml_item_id` reais. O estoque/preço do ML é adotado como verdade inicial; **depois do import, o hub vira o mestre**.
1. **Publicação** — catálogo local → anúncios no ML (com variações, atributos por categoria, guia de tamanhos, GTIN), idempotente.
2. **Sincronização** — preço/estoque hub → ML (push) e vendas ML → hub (webhook baixa estoque), com reconciliação periódica. Regra dura: **nunca oversell**.
3. **Pedidos** — notificação → busca do pedido → NF-e via provedor → etiqueta Mercado Envios → marcar enviado, com falha tratada por etapa.

Fora de escopo: outros marketplaces, emissão fiscal própria, front elaborado, multi-tenant.

**Decisão de modularidade (lazy, deliberada):** todo código que fala com o ML fica isolado em `src/ml/`. Não criaremos interface genérica `Channel` agora — um segundo marketplace no futuro extrai a interface a partir do código real, não de especulação (YAGNI).

---

## 2. Fatos verificados da API do ML (2026-07-13, doc oficial pt_br)

Verificação feita diretamente contra as páginas de `developers.mercadolivre.com.br` (baixadas via curl com UA de navegador; o portal bloqueia fetch automatizado padrão). Páginas com "Última atualização" entre 12/2025 e 07/2026.

### OAuth2 (página `autenticacao-e-autorizacao`) ✅
- Autorização: `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=...&redirect_uri=...` (+`state` recomendado). `redirect_uri` deve ser **exatamente** igual ao cadastrado no app, sem partes variáveis.
- PKCE: opcional; **se habilitado no app, vira obrigatório** (`code_challenge` S256; `code_verifier` no token).
- Token: `POST https://api.mercadolibre.com/oauth/token` (form-urlencoded). Resposta: `expires_in: 21600` (**6h**), `scope: "offline_access read write"`.
- **Refresh token: uso único**, rotaciona a cada refresh, validade 6 meses, só o último vale. Doc recomenda renovar **apenas quando expirar** (não proativamente).
- Token invalidado antes da hora por: troca de senha do seller, rotação do client secret, revogação, ou **4 meses sem chamadas à API**.
- O usuário que autoriza deve ser o **administrador** da conta (operador/colaborador → `invalid_operator_user_id`).

### Notificações (página `produto-receba-notificacoes`) ✅
- Responder **HTTP 200 em até 500ms**; caso contrário o ML pode **desativar o tópico por fallback** — e notificações do período de desativação **não vão para missed_feeds**; é preciso se reinscrever. Inbox assíncrono é obrigatório.
- Retries por ~1h (8 tentativas); depois a notificação vai para `GET /missed_feeds?app_id=` (com filtro `&topic=`), que guarda só **2 dias**.
- Payload contém apenas `resource`/`topic`/`user_id` etc. — sempre fazer GET no resource.
- Tópicos relevantes para nós: `orders_v2` (recomendado), `items`, `shipments`, `payments`, `items_prices`, `stock-locations` (User Products), `invoices` (Faturador ML), `public_offers`.
- ML publica a lista de IPs de origem das notificações (allowlist opcional no firewall).

### Itens, import e publicação (páginas `itens-e-buscas`, `publicacao-de-produtos`, `variacoes`) ✅
- Listagem da conta: `GET /users/{user_id}/items/search`, com `search_type=scan` para contas grandes; filtros úteis: `?seller_sku=`, `?sku=` (seller_custom_field), `?status=active`, `?missing_product_identifiers=true`.
- Atributos por categoria: `GET /categories/{id}/attributes` (tags `required`, `conditional_required`, `allow_variations`, `variation_attribute`).
- **⚠️ MUDANÇA DE MODELO — User Products (UP):** desde out/2024 o ML ativa progressivamente todos os sellers no modelo "Preço por Variação" (meta 100% em 2025). Seller ativado tem a tag **`user_product_seller`** em `/users/me`. Consequências: **não é mais possível publicar com array `variations`** — cada variação vira um item próprio (condição de venda), agrupado por `family_name`/`user_product_id`; estoque é gerido no nível do UP (`GET/PUT /user-products/{id}/stock`, notificações `stock-locations`); `available_quantity` e atributos sincronizam entre itens do mesmo UP automaticamente. Itens no modelo novo têm `family_name != null`. **Primeira coisa a checar no M1: a tag da conta do Miguel.** O modelo de dados do hub já acomoda os dois mundos (ver §5).

### Guia de tamanhos / SIZE_GRID (páginas `gerenciar-tabela-de-medida`, `validacao-tabela-de-medidas`) ✅
- Tabelas: tipos BRAND, STANDARD e SPECIFIC (própria do seller). Criação: `POST /catalog/charts` — estrutura vem da ficha técnica do domínio; `domain_id` **sem** prefixo do site (`SHIRTS`, não `MLB-SHIRTS`); atributos gerais (GENDER, BRAND) no nível da tabela, medidas nas `rows`. Resposta traz `id` da tabela e ids de row no formato `"463005:1"`.
- Associação: atributo `SIZE_GRID_ID` no item + `SIZE_GRID_ROW_ID` (no nível do item se sem variação; por variação se houver). Erros documentados: `Attribute [SIZE_GRID_ID] is missing / is not valid`, idem ROW — exatamente os que o motor de atributos deve prevenir.
- Obrigatória nos domínios de moda desde 2022 — nosso nicho (roupas/acessórios) está 100% dentro.

### GTIN (página `identificadores-de-produtos`) ✅
- Aceitos: UPC (12), EAN (13), JAN (8/13), ITF-14 (14). Validação por dígito verificador no hub antes de enviar.
- Obrigatoriedade: tag `conditional_required` no atributo GTIN da categoria; **marca com 30+ GTINs publicados torna o campo obrigatório de fato**.
- Isenção: atributo `EMPTY_GTIN_REASON` com motivos pré-definidos da ficha técnica (artesanal, kit, não registrado, outro). Nunca inventar número.

### Pedidos, envios e NF-e (páginas `gerenciamento-de-vendas`, `mercado-envios-2`, `obtendo-nota-fiscal`, `anexar-nota-fiscal`) ✅
- Pedido: notificação `orders_v2` → `GET /orders/{id}`.
- Etiqueta: `GET /shipment_labels?shipment_ids=...&response_type=pdf|zpl2`.
- **⚠️ DESCOBERTA — Faturador Mercado Livre:** o ML tem emissor próprio de NF-e por API (Fulfillment, Coletas/cross-docking, Flex e outros modos que usem o emissor). Fluxo: configurar regras tributárias + dados fiscais → ML emite a nota na venda → notificação no tópico `invoices` → `GET /users/{id}/invoices/{invoice_id}` (ou por order_id/shipment_id) → XML/DANFE prontos. **Pode eliminar o provedor externo de NF-e** (ver D2 revisada em §8).
- Emissão externa (se não usar o Faturador): importar a NF-e via `POST /shipments/{shipment_id}/invoice_data` — em logísticas `drop_off`, `cross_docking`, `xd_drop_off` isso é o que **libera a etiqueta**. `POST /packs/{pack_id}/fiscal_documents` apenas anexa o documento para o comprador (não libera etiqueta).

### Testes (página `realizacao-de-testes`) ✅
- Test users disponíveis; para fluxos User Products é preciso solicitar ambientação dos usuários de teste via formulário do ML (ativação semanal).

---

## 3. Stack proposta

| Camada | Escolha | Racional |
| --- | --- | --- |
| Runtime | Node.js 22 LTS + TypeScript (strict) | definido no prompt |
| Framework HTTP | **NestJS** (decidido — D1) | é a stack que você já domina (TaskFlow CRM, 13 módulos); DI e módulos ajudam a manter o isolamento `ml/` |
| ORM/migrations | **Prisma** + PostgreSQL 16 | domínio ativo seu; migrations versionadas |
| Fila de jobs | **Tabela `job` no Postgres** (worker em polling com `FOR UPDATE SKIP LOCKED`) | o prompt autoriza começar assim; BullMQ/Redis só se o volume provar necessidade. A troca fica fácil: handlers recebem `(type, payload)` e não conhecem o transporte |
| Logs | pino (JSON estruturado) com contexto por operação | requisito não-funcional |
| Testes | Vitest (unit) + testes de integração com Postgres via docker-compose; API do ML mockada com `nock`/MSW; e2e opcional com test users do ML | |
| Dev local | docker-compose (Postgres) + túnel (cloudflared/ngrok) para webhook | |
| Deploy | Railway (seu padrão) — dá a URL HTTPS pública para webhooks | |
| NF-e | **Faturador ML** (nativo) como principal; Focus NFe como fallback (D2 revisada) | elimina integração externa no caminho comum |

---

## 4. Árvore de pastas proposta

```
HubML/
├── CLAUDE.md                  # contexto persistente do projeto (criado após o OK)
├── README.md                  # como rodar
├── .env.example               # todas as variáveis (versionado)
├── docker-compose.yml         # Postgres local
├── docs/
│   ├── PLAN.md                # este arquivo
│   └── adr/                   # decisões arquiteturais relevantes
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── src/
│   ├── config/                # parsing/validação de env (zod)
│   ├── lib/                   # logger, erros tipados, utilitários (ex: validador EAN)
│   ├── ml/                    # TUDO que fala com o Mercado Livre
│   │   ├── auth/              # OAuth2, token store, refresh com lock
│   │   ├── client/            # wrapper HTTP: retry/backoff, rate limit, timeout, logs
│   │   ├── api/               # funções tipadas por recurso: items, categories, orders, shipments
│   │   └── webhooks/          # controller do callback + inbox de notificações
│   ├── modules/
│   │   ├── catalog/           # product, variation, estoque (ledger)
│   │   ├── attributes/        # motor de atributos: categoria, SIZE_GRID, GTIN/isenção
│   │   ├── publishing/        # criar/atualizar anúncios, idempotência via listing
│   │   ├── sync/              # push preço/estoque + job de reconciliação
│   │   ├── orders/            # pipeline pedido → NF-e → etiqueta → enviado
│   │   └── invoicing/         # adapter do provedor de NF-e (única parte com interface, pois o provedor pode trocar)
│   ├── jobs/                  # worker de polling + registro de handlers
│   ├── http/                  # bootstrap da API (rotas admin/CLI mínimas)
│   └── main.ts
└── test/
    ├── unit/
    └── integration/
```

---

## 5. Modelo de dados detalhado

Convenções: PKs `uuid`, dinheiro em **centavos (int)**, timestamps `timestamptz`, `created_at`/`updated_at` em tudo.

### Decisão estrutural: todo produto tem ao menos uma variação

Produto "simples" = 1 variação default interna. Elimina o if/else `com-variação vs sem-variação` em estoque, publicação e pedidos. No payload ao ML, produto de variação única pode ser publicado sem bloco `variations` — isso é detalhe do publisher, não do domínio.

### Tabelas

**`product`**
| Campo | Tipo | Notas |
| --- | --- | --- |
| id | uuid PK | |
| title | text | ≤ 60 chars para o ML (validado na publicação) |
| description | text | |
| brand | text | |
| ml_category_id | text null | ex: `MLB31447`; sugerida por domain_discovery, confirmável |
| gender | text null | domínios de moda |

**`variation`**
| Campo | Tipo | Notas |
| --- | --- | --- |
| id | uuid PK | |
| product_id | uuid FK | |
| sku | text UNIQUE | SKU próprio do seller |
| color / size | text null | atributos de variação mais comuns; extras em `attributes jsonb` |
| gtin | text null | EAN validado por dígito verificador |
| gtin_exempt_reason | text null | isenção explícita — `CHECK (gtin IS NOT NULL OR gtin_exempt_reason IS NOT NULL)` avaliado na publicação, não no insert |
| price_cents | int | |
| stock_on_hand | int NOT NULL `CHECK (stock_on_hand >= 0)` | **a** fonte da verdade; o CHECK é a última linha de defesa anti-oversell |

**`stock_movement`** (ledger append-only — auditoria e reconciliação)
| Campo | Tipo | Notas |
| --- | --- | --- |
| id | uuid PK | |
| variation_id | uuid FK | |
| delta | int | negativo = saída |
| reason | enum | `sale` \| `cancel` \| `manual` \| `reconciliation` \| `initial` |
| order_id | uuid null | quando reason = sale/cancel |
| balance_after | int | snapshot para auditoria |

Baixa de estoque sempre via `UPDATE variation SET stock_on_hand = stock_on_hand - $qty WHERE id = $id AND stock_on_hand >= $qty` + insert no ledger, **na mesma transação**. Zero linhas afetadas = venda sem estoque → alerta + pausar anúncio.

**`listing`** (vínculo hub ↔ anúncio ML — chave da idempotência de publicação)

Desenhada para os **dois modelos do ML** (ver §2 — User Products): no modelo legado, 1 listing por produto (item multi-variação); no modelo UP, 1 listing **por variação** (cada variação é um item próprio, agrupado por família).

| Campo | Tipo | Notas |
| --- | --- | --- |
| id | uuid PK | |
| product_id | uuid FK | |
| variation_id | uuid FK null | preenchido no modelo UP (1 item por variação); null = item legado multi-variação |
| ml_item_id | text UNIQUE null | `MLB...`; null = publicação pendente |
| ml_user_product_id | text null | `MLBU...` (modelo UP) |
| ml_family_id / family_name | text null | agrupamento da família no modelo UP |
| status | enum | `pending` \| `active` \| `paused` \| `closed` \| `error` |
| size_grid_id | text null | |
| last_error | jsonb null | erro de validação do ML, legível e reprocessável |
| last_synced_at | timestamptz null | |

**`listing_variation`**: `variation_id` ↔ `ml_variation_id` — usada apenas para anúncios legados multi-variação (ex.: itens antigos trazidos pelo import). Qual dos dois formatos a conta usa é detectado no M1 (tag `user_product_seller`) e confirmado item a item no import (`family_name != null`).

**`order`**
| Campo | Tipo | Notas |
| --- | --- | --- |
| id | uuid PK | |
| ml_order_id | text UNIQUE | **idempotência**: `INSERT ... ON CONFLICT DO NOTHING` |
| status | enum | `received` \| `stock_reserved` \| `invoiced` \| `labeled` \| `shipped` \| `error` — máquina de estados do pipeline; retry retoma da etapa que falhou |
| ml_shipment_id | text null | |
| nfe_ref / nfe_status | text null | referência no provedor de NF-e |
| label_url | text null | |
| total_cents | int | |
| raw | jsonb | payload completo do ML para debug/reprocesso |
| last_error | jsonb null | |

**`order_item`**: order_id, variation_id (match por SKU/ml_variation_id), qty, unit_price_cents.

**`ml_credentials`** (linha única): access_token, refresh_token, expires_at, ml_user_id. Refresh: transação com `SELECT ... FOR UPDATE` → se outro processo já renovou (expires_at futuro), usa o token novo; senão renova e persiste o par novo antes do COMMIT.

**`webhook_event`** (inbox): id, topic, resource, payload jsonb, received_at, processed_at null, status (`pending`/`done`/`failed`), attempts. Controller só insere e responde 200; worker processa. Dedupe por hash(topic+resource+sent).

**`job`** (fila em Postgres): id, type, payload jsonb, dedupe_key text UNIQUE null, status (`pending`/`running`/`done`/`failed`), run_at, attempts, max_attempts, last_error. Worker: `SELECT ... WHERE status='pending' AND run_at <= now() FOR UPDATE SKIP LOCKED LIMIT n`. Backoff exponencial em `run_at`. `dedupe_key` dá idempotência de enfileiramento (ex: `sync-stock:{variationId}`).

---

## 6. Fluxos críticos (como as regras duras são garantidas)

**Anti-oversell (3 camadas):**
1. `CHECK stock_on_hand >= 0` no banco (defesa final);
2. decremento condicional atômico + ledger na mesma transação;
3. job de reconciliação (a cada N min): compara estoque hub × `available_quantity` no ML e corrige o ML (hub sempre vence); também varre `missed_feeds`.

**Idempotência de publicação:** `publishing` sempre consulta `listing` antes: sem `ml_item_id` → `POST /items` e grava o id **antes** de qualquer outro passo; com `ml_item_id` → `PUT`. Falha entre o POST e o save é coberta pela reconciliação (busca itens do seller no ML por SKU via `seller_custom_field`/atributo SKU — ⚠️ verificar campo atual).

**Idempotência de pedidos:** `ml_order_id` UNIQUE + máquina de estados. Cada etapa (reservar estoque → NF-e → etiqueta → shipped) só executa se o status anterior confere; webhook duplicado ou retry de job não repete etapa concluída.

**Refresh de token concorrente:** lock pessimista na linha única de credenciais (descrito acima). Como o refresh token é de uso único, **jamais** dois processos renovam em paralelo.

**Pipeline de pedidos (dois trilhos, decidido pela logística do envio):**
- *Trilho A — Faturador ML (preferido):* pedido recebido → estoque baixado → ML emite a NF-e sozinho → hub escuta tópico `invoices` (ou consulta por `order_id`) e arquiva XML/DANFE → `GET /shipment_labels` → shipped. O hub não emite nada; só observa e arquiva.
- *Trilho B — emissor externo (Focus NFe):* pedido recebido → estoque baixado → hub emite NF-e no provedor → `POST /shipments/{id}/invoice_data` (obrigatório para liberar etiqueta em drop_off/cross_docking/xd_drop_off) → `GET /shipment_labels` → shipped.
A máquina de estados do `order` é a mesma; muda só o executor da etapa `invoiced`.

---

## 7. Milestones

Cada milestone é pequeno, testável e termina com suite verde. **Fase 1 = M0–M5** (entregáveis do prompt + import da conta, que é a origem real do catálogo).

| # | Milestone | Conteúdo | Prova de conclusão |
| --- | --- | --- | --- |
| M0 | Scaffold | repo, tsconfig strict, lint, Vitest, docker-compose (Postgres), pino, config zod, `.env.example`, README, CLAUDE.md, migrations iniciais (todas as tabelas) | `npm test` verde; `docker compose up` + migrate ok |
| M1 | Auth ML | fluxo authorization-code (rota local de callback), token store, refresh automático com lock, ⚠️ re-verificação da doc de OAuth | testes unit (rotação, concorrência simulada) + troca de token real contra a API |
| M2 | Cliente ML | wrapper HTTP: retry/backoff (5xx, 429, timeout), rate limit, timeout configurável, logs com contexto, erros tipados | testes com `nock` (429→retry, 401→refresh→replay, timeout) |
| M3 | Catálogo | CRUD mínimo product/variation via API/CLI, ledger de estoque, decremento atômico | teste de concorrência: N decrementos paralelos não furam o estoque |
| M4 | **Import da conta ML** | varre itens da conta (search + multiget, com variações e atributos), popula product/variation/listing com `ml_item_id`; re-executável sem duplicar (upsert por `ml_item_id`/SKU); estoque/preço do ML adotados como verdade inicial | rodar contra a conta real: catálogo do hub espelha a conta; 2ª execução não duplica nada |
| M5 | **Publicação happy path** | produto simples (1 variação default, categoria fixa informada, GTIN válido) → `POST /items` → listing ativo; idempotência (2ª chamada = PUT, não duplica) | e2e com test user do ML criando anúncio real de teste |
| — | **GATE: fim da Fase 1 — revisão com Miguel** | | |
| M6 | Motor de atributos | fetch/cache de atributos da categoria, validação pré-envio, GTIN inválido → erro claro ou isenção, SIZE_GRID (associar guia, `SIZE_GRID_ROW_ID` por variação) — **obrigatório: nicho é roupas/acessórios** | testes com fixtures reais de categorias de moda |
| M7 | Variações | publicação/atualização multi-variação, `listing_variation` | e2e test user com item de variações |
| M8 | Sincronização | push preço/estoque, webhook `orders_v2`/`items` (inbox), venda baixa estoque, reconciliação periódica + missed_feeds, pausar anúncio ao zerar | simulação de webhook + teste do reconciliador |
| M9 | Pedidos | pipeline received→invoiced→labeled→shipped; trilho A (Faturador ML: escutar `invoices`, arquivar XML/DANFE) e, se necessário, trilho B (Focus NFe + `invoice_data`); etiqueta via `/shipment_labels`; falha por etapa com retry | e2e sandbox: pedido fake percorre a máquina de estados |
| M10 | Operação | import em massa de produtos novos (CSV → catálogo → fila de publicação), dashboards mínimos de erro (CLI/endpoint), deploy Railway | publicar N produtos novos de uma planilha |

---

## 8. Decisões tomadas (2026-07-13, com Miguel)

| # | Decisão | Resposta |
| --- | --- | --- |
| D1 | Framework | **NestJS** + Prisma (delegado ao Claude; stack de domínio ativo do Miguel) |
| D2 | NF-e | **REVISADA após leitura da doc (2026-07-13): usar o Faturador do próprio Mercado Livre** como caminho principal — o ML emite a NF-e por API para os modos logísticos que usam o emissor dele (Fulfillment, Coletas, Flex etc.), com notificações via tópico `invoices` e XML/DANFE para download. Zero integração externa. **Focus NFe fica como fallback** apenas se o modo de envio da conta não for coberto pelo Faturador ou se o contador exigir emissão própria. Verificar no M1/M4 qual modo logístico a conta usa. ⚠️ Pendência mantida: dados fiscais (CNPJ com IE, regras tributárias) precisam estar configurados no ML para o Faturador funcionar |
| D3 | Conta/app ML | **Já existem** conta seller e aplicação no DevCenter (app_id + secret vão para o `.env`) |
| D4 | Origem do catálogo | **A própria conta ML** — os anúncios existentes são importados automaticamente (fluxo 0 / M4). Import por CSV de produtos novos fica para o M10 |
| D5 | Nicho | **Roupas e acessórios** → SIZE_GRID obrigatório; M6 é peça central da Fase 2 |
| D6 | Deploy/webhook | Nada provisionado ainda. Default: Railway em produção, cloudflared/ngrok em dev. Provisiona-se no M8 (primeiro milestone que precisa de webhook público) |
| D7 | Fila | Tabela `job` no Postgres; BullMQ/Redis só se o volume provar necessidade |
| D8 | Modelo de publicação (aberta — resolvida no M1) | Detectar a tag `user_product_seller` em `/users/me`. Se ativa (provável em 2026): publicar no modelo User Products (1 item por variação, agrupado por família), estoque via `/user-products/{id}/stock`, tópico `stock-locations`. Se não: modelo legado com array `variations`. O schema já cobre ambos |

---

## 9. Riscos conhecidos

| Risco | Mitigação |
| --- | --- |
| Conta em transição para User Products (ou migrando durante o projeto) | Detecção no M1 + import (M4) revela o formato real de cada item; schema cobre os dois modelos; tópico `items` avisa de migrações (UPtin) |
| Tópico de webhook desativado por fallback (respostas > 500ms) — notificações somem sem ir ao missed_feeds | Endpoint burro: insere na inbox e responde 200; monitorar latência do endpoint; reconciliação periódica detecta buracos |
| missed_feeds guarda só 2 dias | Reconciliação com período ≤ diário |
| Refresh token de uso único perdido (crash entre refresh e persist) | Persistir novo par ANTES de usar; alerta para re-autorizar manualmente; token morre após 4 meses sem uso da API |
| Erros de validação do ML por categoria (size grid, atributos, GTIN 30+ da marca) | Motor de atributos valida antes; `last_error` legível + reprocesso |
| Faturador ML pode não cobrir o modo logístico da conta | Verificar no M4 (import revela `logistic_type` dos envios); fallback Focus NFe já desenhado (trilho B) |
| Dados fiscais incompletos (NCM, CFOP, origem, IE) | Levantar no gate da Fase 1; sem isso nem Faturador nem provedor externo emitem |
| Test users têm limitações no fluxo UP | Solicitar ambientação via formulário do ML com antecedência (ativação semanal) |

---

## 10. Etapas de execução

Regras de execução: uma etapa por vez, na ordem; cada etapa termina com `npm test` verde e um commit atômico (conventional commits). Nenhuma etapa começa se a anterior não fechou. Etapas da Fase 2 (M6–M10) estão em granularidade grossa de propósito — serão detalhadas no gate de fim da Fase 1.

### M0 — Scaffold e fundações

- [ ] 0.1 Iniciar repo git + `npm init`, TypeScript strict, ESLint, Vitest, estrutura de pastas do §4
- [ ] 0.2 `docker-compose.yml` com Postgres 16; `.env.example` com todas as variáveis conhecidas (DATABASE_URL, ML_APP_ID, ML_CLIENT_SECRET, ML_REDIRECT_URI, LOG_LEVEL, PORT); `.env` no `.gitignore`
- [ ] 0.3 `src/config`: parsing de env com zod — teste: env inválida derruba o boot com mensagem clara
- [ ] 0.4 `src/lib/logger`: pino JSON com contexto por operação (child loggers) — teste: log carrega `sku`/`orderId` quando fornecidos
- [ ] 0.5 Prisma: schema completo do §5 (todas as tabelas, incluindo `job` e `webhook_event`) + primeira migration — teste: migration roda limpa num banco vazio
- [ ] 0.6 Bootstrap NestJS mínimo (health check `GET /health`) — teste e2e: sobe e responde 200
- [ ] 0.7 `README.md` (como rodar) + `CLAUDE.md` (stack, convenções, decisões D1–D8)
- [ ] Saída: `docker compose up` + `npx prisma migrate dev` + `npm test` verdes de ponta a ponta

### M1 — Auth ML (OAuth2)

- [ ] 1.1 Migration/modelo `ml_credentials` já existe (0.5); repository com `SELECT ... FOR UPDATE` — teste: lock serializa dois acessos concorrentes
- [ ] 1.2 Serviço de troca de code por token (`POST /oauth/token`, form-urlencoded) — teste unit com nock: happy path + `invalid_grant`
- [ ] 1.3 Refresh com rotação: renova só se expirado, persiste par novo ANTES de liberar o lock — teste: simular 2 workers concorrentes → apenas 1 refresh HTTP; crash simulado entre refresh e persist não perde o par (persistência na mesma transação)
- [ ] 1.4 Rota one-time de autorização: `GET /auth/ml/start` (redirect com `state`) + `GET /auth/ml/callback` (valida `state`, troca code, persiste) — teste e2e mockado
- [ ] 1.5 **Validação real:** rodar o fluxo com a conta de verdade (redirect_uri de localhost cadastrada no DevCenter); chamar `GET /users/me` e **registrar no CLAUDE.md: a conta tem a tag `user_product_seller`?** (resolve D8) e o modo logístico
- [ ] Saída: token real no banco, refresh automático comprovado, D8 resolvida

### M2 — Cliente ML (wrapper HTTP)

- [ ] 2.1 Cliente base: injeta Bearer do token store, timeout configurável, logs estruturados por chamada (endpoint, status, latência) — teste: header e timeout aplicados
- [ ] 2.2 Retry com backoff exponencial + jitter para 5xx/timeout; respeitar `Retry-After` em 429 — testes com nock: 500→retry→sucesso, 429→espera→sucesso, 4xx (exceto 429) NÃO faz retry
- [ ] 2.3 Em 401: uma tentativa de refresh + replay da chamada; se falhar de novo, erro `MlAuthError` (sinaliza re-autorização manual) — teste
- [ ] 2.4 Erros tipados (`MlApiError` com body do ML legível) + rate limiting simples client-side (limitador de concorrência) — teste
- [ ] 2.5 `src/ml/api`: funções tipadas mínimas usadas nos próximos milestones: `getMe`, `getItem`, `searchSellerItems`, `getCategoryAttributes` — testes com fixtures reais gravadas
- [ ] Saída: toda chamada ao ML passa por um único caminho instrumentado

### M3 — Catálogo e estoque

- [ ] 3.1 CRUD de `product` + `variation` via API REST mínima (sem UI) — testes de validação (SKU único, preço ≥ 0)
- [ ] 3.2 Regra "todo produto tem ≥1 variação": criação de produto simples gera variação default — teste
- [ ] 3.3 Ledger: serviço `moveStock(variationId, delta, reason, orderId?)` = decremento condicional atômico + insert em `stock_movement` na mesma transação — teste de unidade
- [ ] 3.4 Teste de concorrência anti-oversell: estoque 5, 10 decrementos paralelos de 1 → exatamente 5 sucedem, 5 falham, ledger bate com `stock_on_hand`
- [ ] 3.5 Worker de jobs: polling com `FOR UPDATE SKIP LOCKED`, retry com backoff via `run_at`, `dedupe_key` — testes: job falho reagenda; dedupe não duplica; 2 workers não pegam o mesmo job
- [ ] Saída: catálogo funcional com estoque intocável por concorrência

### M4 — Import da conta ML

- [ ] 4.1 `searchSellerItems` com `search_type=scan` paginando até o fim — teste com fixtures de 2+ páginas
- [ ] 4.2 Multiget de detalhes dos itens (lotes) incluindo variações e atributos — fixtures reais da conta (anonimizadas)
- [ ] 4.3 Mapeador item ML → domínio hub, cobrindo os dois modelos: legado (item multi-variação → 1 product + N variations + listing_variation) e UP (`family_name != null` → agrupar itens da família em 1 product, 1 listing por variação) — testes com fixture de cada modelo
- [ ] 4.4 Upsert idempotente por `ml_item_id` + SKU (`seller_sku`); estoque/preço do ML viram verdade inicial com movimento `initial` no ledger — teste: rodar 2x não duplica nem re-inicializa estoque
- [ ] 4.5 Import como job na fila (`import-account`), com relatório final (importados, ignorados, erros por item em `last_error`)
- [ ] 4.6 **Validação real:** rodar contra a conta do Miguel; conferir por amostragem 5 anúncios no painel do ML vs hub
- [ ] Saída: catálogo do hub espelha a conta real; re-execução é no-op

### M5 — Publicação happy path (produto simples)

- [ ] 5.1 Validador pré-envio mínimo: título ≤ 60, categoria informada, GTIN válido por dígito verificador (EAN-13/UPC-12) ou isenção explícita — testes de tabela
- [ ] 5.2 Montador de payload `POST /items` para produto de variação única, no formato detectado em D8 (UP ou legado) — teste contra fixture da doc
- [ ] 5.3 Publicador idempotente: consulta `listing` antes; sem `ml_item_id` → POST e grava id na mesma transação do resultado; com id → PUT; erro de validação do ML → `status=error` + `last_error` legível — testes: duplo enqueue não duplica anúncio
- [ ] 5.4 Job `publish-product` na fila com dedupe_key por produto
- [ ] 5.5 **Validação real:** criar produto de teste no hub → publicar na conta (ou test user, se ambientado) → anúncio ativo no ML → despublicar/pausar
- [ ] Saída: entregável da Fase 1 completo, ponta a ponta com teste

### 🔒 GATE — revisão com Miguel antes da Fase 2
Rever: formato real da conta (D8), modo logístico (define trilho A/B de NF-e), dados fiscais disponíveis, e detalhar M6–M10 no nível acima.

### M6 — Motor de atributos + SIZE_GRID (grosso — detalhar no gate)
- [ ] Fetch/cache de `categories/{id}/attributes` e ficha técnica do domínio; validação pré-envio genérica por tags (`required`, `conditional_required`)
- [ ] GTIN: regra completa (tipos, marca 30+, `EMPTY_GTIN_REASON` com motivos da ficha)
- [ ] Tabelas de medidas: listar existentes, criar SPECIFIC via `POST /catalog/charts`, associar `SIZE_GRID_ID`/`SIZE_GRID_ROW_ID`
- [ ] Fixtures reais de 2–3 categorias de roupas/acessórios da conta

### M7 — Variações completas (grosso)
- [ ] Publicação/atualização multi-variação no formato da conta (UP: N itens por família; legado: array variations)
- [ ] Sincronização de mudanças de variação (adicionar/remover tamanho/cor)

### M8 — Sincronização contínua (grosso)
- [ ] Endpoint público de webhook (inbox: insert + 200 imediato) + deploy Railway + túnel dev
- [ ] Consumers por tópico: `orders_v2` (venda → baixa estoque), `items` (mudança externa → reconciliar), `stock-locations` se UP
- [ ] Push preço/estoque hub → ML (jobs com dedupe por variação)
- [ ] Reconciliador periódico (≤ diário): hub × ML, hub vence; varre `missed_feeds`; pausa anúncio ao zerar estoque
- [ ] Alarme de latência do webhook (regra dos 500ms)

### M9 — Pedidos ponta a ponta (grosso)
- [ ] Máquina de estados do `order` com etapa idempotente e retry por etapa
- [ ] Trilho A (Faturador ML): consumer do tópico `invoices`, arquivar XML/DANFE
- [ ] Trilho B (Focus NFe) apenas se o gate indicar necessidade: emissão + `POST /shipments/{id}/invoice_data`
- [ ] Etiqueta `GET /shipment_labels` (pdf/zpl2) + marcar enviado
- [ ] Tratamento de cancelamento/devolução mínimo (estorno de estoque com movimento `cancel`)

### M10 — Operação em massa (grosso)
- [ ] Import CSV de produtos novos → catálogo → fila de publicação em lote
- [ ] Relatório de erros re-processável (CLI/endpoint)
- [ ] Runbook de operação no README (re-autorizar OAuth, reprocessar erros, rodar reconciliação manual)
