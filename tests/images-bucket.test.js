import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Images = await import('../src/mongo/images.js');

beforeEach(() => {
  fakeDb.reset();
});

function seedFile({ id, ownerType = null, ownerId = null, source = 'upload', prompt = null }) {
  const doc = {
    _id: id || new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerId,
      source,
      prompt,
      generated_by: source === 'generated' ? 'gemini-2.5-flash-image' : null,
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('images metadata helpers', () => {
  it('listLibraryImages returns only files with owner_type null', async () => {
    seedFile({ ownerType: null });
    seedFile({ ownerType: 'beat', ownerId: new ObjectId() });
    seedFile({ ownerType: null });

    const lib = await Images.listLibraryImages();
    expect(lib).toHaveLength(2);
    for (const f of lib) expect(f.metadata.owner_type).toBeNull();
  });

  it('listImagesForBeat filters by owner_type and owner_id', async () => {
    const beatA = new ObjectId();
    const beatB = new ObjectId();
    seedFile({ ownerType: 'beat', ownerId: beatA });
    seedFile({ ownerType: 'beat', ownerId: beatA });
    seedFile({ ownerType: 'beat', ownerId: beatB });

    const aImages = await Images.listImagesForBeat(beatA);
    expect(aImages).toHaveLength(2);
    for (const f of aImages) expect(f.metadata.owner_id.equals(beatA)).toBe(true);
  });

  it('setImageOwner flips ownership from library to a beat', async () => {
    const file = seedFile({ ownerType: null });
    const beatId = new ObjectId();

    await Images.setImageOwner(file._id, { ownerType: 'beat', ownerId: beatId });

    const after = await Images.findImageFile(file._id);
    expect(after.metadata.owner_type).toBe('beat');
    expect(after.metadata.owner_id.equals(beatId)).toBe(true);

    const lib = await Images.listLibraryImages();
    expect(lib).toHaveLength(0);

    const beatImages = await Images.listImagesForBeat(beatId);
    expect(beatImages).toHaveLength(1);
  });

  it('imageFileToMeta extracts the right fields', () => {
    const file = {
      _id: new ObjectId(),
      filename: 'gen.png',
      contentType: 'image/png',
      length: 1234,
      uploadDate: new Date('2025-01-01'),
      metadata: {
        owner_type: null,
        owner_id: null,
        source: 'generated',
        prompt: 'a cat',
        generated_by: 'gemini-2.5-flash-image',
      },
    };
    const meta = Images.imageFileToMeta(file);
    expect(meta.filename).toBe('gen.png');
    expect(meta.size).toBe(1234);
    expect(meta.source).toBe('generated');
    expect(meta.prompt).toBe('a cat');
    expect(meta.generated_by).toBe('gemini-2.5-flash-image');
  });

  it('ensureObjectId accepts strings and ObjectIds', () => {
    const oid = new ObjectId();
    expect(Images.ensureObjectId(oid)).toBe(oid);
    const fromStr = Images.ensureObjectId(oid.toString());
    expect(fromStr.equals(oid)).toBe(true);
  });
});
