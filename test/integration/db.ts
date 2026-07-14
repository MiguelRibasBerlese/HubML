import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// Carrega .env (vitest não faz isso sozinho) e expõe um Prisma para os testes de integração.
// Sem DATABASE_URL configurada, os testes de integração são pulados (ver dbConfigured).
function loadDotEnv(): void {
  try {
    const raw = readFileSync(join(__dirname, '../../.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
    }
  } catch {
    // sem .env — segue com o ambiente atual
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
