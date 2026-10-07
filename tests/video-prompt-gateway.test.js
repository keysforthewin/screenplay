// Gateway flows for Scenes-tab cuts in fallback mode (no Hocuspocus): create
// appends to a scene with its text on the row, delete renumbers, the duration
// and video patches persist + broadcast, and the beat/project cascades cover
// the collection.

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
const VS = await import('../src/mongo/videoScenes.js');
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

// A beat with one scene; `scene` is what cuts are appended to.
async function makeScene(title = 'Scene') {
  const beat = await makeBeat();
  const scene = await VS.createVideoScene({ projectId, beatId: beat._id, title });
  return { beat, scene, sceneId: scene._id.toString() };
}

describe('cut gateway (fallback)', () => {
  it('createVideoPromptViaGateway appends to the scene with its text on the row and pings the room', async () => {
    const { beat, sceneId } = await makeScene();
    const p = await Gateway.createVideoPromptViaGateway({
      projectId,
      sceneId,
      title: 'Arrival',
      prompt: 'Sarah walks in.',
      durationSeconds: 12,
      startFramePrompt: 'The door, closed.',
      endFramePrompt: 'The door, open.',
    });
    expect(p._id).toBeInstanceOf(ObjectId);
    const stored = await VP.getVideoPrompt(projectId, p._id);
    expect(stored.beat_id.toString()).toBe(beat._id.toString());
    expect(stored.scene_id.toString()).toBe(sceneId);
    expect(stored.title).toBe('Arrival');
    expect(stored.prompt).toBe('Sarah walks in.');
    expect(stored.duration_seconds).toBe(12);
    expect(stored.start_frame).toMatchObject({ prompt: 'The door, closed.', image_id: null, reference_ids: [] });
    expect(stored.end_frame.prompt).toBe('The door, open.');
    expect([stored.cut_index, stored.order]).toEqual([1, 1]);
    const ping = broadcasts.find((b) => b.room === `video_prompts:${beat._id}`);
    expect(ping.payload.changed).toEqual(['video_prompts']);
    expect(ping.payload.added_video_prompt_id).toBe(p._id.toString());
  });

  it('a bare cut is empty, and cuts number scene by scene whatever order they were added in', async () => {
    const { beat, sceneId } = await makeScene('One');
    const two = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Two' });
    const a = await Gateway.createVideoPromptViaGateway({ projectId, sceneId });
    expect(a).toMatchObject({ title: '', prompt: '', duration_seconds: null, start_frame: null, end_frame: null });
    await Gateway.createVideoPromptViaGateway({ projectId, sceneId: two._id.toString(), title: '2.1' });
    await Gateway.createVideoPromptViaGateway({ projectId, sceneId, title: '1.2' });
    const list = await VP.listVideoPrompts({ beatId: beat._id });
    expect(list.map((c) => [c.title, c.order, c.cut_index])).toEqual([
      ['', 1, 1],
      ['1.2', 2, 2],
      ['2.1', 3, 1],
    ]);
    await expect(
      Gateway.createVideoPromptViaGateway({ projectId, sceneId: new ObjectId().toString() }),
    ).rejects.toThrow(/Video scene not found/);
  });

  it('setVideoPromptTextFieldViaGateway writes all four text fields through the fallback and rejects unknown fields', async () => {
    const { sceneId } = await makeScene();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, sceneId });
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'title', text: 'Name' });
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'prompt', text: 'new text' });
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'start_frame_prompt', text: 'first' });
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'end_frame_prompt', text: 'last' });
    const stored = await VP.getVideoPrompt(projectId, p._id);
    expect(stored.title).toBe('Name');
    expect(stored.prompt).toBe('new text');
    expect(stored.start_frame.prompt).toBe('first');
    expect(stored.end_frame.prompt).toBe('last');
    await expect(
      Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'body', text: 'x' }),
    ).rejects.toThrow(/unknown video prompt field/);
    await expect(
      Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: new ObjectId().toString(), field: 'prompt', text: 'x' }),
    ).rejects.toThrow(/not found/);
  });

  it('setVideoPromptDurationViaGateway stores the length in half-second steps and pings', async () => {
    const { beat, sceneId } = await makeScene();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, sceneId });
    broadcasts.length = 0;
    const updated = await Gateway.setVideoPromptDurationViaGateway({ projectId, promptId: p._id, durationSeconds: 3.2 });
    expect(updated.duration_seconds).toBe(3);
    expect(broadcasts).toEqual([
      {
        room: `video_prompts:${beat._id}`,
        payload: expect.objectContaining({ changed: ['duration_seconds'], video_prompt_id: p._id.toString() }),
      },
    ]);
    expect(
      (await Gateway.setVideoPromptDurationViaGateway({ projectId, promptId: p._id, durationSeconds: null })).duration_seconds,
    ).toBeNull();
    await expect(
      Gateway.setVideoPromptDurationViaGateway({ projectId, promptId: p._id, durationSeconds: -1 }),
    ).rejects.toThrow(/positive/);
    await expect(
      Gateway.setVideoPromptDurationViaGateway({ projectId, promptId: new ObjectId().toString(), durationSeconds: 2 }),
    ).rejects.toThrow(/not found/);
  });

  it('deleteVideoPromptViaGateway renumbers the rest and deletes the rendered video file', async () => {
    const { beat, sceneId } = await makeScene();
    await Gateway.createVideoPromptViaGateway({ projectId, sceneId, title: 'A' });
    const b = await Gateway.createVideoPromptViaGateway({ projectId, sceneId, title: 'B' });
    await Gateway.createVideoPromptViaGateway({ projectId, sceneId, title: 'C' });
    const fileId = new ObjectId();
    await VP.updateVideoPrompt(projectId, b._id, { video_file_id: fileId });
    broadcasts.length = 0;
    const result = await Gateway.deleteVideoPromptViaGateway({ projectId, promptId: b._id });
    expect(result).toEqual({ ok: true, beat_id: beat._id.toString() });
    const list = await VP.listVideoPrompts({ beatId: beat._id });
    expect(list.map((p) => [p.title, p.order, p.cut_index])).toEqual([['A', 1, 1], ['C', 2, 2]]);
    expect(deletedAttachments).toContain(fileId.toString());
    expect(broadcasts[0].payload.removed_video_prompt_id).toBe(b._id.toString());
  });

  it('reorderCutsInSceneViaGateway persists the new order and pings', async () => {
    const { sceneId } = await makeScene();
    const a = await Gateway.createVideoPromptViaGateway({ projectId, sceneId, title: 'A' });
    const b = await Gateway.createVideoPromptViaGateway({ projectId, sceneId, title: 'B' });
    broadcasts.length = 0;
    const result = await Gateway.reorderCutsInSceneViaGateway({
      projectId,
      sceneId,
      orderedIds: [b._id.toString(), a._id.toString()],
    });
    expect(result.map((p) => [p.title, p.cut_index])).toEqual([['B', 1], ['A', 2]]);
    expect(broadcasts[0].payload).toMatchObject({ changed: ['order'], video_scene_id: sceneId });
  });

  it('setVideoPromptVideoViaGateway records the model snapshot and clears it on null', async () => {
    const { beat, sceneId } = await makeScene();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, sceneId });
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
    expect(withVideo.video_provider).toBe('fal');
    const ping = broadcasts.find((x) => x.room === `video_prompts:${beat._id}`);
    expect(ping.payload.changed).toEqual(['video']);
    expect(ping.payload.video_prompt_id).toBe(p._id.toString());

    const comfy = await Gateway.setVideoPromptVideoViaGateway({
      projectId,
      promptId: p._id,
      videoFileId: fileId,
      provider: 'comfy',
      comfy: { model_id: 'ltx-2.5-i2v', prompt_id: 'abc' },
    });
    expect(comfy.video_provider).toBe('comfy');
    expect(comfy.video_comfy).toEqual({ model_id: 'ltx-2.5-i2v', prompt_id: 'abc' });

    const cleared = await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: p._id, videoFileId: null });
    expect(cleared.video_file_id).toBeNull();
    expect(cleared.video_model_label).toBeNull();
    expect(cleared.video_cost_usd).toBeNull();
    expect(cleared.video_generated_at).toBeNull();
    expect(cleared.video_provider).toBeNull();
    expect(cleared.video_comfy).toBeNull();
  });

  it('keyframes: add seeds the prompt, set/undo/clear by frame key keep the entry, remove deletes its images', async () => {
    const { sceneId } = await makeScene();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, sceneId, durationSeconds: 10 });
    const cutId = p._id.toString();

    const added = await Gateway.addVideoPromptKeyframeViaGateway({ projectId, promptId: cutId, atSeconds: 4, prompt: 'apex', strength: 0.5 });
    const kfId = added.keyframe_id;
    expect(added.cut.keyframes).toHaveLength(1);
    expect(added.cut.keyframes[0]).toMatchObject({ at_seconds: 4, strength: 0.5, prompt: 'apex', image_id: null });
    expect(added.cut.keyframes[0].id.toString()).toBe(kfId);
    expect(broadcasts.at(-1).payload).toMatchObject({ type: 'fields_updated', changed: ['keyframes'], keyframe_id: kfId });

    // Frame keys: parse / label / sub-doc.
    const key = Gateway.keyframeFrameKey(kfId);
    expect(Gateway.parseFrameKey(key)).toEqual({ kind: 'keyframe', key, kfId });
    expect(Gateway.parseFrameKey('end').kind).toBe('end');
    expect(() => Gateway.parseFrameKey('middle')).toThrow(/unknown frame key/);
    expect(() => Gateway.cutFrameKey(key)).toThrow(/keyframe/);
    expect(Gateway.getCutFrame(added.cut, key).prompt).toBe('apex');
    expect(Gateway.frameLabel(key, added.cut)).toBe('keyframe at 4 s');

    // The prompt fragment writes through the fallback path.
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: cutId, field: `kf:${kfId}:prompt`, text: 'apex, edited' });
    expect((await VP.getVideoPrompt(projectId, cutId)).keyframes[0].prompt).toBe('apex, edited');
    await expect(Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: cutId, field: 'kf:nothex:prompt', text: 'x' })).rejects.toThrow(/unknown video prompt field/);

    // Image set → undo target → undo → clear keeps the entry.
    const img1 = new ObjectId();
    const img2 = new ObjectId();
    const ref = new ObjectId();
    let cut = await Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: cutId, frame: key, startFrame: { image_id: img1, reference_ids: [ref], model: 'nano' } });
    expect(cut.keyframes[0]).toMatchObject({ at_seconds: 4, strength: 0.5, prompt: 'apex, edited', model: 'nano' });
    expect(cut.keyframes[0].image_id.toString()).toBe(img1.toString());
    cut = await Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: cutId, frame: key, startFrame: { image_id: img2, reference_ids: [ref] } });
    expect(cut.keyframes[0].previous_image_id.toString()).toBe(img1.toString());
    cut = await Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: cutId, frame: key });
    expect(cut.keyframes[0].image_id.toString()).toBe(img1.toString());
    expect(cut.keyframes[0].previous_image_id).toBeNull();
    await expect(Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: cutId, frame: key })).rejects.toThrow(/No previous keyframe at 4 s/);
    cut = await Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: cutId, frame: key, startFrame: null });
    expect(cut.keyframes).toHaveLength(1);
    expect(cut.keyframes[0]).toMatchObject({ image_id: null, previous_image_id: null, prompt: 'apex, edited', at_seconds: 4 });
    expect(cut.keyframes[0].reference_ids.map(String)).toEqual([ref.toString()]);

    // Scalars.
    cut = await Gateway.updateVideoPromptKeyframeViaGateway({ projectId, promptId: cutId, keyframeId: kfId, atSeconds: 7, strength: null, referenceIds: [] });
    expect(cut.keyframes[0]).toMatchObject({ at_seconds: 7, strength: null, reference_ids: [] });
    await expect(Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: cutId, frame: Gateway.keyframeFrameKey(new ObjectId()), startFrame: null })).rejects.toThrow(/Keyframe not found/);

    // Remove.
    cut = await Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: cutId, frame: key, startFrame: { image_id: img2 } });
    cut = await Gateway.removeVideoPromptKeyframeViaGateway({ projectId, promptId: cutId, keyframeId: kfId });
    expect(cut.keyframes).toEqual([]);
    expect(broadcasts.at(-1).payload).toMatchObject({ changed: ['keyframes'], removed_keyframe_id: kfId });
    await expect(Gateway.removeVideoPromptKeyframeViaGateway({ projectId, promptId: cutId, keyframeId: kfId })).rejects.toThrow(/Keyframe not found/);
  });

  it('the planner-era cut helpers are gone', () => {
    for (const name of [
      'updateVideoPromptScalarsViaGateway',
      'reorderVideoPromptsViaGateway',
      'deleteAllVideoPromptsForBeatViaGateway',
      'setVideoPromptAudioViaGateway',
      'setBeatPromptsVideoViaGateway',
      'clearAssembledVideosForBeat',
    ]) {
      expect(Gateway[name]).toBeUndefined();
    }
  });

  it('deleteBeatViaGateway cascades to scenes and cuts (rows + video files)', async () => {
    const { beat, sceneId } = await makeScene();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, sceneId });
    const fileId = new ObjectId();
    await VP.updateVideoPrompt(projectId, p._id, { video_file_id: fileId });
    const res = await Gateway.deleteBeatViaGateway(projectId, beat._id.toString());
    expect(res.video_prompts_removed).toBe(1);
    expect(res.video_scenes_removed).toBe(1);
    expect(await VP.listVideoPrompts({ beatId: beat._id })).toHaveLength(0);
    expect(await VS.listVideoScenes({ beatId: beat._id })).toHaveLength(0);
    expect(deletedAttachments).toContain(fileId.toString());
  });

  it('deleteProjectCascade removes the video_prompts / video_scenes rows and the room', async () => {
    const { beat, sceneId } = await makeScene();
    await Gateway.createVideoPromptViaGateway({ projectId, sceneId });
    await fakeDb.collection('yjs_docs').insertOne({ _id: `video_prompts:${beat._id}`, state: Buffer.alloc(0) });
    const { deleteProjectCascade } = await import('../src/web/projectDelete.js');
    await createProject('Keeper'); // so the deleted one isn't the last project
    const result = await deleteProjectCascade(projectId);
    expect(result.deleted.video_prompts).toBe(1);
    expect(result.deleted.video_scenes).toBe(1);
    expect(await fakeDb.collection('video_prompts').find({}).toArray()).toHaveLength(0);
    expect(await fakeDb.collection('video_scenes').find({}).toArray()).toHaveLength(0);
    expect(await fakeDb.collection('yjs_docs').find({}).toArray()).toHaveLength(0);
  });
});
