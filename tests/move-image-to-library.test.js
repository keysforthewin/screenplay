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

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Gateway = await import('../src/web/gateway.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
});

function seedOwnedImage({ ownerType, ownerId, _id }) {
  const doc = {
    _id: _id || new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 1,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerId,
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

describe('gateway: moveBeatImageToLibraryViaGateway', () => {
  it('detaches the image from the beat and clears the owner metadata', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const imageId = new ObjectId();
    seedOwnedImage({ ownerType: 'beat', ownerId: b._id, _id: imageId });
    await Plots.pushBeatImage(b._id.toString(), {
      _id: imageId,
      filename: 'a.png',
      content_type: 'image/png',
      size: 1,
    });

    await Gateway.moveBeatImageToLibraryViaGateway({
      beatId: b._id.toString(),
      imageId: imageId.toString(),
    });

    const plot = await Plots.getPlot();
    const beat = plot.beats.find((x) => x._id.equals(b._id));
    expect(beat.images).toHaveLength(0);
    expect(beat.main_image_id).toBeNull();

    const fileAfter = await fakeDb
      .collection('images.files')
      .findOne({ _id: imageId });
    expect(fileAfter.metadata.owner_type).toBeNull();
    expect(fileAfter.metadata.owner_id).toBeNull();
  });
});

describe('gateway: moveCharacterImageToLibraryViaGateway', () => {
  it('detaches the image from the character and clears the owner metadata', async () => {
    const c = await Characters.createCharacter({ name: 'Iris' });
    const imageId = new ObjectId();
    seedOwnedImage({ ownerType: 'character', ownerId: c._id, _id: imageId });
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          images: [
            { _id: imageId, filename: 'a.png', content_type: 'image/png', size: 1 },
          ],
          main_image_id: imageId,
        },
      },
    );

    await Gateway.moveCharacterImageToLibraryViaGateway({
      character: c._id.toString(),
      imageId: imageId.toString(),
    });

    const after = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(after.images).toHaveLength(0);
    expect(after.main_image_id).toBeNull();

    const fileAfter = await fakeDb
      .collection('images.files')
      .findOne({ _id: imageId });
    expect(fileAfter.metadata.owner_type).toBeNull();
    expect(fileAfter.metadata.owner_id).toBeNull();
  });
});

describe('handler: move_image_to_library', () => {
  it('moves a beat-owned image to the library', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const imageId = new ObjectId();
    seedOwnedImage({ ownerType: 'beat', ownerId: b._id, _id: imageId });
    await Plots.pushBeatImage(b._id.toString(), {
      _id: imageId,
      filename: 'a.png',
      content_type: 'image/png',
      size: 1,
    });

    const result = await HANDLERS.move_image_to_library({
      image_id: imageId.toString(),
    });
    expect(result).toMatch(/Moved image .* to the library/);

    const fileAfter = await fakeDb
      .collection('images.files')
      .findOne({ _id: imageId });
    expect(fileAfter.metadata.owner_type).toBeNull();
  });

  it('moves a character-owned image to the library', async () => {
    const c = await Characters.createCharacter({ name: 'Iris' });
    const imageId = new ObjectId();
    seedOwnedImage({ ownerType: 'character', ownerId: c._id, _id: imageId });
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          images: [{ _id: imageId, filename: 'a.png', content_type: 'image/png' }],
          main_image_id: imageId,
        },
      },
    );

    const result = await HANDLERS.move_image_to_library({
      image_id: imageId.toString(),
    });
    expect(result).toMatch(/Moved image .* to the library/);

    const fileAfter = await fakeDb
      .collection('images.files')
      .findOne({ _id: imageId });
    expect(fileAfter.metadata.owner_type).toBeNull();
  });

  it('returns a friendly message when the image is already in the library', async () => {
    const imageId = new ObjectId();
    fakeDb.collection('images.files')._docs.push({
      _id: imageId,
      filename: 'a.png',
      contentType: 'image/png',
      length: 1,
      uploadDate: new Date(),
      metadata: { owner_type: null, owner_id: null },
    });
    const result = await HANDLERS.move_image_to_library({
      image_id: imageId.toString(),
    });
    expect(result).toMatch(/already in the library/);
  });

  it('returns an error when the image_id is unknown', async () => {
    const result = await HANDLERS.move_image_to_library({
      image_id: new ObjectId().toString(),
    });
    expect(result).toMatch(/image not found/i);
  });

  it('returns an error when image_id is missing', async () => {
    const result = await HANDLERS.move_image_to_library({});
    expect(result).toMatch(/image_id required/);
  });
});
