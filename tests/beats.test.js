import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Projects = await import('../src/mongo/projects.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('plots beat CRUD', () => {
  it('seeds a plot on first read with all expected fields', async () => {
    const plot = await Plots.getPlot(projectId);
    const def = await Projects.getDefaultProject();
    expect(plot.project_id).toBe(def._id.toString());
    expect(plot.synopsis).toBe('');
    expect(plot.notes).toBe('');
    expect(plot.beats).toEqual([]);
    expect(plot.current_beat_id).toBe(null);
  });

  it('createBeat assigns an _id, increments order, and auto-sets current beat', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'Opening scene' });
    const b = await Plots.createBeat({ projectId, name: 'Inciting', desc: 'Inciting incident' });

    expect(a._id).toBeInstanceOf(ObjectId);
    expect(a.order).toBe(1);
    expect(b.order).toBe(2);

    const plot = await Plots.getPlot(projectId);
    expect(plot.beats).toHaveLength(2);
    expect(plot.current_beat_id.equals(a._id)).toBe(true);
  });

  it('createBeat stores name, desc, and body separately; body defaults to empty', async () => {
    const beat = await Plots.createBeat({ projectId,
      name: 'Diner Argument',
      desc: 'Alice and Bob argue at the diner.',
    });
    expect(beat.name).toBe('Diner Argument');
    expect(beat.desc).toBe('Alice and Bob argue at the diner.');
    expect(beat.body).toBe('');
  });

  it('createBeat derives name from desc when name is omitted', async () => {
    const beat = await Plots.createBeat({ projectId,
      desc: 'The time when Alice told Bob she was leaving for good.',
    });
    expect(beat.name).toBe('The time when Alice told Bob');
    expect(beat.desc).toBe('The time when Alice told Bob she was leaving for good.');
  });

  it('createBeat without desc or name throws', async () => {
    await expect(Plots.createBeat({ projectId,})).rejects.toThrow(/desc/);
  });

  it('createBeat dedupes characters case-insensitively', async () => {
    const beat = await Plots.createBeat({ projectId,
      name: 'Diner',
      desc: 'A diner scene.',
      characters: ['Alice', 'alice', 'Bob'],
    });
    expect(beat.characters).toEqual(['Alice', 'Bob']);
  });

  it('getBeat resolves by _id, by order string, by name, and falls back to current', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd1' });
    const b = await Plots.createBeat({ projectId, name: 'Twist', desc: 'd2' });

    const byId = await Plots.getBeat(projectId, a._id.toString());
    expect(byId.name).toBe('Open');

    const byOrder = await Plots.getBeat(projectId, '2');
    expect(byOrder.name).toBe('Twist');

    const byName = await Plots.getBeat(projectId, 'twist');
    expect(byName._id.equals(b._id)).toBe(true);

    const current = await Plots.getBeat(projectId);
    expect(current._id.equals(a._id)).toBe(true);
  });

  it('updateBeat patches name/desc/body/order/characters', async () => {
    const a = await Plots.createBeat({ projectId,
      name: 'Open',
      desc: 'orig desc',
      body: 'orig body',
      characters: ['Alice'],
    });
    const updated = await Plots.updateBeat(projectId, a._id.toString(), {
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
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'first paragraph' });
    const updated = await Plots.appendBeatBody(projectId, a._id.toString(), 'second paragraph');
    expect(updated.body).toBe('first paragraph\n\nsecond paragraph');
  });

  it('appendBeatBody on empty body has no leading separator', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd' });
    const updated = await Plots.appendBeatBody(projectId, a._id.toString(), 'first content');
    expect(updated.body).toBe('first content');
  });

  it('appendBeatBody throws on empty content', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd' });
    await expect(Plots.appendBeatBody(projectId, a._id.toString(), '   ')).rejects.toThrow(/content/);
  });

  it('setBeatBody replaces the body and preserves other fields', async () => {
    const a = await Plots.createBeat({ projectId,
      name: 'B', desc: 'd', body: 'old body', characters: ['Alice'],
    });
    const updated = await Plots.setBeatBody(projectId, a._id.toString(), 'brand new body\n\nwith a second paragraph');
    expect(updated.body).toBe('brand new body\n\nwith a second paragraph');
    expect(updated.name).toBe('B');
    expect(updated.desc).toBe('d');
    expect(updated.characters).toEqual(['Alice']);
  });

  it('setBeatBody accepts an empty string (clears the body)', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'something' });
    const updated = await Plots.setBeatBody(projectId, a._id.toString(), '');
    expect(updated.body).toBe('');
  });

  it('setBeatBody rejects non-string body', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd' });
    await expect(Plots.setBeatBody(projectId, a._id.toString(), 123)).rejects.toThrow(/`body` must be a string/);
    await expect(Plots.setBeatBody(projectId, a._id.toString(), null)).rejects.toThrow(/`body` must be a string/);
    await expect(Plots.setBeatBody(projectId, a._id.toString(), { body: 'oops' })).rejects.toThrow(/`body` must be a string/);
  });

  it('setBeatBody throws when the beat is not found', async () => {
    await expect(Plots.setBeatBody(projectId, 'nonexistent-beat', 'x')).rejects.toThrow(/Beat not found/);
  });

  it('editBeatBody applies a single find/replace', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'Keys says "hello" to Bob.' });
    const result = await Plots.editBeatBody(projectId, a._id.toString(), [
      { find: '"hello"', replace: '"good morning"' },
    ]);
    expect(result.beat.body).toBe('Keys says "good morning" to Bob.');
    expect(result.beforeLen).toBe(25);
    expect(result.afterLen).toBe(32);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toEqual({ find_chars: 7, replace_chars: 14, delta: 7 });
  });

  it('editBeatBody applies multiple edits sequentially (each operates on the result of the previous)', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'one two three' });
    const result = await Plots.editBeatBody(projectId, a._id.toString(), [
      { find: 'one', replace: 'ONE' },
      { find: 'three', replace: 'THREE' },
    ]);
    expect(result.beat.body).toBe('ONE two THREE');
    expect(result.edits).toHaveLength(2);
  });

  it('editBeatBody supports cascading edits where edit N depends on edit N-1', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'alpha bravo charlie' });
    const result = await Plots.editBeatBody(projectId, a._id.toString(), [
      { find: 'bravo', replace: 'beta' },
      { find: 'beta', replace: 'BETA' },
    ]);
    expect(result.beat.body).toBe('alpha BETA charlie');
  });

  it('editBeatBody supports deletion via empty replace', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'keep this. DELETE ME. keep this too.' });
    const result = await Plots.editBeatBody(projectId, a._id.toString(), [
      { find: ' DELETE ME.', replace: '' },
    ]);
    expect(result.beat.body).toBe('keep this. keep this too.');
    expect(result.edits[0].delta).toBe(-11);
  });

  it('editBeatBody throws when find text is not present in the body', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'hello world' });
    await expect(
      Plots.editBeatBody(projectId, a._id.toString(), [{ find: 'banana', replace: 'apple' }]),
    ).rejects.toThrow(/not found.*banana/);
  });

  it('editBeatBody throws when find text matches more than once (forces uniqueness)', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'one one one' });
    await expect(
      Plots.editBeatBody(projectId, a._id.toString(), [{ find: 'one', replace: 'two' }]),
    ).rejects.toThrow(/matched 3 places.*must be unique/);
  });

  it('editBeatBody rejects an empty find string with guidance toward the dedicated tools', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'something' });
    await expect(
      Plots.editBeatBody(projectId, a._id.toString(), [{ find: '', replace: 'x' }]),
    ).rejects.toThrow(/empty `find`/);
  });

  it('editBeatBody rejects non-array edits', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd' });
    await expect(Plots.editBeatBody(projectId, a._id.toString(), null)).rejects.toThrow(/non-empty array/);
    await expect(Plots.editBeatBody(projectId, a._id.toString(), [])).rejects.toThrow(/non-empty array/);
    await expect(Plots.editBeatBody(projectId, a._id.toString(), 'find/replace')).rejects.toThrow(/non-empty array/);
  });

  it('editBeatBody rejects an edit missing find/replace strings', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'x' });
    await expect(
      Plots.editBeatBody(projectId, a._id.toString(), [{ find: 'x' }]),
    ).rejects.toThrow(/string `find` and `replace`/);
    await expect(
      Plots.editBeatBody(projectId, a._id.toString(), [{ find: 1, replace: 'y' }]),
    ).rejects.toThrow(/string `find` and `replace`/);
  });

  it('editBeatBody is atomic: a failing edit late in the list does NOT persist earlier edits', async () => {
    const a = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'alpha bravo' });
    await expect(
      Plots.editBeatBody(projectId, a._id.toString(), [
        { find: 'alpha', replace: 'ALPHA' },
        { find: 'nonexistent', replace: 'X' },
      ]),
    ).rejects.toThrow(/not found/);
    const fresh = await Plots.getBeat(projectId, a._id.toString());
    expect(fresh.body).toBe('alpha bravo'); // unchanged
  });

  it('searchBeats finds matches across name, desc, and body, ranked by field', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Diner Scene', desc: 'morning at the diner' });
    const b = await Plots.createBeat({ projectId, name: 'Roadhouse', desc: 'they reach the diner outskirts' });
    const c = await Plots.createBeat({ projectId, name: 'Climax', desc: 'final confrontation', body: 'they end up back at the diner' });

    const results = await Plots.searchBeats(projectId, 'diner');
    expect(results).toHaveLength(3);
    expect(results[0].beat._id.equals(a._id)).toBe(true);
    expect(results[0].matched_field).toBe('name');
    expect(results[1].beat._id.equals(b._id)).toBe(true);
    expect(results[1].matched_field).toBe('desc');
    expect(results[2].beat._id.equals(c._id)).toBe(true);
    expect(results[2].matched_field).toBe('body');
  });

  it('searchBeats returns empty array for blank query', async () => {
    await Plots.createBeat({ projectId, name: 'X', desc: 'Y' });
    expect(await Plots.searchBeats(projectId, '')).toEqual([]);
    expect(await Plots.searchBeats(projectId, '   ')).toEqual([]);
  });

  it('deleteBeat removes the beat, returns name, and clears current_beat_id when it pointed there', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const res = await Plots.deleteBeat(projectId, a._id.toString());
    expect(res._id.equals(a._id)).toBe(true);
    expect(res.name).toBe('Open');

    const plot = await Plots.getPlot(projectId);
    expect(plot.beats).toHaveLength(0);
    expect(plot.current_beat_id).toBe(null);
  });

  it('linkCharacterToBeat is idempotent (no duplicates)', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    await Plots.linkCharacterToBeat(projectId, a._id.toString(), 'Alice');
    await Plots.linkCharacterToBeat(projectId, a._id.toString(), 'alice');
    const beat = await Plots.getBeat(projectId, a._id.toString());
    expect(beat.characters).toEqual(['Alice']);
  });

  it('unlinkCharacterFromBeat removes case-insensitively', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd', characters: ['Alice', 'Bob'] });
    await Plots.unlinkCharacterFromBeat(projectId, a._id.toString(), 'alice');
    const beat = await Plots.getBeat(projectId, a._id.toString());
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
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const m1 = fakeMeta('1');
    const { is_main } = await Plots.pushBeatImage(projectId, a._id.toString(), m1);
    expect(is_main).toBe(true);

    const beat = await Plots.getBeat(projectId, a._id.toString());
    expect(beat.images).toHaveLength(1);
    expect(beat.main_image_id.equals(m1._id)).toBe(true);
  });

  it('pushBeatImage with set_as_main:true overrides existing main', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const m1 = fakeMeta('1');
    const m2 = fakeMeta('2');
    await Plots.pushBeatImage(projectId, a._id.toString(), m1);
    const { is_main } = await Plots.pushBeatImage(projectId, a._id.toString(), m2, true);
    expect(is_main).toBe(true);

    const beat = await Plots.getBeat(projectId, a._id.toString());
    expect(beat.images).toHaveLength(2);
    expect(beat.main_image_id.equals(m2._id)).toBe(true);
  });

  it('pullBeatImage promotes the next remaining image when removing main', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const m1 = fakeMeta('1');
    const m2 = fakeMeta('2');
    await Plots.pushBeatImage(projectId, a._id.toString(), m1);
    await Plots.pushBeatImage(projectId, a._id.toString(), m2);
    await Plots.pullBeatImage(projectId, a._id.toString(), m1._id);

    const beat = await Plots.getBeat(projectId, a._id.toString());
    expect(beat.images).toHaveLength(1);
    expect(beat.main_image_id.equals(m2._id)).toBe(true);
  });

  it('setBeatMainImage requires the image to be attached', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const stranger = new ObjectId();
    await expect(Plots.setBeatMainImage(projectId, a._id.toString(), stranger)).rejects.toThrow(/not attached/);
  });
});

