// Every rendered plate gets described automatically. generateArtworkImageInline
// is the single choke point shared by the generate route, the regenerate route,
// and the image-sheet batch worker, so hooking the vision seed there covers all
// three. The in-line edit path (startEditArtworkJob) re-describes too, since the
// picture has changed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const RENDERED_PNG = Buffer.from('rendered-plate-bytes');

// artworkJobs uploads through uploadGeneratedImage and reads references through
// readImageBuffer; the vision worker reads the finished plate back through the
// same readImageBuffer. Keep one blob store behind both.
const imageBlobs = new Map();
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readImageBuffer: vi.fn(async (id) => imageBlobs.get(String(id)) || null),
  uploadGeneratedImage: vi.fn(async (_projectId, { filename, buffer, contentType }) => {
    const file = { _id: new ObjectId(), filename, contentType: contentType || 'image/png', metadata: {} };
    imageBlobs.set(String(file._id), { buffer, file });
    return file;
  }),
}));

vi.mock('../src/web/imageReplaceDispatch.js', () => ({
  dispatchImageReplace: vi.fn(async () => ({
    buffer: RENDERED_PNG,
    contentType: 'image/png',
    model: 'nano-banana-pro',
  })),
  ALLOWED_IMAGE_MODELS: ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai'],
}));

vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: vi.fn(async () => {}),
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
const Sets = await import('../src/mongo/sets.js');
const Artworks = await import('../src/mongo/artworks.js');
const ArtworkJobs = await import('../src/web/artworkJobs.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  imageBlobs.clear();
  describeMock.mockClear();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function flushQueue() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe('generateArtworkImageInline auto-describe', () => {
  it('describes the plate it just rendered', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    const hostId = set._id.toString();
    const { artwork } = await Artworks.createPendingArtwork({
      projectId,
      hostType: 'set',
      hostId,
      prompt: 'sodium-lit alley, wet asphalt',
      model: 'nano-banana-pro',
    });

    await ArtworkJobs.generateArtworkImageInline({
      projectId,
      hostType: 'set',
      hostId,
      artworkId: artwork._id.toString(),
      prompt: 'sodium-lit alley, wet asphalt',
      model: 'nano-banana-pro',
    });
    await flushQueue();

    const out = await Artworks.getArtwork({
      projectId,
      hostType: 'set',
      hostId,
      artworkId: artwork._id.toString(),
    });
    expect(out.artwork.description).toBe(
      'A narrow alley under sodium light, puddles reflecting neon signage.',
    );
  });

  it('hands the freshly rendered bytes to the describer instead of re-reading GridFS', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    const hostId = set._id.toString();
    const { artwork } = await Artworks.createPendingArtwork({
      projectId,
      hostType: 'set',
      hostId,
      prompt: 'p',
      model: 'nano-banana-pro',
    });

    await ArtworkJobs.generateArtworkImageInline({
      projectId,
      hostType: 'set',
      hostId,
      artworkId: artwork._id.toString(),
      prompt: 'p',
      model: 'nano-banana-pro',
    });
    await flushQueue();

    expect(describeMock).toHaveBeenCalledTimes(1);
    expect(describeMock.mock.calls[0][0].buffer).toBe(RENDERED_PNG);
  });

  it('still returns the rendered file when the describer blows up', async () => {
    describeMock.mockRejectedValueOnce(new Error('vision exploded'));
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    const hostId = set._id.toString();
    const { artwork } = await Artworks.createPendingArtwork({
      projectId,
      hostType: 'set',
      hostId,
      prompt: 'p',
      model: 'nano-banana-pro',
    });

    const result = await ArtworkJobs.generateArtworkImageInline({
      projectId,
      hostType: 'set',
      hostId,
      artworkId: artwork._id.toString(),
      prompt: 'p',
      model: 'nano-banana-pro',
    });
    await flushQueue();

    expect(result.fileId).toBeTruthy();
    const out = await Artworks.getArtwork({
      projectId,
      hostType: 'set',
      hostId,
      artworkId: artwork._id.toString(),
    });
    expect(out.artwork.status).toBe('done');
    expect(out.artwork.description).toBe('');
  });
});
