// Unit tests for src/mongo/artworks.js — the host-agnostic artwork helpers
// that back both character and beat artwork. Focus is on:
//   - status transitions (pending → done/error)
//   - previous_result_image_id rotation on edit
//   - orphan image tracking (so the gateway can clean up GridFS)
//   - parity between character and beat hosts

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

const Artworks = await import('../src/mongo/artworks.js');
const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');

beforeEach(() => {
  fakeDb.reset();
});

async function makeCharacter(name = 'Rae') {
  return Characters.createCharacter({ name });
}

async function makeBeat(name = 'Cold open') {
  return Plots.createBeat({ name, desc: 'A test beat for artwork.' });
}

describe('artworks.js — character host', () => {
  it('createPendingArtwork seeds status=pending with the given fields', async () => {
    const c = await makeCharacter();
    const refA = new ObjectId();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'cyberpunk warrior',
      name: 'Hero shot',
      model: 'fal',
      referenceImageIds: [refA],
    });
    expect(artwork.status).toBe('pending');
    expect(artwork.prompt).toBe('cyberpunk warrior');
    expect(artwork.name).toBe('Hero shot');
    expect(artwork.model).toBe('fal');
    expect(artwork.result_image_id).toBeNull();
    expect(artwork.previous_result_image_id).toBeNull();
    expect(artwork.reference_image_ids).toHaveLength(1);

    const fresh = await Characters.getCharacter('Rae');
    expect(fresh.artworks).toHaveLength(1);
    expect(fresh.artworks[0]._id.toString()).toBe(artwork._id.toString());
  });

  it('setArtworkResult on a pending artwork transitions to done and reports no orphan', async () => {
    const c = await makeCharacter();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    const newResult = new ObjectId();
    const out = await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: newResult,
    });
    expect(out.artwork.status).toBe('done');
    expect(out.artwork.result_image_id.toString()).toBe(newResult.toString());
    expect(out.orphanedImageId).toBeNull();
  });

  it('regenerate (no rotation) orphans the previous result_image_id', async () => {
    const c = await makeCharacter();
    const oldResult = new ObjectId();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: oldResult,
    });
    const newResult = new ObjectId();
    const out = await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: newResult,
      rotateToPrevious: false,
    });
    expect(out.orphanedImageId?.toString()).toBe(oldResult.toString());
    expect(out.artwork.result_image_id.toString()).toBe(newResult.toString());
    expect(out.artwork.previous_result_image_id).toBeNull();
  });

  it('edit rotation moves current → previous and orphans the *old* previous', async () => {
    const c = await makeCharacter();
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const r3 = new ObjectId();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    // First result lands. No previous yet.
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: r1,
    });
    // First edit: rotate r1 → previous, no orphan yet.
    const e1 = await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: r2,
      rotateToPrevious: true,
    });
    expect(e1.artwork.result_image_id.toString()).toBe(r2.toString());
    expect(e1.artwork.previous_result_image_id.toString()).toBe(r1.toString());
    expect(e1.orphanedImageId).toBeNull();
    // Second edit: rotate r2 → previous, r1 is orphaned.
    const e2 = await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: r3,
      rotateToPrevious: true,
    });
    expect(e2.artwork.result_image_id.toString()).toBe(r3.toString());
    expect(e2.artwork.previous_result_image_id.toString()).toBe(r2.toString());
    expect(e2.orphanedImageId.toString()).toBe(r1.toString());
  });

  it('undoArtworkEdit swaps previous → current and orphans the discarded image', async () => {
    const c = await makeCharacter();
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: r1,
    });
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: r2,
      rotateToPrevious: true,
    });
    const undo = await Artworks.undoArtworkEdit({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
    });
    expect(undo.artwork.result_image_id.toString()).toBe(r1.toString());
    expect(undo.artwork.previous_result_image_id).toBeNull();
    expect(undo.orphanedImageId.toString()).toBe(r2.toString());
  });

  it('undoArtworkEdit throws 400 when there is nothing to undo', async () => {
    const c = await makeCharacter();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    await expect(
      Artworks.undoArtworkEdit({
        hostType: 'character',
        hostId: c._id.toString(),
        artworkId: artwork._id,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('setArtworkStatus error stores the message and clears job_id', async () => {
    const c = await makeCharacter();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
      jobId: 'job-1',
    });
    const out = await Artworks.setArtworkStatus({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      status: 'error',
      errorMessage: 'fal HTTP 502',
    });
    expect(out.artwork.status).toBe('error');
    expect(out.artwork.error_message).toBe('fal HTTP 502');
    expect(out.artwork.job_id).toBeNull();
  });

  it('patchArtwork updates name and last_edit_prompt but rejects unknown fields', async () => {
    const c = await makeCharacter();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    const out = await Artworks.patchArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      patch: { name: 'Hero shot v2', last_edit_prompt: 'add hat' },
    });
    expect(out.artwork.name).toBe('Hero shot v2');
    expect(out.artwork.last_edit_prompt).toBe('add hat');

    await expect(
      Artworks.patchArtwork({
        hostType: 'character',
        hostId: c._id.toString(),
        artworkId: artwork._id,
        patch: { totally_made_up: 'x' },
      }),
    ).rejects.toThrow(/unknown field/);
  });

  it('removeArtwork drops the artwork and reports both image ids for GridFS cleanup', async () => {
    const c = await makeCharacter();
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: r1,
    });
    await Artworks.setArtworkResult({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
      resultImageId: r2,
      rotateToPrevious: true,
    });
    const out = await Artworks.removeArtwork({
      hostType: 'character',
      hostId: c._id.toString(),
      artworkId: artwork._id,
    });
    expect(out.removed_image_ids.map(String).sort()).toEqual(
      [r1.toString(), r2.toString()].sort(),
    );
    const fresh = await Characters.getCharacter('Rae');
    expect(fresh.artworks).toEqual([]);
  });
});

