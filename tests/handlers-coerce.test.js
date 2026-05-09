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

describe('bulk_update_character_field stringified-value recovery', () => {
  it('coerces a stringified-object value for a custom field', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'profile',
      updates: [{ character: 'Alice', value: '{"a":1,"b":"x"}' }],
    });
    expect(out).toMatch(/Updated field "profile" on 1\/1/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.profile).toEqual({ a: 1, b: 'x' });
  });

  it('leaves a non-JSON string value alone (still writes the string)', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'role',
      updates: [{ character: 'Alice', value: 'protagonist' }],
    });
    expect(out).toMatch(/1\/1/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('protagonist');
  });

  it('does NOT coerce values for core fields (e.g. hollywood_actor)', async () => {
    await Characters.createCharacter({ name: 'Alice' });
    const out = await HANDLERS.bulk_update_character_field({
      field_name: 'hollywood_actor',
      updates: [{ character: 'Alice', value: '{"name":"someone"}' }],
    });
    expect(out).toMatch(/1\/1/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.hollywood_actor).toBe('{"name":"someone"}');
  });
});
