import { describe, it, expect } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import { vi } from 'vitest';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');

describe('calculator', () => {
  it('does simple arithmetic', async () => {
    const out = JSON.parse(await HANDLERS.calculator({ expression: '2 + 2' }));
    expect(out.expression).toBe('2 + 2');
    expect(out.result).toBe('4');
  });

  it('returns 0.3 exactly for 0.1 + 0.2 (BigNumber path)', async () => {
    const out = JSON.parse(await HANDLERS.calculator({ expression: '0.1 + 0.2' }));
    expect(out.result).toBe('0.3');
  });

  it('handles big integer exponentiation as full digits', async () => {
    const out = JSON.parse(await HANDLERS.calculator({ expression: '2^200' }));
    expect(out.result).toBe(
      '1606938044258990275541962092341162602522202993782792835301376',
    );
  });

  it('honors precision for irrationals', async () => {
    const out = JSON.parse(
      await HANDLERS.calculator({ expression: 'sqrt(2)', precision: 20 }),
    );
    expect(out.result.startsWith('1.4142135623730950488')).toBe(true);
  });

  it('computes 1/7 to high precision', async () => {
    const out = JSON.parse(
      await HANDLERS.calculator({ expression: '1 / 7', precision: 30 }),
    );
    // 1/7 = 0.142857142857... repeating
    expect(out.result.startsWith('0.142857142857142857142857142857')).toBe(true);
  });

  it('sin(pi) is essentially zero', async () => {
    const out = JSON.parse(await HANDLERS.calculator({ expression: 'sin(pi)' }));
    // BigNumber sin(pi) is extremely close to zero but not necessarily literal "0"
    const numeric = Number(out.result);
    expect(Math.abs(numeric)).toBeLessThan(1e-10);
  });

  it('supports factorial and modulo', async () => {
    const out1 = JSON.parse(await HANDLERS.calculator({ expression: '10!' }));
    expect(out1.result).toBe('3628800');
    const out2 = JSON.parse(await HANDLERS.calculator({ expression: '17 mod 5' }));
    expect(out2.result).toBe('2');
  });

  it('returns an error string when expression is missing', async () => {
    const out = await HANDLERS.calculator({});
    expect(out).toBe('Calculator error: `expression` is required.');
  });

  it('returns an error string when expression is empty', async () => {
    const out = await HANDLERS.calculator({ expression: '   ' });
    expect(out).toBe('Calculator error: `expression` is required.');
  });

  it('returns an error string for an invalid expression', async () => {
    const out = await HANDLERS.calculator({ expression: '2 +' });
    expect(out).toMatch(/^Calculator error:/);
  });

  it('rejects dangerous mathjs internals (import) cleanly', async () => {
    const out = await HANDLERS.calculator({ expression: 'import("fs", {})' });
    // mathjs evaluate sandboxes import / createUnit / parse — should error rather than execute
    expect(out).toMatch(/^Calculator error:/);
  });

  it('clamps precision to the [4, 64] range', async () => {
    // precision 1 → clamped to 4 → sqrt(2) shown to 4 sig figs
    const lo = JSON.parse(
      await HANDLERS.calculator({ expression: 'sqrt(2)', precision: 1 }),
    );
    expect(lo.result).toBe('1.414');
    // precision 999 → clamped to 64 — should still produce a result
    const hi = JSON.parse(
      await HANDLERS.calculator({ expression: 'sqrt(2)', precision: 999 }),
    );
    expect(hi.result.length).toBeGreaterThan(40);
  });
});
