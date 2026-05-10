import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Characters = await import('../src/mongo/characters.js');
const {
  setEntityFieldMarkdown,
  updateCharacterViaGateway,
  appendCharacterSheetImageViaGateway,
  removeCharacterSheetImageViaGateway,
  reorderCharacterSheetImagesViaGateway,
} = await import('../src/web/gateway.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('gateway — specifics text-field fallback (no Hocuspocus)', () => {
  it('setEntityFieldMarkdown writes specifics.<key> through updateCharacter', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await setEntityFieldMarkdown({
      entityType: 'character',
      entityId: c._id.toString(),
      field: 'specifics.outfit_armor',
      markdown: 'leather jacket, distressed denim',
    });
    const updated = await Characters.getCharacter(c._id.toString());
    expect(updated.specifics.outfit_armor).toBe('leather jacket, distressed denim');
  });

  it('updateCharacterViaGateway accepts patch.specifics object', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const result = await updateCharacterViaGateway(c._id.toString(), {
      specifics: {
        character_type: 'human',
        age: 'late 20s',
      },
    });
    expect(result.specifics.character_type).toBe('human');
    expect(result.specifics.age).toBe('late 20s');
  });

  it('updateCharacterViaGateway accepts dotted specifics keys alongside other fields', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const result = await updateCharacterViaGateway(c._id.toString(), {
      'specifics.continuity_locks': 'preserve scar; preserve cutout',
      plays_self: true,
    });
    expect(result.specifics.continuity_locks).toBe('preserve scar; preserve cutout');
    expect(result.plays_self).toBe(true);
  });
});

describe('gateway — character sheet image helpers', () => {
  it('appendCharacterSheetImageViaGateway pushes new ids and dedupes', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const a = new ObjectId();
    const b = new ObjectId();

    await appendCharacterSheetImageViaGateway({
      character: c._id.toString(),
      imageId: a.toString(),
    });
    await appendCharacterSheetImageViaGateway({
      character: c._id.toString(),
      imageId: b.toString(),
    });
    // Re-append the first should be a no-op (dedup).
    await appendCharacterSheetImageViaGateway({
      character: c._id.toString(),
      imageId: a.toString(),
    });

    const updated = await Characters.getCharacter(c._id.toString());
    expect(updated.character_sheet_image_ids.map((x) => x.toString())).toEqual([
      a.toString(),
      b.toString(),
    ]);
  });

  it('reorderCharacterSheetImagesViaGateway permutes the array', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const a = new ObjectId();
    const b = new ObjectId();
    await appendCharacterSheetImageViaGateway({ character: c._id.toString(), imageId: a.toString() });
    await appendCharacterSheetImageViaGateway({ character: c._id.toString(), imageId: b.toString() });

    await reorderCharacterSheetImagesViaGateway({
      character: c._id.toString(),
      orderedIds: [b.toString(), a.toString()],
    });
    const updated = await Characters.getCharacter(c._id.toString());
    expect(updated.character_sheet_image_ids.map((x) => x.toString())).toEqual([
      b.toString(),
      a.toString(),
    ]);
  });

  it('removeCharacterSheetImageViaGateway pulls the id from the array', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const a = new ObjectId();
    const b = new ObjectId();
    await appendCharacterSheetImageViaGateway({ character: c._id.toString(), imageId: a.toString() });
    await appendCharacterSheetImageViaGateway({ character: c._id.toString(), imageId: b.toString() });

    await removeCharacterSheetImageViaGateway({
      character: c._id.toString(),
      imageId: a.toString(),
    });
    const updated = await Characters.getCharacter(c._id.toString());
    expect(updated.character_sheet_image_ids.map((x) => x.toString())).toEqual([b.toString()]);
  });

  it('throws when the character does not exist', async () => {
    await expect(
      appendCharacterSheetImageViaGateway({
        character: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        imageId: new ObjectId().toString(),
      }),
    ).rejects.toThrow(/Character not found/);
  });
});
