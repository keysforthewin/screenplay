import { describe, it, expect } from 'vitest';
import { computeAnthropicImageTokens } from '../src/agent/imageTokens.js';

// Hand-built minimal PNG: signature + IHDR with width=300, height=300.
// image-size only needs the IHDR chunk to read dimensions — no pixel data required.
function makePngBuffer(width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // length of IHDR data (always 13)
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); // bit depth
  ihdr.writeUInt8(2, 17); // color type
  ihdr.writeUInt8(0, 18); // compression
  ihdr.writeUInt8(0, 19); // filter
  ihdr.writeUInt8(0, 20); // interlace
  ihdr.writeUInt32BE(0, 21); // CRC (not validated by image-size)
  return Buffer.concat([sig, ihdr]);
}

describe('computeAnthropicImageTokens', () => {
  it('returns zero totals for empty input', () => {
    expect(computeAnthropicImageTokens([])).toEqual({ perImageTokens: [], total: 0 });
    expect(computeAnthropicImageTokens(undefined)).toEqual({ perImageTokens: [], total: 0 });
  });

  it('computes ceil((w*h)/750) per image', () => {
    // 300x300 = 90000 / 750 = 120 tokens
    const buf = makePngBuffer(300, 300);
    const out = computeAnthropicImageTokens([buf]);
    expect(out.perImageTokens).toEqual([120]);
    expect(out.total).toBe(120);
  });

  it('caps at 1600 tokens per image', () => {
    // 2000x2000 = 4_000_000 / 750 = 5333.3 → would be capped to 1600
    const buf = makePngBuffer(2000, 2000);
    const out = computeAnthropicImageTokens([buf]);
    expect(out.perImageTokens).toEqual([1600]);
    expect(out.total).toBe(1600);
  });

  it('sums across multiple images', () => {
    const small = makePngBuffer(150, 150); // 22500 / 750 = 30
    const med = makePngBuffer(600, 400); // 240000 / 750 = 320
    const out = computeAnthropicImageTokens([small, med]);
    expect(out.perImageTokens).toEqual([30, 320]);
    expect(out.total).toBe(350);
  });

  it('falls back to the cap (1600) when dimensions cannot be parsed', () => {
    const garbage = Buffer.from('not an image', 'utf8');
    const out = computeAnthropicImageTokens([garbage]);
    expect(out.perImageTokens).toEqual([1600]);
    expect(out.total).toBe(1600);
  });

  it('rounds up fractional results', () => {
    // 1x1000 = 1000 / 750 = 1.33 → ceil = 2
    const buf = makePngBuffer(1, 1000);
    const out = computeAnthropicImageTokens([buf]);
    expect(out.perImageTokens).toEqual([2]);
  });
});
