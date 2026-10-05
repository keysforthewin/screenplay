// The wardrobe lock: pure helpers (src/web/wardrobe.js), the plate setter and
// its cascade through artwork result / undo / remove and gallery removal, and
// the per-beat overrides on updateBeat.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } }));
vi.mock('../src/mongo/images.js', () => ({
  deleteImage: vi.fn(async () => {}),
  findImageFile: vi.fn(async (id) => ({ _id: new ObjectId(String(id)), metadata: {} })),
  imageFileToMeta: vi.fn(() => ({ name: '', description: '' })),
  readImageBuffer: vi.fn(),
  uploadImageFromUrl: vi.fn(),
  uploadGeneratedImage: vi.fn(),
}));

const W = await import('../src/web/wardrobe.js');
const { createProject } = await import('../src/mongo/projects.js');
const Files = await import('../src/mongo/files.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const Artworks = await import('../src/mongo/artworks.js');

describe('wardrobe helpers (pure)', () => {
  const id = new ObjectId();
  const c = { _id: id, name: '**Sarah**', fields: { wardrobe: '**navy** flannel shirt,\n tan   canvas jacket' } };

  it('wardrobeText strips markdown, collapses whitespace and clips', () => {
    expect(W.wardrobeText(c)).toBe('navy flannel shirt, tan canvas jacket');
    expect(W.wardrobeText({ fields: {} })).toBe('');
    expect(W.wardrobeText(null)).toBe('');
    const long = { fields: { wardrobe: 'x'.repeat(400) } };
    expect(W.wardrobeText(long).length).toBe(W.WARDROBE_TEXT_MAX);
    expect(W.wardrobeText(long).endsWith('…')).toBe(true);
  });

  it('a beat override wins for that character only; blank override falls through', () => {
    const beat = { wardrobe_overrides: { [String(id)]: 'jacket off, sleeves rolled', [String(new ObjectId())]: 'other' } };
    expect(W.wardrobeText(c, beat)).toBe('jacket off, sleeves rolled');
    expect(W.wardrobeText(c, { wardrobe_overrides: { [String(id)]: '  ' } })).toBe('navy flannel shirt, tan canvas jacket');
    expect(W.wardrobeText(c, { wardrobe_overrides: null })).toBe('navy flannel shirt, tan canvas jacket');
  });

  it('wardrobeLine / wardrobeImageId / lockedWardrobeFor / formatLockRows', () => {
    expect(W.wardrobeLine(c)).toBe('Wardrobe (locked — reproduce exactly): navy flannel shirt, tan canvas jacket');
    expect(W.WARDROBE_LINE_RE.test(W.wardrobeLine(c))).toBe(true);
    expect(W.wardrobeLine({ fields: {} })).toBe('');
    const plate = new ObjectId();
    expect(W.wardrobeImageId({ wardrobe_image_id: plate })).toBe(String(plate));
    expect(W.wardrobeImageId({ wardrobe_image_id: 'nope' })).toBe('');
    expect(W.wardrobeImageId({})).toBe('');
    const rows = W.lockedWardrobeFor([c, { _id: new ObjectId(), name: 'Tom', wardrobe_image_id: plate }, null]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: String(id), name: 'Sarah', text: 'navy flannel shirt, tan canvas jacket', image_id: '' });
    expect(rows[1]).toMatchObject({ name: 'Tom', text: '', image_id: String(plate) });
    expect(W.formatLockRows(rows)).toBe('Wardrobe lock — Sarah: navy flannel shirt, tan canvas jacket');
    expect(W.formatWardrobeLocks([c])).toBe('Wardrobe lock — Sarah: navy flannel shirt, tan canvas jacket');
  });
});

