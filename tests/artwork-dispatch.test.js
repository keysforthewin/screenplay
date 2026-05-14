// Verifies dispatchImageReplace handles the new `referenceImages` parameter:
// references are prepended to inputImages on each provider, and OpenAI routes
// through the edits endpoint whenever any input image is present (even in
// 'generate' mode), which is the only safe way to feed references to that
// provider.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const openaiGenerateMock = vi.fn();
const openaiEditMock = vi.fn();
const falKontextMock = vi.fn();
const falNanoBananaProMock = vi.fn();
const falFlux2ProMock = vi.fn();

vi.mock('../src/openai/imageClient.js', () => ({
  generateCharacterSheetImage: (...args) => openaiGenerateMock(...args),
  generateCharacterSheetImageEdit: (...args) => openaiEditMock(...args),
  GPT_IMAGE_MODEL: 'gpt-image-2',
}));
vi.mock('../src/fal/imageClient.js', () => ({
  generateFluxKontextImage: (...args) => falKontextMock(...args),
  generateNanoBananaProImage: (...args) => falNanoBananaProMock(...args),
  generateFlux2ProImage: (...args) => falFlux2ProMock(...args),
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext',
  FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro',
  NANO_BANANA_PRO_GENERATE_MODEL: 'fal-ai/nano-banana-pro',
}));
vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => true,
}));
vi.mock('../src/mongo/tokenUsage.js', () => ({
  recordOpenAIImageUsage: vi.fn(),
  recordFalImageUsage: vi.fn(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/config.js', () => ({
  config: {
    openai: { apiKey: 'sk-test' },
    gemini: { apiKey: 'gem-test', vertex: { project: null } },
  },
}));

const { dispatchImageReplace } = await import('../src/web/imageReplaceDispatch.js');

beforeEach(() => {
  openaiGenerateMock.mockReset();
  openaiEditMock.mockReset();
  falKontextMock.mockReset();
  falNanoBananaProMock.mockReset();
  falFlux2ProMock.mockReset();
});

const refA = { buffer: Buffer.from('ref-a'), contentType: 'image/png' };
const refB = { buffer: Buffer.from('ref-b'), contentType: 'image/jpeg' };
const existing = { buffer: Buffer.from('existing'), contentType: 'image/png' };
const okOut = {
  buffer: Buffer.from('out'),
  contentType: 'image/png',
};

describe('dispatchImageReplace — nano-banana-pro with references', () => {
  it('passes all references plus the existing image as inputImages in edit mode', async () => {
    falNanoBananaProMock.mockResolvedValue({ ...okOut, model: 'fal-ai/nano-banana-pro/edit' });
    await dispatchImageReplace({
      prompt: 'p',
      mode: 'edit',
      model: 'nano-banana-pro',
      existingImage: existing,
      referenceImages: [refA, refB],
    });
    expect(falNanoBananaProMock).toHaveBeenCalledOnce();
    const arg = falNanoBananaProMock.mock.calls[0][0];
    expect(arg.inputImages).toHaveLength(3);
    expect(arg.inputImages[0]).toBe(refA);
    expect(arg.inputImages[1]).toBe(refB);
    expect(arg.inputImages[2]).toBe(existing);
  });

  it('passes only references in generate mode (no existing image)', async () => {
    falNanoBananaProMock.mockResolvedValue({ ...okOut, model: 'fal-ai/nano-banana-pro/edit' });
    await dispatchImageReplace({
      prompt: 'p',
      mode: 'generate',
      model: 'nano-banana-pro',
      referenceImages: [refA],
    });
    const arg = falNanoBananaProMock.mock.calls[0][0];
    expect(arg.inputImages).toEqual([refA]);
  });

  it('passes an empty inputImages array when no references and no existing', async () => {
    falNanoBananaProMock.mockResolvedValue({ ...okOut, model: 'fal-ai/nano-banana-pro' });
    await dispatchImageReplace({
      prompt: 'p',
      mode: 'generate',
      model: 'nano-banana-pro',
    });
    const arg = falNanoBananaProMock.mock.calls[0][0];
    expect(arg.inputImages).toEqual([]);
  });
});

describe('dispatchImageReplace — flux-pro-kontext with references', () => {
  it('passes all references plus existing as inputImages', async () => {
    falKontextMock.mockResolvedValue({ ...okOut, model: 'fal-ai/flux-pro/kontext' });
    await dispatchImageReplace({
      prompt: 'p',
      mode: 'edit',
      model: 'flux-pro-kontext',
      existingImage: existing,
      referenceImages: [refA, refB],
    });
    expect(falKontextMock).toHaveBeenCalledOnce();
    const arg = falKontextMock.mock.calls[0][0];
    expect(arg.inputImages).toHaveLength(3);
    expect(arg.inputImages[0]).toBe(refA);
    expect(arg.inputImages[2]).toBe(existing);
  });
});

describe('dispatchImageReplace — flux-2-pro', () => {
  it('routes to the flux-2-pro client with refs + existing in edit mode', async () => {
    falFlux2ProMock.mockResolvedValue({ ...okOut, model: 'fal-ai/flux-2-pro/edit' });
    await dispatchImageReplace({
      prompt: 'p',
      mode: 'edit',
      model: 'flux-2-pro',
      existingImage: existing,
    });
    expect(falFlux2ProMock).toHaveBeenCalledOnce();
    expect(falFlux2ProMock.mock.calls[0][0].inputImages).toEqual([existing]);
  });
});

describe('dispatchImageReplace — openai routing', () => {
  it('uses the edits endpoint whenever any input image is present, even in generate mode', async () => {
    openaiEditMock.mockResolvedValue({ ...okOut });
    await dispatchImageReplace({
      prompt: 'p',
      mode: 'generate',
      model: 'openai',
      referenceImages: [refA],
    });
    expect(openaiGenerateMock).not.toHaveBeenCalled();
    expect(openaiEditMock).toHaveBeenCalledOnce();
    const arg = openaiEditMock.mock.calls[0][0];
    expect(arg.inputImages).toEqual([refA]);
  });

  it('uses the text-to-image endpoint when no input images are present', async () => {
    openaiGenerateMock.mockResolvedValue({ ...okOut });
    await dispatchImageReplace({
      prompt: 'p',
      mode: 'generate',
      model: 'openai',
    });
    expect(openaiEditMock).not.toHaveBeenCalled();
    expect(openaiGenerateMock).toHaveBeenCalledOnce();
  });

  it('uses the edits endpoint in edit mode (existing image only)', async () => {
    openaiEditMock.mockResolvedValue({ ...okOut });
    await dispatchImageReplace({
      prompt: 'p',
      mode: 'edit',
      model: 'openai',
      existingImage: existing,
    });
    expect(openaiEditMock).toHaveBeenCalledOnce();
    const arg = openaiEditMock.mock.calls[0][0];
    expect(arg.inputImages).toEqual([existing]);
  });
});

describe('dispatchImageReplace — validation', () => {
  it('rejects referenceImages entries without buffer/contentType', async () => {
    await expect(
      dispatchImageReplace({
        prompt: 'p',
        mode: 'generate',
        model: 'nano-banana-pro',
        referenceImages: [{ buffer: Buffer.from('x') }],
      }),
    ).rejects.toThrow(/buffer \+ contentType/);
  });

  it('rejects unknown model values', async () => {
    await expect(
      dispatchImageReplace({
        prompt: 'p',
        mode: 'generate',
        model: 'gemini', // legacy
      }),
    ).rejects.toThrow(/Unknown image model/);
  });
});
