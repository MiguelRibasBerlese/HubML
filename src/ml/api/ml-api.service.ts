import { Injectable } from '@nestjs/common';
import { MlClient } from '../client/ml-client.service';
import type {
  MlUser,
  MlItem,
  MlSearchResult,
  MlCategoryAttribute,
  MlOrder,
  MlSizeGridChart,
  MlSizeGridChartSearchResult,
  MlDomainSuggestion,
  MlCatalogProduct,
} from './ml-api.types';

interface MlDomainDiscoveryResult {
  domain_id: string;
  domain_name: string;
  category_id: string;
  category_name: string;
}

// Funções tipadas por recurso. Todo acesso ao ML passa por aqui (não usar MlClient direto fora daqui).
@Injectable()
export class MlApi {
  constructor(private readonly client: MlClient) {}

  getMe(): Promise<MlUser> {
    return this.client.get<MlUser>('/users/me');
  }

  /** True se a conta está no modelo "Preço por Variação" (User Products) — D8. */
  async isUserProductSeller(): Promise<boolean> {
    const me = await this.getMe();
    return (me.tags ?? []).includes('user_product_seller');
  }

  getItem(itemId: string): Promise<MlItem> {
    return this.client.get<MlItem>(`/items/${itemId}`);
  }

  /** Multiget de itens (lotes de até 20 no ML). Retorna só os corpos que vieram 200. */
  async getItems(ids: string[]): Promise<MlItem[]> {
    const out: MlItem[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const rows = await this.client.get<{ code: number; body: MlItem }[]>('/items', {
        query: { ids: batch.join(',') },
      });
      for (const r of rows) if (r.code === 200 && r.body) out.push(r.body);
    }
    return out;
  }

  /**
   * Todos os ids de item da conta, paginando via search_type=scan (contas grandes).
   * scan usa scroll_id em vez de offset.
   */
  async searchSellerItemIds(userId: string): Promise<string[]> {
    const ids: string[] = [];
    let scrollId: string | undefined;
    for (;;) {
      const page = await this.client.get<MlSearchResult>(
        `/users/${userId}/items/search`,
        { query: { search_type: 'scan', scroll_id: scrollId, limit: 100 } },
      );
      ids.push(...page.results);
      if (!page.results.length || !page.scroll_id) break;
      scrollId = page.scroll_id;
    }
    return ids;
  }

  getCategoryAttributes(categoryId: string): Promise<MlCategoryAttribute[]> {
    return this.client.get<MlCategoryAttribute[]>(`/categories/${categoryId}/attributes`);
  }

  /** Sugestão de domain_id/category_id a partir de texto livre (título do produto).
   *  `domain_id` volta de `domain_discovery` com prefixo `MLB-`; endpoints de chart
   *  (`/catalog/charts/*`) exigem sem prefixo — normalizado aqui, na fronteira, pra
   *  nenhum chamador precisar saber do bug (§11, M6 dry run). Sem resultado => undefined. */
  async suggestDomain(query: string): Promise<MlDomainSuggestion | undefined> {
    const results = await this.client.get<MlDomainDiscoveryResult[]>(
      '/sites/MLB/domain_discovery/search',
      { query: { q: query } },
    );
    const top = results[0];
    if (!top) return undefined;
    return {
      domainId: top.domain_id.replace(/^MLB-/, ''),
      domainName: top.domain_name,
      categoryId: top.category_id,
      categoryName: top.category_name,
    };
  }

  /** Produto do catálogo do ML — base do caminho catalog_listing (marca registrada sem GTIN,
   *  achado 2026-07-18: EMPTY_GTIN_REASON só vale pra marca NÃO registrada; marca registrada
   *  exige GTIN real ou vínculo de catálogo). `domain_id` normalizado sem `MLB-` na fronteira. */
  async getCatalogProduct(productId: string): Promise<MlCatalogProduct> {
    const p = await this.client.get<{
      id: string; status: string; name: string; domain_id: string;
      attributes?: { id: string; value_name?: string | null }[];
      settings?: { listing_strategy?: string | null };
    }>(`/products/${productId}`);
    return {
      id: p.id,
      status: p.status,
      name: p.name,
      domainId: p.domain_id.replace(/^MLB-/, ''),
      brand: p.attributes?.find((a) => a.id === 'BRAND')?.value_name ?? null,
      listingStrategy: p.settings?.listing_strategy ?? null,
    };
  }

  getOrder(orderId: string): Promise<MlOrder> {
    return this.client.get<MlOrder>(`/orders/${orderId}`);
  }

  createItem(payload: unknown): Promise<MlItem> {
    return this.client.post<MlItem>('/items', payload);
  }

  updateItem(itemId: string, payload: unknown): Promise<MlItem> {
    return this.client.put<MlItem>(`/items/${itemId}`, payload);
  }

  /** Busca guias já existentes antes de criar (confirmado real e funcional — §11, M6).
   *  BRAND no filtro não restringe de fato os resultados, então quem chama precisa
   *  escolher entre os `charts` retornados (ver `pickMatchingChart` em size-grid.service.ts). */
  searchCharts(payload: unknown): Promise<MlSizeGridChartSearchResult> {
    return this.client.post<MlSizeGridChartSearchResult>('/catalog/charts/search', payload);
  }

  /** Cria um guia de tamanho (SIZE_GRID) — último recurso, só quando a busca não acha nada. */
  createChart(payload: unknown): Promise<MlSizeGridChart> {
    return this.client.post<MlSizeGridChart>('/catalog/charts', payload);
  }

  /** Etiqueta de envio (Mercado Envios) — pdf ou zpl2. */
  getShipmentLabel(shipmentIds: string[], type: 'pdf' | 'zpl2' = 'pdf'): Promise<unknown> {
    return this.client.get('/shipment_labels', {
      query: { shipment_ids: shipmentIds.join(','), response_type: type },
    });
  }
}
