import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { generateThumbnailBuffer } from '../src/mongo/imageThumbnails.js';

async function makeTestPng(width, height) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 80, b: 40 },
    },
  })
    .png()
    .toBuffer();
}

describe('generateThumbnailBuffer', () => {
  it('downscales a large image to <=600px on the long edge as JPEG', async () => {
    const src = await makeTestPng(1600, 900);
    const out = await generateThumbnailBuffer(src);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width, meta.height)).toBe(600);
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(338);
    expect(out.length).toBeLessThan(src.length);
  });

  it('preserves aspect ratio for portrait input', async () => {
    const src = await makeTestPng(800, 1200);
    const out = await generateThumbnailBuffer(src);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width, meta.height)).toBe(600);
    expect(meta.height).toBe(600);
    expect(meta.width).toBe(400);
  });

  it('does not enlarge images smaller than the cap', async () => {
    const src = await makeTestPng(320, 240);
    const out = await generateThumbnailBuffer(src);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
  });
});
