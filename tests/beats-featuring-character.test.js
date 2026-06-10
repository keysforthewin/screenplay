// Route test for GET /api/beats-featuring-character — the endpoint that
// the Character page's artwork picker calls when the user opens the
// "Beats" tab. Returns only beats whose `characters[]` resolves (by name
// match, via findCharactersInBeat) to the given character id.

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

const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
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

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}

describe('GET /api/beats-featuring-character', () => {
  it('returns only beats whose characters list resolves to the given character', async () => {
    const rae = await Characters.createCharacter({ name: 'Rae' });
    await Characters.createCharacter({ name: 'Wei' });

    const b1 = await Plots.createBeat({ name: 'Cold open', characters: ['Rae'] });
    await Plots.createBeat({ name: 'Middle', characters: ['Wei'] });
    await Plots.createBeat({ name: 'Climax', characters: ['Rae', 'Wei'] });

    // Give b1 an image + a done artwork so the response shape is exercised.
    const img = {
      _id: new ObjectId(),
      filename: 'alley.png',
      name: 'wide alley',
      description: 'establishing',
      content_type: 'image/png',
    };
    await Plots.pushBeatImage(undefined, b1._id.toString(), img);
    const { artwork: a1 } = await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: b1._id.toString(),
      prompt: 'rainy alley',
      model: 'fal',
    });
    await Artworks.setArtworkResult({
      hostType: 'beat',
      hostId: b1._id.toString(),
      artworkId: a1._id,
      resultImageId: new ObjectId(),
    });

    const { status, json } = await get(
      `/api/beats-featuring-character?character_id=${rae._id.toString()}`,
    );
    expect(status).toBe(200);
    expect(json.beats.map((b) => b.name).sort()).toEqual(
      ['Climax', 'Cold open'].sort(),
    );
    const cold = json.beats.find((b) => b.name === 'Cold open');
    expect(cold.images).toHaveLength(1);
    expect(cold.images[0].name).toBe('wide alley');
    expect(cold.artworks).toHaveLength(1);
    expect(cold.artworks[0].result_image_id).toBeTruthy();
  });

  it('returns 400 when character_id is missing or not 24-hex', async () => {
    const { status: missing } = await get('/api/beats-featuring-character');
    expect(missing).toBe(400);
    const { status: bad } = await get(
      '/api/beats-featuring-character?character_id=not-hex',
    );
    expect(bad).toBe(400);
  });

  it('returns 404 when the character does not exist', async () => {
    const { status } = await get(
      `/api/beats-featuring-character?character_id=${new ObjectId().toString()}`,
    );
    expect(status).toBe(404);
  });

  it('returns an empty list when the character is in no beats', async () => {
    const lonely = await Characters.createCharacter({ name: 'Lonely' });
    await Plots.createBeat({ name: 'Solo' });

    const { status, json } = await get(
      `/api/beats-featuring-character?character_id=${lonely._id.toString()}`,
    );
    expect(status).toBe(200);
    expect(json.beats).toEqual([]);
  });
});
