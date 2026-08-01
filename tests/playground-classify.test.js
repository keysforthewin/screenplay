import { describe, it, expect } from 'vitest';
import { classifyInputs, detectOutput, extractControls } from '../scripts/lib/playgroundClassify.js';

// Param maps below mirror what extractIO() in scripts/lib/falDiscovery.js
// produces: { name: { type, default?, title?, ... } }.

describe('classifyInputs', () => {
  it('classifies a text-to-image model (prompt only)', () => {
    const c = classifyInputs(
      { prompt: { type: 'string' } },
      { image_size: { type: 'enum', enum: ['square'] }, num_images: { type: 'integer', default: 1 } },
    );
    expect(c.prompt).toBe('required');
    expect(c.prompt_param).toBe('prompt');
    expect(c.image.need).toBe('unused');
    expect(c.audio.need).toBe('unused');
    expect(c.video.need).toBe('unused');
    expect(c.unsatisfied_required).toEqual([]);
    expect(c.defaults).toEqual({});
  });

  it('classifies start+end frame image params with counts', () => {
    const c = classifyInputs(
      { prompt: { type: 'string' }, image_url: { type: 'string' } },
      { tail_image_url: { type: 'string' } },
    );
    expect(c.image.need).toBe('required');
    expect(c.image.params).toEqual([
      { name: 'image_url', list: false, required: true },
      { name: 'tail_image_url', list: false, required: false },
    ]);
    expect(c.image.required_count).toBe(1);
    expect(c.image.max).toBe(2);
  });

  it('treats a list image param as unbounded', () => {
    const c = classifyInputs(
      { prompt: { type: 'string' }, image_urls: { type: 'string[]' } },
      {},
    );
    expect(c.image.need).toBe('required');
    expect(c.image.params).toEqual([{ name: 'image_urls', list: true, required: true }]);
    expect(c.image.required_count).toBe(1);
    expect(c.image.max).toBe(null);
  });

  it('maps prompt synonyms (text_input, instruction, script) to the prompt slot', () => {
    expect(classifyInputs({ text_input: { type: 'string' } }, {}).prompt_param).toBe('text_input');
    expect(classifyInputs({ instruction: { type: 'string' } }, {}).prompt_param).toBe('instruction');
    expect(classifyInputs({ script: { type: 'string' } }, {}).prompt_param).toBe('script');
  });

  it('maps TTS text param to prompt and keeps required enum defaults', () => {
    const c = classifyInputs(
      { text: { type: 'string' }, voice: { type: 'enum', enum: ['Aria', 'Bill'], default: 'Aria' } },
      {},
    );
    expect(c.prompt).toBe('required');
    expect(c.prompt_param).toBe('text');
    expect(c.defaults).toEqual({ voice: 'Aria' });
    expect(c.unsatisfied_required).toEqual([]);
  });

  it('classifies a prompt-less video upscaler', () => {
    const c = classifyInputs(
      { video_url: { type: 'string' } },
      { upscale_factor: { type: 'number', default: 2 } },
    );
    expect(c.prompt).toBe('unused');
    expect(c.video).toEqual({ need: 'required', param: 'video_url', list: false });
    expect(c.unsatisfied_required).toEqual([]);
  });

  it('classifies audio params', () => {
    const c = classifyInputs(
      { image_url: { type: 'string' }, audio_url: { type: 'string' } },
      { prompt: { type: 'string' } },
    );
    expect(c.audio).toEqual({ need: 'required', param: 'audio_url', list: false });
    expect(c.prompt).toBe('optional');
  });

  it('leaves required mask params unsatisfied', () => {
    const c = classifyInputs(
      { image_url: { type: 'string' }, mask_url: { type: 'string' } },
      {},
    );
    expect(c.unsatisfied_required).toEqual(['mask_url']);
  });

  it('marks a second required audio param unsatisfied (only one audio slot)', () => {
    const c = classifyInputs(
      { first_audio_url: { type: 'string' }, second_audio_url: { type: 'string' } },
      {},
    );
    expect(c.audio.param).toBe('first_audio_url');
    expect(c.unsatisfied_required).toEqual(['second_audio_url']);
  });
});

describe('extractControls', () => {
  it('captures size/duration enums with defaults, in whitelist order', () => {
    const controls = extractControls(
      { prompt: { type: 'string' } },
      {
        image_size: { type: 'enum', enum: ['square_hd', 'portrait_16_9'], default: 'square_hd' },
        num_images: { type: 'integer', default: 1 },
        seed: { type: 'integer' },
        aspect_ratio: { type: 'enum', enum: ['16:9', '1:1'], default: '16:9' },
      },
    );
    expect(controls).toEqual([
      { name: 'image_size', type: 'enum', options: ['square_hd', 'portrait_16_9'], default: 'square_hd' },
      { name: 'aspect_ratio', type: 'enum', options: ['16:9', '1:1'], default: '16:9' },
    ]);
  });

  it('captures integer duration params with bounds', () => {
    const controls = extractControls(
      {},
      { duration: { type: 'integer', default: 5, minimum: 3, maximum: 12 } },
    );
    expect(controls).toEqual([
      { name: 'duration', type: 'int', default: 5, min: 3, max: 12 },
    ]);
  });

  it('captures resolution enums even when required (already in defaults)', () => {
    const controls = extractControls(
      { resolution: { type: 'enum', enum: ['720p', '1080p'], default: '720p' } },
      {},
    );
    expect(controls).toEqual([
      { name: 'resolution', type: 'enum', options: ['720p', '1080p'], default: '720p' },
    ]);
  });

  it('captures enum options surfaced from anyOf variants (fal image_size)', () => {
    // summarizeProp exposes `.enum` for anyOf schemas whose variant is an
    // enum, even though `.type` stays the variant join ('ImageSize|Enum').
    const controls = extractControls(
      {},
      { image_size: { type: 'ImageSize|Enum', enum: ['square_hd', 'landscape_4_3'], default: 'landscape_4_3' } },
    );
    expect(controls).toEqual([
      { name: 'image_size', type: 'enum', options: ['square_hd', 'landscape_4_3'], default: 'landscape_4_3' },
    ]);
  });

  it('ignores non-whitelisted and non-enum params', () => {
    expect(extractControls({}, {
      style: { type: 'enum', enum: ['anime'] },
      width: { type: 'integer', default: 1024 },
    })).toEqual([]);
  });
});

describe('detectOutput', () => {
  it('detects an image array output', () => {
    const o = detectOutput({
      images: { type: 'Image[]' },
      seed: { type: 'integer' },
    });
    expect(o).toEqual({ kind: 'image', path: 'images[0].url' });
  });

  it('detects a single video File output by prop name', () => {
    const o = detectOutput({ video: { type: 'File', title: 'File' } });
    expect(o).toEqual({ kind: 'video', path: 'video.url' });
  });

  it('detects audio kind from the schema title', () => {
    const o = detectOutput({ audio: { type: 'File', title: 'AudioFile' } });
    expect(o).toEqual({ kind: 'audio', path: 'audio.url' });
  });

  it('detects a plain uri string output', () => {
    const o = detectOutput({ video_url: { type: 'string' } });
    expect(o).toEqual({ kind: 'video', path: 'video_url' });
  });

  it('returns null when no media output exists', () => {
    expect(detectOutput({ text: { type: 'string' }, seed: { type: 'integer' } })).toBe(null);
  });
});
