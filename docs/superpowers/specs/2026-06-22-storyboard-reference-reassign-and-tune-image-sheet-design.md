# Bulk reference reassign + Tune Image Sheet — Design

Date: 2026-06-22

Two related additions to the screenplay tool's SPA + backend:

1. **"Assign reference images"** — a storyboard-page button that wipes and re-runs
   reference-image assignment across every frame in a beat.
2. **"Tune image sheet for storyboard"** — an Artwork-tab button that makes a
   critique-driven second pass at a beat's image sheet, adding only the plates
   that storyboard elements actually need.

Both reuse existing, proven pipelines rather than introducing new scoring or
generation logic.

---

## Background (current state)

- **Per-frame references** live on each storyboard frame in the `storyboards`
  collection as `reference_ids: ObjectId[]` and `reference_scores: {<hex>:number}`
  (`src/mongo/storyboards.js`).
- The **auto-suggest pipeline** is `selectFrameReferencesForShot()`
  (`src/web/frameReferences.js`) → Haiku scorer (`src/llm/frameReferenceSelector.js`)
  → persist via `setStoryboardFrameReferenceImagesViaGateway()`
  (`src/web/gateway.js`). Candidates are the beat's and in-scene characters'
  **done artworks** only. There is already a per-frame append endpoint:
  `POST /storyboard/:id/frame/:frameId/reference/auto-populate`
  (`src/web/entityRoutes.js`).
- **Create image sheet** (`web/src/widgets/ArtworkTab.jsx` →
  `ImageSheetDialog.jsx`) generates a set of static "plate" **artworks** on the
  beat via a two-phase planner (holistic plan + per-plate static critique) in
  `src/web/beatSheetPlanner.js`, orchestrated by `src/web/imageSheetJobs.js`.
  Reference images for it are chosen in `ArtworkReferencePicker.jsx` but are
  **not persisted** anywhere today — they are session-only React state.
- **Image critique** for a shot lives on the storyboard doc as `image_critique`
  (and `prompt_critique`): lenses + scores + comments
  (`src/web/storyboardCritique.js`).
- **Background-job pattern**: in-memory `Map` of jobs with a polling endpoint
  (see `src/web/imageSheetJobs.js`, critique jobs in `src/web/storyboardGenerate.js`).
  New jobs follow this pattern; job state is not persisted across restart, which
  is acceptable here.

Scope note: the Artwork tab is shared by characters and beats. "Tune image sheet
for storyboard" is **beat-only** (storyboards belong to beats) and only appears
on a beat's Artwork tab.

---

## Part A — "Assign reference images" (storyboard page)

Destructive bulk reassignment of references for every frame in a beat.

### UI

- New button in the `web/src/routes/StoryboardBeat.jsx` top toolbar, alongside
  *Generate all images* / *Delete all images*. Label: **"Assign reference images"**.
- **Disabled** when the beat has zero storyboard elements.
- Clicking opens a **confirmation dialog** that warns it removes all existing
  references on every frame (including already-generated frames) and reassigns
  from the current artwork set. On confirm, it starts the job and shows live
  progress (reuse the existing job-progress UI pattern, e.g. the bulk-generate /
  image-sheet progress panel).

### Backend

- New endpoint: `POST /storyboard/beat/:beatId/reassign-references`
  (`src/web/entityRoutes.js`). Project-scoped via `req.projectId`. Returns
  `202 { job_id }`.
- Starts an in-memory background job (image-sheet job pattern). The job:
  1. Lists all storyboards in the beat (`listStoryboards`) and every frame in each.
  2. For each frame, runs the **existing** `selectFrameReferencesForShot()`
     pipeline with the frame's text (same `frameText` composition used by the
     per-frame auto-populate endpoint: `sb.summary` + `sb.text_prompt` +
     `frame.prompt`). No new scoring logic.
  3. Persists via `setStoryboardFrameReferenceImagesViaGateway(..., mode: 'replace', scores)`,
     wiping prior refs/scores and writing the freshly scored set.
  4. Tracks `completed / total` frames and exposes progress.
