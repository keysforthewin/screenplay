import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const {
  listCollectionVoices,
  getCollectionVoice,
  addVoiceToCollection,
  removeVoiceFromCollection,
  markVoiceAddedToAccount,
} = await import('../src/mongo/elevenVoices.js');

const P1 = '65e000000000000000000001';
const P2 = '65e000000000000000000002';

beforeEach(() => {
  fakeDb.reset();
});

describe('projectId threading', () => {
  it('every helper throws on a falsy projectId', async () => {
    await expect(listCollectionVoices(null)).rejects.toThrow('projectId required');
    await expect(getCollectionVoice(null, 'v')).rejects.toThrow('projectId required');
    await expect(addVoiceToCollection(null, { voice_id: 'v' })).rejects.toThrow('projectId required');
    await expect(removeVoiceFromCollection(null, 'v')).rejects.toThrow('projectId required');
    await expect(markVoiceAddedToAccount(null, 'v')).rejects.toThrow('projectId required');
  });
});

describe('addVoiceToCollection', () => {
  it('inserts with defaults and returns the stored doc', async () => {
    const doc = await addVoiceToCollection(P1, {
      voice_id: 'v1', public_owner_id: 'owner1', name: 'Detective',
      preview_url: 'https://cdn/x.mp3', labels: { gender: 'male', accent: 'american' },
      category: 'professional', source: 'library',
    });
    expect(doc.project_id).toBe(P1);
    expect(doc.voice_id).toBe('v1');
    expect(doc.added_to_account).toBe(false);
    expect(doc.source).toBe('library');
    expect(doc.created_at).toBeInstanceOf(Date);
  });

  it('upserts on (project, voice) — re-adding updates instead of duplicating', async () => {
    await addVoiceToCollection(P1, { voice_id: 'v1', name: 'Old name' });
    await addVoiceToCollection(P1, { voice_id: 'v1', name: 'New name' });
    const all = await listCollectionVoices(P1);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('New name');
  });

  it('rejects a missing voice_id', async () => {
    await expect(addVoiceToCollection(P1, { name: 'x' })).rejects.toThrow('voice_id required');
  });

  it('normalizes unknown sources to library and clone/design pass through', async () => {
    const a = await addVoiceToCollection(P1, { voice_id: 'a', source: 'weird' });
    const b = await addVoiceToCollection(P1, { voice_id: 'b', source: 'clone', added_to_account: true });
    expect(a.source).toBe('library');
    expect(b.source).toBe('clone');
    expect(b.added_to_account).toBe(true);
  });
});

describe('cross-project isolation', () => {
  it('the same voice can exist in two projects; listing/removal never cross over', async () => {
    await addVoiceToCollection(P1, { voice_id: 'shared', name: 'In P1' });
    await addVoiceToCollection(P2, { voice_id: 'shared', name: 'In P2' });
    expect(await listCollectionVoices(P1)).toHaveLength(1);
    expect((await getCollectionVoice(P2, 'shared')).name).toBe('In P2');
    expect(await removeVoiceFromCollection(P1, 'shared')).toBe(true);
    expect(await listCollectionVoices(P1)).toHaveLength(0);
    expect(await listCollectionVoices(P2)).toHaveLength(1);
  });

  it('removing a voice that is not there returns false', async () => {
    expect(await removeVoiceFromCollection(P1, 'ghost')).toBe(false);
  });
});

describe('markVoiceAddedToAccount', () => {
  it('flips the flag in place', async () => {
    await addVoiceToCollection(P1, { voice_id: 'v1', name: 'X' });
    await markVoiceAddedToAccount(P1, 'v1');
    expect((await getCollectionVoice(P1, 'v1')).added_to_account).toBe(true);
  });
});
