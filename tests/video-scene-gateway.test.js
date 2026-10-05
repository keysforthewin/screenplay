// Gateway flows for Scenes-tab SCENES and the cut FRAMES in fallback mode (no
// Hocuspocus): scene create stores its title and pings, scene delete cascades
// its cuts and renumbers, frame set/undo rotate the one-step undo image for
// the start and the end frame alike, the beat cascade removes scenes and
// frame images, and the room's fragments read and write through the fallback.

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

const scene = (beat, title = '') => Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id.toString(), title });
const cut = (s, title = '') => Gateway.createVideoPromptViaGateway({ projectId, sceneId: s._id.toString(), title });

describe('video scene gateway (fallback)', () => {
  it('createVideoSceneViaGateway appends a titled scene and pings', async () => {
    const beat = await makeBeat();
    const s = await scene(beat, 'Sarah waits');
    expect(s._id).toBeInstanceOf(ObjectId);
    expect(s).toMatchObject({ title: 'Sarah waits', order: 1, project_id: projectId });
    const stored = await VS.getVideoScene(projectId, s._id);
    expect(stored.title).toBe('Sarah waits');
    const ping = pingsFor(beat._id).find((b) => b.payload.added_video_scene_id);
    expect(ping.payload.added_video_scene_id).toBe(s._id.toString());
    expect(ping.payload.changed).toEqual(['video_scenes']);
    const second = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id.toString() });
    expect(second).toMatchObject({ title: '', order: 2 });
  });

  it('the planner-era scene helpers are gone', () => {
    for (const name of [
      'updateVideoSceneViaGateway',
      'setVideoSceneTextFieldViaGateway',
      'deleteAllVideoScenesForBeatViaGateway',
      'setVideoSceneVideoViaGateway',
    ]) {
      expect(Gateway[name]).toBeUndefined();
    }
  });

  it('cutFrameKey maps start/end to the cut field', () => {
    expect(Gateway.cutFrameKey('start')).toBe('start_frame');
    expect(Gateway.cutFrameKey('end')).toBe('end_frame');
    expect(Gateway.cutFrameKey()).toBe('start_frame');
  });

  it('setVideoPromptStartFrameViaGateway rotates the undo image, undo swaps back, null clears', async () => {
    const beat = await makeBeat();
    const p = await cut(await scene(beat));
    const img1 = new ObjectId();
    const img2 = new ObjectId();
    const img3 = new ObjectId();
    const ref = new ObjectId();
    broadcasts.length = 0;
    const first = await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: p._id,
      startFrame: { image_id: img1, prompt: 'v1', reference_ids: [ref], model: 'nano-banana-pro' },
    });
    expect(first.start_frame.image_id.toString()).toBe(img1.toString());
    expect(first.start_frame.previous_image_id).toBeNull();
    expect(first.start_frame.reference_ids.map(String)).toEqual([ref.toString()]);
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

    // Undo: img2 comes back, img3 is discarded; the prompt stays.
    const undone = await Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: p._id });
    expect(undone.start_frame.image_id.toString()).toBe(img2.toString());
    expect(undone.start_frame.previous_image_id).toBeNull();
    expect(undone.start_frame.prompt).toBe('v3b');
    expect(deletedImages).toContain(img3.toString());
    await expect(Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: p._id })).rejects.toThrow(/No previous/);

    // Clear: the remaining image is deleted and the sub-doc is null.
    const cleared = await Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: p._id, startFrame: null });
    expect(cleared.start_frame).toBeNull();
    expect(deletedImages).toContain(img2.toString());
  });

  it('frame: "end" works on end_frame and leaves the start frame alone', async () => {
    const beat = await makeBeat();
    const p = await cut(await scene(beat));
    const startImg = new ObjectId();
    const e1 = new ObjectId();
    const e2 = new ObjectId();
    await Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: p._id, startFrame: { image_id: startImg, prompt: 'start' } });
    broadcasts.length = 0;
    await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: p._id,
      frame: 'end',
      startFrame: { image_id: e1, prompt: 'end', reference_ids: [startImg] },
    });
    expect(pingsFor(beat._id)[0].payload.changed).toEqual(['end_frame']);
    const second = await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: p._id,
      frame: 'end',
      startFrame: { image_id: e2, reference_ids: [startImg] },
    });
    expect(second.end_frame).toMatchObject({ prompt: 'end', image_id: e2, previous_image_id: e1 });
    expect(second.end_frame.reference_ids.map(String)).toEqual([startImg.toString()]);
    expect(second.start_frame).toMatchObject({ prompt: 'start', image_id: startImg, previous_image_id: null });
    const undone = await Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: p._id, frame: 'end' });
    expect(undone.end_frame).toMatchObject({ image_id: e1, previous_image_id: null });
    expect(deletedImages).toEqual([e2.toString()]);
    await expect(Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: p._id })).rejects.toThrow(/No previous start frame/);
    const cleared = await Gateway.setVideoPromptStartFrameViaGateway({ projectId, promptId: p._id, frame: 'end', startFrame: null });
    expect(cleared.end_frame).toBeNull();
    expect(cleared.start_frame.image_id.toString()).toBe(startImg.toString());
    expect(deletedImages).toEqual([e2.toString(), e1.toString()]);
  });

  it('deleteVideoPromptViaGateway deletes both frames\' images and renumbers within the scene', async () => {
    const beat = await makeBeat();
    const s = await scene(beat);
    await cut(s, 'a');
    const b = await cut(s, 'b');
    await cut(s, 'c');
    const img = new ObjectId();
    const prevImg = new ObjectId();
    const endImg = new ObjectId();
    const ref = new ObjectId();
    await VP.updateVideoPrompt(projectId, b._id, {
      start_frame: { image_id: img, previous_image_id: prevImg, reference_ids: [ref] },
      end_frame: { image_id: endImg },
    });
    await Gateway.deleteVideoPromptViaGateway({ projectId, promptId: b._id });
    expect(deletedImages.sort()).toEqual([img.toString(), prevImg.toString(), endImg.toString()].sort());
    // Reference images are artwork owned elsewhere: never deleted with a cut.
    expect(deletedImages).not.toContain(ref.toString());
    const rest = await VP.listVideoPrompts({ beatId: beat._id });
    expect(rest.map((r) => [r.title, r.order, r.cut_index])).toEqual([['a', 1, 1], ['c', 2, 2]]);
  });

  it('deleteVideoSceneViaGateway cascades its cuts (videos + frames), renumbers scenes and cuts', async () => {
    const beat = await makeBeat();
    const s1 = await scene(beat, 'S1');
    const s2 = await scene(beat, 'S2');
    const s3 = await scene(beat, 'S3');
    await cut(s1, 'a');
    const b = await cut(s2, 'b');
    await cut(s2, 'b2');
    await cut(s3, 'c');
    await cut(s3, 'd');
    const fileId = new ObjectId();
    const img = new ObjectId();
    await VP.updateVideoPrompt(projectId, b._id, { video_file_id: fileId, start_frame: { image_id: img } });
    broadcasts.length = 0;
    const result = await Gateway.deleteVideoSceneViaGateway({ projectId, sceneId: s2._id });
    expect(result).toEqual({ ok: true, beat_id: beat._id.toString(), cuts_removed: 2 });
    expect(deletedAttachments).toContain(fileId.toString());
    expect(deletedImages).toContain(img.toString());
    const scenes = await VS.listVideoScenes({ projectId, beatId: beat._id });
    expect(scenes.map((x) => [x.title, x.order])).toEqual([['S1', 1], ['S3', 2]]);
    // Scene 3 is now scene 2: its cuts are 2.1 and 2.2, and the beat-wide order has no gap.
    const cuts = await VP.listVideoPrompts({ beatId: beat._id });
    expect(cuts.map((r) => [r.title, r.order, r.cut_index])).toEqual([['a', 1, 1], ['c', 2, 1], ['d', 3, 2]]);
    const ping = pingsFor(beat._id).find((x) => x.payload.removed_video_scene_id);
    expect(ping.payload.removed_video_scene_id).toBe(s2._id.toString());
    expect(ping.payload.changed).toEqual(['video_scenes', 'video_prompts']);
    await expect(Gateway.deleteVideoSceneViaGateway({ projectId, sceneId: s2._id })).rejects.toThrow(/not found/);
  });

  it('reorderVideoScenesViaGateway and reorderCutsInSceneViaGateway keep the global order coherent', async () => {
    const beat = await makeBeat();
    const s1 = await scene(beat, 'S1');
    const s2 = await scene(beat, 'S2');
    const a = await cut(s1, 'a');
    const b = await cut(s1, 'b');
    await cut(s2, 'c');
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
    await expect(
      Gateway.reorderCutsInSceneViaGateway({ projectId, sceneId: new ObjectId().toString(), orderedIds: [] }),
    ).rejects.toThrow(/Video scene not found/);
  });

  it('deleteBeatViaGateway cascades to scenes and the cuts\' frame images', async () => {
    const beat = await makeBeat();
    const p = await cut(await scene(beat));
    const img = new ObjectId();
    const prev = new ObjectId();
    const endImg = new ObjectId();
    await VP.updateVideoPrompt(projectId, p._id, {
      start_frame: { image_id: img, previous_image_id: prev },
      end_frame: { image_id: endImg },
    });
    const res = await Gateway.deleteBeatViaGateway(projectId, beat._id.toString());
    expect(res.video_prompts_removed).toBe(1);
    expect(res.video_scenes_removed).toBe(1);
    expect(await VS.listVideoScenes({ projectId, beatId: beat._id })).toHaveLength(0);
    expect(deletedImages).toEqual(expect.arrayContaining([img.toString(), prev.toString(), endImg.toString()]));
  });

  it('deleteProjectCascade removes the video_scenes rows', async () => {
    const beat = await makeBeat();
    await scene(beat);
    const { deleteProjectCascade } = await import('../src/web/projectDelete.js');
    await createProject('Keeper');
    const result = await deleteProjectCascade(projectId);
    expect(result.deleted.video_scenes).toBe(1);
    expect(await fakeDb.collection('video_scenes').find({}).toArray()).toHaveLength(0);
  });
});