describe('current beat lifecycle', () => {
  it('setCurrentBeat / getCurrentBeat / clearCurrentBeat round-trip', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const b = await Plots.createBeat({ projectId, name: 'Climax', desc: 'd' });

    await Plots.setCurrentBeat(projectId, b._id.toString());
    const cur = await Plots.getCurrentBeat(projectId);
    expect(cur._id.equals(b._id)).toBe(true);

    await Plots.clearCurrentBeat(projectId);
    expect(await Plots.getCurrentBeat(projectId)).toBeNull();
  });
});

describe('per-beat timestamps', () => {
  it('createBeat stamps created_at and updated_at', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    expect(beat.created_at).toBeInstanceOf(Date);
    expect(beat.updated_at).toBeInstanceOf(Date);
    expect(beat.created_at.getTime()).toBe(beat.updated_at.getTime());
  });

  it('updateBeat advances updated_at without changing created_at', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const originalCreated = beat.created_at.getTime();
    const originalUpdated = beat.updated_at.getTime();
    // Force a clock tick (Date resolution is 1ms; some platforms may need a nudge).
    await new Promise((r) => setTimeout(r, 2));
    const updated = await Plots.updateBeat(projectId, beat._id.toString(), { desc: 'd2' });
    expect(updated.created_at.getTime()).toBe(originalCreated);
    expect(updated.updated_at.getTime()).toBeGreaterThan(originalUpdated);
  });

  it('appendBeatBody advances updated_at', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const originalUpdated = beat.updated_at.getTime();
    await new Promise((r) => setTimeout(r, 2));
    const updated = await Plots.appendBeatBody(projectId, beat._id.toString(), 'more lore');
    expect(updated.updated_at.getTime()).toBeGreaterThan(originalUpdated);
  });

  it('linkCharacterToBeat (via updateBeat) advances updated_at', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'd' });
    const originalUpdated = beat.updated_at.getTime();
    await new Promise((r) => setTimeout(r, 2));
    await Plots.linkCharacterToBeat(projectId, beat._id.toString(), 'Alice');
    const after = await Plots.getBeat(projectId, beat._id.toString());
    expect(after.updated_at.getTime()).toBeGreaterThan(originalUpdated);
  });
});

