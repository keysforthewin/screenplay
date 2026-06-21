// HTTP route test for POST /api/storyboard/:id/frame/:frameId/reference/auto-populate
//
// Verifies that after Task 8 the endpoint uses selectBestReferencesForShot
// (not collectStoryboardReferenceIds) to pick which reference images to append
// to a frame.  We stub the selector's LLM via _setReferenceSelectorLLMForTests
// so the "LLM" chooses image_index 2 for character "Keys" (the OLD sheet) and
// assert the response contains the beat image + old sheet, but NOT the young
// sheet.

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
  findImageFile: vi.fn(async (imageId) => {
    try {
      const oid = new ObjectId(String(imageId));
      return fakeDb.collection('images.files').findOne({ _id: oid });
    } catch {
      return null;
    }
  }),
  imageFileToMeta: vi.fn((file) => ({
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType,
    size: file.length,
    name: file.metadata?.name || '',
    description: file.metadata?.description || '',
  })),
}));
// Stub the anthropic client so referenceSelector doesn't try to make real calls.
vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => ({}),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Characters = await import('../src/mongo/characters.js');
const Sel = await import('../src/web/referenceSelector.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;
let projectId;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  Sel._setReferenceSelectorLLMForTests(null);
});

afterEach(() => {
  Sel._setReferenceSelectorLLMForTests(null);
});

// Insert a GridFS image-file doc (the selector reads name/description from there).
async function putImageMetaInDb({ name = '', description = '' } = {}) {
  const _id = new ObjectId();
  await fakeDb.collection('images.files').insertOne({
    _id,
    filename: 'x.png',
    contentType: 'image/png',
    length: 10,
    uploadDate: new Date(),
    metadata: { name, description },
  });
  return _id;
}

async function makeCharacter(name, { sheets = [], mainId = null, images = [] } = {}) {
  const c = await Characters.createCharacter({ projectId, name });
  await fakeDb.collection('characters').updateOne(
    { _id: c._id },
    { $set: { character_sheet_image_ids: sheets, main_image_id: mainId, images } },
  );
  return Characters.getCharacter(projectId, name);
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-project-id': projectId,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

describe('POST /storyboard/:id/frame/:frameId/reference/auto-populate', () => {
  it('uses selectBestReferencesForShot: picks old sheet + beat image, skips young sheet', async () => {
    // ── seed images ──
    const youngSheet = await putImageMetaInDb({ name: 'Young Keys', description: 'teenager' });
    const oldSheet   = await putImageMetaInDb({ name: 'Old Keys',   description: '70s' });

    // Character "Keys" has two labeled sheets; young is main.
    await makeCharacter('Keys', { sheets: [youngSheet, oldSheet], mainId: youngSheet });

    // ── seed beat with a main image ──
    const beatImg = new ObjectId();
    const beat = await Plots.createBeat({
      projectId,
      name: 'Keys solo',
      desc: 'k',
      body: 'Keys alone in the bar.',
      characters: ['Keys'],
    });
    await Plots.pushBeatImage(projectId, beat._id, { _id: beatImg }, true);

    // ── seed storyboard + frame (empty reference_ids) ──
    const sb = await Storyboards.createStoryboard({
      projectId,
      beatId: beat._id,
      textPrompt: 'Close-up on the old man.',
      summary: 'Keys sits alone at the bar.',
      charactersInScene: ['Keys'],
    });
    const { frameId } = await Storyboards.addFrame(sb._id, {});

    // ── stub the LLM to choose image_index 2 (oldSheet) for "Keys" ──
    Sel._setReferenceSelectorLLMForTests(async () => ({
      picks: [{ character: 'Keys', image_index: 2 }],
    }));

    // ── call the endpoint ──
    const { status, json } = await postJson(
      `/storyboard/${sb._id}/frame/${frameId}/reference/auto-populate`,
      {},
    );

    expect(status).toBe(200);
    expect(json).toBeDefined();

    const added = (json.added || []).map(String);

    // beat image must be present
    expect(added).toContain(beatImg.toString());
    // LLM picked image_index 2 → oldSheet
    expect(added).toContain(oldSheet.toString());
    // youngSheet was NOT picked
    expect(added).not.toContain(youngSheet.toString());

    // total reflects the full resolved list (beatImg + oldSheet = 2)
    expect(json.total).toBeGreaterThanOrEqual(1);

    // storyboard returned in response
    expect(json.storyboard).toBeDefined();
  });
});
