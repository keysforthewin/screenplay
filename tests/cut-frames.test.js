// Rendering a cut's start / end frame (src/web/cutFrames.js): a frame goes to
// the image model with its own prompt and exactly the references listed on
// it, the rendered image becomes the frame's image (the replaced one the undo
// target), and jobs are per cut + frame — no beat lock.
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
const VS = await import('../src/mongo/videoScenes.js');
const Gateway = await import('../src/web/gateway.js');
const CF = await import('../src/web/cutFrames.js');

let projectId;
let dispatched;
// Renders wait here when a test sets it: `gate.release()` lets them finish.
let gate;
function holdRenders() {
  let release;
  const p = new Promise((r) => { release = r; });
  gate = { p, release };
  return gate;
}

beforeEach(async () => {
  fakeDb.reset();
  store.clear();
  uploads.length = 0;
  deleted.length = 0;
  dispatched = [];
  gate = null;
  CF._resetCutFrameJobsForTests();
  CF._setCutFrameDispatcherForTests(async (args) => {
    dispatched.push(args);
    const n = dispatched.length;
    if (gate) await gate.p;
    return { buffer: Buffer.from(`render-${n}`), contentType: 'image/png', model: args.model };
  });
  projectId = (await createProject('Frames'))._id.toString();
});

function img(desc) {
  const id = new ObjectId();
  store.set(id.toString(), { buffer: Buffer.from(desc), description: desc });
  return id;
}

const sent = (call) => call.inputImages.map((i) => i.buffer.toString());

async function seed() {
  const sarahArt = img('Sarah, grey coat');
  const sarahAlt = img('Sarah, bare arms, summer');
  const sarahPlate = img('Sarah, wardrobe plate');
  const dinerArt = img('Diner interior, night');
  const dinerAlt = img('Diner exterior, night');
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Sarah', name_lower: 'sarah', fields: {},
    wardrobe_image_id: sarahPlate,
    artworks: [
      { _id: new ObjectId(), status: 'done', result_image_id: sarahArt, name: 'Coat', description: 'Sarah, grey coat' },
      { _id: new ObjectId(), status: 'done', result_image_id: sarahAlt, name: 'Summer', description: 'Sarah, bare arms, summer' },
      { _id: new ObjectId(), status: 'done', result_image_id: sarahPlate, name: 'Plate', description: 'Sarah, wardrobe plate' },
    ],
    created_at: new Date(), updated_at: new Date(),
  });
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Diner', name_lower: 'diner', description: '',
    artworks: [
      { _id: new ObjectId(), status: 'done', result_image_id: dinerArt, name: 'Interior', description: 'Diner interior, night' },
      { _id: new ObjectId(), status: 'done', result_image_id: dinerAlt, name: 'Exterior', description: 'Diner exterior, night' },
    ],
    created_at: new Date(), updated_at: new Date(),
  });
  const beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'Sarah waits.', characters: ['Sarah'], sets: ['Diner'] });
  const scene = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One' });
  return { beat, scene, sarahArt, sarahAlt, sarahPlate, dinerArt, dinerAlt };
}

function makeCut(beat, scene, extra = {}) {
  return VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: scene._id, title: 'c', ...extra });
}

