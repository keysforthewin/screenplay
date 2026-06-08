# Storyboard Scene Bible + Holistic Generation — Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the storyboard generation pipeline's two-stage outline→sequential-refine (three-output) approach with a holistic two-pass approach built around a persisted, per-beat scene bible, and remove end-frame generation.

**Architecture:** Pass 1 (one Claude call) produces a structured `scene_bible` plus an ordered shot skeleton. The bible is persisted on `plots.beats[].scene_bible`. Pass 2 (one Claude call) expands ALL shots at once, inheriting the bible, emitting only `start_frame_prompt` + `video_prompt` per shot. The AI-video failure-mode rules are extracted into one shared constants module referenced by both passes.

**Tech Stack:** Node ESM, MongoDB (via the in-memory fake in tests), Anthropic SDK (`claude-opus-4-7`), Vitest.

**Plan scope boundary:** This plan covers the scene-bible data model, the constraints module, the two new passes, pipeline wiring, and end-frame removal. It does NOT cover: the critique panel (Plan 2), per-shot regen inheriting the bible / regen-from-critique (Plan 2), or any SPA UI (Plan 3).

---

## File Structure

**New files:**
- `src/mongo/sceneBible.js` — pure scene-bible shape: `SCENE_BIBLE_FIELDS`, `normalizeSceneBible(raw)`, `isEmptySceneBible(bible)`, `renderSceneBibleBlock(bible)`. No DB access; fully unit-testable.
- `src/web/storyboardConstraints.js` — named constant strings for the AI-video failure-mode rules (`CAMERA_MOTION_RULES`, `SUBJECT_MOTION_RULES`, `REVEAL_HANDLING`, `FRAMING_RULES`, `STILL_FRAMING_RULES`). Single source of truth.
- `tests/sceneBible.test.js` — unit tests for `src/mongo/sceneBible.js`.
- `tests/storyboardConstraints.test.js` — guard test that both prompts import the module.
- `tests/storyboardSceneGeneration.test.js` — pipeline tests using the override hooks.

**Modified files:**
- `src/mongo/plots.js` — add `setBeatSceneBible(identifier, bible)`; backfill `scene_bible: null` in `ensureBeatIds`.
- `src/web/storyboardGenerate.js` — replace `OUTLINE_TOOL`/`REFINE_TOOL`/`OUTLINE_SYSTEM_PROMPT`/`REFINE_SYSTEM_PROMPT` with `SCENE_PLAN_TOOL`/`SHOT_EXPAND_TOOL`/`SCENE_PLAN_SYSTEM_PROMPT`/`SHOT_EXPAND_SYSTEM_PROMPT`; replace `planOutline`/`refineFramePrompts`/`planFrames` with `planScene`/`expandShots`/`planFramesV2`; persist the bible; seed only the start-frame prompt.

---

## Milestone A — Scene bible data model

### Task A1: Scene bible pure module

**Files:**
- Create: `src/mongo/sceneBible.js`
- Test: `tests/sceneBible.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/sceneBible.test.js
import { describe, it, expect } from 'vitest';
import {
  SCENE_BIBLE_FIELDS,
  normalizeSceneBible,
  isEmptySceneBible,
  renderSceneBibleBlock,
} from '../src/mongo/sceneBible.js';

describe('normalizeSceneBible', () => {
  it('returns an all-empty-string object for null/garbage input', () => {
    const b = normalizeSceneBible(null);
    for (const f of SCENE_BIBLE_FIELDS) expect(b[f]).toBe('');
    expect(b.updated_at).toBeInstanceOf(Date);
  });

  it('keeps known string fields and drops unknown keys', () => {
    const b = normalizeSceneBible({ location: 'Diner', bogus: 'x', mood: 'tense' });
    expect(b.location).toBe('Diner');
    expect(b.mood).toBe('tense');
    expect(b).not.toHaveProperty('bogus');
  });

  it('coerces non-string field values to empty string', () => {
    const b = normalizeSceneBible({ location: 42, palette: ['a', 'b'] });
    expect(b.location).toBe('');
    expect(b.palette).toBe('');
  });

  it('trims whitespace', () => {
    expect(normalizeSceneBible({ location: '  Diner  ' }).location).toBe('Diner');
  });
});

describe('isEmptySceneBible', () => {
  it('is true for null and for an all-empty bible', () => {
    expect(isEmptySceneBible(null)).toBe(true);
    expect(isEmptySceneBible(normalizeSceneBible({}))).toBe(true);
  });
  it('is false when any field has content', () => {
    expect(isEmptySceneBible(normalizeSceneBible({ mood: 'tense' }))).toBe(false);
  });
});

describe('renderSceneBibleBlock', () => {
  it('returns null when the bible is empty', () => {
    expect(renderSceneBibleBlock(null)).toBeNull();
    expect(renderSceneBibleBlock(normalizeSceneBible({}))).toBeNull();
  });
  it('renders only the populated fields, each on its own labeled line', () => {
    const block = renderSceneBibleBlock(
      normalizeSceneBible({ location: 'Corner diner', mood: 'tense' }),
    );
    expect(block).toContain('Location: Corner diner');
    expect(block).toContain('Mood: tense');
    expect(block).not.toContain('Palette:');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sceneBible.test.js`
Expected: FAIL — cannot resolve `../src/mongo/sceneBible.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/mongo/sceneBible.js
// Pure scene-bible shape + rendering. No DB access — persistence lives in
// plots.js (setBeatSceneBible). The bible is a compact structured "look book"
// for a beat: location, lighting, palette, mood, blocking, continuity anchors,
// camera language. Every storyboard shot of the beat inherits it, so per-shot
// prompts stay short and the scene's look stays unified.

// Ordered list of the editable text fields. The order here is the order they
// render in the prompt block and (later) the SPA editor.
export const SCENE_BIBLE_FIELDS = Object.freeze([
  'location',
  'time_of_day',
  'lighting_key',
  'palette',
  'mood',
  'blocking',
  'continuity_anchors',
  'camera_language',
]);

// Human labels for prompt rendering. Keyed by field.
const FIELD_LABELS = Object.freeze({
  location: 'Location',
  time_of_day: 'Time of day',
  lighting_key: 'Lighting key',
  palette: 'Palette',
  mood: 'Mood',
  blocking: 'Blocking',
  continuity_anchors: 'Continuity anchors',
  camera_language: 'Camera language',
});

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Coerce arbitrary input into the canonical bible shape. Unknown keys dropped,
// non-string field values become ''. Always returns an object with every field
// present (empty string when unset) plus an `updated_at` Date.
export function normalizeSceneBible(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const f of SCENE_BIBLE_FIELDS) out[f] = cleanStr(src[f]);
  out.updated_at = src.updated_at instanceof Date ? src.updated_at : new Date();
  return out;
}

export function isEmptySceneBible(bible) {
  if (!bible || typeof bible !== 'object') return true;
  return SCENE_BIBLE_FIELDS.every((f) => !cleanStr(bible[f]));
}

// Render the populated fields as a labeled text block for inclusion in an LLM
// prompt. Returns null when the bible has no content (so callers can omit the
// section entirely rather than emit an empty header).
export function renderSceneBibleBlock(bible) {
  if (isEmptySceneBible(bible)) return null;
  const lines = [];
  for (const f of SCENE_BIBLE_FIELDS) {
    const v = cleanStr(bible[f]);
    if (v) lines.push(`${FIELD_LABELS[f]}: ${v}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sceneBible.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/mongo/sceneBible.js tests/sceneBible.test.js
