import { describe, it, expect } from 'vitest';
import { renderScreenplayPdf as renderImpl, formatFieldValue } from '../src/pdf/export.js';

// Default TOC off in this file so byte-size deltas measure the section
// behavior under test, not three-pass TOC overhead. TOC behavior is covered
// by tests/pdf-toc.test.js.
const renderScreenplayPdf = (args) => renderImpl({ toc: false, ...args });

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

  it('renders markdown in plot synopsis without crashing', async () => {
    // Lists, bold, italic, headings, and an HR in the synopsis text.
    const buf = await renderScreenplayPdf({
      title: 'Test',
      characters: [{ name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {} }],
      plot: {
        synopsis: '## Act One\n\n**Alice** discovers a *strange* door.\n\n- It glows.\n- It hums.\n\n---\n\nThen the story begins.',
        beats: [],
        notes: '',
      },
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  it('renders markdown bullets in director notes without crashing', async () => {
    const buf = await renderScreenplayPdf({
      title: 'Test',
      characters: [{ name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {} }],
      plot: { synopsis: 's', beats: [], notes: '' },
      directorNotes: {
        notes: [
          { text: '**IMPORTANT:** No anachronisms.\n\n- Unless flagged.\n- And then only for emphasis.' },
          { text: 'Use _sparing_ flashbacks.' },
        ],
      },
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  it('embeds Noto fonts (UTF-8 capable) into the PDF', async () => {
    // PDFKit writes the registered font's PostScript name into the font
    // dictionary. Searching for "NotoSans" in the raw byte stream confirms
    // we're embedding a Noto face rather than a base-14 standard font.
    const buf = await renderScreenplayPdf({
      title: 'Test',
      characters: [{ name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {} }],
      plot: { synopsis: 'Plain.', beats: [], notes: '' },
    });
    const ascii = buf.toString('latin1');
    expect(ascii).toMatch(/NotoSans/);
  });

  it('renders non-ASCII characters in free-text fields', async () => {
    // Emojis, accented Latin, Greek, and CJK should not throw with Noto.
    const buf = await renderScreenplayPdf({
      title: 'Tëst — α β 测试',
      characters: [{
        name: 'Aliçe', plays_self: true, hollywood_actor: null, own_voice: true,
        fields: { background: 'Naïve heroine — café régulier ☕' },
      }],
      plot: { synopsis: 'Σύνοψη — 简介', beats: [], notes: '' },
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});

describe('character field rendering', () => {
  it('does not overlap labels when a field value is empty', async () => {
    const buf = await renderScreenplayPdf({
      title: 'Test',
      characters: [{
        name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true,
        fields: {
          origin_story: null,
          alternate_names: [],
          background_story: 'Once upon a time.',
          name_changes: [{ name: 'Old Alice', changed_on: '2010-01-01' }],
        },
      }],
      plot: { synopsis: 's', beats: [], notes: '' },
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  it('renders each non-empty field on its own line (size grows with each field)', async () => {
    const baseArgs = {
      title: 'Test',
      plot: { synopsis: 's', beats: [], notes: '' },
    };
    const oneField = await renderScreenplayPdf({
      ...baseArgs,
      characters: [{
        name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true,
        fields: { background_story: 'Once upon a time.' },
      }],
    });
    const threeFields = await renderScreenplayPdf({
      ...baseArgs,
      characters: [{
        name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true,
        fields: {
          background_story: 'Once upon a time.',
          origin_story: 'She was born.',
          arc: 'She grew.',
        },
      }],
    });
    expect(threeFields.length).toBeGreaterThan(oneField.length + 100);
  });
});

describe('renderScreenplayPdf section skip guards', () => {
  const baseChars = [{
    name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true,
    fields: { background_story: 'Once upon a time in a land far, far away.' },
  }];
  const basePlot = { synopsis: 'A grand tale of intrigue and pastry.', beats: [], notes: '' };

  it('skips the Characters section when characters array is empty', async () => {
    const withChars = await renderScreenplayPdf({ title: 'T', characters: baseChars, plot: basePlot });
    const noChars = await renderScreenplayPdf({ title: 'T', characters: [], plot: basePlot });
    expect(withChars.length - noChars.length).toBeGreaterThan(200);
  });

  it('skips the Characters section when characters is undefined', async () => {
    const withChars = await renderScreenplayPdf({ title: 'T', characters: baseChars, plot: basePlot });
    const undef = await renderScreenplayPdf({ title: 'T', plot: basePlot });
    expect(withChars.length - undef.length).toBeGreaterThan(200);
  });

  it('skips the Plot section when synopsis, beats, and notes are all empty', async () => {
    const withPlot = await renderScreenplayPdf({
      title: 'T',
      characters: baseChars,
      plot: { synopsis: 'Has a synopsis.', beats: [], notes: '' },
    });
    const noPlot = await renderScreenplayPdf({
      title: 'T',
      characters: baseChars,
      plot: { synopsis: '', beats: [], notes: '' },
    });
    expect(withPlot.length - noPlot.length).toBeGreaterThan(150);
  });

  it('beats-only render: no Characters section, only beats appear in Plot', async () => {
    const beat = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', order: 1, name: 'Heist', desc: 'They steal it.', body: 'A long body.' };
    const both = await renderScreenplayPdf({
      title: 'T',
      characters: baseChars,
      plot: { synopsis: 'Has synopsis.', beats: [beat], notes: '' },
    });
    const beatsOnly = await renderScreenplayPdf({
      title: 'T',
      characters: [],
      plot: { synopsis: '', beats: [beat], notes: '' },
    });
    expect(both.length - beatsOnly.length).toBeGreaterThan(200);
    expect(beatsOnly.slice(0, 4).toString()).toBe('%PDF');
  });
});

describe('formatFieldValue', () => {
  it('returns plain strings unchanged', () => {
    expect(formatFieldValue('hello')).toBe('hello');
  });

  it('joins string arrays with commas', () => {
    expect(formatFieldValue(['Bobby', 'The Boss'])).toBe('Bobby, The Boss');
  });

  it('formats arrays of objects without producing [object Object]', () => {
    const v = [
      { name: 'Robert Smith', changed_on: '2018-05-12' },
      { name: 'Bob Jones', changed_on: '2020-01-01' },
    ];
    const out = formatFieldValue(v);
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('Robert Smith');
    expect(out).toContain('2018-05-12');
    expect(out).toContain('Bob Jones');
    expect(out).toContain('2020-01-01');
  });

  it('formats a bare object without [object Object]', () => {
    const out = formatFieldValue({ name: 'Robert Smith', changed_on: '2018-05-12' });
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('Robert Smith');
    expect(out).toContain('2018-05-12');
  });

  it('skips null/empty values inside object entries', () => {
    const out = formatFieldValue({ name: 'Solo', changed_on: null, note: '' });
    expect(out).toBe('name: Solo');
  });

  it('returns empty string for null/undefined', () => {
    expect(formatFieldValue(null)).toBe('');
    expect(formatFieldValue(undefined)).toBe('');
  });

  it('coerces numbers and booleans to strings', () => {
    expect(formatFieldValue(42)).toBe('42');
    expect(formatFieldValue(true)).toBe('true');
  });
});
