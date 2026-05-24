// In-line edit mode with one-shot reference images:
// `editReferenceImageIds` are loaded from GridFS and passed to the image
// dispatcher alongside the existing frame, with the existing frame last
// (matching imageReplaceDispatch's refs-first ordering).

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
  uploadGeneratedImage: vi.fn(async ({ filename }) => ({
    _id: new ObjectId(),
    filename,
    contentType: 'image/png',
    metadata: {},
  })),
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');

beforeEach(() => {
  fakeDb.reset();
  imageBlobs.clear();
  Generate._setImageDispatcherForTests(null);
});

function registerImage(id, label = null) {
  const oid = id instanceof ObjectId ? id : new ObjectId(String(id));
  imageBlobs.set(String(oid), {
    buffer: Buffer.from(label || `bytes-${String(oid)}`),
    file: { contentType: 'image/png', metadata: {} },
  });
  return oid;
}

async function setupRow({ imageId = null } = {}) {
  const beat = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'b' });
  const sb = await Storyboards.createStoryboard({
    beatId: beat._id,
    textPrompt: 'A wide shot.',
    shotType: 'cinematic_wide',
    charactersInScene: ['Alice'],
  });
  const { frameId } = await Storyboards.addFrame(sb._id, { imageId });
  return { beat, sb: await Storyboards.getStoryboard(sb._id), frameId };
}

describe('regenerateStoryboardFrame (edit mode, editReferenceImageIds)', () => {
  it('forwards the existing frame first, then refs, to the dispatcher', async () => {
    const startId = registerImage(new ObjectId(), 'EXISTING');
    const ref1 = registerImage(new ObjectId(), 'REF-1');
    const ref2 = registerImage(new ObjectId(), 'REF-2');
    const { sb, frameId } = await setupRow({ imageId: startId });

    let captured;
    Generate._setImageDispatcherForTests(async (args) => {
      captured = args;
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      frameId,
      mode: 'edit',
      editPrompt: 'add the hat from the reference',
      editReferenceImageIds: [ref1, ref2],
    });

    expect(captured.mode).toBe('edit');
    expect(captured.prompt).toBe('add the hat from the reference');
    expect(captured.inputImages).toHaveLength(3);
    expect(captured.inputImages[0].buffer.toString()).toBe('EXISTING');
    expect(captured.inputImages[1].buffer.toString()).toBe('REF-1');
    expect(captured.inputImages[2].buffer.toString()).toBe('REF-2');
  });

  it('defaults to single-image edit when no refs are supplied', async () => {
    const startId = registerImage(new ObjectId(), 'EXISTING');
    const { sb, frameId } = await setupRow({ imageId: startId });

    let captured;
    Generate._setImageDispatcherForTests(async (args) => {
      captured = args;
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      frameId,
      mode: 'edit',
      editPrompt: 'tweak the lighting',
    });

    expect(captured.inputImages).toHaveLength(1);
    expect(captured.inputImages[0].buffer.toString()).toBe('EXISTING');
  });

  it('throws when a reference id is missing from GridFS', async () => {
    const startId = registerImage(new ObjectId(), 'EXISTING');
    const { sb, frameId } = await setupRow({ imageId: startId });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

    const missing = new ObjectId();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        frameId,
        mode: 'edit',
        editPrompt: 'tweak',
        editReferenceImageIds: [missing],
      }),
    ).rejects.toThrow(/Reference image .* not found/);
  });

  it('does NOT touch the persisted per-frame reference list', async () => {
    const startId = registerImage(new ObjectId(), 'EXISTING');
    const ref1 = registerImage(new ObjectId(), 'REF-1');
    const { sb, frameId } = await setupRow({ imageId: startId });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      frameId,
      mode: 'edit',
      editPrompt: 'tweak',
      editReferenceImageIds: [ref1],
    });

    const fresh = await Storyboards.getStoryboard(sb._id);
    const frame = fresh.frames.find((f) => f._id.toString() === String(frameId));
    expect(frame.reference_ids || []).toEqual([]);
  });
});
