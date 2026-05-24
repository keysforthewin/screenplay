// Tests for GET /api/beat/:id/images and GET /api/character/:id/images —
// the endpoints the References tab uses to surface the superset of GridFS
// images owned by the entity. Both endpoints must filter out thumbnails
// AND artwork result images (those live exclusively on the Artwork tab).

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

vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(),
  announceCharacterMedia: vi.fn(),
  announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(),
  announceLibraryMedia: vi.fn(),
  announceBatchSummary: vi.fn(),
}));

const deletedImageIds = [];
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    deleteImage: async (id) => {
      deletedImageIds.push(String(id));
      // Also remove from the fake collection so subsequent queries see it gone.
      const docs = fakeDb.collection('images.files')._docs;
      const idx = docs.findIndex((d) => String(d._id) === String(id));
      if (idx >= 0) docs.splice(idx, 1);
    },
  };
});

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Artworks = await import('../src/mongo/artworks.js');
const Storyboards = await import('../src/mongo/storyboards.js');
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
  deletedImageIds.length = 0;
});

function seedImage({ ownerType, ownerId, kind, name }) {
  const doc = {
    _id: new ObjectId(),
    filename: `${name || 'img'}.png`,
    contentType: 'image/png',
    length: 12,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType ?? null,
      owner_id: ownerId ?? null,
      source: 'generated',
      prompt: null,
      generated_by: null,
      name: name || '',
      description: '',
      ...(kind ? { kind } : {}),
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}

async function del(path) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('GET /api/beat/:id/images', () => {
  it('returns all non-thumbnail beat-owned GridFS images, excluding artwork results', async () => {
    const beat = await Plots.createBeat({ name: 'Diner' });
    // In the embedded gallery (typical reference image).
    const gallery = seedImage({ ownerType: 'beat', ownerId: beat._id, name: 'gallery' });
    await Plots.pushBeatImage(beat._id, {
      _id: gallery._id,
      filename: gallery.filename,
      content_type: 'image/png',
      size: 12,
      uploaded_at: gallery.uploadDate,
    });
    // Orphan: owned by beat but not in beat.images[] — e.g. a storyboard frame
    // or per-frame reference upload.
    const orphan = seedImage({ ownerType: 'beat', ownerId: beat._id, name: 'orphan' });
    // Thumbnail cache — must be filtered out.
    seedImage({ ownerType: 'beat', ownerId: beat._id, name: 'thumb', kind: 'thumbnail' });
    // Artwork result image — owned by beat but tracked under beat.artworks[].
    const artworkResult = seedImage({ ownerType: 'beat', ownerId: beat._id, name: 'artwork' });
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: beat._id,
      prompt: 'whatever',
      model: 'gemini',
    });
    await Artworks.setArtworkResult({
      hostType: 'beat',
      hostId: beat._id,
      artworkId: artwork._id,
      resultImageId: artworkResult._id,
    });

    const { status, json } = await get(`/api/beat/${beat._id}/images`);
    expect(status).toBe(200);
    const ids = json.images.map((i) => String(i._id));
    expect(ids).toContain(String(gallery._id));
    expect(ids).toContain(String(orphan._id));
    expect(ids).not.toContain(String(artworkResult._id));
    expect(ids.length).toBe(2);
  });
});

describe('GET /api/character/:id/images', () => {
  it('returns all non-thumbnail character-owned GridFS images, excluding artwork results', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const gallery = seedImage({ ownerType: 'character', ownerId: c._id, name: 'sheet' });
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          images: [
            {
              _id: gallery._id,
              filename: gallery.filename,
              content_type: 'image/png',
              size: 12,
              uploaded_at: gallery.uploadDate,
            },
          ],
        },
      },
    );
    const orphan = seedImage({ ownerType: 'character', ownerId: c._id, name: 'orphan' });
    seedImage({ ownerType: 'character', ownerId: c._id, name: 'thumb', kind: 'thumbnail' });
    const artworkResult = seedImage({ ownerType: 'character', ownerId: c._id, name: 'artwork' });
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id,
      prompt: 'whatever',
      model: 'gemini',
    });
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id,
      artworkId: artwork._id,
      resultImageId: artworkResult._id,
    });

    const { status, json } = await get(`/api/character/${c._id}/images`);
    expect(status).toBe(200);
    const ids = json.images.map((i) => String(i._id));
    expect(ids).toContain(String(gallery._id));
    expect(ids).toContain(String(orphan._id));
    expect(ids).not.toContain(String(artworkResult._id));
    expect(ids.length).toBe(2);
  });

  it('accepts a name in place of an id', async () => {
    const c = await Characters.createCharacter({ name: 'Silver Wolf' });
    seedImage({ ownerType: 'character', ownerId: c._id, name: 'a' });
    const { status, json } = await get(`/api/character/Silver%20Wolf/images`);
    expect(status).toBe(200);
    expect(json.images.length).toBe(1);
  });
});

