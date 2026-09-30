// Pass 0 of the scene/cut planner: the whole-beat context block.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Ctx = await import('../src/web/beatContext.js');

describe('findSluglines', () => {
  it('finds INT./EXT. lines in order with their line numbers', () => {
    const body = 'INT. DINER — NIGHT\n\nSarah waits.\n\nEXT. STREET - CONTINUOUS\nTom runs.\nint/ext. car — day\nnothing interior here';
    expect(Ctx.findSluglines(body)).toEqual([
      { line: 1, text: 'INT. DINER — NIGHT' },
      { line: 5, text: 'EXT. STREET - CONTINUOUS' },
      { line: 7, text: 'int/ext. car — day' },
    ]);
  });
  it('returns [] for prose without sluglines', () => {
    expect(Ctx.findSluglines('She waits. He arrives.')).toEqual([]);
  });
});

describe('formatCharacterFull', () => {
  it('shows every template field, the actor likeness, and plays-self', () => {
    const text = Ctx.formatCharacterFull({
      name: '**Sarah**', hollywood_actor: 'Emma Stone', plays_self: true,
      fields: { role: 'Waitress', description: 'Dark hair tied back, grey wool coat.', background_story: 'Grew up above the diner.', empty: '', memes: 'never drinks her coffee' },
    });
    expect(text).toContain('- Sarah — played by Emma Stone');
    expect(text).toContain('plays themself');
    expect(text).toContain('role: Waitress');
    expect(text).toContain('background story: Grew up above the diner.');
    expect(text).toContain('memes: never drinks her coffee');
    expect(text).not.toContain('empty:');
  });
  it('surfaces voice-only casting as a voice, not a face', () => {
    const text = Ctx.formatCharacterFull({ name: 'Fish', hollywood_actor: 'voice only: Jack Black', fields: {} });
    expect(text).toContain('voice casting');
    expect(text).not.toContain('played by');
  });
  it('caps a runaway field but keeps the rest', () => {
    const text = Ctx.formatCharacterFull({ name: 'X', fields: { description: 'a'.repeat(5000) } });
    expect(text.length).toBeLessThan(2200);
    expect(text).toContain('…');
  });
});

describe('buildFullBeatContextText', () => {
  it('sends the whole body (no 12k clip), lists sluglines, notes, numbered dialogue and neighbours', () => {
    const body = `INT. DINER — NIGHT\n\n${'Sarah waits. '.repeat(1500)}\n\nEXT. STREET — LATER\n\nTom runs.`;
    const text = Ctx.buildFullBeatContextText({
      beat: { order: 3, name: 'Arrival', desc: 'She waits.', body },
      characters: [{ name: 'Sarah', fields: { role: 'lead' } }],
      sets: [{ name: 'Diner', description: 'A roadside diner with a long counter.' }],
      directorNotes: [{ text: 'Never a score swell.' }, { text: '' }],
      dialogs: [
        { _id: new ObjectId(), character: 'Tom', body: 'I am sorry I am late', audio_file_id: null },
        { _id: new ObjectId(), character: 'Sarah', body: 'Do not.', audio_file_id: new ObjectId(), audio_duration_seconds: 1.4 },
      ],
      directorialVoice: 'Observational naturalist',
      neighbours: { previous: { order: 2, name: 'Before', desc: 'They fight.' }, next: { order: 4, name: 'After', desc: 'She leaves town.' } },
      direction: 'Keep it to two scenes.',
    });
    expect(text.length).toBeGreaterThan(19000);
    expect(text).toContain('Tom runs.');
    expect(text).toContain('# Directorial voice');
    expect(text).toContain('Observational naturalist');
    expect(text).toContain('- line 1: INT. DINER — NIGHT');
    expect(text).toContain('EXT. STREET — LATER');
    expect(text).toContain('Previous beat: #2 Before — They fight.');
    expect(text).toContain('Next beat: #4 After — She leaves town.');
    expect(text).toContain('- Never a score swell.');
    expect(text).toMatch(/1\. Tom: I am sorry I am late \[audio: none/);
    expect(text).toMatch(/2\. Sarah: Do not\. \[audio: 1\.4s recorded\]/);
    expect(text).toContain('- Diner\n    A roadside diner with a long counter.');
    expect(text).toContain("# Director's commentary for this run\nKeep it to two scenes.");
    expect(text).toContain('NEVER write them');
  });
  it('says so when there are no sluglines and no dialogue', () => {
    const text = Ctx.buildFullBeatContextText({ beat: { order: 1, name: 'A', body: 'Plain prose.' } });
    expect(text).toContain('Sluglines found in the body: none');
    expect(text).toContain('(none — no lines to cover)');
    expect(text).toContain('Previous beat: (none)');
  });
});

describe('loadFullBeatContext', () => {
  beforeEach(() => fakeDb.reset());
  it('gathers neighbours and dialogs and warns past the safety ceiling without clipping', async () => {
    const projectId = (await createProject('Ctx'))._id.toString();
    await Plots.createBeat({ projectId, name: 'One', body: 'first' });
    const beat = await Plots.createBeat({ projectId, name: 'Two', body: 'x'.repeat(Ctx.BEAT_BODY_SAFETY_CAP + 10) });
    await Plots.createBeat({ projectId, name: 'Three', body: 'third' });
    await Dialogs.createDialog({ projectId, beatId: beat._id, character: 'Sarah', body: 'Hello there' });
    const ctx = await Ctx.loadFullBeatContext({ projectId, beat });
    expect(ctx.warnings.length).toBe(1);
    expect(ctx.warnings[0]).toMatch(/safety ceiling/);
    expect(ctx.text).toContain('x'.repeat(Ctx.BEAT_BODY_SAFETY_CAP + 10));
    expect(ctx.text).toContain('Previous beat: #1 One');
    expect(ctx.text).toContain('Next beat: #3 Three');
    expect(ctx.dialogs.length).toBe(1);
    expect(ctx.text).toMatch(/1\. Sarah: Hello there/);
  });
});
