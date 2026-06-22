# Bulk reference reassign + Tune Image Sheet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add (A) a storyboard-page button that wipes and re-runs reference-image assignment across every frame in a beat, and (B) an Artwork-tab button that makes a critique-driven second pass at a beat's image sheet, adding only the plates the storyboard actually needs.

**Architecture:** Both features reuse existing pipelines. (A) reuses `selectFrameReferencesForShot()` (the per-frame auto-suggest scorer) applied to every frame via a new in-memory background job, mirroring the bulk start-frame generation job. (B) adds a new "tune scan" job that runs a per-shot LLM scanner against the beat's existing plate catalog + each shot's image critique, proposes new static plates, consolidates duplicates, and parks the result on the same image-sheet job map so the existing derive→review→generate UI and the existing `/beat/:id/image-sheet` generate path are reused unchanged.

**Tech Stack:** Node.js (ESM), Express, MongoDB (GridFS), Anthropic SDK, React/Vite SPA, Vitest with the in-memory fake Mongo (`tests/_fakeMongo.js`).

## Global Constraints

- **`project_id` threading:** every project-scoped Mongo helper takes `projectId` as its first parameter and throws `projectId required` on a falsy value. Thread `req.projectId` through all new routes/jobs. (CLAUDE.md)
- **Optional-integration pattern:** image/LLM features must degrade to a user-facing error string when the API key is missing, never throw out of the agent loop. New LLM jobs check `config.anthropic?.apiKey` before starting (mirror `startShotPlanJob`).
- **In-memory jobs:** background-job state lives in a module-level `Map`, polled by the SPA; lost on restart — acceptable (mirror `imageSheetJobs.js`).
- **Tool/handler parity:** these features add **no** agent tools — they are SPA/REST only. Do not touch `src/agent/tools.js` / `handlers.js`.
- **Gateway is the single writer:** all entity mutations route through `src/web/gateway.js` helpers (e.g. `setStoryboardFrameReferenceImagesViaGateway`), never direct Mongo writes from routes/jobs.
- **Tests:** Mongo-touching tests use `createFakeDb()` from `tests/_fakeMongo.js`, mocked via `vi.mock('../src/mongo/client.js', ...)`, with dynamic `await import(...)` of the module under test after the mock is registered, and `fakeDb.reset()` in `beforeEach`.
- **No commit attribution / co-author trailers.** End commit messages with `Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4`.
- Run on branch `feat/storyboard-ref-reassign-tune-sheet` (already created).

---

## File Structure

**Part A — bulk reassign**
- Create: `src/web/storyboardReferenceJobs.js` — the bulk reassign job engine (in-memory map + `startReassignReferencesJob` + `getReassignReferencesJob` + pure `buildFrameShotText`).
- Modify: `src/web/entityRoutes.js` — add `POST /storyboards/reassign-references` + `GET /storyboards/reassign-references/:jobId` (next to the existing `/storyboards/generate-images` routes near line 5091).
- Modify: `web/src/routes/StoryboardBeat.jsx` — add the "Assign reference images" button + confirm dialog + poll.
- Test: `tests/storyboardReassignReferences.test.js`.

**Part B — tune image sheet**
- Modify: `src/mongo/plots.js` — `setBeatImageSheetReferences()` + pure `computeImageSheetPrefillIds()`.
- Modify: `src/web/beatSheetPlanner.js` — extract `STATIC_PLATE_CONSTRAINTS` constant (no behavior change).
- Create: `src/web/storyboardSheetTuner.js` — per-shot scanner + consolidation + `tuneStoryboardImageSheet()` orchestrator (with test seams).
- Modify: `src/web/imageSheetJobs.js` — `startTuneScanJob()` + `runTuneScanJob()` (parks proposed plates on the shared job map).
- Modify: `src/web/entityRoutes.js` — `POST /beat/:id/tune-scan`, `GET /beat/:id/image-sheet-references`, and persist refs in `POST /<host>/:id/image-sheet` for beats.
- Create: `web/src/widgets/TuneImageSheetDialog.jsx` — prefill refs → scan → review → generate.
- Modify: `web/src/widgets/ArtworkTab.jsx` — "Tune image sheet for storyboard" button + storyboard-count fetch + dialog wiring.
- Test: `tests/plots-image-sheet-references.test.js`, `tests/storyboardSheetTuner.test.js`, `tests/imageSheetTuneJob.test.js`.

---

## Task 1: Bulk reassign job engine + routes (Part A backend)

**Files:**
- Create: `src/web/storyboardReferenceJobs.js`
- Modify: `src/web/entityRoutes.js` (add two routes after line 5138)
- Test: `tests/storyboardReassignReferences.test.js`

**Interfaces:**
- Consumes: `listStoryboards({ beatId })` (`src/mongo/storyboards.js:379`); `getBeat(projectId, id)` (`src/mongo/plots.js:225`); `selectFrameReferencesForShot({ projectId, sb, frameText, maxTotal })` → `{ ids, candidates, scores, referenceScores }` and `REFERENCE_LIST_MAX` (`src/web/frameReferences.js:211,31`); `setStoryboardFrameReferenceImagesViaGateway({ projectId, storyboardId, frameId, imageIds, mode, scores })` (`src/web/gateway.js:1751`); `isBeatLocked`, `withBeatLock` (`src/web/beatLocks.js`); `BeatBusyError` (`src/web/storyboardGenerate.js`).
- Produces: `startReassignReferencesJob({ projectId, beatId })` → `{ job_id, planned, beat_id }` (throws `BeatBusyError` when the beat is locked); `getReassignReferencesJob(jobId)` → job or null; `buildFrameShotText(sb, frame)` → string.

- [ ] **Step 1: Write the failing test**

Create `tests/storyboardReassignReferences.test.js`:

```js
// Bulk reference reassignment job: wipes every frame's references and re-runs
// the scored auto-suggest pipeline across all frames in a beat.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Gateway = await import('../src/web/gateway.js');
const Selector = await import('../src/llm/frameReferenceSelector.js');
const Jobs = await import('../src/web/storyboardReferenceJobs.js');

let projectId;
let beat;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  beat = await Plots.createBeat({ projectId, name: 'B1', body: 'INT. ROOM — DAY', characters: [] });
  Selector._setFrameReferenceScorerForTests(null);
});

async function waitForJob(jobId, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Jobs.getReassignReferencesJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish in time');
}

describe('startReassignReferencesJob', () => {
  it('wipes existing references on every frame when selection returns nothing', async () => {
    // No beat artworks → selectFrameReferencesForShot returns [] → frames wiped.
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 'a shot' });
    const { frameId } = await Gateway.addStoryboardFrameViaGateway({
      projectId, storyboardId: sb._id, prompt: 'frame prompt',
    });
    const seedId = new ObjectId().toString();
    await Gateway.setStoryboardFrameReferenceImagesViaGateway({
      projectId, storyboardId: sb._id, frameId, imageIds: [seedId], mode: 'replace', scores: { [seedId]: 0.9 },
    });

    const { job_id } = await Jobs.startReassignReferencesJob({ projectId, beatId: beat._id });
    const job = await waitForJob(job_id);

    expect(job.status).toBe('done');
    expect(job.planned).toBe(1);
    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    expect(fresh.frames[0].reference_ids.map(String)).toEqual([]);
    expect(fresh.frames[0].reference_scores).toEqual({});
  });

  it('reassigns references from the beat artwork catalog using the scorer', async () => {
    // Seed one done beat artwork, then stub the scorer to score it 1.0.
    const art = await Gateway.createPendingArtworkViaGateway({
      projectId, hostType: 'beat', hostId: beat._id.toString(),
      prompt: 'an empty room plate', name: 'Room plate', model: 'nano-banana-pro', referenceImageIds: [],
    });
    const resultId = new ObjectId();
    await Gateway.setArtworkResultViaGateway({
      projectId, hostType: 'beat', hostId: beat._id.toString(),
      artworkId: art.artwork._id, resultImageId: resultId,
    });
    Selector._setFrameReferenceScorerForTests(async ({ candidates }) => {
      const m = new Map();
      candidates.forEach((_c, i) => m.set(i + 1, 1.0));
      return m;
    });

    const sb = await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 'room shot' });
    const { frameId } = await Gateway.addStoryboardFrameViaGateway({
      projectId, storyboardId: sb._id, prompt: 'a frame',
    });

    const { job_id } = await Jobs.startReassignReferencesJob({ projectId, beatId: beat._id });
    const job = await waitForJob(job_id);

    expect(job.status).toBe('done');
    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    expect(fresh.frames[0].reference_ids.map(String)).toContain(resultId.toString());
  });
});

describe('buildFrameShotText', () => {
  it('joins summary, text_prompt, and frame prompt, stripping markdown and blanks', () => {
    const text = Jobs.buildFrameShotText(
      { summary: '**Summary**', text_prompt: 'wide' },
      { prompt: 'frame _detail_' },
    );
    expect(text).toBe('Summary\nwide\nframe detail');
  });
});
```