async function waitJob(id) {
  for (let i = 0; i < 500; i++) {
    const j = CF.getCutFrameJob(id);
    if (j && ['done', 'error'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never finished');
}

async function until(fn) {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never met');
}

const getCut = (cut) => VP.getVideoPrompt(projectId, String(cut._id));

describe('renderCutFrame: what the image model is sent', () => {
  it('sends exactly the listed references — same-kind references in the listed order — with a binding per image', async () => {
    const { beat, scene, sarahArt, sarahAlt, dinerArt, dinerAlt } = await seed();
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 'Wide, 24mm: a **woman** in a grey coat in the booth.', reference_ids: [sarahAlt, sarahArt] },
      endFrame: { prompt: 'The booth, empty.', reference_ids: [dinerAlt, dinerArt] },
    });
    await CF.renderCutFrame({ projectId, cut, frame: 'start' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].model).toBe(CF.DEFAULT_FRAME_MODEL);
    expect(dispatched[0].mode).toBe('generate');
    expect(dispatched[0]).not.toHaveProperty('comfyParams');
    // Only this frame's two references — nothing picked for it, none of the
    // end frame's, none of the beat's other artwork.
    expect(sent(dispatched[0])).toEqual(['Sarah, bare arms, summer', 'Sarah, grey coat']);
    expect(dispatched[0].inputImages.every((i) => i.contentType === 'image/png')).toBe(true);
    expect(Object.keys(dispatched[0].inputImages[0]).sort()).toEqual(['buffer', 'contentType']);
    expect(dispatched[0].prompt).toContain('This is not an edit of any input image');
    expect(dispatched[0].prompt).toContain('Image 1 is Sarah: take only the face, hair, build and wardrobe from it.');
    expect(dispatched[0].prompt).toContain('Image 2 is Sarah:');
    // The frame's own prompt, markdown stripped, closes the message.
    expect(dispatched[0].prompt.endsWith('The shot:\n\nWide, 24mm: a woman in a grey coat in the booth.')).toBe(true);

    await CF.renderCutFrame({ projectId, cut: await getCut(cut), frame: 'end' });
    expect(sent(dispatched[1])).toEqual(['Diner exterior, night', 'Diner interior, night']);
    expect(dispatched[1].prompt).toContain('Image 1 shows the set "Diner" from a different camera');
    expect(dispatched[1].prompt.endsWith('The shot:\n\nThe booth, empty.')).toBe(true);
  });

  it('binds each reference by what it is, numbered in the STORED order — never re-sorted', async () => {
    const { beat, scene, sarahArt, sarahPlate, dinerArt } = await seed();
    const stray = img('An uploaded photo');
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 'She sits.', reference_ids: [dinerArt, stray, sarahPlate, sarahArt] },
    });
    await CF.renderCutFrame({ projectId, cut });
    // All four, only those four, in the order listed: the frame prompt refers
    // to them as "Image N", so the Nth stored id must be image N.
    expect(sent(dispatched[0])).toEqual(['Diner interior, night', 'An uploaded photo', 'Sarah, wardrobe plate', 'Sarah, grey coat']);
    const p = dispatched[0].prompt;
    expect(p).toContain('numbered in the order they are attached');
    expect(p).toContain('Image 1 shows the set "Diner" from a different camera');
    // An image that is nobody's artwork is still sent, as a look reference.
    expect(p).toContain('Image 2 shows this subject from a different camera');
    expect(p).toContain("Image 3 is Sarah's wardrobe plate");
    expect(p).toContain('Image 4 is Sarah: take only the face');
  });

  it('an empty reference list renders from the prompt alone: no input images, no binding preamble', async () => {
    const { beat, scene } = await seed();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'An empty road at dawn.', reference_ids: [] } });
    await CF.renderCutFrame({ projectId, cut });
    expect(dispatched[0].inputImages).toEqual([]);
    expect(dispatched[0].prompt).toBe('An empty road at dawn.');
    expect((await getCut(cut)).start_frame.reference_ids).toEqual([]);
  });

  it('a listed image that no longer exists is left out; the rest are still sent', async () => {
    const { beat, scene, sarahArt } = await seed();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'She sits.', reference_ids: [new ObjectId(), sarahArt] } });
    await CF.renderCutFrame({ projectId, cut });
    expect(sent(dispatched[0])).toEqual(['Sarah, grey coat']);
    // The list on the cut is the user's and is not rewritten.
    expect((await getCut(cut)).start_frame.reference_ids).toHaveLength(2);
  });

  it('uses the model asked for, and caps the list at what that model accepts', async () => {
    const { beat, scene, sarahArt, sarahAlt, dinerArt } = await seed();
    const { maxReferenceImagesFor } = await import('../src/web/imageModelInfo.js');
    const model = 'flux-pro-kontext';
    const cap = maxReferenceImagesFor(model);
    const listed = [sarahArt, sarahAlt, dinerArt, img('a'), img('b'), img('c'), img('d'), img('e'), img('f')];
    expect(cap).toBeLessThan(listed.length);
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'She sits.', reference_ids: listed } });
    const updated = await CF.renderCutFrame({ projectId, cut, imageModel: model });
    expect(dispatched[0].model).toBe(model);
    expect(dispatched[0].inputImages).toHaveLength(cap);
    expect(updated.start_frame.model).toBe(model);
    // Nothing is dropped from the stored list.
    expect(updated.start_frame.reference_ids.map(String)).toEqual(listed.map(String));
  });

  it('the project\'s reference-image model default is used when none is asked for', async () => {
    const { beat, scene } = await seed();
    const { setModelDefaults } = await import('../src/mongo/projectSettings.js');
    await setModelDefaults(projectId, { image_with_refs: 'nano-banana-2' });
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'She sits.' } });
    await CF.renderCutFrame({ projectId, cut });
    expect(dispatched[0].model).toBe('nano-banana-2');
  });

  it('a frame with no prompt is refused before anything is sent', async () => {
    const { beat, scene, sarahArt } = await seed();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: '  ', reference_ids: [sarahArt] } });
    await expect(CF.renderCutFrame({ projectId, cut })).rejects.toMatchObject({ code: 'BAD_FRAME_INPUT', status: 400 });
    await expect(CF.renderCutFrame({ projectId, cut, frame: 'end' })).rejects.toThrow(/end frame has no prompt/);
    expect(dispatched).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });
});

