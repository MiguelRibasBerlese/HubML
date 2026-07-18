import { describe, it, expect } from 'vitest';
import {
  buildChartPayload,
  buildChartSearchPayload,
  type ChartPayloadParams,
} from '../../src/modules/attributes/size-grid-payload';
import { ValidationError } from '../../src/lib/errors';

const base: ChartPayloadParams = {
  domainId: 'DRESSES',
  brand: 'FARM',
  genderValueId: '339665',
  genderName: 'Feminino',
  names: { MLB: 'Guia de tamanho Vestidos FARM' },
  rows: [{ size: 'PP' }, { size: 'P' }, { size: 'M' }, { size: 'G' }],
};

describe('buildChartPayload', () => {
  it('monta domain_id, site_id e atributos de classificação (BRAND + GENDER)', () => {
    const payload = buildChartPayload(base);
    expect(payload.domain_id).toBe('DRESSES');
    expect(payload.site_id).toBe('MLB');
    expect(payload.attributes).toEqual([
      { id: 'BRAND', values: [{ name: 'FARM' }] },
      { id: 'GENDER', values: [{ id: '339665', name: 'Feminino' }] },
    ]);
    expect(payload.main_attribute).toEqual({ attributes: [{ site_id: 'MLB', id: 'SIZE' }] });
  });

  it('gera uma linha por tamanho, com SIZE como atributo (values, sem id — confirmado contra chart real 5170265)', () => {
    const payload = buildChartPayload(base) as { rows: { attributes: unknown[] }[] };
    expect(payload.rows).toHaveLength(4);
    expect(payload.rows[0]!.attributes).toEqual([
      { site_id: 'MLB', id: 'SIZE', values: [{ name: 'PP' }] },
    ]);
  });

  it('inclui MANUFACTURER_SIZE só quando informado', () => {
    const payload = buildChartPayload({
      ...base,
      rows: [{ size: 'P', manufacturerSize: '3' }],
    }) as { rows: { attributes: unknown[] }[] };
    expect(payload.rows[0]!.attributes).toEqual([
      { site_id: 'MLB', id: 'SIZE', values: [{ name: 'P' }] },
      { site_id: 'MLB', id: 'MANUFACTURER_SIZE', values: [{ name: '3' }] },
    ]);
  });

  it('rejeita guia sem linhas', () => {
    expect(() => buildChartPayload({ ...base, rows: [] })).toThrow(ValidationError);
  });
});

describe('buildChartSearchPayload', () => {
  it('monta domain_id, site_id, seller_id e filtros GENDER + BRAND', () => {
    const payload = buildChartSearchPayload(base, '3153970621');
    expect(payload).toEqual({
      domain_id: 'DRESSES',
      site_id: 'MLB',
      seller_id: '3153970621',
      attributes: [
        { id: 'GENDER', values: [{ id: '339665', name: 'Feminino' }] },
        { id: 'BRAND', values: [{ name: 'FARM' }] },
      ],
    });
  });
});
