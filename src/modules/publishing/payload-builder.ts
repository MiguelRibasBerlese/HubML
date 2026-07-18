import type { PublishableProduct, PublishableVariation } from './publish-validator';

// Monta o payload de POST /items para produto de VARIAÇÃO ÚNICA (M5.2).
// No modelo UP e no legado de variação única, o item vai sem bloco `variations`.
// (Multi-variação legado e famílias UP entram no M7.)

export interface ItemAttribute {
  id: string;
  value_id?: string;
  value_name?: string;
}

export interface BuildOptions {
  isUserProduct: boolean;
  condition?: 'new' | 'used';
  listingTypeId?: string; // ex 'gold_special'
  currencyId?: string; // ex 'BRL'
  pictures?: string[];
  categoryOverride?: string; // categoria resolvida ao vivo (acessórios) — vence p.mlCategoryId
  extraAttributes?: ItemAttribute[]; // BRAND/MODEL/GENDER etc. resolvidos por dado real
}

export function buildSingleVariationPayload(
  p: PublishableProduct,
  opts: BuildOptions,
): Record<string, unknown> {
  const v = p.variations[0]!;
  const payload: Record<string, unknown> = {
    category_id: opts.categoryOverride ?? p.mlCategoryId,
    price: p.variations[0]!.priceCents / 100,
    currency_id: opts.currencyId ?? 'BRL',
    available_quantity: v.stockOnHand,
    buying_mode: 'buy_it_now',
    condition: opts.condition ?? 'new',
    listing_type_id: opts.listingTypeId ?? 'gold_special',
    attributes: [...buildGtinAttributes(v), ...(opts.extraAttributes ?? [])],
  };
  // Conta user_product_seller (User Products): o título é derivado de family_name +
  // atributos, então mandar `title` dá 400 body.invalid_fields:[title] (achado 2026-07-17).
  // Conta legado: usa `title` normal, sem family_name.
  if (opts.isUserProduct) {
    payload.family_name = p.title;
  } else {
    payload.title = p.title;
  }
  if (opts.pictures?.length) {
    payload.pictures = opts.pictures.map((url) => ({ source: url }));
  }
  return payload;
}

/** GTIN ou isenção explícita como atributos do ML. */
function buildGtinAttributes(v: PublishableVariation): { id: string; value_name: string }[] {
  if (v.gtin) return [{ id: 'GTIN', value_name: v.gtin }];
  if (v.gtinExemptReason) return [{ id: 'EMPTY_GTIN_REASON', value_name: gtinExemptReasonValue(v.gtinExemptReason) }];
  return [];
}

// O import guarda só o marcador 'EMPTY_GTIN_REASON'; o ML exige um dos motivos válidos
// da categoria. "não tem código cadastrado" é o verdadeiro (Moovin confirmou GTIN inexistente).
// ponytail: valor único válido nas categorias de acessório; se um domínio novo recusar, virar lookup por categoria.
function gtinExemptReasonValue(stored: string): string {
  return stored === 'EMPTY_GTIN_REASON' ? 'O produto não tem código cadastrado' : stored;
}

/** Payload de POST /items vinculado ao catálogo do ML (achado 2026-07-18): pra marca
 *  REGISTRADA no ML, EMPTY_GTIN_REASON não vale — o caminho sem GTIN é catalog_listing.
 *  Título/fotos/atributos vêm do produto de catálogo; daqui só vai o comercial
 *  (preço/estoque/envio) + SELLER_SKU. Validado real com /items/validate → 204. */
export function buildCatalogPayload(p: {
  catalogProductId: string;
  categoryId: string;
  priceCents: number;
  stockOnHand: number;
  sku: string;
}): Record<string, unknown> {
  return {
    category_id: p.categoryId,
    catalog_product_id: p.catalogProductId,
    catalog_listing: true,
    price: p.priceCents / 100,
    currency_id: 'BRL',
    available_quantity: p.stockOnHand,
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: 'gold_pro',
    // >R$79 o ML exige frete grátis; me2 = modo logístico da conta (D8).
    shipping: { mode: 'me2', free_shipping: true, local_pick_up: false },
    attributes: [{ id: 'SELLER_SKU', value_name: p.sku }],
  };
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