describe('renderCutFrame: what is stored', () => {
  it('the render becomes image_id under the beat; the prompt and reference_ids survive', async () => {
    const { beat, scene, sarahArt, dinerArt } = await seed();
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 'Wide: the booth.', reference_ids: [dinerArt, sarahArt] },
    });
    const updated = await CF.renderCutFrame({ projectId, cut });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].ownerType).toBe('beat');
    expect(String(uploads[0].ownerId)).toBe(String(beat._id));
    expect(uploads[0].buffer.toString()).toBe('render-1');
    expect(uploads[0].prompt).toBe('Wide: the booth.');
    expect(uploads[0].generatedBy).toBe(CF.DEFAULT_FRAME_MODEL);
    expect(uploads[0].filename).toMatch(new RegExp(`^cut-${cut._id}-start-frame-`));
    const saved = await getCut(cut);
    expect(String(updated.start_frame.image_id)).toBe(String(uploads[0].id));
    expect(String(saved.start_frame.image_id)).toBe(String(uploads[0].id));
    expect(saved.start_frame.prompt).toBe('Wide: the booth.');
    // Stored in the order the user listed them, whatever order the model got.
    expect(saved.start_frame.reference_ids.map(String)).toEqual([String(dinerArt), String(sarahArt)]);
    expect(saved.start_frame.model).toBe(CF.DEFAULT_FRAME_MODEL);
    expect(saved.start_frame.generated_at).toBeInstanceOf(Date);
    expect(saved.start_frame.previous_image_id).toBeNull();
    expect(saved.end_frame).toBeNull();
  });

  it('a second render makes the first the undo target; a third deletes the oldest', async () => {
    const { beat, scene, sarahArt } = await seed();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'p', reference_ids: [sarahArt] } });
    await CF.renderCutFrame({ projectId, cut });
    const second = await CF.renderCutFrame({ projectId, cut: await getCut(cut) });
    expect(String(second.start_frame.image_id)).toBe(String(uploads[1].id));
    expect(String(second.start_frame.previous_image_id)).toBe(String(uploads[0].id));
    expect(deleted).toEqual([]);
    const third = await CF.renderCutFrame({ projectId, cut: await getCut(cut) });
    expect(String(third.start_frame.image_id)).toBe(String(uploads[2].id));
    expect(String(third.start_frame.previous_image_id)).toBe(String(uploads[1].id));
    expect(deleted).toEqual([String(uploads[0].id)]);
    expect(third.start_frame.prompt).toBe('p');
    expect(third.start_frame.reference_ids.map(String)).toEqual([String(sarahArt)]);
    // Undo brings the second render back.
    const undone = await Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: String(cut._id) });
    expect(String(undone.start_frame.image_id)).toBe(String(uploads[1].id));
    expect(undone.start_frame.previous_image_id).toBeNull();
  });

  it('a prompt or reference list edited while the render runs is not put back', async () => {
    const { beat, scene, sarahArt, dinerArt } = await seed();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'old prompt', reference_ids: [sarahArt] } });
    const g = holdRenders();
    const running = CF.renderCutFrame({ projectId, cut });
    await until(() => dispatched.length === 1);
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: String(cut._id), field: 'start_frame_prompt', text: 'new prompt' });
    await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: String(cut._id),
      startFrame: { ...(await getCut(cut)).start_frame, prompt: undefined, reference_ids: [dinerArt] },
    });
    g.release();
    await running;
    const saved = await getCut(cut);
    expect(dispatched[0].prompt).toContain('old prompt');
    expect(saved.start_frame.prompt).toBe('new prompt');
    expect(saved.start_frame.reference_ids.map(String)).toEqual([String(dinerArt)]);
    expect(String(saved.start_frame.image_id)).toBe(String(uploads[0].id));
  });
});

