// Smoke test for src/fal/imageClient.js: confirms the Flux Kontext adapter
// builds a payload with `image_url` (single) or `image_urls` (multi),
// routes multi-ref calls to the multi-image endpoint (the single endpoint
// rejects `image_urls`), and returns a decoded buffer from the fal response.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const subscribeMock = vi.fn();
const falConfiguredMock = vi.fn(() => true);

vi.mock('../src/fal/client.js', () => ({
  fal: { subscribe: subscribeMock },
  isConfigured: falConfiguredMock,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stub the image-bytes validator with a permissive identity-like impl so we
// don't have to ship real PNG magic bytes inside the test buffers.
vi.mock('../src/mongo/imageBytes.js', () => ({
  validateImageBuffer: vi.fn(() => 'image/png'),
}));

const {
  generateFluxKontextImage,
  generateNanoBananaProImage,
  generateFlux2ProImage,
} = await import('../src/fal/imageClient.js');

beforeEach(() => {
  subscribeMock.mockReset();
  falConfiguredMock.mockReset().mockReturnValue(true);
});

function pngDataUrl(buf) {
  return `data:image/png;base64,${buf.toString('base64')}`;
}

describe('generateFluxKontextImage', () => {
  it('sends a single image_url to the single-image endpoint when one reference is provided', async () => {
    const outBuf = Buffer.from('out-bytes');
    subscribeMock.mockResolvedValue({
      data: { images: [{ url: pngDataUrl(outBuf), content_type: 'image/png' }] },
    });

    const refBuf = Buffer.from('ref-bytes');
    const out = await generateFluxKontextImage({
      prompt: 'wide shot of the diner',
      inputImages: [{ buffer: refBuf, contentType: 'image/png' }],
    });

    expect(subscribeMock).toHaveBeenCalledOnce();
    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/flux-pro/kontext');
    expect(opts.input.prompt).toBe('wide shot of the diner');
    expect(opts.input.image_url).toMatch(/^data:image\/png;base64,/);
    expect(opts.input.image_urls).toBeUndefined();
    expect(opts.input.aspect_ratio).toBe('16:9');
    expect(out.buffer.toString()).toBe(outBuf.toString());
    expect(out.contentType).toBe('image/png');
    expect(out.model).toBe('fal-ai/flux-pro/kontext');
  });

  it('routes to the multi-image endpoint with image_urls (plural) when 2+ references are provided', async () => {
    subscribeMock.mockResolvedValue({
      data: {
        images: [
          { url: pngDataUrl(Buffer.from('out')), content_type: 'image/png' },
        ],
      },
    });
    const refA = Buffer.from('a');
    const refB = Buffer.from('b');
    const out = await generateFluxKontextImage({
      prompt: 'p',
      inputImages: [
        { buffer: refA, contentType: 'image/png' },
        { buffer: refB, contentType: 'image/png' },
      ],
    });
    const [modelId, opts] = subscribeMock.mock.calls[0];
    // Critical: the single-image endpoint rejects requests that send
    // image_urls — we must hit the /multi variant for 2+ refs.
    expect(modelId).toBe('fal-ai/flux-pro/kontext/multi');
    expect(opts.input.image_urls).toHaveLength(2);
    expect(opts.input.image_url).toBeUndefined();
    expect(out.model).toBe('fal-ai/flux-pro/kontext/multi');
  });

  it('omits image_url / image_urls when no references are provided', async () => {
    subscribeMock.mockResolvedValue({
      data: { images: [{ url: pngDataUrl(Buffer.from('out')), content_type: 'image/png' }] },
    });
    await generateFluxKontextImage({ prompt: 'p' });
    const [, opts] = subscribeMock.mock.calls[0];
    expect(opts.input.image_url).toBeUndefined();
    expect(opts.input.image_urls).toBeUndefined();
  });

  it('throws when FAL_KEY is not configured', async () => {
    falConfiguredMock.mockReturnValue(false);
    await expect(
      generateFluxKontextImage({ prompt: 'p' }),
    ).rejects.toThrow(/FAL_KEY is not configured/);
  });

  it('throws when the prompt is empty', async () => {
    await expect(
      generateFluxKontextImage({ prompt: '   ' }),
    ).rejects.toThrow(/Empty prompt/);
  });

  it('throws when the response has no image', async () => {
    subscribeMock.mockResolvedValue({ data: { images: [] } });
    await expect(
      generateFluxKontextImage({ prompt: 'p' }),
    ).rejects.toThrow(/no.*image|did not include/i);
  });

  it('surfaces fal ValidationError detail string with HTTP status and request id', async () => {
    const upstream = new Error('Unprocessable Entity');
    upstream.status = 422;
    upstream.body = { detail: 'prompt too long for this model' };
    upstream.requestId = 'req-abc123';
    subscribeMock.mockRejectedValue(upstream);

    await expect(generateFluxKontextImage({ prompt: 'p' })).rejects.toMatchObject({
      message: expect.stringMatching(/HTTP 422.*prompt too long.*request_id=req-abc123/),
      status: 422,
      requestId: 'req-abc123',
    });
  });

  it('joins pydantic-style detail arrays into "loc: msg" pairs', async () => {
    const upstream = new Error('Unprocessable Entity');
    upstream.status = 422;
    upstream.body = {
      detail: [
        { loc: ['body', 'image_url'], msg: 'value is not a valid url', type: 'value_error.url' },
        { loc: ['body', 'prompt'], msg: 'ensure this value is shorter than 4096 characters' },
      ],
    };
    subscribeMock.mockRejectedValue(upstream);

    await expect(generateFluxKontextImage({ prompt: 'p' })).rejects.toThrow(
      /body\.image_url: value is not a valid url; body\.prompt: ensure/,
    );
  });

  it('maps fal 5xx errors to status 502 so the route layer surfaces them', async () => {
    const upstream = new Error('Internal Server Error');
    upstream.status = 503;
    upstream.body = { message: 'model temporarily unavailable' };
    subscribeMock.mockRejectedValue(upstream);

    await expect(generateFluxKontextImage({ prompt: 'p' })).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/HTTP 503.*model temporarily unavailable/),
    });
  });
});

