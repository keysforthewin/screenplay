// The generate routes must accept a fal catalog endpoint id, not just the seven
// wired shortcuts — otherwise the new picker can offer models the server then
// refuses. Bogus ids must still fail with a 400, not a 500.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
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

vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(),
  announceCharacterMedia: vi.fn(),
  announceSetMedia: vi.fn(),
  announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(),
  announceLibraryMedia: vi.fn(),
  announceBatchSummary: vi.fn(),
}));

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const dispatchMock = vi.fn(async ({ model }) => ({
  buffer: TINY_PNG,
  contentType: 'image/png',
  model,
}));
vi.mock('../src/web/imageReplaceDispatch.js', () => ({
  dispatchImageReplace: (...a) => dispatchMock(...a),
  ALLOWED_IMAGE_MODELS: ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai', 'gemini-25-flash', 'nano-banana-2', 'flux-2-klein'],
}));

vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  uploadGeneratedImage: vi.fn(async (_projectId, { filename }) => ({
    _id: new (await import('mongodb')).ObjectId(),
    filename,
    content_type: 'image/png',
    size: TINY_PNG.length,
    uploaded_at: new Date(),
  })),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Sets = await import('../src/mongo/sets.js');
const { loadImageModelCatalog } = await import('../src/fal/imageModelCatalog.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
let catalogModelId;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Take a real id straight from the catalog so this never drifts from the data.
  const { models } = await loadImageModelCatalog();
  catalogModelId = models.find((m) => !m.is_wired).id;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  dispatchMock.mockClear();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function generateOnSet(model) {
  const set = await Sets.createSet({ projectId, name: 'Alley' });
  const res = await fetch(`${baseUrl}/api/set/${set._id}/image/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'sodium-lit alley', model }),
  });
  return { status: res.status, json: await res.json() };
}

describe('POST /api/set/:id/image/generate model validation', () => {
  it('accepts a wired shortcut', async () => {
    const { status } = await generateOnSet('nano-banana-pro');
    expect(status).toBe(200);
    expect(dispatchMock.mock.calls[0][0].model).toBe('nano-banana-pro');
  });

  it('accepts a fal catalog endpoint id', async () => {
    expect(catalogModelId).toBeTruthy();
    const { status } = await generateOnSet(catalogModelId);
    expect(status).toBe(200);
    expect(dispatchMock.mock.calls[0][0].model).toBe(catalogModelId);
  });

  it('rejects an unknown model with a 400', async () => {
    const { status, json } = await generateOnSet('not-a-real-model');
    expect(status).toBe(400);
    expect(json.error).toMatch(/image_model/);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
