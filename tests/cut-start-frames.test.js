// Pass 5: start frames per cut — references (planner picks vs auto-scored),
// dispatch through the seam, GridFS upload (mocked), the undo slot, edit
// mode, and the bulk/single jobs under the beat lock.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null, withDirectDocument: vi.fn(), broadcastRoomStateless: vi.fn(), isHocuspocusRunning: () => false,
}));

const store = new Map();
const uploads = [];
const deleted = [];
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readImageBuffer: vi.fn(async (id) => {
      const e = store.get(String(id));
      if (!e) return null;
      return { buffer: e.buffer, file: { _id: new ObjectId(String(id)), contentType: 'image/png', metadata: { description: e.description || '' } } };
    }),
    findImageFile: vi.fn(async (id) => {
      const e = store.get(String(id));
      if (!e) return null;
      return { _id: new ObjectId(String(id)), filename: 'x.png', contentType: 'image/png', length: e.buffer.length, metadata: { description: e.description || '' } };
    }),
    uploadGeneratedImage: vi.fn(async (_pid, args) => {
      const id = new ObjectId();
      store.set(id.toString(), { buffer: args.buffer, description: '' });
      uploads.push({ id, ...args });
      return { _id: id, filename: args.filename };
    }),
    deleteImages: vi.fn(async (ids) => { for (const id of ids) deleted.push(String(id)); }),
    deleteImage: vi.fn(async (id) => { deleted.push(String(id)); }),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Sel = await import('../src/llm/frameReferenceSelector.js');
const SF = await import('../src/web/cutStartFrames.js');

let projectId;
let dispatched;
beforeEach(async () => {
  fakeDb.reset();
  store.clear();
  uploads.length = 0;
  deleted.length = 0;
  dispatched = [];
  BeatLocks._clearBeatLocksForTests();
  SF._clearCutStartFrameJobsForTests();
  Sel._setFrameReferenceScorerForTests(null);
  SF._setStartFrameDispatcherForTests(async (args) => {
    dispatched.push(args);
    return { buffer: Buffer.from(`render-${dispatched.length}`), contentType: 'image/png', model: args.model };
  });
  projectId = (await createProject('Frames'))._id.toString();
});

function img(desc) {
  const id = new ObjectId();
  store.set(id.toString(), { buffer: Buffer.from(desc), description: desc });
  return id;
}

async function seed() {
  const sarahArt = img('Sarah, grey coat');
  const sarahAlt = img('Sarah, bare arms, summer');
  const dinerArt = img('Diner interior, night');
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Sarah', name_lower: 'sarah', fields: {},
    artworks: [
      { _id: new ObjectId(), status: 'done', result_image_id: sarahArt, name: 'Coat', description: 'Sarah, grey coat' },
      { _id: new ObjectId(), status: 'done', result_image_id: sarahAlt, name: 'Summer', description: 'Sarah, bare arms, summer' },
    ],
    created_at: new Date(), updated_at: new Date(),
  });
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Diner', name_lower: 'diner', description: '',
    artworks: [{ _id: new ObjectId(), status: 'done', result_image_id: dinerArt, name: 'Interior', description: 'Diner interior, night' }],
    created_at: new Date(), updated_at: new Date(),
  });
  const beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'Sarah waits.', characters: ['Sarah'], sets: ['Diner'] });
  return { beat, sarahArt, sarahAlt, dinerArt };
}

