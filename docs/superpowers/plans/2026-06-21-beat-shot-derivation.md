# Beat Shot Derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the beat "Create image sheet" flow's "Target shots" number with a Derive → Review → Generate wizard backed by a two-phase LLM derivation that produces scene/background plates, each with a justification and a verbatim script quote.

**Architecture:** The planner (`beatSheetPlanner.js`) becomes two-phase: a holistic plan (`plan_scene_plates`) then a per-plate critique (`critique_scene_plate`, verdicts keep/edit/divide/cull). A new "derive" job + `POST /beat/:id/shot-plan` runs the derivation and parks at status `derived` with `job.shots`; the existing `POST /beat/:id/image-sheet` is generalized to render an explicit `shots[]` list. The derived list round-trips through the browser (no server-side parked state). The dialog becomes a wizard.

**Tech Stack:** Node.js (ESM), Express, MongoDB (in-memory fake in tests), Anthropic SDK (streamed forced-tool calls), Vitest (backend only — `web/` has no test runner), React/Vite SPA.

## Global Constraints

- **Plates are empty scene/background plates** — no characters (unless a beat truly cannot be represented without a figure), no proper names in prompts, no caption/quote text in prompts. (Unchanged purpose; reusable storyboard backdrops.)
- **`justification` and `quote` are review-only metadata** — never concatenated into the image prompt; only `{ name, prompt }` is ever rendered.
- **Planner model:** `STORYBOARD_MODEL` (imported from `src/web/storyboardGenerate.js`) for BOTH phases.
- **Plate count is chosen by the model from the beat text** — there is NO target count. A safety cap of `MAX_SCENE_IMAGE_COUNT = 20` is applied AFTER phase 2.
- **Phase-2 critique concurrency:** `PHASE2_CONCURRENCY = 4`.
- **Character path is unchanged** — fixed checklist, `shot_names`/`shot_count`, immediate job.
- **Commits:** every commit message ends with a second paragraph `Claude-Session: https://claude.ai/code/session_01LPebMckxrXoF9uJsQeYcJi`. Never add Co-Authored-By or any attribution trailer.
- **No frontend unit tests** — `web/` has no test runner; frontend tasks verify with `npm run build:web` plus a manual smoke checklist.

## File Structure

- `src/web/beatSheetPlanner.js` — **rewritten** two-phase planner. Exports the two tool defs, two system prompts, two user-text builders, `normalizeScenePlanImages` (now carries justification/quote), `planBeatSceneImages({...,onProgress})`, `MAX_SCENE_IMAGE_COUNT`, `PHASE2_CONCURRENCY`, and two test seams `_setScenePlatePlannerForTests` / `_setScenePlateCritiqueForTests`. Removes the old single-planner symbols.
- `src/web/imageSheetJobs.js` — adds `startShotPlanJob` (derive job, kind `beat_plan`, parks at `derived` with `job.shots`); generalizes `startImageSheetJob`/`runSheetJob` to render an explicit `shots[]` (beats require it); reduces `planShots` to character-only.
- `src/web/entityRoutes.js` — adds `POST /beat/:id/shot-plan`; generalizes `POST /:host/:id/image-sheet` to accept `shots[]`.
- `web/src/widgets/ImageSheetDialog.jsx` — **rewritten** beat branch as a setup→deriving→review wizard (character branch unchanged).
- `web/src/styles.css` — review-card styles.
- `web/src/api.js` — **no change**; the dialog uses the existing `apiPostJson` / `apiGet` directly (a one-line wrapper would not earn its keep — YAGNI).
- `web/src/widgets/ArtworkTab.jsx` — **no change**; the derive job lives inside the dialog and creates no tiles, so the existing `sheetActive` gating still holds (verify only).
- Tests: `tests/beatSheetPlanner.test.js` (rewritten), `tests/imageSheetJobs.test.js` (beat section reworked + additions), `tests/imageSheetRoutes.test.js` (beat tests reworked + additions).

---

## Task 1: Two-phase planner rewrite

**Files:**
- Rewrite: `src/web/beatSheetPlanner.js`
- Rewrite: `tests/beatSheetPlanner.test.js`
- Modify (seam usage only): `tests/imageSheetJobs.test.js`, `tests/imageSheetRoutes.test.js`

**Interfaces:**
- Produces:
  - `planBeatSceneImages({ beat, characters?, referenceInputs?, direction?, directorNotes?, onProgress? }) → Promise<{ images: Array<{name, prompt, justification, quote}> }>` (no `targetCount`; tolerates/ignores unknown keys).
  - `normalizeScenePlanImages(raw, { max }) → Array<{name, prompt, justification, quote}>`
  - `MAX_SCENE_IMAGE_COUNT = 20`, `PHASE2_CONCURRENCY = 4`
  - `SCENE_PLATE_PLAN_TOOL` (name `plan_scene_plates`), `SCENE_PLATE_PLAN_SYSTEM_PROMPT`, `buildScenePlatePlanUserText(args)`
  - `SCENE_PLATE_CRITIQUE_TOOL` (name `critique_scene_plate`), `SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT`, `buildScenePlateCritiqueUserText({...,plate})`
  - Seams: `_setScenePlatePlannerForTests(fn|null)` (phase 1; receives the phase-1 args, returns a raw plate array), `_setScenePlateCritiqueForTests(fn|null)` (phase 2; receives `(plate, ctx)`, returns a verdict object).
- Consumes: `getAnthropic` (`src/anthropic/client.js`), `STORYBOARD_MODEL` + `buildBeatContextBlock` (`src/web/storyboardGenerate.js`), `logger` (`src/log.js`).
- Note: the OLD symbols `SCENE_IMAGE_PLAN_TOOL`, `SCENE_IMAGE_PLAN_SYSTEM_PROMPT`, `buildSceneImagePlanUserText`, `clampSceneImageCount`, `MIN_SCENE_IMAGE_COUNT`, `DEFAULT_SCENE_IMAGE_COUNT`, `_setSceneImagePlannerForTests` are REMOVED.

- [ ] **Step 1: Replace the planner test file** with the new two-phase tests.

Write `tests/beatSheetPlanner.test.js`:

