import { Injectable } from '@nestjs/common';
import { Prisma, type SizeGridChart, type SizeGridChartType } from '@prisma/client';
import { PrismaService } from '../../lib/prisma.service';
import { MlApi } from '../../ml/api/ml-api.service';
import type { MlSizeGridChart } from '../../ml/api/ml-api.types';
import { ValidationError } from '../../lib/errors';
import { buildChartPayload, buildChartSearchPayload, type ChartPayloadParams } from './size-grid-payload';

/** Entre os charts devolvidos por `/catalog/charts/search` (que não filtra por BRAND de
 *  verdade — §11, M6), escolhe o que tem a marca no nome. Ambíguo (>1 match) é erro: preferimos
 *  parar a escolher errado um guia que o comprador usa pra decidir tamanho. */
function pickMatchingChart(charts: MlSizeGridChart[], brand: string): MlSizeGridChart | undefined {
  const brandLower = brand.toLowerCase();
  const matches = charts.filter((c) =>
    Object.values(c.names ?? {}).some((name) => name.toLowerCase().includes(brandLower)),
  );
  if (matches.length > 1) {
    throw new ValidationError(
      `${matches.length} guias existentes citam "${brand}" no nome — escolha manual necessária (ids: ${matches
        .map((m) => m.id)
        .join(', ')})`,
      'brand',
    );
  }
  return matches[0];
}

@Injectable()
export class SizeGridService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mlApi: MlApi,
  ) {}

  /** Idempotente por (domain_id, brand, gender) via cache local. Na primeira chamada: busca
   *  guia existente (`/catalog/charts/search`) antes de criar (§11, M6 — "buscar antes de
   *  criar"); só cria (`POST /catalog/charts`) se a busca não achar nada com a marca no nome. */
  async ensureChart(params: ChartPayloadParams): Promise<SizeGridChart> {
    const cached = await this.prisma.sizeGridChart.findUnique({
      where: {
        domainId_brand_gender: {
          domainId: params.domainId,
          brand: params.brand,
          gender: params.genderName,
        },
      },
    });
    if (cached) return cached;

    const me = await this.mlApi.getMe();
    const searchResult = await this.mlApi.searchCharts(buildChartSearchPayload(params, String(me.id)));
    const found = pickMatchingChart(searchResult.charts ?? [], params.brand);

    const chart = found ?? (await this.mlApi.createChart(buildChartPayload(params)));

    return this.prisma.sizeGridChart.create({
      data: {
        domainId: params.domainId,
        brand: params.brand,
        gender: params.genderName,
        chartId: String(chart.id),
        chartType: (chart.type as SizeGridChartType | undefined) ?? 'SPECIFIC',
        rows: chart.rows as Prisma.InputJsonValue,
      },
    });
  }
}
