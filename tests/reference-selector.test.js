import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => ({}),
}));

const Characters = await import('../src/mongo/characters.js');
const { createProject } = await import('../src/mongo/projects.js');
const Sel = await import('../src/web/referenceSelector.js');

let projectId;

async function putImageMeta({ name = '', description = '' } = {}) {
  const _id = new ObjectId();
  await fakeDb.collection('images.files').insertOne({
    _id, filename: 'x.png', contentType: 'image/png', length: 10,
    uploadDate: new Date(), metadata: { name, description },
  });
  return _id;
}

async function makeCharacter(name, { sheets = [], mainId = null, images = [] } = {}) {
  const c = await Characters.createCharacter({ projectId, name });
  await fakeDb.collection('characters').updateOne(
    { _id: c._id },
    { $set: { character_sheet_image_ids: sheets, main_image_id: mainId, images } },
  );
  return Characters.getCharacter(projectId, name);
}

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('gatherCandidatesFromDocs', () => {
  it('pulls name/description from GridFS metadata and caption from images[]', async () => {
    const young = await putImageMeta({ name: 'Young Keys', description: 'teenager, school uniform' });
    const old = await putImageMeta({ name: 'Old Keys', description: 'grey-haired, 70s' });
    const extra = await putImageMeta({ name: 'profile', description: '' });
    const c = await makeCharacter('Keys', {
      sheets: [young, old],
      mainId: young,
      images: [{ _id: extra, caption: 'side profile' }],
    });
    const out = await Sel.gatherCandidatesFromDocs([c]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Keys');
    // canonical order: sheets (young, old), then main (young dedup), then images (extra)
    expect(out[0].candidates.map((x) => String(x.id))).toEqual([
      String(young), String(old), String(extra),
    ]);
    expect(out[0].candidates[0]).toMatchObject({ name: 'Young Keys', description: 'teenager, school uniform' });
    expect(out[0].candidates[2]).toMatchObject({ name: 'profile', caption: 'side profile' });
  });
});

describe('formatCandidateManifest', () => {
  it('numbers candidates 1-based and skips empty characters', () => {
    const manifest = Sel.formatCandidateManifest([
      { name: 'Keys', candidates: [
        { id: 'a', name: 'Young Keys', description: 'teen', caption: '' },
        { id: 'b', name: 'Old Keys', description: '70s', caption: 'wrinkled' },
      ] },
      { name: 'Nobody', candidates: [] },
    ]);
    expect(manifest).toContain('Keys:');
    expect(manifest).toContain('1. Young Keys — teen');
    expect(manifest).toContain('2. Old Keys — 70s — caption: wrinkled');
    expect(manifest).not.toContain('Nobody');
  });
});

describe('resolveReferencePicks', () => {
  const perCharacter = [
    { name: 'Keys', candidates: [{ id: 'young' }, { id: 'old' }] },
    { name: 'Mara', candidates: [{ id: 'mara1' }] },
  ];

  it('beat image first, then the LLM-picked image per character', () => {
    const ids = Sel.resolveReferencePicks({
      picks: [{ character: 'Keys', image_index: 2 }],
      perCharacter, beatMainImageId: 'beat',
    });
    expect(ids).toEqual(['beat', 'old', 'mara1']);
  });

  it('falls back to canonical (index 0) when pick is missing or out of range', () => {
    expect(Sel.resolveReferencePicks({ picks: [], perCharacter })).toEqual(['young', 'mara1']);
    expect(Sel.resolveReferencePicks({
      picks: [{ character: 'Keys', image_index: 99 }], perCharacter,
    })).toEqual(['young', 'mara1']);
  });

  it('skips characters with zero candidates and dedupes + caps', () => {
    const ids = Sel.resolveReferencePicks({
      picks: [], beatMainImageId: 'young',
      perCharacter: [{ name: 'Keys', candidates: [{ id: 'young' }] }, { name: 'Ghost', candidates: [] }],
      max: 5,
    });
    expect(ids).toEqual(['young']); // beat == canonical, deduped; Ghost skipped
  });
});

describe('selectBestReferencesForShot', () => {
  async function setupKeys() {
    const young = await putImageMeta({ name: 'Young Keys', description: 'teen' });
    const old = await putImageMeta({ name: 'Old Keys', description: '70s' });
    await makeCharacter('Keys', { sheets: [young, old], mainId: young });
    return { young, old };
  }

  it('uses the LLM pick when available', async () => {
    const { young, old } = await setupKeys();
    Sel._setReferenceSelectorLLMForTests(async () => ({ picks: [{ character: 'Keys', image_index: 2 }] }));
    const ids = await Sel.selectBestReferencesForShot({
      projectId, shotText: 'Close-up on the old man.', characterNames: ['Keys'], beatMainImageId: 'beat',
    });
    expect(ids).toEqual(['beat', String(old)]);
    expect(young).toBeDefined();
  });

  it('falls back to canonical when the LLM throws', async () => {
    const { young } = await setupKeys();
    Sel._setReferenceSelectorLLMForTests(async () => { throw new Error('boom'); });
    const ids = await Sel.selectBestReferencesForShot({
      projectId, shotText: 'x', characterNames: ['Keys'],
    });
    expect(ids).toEqual([String(young)]);
  });

  it('skips the LLM entirely when no character has >1 labeled candidate', async () => {
    const only = await putImageMeta({ name: 'only', description: '' });
    await makeCharacter('Solo', { sheets: [only] });
    const spy = vi.fn(async () => ({ picks: [] }));
    Sel._setReferenceSelectorLLMForTests(spy);
    const ids = await Sel.selectBestReferencesForShot({ projectId, shotText: 'x', characterNames: ['Solo'] });
    expect(spy).not.toHaveBeenCalled();
    expect(ids).toEqual([String(only)]);
  });
});
