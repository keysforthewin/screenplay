import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { claimAnnouncement } = await import('../src/mongo/editAnnouncements.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('claimAnnouncement', () => {
  const base = { projectId: 'p1', targetType: 'beat', targetId: 'b1', editor: 'alice' };

  it('returns true the first time and false the second time for the same key', async () => {
    expect(await claimAnnouncement(base)).toBe(true);
    expect(await claimAnnouncement(base)).toBe(false);
  });

  it('returns true for a different editor on the same target', async () => {
    expect(await claimAnnouncement(base)).toBe(true);
    expect(await claimAnnouncement({ ...base, editor: 'bob' })).toBe(true);
  });

  it('returns true for a different target for the same editor', async () => {
    expect(await claimAnnouncement(base)).toBe(true);
    expect(await claimAnnouncement({ ...base, targetId: 'b2' })).toBe(true);
  });

  it('throws when projectId is falsy', async () => {
    await expect(claimAnnouncement({ ...base, projectId: '' })).rejects.toThrow('projectId required');
  });
});
