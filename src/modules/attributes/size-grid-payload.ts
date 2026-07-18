import { ValidationError } from '../../lib/errors';

export interface SizeGridRow {
  size: string; // valor nominal exibido (ex. "P") — vira o atributo SIZE da linha
  manufacturerSize?: string; // opcional, ex. numeração da marca — vira MANUFACTURER_SIZE
}

export interface ChartPayloadParams {
  domainId: string; // sem prefixo do site, ex. "DRESSES" (não "MLB-DRESSES")
  siteId?: string; // default "MLB"
  brand: string;
  genderValueId: string; // id do valor GENDER no ML, ex. "339665"
  genderName: string; // nome legível, ex. "Feminino"
  names: Record<string, string>; // nome do guia por site, ex. { MLB: "Guia FARM Vestidos" }
  rows: SizeGridRow[];
  /** Linhas completas copiadas de um guia REAL (com FILTRABLE_SIZE/medida corporal) —
   *  caminho pra clonar medidas reais entre domínios (2026-07-18, camisas). Quando
   *  presente, vence `rows`. Formato: o mesmo de `chart.rows[].attributes` do ML. */
  rawRows?: { attributes: { id: string; values: unknown[] }[] }[];
  measureType?: string; // ex. BODY_MEASURE — copiado do guia fonte
  mainAttributeId?: string; // ex. SIZE — copiado do guia fonte
}

/** Payload de `POST /catalog/charts` — último recurso, só quando `buildChartSearchPayload`
 *  não acha guia existente (§11, M6: busca antes de criar). Só BRAND e GENDER são atributos
 *  de classificação obrigatórios pra domínios TOPS/BOTTOMS (confirmado via technical_specs);
 *  type/chart_type não vai no payload — o ML infere SPECIFIC pra guia criado pelo seller.
 *  Forma de `values` por linha confirmada contra um chart real da conta (5170265): SIZE não
 *  leva `id` (só `name`), diferente do formato usado em BRAND/GENDER no nível do chart. */
export function buildChartPayload(params: ChartPayloadParams): Record<string, unknown> {
  const siteId = params.siteId ?? 'MLB';
  // Linhas completas de um guia real (clonagem de medidas entre domínios) vencem `rows`.
  if (params.rawRows?.length) {
    return {
      names: params.names,
      domain_id: params.domainId,
      site_id: siteId,
      ...(params.measureType ? { measure_type: params.measureType } : {}),
      ...(params.mainAttributeId ? { main_attribute_id: params.mainAttributeId } : {}),
      attributes: [{ id: 'GENDER', values: [{ id: params.genderValueId, name: params.genderName }] }],
      rows: params.rawRows,
    };
  }
  if (!params.rows.length) throw new ValidationError('guia de tamanho sem linhas', 'rows');
  return {
    names: params.names,
    domain_id: params.domainId,
    site_id: siteId,
    attributes: [
      { id: 'BRAND', values: [{ name: params.brand }] },
      { id: 'GENDER', values: [{ id: params.genderValueId, name: params.genderName }] },
    ],
    main_attribute: { attributes: [{ site_id: siteId, id: 'SIZE' }] },
    rows: params.rows.map((r) => ({
      attributes: [
        { site_id: siteId, id: 'SIZE', values: [{ name: r.size }] },
        ...(r.manufacturerSize
          ? [{ site_id: siteId, id: 'MANUFACTURER_SIZE', values: [{ name: r.manufacturerSize }] }]
          : []),
      ],
    })),
  };
}

/** Payload de `POST /catalog/charts/search` — chamado antes de qualquer criação (§11, M6).
 *  seller_id, domain_id e site_id são obrigatórios; GENDER e BRAND são os filtros mínimos
 *  pra validar (confirmado por tentativa/erro real: `required_filter_missing` sem eles).
 *  BRAND no filtro NÃO restringe de fato os resultados — o ML pode devolver guias de
 *  outras marcas pro mesmo domain/gender; a seleção final é responsabilidade de quem chama. */
export function buildChartSearchPayload(
  params: Pick<ChartPayloadParams, 'domainId' | 'siteId' | 'brand' | 'genderValueId' | 'genderName'>,
  sellerId: string,
): Record<string, unknown> {
  return {
    domain_id: params.domainId,
    site_id: params.siteId ?? 'MLB',
    seller_id: sellerId,
    attributes: [
      { id: 'GENDER', values: [{ id: params.genderValueId, name: params.genderName }] },
      { id: 'BRAND', values: [{ name: params.brand }] },
    ],
  };
}
