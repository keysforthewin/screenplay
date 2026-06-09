# Storyboard Character Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During storyboard generation, reliably link every beat character that appears in a storyboard element and seed that character's artwork as frame reference images.

**Architecture:** Remove the 2-character cap at all three enforcement points; add a deterministic name-match backstop (pure helper) wired into the planner so a character mentioned in shot text is linked even when the LLM omits it; reorder reference seeding canonical-first so each linked character is represented within the first-12 references. Go-forward generation only — no backfill.

**Tech Stack:** Node ESM, Vitest, in-memory fake Mongo (`tests/_fakeMongo.js`), `stripMarkdown` from `src/util/markdown.js`.

**Spec:** `docs/superpowers/specs/2026-06-08-storyboard-character-linking-design.md`

---

### Task 1: Remove the cap + dedupe in the Mongo storage layer

**Files:**
- Modify: `src/mongo/storyboards.js` (`sanitizeCharacterList` ~`:146-157`, export `:120`, comment `:76`)
- Test: `tests/storyboards.test.js` (replace test at `:551`, add a dedupe test)

- [ ] **Step 1: Update the existing failing test + add a dedupe test**

In `tests/storyboards.test.js`, replace the `createStoryboard trims characters_in_scene at MAX_CHARS_PER_SHOT` test (`:551-557`) with:

```js
  it('createStoryboard keeps all characters_in_scene (no cap)', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      charactersInScene: ['Alice', 'Bob', 'Carol', 'Dave'],
    });
    expect(sb.characters_in_scene).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
  });

  it('createStoryboard dedupes characters_in_scene case-insensitively', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      charactersInScene: ['Alice', 'alice', '**Alice**', 'Bob'],
    });
    expect(sb.characters_in_scene).toEqual(['Alice', 'Bob']);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/storyboards.test.js -t "characters_in_scene"`
Expected: FAIL — the "keeps all" test gets `['Alice','Bob']` (still capped); the dedupe test gets `['Alice','alice','Alice','Bob']`.

- [ ] **Step 3: Rewrite `sanitizeCharacterList`**

In `src/mongo/storyboards.js`, replace the whole function (`:146-157`):

```js
function sanitizeCharacterList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const n of list) {
    const stripped = stripMarkdown(String(n ?? '')).trim();
    if (!stripped) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stripped);
  }
  return out;
}
```

Then delete the now-unused export (`:120`): remove the line `export const MAX_CHARS_PER_SHOT = 2;`.

Update the schema comment (`:76`) from `//   characters_in_scene: string[]     (≤ MAX_CHARS_PER_SHOT stripped names)` to `//   characters_in_scene: string[]     (deduped, stripped names)`.

- [ ] **Step 4: Fix `sanitizeCharacterList` call sites (drop the removed option arg)**

