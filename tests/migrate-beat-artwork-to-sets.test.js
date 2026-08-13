// One-shot migration: beat artwork/images/attachments → per-beat sets.
// Idempotent; enumerates GridFS ids strictly from the beat arrays so
// storyboard frame renders (beat-owned but never in the arrays) stay put.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
  closeMongo: async () => {},
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Sets = await import('../src/mongo/sets.js');
const { migrateBeatArtworkToSets } = await import('../scripts/migrate-beat-artwork-to-sets.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Alpha'))._id.toString();
});

function gridfsImage(ownerId, extra = {}) {
  const _id = new ObjectId();
  fakeDb.collection('images.files')._docs.push({
    _id,
    filename: `${_id}.png`,
    length: 5,
    uploadDate: new Date(),
    metadata: { project_id: projectId, owner_type: 'beat', owner_id: ownerId, ...extra },
  });
  return _id;
}

function gridfsAttachment(ownerId) {
  const _id = new ObjectId();
  fakeDb.collection('attachments.files')._docs.push({
    _id,
    filename: `${_id}.pdf`,
    length: 5,
    uploadDate: new Date(),
    metadata: { project_id: projectId, owner_type: 'beat', owner_id: ownerId },
  });
  return _id;
}

async function seedBeatWithMedia({ location = 'Kitchen', name = 'B1' } = {}) {
  const beat = await Plots.createBeat({ projectId, name, desc: 'd', body: 'b' });
  const img = gridfsImage(beat._id);
  const att = gridfsAttachment(beat._id);
  const artResult = gridfsImage(beat._id);
  await fakeDb.collection('plots').updateOne(
    { project_id: projectId, 'beats._id': beat._id },
    {
      $set: {
        'beats.$.images': [{ _id: img, filename: 'ref.png' }],
        'beats.$.main_image_id': img,
        'beats.$.attachments': [{ _id: att, filename: 'plan.pdf' }],
        'beats.$.artworks': [{
          _id: new ObjectId(),
          status: 'done',
          result_image_id: artResult,
          previous_result_image_id: null,
          reference_image_ids: [new ObjectId()],
          name: 'plate',
          prompt: 'a plate',
        }],
        ...(location ? { 'beats.$.scene_bible': { location } } : {}),
      },
    },
  );
  return { beat, img, att, artResult };
}

describe('migrateBeatArtworkToSets', () => {
  it('moves media into a set named from scene_bible.location and clears the beat', async () => {
    const { beat, img, att, artResult } = await seedBeatWithMedia();
    // A storyboard frame render: beat-owned GridFS file NOT in any array.
    const frameRender = gridfsImage(beat._id, { }); // stays beat-owned

    const stats = await migrateBeatArtworkToSets();
    expect(stats.sets_created).toBe(1);
    expect(stats.beats_cleared).toBe(1);

    const set = await Sets.getSet(projectId, 'Kitchen');
    expect(set).toBeTruthy();
    expect(set.images.map((i) => String(i._id))).toEqual([img.toString()]);
    expect(String(set.main_image_id)).toBe(img.toString());
    expect(set.attachments.map((a) => String(a._id))).toEqual([att.toString()]);
    expect(set.artworks).toHaveLength(1);
    expect(set.migrated_from_beat_ids.map(String)).toContain(beat._id.toString());

    // GridFS restamped for gallery + artwork result images…
    for (const id of [img, artResult]) {
      const f = await fakeDb.collection('images.files').findOne({ _id: id });
      expect(f.metadata.owner_type).toBe('set');
      expect(String(f.metadata.owner_id)).toBe(String(set._id));
    }
    const fa = await fakeDb.collection('attachments.files').findOne({ _id: att });
    expect(fa.metadata.owner_type).toBe('set');
    // …but the frame render stays beat-owned.
    const fr = await fakeDb.collection('images.files').findOne({ _id: frameRender });
    expect(fr.metadata.owner_type).toBe('beat');

    // Beat cleared and linked.
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.images).toEqual([]);
    expect(fresh.main_image_id).toBe(null);
    expect(fresh.attachments).toEqual([]);
    expect(fresh.artworks).toEqual([]);
    expect(fresh.sets).toEqual(['Kitchen']);
  });

  it('is idempotent — a second run reports zero deltas', async () => {
    await seedBeatWithMedia();
    await migrateBeatArtworkToSets();
    const second = await migrateBeatArtworkToSets();
    expect(second.sets_created).toBe(0);
    expect(second.sets_merged).toBe(0);
    expect(second.beats_cleared).toBe(0);
    expect(second.images_moved).toBe(0);
    const sets = await Sets.listSets(projectId);
    expect(sets).toHaveLength(1);
  });

  it('merges two beats sharing a location into one set', async () => {
    const a = await seedBeatWithMedia({ location: 'Kitchen', name: 'B1' });
    const b = await seedBeatWithMedia({ location: '**kitchen**', name: 'B2' });
    const stats = await migrateBeatArtworkToSets();
    expect(stats.sets_created).toBe(1);
    expect(stats.sets_merged).toBe(1);
    const sets = await Sets.listSets(projectId);
    expect(sets).toHaveLength(1);
    const set = await Sets.getSet(projectId, 'kitchen');
    expect(set.images).toHaveLength(2);
    // Main image comes from the first beat only; the merge never overwrites it.
    expect(String(set.main_image_id)).toBe(String(a.img));
    expect(set.migrated_from_beat_ids.map(String)).toEqual(
      expect.arrayContaining([a.beat._id.toString(), b.beat._id.toString()]),
    );
  });

  it('falls back to the beat name (then "Beat N") when there is no location', async () => {
    await seedBeatWithMedia({ location: null, name: 'The Rooftop' });
    await migrateBeatArtworkToSets();
    expect(await Sets.getSet(projectId, 'The Rooftop')).toBeTruthy();
  });

  it('migrates beats that only have reference images (no artwork)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'RefsOnly', desc: 'd' });
    const img = gridfsImage(beat._id);
    await fakeDb.collection('plots').updateOne(
      { project_id: projectId, 'beats._id': beat._id },
      { $set: { 'beats.$.images': [{ _id: img, filename: 'r.png' }], 'beats.$.main_image_id': img } },
    );
    const stats = await migrateBeatArtworkToSets();
    expect(stats.sets_created).toBe(1);
    const set = await Sets.getSet(projectId, 'RefsOnly');
    expect(set.images).toHaveLength(1);
    expect((await Plots.getBeat(projectId, beat._id.toString())).images).toEqual([]);
  });

  it('skips beats with no media entirely', async () => {
    await Plots.createBeat({ projectId, name: 'Empty', desc: 'd' });
    const stats = await migrateBeatArtworkToSets();
    expect(stats.sets_created).toBe(0);
    expect(stats.beats_cleared).toBe(0);
    expect(await Sets.listSets(projectId)).toHaveLength(0);
  });
});
