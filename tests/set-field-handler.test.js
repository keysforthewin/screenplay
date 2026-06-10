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

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Prompts = await import('../src/mongo/prompts.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  await Prompts.setCharacterTemplate(projectId, {
    fields: [
      { name: 'name', core: true },
      { name: 'plays_self', core: true },
      { name: 'hollywood_actor', core: true },
      { name: 'own_voice', core: true },
      { name: 'bio', core: false },
    ],
  });
});

// ─── input validation ───────────────────────────────────────────────────────
describe('set_field handler — input validation', () => {
  it('rejects an unknown collection', async () => {
    const out = await HANDLERS.set_field({
      collection: 'plot',
      identifier: 'main',
      field: 'order',
      value: 1,
    }, { projectId });
    expect(out).toMatch(/^Tool error \(set_field\): `collection` must be "beat" or "character"/);
  });

  it('requires identifier', async () => {
    const out = await HANDLERS.set_field({
      collection: 'beat',
      field: 'order',
      value: 1,
    }, { projectId });
    expect(out).toMatch(/`identifier` is required/);
  });

  it('requires value', async () => {
    const out = await HANDLERS.set_field({
      collection: 'character',
      identifier: 'Alice',
      field: 'plays_self',
    }, { projectId });
    expect(out).toMatch(/`value` is required/);
  });
});

// ─── beat ────────────────────────────────────────────────────────────────────
describe('set_field handler — beat', () => {
  it('sets order', async () => {
    const a = await Plots.createBeat({ projectId, name: 'A', desc: 'd' });
    await Plots.createBeat({ projectId, name: 'B', desc: 'd' });
    const out = await HANDLERS.set_field({
      collection: 'beat',
      identifier: a._id.toString(),
      field: 'order',
      value: 5,
    }, { projectId });
    expect(out).toMatch(/Set beat "A"\.order = 5/);
    expect((await Plots.getBeat(projectId, a._id.toString())).order).toBe(5);
  });

  it('rejects non-number for order', async () => {
    await Plots.createBeat({ projectId, name: 'A', desc: 'd' });
    const out = await HANDLERS.set_field({
      collection: 'beat',
      identifier: 'A',
      field: 'order',
      value: 'first',
    }, { projectId });
    expect(out).toMatch(/beat\.order must be a finite number/);
  });

  it('replaces characters roster', async () => {
    const a = await Plots.createBeat({ projectId, name: 'A', desc: 'd', characters: ['Old'] });
    const out = await HANDLERS.set_field({
      collection: 'beat',
      identifier: a._id.toString(),
      field: 'characters',
      value: ['New1', 'New2'],
    }, { projectId });
    expect(out).toMatch(/Set beat "A"\.characters = \["New1", "New2"\]/);
    expect((await Plots.getBeat(projectId, a._id.toString())).characters).toEqual(['New1', 'New2']);
  });

  it('rejects non-string-array characters', async () => {
    await Plots.createBeat({ projectId, name: 'A', desc: 'd' });
    const out = await HANDLERS.set_field({
      collection: 'beat',
      identifier: 'A',
      field: 'characters',
      value: [1, 2],
    }, { projectId });
    expect(out).toMatch(/must be an array of strings/);
  });

  it('rejects unknown beat field', async () => {
    await Plots.createBeat({ projectId, name: 'A', desc: 'd' });
    const out = await HANDLERS.set_field({
      collection: 'beat',
      identifier: 'A',
      field: 'body',
      value: 'something',
    }, { projectId });
    expect(out).toMatch(/For text fields .* use `edit` instead/);
  });

  it('rejects invalid scene_sheet_image_id', async () => {
    await Plots.createBeat({ projectId, name: 'A', desc: 'd' });
    const out = await HANDLERS.set_field({
      collection: 'beat',
      identifier: 'A',
      field: 'scene_sheet_image_id',
      value: 'not-hex',
    }, { projectId });
    expect(out).toMatch(/24-char hex string or null/);
  });
});

// ─── character ───────────────────────────────────────────────────────────────
describe('set_field handler — character', () => {
  it('rejects character fields other than unset', async () => {
    await Characters.createCharacter({ projectId, name: 'Alice' });
    const out = await HANDLERS.set_field({
      collection: 'character',
      identifier: 'Alice',
      field: 'hollywood_actor',
      value: 'Idris Elba',
    }, { projectId });
    expect(out).toMatch(/character field must be "unset"/);
  });

  it('unsets a custom field', async () => {
    await Characters.createCharacter({ projectId,
      name: 'Alice',
      fields: { bio: 'something', role: 'lead' },
    });
    const out = await HANDLERS.set_field({
      collection: 'character',
      identifier: 'Alice',
      field: 'unset',
      value: ['bio'],
    }, { projectId });
    expect(out).toMatch(/Unset 1 field\(s\) on Alice: \[bio\]/);
    const fresh = await Characters.getCharacter(projectId, 'Alice');
    expect('bio' in fresh.fields).toBe(false);
    expect(fresh.fields.role).toBe('lead');
  });

  it('rejects non-array for unset', async () => {
    await Characters.createCharacter({ projectId, name: 'Alice' });
    const out = await HANDLERS.set_field({
      collection: 'character',
      identifier: 'Alice',
      field: 'unset',
      value: 'bio',
    }, { projectId });
    expect(out).toMatch(/must be an array of custom field name strings/);
  });

  it('rejects unknown character field', async () => {
    await Characters.createCharacter({ projectId, name: 'Alice' });
    const out = await HANDLERS.set_field({
      collection: 'character',
      identifier: 'Alice',
      field: 'name',
      value: 'Alicia',
    }, { projectId });
    expect(out).toMatch(/For text fields .* use `edit` instead/);
  });
});
