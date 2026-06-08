# Storyboard Critique + Scene-Bible UI — Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the scene bible and critique panel in the SPA — an editable collaborative Scene Bible, per-shot critique scores + lens breakdowns, and one-click critique / regenerate-from-critique / re-expand-all actions.

**Architecture:** Two thin backend additions (scene-bible y-doc fragments on the beat room; a bulk "re-expand all shots" job) plus three React surfaces (collapsed-row score chip, expanded critique panel, collapsible Scene Bible panel). Pure display/aggregation logic is extracted into plain-JS modules so it gets real Vitest TDD; the JSX stays thin and is verified in the running app.

**Tech Stack:** Node ESM, MongoDB (in-memory fake in tests), Yjs/Tiptap/Hocuspocus collab, React/Vite SPA, Vitest.

**Builds on:** Plan 1 (`beat.scene_bible`, `setBeatSceneBible`, `SCENE_BIBLE_FIELDS`, `planScene`/`expandShots`) and Plan 2 (`prompt_critique`/`image_critique` fields, `critiquePanel`, `reExpandShot`, `mergeCritiqueComments`, `startCritiqueJob`/`getCritiqueJob`, and routes `POST /storyboard/:id/critique`, `GET /storyboard/critique/job/:jobId`, `POST /storyboard/:id/reexpand`).

**Out of scope (→ future):** an AI "Regenerate bible" button; any video-registry change.

---

## Key existing code (verified)

- `src/web/roomRegistry.js` `describeBeatRoom(id)` (lines 217-272): `BEAT_TOP_FIELDS = ['name','desc','body']`; builds `fieldNames`, a `seed` map (`readMongoValue` per field), and `persistFields(snapshot)` that diffs each field vs `readMongoValue` and calls `updateBeat(id, patch)`. The character room (lines 276-355) is the precedent for dynamic `fields.<x>` fragments. Imports at top already include `getPlot`, `updateBeat`; this plan adds `setBeatSceneBible` + `SCENE_BIBLE_FIELDS`.
- `src/mongo/sceneBible.js`: `SCENE_BIBLE_FIELDS` (the 8 field keys), `normalizeSceneBible`, `isEmptySceneBible`.
- `src/mongo/plots.js`: `setBeatSceneBible(identifier, bible)` — whole-object write of `beats.$.scene_bible` (normalizes + stamps `updated_at`).
- `src/web/storyboardGenerate.js`: `reExpandShot({storyboardId, critiqueGuidance})` holds `withBeatLock` + pre-checks `isBeatLocked`; `expandShots`, `buildTextPrompt`, `findCharactersInBeat`, `loadDirectorNotesForPlanner`, `getStoryboard`, `getBeat`, `makeJobId`, `recordProgress`, `withBeatLock`, `isBeatLocked`, `BeatBusyError`, the gateway text helpers (`setStoryboardTextPromptViaGateway`, `setStoryboardFramePromptViaGateway`, `addStoryboardFrameViaGateway`), `listStoryboards`.
- `src/web/entityRoutes.js`: routes under `router.use(requireSession())`; `resolveStoryboardId`, `isOidHex`, job-poll route pattern; `getBeat`.
- SPA: `web/src/routes/StoryboardBeat.jsx` (storyboard list, `CollabSurface room="storyboards:<order>"`, `onRefresh` refetch on `fields_updated`); `web/src/widgets/StoryboardItemCollapsed.jsx` (collapsed row); `web/src/widgets/StoryboardItem.jsx` (expanded row, has the frame-job polling pattern `apiGet('/storyboard/frame-generate/job/'+id)` every 2s); `web/src/editor/CollabSurface.jsx` (`<CollabSurface room session onPing>`, context via `useCollabRoom`) + `web/src/editor/CollabField.jsx` (`<CollabField field=… label multiline>`); `web/src/api.js` (`apiGet`, `apiPostJson`); `web/src/routes/Character.jsx:121` (the `customFields.map(f => <CollabField field={`fields.${f.name}`}/>)` loop precedent).

---

## File Structure

**New files:**
- `web/src/widgets/critiqueDisplay.js` — pure display helpers (which score to show, color band, flag, sub-score line). No React imports → unit-testable in Node.
- `web/src/widgets/SceneBiblePanel.jsx` — the collapsible bible editor (nested CollabSurface + 8 CollabFields + Re-expand-all).
- `web/src/widgets/CritiquePanel.jsx` — the expanded-shot critique breakdown + action buttons.
- `tests/roomRegistry-scene-bible.test.js`, `tests/storyboardReExpandAll.test.js`, `tests/critiqueDisplay.test.js`.

**Modified files:**
- `src/web/roomRegistry.js` — `describeBeatRoom` gains the `scene_bible.*` fragments + persist.
- `src/web/storyboardGenerate.js` — factor `reExpandShotInner`; add `startReExpandAllJob`/`getReExpandAllJob`.
- `src/web/entityRoutes.js` — `POST /beat/:beatId/reexpand-shots`, `GET /beat/reexpand/job/:jobId`.
- `web/src/widgets/StoryboardItemCollapsed.jsx` — score chip.
- `web/src/widgets/StoryboardItem.jsx` — mount `<CritiquePanel>`.
- `web/src/routes/StoryboardBeat.jsx` — mount `<SceneBiblePanel>`.
- `web/src/styles.css` — chip + panel + bible styles.

