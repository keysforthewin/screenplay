import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

// buildFrameReferenceCandidates pools each scene character's and each scene
// set's "Artwork" section (done artworks only). The retired beat source is
// gone — beat artwork migrated onto sets. Mock the entity loaders that supply
// those artwork arrays.
const getBeat = vi.fn();
vi.mock('../src/mongo/plots.js', () => ({ getBeat }));

const getCharacter = vi.fn();
vi.mock('../src/mongo/characters.js', () => ({ getCharacter }));

const getSet = vi.fn();
vi.mock('../src/mongo/sets.js', () => ({ getSet }));

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

// Minimal "done" artwork doc — what lives in set.artworks[] / character.artworks[].
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
  getSet.mockReset();
  scoreFrameReferences.mockReset();
  setRefs.mockReset();
});

// ============================================================================
// buildFrameReferenceCandidates
// ============================================================================

describe('buildFrameReferenceCandidates', () => {
  it('pools set artwork and each character artwork, tagging source and kind', async () => {
    const setArt1 = new ObjectId();
    const setArt2 = new ObjectId();
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Diner',
      artworks: [
        artwork(setArt1, 'Rainy alley', 'neon reflections'),
        artwork(setArt2, 'Diner interior', ''),
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

    const sb = {
      _id: 'sb1',
      beat_id: 'beat1',
      characters_in_scene: ['Steve'],
      sets_in_scene: ['Diner'],
    };
    const cands = await buildFrameReferenceCandidates({
      projectId: 'p',
      sb,
      frameText: 'rainy alley closeup',
    });

    const sources = new Set(cands.map((c) => c.source));
    expect(sources.has('set:Diner')).toBe(true);
    expect(sources.has('Steve')).toBe(true);

    const setCands = cands.filter((c) => c.source === 'set:Diner');
    expect(setCands.length).toBe(2);
    expect(setCands.every((c) => c.kind === 'set')).toBe(true);
    expect(setCands.map((c) => c.id)).toContain(String(setArt1));
    expect(setCands.map((c) => c.id)).toContain(String(setArt2));

    const charCands = cands.filter((c) => c.source === 'Steve');
    expect(charCands.length).toBe(2);
    expect(charCands.every((c) => c.kind === 'char')).toBe(true);
    expect(charCands.map((c) => c.id)).toContain(String(charArt1));
    expect(charCands.map((c) => c.id)).toContain(String(charArt2));
  });

  it('ignores beat artwork entirely — the beat source is retired', async () => {
    getBeat.mockResolvedValue({
      _id: 'beat1',
      artworks: [artwork(new ObjectId(), 'Legacy beat art', 'should not appear')],
      sets: [],
    });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [], sets_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    expect(cands).toEqual([]);
  });

  it('falls back to beat.sets when the row has no sets_in_scene', async () => {
    const setArt = new ObjectId();
    getBeat.mockResolvedValueOnce({ _id: 'beat1', artworks: [], sets: ['Kitchen'] });
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Kitchen',
      artworks: [artwork(setArt, 'Kitchen wide', 'greasy diner kitchen')],
    });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });

    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({
      id: String(setArt),
      kind: 'set',
      source: 'set:Kitchen',
      name: 'Kitchen wide',
      description: 'greasy diner kitchen',
    });
  });

  it('set source names are prefixed so a set cannot merge with a same-named character', async () => {
    const charArt = new ObjectId();
    const setArt = new ObjectId();
    getCharacter.mockResolvedValueOnce({
      _id: 'c1',
      name: 'Kitchen',
      artworks: [artwork(charArt, 'portrait', '')],
    });
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Kitchen',
      artworks: [artwork(setArt, 'plate', '')],
    });

    const sb = {
      _id: 'sb1',
      beat_id: 'beat1',
      characters_in_scene: ['Kitchen'],
      sets_in_scene: ['Kitchen'],
    };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    const sources = new Set(cands.map((c) => c.source));
    expect(sources).toEqual(new Set(['Kitchen', 'set:Kitchen']));
  });

  it('each character becomes its own source tag, stripped of markdown', async () => {
    const img = new ObjectId();
    getCharacter.mockResolvedValueOnce({
      _id: 'c1',
      name: '**Steve**',
      artworks: [artwork(img, 'portrait', '')],
    });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['**Steve**'], sets_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });

    expect(cands).toHaveLength(1);
    expect(cands[0].source).toBe('Steve');
    expect(cands[0].kind).toBe('char');
  });

  it('excludes non-done artworks and artworks without a result image', async () => {
    const doneId = new ObjectId();
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Diner',
      artworks: [
        artwork(doneId, 'Done one', 'kept'),
        artwork(new ObjectId(), 'Pending', 'x', { status: 'pending' }),
        artwork(new ObjectId(), 'Errored', 'x', { status: 'error' }),
        { _id: new ObjectId(), status: 'done', result_image_id: null, name: 'No image' },
      ],
    });
    getCharacter.mockResolvedValueOnce({ _id: 'c1', name: 'Steve', artworks: [] });

    const sb = {
      _id: 'sb1',
      beat_id: 'beat1',
      characters_in_scene: ['Steve'],
      sets_in_scene: ['Diner'],
    };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });

    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe(String(doneId));
  });

  it('continues when a character lookup throws, returning set artwork', async () => {
    const setArt = new ObjectId();
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Alley',
      artworks: [artwork(setArt, 'Alley', 'rain')],
    });
    getCharacter.mockRejectedValueOnce(new Error('lookup failed'));

    const sb = {
      _id: 'sb1',
      beat_id: 'beat1',
      characters_in_scene: ['Steve'],
      sets_in_scene: ['Alley'],
    };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });

    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ id: String(setArt), kind: 'set', source: 'set:Alley' });
  });

  it('continues when a set lookup throws, returning character artwork', async () => {
    const charArt = new ObjectId();
    getSet.mockRejectedValueOnce(new Error('lookup failed'));
    getCharacter.mockResolvedValueOnce({
      _id: 'c1',
      name: 'Steve',
      artworks: [artwork(charArt, 'portrait', '')],
    });

    const sb = {
      _id: 'sb1',
      beat_id: 'beat1',
      characters_in_scene: ['Steve'],
      sets_in_scene: ['Ghost Set'],
    };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });
    expect(cands).toHaveLength(1);
    expect(cands[0].source).toBe('Steve');
  });

  it('deduplicates artworks that share a result_image_id within a source', async () => {
    const id = new ObjectId();
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Alley',
      artworks: [artwork(id, 'Alley', 'rain'), artwork(id, 'Alley copy', 'rain')],
    });

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [], sets_in_scene: ['Alley'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe(String(id));
  });

  it('skips characters and sets with no resolvable doc', async () => {
    getCharacter.mockResolvedValueOnce(null);
    getSet.mockResolvedValueOnce(null);

    const sb = {
      _id: 'sb1',
      beat_id: 'beat1',
      characters_in_scene: ['Ghost'],
      sets_in_scene: ['Nowhere'],
    };
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
    const setArt = new ObjectId();
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Alley',
      artworks: [artwork(setArt, 'Neon alley', 'rain')],
    });
    scoreFrameReferences.mockResolvedValueOnce(new Map([[1, 0.9]]));

    const frame = { _id: 'f1', reference_ids: [] };
    const sb = { _id: 's1', beat_id: 'beat1', characters_in_scene: [], sets_in_scene: ['Alley'] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb,
      frame,
      frameText: 'alley',
      autoReferences: true,
    });

    expect(out).toEqual([String(setArt)]);
    expect(setRefs).toHaveBeenCalledWith({
      projectId: 'p',
      storyboardId: 's1',
      frameId: 'f1',
      imageIds: [String(setArt)],
      mode: 'replace',
      scores: { [String(setArt)]: 0.9 },
    });
    expect(frame.reference_ids).toEqual([String(setArt)]);
    expect(scoreFrameReferences).toHaveBeenCalledOnce();
    expect(scoreFrameReferences.mock.calls[0][0].frameText).toBe('alley');
  });

  it('does not persist when there are no candidates', async () => {
    getBeat.mockResolvedValueOnce({ _id: 'beat1', artworks: [], sets: [] });

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
    const setArt = new ObjectId();
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Alley',
      artworks: [artwork(setArt, 'Neon alley', 'rain')],
    });
    scoreFrameReferences.mockResolvedValueOnce(new Map());

    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1', beat_id: 'beat1', characters_in_scene: [], sets_in_scene: ['Alley'] },
      frame,
      frameText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([String(setArt)]);
    expect(setRefs).toHaveBeenCalled();
    expect(frame.reference_ids).toEqual([String(setArt)]);
  });

  it('swallows gateway errors and returns []', async () => {
    const setArt = new ObjectId();
    getSet.mockResolvedValueOnce({
      _id: 's1',
      name: 'Alley',
      artworks: [artwork(setArt, 'Neon alley', 'rain')],
    });
    scoreFrameReferences.mockResolvedValueOnce(new Map([[1, 0.9]]));
    setRefs.mockRejectedValueOnce(new Error('gateway down'));

    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1', beat_id: 'beat1', characters_in_scene: [], sets_in_scene: ['Alley'] },
      frame,
      frameText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([]);
    expect(frame.reference_ids).toEqual([]);
  });
});
