import { describe, it, expect } from 'vitest';
import { modelAcceptsAttachments, modelReadiness } from '../web/src/playgroundFilter.js';

function model(inputs) {
  return {
    endpoint_id: 'test/x',
    inputs: {
      prompt: 'unused',
      prompt_param: null,
      image: { need: 'unused', params: [], required_count: 0, max: 0 },
      audio: { need: 'unused', param: null, list: false },
      video: { need: 'unused', param: null, list: false },
      ...inputs,
    },
  };
}

const T2I = model({ prompt: 'required', prompt_param: 'prompt' });
const I2V = model({
  prompt: 'optional', prompt_param: 'prompt',
  image: { need: 'required', params: [{ name: 'image_url', list: false, required: true }], required_count: 1, max: 1 },
});
const MULTI_IMG = model({
  prompt: 'required', prompt_param: 'prompt',
  image: { need: 'optional', params: [{ name: 'image_urls', list: true, required: false }], required_count: 0, max: null },
});
const LIPSYNC = model({
  video: { need: 'required', param: 'video_url', list: false },
  audio: { need: 'required', param: 'audio_url', list: false },
});
const UPSCALER = model({ video: { need: 'required', param: 'video_url', list: false } });

const none = { image: 0, audio: 0, video: 0 };

describe('modelAcceptsAttachments', () => {
  it('shows every model on an empty form', () => {
    for (const m of [T2I, I2V, MULTI_IMG, LIPSYNC, UPSCALER]) {
      expect(modelAcceptsAttachments(m, none, false)).toBe(true);
    }
  });

  it('hides models that cannot take an attached image', () => {
    const counts = { ...none, image: 1 };
    expect(modelAcceptsAttachments(T2I, counts, false)).toBe(false);
    expect(modelAcceptsAttachments(I2V, counts, false)).toBe(true);
    expect(modelAcceptsAttachments(UPSCALER, counts, false)).toBe(false);
  });

  it('respects the image count cap (null max = unbounded)', () => {
    const two = { ...none, image: 2 };
    expect(modelAcceptsAttachments(I2V, two, false)).toBe(false);
    expect(modelAcceptsAttachments(MULTI_IMG, two, true)).toBe(true);
  });

  it('hides prompt-less models once a prompt is entered', () => {
    expect(modelAcceptsAttachments(UPSCALER, { ...none, video: 1 }, true)).toBe(false);
    expect(modelAcceptsAttachments(LIPSYNC, { ...none, video: 1, audio: 1 }, true)).toBe(false);
    expect(modelAcceptsAttachments(I2V, { ...none, image: 1 }, true)).toBe(true);
  });

  it('requires every attached kind to be accepted', () => {
    expect(modelAcceptsAttachments(LIPSYNC, { image: 0, audio: 1, video: 1 }, false)).toBe(true);
    expect(modelAcceptsAttachments(LIPSYNC, { image: 1, audio: 1, video: 1 }, false)).toBe(false);
  });
});

describe('modelReadiness', () => {
  it('reports missing required slots', () => {
    expect(modelReadiness(T2I, none, false)).toEqual({ ready: false, missing: ['prompt'] });
    expect(modelReadiness(I2V, none, false)).toEqual({ ready: false, missing: ['image'] });
    expect(modelReadiness(LIPSYNC, none, false)).toEqual({ ready: false, missing: ['audio', 'video'] });
  });

  it('is ready when all required slots are satisfied', () => {
    expect(modelReadiness(T2I, none, true)).toEqual({ ready: true, missing: [] });
    expect(modelReadiness(I2V, { ...none, image: 1 }, false)).toEqual({ ready: true, missing: [] });
    expect(modelReadiness(LIPSYNC, { image: 0, audio: 1, video: 1 }, false)).toEqual({ ready: true, missing: [] });
  });
});
