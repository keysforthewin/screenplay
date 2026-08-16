// Integration tests for the image-sheet background job engine. The provider
// dispatch is mocked (instrumented to measure concurrency); everything else —
// pending-artwork creation, result persistence, job lifecycle — runs against
// the in-memory fake Mongo through the real gateway + artworks helpers.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';
import { config } from '../src/config.js';

const fakeDb = createFakeDb();

// Shared, hoisted instrumentation for the provider mock + fal-config toggle.
const h = vi.hoisted(() => ({
  dispatch: { calls: 0, inFlight: 0, maxInFlight: 0, failOnCall: 0, perCall: [], kleinCalls: [] },
  images: { requested: [] },
  fal: { configured: true },
}));

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async (id) => {
    h.images.requested.push(String(id));
    return {
      buffer: Buffer.from('ref'),
      file: { contentType: 'image/png', metadata: {} },
    };
  }),
  uploadGeneratedImage: vi.fn(async (_projectId, { filename, contentType }) => ({
    _id: new ObjectId(),
    filename,
    content_type: contentType || 'image/png',
    size: 1024,
    uploaded_at: new Date(),
  })),
  findImageFile: vi.fn(async () => null),
  deleteImage: vi.fn(async () => {}),
}));
vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => h.fal.configured,
}));
vi.mock('../src/mongo/tokenUsage.js', () => ({
  recordOpenAIImageUsage: vi.fn(),
  recordFalImageUsage: vi.fn(),
}));
// One catalog endpoint that REQUIRES reference images (edit-only), for the
// pre-flight guard tests. Everything else resolves as not-in-catalog.
vi.mock('../src/fal/imageModelCatalog.js', () => ({
  getImageModel: vi.fn(async (id) =>
    id === 'fal-ai/edit-only/model'
      ? { id: 'fal-ai/edit-only/model', endpoint_id: 'fal-ai/edit-only/model', requires_references: true, accepts_references: true }
      : null),
  loadImageModelCatalog: vi.fn(async () => ({ models: [], generated_at: null, catalog_error: null })),
}));
vi.mock('../src/openai/imageClient.js', () => ({
  generateCharacterSheetImage: vi.fn(),
  generateCharacterSheetImageEdit: vi.fn(),
  GPT_IMAGE_MODEL: 'gpt-image-2',
}));
// Mock the leaf FAL provider used by nano-banana-pro and let the REAL
// dispatchImageReplace route through it (mocking the dispatch module's dynamic
// import from artworkJobs proved unreliable). Instrumented to measure
// concurrency and to fail a specific call.
vi.mock('../src/fal/imageClient.js', () => ({
  generateNanoBananaProImage: async ({ prompt, inputImages } = {}) => {
    h.dispatch.calls += 1;
    h.dispatch.perCall.push({ prompt, inputCount: Array.isArray(inputImages) ? inputImages.length : 0 });
    const callNo = h.dispatch.calls;
    h.dispatch.inFlight += 1;
    h.dispatch.maxInFlight = Math.max(h.dispatch.maxInFlight, h.dispatch.inFlight);
    await new Promise((r) => setTimeout(r, 10));
    h.dispatch.inFlight -= 1;
    if (h.dispatch.failOnCall && callNo === h.dispatch.failOnCall) {
      throw new Error('provider boom');
    }
    return { buffer: Buffer.from('img'), contentType: 'image/png' };
  },
  generateFluxKontextImage: vi.fn(),
  generateFlux2ProImage: vi.fn(),
  generateGemini25FlashImage: vi.fn(),
  generateNanoBanana2Image: vi.fn(),
  generateFlux2KleinImage: vi.fn(async ({ prompt } = {}) => {
    h.dispatch.kleinCalls.push(prompt);
    return { buffer: Buffer.from('img'), contentType: 'image/png' };
  }),
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext',
  FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro',
  NANO_BANANA_PRO_GENERATE_MODEL: 'nano-banana-pro',
  GEMINI_25_FLASH_GENERATE_MODEL: 'fal-ai/gemini-25-flash-image',
  NANO_BANANA_2_GENERATE_MODEL: 'fal-ai/nano-banana-2',
  FLUX_2_KLEIN_GENERATE_MODEL: 'fal-ai/flux-2/klein/9b',
}));

