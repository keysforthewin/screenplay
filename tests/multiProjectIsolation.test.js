import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: () => Promise.resolve() }));
vi.mock('../src/web/hocuspocus.js', () => ({
  isHocuspocusRunning: () => false,
  broadcastRoomStateless: () => {},
  getRoomDocument: () => null,
  withDirectDocument: async (_r, _o, fn) => fn({}),
}));

const { createProject } = await import('../src/mongo/projects.js');
const { createCharacter, getCharacter, listCharacters } = await import(
  '../src/mongo/characters.js'
);
const { getPlot, createBeat, listBeats } = await import('../src/mongo/plots.js');
const { getCharacterTemplate, setCharacterTemplate } = await import('../src/mongo/prompts.js');
const { listLibraryImages, findImageFile } = await import('../src/mongo/images.js');
const Gateway = await import('../src/web/gateway.js');

describe('multi-project isolation', () => {
  let pidA;
  let pidB;

  beforeEach(async () => {
    fakeDb.reset();
    pidA = (await createProject('Project A'))._id.toString();
    pidB = (await createProject('Project B'))._id.toString();
  });

  it('resolves the same character name independently per project', async () => {
    await createCharacter({ projectId: pidA, name: 'Steve' });
    await createCharacter({ projectId: pidB, name: 'Steve' });
    const a = await getCharacter(pidA, 'Steve');
    const b = await getCharacter(pidB, 'Steve');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a._id.toString()).not.toBe(b._id.toString());
    expect(a.project_id).toBe(pidA);
    expect(b.project_id).toBe(pidB);
  });

  it('does not leak characters across project listings', async () => {
    await createCharacter({ projectId: pidA, name: 'OnlyInA' });
    const a = await listCharacters(pidA);
    const b = await listCharacters(pidB);
    expect(a.map((c) => c.name)).toContain('OnlyInA');
    expect(b).toHaveLength(0);
  });

  it("returns not-found for project A's character id looked up under project B", async () => {
    const created = await createCharacter({ projectId: pidA, name: 'Steve' });
    const cross = await getCharacter(pidB, created._id.toString());
    expect(cross).toBeNull();
    // sanity: the id resolves fine under its own project
    const home = await getCharacter(pidA, created._id.toString());
    expect(home).not.toBeNull();
  });

  it('keeps plots and beats scoped per project', async () => {
    await createBeat({ projectId: pidA, name: 'A1', desc: 'first beat in A' });
    const plotA = await getPlot(pidA);
    const plotB = await getPlot(pidB);
    expect(plotA.beats).toHaveLength(1);
    expect(plotB.beats).toHaveLength(0);
    expect(String(plotA._id)).not.toBe(String(plotB._id));
    expect(await listBeats(pidB)).toHaveLength(0);
  });

  it('keeps library listings scoped per project', async () => {
    await fakeDb.collection('images.files').insertOne({
      _id: new ObjectId(),
      filename: 'a.png',
      uploadDate: new Date(),
      metadata: { owner_type: null, owner_id: null, kind: null, project_id: pidA },
    });
    const a = await listLibraryImages(pidA);
    const b = await listLibraryImages(pidB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('keeps character templates independent per project', async () => {
    await setCharacterTemplate(pidA, {
      fields: [{ name: 'secret_skill', description: 'x', required: false, core: false }],
    });
    const a = await getCharacterTemplate(pidA);
    const b = await getCharacterTemplate(pidB);
    expect(a.fields.map((f) => f.name)).toContain('secret_skill');
    expect((b?.fields || []).map((f) => f.name)).not.toContain('secret_skill');
  });

  it('cross-project media attach: attaching project A image to project B beat moves owner but preserves source project_id stamp', async () => {
    // attachExistingImageToBeatViaGateway reassigns ownership via setImageOwner
    // (which only writes owner_type / owner_id, never project_id). The source
    // file therefore retains project_id = pidA even after it is moved to a beat
    // in project B. This test drives that real gateway path and asserts:
    //  1. The source file's project_id is untouched (still pidA).
    //  2. The file's owner is now the beat in project B (owner_type = 'beat').
    //  3. The beat in project B has the image in its images[] array.
    // It will fail if setImageOwner or detachImageFromCurrentOwner starts
    // silently re-stamping the source file's project_id.
    const noteId = new ObjectId();
    const imageId = new ObjectId();
    // Insert an image.files doc that is owned by a director_note in project A.
    await fakeDb.collection('images.files').insertOne({
      _id: imageId,
      filename: 'note-img.png',
      length: 1024,
      uploadDate: new Date(),
      contentType: 'image/png',
      metadata: {
        owner_type: 'director_note',
        owner_id: noteId,
        project_id: pidA,
        source: 'upload',
        prompt: null,
        generated_by: null,
      },
    });
    // Create a beat in project B.
    const beat = await createBeat({ projectId: pidB, name: 'B-beat', desc: 'beat in B' });
    const beatId = beat._id.toString();
    // Run the real gateway attach path.
    await Gateway.attachExistingImageToBeatViaGateway({
      projectId: pidB,
      beatId,
      imageId: imageId.toString(),
    });
    // 1. Source file's project_id must be untouched.
    const movedFile = await findImageFile(imageId.toString());
    expect(movedFile.metadata.project_id).toBe(pidA);
    // 2. Owner has been reassigned to the beat in project B.
    expect(movedFile.metadata.owner_type).toBe('beat');
    expect(movedFile.metadata.owner_id.toString()).toBe(beatId);
    // 3. The beat in project B records the image in its images[] array.
    const plotB = await getPlot(pidB);
    const beatB = plotB.beats.find((b) => b._id.toString() === beatId);
    expect(beatB).toBeDefined();
    expect(beatB.images.some((img) => img._id.toString() === imageId.toString())).toBe(true);
  });
});
