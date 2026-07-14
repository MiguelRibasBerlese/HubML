# HubML — Hub de Integração Mercado Livre

Hub single-seller que é a fonte da verdade do catálogo e conversa com o Mercado
Livre: import da conta, publicação, sincronização de preço/estoque (anti-oversell)
e pipeline de pedidos. Node 22 + TypeScript strict, NestJS, Prisma, PostgreSQL.

Plano completo e decisões: [`docs/PLAN.md`](docs/PLAN.md).

## Estado atual (Fase 1 — M0–M5 implementados e testados)

| Milestone | O que faz | Status |
| --- | --- | --- |
| M0 Scaffold | config (zod), logger (pino), schema completo, health, docker, CI de testes | ✅ |
| M1 Auth ML | OAuth2 authorization-code, token store com refresh rotacionado sob lock | ✅ |
| M2 Cliente ML | wrapper HTTP: retry/backoff, 429 Retry-After, 401→refresh→replay, erros tipados | ✅ |
| M3 Catálogo | product/variation, ledger de estoque, decremento atômico anti-oversell, worker de jobs | ✅ |
| M4 Import | varre a conta (scan+multiget), mapeia legado e User Products, upsert idempotente | ✅ |
| M5 Publicação | validação pré-envio (título/GTIN), payload builder, publicador idempotente | ✅ |
| M6–M10 | motor de atributos/SIZE_GRID, variações, sync contínuo, pedidos, operação em massa | ⏳ roadmap |

> ⚠️ As **validações reais** contra a conta do Mercado Livre (M1.5, M4.6, M5.5) e o
> deploy dependem das credenciais e do OAuth — ficam a seu cargo (ver abaixo). Todo o
> código está pronto para isso; falta só preencher o `.env` e autorizar.

## Pré-requisitos

- Node.js 22+ e npm
- Docker (para o Postgres local) — ou um Postgres 16 próprio
- Uma aplicação no [DevCenter do Mercado Livre](https://developers.mercadolivre.com.br)
  (app_id + client secret) com a `redirect_uri` cadastrada **idêntica** à do `.env`

## Setup local

```bash
cp .env.example .env        # preencha ML_APP_ID, ML_CLIENT_SECRET, ML_REDIRECT_URI
npm install
docker compose up -d        # Postgres em localhost:5433
npm run prisma:migrate      # cria todas as tabelas + CHECK anti-oversell
npm test                    # 29 testes (unit + integração)
npm run start:dev           # API em http://localhost:3000
```

Health check: `curl http://localhost:3000/health` → `{"status":"ok","db":"up"}`.

## Autorizar a conta ML (uma vez)

Com a API no ar e a `redirect_uri` do app apontando para
`http://localhost:3000/auth/ml/callback`:

1. Abra `http://localhost:3000/auth/ml/start` no navegador (logado como **admin** do seller).
2. Autorize; o callback grava o par de tokens no banco (`ml_credentials`).
3. A partir daí o refresh é automático (rotação sob lock; ver `TokenStore`).

Depois disso, descubra o modelo da conta (resolve a decisão D8 do plano):

```bash
# a resposta de /users/me diz se a conta tem a tag user_product_seller
```

## Operação

```bash
curl -X POST http://localhost:3000/admin/import    # enfileira import da conta ML
curl -X POST http://localhost:3000/admin/publish -H 'Content-Type: application/json' \
     -d '{"productId":"<uuid>"}'                    # enfileira publicação de um produto
```

Catálogo (REST mínimo, sem UI):

```bash
POST /catalog/products                 # cria produto (>=1 variação; default se omitida)
GET  /catalog/products                 # lista
GET  /catalog/products/:id             # detalhe com variações e listings
POST /catalog/variations/:id/stock     # { "delta": -1, "reason": "sale" }
```

Webhook do ML (inbox burro, responde 200 em <500ms): `POST /webhooks/ml`.

## Worker

A API sobe um worker de jobs embutido (single-seller, volume baixo). Para escalar
o processamento separado da API:

```bash
npm run worker        # ou worker:dev
```

## No ar (deploy atual)

| Peça | URL | Estado |
| --- | --- | --- |
| Backend (Railway) | https://hubml-api-production.up.railway.app | ✅ público (`/health` → 200) |
| Banco (Railway Postgres) | interno (`postgres.railway.internal`) | ✅ migrations aplicadas |
| Frontend (Vercel) | https://web-99hjxhc9g-miguel-ribas-projects.vercel.app | ⚠️ protegido por Vercel Authentication |

O painel chama o backend e pede a `ADMIN_API_KEY` (definida no Railway) — a chave
fica só no navegador (localStorage), nunca no bundle. Rotas de escrita exigem o
header `x-admin-key`; `/health`, `/webhooks/ml` e `/auth/ml/*` são abertas.

**Para deixar o painel público** (hoje ele pede login da Vercel): desligue a proteção
em Vercel → projeto `web` → Settings → Deployment Protection → Vercel Authentication → **Disabled**,
ou rode `vercel project protection disable --sso --yes` no diretório `web/`.

**Faltando para operar de verdade:** trocar no Railway `ML_APP_ID`, `ML_CLIENT_SECRET`
(hoje `REPLACE_ME`) pelos valores do seu app no DevCenter, e cadastrar a `redirect_uri`
`https://hubml-api-production.up.railway.app/auth/ml/callback` no app do ML. Depois
abra `.../auth/ml/start` para autorizar a conta.

## Deploy (Railway)

O `Dockerfile` + `railway.json` já estão prontos. No Railway:

1. Crie o projeto a partir deste repo (builder = Dockerfile).
2. Adicione um Postgres (plugin do Railway) — ele injeta `DATABASE_URL`.
3. Configure as env vars do `.env.example` (ML_APP_ID, ML_CLIENT_SECRET, `ML_REDIRECT_URI`
   apontando para a URL pública do Railway `.../auth/ml/callback`, cadastrada também no DevCenter).
4. Deploy: o start roda `prisma migrate deploy` e sobe a API. Healthcheck em `/health`.

Em dev, para o webhook público use um túnel (`cloudflared tunnel --url http://localhost:3000`
ou `ngrok http 3000`) e cadastre a URL de callback de notificações no app do ML.

## Estrutura

```
src/
  config/       env (zod)
  lib/          logger (pino), erros tipados, prisma, validador GTIN
  ml/           TUDO que fala com o ML (fronteira): auth, client, api, webhooks
  modules/      catalog (+stock ledger), import, publishing
  jobs/         fila em Postgres + worker (FOR UPDATE SKIP LOCKED)
  http/         health + rotas admin
test/           unit + integration (auto-puladas sem Postgres)
```

## Regras duras garantidas

- **Nunca oversell**: CHECK `stock_on_hand >= 0` + decremento condicional atômico +
  ledger na mesma transação (provado em `test/integration/stock.integration.test.ts`).
- **Refresh token de uso único**: renovação sob `SELECT … FOR UPDATE`; dois processos
  nunca renovam em paralelo.
- **Publicação/import idempotentes**: vínculo via `listing.ml_item_id` e upsert por SKU.

Licença: MIT.