describe('the end frame and the cut\'s start frame', () => {
  it('the cut\'s start image among the end frame\'s references is bound as the opening frame (continuity), at its listed position', async () => {
    const { beat, scene, sarahArt, dinerArt } = await seed();
    const startImage = img('the rendered start frame');
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 'She sits.', image_id: startImage },
      endFrame: { prompt: 'She has stood up.', reference_ids: [sarahArt, dinerArt, startImage] },
    });
    await CF.renderCutFrame({ projectId, cut, frame: 'end' });
    expect(sent(dispatched[0])).toEqual(['Sarah, grey coat', 'Diner interior, night', 'the rendered start frame']);
    const p = dispatched[0].prompt;
    expect(p).toContain('Image 3 is the opening frame of this same shot, a few seconds earlier.');
    // With the opening frame along, it — not the character art — owns the clothing.
    expect(p).toContain('Image 1 is Sarah: take only the face, hair and build from it. The clothing is exactly what this person wears in Image 3');
    expect(p.endsWith('The shot:\n\nShe has stood up.')).toBe(true);
    expect(uploads[0].filename).toMatch(new RegExp(`^cut-${cut._id}-end-frame-`));
    const saved = await getCut(cut);
    expect(String(saved.end_frame.image_id)).toBe(String(uploads[0].id));
    expect(saved.end_frame.reference_ids.map(String)).toEqual([sarahArt, dinerArt, startImage].map(String));
    // The start frame is untouched by an end-frame render.
    expect(String(saved.start_frame.image_id)).toBe(String(startImage));
    expect(saved.start_frame.previous_image_id).toBeNull();
  });

  it('the same image on the START frame\'s list is an ordinary look reference, and the start frame is never added for you', async () => {
    const { beat, scene, sarahArt } = await seed();
    const startImage = img('the rendered start frame');
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 'She sits.', image_id: startImage, reference_ids: [startImage] },
      endFrame: { prompt: 'She has stood up.', reference_ids: [sarahArt] },
    });
    await CF.renderCutFrame({ projectId, cut, frame: 'start' });
    expect(dispatched[0].prompt).not.toContain('opening frame of this same shot');
    await CF.renderCutFrame({ projectId, cut: await getCut(cut), frame: 'end' });
    expect(sent(dispatched[1])).toEqual(['Sarah, grey coat']);
    expect(dispatched[1].prompt).not.toContain('opening frame of this same shot');
  });

  it('re-rendering the start frame repoints the end frame\'s reference at the new image', async () => {
    const { beat, scene, dinerArt } = await seed();
    const oldStart = img('old start frame');
    const endImage = img('end frame');
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 'She sits.', image_id: oldStart },
      endFrame: { prompt: 'She has stood up.', image_id: endImage, reference_ids: [dinerArt, oldStart] },
    });
    await CF.renderCutFrame({ projectId, cut, frame: 'start' });
    const newStart = String(uploads[0].id);
    const saved = await getCut(cut);
    expect(String(saved.start_frame.image_id)).toBe(newStart);
    expect(String(saved.start_frame.previous_image_id)).toBe(String(oldStart));
    expect(saved.end_frame.reference_ids.map(String)).toEqual([String(dinerArt), newStart]);
    // The end frame's own picture, prompt and undo slot are as they were.
    expect(saved.end_frame).toMatchObject({ prompt: 'She has stood up.', image_id: endImage, previous_image_id: null });
    expect(deleted).toEqual([]);
    // …so the next end-frame render is bound to the new start frame.
    await CF.renderCutFrame({ projectId, cut: saved, frame: 'end' });
    expect(sent(dispatched[1])).toEqual(['Diner interior, night', 'render-1']);
    expect(dispatched[1].prompt).toContain('Image 2 is the opening frame of this same shot');
  });

  it('renderCutFrame returns the cut with the end frame already repointed', async () => {
    const { beat, scene, dinerArt } = await seed();
    const oldStart = img('old start frame');
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 'She sits.', image_id: oldStart },
      endFrame: { prompt: 'She has stood up.', reference_ids: [dinerArt, oldStart] },
    });
    const updated = await CF.renderCutFrame({ projectId, cut, frame: 'start' });
    expect(updated.end_frame.reference_ids.map(String)).toEqual([String(dinerArt), String(uploads[0].id)]);
  });

  it('repointStartFrameReference leaves an end frame alone when it does not list the old start image', async () => {
    const { beat, scene, dinerArt } = await seed();
    const oldStart = img('old');
    const newStart = img('new');
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 's', image_id: newStart },
      endFrame: { prompt: 'e', reference_ids: [dinerArt] },
    });
    const same = await CF.repointStartFrameReference({ projectId, cut, from: oldStart });
    expect(same.end_frame.reference_ids.map(String)).toEqual([String(dinerArt)]);
    expect(await CF.repointStartFrameReference({ projectId, cut, from: null })).toBe(cut);
    expect(await CF.repointStartFrameReference({ projectId, cut, from: newStart })).toBe(cut);
    // After an undo: the list follows the restored image.
    await Gateway.setVideoPromptStartFrameViaGateway({
      projectId, promptId: String(cut._id), frame: 'end', startFrame: { prompt: 'e', reference_ids: [oldStart, dinerArt] },
    });
    const moved = await CF.repointStartFrameReference({ projectId, cut: await getCut(cut), from: oldStart });
    expect(moved.end_frame.reference_ids.map(String)).toEqual([String(newStart), String(dinerArt)]);
    expect(moved.end_frame.prompt).toBe('e');
  });
});

