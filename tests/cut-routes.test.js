// REST surface of the scene/cut planner: scenes list/patch/reorder/clear,
// cut create/patch/delete/reorder/lint, and the start-frame routes. The
// planner LLM calls and the image dispatcher go through their test seams.
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
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null, withDirectDocument: vi.fn(), broadcastRoomStateless: vi.fn(), isHocuspocusRunning: () => false,
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
  const fsp = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');
  return {
    ...mod,
    streamAttachmentToTmp: vi.fn(async (id) => {
      const dir = path.join(os.tmpdir(), 'screenplay-cut-routes-test');
      await fsp.mkdir(dir, { recursive: true });
      const p = path.join(dir, `${String(id)}.mp4`);
      await fsp.writeFile(p, Buffer.from(`clip-${String(id)}`));
      return { path: p, file: { _id: id } };
    }),
    uploadAttachmentBuffer: vi.fn(async (_p, args) => ({ _id: new ObjectId(), filename: args.filename, metadata: {} })),
    deleteAttachment: vi.fn(async (id) => { deletedAttachments.push(String(id)); }),
    deleteAttachments: vi.fn(async (ids) => { for (const id of ids) deletedAttachments.push(String(id)); }),
  };
});

const realFetch = global.fetch;
const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const Planner = await import('../src/web/cutPlanner.js');
const SF = await import('../src/web/cutStartFrames.js');
const Assemble = await import('../src/web/beatAssemble.js');
const CutAssemble = await import('../src/web/cutAssemble.js');
const Gateway = await import('../src/web/gateway.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl, projectId;
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
  BeatLocks._clearBeatLocksForTests();
  Planner._setCutPlannerCallsForTests(null);
  Planner._setStartFramesRendererForTests(null);
  Planner._clearCutPlanJobsForTests();
  SF._clearCutStartFrameJobsForTests();
  SF._setStartFrameDispatcherForTests(async () => ({ buffer: Buffer.from('render'), contentType: 'image/png' }));
  CutAssemble._clearCutAssembleJobsForTests();
  deletedAttachments.length = 0;
  Assemble.__setAssembleSpawnImplForTests(async ({ bin, args }) => {
    if (bin === 'ffprobe') return { stdout: args.includes('stream=codec_type') ? 'audio\n' : '7.25\n' };
    (await import('fs')).writeFileSync(args[args.length - 1], Buffer.from('out'));
    return { stdout: '' };
  });
  projectId = (await createProject('Cut Routes'))._id.toString();
});

async function call(method, path, body, pid = projectId) {
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers: { 'X-Project-Id': pid, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
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
  const d1 = await Dialogs.createDialog({ projectId, beatId: beat._id, character: 'Sarah', body: 'Hello' });
  const d2 = await Dialogs.createDialog({ projectId, beatId: beat._id, character: 'Sarah', body: 'Goodbye' });
  return { beat, sarahArt, dinerArt, d1, d2 };
}

async function seedScenes(beat) {
  const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One', setNames: ['Diner'], characterNames: ['Sarah'] });
  const s2 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Two', setNames: ['Diner'], characterNames: ['Sarah'] });
  const c1 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 1, order: 1, title: 'c1', prompt: 'Wide shot. Same light: tubes. Sarah: coat, booth, facing the door. Camera at the counter. End on her hands.', lockLine: 'Same light: tubes. Sarah: coat, booth, facing the door. Camera at the counter.' });
  const c2 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 2, order: 2, title: 'c2' });
  const c3 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s2._id, cutIndex: 1, order: 3, title: 'c3' });
  const loose = await VP.createVideoPrompt({ projectId, beatId: beat._id, order: 4, title: 'legacy' });
  return { s1, s2, c1, c2, c3, loose };
}

