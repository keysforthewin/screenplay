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

const catalogGenerateMock = vi.hoisted(() => vi.fn());
vi.mock('../src/fal/catalogImageGenerate.js', () => ({
  generateCatalogImage: (...a) => catalogGenerateMock(...a),
}));
vi.mock('../src/fal/imageModelCatalog.js', () => ({
  getImageModel: async (id) =>
    id === 'fal-ai/some-catalog-model' ? { id, endpoint_id: 'fal-ai/some-catalog-model' } : null,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const Sets = await import('../src/mongo/sets.js');
const Planner = await import('../src/web/beatSheetPlanner.js');
const Sheet = await import('../src/web/imageSheetJobs.js');
const Images = await import('../src/mongo/images.js');
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
  Planner._setScenePlatePlannerForTests(async () => ([{ name: 'Plate', prompt: 'wide empty set', justification: 'establishes', quote: 'INT. SET' }]));
  Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
  Images.findImageFile.mockImplementation(async () => null);
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

  it('renders an explicit beat shot list and returns 202 with the planned count', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Alley', body: 'INT. ALLEY - NIGHT' });
    const { status, json } = await postJson(`/api/beat/${beat._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
      shots: [
        { name: 'Alley — wide', prompt: 'wide empty rain-slick alley' },
        { name: 'Brick — insert', prompt: 'wet brick texture' },
      ],
    });
    expect(status).toBe(202);
    expect(json.job_id).toBeTruthy();
    expect(json.planned).toBe(2);
    expect(json.host_type).toBe('beat');
    await drain(json.job_id);
  });

  it('400s a beat image-sheet with no shots', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'NoShots', body: 'INT. X' });
    const { status } = await postJson(`/api/beat/${beat._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
    });
    expect(status).toBe(400);
  });

  it('400s on an unknown model', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'V', hollywood_actor: 'Z' });
    const { status } = await postJson(`/api/character/${c._id.toString()}/image-sheet`, { model: 'bogus' });
    expect(status).toBe(400);
  });

  it('accepts a fal catalog endpoint id and renders through the catalog runner', async () => {
    catalogGenerateMock.mockReset();
    catalogGenerateMock.mockResolvedValue({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
      model: 'fal-ai/some-catalog-model',
    });
    const beat = await Plots.createBeat({ projectId, name: 'Cat', body: 'INT. CAT - DAY' });
    const { status, json } = await postJson(`/api/beat/${beat._id.toString()}/image-sheet`, {
      model: 'fal-ai/some-catalog-model',
      shots: [{ name: 'Cat — wide', prompt: 'wide catwalk' }],
    });
    expect(status).toBe(202);
    const job = await drain(json.job_id);
    expect(job.status).toBe('done');
    expect(catalogGenerateMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: 'fal-ai/some-catalog-model' }),
    );
  });

  it('400s a catalog model when FAL is not configured', async () => {
    h.configured = false;
    const beat = await Plots.createBeat({ projectId, name: 'NoFal', body: 'INT. X' });
    const { status, json } = await postJson(`/api/beat/${beat._id.toString()}/image-sheet`, {
      model: 'fal-ai/some-catalog-model',
      shots: [{ name: 'S', prompt: 'p' }],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/FAL_KEY/);
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

describe('POST /api/beat/:id/shot-plan', () => {
  it('starts a derive job and the poll reaches "derived" with shots', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Alley', body: 'INT. ALLEY - NIGHT' });
    const { status, json } = await postJson(`/api/beat/${beat._id.toString()}/shot-plan`, {
      reference_image_ids: [],
    });
    expect(status).toBe(202);
    expect(json.job_id).toBeTruthy();

    let job = null;
    const start = Date.now();
    while (Date.now() - start < 4000) {
      const r = await getJson(`/api/image-sheet/${json.job_id}`);
      job = r.json.job;
      if (job && ['derived', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job.status).toBe('derived');
    expect(job.kind).toBe('beat_plan');
    expect(Array.isArray(job.shots)).toBe(true);
    expect(job.shots[0].name).toBe('Plate');
    expect(typeof job.shots[0].prompt).toBe('string');
    expect(job.shots[0].prompt.length).toBeGreaterThan(0);
    expect(job.shots[0]).toHaveProperty('justification');
    expect(job.shots[0]).toHaveProperty('quote');
  });

  it('404s on a missing beat', async () => {
    const { status } = await postJson(`/api/beat/${new ObjectId().toString()}/shot-plan`, {});
    expect(status).toBe(404);
  });

  it('threads direction + previous_plates through to the planner (re-derive)', async () => {
    let p1args = null;
    Planner._setScenePlatePlannerForTests(async (args) => {
      p1args = args;
      return [{ name: 'Revised', prompt: 'revised plate', justification: 'x', quote: 'INT. ALLEY - NIGHT' }];
    });
    const beat = await Plots.createBeat({ projectId, name: 'Rev', body: 'INT. ALLEY - NIGHT' });
    const { status, json } = await postJson(`/api/beat/${beat._id.toString()}/shot-plan`, {
      direction: 'grittier, fewer wides',
      previous_plates: [{ name: 'Old', prompt: 'old plate' }],
    });
    expect(status).toBe(202);
    let job = null;
    const start = Date.now();
    while (Date.now() - start < 4000) {
      const r = await getJson(`/api/image-sheet/${json.job_id}`);
      job = r.json.job;
      if (job && ['derived', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job.status).toBe('derived');
    expect(p1args.direction).toBe('grittier, fewer wides');
    expect(p1args.previousPlates).toEqual([{ name: 'Old', prompt: 'old plate' }]);
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

describe('POST /api/set/:id/image-sheet with reference_set_ids', () => {
  it('renders the shots with the linked galleries as references', async () => {
    Images.findImageFile.mockImplementation(async () => ({ _id: 'exists' }));
    Images.readImageBuffer.mockImplementation(async () => ({
      buffer: Buffer.from('ref'),
      file: { contentType: 'image/png', metadata: {} },
    }));
    const set = await Sets.createSet({ projectId, name: 'Sky2' });
    const other = await Sets.createSet({ projectId, name: 'Rooftop2' });
    const o1 = new ObjectId();
    await Sets.pushSetImage(projectId, other._id.toString(), { _id: o1 });

    const { status, json } = await postJson(`/api/set/${set._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
      shots: [{ name: 'Sky — wide', prompt: 'endless sky' }],
      reference_set_ids: [other._id.toString()],
    });
    expect(status).toBe(202);
    const job = await drain(json.job_id);
    expect(job.status).toBe('done');
    expect(job.reference_set_ids).toEqual([other._id.toString()]);
    const fresh = await Sets.getSet(projectId, set._id.toString());
    expect(fresh.artworks[0].reference_image_ids.map(String)).toEqual([o1.toString()]);
  });

  it('400s a non-array reference_set_ids', async () => {
    const set = await Sets.createSet({ projectId, name: 'Sky3' });
    const { status } = await postJson(`/api/set/${set._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
      shots: [{ name: 'A', prompt: 'a' }],
      reference_set_ids: 42,
    });
    expect(status).toBe(400);
  });
});

describe('POST /api/set/:id/shot-plan with beat_ids', () => {
  it('threads the selected beats into the planner context', async () => {
    let plannerBeat = null;
    Planner._setScenePlatePlannerForTests(async (args) => {
      plannerBeat = args.beat;
      return [{ name: 'Plate', prompt: 'p', justification: '', quote: '' }];
    });
    const set = await Sets.createSet({ projectId, name: 'Alley', description: 'SET DESC HERE' });
    const b1 = await Plots.createBeat({ projectId, name: 'One', body: 'CHOSEN BEAT TEXT', sets: ['Alley'] });
    await Plots.createBeat({ projectId, name: 'Two', body: 'OTHER BEAT TEXT', sets: ['Alley'] });

    const { status, json } = await postJson(`/api/set/${set._id.toString()}/shot-plan`, {
      beat_ids: [b1._id.toString()],
    });
    expect(status).toBe(202);
    let job = null;
    const start = Date.now();
    while (Date.now() - start < 4000) {
      const r = await getJson(`/api/image-sheet/${json.job_id}`);
      job = r.json.job;
      if (job && ['derived', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job.status).toBe('derived');
    expect(job.beat_ids).toEqual([b1._id.toString()]);
    expect(plannerBeat.body).toContain('SET DESC HERE');
    expect(plannerBeat.body).toContain('CHOSEN BEAT TEXT');
    expect(plannerBeat.body).not.toContain('OTHER BEAT TEXT');
  });

  it('splits main beat from context beats in the planner body', async () => {
    let plannerBeat = null;
    Planner._setScenePlatePlannerForTests(async (args) => {
      plannerBeat = args.beat;
      return [{ name: 'Plate', prompt: 'p', justification: '', quote: '' }];
    });
    const set = await Sets.createSet({ projectId, name: 'Sky', description: 'SET DESC HERE' });
    const b1 = await Plots.createBeat({ projectId, name: 'One', body: 'MAIN BEAT TEXT HERE', sets: ['Sky'] });
    const b2 = await Plots.createBeat({ projectId, name: 'Two', body: 'CONTEXT BEAT TEXT HERE', sets: ['Sky'] });

    const { status, json } = await postJson(`/api/set/${set._id.toString()}/shot-plan`, {
      main_beat_id: b1._id.toString(),
      beat_ids: [b2._id.toString()],
    });
    expect(status).toBe(202);
    let job = null;
    const start = Date.now();
    while (Date.now() - start < 4000) {
      const r = await getJson(`/api/image-sheet/${json.job_id}`);
      job = r.json.job;
      if (job && ['derived', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job.status).toBe('derived');
    expect(job.main_beat_id).toBe(b1._id.toString());
    const body = plannerBeat.body;
    const mainIdx = body.indexOf('## MAIN BEAT');
    const ctxIdx = body.indexOf('## Context beats');
    expect(mainIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeGreaterThan(mainIdx);
    expect(body.indexOf('MAIN BEAT TEXT HERE')).toBeLessThan(ctxIdx);
    expect(body.indexOf('CONTEXT BEAT TEXT HERE')).toBeGreaterThan(ctxIdx);
  });

  it('400s a malformed main_beat_id', async () => {
    const set = await Sets.createSet({ projectId, name: 'BadMain' });
    const { status } = await postJson(`/api/set/${set._id.toString()}/shot-plan`, {
      main_beat_id: 'nope',
    });
    expect(status).toBe(400);
  });
});
