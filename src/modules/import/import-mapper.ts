import type { MlItem } from '../../ml/api/ml-api.types';

// Representação neutra de um produto do hub, extraída de item(ns) do ML.
export interface MappedVariation {
  sku: string;
  mlVariationId?: string; // legado multi-variação
  color?: string;
  size?: string;
  gtin?: string;
  priceCents: number;
  stockOnHand: number;
}

export interface MappedProduct {
  mlItemIds: string[]; // 1 (legado) ou N (UP: 1 item por variação da família)
  mlUserProductId?: string;
  familyName?: string;
  title: string;
  mlCategoryId: string;
  isUserProduct: boolean;
  variations: MappedVariation[];
}

function toCents(price?: number): number {
  return Math.round((price ?? 0) * 100);
}

function attr(item: MlItem, id: string): string | undefined {
  return item.attributes?.find((a) => a.id === id)?.value_name ?? undefined;
}

/** Item legado (family_name == null): 1 item pode ter array `variations`. */
export function mapLegacyItem(item: MlItem): MappedProduct {
  const variations: MappedVariation[] = (item.variations ?? []).length
    ? item.variations!.map((v) => ({
        sku: v.seller_custom_field ?? `${item.id}-${v.id}`,
        mlVariationId: String(v.id),
        color: v.attribute_combinations?.find((c) => /COLOR|COR/i.test(c.id))?.value_name ?? undefined,
        size: v.attribute_combinations?.find((c) => /SIZE|TAMANHO/i.test(c.id))?.value_name ?? undefined,
        gtin: v.attributes?.find((a) => a.id === 'GTIN')?.value_name ?? undefined,
        priceCents: toCents(v.price ?? item.price),
        stockOnHand: v.available_quantity ?? 0,
      }))
    : [
        {
          sku: item.seller_custom_field ?? item.id,
          color: attr(item, 'COLOR'),
          size: attr(item, 'SIZE'),
          gtin: attr(item, 'GTIN'),
          priceCents: toCents(item.price),
          stockOnHand: item.available_quantity ?? 0,
        },
      ];

  return {
    mlItemIds: [item.id],
    title: item.title,
    mlCategoryId: item.category_id,
    isUserProduct: false,
    variations,
  };
}

/**
 * Modelo User Products (family_name != null): cada item da família é 1 variação.
 * Recebe TODOS os itens de uma mesma família e agrupa em um product.
 */
export function mapUserProductFamily(items: MlItem[]): MappedProduct {
  const head = items[0]!;
  const variations: MappedVariation[] = items.map((it) => ({
    sku: it.seller_custom_field ?? it.id,
    color: attr(it, 'COLOR'),
    size: attr(it, 'SIZE'),
    gtin: attr(it, 'GTIN'),
    priceCents: toCents(it.price),
    stockOnHand: it.available_quantity ?? 0,
  }));

  return {
    mlItemIds: items.map((i) => i.id),
    mlUserProductId: head.user_product_id ?? undefined,
    familyName: head.family_name ?? undefined,
    title: head.title,
    mlCategoryId: head.category_id,
    isUserProduct: true,
    variations,
  };
}

/** Agrupa uma leva de itens em produtos, decidindo modelo item a item (family_name). */
export function groupItemsIntoProducts(items: MlItem[]): MappedProduct[] {
  const legacy = items.filter((i) => !i.family_name);
  const up = items.filter((i) => i.family_name);

  const products = legacy.map(mapLegacyItem);

  const families = new Map<string, MlItem[]>();
  for (const it of up) {
    const key = it.family_name!;
    (families.get(key) ?? families.set(key, []).get(key)!).push(it);
  }
  for (const group of families.values()) products.push(mapUserProductFamily(group));

  return products;
}
