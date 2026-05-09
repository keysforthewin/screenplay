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

const Attachments = await import('../src/mongo/attachments.js');

beforeEach(() => {
  fakeDb.reset();
});

function seedAttachment({ ownerType = 'beat', ownerId, name = '', description = '' } = {}) {
  const doc = {
    _id: new ObjectId(),
    filename: 'doc.pdf',
    contentType: 'application/pdf',
    length: 200,
    uploadDate: new Date(),
    metadata: {
      owner_type: ownerType,
      owner_id: ownerType === null ? null : ownerId || new ObjectId(),
      source: 'upload',
      content_type: 'application/pdf',
      name,
      description,
    },
  };
  fakeDb.collection('attachments.files')._docs.push(doc);
  return doc;
}

describe('setOwnedAttachmentMeta', () => {
  it('writes name + description on a beat-owned attachment', async () => {
    const doc = seedAttachment({ ownerType: 'beat' });
    const result = await Attachments.setOwnedAttachmentMeta(doc._id, {
      name: 'Treatment',
      description: 'first draft',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(
      expect.arrayContaining(['metadata.name', 'metadata.description']),
    );
    const after = await fakeDb.collection('attachments.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('Treatment');
    expect(after.metadata.description).toBe('first draft');
  });

  it('writes only the supplied field', async () => {
    const doc = seedAttachment({ ownerType: 'character', name: 'old', description: 'keep' });
    await Attachments.setOwnedAttachmentMeta(doc._id, { name: 'new' });
    const after = await fakeDb.collection('attachments.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('new');
    expect(after.metadata.description).toBe('keep');
  });

  it('returns no-op when neither field is supplied', async () => {
    const doc = seedAttachment({ ownerType: 'beat' });
    const result = await Attachments.setOwnedAttachmentMeta(doc._id, {});
    expect(result.changed).toBe(false);
  });

  it('throws when the attachment does not exist', async () => {
    await expect(
      Attachments.setOwnedAttachmentMeta(new ObjectId(), { name: 'x' }),
    ).rejects.toThrow(/Attachment not found/);
  });
});

describe('setLibraryAttachmentMeta', () => {
  it('writes metadata on a library attachment', async () => {
    const doc = seedAttachment({ ownerType: null });
    await Attachments.setLibraryAttachmentMeta(doc._id, {
      name: 'Bible',
      description: 'show notes',
    });
    const after = await fakeDb.collection('attachments.files').findOne({ _id: doc._id });
    expect(after.metadata.name).toBe('Bible');
    expect(after.metadata.description).toBe('show notes');
  });

  it('refuses when the attachment is owned by an entity', async () => {
    const doc = seedAttachment({ ownerType: 'beat' });
    await expect(
      Attachments.setLibraryAttachmentMeta(doc._id, { name: 'x' }),
    ).rejects.toThrow(/owned by beat/);
  });
});

describe('attachmentFileToMeta', () => {
  it('surfaces name and description from GridFS metadata', () => {
    const meta = Attachments.attachmentFileToMeta({
      _id: new ObjectId(),
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      length: 200,
      uploadDate: new Date(),
      metadata: {
        owner_type: null,
        source: 'upload',
        content_type: 'application/pdf',
        name: 'Treatment',
        description: 'draft',
      },
    });
    expect(meta.name).toBe('Treatment');
    expect(meta.description).toBe('draft');
    expect(meta.content_type).toBe('application/pdf');
  });
});
