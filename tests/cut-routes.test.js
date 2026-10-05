// REST surface of the Scenes tab (src/web/cutRoutes.js): a beat's scenes and
// their cuts — list, add, delete, reorder, a cut's length — and each cut's
// start / end frame: render (through the image-dispatcher seam), the
// reference list, undo, remove, and the job routes a reopened page reads.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => { req.session = { username: 'tester' }; next(); },
}));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const broadcasts = [];
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn((room, payload) => { broadcasts.push({ room, payload }); }),
  isHocuspocusRunning: () => false,
}));

const store = new Map();
const deleted = [];
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readImageBuffer: vi.fn(async (id) => {
      const e = store.get(String(id));
      if (!e) return null;
      return { buffer: e.buffer, file: { _id: new ObjectId(String(id)), contentType: 'image/png', metadata: {} } };
    }),
    findImageFile: vi.fn(async (id) => {
      const e = store.get(String(id));
      if (!e) return null;
      return { _id: new ObjectId(String(id)), filename: 'x.png', contentType: 'image/png', length: e.buffer.length, metadata: { description: e.description || '' } };
    }),
    uploadGeneratedImage: vi.fn(async (_pid, args) => {
      const id = new ObjectId();
      store.set(id.toString(), { buffer: args.buffer, description: '' });
      return { _id: id, filename: args.filename };
    }),
    deleteImages: vi.fn(async (ids) => { for (const id of ids) deleted.push(String(id)); }),
    deleteImage: vi.fn(async (id) => { deleted.push(String(id)); }),
  };
});
const deletedAttachments = [];
vi.mock('../src/mongo/attachments.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    deleteAttachment: vi.fn(async (id) => { deletedAttachments.push(String(id)); }),
    deleteAttachments: vi.fn(async (ids) => { for (const id of ids) deletedAttachments.push(String(id)); }),
  };
});

const realFetch = global.fetch;
const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const CF = await import('../src/web/cutFrames.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl, projectId, dispatched, gate;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  global.fetch = realFetch;
});
beforeEach(async () => {
  fakeDb.reset();
  store.clear();
  deleted.length = 0;
  deletedAttachments.length = 0;
  broadcasts.length = 0;
  dispatched = [];
  gate = null;
  CF._resetCutFrameJobsForTests();
  CF._setCutFrameDispatcherForTests(async (args) => {
    dispatched.push(args);
    const n = dispatched.length;
    if (gate) await gate.p;
    return { buffer: Buffer.from(`render-${n}`), contentType: 'image/png', model: args.model };
  });
  projectId = (await createProject('Cut Routes'))._id.toString();
});

// Renders wait until `release()` is called.
function holdRenders() {
  let release;
  const p = new Promise((r) => { release = r; });
  gate = { p, release };
  return gate;
}

async function call(method, path, body, pid = projectId) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: { 'X-Project-Id': pid, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null; // express's own 404 page for a route that no longer exists
  }
  return { status: res.status, json };
}

function img(desc) {
  const id = new ObjectId();
  store.set(id.toString(), { buffer: Buffer.from(desc), description: desc });
  return id;
}

async function seedBeat() {
  const sarahArt = img('Sarah, grey coat');
  const dinerArt = img('Diner interior');
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Sarah', name_lower: 'sarah', fields: {},
    artworks: [{ _id: new ObjectId(), status: 'done', result_image_id: sarahArt, name: 'Coat', description: 'Sarah, grey coat' }],
    created_at: new Date(), updated_at: new Date(),
  });
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Diner', name_lower: 'diner', description: '',
    artworks: [{ _id: new ObjectId(), status: 'done', result_image_id: dinerArt, name: 'Interior', description: 'Diner interior' }],
    created_at: new Date(), updated_at: new Date(),
  });
  const beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'INT. DINER — NIGHT\n\nSarah waits.', characters: ['Sarah'], sets: ['Diner'] });
  return { beat, sarahArt, dinerArt };
}

async function seedScenes(beat) {
  const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One' });
  const s2 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Two' });
  const c1 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, title: 'c1', prompt: 'Wide shot.' });
  const c2 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, title: 'c2' });
  const c3 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s2._id, title: 'c3' });
  return { s1, s2, c1, c2, c3 };
}

const list = async (beat) => (await call('GET', `/api/video-scenes?beat_id=${beat._id}`)).json;
// "1.1 c1" style labels for the whole beat: scene number . cut number + title.
const labels = (listed) => listed.scenes.flatMap((s) => s.cuts.map((c) => `${s.order}.${c.cut_index} ${c.title}`.trim()));

