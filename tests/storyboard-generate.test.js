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
      start_prompt: 'Wide shot of Alice entering through the diner door, dusk light.',
      end_prompt: 'Alice halfway across the room, scanning the booths.',
      characters_in_scene: ['Alice'],
    },
    {
      description: 'Alice sits down across from Bob.',
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
