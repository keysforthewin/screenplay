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

async function seed(name) {
  return Characters.createCharacter({
    name,
    plays_self: true,
    own_voice: true,
    fields: {},
  });
}

describe('update_character handler — stringified-JSON patch recovery', () => {
  it('recovers when the model passes patch as a JSON-encoded object string', async () => {
    await seed('Aiden');

    const out = await HANDLERS.update_character({
      identifier: 'Aiden',
      patch: '{"fields":{"alternate_names":["a1dan8992"]}}',
    });

    expect(out).toMatch(/Updated Aiden/);
    const fresh = await Characters.getCharacter('Aiden');
    expect(fresh.fields.alternate_names).toEqual(['a1dan8992']);
  });

  it('recovers stringified patch with whitespace padding', async () => {
    await seed('Aiden');

    await HANDLERS.update_character({
      identifier: 'Aiden',
      patch: '   {"name":"Aidan"}   ',
    });

    const fresh = await Characters.getCharacter('Aidan');
    expect(fresh).toBeTruthy();
    expect(fresh.name).toBe('Aidan');
  });

  it('still rejects a stringified JSON array (recovery only accepts plain objects)', async () => {
    await seed('Aiden');

    await expect(
      HANDLERS.update_character({
        identifier: 'Aiden',
        patch: '[{"name":"Aidan"}]',
      }),
    ).rejects.toThrow(/must be an object/);
  });

  it('still rejects a stringified JSON null', async () => {
    await seed('Aiden');

    await expect(
      HANDLERS.update_character({
        identifier: 'Aiden',
        patch: 'null',
      }),
    ).rejects.toThrow(/must be an object/);
  });

  it('still rejects a non-JSON string (no parse attempted, falls through)', async () => {
    await seed('Aiden');

    await expect(
      HANDLERS.update_character({
        identifier: 'Aiden',
        patch: 'a1dan8992',
      }),
    ).rejects.toThrow(/must be an object/);
  });

  it('still rejects a stringified object with malformed JSON', async () => {
    await seed('Aiden');

    await expect(
      HANDLERS.update_character({
        identifier: 'Aiden',
        patch: '{not really json}',
      }),
    ).rejects.toThrow(/must be an object/);
  });

  it('plain object patch is unaffected — applies normally', async () => {
    await seed('Aiden');

    await HANDLERS.update_character({
      identifier: 'Aiden',
      patch: { fields: { memes: 'tactical' } },
    });

    const fresh = await Characters.getCharacter('Aiden');
    expect(fresh.fields.memes).toBe('tactical');
  });
});
