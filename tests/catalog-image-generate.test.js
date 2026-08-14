// Generating an image from ANY endpoint in the fal catalog, not just the seven
// hand-wired shortcuts. The catalog row supplies the param names and the output
// path, so this runner never guesses at a model's schema.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const subscribeMock = vi.fn(async () => ({
  data: { images: [{ url: 'https://fal.media/out.png' }] },
}));
vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => true,
  fal: { subscribe: (...args) => subscribeMock(...args) },
}));

const uploadMock = vi.fn(async () => 'https://fal.media/in.png');
vi.mock('../src/fal/upload.js', () => ({
  uploadFalAsset: (...args) => uploadMock(...args),
}));

vi.mock('../src/fal/prepareImage.js', () => ({
  prepareImageForFal: async ({ buffer, contentType }) => ({ buffer, contentType }),
  extForContentType: () => 'png',
  renameForContentType: (n) => n,
}));

// A one-pixel PNG, so the magic-byte validation on the downloaded result passes.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const ROW = {
  endpoint_id: 'fal-ai/some-new-model',
  display_name: 'Some New Model',
  category: 'image-to-image',
  output: { kind: 'image', path: 'images[0].url' },
  inputs: {
    prompt: 'required',
    prompt_param: 'prompt',
    image: {
      need: 'optional',
      params: [{ name: 'image_urls', list: true, required: false }],
      required_count: 0,
      max: 4,
    },
    audio: { need: 'unused', param: null, list: false },
    video: { need: 'unused', param: null, list: false },
  },
  inputs_required: ['prompt'],
};

const getPlaygroundModelMock = vi.fn(async (id) => (id === ROW.endpoint_id ? ROW : null));
vi.mock('../src/fal/playgroundModels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getPlaygroundModel: (...args) => getPlaygroundModelMock(...args),
}));

const { generateCatalogImage } = await import('../src/fal/catalogImageGenerate.js');

beforeEach(() => {
  subscribeMock.mockClear();
  uploadMock.mockClear();
  getPlaygroundModelMock.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => TINY_PNG.buffer.slice(
      TINY_PNG.byteOffset,
      TINY_PNG.byteOffset + TINY_PNG.byteLength,
    ),
  })));
});

describe('generateCatalogImage', () => {
  it('returns the rendered bytes and the endpoint it used', async () => {
    const out = await generateCatalogImage({
      endpointId: 'fal-ai/some-new-model',
      prompt: 'a rainy alley',
    });

    expect(out.model).toBe('fal-ai/some-new-model');
    expect(out.contentType).toBe('image/png');
    expect(Buffer.isBuffer(out.buffer)).toBe(true);
    expect(out.buffer.length).toBeGreaterThan(0);
  });

  it("submits the prompt under the row's own param name", async () => {
    await generateCatalogImage({ endpointId: 'fal-ai/some-new-model', prompt: 'a rainy alley' });

    const [endpoint, opts] = subscribeMock.mock.calls[0];
    expect(endpoint).toBe('fal-ai/some-new-model');
    expect(opts.input.prompt).toBe('a rainy alley');
  });

  it('uploads reference images to fal and passes their URLs', async () => {
    await generateCatalogImage({
      endpointId: 'fal-ai/some-new-model',
      prompt: 'p',
      referenceImages: [{ buffer: TINY_PNG, contentType: 'image/png' }],
    });

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [, opts] = subscribeMock.mock.calls[0];
    expect(opts.input.image_urls).toEqual(['https://fal.media/in.png']);
  });

  it('drops references the endpoint cannot take rather than failing', async () => {
    getPlaygroundModelMock.mockResolvedValueOnce({
      ...ROW,
      category: 'text-to-image',
      inputs: {
        ...ROW.inputs,
        image: { need: 'unused', params: [], required_count: 0, max: 0 },
      },
    });

    await generateCatalogImage({
      endpointId: 'fal-ai/some-new-model',
      prompt: 'p',
      referenceImages: [{ buffer: TINY_PNG, contentType: 'image/png' }],
    });

    const [, opts] = subscribeMock.mock.calls[0];
    expect(opts.input.image_urls).toBeUndefined();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('clamps references to the endpoint documented maximum', async () => {
    getPlaygroundModelMock.mockResolvedValueOnce({
      ...ROW,
      inputs: {
        ...ROW.inputs,
        image: {
          need: 'optional',
          params: [{ name: 'image_urls', list: true, required: false }],
          required_count: 0,
          max: 2,
        },
      },
    });

    await generateCatalogImage({
      endpointId: 'fal-ai/some-new-model',
      prompt: 'p',
      referenceImages: [
        { buffer: TINY_PNG, contentType: 'image/png' },
        { buffer: TINY_PNG, contentType: 'image/png' },
        { buffer: TINY_PNG, contentType: 'image/png' },
      ],
    });

    expect(uploadMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an endpoint that is not in the catalog', async () => {
    await expect(
      generateCatalogImage({ endpointId: 'fal-ai/not-real', prompt: 'p' }),
    ).rejects.toThrow(/not in the fal catalog/i);
  });

  it('reports a result with no image URL as an error', async () => {
    subscribeMock.mockResolvedValueOnce({ data: {} });
    await expect(
      generateCatalogImage({ endpointId: 'fal-ai/some-new-model', prompt: 'p' }),
    ).rejects.toThrow(/no image/i);
  });

  it('reports a failed download rather than returning empty bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 })));
    await expect(
      generateCatalogImage({ endpointId: 'fal-ai/some-new-model', prompt: 'p' }),
    ).rejects.toThrow(/502/);
  });
});
