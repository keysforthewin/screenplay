// sets_in_scene threading: mirrors characters_in_scene end to end — Mongo
// persistence, gateway scalar patch, and the generation pipeline (planner
// picks + prompt-text detection + reference seeding from set artwork).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const Sets = await import('../src/mongo/sets.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Gateway = await import('../src/web/gateway.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const { appendDoneArtwork } = await import('../src/mongo/artworks.js');
const { _setFrameReferenceScorerForTests } = await import('../src/llm/frameReferenceSelector.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  Generate._setScenePlannerForTests(null);
  Generate._setShotExpanderForTests(null);
  Generate._setImageDispatcherForTests(() => {
    throw new Error('image dispatcher must not be called during generation');
  });
  Generate._setCritiquePanelForTests(async () => ({
    overall: 7,
    lowest_lens: 'cinematic',
    lenses: [{ lens: 'bible', score: 7, comments: 'ok' }],
    model: 'test',
    created_at: new Date(),
    target: 'prompt',
  }));
  _setFrameReferenceScorerForTests(async ({ candidates }) => {
    const m = new Map();
    candidates.forEach((_, i) => m.set(i + 1, 0.9));
    return m;
  });
});

afterEach(() => {
  _setFrameReferenceScorerForTests(null);
});

describe('storyboards.sets_in_scene (mongo + gateway)', () => {
  it('createStoryboard persists a sanitized sets_in_scene and backfill defaults []', async () => {
    const beat = await Plots.createBeat({ projectId, desc: 'One' });
    const sb = await Storyboards.createStoryboard({
      projectId,
      beatId: beat._id,
      summary: 's',
      setsInScene: ['**Kitchen**', 'kitchen', 'Alley'],
    });
    expect(sb.sets_in_scene).toEqual(['Kitchen', 'Alley']);

    const bare = await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 'b' });
    expect(bare.sets_in_scene).toEqual([]);
  });

  it('updateStoryboard accepts sets_in_scene and rejects non-arrays', async () => {
    const beat = await Plots.createBeat({ projectId, desc: 'One' });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 's' });
    const next = await Storyboards.updateStoryboard(projectId, sb._id, {
      sets_in_scene: ['Kitchen'],
    });
    expect(next.sets_in_scene).toEqual(['Kitchen']);
    await expect(
      Storyboards.updateStoryboard(projectId, sb._id, { sets_in_scene: 'Kitchen' }),
    ).rejects.toThrow(/must be an array/);
  });

  it('updateStoryboardScalarsViaGateway passes sets_in_scene through', async () => {
    const beat = await Plots.createBeat({ projectId, desc: 'One' });
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 's' });
    await Gateway.updateStoryboardScalarsViaGateway({
      projectId,
      storyboardId: sb._id,
      patch: { sets_in_scene: ['Kitchen'] },
    });
    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    expect(fresh.sets_in_scene).toEqual(['Kitchen']);
  });
});

describe('generation pipeline threads sets_in_scene', () => {
  async function waitForJob(jobId) {
    for (let i = 0; i < 200; i++) {
      const job = Generate.getStoryboardGenerationJob(jobId);
      if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job never completed');
  }

  it('persists planner set picks, detects sets named in prompts, and seeds set artwork refs', async () => {
    // Two sets linked to the beat, each with one done artwork.
    const kitchen = await Sets.createSet({ projectId, name: 'Kitchen' });
    const alley = await Sets.createSet({ projectId, name: 'Alley' });
    const kitchenArt = new ObjectId();
    const alleyArt = new ObjectId();
    await appendDoneArtwork({
      projectId, hostType: 'set', hostId: kitchen._id.toString(),
      resultImageId: kitchenArt, name: 'Kitchen plate',
    });
    await appendDoneArtwork({
      projectId, hostType: 'set', hostId: alley._id.toString(),
      resultImageId: alleyArt, name: 'Alley plate',
    });

    const beat = await Plots.createBeat({
      projectId,
      name: 'Escape',
      desc: 'From the kitchen to the alley.',
      body: 'They bolt through the kitchen and out into the alley.',
      characters: [],
      sets: ['Kitchen', 'Alley'],
    });

    Generate._setScenePlannerForTests(async () => ({
      sceneBible: { location: 'Kitchen', time_of_day: 'night', lighting_key: 'fluorescent' },
      outline: [
        {
          description: 'Cooks scatter as they burst through.',
          shot_type: 'cinematic_wide',
          duration_seconds: 8,
          transition_in: '',
          characters_in_scene: [],
          sets_in_scene: ['Kitchen'],
        },
        {
          // Planner omitted sets_in_scene — the Alley is named in the prompt
          // text, so detection against the beat's set roster must link it.
          description: 'They spill out the back door.',
          shot_type: 'medium',
          duration_seconds: 6,
          transition_in: 'hard cut',
          characters_in_scene: [],
        },
      ],
    }));
    Generate._setShotExpanderForTests(async ({ outline }) =>
      outline.map((f, i) => ({
        start_frame_prompt:
          i === 0
            ? 'Wide on the chaotic kitchen pass.'
            : 'Medium shot spilling into the rain-slick Alley behind the diner.',
        video_prompt: i === 0 ? 'They sprint through. Camera pans.' : 'Door slams open. Camera holds.',
      })),
    );

    const jobId = await Generate.startStoryboardGenerationJob({
      projectId,
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);
    expect(stored[0].sets_in_scene).toEqual(['Kitchen']);
    expect(stored[1].sets_in_scene).toEqual(['Alley']);

    // Reference seeding drew from the right set's artwork.
    expect(stored[0].frames[0].reference_ids.map(String)).toContain(kitchenArt.toString());
    expect(stored[0].frames[0].reference_ids.map(String)).not.toContain(alleyArt.toString());
    expect(stored[1].frames[0].reference_ids.map(String)).toContain(alleyArt.toString());
  });
});

describe('linkBeatSetsForShot', () => {
  it('unions planner picks with sets detected in shot text, deduped', () => {
    const frame = {
      sets_in_scene: ['Kitchen'],
      start_frame_prompt: 'The KITCHEN pass, then out to the alley.',
      video_prompt: '',
      description: 'Alley exit.',
    };
    const out = Generate.linkBeatSetsForShot(frame, ['Kitchen', 'Alley', 'Rooftop']);
    expect(out).toEqual(['Kitchen', 'Alley']);
  });
});
