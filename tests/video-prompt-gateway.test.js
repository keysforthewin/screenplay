// Gateway flows for Prompts-tab rows in fallback mode (no Hocuspocus):
// create seeds text through the fallback write, delete renumbers, the
// video patch persists + broadcasts, and the beat/project cascades cover
// the new collection.

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

const broadcasts = [];
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn((room, payload) => {
    broadcasts.push({ room, payload });
  }),
  isHocuspocusRunning: () => false,
}));

const deletedAttachments = [];
vi.mock('../src/mongo/attachments.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    deleteAttachment: vi.fn(async (id) => {
      deletedAttachments.push(String(id));
    }),
    deleteAttachments: vi.fn(async (ids) => {
      for (const id of ids) deletedAttachments.push(String(id));
    }),
  };
});

vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({
  deleteEntity: async () => {},
  deleteProjectChunks: async () => 0,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Gateway = await import('../src/web/gateway.js');
const VP = await import('../src/mongo/videoPrompts.js');
const Plots = await import('../src/mongo/plots.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  broadcasts.length = 0;
  deletedAttachments.length = 0;
  projectId = (await createProject('Test Project'))._id.toString();
});

async function makeBeat() {
  return Plots.createBeat({ projectId, name: 'Diner', desc: 'A diner scene.' });
}

describe('video prompt gateway (fallback)', () => {
  it('createVideoPromptViaGateway seeds title/prompt via the fallback write and pings the room', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({
      projectId,
      beatId: beat._id,
      title: 'Arrival',
      prompt: '@Image1 is Sarah.',
      durationSeconds: 12,
      referenceImages: [{ image_id: new ObjectId(), owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — sheet' }],
      order: 1,
      seedFragments: { title: 'Arrival', prompt: '@Image1 is Sarah.' },
    });
    expect(p._id).toBeInstanceOf(ObjectId);
    const stored = await VP.getVideoPrompt(projectId, p._id);
    expect(stored.title).toBe('Arrival');
    expect(stored.prompt).toBe('@Image1 is Sarah.');
    expect(stored.duration_seconds).toBe(12);
    expect(stored.reference_images).toHaveLength(1);
    const ping = broadcasts.find((b) => b.room === `video_prompts:${beat._id}`);
    expect(ping).toBeTruthy();
    expect(ping.payload.added_video_prompt_id).toBe(p._id.toString());
  });

  it('setVideoPromptTextFieldViaGateway writes through the fallback and rejects unknown fields', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'prompt', text: 'new text' });
    expect((await VP.getVideoPrompt(projectId, p._id)).prompt).toBe('new text');
    await expect(
      Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'body', text: 'x' }),
    ).rejects.toThrow(/unknown video prompt field/);
  });

  it('updateVideoPromptScalarsViaGateway patches duration + ordered references and pings', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    const a = new ObjectId();
    const b = new ObjectId();
    broadcasts.length = 0;
    const updated = await Gateway.updateVideoPromptScalarsViaGateway({
      projectId,
      promptId: p._id,
      durationSeconds: 20,
      referenceImages: [
        { image_id: b, owner_type: 'set', owner_name: 'Diner', label: 'Diner — main' },
        { image_id: a, owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — sheet' },
      ],
    });
    expect(updated.duration_seconds).toBe(20);
    expect(updated.reference_images.map((r) => r.image_id.toString())).toEqual([b.toString(), a.toString()]);
    const ping = broadcasts.find((x) => x.room === `video_prompts:${beat._id}`);
    expect(ping.payload.changed).toEqual(['duration_seconds', 'reference_images']);
    expect(ping.payload.video_prompt_id).toBe(p._id.toString());
  });

  it('deleteVideoPromptViaGateway renumbers the rest and deletes the rendered video file', async () => {
    const beat = await makeBeat();
    const a = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'A' });
    const b = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'B' });
    const c = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'C' });
    const fileId = new ObjectId();
    await VP.updateVideoPrompt(projectId, b._id, { video_file_id: fileId });
    const result = await Gateway.deleteVideoPromptViaGateway({ projectId, promptId: b._id });
    expect(result).toEqual({ ok: true, beat_id: beat._id.toString() });
    const list = await VP.listVideoPrompts({ beatId: beat._id });
    expect(list.map((p) => [p.title, p.order])).toEqual([['A', 1], ['C', 2]]);
    expect(deletedAttachments).toContain(fileId.toString());
    void a; void c;
  });

  it('reorderVideoPromptsViaGateway persists the new order and pings', async () => {
    const beat = await makeBeat();
    const a = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'A' });
    const b = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'B' });
    broadcasts.length = 0;
    const result = await Gateway.reorderVideoPromptsViaGateway({
      projectId,
      beatId: beat._id,
      orderedIds: [b._id.toString(), a._id.toString()],
    });
    expect(result.map((p) => p.title)).toEqual(['B', 'A']);
    expect(broadcasts[0].payload.changed).toEqual(['order']);
  });

  it('setVideoPromptVideoViaGateway records the model snapshot and clears it on null', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    const fileId = new ObjectId();
    broadcasts.length = 0;
    const withVideo = await Gateway.setVideoPromptVideoViaGateway({
      projectId,
      promptId: p._id,
      videoFileId: fileId,
      durationSeconds: 15,
      modelId: 'seedance-2.5-ref',
      modelLabel: 'Seedance 2.5 (reference)',
      falModel: 'bytedance/seedance-2.5/reference-to-video',
      modelLab: 'ByteDance',
      modelFamily: 'Seedance 2.5',
      parameters: { duration_seconds: 15, generate_audio: false },
      costUsd: 0.42,
    });
    expect(withVideo.video_file_id.toString()).toBe(fileId.toString());
    expect(withVideo.video_duration_seconds).toBe(15);
    expect(withVideo.video_model_label).toBe('Seedance 2.5 (reference)');
    expect(withVideo.video_fal_model).toBe('bytedance/seedance-2.5/reference-to-video');
    expect(withVideo.video_parameters).toEqual({ duration_seconds: 15, generate_audio: false });
    expect(withVideo.video_cost_usd).toBe(0.42);
    expect(withVideo.video_generated_at).toBeInstanceOf(Date);
    const ping = broadcasts.find((x) => x.room === `video_prompts:${beat._id}`);
    expect(ping.payload.changed).toContain('video_file_id');
    expect(ping.payload.video_prompt_id).toBe(p._id.toString());

    const cleared = await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: p._id, videoFileId: null });
    expect(cleared.video_file_id).toBeNull();
    expect(cleared.video_model_label).toBeNull();
    expect(cleared.video_cost_usd).toBeNull();
    expect(cleared.video_generated_at).toBeNull();
  });

  it('deleteAllVideoPromptsForBeatViaGateway wipes rows and their video files, then pings cleared', async () => {
    const beat = await makeBeat();
    const a = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    const fileId = new ObjectId();
    await VP.updateVideoPrompt(projectId, a._id, { video_file_id: fileId });
    broadcasts.length = 0;
    const result = await Gateway.deleteAllVideoPromptsForBeatViaGateway({ projectId, beatId: beat._id });
    expect(result).toEqual({ ok: true, removed_count: 2 });
    expect(await VP.listVideoPrompts({ beatId: beat._id })).toHaveLength(0);
    expect(deletedAttachments).toContain(fileId.toString());
    expect(broadcasts[0].payload.cleared).toBe(true);
  });

  it('deleteBeatViaGateway cascades to video prompts (rows + video files)', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    const fileId = new ObjectId();
    await VP.updateVideoPrompt(projectId, p._id, { video_file_id: fileId });
    const res = await Gateway.deleteBeatViaGateway(projectId, beat._id.toString());
    expect(res.video_prompts_removed).toBe(1);
    expect(await VP.listVideoPrompts({ beatId: beat._id })).toHaveLength(0);
    expect(deletedAttachments).toContain(fileId.toString());
  });

  it('deleteProjectCascade removes the video_prompts collection rows and room', async () => {
    const beat = await makeBeat();
    await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    await fakeDb.collection('yjs_docs').insertOne({ _id: `video_prompts:${beat._id}`, state: Buffer.alloc(0) });
    const { deleteProjectCascade } = await import('../src/web/projectDelete.js');
    await createProject('Keeper'); // so the deleted one isn't the last project
    const result = await deleteProjectCascade(projectId);
    expect(result.deleted.video_prompts).toBe(1);
    expect(await fakeDb.collection('video_prompts').find({}).toArray()).toHaveLength(0);
    expect(await fakeDb.collection('yjs_docs').find({}).toArray()).toHaveLength(0);
  });
});