describe('disambiguation by explicit identifier (scenario D, T4 regression)', () => {
  it('appendBeatBody with explicit beat id only mutates that beat', async () => {
    // Two beats, both featuring Nully — like "Nully despawns the base" and
    // "the wipe where the kid shot Nully". Must not cross-contaminate when
    // the user adds lore to one of them.
    const despawn = await Plots.createBeat({ projectId,
      name: 'Nully Despawns Base',
      desc: 'The time Nully despawned the base.',
      characters: ['Nully'],
    });
    const shooting = await Plots.createBeat({ projectId,
      name: 'Kid Shoots Nully',
      desc: 'The wipe where a streamer kid shot Nully.',
      characters: ['Nully', 'Streamer Kid'],
    });

    await Plots.appendBeatBody(projectId, despawn._id.toString(), 'He forgot to fill the cupboard.');

    const despawnAfter = await Plots.getBeat(projectId, despawn._id.toString());
    const shootingAfter = await Plots.getBeat(projectId, shooting._id.toString());
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

    const plot = await Plots.getPlot(projectId);
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

    const plot = await Plots.getPlot(projectId);
    expect(plot.beats[0].name).toBe('Old Title');
    expect(plot.beats[0].body).toBe('Old description prose.');
    expect(plot.beats[0].desc).toBe('');
    expect(plot.beats[0].title).toBeUndefined();
    expect(plot.beats[0].description).toBeUndefined();
  });
});