```js
// Unit tests for the two-phase beat plate planner. The real Anthropic calls are
// covered by the phase seams; the normalize/guard/verdict logic and the
// user-message builders are tested directly.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => ({}),
  connectMongo: async () => ({}),
}));
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  uploadGeneratedImage: vi.fn(async () => ({ _id: 'x' })),
}));

const Planner = await import('../src/web/beatSheetPlanner.js');

const beat = {
  order: 3,
  name: 'The Alley',
  desc: 'A chase ends.',
  body: 'INT. ALLEY - NIGHT\nRain falls. A dumpster overflows.',
  characters: ['Rae'],
};

beforeEach(() => {
  Planner._setScenePlatePlannerForTests(null);
  Planner._setScenePlateCritiqueForTests(null);
});

describe('buildScenePlatePlanUserText', () => {
  it('includes the beat context, director notes, and reference descriptions; no target count', () => {
    const text = Planner.buildScenePlatePlanUserText({
      beat,
      characters: [],
      direction: '',
      directorNotes: [{ text: 'Neo-noir mood' }],
      referenceInputs: [{ name: 'alley ref', description: 'wet brick alley at night' }],
    });
    expect(text).toContain('The Alley');
    expect(text).toContain('Rain falls.');
    expect(text).toContain('Neo-noir mood');
    expect(text).toContain('wet brick alley at night');
    expect(text.toLowerCase()).toContain('no target count');
  });

  it('omits the reference block when there are no reference inputs', () => {
    const text = Planner.buildScenePlatePlanUserText({ beat, characters: [], referenceInputs: [] });
    expect(text.toLowerCase()).not.toContain('reference images provided');
  });
});

describe('buildScenePlateCritiqueUserText', () => {
  it('includes the single plate and the beat context', () => {
    const text = Planner.buildScenePlateCritiqueUserText({
      beat,
      plate: { name: 'Alley — wide', prompt: 'wide empty alley', justification: 'establishes', quote: 'Rain falls.' },
    });
    expect(text).toContain('Alley — wide');
    expect(text).toContain('wide empty alley');
    expect(text).toContain('Rain falls.');
  });
});

describe('normalizeScenePlanImages', () => {
  it('drops entries missing name or prompt, trims, and carries justification/quote', () => {
    const out = Planner.normalizeScenePlanImages(
      [
        { name: '  Wide  ', prompt: '  a wide shot  ', justification: '  why  ', quote: '  Rain falls.  ' },
        { name: 'no prompt' },
        { prompt: 'no name' },
        { name: 'Insert', prompt: 'a detail' },
      ],
      { max: 10 },
    );
    expect(out).toEqual([
      { name: 'Wide', prompt: 'a wide shot', justification: 'why', quote: 'Rain falls.' },
      { name: 'Insert', prompt: 'a detail', justification: '', quote: '' },
    ]);
  });

  it('clamps to max', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, prompt: `p${i}` }));
    expect(Planner.normalizeScenePlanImages(many, { max: 5 })).toHaveLength(5);
  });

  it('returns [] for non-array / empty input', () => {
    expect(Planner.normalizeScenePlanImages(null, { max: 5 })).toEqual([]);
    expect(Planner.normalizeScenePlanImages([], { max: 5 })).toEqual([]);
  });
});

describe('planBeatSceneImages — phase 1', () => {
  it('returns normalized plates from the phase-1 seam (phase-2 keep)', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Establishing', prompt: 'wide empty alley, dusk', justification: 'sets place', quote: 'INT. ALLEY - NIGHT' },
      { name: '', prompt: 'dropped — no name', justification: '', quote: '' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images).toEqual([
      { name: 'Establishing', prompt: 'wide empty alley, dusk', justification: 'sets place', quote: 'INT. ALLEY - NIGHT' },
    ]);
  });

  it('returns { images: [] } when phase 1 yields nothing (phase 2 not invoked)', async () => {
    let phase2Calls = 0;
    Planner._setScenePlatePlannerForTests(async () => []);
    Planner._setScenePlateCritiqueForTests(async () => { phase2Calls += 1; return { verdict: 'keep' }; });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images).toEqual([]);
    expect(phase2Calls).toBe(0);
  });
});

describe('planBeatSceneImages — phase 2 verdicts', () => {
  function seedTwoPlates() {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'A', prompt: 'plate a', justification: 'ja', quote: 'qa' },
      { name: 'B', prompt: 'plate b', justification: 'jb', quote: 'qb' },
    ]));
  }

  it('keep leaves plates unchanged', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.map((i) => i.name)).toEqual(['A', 'B']);
    expect(images[0].prompt).toBe('plate a');
  });

  it('edit replaces the prompt and preserves the quote', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async (plate) =>
      plate.name === 'A' ? { verdict: 'edit', prompt: 'plate a, refined' } : { verdict: 'keep' });
    const { images } = await Planner.planBeatSceneImages({ beat });
    const a = images.find((i) => i.name === 'A');
    expect(a.prompt).toBe('plate a, refined');
    expect(a.quote).toBe('qa');
  });

  it('divide expands one plate into two, in place', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async (plate) =>
      plate.name === 'A'
        ? { verdict: 'divide', shots: [
            { name: 'A1', prompt: 'plate a1', justification: 'j1', quote: 'q1' },
            { name: 'A2', prompt: 'plate a2', justification: 'j2', quote: 'q2' },
          ] }
        : { verdict: 'keep' });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.map((i) => i.name)).toEqual(['A1', 'A2', 'B']);
  });

  it('cull drops the plate', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async (plate) =>
      plate.name === 'A' ? { verdict: 'cull' } : { verdict: 'keep' });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.map((i) => i.name)).toEqual(['B']);
  });

  it('caps the final list at MAX_SCENE_IMAGE_COUNT after divides', async () => {
    Planner._setScenePlatePlannerForTests(async () =>
      Array.from({ length: 15 }, (_, i) => ({ name: `n${i}`, prompt: `p${i}`, justification: '', quote: '' })));
    Planner._setScenePlateCritiqueForTests(async (plate) => ({
      verdict: 'divide',
      shots: [
        { name: `${plate.name}-x`, prompt: `${plate.prompt}-x`, justification: '', quote: '' },
        { name: `${plate.name}-y`, prompt: `${plate.prompt}-y`, justification: '', quote: '' },
      ],
    }));
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.length).toBe(Planner.MAX_SCENE_IMAGE_COUNT);
  });

  it('keeps the plate when the critique throws', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async () => { throw new Error('boom'); });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('never lets justification or quote leak into a prompt', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const { images } = await Planner.planBeatSceneImages({ beat });
    for (const im of images) {
      expect(im.prompt).not.toContain(im.justification);
      expect(im.prompt).not.toContain(im.quote);
    }
  });
});

describe('planBeatSceneImages — onProgress', () => {
  it('emits planning and per-plate critiquing events', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'A', prompt: 'a', justification: '', quote: '' },
      { name: 'B', prompt: 'b', justification: '', quote: '' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const phases = [];
    await Planner.planBeatSceneImages({ beat, onProgress: (e) => phases.push(e.phase + ':' + e.step) });
    expect(phases).toContain('planning:plan_start');
    expect(phases.filter((p) => p === 'critiquing:critique_done')).toHaveLength(2);
  });
});

describe('plate tools + system prompts', () => {
  it('exposes plan_scene_plates requiring name/prompt/justification/quote', () => {
    expect(Planner.SCENE_PLATE_PLAN_TOOL.name).toBe('plan_scene_plates');
    const item = Planner.SCENE_PLATE_PLAN_TOOL.input_schema.properties.plates.items;
    expect(item.required.sort()).toEqual(['justification', 'name', 'prompt', 'quote']);
    expect(Planner.SCENE_PLATE_PLAN_SYSTEM_PROMPT.toLowerCase()).toMatch(/background|environment|plate|location/);
  });

  it('exposes critique_scene_plate enumerating the four verdicts', () => {
    expect(Planner.SCENE_PLATE_CRITIQUE_TOOL.name).toBe('critique_scene_plate');
    expect(Planner.SCENE_PLATE_CRITIQUE_TOOL.input_schema.properties.verdict.enum.sort())
      .toEqual(['cull', 'divide', 'edit', 'keep']);
  });
});
```

- [ ] **Step 2: Run the new planner tests to verify they fail**

Run: `npx vitest run tests/beatSheetPlanner.test.js`
Expected: FAIL — e.g. `_setScenePlatePlannerForTests is not a function` / `buildScenePlatePlanUserText is not a function`.

- [ ] **Step 3: Replace `src/web/beatSheetPlanner.js`** with the two-phase implementation.

