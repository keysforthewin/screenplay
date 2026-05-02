import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import {
  formatTocLabel,
  buildAnchorContext,
  renderToc,
  measureTocPageCount,
} from '../src/pdf/toc.js';
import { renderScreenplayPdf } from '../src/pdf/export.js';
import { registerNotoFonts } from '../src/pdf/markdown.js';

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082',
  'hex',
);

function countPages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

function multiSectionArgs(extras = {}) {
  return {
    title: 'Test',
    directorNotes: { notes: [{ text: 'Standing rule one.' }] },
    characters: [
      {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        name: 'Alice', plays_self: true, hollywood_actor: null, own_voice: true, fields: {},
      },
      {
        _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        name: 'Bob', plays_self: false, hollywood_actor: 'Some Actor', own_voice: true, fields: {},
      },
    ],
    plot: {
      synopsis: 'A grand tale.',
      beats: [
        { _id: 'cccccccccccccccccccccccc', order: 1, name: 'Opening' },
        { _id: 'dddddddddddddddddddddddd', order: 2, name: 'Climax' },
      ],
      notes: '',
    },
    library: {
      images: [{ buffer: TINY_PNG, file: { filename: 'orphan.png' } }],
      attachments: [],
    },
    ...extras,
  };
}

async function renderTocStandalone(entries, offset = 0) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margins: { top: 72, bottom: 72, left: 90, right: 72 },
      bufferPages: true,
      autoFirstPage: false,
    });
    registerNotoFonts(doc);
    const chunks = [];
    let pageCount = 0;
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      resolve({ buf: Buffer.concat(chunks), pageCount });
    });
    doc.on('error', reject);
    renderToc(doc, entries, offset);
    pageCount = doc.bufferedPageRange().count;
    doc.end();
  });
}

function entry(kind, label, pageNumber, depth = 0, idx = 0) {
  return {
    kind,
    label,
    pageNumber,
    depth,
    destinationName: `toc-${kind}-${label.toLowerCase().replace(/\s+/g, '-')}-${idx + 1}`,
  };
}

function makeFakeDoc(initialPage = 1) {
  const fake = {
    page: { number: initialPage, dictionary: { fakePage: initialPage } },
    outline: {
      items: [],
      addItem(title) {
        const child = {
          title,
          parent: this,
          items: [],
          addItem(t) {
            const sub = { title: t, parent: this, items: [] };
            this.items.push(sub);
            return sub;
          },
        };
        this.items.push(child);
        return child;
      },
    },
    setPage(n) { this.page.number = n; this.page.dictionary = { fakePage: n }; },
  };
  return fake;
}

describe('formatTocLabel', () => {
  it('returns plain text unchanged when short and clean', () => {
    expect(formatTocLabel('Opening Scene')).toBe('Opening Scene');
  });

  it('strips bold markdown', () => {
    expect(formatTocLabel('**Climax**')).toBe('Climax');
    expect(formatTocLabel('She **suddenly** realizes')).toBe('She suddenly realizes');
  });

  it('strips italic markdown (asterisks and underscores)', () => {
    expect(formatTocLabel('*urgent*')).toBe('urgent');
    expect(formatTocLabel('_pivotal_')).toBe('pivotal');
    expect(formatTocLabel('A *very* important *moment*')).toBe('A very important moment');
  });

  it('strips inline code markdown', () => {
    expect(formatTocLabel('the `meta` beat')).toBe('the meta beat');
  });

  it('strips link markdown, keeping the link text', () => {
    expect(formatTocLabel('See [the rules](http://example.com)')).toBe('See the rules');
  });

  it('collapses internal whitespace and newlines into single spaces', () => {
    expect(formatTocLabel('First line\n\nSecond line')).toBe('First line Second line');
    expect(formatTocLabel('Many   spaces\there')).toBe('Many spaces here');
  });

  it('truncates with ellipsis when over maxChars', () => {
    const long = 'A'.repeat(80);
    const out = formatTocLabel(long, { maxChars: 20 });
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not truncate when under maxChars', () => {
    const out = formatTocLabel('Short', { maxChars: 60 });
    expect(out).toBe('Short');
  });

  it('returns empty string for null, undefined, or empty input', () => {
    expect(formatTocLabel(null)).toBe('');
    expect(formatTocLabel(undefined)).toBe('');
    expect(formatTocLabel('')).toBe('');
  });

  it('coerces non-string input to string', () => {
    expect(formatTocLabel(42)).toBe('42');
  });

  it('handles combined markdown in one label', () => {
    expect(formatTocLabel('**Bold** and *italic* with `code` and [link](url)')).toBe(
      'Bold and italic with code and link',
    );
  });

  it('trims leading and trailing whitespace', () => {
    expect(formatTocLabel('   padded   ')).toBe('padded');
  });
});

