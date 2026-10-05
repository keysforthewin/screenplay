// The artwork critique pipeline and its generation job against the fake Mongo.
// The three model passes come from the analyzer seam; the image provider is
// the same leaf mock imageSheetJobs.test.js uses, so pending-artwork creation,
// inline rendering and result persistence run through the real gateway.
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

let projectId;
let setDoc;
let charDoc;
let beat;
let artworkA;
let artworkB;

const settle = async (jobId, get) => {
  for (let i = 0; i < 200; i++) {
    const j = get(jobId);
    if (!j || ['done', 'partial', 'error'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish');
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
afterEach(() => G._setArtworkCritiqueAnalyzerForTests(null));

function stdAnalyzer(overrides = {}) {
  return {
    requirements: async () => ({
      requirements: [
        { subject_id: String(setDoc._id), subject_kind: 'set', category: 'view', summary: 'Lot from the entrance', detail: 'dusk', quote: 'EXT. THEATRE LOT — DUSK', importance: 'essential' },
        { subject_id: String(setDoc._id), subject_kind: 'set', category: 'vehicle', summary: 'The car', detail: 'a sedan', quote: 'slams the car door', importance: 'useful' },
        { subject_id: String(charDoc._id), subject_kind: 'character', category: 'expression', summary: 'Fury', detail: 'jaw set', quote: 'slams', importance: 'essential' },
      ],
      unlinked_mentions: [{ name: 'Car', kind: 'set', quote: 'the car door' }],
    }),
    // Per artwork: A covers the first set requirement, B fits nothing and is too bright.
    audit: async ({ artworks }) => ({
      artworks: artworks.map((a, i) => {
        if (String(a._id) === String(artworkA._id)) return { index: i + 1, fits: [{ requirement_id: `set:${setDoc._id}:1`, fit: 'covered', lacking: '' }], score: 6, issues: [], suggested_edit: '' };
        if (String(a._id) === String(artworkB._id)) return { index: i + 1, fits: [], score: 6, issues: [{ kind: 'light', note: 'daylight, beat is dusk' }], suggested_edit: 'Grade to dusk.' };
        return { index: i + 1, fits: [], score: 5, issues: [], suggested_edit: '' };
      }),
    }),
    proposals: async ({ subject, requirements }) => ({
      proposals: requirements.map((r) => ({ requirement_ids: [r.id], name: `Gen ${r.summary}`, prompt: `render ${r.summary}`, reference_indexes: subject.kind === 'set' ? [1] : [], rationale: 'needed' })),
    }),
    ...overrides,
  };
}

describe('runArtworkCritique', () => {
  it('audits a set with artwork, treats a character with none as all-missing, and stores proposals', async () => {
    const auditCalls = [];
    G._setArtworkCritiqueAnalyzerForTests(stdAnalyzer({ audit: async (args) => { auditCalls.push(args.subject.kind); return stdAnalyzer().audit(args); } }));
    const job = G.createArtworkCritiqueJob(beat._id.toString());
    const snaps = [];
    G.subscribeToArtworkCritiqueJob(job.job_id, (s) => snaps.push(s));
    const done = await G.runArtworkCritique({ projectId, job });
    expect(done.status).toBe('done');
    expect(auditCalls).toEqual(['set']); // the character has no artwork → no vision call
    const c = await AC.getBeatArtworkCritique(projectId, beat._id.toString());
    expect(c.status).toBe('done');
    expect(c.unlinked_mentions[0].name).toBe('Car');
    expect(c.warnings.some((w) => /Sarah has no artwork/.test(w))).toBe(true);
    const set = c.subjects.find((s) => s.kind === 'set');
    expect(set.status).toBe('done');
    expect(set.accuracy_score).toBe(6);
    expect(set.requirements.map((r) => r.status)).toEqual(['covered', 'missing']);
    expect(String(set.requirements[0].covered_by[0])).toBe(String(artworkA._id));
    expect(set.artworks.find((a) => String(a.artwork_id) === String(artworkB._id)).suggested_edit).toBe('Grade to dusk.');
    const ch = c.subjects.find((s) => s.kind === 'character');
    expect(ch.requirements).toHaveLength(1);
    expect(ch.requirements[0].status).toBe('missing');
    expect(ch.accuracy_score).toBeNull();
    expect(c.proposals).toHaveLength(2);
    const setProp = c.proposals.find((p) => p.host_type === 'set');
    expect(String(setProp.host_id)).toBe(String(setDoc._id));
    expect(setProp.status).toBe('proposed');
    expect(setProp.reference_image_ids.map(String)).toEqual([String(artworkA.result_image_id)]);
    const chProp = c.proposals.find((p) => p.host_type === 'character');
    expect(chProp.prompt).toContain('Jodie Comer');
    expect(chProp.reference_image_ids).toEqual([]);
    // essential covered (2) + useful missing (1) + essential missing (2): 2/5 → 40%
    // quality: the covering plate scores 6/10 → 2 × 0.6 / 5 → 24%
    expect(c.coverage).toEqual({ total: 3, covered: 1, partial: 0, missing: 2, reviewed: 1, pct: 40, quality_pct: 24 });
    expect(set.inventory).toMatchObject({ total: 2, matched: 2, reviewed: 2 });
    // The page follows the run: matching, then the review.
    expect(snaps.map((s) => s.phase)).toEqual(expect.arrayContaining(['requirements', 'matching', 'auditing', 'done']));
    expect(snaps.at(-1).subjects.find((s) => s.kind === 'set')).toMatchObject({ audited: 2, reused: 0 });
    expect(snaps.at(-1).status).toBe('done');
    expect(snaps.at(-1).subjects.find((s) => s.kind === 'set')).toMatchObject({ status: 'done', requirement_count: 2, covered: 1, missing: 1 });
  });

  it('marks one failing subject as error and the run partial', async () => {
    G._setArtworkCritiqueAnalyzerForTests(stdAnalyzer({ audit: async () => { throw new Error('vision boom'); } }));
    const job = G.createArtworkCritiqueJob(beat._id.toString());
    const done = await G.runArtworkCritique({ projectId, job });
    expect(done.status).toBe('partial');
    const c = await AC.getBeatArtworkCritique(projectId, beat._id.toString());
    expect(c.subjects.find((s) => s.kind === 'set')).toMatchObject({ status: 'error', error_message: 'vision boom' });
    expect(c.subjects.find((s) => s.kind === 'character').status).toBe('done');
  });

  it('finishes with a warning when the beat has no linked subjects', async () => {
    const bare = await Plots.createBeat({ projectId, name: 'Bare', body: 'b' });
    G._setArtworkCritiqueAnalyzerForTests({});
    const job = G.createArtworkCritiqueJob(bare._id.toString());
    const done = await G.runArtworkCritique({ projectId, job });
    expect(done.status).toBe('done');
    expect(done.warnings[0]).toMatch(/no linked sets or characters/);
  });

  it('a second run reuses the requirements, the audits and the proposals — no model call at all', async () => {
    const calls = { requirements: 0, audit: 0, proposals: 0 };
    const counted = (over = {}) => {
      const base = stdAnalyzer(over);
      return {
        requirements: async (a) => { calls.requirements += 1; return base.requirements(a); },
        audit: async (a) => { calls.audit += 1; return base.audit(a); },
        proposals: async (a) => { calls.proposals += 1; return base.proposals(a); },
      };
    };
    G._setArtworkCritiqueAnalyzerForTests(counted());
    const id = beat._id.toString();
    await G.runArtworkCritique({ projectId, job: G.createArtworkCritiqueJob(id) });
    expect(calls).toEqual({ requirements: 1, audit: 1, proposals: 2 });
    const first = await AC.getBeatArtworkCritique(projectId, id);
    await G.setProposalStatus({ projectId, beatId: id, proposalId: first.proposals[0]._id, status: 'dismissed' });

    const second = await G.runArtworkCritique({ projectId, job: G.createArtworkCritiqueJob(id) });
    expect(second.status).toBe('done');
    expect(calls).toEqual({ requirements: 1, audit: 1, proposals: 2 });
    const c = await AC.getBeatArtworkCritique(projectId, id);
    expect(c.proposals.map((p) => String(p._id))).toEqual(first.proposals.map((p) => String(p._id)));
    expect(c.proposals[0].status).toBe('dismissed'); // a dismissal survives the re-run
    expect(c.coverage).toEqual(first.coverage);
    expect(second.subjects.find((s) => s.kind === 'set')).toMatchObject({ audited: 0, reused: 2 });

    // One image changes: only that artwork goes back to vision.
    const seen = [];
    G._setArtworkCritiqueAnalyzerForTests(counted({ audit: async (a) => { seen.push(a.artworks.map((x) => String(x._id))); return stdAnalyzer().audit(a); } }));
    await fakeDb.collection('sets').updateOne({ _id: setDoc._id, 'artworks._id': artworkB._id }, { $set: { 'artworks.$.result_image_id': new ObjectId() } });
    await G.runArtworkCritique({ projectId, job: G.createArtworkCritiqueJob(id) });
    expect(seen).toEqual([[String(artworkB._id)]]);
    expect(calls.requirements).toBe(1);

    // force: everything again.
    await G.runArtworkCritique({ projectId, job: G.createArtworkCritiqueJob(id, { force: true }) });
    expect(calls.requirements).toBe(2);
    expect(seen.at(-1)).toHaveLength(2);
  });

  it('check coverage starts from nothing and looks at no image; check quality reviews in place, again each time', async () => {
    const calls = { requirements: 0, audit: 0, proposals: 0 };
    const base = stdAnalyzer();
    G._setArtworkCritiqueAnalyzerForTests({
      requirements: async (a) => { calls.requirements += 1; return base.requirements(a); },
      audit: async (a) => { calls.audit += 1; return base.audit(a); },
      proposals: async (a) => { calls.proposals += 1; return base.proposals(a); },
    });
    const id = beat._id.toString();
    const Climbs = await import('../src/mongo/climbs.js');
    await Climbs.setBeatClimb(projectId, id, 'artwork', { kind: 'artwork', status: 'done', stop_reason: 'stalled' });

    // Quality before any coverage check: refused.
    await expect(G.startArtworkCritiqueJob({ projectId, beatId: id, stage: 'quality' })).rejects.toMatchObject({ status: 409 });

    const cov = await G.startArtworkCritiqueJob({ projectId, beatId: id, stage: 'coverage' });
    expect(await Climbs.getBeatClimb(projectId, id, 'artwork')).toBeNull(); // a manual run ends the climb
    const covJob = await settle(cov, G.getArtworkCritiqueJob);
    expect(covJob).toMatchObject({ status: 'done', stage: 'coverage', review_mode: 'none' });
    expect(calls).toMatchObject({ requirements: 1, audit: 0 });
    let c = await AC.getBeatArtworkCritique(projectId, id);
    const setSubject = () => c.subjects.find((s) => s.kind === 'set');
    expect(setSubject().artworks.length).toBeGreaterThan(0);
    expect(setSubject().artworks.every((a) => a.audited_image_id == null && a.score == null)).toBe(true);
    // The character has no artwork: its requirement is missing and drafted.
    expect(c.proposals.some((p) => p.host_type === 'character' && p.status === 'proposed')).toBe(true);
    expect(c.coverage.reviewed).toBe(0);

    // Quality: the pieces are looked at; the requirements are not derived again.
    await settle(await G.startArtworkCritiqueJob({ projectId, beatId: id, stage: 'quality' }), G.getArtworkCritiqueJob);
    expect(calls).toMatchObject({ requirements: 1, audit: 1 });
    c = await AC.getBeatArtworkCritique(projectId, id);
    expect(setSubject().artworks.some((a) => a.audited_image_id)).toBe(true);

    // Quality again: nothing changed, and everything is still looked at again.
    await settle(await G.startArtworkCritiqueJob({ projectId, beatId: id, stage: 'quality' }), G.getArtworkCritiqueJob);
    expect(calls).toMatchObject({ requirements: 1, audit: 2 });

    // Coverage again wipes the reviews and derives the requirements again.
    await settle(await G.startArtworkCritiqueJob({ projectId, beatId: id, stage: 'coverage' }), G.getArtworkCritiqueJob);
    expect(calls).toMatchObject({ requirements: 2, audit: 2 });
    c = await AC.getBeatArtworkCritique(projectId, id);
    expect(setSubject().artworks.every((a) => a.audited_image_id == null)).toBe(true);
  });

  it('clearArtworkCritique removes the critique and the climb status; 409 while a run is going', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    G._setArtworkCritiqueAnalyzerForTests(stdAnalyzer({ requirements: async () => { await gate; return stdAnalyzer().requirements(); } }));
    const id = beat._id.toString();
    const jobId = await G.startArtworkCritiqueJob({ projectId, beatId: id });
    await expect(G.clearArtworkCritique({ projectId, beatId: id })).rejects.toMatchObject({ status: 409 });
    release();
    await settle(jobId, G.getArtworkCritiqueJob);
    const Climbs = await import('../src/mongo/climbs.js');
    await Climbs.setBeatClimb(projectId, id, 'artwork', { kind: 'artwork', status: 'done' });
    await G.clearArtworkCritique({ projectId, beatId: id });
    expect(await AC.getBeatArtworkCritique(projectId, id)).toBeNull();
    expect(await Climbs.getBeatClimb(projectId, id, 'artwork')).toBeNull();
  });

  it('coverage comes from the descriptions; the review confirms or rejects it; a climb still filling coverage reviews nothing on file', async () => {
    const id = beat._id.toString();
    const looked = [];
    const R = (n) => `set:${setDoc._id}:${n}`;
    const analyzer = stdAnalyzer({
      // By description: A is the entrance view, B is the car.
      match: async ({ text }) => {
        expect(text).toContain('1. "Lot front"');
        return {
          matches: [
            { requirement_id: R(1), artworks: [{ index: 1, fit: 'covered', lacking: '' }] },
            { requirement_id: R(2), artworks: [{ index: 2, fit: 'partial', lacking: 'door not described' }] },
          ],
          duplicate_groups: [],
        };
      },
      // Looked at: A is right; B turns out not to be the car at all.
      audit: async ({ artworks, text }) => {
        looked.push(artworks.map((a) => String(a._id)));
        expect(text).toContain(`[description suggests: ${R(1)}]`);
        return {
          artworks: artworks.map((a, i) => (String(a._id) === String(artworkA._id)
            ? { index: i + 1, fits: [{ requirement_id: R(1), fit: 'covered', lacking: '' }], criteria: ['requirement', 'beat', 'subject', 'reference', 'technical'].map((key) => ({ key, score: 8, note: 'ok' })), issues: [], action: 'keep', suggested_edit: '', regenerate_reason: '' }
            : { index: i + 1, fits: [], criteria: ['requirement', 'beat', 'subject', 'reference', 'technical'].map((key) => ({ key, score: 3, note: 'a van' })), issues: [], action: 'regenerate', suggested_edit: '', regenerate_reason: 'It is a van, not the sedan.' })),
        };
      },
    });
    G._setArtworkCritiqueAnalyzerForTests(analyzer);
    // A climb's run ('auto') with the character's requirement missing: phase 1 only.
    await G.runArtworkCritiqueForClimb({ projectId, beatId: id });
    expect(looked).toEqual([]);
    let c = await AC.getBeatArtworkCritique(projectId, id);
    let set = c.subjects.find((s) => s.kind === 'set');
    expect(set.requirements.map((r) => r.status)).toEqual(['covered', 'partial']);
    expect(set.artworks.map((e) => [e.score, e.audited_image_id])).toEqual([[null, null], [null, null]]);
    // set 2 + 1 answered of 5 → 60% covered; nothing looked at → quality 0
    expect(c.coverage).toMatchObject({ pct: 60, quality_pct: 0, reviewed: 0, missing: 1 });
    expect(c.proposals.map((p) => p.host_type)).toEqual(['character']); // only what is missing gets a proposal

    // The manual run reviews: the reviewer rejects B, so the car is missing after all.
    await G.runArtworkCritique({ projectId, job: G.createArtworkCritiqueJob(id) });
    expect(looked).toEqual([[String(artworkA._id), String(artworkB._id)]]);
    c = await AC.getBeatArtworkCritique(projectId, id);
    set = c.subjects.find((s) => s.kind === 'set');
    expect(set.requirements.map((r) => r.status)).toEqual(['covered', 'missing']);
    const b = set.artworks.find((e) => String(e.artwork_id) === String(artworkB._id));
    expect(b).toMatchObject({ score: 3, action: 'regenerate', regenerate_reason: 'It is a van, not the sedan.', fits: [] });
    expect(set.artworks.find((e) => String(e.artwork_id) === String(artworkA._id))).toMatchObject({ score: 8, action: 'keep' });
    expect(c.coverage).toMatchObject({ pct: 40, quality_pct: 32, reviewed: 1 });
    expect(c.proposals.map((p) => p.host_type).sort()).toEqual(['character', 'set']);
  });

  it('a large library is matched by description: every artwork is read, only the candidates go to vision', async () => {
    const extra = [];
    for (let i = 0; i < 38; i++) {
      extra.push((await Artworks.appendDoneArtwork({ projectId, hostType: 'set', hostId: setDoc._id, resultImageId: new ObjectId(), name: `Plate ${i}` })).artwork);
    }
    const described = [];
    const shortlistSaw = [];
    const audited = [];
    const carId = String(extra[30]._id);
    G._setArtworkCritiqueAnalyzerForTests(stdAnalyzer({
      describe: async ({ artwork }) => { described.push(String(artwork._id)); return `what ${artwork.name} shows`; },
      shortlist: async ({ artworks, text }) => {
        shortlistSaw.push(artworks.length);
        expect(text).toContain('what Plate 37 shows');
        // artwork 1 = Lot front, artwork 33 = Plate 30 (the car); 5 and 6 are the same picture.
        return {
          candidates: [
            { requirement_id: `set:${setDoc._id}:1`, artwork_indexes: [1] },
            { requirement_id: `set:${setDoc._id}:2`, artwork_indexes: [33] },
          ],
          duplicate_groups: [[5, 6], [9]],
        };
      },
      audit: async ({ artworks }) => {
        audited.push(artworks.map((a) => String(a._id)));
        return {
          artworks: artworks.map((a, i) => ({
            index: i + 1,
            fits: String(a._id) === carId
              ? [{ requirement_id: `set:${setDoc._id}:2`, fit: 'partial', lacking: 'the door is closed' }]
              : [{ requirement_id: `set:${setDoc._id}:1`, fit: 'covered', lacking: '' }],
            score: 8,
            issues: [],
            suggested_edit: String(a._id) === carId ? 'Open the driver door.' : '',
          })),
        };
      },
    }));
    const id = beat._id.toString();
    const job = await G.runArtworkCritique({ projectId, job: G.createArtworkCritiqueJob(id) });
    expect(job.status).toBe('done');
    expect(job.warnings.some((w) => /only the newest/.test(w))).toBe(false);
    expect(described).toHaveLength(40);
    expect(shortlistSaw).toEqual([40]);
    expect(audited).toEqual([[String(artworkA._id), carId]]);
    const c = await AC.getBeatArtworkCritique(projectId, id);
    const set = c.subjects.find((s) => s.kind === 'set');
    expect(set.inventory).toMatchObject({ total: 40, matched: 2, reviewed: 2 });
    expect(set.inventory.duplicates.map((g) => g.map(String))).toEqual([[String(extra[2]._id), String(extra[3]._id)]]);
    expect(set.requirements.map((r) => r.status)).toEqual(['covered', 'partial']);
    expect(set.requirements[1].note).toBe('the door is closed');
    expect(String(set.requirements[1].covered_by[0])).toBe(carId);
    expect(set.summary).toContain('40 artworks on file, 2 matched to this beat by description, 2 reviewed');

    // Again with nothing changed: no describe, no shortlist, no vision.
    await G.runArtworkCritique({ projectId, job: G.createArtworkCritiqueJob(id) });
    expect(shortlistSaw).toEqual([40]);
    expect(audited).toHaveLength(1);
  });

  it('startArtworkCritiqueJob: 404 unknown beat, 409 while running', async () => {
    await expect(G.startArtworkCritiqueJob({ projectId, beatId: new ObjectId().toString() })).rejects.toMatchObject({ status: 404 });
    let release;
    const gate = new Promise((r) => { release = r; });
    G._setArtworkCritiqueAnalyzerForTests(stdAnalyzer({ requirements: async () => { await gate; return stdAnalyzer().requirements(); } }));
    const id = await G.startArtworkCritiqueJob({ projectId, beatId: beat._id.toString() });
    await expect(G.startArtworkCritiqueJob({ projectId, beatId: beat._id.toString() })).rejects.toMatchObject({ status: 409 });
    release();
    await settle(id, G.getArtworkCritiqueJob);
  });
});

describe('startArtworkGenerateJob', () => {
  async function critiqued() {
    G._setArtworkCritiqueAnalyzerForTests(stdAnalyzer());
    const job = G.createArtworkCritiqueJob(beat._id.toString());
    await G.runArtworkCritique({ projectId, job });
    return AC.getBeatArtworkCritique(projectId, beat._id.toString());
  }

  it('renders the selected proposals onto their hosts, persists overrides, marks requirements covered', async () => {
    const c = await critiqued();
    const setProp = c.proposals.find((p) => p.host_type === 'set');
    const chProp = c.proposals.find((p) => p.host_type === 'character');
    const { job_id, planned } = await G.startArtworkGenerateJob({
      projectId, beatId: beat._id.toString(), proposalIds: [String(setProp._id), String(chProp._id)], model: 'nano-banana-pro',
      overrides: { [String(chProp._id)]: { prompt: 'OVERRIDDEN PROMPT' } },
    });
    expect(planned).toBe(2);
    const job = await settle(job_id, G.getArtworkGenerateJob);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(2);
    expect(h.dispatch.calls).toBe(2);
    expect(h.dispatch.perCall.some((x) => x.prompt === 'OVERRIDDEN PROMPT')).toBe(true);
    const after = await AC.getBeatArtworkCritique(projectId, beat._id.toString());
    for (const p of after.proposals) {
      expect(p.status).toBe('done');
      expect(p.model).toBe('nano-banana-pro');
      expect(p.artwork_id).toBeTruthy();
    }
    expect(after.proposals.find((p) => p.host_type === 'character').prompt).toBe('OVERRIDDEN PROMPT');
    const freshSet = await Sets.getSet(projectId, setDoc._id.toString());
    const generated = freshSet.artworks.find((a) => String(a._id) === String(after.proposals.find((p) => p.host_type === 'set').artwork_id));
    expect(generated).toMatchObject({ status: 'done', name: 'Gen The car' });
    const freshChar = await Characters.getCharacter(projectId, charDoc._id.toString());
    expect(freshChar.artworks.some((a) => a.status === 'done')).toBe(true);
    const setSubject = after.subjects.find((s) => s.kind === 'set');
    expect(setSubject.requirements[1].status).toBe('covered');
    expect(after.coverage.pct).toBe(100);
  });

  it('a failed render marks the proposal and artwork error and the job partial; dismissed proposals never render', async () => {
    const c = await critiqued();
    const [p1, p2] = c.proposals;
    await G.setProposalStatus({ projectId, beatId: beat._id.toString(), proposalId: p2._id, status: 'dismissed' });
    h.dispatch.failOnCall = 1;
    const { job_id, planned } = await G.startArtworkGenerateJob({ projectId, beatId: beat._id.toString(), proposalIds: [String(p1._id), String(p2._id)], model: 'nano-banana-pro' });
    expect(planned).toBe(1);
    const job = await settle(job_id, G.getArtworkGenerateJob);
    expect(job.status).toBe('error'); // the only planned render failed
    expect(job.failed).toBe(1);
    const after = await AC.getBeatArtworkCritique(projectId, beat._id.toString());
    expect(after.proposals.find((p) => String(p._id) === String(p1._id))).toMatchObject({ status: 'error', error_message: 'provider boom' });
    expect(after.proposals.find((p) => String(p._id) === String(p2._id)).status).toBe('dismissed');
    const host = p1.host_type === 'set' ? await Sets.getSet(projectId, setDoc._id.toString()) : await Characters.getCharacter(projectId, charDoc._id.toString());
    expect(host.artworks.some((a) => a.status === 'error')).toBe(true);
    expect(h.dispatch.calls).toBe(1);
  });

  it('anchors every character render on the portrait — including a retry of a stale proposal that carried only a set plate', async () => {
    const Images = await import('../src/mongo/images.js');
    const portrait = new ObjectId();
    const plate = String(artworkA.result_image_id);
    Images.findImageFile.mockImplementation(async (id) => ({ _id: new ObjectId(String(id)), metadata: String(id) === plate ? { owner_type: 'set' } : {} }));
    await fakeDb.collection('characters').updateOne({ _id: charDoc._id }, { $set: { main_image_id: portrait, images: [{ _id: portrait }] } });
    const c = await critiqued();
    const chProp = c.proposals.find((p) => p.host_type === 'character');
    // A proposal as the pre-portrait code stored it: old authority sentence, one set plate, no picture of the person.
    await AC.updateArtworkCritiqueProposal(projectId, beat._id, chProp._id, {
      prompt: 'Subject: a person.\nThe attached reference images are the authority on this person\'s appearance: exact same face.\n\nseated at the window\n\nSTRICT OUTPUT RULES:\n- one person',
      reference_image_ids: [new ObjectId(plate)],
    });
    const beatId = beat._id.toString();

    h.dispatch.failOnCall = 1;
    let { job_id } = await G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [String(chProp._id)], model: 'nano-banana-pro' });
    expect((await settle(job_id, G.getArtworkGenerateJob)).status).toBe('error');
    expect(h.dispatch.perCall[0].inputCount).toBe(2); // portrait + plate, even on the first (failed) try

    // Retry the failed proposal: same anchoring, the portrait still leads.
    h.dispatch.failOnCall = 0;
    ({ job_id } = await G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [String(chProp._id)], model: 'nano-banana-pro' }));
    expect((await settle(job_id, G.getArtworkGenerateJob)).status).toBe('done');
    expect(h.dispatch.perCall[1].inputCount).toBe(2);
    expect(h.dispatch.perCall[1].prompt).toMatch(/^Subject: a person\.\nReference image 1 is this person's portrait/);
    expect(h.dispatch.perCall[1].prompt).toContain('Reference image 2 shows the PLACE only');
    expect(h.dispatch.perCall[1].prompt).not.toContain('attached reference images are the authority');
    expect(h.dispatch.perCall[1].prompt).toContain('seated at the window');
    const after = await AC.getBeatArtworkCritique(projectId, beatId);
    const stored = after.proposals.find((p) => String(p._id) === String(chProp._id));
    expect(stored.reference_image_ids.map(String)).toEqual([String(portrait), plate]);
    const freshChar = await Characters.getCharacter(projectId, charDoc._id.toString());
    const art = freshChar.artworks.find((a) => String(a._id) === String(stored.artwork_id));
    expect(art.generation.reference_image_ids).toEqual([String(portrait), plate]);
    Images.findImageFile.mockImplementation(async (id) => ({ _id: new ObjectId(String(id)), metadata: {} }));
  });

  it('wardrobe lock: quotes the locked words in pass A and the prompt, attaches the plate at 2, and auto-promotes the first costume render', async () => {
    const Images = await import('../src/mongo/images.js');
    const portrait = new ObjectId();
    await fakeDb.collection('characters').updateOne({ _id: charDoc._id }, { $set: { main_image_id: portrait, images: [{ _id: portrait }], fields: { wardrobe: 'navy flannel shirt, tan canvas jacket' } } });
    let rosterText = '';
    G._setArtworkCritiqueAnalyzerForTests(stdAnalyzer({
      requirements: async ({ text }) => {
        rosterText = text;
        return {
          requirements: [
            { subject_id: String(charDoc._id), subject_kind: 'character', category: 'costume', summary: 'Locked wardrobe', detail: 'navy flannel shirt, tan canvas jacket', quote: 'wardrobe lock', importance: 'essential' },
            { subject_id: String(charDoc._id), subject_kind: 'character', category: 'expression', summary: 'Fury', detail: 'jaw set', quote: 'slams', importance: 'essential' },
          ],
          unlinked_mentions: [],
        };
      },
    }));
    const job = G.createArtworkCritiqueJob(beat._id.toString());
    await G.runArtworkCritique({ projectId, job });
    expect(rosterText).toContain('LOCKED WARDROBE: navy flannel shirt, tan canvas jacket');
    const c = await AC.getBeatArtworkCritique(projectId, beat._id.toString());
    const costume = c.proposals.find((p) => /Locked wardrobe/.test(p.name));
    const fury = c.proposals.find((p) => /Fury/.test(p.name));
    expect(costume.prompt.split('\n')[1]).toBe('Wardrobe (locked — reproduce exactly): navy flannel shirt, tan canvas jacket');
    // No plate yet: portrait only.
    expect(costume.reference_image_ids.map(String)).toEqual([String(portrait)]);
    const beatId = beat._id.toString();

    // Render the costume proposal: its result becomes the plate.
    let { job_id } = await G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [String(costume._id)], model: 'nano-banana-pro' });
    expect((await settle(job_id, G.getArtworkGenerateJob)).status).toBe('done');
    const promotedChar = await Characters.getCharacter(projectId, charDoc._id.toString());
    const after1 = await AC.getBeatArtworkCritique(projectId, beatId);
    const costumeDone = after1.proposals.find((p) => String(p._id) === String(costume._id));
    expect(String(promotedChar.wardrobe_image_id)).toBe(String(costumeDone.result_image_id));
    expect(costumeDone.promoted_wardrobe).toBe(true);
    expect(h.dispatch.perCall[0].inputCount).toBe(1);

    // The next render of the same character goes out with the plate at reference 2 and does not re-promote.
    ({ job_id } = await G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [String(fury._id)], model: 'nano-banana-pro' }));
    expect((await settle(job_id, G.getArtworkGenerateJob)).status).toBe('done');
    expect(h.dispatch.perCall[1].inputCount).toBe(2);
    expect(h.dispatch.perCall[1].prompt).toContain("Reference image 2 is this person's wardrobe plate");
    expect(h.dispatch.perCall[1].prompt).toContain('Wardrobe (locked — reproduce exactly): navy flannel shirt');
    const after2 = await AC.getBeatArtworkCritique(projectId, beatId);
    const furyDone = after2.proposals.find((p) => String(p._id) === String(fury._id));
    expect(furyDone.reference_image_ids.map(String)).toEqual([String(portrait), String(costumeDone.result_image_id)]);
    expect(furyDone.promoted_wardrobe).toBe(false);
    expect(String((await Characters.getCharacter(projectId, charDoc._id.toString())).wardrobe_image_id)).toBe(String(costumeDone.result_image_id));
    Images.findImageFile.mockImplementation(async (id) => ({ _id: new ObjectId(String(id)), metadata: {} }));
  });

  it('validates its input', async () => {
    const c = await critiqued();
    const pid = String(c.proposals[0]._id);
    const beatId = beat._id.toString();
    await expect(G.startArtworkGenerateJob({ projectId, beatId: new ObjectId().toString(), proposalIds: [pid], model: 'nano-banana-pro' })).rejects.toMatchObject({ status: 404 });
    await expect(G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [], model: 'nano-banana-pro' })).rejects.toMatchObject({ status: 400 });
    await expect(G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [new ObjectId().toString()], model: 'nano-banana-pro' })).rejects.toMatchObject({ status: 400 });
    await expect(G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [pid], model: 'not-a-model' })).rejects.toMatchObject({ status: 400 });
    await expect(G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [pid], model: 'nano-banana-pro', overrides: { [pid]: { prompt: '   ' } } })).rejects.toMatchObject({ status: 400 });
    await expect(G.startArtworkGenerateJob({ projectId, beatId, proposalIds: [pid], model: 'nano-banana-pro', overrides: { [pid]: { reference_image_ids: ['nope'] } } })).rejects.toMatchObject({ status: 400 });
    expect(h.dispatch.calls).toBe(0);
  });

  it('setProposalStatus: 404 unknown, dismiss/restore round trip', async () => {
    const c = await critiqued();
    const pid = c.proposals[0]._id;
    await expect(G.setProposalStatus({ projectId, beatId: beat._id.toString(), proposalId: new ObjectId(), status: 'dismissed' })).rejects.toMatchObject({ status: 404 });
    expect((await G.setProposalStatus({ projectId, beatId: beat._id.toString(), proposalId: pid, status: 'dismissed' })).status).toBe('dismissed');
    expect((await AC.getArtworkCritiqueProposal(projectId, beat._id.toString(), pid)).status).toBe('dismissed');
    expect((await G.setProposalStatus({ projectId, beatId: beat._id.toString(), proposalId: pid, status: 'proposed' })).status).toBe('proposed');
  });
});
