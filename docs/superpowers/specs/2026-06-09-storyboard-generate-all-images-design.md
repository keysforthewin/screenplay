# Storyboard: "Generate all images" / "Delete all images" (per beat)

**Date:** 2026-06-09
**Status:** Approved (design); pending implementation plan
**Scope:** One beat's storyboard page (`/storyboard/:order`, `web/src/routes/StoryboardBeat.jsx`)

## Goal

Add two buttons to the top toolbar of the per-beat storyboard page:

- **Generate all images** — opens a small popup to pick the image model, then
  generates the **start-frame image** for every shot in the beat that is missing
  one. No prompt or reference-image input: each frame's prompt and references are
  already configured. Frames that already have an image are skipped.
- **Delete all images** — clears every generated frame image in the beat (a clean
  slate), keeping per-frame prompts and reference images intact.

## Decisions (locked)

| Question | Decision |
|---|---|
| Which frames does Generate cover? | **Start frame only** — `frames[0]` of each shot. |
| Scope of "all"? | **Current beat only** (consistent with existing Generate / Delete all). |
| Empty stored prompt? | **Fall back to the auto-suggested prompt** (same as per-frame Generate). |
| What does Delete remove? | **Generated frame images only** (current + undo image). Keeps reference images and prompts. |
| Delete: which frames? | **Every frame in every shot** (all frames, not just start frames) — a true clean slate. (Accepted asymmetry: Generate refills only start frames; extra/end frames are regenerated per-frame.) |
| Execution model | **One async job**, sequential per frame, inside a single beat lock, reusing the existing per-frame render internal. |

## Background (how the system works today)

Established facts from the codebase (file:line where useful):

- **Storyboard = one shot/row in a beat.** A beat has ~11 shots
  (`DEFAULT_TARGET_COUNT`). Each shot has a `frames[]` pool (max 6,
  `MAX_FRAMES`). Each frame: `_id`, `image_id` (`ObjectId|null`, current image),
  `prompt` (stored generation prompt), `previous_image_id` (one-step undo),
  `last_edit_prompt`, `reference_ids[]` (per-frame gen references).
  (`src/mongo/storyboards.js`)
- **`frames[0]` IS the start frame.** The planner seeds the opening still as the
  first frame of the pool (`storyboardGenerate.js:1296-1310`); the critique code
  treats `frames[0].image_id` as the rendered start frame
  (`storyboardGenerate.js:296-297`); video assignment treats the first frame with
  an image as the start frame.
- **"Missing" = `frame.image_id == null`** (`has_existing_frame: !!frame.image_id`,
  `storyboardGenerate.js:1491`).
- **Per-frame render core:** `regenerateStoryboardFrameInternal({sb, beat, frame,
  imageModel, mode:'generate', prompt})` (`storyboardGenerate.js:1495-1577`)
  requires a non-empty `prompt`, persists it to the frame, loads up to 12
  `reference_ids` as input images, calls the model dispatcher, uploads the result,
  and persists it via `setStoryboardFrameImageViaGateway` — which **broadcasts a
  `fields_updated` ping** to room `storyboards:<beatId>` so connected SPAs
  re-render the tile live. We reuse this internal unchanged.
- **Suggested-prompt fallback:** `buildSuggestedFramePrompt({sb})`
  (`storyboardGenerate.js:1326`) — module-private; builds a prompt from shot
  type + summary + characters. The per-frame `preview-prompt` endpoint already
  uses `frame.prompt.trim() ? frame.prompt : suggested`.
- **Image models:** 7, registered in `web/src/widgets/imageModels.js`
  (`IMAGE_MODELS`, `IMAGE_MODEL_IDS`, `DEFAULT_IMAGE_MODEL = 'nano-banana-pro'`),
  persisted in localStorage key `screenplay.storyboard.model`. The server
  validates the same enum (`ALLOWED_STORYBOARD_MODELS` in
  `src/web/storyboardImageDispatch.js`).
