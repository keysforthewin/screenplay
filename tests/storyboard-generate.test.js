// Integration test for the storyboard auto-generation pipeline (two-pass).
//
// Drives the background job via the NEW pipeline overrides:
//   - _setScenePlannerForTests : returns { sceneBible, outline } (Pass 1)
//   - _setShotExpanderForTests : returns one
//       { start_frame_prompt, video_prompt, reverse_in_post } per skeleton shot
//       (Pass 2)
// Then verifies the storyboards land in Mongo with the expected fields. No
// images are rendered during generation — the image dispatcher must stay idle.
//
// (The narrower Pass-1 / Pass-2 / planFramesV2 unit tests live in
// tests/storyboardSceneGeneration.test.js; this file covers the end-to-end job:
// target-count handling, row metadata persistence, multi-row creation, the
// empty-planner-preserves-existing path, reference seeding, the reverse_in_post
// override, progress events, and crash recording.)

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

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  uploadGeneratedImage: vi.fn(async ({ filename, contentType }) => ({
    _id: new ObjectId(),
    filename,
    content_type: contentType || 'image/png',
    size: 1024,
    uploaded_at: new Date(),
  })),
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');

beforeEach(() => {
  fakeDb.reset();
  // Reset two-pass planner overrides so tests don't leak into each other.
  Generate._setScenePlannerForTests(null);
  Generate._setShotExpanderForTests(null);
  // The image dispatcher must never fire during generation; make it throw so
  // an accidental call surfaces loudly.
  Generate._setImageDispatcherForTests(() => {
    throw new Error('image dispatcher must not be called during generation');
  });
  // Pass 4 runs at the end of generation; stub the critique panel so these
  // integration tests don't make real Anthropic calls (this file does not mock
  // the Anthropic client). The dedicated Pass-4 behavior is covered in
  // tests/storyboardCritiqueGeneration.test.js.
  Generate._setCritiquePanelForTests(async () => ({
    overall: 7,
    lowest_lens: 'cinematic',
    lenses: [{ lens: 'bible', score: 7, comments: 'ok' }],
    model: 'test',
    created_at: new Date(),
    target: 'prompt',
  }));
});

// A two-shot plan. The skeleton fields (description/shot_type/duration/...) are
// what Pass 1 emits; the expand fields (start_frame_prompt/video_prompt) are
// what Pass 2 emits. installPlanner wires both overrides from this shape.
const TWO_SHOT_PLAN = {
  sceneBible: { location: 'Diner', time_of_day: 'dusk', lighting_key: 'warm practicals' },
  shots: [
    {
      description: 'Alice walks into the diner.',
      shot_type: 'cinematic_wide',
      duration_seconds: 12,
      transition_in: '',
      characters_in_scene: ['Alice'],
      reverse_in_post: false,
      start_frame_prompt: 'Wide shot of Alice entering through the diner door, dusk light.',
      video_prompt: 'Alice steps through the doorway and scans the room. Camera holds.',
    },
    {
      description: 'Alice sits down across from Bob.',
      shot_type: 'two_shot',
      duration_seconds: 4,
      transition_in: 'Picks up Alice mid-stride from #1.',
      characters_in_scene: ['Alice', 'Bob'],
      reverse_in_post: false,
      start_frame_prompt: 'Two-shot of Alice approaching the booth.',
      video_prompt: 'Alice slides into the booth opposite Bob; Bob lifts his gaze. Camera holds.',
    },
  ],
};

// Wire the scene planner + shot expander overrides from a plan fixture. The
// scene planner returns the skeleton (description/shot_type/... only); the shot
// expander returns the matching { start_frame_prompt, video_prompt } per shot.
function installPlanner(plan) {
  const outline = plan.shots.map(
    ({ start_frame_prompt, video_prompt, ...skeleton }) => ({ ...skeleton }),
  );
  Generate._setScenePlannerForTests(async () => ({
    sceneBible: plan.sceneBible ?? null,
    outline,
  }));
  Generate._setShotExpanderForTests(async ({ outline: ol }) =>
    ol.map((f, i) => ({
      start_frame_prompt: plan.shots[i]?.start_frame_prompt ?? '',
      video_prompt: plan.shots[i]?.video_prompt ?? '',
      reverse_in_post: Boolean(plan.shots[i]?.reverse_in_post),
    })),
  );
}

