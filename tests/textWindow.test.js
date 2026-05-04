import { describe, it, expect } from 'vitest';
import {
  sliceLines,
  searchLines,
  extractOutline,
  truncateForPreview,
  applyMarkdownEdits,
} from '../src/util/textWindow.js';

const SAMPLE = [
  '# Act One',
  '',
  'INT. DINER - DAY',
  '',
  'Steve sits across from Maya.',
  '',
  '## Scene 2',
  '',
  'Maya stands.',
  'She walks out.',
].join('\n');

describe('sliceLines', () => {
  it('returns a window of lines with metadata', () => {
    const out = sliceLines(SAMPLE, 3, 4);
    expect(out.totalLines).toBe(10);
    expect(out.rangeStart).toBe(3);
    expect(out.rangeEnd).toBe(6);
    expect(out.hasMore).toBe(true);
    expect(out.lines.map((l) => l.n)).toEqual([3, 4, 5, 6]);
    expect(out.lines[0].text).toBe('INT. DINER - DAY');
  });

  it('clamps a too-large lineCount', () => {
    const out = sliceLines(SAMPLE, 9, 50);
    expect(out.lines.map((l) => l.n)).toEqual([9, 10]);
    expect(out.hasMore).toBe(false);
  });

  it('clamps lineStart < 1 to 1', () => {
    const out = sliceLines(SAMPLE, 0, 2);
    expect(out.rangeStart).toBe(1);
    expect(out.lines.map((l) => l.n)).toEqual([1, 2]);
  });

  it('returns empty lines for past-end start', () => {
    const out = sliceLines(SAMPLE, 999, 5);
    expect(out.lines).toEqual([]);
    expect(out.hasMore).toBe(false);
  });

  it('handles empty string', () => {
    const out = sliceLines('', 1, 10);
    expect(out.totalLines).toBe(1); // one empty line
    expect(out.lines).toEqual([{ n: 1, text: '' }]);
  });

  it('handles single line without trailing newline', () => {
    const out = sliceLines('one line only', 1, 10);
    expect(out.totalLines).toBe(1);
    expect(out.lines[0].text).toBe('one line only');
  });

  it('strips a single trailing CR per line', () => {
    const out = sliceLines('a\r\nb\r\nc', 1, 5);
    expect(out.lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('searchLines', () => {
  it('finds substring matches with surrounding context', () => {
    const out = searchLines(SAMPLE, 'Maya', { contextLines: 1 });
    expect(out.totalMatches).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.matches.length).toBe(2);
    // First match on line 5, ±1 context → lines 4-6.
    expect(out.matches[0].context_start).toBe(4);
    expect(out.matches[0].context_end).toBe(6);
    expect(out.matches[0].match_lines).toEqual([5]);
  });

  it('merges overlapping context windows', () => {
    const out = searchLines(SAMPLE, 'Maya', { contextLines: 5 });
    expect(out.matches.length).toBe(1);
    expect(out.matches[0].match_lines).toEqual([5, 9]);
  });

  it('honors maxMatches and reports truncation', () => {
    const text = Array(10).fill('Maya').join('\n');
    const out = searchLines(text, 'Maya', { maxMatches: 3, contextLines: 0 });
    expect(out.totalMatches).toBe(3);
    expect(out.truncated).toBe(true);
  });

  it('substring search is case-insensitive by default', () => {
    const out = searchLines(SAMPLE, 'maya');
    expect(out.totalMatches).toBe(2);
  });

  it('regex mode opts in to case-sensitive by default', () => {
    const out = searchLines(SAMPLE, '^Maya$', { regex: true });
    // "Maya stands." starts with Maya — no match because anchors require full line.
    // "She walks out." — no match.
    expect(out.totalMatches).toBe(0);
  });

  it('regex mode with caseInsensitive flag works', () => {
    const out = searchLines(SAMPLE, '\\bmaya\\b', { regex: true, caseInsensitive: true });
    expect(out.totalMatches).toBe(2);
  });

  it('throws on invalid regex', () => {
    expect(() => searchLines(SAMPLE, '[unclosed', { regex: true })).toThrow(/invalid regex/);
  });

  it('returns no matches for empty pattern', () => {
    const out = searchLines(SAMPLE, '');
    expect(out.totalMatches).toBe(0);
  });
});

describe('extractOutline', () => {
  it('extracts ATX headings with line numbers and levels', () => {
    const out = extractOutline(SAMPLE);
    expect(out).toEqual([
      { level: 1, line: 1, text: 'Act One' },
      { level: 2, line: 7, text: 'Scene 2' },
    ]);
  });

  it('extracts setext headings', () => {
    const text = ['Title', '=====', '', 'Sub', '---', '', 'body'].join('\n');
    const out = extractOutline(text);
    expect(out).toEqual([
      { level: 1, line: 1, text: 'Title' },
      { level: 2, line: 4, text: 'Sub' },
    ]);
  });

  it('returns empty array when no headings present', () => {
    expect(extractOutline('just some text\nno headings')).toEqual([]);
  });

  it('handles empty input', () => {
    expect(extractOutline('')).toEqual([]);
  });

  it('strips trailing # closer characters', () => {
    expect(extractOutline('## Scene 2 ##')).toEqual([{ level: 2, line: 1, text: 'Scene 2' }]);
  });
});

describe('truncateForPreview', () => {
  it('returns full text under threshold', () => {
    const out = truncateForPreview('hello world', 100);
    expect(out.truncated).toBe(false);
    expect(out.preview).toBe('hello world');
    expect(out.totalChars).toBe(11);
  });

  it('truncates at next newline past maxChars', () => {
    const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50);
    const out = truncateForPreview(text, 30);
    expect(out.truncated).toBe(true);
    expect(out.preview).toBe('a'.repeat(50));
    expect(out.totalChars).toBe(101);
  });

  it('hard-cuts when no newline within 200 chars of threshold', () => {
    const text = 'x'.repeat(2000);
    const out = truncateForPreview(text, 100);
    expect(out.truncated).toBe(true);
    expect(out.preview.length).toBe(100);
  });
});

describe('applyMarkdownEdits', () => {
  it('applies a single edit and reports stats', () => {
    const out = applyMarkdownEdits('hello world', [{ find: 'world', replace: 'there' }]);
    expect(out.body).toBe('hello there');
    expect(out.applied).toEqual([{ find_chars: 5, replace_chars: 5, delta: 0 }]);
    expect(out.beforeLen).toBe(11);
    expect(out.afterLen).toBe(11);
  });

  it('applies edits sequentially', () => {
    const out = applyMarkdownEdits('a-b-c', [
      { find: 'a', replace: 'A' },
      { find: 'b', replace: 'B' },
    ]);
    expect(out.body).toBe('A-B-c');
  });

  it('throws on missing find', () => {
    expect(() => applyMarkdownEdits('hello', [{ find: 'xyz', replace: 'q' }])).toThrow(
      /not found/,
    );
  });

  it('throws on ambiguous find', () => {
    expect(() => applyMarkdownEdits('aaa', [{ find: 'a', replace: 'b' }])).toThrow(
      /unique/,
    );
  });

  it('throws on empty find', () => {
    expect(() => applyMarkdownEdits('hello', [{ find: '', replace: 'q' }])).toThrow(
      /empty `find`/,
    );
  });

  it('throws on empty edits array', () => {
    expect(() => applyMarkdownEdits('hello', [])).toThrow(/non-empty array/);
  });

  it('uses the provided label in error messages', () => {
    expect(() => applyMarkdownEdits('hi', [{ find: 'q', replace: 'x' }], 'edit_plot_field')).toThrow(
      /^edit_plot_field:/,
    );
  });
});
