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

const Characters = await import('../src/mongo/characters.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('character artwork helpers', () => {
  it('pushCharacterArtwork appends an artwork to the embedded array', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const artworkId = new ObjectId();
    const resultId = new ObjectId();
    const refA = new ObjectId();

    await Characters.pushCharacterArtwork(c._id.toString(), {
      _id: artworkId,
      prompt: 'cyberpunk warrior',
      model: 'fal',
      reference_image_ids: [refA],
      result_image_id: resultId,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const fresh = await Characters.getCharacter('Rae');
    expect(fresh.artworks).toHaveLength(1);
    expect(fresh.artworks[0].prompt).toBe('cyberpunk warrior');
    expect(fresh.artworks[0].model).toBe('fal');
    expect(fresh.artworks[0]._id.toString()).toBe(artworkId.toString());
  });

  it('replaceCharacterArtwork patches prompt, refs, and result_image_id in place', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const artworkId = new ObjectId();
    await Characters.pushCharacterArtwork(c._id.toString(), {
      _id: artworkId,
      prompt: 'first try',
      model: 'gemini',
      reference_image_ids: [],
      result_image_id: new ObjectId(),
      created_at: new Date(),
      updated_at: new Date(),
    });

    const newResultId = new ObjectId();
    const ref = new ObjectId();
    const updated = await Characters.replaceCharacterArtwork(c._id.toString(), artworkId, {
      prompt: 'second try, more vibes',
      model: 'fal',
      reference_image_ids: [ref],
      result_image_id: newResultId,
    });

    expect(updated.prompt).toBe('second try, more vibes');
    expect(updated.model).toBe('fal');
    expect(updated.result_image_id.toString()).toBe(newResultId.toString());
    const fresh = await Characters.getCharacter('Rae');
    expect(fresh.artworks).toHaveLength(1);
    expect(fresh.artworks[0].reference_image_ids).toHaveLength(1);
  });

  it('replaceCharacterArtwork throws when the artwork is not attached', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.replaceCharacterArtwork(c._id.toString(), new ObjectId(), { prompt: 'x' }),
    ).rejects.toThrow(/not attached/);
  });

  it('pullCharacterArtwork removes the entry and returns its result image id', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const artworkId = new ObjectId();
    const resultId = new ObjectId();
    await Characters.pushCharacterArtwork(c._id.toString(), {
      _id: artworkId,
      prompt: 'p',
      model: 'gemini',
      reference_image_ids: [],
      result_image_id: resultId,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const out = await Characters.pullCharacterArtwork(c._id.toString(), artworkId);
    expect(out.result_image_id.toString()).toBe(resultId.toString());
    const fresh = await Characters.getCharacter('Rae');
    expect(fresh.artworks).toEqual([]);
  });

  it('pullCharacterArtwork throws when the artwork is not attached', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.pullCharacterArtwork(c._id.toString(), new ObjectId()),
    ).rejects.toThrow(/not attached/);
  });
});
