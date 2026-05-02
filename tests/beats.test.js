import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Plots = await import('../src/mongo/plots.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('plots beat CRUD', () => {
  it('seeds a plot on first read with all expected fields', async () => {
    const plot = await Plots.getPlot();
    expect(plot._id).toBe('main');
    expect(plot.synopsis).toBe('');
    expect(plot.notes).toBe('');
    expect(plot.beats).toEqual([]);
    expect(plot.current_beat_id).toBe(null);
  });

  it('createBeat assigns an _id, increments order, and auto-sets current beat', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'Opening scene' });
    const b = await Plots.createBeat({ name: 'Inciting', desc: 'Inciting incident' });

    expect(a._id).toBeInstanceOf(ObjectId);
    expect(a.order).toBe(1);
    expect(b.order).toBe(2);

    const plot = await Plots.getPlot();
    expect(plot.beats).toHaveLength(2);
    expect(plot.current_beat_id.equals(a._id)).toBe(true);
  });

  it('createBeat stores name, desc, and body separately; body defaults to empty', async () => {
    const beat = await Plots.createBeat({
      name: 'Diner Argument',
      desc: 'Alice and Bob argue at the diner.',
    });
    expect(beat.name).toBe('Diner Argument');
    expect(beat.desc).toBe('Alice and Bob argue at the diner.');
    expect(beat.body).toBe('');
  });

  it('createBeat derives name from desc when name is omitted', async () => {
    const beat = await Plots.createBeat({
      desc: 'The time when Alice told Bob she was leaving for good.',
    });
    expect(beat.name).toBe('The time when Alice told Bob');
    expect(beat.desc).toBe('The time when Alice told Bob she was leaving for good.');
  });

  it('createBeat without desc or name throws', async () => {
    await expect(Plots.createBeat({})).rejects.toThrow(/desc/);
  });

  it('createBeat dedupes characters case-insensitively', async () => {
    const beat = await Plots.createBeat({
      name: 'Diner',
      desc: 'A diner scene.',
      characters: ['Alice', 'alice', 'Bob'],
    });
    expect(beat.characters).toEqual(['Alice', 'Bob']);
  });

  it('getBeat resolves by _id, by order string, by name, and falls back to current', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd1' });
    const b = await Plots.createBeat({ name: 'Twist', desc: 'd2' });

    const byId = await Plots.getBeat(a._id.toString());
    expect(byId.name).toBe('Open');

    const byOrder = await Plots.getBeat('2');
    expect(byOrder.name).toBe('Twist');

    const byName = await Plots.getBeat('twist');
    expect(byName._id.equals(b._id)).toBe(true);

    const current = await Plots.getBeat();
    expect(current._id.equals(a._id)).toBe(true);
  });

  it('updateBeat patches name/desc/body/order/characters', async () => {
    const a = await Plots.createBeat({
      name: 'Open',
      desc: 'orig desc',
      body: 'orig body',
      characters: ['Alice'],
    });
    const updated = await Plots.updateBeat(a._id.toString(), {
      name: 'Opening Sequence',
      desc: 'rev desc',
      body: 'rev body',
      characters: ['Bob'],
    });
    expect(updated.name).toBe('Opening Sequence');
    expect(updated.desc).toBe('rev desc');
    expect(updated.body).toBe('rev body');
    expect(updated.characters).toEqual(['Bob']);
  });

  it('appendBeatBody adds to existing body with a blank-line separator', async () => {
    const a = await Plots.createBeat({ name: 'B', desc: 'd', body: 'first paragraph' });
    const updated = await Plots.appendBeatBody(a._id.toString(), 'second paragraph');
    expect(updated.body).toBe('first paragraph\n\nsecond paragraph');
  });

  it('appendBeatBody on empty body has no leading separator', async () => {
    const a = await Plots.createBeat({ name: 'B', desc: 'd' });
    const updated = await Plots.appendBeatBody(a._id.toString(), 'first content');
    expect(updated.body).toBe('first content');
  });

  it('appendBeatBody throws on empty content', async () => {
    const a = await Plots.createBeat({ name: 'B', desc: 'd' });
    await expect(Plots.appendBeatBody(a._id.toString(), '   ')).rejects.toThrow(/content/);
  });

  it('searchBeats finds matches across name, desc, and body, ranked by field', async () => {
    const a = await Plots.createBeat({ name: 'Diner Scene', desc: 'morning at the diner' });
    const b = await Plots.createBeat({ name: 'Roadhouse', desc: 'they reach the diner outskirts' });
    const c = await Plots.createBeat({ name: 'Climax', desc: 'final confrontation', body: 'they end up back at the diner' });

    const results = await Plots.searchBeats('diner');
    expect(results).toHaveLength(3);
    expect(results[0].beat._id.equals(a._id)).toBe(true);
    expect(results[0].matched_field).toBe('name');
    expect(results[1].beat._id.equals(b._id)).toBe(true);
    expect(results[1].matched_field).toBe('desc');
    expect(results[2].beat._id.equals(c._id)).toBe(true);
    expect(results[2].matched_field).toBe('body');
  });

  it('searchBeats returns empty array for blank query', async () => {
    await Plots.createBeat({ name: 'X', desc: 'Y' });
    expect(await Plots.searchBeats('')).toEqual([]);
    expect(await Plots.searchBeats('   ')).toEqual([]);
  });

  it('deleteBeat removes the beat, returns name, and clears current_beat_id when it pointed there', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const res = await Plots.deleteBeat(a._id.toString());
    expect(res._id.equals(a._id)).toBe(true);
    expect(res.name).toBe('Open');

    const plot = await Plots.getPlot();
    expect(plot.beats).toHaveLength(0);
    expect(plot.current_beat_id).toBe(null);
  });

  it('linkCharacterToBeat is idempotent (no duplicates)', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd' });
    await Plots.linkCharacterToBeat(a._id.toString(), 'Alice');
    await Plots.linkCharacterToBeat(a._id.toString(), 'alice');
    const beat = await Plots.getBeat(a._id.toString());
    expect(beat.characters).toEqual(['Alice']);
  });

  it('unlinkCharacterFromBeat removes case-insensitively', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd', characters: ['Alice', 'Bob'] });
    await Plots.unlinkCharacterFromBeat(a._id.toString(), 'alice');
    const beat = await Plots.getBeat(a._id.toString());
    expect(beat.characters).toEqual(['Bob']);
  });
});

