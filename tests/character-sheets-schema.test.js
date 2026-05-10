// Schema helpers for the multi-sheet character_sheet_image_ids[] array, plus
// the lazy backfill that synthesizes the array on legacy docs that only have
// the scalar character_sheet_image_id.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Characters = await import('../src/mongo/characters.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('character_sheet_image_ids — lazy backfill', () => {
  it('synthesizes the array from the legacy scalar on read', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const id = new ObjectId();
    await fakeDb
      .collection('characters')
      .updateOne({ _id: c._id }, { $set: { character_sheet_image_id: id } });

    const got = await Characters.getCharacter(c._id.toString());
    expect(Array.isArray(got.character_sheet_image_ids)).toBe(true);
    expect(got.character_sheet_image_ids).toHaveLength(1);
    expect(got.character_sheet_image_ids[0].equals(id)).toBe(true);
  });

  it('leaves an existing array untouched', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const a = new ObjectId();
    const b = new ObjectId();
    await fakeDb
      .collection('characters')
      .updateOne({ _id: c._id }, { $set: { character_sheet_image_ids: [a, b] } });

    const got = await Characters.getCharacter(c._id.toString());
    expect(got.character_sheet_image_ids.map((x) => x.toString())).toEqual([
      a.toString(),
      b.toString(),
    ]);
  });

  it('returns an empty array when neither field is set', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const got = await Characters.getCharacter(c._id.toString());
    expect(got.character_sheet_image_ids).toEqual([]);
  });
});

describe('appendCharacterSheetImage', () => {
  it('pushes a new id and unsets the legacy scalar', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const legacy = new ObjectId();
    await fakeDb
      .collection('characters')
      .updateOne({ _id: c._id }, { $set: { character_sheet_image_id: legacy } });

    const fresh = new ObjectId();
    await Characters.appendCharacterSheetImage(c._id.toString(), fresh.toString());

    const got = await Characters.getCharacter(c._id.toString());
    // Backfill snapshot ran on append's own getCharacter call, so the array
    // contained [legacy] when we appended → final = [legacy, fresh].
    expect(got.character_sheet_image_ids.map((x) => x.toString())).toEqual([
      legacy.toString(),
      fresh.toString(),
    ]);
    // Legacy scalar is gone after the write.
    expect(got.character_sheet_image_id).toBeUndefined();
  });

  it('is idempotent — re-appending an existing id is a no-op', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const id = new ObjectId();
    await Characters.appendCharacterSheetImage(c._id.toString(), id.toString());
    await Characters.appendCharacterSheetImage(c._id.toString(), id.toString());
    const got = await Characters.getCharacter(c._id.toString());
    expect(got.character_sheet_image_ids).toHaveLength(1);
  });

  it('rejects non-hex ids', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.appendCharacterSheetImage(c._id.toString(), 'not-a-hex-id'),
    ).rejects.toThrow(/24-hex/);
  });
});

describe('removeCharacterSheetImage', () => {
  it('pulls the id from the array', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const a = new ObjectId();
    const b = new ObjectId();
    await Characters.appendCharacterSheetImage(c._id.toString(), a.toString());
    await Characters.appendCharacterSheetImage(c._id.toString(), b.toString());

    await Characters.removeCharacterSheetImage(c._id.toString(), a.toString());

    const got = await Characters.getCharacter(c._id.toString());
    expect(got.character_sheet_image_ids.map((x) => x.toString())).toEqual([b.toString()]);
  });

  it('throws when the id is not currently attached', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.removeCharacterSheetImage(c._id.toString(), new ObjectId().toString()),
    ).rejects.toThrow(/is not attached/);
  });
});

describe('reorderCharacterSheetImages', () => {
  it('permutes the array', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const a = new ObjectId();
    const b = new ObjectId();
    const d = new ObjectId();
    await Characters.appendCharacterSheetImage(c._id.toString(), a.toString());
    await Characters.appendCharacterSheetImage(c._id.toString(), b.toString());
    await Characters.appendCharacterSheetImage(c._id.toString(), d.toString());

    await Characters.reorderCharacterSheetImages(c._id.toString(), [
      d.toString(),
      a.toString(),
      b.toString(),
    ]);
    const got = await Characters.getCharacter(c._id.toString());
    expect(got.character_sheet_image_ids.map((x) => x.toString())).toEqual([
      d.toString(),
      a.toString(),
      b.toString(),
    ]);
  });

  it('rejects when the incoming set differs from the current set', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const a = new ObjectId();
    const b = new ObjectId();
    await Characters.appendCharacterSheetImage(c._id.toString(), a.toString());
    await Characters.appendCharacterSheetImage(c._id.toString(), b.toString());

    // Wrong length.
    await expect(
      Characters.reorderCharacterSheetImages(c._id.toString(), [a.toString()]),
    ).rejects.toThrow(/expected 2 ids/);

    // Wrong id mix.
    await expect(
      Characters.reorderCharacterSheetImages(c._id.toString(), [
        a.toString(),
        new ObjectId().toString(),
      ]),
    ).rejects.toThrow(/not in current set/);

    // Duplicate id.
    await expect(
      Characters.reorderCharacterSheetImages(c._id.toString(), [a.toString(), a.toString()]),
    ).rejects.toThrow(/duplicate id/);
  });
});