- **Async job pattern:** batch jobs live in the in-memory `jobs` Map
  (`storyboardGenerate.js:260`); `makeJobId()`; `recordProgress(job, {...})`
  (`:276`) maintains `job.progress` (rendered status line) + `job.events[]`
  (scrollable log). Job shape: `{job_id, beat_id, status, started_at,
  finished_at, error, planned, completed, failed, image_model, progress,
  events[]}`. Poll route `GET /storyboards/generate/:jobId` reads
  `getStoryboardGenerationJob`. Convention (see `critiqueJobs`,
  `storyboardGenerate.js:298`) is a **dedicated map + getter per job type**.
- **SPA progress UI:** `StoryboardGenerationProgress`
  (`StoryboardBeat.jsx:444-520`) renders any job with `{status, completed,
  planned, failed, progress:{phase,message}, events[], started_at}`. We reuse it
  unchanged.
- **Beat lock:** `withBeatLock(beatId, fn)` / `isBeatLocked(beatId)`
  (`src/web/beatLocks.js`) serialize all work per beat. The bulk job acquires the
  lock once for the whole run, so it cannot race the plan-generation job or
  per-frame edits — and per-frame renders inside it must call the **internal**
  (`regenerateStoryboardFrameInternal`), NOT `startFrameGenerationJob` (which
  re-acquires the lock and would queue behind itself).
- **Existing toolbar** (`StoryboardBeat.jsx:296-330`): `Generate` (plan, primary),
  `Edit…`, `+ Add storyboard`, `Delete all` (shots, danger). The page already
  drives one async job via `pollJob`/`generate` (`:199-249`) and shows
  `StoryboardGenerationProgress`.

## Components

### 1. Backend — bulk generate job (`src/web/storyboardGenerate.js`)

Add a dedicated job table and two functions, mirroring the batch-job pattern.

```js
const imageJobs = new Map();
export function getImageGenerationJob(jobId) { return imageJobs.get(jobId) || null; }

// Build the target list: each shot's start frame (frames[0]) with image_id == null.
// Returns [{ sb, frame }]. Shots with an empty frame pool are skipped.
async function listMissingStartFrameTargets(beatId) { ... }

export async function startBulkFrameGenerationJob({ beatId, imageModel = 'nano-banana-pro', announceUsername = null }) {
  const beat = await getBeat(beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());

  const targets = await listMissingStartFrameTargets(beat._id);
  const jobId = makeJobId();
  const job = {
    job_id: jobId, beat_id: beat._id.toString(),
    status: 'queued', started_at: new Date(), finished_at: null, error: null,
    planned: targets.length, completed: 0, failed: 0,
    image_model: imageModel, progress: null, events: [],
  };
  imageJobs.set(jobId, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued',
    message: `Queued — ${targets.length} missing start frame${targets.length === 1 ? '' : 's'}` });

  withBeatLock(beat._id, () => runBulkFrameGenerationJob({ job, beat, targets, imageModel, announceUsername }))
    .catch((e) => { job.status = 'error'; job.error = e.message; job.finished_at = new Date();
      recordProgress(job, { phase: 'error', step: 'job_crashed', message: `Bulk generate crashed: ${e.message}` }); });

  return { jobId, planned: targets.length };
}
```

`runBulkFrameGenerationJob`:

- If `targets.length === 0`: status `done`, record `"No missing start frames."`, return.
- Else status `rendering`, loop targets `index = 0..n-1`:
  - `recordProgress(job, { phase:'rendering', step:'frame_start', frame:index+1, total, message: 'Frame i/n: rendering…' })`
  - `const prompt = (frame.prompt || '').trim() || buildSuggestedFramePrompt({ sb });`
  - `try { await regenerateStoryboardFrameInternal({ sb, beat, frame, imageModel, mode:'generate', prompt }); job.completed++; recordProgress(...'frame_done'...) }`
  - `catch (e) { job.failed++; recordProgress(...'frame_failed'... message: e.message) }` — **continue** on failure (one bad frame must not abort the rest).
