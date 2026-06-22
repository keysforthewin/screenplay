# Frame Reference Selection + Model Info Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make storyboard frame reference-image selection prompt-aware and diverse (top-2 per source from the beat's artwork and each scene character's full image set, threshold-gated, clamped to the chosen model's reference cap), and surface per-model metadata (max refs, resolution, input formats) inline in the image-model picker.

**Architecture:** Feature 2 (model info) lands first because Feature 1's clamp consumes its registry. A backend registry module (`src/web/imageModelInfo.js`) becomes the single source of truth for per-model caps/metadata — referencing the now-exported fal caps — and is exposed via `GET /api/image-models` for the SPA to render. Feature 1 then rewrites the candidate pool in `src/web/frameReferences.js` to draw from the beat's GridFS artwork plus each character's full image set (reusing `referenceSelector.js` helpers), adds an LLM scorer in `src/llm/frameReferenceSelector.js`, and applies top-2-per-source + character-guarantee + model-cap clamp. Both the bulk auto-fill path and the per-frame auto-suggest route route through the unified selector.

**Tech Stack:** Node.js (ESM), Express, MongoDB (+ GridFS), Anthropic SDK (Haiku enhancer model), Vitest, React/Vite SPA.

## Global Constraints

- **ESM only**, `import`/`export` (matches the repo). No CommonJS.
- **Project scoping:** every `src/mongo/*` helper takes `projectId` first and throws `projectId required` on falsy — always thread `req.projectId` / `projectId`.
- **Graceful degradation:** reference selection must NEVER throw out of `autoFillFrameReferencesIfEmpty` or block generation; LLM/Mongo failures collapse to a safe fallback.
- **Single source of truth for caps:** per-model max reference counts live in `src/web/imageModelInfo.js` (referencing exported fal consts); do not re-hardcode them elsewhere.
- **Selector model:** `config.anthropic.enhancerModel` (default `claude-haiku-4-5-20251001`); skip the LLM call when `config.anthropic.apiKey` is falsy.
- **Mongo tests** use the in-memory fake (`tests/_fakeMongo.js`) mocked via `vi.mock('../src/mongo/client.js', ...)` then dynamic `await import(...)`; call `fakeDb.reset()` in `beforeEach`.
- **Run a single test file:** `npx vitest run tests/<file>.test.js`. Full suite: `npm test`.
- **Commits:** end every commit message body with `Claude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP`. Never add Co-Authored-By / attribution lines.

---

## Feature 2 — Image-model metadata (Tasks 1–4)

### Task 1: Export the per-endpoint reference caps from the fal client

**Files:**
- Modify: `src/fal/imageClient.js` (the private `const FLUX_2_PRO_EDIT_MAX_INPUTS` etc.)
- Test: `tests/fal-image-caps.test.js` (create)

**Interfaces:**
- Produces: named exports `FLUX_2_PRO_EDIT_MAX_INPUTS=9`, `NANO_BANANA_PRO_EDIT_MAX_INPUTS=14`, `GEMINI_25_FLASH_EDIT_MAX_INPUTS=10`, `NANO_BANANA_2_EDIT_MAX_INPUTS=10`, `FLUX_2_KLEIN_EDIT_MAX_INPUTS=4` from `src/fal/imageClient.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/fal-image-caps.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  FLUX_2_PRO_EDIT_MAX_INPUTS,
  NANO_BANANA_PRO_EDIT_MAX_INPUTS,
  GEMINI_25_FLASH_EDIT_MAX_INPUTS,
  NANO_BANANA_2_EDIT_MAX_INPUTS,
  FLUX_2_KLEIN_EDIT_MAX_INPUTS,
} from '../src/fal/imageClient.js';

describe('fal reference caps', () => {
  it('exports the documented per-endpoint maxima', () => {
    expect(FLUX_2_PRO_EDIT_MAX_INPUTS).toBe(9);
    expect(NANO_BANANA_PRO_EDIT_MAX_INPUTS).toBe(14);
    expect(GEMINI_25_FLASH_EDIT_MAX_INPUTS).toBe(10);
    expect(NANO_BANANA_2_EDIT_MAX_INPUTS).toBe(10);
    expect(FLUX_2_KLEIN_EDIT_MAX_INPUTS).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fal-image-caps.test.js`
Expected: FAIL — the consts are not exported (import resolves to `undefined`).

- [ ] **Step 3: Add `export` to each cap const**

In `src/fal/imageClient.js`, change each declaration (they live near their model helpers) from `const NAME =` to `export const NAME =`:

```js
export const FLUX_2_PRO_EDIT_MAX_INPUTS = 9;
export const NANO_BANANA_PRO_EDIT_MAX_INPUTS = 14;
export const GEMINI_25_FLASH_EDIT_MAX_INPUTS = 10;
export const NANO_BANANA_2_EDIT_MAX_INPUTS = 10;
export const FLUX_2_KLEIN_EDIT_MAX_INPUTS = 4;
```

Leave their existing usages (`maxEditInputs: FLUX_2_PRO_EDIT_MAX_INPUTS`, etc.) untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fal-image-caps.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fal/imageClient.js tests/fal-image-caps.test.js
git commit -m "$(printf '♻️ Export fal per-endpoint reference caps\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 2: Backend model-info registry

**Files:**
- Create: `src/web/imageModelInfo.js`
- Test: `tests/image-model-info.test.js`

**Interfaces:**
- Consumes: the exported caps from Task 1; the OpenAI cap is a local const (`OPENAI_EDIT_MAX_INPUTS = 16`).
- Produces:
  - `IMAGE_MODEL_INFO` — object keyed by model id → `{ id, label, family, maxReferenceImages, resolution, inputFormats, speed }`.
  - `listImageModelInfo()` → array of those entries in display order.
  - `maxReferenceImagesFor(modelId)` → number, falling back to `DEFAULT_MAX_REFERENCE_IMAGES = 6` for unknown ids.

