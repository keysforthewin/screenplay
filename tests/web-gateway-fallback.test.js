// Verifies the gateway's fallback path: when Hocuspocus is not running (i.e.
// in tests / CLI scripts), text-mutation gateway calls reach Mongo via the
// underlying helpers, and non-text mutations still update Mongo + no-op the
// stateless broadcast. This is the same code path the agent loop's existing
// tests already exercise transitively, but covering it directly catches
// regressions.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const Gateway = await import('../src/web/gateway.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');

describe('gateway fallback (no Hocuspocus)', () => {
  beforeEach(() => fakeDb.reset());

  it('setBeatBodyViaGateway writes the beat body via Mongo', async () => {
    const beat = await Plots.createBeat({ name: 'Pilot', desc: 'Opening scene' });
    await Gateway.setBeatBodyViaGateway(beat._id.toString(), 'Once upon a time...');
    const fresh = await Plots.getBeat(beat._id.toString());
    expect(fresh.body).toBe('Once upon a time...');
  });

  it('appendBeatBodyViaGateway appends to the beat body', async () => {
    const beat = await Plots.createBeat({ name: 'Pilot', desc: 'X', body: 'first' });
    await Gateway.appendBeatBodyViaGateway(beat._id.toString(), 'second');
    const fresh = await Plots.getBeat(beat._id.toString());
    expect(fresh.body).toBe('first\n\nsecond');
  });

  it('editBeatBodyViaGateway applies find/replace edits', async () => {
    const beat = await Plots.createBeat({ name: 'Pilot', desc: 'X', body: 'foo bar baz' });
    const result = await Gateway.editBeatBodyViaGateway(beat._id.toString(), [
      { find: 'bar', replace: 'BAZ' },
    ]);
    expect(result.applied).toHaveLength(1);
    const fresh = await Plots.getBeat(beat._id.toString());
    expect(fresh.body).toBe('foo BAZ baz');
  });

  it('updateBeatViaGateway rejects non-object patches', async () => {
    await Plots.createBeat({ name: 'X', desc: 'Y' });
    await expect(
      Gateway.updateBeatViaGateway('1', 'not-an-object'),
    ).rejects.toThrow(/must be an object/);
  });

  it('updateCharacterViaGateway writes name + custom field', async () => {
    const c = await Characters.createCharacter({ name: 'Steve' });
    await Gateway.updateCharacterViaGateway(c._id.toString(), {
      name: 'Steven',
      'fields.background_story': 'Born in 1990.',
    });
    const fresh = await Characters.getCharacter(c._id.toString());
    expect(fresh.name).toBe('Steven');
    expect(fresh.fields?.background_story).toBe('Born in 1990.');
  });

  it('updateCharacterViaGateway rejects unrecognized fields', async () => {
    const c = await Characters.createCharacter({ name: 'Bob' });
    await expect(
      Gateway.updateCharacterViaGateway(c._id.toString(), { totally_made_up: 'x' }),
    ).rejects.toThrow(/no recognized fields/);
  });

  it('addDirectorNoteViaGateway then editDirectorNoteViaGateway round-trips text', async () => {
    const note = await Gateway.addDirectorNoteViaGateway({ text: 'first version' });
    await Gateway.editDirectorNoteViaGateway({ noteId: note._id.toString(), text: 'second version' });
    const doc = await DirectorNotes.getDirectorNotes();
    expect(doc.notes).toHaveLength(1);
    expect(doc.notes[0].text).toBe('second version');
  });

  it('removeDirectorNoteViaGateway deletes the note', async () => {
    const note = await Gateway.addDirectorNoteViaGateway({ text: 'doomed' });
    await Gateway.removeDirectorNoteViaGateway({ noteId: note._id.toString() });
    const doc = await DirectorNotes.getDirectorNotes();
    expect(doc.notes).toHaveLength(0);
  });
});
