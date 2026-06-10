// Tests for the per-beat lock when running dialog generation.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
const Generate = await import('../src/web/dialogGenerate.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  BeatLocks._clearBeatLocksForTests();
  _resetAnthropicClientForTests();
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const SIMPLE = {
  entries: [{ character: 'Alice', body: 'hi' }],
};

describe('dialog generation rejects concurrent jobs for the same beat', () => {
  it('throws BeatBusyError when a generation is already in flight', async () => {
    const blocker = deferred();
    _setAnthropicClientForTests(({
      messages: {
        create: vi.fn(async () => {
          await blocker.promise;
          return {
            content: [
              { type: 'tool_use', name: 'populate_dialog', input: SIMPLE },
            ],
          };
        }),
      },
    }));

    const beat = await Plots.createBeat({ projectId,
      name: 'L', desc: '', body: '', characters: [],
    });

    const jobIdP = Generate.startDialogGenerationJob({ projectId,
      beatId: beat._id.toString(),
    });
    // Wait for the lock to actually be claimed.
    await Promise.resolve();
    await Promise.resolve();

    let err;
    try {
      await Generate.startDialogGenerationJob({ projectId,
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
      const job = Generate.getDialogGenerationJob(firstJobId);
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  it('allows generation on a different beat to proceed in parallel', async () => {
    _setAnthropicClientForTests(({
      messages: {
        create: vi.fn(async () => ({
          content: [
            { type: 'tool_use', name: 'populate_dialog', input: SIMPLE },
          ],
        })),
      },
    }));
    const beatA = await Plots.createBeat({ projectId, name: 'A', desc: '', body: '', characters: [] });
    const beatB = await Plots.createBeat({ projectId, name: 'B', desc: '', body: '', characters: [] });
    const idA = await Generate.startDialogGenerationJob({ projectId, beatId: beatA._id.toString() });
    const idB = await Generate.startDialogGenerationJob({ projectId, beatId: beatB._id.toString() });
    expect(idA).not.toBe(idB);
    for (const id of [idA, idB]) {
      for (let i = 0; i < 200; i++) {
        const job = Generate.getDialogGenerationJob(id);
        if (job && (job.status === 'done' || job.status === 'error')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(Generate.getDialogGenerationJob(id).status).toBe('done');
    }
  });
});
