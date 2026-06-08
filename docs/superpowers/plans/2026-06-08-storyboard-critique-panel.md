# Storyboard Critique Panel — Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-lens "critique panel" that scores each storyboard shot 1–10 with detailed comments, runs automatically on the prompts after generation and on-demand against a rendered image, and lets a shot be regenerated using the critique comments as guidance.

**Architecture:** A four-lens panel (bible-adherence, director's-notes-adherence, cinematic-quality, continuity) — each lens a forced-tool Anthropic call returning `{score, comments}`. A pure aggregator combines them with a strict cap (any lens ≤ 3 pins the overall). Results persist on the storyboard row as `prompt_critique` (auto, after generation Pass 2) and `image_critique` (on-demand, vision). A single-shot "re-expand" reruns Pass 2 for one shot, inheriting the beat's scene bible, optionally steered by the merged critique comments.

**Tech Stack:** Node ESM, MongoDB (in-memory fake in tests), Anthropic SDK (`claude-opus-4-7`, forced-tool + base64 vision), Vitest.

**Scope boundary:** This plan is BACKEND ONLY. NOT in scope (→ Plan 3): the Scene Bible editor, the collapsed-card score badge / threshold flag / per-lens breakdown UI, the "Regenerate from critique" button, "Re-expand from bible" UI, and dropping first-last-frame video models. This plan exposes the endpoints + persisted fields those UI pieces will consume.

**Builds on Plan 1** (merged): `planScene`, `expandShots`, `planFramesV2`, `renderSceneBibleBlock`, `setBeatSceneBible`, `beat.scene_bible`.

---

## Key existing APIs (verified, from code)

- `src/web/storyboardGenerate.js`: `STORYBOARD_MODEL = 'claude-opus-4-7'`; `getAnthropic()`; forced-tool pattern (`tool_choice: {type:'tool', name}`); `loadImageInput(imageId) -> {buffer, contentType, _id, description, name}|null` (ANTHROPIC_OK = png/jpeg/webp); `loadDirectorNotesForPlanner() -> notes[]`; `formatDirectorNotes(notes) -> string|null`; `renderSceneBibleBlock(bible)`; `buildBeatContextBlock(...)`; `recordProgress(job, {phase,step,frame,total,message})`; `runStoryboardGenerationJob` (the generation job — Pass 4 slots in here after rows persist); `expandShots({beat, characters, sceneBible, outline, direction, directorNotes})`.
- `src/web/storyboardGenerate.js` regen: `regenerateStoryboardFrame` / `regenerateStoryboardFrameInternal` (regenerate a frame IMAGE from the stored prompt); `startFrameGenerationJob({storyboardId, frameId, ...})`. NOTE: these regen the IMAGE, not the prompt. Regenerate-from-critique regenerates the PROMPT via a new single-shot re-expand (Milestone E).
- `src/mongo/storyboards.js`: `getStoryboard(id)`, `listStoryboards({beatId})` (sorted by order), `getPreviousStoryboardInBeat(beatId, order)`, `updateStoryboard(id, patch)` (whitelisted per-key switch; `backfill(doc)`; `createStoryboard(...)`). A storyboard row carries `text_prompt` (the video prompt + shot header, markdown), `summary` (one-sentence description), `frames[]` (frames[0].prompt = the start-frame still prompt; frames[0].image_id = rendered image), `shot_type`, `duration_seconds`, `transition_in`, `characters_in_scene`, `reverse_in_post`.
- `src/mongo/plots.js`: `getBeat(id)` → beat with `scene_bible`, `characters`.
- `src/mongo/images.js`: `readImageBuffer(imageId) -> {buffer, file}|null`.
- `src/web/gateway.js`: `broadcastFieldsUpdated(roomName, payload)`; room name via `buildRoomName('storyboards', beatId)` → `storyboards:<beatId>`. Non-text mutations write Mongo + broadcast a `{type:'fields_updated'}` ping.
- `src/web/entityRoutes.js`: `router.use(requireSession())`; storyboard endpoints; `resolveStoryboardId(req)`; `isOidHex(...)`; job-poll route pattern `GET /storyboards/generate/:jobId`.
- Vision pattern (`src/llm/referenceImageDescription.js`): `content: [{type:'text',text}, {type:'image', source:{type:'base64', media_type, data: buf.toString('base64')}}]`.

---

## File Structure

**New files:**
- `src/web/storyboardCritique.js` — the critique engine: lens definitions, the pure `aggregateCritique`, the per-lens Anthropic judge, the `critiquePanel` (runs 4 lenses + aggregates), and the user-text/context builders. Test seams for the judge.
- `tests/storyboardCritiqueAggregate.test.js` — unit tests for `aggregateCritique` + lens defs.
- `tests/storyboardCritiquePanel.test.js` — panel tests via the judge override seam.
- `tests/storyboards-critique-fields.test.js` — schema persistence tests.
- `tests/storyboardCritiqueGeneration.test.js` — auto Pass-4 + on-demand endpoint integration tests (fake Mongo + override seams).

**Modified files:**
- `src/mongo/storyboards.js` — add `prompt_critique` / `image_critique` object fields (createStoryboard init, backfill, updateStoryboard validation).
- `src/web/gateway.js` — add `setStoryboardCritiqueViaGateway({storyboardId, beatId, target, critique})`.
- `src/web/storyboardGenerate.js` — auto Pass-4 hook in `runStoryboardGenerationJob`; `expandShots`/`buildShotExpandUserText` gain an optional `revisionNotes`; new `reExpandShot(...)` single-shot prompt regen + its job; export `critiquePanel` plumbing for the endpoint.
- `src/web/entityRoutes.js` — `POST /storyboard/:id/critique` (on-demand, `?target=prompt|image`), `GET /storyboard/critique/job/:jobId`, `POST /storyboard/:id/reexpand` (regen prompt, optional `critique_guidance`).

---

## Milestone A — Persisted critique fields

### Task A1: Add `prompt_critique` / `image_critique` to the storyboard schema

**Files:**
- Modify: `src/mongo/storyboards.js` — `createStoryboard` (init), `backfill`, `updateStoryboard` (validation).
- Test: `tests/storyboards-critique-fields.test.js`

The critique shape (documented, not enforced field-by-field — stored as a validated object):
```
{ overall: number, lenses: [{ lens: string, score: number, comments: string }], model: string, created_at: Date }
```

- [ ] **Step 1: Write the failing test**

```js
// tests/storyboards-critique-fields.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createStoryboard, getStoryboard, updateStoryboard } = await import(
  '../src/mongo/storyboards.js'
);

const SAMPLE = {
  overall: 7,
  lenses: [{ lens: 'bible', score: 7, comments: 'ok' }],
  model: 'claude-opus-4-7',
  created_at: new Date(),
};

describe('storyboard critique fields', () => {
  beforeEach(() => fakeDb.reset());

  it('new rows default prompt_critique/image_critique to null', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    expect(sb.prompt_critique).toBeNull();
    expect(sb.image_critique).toBeNull();
  });

  it('updateStoryboard accepts a prompt_critique object and persists it', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    const updated = await updateStoryboard(sb._id, { prompt_critique: SAMPLE });
    expect(updated.prompt_critique.overall).toBe(7);
    expect(updated.prompt_critique.lenses[0].lens).toBe('bible');
    const reread = await getStoryboard(sb._id);
    expect(reread.prompt_critique.overall).toBe(7);
  });

  it('updateStoryboard accepts null to clear image_critique', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    await updateStoryboard(sb._id, { image_critique: SAMPLE });
    const cleared = await updateStoryboard(sb._id, { image_critique: null });
    expect(cleared.image_critique).toBeNull();
  });

  it('updateStoryboard rejects a non-object prompt_critique', async () => {
    const sb = await createStoryboard({ beatId: '0'.repeat(24), order: 1 });
    await expect(updateStoryboard(sb._id, { prompt_critique: 'nope' })).rejects.toThrow(
      /prompt_critique/,
    );
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

Run: `npx vitest run tests/storyboards-critique-fields.test.js`
Expected: FAIL — fields default to `undefined`; `updateStoryboard` throws `unknown field "prompt_critique"`.

- [ ] **Step 3a: Init in `createStoryboard`**

In the `doc` object literal inside `createStoryboard` (alongside `video_parameters: null` etc.), add:
```js
    prompt_critique: null,
    image_critique: null,
```

- [ ] **Step 3b: Backfill in `backfill(doc)`**

In the returned object of `backfill`, add (mirroring the `video_parameters` style — object-or-null):
```js
    prompt_critique:
      doc.prompt_critique && typeof doc.prompt_critique === 'object' && !Array.isArray(doc.prompt_critique)
        ? doc.prompt_critique
        : null,
    image_critique:
      doc.image_critique && typeof doc.image_critique === 'object' && !Array.isArray(doc.image_critique)
        ? doc.image_critique
        : null,
```

- [ ] **Step 3c: Validate in `updateStoryboard`**

In the per-key `for` loop's switch, add a branch before the final `else { throw ... }`:
```js
    } else if (k === 'prompt_critique' || k === 'image_critique') {
      if (v == null) {
        set[k] = null;
      } else if (typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`update_storyboard: ${k} must be an object or null`);
      } else {
        set[k] = v;
      }