describe('generateNanoBananaProImage', () => {
  it('routes single-image edits to fal-ai/nano-banana-pro/edit with image_urls', async () => {
    const outBuf = Buffer.from('edited-bytes');
    subscribeMock.mockResolvedValue({
      data: { images: [{ url: pngDataUrl(outBuf), content_type: 'image/png' }] },
    });

    const inBuf = Buffer.from('input-bytes');
    const out = await generateNanoBananaProImage({
      prompt: 'add a red hat',
      inputImages: [{ buffer: inBuf, contentType: 'image/png' }],
    });

    expect(subscribeMock).toHaveBeenCalledOnce();
    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/nano-banana-pro/edit');
    expect(opts.input.prompt).toBe('add a red hat');
    expect(opts.input.image_urls).toEqual([expect.stringMatching(/^data:image\/png;base64,/)]);
    expect(opts.input.image_url).toBeUndefined();
    expect(opts.input.aspect_ratio).toBe('16:9');
    expect(out.buffer.toString()).toBe(outBuf.toString());
    expect(out.contentType).toBe('image/png');
    expect(out.model).toBe('fal-ai/nano-banana-pro/edit');
  });

  it('routes pure text-to-image calls to fal-ai/nano-banana-pro (no /edit)', async () => {
    subscribeMock.mockResolvedValue({
      data: { images: [{ url: pngDataUrl(Buffer.from('out')), content_type: 'image/png' }] },
    });

    const out = await generateNanoBananaProImage({ prompt: 'wide shot of a cathedral' });

    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/nano-banana-pro');
    expect(opts.input.image_urls).toBeUndefined();
    expect(opts.input.image_url).toBeUndefined();
    expect(out.model).toBe('fal-ai/nano-banana-pro');
  });

  it('throws when FAL_KEY is not configured', async () => {
    falConfiguredMock.mockReturnValue(false);
    await expect(
      generateNanoBananaProImage({
        prompt: 'p',
        inputImages: [{ buffer: Buffer.from('x'), contentType: 'image/png' }],
      }),
    ).rejects.toThrow(/FAL_KEY is not configured/);
  });

  it('surfaces fal validation errors with status and request id', async () => {
    const upstream = new Error('Unprocessable Entity');
    upstream.status = 422;
    upstream.body = { detail: 'prompt too long' };
    upstream.requestId = 'req-nbp-1';
    subscribeMock.mockRejectedValue(upstream);

    await expect(
      generateNanoBananaProImage({
        prompt: 'p',
        inputImages: [{ buffer: Buffer.from('x'), contentType: 'image/png' }],
      }),
    ).rejects.toMatchObject({
      status: 422,
      requestId: 'req-nbp-1',
      message: expect.stringMatching(/nano-banana-pro.*HTTP 422.*prompt too long/),
    });
  });
});

describe('generateFlux2ProImage', () => {
  it('routes pure text-to-image calls to fal-ai/flux-2-pro', async () => {
    subscribeMock.mockResolvedValue({
      data: { images: [{ url: pngDataUrl(Buffer.from('out')), content_type: 'image/png' }] },
    });

    const out = await generateFlux2ProImage({ prompt: 'a misty diner at night' });

    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/flux-2-pro');
    expect(opts.input.image_urls).toBeUndefined();
    expect(opts.input.image_url).toBeUndefined();
    expect(out.model).toBe('fal-ai/flux-2-pro');
  });

  it('routes image-to-image edits to fal-ai/flux-2-pro/edit with image_urls', async () => {
    subscribeMock.mockResolvedValue({
      data: { images: [{ url: pngDataUrl(Buffer.from('out')), content_type: 'image/png' }] },
    });

    const inBuf = Buffer.from('ref');
    const out = await generateFlux2ProImage({
      prompt: 'change the lighting to dusk',
      inputImages: [{ buffer: inBuf, contentType: 'image/png' }],
    });

    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/flux-2-pro/edit');
    expect(opts.input.image_urls).toHaveLength(1);
    expect(opts.input.image_urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(out.model).toBe('fal-ai/flux-2-pro/edit');
  });

  it('caps inputs at 9 references and slices the rest off', async () => {
    subscribeMock.mockResolvedValue({
      data: { images: [{ url: pngDataUrl(Buffer.from('out')), content_type: 'image/png' }] },
    });

    const refs = Array.from({ length: 12 }, (_, i) => ({
      buffer: Buffer.from(`ref-${i}`),
      contentType: 'image/png',
    }));
    await generateFlux2ProImage({ prompt: 'p', inputImages: refs });

    const [, opts] = subscribeMock.mock.calls[0];
    expect(opts.input.image_urls).toHaveLength(9);
  });
});
