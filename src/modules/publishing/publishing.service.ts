import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../lib/prisma.service';
import { MlApi } from '../../ml/api/ml-api.service';
import { withContext } from '../../lib/logger';
import { MlApiError } from '../../lib/errors';
import { validateForPublish, type PublishableProduct } from './publish-validator';
import { buildSingleVariationPayload, buildUpdatePayload } from './payload-builder';

export interface PublishResult {
  listingId: string;
  mlItemId: string;
  action: 'created' | 'updated';
}

/**
 * Publicador idempotente (M5.3). Consulta `listing` antes:
 *  - sem ml_item_id  → POST /items e grava o id na MESMA transação do resultado;
 *  - com ml_item_id  → PUT.
 * Erro de validação do ML → status=error + last_error legível (reprocessável).
 * Duplo enqueue não duplica anúncio (o listing carrega o ml_item_id).
 */
@Injectable()
export class PublishingService {
  private readonly log = withContext({ op: 'publishing' });

  constructor(
    private readonly prisma: PrismaService,
    private readonly ml: MlApi,
  ) {}

  async publishProduct(productId: string): Promise<PublishResult> {
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: { variations: true },
    });

    const publishable: PublishableProduct = {
      title: product.title,
      mlCategoryId: product.mlCategoryId,
      variations: product.variations.map((v) => ({
        sku: v.sku,
        gtin: v.gtin,
        gtinExemptReason: v.gtinExemptReason,
        priceCents: v.priceCents,
        stockOnHand: v.stockOnHand,
      })),
    };
    validateForPublish(publishable);

    // Um listing por produto no caminho happy path (variação única).
    const listing = await this.prisma.listing.upsert({
      where: { id: await this.listingIdFor(productId) },
      create: { productId, status: 'pending' },
      update: {},
    });

    try {
      if (!listing.mlItemId) {
        const isUp = await this.ml.isUserProductSeller();
        const payload = buildSingleVariationPayload(publishable, { isUserProduct: isUp });
        const created = await this.ml.createItem(payload);
        // Grava o id ANTES de qualquer passo seguinte (idempotência).
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { mlItemId: created.id, status: 'active', lastError: Prisma.DbNull, lastSyncedAt: new Date() },
        });
        this.log.info({ productId, mlItemId: created.id }, 'anúncio criado');
        return { listingId: listing.id, mlItemId: created.id, action: 'created' };
      }

      const payload = buildUpdatePayload(publishable);
      await this.ml.updateItem(listing.mlItemId, payload);
      await this.prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'active', lastSyncedAt: new Date() },
      });
      this.log.info({ productId, mlItemId: listing.mlItemId }, 'anúncio atualizado');
      return { listingId: listing.id, mlItemId: listing.mlItemId, action: 'updated' };
    } catch (err) {
      const body = err instanceof MlApiError ? err.body : { message: (err as Error).message };
      await this.prisma.listing.update({
        where: { id: listing.id },
        data: { status: 'error', lastError: body as object },
      });
      this.log.error({ productId, err: (err as Error).message }, 'falha na publicação');
      throw err;
    }
  }

  /** Id do listing existente do produto (variação única) ou um uuid novo p/ o upsert create. */
  private async listingIdFor(productId: string): Promise<string> {
    const existing = await this.prisma.listing.findFirst({
      where: { productId, variationId: null },
      orderBy: { createdAt: 'asc' },
    });
    return existing?.id ?? randomUUID();
  }
}
