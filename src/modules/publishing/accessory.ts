import { MlApi } from '../../ml/api/ml-api.service';
import { ValidationError } from '../../lib/errors';
import type { MlCategoryAttribute } from '../../ml/api/ml-api.types';
import type { ItemAttribute } from './payload-builder';

/**
 * Mapa curado por TIPO (decisão Miguel 2026-07-17): query desambiguada + domínio esperado.
 * O category_id NÃO é chumbado — vem sempre do domain_discovery (fica atual); o
 * expected_domain é guarda-corpo: se o discovery divergir, bloqueia (SAFETY_GOGGLES
 * nunca mais passa calado). Só entra tipo APROVADO um a um pelo Miguel.
 *
 * modelStrategy: como extrair MODEL (obrigatório em vários domínios) do dado real.
 *  'lacoste-code'      → regex \b(L\d+S)\b no título (óculos Lacoste).
 *  'title-minus-brand' → nome da linha = título sem marca e sem a palavra do tipo (bolsas).
 */
export interface AccessoryMapEntry {
  queryPhrase: string;
  expectedDomain: string;
  modelStrategy: 'lacoste-code' | 'title-minus-brand';
}
export const ACCESSORY_MAP: Record<string, AccessoryMapEntry> = {
  OCULOS: { queryPhrase: 'óculos de sol', expectedDomain: 'SUNGLASSES', modelStrategy: 'lacoste-code' },
  BOLSA: { queryPhrase: 'bolsa feminina', expectedDomain: 'HANDBAGS', modelStrategy: 'title-minus-brand' },
};

export interface AccessoryVariationInput {
  sku: string;
  color: string | null;
  size: string | null;
  priceCents: number;
  stockOnHand: number;
}
export interface AccessoryInput {
  title: string;
  brand: string | null;
  moovinType: string | null;
  moovinCategoria: string | null;
  variations: AccessoryVariationInput[];
}
export interface ResolvedAccessory {
  categoryId: string;
  itemAttributes: ItemAttribute[]; // tudo item-level: modelo UP = 1 SKU = 1 item (ML cria o user_product sozinho)
}

const GTIN_EXEMPT_VALUE = 'O produto não tem código cadastrado'; // motivo real (Moovin sem GTIN)

/** Compara nomes ignorando caixa E espaçamento: o ML usa NBSP (U+00A0) dentro de value_name
 *  (achado real 2026-07-18: BRAND "Luz da Lua") — \s pega NBSP em JS. */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}
const MODEL_RE = /\b(L\d+S)\b/; // modelo de óculos Lacoste no título — parsing, não invenção

/** Resolve categoria (discovery + guarda-corpo) e os atributos obrigatórios por dado real.
 *  Modelo UP: 1 SKU = 1 item com family_name (ML cria o user_product sozinho) — NÃO existe
 *  array `variations` nesta conta (achado 2026-07-17, gabarito MLB4908192909). Multi-SKU =
 *  items irmãos com mesmo family_name (não implementado aqui — bloqueia >1 variação).
 *  Dimensões de embalagem NÃO vão: as da Moovin são default errado (40×40 pra tudo); o ML
 *  preenche sozinho. Qualquer obrigatório sem fonte real → ValidationError (nunca chuta). */
export async function resolveAccessory(ml: MlApi, p: AccessoryInput): Promise<ResolvedAccessory> {
  const entry = p.moovinType ? ACCESSORY_MAP[p.moovinType] : undefined;
  if (!entry) throw new ValidationError(`TIPO "${p.moovinType}" não está no mapa curado de acessórios`, 'moovinType');
  if (p.variations.length !== 1) {
    throw new ValidationError(`multi-SKU (${p.variations.length} variações) = items irmãos, não implementado — bloqueado`, 'variations');
  }
  const v = p.variations[0]!;

  const query = p.brand ? `${entry.queryPhrase} ${p.brand}` : entry.queryPhrase;
  const suggestion = await ml.suggestDomain(query);
  if (!suggestion) throw new ValidationError(`domain_discovery não achou domínio para "${query}"`, 'category');
  if (suggestion.domainId !== entry.expectedDomain) {
    throw new ValidationError(
      `categoria divergente: TIPO ${p.moovinType} esperava ${entry.expectedDomain}, discovery devolveu ${suggestion.domainId} — bloqueado`,
      'category',
    );
  }

  const defs = await ml.getCategoryAttributes(suggestion.categoryId);
  const byId = (id: string) => defs.find((d) => d.id === id);
  const required = defs.filter((a) => a.tags?.required || a.tags?.catalog_required);

  const itemAttributes: ItemAttribute[] = [];
  for (const def of required) {
    switch (def.id) {
      case 'GTIN':
        break; // isenção via EMPTY_GTIN_REASON abaixo
      case 'BRAND':
        itemAttributes.push(resolveOpen(def, p.brand, 'MARCA'));
        break;
      case 'MODEL':
        itemAttributes.push({ id: 'MODEL', value_name: resolveModel(entry, p) });
        break;
      case 'GENDER':
        itemAttributes.push(resolveGender(def, p));
        break;
      case 'COLOR':
        itemAttributes.push(resolveOpen(def, v.color, 'COR'));
        break;
      case 'SIZE':
        itemAttributes.push(resolveOpen(def, v.size, 'TAMANHO'));
        break;
      default:
        throw new ValidationError(`atributo obrigatório não suportado ainda: ${def.id} — bloqueado`, def.id);
    }
  }

  // COLOR mesmo quando não-obrigatório: é o atributo allow_variations que define a variação
  // implícita do user_product — sem ele o EMPTY_GTIN_REASON item-level não "cola" e o ML devolve
  // missing_conditional_required GTIN (achado HANDBAGS 2026-07-17; a Carteira Schutz ativa tem COLOR).
  // Só com dado real (COR da Moovin) — sem COR, segue sem COLOR (nunca chuta).
  const colorDef = byId('COLOR');
  if (colorDef && v.color && !itemAttributes.some((a) => a.id === 'COLOR')) {
    itemAttributes.push(resolveOpen(colorDef, v.color, 'COR'));
  }

  // Isenção de GTIN item-level (Moovin nunca tem GTIN válido). PRECISA do value_id — só value_name
  // o ML ignora e segue exigindo GTIN (achado no gabarito real Carteira Schutz: value_id 17055160).
  const egr = byId('EMPTY_GTIN_REASON');
  if (egr) itemAttributes.push(resolveOpen(egr, GTIN_EXEMPT_VALUE, 'EMPTY_GTIN_REASON'));
  return { categoryId: suggestion.categoryId, itemAttributes };
}

