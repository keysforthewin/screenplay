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
    const job = gen.getStoryboardGenerationJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  return gen.getStoryboardGenerationJob(jobId);
}

describe('auto prompt-critique (Pass 4)', () => {
  beforeEach(() => fakeDb.reset());

  it('critiques each generated row and persists prompt_critique', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    await createBeat({ name: 'CritBeat', desc: 'scene', characters: [] });
    const beat = await getBeat('CritBeat');

    gen._setScenePlannerForTests(() => ({
      sceneBible: { location: 'Diner' },
      outline: [
        { description: 'wide', shot_type: 'establishing', duration_seconds: 6 },
        { description: 'close', shot_type: 'close_up', duration_seconds: 3 },
      ],
    }));
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({ start_frame_prompt: `s${i}`, video_prompt: `v${i}`, reverse_in_post: false })),
    );
    gen._setImageDispatcherForTests(() => { throw new Error('no render'); });
    let panelCalls = 0;
    gen._setCritiquePanelForTests(async () => {
      panelCalls += 1;
      return {
        overall: 8, lowest_lens: 'cinematic',
        lenses: [{ lens: 'bible', score: 8, comments: 'ok' }],
        model: 'test', created_at: new Date(), target: 'prompt',
      };
    });

    const jobId = await gen.startStoryboardGenerationJob({ beatId: beat._id.toString(), targetCount: 2 });
    const job = await drain(jobId);
    expect(job.status).not.toBe('error');
    expect(panelCalls).toBe(2);

    const { listStoryboards } = await import('../src/mongo/storyboards.js');
    const sbs = await listStoryboards({ beatId: beat._id });
    expect(sbs).toHaveLength(2);
    for (const sb of sbs) {
      expect(sb.prompt_critique.overall).toBe(8);
      expect(sb.image_critique).toBeNull();
    }

    gen._setScenePlannerForTests(null);
    gen._setShotExpanderForTests(null);
    gen._setImageDispatcherForTests(null);
    gen._setCritiquePanelForTests(null);
  });
});
