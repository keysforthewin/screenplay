# Storyboard "Generate all images" / "Delete all images" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two top-toolbar buttons to the per-beat storyboard page — "Generate all images" (renders each shot's missing start frame via a model picked in a popup) and "Delete all images" (clears every generated frame image in the beat).

**Architecture:** Reuse the existing per-frame render core (`regenerateStoryboardFrameInternal`), the in-memory async-job + `recordProgress` machinery, the mutation gateway (which broadcasts live SPA updates), and the existing `StoryboardGenerationProgress` panel. One new async "bulk" job iterates each shot's start frame (`frames[0]`) sequentially inside a single beat lock; deletion is a synchronous gateway helper.

**Tech Stack:** Node + Express (`src/web/`), MongoDB (`src/mongo/`, GridFS), React/Vite SPA (`web/src/`), Vitest with in-memory fake Mongo (`tests/_fakeMongo.js`).

**Spec:** `docs/superpowers/specs/2026-06-09-storyboard-generate-all-images-design.md`

**Deviation from spec:** v1 omits the Discord batch-summary announcement. `announceBatchSummary({req, message})` needs the live `req`, which a detached background job doesn't have; per-frame announcements would be spammy. The SPA progress panel is the feedback channel. (Easy to add later by capturing the username at submit and calling `announceText` directly.)

---

## File Structure