```js
// Beat scene-image planner — two-phase.
//
// Phase 1 (holistic): one Anthropic call reads the FULL beat and proposes a
// custom list of standalone SCENE / BACKGROUND / ENVIRONMENT plate images — as
// many as the text needs, no target count. Each plate carries a justification
// and a verbatim quote copied from the beat body.
//
// Phase 2 (per-plate critique): one Anthropic call per plate examines it in
// isolation and returns a verdict — keep / edit / divide / cull — to refine the
// list before it is shown for review.
//
// Plates are mostly-empty location plates (no characters), reusable later as
// storyboard backdrops. Each final entry is { name, prompt, justification, quote };
// only { name, prompt } is ever rendered — justification/quote are review aids.
//
// Two test seams let each phase be exercised without a real API call.

import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import {
  STORYBOARD_MODEL,
  buildBeatContextBlock,
} from './storyboardGenerate.js';

export const MAX_SCENE_IMAGE_COUNT = 20;
// Per-plate critique calls run in parallel, bounded to avoid hammering the API.
export const PHASE2_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Phase 1 — holistic plan
// ---------------------------------------------------------------------------

export const SCENE_PLATE_PLAN_TOOL = {
  name: 'plan_scene_plates',
  description:
    'Plan a custom set of standalone SCENE / BACKGROUND / ENVIRONMENT plate images for one screenplay beat. ' +
    'These are universal location & set plates (generally NO characters) usable later as storyboard backdrops. ' +
    'Return as many plates as the beat text genuinely needs — no fixed count.',
  input_schema: {
    type: 'object',
    properties: {
      plates: {
        type: 'array',
        description: 'The planned plates, in a sensible order (establishing wides first, then set details).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short gallery label, e.g. "Rain-slick alley — wide".' },
            prompt: {
              type: 'string',
              description:
                'Full standalone image-generation prompt for this background/scene plate: concrete location, time of day, ' +
                'lighting, palette, mood, lens/framing. Generally NO characters — an empty environment. ~2–3 sentences. ' +
                'Purely visual: do NOT include any justification or quote text here; this string is sent verbatim to the image model.',
            },
            justification: {
              type: 'string',
              description: 'One sentence: why this plate is appropriate for the beat. Reviewer-facing only — never rendered.',
            },
            quote: {
              type: 'string',
              description: 'A short VERBATIM snippet copied exactly from the beat body that this plate depicts. Reviewer-facing only — never rendered.',
            },
          },
          required: ['name', 'prompt', 'justification', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['plates'],
    additionalProperties: false,
  },
};

export const SCENE_PLATE_PLAN_SYSTEM_PROMPT = [
  'You are a production designer and location scout planning the SET and BACKGROUND plates for one screenplay beat. Return your plan via the plan_scene_plates tool.',
  '',
  '# Goal',
  '- Read the FULL beat, then produce a custom list of standalone scene / background / establishing plates that capture every distinct location, key set detail, and atmosphere the beat calls for.',
  '- Decide the number of plates from the text itself — a short beat needs few, a long or location-rich beat needs more. There is NO target count.',
  '- These are UNIVERSAL BACKDROPS, reused later as storyboard references — so prefer EMPTY or lightly-dressed environments with NO characters in frame.',
  '- Vary the scale: wide establishing shots, mid set views, and tight set-detail inserts (props, textures, signage).',
  '',
  '# For every plate',
  '- prompt: a concrete, standalone, purely-visual image prompt (location, time of day, lighting, palette, mood, lens/framing). Sent verbatim to the image model.',
  '- justification: one sentence on why this plate serves the beat. Reviewer-facing only — never rendered.',
  '- quote: a short VERBATIM snippet copied exactly from the beat body that this plate depicts. Reviewer-facing only — never rendered.',
  '',
  '# How to read the beat',
  '- Beat bodies are screenplay-format (Fountain-flavored): sluglines (INT./EXT. LOCATION — TIME) give location, time of day, and lighting; action lines give set dressing and atmosphere.',
  '- Use the supplied reference-image descriptions and the director\'s notes to lock the look (palette, era, mood). Stay consistent with them.',
  '',
  '# Constraints',
  '- No characters in the plates unless the beat truly cannot be represented without a figure — these are environments, not staged shots.',
  '- Never put a proper character name in a prompt; image models cannot resolve made-up names.',
  '- Do NOT put justification or quote text into the prompt field.',
].join('\n');

function formatReferenceInputs(referenceInputs) {
  const items = (referenceInputs || [])
    .map((r) => {
      const name = String(r?.name || '').trim();
      const desc = String(r?.description || '').trim();
      if (!name && !desc) return null;
      return `- ${name || 'image'}: ${desc || '(no description on file)'}`;
    })
    .filter(Boolean);
  if (!items.length) return null;
  return items.join('\n');
}

export function buildScenePlatePlanUserText({
  beat,
  characters = [],
  referenceInputs = [],
  direction = '',
  directorNotes = [],
} = {}) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const lines = [
    'Plan the scene/background plates for the beat below. Decide how many from the text — there is no target count.',
    '',
    ctx,
  ];
  const refBlock = formatReferenceInputs(referenceInputs);
  if (refBlock) {
    lines.push('', '# Reference images provided (their stored descriptions — design around these):', refBlock);
  }
  lines.push(
    '',
    'Use the plan_scene_plates tool. For each plate give a purely-visual prompt, a one-sentence justification, and a verbatim quote copied from the beat body.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 2 — per-plate critique
// ---------------------------------------------------------------------------

export const SCENE_PLATE_CRITIQUE_TOOL = {
  name: 'critique_scene_plate',
  description:
    'Critique ONE planned scene/background plate for a screenplay beat in detail and decide what to do with it: ' +
    'keep it as-is, edit it (refine/add detail), divide it into two plates, or cull it (drop it).',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['keep', 'edit', 'divide', 'cull'],
        description: 'keep = good as-is; edit = return an improved prompt; divide = return two plates; cull = drop it.',
      },
      prompt: { type: 'string', description: 'For verdict "edit": the improved, purely-visual prompt.' },
      name: { type: 'string', description: 'For verdict "edit": an optional improved gallery label.' },
      justification: { type: 'string', description: 'For verdict "edit": an optional updated justification.' },
      shots: {
        type: 'array',
        description: 'For verdict "divide": exactly two fully-formed plates.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string' },
            justification: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['name', 'prompt', 'justification', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdict'],
    additionalProperties: false,
  },
};

export const SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT = [
  'You are a meticulous storyboard supervisor reviewing ONE proposed scene/background plate for a screenplay beat. Return your decision via the critique_scene_plate tool.',
  '',
  'Examine the single plate in detail against the beat and choose exactly one verdict:',
  '- keep: the plate is already a strong, distinct, purely-visual environment plate. Return it untouched.',
  '- edit: worth keeping but the prompt is vague, generic, or missing concrete visual detail. Return an improved, purely-visual prompt.',
  '- divide: the plate is really two distinct plates (two locations, or a wide AND a detail insert). Return exactly two fully-formed plates.',
  '- cull: redundant with the beat\'s needs, off-topic, requires characters to read, or otherwise should not be generated. Drop it.',
  '',
  'Rules: prompts stay purely visual (no characters unless unavoidable, no proper names, no caption/quote text). Prefer keep/edit over divide; only divide when genuinely two shots. Only cull when the plate adds no value.',
].join('\n');

export function buildScenePlateCritiqueUserText({ beat, characters = [], direction = '', directorNotes = [], plate } = {}) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  return [
    'Critique this single proposed plate for the beat below.',
    '',
    '# The plate',
    `- name: ${plate?.name || ''}`,
    `- prompt: ${plate?.prompt || ''}`,
    `- justification: ${plate?.justification || ''}`,
    `- quote: ${plate?.quote || ''}`,
    '',
    ctx,
    '',
    'Use the critique_scene_plate tool with exactly one verdict.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Normalize + helpers
// ---------------------------------------------------------------------------

// Drop entries missing name/prompt, trim, carry justification/quote, clamp to max.
export function normalizeScenePlanImages(rawImages, { max = MAX_SCENE_IMAGE_COUNT } = {}) {
  if (!Array.isArray(rawImages)) return [];
  const out = [];
  for (const it of rawImages) {
    const name = typeof it?.name === 'string' ? it.name.trim() : '';
    const prompt = typeof it?.prompt === 'string' ? it.prompt.trim() : '';
    if (!name || !prompt) continue;
    const justification = typeof it?.justification === 'string' ? it.justification.trim() : '';
    const quote = typeof it?.quote === 'string' ? it.quote.trim() : '';
    out.push({ name, prompt, justification, quote });
    if (out.length >= max) break;
  }
  return out;
}

function normalizeWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Best-effort: warn (never reject) if a plate's quote is not a whitespace-
// normalized substring of the beat body. Quotes are reviewer aids only.
function warnNonVerbatimQuotes(images, beat) {
  const body = normalizeWs(beat?.body);
  if (!body) return;
  for (const im of images) {
    const q = normalizeWs(im.quote);
    if (q && !body.includes(q)) {
      logger.warn(`beat plate planner: quote not verbatim in beat body: "${(im.quote || '').slice(0, 60)}"`);
    }
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runNext = async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// Apply a single critique verdict to a plate, returning 0, 1, or 2 plates.
function applyVerdict(plate, verdict) {
  const v = verdict || { verdict: 'keep' };
  switch (v.verdict) {
    case 'cull':
      return [];
    case 'edit':
      return [{
        name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : plate.name,
        prompt: typeof v.prompt === 'string' && v.prompt.trim() ? v.prompt.trim() : plate.prompt,
        justification: typeof v.justification === 'string' && v.justification.trim() ? v.justification.trim() : plate.justification,
        quote: plate.quote,
      }];
    case 'divide':
      if (Array.isArray(v.shots) && v.shots.length) {
        const split = v.shots
          .map((s) => ({
            name: typeof s?.name === 'string' ? s.name.trim() : '',
            prompt: typeof s?.prompt === 'string' ? s.prompt.trim() : '',
            justification: typeof s?.justification === 'string' ? s.justification.trim() : '',
            quote: typeof s?.quote === 'string' && s.quote.trim() ? s.quote.trim() : plate.quote,
          }))
          .filter((s) => s.name && s.prompt);
        return split.length ? split : [plate];
      }
      return [plate];
    case 'keep':
    default:
      return [plate];
  }
}

// ---------------------------------------------------------------------------
// Anthropic calls + test seams
// ---------------------------------------------------------------------------

let phase1Override = null;
let phase2Override = null;
// Phase-1 seam: receives the phase-1 args, returns a raw plate array.
export function _setScenePlatePlannerForTests(fn) { phase1Override = fn; }
// Phase-2 seam: receives (plate, ctx), returns a verdict object.
export function _setScenePlateCritiqueForTests(fn) { phase2Override = fn; }

async function callPhase1Anthropic(args) {
  const userText = buildScenePlatePlanUserText(args);
  const client = getAnthropic();
  const resp = await client.messages
    .stream({
      model: STORYBOARD_MODEL,
      max_tokens: 8000,
      system: SCENE_PLATE_PLAN_SYSTEM_PROMPT,
      tools: [SCENE_PLATE_PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'plan_scene_plates' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    })
    .finalMessage();
  if (resp.stop_reason === 'max_tokens') {
    logger.warn(`beat plate planner (phase 1): hit max_tokens cap (model=${STORYBOARD_MODEL}); response may be truncated`);
  }
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'plan_scene_plates');
  if (!toolUse) {
    logger.warn(`beat plate planner (phase 1): model did not call the tool (stop_reason=${resp.stop_reason})`);
    return [];
  }
  return Array.isArray(toolUse.input?.plates) ? toolUse.input.plates : [];
}

async function callPhase2Anthropic({ beat, characters, direction, directorNotes, plate }) {
  const userText = buildScenePlateCritiqueUserText({ beat, characters, direction, directorNotes, plate });
  const client = getAnthropic();
  const resp = await client.messages
    .stream({
      model: STORYBOARD_MODEL,
      max_tokens: 2000,
      system: SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT,
      tools: [SCENE_PLATE_CRITIQUE_TOOL],
      tool_choice: { type: 'tool', name: 'critique_scene_plate' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    })
    .finalMessage();
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'critique_scene_plate');
  if (!toolUse) {
    logger.warn(`beat plate critique (phase 2): model did not call the tool (stop_reason=${resp.stop_reason}); keeping plate`);
    return { verdict: 'keep' };
  }
  return toolUse.input || { verdict: 'keep' };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Plan the plate list for a beat in two phases. Returns
// { images: [{ name, prompt, justification, quote }, ...] }.
// onProgress(evt) receives { phase, step, frame?, total?, message } events.
export async function planBeatSceneImages({
  beat,
  characters = [],
  referenceInputs = [],
  direction = '',
  directorNotes = [],
  onProgress = null,
} = {}) {
  const emit = (e) => { try { onProgress?.(e); } catch { /* progress is best-effort */ } };

  // Phase 1 — holistic plan.
  emit({ phase: 'planning', step: 'plan_start', message: 'Planning scene plates…' });
  const phase1Args = { beat, characters, referenceInputs, direction, directorNotes };
  let rawPlates;
  if (phase1Override) {
    const r = await phase1Override(phase1Args);
    rawPlates = Array.isArray(r) ? r : (r?.plates ?? r?.images ?? []);
  } else {
    rawPlates = await callPhase1Anthropic(phase1Args);
  }
  const planned = normalizeScenePlanImages(rawPlates, { max: MAX_SCENE_IMAGE_COUNT });
  emit({ phase: 'planning', step: 'plan_done', total: planned.length, message: `Planned ${planned.length} plate${planned.length === 1 ? '' : 's'}; critiquing…` });
  if (!planned.length) return { images: [] };

  // Phase 2 — per-plate critique.
  emit({ phase: 'critiquing', step: 'critique_start', total: planned.length, message: `Critiquing ${planned.length} plate${planned.length === 1 ? '' : 's'}…` });
  let done = 0;
  const verdicts = await mapWithConcurrency(planned, PHASE2_CONCURRENCY, async (plate) => {
    let verdict;
    try {
      verdict = phase2Override
        ? await phase2Override(plate, { beat, characters, direction, directorNotes })
        : await callPhase2Anthropic({ beat, characters, direction, directorNotes, plate });
    } catch (e) {
      logger.warn(`beat plate critique failed; keeping plate: ${e.message}`);
      verdict = { verdict: 'keep' };
    }
    done += 1;
    emit({ phase: 'critiquing', step: 'critique_done', frame: done, total: planned.length, message: `Critiqued ${done}/${planned.length}…` });
    return verdict;
  });

  const expanded = [];
  for (let i = 0; i < planned.length; i += 1) {
    expanded.push(...applyVerdict(planned[i], verdicts[i]));
  }
  const images = normalizeScenePlanImages(expanded, { max: MAX_SCENE_IMAGE_COUNT });
  warnNonVerbatimQuotes(images, beat);
  emit({ phase: 'critiquing', step: 'critique_complete', total: images.length, message: `${images.length} plate${images.length === 1 ? '' : 's'} ready for review.` });
  return { images };
}
```

