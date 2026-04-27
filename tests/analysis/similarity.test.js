import { describe, it, expect } from 'vitest';
import { bagOfWords, cosineSimilarity, rankSimilar } from '../../src/analysis/similarity.js';

describe('bagOfWords', () => {
  it('counts stopword-filtered tokens', () => {
    const bag = bagOfWords('alice met alice in the diner');
    expect(bag.get('alice')).toBe(2);
    expect(bag.get('diner')).toBe(1);
    expect(bag.has('the')).toBe(false);
    expect(bag.has('in')).toBe(false);
  });

  it('returns empty map for empty/null input', () => {
    expect(bagOfWords('').size).toBe(0);
    expect(bagOfWords(null).size).toBe(0);
    expect(bagOfWords('the and of').size).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical bags', () => {
    const a = bagOfWords('alice met bob in the diner');
    const b = bagOfWords('alice met bob in the diner');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('is 0 for completely disjoint bags', () => {
    const a = bagOfWords('alice met bob');
    const b = bagOfWords('xander fought yvonne');
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('is in (0, 1) for partially overlapping bags', () => {
    const a = bagOfWords('alice fought bob in dark forest');
    const b = bagOfWords('alice walked through forest alone');
    const score = cosineSimilarity(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('returns 0 for empty inputs (no NaN)', () => {
    expect(cosineSimilarity(new Map(), new Map())).toBe(0);
    expect(cosineSimilarity(bagOfWords('alice'), new Map())).toBe(0);
    expect(cosineSimilarity(null, bagOfWords('alice'))).toBe(0);
  });
});

describe('rankSimilar', () => {
  const corpus = [
    {
      id: 'a',
      label: 'Alice',
      fields: {
        background_story: 'A brave warrior who lost her family in a fire',
        arc: 'Learns to forgive',
      },
    },
    {
      id: 'b',
      label: 'Bob',
      fields: {
        background_story: 'A baker who runs a shop in the village',
        arc: 'Builds new oven',
      },
    },
    {
      id: 'c',
      label: 'Carla',
      fields: {
        background_story: 'A brave warrior who lost her family',
        arc: 'Quests for vengeance',
      },
    },
  ];

  it('finds near-duplicates above the threshold', () => {
    const target = bagOfWords('A brave warrior who lost her family in a fire');
    const matches = rankSimilar({ tokens: target }, corpus, { threshold: 0.6 });
    const carla = matches.find((m) => m.id === 'c');
    expect(carla).toBeDefined();
    expect(carla.score).toBeGreaterThan(0.6);
  });

  it('excludes the target by id', () => {
    const target = bagOfWords('A brave warrior who lost her family in a fire');
    const matches = rankSimilar(
      { tokens: target },
      corpus,
      { threshold: 0.5, excludeId: 'a' },
    );
    expect(matches.find((m) => m.id === 'a')).toBeUndefined();
  });

  it('returns empty when no match meets threshold', () => {
    const target = bagOfWords('something completely unrelated about pancakes');
    const matches = rankSimilar({ tokens: target }, corpus, { threshold: 0.6 });
    expect(matches).toEqual([]);
  });

  it('sorts results descending by score', () => {
    const target = bagOfWords('A brave warrior who lost her family');
    const matches = rankSimilar({ tokens: target }, corpus, { threshold: 0.0 });
    for (let i = 0; i < matches.length - 1; i++) {
      expect(matches[i].score).toBeGreaterThanOrEqual(matches[i + 1].score);
    }
  });

  it('reports matched_field with the highest individual cosine', () => {
    const target = bagOfWords('learns forgive forgiveness lesson');
    const matches = rankSimilar({ tokens: target }, corpus, { threshold: 0.0 });
    const alice = matches.find((m) => m.id === 'a');
    expect(alice.matched_field).toBe('arc');
  });

  it('returns empty when target tokens are empty', () => {
    const matches = rankSimilar({ tokens: new Map() }, corpus, { threshold: 0.0 });
    expect(matches).toEqual([]);
  });
});
