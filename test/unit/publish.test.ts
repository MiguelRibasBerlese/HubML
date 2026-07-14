import { describe, it, expect } from 'vitest';
import { validateForPublish, type PublishableProduct } from '../../src/modules/publishing/publish-validator';
import { buildSingleVariationPayload } from '../../src/modules/publishing/payload-builder';
import { ValidationError } from '../../src/lib/errors';

const base: PublishableProduct = {
  title: 'Camiseta Básica',
  mlCategoryId: 'MLB31447',
  variations: [{ sku: 'SKU-1', gtin: '7891234567895', priceCents: 5000, stockOnHand: 10 }],
};

describe('validateForPublish', () => {
  it('aceita produto válido', () => {
    expect(() => validateForPublish(base)).not.toThrow();
  });

  it('rejeita título > 60 chars', () => {
    expect(() => validateForPublish({ ...base, title: 'x'.repeat(61) })).toThrow(ValidationError);
  });

  it('rejeita sem categoria', () => {
    expect(() => validateForPublish({ ...base, mlCategoryId: null })).toThrow(/categoria/);
  });

  it('rejeita GTIN inválido', () => {
    expect(() =>
      validateForPublish({ ...base, variations: [{ ...base.variations[0]!, gtin: '1234567890123' }] }),
    ).toThrow(/GTIN/);
  });

  it('rejeita sem GTIN e sem isenção', () => {
    expect(() =>
      validateForPublish({ ...base, variations: [{ sku: 'S', priceCents: 100, stockOnHand: 1 }] }),
    ).toThrow(/isenção/);
  });

  it('aceita isenção explícita de GTIN', () => {
    expect(() =>
      validateForPublish({
        ...base,
        variations: [{ sku: 'S', priceCents: 100, stockOnHand: 1, gtinExemptReason: 'Produto artesanal' }],
      }),
    ).not.toThrow();
  });
});

describe('buildSingleVariationPayload', () => {
  it('monta payload com preço em reais e GTIN como atributo', () => {
    const payload = buildSingleVariationPayload(base, { isUserProduct: true });
    expect(payload.price).toBe(50); // 5000 centavos
    expect(payload.available_quantity).toBe(10);
    expect(payload.category_id).toBe('MLB31447');
    expect(payload.attributes).toEqual([{ id: 'GTIN', value_name: '7891234567895' }]);
  });

  it('usa EMPTY_GTIN_REASON quando isento', () => {
    const p: PublishableProduct = {
      ...base,
      variations: [{ sku: 'S', priceCents: 100, stockOnHand: 1, gtinExemptReason: 'Produto artesanal' }],
    };
    const payload = buildSingleVariationPayload(p, { isUserProduct: false });
    expect(payload.attributes).toEqual([{ id: 'EMPTY_GTIN_REASON', value_name: 'Produto artesanal' }]);
  });
});
