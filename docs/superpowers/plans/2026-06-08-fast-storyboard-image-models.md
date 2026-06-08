# Fast fal.ai Image Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three fast fal.ai image models (`gemini-25-flash`, `nano-banana-2`, `flux-2-klein`) as selectable options in every SPA image dialog, motivated by faster/cheaper storyboard frame generation.

**Architecture:** Add model ids to `config.fal`; extract a shared `falGenerateEdit()` helper in `src/fal/imageClient.js` and refactor the two existing generate/edit functions onto it, then add the two Gemini-family functions on the helper plus a bespoke Klein function (uses `image_size`, 4-ref cap); register the three slugs in both dispatchers (`storyboardImageDispatch.js`, `imageReplaceDispatch.js`) and the shared frontend registry (`web/src/widgets/imageModels.js`). Validation in `entityRoutes.js` is automatic via `ALLOWED_IMAGE_MODELS`.

**Tech Stack:** Node ESM, Vitest, `@fal-ai/client`, React/Vite SPA.

Spec: `docs/superpowers/specs/2026-06-08-fast-storyboard-image-models-design.md`

---

### Task 1: Config — add six fal model ids

**Files:**
- Modify: `src/config.js` (the `fal:` block, after `flux2ProEditModel`, before `storageLifetimeDays`)

- [ ] **Step 1: Add the config entries**

```js
    // Gemini 2.5 Flash Image (original "Nano Banana"). Fast/cheap generate/edit
    // split — bare endpoint is text-to-image, /edit takes image_urls.
    gemini25FlashGenerateModel:
      process.env.FAL_GEMINI_25_FLASH_MODEL || 'fal-ai/gemini-25-flash-image',
    gemini25FlashEditModel:
      process.env.FAL_GEMINI_25_FLASH_EDIT_MODEL || 'fal-ai/gemini-25-flash-image/edit',
    // Nano Banana 2 (Gemini 3.1 Flash). Newer fast Gemini; same generate/edit split.
    nanoBanana2GenerateModel:
      process.env.FAL_NANO_BANANA_2_MODEL || 'fal-ai/nano-banana-2',
    nanoBanana2EditModel:
      process.env.FAL_NANO_BANANA_2_EDIT_MODEL || 'fal-ai/nano-banana-2/edit',
    // FLUX.2 [klein] 9B. Distilled, 4-step fast model. Uses image_size (not
    // aspect_ratio); /edit caps at 4 reference images.
    flux2KleinGenerateModel:
      process.env.FAL_FLUX_2_KLEIN_MODEL || 'fal-ai/flux-2/klein/9b',
    flux2KleinEditModel:
      process.env.FAL_FLUX_2_KLEIN_EDIT_MODEL || 'fal-ai/flux-2/klein/9b/edit',
```

- [ ] **Step 2: Commit**

```bash
git add src/config.js
git commit -m "config: add fast fal.ai image model ids"
```

---

### Task 2: fal client — extract `falGenerateEdit()` helper, refactor existing two

**Files:**
- Modify: `src/fal/imageClient.js`
- Test (regression only): `tests/fal-image-client.test.js`

- [ ] **Step 1: Add the helper** (place above `generateFluxKontextImage`, after `callFal`)

```js
// Shared generate/edit-split driver for fal models that take `aspect_ratio`
// and accept `image_urls` on their /edit endpoint (Nano Banana Pro/2, Gemini
// 2.5 Flash, Flux 2 Pro). 0 refs → bare generate endpoint; ≥1 ref → /edit with
// image_urls, truncated to maxEditInputs.
async function falGenerateEdit({
  prompt,
  inputImages = [],
  aspectRatio = '16:9',
  generateModel,
  editModel,
  maxEditInputs,
  label,
}) {
  requirePrompt(prompt);
  requireFal();
  const refs = Array.isArray(inputImages) ? inputImages : [];
  const payload = { prompt, aspect_ratio: aspectRatio, num_images: 1, output_format: 'png' };
  let modelId;
  if (refs.length === 0) {
    modelId = generateModel;
  } else {
    modelId = editModel;
    let capped = refs;
    if (refs.length > maxEditInputs) {
      logger.warn(`fal ${label}/edit: ${refs.length} refs exceeds cap ${maxEditInputs}; truncating`);
      capped = refs.slice(0, maxEditInputs);
    }
    payload.image_urls = capped.map(inputToDataUrl);
  }
  logger.info(`fal ${label} → model=${modelId} prompt=${prompt.length}c refs=${refs.length}`);
  return callFal({ modelId, payload });
}
```

