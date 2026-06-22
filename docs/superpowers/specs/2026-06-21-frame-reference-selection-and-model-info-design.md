# Smarter frame reference selection + image-model info

**Date:** 2026-06-21
**Status:** Approved design, ready for implementation plan

## Problem

Two related rough edges in the storyboard image-generation flow:

1. **Reference-image selection is repetitive and shallow.** When auto-picking
   reference images for a storyboard frame, the current code pools the entire
   project *library* plus each scene character's single `main_image_id`, then a
   cheap LLM selector returns a flat list capped at 6. Because each character
   contributes exactly one image (its main portrait) and the library adds noise,
   the same images get chosen every time. The prompt and the richer per-character
   / per-beat artwork are underused.

2. **The "Generate all images" model picker is opaque.** The dialog lists model
   names only. Users can't see how many reference images each model accepts, its
   output resolution, or what input formats it takes — information that already
   exists in code (per-endpoint caps) but is never surfaced.

## Goals

- Select frame references by examining the frame prompt against the beat's own
  artwork and the full image sets of the characters in the shot, choosing the
  top ~2 per source that clear a relevance threshold.
- Guarantee each scene character is represented by at least its best image.
- Clamp the auto-selected reference count to the chosen model's maximum.
- Surface per-model metadata (max reference images, resolution, accepted input
  formats, speed) inline in the model picker, from a single backend source of
  truth that the clamp also reads.

## Non-goals

- The **initial planner path** (`selectBestReferencesForShot` in
  `src/web/referenceSelector.js`, run during first batch storyboard generation)
  is left unchanged to limit blast radius. Only the bulk auto-fill and per-frame
  auto-suggest paths change.
- No change to how references are *used* downstream (the fal/OpenAI dispatch and
  per-endpoint truncation stay as they are; the clamp just makes truncation rare).
- No live model-schema fetching from fal; metadata is a curated static registry.

## Current state (as found)

- `src/web/frameReferences.js`
  - `buildFrameReferenceCandidates({ projectId, sb, sceneText })` — pools
    `listLibraryImages(projectId)` (whole project library) + each
    `sb.characters_in_scene` character's `main_image_id`. Caps catalog at 120.
  - `autoFillFrameReferencesIfEmpty({ projectId, sb, frame, sceneText, autoReferences })`
    — only fills frames with empty `reference_ids`; calls `selectFrameReferences`,
    persists via `setStoryboardFrameReferenceImagesViaGateway`. Never throws.
  - `AUTO_REFERENCE_MAX = 6`.
- `src/llm/frameReferenceSelector.js`
  - `selectFrameReferences({ sceneText, candidates, max })` — Haiku text-only
    call; returns a flat list of candidate ids (`{"ids":[...]}`). Graceful `[]`
    on any failure.
- `src/web/referenceSelector.js`
  - `orderedCandidateIds(c)` — a character's image ids ordered
    sheets → main → attached, deduped.
  - `gatherCandidatesFromDocs(characterDocs)` — builds per-character candidate
    lists `{ name, candidates:[{id,name,description,caption}] }`.
  - `gatherCharacterReferenceCandidates(projectId, characterNames)` — wraps the
    above with `getCharacter` lookups.
  - These helpers are reused by the new builder. The LLM-call portion
    (`selectBestReferencesForShot` / `resolveReferencePicks`) is **not** touched.
- `src/mongo/storyboards.js` — a storyboard doc carries `beat_id` and
  `characters_in_scene: string[]`.
- `src/mongo/plots.js` — a beat has `images: [{ _id, ... }]` and `main_image_id`.
- `src/mongo/images.js` — `listImagesForBeat(projectId, beatId)` lists GridFS
  images with `metadata.owner_type:'beat'`, `metadata.owner_id:beatId`.
- `web/src/widgets/imageModels.js` — `IMAGE_MODELS` (id + label only),
  `DEFAULT_IMAGE_MODEL`, localStorage helpers. Shared by every edit/regen dialog.
- `web/src/widgets/BulkGenerateImagesDialog.jsx` — the "Generate all images"
  modal; renders `IMAGE_MODELS` as radios; submits `{ imageModel, autoReferences }`.
- `src/fal/imageClient.js` — per-endpoint max input consts (currently **private**):
  `FLUX_2_KLEIN_EDIT_MAX_INPUTS=4`, `FLUX_2_PRO_EDIT_MAX_INPUTS=9`,
  `GEMINI_25_FLASH_EDIT_MAX_INPUTS=10`, `NANO_BANANA_2_EDIT_MAX_INPUTS=10`,
  `NANO_BANANA_PRO_EDIT_MAX_INPUTS=14`. Flux Pro Kontext: single=1 / multi
  (uncapped in code). `src/openai/imageClient.js` — gpt-image-2 edit appends
  `image[]` in a loop (no hard cap; OpenAI edit practical max ~16).

