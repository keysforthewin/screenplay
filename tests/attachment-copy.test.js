// Tests for copyAttachmentBuffer project-id precedence.
// GridFSBucket reads/writes don't play nicely with the in-memory fake mongo,
// so we mock readAttachmentBuffer + uploadAttachmentBuffer and verify the
// projectId arg passed to the upload helper — mirroring image-copy.test.js's
// copyImageToNewOwner describe block. copyAttachmentBuffer lives in
// attachmentCopy.js (separate module boundary) for the same reason
// copyImageToNewOwner lives in imageCopy.js.

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

const uploadCalls = [];

vi.mock('../src/mongo/attachments.js', async () => {
  const actual = await vi.importActual('../src/mongo/attachments.js');
  return {
    ...actual,
    readAttachmentBuffer: async (id) => {
      const key = String(id);
      const docs = fakeDb.collection('attachments.files')._docs;
      const found = docs.find((d) => String(d._id) === key);
      if (!found) return null;
      return { buffer: Buffer.from('FAKE_BYTES'), file: found };
    },
    uploadAttachmentBuffer: async (projectId, args) => {
      const newId = new ObjectId();
      uploadCalls.push({
        projectId: projectId ?? null,
        ownerType: args.ownerType,
        ownerId: args.ownerId ? String(args.ownerId) : null,
        filename: args.filename || 'copy.bin',
      });
      return {
        _id: newId,
        filename: args.filename || 'copy.bin',
        content_type: args.contentType || 'application/octet-stream',
        size: args.buffer?.length || 0,
        metadata: {
          project_id: projectId,
          owner_type: args.ownerType,
          owner_id: args.ownerId,
        },
        uploaded_at: new Date(),
      };
    },
  };
});

import { copyAttachmentBuffer } from '../src/mongo/attachmentCopy.js';

beforeEach(() => {
  fakeDb.reset();
  uploadCalls.length = 0;
});

function seedSourceFile({ projectId, ownerType = null, ownerId = null } = {}) {
  const doc = {
    _id: new ObjectId(),
    filename: 'clip.ogg',
    contentType: 'audio/ogg',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      project_id: projectId ?? 'a'.repeat(24),
      owner_type: ownerType,
      owner_id: ownerId,
      source: 'upload',
      content_type: 'audio/ogg',
    },
  };
  fakeDb.collection('attachments.files')._docs.push(doc);
  return doc;
}

describe('copyAttachmentBuffer — project-id precedence', () => {
  it('fallback-to-source: uses source file project_id when no explicit projectId is given', async () => {
    const sourceProjectId = 'a'.repeat(24);
    const file = seedSourceFile({ projectId: sourceProjectId });

    await copyAttachmentBuffer({
      sourceFileId: file._id,
      ownerType: null,
    });

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].projectId).toBe(sourceProjectId);
  });

  it('pin-override: explicit projectId wins over source file project_id', async () => {
    const sourceProjectId = 'a'.repeat(24);
    const pinnedProjectId = 'b'.repeat(24);
    const file = seedSourceFile({ projectId: sourceProjectId });

    await copyAttachmentBuffer({
      projectId: pinnedProjectId,
      sourceFileId: file._id,
      ownerType: null,
    });

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].projectId).toBe(pinnedProjectId);
    expect(uploadCalls[0].projectId).not.toBe(sourceProjectId);
  });
});
