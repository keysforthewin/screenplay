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

describe('updateCharacter — specifics support', () => {
  it('writes a single specifics.<key> dot-path patch', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const updated = await Characters.updateCharacter(c._id.toString(), {
      'specifics.character_type': 'human',
    });
    expect(updated.specifics.character_type).toBe('human');
  });

  it('expands a specifics: {…} object into dot-path $set ops', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const updated = await Characters.updateCharacter(c._id.toString(), {
      specifics: { age: 'early 30s', height_build: '5\'10" | athletic' },
    });
    expect(updated.specifics.age).toBe('early 30s');
    expect(updated.specifics.height_build).toBe('5\'10" | athletic');
  });

  it('rejects unknown specifics field names (object form)', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.updateCharacter(c._id.toString(), {
        specifics: { not_a_real_field: 'foo' },
      }),
    ).rejects.toThrow(/unknown specifics field/);
  });

  it('rejects unknown specifics field names (dot form)', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.updateCharacter(c._id.toString(), {
        'specifics.bogus': 'foo',
      }),
    ).rejects.toThrow(/unknown specifics field/);
  });
});

describe('updateCharacter — character_sheet_image_id', () => {
  it('accepts a 24-hex string and stores it as ObjectId', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const id = new ObjectId();
    const updated = await Characters.updateCharacter(c._id.toString(), {
      character_sheet_image_id: id.toString(),
    });
    expect(updated.character_sheet_image_id).toBeDefined();
    expect(updated.character_sheet_image_id.equals(id)).toBe(true);
  });

  it('accepts an ObjectId instance directly', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const id = new ObjectId();
    const updated = await Characters.updateCharacter(c._id.toString(), {
      character_sheet_image_id: id,
    });
    expect(updated.character_sheet_image_id.equals(id)).toBe(true);
  });

  it('accepts null to clear the field', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const id = new ObjectId();
    await Characters.updateCharacter(c._id.toString(), {
      character_sheet_image_id: id.toString(),
    });
    const cleared = await Characters.updateCharacter(c._id.toString(), {
      character_sheet_image_id: null,
    });
    expect(cleared.character_sheet_image_id).toBeNull();
  });

  it('rejects non-hex strings', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.updateCharacter(c._id.toString(), {
        character_sheet_image_id: 'not-hex',
      }),
    ).rejects.toThrow(/character_sheet_image_id/);
  });
});
