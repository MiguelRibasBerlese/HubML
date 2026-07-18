import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// Fallback pra quando vitest roda fora do script "test" do package.json (ex. direto
// via IDE) — o script "test" já usa `node --env-file-if-exists=.env.test` que roda
// ANTES de qualquer import, incluindo o autoload de .env do próprio @prisma/client;
// esse loadDotEnv() aqui roda tarde demais pra vencer aquele autoload (é código de
// módulo, não flag de processo), por isso não basta sozinho pra garantir o banco
// isolado (5434) — ver package.json. Sem DATABASE_URL configurada, os testes de
// integração são pulados (ver dbConfigured).
function loadDotEnv(): void {
  for (const file of ['../../.env.test', '../../.env']) {
    try {
      const raw = readFileSync(join(__dirname, file), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
        if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
      }
      return;
    } catch {
      // tenta o próximo arquivo
    }
  }
}
loadDotEnv();

export const prisma = new PrismaClient();

/** Gate síncrono (avaliável na coleta): há banco configurado? Se não, integração é pulada. */
export function dbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

/** Limpa todas as tabelas (ordem respeitando FKs via TRUNCATE CASCADE). */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE listing_variation, listing, stock_movement, order_item, "order", variation, product, job, webhook_event, ml_credentials RESTART IDENTITY CASCADE',
  );
}