describe('buildAnchorContext', () => {
  describe('capture mode', () => {
    it('records an entry with kind, label, page number, and depth 0 for anchor()', () => {
      const doc = makeFakeDoc(3);
      const ctx = buildAnchorContext('capture', doc);
      ctx.anchor('characters', 'Characters');
      expect(ctx.entries).toHaveLength(1);
      expect(ctx.entries[0]).toMatchObject({
        kind: 'characters',
        label: 'Characters',
        pageNumber: 3,
        depth: 0,
      });
      expect(ctx.entries[0].destinationName).toMatch(/^toc-characters-/);
    });

    it('records depth 1 for subAnchor()', () => {
      const doc = makeFakeDoc(4);
      const ctx = buildAnchorContext('capture', doc);
      ctx.subAnchor('character', 'Alice');
      expect(ctx.entries[0].depth).toBe(1);
    });

    it('returns the destination name from anchor()', () => {
      const doc = makeFakeDoc(2);
      const ctx = buildAnchorContext('capture', doc);
      const dest = ctx.anchor('plot', 'Plot');
      expect(typeof dest).toBe('string');
      expect(dest).toBe(ctx.entries[0].destinationName);
    });

    it('captures the current page number at the time anchor() is called', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('capture', doc);
      ctx.anchor('director_notes', "Director's Notes");
      doc.setPage(5);
      ctx.anchor('characters', 'Characters');
      expect(ctx.entries[0].pageNumber).toBe(1);
      expect(ctx.entries[1].pageNumber).toBe(5);
    });

    it('generates unique destination names even when labels repeat', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('capture', doc);
      ctx.subAnchor('character', 'Alice');
      ctx.subAnchor('character', 'Alice');
      expect(ctx.entries[0].destinationName).not.toBe(ctx.entries[1].destinationName);
    });

    it('does not call doc.outline in capture mode', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('capture', doc);
      ctx.anchor('plot', 'Plot');
      expect(doc.outline.items).toHaveLength(0);
    });

    it('slugifies labels safely into destination names (no spaces, lowercase, ascii)', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('capture', doc);
      ctx.subAnchor('character', 'Aliçe O\'Brien');
      expect(ctx.entries[0].destinationName).toMatch(/^toc-character-[a-z0-9-]+$/);
    });
  });

  describe('final mode', () => {
    it('adds a top-level outline item for anchor()', () => {
      const doc = makeFakeDoc(3);
      const ctx = buildAnchorContext('final', doc);
      ctx.anchor('characters', 'Characters');
      expect(doc.outline.items).toHaveLength(1);
      expect(doc.outline.items[0].title).toBe('Characters');
    });

    it('returns the destination name from anchor()', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('final', doc);
      const dest = ctx.anchor('plot', 'Plot');
      expect(typeof dest).toBe('string');
      expect(dest).toMatch(/^toc-plot-/);
    });

    it('nests subAnchor entries under the most recent top-level outline item', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('final', doc);
      ctx.anchor('characters', 'Characters');
      ctx.subAnchor('character', 'Alice');
      ctx.subAnchor('character', 'Bob');
      expect(doc.outline.items).toHaveLength(1);
      expect(doc.outline.items[0].items).toHaveLength(2);
      expect(doc.outline.items[0].items[0].title).toBe('Alice');
      expect(doc.outline.items[0].items[1].title).toBe('Bob');
    });

    it('switches sub-entries to the new parent when a new top-level anchor is added', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('final', doc);
      ctx.anchor('characters', 'Characters');
      ctx.subAnchor('character', 'Alice');
      ctx.anchor('plot', 'Plot');
      ctx.subAnchor('beat', '1. Open');
      expect(doc.outline.items).toHaveLength(2);
      expect(doc.outline.items[0].items[0].title).toBe('Alice');
      expect(doc.outline.items[1].items[0].title).toBe('1. Open');
    });

    it('does not push to a collector in final mode', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('final', doc);
      ctx.anchor('plot', 'Plot');
      expect(ctx.entries).toHaveLength(0);
    });
  });

  describe('noop mode', () => {
    it('does nothing and returns undefined', () => {
      const doc = makeFakeDoc(1);
      const ctx = buildAnchorContext('noop', doc);
      const dest = ctx.anchor('plot', 'Plot');
      expect(dest).toBeUndefined();
      expect(ctx.entries).toHaveLength(0);
      expect(doc.outline.items).toHaveLength(0);
    });
  });
});

describe('renderToc', () => {
  it('produces a valid PDF buffer with a TOC page', async () => {
    const entries = [
      entry('director_notes', "Director's Notes", 2, 0, 0),
      entry('characters', 'Characters', 3, 0, 1),
      entry('plot', 'Plot', 5, 0, 2),
    ];
    const { buf, pageCount } = await renderTocStandalone(entries, 1);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(pageCount).toBeGreaterThanOrEqual(1);
  });

  it('embeds destination names from entries as link annotations in the raw PDF', async () => {
    const entries = [
      entry('director_notes', "Director's Notes", 2, 0, 0),
      entry('characters', 'Characters', 3, 0, 1),
      entry('character', 'Alice', 3, 1, 2),
      entry('plot', 'Plot', 5, 0, 3),
    ];
    const { buf } = await renderTocStandalone(entries, 1);
    const ascii = buf.toString('latin1');
    for (const e of entries) {
      expect(ascii).toContain(e.destinationName);
    }
  });

  it('paginates when there are too many entries to fit on one page', async () => {
    const many = [];
    for (let i = 0; i < 200; i += 1) {
      many.push(entry('beat', `Beat number ${i + 1}`, i + 5, 1, i));
    }
    const { pageCount } = await renderTocStandalone(many, 1);
    expect(pageCount).toBeGreaterThan(1);
  });

  it('renders zero entries without crashing (produces a single page)', async () => {
    const { buf, pageCount } = await renderTocStandalone([], 0);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(pageCount).toBe(1);
  });
});

