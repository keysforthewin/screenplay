// resolveFrameAssignment draws reference images from the shot's planner-scored
// reference list (frames[0].reference_ids / reference_scores) — but only for
// models that accept references, after the frame-pool images, capped at the
// model's default limit. Plus resolveVideoModelByAnyId's id forms.
import { describe, it, expect } from 'vitest';
import {
  resolveFrameAssignment,
  validateAssignment,
  scoredShotReferenceIds,
  resolveVideoModelByAnyId,
  DEFAULT_VIDEO_REFERENCE_LIMIT,
  VIDEO_MODELS,
} from '../src/fal/videoModels.js';

function sb({ frames = [], refs = [], scores = {} } = {}) {
  const f = frames.map((image_id) => ({ image_id }));
  if (!f.length) f.push({ image_id: null });
  f[0].reference_ids = refs;
  f[0].reference_scores = scores;
  return { frames: f, audio_file_id: null, video_upload_file_id: null };
}

const refModel = { inputs: { startFrame: 'unused', endFrame: 'unused', referenceImages: 'required' } };
const startAndRef = { inputs: { startFrame: 'optional', endFrame: 'unused', referenceImages: 'optional' } };
const startOnly = { inputs: { startFrame: 'required', endFrame: 'unused', referenceImages: 'unused' } };

describe('scoredShotReferenceIds', () => {
  it('orders by score, highest first, stable for ties and unscored', () => {
    const out = scoredShotReferenceIds(sb({ refs: ['a', 'b', 'c', 'd'], scores: { b: 0.9, c: 0.9, d: 0.2 } }));
    expect(out).toEqual(['b', 'c', 'd', 'a']);
  });
  it('is empty without a first frame', () => {
    expect(scoredShotReferenceIds({ frames: [] })).toEqual([]);
  });
});

describe('resolveFrameAssignment with scored references', () => {
  it('a reference-to-video model gets the scored artwork, ordered and capped, with no start frame', () => {
    const refs = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const out = resolveFrameAssignment(refModel, sb({ refs, scores: { r5: 1, r4: 0.8 } }));
    expect(out.startFrameId).toBe(null);
    expect(out.referenceImageIds).toEqual(['r5', 'r4', 'r1'].slice(0, DEFAULT_VIDEO_REFERENCE_LIMIT));
    expect(out.referenceImageIds).toHaveLength(DEFAULT_VIDEO_REFERENCE_LIMIT);
    // Validates: the required references are present without any still.
    expect(validateAssignment(refModel, out, sb({ refs }))).toEqual([]);
  });

  it('frame-pool images come first and are never capped; artwork fills the remaining slots', () => {
    const out = resolveFrameAssignment(startAndRef, sb({ frames: ['start', 'p1', 'p2', 'p3'], refs: ['a', 'b'] }));
    expect(out.startFrameId).toBe('start');
    // 3 pool images already fill the default limit → no artwork appended.
    expect(out.referenceImageIds).toEqual(['p1', 'p2', 'p3']);
    const out2 = resolveFrameAssignment(startAndRef, sb({ frames: ['start', 'p1'], refs: ['a', 'b', 'c'] }));
    expect(out2.referenceImageIds).toEqual(['p1', 'a', 'b']);
  });

  it('a model that does not accept references never receives the artwork', () => {
    const out = resolveFrameAssignment(startOnly, sb({ frames: ['start'], refs: ['a', 'b'] }));
    expect(out.referenceImageIds).toEqual([]);
    expect(out.startFrameId).toBe('start');
  });

  it('an explicit ref list may name scored artwork as well as frame images', () => {
    const out = resolveFrameAssignment(startAndRef, sb({ frames: ['start', 'p1'], refs: ['a'] }), { ref: ['a', 'p1', 'zzz'] });
    expect(out.referenceImageIds).toEqual(['a', 'p1']);
  });

  it('honours a registered model\'s maxReferenceImages', () => {
    const model = { ...refModel, maxReferenceImages: 1 };
    const out = resolveFrameAssignment(model, sb({ refs: ['a', 'b'] }));
    expect(out.referenceImageIds).toEqual(['a']);
  });
});

describe('resolveVideoModelByAnyId', () => {
  it('resolves a registry id and a registered endpoint id to the same registered model', async () => {
    const byId = await resolveVideoModelByAnyId('kling-3-pro');
    const byEndpoint = await resolveVideoModelByAnyId(VIDEO_MODELS.find((m) => m.id === 'kling-3-pro').falModel);
    expect(byId).toBe(byEndpoint);
    expect(byEndpoint._synthetic).toBeUndefined();
  });
  it('returns null for nothing', async () => {
    expect(await resolveVideoModelByAnyId('')).toBe(null);
    expect(await resolveVideoModelByAnyId(null)).toBe(null);
  });
});
