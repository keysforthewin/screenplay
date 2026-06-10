import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createStoryboard, getStoryboard } = await import('../src/mongo/storyboards.js');
const { setStoryboardCritiqueViaGateway } = await import('../src/web/gateway.js');

const CRIT = {
  overall: 6,
  lowest_lens: 'continuity',
  lenses: [{ lens: 'bible', score: 6, comments: 'ok' }],
  model: 'test',
  created_at: new Date(),
  target: 'prompt',
};

describe('setStoryboardCritiqueViaGateway', () => {
  beforeEach(() => fakeDb.reset());

  it('persists prompt_critique on the prompt target', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    await setStoryboardCritiqueViaGateway({
      storyboardId: sb._id.toString(),
      beatId: '0'.repeat(24),
      target: 'prompt',
      critique: CRIT,
    });
    const reread = await getStoryboard(undefined, sb._id);
    expect(reread.prompt_critique.overall).toBe(6);
    expect(reread.image_critique).toBeNull();
  });

  it('persists image_critique on the image target', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    await setStoryboardCritiqueViaGateway({
      storyboardId: sb._id.toString(),
      beatId: '0'.repeat(24),
      target: 'image',
      critique: { ...CRIT, target: 'image' },
    });
    const reread = await getStoryboard(undefined, sb._id);
    expect(reread.image_critique.overall).toBe(6);
    expect(reread.prompt_critique).toBeNull();
  });

  it('clears critique when passed null', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    await setStoryboardCritiqueViaGateway({ storyboardId: sb._id.toString(), beatId: '0'.repeat(24), target: 'prompt', critique: CRIT });
    await setStoryboardCritiqueViaGateway({ storyboardId: sb._id.toString(), beatId: '0'.repeat(24), target: 'prompt', critique: null });
    const reread = await getStoryboard(undefined, sb._id);
    expect(reread.prompt_critique).toBeNull();
  });
});