describe('clearCutFrame', () => {
  it('deletes the image and the undo image, keeps the prompt and the references', async () => {
    const { beat, scene, sarahArt, dinerArt } = await seed();
    const cut = await makeCut(beat, scene, {
      startFrame: { prompt: 'Wide: the booth.', reference_ids: [dinerArt, sarahArt] },
      endFrame: { prompt: 'Empty booth.', image_id: img('end') },
    });
    await CF.renderCutFrame({ projectId, cut });
    await CF.renderCutFrame({ projectId, cut: await getCut(cut) });
    const cleared = await CF.clearCutFrame({ projectId, cut: await getCut(cut), frame: 'start' });
    expect(deleted.sort()).toEqual([String(uploads[0].id), String(uploads[1].id)].sort());
    expect(cleared.start_frame).toMatchObject({
      prompt: 'Wide: the booth.',
      image_id: null,
      previous_image_id: null,
      model: null,
      generated_at: null,
    });
    expect(cleared.start_frame.reference_ids.map(String)).toEqual([String(dinerArt), String(sarahArt)]);
    // Reference artwork is never deleted, and the other frame is untouched.
    expect(deleted).not.toContain(String(dinerArt));
    expect(cleared.end_frame.image_id).not.toBeNull();
    const saved = await getCut(cut);
    expect(saved.start_frame.prompt).toBe('Wide: the booth.');
    expect(saved.start_frame.image_id).toBeNull();
  });

  it('a frame that never existed stays null', async () => {
    const { beat, scene } = await seed();
    const cut = await makeCut(beat, scene);
    const cleared = await CF.clearCutFrame({ projectId, cut, frame: 'end' });
    expect(cleared.end_frame).toBeNull();
    expect(deleted).toEqual([]);
  });
});

