// The artwork climb (audit → edit close pieces in place / render real gaps → re-audit what changed) against
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

const R1 = () => `set:${setDoc._id}:1`;
const R2 = () => `set:${setDoc._id}:2`;
const fit = (id, how = 'covered', lacking = '') => ({ requirement_id: id, fit: how, lacking });
const isA = (a) => String(a._id) === String(artworkA._id);
const isB = (a) => String(a._id) === String(artworkB._id);
// The image an artwork had when the test began → has it been edited since?
const edited = (a) => ![String(artworkA.result_image_id), String(artworkB.result_image_id)].includes(String(a.result_image_id));

// `judge(artwork)` is the auditor's verdict on one artwork:
// {fits, score, issues?, suggested_edit?}.
function analyzer(judge) {
  return {
    requirements: async () => ({
      requirements: [
        { subject_id: String(setDoc._id), subject_kind: 'set', category: 'view', summary: 'Lot from the entrance', detail: 'dusk', quote: 'EXT. THEATRE LOT — DUSK', importance: 'essential' },
        { subject_id: String(setDoc._id), subject_kind: 'set', category: 'vehicle', summary: 'The car', detail: 'a sedan', quote: 'slams the car door', importance: 'useful' },
      ],
      unlinked_mentions: [],
    }),
    audit: async ({ artworks }) => {
      auditBatches.push(artworks.map((a) => String(a._id)));
      return { artworks: artworks.map((a, i) => ({ index: i + 1, issues: [], suggested_edit: '', ...judge(a) })) };
    },
    proposals: async ({ text, subject, requirements }) => {
      proposalTexts.push(text);
      return { proposals: requirements.map((r) => ({ requirement_ids: [r.id], name: `Gen ${r.summary}`, prompt: `render ${r.summary}`, reference_indexes: subject.kind === 'set' ? [1] : [], rationale: 'needed' })) };
    },
  };
}

