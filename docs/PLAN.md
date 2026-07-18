# PLAN — Hub de Integração Mercado Livre

> Status: **Fase 1 (M0–M5) implementada e testada em 2026-07-14** (29 testes verdes, 0 vulnerabilidades de produção). **2026-07-16: correção de rumo (ver §11)** — a decisão D4 estava errada; a origem real do catálogo é a Moovin, não a conta ML. **Passo 3 de §11.8 resolvido**: não havia gap de permissão do app — o 403 original era artefato de token ausente (reconfirmado: `GET /users/me` sem token dá o mesmo erro) e `TOPS` nunca foi um `domain_id` válido (o correto é `MLB-SPORT_T_SHIRTS`, obtido via `catalog_domain` da categoria). Com token fresco e domínio certo, `technical_specs` retorna 200 e confirma: SIZE_GRID **não** exige medida corporal, só `SIZE` nominal + `SIZE_GRID_ID`/`SIZE_GRID_ROW_ID` — "caminho direto" confirmado. **Passo 4 bloqueado**: falta rerodar o M4.6 (catálogo foi perdido num reset do volume Docker) e falta o arquivo `data/produtos_moovin.xlsx`. Ver §11.8 para detalhes. Ver `README.md` e `CLAUDE.md`.
> Data: 2026-07-13 (plano) · 2026-07-14 (execução Fase 1) · 2026-07-16 (correção de rumo, §11) · Autor: Claude + Miguel

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
| M4 | **Import da conta ML** (não-crítico desde 2026-07-16, ver §11) | varre itens da conta (search + multiget, com variações e atributos), popula product/variation/listing com `ml_item_id`; re-executável sem duplicar (upsert por `ml_item_id`/SKU); estoque/preço do ML adotados como verdade inicial | rodar contra a conta real: catálogo do hub espelha a conta; 2ª execução não duplica nada. **Implementado e testado, mas não é mais a origem do catálogo** — serve para reconciliação futura (M8) |
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
| D4 | Origem do catálogo | ~~A própria conta ML~~ **CORRIGIDA em 2026-07-16 (§11): a origem real é a Moovin** (e-commerce que recebe dados do ERP Microvix). A conta ML está vazia — publicar nela é o objetivo, não a origem. O import da conta ML (M4) é mantido para reconciliação futura mas sai do caminho crítico |
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

### M6 — Motor de atributos + SIZE_GRID

**Substituído pelo detalhamento fino em §11.6.** Resumo: descobrir via `technical_specs` se o domínio exige medidas corporais (risco em aberto, verificar ANTES de desenhar o resto); criar guia `SPECIFIC` por combinação tipo×marca via `/catalog/charts`; motor de atributos genérico por tags da ficha técnica; GTIN sempre com `EMPTY_GTIN_REASON` (confirmado pela Moovin: GTIN da origem é lixo, ver §11.3).

### M7 — Variações completas

**Substituído pelo detalhamento fino em §11.7.** Resumo: estender `payload-builder.ts` com `attribute_combinations` (cor/tamanho) + `SIZE_GRID_ROW_ID` por variação, persistindo em `ListingVariation.mlVariationId`. Formato depende de D8 (UP vs legado) — resolver D8 é pré-requisito.

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

---

## 11. Correção de rumo (2026-07-16): Moovin é a origem real do catálogo

### 11.1 Causa raiz

D4 assumia que a conta ML já tinha o catálogo e o hub só precisava importá-lo (M4, direção ML → hub). Na prática a conta está vazia — o objetivo é publicar nela, não ler dela. A origem real é:

```
Microvix (ERP, Linx)  →  Moovin (e-commerce)  →  [HubML]  →  Mercado Livre
```

O Microvix é gerenciado por outro setor da Linx, sem previsão de integração — **não vamos esperar por ele**. A Moovin já entregou um export xlsx do catálogo (2.971 linhas) via suporte, e é isso que destrava o projeto agora. M4 (import da conta ML) não é apagado — fica reservado para reconciliação no M8 — mas sai do caminho crítico.

