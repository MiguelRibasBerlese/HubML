import type { PublishableProduct, PublishableVariation } from './publish-validator';

// Monta o payload de POST /items para produto de VARIAÇÃO ÚNICA (M5.2).
// No modelo UP e no legado de variação única, o item vai sem bloco `variations`.
// (Multi-variação legado e famílias UP entram no M7.)

export interface BuildOptions {
  isUserProduct: boolean;
  condition?: 'new' | 'used';
  listingTypeId?: string; // ex 'gold_special'
  currencyId?: string; // ex 'BRL'
  pictures?: string[];
}

export function buildSingleVariationPayload(
  p: PublishableProduct,
  opts: BuildOptions,
): Record<string, unknown> {
  const v = p.variations[0]!;
  const payload: Record<string, unknown> = {
    title: p.title,
    category_id: p.mlCategoryId,
    price: p.variations[0]!.priceCents / 100,
    currency_id: opts.currencyId ?? 'BRL',
    available_quantity: v.stockOnHand,
    buying_mode: 'buy_it_now',
    condition: opts.condition ?? 'new',
    listing_type_id: opts.listingTypeId ?? 'gold_special',
    attributes: buildGtinAttributes(v),
  };
  if (opts.pictures?.length) {
    payload.pictures = opts.pictures.map((url) => ({ source: url }));
  }
  return payload;
}

/** GTIN ou isenção explícita como atributos do ML. */
function buildGtinAttributes(v: PublishableVariation): { id: string; value_name: string }[] {
  if (v.gtin) return [{ id: 'GTIN', value_name: v.gtin }];
  if (v.gtinExemptReason) return [{ id: 'EMPTY_GTIN_REASON', value_name: v.gtinExemptReason }];
  return [];
}

// Payload de PUT /items — só campos mutáveis (preço, estoque, título, pictures).
export function buildUpdatePayload(p: PublishableProduct): Record<string, unknown> {
  const v = p.variations[0]!;
  return {
    title: p.title,
    price: v.priceCents / 100,
    available_quantity: v.stockOnHand,
  };
}