describe('updateBeat input validation', () => {
  it('throws when patch is a string (the model-passed-body-as-patch bug)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'Opening' });
    await expect(
      Plots.updateBeat(projectId, beat._id.toString(), 'a 10000 char body that should have been wrapped'),
    ).rejects.toThrow(/must be an object/);
  });

  it('throws when patch is an array', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'Opening' });
    await expect(Plots.updateBeat(projectId, beat._id.toString(), ['name', 'New'])).rejects.toThrow(
      /must be an object.*array/,
    );
  });

  it('throws when patch is null', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'Opening' });
    await expect(Plots.updateBeat(projectId, beat._id.toString(), null)).rejects.toThrow(/must be an object/);
  });

  it('throws when patch has no recognized fields', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'Opening' });
    await expect(Plots.updateBeat(projectId, beat._id.toString(), { foo: 'bar' })).rejects.toThrow(
      /no recognized fields/,
    );
  });

  it('valid patch.body still updates end-to-end', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'Opening' });
    const newBody = 'A long body content that should actually persist.';
    const updated = await Plots.updateBeat(projectId, beat._id.toString(), { body: newBody });
    expect(updated.body).toBe(newBody);
    const reread = await Plots.getBeat(projectId, beat._id.toString());
    expect(reread.body).toBe(newBody);
  });

  it('updateBeat throws when the atomic write does not match', async () => {
    // Arrange: simulate a torn-down plot by spying on updateOne to return matchedCount=0,
    // since the fake mongo always re-seeds via getPlot before reaching the atomic update.
    const beat = await Plots.createBeat({ projectId, name: 'Open', desc: 'Opening' });
    const col = fakeDb.collection('plots');
    const original = col.updateOne.bind(col);
    const spy = vi.spyOn(col, 'updateOne').mockResolvedValue({ matchedCount: 0 });
    try {
      await expect(
        Plots.updateBeat(projectId, beat._id.toString(), { body: 'new body' }),
      ).rejects.toThrow(/updateBeatFields:.*not found in plot doc/);
    } finally {
      spy.mockRestore();
      col.updateOne = original;
    }
  });
});