async function waitFrame(id) {
  for (let i = 0; i < 500; i++) {
    const { json } = await call('GET', `/api/cuts/frames/job/${id}`);
    if (json && ['done', 'error'].includes(json.status)) return json;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('frame job never finished');
}

async function until(fn) {
  for (let i = 0; i < 500; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never met');
}

describe('scenes', () => {
  it('GET /video-scenes groups cuts under their scenes and validates', async () => {
    const { beat } = await seedBeat();
    const { s1, c1, c2, c3 } = await seedScenes(beat);
    expect((await call('GET', '/api/video-scenes')).status).toBe(400);
    expect((await call('GET', `/api/video-scenes?beat_id=${new ObjectId()}`)).status).toBe(404);
    const { status, json } = await call('GET', `/api/video-scenes?beat_id=${beat._id}`);
    expect(status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(['beat', 'scenes']);
    expect(json.beat).toEqual({ _id: String(beat._id), order: beat.order, name: 'Diner' });
    expect(json.scenes.map((s) => [s.order, s.title])).toEqual([[1, 'One'], [2, 'Two']]);
    expect(json.scenes[0]._id).toBe(String(s1._id));
    expect(json.scenes[0].cuts.map((c) => c._id)).toEqual([String(c1._id), String(c2._id)]);
    expect(json.scenes[1].cuts.map((c) => c._id)).toEqual([String(c3._id)]);
    expect(labels(json)).toEqual(['1.1 c1', '1.2 c2', '2.1 c3']);
    expect(json.scenes[0].cuts[0]).toMatchObject({ prompt: 'Wide shot.', duration_seconds: null, start_frame: null, end_frame: null, video_file_id: null });
    // The beat can also be addressed by its order, as the page URL does.
    expect((await call('GET', `/api/video-scenes?beat_id=${beat.order}`)).json.scenes).toHaveLength(2);
    // Another project cannot see it.
    const other = (await createProject('Other'))._id.toString();
    expect((await call('GET', `/api/video-scenes?beat_id=${beat._id}`, undefined, other)).status).toBe(404);
  });

  it('POST /video-scene appends a scene with its title; an empty beat starts at scene 1', async () => {
    const { beat } = await seedBeat();
    expect((await list(beat)).scenes).toEqual([]);
    expect((await call('POST', '/api/video-scene', {})).status).toBe(404);
    expect((await call('POST', '/api/video-scene', { beat_id: String(new ObjectId()), title: 'x' })).status).toBe(404);
    const other = (await createProject('Other'))._id.toString();
    expect((await call('POST', '/api/video-scene', { beat_id: String(beat._id) }, other)).status).toBe(404);

    let r = await call('POST', '/api/video-scene', { beat_id: String(beat._id), title: 'The **diner**' });
    expect(r.status).toBe(201);
    expect(r.json.scene).toMatchObject({ title: 'The **diner**', order: 1, beat_id: String(beat._id), project_id: projectId });
    expect(Object.keys(r.json.scene).sort()).toEqual(['_id', 'beat_id', 'created_at', 'order', 'project_id', 'title', 'updated_at']);
    // The name is on the row, so the room's first load seeds the fragment with it.
    expect((await VS.getVideoScene(projectId, r.json.scene._id)).title).toBe('The **diner**');
    const { resolveRoom } = await import('../src/web/roomRegistry.js');
    const room = await resolveRoom(`video_prompts:${beat._id}`);
    expect(room.seed).toEqual({ [`scene:${r.json.scene._id}:title`]: 'The **diner**' });
    expect(broadcasts.at(-1)).toEqual({
      room: `video_prompts:${beat._id}`,
      payload: expect.objectContaining({ changed: ['video_scenes'], added_video_scene_id: r.json.scene._id }),
    });

    // No title → an unnamed scene; a non-string title is ignored; a long one is cut.
    r = await call('POST', '/api/video-scene', { beat_id: String(beat._id) });
    expect(r.status).toBe(201);
    expect(r.json.scene).toMatchObject({ title: '', order: 2 });
    r = await call('POST', '/api/video-scene', { beat_id: String(beat._id), title: 42 });
    expect(r.json.scene).toMatchObject({ title: '', order: 3 });
    r = await call('POST', '/api/video-scene', { beat_id: beat.order, title: 'x'.repeat(600) });
    expect(r.json.scene.title).toHaveLength(500);
    expect((await list(beat)).scenes.map((s) => s.order)).toEqual([1, 2, 3, 4]);
  });

  it('POST /video-scenes/reorder renumbers scenes, and the cuts follow', async () => {
    const { beat } = await seedBeat();
    const { s1, s2 } = await seedScenes(beat);
    const r = await call('POST', '/api/video-scenes/reorder', { beat_id: String(beat._id), ordered_ids: [String(s2._id), String(s1._id)] });
    expect(r.status).toBe(200);
    expect(r.json.scenes.map((s) => [s.title, s.order])).toEqual([['Two', 1], ['One', 2]]);
    const listed = await list(beat);
    expect(listed.scenes.map((s) => s._id)).toEqual([String(s2._id), String(s1._id)]);
    expect(labels(listed)).toEqual(['1.1 c3', '2.1 c1', '2.2 c2']);
    // The beat-wide cut order follows the scene order.
    expect(listed.scenes.flatMap((s) => s.cuts.map((c) => c.order))).toEqual([1, 2, 3]);

    expect((await call('POST', '/api/video-scenes/reorder', { beat_id: String(beat._id), ordered_ids: 'nope' })).status).toBe(400);
    expect((await call('POST', '/api/video-scenes/reorder', { beat_id: String(beat._id), ordered_ids: ['nope'] })).status).toBe(400);
    expect((await call('POST', '/api/video-scenes/reorder', { beat_id: String(beat._id), ordered_ids: [String(s1._id)] })).status).toBe(400);
    expect((await call('POST', '/api/video-scenes/reorder', { beat_id: String(beat._id), ordered_ids: [String(s1._id), String(s1._id)] })).status).toBe(400);
    expect((await call('POST', '/api/video-scenes/reorder', { beat_id: String(new ObjectId()), ordered_ids: [] })).status).toBe(404);
  });

  it('DELETE /video-scene/:id removes the scene with its cuts and media, and renumbers scenes and cuts', async () => {
    const { beat } = await seedBeat();
    const { s1, s2, c1, c2, c3 } = await seedScenes(beat);
    const s3 = (await call('POST', '/api/video-scene', { beat_id: String(beat._id), title: 'Three' })).json.scene;
    await call('POST', '/api/cut', { scene_id: s3._id });
    await call('POST', '/api/cut', { scene_id: s3._id });
    const clip = new ObjectId();
    const frame = img('frame');
    await VP.updateVideoPrompt(projectId, c1._id, { video_file_id: clip, start_frame: { image_id: frame } });
    expect(labels(await list(beat))).toEqual(['1.1 c1', '1.2 c2', '2.1 c3', '3.1', '3.2']);

    expect((await call('DELETE', `/api/video-scene/${new ObjectId()}`)).status).toBe(404);
    expect((await call('DELETE', '/api/video-scene/nope')).status).toBe(404);
    const other = (await createProject('Other'))._id.toString();
    expect((await call('DELETE', `/api/video-scene/${s1._id}`, undefined, other)).status).toBe(404);

    const r = await call('DELETE', `/api/video-scene/${s1._id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, beat_id: String(beat._id), cuts_removed: 2 });
    const after = await list(beat);
    // Scene 2 is now scene 1 and scene 3 is scene 2 — their cuts renumber with them.
    expect(after.scenes.map((s) => [s._id, s.order])).toEqual([[String(s2._id), 1], [s3._id, 2]]);
    expect(labels(after)).toEqual(['1.1 c3', '2.1', '2.2']);
    expect(after.scenes.flatMap((s) => s.cuts.map((c) => c.order))).toEqual([1, 2, 3]);
    expect(await VP.getVideoPrompt(projectId, String(c1._id))).toBeNull();
    expect(await VP.getVideoPrompt(projectId, String(c2._id))).toBeNull();
    expect(await VP.getVideoPrompt(projectId, String(c3._id))).not.toBeNull();
    expect(deletedAttachments).toEqual([String(clip)]);
    expect(deleted).toEqual([String(frame)]);
    expect((await call('DELETE', `/api/video-scene/${s1._id}`)).status).toBe(404);

    // Deleting the last scenes leaves an empty beat.
    await call('DELETE', `/api/video-scene/${s2._id}`);
    await call('DELETE', `/api/video-scene/${s3._id}`);
    expect((await list(beat)).scenes).toEqual([]);
    expect(await VP.listVideoPrompts({ beatId: beat._id })).toEqual([]);
  });
});

describe('cuts', () => {
  it('POST /cut appends cut N.M to the scene; 404 for an unknown scene', async () => {
    const { beat } = await seedBeat();
    const { s1, s2 } = await seedScenes(beat);
    expect((await call('POST', '/api/cut', {})).status).toBe(404);
    expect((await call('POST', '/api/cut', { scene_id: 'nope' })).status).toBe(404);
    expect((await call('POST', '/api/cut', { scene_id: String(new ObjectId()) })).status).toBe(404);
    const other = (await createProject('Other'))._id.toString();
    expect((await call('POST', '/api/cut', { scene_id: String(s1._id) }, other)).status).toBe(404);
    // A beat id is not a way to add a cut any more: every cut belongs to a scene.
    expect((await call('POST', '/api/cut', { beat_id: String(beat._id) })).status).toBe(404);

    let r = await call('POST', '/api/cut', { scene_id: String(s1._id), title: 'ignored', prompt: 'ignored' });
    expect(r.status).toBe(201);
    // Scene 1 had two cuts: this is 1.3, and scene 2's cut moves down the beat-wide order.
    expect(r.json.cut).toMatchObject({
      scene_id: String(s1._id),
      beat_id: String(beat._id),
      cut_index: 3,
      order: 3,
      title: '',
      prompt: '',
      duration_seconds: null,
      start_frame: null,
      end_frame: null,
    });
    expect(broadcasts.at(-1).payload).toMatchObject({ changed: ['video_prompts'], added_video_prompt_id: r.json.cut._id });
    r = await call('POST', '/api/cut', { scene_id: String(s2._id) });
    expect(r.json.cut).toMatchObject({ scene_id: String(s2._id), cut_index: 2, order: 5 });
    const listed = await list(beat);
    expect(labels(listed)).toEqual(['1.1 c1', '1.2 c2', '1.3', '2.1 c3', '2.2']);
    expect(listed.scenes.flatMap((s) => s.cuts.map((c) => c.order))).toEqual([1, 2, 3, 4, 5]);
    // The new cut's four text fragments are in the room, empty.
    const { resolveRoom } = await import('../src/web/roomRegistry.js');
    const room = await resolveRoom(`video_prompts:${beat._id}`);
    for (const f of ['title', 'prompt', 'start_frame_prompt', 'end_frame_prompt']) {
      expect(room.seed[`item:${r.json.cut._id}:${f}`]).toBe('');
    }
  });

  it('PATCH /cut/:id takes duration_seconds only, in half-second steps, and validates it', async () => {
    const { beat } = await seedBeat();
    const { c1 } = await seedScenes(beat);
    const url = `/api/cut/${c1._id}`;
    expect((await call('PATCH', `/api/cut/${new ObjectId()}`, { duration_seconds: 2 })).status).toBe(404);
    expect((await call('PATCH', '/api/cut/nope', { duration_seconds: 2 })).status).toBe(404);
    let r = await call('PATCH', url, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/duration_seconds required/);
    // Text is a y-doc fragment, not a REST field.
    expect((await call('PATCH', url, { title: 'x', prompt: 'y' })).status).toBe(400);
    for (const bad of [0, -1, 'abc', 601, 'NaN', [1, 2], { a: 1 }]) {
      r = await call('PATCH', url, { duration_seconds: bad });
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.json.error).toMatch(/positive number/);
    }
    expect((await VP.getVideoPrompt(projectId, String(c1._id))).duration_seconds).toBeNull();

    broadcasts.length = 0;
    r = await call('PATCH', url, { duration_seconds: 2.5, title: 'not written' });
    expect(r.status).toBe(200);
    expect(r.json.cut).toMatchObject({ _id: String(c1._id), duration_seconds: 2.5, title: 'c1' });
    expect(broadcasts).toEqual([
      { room: `video_prompts:${beat._id}`, payload: expect.objectContaining({ changed: ['duration_seconds'], video_prompt_id: String(c1._id) }) },
    ]);
    expect((await call('PATCH', url, { duration_seconds: 3.2 })).json.cut.duration_seconds).toBe(3);
    expect((await call('PATCH', url, { duration_seconds: '4.75' })).json.cut.duration_seconds).toBe(5);
    expect((await call('PATCH', url, { duration_seconds: 0.1 })).json.cut.duration_seconds).toBe(0.5);
    expect((await call('PATCH', url, { duration_seconds: 600 })).json.cut.duration_seconds).toBe(600);
    // null and '' clear it.
    expect((await call('PATCH', url, { duration_seconds: null })).json.cut.duration_seconds).toBeNull();
    await call('PATCH', url, { duration_seconds: 2 });
    expect((await call('PATCH', url, { duration_seconds: '' })).json.cut.duration_seconds).toBeNull();
    const other = (await createProject('Other'))._id.toString();
    expect((await call('PATCH', url, { duration_seconds: 2 }, other)).status).toBe(404);
  });

  it('POST /cuts/reorder within a scene, and DELETE /cut/:id renumbers', async () => {
    const { beat } = await seedBeat();
    const { s1, c1, c2, c3 } = await seedScenes(beat);
    let r = await call('POST', '/api/cuts/reorder', { scene_id: String(s1._id), ordered_ids: [String(c2._id), String(c1._id)] });
    expect(r.status).toBe(200);
    expect(r.json.cuts.map((c) => [c._id, c.cut_index])).toEqual([[String(c2._id), 1], [String(c1._id), 2]]);
    let listed = await list(beat);
    expect(labels(listed)).toEqual(['1.1 c2', '1.2 c1', '2.1 c3']);
    expect(listed.scenes[1].cuts[0].order).toBe(3);
    // A cut of another scene, a short list, junk ids, an unknown scene.
    expect((await call('POST', '/api/cuts/reorder', { scene_id: String(s1._id), ordered_ids: [String(c3._id), String(c1._id)] })).status).toBe(400);
    expect((await call('POST', '/api/cuts/reorder', { scene_id: String(s1._id), ordered_ids: [String(c1._id)] })).status).toBe(400);
    expect((await call('POST', '/api/cuts/reorder', { scene_id: String(s1._id), ordered_ids: ['nope'] })).status).toBe(400);
    expect((await call('POST', '/api/cuts/reorder', { scene_id: String(s1._id) })).status).toBe(400);
    expect((await call('POST', '/api/cuts/reorder', { scene_id: String(new ObjectId()), ordered_ids: [] })).status).toBe(404);

    const clip = new ObjectId();
    const frame = img('frame');
    const undo = img('undo');
    const ref = img('artwork');
    await VP.updateVideoPrompt(projectId, c2._id, {
      video_file_id: clip,
      end_frame: { image_id: frame, previous_image_id: undo, reference_ids: [ref] },
    });
    r = await call('DELETE', `/api/cut/${c2._id}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, beat_id: String(beat._id) });
    listed = await list(beat);
    expect(labels(listed)).toEqual(['1.1 c1', '2.1 c3']);
    expect(listed.scenes.flatMap((s) => s.cuts.map((c) => c.order))).toEqual([1, 2]);
    expect(deletedAttachments).toEqual([String(clip)]);
    // The frame and its undo image go; the reference artwork is not the cut's to delete.
    expect(deleted.sort()).toEqual([String(frame), String(undo)].sort());
    expect((await call('DELETE', `/api/cut/${c2._id}`)).status).toBe(404);
  });
});

describe('frames', () => {
  // `extra`: createVideoPrompt fields, or a function of the seeded beat's artwork ids.
  async function seedCut(extra = {}) {
    const seeded = await seedBeat();
    const scene = await VS.createVideoScene({ projectId, beatId: seeded.beat._id, title: 'One' });
    const fields = typeof extra === 'function' ? extra(seeded) : extra;
    const cut = await VP.createVideoPrompt({ projectId, beatId: seeded.beat._id, sceneId: scene._id, title: 'c', ...fields });
    return { ...seeded, scene, cut };
  }
  const frameOf = async (cut, key = 'start_frame') => (await VP.getVideoPrompt(projectId, String(cut._id)))[key];

  it('generate → job → the frame on the cut; PATCH references; undo restores; DELETE keeps prompt + references', async () => {
    const { beat, cut, sarahArt, dinerArt } = await seedCut((a) => ({ startFrame: { prompt: 'Wide still.', reference_ids: [a.sarahArt] } }));
    expect((await call('POST', `/api/cut/${new ObjectId()}/start-frame/generate`, {})).status).toBe(404);
    let r = await call('POST', `/api/cut/${cut._id}/start-frame/generate`, { image_model: ' nano-banana-2 ', comfy_params: { steps: 4 } });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ job_id: expect.stringMatching(/^[a-f0-9]{24}$/), cut_id: String(cut._id), frame: 'start' });
    let job = await waitFrame(r.json.job_id);
    expect(job).toMatchObject({ job_id: r.json.job_id, beat_id: String(beat._id), cut_id: String(cut._id), frame: 'start', status: 'done', error: null });
    // Exactly the one listed reference, on the model asked for; comfy params only reach comfy models.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].model).toBe('nano-banana-2');
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['Sarah, grey coat']);
    expect(dispatched[0]).not.toHaveProperty('comfyParams');
    const first = await frameOf(cut);
    expect(first.image_id).toBeTruthy();
    expect(first.prompt).toBe('Wide still.');
    expect(first.reference_ids.map(String)).toEqual([String(sarahArt)]);
    r = await call('POST', `/api/cut/${cut._id}/start-frame/undo`);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('nothing to undo');

    // The reference list: ordered, deduped, validated; the image and prompt stay.
    r = await call('PATCH', `/api/cut/${cut._id}/start-frame`, { reference_ids: [String(dinerArt), String(sarahArt), String(dinerArt)] });
    expect(r.status).toBe(200);
    expect(r.json.cut.start_frame.reference_ids).toEqual([String(dinerArt), String(sarahArt)]);
    expect(r.json.cut.start_frame.image_id).toBe(String(first.image_id));
    expect(r.json.cut.start_frame.prompt).toBe('Wide still.');
    expect((await call('PATCH', `/api/cut/${cut._id}/start-frame`, { reference_ids: ['nope'] })).status).toBe(400);
    expect((await call('PATCH', `/api/cut/${cut._id}/start-frame`, {})).status).toBe(400);
    expect((await call('PATCH', `/api/cut/${new ObjectId()}/start-frame`, { reference_ids: [] })).status).toBe(404);
    const many = Array.from({ length: VP.MAX_REFERENCE_IMAGES + 3 }, () => String(new ObjectId()));
    r = await call('PATCH', `/api/cut/${cut._id}/start-frame`, { reference_ids: many });
    expect(r.json.cut.start_frame.reference_ids).toEqual(many.slice(0, VP.MAX_REFERENCE_IMAGES));
    r = await call('PATCH', `/api/cut/${cut._id}/start-frame`, { reference_ids: [String(dinerArt), String(sarahArt)] });

    // A second render uses the new list and makes the first image the undo target.
    r = await call('POST', `/api/cut/${cut._id}/start-frame/generate`, {});
    job = await waitFrame(r.json.job_id);
    expect(job.status).toBe('done');
    expect(dispatched[1].inputImages.map((i) => i.buffer.toString())).toEqual(['Sarah, grey coat', 'Diner interior']);
    const second = await frameOf(cut);
    expect(String(second.previous_image_id)).toBe(String(first.image_id));
    expect(String(second.image_id)).not.toBe(String(first.image_id));

    r = await call('POST', `/api/cut/${cut._id}/start-frame/undo`);
    expect(r.status).toBe(200);
    expect(r.json.cut.start_frame.image_id).toBe(String(first.image_id));
    expect(r.json.cut.start_frame.previous_image_id).toBeNull();
    expect(deleted).toContain(String(second.image_id));
    expect((await call('POST', `/api/cut/${new ObjectId()}/start-frame/undo`)).status).toBe(404);

    r = await call('DELETE', `/api/cut/${cut._id}/start-frame`);
    expect(r.status).toBe(200);
    expect(r.json.cut.start_frame.image_id).toBeNull();
    expect(r.json.cut.start_frame.prompt).toBe('Wide still.');
    expect(r.json.cut.start_frame.reference_ids).toEqual([String(dinerArt), String(sarahArt)]);
    expect(deleted).toContain(String(first.image_id));
    expect(deleted).not.toContain(String(dinerArt));
    expect((await call('DELETE', `/api/cut/${new ObjectId()}/start-frame`)).status).toBe(404);
  });

  it('a frame with no references is rendered from its prompt alone; one with no prompt is a 400', async () => {
    const { cut } = await seedCut({ startFrame: { prompt: 'An empty road.' } });
    let r = await call('POST', `/api/cut/${cut._id}/end-frame/generate`, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/no end-frame prompt/);
    r = await call('POST', `/api/cut/${cut._id}/start-frame/generate`);
    expect(r.status).toBe(202);
    await waitFrame(r.json.job_id);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].inputImages).toEqual([]);
    expect(dispatched[0].prompt).toBe('An empty road.');
    expect(dispatched[0].model).toBe(CF.DEFAULT_FRAME_MODEL);
  });

  it('409 CUT_BUSY for the same frame while it renders; the other frame and other cuts start; GET /cuts/jobs lists them', async () => {
    const { beat, scene, cut } = await seedCut({ startFrame: { prompt: 'First.' }, endFrame: { prompt: 'Last.' } });
    const other = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: scene._id, startFrame: { prompt: 'Other.' } });
    const g = holdRenders();
    const start = await call('POST', `/api/cut/${cut._id}/start-frame/generate`, {});
    expect(start.status).toBe(202);
    const busy = await call('POST', `/api/cut/${cut._id}/start-frame/generate`, {});
    expect(busy.status).toBe(409);
    expect(busy.json).toEqual({ error: expect.stringMatching(/start frame is already rendering/), code: 'CUT_BUSY', job_id: start.json.job_id });
    const end = await call('POST', `/api/cut/${cut._id}/end-frame/generate`, {});
    expect(end.status).toBe(202);
    expect(end.json.frame).toBe('end');
    const third = await call('POST', `/api/cut/${other._id}/start-frame/generate`, {});
    expect(third.status).toBe(202);
    await until(() => dispatched.length === 3);

    let jobs = await call('GET', `/api/cuts/jobs?beat_id=${beat._id}`);
    expect(jobs.status).toBe(200);
    expect(Object.keys(jobs.json).sort()).toEqual(['comfy_videos', 'frames']);
    expect(jobs.json.comfy_videos).toEqual([]);
    expect(jobs.json.frames.map((j) => [j.job_id, j.cut_id, j.frame, j.status]).sort()).toEqual(
      [
        [start.json.job_id, String(cut._id), 'start', 'running'],
        [end.json.job_id, String(cut._id), 'end', 'running'],
        [third.json.job_id, String(other._id), 'start', 'running'],
      ].sort(),
    );
    expect((await call('GET', `/api/cuts/frames/job/${start.json.job_id}`)).json.status).toBe('running');
    // Deleting a scene or cut is not locked out by a render either.
    expect((await call('PATCH', `/api/cut/${cut._id}`, { duration_seconds: 2 })).status).toBe(200);

    g.release();
    for (const id of [start.json.job_id, end.json.job_id, third.json.job_id]) expect((await waitFrame(id)).status).toBe('done');
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.start_frame.image_id).toBeTruthy();
    expect(saved.end_frame.image_id).toBeTruthy();
    expect(saved.duration_seconds).toBe(2);
    jobs = await call('GET', `/api/cuts/jobs?beat_id=${beat._id}`);
    expect(jobs.json.frames).toEqual([]);
    // Free again.
    gate = null;
    expect((await call('POST', `/api/cut/${cut._id}/start-frame/generate`, {})).status).toBe(202);

    expect((await call('GET', '/api/cuts/jobs')).status).toBe(404);
    expect((await call('GET', `/api/cuts/jobs?beat_id=${new ObjectId()}`)).status).toBe(404);
  });

  it('GET /cuts/frames/job/:jobId: 404 for an unknown job and for another project; a failed render is reported and listed', async () => {
    const { beat, cut } = await seedCut({ startFrame: { prompt: 'First.' } });
    expect((await call('GET', `/api/cuts/frames/job/${new ObjectId()}`)).status).toBe(404);
    CF._setCutFrameDispatcherForTests(async () => {
      throw new Error('model unavailable');
    });
    const r = await call('POST', `/api/cut/${cut._id}/start-frame/generate`, {});
    const job = await waitFrame(r.json.job_id);
    expect(job).toMatchObject({ status: 'error', error: 'model unavailable', frame: 'start' });
    const other = (await createProject('Other'))._id.toString();
    expect((await call('GET', `/api/cuts/frames/job/${r.json.job_id}`, undefined, other)).status).toBe(404);
    const jobs = await call('GET', `/api/cuts/jobs?beat_id=${beat._id}`);
    expect(jobs.json.frames).toEqual([expect.objectContaining({ job_id: r.json.job_id, status: 'error' })]);
    expect((await frameOf(cut)).image_id).toBeNull();
  });

  it('end-frame twins: generate, PATCH references, undo, DELETE — the start frame untouched', async () => {
    const startImg = img('start');
    const { cut, sarahArt, dinerArt } = await seedCut({
      startFrame: { prompt: 'Sky.', image_id: startImg },
      endFrame: { prompt: 'The marquee.', reference_ids: [] },
    });
    // References can be listed before anything is rendered.
    let r = await call('PATCH', `/api/cut/${cut._id}/end-frame`, { reference_ids: [String(dinerArt), String(startImg)] });
    expect(r.status).toBe(200);
    expect(r.json.cut.end_frame).toMatchObject({ prompt: 'The marquee.', image_id: null, reference_ids: [String(dinerArt), String(startImg)] });
    expect(r.json.cut.start_frame.image_id).toBe(String(startImg));

    r = await call('POST', `/api/cut/${cut._id}/end-frame/generate`, {});
    expect(r.status).toBe(202);
    expect((await waitFrame(r.json.job_id)).status).toBe('done');
    // The cut's own start frame, listed on the end frame, is sent last as the opening frame.
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['Diner interior', 'start']);
    expect(dispatched[0].prompt).toContain('Image 2 is the opening frame of this same shot');
    const first = await frameOf(cut, 'end_frame');
    expect(first.image_id).toBeTruthy();
    expect(first.reference_ids.map(String)).toEqual([String(dinerArt), String(startImg)]);

    r = await call('PATCH', `/api/cut/${cut._id}/end-frame`, { reference_ids: [String(sarahArt)] });
    expect(r.json.cut.end_frame.reference_ids).toEqual([String(sarahArt)]);
    expect(r.json.cut.end_frame.image_id).toBe(String(first.image_id));
    expect((await call('PATCH', `/api/cut/${cut._id}/end-frame`, {})).status).toBe(400);
    // The planner's derive switch is gone: reference_ids is the only thing this route takes.
    expect((await call('PATCH', `/api/cut/${cut._id}/end-frame`, { derive: true })).status).toBe(400);

    await waitFrame((await call('POST', `/api/cut/${cut._id}/end-frame/generate`, {})).json.job_id);
    r = await call('POST', `/api/cut/${cut._id}/end-frame/undo`);
    expect(r.status).toBe(200);
    expect(r.json.cut.end_frame.image_id).toBe(String(first.image_id));

    r = await call('DELETE', `/api/cut/${cut._id}/end-frame`);
    expect(r.json.cut.end_frame.image_id).toBeNull();
    expect(r.json.cut.end_frame.prompt).toBe('The marquee.');
    expect(r.json.cut.end_frame.reference_ids).toEqual([String(sarahArt)]);
    expect(r.json.cut.start_frame.image_id).toBe(String(startImg));
    expect(r.json.cut.start_frame.previous_image_id).toBeNull();
  });

  it('the end frame\'s reference to the start frame follows a start-frame re-render and its undo', async () => {
    const { cut, dinerArt } = await seedCut({ startFrame: { prompt: 'Sky.' }, endFrame: { prompt: 'The marquee.' } });
    await waitFrame((await call('POST', `/api/cut/${cut._id}/start-frame/generate`, {})).json.job_id);
    const first = String((await frameOf(cut)).image_id);
    await call('PATCH', `/api/cut/${cut._id}/end-frame`, { reference_ids: [first, String(dinerArt)] });

    await waitFrame((await call('POST', `/api/cut/${cut._id}/start-frame/generate`, {})).json.job_id);
    const second = String((await frameOf(cut)).image_id);
    expect(second).not.toBe(first);
    expect((await frameOf(cut, 'end_frame')).reference_ids.map(String)).toEqual([second, String(dinerArt)]);

    const r = await call('POST', `/api/cut/${cut._id}/start-frame/undo`);
    expect(r.status).toBe(200);
    expect(r.json.cut.start_frame.image_id).toBe(first);
    expect(r.json.cut.end_frame.reference_ids).toEqual([first, String(dinerArt)]);
    expect((await frameOf(cut, 'end_frame')).reference_ids.map(String)).toEqual([first, String(dinerArt)]);
    expect((await frameOf(cut, 'end_frame')).prompt).toBe('The marquee.');
  });
});