async function waitJob(id) {
  for (let i = 0; i < 500; i++) {
    const j = SF.getCutStartFrameJob(id);
    if (j && ['done', 'partial', 'error'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never finished');
}

describe('renderCutStartFrame', () => {
  it('uses the planner picks in order, uploads under the beat, persists the frame and syncs the prompt', async () => {
    const { beat, sarahArt, dinerArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'], setsInScene: ['Diner'],
      startFrame: { prompt: 'Wide, 24mm: a woman in a grey coat in the booth.', reference_ids: [dinerArt, sarahArt] },
    });
    const r = await SF.renderCutStartFrame({ projectId, cut, beat });
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].model).toBe(SF.DEFAULT_START_FRAME_MODEL);
    expect(dispatched[0].mode).toBe('generate');
    // The character goes first (identity), the set last as a look reference,
    // and the hosted model is told which is which.
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['Sarah, grey coat', 'Diner interior, night']);
    expect(dispatched[0].prompt).toContain('This is not an edit of any input image');
    expect(dispatched[0].prompt).toContain('Image 1 is Sarah: take only the face, hair, build and wardrobe from it.');
    expect(dispatched[0].prompt).toContain('Image 2 shows the set "Diner" from a different camera');
    expect(dispatched[0].prompt.endsWith('Wide, 24mm: a woman in a grey coat in the booth.')).toBe(true);
    expect(uploads[0].ownerType).toBe('beat');
    expect(String(uploads[0].ownerId)).toBe(String(beat._id));
    expect(uploads[0].filename).toMatch(new RegExp(`^cut-${cut._id}-start-frame-`));
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(String(saved.start_frame.image_id)).toBe(r.image_id);
    expect(saved.start_frame.reference_ids.map(String)).toEqual([String(dinerArt), String(sarahArt)]);
    expect(saved.start_frame.model).toBe(SF.DEFAULT_START_FRAME_MODEL);
    expect(saved.start_frame.previous_image_id).toBeNull();
  });

  it('auto-selects scored artwork when there are no picks, honours the project image default, and rotates the undo slot', async () => {
    const { beat, sarahArt, sarahAlt, dinerArt } = await seed();
    await fakeDb.collection('project_settings').insertOne({ _id: projectId, model_defaults: { image_with_refs: 'flux-kontext' } });
    // The scorer answers by 1-based catalog number, 0..1.
    Sel._setFrameReferenceScorerForTests(async ({ candidates }) => {
      const m = new Map();
      candidates.forEach((c, i) => m.set(i + 1, c.id === String(sarahAlt) ? 0.1 : c.id === String(sarahArt) ? 0.9 : 0.7));
      return m;
    });
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'], setsInScene: ['Diner'],
      startFrame: { prompt: 'Sarah in the booth.', reference_ids: [] },
    });
    const first = await SF.renderCutStartFrame({ projectId, cut, beat });
    expect(dispatched[0].model).toBe('flux-kontext');
    // Every source is represented; the attached buffers go best-scored first
    // and the low-scored alternate never outranks the others.
    expect(first.reference_ids).toEqual(expect.arrayContaining([String(sarahArt), String(dinerArt)]));
    // Best-scored first within a role; the set (a look reference) goes last.
    const sent = dispatched[0].inputImages.map((i) => i.buffer.toString());
    expect(sent[0]).toBe('Sarah, grey coat');
    expect(sent[sent.length - 1]).toBe('Diner interior, night');

    // Second render with a one-off prompt: the new prompt is stored, the old
    // image moves to previous_image_id, nothing is deleted yet.
    const again = await VP.getVideoPrompt(projectId, String(cut._id));
    const second = await SF.renderCutStartFrame({ projectId, cut: again, beat, prompt: 'Closer, 50mm.', imageModel: 'nano-banana-pro' });
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(String(saved.start_frame.image_id)).toBe(second.image_id);
    expect(String(saved.start_frame.previous_image_id)).toBe(first.image_id);
    expect(saved.start_frame.prompt).toBe('Closer, 50mm.');
    expect(deleted).toEqual([]);

    // Third render evicts the oldest image from the undo slot.
    const third = await SF.renderCutStartFrame({ projectId, cut: saved, beat });
    const final = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(String(final.start_frame.previous_image_id)).toBe(second.image_id);
    expect(String(final.start_frame.image_id)).toBe(third.image_id);
    expect(deleted).toEqual([first.image_id]);
  });

  it('tells the image model what the cut means: felt intent, eyeline and the block\'s limits ride under the still prompt', async () => {
    const { beat } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'Hurry', feltIntent: 'A kid in a hurry.', eyeline: 'On the doors, never the lens.', exclusions: ['Do not show his face from the front.'],
      startFrame: { prompt: 'Wide on the lot.', reference_ids: [], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat });
    expect(dispatched[0].prompt).toContain('Wide on the lot.');
    expect(dispatched[0].prompt).toContain('What it must read as at a glance: A kid in a hurry.');
    expect(dispatched[0].prompt).toContain('Eyes: On the doors, never the lens.');
    expect(dispatched[0].prompt).toContain('Hard limits: Do not show his face from the front.');
    // The stored still prompt stays the still prompt.
    expect((await VP.getVideoPrompt(projectId, String(cut._id))).start_frame.prompt).toBe('Wide on the lot.');
  });

  it('respects a planned empty reference list instead of auto-filling it', async () => {
    const { beat } = await seed();
    Sel._setFrameReferenceScorerForTests(async () => { throw new Error('auto-selection must not run'); });
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'], setsInScene: ['Diner'],
      startFrame: { prompt: 'Close-up of a seat back.', reference_ids: [], references_planned: true },
    });
    const r = await SF.renderCutStartFrame({ projectId, cut, beat });
    expect(r.reference_ids).toEqual([]);
    expect(dispatched[0].inputImages).toEqual([]);
    expect(dispatched[0].prompt).toBe('Close-up of a seat back.');
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.start_frame.references_planned).toBe(true);
  });

  it('a set pick marked "framing" goes first and is bound to its viewpoint', async () => {
    const { beat, sarahArt, dinerArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'], setsInScene: ['Diner'],
      startFrame: {
        prompt: 'Wide from the counter.',
        reference_ids: [sarahArt, dinerArt],
        reference_uses: { [String(dinerArt)]: 'framing' },
        references_planned: true,
      },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat });
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['Diner interior, night', 'Sarah, grey coat']);
    expect(dispatched[0].prompt).toContain('Image 1 shows the set "Diner" from almost this camera');
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.start_frame.reference_uses).toEqual({ [String(dinerArt)]: 'framing' });
  });

  it('edit mode feeds the current frame first, keeps the stored prompt, and refuses without a frame', async () => {
    const { beat, sarahArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'],
      startFrame: { prompt: 'Sarah in the booth.', reference_ids: [sarahArt] },
    });
    await expect(SF.renderCutStartFrame({ projectId, cut, beat, mode: 'edit', editPrompt: 'Add rain' })).rejects.toBeInstanceOf(SF.StartFrameInputError);
    await SF.renderCutStartFrame({ projectId, cut, beat });
    const withFrame = await VP.getVideoPrompt(projectId, String(cut._id));
    const extra = img('extra prop');
    await SF.renderCutStartFrame({ projectId, cut: withFrame, beat, mode: 'edit', editPrompt: 'Add rain on the window', editReferenceImageIds: [extra] });
    expect(dispatched[1].mode).toBe('edit');
    expect(dispatched[1].prompt).toBe('Add rain on the window');
    expect(dispatched[1].inputImages.map((i) => i.buffer.toString())).toEqual(['render-1', 'extra prop']);
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.start_frame.prompt).toBe('Sarah in the booth.');
    expect(String(saved.start_frame.previous_image_id)).toBe(String(withFrame.start_frame.image_id));
  });

  it('throws a 400-class error when the cut has no prompt at all', async () => {
    const { beat } = await seed();
    const cut = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'c' });
    await expect(SF.renderCutStartFrame({ projectId, cut, beat })).rejects.toMatchObject({ status: 400 });
  });
});