---

## Milestone A — Scene bible as collaborative fragments

### Task A1: `scene_bible.*` fragments on the beat room

**Files:**
- Modify: `src/web/roomRegistry.js` (`describeBeatRoom`, lines 217-272; imports)
- Test: `tests/roomRegistry-scene-bible.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/roomRegistry-scene-bible.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
const { resolveRoom } = await import('../src/web/roomRegistry.js');

describe('beat room scene_bible fragments', () => {
  beforeEach(() => fakeDb.reset());

  it('exposes a fragment per scene_bible field, seeded from the stored bible', async () => {
    await createBeat({ name: 'Diner', desc: 'd' });
    const beat = await getBeat('Diner');
    await setBeatSceneBible(beat._id, { location: 'Corner diner', mood: 'tense' });

    const desc = await resolveRoom(`beat:${beat._id.toString()}`);
    expect(desc.fields).toContain('scene_bible.location');
    expect(desc.fields).toContain('scene_bible.camera_language');
    expect(desc.seed['scene_bible.location']).toBe('Corner diner');
    expect(desc.seed['scene_bible.mood']).toBe('tense');
    expect(desc.seed['scene_bible.palette']).toBe(''); // unset → empty
  });

  it('persistFields writes a changed bible field back via setBeatSceneBible', async () => {
    await createBeat({ name: 'Diner', desc: 'd' });
    const beat = await getBeat('Diner');
    const desc = await resolveRoom(`beat:${beat._id.toString()}`);

    // snapshot mimics the store-tick: every fragment rendered to markdown
    const snapshot = {};
    for (const f of desc.fields) snapshot[f] = desc.seed[f] ?? '';
    snapshot['scene_bible.location'] = 'Rainy alley';

    const result = await desc.persistFields(snapshot);
    expect(result.changed).toBe(true);
    expect(result.fields).toContain('scene_bible.location');

    const updated = await getBeat('Diner');
    expect(updated.scene_bible.location).toBe('Rainy alley');
  });

  it('persistFields does nothing when no bible field changed', async () => {
    await createBeat({ name: 'Diner', desc: 'd' });
    const beat = await getBeat('Diner');
    await setBeatSceneBible(beat._id, { location: 'Corner diner' });
    const desc = await resolveRoom(`beat:${beat._id.toString()}`);
    const snapshot = {};
    for (const f of desc.fields) snapshot[f] = desc.seed[f] ?? '';
    const result = await desc.persistFields(snapshot);
    // body/name/desc unchanged AND bible unchanged → no change
    expect(result.changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/roomRegistry-scene-bible.test.js`
Expected: FAIL — `scene_bible.location` not in `desc.fields`.

- [ ] **Step 3: Add imports**

At the top of `src/web/roomRegistry.js`, add to the existing imports:

```js
import { setBeatSceneBible } from '../mongo/plots.js';
import { SCENE_BIBLE_FIELDS } from '../mongo/sceneBible.js';
```

(If `updateBeat` is already imported from `../mongo/plots.js`, add `setBeatSceneBible` to that existing import line rather than duplicating.)

- [ ] **Step 4: Add the fragments + persist in `describeBeatRoom`**

Replace the body of `describeBeatRoom` (lines 217-272) with this version (adds `scene_bible.*` to `fieldNames`, `readMongoValue`, and a persist branch that whole-object writes via `setBeatSceneBible`):

