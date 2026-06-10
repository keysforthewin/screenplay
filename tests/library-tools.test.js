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
vi.mock('../src/rag/queue.js', () => ({
  enqueueReindex: () => {},
}));
vi.mock('../src/rag/indexer.js', () => ({
  deleteEntity: async () => {},
}));
vi.mock('../src/web/libraryVisionWorker.js', () => ({
  kickoffLibraryVisionSeed: () => {},
}));

vi.mock('../src/mongo/images.js', async () => {
  const real = await vi.importActual('../src/mongo/images.js');
  return {
    ...real,
    streamImageToTmp: async (id) => ({
      path: `/tmp/fake-${String(id)}.png`,
      file: { _id: id },
    }),
    deleteImage: async (id) => {
      const oid = id instanceof ObjectId ? id : new ObjectId(String(id));
      const docs = fakeDb.collection('images.files')._docs;
      const idx = docs.findIndex((d) => d._id.equals(oid));
      if (idx >= 0) docs.splice(idx, 1);
    },
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const { HANDLERS } = await import('../src/agent/handlers.js');
const Projects = await import('../src/mongo/projects.js');

let pid;

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  pid = (await Projects.getDefaultProject())._id.toString();
});

function seedLibrary({ name = '', description = '' } = {}) {
  const doc = {
    _id: new ObjectId(),
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
      name_lower: name.toLowerCase(),
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('search_library_images handler', () => {
  it('returns matches as compact JSON', async () => {
    seedLibrary({ name: 'Diner at dusk', description: 'neon, purple sky' });
    seedLibrary({ name: 'Sheriff with hat', description: 'a stoic lawman' });

    const out = await HANDLERS.search_library_images({ query: 'diner' }, { projectId });
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Diner at dusk');
    expect(parsed[0].description).toBe('neon, purple sky');
    expect(typeof parsed[0]._id).toBe('string');
    expect(parsed[0]).not.toHaveProperty('filename');
  });

  it('matches description text when name does not match', async () => {
    seedLibrary({ name: 'Untitled', description: 'rainy rooftop chase' });
    const out = await HANDLERS.search_library_images({ query: 'rooftop' }, { projectId });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].description).toMatch(/rooftop/);
  });

  it('rejects empty query', async () => {
    const out = await HANDLERS.search_library_images({ query: '' }, { projectId });
    expect(out).toMatch(/query.*required/i);
  });

  it('returns [] when nothing matches', async () => {
    seedLibrary({ name: 'a', description: 'b' });
    const out = await HANDLERS.search_library_images({ query: 'zzz' }, { projectId });
    expect(JSON.parse(out)).toEqual([]);
  });
});

describe('show_library_image handler', () => {
  it('returns the IMAGE_PATH sentinel with the stored name as caption fallback', async () => {
    const doc = seedLibrary({ name: 'Diner at dusk' });
    const out = await HANDLERS.show_library_image({ image_id: doc._id.toString() }, { projectId });
    expect(out.startsWith('__IMAGE_PATH__:')).toBe(true);
    const [, caption, idStr] = out.split('|');
    expect(caption).toBe('Diner at dusk');
    expect(idStr).toBe(doc._id.toString());
  });

  it('uses the provided note as caption when given', async () => {
    const doc = seedLibrary({ name: 'Diner' });
    const out = await HANDLERS.show_library_image({
      image_id: doc._id.toString(),
      note: 'Here is the diner you asked for',
    }, { projectId });
    const [, caption] = out.split('|');
    expect(caption).toBe('Here is the diner you asked for');
  });

  it('rejects entity-owned images', async () => {
    const doc = {
      _id: new ObjectId(),
      filename: 'b.png',
      contentType: 'image/png',
      length: 50,
      uploadDate: new Date(),
      metadata: { owner_type: 'beat', owner_id: new ObjectId() },
    };
    fakeDb.collection('images.files')._docs.push(doc);
    const out = await HANDLERS.show_library_image({ image_id: doc._id.toString() }, { projectId });
    expect(out).toMatch(/owned by beat/);
  });
});

describe('replace_library_image handler', () => {
  it('copies metadata from source to new and deletes the source', async () => {
    const src = seedLibrary({ name: 'Diner', description: 'neon' });
    const next = seedLibrary({ name: '', description: '' });

    const out = await HANDLERS.replace_library_image({
      source_image_id: src._id.toString(),
      new_image_id: next._id.toString(),
    }, { projectId });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.new_image_id).toBe(next._id.toString());

    const srcAfter = await fakeDb.collection('images.files').findOne({ _id: src._id });
    expect(srcAfter).toBeNull();

    const nextAfter = await fakeDb.collection('images.files').findOne({ _id: next._id });
    expect(nextAfter.metadata.name).toBe('Diner');
    expect(nextAfter.metadata.description).toBe('neon');
    expect(nextAfter.metadata.name_lower).toBe('diner');
  });

  it('skips metadata copy when copy_metadata is false', async () => {
    const src = seedLibrary({ name: 'Diner', description: 'neon' });
    const next = seedLibrary({ name: 'KEEP', description: 'KEEP' });

    await HANDLERS.replace_library_image({
      source_image_id: src._id.toString(),
      new_image_id: next._id.toString(),
      copy_metadata: false,
    }, { projectId });

    const nextAfter = await fakeDb.collection('images.files').findOne({ _id: next._id });
    expect(nextAfter.metadata.name).toBe('KEEP');
    expect(nextAfter.metadata.description).toBe('KEEP');
  });

  it('rejects when either id is not a library image', async () => {
    const lib = seedLibrary({ name: 'a' });
    const beat = {
      _id: new ObjectId(),
      filename: 'b.png',
      contentType: 'image/png',
      length: 10,
      uploadDate: new Date(),
      metadata: { owner_type: 'beat', owner_id: new ObjectId() },
    };
    fakeDb.collection('images.files')._docs.push(beat);

    const a = await HANDLERS.replace_library_image({
      source_image_id: beat._id.toString(),
      new_image_id: lib._id.toString(),
    }, { projectId });
    expect(a).toMatch(/not in the library/);

    const b = await HANDLERS.replace_library_image({
      source_image_id: lib._id.toString(),
      new_image_id: beat._id.toString(),
    }, { projectId });
    expect(b).toMatch(/not in the library/);
  });

  it('rejects same-id requests', async () => {
    const lib = seedLibrary({ name: 'x' });
    const out = await HANDLERS.replace_library_image({
      source_image_id: lib._id.toString(),
      new_image_id: lib._id.toString(),
    }, { projectId });
    expect(out).toMatch(/must differ/);
  });
});
