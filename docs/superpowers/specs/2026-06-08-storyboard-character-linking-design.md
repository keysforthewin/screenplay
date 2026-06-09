# Storyboard character linking & reference seeding — design

**Date:** 2026-06-08
**Status:** Approved (design)

## Problem

During storyboard generation, when a character that is linked to a beat appears in a
storyboard element (shot), that character should be **linked to the element** (in its
`characters_in_scene`) and that character's **artwork should be fed as reference images**
when the element's frames are generated.

Observed failure: a generated storyboard element clearly mentioned a beat character in its
text, yet `characters_in_scene` was empty — so no character was linked and none of that
character's artwork was seeded into the frame's reference images.

## Key finding (current state)

Most of the desired behavior already exists; the gap is **detection reliability** and two
hard limits, not missing plumbing.

- A storyboard element is a doc in the `storyboards` collection, owned by a beat via
  `beat_id`. It carries `characters_in_scene: string[]` and `frames[]`, where each frame has
  `reference_ids: ObjectId[]` (the "reference section").
- Generation is two-pass: `plan_scene` (the LLM fills `characters_in_scene`, instructed
  *"exactly as listed in the beat metadata. AT MOST 2"* — `storyboardGenerate.js:153,156`)
  then `expand_shots` (writes `start_frame_prompt` + `video_prompt`).
- `createPlannedStoryboardEntry` calls `collectStoryboardReferenceIds({ beat, charactersInScene })`
  (`storyboardReferenceAggregator.js:36`), which resolves each name → that character's artwork
  (default sheet → sheets → main portrait → all images) and seeds the frame's `reference_ids`.
- At frame-gen, `loadFrameReferenceImages` feeds the **first 12** of `reference_ids` to the
  image model. So linked-character-artwork → reference-image already works **once
  `characters_in_scene` is populated**.

So the artwork-as-reference path is already wired. The work is making the linking reliable
and lifting the limits that fight "link every appearing character".

## Decisions (locked)

1. **Detection:** deterministic name-match backstop **plus** a firmer planner prompt.
2. **Character cap:** removed — link every beat character that appears in the element.
3. **Reference budget:** pull **all** of each linked character's artwork (user prunes
   unwanted references in the SPA via the existing `pullFrameReferenceImage` path).
4. **Reference ordering:** interleave **canonical-first** so every linked character is
   represented within the first-12 references even when unpruned.
5. **Scope:** **go-forward generation only** — no backfill / migration of existing elements.

## Design

### 1. Remove the 2-character cap

`MAX_CHARS_PER_SHOT = 2` is enforced in three places; all change:

- **`src/mongo/storyboards.js` — `sanitizeCharacterList`** (`:146`): drop the
  `.slice(0, MAX_CHARS_PER_SHOT)` truncation and the warn-on-trim. Keep strip-markdown +
  trim + filter, and **add case-insensitive dedupe** (it currently does not dedupe; with the
  cap gone, duplicate planner names would otherwise accumulate). Remove the now-unused
  `MAX_CHARS_PER_SHOT` export (and any test importing it) or leave it exported but unused —
  resolved during implementation by grep.
- **`src/web/storyboardGenerate.js` — `cleanPlannedFrameV2`** (`:1131-1148`): remove the
  `rawChars.slice(0, MAX_CHARS_PER_SHOT)` and its warn.
- **Prompt text:** `SCENE_PLAN_TOOL` `characters_in_scene` description (`:156`) → *"Names of
  every beat character visible in this shot, exactly as listed in the beat metadata."*; and
  `SCENE_PLAN_SYSTEM_PROMPT` (`:195`) → replace *"Maximum 2 named characters per shot. If a
  beat has 4 people, alternate coverage."* with an instruction to list every character
  visible in the shot. Keep the surrounding coverage/rhythm guidance (vary framing, OTS for
  two-person dialogue).

### 2. Deterministic backstop (the guarantee)

A pure, exported helper:

```
findAppearingBeatCharacters(text, beatCharacters) -> string[]   // canonical beat strings that appear in text
```

