import { describe, it, expect } from 'vitest';
import { scoreSentiment, detectClimax } from '../../src/analysis/sentiment.js';

describe('scoreSentiment', () => {
  it('returns positive comparative for positive text', () => {
    const r = scoreSentiment('joyful wonderful great delightful happy');
    expect(r.comparative).toBeGreaterThan(0);
    expect(r.positive.length).toBeGreaterThan(0);
  });

  it('returns negative comparative for negative text', () => {
    const r = scoreSentiment('terrible horrible awful tragic dreadful');
    expect(r.comparative).toBeLessThan(0);
    expect(r.negative.length).toBeGreaterThan(0);
  });

  it('returns zero for empty/whitespace input', () => {
    expect(scoreSentiment('').comparative).toBe(0);
    expect(scoreSentiment('   ').comparative).toBe(0);
    expect(scoreSentiment(null).comparative).toBe(0);
  });
});

describe('detectClimax', () => {
  function neg(strength) {
    return Array(strength).fill('terrible').join(' ');
  }
  function pos(strength) {
    return Array(strength).fill('wonderful').join(' ');
  }

  it('max_deviation picks the beat farthest from the mean', () => {
    const series = [
      { id: '1', order: 1, text: 'a calm scene' },
      { id: '2', order: 2, text: 'a calm scene' },
      { id: '3', order: 3, text: 'a calm scene' },
      { id: '4', order: 4, text: neg(8) },
      { id: '5', order: 5, text: 'a calm scene' },
    ];
    const r = detectClimax(series, 'max_deviation');
    expect(r.error).toBeUndefined();
    expect(r.climax.id).toBe('4');
    expect(r.climax.normalized_position).toBeCloseTo(0.75, 2);
  });

  it('steepest_drop picks the beat with the largest sentiment fall', () => {
    const series = [
      { id: '1', order: 1, text: pos(4) },
      { id: '2', order: 2, text: pos(4) },
      { id: '3', order: 3, text: pos(4) },
      { id: '4', order: 4, text: neg(6) },
      { id: '5', order: 5, text: 'a quiet ending' },
    ];
    const r = detectClimax(series, 'steepest_drop');
    expect(r.error).toBeUndefined();
    expect(r.climax.id).toBe('4');
    expect(r.climax.deviation_or_drop).toBeLessThan(0);
  });

  it('returns an error when sentiment is flat (variance zero)', () => {
    const series = [
      { id: '1', order: 1, text: 'plain sentence' },
      { id: '2', order: 2, text: 'plain sentence' },
      { id: '3', order: 3, text: 'plain sentence' },
    ];
    const r = detectClimax(series, 'max_deviation');
    expect(r.error).toMatch(/variation/i);
  });

  it('flags in_expected_window correctly', () => {
    const series = [
      { id: '1', order: 1, text: pos(3) },
      { id: '2', order: 2, text: pos(3) },
      { id: '3', order: 3, text: pos(3) },
      { id: '4', order: 4, text: neg(6) },
      { id: '5', order: 5, text: 'a quiet ending' },
    ];
    const r = detectClimax(series, 'max_deviation');
    expect(r.in_expected_window).toBe(true);
  });

  it('flags front-loaded climaxes as outside the window', () => {
    const series = [
      { id: '1', order: 1, text: neg(8) },
      { id: '2', order: 2, text: 'a calm scene' },
      { id: '3', order: 3, text: 'a calm scene' },
      { id: '4', order: 4, text: 'a calm scene' },
      { id: '5', order: 5, text: 'a calm scene' },
    ];
    const r = detectClimax(series, 'max_deviation');
    expect(r.climax.id).toBe('1');
    expect(r.in_expected_window).toBe(false);
  });
});
