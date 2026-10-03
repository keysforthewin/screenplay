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

describe('writing critique v2 helpers', async () => {
  const { formatScore, sortIssues, issueCounts, hasCriteria, coverageBand } = await import('../web/src/widgets/critiqueDisplay.js');
  it('formatScore keeps integers and shows one decimal otherwise', () => {
    expect(formatScore(8)).toBe('8');
    expect(formatScore(7.25)).toBe('7.3');
    expect(formatScore(null)).toBe('—');
  });
  it('sortIssues orders must_fix → should_fix → nit and keeps unknowns last', () => {
    const out = sortIssues([{ severity: 'nit' }, { severity: 'weird' }, { severity: 'must_fix' }, { severity: 'should_fix' }]);
    expect(out.map((i) => i.severity)).toEqual(['must_fix', 'should_fix', 'nit', 'weird']);
  });
  it('issueCounts ignores unfinished facets', () => {
    expect(issueCounts([
      { status: 'done', issues: [{ severity: 'must_fix' }, { severity: 'nit' }] },
      { status: 'error', issues: [{ severity: 'must_fix' }] },
      { status: 'done', issues: [{ severity: 'should_fix' }] },
    ])).toEqual({ must_fix: 1, should_fix: 1, nit: 1 });
  });
  it('hasCriteria and coverageBand', () => {
    expect(hasCriteria({ criteria: [{ key: 'x' }] })).toBe(true);
    expect(hasCriteria({ criteria: [] })).toBe(false);
    expect(hasCriteria({})).toBe(false);
    expect(coverageBand(85)).toBe('good');
    expect(coverageBand(50)).toBe('medium');
    expect(coverageBand(10)).toBe('bad');
    expect(coverageBand(null)).toBeNull();
  });
});