```js
async function describeBeatRoom(id) {
  const plot = await getPlot();
  const beat = (plot.beats || []).find((b) => b._id?.toString?.() === id);
  if (!beat) return null;
  const bibleFieldNames = SCENE_BIBLE_FIELDS.map((f) => `scene_bible.${f}`);
  const fieldNames = [...BEAT_TOP_FIELDS, ...bibleFieldNames];

  function readMongoValue(fieldName) {
    if (BEAT_TOP_FIELDS.includes(fieldName)) {
      return beat[fieldName] != null ? String(beat[fieldName]) : '';
    }
    if (fieldName.startsWith('scene_bible.')) {
      const key = fieldName.slice('scene_bible.'.length);
      const v = beat.scene_bible?.[key];
      return v != null ? String(v) : '';
    }
    return '';
  }

  const imageFragments = await describeOwnedImageFragments(beat.images);
  const attachmentFragments = await describeOwnedAttachmentFragments(beat.attachments);
  const allFields = [...fieldNames, ...imageFragments.fields, ...attachmentFragments.fields];
  const seed = fieldNames.reduce((acc, f) => {
    acc[f] = readMongoValue(f);
    return acc;
  }, {});
  Object.assign(seed, imageFragments.seed, attachmentFragments.seed);

  return {
    type: 'beat',
    id,
    fields: allFields,
    seed,
    persistFields: async (snapshot) => {
      const patch = {};
      for (const f of BEAT_TOP_FIELDS) {
        if (snapshot[f] === undefined) continue;
        if (snapshot[f] === readMongoValue(f)) continue;
        patch[f] = snapshot[f];
      }

      // Scene bible: whole-object read-modify-write (avoids dotted $set through
      // a null scene_bible and reuses the normalizing setBeatSceneBible helper).
      const changedBibleFields = bibleFieldNames.filter(
        (f) => snapshot[f] !== undefined && snapshot[f] !== readMongoValue(f),
      );
      if (changedBibleFields.length) {
        const bible = {};
        for (const f of SCENE_BIBLE_FIELDS) {
          const frag = `scene_bible.${f}`;
          bible[f] = snapshot[frag] !== undefined ? snapshot[frag] : readMongoValue(frag);
        }
        await setBeatSceneBible(id, bible);
      }

      const imgPersist = await persistOwnedImageFragments(snapshot, imageFragments.seed);
      const attachPersist = await persistOwnedAttachmentFragments(
        snapshot,
        attachmentFragments.seed,
      );
      const entityChangedKeys = Object.keys(patch);
      if (entityChangedKeys.length) {
        await updateBeat(id, patch);
        enqueueReindex('beat', id);
      }
      const allChanged = [
        ...entityChangedKeys,
        ...changedBibleFields,
        ...imgPersist.changedFields,
        ...attachPersist.changedFields,
      ];
      if (!allChanged.length) return { changed: false };
      return { changed: true, fields: allChanged };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/roomRegistry-scene-bible.test.js`
Expected: PASS.

- [ ] **Step 6: Regression + commit**

Run: `npx vitest run tests/roomRegistry.test.js` (if present — find via `ls tests | grep -i room`).
```bash
git add src/web/roomRegistry.js tests/roomRegistry-scene-bible.test.js
git commit -m "✨ Expose scene_bible fields as collaborative fragments on the beat room"
```

---

## Milestone B — Bulk "re-expand all shots from bible"

### Task B1: Factor the lock-free core out of `reExpandShot`

**Files:**
- Modify: `src/web/storyboardGenerate.js` (`reExpandShot`)
- Test: existing `tests/storyboardCritiqueGeneration.test.js` must stay green (the reExpandShot test).

This is a pure refactor: extract everything `reExpandShot` does *inside* its `withBeatLock` body into `reExpandShotInner({ sb, beat, critiqueGuidance })`, leaving `reExpandShot` to do the load + `isBeatLocked` pre-check + `withBeatLock(beat._id, () => reExpandShotInner(...))`. Behaviour is unchanged.

- [ ] **Step 1: Read `reExpandShot`** in `src/web/storyboardGenerate.js`. Identify the lock body (the part that builds `outlineFrame`, calls `expandShots`, the empty-expansion guard, and the gateway writes).

- [ ] **Step 2: Extract `reExpandShotInner`**

Create the inner function (takes the already-loaded `sb` + `beat`, no lock, no re-fetch):

```js
// Lock-free core of a single-shot re-expansion. Caller must already hold the
// beat lock (reExpandShot acquires it per-call; the bulk job holds it once).
async function reExpandShotInner({ sb, beat, critiqueGuidance = '' }) {
  const characters = await findCharactersInBeat(beat);
  const directorNotes = await loadDirectorNotesForPlanner();
  const outlineFrame = {
    description: stripMarkdown(sb.summary || '').trim(),
    shot_type: sb.shot_type ?? null,
    duration_seconds: sb.duration_seconds ?? null,
    transition_in: sb.transition_in || '',
    characters_in_scene: Array.isArray(sb.characters_in_scene) ? sb.characters_in_scene : [],
    reverse_in_post: Boolean(sb.reverse_in_post),
  };
  const expanded = await expandShots({
    beat, characters, sceneBible: beat.scene_bible, outline: [outlineFrame],
    direction: '', directorNotes, revisionNotes: critiqueGuidance || '',
  });
  if (!expanded.length || !expanded[0]?.start_frame_prompt || !expanded[0]?.video_prompt) {
    logger.warn(`storyboard reExpandShot: empty/invalid expansion for ${sb._id}; keeping existing prompts`);
    return { storyboardId: String(sb._id), unchanged: true };
  }
  const e = expanded[0];
  const newFrame = {
    ...outlineFrame,
    start_frame_prompt: e.start_frame_prompt,
    video_prompt: e.video_prompt,
    reverse_in_post: typeof e.reverse_in_post === 'boolean' ? e.reverse_in_post : outlineFrame.reverse_in_post,
  };
  const newTextPrompt = buildTextPrompt(newFrame);
  const newStartPrompt = stripMarkdown(newFrame.start_frame_prompt || '').trim();
  await setStoryboardTextPromptViaGateway({ storyboardId: sb._id, text: newTextPrompt });
  if (sb.frames?.[0]?._id) {
    await setStoryboardFramePromptViaGateway({ storyboardId: sb._id, frameId: sb.frames[0]._id, text: newStartPrompt });
  } else if (newStartPrompt) {
    await addStoryboardFrameViaGateway({ storyboardId: sb._id, prompt: newStartPrompt, referenceIds: [] });
  }
  return { storyboardId: String(sb._id) };
}
```