- Finish: status = `job.failed > 0 ? 'partial' : 'done'`; `finished_at = new Date()`; record a summary event.
- If `announceUsername` and `job.completed > 0`: fire **one** Discord batch summary
  via `announceBatchSummary` (fire-and-forget) — e.g. *"generated N start-frame
  images on Storyboard — Beat X"*. No per-frame announcements.

Notes:
- Re-fetch each `sb` via `getStoryboard` when building targets so `frames` are
  backfilled; pass the live `frame` sub-doc into the internal. Within the locked
  run nothing else mutates the beat.
- `regenerateStoryboardFrameInternal` already broadcasts per frame, so tiles fill
  in live during the run with no extra work.

### 2. Backend — clear images (`src/mongo/storyboards.js` + `src/web/gateway.js`)

**`src/mongo/storyboards.js`** — new export:

```js
// Clear every frame image in a beat's storyboards. Sets image_id,
// previous_image_id, last_edit_prompt to null/'' on every frame of every shot.
// Keeps prompt and reference_ids. Returns { freedImageIds, referencedIds, storyboardIds }.
export async function clearAllFrameImagesForBeat(beatId) { ... }
```

- Iterate `listStoryboards({ beatId })`; for each, build a new `frames` array with
  `image_id=null`, `previous_image_id=null`, `last_edit_prompt=''` (keep `prompt`,
  `reference_ids`); one `updateOne` per storyboard with `$set:{frames, updated_at}`.
- Collect `freedImageIds` = all non-null `image_id` + `previous_image_id` seen.
- Collect `referencedIds` = union of all frames' `reference_ids` (so the gateway can
  exclude them from blob deletion).

**`src/web/gateway.js`** — new export:

```js
export async function clearAllFrameImagesForBeatViaGateway({ beatId }) {
  const { freedImageIds, referencedIds, storyboardIds } = await clearAllFrameImagesForBeat(beatId);
  // Free blobs, but never delete an id still referenced by a frame's reference_ids
  // or the beat's main_image_id (the codebase "may be shared" guard).
  const beat = await getBeat(beatId);
  const protectedIds = new Set([...referencedIds.map(String), ...(beat?.main_image_id ? [String(beat.main_image_id)] : [])]);
  const toDelete = [...new Set(freedImageIds.map(String))].filter((id) => !protectedIds.has(id));
  if (toDelete.length) await deleteImages(toDelete);          // src/mongo/images.js
  broadcastFieldsUpdated(`storyboards:${beatId}`, { changed: ['frames'], cleared_images: true, beat_id: String(beatId) });
  return { cleared: storyboardIds.length, freed: toDelete.length };
}
```

- One broadcast to the room triggers the SPA's `CollabSurface onPing → onRefresh`
  (full refetch), so every tile clears at once.

### 3. Backend — routes (`src/web/entityRoutes.js`)

All three require the session middleware already applied to this router.

- `POST /storyboards/generate-images` — body `{ beat_id, image_model }`.
  - 400 if no `beat_id`; 404 if beat not found.
  - Validate `image_model` against the storyboard model allow-list (reuse the same
    validation/normalisation the per-frame `/frame/:frameId/generate` route uses,
    `entityRoutes.js:2798-2875`); default to `'nano-banana-pro'` if absent.
  - 409 if `isBeatLocked(beat._id)`.
  - `const { jobId, planned } = await startBulkFrameGenerationJob({ beatId, imageModel, announceUsername });` → **202** `{ job_id: jobId, planned, beat_id }`.
- `GET /storyboards/generate-images/:jobId` — `getImageGenerationJob`; 404 if
  missing; else `{ job }`. (Mirrors `/storyboards/generate/:jobId`.)
- `POST /storyboards/clear-images` — body `{ beat_id }`. Mirrors `/storyboards/clear`
  (`:4498-4516`): 400/404 guards, 409 if `isBeatLocked`, then
  `clearAllFrameImagesForBeatViaGateway({ beatId: beat._id })` → 200
  `{ cleared, freed, beat_id }`.

`announceUsername`: pull from the session/request the same way the per-frame
generate route does (look at how `/frame/:frameId/generate` obtains it).

