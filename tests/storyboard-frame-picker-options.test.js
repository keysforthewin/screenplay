// Tests for GET /api/storyboard/:id/frame/:role/picker-options — the
// frame-aware reference-picker feed that powers the "This beat" tab when
// the user is generating a start/end frame. Three labelled sections:
//   sibling_frame  — opposite frame on this row
//   beat_artwork   — done beat.artworks[]
//   beat_images    — every non-thumbnail GridFS image owned by the beat
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

describe('GET /api/storyboard/:id/frame/:role/picker-options', () => {
  it('returns the opposite frame as sibling_frame, beat artwork, and beat images', async () => {
    const beat = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'b' });
    const startId = new ObjectId();
    const endId = new ObjectId();
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'A wide shot.',
      shotType: 'cinematic_wide',
    });
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startId });
    await Storyboards.updateStoryboard(sb._id, { end_frame_id: endId });

    const artworkResultId = new ObjectId();
    seedImageFile({ ownerId: beat._id, name: 'upload' });
    seedImageFile({ ownerId: beat._id, name: 'storyboard-frame' });
    await newDoneArtwork(beat._id, {
      resultImageId: artworkResultId,
      name: 'mood',
      prompt: 'neon alley',
    });

    // Generating end_frame → sibling should be start_frame.
    const r1 = await get(`/api/storyboard/${sb._id}/frame/end_frame/picker-options`);
    expect(r1.status).toBe(200);
    expect(r1.json.sibling_frame).toEqual({
      image_id: String(startId),
      label: 'Start frame',
    });
    expect(r1.json.beat_artwork).toHaveLength(1);
    expect(r1.json.beat_artwork[0]).toMatchObject({
      _id: String(artworkResultId),
      name: 'mood',
    });
    expect(r1.json.beat_artwork[0]).toHaveProperty('artwork_id');
    // beat_images includes every non-thumbnail GridFS image for the beat.
    // The SPA dedupes the sibling frame / artwork-result out client-side.
    expect(r1.json.beat_images.length).toBeGreaterThanOrEqual(2);

    // Generating start_frame → sibling should be end_frame.
    const r2 = await get(`/api/storyboard/${sb._id}/frame/start_frame/picker-options`);
    expect(r2.status).toBe(200);
    expect(r2.json.sibling_frame).toEqual({
      image_id: String(endId),
      label: 'End frame',
    });
  });

  it('returns sibling_frame: null when the opposite frame has no image yet', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'x',
      shotType: 'medium',
    });
    await Storyboards.updateStoryboard(sb._id, {
      start_frame_id: new ObjectId(),
    });

    const { status, json } = await get(
      `/api/storyboard/${sb._id}/frame/start_frame/picker-options`,
    );
    expect(status).toBe(200);
    expect(json.sibling_frame).toBeNull();
  });

  it('filters out pending and errored artworks', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'x',
      shotType: 'medium',
    });

    const doneId = new ObjectId();
    await newDoneArtwork(beat._id, { resultImageId: doneId, name: 'kept' });
    // A pending artwork (no result_image_id) — must not appear.
    await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: beat._id,
      prompt: 'pending',
      model: 'nano-banana-pro',
    });

    const { status, json } = await get(
      `/api/storyboard/${sb._id}/frame/end_frame/picker-options`,
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
    const real = seedImageFile({ ownerId: beat._id, name: 'real' });
    seedImageFile({ ownerId: beat._id, kind: 'thumbnail', name: 'thumb' });

    const { status, json } = await get(
      `/api/storyboard/${sb._id}/frame/end_frame/picker-options`,
    );
    expect(status).toBe(200);
    const ids = json.beat_images.map((i) => String(i._id));
    expect(ids).toContain(String(real._id));
    expect(ids.length).toBe(1);
  });

  it('returns 400 for an invalid role', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'b' });
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'x',
      shotType: 'medium',
    });
    const { status } = await get(
      `/api/storyboard/${sb._id}/frame/middle_frame/picker-options`,
    );
    expect(status).toBe(400);
  });

  it('returns 404 for an unknown storyboard id', async () => {
    const { status } = await get(
      `/api/storyboard/0000aaaa0000aaaa0000aaaa/frame/end_frame/picker-options`,
    );
    expect(status).toBe(404);
  });
});