describe('DELETE /api/beat/:id/orphan-image/:imageId', () => {
  it('deletes a beat-owned GridFS image that is not in beat.images[] and clears storyboard refs', async () => {
    const beat = await Plots.createBeat({ name: 'Diner' });
    const orphan = seedImage({ ownerType: 'beat', ownerId: beat._id, name: 'orphan' });
    // Storyboard with the orphan as a frame's current image, and also in
    // another frame's reference list.
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id,
      textPrompt: 'Wide shot',
    });
    const imgFrame = (await Storyboards.addFrame(sb._id, { imageId: orphan._id })).frameId;
    const refFrame = (await Storyboards.addFrame(sb._id, {})).frameId;
    await Storyboards.pushFrameReferenceImage(sb._id, refFrame, orphan._id);

    const { status, json } = await del(
      `/api/beat/${beat._id}/orphan-image/${orphan._id}`,
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(deletedImageIds).toContain(String(orphan._id));
    const fresh = await Storyboards.getStoryboard(sb._id);
    const img = fresh.frames.find((f) => f._id.toString() === String(imgFrame));
    const ref = fresh.frames.find((f) => f._id.toString() === String(refFrame));
    expect(img.image_id).toBe(null);
    expect(ref.reference_ids.map(String)).not.toContain(String(orphan._id));
  });

  it('refuses to delete an image that lives in beat.images[]', async () => {
    const beat = await Plots.createBeat({ name: 'Diner' });
    const gallery = seedImage({ ownerType: 'beat', ownerId: beat._id, name: 'gallery' });
    await Plots.pushBeatImage(beat._id, {
      _id: gallery._id,
      filename: gallery.filename,
      content_type: 'image/png',
      size: 12,
      uploaded_at: gallery.uploadDate,
    });
    const { status } = await del(
      `/api/beat/${beat._id}/orphan-image/${gallery._id}`,
    );
    expect(status).toBe(409);
    expect(deletedImageIds).toHaveLength(0);
  });

  it('refuses to delete an image owned by a different beat', async () => {
    const beatA = await Plots.createBeat({ name: 'A' });
    const beatB = await Plots.createBeat({ name: 'B' });
    const img = seedImage({ ownerType: 'beat', ownerId: beatB._id, name: 'b-img' });
    const { status } = await del(
      `/api/beat/${beatA._id}/orphan-image/${img._id}`,
    );
    expect(status).toBe(409);
    expect(deletedImageIds).toHaveLength(0);
  });
});

describe('DELETE /api/character/:id/orphan-image/:imageId', () => {
  it('deletes a character-owned GridFS image that is not in character.images[]', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const orphan = seedImage({ ownerType: 'character', ownerId: c._id, name: 'orphan' });
    const { status, json } = await del(
      `/api/character/${c._id}/orphan-image/${orphan._id}`,
    );
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(deletedImageIds).toContain(String(orphan._id));
  });

  it('refuses to delete an image that lives in character.images[]', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const gallery = seedImage({ ownerType: 'character', ownerId: c._id, name: 'sheet' });
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          images: [
            {
              _id: gallery._id,
              filename: gallery.filename,
              content_type: 'image/png',
              size: 12,
            },
          ],
        },
      },
    );
    const { status } = await del(
      `/api/character/${c._id}/orphan-image/${gallery._id}`,
    );
    expect(status).toBe(409);
    expect(deletedImageIds).toHaveLength(0);
  });
});