describe('multi-project plots', () => {
  it('getPlot lazy-claims the legacy {_id:"main"} doc for the default project', async () => {
    await fakeDb.collection('plots').insertOne({
      _id: 'main',
      title: 'Legacy',
      synopsis: 's',
      beats: [],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    });
    const plot = await Plots.getPlot(projectId);
    expect(plot._id).toBe('main'); // claimed, not replaced
    expect(plot.title).toBe('Legacy');
    const def = await Projects.getDefaultProject();
    const stored = await fakeDb.collection('plots').findOne({ _id: 'main' });
    expect(stored.project_id).toBe(def._id.toString());
    expect(fakeDb.collection('plots')._docs).toHaveLength(1); // no second doc
  });

  it('keeps two projects\' plots independent', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const beat = await Plots.createBeat({ projectId: p1, name: 'Open', desc: 'd1' });
    expect(await Plots.listBeats(p1)).toHaveLength(1);
    expect(await Plots.listBeats(p2)).toHaveLength(0);
    // Cross-project id lookup behaves as not-found.
    expect(await Plots.getBeat(p2, beat._id.toString())).toBe(null);
    // Writes land in the right doc.
    await Plots.updatePlot(p2, { synopsis: 'beta synopsis' });
    expect((await Plots.getPlot(p1)).synopsis).toBe('');
    expect((await Plots.getPlot(p2)).synopsis).toBe('beta synopsis');
  });

  it('findPlotByBeatId locates the containing plot across projects', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const beat = await Plots.createBeat({ projectId: p1, name: 'Open', desc: 'd' });
    const host = await Plots.findPlotByBeatId(beat._id.toString());
    expect(host.project_id).toBe(p1);
    expect(await Plots.findPlotByBeatId(new ObjectId().toString())).toBe(null);
  });
});
