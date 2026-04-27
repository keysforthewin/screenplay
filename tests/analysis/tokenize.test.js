import { describe, it, expect } from 'vitest';
import { tokenize, tokenizeFiltered, isAllStopwords, STOPWORDS } from '../../src/analysis/tokenize.js';

describe('tokenize', () => {
  it('lowercases and splits on non-letter/digit', () => {
    expect(tokenize('Alice meets Bob.')).toEqual(['alice', 'meets', 'bob']);
  });

  it('handles smart quotes and em dashes by treating them as separators', () => {
    expect(tokenize('“Alice” — said, ‘quietly’.')).toEqual(['alice', 'said', 'quietly']);
  });

  it('strips internal apostrophes (don\'t -> dont)', () => {
    expect(tokenize("don't go")).toEqual(['dont', 'go']);
  });

  it('handles unicode letters', () => {
    expect(tokenize('café niño')).toEqual(['café', 'niño']);
  });

  it('returns empty array for null/undefined/empty', () => {
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('tokenizeFiltered', () => {
  it('drops stopwords and length-1 tokens', () => {
    expect(tokenizeFiltered('She walked into the diner alone')).toEqual([
      'walked',
      'diner',
      'alone',
    ]);
  });

  it('keeps content words when surrounded by stopwords', () => {
    const tokens = tokenizeFiltered('the warrior of the doubt');
    expect(tokens).toEqual(['warrior', 'doubt']);
  });
});

describe('isAllStopwords', () => {
  it('true for an array of only stopwords', () => {
    expect(isAllStopwords(['of', 'the'])).toBe(true);
    expect(isAllStopwords(['and', 'the', 'in'])).toBe(true);
  });

  it('false when any content word is present', () => {
    expect(isAllStopwords(['of', 'wolves'])).toBe(false);
  });

  it('treats empty/null as all-stopwords (no signal)', () => {
    expect(isAllStopwords([])).toBe(true);
    expect(isAllStopwords(null)).toBe(true);
  });
});

describe('STOPWORDS coverage', () => {
  it('includes common English stopwords', () => {
    for (const w of ['the', 'and', 'of', 'to', 'a', 'in', 'is', 'it', 'that']) {
      expect(STOPWORDS.has(w)).toBe(true);
    }
  });
});
