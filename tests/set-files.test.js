// files.js set helpers: attach-existing (move-on-attach), main image, remove,
// and the detachImageFromCurrentOwner 'set' branch.
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

const deleteImage = vi.fn(async () => {});
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteImage,
}));

const Files = await import('../src/mongo/files.js');
const Sets = await import('../src/mongo/sets.js');
const Projects = await import('../src/mongo/projects.js');

let p1;
let setId;

beforeEach(async () => {
  fakeDb.reset();
  deleteImage.mockClear();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
  const s = await Sets.createSet({ projectId: p1, name: 'Kitchen' });
  setId = s._id.toString();
});

function insertGridFsImage({ ownerType = null, ownerId = null } = {}) {
  const _id = new ObjectId();
  fakeDb.collection('images.files')._docs.push({
    _id,
    filename: 'x.png',
    contentType: 'image/png',
    length: 10,
    uploadDate: new Date(),
    metadata: { project_id: p1, owner_type: ownerType, owner_id: ownerId },
  });
  return _id;
}

describe('files.js set helpers', () => {
  it('attachExistingImageToSet claims a library image and pushes meta', async () => {
    const imgId = insertGridFsImage();
    const res = await Files.attachExistingImageToSet({
      projectId: p1,
      set: setId,
      imageId: imgId.toString(),
    });
    expect(res.set).toBe('Kitchen');
    expect(res.is_main).toBe(true);
    const file = await fakeDb.collection('images.files').findOne({ _id: imgId });
    expect(file.metadata.owner_type).toBe('set');
    expect(file.metadata.owner_id.equals(new ObjectId(setId))).toBe(true);
    const s = await Sets.getSet(p1, setId);
    expect(s.images).toHaveLength(1);
  });

  it('detachImageFromCurrentOwner pulls a set-owned image off the set', async () => {
    const imgId = insertGridFsImage();
    await Files.attachExistingImageToSet({ projectId: p1, set: setId, imageId: imgId.toString() });
    const file = await fakeDb.collection('images.files').findOne({ _id: imgId });
    const moved = await Files.detachImageFromCurrentOwner(file);
    expect(moved.prior_owner_type).toBe('set');
    const s = await Sets.getSet(p1, setId);
    expect(s.images).toHaveLength(0);
  });

  it('setMainSetImage accepts gallery images and done artwork results', async () => {
    const a = new ObjectId();
    const artResult = new ObjectId();
    await Sets.pushSetImage(p1, setId, { _id: a });
    await Sets.pushSetArtwork(p1, setId, {
      _id: new ObjectId(),
      status: 'done',
      result_image_id: artResult,
    });
    await Files.setMainSetImage({ projectId: p1, set: setId, imageId: artResult.toString() });
    expect((await Sets.getSet(p1, setId)).main_image_id.equals(artResult)).toBe(true);
    await expect(
      Files.setMainSetImage({ projectId: p1, set: setId, imageId: new ObjectId().toString() }),
    ).rejects.toThrow(/not attached/);
  });

  it('removeSetImage deletes GridFS bytes and re-picks main', async () => {
    const a = new ObjectId();
    const b = new ObjectId();
    await Sets.pushSetImage(p1, setId, { _id: a });
    await Sets.pushSetImage(p1, setId, { _id: b });
    const res = await Files.removeSetImage({ projectId: p1, set: setId, imageId: a.toString() });
    expect(deleteImage).toHaveBeenCalledTimes(1);
    expect(res.main_image_id.equals(b)).toBe(true);
    expect((await Sets.getSet(p1, setId)).images).toHaveLength(1);
  });

  it('listSetImages returns the roster and main id', async () => {
    const a = new ObjectId();
    await Sets.pushSetImage(p1, setId, { _id: a });
    const res = await Files.listSetImages(p1, 'kitchen');
    expect(res.set).toBe('Kitchen');
    expect(res.images).toHaveLength(1);
    expect(res.main_image_id.equals(a)).toBe(true);
  });
});
