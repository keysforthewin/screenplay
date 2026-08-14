// Tests for src/web/artworkVisionWorker.js — the vision pass that fills in an
// artwork's `description` (and its name, when blank) from the rendered image.
//
// Two entry points:
//   describeArtwork()          — awaited; backs POST /<host>/:id/artwork/:id/describe
//   kickoffArtworkVisionSeed() — fire-and-forget; runs after a render finishes
//                                and on the entity-GET lazy backfill

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// Only readImageBuffer needs faking — the rest of images.js runs against the
// fake Mongo like everywhere else.
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
const { describeArtwork, kickoffArtworkVisionSeed } = await import(
  '../src/web/artworkVisionWorker.js'
);

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  describeMock.mockClear();
  readImageBufferMock.mockClear();
});

async function flushQueue() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// Build a done artwork on a fresh host and return {hostId, artworkId}.
async function seedArtwork({ hostType = 'character', name = '' } = {}) {
  const host =
    hostType === 'set'
      ? await Sets.createSet({ projectId, name: 'Alley' })
      : await Characters.createCharacter({ projectId, name: 'Rae' });
  const hostId = host._id.toString();
  const { artwork } = await Artworks.createPendingArtwork({
    projectId,
    hostType,
    hostId,
    prompt: 'p',
    name,
    model: 'fal',
  });
  await Artworks.setArtworkResult({
    projectId,
    hostType,
    hostId,
    artworkId: artwork._id,
    resultImageId: new ObjectId(),
  });
  return { hostId, artworkId: artwork._id.toString() };
}

async function readArtwork(hostType, hostId, artworkId) {
  const out = await Artworks.getArtwork({ projectId, hostType, hostId, artworkId });
  return out?.artwork || null;
}

describe('describeArtwork', () => {
  it('writes the description onto the artwork', async () => {
    const { hostId, artworkId } = await seedArtwork();

    await describeArtwork({ projectId, hostType: 'character', hostId, artworkId });

    const after = await readArtwork('character', hostId, artworkId);
    expect(after.description).toBe(
      'A narrow alley under sodium light, puddles reflecting neon signage.',
    );
  });

  it('fills a blank name from the vision pass', async () => {
    const { hostId, artworkId } = await seedArtwork({ name: '' });

    await describeArtwork({ projectId, hostType: 'character', hostId, artworkId });

    const after = await readArtwork('character', hostId, artworkId);
    expect(after.name).toBe('Rain-slick alley');
  });

  it('leaves an existing name untouched', async () => {
    const { hostId, artworkId } = await seedArtwork({ name: 'Hero shot' });

    await describeArtwork({ projectId, hostType: 'character', hostId, artworkId });

    const after = await readArtwork('character', hostId, artworkId);
    expect(after.name).toBe('Hero shot');
    expect(after.description).toContain('narrow alley');
  });

  it('uses the character describer for character hosts', async () => {
    const { hostId, artworkId } = await seedArtwork({ hostType: 'character' });

    await describeArtwork({ projectId, hostType: 'character', hostId, artworkId });

    expect(describeMock.mock.calls[0][0].kind).toBe('character');
  });

  it('uses the location describer for set hosts', async () => {
    const { hostId, artworkId } = await seedArtwork({ hostType: 'set' });

    await describeArtwork({ projectId, hostType: 'set', hostId, artworkId });

    expect(describeMock.mock.calls[0][0].kind).toBe('location');
  });

  it('reuses a supplied buffer instead of re-downloading from GridFS', async () => {
    const { hostId, artworkId } = await seedArtwork();

    await describeArtwork({
      projectId,
      hostType: 'character',
      hostId,
      artworkId,
      buffer: TINY_PNG,
      contentType: 'image/png',
    });

    expect(readImageBufferMock).not.toHaveBeenCalled();
    expect(describeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the artwork has no result image to look at', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae' });
    const { artwork } = await Artworks.createPendingArtwork({
      projectId,
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });

    await expect(
      describeArtwork({
        projectId,
        hostType: 'character',
        hostId: c._id.toString(),
        artworkId: artwork._id.toString(),
      }),
    ).rejects.toThrow(/no result image/i);
    expect(describeMock).not.toHaveBeenCalled();
  });

  it('leaves the artwork alone when the vision pass returns nothing', async () => {
    const { hostId, artworkId } = await seedArtwork({ name: 'Hero shot' });
    describeMock.mockResolvedValueOnce({ name: '', description: '' });

    await describeArtwork({ projectId, hostType: 'character', hostId, artworkId });

    const after = await readArtwork('character', hostId, artworkId);
    expect(after.description).toBe('');
    expect(after.name).toBe('Hero shot');
  });
});

describe('kickoffArtworkVisionSeed', () => {
  it('describes the artwork in the background', async () => {
    const { hostId, artworkId } = await seedArtwork();

    kickoffArtworkVisionSeed({ projectId, hostType: 'character', hostId, artworkId });
    await flushQueue();

    const after = await readArtwork('character', hostId, artworkId);
    expect(after.description).toContain('narrow alley');
  });

  it('dedups concurrent kickoffs for the same artwork', async () => {
    const { hostId, artworkId } = await seedArtwork();

    kickoffArtworkVisionSeed({ projectId, hostType: 'character', hostId, artworkId });
    kickoffArtworkVisionSeed({ projectId, hostType: 'character', hostId, artworkId });
    kickoffArtworkVisionSeed({ projectId, hostType: 'character', hostId, artworkId });
    await flushQueue();

    expect(describeMock).toHaveBeenCalledTimes(1);
  });

  it('swallows describer failures instead of rejecting', async () => {
    const { hostId, artworkId } = await seedArtwork();
    describeMock.mockRejectedValueOnce(new Error('vision exploded'));

    expect(() =>
      kickoffArtworkVisionSeed({ projectId, hostType: 'character', hostId, artworkId }),
    ).not.toThrow();
    await flushQueue();

    const after = await readArtwork('character', hostId, artworkId);
    expect(after.description).toBe('');
  });
});
