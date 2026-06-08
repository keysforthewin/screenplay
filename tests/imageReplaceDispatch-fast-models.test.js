// Verifies dispatchImageReplace routes the three fast models to their fal
// helpers and exposes them in the allow-list. Complements artwork-dispatch.test.js
// (which covers the existing nano-banana-pro / flux-2-pro / openai paths).

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

const { dispatchImageReplace, ALLOWED_IMAGE_MODELS } = await import(
  '../src/web/imageReplaceDispatch.js'
);

const okOut = { buffer: Buffer.from('o'), contentType: 'image/png' };

beforeEach(() => {
  gemini25Mock.mockReset();
  nano2Mock.mockReset();
  kleinMock.mockReset();
});

describe('dispatchImageReplace — fast models', () => {
  it('lists the three new slugs as allowed', () => {
    expect(ALLOWED_IMAGE_MODELS).toEqual(
      expect.arrayContaining(['gemini-25-flash', 'nano-banana-2', 'flux-2-klein']),
    );
  });

  it('routes gemini-25-flash in generate mode', async () => {
    gemini25Mock.mockResolvedValue({ ...okOut, model: 'fal-ai/gemini-25-flash-image' });
    const r = await dispatchImageReplace({ prompt: 'p', mode: 'generate', model: 'gemini-25-flash' });
    expect(gemini25Mock).toHaveBeenCalledOnce();
    expect(r.model).toBe('fal-ai/gemini-25-flash-image');
  });

  it('routes nano-banana-2 in generate mode', async () => {
    nano2Mock.mockResolvedValue({ ...okOut, model: 'fal-ai/nano-banana-2' });
    await dispatchImageReplace({ prompt: 'p', mode: 'generate', model: 'nano-banana-2' });
    expect(nano2Mock).toHaveBeenCalledOnce();
  });

  it('routes flux-2-klein in generate mode', async () => {
    kleinMock.mockResolvedValue({ ...okOut, model: 'fal-ai/flux-2/klein/9b' });
    await dispatchImageReplace({ prompt: 'p', mode: 'generate', model: 'flux-2-klein' });
    expect(kleinMock).toHaveBeenCalledOnce();
  });
});
