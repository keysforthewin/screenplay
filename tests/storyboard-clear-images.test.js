// Tests for clearing every frame image in a beat (the "Delete all images" core).
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

const deletedImageIds = [];
vi.mock('../src/mongo/images.js', () => ({
  deleteImage: vi.fn(async (id) => { deletedImageIds.push(String(id)); }),
  deleteImages: vi.fn(async (ids) => { for (const i of ids) deletedImageIds.push(String(i)); }),
  uploadGeneratedImage: vi.fn(async () => ({ _id: new ObjectId() })),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Gateway = await import('../src/web/gateway.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  deletedImageIds.length = 0;
});

function frameOf(sb, frameId) {
  return sb.frames.find((f) => f._id.toString() === String(frameId));
}

describe('clearAllFrameImagesForBeat', () => {
  it('nulls image_id + previous_image_id + last_edit_prompt on every frame, keeps prompt + references', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: '', body: '', characters: [] });
    const original = new ObjectId();
    const edited = new ObjectId();
    const ref = new ObjectId();
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, textPrompt: 'one' });
    const { frameId } = await Storyboards.addFrame(sb._id, { imageId: original, referenceIds: [ref] });
    await Storyboards.setFramePrompt(projectId, sb._id, frameId, 'keep me');
    // Rotate: image_id = edited (current), previous_image_id = original, last_edit_prompt = 'tweak'.
    await Storyboards.rotateFrameImageEdit({ id: sb._id, frameId, newImageId: edited, editPrompt: 'tweak' });

    const result = await Storyboards.clearAllFrameImagesForBeat(beat._id);

    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    const f = frameOf(fresh, frameId);
    expect(f.image_id).toBe(null);
    expect(f.previous_image_id).toBe(null);
    expect(f.last_edit_prompt).toBe('');
    expect(f.prompt).toBe('keep me');
    expect(f.reference_ids.map(String)).toEqual([ref.toString()]);
    expect(result.referencedIds.map(String)).toContain(ref.toString());
    expect(result.freedImageIds.map(String)).toEqual(
      expect.arrayContaining([original.toString(), edited.toString()]),
    );
    expect(result.storyboardIds.map(String)).toEqual([sb._id.toString()]);
  });

  it('only touches the target beat', async () => {
    const beatA = await Plots.createBeat({ projectId, name: 'A', desc: '', body: '', characters: [] });
    const beatB = await Plots.createBeat({ projectId, name: 'B', desc: '', body: '', characters: [] });
    const imgA = new ObjectId();
    const sbA = await Storyboards.createStoryboard({ projectId, beatId: beatA._id, textPrompt: 'a' });
    await Storyboards.addFrame(sbA._id, { imageId: imgA });
    const sbB = await Storyboards.createStoryboard({ projectId, beatId: beatB._id, textPrompt: 'b' });
    await Storyboards.addFrame(sbB._id, { imageId: new ObjectId() });

    await Storyboards.clearAllFrameImagesForBeat(beatB._id);

    const freshA = await Storyboards.getStoryboard(projectId, sbA._id);
    expect(freshA.frames[0].image_id.toString()).toBe(imgA.toString());
    const freshB = await Storyboards.getStoryboard(projectId, sbB._id);
    expect(freshB.frames[0].image_id).toBe(null);
  });

  it('is a no-op (empty results) when the beat has no storyboards', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'E', desc: '', body: '', characters: [] });
    const result = await Storyboards.clearAllFrameImagesForBeat(beat._id);
    expect(result).toEqual({ freedImageIds: [], referencedIds: [], storyboardIds: [] });
  });

  it('skips a storyboard whose frames have no images (no write, absent from storyboardIds)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: '', body: '', characters: [] });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, textPrompt: 'one' });
    await Storyboards.addFrame(sb._id, {}); // frame exists but has no image

    const result = await Storyboards.clearAllFrameImagesForBeat(beat._id);

    expect(result.freedImageIds).toEqual([]);
    expect(result.storyboardIds).toEqual([]);
    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    expect(fresh.frames[0].image_id).toBe(null); // still present, just untouched
  });
});

describe('clearAllFrameImagesForBeatViaGateway', () => {
  it('deletes freed blobs, skips referenced ids, and returns counts', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: '', body: '', characters: [] });
    const current = new ObjectId();
    const ref = new ObjectId();
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, textPrompt: 'one' });
    await Storyboards.addFrame(sb._id, { imageId: current, referenceIds: [ref] });
    // A second shot whose current image IS also used as a reference elsewhere:
    const shared = new ObjectId();
    const sb2 = await Storyboards.createStoryboard({ projectId, beatId: beat._id, textPrompt: 'two' });
    await Storyboards.addFrame(sb2._id, { imageId: shared, referenceIds: [shared] });

    const result = await Gateway.clearAllFrameImagesForBeatViaGateway({ projectId, beatId: beat._id });

    expect(result.cleared).toBe(2);
    // `current` is freed and not referenced → deleted. `shared` is referenced → kept.
    expect(deletedImageIds).toContain(current.toString());
    expect(deletedImageIds).not.toContain(shared.toString());
    expect(result.freed).toBe(deletedImageIds.length);

    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    expect(fresh.frames[0].image_id).toBe(null);
    expect(fresh.frames[0].reference_ids.map(String)).toEqual([ref.toString()]);
  });
});
