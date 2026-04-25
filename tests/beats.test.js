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
    const a = await Plots.createBeat({ title: 'Open' });
    const b = await Plots.createBeat({ title: 'Inciting incident' });

    expect(a._id).toBeInstanceOf(ObjectId);
    expect(a.order).toBe(1);
    expect(b.order).toBe(2);

    const plot = await Plots.getPlot();
    expect(plot.beats).toHaveLength(2);
    expect(plot.current_beat_id.equals(a._id)).toBe(true);
  });

  it('createBeat dedupes characters case-insensitively', async () => {
    const beat = await Plots.createBeat({
      title: 'Diner',
      characters: ['Alice', 'alice', 'Bob'],
    });
    expect(beat.characters).toEqual(['Alice', 'Bob']);
  });

  it('getBeat resolves by _id, by order string, by title, and falls back to current', async () => {
    const a = await Plots.createBeat({ title: 'Open' });
    const b = await Plots.createBeat({ title: 'Twist' });

    const byId = await Plots.getBeat(a._id.toString());
    expect(byId.title).toBe('Open');

    const byOrder = await Plots.getBeat('2');
    expect(byOrder.title).toBe('Twist');

    const byTitle = await Plots.getBeat('twist');
    expect(byTitle._id.equals(b._id)).toBe(true);

    const current = await Plots.getBeat();
    expect(current._id.equals(a._id)).toBe(true);
  });

  it('updateBeat patches title/description/order/characters', async () => {
    const a = await Plots.createBeat({ title: 'Open', description: 'orig', characters: ['Alice'] });
    const updated = await Plots.updateBeat(a._id.toString(), {
      title: 'Opening Sequence',
      description: 'rev',
      characters: ['Bob'],
    });
    expect(updated.title).toBe('Opening Sequence');
    expect(updated.description).toBe('rev');
    expect(updated.characters).toEqual(['Bob']);
  });

  it('deleteBeat removes the beat and clears current_beat_id when it pointed there', async () => {
    const a = await Plots.createBeat({ title: 'Open' });
    const res = await Plots.deleteBeat(a._id.toString());
    expect(res._id.equals(a._id)).toBe(true);

    const plot = await Plots.getPlot();
    expect(plot.beats).toHaveLength(0);
    expect(plot.current_beat_id).toBe(null);
  });

  it('linkCharacterToBeat is idempotent (no duplicates)', async () => {
    const a = await Plots.createBeat({ title: 'Open' });
    await Plots.linkCharacterToBeat(a._id.toString(), 'Alice');
    await Plots.linkCharacterToBeat(a._id.toString(), 'alice');
    const beat = await Plots.getBeat(a._id.toString());
    expect(beat.characters).toEqual(['Alice']);
  });

  it('unlinkCharacterFromBeat removes case-insensitively', async () => {
    const a = await Plots.createBeat({ title: 'Open', characters: ['Alice', 'Bob'] });
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
    const a = await Plots.createBeat({ title: 'Open' });
    const m1 = fakeMeta('1');
    const { is_main } = await Plots.pushBeatImage(a._id.toString(), m1);
    expect(is_main).toBe(true);

    const beat = await Plots.getBeat(a._id.toString());
    expect(beat.images).toHaveLength(1);
    expect(beat.main_image_id.equals(m1._id)).toBe(true);
  });

  it('pushBeatImage with set_as_main:true overrides existing main', async () => {
    const a = await Plots.createBeat({ title: 'Open' });
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
    const a = await Plots.createBeat({ title: 'Open' });
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
    const a = await Plots.createBeat({ title: 'Open' });
    const stranger = new ObjectId();
    await expect(Plots.setBeatMainImage(a._id.toString(), stranger)).rejects.toThrow(/not attached/);
  });
});

describe('current beat lifecycle', () => {
  it('setCurrentBeat / getCurrentBeat / clearCurrentBeat round-trip', async () => {
    const a = await Plots.createBeat({ title: 'Open' });
    const b = await Plots.createBeat({ title: 'Climax' });

    await Plots.setCurrentBeat(b._id.toString());
    const cur = await Plots.getCurrentBeat();
    expect(cur._id.equals(b._id)).toBe(true);

    await Plots.clearCurrentBeat();
    expect(await Plots.getCurrentBeat()).toBeNull();
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
    expect(plot.current_beat_id).toBe(null);
  });
});
