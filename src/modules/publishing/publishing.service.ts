import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../lib/prisma.service';
import { MlApi } from '../../ml/api/ml-api.service';
import { withContext } from '../../lib/logger';
import { MlApiError, ValidationError } from '../../lib/errors';
import { validateForPublish, type PublishableProduct } from './publish-validator';
import { buildSingleVariationPayload, buildCatalogPayload, buildUpdatePayload } from './payload-builder';
import { ACCESSORY_MAP, resolveAccessory, buildAccessoryPayload, sameName } from './accessory';
import { APPAREL_MAP, resolveApparel, buildApparelItemPayload, rowIdForSize } from './apparel';
import { SizeGridService } from '../attributes/size-grid.service';
import type { MlItemVariation } from '../../ml/api/ml-api.types';

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
    private readonly sizeGrid: SizeGridService,
  ) {}

  /** Constrói o payload de POST /items sem enviar nada (dry-run — M-acessórios).
   *  Valida igual ao publish real, então erra/bloqueia cedo com a mesma mensagem. */
  async previewPublish(productId: string): Promise<Record<string, unknown>> {
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: { variations: true },
    });
    return this.buildCreatePayload(product);
  }

  /** Payload de POST /items. Acessório (TIPO no mapa) → resolução ao vivo + guarda-corpo +
   *  atributos por dado real + bloco variations quando o ML exige. Não-acessório → caminho legado.
   *  Bloqueia (ValidationError) se faltar dado real. */
  private async buildCreatePayload(
    product: ProductForPublish,
    catalogProductId?: string,
  ): Promise<Record<string, unknown>> {
    if (catalogProductId) return this.buildCatalogCreatePayload(product, catalogProductId);
    const publishable = toPublishable(product);
    const isUp = await this.ml.isUserProductSeller();

    if (product.moovinType && ACCESSORY_MAP[product.moovinType]) {
      const resolved = await resolveAccessory(this.ml, {
        title: product.title,
        brand: product.brand,
        moovinType: product.moovinType,
        moovinCategoria: product.moovinCategoria,
        variations: product.variations.map((v) => ({
          sku: v.sku,
          color: v.color,
          size: v.size,
          priceCents: v.priceCents,
          stockOnHand: v.stockOnHand,
        })),
      });
      publishable.mlCategoryId = resolved.categoryId; // categoria ao vivo → validateForPublish passa
      validateForPublish(publishable);
      return buildAccessoryPayload(resolved, product.variations[0]!, {
        familyName: product.title,
        isUserProduct: isUp,
        pictures: picturesFrom(product.imageUrl),
      });
    }

    validateForPublish(publishable);
    return buildSingleVariationPayload(publishable, { isUserProduct: isUp, pictures: picturesFrom(product.imageUrl) });
  }

  /** Caminho catalog_listing (marca registrada sem GTIN — achado 2026-07-18). O de-para
   *  produto↔catálogo é decisão humana (verificação por foto), passada explicitamente em
   *  `catalogProductId`; aqui só os guarda-corpos: marca e domínio do produto de catálogo
   *  têm que bater com o nosso produto — divergência bloqueia, nunca publica vínculo errado. */
  private async buildCatalogCreatePayload(
    product: ProductForPublish,
    catalogProductId: string,
  ): Promise<Record<string, unknown>> {
    if (product.variations.length !== 1) {
      throw new ValidationError('catalog listing só pra variação única — bloqueado', 'variations');
    }
    if (!product.mlCategoryId) {
      throw new ValidationError('produto sem mlCategoryId (rode resolve-categories) — bloqueado', 'mlCategoryId');
    }
    const cp = await this.ml.getCatalogProduct(catalogProductId);
    if (cp.status !== 'active') {
      throw new ValidationError(`produto de catálogo ${catalogProductId} não está active (${cp.status}) — bloqueado`, 'catalogProductId');
    }
    if (product.brand && cp.brand && !sameName(cp.brand, product.brand)) {
      throw new ValidationError(
        `marca divergente: produto "${product.brand}" vs catálogo "${cp.brand}" — bloqueado`,
        'catalogProductId',
      );
    }
    const expected = product.moovinType ? ACCESSORY_MAP[product.moovinType]?.expectedDomain : undefined;
    if (expected && cp.domainId !== expected) {
      throw new ValidationError(
        `domínio divergente: TIPO ${product.moovinType} esperava ${expected}, catálogo é ${cp.domainId} — bloqueado`,
        'catalogProductId',
      );
    }
    const v = product.variations[0]!;
    return buildCatalogPayload({
      catalogProductId,
      categoryId: product.mlCategoryId,
      priceCents: v.priceCents,
      stockOnHand: v.stockOnHand,
      sku: v.sku,
    });
  }

  async publishProduct(productId: string, catalogProductId?: string): Promise<PublishResult> {
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: { variations: true },
    });

    // Um listing por produto no caminho happy path (variação única).
    const listing = await this.prisma.listing.upsert({
      where: { id: await this.listingIdFor(productId) },
      create: { productId, status: 'pending' },
      update: {},
    });

    try {
      if (!listing.mlItemId) {
        const payload = await this.buildCreatePayload(product, catalogProductId);
        const created = await this.ml.createItem(payload);
        // Grava o id ANTES de qualquer passo seguinte (idempotência).
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { mlItemId: created.id, status: 'active', lastError: Prisma.DbNull, lastSyncedAt: new Date() },
        });
        await this.persistVariations(listing.id, product, created.variations);
        this.log.info({ productId, mlItemId: created.id }, 'anúncio criado');
        return { listingId: listing.id, mlItemId: created.id, action: 'created' };
      }

      const payload = buildUpdatePayload(toPublishable(product));
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

  /** Vestuário com SIZE_GRID (M7-vestidos): cada SKU vira um item irmão com o mesmo
   *  family_name (modelo UP — API recusa `variations` nesta conta). Chart resolvido via
   *  ensureChart (busca antes de criar) e a linha (SIZE_GRID_ROW_ID) casada pelo label real
   *  do tamanho — sem match, aquele SKU bloqueia (nunca chuta guia). Idempotente por
   *  listing (productId, variationId): irmão já criado não recria. Erro num SKU não trava
   *  os demais — cada listing carrega seu próprio status/last_error. */
  async publishApparelProduct(productId: string): Promise<{ created: string[]; skipped: string[]; failed: { sku: string; error: string }[] }> {
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id: productId },
      include: { variations: true },
    });
    if (!product.moovinType || !APPAREL_MAP[product.moovinType]) {
      throw new ValidationError(`TIPO "${product.moovinType}" não está no mapa de vestuário`, 'moovinType');
    }

    const resolved = await resolveApparel(this.ml, {
      title: product.title,
      brand: product.brand,
      gender: product.gender,
      moovinType: product.moovinType,
    });
    const chart = await this.sizeGrid.ensureChart({
      domainId: resolved.domainId,
      brand: product.brand!,
      genderValueId: resolved.genderValueId,
      genderName: resolved.genderName,
      names: { MLB: `${product.moovinType} ${product.brand}` },
      rows: [], // só usado no caminho de criar — DRESSES sem chart existente bloqueia no ML (medida corporal), como deve
    });
    const rows = (chart.rows ?? []) as unknown[];

    const created: string[] = [];
    const skipped: string[] = [];
    const failed: { sku: string; error: string }[] = [];
    // ponytail: só SKUs com estoque — irmão de estoque 0 entra quando o sync de estoque (M8) cuidar dele
    for (const v of product.variations.filter((x) => x.stockOnHand > 0)) {
      const listing = await this.prisma.listing.upsert({
        where: { id: await this.listingIdForVariation(productId, v.id) },
        create: { productId, variationId: v.id, status: 'pending' },
        update: {},
      });
      if (listing.mlItemId) {
        skipped.push(v.sku);
        continue;
      }
      try {
        // O row id embute o chart ("4539158:2") — por isso o cache pode unir linhas de
        // dois guias da mesma marca (nominal PP-GG + numeração 36-44) e o SIZE_GRID_ID
        // certo sai da linha casada, não do chartId da linha de cache (2026-07-18, COLCCI).
        const rowId = rowIdForSize(rows, v.size ?? '');
        const chartIdForItem = rowId.split(':')[0] ?? chart.chartId;
        const payload = buildApparelItemPayload(resolved, v, {
          familyName: product.title,
          chartId: chartIdForItem,
          rowId,
          pictures: picturesFrom(product.imageUrl),
        });
        const item = await this.ml.createItem(payload);
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { mlItemId: item.id, sizeGridId: chartIdForItem, status: 'active', lastError: Prisma.DbNull, lastSyncedAt: new Date() },
        });
        this.log.info({ productId, sku: v.sku, mlItemId: item.id }, 'irmão criado');
        created.push(item.id);
      } catch (err) {
        const body = err instanceof MlApiError ? err.body : { message: (err as Error).message };
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { status: 'error', lastError: body as object },
        });
        this.log.error({ productId, sku: v.sku, err: (err as Error).message }, 'falha no irmão');
        failed.push({ sku: v.sku, error: (err as Error).message });
      }
    }
    if (failed.length && !created.length && !skipped.length) {
      throw new ValidationError(`todos os SKUs falharam: ${failed.map((f) => `${f.sku}: ${f.error}`).join(' | ').slice(0, 400)}`, 'publish');
    }
    return { created, skipped, failed };
  }

  /** Id do listing existente (produto, variação) ou uuid novo p/ o upsert create. */
  private async listingIdForVariation(productId: string, variationId: string): Promise<string> {
    const existing = await this.prisma.listing.findFirst({ where: { productId, variationId } });
    return existing?.id ?? randomUUID();
  }

  /** Persiste o de-para variação nossa ↔ ml_variation_id (casa por SELLER_SKU/seller_custom_field).
   *  Item sem bloco variations não devolve `variations` — no-op. */
  private async persistVariations(
    listingId: string,
    product: ProductForPublish,
    mlVariations?: MlItemVariation[],
  ): Promise<void> {
    if (!mlVariations?.length) return;
    const bySku = new Map(product.variations.map((v) => [v.sku, v.id]));
    for (const mv of mlVariations) {
      const sku = mv.seller_custom_field ?? mv.attributes?.find((a) => a.id === 'SELLER_SKU')?.value_name ?? undefined;
      const variationId = sku ? bySku.get(sku) : undefined;
      if (!variationId) continue;
      await this.prisma.listingVariation.upsert({
        where: { listingId_variationId: { listingId, variationId } },
        create: { listingId, variationId, mlVariationId: String(mv.id) },
        update: { mlVariationId: String(mv.id) },
      });
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

type ProductForPublish = {
  title: string;
  mlCategoryId: string | null;
  brand: string | null;
  imageUrl: string | null;
  moovinType: string | null;
  moovinCategoria: string | null;
  variations: {
    id: string; sku: string; color: string | null; size: string | null;
    gtin: string | null; gtinExemptReason: string | null; priceCents: number; stockOnHand: number;
  }[];
};

// A coluna IMAGEM do xlsx Moovin empacota várias URLs separadas por " | ".
function picturesFrom(imageUrl: string | null): string[] | undefined {
  if (!imageUrl) return undefined;
  const urls = imageUrl.split('|').map((u) => u.trim()).filter(Boolean);
  return urls.length ? urls : undefined;
}

function toPublishable(product: ProductForPublish): PublishableProduct {
  return {
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
}
