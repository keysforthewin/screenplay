import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

// Mock images.js: expose listImagesForBeat and imageFileToMeta used by
// the new buildFrameReferenceCandidates.
const listImagesForBeat = vi.fn();
vi.mock('../src/mongo/images.js', () => ({
  listImagesForBeat,
  // Pure mapper — mirrors the real implementation's field extraction.
  imageFileToMeta: (f) => ({
    _id: f._id,
    name: f.metadata?.name || '',
    description: f.metadata?.description || '',
  }),
}));

// Mock referenceSelector: gatherCharacterReferenceCandidates is the new
// helper used to gather each scene character's full image set.
const gatherCharacterReferenceCandidates = vi.fn();
vi.mock('../src/web/referenceSelector.js', () => ({
  gatherCharacterReferenceCandidates,
}));

const selectFrameReferences = vi.fn();
vi.mock('../src/llm/frameReferenceSelector.js', () => ({ selectFrameReferences }));

const setRefs = vi.fn();
vi.mock('../src/web/gateway.js', () => ({
  setStoryboardFrameReferenceImagesViaGateway: setRefs,
}));

const { buildFrameReferenceCandidates, autoFillFrameReferencesIfEmpty, AUTO_REFERENCE_MAX } =
  await import('../src/web/frameReferences.js');

// ---- Fixture helpers -------------------------------------------------------

// Minimal GridFS-shaped beat image doc.
function beatDoc(id, name, description) {
  return {
    _id: id,
    filename: `${id}.png`,
    contentType: 'image/png',
    length: 1,
    uploadDate: new Date(),
    metadata: { name, description, owner_type: 'beat' },
  };
}

beforeEach(() => {
  listImagesForBeat.mockReset();
  gatherCharacterReferenceCandidates.mockReset();
  selectFrameReferences.mockReset();
  setRefs.mockReset();
});

// ============================================================================
// buildFrameReferenceCandidates
// ============================================================================

