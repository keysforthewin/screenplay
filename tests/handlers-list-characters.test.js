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

describe('list_characters handler — casting field', () => {
  it('returns "no actor assigned" when hollywood_actor is unset', async () => {
    await Characters.createCharacter({ name: 'Alice' });

    const out = JSON.parse(await HANDLERS.list_characters());

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Alice', casting: 'no actor assigned' });
    expect(typeof out[0]._id).toBe('string');
  });

  it('returns "played by <actor>" when hollywood_actor is set', async () => {
    await Characters.createCharacter({
      name: 'Bob',
      hollywood_actor: 'Bob Saget',
    });

    const out = JSON.parse(await HANDLERS.list_characters());

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Bob', casting: 'played by Bob Saget' });
  });

  it('returns both casting variants together, sorted by name', async () => {
    await Characters.createCharacter({ name: 'Alice' });
    await Characters.createCharacter({ name: 'Bob', hollywood_actor: 'Bob Saget' });

    const out = JSON.parse(await HANDLERS.list_characters());

    expect(out.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(out.map((c) => c.casting)).toEqual([
      'no actor assigned',
      'played by Bob Saget',
    ]);
  });
});
