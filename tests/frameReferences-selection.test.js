import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  selectScoredFrameReferences,
  PER_SOURCE_MAX,
  RELEVANCE_THRESHOLD,
} from '../src/web/frameReferences.js';

// ---- Mocks for autoFillFrameReferencesIfEmpty integration test ----

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

vi.mock('../src/mongo/images.js', () => ({
  listImagesForBeat: vi.fn(),
  imageFileToMeta: (f) => ({
    _id: f._id,
    name: f.metadata?.name || '',
    description: f.metadata?.description || '',
  }),
}));

vi.mock('../src/web/referenceSelector.js', () => ({
  gatherCharacterReferenceCandidates: vi.fn(),
}));

vi.mock('../src/web/gateway.js', () => ({
  setStoryboardFrameReferenceImagesViaGateway: vi.fn(),
}));

const { listImagesForBeat } = await import('../src/mongo/images.js');
const { gatherCharacterReferenceCandidates } = await import('../src/web/referenceSelector.js');
const { setStoryboardFrameReferenceImagesViaGateway: setRefs } = await import('../src/web/gateway.js');
const { autoFillFrameReferencesIfEmpty } = await import('../src/web/frameReferences.js');
const { _setFrameReferenceScorerForTests } = await import('../src/llm/frameReferenceSelector.js');

beforeEach(() => {
  listImagesForBeat.mockReset();
  gatherCharacterReferenceCandidates.mockReset();
  setRefs.mockReset();
  _setFrameReferenceScorerForTests(null);
});

// ---- Pure-function helpers ----

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

// ============================================================================
// autoFillFrameReferencesIfEmpty — model cap integration
// ============================================================================

describe('autoFillFrameReferencesIfEmpty model cap', () => {
  it('clamps auto-fill to the model cap (klein=4)', async () => {
    // Build 6 beat candidates — more than the klein cap of 4.
    const beatDocs = Array.from({ length: 6 }, (_, i) => ({
      _id: `img${i + 1}`,
      metadata: { name: `image ${i + 1}`, description: '' },
    }));
    listImagesForBeat.mockResolvedValueOnce(beatDocs);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);

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
