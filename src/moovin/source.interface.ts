// Contrato neutro entre a origem dos dados da Moovin (hoje: xlsx local; amanhã:
// docs.moovin.app) e o importador. MoovinImportService depende só disso.
export interface MoovinVariationRow {
  sku: string;
  color: string | null;
  size: string | null;
  stock: number;
  priceListCents: number;
}

export interface MoovinProductRow {
  urn: string;
  name: string;
  brand: string | null;
  gender: string | null;
  image: string | null;
  type: string | null;
  categoria: string | null;
  variations: MoovinVariationRow[];
}

export interface MoovinSource {
  fetchProducts(): Promise<MoovinProductRow[]>;
}

export const MOOVIN_SOURCE = Symbol('MOOVIN_SOURCE');