> Note on `setArtworkResultViaGateway` arg names: confirm the exact parameter names by reading `src/web/gateway.js:955` (the signature in this repo is `{ projectId, hostType, hostId, artworkId, resultImageId, ... }`). Adjust the test call if they differ.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboardReassignReferences.test.js`
Expected: FAIL — `Cannot find module '../src/web/storyboardReferenceJobs.js'`.

- [ ] **Step 3: Create the job engine**

Create `src/web/storyboardReferenceJobs.js`:

```js
// Bulk reference-image reassignment for a beat's storyboard frames.
//
// Wipes every frame's references and re-runs the SAME scored auto-suggest
// pipeline used by the per-frame "Auto-suggest" button (selectFrameReferencesForShot),
// applied to every frame in every storyboard of the beat. Status lives in an
// in-memory job map the SPA polls — same convention as the bulk start-frame
// generation job. Held under the per-beat lock so it can't race plan generation
// or per-frame edits.

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { listStoryboards } from '../mongo/storyboards.js';
import { getBeat } from '../mongo/plots.js';
import { selectFrameReferencesForShot, REFERENCE_LIST_MAX } from './frameReferences.js';
import { setStoryboardFrameReferenceImagesViaGateway } from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { BeatBusyError } from './storyboardGenerate.js';

const MAX_JOB_EVENTS = 100;
const jobs = new Map();

export function getReassignReferencesJob(jobId) {
  return jobs.get(jobId) || null;
}

function makeJobId() {
  return new ObjectId().toString();
}

function recordProgress(job, { phase, step, frame = null, total = null, message }) {
  if (!job) return;
  const ts = new Date();
  job.progress = { ts, phase, step, frame, total, message, started_at: ts };
  if (!Array.isArray(job.events)) job.events = [];
  job.events.push({ ts, phase, step, frame, total, message });
  if (job.events.length > MAX_JOB_EVENTS) {
    job.events.splice(0, job.events.length - MAX_JOB_EVENTS);
  }
}

// Compose the shot text the scorer sees for one frame — identical to the
// per-frame auto-populate endpoint (entityRoutes.js ~3910) so bulk and
// single-frame results match exactly.
export function buildFrameShotText(sb, frame) {
  return [sb?.summary, sb?.text_prompt, frame?.prompt]
    .map((s) => stripMarkdown(String(s || '')).trim())
    .filter(Boolean)
    .join('\n');
}

async function runReassignJob({ projectId, job, beatId }) {
  try {
    const storyboards = await listStoryboards({ beatId });
    const targets = [];
    for (const sb of storyboards) {
      for (const frame of sb.frames || []) targets.push({ sb, frame });
    }
    job.planned = targets.length;
    if (!targets.length) {
      job.status = 'done';
      job.finished_at = new Date();
      recordProgress(job, { phase: 'done', step: 'job_done_empty', message: 'No frames to reassign.' });
      return;
    }
    job.status = 'rendering';
    recordProgress(job, {
      phase: 'rendering', step: 'reassign_start', total: targets.length,
      message: `Reassigning references for ${targets.length} frame${targets.length === 1 ? '' : 's'}…`,
    });
    for (let index = 0; index < targets.length; index += 1) {
      const { sb, frame } = targets[index];
      const order = index + 1;
      try {
        const frameText = buildFrameShotText(sb, frame);
        const { ids, referenceScores } = await selectFrameReferencesForShot({
          projectId, sb, frameText, maxTotal: REFERENCE_LIST_MAX,
        });
        // mode 'replace' wipes the prior refs/scores AND writes the new set in
        // one atomic step — even when ids is empty (the requested "remove all
        // references" behavior).
        await setStoryboardFrameReferenceImagesViaGateway({
          projectId, storyboardId: sb._id, frameId: frame._id,
          imageIds: ids, mode: 'replace', scores: referenceScores,
        });
        job.completed += 1;
        recordProgress(job, {
          phase: 'rendering', step: 'frame_done', frame: order, total: targets.length,
          message: `Frame ${order}/${targets.length}: ${ids.length} reference${ids.length === 1 ? '' : 's'}`,
        });
      } catch (e) {
        job.failed += 1;
        recordProgress(job, {
          phase: 'rendering', step: 'frame_failed', frame: order, total: targets.length,
          message: `Frame ${order}/${targets.length}: failed — ${e.message}`,
        });
        logger.warn(`reassign refs ${job.job_id} frame ${order} failed: ${e.message}`);
      }
    }
    job.status = job.failed > 0 ? 'partial' : 'done';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: job.status, step: 'job_done',
      message: `Done — ${job.completed} reassigned${job.failed ? `, ${job.failed} failed` : ''}.`,
    });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'job_crashed', message: `Reassign crashed: ${e.message}` });
    logger.error(`reassign refs job ${job.job_id} crashed: ${e.message}`);
  }
}

// Start a background reassignment job. Returns { job_id, planned, beat_id }
// immediately. Throws BeatBusyError if the beat is locked.
export async function startReassignReferencesJob({ projectId, beatId }) {
  const beat = await getBeat(projectId, beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    beat_id: beat._id.toString(),
    project_id: projectId,
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planned: 0,
    completed: 0,
    failed: 0,
    progress: null,
    events: [],
  };
  jobs.set(jobId, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued', message: 'Queued reference reassignment…' });

  withBeatLock(beat._id, () => runReassignJob({ projectId, job, beatId: beat._id })).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'job_crashed', message: `Reassign crashed: ${e.message}` });
    logger.error(`reassign refs job ${jobId} crashed (outer): ${e.message}`);
  });

  return { job_id: jobId, planned: 0, beat_id: beat._id.toString() };
}
```

> Before writing, confirm `beatLocks.js` exports `isBeatLocked` and `withBeatLock` (grep `src/web/storyboardGenerate.js` — it uses both; copy the import path it uses). Confirm `BeatBusyError` is exported from `src/web/storyboardGenerate.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboardReassignReferences.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the routes**

In `src/web/entityRoutes.js`, immediately after the `GET /storyboards/generate-images/:jobId` route (ends ~line 5138), add:

```js
  // Page-level "Assign reference images": wipe every frame's references in the
  // beat and re-run the scored auto-suggest pipeline for each. Async job; poll
  // GET /storyboards/reassign-references/:jobId.
  router.post('/storyboards/reassign-references', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(req.projectId, String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res.status(409).json({ error: 'Storyboard work in progress for this beat; try again' });
      }
      const { startReassignReferencesJob } = await import('./storyboardReferenceJobs.js');
      const { BeatBusyError } = await import('./storyboardGenerate.js');
      try {
        const result = await startReassignReferencesJob({ projectId: req.projectId, beatId: beat._id });
        res.status(202).json(result);
      } catch (e) {
        if (e instanceof BeatBusyError) return res.status(409).json({ error: e.message });
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/storyboards/reassign-references/:jobId', async (req, res, next) => {
    try {
      const { getReassignReferencesJob } = await import('./storyboardReferenceJobs.js');
      const job = getReassignReferencesJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      if (job.project_id && String(job.project_id) !== String(req.projectId)) {
        return res.status(404).json({ error: 'job not found' });
      }
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });
```

- [ ] **Step 6: Run the full suite + commit**

Run: `npm test`
Expected: PASS (no regressions).

```bash
git add src/web/storyboardReferenceJobs.js src/web/entityRoutes.js tests/storyboardReassignReferences.test.js
git commit -m "✨ Add bulk reference-reassign job + routes for storyboard frames

Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4"
```

---

## Task 2: "Assign reference images" button (Part A frontend)

**Files:**
- Modify: `web/src/routes/StoryboardBeat.jsx`

**Interfaces:**
- Consumes: `POST /storyboards/reassign-references` → `{ job_id, planned, beat_id }`; `GET /storyboards/reassign-references/:jobId` → `{ job }`; `apiGet`, `apiPostJson` (already imported); `ConfirmDialog` (`web/src/widgets/Modal.jsx`, already imported at line 20); `GenerationProgress` (already imported).
- Produces: UI only.

There is no UI unit-test harness in this repo (tests are Vitest backend). Verify via build + manual smoke.

- [ ] **Step 1: Add component state**

In `web/src/routes/StoryboardBeat.jsx`, after the `deleteImagesError` state (line 53), add:

```js
  // "Assign reference images": bulk reassign of every frame's references.
  const [reassigning, setReassigning] = useState(false);
  const [reassignJobStatus, setReassignJobStatus] = useState(null);
  const [reassignError, setReassignError] = useState(null);
  const [confirmReassign, setConfirmReassign] = useState(false);
  const reassignPollRef = useRef(null);
```

- [ ] **Step 2: Add the poll + start handlers**

After the `deleteAllImages` function (ends ~line 340), add:

