// Gateway flows for Prompts-tab SCENES and CUT extras in fallback mode (no
// Hocuspocus): scene create seeds its floor-plan fragment through the
// fallback write, scene delete cascades its cuts and renumbers, start-frame
// set/undo rotate the one-step undo image, delete-all wipes scenes and cuts,
// the beat cascade removes scenes, and the room descriptor exposes all four
// fragment kinds.

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

const deletedImages = [];
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    deleteImages: vi.fn(async (ids) => {
      for (const id of ids || []) deletedImages.push(String(id));
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
const { resolveRoom, buildRoomName } = await import('../src/web/roomRegistry.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  broadcasts.length = 0;
  deletedAttachments.length = 0;
  deletedImages.length = 0;
  projectId = (await createProject('Test Project'))._id.toString();
});

async function makeBeat() {
  return Plots.createBeat({ projectId, name: 'Diner', desc: 'A diner scene.' });
}

function pingsFor(beatId) {
  return broadcasts.filter((b) => b.room === `video_prompts:${beatId}`);
}

describe('video scene gateway (fallback)', () => {
  it('createVideoSceneViaGateway seeds the floor plan through the fallback write and pings', async () => {
    const beat = await makeBeat();
    const s = await Gateway.createVideoSceneViaGateway({
      projectId,
      beatId: beat._id,
      title: 'Sarah waits',
      slug: 'INT. DINER — NIGHT',
      setNames: ['Diner'],
      characterNames: ['Sarah', 'Tom'],
      directorsRead: { turn: 'waiting to leaving' },
      intention: 'Make the audience feel her certainty crack.',
      seedFragments: { floor_plan: 'A night diner, the door at the far end.' },
    });
    expect(s._id).toBeInstanceOf(ObjectId);
    const stored = await VS.getVideoScene(projectId, s._id);
    expect(stored.floor_plan).toBe('A night diner, the door at the far end.');
    expect(stored.directors_read.turn).toBe('waiting to leaving');
    expect(s.floor_plan).toBe('A night diner, the door at the far end.');
    const ping = pingsFor(beat._id).find((b) => b.payload.added_video_scene_id);
    expect(ping.payload.added_video_scene_id).toBe(s._id.toString());
    expect(ping.payload.changed).toEqual(['video_scenes']);
  });

  it('setVideoSceneTextFieldViaGateway writes the floor plan and rejects other fields', async () => {
    const beat = await makeBeat();
    const s = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id });
    await Gateway.setVideoSceneTextFieldViaGateway({ projectId, sceneId: s._id, field: 'floor_plan', text: 'Axis: booth to door.' });
    expect((await VS.getVideoScene(projectId, s._id)).floor_plan).toBe('Axis: booth to door.');
    await expect(
      Gateway.setVideoSceneTextFieldViaGateway({ projectId, sceneId: s._id, field: 'title', text: 'x' }),
    ).rejects.toThrow(/unknown video scene field/);
  });

  it('updateVideoSceneViaGateway patches scalars and pings with the scene id', async () => {
    const beat = await makeBeat();
    const s = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id });
    broadcasts.length = 0;
    const updated = await Gateway.updateVideoSceneViaGateway({
      projectId,
      sceneId: s._id,
      patch: { intention: 'Feel the crack.', load: { verdict: 'safe', s: 3.1 }, title: undefined },
    });
    expect(updated.intention).toBe('Feel the crack.');
    expect(updated.load.verdict).toBe('safe');
    const ping = pingsFor(beat._id)[0];
    expect(ping.payload.changed).toEqual(['intention', 'load']);
    expect(ping.payload.video_scene_id).toBe(s._id.toString());
    expect(await Gateway.updateVideoSceneViaGateway({ projectId, sceneId: s._id, patch: {} })).toMatchObject({
      intention: 'Feel the crack.',
    });
  });

  it('createVideoPromptViaGateway accepts cut fields, seeds start_frame_prompt, and recompute lands the cut in its scene', async () => {
    const beat = await makeBeat();
    const s1 = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id, title: 'S1' });
    const s2 = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id, title: 'S2' });
    const a = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'a', sceneId: s1._id });
    const c = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'c', sceneId: s2._id });
    const b = await Gateway.createVideoPromptViaGateway({
      projectId,
      beatId: beat._id,
      title: 'b',
      sceneId: s1._id,
      camera: { size: 'medium', lens_mm: 50 },
      inFrame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }],
      lockLine: 'Same light. Camera at the counter end.',
      seedFragments: { title: 'b', prompt: 'Medium shot from the aisle.', start_frame_prompt: 'Frontal medium.' },
      recompute: true,
    });
    expect(b.camera.size).toBe('medium');
    expect(b.start_frame.prompt).toBe('Frontal medium.');
    expect(b.prompt).toBe('Medium shot from the aisle.');
    expect(b.cut_index).toBe(2);
    expect(b.order).toBe(2);
    const all = await VP.listVideoPrompts({ beatId: beat._id });
    expect(all.map((r) => [r.title, r.order, r.cut_index])).toEqual([['a', 1, 1], ['b', 2, 2], ['c', 3, 1]]);
    void a; void c;
  });

  it('setVideoPromptTextFieldViaGateway writes start_frame_prompt through the fallback', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'start_frame_prompt', text: 'The still.' });
    expect((await VP.getVideoPrompt(projectId, p._id)).start_frame.prompt).toBe('The still.');
  });

  it('updateVideoPromptScalarsViaGateway takes a structured patch alongside the legacy args', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    broadcasts.length = 0;
    const dialogId = new ObjectId();
    const updated = await Gateway.updateVideoPromptScalarsViaGateway({
      projectId,
      promptId: p._id,
      durationSeconds: 6,
      patch: { camera: { size: 'insert' }, dialog_ids: [dialogId], others: 'the waitress keeps wiping', crossing: true },
    });
    expect(updated.duration_seconds).toBe(6);
    expect(updated.camera.size).toBe('insert');
    expect(updated.dialog_ids.map(String)).toEqual([dialogId.toString()]);
    expect(updated.crossing).toBe(true);
    expect(pingsFor(beat._id)[0].payload.changed).toEqual(['duration_seconds', 'camera', 'dialog_ids', 'others', 'crossing']);
    await expect(
      Gateway.updateVideoPromptScalarsViaGateway({ projectId, promptId: p._id, patch: { bogus: 1 } }),
    ).rejects.toThrow(/unknown field/);
  });

  it('setVideoPromptStartFrameViaGateway rotates the undo image, undo swaps back, null clears', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    const img1 = new ObjectId();
    const img2 = new ObjectId();
    const img3 = new ObjectId();
    const ref = new ObjectId();
    broadcasts.length = 0;
    const first = await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: p._id,
      startFrame: { image_id: img1, prompt: 'v1', reference_ids: [ref], reference_scores: { [ref.toString()]: 0.9 }, model: 'nano-banana-pro' },
    });
    expect(first.start_frame.image_id.toString()).toBe(img1.toString());
    expect(first.start_frame.previous_image_id).toBeNull();
    expect(pingsFor(beat._id)[0].payload.changed).toEqual(['start_frame']);
    expect(pingsFor(beat._id)[0].payload.video_prompt_id).toBe(p._id.toString());

    // Second render: img1 becomes the undo target; the prompt is kept when omitted.
    const second = await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: p._id,
      startFrame: { image_id: img2, reference_ids: [ref], model: 'nano-banana-pro' },
    });
    expect(second.start_frame.image_id.toString()).toBe(img2.toString());
    expect(second.start_frame.previous_image_id.toString()).toBe(img1.toString());
    expect(second.start_frame.prompt).toBe('v1');
    expect(deletedImages).toEqual([]);

    // Third render: img2 becomes the undo target and img1 (the older one) is deleted.
    const third = await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: p._id,
      startFrame: { image_id: img3, prompt: 'v3' },
    });
    expect(third.start_frame.previous_image_id.toString()).toBe(img2.toString());
    expect(third.start_frame.prompt).toBe('v3');
    expect(deletedImages).toEqual([img1.toString()]);

    // Metadata-only update (same image) keeps the undo target.
    const same = await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: p._id,
      startFrame: { image_id: img3, prompt: 'v3b', model: 'gemini' },
    });
    expect(same.start_frame.previous_image_id.toString()).toBe(img2.toString());
    expect(same.start_frame.model).toBe('gemini');

    // Undo: img2 comes back, img3 is discarded.
    const undone = await Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: p._id });
    expect(undone.start_frame.image_id.toString()).toBe(img2.toString());
    expect(undone.start_frame.previous_image_id).toBeNull();
    expect(deletedImages).toContain(img3.toString());
    await expect(Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: p._id })).rejects.toThrow(/No previous/);

    // Clear: the remaining image is deleted and the sub-doc is null.
    const cleared = await Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: p._id, startFrame: null });
    expect(cleared.start_frame).toBeNull();
    expect(deletedImages).toContain(img2.toString());
  });

  it('setVideoPromptVideoViaGateway records the provider (fal by default, comfy when asked)', async () => {
    const beat = await makeBeat();
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    const fal = await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: p._id, videoFileId: new ObjectId(), modelId: 'kling' });
    expect(fal.video_provider).toBe('fal');
    expect(fal.video_comfy).toBeNull();
    const comfy = await Gateway.setVideoPromptVideoViaGateway({
      projectId,
      promptId: p._id,
      videoFileId: new ObjectId(),
      modelId: 'ltx-2.5-i2v',
      provider: 'comfy',
      comfy: { template: 'video_ltx2_5_i2v', prompt_id: 'abc' },
    });
    expect(comfy.video_provider).toBe('comfy');
    expect(comfy.video_comfy).toEqual({ template: 'video_ltx2_5_i2v', prompt_id: 'abc' });
    const cleared = await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: p._id, videoFileId: null });
    expect(cleared.video_provider).toBeNull();
    expect(cleared.video_comfy).toBeNull();
  });

  it('deleteVideoPromptViaGateway deletes start-frame images and renumbers within the scene', async () => {
    const beat = await makeBeat();
    const s = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id });
    const a = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'a', sceneId: s._id });
    const b = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'b', sceneId: s._id });
    const c = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'c', sceneId: s._id });
    const img = new ObjectId();
    const prevImg = new ObjectId();
    await VP.updateVideoPrompt(projectId, b._id, { start_frame: { image_id: img, previous_image_id: prevImg } });
    await Gateway.deleteVideoPromptViaGateway({ projectId, promptId: b._id });
    expect(deletedImages).toEqual(expect.arrayContaining([img.toString(), prevImg.toString()]));
    const rest = await VP.listVideoPrompts({ beatId: beat._id });
    expect(rest.map((r) => [r.title, r.order, r.cut_index])).toEqual([['a', 1, 1], ['c', 2, 2]]);
  });

  it('deleteVideoSceneViaGateway cascades its cuts (videos + start frames), renumbers scenes and cut order', async () => {
    const beat = await makeBeat();
    const s1 = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id, title: 'S1' });
    const s2 = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id, title: 'S2' });
    const s3 = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id, title: 'S3' });
    const a = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'a', sceneId: s1._id });
    const b = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'b', sceneId: s2._id });
    const c = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'c', sceneId: s3._id });
    const fileId = new ObjectId();
    const img = new ObjectId();
    await VP.updateVideoPrompt(projectId, b._id, { video_file_id: fileId, start_frame: { image_id: img } });
    broadcasts.length = 0;
    const result = await Gateway.deleteVideoSceneViaGateway({ projectId, sceneId: s2._id });
    expect(result).toEqual({ ok: true, beat_id: beat._id.toString(), cuts_removed: 1 });
    expect(deletedAttachments).toContain(fileId.toString());
    expect(deletedImages).toContain(img.toString());
    const scenes = await VS.listVideoScenes({ projectId, beatId: beat._id });
    expect(scenes.map((x) => [x.title, x.order])).toEqual([['S1', 1], ['S3', 2]]);
    const cuts = await VP.listVideoPrompts({ beatId: beat._id });
    expect(cuts.map((r) => [r.title, r.order])).toEqual([['a', 1], ['c', 2]]);
    const ping = pingsFor(beat._id).find((x) => x.payload.removed_video_scene_id);
    expect(ping.payload.removed_video_scene_id).toBe(s2._id.toString());
    await expect(Gateway.deleteVideoSceneViaGateway({ projectId, sceneId: s2._id })).rejects.toThrow(/not found/);
    void a; void c;
  });

  it('reorderVideoScenesViaGateway and reorderCutsInSceneViaGateway keep the global order coherent', async () => {
    const beat = await makeBeat();
    const s1 = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id, title: 'S1' });
    const s2 = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id, title: 'S2' });
    const a = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'a', sceneId: s1._id });
    const b = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'b', sceneId: s1._id });
    const c = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, title: 'c', sceneId: s2._id });
    broadcasts.length = 0;
    const scenes = await Gateway.reorderVideoScenesViaGateway({ projectId, beatId: beat._id, orderedIds: [s2._id, s1._id] });
    expect(scenes.map((x) => x.title)).toEqual(['S2', 'S1']);
    expect((await VP.listVideoPrompts({ beatId: beat._id })).map((r) => r.title)).toEqual(['c', 'a', 'b']);
    expect(pingsFor(beat._id)[0].payload.changed).toEqual(['video_scenes', 'order']);
    broadcasts.length = 0;
    const cuts = await Gateway.reorderCutsInSceneViaGateway({ projectId, sceneId: s1._id, orderedIds: [b._id, a._id] });
    expect(cuts.map((r) => [r.title, r.cut_index])).toEqual([['b', 1], ['a', 2]]);
    expect((await VP.listVideoPrompts({ beatId: beat._id })).map((r) => r.title)).toEqual(['c', 'b', 'a']);
    expect(pingsFor(beat._id)[0].payload.video_scene_id).toBe(s1._id.toString());
    void c;
  });

  it('deleteAllVideoScenesForBeatViaGateway wipes scenes, cuts, videos and start frames', async () => {
    const beat = await makeBeat();
    const s = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id });
    const a = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, sceneId: s._id });
    await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id });
    const fileId = new ObjectId();
    const img = new ObjectId();
    await VP.updateVideoPrompt(projectId, a._id, { video_file_id: fileId, start_frame: { image_id: img } });
    broadcasts.length = 0;
    const result = await Gateway.deleteAllVideoScenesForBeatViaGateway({ projectId, beatId: beat._id });
    expect(result).toEqual({ ok: true, removed_count: 2, scenes_removed: 1 });
    expect(await VP.listVideoPrompts({ beatId: beat._id })).toHaveLength(0);
    expect(await VS.listVideoScenes({ projectId, beatId: beat._id })).toHaveLength(0);
    expect(deletedAttachments).toContain(fileId.toString());
    expect(deletedImages).toContain(img.toString());
    expect(pingsFor(beat._id)[0].payload.cleared).toBe(true);
  });

  it('deleteBeatViaGateway cascades to scenes and cut start-frame images', async () => {
    const beat = await makeBeat();
    const s = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id });
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, sceneId: s._id });
    const img = new ObjectId();
    const prev = new ObjectId();
    await VP.updateVideoPrompt(projectId, p._id, { start_frame: { image_id: img, previous_image_id: prev } });
    const res = await Gateway.deleteBeatViaGateway(projectId, beat._id.toString());
    expect(res.video_prompts_removed).toBe(1);
    expect(res.video_scenes_removed).toBe(1);
    expect(await VS.listVideoScenes({ projectId, beatId: beat._id })).toHaveLength(0);
    expect(deletedImages).toEqual(expect.arrayContaining([img.toString(), prev.toString()]));
  });

  it('deleteProjectCascade removes the video_scenes rows', async () => {
    const beat = await makeBeat();
    await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id });
    const { deleteProjectCascade } = await import('../src/web/projectDelete.js');
    await createProject('Keeper');
    const result = await deleteProjectCascade(projectId);
    expect(result.deleted.video_scenes).toBe(1);
    expect(await fakeDb.collection('video_scenes').find({}).toArray()).toHaveLength(0);
  });
});