- Candidate set is scoped to **`beat.characters`** only (the user-curated beat cast) — never
  the whole characters collection.
- Match: `stripMarkdown` + lowercase both sides, **word-boundary** regex per name (escaped),
  so "Sam" does not match "same" and multi-word names ("The Narrator") match as a phrase.
- Returns the **beat's** canonical name string for each match (so display + downstream
  `getCharacter` resolution stay consistent).
- Known tradeoff: a beat character whose name is a common word (e.g. "Will", "Hope") can
  over-match prose. Accepted — the candidate set is the curated beat cast and the user prunes
  references. (Capitalization-sensitivity is a possible later refinement; out of scope now.)

Wire it in **`planFramesV2`** (`storyboardGenerate.js`, after `frames` are assembled
~`:1178-1186`), where `beat` is in scope and each frame already has `description`,
`start_frame_prompt`, `video_prompt`, `transition_in`. For each frame, scan the joined shot
text, union the matches with the planner's `characters_in_scene`, and dedupe
case-insensitively. The persisted `characters_in_scene` (via `createPlannedStoryboardEntry`
→ `createStoryboardViaGateway`) and the references (via `collectStoryboardReferenceIds`) then
both see the augmented list.

### 3. Reference seeding — interleave canonical-first

Restructure **`collectStoryboardReferenceIds`** (`storyboardReferenceAggregator.js:36-92`) to
two rounds, preserving the existing dedupe-via-`seen`:

- Add `canonicalImageIdFor(c)` = `defaultSheetIdFor(c)` ?? `c.main_image_id` ?? first
  `c.images[]._id`.
- **Round 1 (canonical):** `beat.main_image_id`, then for each character its single canonical
  image.
- **Round 2 (remainder):** the rest of `beat.images`, then for each character: all
  `character_sheet_image_ids`, main portrait, all `images[]`.

Result: with N linked characters, ids `[beat main, char1 canonical, … charN canonical, …rest]`
— every character is represented within the first 12 even with no pruning, while the full set
is still seeded for the user to prune. This shared helper also improves the SPA "Auto-suggest"
button (same code path) — consistent, not a backfill.

### 4. Frame generation — no change

`loadFrameReferenceImages` already feeds `reference_ids` (first 12) to the image model. With
detection fixed and ordering interleaved, linked-character artwork now reliably reaches the
model. The user prunes unwanted references in the SPA.

## Out of scope

- No backfill / migration of existing storyboard elements.
- No new SPA UI (removal uses the existing per-frame reference controls).
- No promotion of name-string links to `character_id` references (keeps consistency with the
  existing name-based `beat.characters` convention; rename-resilience is a separate concern).

## Tests (TDD)

- `sanitizeCharacterList`: keeps >2 entries; dedupes case-insensitively; still strips markdown.
- `findAppearingBeatCharacters`: matches a mentioned beat character; excludes a non-mentioned
  one; no substring false-positive ("Sam" vs "same"); multi-word name; case-insensitive;
  result dedupes against the planner's existing picks.
- `collectStoryboardReferenceIds` (fake Mongo + characters): with 3 characters each having
  artwork, returns every id, and the leading ids are canonical-first
  (beat main, then one canonical per character) before any character's extra images.
- (If feasible) a `planFramesV2` seam test asserting a beat character mentioned only in
  `video_prompt`/`start_frame_prompt` ends up in the frame's `characters_in_scene`.

## Key anchors

- `src/mongo/storyboards.js:120,146-157` — `MAX_CHARS_PER_SHOT`, `sanitizeCharacterList`.
- `src/web/storyboardGenerate.js:113-168,170-199` — `plan_scene` tool + system prompt.
- `src/web/storyboardGenerate.js:1131-1188` — `cleanPlannedFrameV2`, `planFramesV2`.
- `src/web/storyboardGenerate.js:1200-1260` — `createPlannedStoryboardEntry`.
- `src/web/storyboardReferenceAggregator.js:36-92` — `collectStoryboardReferenceIds`.
- `src/web/storyboardGenerate.js:~1355` — `loadFrameReferenceImages` (first-12 clamp).
