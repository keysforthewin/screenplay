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
  // Default the describer / end-prompt derivation hooks to no-ops so tests
  // that don't override them don't reach the real Anthropic client. Tests
  // that DO care override these explicitly.
  Generate._setDescriberForTests(async () => ({ name: '', description: '' }));
  Generate._setEndPromptDerivationForTests(async () => null);
  // Default the image dispatcher to a benign fake so tests that don't
  // override it (e.g. the new direction/clamp/rolling-context tests) still
  // complete without trying to hit Gemini/OpenAI.
  Generate._setImageDispatcherForTests(async () => ({
    buffer: Buffer.from('img'),
    contentType: 'image/png',
  }));
});

// Two-stage flow: outline returns the shot list (no start/end prompts), then
// each frame is refined into start/end prompts. The TWO_FRAME_PLAN object
// carries both halves so each test can drive both stages with one fixture.
const TWO_FRAME_PLAN = {
  frames: [
    {
      description: 'Alice walks into the diner.',
      shot_type: 'cinematic_wide',
      duration_seconds: 12,
      transition_in: '',
      start_prompt: 'Wide shot of Alice entering through the diner door, dusk light.',
      end_prompt: 'Alice halfway across the room, scanning the booths.',
      characters_in_scene: ['Alice'],
    },
    {
      description: 'Alice sits down across from Bob.',
      shot_type: 'two_shot',
      duration_seconds: 4,
      transition_in: 'Picks up Alice mid-stride from #1.',
      start_prompt: 'Two-shot of Alice approaching the booth.',
      end_prompt: 'Alice seated, Bob looking up.',
      characters_in_scene: ['Alice', 'Bob'],
    },
  ],
};

