// Tests for the per-beat in-process mutex used by Generate and Edit.

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
const Generate = await import('../src/web/storyboardGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

beforeEach(() => {
  fakeDb.reset();
  uploadCounter.n = 0;
  BeatLocks._clearBeatLocksForTests();
  _resetAnthropicClientForTests();
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const SIMPLE_PLAN = {
  frames: [
    {
      description: 'one',
      start_prompt: 's1',
      end_prompt: 'e1',
      characters_in_scene: [],
    },
  ],
};

describe('beatLocks', () => {
  it('queues sequential withBeatLock calls for the same beat', async () => {
    const order = [];
    const d1 = deferred();
    const d2 = deferred();
    const p1 = BeatLocks.withBeatLock('beat-x', async () => {
      order.push('start1');
      await d1.promise;
      order.push('end1');
      return 1;
    });
    const p2 = BeatLocks.withBeatLock('beat-x', async () => {
      order.push('start2');
      await d2.promise;
      order.push('end2');
      return 2;
    });
    // Let microtasks settle: p1 should have started, p2 should not.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start1']);
    d1.resolve();
    await p1;
    expect(order).toEqual(['start1', 'end1', 'start2']);
    d2.resolve();
    await p2;
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('runs different beats in parallel', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const order = [];
    const p1 = BeatLocks.withBeatLock('beat-a', async () => {
      order.push('start-a');
      await d1.promise;
      order.push('end-a');
    });
    const p2 = BeatLocks.withBeatLock('beat-b', async () => {
      order.push('start-b');
      await d2.promise;
      order.push('end-b');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order.sort()).toEqual(['start-a', 'start-b']);
    d2.resolve();
    d1.resolve();
    await Promise.all([p1, p2]);
  });
});

describe('generation rejects concurrent jobs for the same beat', () => {
  it('throws BeatBusyError when a generation is already in flight', async () => {
    // Block Anthropic so the first job stays in 'planning'.
    const blocker = deferred();
    _setAnthropicClientForTests(({
      messages: {
        create: vi.fn(async () => {
          await blocker.promise;
          return {
            content: [
              { type: 'tool_use', name: 'plan_storyboard', input: SIMPLE_PLAN },
            ],
          };
        }),
      },
    }));
    Generate._setGeminiForTests(async () => ({
      buffer: Buffer.from('x'),
      contentType: 'image/png',
    }));

    const beat = await Plots.createBeat({
      name: 'L', desc: '', body: '', characters: [],
    });

    const jobIdP = Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    // Wait for the lock to actually be claimed.
    await Promise.resolve();
    await Promise.resolve();

    let err;
    try {
      await Generate.startStoryboardGenerationJob({
        beatId: beat._id.toString(),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('BEAT_BUSY');

    // Unblock and let the first job finish so we don't leak it.
    blocker.resolve();
    const firstJobId = await jobIdP;
    for (let i = 0; i < 200; i++) {
      const job = Generate.getStoryboardGenerationJob(firstJobId);
      if (job && (job.status === 'done' || job.status === 'error' || job.status === 'partial')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  });
});