**Backend**
- `src/mongo/storyboards.js` — add `clearAllFrameImagesForBeat(beatId)` (pure Mongo: null out every frame's `image_id`/`previous_image_id`/`last_edit_prompt`, return freed + referenced ids).
- `src/web/gateway.js` — add `clearAllFrameImagesForBeatViaGateway({beatId})` (calls the Mongo fn, deletes freed blobs except protected ids, broadcasts one room ping).
- `src/web/storyboardGenerate.js` — add `imageJobs` map, `getImageGenerationJob`, `listMissingStartFrameTargets(beatId)`, `startBulkFrameGenerationJob`, `runBulkFrameGenerationJob`. Reuses in-module `regenerateStoryboardFrameInternal`, `buildSuggestedFramePrompt`, `recordProgress`, `makeJobId`, `withBeatLock`, `isBeatLocked`, `BeatBusyError`.
- `src/web/entityRoutes.js` — add 3 routes: `POST /storyboards/generate-images`, `GET /storyboards/generate-images/:jobId`, `POST /storyboards/clear-images`.

**Frontend**
- `web/src/widgets/BulkGenerateImagesDialog.jsx` — new model-picker modal (radio list + pre-flight count summary).
- `web/src/routes/StoryboardBeat.jsx` — two new toolbar buttons + bulk-generate state/poll + delete-images confirm + dialog mount.

**Tests**
- `tests/storyboard-clear-images.test.js` — Mongo + gateway clear (mirrors `storyboard-clear.test.js`).
- `tests/storyboard-bulk-images.test.js` — target selection + bulk job accounting (mirrors `storyboard-frame-regen.test.js`).
- `tests/storyboard-bulk-images-routes.test.js` — the 3 routes (mirrors `storyboard-grab-frame.test.js`'s express harness).

---

## Task 1: Mongo — `clearAllFrameImagesForBeat`

**Files:**
- Create: `tests/storyboard-clear-images.test.js`
- Modify: `src/mongo/storyboards.js` (add export near `deleteStoryboardsForBeat`, ~line 629)

- [ ] **Step 1: Write the failing test**

Create `tests/storyboard-clear-images.test.js`:

```js
// Tests for clearing every frame image in a beat (the "Delete all images" core).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');

beforeEach(() => fakeDb.reset());

function frameOf(sb, frameId) {
  return sb.frames.find((f) => f._id.toString() === String(frameId));
}

describe('clearAllFrameImagesForBeat', () => {
  it('nulls image_id + previous_image_id + last_edit_prompt on every frame, keeps prompt + references', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: '', body: '', characters: [] });
    const original = new ObjectId();
    const edited = new ObjectId();
    const ref = new ObjectId();
    const sb = await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'one' });
    const { frameId } = await Storyboards.addFrame(sb._id, { imageId: original, referenceIds: [ref] });
    await Storyboards.setFramePrompt(sb._id, frameId, 'keep me');
    // Rotate: image_id = edited (current), previous_image_id = original, last_edit_prompt = 'tweak'.
    await Storyboards.rotateFrameImageEdit({ id: sb._id, frameId, newImageId: edited, editPrompt: 'tweak' });

    const result = await Storyboards.clearAllFrameImagesForBeat(beat._id);

    const fresh = await Storyboards.getStoryboard(sb._id);
    const f = frameOf(fresh, frameId);
    expect(f.image_id).toBe(null);
    expect(f.previous_image_id).toBe(null);
    expect(f.last_edit_prompt).toBe('');
    expect(f.prompt).toBe('keep me');
    expect(f.reference_ids.map(String)).toEqual([ref.toString()]);
    expect(result.referencedIds.map(String)).toContain(ref.toString());
    expect(result.freedImageIds.map(String)).toEqual(
      expect.arrayContaining([original.toString(), edited.toString()]),
    );
    expect(result.storyboardIds.map(String)).toEqual([sb._id.toString()]);
  });

  it('only touches the target beat', async () => {
    const beatA = await Plots.createBeat({ name: 'A', desc: '', body: '', characters: [] });
    const beatB = await Plots.createBeat({ name: 'B', desc: '', body: '', characters: [] });
    const imgA = new ObjectId();
    const sbA = await Storyboards.createStoryboard({ beatId: beatA._id, textPrompt: 'a' });
    await Storyboards.addFrame(sbA._id, { imageId: imgA });
    const sbB = await Storyboards.createStoryboard({ beatId: beatB._id, textPrompt: 'b' });
    await Storyboards.addFrame(sbB._id, { imageId: new ObjectId() });

    await Storyboards.clearAllFrameImagesForBeat(beatB._id);

    const freshA = await Storyboards.getStoryboard(sbA._id);
    expect(freshA.frames[0].image_id.toString()).toBe(imgA.toString());
    const freshB = await Storyboards.getStoryboard(sbB._id);
    expect(freshB.frames[0].image_id).toBe(null);
  });

  it('is a no-op (empty results) when the beat has no storyboards', async () => {
    const beat = await Plots.createBeat({ name: 'E', desc: '', body: '', characters: [] });
    const result = await Storyboards.clearAllFrameImagesForBeat(beat._id);
    expect(result).toEqual({ freedImageIds: [], referencedIds: [], storyboardIds: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/storyboard-clear-images.test.js`
Expected: FAIL — `Storyboards.clearAllFrameImagesForBeat is not a function`.

- [ ] **Step 3: Implement `clearAllFrameImagesForBeat`**

In `src/mongo/storyboards.js`, add immediately after `deleteStoryboardsForBeat` (~line 629):

```js
// Clear every generated frame image in a beat's storyboards (the "Delete all
// images" core). Nulls image_id, previous_image_id and last_edit_prompt on every
// frame of every shot; KEEPS each frame's prompt and reference_ids. Returns the
// freed image ids (current + undo, for GridFS cleanup), all referenced ids (so
// the caller can avoid deleting a blob still used as a reference), and the
// touched storyboard ids.
export async function clearAllFrameImagesForBeat(beatId) {
  const sbs = await listStoryboards({ beatId });
  const freedImageIds = [];
  const referencedIds = [];
  const storyboardIds = [];
  for (const sb of sbs) {
    storyboardIds.push(sb._id);
    let touched = false;
    const frames = sb.frames.map((f) => {
      if (f.image_id) { freedImageIds.push(f.image_id); touched = true; }
      if (f.previous_image_id) { freedImageIds.push(f.previous_image_id); touched = true; }
      if (f.last_edit_prompt) touched = true;
      for (const r of f.reference_ids || []) if (r) referencedIds.push(r);
      return {
        ...f,
        image_id: null,
        previous_image_id: null,
        last_edit_prompt: '',
        reference_ids: [...(f.reference_ids || [])],
      };
    });
    if (touched) {
      await col().updateOne({ _id: sb._id }, { $set: { frames, updated_at: new Date() } });
    }
  }
  return { freedImageIds, referencedIds, storyboardIds };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/storyboard-clear-images.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/storyboard-clear-images.test.js src/mongo/storyboards.js
git commit -m "feat(storyboards): clearAllFrameImagesForBeat mongo helper"
```

---

## Task 2: Gateway — `clearAllFrameImagesForBeatViaGateway`

**Files:**
- Modify: `tests/storyboard-clear-images.test.js` (add a `describe` block; mock `images.js`)
- Modify: `src/web/gateway.js` (import the mongo fn in the existing storyboards import block ~line 94-102; add the export after `deleteAllStoryboardsForBeatViaGateway` ~line 1491)

> Note: this task's test mocks `../src/mongo/images.js` to capture `deleteImage` calls. Because the existing Task 1 tests in this file do NOT mock `images.js`, add the mock at the top of the file (mocks are hoisted and file-wide) — it does not affect Task 1's tests, which never touch images.

- [ ] **Step 1: Write the failing test**

At the top of `tests/storyboard-clear-images.test.js`, add this mock alongside the others (after the `log.js` mock):

```js
const deletedImageIds = [];
vi.mock('../src/mongo/images.js', () => ({
  deleteImage: vi.fn(async (id) => { deletedImageIds.push(String(id)); }),
  deleteImages: vi.fn(async (ids) => { for (const i of ids) deletedImageIds.push(String(i)); }),
  uploadGeneratedImage: vi.fn(async () => ({ _id: new ObjectId() })),
}));
```

Add `const Gateway = await import('../src/web/gateway.js');` to the import section, and `deletedImageIds.length = 0;` inside the existing `beforeEach`.

Append this `describe` block to the file:

```js
describe('clearAllFrameImagesForBeatViaGateway', () => {
  it('deletes freed blobs, skips referenced ids, and returns counts', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: '', body: '', characters: [] });
    const current = new ObjectId();
    const ref = new ObjectId();
    const sb = await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'one' });
    await Storyboards.addFrame(sb._id, { imageId: current, referenceIds: [ref] });
    // A second shot whose current image IS also used as a reference elsewhere:
    const shared = new ObjectId();
    const sb2 = await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'two' });
    await Storyboards.addFrame(sb2._id, { imageId: shared, referenceIds: [shared] });

    const result = await Gateway.clearAllFrameImagesForBeatViaGateway({ beatId: beat._id });

    expect(result.cleared).toBe(2);
    // `current` is freed and not referenced → deleted. `shared` is referenced → kept.
    expect(deletedImageIds).toContain(current.toString());
    expect(deletedImageIds).not.toContain(shared.toString());
    expect(result.freed).toBe(deletedImageIds.length);

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.frames[0].image_id).toBe(null);
    expect(fresh.frames[0].reference_ids.map(String)).toEqual([ref.toString()]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/storyboard-clear-images.test.js`
Expected: FAIL — `Gateway.clearAllFrameImagesForBeatViaGateway is not a function`.

- [ ] **Step 3: Implement the gateway helper**

In `src/web/gateway.js`, add `clearAllFrameImagesForBeat` to the existing import from `'../mongo/storyboards.js'` (the block ending ~line 102), aliased:

```js
  clearAllFrameImagesForBeat as mongoClearAllFrameImagesForBeat,
```

Add this export right after `deleteAllStoryboardsForBeatViaGateway` (~line 1491):

```js
// "Delete all images" for a beat: clear every frame's generated image (current +
// undo), free the underlying GridFS blobs, and ping the room so SPAs re-render.
// Never deletes a blob still used as a frame reference or as the beat's hero
// image (the codebase "may be shared" guard). Keeps prompts and references.
export async function clearAllFrameImagesForBeatViaGateway({ beatId }) {
  const { freedImageIds, referencedIds, storyboardIds } =
    await mongoClearAllFrameImagesForBeat(beatId);
  const beat = await getBeat(beatId);
  const protectedIds = new Set([
    ...referencedIds.map(String),
    ...(beat?.main_image_id ? [String(beat.main_image_id)] : []),
  ]);
  const toDelete = [...new Set(freedImageIds.map(String))].filter(
    (id) => !protectedIds.has(id),
  );
  for (const id of toDelete) {
    await tryDeleteImage(id, 'cleared all storyboard frame images');
  }
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['frames'],
    cleared_images: true,
  });
  return { cleared: storyboardIds.length, freed: toDelete.length };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/storyboard-clear-images.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/storyboard-clear-images.test.js src/web/gateway.js
git commit -m "feat(gateway): clearAllFrameImagesForBeatViaGateway"
```

---

## Task 3: Backend — bulk start-frame generation job

**Files:**
- Create: `tests/storyboard-bulk-images.test.js`
- Modify: `src/web/storyboardGenerate.js` (add after `getStoryboardGenerationJob` ~line 292; reuse `regenerateStoryboardFrameInternal`, `buildSuggestedFramePrompt`, `recordProgress`, `makeJobId`, `withBeatLock`, `isBeatLocked`, `BeatBusyError`)

- [ ] **Step 1: Write the failing test**

Create `tests/storyboard-bulk-images.test.js`:

```js
// Bulk "Generate all images": targets each shot's start frame (frames[0]) that
// has no image, uses the stored prompt or the suggested fallback, and accounts
// for successes/failures without aborting on a single bad frame.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  uploadGeneratedImage: vi.fn(async ({ filename }) => ({
    _id: new ObjectId(), filename, contentType: 'image/png', metadata: {},
  })),
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');

beforeEach(() => {
  fakeDb.reset();
  Generate._setImageDispatcherForTests(null);
});

async function waitForJob(jobId) {
  for (let i = 0; i < 400; i++) {
    const job = Generate.getImageGenerationJob(jobId);
    if (job && ['done', 'partial', 'error'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  return Generate.getImageGenerationJob(jobId);
}

// Create a beat with N shots; each gets a start frame unless skipFrame is set.
async function makeBeat({ shots }) {
  const beat = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'b', characters: [] });
  const out = [];
  for (const s of shots) {
    const sb = await Storyboards.createStoryboard({
      beatId: beat._id, textPrompt: s.text || 'a shot', shotType: 'cinematic_wide',
    });
    let frameId = null;
    if (!s.skipFrame) {
      const r = await Storyboards.addFrame(sb._id, { imageId: s.imageId || null });
      frameId = r.frameId;
      if (s.prompt) await Storyboards.setFramePrompt(sb._id, frameId, s.prompt);
    }
    out.push({ sbId: sb._id, frameId });
  }
  return { beat, out };
}

describe('listMissingStartFrameTargets', () => {
  it('returns only shots whose start frame (frames[0]) has no image; skips empty pools and rendered starts', async () => {
    const { beat } = await makeBeat({ shots: [
      { prompt: 'p1' },                         // missing → target
      { imageId: new ObjectId() },              // already rendered → skip
      { skipFrame: true },                      // no start frame → skip
    ] });
    const targets = await Generate.listMissingStartFrameTargets(beat._id);
    expect(targets).toHaveLength(1);
    expect(targets[0].frame.prompt).toBe('p1');
  });
});

describe('startBulkFrameGenerationJob', () => {
  it('generates only the missing start frames and reports planned/completed', async () => {
    const { beat, out } = await makeBeat({ shots: [
      { prompt: 'first shot' },
      { imageId: new ObjectId() },              // skipped
      { prompt: 'third shot' },
    ] });
    const seen = [];
    Generate._setImageDispatcherForTests(async (args) => {
      seen.push(args.prompt);
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    const { jobId, planned } = await Generate.startBulkFrameGenerationJob({
      beatId: beat._id, imageModel: 'gemini',
    });
    expect(planned).toBe(2);
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(2);
    expect(job.failed).toBe(0);
    expect(seen.sort()).toEqual(['first shot', 'third shot']);

    // The two targeted start frames now have images; the rendered one is untouched.
    const sb0 = await Storyboards.getStoryboard(out[0].sbId);
    expect(sb0.frames[0].image_id).toBeTruthy();
  });

  it('falls back to the suggested prompt when a start frame has no stored prompt', async () => {
    const { beat } = await makeBeat({ shots: [{ /* no prompt */ }] });
    let captured = null;
    Generate._setImageDispatcherForTests(async (args) => {
      captured = args.prompt;
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });
    const { jobId } = await Generate.startBulkFrameGenerationJob({ beatId: beat._id });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(typeof captured).toBe('string');
    expect(captured.trim().length).toBeGreaterThan(0);
    expect(captured).toMatch(/cinematic_wide|wide/i);
  });

  it('continues past a failing frame and finishes as partial', async () => {
    const { beat } = await makeBeat({ shots: [{ prompt: 'good' }, { prompt: 'bad' }] });
    Generate._setImageDispatcherForTests(async (args) => {
      if (args.prompt === 'bad') throw new Error('model boom');
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });
    const { jobId } = await Generate.startBulkFrameGenerationJob({ beatId: beat._id });
    const job = await waitForJob(jobId);
    expect(job.status).toBe('partial');
    expect(job.completed).toBe(1);
    expect(job.failed).toBe(1);
  });

  it('finishes immediately as done with planned=0 when nothing is missing', async () => {
    const { beat } = await makeBeat({ shots: [{ imageId: new ObjectId() }] });
    const { jobId, planned } = await Generate.startBulkFrameGenerationJob({ beatId: beat._id });
    expect(planned).toBe(0);
    const job = await waitForJob(jobId);
    expect(job.status).toBe('done');
    expect(job.completed).toBe(0);
  });

  it('throws BeatBusyError when the beat lock is already held', async () => {
    const { beat } = await makeBeat({ shots: [{ prompt: 'p' }] });
    const { withBeatLock } = await import('../src/web/beatLocks.js');
    let release;
    const held = new Promise((r) => { release = r; });
    withBeatLock(beat._id, () => held); // hold the lock
    await expect(
      Generate.startBulkFrameGenerationJob({ beatId: beat._id }),
    ).rejects.toThrow(/in progress/i);
    release();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/storyboard-bulk-images.test.js`
Expected: FAIL — `Generate.listMissingStartFrameTargets is not a function` / `startBulkFrameGenerationJob is not a function`.

- [ ] **Step 3: Implement the bulk job**

In `src/web/storyboardGenerate.js`, add right after `getStoryboardGenerationJob` (~line 292):

```js
// ── Bulk start-frame image generation ("Generate all images") ───────────────
// Separate in-memory job table from the plan-generation `jobs` Map: same shape
// (so the SPA's StoryboardGenerationProgress renders it unchanged) but a
// distinct polling endpoint and lifecycle. Mirrors the critiqueJobs convention.
const imageJobs = new Map();

export function getImageGenerationJob(jobId) {
  return imageJobs.get(jobId) || null;
}

// Each shot's START frame is frames[0]. Returns [{ sb, frame }] for every shot in
// the beat whose start frame exists and has no image yet. Shots with an empty
// frame pool (no start frame) and shots whose start frame already has an image
// are skipped.
export async function listMissingStartFrameTargets(beatId) {
  const sbs = await listStoryboards({ beatId });
  const targets = [];
  for (const sb of sbs) {
    const frame = sb.frames?.[0];
    if (!frame) continue;
    if (frame.image_id) continue;
    targets.push({ sb, frame });
  }
  return targets;
}

// SPA entry point for the page-level "Generate all images" button. Returns
// { jobId, planned } immediately; the SPA polls
// /storyboards/generate-images/:jobId. The runner holds the per-beat lock for
// its whole duration so it can't race the plan-generation job or per-frame edits.
export async function startBulkFrameGenerationJob({
  beatId,
  imageModel = 'nano-banana-pro',
}) {
  const beat = await getBeat(beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  const targets = await listMissingStartFrameTargets(beat._id);
  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    beat_id: beat._id.toString(),
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planned: targets.length,
    completed: 0,
    failed: 0,
    image_model: imageModel,
    progress: null,
    events: [],
  };
  imageJobs.set(jobId, job);
  recordProgress(job, {
    phase: 'queued',
    step: 'job_queued',
    message: `Queued — ${targets.length} missing start frame${targets.length === 1 ? '' : 's'}`,
  });

  withBeatLock(beat._id, () =>
    runBulkFrameGenerationJob({ job, beat, targets, imageModel }),
  ).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'error',
      step: 'job_crashed',
      message: `Bulk generate crashed: ${e.message}`,
    });
    logger.error(`bulk image gen job ${jobId} crashed: ${e.message}`);
  });

  return { jobId, planned: targets.length };
}

async function runBulkFrameGenerationJob({ job, beat, targets, imageModel }) {
  if (targets.length === 0) {
    job.status = 'done';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'done',
      step: 'job_done_empty',
      message: 'No missing start frames — nothing to generate.',
    });
    return;
  }
  job.status = 'rendering';
  recordProgress(job, {
    phase: 'rendering',
    step: 'render_start',
    total: targets.length,
    message: `Rendering ${targets.length} start frame${targets.length === 1 ? '' : 's'}…`,
  });
  for (let index = 0; index < targets.length; index++) {
    const { sb, frame } = targets[index];
    const order = index + 1;
    const prompt = (frame.prompt || '').trim() || buildSuggestedFramePrompt({ sb });
    recordProgress(job, {
      phase: 'rendering',
      step: 'frame_start',
      frame: order,
      total: targets.length,
      message: `Frame ${order}/${targets.length}: rendering…`,
    });
    try {
      await regenerateStoryboardFrameInternal({
        sb,
        beat,
        frame,
        imageModel,
        mode: 'generate',
        prompt,
      });
      job.completed += 1;
      recordProgress(job, {
        phase: 'rendering',
        step: 'frame_done',
        frame: order,
        total: targets.length,
        message: `Frame ${order}/${targets.length}: done`,
      });
    } catch (e) {
      job.failed += 1;
      recordProgress(job, {
        phase: 'rendering',
        step: 'frame_failed',
        frame: order,
        total: targets.length,
        message: `Frame ${order}/${targets.length}: failed — ${e.message}`,
      });
      logger.warn(`bulk image gen ${job.job_id} frame ${order} failed: ${e.message}`);
    }
  }
  job.status = job.failed > 0 ? 'partial' : 'done';
  job.finished_at = new Date();
  recordProgress(job, {
    phase: job.status,
    step: 'job_done',
    message: `Done — ${job.completed} generated${job.failed ? `, ${job.failed} failed` : ''}.`,
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/storyboard-bulk-images.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/storyboard-bulk-images.test.js src/web/storyboardGenerate.js
git commit -m "feat(storyboards): bulk start-frame image generation job"
```

---

## Task 4: Backend — routes

**Files:**
- Create: `tests/storyboard-bulk-images-routes.test.js`
- Modify: `src/web/entityRoutes.js` (add the 3 routes next to the existing `/storyboards/clear` route ~line 4516)

- [ ] **Step 1: Write the failing test**

Create `tests/storyboard-bulk-images-routes.test.js`:

```js
// HTTP routes for bulk start-frame generation + clear-all-images.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  deleteImage: vi.fn(async () => {}),
  deleteImages: vi.fn(async () => {}),
  uploadGeneratedImage: vi.fn(async ({ filename }) => ({
    _id: new ObjectId(), filename, contentType: 'image/png', metadata: {},
  })),
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(() => r())); });

beforeEach(() => {
  fakeDb.reset();
  Generate._setImageDispatcherForTests(async () => ({
    buffer: Buffer.from('img'), contentType: 'image/png',
  }));
});
afterEach(() => Generate._setImageDispatcherForTests(null));

const post = (path, body) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get = (path) => fetch(`${baseUrl}/api${path}`);

async function beatWithMissingStart() {
  const beat = await Plots.createBeat({ name: 'B', desc: '', body: '', characters: [] });
  const sb = await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'shot', shotType: 'cinematic_wide' });
  await Storyboards.addFrame(sb._id, {});
  return beat;
}

describe('POST /storyboards/generate-images', () => {
  it('400 when beat_id is missing', async () => {
    const r = await post('/storyboards/generate-images', {});
    expect(r.status).toBe(400);
  });
  it('404 for unknown beat', async () => {
    const r = await post('/storyboards/generate-images', { beat_id: new ObjectId().toString() });
    expect(r.status).toBe(404);
  });
  it('400 for an invalid image_model', async () => {
    const beat = await beatWithMissingStart();
    const r = await post('/storyboards/generate-images', { beat_id: beat._id.toString(), image_model: 'not-a-model' });
    expect(r.status).toBe(400);
  });
  it('202 with job_id + planned on success', async () => {
    const beat = await beatWithMissingStart();
    const r = await post('/storyboards/generate-images', { beat_id: beat._id.toString(), image_model: 'gemini-25-flash' });
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body.job_id).toBeTruthy();
    expect(body.planned).toBe(1);
  });
});

describe('GET /storyboards/generate-images/:jobId', () => {
  it('404 for an unknown job', async () => {
    const r = await get(`/storyboards/generate-images/${new ObjectId().toString()}`);
    expect(r.status).toBe(404);
  });
  it('returns the job for a real id', async () => {
    const beat = await beatWithMissingStart();
    const sub = await (await post('/storyboards/generate-images', { beat_id: beat._id.toString() })).json();
    const r = await get(`/storyboards/generate-images/${sub.job_id}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.job.job_id).toBe(sub.job_id);
  });
});

