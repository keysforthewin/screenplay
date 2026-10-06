// The MCP server for coding agents (src/mcp/): the read tools hand over the
// beat text, dialogue, cast and artwork; the write tools build and edit the
// Scenes tab through the gateway; frames and clips arrive by URL, by copy or
// over the plain HTTP upload endpoint.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const broadcasts = [];
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn((room, payload) => broadcasts.push({ room, payload })),
  isHocuspocusRunning: () => false,
}));
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: async () => {}, deleteProjectChunks: async () => 0 }));

const store = new Map();
const deleted = [];
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  const fileOf = (id) => {
    const e = store.get(String(id));
    if (!e) return null;
    return {
      _id: new ObjectId(String(id)),
      filename: 'x.png',
      contentType: 'image/png',
      length: e.buffer.length,
      metadata: { project_id: e.projectId, owner_type: e.ownerType || null, description: e.description || '', generated_by: e.generatedBy || null },
    };
  };
  return {
    ...mod,
    findImageFile: vi.fn(async (id) => fileOf(id)),
    readImageBuffer: vi.fn(async (id) => (store.has(String(id)) ? { buffer: store.get(String(id)).buffer, file: fileOf(id) } : null)),
    uploadGeneratedImage: vi.fn(async (pid, args) => {
      const id = new ObjectId();
      store.set(id.toString(), { buffer: args.buffer, projectId: pid, ownerType: args.ownerType, generatedBy: args.generatedBy });
      return { _id: id, filename: args.filename };
    }),
    deleteImages: vi.fn(async (ids) => { for (const id of ids) deleted.push(String(id)); }),
    deleteImage: vi.fn(async (id) => { deleted.push(String(id)); }),
  };
});
vi.mock('../src/mongo/imageBytes.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchImageFromUrl: vi.fn(async (url) => ({ buffer: Buffer.from(`bytes of ${url}`), contentType: 'image/png' })),
}));

