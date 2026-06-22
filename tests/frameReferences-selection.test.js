import { describe, it, expect } from 'vitest';
import {
  selectScoredFrameReferences,
  PER_SOURCE_MAX,
  RELEVANCE_THRESHOLD,
} from '../src/web/frameReferences.js';

function cand(id, source, kind = source === 'beat' ? 'art' : 'char') {
  return { id, source, kind, name: id, description: '' };
}

describe('selectScoredFrameReferences', () => {
  it('keeps at most PER_SOURCE_MAX per source above threshold', () => {
    const candidates = [
      cand('b1', 'beat'), cand('b2', 'beat'), cand('b3', 'beat'),
    ];
    const scores = new Map([[1, 0.9], [2, 0.8], [3, 0.7]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual(['b1', 'b2']); // top 2 of beat
    expect(PER_SOURCE_MAX).toBe(2);
  });

  it('excludes beat artwork below threshold', () => {
    const candidates = [cand('b1', 'beat'), cand('b2', 'beat')];
    const scores = new Map([[1, 0.2], [2, 0.1]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual([]);
    expect(RELEVANCE_THRESHOLD).toBe(0.5);
  });

  it('guarantees one image per character even below threshold', () => {
    const candidates = [cand('s1', 'Steve'), cand('s2', 'Steve')];
    const scores = new Map([[1, 0.1], [2, 0.05]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual(['s1']); // best of Steve, guaranteed
  });

  it('clamps to maxTotal dropping lowest score, keeping character guarantees', () => {
    const candidates = [
      cand('b1', 'beat'), cand('b2', 'beat'),
      cand('s1', 'Steve'),
    ];
    // beat high, Steve low — but Steve is guaranteed and must survive the clamp
    const scores = new Map([[1, 0.9], [2, 0.85], [3, 0.2]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 2 });
    expect(out).toContain('s1');       // guaranteed survives
    expect(out).toContain('b1');       // highest beat survives
    expect(out).not.toContain('b2');   // dropped to fit cap 2
    expect(out.length).toBe(2);
  });
});
