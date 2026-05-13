// Unit tests for the video pricing module (src/fal/videoPricing.js).
// Table-driven across the six registered models and their billable
// dimensions (duration, audio-on/off, resolution).

import { describe, it, expect } from 'vitest';
import {
  PRICING,
  describePricing,
  estimateRegisteredCost,
  estimateCatalogCost,
  parseCatalogPriceText,
  formatUsd,
} from '../src/fal/videoPricing.js';

describe('describePricing', () => {
  it('returns null for unknown ids', () => {
    expect(describePricing('nope')).toBeNull();
  });
  it('preserves shape and marks unknown models as not exact', () => {
    const flat = describePricing('flashhead');
    expect(flat).toBeTruthy();
    expect(flat.kind).toBe('unknown');
    expect(flat.exact).toBe(false);
  });
  it('marks per-audio-second pricing requires_audio_duration', () => {
    const p = describePricing('kling-avatar-v2-pro');
    expect(p.requires_audio_duration).toBe(true);
  });
});

describe('estimateRegisteredCost — Kling 3 Pro', () => {
  it('charges $0.112/s with audio off', () => {
    const est = estimateRegisteredCost('kling-3-pro', { durationSeconds: 5, generateAudio: false });
    expect(est.totalUsd).toBeCloseTo(0.56, 6);
    expect(est.perSecondUsd).toBe(0.112);
    expect(est.exact).toBe(true);
  });
  it('charges $0.168/s with audio on', () => {
    const est = estimateRegisteredCost('kling-3-pro', { durationSeconds: 5, generateAudio: true });
    expect(est.totalUsd).toBeCloseTo(0.84, 6);
    expect(est.perSecondUsd).toBe(0.168);
  });
  it('returns null without a duration', () => {
    expect(estimateRegisteredCost('kling-3-pro', { generateAudio: false })).toBeNull();
  });
});

describe('estimateRegisteredCost — Veo 3.1 FLF', () => {
  it('defaults auto resolution to 1080p, $0.20/s no audio', () => {
    const est = estimateRegisteredCost('veo-3-1-flf', { durationSeconds: 8, generateAudio: false });
    expect(est.totalUsd).toBeCloseTo(1.6, 6);
    expect(est.basis).toMatch(/1080p/);
  });
  it('1080p with audio is $0.40/s', () => {
    const est = estimateRegisteredCost('veo-3-1-flf', {
      durationSeconds: 5, generateAudio: true, resolution: '1080p',
    });
    expect(est.totalUsd).toBeCloseTo(2.0, 6);
  });
  it('720p with audio is $0.40/s (same tier as 1080p)', () => {
    const est = estimateRegisteredCost('veo-3-1-flf', {
      durationSeconds: 5, generateAudio: true, resolution: '720p',
    });
    expect(est.totalUsd).toBeCloseTo(2.0, 6);
  });
  it('4k jumps to $0.40/s no audio and $0.60/s with audio', () => {
    expect(
      estimateRegisteredCost('veo-3-1-flf', { durationSeconds: 8, generateAudio: false, resolution: '4k' }).totalUsd,
    ).toBeCloseTo(3.2, 6);
    expect(
      estimateRegisteredCost('veo-3-1-flf', { durationSeconds: 8, generateAudio: true, resolution: '4k' }).totalUsd,
    ).toBeCloseTo(4.8, 6);
  });
});

describe('estimateRegisteredCost — Kling Avatar v2 Pro (lip-sync)', () => {
  it('returns null without audio duration', () => {
    expect(estimateRegisteredCost('kling-avatar-v2-pro', {})).toBeNull();
  });
  it('returns duration without a total when rate is not published', () => {
    const est = estimateRegisteredCost('kling-avatar-v2-pro', { audioDurationSeconds: 4.2 });
    expect(est).toBeTruthy();
    expect(est.totalUsd).toBeNull();
    expect(est.durationSeconds).toBe(4.2);
    expect(est.exact).toBe(false);
  });
});

describe('estimateRegisteredCost — Flashhead', () => {
  it('returns null because pricing is unknown', () => {
    expect(estimateRegisteredCost('flashhead', { durationSeconds: 5 })).toBeNull();
  });
});

describe('estimateRegisteredCost — Sora 2', () => {
  it('charges $0.10/s flat', () => {
    const est = estimateRegisteredCost('sora-2', { durationSeconds: 8 });
    expect(est.totalUsd).toBeCloseTo(0.8, 6);
    expect(est.perSecondUsd).toBe(0.10);
  });
});

describe('estimateRegisteredCost — Sora 2 Pro', () => {
  it('defaults auto resolution to 720p at $0.30/s', () => {
    const est = estimateRegisteredCost('sora-2-pro', {
      durationSeconds: 4,
      resolution: 'auto',
    });
    expect(est.totalUsd).toBeCloseTo(1.2, 6);
    expect(est.basis).toMatch(/720p/);
  });
  it('uses $0.50/s at legacy 1080p', () => {
    const est = estimateRegisteredCost('sora-2-pro', {
      durationSeconds: 4,
      resolution: '1080p',
    });
    expect(est.totalUsd).toBeCloseTo(2.0, 6);
  });
  it('uses $0.70/s at true 1080p', () => {
    const est = estimateRegisteredCost('sora-2-pro', {
      durationSeconds: 4,
      resolution: 'true_1080p',
    });
    expect(est.totalUsd).toBeCloseTo(2.8, 6);
  });
});

