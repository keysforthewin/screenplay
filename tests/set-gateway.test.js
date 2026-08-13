// Gateway surface for sets: text-field fallback writes, beat.sets patching,
// create/delete gateway functions, and the media wrappers.
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

const deleteEntity = vi.fn(async () => {});
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: (...a) => deleteEntity(...a) }));

const deleteImage = vi.fn(async () => {});
const deleteImages = vi.fn(async () => {});
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteImage: (...a) => deleteImage(...a),
  deleteImages: (...a) => deleteImages(...a),
}));

const deleteAttachments = vi.fn(async () => {});
vi.mock('../src/mongo/attachments.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteAttachments: (...a) => deleteAttachments(...a),
}));

const Projects = await import('../src/mongo/projects.js');
const Sets = await import('../src/mongo/sets.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Gateway = await import('../src/web/gateway.js');

let p1;

beforeEach(async () => {
  fakeDb.reset();
  deleteEntity.mockClear();
  deleteImage.mockClear();
  deleteImages.mockClear();
  deleteAttachments.mockClear();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
});

describe('set text fields through the gateway (fallback path)', () => {
  it('updateSetViaGateway writes name and description', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    await Gateway.updateSetViaGateway(p1, s._id.toString(), {
      name: '**Diner**',
      description: 'Neon.',
    });
    const fresh = await Sets.getSet(p1, s._id.toString());
    expect(fresh.name).toBe('**Diner**');
    expect(fresh.name_lower).toBe('diner');
    expect(fresh.description).toBe('Neon.');
  });

  it('updateSetViaGateway rejects unknown patches', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    await expect(
      Gateway.updateSetViaGateway(p1, s._id.toString(), { bogus: 1 }),
    ).rejects.toThrow(/no recognized fields/);
  });

  it('editSetFieldViaGateway applies windowed edits to the description', async () => {
    const s = await Sets.createSet({
      projectId: p1,
      name: 'Kitchen',
      description: 'The kitchen is red.',
    });
    await Gateway.editSetFieldViaGateway({
      projectId: p1,
      identifier: 'kitchen',
      field: 'description',
      edits: [{ find: 'red', replace: 'blue' }],
    });
    expect((await Sets.getSet(p1, s._id.toString())).description).toBe('The kitchen is blue.');
  });
});

describe('beat.sets through the gateway', () => {
  it('updateBeatViaGateway accepts a sets roster', async () => {
    const beat = await Plots.createBeat({ projectId: p1, desc: 'One' });
    const after = await Gateway.updateBeatViaGateway(p1, beat._id.toString(), {
      sets: ['Kitchen', 'kitchen', 'Alley'],
    });
    expect(after.sets).toEqual(['Kitchen', 'Alley']);
  });
});

describe('create/delete gateways', () => {
  it('createSetViaGateway creates and returns the set', async () => {
    const s = await Gateway.createSetViaGateway({
      projectId: p1,
      name: 'Kitchen',
      description: 'Greasy.',
    });
    expect(s._id).toBeTruthy();
    expect((await Sets.getSet(p1, 'kitchen')).description).toBe('Greasy.');
  });

  it('createSetViaGateway rejects a duplicate name in the project', async () => {
    await Gateway.createSetViaGateway({ projectId: p1, name: 'Kitchen' });
    await expect(
      Gateway.createSetViaGateway({ projectId: p1, name: '**kitchen**' }),
    ).rejects.toThrow(/already exists/i);
  });

  it('deleteSetViaGateway unlinks beats, purges bytes, and drops RAG chunks', async () => {
    const s = await Gateway.createSetViaGateway({ projectId: p1, name: 'Kitchen' });
    await Plots.createBeat({ projectId: p1, desc: 'One', sets: ['Kitchen'] });
    const img = new ObjectId();
    const att = new ObjectId();
    await Sets.pushSetImage(p1, s._id.toString(), { _id: img });
    await Sets.pushSetAttachment(p1, s._id.toString(), { _id: att });
    const res = await Gateway.deleteSetViaGateway(p1, s._id.toString());
    expect(res.name).toBe('Kitchen');
    expect(await Sets.getSet(p1, 'kitchen')).toBe(null);
    const plot = await Plots.getPlot(p1);
    expect(plot.beats[0].sets).toEqual([]);
    expect(deleteImages).toHaveBeenCalledWith([img]);
    expect(deleteAttachments).toHaveBeenCalledWith([att]);
    expect(deleteEntity).toHaveBeenCalledWith('set', s._id.toString());
  });

  it('createCharacterViaGateway creates and rejects duplicates', async () => {
    const c = await Gateway.createCharacterViaGateway({ projectId: p1, name: 'Steve' });
    expect(c._id).toBeTruthy();
    expect((await Characters.getCharacter(p1, 'steve'))._id.toString()).toBe(c._id.toString());
    await expect(
      Gateway.createCharacterViaGateway({ projectId: p1, name: 'STEVE' }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe('set media wrappers', () => {
  it('add/setMain/remove image wrappers thread projectId', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const a = { _id: new ObjectId(), filename: 'a.png' };
    const b = { _id: new ObjectId(), filename: 'b.png' };
    await Gateway.addSetImageViaGateway({ projectId: p1, set: s._id.toString(), imageMeta: a });
    await Gateway.addSetImageViaGateway({ projectId: p1, set: s._id.toString(), imageMeta: b });
    await Gateway.setSetMainImageViaGateway({
      projectId: p1,
      set: s._id.toString(),
      imageId: b._id.toString(),
    });
    expect((await Sets.getSet(p1, 'kitchen')).main_image_id.equals(b._id)).toBe(true);
    await Gateway.removeSetImageViaGateway({
      projectId: p1,
      set: s._id.toString(),
      imageId: a._id.toString(),
    });
    expect(deleteImage).toHaveBeenCalledTimes(1);
    expect((await Sets.getSet(p1, 'kitchen')).images).toHaveLength(1);
  });

  it('attachment wrappers push and pull with byte cleanup', async () => {
    const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
    const att = { _id: new ObjectId(), filename: 'plan.pdf' };
    await Gateway.addSetAttachmentViaGateway({
      projectId: p1,
      set: s._id.toString(),
      attachmentMeta: att,
    });
    expect((await Sets.getSet(p1, 'kitchen')).attachments).toHaveLength(1);
    await Gateway.removeSetAttachmentViaGateway({
      projectId: p1,
      set: s._id.toString(),
      attachmentId: att._id.toString(),
    });
    expect((await Sets.getSet(p1, 'kitchen')).attachments).toHaveLength(0);
  });
});
