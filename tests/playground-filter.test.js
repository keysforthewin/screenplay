import { describe, it, expect } from 'vitest';
import { modelMatchesFilters, modelMatchesSearch, modelReadiness, defaultFilters } from '../web/src/playgroundFilter.js';

function model(inputs, outputKind = 'image') {
  return {
    endpoint_id: 'test/x',
    output: { kind: outputKind, path: 'x.url' },
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
const T2V = model({ prompt: 'required', prompt_param: 'prompt' }, 'video');
const I2V = model({
  prompt: 'optional', prompt_param: 'prompt',
  image: { need: 'required', params: [{ name: 'image_url', list: false, required: true }], required_count: 1, max: 1 },
}, 'video');
const MULTI_IMG = model({
  prompt: 'required', prompt_param: 'prompt',
  image: { need: 'optional', params: [{ name: 'image_urls', list: true, required: false }], required_count: 0, max: null },
});
const LIPSYNC = model({
  video: { need: 'required', param: 'video_url', list: false },
  audio: { need: 'required', param: 'audio_url', list: false },
}, 'video');
const UPSCALER = model({ video: { need: 'required', param: 'video_url', list: false } }, 'video');
const TTS = model({ prompt: 'required', prompt_param: 'text' }, 'audio');

function filters(overrides = {}) {
  return { ...defaultFilters(), ...overrides };
}

describe('defaultFilters', () => {
  it('starts with no inputs checked and every output kind on', () => {
    expect(defaultFilters()).toEqual({
      prompt: false, image: false, audio: false, video: false,
      imageCount: 0,
      category: null,
      outputs: { image: true, video: true, audio: true },
    });
  });
});

describe('modelMatchesFilters — inputs', () => {
  it('with nothing checked, hides every model that requires an input', () => {
    const f = filters();
    expect(modelMatchesFilters(T2I, f)).toBe(false);
    expect(modelMatchesFilters(I2V, f)).toBe(false);
    expect(modelMatchesFilters(LIPSYNC, f)).toBe(false);
  });

  it('prompt checked shows prompt models and hides prompt-less ones', () => {
    const f = filters({ prompt: true });
    expect(modelMatchesFilters(T2I, f)).toBe(true);
    expect(modelMatchesFilters(MULTI_IMG, f)).toBe(true); // image optional, not required
    expect(modelMatchesFilters(UPSCALER, f)).toBe(false); // no prompt slot
    expect(modelMatchesFilters(I2V, f)).toBe(false); // still requires an image
  });

  it('image checked requires the model to accept images', () => {
    const f = filters({ image: true, imageCount: 1 });
    expect(modelMatchesFilters(I2V, f)).toBe(true); // prompt optional
    expect(modelMatchesFilters(T2I, f)).toBe(false); // cannot take an image
  });

  it('respects the attached image count against the model cap', () => {
    expect(modelMatchesFilters(I2V, filters({ image: true, imageCount: 2 }))).toBe(false);
    expect(modelMatchesFilters(MULTI_IMG, filters({ prompt: true, image: true, imageCount: 5 }))).toBe(true);
  });

  it('image checked with no images yet applies no count constraint', () => {
    expect(modelMatchesFilters(I2V, filters({ image: true, imageCount: 0 }))).toBe(true);
  });

  it('audio+video checked matches lip-sync models exactly', () => {
    const f = filters({ audio: true, video: true });
    expect(modelMatchesFilters(LIPSYNC, f)).toBe(true);
    expect(modelMatchesFilters(UPSCALER, f)).toBe(false); // does not use the audio
    expect(modelMatchesFilters(T2V, f)).toBe(false);
  });

  it('hides models whose required inputs exceed what is checked', () => {
    expect(modelMatchesFilters(LIPSYNC, filters({ video: true }))).toBe(false);
    expect(modelMatchesFilters(UPSCALER, filters({ video: true }))).toBe(true);
  });
});

describe('modelMatchesFilters — output kinds', () => {
  it('filters by output kind checkboxes', () => {
    const onlyVideo = filters({ prompt: true, outputs: { image: false, video: true, audio: false } });
    expect(modelMatchesFilters(T2V, onlyVideo)).toBe(true);
    expect(modelMatchesFilters(T2I, onlyVideo)).toBe(false);
    expect(modelMatchesFilters(TTS, onlyVideo)).toBe(false);

    const onlyAudio = filters({ prompt: true, outputs: { image: false, video: false, audio: true } });
    expect(modelMatchesFilters(TTS, onlyAudio)).toBe(true);
    expect(modelMatchesFilters(T2I, onlyAudio)).toBe(false);
  });
});

describe('modelMatchesFilters — category', () => {
  const catModel = { ...T2I, category: 'text-to-image' };

  it('matches every category when filters.category is null', () => {
    expect(modelMatchesFilters(catModel, filters({ prompt: true }))).toBe(true);
  });

  it('matches only the selected category', () => {
    expect(modelMatchesFilters(catModel, filters({ prompt: true, category: 'text-to-image' }))).toBe(true);
    expect(modelMatchesFilters(catModel, filters({ prompt: true, category: 'text-to-video' }))).toBe(false);
  });

  it('hides category-less models when a category is selected', () => {
    expect(modelMatchesFilters(T2I, filters({ prompt: true, category: 'text-to-image' }))).toBe(false);
  });
});

describe('modelMatchesSearch', () => {
  const m = {
    endpoint_id: 'fal-ai/happy-horse',
    display_name: 'Happy Horse',
    category: 'image-to-video',
    description: 'Generate 1080p video with synchronized native audio and multilingual lip-sync.',
  };

  it('matches everything on an empty or whitespace query', () => {
    expect(modelMatchesSearch(m, '')).toBe(true);
    expect(modelMatchesSearch(m, '   ')).toBe(true);
  });

  it('matches endpoint id, display name, and category case-insensitively', () => {
    expect(modelMatchesSearch(m, 'happy-horse')).toBe(true);
    expect(modelMatchesSearch(m, 'HAPPY HORSE')).toBe(true);
    expect(modelMatchesSearch(m, 'image-to-video')).toBe(true);
  });

  it('matches against the description', () => {
    expect(modelMatchesSearch(m, 'lip-sync')).toBe(true);
    expect(modelMatchesSearch(m, 'Multilingual')).toBe(true);
    expect(modelMatchesSearch(m, 'watercolor')).toBe(false);
  });

  it('tolerates models with missing fields', () => {
    expect(modelMatchesSearch({ endpoint_id: 'x/y' }, 'y')).toBe(true);
    expect(modelMatchesSearch({ endpoint_id: 'x/y' }, 'z')).toBe(false);
  });
});

describe('modelReadiness', () => {
  const none = { image: 0, audio: 0, video: 0 };

  it('reports missing required slots against actual attachments', () => {
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
