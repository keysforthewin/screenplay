import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const gen = await import('../src/web/storyboardGenerate.js');

async function drain(jobId) {
  for (let i = 0; i < 200; i++) {
    const j = gen.getReExpandAllJob(jobId);
    if (j && ['done', 'partial', 'error'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  return gen.getReExpandAllJob(jobId);
}

describe('startReExpandAllJob', () => {
  beforeEach(() => fakeDb.reset());

  it('re-expands every shot of the beat against the bible', async () => {
    const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
    const { createStoryboard, listStoryboards } = await import('../src/mongo/storyboards.js');
    await createBeat({ name: 'Bulk', desc: 'd', characters: [] });
    const beat = await getBeat(undefined, 'Bulk');
    await setBeatSceneBible(undefined, 'Bulk', { location: 'Diner' });
    await createStoryboard({ beatId: beat._id, order: 1, textPrompt: 'OLD1', summary: 'shot one', shotType: 'medium', durationSeconds: 4 });
    await createStoryboard({ beatId: beat._id, order: 2, textPrompt: 'OLD2', summary: 'shot two', shotType: 'close_up', durationSeconds: 3 });

    let calls = 0;
    gen._setShotExpanderForTests(({ outline }) => {
      calls += 1;
      return outline.map(() => ({ start_frame_prompt: `NS${calls}`, video_prompt: `NV${calls}`, reverse_in_post: false }));
    });

    const jobId = await gen.startReExpandAllJob({ beatId: beat._id.toString() });
    const job = await drain(jobId);
    expect(job.status).toBe('done');
    expect(calls).toBe(2);

    const sbs = await listStoryboards({ beatId: beat._id });
    for (const sb of sbs) {
      expect(sb.text_prompt).toContain('NV');
      expect(sb.frames[0].prompt).toMatch(/^NS/);
    }
    gen._setShotExpanderForTests(null);
  });

  it('reports done with zero shots (no-op)', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    await createBeat({ name: 'Empty', desc: 'd' });
    const beat = await getBeat(undefined, 'Empty');
    const jobId = await gen.startReExpandAllJob({ beatId: beat._id.toString() });
    const job = await drain(jobId);
    expect(job.status).toBe('done');
    expect(job.total).toBe(0);
  });
});
