import { describe, it, expect } from 'vitest';
import { ngrams, countNgrams, topNgrams } from '../../src/analysis/ngrams.js';

describe('ngrams', () => {
  it('returns sliding-window n-grams', () => {
    expect(ngrams(['a', 'b', 'c', 'd'], 2)).toEqual(['a b', 'b c', 'c d']);
    expect(ngrams(['a', 'b', 'c', 'd'], 3)).toEqual(['a b c', 'b c d']);
  });

  it('returns empty array when tokens shorter than n', () => {
    expect(ngrams(['a'], 2)).toEqual([]);
    expect(ngrams([], 2)).toEqual([]);
    expect(ngrams(['a', 'b'], 5)).toEqual([]);
  });
});

describe('countNgrams', () => {
  it('counts a 3-gram appearing across multiple docs', () => {
    const docs = [
      { id: '1', label: '#1 A', text: 'she said quietly to him' },
      { id: '2', label: '#2 B', text: 'and then she said quietly again' },
      { id: '3', label: '#3 C', text: 'she said quietly while turning' },
    ];
    const counts = countNgrams(docs, [3], { minCount: 2 });
    const sheSaidQuietly = counts.find((c) => c.gram === 'she said quietly');
    expect(sheSaidQuietly).toBeDefined();
    expect(sheSaidQuietly.count).toBe(3);
    expect(sheSaidQuietly.n).toBe(3);
    expect(sheSaidQuietly.sources.map((s) => s.id).sort()).toEqual(['1', '2', '3']);
  });

  it('filters out all-stopword n-grams', () => {
    const docs = [
      { id: '1', label: '#1', text: 'of the of the of the' },
      { id: '2', label: '#2', text: 'and the and the and the' },
    ];
    const counts = countNgrams(docs, [2], { minCount: 2 });
    expect(counts.find((c) => c.gram === 'of the')).toBeUndefined();
    expect(counts.find((c) => c.gram === 'and the')).toBeUndefined();
  });

  it('respects min_count threshold', () => {
    const docs = [
      { id: '1', label: '#1', text: 'unique phrase one' },
      { id: '2', label: '#2', text: 'unique phrase two' },
    ];
    const counts3 = countNgrams(docs, [2], { minCount: 3 });
    expect(counts3.find((c) => c.gram === 'unique phrase')).toBeUndefined();
    const counts2 = countNgrams(docs, [2], { minCount: 2 });
    expect(counts2.find((c) => c.gram === 'unique phrase')).toBeDefined();
  });

  it('does not double-add sources for repeated grams in the same doc', () => {
    const docs = [
      { id: '1', label: '#1', text: 'twin phrase twin phrase twin phrase' },
      { id: '2', label: '#2', text: 'twin phrase elsewhere' },
    ];
    const counts = countNgrams(docs, [2], { minCount: 2 });
    const tp = counts.find((c) => c.gram === 'twin phrase');
    expect(tp.count).toBe(4);
    expect(tp.sources).toHaveLength(2);
    expect(tp.sources.map((s) => s.id).sort()).toEqual(['1', '2']);
  });

  it('sorts results by count desc', () => {
    const docs = [
      { id: '1', label: '#1', text: 'common phrase common phrase' },
      { id: '2', label: '#2', text: 'common phrase rare bigram' },
      { id: '3', label: '#3', text: 'rare bigram alone' },
    ];
    const counts = countNgrams(docs, [2], { minCount: 2 });
    expect(counts[0].gram).toBe('common phrase');
    expect(counts[0].count).toBeGreaterThan(counts[1]?.count || 0);
  });
});

describe('topNgrams', () => {
  it('caps to k', () => {
    const fake = Array.from({ length: 50 }, (_, i) => ({
      gram: `g${i}`,
      n: 2,
      count: 50 - i,
      sources: [],
    }));
    expect(topNgrams(fake, 5)).toHaveLength(5);
    expect(topNgrams(fake, 5)[0].gram).toBe('g0');
  });

  it('handles empty input', () => {
    expect(topNgrams([], 10)).toEqual([]);
    expect(topNgrams(null, 10)).toEqual([]);
  });
});