- [ ] **Step 2: Replace the body of `generateNanoBananaProImage`** with a delegation

```js
export async function generateNanoBananaProImage({ prompt, inputImages = [], aspectRatio = '16:9' }) {
  return falGenerateEdit({
    prompt, inputImages, aspectRatio,
    generateModel: NANO_BANANA_PRO_GENERATE_MODEL,
    editModel: NANO_BANANA_PRO_EDIT_MODEL,
    maxEditInputs: NANO_BANANA_PRO_EDIT_MAX_INPUTS,
    label: 'nano-banana-pro',
  });
}
```

- [ ] **Step 3: Replace the body of `generateFlux2ProImage`** with a delegation

```js
export async function generateFlux2ProImage({ prompt, inputImages = [], aspectRatio = '16:9' }) {
  return falGenerateEdit({
    prompt, inputImages, aspectRatio,
    generateModel: FLUX_2_PRO_MODEL,
    editModel: FLUX_2_PRO_EDIT_MODEL,
    maxEditInputs: FLUX_2_PRO_EDIT_MAX_INPUTS,
    label: 'flux-2-pro',
  });
}
```

- [ ] **Step 4: Run the regression tests**

Run: `npx vitest run tests/fal-image-client.test.js`
Expected: PASS (all existing nano-banana-pro + flux-2-pro + kontext cases green; behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/fal/imageClient.js
git commit -m "refactor: extract falGenerateEdit() shared helper"
```

---

### Task 3: fal client — add Gemini 2.5 Flash + Nano Banana 2

**Files:**
- Modify: `src/fal/imageClient.js`
- Test: `tests/fal-image-client.test.js`

- [ ] **Step 1: Write failing tests** (append inside the file, new describe blocks)

```js
describe('generateGemini25FlashImage', () => {
  it('routes text-to-image to fal-ai/gemini-25-flash-image with aspect_ratio', async () => {
    subscribeMock.mockResolvedValue({ data: { images: [{ url: pngDataUrl(Buffer.from('o')), content_type: 'image/png' }] } });
    const out = await generateGemini25FlashImage({ prompt: 'wide shot' });
    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/gemini-25-flash-image');
    expect(opts.input.image_urls).toBeUndefined();
    expect(opts.input.aspect_ratio).toBe('16:9');
    expect(out.model).toBe('fal-ai/gemini-25-flash-image');
  });
  it('routes edits to fal-ai/gemini-25-flash-image/edit with image_urls', async () => {
    subscribeMock.mockResolvedValue({ data: { images: [{ url: pngDataUrl(Buffer.from('o')), content_type: 'image/png' }] } });
    const out = await generateGemini25FlashImage({ prompt: 'p', inputImages: [{ buffer: Buffer.from('r'), contentType: 'image/png' }] });
    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/gemini-25-flash-image/edit');
    expect(opts.input.image_urls).toHaveLength(1);
    expect(out.model).toBe('fal-ai/gemini-25-flash-image/edit');
  });
});

describe('generateNanoBanana2Image', () => {
  it('routes text-to-image to fal-ai/nano-banana-2', async () => {
    subscribeMock.mockResolvedValue({ data: { images: [{ url: pngDataUrl(Buffer.from('o')), content_type: 'image/png' }] } });
    const out = await generateNanoBanana2Image({ prompt: 'wide shot' });
    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/nano-banana-2');
    expect(opts.input.image_urls).toBeUndefined();
    expect(out.model).toBe('fal-ai/nano-banana-2');
  });
  it('routes edits to fal-ai/nano-banana-2/edit with image_urls', async () => {
    subscribeMock.mockResolvedValue({ data: { images: [{ url: pngDataUrl(Buffer.from('o')), content_type: 'image/png' }] } });
    const out = await generateNanoBanana2Image({ prompt: 'p', inputImages: [{ buffer: Buffer.from('r'), contentType: 'image/png' }] });
    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/nano-banana-2/edit');
    expect(opts.input.image_urls).toHaveLength(1);
    expect(out.model).toBe('fal-ai/nano-banana-2/edit');
  });
});
```

Also add the two new names to the import at the top of the test file:

```js
const {
  generateFluxKontextImage,
  generateNanoBananaProImage,
  generateFlux2ProImage,
  generateGemini25FlashImage,
  generateNanoBanana2Image,
  generateFlux2KleinImage,
} = await import('../src/fal/imageClient.js');
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fal-image-client.test.js -t "Gemini 2.5"`
Expected: FAIL ("generateGemini25FlashImage is not a function").

- [ ] **Step 3: Implement** (add to `src/fal/imageClient.js`, near the other model constants/functions)

```js
export const GEMINI_25_FLASH_GENERATE_MODEL = config.fal.gemini25FlashGenerateModel;
export const GEMINI_25_FLASH_EDIT_MODEL = config.fal.gemini25FlashEditModel;
const GEMINI_25_FLASH_EDIT_MAX_INPUTS = 10;

export async function generateGemini25FlashImage({ prompt, inputImages = [], aspectRatio = '16:9' }) {
  return falGenerateEdit({
    prompt, inputImages, aspectRatio,
    generateModel: GEMINI_25_FLASH_GENERATE_MODEL,
    editModel: GEMINI_25_FLASH_EDIT_MODEL,
    maxEditInputs: GEMINI_25_FLASH_EDIT_MAX_INPUTS,
    label: 'gemini-25-flash',
  });
}

export const NANO_BANANA_2_GENERATE_MODEL = config.fal.nanoBanana2GenerateModel;
export const NANO_BANANA_2_EDIT_MODEL = config.fal.nanoBanana2EditModel;
const NANO_BANANA_2_EDIT_MAX_INPUTS = 10;

export async function generateNanoBanana2Image({ prompt, inputImages = [], aspectRatio = '16:9' }) {
  return falGenerateEdit({
    prompt, inputImages, aspectRatio,
    generateModel: NANO_BANANA_2_GENERATE_MODEL,
    editModel: NANO_BANANA_2_EDIT_MODEL,
    maxEditInputs: NANO_BANANA_2_EDIT_MAX_INPUTS,
    label: 'nano-banana-2',
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/fal-image-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fal/imageClient.js tests/fal-image-client.test.js
git commit -m "feat: add Gemini 2.5 Flash + Nano Banana 2 fal image helpers"
```

---

### Task 4: fal client — add FLUX.2 Klein 9B (bespoke, uses image_size + 4-ref cap)

**Files:**
- Modify: `src/fal/imageClient.js`
- Test: `tests/fal-image-client.test.js`

- [ ] **Step 1: Write failing tests**

```js
describe('generateFlux2KleinImage', () => {
  it('routes text-to-image to fal-ai/flux-2/klein/9b with image_size (no aspect_ratio)', async () => {
    subscribeMock.mockResolvedValue({ data: { images: [{ url: pngDataUrl(Buffer.from('o')), content_type: 'image/png' }] } });
    const out = await generateFlux2KleinImage({ prompt: 'wide shot' });
    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/flux-2/klein/9b');
    expect(opts.input.aspect_ratio).toBeUndefined();
    expect(opts.input.image_size).toEqual({ width: 2048, height: 1152 });
    expect(opts.input.image_urls).toBeUndefined();
    expect(out.model).toBe('fal-ai/flux-2/klein/9b');
  });
  it('routes edits to fal-ai/flux-2/klein/9b/edit with image_urls and no image_size', async () => {
    subscribeMock.mockResolvedValue({ data: { images: [{ url: pngDataUrl(Buffer.from('o')), content_type: 'image/png' }] } });
    const out = await generateFlux2KleinImage({ prompt: 'p', inputImages: [{ buffer: Buffer.from('r'), contentType: 'image/png' }] });
    const [modelId, opts] = subscribeMock.mock.calls[0];
    expect(modelId).toBe('fal-ai/flux-2/klein/9b/edit');
    expect(opts.input.image_urls).toHaveLength(1);
    expect(opts.input.image_size).toBeUndefined();
    expect(out.model).toBe('fal-ai/flux-2/klein/9b/edit');
  });
  it('caps edit references at 4', async () => {
    subscribeMock.mockResolvedValue({ data: { images: [{ url: pngDataUrl(Buffer.from('o')), content_type: 'image/png' }] } });
    const refs = Array.from({ length: 7 }, (_, i) => ({ buffer: Buffer.from(`r${i}`), contentType: 'image/png' }));
    await generateFlux2KleinImage({ prompt: 'p', inputImages: refs });
    const [, opts] = subscribeMock.mock.calls[0];
    expect(opts.input.image_urls).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fal-image-client.test.js -t "generateFlux2KleinImage"`
Expected: FAIL ("generateFlux2KleinImage is not a function").

- [ ] **Step 3: Implement**

```js
export const FLUX_2_KLEIN_GENERATE_MODEL = config.fal.flux2KleinGenerateModel;
export const FLUX_2_KLEIN_EDIT_MODEL = config.fal.flux2KleinEditModel;
const FLUX_2_KLEIN_EDIT_MAX_INPUTS = 4;

// FLUX.2 Klein takes image_size ({width,height}) rather than aspect_ratio.
// Map the ratios the pipeline uses to pixel dims; 16:9 matches the storyboard
// pipeline's 2048x1152. Unmapped ratios fall through to the model default.
const KLEIN_SIZE_BY_ASPECT = {
  '16:9': { width: 2048, height: 1152 },
  '9:16': { width: 1152, height: 2048 },
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1536, height: 1152 },
  '3:4': { width: 1152, height: 1536 },
};

export async function generateFlux2KleinImage({ prompt, inputImages = [], aspectRatio = '16:9' }) {
  requirePrompt(prompt);
  requireFal();
  const refs = Array.isArray(inputImages) ? inputImages : [];
  const payload = { prompt, num_images: 1, output_format: 'png' };
  let modelId;
  if (refs.length === 0) {
    modelId = FLUX_2_KLEIN_GENERATE_MODEL;
    const size = KLEIN_SIZE_BY_ASPECT[aspectRatio];
    if (size) payload.image_size = size;
  } else {
    modelId = FLUX_2_KLEIN_EDIT_MODEL;
    let capped = refs;
    if (refs.length > FLUX_2_KLEIN_EDIT_MAX_INPUTS) {
      logger.warn(`fal flux-2-klein/edit: ${refs.length} refs exceeds cap ${FLUX_2_KLEIN_EDIT_MAX_INPUTS}; truncating`);
      capped = refs.slice(0, FLUX_2_KLEIN_EDIT_MAX_INPUTS);
    }
    payload.image_urls = capped.map(inputToDataUrl);
    // image_size omitted in edit mode — Klein inherits the reference frame size.
  }
  logger.info(`fal flux-2-klein → model=${modelId} prompt=${prompt.length}c refs=${refs.length}`);
  return callFal({ modelId, payload });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/fal-image-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fal/imageClient.js tests/fal-image-client.test.js
git commit -m "feat: add FLUX.2 Klein 9B fal image helper"
```

---

### Task 5: storyboardImageDispatch — register the three slugs

**Files:**
- Modify: `src/web/storyboardImageDispatch.js`
- Test: `tests/storyboardImageDispatch.test.js` (new)

- [ ] **Step 1: Write failing test** (new file)

```js
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
vi.mock('../src/mongo/tokenUsage.js', () => ({ recordOpenAIImageUsage: vi.fn(), recordFalImageUsage: vi.fn() }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../src/config.js', () => ({ config: { openai: { apiKey: 'sk' } } }));

const { dispatchStoryboardImage, ALLOWED_STORYBOARD_MODELS } = await import('../src/web/storyboardImageDispatch.js');

const okOut = { buffer: Buffer.from('o'), contentType: 'image/png' };
beforeEach(() => { gemini25Mock.mockReset(); nano2Mock.mockReset(); kleinMock.mockReset(); });

describe('dispatchStoryboardImage — fast models', () => {
  it('lists the three new slugs as allowed', () => {
    expect(ALLOWED_STORYBOARD_MODELS).toEqual(expect.arrayContaining(['gemini-25-flash', 'nano-banana-2', 'flux-2-klein']));
  });
  it('routes gemini-25-flash to generateGemini25FlashImage with 16:9', async () => {
    gemini25Mock.mockResolvedValue({ ...okOut, model: 'fal-ai/gemini-25-flash-image' });
    const r = await dispatchStoryboardImage({ prompt: 'p', model: 'gemini-25-flash' });
    expect(gemini25Mock).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'p', aspectRatio: '16:9' }));
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
    await expect(dispatchStoryboardImage({ prompt: 'p', model: 'nope' })).rejects.toThrow(/Unknown storyboard image model/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/storyboardImageDispatch.test.js`
Expected: FAIL (slugs not in allow-list / not routed).

- [ ] **Step 3: Implement** — in `src/web/storyboardImageDispatch.js`:

(a) Extend the fal import:

```js
import {
  generateFluxKontextImage,
  generateFlux2ProImage,
  generateNanoBananaProImage,
  generateGemini25FlashImage,
  generateNanoBanana2Image,
  generateFlux2KleinImage,
  FLUX_KONTEXT_MODEL,
  FLUX_2_PRO_MODEL,
  NANO_BANANA_PRO_GENERATE_MODEL,
  GEMINI_25_FLASH_GENERATE_MODEL,
  NANO_BANANA_2_GENERATE_MODEL,
  FLUX_2_KLEIN_GENERATE_MODEL,
} from '../fal/imageClient.js';
```

(b) Extend the allow-list + FAL set:

```js
export const ALLOWED_STORYBOARD_MODELS = ['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai', 'gemini-25-flash', 'nano-banana-2', 'flux-2-klein'];
const FAL_MODELS = new Set(['nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'gemini-25-flash', 'nano-banana-2', 'flux-2-klein']);
```

(c) Insert three branches before the final `else` (the flux-kontext branch):

```js
    } else if (model === 'gemini-25-flash') {
      result = await generateGemini25FlashImage({ prompt, inputImages: refs, aspectRatio: ASPECT_RATIO });
      fallbackModel = GEMINI_25_FLASH_GENERATE_MODEL;
    } else if (model === 'nano-banana-2') {
      result = await generateNanoBanana2Image({ prompt, inputImages: refs, aspectRatio: ASPECT_RATIO });
      fallbackModel = NANO_BANANA_2_GENERATE_MODEL;
    } else if (model === 'flux-2-klein') {
      result = await generateFlux2KleinImage({ prompt, inputImages: refs, aspectRatio: ASPECT_RATIO });
      fallbackModel = FLUX_2_KLEIN_GENERATE_MODEL;
    } else {
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/storyboardImageDispatch.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardImageDispatch.js tests/storyboardImageDispatch.test.js
git commit -m "feat: route fast models through storyboard image dispatch"
```

---

### Task 6: imageReplaceDispatch — register the three slugs

**Files:**
- Modify: `src/web/imageReplaceDispatch.js`
- Test: `tests/imageReplaceDispatch-fast-models.test.js` (new)

- [ ] **Step 1: Write failing test** (new file — same mock block as Task 5 but importing `dispatchImageReplace`)

```js
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
vi.mock('../src/mongo/tokenUsage.js', () => ({ recordOpenAIImageUsage: vi.fn(), recordFalImageUsage: vi.fn() }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../src/config.js', () => ({ config: { openai: { apiKey: 'sk' } } }));

const { dispatchImageReplace, ALLOWED_IMAGE_MODELS } = await import('../src/web/imageReplaceDispatch.js');

const okOut = { buffer: Buffer.from('o'), contentType: 'image/png' };
beforeEach(() => { gemini25Mock.mockReset(); nano2Mock.mockReset(); kleinMock.mockReset(); });

describe('dispatchImageReplace — fast models', () => {
  it('lists the three new slugs as allowed', () => {
    expect(ALLOWED_IMAGE_MODELS).toEqual(expect.arrayContaining(['gemini-25-flash', 'nano-banana-2', 'flux-2-klein']));
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/imageReplaceDispatch-fast-models.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** — mirror Task 5 in `src/web/imageReplaceDispatch.js`: extend the fal import (same six functions + constants), extend `ALLOWED_IMAGE_MODELS` and `FAL_MODELS` with the three slugs, and insert the three `else if` branches before the final `else` (flux-kontext). The fal calls here pass only `{ prompt, inputImages }` (no aspectRatio), matching the existing nano-banana-pro branch:

```js
    } else if (model === 'gemini-25-flash') {
      result = await generateGemini25FlashImage({ prompt, inputImages });
      fallbackModel = GEMINI_25_FLASH_GENERATE_MODEL;
    } else if (model === 'nano-banana-2') {
      result = await generateNanoBanana2Image({ prompt, inputImages });
      fallbackModel = NANO_BANANA_2_GENERATE_MODEL;
    } else if (model === 'flux-2-klein') {
      result = await generateFlux2KleinImage({ prompt, inputImages });
      fallbackModel = FLUX_2_KLEIN_GENERATE_MODEL;
    } else {
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/imageReplaceDispatch-fast-models.test.js tests/artwork-dispatch.test.js`
Expected: PASS (new file green; existing artwork-dispatch unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/web/imageReplaceDispatch.js tests/imageReplaceDispatch-fast-models.test.js
git commit -m "feat: route fast models through image-replace dispatch"
```

---

### Task 7: Frontend registry — surface the three models in every dialog

**Files:**
- Modify: `web/src/widgets/imageModels.js`

- [ ] **Step 1: Append the three entries to `IMAGE_MODELS`**

```js
export const IMAGE_MODELS = [
  { id: 'nano-banana-pro', label: 'Nano Banana Pro (Gemini 3 Pro)' },
  { id: 'flux-2-pro', label: 'Flux 2 Pro' },
  { id: 'flux-pro-kontext', label: 'Flux Pro Kontext' },
  { id: 'openai', label: 'OpenAI (gpt-image-2)' },
  { id: 'gemini-25-flash', label: 'Gemini 2.5 Flash (fast)' },
  { id: 'nano-banana-2', label: 'Nano Banana 2 (Gemini 3.1 Flash)' },
  { id: 'flux-2-klein', label: 'Flux 2 Klein (fast)' },
];
```

(`DEFAULT_IMAGE_MODEL` stays `'nano-banana-pro'`.)

- [ ] **Step 2: Build the SPA**

Run: `npm run build:web`
Expected: build succeeds, `web/dist/` updated.

- [ ] **Step 3: Commit**

```bash
git add web/src/widgets/imageModels.js web/dist
git commit -m "feat: add fast image models to SPA picker registry"
```

---

### Task 8: Full suite + wrap-up

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS (all green).

- [ ] **Step 2: If green, final no-op confirmation commit is not needed.** Push branch when ready:

```bash
git push -u origin fast-fal-image-models
```

---

## Self-Review

- **Spec coverage:** config (Task 1) ✓; falGenerateEdit helper + refactor (Task 2) ✓; Gemini 2.5 + Nano Banana 2 (Task 3) ✓; Klein with image_size + 4-cap (Task 4) ✓; both dispatchers (Tasks 5–6) ✓; frontend registry (Task 7) ✓; entityRoutes auto-covered via ALLOWED_IMAGE_MODELS (noted, no task needed) ✓; default unchanged ✓; tests-first throughout ✓.
- **Placeholder scan:** none — every code step has full code.
- **Type/name consistency:** function names (`generateGemini25FlashImage`, `generateNanoBanana2Image`, `generateFlux2KleinImage`), constants (`*_GENERATE_MODEL`), slugs (`gemini-25-flash`, `nano-banana-2`, `flux-2-klein`), and config keys (`gemini25FlashGenerateModel`, etc.) are identical across config, client, dispatchers, tests, and registry.
- **Risk noted in spec:** Klein per-MP cost tracking — `recordFalImageUsage` records by model id; no price-table change identified. Verify during Task 8 that no cost assertion breaks.
