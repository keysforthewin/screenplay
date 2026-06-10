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
// rag/queue is imported as a side effect — stub so we don't try to wire chroma.
vi.mock('../src/rag/queue.js', () => ({
  enqueueReindex: () => {},
}));
vi.mock('../src/rag/indexer.js', () => ({}));

const { resolveRoom, parseRoomName, buildRoomName } = await import('../src/web/roomRegistry.js');
const Projects = await import('../src/mongo/projects.js');

let pid;

beforeEach(async () => {
  fakeDb.reset();
  pid = (await Projects.getDefaultProject())._id.toString();
});

function seedLibrary({ id, name = '', description = '' } = {}) {
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
      name_lower: name.toLowerCase(),
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('library room', () => {
  it('parseRoomName recognizes the literal "library" room', () => {
    expect(parseRoomName('library')).toEqual({ type: 'library' });
  });

  it('buildRoomName returns "library" for type:library', () => {
    expect(buildRoomName('library')).toBe('library');
  });

  it('describeLibraryRoom yields two fragments per image, seeded from Mongo', async () => {
    const a = seedLibrary({ name: 'Diner', description: 'neon' });
    const b = seedLibrary({ name: 'Rooftop', description: 'storm' });

    const desc = await resolveRoom('library');
    expect(desc.type).toBe('library');
    expect(desc.fields).toEqual(
      expect.arrayContaining([
        `library:${a._id}:name`,
        `library:${a._id}:description`,
        `library:${b._id}:name`,
        `library:${b._id}:description`,
      ]),
    );
    expect(desc.seed[`library:${a._id}:name`]).toBe('Diner');
    expect(desc.seed[`library:${a._id}:description`]).toBe('neon');
  });

  it('persistFields writes only changed fragments back to Mongo and updates name_lower', async () => {
    const a = seedLibrary({ name: 'Old', description: 'orig' });

    const desc = await resolveRoom('library');
    const result = await desc.persistFields({
      [`library:${a._id}:name`]: 'NEW NAME',
      [`library:${a._id}:description`]: 'orig', // unchanged
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual([`library:${a._id}:name`]);

    const after = await fakeDb.collection('images.files').findOne({ _id: a._id });
    expect(after.metadata.name).toBe('NEW NAME');
    expect(after.metadata.name_lower).toBe('new name');
    expect(after.metadata.description).toBe('orig');
  });

  it('persistFields is a no-op when nothing changed', async () => {
    const a = seedLibrary({ name: 'Same', description: 'same' });
    const desc = await resolveRoom('library');
    const result = await desc.persistFields({
      [`library:${a._id}:name`]: 'Same',
      [`library:${a._id}:description`]: 'same',
    });
    expect(result.changed).toBe(false);
  });

  function seedLibraryAttachment({ id, name = '', description = '' } = {}) {
    const doc = {
      _id: id || new ObjectId(),
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      length: 555,
      uploadDate: new Date(),
      metadata: {
        owner_type: null,
        owner_id: null,
        source: 'upload',
        content_type: 'application/pdf',
        name,
        description,
      },
    };
    fakeDb.collection('attachments.files')._docs.push(doc);
    return doc;
  }

  it('describeLibraryRoom exposes library_attachment fragments seeded from GridFS metadata', async () => {
    const a = seedLibraryAttachment({ name: 'Treatment', description: 'first draft' });

    const desc = await resolveRoom('library');
    expect(desc.fields).toEqual(
      expect.arrayContaining([
        `library_attachment:${a._id}:name`,
        `library_attachment:${a._id}:description`,
      ]),
    );
    expect(desc.seed[`library_attachment:${a._id}:name`]).toBe('Treatment');
    expect(desc.seed[`library_attachment:${a._id}:description`]).toBe('first draft');
  });

  it('persistFields routes library_attachment:<id>:name back to attachments GridFS metadata', async () => {
    const a = seedLibraryAttachment({ name: 'old', description: 'desc' });

    const desc = await resolveRoom('library');
    const result = await desc.persistFields({
      [`library_attachment:${a._id}:name`]: 'NEW',
      [`library_attachment:${a._id}:description`]: 'desc',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual([`library_attachment:${a._id}:name`]);
    const after = await fakeDb.collection('attachments.files').findOne({ _id: a._id });
    expect(after.metadata.name).toBe('NEW');
    expect(after.metadata.description).toBe('desc');
  });
});
