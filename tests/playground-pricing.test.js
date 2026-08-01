import { describe, it, expect } from 'vitest';
import { parsePlaygroundPricing } from '../scripts/lib/playgroundPricing.js';

describe('parsePlaygroundPricing', () => {
  it('parses per-image pricing', () => {
    expect(parsePlaygroundPricing('Your request will cost **$0.08** per image.'))
      .toMatchObject({ kind: 'per_image', perImageUsd: 0.08 });
  });

  it('derives per-image from a bulk quote', () => {
    expect(parsePlaygroundPricing('For **$1.00**, you can generate 25 images.'))
      .toMatchObject({ kind: 'per_image', perImageUsd: 0.04 });
  });

  it('parses per-1000-characters TTS pricing', () => {
    expect(parsePlaygroundPricing('Your request will cost $0.05 per 1000 characters.'))
      .toMatchObject({ kind: 'per_1k_chars', per1kCharsUsd: 0.05 });
  });

  it('parses per-minute audio pricing', () => {
    expect(parsePlaygroundPricing('Generated audio costs $0.60 per minute.'))
      .toMatchObject({ kind: 'per_minute', perMinuteUsd: 0.6 });
  });

  it('delegates video per-second pricing to the shared parser', () => {
    expect(parsePlaygroundPricing('The pricing is $0.10/s of generated video.'))
      .toMatchObject({ kind: 'per_second', perSecondUsd: 0.1 });
  });

  it('delegates tiered per-second pricing', () => {
    const p = parsePlaygroundPricing('720p: $0.20/s. 1080p: $0.40/s.');
    expect(p.kind).toBe('per_second_tiered');
    expect(p.rates).toHaveLength(2);
  });

  it('parses per-megapixel pricing', () => {
    expect(parsePlaygroundPricing('Your request will cost $0.011 per megapixel.'))
      .toMatchObject({ kind: 'per_megapixel', perMpUsd: 0.011 });
  });

  it('parses currency-after-number per-second phrasing', () => {
    expect(parsePlaygroundPricing('Your request will cost **0.1$** per output video second.'))
      .toMatchObject({ kind: 'per_second', perSecondUsd: 0.1 });
  });

  it('parses flat per-video pricing', () => {
    expect(parsePlaygroundPricing('Your request will cost 0.07 $ per video.'))
      .toMatchObject({ kind: 'flat_per_clip', flatUsd: 0.07 });
  });

  it('parses per-audio-second pricing', () => {
    expect(parsePlaygroundPricing('Your request will cost **0.002** per generated **audio seconds**.'))
      .toMatchObject({ kind: 'per_audio_second', perAudioSecondUsd: 0.002 });
  });

  it('returns null for empty text', () => {
    expect(parsePlaygroundPricing(null)).toBe(null);
    expect(parsePlaygroundPricing('')).toBe(null);
  });
});
