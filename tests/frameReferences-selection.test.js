import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  selectScoredFrameReferences,
  PER_SOURCE_MIN,
  RELEVANCE_THRESHOLD,
} from '../src/web/frameReferences.js';

// ---- Mocks for autoFillFrameReferencesIfEmpty integration test ----

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

vi.mock('../src/mongo/plots.js', () => ({ getBeat: vi.fn() }));
vi.mock('../src/mongo/characters.js', () => ({ getCharacter: vi.fn() }));

vi.mock('../src/web/gateway.js', () => ({
  setStoryboardFrameReferenceImagesViaGateway: vi.fn(),
}));

const { getBeat } = await import('../src/mongo/plots.js');
const { getCharacter } = await import('../src/mongo/characters.js');
const { setStoryboardFrameReferenceImagesViaGateway: setRefs } = await import('../src/web/gateway.js');
const { autoFillFrameReferencesIfEmpty } = await import('../src/web/frameReferences.js');
const { _setFrameReferenceScorerForTests } = await import('../src/llm/frameReferenceSelector.js');

beforeEach(() => {
  getBeat.mockReset();
  getCharacter.mockReset();
  setRefs.mockReset();
  _setFrameReferenceScorerForTests(null);
});

// ---- Pure-function helpers ----

function cand(id, source, kind = source === 'beat' ? 'art' : 'char') {
  return { id, source, kind, name: id, description: '' };
}

describe('selectScoredFrameReferences', () => {
  it('keeps the per-source floor plus any extras above threshold', () => {
    const candidates = [
      cand('b1', 'beat'), cand('b2', 'beat'), cand('b3', 'beat'), cand('b4', 'beat'),
    ];
    // b1,b2 are the floor; b3 (0.6) also clears the cutoff; b4 (0.3) does not.
    const scores = new Map([[1, 0.9], [2, 0.8], [3, 0.6], [4, 0.3]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual(['b1', 'b2', 'b3']);
    expect(PER_SOURCE_MIN).toBe(2);
    expect(RELEVANCE_THRESHOLD).toBe(0.5);
  });

  it('keeps the top-2 beat floor even when both are below threshold', () => {
    const candidates = [cand('b1', 'beat'), cand('b2', 'beat'), cand('b3', 'beat')];
    const scores = new Map([[1, 0.2], [2, 0.1], [3, 0.05]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual(['b1', 'b2']); // floor of 2, b3 dropped (below cutoff, beyond floor)
  });

  it('keeps the top-2 floor per character even below threshold', () => {
    const candidates = [cand('s1', 'Steve'), cand('s2', 'Steve'), cand('s3', 'Steve')];
    const scores = new Map([[1, 0.1], [2, 0.05], [3, 0.01]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual(['s1', 's2']); // best 2 of Steve
  });

  it('floors at 2 beat + 2 character for a one-character shot', () => {
    const candidates = [
      cand('b1', 'beat'), cand('b2', 'beat'),
      cand('s1', 'Steve'), cand('s2', 'Steve'),
    ];
    // Everything below threshold — the floor still yields all four.
    const scores = new Map([[1, 0.3], [2, 0.2], [3, 0.1], [4, 0.05]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out.sort()).toEqual(['b1', 'b2', 's1', 's2']);
  });

  it('clamps to maxTotal dropping the lowest-scored floor picks first', () => {
    const candidates = [
      cand('b1', 'beat'), cand('b2', 'beat'),
      cand('s1', 'Steve'),
    ];
    const scores = new Map([[1, 0.9], [2, 0.85], [3, 0.2]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 2 });
    expect(out).toEqual(['b1', 'b2']); // top-2 by score survive the cap
  });
});

// ============================================================================
// autoFillFrameReferencesIfEmpty — model cap integration
// ============================================================================

describe('autoFillFrameReferencesIfEmpty model cap', () => {
  it('clamps auto-fill to the model cap (klein=4)', async () => {
    // Build 6 beat artworks — more than the klein cap of 4.
    const artworks = Array.from({ length: 6 }, (_, i) => ({
      _id: `art${i + 1}`,
      status: 'done',
      result_image_id: `img${i + 1}`,
      name: `image ${i + 1}`,
      prompt: '',
    }));
    getBeat.mockResolvedValueOnce({ _id: 'beat1', artworks });

    // Score all 6 above threshold so they would normally all be picked.
    _setFrameReferenceScorerForTests(async ({ candidates }) => {
      const m = new Map();
      candidates.forEach((_, i) => m.set(i + 1, 0.9));
      return m;
    });

    const frame = { _id: 'f1', reference_ids: [] };
    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [] };
    const ids = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb,
      frame,
      frameText: 'x',
      autoReferences: true,
      imageModel: 'flux-2-klein',
    });

    expect(ids.length).toBeLessThanOrEqual(4);
  });
});
