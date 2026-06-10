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

const { createProject } = await import('../src/mongo/projects.js');
const Images = await import('../src/mongo/images.js');
const Projects = await import('../src/mongo/projects.js');

let pid;

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  pid = (await Projects.getDefaultProject())._id.toString();
});

function seedLibrary({ id, name = '', description = '', name_lower = '' } = {}) {
  const doc = {
    _id: id || new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      project_id: pid,
      owner_type: null,
      owner_id: null,
      source: 'upload',
      prompt: null,
      generated_by: null,
      name,
      description,
      name_lower: name_lower || name.toLowerCase(),
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('library image metadata helpers', () => {
  it('setLibraryImageMeta writes name + description and recomputes name_lower', async () => {
    const doc = seedLibrary({});
    await Images.setLibraryImageMeta(doc._id, {
      name: '**Diner** at dusk',
      description: 'A neon-lit roadside diner under a purple sky.',
    });
    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('**Diner** at dusk');
    expect(after.metadata.description).toBe('A neon-lit roadside diner under a purple sky.');
    expect(after.metadata.name_lower).toBe('diner at dusk');
  });

  it('setLibraryImageMeta accepts partial patches', async () => {
    const doc = seedLibrary({ name: 'Old', name_lower: 'old', description: 'keep me' });
    await Images.setLibraryImageMeta(doc._id, { name: 'New' });
    const after = await fakeDb.collection('images.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('New');
    expect(after.metadata.name_lower).toBe('new');
    expect(after.metadata.description).toBe('keep me');
  });

  it('setLibraryImageMeta refuses to touch entity-owned images', async () => {
    const doc = {
      _id: new ObjectId(),
      filename: 'b.png',
      contentType: 'image/png',
      length: 50,
      uploadDate: new Date(),
      metadata: { owner_type: 'beat', owner_id: new ObjectId(), source: 'upload' },
    };
    fakeDb.collection('images.files')._docs.push(doc);
    await expect(
      Images.setLibraryImageMeta(doc._id, { name: 'nope' }),
    ).rejects.toThrow(/owned by beat/);
  });

  it('searchLibraryImages matches name and description (case-insensitive)', async () => {
    seedLibrary({ name: 'Diner at dusk', description: 'neon, purple sky' });
    seedLibrary({ name: 'Sheriff with hat', description: 'a stoic lawman' });
    seedLibrary({ name: 'Rooftop chase', description: 'night, rain' });

    const a = await Images.searchLibraryImages({ projectId, query: 'diner' });
    expect(a.map((f) => f.metadata.name)).toEqual(['Diner at dusk']);

    const b = await Images.searchLibraryImages({ projectId, query: 'NEON' });
    expect(b.map((f) => f.metadata.name)).toEqual(['Diner at dusk']);

    const c = await Images.searchLibraryImages({ projectId, query: 'rain' });
    expect(c.map((f) => f.metadata.name)).toEqual(['Rooftop chase']);

    const empty = await Images.searchLibraryImages({ projectId, query: 'nothing-matches' });
    expect(empty).toEqual([]);
  });

  it('searchLibraryImages caps results by limit', async () => {
    for (let i = 0; i < 5; i++) seedLibrary({ name: `cat ${i}` });
    const out = await Images.searchLibraryImages({ projectId, query: 'cat', limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('imageFileToMeta surfaces name + description', () => {
    const file = {
      _id: new ObjectId(),
      filename: 'gen.png',
      contentType: 'image/png',
      length: 1234,
      uploadDate: new Date(),
      metadata: {
        owner_type: null,
        owner_id: null,
        source: 'generated',
        prompt: 'a cat',
        generated_by: 'gemini-2.5-flash-image',
        name: 'Black cat',
        description: 'A glossy black cat in a window.',
      },
    };
    const meta = Images.imageFileToMeta(file);
    expect(meta.name).toBe('Black cat');
    expect(meta.description).toBe('A glossy black cat in a window.');
  });
});
