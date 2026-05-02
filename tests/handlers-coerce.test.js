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
const Plots = await import('../src/mongo/plots.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('update_character stringified-patch recovery', () => {
  it('recovers a plain stringified JSON object patch', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: '{"fields":{"role":"lead"}}',
    });
    expect(out).toMatch(/Updated Alice/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('lead');
  });

  it('recovers a code-fenced JSON patch (```json ... ```)', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const fenced = '```json\n{"fields":{"role":"lead"}}\n```';
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: fenced,
    });
    expect(out).toMatch(/Updated Alice/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('lead');
  });

  it('recovers an array-wrapped single-object patch', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: '[{"fields":{"role":"lead"}}]',
    });
    expect(out).toMatch(/Updated Alice/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.role).toBe('lead');
  });

  it('falls through to canonical error on truly malformed string', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: {} });
    await expect(
      HANDLERS.update_character({
        identifier: 'Alice',
        patch: '{not json',
      }),
    ).rejects.toThrow(/must be an object/);
  });

  it('recovers a stringified unset patch (deletion path)', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      fields: { memes: 'doge', role: 'lead' },
    });
    const out = await HANDLERS.update_character({
      identifier: 'Alice',
      patch: '{"unset":["memes"]}',
    });
    expect(out).toMatch(/Updated Alice/);
    const fresh = await Characters.getCharacter('Alice');
    expect('memes' in fresh.fields).toBe(false);
    expect(fresh.fields.role).toBe('lead');
  });
});

describe('update_beat stringified-patch recovery', () => {
  it('recovers a plain stringified JSON object patch', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old body' });
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: '{"body":"new body"}',
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('new body');
  });

  it('recovers a code-fenced JSON patch (```json ... ```)', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old body' });
    const fenced = '```json\n{"body":"fenced body"}\n```';
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: fenced,
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('fenced body');
  });

  it('falls through to canonical error on truly malformed string', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene' });
    await expect(
      HANDLERS.update_beat({
        identifier: 'Opening',
        patch: 'this is not json at all',
      }),
    ).rejects.toThrow(/must be an object/);
  });

  it('recovers a patch wrapped in leading prose ("Patch: {...}")', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: 'Here is the patch: {"body":"prose-wrapped body"}',
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('prose-wrapped body');
  });

  it('recovers a patch followed by trailing prose', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: '{"body":"trailing-prose body"} — done',
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('trailing-prose body');
  });

  it('recovers a smart-quoted patch (curly “ ”)', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: '{“body”:“smart-quoted body”}',
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('smart-quoted body');
  });

  it('recovers an over-stringified patch ("\\"{...}\\"")', async () => {
    await Plots.createBeat({ name: 'Opening', desc: 'opening scene', body: 'old' });
    const overStringified = JSON.stringify(JSON.stringify({ body: 'over-stringified body' }));
    const out = await HANDLERS.update_beat({
      identifier: 'Opening',
      patch: overStringified,
    });
    expect(out).toMatch(/Updated beat "Opening"/);
    const fresh = await Plots.getBeat('Opening');
    expect(fresh.body).toBe('over-stringified body');
  });
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
