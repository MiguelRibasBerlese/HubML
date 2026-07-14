import { Injectable } from '@nestjs/common';
import { MlClient } from '../client/ml-client.service';
import type {
  MlUser,
  MlItem,
  MlSearchResult,
  MlCategoryAttribute,
  MlOrder,
} from './ml-api.types';

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

  getOrder(orderId: string): Promise<MlOrder> {
    return this.client.get<MlOrder>(`/orders/${orderId}`);
  }

  createItem(payload: unknown): Promise<MlItem> {
    return this.client.post<MlItem>('/items', payload);
  }

  updateItem(itemId: string, payload: unknown): Promise<MlItem> {
    return this.client.put<MlItem>(`/items/${itemId}`, payload);
  }

  /** Etiqueta de envio (Mercado Envios) — pdf ou zpl2. */
  getShipmentLabel(shipmentIds: string[], type: 'pdf' | 'zpl2' = 'pdf'): Promise<unknown> {
    return this.client.get('/shipment_labels', {
      query: { shipment_ids: shipmentIds.join(','), response_type: type },
    });
  }
}
