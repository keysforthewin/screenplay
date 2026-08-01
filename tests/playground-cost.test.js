import { describe, it, expect } from 'vitest';
import { estimatePlaygroundCost, rowPriceLabel } from '../web/src/playgroundCost.js';

function model(pricing, outputKind = 'image', controls = []) {
  return { endpoint_id: 'test/x', output: { kind: outputKind }, pricing, controls, price_min_usd: 0.3 };
}

describe('estimatePlaygroundCost', () => {
  it('prices per-image models exactly', () => {
    const e = estimatePlaygroundCost(model({ kind: 'per_image', perImageUsd: 0.08 }), {});
    expect(e).toMatchObject({ totalUsd: 0.08, exact: true });
  });

  it('prices per-second video from the selected duration', () => {
    const e = estimatePlaygroundCost(
      model({ kind: 'per_second', perSecondUsd: 0.1 }, 'video'),
      { selections: { duration: '8' } },
    );
    expect(e).toMatchObject({ totalUsd: 0.8, exact: true });
  });

  it('parses duration enums with an s suffix', () => {
    const e = estimatePlaygroundCost(
      model({ kind: 'per_second', perSecondUsd: 0.2 }, 'video'),
      { selections: { duration: '5s' } },
    );
    expect(e).toMatchObject({ totalUsd: 1, exact: true });
  });

  it('picks the tier matching the selected resolution', () => {
    const pricing = {
      kind: 'per_second_tiered',
      rates: [
        { when: { resolution: '720p' }, perSecondUsd: 0.2 },
        { when: { resolution: '1080p' }, perSecondUsd: 0.4 },
      ],
    };
    const e = estimatePlaygroundCost(model(pricing, 'video'), {
      selections: { resolution: '1080p', duration: '5' },
    });
    expect(e).toMatchObject({ totalUsd: 2, exact: true });
  });

  it('returns a rate-only estimate when duration is unknown', () => {
    const e = estimatePlaygroundCost(model({ kind: 'per_second', perSecondUsd: 0.1 }, 'video'), {});
    expect(e.totalUsd).toBe(null);
    expect(e.label).toMatch(/\$0\.10\/s/);
  });

  it('prices per-megapixel images from the selected size', () => {
    const e = estimatePlaygroundCost(
      model({ kind: 'per_megapixel', perMpUsd: 0.02 }, 'image'),
      { selections: { image_size: 'square_hd' } }, // 1024×1024 ≈ 1.05 MP
    );
    expect(e.totalUsd).toBeCloseTo(0.02097, 4);
  });

  it('prices TTS from the prompt length', () => {
    const e = estimatePlaygroundCost(
      model({ kind: 'per_1k_chars', per1kCharsUsd: 0.05 }, 'audio'),
      { promptLength: 500 },
    );
    expect(e).toMatchObject({ totalUsd: 0.025, exact: true });
  });

  it('returns null with no pricing data', () => {
    expect(estimatePlaygroundCost(model(null), {})).toBe(null);
  });
});

describe('rowPriceLabel', () => {
  it('renders compact per-unit labels', () => {
    expect(rowPriceLabel(model({ kind: 'per_image', perImageUsd: 0.08 }))).toBe('$0.08/image');
    expect(rowPriceLabel(model({ kind: 'per_second', perSecondUsd: 0.1 }, 'video'))).toBe('$0.10/s');
    expect(rowPriceLabel(model({ kind: 'per_1k_chars', per1kCharsUsd: 0.05 }, 'audio'))).toBe('$0.05/1k chars');
    expect(rowPriceLabel(model({ kind: 'per_minute', perMinuteUsd: 0.6 }, 'audio'))).toBe('$0.60/min');
    expect(rowPriceLabel(model({ kind: 'per_megapixel', perMpUsd: 0.011 }))).toBe('$0.011/MP');
    expect(rowPriceLabel(model({ kind: 'flat_per_clip', flatUsd: 0.3 }, 'video'))).toBe('~$0.30');
  });

  it('renders a tiered range', () => {
    const pricing = {
      kind: 'per_second_tiered',
      rates: [
        { when: { resolution: '720p' }, perSecondUsd: 0.2 },
        { when: { resolution: '1080p' }, perSecondUsd: 0.4 },
      ],
    };
    expect(rowPriceLabel(model(pricing, 'video'))).toBe('$0.20–$0.40/s');
  });

  it('falls back to price_min_usd, then to varies', () => {
    expect(rowPriceLabel(model(null))).toBe('from $0.30');
    expect(rowPriceLabel({ ...model(null), price_min_usd: null })).toBe('pricing varies');
  });

  it('shows the smallest-duration total for per-second models with a duration control', () => {
    const m = model({ kind: 'per_second', perSecondUsd: 0.14 }, 'video', [
      { name: 'resolution', type: 'enum', options: ['720p', '1080p'], default: '1080p' },
      { name: 'duration', type: 'enum', options: [3, 4, 5, 10], default: 5 },
    ]);
    expect(rowPriceLabel(m)).toBe('from $0.42');
  });

  it('uses int-control minimums for duration', () => {
    const m = model({ kind: 'per_second', perSecondUsd: 0.2 }, 'video', [
      { name: 'duration', type: 'int', default: 5, min: 2, max: 12 },
    ]);
    expect(rowPriceLabel(m)).toBe('from $0.40');
  });

  it('shows the smallest-size total for per-megapixel image models', () => {
    const m = model({ kind: 'per_megapixel', perMpUsd: 0.02 }, 'image', [
      { name: 'image_size', type: 'enum', options: ['square_hd', 'square', 'landscape_4_3'], default: 'landscape_4_3' },
    ]);
    // smallest = square 512×512 ≈ 0.262 MP → $0.00524
    expect(rowPriceLabel(m)).toBe('from $0.005');
  });

  it('labels per_unit machine pricing as a rate', () => {
    const m = model({ kind: 'per_unit', unitPriceUsd: 0.0002, unit: 'compute-s' }, 'video');
    expect(rowPriceLabel(m)).toBe('$0.0002/compute-s');
    const e = estimatePlaygroundCost(m, {});
    expect(e.totalUsd).toBe(null);
    expect(e.label).toBe('$0.0002/compute-s');
  });
});