describe('buildFrameReferenceCandidates', () => {
  it('pools beat artwork and each character full set, tagging source and kind', async () => {
    // Two beat images — both should appear with source 'beat' / kind 'art'.
    const beatImg1 = new ObjectId();
    const beatImg2 = new ObjectId();
    listImagesForBeat.mockResolvedValueOnce([
      beatDoc(beatImg1, 'Rainy alley', 'neon reflections'),
      beatDoc(beatImg2, 'Diner interior', ''),
    ]);

    // Steve has two character image candidates.
    const charImg1 = new ObjectId();
    const charImg2 = new ObjectId();
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([
      {
        name: 'Steve',
        candidates: [
          { id: String(charImg1), name: 'Steve portrait', description: 'young', caption: '' },
          { id: String(charImg2), name: 'Steve action', description: 'coat', caption: '' },
        ],
      },
    ]);

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Steve'] };
    const cands = await buildFrameReferenceCandidates({
      projectId: 'p',
      sb,
      frameText: 'rainy alley closeup',
    });

    const sources = new Set(cands.map((c) => c.source));
    expect(sources.has('beat')).toBe(true);
    expect(sources.has('Steve')).toBe(true);

    // Beat candidates carry kind 'art'.
    const beatCands = cands.filter((c) => c.source === 'beat');
    expect(beatCands.length).toBe(2);
    expect(beatCands.every((c) => c.kind === 'art')).toBe(true);
    expect(beatCands.map((c) => c.id)).toContain(String(beatImg1));
    expect(beatCands.map((c) => c.id)).toContain(String(beatImg2));

    // Character candidates carry kind 'char'.
    const charCands = cands.filter((c) => c.source === 'Steve');
    expect(charCands.length).toBe(2);
    expect(charCands.every((c) => c.kind === 'char')).toBe(true);
    expect(charCands.map((c) => c.id)).toContain(String(charImg1));
    expect(charCands.map((c) => c.id)).toContain(String(charImg2));
  });

  it('beat artwork uses name/description from GridFS metadata', async () => {
    const id = new ObjectId();
    listImagesForBeat.mockResolvedValueOnce([beatDoc(id, 'Lighthouse', 'cliff scene')]);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });

    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({
      id: String(id),
      kind: 'art',
      source: 'beat',
      name: 'Lighthouse',
      description: 'cliff scene',
    });
  });

  it('each character becomes its own source tag, stripped of markdown', async () => {
    const img = new ObjectId();
    listImagesForBeat.mockResolvedValueOnce([]);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([
      {
        name: 'Steve',
        candidates: [{ id: String(img), name: 'portrait', description: '', caption: '' }],
      },
    ]);

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['**Steve**'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });

    expect(cands).toHaveLength(1);
    // source is the stripped character name returned by gatherCharacterReferenceCandidates
    expect(cands[0].source).toBe('Steve');
    expect(cands[0].kind).toBe('char');
  });

  it('does NOT include library images', async () => {
    const libraryImgId = 'library-img-id';
    listImagesForBeat.mockResolvedValueOnce([]); // no beat images
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]); // no characters

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });

    expect(cands.find((c) => c.id === libraryImgId)).toBeUndefined();
    expect(cands).toEqual([]);
  });

  it('returns [] when listImagesForBeat throws (never propagates)', async () => {
    listImagesForBeat.mockRejectedValueOnce(new Error('mongo down'));
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });
    expect(cands).toEqual([]);
  });

  it('continues when gatherCharacterReferenceCandidates throws, returning beat images', async () => {
    const beatImg = new ObjectId();
    listImagesForBeat.mockResolvedValueOnce([beatDoc(beatImg, 'Alley', 'rain')]);
    gatherCharacterReferenceCandidates.mockRejectedValueOnce(new Error('lookup failed'));

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Steve'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: 'x' });

    // Beat images still returned; character section silently swallowed.
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ id: String(beatImg), kind: 'art', source: 'beat' });
  });

  it('deduplicates beat images that appear multiple times in listImagesForBeat', async () => {
    const id = new ObjectId();
    // Same image returned twice (e.g. main_image also in the GridFS results).
    listImagesForBeat.mockResolvedValueOnce([
      beatDoc(id, 'Alley', 'rain'),
      beatDoc(id, 'Alley', 'rain'),
    ]);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toBe(String(id));
  });

  it('returns [] when beat_id is absent', async () => {
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);

    const sb = { _id: 'sb1', characters_in_scene: [] }; // no beat_id
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    expect(cands).toEqual([]);
    expect(listImagesForBeat).not.toHaveBeenCalled();
  });

  it('combines candidate description and caption with em-dash separator', async () => {
    const img = new ObjectId();
    listImagesForBeat.mockResolvedValueOnce([]);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([
      {
        name: 'Mary',
        candidates: [
          { id: String(img), name: 'Mary close', description: 'red coat', caption: 'pensive look' },
        ],
      },
    ]);

    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Mary'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, frameText: '' });
    expect(cands[0].description).toBe('red coat — pensive look');
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
      sceneText: 'x',
      autoReferences: false,
    });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('skips frames that already have references', async () => {
    const frame = { _id: 'f1', reference_ids: ['existing'] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1' },
      frame,
      sceneText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
    expect(frame.reference_ids).toEqual(['existing']);
  });

  it('persists picks via the gateway and mutates the frame', async () => {
    // New pool: beat artwork. Provide one beat image so candidates is non-empty.
    const beatImg = new ObjectId();
    listImagesForBeat.mockResolvedValueOnce([beatDoc(beatImg, 'Neon alley', 'rain')]);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);
    selectFrameReferences.mockResolvedValueOnce([String(beatImg)]);

    const frame = { _id: 'f1', reference_ids: [] };
    const sb = { _id: 's1', beat_id: 'beat1', characters_in_scene: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb,
      frame,
      sceneText: 'alley',
      autoReferences: true,
    });

    expect(out).toEqual([String(beatImg)]);
    expect(setRefs).toHaveBeenCalledWith({
      projectId: 'p',
      storyboardId: 's1',
      frameId: 'f1',
      imageIds: [String(beatImg)],
      mode: 'replace',
    });
    expect(frame.reference_ids).toEqual([String(beatImg)]);
    expect(selectFrameReferences.mock.calls[0][0].max).toBe(AUTO_REFERENCE_MAX);
  });

  it('does not persist when there are no candidates', async () => {
    listImagesForBeat.mockResolvedValueOnce([]);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);

    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1', beat_id: 'beat1', characters_in_scene: [] },
      frame,
      sceneText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('does not persist when the selector returns nothing', async () => {
    const beatImg = new ObjectId();
    listImagesForBeat.mockResolvedValueOnce([beatDoc(beatImg, 'Neon alley', 'rain')]);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);
    selectFrameReferences.mockResolvedValueOnce([]);

    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1', beat_id: 'beat1', characters_in_scene: [] },
      frame,
      sceneText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([]);
    expect(setRefs).not.toHaveBeenCalled();
    expect(frame.reference_ids).toEqual([]);
  });

  it('swallows gateway errors and returns []', async () => {
    const beatImg = new ObjectId();
    listImagesForBeat.mockResolvedValueOnce([beatDoc(beatImg, 'Neon alley', 'rain')]);
    gatherCharacterReferenceCandidates.mockResolvedValueOnce([]);
    selectFrameReferences.mockResolvedValueOnce([String(beatImg)]);
    setRefs.mockRejectedValueOnce(new Error('gateway down'));

    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({
      projectId: 'p',
      sb: { _id: 's1', beat_id: 'beat1', characters_in_scene: [] },
      frame,
      sceneText: 'x',
      autoReferences: true,
    });
    expect(out).toEqual([]);
    expect(frame.reference_ids).toEqual([]);
  });
});