- [ ] **Step 1: Write the failing test**

Create `tests/image-model-info.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  IMAGE_MODEL_INFO,
  listImageModelInfo,
  maxReferenceImagesFor,
  DEFAULT_MAX_REFERENCE_IMAGES,
} from '../src/web/imageModelInfo.js';
import { FLUX_2_KLEIN_EDIT_MAX_INPUTS } from '../src/fal/imageClient.js';

const EXPECTED_IDS = [
  'nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai',
  'gemini-25-flash', 'nano-banana-2', 'flux-2-klein',
];

describe('imageModelInfo', () => {
  it('has one entry per supported model with full metadata', () => {
    const list = listImageModelInfo();
    expect(list.map((m) => m.id)).toEqual(EXPECTED_IDS);
    for (const m of list) {
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
      expect(typeof m.maxReferenceImages).toBe('number');
      expect(m.maxReferenceImages).toBeGreaterThan(0);
      expect(typeof m.resolution).toBe('string');
      expect(Array.isArray(m.inputFormats)).toBe(true);
      expect(m.inputFormats.length).toBeGreaterThan(0);
      expect(typeof m.speed).toBe('string');
    }
  });

  it('sources the klein cap from the fal client (single source of truth)', () => {
    expect(IMAGE_MODEL_INFO['flux-2-klein'].maxReferenceImages).toBe(
      FLUX_2_KLEIN_EDIT_MAX_INPUTS,
    );
    expect(IMAGE_MODEL_INFO['flux-2-klein'].maxReferenceImages).toBe(4);
  });

  it('maxReferenceImagesFor falls back for unknown ids', () => {
    expect(maxReferenceImagesFor('nano-banana-pro')).toBe(14);
    expect(maxReferenceImagesFor('totally-unknown')).toBe(DEFAULT_MAX_REFERENCE_IMAGES);
    expect(DEFAULT_MAX_REFERENCE_IMAGES).toBe(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/image-model-info.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the registry module**

Create `src/web/imageModelInfo.js`:

```js
// Single source of truth for image-generation model metadata. The per-endpoint
// reference caps are imported from the fal client so they cannot drift; the
// rest (resolution, input formats, speed) is curated copy for the model picker.
// Consumed by GET /api/image-models (SPA display) and by the bulk frame
// reference auto-fill clamp (src/web/frameReferences.js).

import {
  FLUX_2_PRO_EDIT_MAX_INPUTS,
  NANO_BANANA_PRO_EDIT_MAX_INPUTS,
  GEMINI_25_FLASH_EDIT_MAX_INPUTS,
  NANO_BANANA_2_EDIT_MAX_INPUTS,
  FLUX_2_KLEIN_EDIT_MAX_INPUTS,
} from '../fal/imageClient.js';

// OpenAI gpt-image-2 edit accepts multiple input images (image[] array); the
// practical edit maximum is 16. Defined here since it isn't a fal endpoint.
const OPENAI_EDIT_MAX_INPUTS = 16;

// Flux Pro Kontext single-image endpoint takes 1 ref; the /multi endpoint takes
// several. We advertise the higher number the pipeline can actually drive.
const FLUX_KONTEXT_MAX_INPUTS = 4;

const PNG_JPEG_WEBP = ['PNG', 'JPEG', 'WebP'];

export const DEFAULT_MAX_REFERENCE_IMAGES = 6;

// Order here defines display order in the picker and the API response.
export const IMAGE_MODEL_INFO = {
  'nano-banana-pro': {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro (Gemini 3 Pro)',
    family: 'Gemini 3 Pro Image',
    maxReferenceImages: NANO_BANANA_PRO_EDIT_MAX_INPUTS,
    resolution: 'up to 4K, aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'standard',
  },
  'flux-2-pro': {
    id: 'flux-2-pro',
    label: 'Flux 2 Pro',
    family: 'FLUX.2 Pro',
    maxReferenceImages: FLUX_2_PRO_EDIT_MAX_INPUTS,
    resolution: 'aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'standard',
  },
  'flux-pro-kontext': {
    id: 'flux-pro-kontext',
    label: 'Flux Pro Kontext',
    family: 'FLUX.1 Kontext',
    maxReferenceImages: FLUX_KONTEXT_MAX_INPUTS,
    resolution: 'aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'standard',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (gpt-image-2)',
    family: 'gpt-image-2',
    maxReferenceImages: OPENAI_EDIT_MAX_INPUTS,
    resolution: 'up to 3840×2160 (auto-selected)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'standard',
  },
  'gemini-25-flash': {
    id: 'gemini-25-flash',
    label: 'Gemini 2.5 Flash (fast)',
    family: 'Gemini 2.5 Flash Image',
    maxReferenceImages: GEMINI_25_FLASH_EDIT_MAX_INPUTS,
    resolution: 'aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'fast',
  },
  'nano-banana-2': {
    id: 'nano-banana-2',
    label: 'Nano Banana 2 (Gemini 3.1 Flash)',
    family: 'Gemini 3.1 Flash Image',
    maxReferenceImages: NANO_BANANA_2_EDIT_MAX_INPUTS,
    resolution: 'aspect-driven (16:9 ≈ 2048×1152)',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'fast',
  },
  'flux-2-klein': {
    id: 'flux-2-klein',
    label: 'Flux 2 Klein (fast)',
    family: 'FLUX.2 [klein] 9B',
    maxReferenceImages: FLUX_2_KLEIN_EDIT_MAX_INPUTS,
    resolution: '2048×1152 (16:9), explicit pixel size',
    inputFormats: PNG_JPEG_WEBP,
    speed: 'fast (distilled 4-step)',
  },
};

export function listImageModelInfo() {
  return Object.values(IMAGE_MODEL_INFO);
}

