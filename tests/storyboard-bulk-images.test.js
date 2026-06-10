// Bulk "Generate all images": targets each shot's start frame (frames[0]) that
// has no image, uses the stored prompt or the suggested fallback, and accounts
// for successes/failures without aborting on a single bad frame.
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
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  uploadGeneratedImage: vi.fn(async (_projectId, { filename }) => ({
    _id: new ObjectId(), filename, contentType: 'image/png', metadata: {},
  })),
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');

beforeEach(() => {
  fakeDb.reset();
  Generate._setImageDispatcherForTests(null);
  BeatLocks._clearBeatLocksForTests();
});

async function waitForJob(jobId) {
  for (let i = 0; i < 400; i++) {
    const job = Generate.getImageGenerationJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  return Generate.getImageGenerationJob(jobId);
}

// Create a beat with N shots; each gets a start frame unless skipFrame is set.
async function makeBeat({ shots }) {
  const beat = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'b', characters: [] });
  const out = [];
  for (const s of shots) {
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id, textPrompt: s.text || 'a shot', shotType: 'cinematic_wide',
    });
    let frameId = null;
    if (!s.skipFrame) {
      const r = await Storyboards.addFrame(sb._id, { imageId: s.imageId || null });
      frameId = r.frameId;
      if (s.prompt) await Storyboards.setFramePrompt(undefined, sb._id, frameId, s.prompt);
    }
    out.push({ sbId: sb._id, frameId });
  }
  return { beat, out };
}

describe('listMissingStartFrameTargets', () => {
  it('returns only shots whose start frame (frames[0]) has no image; skips empty pools and rendered starts', async () => {
    const { beat } = await makeBeat({ shots: [
      { prompt: 'p1' },                         // missing -> target
      { imageId: new ObjectId() },              // already rendered -> skip
      { skipFrame: true },                      // no start frame -> skip
    ] });
    const targets = await Generate.listMissingStartFrameTargets(beat._id);
    expect(targets).toHaveLength(1);
    expect(targets[0].frame.prompt).toBe('p1');
  });
});

describe('startBulkFrameGenerationJob', () => {
  it('generates only the missing start frames and reports planned/completed', async () => {
    const midImage = new ObjectId();
    const { beat, out } = await makeBeat({ shots: [
      { prompt: 'first shot' },
      { imageId: midImage },              // skipped — must stay untouched
      { prompt: 'third shot' },
    ] });
    const seen = [];
    Generate._setImageDispatcherForTests(async (args) => {
      seen.push(args.prompt);
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    const { jobId, planned } = await Generate.startBulkFrameGenerationJob({
      beatId: beat._id, imageModel: 'gemini',
    });
    expect(planned).toBe(2);
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(2);
    expect(job.failed).toBe(0);
    expect(seen.sort()).toEqual(['first shot', 'third shot']);

    const sb0 = await Storyboards.getStoryboard(undefined, out[0].sbId);
    expect(sb0.frames[0].image_id).toBeTruthy();

    // The already-rendered middle shot must NOT be regenerated/overwritten.
    const sb1 = await Storyboards.getStoryboard(undefined, out[1].sbId);
    expect(sb1.frames[0].image_id.toString()).toBe(midImage.toString());
  });

  it('falls back to the suggested prompt when a start frame has no stored prompt', async () => {
    const { beat } = await makeBeat({ shots: [{ /* no prompt */ }] });
    let captured = null;
    Generate._setImageDispatcherForTests(async (args) => {
      captured = args.prompt;
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });
    const { jobId } = await Generate.startBulkFrameGenerationJob({ beatId: beat._id });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(typeof captured).toBe('string');
    expect(captured.trim().length).toBeGreaterThan(0);
    expect(captured).toMatch(/cinematic_wide|wide/i);
  });

  it('continues past a failing frame and finishes as partial', async () => {
    const { beat } = await makeBeat({ shots: [{ prompt: 'good' }, { prompt: 'bad' }] });
    Generate._setImageDispatcherForTests(async (args) => {
      if (args.prompt === 'bad') throw new Error('model boom');
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });
    const { jobId } = await Generate.startBulkFrameGenerationJob({ beatId: beat._id });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('partial');
    expect(job.completed).toBe(1);
    expect(job.failed).toBe(1);
  });

  it('finishes immediately as done with planned=0 when nothing is missing', async () => {
    const { beat } = await makeBeat({ shots: [{ imageId: new ObjectId() }] });
    const { jobId, planned } = await Generate.startBulkFrameGenerationJob({ beatId: beat._id });
    expect(planned).toBe(0);
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(0);
  });

  it('throws BeatBusyError when the beat lock is already held', async () => {
    const { beat } = await makeBeat({ shots: [{ prompt: 'p' }] });
    const { withBeatLock } = await import('../src/web/beatLocks.js');
    let release;
    const held = new Promise((r) => { release = r; });
    withBeatLock(beat._id, () => held); // hold the lock
    await expect(
      Generate.startBulkFrameGenerationJob({ beatId: beat._id }),
    ).rejects.toThrow(/in progress/i);
    release();
  });
});
