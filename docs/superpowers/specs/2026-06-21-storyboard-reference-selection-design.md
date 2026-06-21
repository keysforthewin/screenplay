# Storyboard Frame Reference-Image Selection — Design

**Date:** 2026-06-21
**Status:** Approved (design); implementation pending
**Scope:** `src/web/storyboardGenerate.js`, `src/web/storyboardReferenceAggregator.js`, new `src/web/referenceSelector.js`

## Problem

When a storyboard frame is generated, the wrong reference images get attached. In a
tight shot zoomed on one character, references for *other* characters (e.g. an older
character not in frame) are pulled in — "it's choosing everything." Off-subject
references degrade the generated still.

Three independent mechanisms cause the over-inclusion, all upstream of the image
model:

1. **Name-matching backstop.** `linkBeatCharactersForShot`
   (`storyboardGenerate.js:1312`) unions the planner's `characters_in_scene` with any
   beat character *named anywhere* in the concatenated shot text
   (`description + start_frame_prompt + video_prompt + transition_in`). The
   `video_prompt` (motion/narration) and `transition_in` routinely mention off-frame
   characters, so a character merely referenced in narration gets their reference
   images attached.

2. **Planner is told to be inclusive.** `SCENE_PLAN_SYSTEM_PROMPT:198` — "list EVERY
   named character visible … there is no cap" — with no narrowing for tight shot
   types and nothing keyed off `shot_type`.

3. **Per-character image explosion.** `collectStoryboardReferenceIds`
   (`storyboardReferenceAggregator.js:84-101`) Round 2 appends *every* image of every
   in-scene character. With the 12-slot render cap, a couple of characters saturate
   the reference list with redundant angles. The blind pick
   (`canonicalImageIdFor`) never reads what an image actually depicts.

## Goals

- Tight shots attach references only for characters actually in the frame.
- For each in-scene character, attach the *single most appropriate* image, chosen by
  reading each candidate image's `name` / `description` / `caption`.
- No new failure modes: if labels are absent or the LLM is unavailable, behavior
  degrades to today's canonical pick — never worse.

## Non-goals

- The beat image-sheet pipeline (`imageSheetJobs.js`) — separate concern, not touched
  here.
- Re-ranking references across characters or keeping multiple images per character
  (decided: single best per character).
- Any change to the video/clip generation prompts.

## Data model (grounding)

- Every stored image carries `metadata.name` and `metadata.description` (GridFS,
  bucket `images`). `imageFileToMeta(file)` (`src/mongo/images.js:254`) exposes both
  without reading bytes; `loadImageInput(id)` (`storyboardGenerate.js`) returns
  `{ buffer, contentType, _id, name, description }`.
- A character's candidate references: `character_sheet_image_ids[]`, `main_image_id`,
  and `images[]` (each embedded entry carries an inline `caption`).
- `name`/`description` for sheet/main ids require a metadata-only GridFS read;
  `caption` is already on the character doc's `images[]` entries.

## Design

Three coordinated changes. (1) and (2) control *which characters* are in a frame;
(3) controls *which image* represents each one.

### Change 1 — Tighten the backstop

`linkBeatCharactersForShot` scans only `start_frame_prompt` (what is actually composed
in the still) instead of the full text bundle. Drop `video_prompt`, `description`, and
`transition_in` from the haystack. The planner's explicit `characters_in_scene` remains
the primary source; the backstop stays only as a narrow safety net for a character
named in the frame composition itself but omitted from the picks.

### Change 2 — Shot-type-aware narrowing

Add an instruction to `SCENE_PLAN_SYSTEM_PROMPT`: for `CLOSE_UP`, `EXTREME_CLOSE_UP`,
and `INSERT` (and similarly tight types), list only the character(s) physically in
frame, not everyone in the location. The planner stays authoritative — no hard
enforcement in code. Optionally `logger.warn` when a tight-type shot lists 3+
characters, for observability.

### Change 3 — Artwork-aware reference selection

New module `src/web/referenceSelector.js`, factored so the planner path and the SPA
auto-suggest button share logic:

- **`gatherCharacterReferenceCandidates(projectId, characterNames)`** → for each
  character, the deduped candidate set (`character_sheet_image_ids[]` + `main_image_id`
  + `images[]`), each enriched to `{ id, name, description, caption }`. Name/description
  via metadata-only GridFS read (`imageFileToMeta`); caption inline from `images[]`.