describe('jobs', () => {
  it('bulk job skips rendered cuts, records per-cut failures as partial, and holds the beat lock', async () => {
    const { beat, sarahArt } = await seed();
    const done = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'done', order: 1, startFrame: { prompt: 'p', reference_ids: [sarahArt], image_id: img('already') } });
    const todo = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'todo', order: 2, startFrame: { prompt: 'p', reference_ids: [sarahArt] } });
    const broken = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'broken', order: 3 });
    let sawLock = false;
    SF._setStartFrameDispatcherForTests(async (args) => {
      sawLock = BeatLocks.isBeatLocked(beat._id);
      dispatched.push(args);
      return { buffer: Buffer.from('r'), contentType: 'image/png' };
    });
    const jobId = await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id) });
    await expect(SF.startCutStartFramesJob({ projectId, beatId: String(beat._id) })).rejects.toBeInstanceOf(SF.BeatBusyError);
    const job = await waitJob(jobId);
    expect(sawLock).toBe(true);
    expect(job.status).toBe('partial');
    expect(job).toMatchObject({ planned: 3, rendered: 1, failed: 1, skipped: 1 });
    expect(job.warnings).toEqual([expect.stringMatching(/"broken" failed: This cut has no start-frame prompt yet/)]);
    expect(job.results.find((r) => r.cut_id === String(done._id)).skipped).toBe(true);
    expect(job.results.find((r) => r.cut_id === String(todo._id)).image_id).toBeTruthy();
    expect(job.results.find((r) => r.cut_id === String(broken._id)).error).toMatch(/no start-frame prompt/);
    expect(BeatLocks.isBeatLocked(beat._id)).toBe(false);
    // skip_rendered:false re-renders the finished one too.
    const job2 = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), cutIds: [String(done._id)], skipRendered: false }));
    expect(job2).toMatchObject({ status: 'done', rendered: 1, skipped: 0 });
  });

  it('single job validates up front and renders one cut', async () => {
    const { beat, sarahArt } = await seed();
    const cut = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'c', startFrame: { prompt: '', reference_ids: [sarahArt] } });
    await expect(SF.startSingleCutStartFrameJob({ projectId, cutId: String(cut._id) })).rejects.toMatchObject({ status: 400 });
    await expect(SF.startSingleCutStartFrameJob({ projectId, cutId: String(cut._id), mode: 'edit', editPrompt: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(SF.startSingleCutStartFrameJob({ projectId, cutId: new ObjectId().toString() })).rejects.toBeInstanceOf(SF.CutNotFoundError);
    const job = await waitJob(await SF.startSingleCutStartFrameJob({ projectId, cutId: String(cut._id), prompt: 'One-off prompt.' }));
    expect(job).toMatchObject({ status: 'done', rendered: 1 });
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.start_frame.prompt).toBe('One-off prompt.');
    expect(String(saved.start_frame.image_id)).toBe(job.results[0].image_id);
  });
});

