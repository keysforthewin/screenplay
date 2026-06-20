// HTTP-layer tests for the image-sheet routes:
//   POST /api/:host/:id/image-sheet   (character + beat)
//   GET  /api/image-sheet/:jobId       (poll)
// The real route → real engine runs through a mocked FAL provider (same
// approach as imageSheetJobs.test.js).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
const h = vi.hoisted(() => ({ configured: true }));

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
  uploadGeneratedImage: vi.fn(async (_p, { filename, contentType }) => ({
    _id: new ObjectId(),
    filename,
    content_type: contentType || 'image/png',
    size: 1024,
    uploaded_at: new Date(),
  })),
  findImageFile: vi.fn(async () => null),
  deleteImage: vi.fn(async () => {}),
}));
vi.mock('../src/fal/client.js', () => ({ isConfigured: () => h.configured }));
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
  generateNanoBananaProImage: async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' }),
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
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const Planner = await import('../src/web/beatSheetPlanner.js');
const Sheet = await import('../src/web/imageSheetJobs.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  h.configured = true;
  Planner._setSceneImagePlannerForTests(async () => ({ images: [{ name: 'Plate', prompt: 'wide empty set' }] }));
});

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}

async function drain(jobId, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Sheet.getImageSheetJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

describe('POST /api/:host/:id/image-sheet', () => {
  it('starts a character sheet job and returns 202 with the planned count', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae', hollywood_actor: 'Zendaya' });
    const { status, json } = await postJson(`/api/character/${c._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
      shot_count: 2,
    });
    expect(status).toBe(202);
    expect(json.job_id).toBeTruthy();
    expect(json.planned).toBe(2);
    expect(json.host_type).toBe('character');
    await drain(json.job_id);
  });

  it('starts a beat sheet job and returns 202 (planned unknown until planned)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Alley', body: 'INT. ALLEY - NIGHT' });
    const { status, json } = await postJson(`/api/beat/${beat._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
      shot_count: 6,
    });
    expect(status).toBe(202);
    expect(json.job_id).toBeTruthy();
    expect(json.planned == null).toBe(true);
    expect(json.host_type).toBe('beat');
    await drain(json.job_id);
  });

  it('400s on an unknown model', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'V', hollywood_actor: 'Z' });
    const { status } = await postJson(`/api/character/${c._id.toString()}/image-sheet`, { model: 'bogus' });
    expect(status).toBe(400);
  });

  it('404s on a missing host', async () => {
    const { status } = await postJson(`/api/character/${new ObjectId().toString()}/image-sheet`, {
      model: 'nano-banana-pro',
    });
    expect(status).toBe(404);
  });

  it('400s when FAL is not configured for a FAL model', async () => {
    h.configured = false;
    const c = await Characters.createCharacter({ projectId, name: 'NoKey', hollywood_actor: 'Z' });
    const { status } = await postJson(`/api/character/${c._id.toString()}/image-sheet`, { model: 'nano-banana-pro' });
    expect(status).toBe(400);
  });

  it('accepts shot_names and plans exactly that many', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Pick', hollywood_actor: 'Z' });
    const { json: list } = await getJson('/api/character-sheet-shots');
    const names = [list.shots[0].name, list.shots.find((s) => /back of head/i.test(s.name)).name];
    const { status, json } = await postJson(`/api/character/${c._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
      shot_names: names,
    });
    expect(status).toBe(202);
    expect(json.planned).toBe(2);
    await drain(json.job_id);
  });
});

describe('GET /api/character-sheet-shots', () => {
  it('returns the canonical character shot list', async () => {
    const { status, json } = await getJson('/api/character-sheet-shots');
    expect(status).toBe(200);
    expect(Array.isArray(json.shots)).toBe(true);
    expect(json.shots.length).toBeGreaterThanOrEqual(8);
    expect(typeof json.shots[0].name).toBe('string');
  });
});

describe('GET /api/image-sheet/:jobId', () => {
  it('returns the job for a known id and 404 for an unknown one', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae', hollywood_actor: 'Z' });
    const { json: started } = await postJson(`/api/character/${c._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
      shot_count: 2,
    });
    const { status, json } = await getJson(`/api/image-sheet/${started.job_id}`);
    expect(status).toBe(200);
    expect(json.job.job_id).toBe(started.job_id);
    expect(json.job.host_type).toBe('character');

    const { status: missing } = await getJson(`/api/image-sheet/${new ObjectId().toString()}`);
    expect(missing).toBe(404);
    await drain(started.job_id);
  });
});
