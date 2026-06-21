# Beat shot derivation with interim review

- **Date:** 2026-06-21
- **Status:** Approved (design); pending implementation plan
- **Area:** Artwork tab → "Create image sheet" (beat path only)

## Summary

Replace the beat "Create image sheet" flow's single "Target shots" number with a
**Derive → Review → Generate** wizard. Clicking **Derive** runs a two-phase LLM
derivation that reads the beat's screenplay text and proposes a set of
scene/background plates — each carrying a justification and a verbatim script
quote. The user reviews and edits that list (rename, edit prompts, remove, add),
then clicks **Generate Sheet** to render the images through the existing
pipeline.

The character path is **unchanged**. Beat plates remain
empty/lightly-dressed environments with no characters — still reusable as
storyboard backdrops. Only the *method* of planning changes (more methodical,
count chosen by the model, plus an interim review).

## Motivation / current behavior

Today (`web/src/widgets/ImageSheetDialog.jsx`, `src/web/imageSheetJobs.js`,
`src/web/beatSheetPlanner.js`):

- The beat branch of the dialog shows a **"Target shots"** number input
  (`BEAT_SHOT = { def: 8, min: 3, max: 20 }`), submitted as `shot_count`.
- `POST /api/beat/:id/image-sheet` starts a single fire-and-forget job that
  **plans then immediately renders** — no interim review.
- The planner (`planBeatSceneImages`) makes one Anthropic call (`plan_scene_images`
  tool) aiming for ~`targetCount` plates and returns `[{ name, prompt }]`.

Problems this addresses:

- A fixed target count is wrong for beats — short beats need few plates, long
  beats need many. The count should be **derived from the text**, not entered.
- There is no chance to review/fix prompts before spending image-gen credits.
- Plates carry no rationale, so it's hard to tell why a plate exists or which
  part of the beat it serves.

## Decisions (locked with the user)

1. **Shot type:** scene/background plates — empty, no characters; still reusable
   storyboard backdrops. Planner purpose unchanged; method gets more rigorous.
2. **Flow:** Derive → Review (full editing) → Generate Sheet.
3. **Justification + quote:** review-only metadata. The image-generation prompt
   stays clean; the image model never sees the justification or quote.
4. **Phase-2 verdicts:** four — `keep` / `edit` / `divide` / `cull`.

## Scope

**In scope (beat path only):**
- Two-phase derivation in `beatSheetPlanner.js`.
- A new "derive" job + endpoint; generalizing the render job/endpoint to accept
  an explicit shot list.
- The dialog wizard, with full editing of the derived list.
- Tests for the planner, jobs, and routes.

**Out of scope:**
- The **character** path (fixed checklist) — untouched.
- The **storyboard** generator and frame-reference auto-fill — untouched.
- Persisting justification/quote after generation (they are review aids only).
- Persisting a derived list across dialog closes (ephemeral — see Data model).

## Data model: a derived plate (review-only)

```js
{
  name: string,          // gallery label — editable
  prompt: string,        // clean visual description; the ONLY thing rendered — editable
  justification: string, // why this plate serves the beat — review-only, read-only in UI
  quote: string          // verbatim beat snippet this plate derives from — review-only
}
```

The derived list lives in dialog React state (seeded from the derive job's
`job.shots`). It is **not** persisted to Mongo. On Generate Sheet, only
`{ name, prompt }` is sent; `justification` and `quote` are dropped. Generated
artworks store the clean prompt exactly as today.

## The two-phase derivation (`src/web/beatSheetPlanner.js`)

`planBeatSceneImages` is reworked to drop `targetCount` and run two phases,
returning `{ images: [{ name, prompt, justification, quote }] }`. It accepts an
optional `onProgress(evt)` callback so the job can surface progress; the planner
stays self-contained (both phases live here) and remains independently testable.

### Phase 1 — holistic plan (one Anthropic call)

- New tool `plan_scene_plates`. Items are `{ name, prompt, justification, quote }`
  (all required).
- New system prompt: a methodical production-designer pass that reads the **full**
  beat and proposes **as many plates as the text genuinely needs — no target
  count**. Cover every distinct location, key set detail, and atmosphere. Keep
  all current rules: empty/lightly-dressed backdrops, no characters, no caption
  text in the image, no proper names in prompts.
- For each plate the model must return:
  - `justification` — one sentence on why this plate serves the beat.
  - `quote` — a **verbatim** snippet copied from the beat body that this plate
    derives from.
- New user-text builder (no count language); reuses `buildBeatContextBlock` and
  the reference-description block as today.
- Model: `STORYBOARD_MODEL` (unchanged), streamed `finalMessage()` like the
  current planner.

### Phase 2 — per-plate critique (one Anthropic call per plate, bounded concurrency)

