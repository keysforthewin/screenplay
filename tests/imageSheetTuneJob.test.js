import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';
import { config } from '../src/config.js';

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
const Tuner = await import('../src/web/storyboardSheetTuner.js');
const Sheet = await import('../src/web/imageSheetJobs.js');

let projectId;
let beat;
let prevKey;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  beat = await Plots.createBeat({ projectId, name: 'B', body: 'INT. ROOM — DAY' });
  Tuner._setShotPlateScanForTests(null);
  Tuner._setConsolidatePlatesForTests(null);
  prevKey = config.anthropic?.apiKey;
  config.anthropic = { ...(config.anthropic || {}), apiKey: 'test-key' };
});

async function waitForStatus(jobId, statuses, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Sheet.getImageSheetJob(jobId);
    if (job && statuses.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job did not reach ${statuses.join('/')} in time`);
}

describe('startTuneScanJob', () => {
  it('scans storyboards and parks proposed plates on the job (status derived)', async () => {
    await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 'gap shot' });
    Tuner._setShotPlateScanForTests(async () => ({ needs_plate: true, name: 'New plate', prompt: 'empty room' }));

    const { job_id } = await Sheet.startTuneScanJob({ projectId, hostId: beat._id.toString(), referenceImageIds: [] });
    const job = await waitForStatus(job_id, ['derived', 'error']);

    expect(job.status).toBe('derived');
    expect(job.shots).toEqual([{ name: 'New plate', prompt: 'empty room', justification: '', quote: '' }]);
    expect(job.planned).toBe(1);
  });

  it('reaches derived with no shots when the beat has no storyboards', async () => {
    const { job_id } = await Sheet.startTuneScanJob({ projectId, hostId: beat._id.toString(), referenceImageIds: [] });
    const job = await waitForStatus(job_id, ['derived', 'error']);
    expect(job.status).toBe('derived');
    expect(job.shots).toEqual([]);
  });
});
