// dispatchImageReplace keeps the seven tuned shortcuts on their fast paths and
// sends anything else that resolves to a catalog image endpoint through the
// generic runner. Ids that are neither still fail closed with a 400.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const nanoBananaMock = vi.fn(async () => ({
  buffer: TINY_PNG,
  contentType: 'image/png',
  model: 'fal-ai/nano-banana-pro',
}));
vi.mock('../src/fal/imageClient.js', () => ({
  generateNanoBananaProImage: (...a) => nanoBananaMock(...a),
  generateFluxKontextImage: vi.fn(),
  generateFlux2ProImage: vi.fn(),
  generateGemini25FlashImage: vi.fn(),
  generateNanoBanana2Image: vi.fn(),
  generateFlux2KleinImage: vi.fn(),
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext',
  FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro',
  NANO_BANANA_PRO_GENERATE_MODEL: 'fal-ai/nano-banana-pro',
  GEMINI_25_FLASH_GENERATE_MODEL: 'fal-ai/gemini-25-flash-image',
  NANO_BANANA_2_GENERATE_MODEL: 'fal-ai/nano-banana-2',
  FLUX_2_KLEIN_GENERATE_MODEL: 'fal-ai/flux-2/klein/9b',
}));

vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => true,
  fal: { subscribe: vi.fn() },
}));

vi.mock('../src/mongo/tokenUsage.js', () => ({
  recordOpenAIImageUsage: vi.fn(async () => {}),
  recordFalImageUsage: vi.fn(async () => {}),
}));

const catalogGenerateMock = vi.fn(async () => ({
  buffer: TINY_PNG,
  contentType: 'image/png',
  model: 'fal-ai/some-new-model',
}));
vi.mock('../src/fal/catalogImageGenerate.js', () => ({
  generateCatalogImage: (...a) => catalogGenerateMock(...a),
}));

const getImageModelMock = vi.fn(async (id) =>
  (id === 'fal-ai/some-new-model'
    ? { id, endpoint_id: id, is_wired: false, category: 'text-to-image' }
    : null),
);
vi.mock('../src/fal/imageModelCatalog.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getImageModel: (...a) => getImageModelMock(...a),
}));

const { dispatchImageReplace } = await import('../src/web/imageReplaceDispatch.js');

beforeEach(() => {
  nanoBananaMock.mockClear();
  catalogGenerateMock.mockClear();
  getImageModelMock.mockClear();
});

describe('dispatchImageReplace catalog fallback', () => {
  it('keeps a wired shortcut on its tuned client', async () => {
    const out = await dispatchImageReplace({
      prompt: 'a rainy alley',
      mode: 'generate',
      model: 'nano-banana-pro',
    });

    expect(nanoBananaMock).toHaveBeenCalledTimes(1);
    expect(catalogGenerateMock).not.toHaveBeenCalled();
    expect(out.model).toBe('fal-ai/nano-banana-pro');
  });

  it('routes a catalog endpoint id through the generic runner', async () => {
    const out = await dispatchImageReplace({
      prompt: 'a rainy alley',
      mode: 'generate',
      model: 'fal-ai/some-new-model',
    });

    expect(catalogGenerateMock).toHaveBeenCalledTimes(1);
    expect(catalogGenerateMock.mock.calls[0][0]).toMatchObject({
      endpointId: 'fal-ai/some-new-model',
      prompt: 'a rainy alley',
    });
    expect(out.model).toBe('fal-ai/some-new-model');
  });

  it('passes the edited image to a catalog model as its first reference', async () => {
    await dispatchImageReplace({
      prompt: 'add a hat',
      mode: 'edit',
      model: 'fal-ai/some-new-model',
      existingImage: { buffer: TINY_PNG, contentType: 'image/png' },
      referenceImages: [{ buffer: TINY_PNG, contentType: 'image/jpeg' }],
    });

    const refs = catalogGenerateMock.mock.calls[0][0].referenceImages;
    expect(refs).toHaveLength(2);
    expect(refs[0].contentType).toBe('image/png');
  });

  it('still rejects an id that is neither wired nor in the catalog', async () => {
    await expect(
      dispatchImageReplace({ prompt: 'p', mode: 'generate', model: 'made-up-model' }),
    ).rejects.toThrow(/unknown image model/i);
  });
});
