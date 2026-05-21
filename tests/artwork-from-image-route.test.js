// Integration test for POST /:host/:id/artwork/from-image — the endpoint
// the unified artwork picker hits when the user clicks a thumb on a
// non-Generate tab. Same-owner path only (cross-owner needs real GridFS).

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

const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
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

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function seedImage({ ownerType, ownerId }) {
  const doc = {
    _id: new ObjectId(),
    filename: 'src.png',
    contentType: 'image/png',
    length: 1234,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerId || null,
      source: 'generated',
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('POST /api/:host/:id/artwork/from-image', () => {
  it('imports a host-owned image as a new done artwork on a character', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const file = seedImage({ ownerType: 'character', ownerId: c._id });

    const { status, json } = await postJson(
      `/api/character/${c._id.toString()}/artwork/from-image`,
      { image_id: file._id.toString(), name: 'Hero portrait' },
    );

    expect(status).toBe(200);
    expect(json.artwork.status).toBe('done');
    expect(json.artwork.source).toBe('imported');
    expect(json.artwork.result_image_id.toString()).toBe(file._id.toString());
    expect(json.artwork.name).toBe('Hero portrait');
    expect(json.artwork.prompt).toBe('');
    expect(json.artwork.reference_image_ids).toEqual([]);

    const fresh = await Characters.getCharacter('Rae');
    expect(fresh.artworks).toHaveLength(1);
  });

  it('imports a beat-owned image as a new done artwork on the same beat', async () => {
    const beat = await Plots.createBeat({ name: 'Cold open' });
    const file = seedImage({ ownerType: 'beat', ownerId: beat._id });

    const { status, json } = await postJson(
      `/api/beat/${beat._id.toString()}/artwork/from-image`,
      { image_id: file._id.toString() },
    );

    expect(status).toBe(200);
    expect(json.artwork.status).toBe('done');
    expect(json.artwork.result_image_id.toString()).toBe(file._id.toString());

    const plot = await Plots.getPlot();
    const fresh = plot.beats.find((b) => b._id.equals(beat._id));
    expect(fresh.artworks).toHaveLength(1);
  });

  it('400s when image_id is missing or malformed', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const { status: missing } = await postJson(
      `/api/character/${c._id.toString()}/artwork/from-image`,
      {},
    );
    expect(missing).toBe(400);
    const { status: bad } = await postJson(
      `/api/character/${c._id.toString()}/artwork/from-image`,
      { image_id: 'not-hex' },
    );
    expect(bad).toBe(400);
  });

  it('404s when the source image does not exist', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const { status } = await postJson(
      `/api/character/${c._id.toString()}/artwork/from-image`,
      { image_id: new ObjectId().toString() },
    );
    expect(status).toBe(404);
  });
});