- [ ] **Step 4: Run the planner tests to verify they pass**

Run: `npx vitest run tests/beatSheetPlanner.test.js`
Expected: PASS (all describes green).

- [ ] **Step 5: Update the planner seam usage in the two dependent test files** (the job/route CODE is untouched in this task; only the seam calls change so the suite stays green).

In `tests/imageSheetJobs.test.js`:

Replace the `beforeEach` reset line `Planner._setSceneImagePlannerForTests(null);` with:

```js
  Planner._setScenePlatePlannerForTests(null);
  Planner._setScenePlateCritiqueForTests(null);
```

In the test `'plans then renders one done artwork per planned image'`, replace the `Planner._setSceneImagePlannerForTests(async () => ({ images: [...] }));` block with:

```js
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Alley — wide', prompt: 'wide empty rain-slick alley at dusk', justification: 'establishes the location', quote: 'INT. ALLEY - NIGHT' },
      { name: 'Brick — insert', prompt: 'tight insert of wet brick texture', justification: 'set detail', quote: 'INT. ALLEY - NIGHT' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
```

In the test `'finishes "done" with no artworks when the planner returns nothing'`, replace `Planner._setSceneImagePlannerForTests(async () => ({ images: [] }));` with:

```js
    Planner._setScenePlatePlannerForTests(async () => []);
```

In `tests/imageSheetRoutes.test.js`, replace the `beforeEach` line `Planner._setSceneImagePlannerForTests(async () => ({ images: [{ name: 'Plate', prompt: 'wide empty set' }] }));` with:

```js
  Planner._setScenePlatePlannerForTests(async () => ([{ name: 'Plate', prompt: 'wide empty set', justification: 'establishes', quote: 'INT. SET' }]));
  Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
```

- [ ] **Step 6: Run the three affected suites to verify the whole set is green**

Run: `npx vitest run tests/beatSheetPlanner.test.js tests/imageSheetJobs.test.js tests/imageSheetRoutes.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/beatSheetPlanner.js tests/beatSheetPlanner.test.js tests/imageSheetJobs.test.js tests/imageSheetRoutes.test.js
git commit -m "✨ Two-phase beat plate planner (plan + per-plate critique)" -m "Claude-Session: https://claude.ai/code/session_01LPebMckxrXoF9uJsQeYcJi"
```

---

## Task 2: Derive job + `POST /beat/:id/shot-plan` (additive)

**Files:**
- Modify: `src/web/imageSheetJobs.js`
- Modify: `src/web/entityRoutes.js:2581-2613` (add a sibling route inside `registerArtworkRoutes`)
- Modify: `tests/imageSheetJobs.test.js` (add a derive-job describe block + a `waitForStatus` helper)
- Modify: `tests/imageSheetRoutes.test.js` (add a shot-plan route describe block)

**Interfaces:**
- Produces: `startShotPlanJob({ projectId, hostId, referenceImageIds?, direction? }) → Promise<{ job_id }>`. Creates an in-memory job (`kind:'beat_plan'`) that runs `planBeatSceneImages` with `onProgress` wired to `recordProgress`, then parks at `status:'derived'` with `job.shots = [{name,prompt,justification,quote}]` and `job.planned = shots.length`. Synchronously throws `httpError(...,400)` if `ANTHROPIC_API_KEY` is missing and `httpError(...,404)` if the beat is absent.
- Consumes: `planBeatSceneImages` (Task 1), existing `getBeat`, `findCharactersInBeat`, `loadDirectorNotesForPlanner`, the module-local `loadReferenceInputs`, `STORYBOARD_MODEL`, `config`, `recordProgress`, `httpError`, `makeJobId`, `jobs` (all already in `imageSheetJobs.js`).
- Route consumes: `resolveHostId`, `validateArtworkRefs`, `webDiscordUser`, `req.projectId` (already in scope inside `registerArtworkRoutes`).

- [ ] **Step 1: Add the derive-job tests** to `tests/imageSheetJobs.test.js`.

Add this `waitForStatus` helper just below the existing `waitForJob` function:

