import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

// buildFrameReferenceCandidates now pools the beat's and each scene character's
// "Artwork" section (done artworks only) — NOT every GridFS image owned by the
// beat. Mock the entity loaders that supply those artwork arrays.
const getBeat = vi.fn();
vi.mock('../src/mongo/plots.js', () => ({ getBeat }));

const getCharacter = vi.fn();
vi.mock('../src/mongo/characters.js', () => ({ getCharacter }));

const scoreFrameReferences = vi.fn();
vi.mock('../src/llm/frameReferenceSelector.js', () => ({
  scoreFrameReferences,
  _setFrameReferenceScorerForTests: () => {},
}));

// Mock imageModelInfo so tests don't depend on fal/imageCaps.js being present.
vi.mock('../src/web/imageModelInfo.js', () => ({
  maxReferenceImagesFor: () => 6,
}));

const setRefs = vi.fn();
vi.mock('../src/web/gateway.js', () => ({
  setStoryboardFrameReferenceImagesViaGateway: setRefs,
}));

const { buildFrameReferenceCandidates, autoFillFrameReferencesIfEmpty } =
  await import('../src/web/frameReferences.js');

// ---- Fixture helpers -------------------------------------------------------

// Minimal "done" artwork doc — what lives in beat.artworks[] / character.artworks[].
function artwork(resultImageId, name = '', prompt = '', overrides = {}) {
  return {
    _id: new ObjectId(),
    status: 'done',
    result_image_id: resultImageId,
    name,
    prompt,
    ...overrides,
  };
}

beforeEach(() => {
  getBeat.mockReset();
  getCharacter.mockReset();
  scoreFrameReferences.mockReset();
  setRefs.mockReset();
});

// ============================================================================
// buildFrameReferenceCandidates
// ============================================================================

describe('buildFrameReferenceCandidates', () => {
  it('pools beat artwork and each character artwork, tagging source and kind', async () => {
    const beatArt1 = new ObjectId();
    const beatArt2 = new ObjectId();
    getBeat.mockResolvedValueOnce({
      _id: 'beat1',
      artworks: [
        artwork(beatArt1, 'Rainy alley', 'neon reflections'),
        artwork(beatArt2, 'Diner interior', ''),
      ],
    });

    const charArt1 = new ObjectId();
    const charArt2 = new ObjectId();
    getCharacter.mockResolvedValueOnce({
      _id: 'c1',
      name: 'Steve',
      artworks: [
        artwork(charArt1, 'Steve portrait', 'young'),
        artwork(charArt2, 'Steve action', 'coat'),
      ],
    });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Steve'] };
    const cands = await buildFrameReferenceCandidates({
      projectId: 'p',
      sb,
      frameText: 'rainy alley closeup',
    });

    const sources = new Set(cands.map((c) => c.source));
    expect(sources.has('beat')).toBe(true);
    expect(sources.has('Steve')).toBe(true);

    const beatCands = cands.filter((c) => c.source === 'beat');
    expect(beatCands.length).toBe(2);
    expect(beatCands.every((c) => c.kind === 'art')).toBe(true);
    expect(beatCands.map((c) => c.id)).toContain(String(beatArt1));
    expect(beatCands.map((c) => c.id)).toContain(String(beatArt2));

    const charCands = cands.filter((c) => c.source === 'Steve');
    expect(charCands.length).toBe(2);
    expect(charCands.every((c) => c.kind === 'char')).toBe(true);
    expect(charCands.map((c) => c.id)).toContain(String(charArt1));
    expect(charCands.map((c) => c.id)).toContain(String(charArt2));
  });

  it('beat artwork uses name and prompt (as description) from the artwork doc', async () => {
    const id = new ObjectId();
    getBeat.mockResolvedValueOnce({
      _id: 'beat1',
      artworks: [artwork(id, 'Lighthouse', 'cliff scene at dusk')],
    });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });

    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({
      id: String(id),
      kind: 'art',
      source: 'beat',
      name: 'Lighthouse',
      description: 'cliff scene at dusk',
    });
  });

  it('each character becomes its own source tag, stripped of markdown', async () => {
    const img = new ObjectId();
    getBeat.mockResolvedValueOnce({ _id: 'beat1', artworks: [] });
    getCharacter.mockResolvedValueOnce({
      _id: 'c1',
      name: '**Steve**',
      artworks: [artwork(img, 'portrait', '')],
    });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['**Steve**'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });

    expect(cands).toHaveLength(1);
    expect(cands[0].source).toBe('Steve');
    expect(cands[0].kind).toBe('char');
  });

  it('excludes non-done artworks and artworks without a result image', async () => {
    const doneId = new ObjectId();
    getBeat.mockResolvedValueOnce({
      _id: 'beat1',
      artworks: [
        artwork(doneId, 'Done one', 'kept'),
        artwork(new ObjectId(), 'Pending', 'x', { status: 'pending' }),
        artwork(new ObjectId(), 'Errored', 'x', { status: 'error' }),
        { _id: new ObjectId(), status: 'done', result_image_id: null, name: 'No image' },
      ],
    });
    getCharacter.mockResolvedValueOnce({ _id: 'c1', name: 'Steve', artworks: [] });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Steve'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });

    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe(String(doneId));
  });

  it('does NOT include the beat\'s plain reference images, only artwork', async () => {
    // A beat may own dozens of GridFS images (storyboard frames, uploaded
    // references) but no artworks — auto-suggest must surface none of them.
    getBeat.mockResolvedValueOnce({ _id: 'beat1', artworks: [] });
    getCharacter.mockResolvedValueOnce({ _id: 'c1', name: 'Steve', artworks: [] });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Steve'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });
    expect(cands).toEqual([]);
  });

  it('returns [] when getBeat throws (never propagates)', async () => {
    getBeat.mockRejectedValueOnce(new Error('mongo down'));
    getCharacter.mockResolvedValueOnce({ _id: 'c1', name: 'Steve', artworks: [] });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Steve'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });
    expect(cands).toEqual([]);
  });

  it('continues when a character lookup throws, returning beat artwork', async () => {
    const beatArt = new ObjectId();
    getBeat.mockResolvedValueOnce({
      _id: 'beat1',
      artworks: [artwork(beatArt, 'Alley', 'rain')],
    });
    getCharacter.mockRejectedValueOnce(new Error('lookup failed'));

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Steve'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });

    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ id: String(beatArt), kind: 'art', source: 'beat' });
  });

  it('deduplicates artworks that share a result_image_id within a source', async () => {
    const id = new ObjectId();
    getBeat.mockResolvedValueOnce({
      _id: 'beat1',
      artworks: [artwork(id, 'Alley', 'rain'), artwork(id, 'Alley copy', 'rain')],
    });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe(String(id));
  });

  it('returns [] when beat_id is absent', async () => {
    const sb = { _id: 'sb1', characters_in_scene: [] }; // no beat_id
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    expect(cands).toEqual([]);
    expect(getBeat).not.toHaveBeenCalled();
  });

  it('skips characters with no resolvable doc', async () => {
    getBeat.mockResolvedValueOnce({ _id: 'beat1', artworks: [] });
    getCharacter.mockResolvedValueOnce(null);

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Ghost'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    expect(cands).toEqual([]);
  });
});

