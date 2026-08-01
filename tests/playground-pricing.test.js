import { describe, it, expect } from 'vitest';
import { parsePlaygroundPricing, pricingFromMachine, mergePricing } from '../scripts/lib/playgroundPricing.js';

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

describe('pricingFromMachine', () => {
  const row = (unit_price, unit) => ({ endpoint_id: 'x', unit_price, unit, currency: 'USD' });

  it('maps exact quantity units', () => {
    expect(pricingFromMachine(row(0.003, 'megapixels'))).toMatchObject({ kind: 'per_megapixel', perMpUsd: 0.003, exact: true });
    expect(pricingFromMachine(row(0.01, 'processed megapixels'))).toMatchObject({ kind: 'per_megapixel', perMpUsd: 0.01 });
    expect(pricingFromMachine(row(0.05, 'images'))).toMatchObject({ kind: 'per_image', perImageUsd: 0.05, exact: true });
    expect(pricingFromMachine(row(0.1, 'seconds'))).toMatchObject({ kind: 'per_second', perSecondUsd: 0.1, exact: true });
    expect(pricingFromMachine(row(1.5, '10 seconds'))).toMatchObject({ kind: 'per_second', perSecondUsd: 0.15 });
    expect(pricingFromMachine(row(0.6, 'minutes'))).toMatchObject({ kind: 'per_minute', perMinuteUsd: 0.6 });
    expect(pricingFromMachine(row(0.03, '1000 characters'))).toMatchObject({ kind: 'per_1k_chars', per1kCharsUsd: 0.03 });
    expect(pricingFromMachine(row(0.25, 'videos'))).toMatchObject({ kind: 'flat_per_clip', flatUsd: 0.25, exact: true });
    expect(pricingFromMachine(row(0.25, 'generations'))).toMatchObject({ kind: 'flat_per_clip', flatUsd: 0.25 });
  });

  it('maps opaque units to a rate-only per_unit kind', () => {
    expect(pricingFromMachine(row(0.0002, 'compute seconds')))
      .toMatchObject({ kind: 'per_unit', unitPriceUsd: 0.0002, unit: 'compute-s' });
    expect(pricingFromMachine(row(2, '1m tokens')))
      .toMatchObject({ kind: 'per_unit', unit: '1M tokens' });
    expect(pricingFromMachine(row(0.01, 'credits')))
      .toMatchObject({ kind: 'per_unit', unit: 'credit' });
  });

  it('returns null without a usable row', () => {
    expect(pricingFromMachine(null)).toBe(null);
    expect(pricingFromMachine({ unit_price: null, unit: 'images' })).toBe(null);
  });
});

describe('mergePricing', () => {
  it('prefers machine pricing over text-parsed, except text tiers win', () => {
    const machine = { kind: 'per_second', perSecondUsd: 0.1, exact: true };
    const text = { kind: 'flat_per_clip', flatUsd: 0.3 };
    const tiered = { kind: 'per_second_tiered', rates: [{ when: { resolution: '720p' }, perSecondUsd: 0.2 }] };
    expect(mergePricing(text, machine)).toBe(machine);
    expect(mergePricing(tiered, machine)).toBe(tiered);
    expect(mergePricing(text, null)).toBe(text);
    expect(mergePricing(null, machine)).toBe(machine);
    expect(mergePricing(null, null)).toBe(null);
  });
});
