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

describe('search_characters handler — match context', () => {
  it('reports hollywood_actor as the matching field when an actor name matches', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      plays_self: false,
      hollywood_actor: 'Liam Neeson',
      own_voice: true,
    });

    const out = JSON.parse(await HANDLERS.search_characters({ query: 'Liam Neeson' }));

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'Alice',
      matched_fields: ['hollywood_actor'],
    });
    expect(out[0].preview).toContain('Liam Neeson');
  });

  it('reports the matching template field when the hit is in fields.*', async () => {
    await Characters.createCharacter({
      name: 'Bob',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'Bob met Liam Neeson once at a diner.' },
    });

    const out = JSON.parse(await HANDLERS.search_characters({ query: 'Liam Neeson' }));

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'Bob',
      matched_fields: ['fields.background_story'],
    });
    expect(out[0].preview).toContain('Liam Neeson');
  });

  it('distinguishes a casting hit from a lore hit across multiple characters', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      plays_self: false,
      hollywood_actor: 'Liam Neeson',
      own_voice: true,
    });
    await Characters.createCharacter({
      name: 'Bob',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'Bob met Liam Neeson once.' },
    });
    await Characters.createCharacter({
      name: 'Carol',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'Carol works at a flower shop.' },
    });

    const out = JSON.parse(await HANDLERS.search_characters({ query: 'Liam Neeson' }));

    const byName = Object.fromEntries(out.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(['Alice', 'Bob']);
    expect(byName.Alice.matched_fields).toContain('hollywood_actor');
    expect(byName.Bob.matched_fields).toContain('fields.background_story');
    expect(byName.Bob.matched_fields).not.toContain('hollywood_actor');
  });

  it('returns [] when no character matches', async () => {
    await Characters.createCharacter({
      name: 'Carol',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'Carol works at a flower shop.' },
    });

    const out = JSON.parse(await HANDLERS.search_characters({ query: 'Liam Neeson' }));
    expect(out).toEqual([]);
  });

  it('truncates preview to 200 characters', async () => {
    const longLore = 'word '.repeat(100) + 'Liam Neeson ' + 'word '.repeat(100);
    await Characters.createCharacter({
      name: 'Dana',
      plays_self: true,
      own_voice: true,
      fields: { background_story: longLore },
    });

    const out = JSON.parse(await HANDLERS.search_characters({ query: 'Liam Neeson' }));
    expect(out[0].preview.length).toBeLessThanOrEqual(200);
  });

  it('is case-insensitive', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      plays_self: false,
      hollywood_actor: 'Liam Neeson',
      own_voice: true,
    });

    const out = JSON.parse(await HANDLERS.search_characters({ query: 'liam NEESON' }));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Alice');
  });
});

describe('searchCharacters (mongo layer) — regression: no JSON-blob matches', () => {
  it('does not match a character via its serialized _id hex digits', async () => {
    const knownId = new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa');
    fakeDb.collection('characters')._docs.push({
      _id: knownId,
      name: 'Edge',
      name_lower: 'edge',
      plays_self: true,
      hollywood_actor: null,
      own_voice: true,
      fields: {},
    });

    const out = await Characters.searchCharacters('aaaaaa');
    expect(out).toEqual([]);
  });

  it('does not match a character via stringified plays_self/own_voice booleans', async () => {
    await Characters.createCharacter({ name: 'Frank', plays_self: true, own_voice: true });

    const out = await Characters.searchCharacters('true');
    expect(out).toEqual([]);
  });
});
