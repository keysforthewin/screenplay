// Integration test for the storyboard auto-generation pipeline.
//
// Mocks Anthropic (returns a fixed 2-frame plan), Gemini (returns fake image
// bytes), and the GridFS image upload helper (returns fake metadata). Then
// drives the job from start to finish and verifies the storyboards land in
// Mongo with the expected fields.

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

const uploadCounter = { n: 0 };
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  uploadGeneratedImage: vi.fn(async ({ filename, contentType }) => {
    uploadCounter.n += 1;
    return {
      _id: new ObjectId(),
      filename,
      content_type: contentType || 'image/png',
      size: 1024,
      uploaded_at: new Date(),
    };
  }),
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const { _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

beforeEach(() => {
  fakeDb.reset();
  uploadCounter.n = 0;
  _resetAnthropicClientForTests();
  // Reset two-stage planner overrides so tests don't leak into each other.
  Generate._setOutlinePlannerForTests(null);
  Generate._setFrameRefinerForTests(null);
  // Default the image dispatcher to a benign fake so tests that don't
  // override it (e.g. the new direction/clamp/rolling-context tests) still
  // complete without trying to hit Gemini/OpenAI.
  Generate._setImageDispatcherForTests(async () => ({
    buffer: Buffer.from('img'),
    contentType: 'image/png',
  }));
});

// Two-stage flow: outline returns the shot list (no detailed prompts), then
// each frame is refined into video_prompt + start_frame_prompt +
// end_frame_prompt. The TWO_FRAME_PLAN object carries both halves so each
// test can drive both stages with one fixture.
const TWO_FRAME_PLAN = {
  frames: [
    {
      description: 'Alice walks into the diner.',
      shot_type: 'cinematic_wide',
      duration_seconds: 12,
      transition_in: '',
      video_prompt: 'Alice steps through the doorway and scans the room. Camera holds.',
      start_frame_prompt: 'Wide shot of Alice entering through the diner door, dusk light.',
      end_frame_prompt: 'Alice halfway across the room, scanning the booths.',
      characters_in_scene: ['Alice'],
    },
    {
      description: 'Alice sits down across from Bob.',
      shot_type: 'two_shot',
      duration_seconds: 4,
      transition_in: 'Picks up Alice mid-stride from #1.',
      video_prompt: 'Alice slides into the booth opposite Bob; Bob lifts his gaze. Camera holds.',
      start_frame_prompt: 'Two-shot of Alice approaching the booth.',
      end_frame_prompt: 'Alice seated, Bob looking up.',
      characters_in_scene: ['Alice', 'Bob'],
    },
  ],
};

// Set up both-stage overrides from a frames fixture. The outline override
// returns the frames minus the detailed prompts (Stage A's contract); the
// refiner override returns the matching video / still prompts so the final
// pipeline output equals the fixture frames.
function installPlannerForFixture(frames) {
  const outline = frames.map(
    ({ video_prompt, start_frame_prompt, end_frame_prompt, ...rest }) => ({
      ...rest,
    }),
  );
  Generate._setOutlinePlannerForTests(async () => outline);
  Generate._setFrameRefinerForTests(async ({ index }) => ({
    video_prompt: frames[index]?.video_prompt ?? '',
    start_frame_prompt: frames[index]?.start_frame_prompt ?? '',
    end_frame_prompt: frames[index]?.end_frame_prompt ?? '',
  }));
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

describe('storyboard auto-generation', () => {
  it('plans frames and creates storyboard rows without rendering frame images', async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    const dispatcherCalls = [];
    Generate._setImageDispatcherForTests(async ({ prompt }) => {
      dispatcherCalls.push(prompt);
      return {
        buffer: Buffer.from('fake-png-bytes'),
        contentType: 'image/png',
      };
    });

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

    // Auto frame-image generation has been removed: the image dispatcher must
    // not be called during the bulk-create path. Users render frames manually
    // via the per-row regen flow.
    expect(dispatcherCalls).toHaveLength(0);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);
    for (const sb of stored) {
      // The planner seeds two frames (start + end prompt), neither rendered yet.
      expect(sb.frames).toHaveLength(2);
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

  it('returns immediately with status=done when the model returns no frames', async () => {
    installPlannerForFixture([]);
    Generate._setImageDispatcherForTests(async () => {
      throw new Error('should not be called');
    });

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
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('fake'),
      contentType: 'image/png',
    }));

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
    installPlannerForFixture([
      {
        description: 'Tight on Alice, eyes welling.',
        shot_type: 'close_up',
        duration_seconds: 12, // close_up cap is 5
        transition_in: '',
        video_prompt: 'Alice lifts her gaze; eyes well. Camera holds.',
        start_frame_prompt: 'Tight close-up of Alice, looking down.',
        end_frame_prompt: 'Tight close-up of Alice, looking up.',
        characters_in_scene: ['Alice'],
      },
    ]);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('fake'),
      contentType: 'image/png',
    }));

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

  it('trims characters_in_scene to MAX_CHARS_PER_SHOT', async () => {
    installPlannerForFixture([
      {
        description: 'Crowd shot.',
        shot_type: 'cinematic_wide',
        duration_seconds: 8,
        transition_in: '',
        video_prompt: 'Subtle handheld breath on the wide; background figures drift slightly.',
        start_frame_prompt: 'Wide shot of the diner.',
        end_frame_prompt: 'Wide shot of the diner, slight zoom.',
        characters_in_scene: ['Alice', 'Bob', 'Carol', 'Dave'],
      },
    ]);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('fake'),
      contentType: 'image/png',
    }));

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
    expect(stored[0].characters_in_scene).toEqual(['Alice', 'Bob']);
  });

  it('handles atmospheric/insert frames with empty characters_in_scene', async () => {
    installPlannerForFixture([
      {
        description: 'Establishing wide.',
        shot_type: 'establishing',
        duration_seconds: 5,
        transition_in: '',
        video_prompt: 'Camera holds locked-off on the diner exterior; light drains from the sky.',
        start_frame_prompt: 'Wide of the diner exterior at dusk.',
        end_frame_prompt: 'Same wide; neon sign flickers on.',
        characters_in_scene: [],
      },
      {
        description: 'Insert: coffee cup steaming.',
        shot_type: 'insert',
        duration_seconds: 3,
        transition_in: 'Match cut from neon glow to steam.',
        video_prompt: 'Steam rises from the coffee cup in a slow curl. Camera holds.',
        start_frame_prompt: 'Macro shot of a coffee cup, steam rising.',
        end_frame_prompt: 'Macro shot of a coffee cup, ripple as a hand reaches in.',
        characters_in_scene: [],
      },
    ]);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('fake'),
      contentType: 'image/png',
    }));

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

  it('preserves existing storyboards when the planner returns no frames', async () => {
    installPlannerForFixture([]);
    Generate._setImageDispatcherForTests(async () => {
      throw new Error('should not be called');
    });

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

  it("stores the planner's video_prompt in text_prompt and pre-fills the per-frame still prompts", async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

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
    // text_prompt is the clip-gen prompt — the planner's video_prompt verbatim
    // (no Start frame / End frame baking). No legacy markers should appear.
    expect(stored[0].text_prompt).toContain(TWO_FRAME_PLAN.frames[0].video_prompt);
    expect(stored[1].text_prompt).toContain(TWO_FRAME_PLAN.frames[1].video_prompt);
    expect(stored[0].text_prompt).not.toMatch(/\*\*Start frame:\*\*/);
    expect(stored[0].text_prompt).not.toMatch(/\*\*End frame:\*\*/);
    // The planner's opening/closing still prompts are seeded as the first two
    // frames of each row's pool so the SPA's frame CollabFields render with the
    // planner's suggestions.
    expect(stored[0].frames.map((f) => f.prompt)).toEqual([
      TWO_FRAME_PLAN.frames[0].start_frame_prompt,
      TWO_FRAME_PLAN.frames[0].end_frame_prompt,
    ]);
    expect(stored[1].frames.map((f) => f.prompt)).toEqual([
      TWO_FRAME_PLAN.frames[1].start_frame_prompt,
      TWO_FRAME_PLAN.frames[1].end_frame_prompt,
    ]);
  });

  it('refines frames sequentially with rolling context — each call sees previously refined neighbors', async () => {
    // Stage A returns 3 outline frames; Stage B observes the previousRefined
    // list each call. We assert refinement #2 sees #1's prompts and #3 sees
    // both #1 and #2.
    const outline = [
      {
        description: 'Door opens.',
        shot_type: 'cinematic_wide',
        duration_seconds: 5,
        transition_in: '',
        characters_in_scene: [],
      },
      {
        description: 'Push in on the protagonist.',
        shot_type: 'medium',
        duration_seconds: 4,
        transition_in: 'Picks up the doorframe from #1.',
        characters_in_scene: ['Alice'],
      },
      {
        description: 'Reaction close-up.',
        shot_type: 'reaction',
        duration_seconds: 3,
        transition_in: 'Match cut on the eyes.',
        characters_in_scene: ['Alice'],
      },
    ];
    Generate._setOutlinePlannerForTests(async () => outline);
    const refineSeen = [];
    Generate._setFrameRefinerForTests(async ({ index, previousRefined }) => {
      // Deep-copy what we saw so later mutations can't poison the assertion.
      refineSeen.push({
        index,
        previousRefined: previousRefined.map((p) => ({ ...p })),
      });
      return {
        video_prompt: `video#${index}`,
        start_frame_prompt: `start#${index}`,
        end_frame_prompt: `end#${index}`,
      };
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

    const beat = await Plots.createBeat({
      name: 'Roll',
      desc: 'r',
      body: 'r',
      characters: ['Alice'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.planned).toBe(3);

    // Refinement order is 0, 1, 2 with growing context. Each previousRefined
    // entry carries the refined prompts of the prior frame(s) (alongside the
    // outline fields so the refiner can re-read shot_type etc. if needed).
    expect(refineSeen.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(refineSeen[0].previousRefined).toEqual([]);
    expect(refineSeen[1].previousRefined.map((p) => p.video_prompt)).toEqual([
      'video#0',
    ]);
    expect(refineSeen[1].previousRefined.map((p) => p.start_frame_prompt)).toEqual([
      'start#0',
    ]);
    expect(refineSeen[1].previousRefined.map((p) => p.end_frame_prompt)).toEqual([
      'end#0',
    ]);
    expect(refineSeen[2].previousRefined.map((p) => p.video_prompt)).toEqual([
      'video#0',
      'video#1',
    ]);
    expect(refineSeen[2].previousRefined.map((p) => p.start_frame_prompt)).toEqual([
      'start#0',
      'start#1',
    ]);
    expect(refineSeen[2].previousRefined.map((p) => p.end_frame_prompt)).toEqual([
      'end#0',
      'end#1',
    ]);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    // Each row's text_prompt carries the planner's video_prompt verbatim.
    expect(stored.map((s) => s.text_prompt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('video#0'),
        expect.stringContaining('video#1'),
        expect.stringContaining('video#2'),
      ]),
    );
    // The opening/closing still prompts are seeded as each row's two frames.
    expect(stored.map((s) => s.frames[0]?.prompt)).toEqual(
      expect.arrayContaining(['start#0', 'start#1', 'start#2']),
    );
    expect(stored.map((s) => s.frames[1]?.prompt)).toEqual(
      expect.arrayContaining(['end#0', 'end#1', 'end#2']),
    );
  });

  it('propagates `direction` to both stages', async () => {
    const outlineCalls = [];
    Generate._setOutlinePlannerForTests(async (args) => {
      outlineCalls.push(args);
      return [
        {
          description: 'D',
          shot_type: 'medium',
          duration_seconds: 4,
          transition_in: '',
          characters_in_scene: [],
        },
      ];
    });
    const refineCalls = [];
    Generate._setFrameRefinerForTests(async (args) => {
      refineCalls.push(args);
      return { video_prompt: 'v', start_frame_prompt: 's', end_frame_prompt: 'e' };
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

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

    expect(outlineCalls).toHaveLength(1);
    expect(outlineCalls[0].direction).toBe(
      'lean handheld and dirty over-the-shoulders',
    );
    expect(refineCalls).toHaveLength(1);
    expect(refineCalls[0].direction).toBe(
      'lean handheld and dirty over-the-shoulders',
    );
  });

  it('records detailed progress events for each generation step', async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

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

    // The event log captures the major phases plus per-frame steps. Each entry
    // carries an ISO timestamp, phase, step, and human-readable message. With
    // auto frame-image generation removed, per-frame events shrink to
    // frame_start / frame_done — no render_*_frame or caption_*_frame steps.
    expect(Array.isArray(job.events)).toBe(true);
    const steps = job.events.map((e) => e.step);
    expect(steps).toContain('job_queued');
    expect(steps).toContain('plan_outline_start');
    expect(steps).toContain('plan_outline_done');
    expect(steps).toContain('refine_frame_start');
    expect(steps).toContain('refine_done');
    expect(steps).toContain('render_start');
    expect(steps).toContain('frame_start');
    expect(steps).toContain('frame_done');
    expect(steps).toContain('job_done');
    expect(steps).not.toContain('render_start_frame');
    expect(steps).not.toContain('caption_start_frame');
    expect(steps).not.toContain('render_end_frame');
    expect(steps).not.toContain('caption_end_frame');

    // Per-frame events carry the frame index + total so the SPA can render
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
    Generate._setOutlinePlannerForTests(async () => {
      throw new Error('outline boom');
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

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
    expect(job.progress?.message).toMatch(/outline boom/);
  });

  it('falls back to synthesized prompts when refinement returns null', async () => {
    Generate._setOutlinePlannerForTests(async () => [
      {
        description: 'Alice opens the door.',
        shot_type: 'medium',
        duration_seconds: 4,
        transition_in: '',
        characters_in_scene: ['Alice'],
      },
    ]);
    Generate._setFrameRefinerForTests(async () => null);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

    const beat = await Plots.createBeat({
      name: 'F',
      desc: '',
      body: '',
      characters: ['Alice'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(['done', 'partial']).toContain(job.status);
    expect(job.refine_failures).toBe(1);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(1);
    // Synthesized prompts include the outline description so the row has
    // usable text. The video_prompt lands in text_prompt; the still prompts
    // are pre-filled on the row's collab fragments.
    expect(stored[0].text_prompt).toMatch(/Alice opens the door/);
    expect(stored[0].text_prompt).not.toMatch(/\*\*Start frame:\*\*/);
    expect(stored[0].text_prompt).not.toMatch(/\*\*End frame:\*\*/);
    expect(stored[0].frames).toHaveLength(2);
    expect(stored[0].frames[0].prompt).toMatch(/Alice opens the door/);
    expect(stored[0].frames[1].prompt).toMatch(/Alice opens the door/);
  });

  it('clamps targetCount and records the requested value on the job', async () => {
    let receivedTarget = null;
    Generate._setOutlinePlannerForTests(async ({ targetCount }) => {
      receivedTarget = targetCount;
      return [];
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

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
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
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

    // Each planned row gets two frames (start + end prompt); every frame's
    // reference list is seeded identically from the aggregator (beat image +
    // the in-scene characters' refs).
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
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
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
  // The outline planner is supposed to mark reveal shots with
  // reverse_in_post: true, but it can miss them when the beat narrative uses
  // forward-reveal language. The refiner is a second line of defense: it can
  // return reverse_in_post in its tool output to override the outline's value.

  async function runOne({ outlineReverse, refinerReverse }) {
    Generate._setOutlinePlannerForTests(async () => [
      {
        description: 'Skyscraper looms into view as we slowly tilt up.',
        shot_type: 'cinematic_wide',
        duration_seconds: 5,
        transition_in: '',
        characters_in_scene: [],
        reverse_in_post: outlineReverse,
      },
    ]);
    Generate._setFrameRefinerForTests(async () => {
      const out = {
        video_prompt: 'Heroes shift weight subtly at frame bottom; camera holds locked-off.',
        start_frame_prompt: 'Skyscraper fills the frame, glass facade reflecting overcast sky.',
        end_frame_prompt: 'Same wide low-angle; the heroes have shifted a half-step.',
      };
      if (refinerReverse !== undefined) out.reverse_in_post = refinerReverse;
      return out;
    });
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

  it('refiner can flip reverse_in_post from false to true when outline missed a reveal', async () => {
    const sb = await runOne({ outlineReverse: false, refinerReverse: true });
    expect(sb.reverse_in_post).toBe(true);
  });

  it('refiner can flip reverse_in_post from true to false when it disagrees', async () => {
    const sb = await runOne({ outlineReverse: true, refinerReverse: false });
    expect(sb.reverse_in_post).toBe(false);
  });

  it('outline value is preserved when refiner omits reverse_in_post (true case)', async () => {
    const sb = await runOne({ outlineReverse: true, refinerReverse: undefined });
    expect(sb.reverse_in_post).toBe(true);
  });

  it('outline value is preserved when refiner omits reverse_in_post (false case)', async () => {
    const sb = await runOne({ outlineReverse: false, refinerReverse: undefined });
    expect(sb.reverse_in_post).toBe(false);
  });

  it('synthesized fallback (refiner returns null) preserves the outline value', async () => {
    Generate._setOutlinePlannerForTests(async () => [
      {
        description: 'The killer is revealed in the corner booth.',
        shot_type: 'cinematic_wide',
        duration_seconds: 5,
        transition_in: '',
        characters_in_scene: [],
        reverse_in_post: true,
      },
    ]);
    Generate._setFrameRefinerForTests(async () => null);
    const beat = await Plots.createBeat({
      name: 'Reveal-fallback',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.refine_failures).toBe(1);
    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(1);
    expect(stored[0].reverse_in_post).toBe(true);
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
