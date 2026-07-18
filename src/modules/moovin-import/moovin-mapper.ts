import type { MoovinProductRow } from '../../moovin/source.interface';
import { normalizeSize } from './size-normalizer';

export interface MappedMoovinVariation {
  sku: string;
  color?: string;
  size?: string;
  attributes: Record<string, unknown>;
  gtinExemptReason: string;
  priceCents: number;
  stockOnHand: number;
}

export interface MappedMoovinProduct {
  moovinUrn: string;
  title: string;
  brand?: string;
  gender?: string;
  imageUrl?: string;
  moovinType?: string;
  moovinCategoria?: string;
  variations: MappedMoovinVariation[];
}

/**
 * A dedupe + agrupamento por URN já vem pronta nas abas PRODUTOS/VARIACOES do
 * catálogo "preparado para o ML" (ver PLAN.md §11.2/§11.8 passo 4 — o export
 * bruto original que §11.3 previa não é o formato real entregue). O mapper só
 * normaliza tamanho e marca GTIN como isento (100% vazio/inválido na Moovin,
 * confirmado com o suporte deles).
 */
export function mapMoovinProduct(row: MoovinProductRow): MappedMoovinProduct {
  return {
    moovinUrn: row.urn,
    title: row.name,
    brand: row.brand ?? undefined,
    gender: row.gender ?? undefined,
    imageUrl: row.image ?? undefined,
    moovinType: row.type ?? undefined,
    moovinCategoria: row.categoria ?? undefined,
    variations: row.variations.map((v) => {
      const normalized = v.size ? normalizeSize(v.size, row.brand ?? undefined) : undefined;
      return {
        sku: v.sku,
        color: v.color ?? undefined,
        size: normalized?.original,
        attributes: normalized ? { normalizedSize: normalized } : {},
        // GTIN da Moovin é 100% inválido/vazio (86% = SKU duplicado, 14% vazio) —
        // suporte da Moovin confirmou que isento é o caminho certo (PLAN.md §11.2).
        gtinExemptReason: 'EMPTY_GTIN_REASON',
        priceCents: v.priceListCents,
        stockOnHand: v.stock,
      };
    }),
  };
}