```

- [ ] **Step 4: Run test, confirm PASS**

Run: `npx vitest run tests/storyboards-critique-fields.test.js`

- [ ] **Step 5: Regression + commit**

Run: `npx vitest run tests/storyboards.test.js`
```bash
git add src/mongo/storyboards.js tests/storyboards-critique-fields.test.js
git commit -m "✨ Add prompt_critique/image_critique fields to storyboard schema"
```

---

## Milestone B — Critique engine

### Task B1: Lens definitions + strict-cap aggregation (pure)

**Files:**
- Create: `src/web/storyboardCritique.js` (first slice — pure parts only)
- Test: `tests/storyboardCritiqueAggregate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/storyboardCritiqueAggregate.test.js
import { describe, it, expect } from 'vitest';
import { CRITIQUE_LENSES, aggregateCritique, clampScore } from '../src/web/storyboardCritique.js';

describe('CRITIQUE_LENSES', () => {
  it('defines the four lenses with key + instruction', () => {
    const keys = CRITIQUE_LENSES.map((l) => l.key);
    expect(keys).toEqual(['bible', 'director_notes', 'cinematic', 'continuity']);
    for (const l of CRITIQUE_LENSES) expect(l.instruction.length).toBeGreaterThan(0);
  });
});

describe('clampScore', () => {
  it('coerces to an integer in 1..10', () => {
    expect(clampScore(0)).toBe(1);
    expect(clampScore(11)).toBe(10);
    expect(clampScore(7.4)).toBe(7);
    expect(clampScore('nope')).toBe(1);
  });
});

