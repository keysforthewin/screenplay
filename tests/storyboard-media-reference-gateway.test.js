// Exercises copyAttachmentToStoryboardMediaViaGateway — the helper behind the
// /storyboard/:id/{audio|video-upload}/from-attachment routes. Confirms that
// it validates the source's content type, copies bytes into a new GridFS
// file owned by the storyboard's beat, and points the right storyboard
// field at the copy.

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

// Stub the GridFS-touching attachment helpers — focus on gateway wiring.
vi.mock('../src/mongo/attachments.js', async () => {
  const actual = await vi.importActual('../src/mongo/attachments.js');
  return {
    ...actual,
    copyAttachmentBuffer: vi.fn(async ({ filename }) => ({
      _id: new ObjectId(),
      filename: filename || 'copy.bin',
      content_type: 'audio/webm',
      size: 1234,
      metadata: {},
      uploaded_at: new Date(),
    })),
    findAttachmentFile: vi.fn(),
    readAttachmentBuffer: vi.fn(async () => null),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Gateway = await import('../src/web/gateway.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Plots = await import('../src/mongo/plots.js');
const Attachments = await import('../src/mongo/attachments.js');

describe('copyAttachmentToStoryboardMediaViaGateway', () => {
  let projectId;

beforeEach(async () => {
    fakeDb.reset();
    projectId = (await createProject('Test Project'))._id.toString();
    Attachments.copyAttachmentBuffer.mockClear();
    Attachments.findAttachmentFile.mockReset();
  });

  it('copies an audio attachment into a fresh file and points the storyboard at it', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Diner', desc: 'A diner.' });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id });
    const sourceId = new ObjectId();
    Attachments.findAttachmentFile.mockResolvedValueOnce({
      _id: sourceId,
      filename: 'rumble.mp3',
      contentType: 'audio/mpeg',
      length: 9000,
      metadata: { content_type: 'audio/mpeg', owner_type: 'beat' },
    });

    const result = await Gateway.copyAttachmentToStoryboardMediaViaGateway({ projectId,
      storyboardId: sb._id.toString(),
      attachmentId: sourceId.toString(),
      kind: 'audio',
    });

    expect(Attachments.copyAttachmentBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFileId: sourceId.toString(),
        ownerType: 'beat',
      }),
    );
    expect(result.audio._id.toString()).not.toBe(sourceId.toString());
    expect(result.storyboard.audio_file_id.toString()).toBe(
      result.audio._id.toString(),
    );
  });

  it('copies a video attachment and sets video_upload_file_id', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Highway', desc: 'A drive.' });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id });
    const sourceId = new ObjectId();
    Attachments.findAttachmentFile.mockResolvedValueOnce({
      _id: sourceId,
      filename: 'cliip.mp4',
      contentType: 'video/mp4',
      length: 99000,
      metadata: { content_type: 'video/mp4', owner_type: 'character' },
    });

    const result = await Gateway.copyAttachmentToStoryboardMediaViaGateway({ projectId,
      storyboardId: sb._id.toString(),
      attachmentId: sourceId.toString(),
      kind: 'video',
    });

    expect(result.video._id.toString()).not.toBe(sourceId.toString());
    expect(result.storyboard.video_upload_file_id.toString()).toBe(
      result.video._id.toString(),
    );
  });

  it('rejects when the source attachment is the wrong content-type family', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Cafe', desc: 'A cafe.' });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id });
    const sourceId = new ObjectId();
    Attachments.findAttachmentFile.mockResolvedValueOnce({
      _id: sourceId,
      filename: 'photo.png',
      contentType: 'image/png',
      length: 100,
      metadata: { content_type: 'image/png', owner_type: 'beat' },
    });

    await expect(
      Gateway.copyAttachmentToStoryboardMediaViaGateway({ projectId,
        storyboardId: sb._id.toString(),
        attachmentId: sourceId.toString(),
        kind: 'audio',
      }),
    ).rejects.toThrow(/not audio\//i);
  });

  it('rejects when the source attachment is not found', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Park', desc: 'A park.' });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id });
    Attachments.findAttachmentFile.mockResolvedValueOnce(null);

    await expect(
      Gateway.copyAttachmentToStoryboardMediaViaGateway({ projectId,
        storyboardId: sb._id.toString(),
        attachmentId: new ObjectId().toString(),
        kind: 'audio',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects invalid kind', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Hall', desc: 'A hall.' });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id });
    await expect(
      Gateway.copyAttachmentToStoryboardMediaViaGateway({ projectId,
        storyboardId: sb._id.toString(),
        attachmentId: new ObjectId().toString(),
        kind: 'image',
      }),
    ).rejects.toThrow(/invalid kind/i);
  });
});
