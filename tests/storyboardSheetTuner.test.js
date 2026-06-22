import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
// Guard: these tests must use the seams, never a real Anthropic call.
vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => { throw new Error('no live Anthropic in tests'); },
}));

const Tuner = await import('../src/web/storyboardSheetTuner.js');

beforeEach(() => {
  Tuner._setShotPlateScanForTests(null);
  Tuner._setConsolidatePlatesForTests(null);
});

describe('buildShotScanUserText', () => {
  it('includes the shot summary, image critique, and existing plate catalog', () => {
    const sb = {
      summary: 'Hero enters the alley',
      text_prompt: 'wide shot',
      characters_in_scene: ['Hero'],
      image_critique: { overall: 4, lenses: [{ lens: 'bible', score: 3, comments: 'background is wrong' }] },
    };
    const text = Tuner.buildShotScanUserText({ sb, existingPlates: [{ name: 'Street', prompt: 'a street' }] });
    expect(text).toContain('Hero enters the alley');
    expect(text).toContain('background is wrong');
    expect(text).toContain('1. Street — a street');
  });
});

describe('tuneStoryboardImageSheet', () => {
  it('collects proposals from shots that need a plate and skips covered shots', async () => {
    Tuner._setShotPlateScanForTests(async ({ sb }) =>
      sb.summary === 'gap'
        ? { needs_plate: true, name: 'New plate', prompt: 'an empty room', justification: 'no plate covers this' }
        : { needs_plate: false });
    Tuner._setConsolidatePlatesForTests(async ({ proposals }) => proposals); // identity dedup

    const storyboards = [{ summary: 'gap' }, { summary: 'covered' }];
    const { images } = await Tuner.tuneStoryboardImageSheet({ storyboards, existingPlates: [] });
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ name: 'New plate', prompt: 'an empty room', quote: '' });
  });

  it('drops proposals missing a name or prompt', async () => {
    Tuner._setShotPlateScanForTests(async () => ({ needs_plate: true, name: '', prompt: 'x' }));
    const { images } = await Tuner.tuneStoryboardImageSheet({ storyboards: [{ summary: 'a' }], existingPlates: [] });
    expect(images).toEqual([]);
  });

  it('returns proposals unchanged through consolidation when only one', async () => {
    Tuner._setShotPlateScanForTests(async () => ({ needs_plate: true, name: 'P', prompt: 'p' }));
    // consolidate is skipped for <=1 proposal, so the override must NOT be called.
    let called = false;
    Tuner._setConsolidatePlatesForTests(async () => { called = true; return []; });
    const { images } = await Tuner.tuneStoryboardImageSheet({ storyboards: [{ summary: 'a' }], existingPlates: [] });
    expect(called).toBe(false);
    expect(images).toHaveLength(1);
  });
});
