// Verifies dispatchStoryboardImage routes the three fast models to their fal
// helpers, exposes them in the allow-list, and still rejects unknown models.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const nanoProMock = vi.fn();
const flux2ProMock = vi.fn();
const kontextMock = vi.fn();
const gemini25Mock = vi.fn();
const nano2Mock = vi.fn();
const kleinMock = vi.fn();

vi.mock('../src/fal/imageClient.js', () => ({
  generateFluxKontextImage: (...a) => kontextMock(...a),
  generateFlux2ProImage: (...a) => flux2ProMock(...a),
  generateNanoBananaProImage: (...a) => nanoProMock(...a),
  generateGemini25FlashImage: (...a) => gemini25Mock(...a),
  generateNanoBanana2Image: (...a) => nano2Mock(...a),
  generateFlux2KleinImage: (...a) => kleinMock(...a),
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext',
  FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro',
  NANO_BANANA_PRO_GENERATE_MODEL: 'fal-ai/nano-banana-pro',
  GEMINI_25_FLASH_GENERATE_MODEL: 'fal-ai/gemini-25-flash-image',
  NANO_BANANA_2_GENERATE_MODEL: 'fal-ai/nano-banana-2',
  FLUX_2_KLEIN_GENERATE_MODEL: 'fal-ai/flux-2/klein/9b',
}));
vi.mock('../src/openai/imageClient.js', () => ({
  generateCharacterSheetImage: vi.fn(),
  generateCharacterSheetImageEdit: vi.fn(),
  GPT_IMAGE_MODEL: 'gpt-image-2',
}));
vi.mock('../src/fal/client.js', () => ({ isConfigured: () => true }));
vi.mock('../src/mongo/tokenUsage.js', () => ({
  recordOpenAIImageUsage: vi.fn(),
  recordFalImageUsage: vi.fn(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/config.js', () => ({ config: { openai: { apiKey: 'sk' } } }));

const { dispatchStoryboardImage, ALLOWED_STORYBOARD_MODELS } = await import(
  '../src/web/storyboardImageDispatch.js'
);

const okOut = { buffer: Buffer.from('o'), contentType: 'image/png' };

beforeEach(() => {
  gemini25Mock.mockReset();
  nano2Mock.mockReset();
  kleinMock.mockReset();
});

describe('dispatchStoryboardImage — fast models', () => {
  it('lists the three new slugs as allowed', () => {
    expect(ALLOWED_STORYBOARD_MODELS).toEqual(
      expect.arrayContaining(['gemini-25-flash', 'nano-banana-2', 'flux-2-klein']),
    );
  });

  it('routes gemini-25-flash to generateGemini25FlashImage with 16:9', async () => {
    gemini25Mock.mockResolvedValue({ ...okOut, model: 'fal-ai/gemini-25-flash-image' });
    const r = await dispatchStoryboardImage({ prompt: 'p', model: 'gemini-25-flash' });
    expect(gemini25Mock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'p', aspectRatio: '16:9' }),
    );
    expect(r.model).toBe('fal-ai/gemini-25-flash-image');
  });

  it('routes nano-banana-2 to generateNanoBanana2Image', async () => {
    nano2Mock.mockResolvedValue({ ...okOut, model: 'fal-ai/nano-banana-2' });
    await dispatchStoryboardImage({ prompt: 'p', model: 'nano-banana-2' });
    expect(nano2Mock).toHaveBeenCalledOnce();
  });

  it('routes flux-2-klein to generateFlux2KleinImage', async () => {
    kleinMock.mockResolvedValue({ ...okOut, model: 'fal-ai/flux-2/klein/9b' });
    await dispatchStoryboardImage({ prompt: 'p', model: 'flux-2-klein' });
    expect(kleinMock).toHaveBeenCalledOnce();
  });

  it('rejects an unknown model', async () => {
    await expect(
      dispatchStoryboardImage({ prompt: 'p', model: 'nope' }),
    ).rejects.toThrow(/Unknown storyboard image model/);
  });
});