git commit -m "✨ Add scene bible shape + rendering module"
```

---

### Task A2: Backfill `scene_bible` on beats

**Files:**
- Modify: `src/mongo/plots.js:35-101` (`ensureBeatIds`)
- Test: `tests/plots-scene-bible.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/plots-scene-bible.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { getPlot, createBeat, getBeat, setBeatSceneBible } = await import(
  '../src/mongo/plots.js'
);

describe('scene_bible on beats', () => {
  beforeEach(() => fakeDb.reset());

  it('backfills scene_bible: null on beats that lack it', async () => {
    await createBeat({ name: 'Diner', desc: 'A diner' });
    const beat = await getBeat('Diner');
    expect(beat.scene_bible).toBeNull();
  });

  it('setBeatSceneBible persists a normalized bible and re-reads it', async () => {
    await createBeat({ name: 'Diner', desc: 'A diner' });
    await setBeatSceneBible('Diner', { location: '  Corner diner  ', bogus: 'x' });
    const beat = await getBeat('Diner');
    expect(beat.scene_bible.location).toBe('Corner diner');
    expect(beat.scene_bible).not.toHaveProperty('bogus');
    expect(beat.scene_bible.mood).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plots-scene-bible.test.js`
Expected: FAIL — `setBeatSceneBible` is not exported / `scene_bible` is undefined.

- [ ] **Step 3a: Backfill in `ensureBeatIds`**

In `src/mongo/plots.js`, inside the `.map((b) => { ... })` in `ensureBeatIds`, add this block immediately after the `next.characters` block (after line 63, before the `next.name` block):

```js
    if (next.scene_bible === undefined) {
      next.scene_bible = null;
      changed = true;
    }
```

- [ ] **Step 3b: Add `setBeatSceneBible` export**

In `src/mongo/plots.js`, add the import at the top (after the existing imports):

```js
import { normalizeSceneBible } from './sceneBible.js';
```

Then add this exported function near the other beat helpers (e.g. after `setBeatBody`, around line 391):

```js
// Persist a beat's scene bible (the per-beat "look book" that all storyboard
// shots inherit). Stored as a normalized sub-doc under beats.$.scene_bible.
// Pass null/empty to clear. Uses the atomic per-beat write path.
export async function setBeatSceneBible(identifier, bible) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const value = bible == null ? null : normalizeSceneBible(bible);
  await updateBeatFields(beat._id, { 'beats.$.scene_bible': value });
  logger.info(`mongo: beat scene_bible set id=${beat._id}`);
  return fetchBeat(beat._id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plots-scene-bible.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mongo/plots.js tests/plots-scene-bible.test.js
git commit -m "✨ Persist + backfill scene_bible on beats"
```

---

## Milestone B — Constraints module

### Task B1: Extract AI-video constraints into a shared module

**Files:**
- Create: `src/web/storyboardConstraints.js`
- Test: `tests/storyboardConstraints.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/storyboardConstraints.test.js
import { describe, it, expect } from 'vitest';
import {
  CAMERA_MOTION_RULES,
  SUBJECT_MOTION_RULES,
  REVEAL_HANDLING,
  FRAMING_RULES,
  STILL_FRAMING_RULES,
} from '../src/web/storyboardConstraints.js';

describe('storyboard constraints', () => {
  it('every block is a non-empty string', () => {
    for (const block of [
      CAMERA_MOTION_RULES,
      SUBJECT_MOTION_RULES,
      REVEAL_HANDLING,
      FRAMING_RULES,
      STILL_FRAMING_RULES,
    ]) {
      expect(typeof block).toBe('string');
      expect(block.trim().length).toBeGreaterThan(0);
    }
  });

  it('camera rules name the locked-off default and forbid yaw/pan', () => {
    expect(CAMERA_MOTION_RULES.toLowerCase()).toContain('locked-off');
    expect(CAMERA_MOTION_RULES.toLowerCase()).toContain('pan');
  });

  it('reveal handling names reverse_in_post', () => {
    expect(REVEAL_HANDLING).toContain('reverse_in_post');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboardConstraints.test.js`
Expected: FAIL — cannot resolve `../src/web/storyboardConstraints.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/web/storyboardConstraints.js
// Single source of truth for the AI image-to-video failure-mode rules. Both
// the scene-plan prompt and the shot-expand prompt reference these so the
// guidance is written once. Each export is a ready-to-embed text block.

export const CAMERA_MOTION_RULES = [
  'Camera motion — pick at most one per shot, and prefer the top of this list:',
  '- Locked-off / tripod static. Most reliable; the camera does not move, only the subject does. When in doubt, pick this.',
  '- Subtle handheld breath — micro-shake or small drift while the camera stays essentially in place.',
  '- Slow push-in toward the subject along the subject axis.',
  '- Slow pull-out along the subject axis (keep it short; the model must invent peripheral background).',
  '- Slow lateral truck — only when the destination space is continuous and simple.',
  'NEVER (these break the model):',
  '- Turning / panning in place to look off-frame (yaw rotation): "the camera pans to…", "we pan from Alice to Bob".',
  '- Tilting up/down to reveal a new subject (pitch rotation).',
  '- Whip pans, fast zooms, dolly-zooms, rolls, sweeps, orbits.',
  '- Crane / jib / drone / aerial / Steadicam-following moves; any arcing or subject-tracking trajectory.',
  '- Two-stage moves in one shot (push-in then tilt; lateral then turn).',
].join('\n');

export const SUBJECT_MOTION_RULES = [
  'Subject motion — keep it constrained to a single vector:',
  '- Best: a head turn, a gaze shift, a hand lifting, weight shifting, fabric/hair moving, smoke rising, rain falling.',
  '- Do NOT introduce new people or props mid-clip. Everyone the clip ends with must already be in the start frame.',
  '- Do NOT describe two-character contact (handshake, hug, kiss, struggle, dance) — limbs merge and identities swap.',
  '- Do NOT describe subjects passing in front of each other — identity swap.',
  '- Do NOT describe lighting changes mid-clip (a lamp turning on, headlights sweeping, a flash).',
  '- Do NOT describe precise hand action (writing, typing, counting bills, threading, tying) — fingers merge.',
  '- Do NOT describe spinning wheels, gear mechanisms, or fast clock hands — repeating geometry warps.',
  '- Do NOT write dialogue, voice-over, or sound effects. Audio is added in post.',
].join('\n');

export const REVEAL_HANDLING = [
  'Reveals and entries break the model: a camera move or cut that lands on a previously-hidden subject glitches.',
  'Detect them via signal phrases: "is revealed", "comes into view", "appears", "emerges", "X enters the frame",',
  '"X walks in", "we discover X", "the camera pans to find X", "pulls out to show X", or any end-state that',
  'contains something not visible at the start.',
  'When a shot is a SPATIAL reveal/entry, mark it reverse_in_post: true and write it BACKWARDS: the shot starts',
  'with the reveal target centered and fully visible, and ends with the camera pulled back / the subject',
  'shrunk or exited. The clip is reversed in post, so the audience experiences the discovery.',
  'When the reveal is NOT spatially invertible (lighting change, irreversible physics, yaw/pitch rotation,',
  'audio-driven beat), do NOT use reverse_in_post — substitute with separate static shots covering the same content.',
].join('\n');

export const FRAMING_RULES = [
  'Framing — what the model cannot draw cleanly, avoid in any shot:',
  '- Crowds or background extras. Frame tight on the named subject(s) against a simple/blurred background.',
  '- Subjects entering from off-screen mid-shot. Everyone who matters is already on-screen at the first frame.',
  '- Subjects partially occluded by foreground while the camera moves (foliage, bars, fences, glass).',
  '- Mirrors, water, or polished-glass reflections of a character — the reflection drifts independently.',
  '- Readable text or logos the audience is meant to read (signs, screens, books, plates) — they warp to gibberish.',
].join('\n');

export const STILL_FRAMING_RULES = [
  'Still-frame composition (for the start_frame_prompt that anchors the clip):',
  '- Place the subject (or both, in a two-shot) centered, not clipped at the frame edge.',
  '- Keep subjects unoccluded; keep foreground clear of their silhouette.',
  '- Specify a simple, separable background when the set allows ("dark interior", "soft blurred street lights").',
  '- The opening still is the WHOLE composition — do NOT describe the camera arriving on the subject from off-frame.',
].join('\n');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboardConstraints.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardConstraints.js tests/storyboardConstraints.test.js
git commit -m "✨ Extract AI-video constraints into shared module"
```

---

## Milestone C — Pass 1: scene plan (bible + skeleton)

### Task C1: `SCENE_PLAN_TOOL` + `SCENE_PLAN_SYSTEM_PROMPT` + `planScene`

**Files:**
- Modify: `src/web/storyboardGenerate.js` (add new tool/prompt/function; keep old ones until Milestone E removes them)
- Test: `tests/storyboardSceneGeneration.test.js`

This task adds the Pass-1 building blocks alongside the existing code. The override hook for testing is a new `_setScenePlannerForTests`.

- [ ] **Step 1: Write the failing test**

```js
// tests/storyboardSceneGeneration.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const gen = await import('../src/web/storyboardGenerate.js');
const { SCENE_PLAN_SYSTEM_PROMPT, SHOT_EXPAND_SYSTEM_PROMPT } = gen;

describe('scene-plan building blocks', () => {
  it('exports both system prompts as non-empty strings', () => {
    expect(SCENE_PLAN_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(SHOT_EXPAND_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('both prompts embed the shared constraint blocks (no duplication)', () => {
    // The locked-off camera rule should appear via the shared module, in both.
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain('Locked-off');
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain('Locked-off');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js`
Expected: FAIL — `SCENE_PLAN_SYSTEM_PROMPT` / `SHOT_EXPAND_SYSTEM_PROMPT` undefined.

- [ ] **Step 3a: Import the constraints + scene-bible render**

In `src/web/storyboardGenerate.js`, add to the import block (near line 46-48):

```js
import {
  CAMERA_MOTION_RULES,
  SUBJECT_MOTION_RULES,
  REVEAL_HANDLING,
  FRAMING_RULES,
  STILL_FRAMING_RULES,
} from './storyboardConstraints.js';
import { renderSceneBibleBlock, normalizeSceneBible } from '../mongo/sceneBible.js';
```

- [ ] **Step 3b: Add the Pass-1 tool**

Add near the existing `OUTLINE_TOOL` definition:

```js
// Pass 1 tool: produce the scene bible AND the ordered shot skeleton in one
// call. The bible is the unified look all shots inherit; the skeleton is the
// coverage plan (no detailed prompts yet — those are Pass 2).
const SCENE_PLAN_TOOL = {
  name: 'plan_scene',
  description:
    'Design the whole scene: first a compact scene bible (the unified visual look every shot inherits), ' +
    'then an ordered shot skeleton covering the entire beat. Do NOT write detailed video / still prompts here.',
  input_schema: {
    type: 'object',
    properties: {
      scene_bible: {
        type: 'object',
        description:
          'The unified visual plan for the whole scene. Every shot inherits this, so keep each field concrete and consistent.',
        properties: {
          location: { type: 'string', description: 'Where the scene takes place, concretely.' },
          time_of_day: { type: 'string', description: 'Time of day / part of day.' },
          lighting_key: { type: 'string', description: 'Lighting key and sources, e.g. "warm low practical + cool fill".' },
          palette: { type: 'string', description: '3–5 anchor colors / overall grade.' },
          mood: { type: 'string', description: 'Tonal one-liner.' },
          blocking: { type: 'string', description: 'Character geography: who is where in the space and their spatial relationships.' },
          continuity_anchors: { type: 'string', description: 'Props, wardrobe states, weather that must stay constant across shots.' },
          camera_language: { type: 'string', description: 'The scene default camera grammar, e.g. "mostly locked-off, occasional slow push".' },
        },
        additionalProperties: false,
      },
      frames: {
        type: 'array',
        description: 'Ordered shot skeleton covering the entire beat.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'One-sentence narrative summary of what happens in this shot.' },
            shot_type: {
              type: 'string',
              enum: [...SHOT_TYPES],
              description:
                'Framing/coverage class. establishing/cinematic_wide/insert ≤ 15s, medium ≤ 10s, close_up/reaction/two_shot/over_the_shoulder ≤ 5s.',
            },
            duration_seconds: { type: 'integer', minimum: 1, maximum: 15, description: 'On-screen hold time; respect the shot_type cap.' },
            transition_in: { type: 'string', description: 'One-line continuity note: how this shot picks up from the previous one. Empty for the first shot.' },
            characters_in_scene: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of characters visible in this shot, exactly as listed in the beat metadata. AT MOST 2.',
            },
            reverse_in_post: { type: 'boolean', description: 'True for spatial reveal/entry shots that must be generated backwards and reversed in post.' },
          },
          required: ['description', 'shot_type', 'duration_seconds'],
          additionalProperties: false,
        },
      },
    },
    required: ['scene_bible', 'frames'],
    additionalProperties: false,
  },
};
```

- [ ] **Step 3c: Add the Pass-1 system prompt**

Add near the existing `OUTLINE_SYSTEM_PROMPT`:

```js
// Pass 1 system prompt. Direction-focused: derive the bible, design coverage /
// rhythm / shot list to the exact target count, and mark reveals. The AI-video
// failure-mode rules come from the shared constraints module (referenced once).
export const SCENE_PLAN_SYSTEM_PROMPT = [
  'You are a Hollywood storyboard artist and DP planning a whole scene from a screenplay beat. Return your plan via the plan_scene tool.',
  '',
  '# Two jobs',
  '1. Write the SCENE BIBLE — a compact, unified visual plan (location, time of day, lighting key, palette, mood, blocking, continuity anchors, camera language). Every shot will inherit this, so make it concrete and self-consistent. Derive it from the beat body, description, characters, and director guidance.',
  '2. Plan the ordered SHOT SKELETON — one entry per shot, covering the whole beat with cinematic rhythm.',
  '',
  '# FRAME COUNT IS NON-NEGOTIABLE',
  '- The user message specifies an EXACT target shot count. Emit exactly that many frames — not fewer, not more.',
  '- If the beat is short, pad with embellishment shots (establishing wides, inserts of props/hands/eyes, reaction close-ups, atmospheric cutaways, alternate-angle coverage).',
  '',
  '# Coverage and rhythm',
  '- Open with an establishing wide. Vary framing (wides, mediums, close-ups in rotation, not three close-ups in a row). Use over_the_shoulder for two-person dialogue.',
  '- Adjacent shots must hand off cleanly: a shared subject, a matching motion vector, or a deliberate match cut. State the link in transition_in.',
  '',
  '# Reveals',
  REVEAL_HANDLING,
  '',
  '# Camera grammar to plan around',
  CAMERA_MOTION_RULES,
  '',
  '# Hard constraints',
  '- Maximum 2 named characters per shot. If a beat has 4 people, alternate coverage.',
  '- shot_type drives duration_seconds: establishing/cinematic_wide/insert ≤ 15s, medium ≤ 10s, close_up/reaction/two_shot/over_the_shoulder ≤ 5s. Prefer the lower half of the range — shorter clips survive video gen better.',
  "- Don't invent characters not in the beat's character list.",
  '- Emit EXACTLY the requested number of frames.',
].join('\n');
```

- [ ] **Step 3d: Add the `_setScenePlannerForTests` hook and `planScene`**

Add the override hook near the existing `_setOutlinePlannerForTests`:

```js
let scenePlannerOverride = null;
export function _setScenePlannerForTests(fn) {
  scenePlannerOverride = fn;
}
```

Add the `buildScenePlanUserText` + `planScene` functions (model the user-text on the existing `buildOutlineUserText`):

```js
export function buildScenePlanUserText({ beat, characters, targetCount, direction, directorNotes = [] }) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const count = clampTargetCount(targetCount);
  const lead =
    `Target shot count: EXACTLY ${count} frames. Your frames array MUST contain ${count} entries.`;
  const instruction =
    `First write the scene_bible (the unified look). Then produce ${count} cinematic shots in narrative order, ` +
    'with embellishment shots interleaved among the narrative beats. Each shot must be visually distinct from ' +
    'the previous AND continuous with it. Pick a shot_type and duration_seconds for every shot. ' +
    'Re-interpret any reveals/entries/camera-moves the beat describes per the reveal rules. ' +
    `Use the plan_scene tool. Reminder: exactly ${count} frames.`;
  return `${lead}\n\n${ctx}\n\n${instruction}`;
}

// Pass 1. Returns { sceneBible, outline } where sceneBible is a normalized
// bible object and outline is the raw frames array (cleaned later). Returns
// { sceneBible: null, outline: [] } on model failure.
async function planScene({ beat, characters, targetCount, direction, directorNotes = [] }) {
  if (scenePlannerOverride) {
    return scenePlannerOverride({ beat, characters, targetCount, direction, directorNotes });
  }
  const userText = buildScenePlanUserText({ beat, characters, targetCount, direction, directorNotes });
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: STORYBOARD_MODEL,
    max_tokens: 16000,
    system: SCENE_PLAN_SYSTEM_PROMPT,
    tools: [SCENE_PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'plan_scene' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'plan_scene');
  if (!toolUse?.input) {
    logger.warn(`storyboard plan_scene: model did not call the tool (stop_reason=${resp.stop_reason})`);
    return { sceneBible: null, outline: [] };
  }
  const sceneBible = normalizeSceneBible(toolUse.input.scene_bible);
  const outline = Array.isArray(toolUse.input.frames) ? toolUse.input.frames : [];
  return { sceneBible, outline };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js`
Expected: FAIL on the `SHOT_EXPAND_SYSTEM_PROMPT` assertions (not yet defined), PASS on the scene-plan ones. This is expected — Task D1 adds the expand prompt. To keep the step green, temporarily run only the first test:

Run: `npx vitest run tests/storyboardSceneGeneration.test.js -t "non-empty"`
Expected: still FAIL until D1. **Skip the SHOT_EXPAND assertions for now** by commenting out the second `it(...)` block and the `SHOT_EXPAND_SYSTEM_PROMPT` destructure; re-enable in Task D1.

(If you prefer strict green-between-tasks, split the test file: put SCENE_PLAN assertions here and add SHOT_EXPAND assertions in D1.)

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboardSceneGeneration.test.js
git commit -m "✨ Add Pass 1 scene planner (bible + shot skeleton)"
```

---

## Milestone D — Pass 2: holistic shot expansion (2 outputs)

### Task D1: `SHOT_EXPAND_TOOL` + `SHOT_EXPAND_SYSTEM_PROMPT` + `expandShots`

**Files:**
- Modify: `src/web/storyboardGenerate.js`
- Test: `tests/storyboardSceneGeneration.test.js` (re-enable the SHOT_EXPAND assertions, add expand-output test)

- [ ] **Step 1: Write the failing test**

Re-enable the second `it(...)` from Task C1, and add:

```js
describe('expandShots (Pass 2)', () => {
  it('returns one {start_frame_prompt, video_prompt} per skeleton shot via the override', async () => {
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({
        start_frame_prompt: `start ${i}`,
        video_prompt: `move ${i}`,
        reverse_in_post: Boolean(f.reverse_in_post),
      })),
    );
    const outline = [
      { description: 'a', shot_type: 'medium', duration_seconds: 4 },
      { description: 'b', shot_type: 'close_up', duration_seconds: 3 },
    ];
    const shots = await gen._expandShotsForTest({
      beat: { name: 'X', order: 1, body: '', desc: '', characters: [] },
      characters: [],
      sceneBible: { location: 'Diner' },
      outline,
      direction: '',
      directorNotes: [],
    });
    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({ start_frame_prompt: 'start 0', video_prompt: 'move 0' });
    expect(shots[0]).not.toHaveProperty('end_frame_prompt');
    gen._setShotExpanderForTests(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js`
Expected: FAIL — `_setShotExpanderForTests` / `_expandShotsForTest` undefined.

- [ ] **Step 3a: Add the Pass-2 tool**

```js
// Pass 2 tool: expand the WHOLE skeleton at once. One entry per shot, two
// outputs each — no end frame. shot_index ties each output back to the
// skeleton order so a partial/misaligned response can be matched up.
const SHOT_EXPAND_TOOL = {
  name: 'expand_shots',
  description:
    'Given the scene bible and the full ordered shot skeleton, write the two generation prompts for EVERY shot: ' +
    'a start_frame_prompt (the opening still that anchors the clip) and a video_prompt (what happens + camera move). ' +
    'Return one entry per shot, in skeleton order.',
  input_schema: {
    type: 'object',
    properties: {
      shots: {
        type: 'array',
        description: 'One entry per skeleton shot, in order.',
        items: {
          type: 'object',
          properties: {
            shot_index: { type: 'integer', minimum: 1, description: '1-based index into the skeleton this entry expands.' },
            start_frame_prompt: {
              type: 'string',
              description:
                'Still-image prompt for the opening composition: subject, action, framing, camera lighting. ~2 sentences. Do NOT re-describe the scene bible (location/lighting/palette/blocking) or character faces/wardrobe — reference them.',
            },
            video_prompt: {
              type: 'string',
              description:
                'Clip-gen prompt: what HAPPENS (subject action + one camera move or hold), assuming the start frame already exists. ~2 sentences. Do NOT re-describe the start composition.',
            },
            reverse_in_post: {
              type: 'boolean',
              description:
                'Override the skeleton if you detect a reveal it missed. When true, invert: start_frame_prompt = final revealed state, video_prompt = the pull-back/generation-direction move (reversed in post). Omit to inherit the skeleton value.',
            },
          },
          required: ['shot_index', 'start_frame_prompt', 'video_prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['shots'],
    additionalProperties: false,
  },
};
```

- [ ] **Step 3b: Add the Pass-2 system prompt**

```js
// Pass 2 system prompt. Prompt-writing-focused: two outputs per shot, no end
// frame. Heavy shared context lives in the bible (referenced, not re-described),
// so per-shot prompts stay short. Constraints come from the shared module.
export const SHOT_EXPAND_SYSTEM_PROMPT = [
  'You are a Hollywood storyboard artist writing the generation prompts for an already-planned shot list. Return all prompts via the expand_shots tool.',
  '',
  'You see the SCENE BIBLE (the unified look) and the FULL shot skeleton at once, so you can compose the whole scene coherently: each shot picks up its neighbor, and every shot honors the same bible.',
  '',
  '# Two outputs per shot (NO end frame)',
  '1. start_frame_prompt — the opening still that the image-to-video model conditions on. Subject, action, framing, camera lighting. ~2 sentences.',
  '2. video_prompt — what HAPPENS during the clip (subject action + one camera move, or a hold), assuming the start frame already exists. ~2 sentences. Lead with the motion; do NOT re-describe the start composition.',
  '',
  '# Inherit the bible — do not re-describe it',
  '- The scene bible already fixes location, time of day, lighting key, palette, mood, blocking, and camera language. Reference them; never restate them.',
  '- Character faces, bodies, and wardrobe come from reference photos. Do not describe them.',
  '- This is WHY your prompts can be short: the shared context is carried by the bible + reference images.',
  '',
  '# Continuity',
  "- Compose each start_frame_prompt to pick up the prior shot's motion vector / match cut, per the skeleton's transition_in.",
  '- Honor each shot\'s description, shot_type, transition_in, and characters_in_scene.',
  '',
  '# Camera motion (for video_prompt)',
  CAMERA_MOTION_RULES,
  '',
  '# Subject motion (for video_prompt)',
  SUBJECT_MOTION_RULES,
  '',
  '# Still composition (for start_frame_prompt)',
  STILL_FRAMING_RULES,
  '',
  '# What the model cannot draw',
  FRAMING_RULES,
  '',
  '# Reveals',
  REVEAL_HANDLING,
  'For a reverse_in_post shot, the start_frame_prompt is the FINAL revealed state and the video_prompt is the pull-back / generation-direction move; the clip is reversed in post.',
  '',
  '# Output',
  '- Return one entry per skeleton shot, each with its 1-based shot_index. Emit ALL shots.',
].join('\n');
```

- [ ] **Step 3c: Add the override hook, `buildShotExpandUserText`, `expandShots`, and a test seam**

```js
let shotExpanderOverride = null;
export function _setShotExpanderForTests(fn) {
  shotExpanderOverride = fn;
}

function formatSkeletonForExpand(outline) {
  return outline
    .map((f, i) => {
      const parts = [
        `${i + 1}. [${f.shot_type || 'shot'} · ${f.duration_seconds || '?'}s] ${f.description || ''}`,
      ];
      if (f.transition_in) parts.push(`   transition_in: ${f.transition_in}`);
      if (Array.isArray(f.characters_in_scene) && f.characters_in_scene.length) {
        parts.push(`   characters_in_scene: ${f.characters_in_scene.join(', ')}`);
      }
      if (f.reverse_in_post) parts.push('   reverse_in_post: true (invert temporal direction)');
      return parts.join('\n');
    })
    .join('\n');
}

export function buildShotExpandUserText({ beat, characters, sceneBible, outline, direction, directorNotes = [] }) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const bibleBlock = renderSceneBibleBlock(sceneBible);
  const lines = [ctx];
  if (bibleBlock) {
    lines.push('', '# Scene bible (the unified look — inherit, do not re-describe):', bibleBlock);
  }
  lines.push(
    '',
    '# Full shot skeleton:',
    formatSkeletonForExpand(outline),
    '',
    `Write start_frame_prompt + video_prompt for ALL ${outline.length} shots via the expand_shots tool, one entry per shot with its 1-based shot_index.`,
  );
  return lines.join('\n');
}

// Pass 2. One call expands the whole skeleton. Returns an array aligned to the
// skeleton (index i → shot i+1); entries the model omitted are filled with a
// synthesized fallback so downstream persistence still gets a usable prompt.
async function expandShots({ beat, characters, sceneBible, outline, direction, directorNotes = [] }) {
  if (shotExpanderOverride) {
    return shotExpanderOverride({ beat, characters, sceneBible, outline, direction, directorNotes });
  }
  const userText = buildShotExpandUserText({ beat, characters, sceneBible, outline, direction, directorNotes });
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: STORYBOARD_MODEL,
    max_tokens: 8000,
    system: SHOT_EXPAND_SYSTEM_PROMPT,
    tools: [SHOT_EXPAND_TOOL],
    tool_choice: { type: 'tool', name: 'expand_shots' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'expand_shots');
  const raw = Array.isArray(toolUse?.input?.shots) ? toolUse.input.shots : [];
  // Index returned entries by shot_index so a misordered/partial response still
  // maps correctly. Fall back to array position when shot_index is missing.
  const byIndex = new Map();
  raw.forEach((s, pos) => {
    const idx = Number.isFinite(Number(s?.shot_index)) ? Number(s.shot_index) : pos + 1;
    byIndex.set(idx, s);
  });
  return outline.map((f, i) => {
    const s = byIndex.get(i + 1);
    const sfp = typeof s?.start_frame_prompt === 'string' ? s.start_frame_prompt.trim() : '';
    const vp = typeof s?.video_prompt === 'string' ? s.video_prompt.trim() : '';
    if (!sfp || !vp) {
      logger.warn(`storyboard expand_shots: missing output for shot ${i + 1}; using fallback`);
      const fb = synthesizeFallbackShot(f);
      return { ...fb, reverse_in_post: Boolean(f.reverse_in_post) };
    }
    const rev = typeof s.reverse_in_post === 'boolean' ? s.reverse_in_post : Boolean(f.reverse_in_post);
    return { start_frame_prompt: sfp, video_prompt: vp, reverse_in_post: rev };
  });
}

// Two-output fallback (replaces the old three-output synthesizeFallbackPrompts
// for the new pipeline). Exported indirectly via expandShots' fallback path.
function synthesizeFallbackShot(frame) {
  const base = stripMarkdown(frame.description || '').trim();
  return {
    start_frame_prompt: base ? `Opening composition of the shot: ${base}` : 'Opening composition of the shot.',
    video_prompt: base ? `The action plays out: ${base}. Camera holds.` : 'Subject performs the action; camera holds.',
  };
}

// Test seam so the pipeline test can drive expandShots directly.
export function _expandShotsForTest(args) {
  return expandShots(args);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js`
Expected: PASS (scene-plan prompt assertions + expand assertions).

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboardSceneGeneration.test.js
git commit -m "✨ Add Pass 2 holistic shot expansion (start + video, no end frame)"
```

---

## Milestone E — Wire the new pipeline + remove end frames

### Task E1: `planFramesV2` combining Pass 1 + Pass 2

**Files:**
- Modify: `src/web/storyboardGenerate.js`
- Test: `tests/storyboardSceneGeneration.test.js`

- [ ] **Step 1: Write the failing test**

```js
describe('planFramesV2', () => {
  it('runs scene plan then expand, returns cleaned frames + the bible', async () => {
    gen._setScenePlannerForTests(() => ({
      sceneBible: normalizeBibleForTest({ location: 'Diner', mood: 'tense' }),
      outline: [
        { description: 'wide of diner', shot_type: 'establishing', duration_seconds: 6 },
        { description: 'Sarah looks up', shot_type: 'close_up', duration_seconds: 3, characters_in_scene: ['Sarah'] },
      ],
    }));
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({ start_frame_prompt: `s${i}`, video_prompt: `v${i}`, reverse_in_post: false })),
    );

    const { frames, sceneBible } = await gen._planFramesV2ForTest({
      beat: { name: 'Diner', order: 1, body: 'x', desc: '', characters: ['Sarah'] },
      characters: [{ name: 'Sarah' }],
      targetCount: 2,
      direction: '',
      directorNotes: [],
    });

    expect(sceneBible.location).toBe('Diner');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ start_frame_prompt: 's0', video_prompt: 'v0', shot_type: 'establishing' });
    expect(frames[0]).not.toHaveProperty('end_frame_prompt');

    gen._setScenePlannerForTests(null);
    gen._setShotExpanderForTests(null);
  });
});
```

Add this helper import at the top of the test file:

```js
import { normalizeSceneBible as normalizeBibleForTest } from '../src/mongo/sceneBible.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js -t planFramesV2`
Expected: FAIL — `_planFramesV2ForTest` undefined.

- [ ] **Step 3: Implement `planFramesV2` + a `cleanPlannedFrameV2` (two-output validator) + test seam**

Add a two-output frame cleaner (parallels the existing `cleanPlannedFrame` but validates `start_frame_prompt`/`video_prompt` instead of three outputs):

```js
// Two-output validator for the new pipeline. Drops a frame only if it has no
// start_frame_prompt AND no video_prompt; otherwise clamps shot_type/duration/
// characters/transition exactly like cleanPlannedFrame.
function cleanPlannedFrameV2(f) {
  if (!f || typeof f.start_frame_prompt !== 'string' || typeof f.video_prompt !== 'string') {
    return [];
  }
  const shotType = SHOT_TYPES.includes(f.shot_type) ? f.shot_type : null;
  const clampedDur = clampDuration(f.duration_seconds, shotType);
  const rawChars = Array.isArray(f.characters_in_scene)
    ? f.characters_in_scene.map((n) => stripMarkdown(String(n ?? '')).trim()).filter(Boolean)
    : [];
  const transition =
    typeof f.transition_in === 'string' && f.transition_in.trim()
      ? f.transition_in.trim().slice(0, MAX_TRANSITION_LEN)
      : null;
  return [{
    ...f,
    shot_type: shotType,
    duration_seconds: clampedDur,
    transition_in: transition,
    characters_in_scene: rawChars.slice(0, MAX_CHARS_PER_SHOT),
    reverse_in_post: Boolean(f.reverse_in_post),
  }];
}

// New two-pass planner. Returns { frames, sceneBible }. frames carry
// start_frame_prompt + video_prompt (no end_frame_prompt). On planner failure
// returns { frames: [], sceneBible: null }.
async function planFramesV2({ beat, characters, targetCount, direction = '', directorNotes = [], onProgress = null }) {
  onProgress?.({ phase: 'planning', step: 'plan_scene_start', message: 'Planning scene bible + shot list…' });
  const { sceneBible, outline: outlineRaw } = await planScene({ beat, characters, targetCount, direction, directorNotes });
  if (!Array.isArray(outlineRaw) || !outlineRaw.length) {
    onProgress?.({ phase: 'planning', step: 'plan_scene_empty', message: 'Scene planner returned no shots.' });
    return { frames: [], sceneBible };
  }
  onProgress?.({ phase: 'planning', step: 'plan_scene_done', total: outlineRaw.length, message: `Scene plan complete: ${outlineRaw.length} shots.` });

  const outline = outlineRaw.map((f) => ({
    description: typeof f?.description === 'string' ? f.description : '',
    shot_type: f?.shot_type ?? null,
    duration_seconds: f?.duration_seconds ?? null,
    transition_in: typeof f?.transition_in === 'string' ? f.transition_in : '',
    characters_in_scene: Array.isArray(f?.characters_in_scene) ? f.characters_in_scene : [],
    reverse_in_post: Boolean(f?.reverse_in_post),
  }));

  onProgress?.({ phase: 'refining', step: 'expand_start', total: outline.length, message: `Expanding ${outline.length} shots…` });
  const expanded = await expandShots({ beat, characters, sceneBible, outline, direction, directorNotes });
  onProgress?.({ phase: 'refining', step: 'expand_done', total: outline.length, message: 'Shot expansion complete.' });

  const frames = outline.flatMap((f, i) => {
    const e = expanded[i] || {};
    return cleanPlannedFrameV2({
      ...f,
      start_frame_prompt: e.start_frame_prompt,
      video_prompt: e.video_prompt,
      reverse_in_post: typeof e.reverse_in_post === 'boolean' ? e.reverse_in_post : f.reverse_in_post,
    });
  });
  return { frames, sceneBible };
}

export function _planFramesV2ForTest(args) {
  return planFramesV2(args);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js -t planFramesV2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboardSceneGeneration.test.js
git commit -m "✨ Add planFramesV2 two-pass orchestration"
```

---

### Task E2: Switch the job runner to `planFramesV2`, persist the bible, seed only the start prompt

**Files:**
- Modify: `src/web/storyboardGenerate.js:628-755` (`runStoryboardGenerationJob`), `:1290-1351` (`createPlannedStoryboardEntry`)
- Test: `tests/storyboardSceneGeneration.test.js`

- [ ] **Step 1: Write the failing test**

```js
describe('end-to-end generation job (overrides)', () => {
  it('persists the bible on the beat and seeds one start-frame prompt per row', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    await createBeat({ name: 'Diner', desc: 'A diner scene', characters: [] });
    const beat = await getBeat('Diner');

    gen._setScenePlannerForTests(() => ({
      sceneBible: normalizeBibleForTest({ location: 'Diner' }),
      outline: [{ description: 'wide', shot_type: 'establishing', duration_seconds: 6 }],
    }));
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({ start_frame_prompt: `start${i}`, video_prompt: `vid${i}`, reverse_in_post: false })),
    );
    gen._setImageDispatcherForTests(() => { throw new Error('should not render during generation'); });

    const jobId = await gen.startStoryboardGenerationJob({ beatId: beat._id.toString(), targetCount: 1 });
    // drain the background job
    for (let i = 0; i < 50; i++) {
      const job = gen.getStoryboardGenerationJob(jobId);
      if (job && (job.status === 'done' || job.status === 'partial' || job.status === 'error')) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const updatedBeat = await getBeat('Diner');
    expect(updatedBeat.scene_bible.location).toBe('Diner');

    const { listStoryboards } = await import('../src/mongo/storyboards.js');
    const sbs = await listStoryboards({ beatId: beat._id });
    expect(sbs).toHaveLength(1);
    // exactly one seeded frame (the start prompt), not two
    expect(sbs[0].frames).toHaveLength(1);
    expect(sbs[0].frames[0].prompt).toBe('start0');

    gen._setScenePlannerForTests(null);
    gen._setShotExpanderForTests(null);
    gen._setImageDispatcherForTests(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js -t "end-to-end"`
Expected: FAIL — bible not persisted (`updatedBeat.scene_bible` is null) and/or two frames seeded.

- [ ] **Step 3a: Update `runStoryboardGenerationJob` to call `planFramesV2` and persist the bible**

In `src/web/storyboardGenerate.js`, replace the `const planned = await planFrames({...})` call (lines ~648-659) with:

```js
  const { frames: planned, sceneBible } = await planFramesV2({
    beat,
    characters: characterDocs,
    targetCount: targetCount || DEFAULT_TARGET_COUNT,
    direction: direction || '',
    directorNotes,
    onProgress: (fields) => recordProgress(job, fields),
  });
  // Persist the scene bible on the beat as soon as the plan succeeds, so it
  // survives for per-shot regen (Plan 2) and the SPA editor (Plan 3), even if
  // individual row creation fails below.
  if (sceneBible && !isEmptySceneBible(sceneBible)) {
    try {
      const { setBeatSceneBible } = await import('../mongo/plots.js');
      await setBeatSceneBible(beat._id, sceneBible);
    } catch (e) {
      logger.warn(`storyboard gen: persist scene bible failed: ${e.message}`);
    }
  }
```

Add `isEmptySceneBible` to the `sceneBible.js` import added in Task C1 step 3a:

```js
import { renderSceneBibleBlock, normalizeSceneBible, isEmptySceneBible } from '../mongo/sceneBible.js';
```

Remove the now-unused `onRefineFailure`/`refineModel` wiring from that call site (they belonged to the old `planFrames`). The `job.refine_failures` field can stay (harmless) but is no longer incremented here.

- [ ] **Step 3b: Seed only the start-frame prompt in `createPlannedStoryboardEntry`**

In `createPlannedStoryboardEntry` (around line 1300-1350), replace the end-frame handling. Change:

```js
  const startFramePrompt = stripMarkdown(frame.start_frame_prompt || '').trim();
  const endFramePrompt = stripMarkdown(frame.end_frame_prompt || '').trim();
```

to:

```js
  const startFramePrompt = stripMarkdown(frame.start_frame_prompt || '').trim();
```

And change the seeding loop:

```js
  for (const prompt of [startFramePrompt, endFramePrompt]) {
    if (!prompt) continue;
```

to:

```js
  for (const prompt of [startFramePrompt]) {
    if (!prompt) continue;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js -t "end-to-end"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboardSceneGeneration.test.js
git commit -m "✨ Wire two-pass pipeline: persist bible, seed start frame only"
```

---

### Task E3: Remove the dead old pipeline + run the full suite

**Files:**
- Modify: `src/web/storyboardGenerate.js` (delete `OUTLINE_TOOL`, `REFINE_TOOL`, `OUTLINE_SYSTEM_PROMPT`, `REFINE_SYSTEM_PROMPT`, `planOutline`, `refineFramePrompts`, `synthesizeFallbackPrompts`, `planFrames`, `cleanPlannedFrame`, `buildOutlineUserText`, `buildRefinementUserText`, `formatOutlineForRefinement`, `formatPreviousRefined`, and the `_setOutlinePlannerForTests`/`_setFrameRefinerForTests` hooks), plus any consumers of the removed exports.
- Modify: `src/web/entityRoutes.js:~4367` (prompt-preview endpoint) — point it at the new prompts/builders.

- [ ] **Step 1: Find every consumer of the removed exports**

Run:
```bash
grep -rn "OUTLINE_SYSTEM_PROMPT\|REFINE_SYSTEM_PROMPT\|buildOutlineUserText\|_setOutlinePlannerForTests\|_setFrameRefinerForTests\|planFrames\b" src tests
```
Expected: hits in `src/web/storyboardGenerate.js`, `src/web/entityRoutes.js` (preview), and possibly existing storyboard tests.

- [ ] **Step 2: Update the prompt-preview endpoint**

In `src/web/entityRoutes.js`, replace the imports/usages of `OUTLINE_SYSTEM_PROMPT`/`buildOutlineUserText` with `SCENE_PLAN_SYSTEM_PROMPT`/`buildScenePlanUserText` and surface `SHOT_EXPAND_SYSTEM_PROMPT` (the preview now shows both passes). Mirror the existing response shape — read the current handler first and keep its field names, swapping only the prompt sources.

- [ ] **Step 3: Delete the dead old code**

Remove the symbols listed in the Files block above from `src/web/storyboardGenerate.js`. Keep `buildBeatContextBlock`, `formatCharacterLines`, `formatDirectorNotes`, `clampTargetCount`, `sanitizeDirection`, `synthesizeFallbackShot`, and everything in the new pipeline.

- [ ] **Step 4: Delete/replace obsolete old-pipeline tests**

Any existing test that imports `_setOutlinePlannerForTests` / `_setFrameRefinerForTests` / `planFrames` must be deleted or rewritten against the new `_setScenePlannerForTests` / `_setShotExpanderForTests` hooks. Identify them from Step 1's grep output and update each.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (whole suite green; no references to removed symbols).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "♻️ Remove legacy outline/refine pipeline; preview shows both passes"
```

---

## Self-Review (completed during planning)

**Spec coverage (Plan-1 scope only):**
- Scene bible structured fields + persistence on `plots.beats[].scene_bible` → Tasks A1, A2. ✅
- `getPlot` backfill untouched / `null` on legacy beats → Task A2 (added inside `ensureBeatIds`). ✅
- Centralized constraints module referenced by both prompts → Tasks B1, C1, D1; guard test in `tests/storyboardConstraints.test.js` + the "no duplication" assertion in C1. ✅
- Pass 1 (bible + skeleton, one call) → Task C1. ✅
- Pass 2 (holistic, two outputs, no end frame) → Task D1. ✅
- reverse_in_post simplified to two outputs → SHOT_EXPAND_TOOL + `expandShots` (inherits/overrides, no three-way inversion). ✅
- End-frame removal (no `end_frame_prompt` produced or seeded) → Tasks D1, E2, E3. ✅
- Pipeline wiring + bible persisted before row creation → Task E2. ✅

**Deferred to later plans (explicitly out of Plan-1 scope):**
- Critique panel (Pass 4), `prompt_critique`/`image_critique`, scoring UI → **Plan 2 + Plan 3**.
- Per-shot regen inheriting the bible; regen-from-critique (`critique_guidance`) → **Plan 2** (requires reading the per-frame regen / `startFrameGenerationJob` code first).
- "Re-expand shots from bible" endpoint/action; Scene Bible editor panel; `GET/PUT /api/beats/:beatId/scene-bible`; collapsed-card score badge → **Plan 3**.
- Dropping first-last-frame video models from the registry → **Plan 3** (UI/registry surface).

**Type consistency:** `normalizeSceneBible`, `renderSceneBibleBlock`, `isEmptySceneBible`, `setBeatSceneBible`, `_setScenePlannerForTests`, `_setShotExpanderForTests`, `planScene` (returns `{sceneBible, outline}`), `expandShots` (returns array of `{start_frame_prompt, video_prompt, reverse_in_post}`), `planFramesV2` (returns `{frames, sceneBible}`) — names used consistently across tasks.

**Placeholder scan:** No TBD/TODO. Each code step shows complete code; each wiring step shows the exact before/after edit anchored to a real line range. Task E3's preview-endpoint edit is the one "read first, mirror the shape" step — justified because the handler's response shape must be preserved and is short; the engineer keeps existing field names and swaps only the prompt sources.

---

## Next plans (roadmap)

- **Plan 2 — Critique panel (backend).** Four-lens panel (bible / director's-notes / cinematic / continuity) per shot, 1–10 with strict-cap aggregation; `prompt_critique` (auto, after Pass 2) + `image_critique` (on-demand, vision) on the storyboard row; `POST /api/storyboards/:id/critique`; per-shot regen inheriting the bible and accepting `critique_guidance`. Requires reading the existing per-frame regen / `startFrameGenerationJob` code first.
- **Plan 3 — SPA + registry.** Scene Bible editor panel + `GET/PUT /api/beats/:beatId/scene-bible`; "Re-expand shots from bible" action; collapsed-card score badge + threshold flag + per-lens breakdown; "Regenerate from critique" button; drop first-last-frame video models from the registry.
```
