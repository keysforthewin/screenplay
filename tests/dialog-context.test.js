// Unit test for buildDialogContext — the shared steering-context assembler
// used by dialogue generation, per-line regeneration, and the critic.

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

const Plots = await import('../src/mongo/plots.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Characters = await import('../src/mongo/characters.js');
const { buildDialogContext } = await import('../src/web/dialogContext.js');

beforeEach(() => {
  fakeDb.reset();
});

async function setPlotStyle(text) {
  await fakeDb
    .collection('plots')
    .updateOne({ _id: 'main' }, { $set: { dialogue_style: text } });
}

describe('buildDialogContext', () => {
  it('includes the logline (title + synopsis)', async () => {
    await Plots.updatePlot({ title: 'The Long Drive', synopsis: 'A courier crosses a dead country.' });
    const beat = await Plots.createBeat({ name: 'Open road', desc: 'd', body: 'b' });

    const ctx = await buildDialogContext(beat);
    expect(ctx).toContain('The Long Drive');
    expect(ctx).toContain('A courier crosses a dead country.');
  });

  it('includes the previous beat name and its closing dialogue lines', async () => {
    const b1 = await Plots.createBeat({ name: 'The diner', desc: 'd1', body: 'b1' });
    const b2 = await Plots.createBeat({ name: 'The road', desc: 'd2', body: 'b2' });
    await Dialogs.createDialog({ beatId: b1._id, body: 'You sure about this?', character: 'Alice' });
    await Dialogs.createDialog({ beatId: b1._id, body: 'No. Drive.', character: 'Bob' });

    const ctx = await buildDialogContext(b2);
    expect(ctx).toContain('The diner');
    expect(ctx).toContain('No. Drive.');
  });

  it('omits the previous-beat section for the first beat', async () => {
    const b1 = await Plots.createBeat({ name: 'First', desc: 'd', body: 'b' });
    const ctx = await buildDialogContext(b1);
    expect(ctx).not.toMatch(/previous beat/i);
  });

  it('includes the per-beat dialogue notes when present', async () => {
    const beat = await Plots.createBeat({ name: 'Tense', desc: 'd', body: 'b' });
    beat.dialog_notes = 'Keep it clipped. Nobody says what they mean.';

    const ctx = await buildDialogContext(beat);
    expect(ctx).toContain('Keep it clipped. Nobody says what they mean.');
  });

  it('includes the project dialogue style when present', async () => {
    const beat = await Plots.createBeat({ name: 'Tense', desc: 'd', body: 'b' });
    await setPlotStyle('1970s neo-noir. Sparse, hard-boiled. Think Chinatown.');

    const ctx = await buildDialogContext(beat);
    expect(ctx).toContain('1970s neo-noir');
    expect(ctx).toContain('Chinatown');
  });

  it('includes character bios for the beat speakers', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      fields: { background_story: 'Former courier.', memes: 'Says "well well well".' },
    });
    const beat = await Plots.createBeat({
      name: 'Meet', desc: 'd', body: 'b', characters: ['Alice'],
    });

    const ctx = await buildDialogContext(beat);
    expect(ctx).toContain('## Alice');
    expect(ctx).toContain('background_story: Former courier.');
    expect(ctx).toContain('memes: Says "well well well".');
  });
});
