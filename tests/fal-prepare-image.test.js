// Tests for prepareImageForFal — the guard that keeps oversized storyboard
// frames from being shipped to fal.ai as model inputs. fal rejects input
// files over 10 MB, and several model backends (e.g. bytedance/omnihuman)
// refuse oversized images with a generic file_download_error. Storyboard
// frames are frequently 4K PNGs (~14 MB), so we downscale + re-encode before
// upload. Images already within limits must pass through byte-for-byte.

import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { randomFillSync } from 'node:crypto';

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { prepareImageForFal } = await import('../src/fal/prepareImage.js');

const MB = 1024 * 1024;

describe('prepareImageForFal', () => {
  it('downscales a 4K image past the dimension cap and re-encodes to JPEG', async () => {
    // 3840x2160 — the real-world repro (a generated 4K start frame).
    const buffer = await sharp({
      create: { width: 3840, height: 2160, channels: 3, background: { r: 12, g: 34, b: 56 } },
    })
      .png()
      .toBuffer();

    const out = await prepareImageForFal({ buffer, contentType: 'image/png' });

    const meta = await sharp(out.buffer).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(2048);
    expect(out.contentType).toBe('image/jpeg');
    expect(out.buffer.length).toBeLessThan(10 * MB);
  });

  it('re-encodes an oversized-by-bytes image even when dimensions are in range', async () => {
    // 2000x2000 random noise: under the 2048 dim cap but a PNG of noise is
    // ~12 MB, over fal's 10 MB ceiling.
    const raw = Buffer.alloc(2000 * 2000 * 3);
    randomFillSync(raw);
    const buffer = await sharp(raw, { raw: { width: 2000, height: 2000, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(buffer.length).toBeGreaterThan(8 * MB);

    const out = await prepareImageForFal({ buffer, contentType: 'image/png' });

    expect(out.buffer.length).toBeLessThan(10 * MB);
    expect(out.contentType).toBe('image/jpeg');
  });

  it('preserves PNG + alpha when an image with transparency must be resized', async () => {
    const buffer = await sharp({
      create: { width: 3000, height: 3000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const out = await prepareImageForFal({ buffer, contentType: 'image/png' });

    const meta = await sharp(out.buffer).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(2048);
    expect(out.contentType).toBe('image/png');
    expect(meta.hasAlpha).toBe(true);
  });

  it('passes small in-limit images through byte-for-byte (no re-encode)', async () => {
    const buffer = await sharp({
      create: { width: 256, height: 256, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const out = await prepareImageForFal({ buffer, contentType: 'image/png' });

    expect(out.buffer).toBe(buffer); // same reference — untouched
    expect(out.contentType).toBe('image/png');
  });

  it('passes a non-decodable buffer through untouched', async () => {
    const buffer = Buffer.from('not really an image');
    const out = await prepareImageForFal({ buffer, contentType: 'image/png' });
    expect(out.buffer).toBe(buffer);
    expect(out.contentType).toBe('image/png');
  });
});
