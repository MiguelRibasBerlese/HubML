import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma, dbConfigured, resetDb } from './db';
import { PublishingService } from '../../src/modules/publishing/publishing.service';
import type { MlApi } from '../../src/ml/api/ml-api.service';

 const d = dbConfigured() ? describe : describe.skip;

d('PublishingService (integração) — idempotência', () => {
  const createItem = vi.fn().mockResolvedValue({ id: 'MLB-NEW-1' });
  const updateItem = vi.fn().mockResolvedValue({ id: 'MLB-NEW-1' });
  const ml = {
    isUserProductSeller: async () => false,
    createItem,
    updateItem,
  } as unknown as MlApi;
  const svc = new PublishingService(prisma as never, ml);

  let productId: string;

  beforeEach(async () => {
    await resetDb();
    createItem.mockClear();
    updateItem.mockClear();
    const p = await prisma.product.create({
      data: {
        title: 'Camiseta Básica',
        mlCategoryId: 'MLB31447',
        variations: {
          create: { sku: 'PUB-1', priceCents: 5000, stockOnHand: 10, gtin: '7891234567895' },
        },
      },
    });
    productId = p.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('1ª publicação = POST; 2ª = PUT; não duplica listing', async () => {
    const first = await svc.publishProduct(productId);
    expect(first.action).toBe('created');
    expect(first.mlItemId).toBe('MLB-NEW-1');
    expect(createItem).toHaveBeenCalledTimes(1);

    const second = await svc.publishProduct(productId);
    expect(second.action).toBe('updated');
    expect(updateItem).toHaveBeenCalledTimes(1);
    expect(createItem).toHaveBeenCalledTimes(1); // não chamou POST de novo

    const listings = await prisma.listing.count({ where: { productId } });
    expect(listings).toBe(1);
  });

  it('erro de validação do ML marca listing como error com last_error legível', async () => {
    createItem.mockRejectedValueOnce(
      Object.assign(new Error('ML API 400'), { name: 'MlApiError', body: { message: 'title too long' } }),
    );
    await expect(svc.publishProduct(productId)).rejects.toThrow();
    const listing = await prisma.listing.findFirstOrThrow({ where: { productId } });
    expect(listing.status).toBe('error');
    expect(listing.lastError).toBeTruthy();
  });
});
