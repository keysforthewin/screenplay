import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { getHistoryClearedAt, setHistoryClearedAt, getCurrentProjectId, setCurrentProjectId } =
  await import('../src/mongo/channelState.js');

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

describe('channelState current project pointer', () => {
  const PID_A = 'a'.repeat(24);
  const PID_B = 'b'.repeat(24);

  it('returns null for an unknown channel', async () => {
    expect(await getCurrentProjectId('nope')).toBeNull();
  });

  it('returns null when channelId is empty on get', async () => {
    expect(await getCurrentProjectId('')).toBeNull();
  });

  it('round-trips a project id via upsert', async () => {
    const returned = await setCurrentProjectId('chan-1', PID_A);
    expect(returned).toBe(PID_A);
    expect(await getCurrentProjectId('chan-1')).toBe(PID_A);
  });

  it('overwrites a previous project id on a second call', async () => {
    await setCurrentProjectId('chan-2', PID_A);
    await setCurrentProjectId('chan-2', PID_B);
    expect(await getCurrentProjectId('chan-2')).toBe(PID_B);
  });

  it('keeps project pointer isolated per channel', async () => {
    await setCurrentProjectId('chan-a', PID_A);
    expect(await getCurrentProjectId('chan-a')).toBe(PID_A);
    expect(await getCurrentProjectId('chan-b')).toBeNull();
  });

  it('coexists with history_cleared_at on the same doc', async () => {
    const when = new Date('2026-06-01T10:00:00Z');
    await setHistoryClearedAt('chan-3', when);
    await setCurrentProjectId('chan-3', PID_A);
    expect(await getHistoryClearedAt('chan-3')).toEqual(when);
    expect(await getCurrentProjectId('chan-3')).toBe(PID_A);
  });

  it('rejects an empty channelId on set', async () => {
    await expect(setCurrentProjectId('', PID_A)).rejects.toThrow(/channelId required/);
  });

  it('rejects a non-hex projectId on set', async () => {
    await expect(setCurrentProjectId('chan-4', 'not-a-hex-id')).rejects.toThrow(/24-hex/);
    await expect(setCurrentProjectId('chan-4', null)).rejects.toThrow(/24-hex/);
  });
});
