import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPlaygroundCatalog,
  getPlaygroundModel,
  buildPlaygroundInput,
  validateControlOptions,
  extractOutputMedia,
  classifyMediaKind,
} from '../src/fal/playgroundModels.js';

function row(overrides = {}) {
  return {
    endpoint_id: 'fal-ai/test/model',
    display_name: 'Test Model',
    output: { kind: 'image', path: 'images[0].url' },
    inputs: {
      prompt: 'required',
      prompt_param: 'prompt',
      image: { need: 'unused', params: [], required_count: 0, max: 0 },
      audio: { need: 'unused', param: null, list: false },
      video: { need: 'unused', param: null, list: false },
    },
    defaults: {},
    ...overrides,
  };
}

describe('loadPlaygroundCatalog', () => {
  it('returns catalog_error and empty models when the file is missing', async () => {
    const cat = await loadPlaygroundCatalog({ catalogPath: '/nonexistent/playground.json' });
    expect(cat.models).toEqual([]);
    expect(cat.catalog_error).toMatch(/refresh:playground-models/);
  });

  it('parses a manifest file and finds models by id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pg-cat-'));
    const file = path.join(dir, 'catalog.json');
    await writeFile(file, JSON.stringify({
      generated_at: '2026-08-01T00:00:00.000Z',
      model_count: 1,
      models: [row()],
    }));
    const cat = await loadPlaygroundCatalog({ catalogPath: file });
    expect(cat.catalog_error).toBeUndefined();
    expect(cat.generated_at).toBe('2026-08-01T00:00:00.000Z');
    expect(cat.models).toHaveLength(1);

    const found = await getPlaygroundModel('fal-ai/test/model', { catalogPath: file });
    expect(found?.display_name).toBe('Test Model');
    expect(await getPlaygroundModel('fal-ai/other', { catalogPath: file })).toBe(null);
  });
});

describe('buildPlaygroundInput', () => {
  it('maps prompt to the declared prompt param', () => {
    const input = buildPlaygroundInput(
      row({ inputs: { ...row().inputs, prompt_param: 'text' } }),
      { prompt: 'hello there' },
    );
    expect(input).toEqual({ text: 'hello there' });
  });

  it('fills singular image params in order (start then end)', () => {
    const r = row({
      inputs: {
        ...row().inputs,
        image: {
          need: 'required',
          params: [
            { name: 'image_url', list: false, required: true },
            { name: 'tail_image_url', list: false, required: false },
          ],
          required_count: 1,
          max: 2,
        },
      },
    });
    const input = buildPlaygroundInput(r, { prompt: 'p', imageUrls: ['https://a/1.png', 'https://a/2.png'] });
    expect(input).toEqual({ prompt: 'p', image_url: 'https://a/1.png', tail_image_url: 'https://a/2.png' });
  });

  it('gives a list image param all remaining urls as an array', () => {
    const r = row({
      inputs: {
        ...row().inputs,
        image: {
          need: 'required',
          params: [{ name: 'image_urls', list: true, required: true }],
          required_count: 1,
          max: null,
        },
      },
    });
    const input = buildPlaygroundInput(r, { prompt: 'p', imageUrls: ['https://a/1.png', 'https://a/2.png'] });
    expect(input).toEqual({ prompt: 'p', image_urls: ['https://a/1.png', 'https://a/2.png'] });
  });

  it('wraps audio/video urls in arrays for list params and spreads defaults', () => {
    const r = row({
      inputs: {
        ...row().inputs,
        prompt: 'unused',
        prompt_param: null,
        audio: { need: 'required', param: 'audio_urls', list: true },
        video: { need: 'required', param: 'video_url', list: false },
      },
      defaults: { voice: 'Aria' },
    });
    const input = buildPlaygroundInput(r, { audioUrl: 'https://a/a.mp3', videoUrl: 'https://a/v.mp4' });
    expect(input).toEqual({ audio_urls: ['https://a/a.mp3'], video_url: 'https://a/v.mp4', voice: 'Aria' });
  });

  it('omits the prompt param when no prompt is given and the slot is optional', () => {
    const r = row({ inputs: { ...row().inputs, prompt: 'optional' } });
    expect(buildPlaygroundInput(r, {})).toEqual({});
  });

  it('merges control options over defaults', () => {
    const r = row({ defaults: { resolution: '720p' } });
    const input = buildPlaygroundInput(r, {
      prompt: 'p',
      options: { resolution: '1080p', image_size: 'square_hd' },
    });
    expect(input).toEqual({ prompt: 'p', resolution: '1080p', image_size: 'square_hd' });
  });
});

