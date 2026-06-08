import { describe, it, expect } from 'vitest';
import { CRITIQUE_LENSES, aggregateCritique, clampScore } from '../src/web/storyboardCritique.js';

describe('CRITIQUE_LENSES', () => {
  it('defines the four lenses with key + instruction', () => {
    const keys = CRITIQUE_LENSES.map((l) => l.key);
    expect(keys).toEqual(['bible', 'director_notes', 'cinematic', 'continuity']);
    for (const l of CRITIQUE_LENSES) expect(l.instruction.length).toBeGreaterThan(0);
  });
});

describe('clampScore', () => {
  it('coerces to an integer in 1..10', () => {
    expect(clampScore(0)).toBe(1);
    expect(clampScore(11)).toBe(10);
    expect(clampScore(7.4)).toBe(7);
    expect(clampScore('nope')).toBe(1);
  });
});

describe('aggregateCritique', () => {
  it('overall is the rounded mean when no lens is critical', () => {
    const r = aggregateCritique([
      { lens: 'bible', score: 8, comments: '' },
      { lens: 'director_notes', score: 7, comments: '' },
      { lens: 'cinematic', score: 9, comments: '' },
      { lens: 'continuity', score: 8, comments: '' },
    ]);
    expect(r.overall).toBe(8);
    expect(r.lowest_lens).toBe('director_notes');
  });

  it('caps overall at a critical lens score (<= 3)', () => {
    const r = aggregateCritique([
      { lens: 'bible', score: 9, comments: '' },
      { lens: 'director_notes', score: 9, comments: '' },
      { lens: 'cinematic', score: 2, comments: 'breaks the look' },
      { lens: 'continuity', score: 9, comments: '' },
    ]);
    expect(r.overall).toBe(2);
    expect(r.lowest_lens).toBe('cinematic');
  });

  it('caps at the LOWEST critical lens when several are critical', () => {
    const r = aggregateCritique([
      { lens: 'bible', score: 3, comments: '' },
      { lens: 'director_notes', score: 1, comments: '' },
      { lens: 'cinematic', score: 8, comments: '' },
      { lens: 'continuity', score: 8, comments: '' },
    ]);
    expect(r.overall).toBe(1);
    expect(r.lowest_lens).toBe('director_notes');
  });

  it('returns overall 1 + null lowest for an empty lens list', () => {
    const r = aggregateCritique([]);
    expect(r.overall).toBe(1);
    expect(r.lowest_lens).toBe(null);
  });
});