describe('measureTocPageCount', () => {
  it('returns 1 for a small TOC', () => {
    const entries = [
      entry('characters', 'Characters', 2, 0, 0),
      entry('plot', 'Plot', 5, 0, 1),
    ];
    expect(measureTocPageCount(entries)).toBe(1);
  });

  it('returns the same count as renderToc actually produces', async () => {
    const entries = [];
    for (let i = 0; i < 80; i += 1) {
      entries.push(entry('beat', `Beat ${i + 1}`, i + 3, 1, i));
    }
    const measured = measureTocPageCount(entries);
    const { pageCount: actual } = await renderTocStandalone(entries, 1);
    expect(measured).toBe(actual);
  });

  it('grows when there are many more entries', () => {
    const small = [entry('plot', 'Plot', 2, 0, 0)];
    const huge = [];
    for (let i = 0; i < 500; i += 1) {
      huge.push(entry('beat', `Long beat name ${i + 1}`, i + 3, 1, i));
    }
    expect(measureTocPageCount(huge)).toBeGreaterThan(measureTocPageCount(small));
  });
});

describe('renderScreenplayPdf TOC integration', () => {
  it('embeds a TOC with destinations for every section and sub-entry', async () => {
    const buf = await renderScreenplayPdf(multiSectionArgs());
    const ascii = buf.toString('latin1');
    expect(ascii).toMatch(/toc-director_notes-/);
    expect(ascii).toMatch(/toc-characters-/);
    expect(ascii).toMatch(/toc-character-alice-/);
    expect(ascii).toMatch(/toc-character-bob-/);
    expect(ascii).toMatch(/toc-plot-/);
    expect(ascii).toMatch(/toc-beat-/);
    expect(ascii).toMatch(/toc-library-/);
  });

  it('grows the page count by tocPageCount when TOC is enabled', async () => {
    const args = multiSectionArgs();
    const withToc = await renderScreenplayPdf(args);
    const withoutToc = await renderScreenplayPdf({ ...args, toc: false });
    const withTocPages = countPages(withToc);
    const withoutTocPages = countPages(withoutToc);
    expect(withTocPages).toBeGreaterThan(withoutTocPages);
    // For this small fixture, the TOC fits on a single page.
    expect(withTocPages - withoutTocPages).toBe(1);
  });

  it('skips the TOC when there are fewer than 2 sections', async () => {
    const oneSectionOnly = {
      title: 'Solo',
      directorNotes: { notes: [{ text: 'Only one section.' }] },
      characters: [],
      plot: { synopsis: '', beats: [], notes: '' },
    };
    const withTocAttempted = await renderScreenplayPdf(oneSectionOnly);
    const explicitlyDisabled = await renderScreenplayPdf({ ...oneSectionOnly, toc: false });
    // When < 2 sections, TOC should be skipped, producing identical output.
    expect(Math.abs(withTocAttempted.length - explicitlyDisabled.length)).toBeLessThan(50);
    // No TOC dest names should appear.
    expect(withTocAttempted.toString('latin1')).not.toMatch(/toc-director_notes-/);
  });

  it('opt-out: toc=false produces a PDF without any TOC destinations', async () => {
    const buf = await renderScreenplayPdf({ ...multiSectionArgs(), toc: false });
    const ascii = buf.toString('latin1');
    expect(ascii).not.toMatch(/toc-/);
  });

  it('populates the PDF outline (bookmarks) tree', async () => {
    const buf = await renderScreenplayPdf(multiSectionArgs());
    const ascii = buf.toString('latin1');
    expect(ascii).toMatch(/\/Outlines/);
  });

  it('produces a structurally valid PDF with TOC', async () => {
    const buf = await renderScreenplayPdf(multiSectionArgs());
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.slice(-6).toString()).toMatch(/%%EOF/);
  });

  it('handles markdown-laden beat names by stripping them in the TOC label', async () => {
    const args = multiSectionArgs({
      plot: {
        synopsis: 'A tale.',
        beats: [{ _id: 'eeeeeeeeeeeeeeeeeeeeeeee', order: 1, name: '**Epic** *climax*' }],
        notes: '',
      },
    });
    const buf = await renderScreenplayPdf(args);
    const ascii = buf.toString('latin1');
    // Beat dest name should appear; slugified label drops asterisks.
    expect(ascii).toMatch(/toc-beat-/);
  });
});