### 11.2 Diagnóstico do xlsx (fato apurado, base para o desenho abaixo)

Arquivo `produtos_moovin_2026-07-16T13-14-20-534Z.xlsx`, aba `Produtos`, 27 colunas. Relevantes: `ID, URN, LINK_PRODUTO, NOME, DESCRICAO, SKU, GTIN, CATEGORIA, MARCA, ATIVO, PRECO_CUSTO, PRECO_VENDA, PRECO_LISTA, ESTOQUE, IMAGENS, COR, TAMANHO, ALTURA, LARGURA, COMPRIMENTO, PESO`.

- 2.971 linhas, 267 duplicatas exatas (9%) → deduplicar na importação.
- Linhas são **variações**; agrupar por `URN` (chave estável, sem conflito de nome) dá **959 produtos** e **2.704 variações** (~3 variações/produto).
- **GTIN: zero registros válidos.** 86% = GTIN igual ao SKU interno; 14% vazio. Confirmado pelo suporte Moovin: deixar vazio/zerado é a orientação, testado e funcional no PlaceMarket. **Todo produto publica com `EMPTY_GTIN_REASON`** (já implementado em `payload-builder.ts`).
- **`PRECO_VENDA` está zerado em 100% das linhas — usar `PRECO_LISTA`.** Erro aqui publica o catálogo a zero.
- Imagens: 950 URLs distintas (`storage.moovin.store`), só 10 produtos sem imagem; variações do mesmo produto compartilham URL.
- **734 produtos (77%) exigem SIZE_GRID.** 168 são livres (bolsas, bonés, cintos, carteiras, óculos).
- 111 combinações tipo×marca precisam de guia (maior volume: VESTIDO/FARM = 79).
- **95 formatos de tamanho distintos, 35 inválidos, afetando 126 variações** (ver §11.4 para exemplos e o que fica em aberto).
- `CATEGORIA` da Moovin é departamento (MASCULINO/FEMININO/INFANTIL/...), não categoria ML. Tipo real do produto só é inferível da 1ª palavra do `NOME`; gênero é inferível da `CATEGORIA`.

### 11.3 Desenho: importador Moovin

Mesma regra de fronteira que já existe para o ML (`src/ml/` concentra tudo que fala com o Mercado Livre) — replicar para a Moovin:

```
src/moovin/
├── source.interface.ts   # MoovinSource + MoovinProductRow (contrato neutro)
├── xlsx-source.ts         # implementação de hoje: lê o arquivo local
└── api-source.ts          # implementação de amanhã: docs.moovin.app (app_id/app_secret, paginação page/size≤100, {items, total})
src/modules/moovin-import/
├── moovin-mapper.ts        # dedupe + agrupamento por URN + inferência tipo/gênero + normalização de tamanho
├── size-normalizer.ts      # de-para determinístico (ver §11.4), com valor original preservado
└── moovin-import.service.ts # upsert idempotente product/variation, análogo ao ImportService do M4
```

`MoovinImportService` depende só de `MoovinSource` (interface), nunca do formato de arquivo — trocar para a API futura é trocar a implementação injetada, sem tocar no mapper nem no service. Mesmo padrão de `MappedProduct`/`MappedVariation` do `import-mapper.ts` atual, reaproveitado por analogia (não literalmente o mesmo tipo, porque a Moovin não tem `ml_item_id`/variação legado vs UP).

**Chave de identidade (schema, precisa de migration — pendente de confirmação):**
- `product.moovin_urn text unique null` — chave de agrupamento estável da Moovin.
- `variation.sku` já é `unique` no schema atual — **o SKU da Moovin passa a ser o SKU canônico do hub**. Isso é consistente com M4/M8: quando o hub publica no ML, envia esse mesmo SKU como `seller_custom_field`; a reconciliação por import da conta ML (M4) casa por esse campo sem colisão.

Idempotência: upsert por `moovin_urn` (produto) e `sku` (variação) — rodar duas vezes não duplica, mesma prova de conclusão usada no M4.