export interface BuildAccessoryOptions {
  familyName: string;
  isUserProduct: boolean;
  pictures?: string[];
  listingTypeId?: string;
  currencyId?: string;
}

/** Body de POST /items item-level (modelo UP: 1 SKU = 1 item). Conta UP manda family_name;
 *  legado manda title. condition SEMPRE 'new' explícito (MAGNI vende novo — nunca depender do
 *  default do ML, que já saiu 'Usado'). SEM dimensões de embalagem (ML preenche). */
export function buildAccessoryPayload(
  resolved: ResolvedAccessory,
  single: { priceCents: number; stockOnHand: number },
  opts: BuildAccessoryOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    category_id: resolved.categoryId,
    price: single.priceCents / 100,
    available_quantity: single.stockOnHand,
    currency_id: opts.currencyId ?? 'BRL',
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: opts.listingTypeId ?? 'gold_pro',
    attributes: resolved.itemAttributes,
  };
  if (opts.isUserProduct) body.family_name = opts.familyName;
  else body.title = opts.familyName;
  if (opts.pictures?.length) body.pictures = opts.pictures.map((source) => ({ source }));
  return body;
}

/** MODEL por dado real, por estratégia do tipo. Sem fonte real → bloqueia (nunca chuta). */
function resolveModel(entry: AccessoryMapEntry, p: AccessoryInput): string {
  if (entry.modelStrategy === 'lacoste-code') {
    const code = p.title.match(MODEL_RE)?.[1];
    if (!code) throw new ValidationError(`MODEL não encontrado no título "${p.title}" (regex L\\d+S) — bloqueado`, 'MODEL');
    return code;
  }
  let s = p.title;
  if (p.brand) s = s.replace(new RegExp(escapeRe(p.brand), 'ig'), ' ');
  if (p.moovinType) s = s.replace(new RegExp(`\\b${escapeRe(p.moovinType)}\\b`, 'ig'), ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) throw new ValidationError(`MODEL vazio após remover marca/tipo do título "${p.title}" — bloqueado`, 'MODEL');
  return s;
}

/** GENDER por dado real: CATEGORIA=UNISSEX → "Sem gênero"; senão só se FEMININO/MASCULINO
 *  estiver LITERAL no título (parsing, mesma régua). Sem fonte → bloqueia (nunca assume). */
function resolveGender(def: MlCategoryAttribute, p: AccessoryInput): ItemAttribute {
  if ((p.moovinCategoria ?? '').toUpperCase() === 'UNISSEX') return resolveOpen(def, 'Sem gênero', 'CATEGORIA');
  const tl = p.title.toUpperCase();
  if (/\bFEMININ[AO]\b/.test(tl)) return resolveOpen(def, 'Feminino', 'título');
  if (/\bMASCULINO\b/.test(tl)) return resolveOpen(def, 'Masculino', 'título');
  throw new ValidationError(
    `GENDER exigido mas sem fonte real (CATEGORIA≠UNISSEX e sem FEMININO/MASCULINO no título "${p.title}") — bloqueado`,
    'GENDER',
  );
}

/** Casa um valor real com as allowed values (por nome, case-insensitive) → value_id. Lista fechada
 *  (value_type 'list') sem match → bloqueia. Atributo aberto ('string', values são só sugestões) →
 *  manda value_name. Valor ausente → bloqueia. */
export function resolveOpen(def: MlCategoryAttribute, value: string | null, source: string): ItemAttribute {
  if (!value) throw new ValidationError(`${def.id} exigido mas ${source} vazio — bloqueado`, def.id);
  const match = (def.values ?? []).find((v) => v.name && sameName(v.name, value));
  if (match) return { id: def.id, value_id: match.id, value_name: match.name };
  if (def.value_type === 'list') {
    throw new ValidationError(`${def.id}="${value}" não está nos valores válidos (lista fechada) do ML — bloqueado`, def.id);
  }
  return { id: def.id, value_name: value };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
