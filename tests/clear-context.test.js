import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const { getHistoryClearedAt } = await import('../src/mongo/channelState.js');

beforeEach(() => fakeDb.reset());

describe('clear_context handler', () => {
  it('sets the history-cleared watermark for the channel', async () => {
    const before = await getHistoryClearedAt('chan-1');
    expect(before).toBeNull();

    const out = await HANDLERS.clear_context({}, { channelId: 'chan-1' });
    expect(typeof out).toBe('string');
    expect(out.toLowerCase()).toContain('clear');

    const after = await getHistoryClearedAt('chan-1');
    expect(after).toBeInstanceOf(Date);
  });

  it('returns an error string when there is no channel context', async () => {
    const out = await HANDLERS.clear_context({}, {});
    expect(out).toMatch(/^Error:/);
  });
});
