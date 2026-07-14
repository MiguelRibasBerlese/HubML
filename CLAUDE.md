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
| D4 | Origem do catálogo = **a própria conta ML** (import M4); CSV de novos = M10 |
| D5 | Nicho = **roupas e acessórios** → SIZE_GRID obrigatório (M6) |
| D6 | Deploy Railway; webhook via túnel em dev; provisiona no M8 |
| D7 | Fila = tabela `job` no Postgres |
| **D8** | **PENDENTE (resolver no M1.5):** a conta tem a tag `user_product_seller`? Preencher aqui: `___`. Modo logístico dos envios (define trilho A/B de NF-e): `___` |

## Anti-oversell (3 camadas — §6)

1. CHECK `stock_on_hand >= 0` no banco (defesa final)
2. decremento condicional atômico + ledger na mesma transação (`StockService.move`)
3. reconciliador periódico (hub vence) — **M8, ainda não implementado**

## Estado

Fase 1 (M0–M5) implementada e testada (29 testes verdes). Falta rodar as
validações reais contra a conta (M1.5 resolve D8; M4.6; M5.5) e seguir para M6–M10
após o gate com o Miguel. Ver README para operar e `docs/PLAN.md §10` para as etapas.

## Comandos

```
docker compose up -d        # Postgres 5433
npm run prisma:migrate      # migrations
npm test                    # suite completa (auto-pula integração sem DB)
npm run start:dev           # API + worker embutido
```