describe('wardrobe lock', () => {
  async function lockSarah({ plate = true, text = 'grey wool coat, black boots' } = {}) {
    const plateId = plate ? img('Sarah, wardrobe plate') : null;
    await fakeDb.collection('characters').updateOne(
      { project_id: projectId, name_lower: 'sarah' },
      { $set: { fields: { wardrobe: text }, ...(plateId ? { wardrobe_image_id: plateId } : {}) } },
    );
    return plateId;
  }

  it('attaches the in-frame character\'s plate as a wardrobe reference and appends the lock under the still prompt', async () => {
    const { beat, sarahArt, dinerArt } = await seed();
    const plateId = await lockSarah();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'], setsInScene: ['Diner'],
      inFrame: [{ character: 'Sarah', position: 'booth', facing: 'camera' }],
      startFrame: { prompt: 'Wide: the woman in the grey coat in the booth.', reference_ids: [dinerArt, sarahArt], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat, imageModel: 'comfy:qwen-image-2.1-edit' });
    expect(dispatched[0].inputImages.map((i) => [i.label, i.role])).toEqual([['Sarah', 'identity'], ['Sarah', 'wardrobe'], ['the set "Diner"', 'look']]);
    expect(dispatched[0].inputImages[1].buffer.toString()).toBe('Sarah, wardrobe plate');
    expect(dispatched[0].prompt).toContain('Wardrobe lock — Sarah: grey wool coat, black boots');
    expect(dispatched[0].prompt).toContain('Clothes are locked');
    // The appendix is never stored in the prompt.
    const after = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(after.start_frame.prompt).toBe('Wide: the woman in the grey coat in the booth.');
    expect(String(plateId)).toBeTruthy();
  });

  it('hosted models get the wardrobe binding line', async () => {
    const { beat, sarahArt } = await seed();
    await lockSarah();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'],
      inFrame: [{ character: 'Sarah' }],
      startFrame: { prompt: 'Sarah.', reference_ids: [sarahArt], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat, imageModel: 'nano-banana-pro' });
    expect(dispatched[0].prompt).toContain("Image 2 is Sarah's wardrobe plate: this person wears exactly these garments");
    expect(dispatched[0].inputImages).toHaveLength(2);
  });

  it('a planner pick of the plate itself is bound as wardrobe, not identity, and is not attached twice', async () => {
    const { beat } = await seed();
    const plateId = await lockSarah();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'],
      inFrame: [{ character: 'Sarah' }],
      startFrame: { prompt: 'Sarah.', reference_ids: [plateId], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat, imageModel: 'comfy:qwen-image-2.1-edit' });
    expect(dispatched[0].inputImages.map((i) => [i.label, i.role])).toEqual([['Sarah', 'wardrobe']]);
  });

  it('is dropped for an end frame that carries the continuity frame, and skipped for a person not in frame', async () => {
    const { beat, sarahArt } = await seed();
    await lockSarah();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'],
      inFrame: [{ character: 'Sarah' }],
      startFrame: { prompt: 'Sarah.', reference_ids: [sarahArt], references_planned: true },
      endFrame: { prompt: 'Sarah, later.', reference_ids: [sarahArt], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat });
    const fresh = await VP.getVideoPrompt(projectId, String(cut._id));
    await SF.renderCutStartFrame({ projectId, cut: fresh, beat, frame: 'end' });
    expect(dispatched[1].inputImages).toHaveLength(2);
    expect(dispatched[1].prompt).toContain('Image 2 is the opening frame of this same shot');
    expect(dispatched[1].prompt).not.toContain('wardrobe plate');
    // The lock words still ride under the prompt.
    expect(dispatched[1].prompt).toContain('Wardrobe lock — Sarah');

    const other = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'd', charactersInScene: ['Sarah'],
      inFrame: [{ character: 'Tom' }],
      startFrame: { prompt: 'Tom alone.', reference_ids: [], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut: other, beat });
    expect(dispatched[2].inputImages).toEqual([]);
    expect(dispatched[2].prompt).not.toContain('Wardrobe lock');
  });

  it('a text-only lock (no plate) still reaches the prompt; an edit never gets it', async () => {
    const { beat, sarahArt } = await seed();
    await lockSarah({ plate: false });
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'],
      startFrame: { prompt: 'Sarah.', reference_ids: [sarahArt], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat });
    expect(dispatched[0].inputImages).toHaveLength(1);
    expect(dispatched[0].prompt).toContain('Wardrobe lock — Sarah: grey wool coat, black boots');
    const fresh = await VP.getVideoPrompt(projectId, String(cut._id));
    await SF.renderCutStartFrame({ projectId, cut: fresh, beat, mode: 'edit', editPrompt: 'Brighter.' });
    expect(dispatched[1].prompt).toBe('Brighter.');
  });
});

describe('local ComfyUI image models', () => {
  it('introduces each reference by subject and forwards the render parameters', async () => {
    const { beat, sarahArt, dinerArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'], setsInScene: ['Diner'],
      startFrame: { prompt: 'Wide: Sarah in the booth.', reference_ids: [dinerArt, sarahArt] },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat, imageModel: 'comfy:qwen-image-2.1-edit', comfyParams: { steps: 12 } });
    expect(dispatched[0].model).toBe('comfy:qwen-image-2.1-edit');
    expect(dispatched[0].comfyParams).toEqual({ steps: 12 });
    // ComfyUI writes the binding itself (its own reference token), so the
    // prompt goes through bare and each reference carries its label + role.
    expect(dispatched[0].prompt).toBe('Wide: Sarah in the booth.');
    expect(dispatched[0].inputImages.map((i) => [i.label, i.role])).toEqual([['Sarah', 'identity'], ['the set "Diner"', 'look']]);
  });

  it('hosted models get neither labels nor comfy parameters', async () => {
    const { beat, sarahArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'], setsInScene: ['Diner'],
      startFrame: { prompt: 'Sarah.', reference_ids: [sarahArt] },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat, imageModel: 'nano-banana-pro', comfyParams: { steps: 12 } });
    expect(dispatched[0].comfyParams).toBeUndefined();
    expect(dispatched[0].inputImages[0].label).toBeUndefined();
  });
});