### 4. Frontend — model picker dialog (`web/src/widgets/BulkGenerateImagesDialog.jsx`)

New small modal (`Modal` from `./Modal.jsx`), props:
`{ open, onClose, onSubmit, missingCount, skipCount }`.

- State: `imageModel`, initialized from `readStoredImageModel('screenplay.storyboard.model')`;
  persist with `writeStoredImageModel` on change (shares the per-frame default).
- Body:
  - Summary line: *"{missingCount} start frame(s) missing → will be generated.
    {skipCount} already have an image → skipped."* If `missingCount === 0`, show
    *"All start frames already have images. Nothing to generate."* and disable Generate.
  - Image-model radio list from `IMAGE_MODELS` (same markup as
    `FrameRegenerateDialog` model row).
- Footer: Cancel / Generate (primary, disabled when `missingCount === 0`).
- `onSubmit({ imageModel })`.

### 5. Frontend — toolbar wiring (`web/src/routes/StoryboardBeat.jsx`)

- **State:** `imageGenDialogOpen`, `imageGenerating`, `imageJobStatus`,
  `imageGenError`, `imagePollRef`, `confirmDeleteImages`, `deleteImagesError`.
  Keep separate from the existing plan-gen state.
- **Missing/skip counts** (client-side from `sortedItems`):
  - `missingCount` = shots where `frames?.[0]` exists and `frames[0].image_id == null`.
  - `skipCount` = shots where `frames?.[0]?.image_id` is set.
  (Shots with empty pools count as neither.)
- **Buttons** (added to the existing `:300` button group):
  - `Generate all images` — `onClick` opens `BulkGenerateImagesDialog`. Disabled
    while `generating || imageGenerating || sortedItems.length === 0`. Tooltip:
    *"Render the start-frame image for every shot that's missing one."*
  - `Delete all images` (`className="danger"`) — opens a `ConfirmDialog`. Disabled
    while `generating || imageGenerating || sortedItems.length === 0`. Tooltip:
    *"Remove every generated frame image in this beat (keeps prompts & references)."*
- **Generate flow:** dialog `onSubmit({imageModel})` → close →
  `apiPostJson('/storyboards/generate-images', { beat_id: data.beat._id, image_model: imageModel })`
  → set `imageGenerating=true`, seed `imageJobStatus` → poll
  `GET /storyboards/generate-images/:jobId` every 2000ms via `imagePollRef`,
  reusing the same logic as `pollJob` (`:199-218`): on `done|partial|error` clear
  the interval, set `imageGenerating=false`, `onRefresh()`; otherwise `onRefresh()`
  so partial completions show. Render `<StoryboardGenerationProgress job={imageJobStatus} .../>`
  (reuse component) while `imageGenerating`.
- **Delete flow:** `ConfirmDialog` (danger) message: *"This removes every generated
  frame image in this beat ({total image count}). Prompts and reference images are
  kept. This cannot be undone."* → on confirm
  `apiPostJson('/storyboards/clear-images', { beat_id })` → `onRefresh()`; show
  `deleteImagesError` banner on failure.
- Disable the existing plan **Generate** / **Delete all** buttons while
  `imageGenerating` too (mutual exclusion; the beat lock enforces it server-side,
  but the UI should reflect it).
- Clean up `imagePollRef` in the existing unmount effect (`:261-265`).

## Data flow

```
[Generate all images]
  click → BulkGenerateImagesDialog (pick model)
    → POST /storyboards/generate-images {beat_id, image_model}
      → startBulkFrameGenerationJob: build targets (frames[0], image_id==null)
        → 202 {job_id, planned}
      → withBeatLock: for each target → regenerateStoryboardFrameInternal
           (reads frame.prompt || suggested, loads reference_ids, dispatches model,
            uploads, setStoryboardFrameImageViaGateway → broadcast fields_updated)
    SPA: poll GET /storyboards/generate-images/:jobId (2s) → StoryboardGenerationProgress
         + Hocuspocus pings fill tiles live → onRefresh on terminal status

[Delete all images]
  click → ConfirmDialog → POST /storyboards/clear-images {beat_id}
    → clearAllFrameImagesForBeatViaGateway
        → clearAllFrameImagesForBeat (null image_id/previous_image_id/last_edit_prompt on all frames)
        → deleteImages(freed − referenced − beat.main_image_id)
        → broadcast fields_updated → SPA onRefresh
    → 200 {cleared, freed}
```