export function maxReferenceImagesFor(modelId) {
  const info = IMAGE_MODEL_INFO[modelId];
  return info ? info.maxReferenceImages : DEFAULT_MAX_REFERENCE_IMAGES;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/image-model-info.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/imageModelInfo.js tests/image-model-info.test.js
git commit -m "$(printf '✨ Add image-model metadata registry\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 3: `GET /api/image-models` endpoint

**Files:**
- Modify: `src/web/entityRoutes.js` (add a GET route; add the import)
- Test: `tests/image-models-route.test.js`

**Interfaces:**
- Consumes: `listImageModelInfo()` from Task 2; `buildApiRouter()` from `src/web/entityRoutes.js`.
- Produces: `GET /api/image-models` → `200` with `{ models: [{ id, label, family, maxReferenceImages, resolution, inputFormats, speed }] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/image-models-route.test.js`. Mirror the existing route test pattern (an `express()` app with `buildApiRouter()` mounted under `/api`, using supertest if the repo already uses it — check `tests/storyboard-auto-populate-route.test.js` for the exact harness and copy it). Skeleton:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const fakeDb = (await import('./_fakeMongo.js')).createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
// Session + project middleware are exercised by the existing route tests;
// reuse their mocking approach from storyboard-auto-populate-route.test.js.

const { buildApiRouter } = await import('../src/web/entityRoutes.js');

function makeApp() {
  const app = express();
  app.use('/api', buildApiRouter());
  return app;
}

describe('GET /api/image-models', () => {
  beforeEach(() => fakeDb.reset());

  it('returns every model with full metadata', async () => {
    const res = await request(makeApp())
      .get('/api/image-models')
      .set(/* auth + project headers per existing test harness */);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.models)).toBe(true);
    const ids = res.body.models.map((m) => m.id);
    expect(ids).toContain('nano-banana-pro');
    expect(ids).toContain('flux-2-klein');
    const klein = res.body.models.find((m) => m.id === 'flux-2-klein');
    expect(klein.maxReferenceImages).toBe(4);
    expect(klein.inputFormats).toEqual(['PNG', 'JPEG', 'WebP']);
  });
});
```

> NOTE TO IMPLEMENTER: open `tests/storyboard-auto-populate-route.test.js` first and copy its exact app/middleware/auth-header setup (session creation, `X-Project-Id`), since that test already drives `buildApiRouter()` successfully. Match it rather than inventing a harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/image-models-route.test.js`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add the import and route**

In `src/web/entityRoutes.js`, add to the import block near the other `./` imports:

```js
import { listImageModelInfo } from './imageModelInfo.js';
```

Add this route alongside the other simple GET routes (e.g. just after the `/toc` route, ~line 695). It needs no project data, but lives under the authenticated `/api` router like its neighbors:

```js
router.get('/image-models', (req, res) => {
  res.json({ models: listImageModelInfo() });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/image-models-route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/entityRoutes.js tests/image-models-route.test.js
git commit -m "$(printf '✨ Add GET /api/image-models endpoint\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 4: Show model metadata inline in the picker

**Files:**
- Modify: `web/src/api.js` (add a fetch helper)
- Modify: `web/src/widgets/BulkGenerateImagesDialog.jsx`
- (Optional drift guard) Test: `tests/image-models-parity.test.js`

**Interfaces:**
- Consumes: `GET /api/image-models` (Task 3); `IMAGE_MODELS` from `web/src/widgets/imageModels.js`.
- Produces: a metadata line under each radio in the bulk dialog.

- [ ] **Step 1: Add a parity drift-guard test (backend)**

Create `tests/image-models-parity.test.js` — asserts the backend registry covers exactly the frontend-allowed ids (mirrors the existing id-list parity convention). The frontend list is duplicated here as a literal because Node can't import the JSX-adjacent module cleanly; keep it in sync by hand (this test is the guard):

```js
import { describe, it, expect } from 'vitest';
import { IMAGE_MODEL_INFO } from '../src/web/imageModelInfo.js';

// Mirror of web/src/widgets/imageModels.js IMAGE_MODELS ids. If you add a model
// in one place you must add it in the other; this test fails on drift.
const FRONTEND_MODEL_IDS = [
  'nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai',
  'gemini-25-flash', 'nano-banana-2', 'flux-2-klein',
];

