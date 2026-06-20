# Screenplay-centric Beat Writing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Steer the agent to write beat bodies in a pragmatic screenplay style (photographable action lines, sparing camera cues, baseline dialogue) and help the storyboard planner exploit that structure — improving storyboard image accuracy.

**Architecture:** Pure writing-guidance change, no schema change. A single new module owns the screenplay style text; `load_writing_context` returns the full guide on-demand, the always-on system prompt carries a short summary, and the storyboard scene-planner prompt gets a one-line nudge to read the new structure.

**Tech Stack:** Node.js (ES modules), Vitest, in-memory fake Mongo (`tests/_fakeMongo.js`).

## Global Constraints

- Format is **pragmatic screenplay, Fountain-flavored**: optional slugline `INT./EXT. LOCATION — TIME OF DAY`, present-tense photographable action lines, sparing shot cues (`CLOSE ON`, `WIDE`, `PUSH IN`), character cues + parentheticals + **sparse anchor dialogue**. Loose for non-scene lore beats.
- Beat body dialogue is **sparse/illustrative only**; the separate dialogue generator + `dialogs` collection stays **canonical and untouched**.
- The full `SCREENPLAY_STYLE_GUIDE` loads **on-demand via `load_writing_context`**; the always-on system prompt carries only the short `SCREENPLAY_STYLE_SUMMARY` (keep per-request tokens lean).
- Do **not** change: beat `name`/`desc` handling, the `load_writing_context` gate, any `edit` mechanics, the dialogue generator, `dialogs`, `dialog_notes`, or the `scene_bible` schema.
- No new agent tool, no bulk migration. Reformat-on-request is covered by a line in the guide, not new code.
- One source of truth: the style text is defined once in `src/agent/screenplayStyle.js` and imported by every consumer — never duplicated.
- Prompt-text tests assert short, stable anchor substrings only.
- Commit after each task. Full suite: `npm test`. Single file: `npx vitest run tests/<file>`.

---

### Task 1: Screenplay style module (single source of truth)

**Files:**
- Create: `src/agent/screenplayStyle.js`
- Test: `tests/screenplay-style.test.js`

**Interfaces:**
- Produces:
  - `SCREENPLAY_STYLE_GUIDE: string` — full craft guide (loaded by `load_writing_context`).
  - `SCREENPLAY_STYLE_SUMMARY: string` — 1–2 sentence version (injected into the system prompt).

- [ ] **Step 1: Write the failing test**

Create `tests/screenplay-style.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { SCREENPLAY_STYLE_GUIDE, SCREENPLAY_STYLE_SUMMARY } from '../src/agent/screenplayStyle.js';

describe('screenplay style text', () => {
  it('exports a non-empty full guide covering the key craft elements', () => {
    expect(typeof SCREENPLAY_STYLE_GUIDE).toBe('string');
    expect(SCREENPLAY_STYLE_GUIDE.length).toBeGreaterThan(200);
    // slugline convention
    expect(SCREENPLAY_STYLE_GUIDE).toContain('INT.');
    // photographable action lines
    expect(SCREENPLAY_STYLE_GUIDE.toLowerCase()).toContain('photographable');
    // sparing camera cues
    expect(SCREENPLAY_STYLE_GUIDE).toContain('CLOSE ON');
    // baseline dialogue
    expect(SCREENPLAY_STYLE_GUIDE.toLowerCase()).toContain('dialogue');
    // reformat-on-request
    expect(SCREENPLAY_STYLE_GUIDE.toLowerCase()).toContain('reformat');
  });

  it('exports a short summary that points back to load_writing_context', () => {
    expect(typeof SCREENPLAY_STYLE_SUMMARY).toBe('string');
    expect(SCREENPLAY_STYLE_SUMMARY.length).toBeGreaterThan(0);
    expect(SCREENPLAY_STYLE_SUMMARY.length).toBeLessThan(600);
    expect(SCREENPLAY_STYLE_SUMMARY).toContain('screenplay action');
    expect(SCREENPLAY_STYLE_SUMMARY).toContain('load_writing_context');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/screenplay-style.test.js`
Expected: FAIL — `Failed to resolve import "../src/agent/screenplayStyle.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/screenplayStyle.js`:

```js
// Single source of truth for the screenplay-centric beat-writing convention.
//
// SCREENPLAY_STYLE_GUIDE is the full, actionable craft guide returned by the
// agent's load_writing_context tool (src/agent/writingContext.js) right before
// it composes a beat body. SCREENPLAY_STYLE_SUMMARY is the short version carried
// in the always-on system prompt (src/agent/systemPrompt.js). Define the text
// ONCE here so the two placements never drift.

export const SCREENPLAY_STYLE_GUIDE = [
  'Write beat bodies as screen action a camera can shoot — not novel prose.',
  '',
  '- Scene heading: when the beat is a literal scene, open with a slugline — `INT./EXT. LOCATION — TIME OF DAY` (e.g. `INT. DINER — NIGHT`). Skip it for lore or world-building beats that are not a single place and time.',
  '- Action lines: present tense, third person, concrete and photographable. Describe what is SEEN — looks, nods, glances, gestures, posture, where people stand and move, how they handle props. Do not write interior thoughts or backstory the camera cannot show; turn them into a visible action or a spoken line.',
  '- Camera/shot cues: use sparingly, only where the shot matters — `CLOSE ON`, `WIDE`, `PUSH IN`, `ANGLE ON`, `POV`. Do not direct every line; let most action imply its own framing.',
  "- Dialogue: include a few anchor lines that establish voice and carry the beat. Put the speaker's name in CAPS on its own line, an optional `(parenthetical)` for delivery, then the line. Keep it sparse — the full dialogue is written separately by the dialogue generator, so the body only needs the key beats.",
  '- Non-scene beats: lore and world-building may stay descriptive, but still write in present tense and favour the concrete and visual over the abstract.',
  '- Reformatting: if the user asks you to convert an existing prose beat into screenplay style, rewrite its body to follow this guide.',
].join('\n');

export const SCREENPLAY_STYLE_SUMMARY =
  'Beat bodies are written as screenplay action, not prose: present-tense, photographable action lines (looks, nods, blocking — what the camera sees), sparing shot cues (CLOSE ON, WIDE), and a few anchor lines of dialogue. `load_writing_context` returns the full screenplay-format guide — follow it whenever you compose or edit a body.';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/screenplay-style.test.js`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/agent/screenplayStyle.js tests/screenplay-style.test.js
git commit -m "✨ Add screenplay-style beat-writing guide (single source of truth)"
```

---

### Task 2: `load_writing_context` returns the full guide

**Files:**
- Modify: `src/agent/writingContext.js`
- Test: `tests/writing-context.test.js` (extend)

**Interfaces:**
- Consumes: `SCREENPLAY_STYLE_GUIDE` from `src/agent/screenplayStyle.js`.
- Produces: `buildWritingContext(projectId, beat, characterNames)` output now ends with a `# Writing in screenplay format` section containing `SCREENPLAY_STYLE_GUIDE`.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('buildWritingContext', ...)` block in `tests/writing-context.test.js` (the file already imports `buildWritingContext`, `Plots`, etc.):

```js
  it('includes the screenplay-format writing guide', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Road', desc: 'd', body: 'b' });
    const ctx = await buildWritingContext(projectId, beat, []);
    expect(ctx).toContain('# Writing in screenplay format');
    expect(ctx.toLowerCase()).toContain('photographable');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/writing-context.test.js -t "screenplay-format"`
Expected: FAIL — `ctx` does not contain `# Writing in screenplay format`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/writingContext.js`:

Add the import near the other imports at the top:

```js
import { SCREENPLAY_STYLE_GUIDE } from './screenplayStyle.js';
```

In `buildWritingContext`, immediately before the final `return sections.join('\n\n');`, append the guide as the last section:

```js
  // Screenplay-format craft guide — last section so it is the freshest guidance
  // in context right before the agent composes/edits the body.
  sections.push(['# Writing in screenplay format', SCREENPLAY_STYLE_GUIDE].join('\n'));

  return sections.join('\n\n');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/writing-context.test.js`
Expected: PASS — the new test plus all five existing tests (scoping, beat details, logline/style, unknown character, truncation) still green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/writingContext.js tests/writing-context.test.js
git commit -m "✨ Return the screenplay-format guide from load_writing_context"
```

---

### Task 3: System prompt "# Beats" reframe + summary injection

**Files:**
- Modify: `src/agent/systemPrompt.js`
- Test: `tests/systemPrompt.test.js` (extend)

**Interfaces:**
- Consumes: `SCREENPLAY_STYLE_SUMMARY` from `src/agent/screenplayStyle.js`.
- Produces: the stable system-prompt text's "# Beats" section now describes `body` as screenplay-format content and contains `SCREENPLAY_STYLE_SUMMARY`.

- [ ] **Step 1: Write the failing test**

Add this test to `tests/systemPrompt.test.js` (it already imports `buildSystemPrompt`, `joinSystemBlocks`, `_resetStableTextCacheForTests`, and defines the `joined(args)` helper):

```js
  it('teaches screenplay-format beat bodies in the # Beats section', () => {
    _resetStableTextCacheForTests();
    const text = joined({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
    });
    expect(text).toContain('screenplay action');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/systemPrompt.test.js -t "screenplay-format beat bodies"`
Expected: FAIL — the built prompt does not yet contain `screenplay action`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/systemPrompt.js`:

Add the import at the top (after the existing imports on lines 1–3):

```js
import { SCREENPLAY_STYLE_SUMMARY } from './screenplayStyle.js';
```

In `buildStableText`, inside the big template literal, locate the `body` bullet in the "# Beats (the per-scene unit)" section. It currently reads:

```
- **body** — long-form developing content. Grows over time as the user dumps lore into the beat.
```

Replace that single line with the reframed bullet plus the summary line (interpolating the imported constant — the surrounding text is already a template literal, so `${SCREENPLAY_STYLE_SUMMARY}` works):

```
- **body** — the screenplay-format scene content: present-tense action lines, sparing camera direction, and baseline dialogue. Grows over time as the user dumps lore into the beat.