## Design

### Feature 1 — Reference selection

All changes concentrate in `src/web/frameReferences.js` and
`src/llm/frameReferenceSelector.js`.

#### Candidate pool (replaces library + char-main with beat + char-full)

`buildFrameReferenceCandidates({ projectId, sb, frameText })` returns candidates
each tagged with a **source** so the selector can enforce per-source caps:

```
{ id, source, name, description, caption }
```

where `source` is the string `"beat"` for beat artwork, or the character's
stripped name for character images.

- **Beat source:** resolve the beat from `sb.beat_id`. Enumerate all attached
  artwork: `beat.images[]` (each `_id`), unioned with `listImagesForBeat(...)`
  (GridFS `owner_type:'beat'`), deduped. Flag the `beat.main_image_id` entry.
  Read each one's name/description metadata for the catalog text.
- **Character sources:** call
  `gatherCharacterReferenceCandidates(projectId, sb.characters_in_scene)` (reused
  from `referenceSelector.js`). Each returned character becomes its own source;
  its `candidates[]` carry name/description/caption already.
- **Library is dropped** from the pool.
- Keep a bounded total guard (reuse the existing 120 cap with overlap-trim, but
  trim within source groups so no source is starved).

#### Scoring + selection

Extend the Haiku selector to **score** rather than just pick. New function
(in `src/llm/frameReferenceSelector.js`), e.g.
`scoreFrameReferences({ frameText, candidates, ... })`:

- System prompt: score each numbered catalog entry `0.0–1.0` for how useful it is
  as a visual reference for *this* frame, given the frame prompt. Locations/sets/
  props/mood that match the scene and characters who appear score high; unrelated
  art scores low.
- Response: one line of compact JSON `{"scores":[{"n":<1-based>,"score":<0..1>}]}`.
  Reuse the existing safe-parse discipline (strip code fences, validate ranges,
  dedupe, ignore out-of-range `n`). Missing entries default to score 0.
- Driven by `config.anthropic.enhancerModel` (Haiku), same graceful-`[]`/empty
  behavior on missing key / bad JSON / network error.

Selection logic in `frameReferences.js`:

1. Attach scores to candidates (unscored → 0).
2. Group by `source`. Within each source, sort by score desc and keep up to
   `PER_SOURCE_MAX = 2` whose score ≥ `RELEVANCE_THRESHOLD = 0.5`.
3. **Character guarantee:** for every character source that has any candidates,
   if step 2 kept none for it, force-include that character's single
   highest-scored candidate (its canonical/best image). Beat artwork is *not*
   guaranteed — purely threshold-gated.
4. **Model clamp:** clamp the combined list to the chosen model's
   `maxReferenceImages` (from the Feature 2 registry). When over the cap, drop
   the lowest-scored picks first; character-guaranteed picks are treated as
   highest priority so they survive longest.

`PER_SOURCE_MAX`, `RELEVANCE_THRESHOLD` are named constants in
`frameReferences.js`.

#### Plumbing

- `autoFillFrameReferencesIfEmpty(...)` gains the chosen `imageModel` (or its
  resolved `maxReferenceImages`) so it can clamp. The bulk job
  (`startBulkFrameGenerationJob` in `src/web/storyboardGenerate.js`) already knows
  `imageModel`; thread it through.
- Frame prompt sourcing: prefer `frame.prompt`; fall back to `sb.text_prompt`,
  then any passed scene text.
- Keep the "only fill empty `reference_ids`" guard — never override user picks.
- Graceful fallback (no prompt / LLM failure): beat `main_image_id` + each
  character's first candidate, clamped to cap. Never blocks generation.

#### Unify the per-frame "auto-suggest references" button

Identify the endpoint behind the SPA's per-frame auto-suggest action and route it
through the same `buildFrameReferenceCandidates` + scoring path so single-frame
and bulk selection behave identically. (Verification step in the plan: confirm
the current handler and switch it over.)

### Feature 2 — Model metadata

#### Backend registry (single source of truth)

New module `src/web/imageModelInfo.js` exporting a map keyed by model id:

```
{
  'nano-banana-pro': {
    label, family,
    maxReferenceImages,   // referenced from fal/imageClient exported consts
    resolution,           // human string, e.g. 'up to 4K (16:9 ≈ 2048×1152)'
    inputFormats,         // ['PNG','JPEG','WebP']
    speed,                // short note, e.g. 'standard' | 'fast (4-step)'
  },
  ...
}
```

