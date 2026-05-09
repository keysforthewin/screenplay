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

const Images = await import('../src/mongo/images.js');

beforeEach(() => {
  fakeDb.reset();
});

function seedOwnedImage({ ownerType = 'character', ownerId, name = '', description = '' } = {}) {
  const doc = {
    _id: new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerId || new ObjectId(),
      source: 'upload',
      prompt: null,
      generated_by: null,
      name,
      description,
      name_lower: name.toLowerCase(),
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('setOwnedImageMeta', () => {
  it('writes name + description on a character-owned image and recomputes name_lower', async () => {
    const doc = seedOwnedImage({ ownerType: 'character' });
    const result = await Images.setOwnedImageMeta(doc._id, {
      name: '**Brooding** sheriff',
      description: 'A weary sheriff at sundown.',
    });
    expect(result.changed).toBe(true);
    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('**Brooding** sheriff');
    expect(after.metadata.description).toBe('A weary sheriff at sundown.');
    expect(after.metadata.name_lower).toBe('brooding sheriff');
  });

  it('writes name + description on a beat-owned image too', async () => {
    const doc = seedOwnedImage({ ownerType: 'beat' });
    await Images.setOwnedImageMeta(doc._id, { name: 'Diner', description: 'neon' });
    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('Diner');
    expect(after.metadata.description).toBe('neon');
  });

  it('accepts partial patches', async () => {
    const doc = seedOwnedImage({ ownerType: 'character', name: 'Old', description: 'keep me' });
    await Images.setOwnedImageMeta(doc._id, { name: 'New' });
    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('New');
    expect(after.metadata.description).toBe('keep me');
  });

  it('throws if the image does not exist', async () => {
    await expect(
      Images.setOwnedImageMeta(new ObjectId(), { name: 'x' }),
    ).rejects.toThrow(/Image not found/);
  });

  it('returns no-op when nothing supplied', async () => {
    const doc = seedOwnedImage({ ownerType: 'character', name: 'Untouched' });
    const result = await Images.setOwnedImageMeta(doc._id, {});
    expect(result.changed).toBe(false);
    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('Untouched');
  });
});
