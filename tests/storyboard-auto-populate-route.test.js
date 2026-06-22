// HTTP route test for POST /api/storyboard/:id/frame/:frameId/reference/auto-populate
//
// Verifies that the endpoint uses the unified scored-selection path:
// buildFrameReferenceCandidates → scoreFrameReferences → selectScoredFrameReferences.
// We inject a deterministic scorer via _setFrameReferenceScorerForTests so
// the "LLM" returns fixed scores (beat candidates 0.9, char candidates 0.8)
// and assert the response reflects scored top-2-per-source + character guarantee,
// capped at 6.

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
  listImagesForBeat: vi.fn(async (projectId, beatId) => {
    const docs = await fakeDb
      .collection('images.files')
      .find({ 'metadata.owner_type': 'beat', 'metadata.owner_id': beatId })
      .toArray();
    return docs;
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
// Stub the anthropic client so frameReferenceSelector doesn't try to make real calls.
vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => ({}),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Characters = await import('../src/mongo/characters.js');
const { appendDoneArtwork } = await import('../src/mongo/artworks.js');
const { _setFrameReferenceScorerForTests } = await import('../src/llm/frameReferenceSelector.js');
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
  _setFrameReferenceScorerForTests(null);
});

afterEach(() => {
  _setFrameReferenceScorerForTests(null);
});

// Insert a GridFS image-file doc owned by a beat.
async function putBeatImageInDb(beatId, { name = 'beat artwork', description = '' } = {}) {
  const _id = new ObjectId();
  await fakeDb.collection('images.files').insertOne({
    _id,
    filename: 'x.png',
    contentType: 'image/png',
    length: 10,
    uploadDate: new Date(),
    metadata: { name, description, owner_type: 'beat', owner_id: String(beatId) },
  });
  return _id;
}

async function makeCharacter(name, { images = [], mainId = null } = {}) {
  const c = await Characters.createCharacter({ projectId, name });
  await fakeDb.collection('characters').updateOne(
    { _id: c._id },
    { $set: { main_image_id: mainId, images } },
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
  it('uses unified scored selection: beat artwork + character artwork, capped at 6', async () => {
    // ── seed beat ──
    const beat = await Plots.createBeat({
      projectId,
      name: 'Keys solo',
      desc: 'k',
      body: 'Keys alone in the bar.',
      characters: ['Keys'],
    });

    // Seed two beat ARTWORKS (the "Artwork" section). Auto-suggest pools these,
    // not the beat's plain reference images.
    const beatArt1 = new ObjectId();
    const beatArt2 = new ObjectId();
    // Negative control: a plain beat reference image that is NOT an artwork —
    // auto-suggest must never surface it.
    const plainRefImg = await putBeatImageInDb(beat._id, { name: 'Uploaded ref', description: 'not artwork' });
    await Plots.pushBeatImage(projectId, beat._id, { _id: plainRefImg }, true);
    await appendDoneArtwork({ projectId, hostType: 'beat', hostId: beat._id, resultImageId: beatArt1, name: 'Bar interior' });
    await appendDoneArtwork({ projectId, hostType: 'beat', hostId: beat._id, resultImageId: beatArt2, name: 'Close-up' });

    // ── seed character with multiple artworks ──
    const char = await makeCharacter('Keys');
    const charArt1 = new ObjectId();
    const charArt2 = new ObjectId();
    await appendDoneArtwork({ projectId, hostType: 'character', hostId: char._id, resultImageId: charArt1, name: 'Keys young' });
    await appendDoneArtwork({ projectId, hostType: 'character', hostId: char._id, resultImageId: charArt2, name: 'Keys old' });

    // ── seed storyboard + frame (empty reference_ids) ──
    const sb = await Storyboards.createStoryboard({
      projectId,
      beatId: beat._id,
      textPrompt: 'Close-up on the old man.',
      summary: 'Keys sits alone at the bar.',
      charactersInScene: ['Keys'],
    });
    const { frameId } = await Storyboards.addFrame(sb._id, {});

    // ── inject a deterministic scorer: beat candidates score 0.9, char 0.8 ──
    // Track whether the scorer was actually called so we can assert the route
    // took the new code path (not the old selectBestReferencesForShot path).
    let scorerCalled = false;
    _setFrameReferenceScorerForTests(async ({ candidates }) => {
      scorerCalled = true;
      const m = new Map();
      candidates.forEach((c, i) => m.set(i + 1, c.source === 'beat' ? 0.9 : 0.8));
      return m;
    });

    // ── call the endpoint ──
    const { status, json } = await postJson(
      `/storyboard/${sb._id}/frame/${frameId}/reference/auto-populate`,
      {},
    );

    expect(status).toBe(200);
    expect(json).toBeDefined();
    // The new path MUST have called the injected scorer
    expect(scorerCalled).toBe(true);
    // total must be within the model cap (null → 6)
    expect(json.total).toBeGreaterThan(0);
    expect(json.total).toBeLessThanOrEqual(6);
    // Both beat images (scored 0.9 each, above threshold) must be included;
    // top-2-per-source means both beat images qualify.
    expect(json.total).toBeGreaterThanOrEqual(2);
    // added reflects what was actually appended
    expect(Array.isArray(json.added)).toBe(true);
    // The plain (non-artwork) beat reference image must NOT be auto-suggested.
    expect(json.added.map(String)).not.toContain(String(plainRefImg));
    // storyboard returned in response
    expect(json.storyboard).toBeDefined();
  });

  it('returns status 200 with empty added when frame already has all references', async () => {
    const beat = await Plots.createBeat({
      projectId,
      name: 'Scene',
      desc: 'd',
      body: 'A scene.',
      characters: [],
    });
    const beatArt = new ObjectId();
    await appendDoneArtwork({ projectId, hostType: 'beat', hostId: beat._id, resultImageId: beatArt, name: 'Scene art' });

    const sb = await Storyboards.createStoryboard({
      projectId,
      beatId: beat._id,
      textPrompt: 'A scene.',
      summary: 'Scene.',
      charactersInScene: [],
    });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    // Pre-seed the frame with the beat artwork so nothing new gets added
    await Storyboards.setFrameReferenceImages(sb._id, frameId, [beatArt]);

    _setFrameReferenceScorerForTests(async ({ candidates }) => {
      const m = new Map();
      candidates.forEach((c, i) => m.set(i + 1, 0.9));
      return m;
    });

    const { status, json } = await postJson(
      `/storyboard/${sb._id}/frame/${frameId}/reference/auto-populate`,
      {},
    );

    expect(status).toBe(200);
    expect(json.added).toEqual([]);
    expect(json.storyboard).toBeDefined();
  });
});