// ============================================================================
// autoFillFrameReferencesIfEmpty
// ============================================================================

describe('autoFillFrameReferencesIfEmpty', () => {
  it('does nothing when autoReferences is false', async () => {
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1' },
      frame,
      frameText: 'x',
      autoReferences: false,
    });
    expect(out).toEqual([]);
    expect(scoreFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('skips frames that already have references', async () => {
    const frame = { _id: 'f1', reference_ids: ['existing'] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1' },
      frame,
      frameText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([]);
    expect(scoreFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
    expect(frame.reference_ids).toEqual(['existing']);
  });

  it('persists scored picks via the gateway and mutates the frame', async () => {
    const beatArt = new ObjectId();
    getBeat.mockResolvedValueOnce({
      _id: 'beat1',
      artworks: [artwork(beatArt, 'Neon alley', 'rain')],
    });
    scoreFrameReferences.mockResolvedValueOnce(new Map([[1, 0.9]]));

    const frame = { _id: 'f1', reference_ids: [] };
    const sb = { _id: 's1', beat_id: 'beat1', characters_in_scene: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb,
      frame,
      frameText: 'alley',
      autoReferences: true,
    });

    expect(out).toEqual([String(beatArt)]);
    expect(setRefs).toHaveBeenCalledWith({
      projectId: 'p',
      storyboardId: 's1',
      frameId: 'f1',
      imageIds: [String(beatArt)],
      mode: 'replace',
      scores: { [String(beatArt)]: 0.9 },
    });
    expect(frame.reference_ids).toEqual([String(beatArt)]);
    expect(scoreFrameReferences).toHaveBeenCalledOnce();
    expect(scoreFrameReferences.mock.calls[0][0].frameText).toBe('alley');
  });

  it('does not persist when there are no candidates', async () => {
    getBeat.mockResolvedValueOnce({ _id: 'beat1', artworks: [] });

    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1', beat_id: 'beat1', characters_in_scene: [] },
      frame,
      frameText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([]);
    expect(scoreFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('falls back to first-per-source when scorer returns empty scores', async () => {
    const beatArt = new ObjectId();
    getBeat.mockResolvedValueOnce({
      _id: 'beat1',
      artworks: [artwork(beatArt, 'Neon alley', 'rain')],
    });
    scoreFrameReferences.mockResolvedValueOnce(new Map());

    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1', beat_id: 'beat1', characters_in_scene: [] },
      frame,
      frameText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([String(beatArt)]);
    expect(setRefs).toHaveBeenCalled();
    expect(frame.reference_ids).toEqual([String(beatArt)]);
  });

  it('swallows gateway errors and returns []', async () => {
    const beatArt = new ObjectId();
    getBeat.mockResolvedValueOnce({
      _id: 'beat1',
      artworks: [artwork(beatArt, 'Neon alley', 'rain')],
    });
    scoreFrameReferences.mockResolvedValueOnce(new Map([[1, 0.9]]));
    setRefs.mockRejectedValueOnce(new Error('gateway down'));

    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1', beat_id: 'beat1', characters_in_scene: [] },
      frame,
      frameText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([]);
    expect(frame.reference_ids).toEqual([]);
  });
});
