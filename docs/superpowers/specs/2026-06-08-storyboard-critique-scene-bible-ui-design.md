# Storyboard critique + scene-bible UI — design (Plan 3 of 3)

**Date:** 2026-06-08
**Status:** Design approved, pending spec review

## Goal

Surface the (already-built) scene bible and critique panel in the SPA: an editable, collaborative Scene Bible; per-shot critique scores and detailed lens breakdowns; and one-click actions to critique, regenerate a shot from its critique, and re-expand all shots from the bible.

Builds on Plan 1 (scene bible + two-pass generation) and Plan 2 (critique engine, `prompt_critique`/`image_critique` persisted fields, `POST /storyboard/:id/critique`, `GET /storyboard/critique/job/:jobId`, `POST /storyboard/:id/reexpand`).

## Decisions (from brainstorming)

- **Score badge:** inline chip *before* the summary text on the collapsed shot row, colored by score, with a ⚑ flag when below threshold (default < 6). Shows the image score if present, else the prompt score.
- **Critique panel (expanded shot):** full breakdown — overall score, `prompt N · render M` sub-scores, all four lenses (name · score · bar · comment) always visible, plus action buttons in the header.
- **Scene Bible editor:** a collapsible panel atop the Storyboard page (not a beat tab), collapsing to a one-line summary bar. **Live-collaborative (y-doc)** — the 8 fields are Yjs/Tiptap fragments like the beat body.
- **Video models:** unchanged. All models stay; first-last-frame models remain usable because the video-gen dialog already lets you assign reference images as start/end frames.
- **Bulk re-expand:** "Re-expand all shots from bible" shows a confirm dialog ("rewrites prompts for all N shots"). Per-shot "Regenerate from critique" is one-click.
- **Deferred (out of scope):** an AI "Regenerate bible" button (re-deriving the bible via a bible-only generation pass) — a later feature.

## Architecture

Two thin backend additions + the React UI.

### Backend A — Scene bible as collaborative fragments

Mirror the character-template-fields pattern (verified in `src/web/roomRegistry.js` `describeCharacterRoom`, which exposes `fields.<x>` fragments).

- In `describeBeatRoom` (`src/web/roomRegistry.js`), add 8 fragments named `scene_bible.<field>` for each `SCENE_BIBLE_FIELDS` (`location`, `time_of_day`, `lighting_key`, `palette`, `mood`, `blocking`, `continuity_anchors`, `camera_language`).
  - `fieldNames` gains `scene_bible.${f}`.
  - `readMongoValue('scene_bible.X')` → `beat.scene_bible?.[X] ?? ''`.
  - `seed[...]` carries those values so a fresh fragment seeds from the stored bible.
- **Persist hook:** in `describeBeatRoom`'s `persistFields(snapshot)`, after the existing body/name/desc patch, detect whether any `scene_bible.*` fragment changed vs `readMongoValue`. If so, reassemble the whole bible object from the snapshot:
  ```js
  const bible = {};
  for (const f of SCENE_BIBLE_FIELDS) bible[f] = snapshot[`scene_bible.${f}`] ?? readMongoValue(`scene_bible.${f}`);
  await setBeatSceneBible(id, bible);
  ```
  Whole-object read-modify-write via the existing `setBeatSceneBible` (Plan 1) — normalizes, stamps `updated_at`, writes `beats.$.scene_bible`. This sidesteps the MongoDB "can't traverse a null path" problem with dotted `scene_bible.location` `$set` when the bible is currently `null`, and needs **no change to `updateBeat`'s field whitelist**. Report the changed scene_bible fields in the `persistFields` result so the store-tick log is accurate.
