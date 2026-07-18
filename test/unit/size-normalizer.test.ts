import { describe, it, expect } from 'vitest';
import { normalizeSize } from '../../src/modules/moovin-import/size-normalizer';

describe('normalizeSize', () => {
  it('tamanho simples (letra ou número) vira kind letter, sem parêntese', () => {
    expect(normalizeSize('P')).toEqual({ original: 'P', brandLabel: 'P', brLabel: 'P', kind: 'letter' });
    expect(normalizeSize('42')).toEqual({ original: '42', brandLabel: '42', brLabel: '42', kind: 'letter' });
    expect(normalizeSize('ÚNICO')).toMatchObject({ kind: 'letter' });
  });

  it('par numérico (chinelo/kit) vira kind numeric-pair, preserva ambos', () => {
    const r = normalizeSize('27/28');
    expect(r.kind).toBe('numeric-pair');
    expect(r.original).toBe('27/28');
  });

  it('Lacoste: número da marca fora, BR dentro do parêntese', () => {
    const r = normalizeSize('3 (P)', 'LACOSTE');
    expect(r.kind).toBe('letter-number');
    expect(r.brandLabel).toBe('3');
    expect(r.brLabel).toBe('P');
  });

  it('Farm: BR fora, número da marca dentro — ordem invertida', () => {
    const r = normalizeSize('P (3)', 'FARM');
    expect(r.kind).toBe('letter-number');
    expect(r.brandLabel).toBe('3');
    expect(r.brLabel).toBe('P');
  });

  it('marca desconhecida assume marca-fora/BR-dentro por padrão', () => {
    const r = normalizeSize('M (40)', 'COLCCI');
    expect(r.brandLabel).toBe('M');
    expect(r.brLabel).toBe('40');
  });

  it('notação internacional + BR (Levi\'s/CK)', () => {
    const r = normalizeSize('S (P)', 'LEVIS');
    expect(r.brandLabel).toBe('S');
    expect(r.brLabel).toBe('P');
  });

  it('formato com "|" (USA | BR) não quebra — cai em kind letter por não casar parêntese', () => {
    const r = normalizeSize('S USA | P BR');
    expect(r.original).toBe('S USA | P BR');
    expect(r.kind).toBe('letter');
  });
});