describe('validateControlOptions', () => {
  const r = row({
    controls: [
      { name: 'image_size', type: 'enum', options: ['square_hd', 'portrait_16_9'], default: 'square_hd' },
      { name: 'duration', type: 'int', default: 5, min: 3, max: 12 },
    ],
  });

  it('accepts valid enum and int values (coercing int strings)', () => {
    expect(validateControlOptions(r, { image_size: 'portrait_16_9', duration: '8' }))
      .toEqual({ clean: { image_size: 'portrait_16_9', duration: 8 }, errors: [] });
  });

  it('matches numeric enum options sent as strings and restores their type', () => {
    // HTML <select> values are always strings; catalog enums may be numbers.
    const numeric = row({
      controls: [{ name: 'duration', type: 'enum', options: [3, 5, 10], default: 5 }],
    });
    expect(validateControlOptions(numeric, { duration: '5' }))
      .toEqual({ clean: { duration: 5 }, errors: [] });
    expect(validateControlOptions(numeric, { duration: '7' }).errors).toHaveLength(1);
  });

  it('rejects unknown option names, bad enum values, and out-of-range ints', () => {
    const { clean, errors } = validateControlOptions(r, {
      seed: 42, image_size: 'huge', duration: 99,
    });
    expect(clean).toEqual({});
    expect(errors).toHaveLength(3);
  });

  it('returns empty for a model with no controls', () => {
    expect(validateControlOptions(row(), { anything: 'x' }))
      .toEqual({ clean: {}, errors: ['anything is not a supported option'] });
    expect(validateControlOptions(row(), {})).toEqual({ clean: {}, errors: [] });
  });
});

describe('extractOutputMedia', () => {
  it('follows an images[0].url path and expands the whole array', () => {
    const outputs = extractOutputMedia(row(), {
      images: [{ url: 'https://f/1.png' }, { url: 'https://f/2.png' }],
    });
    expect(outputs).toEqual([
      { url: 'https://f/1.png', kind: 'image' },
      { url: 'https://f/2.png', kind: 'image' },
    ]);
  });

  it('follows a video.url path', () => {
    const r = row({ output: { kind: 'video', path: 'video.url' } });
    expect(extractOutputMedia(r, { video: { url: 'https://f/v.mp4' } }))
      .toEqual([{ url: 'https://f/v.mp4', kind: 'video' }]);
  });

  it('follows a bare string path', () => {
    const r = row({ output: { kind: 'video', path: 'video_url' } });
    expect(extractOutputMedia(r, { video_url: 'https://f/v.mp4' }))
      .toEqual([{ url: 'https://f/v.mp4', kind: 'video' }]);
  });

  it('falls back to a recursive url walk when the path misses', () => {
    const r = row({ output: { kind: 'audio', path: 'audio.url' } });
    expect(extractOutputMedia(r, { result: { file: { url: 'https://f/a.mp3', content_type: 'audio/mpeg' } } }))
      .toEqual([{ url: 'https://f/a.mp3', kind: 'audio' }]);
  });

  it('returns [] when nothing is found', () => {
    expect(extractOutputMedia(row(), { seed: 3 })).toEqual([]);
  });
});

describe('classifyMediaKind', () => {
  it('maps mime prefixes to kinds', () => {
    expect(classifyMediaKind('image/png')).toBe('image');
    expect(classifyMediaKind('video/mp4')).toBe('video');
    expect(classifyMediaKind('audio/mpeg; charset=binary')).toBe('audio');
    expect(classifyMediaKind('application/json')).toBe(null);
    expect(classifyMediaKind(null)).toBe(null);
  });
});
