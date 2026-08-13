import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Sets = await import('../src/mongo/sets.js');
const Projects = await import('../src/mongo/projects.js');

let p1;
let p2;

beforeEach(async () => {
  fakeDb.reset();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
  p2 = (await Projects.createProject('Beta'))._id.toString();
});

describe('sets CRUD + project scoping', () => {
  it('createSet stamps project_id and stripped name_lower', async () => {
    const s = await Sets.createSet({ projectId: p1, name: '**Kitchen**', description: 'A greasy diner kitchen.' });
    expect(s.project_id).toBe(p1);
    expect(s.name).toBe('**Kitchen**');
    expect(s.name_lower).toBe('kitchen');
    expect(s.description).toBe('A greasy diner kitchen.');
    expect(s._id).toBeTruthy();
  });

  it('createSet defaults description to empty string', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Alley' });
    expect(s.description).toBe('');
  });

  it('the same name resolves independently per project', async () => {
    const a = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const b = await Sets.createSet({ projectId: p2, name: 'Kitchen' });
    expect((await Sets.getSet(p1, 'kitchen'))._id.toString()).toBe(a._id.toString());
    expect((await Sets.getSet(p2, 'kitchen'))._id.toString()).toBe(b._id.toString());
  });

  it('id lookup verifies project_id — mismatch is not-found', async () => {
    const a = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    expect(await Sets.getSet(p2, a._id.toString())).toBe(null);
    expect((await Sets.getSet(p1, a._id.toString()))._id.toString()).toBe(a._id.toString());
  });

  it('the stripMarkdown fallback scan stays inside the project', async () => {
    await Sets.createSet({ projectId: p1, name: '**Dark Alley**' });
    await Sets.createSet({ projectId: p2, name: '**Dark Alley**' });
    await fakeDb.collection('sets').updateOne(
      { project_id: p1 },
      { $set: { name_lower: '**dark alley**' } },
    );
    const found = await Sets.getSet(p1, 'Dark Alley');
    expect(found.project_id).toBe(p1);
  });

  it('listSets is scoped and sorted by name', async () => {
    await Sets.createSet({ projectId: p1, name: 'Rooftop' });
    await Sets.createSet({ projectId: p1, name: 'Alley' });
    await Sets.createSet({ projectId: p2, name: 'Diner' });
    expect((await Sets.listSets(p1)).map((s) => s.name)).toEqual(['Alley', 'Rooftop']);
    expect((await Sets.findAllSets(p2)).map((s) => s.name)).toEqual(['Diner']);
  });

  it('updateSet renames (recomputing name_lower) and edits description', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const next = await Sets.updateSet(p1, s._id.toString(), {
      name: '**Diner Kitchen**',
      description: 'Now with neon.',
    });
    expect(next.name).toBe('**Diner Kitchen**');
    expect(next.name_lower).toBe('diner kitchen');
    expect(next.description).toBe('Now with neon.');
  });

  it('updateSet rejects unrecognized keys and empty patches', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    await expect(Sets.updateSet(p1, s._id.toString(), { bogus: 1 })).rejects.toThrow(/no recognized fields/);
    await expect(Sets.updateSet(p1, s._id.toString(), 'nope')).rejects.toThrow(/must be an object/);
  });

  it('searchSets matches name and description', async () => {
    await Sets.createSet({ projectId: p1, name: 'Kitchen', description: 'Greasy diner, neon sign outside.' });
    await Sets.createSet({ projectId: p1, name: 'Rooftop', description: 'Windy.' });
    await Sets.createSet({ projectId: p2, name: 'Neon Bar' });
    const hits = await Sets.searchSets(p1, 'neon');
    expect(hits.map((h) => h.name)).toEqual(['Kitchen']);
    expect(hits[0].matched_fields).toEqual(['description']);
    expect(hits[0].preview).toContain('neon');
  });

  it('deleteSet returns image + attachment ids including artwork result ids', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const img = new ObjectId();
    const att = new ObjectId();
    const artResult = new ObjectId();
    const artPrev = new ObjectId();
    await Sets.pushSetImage(p1, s._id.toString(), { _id: img, name: 'ref' });
    await Sets.pushSetAttachment(p1, s._id.toString(), { _id: att, name: 'floorplan.pdf' });
    await Sets.pushSetArtwork(p1, s._id.toString(), {
      _id: new ObjectId(),
      status: 'done',
      result_image_id: artResult,
      previous_result_image_id: artPrev,
    });
    const res = await Sets.deleteSet(p1, 'kitchen');
    expect(res.name).toBe('Kitchen');
    const imageIds = res.image_ids.map(String);
    expect(imageIds).toContain(img.toString());
    expect(imageIds).toContain(artResult.toString());
    expect(imageIds).toContain(artPrev.toString());
    expect(res.attachment_ids.map(String)).toEqual([att.toString()]);
    expect(await Sets.getSet(p1, 'kitchen')).toBe(null);
  });
});

