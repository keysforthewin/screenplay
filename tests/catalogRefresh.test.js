// The shared fal-catalog refresh runner. One single-flight slot per named job
// ('video' regenerates data/fal-models.json, 'image' regenerates the playground
// catalog that backs the image-model picker), so refreshing one never blocks or
// clobbers the other.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  getCatalogRefreshState,
  startCatalogRefresh,
  _setScriptRunnerForTests,
} = await import('../src/fal/catalogRefresh.js');

let resolvers;

beforeEach(() => {
  resolvers = [];
  // Replace the child-process spawn with a promise we control, so nothing
  // actually scrapes fal.ai during the suite.
  _setScriptRunnerForTests(
    (script) => new Promise((resolve, reject) => {
      resolvers.push({ script, resolve, reject });
    }),
  );
});

afterEach(async () => {
  // Let any in-flight job settle so it doesn't leak into the next test.
  for (const r of resolvers) r.resolve();
  await Promise.resolve();
  _setScriptRunnerForTests(null);
});

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('startCatalogRefresh', () => {
  it('starts the video job by default', () => {
    const out = startCatalogRefresh();
    expect(out.started).toBe(true);
    expect(getCatalogRefreshState().running).toBe(true);
  });

  it('runs the image job from its own single-flight slot', async () => {
    startCatalogRefresh('video');
    const out = startCatalogRefresh('image');

    expect(out.started).toBe(true);
    expect(getCatalogRefreshState('image').running).toBe(true);
    expect(getCatalogRefreshState('video').running).toBe(true);
    expect(resolvers.some((r) => r.script.includes('playground'))).toBe(true);
  });

  it('refuses a second start while the same job is running', () => {
    startCatalogRefresh('image');
    const second = startCatalogRefresh('image');
    expect(second.started).toBe(false);
    expect(second.state.running).toBe(true);
  });

  it('clears running and stamps finished_at when the scripts complete', async () => {
    startCatalogRefresh('image');
    for (const r of resolvers) r.resolve();
    await settle();

    const state = getCatalogRefreshState('image');
    expect(state.running).toBe(false);
    expect(state.finished_at).toBeTruthy();
    expect(state.error).toBeNull();
  });

  it('records the failure and frees the slot when a script fails', async () => {
    startCatalogRefresh('image');
    resolvers[0].reject(new Error('scrape exploded'));
    await settle();

    const state = getCatalogRefreshState('image');
    expect(state.running).toBe(false);
    expect(state.error).toMatch(/scrape exploded/);
    // The slot is usable again — a failed refresh must not wedge the button.
    expect(startCatalogRefresh('image').started).toBe(true);
  });

  it('rejects an unknown job name', () => {
    expect(() => startCatalogRefresh('nonsense')).toThrow(/unknown catalog job/i);
    expect(() => getCatalogRefreshState('nonsense')).toThrow(/unknown catalog job/i);
  });
});
