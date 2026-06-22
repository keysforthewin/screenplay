import { describe, it, expect } from 'vitest';
import {
  referenceScoresForIds,
  orderReferenceIdsByScore,
  MAX_ATTACHED_REFERENCE_IMAGES,
} from '../src/web/frameReferences.js';

describe('referenceScoresForIds', () => {
  const candidates = [
    { id: 'a', kind: 'art', source: 'beat' },
    { id: 'b', kind: 'char', source: 'Steve' },
    { id: 'c', kind: 'char', source: 'Mara' },
  ];

  it('maps each selected id to its 1-based score', () => {
    const scores = new Map([[1, 0.9], [2, 0.4], [3, 0.7]]);
    const out = referenceScoresForIds({ candidates, scores, ids: ['a', 'c'] });
    expect(out).toEqual({ a: 0.9, c: 0.7 });
  });

  it('omits ids that have no finite score', () => {
    const scores = new Map([[1, 0.9]]); // only candidate a scored
    const out = referenceScoresForIds({ candidates, scores, ids: ['a', 'b'] });
    expect(out).toEqual({ a: 0.9 });
  });

  it('keeps the max score when an id appears in multiple sources', () => {
    const dup = [
      { id: 'x', kind: 'art', source: 'beat' },
      { id: 'x', kind: 'char', source: 'Steve' },
    ];
    const scores = new Map([[1, 0.3], [2, 0.8]]);
    const out = referenceScoresForIds({ candidates: dup, scores, ids: ['x'] });
    expect(out).toEqual({ x: 0.8 });
  });
});

describe('orderReferenceIdsByScore', () => {
  it('orders ids by score descending', () => {
    const out = orderReferenceIdsByScore({
      referenceIds: ['a', 'b', 'c'],
      referenceScores: { a: 0.2, b: 0.9, c: 0.5 },
    });
    expect(out).toEqual(['b', 'c', 'a']);
  });

  it('sorts unscored ids after all scored ids, preserving their order', () => {
    const out = orderReferenceIdsByScore({
      referenceIds: ['a', 'b', 'c', 'd'],
      referenceScores: { b: 0.9, d: 0.3 },
    });
    // scored first (b=0.9, d=0.3), then unscored in original order (a, c)
    expect(out).toEqual(['b', 'd', 'a', 'c']);
  });

  it('is stable for equal scores (preserves original order)', () => {
    const out = orderReferenceIdsByScore({
      referenceIds: ['a', 'b', 'c'],
      referenceScores: { a: 0.5, b: 0.5, c: 0.5 },
    });
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('caps to maxTotal, dropping the lowest-scored', () => {
    const out = orderReferenceIdsByScore({
      referenceIds: ['a', 'b', 'c', 'd'],
      referenceScores: { a: 0.2, b: 0.9, c: 0.5, d: 0.1 },
      maxTotal: 2,
    });
    expect(out).toEqual(['b', 'c']);
  });

  it('returns all ids when maxTotal is not finite', () => {
    const out = orderReferenceIdsByScore({
      referenceIds: ['a', 'b'],
      referenceScores: { a: 0.1, b: 0.2 },
      maxTotal: Infinity,
    });
    expect(out).toEqual(['b', 'a']);
  });

  it('exposes a max-attached constant of 8', () => {
    expect(MAX_ATTACHED_REFERENCE_IMAGES).toBe(8);
  });
});