Run: `grep -n 'sanitizeCharacterList(' src/mongo/storyboards.js`
For each call that passes a second argument (e.g. `sanitizeCharacterList(x, { warnOnTrim: true })`), change it to `sanitizeCharacterList(x)`. (Extra args are harmless in JS, but remove them for clarity.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/storyboards.test.js`
Expected: PASS (whole file).

- [ ] **Step 6: Commit**

```bash
git add src/mongo/storyboards.js tests/storyboards.test.js
git commit -m "Remove storyboard character cap + dedupe in mongo layer"
```

---

### Task 2: Remove the cap in the generation pipeline

**Files:**
- Modify: `src/web/storyboardGenerate.js` (import `:43`; `cleanPlannedFrameV2` `:1131-1148`)
- Test: `tests/storyboard-generate.test.js` (update test at `:264`)

- [ ] **Step 1: Update the existing pipeline-cap test**

In `tests/storyboard-generate.test.js`, replace the `trims characters_in_scene to MAX_CHARS_PER_SHOT` test (`:264-294`) body's final assertion. Rename it and change the expectation:

```js
  it('keeps all characters_in_scene (cap removed)', async () => {
```
…and change the final assertion from `expect(stored[0].characters_in_scene).toEqual(['Alice', 'Bob']);` to:
```js
    expect(stored[0].characters_in_scene).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
```
(Leave the rest of the test — the planner install and beat with 4 characters — unchanged.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/storyboard-generate.test.js -t "cap removed"`
Expected: FAIL — stored value is still `['Alice','Bob']`.

- [ ] **Step 3: Remove the cap from `cleanPlannedFrameV2`**

In `src/web/storyboardGenerate.js`, replace the `rawChars` block (`:1131-1138`):

```js
  const rawChars = Array.isArray(f.characters_in_scene)
    ? f.characters_in_scene.map((n) => stripMarkdown(String(n ?? '')).trim()).filter(Boolean)
    : [];
  if (rawChars.length > MAX_CHARS_PER_SHOT) {
    logger.warn(
      `storyboard plan (v2): trimming characters_in_scene from ${rawChars.length} to ${MAX_CHARS_PER_SHOT}`,
    );
  }
```

with:

```js
  const rawChars = Array.isArray(f.characters_in_scene)
    ? f.characters_in_scene.map((n) => stripMarkdown(String(n ?? '')).trim()).filter(Boolean)
    : [];
```

And change the return's character line (`:1148`) from `    characters_in_scene: rawChars.slice(0, MAX_CHARS_PER_SHOT),` to:

```js
    characters_in_scene: rawChars,
```

- [ ] **Step 4: Remove the now-unused import**

In `src/web/storyboardGenerate.js`, delete the line `  MAX_CHARS_PER_SHOT,` (`:43`) from the `import { … } from '../mongo/storyboards.js';` block.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/storyboard-generate.test.js -t "cap removed"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-generate.test.js
git commit -m "Remove storyboard character cap in generation pipeline"
```

---

### Task 3: Deterministic backstop helpers (pure functions)

**Files:**
- Modify: `src/web/storyboardGenerate.js` (add exported helpers + `escapeRegExp`)
- Test: `tests/storyboard-character-linking.test.js` (new)

- [ ] **Step 1: Write the failing unit tests**

Create `tests/storyboard-character-linking.test.js`:

```js
// Unit tests for the deterministic character-linking backstop used during
// storyboard generation. Pure functions — no Mongo, but importing the module
// pulls in the mongo client, so stub it like the other generate tests.
import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { findAppearingBeatCharacters, linkBeatCharactersForShot } = await import(
  '../src/web/storyboardGenerate.js'
);

describe('findAppearingBeatCharacters', () => {
  it('finds a beat character named in the text', () => {
    expect(findAppearingBeatCharacters('Alice opens the door.', ['Alice', 'Bob'])).toEqual(['Alice']);
  });

  it('excludes a beat character not mentioned', () => {
    expect(findAppearingBeatCharacters('Alice opens the door.', ['Bob'])).toEqual([]);
  });

  it('does not match on a substring (whole-word only)', () => {
    expect(findAppearingBeatCharacters('They are all the same.', ['Sam'])).toEqual([]);
  });

  it('matches multi-word names as a phrase', () => {
    expect(findAppearingBeatCharacters('The Narrator speaks.', ['The Narrator'])).toEqual(['The Narrator']);
  });

  it('is case-insensitive and markdown-insensitive', () => {
    expect(findAppearingBeatCharacters('the door creaks as ALICE enters', ['**Alice**'])).toEqual(['Alice']);
  });

  it('returns each match once even if named twice', () => {
    expect(findAppearingBeatCharacters('Bob waves. Bob smiles.', ['Bob'])).toEqual(['Bob']);
  });
});

describe('linkBeatCharactersForShot', () => {
  it('unions the planner picks with text-detected beat characters', () => {
    const frame = {
      characters_in_scene: ['Alice'],
      description: 'Two figures talk.',
      start_frame_prompt: 'Alice and Bob at the counter.',
      video_prompt: 'Bob leans in; Alice reacts.',
    };
    expect(linkBeatCharactersForShot(frame, ['Alice', 'Bob'])).toEqual(['Alice', 'Bob']);
  });

  it('keeps planner picks even when not in beat.characters', () => {
    const frame = { characters_in_scene: ['Ghost'], description: '', start_frame_prompt: '', video_prompt: '' };
    expect(linkBeatCharactersForShot(frame, ['Alice'])).toEqual(['Ghost']);
  });

  it('dedupes a planner pick that is also text-detected', () => {
    const frame = { characters_in_scene: ['Bob'], description: 'Bob enters.', start_frame_prompt: '', video_prompt: '' };
    expect(linkBeatCharactersForShot(frame, ['Bob'])).toEqual(['Bob']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/storyboard-character-linking.test.js`
Expected: FAIL — `findAppearingBeatCharacters is not a function` (not yet exported).

- [ ] **Step 3: Implement the helpers**

In `src/web/storyboardGenerate.js`, add near the top-level helpers (e.g. just above `cleanPlannedFrameV2`):

```js
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Which of the beat's linked characters are named in a shot's text? Whole-word,
// case- and markdown-insensitive. Candidate set is the curated beat cast only.
// Returns the beat's canonical name strings (deduped). This is the backstop
// that links a character the planner mentioned but forgot to list.
export function findAppearingBeatCharacters(text, beatCharacters) {
  const haystack = stripMarkdown(String(text ?? '')).toLowerCase();
  if (!haystack) return [];
  const out = [];
  const seen = new Set();
  for (const raw of beatCharacters || []) {
    const name = stripMarkdown(String(raw ?? '')).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    const re = new RegExp(`\\b${escapeRegExp(key)}\\b`);
    if (re.test(haystack)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

// Union the planner's characters_in_scene with any beat characters detected in
// the shot text, deduped case-insensitively. Planner picks lead the ordering.
export function linkBeatCharactersForShot(frame, beatCharacters) {
  const picks = Array.isArray(frame?.characters_in_scene) ? frame.characters_in_scene : [];
  const text = [frame?.description, frame?.start_frame_prompt, frame?.video_prompt, frame?.transition_in]
    .filter(Boolean)
    .join('\n');
  const detected = findAppearingBeatCharacters(text, beatCharacters);
  const out = [];
  const seen = new Set();
  for (const raw of [...picks, ...detected]) {
    const name = stripMarkdown(String(raw ?? '')).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/storyboard-character-linking.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-character-linking.test.js
git commit -m "Add deterministic beat-character linking backstop"
```

---

### Task 4: Wire the backstop into the planner

**Files:**
- Modify: `src/web/storyboardGenerate.js` (`planFramesV2`, after `frames` assembled ~`:1178-1187`)
- Test: `tests/storyboard-generate.test.js` (add a backstop integration test)

- [ ] **Step 1: Write the failing integration test**

In `tests/storyboard-generate.test.js`, add after the "cap removed" test (mirror the `installPlanner` / `Plots.createBeat` / `waitForJob` shape used by neighbouring tests):

```js
  it('links a beat character mentioned only in the shot text (backstop)', async () => {
    installPlanner({
      sceneBible: { location: 'Diner' },
      shots: [
        {
          description: 'Two figures talk.',
          shot_type: 'two_shot',
          duration_seconds: 5,
          transition_in: '',
          characters_in_scene: ['Alice'], // planner forgot Bob
          reverse_in_post: false,
          start_frame_prompt: 'Alice and Bob at the counter.',
          video_prompt: 'Bob leans in; Alice reacts.',
        },
      ],
    });

    const beat = await Plots.createBeat({
      name: 'Talk',
      desc: 't',
      body: 't',
      characters: ['Alice', 'Bob'],
    });
    const jobId = await Generate.startStoryboardGenerationJob({
      beatId: beat._id.toString(),
    });
    await waitForJob(jobId);

    const stored = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(stored[0].characters_in_scene).toEqual(['Alice', 'Bob']);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/storyboard-generate.test.js -t "backstop"`
Expected: FAIL — stored value is `['Alice']` (Bob not yet detected/linked).

- [ ] **Step 3: Wire the union into `planFramesV2`**

In `src/web/storyboardGenerate.js`, find the tail of `planFramesV2` (`:1178-1187`):

```js
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
```

Replace the `return` with a backstop pass:

```js
  const beatCharacters = Array.isArray(beat?.characters) ? beat.characters : [];
  const linkedFrames = frames.map((fr) => ({
    ...fr,
    characters_in_scene: linkBeatCharactersForShot(fr, beatCharacters),
  }));
  return { frames: linkedFrames, sceneBible };
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/storyboard-generate.test.js -t "backstop"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-generate.test.js
git commit -m "Wire beat-character backstop into the storyboard planner"
```

---

### Task 5: Firmer planner prompt (no character cap)

**Files:**
- Modify: `src/web/storyboardGenerate.js` (`SCENE_PLAN_TOOL` `:156`, `SCENE_PLAN_SYSTEM_PROMPT` `:195`)

- [ ] **Step 1: Update the tool field description**

In `src/web/storyboardGenerate.js`, change the `characters_in_scene` description (`:156`) from:

```js
              description: 'Names of characters visible in this shot, exactly as listed in the beat metadata. AT MOST 2.',
```

to:

```js
              description: 'Names of EVERY character visible in this shot, exactly as listed in the beat metadata. List everyone who appears in frame — however many that is.',
```

- [ ] **Step 2: Update the system-prompt hard constraint**

Change the hard constraint line (`:195`) from:

```js
  '- Maximum 2 named characters per shot. If a beat has 4 people, alternate coverage.',
```

to:

```js
  '- List EVERY named character visible in a shot in characters_in_scene — there is no cap. You may still vary which characters are prominent across shots, but anyone visible in frame must be listed.',
```

- [ ] **Step 3: Verify the old cap language is gone**

Run: `grep -nE 'AT MOST 2|Maximum 2 named' src/web/storyboardGenerate.js`
Expected: no matches.

- [ ] **Step 4: Run the generate suite (no regressions)**

Run: `npx vitest run tests/storyboard-generate.test.js tests/storyboardSceneGeneration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js
git commit -m "Drop 2-character cap from storyboard planner prompts"
```

---

### Task 6: Interleave reference seeding canonical-first

**Files:**
- Modify: `src/web/storyboardReferenceAggregator.js` (`collectStoryboardReferenceIds` `:36-92`, add `canonicalImageIdFor`)
- Test: `tests/storyboard-reference-aggregator.test.js` (add multi-character interleave test)

- [ ] **Step 1: Write the failing interleave test**

In `tests/storyboard-reference-aggregator.test.js`, add inside the `describe('collectStoryboardReferenceIds', …)` block:

```js
  it('interleaves canonical-first: beat main + one signature image per character before extras', async () => {
    const beatMain = new ObjectId();
    const sheetA = new ObjectId();
    const portraitA = new ObjectId();
    const sheetB = new ObjectId();
    const portraitB = new ObjectId();
    await makeCharacter('Alice', { sheets: [sheetA], mainId: portraitA });
    await makeCharacter('Bob', { sheets: [sheetB], mainId: portraitB });
    const beat = { _id: new ObjectId(), images: [], main_image_id: beatMain };
    const result = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: ['Alice', 'Bob'],
      existingIds: [],
    });
    expect(result.ids).toEqual([
      beatMain.toString(),
      sheetA.toString(),
      sheetB.toString(),
      portraitA.toString(),
      portraitB.toString(),
    ]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/storyboard-reference-aggregator.test.js -t "interleaves"`
Expected: FAIL — current order is `[beatMain, sheetA, portraitA, sheetB, portraitB]` (character A fully before B).

- [ ] **Step 3: Rewrite `collectStoryboardReferenceIds`**

In `src/web/storyboardReferenceAggregator.js`, replace the function body (`:36-92`) and add the canonical helper:

```js
function canonicalImageIdFor(c) {
  return defaultSheetIdFor(c) || c?.main_image_id || c?.images?.[0]?._id || null;
}

export async function collectStoryboardReferenceIds({
  beat,
  charactersInScene,
  existingIds = [],
}) {
  const seen = new Set();
  const ids = [];

  // Resolve in-scene characters once, preserving order and skipping unknowns.
  const chars = [];
  for (const raw of charactersInScene || []) {
    const stripped = stripMarkdown(raw || '').trim();
    if (!stripped) continue;
    let c = null;
    try {
      c = await getCharacter(stripped);
    } catch (e) {
      logger.warn(`storyboard refs: character lookup "${stripped}" failed: ${e.message}`);
      continue;
    }
    if (!c) {
      logger.warn(`storyboard refs: unknown character "${stripped}" — skipped`);
      continue;
    }
    chars.push(c);
  }

  // Round 1 — canonical: beat set image, then one signature image per character.
  // Frame gen consumes only the first N references, so this guarantees every
  // linked character is represented even before the user prunes.
  if (beat?.main_image_id) pushId(seen, ids, beat.main_image_id);
  for (const c of chars) pushId(seen, ids, canonicalImageIdFor(c));

  // Round 2 — remainder: the rest of the beat images, then each character's
  // full set (sheets, portrait, every image) for the user to prune down.
  if (beat) {
    for (const img of beat.images || []) pushId(seen, ids, img?._id);
  }
  for (const c of chars) {
    pushId(seen, ids, defaultSheetIdFor(c));
    for (const sid of c.character_sheet_image_ids || []) pushId(seen, ids, sid);
    pushId(seen, ids, c.main_image_id);
    for (const img of c.images || []) pushId(seen, ids, img?._id);
  }

  const existing = new Set((existingIds || []).map((x) => String(x)));
  const added = ids.filter((id) => !existing.has(id));

  return { ids, added };
}
```

(Also update the stale file-header comment that mentions `start_frame_reference_ids and end_frame_reference_ids` to just "the per-frame reference list" if convenient — non-blocking.)

- [ ] **Step 4: Run to verify the whole aggregator file passes**

Run: `npx vitest run tests/storyboard-reference-aggregator.test.js`
Expected: PASS — the new interleave test plus all pre-existing single/zero-character tests (their ordering is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardReferenceAggregator.js tests/storyboard-reference-aggregator.test.js
git commit -m "Interleave storyboard references canonical-first"
```

---

### Task 7: Full suite + final verification

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS (no regressions across the storyboard, plots, characters, gateway suites).

- [ ] **Step 2: Confirm no stale cap references remain**

Run: `grep -rnE 'MAX_CHARS_PER_SHOT|AT MOST 2|Maximum 2 named' src/`
Expected: no matches.

- [ ] **Step 3: Commit any remaining cleanup**

```bash
git add -A
git commit -m "Storyboard character linking: final cleanup" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Remove cap (3 sites) → Tasks 1 (mongo), 2 (pipeline), 5 (prompts). ✓
- Add missing dedupe → Task 1. ✓
- Deterministic backstop (`findAppearingBeatCharacters`, scoped to beat.characters, word-boundary, unioned) → Tasks 3 + 4. ✓
- Firmer planner prompt → Task 5. ✓
- Interleave canonical-first → Task 6. ✓
- Pull-all artwork (user prunes) → preserved in Task 6 Round 2. ✓
- Go-forward only / no backfill / no new UI → nothing added. ✓
- Tests called out in spec → Tasks 1, 3, 4, 6. ✓

**Type/name consistency:** `findAppearingBeatCharacters(text, beatCharacters)` and `linkBeatCharactersForShot(frame, beatCharacters)` defined in Task 3, consumed identically in Task 4. `canonicalImageIdFor(c)` defined and used in Task 6. `sanitizeCharacterList(list)` single-arg in Task 1, call sites fixed same task.

**Placeholder scan:** none — every code step shows complete code; every run step shows the command + expected result.
