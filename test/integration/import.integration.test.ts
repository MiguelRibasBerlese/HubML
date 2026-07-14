import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma, dbConfigured, resetDb } from './db';
import { ImportService } from '../../src/modules/import/import.service';
import type { MlApi } from '../../src/ml/api/ml-api.service';
import type { MlItem } from '../../src/ml/api/ml-api.types';

 const d = dbConfigured() ? describe : describe.skip;

const legacyItem: MlItem = {
  id: 'MLB900',
  title: 'Camiseta',
  category_id: 'MLB31447',
  price: 49.9,
  family_name: null,
  variations: [
    { id: 1, seller_custom_field: 'CAM-P', available_quantity: 3, price: 49.9 },
    { id: 2, seller_custom_field: 'CAM-M', available_quantity: 7, price: 49.9 },
  ],
};

function fakeMl(): MlApi {
  return {
    getMe: async () => ({ id: 123, nickname: 'seller', tags: [] }),
    searchSellerItemIds: async () => ['MLB900'],
    getItems: async () => [legacyItem],
  } as unknown as MlApi;
}

d('ImportService (integração) — idempotência', () => {
  const svc = new ImportService(prisma as never, fakeMl());

  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('importa e re-executar é no-op (sem duplicar nem re-inicializar estoque)', async () => {
    const r1 = await svc.importAccount();
    expect(r1.productsUpserted).toBe(1);
    expect(r1.variationsUpserted).toBe(2);

    const products1 = await prisma.product.count();
    const variations1 = await prisma.variation.count();
    const listings1 = await prisma.listing.count();
    const movements1 = await prisma.stockMovement.count();
    expect(products1).toBe(1);
    expect(variations1).toBe(2);
    expect(listings1).toBe(1); // legado: 1 listing por produto
    expect(movements1).toBe(2); // um movimento initial por variação

    await svc.importAccount(); // 2ª execução

    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.variation.count()).toBe(2);
    expect(await prisma.listing.count()).toBe(1);
    expect(await prisma.stockMovement.count()).toBe(2); // NÃO re-inicializou estoque

    const camP = await prisma.variation.findUniqueOrThrow({ where: { sku: 'CAM-P' } });
    expect(camP.stockOnHand).toBe(3);
  });
});
