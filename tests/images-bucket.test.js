import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Images = await import('../src/mongo/images.js');
const Projects = await import('../src/mongo/projects.js');

let pid; // default project id (hex string), recreated per test by getDefaultProject

beforeEach(async () => {
  fakeDb.reset();
  pid = (await Projects.getDefaultProject())._id.toString();
});

function seedFile({ id, projectId, ownerType = null, ownerId = null, source = 'upload', prompt = null }) {
  const doc = {
    _id: id || new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      project_id: projectId ?? pid,
      owner_type: ownerType,
      owner_id: ownerId,
      source,
      prompt,
      generated_by: source === 'generated' ? 'gemini-2.5-flash-image' : null,
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('images metadata helpers', () => {
  it('listLibraryImages returns only files with owner_type null', async () => {
    seedFile({ ownerType: null });
    seedFile({ ownerType: 'beat', ownerId: new ObjectId() });
    seedFile({ ownerType: null });

    const lib = await Images.listLibraryImages();
    expect(lib).toHaveLength(2);
    for (const f of lib) expect(f.metadata.owner_type).toBeNull();
  });

  it('listImagesForBeat filters by owner_type and owner_id', async () => {
    const beatA = new ObjectId();
    const beatB = new ObjectId();
    seedFile({ ownerType: 'beat', ownerId: beatA });
    seedFile({ ownerType: 'beat', ownerId: beatA });
    seedFile({ ownerType: 'beat', ownerId: beatB });

    const aImages = await Images.listImagesForBeat(undefined, beatA);
    expect(aImages).toHaveLength(2);
    for (const f of aImages) expect(f.metadata.owner_id.equals(beatA)).toBe(true);
  });

  it('setImageOwner flips ownership from library to a beat', async () => {
    const file = seedFile({ ownerType: null });
    const beatId = new ObjectId();

    await Images.setImageOwner(file._id, { ownerType: 'beat', ownerId: beatId });

    const after = await Images.findImageFile(file._id);
    expect(after.metadata.owner_type).toBe('beat');
    expect(after.metadata.owner_id.equals(beatId)).toBe(true);

    const lib = await Images.listLibraryImages();
    expect(lib).toHaveLength(0);

    const beatImages = await Images.listImagesForBeat(undefined, beatId);
    expect(beatImages).toHaveLength(1);
  });

  it('imageFileToMeta extracts the right fields', () => {
    const file = {
      _id: new ObjectId(),
      filename: 'gen.png',
      contentType: 'image/png',
      length: 1234,
      uploadDate: new Date('2025-01-01'),
      metadata: {
        owner_type: null,
        owner_id: null,
        source: 'generated',
        prompt: 'a cat',
        generated_by: 'gemini-2.5-flash-image',
      },
    };
    const meta = Images.imageFileToMeta(file);
    expect(meta.filename).toBe('gen.png');
    expect(meta.size).toBe(1234);
    expect(meta.source).toBe('generated');
    expect(meta.prompt).toBe('a cat');
    expect(meta.generated_by).toBe('gemini-2.5-flash-image');
  });

  it('ensureObjectId accepts strings and ObjectIds', () => {
    const oid = new ObjectId();
    expect(Images.ensureObjectId(oid)).toBe(oid);
    const fromStr = Images.ensureObjectId(oid.toString());
    expect(fromStr.equals(oid)).toBe(true);
  });
});

describe('images project scoping', () => {
  it('listLibraryImages(projectId) only returns that project\'s library', async () => {
    const other = await Projects.createProject('Other Movie');
    const otherPid = other._id.toString();
    seedFile({ ownerType: null });                       // default project
    seedFile({ ownerType: null, projectId: otherPid });  // other project

    const defaults = await Images.listLibraryImages();   // undefined → default project
    expect(defaults).toHaveLength(1);
    expect(defaults[0].metadata.project_id).toBe(pid);

    const others = await Images.listLibraryImages(otherPid);
    expect(others).toHaveLength(1);
    expect(others[0].metadata.project_id).toBe(otherPid);
  });

  it('listImagesByOwnerType(projectId, ownerType) is project-filtered', async () => {
    const other = await Projects.createProject('Other Movie');
    const otherPid = other._id.toString();
    seedFile({ ownerType: 'character', ownerId: new ObjectId() });
    seedFile({ ownerType: 'character', ownerId: new ObjectId(), projectId: otherPid });

    const defaults = await Images.listImagesByOwnerType(undefined, 'character');
    expect(defaults).toHaveLength(1);
    expect(defaults[0].metadata.project_id).toBe(pid);

    const others = await Images.listImagesByOwnerType(otherPid, 'character');
    expect(others).toHaveLength(1);
  });

  it('listImagesForBeat verifies project but is lenient toward unstamped legacy files', async () => {
    const other = await Projects.createProject('Other Movie');
    const otherPid = other._id.toString();
    const beatId = new ObjectId();
    seedFile({ ownerType: 'beat', ownerId: beatId });                      // default project
    seedFile({ ownerType: 'beat', ownerId: beatId, projectId: otherPid }); // other project
    const legacy = seedFile({ ownerType: 'beat', ownerId: beatId });
    delete legacy.metadata.project_id;                                     // pre-migration file

    const defaults = await Images.listImagesForBeat(undefined, beatId);
    expect(defaults).toHaveLength(2); // default-project file + legacy file

    const others = await Images.listImagesForBeat(otherPid, beatId);
    expect(others).toHaveLength(2); // other-project file + legacy file
  });

  it('files without metadata.project_id are excluded (strict filter; migration stamps legacy files)', async () => {
    const doc = seedFile({ ownerType: null });
    delete doc.metadata.project_id;
    const lib = await Images.listLibraryImages();
    expect(lib).toHaveLength(0);
  });
});
