import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchImageFromUrl,
  USER_AGENT,
  MAX_IMAGE_BYTES,
  validateImageBuffer,
} from '../src/mongo/imageBytes.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function pngArrayBuffer() {
  const ab = new ArrayBuffer(PNG_BYTES.length);
  new Uint8Array(ab).set(PNG_BYTES);
  return ab;
}

describe('fetchImageFromUrl', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => pngArrayBuffer(),
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('exports a browser-shaped USER_AGENT (Wikimedia rejects bot-style UAs)', () => {
    expect(USER_AGENT).toMatch(/Mozilla.*Chrome/);
  });

  it('sends the User-Agent header on the outbound fetch', async () => {
    await fetchImageFromUrl('https://example.com/x.png');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] || {};
    const headers = init.headers || {};
    const ua = headers['User-Agent'] || headers['user-agent'];
    expect(ua).toBeTypeOf('string');
    expect(ua).toMatch(/Mozilla.*Chrome/);
    expect(ua).toBe(USER_AGENT);
  });

  it('returns the buffer and content type from a successful download', async () => {
    const { buffer, contentType } = await fetchImageFromUrl('https://example.com/x.png');
    expect(contentType).toBe('image/png');
    expect(buffer.equals(PNG_BYTES)).toBe(true);
  });
});

describe('MAX_IMAGE_BYTES', () => {
  it('is set to 100 MB so multer-uploaded images can fill the multer cap', () => {
    expect(MAX_IMAGE_BYTES).toBe(100 * 1024 * 1024);
  });

  it('accepts a 50 MB PNG buffer (rejected at the prior 25 MB cap)', () => {
    const fifty = Buffer.alloc(50 * 1024 * 1024, 0);
    PNG_BYTES.copy(fifty, 0);
    expect(() => validateImageBuffer(fifty)).not.toThrow();
  });

  it('still rejects a buffer larger than 100 MB', () => {
    const big = Buffer.alloc(101 * 1024 * 1024, 0);
    PNG_BYTES.copy(big, 0);
    expect(() => validateImageBuffer(big)).toThrow(/too large/);
  });
});