let proposalTexts;
let auditBatches;
beforeEach(async () => {
  proposalTexts = [];
  auditBatches = [];
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

  it('edits the close artwork in place — no new artwork, only the edited pieces re-audited', async () => {
    // A covers the view but is too bright; B is the car with its door closed.
    const id = beat._id.toString();
    // What a poll sees while each audit runs.
    const views = [];
    const stored = [];
    const hooked = G._setArtworkCritiqueAnalyzerForTests;
    const an = analyzer((a) => {
      if (isA(a)) return edited(a) ? { fits: [fit(R1())], score: 9 } : { fits: [fit(R1())], score: 6, issues: [{ kind: 'light', note: 'daylight' }], suggested_edit: 'Grade to dusk.' };
      if (isB(a)) return edited(a) ? { fits: [fit(R2())], score: 9 } : { fits: [fit(R2(), 'partial', 'the door is closed')], score: 6, suggested_edit: 'Open the driver door.' };
      return { fits: [], score: 5 };
    });
    const audit = an.audit;
    an.audit = async (args) => {
      views.push(await Core.getClimbView(projectId, id, 'artwork'));
      stored.push(await AC.getBeatArtworkCritique(projectId, id));
      return audit(args);
    };
    hooked(an);
    const started = await Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro', direction: 'wet tarmac' } });
    expect(started.status).toBe('running');
    // The climb owns the beat: the manual routes are refused meanwhile.
    await expect(G.startArtworkCritiqueJob({ projectId, beatId: id })).rejects.toMatchObject({ status: 409 });
    await expect(Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro' } })).rejects.toMatchObject({ status: 409 });
    const climb = await finished(id);
    // start: both requirements have a picture scoring 6 → 60%; after the edits both score 9 → 90%
    expect(climb).toMatchObject({ status: 'done', stop_reason: 'target', start_score: 60, best_score: 90, wall_summary: null, model: 'nano-banana-pro', stage: 'quality' });
    expect(climb.attempts).toHaveLength(1);
    expect(climb.attempts[0]).toMatchObject({ n: 1, score: 90, kept: true });
    expect(climb.attempts[0].detail).toMatchObject({ stage: 'quality', edited: 2, reverted: 0, rendered: 0, failed: 0 });
    // Live status: while the edited pieces are re-checked a poll sees each one
    // as `checking` with its new picture, and the page still has the last audit.
    const a = String(artworkA._id);
    const b = String(artworkB._id);
    expect(views[0].activity).toEqual({});
    expect(views[1].activity[a]).toMatchObject({ status: 'checking', name: 'Lot front', round: 1, from: 6 });
    expect(views[1].activity[a].image_id).toMatch(/^[0-9a-f]{24}$/);
    expect(views[1].activity[b].status).toBe('checking');
    expect(stored[1].subjects[0].artworks).toHaveLength(2);
    expect(stored[1].subjects[0].requirements).toHaveLength(2);
    expect(stored[1].coverage.quality_pct).toBe(60);
    expect(climb.activity[a]).toMatchObject({ status: 'kept', from: 6, to: 9 });
    expect(climb.activity[b]).toMatchObject({ status: 'kept', from: 6, to: 9 });
    const log = climb.events.map((e) => e.text).join('\n');
    expect(log).toContain('Round 1: editing 2 pieces in place');
    expect(log).toContain('Kept the edit of "Lot front": 6 → 9/10.');
    expect(log).toContain('Phase 2 — quality');
    expect(log).toContain('Round 1: coverage 100% (2/2 requirements have a picture), quality 90% (2 reviewed).');
    expect(h.dispatch.calls).toBe(2);
    expect(h.dispatch.perCall.map((c) => c.prompt).sort()[0]).toContain('Grade to dusk.');
    const carEdit = h.dispatch.perCall.find((c) => /driver door/.test(c.prompt));
    expect(carEdit.prompt).toContain('the door is closed');
    expect(carEdit.prompt).toContain('wet tarmac');
    // The reviewer's findings reach the edit model and the log explains them.
    const dusk = h.dispatch.perCall.find((c) => /Grade to dusk/.test(c.prompt));
    expect(dusk.prompt).toContain('The reviewer found these wrong in the picture — correct every one: daylight.');
    expect(climb.activity[String(artworkA._id)].why).toEqual(['daylight']);
    expect(climb.events.map((e) => e.text).join('\n')).toContain('"Lot front" (Theatre lot, 6/10) needs: daylight. Edit sent: Grade to dusk.');
    expect(proposalTexts).toEqual([]); // every requirement has a picture: nothing to draft
    const fresh = await Sets.getSet(projectId, String(setDoc._id));
    expect(fresh.artworks).toHaveLength(2); // nothing new was made
    for (const art of fresh.artworks) {
      expect(String(art.result_image_id)).not.toBe(String((isA(art) ? artworkA : artworkB).result_image_id));
      expect(String(art.previous_result_image_id)).toBe(String((isA(art) ? artworkA : artworkB).result_image_id));
    }
    // Baseline looked at both; the round looked at the two it edited; the final score needed no vision.
    expect(auditBatches).toHaveLength(2);
    const c = await AC.getBeatArtworkCritique(projectId, id);
    expect(c.subjects[0].requirements.map((r) => r.status)).toEqual(['covered', 'covered']);
    expect(c.proposals).toEqual([]); // the draft for the car was never rendered and is no longer needed
    // Released: a manual critique can start again.
    await expect(G.startArtworkCritiqueJob({ projectId, beatId: id })).resolves.toBeTruthy();
  });

  it('coverage first: renders a new image for a requirement nothing on file answers', async () => {
    G._setArtworkCritiqueAnalyzerForTests(analyzer((a) => {
      if (isA(a)) return { fits: [fit(R1())], score: 10 };
      if (isB(a)) return { fits: [], score: 7 };
      return { fits: [fit(R2())], score: 10 }; // the render
    }));
    const id = beat._id.toString();
    await Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro', direction: 'wet tarmac' } });
    const climb = await finished(id);
    expect(climb).toMatchObject({ status: 'done', stop_reason: 'target', start_score: 67, best_score: 100 });
    expect(climb.attempts[0].detail).toMatchObject({ stage: 'coverage', edited: 0, rendered: 1 });
    expect(proposalTexts[0]).toContain('wet tarmac');
    const log = climb.events.map((e) => e.text).join('\n');
    expect(log).toContain('Phase 1 — coverage: 1 requirement has no picture on file.');
    expect(log).toContain('Round 1: rendering 1 new image for the 1 requirement with no picture — "Gen The car".');
    expect(h.dispatch.calls).toBe(1);
    const fresh = await Sets.getSet(projectId, String(setDoc._id));
    expect(fresh.artworks).toHaveLength(3);
    // The round's audit saw only the new render.
    expect(auditBatches).toEqual([[String(artworkA._id), String(artworkB._id)], [String(fresh.artworks[2]._id)]]);
  });

  it('undoes an edit that does not help, then makes the picture again; stalls and says why', async () => {
    // B stays "door closed" whatever is done to it; a new render does not show the car either.
    G._setArtworkCritiqueAnalyzerForTests(analyzer((a) => {
      if (isA(a)) return { fits: [fit(R1())], score: 9 };
      if (isB(a)) return { fits: [fit(R2(), 'partial', 'the door is closed')], score: 6, suggested_edit: 'Open the driver door.' };
      return { fits: [], score: 5 };
    }));
    const id = beat._id.toString();
    await Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro', stop_after: 2 } });
    const climb = await finished(id);
    // (2 × 0.9 + 1 × 0.6) / 3 → 80%
    expect(climb).toMatchObject({ status: 'done', stop_reason: 'stalled', start_score: 80, best_score: 80, stalls: 2 });
    expect(climb.attempts.map((a) => a.kept)).toEqual([false, false]);
    expect(climb.attempts[0].detail).toMatchObject({ edited: 0, reverted: 1, rendered: 0 });
    // Second miss in a row: the piece is left alone and the proposal is rendered instead.
    expect(climb.attempts[1].detail).toMatchObject({ edited: 0, reverted: 1, rendered: 1 });
    expect(climb.wall_summary).toBe('WALL: the car never appears.');
    expect(climb.activity[String(artworkB._id)]).toMatchObject({ status: 'undone', round: 2, from: 6, to: 6, image_id: null });
    const log = climb.events.map((e) => e.text).join('\n');
    expect(log).toContain('Undid the edit of "Lot side": 6 → 6/10, no gain.');
    expect(log).toContain('Round 2: rendering 1 new image to replace pieces the reviewer turned down — "Gen The car".');
    // The planner is told it is a remake, and everything the reviewer found.
    expect(proposalTexts.at(-1)).toContain('regenerate] The car');
    expect(proposalTexts.at(-1)).toContain('(review: Wrong in "Lot side": the door is closed. 2 in-place edit(s) did not fix it ("Open the driver door.")');
    const made = (await AC.getBeatArtworkCritique(projectId, id)).proposals.find((p) => p.status === 'done');
    expect(made.review_brief).toContain('the door is closed');
    expect(String(made.replaces_artwork_id)).toBe(String(artworkB._id));
    expect(log).toContain("the reviewer's findings it has to put right: Wrong in \"Lot side\": the door is closed.");
    expect(log).toContain('Rendered "Gen The car".');
    expect(h.dispatch.calls).toBe(3);
    const fresh = await Sets.getSet(projectId, String(setDoc._id));
    expect(fresh.artworks).toHaveLength(3);
    const b = fresh.artworks.find(isB);
    expect(String(b.result_image_id)).toBe(String(artworkB.result_image_id)); // both edits undone
    const c = await AC.getBeatArtworkCritique(projectId, id);
    expect(c.subjects[0].artworks.find((e) => String(e.artwork_id) === String(artworkB._id)).edit_attempts).toBe(2);
    expect((await Core.getClimbView(projectId, id, 'artwork')).stop_reason).toBe('stalled');
  });

  it('a critique that has to re-derive the requirements keeps the last audit on the page until the new one lands', async () => {
    const id = beat._id.toString();
    const an = analyzer((a) => (isA(a) ? { fits: [fit(R1())], score: 9 } : { fits: [fit(R2())], score: 8 }));
    G._setArtworkCritiqueAnalyzerForTests(an);
    await G.runArtworkCritiqueForClimb({ projectId, beatId: id });
    const first = await AC.getBeatArtworkCritique(projectId, id);
    expect(first.subjects[0].artworks).toHaveLength(2);
    // The beat's text changes → pass A runs again.
    await Plots.updateBeat(projectId, id, { body: 'EXT. THEATRE LOT — DUSK\nSarah slams the car door and runs.' });
    // What the page has while the new requirements are being matched.
    let during = null;
    an.match = async ({ requirements, artworks }) => {
      during = await AC.getBeatArtworkCritique(projectId, id);
      return { candidates: requirements.map((r) => ({ requirement_id: r.id, artwork_indexes: artworks.map((_, i) => i + 1) })), duplicate_groups: [] };
    };
    const job = await G.runArtworkCritiqueForClimb({ projectId, beatId: id });
    expect(job.status).toBe('done');
    expect(during.subjects[0].artworks).toHaveLength(2);
    expect(during.subjects[0].artworks.map((e) => e.score)).toEqual([9, 8]);
    expect(during.subjects[0].requirements.map((r) => r.status)).toEqual(['covered', 'covered']);
    expect(during.coverage.pct).toBe(100);
    expect(during.requirements_sig).toBe(first.requirements_sig); // not stamped until every subject is rewritten
    const after = await AC.getBeatArtworkCritique(projectId, id);
    expect(after.requirements_sig).not.toBe(first.requirements_sig);
    expect(after.subjects[0].artworks).toHaveLength(2);
    expect(auditBatches).toHaveLength(2); // every piece was looked at again
  });

  it('moves on to quality when nothing can be rendered for what is missing', async () => {
    // The car has no picture and the planner drafts nothing for it; A can still be improved.
    const an = analyzer((a) => {
      if (isA(a)) return edited(a) ? { fits: [fit(R1())], score: 9 } : { fits: [fit(R1())], score: 6, issues: [{ kind: 'light', note: 'daylight' }], suggested_edit: 'Grade to dusk.' };
      return { fits: [], score: 7 };
    });
    an.proposals = async () => ({ proposals: [] });
    G._setArtworkCritiqueAnalyzerForTests(an);
    const id = beat._id.toString();
    await Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 60, model: 'nano-banana-pro' } });
    const climb = await finished(id);
    // 2 × 0.6 / 3 → 40%; after the edit 2 × 0.9 / 3 → 60%
    expect(climb).toMatchObject({ status: 'done', stop_reason: 'target', start_score: 40, best_score: 60, coverage_blocked: true, stage: 'quality' });
    expect(climb.attempts[0].detail).toMatchObject({ stage: 'quality', edited: 1, rendered: 0 });
    expect(climb.events.map((e) => e.text).join('\n')).toContain('Coverage cannot be completed automatically: 1 requirement has no picture and no proposal to render ("The car").');
    expect(h.dispatch.calls).toBe(1);
  });

  it('ends with an error when nothing can be rendered or edited', async () => {
    G._setArtworkCritiqueAnalyzerForTests(analyzer((a) => (isA(a) ? { fits: [fit(R1())], score: 10 } : { fits: [], score: 7 })));
    h.dispatch.failOnCall = 1;
    const id = beat._id.toString();
    await Climb.startArtworkClimb({ projectId, beatId: id, params: { target: 90, model: 'nano-banana-pro' } });
    const climb = await finished(id);
    expect(climb.status).toBe('error');
    expect(climb.error).toMatch(/No artwork could be rendered/);
  });
});
