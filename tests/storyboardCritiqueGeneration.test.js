import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const gen = await import('../src/web/storyboardGenerate.js');

afterEach(() => {
  gen._setScenePlannerForTests(null);
  gen._setShotExpanderForTests(null);
  gen._setImageDispatcherForTests(null);
  gen._setCritiquePanelForTests(null);
});

async function drain(jobId) {
  for (let i = 0; i < 200; i++) {
    const job = gen.getStoryboardGenerationJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  return gen.getStoryboardGenerationJob(jobId);
}

let projectId;

describe('auto prompt-critique (Pass 4)', () => {
  beforeEach(async () => {
    fakeDb.reset();
    projectId = (await createProject('Test Project'))._id.toString();
  });

  it('critiques each generated row and persists prompt_critique', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    await createBeat({ projectId, name: 'CritBeat', desc: 'scene', characters: [] });
    const beat = await getBeat(projectId, 'CritBeat');

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

    const jobId = await gen.startStoryboardGenerationJob({ projectId, beatId: beat._id.toString(), targetCount: 2 });
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

describe('on-demand critique job', () => {
  beforeEach(async () => {
    fakeDb.reset();
    projectId = (await createProject('Test Project'))._id.toString();
  });

  it('prompt-tier: critiques a single row on demand', async () => {
    const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
    const { createStoryboard, getStoryboard } = await import('../src/mongo/storyboards.js');
    await createBeat({ projectId, name: 'OnDemand', desc: 'x', characters: [] });
    const beat = await getBeat(projectId, 'OnDemand');
    await setBeatSceneBible(projectId, 'OnDemand', { location: 'Diner' });
    const sb = await createStoryboard({ projectId, beatId: beat._id, order: 1, textPrompt: 'tp', summary: 'a shot' });

    gen._setCritiquePanelForTests(async ({ target }) => ({
      overall: 5, lowest_lens: 'continuity',
      lenses: [{ lens: 'bible', score: 5, comments: 'meh' }],
      model: 'test', created_at: new Date(), target,
    }));

    const jobId = await gen.startCritiqueJob({ projectId, storyboardId: sb._id.toString(), target: 'prompt' });
    for (let i = 0; i < 100; i++) {
      const j = gen.getCritiqueJob(jobId);
      if (j && ['done', 'error'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const j = gen.getCritiqueJob(jobId);
    expect(j.status).toBe('done');
    const reread = await getStoryboard(projectId, sb._id);
    expect(reread.prompt_critique.overall).toBe(5);
  });

  it('image-tier errors cleanly when the row has no rendered image', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    const { createStoryboard } = await import('../src/mongo/storyboards.js');
    await createBeat({ projectId, name: 'NoImg', desc: 'x', characters: [] });
    const beat = await getBeat(projectId, 'NoImg');
    const sb = await createStoryboard({ projectId, beatId: beat._id, order: 1, summary: 's' });

    const jobId = await gen.startCritiqueJob({ projectId, storyboardId: sb._id.toString(), target: 'image' });
    for (let i = 0; i < 100; i++) {
      const j = gen.getCritiqueJob(jobId);
      if (j && ['done', 'error'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const j = gen.getCritiqueJob(jobId);
    expect(j.status).toBe('error');
    expect(j.error).toMatch(/no rendered image|image/i);
  });
});

describe('reExpandShot (regenerate prompt from critique)', () => {
  beforeEach(async () => {
    fakeDb.reset();
    projectId = (await createProject('Test Project'))._id.toString();
  });

  it('re-expands one shot using critique guidance and updates the prompts', async () => {
    const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
    const { createStoryboard, getStoryboard } = await import('../src/mongo/storyboards.js');
    await createBeat({ projectId, name: 'ReExp', desc: 'x', characters: [] });
    const beat = await getBeat(projectId, 'ReExp');
    await setBeatSceneBible(projectId, 'ReExp', { location: 'Diner' });
    const sb = await createStoryboard({ projectId, beatId: beat._id, order: 1, textPrompt: 'OLD', summary: 'Sarah at counter', shotType: 'close_up', durationSeconds: 3 });

    let sawNotes = null;
    gen._setShotExpanderForTests(({ revisionNotes, outline }) => {
      sawNotes = revisionNotes;
      return outline.map(() => ({ start_frame_prompt: 'NEW start', video_prompt: 'NEW video', reverse_in_post: false }));
    });

    await gen.reExpandShot({ projectId, storyboardId: sb._id.toString(), critiqueGuidance: 'colder light' });
    expect(sawNotes).toContain('colder light');
    const reread = await getStoryboard(projectId, sb._id);
    expect(reread.frames[0].prompt).toBe('NEW start');
    expect(reread.text_prompt).toContain('NEW video');
    gen._setShotExpanderForTests(null);
  });

  it('re-links beat characters named in the re-expanded prompts', async () => {
    const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
    const { createStoryboard, getStoryboard } = await import('../src/mongo/storyboards.js');
    const { createCharacter } = await import('../src/mongo/characters.js');
    await createCharacter({ projectId, name: 'Sarah' });
    await createCharacter({ projectId, name: 'Tom' });
    await createBeat({ projectId, name: 'ReLink', desc: 'x', characters: ['Sarah', 'Tom'] });
    const beat = await getBeat(projectId, 'ReLink');
    await setBeatSceneBible(projectId, 'ReLink', { location: 'Diner' });
    // Storyboard starts with only Sarah linked.
    const sb = await createStoryboard({
      projectId, beatId: beat._id, order: 1, textPrompt: 'OLD',
      summary: 'Sarah at counter', shotType: 'two_shot', durationSeconds: 4,
      charactersInScene: ['Sarah'],
    });

    // Re-expansion introduces Tom in the new video prompt.
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map(() => ({ start_frame_prompt: 'Sarah and Tom at the counter.', video_prompt: 'Tom leans in.', reverse_in_post: false })),
    );

    await gen.reExpandShot({ projectId, storyboardId: sb._id.toString() });
    const reread = await getStoryboard(projectId, sb._id);
    expect(reread.characters_in_scene.sort()).toEqual(['Sarah', 'Tom']);
    gen._setShotExpanderForTests(null);
  });

  it('mergeCritiqueComments turns low-scoring lens comments into guidance', async () => {
    const guidance = gen.mergeCritiqueComments({
      overall: 4,
      lenses: [
        { lens: 'bible', score: 3, comments: 'Wrong location feel' },
        { lens: 'cinematic', score: 9, comments: 'Great framing' },
        { lens: 'continuity', score: 5, comments: 'Jump from prev shot' },
      ],
    });
    expect(guidance).toContain('Wrong location feel');   // score < 8 included
    expect(guidance).toContain('Jump from prev shot');    // score < 8 included
    expect(guidance).not.toContain('Great framing');      // score >= 8 excluded
  });

  it('mergeCritiqueComments excludes errored lenses from guidance', async () => {
    const guidance = gen.mergeCritiqueComments({
      overall: 4,
      lenses: [
        { lens: 'bible', score: 3, comments: 'Wrong location feel' },
        { lens: 'cinematic', score: 1, comments: '(lens failed: timeout)', error: true },
      ],
    });
    expect(guidance).toContain('Wrong location feel');    // real low score included
    expect(guidance).not.toContain('lens failed');        // errored lens excluded
  });
});
