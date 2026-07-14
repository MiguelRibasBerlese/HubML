import { describe, it, expect } from 'vitest';
import { ConcurrencyLimiter } from '../../src/ml/client/concurrency';

describe('ConcurrencyLimiter', () => {
  it('nunca ultrapassa o máximo de execuções simultâneas', async () => {
    const limiter = new ConcurrencyLimiter(3);
    let active = 0;
    let peak = 0;
    const task = async () => {
      await limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    };
    await Promise.all(Array.from({ length: 20 }, task));
    expect(peak).toBeLessThanOrEqual(3);
    expect(active).toBe(0);
  });
});