- Polling endpoint follows the existing job-status convention
  (`GET .../reassign-references/:jobId` or the shared job-status route),
  verifying the job belongs to the caller's project.

### Notes

- The only behavioural difference from today's auto-suggest is `replace` instead
  of `append`, applied to every frame rather than one.
- Frames with no candidates (no done artworks for the beat/characters) end up
  with an empty reference set — same as the per-frame pipeline today.

---

## Part B — "Tune image sheet for storyboard" (Artwork tab)

A critique-driven second pass at a beat's image sheet that adds only the plates
storyboard elements actually need, without duplicating existing plates.

### Prerequisite — persist the image-sheet reference set

- Add `image_sheet_reference_ids: ObjectId[]` to the beat (in the embedded
  `plots.beats[]` schema; backfill lazily as with other beat fields in
  `getPlot`/`ensureBeatIds`).
- **Create image sheet** saves its chosen reference set to this field on submit
  (the beat path of `startImageSheetJob` / the `POST /beat/:id/image-sheet` route).
- **Tune** pre-fills its dialog from this field. For older beats with no saved
  set, fall back to the **union of `reference_image_ids`** across the beat's
  existing sheet artworks.

### UI

- New button next to *Create image sheet* in `web/src/widgets/ArtworkTab.jsx`,
  shown **only when `hostType === 'beat'`**. Label:
  **"Tune image sheet for storyboard"**.
- **Disabled** when the beat has no storyboard elements (the tab needs to know
  the beat's storyboard count — fetch it or pass via props).

### Flow

1. **Reference dialog** opens, pre-filled with the saved reference set (rendered
   with the existing `ArtworkReferencePicker`), letting the user add/remove
   references before tuning. The resulting set is used for any new plates and is
   re-saved to `image_sheet_reference_ids`.
2. **Scan job — one LLM call per storyboard element.** For each shot the scanner
   receives:
   - the shot's prompt/summary + in-scene characters (the subject),
   - its `image_critique` (and `prompt_critique`) as the "need" signal,
   - a **text catalog of the beat's existing sheet plates** (names + prompts) as
     the coverage/dedup catalog.
   It decides whether the shot is under-served and, if so, proposes a new static
   plate `{ name, prompt, justification, source_shot }`. Shots already covered by
   an existing plate produce no proposal.
3. **Consolidation pass.** Merge proposals across shots and drop any that
   duplicate an existing plate or another proposal — enforcing "no duplicates."
4. **Review stage** (same wizard shape as the beat image-sheet "review" stage in
   `ImageSheetDialog.jsx`): shows proposed new plates with justification/source
   shot; the user can edit/remove/add, then clicks **Generate**.
5. **Generate.** New plates are rendered as **beat artworks** through the existing
   static-plate render path (reusing the beat-sheet static-plate critique in
   `src/web/beatSheetPlanner.js` so they stay clean backdrops), with the chosen
   reference set. Existing plates are untouched.

### Judgment calls (approved)

- The per-shot scanner works from a **text catalog** of existing plates plus the
  shot's critique text — it is not fed every plate image. This keeps token/vision
  cost sane; the critiques already encode what is wrong with each shot's render.
- New plates **reuse the static-plate style/critique** from the beat image-sheet
  planner, so Tune output matches Create-image-sheet output.

### Notes

- If the beat has no existing plates yet, every gap is "uncovered" and Tune
  behaves like a critique-driven first pass. Running *Create image sheet* first is
  the expected workflow, but Tune does not require it.
- Tune adds to the sheet only; it never deletes or regenerates existing plates.

---

## Out of scope

- No per-frame or per-character reassign UI changes beyond Part A's beat-level
  button (the existing per-frame auto-suggest stays as-is).
- No persistence of background-job state across server restart.
- No changes to video/audio generation or to character image sheets.