describe('video_prompts room (cuts + scenes)', () => {
  it('exposes title/prompt/start_frame_prompt/end_frame_prompt per cut and floor_plan per scene, and persists them', async () => {
    const beat = await makeBeat();
    const s = await Gateway.createVideoSceneViaGateway({
      projectId,
      beatId: beat._id,
      seedFragments: { floor_plan: 'Door at the far end.' },
    });
    const p = await Gateway.createVideoPromptViaGateway({
      projectId,
      beatId: beat._id,
      sceneId: s._id,
      seedFragments: { title: 'Cut 1', prompt: 'Wide from the counter end.', start_frame_prompt: 'Frontal wide.', end_frame_prompt: 'Door shut.' },
    });
    const desc = await resolveRoom(buildRoomName('video_prompts', beat._id.toString()));
    expect(desc.type).toBe('video_prompts');
    const pid = p._id.toString();
    const sid = s._id.toString();
    expect(desc.fields).toEqual([
      `scene:${sid}:floor_plan`,
      `item:${pid}:title`,
      `item:${pid}:prompt`,
      `item:${pid}:start_frame_prompt`,
      `item:${pid}:end_frame_prompt`,
    ]);
    expect(desc.seed[`scene:${sid}:floor_plan`]).toBe('Door at the far end.');
    expect(desc.seed[`item:${pid}:start_frame_prompt`]).toBe('Frontal wide.');
    expect(desc.seed[`item:${pid}:end_frame_prompt`]).toBe('Door shut.');
    expect(desc.seed[`item:${pid}:prompt`]).toBe('Wide from the counter end.');

    const result = await desc.persistFields({
      [`scene:${sid}:floor_plan`]: 'Door at the far end. Counter on the right.',
      [`item:${pid}:title`]: 'Cut 1',
      [`item:${pid}:prompt`]: 'Wide from the counter end, looking down the aisle.',
      [`item:${pid}:start_frame_prompt`]: 'Frontal wide, 24mm.',
      [`item:${pid}:end_frame_prompt`]: 'Door shut, Tom in the aisle.',
      'item:ffffffffffffffffffffffff:prompt': 'ignored',
      [`item:${pid}:bogus`]: 'ignored',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual([
      `scene:${sid}:floor_plan`,
      `item:${pid}:prompt`,
      `item:${pid}:start_frame_prompt`,
      `item:${pid}:end_frame_prompt`,
    ]);
    const scene = await VS.getVideoScene(projectId, s._id);
    expect(scene.floor_plan).toBe('Door at the far end. Counter on the right.');
    const cut = await VP.getVideoPrompt(projectId, p._id);
    expect(cut.prompt).toBe('Wide from the counter end, looking down the aisle.');
    expect(cut.start_frame.prompt).toBe('Frontal wide, 24mm.');
    expect(cut.end_frame.prompt).toBe('Door shut, Tom in the aisle.');
    expect(cut.title).toBe('Cut 1');
  });

  it('reads and writes the new fragments through the gateway fallback branches', async () => {
    const beat = await makeBeat();
    const s = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id });
    const p = await Gateway.createVideoPromptViaGateway({ projectId, beatId: beat._id, sceneId: s._id });
    await Gateway.setVideoSceneTextFieldViaGateway({ projectId, sceneId: s._id, field: 'floor_plan', text: 'FP' });
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'start_frame_prompt', text: 'SF' });
    // append reads the current value through the fallback read branch, then
    // writes through the fallback write branch.
    const entityId = beat._id.toString();
    await Gateway.appendEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `scene:${s._id}:floor_plan`, content: 'Axis: booth to door.' });
    await Gateway.appendEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `item:${p._id}:start_frame_prompt`, content: '24mm.' });
    const scene = await VS.getVideoScene(projectId, s._id);
    expect(scene.floor_plan).toContain('FP');
    expect(scene.floor_plan).toContain('Axis: booth to door.');
    const cut = await VP.getVideoPrompt(projectId, p._id);
    expect(cut.start_frame.prompt).toContain('SF');
    expect(cut.start_frame.prompt).toContain('24mm.');
    await expect(
      Gateway.appendEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `item:${p._id}:nope`, content: 'x' }),
    ).rejects.toThrow(/unknown video_prompts field/);
  });
});