describe('aggregateCritique', () => {
  it('overall is the rounded mean when no lens is critical', () => {
    const r = aggregateCritique([
      { lens: 'bible', score: 8, comments: '' },
      { lens: 'director_notes', score: 7, comments: '' },
      { lens: 'cinematic', score: 9, comments: '' },
      { lens: 'continuity', score: 8, comments: '' },
    ]);
    expect(r.overall).toBe(8); // mean 8.0
    expect(r.lowest_lens).toBe('director_notes');
  });

  it('caps overall at a critical lens score (<= 3)', () => {
    const r = aggregateCritique([
      { lens: 'bible', score: 9, comments: '' },
      { lens: 'director_notes', score: 9, comments: '' },
      { lens: 'cinematic', score: 2, comments: 'breaks the look' },
      { lens: 'continuity', score: 9, comments: '' },
    ]);
    // mean would be ~7, but a critical lens pins it to 2
    expect(r.overall).toBe(2);
    expect(r.lowest_lens).toBe('cinematic');
  });

  it('caps at the LOWEST critical lens when several are critical', () => {
    const r = aggregateCritique([
      { lens: 'bible', score: 3, comments: '' },
      { lens: 'director_notes', score: 1, comments: '' },
      { lens: 'cinematic', score: 8, comments: '' },
      { lens: 'continuity', score: 8, comments: '' },
    ]);
    expect(r.overall).toBe(1);
    expect(r.lowest_lens).toBe('director_notes');
  });

  it('returns overall 1 + empty lowest for an empty lens list', () => {
    const r = aggregateCritique([]);
    expect(r.overall).toBe(1);
    expect(r.lowest_lens).toBe(null);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL** (`npx vitest run tests/storyboardCritiqueAggregate.test.js`).

- [ ] **Step 3: Implement the pure slice of `src/web/storyboardCritique.js`**

```js
// src/web/storyboardCritique.js
// Multi-lens critique panel for storyboard shots. Each lens is an independent
// forced-tool Anthropic call scoring 1–10 with comments; aggregateCritique
// combines them with a strict cap (any lens <= CRITICAL_SCORE pins the overall
// so one hard failure can't be averaged away).

export const CRITICAL_SCORE = 3;

// The four judging lenses. `key` is persisted; `label` is human-facing; `focus`
// is the one-line system-prompt framing for that lens; `instruction` is the
// reminder injected into the judge's user text.
export const CRITIQUE_LENSES = Object.freeze([
  {
    key: 'bible',
    label: 'Bible adherence',
    focus: 'how faithfully the shot honors the scene bible',
    instruction:
      'Judge ONLY whether the shot honors the scene bible — location, time of day, lighting key, palette, mood, blocking, and camera language. Reward consistency; penalize drift or contradiction.',
  },
  {
    key: 'director_notes',
    label: "Director's-notes adherence",
    focus: "how well the shot respects the project-wide director's notes",
    instruction:
      "Judge ONLY whether the shot respects the project-wide director's notes (global tone / style / continuity directives). If there are no notes, score 8 and say so.",
  },
  {
    key: 'cinematic',
    label: 'Cinematic quality',
    focus: 'the cinematic merit of the shot',
    instruction:
      'Judge ONLY cinematic merit — composition, shot value, framing choice, and whether this shot earns its place in the sequence. Ignore bible/notes adherence (other lenses cover those).',
  },
  {
    key: 'continuity',
    label: 'Continuity',
    focus: 'how cleanly the shot hands off to and from its neighbors',
    instruction:
      'Judge ONLY continuity with the neighbor shots shown — does this shot hand off cleanly (shared subject, matching motion vector, deliberate match cut)? Penalize jarring jumps or drift between neighbors.',
  },
]);

const LENS_KEYS = new Set(CRITIQUE_LENSES.map((l) => l.key));

// Coerce a model-provided score to an integer in [1, 10].
export function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.min(10, Math.max(1, Math.round(v)));
}

// Combine per-lens results into { overall, lowest_lens }. overall = rounded mean,
// but if any lens scored <= CRITICAL_SCORE the overall is capped at the lowest
// such score. lowest_lens names the worst-scoring lens (tie → first by score).
export function aggregateCritique(lensResults) {
  const lenses = (Array.isArray(lensResults) ? lensResults : []).filter(
    (l) => l && LENS_KEYS.has(l.lens),
  );
  if (!lenses.length) return { overall: 1, lowest_lens: null };
  const scores = lenses.map((l) => clampScore(l.score));
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  let overall = Math.min(10, Math.max(1, Math.round(mean)));
  const critical = scores.filter((s) => s <= CRITICAL_SCORE);
  if (critical.length) overall = Math.min(overall, ...critical);
  // lowest_lens = the lens with the minimum score (first one on ties)
  let lowest = lenses[0];
  let lowestScore = clampScore(lenses[0].score);
  for (const l of lenses) {
    const s = clampScore(l.score);
    if (s < lowestScore) {
      lowest = l;
      lowestScore = s;
    }
  }
  return { overall, lowest_lens: lowest.lens };
}
```

- [ ] **Step 4: Run test, confirm PASS.**

- [ ] **Step 5: Commit**
```bash
git add src/web/storyboardCritique.js tests/storyboardCritiqueAggregate.test.js
git commit -m "✨ Add critique lens defs + strict-cap aggregation"
```

---

### Task B2: The judge + panel (Anthropic, prompt & image tier)

**Files:**
- Modify: `src/web/storyboardCritique.js` — add the context builder, the single-lens judge (forced-tool Anthropic call, optional image), the `critiquePanel`, and a `_setLensJudgeForTests` seam.
- Test: `tests/storyboardCritiquePanel.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/storyboardCritiquePanel.test.js
import { describe, it, expect, vi } from 'vitest';
import {
  buildShotCritiqueContext,
  critiquePanel,
  _setLensJudgeForTests,
} from '../src/web/storyboardCritique.js';

describe('buildShotCritiqueContext', () => {
  it('includes the bible block, director notes, the shot prompts, and neighbors', () => {
    const text = buildShotCritiqueContext({
      sceneBible: { location: 'Diner', mood: 'tense' },
      directorNotes: [{ text: 'Keep it cold and quiet.' }],
      shot: { order: 2, summary: 'Sarah looks up', text_prompt: 'She lifts her gaze. Camera holds.', startFramePrompt: 'Sarah at the counter, medium shot.', shot_type: 'close_up' },
      prevShot: { order: 1, summary: 'Wide of the diner', startFramePrompt: 'Empty diner, establishing.' },
      nextShot: null,
    });
    expect(text).toContain('Diner');
    expect(text).toContain('Keep it cold and quiet.');
    expect(text).toContain('She lifts her gaze');
    expect(text).toContain('Sarah at the counter');
    expect(text).toContain('Empty diner'); // neighbor
  });
});

describe('critiquePanel', () => {
  it('runs all four lenses and aggregates (strict cap)', async () => {
    // Override: bible scores low (2) → strict cap to 2; others high.
    _setLensJudgeForTests(async ({ lens }) => {
      const score = lens.key === 'bible' ? 2 : 9;
      return { score, comments: `${lens.key} says ${score}` };
    });
    const result = await critiquePanel({
      target: 'prompt',
      sceneBible: { location: 'Diner' },
      directorNotes: [],
      shot: { order: 1, summary: 's', text_prompt: 'tp', startFramePrompt: 'sf' },
      prevShot: null,
      nextShot: null,
    });
    expect(result.lenses).toHaveLength(4);
    expect(result.lenses.map((l) => l.lens).sort()).toEqual(
      ['bible', 'cinematic', 'continuity', 'director_notes'],
    );
    expect(result.overall).toBe(2); // strict cap from the bible lens
    expect(result.lowest_lens).toBe('bible');
    expect(typeof result.model).toBe('string');
    expect(result.created_at).toBeInstanceOf(Date);
    _setLensJudgeForTests(null);
  });

  it('passes the image buffer to the judge on the image tier', async () => {
    let sawImage = false;
    _setLensJudgeForTests(async ({ imageInput }) => {
      if (imageInput && imageInput.buffer) sawImage = true;
      return { score: 6, comments: 'ok' };
    });
    await critiquePanel({
      target: 'image',
      sceneBible: {},
      directorNotes: [],
      shot: { order: 1, summary: 's', text_prompt: 'tp', startFramePrompt: 'sf' },
      prevShot: null,
      nextShot: null,
      imageInput: { buffer: Buffer.from('x'), contentType: 'image/png' },
    });
    expect(sawImage).toBe(true);
    _setLensJudgeForTests(null);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL** (`npx vitest run tests/storyboardCritiquePanel.test.js`).

- [ ] **Step 3: Implement. Append to `src/web/storyboardCritique.js`:**

```js
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { renderSceneBibleBlock } from '../mongo/sceneBible.js';

// Hardcoded top-tier model, matching the rest of the storyboard surface.
const CRITIQUE_MODEL = 'claude-opus-4-7';

// Forced-tool schema: every lens judge returns one score + comments.
const JUDGE_TOOL = {
  name: 'judge_shot',
  description: 'Return a 1–10 score and detailed improvement comments for this shot, for your assigned lens only.',
  input_schema: {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 1, maximum: 10, description: '1 = unusable, 10 = excellent, for your assigned lens only.' },
      comments: { type: 'string', description: 'Specific, actionable notes on what to change/improve for this lens. 1–4 sentences.' },
    },
    required: ['score', 'comments'],
    additionalProperties: false,
  },
};

function formatNeighbor(label, shot) {
  if (!shot) return `${label}: (none)`;
  const sf = stripMarkdown(shot.startFramePrompt || '').trim();
  const summ = stripMarkdown(shot.summary || '').trim();
  return `${label} (shot ${shot.order ?? '?'}): ${summ || '(no summary)'}${sf ? ` | start frame: ${sf}` : ''}`;
}

// Shared context block every lens judge sees for one shot.
export function buildShotCritiqueContext({ sceneBible, directorNotes, shot, prevShot, nextShot }) {
  const lines = [];
  const bibleBlock = renderSceneBibleBlock(sceneBible);
  if (bibleBlock) lines.push('# Scene bible (the agreed look):', bibleBlock, '');
  const notes = formatDirectorNotesForCritique(directorNotes);
  if (notes) lines.push("# Director's notes (project-wide):", notes, '');
  lines.push(
    '# Shot under review:',
    `order: ${shot.order ?? '?'}`,
    `shot_type: ${shot.shot_type || '(unset)'}`,
    `summary: ${stripMarkdown(shot.summary || '').trim() || '(none)'}`,
    `prompt (video/action): ${stripMarkdown(shot.text_prompt || '').trim() || '(none)'}`,
    `start-frame prompt: ${stripMarkdown(shot.startFramePrompt || '').trim() || '(none)'}`,
    '',
    '# Neighbors (for continuity):',
    formatNeighbor('Previous', prevShot),
    formatNeighbor('Next', nextShot),
  );
  return lines.join('\n');
}

// Local copy of the director-notes formatter (storyboardGenerate has one too,
// but we keep this module self-contained). Accepts the notes[] array.
function formatDirectorNotesForCritique(directorNotes) {
  if (!Array.isArray(directorNotes) || !directorNotes.length) return null;
  const items = directorNotes
    .map((n) => stripMarkdown(typeof n?.text === 'string' ? n.text : '').trim())
    .filter(Boolean);
  return items.length ? items.map((t) => `- ${t}`).join('\n') : null;
}

let lensJudgeOverride = null;
export function _setLensJudgeForTests(fn) {
  lensJudgeOverride = fn;
}

// Run ONE lens judge. `target` is 'prompt' | 'image'. On the image tier,
// imageInput {buffer, contentType} is attached as a base64 image block.
async function runLensJudge({ lens, target, context, imageInput }) {
  if (lensJudgeOverride) return lensJudgeOverride({ lens, target, context, imageInput });
  const system = [
    `You are a strict film director reviewing ONE storyboard shot through a single lens: ${lens.focus}.`,
    lens.instruction,
    'Score 1–10 (1 = unusable, 10 = excellent) and give specific, actionable comments. Be exacting; do not inflate scores.',
    target === 'image'
      ? 'You are judging the RENDERED START-FRAME IMAGE attached below against the shot description and the context.'
      : 'You are judging the WRITTEN PROMPTS (no image yet) against the context.',
    'Return your verdict via the judge_shot tool.',
  ].join('\n');
  const content = [{ type: 'text', text: context }];
  if (target === 'image' && imageInput?.buffer && imageInput?.contentType) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: imageInput.contentType, data: imageInput.buffer.toString('base64') },
    });
  }
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: CRITIQUE_MODEL,
    max_tokens: 600,
    system,
    tools: [JUDGE_TOOL],
    tool_choice: { type: 'tool', name: 'judge_shot' },
    messages: [{ role: 'user', content }],
  });
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'judge_shot');
  if (!toolUse?.input) {
    logger.warn(`storyboard critique: lens ${lens.key} returned no tool call`);
    return { score: 1, comments: '(judge produced no verdict)' };
  }
  return {
    score: toolUse.input.score,
    comments: typeof toolUse.input.comments === 'string' ? toolUse.input.comments : '',
  };
}