async function waitPlan(id) {
  for (let i = 0; i < 500; i++) {
    const { json } = await call('GET', `/api/video-scenes/generate/${id}`);
    if (json?.job && ['done', 'partial', 'error'].includes(json.job.status)) return json.job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('plan job never finished');
}

async function waitFrames(id) {
  for (let i = 0; i < 500; i++) {
    const { json } = await call('GET', `/api/cuts/start-frames/job/${id}`);
    if (json?.job && ['done', 'partial', 'error'].includes(json.job.status)) return json.job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('frame job never finished');
}

describe('scenes', () => {
  it('GET /video-scenes groups cuts under scenes, lists legacy rows as unsorted, and validates', async () => {
    const { beat } = await seedBeat();
    const { s1, c1, c2, c3, loose } = await seedScenes(beat);
    expect((await call('GET', '/api/video-scenes')).status).toBe(400);
    expect((await call('GET', `/api/video-scenes?beat_id=${new ObjectId()}`)).status).toBe(404);
    const { status, json } = await call('GET', `/api/video-scenes?beat_id=${beat._id}`);
    expect(status).toBe(200);
    expect(json.beat.name).toBe('Diner');
    expect(json.scenes.map((s) => s.title)).toEqual(['One', 'Two']);
    expect(json.scenes[0]._id).toBe(String(s1._id));
    expect(json.scenes[0].cuts.map((c) => c._id)).toEqual([String(c1._id), String(c2._id)]);
    expect(json.scenes[1].cuts.map((c) => c._id)).toEqual([String(c3._id)]);
    expect(json.unsorted.map((c) => c._id)).toEqual([String(loose._id)]);
    expect(json.dialogs.length).toBe(2);
    // Another project cannot see it.
    const other = (await createProject('Other'))._id.toString();
    expect((await call('GET', `/api/video-scenes?beat_id=${beat._id}`, undefined, other)).status).toBe(404);
  });

  it('PATCH / reorder / DELETE / clear scenes', async () => {
    const { beat } = await seedBeat();
    const { s1, s2, c1, c2, c3, loose } = await seedScenes(beat);
    let r = await call('PATCH', `/api/video-scene/${s1._id}`, { title: 'Renamed', intention: 'crack', bogus: 'x', character_names: ['Sarah'] });
    expect(r.status).toBe(200);
    expect(r.json.scene.title).toBe('Renamed');
    expect(r.json.scene.intention).toBe('crack');
    expect(r.json.scene.bogus).toBeUndefined();
    expect((await call('PATCH', `/api/video-scene/${new ObjectId()}`, { title: 'x' })).status).toBe(404);

    r = await call('POST', '/api/video-scenes/reorder', { beat_id: String(beat._id), ordered_ids: [String(s2._id), String(s1._id)] });
    expect(r.status).toBe(200);
    const listed = (await call('GET', `/api/video-scenes?beat_id=${beat._id}`)).json;
    expect(listed.scenes.map((s) => s._id)).toEqual([String(s2._id), String(s1._id)]);
    // The beat-wide cut order follows the scene order.
    expect(listed.scenes[0].cuts[0].order).toBe(1);
    expect(listed.scenes[1].cuts.map((c) => c.order)).toEqual([2, 3]);

    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((res) => { release = res; }));
    expect((await call('DELETE', `/api/video-scene/${s1._id}`)).status).toBe(409);
    release();
    await new Promise((res) => setTimeout(res, 0));
    r = await call('DELETE', `/api/video-scene/${s1._id}`);
    expect(r.status).toBe(200);
    const after = (await call('GET', `/api/video-scenes?beat_id=${beat._id}`)).json;
    expect(after.scenes.map((s) => s._id)).toEqual([String(s2._id)]);
    expect(after.scenes[0].cuts.map((c) => c._id)).toEqual([String(c3._id)]);
    expect(after.unsorted.map((c) => c._id)).toEqual([String(loose._id)]);
    expect(await VP.getVideoPrompt(projectId, String(c1._id))).toBeNull();
    expect(await VP.getVideoPrompt(projectId, String(c2._id))).toBeNull();

    r = await call('POST', '/api/video-scenes/clear', { beat_id: String(beat._id) });
    expect(r.status).toBe(200);
    const cleared = (await call('GET', `/api/video-scenes?beat_id=${beat._id}`)).json;
    expect(cleared.scenes).toEqual([]);
    expect(cleared.unsorted).toEqual([]);
  });

  it('POST /video-scenes/generate runs the planner (seamed) and reports through the job route; 409 while busy', async () => {
    const { beat } = await seedBeat();
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    Planner._setCutPlannerCallsForTests(async ({ pass }) => {
      if (pass === 'scenes') {
        await gate;
        return { scenes: [{ title: 'Waiting', slug: 'INT. DINER — NIGHT', set_names: ['Diner'], character_names: ['Sarah'], text_span: { starts_with: 'Sarah', ends_with: 'waits.' }, directors_read: { dramatic_function: 'a', turn: 'b', pov: 'c', power_shift: 'd', hidden_want: 'e', obstacle_tactic: 'f', subtext: 'g', suppressed_behavior: 'h', non_transferable_detail: 'i', stock_solution_refused: 'j' }, intention: 'wait', scope: { already_happened: [], this_scene_only: [], reserved_for_later: [], do_not_show_yet: [] }, floor_plan: 'Booth left, door right.', dialog_lines: [1, 2] }] };
      }
      if (pass === 'cuts') return { cuts: [{ camera: { size: 'wide', angle: 'eye_level', height: 'seated', lens_mm: 24, side: 'counter', movement: 'static', motivation: '', depth_of_field: 'deep', lighting: 'tubes' }, in_frame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }], action_by: 'Sarah', reaction: false, eyeline: '', action: 'waits', others: '', last_frame: 'hands', sound: '', sound_on_action: false, crossing: false, contact: false, dialog_lines: [1, 2], sets_in_scene: ['Diner'], primary_spend: 'world', felt_intent: 'w' }], load_notes: '' };
      if (pass === 'prose') return { cuts: [{ cut_index: 1, title: 'Waiting', prompt: 'Wide shot from the counter, 24mm. Same light: tubes. Sarah: coat, booth, facing the door. Camera at the counter. End on her hands.', lock_line: 'Same light: tubes. Sarah: coat, booth, facing the door. Camera at the counter.', reference_binding: '', exclusions: [] }] };
      if (pass === 'start_frames') return { cuts: [{ cut_index: 1, start_frame_prompt: 'Wide frontal still.', reference_picks: [{ subject: 'Sarah', artwork_index: 1 }] }] };
      return null;
    });
    expect((await call('POST', '/api/video-scenes/generate', {})).status).toBe(400);
    expect((await call('POST', '/api/video-scenes/generate', { beat_id: String(new ObjectId()) })).status).toBe(404);
    const r = await call('POST', '/api/video-scenes/generate', { beat_id: String(beat._id), direction: 'Two cuts max.' });
    expect(r.status).toBe(202);
    expect((await call('POST', '/api/video-scenes/generate', { beat_id: String(beat._id) })).status).toBe(409);
    // Reattach: a page opened mid-run finds the running job for this beat,
    // with everything logged so far.
    expect((await call('GET', '/api/cuts/jobs')).status).toBe(400);
    const mid = await call('GET', `/api/cuts/jobs?beat_id=${beat._id}`);
    expect(mid.status).toBe(200);
    expect(mid.json.plan.job_id).toBe(r.json.job_id);
    expect(['queued', 'running']).toContain(mid.json.plan.status);
    expect(Array.isArray(mid.json.plan.steps)).toBe(true);
    expect(Array.isArray(mid.json.plan.events)).toBe(true);
    expect(mid.json.plan).not.toHaveProperty('_notify');
    expect(mid.json).toMatchObject({ start_frames: null, assemble: null, render: null });
    releaseGate();
    const job = await waitPlan(r.json.job_id);
    expect(job.status).toBe('done');
    // …and one opened just after it ended still gets the finished job + log.
    const after = await call('GET', `/api/cuts/jobs?beat_id=${beat._id}`);
    expect(after.json.plan).toMatchObject({ job_id: r.json.job_id, status: 'done' });
    expect(after.json.plan.events.at(-1).text).toMatch(/^✓ Done/);
    expect(job.scenes_done).toBe(1);
    expect(job.cuts_done).toBe(1);
    expect((await call('GET', `/api/video-scenes/generate/${new ObjectId()}`)).status).toBe(404);
    const listed = (await call('GET', `/api/video-scenes?beat_id=${beat._id}`)).json;
    expect(listed.scenes[0].title).toBe('Waiting');
    expect(listed.scenes[0].cuts[0].title).toBe('Waiting');
    expect(listed.scenes[0].cuts[0].start_frame.prompt).toBe('Wide frontal still.');
    expect(listed.scenes[0].cuts[0].dialog_ids.length).toBe(2);

    // Replan one scene through its route.
    const rp = await call('POST', `/api/video-scene/${listed.scenes[0]._id}/replan`, { direction: 'tighter' });
    expect(rp.status).toBe(202);
    const rj = await waitPlan(rp.json.job_id);
    expect(rj.status).toBe('done');
    expect(rj.scene_id).toBe(listed.scenes[0]._id);
    expect((await call('POST', `/api/video-scene/${new ObjectId()}/replan`, {})).status).toBe(404);
  });
});

