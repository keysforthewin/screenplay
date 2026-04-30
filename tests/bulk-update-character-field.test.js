import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
});

async function seedCharacter(name, extras = {}) {
  return Characters.createCharacter({
    name,
    plays_self: true,
    own_voice: true,
    fields: {},
    ...extras,
  });
}

describe('bulk_update_character_field handler', () => {
  it('updates a custom (template) field across multiple characters in one call', async () => {
    await seedCharacter('Alice');
    await seedCharacter('Bob');
    await seedCharacter('Carol');

    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'role',
      updates: [
        { character: 'Alice', value: 'protagonist' },
        { character: 'bob', value: 'antagonist' },
        { character: 'CAROL', value: 'sidekick' },
      ],
    });

    expect(out).toMatch(/Updated field "role" on 3\/3 character\(s\)\./);
    const a = await Characters.getCharacter('Alice');
    const b = await Characters.getCharacter('Bob');
    const c = await Characters.getCharacter('Carol');
    expect(a.fields.role).toBe('protagonist');
    expect(b.fields.role).toBe('antagonist');
    expect(c.fields.role).toBe('sidekick');
  });

  it('writes core fields top-level (not under fields.x)', async () => {
    await seedCharacter('Alice');

    await HANDLERS.bulk_update_character_field({
      field_name: 'plays_self',
      updates: [{ character: 'Alice', value: false }],
    });

    const a = await Characters.getCharacter('Alice');
    expect(a.plays_self).toBe(false);
    expect(a.fields?.plays_self).toBeUndefined();
  });

  it('reports per-row failures without aborting the rest', async () => {
    await seedCharacter('Alice');
    await seedCharacter('Carol');

    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'role',
      updates: [
        { character: 'Alice', value: 'protagonist' },
        { character: 'Bob', value: 'antagonist' }, // does not exist
        { character: 'Carol', value: 'sidekick' },
      ],
    });

    expect(out).toMatch(/Updated field "role" on 2\/3/);
    expect(out).toMatch(/Failures \(1\):/);
    expect(out).toMatch(/"Bob": Character not found: Bob/);

    const a = await Characters.getCharacter('Alice');
    const c = await Characters.getCharacter('Carol');
    expect(a.fields.role).toBe('protagonist');
    expect(c.fields.role).toBe('sidekick');
  });

  it('resolves characters by both name and _id', async () => {
    const a = await seedCharacter('Alice');

    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'role',
      updates: [{ character: a._id.toString(), value: 'lead' }],
    });

    expect(out).toMatch(/1\/1/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('lead');
  });

  it('honors batch_size and processes all rows regardless of size', async () => {
    for (let i = 0; i < 7; i++) await seedCharacter(`Char${i}`);

    const updates = Array.from({ length: 7 }, (_, i) => ({
      character: `Char${i}`,
      value: `v${i}`,
    }));

    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'role',
      updates,
      batch_size: 2,
    });

    expect(out).toMatch(/7\/7/);
    for (let i = 0; i < 7; i++) {
      const c = await Characters.getCharacter(`Char${i}`);
      expect(c.fields.role).toBe(`v${i}`);
    }
  });

  it('returns an error string when updates is empty or missing', async () => {
    const out1 = await HANDLERS.bulk_update_character_field({
      field_name: 'role',
      updates: [],
    });
    expect(out1).toMatch(/Error/);

    const out2 = await HANDLERS.bulk_update_character_field({ field_name: 'role' });
    expect(out2).toMatch(/Error/);
  });

  it('returns an error string when field_name is missing', async () => {
    const out = await HANDLERS.bulk_update_character_field({
      updates: [{ character: 'Alice', value: 'x' }],
    });
    expect(out).toMatch(/Error/);
  });
});
