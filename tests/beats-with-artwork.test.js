// Route test for GET /api/beats/with-artwork — the endpoint that the
// tabbed reference picker calls when the user clicks the "Beats" tab.
// Verifies shape only; filtering / search happens client-side.

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

const { createProject } = await import('../src/mongo/projects.js');
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

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}

describe('GET /api/beats/with-artwork', () => {
  it('returns every beat with its embedded images and done artworks', async () => {
    const b1 = await Plots.createBeat({ projectId, name: 'Cold open', desc: 'rainy alley' });
    const b2 = await Plots.createBeat({ projectId, name: 'Climax', desc: 'rooftop chase' });

    // Beat 1 gets one image and one done artwork
    const img = {
      _id: new ObjectId(),
      filename: 'alley.png',
      name: 'wide alley',
      description: 'establishing reference',
      content_type: 'image/png',
    };
    await Plots.pushBeatImage(projectId, b1._id.toString(), img);
    const { artwork: a1 } = await Artworks.createPendingArtwork({ projectId,
      hostType: 'beat',
      hostId: b1._id.toString(),
      prompt: 'rainy alley wide shot',
      name: 'Hero establishing',
      model: 'fal',
    });
    await Artworks.setArtworkResult({ projectId,
      hostType: 'beat',
      hostId: b1._id.toString(),
      artworkId: a1._id,
      resultImageId: new ObjectId(),
    });

    // Beat 1 also gets one *pending* artwork, which should NOT appear
    // in the picker output (no result image yet).
    await Artworks.createPendingArtwork({ projectId,
      hostType: 'beat',
      hostId: b1._id.toString(),
      prompt: 'still rendering',
      model: 'fal',
    });

    const { status, json } = await get('/api/beats/with-artwork');
    expect(status).toBe(200);
    expect(json.beats).toHaveLength(2);
    const out1 = json.beats.find((b) => b.name === 'Cold open');
    expect(out1.images).toHaveLength(1);
    expect(out1.images[0].name).toBe('wide alley');
    expect(out1.artworks).toHaveLength(1);
    expect(out1.artworks[0].name).toBe('Hero establishing');
    expect(out1.artworks[0].result_image_id).toBeTruthy();
    const out2 = json.beats.find((b) => b.name === 'Climax');
    expect(out2.images).toEqual([]);
    expect(out2.artworks).toEqual([]);
  });
});
