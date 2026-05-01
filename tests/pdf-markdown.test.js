import { describe, it, expect } from 'vitest';
import { tokenizeInline, tokenizeBlocks, renderMarkdown, NOTO_FONTS } from '../src/pdf/markdown.js';

// ────────────────────────────────────────────────────────────────────────────
// Inline tokenizer
// ────────────────────────────────────────────────────────────────────────────

describe('tokenizeInline', () => {
  it('returns plain text unchanged', () => {
    expect(tokenizeInline('Hello world.')).toEqual([{ text: 'Hello world.' }]);
  });

  it('handles bold (**)', () => {
    expect(tokenizeInline('Use **bold** text.')).toEqual([
      { text: 'Use ' },
      { text: 'bold', bold: true },
      { text: ' text.' },
    ]);
  });

  it('handles bold (__)', () => {
    expect(tokenizeInline('Use __bold__ text.')).toEqual([
      { text: 'Use ' },
      { text: 'bold', bold: true },
      { text: ' text.' },
    ]);
  });

  it('handles italic (*)', () => {
    expect(tokenizeInline('A *thoughtful* line.')).toEqual([
      { text: 'A ' },
      { text: 'thoughtful', italic: true },
      { text: ' line.' },
    ]);
  });

  it('handles italic (_)', () => {
    expect(tokenizeInline('A _thoughtful_ line.')).toEqual([
      { text: 'A ' },
      { text: 'thoughtful', italic: true },
      { text: ' line.' },
    ]);
  });

  it('handles bold-italic (***)', () => {
    expect(tokenizeInline('Most ***urgent*** alert.')).toEqual([
      { text: 'Most ' },
      { text: 'urgent', bold: true, italic: true },
      { text: ' alert.' },
    ]);
  });

  it('handles inline code', () => {
    expect(tokenizeInline('Run `npm test` now.')).toEqual([
      { text: 'Run ' },
      { text: 'npm test', mono: true },
      { text: ' now.' },
    ]);
  });

  it('handles a hyperlink', () => {
    expect(tokenizeInline('See [the docs](https://example.com) please.')).toEqual([
      { text: 'See ' },
      { text: 'the docs', link: 'https://example.com' },
      { text: ' please.' },
    ]);
  });

  it('strips image syntax', () => {
    // Image markup is consumed but the surrounding text stays in one run.
    expect(tokenizeInline('Look ![alt](https://x.com/a.png) here.')).toEqual([
      { text: 'Look  here.' },
    ]);
  });

  it('preserves backslash-escaped markers as literals', () => {
    expect(tokenizeInline('Literal \\*stars\\* here.')).toEqual([
      { text: 'Literal *stars* here.' },
    ]);
  });

  it('treats unmatched markers as literals', () => {
    // No closing `**` so the opener is just literal characters.
    expect(tokenizeInline('Half open **bold no end.')).toEqual([
      { text: 'Half open **bold no end.' },
    ]);
  });

  it('combines bold and italic when nested', () => {
    // `**bold _and italic_ inside**` — italic wraps a chunk inside bold.
    const runs = tokenizeInline('**bold _and italic_ inside**');
    expect(runs).toEqual([
      { text: 'bold ', bold: true },
      { text: 'and italic', bold: true, italic: true },
      { text: ' inside', bold: true },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Block tokenizer
// ────────────────────────────────────────────────────────────────────────────

describe('tokenizeBlocks', () => {
  it('parses a single paragraph', () => {
    const blocks = tokenizeBlocks('Just one line.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].inlines).toEqual([{ text: 'Just one line.' }]);
  });

  it('joins consecutive non-blank lines into one paragraph', () => {
    const blocks = tokenizeBlocks('first line\nsecond line\nthird line');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].inlines).toEqual([{ text: 'first line second line third line' }]);
  });

  it('separates paragraphs on blank line', () => {
    const blocks = tokenizeBlocks('one\n\ntwo');
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('parses ATX headings 1-6', () => {
    const blocks = tokenizeBlocks('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6');
    expect(blocks.map((b) => b.type)).toEqual(Array(6).fill('heading'));
    expect(blocks.map((b) => b.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('parses an HR', () => {
    expect(tokenizeBlocks('---').map((b) => b.type)).toEqual(['hr']);
    expect(tokenizeBlocks('***').map((b) => b.type)).toEqual(['hr']);
    expect(tokenizeBlocks('___').map((b) => b.type)).toEqual(['hr']);
  });

  it('parses a bullet list', () => {
    const blocks = tokenizeBlocks('- one\n- two\n- three');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'list',
      ordered: false,
      items: [
        { inlines: [{ text: 'one' }] },
        { inlines: [{ text: 'two' }] },
        { inlines: [{ text: 'three' }] },
      ],
    });
  });

  it('parses an ordered list', () => {
    const blocks = tokenizeBlocks('1. first\n2. second\n3. third');
    expect(blocks[0]).toMatchObject({
      type: 'list',
      ordered: true,
      items: [
        { marker: 1 },
        { marker: 2 },
        { marker: 3 },
      ],
    });
  });

  it('parses nested bullet lists by indent', () => {
    const blocks = tokenizeBlocks('- top\n  - nested\n  - nested two\n- top again');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].items.map((it) => it.depth)).toEqual([0, 1, 1, 0]);
  });

  it('parses a blockquote', () => {
    const blocks = tokenizeBlocks('> quoted line\n> second quoted line');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('blockquote');
  });

  it('parses a mixed document', () => {
    const md = '# Title\n\nIntro paragraph.\n\n- item one\n- item two\n\n---\n\nClosing thoughts.';
    const types = tokenizeBlocks(md).map((b) => b.type);
    expect(types).toEqual(['heading', 'paragraph', 'list', 'hr', 'paragraph']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// renderMarkdown: end-to-end against a fake PDFKit doc
// ────────────────────────────────────────────────────────────────────────────

function makeFakeDoc() {
  const calls = [];
  const doc = {
    y: 72,
    _font: null,
    _size: 11,
    _color: '#000',
    page: {
      width: 612,
      height: 792,
      margins: { top: 72, bottom: 72, left: 90, right: 72 },
    },
    registerFont(name) { calls.push(['registerFont', name]); return doc; },
    font(name) { doc._font = name; calls.push(['font', name]); return doc; },
    fontSize(size) { doc._size = size; calls.push(['fontSize', size]); return doc; },
    fillColor(c) { doc._color = c; calls.push(['fillColor', c]); return doc; },
    strokeColor(c) { calls.push(['strokeColor', c]); return doc; },
    lineWidth(w) { calls.push(['lineWidth', w]); return doc; },
    moveTo(x, y) { calls.push(['moveTo', x, y]); return doc; },
    lineTo(x, y) { calls.push(['lineTo', x, y]); return doc; },
    stroke() { calls.push(['stroke']); return doc; },
    save() { calls.push(['save']); return doc; },
    restore() { calls.push(['restore']); return doc; },
    moveDown(n) { calls.push(['moveDown', n]); return doc; },
    text(s, opts = {}) {
      calls.push(['text', s, { ...opts, _font: doc._font, _size: doc._size, _color: doc._color }]);
      return doc;
    },
    _calls: calls,
  };
  return doc;
}

describe('renderMarkdown', () => {
  it('emits plain text in a single paragraph', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, 'Just one line.');
    const textCalls = doc._calls.filter((c) => c[0] === 'text');
    expect(textCalls).toHaveLength(1);
    expect(textCalls[0][1]).toBe('Just one line.');
    expect(textCalls[0][2]._font).toBe(NOTO_FONTS.regular);
  });

  it('switches font for bold runs and chains continued: true', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, 'Use **bold** here.');
    const textCalls = doc._calls.filter((c) => c[0] === 'text');
    expect(textCalls.map((c) => c[1])).toEqual(['Use ', 'bold', ' here.']);
    expect(textCalls.map((c) => c[2]._font)).toEqual([
      NOTO_FONTS.regular,
      NOTO_FONTS.bold,
      NOTO_FONTS.regular,
    ]);
    expect(textCalls[0][2].continued).toBe(true);
    expect(textCalls[1][2].continued).toBe(true);
    // last run does NOT continue
    expect(textCalls[2][2].continued).toBeUndefined();
  });

  it('uses bold-italic font for ***triple*** runs', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, '***alert***');
    const fonts = doc._calls.filter((c) => c[0] === 'text').map((c) => c[2]._font);
    expect(fonts).toContain(NOTO_FONTS.boldItalic);
  });

  it('uses mono font for inline code', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, 'Run `npm test`.');
    const codeCall = doc._calls.find((c) => c[0] === 'text' && c[1] === 'npm test');
    expect(codeCall[2]._font).toBe(NOTO_FONTS.mono);
  });

  it('emits bullet markers for an unordered list', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, '- alpha\n- beta');
    const textCalls = doc._calls.filter((c) => c[0] === 'text');
    const strs = textCalls.map((c) => c[1]);
    expect(strs).toContain('• ');
    // Each item gets its own bullet
    expect(strs.filter((s) => s === '• ')).toHaveLength(2);
    expect(strs).toContain('alpha');
    expect(strs).toContain('beta');
  });

  it('emits numeric markers for ordered lists', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, '1. first\n2. second');
    const strs = doc._calls.filter((c) => c[0] === 'text').map((c) => c[1]);
    expect(strs).toContain('1. ');
    expect(strs).toContain('2. ');
  });

  it('renders link runs in blue with underline', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, 'See [docs](https://x.com) here.');
    const linkCall = doc._calls.find((c) => c[0] === 'text' && c[1] === 'docs');
    expect(linkCall[2].link).toBe('https://x.com');
    expect(linkCall[2].underline).toBe(true);
    expect(linkCall[2]._color).toBe('#0645AD');
  });

  it('draws a horizontal rule for ---', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, '---');
    const ops = doc._calls.map((c) => c[0]);
    expect(ops).toContain('moveTo');
    expect(ops).toContain('lineTo');
    expect(ops).toContain('stroke');
  });

  it('emits headings using the bold font at a larger size', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, '# Big heading\n\nbody');
    const headingCall = doc._calls.find((c) => c[0] === 'text' && c[1] === 'Big heading');
    expect(headingCall[2]._font).toBe(NOTO_FONTS.bold);
    expect(headingCall[2]._size).toBeGreaterThan(11);
  });

  it('continueFirstParagraph: true keeps first paragraph runs on the same line', () => {
    const doc = makeFakeDoc();
    // Caller emits "• " with continued: true, then renderMarkdown finishes the paragraph.
    doc.font('Noto').fontSize(11).fillColor('#000');
    doc.text('• ', { indent: 0, continued: true });
    renderMarkdown(doc, 'A **bold** thought.', {
      size: 11,
      paragraphGap: 4,
      continueFirstParagraph: true,
    });
    const textCalls = doc._calls.filter((c) => c[0] === 'text');
    // First call from caller is bullet, then renderMarkdown's runs follow.
    expect(textCalls[0][1]).toBe('• ');
    expect(textCalls[0][2].continued).toBe(true);
    // First markdown run does not pass `indent` since we're already mid-paragraph.
    expect(textCalls[1][2].indent).toBeUndefined();
  });

  it('continueFirstParagraph closes the line when first block is not a paragraph', () => {
    const doc = makeFakeDoc();
    doc.text('Header: ', { continued: true });
    renderMarkdown(doc, '- one\n- two', {
      size: 11,
      continueFirstParagraph: true,
    });
    // Should have emitted an empty `text('')` to break out of the continuation
    // before rendering the list.
    const textCalls = doc._calls.filter((c) => c[0] === 'text');
    const emptyCloseIdx = textCalls.findIndex((c) => c[1] === '');
    expect(emptyCloseIdx).toBeGreaterThanOrEqual(1);
    // The list bullets should follow.
    const bullets = textCalls.filter((c) => c[1] === '• ');
    expect(bullets.length).toBe(2);
  });

  it('handles empty/null input without throwing', () => {
    const doc = makeFakeDoc();
    expect(() => renderMarkdown(doc, '')).not.toThrow();
    expect(() => renderMarkdown(doc, null)).not.toThrow();
    expect(() => renderMarkdown(doc, undefined)).not.toThrow();
  });

  it('honors baseStyle: italic so plain text uses the italic font', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, 'Stage direction.', { baseStyle: 'italic' });
    const call = doc._calls.find((c) => c[0] === 'text' && c[1] === 'Stage direction.');
    expect(call[2]._font).toBe(NOTO_FONTS.italic);
  });

  it('escaped markers render as literal characters', () => {
    const doc = makeFakeDoc();
    renderMarkdown(doc, 'No \\*emphasis\\* here.');
    const call = doc._calls.find((c) => c[0] === 'text' && c[1].includes('emphasis'));
    expect(call[1]).toBe('No *emphasis* here.');
    expect(call[2]._font).toBe(NOTO_FONTS.regular);
  });
});
