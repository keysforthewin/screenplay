import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import { createFakeChroma } from './_fakeChroma.js';

const fakeDb = createFakeDb();
const fakeChroma = createFakeChroma();

let ragEnabled = true;
let chromaUp = true;

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/rag/chromaClient.js', () => ({
  isRagEnabled: () => ragEnabled,
  getCollection: async () => (chromaUp ? fakeChroma : null),
  chromaHealthcheck: async () => chromaUp,
  resetForTests: () => {},
}));

function fakeVector(text, dim = 16) {
  const v = new Array(dim).fill(0);
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    v[i % dim] += s.charCodeAt(i) / 255;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

vi.mock('../src/rag/embeddings.js', () => ({
  embedTexts: vi.fn(async (texts) => texts.map((t) => fakeVector(t))),
  RagDisabledError: class extends Error {},
}));

const Projects = await import('../src/mongo/projects.js');
const { searchScreenplay } = await import('../src/rag/query.js');

beforeEach(() => {
  fakeDb.reset();
  fakeChroma._store.clear();
  ragEnabled = true;
  chromaUp = true;
});

async function seedChunk({ id, text, projectId, entityType = 'beat' }) {
  await fakeChroma.upsert({
    ids: [id],
    embeddings: [fakeVector(text)],
    metadatas: [{
      entity_type: entityType,
      entity_id: id,
      entity_label: text.slice(0, 20),
      project_id: projectId,
      field: 'body',
      chunk_index: 0,
      text_md: text,
    }],
    documents: [text],
  });
}

describe('searchScreenplay', () => {
  it('filters hits to the given project', async () => {
    const a = await Projects.createProject('Project A');
    const b = await Projects.createProject('Project B');
    const pidA = a._id.toString();
    const pidB = b._id.toString();
    await seedChunk({ id: 'beat:1:body:0', text: 'a tense diner argument', projectId: pidA });
    await seedChunk({ id: 'beat:2:body:0', text: 'a tense diner argument', projectId: pidB });

    const res = await searchScreenplay(pidA, 'diner argument');
    expect(res.ok).toBe(true);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe('beat:1:body:0');
    expect(res.hits[0].text).toBe('a tense diner argument');
    expect(typeof res.hits[0].score).toBe('number');
  });

  it('falsy projectId resolves to the default project (transitional)', async () => {
    const defaultPid = (await Projects.getDefaultProject())._id.toString();
    const other = await Projects.createProject('Other');
    await seedChunk({ id: 'beat:def:body:0', text: 'default project beat', projectId: defaultPid });
    await seedChunk({ id: 'beat:oth:body:0', text: 'default project beat', projectId: other._id.toString() });

    const res = await searchScreenplay(undefined, 'default project beat');
    expect(res.ok).toBe(true);
    expect(res.hits.map((h) => h.id)).toEqual(['beat:def:body:0']);
  });

  it('combines the project filter with entityTypes', async () => {
    const a = await Projects.createProject('Project A');
    const pidA = a._id.toString();
    await seedChunk({ id: 'beat:3:body:0', text: 'rooftop chase at night', projectId: pidA, entityType: 'beat' });
    await seedChunk({ id: 'character:9:name', text: 'rooftop chase at night', projectId: pidA, entityType: 'character' });

    const res = await searchScreenplay(pidA, 'rooftop chase', { entityTypes: ['character'] });
    expect(res.ok).toBe(true);
    expect(res.hits.map((h) => h.id)).toEqual(['character:9:name']);
  });

  it('returns ok:false reason:disabled when RAG is not configured', async () => {
    ragEnabled = false;
    const res = await searchScreenplay(undefined, 'anything');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('disabled');
    expect(res.message).toMatch(/VOYAGE_API_KEY/);
  });

  it('returns ok:false reason:unreachable when Chroma is down', async () => {
    chromaUp = false;
    const res = await searchScreenplay(undefined, 'anything');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unreachable');
    expect(res.message).toMatch(/ChromaDB not reachable/);
  });

  it('returns ok:false reason:bad_project for a malformed projectId', async () => {
    const res = await searchScreenplay('not-hex', 'something');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad_project');
    expect(res.message).toMatch(/bad project/);
  });

  it('clamps k: 999 to 20 (never requests more than 20 results)', async () => {
    const proj = await Projects.createProject('Clamp Test');
    const pid = proj._id.toString();
    // Seed 25 chunks so there are more docs than the max to retrieve.
    for (let i = 0; i < 25; i++) {
      await seedChunk({ id: `beat:clamp${i}:body:0`, text: `scene ${i} content`, projectId: pid });
    }
    const res = await searchScreenplay(pid, 'scene content', { k: 999 });
    expect(res.ok).toBe(true);
    expect(res.hits.length).toBeLessThanOrEqual(20);
  });

  it('entityTypes: [] behaves like undefined (only project filter applied)', async () => {
    const proj = await Projects.createProject('Empty Types Test');
    const pid = proj._id.toString();
    await seedChunk({ id: 'beat:et:body:0', text: 'forest chase scene', projectId: pid, entityType: 'beat' });
    await seedChunk({ id: 'character:et:name', text: 'forest chase scene', projectId: pid, entityType: 'character' });

    const res = await searchScreenplay(pid, 'forest chase scene', { entityTypes: [] });
    expect(res.ok).toBe(true);
    // Both entity types must be present since [] means no type filter.
    const ids = res.hits.map((h) => h.id).sort();
    expect(ids).toContain('beat:et:body:0');
    expect(ids).toContain('character:et:name');
  });
});
