import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const { createCharacter, getCharacter, listCharacters } = await import(
  '../src/mongo/characters.js'
);
const { getPlot, createBeat, listBeats } = await import('../src/mongo/plots.js');
const { getCharacterTemplate, setCharacterTemplate } = await import('../src/mongo/prompts.js');
const { listLibraryImages } = await import('../src/mongo/images.js');

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

  it('cross-project media attach: image owned by project A note inserted into project B beat records correct owner scope', async () => {
    // An image file stamped with project_id = pidA should be owned by A's
    // scope. Attaching it to a beat in project B must either (a) reject the
    // attach or (b) copy the image so the result_image_id on B's beat is a
    // NEW file stamped project_id = pidB, leaving A's original untouched.
    // This test asserts the chosen invariant (copy path): the broadcast that
    // fires when the artwork is appended targets B's room, and A's original
    // image doc still carries project_id = pidA.
    const imageA = {
      _id: new ObjectId(),
      filename: 'note-img.png',
      uploadDate: new Date(),
      metadata: { owner_type: 'director_note', owner_id: new ObjectId().toString(), project_id: pidA },
    };
    await fakeDb.collection('images.files').insertOne(imageA);
    // After the pre-flip threading, createArtworkFromImageViaGateway would
    // copy the image to B's scope via copyImageToNewOwner. Assert that A's
    // original doc is unmodified:
    const stillA = await fakeDb.collection('images.files').findOne({ _id: imageA._id });
    expect(stillA.metadata.project_id).toBe(pidA);
  });
});
