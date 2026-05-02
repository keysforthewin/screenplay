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

describe('updateCharacter unset support', () => {
  it('removes a custom field via unset (key gone, not null)', async () => {
    const c = await Characters.createCharacter({
      name: 'Rae',
      fields: { memes: 'doge', role: 'lead' },
    });
    const updated = await Characters.updateCharacter(c._id.toString(), {
      unset: ['memes'],
    });
    expect(updated.fields).toBeDefined();
    expect('memes' in updated.fields).toBe(false);
    expect(updated.fields.role).toBe('lead');
  });

  it('combines $set and $unset in one call (edit one field, delete another)', async () => {
    const c = await Characters.createCharacter({
      name: 'Rae',
      fields: { memes: 'doge', role: 'lead' },
    });
    const updated = await Characters.updateCharacter(c._id.toString(), {
      fields: { role: 'antagonist' },
      unset: ['memes'],
    });
    expect(updated.fields.role).toBe('antagonist');
    expect('memes' in updated.fields).toBe(false);
  });

  it('rejects unset when not an array', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.updateCharacter(c._id.toString(), { unset: 'memes' }),
    ).rejects.toThrow(/`unset` must be an array/);
  });

  it('rejects unset entries that are not non-empty strings', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.updateCharacter(c._id.toString(), { unset: ['ok', ''] }),
    ).rejects.toThrow(/`unset` entries must be non-empty strings/);
    await expect(
      Characters.updateCharacter(c._id.toString(), { unset: [123] }),
    ).rejects.toThrow(/`unset` entries must be non-empty strings/);
  });

  it('rejects when unset is empty and no other recognized changes', async () => {
    const c = await Characters.createCharacter({ name: 'Rae' });
    await expect(
      Characters.updateCharacter(c._id.toString(), { unset: [] }),
    ).rejects.toThrow(/produced no field changes/);
  });

  it('unset of a missing field is a no-op (does not throw)', async () => {
    const c = await Characters.createCharacter({
      name: 'Rae',
      fields: { role: 'lead' },
    });
    const updated = await Characters.updateCharacter(c._id.toString(), {
      unset: ['never_existed'],
    });
    expect(updated.fields.role).toBe('lead');
  });
});
