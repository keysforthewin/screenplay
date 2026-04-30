import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(),
  // Other exports referenced by handlers.js — keep them defined but unused.
  streamImageToTmp: vi.fn(),
  uploadGeneratedImage: vi.fn(),
  uploadImageFromUrl: vi.fn(),
  findImageFile: vi.fn(),
  listLibraryImages: vi.fn(),
  listImagesForBeat: vi.fn(),
  listImagesForDirectorNote: vi.fn(),
  setImageOwner: vi.fn(),
  deleteImage: vi.fn(),
  deleteImages: vi.fn(),
  openImageDownloadStream: vi.fn(),
  imageFileToMeta: vi.fn(),
  ensureObjectId: vi.fn(),
}));

const { HANDLERS, dispatchTool } = await import('../src/agent/handlers.js');
const Images = await import('../src/mongo/images.js');

// Smallest valid PNG (1×1 transparent, 67 bytes).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

beforeEach(() => {
  fakeDb.reset();
  Images.readImageBuffer.mockReset();
});

describe('describe_image', () => {
  it('returns a content array with text guidance and an image block', async () => {
    Images.readImageBuffer.mockResolvedValue({
      buffer: TINY_PNG,
      file: { _id: new ObjectId(), contentType: 'image/png', length: TINY_PNG.length },
    });

    const result = await HANDLERS.describe_image({ image_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    const [textBlock, imageBlock] = result;
    expect(textBlock.type).toBe('text');
    // Baseline guidance must include the character-recreation hooks the user
    // explicitly asked for.
    expect(textBlock.text.toLowerCase()).toContain('hair color');
    expect(textBlock.text.toLowerCase()).toContain('hair length');
    expect(textBlock.text.toLowerCase()).toContain('hairstyle');

    expect(imageBlock.type).toBe('image');
    expect(imageBlock.source.type).toBe('base64');
    expect(imageBlock.source.media_type).toBe('image/png');
    // Round-trip: base64 must decode to the original bytes.
    expect(Buffer.from(imageBlock.source.data, 'base64').equals(TINY_PNG)).toBe(true);
  });

  it('appends operator prompt under a header when provided', async () => {
    Images.readImageBuffer.mockResolvedValue({
      buffer: TINY_PNG,
      file: { contentType: 'image/png', length: TINY_PNG.length },
    });

    const result = await HANDLERS.describe_image({
      image_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      prompt: 'compare to the prior portrait',
    });

    const text = result[0].text;
    expect(text).toContain('Operator prompt: compare to the prior portrait');
    // The baseline guidance is still there.
    expect(text.toLowerCase()).toContain('hair color');
  });

  it('returns a friendly text error (not an array) when the image is missing', async () => {
    Images.readImageBuffer.mockResolvedValue(null);

    const result = await HANDLERS.describe_image({ image_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/not found/i);
  });

  it('refuses unsupported content types', async () => {
    Images.readImageBuffer.mockResolvedValue({
      buffer: TINY_PNG,
      file: { contentType: 'image/gif', length: TINY_PNG.length },
    });

    const result = await HANDLERS.describe_image({ image_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/unsupported/i);
  });

  it('refuses oversize images', async () => {
    const huge = Buffer.alloc(5 * 1024 * 1024, 0xff); // 5 MB > 4 MB cap
    Images.readImageBuffer.mockResolvedValue({
      buffer: huge,
      file: { contentType: 'image/jpeg', length: huge.length },
    });

    const result = await HANDLERS.describe_image({ image_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });

    expect(typeof result).toBe('string');
    expect(result).toMatch(/too large/i);
  });

  it('dispatchTool surfaces invalid image_id as a text error (does not throw)', async () => {
    Images.readImageBuffer.mockImplementation(async () => {
      throw new Error('input must be a 24 character hex string');
    });

    const out = await dispatchTool('describe_image', { image_id: 'not-hex' });

    expect(typeof out).toBe('string');
    expect(out).toMatch(/Tool error \(describe_image\)/);
  });
});
