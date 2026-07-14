import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { prisma, dbConfigured, resetDb } from './db';
import { StockService } from '../../src/modules/catalog/stock.service';
import { OutOfStockError } from '../../src/lib/errors';

 const d = dbConfigured() ? describe : describe.skip;

d('StockService (integração) — anti-oversell', () => {
  const stock = new StockService(prisma as never);
  let variationId: string;

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
    const product = await prisma.product.create({ data: { title: 'T' } });
    const v = await prisma.variation.create({
      data: { productId: product.id, sku: `SKU-${Date.now()}`, priceCents: 100, stockOnHand: 5 },
    });
    variationId = v.id;
  });

  it('10 decrementos paralelos de 1 sobre estoque 5 → exatamente 5 sucedem', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => stock.move(variationId, -1, 'sale')),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const outOfStock = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof OutOfStockError,
    ).length;

    expect(ok).toBe(5);
    expect(outOfStock).toBe(5);

    const v = await prisma.variation.findUniqueOrThrow({ where: { id: variationId } });
    expect(v.stockOnHand).toBe(0);

    // Ledger bate com o saldo: soma dos deltas = -5.
    const movements = await prisma.stockMovement.findMany({ where: { variationId } });
    const sum = movements.reduce((a, m) => a + m.delta, 0);
    expect(sum).toBe(-5);
    expect(movements).toHaveLength(5);
  });

  it('o CHECK do banco impede saldo negativo mesmo por SQL direto', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE variation SET stock_on_hand = -1 WHERE id = '${variationId}'`,
      ),
    ).rejects.toThrow();
  });
});
