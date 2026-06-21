import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const listLibraryImages = vi.fn();
// Fully mock images.js so the real module (and its mongo/config deps) never
// loads. imageFileToMeta is a tiny pure mapper — stand in for just the fields
// buildFrameReferenceCandidates reads.
vi.mock('../src/mongo/images.js', () => ({
  listLibraryImages,
  imageFileToMeta: (f) => ({
    _id: f._id,
    name: f.metadata?.name || '',
    description: f.metadata?.description || '',
  }),
}));

const getCharacter = vi.fn();
vi.mock('../src/mongo/characters.js', () => ({ getCharacter }));

const selectFrameReferences = vi.fn();
vi.mock('../src/llm/frameReferenceSelector.js', () => ({ selectFrameReferences }));

const setRefs = vi.fn();
vi.mock('../src/web/gateway.js', () => ({
  setStoryboardFrameReferenceImagesViaGateway: setRefs,
}));

const { buildFrameReferenceCandidates, autoFillFrameReferencesIfEmpty, AUTO_REFERENCE_MAX } =
  await import('../src/web/frameReferences.js');

// Minimal GridFS-shaped library doc.
function libDoc(id, name, description) {
  return { _id: id, filename: `${id}.png`, contentType: 'image/png', length: 1, uploadDate: new Date(), metadata: { name, description, owner_type: null } };
}

beforeEach(() => {
  listLibraryImages.mockReset();
  getCharacter.mockReset();
  selectFrameReferences.mockReset();
  setRefs.mockReset();
});

describe('buildFrameReferenceCandidates', () => {
  it('includes captioned artwork + scene-character portraits, drops empties and missing portraits', async () => {
    listLibraryImages.mockResolvedValueOnce([
      libDoc('art1', 'Neon alley', 'rain-slick alley'),
      libDoc('art2', '', ''), // no signal -> dropped
      libDoc('art3', 'Diner', ''),
    ]);
    getCharacter.mockImplementation(async (_pid, name) => {
      if (name === 'Steve') return { _id: 'c1', name: 'Steve', main_image_id: 'p_steve' };
      if (name === 'Mary') return { _id: 'c2', name: 'Mary', main_image_id: null }; // no portrait -> dropped
      return null; // 'Ghost' unknown -> dropped
    });
    const sb = { characters_in_scene: ['**Steve**', 'Ghost', 'Mary'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, sceneText: 'x' });
    expect(cands).toEqual([
      { id: 'art1', kind: 'art', name: 'Neon alley', description: 'rain-slick alley' },
      { id: 'art3', kind: 'art', name: 'Diner', description: '' },
      { id: 'p_steve', kind: 'char', name: 'Steve', description: '' },
    ]);
  });

  it('trims an oversized catalog to CATALOG_MAX, keeping scene-text matches', async () => {
    const docs = [];
    for (let i = 0; i < 130; i++) docs.push(libDoc(`art${i}`, `Filler ${i}`, 'generic'));
    docs.push(libDoc('match', 'Lighthouse cliff', 'a lighthouse on a rugged cliff'));
    listLibraryImages.mockResolvedValueOnce(docs);
    getCharacter.mockResolvedValue(null);
    const sb = { characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, sceneText: 'a lighthouse on a cliff' });
    expect(cands.length).toBe(120);
    expect(cands.some((c) => c.id === 'match')).toBe(true);
  });

  it('returns [] when listLibraryImages throws (never propagates)', async () => {
    listLibraryImages.mockRejectedValueOnce(new Error('mongo down'));
    getCharacter.mockResolvedValue(null);
    const sb = { characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, sceneText: 'x' });
    expect(cands).toEqual([]);
  });

  it('skips a character and continues when getCharacter throws', async () => {
    listLibraryImages.mockResolvedValueOnce([libDoc('art1', 'Neon alley', 'rain')]);
    getCharacter.mockImplementation(async (_pid, name) => {
      if (name === 'Steve') throw new Error('lookup failed');
      if (name === 'Mary') return { _id: 'c2', name: 'Mary', main_image_id: 'p_mary' };
      return null;
    });
    const sb = { characters_in_scene: ['Steve', 'Mary'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, sceneText: 'x' });
    expect(cands).toEqual([
      { id: 'art1', kind: 'art', name: 'Neon alley', description: 'rain' },
      { id: 'p_mary', kind: 'char', name: 'Mary', description: '' },
    ]);
  });
});

describe('autoFillFrameReferencesIfEmpty', () => {
  it('does nothing when autoReferences is false', async () => {
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1' }, frame, sceneText: 'x', autoReferences: false });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('skips frames that already have references', async () => {
    const frame = { _id: 'f1', reference_ids: ['existing'] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1' }, frame, sceneText: 'x', autoReferences: true });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
    expect(frame.reference_ids).toEqual(['existing']);
  });

  it('persists picks via the gateway and mutates the frame', async () => {
    listLibraryImages.mockResolvedValueOnce([libDoc('art1', 'Neon alley', 'rain')]);
    getCharacter.mockResolvedValue(null);
    selectFrameReferences.mockResolvedValueOnce(['art1']);
    const frame = { _id: 'f1', reference_ids: [] };
    const sb = { _id: 's1', characters_in_scene: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb, frame, sceneText: 'alley', autoReferences: true });
    expect(out).toEqual(['art1']);
    expect(setRefs).toHaveBeenCalledWith({ projectId: 'p', storyboardId: 's1', frameId: 'f1', imageIds: ['art1'], mode: 'replace' });
    expect(frame.reference_ids).toEqual(['art1']);
    expect(selectFrameReferences.mock.calls[0][0].max).toBe(AUTO_REFERENCE_MAX);
  });

  it('does not persist when there are no candidates', async () => {
    listLibraryImages.mockResolvedValueOnce([]);
    getCharacter.mockResolvedValue(null);
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1', characters_in_scene: [] }, frame, sceneText: 'x', autoReferences: true });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('does not persist when the selector returns nothing', async () => {
    listLibraryImages.mockResolvedValueOnce([libDoc('art1', 'Neon alley', 'rain')]);
    getCharacter.mockResolvedValue(null);
    selectFrameReferences.mockResolvedValueOnce([]);
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1', characters_in_scene: [] }, frame, sceneText: 'x', autoReferences: true });
    expect(out).toEqual([]);
    expect(setRefs).not.toHaveBeenCalled();
    expect(frame.reference_ids).toEqual([]);
  });

  it('swallows gateway errors and returns []', async () => {
    listLibraryImages.mockResolvedValueOnce([libDoc('art1', 'Neon alley', 'rain')]);
    getCharacter.mockResolvedValue(null);
    selectFrameReferences.mockResolvedValueOnce(['art1']);
    setRefs.mockRejectedValueOnce(new Error('gateway down'));
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1', characters_in_scene: [] }, frame, sceneText: 'x', autoReferences: true });
    expect(out).toEqual([]);
    expect(frame.reference_ids).toEqual([]);
  });
});