describe('set image/attachment/artwork embedded arrays', () => {
  let setId;
  beforeEach(async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    setId = s._id.toString();
  });

  it('first pushed image auto-promotes to main; setAsMain overrides later', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    const first = await Sets.pushSetImage(p1, setId, { _id: a });
    expect(first.is_main).toBe(true);
    const second = await Sets.pushSetImage(p1, setId, { _id: b });
    expect(second.is_main).toBe(false);
    await Sets.pushSetImage(p1, setId, { _id: new ObjectId() }, true);
    const s = await Sets.getSet(p1, setId);
    expect(s.images.length).toBe(3);
    expect(s.main_image_id.equals(a)).toBe(false);
  });

  it('pullSetImage re-picks main from the remaining images', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    await Sets.pushSetImage(p1, setId, { _id: a });
    await Sets.pushSetImage(p1, setId, { _id: b });
    const res = await Sets.pullSetImage(p1, setId, a);
    expect(res.main_image_id.equals(b)).toBe(true);
    await expect(Sets.pullSetImage(p1, setId, a)).rejects.toThrow(/not attached/);
  });

  it('replaceSetImage preserves the slot and carries main status', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    const n = new ObjectId();
    await Sets.pushSetImage(p1, setId, { _id: a });
    await Sets.pushSetImage(p1, setId, { _id: b });
    const res = await Sets.replaceSetImage(p1, setId, a, { _id: n });
    expect(res.was_main).toBe(true);
    const s = await Sets.getSet(p1, setId);
    expect(s.images[0]._id.equals(n)).toBe(true);
    expect(s.main_image_id.equals(n)).toBe(true);
  });

  it('attachments push/pull round-trip', async () => {
    const a = new ObjectId();
    await Sets.pushSetAttachment(p1, setId, { _id: a, name: 'plan.pdf' });
    expect((await Sets.getSet(p1, setId)).attachments.length).toBe(1);
    await Sets.pullSetAttachment(p1, setId, a);
    expect((await Sets.getSet(p1, setId)).attachments.length).toBe(0);
  });

  it('artwork push/replace/pull round-trip', async () => {
    const aid = new ObjectId();
    const rid = new ObjectId();
    await Sets.pushSetArtwork(p1, setId, { _id: aid, status: 'pending', prompt: 'wide shot' });
    const patched = await Sets.replaceSetArtwork(p1, setId, aid, { status: 'done', result_image_id: rid });
    expect(patched.status).toBe('done');
    const pulled = await Sets.pullSetArtwork(p1, setId, aid);
    expect(pulled.result_image_id.equals(rid)).toBe(true);
    expect(((await Sets.getSet(p1, setId)).artworks || []).length).toBe(0);
  });
});

describe('projectId threading', () => {
  it('every helper throws on a falsy projectId', async () => {
    await expect(Sets.listSets()).rejects.toThrow(/projectId required/);
    await expect(Sets.getSet(null, 'x')).rejects.toThrow(/projectId required/);
    await expect(Sets.createSet({ name: 'X' })).rejects.toThrow(/projectId required/);
  });
});