describe('beat images', () => {
  function fakeMeta(suffix = '') {
    return {
      _id: new ObjectId(),
      filename: `f${suffix}.png`,
      content_type: 'image/png',
      size: 100,
      source: 'upload',
      caption: null,
      uploaded_at: new Date(),
    };
  }

  it('pushBeatImage appends and auto-promotes the first image to main', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const m1 = fakeMeta('1');
    const { is_main } = await Plots.pushBeatImage(a._id.toString(), m1);
    expect(is_main).toBe(true);

    const beat = await Plots.getBeat(a._id.toString());
    expect(beat.images).toHaveLength(1);
    expect(beat.main_image_id.equals(m1._id)).toBe(true);
  });

  it('pushBeatImage with set_as_main:true overrides existing main', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const m1 = fakeMeta('1');
    const m2 = fakeMeta('2');
    await Plots.pushBeatImage(a._id.toString(), m1);
    const { is_main } = await Plots.pushBeatImage(a._id.toString(), m2, true);
    expect(is_main).toBe(true);

    const beat = await Plots.getBeat(a._id.toString());
    expect(beat.images).toHaveLength(2);
    expect(beat.main_image_id.equals(m2._id)).toBe(true);
  });

  it('pullBeatImage promotes the next remaining image when removing main', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const m1 = fakeMeta('1');
    const m2 = fakeMeta('2');
    await Plots.pushBeatImage(a._id.toString(), m1);
    await Plots.pushBeatImage(a._id.toString(), m2);
    await Plots.pullBeatImage(a._id.toString(), m1._id);

    const beat = await Plots.getBeat(a._id.toString());
    expect(beat.images).toHaveLength(1);
    expect(beat.main_image_id.equals(m2._id)).toBe(true);
  });

  it('setBeatMainImage requires the image to be attached', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const stranger = new ObjectId();
    await expect(Plots.setBeatMainImage(a._id.toString(), stranger)).rejects.toThrow(/not attached/);
  });
});

describe('current beat lifecycle', () => {
  it('setCurrentBeat / getCurrentBeat / clearCurrentBeat round-trip', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const b = await Plots.createBeat({ name: 'Climax', desc: 'd' });

    await Plots.setCurrentBeat(b._id.toString());
    const cur = await Plots.getCurrentBeat();
    expect(cur._id.equals(b._id)).toBe(true);

    await Plots.clearCurrentBeat();
    expect(await Plots.getCurrentBeat()).toBeNull();
  });
});

describe('per-beat timestamps', () => {
  it('createBeat stamps created_at and updated_at', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'd' });
    expect(beat.created_at).toBeInstanceOf(Date);
    expect(beat.updated_at).toBeInstanceOf(Date);
    expect(beat.created_at.getTime()).toBe(beat.updated_at.getTime());
  });

  it('updateBeat advances updated_at without changing created_at', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const originalCreated = beat.created_at.getTime();
    const originalUpdated = beat.updated_at.getTime();
    // Force a clock tick (Date resolution is 1ms; some platforms may need a nudge).
    await new Promise((r) => setTimeout(r, 2));
    const updated = await Plots.updateBeat(beat._id.toString(), { desc: 'd2' });
    expect(updated.created_at.getTime()).toBe(originalCreated);
    expect(updated.updated_at.getTime()).toBeGreaterThan(originalUpdated);
  });

  it('appendBeatBody advances updated_at', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const originalUpdated = beat.updated_at.getTime();
    await new Promise((r) => setTimeout(r, 2));
    const updated = await Plots.appendBeatBody(beat._id.toString(), 'more lore');
    expect(updated.updated_at.getTime()).toBeGreaterThan(originalUpdated);
  });

  it('linkCharacterToBeat (via updateBeat) advances updated_at', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'd' });
    const originalUpdated = beat.updated_at.getTime();
    await new Promise((r) => setTimeout(r, 2));
    await Plots.linkCharacterToBeat(beat._id.toString(), 'Alice');
    const after = await Plots.getBeat(beat._id.toString());
    expect(after.updated_at.getTime()).toBeGreaterThan(originalUpdated);
  });
});

