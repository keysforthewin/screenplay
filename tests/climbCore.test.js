// The climb loop and its stop rules, with scripted evaluate / improve.
import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { normalizeClimbParams, createClimbState, runClimbLoop, DEFAULT_STOP_AFTER } = await import('../src/web/climbCore.js');

// Runs a climb whose evaluations return `scores` in order (baseline first).
async function climb(scores, params = {}, hooks = {}) {
  const state = createClimbState('writing', { target: 8, direction: '', stop_after: 3, ...params });
  const log = [];
  let i = 0;
  await runClimbLoop({
    state,
    evaluate: async () => ({ score: scores[i++] }),
    improve: async (n) => { log.push(`improve ${n}`); return hooks.improve?.(n, state); },
    keep: async (_r, n) => { log.push(`keep ${n}`); },
    revert: async (_r, n) => { log.push(`revert ${n}`); },
    summarize: async () => 'why',
    save: async () => {},
  });
  return { state, log };
}

describe('normalizeClimbParams', () => {
  it('defaults stop_after to 3 and rounds the target to the scale', () => {
    expect(normalizeClimbParams({ target: '8.56', direction: '  tighter  ' }, 'writing')).toEqual({ target: 8.6, direction: 'tighter', stop_after: DEFAULT_STOP_AFTER });
    expect(DEFAULT_STOP_AFTER).toBe(3);
    expect(normalizeClimbParams({ target: 89.6, stop_after: 5 }, 'artwork')).toEqual({ target: 90, direction: '', stop_after: 5 });
  });

  it('rejects an out-of-range target and a bad stop_after with 400', () => {
    for (const body of [{}, { target: 11 }, { target: 0 }, { target: 'x' }, { target: 8, stop_after: 0 }, { target: 8, stop_after: 2.5 }, { target: 8, stop_after: 99 }]) {
      expect(() => normalizeClimbParams(body, 'writing')).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(() => normalizeClimbParams({ target: 101 }, 'artwork')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('runClimbLoop', () => {
  it('does nothing when the baseline already meets the target', async () => {
    const { state, log } = await climb([8.2]);
    expect(state).toMatchObject({ status: 'done', stop_reason: 'target', start_score: 8.2, best_score: 8.2, wall_summary: null });
    expect(log).toEqual(['keep 0']);
  });

  it('climbs until the target, keeping gains and reverting the rest', async () => {
    const { state, log } = await climb([5, 6, 5.5, 8.1]);
    expect(state).toMatchObject({ stop_reason: 'target', best_score: 8.1, stalls: 0 });
    expect(state.attempts.map((a) => [a.score, a.kept])).toEqual([[6, true], [5.5, false], [8.1, true]]);
    expect(log).toEqual(['keep 0', 'improve 1', 'keep 1', 'improve 2', 'revert 2', 'improve 3', 'keep 3']);
  });

  it('stops after stop_after attempts in a row without an increase (a tie is not an increase)', async () => {
    const { state } = await climb([5, 6, 6, 5, 6, 9], { stop_after: 3 });
    expect(state).toMatchObject({ status: 'done', stop_reason: 'stalled', best_score: 6, stalls: 3, wall_summary: 'why' });
    expect(state.attempts).toHaveLength(4);
  });

  it('a gain resets the stall count', async () => {
    const { state } = await climb([5, 5, 5.5, 5, 5], { stop_after: 2 });
    expect(state.stop_reason).toBe('stalled');
    expect(state.attempts).toHaveLength(4);
    expect(state.best_score).toBe(5.5);
  });

  it('stops at the attempt limit', async () => {
    const scores = [1, ...Array.from({ length: 20 }, (_, i) => 1 + (i + 1) * 0.1)];
    const { state } = await climb(scores);
    expect(state.stop_reason).toBe('max_attempts');
    expect(state.attempts).toHaveLength(state.max_attempts);
    expect(state.wall_summary).toBe('why');
  });

  it('stops when there is nothing left to improve', async () => {
    const { state } = await climb([5], {}, { improve: () => false });
    expect(state).toMatchObject({ stop_reason: 'nothing_to_improve', wall_summary: 'why' });
    expect(state.attempts).toHaveLength(0);
  });

  it('a cancel during an attempt reverts it and skips the summary', async () => {
    const { state, log } = await climb([5, 9], {}, { improve: (_n, s) => { s.cancel_requested = true; } });
    expect(state).toMatchObject({ status: 'done', stop_reason: 'cancelled', best_score: 5, wall_summary: null });
    expect(log).toEqual(['keep 0', 'improve 1', 'revert 1']);
  });

  it('a failure ends the climb as an error after reverting', async () => {
    const { state, log } = await climb([5], {}, { improve: () => { throw new Error('boom'); } });
    expect(state).toMatchObject({ status: 'error', stop_reason: 'error', error: 'boom', wall_summary: null });
    expect(log.at(-1)).toBe('revert 1');
    expect(state.finished_at).toBeInstanceOf(Date);
  });
});