describe('video_prompts room (cuts + scenes)', () => {
  it('exposes title per scene and title/prompt/start_frame_prompt/end_frame_prompt per cut, and persists them', async () => {
    const beat = await makeBeat();
    const s = await scene(beat, 'The diner');
    const p = await Gateway.createVideoPromptViaGateway({
      projectId,
      sceneId: s._id.toString(),
      title: 'Cut 1',
      prompt: 'Wide from the counter end.',
      startFramePrompt: 'Frontal wide.',
      endFramePrompt: 'Door shut.',
    });
    const desc = await resolveRoom(buildRoomName('video_prompts', beat._id.toString()));
    expect(desc.type).toBe('video_prompts');
    const pid = p._id.toString();
    const sid = s._id.toString();
    expect(desc.fields).toEqual([
      `scene:${sid}:title`,
      `item:${pid}:title`,
      `item:${pid}:prompt`,
      `item:${pid}:start_frame_prompt`,
      `item:${pid}:end_frame_prompt`,
    ]);
    expect(desc.seed[`scene:${sid}:title`]).toBe('The diner');
    expect(desc.seed[`item:${pid}:start_frame_prompt`]).toBe('Frontal wide.');
    expect(desc.seed[`item:${pid}:end_frame_prompt`]).toBe('Door shut.');
    expect(desc.seed[`item:${pid}:prompt`]).toBe('Wide from the counter end.');

    const result = await desc.persistFields({
      [`scene:${sid}:title`]: 'The diner, night',
      [`item:${pid}:title`]: 'Cut 1',
      [`item:${pid}:prompt`]: 'Wide from the counter end, looking down the aisle.',
      [`item:${pid}:start_frame_prompt`]: 'Frontal wide, 24mm.',
      [`item:${pid}:end_frame_prompt`]: 'Door shut, Tom in the aisle.',
      'item:ffffffffffffffffffffffff:prompt': 'ignored',
      [`item:${pid}:bogus`]: 'ignored',
      [`scene:${sid}:floor_plan`]: 'ignored',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual([
      `scene:${sid}:title`,
      `item:${pid}:prompt`,
      `item:${pid}:start_frame_prompt`,
      `item:${pid}:end_frame_prompt`,
    ]);
    const stored = await VS.getVideoScene(projectId, s._id);
    expect(stored.title).toBe('The diner, night');
    const row = await VP.getVideoPrompt(projectId, p._id);
    expect(row.prompt).toBe('Wide from the counter end, looking down the aisle.');
    expect(row.start_frame.prompt).toBe('Frontal wide, 24mm.');
    expect(row.end_frame.prompt).toBe('Door shut, Tom in the aisle.');
    expect(row.title).toBe('Cut 1');
  });

  it('a frame prompt persisted by the room keeps the frame\'s image and references', async () => {
    const beat = await makeBeat();
    const p = await cut(await scene(beat));
    const img = new ObjectId();
    const ref = new ObjectId();
    await Gateway.setVideoPromptStartFrameViaGateway({
      projectId,
      promptId: p._id,
      startFrame: { image_id: img, prompt: 'old', reference_ids: [ref] },
    });
    const desc = await resolveRoom(buildRoomName('video_prompts', beat._id.toString()));
    await desc.persistFields({ [`item:${p._id}:start_frame_prompt`]: 'new' });
    const row = await VP.getVideoPrompt(projectId, p._id);
    expect(row.start_frame).toMatchObject({ prompt: 'new', image_id: img });
    expect(row.start_frame.reference_ids.map(String)).toEqual([ref.toString()]);
  });

  it('reads and writes the fragments through the gateway fallback branches', async () => {
    const beat = await makeBeat();
    const s = await scene(beat, 'ST');
    const p = await cut(s);
    await Gateway.setVideoPromptTextFieldViaGateway({ projectId, promptId: p._id, field: 'start_frame_prompt', text: 'SF' });
    // append reads the current value through the fallback read branch, then
    // writes through the fallback write branch.
    const entityId = beat._id.toString();
    await Gateway.appendEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `scene:${s._id}:title`, content: 'at night' });
    await Gateway.appendEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `item:${p._id}:start_frame_prompt`, content: '24mm.' });
    await Gateway.appendEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `item:${p._id}:end_frame_prompt`, content: 'Last.' });
    const stored = await VS.getVideoScene(projectId, s._id);
    expect(stored.title).toContain('ST');
    expect(stored.title).toContain('at night');
    const row = await VP.getVideoPrompt(projectId, p._id);
    expect(row.start_frame.prompt).toContain('SF');
    expect(row.start_frame.prompt).toContain('24mm.');
    expect(row.end_frame.prompt).toContain('Last.');
    await Gateway.setEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `scene:${s._id}:title`, markdown: 'Renamed' });
    expect((await VS.getVideoScene(projectId, s._id)).title).toBe('Renamed');
    await expect(
      Gateway.appendEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `item:${p._id}:nope`, content: 'x' }),
    ).rejects.toThrow(/unknown video_prompts field/);
    await expect(
      Gateway.appendEntityFieldMarkdown({ projectId, entityType: 'video_prompts', entityId, field: `scene:${s._id}:floor_plan`, content: 'x' }),
    ).rejects.toThrow(/unknown video_prompts field/);
  });
});