- New tool `critique_scene_plate`. Each phase-1 plate is examined **in
  isolation** with the beat as context, returning one verdict:
  - `keep` → plate passes through unchanged.
  - `edit` → returns a refined `prompt` (and optionally `name` / `justification`);
    `quote` is preserved.
  - `divide` → returns **two** fully-formed plates (`{ name, prompt,
    justification, quote }` each).
  - `cull` → plate is dropped.
- Runs in parallel with a small bounded-concurrency pool (e.g.
  `PHASE2_CONCURRENCY = 4`), emitting `onProgress({ phase:'critiquing', index, total })`.
- Results are reassembled in **phase-1 order** (divides expand in place).
- Model: `STORYBOARD_MODEL`. This is the main cost lever (N calls). A cheaper
  model is a possible future knob; default to the strong model for quality.

### Post-processing

- Reuse `normalizeScenePlanImages`, extended to **carry through** `justification`
  and `quote` (still requires non-empty `name` + `prompt`; drops entries missing
  either).
- Apply the existing `MAX_SCENE_IMAGE_COUNT = 20` cap **after** phase 2 (so a
  `divide` explosion is bounded); log a note when truncating.
- **Quote validation:** best-effort. If `quote` is not a whitespace-normalized
  substring of the beat body, keep it anyway and log a warning — never reject a
  plate over its quote.

### Test seams

Replace the single `_setSceneImagePlannerForTests` seam with two, so each phase
is stubbable:

- `_setScenePlatePlannerForTests(fn)` — phase 1; returns the raw plate array.
- `_setScenePlateCritiqueForTests(fn)` — phase 2; receives one plate (+ context),
  returns a verdict object.

## Jobs & API (`src/web/imageSheetJobs.js`, `src/web/entityRoutes.js`)

The derived shots round-trip through the browser (derive → edit → render), so
**no server-side job is parked** across user think-time (the job store is
in-memory). Two jobs, both polled through the existing `GET /api/image-sheet/:jobId`.

### Derive job — `POST /api/beat/:id/shot-plan`

- Body: `{ reference_image_ids?, direction? }`. (Model is not needed to derive;
  it is sent again at Generate. Reference *descriptions* feed phase 1.)
- New `startShotPlanJob(...)`:
  - Validates the beat exists and `ANTHROPIC_API_KEY` is configured
    (`assertConfigured` for the beat/anthropic case; **no image-model validation**).
  - Creates a job with `kind: 'beat_plan'`, status `queued → planning →
    critiquing → derived` (or `error`). On success sets
    `job.shots = [{ name, prompt, justification, quote }]` and does **not** render.
  - Drives `planBeatSceneImages({ ..., onProgress: (e) => recordProgress(job, e) })`.
  - Does **not** use `busyHosts` (no artworks created; deriving has no side
    effects). The dialog disables Derive client-side while one is in flight.
- Route name is `shot-plan` (not `image-sheet/derive`) to avoid colliding with
  the `GET /image-sheet/:jobId` poll route.
- Returns `{ job_id }`.

### Render job — `POST /api/beat/:id/image-sheet` (generalized)

- Body gains `shots: [{ name, prompt }]`. For **beats**, `shots` is now
  **required** (the flow always derives first); reject missing/empty with 400.
- Validation: array length ≤ `MAX_SCENE_IMAGE_COUNT`; each `name`/`prompt` a
  non-empty string; clamp lengths (name ≤ ~200, prompt ≤ ~2000); drop blanks.
- `startImageSheetJob` accepts `shots`; `runSheetJob` uses them directly when
  present (`const shots = explicitShots ?? await planShots(...)`), skipping the
  planner entirely. `kind` stays `beat_sheet`; `busyHosts` still guards
  concurrent renders on a host.
- **Character** path unchanged: still sends `shot_names` / `shot_count`, still
  plans its fixed preset (no `shots` in body).

### Poll — `GET /api/image-sheet/:jobId`

- Unchanged. It now also carries `job.shots` and the new `beat_plan` kind /
  `planning|critiquing|derived` statuses. The project-ownership check is unchanged.

## Frontend (`web/src/widgets/ImageSheetDialog.jsx`, `api.js`, `ArtworkTab.jsx`)

### `ImageSheetDialog.jsx` — beat branch becomes a wizard

- Remove `BEAT_SHOT`, the `shotCount` state, and the number input + its
  validation.
- Add a `stage` state for beats: `'setup' | 'deriving' | 'review'`. (Characters
  ignore `stage`.)
- **Setup:** the reference picker + model selector (as today) + a **"Derive
  shots"** button where the number input was.
- **Deriving:** `POST {basePath}/shot-plan`, then poll `GET /image-sheet/:jobId`;
  render progress with the existing `GenerationProgress` component (the derive
  job populates `job.progress`). Poll cleanup guarded by the existing
  `openSeqRef` on close/unmount.
- **Review:** editable list of plate cards. Each card: editable **name** input,
  editable **prompt** textarea, a read-only **quote** block, a one-line read-only
  **justification**, and a **Remove** button. Plus **Add shot** (blank card),
  **Re-derive** (confirm if manual edits exist), and footer **Generate Sheet**
  (disabled at zero shots) + **Cancel**.