describe('artworks.js — beat host', () => {
  it('createPendingArtwork on a beat persists into plots.beats[].artworks[]', async () => {
    const b = await makeBeat();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: b._id.toString(),
      prompt: 'wide diner exterior',
      name: 'establishing',
      model: 'fal',
    });
    expect(artwork.status).toBe('pending');
    const fresh = await Plots.getBeat(b._id.toString());
    expect(fresh.artworks).toHaveLength(1);
    expect(fresh.artworks[0].name).toBe('establishing');
  });

  it('beat artwork undo + remove behave identically to character artwork', async () => {
    const b = await makeBeat();
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: b._id.toString(),
      prompt: 'p',
      model: 'fal',
    });
    await Artworks.setArtworkResult({
      hostType: 'beat',
      hostId: b._id.toString(),
      artworkId: artwork._id,
      resultImageId: r1,
    });
    await Artworks.setArtworkResult({
      hostType: 'beat',
      hostId: b._id.toString(),
      artworkId: artwork._id,
      resultImageId: r2,
      rotateToPrevious: true,
    });
    const undo = await Artworks.undoArtworkEdit({
      hostType: 'beat',
      hostId: b._id.toString(),
      artworkId: artwork._id,
    });
    expect(undo.artwork.result_image_id.toString()).toBe(r1.toString());
    expect(undo.orphanedImageId.toString()).toBe(r2.toString());

    const rm = await Artworks.removeArtwork({
      hostType: 'beat',
      hostId: b._id.toString(),
      artworkId: artwork._id,
    });
    expect(rm.removed_image_ids.map(String)).toEqual([r1.toString()]);
  });

  it('beat lookup works by _id, order, or name', async () => {
    const b = await makeBeat('Inciting incident');
    await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: b._id.toString(),
      prompt: 'p1',
      model: 'gemini',
    });
    // Order
    await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: String(b.order),
      prompt: 'p2',
      model: 'gemini',
    });
    // Name
    await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: 'Inciting incident',
      prompt: 'p3',
      model: 'gemini',
    });
    const fresh = await Plots.getBeat(b._id.toString());
    expect(fresh.artworks).toHaveLength(3);
    expect(fresh.artworks.map((a) => a.prompt)).toEqual(['p1', 'p2', 'p3']);
  });

  it('rejects unknown host types', async () => {
    await expect(
      Artworks.createPendingArtwork({
        hostType: 'storyboard',
        hostId: 'whatever',
        prompt: 'p',
        model: 'fal',
      }),
    ).rejects.toThrow(/invalid hostType/);
  });
});