async function waitForJob(jobId) {
  for (let i = 0; i < 200; i++) {
    const job = Generate.getStoryboardGenerationJob(jobId);
    if (
      job &&
      (job.status === 'done' || job.status === 'partial' || job.status === 'error')
    ) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job never completed');
}

describe('storyboard auto-generation (two-pass)', () => {
  it('plans shots and creates storyboard rows without rendering frame images', async () => {
    installPlanner(TWO_SHOT_PLAN);

    const beat = await Plots.createBeat({
      name: 'Diner reunion',
      desc: 'Alice meets Bob at the diner.',
      body: 'Alice arrives at the diner. She finds Bob in the back booth.',
      characters: ['Alice', 'Bob'],
    });

    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);

    expect(job.status).toBe('done');
    expect(job.planned).toBe(2);
    expect(job.completed).toBe(2);
    expect(job.failed).toBe(0);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);
    for (const sb of stored) {
      // Only the start-frame prompt is seeded (one frame, not start+end).
      expect(sb.frames).toHaveLength(1);
      for (const f of sb.frames) expect(f.image_id).toBe(null);
      expect(typeof sb.text_prompt).toBe('string');
      expect(sb.text_prompt.length).toBeGreaterThan(0);
    }
    // Order is contiguous.
    expect(stored.map((s) => s.order)).toEqual([1, 2]);

    // Shot metadata from the planner survives to storage.
    expect(stored[0].shot_type).toBe('cinematic_wide');
    expect(stored[0].duration_seconds).toBe(12);
    expect(stored[0].transition_in).toBe(null); // empty string in plan
    expect(stored[0].characters_in_scene).toEqual(['Alice']);

    expect(stored[1].shot_type).toBe('two_shot');
    expect(stored[1].duration_seconds).toBe(4);
    expect(stored[1].transition_in).toBe('Picks up Alice mid-stride from #1.');
    expect(stored[1].characters_in_scene).toEqual(['Alice', 'Bob']);
  });

  it('returns status=done and persists nothing when the planner returns no shots', async () => {
    Generate._setScenePlannerForTests(async () => ({ sceneBible: null, outline: [] }));

    const beat = await Plots.createBeat({
      name: 'E',
      desc: 'e',
      body: '',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.planned).toBe(0);
    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(0);
  });

  it('replaces existing storyboards when the planner produces a non-empty plan', async () => {
    installPlanner(TWO_SHOT_PLAN);

    const beat = await Plots.createBeat({
      name: 'R',
      desc: 'r',
      body: 'r',
      characters: [],
    });
    // Seed three pre-existing storyboards on the beat.
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'old 1' });
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'old 2' });
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'old 3' });
    const before = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(before).toHaveLength(3);
    const oldIds = new Set(before.map((s) => s._id.toString()));

    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');

    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after).toHaveLength(2);
    expect(after.map((s) => s.order)).toEqual([1, 2]);
    // None of the original ids should survive — the old set was wiped.
    for (const sb of after) {
      expect(oldIds.has(sb._id.toString())).toBe(false);
    }
  });

  it('clamps planner-emitted duration that exceeds the shot_type cap', async () => {
    installPlanner({
      sceneBible: { location: 'Room' },
      shots: [
        {
          description: 'Tight on Alice, eyes welling.',
          shot_type: 'close_up',
          duration_seconds: 12, // close_up cap is 5
          transition_in: '',
          characters_in_scene: ['Alice'],
          reverse_in_post: false,
          start_frame_prompt: 'Tight close-up of Alice, looking down.',
          video_prompt: 'Alice lifts her gaze; eyes well. Camera holds.',
        },
      ],
    });

    const beat = await Plots.createBeat({
      name: 'Clamp',
      desc: 'c',
      body: 'c',
      characters: ['Alice'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    await waitForJob(jobId);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(1);
    expect(stored[0].shot_type).toBe('close_up');
    expect(stored[0].duration_seconds).toBe(5);
  });

  it('keeps all characters_in_scene (cap removed)', async () => {
    installPlanner({
      sceneBible: { location: 'Diner' },
      shots: [
        {
          description: 'Crowd shot.',
          shot_type: 'cinematic_wide',
          duration_seconds: 8,
          transition_in: '',
          characters_in_scene: ['Alice', 'Bob', 'Carol', 'Dave'],
          reverse_in_post: false,
          start_frame_prompt: 'Wide shot of the diner.',
          video_prompt: 'Subtle handheld breath on the wide; background figures drift slightly.',
        },
      ],
    });

    const beat = await Plots.createBeat({
      name: 'Crowd',
      desc: 'c',
      body: 'c',
      characters: ['Alice', 'Bob', 'Carol', 'Dave'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    await waitForJob(jobId);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored[0].characters_in_scene).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('handles atmospheric/insert shots with empty characters_in_scene', async () => {
    installPlanner({
      sceneBible: { location: 'Diner exterior' },
      shots: [
        {
          description: 'Establishing wide.',
          shot_type: 'establishing',
          duration_seconds: 5,
          transition_in: '',
          characters_in_scene: [],
          reverse_in_post: false,
          start_frame_prompt: 'Wide of the diner exterior at dusk.',
          video_prompt: 'Camera holds locked-off on the diner exterior; light drains from the sky.',
        },
        {
          description: 'Insert: coffee cup steaming.',
          shot_type: 'insert',
          duration_seconds: 3,
          transition_in: 'Match cut from neon glow to steam.',
          characters_in_scene: [],
          reverse_in_post: false,
          start_frame_prompt: 'Macro shot of a coffee cup, steam rising.',
          video_prompt: 'Steam rises from the coffee cup in a slow curl. Camera holds.',
        },
      ],
    });

    const beat = await Plots.createBeat({
      name: 'Atmos',
      desc: 'a',
      body: 'a',
      characters: ['Alice'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(['done', 'partial']).toContain(job.status);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);
    expect(stored[0].shot_type).toBe('establishing');
    expect(stored[0].characters_in_scene).toEqual([]);
    expect(stored[1].shot_type).toBe('insert');
    expect(stored[1].transition_in).toBe('Match cut from neon glow to steam.');
  });

  it('preserves existing storyboards when the planner returns no shots', async () => {
    Generate._setScenePlannerForTests(async () => ({ sceneBible: null, outline: [] }));

    const beat = await Plots.createBeat({
      name: 'P',
      desc: 'p',
      body: 'p',
      characters: [],
    });
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'keep 1' });
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'keep 2' });
    const before = await Storyboards.listStoryboards({ beatId: beat._id });
    const beforeIds = before.map((s) => s._id.toString()).sort();

    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.planned).toBe(0);

    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after).toHaveLength(2);
    expect(after.map((s) => s._id.toString()).sort()).toEqual(beforeIds);
    expect(after.map((s) => s.text_prompt)).toEqual(['keep 1', 'keep 2']);
  });

  it("stores the expander's video_prompt in text_prompt and seeds the start-frame still prompt", async () => {
    installPlanner(TWO_SHOT_PLAN);

    const beat = await Plots.createBeat({
      name: 'D',
      desc: 'd',
      body: 'b',
      characters: ['Alice', 'Bob'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);
    // text_prompt is the lean, motion-only video prompt — exactly the expander's
    // video_prompt, with no Start/End markers and (crucially) none of the static
    // chrome that used to be bundled in (shot-type header, the narrative
    // description, the transition note). Those live on structured fields and the
    // SPA renders them separately; bundling them here is what made the video
    // model re-describe the already-correct start frame.
    expect(stored[0].text_prompt).toBe(TWO_SHOT_PLAN.shots[0].video_prompt);
    expect(stored[1].text_prompt).toBe(TWO_SHOT_PLAN.shots[1].video_prompt);
    expect(stored[0].text_prompt).not.toMatch(/\*\*Start frame:\*\*/);
    expect(stored[0].text_prompt).not.toMatch(/\*\*End frame:\*\*/);
    // No static description / shot-type header / transition note bled into the
    // prompt the video model receives.
    expect(stored[0].text_prompt).not.toContain(TWO_SHOT_PLAN.shots[0].description);
    expect(stored[0].text_prompt).not.toContain('CINEMATIC WIDE');
    expect(stored[1].text_prompt).not.toContain(TWO_SHOT_PLAN.shots[1].transition_in);
    // Only the opening still prompt is seeded — exactly one frame per row.
    expect(stored[0].frames.map((f) => f.prompt)).toEqual([
      TWO_SHOT_PLAN.shots[0].start_frame_prompt,
    ]);
    expect(stored[1].frames.map((f) => f.prompt)).toEqual([
      TWO_SHOT_PLAN.shots[1].start_frame_prompt,
    ]);
  });

  it('propagates `direction` to both passes', async () => {
    const sceneCalls = [];
    Generate._setScenePlannerForTests(async (args) => {
      sceneCalls.push(args);
      return {
        sceneBible: { location: 'X' },
        outline: [
          {
            description: 'D',
            shot_type: 'medium',
            duration_seconds: 4,
            transition_in: '',
            characters_in_scene: [],
          },
        ],
      };
    });
    const expandCalls = [];
    Generate._setShotExpanderForTests(async (args) => {
      expandCalls.push(args);
      return args.outline.map(() => ({
        start_frame_prompt: 's',
        video_prompt: 'v',
        reverse_in_post: false,
      }));
    });

    const beat = await Plots.createBeat({
      name: 'Dir',
      desc: '',
      body: '',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
      direction: 'lean handheld and dirty over-the-shoulders',
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    // Direction is recorded on the job.
    expect(job.direction).toBe('lean handheld and dirty over-the-shoulders');

    expect(sceneCalls).toHaveLength(1);
    expect(sceneCalls[0].direction).toBe('lean handheld and dirty over-the-shoulders');
    expect(expandCalls).toHaveLength(1);
    expect(expandCalls[0].direction).toBe('lean handheld and dirty over-the-shoulders');
  });

  it('records detailed progress events for each generation step', async () => {
    installPlanner(TWO_SHOT_PLAN);

    const beat = await Plots.createBeat({
      name: 'P',
      desc: 'd',
      body: 'b',
      characters: ['Alice'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);

    expect(job.status).toBe('done');
    // Every step records a current-progress snapshot so the SPA always has
    // something to show.
    expect(job.progress).toBeTruthy();
    expect(job.progress.phase).toBe('done');
    expect(job.progress.step).toBe('job_done');
    expect(job.progress.message).toMatch(/Done — 2 created/);

    // The event log captures the two planning passes plus per-row steps.
    expect(Array.isArray(job.events)).toBe(true);
    const steps = job.events.map((e) => e.step);
    expect(steps).toContain('job_queued');
    expect(steps).toContain('plan_scene_start');
    expect(steps).toContain('plan_scene_done');
    expect(steps).toContain('expand_start');
    expect(steps).toContain('expand_done');
    expect(steps).toContain('render_start');
    expect(steps).toContain('frame_start');
    expect(steps).toContain('frame_done');
    expect(steps).toContain('job_done');
    // No legacy per-frame refine / render-image steps.
    expect(steps).not.toContain('refine_frame_start');
    expect(steps).not.toContain('render_start_frame');
    expect(steps).not.toContain('caption_start_frame');

    // Per-row events carry the row index + total so the SPA can render
    // "Frame 2/2" without re-deriving it.
    const frameStarts = job.events.filter((e) => e.step === 'frame_start');
    expect(frameStarts.map((e) => e.frame)).toEqual([1, 2]);
    for (const e of frameStarts) {
      expect(e.total).toBe(2);
    }

    // Event log is capped — we don't pile up forever.
    expect(job.events.length).toBeLessThanOrEqual(100);
  });

  it('records a job_crashed progress event when the runner throws', async () => {
    Generate._setScenePlannerForTests(async () => {
      throw new Error('plan boom');
    });

    const beat = await Plots.createBeat({
      name: 'Crash',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);

    expect(job.status).toBe('error');
    expect(job.progress?.phase).toBe('error');
    expect(job.progress?.step).toBe('job_crashed');
    expect(job.progress?.message).toMatch(/plan boom/);
  });

  it('clamps targetCount and records the requested value on the job', async () => {
    let receivedTarget = null;
    Generate._setScenePlannerForTests(async ({ targetCount }) => {
      receivedTarget = targetCount;
      return { sceneBible: null, outline: [] };
    });

    const beat = await Plots.createBeat({
      name: 'C',
      desc: '',
      body: '',
      characters: [],
    });
    // 999 is above MAX_TARGET_COUNT (30); we expect it clamped to 30.
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
      targetCount: 999,
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(receivedTarget).toBe(30);
    expect(job.target_count_requested).toBe(30);
  });
});

describe('auto-populated reference images', () => {
  it('attaches beat + per-character reference images to each generated row', async () => {
    installPlanner(TWO_SHOT_PLAN);
    const Characters = await import('../src/mongo/characters.js');
    const sheetA = new ObjectId();
    const mainA = new ObjectId();
    const sheetB = new ObjectId();
    const beatImg = new ObjectId();

    const a = await Characters.createCharacter({ name: 'Alice' });
    await fakeDb.collection('characters').updateOne(
      { _id: a._id },
      {
        $set: {
          character_sheet_image_ids: [sheetA],
          main_image_id: mainA,
          images: [{ _id: mainA }],
        },
      },
    );
    const b = await Characters.createCharacter({ name: 'Bob' });
    await fakeDb.collection('characters').updateOne(
      { _id: b._id },
      {
        $set: {
          character_sheet_image_ids: [sheetB],
          main_image_id: null,
          images: [],
        },
      },
    );

    const beat = await Plots.createBeat({
      name: 'Diner',
      desc: 'd',
      body: 'Alice walks in. Bob is waiting.',
      characters: ['Alice', 'Bob'],
    });
    await Plots.pushBeatImage(beat._id, { _id: beatImg }, true);

    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);

    // Each planned row's single seeded frame gets its reference list seeded from
    // the aggregator (beat image + the in-scene characters' refs).
    // Shot 1: Alice only → beat image + Alice's sheet + Alice's main.
    for (const frame of stored[0].frames) {
      const ids = frame.reference_ids.map((x) => x.toString());
      expect(ids).toContain(beatImg.toString());
      expect(ids).toContain(sheetA.toString());
      expect(ids).toContain(mainA.toString());
      expect(ids).not.toContain(sheetB.toString());
    }
    // Shot 2: Alice + Bob → beat image + both characters' refs.
    for (const frame of stored[1].frames) {
      const ids = frame.reference_ids.map((x) => x.toString());
      expect(ids).toContain(beatImg.toString());
      expect(ids).toContain(sheetA.toString());
      expect(ids).toContain(sheetB.toString());
    }
  });

  it('leaves every frame reference list empty when the beat has no images and characters are unknown', async () => {
    installPlanner(TWO_SHOT_PLAN);
    const beat = await Plots.createBeat({
      name: 'Bare',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    for (const sb of stored) {
      for (const frame of sb.frames) {
        expect(frame.reference_ids).toEqual([]);
      }
    }
  });
});

describe('reverse_in_post override flow', () => {
  // The scene planner is supposed to mark reveal shots with reverse_in_post:
  // true, but it can miss them when the beat narrative uses forward-reveal
  // language. The shot expander is a second line of defense: it can return
  // reverse_in_post in its output to override the skeleton's value.

  async function runOne({ skeletonReverse, expanderReverse }) {
    Generate._setScenePlannerForTests(async () => ({
      sceneBible: { location: 'Street' },
      outline: [
        {
          description: 'Skyscraper looms into view as we slowly tilt up.',
          shot_type: 'cinematic_wide',
          duration_seconds: 5,
          transition_in: '',
          characters_in_scene: [],
          reverse_in_post: skeletonReverse,
        },
      ],
    }));
    Generate._setShotExpanderForTests(async ({ outline }) =>
      outline.map((f) => ({
        start_frame_prompt: 'Skyscraper fills the frame, glass facade reflecting overcast sky.',
        video_prompt: 'Heroes shift weight subtly at frame bottom; camera holds locked-off.',
        // When expanderReverse is undefined the expander inherits the skeleton.
        reverse_in_post:
          expanderReverse !== undefined ? expanderReverse : Boolean(f.reverse_in_post),
      })),
    );
    const beat = await Plots.createBeat({
      name: 'Reveal',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(1);
    return stored[0];
  }

  it('expander can flip reverse_in_post from false to true when the skeleton missed a reveal', async () => {
    const sb = await runOne({ skeletonReverse: false, expanderReverse: true });
    expect(sb.reverse_in_post).toBe(true);
  });

  it('expander can flip reverse_in_post from true to false when it disagrees', async () => {
    const sb = await runOne({ skeletonReverse: true, expanderReverse: false });
    expect(sb.reverse_in_post).toBe(false);
  });

  it('skeleton value is preserved when the expander inherits it', async () => {
    const sb = await runOne({ skeletonReverse: true, expanderReverse: undefined });
    expect(sb.reverse_in_post).toBe(true);
  });
});

describe('findCharactersInBeat', () => {
  it('resolves every name in beat.characters to its current Mongo doc', async () => {
    const Characters = await import('../src/mongo/characters.js');
    await Characters.createCharacter({ name: 'Alice' });
    await Characters.createCharacter({ name: 'Bob' });

    const beat = await Plots.createBeat({
      name: 'B',
      desc: 'd',
      body: 'b',
      characters: ['Alice', 'Bob', '   ', 'Nonexistent'],
    });

    const docs = await Generate.findCharactersInBeat(beat);
    const names = docs.map((d) => d.name).sort();
    // Empty strings are skipped; unknown names resolve to null and drop.
    expect(names).toEqual(['Alice', 'Bob']);
  });
});

describe('shot-expand prompt wiring', () => {
  it('includes the placeholder-occupant guidance in the expand system prompt', () => {
    expect(Generate.SHOT_EXPAND_SYSTEM_PROMPT).toContain('Placeholder occupants');
    expect(Generate.SHOT_EXPAND_SYSTEM_PROMPT.toLowerCase()).toContain(
      'through the glass',
    );
  });
});
