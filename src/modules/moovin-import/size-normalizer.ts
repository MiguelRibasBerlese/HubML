// Normalizador de tamanho da Moovin (PLAN.md §11.4). Todo formato "A (B)" é
// sempre duas notações do mesmo tamanho — a ordem (marca fora/dentro do
// parêntese) varia por marca, então nunca descartamos nenhuma das duas.
export interface NormalizedSize {
  original: string; // valor cru da planilha, ex "P (3)"
  brandLabel: string; // notação da marca
  brLabel: string; // equivalente BR
  kind: 'letter' | 'numeric-pair' | 'letter-number';
}

// ponytail: marcas onde a notação BR vem fora do parêntese (Farm confirmada
// no PLAN.md §11.4); toda marca não listada assume marca-fora/BR-dentro
// (Lacoste, Levi's, Calvin Klein, Colcci). Mapeamento definitivo de qual
// campo vira main_attribute do guia de tamanho é responsabilidade do
// size-grid.service.ts (§11.5), ainda não implementado.
const BR_LABEL_OUTSIDE_BRANDS = new Set(['FARM']);

export function normalizeSize(original: string, brand?: string): NormalizedSize {
  const trimmed = original.trim();

  const pairMatch = /^(\d+)\/(\d+)$/.exec(trimmed);
  if (pairMatch) {
    return { original: trimmed, brandLabel: trimmed, brLabel: trimmed, kind: 'numeric-pair' };
  }

  const parenMatch = /^(.+?)\s*\((.+)\)$/.exec(trimmed);
  if (parenMatch) {
    const [, outer, inner] = parenMatch as unknown as [string, string, string];
    const brOutside = brand != null && BR_LABEL_OUTSIDE_BRANDS.has(brand.toUpperCase());
    return {
      original: trimmed,
      brandLabel: brOutside ? inner : outer,
      brLabel: brOutside ? outer : inner,
      kind: 'letter-number',
    };
  }

  return { original: trimmed, brandLabel: trimmed, brLabel: trimmed, kind: 'letter' };
}