describe('cancelCutStartFrameJob', () => {
  it('stops before the next cut, keeps what finished and reports the rest as not rendered', async () => {
    const { beat, sarahArt } = await seed();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const c = await VP.createVideoPrompt({
        projectId, beatId: beat._id, title: `c${i}`, charactersInScene: ['Sarah'], setsInScene: ['Diner'],
        startFrame: { prompt: `Frame ${i}.`, reference_ids: [sarahArt] },
      });
      ids.push(String(c._id));
    }
    let jobId = null;
    SF._setStartFrameDispatcherForTests(async (args) => {
      dispatched.push(args);
      SF.cancelCutStartFrameJob(jobId); // cancel lands while the first renders are in flight
      await new Promise((r) => setTimeout(r, 10));
      return { buffer: Buffer.from('x'), contentType: 'image/png', model: args.model };
    });
    jobId = await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), cutIds: ids });
    const job = await waitJob(jobId);
    expect(job.status).toBe('partial');
    expect(job.cancelled).toBe(true);
    expect(job.rendered).toBe(SF.START_FRAME_CONCURRENCY);
    expect(dispatched.length).toBe(SF.START_FRAME_CONCURRENCY);
    expect(job.warnings.at(-1)).toMatch(/Cancelled — 2 frames not rendered/);
    expect(SF.cancelCutStartFrameJob('nope')).toBeNull();
  });
});

describe('clearBeatStartFrames', () => {
  it('deletes every rendered frame and its undo copy, keeping prompts, references and the cuts', async () => {
    const { beat, sarahArt } = await seed();
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'a', startFrame: { prompt: 'A.', reference_ids: [sarahArt] } });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'b', startFrame: { prompt: 'B.', reference_ids: [] } });
    await SF.renderCutStartFrame({ projectId, cut: a, beat });
    await SF.renderCutStartFrame({ projectId, cut: await VP.getVideoPrompt(projectId, String(a._id)), beat }); // leaves an undo copy
    const before = await VP.getVideoPrompt(projectId, String(a._id));
    expect(before.start_frame.previous_image_id).toBeTruthy();

    const r = await SF.clearBeatStartFrames({ projectId, beatId: String(beat._id) });
    expect(r.cleared).toBe(1); // b never had a frame
    const after = await VP.getVideoPrompt(projectId, String(a._id));
    expect(after.start_frame.image_id).toBeNull();
    expect(after.start_frame.previous_image_id).toBeNull();
    expect(after.start_frame.prompt).toBe('A.');
    expect(after.start_frame.reference_ids.map(String)).toEqual([String(sarahArt)]);
    expect(deleted).toEqual(expect.arrayContaining([String(before.start_frame.image_id), String(before.start_frame.previous_image_id)]));
    expect(await VP.getVideoPrompt(projectId, String(b._id))).toBeTruthy();
  });

  it('refuses while a job holds the beat', async () => {
    const { beat } = await seed();
    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((r) => { release = r; }));
    await expect(SF.clearBeatStartFrames({ projectId, beatId: String(beat._id) })).rejects.toMatchObject({ code: 'BEAT_BUSY' });
    release();
  });
});

