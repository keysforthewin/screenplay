// REST endpoints for the playground page: model listing, reference upload,
// generate kickoff (error mapping), ref deletion ownership guards, and the
// SSE job stream's auth/registration.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => {
    req.session = { session_id: 'sid1', username: 'tester' };
    next();
  },
}));
vi.mock('../src/mongo/auth.js', () => ({
  getSession: async (sid) => (sid === 'sid1' ? { session_id: 'sid1', username: 'tester' } : null),
  touchSession: async () => {},
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CANNED_CATALOG = {
  generated_at: '2026-08-01T00:00:00.000Z',
  models: [{
    endpoint_id: 'test/t2i',
    display_name: 'Test T2I',
    output: { kind: 'image', path: 'images[0].url' },
    inputs: {
      prompt: 'required', prompt_param: 'prompt',
      image: { need: 'unused', params: [], required_count: 0, max: 0 },
      audio: { need: 'unused', param: null, list: false },
      video: { need: 'unused', param: null, list: false },
    },
    defaults: {},
    price_text: '$0.01 per image', price_min_usd: 0.01,
  }],
};
vi.mock('../src/fal/playgroundModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadPlaygroundCatalog: vi.fn(async () => CANNED_CATALOG),
}));

const uploadedImages = [];
const deletedImages = [];
let imageFiles = new Map(); // id → file doc
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  uploadGeneratedImage: vi.fn(async (_projectId, args) => {
    const file = { _id: new ObjectId(), filename: 'up.png', content_type: args.contentType, size: args.buffer.length };
    uploadedImages.push({ ...args, projectId: _projectId });
    return file;
  }),
  findImageFile: vi.fn(async (id) => imageFiles.get(String(id)) || null),
  deleteImage: vi.fn(async (id) => { deletedImages.push(String(id)); }),
}));

const uploadedAttachments = [];
const deletedAttachments = [];
let attachmentFiles = new Map();
vi.mock('../src/mongo/attachments.js', async (importOriginal) => ({
  ...(await importOriginal()),
  uploadAttachmentBuffer: vi.fn(async (_projectId, args) => {
    const file = { _id: new ObjectId(), filename: args.filename, content_type: args.contentType, size: args.buffer.length };
    uploadedAttachments.push({ ...args, projectId: _projectId });
    return file;
  }),
  findAttachmentFile: vi.fn(async (id) => attachmentFiles.get(String(id)) || null),
  deleteAttachment: vi.fn(async (id) => { deletedAttachments.push(String(id)); }),
}));

let generateImpl = async () => ({ job_id: 'job-1' });
let sseJob = null;
vi.mock('../src/web/playgroundGenerate.js', () => ({
  startPlaygroundJob: vi.fn((args) => generateImpl(args)),
  getPlaygroundJob: vi.fn(() => sseJob),
  subscribeToPlaygroundJob: vi.fn(),
  unsubscribeFromPlaygroundJob: vi.fn(),
  serializePlaygroundJob: vi.fn((job) => job),
}));

const Projects = await import('../src/mongo/projects.js');
const PlaygroundGen = await import('../src/web/playgroundGenerate.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r()));
});
beforeEach(() => {
  fakeDb.reset();
  uploadedImages.length = 0;
  uploadedAttachments.length = 0;
  deletedImages.length = 0;
  deletedAttachments.length = 0;
  imageFiles = new Map();
  attachmentFiles = new Map();
  generateImpl = async () => ({ job_id: 'job-1' });
  sseJob = null;
});