const { createProject } = await import('../src/mongo/projects.js');
const Images = await import('../src/mongo/images.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const Planner = await import('../src/web/beatSheetPlanner.js');
const Sheet = await import('../src/web/imageSheetJobs.js');
const CharShots = await import('../src/web/characterSheetShots.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  h.dispatch.calls = 0;
  h.dispatch.inFlight = 0;
  h.dispatch.maxInFlight = 0;
  h.dispatch.failOnCall = 0;
  h.dispatch.perCall = [];
  h.dispatch.kleinCalls = [];
  h.images.requested = [];
  h.fal.configured = true;
  Images.findImageFile.mockImplementation(async () => null);
  Planner._setScenePlatePlannerForTests(null);
  Planner._setScenePlateCritiqueForTests(null);
});

async function waitForJob(jobId, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Sheet.getImageSheetJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish in time');
}

async function waitForStatus(jobId, statuses, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Sheet.getImageSheetJob(jobId);
    if (job && statuses.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job did not reach ${statuses.join('/')} in time`);
}

describe('startImageSheetJob — character', () => {
  it('creates one done artwork per shot and finishes "done"', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae', hollywood_actor: 'Zendaya' });
    const { job_id, planned } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shotCount: 3,
    });
    expect(planned).toBe(3);
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(3);
    expect(job.failed).toBe(0);

    const fresh = await Characters.getCharacter(projectId, 'Rae');
    expect(fresh.artworks).toHaveLength(3);
    for (const a of fresh.artworks) {
      expect(a.status).toBe('done');
      expect(a.result_image_id).toBeTruthy();
      expect(a.model).toBe('nano-banana-pro');
      expect(a.prompt.length).toBeGreaterThan(0);
      expect(typeof a.name).toBe('string');
      expect(a.name.length).toBeGreaterThan(0); // labeled by shot
    }
  });

  it('never runs more than SHEET_CONCURRENCY provider calls at once', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Max', hollywood_actor: 'Zendaya' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shotCount: 7,
    });
    const job = await waitForJob(job_id);
    expect(job.completed).toBe(7);
    expect(h.dispatch.calls).toBe(7);
    expect(h.dispatch.maxInFlight).toBeLessThanOrEqual(Sheet.SHEET_CONCURRENCY);
    expect(h.dispatch.maxInFlight).toBeGreaterThan(1); // actually parallel
  });

  it('marks a single failed shot as error and finishes "partial"', async () => {
    h.dispatch.failOnCall = 2; // 2nd provider call throws
    const c = await Characters.createCharacter({ projectId, name: 'Partial', hollywood_actor: 'Zendaya' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shotCount: 3,
    });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('partial');
    expect(job.completed).toBe(2);
    expect(job.failed).toBe(1);

    const fresh = await Characters.getCharacter(projectId, 'Partial');
    const statuses = fresh.artworks.map((a) => a.status).sort();
    expect(statuses).toEqual(['done', 'done', 'error']);
    const errored = fresh.artworks.find((a) => a.status === 'error');
    expect(errored.error_message).toMatch(/boom/);
  });

  it('generates exactly the shots named in shotNames', async () => {
    const front = CharShots.CHARACTER_SHEET_SHOTS[0].name;
    const back = CharShots.CHARACTER_SHEET_SHOTS.find((s) => /back of head/i.test(s.name)).name;
    const c = await Characters.createCharacter({ projectId, name: 'Named', hollywood_actor: 'Zendaya' });
    const { job_id, planned } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shotNames: [back, front],
    });
    expect(planned).toBe(2);
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(2);
    const fresh = await Characters.getCharacter(projectId, 'Named');
    expect(fresh.artworks.map((a) => a.name).sort()).toEqual([back, front].sort());
  });
});

describe('startImageSheetJob — beat (explicit shots)', () => {
  it('renders one done artwork per explicit shot WITHOUT calling the planner', async () => {
    let planCalls = 0;
    Planner._setScenePlatePlannerForTests(async () => { planCalls += 1; return []; });
    const beat = await Plots.createBeat({ projectId, name: 'The Alley', desc: 'x', body: 'INT. ALLEY - NIGHT' });
    const { job_id, planned } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shots: [
        { name: 'Alley — wide', prompt: 'wide empty rain-slick alley at dusk' },
        { name: 'Brick — insert', prompt: 'tight insert of wet brick texture' },
      ],
    });
    expect(planned).toBe(2);
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.planned).toBe(2);
    expect(job.completed).toBe(2);
    expect(planCalls).toBe(0);

    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.artworks).toHaveLength(2);
    expect(fresh.artworks.map((a) => a.name).sort()).toEqual(['Alley — wide', 'Brick — insert']);
    for (const a of fresh.artworks) {
      expect(a.status).toBe('done');
      expect(a.prompt.length).toBeGreaterThan(0);
    }
  });

  it('rejects a beat with no shots (status 400)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'NoShots', body: 'INT. X' });
    await expect(
      Sheet.startImageSheetJob({ projectId, hostType: 'beat', hostId: beat._id.toString(), model: 'nano-banana-pro' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a beat with an empty/invalid shots list (status 400)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Empty', body: 'INT. X' });
    await expect(
      Sheet.startImageSheetJob({
        projectId, hostType: 'beat', hostId: beat._id.toString(), model: 'nano-banana-pro',
        shots: [{ name: '', prompt: '' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('clamps an over-long explicit shot list to MAX_SCENE_IMAGE_COUNT', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Many', body: 'INT. X' });
    const shots = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, prompt: `p${i}` }));
    const { job_id, planned } = await Sheet.startImageSheetJob({
      projectId, hostType: 'beat', hostId: beat._id.toString(), model: 'nano-banana-pro', shots,
    });
    expect(planned).toBe(Planner.MAX_SCENE_IMAGE_COUNT);
    await waitForJob(job_id);
  });
});

describe('startImageSheetJob — per-shot references', () => {
  const refA = 'a'.repeat(24);
  const refB = 'b'.repeat(24);
  const refC = 'c'.repeat(24);

  it('sends each shot ONLY its own reference images, never the sheet pool', async () => {
    Images.findImageFile.mockImplementation(async (id) => ({ _id: id }));
    const beat = await Plots.createBeat({ projectId, name: 'Stars', body: 'EXT. SKY - NIGHT' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [refA, refB, refC],
      shots: [
        { name: 'Starfield', prompt: 'the milky way over black hills', reference_image_ids: [] },
        { name: 'Theater', prompt: 'the theater from the reference beneath stars', reference_image_ids: [refA, refB] },
      ],
    });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    const star = h.dispatch.perCall.find((c) => c.prompt.includes('milky way'));
    const theater = h.dispatch.perCall.find((c) => c.prompt.includes('theater'));
    expect(star.inputCount).toBe(0);
    expect(theater.inputCount).toBe(2);

    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    const starArt = fresh.artworks.find((a) => a.name === 'Starfield');
    const theaterArt = fresh.artworks.find((a) => a.name === 'Theater');
    expect(starArt.reference_image_ids).toEqual([]);
    expect(theaterArt.reference_image_ids.map(String)).toEqual([refA, refB]);
  });

  it('falls back to the sheet-level pool for shots without their own list', async () => {
    Images.findImageFile.mockImplementation(async (id) => ({ _id: id }));
    const beat = await Plots.createBeat({ projectId, name: 'Legacy', body: 'INT. X' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [refA, refB],
      shots: [{ name: 'Old-style', prompt: 'a legacy plate' }],
    });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(h.dispatch.perCall[0].inputCount).toBe(2);
  });

  it('drops per-shot reference ids whose files are gone instead of failing the shot', async () => {
    Images.findImageFile.mockImplementation(async (id) => (String(id) === refA ? { _id: id } : null));
    const beat = await Plots.createBeat({ projectId, name: 'Stale', body: 'INT. X' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shots: [{ name: 'T', prompt: 'plate with one stale ref', reference_image_ids: [refA, refB] }],
    });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.failed).toBe(0);
    expect(h.dispatch.perCall[0].inputCount).toBe(1);
  });

  it('sanitizes per-shot reference ids (non-hex dropped, deduped)', async () => {
    Images.findImageFile.mockImplementation(async (id) => ({ _id: id }));
    const beat = await Plots.createBeat({ projectId, name: 'Dirty', body: 'INT. X' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shots: [{ name: 'T', prompt: 'p', reference_image_ids: [refA, refA, 'nope', refB] }],
    });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(h.dispatch.perCall[0].inputCount).toBe(2);
  });
});

describe('startShotPlanJob — derive', () => {
  it('runs the two-phase planner and parks at "derived" with job.shots', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Alley — wide', prompt: 'wide empty alley', justification: 'establishes', quote: 'INT. ALLEY - NIGHT' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const beat = await Plots.createBeat({ projectId, name: 'Alley', body: 'INT. ALLEY - NIGHT' });
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostId: beat._id.toString(),
      referenceImageIds: [],
    });
    expect(job_id).toBeTruthy();
    const job = await waitForStatus(job_id, ['derived', 'error']);
    expect(job.status).toBe('derived');
    expect(job.kind).toBe('beat_plan');
    expect(job.planned).toBe(1);
    expect(job.shots).toEqual([
      { name: 'Alley — wide', prompt: 'wide empty alley', justification: 'establishes', quote: 'INT. ALLEY - NIGHT', reference_image_ids: [], requires_reference: false },
    ]);
  });

  it('threads the planner\'s requires_reference marking through job.shots', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Theater', prompt: 'the established theater', justification: '', quote: '', requires_reference: true },
      { name: 'Starfield', prompt: 'milky way', justification: '', quote: '', requires_reference: false },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const beat = await Plots.createBeat({ projectId, name: 'Marked', body: 'EXT. THEATER - NIGHT' });
    const { job_id } = await Sheet.startShotPlanJob({ projectId, hostId: beat._id.toString(), referenceImageIds: [] });
    const job = await waitForStatus(job_id, ['derived', 'error']);
    expect(job.shots.map((s) => s.requires_reference)).toEqual([true, false]);
  });

  it('resolves planner reference assignments to the requested reference ids', async () => {
    const refA = 'a'.repeat(24);
    const refB = 'b'.repeat(24);
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Theater', prompt: 'the theater from the reference', justification: '', quote: '', reference_indexes: [2] },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const beat = await Plots.createBeat({ projectId, name: 'Refs', body: 'EXT. THEATER - NIGHT' });
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostId: beat._id.toString(),
      referenceImageIds: [refA, refB],
    });
    const job = await waitForStatus(job_id, ['derived', 'error']);
    expect(job.status).toBe('derived');
    expect(job.shots[0].reference_image_ids).toEqual([refB]);
  });

  it('rejects with status 400 when ANTHROPIC_API_KEY is not configured', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'NoKey', body: 'INT. X' });
    const saved = config.anthropic.apiKey;
    config.anthropic.apiKey = '';
    try {
      await expect(
        Sheet.startShotPlanJob({ projectId, hostId: beat._id.toString(), referenceImageIds: [] }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      config.anthropic.apiKey = saved;
    }
  });

  it('rejects a missing beat with status 404', async () => {
    await expect(
      Sheet.startShotPlanJob({ projectId, hostId: new ObjectId().toString(), referenceImageIds: [] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('does NOT create any artworks (derive renders nothing)', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'A', prompt: 'a', justification: '', quote: '' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const beat = await Plots.createBeat({ projectId, name: 'NoArt', body: 'INT. X' });
    const { job_id } = await Sheet.startShotPlanJob({ projectId, hostId: beat._id.toString(), referenceImageIds: [] });
    await waitForStatus(job_id, ['derived', 'error']);
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.artworks || []).toHaveLength(0);
  });

  it('threads direction + normalized previousPlates into the planner on re-derive', async () => {
    let p1args = null;
    Planner._setScenePlatePlannerForTests(async (args) => {
      p1args = args;
      return [{ name: 'A', prompt: 'a', justification: '', quote: '' }];
    });
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const beat = await Plots.createBeat({ projectId, name: 'Rev', body: 'INT. X' });
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostId: beat._id.toString(),
      referenceImageIds: [],
      direction: 'make it grittier',
      previousPlates: [
        { name: 'Old', prompt: 'old plate' },
        { name: '', prompt: 'dropped (blank name)' },
      ],
    });
    await waitForStatus(job_id, ['derived', 'error']);
    expect(p1args.direction).toBe('make it grittier');
    expect(p1args.previousPlates).toEqual([{ name: 'Old', prompt: 'old plate' }]);
  });
});

describe('startImageSheetJob — per-shot models', () => {
  const refA = 'a'.repeat(24);

  it('renders each shot with its own model (split sheet: refs model + prompt model)', async () => {
    Images.findImageFile.mockImplementation(async (id) => ({ _id: id }));
    const beat = await Plots.createBeat({ projectId, name: 'Split', body: 'EXT. SKY - NIGHT' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shots: [
        { name: 'Theater', prompt: 'theater from the reference', reference_image_ids: [refA], model: 'nano-banana-pro' },
        { name: 'Starfield', prompt: 'milky way alone', reference_image_ids: [], model: 'flux-2-klein' },
      ],
    });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(h.dispatch.perCall.map((c) => c.prompt)).toEqual(['theater from the reference']);
    expect(h.dispatch.kleinCalls).toEqual(['milky way alone']);

    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.artworks.find((a) => a.name === 'Theater').model).toBe('nano-banana-pro');
    // The provider resolves the shortcut to its endpoint id and the artwork
    // records the resolved model (existing fallback-patch behavior).
    expect(fresh.artworks.find((a) => a.name === 'Starfield').model).toBe('fal-ai/flux-2/klein/9b');
  });

  it('shots without their own model fall back to the sheet model', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'FallbackModel', body: 'INT. X' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shots: [{ name: 'Plain', prompt: 'a plate' }],
    });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(h.dispatch.perCall).toHaveLength(1);
  });

  it('rejects an invalid per-shot model with status 400 before creating tiles', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'BadModel', body: 'INT. X' });
    await expect(
      Sheet.startImageSheetJob({
        projectId,
        hostType: 'beat',
        hostId: beat._id.toString(),
        model: 'nano-banana-pro',
        shots: [{ name: 'X', prompt: 'p', model: 'bogus-model' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.artworks || []).toHaveLength(0);
  });

  it('applies the refs-required guard against each shot\'s own model', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'PerShotGuard', body: 'INT. X' });
    await expect(
      Sheet.startImageSheetJob({
        projectId,
        hostType: 'beat',
        hostId: beat._id.toString(),
        model: 'nano-banana-pro',
        shots: [
          { name: 'Fine', prompt: 'p', reference_image_ids: [], model: 'nano-banana-pro' },
          { name: 'Broken', prompt: 'p', reference_image_ids: [], model: 'fal-ai/edit-only/model' },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/requires reference images.*Broken/s),
    });
  });
});

describe('startImageSheetJob — reference-requiring models', () => {
  const refA = 'a'.repeat(24);

  it('rejects plates with no references on a refs-required catalog model, naming them (400)', async () => {
    Images.findImageFile.mockImplementation(async (id) => ({ _id: id }));
    const beat = await Plots.createBeat({ projectId, name: 'Guard', body: 'EXT. SKY - NIGHT' });
    await expect(
      Sheet.startImageSheetJob({
        projectId,
        hostType: 'beat',
        hostId: beat._id.toString(),
        model: 'fal-ai/edit-only/model',
        referenceImageIds: [refA],
        shots: [
          { name: 'Theater', prompt: 'theater plate', reference_image_ids: [refA] },
          { name: 'Open starfield', prompt: 'milky way', reference_image_ids: [] },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/requires reference images.*Open starfield/s),
    });
    // Fails fast — no pending tiles created.
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.artworks || []).toHaveLength(0);
  });

  it('rejects a character sheet with an empty pool on a refs-required catalog model (400)', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'NoRefs', hollywood_actor: 'Z' });
    await expect(
      Sheet.startImageSheetJob({
        projectId,
        hostType: 'character',
        hostId: c._id.toString(),
        model: 'fal-ai/edit-only/model',
        referenceImageIds: [],
        shotCount: 2,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/requires reference images/i),
    });
  });

  it('accepts refless plates on models that can generate from a prompt alone', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'FreeGen', body: 'EXT. SKY' });
    const { job_id } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shots: [{ name: 'Starfield', prompt: 'milky way', reference_image_ids: [] }],
    });
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
  });
});

describe('startImageSheetJob — validation', () => {
  it('rejects an unknown model with status 400', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'V', hollywood_actor: 'Z' });
    await expect(
      Sheet.startImageSheetJob({ projectId, hostType: 'character', hostId: c._id.toString(), model: 'bogus', shotCount: 2 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a missing host with status 404', async () => {
    await expect(
      Sheet.startImageSheetJob({ projectId, hostType: 'character', hostId: new ObjectId().toString(), model: 'nano-banana-pro', shotCount: 2 }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a FAL model with status 400 when FAL is not configured', async () => {
    h.fal.configured = false;
    const c = await Characters.createCharacter({ projectId, name: 'NoKey', hollywood_actor: 'Z' });
    await expect(
      Sheet.startImageSheetJob({ projectId, hostType: 'character', hostId: c._id.toString(), model: 'nano-banana-pro', shotCount: 2 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a second concurrent sheet on the same host with status 409', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Busy', hollywood_actor: 'Z' });
    const first = await Sheet.startImageSheetJob({
      projectId, hostType: 'character', hostId: c._id.toString(), model: 'nano-banana-pro', shotCount: 5,
    });
    await expect(
      Sheet.startImageSheetJob({ projectId, hostType: 'character', hostId: c._id.toString(), model: 'nano-banana-pro', shotCount: 5 }),
    ).rejects.toMatchObject({ status: 409 });
    await waitForJob(first.job_id); // let the first finish so it releases the host
  });
});
