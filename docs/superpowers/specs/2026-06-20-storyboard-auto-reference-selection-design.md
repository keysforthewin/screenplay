# Automatic reference-image selection for storyboard generation

- **Date:** 2026-06-20
- **Status:** Approved (design) — ready for implementation plan
- **Area:** Storyboard generator (`src/web/storyboardGenerate.js`), library images, character portraits

## Problem

When generating storyboard frame images, reference images that steer the image
model are stored per-frame in `frame.reference_ids` (max 12) and must be
**manually pre-selected** in the SPA before generation. The project's library
("artwork") is auto-captioned with a rich `name` and `description` by the
background vision worker (`src/web/libraryVisionWorker.js` →
`analyzeLibraryImage`), so the information needed to pick relevant references
already exists — but a human still has to do the picking by hand for every
frame. We want this to be automatic, exploiting the detailed captions.

## Goals

- During frame generation, automatically choose the most relevant reference
  images for a frame from the project's library artwork **and** the characters
  that appear in the shot.
- Make the picks **reviewable and editable**: write them into
  `frame.reference_ids` so they surface in the existing SPA reference panel.
- **Never override manual picks**: only auto-fill frames whose `reference_ids`
  is empty.
- Never block or slow generation on failure — degrade gracefully.

## Non-goals (YAGNI)

- Batched per-beat selection for cross-frame consistency (one LLM call covering
  all frames). Per-frame is simpler and serves both bulk and single-frame paths.
- Vision-based matching (sending image bytes to the selector). Text matching on
  the rich captions is the point.
- An embedding / RAG catalog index for the library.
- A standalone "auto-pick all" preview button separate from generation.

## Decisions (resolved during brainstorming)

1. **Integration model:** auto-fill into `frame.reference_ids` (reviewable in
   the UI), skipping frames that already have references. Picks persist before
   generation so they survive a failed render and are reusable on re-run.
2. **Candidate pool:** library artwork **plus** portraits of the characters
   listed in the shot's `characters_in_scene`.
3. **Selection mechanism:** a unified, text-only LLM selector — one cheap call
   over a single catalog containing both artwork and scene characters. The model
   returns the subset most useful for constructing the scene.

## Architecture

Two new modules keep the logic out of the already-large
`storyboardGenerate.js`:

### `src/llm/frameReferenceSelector.js`

```
selectFrameReferences({ sceneText, candidates, max }) -> string[]   // GridFS id strings
```

- `candidates`: `[{ id, kind: 'art'|'char', name, description }]`.
- Presents candidates **numbered 1..N** in the prompt (kind, name, description).
  The model is asked to return `{"ids": [<numbers>]}` (numbers, not 24-hex
  strings — more robust to echo). We map numbers back to `candidates[i].id`,
  validate each is in range, dedupe preserving model order, and cap at `max`.
- Single Anthropic call via `getAnthropic()` using
  `config.anthropic.enhancerModel` (haiku-tier), `max_tokens ≈ 300`.
- **No image bytes are sent** — pure text matching on names/descriptions.
- Robustness mirrors `src/llm/libraryImageMeta.js`: missing API key, empty
  candidates, network error, or unparseable output all return `[]` (never
  throws).

System-prompt intent (implementation may refine the prose; the I/O contract
above is fixed): "You select reference images that help an image model construct
a storyboard frame. Given the scene description and a numbered catalog, return
the numbers of the images most useful as visual references — locations, sets,
props, and mood that match the scene, plus characters who appear in it. Prefer
precision over recall; return at most `max`. Respond with EXACTLY one line of
JSON: `{\"ids\": [<numbers>]}`, numbers only from the catalog, no other text."

### `src/web/frameReferences.js`

```
autoSelectFrameReferences({ projectId, sb, frame, sceneText }) -> string[]
```

Builds the candidate catalog, calls `selectFrameReferences`, returns ordered
GridFS id strings. Returns `[]` on any problem (logs and continues).

**Catalog construction:**

- **Library artwork:** `Images.listLibraryImages(projectId)` →
  `imageFileToMeta` → `{ kind: 'art', name, description }`. Drop entries whose
  `name` and `description` are both empty (no text signal for the selector).
