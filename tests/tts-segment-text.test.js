import { describe, it, expect } from 'vitest';
import { segmentText, MAX_CHARS } from '../web/src/tts/segmentText.js';

const base = 'The room is quiet. Steve walks in. He sits down. Nobody speaks. ';

describe('segmentText', () => {
  it('never exceeds the cap and never loses a word', () => {
    const text = base.repeat(40);
    const segs = segmentText(text);
    expect(segs.length).toBeGreaterThan(5);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(segs.join(' ')).toBe(text.trim());
  });

  // The regression: kokoro-js's splitter treats these as an opening quote or
  // bracket that never closes and returns the whole text as ONE sentence.
  it.each([
    ["the writers' room is loud. ", 'possessive apostrophe'],
    ['He said "wait. ', 'stray double quote'],
    ['INT. HOUSE (NIGHT. ', 'unclosed paren'],
  ])('keeps splitting after %j (%s)', (prefix) => {
    const segs = segmentText(prefix + base.repeat(40));
    expect(segs.length).toBeGreaterThan(5);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it('keeps the first segment to one sentence so audio starts quickly', () => {
    expect(segmentText(base.repeat(5))[0]).toBe('The room is quiet.');
  });

  it('does not merge across paragraphs', () => {
    expect(segmentText('Title\n\nFirst line. Second line.\nNext para.')).toEqual([
      'Title', 'First line. Second line.', 'Next para.',
    ]);
  });

  it('breaks a punctuation-free run at clause marks, then spaces', () => {
    const long = `${'word '.repeat(40)}, ${'more '.repeat(60)}`.trim();
    const segs = segmentText(long);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(segs.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });

  it('hard-cuts a single unbroken token and drops symbol-only lines', () => {
    const segs = segmentText(`${'x'.repeat(600)}\n***\n---`);
    expect(segs.map((s) => s.length)).toEqual([250, 250, 100]);
  });

  it('returns [] for empty input', () => {
    expect(segmentText('  \n ')).toEqual([]);
  });
});
