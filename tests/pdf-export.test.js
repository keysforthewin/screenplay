import { describe, it, expect } from 'vitest';
import { renderScreenplayPdf } from '../src/pdf/export.js';

describe('renderScreenplayPdf', () => {
  it('produces a non-empty PDF buffer', async () => {
    const buf = await renderScreenplayPdf({
      title: 'Test',
      characters: [{
        name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true,
        fields: { background_story: 'Once upon a time.' },
      }],
      plot: { synopsis: 'A test.', beats: [{ order: 1, name: 'Open', desc: 'It begins.', body: 'Long form content.' }], notes: '' },
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  it("embeds Director's Notes when notes are provided", async () => {
    const baseArgs = {
      title: 'Test',
      characters: [{ name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {} }],
      plot: { synopsis: 's', beats: [], notes: '' },
    };
    const without = await renderScreenplayPdf(baseArgs);
    const withNotes = await renderScreenplayPdf({
      ...baseArgs,
      directorNotes: {
        notes: [
          { text: 'Unnamed extras are Feral Ewoks.' },
          { text: 'No anachronisms unless flagged.' },
        ],
      },
    });
    // PDFKit flate-compresses text streams, so we can't substring-match the
    // notes' text. But adding a whole page with a heading + bullets pushes
    // the byte size up by hundreds of bytes; size-delta is a reliable signal
    // that the section was actually rendered.
    expect(withNotes.length - without.length).toBeGreaterThan(200);
  });

  it('omits the Director\'s Notes page when the notes list is empty', async () => {
    const baseArgs = {
      title: 'Test',
      characters: [{ name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {} }],
      plot: { synopsis: 's', beats: [], notes: '' },
    };
    const without = await renderScreenplayPdf(baseArgs);
    const empty = await renderScreenplayPdf({ ...baseArgs, directorNotes: { notes: [] } });
    // Empty director notes should produce a byte-identical PDF (no extra page).
    // We allow tiny variance in case PDFKit timestamps the doc, so compare lengths.
    expect(Math.abs(empty.length - without.length)).toBeLessThan(50);
  });
});