describe('startCutFrameJob', () => {
  it('returns a job id at once, renders in the background and ends done', async () => {
    const { beat, scene, sarahArt } = await seed();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'She sits.', reference_ids: [sarahArt] } });
    const g = holdRenders();
    const jobId = await CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: 'start', imageModel: 'nano-banana-2' });
    expect(jobId).toMatch(/^[a-f0-9]{24}$/);
    const running = CF.serializeCutFrameJob(CF.getCutFrameJob(jobId));
    expect(running).toMatchObject({
      job_id: jobId,
      beat_id: String(beat._id),
      cut_id: String(cut._id),
      frame: 'start',
      status: 'running',
      error: null,
      finished_at: null,
    });
    expect(running.started_at).toBeInstanceOf(Date);
    expect(CF.listCutFrameJobsForBeat(String(beat._id)).map((j) => j.job_id)).toEqual([jobId]);
    expect(CF.listCutFrameJobsForBeat(String(new ObjectId()))).toEqual([]);
    g.release();
    const done = await waitJob(jobId);
    expect(done.status).toBe('done');
    expect(done.finished_at).toBeInstanceOf(Date);
    expect(dispatched[0].model).toBe('nano-banana-2');
    expect(sent(dispatched[0])).toEqual(['Sarah, grey coat']);
    expect(String((await getCut(cut)).start_frame.image_id)).toBe(String(uploads[0].id));
    // A finished job is no longer listed for a page that opens later.
    expect(CF.listCutFrameJobsForBeat(String(beat._id))).toEqual([]);
    expect(CF.getCutFrameJob('nope')).toBeNull();
    expect(CF.serializeCutFrameJob(null)).toBeNull();
  });

  it('refuses an unknown cut (CUT_NOT_FOUND) and a frame with no prompt (BAD_FRAME_INPUT)', async () => {
    const { beat, scene } = await seed();
    await expect(
      CF.startCutFrameJob({ projectId, cutId: new ObjectId().toString(), frame: 'start' }),
    ).rejects.toMatchObject({ code: 'CUT_NOT_FOUND', status: 404 });
    const other = (await createProject('Other'))._id.toString();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'She sits.' }, endFrame: { prompt: '**  **', reference_ids: [] } });
    await expect(CF.startCutFrameJob({ projectId: other, cutId: String(cut._id) })).rejects.toMatchObject({ code: 'CUT_NOT_FOUND' });
    await expect(CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: 'end' })).rejects.toMatchObject({
      code: 'BAD_FRAME_INPUT',
      status: 400,
      message: expect.stringContaining('end frame has no prompt'),
    });
    const bare = await makeCut(beat, scene);
    await expect(CF.startCutFrameJob({ projectId, cutId: String(bare._id) })).rejects.toMatchObject({ code: 'BAD_FRAME_INPUT' });
    expect(dispatched).toHaveLength(0);
    expect(CF.listCutFrameJobsForBeat(String(beat._id))).toEqual([]);
  });

  it('a second start for the same cut + frame is CUT_BUSY while the first runs — and free again afterwards', async () => {
    const { beat, scene } = await seed();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'She sits.' } });
    const g = holdRenders();
    const first = await CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: 'start' });
    const err = await CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: 'start' }).catch((e) => e);
    expect(err).toBeInstanceOf(CF.CutFrameBusyError);
    expect(err).toMatchObject({ code: 'CUT_BUSY', status: 409, job_id: first });
    g.release();
    await waitJob(first);
    expect(dispatched).toHaveLength(1);
    gate = null;
    const again = await CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: 'start' });
    expect(again).not.toBe(first);
    expect((await waitJob(again)).status).toBe('done');
    const saved = await getCut(cut);
    expect(String(saved.start_frame.previous_image_id)).toBe(String(uploads[0].id));
  });

  it('the start and end frames of one cut — and another cut of the same beat — render at the same time', async () => {
    const { beat, scene } = await seed();
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'First.' }, endFrame: { prompt: 'Last.' } });
    const other = await makeCut(beat, scene, { startFrame: { prompt: 'Other.' } });
    const g = holdRenders();
    const startJob = await CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: 'start' });
    const endJob = await CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: 'end' });
    const otherJob = await CF.startCutFrameJob({ projectId, cutId: String(other._id), frame: 'start' });
    // All three are inside the image model before any has finished.
    await until(() => dispatched.length === 3);
    expect(dispatched.map((d) => d.prompt).sort()).toEqual(['First.', 'Last.', 'Other.']);
    expect([startJob, endJob, otherJob].map((id) => CF.getCutFrameJob(id).status)).toEqual(['running', 'running', 'running']);
    expect(CF.listCutFrameJobsForBeat(String(beat._id)).map((j) => [j.cut_id, j.frame]).sort()).toEqual(
      [
        [String(cut._id), 'start'],
        [String(cut._id), 'end'],
        [String(other._id), 'start'],
      ].sort(),
    );
    g.release();
    expect((await waitJob(startJob)).status).toBe('done');
    expect((await waitJob(endJob)).status).toBe('done');
    expect((await waitJob(otherJob)).status).toBe('done');
    const saved = await getCut(cut);
    expect(saved.start_frame.image_id).not.toBeNull();
    expect(saved.end_frame.image_id).not.toBeNull();
    expect(String(saved.start_frame.image_id)).not.toBe(String(saved.end_frame.image_id));
    expect(saved.start_frame.prompt).toBe('First.');
    expect(saved.end_frame.prompt).toBe('Last.');
    expect((await getCut(other)).start_frame.image_id).not.toBeNull();
  });

  it('a failed render ends the job in error, leaves the frame as it was, and is listed for the beat', async () => {
    const { beat, scene } = await seed();
    const before = img('before');
    const cut = await makeCut(beat, scene, { startFrame: { prompt: 'She sits.', image_id: before } });
    CF._setCutFrameDispatcherForTests(async () => {
      throw new Error('model unavailable');
    });
    const jobId = await CF.startCutFrameJob({ projectId, cutId: String(cut._id) });
    const job = await waitJob(jobId);
    expect(job).toMatchObject({ status: 'error', error: 'model unavailable' });
    const saved = await getCut(cut);
    expect(String(saved.start_frame.image_id)).toBe(String(before));
    expect(saved.start_frame.previous_image_id).toBeNull();
    expect(uploads).toHaveLength(0);
    expect(CF.listCutFrameJobsForBeat(String(beat._id))).toEqual([
      expect.objectContaining({ job_id: jobId, status: 'error', error: 'model unavailable' }),
    ]);
    // The failed job does not block a retry.
    CF._setCutFrameDispatcherForTests(async (args) => ({ buffer: Buffer.from('ok'), contentType: 'image/png', model: args.model }));
    expect((await waitJob(await CF.startCutFrameJob({ projectId, cutId: String(cut._id) }))).status).toBe('done');
  });
});

