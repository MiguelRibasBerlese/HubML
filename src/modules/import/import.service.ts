import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../lib/prisma.service';
import { MlApi } from '../../ml/api/ml-api.service';
import { withContext } from '../../lib/logger';
import { groupItemsIntoProducts, type MappedProduct, type MappedVariation } from './import-mapper';

export interface ImportReport {
  itemsFetched: number;
  productsUpserted: number;
  variationsUpserted: number;
  errors: { mlItemId: string; message: string }[];
}

type PrismaTx = Prisma.TransactionClient;

/**
 * Import da conta ML (M4). Varre itens (scan) → multiget → agrupa por modelo →
 * upsert idempotente por ml_item_id + SKU. Estoque/preço do ML viram verdade
 * inicial (movimento `initial` no ledger só quando a variação é criada). Re-executar é no-op.
 */
@Injectable()
export class ImportService {
  private readonly log = withContext({ op: 'import' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly ml: MlApi,
  ) {}

  async importAccount(): Promise<ImportReport> {
    const me = await this.ml.getMe();
    const ids = await this.ml.searchSellerItemIds(String(me.id));
    this.log.info({ count: ids.length }, 'itens da conta encontrados');

    const items = await this.ml.getItems(ids);
    const products = groupItemsIntoProducts(items);

    const report: ImportReport = {
      itemsFetched: items.length,
      productsUpserted: 0,
      variationsUpserted: 0,
      errors: [],
    };

    for (const p of products) {
      try {
        report.variationsUpserted += await this.upsertProduct(p);
        report.productsUpserted++;
      } catch (err) {
        report.errors.push({ mlItemId: p.mlItemIds[0] ?? '?', message: (err as Error).message });
        this.log.error({ mlItemIds: p.mlItemIds, err: (err as Error).message }, 'falha ao importar');
      }
    }
    this.log.info({ ...report, errors: report.errors.length }, 'import concluído');
    return report;
  }

  /** Upsert de um produto mapeado numa única transação. Retorna nº de variações tocadas. */
  private upsertProduct(mapped: MappedProduct): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.listing.findFirst({ where: { mlItemId: { in: mapped.mlItemIds } } });
      const product = existing
        ? await tx.product.update({
            where: { id: existing.productId },
            data: { title: mapped.title, mlCategoryId: mapped.mlCategoryId },
          })
        : await tx.product.create({ data: { title: mapped.title, mlCategoryId: mapped.mlCategoryId } });

      let touched = 0;
      for (const [idx, v] of mapped.variations.entries()) {
        const variationId = await this.upsertVariation(tx, product.id, v);
        await this.upsertListing(tx, mapped, product.id, idx, variationId);
        touched++;
      }
      return touched;
    });
  }

  /** Cria (com movimento initial) ou atualiza a variação. Não re-inicializa estoque existente. */
  private async upsertVariation(tx: PrismaTx, productId: string, v: MappedVariation): Promise<string> {
    const existing = await tx.variation.findUnique({ where: { sku: v.sku } });
    if (existing) {
      await tx.variation.update({
        where: { id: existing.id },
        data: { priceCents: v.priceCents, color: v.color ?? null, size: v.size ?? null, gtin: v.gtin ?? null },
      });
      return existing.id;
    }
    const created = await tx.variation.create({
      data: {
        productId,
        sku: v.sku,
        priceCents: v.priceCents,
        stockOnHand: v.stockOnHand, // verdade inicial do ML
        color: v.color ?? null,
        size: v.size ?? null,
        gtin: v.gtin ?? null,
      },
    });
    if (v.stockOnHand !== 0) {
      await tx.stockMovement.create({
        data: { variationId: created.id, delta: v.stockOnHand, reason: 'initial', balanceAfter: v.stockOnHand },
      });
    }
    return created.id;
  }

  private async upsertListing(
    tx: PrismaTx,
    mapped: MappedProduct,
    productId: string,
    idx: number,
    variationId: string,
  ): Promise<void> {
    if (mapped.isUserProduct) {
      const mlItemId = mapped.mlItemIds[idx];
      if (!mlItemId) return;
      await tx.listing.upsert({
        where: { mlItemId },
        create: {
          productId,
          variationId,
          mlItemId,
          mlUserProductId: mapped.mlUserProductId ?? null,
          familyName: mapped.familyName ?? null,
          status: 'active',
        },
        update: { status: 'active', familyName: mapped.familyName ?? null },
      });
      return;
    }
    // Legado: 1 listing por produto (item multi-variação). Registrado no idx 0.
    if (idx !== 0) {
      // Vincula variação ↔ ml_variation_id no listing legado, se houver.
      const listing = await tx.listing.findFirst({ where: { mlItemId: mapped.mlItemIds[0]! } });
      const mlVarId = mapped.variations[idx]?.mlVariationId;
      if (listing && mlVarId) {
        await tx.listingVariation.upsert({
          where: { listingId_variationId: { listingId: listing.id, variationId } },
          create: { listingId: listing.id, variationId, mlVariationId: mlVarId },
          update: { mlVariationId: mlVarId },
        });
      }
      return;
    }
    const mlItemId = mapped.mlItemIds[0]!;
    const listing = await tx.listing.upsert({
      where: { mlItemId },
      create: { productId, mlItemId, status: 'active' },
      update: { status: 'active' },
    });
    // idx 0 do legado também pode ter ml_variation_id.
    const mlVarId = mapped.variations[0]?.mlVariationId;
    if (mlVarId) {
      await tx.listingVariation.upsert({
        where: { listingId_variationId: { listingId: listing.id, variationId } },
        create: { listingId: listing.id, variationId, mlVariationId: mlVarId },
        update: { mlVariationId: mlVarId },
      });
    }
  }
}
