import { MlApi } from '../../ml/api/ml-api.service';
import { ValidationError } from '../../lib/errors';
import { resolveOpen, sameName } from './accessory';
import type { ItemAttribute } from './payload-builder';

/**
 * Vestuário com SIZE_GRID (M7-vestidos, 2026-07-18). Modelo UP: cada SKU (cor+tamanho) vira
 * um item irmão com o MESMO family_name — o ML agrupa em família (sem array `variations`,
 * que a API recusa nesta conta; os vestidos legados com variations são herança da tela).
 * Provado via /items/validate: FARM/DRESSES não exige GTIN; exige SIZE_GRID_ID +
 * SIZE_GRID_ROW_ID por item (linha do chart casada pelo label do tamanho).
 * Só entra TIPO aprovado — mesma régua do ACCESSORY_MAP.
 */
export interface ApparelMapEntry {
  queryPhrase: string;
  expectedDomain: string;
}
export const APPAREL_MAP: Record<string, ApparelMapEntry> = {
  VESTIDO: { queryPhrase: 'vestido feminino', expectedDomain: 'DRESSES' },
};

/** Linhas do chart como vêm do `/catalog/charts/search` (persistidas em size_grid_chart.rows). */
interface ChartRow {
  id: number | string;
  attributes?: { id: string; values?: { name?: string | null }[] }[];
}

/** row_id da linha cujo SIZE casa com o tamanho real da variação. Sem match → bloqueia
 *  (guia de tamanho errada é exatamente o erro que originou este projeto). */
export function rowIdForSize(rows: unknown[], size: string): string {
  for (const row of rows as ChartRow[]) {
    const rowSize = row.attributes?.find((a) => a.id === 'SIZE')?.values?.[0]?.name;
    if (rowSize && sameName(rowSize, size)) return String(row.id);
  }
  throw new ValidationError(`tamanho "${size}" não tem linha no guia (linhas: ${(rows as ChartRow[])
    .map((r) => r.attributes?.find((a) => a.id === 'SIZE')?.values?.[0]?.name)
    .filter(Boolean)
    .join(', ')}) — bloqueado`, 'SIZE_GRID_ROW_ID');
}

export interface ApparelProductInput {
  title: string;
  brand: string | null;
  gender: string | null;
  moovinType: string | null;
}
export interface ApparelVariationInput {
  sku: string;
  color: string | null;
  size: string | null;
}
export interface ResolvedApparel {
  categoryId: string;
  domainId: string;
  genderValueId: string;
  genderName: string;
  /** atributos comuns a todos os irmãos (BRAND/MODEL/GENDER) — SIZE/COLOR/ROW são por item */
  baseAttributes: ItemAttribute[];
}

/** Resolve categoria (discovery + guarda-corpo) e atributos comuns por dado real.
 *  Igual ao acessório: qualquer obrigatório sem fonte real → bloqueia, nunca chuta. */
export async function resolveApparel(ml: MlApi, p: ApparelProductInput): Promise<ResolvedApparel> {
  const entry = p.moovinType ? APPAREL_MAP[p.moovinType] : undefined;
  if (!entry) throw new ValidationError(`TIPO "${p.moovinType}" não está no mapa de vestuário`, 'moovinType');
  if (!p.brand) throw new ValidationError('produto sem marca — bloqueado', 'brand');
  if (!p.gender) throw new ValidationError('produto sem gênero — bloqueado (guia de tamanho é por gênero)', 'gender');

  const query = `${entry.queryPhrase} ${p.brand}`;
  const suggestion = await ml.suggestDomain(query);
  if (!suggestion) throw new ValidationError(`domain_discovery não achou domínio para "${query}"`, 'category');
  if (suggestion.domainId !== entry.expectedDomain) {
    throw new ValidationError(
      `categoria divergente: TIPO ${p.moovinType} esperava ${entry.expectedDomain}, discovery devolveu ${suggestion.domainId} — bloqueado`,
      'category',
    );
  }

  const defs = await ml.getCategoryAttributes(suggestion.categoryId);
  const brandDef = defs.find((d) => d.id === 'BRAND');
  const genderDef = defs.find((d) => d.id === 'GENDER');
  if (!brandDef || !genderDef) throw new ValidationError('categoria sem BRAND/GENDER nos atributos — inesperado', 'category');

  const brandAttr = resolveOpen(brandDef, p.brand, 'MARCA');
  const genderAttr = resolveOpen(genderDef, p.gender, 'gender');
  if (!genderAttr.value_id) {
    // GENDER é lista fechada em DRESSES; sem value_id o chart search/create não funciona.
    throw new ValidationError(`GENDER "${p.gender}" sem value_id na categoria ${suggestion.categoryId} — bloqueado`, 'GENDER');
  }

  return {
    categoryId: suggestion.categoryId,
    domainId: suggestion.domainId,
    genderValueId: genderAttr.value_id,
    genderName: genderAttr.value_name ?? p.gender,
    baseAttributes: [brandAttr, { id: 'MODEL', value_name: modelFrom(p) }, genderAttr],
  };
}

/** Payload de POST /items de UM irmão (1 SKU). condition new explícito, sem dimensões. */
export function buildApparelItemPayload(
  resolved: ResolvedApparel,
  v: ApparelVariationInput & { priceCents: number; stockOnHand: number },
  opts: { familyName: string; chartId: string; rowId: string; pictures?: string[] },
): Record<string, unknown> {
  if (!v.color || !v.size) throw new ValidationError(`SKU ${v.sku} sem cor/tamanho — bloqueado`, 'variation');
  const body: Record<string, unknown> = {
    family_name: opts.familyName,
    category_id: resolved.categoryId,
    price: v.priceCents / 100,
    available_quantity: v.stockOnHand,
    currency_id: 'BRL',
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: 'gold_pro',
    // >R$79 frete grátis é mandatório; me2 = modo da conta (D8).
    shipping: { mode: 'me2', free_shipping: true, local_pick_up: false },
    attributes: [
      ...resolved.baseAttributes,
      { id: 'COLOR', value_name: v.color },
      { id: 'SIZE', value_name: v.size },
      { id: 'SIZE_GRID_ID', value_name: opts.chartId },
      { id: 'SIZE_GRID_ROW_ID', value_name: opts.rowId },
      { id: 'SELLER_SKU', value_name: v.sku },
    ],
  };
  if (opts.pictures?.length) body.pictures = opts.pictures.map((source) => ({ source }));
  return body;
}

/** MODEL = título sem a marca e sem a palavra do tipo (mesma estratégia title-minus-brand). */
function modelFrom(p: ApparelProductInput): string {
  let s = p.title;
  if (p.brand) s = s.replace(new RegExp(escapeRe(p.brand), 'ig'), ' ');
  if (p.moovinType) s = s.replace(new RegExp(`\\b${escapeRe(p.moovinType)}\\b`, 'ig'), ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) throw new ValidationError(`MODEL vazio após remover marca/tipo de "${p.title}" — bloqueado`, 'MODEL');
  return s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
