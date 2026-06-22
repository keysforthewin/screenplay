// Bulk reference reassignment job: wipes every frame's references and re-runs
// the scored auto-suggest pipeline across all frames in a beat.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Gateway = await import('../src/web/gateway.js');
const Selector = await import('../src/llm/frameReferenceSelector.js');
const Jobs = await import('../src/web/storyboardReferenceJobs.js');

let projectId;
let beat;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  beat = await Plots.createBeat({ projectId, name: 'B1', body: 'INT. ROOM — DAY', characters: [] });
  Selector._setFrameReferenceScorerForTests(null);
});

async function waitForJob(jobId, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Jobs.getReassignReferencesJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish in time');
}

describe('startReassignReferencesJob', () => {
  it('wipes existing references on every frame when selection returns nothing', async () => {
    // No beat artworks → selectFrameReferencesForShot returns [] → frames wiped.
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 'a shot' });
    const { frameId } = await Gateway.addStoryboardFrameViaGateway({
      projectId, storyboardId: sb._id, prompt: 'frame prompt',
    });
    const seedId = new ObjectId().toString();
    await Gateway.setStoryboardFrameReferenceImagesViaGateway({
      projectId, storyboardId: sb._id, frameId, imageIds: [seedId], mode: 'replace', scores: { [seedId]: 0.9 },
    });

    const { job_id } = await Jobs.startReassignReferencesJob({ projectId, beatId: beat._id });
    const job = await waitForJob(job_id);

    expect(job.status).toBe('done');
    expect(job.planned).toBe(1);
    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    expect(fresh.frames[0].reference_ids.map(String)).toEqual([]);
    expect(fresh.frames[0].reference_scores).toEqual({});
  });

  it('reassigns references from the beat artwork catalog using the scorer', async () => {
    // Seed one done beat artwork, then stub the scorer to score it 1.0.
    const art = await Gateway.createPendingArtworkViaGateway({
      projectId, hostType: 'beat', hostId: beat._id.toString(),
      prompt: 'an empty room plate', name: 'Room plate', model: 'nano-banana-pro', referenceImageIds: [],
    });
    const resultId = new ObjectId();
    await Gateway.setArtworkResultViaGateway({
      projectId, hostType: 'beat', hostId: beat._id.toString(),
      artworkId: art.artwork._id, resultImageId: resultId,
    });
    Selector._setFrameReferenceScorerForTests(async ({ candidates }) => {
      const m = new Map();
      candidates.forEach((_c, i) => m.set(i + 1, 1.0));
      return m;
    });

    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 'room shot' });
    const { frameId } = await Gateway.addStoryboardFrameViaGateway({
      projectId, storyboardId: sb._id, prompt: 'a frame',
    });

    const { job_id } = await Jobs.startReassignReferencesJob({ projectId, beatId: beat._id });
    const job = await waitForJob(job_id);

    expect(job.status).toBe('done');
    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    expect(fresh.frames[0].reference_ids.map(String)).toContain(resultId.toString());
  });
});

describe('buildFrameShotText', () => {
  it('joins summary, text_prompt, and frame prompt, stripping markdown and blanks', () => {
    const text = Jobs.buildFrameShotText(
      { summary: '**Summary**', text_prompt: 'wide' },
      { prompt: 'frame _detail_' },
    );
    expect(text).toBe('Summary\nwide\nframe detail');
  });
});