describe('disambiguation by explicit identifier (scenario D, T4 regression)', () => {
  it('appendBeatBody with explicit beat id only mutates that beat', async () => {
    // Two beats, both featuring Nully — like "Nully despawns the base" and
    // "the wipe where the kid shot Nully". Must not cross-contaminate when
    // the user adds lore to one of them.
    const despawn = await Plots.createBeat({
      name: 'Nully Despawns Base',
      desc: 'The time Nully despawned the base.',
      characters: ['Nully'],
    });
    const shooting = await Plots.createBeat({
      name: 'Kid Shoots Nully',
      desc: 'The wipe where a streamer kid shot Nully.',
      characters: ['Nully', 'Streamer Kid'],
    });

    await Plots.appendBeatBody(despawn._id.toString(), 'He forgot to fill the cupboard.');

    const despawnAfter = await Plots.getBeat(despawn._id.toString());
    const shootingAfter = await Plots.getBeat(shooting._id.toString());
    expect(despawnAfter.body).toBe('He forgot to fill the cupboard.');
    expect(shootingAfter.body).toBe('');
  });
});

describe('legacy beat backfill', () => {
  it('assigns _id and image fields to beats missing them on next read', async () => {
    const legacyPlot = {
      _id: 'main',
      synopsis: 's',
      notes: '',
      beats: [
        { order: 1, title: 'Open', description: 'd', characters: ['Alice'] },
      ],
      updated_at: new Date(),
    };
    await fakeDb.collection('plots').insertOne(legacyPlot);

    const plot = await Plots.getPlot();
    expect(plot.beats[0]._id).toBeInstanceOf(ObjectId);
    expect(plot.beats[0].images).toEqual([]);
    expect(plot.beats[0].main_image_id).toBe(null);
    expect(plot.beats[0].created_at).toBeInstanceOf(Date);
    expect(plot.beats[0].updated_at).toBeInstanceOf(Date);
    expect(plot.current_beat_id).toBe(null);
  });

  it('migrates legacy title→name and description→body, defaults desc to empty', async () => {
    const legacyPlot = {
      _id: 'main',
      synopsis: '',
      notes: '',
      beats: [
        { order: 1, title: 'Old Title', description: 'Old description prose.', characters: [] },
      ],
      updated_at: new Date(),
    };
    await fakeDb.collection('plots').insertOne(legacyPlot);

    const plot = await Plots.getPlot();
    expect(plot.beats[0].name).toBe('Old Title');
    expect(plot.beats[0].body).toBe('Old description prose.');
    expect(plot.beats[0].desc).toBe('');
    expect(plot.beats[0].title).toBeUndefined();
    expect(plot.beats[0].description).toBeUndefined();
  });
});

describe('updateBeat input validation', () => {
  it('throws when patch is a string (the model-passed-body-as-patch bug)', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'Opening' });
    await expect(
      Plots.updateBeat(beat._id.toString(), 'a 10000 char body that should have been wrapped'),
    ).rejects.toThrow(/must be an object/);
  });

  it('throws when patch is an array', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'Opening' });
    await expect(Plots.updateBeat(beat._id.toString(), ['name', 'New'])).rejects.toThrow(
      /must be an object.*array/,
    );
  });

  it('throws when patch is null', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'Opening' });
    await expect(Plots.updateBeat(beat._id.toString(), null)).rejects.toThrow(/must be an object/);
  });

  it('throws when patch has no recognized fields', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'Opening' });
    await expect(Plots.updateBeat(beat._id.toString(), { foo: 'bar' })).rejects.toThrow(
      /no recognized fields/,
    );
  });

  it('valid patch.body still updates end-to-end', async () => {
    const beat = await Plots.createBeat({ name: 'Open', desc: 'Opening' });
    const newBody = 'A long body content that should actually persist.';
    const updated = await Plots.updateBeat(beat._id.toString(), { body: newBody });
    expect(updated.body).toBe(newBody);
    const reread = await Plots.getBeat(beat._id.toString());
    expect(reread.body).toBe(newBody);
  });

  it('persistBeats throws when the plot doc is missing', async () => {
    // Arrange: simulate a torn-down plot by spying on updateOne to return matchedCount=0,
    // since the fake mongo always re-seeds via getPlot before reaching persistBeats.
    const beat = await Plots.createBeat({ name: 'Open', desc: 'Opening' });
    const col = fakeDb.collection('plots');
    const original = col.updateOne.bind(col);
    const spy = vi.spyOn(col, 'updateOne').mockResolvedValue({ matchedCount: 0 });
    try {
      await expect(
        Plots.updateBeat(beat._id.toString(), { body: 'new body' }),
      ).rejects.toThrow(/persistBeats: plot doc.*not found/);
    } finally {
      spy.mockRestore();
      // Ensure the mock cleanup left the collection method intact.
      col.updateOne = original;
    }
  });
});