**Dependência (decidida em 2026-07-16):** `@e965/xlsx` — fork de `xlsx`/SheetJS republicado no npm, sincronizado com os patches pós-CVE-2023-30533 (a `xlsx` oficial parou em 0.18.5, vulnerável, no registro público; a correção 0.19.3+ nunca voltou a ser publicada lá). Confirmado no registro: `@e965/xlsx` existe, versão atual 0.20.3, mesma API do SheetJS. Vantagem sobre instalar via tarball da CDN oficial: fluxo `npm install` normal, versionado em `package-lock.json`, sem dependência de alcançar `cdn.sheetjs.com` no build do Railway. Só leitura (nunca escrita de planilha).

**Dado sensível:** o xlsx tem preço de custo, preço de venda e estoque reais do cliente (`PRECO_CUSTO` incluso). Não vai para o Git independente do repositório ser público ou privado. `data/` inteira no `.gitignore`; caminho default `data/produtos_moovin.xlsx`, sobrescrevível por `MOOVIN_IMPORT_FILE_PATH` no `.env`.

### 11.4 Desenho: normalizador de tamanho (revisado com fatos do Miguel, 2026-07-16)

Fatos corrigidos (a leitura original estava parcialmente errada — cintura/comprimento e idade eram chutes, os reais são estes):

| Formato | Fato apurado |
| --- | --- |
| `27/28, 29/30, 31/32, 33/34, 35/36` | **100% chinelo Calvin Klein infantil** — numeração dupla de calçado (um chinelo serve os dois números), não cintura/comprimento |
| `4/6, 6/8, 8/10, 10/12, 12/14` | **Kit 2 cuecas Calvin Klein Trunk infantil** — faixa de tamanho, não idade exata |
| `3 (P), 4 (M), 5 (G), 6 (GG)` | Lacoste (polos/sweaters) — numeração própria da marca, equivalente BR entre parênteses |
| `P (3)` | Farm (vestidos) — ordem invertida: letra BR primeiro, número da marca entre parênteses |
| `S (P), L (G), XS (PP)` | Levi's e Calvin Klein — notação internacional + equivalente BR |
| `M (40), XL (43)` | Colcci, Lacoste, Levi's — letra + numeração |

**Regra:** todo formato `A (B)` é sempre **duas notações do mesmo tamanho** (uma da marca, outra o equivalente), mas a ordem (qual vem fora/dentro do parêntese) varia por marca — não dá para assumir uma posição fixa. Decisão de design: `normalizeSize` **não descarta nenhuma das duas notações**. Interface proposta:

```ts
interface NormalizedSize {
  original: string;       // valor cru da planilha, ex "P (3)"
  brandLabel: string;     // notação da marca (o "3" da Lacoste, o "27/28" do chinelo)
  brLabel: string;        // equivalente BR (o "P", o "PP")
  kind: 'letter' | 'numeric-pair' | 'letter-number'; // guia qual linha do guia usar depois
}
```

Qual dos dois campos (`brandLabel`/`brLabel`) vira o `main_attribute`/coluna principal do guia e qual vira coluna secundária **só é decidido depois do `technical_specs` real** (§11.5) — há indício de um atributo `FILTRABLE_SIZE` com lista fechada e de o guia aceitar mais de uma coluna de tamanho, mas decidir isso sem ver a ficha técnica seria chute. `normalizeSize` fica pronta e testada contra os 35 formatos reais nesta fase; o mapeamento final `NormalizedSize → row_id do guia` é responsabilidade do `size-grid.service.ts` (§11.5), não do normalizador.

### 11.5 Desenho: M6 — motor de atributos + SIZE_GRID

**Primeiro passo, antes de desenhar o resto: chamar `POST /domains/{DOMAIN_ID}/technical_specs?section=grids` de um domínio de vestuário real (ex. `TOPS` ou `SHIRTS`) e verificar se medidas corporais (`WAIST_CIRCUMFERENCE_FROM`, `HIP_CIRCUMFERENCE_FROM`, `FOOT_LENGTH`...) aparecem como `required`.** A MAGNI não tem esse dado e ele não pode ser inventado. Dois caminhos, dependendo do resultado:

- **Se medidas NÃO são obrigatórias** (só `main_attribute` tipo "Tamanho" com valores nominais): caminho direto — criar guia `SPECIFIC` por combinação tipo×marca com as linhas = tamanhos normalizados (§11.4).
- **Se medidas SÃO obrigatórias**: não decido sozinho o fallback. Opções a levar para o Miguel: (a) restringir o lançamento inicial a categorias sem exigência de medida corporal (ex. calçados, onde `BRAND`/`STANDARD` podem existir); (b) buscar tabela de medidas públicas por marca (risco: dado que não vem da MAGNI, precisa de aval explícito); (c) outra fonte de medida que a MAGNI tenha e eu não conheça. **Não seguir sem essa resposta.**

Componentes (assumindo caminho direto):
- `src/modules/attributes/` (novo): `size-grid.service.ts`. **Corrigido em 2026-07-16 (implementação real, ver passo 5):** `/catalog/charts/search` e `/catalog/charts/domains/search` **não existem** — testados ao vivo, 404 nos dois. O ML só expõe `POST /catalog/charts` (criar) e `GET /catalog/charts/$CHART_ID` (consultar por id; sem busca por domain/brand/gender). Por isso o cache local (`size_grid_chart`, chave `(domain_id, brand, gender)`) é a única forma de idempotência — `ensureChart()` checa o cache primeiro, só chama `POST /catalog/charts` se não achar, e persiste o `chart_id` retornado. `technical-specs.service.ts` não foi construído: a checagem do schema (§11.5 passo 1) foi feita manualmente contra a API pra confirmar o payload, não precisa virar código reusável nesta fase.
- Schema novo (migration): tabela `size_grid_chart` com **chave única `(domain_id, brand, gender)`** — corrigido em 2026-07-16: a chave não é tipo×marca, é domínio×marca×gênero, porque o guia do ML é por domínio e o gênero é atributo do guia (a moderação pausa o anúncio quando o gênero do guia não bate com o do anúncio — exatamente o risco documentado no PLAN). Campos: `domain_id`, `brand`, `gender`, `chart_id`, `chart_type` (`BRAND`/`STANDARD`/`SPECIFIC`), `rows jsonb`. `Listing.sizeGridId` continua guardando o vínculo por anúncio; esta tabela existe para não recriar o mesmo chart repetidamente entre os produtos que compartilham domínio×marca×gênero.
- Validação genérica por tags da ficha técnica (`required`, `conditional_required`, `main_attribute_candidate`) estendendo `publish-validator.ts`.
- **201 não é sucesso final:** após publicar, checar o status do item depois (moderação pode pausar por incompatibilidade de gênero no guia) — job de verificação pós-publicação ou checagem síncrona com espera curta, a decidir na fase de implementação.

### 11.6 Desenho: M7 — publicação multi-variação

Estende `payload-builder.ts` com `buildMultiVariationPayload`: bloco `variations[]` com `attribute_combinations` (COLOR, SIZE) + `SIZE_GRID_ROW_ID` por variação. Resposta do ML traz os `variation_id`s → persistir em `ListingVariation.mlVariationId` (modelo já existe, hoje só preenchido pelo import M4).

**Formato depende de D8 (ainda aberta):**
- Se legado: 1 `POST /items` com array `variations` (caminho acima).
- Se User Products: **desenho diferente** — cada variação é um item próprio agrupado por família; não é uma extensão de `buildMultiVariationPayload`, é um publicador novo (N `POST /items` + agrupamento por `family_name`). Não vou desenhar isso em detalhe agora porque D8 decide qual dos dois caminhos é real — resolver D8 primeiro evita construir o caminho errado.

### 11.7 Dependências e mudanças de schema — aprovadas em 2026-07-16, nenhuma aplicada ainda (fica para a fase 3/4 de §11.8)