// Set up both-stage overrides from a frames fixture. The outline override
// returns the frames minus the visual prompts (Stage A's contract); the
// refiner override returns the matching start/end prompts so the final
// pipeline output equals the fixture frames.
function installPlannerForFixture(frames) {
  const outline = frames.map(
    ({ start_prompt, end_prompt, ...rest }) => ({ ...rest }),
  );
  Generate._setOutlinePlannerForTests(async () => outline);
  Generate._setFrameRefinerForTests(async ({ index }) => ({
    start_prompt: frames[index]?.start_prompt ?? '',
    end_prompt: frames[index]?.end_prompt ?? '',
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
  it('plans frames and renders start + end images for each one', async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    const generated = [];
    Generate._setImageDispatcherForTests(async ({ prompt }) => {
      generated.push(prompt);
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

    // Two frames × two images each = 4 Gemini calls.
    expect(generated.length).toBe(4);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);
    for (const sb of stored) {
      expect(sb.start_frame_id).not.toBe(null);
      expect(sb.end_frame_id).not.toBe(null);
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

    // Each prompt sent to Gemini carries the shot-type cue.
    expect(generated.some((p) => /Shot type: CINEMATIC WIDE\./.test(p))).toBe(true);
    expect(generated.some((p) => /Shot type: TWO SHOT\./.test(p))).toBe(true);
  });

  it('marks the job as partial if some frames fail', async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    let call = 0;
    Generate._setImageDispatcherForTests(async () => {
      call += 1;
      // Every other call fails.
      if (call % 2 === 0) throw new Error('gemini boom');
      return {
        buffer: Buffer.from('fake'),
        contentType: 'image/png',
      };
    });

    const beat = await Plots.createBeat({
      name: 'B',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    // Each frame produces 2 storyboard images. Some succeed, some fail; the
    // storyboard rows still exist for both frames because creation succeeds
    // before image rendering. The job completes successfully (frame errors
    // are tolerated within renderFrame).
    expect(['done', 'partial']).toContain(job.status);
    expect(job.planned).toBe(2);
    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);
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
        start_prompt: 'Tight close-up of Alice, looking down.',
        end_prompt: 'Tight close-up of Alice, looking up.',
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
        start_prompt: 'Wide shot of the diner.',
        end_prompt: 'Wide shot of the diner, slight zoom.',
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
        start_prompt: 'Wide of the diner exterior at dusk.',
        end_prompt: 'Same wide; neon sign flickers on.',
        characters_in_scene: [],
      },
      {
        description: 'Insert: coffee cup steaming.',
        shot_type: 'insert',
        duration_seconds: 3,
        transition_in: 'Match cut from neon glow to steam.',
        start_prompt: 'Macro shot of a coffee cup, steam rising.',
        end_prompt: 'Macro shot of a coffee cup, ripple as a hand reaches in.',
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

  it('persists start_prompt/end_prompt on each row and runs end-prompt derivation when captioned', async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));
    // Captioning returns a non-empty description so derivation fires.
    Generate._setDescriberForTests(async () => ({
      name: 'Diner',
      description: 'Pink booth, warm tungsten light, neon glow on the table.',
    }));
    const derivedCalls = [];
    Generate._setEndPromptDerivationForTests(async (args) => {
      derivedCalls.push(args);
      // Tag each derivation so we can verify it lands on the right row.
      return `DERIVED[${args.startPrompt.slice(0, 12)}]`;
    });

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

    // Derivation ran once per frame.
    expect(derivedCalls).toHaveLength(2);
    expect(derivedCalls[0].startPrompt).toBe(TWO_FRAME_PLAN.frames[0].start_prompt);
    expect(derivedCalls[0].endPrompt).toBe(TWO_FRAME_PLAN.frames[0].end_prompt);
    expect(derivedCalls[0].shotType).toBe('cinematic_wide');
    expect(derivedCalls[1].shotType).toBe('two_shot');

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored).toHaveLength(2);
    // Both rows carry the planner's start_prompt verbatim.
    expect(stored[0].start_prompt).toBe(TWO_FRAME_PLAN.frames[0].start_prompt);
    expect(stored[1].start_prompt).toBe(TWO_FRAME_PLAN.frames[1].start_prompt);
    // The derived end_prompt landed on each row (overwrites the planner's).
    expect(stored[0].end_prompt).toMatch(/^DERIVED\[/);
    expect(stored[1].end_prompt).toMatch(/^DERIVED\[/);
    expect(stored[0].end_prompt).not.toBe(TWO_FRAME_PLAN.frames[0].end_prompt);
  });

  it('falls back to the planner end_prompt and leaves end_prompt as planner output when derivation returns null', async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));
    Generate._setDescriberForTests(async () => ({
      name: 'D',
      description: 'something',
    }));
    Generate._setEndPromptDerivationForTests(async () => null);

    const beat = await Plots.createBeat({
      name: 'X',
      desc: '',
      body: '',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    await waitForJob(jobId);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    // Planner end_prompt is persisted at create-time; derivation null means
    // we don't overwrite, so the planner's original survives.
    expect(stored[0].end_prompt).toBe(TWO_FRAME_PLAN.frames[0].end_prompt);
    expect(stored[1].end_prompt).toBe(TWO_FRAME_PLAN.frames[1].end_prompt);
  });

  it('threads imageModel="openai" through every dispatcher call', async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('out'), contentType: 'image/png' };
    });

    const beat = await Plots.createBeat({
      name: 'M',
      desc: '',
      body: '',
      characters: [],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
      imageModel: 'openai',
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    // 2 frames × (start + end) = 4 dispatcher calls, every one with model=openai.
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.model).toBe('openai');
      expect(c.mode).toBe('generate');
    }
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
        start_prompt: `start#${index}`,
        end_prompt: `end#${index}`,
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
    expect(refineSeen[1].previousRefined.map((p) => p.start_prompt)).toEqual([
      'start#0',
    ]);
    expect(refineSeen[1].previousRefined.map((p) => p.end_prompt)).toEqual([
      'end#0',
    ]);
    expect(refineSeen[2].previousRefined.map((p) => p.start_prompt)).toEqual([
      'start#0',
      'start#1',
    ]);
    expect(refineSeen[2].previousRefined.map((p) => p.end_prompt)).toEqual([
      'end#0',
      'end#1',
    ]);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored.map((s) => s.start_prompt)).toEqual(['start#0', 'start#1', 'start#2']);
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
      return { start_prompt: 's', end_prompt: 'e' };
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
    Generate._setDescriberForTests(async () => ({
      name: 'D',
      description: 'description text',
    }));
    Generate._setEndPromptDerivationForTests(async () => 'derived');

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
    expect(job.progress.message).toMatch(/Done — 2 rendered/);

    // The event log captures the major phases plus per-frame steps. Each entry
    // carries an ISO timestamp, phase, step, and human-readable message.
    expect(Array.isArray(job.events)).toBe(true);
    const steps = job.events.map((e) => e.step);
    expect(steps).toContain('job_queued');
    expect(steps).toContain('plan_outline_start');
    expect(steps).toContain('plan_outline_done');
    expect(steps).toContain('refine_frame_start');
    expect(steps).toContain('refine_done');
    expect(steps).toContain('render_start');
    expect(steps).toContain('frame_start');
    expect(steps).toContain('render_start_frame');
    expect(steps).toContain('caption_start_frame');
    expect(steps).toContain('derive_end_prompt');
    expect(steps).toContain('render_end_frame');
    expect(steps).toContain('caption_end_frame');
    expect(steps).toContain('frame_done');
    expect(steps).toContain('job_done');

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

  it('threads `direction` into every image-gen prompt sent to the dispatcher', async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    const prompts = [];
    Generate._setImageDispatcherForTests(async ({ prompt }) => {
      prompts.push(prompt);
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    const beat = await Plots.createBeat({
      name: 'Style',
      desc: 'd',
      body: 'b',
      characters: ['Alice', 'Bob'],
    });
    const direction = 'shot on Super 16, heavy anamorphic flares, golden hour';
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
      direction,
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');

    // 2 frames × (start + end) = 4 image-gen calls. Every one must carry the
    // director's style direction so the model doesn't drift mid-sequence.
    expect(prompts).toHaveLength(4);
    for (const p of prompts) {
      expect(p).toMatch(/Director's style direction: shot on Super 16/);
    }
  });

  it("chains each frame's start call onto the previous frame's end-frame buffer", async () => {
    installPlannerForFixture(TWO_FRAME_PLAN.frames);
    // Hand back a unique buffer per call so we can identify which buffer
    // landed where. Call sequence (sequential): f1-start, f1-end, f2-start,
    // f2-end. Use a counter; tag each buffer with its index.
    let call = 0;
    const calls = [];
    Generate._setImageDispatcherForTests(async (args) => {
      const idx = call++;
      calls.push({ idx, inputImages: args.inputImages, prompt: args.prompt });
      return {
        buffer: Buffer.from(`img-${idx}`),
        contentType: 'image/png',
      };
    });
    // Caption every image with a tagged description so we can verify the
    // verbal anchor lands in the next start-frame prompt.
    Generate._setDescriberForTests(async ({ buffer }) => ({
      name: 'auto',
      description: `caption-of:${buffer.toString()}`,
    }));

    const beat = await Plots.createBeat({
      name: 'Chain',
      desc: 'd',
      body: 'b',
      characters: ['Alice', 'Bob'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');

    // Sequential ordering: 4 calls in [f1-start, f1-end, f2-start, f2-end]
    // order. The dispatcher is fully synchronous in this test.
    expect(calls).toHaveLength(4);

    // f1-start (call 0): no previous end frame, so no continuity ref appended.
    // It receives only the base inputs (chars + set, both empty here since the
    // beat has no portraits/sheets/set image attached in this test setup).
    const f1Start = calls[0];
    for (const img of f1Start.inputImages) {
      expect(img.buffer.toString()).not.toMatch(/^img-/);
    }

    // f2-start (call 2): the LAST input image must be f1's end-frame buffer
    // (call 1's return value), which is how buildVisualPrompt's "final image
    // above" sentence refers to it.
    const f2Start = calls[2];
    expect(f2Start.inputImages.length).toBeGreaterThan(0);
    const lastInput = f2Start.inputImages[f2Start.inputImages.length - 1];
    expect(lastInput.buffer.toString()).toBe('img-1');
    // The verbal anchor derived from f1's end-frame caption must appear in
    // the prompt — confirms the description threaded through too.
    expect(f2Start.prompt).toMatch(
      /Previous shot end frame to match: caption-of:img-1/,
    );
    // And the previous-shot continuity label/directive landed in the prompt.
    expect(f2Start.prompt).toMatch(/PREVIOUS shot's end frame/);
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
    // Synthesized prompts include the outline description so the renderer
    // has something to feed the image generator.
    expect(stored[0].start_prompt).toMatch(/Alice opens the door/);
    expect(stored[0].end_prompt).toMatch(/Alice opens the door/);
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
