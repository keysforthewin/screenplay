// Cascade tests: when the artwork whose result is the host's main_image_id
// is regenerated / edited / undone / removed, main_image_id must follow
// (regen, edit, undo) or clear (remove). When a non-main artwork is
// mutated, the host's main_image_id must not change.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const Files = await import('../src/mongo/files.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');
const Artworks = await import('../src/mongo/artworks.js');

beforeEach(() => {
  fakeDb.reset();
});

async function makeCharacterWithMainArtwork() {
  const c = await Characters.createCharacter({ name: 'Rae' });
  const { artwork } = await Artworks.createPendingArtwork({
    hostType: 'character',
    hostId: c._id.toString(),
    prompt: 'p',
    model: 'fal',
  });
  const r1 = new ObjectId();
  await Artworks.setArtworkResult({
    hostType: 'character',
    hostId: c._id.toString(),
    artworkId: artwork._id,
    resultImageId: r1,
  });
  await Files.setMainCharacterImage({
    character: c._id.toString(),
    imageId: r1.toString(),
  });
  return { c, artworkId: artwork._id, r1 };
}

async function makeBeatWithMainArtwork() {
  const b = await Plots.createBeat({ name: 'Cold open' });
  const { artwork } = await Artworks.createPendingArtwork({
    hostType: 'beat',
    hostId: b._id.toString(),
    prompt: 'p',
    model: 'fal',
  });
  const r1 = new ObjectId();
  await Artworks.setArtworkResult({
    hostType: 'beat',
    hostId: b._id.toString(),
    artworkId: artwork._id,
    resultImageId: r1,
  });
  await Plots.setBeatMainImage(undefined, b._id.toString(), r1);
  return { b, artworkId: artwork._id, r1 };
}

describe('Artwork → main_image_id cascade (character)', () => {
  it('regenerate moves main_image_id to the new result', async () => {
    const { c, artworkId, r1 } = await makeCharacterWithMainArtwork();
    const r2 = new ObjectId();
    const out = await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId,
      resultImageId: r2,
    });
    expect(out.orphanedImageId.equals(r1)).toBe(true);
    expect(out.mainImageIdChange?.changed).toBe(true);
    expect(out.mainImageIdChange.value.equals(r2)).toBe(true);
    const fresh = await Characters.getCharacter(undefined, 'Rae');
    expect(fresh.main_image_id.equals(r2)).toBe(true);
  });

  it('edit (rotate) moves main_image_id to the new result', async () => {
    const { c, artworkId } = await makeCharacterWithMainArtwork();
    const r2 = new ObjectId();
    const out = await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId,
      resultImageId: r2,
      rotateToPrevious: true,
    });
    expect(out.mainImageIdChange?.changed).toBe(true);
    expect(out.mainImageIdChange.value.equals(r2)).toBe(true);
    const fresh = await Characters.getCharacter(undefined, 'Rae');
    expect(fresh.main_image_id.equals(r2)).toBe(true);
  });

  it('undo after edit restores main_image_id to the previous result', async () => {
    const { c, artworkId, r1 } = await makeCharacterWithMainArtwork();
    const r2 = new ObjectId();
    // Edit: r1 → previous, r2 → current. Main follows to r2.
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId,
      resultImageId: r2,
      rotateToPrevious: true,
    });
    // Undo: r2 → orphan, r1 → current. Main follows back to r1.
    const out = await Artworks.undoArtworkEdit({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId,
    });
    expect(out.mainImageIdChange?.changed).toBe(true);
    expect(out.mainImageIdChange.value.equals(r1)).toBe(true);
    const fresh = await Characters.getCharacter(undefined, 'Rae');
    expect(fresh.main_image_id.equals(r1)).toBe(true);
  });

  it('remove clears main_image_id when the deleted artwork hosts main', async () => {
    const { c, artworkId } = await makeCharacterWithMainArtwork();
    const out = await Artworks.removeArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId,
    });
    expect(out.mainImageIdChange?.changed).toBe(true);
    expect(out.mainImageIdChange.value).toBeNull();
    const fresh = await Characters.getCharacter(undefined, 'Rae');
    expect(fresh.main_image_id).toBeNull();
  });

  it('leaves main_image_id alone when a non-main artwork is regenerated', async () => {
    const { c, r1 } = await makeCharacterWithMainArtwork();
    // Add a second, unrelated artwork; main still points at r1.
    const { artwork: a2 } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'side piece',
      model: 'fal',
    });
    const r2 = new ObjectId();
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: a2._id,
      resultImageId: r2,
    });
    const r3 = new ObjectId();
    const out = await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: a2._id,
      resultImageId: r3,
    });
    expect(out.mainImageIdChange).toBeNull();
    const fresh = await Characters.getCharacter(undefined, 'Rae');
    expect(fresh.main_image_id.equals(r1)).toBe(true);
  });

  it('leaves main_image_id alone when a non-main artwork is removed', async () => {
    const { c, r1 } = await makeCharacterWithMainArtwork();
    const { artwork: a2 } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'side piece',
      model: 'fal',
    });
    const r2 = new ObjectId();
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: a2._id,
      resultImageId: r2,
    });
    const out = await Artworks.removeArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: a2._id,
    });
    expect(out.mainImageIdChange).toBeNull();
    const fresh = await Characters.getCharacter(undefined, 'Rae');
    expect(fresh.main_image_id.equals(r1)).toBe(true);
  });
});

describe('Artwork → main_image_id cascade (beat)', () => {
  it('regenerate moves beat main_image_id to the new result', async () => {
    const { b, artworkId, r1 } = await makeBeatWithMainArtwork();
    const r2 = new ObjectId();
    const out = await Artworks.setArtworkResult({
      hostType: 'beat',
      hostId: b._id.toString(),
      artworkId,
      resultImageId: r2,
    });
    expect(out.orphanedImageId.equals(r1)).toBe(true);
    expect(out.mainImageIdChange?.changed).toBe(true);
    expect(out.mainImageIdChange.value.equals(r2)).toBe(true);
    const fresh = await Plots.getBeat(undefined, b._id.toString());
    expect(fresh.main_image_id.equals(r2)).toBe(true);
  });

  it('remove clears beat main_image_id when the deleted artwork hosts main', async () => {
    const { b, artworkId } = await makeBeatWithMainArtwork();
    const out = await Artworks.removeArtwork({
      hostType: 'beat',
      hostId: b._id.toString(),
      artworkId,
    });
    expect(out.mainImageIdChange?.changed).toBe(true);
    expect(out.mainImageIdChange.value).toBeNull();
    const fresh = await Plots.getBeat(undefined, b._id.toString());
    expect(fresh.main_image_id).toBeNull();
  });
});
