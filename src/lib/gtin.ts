// Validador de GTIN (UPC-12, EAN-8/13, ITF-14) por dígito verificador — §2 do PLAN.
// O ML aceita UPC(12), EAN(13), JAN(8/13), ITF-14(14). Validar ANTES de enviar.

const VALID_LENGTHS = new Set([8, 12, 13, 14]);

/** true se o GTIN tem comprimento aceito e dígito verificador correto. */
export function isValidGtin(gtin: string): boolean {
  if (!/^\d+$/.test(gtin)) return false;
  if (!VALID_LENGTHS.has(gtin.length)) return false;

  const digits = gtin.split('').map(Number);
  const check = digits[digits.length - 1]!;
  const body = digits.slice(0, -1);

  // Pesos 3/1 aplicados da direita para a esquerda sobre o corpo (padrão GS1).
  let sum = 0;
  for (let i = body.length - 1, pos = 0; i >= 0; i--, pos++) {
    sum += body[i]! * (pos % 2 === 0 ? 3 : 1);
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === check;
}

// Motivos de isenção aceitos pelo ML (EMPTY_GTIN_REASON). Nunca inventar número.
export const GTIN_EXEMPT_REASONS = [
  'Fabricado por mim',
  'Produto artesanal',
  'Kit ou pacote de produtos',
  'Não possui código',
] as const;
export type GtinExemptReason = (typeof GTIN_EXEMPT_REASONS)[number];
