// Unit tests for the `video_prompts` collection helpers (Prompts tab rows).

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

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Prompts Test'))._id.toString();
});

async function makeBeat(name = 'Diner') {
  return Plots.createBeat({ projectId, name, desc: '', body: '' });
}

describe('video_prompts collection', () => {
  it('createVideoPrompt appends with contiguous order and stamps project_id', async () => {
    const beat = await makeBeat();
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'A', prompt: 'p1' });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'B', prompt: 'p2' });
    expect(a.order).toBe(1);
    expect(b.order).toBe(2);
    expect(a.project_id).toBe(projectId);
    expect(a.video_file_id).toBeNull();
    expect(a.reference_images).toEqual([]);
    const list = await VP.listVideoPrompts({ beatId: beat._id });
    expect(list.map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('normalizes reference_images: valid ids only, deduped, capped at 9', () => {
    const ids = Array.from({ length: 11 }, () => new ObjectId().toString());
    const refs = VP.normalizeReferenceImages([
      { image_id: ids[0], owner_type: 'character', owner_name: 'Sarah', label: 'Sarah — sheet' },
      { image_id: ids[0], owner_type: 'character', owner_name: 'Sarah', label: 'dupe' },
      ...ids.slice(1).map((id) => ({ image_id: id, owner_type: 'set', owner_name: 'Diner' })),
    ]);
    expect(refs).toHaveLength(9);
    expect(refs[0].image_id.toString()).toBe(ids[0]);
    expect(refs[0].label).toBe('Sarah — sheet');
    expect(refs[1].owner_type).toBe('set');
    expect(() => VP.normalizeReferenceImages([{ image_id: 'nope' }])).toThrow(/invalid image_id/);
    expect(() => VP.normalizeReferenceImages('x')).toThrow(/array/);
  });

  it('updateVideoPrompt whitelists fields and clamps/validates scalars', async () => {
    const beat = await makeBeat();
    const p = await VP.createVideoPrompt({ projectId, beatId: beat._id });
    const imageId = new ObjectId();
    const updated = await VP.updateVideoPrompt(projectId, p._id, {
      title: 'T',
      prompt: '@Image1 is Sarah.',
      duration_seconds: 12.4,
      reference_images: [{ image_id: imageId, owner_type: 'character', owner_name: 'Sarah', label: 'x' }],
      video_file_id: null,
    });
    expect(updated.title).toBe('T');
    expect(updated.duration_seconds).toBe(12);
    expect(updated.reference_images[0].image_id.toString()).toBe(imageId.toString());
    await expect(VP.updateVideoPrompt(projectId, p._id, { bogus: 1 })).rejects.toThrow(/unknown field/);
    await expect(VP.updateVideoPrompt(projectId, p._id, { duration_seconds: -3 })).rejects.toThrow(/positive/);
    await expect(VP.updateVideoPrompt(projectId, p._id, {})).rejects.toThrow(/no changes/);
  });

  it('getVideoPrompt verifies the project — a cross-project id behaves as not-found', async () => {
    const beat = await makeBeat();
    const p = await VP.createVideoPrompt({ projectId, beatId: beat._id });
    const other = (await createProject('Other'))._id.toString();
    expect(await VP.getVideoPrompt(projectId, p._id)).not.toBeNull();
    expect(await VP.getVideoPrompt(other, p._id)).toBeNull();
    await expect(VP.updateVideoPrompt(other, p._id, { title: 'x' })).rejects.toThrow(/not found/);
  });

  it('reorderVideoPromptsForBeat requires the full id set with no duplicates', async () => {
    const beat = await makeBeat();
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'A' });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'B' });
    const c = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'C' });
    const after = await VP.reorderVideoPromptsForBeat(beat._id, [c._id, a._id, b._id]);
    expect(after.map((p) => p.title)).toEqual(['C', 'A', 'B']);
    expect(after.map((p) => p.order)).toEqual([1, 2, 3]);
    await expect(VP.reorderVideoPromptsForBeat(beat._id, [a._id, b._id])).rejects.toThrow(/length/);
    await expect(VP.reorderVideoPromptsForBeat(beat._id, [a._id, a._id, b._id])).rejects.toThrow(/duplicate/);
    await expect(
      VP.reorderVideoPromptsForBeat(beat._id, [a._id, b._id, new ObjectId()]),
    ).rejects.toThrow(/not in this beat/);
  });

  it('deleteVideoPromptsForBeat removes only that beat and counts per beat', async () => {
    const beatA = await makeBeat('A');
    const beatB = await makeBeat('B');
    await VP.createVideoPrompt({ projectId, beatId: beatA._id });
    await VP.createVideoPrompt({ projectId, beatId: beatB._id });
    await VP.createVideoPrompt({ projectId, beatId: beatB._id });
    const counts = await VP.countVideoPromptsByBeat(projectId);
    expect(counts.get(beatA._id.toString())).toBe(1);
    expect(counts.get(beatB._id.toString())).toBe(2);
    const removed = await VP.deleteVideoPromptsForBeat(beatB._id);
    expect(removed).toHaveLength(2);
    expect(await VP.listVideoPrompts({ beatId: beatB._id })).toHaveLength(0);
    expect(await VP.listVideoPrompts({ beatId: beatA._id })).toHaveLength(1);
  });
});