// Run all four lenses (in parallel) for one shot and aggregate. Returns the
// persisted critique shape: { overall, lowest_lens, lenses[], model, created_at }.
export async function critiquePanel({ target, sceneBible, directorNotes, shot, prevShot, nextShot, imageInput = null }) {
  const context = buildShotCritiqueContext({ sceneBible, directorNotes, shot, prevShot, nextShot });
  const lensResults = await Promise.all(
    CRITIQUE_LENSES.map(async (lens) => {
      try {
        const { score, comments } = await runLensJudge({ lens, target, context, imageInput });
        return { lens: lens.key, score: clampScore(score), comments: String(comments || '') };
      } catch (e) {
        logger.warn(`storyboard critique: lens ${lens.key} failed: ${e?.message || e}`);
        return { lens: lens.key, score: 1, comments: `(lens failed: ${e?.message || e})` };
      }
    }),
  );
  const { overall, lowest_lens } = aggregateCritique(lensResults);
  return { overall, lowest_lens, lenses: lensResults, model: CRITIQUE_MODEL, created_at: new Date(), target };
}
```

- [ ] **Step 4: Run test, confirm PASS.**

- [ ] **Step 5: Commit**
```bash
git add src/web/storyboardCritique.js tests/storyboardCritiquePanel.test.js
git commit -m "✨ Add critique panel: four-lens judge (prompt + image tier)"
```

---

## Milestone C — Persist critique via the gateway

### Task C1: `setStoryboardCritiqueViaGateway`

**Files:**
- Modify: `src/web/gateway.js` — add the helper.
- Test: covered indirectly by the integration test in Task D (no separate unit test — the gateway's Hocuspocus-vs-Mongo fallback is exercised there). If you prefer a direct test, add one to `tests/storyboards-critique-fields.test.js`.

- [ ] **Step 1: Read `src/web/gateway.js`** — find how non-text mutations write Mongo + broadcast (e.g. the storyboard create/delete helpers calling `updateStoryboard`/`broadcastFieldsUpdated` and `buildRoomName('storyboards', beatId)`). Mirror that exact pattern.

- [ ] **Step 2: Add the helper** (adapt names to the file's conventions):
```js
// Persist a shot's critique (prompt_critique or image_critique) and notify the
// storyboards room so connected SPAs re-render the score. `target` is
// 'prompt' | 'image'. critique is the object from critiquePanel (or null).
export async function setStoryboardCritiqueViaGateway({ storyboardId, beatId, target, critique }) {
  const field = target === 'image' ? 'image_critique' : 'prompt_critique';
  const updated = await updateStoryboard(storyboardId, { [field]: critique });
  try {
    broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
      changed: ['critique'],
      storyboard_id: String(storyboardId),
      critique_target: target,
    });
  } catch (e) {
    logger.warn(`gateway: critique broadcast failed: ${e?.message || e}`);
  }
  return updated;
}
```
Ensure `updateStoryboard`, `broadcastFieldsUpdated`, `buildRoomName`, `logger` are imported in gateway.js (most already are — verify and add only what's missing).

- [ ] **Step 3: Verify nothing else broke**
Run: `npx vitest run tests/storyboard-gateway.test.js` (if present) and `npx vitest run tests/storyboards.test.js`.

- [ ] **Step 4: Commit**
```bash
git add src/web/gateway.js
git commit -m "✨ Add setStoryboardCritiqueViaGateway (persist + broadcast)"
```

---

## Milestone D — Wiring: auto Pass-4 + on-demand endpoint

### Task D1: Auto prompt-critique as generation Pass 4

**Files:**
- Modify: `src/web/storyboardGenerate.js` — at the end of `runStoryboardGenerationJob`, after all rows are persisted and before the announce, critique each row's prompts and persist `prompt_critique`. Add a `critiqueShotsForBeat` helper + a `_setCritiquePanelForTests` seam (so the integration test can stub the panel without Anthropic).
- Test: `tests/storyboardCritiqueGeneration.test.js`

- [ ] **Step 1: Write the failing test** (auto path):
```js
// tests/storyboardCritiqueGeneration.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const gen = await import('../src/web/storyboardGenerate.js');