describe('end frames of a camera that slides the picture', () => {
  const PAN = { size: 'wide', movement: 'pan', travel: 'right to left, from the marquee to the lot', travel_widths: 1 };
  // A real picture the canvas can be cut from; `split` paints a hard line at x.
  async function picture(split = null) {
    const sharp = (await import('sharp')).default;
    const base = sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 90, g: 80, b: 70 } } });
    if (split == null) return base.png().toBuffer();
    const side = await sharp({ create: { width: split, height: 100, channels: 3, background: { r: 230, g: 230, b: 240 } } }).png().toBuffer();
    return base.composite([{ input: side, left: 0, top: 0 }]).png().toBuffer();
  }
  async function panCut(beat, dinerArt) {
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'Pan', camera: PAN,
      startFrame: { prompt: 'The marquee at the right, the doors at the left.', reference_ids: [], references_planned: true },
      endFrame: { prompt: 'The lot fills the frame, the doors at the right edge.', reference_ids: [dinerArt], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat });
    return VP.getVideoPrompt(projectId, String(cut._id));
  }

  it('builds a wider master plate from the start frame and crops BOTH frames from it; the plate is reused while the start frame is its crop', async () => {
    const { beat, dinerArt } = await seed();
    const plain = await picture();
    SF._setStartFrameDispatcherForTests(async (args) => {
      dispatched.push(args);
      return { buffer: plain, contentType: 'image/png', model: args.model };
    });
    const cut = await panCut(beat, dinerArt);
    const firstStart = String(cut.start_frame.image_id);
    await SF.renderCutStartFrame({ projectId, cut, beat, frame: 'end' });
    // One edit: the start frame extended to 21:9 at 2K. No artwork.
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]).toMatchObject({ mode: 'edit', aspectRatio: '21:9', resolution: '2K' });
    expect(dispatched[1].inputImages).toHaveLength(1);
    expect(dispatched[1].prompt).toContain('Extend this photograph into a wider frame');
    expect(dispatched[1].prompt).toContain('The picture you are given is the RIGHT part');
    expect(dispatched[1].prompt).toContain('The lot fills the frame');
    const after = await VP.getVideoPrompt(projectId, String(cut._id));
    // The start frame is now the plate's crop; Undo holds the one it replaced.
    expect(String(after.start_frame.image_id)).not.toBe(firstStart);
    expect(String(after.start_frame.previous_image_id)).toBe(firstStart);
    expect(after.start_frame.prompt).toBe('The marquee at the right, the doors at the left.');
    expect(after.end_frame.master_image_id).toBeTruthy();
    expect(String(after.end_frame.continuity_image_id)).toBe(String(after.start_frame.image_id));
    expect(after.end_frame.prompt).toBe('The lot fills the frame, the doors at the right edge.');
    expect(after.end_frame.reference_ids.map(String)).toEqual([String(dinerArt)]);
    // The two frames are the two ends of the plate (200x100 → 178 wide crops).
    const sharp = (await import('sharp')).default;
    expect((await sharp(store.get(String(after.end_frame.image_id)).buffer).metadata()).width).toBe(178);
    // Again: the plate is reused, the start frame is left alone, nothing is asked of the model.
    await SF.renderCutStartFrame({ projectId, cut: after, beat, frame: 'end' });
    expect(dispatched).toHaveLength(2);
    const again = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(String(again.start_frame.image_id)).toBe(String(after.start_frame.image_id));
    expect(String(again.end_frame.master_image_id)).toBe(String(after.end_frame.master_image_id));
    // A new start frame makes the plate stale: a new one is built.
    await SF.renderCutStartFrame({ projectId, cut: again, beat, frame: 'start' });
    await SF.renderCutStartFrame({ projectId, cut: await VP.getVideoPrompt(projectId, String(cut._id)), beat, frame: 'end' });
    expect(dispatched).toHaveLength(4);
    expect(dispatched[3].aspectRatio).toBe('21:9');
  });

  it('people who travel with the camera are moved inside the plate before the end frame is cropped', async () => {
    const { beat, dinerArt } = await seed();
    const plain = await picture();
    SF._setStartFrameDispatcherForTests(async (args) => {
      dispatched.push(args);
      return { buffer: plain, contentType: 'image/png', model: args.model };
    });
    const made = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'Follow', camera: PAN, inFrame: [{ character: 'Sarah', position: 'crossing the lot', facing: 'the doors', acts: true }],
      startFrame: { prompt: 'She strides left.', reference_ids: [], references_planned: true },
      endFrame: { prompt: 'She is one step from the doors.', reference_ids: [dinerArt], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut: made, beat });
    await SF.renderCutStartFrame({ projectId, cut: await VP.getVideoPrompt(projectId, String(made._id)), beat, frame: 'end' });
    expect(dispatched).toHaveLength(3);
    expect(dispatched[2]).toMatchObject({ mode: 'edit', aspectRatio: '21:9' });
    expect(dispatched[2].inputImages).toHaveLength(1);
    expect(dispatched[2].prompt).toContain('master plate of a film shot');
    expect(dispatched[2].prompt).toContain('a QUARTER of the plate\'s width toward the left');
    expect(dispatched[2].prompt).toContain('She is one step from the doors.');
  });

  it('a model that cannot widen the picture slides the start frame instead: band fill, then a plain edit when it seams', async () => {
    const { beat, dinerArt } = await seed();
    const plain = await picture();
    const seamed = await picture(100);
    SF._setStartFrameDispatcherForTests(async (args) => {
      dispatched.push(args);
      return { buffer: dispatched.length === 2 ? seamed : plain, contentType: 'image/png', model: args.model };
    });
    const cut = await panCut(beat, dinerArt);
    await SF.renderCutStartFrame({ projectId, cut, beat, frame: 'end', imageModel: 'flux-2-pro' });
    expect(dispatched).toHaveLength(3);
    expect(dispatched[1].prompt).toContain('flat grey band along the left (about 50% of the image)');
    expect(dispatched[1].aspectRatio).toBeUndefined();
    expect(dispatched[2].prompt).toContain('turned on its spot — panned left, by about 50% of the frame\'s width');
    expect(dispatched[2].inputImages[0].buffer.equals(plain)).toBe(true);
    const after = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(after.end_frame.master_image_id).toBeNull();
    expect(String(after.start_frame.image_id)).toBe(String(cut.start_frame.image_id));
    await SF.renderCutStartFrame({ projectId, cut: after, beat, frame: 'end', imageModel: 'flux-2-pro', slideMethod: 'edit' });
    expect(dispatched).toHaveLength(4);
    expect(dispatched[3].prompt).toContain('turned on its spot — panned left');
  });

  it('a track forward keeps the reference path, and its continuity frame is told the move', async () => {
    const { beat, dinerArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'Track', camera: { size: 'medium', movement: 'track', travel: 'forward to the open door', travel_widths: 1 },
      startFrame: { prompt: 'Behind his shoulder at the canopy.', reference_ids: [], references_planned: true },
      endFrame: { prompt: 'At the threshold of the open door.', reference_ids: [dinerArt], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat });
    const fresh = await VP.getVideoPrompt(projectId, String(cut._id));
    await SF.renderCutStartFrame({ projectId, cut: fresh, beat, frame: 'end' });
    expect(dispatched[1].mode).toBe('generate');
    expect(dispatched[1].inputImages).toHaveLength(2);
    expect(dispatched[1].prompt).toContain('It is the SAME camera, which has only done this since that frame: track — forward to the open door.');
    expect(Object.keys(dispatched[1].inputImages[0]).sort()).toEqual(['buffer', 'contentType']);
  });
});

