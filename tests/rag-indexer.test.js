import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';
import { createFakeChroma } from './_fakeChroma.js';

const fakeDb = createFakeDb();
const fakeChroma = createFakeChroma();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/rag/chromaClient.js', () => ({
  isRagEnabled: () => true,
  getCollection: async () => fakeChroma,
  chromaHealthcheck: async () => true,
  resetForTests: () => {},
}));

// Deterministic vector: 16-dim, hash-of-chars based.
function fakeVector(text, dim = 16) {
  const v = new Array(dim).fill(0);
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    v[i % dim] += s.charCodeAt(i) / 255;
  }
  // L2 normalize
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

vi.mock('../src/rag/embeddings.js', () => ({
  embedTexts: vi.fn(async (texts) => texts.map((t) => fakeVector(t))),
  RagDisabledError: class extends Error {},
}));

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');
const Indexer = await import('../src/rag/indexer.js');

beforeEach(() => {
  fakeDb.reset();
  fakeChroma._store.clear();
});

describe('rag indexer — beats', () => {
  it('indexBeat creates expected chunk ids for name/desc/body', async () => {
    const beat = await Plots.createBeat({
      name: 'Diner Argument',
      desc: 'Alice and Bob argue at the diner.',
      body: 'A short body about the morning hours.',
    });
    await Indexer.indexBeat(beat._id);
    const ids = [...fakeChroma._store.keys()].sort();
    expect(ids).toContain(`beat:${beat._id.toString()}:name`);
    expect(ids).toContain(`beat:${beat._id.toString()}:desc`);
    expect(ids.some((i) => i.startsWith(`beat:${beat._id.toString()}:body:`))).toBe(true);
  });

  it('shrinking the body deletes orphan chunks', async () => {
    const beat = await Plots.createBeat({
      name: 'Long',
      desc: 'd',
      body: ('Para. '.repeat(200) + '\n\n').repeat(8),
    });
    await Indexer.indexBeat(beat._id);
    const wide = [...fakeChroma._store.keys()].filter((k) =>
      k.startsWith(`beat:${beat._id.toString()}:body:`),
    ).length;
    expect(wide).toBeGreaterThan(1);
    await Plots.setBeatBody(beat._id.toString(), 'tiny');
    await Indexer.indexBeat(beat._id);
    const narrow = [...fakeChroma._store.keys()].filter((k) =>
      k.startsWith(`beat:${beat._id.toString()}:body:`),
    ).length;
    expect(narrow).toBeLessThan(wide);
    expect(narrow).toBe(1);
  });

  it('beat name strip-markdown is used for entity_label', async () => {
    const beat = await Plots.createBeat({
      name: '**Bold Name**',
      desc: 'd',
    });
    await Indexer.indexBeat(beat._id);
    const meta = fakeChroma._store.get(`beat:${beat._id.toString()}:name`).metadata;
    expect(meta.entity_label).toBe('Bold Name');
    // The text_md should keep the markdown.
    expect(meta.text_md).toBe('**Bold Name**');
  });
});

describe('rag indexer — characters', () => {
  it('skips empty hollywood_actor and empty fields', async () => {
    const c = await Characters.createCharacter({
      name: 'Alice',
      plays_self: false,
      hollywood_actor: '',
      own_voice: true,
      fields: { background_story: 'Born in 1990 in a small town.', favorite_color: '' },
    });
    await Indexer.indexCharacter(c._id);
    const ids = [...fakeChroma._store.keys()];
    expect(ids).toContain(`character:${c._id.toString()}:name`);
    expect(ids.some((i) => i.includes('hollywood_actor'))).toBe(false);
    expect(ids.some((i) => i.includes('field:background_story'))).toBe(true);
    expect(ids.some((i) => i.includes('field:favorite_color'))).toBe(false);
  });

  it('updating a custom field replaces only that field\'s chunks', async () => {
    const c = await Characters.createCharacter({
      name: 'Bob',
      plays_self: true,
      hollywood_actor: '',
      own_voice: true,
      fields: { background_story: 'Long story. '.repeat(300) },
    });
    await Indexer.indexCharacter(c._id);
    const before = [...fakeChroma._store.keys()].filter((k) =>
      k.includes('field:background_story'),
    ).length;
    expect(before).toBeGreaterThan(0);
    await Characters.updateCharacter(c._id.toString(), {
      fields: { background_story: 'short' },
    });
    await Indexer.indexCharacter(c._id);
    const after = [...fakeChroma._store.keys()].filter((k) =>
      k.includes('field:background_story'),
    ).length;
    expect(after).toBe(1);
  });
});

describe('rag indexer — director notes & messages', () => {
  it('indexDirectorNote chunks the note text', async () => {
    const note = await DirectorNotes.addDirectorNote({ text: 'No fast cuts under 90 seconds.' });
    await Indexer.indexDirectorNote(note._id);
    const ids = [...fakeChroma._store.keys()];
    expect(ids).toContain(`director_note:${note._id.toString()}:text:0`);
  });

  it('indexMessage skips empty text after strip', async () => {
    const oid = new ObjectId();
    const empty = { _id: oid, role: 'user', content: '   ', author: { tag: '' } };
    await Indexer.indexMessage(empty);
    expect(fakeChroma._store.has(`message:${oid.toString()}`)).toBe(false);

    const oid2 = new ObjectId();
    const real = {
      _id: oid2,
      role: 'user',
      channel_id: '0',
      content: 'Hello, this is a real message.',
      author: { tag: 'steve' },
      created_at: new Date('2026-04-01T00:00:00Z'),
    };
    await Indexer.indexMessage(real);
    expect(fakeChroma._store.has(`message:${oid2.toString()}`)).toBe(true);
    const meta = fakeChroma._store.get(`message:${oid2.toString()}`).metadata;
    expect(meta.entity_label).toBe('steve');
    expect(meta.role).toBe('user');
    expect(meta.channel_id).toBe('0');
  });
});

describe('rag indexer — degraded paths', () => {
  it('embedTexts throwing leaves the store untouched and surfaces the error', async () => {
    const c = await Characters.createCharacter({
      name: 'Charlie',
      plays_self: true,
      hollywood_actor: '',
      own_voice: true,
      fields: {},
    });
    const Embeddings = await import('../src/rag/embeddings.js');
    const orig = Embeddings.embedTexts;
    Embeddings.embedTexts.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(Indexer.indexCharacter(c._id)).rejects.toThrow(/boom/);
    Embeddings.embedTexts.mockImplementation(orig);
  });
});