async function drain(jobId) {
  for (let i = 0; i < 200; i++) {
    const job = gen.getStoryboardGenerationJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  return gen.getStoryboardGenerationJob(jobId);
}

describe('auto prompt-critique (Pass 4)', () => {
  beforeEach(() => fakeDb.reset());

  it('critiques each generated row and persists prompt_critique', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    await createBeat({ name: 'CritBeat', desc: 'scene', characters: [] });
    const beat = await getBeat('CritBeat');

    gen._setScenePlannerForTests(() => ({
      sceneBible: { location: 'Diner' },
      outline: [
        { description: 'wide', shot_type: 'establishing', duration_seconds: 6 },
        { description: 'close', shot_type: 'close_up', duration_seconds: 3 },
      ],
    }));
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({ start_frame_prompt: `s${i}`, video_prompt: `v${i}`, reverse_in_post: false })),
    );
    gen._setImageDispatcherForTests(() => { throw new Error('no render'); });
    let panelCalls = 0;
    gen._setCritiquePanelForTests(async () => {
      panelCalls += 1;
      return {
        overall: 8, lowest_lens: 'cinematic',
        lenses: [{ lens: 'bible', score: 8, comments: 'ok' }],
        model: 'test', created_at: new Date(), target: 'prompt',
      };
    });

    const jobId = await gen.startStoryboardGenerationJob({ beatId: beat._id.toString(), targetCount: 2 });
    const job = await drain(jobId);
    expect(job.status).not.toBe('error');
    expect(panelCalls).toBe(2); // one panel per row

    const { listStoryboards } = await import('../src/mongo/storyboards.js');
    const sbs = await listStoryboards({ beatId: beat._id });
    expect(sbs).toHaveLength(2);
    for (const sb of sbs) {
      expect(sb.prompt_critique.overall).toBe(8);
      expect(sb.image_critique).toBeNull();
    }

    gen._setScenePlannerForTests(null);
    gen._setShotExpanderForTests(null);
    gen._setImageDispatcherForTests(null);
    gen._setCritiquePanelForTests(null);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL** (`_setCritiquePanelForTests` undefined / no prompt_critique persisted).

- [ ] **Step 3a: Add imports + the panel seam in storyboardGenerate.js**
```js
import { critiquePanel as defaultCritiquePanel } from './storyboardCritique.js';
import { setStoryboardCritiqueViaGateway } from './gateway.js';
```
```js
let critiquePanelOverride = null;
export function _setCritiquePanelForTests(fn) {
  critiquePanelOverride = fn;
}
function runCritiquePanel(args) {
  return (critiquePanelOverride || defaultCritiquePanel)(args);
}
```

- [ ] **Step 3b: Add `critiqueShotsForBeat`** (sequential over rows so progress reads cleanly; lenses already run in parallel inside the panel):
```js
// Pass 4: auto prompt-tier critique. Runs the four-lens panel over every shot
// of the beat against the scene bible + director's notes + neighbors, and
// persists prompt_critique per row. Failures are swallowed per row so a bad
// critique never fails the generation job.
async function critiqueShotsForBeat({ beat, sceneBible, directorNotes, onProgress = null }) {
  const { listStoryboards } = await import('../mongo/storyboards.js');
  const shots = await listStoryboards({ beatId: beat._id });
  for (let i = 0; i < shots.length; i++) {
    const sb = shots[i];
    onProgress?.({ phase: 'critiquing', step: 'critique_shot_start', frame: i + 1, total: shots.length, message: `Critiquing shot ${i + 1}/${shots.length}…` });
    try {
      const shot = {
        order: sb.order,
        summary: sb.summary,
        text_prompt: sb.text_prompt,
        startFramePrompt: sb.frames?.[0]?.prompt || '',
        shot_type: sb.shot_type,
      };
      const prevShot = i > 0 ? toCritiqueNeighbor(shots[i - 1]) : null;
      const nextShot = i < shots.length - 1 ? toCritiqueNeighbor(shots[i + 1]) : null;
      const critique = await runCritiquePanel({
        target: 'prompt', sceneBible, directorNotes, shot, prevShot, nextShot,
      });
      await setStoryboardCritiqueViaGateway({ storyboardId: sb._id, beatId: beat._id, target: 'prompt', critique });
    } catch (e) {
      logger.warn(`storyboard critique: shot ${i + 1} failed: ${e?.message || e}`);
    }
  }
}

function toCritiqueNeighbor(sb) {
  return { order: sb.order, summary: sb.summary, startFramePrompt: sb.frames?.[0]?.prompt || '' };
}
```

- [ ] **Step 3c: Call Pass 4 in `runStoryboardGenerationJob`**, after the render loop completes and before the announce block. Use the `sceneBible` already returned by `planFramesV2` and the `directorNotes` already loaded earlier in the function:
```js
  // Pass 4: auto prompt-critique. Best-effort — wrapped so a failure never
  // flips the job to error after the rows already landed.
  if (job.completed > 0) {
    job.status = 'critiquing';
    recordProgress(job, { phase: 'critiquing', step: 'critique_start', total: planned.length, message: 'Critiquing shots…' });
    try {
      await critiqueShotsForBeat({
        beat,
        sceneBible,
        directorNotes,
        onProgress: (fields) => recordProgress(job, fields),
      });
    } catch (e) {
      logger.warn(`storyboard gen: critique pass failed: ${e.message}`);
    }
  }
```
(Place this so the subsequent `job.status = job.failed === 0 ? 'done' : 'partial'` line still runs afterward and is the final status. If the existing code sets the final status before this point, move the Pass-4 block ABOVE the final-status assignment. Read the function and place accordingly so the terminal status is still `done`/`partial`.)

- [ ] **Step 4: Run test, confirm PASS** (`npx vitest run tests/storyboardCritiqueGeneration.test.js`).

- [ ] **Step 5: Regression + commit**
Run: `npx vitest run tests/storyboardSceneGeneration.test.js tests/storyboard-generate.test.js`
```bash
git add src/web/storyboardGenerate.js tests/storyboardCritiqueGeneration.test.js
git commit -m "✨ Auto prompt-critique (Pass 4) at end of generation"
```

---

### Task D2: On-demand critique endpoint + job + vision tier

**Files:**
- Modify: `src/web/storyboardGenerate.js` — add `startCritiqueJob({ storyboardId, target })` (in-memory job, mirrors the frame-job tracker) that loads the row + beat bible + director's notes + neighbors, loads the rendered image for the image tier (`loadImageInput(frames[0].image_id)`), runs `runCritiquePanel`, persists via `setStoryboardCritiqueViaGateway`, and a `getCritiqueJob(jobId)`.
- Modify: `src/web/entityRoutes.js` — `POST /storyboard/:id/critique?target=prompt|image` (202 + job_id), `GET /storyboard/critique/job/:jobId`.
- Test: append to `tests/storyboardCritiqueGeneration.test.js`.

- [ ] **Step 1: Write the failing test** (on-demand, both tiers):
```js
describe('on-demand critique job', () => {
  beforeEach(() => fakeDb.reset());

  it('prompt-tier: critiques a single row on demand', async () => {
    const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
    const { createStoryboard, getStoryboard } = await import('../src/mongo/storyboards.js');
    await createBeat({ name: 'OnDemand', desc: 'x', characters: [] });
    const beat = await getBeat('OnDemand');
    await setBeatSceneBible('OnDemand', { location: 'Diner' });
    const sb = await createStoryboard({ beatId: beat._id, order: 1, textPrompt: 'tp', summary: 'a shot' });

    gen._setCritiquePanelForTests(async ({ target }) => ({
      overall: 5, lowest_lens: 'continuity',
      lenses: [{ lens: 'bible', score: 5, comments: 'meh' }],
      model: 'test', created_at: new Date(), target,
    }));

    const jobId = await gen.startCritiqueJob({ storyboardId: sb._id.toString(), target: 'prompt' });
    for (let i = 0; i < 100; i++) {
      const j = gen.getCritiqueJob(jobId);
      if (j && ['done', 'error'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const j = gen.getCritiqueJob(jobId);
    expect(j.status).toBe('done');
    const reread = await getStoryboard(sb._id);
    expect(reread.prompt_critique.overall).toBe(5);
    gen._setCritiquePanelForTests(null);
  });

  it('image-tier errors cleanly when the row has no rendered image', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    const { createStoryboard } = await import('../src/mongo/storyboards.js');
    await createBeat({ name: 'NoImg', desc: 'x', characters: [] });
    const beat = await getBeat('NoImg');
    const sb = await createStoryboard({ beatId: beat._id, order: 1, summary: 's' });

    const jobId = await gen.startCritiqueJob({ storyboardId: sb._id.toString(), target: 'image' });
    for (let i = 0; i < 100; i++) {
      const j = gen.getCritiqueJob(jobId);
      if (j && ['done', 'error'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const j = gen.getCritiqueJob(jobId);
    expect(j.status).toBe('error');
    expect(j.error).toMatch(/no rendered image|image/i);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL** (`startCritiqueJob`/`getCritiqueJob` undefined).

- [ ] **Step 3a: Implement `startCritiqueJob` + `getCritiqueJob`** in storyboardGenerate.js (mirror the existing `frameJobs` Map + `makeJobId` + status flow). Key logic:
```js
const critiqueJobs = new Map();
export function getCritiqueJob(jobId) { return critiqueJobs.get(jobId) || null; }

// Critique one shot on demand. target 'prompt' judges the written prompts;
// 'image' judges the rendered start-frame image (errors if none rendered).
export async function startCritiqueJob({ storyboardId, target = 'prompt' }) {
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beat = await getBeat(sb.beat_id.toString());
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  const jobId = makeJobId();
  const job = { job_id: jobId, storyboard_id: String(sb._id), beat_id: String(beat._id), target, status: 'queued', started_at: new Date(), finished_at: null, error: null, overall: null };
  critiqueJobs.set(jobId, job);
  // fire-and-forget
  (async () => {
    job.status = 'running';
    try {
      const directorNotes = await loadDirectorNotesForPlanner();
      const { listStoryboards } = await import('../mongo/storyboards.js');
      const shots = await listStoryboards({ beatId: beat._id });
      const idx = shots.findIndex((s) => String(s._id) === String(sb._id));
      const prevShot = idx > 0 ? toCritiqueNeighbor(shots[idx - 1]) : null;
      const nextShot = idx >= 0 && idx < shots.length - 1 ? toCritiqueNeighbor(shots[idx + 1]) : null;
      let imageInput = null;
      if (target === 'image') {
        const imgId = sb.frames?.[0]?.image_id;
        if (!imgId) throw new Error('no rendered image to critique on this shot');
        imageInput = await loadImageInput(imgId);
        if (!imageInput) throw new Error('rendered image could not be read or is an unsupported type');
      }
      const shot = { order: sb.order, summary: sb.summary, text_prompt: sb.text_prompt, startFramePrompt: sb.frames?.[0]?.prompt || '', shot_type: sb.shot_type };
      const critique = await runCritiquePanel({ target, sceneBible: beat.scene_bible, directorNotes, shot, prevShot, nextShot, imageInput });
      await setStoryboardCritiqueViaGateway({ storyboardId: sb._id, beatId: beat._id, target, critique });
      job.overall = critique.overall;
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      logger.warn(`storyboard critique job ${jobId} failed: ${e.message}`);
    } finally {
      job.finished_at = new Date();
    }
  })();
  return jobId;
}
```
(Confirm `getStoryboard`, `getBeat`, `loadImageInput`, `loadDirectorNotesForPlanner`, `makeJobId`, `toCritiqueNeighbor`, `runCritiquePanel`, `setStoryboardCritiqueViaGateway` are all in scope — add imports if needed. `getStoryboard` may need importing from `../mongo/storyboards.js` if not already.)

- [ ] **Step 3b: Add the routes** in entityRoutes.js (mirror the frame-generate endpoint + job-poll patterns; under `requireSession()`):
```js
router.post('/storyboard/:id/critique', async (req, res, next) => {
  try {
    const sbId = await resolveStoryboardId(req);
    if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
    const target = req.query?.target === 'image' ? 'image' : 'prompt';
    const { startCritiqueJob } = await import('./storyboardGenerate.js');
    const jobId = await startCritiqueJob({ storyboardId: sbId, target });
    res.status(202).json({ job_id: jobId, storyboard_id: sbId, target });
  } catch (e) { next(e); }
});

router.get('/storyboard/critique/job/:jobId', async (req, res, next) => {
  try {
    const { getCritiqueJob } = await import('./storyboardGenerate.js');
    const job = getCritiqueJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ job });
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Run test, confirm PASS.**

- [ ] **Step 5: Regression + commit**
Run: `npx vitest run tests/storyboardCritiqueGeneration.test.js`
```bash
git add src/web/storyboardGenerate.js src/web/entityRoutes.js tests/storyboardCritiqueGeneration.test.js
git commit -m "✨ On-demand critique endpoint + vision-tier job"
```

---

## Milestone E — Regenerate-from-critique (single-shot re-expand)

### Task E1: `expandShots` accepts optional `revisionNotes`

**Files:**
- Modify: `src/web/storyboardGenerate.js` — `buildShotExpandUserText` and `expandShots` accept an optional `revisionNotes` string appended to the user text. Backward compatible (omitted → no change).
- Test: append to `tests/storyboardSceneGeneration.test.js`.

- [ ] **Step 1: Write the failing test**
```js
describe('expandShots revisionNotes', () => {
  it('includes revision notes in the user text when provided', () => {
    const text = gen.buildShotExpandUserText({
      beat: { name: 'X', order: 1, body: '', desc: '', characters: [] },
      characters: [],
      sceneBible: { location: 'Diner' },
      outline: [{ description: 'a', shot_type: 'medium', duration_seconds: 4 }],
      direction: '',
      directorNotes: [],
      revisionNotes: 'Make the lighting colder; subject too close to edge.',
    });
    expect(text).toContain('Make the lighting colder');
  });
});
```
(The test uses `gen.buildShotExpandUserText`, already exported from Plan 1.)

- [ ] **Step 2: Run test, confirm FAIL.**

- [ ] **Step 3: Implement** — add `revisionNotes = ''` to the destructured params of `buildShotExpandUserText`; when non-empty, push a section before the final instruction line:
```js
  if (typeof revisionNotes === 'string' && revisionNotes.trim()) {
    lines.push('', '# Revision notes to address (from a critique of the previous version — fix these):', revisionNotes.trim());
  }
```
Thread `revisionNotes` through `expandShots`'s params into the `buildShotExpandUserText` call (add `revisionNotes = ''` to `expandShots`'s destructure and pass it).

- [ ] **Step 4: Run test, confirm PASS** (`npx vitest run tests/storyboardSceneGeneration.test.js`).

- [ ] **Step 5: Commit**
```bash
git add src/web/storyboardGenerate.js tests/storyboardSceneGeneration.test.js
git commit -m "✨ expandShots: accept optional revisionNotes"
```

---

### Task E2: `reExpandShot` single-shot prompt regen + endpoint

**Files:**
- Modify: `src/web/storyboardGenerate.js` — `reExpandShot({ storyboardId, critiqueGuidance })`: loads the row + beat (for `scene_bible`), reconstructs a one-element outline from the row's stored shot metadata, builds neighbor context, runs `expandShots` (one shot) with `revisionNotes = critiqueGuidance`, and writes the new `text_prompt` (rebuilt via `buildTextPrompt`) + the start-frame prompt (frames[0].prompt) via the gateway. Plus `mergeCritiqueComments(critique)` helper to turn a stored critique into a revision-notes string.
- Modify: `src/web/entityRoutes.js` — `POST /storyboard/:id/reexpand` with optional `{ use_critique: true }` (pulls the row's stored prompt_critique comments) or explicit `{ critique_guidance: "..." }`.
- Test: append to `tests/storyboardCritiqueGeneration.test.js`.

- [ ] **Step 1: Write the failing test**
```js
describe('reExpandShot (regenerate prompt from critique)', () => {
  beforeEach(() => fakeDb.reset());

  it('re-expands one shot using critique guidance and updates the prompts', async () => {
    const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
    const { createStoryboard, getStoryboard } = await import('../src/mongo/storyboards.js');
    await createBeat({ name: 'ReExp', desc: 'x', characters: [] });
    const beat = await getBeat('ReExp');
    await setBeatSceneBible('ReExp', { location: 'Diner' });
    const sb = await createStoryboard({ beatId: beat._id, order: 1, textPrompt: 'OLD', summary: 'Sarah at counter', shotType: 'close_up', durationSeconds: 3 });

    let sawNotes = null;
    gen._setShotExpanderForTests(({ revisionNotes, outline }) => {
      sawNotes = revisionNotes;
      return outline.map(() => ({ start_frame_prompt: 'NEW start', video_prompt: 'NEW video', reverse_in_post: false }));
    });

    await gen.reExpandShot({ storyboardId: sb._id.toString(), critiqueGuidance: 'colder light' });
    expect(sawNotes).toContain('colder light');
    const reread = await getStoryboard(sb._id);
    expect(reread.frames[0].prompt).toBe('NEW start');
    expect(reread.text_prompt).toContain('NEW video');
    gen._setShotExpanderForTests(null);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL.**

- [ ] **Step 3: Implement `reExpandShot` + `mergeCritiqueComments`.** Reconstruct the outline frame from the row, run the one-shot expand, and persist via the gateway text helpers used in Plan 1 (`setStoryboardFramePromptViaGateway` for the start frame; `createStoryboardViaGateway`/`updateStoryboard` route for `text_prompt` — match how Plan 1's `createPlannedStoryboardEntry` writes `text_prompt` and the frame prompt). Read `createPlannedStoryboardEntry` + the gateway text helpers and mirror them. `buildTextPrompt(frame)` already exists to render the `text_prompt` markdown from a frame object. If the row has no `frames[0]`, add one via `addStoryboardFrameViaGateway`.
```js
export function mergeCritiqueComments(critique) {
  if (!critique || !Array.isArray(critique.lenses)) return '';
  return critique.lenses
    .filter((l) => l && l.comments && Number(l.score) < 8)
    .map((l) => `- [${l.lens}] ${l.comments}`)
    .join('\n');
}

// Regenerate ONE shot's prompts (Pass 2 for a single shot), inheriting the
// beat's scene bible and optionally steered by critique guidance. Writes the
// new start-frame prompt + text_prompt via the gateway. Does NOT re-render the
// image (the user triggers that separately).
export async function reExpandShot({ storyboardId, critiqueGuidance = '' }) {
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beat = await getBeat(sb.beat_id.toString());
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  const characters = await findCharactersInBeat(beat);
  const directorNotes = await loadDirectorNotesForPlanner();
  const outlineFrame = {
    description: stripMarkdown(sb.summary || '').trim(),
    shot_type: sb.shot_type ?? null,
    duration_seconds: sb.duration_seconds ?? null,
    transition_in: sb.transition_in || '',
    characters_in_scene: Array.isArray(sb.characters_in_scene) ? sb.characters_in_scene : [],
    reverse_in_post: Boolean(sb.reverse_in_post),
  };
  const expanded = await expandShots({
    beat, characters, sceneBible: beat.scene_bible, outline: [outlineFrame],
    direction: '', directorNotes, revisionNotes: critiqueGuidance || '',
  });
  const e = expanded[0] || {};
  const newFrame = {
    ...outlineFrame,
    start_frame_prompt: e.start_frame_prompt,
    video_prompt: e.video_prompt,
    reverse_in_post: typeof e.reverse_in_post === 'boolean' ? e.reverse_in_post : outlineFrame.reverse_in_post,
  };
  // Persist: text_prompt (rebuilt) + start-frame prompt. Mirror how
  // createPlannedStoryboardEntry writes these via the gateway.
  // ... (use buildTextPrompt(newFrame), setStoryboardFramePromptViaGateway / addStoryboardFrameViaGateway,
  //      and the text_prompt write path used by Plan 1) ...
  return { storyboardId: String(sb._id) };
}
```
Fill in the persistence with the SAME gateway calls Plan 1's `createPlannedStoryboardEntry` uses (read it). The test asserts `frames[0].prompt === 'NEW start'` and `text_prompt` contains the new video prompt, so both writes must land in the fake-Mongo fallback path.

- [ ] **Step 4: Add the endpoint** in entityRoutes.js:
```js
router.post('/storyboard/:id/reexpand', async (req, res, next) => {
  try {
    const sbId = await resolveStoryboardId(req);
    if (!sbId) return res.status(404).json({ error: 'storyboard not found' });
    let guidance = typeof req.body?.critique_guidance === 'string' ? req.body.critique_guidance : '';
    if (!guidance && req.body?.use_critique) {
      const { getStoryboard } = await import('../mongo/storyboards.js');
      const { mergeCritiqueComments } = await import('./storyboardGenerate.js');
      const sb = await getStoryboard(sbId);
      guidance = mergeCritiqueComments(sb?.prompt_critique) || '';
    }
    const { reExpandShot } = await import('./storyboardGenerate.js');
    const result = await reExpandShot({ storyboardId: sbId, critiqueGuidance: guidance });
    res.json(result);
  } catch (e) { next(e); }
});
```

- [ ] **Step 5: Run test, confirm PASS.**

- [ ] **Step 6: Full suite + commit**
Run: `npm test`
```bash
git add src/web/storyboardGenerate.js src/web/entityRoutes.js tests/storyboardCritiqueGeneration.test.js
git commit -m "✨ Regenerate-from-critique: single-shot re-expand + endpoint"
```

---

## Self-Review (completed during planning)

**Spec coverage (Plan-2 scope):**
- Persisted `prompt_critique` / `image_critique` per shot → Task A1. ✅
- Four-lens panel (bible / director's-notes / cinematic / continuity), 1–10, detailed comments → Tasks B1, B2. ✅
- Strict-cap aggregation (any lens ≤ 3 pins overall; lowest lens surfaced) → Task B1. ✅
- Two-tier: auto prompt critique after generation; on-demand vision image critique → Tasks D1, D2. ✅
- Director's notes + scene bible + neighbors fed to every lens → Tasks B2, D1, D2. ✅
- Persist + broadcast so the SPA can re-render → Task C1 (gateway). ✅
- Regenerate-from-critique (single-shot re-expand inheriting the bible, steered by merged comments) → Tasks E1, E2. ✅
- Endpoints: `POST /storyboard/:id/critique?target=`, `GET /storyboard/critique/job/:jobId`, `POST /storyboard/:id/reexpand` → Tasks D2, E2. ✅

**Deferred to Plan 3:** collapsed-card score badge + threshold flag + per-lens breakdown UI, "Regenerate from critique" / "Re-expand from bible" buttons, Scene Bible editor, dropping first-last-frame video models.

**Type consistency:** critique object shape `{overall, lowest_lens, lenses:[{lens,score,comments}], model, created_at, target}` is produced by `critiquePanel`, persisted by `setStoryboardCritiqueViaGateway` into `prompt_critique`/`image_critique`, validated as object-or-null by `updateStoryboard`. `runCritiquePanel` (seam) wraps `critiquePanel`/override. `_setCritiquePanelForTests`, `_setLensJudgeForTests` seams named consistently. `expandShots`/`buildShotExpandUserText` gain `revisionNotes`; `reExpandShot` passes it.

**Placeholder note:** Task C1 and Task E2 step 3 each say "read X and mirror it" for the gateway persistence — justified because the exact gateway helper names must match the file's conventions (verified to exist: `setStoryboardFramePromptViaGateway`, `addStoryboardFrameViaGateway`, `createStoryboardViaGateway`, `broadcastFieldsUpdated`, `buildRoomName`), and mirroring Plan 1's `createPlannedStoryboardEntry` is the safe pattern. The implementer reads one function and copies its write calls.

**Cost note (surfaced, not hidden):** auto Pass-4 runs 4 Anthropic calls per shot — e.g. an 11-shot beat = 44 calls. This is the explicitly-chosen multi-lens design. Lenses run in parallel per shot; shots run sequentially for clean progress. If this proves too slow/expensive in practice, a future optimization is a single-call panel — but that changes the design and is out of scope here.

---

## Next plan (roadmap)

- **Plan 3 — SPA + registry.** Scene Bible editor panel + `GET/PUT /api/beats/:beatId/scene-bible`; "Re-expand shots from bible" action; collapsed-card score badge (image score if present else prompt score) + threshold flag (< 6) + expanded per-lens breakdown; "Critique now" (prompt/image) + "Regenerate from critique" buttons wired to this plan's endpoints; drop first-last-frame video models from the registry.
