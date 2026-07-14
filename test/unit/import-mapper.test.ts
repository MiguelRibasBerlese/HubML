import { describe, it, expect } from 'vitest';
import { groupItemsIntoProducts } from '../../src/modules/import/import-mapper';
import type { MlItem } from '../../src/ml/api/ml-api.types';

describe('groupItemsIntoProducts', () => {
  it('mapeia item legado multi-variação em 1 product + N variations', () => {
    const item: MlItem = {
      id: 'MLB1',
      title: 'Camiseta',
      category_id: 'MLB31447',
      price: 50,
      family_name: null,
      variations: [
        { id: 10, seller_custom_field: 'SKU-P', available_quantity: 3, price: 50, attribute_combinations: [{ id: 'SIZE', name: 'Tam', value_name: 'P' }] },
        { id: 11, seller_custom_field: 'SKU-M', available_quantity: 5, price: 50, attribute_combinations: [{ id: 'SIZE', name: 'Tam', value_name: 'M' }] },
      ],
    };
    const [product] = groupItemsIntoProducts([item]);
    expect(product!.isUserProduct).toBe(false);
    expect(product!.mlItemIds).toEqual(['MLB1']);
    expect(product!.variations).toHaveLength(2);
    expect(product!.variations.map((v) => v.sku)).toEqual(['SKU-P', 'SKU-M']);
    expect(product!.variations[0]!.stockOnHand).toBe(3);
  });

  it('agrupa itens User Products da mesma família em 1 product', () => {
    const items: MlItem[] = [
      { id: 'MLB100', title: 'Tênis', category_id: 'MLB1276', price: 200, family_name: 'FAM-TENIS', user_product_id: 'MLBU1', seller_custom_field: 'TEN-38', available_quantity: 2 },
      { id: 'MLB101', title: 'Tênis', category_id: 'MLB1276', price: 200, family_name: 'FAM-TENIS', user_product_id: 'MLBU1', seller_custom_field: 'TEN-39', available_quantity: 4 },
    ];
    const products = groupItemsIntoProducts(items);
    expect(products).toHaveLength(1);
    expect(products[0]!.isUserProduct).toBe(true);
    expect(products[0]!.mlItemIds).toEqual(['MLB100', 'MLB101']);
    expect(products[0]!.familyName).toBe('FAM-TENIS');
    expect(products[0]!.variations).toHaveLength(2);
  });

  it('converte preço para centavos', () => {
    const item: MlItem = { id: 'MLB2', title: 'X', category_id: 'C', price: 19.9, family_name: null, seller_custom_field: 'A', available_quantity: 1 };
    const [p] = groupItemsIntoProducts([item]);
    expect(p!.variations[0]!.priceCents).toBe(1990);
  });
});
