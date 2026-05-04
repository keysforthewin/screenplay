import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');
const Prompts = await import('../src/mongo/prompts.js');
const { config } = await import('../src/config.js');

beforeEach(async () => {
  fakeDb.reset();
  // Seed character template so non-core fields are recognized.
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

function makeBody(linePrefix, lineCount) {
  return Array.from({ length: lineCount }, (_, i) => `${linePrefix} ${i + 1}`).join('\n');
}

function parseHandlerJson(out) {
  // Handlers wrap JSON output with `\nEdit in browser: <url>` via withSpaLink.
  const stripped = String(out).replace(/\nEdit in browser:.*$/s, '');
  return JSON.parse(stripped);
}

describe('read_beat_body', () => {
  it('returns a window of numbered lines', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: makeBody('Line', 50) });
    const out = await HANDLERS.read_beat_body({
      beat: beat._id.toString(),
      line_start: 10,
      line_count: 5,
    });
    const json = parseHandlerJson(out);
    expect(json.total_lines).toBe(50);
    expect(json.range_start).toBe(10);
    expect(json.range_end).toBe(14);
    expect(json.lines.map((l) => l.text)).toEqual([
      'Line 10', 'Line 11', 'Line 12', 'Line 13', 'Line 14',
    ]);
    expect(json.has_more).toBe(true);
  });

  it('defaults to first 200 lines', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: makeBody('Row', 5) });
    const out = await HANDLERS.read_beat_body({ beat: beat._id.toString() });
    const json = parseHandlerJson(out);
    expect(json.range_start).toBe(1);
    expect(json.range_end).toBe(5);
    expect(json.has_more).toBe(false);
    expect(json.lines).toHaveLength(5);
  });
});

describe('search_in_beat_body', () => {
  it('finds substring matches with context', async () => {
    const body = ['intro', 'INT. DINER', 'Steve enters', 'sits down', 'orders coffee'].join('\n');
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body });
    const out = await HANDLERS.search_in_beat_body({
      beat: beat._id.toString(),
      pattern: 'Steve',
      context_lines: 1,
    });
    const json = parseHandlerJson(out);
    expect(json.total_matches).toBe(1);
    expect(json.matches[0].match_lines).toEqual([3]);
    expect(json.matches[0].context_start).toBe(2);
    expect(json.matches[0].context_end).toBe(4);
  });

  it('errors on missing pattern', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'x' });
    const out = await HANDLERS.search_in_beat_body({ beat: beat._id.toString() });
    expect(out).toMatch(/pattern.*required/);
  });
});

describe('outline_beat_body', () => {
  it('returns markdown headings with line numbers', async () => {
    const body = ['# Act 1', '', '## Scene 1', 'beat text', '## Scene 2'].join('\n');
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body });
    const out = await HANDLERS.outline_beat_body({ beat: beat._id.toString() });
    const json = parseHandlerJson(out);
    expect(json.heading_count).toBe(3);
    expect(json.headings).toEqual([
      { level: 1, line: 1, text: 'Act 1' },
      { level: 2, line: 3, text: 'Scene 1' },
      { level: 2, line: 5, text: 'Scene 2' },
    ]);
  });
});

describe('get_beat auto-truncation', () => {
  it('returns body inline when under threshold', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: 'short body' });
    const out = await HANDLERS.get_beat({ identifier: beat._id.toString() });
    const json = parseHandlerJson(out);
    expect(json.body).toBe('short body');
    expect(json.body_preview).toBeUndefined();
  });

  it('replaces body with body_preview when above threshold', async () => {
    const big = 'x'.repeat(config.agent.bodyPreviewThreshold + 5000);
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: big });
    const out = await HANDLERS.get_beat({ identifier: beat._id.toString() });
    const json = parseHandlerJson(out);
    expect(json.body).toBeUndefined();
    expect(json.body_preview.truncated).toBe(true);
    expect(json.body_preview.total_chars).toBe(big.length);
    expect(json.body_preview.hint).toMatch(/read_beat_body/);
  });

  it('full_body=true bypasses truncation', async () => {
    const big = 'y'.repeat(config.agent.bodyPreviewThreshold + 100);
    const beat = await Plots.createBeat({ name: 'B', desc: 'd', body: big });
    const out = await HANDLERS.get_beat({ identifier: beat._id.toString(), full_body: true });
    const json = parseHandlerJson(out);
    expect(json.body).toBe(big);
    expect(json.body_preview).toBeUndefined();
  });
});