${SCREENPLAY_STYLE_SUMMARY}
```

Leave the rest of the "# Beats" section — the `load_writing_context` gate paragraph and every `edit` mechanic (targeted edits, wholesale rewrite, append, large-body navigation, error handling) — exactly as written.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/systemPrompt.test.js`
Expected: PASS — the new test plus all existing systemPrompt tests (block structure, cache_control, volatile/stable split) still green.

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.js tests/systemPrompt.test.js
git commit -m "✨ Reframe the # Beats system prompt for screenplay-format bodies"
```

---

### Task 4: Storyboard scene-planner nudge

**Files:**
- Modify: `src/web/storyboardGenerate.js` (`SCENE_PLAN_SYSTEM_PROMPT`, the array starting line 169)
- Test: `tests/storyboard-generate.test.js` (extend — it already imports the module as `Generate` with all required mocks)

**Interfaces:**
- Consumes: nothing new (the nudge is static text in `SCENE_PLAN_SYSTEM_PROMPT`).
- Produces: `SCENE_PLAN_SYSTEM_PROMPT` joined text now contains a screenplay-format note.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block at the end of `tests/storyboard-generate.test.js` (the module is already imported there as `const Generate = await import('../src/web/storyboardGenerate.js');`):

```js
describe('scene-planner screenplay-format nudge', () => {
  it('tells the planner that beat bodies are screenplay-formatted', () => {
    const text = Generate.SCENE_PLAN_SYSTEM_PROMPT.join('\n');
    expect(text.toLowerCase()).toContain('screenplay format');
    expect(text.toLowerCase()).toContain('slugline');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboard-generate.test.js -t "screenplay-format nudge"`
Expected: FAIL — `SCENE_PLAN_SYSTEM_PROMPT` does not yet contain a screenplay-format note.

- [ ] **Step 3: Write minimal implementation**

In `src/web/storyboardGenerate.js`, in the `SCENE_PLAN_SYSTEM_PROMPT` array, find the "# Two jobs" / scene-bible bullet (line 173):

```js
  '1. Write the SCENE BIBLE — a compact, unified visual plan (location, time of day, lighting key, palette, mood, blocking, continuity anchors, camera language). Every shot will inherit this, so make it concrete and self-consistent. Derive it from the beat body, description, characters, and director guidance.',
```

Insert a new array element immediately after it:

```js
  '   Beat bodies are written in screenplay format (Fountain-flavored): read sluglines (INT./EXT. LOCATION — TIME) for location, time of day, and lighting; action lines for blocking and staging; and shot cues (CLOSE ON, WIDE, PUSH IN) for camera language. Lean on that structure when deriving the scene bible.',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/storyboard-generate.test.js`
Expected: PASS — the new test plus all existing storyboard-generation tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-generate.test.js
git commit -m "✨ Nudge the storyboard planner to read screenplay-format beat bodies"
```

---

### Task 5: Full-suite regression

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS (all files). The change is additive prompt text; no existing assertion should break. If a snapshot-style test elsewhere pinned the exact "# Beats" body bullet wording, update it to the new wording and re-run.

- [ ] **Step 2: Commit (only if Step 1 surfaced an incidental fix)**

```bash
git add -A
git commit -m "✅ Update incidental assertions for screenplay-format beat bodies"
```

---

## Self-Review

**Spec coverage:**
- §1 single source-of-truth module (`SCREENPLAY_STYLE_GUIDE` + `SCREENPLAY_STYLE_SUMMARY`) → Task 1. ✓
- §2 `load_writing_context` returns the full guide → Task 2. ✓
- §3 system prompt reframe + summary injection → Task 3. ✓
- §4 storyboard planner nudge → Task 4. ✓
- §5 out-of-scope (name/desc, dialogue generator, dialogs, dialog_notes, scene_bible, gate, edit mechanics) → no task touches them; Global Constraints forbid it. ✓
- §6 testing (new screenplay-style test, extended writing-context test, storyboard-prompt assertion) → Tasks 1, 2, 4; plus systemPrompt assertion in Task 3 and full-suite regression in Task 5. ✓

**Placeholder scan:** none — every code step shows complete content (full module text, exact edits, exact test code).

**Type consistency:** `SCREENPLAY_STYLE_GUIDE` and `SCREENPLAY_STYLE_SUMMARY` are the exact export names used in Tasks 1–3. `buildWritingContext(projectId, beat, characterNames)` and the `sections.push(...)` pattern match the real `writingContext.js`. `SCENE_PLAN_SYSTEM_PROMPT` is the real exported array consumed via `Generate.SCENE_PLAN_SYSTEM_PROMPT` in Task 4. `_resetStableTextCacheForTests` / `joined(args)` match the real `systemPrompt.js` / `tests/systemPrompt.test.js`.
