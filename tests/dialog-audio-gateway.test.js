// Exercises the dialog audio gateway flows: attach/detach a recording and the
// duration probe.

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
vi.mock('../src/web/dialogAudioProbe.js', () => ({
  probeDialogAudioDuration: vi.fn(async () => 4.25),
}));

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

  it('setDialogAudioViaGateway probes and stores the recording length, and clears it on detach', async () => {
    const Probe = await import('../src/web/dialogAudioProbe.js');
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const fileId = new ObjectId();
    const updated = await Gateway.setDialogAudioViaGateway({ projectId, dialogId: d._id, audioFileId: fileId });
    expect(updated.audio_duration_seconds).toBe(4.25);
    expect(Probe.probeDialogAudioDuration).toHaveBeenCalledWith(fileId);
    const cleared = await Gateway.setDialogAudioViaGateway({ projectId, dialogId: d._id, audioFileId: null });
    expect(cleared.audio_duration_seconds).toBe(null);
  });

  it('setDialogAudioViaGateway stores null when the probe throws', async () => {
    const Probe = await import('../src/web/dialogAudioProbe.js');
    Probe.probeDialogAudioDuration.mockImplementationOnce(async () => { throw new Error('ffprobe missing'); });
    const beat = await makeBeat();
    const d = await Gateway.createDialogViaGateway({ projectId, beatId: beat._id });
    const updated = await Gateway.setDialogAudioViaGateway({ projectId, dialogId: d._id, audioFileId: new ObjectId() });
    expect(updated.audio_file_id).toBeTruthy();
    expect(updated.audio_duration_seconds).toBe(null);
  });

  it('ensureDialogAudioDurations lazily probes legacy rows that have audio but no length', async () => {
    const beat = await makeBeat();
    const d = await Dialogs.createDialog({ projectId, beatId: beat._id, body: 'legacy' });
    await fakeDb.collection('dialogs').updateOne({ _id: d._id }, { $set: { audio_file_id: String(new ObjectId()), audio_duration_seconds: null } });
    const rows = await Dialogs.listDialogs({ projectId, beatId: beat._id });
    const probe = vi.fn(async () => 2.5);
    const out = await Dialogs.ensureDialogAudioDurations(projectId, rows, { probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(out[0].audio_duration_seconds).toBe(2.5);
    const reread = await Dialogs.listDialogs({ projectId, beatId: beat._id });
    expect(reread[0].audio_duration_seconds).toBe(2.5);
    // Second pass is a no-op.
    await Dialogs.ensureDialogAudioDurations(projectId, reread, { probe });
    expect(probe).toHaveBeenCalledTimes(1);
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
});