describe('wardrobe plate: setter and cascade', () => {
  let projectId;
  beforeEach(async () => {
    fakeDb.reset();
    projectId = (await createProject('P'))._id.toString();
  });

  async function characterWithArtwork() {
    const c = await Characters.createCharacter({ projectId, name: 'Rae' });
    const { artwork } = await Artworks.createPendingArtwork({ projectId, hostType: 'character', hostId: c._id.toString(), prompt: 'p', model: 'fal' });
    const r1 = new ObjectId();
    await Artworks.setArtworkResult({ projectId, hostType: 'character', hostId: c._id.toString(), artworkId: artwork._id, resultImageId: r1 });
    return { c, artworkId: artwork._id, r1 };
  }
  const plateOf = async (c) => (await Characters.getCharacter(projectId, c._id.toString())).wardrobe_image_id;

  it('accepts a done artwork result or a gallery image, rejects anything else, and clears on null', async () => {
    const { c, r1 } = await characterWithArtwork();
    const out = await Files.setCharacterWardrobeImage({ projectId, character: c._id.toString(), imageId: r1.toString() });
    expect(String(out.wardrobe_image_id)).toBe(String(r1));
    expect(String(await plateOf(c))).toBe(String(r1));
    await expect(Files.setCharacterWardrobeImage({ projectId, character: c._id.toString(), imageId: new ObjectId().toString() })).rejects.toThrow(/not attached/);
    const img = new ObjectId();
    await Characters.pushCharacterImage(projectId, c._id.toString(), { _id: img, filename: 'g.png' }, false);
    await Files.setCharacterWardrobeImage({ projectId, character: c._id.toString(), imageId: img.toString() });
    expect(String(await plateOf(c))).toBe(String(img));
    await Files.setCharacterWardrobeImage({ projectId, character: c._id.toString(), imageId: null });
    expect(await plateOf(c)).toBeNull();
  });

  it('follows a regenerated / edited result, an undo, and clears on remove — main_image_id untouched', async () => {
    const { c, artworkId, r1 } = await characterWithArtwork();
    await Files.setCharacterWardrobeImage({ projectId, character: c._id.toString(), imageId: r1.toString() });
    const r2 = new ObjectId();
    const edit = await Artworks.setArtworkResult({ projectId, hostType: 'character', hostId: c._id.toString(), artworkId, resultImageId: r2, rotateToPrevious: true });
    expect(edit.wardrobeImageIdChange).toEqual({ changed: true, value: r2 });
    expect(edit.mainImageIdChange).toBeNull();
    expect(String(await plateOf(c))).toBe(String(r2));
    const undo = await Artworks.undoArtworkEdit({ projectId, hostType: 'character', hostId: c._id.toString(), artworkId });
    expect(undo.wardrobeImageIdChange).toEqual({ changed: true, value: r1 });
    expect(String(await plateOf(c))).toBe(String(r1));
    const rm = await Artworks.removeArtwork({ projectId, hostType: 'character', hostId: c._id.toString(), artworkId });
    expect(rm.wardrobeImageIdChange).toEqual({ changed: true, value: null });
    expect(await plateOf(c)).toBeNull();
    expect((await Characters.getCharacter(projectId, c._id.toString())).main_image_id ?? null).toBeNull();
  });

  it('does not move when a different artwork changes', async () => {
    const { c, r1 } = await characterWithArtwork();
    await Files.setCharacterWardrobeImage({ projectId, character: c._id.toString(), imageId: r1.toString() });
    const { artwork: other } = await Artworks.createPendingArtwork({ projectId, hostType: 'character', hostId: c._id.toString(), prompt: 'q', model: 'fal' });
    const out = await Artworks.setArtworkResult({ projectId, hostType: 'character', hostId: c._id.toString(), artworkId: other._id, resultImageId: new ObjectId() });
    expect(out.wardrobeImageIdChange).toBeNull();
    expect(String(await plateOf(c))).toBe(String(r1));
  });

  it('clears when the gallery image it points at is removed or replaced', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae' });
    const img = new ObjectId();
    await Characters.pushCharacterImage(projectId, c._id.toString(), { _id: img, filename: 'g.png' }, false);
    await Files.setCharacterWardrobeImage({ projectId, character: c._id.toString(), imageId: img.toString() });
    const img2 = new ObjectId();
    await Characters.replaceCharacterImage(projectId, c._id.toString(), img, { _id: img2, filename: 'h.png' });
    expect(String(await plateOf(c))).toBe(String(img2));
    await Files.removeCharacterImage({ projectId, character: c._id.toString(), imageId: img2.toString() });
    expect(await plateOf(c)).toBeNull();
  });
});

describe('beat wardrobe_overrides', () => {
  let projectId;
  beforeEach(async () => {
    fakeDb.reset();
    projectId = (await createProject('P'))._id.toString();
  });

  it('merges, trims, deletes on blank, and validates keys', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B' });
    const a = new ObjectId().toString();
    const b = new ObjectId().toString().toUpperCase();
    let out = await Plots.updateBeat(projectId, beat._id.toString(), { wardrobe_overrides: { [a]: '  jacket off ' } });
    expect(out.wardrobe_overrides).toEqual({ [a]: 'jacket off' });
    out = await Plots.updateBeat(projectId, beat._id.toString(), { wardrobe_overrides: { [b]: 'hat on' } });
    expect(out.wardrobe_overrides).toEqual({ [a]: 'jacket off', [b.toLowerCase()]: 'hat on' });
    out = await Plots.updateBeat(projectId, beat._id.toString(), { wardrobe_overrides: { [a]: '', [b.toLowerCase()]: null } });
    expect(out.wardrobe_overrides).toEqual({});
    await expect(Plots.updateBeat(projectId, beat._id.toString(), { wardrobe_overrides: { nope: 'x' } })).rejects.toThrow(/not a character id/);
    await expect(Plots.updateBeat(projectId, beat._id.toString(), { wardrobe_overrides: [] })).rejects.toThrow(/must be an object/);
  });
});