describe('POST /storyboards/clear-images', () => {
  it('400 when beat_id is missing', async () => {
    const r = await post('/storyboards/clear-images', {});
    expect(r.status).toBe(400);
  });
  it('clears images and returns counts', async () => {
    const beat = await Plots.createBeat({ name: 'B', desc: '', body: '', characters: [] });
    const sb = await Storyboards.createStoryboard({ beatId: beat._id, textPrompt: 'shot' });
    await Storyboards.addFrame(sb._id, { imageId: new ObjectId() });
    const r = await post('/storyboards/clear-images', { beat_id: beat._id.toString() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cleared).toBe(1);
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.frames[0].image_id).toBe(null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/storyboard-bulk-images-routes.test.js`
Expected: FAIL — routes return 404 (not registered) for the success cases.

- [ ] **Step 3: Implement the routes**

In `src/web/entityRoutes.js`, immediately after the `/storyboards/clear` route (ends ~line 4516), add:

```js
  // Page-level "Generate all images": render every shot's missing start frame.
  // Async — returns 202 + { job_id, planned }; SPA polls
  // /storyboards/generate-images/:jobId.
  router.post('/storyboards/generate-images', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const imageModel = normalizeImageModel(req.body?.image_model);
      if (!isValidImageModel(imageModel)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const { isBeatLocked } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res
          .status(409)
          .json({ error: 'Storyboard work in progress for this beat; try again' });
      }
      const { startBulkFrameGenerationJob } = await import('./storyboardGenerate.js');
      const { jobId, planned } = await startBulkFrameGenerationJob({
        beatId: beat._id,
        imageModel,
      });
      res.status(202).json({ job_id: jobId, planned, beat_id: beat._id.toString() });
    } catch (e) {
      next(e);
    }
  });

  router.get('/storyboards/generate-images/:jobId', async (req, res, next) => {
    try {
      const { getImageGenerationJob } = await import('./storyboardGenerate.js');
      const job = getImageGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });

  // Page-level "Delete all images": clear every generated frame image in the beat.
  // Synchronous; keeps prompts + references.
  router.post('/storyboards/clear-images', async (req, res, next) => {
    try {
      const beatRef = req.body?.beat_id;
      if (!beatRef) return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) {
        return res
          .status(409)
          .json({ error: 'Storyboard work in progress for this beat; try again' });
      }
      const { clearAllFrameImagesForBeatViaGateway } = await import('./gateway.js');
      const result = await clearAllFrameImagesForBeatViaGateway({ beatId: beat._id });
      res.json({ ...result, beat_id: beat._id.toString() });
    } catch (e) {
      next(e);
    }
  });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/storyboard-bulk-images-routes.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/storyboard-bulk-images-routes.test.js src/web/entityRoutes.js
git commit -m "feat(routes): generate-images, generate-images/:jobId, clear-images"
```

---

## Task 5: Frontend — `BulkGenerateImagesDialog`

**Files:**
- Create: `web/src/widgets/BulkGenerateImagesDialog.jsx`

No component-test harness exists (no @testing-library/react). Verify by building the SPA.

- [ ] **Step 1: Create the component**

Create `web/src/widgets/BulkGenerateImagesDialog.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';
import {
  IMAGE_MODELS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.storyboard.model';

// Page-level "Generate all images" dialog. Pick the image model; prompts and
// references are taken from each frame as already configured, so there are no
// prompt/reference inputs here. Shows how many start frames will be generated
// vs skipped (computed by the caller from the loaded storyboard list).
export function BulkGenerateImagesDialog({ open, onClose, onSubmit, missingCount = 0, skipCount = 0 }) {
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  const nothingToDo = missingCount === 0;

  return (
    <Modal
      open={open}
      title="Generate all images"
      onClose={onClose}
      dismissible
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={() => onSubmit({ imageModel })}
            disabled={nothingToDo}
          >
            Generate
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p className="modal-help" style={{ margin: 0 }}>
          {nothingToDo
            ? 'Every shot already has a start-frame image. Nothing to generate.'
            : `${missingCount} start frame${missingCount === 1 ? '' : 's'} missing → will be generated.` +
              (skipCount > 0
                ? ` ${skipCount} already ${skipCount === 1 ? 'has' : 'have'} an image → skipped.`
                : '')}
        </p>
        <p className="modal-help" style={{ margin: 0 }}>
          Each frame uses its own configured prompt and references. Frames with no
          saved prompt fall back to an auto-suggested one.
        </p>
        <div className="frame-generate-model-row">
          <span className="field-label">Image model</span>
          <div className="frame-generate-model-options">
            {IMAGE_MODELS.map((m) => (
              <label key={m.id}>
                <input
                  type="radio"
                  name="bulk-image-model"
                  value={m.id}
                  checked={imageModel === m.id}
                  onChange={() => setImageModel(m.id)}
                />
                {m.label}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Build the SPA to verify it compiles**

Run: `npm run build:web`
Expected: Build succeeds with no errors referencing `BulkGenerateImagesDialog` (the import is added in Task 6; this step just verifies the file itself parses — it will be tree-shaken out until imported, so a clean build is the pass condition).

- [ ] **Step 3: Commit**

```bash
git add web/src/widgets/BulkGenerateImagesDialog.jsx
git commit -m "feat(web): BulkGenerateImagesDialog model picker"
```

---

## Task 6: Frontend — wire the two buttons into `StoryboardBeat`

**Files:**
- Modify: `web/src/routes/StoryboardBeat.jsx`

- [ ] **Step 1: Add the import**

After the existing `StoryboardGenerateDialog` import (~line 22), add:

```jsx
import { BulkGenerateImagesDialog } from '../widgets/BulkGenerateImagesDialog.jsx';
```

- [ ] **Step 2: Add bulk-image state**

After the existing `const [deleteAllError, setDeleteAllError] = useState(null);` (~line 41), add:

```jsx
  // Bulk start-frame image generation ("Generate all images") — separate job +
  // poll from the plan-generation flow above. Both are mutually exclusive via
  // the per-beat lock; the UI also disables one while the other runs.
  const [imageGenDialogOpen, setImageGenDialogOpen] = useState(false);
  const [imageGenerating, setImageGenerating] = useState(false);
  const [imageJobStatus, setImageJobStatus] = useState(null);
  const [imageGenError, setImageGenError] = useState(null);
  const imagePollRef = useRef(null);
  const [confirmDeleteImages, setConfirmDeleteImages] = useState(false);
  const [deleteImagesError, setDeleteImagesError] = useState(null);
```

- [ ] **Step 3: Add the missing/skip counts (derived)**

After the `totalRuntime` useMemo (~line 155), add:

```jsx
  // Each shot's start frame is frames[0]. "Missing" = it exists but has no image.
  const startFrameStats = useMemo(() => {
    let missing = 0;
    let withImage = 0;
    for (const sb of sortedItems) {
      const f0 = sb.frames?.[0];
      if (!f0) continue;
      if (f0.image_id) withImage += 1;
      else missing += 1;
    }
    return { missing, withImage };
  }, [sortedItems]);
```

- [ ] **Step 4: Add the bulk generate poll + start, delete handler**

After the existing `deleteAll` function (~line 259), add:

```jsx
  async function pollImageJob(jobId) {
    try {
      const r = await apiGet(`/storyboards/generate-images/${jobId}`);
      setImageJobStatus(r.job);
      if (['done', 'partial', 'error'].includes(r.job?.status)) {
        clearInterval(imagePollRef.current);
        imagePollRef.current = null;
        setImageGenerating(false);
        if (r.job.status === 'error') {
          setImageGenError(r.job.error || 'Image generation failed.');
        }
        onRefresh();
      } else {
        onRefresh();
      }
    } catch (e) {
      // Ignore transient errors; polling keeps trying.
    }
  }

  async function generateAllImages({ imageModel }) {
    if (!data?.beat) return;
    setImageGenError(null);
    setImageGenerating(true);
    setImageJobStatus({ status: 'queued', completed: 0, planned: 0, failed: 0 });
    try {
      const r = await apiPostJson('/storyboards/generate-images', {
        beat_id: data.beat._id,
        image_model: imageModel,
      });
      const jobId = r.job_id;
      imagePollRef.current = setInterval(() => pollImageJob(jobId), 2000);
      pollImageJob(jobId);
    } catch (e) {
      setImageGenerating(false);
      setImageGenError(e.message);
    }
  }

  function onGenDialogImagesSubmit(settings) {
    setImageGenDialogOpen(false);
    generateAllImages(settings);
  }

  async function deleteAllImages() {
    setDeleteImagesError(null);
    try {
      await apiPostJson('/storyboards/clear-images', { beat_id: data.beat._id });
      onRefresh();
    } catch (e) {
      setDeleteImagesError(e.message);
    }
  }
```

- [ ] **Step 5: Clean up the poll interval on unmount**

In the existing unmount effect (~line 261-265), add the image poll cleanup:

```jsx
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (imagePollRef.current) clearInterval(imagePollRef.current);
    };
  }, []);
```

- [ ] **Step 6: Add the two toolbar buttons**

In the toolbar button group (the `<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>` ~line 300), the existing plan "Generate" button at the top must also disable while images are generating, and the existing "Delete all" too. Replace the plan **Generate** button's `disabled={generating}` with `disabled={generating || imageGenerating}`, and the **Delete all** button's `disabled={generating || sortedItems.length === 0}` with `disabled={generating || imageGenerating || sortedItems.length === 0}`.

Then add these two buttons inside the same group, right before the closing `</div>` of the button group (after the existing "Delete all" button):

```jsx
          <button
            onClick={() => setImageGenDialogOpen(true)}
            disabled={generating || imageGenerating || sortedItems.length === 0}
            title="Render the start-frame image for every shot that's missing one"
          >
            {imageGenerating ? 'Generating images…' : 'Generate all images'}
          </button>
          <button
            className="danger"
            onClick={() => setConfirmDeleteImages(true)}
            disabled={generating || imageGenerating || sortedItems.length === 0}
            title="Remove every generated frame image in this beat (keeps prompts & references)"
          >
            Delete all images
          </button>
```

- [ ] **Step 7: Add the image error banner + progress panel**

After the existing `{generating && generationStatus && (<StoryboardGenerationProgress .../>)}` block (~line 340-347), add:

```jsx
      {imageGenError && (
        <div className="error-banner">Image generation error: {imageGenError}</div>
      )}
      {deleteImagesError && (
        <div className="error-banner">Delete images failed: {deleteImagesError}</div>
      )}
      {imageGenerating && imageJobStatus && (
        <StoryboardGenerationProgress
          job={imageJobStatus}
          showLog={showProgressLog}
          onToggleLog={() => setShowProgressLog((s) => !s)}
          logRef={progressLogRef}
        />
      )}
```

- [ ] **Step 8: Mount the dialog + confirm**

After the existing `<StoryboardGenerateDialog ... />` block (~line 409-416), add:

```jsx
      <BulkGenerateImagesDialog
        open={imageGenDialogOpen}
        onClose={() => setImageGenDialogOpen(false)}
        onSubmit={onGenDialogImagesSubmit}
        missingCount={startFrameStats.missing}
        skipCount={startFrameStats.withImage}
      />

      <ConfirmDialog
        open={confirmDeleteImages}
        title="Delete all images?"
        message={
          'This removes every generated frame image in this beat. ' +
          'Prompts and reference images are kept. This cannot be undone.'
        }
        confirmLabel="Delete all images"
        danger
        onConfirm={() => { setConfirmDeleteImages(false); deleteAllImages(); }}
        onCancel={() => setConfirmDeleteImages(false)}
      />
```

(`ConfirmDialog` is already imported at the top of the file alongside `Modal`.)

- [ ] **Step 9: Build the SPA**

Run: `npm run build:web`
Expected: Build succeeds, no errors.

- [ ] **Step 10: Commit**

```bash
git add web/src/routes/StoryboardBeat.jsx
git commit -m "feat(web): Generate all images / Delete all images toolbar buttons"
```

---

## Task 7: Full verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass, including the three new files.

- [ ] **Step 2: Build the SPA**

Run: `npm run build:web`
Expected: Clean build into `web/dist/`.

- [ ] **Step 3: Manual smoke (requires Mongo + the dev server)**

Run: `npm run dev` (and `npm run dev:web` for the SPA dev server, or open the built SPA), then:
- Open a beat storyboard with several shots, some start frames empty, some rendered.
- Click **Generate all images** → dialog shows the correct "N missing → generate / M skipped" counts and the model radio list (default = your last-used model). Click Generate.
- Confirm the progress panel appears, tiles fill in live as frames complete, and already-rendered start frames are untouched.
- Click **Delete all images**, confirm → all frame images disappear; prompts and reference images remain (open a frame's Generate dialog to confirm references are still attached).
- Re-run **Generate all images** → it regenerates the cleared start frames.

- [ ] **Step 4: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "chore: storyboard bulk image generation verification tweaks"
```

(Skip if Step 3 required no changes.)

---

## Self-Review (completed by plan author)

**Spec coverage:** Generate (start frame / this beat / suggested fallback) → Tasks 3,4,5,6. Delete (all frame images / keep refs+prompts / shared-id guard) → Tasks 1,2,4,6. Model picker dialog → Task 5. Progress reuse + poll → Task 6. Routes/contracts → Task 4. Toolbar naming + mutual-exclusion disable → Task 6. Tests → Tasks 1-4. ✅ (Deviation: Discord batch announcement omitted — documented in header.)

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `clearAllFrameImagesForBeat` returns `{freedImageIds, referencedIds, storyboardIds}` (Task 1) consumed identically in Task 2. `startBulkFrameGenerationJob` returns `{jobId, planned}` (Task 3) consumed in route (Task 4, reads `jobId`/`planned`) and SPA (Task 6, reads `r.job_id`/`r.planned`). Route response key is `job_id` (Task 4) and the SPA reads `r.job_id` (Task 6) — consistent. Job statuses `queued|rendering|done|partial|error` produced in Task 3 and matched by the SPA poll terminal check in Task 6. ✅