describe('estimateCatalogCost — per-megapixel computes a total when resolution+fps+duration are known', () => {
  it('matches fal\'s own LTX example (1280×720, 121 frames ≈ 112 MP, $0.0896)', () => {
    const row = {
      price_text:
        'Your request will cost $0.0008 per megapixel of generated video data ' +
        '(width × height × frames), rounded up.',
    };
    // 1280×720 @ 24fps × 5s = 120 frames → 1280*720*120 = 110,592,000 px → 110.59 MP × $0.0008 = $0.0885
    const est = estimateCatalogCost(row, { durationSeconds: 5, fps: 24, resolution: '720p' });
    expect(est.totalUsd).toBeCloseTo(0.0885, 3);
    expect(est.exact).toBe(false);
    expect(est.basis).toMatch(/MP/);
  });
  it('returns null totalUsd when resolution/fps missing (rate-only)', () => {
    const row = { price_text: '$0.001 per megapixel of generated video data' };
    const est = estimateCatalogCost(row, { durationSeconds: 5 });
    expect(est.totalUsd).toBeNull();
    expect(est.perMpUsd).toBe(0.001);
  });
});

describe('estimateCatalogCost — tiered catalog parser uses the user\'s resolution', () => {
  it('parses three tiers and picks the user-selected one', () => {
    const row = {
      price_text:
        'For 360p: $0.025/s, for 720p: $0.045/s, for 1080p: $0.075/s.',
    };
    const e360 = estimateCatalogCost(row, { durationSeconds: 5, resolution: '360p' });
    const e720 = estimateCatalogCost(row, { durationSeconds: 5, resolution: '720p' });
    const e1080 = estimateCatalogCost(row, { durationSeconds: 5, resolution: '1080p' });
    expect(e360.totalUsd).toBeCloseTo(0.125, 6);
    expect(e720.totalUsd).toBeCloseTo(0.225, 6);
    expect(e1080.totalUsd).toBeCloseTo(0.375, 6);
  });
  it('falls back to the lowest tier when no resolution is given', () => {
    const row = {
      price_text: 'For 360p: $0.025/s, for 720p: $0.045/s, for 1080p: $0.075/s.',
    };
    const e = estimateCatalogCost(row, { durationSeconds: 5 });
    expect(e.totalUsd).toBeCloseTo(0.125, 6);
  });
});

describe('PRICING table coverage', () => {
  it('covers every registered model id used by the orchestrator', () => {
    const ids = ['kling-3-pro', 'veo-3-1-flf', 'kling-avatar-v2-pro', 'flashhead', 'sora-2', 'sora-2-pro'];
    for (const id of ids) expect(PRICING[id]).toBeTruthy();
  });
});

describe('parseCatalogPriceText', () => {
  it('parses a simple "$0.10/s" rate', () => {
    expect(parseCatalogPriceText('The pricing is $0.10/s for Sora 2.')).toMatchObject({
      kind: 'per_second',
      perSecondUsd: 0.1,
    });
  });
  it('parses per-megapixel rates', () => {
    const res = parseCatalogPriceText('Your request will cost $0.0008 per megapixel of generated video');
    expect(res).toMatchObject({ kind: 'per_megapixel', perMpUsd: 0.0008 });
  });
  it('parses "every second of video … $X" Kling-style', () => {
    const res = parseCatalogPriceText('For every second of video you generated, you will be charged **$0.112** (audio off) or **$0.168** (audio on)');
    expect(res.kind).toBe('per_second');
    expect(res.perSecondUsd).toBe(0.112);
  });
  it('parses "$Y for a Ns clip"', () => {
    const res = parseCatalogPriceText('Total cost is $0.50 for a 5s clip.');
    expect(res.kind).toBe('per_second');
    expect(res.perSecondUsd).toBeCloseTo(0.10, 6);
  });
  it('returns null on empty/unparseable text', () => {
    expect(parseCatalogPriceText('')).toBeNull();
    expect(parseCatalogPriceText(null)).toBeNull();
  });
});

describe('estimateCatalogCost', () => {
  it('totals per-second × duration', () => {
    const row = { price_text: '$0.05/s' };
    const est = estimateCatalogCost(row, { durationSeconds: 6 });
    expect(est.totalUsd).toBeCloseTo(0.3, 6);
    expect(est.exact).toBe(false);
  });
  it('returns null when the row has no price_text', () => {
    expect(estimateCatalogCost({}, { durationSeconds: 5 })).toBeNull();
  });
});

describe('formatUsd', () => {
  it('renders >=1 with two decimals', () => {
    expect(formatUsd(2)).toBe('$2.00');
  });
  it('renders sub-dollar with up to three decimals, trimming zeros', () => {
    expect(formatUsd(0.5)).toBe('$0.5');
    expect(formatUsd(0.112)).toBe('$0.112');
  });
  it('returns null for non-numbers', () => {
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd('x')).toBeNull();
  });
});
