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
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('list_characters handler — casting field', () => {
  it('returns "plays self" when plays_self is true', async () => {
    await Characters.createCharacter({ name: 'Alice', plays_self: true, own_voice: true });

    const out = JSON.parse(await HANDLERS.list_characters());

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Alice', casting: 'plays self' });
    expect(typeof out[0]._id).toBe('string');
  });

  it('returns "played by <actor>" when plays_self is false and an actor is set', async () => {
    await Characters.createCharacter({
      name: 'Bob',
      plays_self: false,
      hollywood_actor: 'Bob Saget',
      own_voice: true,
    });

    const out = JSON.parse(await HANDLERS.list_characters());

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Bob', casting: 'played by Bob Saget' });
  });

  it('returns "played by (unspecified)" when neither plays_self nor an actor is set', async () => {
    // createCharacter coerces plays_self to !!input — passing false explicitly with no actor.
    // The Mongo layer normally would have rejected this at the handler, but listCharacters
    // shouldn't crash on a doc that's missing both fields. Insert directly.
    fakeDb.collection('characters')._docs.push({
      _id: new ObjectId(),
      name: 'Carol',
      name_lower: 'carol',
      plays_self: false,
      hollywood_actor: null,
      own_voice: true,
      fields: {},
    });

    const out = JSON.parse(await HANDLERS.list_characters());

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Carol', casting: 'played by (unspecified)' });
  });

  it('returns all three casting variants together, sorted by name', async () => {
    await Characters.createCharacter({ name: 'Alice', plays_self: true, own_voice: true });
    await Characters.createCharacter({
      name: 'Bob',
      plays_self: false,
      hollywood_actor: 'Bob Saget',
      own_voice: true,
    });
    fakeDb.collection('characters')._docs.push({
      _id: new ObjectId(),
      name: 'Carol',
      name_lower: 'carol',
      plays_self: false,
      hollywood_actor: null,
      own_voice: true,
      fields: {},
    });

    const out = JSON.parse(await HANDLERS.list_characters());

    expect(out.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(out.map((c) => c.casting)).toEqual([
      'plays self',
      'played by Bob Saget',
      'played by (unspecified)',
    ]);
  });
});