describe('cuts', () => {
  it('POST /cut appends to a scene (renumbered) or to the beat as unsorted', async () => {
    const { beat } = await seedBeat();
    const { s1 } = await seedScenes(beat);
    expect((await call('POST', '/api/cut', {})).status).toBe(400);
    expect((await call('POST', '/api/cut', { scene_id: String(new ObjectId()) })).status).toBe(404);
    let r = await call('POST', '/api/cut', { scene_id: String(s1._id), title: 'third' });
    expect(r.status).toBe(200);
    expect(r.json.cut.scene_id).toBe(String(s1._id));
    expect(r.json.cut.cut_index).toBe(3);
    expect(r.json.cut.order).toBe(3);
    expect(r.json.cut.sets_in_scene).toEqual(['Diner']);
    r = await call('POST', '/api/cut', { beat_id: String(beat._id), title: 'loose2', prompt: 'p' });
    expect(r.status).toBe(200);
    expect(r.json.cut.scene_id).toBeNull();
    const listed = (await call('GET', `/api/video-scenes?beat_id=${beat._id}`)).json;
    expect(listed.scenes[0].cuts.map((c) => c.title)).toEqual(['c1', 'c2', 'third']);
    expect(listed.unsorted.map((c) => c.title)).toEqual(['legacy', 'loose2']);
  });

  it('PATCH /cut/:id accepts structured fields, verifies dialog ids and references, rejects the rest', async () => {
    const { beat, sarahArt, d1, d2 } = await seedBeat();
    const { c1 } = await seedScenes(beat);
    let r = await call('PATCH', `/api/cut/${c1._id}`, {
      camera: { size: 'close_up', lens_mm: '85', angle: 'nonsense' },
      in_frame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }],
      action_by: 'Sarah', last_frame: 'hands', crossing: true, primary_spend: 'identity',
      dialog_ids: [String(d2._id), String(d1._id)],
      duration_seconds: 7, exclusions: ['no street'], title: 'ignored',
    });
    expect(r.status).toBe(200);
    expect(r.json.cut.camera.size).toBe('close_up');
    expect(r.json.cut.camera.lens_mm).toBe(85);
    expect(r.json.cut.camera.angle).toBeNull();
    expect(r.json.cut.crossing).toBe(true);
    expect(r.json.cut.dialog_ids).toEqual([String(d1._id), String(d2._id)]);
    expect(r.json.cut.duration_seconds).toBe(7);
    expect(r.json.cut.exclusions).toEqual(['no street']);
    expect(r.json.cut.title).toBe('c1');
    expect((await call('PATCH', `/api/cut/${c1._id}`, { dialog_ids: [String(new ObjectId())] })).status).toBe(400);
    expect((await call('PATCH', `/api/cut/${c1._id}`, { duration_seconds: 99 })).status).toBe(400);
    // Half-second lengths and hand-set assembly trims (null = automatic).
    r = await call('PATCH', `/api/cut/${c1._id}`, { duration_seconds: 1.5, trim_head_seconds: 0.75, trim_tail_seconds: 0 });
    expect(r.json.cut).toMatchObject({ duration_seconds: 1.5, trim_head_seconds: 0.75, trim_tail_seconds: 0 });
    r = await call('PATCH', `/api/cut/${c1._id}`, { trim_head_seconds: '', trim_tail_seconds: null });
    expect(r.json.cut).toMatchObject({ trim_head_seconds: null, trim_tail_seconds: null });
    expect((await call('PATCH', `/api/cut/${c1._id}`, { trim_head_seconds: -1 })).status).toBe(400);
    expect((await call('PATCH', `/api/cut/${c1._id}`, { reference_image_ids: [String(new ObjectId())] })).status).toBe(400);
    r = await call('PATCH', `/api/cut/${c1._id}`, { reference_image_ids: [String(sarahArt)] });
    expect(r.status).toBe(200);
    expect(r.json.cut.reference_images.map((x) => x.image_id)).toEqual([String(sarahArt)]);
    expect((await call('PATCH', `/api/cut/${new ObjectId()}`, { crossing: true })).status).toBe(404);
  });

  it('DELETE, reorder within a scene, and lint', async () => {
    const { beat } = await seedBeat();
    const { s1, c1, c2, c3 } = await seedScenes(beat);
    let r = await call('POST', '/api/cuts/reorder', { scene_id: String(s1._id), ordered_ids: [String(c2._id), String(c1._id)] });
    expect(r.status).toBe(200);
    let listed = (await call('GET', `/api/video-scenes?beat_id=${beat._id}`)).json;
    expect(listed.scenes[0].cuts.map((c) => c._id)).toEqual([String(c2._id), String(c1._id)]);
    expect(listed.scenes[0].cuts.map((c) => c.cut_index)).toEqual([1, 2]);
    expect(listed.scenes[1].cuts[0].order).toBe(3);
    expect((await call('POST', '/api/cuts/reorder', { scene_id: String(s1._id), ordered_ids: [String(c3._id)] })).status).toBe(400);

    r = await call('POST', `/api/cut/${c1._id}/lint`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.lint)).toBe(true);
    expect(r.json.lint.map((f) => f.code)).not.toContain('lock_line_missing');
    r = await call('POST', `/api/cut/${c2._id}/lint`);
    expect(r.json.lint.map((f) => f.code)).toContain('too_short');

    r = await call('DELETE', `/api/cut/${c2._id}`);
    expect(r.status).toBe(200);
    listed = (await call('GET', `/api/video-scenes?beat_id=${beat._id}`)).json;
    expect(listed.scenes[0].cuts.map((c) => c._id)).toEqual([String(c1._id)]);
    expect(listed.scenes[0].cuts[0].cut_index).toBe(1);
    expect((await call('DELETE', `/api/cut/${c2._id}`)).status).toBe(404);
  });
});

