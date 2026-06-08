# Fast fal.ai image models for storyboard generation

**Date:** 2026-06-08
**Status:** Draft — pending user review

## Goal

Add three **fast** fal.ai image-generation models as selectable options anywhere the SPA
generates images, motivated by the storyboard frame-generation flow where the current
default (`nano-banana-pro`, Gemini 3 Pro Image, $0.15/img) is slow and expensive. The
new options trade a little fidelity for large speed/cost gains while **preserving the
reference-image continuity** the storyboard pipeline relies on.

## Models being added

All three expose both a text-to-image endpoint and an `/edit` (image-to-image) endpoint
that accepts `image_urls`, so all three slot into the existing "auto-route between
generate and edit based on whether refs are present" pattern.

| Logical slug | Label (picker) | Generate endpoint | Edit endpoint | Size param | Edit refs cap | Price |
|---|---|---|---|---|---|---|
| `gemini-25-flash` | Gemini 2.5 Flash (fast) | `fal-ai/gemini-25-flash-image` | `fal-ai/gemini-25-flash-image/edit` | `aspect_ratio` | 10 (soft) | $0.040 / image |
| `nano-banana-2` | Nano Banana 2 (Gemini 3.1 Flash) | `fal-ai/nano-banana-2` | `fal-ai/nano-banana-2/edit` | `aspect_ratio` | 10 (soft) | $0.080 / image |
| `flux-2-klein` | Flux 2 Klein (fast) | `fal-ai/flux-2/klein/9b` | `fal-ai/flux-2/klein/9b/edit` | `image_size` | **4 (hard)** | $0.011 / megapixel |

Notes confirmed from the fal schema:
- Gemini 2.5 Flash and Nano Banana 2 are structurally **identical** to the existing
  `nano-banana-pro` helper: payload `{ prompt, aspect_ratio, num_images:1, output_format:'png' }`
  for generate; `/edit` requires `image_urls`. `aspect_ratio:"16:9"` is accepted by both.
- Flux 2 Klein differs in two ways: it uses **`image_size`** (object `{width,height}` or a
  preset string) instead of `aspect_ratio`, and its `/edit` endpoint allows a **maximum of 4**
  `image_urls`. Klein runs at 4 inference steps by default (the source of its speed).
- "Soft" caps truncate-with-warning (matching existing `nano-banana-pro` cap=14, `flux-2-pro`
  cap=9 behavior). The Klein cap of 4 is enforced by fal, so we truncate to it.

## Out of scope (explicit non-goals)

- **Default model is unchanged** — stays `nano-banana-pro`. Users opt into the fast models.
- **No FLUX schnell** — considered and rejected: its only image-conditioning is style-transfer
  (redux), which breaks character/scene continuity across storyboard frames.
- **No model picker added to the batch "Storyboard Generate" setup dialog** — that dialog only
  produces text prompts; it does not render images (see Architecture). Nothing to wire there.
- **No new cost/billing logic** beyond what `recordFalImageUsage` already records (see Risks).

## Architecture / how a model choice flows

1. The **batch** storyboard generate job (`startStoryboardGenerationJob` →
   `runStoryboardGenerationJob`) writes only text prompts to Mongo. It stores `image_model`
   as metadata but **does not render images**.
2. Image rendering happens **per frame** through `dispatchStoryboardImage`
   (`src/web/storyboardImageDispatch.js`), invoked by the per-frame regenerate flow
   (`callGenerateImage`, storyboardGenerate.js:1452). The model id comes from the SPA's
   `FrameRegenerateDialog`.
3. The standalone "edit / regenerate image" dialogs (character portraits, artwork, inline
   edits) route through `dispatchImageReplace` (`src/web/imageReplaceDispatch.js`).
4. Both dispatchers call the same fal helpers in `src/fal/imageClient.js` and validate against
   an allow-list. The SPA picker UI in all six dialogs is driven by the shared registry
   `web/src/widgets/imageModels.js`.

**Scope decision:** add the three models to the shared registry + both dispatchers, so they
appear in **every** image dialog (storyboard frames *and* character/artwork/inline). This is
the simplest path and a fast/cheap option is broadly useful; no per-dialog scoping.

## Components to change

### 1. `src/config.js` — `fal` block

Add six env-overridable model ids following the existing `nanoBananaPro*` / `flux2Pro*` style:

```js
gemini25FlashGenerateModel: process.env.FAL_GEMINI_25_FLASH_MODEL      || 'fal-ai/gemini-25-flash-image',
gemini25FlashEditModel:     process.env.FAL_GEMINI_25_FLASH_EDIT_MODEL || 'fal-ai/gemini-25-flash-image/edit',
nanoBanana2GenerateModel:   process.env.FAL_NANO_BANANA_2_MODEL        || 'fal-ai/nano-banana-2',
nanoBanana2EditModel:       process.env.FAL_NANO_BANANA_2_EDIT_MODEL   || 'fal-ai/nano-banana-2/edit',
flux2KleinGenerateModel:    process.env.FAL_FLUX_2_KLEIN_MODEL         || 'fal-ai/flux-2/klein/9b',
flux2KleinEditModel:        process.env.FAL_FLUX_2_KLEIN_EDIT_MODEL    || 'fal-ai/flux-2/klein/9b/edit',
```

### 2. `src/fal/imageClient.js` — extract shared helper + add 3 functions (Option B)

**Extract** an internal helper for the `aspect_ratio` + `image_urls` generate/edit family:

```js
// generate-endpoint when no refs; /edit endpoint (image_urls, capped) when refs present.
async function falGenerateEdit({ prompt, inputImages = [], aspectRatio = '16:9',
                                 generateModel, editModel, maxEditInputs, label }) { ... }
```

- **Refactor** `generateNanoBananaProImage` (cap 14) and `generateFlux2ProImage` (cap 9) to
  delegate to `falGenerateEdit`. Their exported names + the `*_MODEL` constants stay identical
  so both dispatchers keep importing them unchanged.
- **Add** `generateGemini25FlashImage` (cap 10) and `generateNanoBanana2Image` (cap 10) as thin
  wrappers over `falGenerateEdit`, plus exported `GEMINI_25_FLASH_GENERATE_MODEL` /
  `NANO_BANANA_2_GENERATE_MODEL` constants (used as the usage-tracking fallback model id).
- **Add** a dedicated `generateFlux2KleinImage` (does NOT use the helper) for Klein's quirks:
  - generate (0 refs): endpoint = klein generate, payload `{ prompt, image_size, num_images:1, output_format:'png' }`.
    Map `aspectRatio` → `image_size`; for the storyboard default `'16:9'` use `{ width: 2048, height: 1152 }`
    (matches the pipeline's OpenAI size). A small map handles the other ratios; unknown → omit (model default).
  - edit (≥1 ref): endpoint = klein edit, payload `{ prompt, image_urls (capped to 4), num_images:1, output_format:'png' }`,
    **omit `image_size`** so it inherits the reference frame's dimensions.
  - Export `FLUX_2_KLEIN_GENERATE_MODEL`.
- `callFal`, `fetchResultImage`, `inputToDataUrl`, `enrichFalError` are reused as-is — Klein's
  output shape (`images[0]`) matches what `callFal` already extracts.

### 3. `src/web/storyboardImageDispatch.js` and `src/web/imageReplaceDispatch.js`

Both files have the same shape (`ALLOWED_*` array, `FAL_MODELS` Set, a routing `if/else`).
In each:
- Add `'gemini-25-flash'`, `'nano-banana-2'`, `'flux-2-klein'` to the allow-list array and the
  `FAL_MODELS` set.
- Import the three new generate functions + their `*_MODEL` constants.
- Add three routing branches mirroring the `nano-banana-pro` branch (call helper, set
  `fallbackModel`). `storyboardImageDispatch` passes `aspectRatio: ASPECT_RATIO` ('16:9');
  `imageReplaceDispatch` passes none (helper default '16:9'), consistent with the existing fal calls.

`entityRoutes.js` needs **no change**: its `normalizeImageModel`/`isValidImageModel` validate
against `ALLOWED_IMAGE_MODELS` imported from `imageReplaceDispatch.js`, so updating that array
covers all ~8 validation sites automatically.

### 4. `web/src/widgets/imageModels.js`

Append to `IMAGE_MODELS` (order = picker order; keep `nano-banana-pro` first as default):

```js
{ id: 'gemini-25-flash', label: 'Gemini 2.5 Flash (fast)' },
{ id: 'nano-banana-2',   label: 'Nano Banana 2 (Gemini 3.1 Flash)' },
{ id: 'flux-2-klein',    label: 'Flux 2 Klein (fast)' },
```

`IMAGE_MODEL_IDS`, `readStoredImageModel`, and `DEFAULT_IMAGE_MODEL` derive from this list, so
all six dialogs pick up the new options automatically. Rebuild with `npm run build:web`.

## Testing (TDD — tests written first)

- **`src/fal/imageClient.js`** (new/extended unit tests, mock `fal.subscribe`):
  - `generateGemini25FlashImage` / `generateNanoBanana2Image`: 0 refs → generate endpoint with
    `aspect_ratio`; ≥1 ref → `/edit` endpoint with `image_urls`; refs over cap truncated.
  - `generateFlux2KleinImage`: 0 refs → klein generate with `image_size` (16:9 → 2048×1152, no
    `aspect_ratio` key); ≥1 ref → klein edit with `image_urls`, **no `image_size`**, refs > 4 truncated to 4.
  - Regression: existing `generateNanoBananaProImage` / `generateFlux2ProImage` behavior is
    unchanged after the helper refactor (same endpoints, same payload, same caps).
- **Dispatch** (`storyboardImageDispatch` + `imageReplaceDispatch`): each new slug routes to the
  right fal helper; an unknown slug still throws a 400; the three slugs are present in
  `ALLOWED_*` and `FAL_MODELS`.
- Run the full suite (`npm test`) — the storyboard generate/critique/constraints tests already
  in flight must stay green.

## Risks / edge cases

- **Klein per-megapixel pricing.** `recordFalImageUsage` is called with the model id string +
  meta; verify whether any downstream cost computation assumes per-image pricing (Klein is
  per-MP). If cost is only event-logged by model id, no change needed; if a price table exists,
  add Klein's per-MP entry. Treat as a verification step, not a blocker.
- **Klein 4-ref hard cap.** Storyboard edits can pass several reference frames; truncation to 4
  may drop context vs. the Gemini models (cap 10–14). Acceptable for a "fast/cheap" tier; logged
  via the existing truncation warning.
- **`image_size` mapping.** Only the storyboard 16:9 path is exercised today; map a couple of
  common ratios and fall back to the model default for anything unmapped so character/portrait
  generation via `imageReplaceDispatch` (which doesn't force a ratio) still works.
- **Edit-endpoint `aspect_ratio` default is `"auto"`** for the Gemini models; we explicitly pass
  `"16:9"` from the storyboard dispatcher, so output framing stays consistent.
