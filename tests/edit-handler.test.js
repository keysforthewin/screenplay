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

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');
const Prompts = await import('../src/mongo/prompts.js');
const { HANDLERS, dispatchTool } = await import('../src/agent/handlers.js');

beforeEach(async () => {
  fakeDb.reset();
  await Prompts.setCharacterTemplate({
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
describe('edit handler — input validation', () => {
  it('rejects an unknown collection', async () => {
    const out = await HANDLERS.edit({
      collection: 'beats',
      identifier: '1',
      field: 'body',
      edits: [{ find: 'a', replace: 'b' }],
    });
    expect(out).toMatch(/^Tool error \(edit\): `collection` must be one of/);
  });

  it('requires a field', async () => {
    const out = await HANDLERS.edit({
      collection: 'beat',
      identifier: '1',
      edits: [{ find: 'a', replace: 'b' }],
    });
    expect(out).toMatch(/`field` is required/);
  });

  it('requires a non-empty edits array', async () => {
    const out = await HANDLERS.edit({
      collection: 'beat',
      identifier: '1',
      field: 'body',
      edits: [],
    });
    expect(out).toMatch(/`edits` must be a non-empty array/);
  });

  it('rejects empty find in multi-edit calls', async () => {
    await Plots.createBeat({ name: 'X', desc: 'd', body: 'hello world' });
    const out = await HANDLERS.edit({
      collection: 'beat',
      identifier: 'X',
      field: 'body',
      edits: [
        { find: '', replace: 'first' },
        { find: 'world', replace: 'mars' },
      ],
    });
    expect(out).toMatch(/Empty find \(whole-field replace\) is only allowed in single-edit calls/);
  });

  it('rejects non-string find/replace', async () => {
    const out = await HANDLERS.edit({
      collection: 'beat',
      identifier: '1',
      field: 'body',
      edits: [{ find: 1, replace: 'b' }],
    });
    expect(out).toMatch(/edit 0 must have string `find` and `replace`/);
  });
});

// ─── beat ────────────────────────────────────────────────────────────────────
describe('edit handler — beat', () => {
  it('partial edit on body', async () => {
    const b = await Plots.createBeat({ name: 'B', desc: 'd', body: 'hello world' });
    const out = await HANDLERS.edit({
      collection: 'beat',
      identifier: b._id.toString(),
      field: 'body',
      edits: [{ find: 'world', replace: 'mars' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    expect((await Plots.getBeat(b._id.toString())).body).toBe('hello mars');
  });

  it('whole-field replace via empty find', async () => {
    const b = await Plots.createBeat({ name: 'B', desc: 'd', body: 'old body' });
    const out = await HANDLERS.edit({
      collection: 'beat',
      identifier: b._id.toString(),
      field: 'body',
      edits: [{ find: '', replace: 'totally new body' }],
    });
    expect(out).toMatch(/Replaced beat "B"\.body/);
    expect((await Plots.getBeat(b._id.toString())).body).toBe('totally new body');
  });

  it('resolves identifier by order', async () => {
    await Plots.createBeat({ name: 'First', desc: 'd', body: 'aaa' });
    const out = await HANDLERS.edit({
      collection: 'beat',
      identifier: '1',
      field: 'name',
      edits: [{ find: '', replace: 'Renamed' }],
    });
    expect(out).toMatch(/Replaced beat "First"\.name/);
  });

  it('rejects unknown beat field (throws — caught by dispatchTool)', async () => {
    await Plots.createBeat({ name: 'X', desc: 'd' });
    await expect(
      HANDLERS.edit({
        collection: 'beat',
        identifier: 'X',
        field: 'order',
        edits: [{ find: '', replace: '5' }],
      }),
    ).rejects.toThrow(/beat field must be name, desc, body, or specifics/);
  });
});

// ─── character ───────────────────────────────────────────────────────────────
describe('edit handler — character', () => {
  it('edits a custom field via bare field name', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: { bio: 'short bio here' } });
    const out = await HANDLERS.edit({
      collection: 'character',
      identifier: 'Alice',
      field: 'bio',
      edits: [{ find: 'short', replace: 'long' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    expect((await Characters.getCharacter('Alice')).fields.bio).toBe('long bio here');
  });

  it('edits a core field', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      plays_self: false,
      hollywood_actor: 'Old Actor',
    });
    const out = await HANDLERS.edit({
      collection: 'character',
      identifier: 'Alice',
      field: 'hollywood_actor',
      edits: [{ find: 'Old', replace: 'New' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    expect((await Characters.getCharacter('Alice')).hollywood_actor).toBe('New Actor');
  });
});

// ─── plot ────────────────────────────────────────────────────────────────────
describe('edit handler — plot', () => {
  it('partial edit on synopsis', async () => {
    await Plots.updatePlot({ synopsis: 'A short tale.' });
    const out = await HANDLERS.edit({
      collection: 'plot',
      field: 'synopsis',
      edits: [{ find: 'short', replace: 'long' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    expect((await Plots.getPlot()).synopsis).toBe('A long tale.');
  });

  it('whole replace on title', async () => {
    await Plots.updatePlot({ title: 'Old' });
    const out = await HANDLERS.edit({
      collection: 'plot',
      field: 'title',
      edits: [{ find: '', replace: 'Caper' }],
    });
    expect(out).toMatch(/Replaced plot\.title/);
    expect((await Plots.getPlot()).title).toBe('Caper');
  });

  it('partial edit on title', async () => {
    await Plots.updatePlot({ title: 'The Big Caper' });
    const out = await HANDLERS.edit({
      collection: 'plot',
      field: 'title',
      edits: [{ find: 'Big', replace: 'Long' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    expect((await Plots.getPlot()).title).toBe('The Long Caper');
  });
});

// ─── director_note ───────────────────────────────────────────────────────────
describe('edit handler — director_note', () => {
  it('partial edit', async () => {
    const note = await DirectorNotes.addDirectorNote({ text: 'Always wear red.' });
    const out = await HANDLERS.edit({
      collection: 'director_note',
      identifier: note._id.toString(),
      field: 'text',
      edits: [{ find: 'red', replace: 'blue' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    const doc = await DirectorNotes.getDirectorNotes();
    const fresh = doc.notes.find((n) => n._id.equals(note._id));
    expect(fresh.text).toBe('Always wear blue.');
  });

  it('whole-field replace via empty find', async () => {
    const note = await DirectorNotes.addDirectorNote({ text: 'old rule' });
    const out = await HANDLERS.edit({
      collection: 'director_note',
      identifier: note._id.toString(),
      field: 'text',
      edits: [{ find: '', replace: 'new rule entirely' }],
    });
    expect(out).toMatch(/Replaced director's note/);
    const doc = await DirectorNotes.getDirectorNotes();
    const fresh = doc.notes.find((n) => n._id.equals(note._id));
    expect(fresh.text).toBe('new rule entirely');
  });

  it('rejects unknown director_note field (throws — caught by dispatchTool)', async () => {
    const note = await DirectorNotes.addDirectorNote({ text: 'rule' });
    await expect(
      HANDLERS.edit({
        collection: 'director_note',
        identifier: note._id.toString(),
        field: 'caption',
        edits: [{ find: '', replace: 'x' }],
      }),
    ).rejects.toThrow(/director_note field must be "text"/);
  });
});

// ─── error surfacing via dispatchTool ────────────────────────────────────────
describe('edit handler — error surfacing', () => {
  it('produces a canonical "Tool error (edit): ..." string when find is missing', async () => {
    await Plots.createBeat({ name: 'X', desc: 'd', body: 'hello world' });
    const result = await dispatchTool('edit', {
      collection: 'beat',
      identifier: 'X',
      field: 'body',
      edits: [{ find: 'banana', replace: 'apple' }],
    });
    expect(result).toMatch(/^Tool error \(edit\):/);
    expect(result).toMatch(/not found/);
  });
});
