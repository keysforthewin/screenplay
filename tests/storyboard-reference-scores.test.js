import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Storyboards = await import('../src/mongo/storyboards.js');

const beatA = new ObjectId();
let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function newFrame() {
  const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
  const { frameId } = await Storyboards.addFrame(sb._id);
  return { sbId: sb._id, frameId };
}

function frameOf(sb, frameId) {
  return sb.frames.find((f) => String(f._id) === String(frameId));
}

const a = new ObjectId().toString();
const b = new ObjectId().toString();
const c = new ObjectId().toString();

describe('frame reference_scores persistence', () => {
  it('setFrameReferenceImages stores the provided scores map', async () => {
    const { sbId, frameId } = await newFrame();
    const sb = await Storyboards.setFrameReferenceImages(sbId, frameId, [a, b], {
      [a]: 0.9,
      [b]: 0.4,
    });
    const frame = frameOf(sb, frameId);
    expect(frame.reference_ids.map(String)).toEqual([a, b]);
    expect(frame.reference_scores).toEqual({ [a]: 0.9, [b]: 0.4 });
  });

  it('setFrameReferenceImages prunes scores for ids no longer present', async () => {
    const { sbId, frameId } = await newFrame();
    await Storyboards.setFrameReferenceImages(sbId, frameId, [a, b], { [a]: 0.9, [b]: 0.4 });
    const sb = await Storyboards.setFrameReferenceImages(sbId, frameId, [a], { [a]: 0.9 });
    const frame = frameOf(sb, frameId);
    expect(frame.reference_ids.map(String)).toEqual([a]);
    expect(frame.reference_scores).toEqual({ [a]: 0.9 });
  });

  it('pushFrameReferenceImages merges new scores with existing ones', async () => {
    const { sbId, frameId } = await newFrame();
    await Storyboards.setFrameReferenceImages(sbId, frameId, [a], { [a]: 0.9 });
    const sb = await Storyboards.pushFrameReferenceImages(sbId, frameId, [b, c], {
      [b]: 0.7,
      [c]: 0.2,
    });
    const frame = frameOf(sb, frameId);
    expect(frame.reference_ids.map(String)).toEqual([a, b, c]);
    expect(frame.reference_scores).toEqual({ [a]: 0.9, [b]: 0.7, [c]: 0.2 });
  });

  it('manual set without scores leaves remaining ids unscored (pruned)', async () => {
    const { sbId, frameId } = await newFrame();
    await Storyboards.setFrameReferenceImages(sbId, frameId, [a, b], { [a]: 0.9, [b]: 0.4 });
    // Manual picker replaces the list with no score info.
    const sb = await Storyboards.setFrameReferenceImages(sbId, frameId, [b, c]);
    const frame = frameOf(sb, frameId);
    expect(frame.reference_ids.map(String)).toEqual([b, c]);
    // b's old score is retained; c is unscored; a is pruned.
    expect(frame.reference_scores).toEqual({ [b]: 0.4 });
  });

  it('pullFrameReferenceImage prunes the removed id from scores', async () => {
    const { sbId, frameId } = await newFrame();
    await Storyboards.setFrameReferenceImages(sbId, frameId, [a, b], { [a]: 0.9, [b]: 0.4 });
    const sb = await Storyboards.pullFrameReferenceImage(sbId, frameId, a);
    const frame = frameOf(sb, frameId);
    expect(frame.reference_ids.map(String)).toEqual([b]);
    expect(frame.reference_scores).toEqual({ [b]: 0.4 });
  });
});
