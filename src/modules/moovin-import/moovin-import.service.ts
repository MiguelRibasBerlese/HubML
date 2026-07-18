import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../lib/prisma.service';
import { withContext } from '../../lib/logger';
import { MOOVIN_SOURCE, type MoovinSource } from '../../moovin/source.interface';
import { mapMoovinProduct, type MappedMoovinProduct, type MappedMoovinVariation } from './moovin-mapper';

type PrismaTx = Prisma.TransactionClient;

export interface MoovinImportReport {
  productsFetched: number;
  productsUpserted: number;
  variationsUpserted: number;
  errors: { moovinUrn: string; message: string }[];
}

/**
 * Import do catálogo Moovin (§11.8 passo 4). Upsert idempotente por
 * moovin_urn (produto) e sku (variação) — rodar duas vezes não duplica, mesma
 * prova de conclusão do M4. Análogo a ImportService, trocando MlApi por
 * MoovinSource.
 */
@Injectable()
export class MoovinImportService {
  private readonly log = withContext({ op: 'moovin-import' });

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MOOVIN_SOURCE) private readonly source: MoovinSource,
  ) {}

  async importCatalog(): Promise<MoovinImportReport> {
    const rows = await this.source.fetchProducts();
    const products = rows.map(mapMoovinProduct);

    const report: MoovinImportReport = {
      productsFetched: products.length,
      productsUpserted: 0,
      variationsUpserted: 0,
      errors: [],
    };

    for (const p of products) {
      try {
        report.variationsUpserted += await this.upsertProduct(p);
        report.productsUpserted++;
      } catch (err) {
        report.errors.push({ moovinUrn: p.moovinUrn, message: (err as Error).message });
        this.log.error({ moovinUrn: p.moovinUrn, err: (err as Error).message }, 'falha ao importar produto Moovin');
      }
    }
    this.log.info({ ...report, errors: report.errors.length }, 'import Moovin concluído');
    return report;
  }

  private upsertProduct(mapped: MappedMoovinProduct): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.upsert({
        where: { moovinUrn: mapped.moovinUrn },
        create: {
          moovinUrn: mapped.moovinUrn,
          title: mapped.title,
          brand: mapped.brand ?? null,
          gender: mapped.gender ?? null,
          imageUrl: mapped.imageUrl ?? null,
          moovinType: mapped.moovinType ?? null,
          moovinCategoria: mapped.moovinCategoria ?? null,
        },
        update: {
          title: mapped.title,
          brand: mapped.brand ?? null,
          gender: mapped.gender ?? null,
          imageUrl: mapped.imageUrl ?? null,
          moovinType: mapped.moovinType ?? null,
          moovinCategoria: mapped.moovinCategoria ?? null,
        },
      });

      let touched = 0;
      for (const v of mapped.variations) {
        await this.upsertVariation(tx, product.id, v);
        touched++;
      }
      return touched;
    });
  }

  private async upsertVariation(tx: PrismaTx, productId: string, v: MappedMoovinVariation): Promise<void> {
    const existing = await tx.variation.findUnique({ where: { sku: v.sku } });
    if (existing) {
      await tx.variation.update({
        where: { id: existing.id },
        data: {
          priceCents: v.priceCents,
          color: v.color ?? null,
          size: v.size ?? null,
          attributes: v.attributes as Prisma.InputJsonValue,
          gtinExemptReason: v.gtinExemptReason,
        },
      });
      return;
    }
    const created = await tx.variation.create({
      data: {
        productId,
        sku: v.sku,
        priceCents: v.priceCents,
        stockOnHand: v.stockOnHand,
        color: v.color ?? null,
        size: v.size ?? null,
        attributes: v.attributes as Prisma.InputJsonValue,
        gtinExemptReason: v.gtinExemptReason,
      },
    });
    if (v.stockOnHand !== 0) {
      await tx.stockMovement.create({
        data: { variationId: created.id, delta: v.stockOnHand, reason: 'initial', balanceAfter: v.stockOnHand },
      });
    }
  }
}
