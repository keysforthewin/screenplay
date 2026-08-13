// Beat-aware set plate planning + the one-shot "auto image sheet" job that
// chains plan → render for a set with no human review step. Same harness as
// imageSheetJobs.test.js: the leaf FAL provider is mocked, the two planner
// phases are stubbed via their test seams, everything else runs real against
// the fake Mongo.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';
import { config } from '../src/config.js';

const fakeDb = createFakeDb();

const h = vi.hoisted(() => ({
  dispatch: { calls: 0, failOnCall: 0 },
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
  readImageBuffer: vi.fn(async () => ({
    buffer: Buffer.from('ref'),
    file: { contentType: 'image/png', metadata: {} },
  })),
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
vi.mock('../src/openai/imageClient.js', () => ({
  generateCharacterSheetImage: vi.fn(),
  generateCharacterSheetImageEdit: vi.fn(),
  GPT_IMAGE_MODEL: 'gpt-image-2',
}));
vi.mock('../src/fal/imageClient.js', () => ({
  generateNanoBananaProImage: async () => {
    h.dispatch.calls += 1;
    const callNo = h.dispatch.calls;
    await new Promise((r) => setTimeout(r, 5));
    if (h.dispatch.failOnCall && callNo === h.dispatch.failOnCall) {
      throw new Error('provider boom');
    }
    return { buffer: Buffer.from('img'), contentType: 'image/png' };
  },
  generateFluxKontextImage: vi.fn(),
  generateFlux2ProImage: vi.fn(),
  generateGemini25FlashImage: vi.fn(),
  generateNanoBanana2Image: vi.fn(),
  generateFlux2KleinImage: vi.fn(),
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext',
  FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro',
  NANO_BANANA_PRO_GENERATE_MODEL: 'nano-banana-pro',
  GEMINI_25_FLASH_GENERATE_MODEL: 'fal-ai/gemini-25-flash-image',
  NANO_BANANA_2_GENERATE_MODEL: 'fal-ai/nano-banana-2',
  FLUX_2_KLEIN_GENERATE_MODEL: 'fal-ai/flux-2/klein/9b',
}));

const { createProject } = await import('../src/mongo/projects.js');
const Sets = await import('../src/mongo/sets.js');
const Plots = await import('../src/mongo/plots.js');
const Planner = await import('../src/web/beatSheetPlanner.js');
const Sheet = await import('../src/web/imageSheetJobs.js');
const Images = await import('../src/mongo/images.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  h.dispatch.calls = 0;
  h.dispatch.failOnCall = 0;
  h.fal.configured = true;
  Planner._setScenePlatePlannerForTests(null);
  Planner._setScenePlateCritiqueForTests(null);
  Images.findImageFile.mockImplementation(async () => null);
});

async function waitForStatus(jobId, statuses, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Sheet.getImageSheetJob(jobId);
    if (job && statuses.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job did not reach ${statuses.join('/')} in time`);
}

const TERMINAL = ['done', 'partial', 'error'];

function stubPlanner(plates, onArgs) {
  Planner._setScenePlatePlannerForTests(async (args) => {
    if (onArgs) onArgs(args);
    return plates;
  });
  Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
}

async function makeLinkedSet() {
  const set = await Sets.createSet({
    projectId,
    name: 'Alley',
    description: 'THE SET DESCRIPTION: narrow brick alley.',
  });
  const b1 = await Plots.createBeat({ projectId, name: 'Chase', body: 'FIRST BEAT BODY TEXT', sets: ['Alley'] });
  const b2 = await Plots.createBeat({ projectId, name: 'Aftermath', body: 'SECOND BEAT BODY TEXT', sets: ['alley'] });
  await Plots.createBeat({ projectId, name: 'Elsewhere', body: 'UNLINKED BEAT TEXT', sets: ['Rooftop'] });
  return { set, b1, b2 };
}

describe('startShotPlanJob — set with beatIds', () => {
  it('feeds the set description AND the selected beats\' text to the planner', async () => {
    let plannerBeat = null;
    stubPlanner(
      [{ name: 'Alley — wide', prompt: 'wide alley', justification: '', quote: '' }],
      (args) => { plannerBeat = args.beat; },
    );
    const { set, b1 } = await makeLinkedSet();
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostType: 'set',
      hostId: set._id.toString(),
      referenceImageIds: [],
      beatIds: [b1._id.toString()],
    });
    const job = await waitForStatus(job_id, ['derived', 'error']);
    expect(job.status).toBe('derived');
    expect(plannerBeat.body).toContain('THE SET DESCRIPTION: narrow brick alley.');
    expect(plannerBeat.body).toContain('FIRST BEAT BODY TEXT');
    expect(plannerBeat.body).not.toContain('SECOND BEAT BODY TEXT');
    expect(job.beat_ids).toEqual([b1._id.toString()]);
  });

  it('includes ALL linked beats when beatIds is empty', async () => {
    let plannerBeat = null;
    stubPlanner([], (args) => { plannerBeat = args.beat; });
    const { set } = await makeLinkedSet();
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostType: 'set',
      hostId: set._id.toString(),
      referenceImageIds: [],
    });
    await waitForStatus(job_id, ['derived', 'error']);
    expect(plannerBeat.body).toContain('FIRST BEAT BODY TEXT');
    expect(plannerBeat.body).toContain('SECOND BEAT BODY TEXT');
    expect(plannerBeat.body).not.toContain('UNLINKED BEAT TEXT');
  });
});

describe('startShotPlanJob — set with a main beat', () => {
  it('plans plates for the main beat only; selected beats become labeled context', async () => {
    let plannerBeat = null;
    stubPlanner(
      [{ name: 'Alley — wide', prompt: 'wide alley', justification: '', quote: '' }],
      (args) => { plannerBeat = args.beat; },
    );
    const { set, b1, b2 } = await makeLinkedSet();
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostType: 'set',
      hostId: set._id.toString(),
      referenceImageIds: [],
      mainBeatId: b1._id.toString(),
      beatIds: [b2._id.toString()],
    });
    const job = await waitForStatus(job_id, ['derived', 'error']);
    expect(job.status).toBe('derived');
    expect(job.main_beat_id).toBe(b1._id.toString());
    expect(job.beat_ids).toEqual([b2._id.toString()]);

    const body = plannerBeat.body;
    const mainIdx = body.indexOf('## MAIN BEAT');
    const ctxIdx = body.indexOf('## Context beats');
    expect(mainIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeGreaterThan(mainIdx);
    expect(body.indexOf('FIRST BEAT BODY TEXT')).toBeGreaterThan(mainIdx);
    expect(body.indexOf('FIRST BEAT BODY TEXT')).toBeLessThan(ctxIdx);
    expect(body.indexOf('SECOND BEAT BODY TEXT')).toBeGreaterThan(ctxIdx);
    expect(plannerBeat.desc).toContain('MAIN BEAT');
  });

  it('with a main beat, empty beatIds means NO context beats', async () => {
    let plannerBeat = null;
    stubPlanner([], (args) => { plannerBeat = args.beat; });
    const { set, b1 } = await makeLinkedSet();
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostType: 'set',
      hostId: set._id.toString(),
      referenceImageIds: [],
      mainBeatId: b1._id.toString(),
      beatIds: [],
    });
    await waitForStatus(job_id, ['derived', 'error']);
    expect(plannerBeat.body).toContain('FIRST BEAT BODY TEXT');
    expect(plannerBeat.body).not.toContain('Context beats');
    expect(plannerBeat.body).not.toContain('SECOND BEAT BODY TEXT');
  });

  it('never duplicates the main beat into the context section', async () => {
    let plannerBeat = null;
    stubPlanner([], (args) => { plannerBeat = args.beat; });
    const { set, b1, b2 } = await makeLinkedSet();
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostType: 'set',
      hostId: set._id.toString(),
      referenceImageIds: [],
      mainBeatId: b1._id.toString(),
      beatIds: [b1._id.toString(), b2._id.toString()],
    });
    await waitForStatus(job_id, ['derived', 'error']);
    const occurrences = plannerBeat.body.split('FIRST BEAT BODY TEXT').length - 1;
    expect(occurrences).toBe(1);
    expect(plannerBeat.body).toContain('SECOND BEAT BODY TEXT');
  });

  it('falls back to legacy flattening when the main beat no longer references the set', async () => {
    let plannerBeat = null;
    stubPlanner([], (args) => { plannerBeat = args.beat; });
    const { set } = await makeLinkedSet();
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostType: 'set',
      hostId: set._id.toString(),
      referenceImageIds: [],
      mainBeatId: new ObjectId().toString(),
      beatIds: [],
    });
    await waitForStatus(job_id, ['derived', 'error']);
    expect(plannerBeat.body).not.toContain('MAIN BEAT');
    expect(plannerBeat.body).toContain('FIRST BEAT BODY TEXT');
    expect(plannerBeat.body).toContain('SECOND BEAT BODY TEXT');
  });
});

describe('setAsPlannerBeat', () => {
  it('caps context beats without counting the main beat', () => {
    const mk = (i) => ({ order: i, name: `B${i}`, body: `BODY-${i} TEXT` });
    const main = mk(0);
    const ctx = Array.from({ length: 13 }, (_, i) => mk(i + 1));
    const { body } = Sheet.setAsPlannerBeat(
      { name: 'S', description: 'DESC' },
      { mainBeat: main, contextBeats: ctx },
    );
    expect(body).toContain('BODY-0 TEXT');
    expect(body).toContain('BODY-12 TEXT');
    expect(body).not.toContain('BODY-13 TEXT');
  });

  it('keeps the legacy shape (no MAIN BEAT section, legacy desc) without a main beat', () => {
    const { body, desc } = Sheet.setAsPlannerBeat(
      { name: 'S', description: 'DESC' },
      { contextBeats: [{ order: 1, name: 'B1', body: 'BODY-1 TEXT' }] },
    );
    expect(body).not.toContain('MAIN BEAT');
    expect(body).toContain('## Beat #1 — B1');
    expect(desc).toContain('the beats below stage in it');
  });
});

describe('startAutoSheetJob', () => {
  it('chains plan → render: artworks land on the set, job ends "done"', async () => {
    stubPlanner([
      { name: 'Alley — wide', prompt: 'wide empty alley', justification: '', quote: '' },
      { name: 'Brick — insert', prompt: 'wet brick close-up', justification: '', quote: '' },
    ]);
    const { set } = await makeLinkedSet();
    const { job_id, host_type, host_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
    });
    expect(host_type).toBe('set');
    expect(host_id).toBe(set._id.toString());
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.status).toBe('done');
    expect(job.kind).toBe('set_auto_sheet');
    expect(job.planned).toBe(2);
    expect(job.completed).toBe(2);
    expect(job.failed).toBe(0);

    const fresh = await Sets.getSet(projectId, set._id.toString());
    expect(fresh.artworks).toHaveLength(2);
    expect(fresh.artworks.map((a) => a.name).sort()).toEqual(['Alley — wide', 'Brick — insert']);
    for (const a of fresh.artworks) {
      expect(a.status).toBe('done');
      expect(a.result_image_id).toBeTruthy();
    }
  });

  it('defaults references to the set\'s gallery images', async () => {
    stubPlanner([{ name: 'A', prompt: 'a', justification: '', quote: '' }]);
    const { set } = await makeLinkedSet();
    const g1 = new ObjectId();
    const g2 = new ObjectId();
    await Sets.pushSetImage(projectId, set._id.toString(), { _id: g1 });
    await Sets.pushSetImage(projectId, set._id.toString(), { _id: g2 });

    const { job_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
    });
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.reference_image_ids).toEqual([g1.toString(), g2.toString()]);
    const fresh = await Sets.getSet(projectId, set._id.toString());
    expect(fresh.artworks[0].reference_image_ids.map(String)).toEqual([g1.toString(), g2.toString()]);
  });

  it('finishes "done" with no artworks when the planner returns nothing', async () => {
    stubPlanner([]);
    const { set } = await makeLinkedSet();
    const { job_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
    });
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.status).toBe('done');
    expect(job.planned).toBe(0);
    expect((await Sets.getSet(projectId, set._id.toString())).artworks).toHaveLength(0);
  });

  it('marks one failed render and finishes "partial"', async () => {
    h.dispatch.failOnCall = 1;
    stubPlanner([
      { name: 'A', prompt: 'a', justification: '', quote: '' },
      { name: 'B', prompt: 'b', justification: '', quote: '' },
    ]);
    const { set } = await makeLinkedSet();
    const { job_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
    });
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.status).toBe('partial');
    expect(job.completed).toBe(1);
    expect(job.failed).toBe(1);
    const fresh = await Sets.getSet(projectId, set._id.toString());
    expect(fresh.artworks.map((a) => a.status).sort()).toEqual(['done', 'error']);
  });

  it('holds ONE busy registration across plan+render: concurrent sheets 409 both ways', async () => {
    // Slow planner so the job is still planning when we try to collide with it.
    Planner._setScenePlatePlannerForTests(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return [{ name: 'A', prompt: 'a', justification: '', quote: '' }];
    });
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const { set } = await makeLinkedSet();
    const first = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
    });
    await expect(
      Sheet.startAutoSheetJob({ projectId, hostId: set._id.toString(), model: 'nano-banana-pro' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      Sheet.startImageSheetJob({
        projectId,
        hostType: 'set',
        hostId: set._id.toString(),
        model: 'nano-banana-pro',
        shots: [{ name: 'X', prompt: 'x' }],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await waitForStatus(first.job_id, TERMINAL);
    // Released after completion: a new sheet may start.
    const again = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'set',
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
      shots: [{ name: 'Y', prompt: 'y' }],
    });
    await waitForStatus(again.job_id, TERMINAL);
  });

  it('unions the checked sets\' galleries into the reference pool, deduped, in selection order', async () => {
    Images.findImageFile.mockImplementation(async () => ({ _id: 'exists' }));
    stubPlanner([{ name: 'A', prompt: 'a', justification: '', quote: '' }]);
    const { set } = await makeLinkedSet();
    const own = new ObjectId();
    const shared = new ObjectId();
    const o2 = new ObjectId();
    await Sets.pushSetImage(projectId, set._id.toString(), { _id: own });
    await Sets.pushSetImage(projectId, set._id.toString(), { _id: shared });
    const other = await Sets.createSet({ projectId, name: 'Rooftop' });
    await Sets.pushSetImage(projectId, other._id.toString(), { _id: shared });
    await Sets.pushSetImage(projectId, other._id.toString(), { _id: o2 });

    const { job_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
      referenceSetIds: [set._id.toString(), other._id.toString()],
    });
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.reference_image_ids).toEqual([own.toString(), shared.toString(), o2.toString()]);
    expect(job.reference_set_ids).toEqual([set._id.toString(), other._id.toString()]);
  });

  it('drops stale gallery ids that no longer resolve to a stored image', async () => {
    stubPlanner([{ name: 'A', prompt: 'a', justification: '', quote: '' }]);
    const { set } = await makeLinkedSet();
    const live = new ObjectId();
    const stale = new ObjectId();
    await Sets.pushSetImage(projectId, set._id.toString(), { _id: live });
    await Sets.pushSetImage(projectId, set._id.toString(), { _id: stale });
    Images.findImageFile.mockImplementation(async (id) =>
      String(id) === stale.toString() ? null : { _id: 'exists' });

    const { job_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
      referenceSetIds: [set._id.toString()],
    });
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.reference_image_ids).toEqual([live.toString()]);
  });

  it('an explicitly empty referenceSetIds means zero references (unlike the omitted default)', async () => {
    stubPlanner([{ name: 'A', prompt: 'a', justification: '', quote: '' }]);
    const { set } = await makeLinkedSet();
    await Sets.pushSetImage(projectId, set._id.toString(), { _id: new ObjectId() });
    const { job_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
      referenceSetIds: [],
    });
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.reference_image_ids).toEqual([]);
  });

  it('caps the unioned pool at MAX_SHEET_REFERENCE_IMAGES', async () => {
    Images.findImageFile.mockImplementation(async () => ({ _id: 'exists' }));
    stubPlanner([{ name: 'A', prompt: 'a', justification: '', quote: '' }]);
    const { set } = await makeLinkedSet();
    for (let i = 0; i < Sheet.MAX_SHEET_REFERENCE_IMAGES + 5; i++) {
      await Sets.pushSetImage(projectId, set._id.toString(), { _id: new ObjectId() });
    }
    const { job_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
      referenceSetIds: [set._id.toString()],
    });
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.reference_image_ids).toHaveLength(Sheet.MAX_SHEET_REFERENCE_IMAGES);
  });

  it('records the main beat on the job and threads it into planning', async () => {
    let plannerBeat = null;
    stubPlanner([{ name: 'A', prompt: 'a', justification: '', quote: '' }], (args) => { plannerBeat = args.beat; });
    const { set, b1, b2 } = await makeLinkedSet();
    const { job_id } = await Sheet.startAutoSheetJob({
      projectId,
      hostId: set._id.toString(),
      model: 'nano-banana-pro',
      mainBeatId: b1._id.toString(),
      beatIds: [b2._id.toString()],
    });
    const job = await waitForStatus(job_id, TERMINAL);
    expect(job.main_beat_id).toBe(b1._id.toString());
    expect(plannerBeat.body).toContain('## MAIN BEAT');
    expect(plannerBeat.body).toContain('FIRST BEAT BODY TEXT');
  });

  it('rejects 400 without ANTHROPIC_API_KEY, 400 without FAL, 404 unknown set', async () => {
    const { set } = await makeLinkedSet();
    const saved = config.anthropic.apiKey;
    config.anthropic.apiKey = '';
    try {
      await expect(
        Sheet.startAutoSheetJob({ projectId, hostId: set._id.toString(), model: 'nano-banana-pro' }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      config.anthropic.apiKey = saved;
    }
    h.fal.configured = false;
    await expect(
      Sheet.startAutoSheetJob({ projectId, hostId: set._id.toString(), model: 'nano-banana-pro' }),
    ).rejects.toMatchObject({ status: 400 });
    h.fal.configured = true;
    await expect(
      Sheet.startAutoSheetJob({ projectId, hostId: new ObjectId().toString(), model: 'nano-banana-pro' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
