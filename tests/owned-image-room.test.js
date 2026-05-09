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
vi.mock('../src/rag/indexer.js', () => ({}));

const { resolveRoom } = await import('../src/web/roomRegistry.js');

beforeEach(() => {
  fakeDb.reset();
});

function seedImageFile({ id, ownerType, ownerId, name = '', description = '' }) {
  const doc = {
    _id: id || new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerId,
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

describe('owned-image fragments on character/beat rooms', () => {
  it('describeCharacterRoom seeds image:<id>:name and image:<id>:description from GridFS metadata', async () => {
    const charId = new ObjectId();
    const imgA = new ObjectId();
    const imgB = new ObjectId();
    fakeDb.collection('characters')._docs.push({
      _id: charId,
      name: 'Sheriff',
      name_lower: 'sheriff',
      hollywood_actor: '',
      images: [
        { _id: imgA, filename: 'a.png' },
        { _id: imgB, filename: 'b.png' },
      ],
      main_image_id: null,
    });
    seedImageFile({ id: imgA, ownerType: 'character', ownerId: charId, name: 'Brooding sheriff', description: 'sundown' });
    seedImageFile({ id: imgB, ownerType: 'character', ownerId: charId, name: '', description: '' });

    const desc = await resolveRoom(`character:${charId}`);
    expect(desc).toBeTruthy();
    expect(desc.fields).toEqual(
      expect.arrayContaining([
        `image:${imgA}:name`,
        `image:${imgA}:description`,
        `image:${imgB}:name`,
        `image:${imgB}:description`,
      ]),
    );
    expect(desc.seed[`image:${imgA}:name`]).toBe('Brooding sheriff');
    expect(desc.seed[`image:${imgA}:description`]).toBe('sundown');
    expect(desc.seed[`image:${imgB}:name`]).toBe('');
  });

  it('character room persistFields routes image:<id>:name back to GridFS metadata', async () => {
    const charId = new ObjectId();
    const imgA = new ObjectId();
    fakeDb.collection('characters')._docs.push({
      _id: charId,
      name: 'Sheriff',
      name_lower: 'sheriff',
      hollywood_actor: '',
      images: [{ _id: imgA, filename: 'a.png' }],
      main_image_id: null,
    });
    seedImageFile({ id: imgA, ownerType: 'character', ownerId: charId, name: 'old', description: 'old desc' });

    const desc = await resolveRoom(`character:${charId}`);
    const result = await desc.persistFields({
      [`image:${imgA}:name`]: 'NEW NAME',
      [`image:${imgA}:description`]: 'old desc',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual([`image:${imgA}:name`]);

    const after = await fakeDb.collection('images.files').findOne({ _id: imgA });
    expect(after.metadata.name).toBe('NEW NAME');
    expect(after.metadata.name_lower).toBe('new name');
    expect(after.metadata.description).toBe('old desc');
  });

  it('describeBeatRoom seeds image fragments from beat.images and updates them on persist', async () => {
    const plotId = 'main';
    const beatId = new ObjectId();
    const imgA = new ObjectId();
    fakeDb.collection('plots')._docs.push({
      _id: plotId,
      title: 'P',
      synopsis: '',
      beats: [
        {
          _id: beatId,
          order: 1,
          name: 'Open',
          desc: '',
          body: '',
          images: [{ _id: imgA, filename: 'a.png', content_type: 'image/png' }],
          main_image_id: null,
        },
      ],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    });
    seedImageFile({ id: imgA, ownerType: 'beat', ownerId: beatId, name: 'Wide', description: 'shot' });

    const desc = await resolveRoom(`beat:${beatId}`);
    expect(desc).toBeTruthy();
    expect(desc.fields).toEqual(
      expect.arrayContaining([`image:${imgA}:name`, `image:${imgA}:description`]),
    );
    expect(desc.seed[`image:${imgA}:name`]).toBe('Wide');

    const result = await desc.persistFields({
      [`image:${imgA}:description`]: 'updated description',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual([`image:${imgA}:description`]);
    const after = await fakeDb.collection('images.files').findOne({ _id: imgA });
    expect(after.metadata.description).toBe('updated description');
  });

  it('describeBeatRoom returns no image fragments when the beat has no images', async () => {
    const beatId = new ObjectId();
    fakeDb.collection('plots')._docs.push({
      _id: 'main',
      title: 'P',
      synopsis: '',
      beats: [
        {
          _id: beatId,
          order: 1,
          name: 'Open',
          desc: '',
          body: '',
          images: [],
          main_image_id: null,
        },
      ],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    });

    const desc = await resolveRoom(`beat:${beatId}`);
    const imageFields = desc.fields.filter((f) => f.startsWith('image:'));
    expect(imageFields).toEqual([]);
  });
});
