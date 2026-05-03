import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { getHistoryClearedAt, setHistoryClearedAt } = await import('../src/mongo/channelState.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('channelState', () => {
  it('returns null for an unknown channel', async () => {
    expect(await getHistoryClearedAt('nope')).toBeNull();
  });

  it('round-trips a clear timestamp via upsert', async () => {
    const when = new Date('2026-05-03T10:00:00Z');
    const returned = await setHistoryClearedAt('chan-1', when);
    expect(returned).toEqual(when);
    expect(await getHistoryClearedAt('chan-1')).toEqual(when);
  });

  it('overwrites a previous clear timestamp on a second call', async () => {
    const first = new Date('2026-05-03T10:00:00Z');
    const second = new Date('2026-05-03T11:00:00Z');
    await setHistoryClearedAt('chan-2', first);
    await setHistoryClearedAt('chan-2', second);
    expect(await getHistoryClearedAt('chan-2')).toEqual(second);
  });

  it('keeps clear state isolated per channel', async () => {
    const ts = new Date('2026-05-03T12:00:00Z');
    await setHistoryClearedAt('chan-a', ts);
    expect(await getHistoryClearedAt('chan-a')).toEqual(ts);
    expect(await getHistoryClearedAt('chan-b')).toBeNull();
  });

  it('defaults the timestamp to now when none is supplied', async () => {
    const before = Date.now();
    const returned = await setHistoryClearedAt('chan-3');
    const after = Date.now();
    expect(returned.getTime()).toBeGreaterThanOrEqual(before);
    expect(returned.getTime()).toBeLessThanOrEqual(after);
    expect((await getHistoryClearedAt('chan-3')).getTime()).toBe(returned.getTime());
  });

  it('rejects an empty channelId on set', async () => {
    await expect(setHistoryClearedAt('')).rejects.toThrow(/channelId required/);
  });

  it('returns null when channelId is empty on get', async () => {
    expect(await getHistoryClearedAt('')).toBeNull();
  });
});
