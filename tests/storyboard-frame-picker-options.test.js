// Tests for GET /api/storyboard/:id/frame/:frameId/picker-options — the
// frame-aware reference-picker feed that powers the "This beat" tab. Three
// labelled sections:
//   other_frames  — the OTHER frames in the pool that have an image
//   beat_artwork  — done beat.artworks[]
//   beat_images   — every non-thumbnail GridFS image owned by the beat
// Dedup across sections lives in the SPA (the endpoint emits the raw
// per-section lists). We assert shape + filtering here.

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
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Artworks = await import('../src/mongo/artworks.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

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

beforeEach(() => {
  fakeDb.reset();
});

function seedImageFile({ ownerId, kind, name }) {
  const doc = {
    _id: new ObjectId(),
    filename: `beat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`,
    contentType: 'image/png',
    length: 1024,
    uploadDate: new Date(),
    metadata: {
      owner_type: 'beat',
      owner_id: ownerId,
      source: 'generated',
      name: name || '',
      ...(kind ? { kind } : {}),
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

async function newDoneArtwork(beatId, { resultImageId, name, prompt }) {
  const { artwork } = await Artworks.createPendingArtwork({
    hostType: 'beat',
    hostId: beatId,
    prompt: prompt || 'painted moodboard',
    name: name || '',
    model: 'nano-banana-pro',
  });
  await Artworks.setArtworkResult({
    hostType: 'beat',
    hostId: beatId,
    artworkId: artwork._id,
    resultImageId,
  });
  return artwork;
}

async function addFrame(sbId, imageId) {
  const { frameId } = await Storyboards.addFrame(sbId, { imageId });
  return frameId;
}

describe('GET /api/storyboard/:id/frame/:frameId/picker-options', () => {
  it('returns the other frames, beat artwork, and beat images', async () => {
    const beat = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'b' });
    const img1 = new ObjectId();
    const img2 = new ObjectId();
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'A wide shot.',
      shotType: 'cinematic_wide',
    });
    const f1 = await addFrame(sb._id, img1);
    const f2 = await addFrame(sb._id, img2);

    const artworkResultId = new ObjectId();
    seedImageFile({ ownerId: beat._id, name: 'upload' });
    seedImageFile({ ownerId: beat._id, name: 'storyboard-frame' });
    await newDoneArtwork(beat._id, {
      resultImageId: artworkResultId,
      name: 'mood',
      prompt: 'neon alley',
    });

    // Picking refs for frame 2 → other_frames should list frame 1.
    const r1 = await get(`/api/storyboard/${sb._id}/frame/${f2}/picker-options`);
    expect(r1.status).toBe(200);
    expect(r1.json.other_frames).toEqual([
      { image_id: String(img1), label: 'Frame 1' },
    ]);
    expect(r1.json.beat_artwork).toHaveLength(1);
    expect(r1.json.beat_artwork[0]).toMatchObject({
      _id: String(artworkResultId),
      name: 'mood',
    });
    expect(r1.json.beat_artwork[0]).toHaveProperty('artwork_id');
    expect(r1.json.beat_images.length).toBeGreaterThanOrEqual(2);

    // Picking refs for frame 1 → other_frames should list frame 2.
    const r2 = await get(`/api/storyboard/${sb._id}/frame/${f1}/picker-options`);
    expect(r2.status).toBe(200);
    expect(r2.json.other_frames).toEqual([
      { image_id: String(img2), label: 'Frame 2' },
    ]);
  });

  it('omits frames without an image from other_frames', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'x',
      shotType: 'medium',
    });
    const f1 = await addFrame(sb._id, null); // no image
    const f2 = await addFrame(sb._id, null);

    const { status, json } = await get(
      `/api/storyboard/${sb._id}/frame/${f2}/picker-options`,
    );
    expect(status).toBe(200);
    expect(json.other_frames).toEqual([]);
    void f1;
  });

  it('filters out pending and errored artworks', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'x',
      shotType: 'medium',
    });
    const f = await addFrame(sb._id, null);

    const doneId = new ObjectId();
    await newDoneArtwork(beat._id, { resultImageId: doneId, name: 'kept' });
    await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: beat._id,
      prompt: 'pending',
      model: 'nano-banana-pro',
    });

    const { status, json } = await get(
      `/api/storyboard/${sb._id}/frame/${f}/picker-options`,
    );
    expect(status).toBe(200);
    expect(json.beat_artwork).toHaveLength(1);
    expect(json.beat_artwork[0]._id).toBe(String(doneId));
  });

  it('skips thumbnail-kind images in beat_images', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'x',
      shotType: 'medium',
    });
    const f = await addFrame(sb._id, null);
    const real = seedImageFile({ ownerId: beat._id, name: 'real' });
    seedImageFile({ ownerId: beat._id, kind: 'thumbnail', name: 'thumb' });

    const { status, json } = await get(
      `/api/storyboard/${sb._id}/frame/${f}/picker-options`,
    );
    expect(status).toBe(200);
    const ids = json.beat_images.map((i) => String(i._id));
    expect(ids).toContain(String(real._id));
    expect(ids.length).toBe(1);
  });

  it('returns 400 for an invalid frame id', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'x',
      shotType: 'medium',
    });
    const { status } = await get(
      `/api/storyboard/${sb._id}/frame/not-a-hex/picker-options`,
    );
    expect(status).toBe(400);
  });

  it('returns 404 for an unknown storyboard id', async () => {
    const { status } = await get(
      `/api/storyboard/0000aaaa0000aaaa0000aaaa/frame/0000aaaa0000aaaa0000aaaa/picker-options`,
    );
    expect(status).toBe(404);
  });
});
