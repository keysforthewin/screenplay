// Validator parity tests for setMainCharacterImage / setBeatMainImage:
// the main image may now be either an entry in images[] or the
// result_image_id of a `done` artwork on the host.

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

const Files = await import('../src/mongo/files.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const Artworks = await import('../src/mongo/artworks.js');

beforeEach(() => {
  fakeDb.reset();
});

function makeMeta() {
  return {
    _id: new ObjectId(),
    filename: 'x.png',
    content_type: 'image/png',
    size: 1,
    uploaded_at: new Date(),
    caption: null,
  };
}

describe('setMainCharacterImage — artwork source', () => {
  it('accepts a done artwork result_image_id and sets main', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    const resultId = new ObjectId();
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: resultId,
    });

    const out = await Files.setMainCharacterImage({
      character: c._id.toString(),
      imageId: resultId.toString(),
    });
    expect(out.main_image_id.equals(resultId)).toBe(true);

    const fresh = await Characters.getCharacter(undefined, 'Rae');
    expect(fresh.main_image_id.equals(resultId)).toBe(true);
  });

  it('rejects a pending artwork (no result yet)', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    // Synthesize an id that is not present anywhere on the host
    const ghost = new ObjectId();
    await expect(
      Files.setMainCharacterImage({
        character: c._id.toString(),
        imageId: ghost.toString(),
      }),
    ).rejects.toThrow(/not attached/i);
    // And the artwork itself is still pending — its (null) result_image_id
    // can't be referenced.
    expect(artwork.result_image_id).toBeNull();
  });

  it('still accepts a regular images[] entry (no regression)', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const meta = makeMeta();
    await Characters.pushCharacterImage(undefined, c._id.toString(), meta, false);
    const out = await Files.setMainCharacterImage({
      character: c._id.toString(),
      imageId: meta._id.toString(),
    });
    expect(out.main_image_id.equals(meta._id)).toBe(true);
  });

  it('rejects an id that is neither in images[] nor an artwork result', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Files.setMainCharacterImage({
        character: c._id.toString(),
        imageId: new ObjectId().toString(),
      }),
    ).rejects.toThrow(/not attached/i);
  });
});

describe('setBeatMainImage — artwork source', () => {
  it('accepts a done artwork result_image_id on a beat', async () => {
    const b = await Plots.createBeat({ name: 'Cold open' });
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: b._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    const resultId = new ObjectId();
    await Artworks.setArtworkResult({
      hostType: 'beat',
      hostId: b._id.toString(),
      artworkId: artwork._id,
      resultImageId: resultId,
    });

    const updated = await Plots.setBeatMainImage(undefined, b._id.toString(), resultId);
    expect(updated.main_image_id.equals(resultId)).toBe(true);
  });

  it('still accepts a regular images[] entry on a beat (no regression)', async () => {
    const b = await Plots.createBeat({ name: 'Cold open' });
    const meta = makeMeta();
    await Plots.pushBeatImage(undefined, b._id.toString(), meta, false);
    const updated = await Plots.setBeatMainImage(undefined, b._id.toString(), meta._id);
    expect(updated.main_image_id.equals(meta._id)).toBe(true);
  });

  it('rejects an id that is neither in images[] nor an artwork result', async () => {
    const b = await Plots.createBeat({ name: 'Cold open' });
    await expect(
      Plots.setBeatMainImage(undefined, b._id.toString(), new ObjectId()),
    ).rejects.toThrow(/not attached/i);
  });
});
