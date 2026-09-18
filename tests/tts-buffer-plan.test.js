import { describe, it, expect } from 'vitest';
import { planBuffer, MIN_BUFFER_SEC, RATE_SAFETY, formatDuration } from '../web/src/tts/bufferPlan.js';

const chunk = (audioSec, synthSec, chars = 100) => ({ audioSec, synthSec, chars });

describe('planBuffer', () => {
  it('needs T·(1−R) banked when slower than realtime', () => {
    // 0.5× measured, 5s per 100 chars, 1000 chars → 50s total.
    const plan = planBuffer({ chunks: [chunk(5, 10)], totalChars: 1000, unplayedSec: 5, done: false });
    expect(plan.rate).toBeCloseTo(0.5);
    expect(plan.totalSec).toBeCloseTo(50);
    expect(plan.neededSec).toBeCloseTo(50 * (1 - 0.5 * RATE_SAFETY));
    expect(plan.ready).toBe(false);
    expect(plan.waitSec).toBeCloseTo((plan.neededSec - 5) / 0.5);
  });

  it('that bank is sufficient: simulated playback never underruns', () => {
    const rate = 0.6;
    const total = 300;
    const need = planBuffer({
      chunks: [chunk(6, 10), chunk(6, 10)], totalChars: 5000, unplayedSec: 0, done: false,
    }).neededSec;
    // Generation continues at the TRUE rate from `need` banked; playback at 1×.
    for (let t = 0; t <= total; t += 1) {
      const generated = Math.min(total, need + rate * t);
      const played = Math.min(total, t);
      expect(generated).toBeGreaterThanOrEqual(played);
    }
  });

  it('only needs the floor when faster than realtime', () => {
    const plan = planBuffer({ chunks: [chunk(5, 1)], totalChars: 1000, unplayedSec: 5, done: false });
    expect(plan.neededSec).toBe(MIN_BUFFER_SEC);
    expect(plan.ready).toBe(true);
  });

  it('ignores the warmup chunk once there is a second measurement', () => {
    const plan = planBuffer({
      chunks: [chunk(5, 50), chunk(5, 2.5)], totalChars: 1000, unplayedSec: 10, done: false,
    });
    expect(plan.rate).toBeCloseTo(2);
  });

  it('is ready when generation is done or nothing remains', () => {
    expect(planBuffer({ chunks: [chunk(5, 50)], totalChars: 1000, unplayedSec: 1, done: true }).ready).toBe(true);
    expect(planBuffer({ chunks: [chunk(5, 50)], totalChars: 100, unplayedSec: 1, done: false }).ready).toBe(true);
  });

  it('unmeasured chunks (no synth timing) start immediately', () => {
    const plan = planBuffer({ chunks: [{ audioSec: 1, synthSec: 0, chars: 0 }], totalChars: 0, unplayedSec: 1, done: false });
    expect(plan.ready).toBe(true);
  });

  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(190)).toBe('3m10s');
  });
});
