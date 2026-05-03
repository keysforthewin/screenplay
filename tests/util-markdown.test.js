import { describe, it, expect } from 'vitest';
import { stripMarkdown } from '../src/util/markdown.js';

describe('stripMarkdown', () => {
  it('returns empty for nullish input', () => {
    expect(stripMarkdown(undefined)).toBe('');
    expect(stripMarkdown(null)).toBe('');
    expect(stripMarkdown('')).toBe('');
  });

  it('removes inline emphasis', () => {
    expect(stripMarkdown('hello **world**')).toBe('hello world');
    expect(stripMarkdown('this is *italic* and **bold**')).toBe('this is italic and bold');
    expect(stripMarkdown('~~struck~~')).toBe('struck');
  });

  it('keeps text inside links and strips the URL', () => {
    expect(stripMarkdown('[Steve](https://example.com)')).toBe('Steve');
  });

  it('keeps alt text for images', () => {
    expect(stripMarkdown('![Alt text](https://example.com/x.png)')).toBe('Alt text');
  });

  it('strips code fences and inline code', () => {
    expect(stripMarkdown('```js\nconst x = 1;\n```')).toBe('');
    expect(stripMarkdown('use `const` here')).toBe('use const here');
  });

  it('strips heading markers and list bullets', () => {
    expect(stripMarkdown('# Title\n- item one\n- item two')).toBe('Title item one item two');
    expect(stripMarkdown('1. first\n2. second')).toBe('first second');
  });

  it('collapses consecutive whitespace', () => {
    expect(stripMarkdown('hello    world\n\nbye')).toBe('hello world bye');
  });
});
