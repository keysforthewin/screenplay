// Exercises the dialog audio gateway flows: attach/detach a recording, copy
// audio onto a storyboard scene, and confirm the resulting GridFS file is
// independent (deleting the dialog's audio does not affect the scene's).

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

// Avoid touching GridFS in tests — stub the copy helper to return a fresh
// ObjectId. The real implementation is covered separately by the bucket
// roundtrip helpers; this test focuses on the gateway wiring + independence.
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
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Gateway = await import('../src/web/gateway.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Plots = await import('../src/mongo/plots.js');
const Attachments = await import('../src/mongo/attachments.js');

describe('dialog audio gateway', () => {
  let projectId;

beforeEach(async () => {
    fakeDb.reset();
    projectId = (await createProject('Test Project'))._id.toString();
    Attachments.copyAttachmentBuffer.mockClear();
  });

  async function makeBeat() {
    return Plots.createBeat({ projectId, name: 'Diner', desc: 'A diner scene.' });
  }

  it('setDialogAudioViaGateway attaches an audio file id', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const fileId = new ObjectId();
    const updated = await Gateway.setDialogAudioViaGateway({ projectId,
      dialogId: d._id,
      audioFileId: fileId,
    });
    expect(updated.audio_file_id.toString()).toBe(fileId.toString());
  });

  it('setDialogAudioViaGateway clears audio when passed null', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const fileId = new ObjectId();
    await Gateway.setDialogAudioViaGateway({ projectId,
      dialogId: d._id,
      audioFileId: fileId,
    });
    const cleared = await Gateway.setDialogAudioViaGateway({ projectId,
      dialogId: d._id,
      audioFileId: null,
    });
    expect(cleared.audio_file_id).toBe(null);
  });

  it('copyDialogAudioToStoryboardViaGateway copies bytes into a new GridFS file', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const sourceFileId = new ObjectId();
    await Gateway.setDialogAudioViaGateway({ projectId,
      dialogId: d._id,
      audioFileId: sourceFileId,
    });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id });

    const result = await Gateway.copyDialogAudioToStoryboardViaGateway({ projectId,
      storyboardId: sb._id.toString(),
      dialogId: d._id.toString(),
    });

    expect(Attachments.copyAttachmentBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFileId: expect.anything(),
        ownerType: 'beat',
      }),
    );
    // Scene's audio_file_id is the new file, NOT the source.
    expect(result.audio._id.toString()).not.toBe(sourceFileId.toString());
    expect(result.storyboard.audio_file_id.toString()).toBe(
      result.audio._id.toString(),
    );
  });

  it('copy result is independent — clearing the dialog audio leaves the scene audio intact', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const sourceFileId = new ObjectId();
    await Gateway.setDialogAudioViaGateway({ projectId,
      dialogId: d._id,
      audioFileId: sourceFileId,
    });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id });
    const { storyboard: afterCopy } = await Gateway.copyDialogAudioToStoryboardViaGateway({ projectId,
      storyboardId: sb._id.toString(),
      dialogId: d._id.toString(),
    });
    const sceneAudioId = afterCopy.audio_file_id.toString();

    await Gateway.setDialogAudioViaGateway({ projectId,
      dialogId: d._id,
      audioFileId: null,
    });

    const scene = await Storyboards.getStoryboard(projectId, sb._id);
    const dialog = await Dialogs.getDialog(projectId, d._id);
    expect(scene.audio_file_id.toString()).toBe(sceneAudioId);
    expect(dialog.audio_file_id).toBe(null);
  });

  it('copyDialogAudio rejects a dialog with no audio attached', async () => {
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id });
    await expect(
      Gateway.copyDialogAudioToStoryboardViaGateway({ projectId,
        storyboardId: sb._id.toString(),
        dialogId: d._id.toString(),
      }),
    ).rejects.toThrow(/no audio to copy/i);
  });

  it('copyDialogAudio rejects when dialog and storyboard belong to different beats', async () => {
    const beatA = await makeBeat();
    const beatB = await Plots.createBeat({ projectId, name: 'Other', desc: 'elsewhere' });
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beatA._id });
    await Gateway.setDialogAudioViaGateway({ projectId,
      dialogId: d._id,
      audioFileId: new ObjectId(),
    });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatB._id });
    await expect(
      Gateway.copyDialogAudioToStoryboardViaGateway({ projectId,
        storyboardId: sb._id.toString(),
        dialogId: d._id.toString(),
      }),
    ).rejects.toThrow(/different beats/i);
  });
});