```js
async function waitForStatus(jobId, statuses, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Sheet.getImageSheetJob(jobId);
    if (job && statuses.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job did not reach ${statuses.join('/')} in time`);
}
```

Add this describe block after the `'startImageSheetJob — beat (dynamic planner)'` block:

```js
describe('startShotPlanJob — derive', () => {
  it('runs the two-phase planner and parks at "derived" with job.shots', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Alley — wide', prompt: 'wide empty alley', justification: 'establishes', quote: 'INT. ALLEY - NIGHT' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const beat = await Plots.createBeat({ projectId, name: 'Alley', body: 'INT. ALLEY - NIGHT' });
    const { job_id } = await Sheet.startShotPlanJob({
      projectId,
      hostId: beat._id.toString(),
      referenceImageIds: [],
    });
    expect(job_id).toBeTruthy();
    const job = await waitForStatus(job_id, ['derived', 'error']);
    expect(job.status).toBe('derived');
    expect(job.kind).toBe('beat_plan');
    expect(job.planned).toBe(1);
    expect(job.shots).toEqual([
      { name: 'Alley — wide', prompt: 'wide empty alley', justification: 'establishes', quote: 'INT. ALLEY - NIGHT' },
    ]);
  });

  it('rejects a missing beat with status 404', async () => {
    await expect(
      Sheet.startShotPlanJob({ projectId, hostId: new ObjectId().toString(), referenceImageIds: [] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('does NOT create any artworks (derive renders nothing)', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'A', prompt: 'a', justification: '', quote: '' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const beat = await Plots.createBeat({ projectId, name: 'NoArt', body: 'INT. X' });
    const { job_id } = await Sheet.startShotPlanJob({ projectId, hostId: beat._id.toString(), referenceImageIds: [] });
    await waitForStatus(job_id, ['derived', 'error']);
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.artworks || []).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run tests/imageSheetJobs.test.js -t "startShotPlanJob"`
Expected: FAIL — `Sheet.startShotPlanJob is not a function`.

- [ ] **Step 3: Implement `startShotPlanJob` + `runShotPlanJob`** in `src/web/imageSheetJobs.js`.

Add this block immediately before the existing `export async function startImageSheetJob({` (around line 283):

```js
// Run the two-phase derivation for a beat and park the result on the job for
// review. Renders NOTHING — the SPA polls GET /image-sheet/:jobId, reads
// job.shots once status === 'derived', lets the user edit, then POSTs the
// reviewed list back to /image-sheet. No busyHosts lock: deriving has no side
// effects.
async function runShotPlanJob({ projectId, job, hostId, referenceImageIds, direction }) {
  try {
    job.status = 'planning';
    const beat = await getBeat(projectId, hostId);
    if (!beat) throw new Error(`beat not found: ${hostId}`);
    const characters = await findCharactersInBeat(projectId, beat);
    const directorNotes = await loadDirectorNotesForPlanner(projectId);
    const referenceInputs = await loadReferenceInputs(referenceImageIds);
    const { images } = await planBeatSceneImages({
      beat,
      characters,
      referenceInputs,
      direction,
      directorNotes,
      onProgress: (e) => recordProgress(job, e),
    });
    job.shots = images;
    job.planned = images.length;
    job.status = 'derived';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'derived',
      step: 'derive_done',
      total: images.length,
      message: `Derived ${images.length} plate${images.length === 1 ? '' : 's'} — review and generate.`,
    });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'derive_crashed', message: `Derivation failed: ${e.message}` });
    logger.error(`shot-plan job ${job.job_id} crashed: ${e.message}`);
  }
}

// Start a background plate-derivation job for a beat. Returns { job_id }
// immediately (HTTP 202). Throws an error carrying `.status` for not-found /
// config conditions (surfaced before the job is created).
export async function startShotPlanJob({
  projectId,
  hostId,
  referenceImageIds = [],
  direction = '',
}) {
  if (!config.anthropic?.apiKey) {
    throw httpError('ANTHROPIC_API_KEY is not configured (required to derive beat plates).', 400);
  }
  const beat = await getBeat(projectId, String(hostId));
  if (!beat) throw httpError(`beat not found: ${hostId}`, 404);
  const resolvedHostId = beat._id.toString();

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    host_type: 'beat',
    host_id: resolvedHostId,
    project_id: projectId,
    kind: 'beat_plan',
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planner_model: STORYBOARD_MODEL,
    reference_image_ids: (referenceImageIds || []).map(String),
    planned: 0,
    completed: 0,
    failed: 0,
    progress: null,
    events: [],
    shots: null,
  };
  jobs.set(jobId, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued', message: 'Queued plate derivation…' });

  setImmediate(() => {
    runShotPlanJob({ projectId, job, hostId: resolvedHostId, referenceImageIds, direction })
      .catch((e) => {
        job.status = 'error';
        job.error = e.message;
        job.finished_at = new Date();
        logger.error(`shot-plan job ${jobId} crashed (outer): ${e.message}`);
      });
  });

  return { job_id: jobId };
}
```

- [ ] **Step 4: Run the derive-job tests to verify they pass**

Run: `npx vitest run tests/imageSheetJobs.test.js -t "startShotPlanJob"`
Expected: PASS.

- [ ] **Step 5: Add the shot-plan route tests** to `tests/imageSheetRoutes.test.js`.

Add this describe block after the `'POST /api/:host/:id/image-sheet'` block:

```js
describe('POST /api/beat/:id/shot-plan', () => {
  it('starts a derive job and the poll reaches "derived" with shots', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Alley', body: 'INT. ALLEY - NIGHT' });
    const { status, json } = await postJson(`/api/beat/${beat._id.toString()}/shot-plan`, {
      reference_image_ids: [],
    });
    expect(status).toBe(202);
    expect(json.job_id).toBeTruthy();

    let job = null;
    const start = Date.now();
    while (Date.now() - start < 4000) {
      const r = await getJson(`/api/image-sheet/${json.job_id}`);
      job = r.json.job;
      if (job && ['derived', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job.status).toBe('derived');
    expect(job.kind).toBe('beat_plan');
    expect(Array.isArray(job.shots)).toBe(true);
    expect(job.shots[0].name).toBe('Plate');
  });

  it('404s on a missing beat', async () => {
    const { status } = await postJson(`/api/beat/${new ObjectId().toString()}/shot-plan`, {});
    expect(status).toBe(404);
  });
});
```

- [ ] **Step 6: Run the route tests to verify they fail**

Run: `npx vitest run tests/imageSheetRoutes.test.js -t "shot-plan"`
Expected: FAIL — the POST returns 404 (route not registered) so the poll never reaches `derived`.

- [ ] **Step 7: Register the `shot-plan` route** in `src/web/entityRoutes.js`.

Immediately after the closing `});` of the `router.post(`${basePath}/:id/image-sheet`, ...)` handler (currently line 2613) and before the closing `}` of `registerArtworkRoutes`, insert:

```js
    // POST /beat/:id/shot-plan — start a two-phase plate DERIVATION job (beats
    // only). Renders nothing; returns 202 + { job_id }. The SPA polls
    // GET /image-sheet/:jobId until status==='derived', shows job.shots for
    // review, then POSTs the reviewed list to /beat/:id/image-sheet.
    if (hostType === 'beat') {
      router.post(`${basePath}/:id/shot-plan`, async (req, res, next) => {
        try {
          const hostId = await resolveHostId(req);
          if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
          const refs = await validateArtworkRefs(req, res);
          if (!refs) return;
          const direction = String(req.body?.direction || '').slice(0, 4000);
          const { startShotPlanJob } = await import('./imageSheetJobs.js');
          const result = await startShotPlanJob({
            projectId: req.projectId,
            hostId,
            referenceImageIds: refs.ids,
            direction,
          });
          res.status(202).json(result);
        } catch (e) {
          handleArtworkError(e, res, next);
        }
      });
    }
```

- [ ] **Step 8: Run the route tests to verify they pass**

Run: `npx vitest run tests/imageSheetRoutes.test.js -t "shot-plan"`
Expected: PASS.

- [ ] **Step 9: Run both affected suites in full to confirm no regressions**

Run: `npx vitest run tests/imageSheetJobs.test.js tests/imageSheetRoutes.test.js`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/web/imageSheetJobs.js src/web/entityRoutes.js tests/imageSheetJobs.test.js tests/imageSheetRoutes.test.js
git commit -m "✨ Add beat plate derive job + POST /beat/:id/shot-plan" -m "Claude-Session: https://claude.ai/code/session_01LPebMckxrXoF9uJsQeYcJi"
```

---

## Task 3: Render an explicit shot list (beats require it)

This is the atomic contract flip: the engine + route + their beat tests change together so the suite stays green.

**Files:**
- Modify: `src/web/imageSheetJobs.js`
- Modify: `src/web/entityRoutes.js:2581-2613` (the `image-sheet` POST handler)
- Modify: `tests/imageSheetJobs.test.js` (replace the `'startImageSheetJob — beat (dynamic planner)'` block)
- Modify: `tests/imageSheetRoutes.test.js` (replace the beat `image-sheet` test + add validation tests)

**Interfaces:**
- `startImageSheetJob({ projectId, hostType, hostId, model, referenceImageIds?, shotNames?, shotCount?, shots?, discordUser?, announceUsername? })` — for `hostType:'beat'`, `shots` is REQUIRED (`[{name,prompt}]`); a missing/empty list throws `httpError(...,400)`. Returns `{ job_id, planned, host_type, host_id }` where `planned = shots.length` for beats. Characters are unchanged (plan their fixed preset).
- `planShots(...)` is now **character-only**; beats never plan inside the render job.

- [ ] **Step 1: Replace the beat job tests** in `tests/imageSheetJobs.test.js`.

Replace the entire `describe('startImageSheetJob — beat (dynamic planner)', () => { ... });` block with:

```js
describe('startImageSheetJob — beat (explicit shots)', () => {
  it('renders one done artwork per explicit shot WITHOUT calling the planner', async () => {
    let planCalls = 0;
    Planner._setScenePlatePlannerForTests(async () => { planCalls += 1; return []; });
    const beat = await Plots.createBeat({ projectId, name: 'The Alley', desc: 'x', body: 'INT. ALLEY - NIGHT' });
    const { job_id, planned } = await Sheet.startImageSheetJob({
      projectId,
      hostType: 'beat',
      hostId: beat._id.toString(),
      model: 'nano-banana-pro',
      referenceImageIds: [],
      shots: [
        { name: 'Alley — wide', prompt: 'wide empty rain-slick alley at dusk' },
        { name: 'Brick — insert', prompt: 'tight insert of wet brick texture' },
      ],
    });
    expect(planned).toBe(2);
    const job = await waitForJob(job_id);
    expect(job.status).toBe('done');
    expect(job.planned).toBe(2);
    expect(job.completed).toBe(2);
    expect(planCalls).toBe(0);

    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.artworks).toHaveLength(2);
    expect(fresh.artworks.map((a) => a.name).sort()).toEqual(['Alley — wide', 'Brick — insert']);
    for (const a of fresh.artworks) {
      expect(a.status).toBe('done');
      expect(a.prompt.length).toBeGreaterThan(0);
    }
  });

  it('rejects a beat with no shots (status 400)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'NoShots', body: 'INT. X' });
    await expect(
      Sheet.startImageSheetJob({ projectId, hostType: 'beat', hostId: beat._id.toString(), model: 'nano-banana-pro' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a beat with an empty/invalid shots list (status 400)', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Empty', body: 'INT. X' });
    await expect(
      Sheet.startImageSheetJob({
        projectId, hostType: 'beat', hostId: beat._id.toString(), model: 'nano-banana-pro',
        shots: [{ name: '', prompt: '' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('clamps an over-long explicit shot list to MAX_SCENE_IMAGE_COUNT', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Many', body: 'INT. X' });
    const shots = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, prompt: `p${i}` }));
    const { job_id, planned } = await Sheet.startImageSheetJob({
      projectId, hostType: 'beat', hostId: beat._id.toString(), model: 'nano-banana-pro', shots,
    });
    expect(planned).toBe(Planner.MAX_SCENE_IMAGE_COUNT);
    await waitForJob(job_id);
  });
});
```

- [ ] **Step 2: Run the beat job tests to verify they fail**

Run: `npx vitest run tests/imageSheetJobs.test.js -t "explicit shots"`
Expected: FAIL — `planned` is `null`/`0` (the engine ignores `shots` and still plans), and the 400 cases resolve instead of rejecting.

- [ ] **Step 3: Generalize the engine** in `src/web/imageSheetJobs.js`.

3a. Extend the planner import (line 37):

```js
import { planBeatSceneImages, MAX_SCENE_IMAGE_COUNT } from './beatSheetPlanner.js';
```

3b. Add a normalizer just below the `runPool` function (after line 158):

```js
// Trim/validate a client-supplied explicit shot list (beats). Returns an array
// of { name, prompt } (blanks dropped, lengths clamped, capped at the max), or
// null if `shots` is not an array.
function normalizeExplicitShots(shots, { max = MAX_SCENE_IMAGE_COUNT } = {}) {
  if (!Array.isArray(shots)) return null;
  const out = [];
  for (const s of shots) {
    const name = typeof s?.name === 'string' ? s.name.trim().slice(0, 200) : '';
    const prompt = typeof s?.prompt === 'string' ? s.prompt.trim().slice(0, 2000) : '';
    if (!name || !prompt) continue;
    out.push({ name, prompt });
    if (out.length >= max) break;
  }
  return out;
}
```

3c. Reduce `planShots` to character-only. Replace the whole function (lines 120-145) with:

```js
// Plan the shot list for a CHARACTER (fixed preset). Beats are rendered from an
// explicit, pre-derived list passed straight to runSheetJob, so they never
// reach here.
async function planShots({ projectId, hostId, shotNames, shotCount }) {
  const character = await getCharacter(projectId, hostId);
  if (!character) throw new Error(`character not found: ${hostId}`);
  const directorNotes = await loadDirectorNotesForPlanner(projectId);
  return buildCharacterSheetShots({ character, directorNotes, shotNames, shotCount });
}
```

3d. Update `runSheetJob` to prefer the explicit list. Change its signature and first statement. Replace the signature line (line 241):

```js
async function runSheetJob({ projectId, job, hostType, hostId, model, referenceImageIds, shotNames, shotCount, explicitShots, discordUser, announceUsername }) {
```

and replace the first body line (line 243):

```js
    const shots = explicitShots ?? await planShots({ projectId, hostId, shotNames, shotCount });
```

3e. Update `startImageSheetJob`. Add `shots` to the destructured params (after `shotCount,` on line 290):

```js
  shots,
```

Then, right after the `const resolvedHostId = await loadHostId(projectId, hostType, hostId);` line (line 298), insert the beat requirement:

```js

  // Beats render an explicit, pre-derived shot list (the derive→review→generate
  // flow); characters plan their fixed preset.
  let explicitShots = null;
  if (hostType === 'beat') {
    explicitShots = normalizeExplicitShots(shots);
    if (!explicitShots || !explicitShots.length) {
      throw httpError('A beat image sheet needs a derived shot list (shots[]).', 400);
    }
  }
```

Change the `planner_model` line (line 318) to:

```js
    planner_model: null,
```

Change the `planned:` line (line 320) to:

```js
    planned: hostType === 'character' ? selectSheetShots({ shotNames, shotCount }).length : explicitShots.length,
```

Add a `shots` field to the job object (insert after the `planned:` line):

```js
    shots: explicitShots,
```

Update the `setImmediate` runSheetJob call (line 332) to pass `explicitShots` instead of `shotCount, direction` for the render (keep `shotNames`/`shotCount` for the character planner):

```js
    runSheetJob({ projectId, job, hostType, hostId: resolvedHostId, model, referenceImageIds, shotNames, shotCount, explicitShots, discordUser, announceUsername })
```

Update the return `planned` (line 344) to:

```js
    planned: hostType === 'character' ? job.planned : explicitShots.length,
```

- [ ] **Step 4: Run the beat job tests to verify they pass**

Run: `npx vitest run tests/imageSheetJobs.test.js`
Expected: PASS (the full file — character tests and the new beat block).

- [ ] **Step 5: Replace the beat route test** in `tests/imageSheetRoutes.test.js`.

Replace the test `'starts a beat sheet job and returns 202 (planned unknown until planned)'` with:

```js
  it('renders an explicit beat shot list and returns 202 with the planned count', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Alley', body: 'INT. ALLEY - NIGHT' });
    const { status, json } = await postJson(`/api/beat/${beat._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
      shots: [
        { name: 'Alley — wide', prompt: 'wide empty rain-slick alley' },
        { name: 'Brick — insert', prompt: 'wet brick texture' },
      ],
    });
    expect(status).toBe(202);
    expect(json.job_id).toBeTruthy();
    expect(json.planned).toBe(2);
    expect(json.host_type).toBe('beat');
    await drain(json.job_id);
  });

  it('400s a beat image-sheet with no shots', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'NoShots', body: 'INT. X' });
    const { status } = await postJson(`/api/beat/${beat._id.toString()}/image-sheet`, {
      model: 'nano-banana-pro',
    });
    expect(status).toBe(400);
  });
