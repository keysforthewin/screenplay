// Route tests for:
//   GET /api/beat/:id/image-sheet-references
// Reuses the Express/supertest harness from imageSheetRoutes.test.js.
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
const Plots = await import('../src/mongo/plots.js');
const Planner = await import('../src/web/beatSheetPlanner.js');
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
let beat;
let r1; // a reference image id seeded on an artwork

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Ref Test Project'))._id.toString();
  h.configured = true;
  Planner._setScenePlatePlannerForTests(async () => ([{ name: 'Plate', prompt: 'wide empty set', justification: 'establishes', quote: 'INT. SET' }]));
  Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));

  // Create a beat and seed it with one done artwork that carries a reference id.
  beat = await Plots.createBeat({ projectId, name: 'Scene 1', body: 'INT. STUDIO - DAY' });
  r1 = new ObjectId().toString();

  // Directly inject an artwork with a reference_image_ids entry into the beat's
  // artworks[] array using the fake DB's $push support.
  const db = fakeDb;
  await db.collection('plots').updateOne(
    { project_id: projectId, 'beats._id': beat._id },
    {
      $push: {
        'beats.$.artworks': {
          _id: new ObjectId(),
          name: 'Test artwork',
          prompt: 'wide shot',
          model: 'nano-banana-pro',
          reference_image_ids: [new ObjectId(r1)],
          result_image_id: new ObjectId(),
          previous_result_image_id: null,
          last_edit_prompt: '',
          status: 'done',
          error_message: null,
          job_id: null,
          source: 'generated',
          created_at: new Date(),
          updated_at: new Date(),
        },
      },
    },
  );
});

async function getJson(path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, json: await res.json() };
}

describe('GET /api/beat/:id/image-sheet-references', () => {
  it('returns saved reference ids when present', async () => {
    const savedId = new ObjectId().toString();
    await Plots.setBeatImageSheetReferences(projectId, beat._id, [savedId]);

    const { status, json } = await getJson(
      `/api/beat/${beat._id.toString()}/image-sheet-references`,
      { 'X-Project-Id': projectId },
    );
    expect(status).toBe(200);
    expect(json.reference_ids).toEqual([savedId]);
  });

  it('falls back to artwork reference ids when none saved', async () => {
    // beat has no image_sheet_reference_ids; should return r1 from the seeded artwork
    const { status, json } = await getJson(
      `/api/beat/${beat._id.toString()}/image-sheet-references`,
      { 'X-Project-Id': projectId },
    );
    expect(status).toBe(200);
    expect(json.reference_ids).toContain(r1);
  });

  it('404s on a missing beat', async () => {
    const { status } = await getJson(
      `/api/beat/${new ObjectId().toString()}/image-sheet-references`,
      { 'X-Project-Id': projectId },
    );
    expect(status).toBe(404);
  });
});
