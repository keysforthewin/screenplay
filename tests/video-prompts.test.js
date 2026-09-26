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