```

- [ ] **Step 6: Run the route test to verify it fails**

Run: `npx vitest run tests/imageSheetRoutes.test.js -t "explicit beat shot list"`
Expected: FAIL — the route ignores `shots` and returns `planned: null`.

- [ ] **Step 7: Pass `shots` through the route** in `src/web/entityRoutes.js`.

In the `image-sheet` POST handler, after the `shotNames` parse (line 2592-2594), add:

```js
        const shots = Array.isArray(req.body?.shots) ? req.body.shots : undefined;
```

and add `shots,` to the `startImageSheetJob({ ... })` call (right after `shotCount,`):

```js
          shots,
```

- [ ] **Step 8: Run the route tests to verify they pass**

Run: `npx vitest run tests/imageSheetRoutes.test.js`
Expected: PASS.

- [ ] **Step 9: Run the full backend suite (the deploy gate)**

Run: `npm test`
Expected: PASS — no regressions anywhere (planner, jobs, routes, tools-schema, etc.).

- [ ] **Step 10: Commit**

```bash
git add src/web/imageSheetJobs.js src/web/entityRoutes.js tests/imageSheetJobs.test.js tests/imageSheetRoutes.test.js
git commit -m "✨ Render beat image sheets from an explicit derived shot list" -m "Claude-Session: https://claude.ai/code/session_01LPebMckxrXoF9uJsQeYcJi"
```

---

## Task 4: Dialog wizard (frontend)

No frontend test runner exists, so this task verifies with `npm run build:web` (must compile) plus the manual smoke checklist at the end. The character branch is preserved exactly; only the beat branch becomes a wizard.

**Files:**
- Rewrite: `web/src/widgets/ImageSheetDialog.jsx`
- Modify: `web/src/styles.css` (append review-card styles)
- Verify only: `web/src/widgets/ArtworkTab.jsx` (no change expected)

**Interfaces:**
- Consumes: `POST /api/beat/:id/shot-plan` → `{ job_id }`; `GET /api/image-sheet/:jobId` → `{ job }` with `job.status` reaching `'derived'` and `job.shots = [{name,prompt,justification,quote}]`; `POST /api/beat/:id/image-sheet` with `{ reference_image_ids, model, shots:[{name,prompt}] }` → `{ job_id, planned }`.
- Produces: unchanged `onStarted({ jobId, planned })` callback into `ArtworkTab.startSheetJob` (fired only on Generate, with the RENDER job id).

- [ ] **Step 1: Replace `web/src/widgets/ImageSheetDialog.jsx`** with the wizard.

```jsx
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { GenerationProgress } from './GenerationProgress.jsx';
import { apiGet, apiPostJson, imageUrl, thumbUrl } from '../api.js';
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.imagesheet.model';

