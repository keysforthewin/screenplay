// Tests for the page-level "Delete all" gateway helper.

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

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Gateway = await import('../src/web/gateway.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('deleteAllStoryboardsForBeatViaGateway', () => {
  it('removes every storyboard for the beat and returns a count', async () => {
    const beat = await Plots.createBeat({
      name: 'B', desc: '', body: '', characters: [],
    });
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'one' });
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'two' });
    await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'three' });

    const result = await Gateway.deleteAllStoryboardsForBeatViaGateway({ beatId: beat._id });
    expect(result).toEqual({ ok: true, removed_count: 3 });

    const after = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(after).toHaveLength(0);
  });

  it('does not affect storyboards on other beats', async () => {
    const beatA = await Plots.createBeat({ name: 'A', desc: '', body: '', characters: [] });
    const beatB = await Plots.createBeat({ name: 'B', desc: '', body: '', characters: [] });
    await Storyboards.createStoryboard({ beatId: beatA._id, textPrompt: 'a1' });
    await Storyboards.createStoryboard({ beatId: beatB._id, textPrompt: 'b1' });
    await Storyboards.createStoryboard({ beatId: beatB._id, textPrompt: 'b2' });

    await Gateway.deleteAllStoryboardsForBeatViaGateway({ beatId: beatB._id });

    const stillA = await Storyboards.listStoryboards({ beatId: beatA._id });
    const goneB = await Storyboards.listStoryboards({ beatId: beatB._id });
    expect(stillA.map((s) => s.text_prompt)).toEqual(['a1']);
    expect(goneB).toHaveLength(0);
  });

  it('is a no-op when the beat has no storyboards', async () => {
    const beat = await Plots.createBeat({ name: 'E', desc: '', body: '', characters: [] });
    const result = await Gateway.deleteAllStoryboardsForBeatViaGateway({ beatId: beat._id });
    expect(result).toEqual({ ok: true, removed_count: 0 });
  });
});
