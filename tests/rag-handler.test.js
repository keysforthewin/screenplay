import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';
import { createFakeChroma } from './_fakeChroma.js';

const fakeDb = createFakeDb();
const fakeChroma = createFakeChroma();

const ragState = { enabled: true };

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/rag/chromaClient.js', () => ({
  isRagEnabled: () => ragState.enabled,
  getCollection: async () => (ragState.enabled ? fakeChroma : null),
  chromaHealthcheck: async () => true,
  resetForTests: () => {},
}));

function fakeVector(text, dim = 16) {
  const v = new Array(dim).fill(0);
  const s = String(text);
  for (let i = 0; i < s.length; i++) v[i % dim] += s.charCodeAt(i) / 255;
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

vi.mock('../src/rag/embeddings.js', () => ({
  embedTexts: vi.fn(async (texts) => texts.map((t) => fakeVector(t))),
  RagDisabledError: class extends Error {},
}));

const Plots = await import('../src/mongo/plots.js');
const Indexer = await import('../src/rag/indexer.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
  fakeChroma._store.clear();
  ragState.enabled = true;
});

describe('screenplay_search handler', () => {
  it('returns a friendly error when RAG is not configured', async () => {
    ragState.enabled = false;
    const out = await HANDLERS.screenplay_search({ query: 'anything' });
    expect(out).toMatch(/unavailable/);
    expect(out).toMatch(/VOYAGE_API_KEY/);
  });

  it('errors when query is missing', async () => {
    const out = await HANDLERS.screenplay_search({});
    expect(out).toMatch(/^Error: `query` is required/);
  });

  it('returns formatted JSON with provenance for indexed beats', async () => {
    const beat = await Plots.createBeat({
      name: 'Diner Argument',
      desc: 'Alice and Bob fight at the diner over the affair.',
      body: 'Alice slams down the menu. The waitress avoids eye contact. Bob says nothing.',
    });
    await Indexer.indexBeat(beat._id);
    const out = await HANDLERS.screenplay_search({ query: 'Alice and Bob diner', k: 3 });
    const parsed = JSON.parse(out);
    expect(parsed.match_count).toBeGreaterThan(0);
    const top = parsed.results[0];
    expect(top.entity_type).toBe('beat');
    expect(top.entity_id).toBe(beat._id.toString());
    expect(top.entity_label).toBe('Diner Argument');
    expect(['name', 'desc', 'body']).toContain(top.field);
    expect(typeof top.text).toBe('string');
    expect(typeof top.score).toBe('number');
    expect(top.score).toBeGreaterThanOrEqual(0);
    expect(top.score).toBeLessThanOrEqual(1);
  });

  it('respects entity_types filter', async () => {
    const beat = await Plots.createBeat({
      name: 'Open',
      desc: 'opening scene',
      body: 'the bag is heavy',
    });
    await Indexer.indexBeat(beat._id);
    // Insert a fake message chunk directly so the filter has something to exclude.
    const oid = new ObjectId();
    await Indexer.indexMessage({
      _id: oid,
      role: 'user',
      channel_id: '0',
      author: { tag: 'a' },
      content: 'the bag is heavy',
      created_at: new Date(),
    });
    const out = await HANDLERS.screenplay_search({
      query: 'bag',
      k: 5,
      entity_types: ['beat'],
    });
    const parsed = JSON.parse(out);
    for (const r of parsed.results) {
      expect(r.entity_type).toBe('beat');
    }
  });
});
