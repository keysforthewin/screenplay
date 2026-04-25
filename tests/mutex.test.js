import { describe, it, expect } from 'vitest';
import { keyedMutex } from '../src/util/mutex.js';

describe('keyedMutex', () => {
  it('serializes operations per key', async () => {
    const mutex = keyedMutex();
    const order = [];
    const a = mutex.run('k1', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); });
    const b = mutex.run('k1', async () => { order.push('b'); });
    const c = mutex.run('k2', async () => { order.push('c'); });
    await Promise.all([a, b, c]);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
  });
});
