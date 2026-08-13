// set:<id> y-doc rooms — name/description fields + owned image/attachment
// fragments, with project resolution through the sets collection (NOT the
// legacy beat fallthrough).
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
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({}));

const { buildRoomName, parseRoomName, resolveRoom, projectIdForRoom } =
  await import('../src/web/roomRegistry.js');
const Sets = await import('../src/mongo/sets.js');
const Projects = await import('../src/mongo/projects.js');

let p1;

beforeEach(async () => {
  fakeDb.reset();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
});

describe('set rooms', () => {
  it('parseRoomName/buildRoomName handle set:<hex>', () => {
    const id = new ObjectId().toString();
    expect(buildRoomName('set', id)).toBe(`set:${id}`);
    expect(parseRoomName(`set:${id}`)).toEqual({ type: 'set', id });
    expect(parseRoomName('set:not-hex')).toBeNull();
  });

  it('projectIdForRoom resolves through the sets collection, not the beat fallthrough', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    expect(await projectIdForRoom(`set:${s._id.toString()}`)).toBe(p1);
    // Unknown set id must be null — if the beat fallthrough handled it,
    // assertRoomAccess would resolve through the plots collection instead.
    expect(await projectIdForRoom(`set:${new ObjectId().toString()}`)).toBeNull();
  });

  it('resolveRoom describes name/description fields and persists edits back', async () => {
    const s = await Sets.createSet({
      projectId: p1,
      name: 'Kitchen',
      description: 'Greasy diner.',
    });
    const desc = await resolveRoom(`set:${s._id.toString()}`);
    expect(desc.type).toBe('set');
    expect(desc.fields).toContain('name');
    expect(desc.fields).toContain('description');
    expect(desc.seed.name).toBe('Kitchen');
    expect(desc.seed.description).toBe('Greasy diner.');

    const result = await desc.persistFields({
      name: '**Diner Kitchen**',
      description: 'Neon now.',
    });
    expect(result.changed).toBe(true);
    const fresh = await Sets.getSet(p1, s._id.toString());
    expect(fresh.name).toBe('**Diner Kitchen**');
    expect(fresh.name_lower).toBe('diner kitchen');
    expect(fresh.description).toBe('Neon now.');
  });

  it('resolveRoom returns null for an unknown set', async () => {
    expect(await resolveRoom(`set:${new ObjectId().toString()}`)).toBeNull();
  });

  it('set rooms expose owned image fragments', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const imgId = new ObjectId();
    // Owned-image fragments read from GridFS metadata (images.files).
    await fakeDb.collection('images.files').insertOne({
      _id: imgId,
      filename: 'ref.png',
      metadata: {
        project_id: p1,
        owner_type: 'set',
        owner_id: s._id,
        name: 'North wall',
        description: 'Window over the sink',
      },
    });
    await Sets.pushSetImage(p1, s._id.toString(), { _id: imgId, name: 'North wall' });
    const desc = await resolveRoom(`set:${s._id.toString()}`);
    expect(desc.fields).toContain(`image:${imgId.toString()}:name`);
    expect(desc.seed[`image:${imgId.toString()}:name`]).toBe('North wall');
  });
});