const getJson = async (path) => {
  const r = await fetch(`${baseUrl}/api${path}`);
  return { status: r.status, body: await r.json() };
};
const postJson = async (path, body) => {
  const r = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const uploadFile = async (bytes, type, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  const r = await fetch(`${baseUrl}/api/playground/upload`, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json() };
};

describe('GET /api/playground/models', () => {
  it('returns configured flag, catalog metadata, and the model list', async () => {
    const { status, body } = await getJson('/playground/models');
    expect(status).toBe(200);
    expect(typeof body.configured).toBe('boolean');
    expect(body.catalog_generated_at).toBe('2026-08-01T00:00:00.000Z');
    expect(body.models).toHaveLength(1);
    expect(body.models[0].endpoint_id).toBe('test/t2i');
  });
});

describe('GET /api/playground/history', () => {
  // Seeds GridFS file docs straight into the fake — the listers run real
  // queries against these collections (only the upload/delete helpers are
  // mocked above).
  async function seedHistory() {
    const project = await Projects.getDefaultProject();
    const pid = project._id.toString();
    const imgCol = fakeDb.collection('images.files');
    const attCol = fakeDb.collection('attachments.files');
    const ids = { img: new ObjectId(), vid: new ObjectId(), legacy: new ObjectId() };
    await imgCol.insertOne({
      _id: ids.img, filename: 'generated-3.png', length: 100, contentType: 'image/png',
      uploadDate: new Date('2026-08-02T03:00:00Z'),
      metadata: { project_id: pid, owner_type: 'playground', source: 'generated', generated_by: 'test/t2i', prompt: 'a fish' },
    });
    await imgCol.insertOne({ // thumbnail of an output — excluded
      _id: new ObjectId(), filename: 'thumb.png', length: 5, contentType: 'image/png',
      uploadDate: new Date('2026-08-02T03:00:01Z'),
      metadata: { project_id: pid, owner_type: 'playground', generated_by: 'test/t2i', kind: 'thumbnail' },
    });
    await imgCol.insertOne({ // image reference upload — excluded (no generated_by)
      _id: new ObjectId(), filename: 'my-photo.png', length: 50, contentType: 'image/png',
      uploadDate: new Date('2026-08-02T02:30:00Z'),
      metadata: { project_id: pid, owner_type: 'playground', source: 'generated', generated_by: null, prompt: null },
    });
    await imgCol.insertOne({ // another project's output — excluded
      _id: new ObjectId(), filename: 'other.png', length: 50, contentType: 'image/png',
      uploadDate: new Date('2026-08-02T02:00:00Z'),
      metadata: { project_id: new ObjectId().toString(), owner_type: 'playground', generated_by: 'test/t2i' },
    });
    await attCol.insertOne({ // video output with generated_by stamped
      _id: ids.vid, filename: 'playground-1754000000000.mp4', length: 999, contentType: 'video/mp4',
      uploadDate: new Date('2026-08-02T02:45:00Z'),
      metadata: { project_id: pid, owner_type: 'playground', content_type: 'video/mp4', generated_by: 'test/i2v', prompt: 'move it' },
    });
    await attCol.insertOne({ // legacy output: no generated_by, playground-<ts> filename
      _id: ids.legacy, filename: 'playground-1753000000000.mp4', length: 500, contentType: 'video/mp4',
      uploadDate: new Date('2026-08-01T01:00:00Z'),
      metadata: { project_id: pid, owner_type: 'playground', content_type: 'video/mp4', source: 'upload' },
    });
    await attCol.insertOne({ // audio reference upload — excluded
      _id: new ObjectId(), filename: 'song.mp3', length: 300, contentType: 'audio/mpeg',
      uploadDate: new Date('2026-08-02T01:00:00Z'),
      metadata: { project_id: pid, owner_type: 'playground', content_type: 'audio/mpeg', source: 'upload' },
    });
    return ids;
  }

  it('lists generated outputs newest-first, excluding refs, thumbnails, and other projects', async () => {
    const ids = await seedHistory();
    const { status, body } = await getJson('/playground/history');
    expect(status).toBe(200);
    expect(body.items.map((i) => i.file_id)).toEqual([ids.img, ids.vid, ids.legacy].map(String));
    expect(body.items[0]).toMatchObject({
      kind: 'image', model: 'test/t2i', prompt: 'a fish',
      content_type: 'image/png', size: 100, filename: 'generated-3.png',
    });
    expect(body.items[0].created_at).toBeTruthy();
    expect(body.items[1].kind).toBe('video');
    expect(body.items[2]).toMatchObject({ kind: 'video', model: null, prompt: null });
  });

  it('respects the limit query param', async () => {
    await seedHistory();
    const { body } = await getJson('/playground/history?limit=1');
    expect(body.items).toHaveLength(1);
  });
});

describe('POST /api/playground/upload', () => {
  it('stores an image in the images bucket tagged playground', async () => {
    const { status, body } = await uploadFile([1, 2, 3], 'image/png', 'ref.png');
    expect(status).toBe(200);
    expect(body.ref.kind).toBe('image');
    expect(body.ref.file_id).toMatch(/^[a-f0-9]{24}$/);
    expect(uploadedImages).toHaveLength(1);
    expect(uploadedImages[0].ownerType).toBe('playground');
  });

  it('stores audio and video in the attachments bucket', async () => {
    const audio = await uploadFile([1], 'audio/mpeg', 'a.mp3');
    expect(audio.status).toBe(200);
    expect(audio.body.ref.kind).toBe('audio');
    const video = await uploadFile([1], 'video/mp4', 'v.mp4');
    expect(video.body.ref.kind).toBe('video');
    expect(uploadedAttachments).toHaveLength(2);
    expect(uploadedAttachments.every((u) => u.ownerType === 'playground')).toBe(true);
  });

  it('rejects non-media mimetypes with 400', async () => {
    const { status, body } = await uploadFile([1], 'application/pdf', 'x.pdf');
    expect(status).toBe(400);
    expect(body.error).toMatch(/image, audio, or video/i);
  });
});

describe('POST /api/playground/generate', () => {
  it('returns 202 with the job id and threads project id and options', async () => {
    let seenArgs;
    generateImpl = async (args) => { seenArgs = args; return { job_id: 'job-9' }; };
    const { status, body } = await postJson('/playground/generate', {
      model_id: 'test/t2i', prompt: 'hi', refs: [], options: { image_size: 'square_hd' },
    });
    expect(status).toBe(202);
    expect(body.job_id).toBe('job-9');
    expect(seenArgs.modelId).toBe('test/t2i');
    expect(seenArgs.projectId).toMatch(/^[a-f0-9]{24}$/);
    expect(seenArgs.options).toEqual({ image_size: 'square_hd' });
  });

  it('maps typed generate errors to HTTP statuses', async () => {
    generateImpl = async () => { throw Object.assign(new Error('nope'), { code: 'UNKNOWN_MODEL' }); };
    expect((await postJson('/playground/generate', { model_id: 'x' })).status).toBe(404);
    generateImpl = async () => {
      throw Object.assign(new Error('missing'), { code: 'MISSING_INPUTS', missing: ['prompt'] });
    };
    const missing = await postJson('/playground/generate', { model_id: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body.missing).toEqual(['prompt']);
    generateImpl = async () => { throw Object.assign(new Error('no key'), { code: 'FAL_NOT_CONFIGURED' }); };
    expect((await postJson('/playground/generate', { model_id: 'x' })).status).toBe(503);
    generateImpl = async () => {
      throw Object.assign(new Error('bad size'), { code: 'BAD_OPTIONS', errors: ['image_size must be one of: square_hd'] });
    };
    const bad = await postJson('/playground/generate', { model_id: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toHaveLength(1);
  });
});

describe('DELETE /api/playground/ref/:kind/:id', () => {
  it('deletes an owned playground image', async () => {
    const project = await Projects.getDefaultProject();
    const id = new ObjectId().toString();
    imageFiles.set(id, { _id: new ObjectId(id), metadata: { project_id: project._id.toString(), owner_type: 'playground' } });
    const r = await fetch(`${baseUrl}/api/playground/ref/image/${id}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(deletedImages).toEqual([id]);
  });

  it('404s for cross-project or non-playground files', async () => {
    const id = new ObjectId().toString();
    imageFiles.set(id, { _id: new ObjectId(id), metadata: { project_id: new ObjectId().toString(), owner_type: 'playground' } });
    const cross = await fetch(`${baseUrl}/api/playground/ref/image/${id}`, { method: 'DELETE' });
    expect(cross.status).toBe(404);

    const project = await Projects.getDefaultProject();
    const id2 = new ObjectId().toString();
    attachmentFiles.set(id2, { _id: new ObjectId(id2), metadata: { project_id: project._id.toString(), owner_type: 'beat' } });
    const wrongOwner = await fetch(`${baseUrl}/api/playground/ref/audio/${id2}`, { method: 'DELETE' });
    expect(wrongOwner.status).toBe(404);
    expect(deletedImages).toEqual([]);
    expect(deletedAttachments).toEqual([]);
  });
});

describe('GET /api/playground/job/:jobId/events', () => {
  it('401s without a session id (registered before requireSession)', async () => {
    const r = await fetch(`${baseUrl}/api/playground/job/abc/events`);
    expect(r.status).toBe(401);
  });

  it('404s for an unknown job with a valid session', async () => {
    const r = await fetch(`${baseUrl}/api/playground/job/abc/events?session_id=sid1`);
    expect(r.status).toBe(404);
  });

  it('streams the snapshot and closes for a terminal job', async () => {
    sseJob = { job_id: 'j1', status: 'done', outputs: [{ kind: 'image', file_id: 'f1' }] };
    const r = await fetch(`${baseUrl}/api/playground/job/j1/events?session_id=sid1`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await r.text();
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"job_id":"j1"');
  });
});