## Error handling

- **Beat busy (409):** both POST routes return 409 when `isBeatLocked`. The SPA
  surfaces the error in `imageGenError` / `deleteImagesError`. (Buttons are already
  disabled during local jobs; 409 covers the bot/other-client case.)
- **Per-frame failure:** the bulk job catches each frame error, increments
  `failed`, records an event, and continues. Final status `partial` if any failed;
  the progress panel already shows `· N failed`.
- **Missing model key (no fal/openai/gemini key):** the dispatcher returns its
  usual error; it surfaces as a failed frame (`partial`), not a crash.
- **No targets:** Generate job completes immediately as `done` with
  `"No missing start frames."`; the dialog also disables Generate when
  `missingCount === 0` so this is rare.
- **Shared blobs on delete:** never delete an id present in any frame's
  `reference_ids` or the beat's `main_image_id`.

## Testing

Vitest, using the in-memory fake Mongo (`tests/_fakeMongo.js`) per existing
patterns. New file `tests/storyboard-bulk-images.test.js` (or extend an existing
storyboard test file):

- **`clearAllFrameImagesForBeat`**: seed a beat with N shots, frames carrying
  `image_id`/`previous_image_id`/`reference_ids`; assert image fields null after,
  `reference_ids` + `prompt` preserved, and `freedImageIds` excludes nothing it
  shouldn't (referenced/main_image guard verified at the gateway layer or via a
  focused unit on the filter).
- **target selection**: `listMissingStartFrameTargets` returns only shots whose
  `frames[0].image_id == null`; skips shots with empty pools and shots whose
  start frame already has an image.
- **prompt fallback**: a target with empty `frame.prompt` uses
  `buildSuggestedFramePrompt` (mock the dispatcher; assert the prompt passed in is
  non-empty / equals the suggested text).
- **bulk job accounting**: mock `regenerateStoryboardFrameInternal` /
  `callGenerateImage`; one failing frame → `status==='partial'`, `completed`/`failed`
  counts correct, loop does not abort.
- **route guards**: 400 (no beat_id), 404 (bad beat), 409 (beat locked), 202 with
  `{job_id, planned}` on success; clear route returns `{cleared, freed}`.
- Run `npx vitest run tests/storyboard-bulk-images.test.js` and the full suite.

Manual: build the SPA (`npm run build:web`), open a beat storyboard, verify the
two buttons, the dialog summary counts, live tile fill-in during generation, the
progress panel, and that Delete clears tiles while keeping references.

## Out of scope

- Whole-movie (cross-beat) bulk generate — per-beat only for v1.
- Generating non-start frames in bulk — start frame only.
- Image cost tracking / pre-flight cost estimate.
- Cancel/abort mid-job (the existing plan-gen job has none either).
- Editing prompts/references from the bulk dialog (use the per-frame flow).

## Touched files

- `src/web/storyboardGenerate.js` — `imageJobs`, `getImageGenerationJob`,
  `listMissingStartFrameTargets`, `startBulkFrameGenerationJob`,
  `runBulkFrameGenerationJob`. (Reuses `regenerateStoryboardFrameInternal`,
  `buildSuggestedFramePrompt`, `recordProgress`, `makeJobId`, `withBeatLock`.)
- `src/mongo/storyboards.js` — `clearAllFrameImagesForBeat`.
- `src/web/gateway.js` — `clearAllFrameImagesForBeatViaGateway`.
- `src/web/entityRoutes.js` — 3 routes.
- `web/src/widgets/BulkGenerateImagesDialog.jsx` — new.
- `web/src/routes/StoryboardBeat.jsx` — 2 buttons + state + poll + confirm + dialog.
- `tests/storyboard-bulk-images.test.js` — new.