```js
  async function pollReassignJob(jobId) {
    try {
      const r = await apiGet(`/storyboards/reassign-references/${jobId}`);
      setReassignJobStatus(r.job);
      if (['done', 'partial', 'error'].includes(r.job?.status)) {
        clearInterval(reassignPollRef.current);
        reassignPollRef.current = null;
        setReassigning(false);
        if (r.job.status === 'error') {
          setReassignError(r.job.error || 'Reference reassignment failed.');
        }
        onRefresh();
      } else {
        onRefresh();
      }
    } catch (e) {
      // transient poll error — keep polling (the job runs server-side).
    }
  }

  async function reassignReferences() {
    if (!data?.beat) return;
    setReassignError(null);
    setReassigning(true);
    setShowProgressLog(true);
    setReassignJobStatus({ status: 'queued', completed: 0, planned: 0, failed: 0 });
    try {
      const r = await apiPostJson('/storyboards/reassign-references', { beat_id: data.beat._id });
      const jobId = r.job_id;
      reassignPollRef.current = setInterval(() => pollReassignJob(jobId), 2000);
      pollReassignJob(jobId);
    } catch (e) {
      setReassigning(false);
      setReassignError(e.message);
    }
  }
```

Find the existing unmount cleanup effect (search for `clearInterval(imagePollRef.current)` inside a `useEffect(() => () => ...)`). Add `if (reassignPollRef.current) clearInterval(reassignPollRef.current);` alongside it. If there is no combined cleanup effect, add:

```js
  useEffect(() => () => {
    if (reassignPollRef.current) clearInterval(reassignPollRef.current);
  }, []);
```

- [ ] **Step 3: Add the toolbar button**

In the toolbar `<div>` (after the "Delete all images" button, line 425), add:

```jsx
          <button
            onClick={() => setConfirmReassign(true)}
            disabled={generating || imageGenerating || reassigning || sortedItems.length === 0}
            title="Remove all reference images on every frame and reassign from the current artwork set"
          >
            {reassigning ? 'Assigning references…' : 'Assign reference images'}
          </button>
```

- [ ] **Step 4: Add the error banner + progress panel**

After the `deleteImagesError` banner block (~line 449), add:

```jsx
      {reassignError && (
        <div className="error-banner">Reassign failed: {reassignError}</div>
      )}
      {reassigning && reassignJobStatus && (
        <GenerationProgress
          job={reassignJobStatus}
          noun="frame"
          showLog={showProgressLog}
          onToggleLog={() => setShowProgressLog((s) => !s)}
          logRef={progressLogRef}
        />
      )}
```

- [ ] **Step 5: Add the confirm dialog**

After the `confirmDeleteAll` `<ConfirmDialog>` block (ends ~line 561), add:

```jsx
      <ConfirmDialog
        open={confirmReassign}
        title="Assign reference images?"
        message={
          'This removes all reference images on every frame in this beat — including frames that already have a generated image — and reassigns them from the current artwork set. Generated images are kept. This cannot be undone.'
        }
        confirmLabel="Assign reference images"
        danger
        onConfirm={() => { setConfirmReassign(false); reassignReferences(); }}
        onCancel={() => setConfirmReassign(false)}
      />
```

- [ ] **Step 6: Build + manual verify**

Run: `npm run build:web`
Expected: build succeeds with no errors.

Manual: run `npm run dev` + `npm run dev:web`, open a beat's storyboard page. Confirm the button is disabled with no storyboard items, enabled with items; clicking shows the confirm dialog; confirming shows the progress panel; frames' references update (open the Generate-frame dialog on a frame to verify its reference list changed).

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/StoryboardBeat.jsx
git commit -m "✨ Add 'Assign reference images' bulk button to storyboard page

Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4"
```

---

## Task 3: Persist + prefill the image-sheet reference set (Part B mongo)

**Files:**
- Modify: `src/mongo/plots.js` (add two exports near `setBeatMainImage`, ~line 607)
- Test: `tests/plots-image-sheet-references.test.js`

**Interfaces:**
- Consumes: `resolveProjectId`, `getPlot`, `findBeat`, `fetchBeat`, `updateBeatFields`, `ObjectId` (all in-module in `src/mongo/plots.js`).
- Produces: `setBeatImageSheetReferences(projectId, beatIdentifier, imageIds)` → updated beat doc; `computeImageSheetPrefillIds(beat)` → `string[]` (pure).

- [ ] **Step 1: Write the failing test**

Create `tests/plots-image-sheet-references.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('setBeatImageSheetReferences', () => {
  it('persists the reference id set on the beat and getBeat returns it', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const a = new ObjectId();
    const b = new ObjectId();
    await Plots.setBeatImageSheetReferences(projectId, beat._id, [a.toString(), b.toString()]);
    const fresh = await Plots.getBeat(projectId, beat._id);
    expect(fresh.image_sheet_reference_ids.map(String)).toEqual([a.toString(), b.toString()]);
  });
});

