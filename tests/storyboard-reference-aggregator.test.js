// Unit tests for the storyboard reference aggregator. Uses the fake Mongo
// helpers (not mocks) so the test exercises the real character lookup path.

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

const Characters = await import('../src/mongo/characters.js');
const {
  collectStoryboardReferenceIds,
} = await import('../src/web/storyboardReferenceAggregator.js');

beforeEach(() => fakeDb.reset());

// Synthesize a character with the modern image fields populated. The
// aggregator reads character_sheet_image_ids, main_image_id, and images[].
async function makeCharacter(name, { sheets = [], mainId = null, extraImages = [] } = {}) {
  const c = await Characters.createCharacter({ name });
  await fakeDb.collection('characters').updateOne(
    { _id: c._id },
    {
      $set: {
        character_sheet_image_ids: sheets,
        main_image_id: mainId,
        images: extraImages.map((id) => ({ _id: id })),
      },
    },
  );
  return Characters.getCharacter(name);
}

describe('collectStoryboardReferenceIds', () => {
  it('returns just the beat set image when no characters resolve', async () => {
    const setId = new ObjectId();
    const beat = { _id: new ObjectId(), images: [], main_image_id: setId };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: [],
      existingIds: [],
    });
    expect(result.ids).toEqual([setId.toString()]);
    expect(result.added).toEqual([setId.toString()]);
  });

  it('returns every id from beat.images plus main_image_id, deduped', async () => {
    const i1 = new ObjectId();
    const i2 = new ObjectId();
    const beat = {
      _id: new ObjectId(),
      images: [{ _id: i1 }, { _id: i2 }],
      main_image_id: i1, // already in images[] — should not duplicate
    };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: [],
      existingIds: [],
    });
    expect(result.ids).toEqual([i1.toString(), i2.toString()]);
  });

  it('pulls default sheet + remaining sheets + main + images for each in-scene character', async () => {
    const sheetA1 = new ObjectId();
    const sheetA2 = new ObjectId();
    const mainA = new ObjectId();
    const imgA = new ObjectId();
    await makeCharacter('Alice', {
      sheets: [sheetA1, sheetA2],
      mainId: mainA,
      extraImages: [imgA, mainA], // mainA already as main_image_id — dedupe
    });
    const beat = { _id: new ObjectId(), images: [], main_image_id: null };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: ['Alice'],
      existingIds: [],
    });
    expect(result.ids).toEqual([
      sheetA1.toString(),
      sheetA2.toString(),
      mainA.toString(),
      imgA.toString(),
    ]);
  });

  it('interleaves canonical-first: beat main + one signature image per character before extras', async () => {
    const beatMain = new ObjectId();
    const sheetA = new ObjectId();
    const portraitA = new ObjectId();
    const sheetB = new ObjectId();
    const portraitB = new ObjectId();
    await makeCharacter('Alice', { sheets: [sheetA], mainId: portraitA });
    await makeCharacter('Bob', { sheets: [sheetB], mainId: portraitB });
    const beat = { _id: new ObjectId(), images: [], main_image_id: beatMain };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: ['Alice', 'Bob'],
      existingIds: [],
    });
    expect(result.ids).toEqual([
      beatMain.toString(),
      sheetA.toString(),
      sheetB.toString(),
      portraitA.toString(),
      portraitB.toString(),
    ]);
  });

  it('skips unknown character names but still aggregates the rest', async () => {
    const sheetB = new ObjectId();
    await makeCharacter('Bob', { sheets: [sheetB] });
    const beat = { _id: new ObjectId(), images: [], main_image_id: null };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: ['Nonexistent', 'Bob'],
      existingIds: [],
    });
    expect(result.ids).toEqual([sheetB.toString()]);
  });

  it('strips markdown from character names before lookup', async () => {
    const sheet = new ObjectId();
    await makeCharacter('Alice', { sheets: [sheet] });
    const beat = { _id: new ObjectId(), images: [], main_image_id: null };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: ['**Alice**'],
      existingIds: [],
    });
    expect(result.ids).toEqual([sheet.toString()]);
  });

  it('dedupes ids that appear in both beat and character', async () => {
    const shared = new ObjectId();
    await makeCharacter('Alice', { mainId: shared });
    const beat = { _id: new ObjectId(), images: [{ _id: shared }], main_image_id: null };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: ['Alice'],
      existingIds: [],
    });
    expect(result.ids).toEqual([shared.toString()]);
  });

  it('excludes existingIds from `added` but keeps them in `ids`', async () => {
    const i1 = new ObjectId();
    const i2 = new ObjectId();
    const beat = {
      _id: new ObjectId(),
      images: [{ _id: i1 }, { _id: i2 }],
      main_image_id: null,
    };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: [],
      existingIds: [i1.toString()],
    });
    expect(result.ids).toEqual([i1.toString(), i2.toString()]);
    expect(result.added).toEqual([i2.toString()]);
  });

  it('returns empty added when everything is already attached (idempotent)', async () => {
    const i1 = new ObjectId();
    const beat = { _id: new ObjectId(), images: [{ _id: i1 }], main_image_id: null };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: [],
      existingIds: [i1],
    });
    expect(result.added).toEqual([]);
    expect(result.ids).toEqual([i1.toString()]);
  });

  it('handles a character with no images at all (skipped, others present)', async () => {
    await makeCharacter('Alice'); // no sheets, no main, no images
    const sheetB = new ObjectId();
    await makeCharacter('Bob', { sheets: [sheetB] });
    const beat = { _id: new ObjectId(), images: [], main_image_id: null };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: ['Alice', 'Bob'],
      existingIds: [],
    });
    expect(result.ids).toEqual([sheetB.toString()]);
  });

  it('falls back to legacy character_sheet_image_id when array is empty', async () => {
    const legacy = new ObjectId();
    const c = await Characters.createCharacter({ name: 'Carol' });
    await fakeDb.collection('characters').updateOne(
      { _id: c._id },
      {
        $set: {
          character_sheet_image_id: legacy,
          character_sheet_image_ids: [],
          main_image_id: null,
        },
      },
    );
    const beat = { _id: new ObjectId(), images: [], main_image_id: null };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: ['Carol'],
      existingIds: [],
    });
    expect(result.ids).toEqual([legacy.toString()]);
  });

  it('returns empty result when beat is null and no characters resolve', async () => {
    const result = await collectStoryboardReferenceIds({
      beat: null,
      charactersInScene: ['Ghost'],
      existingIds: [],
    });
    expect(result.ids).toEqual([]);
    expect(result.added).toEqual([]);
  });
});
