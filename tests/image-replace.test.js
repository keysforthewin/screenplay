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
// GridFS bucket isn't usable against the in-memory fake; stub the file ops
// we rely on so the gateway's `deleteImage` call after replace doesn't crash.
const deletedImageIds = [];
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    deleteImage: async (id) => {
      deletedImageIds.push(String(id));
    },
  };
});

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Gateway = await import('../src/web/gateway.js');

beforeEach(() => {
  fakeDb.reset();
  deletedImageIds.length = 0;
});

describe('mongo: replaceBeatImage', () => {
  it('swaps the meta in place and preserves slot order; promotes new image to main if old was main', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const old1 = new ObjectId();
    const old2 = new ObjectId();
    await Plots.pushBeatImage(b._id.toString(), {
      _id: old1,
      filename: 'a.png',
      content_type: 'image/png',
      size: 1,
    });
    await Plots.pushBeatImage(b._id.toString(), {
      _id: old2,
      filename: 'b.png',
      content_type: 'image/png',
      size: 1,
    });
    // First image is auto-promoted to main.
    let plot = await Plots.getPlot();
    let beat = plot.beats.find((x) => x._id.equals(b._id));
    expect(beat.main_image_id.equals(old1)).toBe(true);

    const newId = new ObjectId();
    const result = await Plots.replaceBeatImage(b._id.toString(), old1, {
      _id: newId,
      filename: 'new.png',
      content_type: 'image/png',
      size: 1,
    });
    expect(result.was_main).toBe(true);
    expect(result.new_image_id.equals(newId)).toBe(true);

    plot = await Plots.getPlot();
    beat = plot.beats.find((x) => x._id.equals(b._id));
    expect(beat.images.map((i) => i._id.toString())).toEqual([
      newId.toString(),
      old2.toString(),
    ]);
    expect(beat.main_image_id.equals(newId)).toBe(true);
  });

  it('throws when the old image is not on the beat', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    await expect(
      Plots.replaceBeatImage(b._id.toString(), new ObjectId(), {
        _id: new ObjectId(),
        filename: 'x.png',
        content_type: 'image/png',
        size: 1,
      }),
    ).rejects.toThrow(/not attached/);
  });
});

describe('mongo: replaceCharacterImage', () => {
  it('swaps the meta in place and carries main-image status', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const old = new ObjectId();
    await fakeDb
      .collection('characters')
      .updateOne(
        { _id: c._id },
        {
          $set: {
            images: [
              { _id: old, filename: 'a.png', content_type: 'image/png', size: 1 },
            ],
            main_image_id: old,
          },
        },
      );
    const newId = new ObjectId();
    const result = await Characters.replaceCharacterImage(c._id.toString(), old, {
      _id: newId,
      filename: 'new.png',
      content_type: 'image/png',
      size: 1,
    });
    expect(result.was_main).toBe(true);
    const after = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(after.images).toHaveLength(1);
    expect(after.images[0]._id.equals(newId)).toBe(true);
    expect(after.main_image_id.equals(newId)).toBe(true);
  });
});

describe('gateway: replaceBeatImageViaGateway deletes old gridfs bytes', () => {
  it('passes through to mongo replace, then drops the old image bytes', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const old = new ObjectId();
    await Plots.pushBeatImage(b._id.toString(), {
      _id: old,
      filename: 'a.png',
      content_type: 'image/png',
      size: 1,
    });
    const newId = new ObjectId();
    await Gateway.replaceBeatImageViaGateway({
      beatId: b._id.toString(),
      oldImageId: old,
      newImageMeta: {
        _id: newId,
        filename: 'new.png',
        content_type: 'image/png',
        size: 1,
      },
    });
    expect(deletedImageIds).toContain(old.toString());
  });
});

describe('gateway: replaceCharacterImageViaGateway deletes old gridfs bytes', () => {
  it('passes through to mongo replace, then drops the old image bytes', async () => {
    const c = await Characters.createCharacter({ name: 'Bronze Leopard' });
    const old = new ObjectId();
    await fakeDb
      .collection('characters')
      .updateOne(
        { _id: c._id },
        { $set: { images: [{ _id: old, filename: 'a.png', content_type: 'image/png' }], main_image_id: old } },
      );
    const newId = new ObjectId();
    await Gateway.replaceCharacterImageViaGateway({
      character: c._id.toString(),
      oldImageId: old,
      newImageMeta: {
        _id: newId,
        filename: 'new.png',
        content_type: 'image/png',
        size: 1,
      },
    });
    expect(deletedImageIds).toContain(old.toString());
  });
});