const attachments = new Map();
const deletedAttachments = [];
vi.mock('../src/mongo/attachments.js', async (importOriginal) => ({
  ...(await importOriginal()),
  uploadAttachmentBuffer: vi.fn(async (_pid, args) => {
    const id = new ObjectId();
    attachments.set(id.toString(), args);
    return { _id: id, filename: args.filename, content_type: args.contentType };
  }),
  uploadAttachmentFromUrl: vi.fn(async (_pid, args) => {
    const id = new ObjectId();
    attachments.set(id.toString(), args);
    return { _id: id, filename: 'clip.mp4', content_type: /\.mp4$/.test(args.sourceUrl) ? 'video/mp4' : 'text/html' };
  }),
  deleteAttachment: vi.fn(async (id) => { deletedAttachments.push(String(id)); }),
  deleteAttachments: vi.fn(async (ids) => { for (const id of ids) deletedAttachments.push(String(id)); }),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const { buildMcpServer } = await import('../src/mcp/tools.js');
const { buildMcpApp } = await import('../src/mcp/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

let projectId;
let beat;
let client;
let server;
let art;

function img(description, pid = projectId) {
  const id = new ObjectId();
  store.set(id.toString(), { buffer: Buffer.from(description), projectId: pid, description });
  return id;
}

// Call a tool; returns its parsed JSON (or throws the tool's error text).
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === 'text')?.text || '';
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

beforeEach(async () => {
  fakeDb.reset();
  store.clear();
  attachments.clear();
  deleted.length = 0;
  deletedAttachments.length = 0;
  broadcasts.length = 0;
  projectId = (await createProject('Heist'))._id.toString();
  art = { coat: img('Sarah, grey coat'), plate: img('Sarah, wardrobe plate'), upload: img('Sarah, phone snap'), diner: img('Diner, night') };
  await fakeDb.collection('characters').insertOne({
    _id: new ObjectId(), project_id: projectId, name: '**Sarah**', name_lower: 'sarah', hollywood_actor: '',
    fields: { wardrobe: 'grey wool coat', background: 'Safecracker.' },
    main_image_id: art.upload, wardrobe_image_id: art.plate,
    images: [{ _id: art.upload, filename: 'snap.jpg', caption: 'phone snap' }],
    artworks: [
      { _id: new ObjectId(), status: 'done', result_image_id: art.coat, name: 'Coat', description: 'grey coat', prompt: 'p1', model: 'm1' },
      { _id: new ObjectId(), status: 'done', result_image_id: art.plate, name: 'Plate', description: 'plate' },
      { _id: new ObjectId(), status: 'pending', result_image_id: null, name: 'Not yet' },
    ],
  });
  await fakeDb.collection('sets').insertOne({
    _id: new ObjectId(), project_id: projectId, name: 'Diner', name_lower: 'diner', description: 'Chrome and neon.',
    main_image_id: art.diner, images: [],
    artworks: [{ _id: new ObjectId(), status: 'done', result_image_id: art.diner, name: 'Night', description: 'night' }],
  });
  beat = await Plots.createBeat({
    projectId, name: 'The Diner', desc: 'They meet.', characters: ['Sarah'], sets: ['Diner'],
    body: 'INT. DINER - NIGHT\n\nSARAH\\\n(flat)\\\nCoffee.',
  });
  await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'Coffee.', character: 'SARAH', direction: 'flat' });

  server = buildMcpServer({ uploadBase: 'http://localhost:3002' });
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

describe('reading', () => {
  it('lists its tools and says how to upload a local file', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'list_projects', 'get_story', 'list_beats', 'get_beat', 'get_dialogue', 'get_cast', 'list_characters', 'list_sets',
      'list_artwork', 'list_reference_images', 'get_scenes', 'view_image', 'create_scene', 'update_scene', 'delete_scene',
      'reorder_scenes', 'create_cut', 'update_cut', 'delete_cut', 'reorder_cuts', 'set_frame_image', 'clear_frame_image',
      'undo_frame_image', 'set_cut_video', 'clear_cut_video', 'render_videos', 'get_video_batch', 'cancel_video_batch',
    ]));
    expect(client.getInstructions()).toContain('curl -T frame.png "http://localhost:3002/upload?cut_id=');
  });

  it('gives the beat as written, with its dialogue', async () => {
    const b = await call('get_beat', { beat: 1 });
    expect(b.body).toBe('INT. DINER - NIGHT\n\nSARAH\n(flat)\nCoffee.');
    expect(b.characters).toEqual(['Sarah']);
    expect(b.dialogue).toEqual([expect.objectContaining({ character: 'SARAH', direction: 'flat', line: 'Coffee.' })]);
    expect((await call('get_beat', { beat: 'The Diner', include_dialogue: false })).dialogue).toBeUndefined();
    expect((await call('get_dialogue', { project: 'heist', beat: '1' })).dialogue).toHaveLength(1);
  });

  it('counts what each beat already has', async () => {
    await call('create_scene', { beat: 1, title: 'A', cuts: [{ title: 'one' }, { title: 'two' }] });
    const { beats } = await call('list_beats');
    expect(beats[0]).toMatchObject({ order: 1, name: 'The Diner', scenes: 1, cuts: 2, dialogue_lines: 1 });
  });

  it('refuses an unknown project or beat instead of creating one', async () => {
    await expect(call('list_beats', { project: 'Nope' })).rejects.toThrow(/Unknown project "Nope".*"Heist"/);
    await expect(call('list_beats', { project: new ObjectId().toString() })).rejects.toThrow(/Unknown project/);
    await expect(call('get_beat', { beat: 9 })).rejects.toThrow(/Beat "9" not found/);
    expect(await fakeDb.collection('plots').find({}).toArray()).toHaveLength(1);
  });

  it('lists the cast and every picture of a character or a set', async () => {
    const cast = await call('get_cast', { beat: 1 });
    expect(cast.characters[0]).toMatchObject({ name: 'Sarah', wardrobe: 'grey wool coat', wardrobe_image_id: art.plate.toString() });
    expect(cast.sets[0]).toMatchObject({ name: 'Diner', description: 'Chrome and neon.' });

    expect((await call('list_characters')).characters.map((c) => c.name)).toEqual(['Sarah']);
    expect((await call('list_sets')).sets.map((s) => s.name)).toEqual(['Diner']);

    const sarah = await call('list_artwork', { character: 'Sarah' });
    expect(sarah.images.map((i) => [i.image_id, i.kind, i.roles])).toEqual([
      [art.coat.toString(), 'artwork', []],
      [art.plate.toString(), 'artwork', ['wardrobe_plate']],
      [art.upload.toString(), 'gallery', ['portrait']],
    ]);
    expect(sarah.images[0]).toMatchObject({ name: 'Coat', prompt: 'p1', url: expect.stringContaining(`/image/${art.coat}`) });
    const diner = await call('list_artwork', { set: 'diner' });
    expect(diner.images).toEqual([expect.objectContaining({ image_id: art.diner.toString(), roles: ['main'] })]);
    await expect(call('list_artwork', {})).rejects.toThrow(/exactly one/);
    await expect(call('list_artwork', { character: 'Bob' })).rejects.toThrow(/not found/);

    const pool = await call('list_reference_images', { beat: 1 });
    expect(pool.images.map((i) => i.image_id).sort()).toEqual([art.coat, art.plate, art.diner].map(String).sort());
  });

  it('shows an image as a picture', async () => {
    const id = new ObjectId();
    const png = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#336699' } }).png().toBuffer();
    store.set(id.toString(), { buffer: png, projectId, description: 'blue' });
    const res = await client.callTool({ name: 'view_image', arguments: { image_id: id.toString(), max_px: 512 } });
    const picture = res.content.find((c) => c.type === 'image');
    expect(picture.mimeType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(picture.data, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([512, 256]);
    await expect(call('view_image', { image_id: new ObjectId().toString() })).rejects.toThrow(/not found/);
  });
});

describe('scenes and cuts', () => {
  it('creates a whole scene in one call', async () => {
    const { scene } = await call('create_scene', {
      beat: 1,
      title: 'Counter',
      cuts: [
        {
          title: 'Wide', prompt: 'Slow push in.', duration_seconds: 4.2,
          start_frame_prompt: 'Sarah at the counter.', end_frame_prompt: 'Closer.',
          start_frame_reference_ids: [art.coat.toString(), art.diner.toString()],
        },
        { title: 'Insert', prompt: 'The cup.' },
      ],
    });
    expect(scene).toMatchObject({ order: 1, title: 'Counter' });
    expect(scene.cuts.map((c) => [c.label, c.title])).toEqual([['1.1', 'Wide'], ['1.2', 'Insert']]);
    expect(scene.cuts[0]).toMatchObject({
      duration_seconds: 4,
      prompt: 'Slow push in.',
      start_frame: { prompt: 'Sarah at the counter.', reference_ids: [art.coat.toString(), art.diner.toString()], image_id: null },
      end_frame: { prompt: 'Closer.', reference_ids: [] },
      video: null,
    });
    const stored = await call('get_scenes', { beat: 1 });
    expect(stored.scenes).toEqual([scene]);
    expect(broadcasts.some((b) => b.room === `video_prompts:${beat._id}`)).toBe(true);
  });

  it('writes nothing when one cut of the batch is wrong', async () => {
    const other = (await createProject('Other'))._id.toString();
    const foreign = img('someone else', other);
    await expect(
      call('create_scene', { beat: 1, title: 'X', cuts: [{ title: 'ok' }, { title: 'bad', end_frame_reference_ids: [foreign.toString()] }] }),
    ).rejects.toThrow(/belongs to another project/);
    await expect(
      call('create_scene', { beat: 1, cuts: [{ start_frame_reference_ids: [new ObjectId().toString()] }] }),
    ).rejects.toThrow(/not found/);
    expect((await call('get_scenes', { beat: 1 })).scenes).toEqual([]);
  });

  it('edits every field of a cut and only the ones passed', async () => {
    const { scene } = await call('create_scene', { beat: 1, title: 'S', cuts: [{ title: 'A', prompt: 'old', start_frame_prompt: 'sf' }] });
    const id = scene.cuts[0].id;
    const { cut } = await call('update_cut', {
      cut_id: id, prompt: 'new', duration_seconds: 6, end_frame_prompt: 'ef',
      start_frame_reference_ids: [art.diner.toString()], end_frame_reference_ids: [art.coat.toString()],
    });
    expect(cut).toMatchObject({
      title: 'A', prompt: 'new', duration_seconds: 6,
      start_frame: { prompt: 'sf', reference_ids: [art.diner.toString()] },
      end_frame: { prompt: 'ef', reference_ids: [art.coat.toString()] },
    });
    const row = await VP.getVideoPrompt(projectId, id);
    expect(row).toMatchObject({ title: 'A', prompt: 'new', duration_seconds: 6 });
    expect(row.start_frame.prompt).toBe('sf');
    expect(row.end_frame.prompt).toBe('ef');
    expect((await call('update_cut', { cut_id: id, duration_seconds: null })).cut.duration_seconds).toBeNull();
    expect((await call('update_cut', { cut_id: id, start_frame_reference_ids: [] })).cut.start_frame).toMatchObject({ prompt: 'sf', reference_ids: [] });
    await expect(call('update_cut', { cut_id: new ObjectId().toString(), title: 'x' })).rejects.toThrow(/not found/);
  });

  it('places, moves, reorders and deletes', async () => {
    const a = (await call('create_scene', { beat: 1, title: 'A', cuts: [{ title: 'a1' }, { title: 'a2' }] })).scene;
    const b = (await call('create_scene', { beat: 1, title: 'B', position: 1 })).scene;
    expect(b.order).toBe(1);
    const first = (await call('create_cut', { scene_id: a.id, title: 'a0', position: 1 })).cut;
    expect(first.label).toBe('2.1');
    expect((await call('update_cut', { cut_id: first.id, position: 3 })).cut.label).toBe('2.3');
    const reordered = (await call('reorder_cuts', { scene_id: a.id, ordered_ids: [first.id, a.cuts[1].id, a.cuts[0].id] })).scene;
    expect(reordered.cuts.map((c) => c.title)).toEqual(['a0', 'a2', 'a1']);
    await expect(call('reorder_cuts', { scene_id: a.id, ordered_ids: [first.id] })).rejects.toThrow(/reorder/);

    expect((await call('update_scene', { scene_id: a.id, title: 'A2', position: 1 })).scene).toMatchObject({ title: 'A2', order: 1 });
    expect((await VS.getVideoScene(projectId, a.id)).title).toBe('A2');
    const back = await call('reorder_scenes', { beat: 1, ordered_ids: [b.id, a.id] });
    expect(back.scenes.map((s) => s.title)).toEqual(['B', 'A2']);

    await call('delete_cut', { cut_id: first.id });
    expect((await call('get_scenes', { beat: 1 })).scenes[1].cuts.map((c) => c.label)).toEqual(['2.1', '2.2']);
    expect(await call('delete_scene', { scene_id: a.id })).toEqual({ deleted: true, cuts_removed: 2 });
    expect((await call('get_scenes', { beat: 1 })).scenes.map((s) => s.title)).toEqual(['B']);
  });
});

describe('frame images and clips', () => {
  async function oneCut() {
    const { scene } = await call('create_scene', { beat: 1, title: 'S', cuts: [{ title: 'A', start_frame_prompt: 'sf' }] });
    return scene.cuts[0].id;
  }

  it('stores a frame from a URL, keeps one undo, and follows the start frame on the end frame', async () => {
    const id = await oneCut();
    const one = (await call('set_frame_image', { cut_id: id, frame: 'start', image_url: 'https://x/1.png', model: 'flux' })).cut;
    expect(one.start_frame).toMatchObject({ prompt: 'sf', can_undo: false, model: 'flux' });
    expect(store.get(one.start_frame.image_id)).toMatchObject({ ownerType: 'beat', generatedBy: 'flux' });
    expect(store.get(one.start_frame.image_id).buffer.toString()).toBe('bytes of https://x/1.png');

    await call('update_cut', { cut_id: id, end_frame_reference_ids: [one.start_frame.image_id] });
    const two = (await call('set_frame_image', { cut_id: id, frame: 'start', image_url: 'https://x/2.png' })).cut;
    expect(two.start_frame.can_undo).toBe(true);
    expect(two.start_frame.image_id).not.toBe(one.start_frame.image_id);
    expect(two.end_frame.reference_ids).toEqual([two.start_frame.image_id]);

    const undone = (await call('undo_frame_image', { cut_id: id, frame: 'start' })).cut;
    expect(undone.start_frame).toMatchObject({ image_id: one.start_frame.image_id, can_undo: false });
    expect(undone.end_frame.reference_ids).toEqual([one.start_frame.image_id]);
    await expect(call('undo_frame_image', { cut_id: id, frame: 'start' })).rejects.toThrow(/no earlier image/);

    const cleared = (await call('clear_frame_image', { cut_id: id, frame: 'start' })).cut;
    expect(cleared.start_frame).toMatchObject({ image_id: null, prompt: 'sf' });
  });

  it('copies an existing image rather than sharing it', async () => {
    const id = await oneCut();
    const { cut } = await call('set_frame_image', { cut_id: id, frame: 'end', image_id: art.coat.toString() });
    expect(cut.end_frame.image_id).not.toBe(art.coat.toString());
    expect(store.get(cut.end_frame.image_id).buffer.toString()).toBe('Sarah, grey coat');
    await call('clear_frame_image', { cut_id: id, frame: 'end' });
    expect(deleted).not.toContain(art.coat.toString());
    await expect(call('set_frame_image', { cut_id: id, frame: 'end' })).rejects.toThrow(/exactly one/);
  });

  it('stores and replaces a clip from a URL', async () => {
    const id = await oneCut();
    const one = (await call('set_cut_video', { cut_id: id, video_url: 'https://x/a.mp4', duration_seconds: 5, model: 'kling' })).cut;
    expect(one.video).toMatchObject({ duration_seconds: 5, model: 'kling', url: expect.stringContaining('/attachment/') });
    const two = (await call('set_cut_video', { cut_id: id, video_url: 'https://x/b.mp4' })).cut;
    expect(deletedAttachments).toEqual([one.video.attachment_id]);
    await expect(call('set_cut_video', { cut_id: id, video_url: 'https://x/page' })).rejects.toThrow(/not a video/);
    expect((await call('clear_cut_video', { cut_id: id })).cut.video).toBeNull();
    expect(deletedAttachments).toContain(two.video.attachment_id);
  });
});

describe('render_videos', () => {
  let started;
  beforeEach(async () => {
    const Batch = await import('../src/web/cutVideoBatch.js');
    Batch._resetCutBatchesForTests();
    started = [];
    const factory = async (opts) => ({
      opts,
      preflight: async () => {},
      start: async (cutId) => { started.push({ cutId, modelId: opts.modelId, params: opts.params }); return { job_id: `job-${cutId}` }; },
      get: () => ({ status: 'done' }),
      subscribe: (_jobId, cb) => { setTimeout(() => cb({ status: 'done' }), 5); },
      unsubscribe: () => {},
      cancel: async () => {},
    });
    Batch._setCutBatchProvidersForTests({ comfy: factory, fal: factory }, { pollMs: 10 });
  });
  afterEach(async () => {
    const Batch = await import('../src/web/cutVideoBatch.js');
    Batch._setCutBatchProvidersForTests(null);
    Batch._resetCutBatchesForTests();
  });

  async function readyCut() {
    const scene = (await call('create_scene', { beat: beat.order, title: 'S' })).scene;
    const cut = (await call('create_cut', { scene_id: scene.id, prompt: 'A clip.' })).cut;
    await call('set_frame_image', { cut_id: cut.id, frame: 'start', image_id: img('start').toString() });
    await call('set_frame_image', { cut_id: cut.id, frame: 'end', image_id: img('end').toString() });
    return cut;
  }

  it('refuses to pick a model: no default set → an error naming the Admin page', async () => {
    await readyCut();
    await expect(call('render_videos', { beat: beat.order })).rejects.toThrow(/Admin → Video renderer/);
    expect((await call('get_video_batch', { beat: beat.order })).batch).toBeNull();
  });

  it('renders every ready cut with the admin default when no model is named', async () => {
    const cut = await readyCut();
    const Settings = await import('../src/mongo/appSettings.js');
    await Settings.setVideoDefaultSettings({ provider: 'comfy', model_id: 'wan-2.2-14b-flf2v', params: { steps: 20 } });
    const r = await call('render_videos', { beat: beat.order });
    expect(r.renderer).toEqual({ provider: 'comfy', model_id: 'wan-2.2-14b-flf2v', from_default: true });
    expect(r.batch.items.map((it) => it.cut_id)).toEqual([cut.id]);
    await new Promise((res) => setTimeout(res, 60));
    expect(started).toEqual([{ cutId: cut.id, modelId: 'wan-2.2-14b-flf2v', params: { steps: 20 } }]);
    const g = await call('get_video_batch', { beat: beat.order });
    expect(g.batch.status).toBe('done');
    expect(g.default_renderer.model_id).toBe('wan-2.2-14b-flf2v');
  });

  it('an explicit model is kept as given', async () => {
    await readyCut();
    const r = await call('render_videos', { beat: beat.order, provider: 'comfy', model_id: 'ltx-2.5-i2v' });
    expect(r.renderer).toMatchObject({ model_id: 'ltx-2.5-i2v', from_default: false });
  });
});

describe('HTTP', () => {
  let http;
  let base;
  beforeEach(async () => {
    http = buildMcpApp().listen(0, '127.0.0.1');
    await new Promise((r) => http.once('listening', r));
    base = `http://127.0.0.1:${http.address().port}`;
  });
  afterEach(() => new Promise((r) => http.close(r)));

  it('takes a local file as a frame or a clip', async () => {
    const { scene } = await call('create_scene', { beat: 1, title: 'S', cuts: [{ title: 'A' }] });
    const id = scene.cuts[0].id;
    const put = (query, body) => fetch(`${base}/upload?${query}`, { method: 'PUT', body }).then(async (r) => [r.status, await r.json()]);

    const [status, out] = await put(`cut_id=${id}&target=end_frame&model=local`, Buffer.from('png bytes'));
    expect(status).toBe(200);
    expect(store.get(out.cut.end_frame.image_id).buffer.toString()).toBe('png bytes');
    expect(out.cut.end_frame.model).toBe('local');

    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
    const [vs, video] = await put(`cut_id=${id}&target=video&duration_seconds=3`, mp4);
    expect(vs).toBe(200);
    expect(video.cut.video.duration_seconds).toBe(3);
    expect(attachments.get(video.cut.video.attachment_id).contentType).toBe('video/mp4');

    expect((await put(`cut_id=${id}&target=video`, Buffer.from('not a video')))[0]).toBe(400);
    expect((await put(`cut_id=${id}`, Buffer.from('x')))[1].error).toMatch(/target is required/);
    expect((await put(`cut_id=${new ObjectId()}&target=start_frame`, Buffer.from('x')))[0]).toBe(400);
  });

  it('speaks MCP over HTTP without a session and refuses a foreign Host', async () => {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const remote = new Client({ name: 'http-test', version: '1' });
    await remote.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const res = await remote.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.parse(res.content[0].text).projects).toEqual([{ id: projectId, title: 'Heist' }]);
    expect(remote.getInstructions()).toContain(`${base}/upload`);
    await remote.close();

    const { request } = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = request(`${base}/health`, { headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