1. Nova dependência: `@e965/xlsx` (fork republicado do SheetJS, patch pós-CVE-2023-30533) para ler o export da Moovin.
2. Migration: `product.moovin_urn text unique null` + index — nullable porque produtos vindos do import da conta ML (M4) não têm URN; é a chave de idempotência do upsert do importador Moovin.
3. Migration: nova tabela `size_grid_chart`, chave única `(domain_id, brand, gender)` + campo `chart_type` (`BRAND`/`STANDARD`/`SPECIFIC`).
4. Nova env var: `MOOVIN_IMPORT_FILE_PATH`, default `data/produtos_moovin.xlsx` — pasta `data/` inteira no `.gitignore` (o xlsx tem `PRECO_CUSTO` e não vai para o Git, público ou privado).

### 11.8 Ordem de execução (confirmada em 2026-07-16, cada fase com `npm test` verde e commit atômico)

1. ✅ **Feito (2026-07-16):** `data/` já estava no `.gitignore`; migrations `product.moovin_urn` (nullable unique) e `size_grid_chart` (chave `domain_id`+`brand`+`gender`, `chart_type` enum) criadas e aplicadas no Postgres local (`20260716134854_moovin_urn_and_size_grid_chart`), `npx prisma generate` + `npm run build` + `npm test` (29 testes) verdes. `.env.example` com `MOOVIN_IMPORT_FILE_PATH=data/produtos_moovin.xlsx` — **feito pelo Miguel manualmente** (arquivo segue bloqueado pra mim, mesma restrição do `.env`).
2. ✅ **Feito (2026-07-16):** conta ML autorizada de verdade via `/auth/ml/start` → `/auth/ml/callback`, D8 resolvido (`user_product_seller`, `mode=me2`/`logistic_type=xd_drop_off` — ver CLAUDE.md). Token se perdeu depois (volume Docker resetado, causa não identificada) mas **reautorizado de novo pelo Miguel no mesmo dia** (`{"ok":true,"mlUserId":"3153970621"}`) — `ml_credentials` confirmado com 1 linha válida.
3. ✅ **Resolvido (2026-07-16):** a 1ª investigação viu `POST/GET .../technical_specs` devolver 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` contra o domínio `TOPS`, o que parecia gap de permissão do app. Duas causas reais, nenhuma delas permissão:
   - **Token ausente na hora do reteste** — prova: `GET /users/me` (que não depende de nenhuma permissão especial) devolvia o mesmo 403 sem token válido. Resolvido reautorizando (passo 2).
   - **`TOPS` nunca foi um `domain_id` válido.** O `domain_id` real da categoria `MLB448691` (Camisetas) é `MLB-SPORT_T_SHIRTS` (campo `catalog_domain` de `GET /categories/MLB448691`).
   
   Com token fresco e `domain_id` correto: `GET /domains/MLB-SPORT_T_SHIRTS/technical_specs` → **200**, schema completo. **Confirma a pergunta crítica do §11.5: SIZE_GRID não exige medida corporal obrigatória** — nenhum atributo `CHEST`/`WAIST`/`HIP`/`BUST`/etc. no schema, só `SIZE` (nominal, lista fechada), `SIZE_GRID_ID` e `SIZE_GRID_ROW_ID`. **"Caminho direto" confirmado como definitivo**, não mais evidência indireta.
4. ✅ **Feito e validado (2026-07-16).** Achado importante: o xlsx real entregue pela Moovin **não é** o export bruto que §11.2/§11.3 descreviam — é um "catálogo preparado para o ML" com 5 abas (`LEIA-ME`, `RESUMO`, `PRODUTOS`, `VARIACOES`, `FALTA_BAIXAR`); as abas `PRODUTOS` (959 linhas) e `VARIACOES` (2704 linhas) já vêm com o agrupamento por URN, dedup e inferência de tipo/gênero feitos do lado da MAGNI — o mapper implementado é mais simples que o desenho original do §11.3 (sem dedupe/agrupamento em código). `normalizeSize` cobre as 3 formas reais encontradas nos 96 formatos de `TAMANHO` (par numérico `27/28`, parêntese letra-número `P (3)`, token único) — testada, 7 casos verdes. `@e965/xlsx` instalado; `MoovinSource`/`xlsx-source.ts`, `moovin-mapper.ts`, `MoovinImportService` implementados e ligados na fila de jobs (`import-moovin`) e no `POST /admin/import-moovin`. Rodado contra o xlsx real via HTTP/job: **959 produtos / 2704 variações**, batendo exatamente com a contagem alvo. Idempotência confirmada chamando `importCatalog()` uma 2ª vez diretamente (contornando o dedupe da fila): mesmos 959/2704, 0 erros, nenhuma duplicação. **Efeito colateral encontrado nesta sessão:** rodar `npm test` contra o Postgres de dev (compartilhado, sem isolamento) faz TRUNCATE nas tabelas como parte da suíte de integração — isso apagou o catálogo M4.6 (87/195/134) que tinha acabado de ser reimportado no passo 4 anterior; restaurado de novo com `POST /admin/import` depois do achado. **Risco operacional a documentar/mitigar antes do M6/M7**: qualquer `npm test` futuro contra este Postgres apaga dados manualmente importados — considerar banco de teste isolado.
5. M6: `size-grid.service.ts` + criação de **um** guia real (VESTIDO/FARM, maior volume, 79 produtos) via `/catalog/charts`, chave `(domain_id, brand, gender)`. **Código pronto (2026-07-16)**, `POST /catalog/charts` real ainda **não disparado** — pendente de confirmação do Miguel (escrita em produção na conta `MUNDOMAGNIRP`). Dados reais confirmados: `domain_id` = `DRESSES` (`MLB-DRESSES` com prefixo do site), 79 produtos FARM/vestido no catálogo local, `gender` = Feminino (`id` ML `339665`) em 100% deles, 4 tamanhos distintos por `brLabel` (PP 44, P 65+3, M 21, G 5) — o par `"P"`/`"P (3)"` colapsa na mesma linha porque o guia usa `brLabel`, não `original`.
6. M7: publicar **um** produto multi-variação ponta a ponta (formato decidido pelo D8 do passo 2); confirmar status ativo — não moderado/pausado — depois do 201.
7. Só então rodar o lote nos 959 produtos, com relatório de erros reprocessável (mesmo padrão do M4/M5).

### 11.9 Decisões fechadas em 2026-07-16 (não são mais perguntas abertas)

1. Caminho do xlsx: `data/produtos_moovin.xlsx` (default), `MOOVIN_IMPORT_FILE_PATH` sobrescreve. O Miguel entrega o arquivo manualmente em `data/`.
2. Normalização: guardar as duas notações (`brandLabel`/`brLabel`), nunca descartar o parêntese — mapeamento final para `main_attribute` depende do `technical_specs` real (passo 3 acima).
3. Dependência: `@e965/xlsx` (não a `xlsx` do npm público, vulnerável e parada em 0.18.5).
4. Migrations aprovadas com os ajustes do Miguel: `product.moovin_urn` nullable+unique+index; `size_grid_chart` com chave `(domain_id, brand, gender)` + `chart_type`.
5. `data/` no `.gitignore`, caminho via env var — vale independente da visibilidade do repositório (tem `PRECO_CUSTO`).
6. ✅ Resolvido em 2026-07-16 (ver passo 3 de §11.8): SIZE_GRID não exige medida corporal — mapeamento é por `SIZE` nominal + `SIZE_GRID_ID`/`SIZE_GRID_ROW_ID`.

**Única pendência real para começar a codar:** o arquivo `data/produtos_moovin.xlsx` precisa existir localmente e o catálogo do M4.6 precisa ser reimportado (perdido num reset do volume Docker) antes do passo 4. Credenciais ML já resolvidas (D8 + reautorização 2026-07-16). Aviso, não pergunta.