describe('keyframes (frame key "kf:<id>")', () => {
  it('renders a keyframe with its own references, binds the start frame as the opening frame, and stores it on the entry', async () => {
    const { beat, scene, sarahArt } = await seed();
    const startImage = img('start render');
    let cut = await makeCut(beat, scene, {
      durationSeconds: 8,
      startFrame: { prompt: 'Opening.', image_id: startImage },
      keyframes: [{ at_seconds: 3, prompt: 'Image 2 exactly — higher.', reference_ids: [sarahArt, startImage] }],
    });
    const kid = cut.keyframes[0].id.toString();
    const key = `kf:${kid}`;
    cut = await CF.renderCutFrame({ projectId, cut, frame: key });
    expect(dispatched).toHaveLength(1);
    expect(sent(dispatched[0])).toEqual(['Sarah, grey coat', 'start render']);
    expect(dispatched[0].prompt).toMatch(/Image 2 is the opening frame of this same shot/);
    expect(cut.keyframes[0].image_id).toBeTruthy();
    expect(cut.keyframes[0].model).toBe(CF.DEFAULT_FRAME_MODEL);
    expect(cut.keyframes[0]).toMatchObject({ at_seconds: 3, prompt: 'Image 2 exactly — higher.' });
    expect(uploads[0].filename).toMatch(new RegExp(`cut-${cut._id}-kf-${kid}-frame-`));
    // The start frame is untouched.
    expect(String(cut.start_frame.image_id)).toBe(String(startImage));
    // Unknown keys never fall back to the start frame.
    await expect(CF.renderCutFrame({ projectId, cut, frame: 'middle' })).rejects.toThrow(/unknown frame key/);
    await expect(CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: `kf:${new ObjectId()}` })).rejects.toMatchObject({ code: 'BAD_FRAME_INPUT' });
  });

  it('a re-rendered start frame repoints every keyframe that referenced it; a keyframe deleted mid-render is not resurrected', async () => {
    const { beat, scene } = await seed();
    const old = img('old start');
    let cut = await makeCut(beat, scene, {
      durationSeconds: 8,
      startFrame: { prompt: 'Opening.', image_id: old },
      endFrame: { prompt: 'Closing.', reference_ids: [old] },
      keyframes: [
        { at_seconds: 2, prompt: 'k1', reference_ids: [old] },
        { at_seconds: 5, prompt: 'k2', reference_ids: [] },
      ],
    });
    cut = await CF.renderCutFrame({ projectId, cut, frame: 'start' });
    const fresh = String(cut.start_frame.image_id);
    expect(fresh).not.toBe(String(old));
    expect(cut.end_frame.reference_ids.map(String)).toEqual([fresh]);
    expect(cut.keyframes[0].reference_ids.map(String)).toEqual([fresh]);
    expect(cut.keyframes[1].reference_ids).toEqual([]);

    // Delete the keyframe while its render is held → the picture is dropped.
    const kid = cut.keyframes[1].id.toString();
    const g = holdRenders();
    const jobId = await CF.startCutFrameJob({ projectId, cutId: String(cut._id), frame: `kf:${kid}` });
    await until(() => dispatched.length === 2);
    await Gateway.removeVideoPromptKeyframeViaGateway({ projectId, promptId: String(cut._id), keyframeId: kid });
    g.release();
    const job = await waitJob(jobId);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/removed while it rendered/);
    const after = await getCut(cut);
    expect(after.keyframes.map((k) => k.id.toString())).toEqual([cut.keyframes[0].id.toString()]);
    // The uploaded render was deleted again.
    const rendered = uploads.at(-1).id.toString();
    expect(deleted).toContain(rendered);
  });
});
