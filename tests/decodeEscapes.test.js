import { describe, it, expect } from 'vitest';
import { decodeEscapes, decodeEscapesInString } from '../src/agent/decodeEscapes.js';

describe('decodeEscapesInString', () => {
  it('decodes \\uXXXX into the matching code point', () => {
    expect(decodeEscapesInString('Hello \\u2014 world')).toBe('Hello — world');
    expect(decodeEscapesInString('\\u201Cquoted\\u201D')).toBe('“quoted”');
  });

  it('decodes \\u{...} braced escapes including astral planes', () => {
    expect(decodeEscapesInString('\\u{1F600}')).toBe('😀');
  });

  it('decodes \\xNN', () => {
    expect(decodeEscapesInString('caf\\xE9')).toBe('café');
  });

  it('decodes named escapes', () => {
    expect(decodeEscapesInString('a\\nb\\tc')).toBe('a\nb\tc');
    expect(decodeEscapesInString('back\\\\slash')).toBe('back\\slash');
  });

  it('leaves backslashes followed by non-escape chars alone', () => {
    expect(decodeEscapesInString('\\q stays')).toBe('\\q stays');
    expect(decodeEscapesInString('regex \\d+ pattern')).toBe('regex \\d+ pattern');
    expect(decodeEscapesInString('\\u20')).toBe('\\u20'); // truncated, not 4 hex digits
  });

  it('is a no-op when there is no backslash', () => {
    const s = 'plain text — already correct';
    expect(decodeEscapesInString(s)).toBe(s);
  });

  it('passes non-strings through', () => {
    expect(decodeEscapesInString(42)).toBe(42);
    expect(decodeEscapesInString(null)).toBe(null);
    expect(decodeEscapesInString(undefined)).toBe(undefined);
  });
});

describe('decodeEscapes (deep)', () => {
  it('walks objects and arrays', () => {
    const input = {
      name: 'Alice \\u2014 protagonist',
      tags: ['hero\\u2014lead', 'mentor'],
      nested: { body: '\\u201CHi\\u201D' },
      n: 1,
      flag: true,
      missing: null,
    };
    expect(decodeEscapes(input)).toEqual({
      name: 'Alice — protagonist',
      tags: ['hero—lead', 'mentor'],
      nested: { body: '“Hi”' },
      n: 1,
      flag: true,
      missing: null,
    });
  });

  it('returns the same value for primitives and null', () => {
    expect(decodeEscapes(null)).toBe(null);
    expect(decodeEscapes(undefined)).toBe(undefined);
    expect(decodeEscapes(0)).toBe(0);
    expect(decodeEscapes(false)).toBe(false);
  });
});