describe('the planner-era routes are gone', () => {
  it('every retired route answers 404', async () => {
    const { beat } = await seedBeat();
    const { s1, c1 } = await seedScenes(beat);
    const b = { beat_id: String(beat._id) };
    for (const [method, path, body] of [
      ['POST', '/api/video-scenes/generate', b],
      ['GET', `/api/video-scenes/generate/${new ObjectId()}`],
      ['POST', '/api/video-scenes/stage', { ...b, stage: 'breakdown' }],
      ['POST', '/api/video-scenes/critique', { ...b, stage: 'table' }],
      ['POST', '/api/video-scenes/clear', b],
      ['POST', '/api/video-scenes/assemble', b],
      ['DELETE', `/api/video-scenes/video?beat_id=${beat._id}`],
      ['PATCH', `/api/video-scene/${s1._id}`, { title: 'x' }],
      ['POST', `/api/video-scene/${s1._id}/replan`, {}],
      ['POST', `/api/video-scene/${s1._id}/assemble`, {}],
      ['DELETE', `/api/video-scene/${s1._id}/video`],
      ['POST', `/api/cut/${c1._id}/replan`, {}],
      ['POST', `/api/cut/${c1._id}/lint`],
      ['POST', `/api/cut/${c1._id}/frames/check`, {}],
      ['POST', '/api/cuts/frames/check', b],
      ['POST', '/api/cuts/images/generate', b],
      ['POST', '/api/cuts/start-frames/generate', b],
      ['GET', `/api/cuts/start-frames/job/${new ObjectId()}`],
      ['DELETE', `/api/cuts/start-frames?beat_id=${beat._id}`],
      ['GET', `/api/cuts/assemble/job/${new ObjectId()}`],
      ['POST', '/api/cuts/render/preview', b],
      ['POST', '/api/cuts/render', b],
      ['GET', `/api/cuts/render/job/${new ObjectId()}`],
    ]) {
      const r = await call(method, path, body);
      expect([method, path, r.status]).toEqual([method, path, 404]);
    }
    // …and none of them changed anything.
    expect(labels(await list(beat))).toEqual(['1.1 c1', '1.2 c2', '2.1 c3']);
    expect((await VS.getVideoScene(projectId, s1._id)).title).toBe('One');
  });
});