describe('start frames', () => {
  it('single generate → job → frame on the cut; PATCH references; DELETE keeps the prompt; undo restores', async () => {
    const { beat, sarahArt, dinerArt } = await seedBeat();
    const cut = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'c', charactersInScene: ['Sarah'], setsInScene: ['Diner'], startFrame: { prompt: 'Wide still.', reference_ids: [sarahArt] } });
    expect((await call('POST', `/api/cut/${new ObjectId()}/start-frame/generate`, {})).status).toBe(404);
    expect((await call('POST', `/api/cut/${cut._id}/start-frame/generate`, { mode: 'edit' })).status).toBe(400);
    let r = await call('POST', `/api/cut/${cut._id}/start-frame/generate`, { image_model: 'nano-banana-pro' });
    expect(r.status).toBe(202);
    let job = await waitFrames(r.json.job_id);
    expect(job).toMatchObject({ status: 'done', rendered: 1 });
    const first = (await VP.getVideoPrompt(projectId, String(cut._id))).start_frame;
    expect(first.image_id).toBeTruthy();
    expect((await call('POST', `/api/cut/${cut._id}/start-frame/undo`)).status).toBe(400);

    r = await call('PATCH', `/api/cut/${cut._id}/start-frame`, { reference_ids: [String(dinerArt), String(sarahArt), String(dinerArt)] });
    expect(r.status).toBe(200);
    expect(r.json.cut.start_frame.reference_ids).toEqual([String(dinerArt), String(sarahArt)]);
    expect(r.json.cut.start_frame.image_id).toBe(String(first.image_id));
    expect((await call('PATCH', `/api/cut/${cut._id}/start-frame`, { reference_ids: ['nope'] })).status).toBe(400);

    r = await call('POST', `/api/cut/${cut._id}/start-frame/generate`, { prompt: 'Closer still.' });
    job = await waitFrames(r.json.job_id);
    expect(job.status).toBe('done');
    const second = (await VP.getVideoPrompt(projectId, String(cut._id))).start_frame;
    expect(String(second.previous_image_id)).toBe(String(first.image_id));
    expect(second.prompt).toBe('Closer still.');

    r = await call('POST', `/api/cut/${cut._id}/start-frame/undo`);
    expect(r.status).toBe(200);
    expect(r.json.cut.start_frame.image_id).toBe(String(first.image_id));
    expect(r.json.cut.start_frame.previous_image_id).toBeNull();
    expect(deleted).toContain(String(second.image_id));

    r = await call('DELETE', `/api/cut/${cut._id}/start-frame`);
    expect(r.status).toBe(200);
    expect(r.json.cut.start_frame.image_id).toBeNull();
    expect(r.json.cut.start_frame.prompt).toBe('Closer still.');
    expect(r.json.cut.start_frame.reference_ids).toEqual([String(dinerArt), String(sarahArt)]);
    expect(deleted).toContain(String(first.image_id));
  });

  it('bulk generate over a beat: 202, skip rendered, 409 while busy, 404 unknown job', async () => {
    const { beat, sarahArt } = await seedBeat();
    await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'a', order: 1, startFrame: { prompt: 'p', reference_ids: [sarahArt], image_id: img('done') } });
    await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'b', order: 2, startFrame: { prompt: 'p', reference_ids: [sarahArt] } });
    let releaseGate;
    const gate = new Promise((res) => { releaseGate = res; });
    SF._setStartFrameDispatcherForTests(async () => {
      await gate;
      return { buffer: Buffer.from('render'), contentType: 'image/png' };
    });
    expect((await call('POST', '/api/cuts/start-frames/generate', {})).status).toBe(400);
    const r = await call('POST', '/api/cuts/start-frames/generate', { beat_id: String(beat._id) });
    expect(r.status).toBe(202);
    expect((await call('POST', '/api/cuts/start-frames/generate', { beat_id: String(beat._id) })).status).toBe(409);
    releaseGate();
    const job = await waitFrames(r.json.job_id);
    expect(job).toMatchObject({ status: 'done', planned: 2, rendered: 1, skipped: 1 });
    expect((await call('GET', `/api/cuts/start-frames/job/${new ObjectId()}`)).status).toBe(404);
  });

  it('POST /cut/:id/frames/check: 400 while switched off or without both frames, 202 check / repair, 409 while the beat is busy', async () => {
    const FC = await import('../src/web/cutFrameCheck.js');
    const { beat } = await seedBeat();
    const cut = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'c', startFrame: { prompt: 's', image_id: img('start') }, endFrame: { prompt: 'e', image_id: img('end') } });
    const bare = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'bare', startFrame: { prompt: 's', image_id: img('only start') } });
    // tests/setup.js pins CUT_FRAME_CHECK=off.
    let r = await call('POST', `/api/cut/${cut._id}/frames/check`, {});
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/switched off/);
    const issue = { kind: 'prop_added', frame_to_fix: 'end', note: 'A dispenser appears.', fix_instruction: 'Remove the dispenser.' };
    let n = 0;
    // Fails for the check-only job and for the repair job's first look, then passes.
    FC._setFrameCheckerForTests(async () => ({ issues: n++ < 2 ? [issue] : [] }));
    try {
      expect((await call('POST', `/api/cut/${new ObjectId()}/frames/check`, {})).status).toBe(404);
      r = await call('POST', `/api/cut/${bare._id}/frames/check`, {});
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/Render both/);
      r = await call('POST', `/api/cut/${cut._id}/frames/check`, {});
      expect(r.status).toBe(202);
      let job = await waitFrames(r.json.job_id);
      expect(job).toMatchObject({ status: 'done', kind: 'check', checks: { failed: 1 } });
      r = await call('GET', `/api/video-scenes?beat_id=${beat._id}`);
      const row = [...r.json.unsorted, ...r.json.scenes.flatMap((s) => s.cuts)].find((c) => String(c._id) === String(cut._id));
      expect(row.frame_check).toMatchObject({ status: 'fail', rounds: 0, issues: [issue] });
      r = await call('POST', `/api/cut/${cut._id}/frames/check`, { repair: true });
      expect(r.status).toBe(202);
      job = await waitFrames(r.json.job_id);
      expect(job).toMatchObject({ status: 'done', kind: 'repair', checks: { passed: 1, repaired: 1 } });
      expect((await VP.getVideoPrompt(projectId, String(cut._id))).frame_check).toMatchObject({ status: 'pass', rounds: 1 });
      await BeatLocks.withBeatLock(beat._id, async () => {
        expect((await call('POST', `/api/cut/${cut._id}/frames/check`, {})).status).toBe(409);
      });
    } finally {
      FC._setFrameCheckerForTests(null);
    }
  });

  it('end-frame twins: generate, PATCH references, undo, DELETE — the start frame untouched; bulk takes frames; DELETE ?frames=end', async () => {
    const { beat, sarahArt, dinerArt } = await seedBeat();
    const startImg = img('start');
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'c',
      startFrame: { prompt: 'Sky.', image_id: startImg, references_planned: true },
      endFrame: { prompt: 'The marquee.', reference_ids: [dinerArt], references_planned: true },
    });
    let r = await call('POST', `/api/cut/${cut._id}/end-frame/generate`, {});
    expect(r.status).toBe(202);
    let job = await waitFrames(r.json.job_id);
    expect(job).toMatchObject({ status: 'done', rendered: 1, frames: ['end'] });
    const first = (await VP.getVideoPrompt(projectId, String(cut._id))).end_frame;
    expect(first.image_id).toBeTruthy();

    r = await call('PATCH', `/api/cut/${cut._id}/end-frame`, { reference_ids: [String(sarahArt)] });
    expect(r.json.cut.end_frame.reference_ids).toEqual([String(sarahArt)]);
    expect(r.json.cut.start_frame.image_id).toBe(String(startImg));
    // The derive switch (end frame only) patches on its own and keeps the list.
    r = await call('PATCH', `/api/cut/${cut._id}/end-frame`, { derive: true });
    expect(r.json.cut.end_frame).toMatchObject({ derive: true, reference_ids: [String(sarahArt)] });
    r = await call('PATCH', `/api/cut/${cut._id}/end-frame`, { derive: false });
    expect(r.json.cut.end_frame.derive).toBe(false);
    expect((await call('PATCH', `/api/cut/${cut._id}/start-frame`, { derive: true })).status).toBe(400);
    expect((await call('PATCH', `/api/cut/${cut._id}/end-frame`, {})).status).toBe(400);

    job = await waitFrames((await call('POST', `/api/cut/${cut._id}/end-frame/generate`, {})).json.job_id);
    r = await call('POST', `/api/cut/${cut._id}/end-frame/undo`);
    expect(r.status).toBe(200);
    expect(r.json.cut.end_frame.image_id).toBe(String(first.image_id));

    r = await call('DELETE', `/api/cut/${cut._id}/end-frame`);
    expect(r.json.cut.end_frame.image_id).toBeNull();
    expect(r.json.cut.end_frame.prompt).toBe('The marquee.');
    expect(r.json.cut.start_frame.image_id).toBe(String(startImg));

    r = await call('POST', '/api/cuts/start-frames/generate', { beat_id: String(beat._id), frames: ['start', 'end'] });
    job = await waitFrames(r.json.job_id);
    expect(job).toMatchObject({ status: 'done', planned: 2, rendered: 1, skipped: 1, frames: ['start', 'end'] });

    r = await call('DELETE', `/api/cuts/start-frames?beat_id=${beat._id}&frames=end`);
    expect(r.json).toEqual({ cleared: 1 });
    const after = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(after.end_frame.image_id).toBeNull();
    expect(String(after.start_frame.image_id)).toBe(String(startImg));
  });
});

