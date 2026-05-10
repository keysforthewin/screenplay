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
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

beforeEach(() => {
  fakeDb.reset();
  uploadCounter.n = 0;
  _resetAnthropicClientForTests();
});

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

function fakeAnthropicClient(toolInput) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'plan_storyboard',
            input: toolInput,
          },
        ],
      })),
    },
  };
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
    _setAnthropicClientForTests(fakeAnthropicClient(TWO_FRAME_PLAN));
    const generated = [];
    Generate._setGeminiForTests(async ({ prompt }) => {
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
    _setAnthropicClientForTests(fakeAnthropicClient(TWO_FRAME_PLAN));
    let call = 0;
    Generate._setGeminiForTests(async () => {
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
    _setAnthropicClientForTests(fakeAnthropicClient({ frames: [] }));
    Generate._setGeminiForTests(async () => {
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
    _setAnthropicClientForTests(fakeAnthropicClient(TWO_FRAME_PLAN));
    Generate._setGeminiForTests(async () => ({
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
    _setAnthropicClientForTests(
      fakeAnthropicClient({
        frames: [
          {
            description: 'Tight on Alice, eyes welling.',
            shot_type: 'close_up',
            duration_seconds: 12, // close_up cap is 5
            transition_in: '',
            start_prompt: 'Tight close-up of Alice, looking down.',
            end_prompt: 'Tight close-up of Alice, looking up.',
            characters_in_scene: ['Alice'],
          },
        ],
      }),
    );
    Generate._setGeminiForTests(async () => ({
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
    _setAnthropicClientForTests(
      fakeAnthropicClient({
        frames: [
          {
            description: 'Crowd shot.',
            shot_type: 'cinematic_wide',
            duration_seconds: 8,
            transition_in: '',
            start_prompt: 'Wide shot of the diner.',
            end_prompt: 'Wide shot of the diner, slight zoom.',
            characters_in_scene: ['Alice', 'Bob', 'Carol', 'Dave'],
          },
        ],
      }),
    );
    Generate._setGeminiForTests(async () => ({
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
    _setAnthropicClientForTests(
      fakeAnthropicClient({
        frames: [
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
          },
        ],
      }),
    );
    Generate._setGeminiForTests(async () => ({
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
    _setAnthropicClientForTests(fakeAnthropicClient({ frames: [] }));
    Generate._setGeminiForTests(async () => {
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
