import { describe, it, expect, vi } from 'vitest';
import { SizeGridService } from '../../src/modules/attributes/size-grid.service';
import { ValidationError } from '../../src/lib/errors';
import type { PrismaService } from '../../src/lib/prisma.service';
import type { MlApi } from '../../src/ml/api/ml-api.service';
import type { ChartPayloadParams } from '../../src/modules/attributes/size-grid-payload';

const params: ChartPayloadParams = {
  domainId: 'DRESSES',
  brand: 'FARM',
  genderValueId: '339665',
  genderName: 'Feminino',
  names: { MLB: 'Guia FARM Vestidos' },
  rows: [{ size: 'PP' }],
};

function makePrisma(findUnique: unknown = null) {
  const create = vi.fn().mockImplementation(({ data }: { data: unknown }) =>
    Promise.resolve({ id: 'local-id', ...(data as object) }),
  );
  return {
    prisma: { sizeGridChart: { findUnique: vi.fn().mockResolvedValue(findUnique), create } } as unknown as PrismaService,
    create,
  };
}

function makeMlApi(overrides: Partial<Record<'getMe' | 'searchCharts' | 'createChart', unknown>> = {}) {
  return {
    getMe: vi.fn().mockResolvedValue({ id: 3153970621 }),
    searchCharts: vi.fn().mockResolvedValue({ charts: [] }),
    createChart: vi.fn(),
    ...overrides,
  } as unknown as MlApi;
}

describe('SizeGridService.ensureChart', () => {
  it('reusa o cache local sem chamar o ML', async () => {
    const cached = { id: 'cached-1', chartId: '999' };
    const { prisma } = makePrisma(cached);
    const mlApi = makeMlApi();
    const service = new SizeGridService(prisma, mlApi);

    const out = await service.ensureChart(params);

    expect(out).toBe(cached);
    expect(mlApi.searchCharts).not.toHaveBeenCalled();
  });

  it('reusa guia existente cujo nome cita a marca, sem criar (§11, M6: buscar antes de criar)', async () => {
    const { prisma, create } = makePrisma();
    const mlApi = makeMlApi({
      searchCharts: vi.fn().mockResolvedValue({
        charts: [
          { id: '4537790', names: { MLB: 'Vestidos' }, type: 'SPECIFIC', rows: [] },
          { id: '5170265', names: { MLB: 'VESTIDOS FARM' }, type: 'SPECIFIC', rows: [{ id: '5170265:1' }] },
        ],
      }),
    });
    const service = new SizeGridService(prisma, mlApi);

    await service.ensureChart(params);

    expect(mlApi.createChart).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ chartId: '5170265', chartType: 'SPECIFIC' }) }),
    );
  });

  it('cria quando a busca não acha guia com a marca no nome', async () => {
    const { prisma } = makePrisma();
    const mlApi = makeMlApi({
      searchCharts: vi.fn().mockResolvedValue({ charts: [{ id: '1', names: { MLB: 'Vestidos' }, rows: [] }] }),
      createChart: vi.fn().mockResolvedValue({ id: 'new-1', rows: [] }),
    });
    const service = new SizeGridService(prisma, mlApi);

    await service.ensureChart(params);

    expect(mlApi.createChart).toHaveBeenCalledTimes(1);
  });

  it('rejeita quando mais de um guia existente cita a marca (ambíguo — não escolhe sozinho)', async () => {
    const { prisma } = makePrisma();
    const mlApi = makeMlApi({
      searchCharts: vi.fn().mockResolvedValue({
        charts: [
          { id: 'a', names: { MLB: 'FARM Vestidos' }, rows: [] },
          { id: 'b', names: { MLB: 'Vestidos FARM Numeração' }, rows: [] },
        ],
      }),
    });
    const service = new SizeGridService(prisma, mlApi);

    await expect(service.ensureChart(params)).rejects.toBeInstanceOf(ValidationError);
    expect(mlApi.createChart).not.toHaveBeenCalled();
  });
});