describe('image model registry parity', () => {
  it('backend registry ids exactly match the frontend picker ids', () => {
    expect(Object.keys(IMAGE_MODEL_INFO).sort()).toEqual([...FRONTEND_MODEL_IDS].sort());
  });
});
```

Run: `npx vitest run tests/image-models-parity.test.js` → Expected: PASS (registry already matches).

- [ ] **Step 2: Add the fetch helper to the SPA api module**

In `web/src/api.js`, add (mirroring the existing GET helpers / `authHeaders()` usage in that file):

```js
export async function fetchImageModels() {
  const res = await fetch('/api/image-models', { headers: authHeaders() });
  if (!res.ok) throw new Error(`image-models ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}
```

> If `web/src/api.js` already exposes a generic `apiGet(path)` helper, use that instead of raw `fetch` to stay consistent — check the file and prefer the existing pattern.

- [ ] **Step 3: Render metadata inline in the dialog**

In `web/src/widgets/BulkGenerateImagesDialog.jsx`:

Add imports/state at the top of the component:

```jsx
import { useEffect, useState } from 'react';
import { fetchImageModels } from '../api.js';
```

Inside the component, add an info map keyed by id, loaded on open:

```jsx
const [modelInfo, setModelInfo] = useState({});
useEffect(() => {
  if (!open) return;
  let alive = true;
  fetchImageModels()
    .then((models) => {
      if (!alive) return;
      const byId = {};
      for (const m of models) byId[m.id] = m;
      setModelInfo(byId);
    })
    .catch(() => { /* label-only fallback */ });
  return () => { alive = false; };
}, [open]);
```

Replace the radio `<label>` body so it renders an optional metadata line:

```jsx
{IMAGE_MODELS.map((m) => {
  const info = modelInfo[m.id];
  return (
    <label key={m.id}>
      <input
        type="radio"
        name="bulk-image-model"
        value={m.id}
        checked={imageModel === m.id}
        onChange={() => setImageModel(m.id)}
      />
      <span>
        {m.label}
        {info && (
          <span className="model-meta" style={{ display: 'block', opacity: 0.7, fontSize: '0.85em' }}>
            {info.maxReferenceImages} ref images · {info.resolution} · {info.inputFormats.join('/')}
          </span>
        )}
      </span>
    </label>
  );
})}
```

- [ ] **Step 4: Verify the build + tests**

Run: `npm run build:web`
Expected: build succeeds (no syntax/import errors).
Run: `npx vitest run tests/image-models-parity.test.js`
Expected: PASS.

Optional manual check: `npm run dev:web`, open the "Generate all images" dialog, confirm each model shows a metadata line and that a simulated fetch failure (offline) still renders labels.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.js web/src/widgets/BulkGenerateImagesDialog.jsx tests/image-models-parity.test.js
git commit -m "$(printf '✨ Show per-model ref/resolution/format info in picker\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

## Feature 1 — Smarter reference selection (Tasks 5–9)

### Task 5: LLM relevance scorer

**Files:**
- Modify: `src/llm/frameReferenceSelector.js` (add a scorer + test override hook; keep the existing `selectFrameReferences` for now)
- Test: `tests/frame-reference-scorer.test.js`

**Interfaces:**
- Consumes: `config.anthropic.{apiKey,enhancerModel}`, `getAnthropic()`.
- Produces:
  - `scoreFrameReferences({ frameText, candidates })` → `Promise<Map<number, number>>` mapping 1-based catalog index → score in `[0,1]`. Returns an empty Map on missing key / empty input / parse failure / network error (never throws).
  - `_setFrameReferenceScorerForTests(fn | null)` — test override; when set, `scoreFrameReferences` calls `fn({ frameText, candidates })` instead of the network and expects it to return the same Map shape.

- [ ] **Step 1: Write the failing test**

Create `tests/frame-reference-scorer.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest';
import {
  scoreFrameReferences,
  _setFrameReferenceScorerForTests,
} from '../src/llm/frameReferenceSelector.js';

afterEach(() => _setFrameReferenceScorerForTests(null));

const CANDS = [
  { id: 'a', source: 'beat', name: 'Alley', description: 'rainy night alley' },
  { id: 'b', source: 'Steve', name: 'Steve hero', description: 'closeup' },
];

describe('scoreFrameReferences', () => {
  it('returns [] map when no candidates', async () => {
    const m = await scoreFrameReferences({ frameText: 'x', candidates: [] });
    expect(m.size).toBe(0);
  });

  it('returns [] map when frameText is blank', async () => {
    const m = await scoreFrameReferences({ frameText: '   ', candidates: CANDS });
    expect(m.size).toBe(0);
  });

  it('maps 1-based indices to scores via the override', async () => {
    _setFrameReferenceScorerForTests(async ({ candidates }) => {
      const m = new Map();
      candidates.forEach((_, i) => m.set(i + 1, i === 0 ? 0.9 : 0.2));
      return m;
    });
    const m = await scoreFrameReferences({ frameText: 'rainy alley', candidates: CANDS });
    expect(m.get(1)).toBe(0.9);
    expect(m.get(2)).toBe(0.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-reference-scorer.test.js`
Expected: FAIL — `scoreFrameReferences` / `_setFrameReferenceScorerForTests` not exported.

- [ ] **Step 3: Implement the scorer**

Append to `src/llm/frameReferenceSelector.js` (keep all existing code):

```js
// ---------------------------------------------------------------------------
// Relevance scorer — scores each candidate 0..1 for usefulness as a reference
// for a specific frame. Used by the new beat+character selection in
// src/web/frameReferences.js. Same graceful-failure contract as the picker:
// any problem yields an empty Map so generation is never blocked.
// ---------------------------------------------------------------------------

const SCORE_SYSTEM = [
  'You score reference images for usefulness in constructing ONE storyboard frame.',
  'You are given the FRAME description and a numbered CATALOG of available images',
  '(the scene/beat artwork plus characters who may appear).',
  'For EACH catalog number, output a relevance score from 0.0 to 1.0:',
  'high for locations, sets, props, mood, and characters that clearly match THIS frame;',
  'low for images that are unrelated. Be discriminating — do not give everything a high score.',
  'Respond with EXACTLY one line of compact JSON: {"scores":[{"n":<number>,"score":<0..1>}]}.',
  'Include every catalog number exactly once. No markdown, no commentary.',
].join(' ');

// Parse {"scores":[{"n":N,"score":S}]} into a Map<number, number> with N in
// [1,count] and S clamped to [0,1]. Returns null on any structural problem.
function safeParseScores(text, count) {
  if (typeof text !== 'string') return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(stripped);
    if (!obj || !Array.isArray(obj.scores)) return null;
    const out = new Map();
    for (const row of obj.scores) {
      const n = Number(row?.n);
      let s = Number(row?.score);
      if (!Number.isInteger(n) || n < 1 || n > count) continue;
      if (!Number.isFinite(s)) continue;
      if (s < 0) s = 0;
      if (s > 1) s = 1;
      out.set(n, s);
    }
    return out;
  } catch {
    return null;
  }
}

let scorerOverride = null;
export function _setFrameReferenceScorerForTests(fn) {
  scorerOverride = fn;
}

export async function scoreFrameReferences({ frameText, candidates }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return new Map();
  const frame = String(frameText || '').trim();
  if (!frame) return new Map();
  if (scorerOverride) {
    try {
      const m = await scorerOverride({ frameText: frame, candidates });
      return m instanceof Map ? m : new Map();
    } catch {
      return new Map();
    }
  }
  if (!config.anthropic?.apiKey) return new Map();

  const userText = [
    `FRAME:\n${frame}`,
    '',
    `CATALOG:\n${buildCatalogText(candidates)}`,
    '',
    'Score every catalog number as {"scores":[{"n":N,"score":S}]}.',
  ].join('\n');

  const t0 = Date.now();
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: SELECTOR_MODEL,
      max_tokens: 600,
      system: SCORE_SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const scores = safeParseScores(text, candidates.length);
    if (!scores) {
      logger.warn(`scoreFrameReferences: parse failed (${Date.now() - t0}ms)`);
      return new Map();
    }
    return scores;
  } catch (e) {
    logger.warn(`scoreFrameReferences: ${e.message} (${Date.now() - t0}ms)`);
    return new Map();
  }
}
```

> `buildCatalogText`, `SELECTOR_MODEL`, `config`, `getAnthropic`, `logger` are already defined/imported at the top of this file — reuse them. `buildCatalogText` shows `[CHARACTER]`/`[ARTWORK]` from `c.kind`; the new candidates will set `kind` too (Task 6).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-reference-scorer.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm/frameReferenceSelector.js tests/frame-reference-scorer.test.js
git commit -m "$(printf '✨ Add per-candidate frame reference relevance scorer\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 6: Rebuild the candidate pool from beat artwork + character full sets

**Files:**
- Modify: `src/web/frameReferences.js` (`buildFrameReferenceCandidates`)
- Test: `tests/frameReferences.test.js` (extend — read existing tests first and keep them passing or update intentionally)

**Interfaces:**
- Consumes: `getBeat(projectId, beatId)` and the beat's `main_image_id` (`src/mongo/plots.js`); `listImagesForBeat(projectId, beatId)` + `imageFileToMeta` (`src/mongo/images.js`); `gatherCharacterReferenceCandidates(projectId, names)` (`src/web/referenceSelector.js`).
- Produces: `buildFrameReferenceCandidates({ projectId, sb, frameText })` → `Array<{ id, kind, source, name, description }>` where `kind` is `'art'` for beat artwork and `'char'` for character images; `source` is `'beat'` or the character's stripped name. No library images. The `main_image_id` beat entry is included (deduped).

- [ ] **Step 1: Read the existing test, then write the new failing test**

First: `npx vitest run tests/frameReferences.test.js` to see current green state, and read it so the rewrite doesn't silently drop coverage.

Add/replace tests asserting the new pool. Use the fake-mongo mock pattern (top of file):

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { buildFrameReferenceCandidates } = await import('../src/web/frameReferences.js');
```

Test body (seed a beat with two GridFS beat images and one scene character with two images; assert sources/kinds and that library images are excluded):

```js
describe('buildFrameReferenceCandidates', () => {
  beforeEach(() => fakeDb.reset());

  it('pools beat artwork and each character full set, tagging source', async () => {
    // Seed plot with a beat that has main_image_id, two beat GridFS images,
    // and characters_in_scene = ['Steve']; seed Steve with 2 images.
    // (Use the same seeding helpers the existing frameReferences/reference-selector
    //  tests use — copy their fixture setup.)
    const sb = { _id: 'sb1', beat_id: 'beat1', characters_in_scene: ['Steve'] };
    const cands = await buildFrameReferenceCandidates({
      projectId: PID, sb, frameText: 'rainy alley closeup',
    });
    const sources = new Set(cands.map((c) => c.source));
    expect(sources.has('beat')).toBe(true);
    expect(sources.has('Steve')).toBe(true);
    // beat candidates are kind 'art', character candidates kind 'char'
    expect(cands.filter((c) => c.source === 'beat').every((c) => c.kind === 'art')).toBe(true);
    expect(cands.filter((c) => c.source === 'Steve').every((c) => c.kind === 'char')).toBe(true);
    // No library images leak in (library image id should be absent)
    expect(cands.find((c) => c.id === LIBRARY_IMG_ID)).toBeUndefined();
  });
});
```

> IMPLEMENTER: pull the exact beat/character/GridFS seeding from `tests/reference-selector.test.js` and the existing `tests/frameReferences.test.js`; reuse their fixtures rather than inventing field names. Replace `PID`, `LIBRARY_IMG_ID` with the fixture values.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frameReferences.test.js`
Expected: FAIL — current builder uses the library + char main image and has no `source`/`kind:'art'` beat artwork.

- [ ] **Step 3: Rewrite `buildFrameReferenceCandidates`**

In `src/web/frameReferences.js`, update imports:

```js
import { logger } from '../log.js';
import { listImagesForBeat, imageFileToMeta } from '../mongo/images.js';
import { getBeat } from '../mongo/plots.js';
import { stripMarkdown } from '../util/markdown.js';
import { scoreFrameReferences } from '../llm/frameReferenceSelector.js';
import { gatherCharacterReferenceCandidates } from './referenceSelector.js';
import { setStoryboardFrameReferenceImagesViaGateway } from './gateway.js';
import { maxReferenceImagesFor } from './imageModelInfo.js';
```

(Drop the `listLibraryImages` / `getCharacter` / `selectFrameReferences` imports if now unused — verify after the full task set.)

Replace `buildFrameReferenceCandidates` with:

```js
export const PER_SOURCE_MAX = 2;
export const RELEVANCE_THRESHOLD = 0.5;

export async function buildFrameReferenceCandidates({ projectId, sb, frameText = '' }) {
  const candidates = [];

  // Beat artwork — every GridFS image owned by this beat, including the beat's
  // main image. Tagged source 'beat'.
  try {
    const beatId = sb?.beat_id ? String(sb.beat_id) : null;
    if (beatId) {
      const files = await listImagesForBeat(projectId, beatId);
      const seen = new Set();
      for (const f of files) {
        const m = imageFileToMeta(f);
        const id = String(m._id);
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push({
          id,
          kind: 'art',
          source: 'beat',
          name: (m.name || '').trim() || 'beat artwork',
          description: (m.description || '').trim(),
        });
      }
    }
  } catch (e) {
    logger.warn(`frameReferences: beat artwork load failed: ${e.message}`);
  }

  // Scene characters — full image set per character (sheets -> main -> attached),
  // each character its own source. Reuses the referenceSelector gatherer.
  try {
    const names = Array.isArray(sb?.characters_in_scene) ? sb.characters_in_scene : [];
    const perChar = await gatherCharacterReferenceCandidates(projectId, names);
    for (const entry of perChar) {
      const source = stripMarkdown(entry.name || '').trim();
      if (!source) continue;
      for (const cand of entry.candidates || []) {
        const desc = [cand.description, cand.caption].filter(Boolean).join(' — ');
        candidates.push({
          id: String(cand.id),
          kind: 'char',
          source,
          name: cand.name || source,
          description: desc,
        });
      }
    }
  } catch (e) {
    logger.warn(`frameReferences: character candidates failed: ${e.message}`);
  }

  return candidates;
}
```

Keep the existing `tokenize`/`overlapScore` helpers only if still referenced; otherwise remove them in this task. `CATALOG_MAX` is no longer used for library trimming — remove it if unused (the pool is now bounded by beat+character image counts).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frameReferences.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/frameReferences.js tests/frameReferences.test.js
git commit -m "$(printf '✨ Pool frame references from beat artwork + character sets\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 7: Scored top-2-per-source selection with character guarantee + model clamp

**Files:**
- Modify: `src/web/frameReferences.js` (add `selectScoredFrameReferences`; rewrite `autoFillFrameReferencesIfEmpty`)
- Test: `tests/frameReferences-selection.test.js` (create)

**Interfaces:**
- Consumes: `scoreFrameReferences` (Task 5), `buildFrameReferenceCandidates` (Task 6), `maxReferenceImagesFor` (Task 2), `setStoryboardFrameReferenceImagesViaGateway`.
- Produces:
  - `selectScoredFrameReferences({ candidates, scores, maxTotal })` → `string[]` of image ids — pure function: ≤ `PER_SOURCE_MAX` per source above `RELEVANCE_THRESHOLD`, **guarantee ≥1 per character source** (best-scored even if below threshold; beat source NOT guaranteed), then clamp to `maxTotal` dropping lowest-scored first (guaranteed character picks retained longest).
  - `autoFillFrameReferencesIfEmpty({ projectId, sb, frame, frameText, autoReferences, imageModel })` → `string[]` (unchanged contract: only fills empty `reference_ids`, never throws).

- [ ] **Step 1: Write the failing test (pure selection function)**

Create `tests/frameReferences-selection.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  selectScoredFrameReferences,
  PER_SOURCE_MAX,
  RELEVANCE_THRESHOLD,
} from '../src/web/frameReferences.js';

function cand(id, source, kind = source === 'beat' ? 'art' : 'char') {
  return { id, source, kind, name: id, description: '' };
}

describe('selectScoredFrameReferences', () => {
  it('keeps at most PER_SOURCE_MAX per source above threshold', () => {
    const candidates = [
      cand('b1', 'beat'), cand('b2', 'beat'), cand('b3', 'beat'),
    ];
    const scores = new Map([[1, 0.9], [2, 0.8], [3, 0.7]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual(['b1', 'b2']); // top 2 of beat
    expect(PER_SOURCE_MAX).toBe(2);
  });

  it('excludes beat artwork below threshold', () => {
    const candidates = [cand('b1', 'beat'), cand('b2', 'beat')];
    const scores = new Map([[1, 0.2], [2, 0.1]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual([]);
    expect(RELEVANCE_THRESHOLD).toBe(0.5);
  });

  it('guarantees one image per character even below threshold', () => {
    const candidates = [cand('s1', 'Steve'), cand('s2', 'Steve')];
    const scores = new Map([[1, 0.1], [2, 0.05]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 99 });
    expect(out).toEqual(['s1']); // best of Steve, guaranteed
  });

  it('clamps to maxTotal dropping lowest score, keeping character guarantees', () => {
    const candidates = [
      cand('b1', 'beat'), cand('b2', 'beat'),
      cand('s1', 'Steve'),
    ];
    // beat high, Steve low — but Steve is guaranteed and must survive the clamp
    const scores = new Map([[1, 0.9], [2, 0.85], [3, 0.2]]);
    const out = selectScoredFrameReferences({ candidates, scores, maxTotal: 2 });
    expect(out).toContain('s1');       // guaranteed survives
    expect(out).toContain('b1');       // highest beat survives
    expect(out).not.toContain('b2');   // dropped to fit cap 2
    expect(out.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frameReferences-selection.test.js`
Expected: FAIL — `selectScoredFrameReferences` not exported.

- [ ] **Step 3: Implement selection + rewrite auto-fill**

Add to `src/web/frameReferences.js`:

```js
// Pure selection: group candidates by source, keep top PER_SOURCE_MAX above
// RELEVANCE_THRESHOLD; guarantee >=1 per character source (best-scored, even
// below threshold); beat source is threshold-only. Then clamp to maxTotal,
// dropping lowest-scored first while preserving character guarantees.
export function selectScoredFrameReferences({ candidates, scores, maxTotal }) {
  const scoreOf = (i) => (scores.get(i + 1) ?? 0);
  const bySource = new Map();
  candidates.forEach((c, i) => {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push({ c, score: scoreOf(i) });
  });

  const picks = []; // { id, score, guaranteed }
  for (const [source, items] of bySource) {
    items.sort((a, b) => b.score - a.score);
    const isChar = items.some((it) => it.c.kind === 'char') || source !== 'beat';
    const above = items.filter((it) => it.score >= RELEVANCE_THRESHOLD).slice(0, PER_SOURCE_MAX);
    if (above.length) {
      for (const it of above) picks.push({ id: it.c.id, score: it.score, guaranteed: false });
    } else if (isChar && items.length) {
      // character guarantee — include the single best even if below threshold
      picks.push({ id: items[0].c.id, score: items[0].score, guaranteed: true });
    }
  }

  // Dedupe by id, keeping the highest score / guaranteed flag.
  const byId = new Map();
  for (const p of picks) {
    const prev = byId.get(p.id);
    if (!prev || p.score > prev.score || (p.guaranteed && !prev.guaranteed)) {
      byId.set(p.id, { ...p, guaranteed: p.guaranteed || prev?.guaranteed });
    }
  }
  let kept = [...byId.values()];

  // Clamp: sort guaranteed-first then by score desc, take maxTotal.
  if (Number.isFinite(maxTotal) && kept.length > maxTotal) {
    kept.sort((a, b) =>
      (b.guaranteed - a.guaranteed) || (b.score - a.score));
    kept = kept.slice(0, maxTotal);
  }
  // Final order: by score desc (stable enough for references).
  kept.sort((a, b) => (b.guaranteed - a.guaranteed) || (b.score - a.score));
  return kept.map((p) => p.id);
}
```

Rewrite `autoFillFrameReferencesIfEmpty` to use the scorer + selection + clamp:

```js
export async function autoFillFrameReferencesIfEmpty({
  projectId,
  sb,
  frame,
  frameText,
  autoReferences = true,
  imageModel = null,
}) {
  if (!autoReferences) return [];
  if ((frame?.reference_ids || []).length > 0) return [];
  try {
    const text = String(frameText || '').trim();
    const candidates = await buildFrameReferenceCandidates({ projectId, sb, frameText: text });
    if (!candidates.length) return [];
    const scores = await scoreFrameReferences({ frameText: text, candidates });
    const maxTotal = maxReferenceImagesFor(imageModel);
    let ids = selectScoredFrameReferences({ candidates, scores, maxTotal });
    if (!ids.length) {
      // Fallback: beat main + each character's first candidate, clamped.
      ids = fallbackReferenceIds({ candidates, maxTotal });
    }
    if (!ids.length) return [];
    await setStoryboardFrameReferenceImagesViaGateway({
      projectId,
      storyboardId: sb._id,
      frameId: frame._id,
      imageIds: ids,
      mode: 'replace',
    });
    frame.reference_ids = ids;
    return ids;
  } catch (e) {
    logger.warn(`frameReferences: auto-fill failed for frame ${frame?._id}: ${e.message}`);
    return [];
  }
}

// Deterministic fallback when scoring yields nothing usable: first beat artwork
// + first candidate of each character source, clamped to maxTotal.
function fallbackReferenceIds({ candidates, maxTotal }) {
  const out = [];
  const seenSource = new Set();
  for (const c of candidates) {
    if (seenSource.has(c.source)) continue;
    seenSource.add(c.source);
    out.push(c.id);
  }
  const cap = Number.isFinite(maxTotal) ? maxTotal : out.length;
  return out.slice(0, cap);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/frameReferences-selection.test.js tests/frameReferences.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/frameReferences.js tests/frameReferences-selection.test.js
git commit -m "$(printf '✨ Score, cap-per-source, guarantee, and clamp frame refs\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 8: Thread `imageModel` + frame prompt into the bulk auto-fill call

**Files:**
- Modify: `src/web/storyboardGenerate.js` (the `autoFillFrameReferencesIfEmpty` call inside `regenerateStoryboardFrameInternal`, ~line 1763)
- Test: extend `tests/frameReferences-selection.test.js` is unit-level; add an integration assertion to whichever bulk-generation test exists, or a focused test (see step 1).

**Interfaces:**
- Consumes: `autoFillFrameReferencesIfEmpty({ ..., frameText, imageModel })` (Task 7). `imageModel` is already a parameter of `regenerateStoryboardFrameInternal`; `renderPrompt` is the per-frame text already built there.

- [ ] **Step 1: Write the failing test**

Search for an existing bulk-generation test (`rg -l "startBulkFrameGenerationJob|regenerateStoryboardFrameInternal" tests`). If one exists, add an assertion that the model's cap is respected; if none drives this cleanly, add a focused test that calls `autoFillFrameReferencesIfEmpty` with `imageModel: 'flux-2-klein'` and a candidate set where >4 would otherwise be picked, asserting `result.length <= 4`:

```js
it('clamps auto-fill to the model cap (klein=4)', async () => {
  // seed sb/frame/beat/characters yielding >4 above-threshold candidates,
  // override scorer to score them all 0.9
  _setFrameReferenceScorerForTests(async ({ candidates }) => {
    const m = new Map();
    candidates.forEach((_, i) => m.set(i + 1, 0.9));
    return m;
  });
  const ids = await autoFillFrameReferencesIfEmpty({
    projectId: PID, sb, frame, frameText: 'x',
    autoReferences: true, imageModel: 'flux-2-klein',
  });
  expect(ids.length).toBeLessThanOrEqual(4);
});
```

(Import `autoFillFrameReferencesIfEmpty` and `_setFrameReferenceScorerForTests`; use the fake-mongo seeding from Task 6.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frameReferences-selection.test.js`
Expected: FAIL — current call site passes `sceneText` (not `frameText`) and no `imageModel`, so the cap isn't applied (or text key mismatch yields no candidates/scoring).

- [ ] **Step 3: Update the call site**

In `src/web/storyboardGenerate.js` (~line 1763), change:

```js
await autoFillFrameReferencesIfEmpty({
  projectId,
  sb,
  frame,
  sceneText: renderPrompt,
  autoReferences,
});
```

to:

```js
await autoFillFrameReferencesIfEmpty({
  projectId,
  sb,
  frame,
  frameText: renderPrompt,
  autoReferences,
  imageModel,
});
```

(`imageModel` is in scope in `regenerateStoryboardFrameInternal`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/frameReferences-selection.test.js`
Then the broader suite touch: `npx vitest run tests/frameReferences.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/frameReferences-selection.test.js
git commit -m "$(printf '✨ Thread image model + frame prompt into ref auto-fill\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 9: Route the per-frame auto-suggest button through the unified selector

**Files:**
- Modify: `src/web/entityRoutes.js` (the `POST /storyboard/:id/frame/:frameId/reference/auto-populate` handler, ~line 3888)
- Test: `tests/storyboard-auto-populate-route.test.js` (update existing assertions)

**Interfaces:**
- Consumes: `buildFrameReferenceCandidates`, `scoreFrameReferences`, `selectScoredFrameReferences`, `maxReferenceImagesFor`. The route has no chosen model; use `maxReferenceImagesFor(null)` (→ `DEFAULT_MAX_REFERENCE_IMAGES = 6`) as the cap. Keep `mode: 'append'` and the response shape `{ storyboard, added, total }`.

- [ ] **Step 1: Update the test to expect the unified selection**

Read `tests/storyboard-auto-populate-route.test.js`. It currently asserts the old `selectBestReferencesForShot` behavior (one sheet per character, beat main first). Update it to drive the new path: seed beat artwork + a scene character with multiple images, mock the scorer (the route imports from `frameReferenceSelector.js`, so set `_setFrameReferenceScorerForTests`), and assert the response `added` reflects top-2-per-source + character guarantee, capped at 6. Keep the test exercising the real HTTP route via the existing harness.

```js
import { _setFrameReferenceScorerForTests } from '../src/llm/frameReferenceSelector.js';
// ...
afterEach(() => _setFrameReferenceScorerForTests(null));

it('auto-populates from beat artwork + character set, scored', async () => {
  _setFrameReferenceScorerForTests(async ({ candidates }) => {
    const m = new Map();
    candidates.forEach((c, i) => m.set(i + 1, c.source === 'beat' ? 0.9 : 0.8));
    return m;
  });
  const res = await request(app)
    .post(`/api/storyboard/${sbId}/frame/${frameId}/reference/auto-populate`)
    .set(/* auth + project headers */);
  expect(res.status).toBe(200);
  expect(res.body.total).toBeGreaterThan(0);
  expect(res.body.total).toBeLessThanOrEqual(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboard-auto-populate-route.test.js`
Expected: FAIL — route still calls `selectBestReferencesForShot`; the scorer override isn't consulted.

- [ ] **Step 3: Rewrite the handler's selection block**

In `src/web/entityRoutes.js`, update the imports to add (near the other `./` imports):

```js
import {
  buildFrameReferenceCandidates,
  selectScoredFrameReferences,
} from './frameReferences.js';
import { scoreFrameReferences } from '../llm/frameReferenceSelector.js';
import { maxReferenceImagesFor } from './imageModelInfo.js';
```

Replace the body between `const shotText = ...` and the `const existing = ...` lines:

```js
const shotText = [sb.summary, sb.text_prompt, frame.prompt]
  .map((s) => stripMarkdown(String(s || '')).trim())
  .filter(Boolean)
  .join('\n');

const candidates = await buildFrameReferenceCandidates({
  projectId: req.projectId,
  sb,
  frameText: shotText,
});
const scores = await scoreFrameReferences({ frameText: shotText, candidates });
const ids = selectScoredFrameReferences({
  candidates,
  scores,
  maxTotal: maxReferenceImagesFor(null),
});
```

Leave the existing `existing`/`added`/`setStoryboardFrameReferenceImagesViaGateway('append')`/response logic intact. Remove the now-unused `selectBestReferencesForShot` import from this file if no other route uses it (grep first).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/storyboard-auto-populate-route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/entityRoutes.js tests/storyboard-auto-populate-route.test.js
git commit -m "$(printf '✨ Unify per-frame auto-suggest with scored selection\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

## Final verification

- [ ] **Run the full suite:** `npm test` → all green. Fix any test that referenced the removed library-pool behavior or the old `sceneText` arg name.
- [ ] **Dead-code sweep:** grep for now-unused exports — `selectFrameReferences` (old picker), `CATALOG_MAX`, `tokenize`/`overlapScore` in `frameReferences.js`, and `selectBestReferencesForShot`/`resolveReferencePicks` if nothing else imports them. Leave the `referenceSelector.js` *gatherer* helpers (`gatherCharacterReferenceCandidates` etc.) — they are now used by `frameReferences.js`. Remove genuinely-dead code in a final `🗑️` commit; keep anything the untouched planner path still uses.
- [ ] **Build the SPA:** `npm run build:web` → succeeds.
- [ ] **Manual smoke (optional):** with `MONGO_URI` + keys set, open a storyboard, run "Generate all images" with Flux 2 Klein, confirm the picker shows "4 ref images · 2048×1152 …" and that auto-filled frames get ≤4 references skewed toward prompt-relevant beat/character art.

---

## Self-review notes (coverage check)

- Spec Feature 1 candidate pool (beat + char full sets, no library) → Task 6. ✓
- LLM relevance scoring → Task 5. ✓
- Top-2/source + threshold + character guarantee + model clamp → Task 7. ✓
- Bulk path threading (imageModel + frame prompt) → Task 8. ✓
- Per-frame auto-suggest unification → Task 9. ✓
- Planner path untouched (`selectBestReferencesForShot`) → preserved; only the auto-populate route stops calling it (Task 9), gatherers retained. ✓
- Feature 2 registry single-source-of-truth (exported fal caps) → Tasks 1–2. ✓
- `GET /api/image-models` → Task 3. ✓
- Inline metadata in picker + graceful fallback + drift guard → Task 4. ✓
