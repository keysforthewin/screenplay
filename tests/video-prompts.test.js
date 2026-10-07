// Unit tests for the `video_prompts` collection helpers (Scenes tab cuts).

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

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Prompts Test'))._id.toString();
});

async function makeBeat(name = 'Diner') {
  return Plots.createBeat({ projectId, name, desc: '', body: '' });
}

async function makeScene(beat, title = 'Scene') {
  return VS.createVideoScene({ projectId, beatId: beat._id, title });
}

describe('video_prompts normalizers', () => {
  it('normalizeReferenceIds keeps valid ids only, deduped, in order, capped', () => {
    const ids = Array.from({ length: VP.MAX_REFERENCE_IMAGES + 2 }, () => new ObjectId());
    const out = VP.normalizeReferenceIds([ids[0], ids[0].toString(), 'nope', 12, null, ...ids.slice(1).map(String)]);
    expect(VP.MAX_REFERENCE_IMAGES).toBe(9);
    expect(out).toHaveLength(9);
    expect(out.every((v) => v instanceof ObjectId)).toBe(true);
    expect(out.map(String)).toEqual(ids.slice(0, 9).map(String));
    expect(VP.normalizeReferenceIds('x')).toEqual([]);
    expect(VP.normalizeReferenceIds(undefined)).toEqual([]);
  });

  it('normalizeFrame keeps null and coerces the sub-doc to exactly the frame shape', () => {
    expect(VP.normalizeFrame(null)).toBeNull();
    expect(VP.normalizeFrame(undefined)).toBeNull();
    const img = new ObjectId();
    const ref = new ObjectId();
    const f = VP.normalizeFrame({
      image_id: img.toString(),
      prompt: 'Frontal medium.',
      reference_ids: [ref, 'x'],
      model: ' nano-banana-pro ',
      generated_at: '2026-09-30T00:00:00Z',
      // Planner-era keys are dropped.
      reference_scores: { [ref.toString()]: 0.8 },
      derive: true,
      continuity_image_id: img.toString(),
      master_image_id: img.toString(),
      references_planned: true,
    });
    expect(Object.keys(f)).toEqual(['image_id', 'prompt', 'reference_ids', 'model', 'generated_at', 'previous_image_id']);
    expect(f.image_id.toString()).toBe(img.toString());
    expect(f.prompt).toBe('Frontal medium.');
    expect(f.reference_ids.map(String)).toEqual([ref.toString()]);
    expect(f.model).toBe('nano-banana-pro');
    expect(f.generated_at).toBeInstanceOf(Date);
    expect(f.previous_image_id).toBeNull();
    expect(VP.normalizeFrame({})).toEqual({
      image_id: null,
      prompt: '',
      reference_ids: [],
      model: null,
      generated_at: null,
      previous_image_id: null,
    });
    expect(VP.normalizeFrame({ image_id: 'bad', generated_at: 'not a date', previous_image_id: img })).toMatchObject({
      image_id: null,
      generated_at: null,
      previous_image_id: img,
    });
    expect(VP.normalizeFrame('junk')).toMatchObject({ image_id: null, prompt: '' });
  });

  it('the planner-era exports are gone', () => {
    expect([...VP.VIDEO_PROVIDERS]).toEqual(['fal', 'comfy']);
    for (const name of [
      'normalizeStartFrame',
      'normalizeCamera',
      'normalizeInFrame',
      'normalizeDialogIds',
      'normalizeLint',
      'normalizeFrameCheck',
      'normalizeReferenceImages',
      'reorderVideoPromptsForBeat',
    ]) {
      expect(VP[name]).toBeUndefined();
    }
  });
});

