// Regression guard for the multi-project threading bug where
// removeCharacterImageViaGateway / setCharacterMainImageViaGateway received a
// projectId but failed to forward it to the underlying Mongo helper, so the
// helper's getCharacter(undefined, …) threw "projectId required" — surfacing in
// the SPA as an "invalid project ID" error when deleting / setting-main a
// character image.

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
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: () => Promise.resolve() }));

// Stub only the GridFS delete so removeCharacterImage's full path runs against
// the fake DB without a real bucket; we still assert it gets invoked.
const deleteImage = vi.fn(async () => {});
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  deleteImage,
}));

const Projects = await import('../src/mongo/projects.js');
const Characters = await import('../src/mongo/characters.js');
const Gateway = await import('../src/web/gateway.js');

function makeMeta(tag) {
  return {
    _id: new ObjectId(),
    filename: `${tag}.png`,
    content_type: 'image/png',
    size: 1,
    uploaded_at: new Date(),
  };
}

describe('character image gateway threads projectId', () => {
  let projectId;

  beforeEach(async () => {
    fakeDb.reset();
    deleteImage.mockClear();
    projectId = (await Projects.createProject('Test Project'))._id.toString();
  });

  it('removeCharacterImageViaGateway removes the image and promotes a new main', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae' });
    const a = makeMeta('a');
    const b = makeMeta('b');
    await Characters.pushCharacterImage(projectId, c._id.toString(), a, true);
    await Characters.pushCharacterImage(projectId, c._id.toString(), b, false);

    await Gateway.removeCharacterImageViaGateway({
      projectId,
      character: c._id.toString(),
      imageId: a._id.toString(),
    });

    expect(deleteImage).toHaveBeenCalledTimes(1);
    const fresh = await Characters.getCharacter(projectId, c._id.toString());
    expect(fresh.images).toHaveLength(1);
    expect(fresh.images[0]._id.equals(b._id)).toBe(true);
    // 'a' was main; removing it promotes the remaining image.
    expect(fresh.main_image_id.equals(b._id)).toBe(true);
  });

  it('setCharacterMainImageViaGateway switches the main image', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Rae' });
    const a = makeMeta('a');
    const b = makeMeta('b');
    await Characters.pushCharacterImage(projectId, c._id.toString(), a, true);
    await Characters.pushCharacterImage(projectId, c._id.toString(), b, false);

    await Gateway.setCharacterMainImageViaGateway({
      projectId,
      character: c._id.toString(),
      imageId: b._id.toString(),
    });

    const fresh = await Characters.getCharacter(projectId, c._id.toString());
    expect(fresh.main_image_id.equals(b._id)).toBe(true);
  });
});
