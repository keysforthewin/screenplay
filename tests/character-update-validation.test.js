import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('updateCharacter input validation', () => {
  it('throws when patch is a string (the model-passed-value-as-patch bug)', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(Characters.updateCharacter(c._id.toString(), 'a long memes value')).rejects.toThrow(
      /must be an object/,
    );
  });

  it('throws when patch is an array', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(Characters.updateCharacter(c._id.toString(), ['name', 'New'])).rejects.toThrow(
      /must be an object.*array/,
    );
  });

  it('throws when patch is null', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(Characters.updateCharacter(c._id.toString(), null)).rejects.toThrow(
      /must be an object/,
    );
  });

  it('throws when patch has no recognized fields', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(Characters.updateCharacter(c._id.toString(), { foo: 'bar' })).rejects.toThrow(
      /no recognized fields/,
    );
  });

  it('valid patch.name still updates end-to-end', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const updated = await Characters.updateCharacter(c._id.toString(), { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.name_lower).toBe('renamed');
  });

  it('valid patch.fields.memes still updates end-to-end', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const updated = await Characters.updateCharacter(c._id.toString(), {
      fields: { memes: 'doge' },
    });
    expect(updated.fields.memes).toBe('doge');
  });

  it('updateCharacter throws when the doc disappears mid-write', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    const col = fakeDb.collection('characters');
    const spy = vi.spyOn(col, 'updateOne').mockResolvedValue({ matchedCount: 0 });
    try {
      await expect(
        Characters.updateCharacter(c._id.toString(), { name: 'Newer' }),
      ).rejects.toThrow(/updateCharacter:.*not found/);
    } finally {
      spy.mockRestore();
    }
  });
});