async function waitAssemble(id) {
  for (let i = 0; i < 500; i++) {
    const { json } = await call('GET', `/api/cuts/assemble/job/${id}`);
    if (json?.job && ['done', 'error'].includes(json.job.status)) return json.job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('assemble job never finished');
}

describe('assembled MP4s', () => {
  async function seedWithClips(beat, titles) {
    const rows = await seedScenes(beat);
    for (const key of titles) {
      await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: String(rows[key]._id), videoFileId: new ObjectId(), durationSeconds: 3 });
    }
    return rows;
  }

  it('POST /video-scenes/assemble validates, runs the job, and the beat exposes prompts_video_*', async () => {
    const { beat } = await seedBeat();
    const { s1 } = await seedWithClips(beat, ['c1', 'c3', 'loose']);
    expect((await call('POST', '/api/video-scenes/assemble', {})).status).toBe(400);
    expect((await call('POST', '/api/video-scenes/assemble', { beat_id: new ObjectId() })).status).toBe(404);
    // c2 (scene 1, cut 2) has no clip yet.
    const bad = await call('POST', '/api/video-scenes/assemble', { beat_id: beat._id });
    expect(bad.status).toBe(400);
    expect(bad.json.missing).toEqual(['1.2']);
    // Scene 2 alone is complete.
    const sceneBad = await call('POST', `/api/video-scene/${s1._id}/assemble`, {});
    expect(sceneBad.status).toBe(400);
    expect(sceneBad.json.missing).toEqual(['1.2']);

    await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: String((await seedScenesLookup(beat)).c2), videoFileId: new ObjectId(), durationSeconds: 3 });
    const r = await call('POST', '/api/video-scenes/assemble', { beat_id: beat._id });
    expect(r.status).toBe(202);
    const job = await waitAssemble(r.json.job_id);
    expect(job.status).toBe('done');
    expect(job.video_file_id).toBeTruthy();
    const listed = await call('GET', `/api/video-scenes?beat_id=${beat._id}`);
    expect(listed.json.beat.prompts_video_file_id).toBe(job.video_file_id);
    expect(listed.json.beat.prompts_video_duration_seconds).toBe(7.25);
    // The Storyboard tab's beat video is untouched.
    expect((await Plots.getBeat(projectId, String(beat._id))).video_file_id ?? null).toBeNull();

    const del = await call('DELETE', `/api/video-scenes/video?beat_id=${beat._id}`);
    expect(del.status).toBe(200);
    expect(del.json.beat.prompts_video_file_id).toBeNull();
    expect(deletedAttachments).toContain(job.video_file_id);
    expect((await call('DELETE', '/api/video-scenes/video')).status).toBe(400);
  });

  it('POST /video-scene/:id/assemble and DELETE /video-scene/:id/video', async () => {
    const { beat } = await seedBeat();
    const { s2 } = await seedWithClips(beat, ['c3']);
    expect((await call('POST', `/api/video-scene/${new ObjectId()}/assemble`, {})).status).toBe(404);
    const r = await call('POST', `/api/video-scene/${s2._id}/assemble`, {});
    expect(r.status).toBe(202);
    expect(r.json.scene_id).toBe(String(s2._id));
    const job = await waitAssemble(r.json.job_id);
    expect(job.status).toBe('done');
    expect(job.scene_id).toBe(String(s2._id));
    const listed = await call('GET', `/api/video-scenes?beat_id=${beat._id}`);
    const scene = listed.json.scenes.find((s) => s._id === String(s2._id));
    expect(scene.video_file_id).toBe(job.video_file_id);
    expect(scene.video_duration_seconds).toBe(7.25);
    const del = await call('DELETE', `/api/video-scene/${s2._id}/video`);
    expect(del.status).toBe(200);
    expect(del.json.scene.video_file_id).toBeNull();
    expect(deletedAttachments).toContain(job.video_file_id);
    expect((await call('GET', `/api/cuts/assemble/job/${new ObjectId()}`)).status).toBe(404);
    expect((await call('DELETE', `/api/video-scene/${new ObjectId()}/video`)).status).toBe(404);
  });

  it('409 while the beat is locked', async () => {
    const { beat } = await seedBeat();
    await seedWithClips(beat, ['c1', 'c2', 'c3', 'loose']);
    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((r) => { release = r; }));
    expect((await call('POST', '/api/video-scenes/assemble', { beat_id: beat._id })).status).toBe(409);
    release();
  });
});