// "Create image sheet" dialog for the Artwork tab on characters AND beats.
// Characters: pick which fixed shots to generate from a checklist, then start a
// background job immediately.
// Beats: a wizard — Derive (a 2-phase LLM pass reads the beat and proposes
// scene/background plates, each with a justification + verbatim script quote) →
// Review (edit / remove / add the plates) → Generate sheet (renders the reviewed
// list through the same background job). justification/quote are review-only and
// are NOT sent to the image model.
export function ImageSheetDialog({
  open,
  onClose,
  onStarted,
  hostType,
  hostId,
  hostLabel,
  hostImages = [],
  hostArtworks = [],
}) {
  const isCharacter = hostType === 'character';
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Character: the fixed shot list + which are checked.
  const [shots, setShots] = useState([]);
  const [selectedShots, setSelectedShots] = useState([]);
  // Beat wizard: 'setup' → 'deriving' → 'review'.
  const [stage, setStage] = useState('setup');
  const [derivedShots, setDerivedShots] = useState([]); // [{ key, name, prompt, justification, quote }]
  const [deriveJob, setDeriveJob] = useState(null);
  const [showDeriveLog, setShowDeriveLog] = useState(false);
  const [editedSinceDerive, setEditedSinceDerive] = useState(false);
  const openSeqRef = useRef(0);
  const derivePollRef = useRef(null);
  const deriveLogRef = useRef(null);
  const keyRef = useRef(0);

  const basePath = `/${hostType}/${hostId}`;

  function stopDerivePoll() {
    if (derivePollRef.current) {
      clearInterval(derivePollRef.current);
      derivePollRef.current = null;
    }
  }

  // Reset on open/close. Closing bumps the seq so any in-flight async bails.
  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      stopDerivePoll();
      return;
    }
    setError(null);
    setBusy(false);
    setReferenceIds([]);
    setStage('setup');
    setDerivedShots([]);
    setDeriveJob(null);
    setShowDeriveLog(false);
    setEditedSinceDerive(false);
  }, [open]);

  useEffect(() => () => stopDerivePoll(), []);

  // Character shot list loads when the dialog opens for a character.
  useEffect(() => {
    if (!open || !isCharacter) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/character-sheet-shots');
        if (cancelled) return;
        const list = Array.isArray(r?.shots) ? r.shots : [];
        setShots(list);
        setSelectedShots(list.map((s) => s.name));
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Could not load the shot list');
      }
    })();
    return () => { cancelled = true; };
  }, [open, isCharacter]);

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }

  function toggleShot(name) {
    setSelectedShots((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  function nextKey() {
    keyRef.current += 1;
    return `s${keyRef.current}`;
  }

  // ---- Character: start the render job immediately. ------------------------
  async function submitCharacter() {
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/image-sheet`, {
        reference_image_ids: referenceIds,
        model: imageModel,
        shot_names: selectedShots,
      });
      if (seq !== openSeqRef.current) return;
      onStarted?.({ jobId: res.job_id, planned: res.planned ?? null });
      onClose?.();
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start image sheet');
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  // ---- Beat: derive (2-phase) → poll → review. ----------------------------
  async function pollDerive(jobId, seq) {
    if (seq !== openSeqRef.current) { stopDerivePoll(); return; }
    try {
      const r = await apiGet(`/image-sheet/${jobId}`);
      const job = r?.job ?? r;
      if (seq !== openSeqRef.current) { stopDerivePoll(); return; }
      setDeriveJob(job);
      if (job?.status === 'derived') {
        stopDerivePoll();
        const list = Array.isArray(job.shots) ? job.shots : [];
        setDerivedShots(list.map((s) => ({
          key: nextKey(),
          name: s.name || '',
          prompt: s.prompt || '',
          justification: s.justification || '',
          quote: s.quote || '',
        })));
        setEditedSinceDerive(false);
        setStage('review');
        setBusy(false);
      } else if (job?.status === 'error') {
        stopDerivePoll();
        setError(job.error || 'Derivation failed.');
        setStage('setup');
        setBusy(false);
      }
    } catch {
      // transient poll error — keep polling (the job runs server-side).
    }
  }

  async function derive() {
    setBusy(true);
    setError(null);
    setStage('deriving');
    setDeriveJob({ status: 'queued', started_at: new Date().toISOString(), events: [] });
    setShowDeriveLog(true);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/shot-plan`, { reference_image_ids: referenceIds });
      if (seq !== openSeqRef.current) return;
      stopDerivePoll();
      derivePollRef.current = setInterval(() => pollDerive(res.job_id, seq), 2000);
      pollDerive(res.job_id, seq);
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start derivation');
      setStage('setup');
      setBusy(false);
    }
  }

  function reDerive() {
    if (editedSinceDerive && !confirm('Re-derive will discard your edits to the shot list. Continue?')) return;
    setDerivedShots([]);
    derive();
  }

  function updateShot(key, field, value) {
    setEditedSinceDerive(true);
    setDerivedShots((prev) => prev.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  }

  function removeShot(key) {
    setEditedSinceDerive(true);
    setDerivedShots((prev) => prev.filter((s) => s.key !== key));
  }

  function addShot() {
    setEditedSinceDerive(true);
    setDerivedShots((prev) => [...prev, { key: nextKey(), name: 'New plate', prompt: '', justification: '', quote: '' }]);
  }

  async function generateSheet() {
    const ready = derivedShots
      .map((s) => ({ name: s.name.trim(), prompt: s.prompt.trim() }))
      .filter((s) => s.name && s.prompt);
    if (!ready.length) {
      setError('Add at least one plate with a name and a prompt.');
      return;
    }
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/image-sheet`, {
        reference_image_ids: referenceIds,
        model: imageModel,
        shots: ready,
      });
      if (seq !== openSeqRef.current) return;
      onStarted?.({ jobId: res.job_id, planned: res.planned ?? ready.length });
      onClose?.();
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start image sheet');
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  // ---- Footer (varies by host type + beat stage). -------------------------
  const charCanSubmit = selectedShots.length >= 1 && IMAGE_MODEL_IDS.has(imageModel) && !busy;
  const reviewReady = derivedShots.some((s) => s.name.trim() && s.prompt.trim());

  let footer;
  if (isCharacter) {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary" onClick={submitCharacter} disabled={!charCanSubmit}>
          {busy ? 'Starting…' : `Generate ${selectedShots.length} image${selectedShots.length === 1 ? '' : 's'}`}
        </button>
      </>
    );
  } else if (stage === 'review') {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" onClick={reDerive} disabled={busy}>Re-derive</button>
        <button
          type="button"
          className="primary"
          onClick={generateSheet}
          disabled={busy || !reviewReady || !IMAGE_MODEL_IDS.has(imageModel)}
        >
          {busy ? 'Starting…' : `Generate sheet (${derivedShots.length})`}
        </button>
      </>
    );
  } else {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy && stage !== 'deriving'}>Cancel</button>
        <button type="button" className="primary" onClick={derive} disabled={busy}>
          {stage === 'deriving' ? 'Deriving…' : 'Derive shots'}
        </button>
      </>
    );
  }

  const intro = isCharacter
    ? 'Generate a set of clean, single-pose reference photos for this character — one image per checked shot. No text, no panels; just the pose.'
    : 'Derive a set of scene and background plates from this beat’s script, review and edit them, then generate. Plates are universal backdrops you can reuse later.';

  const modalSize = !isCharacter && stage === 'review' ? 'xl' : 'wide';

  return (
    <>
      <Modal
        open={open}
        title="Create image sheet"
        onClose={onClose}
        dismissible={!busy}
        size={modalSize}
        footer={footer}
      >
        <div className="frame-generate-modal">
          <p className="tab-intro" style={{ marginTop: 0 }}>{intro}</p>

          {(isCharacter || stage !== 'deriving') && (
            <div className="frame-generate-refs">
              <div className="frame-generate-section-header">
                <span className="field-label">Reference images</span>
                <button type="button" className="primary" onClick={() => setPickerOpen(true)} disabled={busy}>
                  + Add references
                </button>
              </div>
              <div className="frame-generate-ref-grid">
                {referenceIds.length === 0 ? (
                  <div className="frame-generate-ref-empty">
                    No reference images selected. Adding some anchors the look — the
                    generated plates may drift without them.
                  </div>
                ) : (
                  referenceIds.map((id) => (
                    <div className="frame-generate-ref-thumb" key={id}>
                      <img
                        src={thumbUrl(id)}
                        alt="reference"
                        loading="lazy"
                        onClick={() => window.open(imageUrl(id), '_blank', 'noopener')}
                      />
                      <button
                        type="button"
                        className="storyboard-frame-remove"
                        title="Remove reference"
                        onClick={() => removeReference(id)}
                        disabled={busy}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {isCharacter && (
            <div className="image-sheet-shotlist">
              <div className="frame-generate-section-header">
                <span className="field-label">
                  Shots to generate ({selectedShots.length}/{shots.length})
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setSelectedShots(shots.map((s) => s.name))} disabled={busy}>All</button>
                  <button type="button" onClick={() => setSelectedShots([])} disabled={busy}>None</button>
                </span>
              </div>
              <div className="image-sheet-shotlist-grid">
                {shots.map((s) => (
                  <label key={s.name} className="image-sheet-shot" title={s.hint || ''}>
                    <input
                      type="checkbox"
                      checked={selectedShots.includes(s.name)}
                      onChange={() => toggleShot(s.name)}
                      disabled={busy}
                    />
                    <span>{s.name}</span>
                  </label>
                ))}
              </div>
              <span className="frame-generate-help">
                Each checked shot is one image. Uncheck any you don't need —
                generation is billed per image.
              </span>
            </div>
          )}

          {!isCharacter && stage === 'setup' && (
            <div className="image-sheet-derive-setup">
              <span className="frame-generate-help">
                Click <strong>Derive shots</strong> to read the beat and propose plates. You'll
                review and edit the list before any images are generated.
              </span>
            </div>
          )}

          {!isCharacter && stage === 'deriving' && deriveJob && (
            <div className="image-sheet-progress">
              <GenerationProgress
                job={deriveJob}
                noun="plate"
                showLog={showDeriveLog}
                onToggleLog={() => setShowDeriveLog((s) => !s)}
                logRef={deriveLogRef}
              />
            </div>
          )}

          {!isCharacter && stage === 'review' && (
            <div className="image-sheet-review">
              <div className="frame-generate-section-header">
                <span className="field-label">Plates to generate ({derivedShots.length})</span>
                <button type="button" onClick={addShot} disabled={busy}>+ Add plate</button>
              </div>
              {derivedShots.length === 0 ? (
                <div className="frame-generate-ref-empty">
                  No plates derived. Add one manually, or Re-derive.
                </div>
              ) : (
                <div className="image-sheet-plate-list">
                  {derivedShots.map((s, i) => (
                    <div className="image-sheet-plate-card" key={s.key}>
                      <div className="image-sheet-plate-head">
                        <span className="image-sheet-plate-num">{i + 1}</span>
                        <input
                          className="image-sheet-plate-name"
                          type="text"
                          value={s.name}
                          placeholder="Plate name"
                          onChange={(e) => updateShot(s.key, 'name', e.target.value)}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="storyboard-frame-remove"
                          title="Remove plate"
                          onClick={() => removeShot(s.key)}
                          disabled={busy}
                        >
                          ×
                        </button>
                      </div>
                      <textarea
                        className="image-sheet-plate-prompt"
                        rows={3}
                        value={s.prompt}
                        placeholder="Image prompt (purely visual — no characters or caption text)"
                        onChange={(e) => updateShot(s.key, 'prompt', e.target.value)}
                        disabled={busy}
                      />
                      {s.quote && <blockquote className="image-sheet-plate-quote">{s.quote}</blockquote>}
                      {s.justification && <div className="image-sheet-plate-just">{s.justification}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {(isCharacter || stage === 'setup' || stage === 'review') && (
            <div className="frame-generate-model-row">
              <span className="field-label">Image model</span>
              <div className="frame-generate-model-options">
                {IMAGE_MODELS.map((m) => (
                  <label key={m.id}>
                    <input
                      type="radio"
                      name="image-sheet-model"
                      value={m.id}
                      checked={imageModel === m.id}
                      onChange={() => setImageModel(m.id)}
                      disabled={busy}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <span className="frame-generate-help">
            Generation runs in the background. The shots appear as placeholders in
            the gallery and fill in as each one finishes.
          </span>

          {error && <div className="error-banner">{error}</div>}
        </div>
      </Modal>
      <ArtworkReferencePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onApply={(ids) => setReferenceIds(ids)}
        hostType={hostType}
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
        selectedIds={referenceIds}
      />
    </>
  );
}
```

- [ ] **Step 2: Append the review-card styles** to `web/src/styles.css` (after the existing `.image-sheet-shot` rules, ~line 451).

```css
/* Beat image-sheet derive/review wizard. */
.image-sheet-derive-setup { margin: 12px 0 0; }
.image-sheet-review { margin: 12px 0 0; }
.image-sheet-plate-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
  max-height: 52vh;
  overflow-y: auto;
}
.image-sheet-plate-card {
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  padding: 10px;
  background: var(--panel, #1a1a1a);
}
.image-sheet-plate-head { display: flex; align-items: center; gap: 8px; }
.image-sheet-plate-num {
  flex: none;
  width: 22px; height: 22px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: 12px;
  background: var(--border, #333);
}
.image-sheet-plate-name { flex: 1; }
.image-sheet-plate-prompt {
  width: 100%;
  margin-top: 8px;
  resize: vertical;
  font: inherit;
}
.image-sheet-plate-quote {
  margin: 8px 0 0;
  padding: 4px 0 4px 10px;
  border-left: 3px solid var(--accent, #6cf);
  color: var(--muted, #aaa);
  font-style: italic;
  font-size: 13px;
}
.image-sheet-plate-just { margin-top: 6px; color: var(--muted, #aaa); font-size: 12px; }
```

- [ ] **Step 3: Build the SPA to verify it compiles**

Run: `npm run build:web`
Expected: build succeeds (no JSX/import errors); `web/dist/` is written.

- [ ] **Step 4: Manual smoke checklist** (run `npm run dev` + `npm run dev:web`, or use the built SPA; needs a real session + `ANTHROPIC_API_KEY` + an image provider key). Confirm:
  - Beat → Artwork → "Create image sheet" shows the setup stage with a **Derive shots** button and NO "Target shots" number field.
  - Clicking Derive shows the progress panel (PLANNING → CRITIQUING), then a review list of plate cards each with an editable name, editable prompt, a quote block, and a justification line.
  - Editing a prompt, removing a plate, and "+ Add plate" all work; "Re-derive" warns before discarding edits.
  - "Generate sheet (N)" closes the dialog and the gallery fills with N pending→done tiles (the existing ArtworkTab progress panel).
  - Character → "Create image sheet" is unchanged (checklist + immediate generate).

- [ ] **Step 5: Commit**

```bash
git add web/src/widgets/ImageSheetDialog.jsx web/src/styles.css
git commit -m "✨ Beat image-sheet derive→review→generate wizard" -m "Claude-Session: https://claude.ai/code/session_01LPebMckxrXoF9uJsQeYcJi"
```

---

## Final verification

- [ ] **Run the full backend suite:** `npm test` → all green.
- [ ] **Build the SPA:** `npm run build:web` → succeeds.
- [ ] **Confirm no stray references to removed symbols:** `grep -rn "shot_count\|_setSceneImagePlannerForTests\|SCENE_IMAGE_PLAN\|BEAT_SHOT\|clampSceneImageCount" src/ web/src/ tests/` returns only character-path `shot_count` usages (character route/engine/tests) — no beat-planner, dialog, or removed-seam hits.
