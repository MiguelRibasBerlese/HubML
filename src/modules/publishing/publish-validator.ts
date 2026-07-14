import { ValidationError } from '../../lib/errors';
import { isValidGtin } from '../../lib/gtin';

export interface PublishableVariation {
  sku: string;
  gtin?: string | null;
  gtinExemptReason?: string | null;
  priceCents: number;
  stockOnHand: number;
}

export interface PublishableProduct {
  title: string;
  mlCategoryId?: string | null;
  variations: PublishableVariation[];
}

const TITLE_MAX = 60;

/**
 * Validação pré-envio mínima (M5.1). Lança ValidationError legível no primeiro
 * problema — o motor de atributos completo (categoria, SIZE_GRID) entra no M6.
 */
export function validateForPublish(p: PublishableProduct): void {
  if (!p.title.trim()) throw new ValidationError('título é obrigatório', 'title');
  if (p.title.length > TITLE_MAX) {
    throw new ValidationError(`título excede ${TITLE_MAX} caracteres (${p.title.length})`, 'title');
  }
  if (!p.mlCategoryId) throw new ValidationError('categoria do ML é obrigatória', 'mlCategoryId');
  if (!p.variations.length) throw new ValidationError('produto sem variações', 'variations');

  for (const v of p.variations) {
    if (v.priceCents <= 0) throw new ValidationError(`preço inválido no SKU ${v.sku}`, 'priceCents');
    if (v.gtin) {
      if (!isValidGtin(v.gtin)) throw new ValidationError(`GTIN inválido no SKU ${v.sku}: ${v.gtin}`, 'gtin');
    } else if (!v.gtinExemptReason) {
      // ponytail: obrigatoriedade real do GTIN é por categoria/marca (M6);
      // aqui só exigimos GTIN válido OU isenção explícita — nunca enviar vazio silencioso.
      throw new ValidationError(`SKU ${v.sku} sem GTIN e sem motivo de isenção`, 'gtin');
    }
  }
}