describe('end frames', () => {
  it('renders the end frame from end_frame refs plus the rendered start frame as a last continuity reference', async () => {
    const { beat, sarahArt, dinerArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c',
      startFrame: { prompt: 'The sky over the roofline.', reference_ids: [], references_planned: true },
      endFrame: { prompt: 'Wide on the diner front, the woman at the door.', reference_ids: [dinerArt, sarahArt], references_planned: true },
    });
    const s = await SF.renderCutStartFrame({ projectId, cut, beat });
    expect(dispatched[0].inputImages).toEqual([]);
    const fresh = await VP.getVideoPrompt(projectId, String(cut._id));
    const e = await SF.renderCutStartFrame({ projectId, cut: fresh, beat, frame: 'end' });
    const refs = dispatched[1].inputImages.map((i) => i.buffer.toString());
    expect(refs).toEqual(['Sarah, grey coat', 'Diner interior, night', 'render-1']);
    expect(dispatched[1].prompt).toContain('Image 3 is the opening frame of this same shot');
    expect(dispatched[1].prompt).toContain('Wide on the diner front');
    // The opening frame owns the clothing, the props and the layout; the
    // character artwork gives only the face.
    expect(dispatched[1].prompt).toContain('Image 1 is Sarah: take only the face, hair and build from it. The clothing is exactly what this person wears in Image 3');
    expect(dispatched[1].prompt).toContain('the same furniture in the same arrangement and count');
    expect(dispatched[1].prompt).toContain('Add nothing that is not in it and remove nothing from it');
    expect(dispatched[1].mode).toBe('generate');
    expect(uploads[1].filename).toMatch(/^cut-.*-end-frame-/);
    const after = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(String(after.end_frame.image_id)).toBe(e.image_id);
    expect(String(after.start_frame.image_id)).toBe(s.image_id);
    expect(after.end_frame.prompt).toBe('Wide on the diner front, the woman at the door.');
    // Which opening frame this end frame was built against (the stale check).
    expect(String(after.end_frame.continuity_image_id)).toBe(s.image_id);
  });

  it('always attaches the opening frame: one slot of the cap is reserved for it', async () => {
    const { beat, sarahArt, sarahAlt, dinerArt } = await seed();
    const extras = [img('extra 1'), img('extra 2'), img('extra 3')];
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c',
      startFrame: { prompt: 'Start.', reference_ids: [], references_planned: true },
      endFrame: { prompt: 'End.', reference_ids: [sarahArt, sarahAlt, dinerArt, ...extras], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat, imageModel: 'flux-2-klein' }); // cap 4
    const fresh = await VP.getVideoPrompt(projectId, String(cut._id));
    await SF.renderCutStartFrame({ projectId, cut: fresh, beat, frame: 'end', imageModel: 'flux-2-klein' });
    const sent = dispatched[1].inputImages.map((i) => i.buffer.toString());
    expect(sent).toHaveLength(4);
    expect(sent[3]).toBe('render-1');
    expect(dispatched[1].prompt).toContain('Image 4 is the opening frame of this same shot');
  });

  it('a held camera derives the end frame by editing the start frame: only that image, the change list, no artwork', async () => {
    const { beat, sarahArt, dinerArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c',
      startFrame: { prompt: 'Medium from the aisle: the boy in the red windbreaker holds the bucket.', reference_ids: [sarahArt, dinerArt], references_planned: true },
      endFrame: { prompt: 'Same frame. The bucket lies on its side on the carpet by his left shoe; his empty hand hangs open.', reference_ids: [sarahArt, dinerArt], references_planned: true, derive: true },
    });
    const s = await SF.renderCutStartFrame({ projectId, cut, beat });
    const fresh = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(fresh.end_frame.derive).toBe(true);
    await SF.renderCutStartFrame({ projectId, cut: fresh, beat, frame: 'end' });
    expect(dispatched[1].mode).toBe('edit');
    expect(dispatched[1].inputImages.map((i) => i.buffer.toString())).toEqual(['render-1']);
    expect(dispatched[1].prompt).toContain('This image is the opening frame of a film shot. Produce the closing frame of the same shot');
    expect(dispatched[1].prompt).toContain('Add nothing and remove nothing.');
    expect(dispatched[1].prompt).toMatch(/Change only this:\n\nThe bucket lies on its side/);
    expect(dispatched[1].prompt).not.toContain('Generate a new cinematic');
    const after = await VP.getVideoPrompt(projectId, String(cut._id));
    // The stored prompt stays the change list; the flag and the opening frame it was built on persist.
    expect(after.end_frame.prompt).toBe('Same frame. The bucket lies on its side on the carpet by his left shoe; his empty hand hangs open.');
    expect(after.end_frame.derive).toBe(true);
    expect(String(after.end_frame.continuity_image_id)).toBe(s.image_id);
    expect(after.end_frame.reference_ids.map(String)).toEqual([String(sarahArt), String(dinerArt)]);
  });

  it('a derived end frame with no start frame yet renders from the start prompt plus the change list', async () => {
    const { beat, dinerArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c',
      startFrame: { prompt: 'Medium from the aisle, the bucket in his hand.' },
      endFrame: { prompt: 'Same frame. The bucket lies on the carpet.', reference_ids: [dinerArt], references_planned: true, derive: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat, frame: 'end' });
    expect(dispatched[0].mode).toBe('generate');
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['Diner interior, night']);
    expect(dispatched[0].prompt).toContain('Medium from the aisle, the bucket in his hand.\n\nThe same frame a few seconds later, everything else unchanged: The bucket lies on the carpet.');
    const after = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(after.end_frame.continuity_image_id).toBeNull();
    expect(after.end_frame.prompt).toBe('Same frame. The bucket lies on the carpet.');
  });

  it('re-renders an existing end frame when its start frame was rendered in the same run', async () => {
    const { beat } = await seed();
    const cut = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'a', startFrame: { prompt: 'A start.', references_planned: true }, endFrame: { prompt: 'A end.', references_planned: true } });
    // Only the end frame exists (rendered before any start frame).
    await SF.renderCutStartFrame({ projectId, cut, beat, frame: 'end' });
    dispatched.length = 0;
    const job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), cutIds: [String(cut._id)], frames: ['start', 'end'] }));
    expect(job.rendered).toBe(2);
    expect(job.skipped).toBe(0);
    expect(dispatched[1].prompt).toContain('is the opening frame of this same shot');
  });

  it('omits the continuity reference when the cut has no start frame yet, and refuses a cut with no end prompt', async () => {
    const { beat, dinerArt } = await seed();
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c',
      startFrame: { prompt: 'Start.' },
      endFrame: { prompt: 'End.', reference_ids: [dinerArt], references_planned: true },
    });
    await SF.renderCutStartFrame({ projectId, cut, beat, frame: 'end' });
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['Diner interior, night']);
    const bare = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'd', startFrame: { prompt: 'S.' } });
    await expect(SF.renderCutStartFrame({ projectId, cut: bare, beat, frame: 'end' })).rejects.toThrow(/no end-frame prompt/);
  });

  it('a bulk job over both frames renders start before end per cut, counts frames, and skips an end frame with no prompt', async () => {
    const { beat } = await seed();
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'a', startFrame: { prompt: 'A start.', references_planned: true }, endFrame: { prompt: 'A end.', references_planned: true } });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'b', startFrame: { prompt: 'B start.', references_planned: true } });
    const jobId = await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), cutIds: [String(a._id), String(b._id)], frames: ['end', 'start'] });
    const job = await waitJob(jobId);
    expect(job.frames).toEqual(['start', 'end']);
    expect(job.planned).toBe(4);
    expect(job.rendered).toBe(3);
    expect(job.skipped).toBe(1);
    expect(job.status).toBe('done');
    expect(job.warnings.join(' ')).toMatch(/"b" has no end-frame prompt/);
    const aPrompts = dispatched.map((d) => d.prompt).filter((p) => p.includes('A '));
    expect(aPrompts[0]).toContain('A start.');
    expect(aPrompts[1]).toContain('A end.');
    // A second run with skip_rendered keeps every rendered frame.
    const again = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), cutIds: [String(a._id)], frames: ['start', 'end'] }));
    expect(again.skipped).toBe(2);
    expect(again.rendered).toBe(0);
  });

  it('clearBeatStartFrames clears one or both frames', async () => {
    const { beat } = await seed();
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'a', startFrame: { prompt: 'S.', references_planned: true }, endFrame: { prompt: 'E.', references_planned: true } });
    await SF.renderCutStartFrame({ projectId, cut: a, beat });
    await SF.renderCutStartFrame({ projectId, cut: await VP.getVideoPrompt(projectId, String(a._id)), beat, frame: 'end' });
    expect((await SF.clearBeatStartFrames({ projectId, beatId: String(beat._id), frames: ['end'] })).cleared).toBe(1);
    let row = await VP.getVideoPrompt(projectId, String(a._id));
    expect(row.start_frame.image_id).toBeTruthy();
    expect(row.end_frame.image_id).toBeNull();
    expect(row.end_frame.prompt).toBe('E.');
    expect((await SF.clearBeatStartFrames({ projectId, beatId: String(beat._id) })).cleared).toBe(1);
    row = await VP.getVideoPrompt(projectId, String(a._id));
    expect(row.start_frame.image_id).toBeNull();
  });

  it('normalizeFrames orders and de-duplicates', () => {
    expect(SF.normalizeFrames(['end', 'start', 'end'])).toEqual(['start', 'end']);
    expect(SF.normalizeFrames('end')).toEqual(['end']);
    expect(SF.normalizeFrames(['bogus'])).toEqual(['start']);
    expect(SF.normalizeFrames(null, SF.CUT_FRAMES)).toEqual(['start', 'end']);
  });
});