- **Scene characters:** for each name in `sb.characters_in_scene`,
  `stripMarkdown(name)` → `getCharacter(projectId, name)`; if the character has
  a `main_image_id`, add `{ kind: 'char', name, description }` using that
  portrait id. Characters with no portrait are skipped.
- **Scaling guard:** if the catalog exceeds `CATALOG_MAX` (≈120), pre-trim to
  the top `CATALOG_MAX` by simple token overlap with `sceneText` before the LLM
  call. (Logged when it triggers, so truncation is never silent.)

## Data flow / hook

In `regenerateStoryboardFrameInternal` (`storyboardGenerate.js`, **generate
branch**, ~line 1717), after the prompt is persisted and **before**
`loadFrameReferenceImages(frame)`:

```js
if (autoReferences && (frame.reference_ids || []).length === 0) {
  try {
    const ids = await autoSelectFrameReferences({
      projectId, sb, frame, sceneText: renderPrompt,
    });
    if (ids.length) {
      await setStoryboardFrameReferenceImagesViaGateway({
        projectId, storyboardId: sb._id, frameId, imageIds: ids, mode: 'replace',
      });
      frame.reference_ids = ids; // existing load step picks them up unchanged
    }
  } catch (e) {
    logger.warn(`auto-reference select failed for frame ${frameId}: ${e.message}`);
  }
}
inputImages = await loadFrameReferenceImages(frame);
```

- `setStoryboardFrameReferenceImagesViaGateway` (`gateway.js:1751`, `mode:
  'replace'`) writes Mongo and calls `broadcastFrames(...)`, so the SPA
  reference panel re-renders with the picks for review.
- The gateway setter already lives in a module imported by
  `storyboardGenerate.js`, so no new import cycle is introduced.

**Threading `autoReferences` (default `true`):**

- `startBulkFrameGenerationJob` → `runBulkFrameGenerationJob` →
  `regenerateStoryboardFrameInternal`.
- The single-frame job (`startFrameGenerationJob` → …) → same internal worker.
- The bulk-generate route accepts `autoReferences` from the request body
  (default `true`); single-frame generation inherits the default.

## Configuration / tunables

- `AUTO_REFERENCE_MAX = 6` — per-frame auto-pick cap (module const, mirroring the
  existing `MAX_FRAME_REFERENCE_IMAGES = 12`). Under the frame cap and all image
  model caps.
- `CATALOG_MAX ≈ 120` — pre-trim threshold for the candidate catalog.
- Selector model: `config.anthropic.enhancerModel` (existing).
- Auto-references **on by default**.

## UI

- One addition: a checkbox on the page-level **"Generate all images"** control —
  "Auto-pick reference images" (default checked) — that sends `autoReferences`
  to the bulk-generate route.
- No review widget needed: the existing per-frame reference panel re-renders on
  the `broadcastFrames` ping, so auto-picked refs appear under each frame and
  remain editable.

## Failure handling

Every failure mode in the selection path (no API key, parse error, empty
candidates, Mongo error) logs a warning and proceeds with whatever references
exist (typically none). Generation is never blocked. This follows the project's
optional-integration convention (return gracefully, never throw into the loop).

## Testing

- **`tests/frameReferenceSelector.test.js`** — mock the Anthropic client:
  number→id mapping, range validation, dedupe, `max` cap; returns `[]` on
  missing API key, bad JSON, and out-of-range numbers.
- **`tests/frameReferences.test.js`** (fake Mongo) — catalog building: scene
  characters resolved to portrait ids, characters without a portrait skipped,
  empty-signal artwork dropped, `CATALOG_MAX` trim, cap respected; `[]` when no
  candidates. Selector mocked to a known subset; assert returned ids resolve.
- **Integration** (`storyboardGenerate`) — frames with existing `reference_ids`
  are not overwritten; `autoReferences: false` disables auto-fill; a selector
  returning `[]` still generates with no references.

## Affected files (anticipated)

- New: `src/llm/frameReferenceSelector.js`, `src/web/frameReferences.js`.
- Edit: `src/web/storyboardGenerate.js` (hook + thread `autoReferences` through
  bulk and single-frame paths).
- Edit: the bulk-generate Express route (accept `autoReferences`).
- Edit: SPA "Generate all images" control (checkbox + request field).
- New tests as above.
