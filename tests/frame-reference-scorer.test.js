import { describe, it, expect, afterEach } from 'vitest';
import {
  scoreFrameReferences,
  _setFrameReferenceScorerForTests,
} from '../src/llm/frameReferenceSelector.js';

afterEach(() => _setFrameReferenceScorerForTests(null));

const CANDS = [
  { id: 'a', source: 'beat', name: 'Alley', description: 'rainy night alley' },
  { id: 'b', source: 'Steve', name: 'Steve hero', description: 'closeup' },
];

describe('scoreFrameReferences', () => {
  it('returns [] map when no candidates', async () => {
    const m = await scoreFrameReferences({ frameText: 'x', candidates: [] });
    expect(m.size).toBe(0);
  });

  it('returns [] map when frameText is blank', async () => {
    const m = await scoreFrameReferences({ frameText: '   ', candidates: CANDS });
    expect(m.size).toBe(0);
  });

  it('maps 1-based indices to scores via the override', async () => {
    _setFrameReferenceScorerForTests(async ({ candidates }) => {
      const m = new Map();
      candidates.forEach((_, i) => m.set(i + 1, i === 0 ? 0.9 : 0.2));
      return m;
    });
    const m = await scoreFrameReferences({ frameText: 'rainy alley', candidates: CANDS });
    expect(m.get(1)).toBe(0.9);
    expect(m.get(2)).toBe(0.2);
  });
});
