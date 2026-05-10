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
vi.mock('../src/rag/queue.js', () => ({
  enqueueReindex: () => {},
}));
vi.mock('../src/rag/indexer.js', () => ({
  deleteEntity: async () => {},
}));

const analyzeMock = vi.fn(async () => ({
  name: 'Diner at dusk',
  description: 'A neon-lit diner glowing under a darkening sky.',
}));
vi.mock('../src/llm/libraryImageMeta.js', () => ({
  analyzeLibraryImage: analyzeMock,
}));

// Owner-typed (beat / character / storyboard reference) uploads use the
// detailed describer instead of the terse library caption. Mock it here so
// the test asserts on the same fake response shape regardless of which
// describer the worker dispatches to.
const describeMock = vi.fn(async () => ({
  name: 'Diner at dusk',
  description: 'A neon-lit diner glowing under a darkening sky.',
}));
vi.mock('../src/llm/referenceImageDescription.js', () => ({
  describeReferenceImage: describeMock,
  REFERENCE_KINDS: ['auto', 'character', 'location', 'prop'],
}));

const Images = await import('../src/mongo/images.js');
const { kickoffLibraryVisionSeed, kickoffImageVisionSeed } = await import('../src/web/libraryVisionWorker.js');

beforeEach(() => {
  fakeDb.reset();
  analyzeMock.mockClear();
  describeMock.mockClear();
});

function seedLibrary() {
  const doc = {
    _id: new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      owner_type: null,
      owner_id: null,
      source: 'upload',
      prompt: null,
      generated_by: null,
      name: '',
      description: '',
      name_lower: '',
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

async function flushQueue() {
  // queueMicrotask schedules onto the microtask queue; awaiting a few ticks
  // here is enough to let it run + the awaited gateway write.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('library vision seed worker', () => {
  it('writes name + description back to Mongo via the gateway fallback', async () => {
    const doc = seedLibrary();
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    kickoffLibraryVisionSeed(doc._id, buf, 'image/png');
    await flushQueue();

    expect(analyzeMock).toHaveBeenCalledTimes(1);
    expect(analyzeMock.mock.calls[0][0]).toBe(buf);
    expect(analyzeMock.mock.calls[0][1]).toBe('image/png');

    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('Diner at dusk');
    expect(after.metadata.description).toBe('A neon-lit diner glowing under a darkening sky.');
    expect(after.metadata.name_lower).toBe('diner at dusk');
  });

  it('skips the write when the LLM returns nothing', async () => {
    const doc = seedLibrary();
    analyzeMock.mockResolvedValueOnce({ name: '', description: '' });

    kickoffLibraryVisionSeed(doc._id, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
    await flushQueue();

    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('');
    expect(after.metadata.description).toBe('');
  });

  it('skips silently when the image does not exist in GridFS', async () => {
    // No buffer + an unknown image id → worker tries GridFS download via
    // readImageBuffer, which returns null (file not found), and the worker
    // logs+exits without calling the LLM.
    kickoffLibraryVisionSeed(new ObjectId(), null, null);
    await flushQueue();
    expect(analyzeMock).not.toHaveBeenCalled();
  });

  it('exposes name + description through Images.searchLibraryImages after seeding', async () => {
    const doc = seedLibrary();
    kickoffLibraryVisionSeed(doc._id, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
    await flushQueue();

    const found = await Images.searchLibraryImages({ query: 'diner' });
    expect(found).toHaveLength(1);
    expect(found[0]._id.toString()).toBe(doc._id.toString());
  });

  it('routes character-owned images through setOwnedImageMeta (not the library setter)', async () => {
    const charOwnerId = new ObjectId();
    const doc = {
      _id: new ObjectId(),
      filename: 'c.png',
      contentType: 'image/png',
      length: 100,
      uploadDate: new Date(),
      metadata: {
        owner_type: 'character',
        owner_id: charOwnerId,
        source: 'upload',
        prompt: null,
        generated_by: null,
        name: '',
        description: '',
        name_lower: '',
      },
    };
    fakeDb.collection('images.files')._docs.push(doc);

    kickoffImageVisionSeed(doc._id, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', {
      ownerType: 'character',
      ownerId: charOwnerId,
    });
    await flushQueue();

    // Character-owned images go through the detailed describer (not the
    // terse library caption) and the setOwnedImageMeta writer.
    expect(describeMock).toHaveBeenCalledTimes(1);
    expect(analyzeMock).not.toHaveBeenCalled();
    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('Diner at dusk');
    expect(after.metadata.description).toBe('A neon-lit diner glowing under a darkening sky.');
    expect(after.metadata.owner_type).toBe('character');
  });

  it('dedups concurrent kickoffs for the same image id', async () => {
    const doc = seedLibrary();
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    kickoffImageVisionSeed(doc._id, buf, 'image/png');
    kickoffImageVisionSeed(doc._id, buf, 'image/png');
    kickoffImageVisionSeed(doc._id, buf, 'image/png');
    await flushQueue();
    expect(analyzeMock).toHaveBeenCalledTimes(1);
  });
});
