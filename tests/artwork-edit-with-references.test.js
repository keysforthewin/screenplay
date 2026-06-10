// startEditArtworkJob with reference_image_ids: the edit job loads the
// existing artwork result image AND each reference image, then forwards
// them to the dispatcher via runProviderForEdit (mode='edit'). The
// dispatcher itself prepends refs and appends the existing image — that
// ordering is already covered in tests/artwork-dispatch.test.js. Here we
// verify the artwork-job layer correctly threads the new
// referenceImageIds param all the way through.

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

const imageBlobs = new Map();
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async (id) => {
    const key = String(id);
    if (!imageBlobs.has(key)) return null;
    return imageBlobs.get(key);
  }),
  uploadGeneratedImage: vi.fn(async (_projectId, { filename }) => ({
    _id: new ObjectId(),
    filename,
    contentType: 'image/png',
    metadata: {},
  })),
}));

const dispatchSpy = vi.fn();
vi.mock('../src/web/imageReplaceDispatch.js', () => ({
  dispatchImageReplace: (...args) => dispatchSpy(...args),
  ALLOWED_IMAGE_MODELS: ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai'],
}));

vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: vi.fn(async () => {}),
}));

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Artworks = await import('../src/mongo/artworks.js');
const ArtworkJobs = await import('../src/web/artworkJobs.js');

function registerImage(id, label) {
  const oid = id instanceof ObjectId ? id : new ObjectId(String(id));
  imageBlobs.set(String(oid), {
    buffer: Buffer.from(label),
    file: { contentType: 'image/png', metadata: {} },
  });
  return oid;
}

// Resolve once the background setImmediate task finishes by polling the
// artwork status — the job flips it to 'pending' before scheduling and
// the dispatcher mock runs synchronously inside setImmediate, so a few
// macrotask flushes are enough.
async function waitForDispatch() {
  for (let i = 0; i < 200; i++) {
    if (dispatchSpy.mock.calls.length > 0) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('dispatchImageReplace was not called');
}

beforeEach(() => {
  fakeDb.reset();
  imageBlobs.clear();
  dispatchSpy.mockReset();
  dispatchSpy.mockResolvedValue({
    buffer: Buffer.from('out'),
    contentType: 'image/png',
    model: 'fal-ai/nano-banana-pro/edit',
  });
});

describe('startEditArtworkJob with reference_image_ids', () => {
  it('forwards references + the artwork\'s existing result image to the dispatcher', async () => {
    const character = await Characters.createCharacter({ name: 'Rae' });
    const existingResultId = registerImage(new ObjectId(), 'EXISTING');
    const ref1 = registerImage(new ObjectId(), 'REF-1');
    const ref2 = registerImage(new ObjectId(), 'REF-2');

    const { artwork: seeded } = await Artworks.appendDoneArtwork({
      hostType: 'character',
      hostId: character._id,
      resultImageId: existingResultId,
      name: 'seed',
    });

    await ArtworkJobs.startEditArtworkJob({
      hostType: 'character',
      hostId: character._id,
      artworkId: seeded._id,
      prompt: 'add the hat from the reference',
      model: 'nano-banana-pro',
      referenceImageIds: [ref1, ref2],
    });

    await waitForDispatch();

    expect(dispatchSpy).toHaveBeenCalledOnce();
    const arg = dispatchSpy.mock.calls[0][0];
    expect(arg.mode).toBe('edit');
    expect(arg.model).toBe('nano-banana-pro');
    expect(arg.prompt).toBe('add the hat from the reference');
    expect(arg.existingImage?.buffer?.toString()).toBe('EXISTING');
    expect(arg.referenceImages).toHaveLength(2);
    expect(arg.referenceImages[0].buffer.toString()).toBe('REF-1');
    expect(arg.referenceImages[1].buffer.toString()).toBe('REF-2');
  });

  it('defaults to no references (existing image only)', async () => {
    const beat = await Plots.createBeat({ name: 'Cold open' });
    const existingResultId = registerImage(new ObjectId(), 'EXISTING');

    const { artwork: seeded } = await Artworks.appendDoneArtwork({
      hostType: 'beat',
      hostId: beat._id,
      resultImageId: existingResultId,
      name: 'seed',
    });

    await ArtworkJobs.startEditArtworkJob({
      hostType: 'beat',
      hostId: beat._id,
      artworkId: seeded._id,
      prompt: 'subtle tweak',
      model: 'nano-banana-pro',
    });

    await waitForDispatch();

    const arg = dispatchSpy.mock.calls[0][0];
    expect(arg.referenceImages).toEqual([]);
    expect(arg.existingImage?.buffer?.toString()).toBe('EXISTING');
  });
});
