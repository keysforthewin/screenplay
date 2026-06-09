// HTTP routes for bulk start-frame generation + clear-all-images.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  deleteImage: vi.fn(async () => {}),
  deleteImages: vi.fn(async () => {}),
  uploadGeneratedImage: vi.fn(async ({ filename }) => ({
    _id: new ObjectId(), filename, contentType: 'image/png', metadata: {},
  })),
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(() => r())); });

beforeEach(() => {
  fakeDb.reset();
  BeatLocks._clearBeatLocksForTests();
  Generate._setImageDispatcherForTests(async () => ({
    buffer: Buffer.from('img'), contentType: 'image/png',
  }));
});
afterEach(() => Generate._setImageDispatcherForTests(null));

const post = (path, body) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = (path) => fetch(`${baseUrl}/api${path}`);

async function beatWithMissingStart() {
  const beat = await Plots.createBeat({ name: 'B', desc: '', body: '', characters: [] });
  const sb = await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'shot', shotType: 'cinematic_wide' });
  await Storyboards.addFrame(sb._id, {});
  return beat;
}

describe('POST /storyboards/generate-images', () => {
  it('400 when beat_id is missing', async () => {
    const r = await post('/storyboards/generate-images', {});
    expect(r.status).toBe(400);
  });
  it('404 for unknown beat', async () => {
    const r = await post('/storyboards/generate-images', { beat_id: new ObjectId().toString() });
    expect(r.status).toBe(404);
  });
  it('400 for an invalid image_model', async () => {
    const beat = await beatWithMissingStart();
    const r = await post('/storyboards/generate-images', { beat_id: beat._id.toString(), image_model: 'not-a-model' });
    expect(r.status).toBe(400);
  });
  it('202 with job_id + planned on success', async () => {
    const beat = await beatWithMissingStart();
    const r = await post('/storyboards/generate-images', { beat_id: beat._id.toString(), image_model: 'gemini-25-flash' });
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body.job_id).toBeTruthy();
    expect(body.planned).toBe(1);
  });
  it('409 when the beat is locked', async () => {
    const beat = await beatWithMissingStart();
    let release;
    const held = new Promise((r) => { release = r; });
    BeatLocks.withBeatLock(beat._id, () => held); // hold the lock
    try {
      const r = await post('/storyboards/generate-images', { beat_id: beat._id.toString() });
      expect(r.status).toBe(409);
    } finally {
      release();
      BeatLocks._clearBeatLocksForTests();
    }
  });
});

describe('GET /storyboards/generate-images/:jobId', () => {
  it('404 for an unknown job', async () => {
    const r = await get(`/storyboards/generate-images/${new ObjectId().toString()}`);
    expect(r.status).toBe(404);
  });
  it('returns the job for a real id', async () => {
    const beat = await beatWithMissingStart();
    const sub = await (await post('/storyboards/generate-images', { beat_id: beat._id.toString() })).json();
    const r = await get(`/storyboards/generate-images/${sub.job_id}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.job.job_id).toBe(sub.job_id);
  });
});

describe('POST /storyboards/clear-images', () => {
  it('400 when beat_id is missing', async () => {
    const r = await post('/storyboards/clear-images', {});
    expect(r.status).toBe(400);
  });
  it('clears images and returns counts', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: '', body: '', characters: [] });
    const sb = await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'shot' });
    await Storyboards.addFrame(sb._id, { imageId: new ObjectId() });
    const r = await post('/storyboards/clear-images', { beat_id: beat._id.toString() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cleared).toBe(1);
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.frames[0].image_id).toBe(null);
  });
});
