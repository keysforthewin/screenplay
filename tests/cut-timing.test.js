import { describe, it, expect } from 'vitest';
import {
  cameraTravels,
  cutHandles,
  snapDurationUp,
  renderSecondsForCut,
  describeTiming,
  trimPolicyForCut,
  resolveTrim,
  trimWindow,
} from '../src/web/cutTiming.js';

const pan = (extra = {}) => ({ duration_seconds: 6, camera: { movement: 'pan' }, dialog_ids: [], ...extra });
const held = (extra = {}) => ({ duration_seconds: 1.5, camera: { movement: 'static' }, dialog_ids: [], ...extra });

describe('cutHandles', () => {
  it('gives a travelling camera half a second at each end', () => {
    expect(cameraTravels(pan())).toBe(true);
    expect(cutHandles(pan())).toEqual({ head: 0.5, tail: 0.5 });
    expect(cutHandles(pan({ camera: { movement: 'push_in' } }))).toEqual({ head: 0.5, tail: 0.5 });
  });

  it('gives a held camera none', () => {
    expect(cameraTravels(held())).toBe(false);
    expect(cutHandles(held())).toEqual({ head: 0, tail: 0 });
    expect(cutHandles(held({ camera: { movement: 'handheld' } }))).toEqual({ head: 0, tail: 0 });
  });

  it('never adds automatic handles to a cut that covers dialogue', () => {
    expect(cutHandles(pan({ dialog_ids: ['a'] }))).toEqual({ head: 0, tail: 0 });
  });

  it('uses hand-set trims as the handles', () => {
    expect(cutHandles(held({ trim_head_seconds: 1 }))).toEqual({ head: 1, tail: 0 });
    expect(cutHandles(pan({ trim_head_seconds: 0, trim_tail_seconds: 0 }))).toEqual({ head: 0, tail: 0 });
  });
});

describe('snapDurationUp', () => {
  it('rounds up to whole seconds for an int param', () => {
    expect(snapDurationUp(1.5, { type: 'int', min: 1, max: 60, step: 1 })).toBe(2);
    expect(snapDurationUp(7, { type: 'int', min: 1, max: 60, step: 1 })).toBe(7);
  });

  it('rounds up to the step for a float param', () => {
    expect(snapDurationUp(1.2, { type: 'float', min: 1, max: 10, step: 0.5 })).toBe(1.5);
    expect(snapDurationUp(1.5, { type: 'float', min: 1, max: 10, step: 0.5 })).toBe(1.5);
  });

  it('clamps to the model range', () => {
    expect(snapDurationUp(1.5, { type: 'int', min: 4, max: 15 })).toBe(4);
    expect(snapDurationUp(13, { type: 'float', min: 1, max: 10, step: 0.5 })).toBe(10);
  });

  it('passes a value through when there is no spec', () => {
    expect(snapDurationUp(6.5)).toBe(6.5);
    expect(snapDurationUp(0)).toBe(null);
  });
});

describe('renderSecondsForCut', () => {
  const ltx = { type: 'int', min: 1, max: 60, step: 1 };

  it('adds the handles to a pan', () => {
    expect(renderSecondsForCut(pan(), ltx)).toMatchObject({ cut_seconds: 6, head: 0.5, tail: 0.5, requested: 7, seconds: 7, clamp: null });
  });

  it('snaps a quick cut up to what the model renders', () => {
    expect(renderSecondsForCut(held(), ltx)).toMatchObject({ cut_seconds: 1.5, requested: 1.5, seconds: 2, clamp: null });
  });

  it('reports a clamp with a line the preview can show', () => {
    const short = renderSecondsForCut(held(), { type: 'int', min: 4, max: 15 });
    expect(short).toMatchObject({ seconds: 4, clamp: 'min' });
    expect(describeTiming(short, 'Seedance 2.0')).toBe(
      "Cut wants 1.5 s; Seedance 2.0's minimum is 4 s — rendered at 4 s, the assembly trims it to 1.5 s.",
    );
    const long = renderSecondsForCut(pan({ duration_seconds: 12 }), { type: 'float', min: 1, max: 10, step: 0.5 });
    expect(long).toMatchObject({ requested: 13, seconds: 10, clamp: 'max' });
    expect(describeTiming(long, 'Wan 2.2')).toBe("Cut wants 13 s; Wan 2.2's maximum is 10 s — rendered at 10 s.");
    expect(describeTiming(renderSecondsForCut(pan(), ltx), 'LTX')).toBe(null);
  });

  it('is null for a cut with no length', () => {
    expect(renderSecondsForCut({ camera: { movement: 'pan' } }, ltx)).toBe(null);
  });
});

describe('trimPolicyForCut + resolveTrim', () => {
  it('keeps the middle of a travelling move', () => {
    const policy = trimPolicyForCut(pan());
    expect(policy).toEqual({ want_seconds: 6, anchor: 'centre' });
    expect(resolveTrim(7, policy)).toEqual({ start: 0.5, duration: 6 });
  });

  it('keeps the end of a held cut that was rendered long', () => {
    const policy = trimPolicyForCut(held());
    expect(policy).toEqual({ want_seconds: 1.5, anchor: 'tail' });
    expect(resolveTrim(2, policy)).toEqual({ start: 0.5, duration: 1.5 });
    expect(resolveTrim(4.04, policy)).toEqual({ start: 2.54, duration: 1.5 });
  });

  it('leaves a clip alone when it is no longer than the cut', () => {
    expect(resolveTrim(5, trimPolicyForCut(held({ duration_seconds: 11 })))).toBe(null);
    expect(resolveTrim(6.04, trimPolicyForCut(held({ duration_seconds: 6 })))).toBe(null);
  });

  it('leaves a dialogue cut whole', () => {
    expect(trimPolicyForCut(held({ dialog_ids: ['a'], duration_seconds: 3 }))).toBe(null);
  });

  it('honours hand-set trims over the automatic window', () => {
    const policy = trimPolicyForCut(pan({ trim_head_seconds: 1, trim_tail_seconds: 0.25 }));
    expect(policy).toEqual({ head: 1, tail: 0.25 });
    expect(resolveTrim(7, policy)).toEqual({ start: 1, duration: 5.75 });
    // Zero on both ends switches the automatic trim off.
    expect(resolveTrim(7, trimPolicyForCut(pan({ trim_head_seconds: 0, trim_tail_seconds: 0 })))).toBe(null);
    // Trims that leave nothing are ignored.
    expect(resolveTrim(2, { head: 1.5, tail: 1 })).toBe(null);
  });

  it('returns null without a clip length or a policy', () => {
    expect(resolveTrim(null, { want_seconds: 2, anchor: 'tail' })).toBe(null);
    expect(resolveTrim(5, null)).toBe(null);
  });

  it('reports the kept window for display', () => {
    expect(trimWindow(7, pan())).toEqual({ start: 0.5, end: 6.5 });
    expect(trimWindow(6, pan())).toBe(null);
  });
});
