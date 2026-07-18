// Tipos mínimos dos recursos do ML usados pelo hub. Parciais de propósito:
// só o que consumimos. Campos crus completos ficam em `raw` quando persistidos.

export interface MlUser {
  id: number;
  nickname: string;
  tags?: string[]; // contém 'user_product_seller' se a conta está no modelo UP (D8)
  site_id?: string;
}

export interface MlItemVariation {
  id: number | string;
  attribute_combinations?: { id: string; name: string; value_name?: string | null }[];
  available_quantity?: number;
  price?: number;
  seller_custom_field?: string | null; // SKU do seller
  attributes?: { id: string; value_name?: string | null }[];
}

export interface MlItem {
  id: string; // MLB...
  title: string;
  category_id: string;
  price?: number;
  available_quantity?: number;
  status?: string;
  seller_custom_field?: string | null; // SKU (item sem variação)
  family_name?: string | null; // != null => modelo User Products
  user_product_id?: string | null;
  attributes?: { id: string; value_name?: string | null }[];
  variations?: MlItemVariation[];
  pictures?: { url: string }[];
}

export interface MlSearchResult {
  seller_id?: string;
  results: string[]; // ids MLB...
  paging?: { total: number; offset?: number; limit: number };
  scroll_id?: string; // search_type=scan
}

export interface MlCategoryAttribute {
  id: string;
  name: string;
  tags?: Record<string, boolean>; // required, conditional_required, allow_variations, variation_attribute...
  value_type?: string;
  values?: { id: string; name: string }[];
}

/** Guia de tamanho (SIZE_GRID). Parcial: só o que persistimos ou usamos pra escolher entre resultados de busca. */
export interface MlSizeGridChart {
  id: number | string;
  names?: Record<string, string>;
  type?: 'BRAND' | 'STANDARD' | 'SPECIFIC';
  rows: unknown[];
}

/** Resposta de POST /catalog/charts/search — confirmado contra a conta real (§11, M6):
 *  o filtro BRAND não restringe de fato os resultados, então `charts` pode trazer guias
 *  de marcas diferentes da pedida; a escolha por nome fica por conta de quem chama. */
export interface MlSizeGridChartSearchResult {
  paging?: { total: number; offset: number; limit: number };
  charts: MlSizeGridChart[];
}

/** Sugestão de categoria a partir de texto livre (`domain_discovery`). `domain_id` já vem
 *  normalizado (sem prefixo `MLB-`) por `MlApi.suggestDomain` — ver bug §11/M6 dry run. */
export interface MlDomainSuggestion {
  domainId: string;
  domainName: string;
  categoryId: string;
  categoryName: string;
}

/** Produto do catálogo do ML (`GET /products/{id}`). Publicar vinculado a ele
 *  (`catalog_product_id` + `catalog_listing`) dispensa GTIN — identidade vem do catálogo.
 *  `domainId` já normalizado sem prefixo `MLB-` (mesmo bug de sempre). */
export interface MlCatalogProduct {
  id: string;
  status: string;
  name: string;
  domainId: string;
  brand: string | null;
  listingStrategy: string | null; // settings.listing_strategy — 'open' = aberto pra anunciar
}

export interface MlOrder {
  id: number;
  status: string;
  total_amount?: number;
  order_items: {
    item: { id: string; seller_custom_field?: string | null; variation_id?: number | null };
    quantity: number;
    unit_price: number;
  }[];
  shipping?: { id?: number };
}
