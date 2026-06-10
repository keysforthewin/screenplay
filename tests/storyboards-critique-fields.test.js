import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createStoryboard, getStoryboard, updateStoryboard } = await import(
  '../src/mongo/storyboards.js'
);

const SAMPLE = {
  overall: 7,
  lenses: [{ lens: 'bible', score: 7, comments: 'ok' }],
  model: 'claude-opus-4-7',
  created_at: new Date(),
};

describe('storyboard critique fields', () => {
  beforeEach(() => fakeDb.reset());

  it('new rows default prompt_critique/image_critique to null', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    expect(sb.prompt_critique).toBeNull();
    expect(sb.image_critique).toBeNull();
  });

  it('updateStoryboard accepts a prompt_critique object and persists it', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    const updated = await updateStoryboard(undefined, sb._id, { prompt_critique: SAMPLE });
    expect(updated.prompt_critique.overall).toBe(7);
    expect(updated.prompt_critique.lenses[0].lens).toBe('bible');
    const reread = await getStoryboard(undefined, sb._id);
    expect(reread.prompt_critique.overall).toBe(7);
  });

  it('updateStoryboard accepts null to clear image_critique', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    await updateStoryboard(undefined, sb._id, { image_critique: SAMPLE });
    const cleared = await updateStoryboard(undefined, sb._id, { image_critique: null });
    expect(cleared.image_critique).toBeNull();
  });

  it('updateStoryboard rejects a non-object prompt_critique', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    await expect(updateStoryboard(undefined, sb._id, { prompt_critique: 'nope' })).rejects.toThrow(
      /prompt_critique/,
    );
  });
});