describe('render beat (cuts → clips → beat MP4)', () => {
  it('POST /cuts/render/preview plans per cut and reports the provider state', async () => {
    const { beat } = await seedBeat();
    const rows = await seedScenes(beat);
    await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: String(rows.c3._id), videoFileId: new ObjectId(), durationSeconds: 3 });
    expect((await call('POST', '/api/cuts/render/preview', {})).status).toBe(400);
    expect((await call('POST', '/api/cuts/render/preview', { beat_id: new ObjectId() })).status).toBe(404);
    const bad = await call('POST', '/api/cuts/render/preview', { beat_id: beat._id, provider: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('UNKNOWN_PROVIDER');

    const r = await call('POST', '/api/cuts/render/preview', { beat_id: beat._id, provider: 'fal' });
    expect(r.status).toBe(200);
    expect(r.json.provider).toBe('fal');
    expect(r.json.comfy_configured).toBe(false);
    expect(r.json.comfy_disabled_reason).toMatch(/disabled on this server/);
    expect(r.json.fal_configured).toBe(false);
    expect(r.json.cuts.map((c) => c.label)).toEqual(['1.1', '1.2', '2.1', '#4']);
    // c1 has a prompt but no start frame prompt → blocked; c2/loose have no prompt; c3 already rendered.
    expect(r.json.cuts.map((c) => c.status)).toEqual(['blocked', 'skipped', 'skipped', 'skipped']);
    expect(r.json.cuts[2].skip_reason).toBe('already rendered');
    expect(r.json.counts).toMatchObject({ total: 4, to_render: 0, skipped: 3, blocked: 1 });
    expect(r.json.will_assemble).toBe(false);
    expect(r.json.models.clip.provider).toBe('fal');

    const comfy = await call('POST', '/api/cuts/render/preview', { beat_id: beat._id, provider: 'comfy' });
    expect(comfy.status).toBe(200);
    expect(comfy.json.models.lipsync.id).toBe('ltx-2.3-ia2v');
  });

  it('POST /cuts/render answers 503 for an unconfigured provider, 400 for a bad one; the job route 404s unknown ids', async () => {
    const { beat } = await seedBeat();
    await seedScenes(beat);
    expect((await call('POST', '/api/cuts/render', { beat_id: beat._id, provider: 'nope' })).status).toBe(400);
    const fal = await call('POST', '/api/cuts/render', { beat_id: beat._id, provider: 'fal' });
    expect(fal.status).toBe(503);
    expect(fal.json.code).toBe('FAL_NOT_CONFIGURED');
    const comfy = await call('POST', '/api/cuts/render', { beat_id: beat._id, provider: 'comfy' });
    expect(comfy.status).toBe(503);
    expect(comfy.json.error).toMatch(/ComfyUI rendering is disabled on this server/);
    expect((await call('GET', '/api/cuts/render/job/nope')).status).toBe(404);
  });
});

// Cut ids by title for a beat seeded through seedScenes.
async function seedScenesLookup(beat) {
  const rows = await VP.listVideoPrompts({ projectId, beatId: beat._id });
  return Object.fromEntries(rows.map((r) => [r.title, String(r._id)]));
}