- The per-endpoint max consts in `src/fal/imageClient.js` are **exported** and
  referenced here so the cap lives in one place. OpenAI's cap is defined where its
  client lives.
- Consumed by: (a) the Feature 1 clamp, (b) the new SPA endpoint.

Seed values (confirm exact strings during implementation):

| Model | Max refs | Resolution | Inputs |
|---|---|---|---|
| nano-banana-pro | 14 | up to 4K, aspect-driven (16:9 ≈ 2048×1152) | PNG/JPEG/WebP |
| flux-2-pro | 9 | aspect-driven (16:9 ≈ 2048×1152) | PNG/JPEG/WebP |
| flux-pro-kontext | 1 single / multi | aspect-driven | PNG/JPEG/WebP |
| openai (gpt-image-2) | ~16 | up to 3840×2160 / auto | PNG/JPEG/WebP |
| gemini-25-flash | 10 | aspect-driven | PNG/JPEG/WebP |
| nano-banana-2 | 10 | aspect-driven | PNG/JPEG/WebP |
| flux-2-klein | 4 | explicit px (16:9 = 2048×1152) | PNG/JPEG/WebP |

#### API

`GET /api/image-models` (project-scoped middleware is fine; the data is global)
returns the registry as an array aligned with `IMAGE_MODELS` order:
`[{ id, label, family, maxReferenceImages, resolution, inputFormats, speed }]`.

#### SPA

- `BulkGenerateImagesDialog.jsx` fetches `/api/image-models` on open and renders,
  inline under each radio label, a compact metadata line, e.g.:
  `14 ref images · up to 4K (16:9 ≈ 2048×1152) · PNG/JPEG/WebP`.
- Fetch failure or in-flight → fall back to today's label-only rendering
  (no blocking, no error surface).
- The same metadata is available to the other edit/regenerate dialogs that import
  `imageModels.js`; wiring those is optional polish, not required.

## Data flow

```
Bulk "Generate all images"
  → POST /storyboards/generate-images { image_model, auto_references }
  → startBulkFrameGenerationJob (knows imageModel)
     → per frame: autoFillFrameReferencesIfEmpty({ ..., imageModel })
        → buildFrameReferenceCandidates (beat artwork + char full sets, sourced)
        → scoreFrameReferences (Haiku: per-candidate 0..1 vs frame prompt)
        → top-2/source ≥ threshold, guarantee ≥1 per character,
          clamp to model.maxReferenceImages (imageModelInfo)
        → setStoryboardFrameReferenceImagesViaGateway (persist, only if empty)
```

## Error handling

- `listImagesForBeat` / `getBeat` / `getCharacter` failures → warn, skip that
  source, continue (mirrors current try/catch style).
- LLM scoring failure / missing key / bad JSON → graceful fallback (beat main +
  char canonical, clamped). Generation never blocked.
- Unknown / missing model in registry → clamp falls back to `AUTO_REFERENCE_MAX`;
  endpoint omits unknown ids.
- `/api/image-models` fetch failure in SPA → label-only fallback.

## Testing

- **Candidate builder:** beat with `images[]` + GridFS beat images and 2 scene
  characters with multiple images each → candidates carry correct `source` tags;
  library images are absent; dedupe across `beat.images` and GridFS works.
- **Selection:** given mocked scores, asserts ≤2 per source above threshold,
  character guarantee fires when a character's scores are all below threshold,
  beat artwork below threshold is excluded.
- **Clamp:** picks exceeding a model cap (e.g. Klein=4) trimmed lowest-score
  first, character-guaranteed picks retained.
- **Selector parse:** `{"scores":[...]}` parsing handles code fences, out-of-range
  `n`, dupes, non-numeric scores; total failure → empty.
- **Fallback:** no prompt text and LLM-disabled → beat main + char canonical,
  clamped.
- **Registry/endpoint:** `GET /api/image-models` returns one entry per
  `IMAGE_MODELS` id with all metadata fields; a test asserts the frontend id set
  and backend registry id set match (drift guard, mirroring the existing
  id-list parity pattern).
- Mongo-touching tests use the in-memory fake (`tests/_fakeMongo.js`) per the
  established pattern.

## Open implementation details (decide in plan, not blocking)

- Exact `RELEVANCE_THRESHOLD` tuning (start 0.5).
- Whether to keep `AUTO_REFERENCE_MAX` as the no-model fallback cap (yes).
- Exact endpoint name/handler for the per-frame auto-suggest button (verify).
- Final curated resolution strings and the OpenAI ref cap value.
