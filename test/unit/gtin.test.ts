import { describe, it, expect } from 'vitest';
import { isValidGtin } from '../../src/lib/gtin';

describe('isValidGtin', () => {
  it('aceita EAN-13 válido', () => {
    expect(isValidGtin('7891234567895')).toBe(true); // check calculado
    expect(isValidGtin('4006381333931')).toBe(true); // exemplo GS1 clássico
  });

  it('aceita UPC-12 e EAN-8 válidos', () => {
    expect(isValidGtin('036000291452')).toBe(true); // UPC-12
    expect(isValidGtin('40170725')).toBe(true); // EAN-8
  });

  it('rejeita dígito verificador errado', () => {
    expect(isValidGtin('4006381333930')).toBe(false);
    expect(isValidGtin('7891234567890')).toBe(false);
  });

  it('rejeita comprimento inválido e não-numéricos', () => {
    expect(isValidGtin('12345')).toBe(false);
    expect(isValidGtin('789123456789X')).toBe(false);
    expect(isValidGtin('')).toBe(false);
  });
});