describe('computeImageSheetPrefillIds', () => {
  it('prefers the saved reference set', () => {
    const id = new ObjectId().toString();
    const beat = { image_sheet_reference_ids: [id], artworks: [{ reference_image_ids: [new ObjectId()] }] };
    expect(Plots.computeImageSheetPrefillIds(beat)).toEqual([id]);
  });
  it('falls back to the union of done-artwork reference ids when none saved', () => {
    const r1 = new ObjectId().toString();
    const r2 = new ObjectId().toString();
    const beat = {
      image_sheet_reference_ids: [],
      artworks: [
        { reference_image_ids: [r1, r2] },
        { reference_image_ids: [r2] }, // duplicate dropped
      ],
    };
    expect(Plots.computeImageSheetPrefillIds(beat)).toEqual([r1, r2]);
  });
  it('returns [] when nothing is available', () => {
    expect(Plots.computeImageSheetPrefillIds({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plots-image-sheet-references.test.js`
Expected: FAIL — `Plots.setBeatImageSheetReferences is not a function`.

- [ ] **Step 3: Implement the helpers**

In `src/mongo/plots.js`, after `setBeatMainImage` (line 607), add:

```js
// Persist the reference-image set chosen for this beat's image sheet, so the
// "Tune image sheet" flow can pre-fill the picker with the same references.
export async function setBeatImageSheetReferences(projectId, beatIdentifier, imageIds) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, beatIdentifier);
  if (!beat) throw new Error(`Beat not found: ${beatIdentifier}`);
  const ids = (Array.isArray(imageIds) ? imageIds : [])
    .map((x) => {
      try { return x instanceof ObjectId ? x : new ObjectId(String(x)); }
      catch { return null; }
    })
    .filter(Boolean);
  await updateBeatFields(projectId, beat._id, { 'beats.$.image_sheet_reference_ids': ids });
  logger.info(`mongo: beat image_sheet_reference_ids set id=${beat._id} count=${ids.length}`);
  return fetchBeat(projectId, beat._id);
}

// Pure: the reference ids used to pre-fill the Tune dialog. Prefers the saved
// image_sheet_reference_ids; falls back to the union of reference_image_ids on
// the beat's artworks (for sheets created before the field existed). Returns
// hex strings.
export function computeImageSheetPrefillIds(beat) {
  const saved = (beat?.image_sheet_reference_ids || []).map((x) => String(x));
  if (saved.length) return saved;
  const seen = new Set();
  const out = [];
  for (const a of beat?.artworks || []) {
    for (const r of a?.reference_image_ids || []) {
      const id = String(r);
      if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plots-image-sheet-references.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mongo/plots.js tests/plots-image-sheet-references.test.js
git commit -m "✨ Persist + prefill beat image-sheet reference set

Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4"
```

---

## Task 4: Save refs on Create-image-sheet + prefill endpoint (Part B backend wiring)

**Files:**
- Modify: `src/web/entityRoutes.js` (image-sheet route ~2606; add a beat-only GET route in the `if (hostType === 'beat')` block ~2628)
- Test: `tests/imageSheetReferencesEndpoint.test.js`

**Interfaces:**
- Consumes: `setBeatImageSheetReferences`, `computeImageSheetPrefillIds`, `getBeat` (`src/mongo/plots.js`); existing `validateArtworkRefs`, `resolveHostId`, `startImageSheetJob`.
- Produces: refs persisted on every beat image-sheet generation; `GET /beat/:id/image-sheet-references` → `{ reference_ids: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/imageSheetReferencesEndpoint.test.js`. This is a thin route test — reuse the Express app harness from `tests/imageSheetRoutes.test.js` (open that file and copy its top-of-file `vi.mock` boilerplate, `createApp`/supertest setup, and project/beat seeding; it already exercises `/beat/:id/image-sheet`). Then add:

```js
// (after copying the harness + seeding `projectId` and a `beat` with one done artwork)
describe('GET /beat/:id/image-sheet-references', () => {
  it('returns saved reference ids when present', async () => {
    const Plots = await import('../src/mongo/plots.js');
    const id = new ObjectId().toString();
    await Plots.setBeatImageSheetReferences(projectId, beat._id, [id]);
    const res = await request(app)
      .get(`/api/beat/${beat._id}/image-sheet-references`)
      .set('X-Project-Id', projectId);
    expect(res.status).toBe(200);
    expect(res.body.reference_ids).toEqual([id]);
  });

  it('falls back to artwork reference ids when none saved', async () => {
    // beat seeded with one artwork carrying reference_image_ids [r1]
    const res = await request(app)
      .get(`/api/beat/${beat._id}/image-sheet-references`)
      .set('X-Project-Id', projectId);
    expect(res.status).toBe(200);
    expect(res.body.reference_ids).toContain(r1);
  });
});
```

> Match the route mount prefix used in `imageSheetRoutes.test.js` (it may be `/` or `/api`); use whatever that file uses. If copying the full harness proves heavy, it is acceptable to assert the persistence half via the Task 3 helper test and verify the route wiring with the manual curl in Step 4 instead — but prefer the route test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/imageSheetReferencesEndpoint.test.js`
Expected: FAIL — 404 (route not registered yet).

- [ ] **Step 3: Persist refs on the image-sheet route**

In `src/web/entityRoutes.js`, in the `POST ${basePath}/:id/image-sheet` handler, right after `const result = await startImageSheetJob({ ... });` (line ~2617) and before `res.status(202).json(result);`, add:

```js
        if (hostType === 'beat') {
          const { setBeatImageSheetReferences } = await import('../mongo/plots.js');
          await setBeatImageSheetReferences(req.projectId, hostId, refs.ids).catch((e) =>
            logger.warn(`image-sheet: persist reference set failed: ${e.message}`));
        }
```

- [ ] **Step 4: Add the prefill endpoint**

In the `if (hostType === 'beat') { ... }` block (after the `shot-plan` route, ~line 2649), add:

```js
      // GET /beat/:id/image-sheet-references — the reference set to pre-fill the
      // Tune dialog with (saved set, else union of the beat's artwork refs).
      router.get(`${basePath}/:id/image-sheet-references`, async (req, res, next) => {
        try {
          const hostId = await resolveHostId(req);
          if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
          const { getBeat, computeImageSheetPrefillIds } = await import('../mongo/plots.js');
          const beat = await getBeat(req.projectId, hostId);
          if (!beat) return res.status(404).json({ error: 'beat not found' });
          res.json({ reference_ids: computeImageSheetPrefillIds(beat) });
        } catch (e) {
          next(e);
        }
      });
```

> Confirm `logger` is in scope in `entityRoutes.js` (it is imported at the top). If `getBeat` is already imported at the top of the file, use that import instead of the dynamic one.

- [ ] **Step 5: Run test + full suite**

Run: `npx vitest run tests/imageSheetReferencesEndpoint.test.js && npm test`
Expected: PASS.

Manual curl (optional, with the dev server running and a valid session header): 
`curl -s localhost:3000/api/beat/<id>/image-sheet-references -H "X-Project-Id: <pid>"` → `{"reference_ids":[...]}`.

- [ ] **Step 6: Commit**

```bash
git add src/web/entityRoutes.js tests/imageSheetReferencesEndpoint.test.js
git commit -m "✨ Persist image-sheet refs on generate; add prefill endpoint

Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4"
```

---

## Task 5: Extract STATIC_PLATE_CONSTRAINTS (Part B refactor)

**Files:**
- Modify: `src/web/beatSheetPlanner.js`
- Test: extend `tests/beatSheetPlanner.test.js` (or add `tests/staticPlateConstraints.test.js`)

**Interfaces:**
- Produces: `export const STATIC_PLATE_CONSTRAINTS` (string) from `src/web/beatSheetPlanner.js`, reused verbatim inside `SCENE_PLATE_PLAN_SYSTEM_PROMPT`.

This is a no-behavior-change extraction so Task 6 can reuse the static-plate rules.

- [ ] **Step 1: Write the failing test**

Add to `tests/beatSheetPlanner.test.js` (or create `tests/staticPlateConstraints.test.js`):

```js
import { describe, it, expect } from 'vitest';
import {
  STATIC_PLATE_CONSTRAINTS,
  SCENE_PLATE_PLAN_SYSTEM_PROMPT,
} from '../src/web/beatSheetPlanner.js';

describe('STATIC_PLATE_CONSTRAINTS', () => {
  it('is exported and embedded verbatim in the phase-1 system prompt', () => {
    expect(STATIC_PLATE_CONSTRAINTS).toContain('CLEAN PLATES');
    expect(SCENE_PLATE_PLAN_SYSTEM_PROMPT).toContain(STATIC_PLATE_CONSTRAINTS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/beatSheetPlanner.test.js`
Expected: FAIL — `STATIC_PLATE_CONSTRAINTS` is undefined.

- [ ] **Step 3: Extract the constant**

In `src/web/beatSheetPlanner.js`, define the constant just before `SCENE_PLATE_PLAN_SYSTEM_PROMPT` (line 80), copying the four `# Constraints` bullet lines verbatim from the current prompt (lines 104–107):

```js
// Shared static-plate rules — reused by the storyboard image-sheet tuner so its
// proposed plates obey the same clean-background discipline. Keep verbatim.
export const STATIC_PLATE_CONSTRAINTS = [
  '- These are CLEAN PLATES — capture only the static set and environment. Omit anything moving, transient, or mid-action even when the beat describes it: shooting stars, lightning, fireworks, explosions, falling/flying objects, moving vehicles, splashing water, birds in flight, drifting smoke as a subject, etc. Render the empty background as it looks BEFORE or AFTER that element passes through — the video stage adds the motion later. (You may keep the lighting such an event casts, e.g. the glow it throws across a rooftop, but never the moving object itself.)',
  '- No characters in the plates unless the beat truly cannot be represented without a figure — these are environments, not staged shots.',
  '- Never put a proper character name in a prompt; image models cannot resolve made-up names.',
  '- Do NOT put justification or quote text into the prompt field.',
].join('\n');
```

Then in `SCENE_PLATE_PLAN_SYSTEM_PROMPT`, replace the four inline `'# Constraints'` bullet strings (lines 103–107) with:

```js
  '# Constraints',
  STATIC_PLATE_CONSTRAINTS,
```

(So the `.join('\n')` produces byte-identical output to before.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/beatSheetPlanner.test.js`
Expected: PASS (including the file's existing tests — confirms no behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/web/beatSheetPlanner.js tests/beatSheetPlanner.test.js
git commit -m "♻️ Extract STATIC_PLATE_CONSTRAINTS for reuse by the sheet tuner

Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4"
```

---

## Task 6: Storyboard image-sheet tuner module (Part B core logic)

**Files:**
- Create: `src/web/storyboardSheetTuner.js`
- Test: `tests/storyboardSheetTuner.test.js`

**Interfaces:**
- Consumes: `getAnthropic` (`src/anthropic/client.js`); `STORYBOARD_MODEL` (`src/web/storyboardGenerate.js`); `STATIC_PLATE_CONSTRAINTS` (`src/web/beatSheetPlanner.js`, Task 5); `stripMarkdown` (`src/util/markdown.js`).
- Produces:
  - `scanShotForPlateGap({ sb, existingPlates })` → `{ needs_plate, name?, prompt?, justification? }`
  - `consolidatePlateProposals({ proposals, existingPlates })` → `[{ name, prompt, justification, quote }]`
  - `tuneStoryboardImageSheet({ storyboards, existingPlates, onProgress })` → `{ images: [{ name, prompt, justification, quote }] }`
  - test seams `_setShotPlateScanForTests(fn)`, `_setConsolidatePlatesForTests(fn)`
  - `buildShotScanUserText({ sb, existingPlates })` → string (exported for testing)

- [ ] **Step 1: Write the failing test**

Create `tests/storyboardSheetTuner.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
// Guard: these tests must use the seams, never a real Anthropic call.
vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => { throw new Error('no live Anthropic in tests'); },
}));

const Tuner = await import('../src/web/storyboardSheetTuner.js');

beforeEach(() => {
  Tuner._setShotPlateScanForTests(null);
  Tuner._setConsolidatePlatesForTests(null);
});

describe('buildShotScanUserText', () => {
  it('includes the shot summary, image critique, and existing plate catalog', () => {
    const sb = {
      summary: 'Hero enters the alley',
      text_prompt: 'wide shot',
      characters_in_scene: ['Hero'],
      image_critique: { overall: 4, lenses: [{ lens: 'bible', score: 3, comments: 'background is wrong' }] },
    };
    const text = Tuner.buildShotScanUserText({ sb, existingPlates: [{ name: 'Street', prompt: 'a street' }] });
    expect(text).toContain('Hero enters the alley');
    expect(text).toContain('background is wrong');
    expect(text).toContain('1. Street — a street');
  });
});

describe('tuneStoryboardImageSheet', () => {
  it('collects proposals from shots that need a plate and skips covered shots', async () => {
    Tuner._setShotPlateScanForTests(async ({ sb }) =>
      sb.summary === 'gap'
        ? { needs_plate: true, name: 'New plate', prompt: 'an empty room', justification: 'no plate covers this' }
        : { needs_plate: false });
    Tuner._setConsolidatePlatesForTests(async ({ proposals }) => proposals); // identity dedup

    const storyboards = [{ summary: 'gap' }, { summary: 'covered' }];
    const { images } = await Tuner.tuneStoryboardImageSheet({ storyboards, existingPlates: [] });
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ name: 'New plate', prompt: 'an empty room', quote: '' });
  });

  it('drops proposals missing a name or prompt', async () => {
    Tuner._setShotPlateScanForTests(async () => ({ needs_plate: true, name: '', prompt: 'x' }));
    const { images } = await Tuner.tuneStoryboardImageSheet({ storyboards: [{ summary: 'a' }], existingPlates: [] });
    expect(images).toEqual([]);
  });

  it('returns proposals unchanged through consolidation when only one', async () => {
    Tuner._setShotPlateScanForTests(async () => ({ needs_plate: true, name: 'P', prompt: 'p' }));
    // consolidate is skipped for <=1 proposal, so the override must NOT be called.
    let called = false;
    Tuner._setConsolidatePlatesForTests(async () => { called = true; return []; });
    const { images } = await Tuner.tuneStoryboardImageSheet({ storyboards: [{ summary: 'a' }], existingPlates: [] });
    expect(called).toBe(false);
    expect(images).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboardSheetTuner.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the tuner module**

Create `src/web/storyboardSheetTuner.js`:

```js
// Storyboard-driven image-sheet tuner.
//
// After a beat's storyboard is generated, this makes a second pass over the
// beat's image sheet. For each storyboard element it asks the model whether the
// beat's EXISTING plates already cover the shot's background; if not, it proposes
// ONE new static background plate. A consolidation pass then merges duplicate
// proposals and drops any already covered by an existing plate. The output is a
// list of proposed plates { name, prompt, justification, quote } rendered later
// through the normal image-sheet generate path.
//
// The per-shot scanner works from a TEXT catalog of existing plates (names +
// prompts) plus the shot's image critique — it is not fed plate images. The
// static-plate rules are shared with the beat planner via STATIC_PLATE_CONSTRAINTS.

import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { STORYBOARD_MODEL } from './storyboardGenerate.js';
import { STATIC_PLATE_CONSTRAINTS } from './beatSheetPlanner.js';

// ---------------------------------------------------------------------------
// Per-shot scan
// ---------------------------------------------------------------------------

export const SHOT_PLATE_SCAN_TOOL = {
  name: 'scan_shot_plate',
  description:
    'Decide whether a beat image sheet needs a NEW static background plate to serve one storyboard shot, and if so propose exactly one.',
  input_schema: {
    type: 'object',
    properties: {
      needs_plate: {
        type: 'boolean',
        description:
          'true ONLY if no existing plate adequately serves this shot AND a new static background plate would meaningfully help.',
      },
      name: { type: 'string', description: 'For needs_plate=true: short gallery label for the new plate.' },
      prompt: {
        type: 'string',
        description:
          'For needs_plate=true: full standalone, purely-visual static background plate prompt (location, sub-location, time of day, lighting, palette, mood, lens/framing).',
      },
      justification: {
        type: 'string',
        description: 'For needs_plate=true: one sentence on which gap this plate fills. Reviewer-facing only.',
      },
    },
    required: ['needs_plate'],
    additionalProperties: false,
  },
};

export const SHOT_PLATE_SCAN_SYSTEM_PROMPT = [
  "You are a storyboard supervisor tuning a beat's set of background PLATES (clean, characterless environment images reused as storyboard backdrops). You are given ONE storyboard shot, any critique notes on its rendered frame, and a catalog of the plates that already exist for this beat.",
  '',
  'Decide whether the existing plates already give this shot a usable background. If an existing plate already depicts this shot\'s location / sub-location / angle / lighting well enough, set needs_plate=false. Only set needs_plate=true when there is a genuine GAP — the shot happens somewhere (or from an angle, or in a lighting state) that no existing plate covers, or the image critique shows the background is wrong or missing — AND a new static plate would fix it.',
  '',
  'When needs_plate=true, propose exactly ONE new plate with a concrete, standalone, purely-visual prompt.',
  '',
  '# Plate constraints',
  STATIC_PLATE_CONSTRAINTS,
  '',
  'Be conservative: prefer needs_plate=false when an existing plate is close enough, and never propose a near-duplicate of an existing plate. Return your decision via the scan_shot_plate tool.',
].join('\n');

function formatExistingPlates(plates) {
  if (!plates?.length) return '(none yet)';
  return plates
    .map((p, i) => `${i + 1}. ${(p.name || '').trim() || '(unnamed)'} — ${(p.prompt || '').trim()}`)
    .join('\n');
}

function formatImageCritique(critique) {
  if (!critique || !Array.isArray(critique.lenses)) return '(no image critique yet)';
  const head = Number.isFinite(critique.overall) ? `overall ${critique.overall}/10` : '';
  const parts = critique.lenses
    .filter((l) => l && l.comments)
    .map((l) => `- ${l.lens} (${l.score}/10): ${stripMarkdown(String(l.comments)).trim()}`);
  return [head, ...parts].filter(Boolean).join('\n') || '(no image critique yet)';
}

export function buildShotScanUserText({ sb, existingPlates = [] }) {
  return [
    '# Storyboard shot under review',
    `summary: ${stripMarkdown(sb?.summary || '').trim() || '(none)'}`,
    `prompt: ${stripMarkdown(sb?.text_prompt || '').trim() || '(none)'}`,
    `characters in scene: ${(sb?.characters_in_scene || []).join(', ') || '(none)'}`,
    '',
    "# Image critique of this shot's rendered frame (the \"need\" signal)",
    formatImageCritique(sb?.image_critique),
    '',
    '# Existing plates in the beat image sheet (the coverage catalog)',
    formatExistingPlates(existingPlates),
    '',
    'Use the scan_shot_plate tool. Set needs_plate=true ONLY for a genuine gap.',
  ].join('\n');
}

let scanOverride = null;
export function _setShotPlateScanForTests(fn) { scanOverride = fn; }

export async function scanShotForPlateGap({ sb, existingPlates = [] }) {
  if (scanOverride) {
    try { return await scanOverride({ sb, existingPlates }); }
    catch (e) { logger.warn(`tuner scan override failed: ${e.message}`); return { needs_plate: false }; }
  }
  const userText = buildShotScanUserText({ sb, existingPlates });
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: STORYBOARD_MODEL,
      max_tokens: 1200,
      system: SHOT_PLATE_SCAN_SYSTEM_PROMPT,
      tools: [SHOT_PLATE_SCAN_TOOL],
      tool_choice: { type: 'tool', name: 'scan_shot_plate' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });
    const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'scan_shot_plate');
    return toolUse?.input || { needs_plate: false };
  } catch (e) {
    logger.warn(`tuner scan failed: ${e.message}`);
    return { needs_plate: false };
  }
}

function proposalFromScan(scan) {
  if (!scan?.needs_plate) return null;
  const name = typeof scan.name === 'string' ? scan.name.trim() : '';
  const prompt = typeof scan.prompt === 'string' ? scan.prompt.trim() : '';
  if (!name || !prompt) return null;
  return {
    name,
    prompt,
    justification: typeof scan.justification === 'string' ? scan.justification.trim() : '',
    quote: '',
  };
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

export const CONSOLIDATE_PLATES_TOOL = {
  name: 'consolidate_plates',
  description:
    'Merge a list of proposed new background plates, dropping near-duplicates and any already covered by the existing plates.',
  input_schema: {
    type: 'object',
    properties: {
      plates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string' },
            justification: { type: 'string' },
          },
          required: ['name', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['plates'],
    additionalProperties: false,
  },
};

export const CONSOLIDATE_PLATES_SYSTEM_PROMPT = [
  'You are consolidating a list of PROPOSED new background plates for a beat image sheet. Merge near-duplicate proposals into one, and DROP any proposal already adequately covered by an existing plate. Keep every genuinely distinct, still-needed plate. Do not invent new plates. Keep prompts purely visual and static.',
  '',
  '# Plate constraints',
  STATIC_PLATE_CONSTRAINTS,
  '',
  'Return the final deduped list via the consolidate_plates tool.',
].join('\n');

let consolidateOverride = null;
export function _setConsolidatePlatesForTests(fn) { consolidateOverride = fn; }

export async function consolidatePlateProposals({ proposals, existingPlates = [] }) {
  const list = (Array.isArray(proposals) ? proposals : []).filter(Boolean);
  if (list.length <= 1) return list; // nothing to dedup
  if (consolidateOverride) {
    try {
      const r = await consolidateOverride({ proposals: list, existingPlates });
      return Array.isArray(r) ? r : list;
    } catch (e) {
      logger.warn(`tuner consolidate override failed: ${e.message}`);
      return list;
    }
  }
  const userText = [
    '# Existing plates (already in the sheet — drop proposals these already cover)',
    formatExistingPlates(existingPlates),
    '',
    '# Proposed new plates (deduplicate and prune)',
    list
      .map((p, i) => `${i + 1}. ${p.name} — ${p.prompt}${p.justification ? ` [why: ${p.justification}]` : ''}`)
      .join('\n'),
    '',
    'Return the final deduped list via the consolidate_plates tool.',
  ].join('\n');
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: STORYBOARD_MODEL,
      max_tokens: 4000,
      system: CONSOLIDATE_PLATES_SYSTEM_PROMPT,
      tools: [CONSOLIDATE_PLATES_TOOL],
      tool_choice: { type: 'tool', name: 'consolidate_plates' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });
    const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'consolidate_plates');
    const out = Array.isArray(toolUse?.input?.plates) ? toolUse.input.plates : null;
    if (!out) return list;
    return out
      .map((p) => ({
        name: typeof p?.name === 'string' ? p.name.trim() : '',
        prompt: typeof p?.prompt === 'string' ? p.prompt.trim() : '',
        justification: typeof p?.justification === 'string' ? p.justification.trim() : '',
        quote: '',
      }))
      .filter((p) => p.name && p.prompt);
  } catch (e) {
    logger.warn(`tuner consolidate failed: ${e.message}`);
    return list;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Scan every storyboard shot, collect plate proposals, consolidate, and return
// the final list. onProgress(evt) receives { phase, step, frame?, total?, message }.
export async function tuneStoryboardImageSheet({ storyboards = [], existingPlates = [], onProgress = null } = {}) {
  const emit = (e) => { try { onProgress?.(e); } catch { /* best-effort */ } };

  emit({
    phase: 'scanning', step: 'scan_start', total: storyboards.length,
    message: `Scanning ${storyboards.length} shot${storyboards.length === 1 ? '' : 's'}…`,
  });
  const proposals = [];
  let done = 0;
  for (const sb of storyboards) {
    let scan;
    try { scan = await scanShotForPlateGap({ sb, existingPlates }); }
    catch (e) { logger.warn(`tuner scan shot ${sb?._id} failed: ${e.message}`); scan = { needs_plate: false }; }
    const proposal = proposalFromScan(scan);
    if (proposal) proposals.push(proposal);
    done += 1;
    emit({ phase: 'scanning', step: 'scan_progress', frame: done, total: storyboards.length, message: `Scanned ${done}/${storyboards.length}…` });
  }

  emit({
    phase: 'consolidating', step: 'consolidate_start', total: proposals.length,
    message: `Consolidating ${proposals.length} proposed plate${proposals.length === 1 ? '' : 's'}…`,
  });
  const images = await consolidatePlateProposals({ proposals, existingPlates });
  emit({ phase: 'derived', step: 'tune_done', total: images.length, message: `${images.length} new plate${images.length === 1 ? '' : 's'} proposed.` });
  return { images };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboardSheetTuner.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardSheetTuner.js tests/storyboardSheetTuner.test.js
git commit -m "✨ Add storyboard image-sheet tuner (scan + consolidate)

Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4"
```

---

## Task 7: Tune scan job + route (Part B backend)

**Files:**
- Modify: `src/web/imageSheetJobs.js` (add static imports + `startTuneScanJob` + `runTuneScanJob`)
- Modify: `src/web/entityRoutes.js` (add `POST /beat/:id/tune-scan` in the beat-only block)
- Test: `tests/imageSheetTuneJob.test.js`

**Interfaces:**
- Consumes: `getBeat` (`src/mongo/plots.js`, already imported in imageSheetJobs.js:29); `listStoryboards` (`src/mongo/storyboards.js`); `tuneStoryboardImageSheet` (`src/web/storyboardSheetTuner.js`, Task 6); existing `jobs` map, `makeJobId`, `recordProgress`, `httpError`, `STORYBOARD_MODEL`, `config` in imageSheetJobs.js.
- Produces: `startTuneScanJob({ projectId, hostId, referenceImageIds })` → `{ job_id }`; the job is pollable via the existing `GET /image-sheet/:jobId`, reaching `status: 'derived'` with `job.shots = [{ name, prompt, justification, quote }]`. Route: `POST /beat/:id/tune-scan`.

- [ ] **Step 1: Write the failing test**

Create `tests/imageSheetTuneJob.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';
import { config } from '../src/config.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Tuner = await import('../src/web/storyboardSheetTuner.js');
const Sheet = await import('../src/web/imageSheetJobs.js');

let projectId;
let beat;
let prevKey;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  beat = await Plots.createBeat({ projectId, name: 'B', body: 'INT. ROOM — DAY' });
  Tuner._setShotPlateScanForTests(null);
  Tuner._setConsolidatePlatesForTests(null);
  prevKey = config.anthropic?.apiKey;
  config.anthropic = { ...(config.anthropic || {}), apiKey: 'test-key' };
});

async function waitForStatus(jobId, statuses, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = Sheet.getImageSheetJob(jobId);
    if (job && statuses.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job did not reach ${statuses.join('/')} in time`);
}

describe('startTuneScanJob', () => {
  it('scans storyboards and parks proposed plates on the job (status derived)', async () => {
    await Storyboards.createStoryboard({ projectId, beatId: beat._id, summary: 'gap shot' });
    Tuner._setShotPlateScanForTests(async () => ({ needs_plate: true, name: 'New plate', prompt: 'empty room' }));

    const { job_id } = await Sheet.startTuneScanJob({ projectId, hostId: beat._id.toString(), referenceImageIds: [] });
    const job = await waitForStatus(job_id, ['derived', 'error']);

    expect(job.status).toBe('derived');
    expect(job.shots).toEqual([{ name: 'New plate', prompt: 'empty room', justification: '', quote: '' }]);
    expect(job.planned).toBe(1);
  });

  it('reaches derived with no shots when the beat has no storyboards', async () => {
    const { job_id } = await Sheet.startTuneScanJob({ projectId, hostId: beat._id.toString(), referenceImageIds: [] });
    const job = await waitForStatus(job_id, ['derived', 'error']);
    expect(job.status).toBe('derived');
    expect(job.shots).toEqual([]);
  });
});
```

> If mutating `config.anthropic` is awkward, the alternative is `vi.mock('../src/config.js', ...)`. Mirror however `imageSheetJobs.test.js` already handles config (it imports `config` directly — check its approach).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/imageSheetTuneJob.test.js`
Expected: FAIL — `Sheet.startTuneScanJob is not a function`.

- [ ] **Step 3: Add the static imports**

In `src/web/imageSheetJobs.js`, add to the imports near the top (after line 37):

```js
import { listStoryboards } from '../mongo/storyboards.js';
import { tuneStoryboardImageSheet } from './storyboardSheetTuner.js';
```

- [ ] **Step 4: Add the job runner + starter**

In `src/web/imageSheetJobs.js`, after `startShotPlanJob` (ends line 370), add:

```js
// Run the storyboard-driven tune scan for a beat and park the proposed new
// plates on the job for review. Renders NOTHING — the SPA polls
// GET /image-sheet/:jobId until status === 'derived', shows job.shots for
// review, then POSTs the reviewed list to /beat/:id/image-sheet (same as the
// derive→review→generate flow). No busyHosts lock: scanning has no side effects.
async function runTuneScanJob({ projectId, job, hostId }) {
  try {
    job.status = 'planning';
    const beat = await getBeat(projectId, hostId);
    if (!beat) throw new Error(`beat not found: ${hostId}`);
    const storyboards = await listStoryboards({ beatId: beat._id });
    if (!storyboards.length) {
      job.shots = [];
      job.planned = 0;
      job.status = 'derived';
      job.finished_at = new Date();
      recordProgress(job, { phase: 'derived', step: 'tune_empty', message: 'No storyboard elements to scan.' });
      return;
    }
    const existingPlates = (beat.artworks || [])
      .filter((a) => a?.status === 'done' && a.result_image_id)
      .map((a) => ({ name: (a.name || '').trim(), prompt: (a.prompt || '').trim() }));
    const { images } = await tuneStoryboardImageSheet({
      storyboards,
      existingPlates,
      onProgress: (e) => recordProgress(job, e),
    });
    job.shots = images;
    job.planned = images.length;
    job.status = 'derived';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'derived',
      step: 'derive_done',
      total: images.length,
      message: `Proposed ${images.length} new plate${images.length === 1 ? '' : 's'} — review and generate.`,
    });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'tune_crashed', message: `Tune failed: ${e.message}` });
    logger.error(`tune-scan job ${job.job_id} crashed: ${e.message}`);
  }
}

// Start a background tune-scan job for a beat. Returns { job_id } immediately
// (HTTP 202). Throws an error carrying `.status` for not-found / config issues.
export async function startTuneScanJob({ projectId, hostId, referenceImageIds = [] }) {
  if (!config.anthropic?.apiKey) {
    throw httpError('ANTHROPIC_API_KEY is not configured (required to tune the image sheet).', 400);
  }
  const beat = await getBeat(projectId, String(hostId));
  if (!beat) throw httpError(`beat not found: ${hostId}`, 404);
  const resolvedHostId = beat._id.toString();

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    host_type: 'beat',
    host_id: resolvedHostId,
    project_id: projectId,
    kind: 'beat_tune',
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planner_model: STORYBOARD_MODEL,
    reference_image_ids: (referenceImageIds || []).map(String),
    planned: 0,
    completed: 0,
    failed: 0,
    progress: null,
    events: [],
    shots: null,
  };
  jobs.set(jobId, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued', message: 'Queued image-sheet tune…' });

  setImmediate(() => {
    runTuneScanJob({ projectId, job, hostId: resolvedHostId }).catch((e) => {
      job.status = 'error';
      job.error = e.message;
      job.finished_at = new Date();
      logger.error(`tune-scan job ${jobId} crashed (outer): ${e.message}`);
    });
  });

  return { job_id: jobId };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/imageSheetTuneJob.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Add the route**

In `src/web/entityRoutes.js`, inside the `if (hostType === 'beat') { ... }` block (after the `shot-plan` route, ~line 2649), add:

```js
      // POST /beat/:id/tune-scan — scan the beat's storyboard against its existing
      // plates and propose new ones. Renders nothing; returns 202 + { job_id }. The
      // SPA polls GET /image-sheet/:jobId until status==='derived', reviews
      // job.shots, then POSTs the reviewed list to /beat/:id/image-sheet.
      router.post(`${basePath}/:id/tune-scan`, async (req, res, next) => {
        try {
          const hostId = await resolveHostId(req);
          if (!hostId) return res.status(404).json({ error: `${hostType} not found` });
          const refs = await validateArtworkRefs(req, res);
          if (!refs) return;
          const { startTuneScanJob } = await import('./imageSheetJobs.js');
          const result = await startTuneScanJob({
            projectId: req.projectId,
            hostId,
            referenceImageIds: refs.ids,
          });
          res.status(202).json(result);
        } catch (e) {
          handleArtworkError(e, res, next);
        }
      });
```

- [ ] **Step 7: Run the full suite + commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/web/imageSheetJobs.js src/web/entityRoutes.js tests/imageSheetTuneJob.test.js
git commit -m "✨ Add tune-scan job + route for storyboard image-sheet tuning

Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4"
```

---

## Task 8: Tune dialog + Artwork-tab button (Part B frontend)

**Files:**
- Create: `web/src/widgets/TuneImageSheetDialog.jsx`
- Modify: `web/src/widgets/ArtworkTab.jsx`

**Interfaces:**
- Consumes: `GET /beat/:id/image-sheet-references` → `{ reference_ids }`; `POST /beat/:id/tune-scan` → `{ job_id }`; `GET /image-sheet/:jobId` → `{ job }` (status `derived`, `job.shots`); `POST /beat/:id/image-sheet` (existing generate path); `GET /storyboards?beat_id=<id>` → `{ storyboards }`; `Modal`, `ArtworkReferencePicker`, `GenerationProgress`, `imageModels.js`, `api.js` helpers.
- Produces: UI only. The Tune dialog calls `onStarted({ jobId, planned })` on generate, reusing ArtworkTab's existing `startSheetJob` (the image-sheet progress panel).

No UI unit-test harness — verify via build + manual.

- [ ] **Step 1: Create the dialog component**

Create `web/src/widgets/TuneImageSheetDialog.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { GenerationProgress } from './GenerationProgress.jsx';
import { apiGet, apiPostJson, imageUrl, thumbUrl } from '../api.js';
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.imagesheet.model';

// "Tune image sheet for storyboard" — a beat-only second pass at the image sheet.
// Flow: prefill the reference set (the one used for the initial sheet, editable)
// → Scan storyboard (a per-shot LLM pass proposes only the plates the storyboard
// still needs) → Review (edit / remove / add) → Generate (reuses the normal
// /beat/:id/image-sheet render path). Proposed plates never duplicate existing ones.
export function TuneImageSheetDialog({
  open,
  onClose,
  onStarted,
  hostId,
  hostLabel,
  hostImages = [],
  hostArtworks = [],
}) {
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // 'setup' → 'scanning' → 'review' | 'empty'.
  const [stage, setStage] = useState('setup');
  const [proposedShots, setProposedShots] = useState([]);
  const [scanJob, setScanJob] = useState(null);
  const [showScanLog, setShowScanLog] = useState(false);
  const openSeqRef = useRef(0);
  const scanPollRef = useRef(null);
  const scanLogRef = useRef(null);
  const keyRef = useRef(0);

  const basePath = `/beat/${hostId}`;

  function stopScanPoll() {
    if (scanPollRef.current) { clearInterval(scanPollRef.current); scanPollRef.current = null; }
  }

  // Reset + prefill on open; bump seq on close so in-flight async bails.
  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      stopScanPoll();
      setPickerOpen(false);
      return;
    }
    setError(null);
    setBusy(false);
    setStage('setup');
    setProposedShots([]);
    setScanJob(null);
    setShowScanLog(false);
    setReferenceIds([]);
    const seq = ++openSeqRef.current;
    (async () => {
      try {
        const r = await apiGet(`${basePath}/image-sheet-references`);
        if (seq !== openSeqRef.current) return;
        setReferenceIds(Array.isArray(r?.reference_ids) ? r.reference_ids.map(String) : []);
      } catch {
        // leave empty — the user can add references manually.
      }
    })();
  }, [open]);

  useEffect(() => () => stopScanPoll(), []);
  useEffect(() => { writeStoredImageModel(MODEL_STORAGE_KEY, imageModel); }, [imageModel]);

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }
  function nextKey() { keyRef.current += 1; return `t${keyRef.current}`; }

  async function pollScan(jobId, seq) {
    if (seq !== openSeqRef.current) { stopScanPoll(); return; }
    try {
      const r = await apiGet(`/image-sheet/${jobId}`);
      const job = r?.job ?? r;
      if (seq !== openSeqRef.current) { stopScanPoll(); return; }
      setScanJob(job);
      if (job?.status === 'derived') {
        stopScanPoll();
        const list = Array.isArray(job.shots) ? job.shots : [];
        setProposedShots(list.map((s) => ({
          key: nextKey(),
          name: s.name || '',
          prompt: s.prompt || '',
          justification: s.justification || '',
          quote: s.quote || '',
        })));
        setStage(list.length ? 'review' : 'empty');
        setBusy(false);
      } else if (job?.status === 'error') {
        stopScanPoll();
        setError(job.error || 'Scan failed.');
        setStage('setup');
        setBusy(false);
      }
    } catch {
      // transient poll error — keep polling.
    }
  }

  async function scan() {
    if (referenceIds.length === 0) {
      setError('Select at least one reference image before scanning.');
      return;
    }
    setBusy(true);
    setError(null);
    setStage('scanning');
    setScanJob({ status: 'queued', started_at: new Date().toISOString(), events: [] });
    setShowScanLog(true);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/tune-scan`, { reference_image_ids: referenceIds });
      if (seq !== openSeqRef.current) return;
      stopScanPoll();
      scanPollRef.current = setInterval(() => pollScan(res.job_id, seq), 2000);
      pollScan(res.job_id, seq);
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start scan');
      setStage('setup');
      setBusy(false);
    }
  }

  function updateShot(key, field, value) {
    setProposedShots((prev) => prev.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  }
  function removeShot(key) {
    setProposedShots((prev) => prev.filter((s) => s.key !== key));
  }
  function addShot() {
    setProposedShots((prev) => [...prev, { key: nextKey(), name: 'New plate', prompt: '', justification: '', quote: '' }]);
  }

  async function generateSheet() {
    const ready = proposedShots
      .map((s) => ({ name: s.name.trim(), prompt: s.prompt.trim() }))
      .filter((s) => s.name && s.prompt);
    if (!ready.length) {
      setError('Add at least one plate with a name and a prompt.');
      return;
    }
    if (referenceIds.length === 0) {
      setError('Select at least one reference image before generating.');
      return;
    }
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/image-sheet`, {
        reference_image_ids: referenceIds,
        model: imageModel,
        shots: ready,
      });
      if (seq !== openSeqRef.current) return;
      onStarted?.({ jobId: res.job_id, planned: res.planned ?? ready.length });
      onClose?.();
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start image sheet');
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  const hasReferences = referenceIds.length > 0;
  const reviewReady = proposedShots.some((s) => s.name.trim() && s.prompt.trim());

  let footer;
  if (stage === 'review') {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="primary"
          onClick={generateSheet}
          disabled={busy || !reviewReady || !hasReferences || !IMAGE_MODEL_IDS.has(imageModel)}
        >
          {busy ? 'Starting…' : `Generate ${proposedShots.length} new plate${proposedShots.length === 1 ? '' : 's'}`}
        </button>
      </>
    );
  } else if (stage === 'empty') {
    footer = <button type="button" className="primary" onClick={onClose}>Close</button>;
  } else {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy && stage !== 'scanning'}>Cancel</button>
        <button type="button" className="primary" onClick={scan} disabled={busy || !hasReferences}>
          {stage === 'scanning' ? 'Scanning…' : 'Scan storyboard'}
        </button>
      </>
    );
  }

  const modalSize = stage === 'review' ? 'xl' : 'wide';

  return (
    <>
      <Modal
        open={open}
        title="Tune image sheet for storyboard"
        onClose={onClose}
        dismissible={!busy}
        size={modalSize}
        footer={footer}
      >
        <div className="frame-generate-modal">
          <p className="tab-intro" style={{ marginTop: 0 }}>
            Scan this beat's storyboard against the existing plates and add only the new plates the
            shots still need. Existing plates are kept; nothing is duplicated.
          </p>

          {stage !== 'scanning' && (
            <div className="frame-generate-refs">
              <div className="frame-generate-section-header">
                <span className="field-label">Reference images</span>
                <button type="button" className="primary" onClick={() => setPickerOpen(true)} disabled={busy}>
                  + Add references
                </button>
              </div>
              <div className="frame-generate-ref-grid">
                {referenceIds.length === 0 ? (
                  <div className="frame-generate-ref-empty">
                    These are the references used for the initial image sheet — add or remove some,
                    then scan. Use <strong>+ Add references</strong> to choose more.
                  </div>
                ) : (
                  referenceIds.map((id) => (
                    <div className="frame-generate-ref-thumb" key={id}>
                      <img
                        src={thumbUrl(id)}
                        alt="reference"
                        loading="lazy"
                        onClick={() => window.open(imageUrl(id), '_blank', 'noopener')}
                      />
                      <button
                        type="button"
                        className="storyboard-frame-remove"
                        title="Remove reference"
                        onClick={() => removeReference(id)}
                        disabled={busy}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {stage === 'setup' && (
            <div className="image-sheet-derive-setup">
              <span className="frame-generate-help">
                Click <strong>Scan storyboard</strong> to review every shot against the current plates.
                You'll review and edit the proposed new plates before any images are generated.
              </span>
            </div>
          )}

          {stage === 'scanning' && scanJob && (
            <div className="image-sheet-progress">
              <GenerationProgress
                job={scanJob}
                noun="shot"
                showLog={showScanLog}
                onToggleLog={() => setShowScanLog((s) => !s)}
                logRef={scanLogRef}
              />
            </div>
          )}

          {stage === 'empty' && (
            <div className="frame-generate-ref-empty">
              No new plates needed — the existing image sheet already covers every storyboard shot.
            </div>
          )}

          {stage === 'review' && (
            <div className="image-sheet-review">
              <div className="frame-generate-section-header">
                <span className="field-label">New plates to generate ({proposedShots.length})</span>
                <button type="button" onClick={addShot} disabled={busy}>+ Add plate</button>
              </div>
              <div className="image-sheet-plate-list">
                {proposedShots.map((s, i) => (
                  <div className="image-sheet-plate-card" key={s.key}>
                    <div className="image-sheet-plate-head">
                      <span className="image-sheet-plate-num">{i + 1}</span>
                      <input
                        className="image-sheet-plate-name"
                        type="text"
                        value={s.name}
                        placeholder="Plate name"
                        onChange={(e) => updateShot(s.key, 'name', e.target.value)}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="storyboard-frame-remove"
                        title="Remove plate"
                        onClick={() => removeShot(s.key)}
                        disabled={busy}
                      >
                        ×
                      </button>
                    </div>
                    <textarea
                      className="image-sheet-plate-prompt"
                      rows={3}
                      value={s.prompt}
                      placeholder="Image prompt (purely visual — no characters or caption text)"
                      onChange={(e) => updateShot(s.key, 'prompt', e.target.value)}
                      disabled={busy}
                    />
                    {s.justification && <div className="image-sheet-plate-just">{s.justification}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(stage === 'setup' || stage === 'review') && (
            <div className="frame-generate-model-row">
              <span className="field-label">Image model</span>
              <div className="frame-generate-model-options">
                {IMAGE_MODELS.map((m) => (
                  <label key={m.id}>
                    <input
                      type="radio"
                      name="tune-image-model"
                      value={m.id}
                      checked={imageModel === m.id}
                      onChange={() => setImageModel(m.id)}
                      disabled={busy}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}
        </div>
      </Modal>
      <ArtworkReferencePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onApply={(ids) => setReferenceIds(ids)}
        hostType="beat"
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
        selectedIds={referenceIds}
      />
    </>
  );
}
```

- [ ] **Step 2: Wire the button into ArtworkTab**

In `web/src/widgets/ArtworkTab.jsx`:

(a) Add the import after line 5:
```js
import { TuneImageSheetDialog } from './TuneImageSheetDialog.jsx';
```

(b) Add state after `sheetLogRef` (line 58):
```js
  const [tuneOpen, setTuneOpen] = useState(false);
  const [sbCount, setSbCount] = useState(0);
```

(c) Add a storyboard-count fetch effect after the unmount cleanup effect (line 104):
```js
  // Beats only: load the storyboard count so the Tune button can disable when
  // there are no storyboard elements to scan.
  useEffect(() => {
    if (hostType !== 'beat' || !hostId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/storyboards?beat_id=${encodeURIComponent(hostId)}`);
        if (!cancelled) setSbCount(Array.isArray(r?.storyboards) ? r.storyboards.length : 0);
      } catch {
        // leave at 0 → button stays disabled
      }
    })();
    return () => { cancelled = true; };
  }, [hostType, hostId]);
```

(d) Add the button after the "Create image sheet" button (line 245), inside the same `.tab-actions` div:
```jsx
        {hostType === 'beat' && (
          <button
            type="button"
            onClick={() => setTuneOpen(true)}
            disabled={sheetActive || sbCount === 0}
            title={
              sbCount === 0
                ? 'Generate a storyboard for this beat first'
                : 'Scan the storyboard and add only the plates it still needs'
            }
          >
            Tune image sheet for storyboard
          </button>
        )}
```

(e) Render the dialog after the `<ImageSheetDialog ... />` block (line 456):
```jsx
      {hostType === 'beat' && (
        <TuneImageSheetDialog
          open={tuneOpen}
          onClose={() => setTuneOpen(false)}
          onStarted={startSheetJob}
          hostId={hostId}
          hostLabel={hostLabel}
          hostImages={hostImages}
          hostArtworks={hostArtworks}
        />
      )}
```

- [ ] **Step 3: Build**

Run: `npm run build:web`
Expected: build succeeds.

- [ ] **Step 4: Manual verify**

Run `npm run dev` + `npm run dev:web`. On a beat with a generated storyboard and an existing image sheet:
1. Open the beat's Artwork tab → "Tune image sheet for storyboard" is present and enabled (disabled on a beat with no storyboards).
2. Click it → dialog opens prefilled with the initial sheet's reference images.
3. Add/remove a reference, click "Scan storyboard" → progress panel runs; on completion either the review list of proposed new plates appears, or the "no new plates needed" empty state.
4. Edit/remove a proposed plate, click Generate → the dialog closes and the Artwork tab's image-sheet progress panel fills in the new plates as artworks; existing plates are untouched.
5. Reopen Tune → the reference set reflects the edits made (persisted via `/beat/:id/image-sheet`).

- [ ] **Step 5: Commit**

```bash
git add web/src/widgets/TuneImageSheetDialog.jsx web/src/widgets/ArtworkTab.jsx
git commit -m "✨ Add 'Tune image sheet for storyboard' dialog + button

Claude-Session: https://claude.ai/code/session_018ocNDPZtUNQLMzKVWh6nn4"
```

---

## Final verification

- [ ] Run the full backend suite: `npm test` → all pass.
- [ ] Build the SPA: `npm run build:web` → succeeds.
- [ ] Manual smoke of both features per Tasks 2 and 8.

---

## Self-Review notes (author)

- **Spec coverage:**
  - "Assign reference images" button, disabled when no storyboard elements, confirm before wipe, background job, same auto-suggest pipeline, replace (wipe) including generated frames → Tasks 1–2.
  - Persist + prefill the image-sheet reference set on the beat (with artwork-union fallback) → Tasks 3–4.
  - "Tune image sheet for storyboard" button next to "Create image sheet", beat-only, disabled when no storyboards → Task 8.
  - Reference dialog prefilled, editable, re-saved → Tasks 4 + 8.
  - Per-shot scan vs text catalog of existing plates + image critique, propose new static plates, consolidate/no-duplicates, reuse static-plate rules → Tasks 5–7.
  - Review stage before generate; generate as beat artworks via existing path → Tasks 7–8.
- **Two approved judgment calls** (scanner uses a text catalog, not plate images; plates reuse the static-plate rules via `STATIC_PLATE_CONSTRAINTS`) are realized in Tasks 5–6.
- **Type consistency:** job `shots` entries are `{ name, prompt, justification, quote }` across the tuner (Task 6), the tune job (Task 7), and the dialog/generate path (Task 8), matching what `POST /beat/:id/image-sheet` already accepts (`normalizeExplicitShots` keeps only `{ name, prompt }`).
- **Assumptions to confirm during implementation** (flagged inline): exact `setArtworkResultViaGateway` param names (gateway.js:955); `beatLocks.js` export names; `imageSheetRoutes.test.js` mount prefix + harness; how `imageSheetJobs.test.js` handles `config.anthropic`.
