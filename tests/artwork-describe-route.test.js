// Integration tests for the two artwork-description endpoints:
//   PATCH  /api/:host/:id/artwork/:artworkId          { description }
//   POST   /api/:host/:id/artwork/:artworkId/describe  (vision auto-fill)
//
// Both are registered by the shared registerArtworkRoutes(), so character and
// set hosts are covered by the same code path.

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

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const readImageBufferMock = vi.fn(async () => ({
  buffer: TINY_PNG,
  file: { contentType: 'image/png' },
}));
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readImageBuffer: readImageBufferMock,
}));

const describeMock = vi.fn(async () => ({
  name: 'Rain-slick alley',
  description: 'A narrow alley under sodium light, puddles reflecting neon signage.',
}));
vi.mock('../src/llm/referenceImageDescription.js', () => ({
  describeReferenceImage: describeMock,
  REFERENCE_KINDS: ['auto', 'character', 'location', 'prop'],
}));

const { createProject } = await import('../src/mongo/projects.js');
const Characters = await import('../src/mongo/characters.js');
const Sets = await import('../src/mongo/sets.js');
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
  describeMock.mockClear();
  readImageBufferMock.mockClear();
});

async function sendJson(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json() };
}

// A done artwork on a fresh host of the requested type.
async function seedArtwork({ hostType = 'character', name = '', withResult = true } = {}) {
  const host =
    hostType === 'set'
      ? await Sets.createSet({ projectId, name: 'Alley' })
      : await Characters.createCharacter({ projectId, name: 'Rae' });
  const hostId = host._id.toString();
  const { artwork } = await Artworks.createPendingArtwork({
    projectId,
    hostType,
    hostId,
    prompt: 'cyberpunk warrior, neon rim light',
    name,
    model: 'fal',
  });
  if (withResult) {
    await Artworks.setArtworkResult({
      projectId,
      hostType,
      hostId,
      artworkId: artwork._id,
      resultImageId: new ObjectId(),
    });
  }
  return { hostId, artworkId: artwork._id.toString() };
}

describe('PATCH /api/:host/:id/artwork/:artworkId', () => {
  it('saves a description on a character artwork', async () => {
    const { hostId, artworkId } = await seedArtwork();

    const { status, json } = await sendJson(
      'PATCH',
      `/api/character/${hostId}/artwork/${artworkId}`,
      { description: 'A woman in a rain-slick alley, lit from behind.' },
    );

    expect(status).toBe(200);
    expect(json.artwork.description).toBe('A woman in a rain-slick alley, lit from behind.');
    // The generation prompt is a separate field and must survive untouched.
    expect(json.artwork.prompt).toBe('cyberpunk warrior, neon rim light');
  });

  it('saves a description on a set artwork', async () => {
    const { hostId, artworkId } = await seedArtwork({ hostType: 'set' });

    const { status, json } = await sendJson(
      'PATCH',
      `/api/set/${hostId}/artwork/${artworkId}`,
      { description: 'Sodium-lit alley, wet asphalt, fire escape camera-left.' },
    );

    expect(status).toBe(200);
    expect(json.artwork.description).toBe('Sodium-lit alley, wet asphalt, fire escape camera-left.');
  });

  it('accepts name and description together', async () => {
    const { hostId, artworkId } = await seedArtwork();

    const { status, json } = await sendJson(
      'PATCH',
      `/api/character/${hostId}/artwork/${artworkId}`,
      { name: 'Hero shot', description: 'Close on Rae.' },
    );

    expect(status).toBe(200);
    expect(json.artwork.name).toBe('Hero shot');
    expect(json.artwork.description).toBe('Close on Rae.');
  });

  it('clears the description when sent an empty string', async () => {
    const { hostId, artworkId } = await seedArtwork();
    await sendJson('PATCH', `/api/character/${hostId}/artwork/${artworkId}`, {
      description: 'temporary',
    });

    const { status, json } = await sendJson(
      'PATCH',
      `/api/character/${hostId}/artwork/${artworkId}`,
      { description: '' },
    );

    expect(status).toBe(200);
    expect(json.artwork.description).toBe('');
  });

  it('rejects a body with no recognized fields', async () => {
    const { hostId, artworkId } = await seedArtwork();

    const { status, json } = await sendJson(
      'PATCH',
      `/api/character/${hostId}/artwork/${artworkId}`,
      { nonsense: 'x' },
    );

    expect(status).toBe(400);
    expect(json.error).toMatch(/description/);
  });
});

describe('artwork description backfill on entity GET', () => {
  async function getJson(path) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, json: await res.json() };
  }

  // The backfill is fired after the response is sent, so give its microtasks a
  // chance to run before asserting.
  async function flushQueue() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }

  it('describes a character artwork that has none yet', async () => {
    const { hostId, artworkId } = await seedArtwork();

    const { status } = await getJson('/api/character?name=Rae');
    expect(status).toBe(200);
    await flushQueue();

    const out = await Artworks.getArtwork({
      projectId, hostType: 'character', hostId, artworkId,
    });
    expect(out.artwork.description).toContain('narrow alley');
  });

  it('describes a set artwork that has none yet', async () => {
    const { hostId, artworkId } = await seedArtwork({ hostType: 'set' });

    const { status } = await getJson('/api/set?name=Alley');
    expect(status).toBe(200);
    await flushQueue();

    const out = await Artworks.getArtwork({ projectId, hostType: 'set', hostId, artworkId });
    expect(out.artwork.description).toContain('narrow alley');
  });

  it('leaves an artwork that already has a description alone', async () => {
    const { hostId, artworkId } = await seedArtwork();
    await sendJson('PATCH', `/api/character/${hostId}/artwork/${artworkId}`, {
      description: 'Hand-written by the director.',
    });

    await getJson('/api/character?name=Rae');
    await flushQueue();

    expect(describeMock).not.toHaveBeenCalled();
    const out = await Artworks.getArtwork({
      projectId, hostType: 'character', hostId, artworkId,
    });
    expect(out.artwork.description).toBe('Hand-written by the director.');
  });

  it('skips artworks that have not rendered yet', async () => {
    await seedArtwork({ withResult: false });

    await getJson('/api/character?name=Rae');
    await flushQueue();

    expect(describeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/:host/:id/artwork/:artworkId/describe', () => {
  it('fills the description from the rendered image', async () => {
    const { hostId, artworkId } = await seedArtwork();

    const { status, json } = await sendJson(
      'POST',
      `/api/character/${hostId}/artwork/${artworkId}/describe`,
    );

    expect(status).toBe(200);
    expect(json.artwork.description).toBe(
      'A narrow alley under sodium light, puddles reflecting neon signage.',
    );
  });

  it('describes a set artwork with the location describer', async () => {
    const { hostId, artworkId } = await seedArtwork({ hostType: 'set' });

    const { status } = await sendJson(
      'POST',
      `/api/set/${hostId}/artwork/${artworkId}/describe`,
    );

    expect(status).toBe(200);
    expect(describeMock.mock.calls[0][0].kind).toBe('location');
  });

  it('400s when the artwork has not rendered yet', async () => {
    const { hostId, artworkId } = await seedArtwork({ withResult: false });

    const { status, json } = await sendJson(
      'POST',
      `/api/character/${hostId}/artwork/${artworkId}/describe`,
    );

    expect(status).toBe(400);
    expect(json.error).toMatch(/no result image/i);
  });

  it('400s on a malformed artwork id', async () => {
    const { hostId } = await seedArtwork();

    const { status } = await sendJson(
      'POST',
      `/api/character/${hostId}/artwork/not-an-id/describe`,
    );

    expect(status).toBe(400);
  });
});