describe('video_prompts rows as cuts', () => {
  it('normalizeCamera coerces enums (unknown → null) and lens_mm to a positive integer', () => {
    const cam = VP.normalizeCamera({
      size: 'Close-up',
      angle: 'LOW',
      height: ' deck height ',
      lens_mm: '85.4',
      side: 'from the counter side',
      movement: 'push in',
      motivation: 'follows her reach',
      depth_of_field: 'shallow',
      lighting: 'one warm tungsten lamp overhead',
    });
    expect(cam).toEqual({
      size: 'close_up',
      angle: 'low',
      height: 'deck height',
      lens_mm: 85,
      side: 'from the counter side',
      movement: 'push_in',
      motivation: 'follows her reach',
      depth_of_field: 'shallow',
      lighting: 'one warm tungsten lamp overhead',
    });
    const odd = VP.normalizeCamera({ size: 'gigantic', angle: 'sideways', lens_mm: -3, movement: 'zoom' });
    expect(odd.size).toBeNull();
    expect(odd.angle).toBeNull();
    expect(odd.lens_mm).toBeNull();
    expect(odd.movement).toBeNull();
    expect(VP.normalizeCamera(null).side).toBe('');
  });

  it('normalizeInFrame drops nameless entries; normalizeDialogIds dedupes and skips junk', () => {
    expect(
      VP.normalizeInFrame([
        { character: 'Sarah', position: 'window booth', facing: 'the door', acts: 'true' },
        { position: 'nowhere' },
        'junk',
        { character: ' Tom ' },
      ]),
    ).toEqual([
      { character: 'Sarah', position: 'window booth', facing: 'the door', acts: true },
      { character: 'Tom', position: '', facing: '', acts: false },
    ]);
    const a = new ObjectId();
    const ids = VP.normalizeDialogIds([a, a.toString(), 'nope', 12, new ObjectId().toString()]);
    expect(ids).toHaveLength(2);
    expect(ids[0].toString()).toBe(a.toString());
  });

  it('normalizeStartFrame keeps null and coerces the sub-doc; normalizeLint defaults severity', () => {
    expect(VP.normalizeStartFrame(null)).toBeNull();
    const img = new ObjectId();
    const ref = new ObjectId();
    const sf = VP.normalizeStartFrame({
      image_id: img.toString(),
      prompt: 'Frontal medium.',
      reference_ids: [ref, 'x'],
      reference_scores: { [ref.toString()]: '0.8', junk: 1 },
      model: 'nano-banana-pro',
      generated_at: '2026-09-30T00:00:00Z',
    });
    expect(sf.image_id.toString()).toBe(img.toString());
    expect(sf.reference_ids.map(String)).toEqual([ref.toString()]);
    expect(sf.reference_scores).toEqual({ [ref.toString()]: 0.8 });
    expect(sf.generated_at).toBeInstanceOf(Date);
    expect(sf.previous_image_id).toBeNull();
    expect(VP.normalizeLint([{ code: 'trap_phrase', message: 'x' }, { message: 'y', severity: 'error' }, {}])).toEqual([
      { code: 'trap_phrase', severity: 'warn', message: 'x' },
      { code: 'lint', severity: 'error', message: 'y' },
    ]);
  });

  it('createVideoPrompt stores the cut fields and assigns cut_index within a scene', async () => {
    const beat = await makeBeat();
    const sceneId = new ObjectId();
    const dialogId = new ObjectId();
    const a = await VP.createVideoPrompt({
      projectId,
      beatId: beat._id,
      sceneId,
      camera: { size: 'wide', movement: 'static', lens_mm: 24 },
      inFrame: [{ character: 'Sarah', position: 'booth', facing: 'door', acts: true }],
      actionBy: 'Sarah',
      action: 'pushes the cup one inch toward him',
      others: 'the waitress keeps wiping',
      lastFrame: 'her hand still on the cup',
      sound: 'rain on the glass',
      charactersInScene: ['Sarah'],
      setsInScene: ['Diner'],
      primarySpend: 'identity',
      dialogIds: [dialogId],
      lockLine: 'Same light: warm tubes. Sarah: seated, facing the door. Camera at the counter end.',
      exclusions: ['Do not show Tom leaving yet.'],
      lint: [{ code: 'bare_feeling', message: 'furious' }],
    });
    expect(a.scene_id.toString()).toBe(sceneId.toString());
    expect(a.cut_index).toBe(1);
    expect(a.camera.size).toBe('wide');
    expect(a.in_frame[0].acts).toBe(true);
    expect(a.primary_spend).toBe('identity');
    expect(a.dialog_ids.map(String)).toEqual([dialogId.toString()]);
    expect(a.lint[0].severity).toBe('warn');
    expect(a.start_frame).toBeNull();
    expect(a.video_provider).toBeNull();
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId });
    expect(b.cut_index).toBe(2);
    const flat = await VP.createVideoPrompt({ projectId, beatId: beat._id });
    expect(flat.scene_id).toBeNull();
    expect(flat.cut_index).toBeNull();
    expect(await VP.listVideoPromptsForScene(sceneId)).toHaveLength(2);
  });

  it('updateVideoPrompt accepts the cut fields and start_frame_prompt creates the sub-doc', async () => {
    const beat = await makeBeat();
    const p = await VP.createVideoPrompt({ projectId, beatId: beat._id });
    const u1 = await VP.updateVideoPrompt(projectId, p._id, {
      camera: { size: 'close_up', angle: 'eye_level' },
      reaction: true,
      eyeline: 'past the lens toward the door',
      start_frame_prompt: 'Frontal close-up of the woman.',
      video_provider: 'comfy',
      video_comfy: { template: 'video_ltx2_5_i2v' },
    });
    expect(u1.camera.size).toBe('close_up');
    expect(u1.reaction).toBe(true);
    expect(u1.start_frame).not.toBeNull();
    expect(u1.start_frame.prompt).toBe('Frontal close-up of the woman.');
    expect(u1.start_frame.image_id).toBeNull();
    expect(u1.video_provider).toBe('comfy');
    expect(u1.video_comfy).toEqual({ template: 'video_ltx2_5_i2v' });
    const img = new ObjectId();
    const u2 = await VP.updateVideoPrompt(projectId, p._id, {
      start_frame: { image_id: img, prompt: 'kept', model: 'gemini' },
    });
    expect(u2.start_frame.image_id.toString()).toBe(img.toString());
    // Dotted update into an existing sub-doc keeps the image.
    const u3 = await VP.updateVideoPrompt(projectId, p._id, { start_frame_prompt: 'edited' });
    expect(u3.start_frame.prompt).toBe('edited');
    expect(u3.start_frame.image_id.toString()).toBe(img.toString());
    expect(u3.start_frame.model).toBe('gemini');
    await expect(VP.updateVideoPrompt(projectId, p._id, { scene_id: 'bad' })).rejects.toThrow(/scene_id/);
    await expect(VP.updateVideoPrompt(projectId, p._id, { cut_index: 'x' })).rejects.toThrow(/cut_index/);
    const cleared = await VP.updateVideoPrompt(projectId, p._id, { start_frame: null, video_provider: 'bogus' });
    expect(cleared.start_frame).toBeNull();
    expect(cleared.video_provider).toBeNull();
  });

  it('recomputeCutOrderForBeat orders scene by scene, then unsorted rows, renumbering cut_index', async () => {
    const beat = await makeBeat();
    const VS = await import('../src/mongo/videoScenes.js');
    const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'S1' });
    const s2 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'S2' });
    // Created out of scene order on purpose: a flat row first, then scene 2, then scene 1.
    const flat = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'flat' });
    const s2a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 's2a', sceneId: s2._id, cutIndex: 5 });
    const s2b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 's2b', sceneId: s2._id, cutIndex: 9 });
    const s1a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 's1a', sceneId: s1._id });
    const rows = await VP.recomputeCutOrderForBeat(beat._id, [s1._id.toString(), s2._id.toString()]);
    expect(rows.map((r) => [r.title, r.order, r.cut_index])).toEqual([
      ['s1a', 1, 1],
      ['s2a', 2, 1],
      ['s2b', 3, 2],
      ['flat', 4, null],
    ]);
    // Without an explicit scene order the stored scene order is used.
    await VS.reorderVideoScenesForBeat(beat._id, [s2._id, s1._id]);
    const rows2 = await VP.recomputeCutOrderForBeat(beat._id);
    expect(rows2.map((r) => r.title)).toEqual(['s2a', 's2b', 's1a', 'flat']);
    void flat; void s2a; void s2b; void s1a;
  });

  it('reorderCutsInScene renumbers cut_index within the scene and the global order', async () => {
    const beat = await makeBeat();
    const VS = await import('../src/mongo/videoScenes.js');
    const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'S1' });
    const s2 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'S2' });
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'a', sceneId: s1._id });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'b', sceneId: s1._id });
    const c = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'c', sceneId: s2._id });
    const inScene = await VP.reorderCutsInScene(s1._id, [b._id, a._id]);
    expect(inScene.map((r) => [r.title, r.cut_index])).toEqual([['b', 1], ['a', 2]]);
    const all = await VP.listVideoPrompts({ beatId: beat._id });
    expect(all.map((r) => [r.title, r.order])).toEqual([['b', 1], ['a', 2], ['c', 3]]);
    await expect(VP.reorderCutsInScene(s1._id, [a._id])).rejects.toThrow(/length/);
    await expect(VP.reorderCutsInScene(s1._id, [a._id, c._id])).rejects.toThrow(/not in this scene/);
    const removed = await VP.deleteVideoPromptsForScene(s1._id);
    expect(removed.map((r) => r.title)).toEqual(['b', 'a']);
    expect(await VP.listVideoPrompts({ beatId: beat._id })).toHaveLength(1);
  });
});
