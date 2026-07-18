import { describe, it, expect } from 'vitest';
import { validateForPublish, type PublishableProduct } from '../../src/modules/publishing/publish-validator';
import { buildSingleVariationPayload } from '../../src/modules/publishing/payload-builder';
import { buildAccessoryPayload, resolveAccessory, type ResolvedAccessory } from '../../src/modules/publishing/accessory';
import { buildCatalogPayload } from '../../src/modules/publishing/payload-builder';
import type { MlApi } from '../../src/ml/api/ml-api.service';
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

  it('conta UP: family_name no lugar de title (ML deriva o título; mandar title dá 400)', () => {
    const payload = buildSingleVariationPayload(base, { isUserProduct: true });
    expect(payload.family_name).toBe('Camiseta Básica');
    expect(payload.title).toBeUndefined();
  });

  it('conta legado: title normal, sem family_name', () => {
    const payload = buildSingleVariationPayload(base, { isUserProduct: false });
    expect(payload.family_name).toBeUndefined();
    expect(payload.title).toBe('Camiseta Básica');
  });
});

describe('buildAccessoryPayload', () => {
  const resolved: ResolvedAccessory = {
    categoryId: 'MLB7022',
    itemAttributes: [{ id: 'BRAND', value_name: 'LUZ DA LUA' }, { id: 'MODEL', value_name: 'RAVENA' }],
  };

  it('item-level (modelo UP): family_name + price/qty no item, condition new, sem variations', () => {
    const p = buildAccessoryPayload(resolved, { priceCents: 5000, stockOnHand: 3 }, { familyName: 'F', isUserProduct: true });
    expect(p.price).toBe(50);
    expect(p.available_quantity).toBe(3);
    expect(p.family_name).toBe('F');
    expect(p.title).toBeUndefined();
    expect(p.condition).toBe('new'); // sempre novo explícito, nunca default do ML
    expect(p.variations).toBeUndefined();
  });

  it('conta legado: title em vez de family_name', () => {
    const p = buildAccessoryPayload(resolved, { priceCents: 100, stockOnHand: 1 }, { familyName: 'F', isUserProduct: false });
    expect(p.title).toBe('F');
    expect(p.family_name).toBeUndefined();
  });
});

describe('apparel (items irmãos + size grid)', () => {
  const rows = [
    { id: '5170265:1', attributes: [{ id: 'SIZE', values: [{ name: 'PP' }] }] },
    { id: '5170265:4', attributes: [{ id: 'SIZE', values: [{ name: 'G' }] }] },
  ];

  it('rowIdForSize casa label real; sem match bloqueia', async () => {
    const { rowIdForSize } = await import('../../src/modules/publishing/apparel');
    expect(rowIdForSize(rows, 'PP')).toBe('5170265:1');
    expect(rowIdForSize(rows, 'g')).toBe('5170265:4'); // case-insensitive
    expect(() => rowIdForSize(rows, '42')).toThrow(ValidationError);
  });

  it('NÃO casa por FILTRABLE_SIZE (ML exige item SIZE = label SIZE da linha — visto real)', async () => {
    const { rowIdForSize } = await import('../../src/modules/publishing/apparel');
    const grid = [
      { id: '6558327:2', attributes: [{ id: 'SIZE', values: [{ name: '2' }] }, { id: 'FILTRABLE_SIZE', values: [{ name: 'P' }] }] },
    ];
    expect(() => rowIdForSize(grid, 'P')).toThrow(ValidationError);
    expect(rowIdForSize(grid, '2')).toBe('6558327:2');
  });

  it('sleeveFromTitle: só quando o título diz', async () => {
    const { sleeveFromTitle } = await import('../../src/modules/publishing/apparel');
    expect(sleeveFromTitle('CAMISETA X MANGA LONGA')).toBe('Longa');
    expect(sleeveFromTitle('BLUSA Y REGATA')).toBe('Sem mangas');
    expect(sleeveFromTitle('POLO Z PIQUET')).toBeNull();
  });

  it('cache com linhas de 2 guias (nominal+numeração): row id embute o chart certo', async () => {
    const { rowIdForSize } = await import('../../src/modules/publishing/apparel');
    const mixed = [...rows, { id: '4539158:3', attributes: [{ id: 'SIZE', values: [{ name: '40' }] }] }];
    expect(rowIdForSize(mixed, 'PP')).toBe('5170265:1');
    expect(rowIdForSize(mixed, '40')).toBe('4539158:3');
  });

  it('payload do irmão: family_name + SIZE/COLOR/GRID no item, sem variations', async () => {
    const { buildApparelItemPayload } = await import('../../src/modules/publishing/apparel');
    const p = buildApparelItemPayload(
      {
        categoryId: 'MLB108704', domainId: 'DRESSES', genderValueId: '339665', genderName: 'Feminino',
        baseAttributes: [{ id: 'BRAND', value_name: 'Farm' }],
      },
      { sku: '3542', color: 'PRETO', size: 'PP', priceCents: 57700, stockOnHand: 2 },
      { familyName: 'VESTIDO FARM RIO VOLUME MIDI ORIGINAL', chartId: '5170265', rowId: '5170265:1' },
    );
    expect(p.family_name).toBe('VESTIDO FARM RIO VOLUME MIDI ORIGINAL');
    expect(p.price).toBe(577);
    expect(p.variations).toBeUndefined();
    const ids = (p.attributes as { id: string }[]).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['BRAND', 'COLOR', 'SIZE', 'SIZE_GRID_ID', 'SIZE_GRID_ROW_ID', 'SELLER_SKU']));
  });

  it('sem cor/tamanho no SKU bloqueia', async () => {
    const { buildApparelItemPayload } = await import('../../src/modules/publishing/apparel');
    expect(() =>
      buildApparelItemPayload(
        { categoryId: 'C', domainId: 'D', genderValueId: 'G', genderName: 'F', baseAttributes: [] },
        { sku: 'S', color: null, size: 'PP', priceCents: 100, stockOnHand: 1 },
        { familyName: 'F', chartId: '1', rowId: '1:1' },
      ),
    ).toThrow(ValidationError);
  });
});