describe('edit_character_field', () => {
  it('applies find/replace edits to a custom field via gateway fallback', async () => {
    const c = await Characters.createCharacter({
      name: 'Maya',
      fields: { bio: 'Maya is a rookie. Maya likes coffee.' },
    });
    const out = await HANDLERS.edit_character_field({
      character: 'Maya',
      field: 'bio',
      edits: [{ find: 'rookie', replace: 'veteran' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    const fresh = await Characters.getCharacter(c._id.toString());
    expect(fresh.fields.bio).toBe('Maya is a veteran. Maya likes coffee.');
  });

  it('applies edits to a core field (hollywood_actor)', async () => {
    await Characters.createCharacter({
      name: 'Steve',
      plays_self: false,
      hollywood_actor: 'Steve Mulligan Senior',
    });
    const out = await HANDLERS.edit_character_field({
      character: 'Steve',
      field: 'hollywood_actor',
      edits: [{ find: 'Senior', replace: 'Junior' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    const fresh = await Characters.getCharacter('Steve');
    expect(fresh.hollywood_actor).toBe('Steve Mulligan Junior');
  });

  it('errors on ambiguous find', async () => {
    await Characters.createCharacter({
      name: 'Maya',
      fields: { bio: 'apple apple apple' },
    });
    await expect(
      HANDLERS.edit_character_field({
        character: 'Maya',
        field: 'bio',
        edits: [{ find: 'apple', replace: 'orange' }],
      }),
    ).rejects.toThrow(/matched 3 places/);
  });

  it('errors on missing find', async () => {
    await Characters.createCharacter({ name: 'Maya', fields: { bio: 'hello world' } });
    await expect(
      HANDLERS.edit_character_field({
        character: 'Maya',
        field: 'bio',
        edits: [{ find: 'banana', replace: 'apple' }],
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('edit_director_note_partial', () => {
  it('applies find/replace to a director note via gateway fallback', async () => {
    const note = await DirectorNotes.addDirectorNote({ text: 'Always show Maya wearing red.' });
    const out = await HANDLERS.edit_director_note_partial({
      note_id: note._id.toString(),
      edits: [{ find: 'red', replace: 'blue' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    const doc = await DirectorNotes.getDirectorNotes();
    const updated = doc.notes.find((n) => n._id.equals(note._id));
    expect(updated.text).toBe('Always show Maya wearing blue.');
  });

  it('errors on ambiguous find', async () => {
    const note = await DirectorNotes.addDirectorNote({ text: 'red red red' });
    await expect(
      HANDLERS.edit_director_note_partial({
        note_id: note._id.toString(),
        edits: [{ find: 'red', replace: 'blue' }],
      }),
    ).rejects.toThrow(/matched 3 places/);
  });
});

describe('edit_plot_field', () => {
  it('applies find/replace to plot synopsis via Mongo', async () => {
    await Plots.updatePlot({ synopsis: 'A story about Steve and Maya.' });
    const out = await HANDLERS.edit_plot_field({
      field: 'synopsis',
      edits: [{ find: 'Steve and Maya', replace: 'two friends' }],
    });
    expect(out).toMatch(/Applied 1 edit/);
    const plot = await Plots.getPlot();
    expect(plot.synopsis).toBe('A story about two friends.');
  });

  it('rejects unknown field', async () => {
    const out = await HANDLERS.edit_plot_field({
      field: 'title',
      edits: [{ find: 'x', replace: 'y' }],
    });
    expect(out).toMatch(/synopsis.*notes/);
  });

  it('errors on missing find', async () => {
    await Plots.updatePlot({ notes: 'Tone is deadpan.' });
    await expect(
      HANDLERS.edit_plot_field({
        field: 'notes',
        edits: [{ find: 'banana', replace: 'apple' }],
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('read_director_note', () => {
  it('returns a slice of a long note', async () => {
    const text = makeBody('Note', 30);
    const note = await DirectorNotes.addDirectorNote({ text });
    const out = await HANDLERS.read_director_note({
      note_id: note._id.toString(),
      line_start: 5,
      line_count: 3,
    });
    const json = parseHandlerJson(out);
    expect(json.lines.map((l) => l.text)).toEqual(['Note 5', 'Note 6', 'Note 7']);
    expect(json.has_more).toBe(true);
  });
});

describe('read_character_field', () => {
  it('returns a slice of a custom field', async () => {
    const big = makeBody('Bio', 25);
    await Characters.createCharacter({ name: 'Maya', fields: { bio: big } });
    const out = await HANDLERS.read_character_field({
      character: 'Maya',
      field: 'bio',
      line_start: 1,
      line_count: 3,
    });
    const json = parseHandlerJson(out);
    expect(json.field).toBe('bio');
    expect(json.lines.map((l) => l.text)).toEqual(['Bio 1', 'Bio 2', 'Bio 3']);
    expect(json.total_lines).toBe(25);
  });
});