- No reindex for bible-only changes (bible isn't searched).

### Backend B — Bulk "re-expand all shots from bible"

A new async job, mirroring the existing critique/generation in-memory job pattern in `src/web/storyboardGenerate.js`.

- `startReExpandAllJob({ beatId })` → returns a job id; the worker holds the beat lock **once** (`withBeatLock`), loads the beat + its scene bible + director's notes, lists the beat's storyboards, and for each runs the same single-shot Pass-2 logic that `reExpandShot` uses (inheriting `beat.scene_bible`), persisting each shot's new `text_prompt` + start-frame prompt. Per-shot failures are swallowed + logged; progress is recorded per shot (`recordProgress`-style). To avoid double-locking, factor the lock-free core of `reExpandShot` into a helper (e.g. `reExpandShotInner`) that both the per-shot path (with lock) and the bulk job (lock held once) call.
- `getReExpandAllJob(jobId)`.
- Routes in `src/web/entityRoutes.js` (under `requireSession()`): `POST /beat/:beatId/reexpand-shots` (202 + `{job_id, beat_id}`) and `GET /beat/reexpand/job/:jobId` (`{job}`), mirroring the storyboard job routes. Watch route ordering so `/beat/reexpand/job/:jobId` isn't shadowed by a `/beat/:id` route — use a literal path prefix as the existing job routes do.

### Frontend — three surfaces

The REST `GET /storyboards?beat_id=` already returns full docs (no projection), so `prompt_critique`/`image_critique` reach the SPA already. Live refresh is already wired: `CollabSurface` `stateless` → `fields_updated` → the storyboard page's `onRefresh()` re-fetch (the Plan-2 critique persist broadcasts `changed:['critique']`).

1. **Collapsed-row score chip** — `web/src/widgets/StoryboardItemCollapsed.jsx`. A small pill rendered before the `.storyboard-item-collapsed-summary` text: `{overall}` colored by band (good/medium/bad), with a ⚑ when `overall < FLAG_THRESHOLD` (6). Score source: `image_critique?.overall ?? prompt_critique?.overall ?? null`; render nothing when null. New CSS classes mirroring `.artwork-badge` conventions and the `--ok`/`--warning`/`--danger` vars.

2. **Expanded critique panel** — `web/src/widgets/StoryboardItem.jsx`, a new section above `<ShotMetaRow>`. Renders the chosen full-breakdown layout: overall score, `prompt N · render M` line (from the two critique objects), the four lens rows (`lenses[]` → name · score · bar · comment), and a header with three buttons:
   - **Critique prompt** → `POST /storyboard/:id/critique?target=prompt`, poll `GET /storyboard/critique/job/:jobId` every 2s, `onRefresh()` on done (reuse the existing frame-job polling pattern in this file).
   - **Critique image** → same with `?target=image`; disabled (with a tooltip) when the shot has no rendered start-frame image.
   - **Regenerate from critique** → `POST /storyboard/:id/reexpand` with `{use_critique:true}`, one-click, `onRefresh()` on completion.
   - When a shot has no critique yet, the panel shows a "Not critiqued yet" state with just the Critique buttons.

3. **Scene Bible panel** — atop `web/src/routes/StoryboardBeat.jsx`, a new `<SceneBiblePanel beatId=…>` wrapped in a second `<CollabSurface room={`beat:${beatId}`}>` (nested beside the existing `storyboards:${beatId}` surface). Collapsible (defaults collapsed to a one-line summary bar derived from the bible). When open, loops the 8 fields rendering `<CollabField field={`scene_bible.${f}`} label=… multiline>` each. Header buttons: **Re-expand all shots** (confirm dialog → `POST /beat/:beatId/reexpand-shots`, poll the job, `onRefresh()`). The SPA holds its own small copy of the field list + labels (the 8 fields are stable; avoids cross-importing server code into the Vite app).

## Testing

- **Backend (TDD, Vitest + fake Mongo):**
  - `describeBeatRoom` exposes the 8 `scene_bible.*` fragments, seeds them from `beat.scene_bible`, and `persistFields` writes a changed bible back via `setBeatSceneBible` (and does nothing when unchanged). Extend `tests/_fakeMongo.js` only if the persist path needs a shape it doesn't support.
  - The bulk re-expand job: `startReExpandAllJob` re-expands every shot of a beat (via the `_setShotExpanderForTests` seam), persists new prompts per row, reports done; holds the lock once; per-shot failure doesn't abort the job. Routes return the documented shapes.
- **Frontend:** the plan's first frontend task checks for an existing React test harness (Testing Library / jsdom in `web/`); if present, add component tests for the score-chip band/flag logic and the critique-panel render. Regardless, verify the three surfaces in the running app (real beat with critiqued shots): chip color/flag, panel breakdown + button flows, bible edit persisting + re-expand. `npm run build:web` must stay green.

## Out of scope (→ future)

- AI "Regenerate bible" (bible-only re-derivation pass).
- Any change to the video model registry.