describe('video_prompts collection (cuts)', () => {
  it('createVideoPrompt requires a scene, appends with contiguous order and cut_index, stamps project_id', async () => {
    const beat = await makeBeat();
    const s1 = await makeScene(beat, 'S1');
    const s2 = await makeScene(beat, 'S2');
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, title: 'A', prompt: 'p1' });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id.toString(), title: 'B', prompt: 'p2' });
    const c = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s2._id, title: 'C' });
    expect([a.order, b.order, c.order]).toEqual([1, 2, 3]);
    expect([a.cut_index, b.cut_index, c.cut_index]).toEqual([1, 2, 1]);
    expect(a.project_id).toBe(projectId);
    expect(a.scene_id.toString()).toBe(s1._id.toString());
    expect(a.duration_seconds).toBeNull();
    expect(a.start_frame).toBeNull();
    expect(a.end_frame).toBeNull();
    expect(a.video_file_id).toBeNull();
    expect(a.video_provider).toBeNull();
    const list = await VP.listVideoPrompts({ beatId: beat._id });
    expect(list.map((p) => p.title)).toEqual(['A', 'B', 'C']);
    expect((await VP.listVideoPromptsForScene(s1._id)).map((p) => p.title)).toEqual(['A', 'B']);
    await expect(VP.createVideoPrompt({ projectId, beatId: beat._id })).rejects.toThrow(/sceneId required/);
    await expect(VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: 'nope' })).rejects.toThrow(/sceneId required/);
    await expect(VP.createVideoPrompt({ projectId, sceneId: s1._id })).rejects.toThrow(/beatId required/);
  });

  it('createVideoPrompt stores exactly the cut shape (id, length, both frames; no planner fields)', async () => {
    const beat = await makeBeat();
    const scene = await makeScene(beat);
    const id = new ObjectId();
    const ref = new ObjectId();
    const cut = await VP.createVideoPrompt({
      id,
      projectId,
      beatId: beat._id,
      sceneId: scene._id,
      cutIndex: 4,
      order: 7,
      title: 'Cup',
      prompt: 'She slides the cup.',
      durationSeconds: 2.3,
      startFrame: { prompt: 'Booth, wide.', reference_ids: [ref] },
      endFrame: { prompt: 'Her hand on the cup.' },
      // Ignored: the shot table is gone.
      camera: { size: 'wide' },
      inFrame: [{ character: 'Sarah' }],
      dialogIds: [new ObjectId()],
      lockLine: 'Same light.',
    });
    expect(cut._id.toString()).toBe(id.toString());
    expect(cut.cut_index).toBe(4);
    expect(cut.order).toBe(7);
    expect(cut.duration_seconds).toBe(2.5); // half-second steps
    expect(cut.start_frame).toMatchObject({ prompt: 'Booth, wide.', image_id: null, previous_image_id: null });
    expect(cut.start_frame.reference_ids.map(String)).toEqual([ref.toString()]);
    expect(cut.end_frame.prompt).toBe('Her hand on the cup.');
    const stored = fakeDb.collection('video_prompts')._docs[0];
    for (const gone of [
      'camera',
      'in_frame',
      'dialog_ids',
      'lock_line',
      'reference_images',
      'reference_binding',
      'exclusions',
      'lint',
      'frame_check',
      'trim_head_seconds',
      'trim_tail_seconds',
      'audio_file_id',
    ]) {
      expect(stored).not.toHaveProperty(gone);
      expect(cut).not.toHaveProperty(gone);
    }
    await expect(
      VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: scene._id, durationSeconds: -1 }),
    ).rejects.toThrow(/positive/);
  });

  it('updateVideoPrompt whitelists fields and clamps/validates scalars', async () => {
    const beat = await makeBeat();
    const scene = await makeScene(beat);
    const p = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: scene._id });
    const fileId = new ObjectId();
    const updated = await VP.updateVideoPrompt(projectId, p._id, {
      title: 'T',
      prompt: 'Sarah slides the cup.',
      duration_seconds: 12.4,
      video_file_id: fileId.toString(),
      video_duration_seconds: '5',
      video_cost_usd: 0.25,
      video_model_id: 'm',
      video_generated_at: '2026-10-04T00:00:00Z',
      video_parameters: { seed: 3 },
      video_provider: 'comfy',
      video_comfy: { template: 'video_ltx2_5_i2v' },
    });
    expect(updated.title).toBe('T');
    expect(updated.prompt).toBe('Sarah slides the cup.');
    expect(updated.duration_seconds).toBe(12.5); // half-second steps
    expect(updated.video_file_id.toString()).toBe(fileId.toString());
    expect(updated.video_duration_seconds).toBe(5);
    expect(updated.video_cost_usd).toBe(0.25);
    expect(updated.video_model_id).toBe('m');
    expect(updated.video_generated_at).toBeInstanceOf(Date);
    expect(updated.video_parameters).toEqual({ seed: 3 });
    expect(updated.video_provider).toBe('comfy');
    expect(updated.video_comfy).toEqual({ template: 'video_ltx2_5_i2v' });
    expect((await VP.updateVideoPrompt(projectId, p._id, { duration_seconds: 0.1 })).duration_seconds).toBe(0.5);
    expect((await VP.updateVideoPrompt(projectId, p._id, { duration_seconds: null })).duration_seconds).toBeNull();
    const cleared = await VP.updateVideoPrompt(projectId, p._id, { video_file_id: null, video_provider: 'bogus', video_comfy: 'x' });
    expect(cleared).toMatchObject({ video_file_id: null, video_provider: null, video_comfy: null });
    await expect(VP.updateVideoPrompt(projectId, p._id, { bogus: 1 })).rejects.toThrow(/unknown field/);
    for (const gone of ['reference_images', 'trim_head_seconds', 'camera', 'lint', 'frame_check', 'dialog_ids', 'audio_file_id', 'scene_id']) {
      await expect(VP.updateVideoPrompt(projectId, p._id, { [gone]: null })).rejects.toThrow(/unknown field/);
    }
    await expect(VP.updateVideoPrompt(projectId, p._id, { duration_seconds: -3 })).rejects.toThrow(/positive/);
    await expect(VP.updateVideoPrompt(projectId, p._id, { video_cost_usd: -1 })).rejects.toThrow(/non-negative/);
    await expect(VP.updateVideoPrompt(projectId, p._id, { video_file_id: 'bad' })).rejects.toThrow(/invalid file id/);
    await expect(VP.updateVideoPrompt(projectId, p._id, { order: 'x' })).rejects.toThrow(/order must be/);
    await expect(VP.updateVideoPrompt(projectId, p._id, { cut_index: 'x' })).rejects.toThrow(/cut_index/);
    await expect(VP.updateVideoPrompt(projectId, p._id, {})).rejects.toThrow(/no changes/);
  });

  it('start_frame_prompt / end_frame_prompt create the sub-doc, then edit it in place', async () => {
    const beat = await makeBeat();
    const scene = await makeScene(beat);
    const p = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: scene._id });
    const u1 = await VP.updateVideoPrompt(projectId, p._id, {
      start_frame_prompt: 'Frontal close-up of the woman.',
      end_frame_prompt: 'She has turned away.',
    });
    expect(u1.start_frame).toMatchObject({ prompt: 'Frontal close-up of the woman.', image_id: null, reference_ids: [] });
    expect(u1.end_frame).toMatchObject({ prompt: 'She has turned away.', image_id: null });
    const img = new ObjectId();
    const ref = new ObjectId();
    const u2 = await VP.updateVideoPrompt(projectId, p._id, {
      start_frame: { image_id: img, prompt: 'kept', model: 'gemini', reference_ids: [ref] },
    });
    expect(u2.start_frame.image_id.toString()).toBe(img.toString());
    // Dotted update into an existing sub-doc keeps the image and references.
    const u3 = await VP.updateVideoPrompt(projectId, p._id, { start_frame_prompt: 'edited' });
    expect(u3.start_frame.prompt).toBe('edited');
    expect(u3.start_frame.image_id.toString()).toBe(img.toString());
    expect(u3.start_frame.model).toBe('gemini');
    expect(u3.start_frame.reference_ids.map(String)).toEqual([ref.toString()]);
    expect(u3.end_frame.prompt).toBe('She has turned away.');
    // A frame and its prompt in one patch: the prompt lands on the new sub-doc.
    const u4 = await VP.updateVideoPrompt(projectId, p._id, { end_frame: { image_id: img }, end_frame_prompt: 'both' });
    expect(u4.end_frame.prompt).toBe('both');
    expect(u4.end_frame.image_id.toString()).toBe(img.toString());
    const cleared = await VP.updateVideoPrompt(projectId, p._id, { start_frame: null });
    expect(cleared.start_frame).toBeNull();
    expect(cleared.end_frame.prompt).toBe('both');
  });

  it('normalizeKeyframes drops unusable entries, dedupes, clamps into the cut and sorts by time', () => {
    const a = new ObjectId();
    const b = new ObjectId();
    const img = new ObjectId();
    const out = VP.normalizeKeyframes(
      [
        { id: b, at_seconds: 9.9, strength: 1.7, image_id: img, prompt: 'late' },
        { id: a, at_seconds: 1.26, strength: -1 },
        { id: a.toString(), at_seconds: 3 }, // duplicate id
        { at_seconds: 0 }, // unusable time
        { at_seconds: 'x' },
        'junk',
      ],
      { durationSeconds: 8 },
    );
    expect(out.map((k) => k.id.toString())).toEqual([a.toString(), b.toString()]);
    expect(out[0]).toMatchObject({ at_seconds: 1.5, strength: 0, image_id: null, prompt: '', reference_ids: [] });
    expect(out[1]).toMatchObject({ at_seconds: 7.5, strength: 1, prompt: 'late' }); // clamped to duration − 0.5
    expect(out[1].image_id.toString()).toBe(img.toString());
    expect(VP.normalizeKeyframes(undefined)).toEqual([]);
    // No duration known: times are kept.
    expect(VP.normalizeKeyframes([{ at_seconds: 40 }])[0].at_seconds).toBe(40);
    // An entry without an id gets one.
    expect(VP.normalizeKeyframes([{ at_seconds: 2 }])[0].id).toBeInstanceOf(ObjectId);
    expect(VP.normalizeStrength(null)).toBeNull();
    expect(VP.normalizeStrength('0.456')).toBe(0.46);
  });

  it('keyframes: create, add, prompt via arrayFilters, update, duration shrink clamps, remove', async () => {
    const beat = await makeBeat();
    const scene = await makeScene(beat);
    const p = await VP.createVideoPrompt({
      projectId,
      beatId: beat._id,
      sceneId: scene._id,
      durationSeconds: 10,
      keyframes: [{ at_seconds: 6, prompt: 'apex' }],
    });
    expect(p.keyframes).toHaveLength(1);
    expect(p.keyframes[0]).toMatchObject({ at_seconds: 6, strength: null, prompt: 'apex', image_id: null });

    const pre = new ObjectId();
    const u1 = await VP.addVideoPromptKeyframe(projectId, p._id, { id: pre, at_seconds: 2.5, strength: 0.5, prompt: 'rise' });
    expect(u1.keyframes.map((k) => k.at_seconds)).toEqual([2.5, 6]); // sorted
    expect(u1.keyframes[0].id.toString()).toBe(pre.toString());
    const apexId = u1.keyframes[1].id.toString();

    // The y-doc persist path edits ONE element in place and keeps the rest.
    const u2 = await VP.updateVideoPrompt(projectId, p._id, { keyframe_prompts: { [apexId]: 'apex, edited', [new ObjectId().toString()]: 'gone' } });
    expect(u2.keyframes[1].prompt).toBe('apex, edited');
    expect(u2.keyframes[0].prompt).toBe('rise');
    await expect(VP.updateVideoPrompt(projectId, p._id, { keyframes: [], keyframe_prompts: {} })).rejects.toThrow(/cannot be set in one patch/);
    // Only unknown ids → nothing to set.
    await expect(VP.updateVideoPrompt(projectId, p._id, { keyframe_prompts: { [new ObjectId().toString()]: 'x' } })).rejects.toThrow(/no changes/);

    const img = new ObjectId();
    const u3 = await VP.updateVideoPromptKeyframe(projectId, p._id, apexId, { image_id: img, model: 'nano', at_seconds: 1 });
    expect(u3.keyframes.map((k) => k.at_seconds)).toEqual([1, 2.5]); // moved and re-sorted
    expect(u3.keyframes[0].id.toString()).toBe(apexId);
    expect(u3.keyframes[0].image_id.toString()).toBe(img.toString());
    expect(u3.keyframes[0].prompt).toBe('apex, edited');
    await expect(VP.updateVideoPromptKeyframe(projectId, p._id, new ObjectId().toString(), { at_seconds: 1 })).rejects.toThrow(/Keyframe not found/);

    // Shrinking the cut pulls keyframes inside the new length.
    const u4 = await VP.updateVideoPrompt(projectId, p._id, { duration_seconds: 2 });
    expect(u4.keyframes.map((k) => k.at_seconds)).toEqual([1, 1.5]);

    const u5 = await VP.removeVideoPromptKeyframe(projectId, p._id, apexId);
    expect(u5.keyframes.map((k) => k.id.toString())).toEqual([pre.toString()]);
    await expect(VP.removeVideoPromptKeyframe(projectId, p._id, apexId)).rejects.toThrow(/Keyframe not found/);
    await expect(VP.addVideoPromptKeyframe(projectId, p._id, { at_seconds: -2 })).rejects.toThrow(/positive/);
  });

  it('getVideoPrompt verifies the project — a cross-project id behaves as not-found', async () => {
    const beat = await makeBeat();
    const scene = await makeScene(beat);
    const p = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: scene._id });
    const other = (await createProject('Other'))._id.toString();
    expect(await VP.getVideoPrompt(projectId, p._id)).not.toBeNull();
    expect(await VP.getVideoPrompt(other, p._id)).toBeNull();
    expect(await VP.getVideoPrompt(projectId, 'not-an-id')).toBeNull();
    await expect(VP.updateVideoPrompt(other, p._id, { title: 'x' })).rejects.toThrow(/not found/);
  });

  it('deleteVideoPrompt / deleteVideoPromptsForBeat remove only their rows; counts are per beat', async () => {
    const beatA = await makeBeat('A');
    const beatB = await makeBeat('B');
    const sa = await makeScene(beatA);
    const sb = await makeScene(beatB);
    const a1 = await VP.createVideoPrompt({ projectId, beatId: beatA._id, sceneId: sa._id });
    await VP.createVideoPrompt({ projectId, beatId: beatA._id, sceneId: sa._id });
    await VP.createVideoPrompt({ projectId, beatId: beatB._id, sceneId: sb._id });
    await VP.createVideoPrompt({ projectId, beatId: beatB._id, sceneId: sb._id });
    const counts = await VP.countVideoPromptsByBeat(projectId);
    expect(counts.get(beatA._id.toString())).toBe(2);
    expect(counts.get(beatB._id.toString())).toBe(2);
    const gone = await VP.deleteVideoPrompt(a1._id);
    expect(gone._id.toString()).toBe(a1._id.toString());
    await expect(VP.deleteVideoPrompt(a1._id)).rejects.toThrow(/not found/);
    const removed = await VP.deleteVideoPromptsForBeat(beatB._id);
    expect(removed).toHaveLength(2);
    expect(await VP.listVideoPrompts({ beatId: beatB._id })).toHaveLength(0);
    expect(await VP.listVideoPrompts({ beatId: beatA._id })).toHaveLength(1);
    expect((await VP.listVideoPrompts({ projectId })).length).toBe(1);
  });

  it('recomputeCutOrderForBeat orders scene by scene, renumbering cut_index', async () => {
    const beat = await makeBeat();
    const s1 = await makeScene(beat, 'S1');
    const s2 = await makeScene(beat, 'S2');
    // Created out of scene order on purpose: scene 2 first, then scene 1.
    await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 's2a', sceneId: s2._id, cutIndex: 5 });
    await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 's2b', sceneId: s2._id, cutIndex: 9 });
    await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 's1a', sceneId: s1._id });
    const rows = await VP.recomputeCutOrderForBeat(beat._id, [s1._id.toString(), s2._id.toString()]);
    expect(rows.map((r) => [r.title, r.order, r.cut_index])).toEqual([
      ['s1a', 1, 1],
      ['s2a', 2, 1],
      ['s2b', 3, 2],
    ]);
    // Without an explicit scene order the stored scene order is used.
    await VS.reorderVideoScenesForBeat(beat._id, [s2._id, s1._id]);
    const rows2 = await VP.recomputeCutOrderForBeat(beat._id);
    expect(rows2.map((r) => r.title)).toEqual(['s2a', 's2b', 's1a']);
    expect(rows2.map((r) => r.order)).toEqual([1, 2, 3]);
  });

  it('reorderCutsInScene renumbers cut_index within the scene and the global order', async () => {
    const beat = await makeBeat();
    const s1 = await makeScene(beat, 'S1');
    const s2 = await makeScene(beat, 'S2');
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'a', sceneId: s1._id });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'b', sceneId: s1._id });
    const c = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'c', sceneId: s2._id });
    const inScene = await VP.reorderCutsInScene(s1._id, [b._id, a._id]);
    expect(inScene.map((r) => [r.title, r.cut_index])).toEqual([['b', 1], ['a', 2]]);
    const all = await VP.listVideoPrompts({ beatId: beat._id });
    expect(all.map((r) => [r.title, r.order])).toEqual([['b', 1], ['a', 2], ['c', 3]]);
    await expect(VP.reorderCutsInScene(s1._id, [a._id])).rejects.toThrow(/length/);
    await expect(VP.reorderCutsInScene(s1._id, [a._id, a._id])).rejects.toThrow(/duplicate/);
    await expect(VP.reorderCutsInScene(s1._id, [a._id, c._id])).rejects.toThrow(/not in this scene/);
    const removed = await VP.deleteVideoPromptsForScene(s1._id);
    expect(removed.map((r) => r.title)).toEqual(['b', 'a']);
    expect(await VP.listVideoPrompts({ beatId: beat._id })).toHaveLength(1);
  });
});