describe('buildChartPayload — rawRows (clonagem de medidas reais)', () => {
  it('usa rawRows verbatim + measure_type/main_attribute_id, sem BRAND no nível do chart', async () => {
    const { buildChartPayload } = await import('../../src/modules/attributes/size-grid-payload');
    const raw = [{ attributes: [{ id: 'SIZE', values: [{ name: '1' }] }, { id: 'CHEST_CIRCUMFERENCE_FROM', values: [{ name: '90 cm', struct: { number: 90, unit: 'cm' } }] }] }];
    const p = buildChartPayload({
      domainId: 'SHIRTS', brand: 'RICHARDS', genderValueId: '339666', genderName: 'Masculino',
      names: { MLB: 'CAMISAS MASCULINO' }, rows: [], rawRows: raw, measureType: 'BODY_MEASURE', mainAttributeId: 'SIZE',
    });
    expect(p.rows).toBe(raw);
    expect(p.measure_type).toBe('BODY_MEASURE');
    expect(p.main_attribute_id).toBe('SIZE');
    expect(p.domain_id).toBe('SHIRTS');
  });
});

describe('sameName', () => {
  it('ignora caixa e NBSP (U+00A0) do ML', async () => {
    const { sameName } = await import('../../src/modules/publishing/accessory');
    expect(sameName('LUZ DA LUA', 'Luz da Lua')).toBe(true);
    expect(sameName('LUZ DA LUA', 'Schutz')).toBe(false);
  });
});

describe('buildCatalogPayload', () => {
  it('catalog listing: sem family_name/title/pictures (vêm do catálogo), preço em reais, frete grátis me2', () => {
    const p = buildCatalogPayload({
      catalogProductId: 'MLB36384107', categoryId: 'MLB7022', priceCents: 118900, stockOnHand: 1, sku: '2570',
    });
    expect(p.catalog_product_id).toBe('MLB36384107');
    expect(p.catalog_listing).toBe(true);
    expect(p.price).toBe(1189);
    expect(p.condition).toBe('new');
    expect(p.family_name).toBeUndefined();
    expect(p.title).toBeUndefined();
    expect(p.pictures).toBeUndefined();
    expect(p.shipping).toEqual({ mode: 'me2', free_shipping: true, local_pick_up: false });
    expect(p.attributes).toEqual([{ id: 'SELLER_SKU', value_name: '2570' }]);
  });
});

describe('resolveAccessory — COLOR não-obrigatório', () => {
  const ml = {
    suggestDomain: async () => ({ domainId: 'HANDBAGS', categoryId: 'MLB7022' }),
    getCategoryAttributes: async () => [
      { id: 'BRAND', value_type: 'string', tags: { required: true }, values: [] },
      // COLOR NÃO é required em MLB7022 — mas é o allow_variations que faz o EMPTY_GTIN_REASON colar
      { id: 'COLOR', value_type: 'string', tags: { allow_variations: true }, values: [{ id: '52049', name: 'Preto' }] },
      { id: 'EMPTY_GTIN_REASON', value_type: 'list', tags: {}, values: [{ id: '17055160', name: 'O produto não tem código cadastrado' }] },
    ],
  } as unknown as MlApi;
  const input = {
    title: 'BOLSA LUZ DA LUA COURO RAVENA',
    brand: 'LUZ DA LUA',
    moovinType: 'BOLSA',
    moovinCategoria: null,
    variations: [{ sku: 'S1', color: 'AMÊNDOA', size: null, priceCents: 93900, stockOnHand: 1 }],
  };

  it('inclui COLOR do dado real mesmo sem ser required', async () => {
    const r = await resolveAccessory(ml, input);
    expect(r.itemAttributes).toContainEqual({ id: 'COLOR', value_name: 'AMÊNDOA' });
  });

  it('sem COR real: segue sem COLOR (nunca chuta)', async () => {
    const r = await resolveAccessory(ml, {
      ...input,
      variations: [{ ...input.variations[0]!, color: null }],
    });
    expect(r.itemAttributes.some((a) => a.id === 'COLOR')).toBe(false);
  });
});
