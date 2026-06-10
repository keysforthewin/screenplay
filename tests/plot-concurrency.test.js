// Concurrency tests for the singleton `plots` doc.
//
// Every beat-related mutation today rewrites the entire `plots.beats[]`
// array (see persistBeats in src/mongo/plots.js and persistArtworks in
// src/mongo/artworks.js). When two operations overlap their read-modify-
// write windows, the later writer's stale snapshot silently clobbers the
// earlier writer's changes. The most painful case in practice is artwork
// generation (10–30 s window between createPendingArtwork and
// setArtworkResult) racing with a Hocuspocus body-edit tick (~2 s),
// which is how artwork goes missing on page reload even though the user
// never deleted anything.
//
// These tests pin the desired behavior: independent concurrent mutations
// on a single beat must all land. They will fail today and pass once the
// helpers are migrated to positional/atomic updates.

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
const Plots = await import('../src/mongo/plots.js');

beforeEach(() => fakeDb.reset());

describe('plots concurrency — beat mutations must not clobber each other', () => {
  it('setArtworkResult racing with updateBeat: both writes survive', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'd', body: 'orig body' });
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: beat._id.toString(),
      prompt: 'p',
      model: 'nano-banana-pro',
    });

    const newResult = new ObjectId();
    const [, ] = await Promise.all([
      Artworks.setArtworkResult({
        hostType: 'beat',
        hostId: beat._id.toString(),
        artworkId: artwork._id,
        resultImageId: newResult,
      }),
      Plots.updateBeat(undefined, beat._id.toString(), { body: 'new body' }),
    ]);

    const fresh = await Plots.getBeat(undefined, beat._id.toString());
    expect(fresh.body).toBe('new body');
    expect(fresh.artworks).toHaveLength(1);
    expect(fresh.artworks[0].status).toBe('done');
    expect(fresh.artworks[0].result_image_id.toString()).toBe(newResult.toString());
  });

  it('createPendingArtwork racing with updateBeat: artwork is not lost', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'd', body: 'orig body' });

    const [{ artwork }] = await Promise.all([
      Artworks.createPendingArtwork({
        hostType: 'beat',
        hostId: beat._id.toString(),
        prompt: 'p',
        model: 'nano-banana-pro',
      }),
      Plots.updateBeat(undefined, beat._id.toString(), { body: 'new body' }),
    ]);

    const fresh = await Plots.getBeat(undefined, beat._id.toString());
    expect(fresh.body).toBe('new body');
    expect(fresh.artworks).toHaveLength(1);
    expect(fresh.artworks[0]._id.toString()).toBe(artwork._id.toString());
    expect(fresh.artworks[0].status).toBe('pending');
  });

  it('two artworks created concurrently on the same beat both survive', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'd' });

    const [a, b] = await Promise.all([
      Artworks.createPendingArtwork({
        hostType: 'beat',
        hostId: beat._id.toString(),
        prompt: 'first',
        model: 'nano-banana-pro',
      }),
      Artworks.createPendingArtwork({
        hostType: 'beat',
        hostId: beat._id.toString(),
        prompt: 'second',
        model: 'nano-banana-pro',
      }),
    ]);

    const fresh = await Plots.getBeat(undefined, beat._id.toString());
    const ids = (fresh.artworks || []).map((aw) => aw._id.toString()).sort();
    const expected = [a.artwork._id.toString(), b.artwork._id.toString()].sort();
    expect(ids).toEqual(expected);
  });

  it('setArtworkResult on beat A does not clobber updateBeat on beat B', async () => {
    const beatA = await Plots.createBeat({ name: 'A', desc: 'a', body: 'a-orig' });
    const beatB = await Plots.createBeat({ name: 'B', desc: 'b', body: 'b-orig' });
    const { artwork } = await Artworks.createPendingArtwork({
      hostType: 'beat',
      hostId: beatA._id.toString(),
      prompt: 'p',
      model: 'nano-banana-pro',
    });

    const newResult = new ObjectId();
    await Promise.all([
      Artworks.setArtworkResult({
        hostType: 'beat',
        hostId: beatA._id.toString(),
        artworkId: artwork._id,
        resultImageId: newResult,
      }),
      Plots.updateBeat(undefined, beatB._id.toString(), { body: 'b-new' }),
    ]);

    const freshA = await Plots.getBeat(undefined, beatA._id.toString());
    const freshB = await Plots.getBeat(undefined, beatB._id.toString());
    expect(freshA.artworks[0].status).toBe('done');
    expect(freshA.artworks[0].result_image_id.toString()).toBe(newResult.toString());
    expect(freshB.body).toBe('b-new');
  });

  it('two concurrent character artwork creations both land', async () => {
    const Characters = await import('../src/mongo/characters.js');
    const c = await Characters.createCharacter({ name: 'Rae' });

    const [a, b] = await Promise.all([
      Artworks.createPendingArtwork({
        hostType: 'character',
        hostId: c._id.toString(),
        prompt: 'first',
        model: 'nano-banana-pro',
      }),
      Artworks.createPendingArtwork({
        hostType: 'character',
        hostId: c._id.toString(),
        prompt: 'second',
        model: 'nano-banana-pro',
      }),
    ]);

    const fresh = await Characters.getCharacter(undefined, c._id.toString());
    const ids = (fresh.artworks || []).map((aw) => aw._id.toString()).sort();
    const expected = [a.artwork._id.toString(), b.artwork._id.toString()].sort();
    expect(ids).toEqual(expected);
  });
});
