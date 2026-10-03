// The artwork climb (critique → generate every proposal → critique) against
// the fake Mongo, on the same mocks as artworkCritiqueGenerate.test.js: the
// model passes come from the analyzer seam, the image provider is a leaf mock.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
const h = vi.hoisted(() => ({ dispatch: { calls: 0, failOnCall: 0, perCall: [] } }));

vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => ({ buffer: Buffer.from('ref'), file: { contentType: 'image/png', metadata: {} } })),
  uploadGeneratedImage: vi.fn(async (_projectId, { filename, contentType }) => ({
    _id: new ObjectId(), filename, content_type: contentType || 'image/png', size: 1024, uploaded_at: new Date(),
  })),
  findImageFile: vi.fn(async (id) => ({ _id: new ObjectId(String(id)), metadata: {} })),
  imageFileToMeta: vi.fn((f) => ({ name: '', description: '' })),
  deleteImage: vi.fn(async () => {}),
}));
vi.mock('../src/fal/client.js', () => ({ isConfigured: () => true }));
vi.mock('../src/mongo/tokenUsage.js', () => ({
  recordOpenAIImageUsage: vi.fn(), recordFalImageUsage: vi.fn(), recordAnthropicTextUsage: vi.fn(), recordAnthropicImageInputUsage: vi.fn(),
}));
vi.mock('../src/fal/imageModelCatalog.js', () => ({
  getImageModel: vi.fn(async () => null),
  loadImageModelCatalog: vi.fn(async () => ({ models: [], generated_at: null, catalog_error: null })),
}));
vi.mock('../src/openai/imageClient.js', () => ({ generateCharacterSheetImage: vi.fn(), generateCharacterSheetImageEdit: vi.fn(), GPT_IMAGE_MODEL: 'gpt-image-2' }));
vi.mock('../src/fal/imageClient.js', () => ({
  generateNanoBananaProImage: async ({ prompt, inputImages } = {}) => {
    h.dispatch.calls += 1;
    h.dispatch.perCall.push({ prompt, inputCount: Array.isArray(inputImages) ? inputImages.length : 0 });
    if (h.dispatch.failOnCall && h.dispatch.calls === h.dispatch.failOnCall) throw new Error('provider boom');
    return { buffer: Buffer.from('img'), contentType: 'image/png' };
  },
  generateFluxKontextImage: vi.fn(), generateFlux2ProImage: vi.fn(), generateGemini25FlashImage: vi.fn(), generateNanoBanana2Image: vi.fn(), generateFlux2KleinImage: vi.fn(),
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext', FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro', NANO_BANANA_PRO_GENERATE_MODEL: 'nano-banana-pro',
  GEMINI_25_FLASH_GENERATE_MODEL: 'fal-ai/gemini-25-flash-image', NANO_BANANA_2_GENERATE_MODEL: 'fal-ai/nano-banana-2', FLUX_2_KLEIN_GENERATE_MODEL: 'fal-ai/flux-2/klein/9b',
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Sets = await import('../src/mongo/sets.js');
const Characters = await import('../src/mongo/characters.js');
const Artworks = await import('../src/mongo/artworks.js');
const AC = await import('../src/mongo/artworkCritiques.js');
const G = await import('../src/web/artworkCritique.js');
const Climb = await import('../src/web/artworkClimb.js');
const Core = await import('../src/web/climbCore.js');
const { getBeatClimb } = await import('../src/mongo/climbs.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');

let projectId;
let setDoc;
let charDoc;
let beat;
let artworkA;
let artworkB;

const finished = async (beatId) => {
  for (let i = 0; i < 400; i++) {
    if (!Core.isClimbRunning('artwork', beatId)) return getBeatClimb(projectId, beatId, 'artwork');
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('climb did not finish');
};

beforeEach(async () => {
  fakeDb.reset();
  h.dispatch.calls = 0; h.dispatch.failOnCall = 0; h.dispatch.perCall = [];
  projectId = (await createProject('P'))._id.toString();
  setDoc = await Sets.createSet({ projectId, name: 'Theatre lot', description: 'A cinema car park at dusk.' });
  charDoc = await Characters.createCharacter({ projectId, name: 'Sarah', hollywood_actor: 'Jodie Comer', fields: {} });
  artworkA = (await Artworks.appendDoneArtwork({ projectId, hostType: 'set', hostId: setDoc._id, resultImageId: new ObjectId(), name: 'Lot front' })).artwork;
  artworkB = (await Artworks.appendDoneArtwork({ projectId, hostType: 'set', hostId: setDoc._id, resultImageId: new ObjectId(), name: 'Lot side' })).artwork;
  beat = await Plots.createBeat({ projectId, name: 'Arrival', body: 'EXT. THEATRE LOT — DUSK\nSarah slams the car door.', sets: ['Theatre lot'], characters: ['Sarah'] });
});
afterEach(() => { G._setArtworkCritiqueAnalyzerForTests(null); _setAnthropicClientForTests(null); });

// `covers(subject, artworks)` decides whether the audit calls everything covered.
function analyzer(covers) {
  return {
    requirements: async () => ({
      requirements: [
        { subject_id: String(setDoc._id), subject_kind: 'set', category: 'view', summary: 'Lot from the entrance', detail: 'dusk', quote: 'EXT. THEATRE LOT — DUSK', importance: 'essential' },
        { subject_id: String(setDoc._id), subject_kind: 'set', category: 'vehicle', summary: 'The car', detail: 'a sedan', quote: 'slams the car door', importance: 'useful' },
      ],
      unlinked_mentions: [],
    }),
    audit: async ({ subject, artworks }) => ({
      coverage: [
        { requirement_id: `set:${setDoc._id}:1`, status: 'covered', artwork_indexes: [1], note: 'front plate' },
        covers(subject, artworks)
          ? { requirement_id: `set:${setDoc._id}:2`, status: 'covered', artwork_indexes: [artworks.length], note: 'the car' }
          : { requirement_id: `set:${setDoc._id}:2`, status: 'missing', artwork_indexes: [], note: 'no car in any plate' },
      ],
      artworks: [],
      accuracy_score: 6,
      summary: `audit of ${subject.name}`,
    }),
    proposals: async ({ text, subject, requirements }) => {
      proposalTexts.push(text);
      return { proposals: requirements.map((r) => ({ requirement_ids: [r.id], name: `Gen ${r.summary}`, prompt: `render ${r.summary}`, reference_indexes: subject.kind === 'set' ? [1] : [], rationale: 'needed' })) };
    },
  };
}

let proposalTexts;
beforeEach(async () => {
  proposalTexts = [];
  // The character has no requirements in these tests; keep the beat to the set.
  await Plots.updateBeat(projectId, beat._id.toString(), { characters: [] });
  _setAnthropicClientForTests({ messages: { create: async () => ({ content: [{ type: 'text', text: 'WALL: the car never appears.' }] }) } });
});

describe('startArtworkClimb', () => {
  it('rejects a bad target, an unknown beat and a missing model', async () => {
    await expect(Climb.startArtworkClimb({ projectId, beatId: beat._id.toString(), params: { target: 0, model: 'nano-banana-pro' } })).rejects.toMatchObject({ status: 400 });
    await expect(Climb.startArtworkClimb({ projectId, beatId: '999', params: { target: 90, model: 'nano-banana-pro' } })).rejects.toMatchObject({ status: 404 });
    await expect(Climb.startArtworkClimb({ projectId, beatId: beat._id.toString(), params: { target: 90, model: 'no-such-model' } })).rejects.toMatchObject({ status: 400 });
  });

  it('generates the proposals and stops when coverage reaches the target', async () => {
    G._setArtworkCritiqueAnalyzerForTests(analyzer((_s, artworks) => artworks.length > 2));
    const id = beat._id.toString();
    const started = await Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro', direction: 'wet tarmac' } });
    expect(started.status).toBe('running');
    // The climb owns the beat: the manual routes are refused meanwhile.
    await expect(G.startArtworkCritiqueJob({ projectId, beatId: id })).rejects.toMatchObject({ status: 409 });
    await expect(Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro' } })).rejects.toMatchObject({ status: 409 });
    const climb = await finished(id);
    expect(climb).toMatchObject({ status: 'done', stop_reason: 'target', start_score: 67, best_score: 100, wall_summary: null, model: 'nano-banana-pro' });
    expect(climb.attempts).toHaveLength(1);
    expect(climb.attempts[0]).toMatchObject({ n: 1, score: 100, kept: true });
    expect(climb.attempts[0].detail.rendered).toBe(1);
    expect(h.dispatch.calls).toBe(1);
    expect(proposalTexts[0]).toContain('wet tarmac');
    const fresh = await Sets.getSet(projectId, String(setDoc._id));
    expect(fresh.artworks).toHaveLength(3);
    // Released: a manual critique can start again.
    await expect(G.startArtworkCritiqueJob({ projectId, beatId: id })).resolves.toBeTruthy();
  });

  it('stops after N rounds without a gain and stores why it hit the wall', async () => {
    G._setArtworkCritiqueAnalyzerForTests(analyzer(() => false));
    const id = beat._id.toString();
    await Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro', stop_after: 2 } });
    const climb = await finished(id);
    expect(climb).toMatchObject({ status: 'done', stop_reason: 'stalled', start_score: 67, best_score: 67, stalls: 2 });
    expect(climb.attempts.map((a) => a.kept)).toEqual([false, false]);
    expect(climb.wall_summary).toBe('WALL: the car never appears.');
    expect(h.dispatch.calls).toBe(2);
    expect((await Core.getClimbView(projectId, id, 'artwork')).stop_reason).toBe('stalled');
  });

  it('ends with an error when every render fails', async () => {
    G._setArtworkCritiqueAnalyzerForTests(analyzer(() => false));
    h.dispatch.failOnCall = 1;
    const id = beat._id.toString();
    await Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro' } });
    const climb = await finished(id);
    expect(climb.status).toBe('error');
    expect(climb.error).toMatch(/No artwork could be rendered/);
  });
});