- **`formatCandidateManifest(candidates)`** → a compact prompt block: per character, a
  numbered list of their images with name/description/caption. Stable 1-based indices
  (the LLM returns an index, not a 24-hex id — fewer tokens, no id hallucination).
- **`resolveReferencePicks(picks, candidates, beatMainImageId)`** → maps the LLM's
  `(character, image_index)` picks back to image ids, applies fallbacks, returns the
  final ordered `reference_ids` (beat plate first, then one best image per character),
  deduped and capped at `MAX_FRAME_REFERENCE_IMAGES` (12).
- **`selectBestReferencesForShot({ projectId, shotText, characterNames })`** →
  standalone path: gather + a small dedicated LLM call + resolve. Used by the
  auto-suggest endpoint.

**Planner integration (no extra API call):** `SHOT_EXPAND_TOOL` gains a per-shot
`references: [{ character, image_index }]` field; `buildShotExpandUserText` appends the
candidate manifest. After `expandShots` returns, `resolveReferencePicks` converts each
shot's picks into its `reference_ids`. This *replaces* the `collectStoryboardReferenceIds`
Round-1/Round-2 logic on the generation path, which also eliminates the per-character
image explosion (problem 3) for free.

## Data flow

**Generation path (planner-driven):**

```
planScene → outline w/ characters_in_scene
  → Change 2 narrows tight shots
expandShots:
  buildShotExpandUserText appends per-character candidate manifest
  LLM returns per shot: { start_frame_prompt, video_prompt, references:[{character, image_index}] }
linkBeatCharactersForShot (Change 1: start_frame_prompt only) → final character set
resolveReferencePicks(shot.references, candidates, beat.main_image_id) → reference_ids
createPlannedStoryboardEntry seeds frame.reference_ids directly
```

**Auto-suggest path (SPA button, no planner):**

```
POST .../reference/auto-populate
  → selectBestReferencesForShot({ projectId, shotText: frame prompt + summary, characterNames })
  → gather candidates → dedicated LLM call → resolveReferencePicks → reference_ids
```

`collectStoryboardReferenceIds` is retired if the auto-suggest endpoint was its only
consumer; confirm callers during implementation rather than assume. If a "show all
images for manual pruning" UI affordance still depends on it, keep it for that path
only.

## Fallbacks & degradation

Selection never blocks a render:

- **0 or 1 candidate for a character** → skip the LLM question, use the only/canonical
  image (`canonicalImageIdFor`).
- **All candidates have empty name/description/caption** → nothing to match on →
  canonical fallback + `logger.warn` (images are unlabeled).
- **LLM omits a character, or returns an out-of-range/invalid index** → canonical
  fallback for that character.
- **Standalone LLM call fails/throws** → canonical-per-character behavior; log and
  continue.
- **Beat plate** (`beat.main_image_id`) always included first, never character-gated.
- Result deduped and capped at 12.

Worst case (no labels, no API) matches today's canonical pick exactly.

## Testing

Test-first, using existing exported seams plus the new module. Unit tests (Vitest, fake
Mongo):

- **`linkBeatCharactersForShot`** — off-screen name in `video_prompt` is NOT linked;
  name in `start_frame_prompt` IS. (locks Change 1)
- **`resolveReferencePicks`** — valid picks map to ids; invalid index → canonical;
  missing character → canonical; empty candidates → canonical; beat plate first;
  dedupe + cap.
- **`gatherCharacterReferenceCandidates`** — name/description from GridFS metadata,
  caption from `images[]`; dedupes overlapping ids.
- **`selectBestReferencesForShot`** — stubbed LLM (override seam) returns the chosen
  image; LLM throw → canonical fallback.
- **expand parsing (`cleanPlannedFrameV2` / `expandShots` mapping)** — `references`
  field parsed and clamped; absent field doesn't break.

Change 2 is prompt-only — confirm the prompt string contains the narrowing rule; no
behavioral unit test.

## Open implementation details (decide during build, no further sign-off needed)

- Exact `shotText` for the standalone path: frame prompt + summary.
- Whether `collectStoryboardReferenceIds` is fully retired or kept for a manual-pruning
  UI path — depends on its callers.