NOTE: copy the EXACT gateway-write calls from the current `reExpandShot` (the persistence helper names/args must match what's already there — read them and mirror; the above reflects the Task-E2 implementation but verify the arg shapes `{storyboardId, text}` / `{storyboardId, frameId, text}` against the real helpers before finalizing).

- [ ] **Step 3: Rewrite `reExpandShot` to delegate**

```js
export async function reExpandShot({ storyboardId, critiqueGuidance = '' }) {
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beat = await getBeat(sb.beat_id.toString());
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  return withBeatLock(beat._id, () => reExpandShotInner({ sb, beat, critiqueGuidance }));
}
```

- [ ] **Step 4: Run the existing reExpand test**

Run: `npx vitest run tests/storyboardCritiqueGeneration.test.js`
Expected: PASS (behaviour unchanged — the reExpandShot test still updates `frames[0].prompt` + `text_prompt`).

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js
git commit -m "♻️ Factor reExpandShotInner (lock-free core) out of reExpandShot"
```

---

### Task B2: `startReExpandAllJob` + routes

**Files:**
- Modify: `src/web/storyboardGenerate.js` (job map + functions)
- Modify: `src/web/entityRoutes.js` (two routes)
- Test: `tests/storyboardReExpandAll.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/storyboardReExpandAll.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const gen = await import('../src/web/storyboardGenerate.js');

async function drain(jobId) {
  for (let i = 0; i < 200; i++) {
    const j = gen.getReExpandAllJob(jobId);
    if (j && ['done', 'partial', 'error'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  return gen.getReExpandAllJob(jobId);
}

describe('startReExpandAllJob', () => {
  beforeEach(() => fakeDb.reset());

  it('re-expands every shot of the beat against the bible', async () => {
    const { createBeat, getBeat, setBeatSceneBible } = await import('../src/mongo/plots.js');
    const { createStoryboard, getStoryboard, listStoryboards } = await import('../src/mongo/storyboards.js');
    await createBeat({ name: 'Bulk', desc: 'd', characters: [] });
    const beat = await getBeat('Bulk');
    await setBeatSceneBible('Bulk', { location: 'Diner' });
    await createStoryboard({ beatId: beat._id, order: 1, textPrompt: 'OLD1', summary: 'shot one', shotType: 'medium', durationSeconds: 4 });
    await createStoryboard({ beatId: beat._id, order: 2, textPrompt: 'OLD2', summary: 'shot two', shotType: 'close_up', durationSeconds: 3 });

    let calls = 0;
    gen._setShotExpanderForTests(({ outline }) => {
      calls += 1;
      return outline.map((_, i) => ({ start_frame_prompt: `NS${calls}`, video_prompt: `NV${calls}`, reverse_in_post: false }));
    });

    const jobId = await gen.startReExpandAllJob({ beatId: beat._id.toString() });
    const job = await drain(jobId);
    expect(job.status).toBe('done');
    expect(calls).toBe(2); // one expand per shot

    const sbs = await listStoryboards({ beatId: beat._id });
    for (const sb of sbs) {
      expect(sb.text_prompt).toContain('NV');
      expect(sb.frames[0].prompt).toMatch(/^NS/);
    }
    gen._setShotExpanderForTests(null);
  });

  it('reports done with zero shots (no-op)', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    await createBeat({ name: 'Empty', desc: 'd' });
    const beat = await getBeat('Empty');
    const jobId = await gen.startReExpandAllJob({ beatId: beat._id.toString() });
    const job = await drain(jobId);
    expect(job.status).toBe('done');
    expect(job.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboardReExpandAll.test.js`
Expected: FAIL — `startReExpandAllJob` undefined.

- [ ] **Step 3: Implement the job** in `src/web/storyboardGenerate.js`

```js
const reExpandAllJobs = new Map();
export function getReExpandAllJob(jobId) { return reExpandAllJobs.get(jobId) || null; }

// Bulk re-expand: rerun Pass 2 for EVERY shot of a beat against the current
// scene bible. Holds the beat lock once and loops shots through the lock-free
// reExpandShotInner. Per-shot failures are swallowed so one bad shot doesn't
// abort the batch.
export async function startReExpandAllJob({ beatId }) {
  const beat = await getBeat(beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  const jobId = makeJobId();
  const job = { job_id: jobId, beat_id: String(beat._id), status: 'queued', started_at: new Date(), finished_at: null, error: null, total: 0, completed: 0, failed: 0, progress: null, events: [] };
  reExpandAllJobs.set(jobId, job);
  withBeatLock(beat._id, async () => {
    job.status = 'running';
    const { listStoryboards } = await import('../mongo/storyboards.js');
    const shots = await listStoryboards({ beatId: beat._id });
    job.total = shots.length;
    for (let i = 0; i < shots.length; i++) {
      recordProgress(job, { phase: 'reexpand', step: 'shot_start', frame: i + 1, total: shots.length, message: `Re-expanding shot ${i + 1}/${shots.length}…` });
      try {
        // Re-read each shot so we get its current frames[]/metadata.
        const sb = await getStoryboard(shots[i]._id);
        await reExpandShotInner({ sb, beat });
        job.completed += 1;
      } catch (e) {
        job.failed += 1;
        logger.warn(`reExpandAll shot ${i + 1}: ${e?.message || e}`);
      }
    }
    job.status = job.failed === 0 ? 'done' : 'partial';
    job.finished_at = new Date();
  }).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    logger.error(`reExpandAll job ${jobId} crashed: ${e.message}`);
  });
  return jobId;
}
```

VERIFY `recordProgress`, `getStoryboard`, `getBeat`, `makeJobId`, `withBeatLock`, `isBeatLocked`, `BeatBusyError`, `reExpandShotInner`, `logger` are in scope. (`getBeat` accepts an id string and resolves the beat.)

- [ ] **Step 4: Add the routes** in `src/web/entityRoutes.js` (under `requireSession()`, near the other beat/storyboard routes). Use a literal path so the job route isn't shadowed by `/beat/:id`:

```js
router.post('/beat/:beatId/reexpand-shots', async (req, res, next) => {
  try {
    const beat = await getBeat(String(req.params.beatId));
    if (!beat) return res.status(404).json({ error: 'beat not found' });
    const { startReExpandAllJob, BeatBusyError } = await import('./storyboardGenerate.js');
    try {
      const jobId = await startReExpandAllJob({ beatId: beat._id.toString() });
      res.status(202).json({ job_id: jobId, beat_id: beat._id });
    } catch (e) {
      if (e instanceof BeatBusyError) return res.status(409).json({ error: e.message });
      throw e;
    }
  } catch (e) { next(e); }
});

router.get('/beat/reexpand/job/:jobId', async (req, res, next) => {
  try {
    const { getReExpandAllJob } = await import('./storyboardGenerate.js');
    const job = getReExpandAllJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ job });
  } catch (e) { next(e); }
});
```

Confirm there's no `GET /beat/:id` that would capture `/beat/reexpand/job/:jobId` (the literal `reexpand` segment in `:beatId` position only matters for the POST, which resolves via getBeat and 404s on a non-id; the GET is 3-segment literal `beat/reexpand/job/:jobId`). Report the route-ordering check.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/storyboardReExpandAll.test.js`
Expected: PASS.

- [ ] **Step 6: Regression + commit**

Run: `npx vitest run tests/storyboardCritiqueGeneration.test.js`
```bash
git add src/web/storyboardGenerate.js src/web/entityRoutes.js tests/storyboardReExpandAll.test.js
git commit -m "✨ Add bulk re-expand-all-shots job + endpoints"
```

---

## Milestone C — Frontend

### Task C1: Critique display helpers + collapsed-row score chip

**Files:**
- Create: `web/src/widgets/critiqueDisplay.js`
- Test: `tests/critiqueDisplay.test.js`
- Modify: `web/src/widgets/StoryboardItemCollapsed.jsx`, `web/src/styles.css`

- [ ] **Step 1: Write the failing test**

```js
// tests/critiqueDisplay.test.js
import { describe, it, expect } from 'vitest';
import { pickCritiqueScore, scoreBand, isFlagged, FLAG_THRESHOLD } from '../web/src/widgets/critiqueDisplay.js';

describe('pickCritiqueScore', () => {
  it('prefers the image critique score when present', () => {
    expect(pickCritiqueScore({ image_critique: { overall: 4 }, prompt_critique: { overall: 8 } })).toBe(4);
  });
  it('falls back to the prompt critique score', () => {
    expect(pickCritiqueScore({ image_critique: null, prompt_critique: { overall: 7 } })).toBe(7);
  });
  it('returns null when neither is present', () => {
    expect(pickCritiqueScore({})).toBe(null);
    expect(pickCritiqueScore({ prompt_critique: null })).toBe(null);
  });
});

describe('scoreBand', () => {
  it('maps scores to good/medium/bad bands', () => {
    expect(scoreBand(9)).toBe('good');
    expect(scoreBand(8)).toBe('good');
    expect(scoreBand(6)).toBe('medium');
    expect(scoreBand(5)).toBe('bad');
    expect(scoreBand(1)).toBe('bad');
  });
});

describe('isFlagged', () => {
  it('flags scores below the threshold', () => {
    expect(FLAG_THRESHOLD).toBe(6);
    expect(isFlagged(5)).toBe(true);
    expect(isFlagged(6)).toBe(false);
    expect(isFlagged(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/critiqueDisplay.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```js
// web/src/widgets/critiqueDisplay.js
// Pure display helpers for storyboard critique scores. No React — unit-tested
// in Node so the score/band/flag logic is covered even without a DOM harness.

export const FLAG_THRESHOLD = 6; // scores strictly below this get a ⚑

// The score to show on a shot: the rendered-image critique if it exists,
// otherwise the prompt critique, otherwise null (not yet critiqued).
export function pickCritiqueScore(sb) {
  const img = sb?.image_critique?.overall;
  if (typeof img === 'number') return img;
  const prm = sb?.prompt_critique?.overall;
  if (typeof prm === 'number') return prm;
  return null;
}

// Color band for a 1–10 score: 8+ good, 6–7 medium, ≤5 bad.
export function scoreBand(score) {
  if (typeof score !== 'number') return null;
  if (score >= 8) return 'good';
  if (score >= 6) return 'medium';
  return 'bad';
}

export function isFlagged(score) {
  return typeof score === 'number' && score < FLAG_THRESHOLD;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/critiqueDisplay.test.js`
Expected: PASS.

- [ ] **Step 5: Render the chip in `StoryboardItemCollapsed.jsx`**

Add the import and render the chip before the summary text. Read the current file; inside `.storyboard-item-collapsed-summary`, prepend the chip. Use the `sb` prop the component already receives (confirm the prop name — likely `item` or `storyboard`; match it).

```jsx
import { pickCritiqueScore, scoreBand, isFlagged } from './critiqueDisplay.js';
// ...
// inside the component, before return:
const critScore = pickCritiqueScore(sb);
const critBand = scoreBand(critScore);
// ...
// inside .storyboard-item-collapsed-summary, as the first child:
{critScore != null && (
  <span className={`storyboard-score-chip ${critBand}`} title="Critique score">
    {critScore}{isFlagged(critScore) ? ' ⚑' : ''}
  </span>
)}
```

- [ ] **Step 6: Add CSS** to `web/src/styles.css`

```css
.storyboard-score-chip {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  margin-right: 8px;
  vertical-align: middle;
}
.storyboard-score-chip.good { background: rgba(52,168,83,.16); color: var(--ok, #5fd07e); }
.storyboard-score-chip.medium { background: rgba(234,179,8,.16); color: var(--warning, #e7c14b); }
.storyboard-score-chip.bad { background: rgba(239,68,68,.16); color: var(--danger, #f1736e); }
```

- [ ] **Step 7: Build + commit**

Run: `npm run build:web` (must succeed).
```bash
git add web/src/widgets/critiqueDisplay.js tests/critiqueDisplay.test.js web/src/widgets/StoryboardItemCollapsed.jsx web/src/styles.css
git commit -m "✨ Show critique score chip on collapsed storyboard row"
```

---

### Task C2: Expanded critique panel + action buttons

**Files:**
- Create: `web/src/widgets/CritiquePanel.jsx`
- Modify: `web/src/widgets/StoryboardItem.jsx` (mount the panel), `web/src/styles.css`

This task is verified in the running app (no React harness assumed). The pure score/band logic it reuses is already tested (C1).

- [ ] **Step 1: Build `CritiquePanel.jsx`**

A component taking `{ sb, onRefresh }`. Renders the overall score (`pickCritiqueScore`), a `prompt N · render M` sub-line (from `sb.prompt_critique?.overall` / `sb.image_critique?.overall`), the four lens rows from whichever critique object is shown (`lenses[]` → name · score · bar · comment), and three buttons wired with the same job-polling pattern used by `StoryboardItem.jsx`'s frame regen (read it for `apiGet`/`apiPostJson` + `setInterval(poll, 2000)`):

```jsx
import { useRef, useState } from 'react';
import { apiGet, apiPostJson } from '../api.js';
import { pickCritiqueScore, scoreBand } from './critiqueDisplay.js';

export function CritiquePanel({ sb, onRefresh }) {
  const [busy, setBusy] = useState(null); // 'prompt' | 'image' | 'regen' | null
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const shown = sb.image_critique || sb.prompt_critique || null;
  const overall = pickCritiqueScore(sb);
  const hasImage = Boolean(sb.frames?.[0]?.image_id);

  function pollCritique(jobId) {
    pollRef.current = setInterval(async () => {
      try {
        const r = await apiGet(`/storyboard/critique/job/${jobId}`);
        const job = r?.job;
        if (job && (job.status === 'done' || job.status === 'error')) {
          clearInterval(pollRef.current); pollRef.current = null;
          if (job.status === 'error') setError(job.error || 'critique failed');
          setBusy(null);
          await onRefresh?.();
        }
      } catch { /* transient; retry next tick */ }
    }, 2000);
  }

  async function critique(target) {
    setBusy(target); setError(null);
    try {
      const r = await apiPostJson(`/storyboard/${sb._id}/critique?target=${target}`, {});
      pollCritique(r.job_id);
    } catch (e) { setError(e.message); setBusy(null); }
  }

  async function regenerate() {
    setBusy('regen'); setError(null);
    try {
      await apiPostJson(`/storyboard/${sb._id}/reexpand`, { use_critique: true });
      setBusy(null);
      await onRefresh?.();
    } catch (e) { setError(e.message); setBusy(null); }
  }

  return (
    <div className="critique-panel">
      <div className="critique-head">
        {overall != null ? (
          <span className={`critique-overall ${scoreBand(overall)}`}>{overall}<span className="max">/10</span></span>
        ) : <span className="critique-overall none">not critiqued</span>}
        <span className="critique-tiers">
          {sb.prompt_critique && <>prompt <b>{sb.prompt_critique.overall}</b></>}
          {sb.image_critique && <> · render <b>{sb.image_critique.overall}</b></>}
        </span>
        <span className="spacer" />
        <button disabled={busy} onClick={() => critique('prompt')}>{busy === 'prompt' ? 'Critiquing…' : 'Critique prompt'}</button>
        <button disabled={busy || !hasImage} title={hasImage ? '' : 'Render a frame first'} onClick={() => critique('image')}>{busy === 'image' ? 'Critiquing…' : 'Critique image'}</button>
        <button className="primary" disabled={busy || !sb.prompt_critique} onClick={regenerate}>{busy === 'regen' ? 'Regenerating…' : 'Regenerate from critique'}</button>
      </div>
      {error && <div className="critique-error">{error}</div>}
      {shown?.lenses?.map((l) => (
        <div className="critique-lens" key={l.lens}>
          <span className="lens-name">{l.lens.replace(/_/g, ' ')}</span>
          <span className={`lens-score ${scoreBand(l.score)}`}>{l.score}</span>
          <span className="lens-bar"><i className={scoreBand(l.score)} style={{ width: `${(l.score / 10) * 100}%` }} /></span>
          <span className="lens-comment">{l.comments}{l.error ? ' (lens errored)' : ''}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in `StoryboardItem.jsx`**

Import `CritiquePanel` and render `<CritiquePanel sb={sb} onRefresh={onRefresh} />` just above the `<ShotMetaRow>` (around line 604). Use the `sb`/`onRefresh` names the component already has in scope (verify and match).

- [ ] **Step 3: Add CSS** to `web/src/styles.css`

```css
.critique-panel { background:#16181d; border:1px solid var(--border,#2c2f36); border-radius:8px; padding:12px 14px; margin-bottom:12px; }
.critique-head { display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap; }
.critique-overall { font-size:22px; font-weight:800; }
.critique-overall .max { font-size:12px; color:var(--fg-muted,#6b7280); font-weight:600; }
.critique-overall.none { font-size:13px; color:var(--fg-muted,#6b7280); font-weight:600; }
.critique-overall.good{color:var(--ok,#5fd07e)} .critique-overall.medium{color:var(--warning,#e7c14b)} .critique-overall.bad{color:var(--danger,#f1736e)}
.critique-tiers { font-size:11px; color:var(--fg-muted,#8b93a1); }
.critique-tiers b { color:var(--fg,#c9ccd2); }
.critique-head .spacer { flex:1; }
.critique-error { color:var(--danger,#f1736e); font-size:12px; margin-bottom:6px; }
.critique-lens { display:flex; align-items:center; gap:10px; padding:6px 0; border-top:1px solid #23262d; }
.lens-name { width:110px; flex:none; font-size:12px; color:#aeb4be; text-transform:capitalize; }
.lens-score { width:22px; flex:none; font-weight:700; font-size:13px; text-align:right; }
.lens-score.good{color:var(--ok,#5fd07e)} .lens-score.medium{color:var(--warning,#e7c14b)} .lens-score.bad{color:var(--danger,#f1736e)}
.lens-bar { width:80px; flex:none; height:6px; border-radius:3px; background:#23262d; overflow:hidden; }
.lens-bar > i { display:block; height:100%; }
.lens-bar > i.good{background:var(--ok,#5fd07e)} .lens-bar > i.medium{background:var(--warning,#e7c14b)} .lens-bar > i.bad{background:var(--danger,#f1736e)}
.lens-comment { flex:1; font-size:12px; color:#9aa1ac; line-height:1.35; }
```

- [ ] **Step 4: Build + commit**

Run: `npm run build:web`
```bash
git add web/src/widgets/CritiquePanel.jsx web/src/widgets/StoryboardItem.jsx web/src/styles.css
git commit -m "✨ Add expanded-shot critique panel with critique/regenerate actions"
```

---

### Task C3: Scene Bible panel

**Files:**
- Create: `web/src/widgets/SceneBiblePanel.jsx`
- Modify: `web/src/routes/StoryboardBeat.jsx` (mount it), `web/src/styles.css`

Verified in the running app. The 8 field keys + labels are held locally in the SPA (stable; avoids importing server code into Vite).

- [ ] **Step 1: Build `SceneBiblePanel.jsx`**

```jsx
import { useRef, useState } from 'react';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { apiGet, apiPostJson } from '../api.js';

const BIBLE_FIELDS = [
  ['location', 'Location'],
  ['time_of_day', 'Time of day'],
  ['lighting_key', 'Lighting key'],
  ['palette', 'Palette'],
  ['mood', 'Mood'],
  ['blocking', 'Blocking'],
  ['continuity_anchors', 'Continuity anchors'],
  ['camera_language', 'Camera language'],
];

export function SceneBiblePanel({ beatId, session, shotCount, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  async function reexpandAll() {
    if (!window.confirm(`Re-expand prompts for all ${shotCount} shot(s) from the scene bible? This rewrites their prompts.`)) return;
    setBusy(true); setError(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/reexpand-shots`, {});
      pollRef.current = setInterval(async () => {
        try {
          const res = await apiGet(`/beat/reexpand/job/${r.job_id}`);
          const job = res?.job;
          if (job && ['done', 'partial', 'error'].includes(job.status)) {
            clearInterval(pollRef.current); pollRef.current = null;
            if (job.status === 'error') setError(job.error || 're-expand failed');
            setBusy(false);
            await onRefresh?.();
          }
        } catch { /* retry */ }
      }, 2000);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="scene-bible">
      <div className="scene-bible-head" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="title">Scene Bible</span>
        <span className="sub">{shotCount} shot(s) inherit this</span>
        <span className="spacer" />
        <button className="primary" disabled={busy} onClick={(e) => { e.stopPropagation(); reexpandAll(); }}>
          {busy ? 'Re-expanding…' : 'Re-expand all shots'}
        </button>
      </div>
      {error && <div className="critique-error">{error}</div>}
      {open && (
        <CollabSurface room={`beat:${beatId}`} session={session}>
          <div className="scene-bible-grid">
            {BIBLE_FIELDS.map(([key, label]) => (
              <div className="scene-bible-field" key={key}>
                <CollabField label={label} field={`scene_bible.${key}`} multiline />
              </div>
            ))}
          </div>
        </CollabSurface>
      )}
    </div>
  );
}
```

VERIFY against `CollabSurface.jsx`: the exact props it needs (`room`, `session`, optional `onPing`) and that nesting a second surface for a different room on the same page works (the exploration confirmed it's context-based). Pass the same `session` the page already has. If `CollabSurface` requires an `onPing`, pass a no-op or `onRefresh`.

- [ ] **Step 2: Mount in `StoryboardBeat.jsx`**

Render `<SceneBiblePanel beatId={beat._id} session={session} shotCount={storyboards.length} onRefresh={refresh} />` just inside the page, ABOVE the storyboard list (and outside the existing `storyboards:<…>` CollabSurface, or as a sibling — it brings its own surface). Match the real variable names in the route (`beat._id`, the storyboards array, the session, and the refetch fn — read the file and wire to the actual names).

- [ ] **Step 3: Add CSS** to `web/src/styles.css`

```css
.scene-bible { background:#16181d; border:1px solid var(--border,#2c2f36); border-radius:10px; margin-bottom:14px; overflow:hidden; }
.scene-bible-head { display:flex; align-items:center; gap:10px; padding:11px 14px; cursor:pointer; background:#1b1d22; }
.scene-bible-head .caret { color:var(--fg-muted,#6b7280); }
.scene-bible-head .title { font-weight:700; font-size:13px; color:var(--fg,#dfe3e9); }
.scene-bible-head .sub { font-size:11px; color:var(--fg-muted,#6b7280); }
.scene-bible-head .spacer { flex:1; }
.scene-bible-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 16px; padding:14px; }
.scene-bible-field label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:#7b8290; margin-bottom:4px; }
```

- [ ] **Step 4: Build + verify + commit**

Run: `npm run build:web` (must succeed).
```bash
git add web/src/widgets/SceneBiblePanel.jsx web/src/routes/StoryboardBeat.jsx web/src/styles.css
git commit -m "✨ Add collaborative Scene Bible panel with re-expand-all"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- Scene bible as y-doc fragments (seed + persist via setBeatSceneBible) → Task A1. ✅
- Bulk re-expand job + endpoints (lock held once, per-shot core shared) → Tasks B1, B2. ✅
- Collapsed-row score chip (image-else-prompt, band color, ⚑ flag <6) → Task C1. ✅
- Expanded critique panel (overall + prompt/render sub-scores + 4 lens rows + 3 buttons w/ job polling) → Task C2. ✅
- Scene Bible panel (nested CollabSurface, 8 CollabFields, collapse, Re-expand-all w/ confirm + poll) → Task C3. ✅
- Live refresh reuses existing `fields_updated` → onRefresh; critique persist already broadcasts. ✅
- No video-registry change; "Regenerate bible" deferred. ✅

**Placeholder scan:** No TBD/TODO. Every code step shows full code. The "read X and match the real prop/var names" notes in C1/C2/C3 and B1 are deliberate verification steps (the component prop names + exact gateway-helper arg shapes must be confirmed against the real files), not deferred logic.

**Type consistency:** `pickCritiqueScore`/`scoreBand`/`isFlagged`/`FLAG_THRESHOLD` defined in C1, reused in C2. `reExpandShotInner({sb, beat, critiqueGuidance})` defined in B1, reused by `reExpandShot` and `startReExpandAllJob` (B2). Job shape `{job_id, beat_id, status, total, completed, failed, ...}` consistent between B2 and the C3 poller. Critique object shape (`{overall, lenses:[{lens,score,comments,error?}]}`) matches Plan 2's `critiquePanel` output consumed in C2.

**Testing reality:** Backend (A1, B2) + the pure C1 helper get Vitest TDD. C2/C3 JSX is build-verified + app-verified (no React harness assumed); their non-trivial logic (score/band) is already covered by C1's tests.
