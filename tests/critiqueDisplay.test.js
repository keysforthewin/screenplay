import { describe, it, expect } from 'vitest';
import { pickCritiqueScore, scoreBand, isFlagged, FLAG_THRESHOLD } from '../web/src/widgets/critiqueDisplay.js';

describe('pickCritiqueScore', () => {
  it('prefers the image critique score when present', () => {
    expect(pickCritiqueScore({ image_critique: { overall: 4 }, prompt_critique: { overall: 8 } })).toBe(4);
  });
  it('falls back to the prompt critique score', () => {
    expect(pickCritiqueScore({ image_critique: null, prompt_critique: { overall: 7 } })).toBe(7);
  });
  it('returns null when neither is present', () => {
    expect(pickCritiqueScore({})).toBe(null);
    expect(pickCritiqueScore({ prompt_critique: null })).toBe(null);
  });
});

describe('scoreBand', () => {
  it('maps scores to good/medium/bad bands', () => {
    expect(scoreBand(9)).toBe('good');
    expect(scoreBand(8)).toBe('good');
    expect(scoreBand(6)).toBe('medium');
    expect(scoreBand(5)).toBe('bad');
    expect(scoreBand(1)).toBe('bad');
  });
});

describe('isFlagged', () => {
  it('flags scores below the threshold', () => {
    expect(FLAG_THRESHOLD).toBe(6);
    expect(isFlagged(5)).toBe(true);
    expect(isFlagged(6)).toBe(false);
    expect(isFlagged(null)).toBe(false);
  });
});
