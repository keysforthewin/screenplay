import { describe, it, expect } from 'vitest';
import { renderScreenplayPdf } from '../src/pdf/export.js';

// Minimal valid 1x1 RGB PNG (red pixel) — accepted by PDFKit's openImage/image.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082',
  'hex',
);

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

  it('embeds every image in a character or beat bundle, not just the main image', async () => {
    const charId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const beatId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const baseArgs = {
      title: 'Test',
      characters: [{
        _id: charId,
        name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {},
      }],
      plot: { synopsis: 's', beats: [{ _id: beatId, order: 1, name: 'Open' }], notes: '' },
    };
    const oneEach = await renderScreenplayPdf({
      ...baseArgs,
      characterImages: { [charId]: [{ buffer: TINY_PNG, meta: {} }] },
      beatImages: { [beatId]: [{ buffer: TINY_PNG, meta: {} }] },
    });
    const threeEach = await renderScreenplayPdf({
      ...baseArgs,
      characterImages: {
        [charId]: [
          { buffer: TINY_PNG, meta: {} },
          { buffer: TINY_PNG, meta: {} },
          { buffer: TINY_PNG, meta: {} },
        ],
      },
      beatImages: {
        [beatId]: [
          { buffer: TINY_PNG, meta: {} },
          { buffer: TINY_PNG, meta: {} },
          { buffer: TINY_PNG, meta: {} },
        ],
      },
    });
    // Each extra embedded image adds drawing instructions and graphics-state ops.
    // Going from 1→3 images on two owners (4 extra embeds total) reliably grows
    // the PDF; threshold accounts for PDFKit deduping the underlying image XObject.
    expect(threeEach.length).toBeGreaterThan(oneEach.length + 100);
  });

  it('lists inline character and beat attachments', async () => {
    const charId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const beatId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const attId = 'cccccccccccccccccccccccc';
    const baseArgs = {
      title: 'Test',
      characters: [{
        _id: charId,
        name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {},
      }],
      plot: { synopsis: 's', beats: [{ _id: beatId, order: 1, name: 'Open' }], notes: '' },
    };
    const without = await renderScreenplayPdf(baseArgs);
    const withAttachments = await renderScreenplayPdf({
      ...baseArgs,
      characters: [{
        ...baseArgs.characters[0],
        attachments: [{ _id: attId, filename: 'bio.pdf', content_type: 'application/pdf', size: 12345, caption: 'character backstory' }],
      }],
      plot: {
        ...baseArgs.plot,
        beats: [{
          ...baseArgs.plot.beats[0],
          attachments: [{ _id: attId, filename: 'storyboard.png', content_type: 'image/png', size: 9999 }],
        }],
      },
    });
    // Two new "Attachments:" sections + bullet lines should grow the byte count
    // well beyond timestamp/Producer-string drift.
    expect(withAttachments.length - without.length).toBeGreaterThan(150);
  });

  it('renders a Library page when library has images or attachments', async () => {
    const baseArgs = {
      title: 'Test',
      characters: [{ name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {} }],
      plot: { synopsis: 's', beats: [], notes: '' },
    };
    const without = await renderScreenplayPdf(baseArgs);
    const withLib = await renderScreenplayPdf({
      ...baseArgs,
      library: {
        images: [{ buffer: TINY_PNG, file: { filename: 'orphan.png' } }],
        attachments: [{ _id: 'cccccccccccccccccccccccc', filename: 'lost.txt', contentType: 'text/plain', length: 42 }],
      },
    });
    // New page + heading + image + attachment line = sizeable delta.
    expect(withLib.length - without.length).toBeGreaterThan(300);
  });

  it('omits the Library page when library is empty', async () => {
    const baseArgs = {
      title: 'Test',
      characters: [{ name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {} }],
      plot: { synopsis: 's', beats: [], notes: '' },
    };
    const without = await renderScreenplayPdf(baseArgs);
    const empty = await renderScreenplayPdf({
      ...baseArgs,
      library: { images: [], attachments: [] },
    });
    expect(Math.abs(empty.length - without.length)).toBeLessThan(50);
  });
});