- **Generate Sheet:** `POST {basePath}/image-sheet` with
  `{ reference_image_ids, model, shots: list.map(({name,prompt}) => ({name,prompt})) }`,
  then the existing `onStarted({ jobId })` → close → live gallery fill-in.
- **Empty result** (phase 1 returns nothing, or phase 2 culls everything): the
  review stage shows an empty-state message and the user can Add shot manually;
  Generate stays disabled until ≥1 shot.

### `api.js`

- Add a thin `startShotPlan(basePath, body)` helper over `apiPostJson`; reuse
  `apiGet` for polling.

### `ArtworkTab.jsx`

- Minimal/none: deriving happens inside the open dialog and creates no tiles, so
  the existing `sheetActive` (render-job) gating still holds. Verify the
  "Create image sheet" button's disabled logic is unaffected.

### Styles

- Add review-card styles alongside the existing `.image-sheet-*` rules in
  `web/src/styles.css`.

## Edge cases

- **Empty / very short beat:** phase 1 may return few or zero plates — handled by
  the review empty-state + manual Add.
- **All culled:** same empty-state path.
- **Divide explosion:** bounded by the post-phase-2 cap, with a logged note.
- **Anthropic key missing:** `shot-plan` returns 400 before any work.
- **Non-verbatim quote:** kept as-is, logged; never blocks a plate.
- **Re-derive with manual edits:** confirm before discarding.
- **Dialog closed mid-derive:** polling cancelled via `openSeqRef`; the in-memory
  job is abandoned harmlessly.
- **Process restart mid-derive:** in-memory job lost (same accepted tradeoff as
  today); the user re-derives.

## Testing

Follow existing patterns (fake Mongo via `tests/_fakeMongo.js`; planner seams;
the provider stub used by `imageSheetJobs.test.js`).

**`tests/beatSheetPlanner.test.js` (rework + extend):**
- Phase 1 via `_setScenePlatePlannerForTests`: `{ name, prompt, justification,
  quote }` retained through `normalizeScenePlanImages`.
- Phase 2 via `_setScenePlateCritiqueForTests`: each verdict —
  `keep` (unchanged), `edit` (prompt replaced, quote preserved),
  `divide` (one → two), `cull` (removed).
- Cap enforced **after** divide (≤ `MAX_SCENE_IMAGE_COUNT`).
- `onProgress` called for phase 1 and per-plate phase 2.
- Clean-prompt isolation: `justification`/`quote` never concatenated into `prompt`.
- Tool/system-prompt sanity: `plan_scene_plates` schema requires the four fields;
  `critique_scene_plate` enumerates the four verdicts.

**`tests/imageSheetJobs.test.js` (rework beat section + add):**
- `startShotPlanJob` reaches `derived` with `job.shots` populated (planner seam).
- `startImageSheetJob` with explicit `shots` renders exactly those and **does not
  call the planner** (assert the phase-1 seam is untouched; artworks carry the
  given prompts).
- Beat render with no `shots` → error.
- Character regression: existing character job tests still pass.

**`tests/imageSheetRoutes.test.js` (update beat + add):**
- `POST /api/beat/:id/shot-plan` happy path → `{ job_id }`; poll to `derived`.
- `POST /api/beat/:id/image-sheet` with `shots` → 202 and renders them.
- Validation: empty/missing `shots` for a beat → 400; over-cap length; empty
  `prompt` rejected.
- Character regression: `shot_names` / `shot_count` paths still pass.

## File-by-file change list

- `src/web/beatSheetPlanner.js` — two-phase rewrite; new `plan_scene_plates` /
  `critique_scene_plate` tools + system prompts; `onProgress`; carry
  `justification`/`quote`; post-cap; quote validation; two test seams.
- `src/web/imageSheetJobs.js` — `startShotPlanJob` + derive flow; `startImageSheetJob`
  / `runSheetJob` accept explicit `shots`; new job statuses; progress wiring.
- `src/web/entityRoutes.js` — `POST /:host/:id/shot-plan` (beat); generalize
  `POST /:host/:id/image-sheet` to accept + validate `shots`.
- `web/src/widgets/ImageSheetDialog.jsx` — wizard (setup/deriving/review),
  remove target-shots input, editable review list.
- `web/src/api.js` — `startShotPlan` helper.
- `web/src/widgets/ArtworkTab.jsx` — verify gating (likely no change).
- `web/src/styles.css` — review-card styles.
- `tests/beatSheetPlanner.test.js`, `tests/imageSheetJobs.test.js`,
  `tests/imageSheetRoutes.test.js` — as above.

## Open knobs (non-blocking)

- Phase-2 model could be downgraded to cut cost (default: keep `STORYBOARD_MODEL`).
- `PHASE2_CONCURRENCY` default 4 — tune against rate limits.
- Post-phase-2 cap stays at 20; revisit if long beats routinely need more.
