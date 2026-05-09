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

const Images = await import('../src/mongo/images.js');
const { kickoffLibraryVisionSeed } = await import('../src/web/libraryVisionWorker.js');

beforeEach(() => {
  fakeDb.reset();
  analyzeMock.mockClear();
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

  it('does nothing when the buffer is missing', async () => {
    const doc = seedLibrary();
    kickoffLibraryVisionSeed(doc._id, null, 'image/png');
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
});
