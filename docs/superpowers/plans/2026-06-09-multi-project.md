# Multi-Project Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple independent screenplay projects in one deployment — a Project Manager dialog in the SPA (create/switch, per-browser), a `set_project` tool for the Discord agent, and a `project_id` dimension on every content collection, threaded as explicit parameters.

**Architecture:** A new `projects` collection anchors plain-text unique titles. Every project-scoped Mongo helper gains `projectId` as an explicit first parameter (object-arg helpers gain a `projectId` key); during the build-out a transitional `resolveProjectId()` defaults missing ids to the default project so `npm test` stays green at every commit, then Task 20 flips it to throw (fail closed). Project enters at four boundaries: the Discord message handler (via `channel_state.current_project_id`), an Express middleware (`X-Project-Id` header), Hocuspocus room names (`plot:<pid>`, `notes:<pid>`, `library:<pid>`), and the SPA's `/p/:projectTitle/*` routes. A one-shot idempotent migration claims existing data for a default project.

**Tech Stack:** Node 20 ESM, Express, discord.js, MongoDB + GridFS, Yjs / Hocuspocus / Tiptap, React 18 + Vite + react-router, Vitest (`tests/_fakeMongo.js`), Chroma (RAG).

**Spec:** `docs/superpowers/specs/2026-06-09-multi-project-design.md`

## Phase overview & execution order

| Phase | Tasks | Contents |
|---|---|---|
| A — Foundation + Mongo core | 1–6 | `projects` helpers, plots per-project (+ lockstep duplicates), prompts/director-notes composite ids + seeding split, characters + index swap, messages stamping, storyboards/dialogs |
| B — Media + RAG | 7–9 | GridFS `images`/`attachments` `metadata.project_id`, library filters, `src/rag/query.js` extraction + project metadata, reindex script loop |
| C — Agent loop | 10–13 | `channel_state.current_project_id`, context plumbing (`projectId`/`projectTitle`), handler sweep + `links.js`, `set_project` tool |
| D — Web backend | 14–15 | `resolveProject()` middleware, `/api/projects`, route sweep, room renames + gateway |
| E — SPA | 16–18 | api.js project store, `ProjectProvider`, `/p/:projectTitle/*` routes, Header + ProjectManagerDialog, singleton room consumers |
| F — Migration + strict flip + docs | 19–21 | `scripts/migrate-multi-project.js`, strict `resolveProjectId` flip + isolation suite, CLAUDE.md/runbook |

**Execution rules:**
- Tasks run in numeric order; every task's commit leaves `npm test` green (the transitional `resolveProjectId` default is what makes the incremental sweeps safe — `undefined` project args resolve to the default project until later phases replace them).
- Where a task quotes "current code", an executor must match against the real file — earlier tasks may have shifted line numbers, but the quoted code itself is the anchor.
- Known accepted interim breakage (documented in Phase E's preamble): between Task 15 (server-side room renames) and Task 18 (SPA room consumers), the About/Notes/Library collaborative surfaces show a collaboration auth error in a running dev server. Build and tests stay green throughout; this window only affects manual QA of those three surfaces.

---
## Phase A: Foundation + Mongo Core

Spec: `docs/superpowers/specs/2026-06-09-multi-project-design.md`. Shared conventions apply throughout:

- `project_id` is a 24-hex **string** in all docs; `projects._id` is an ObjectId (convert with `.toString()`).
- Every project-scoped helper starts with `projectId = await resolveProjectId(projectId);` (transitional: falsy → default project; Task 20 flips it to throw).
- Positional helpers gain `projectId` as **first** parameter. Helpers that take a **single options object** (`createBeat({...})`, `createStoryboard({...})`, `createCharacter({...})`, `addDirectorNote({...})`, the `artworks.js` API, the `messages.js` recorders) gain a `projectId` **key** instead — their legacy callers stay green with no sweep.
- **Bridge rule for positional-helper call sites:** every existing call site in `src/` (outside the file being reworked) gets `undefined, ` prepended as the first argument in the *same task* that changes the signature. `resolveProjectId(undefined)` → default project, so behavior is unchanged. Later phases replace these `undefined`s with `context.projectId` / `req.projectId`. This is what keeps `npm test` green at every commit.
- ObjectId-addressed lookups locate by id, then verify `project_id`; **mismatch ⇒ not-found**. Docs with **no** `project_id` (pre-migration legacy) are treated as in-project (lenient until the migration stamps everything).

### Task 1: Projects module (`src/mongo/projects.js`)

Files:
- Create: `src/mongo/projects.js`
- Create: `tests/projects.test.js`
- Modify: `src/mongo/client.js` (index block, after line 95)
- Test: `tests/projects.test.js`

`tests/_fakeMongo.js` already supports everything this module needs (`findOne`, `insertOne`, `find().sort().limit().toArray()`, `createIndex` no-op) — **no fake extension required**. The fake does NOT enforce unique indexes, so `createProject` carries a helper-level duplicate check (with `err.code = 11000` so REST callers can map it to 409 the same way they would a real E11000).

- [ ] **Step 1: Write the failing test file** — create `tests/projects.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Projects = await import('../src/mongo/projects.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('createProject', () => {
  it('creates a project with trimmed title, title_lower, created_at', async () => {
    const p = await Projects.createProject('  My Movie  ');
    expect(p._id).toBeInstanceOf(ObjectId);
    expect(p.title).toBe('My Movie');
    expect(p.title_lower).toBe('my movie');
    expect(p.created_at).toBeInstanceOf(Date);
  });

  it('rejects empty / whitespace-only titles', async () => {
    await expect(Projects.createProject('')).rejects.toThrow(/non-empty/);
    await expect(Projects.createProject('   ')).rejects.toThrow(/non-empty/);
    await expect(Projects.createProject(undefined)).rejects.toThrow(/non-empty/);
  });

  it('rejects titles longer than 120 chars', async () => {
    await expect(Projects.createProject('x'.repeat(121))).rejects.toThrow(/120/);
  });

  it('rejects titles containing "/"', async () => {
    await expect(Projects.createProject('a/b')).rejects.toThrow(/\//);
  });

  it('throws (code 11000) on duplicate title, case-insensitively', async () => {
    await Projects.createProject('Heist');
    const err = await Projects.createProject('  HEIST ').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(11000);
    expect(err.message).toMatch(/duplicate/i);
  });
});

describe('listProjects / getProjectByTitle / getProjectById', () => {
  it('listProjects returns all projects oldest-first', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const list = await Projects.listProjects();
    expect(list.map((p) => p.title)).toEqual(['A', 'B']);
    expect(list[0]._id.toString()).toBe(a._id.toString());
    expect(list[1]._id.toString()).toBe(b._id.toString());
  });

  it('getProjectByTitle is case-insensitive and trims', async () => {
    const p = await Projects.createProject('Space Western');
    const found = await Projects.getProjectByTitle('  space WESTERN ');
    expect(found._id.toString()).toBe(p._id.toString());
    expect(await Projects.getProjectByTitle('nope')).toBe(null);
  });

  it('getProjectById accepts hex string or ObjectId; bad input returns null', async () => {
    const p = await Projects.createProject('X');
    expect((await Projects.getProjectById(p._id.toString()))._id.toString()).toBe(p._id.toString());
    expect((await Projects.getProjectById(p._id))._id.toString()).toBe(p._id.toString());
    expect(await Projects.getProjectById('not-hex')).toBe(null);
    expect(await Projects.getProjectById(new ObjectId().toString())).toBe(null);
  });
});

describe('getDefaultProject', () => {
  it('lazily creates a project titled "Screenplay" when the collection is empty', async () => {
    const def = await Projects.getDefaultProject();
    expect(def.title).toBe('Screenplay');
    expect(fakeDb.collection('projects')._docs).toHaveLength(1);
    // Idempotent: second call returns the same doc, no second insert.
    const again = await Projects.getDefaultProject();
    expect(again._id.toString()).toBe(def._id.toString());
    expect(fakeDb.collection('projects')._docs).toHaveLength(1);
  });

  it('returns the oldest project by created_at when projects exist', async () => {
    const a = await Projects.createProject('First');
    await Projects.createProject('Second');
    const def = await Projects.getDefaultProject();
    expect(def._id.toString()).toBe(a._id.toString());
  });
});

describe('resolveProjectId (transitional)', () => {
  it('returns String(projectId) when truthy', async () => {
    const oid = new ObjectId();
    expect(await Projects.resolveProjectId(oid)).toBe(oid.toString());
    expect(await Projects.resolveProjectId('abc')).toBe('abc');
  });

  it('falls back to the default project id when falsy', async () => {
    const id = await Projects.resolveProjectId(undefined);
    const def = await Projects.getDefaultProject();
    expect(id).toBe(def._id.toString());
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run tests/projects.test.js` → the file fails to load: `Failed to load ... Cannot find module '../src/mongo/projects.js'` (the module does not exist yet).

- [ ] **Step 3: Implement** — create `src/mongo/projects.js`:

```js
import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';

const col = () => getDb().collection('projects');

export const DEFAULT_PROJECT_TITLE = 'Screenplay';
const MAX_TITLE_LEN = 120;

// Title rules: trimmed, non-empty, max 120 chars, must not contain '/'
// (titles are URL path segments: /p/<encodeURIComponent(title)>/...).
export function normalizeProjectTitle(title) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error('project title must be a non-empty string');
  if (t.length > MAX_TITLE_LEN) {
    throw new Error(`project title must be at most ${MAX_TITLE_LEN} characters`);
  }
  if (t.includes('/')) throw new Error('project title must not contain "/"');
  return t;
}

export async function createProject(title) {
  const t = normalizeProjectTitle(title);
  const title_lower = t.toLowerCase();
  // Helper-level duplicate check (tests/_fakeMongo.js does not enforce unique
  // indexes). The unique index on title_lower is the real-Mongo backstop for
  // races — a raced insertOne surfaces E11000 to the caller, same code path.
  const existing = await col().findOne({ title_lower });
  if (existing) {
    const err = new Error(`duplicate project title: ${t}`);
    err.code = 11000;
    throw err;
  }
  const doc = { _id: new ObjectId(), title: t, title_lower, created_at: new Date() };
  await col().insertOne(doc);
  logger.info(`mongo: project create id=${doc._id} title="${t}"`);
  return doc;
}

export async function listProjects() {
  return col().find({}).sort({ created_at: 1 }).toArray();
}

export async function getProjectByTitle(title) {
  const t = String(title ?? '').trim().toLowerCase();
  if (!t) return null;
  return col().findOne({ title_lower: t });
}

export async function getProjectById(id) {
  if (id instanceof ObjectId) return col().findOne({ _id: id });
  if (typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) {
    return col().findOne({ _id: new ObjectId(id) });
  }
  return null;
}

// Default project := the oldest project by created_at (post-migration there is
// exactly one). Lazily creates 'Screenplay' on a fresh database.
export async function getDefaultProject() {
  const oldest = await col().find({}).sort({ created_at: 1 }).limit(1).toArray();
  if (oldest.length) return oldest[0];
  try {
    return await createProject(DEFAULT_PROJECT_TITLE);
  } catch (e) {
    if (e?.code === 11000) {
      const p = await getProjectByTitle(DEFAULT_PROJECT_TITLE);
      if (p) return p;
    }
    throw e;
  }
}

// TRANSITIONAL: falsy projectId resolves to the default project so
// un-migrated callers stay green during the incremental sweep. Task 20
// (strict flip) changes this to THROW on falsy.
export async function resolveProjectId(projectId) {
  if (projectId) return String(projectId);
  return (await getDefaultProject())._id.toString();
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/projects.test.js` → all tests pass.

- [ ] **Step 5: Add the index** in `src/mongo/client.js` — index setup lives in `connectMongo` (the `characters` `name_lower` index at line 95 is the precedent). Insert directly after that line:

```js
  await db.collection('projects').createIndex({ title_lower: 1 }, { unique: true });
```

- [ ] **Step 6: Full suite + commit** — `npm test` → green. Then:

```
git add src/mongo/projects.js tests/projects.test.js src/mongo/client.js
git commit -m "✨ Add projects collection with default-project resolution"
```

### Task 2: Plots per-project (+ artworks / RAG / detach-path lockstep)

Files:
- Modify: `src/mongo/plots.js` (all 13 `_id: 'main'` occurrences: lines 101, 109, 112, 125, 129, 159, 244, 265, 443, 479, 582, 654, 669; every export gains `projectId`)
- Modify: `src/mongo/artworks.js` (lines 62-64 `loadPlot`, 82-94 `loadHost`, 98-117 `fetchArtwork`/`fetchHostMainImageId`, 130-137, 168-175, 199-204 the `{_id:'main'}` writes; public API gains `projectId` key)
- Modify: `src/rag/indexer.js` (lines 158-182 `indexBeat`: `getPlot()` read + `{_id:'main','beats._id':...}` stamp)
- Modify: `src/mongo/files.js` (lines 24-43 `detachImageFromCurrentOwner` beat branch)
- Modify: `src/mongo/attachments.js` (lines 304-323 detach beat branch; lines 362-387 `attachExistingAttachmentToBeat`)
- Modify: `src/mongo/client.js` (plots unique index, Step 8)
- Modify (mechanical sweep): call sites listed in Step 6
- Test: `tests/beats.test.js` (+ test sweep, Step 7)

**Reality check vs spec:** `files.js`/`attachments.js` do **not** literally query `{'beats._id': oid}` today — they detach via `pullBeatImage`/`pullBeatAttachment`, which used the `{_id:'main'}` singleton implicitly. The verify-after-locate guard is implemented by a new `findPlotByBeatId(beatId)` in `plots.js`: locate the containing plot by beat id, then scope the pull to that plot's `project_id`.

- [ ] **Step 1: Write failing tests** — in `tests/beats.test.js`, add `const Projects = await import('../src/mongo/projects.js');` after the `Plots` import, change the line-21 assertion in the first test from `expect(plot._id).toBe('main');` to:

```js
    const def = await Projects.getDefaultProject();
    expect(plot.project_id).toBe(def._id.toString());
```

and append a new describe block at the end of the file:

```js
describe('multi-project plots', () => {
  it('getPlot lazy-claims the legacy {_id:"main"} doc for the default project', async () => {
    await fakeDb.collection('plots').insertOne({
      _id: 'main',
      title: 'Legacy',
      synopsis: 's',
      beats: [],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    });
    const plot = await Plots.getPlot();
    expect(plot._id).toBe('main'); // claimed, not replaced
    expect(plot.title).toBe('Legacy');
    const def = await Projects.getDefaultProject();
    const stored = await fakeDb.collection('plots').findOne({ _id: 'main' });
    expect(stored.project_id).toBe(def._id.toString());
    expect(fakeDb.collection('plots')._docs).toHaveLength(1); // no second doc
  });

  it('keeps two projects\' plots independent', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const beat = await Plots.createBeat({ projectId: p1, name: 'Open', desc: 'd1' });
    expect(await Plots.listBeats(p1)).toHaveLength(1);
    expect(await Plots.listBeats(p2)).toHaveLength(0);
    // Cross-project id lookup behaves as not-found.
    expect(await Plots.getBeat(p2, beat._id.toString())).toBe(null);
    // Writes land in the right doc.
    await Plots.updatePlot(p2, { synopsis: 'beta synopsis' });
    expect((await Plots.getPlot(p1)).synopsis).toBe('');
    expect((await Plots.getPlot(p2)).synopsis).toBe('beta synopsis');
  });

  it('findPlotByBeatId locates the containing plot across projects', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const beat = await Plots.createBeat({ projectId: p1, name: 'Open', desc: 'd' });
    const host = await Plots.findPlotByBeatId(beat._id.toString());
    expect(host.project_id).toBe(p1);
    expect(await Plots.findPlotByBeatId(new ObjectId().toString())).toBe(null);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/beats.test.js` → the new tests fail, e.g. `expected undefined to be '66…'` (no `project_id` stamped) and `expected [ { … } ] to have a length of +0 but got 1` (`listBeats(p2)` ignores its argument today).

- [ ] **Step 3: Rework `src/mongo/plots.js`.** Add the import `import { resolveProjectId, getDefaultProject } from './projects.js';`. New `getPlot` (replaces lines 108-132):

```js
export async function getPlot(projectId) {
  projectId = await resolveProjectId(projectId);
  let existing = await col().findOne({ project_id: projectId });
  if (!existing) {
    // Lazy-claim: adopt the pre-multi-project singleton {_id:'main'} for the
    // default project the first time it is read post-upgrade.
    const defaultId = (await getDefaultProject())._id.toString();
    if (projectId === defaultId) {
      const legacy = await col().findOne({ _id: 'main', project_id: { $exists: false } });
      if (legacy) {
        await col().updateOne({ _id: 'main' }, { $set: { project_id: projectId } });
        existing = { ...legacy, project_id: projectId };
        logger.info('mongo: plot lazy-claimed legacy {_id:"main"} doc for default project');
      }
    }
  }
  if (!existing) {
    existing = {
      _id: new ObjectId(),
      project_id: projectId,
      title: '',
      synopsis: '',
      beats: [],
      notes: '',
      current_beat_id: null,
      updated_at: new Date(),
    };
    await col().insertOne(existing);
    return existing;
  }
  if (existing.current_beat_id === undefined) {
    existing.current_beat_id = null;
    await col().updateOne({ _id: existing._id }, { $set: { current_beat_id: null } });
  }
  if (existing.title === undefined) {
    existing.title = '';
    await col().updateOne({ _id: existing._id }, { $set: { title: '' } });
  }
  return ensureBeatIds(existing);
}
```

`ensureBeatIds`' write (line 100-103) targets the doc it was handed — `{ _id: 'main' }` → `{ _id: plot._id }`. The two internal write helpers gain `projectId`:

```js
async function updateBeatFields(projectId, beatOid, set = {}, opts = {}) {
  // ... unchanged body, but the filter becomes:
  const result = await col().updateOne(
    { project_id: projectId, 'beats._id': beatOid },
    update,
  );
```

```js
async function persistBeatsFullArray(projectId, beats, extraSet = {}) {
  const result = await col().updateOne(
    { project_id: projectId },
    { $set: { beats, updated_at: new Date(), ...extraSet } },
  );
  if (!result || result.matchedCount === 0) {
    const msg = `persistBeatsFullArray: plot doc {project_id: "${projectId}"} not found — write did not apply.`;
```

`fetchBeat(projectId, beatOid)` calls `getPlot(projectId)`. Add the new export:

```js
// Locate the plot containing a beat — ANY project. Beat ObjectIds are
// globally unique, so this is the verify-after-locate hook for callers that
// know a beat id but not its project (GridFS detach paths, RAG indexer).
export async function findPlotByBeatId(beatId) {
  const oid = beatId instanceof ObjectId ? beatId : maybeOid(String(beatId));
  if (!oid) return null;
  return col().findOne({ 'beats._id': oid });
}
```

**Uniform transformation for every other export** (this is an in-file mechanical sweep): first parameter `projectId` (except `createBeat`, which takes a `projectId` **key** in its existing options object), first statement `projectId = await resolveProjectId(projectId);`, every `await getPlot()` → `await getPlot(projectId)`, every remaining `{ _id: 'main' }` filter → `{ project_id: projectId }`, every `updateBeatFields(`/`persistBeatsFullArray(`/`fetchBeat(` call gains `projectId` as first arg, and error strings mentioning `{_id: "main"}` say `{project_id: "<id>"}` instead. Two real examples:

Before (lines 649-659):
```js
export async function setCurrentBeat(identifier) {
  const plot = await getPlot();
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  await col().updateOne(
    { _id: 'main' },
    { $set: { current_beat_id: beat._id, updated_at: new Date() } },
  );
```
After:
```js
export async function setCurrentBeat(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const plot = await getPlot(projectId);
  const beat = findBeat(plot, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  await col().updateOne(
    { project_id: projectId },
    { $set: { current_beat_id: beat._id, updated_at: new Date() } },
  );
```

Before (line 275): `export async function createBeat({ name, desc = '', body = '', characters = [], order } = {}) {`
After:
```js
export async function createBeat({ projectId, name, desc = '', body = '', characters = [], order } = {}) {
  projectId = await resolveProjectId(projectId);
  // ... unchanged until:
  const plot = await getPlot(projectId);
  // ... and the persist call:
  await persistBeatsFullArray(projectId, beats, extra);
```

Resulting export signatures (all internally resolve first): `getPlot(projectId)`, `updatePlot(projectId, patch)`, `listBeats(projectId)`, `getBeat(projectId, identifier)`, `searchBeats(projectId, query)`, `createBeat({projectId, name, desc, body, characters, order})`, `updateBeat(projectId, identifier, patch)`, `setBeatBody(projectId, identifier, body)`, `setBeatSceneBible(projectId, identifier, bible)`, `editBeatBody(projectId, identifier, edits)`, `editPlotField(projectId, field, edits)`, `appendBeatBody(projectId, identifier, content)`, `deleteBeat(projectId, identifier)`, `linkCharacterToBeat(projectId, identifier, characterName)`, `unlinkCharacterFromBeat(projectId, identifier, characterName)`, `unlinkCharacterFromAllBeats(projectId, characterName)`, `pushBeatImage(projectId, beatIdentifier, imageMeta, setAsMain)`, `setBeatMainImage(projectId, beatIdentifier, imageId)`, `replaceBeatImage(projectId, beatIdentifier, oldImageId, newImageMeta)`, `pullBeatImage(projectId, beatIdentifier, imageId)`, `pushBeatAttachment(projectId, beatIdentifier, attachmentMeta)`, `pullBeatAttachment(projectId, beatIdentifier, attachmentId)`, `setCurrentBeat(projectId, identifier)`, `getCurrentBeat(projectId)`, `clearCurrentBeat(projectId)` (this one must call `getPlot(projectId)` first since it previously wrote `{_id:'main'}` blind), `findPlotByBeatId(beatId)`.

In-file verification: `grep -n "'main'" src/mongo/plots.js` → **zero matches**.

- [ ] **Step 4: Lockstep duplicates.**

`src/mongo/artworks.js` — delete `loadPlot` (lines 62-64) and import `getPlot` from `./plots.js`. `loadHost` gains `projectId`:

```js
async function loadHost(projectId, hostType, hostId) {
  assertHostType(hostType);
  if (hostType === 'character') {
    const c = await loadCharacter(hostId); // scoped in Task 4
    if (!c) throw new Error(`Character not found: ${hostId}`);
    return { kind: 'character', doc: c, _id: c._id };
  }
  const plot = await getPlot(projectId);
  if (!plot) throw new Error('Plot doc not found');
  const beat = findBeatInPlot(plot, hostId);
  if (!beat) throw new Error(`Beat not found: ${hostId}`);
  return { kind: 'beat', plot, beat, _id: beat._id };
}
```

The three beat-branch writes (`pushArtwork` line 130-137, `setArtworkFields` line 168-175, `pullArtwork` line 199-204) and the two beat-branch re-reads (`fetchArtwork` line 104, `fetchHostMainImageId` line 114) replace `{ _id: 'main' }` / `loadPlot()` with the already-located plot's own id — example (`pushArtwork`):

```js
  await getDb().collection('plots').updateOne(
    { _id: host.plot._id },
    {
      $push: { 'beats.$[b].artworks': artwork },
      $set: { 'beats.$[b].updated_at': now, updated_at: now },
    },
    { arrayFilters: [{ 'b._id': host._id }] },
  );
```
and the re-reads become `const plot = await getDb().collection('plots').findOne({ _id: host.plot._id });`. All nine public functions take a single options object — each gains a `projectId` key passed to `loadHost`, e.g. before (line 235-241) → after:

```js
export async function appendDoneArtwork({
  projectId,
  hostType,
  hostId,
  resultImageId,
  name = '',
}) {
  const host = await loadHost(projectId, hostType, hostId);
```
Apply identically to `createPendingArtwork`, `patchArtwork`, `setArtworkStatus`, `setArtworkResult`, `undoArtworkEdit`, `removeArtwork`, `getArtwork`, `listArtworks`. Legacy callers (gateway, artwork jobs) omit the key and resolve to the default project — no sweep needed.
In-file verification: `grep -n "'main'" src/mongo/artworks.js` → zero matches.

`src/rag/indexer.js` `indexBeat` (lines 158-182) — locate by beat instead of reading the singleton. Replace `const plot = await getPlot();` with `const plot = await findPlotByBeatId(beatId);` (adjust the import from `../mongo/plots.js`), replace `const beat = (plot.beats || []).find(...)` with `const beat = (plot?.beats || []).find(...)`, and the stamp filter:

```js
      await getDb().collection('plots').updateOne(
        { _id: plot._id, 'beats._id': beat._id },
        { $set: { 'beats.$.rag_indexed_at': new Date() } },
      );
```

`src/mongo/files.js` `detachImageFromCurrentOwner` beat branch (lines 30-33) — verify-after-locate:

```js
    if (ownerType === 'beat') {
      const hostPlot = await findPlotByBeatId(ownerId);
      const res = await pullBeatImage(hostPlot?.project_id, ownerId, file._id);
      priorName = res?.beat?.name || null;
    }
```
(add `findPlotByBeatId` to the line-3 import from `./plots.js`). A missing/foreign host resolves to "Beat not found", which the existing catch swallows — same as stale metadata today.

`src/mongo/attachments.js` — same guard in `detachAttachmentFromCurrentOwner` (lines 310-313): `const hostPlot = await findPlotByBeatId(ownerId); const res = await pullBeatAttachment(hostPlot?.project_id, ownerId, file._id);` (extend the line-8 import). And `attachExistingAttachmentToBeat` (line 362) gains a `projectId` key threaded through:

```js
export async function attachExistingAttachmentToBeat({ projectId, beat, attachmentId, caption }) {
  // ...
  const beatDoc = await getBeat(projectId, beat);
  // ...
  await pushBeatAttachment(projectId, beatDoc._id.toString(), meta);
```

- [ ] **Step 5: Run the module tests** — `npx vitest run tests/beats.test.js` → the new multi-project tests pass (other suites are still red until the sweep).

- [ ] **Step 6: MECHANICAL SWEEP — src call sites.** Enumerate with:

```
grep -rn -E "(updatePlot|getBeat|searchBeats|updateBeat|setBeatBody|setBeatSceneBible|editBeatBody|editPlotField|appendBeatBody|deleteBeat|linkCharacterToBeat|unlinkCharacterFromBeat|unlinkCharacterFromAllBeats|pushBeatImage|setBeatMainImage|replaceBeatImage|pullBeatImage|pushBeatAttachment|pullBeatAttachment|setCurrentBeat)\(" src/ --include='*.js' | grep -v '^src/mongo/plots.js' | grep -v import | grep -v ' from '
```

Site list at planning time (file: lines) — `src/mongo/files.js: 31` and `src/mongo/attachments.js: 311,366,385` were already handled in Step 4 and are excluded here:

```
src/agent/entityLinks.js: 128
src/agent/handlers.js: 399,1146,1393,1654,1788,1804,1811,1820,1828,2007,2026,2388,2600,2630,2746,2775,3067
src/pdf/export.js: 588
src/web/artworkJobs.js: 45
src/web/dialogCritique.js: 66
src/web/dialogGenerate.js: 144
src/web/dialogRegenerate.js: 54
src/web/downloads.js: 140
src/web/entityRoutes.js: 465,467,483,527,589,877,910,931,956,970,1070,1106,1147,1222,1303,1328,1354,1990,2039,2177,2498,2522,2618,2667,2704,2772,3118,3236,3253,3428,3598,3663,3730,3753,3809,3832,4080,4118,4328,4359,4386,4425,4451,4502,4525,4572,4598,4638,4660,4783,4806,4823,4842,4879,4905,4951,4979
src/web/falVideoGenerate.js: 774
src/web/gateway.js: 239,345,346,347,388,389,394,419,430,566,596,712,720,728,736,744,975,1069,1093,1250,1501
src/web/roomRegistry.js: 272,282,533,560,735
src/web/sceneBibleAutofill.js: 111
src/web/storyboardGenerate.js: 328,452,518,609,1201,1223,1599,1625,1757
```

Uniform transformation — prepend `undefined, ` as the first argument (later phases replace it with the real project id). Two real examples:

`src/web/gateway.js:566` before/after:
```js
  const beat = await getBeat(identifier);
  const beat = await getBeat(undefined, identifier);
```
`src/agent/handlers.js:1811` before/after:
```js
    const updated = await Plots.linkCharacterToBeat(target._id.toString(), character);
    const updated = await Plots.linkCharacterToBeat(undefined, target._id.toString(), character);
```

Watch the multiline calls (first argument on its own line): `src/agent/handlers.js:2775`, `src/web/gateway.js:1093` — the `undefined,` goes on the line after the `(`. Zero-arg reads (`getPlot()`, `listBeats()`, `getCurrentBeat()`, `clearCurrentBeat()`) and `createBeat({...})` (object key) need **no** edit. Verification (single-line sites; expect **zero** output):

```
grep -rnP "\b(updatePlot|getBeat|searchBeats|updateBeat|setBeatBody|setBeatSceneBible|editBeatBody|editPlotField|appendBeatBody|deleteBeat|linkCharacterToBeat|unlinkCharacterFromBeat|unlinkCharacterFromAllBeats|pushBeatImage|setBeatMainImage|replaceBeatImage|pullBeatImage|pushBeatAttachment|pullBeatAttachment|setCurrentBeat)\(\s*(?=\S)(?!undefined|projectId|hostPlot)" src --include='*.js' | grep -v '^src/mongo/plots.js' | grep -v import | grep -v ' from '
```

- [ ] **Step 7: MECHANICAL SWEEP — tests.** Same transformation (prepend `undefined, `) in test files that call these helpers positionally on the real module. Enumerate:

```
grep -rln -E "(updatePlot|getBeat|searchBeats|updateBeat|setBeatBody|setBeatSceneBible|editBeatBody|editPlotField|appendBeatBody|deleteBeat|linkCharacterToBeat|unlinkCharacterFromBeat|unlinkCharacterFromAllBeats|pushBeatImage|setBeatMainImage|replaceBeatImage|pullBeatImage|pushBeatAttachment|pullBeatAttachment|setCurrentBeat)\(" tests/*.test.js | xargs grep -ln "mongo/plots.js"
```
(45 files at planning time; files that only mock `mongo/plots.js` via `vi.mock` need no edit — mocked functions ignore extra args.) Example, `tests/beats.test.js:76` before/after:
```js
    const byId = await Plots.getBeat(a._id.toString());
    const byId = await Plots.getBeat(undefined, a._id.toString());
```
Two known non-uniform sites:
  - `tests/dialog-context.test.js:30` writes `.updateOne({ _id: 'main' }, { $set: { dialogue_style: text } })` directly on the fake. The plot doc is no longer keyed `'main'` when created fresh — change the filter to `{}` (the collection holds exactly one plot doc in that test, and the fake's `updateOne` matches the first doc).
  - Tests that *seed* `{_id:'main'}` docs directly (`tests/plot-title.test.js:25`, `tests/owned-attachment-room.test.js:51,101,173`, `tests/owned-image-room.test.js:152`, `tests/beats.test.js:427,448`) stay green via the lazy-claim path — no edit.

Run `npm test`; fix any straggler with the same prepend rule until green.

- [ ] **Step 8: Plots unique index** in `src/mongo/client.js` — in `connectMongo`, directly after the `projects` index added in Task 1 Step 5:

```js
  await db.collection('plots').createIndex(
    { project_id: 1 },
    { unique: true, partialFilterExpression: { project_id: { $type: 'string' } } },
  );
```

One plot doc per project, enforced on real Mongo (the fake doesn't enforce unique indexes — `getPlot`'s find-before-insert is the test-suite path). The `partialFilterExpression` keeps the un-stamped legacy `{_id:'main'}` doc out of the index until the lazy claim / migration stamps it — a plain unique index would treat the missing `project_id` as a null key and collide pre-migration. (`tests/_fakeMongo.js`'s `createIndex` is a no-op — no test change.)

- [ ] **Step 9: Commit**

```
git add src/mongo/plots.js src/mongo/artworks.js src/rag/indexer.js src/mongo/files.js src/mongo/attachments.js src/mongo/client.js src/agent src/web src/pdf tests
git commit -m "✨ Scope plots and beat hosts per project"
```

### Task 3: Prompts + director notes composite ids, seed split, roomRegistry write-back

Files:
- Modify: `src/mongo/prompts.js` (whole file, 44 lines)
- Modify: `src/mongo/directorNotes.js` (doc id + all exports)
- Modify: `src/web/roomRegistry.js` (lines 414-420, the direct `updateOne({_id:'director_notes'})`)
- Modify: `src/seed/defaults.js` (split into `seedProjectDefaults(projectId)` + all-projects startup pass)
- Modify (sweep): directorNotes positional call sites (Step 5)
- Test: `tests/director-notes.test.js`, `tests/defaults.test.js`

Composite ids per conventions: `'<projectId>:character_template'`, `'<projectId>:plot_template'`, `'<projectId>:director_notes'`. **No lazy claim** — `scripts/migrate-multi-project.js` re-keys the legacy singletons (string `_id`s are immutable; insert-new + delete-old).

- [ ] **Step 1: Write failing tests.** In `tests/director-notes.test.js` add `const Projects = await import('../src/mongo/projects.js');` after the `Notes` import; change the first test's `expect(doc._id).toBe('director_notes');` to:

```js
    const def = await Projects.getDefaultProject();
    expect(doc._id).toBe(`${def._id.toString()}:director_notes`);
```
and append:

```js
describe('multi-project director notes', () => {
  it('keeps notes per project under composite _ids', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    await Notes.addDirectorNote({ projectId: p1, text: 'alpha note' });
    const d1 = await Notes.getDirectorNotes(p1);
    const d2 = await Notes.getDirectorNotes(p2);
    expect(d1._id).toBe(`${p1}:director_notes`);
    expect(d1.notes.map((n) => n.text)).toEqual(['alpha note']);
    expect(d2.notes).toEqual([]);
  });

  it('writeDirectorNotesArray persists into the project-keyed doc', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const note = await Notes.addDirectorNote({ projectId: p1, text: 'before' });
    await Notes.writeDirectorNotesArray(p1, [{ ...note, text: 'after' }]);
    const d1 = await Notes.getDirectorNotes(p1);
    expect(d1.notes[0].text).toBe('after');
  });
});
```

In `tests/defaults.test.js` add `const Projects = await import('../src/mongo/projects.js');` and append:

```js
describe('seedProjectDefaults', () => {
  it('seeds templates and an empty plot doc for every project on startup', async () => {
    const p2 = (await Projects.createProject('Second'))._id.toString();
    await seedDefaults();
    const { getCharacterTemplate, getPlotTemplate } = await import('../src/mongo/prompts.js');
    expect(await getCharacterTemplate(p2)).toBeTruthy();
    expect(await getPlotTemplate(p2)).toBeTruthy();
    const plot = await fakeDb.collection('plots').findOne({ project_id: p2 });
    expect(plot).toBeTruthy();
    expect(plot.beats).toEqual([]);
  });
});
```
(`seedDefaults` import stays; also extend the existing destructured prompts import if preferred.)

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/director-notes.test.js tests/defaults.test.js` → `expected 'director_notes' to be '66…:director_notes'` and the seed test fails because `getCharacterTemplate(p2)` (old zero-arg signature) reads the global `'character_template'` doc / plot doc for p2 is missing.

- [ ] **Step 3: Rewrite `src/mongo/prompts.js`** (complete file):

```js
import { getDb } from './client.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('prompts');

// Composite per-project doc ids: '<projectId>:character_template' etc.
// No lazy claim of the legacy singleton ids — scripts/migrate-multi-project.js
// re-keys them (insert-new + delete-old; string _ids are immutable).
export function promptDocId(projectId, name) {
  return `${projectId}:${name}`;
}

export async function getCharacterTemplate(projectId) {
  projectId = await resolveProjectId(projectId);
  return col().findOne({ _id: promptDocId(projectId, 'character_template') });
}

export async function setCharacterTemplate(projectId, doc) {
  projectId = await resolveProjectId(projectId);
  await col().updateOne(
    { _id: promptDocId(projectId, 'character_template') },
    { $set: { ...doc, project_id: projectId, updated_at: new Date() } },
    { upsert: true },
  );
  return getCharacterTemplate(projectId);
}

export async function updateCharacterTemplateFields({ projectId, add = [], remove = [] }) {
  projectId = await resolveProjectId(projectId);
  const tpl = await getCharacterTemplate(projectId);
  let fields = tpl?.fields ? [...tpl.fields] : [];
  for (const name of remove) {
    const target = fields.find((f) => f.name === name);
    if (target?.core) throw new Error(`Cannot remove core field: ${name}`);
    fields = fields.filter((f) => f.name !== name);
  }
  for (const f of add) {
    if (fields.some((x) => x.name === f.name)) continue;
    fields.push({ name: f.name, description: f.description, required: !!f.required, core: false });
  }
  return setCharacterTemplate(projectId, { fields });
}

export async function getPlotTemplate(projectId) {
  projectId = await resolveProjectId(projectId);
  return col().findOne({ _id: promptDocId(projectId, 'plot_template') });
}

export async function setPlotTemplate(projectId, doc) {
  projectId = await resolveProjectId(projectId);
  await col().updateOne(
    { _id: promptDocId(projectId, 'plot_template') },
    { $set: { ...doc, project_id: projectId, updated_at: new Date() } },
    { upsert: true },
  );
  return getPlotTemplate(projectId);
}
```
Caller check: `src/agent/handlers.js:1405` calls `Prompts.updateCharacterTemplateFields({ add, remove })` (object arg, stays green); all `getCharacterTemplate()`/`getPlotTemplate()` callers are zero-arg (stay green). `setCharacterTemplate`/`setPlotTemplate` have positional callers in `src/seed/defaults.js` (rewritten in Step 4) **and three test fixtures** that pass the template doc as the first argument — `tests/set-field-handler.test.js:22`, `tests/edit-handler.test.js:23`, `tests/handlers-large-body.test.js:21`. Prepend `undefined, ` at each. Two real before/after examples — `tests/set-field-handler.test.js:22`:
```js
  await Prompts.setCharacterTemplate({
  await Prompts.setCharacterTemplate(undefined, {
```
and `tests/handlers-large-body.test.js:21`:
```js
  await Prompts.setCharacterTemplate({
  await Prompts.setCharacterTemplate(undefined, {
```
(all three sites have this same multiline-object shape — the `undefined, ` goes before the `{` on the call line). Verification (expect zero output):
```
grep -rnP "\b(setCharacterTemplate|setPlotTemplate)\(\s*(?=\S)(?!undefined|projectId)" src tests --include='*.js' | grep -v '^src/mongo/prompts.js' | grep -v import | grep -v ' from '
```

- [ ] **Step 4: Rework `src/mongo/directorNotes.js` + seed + roomRegistry.**

directorNotes: add `import { resolveProjectId } from './projects.js';`, replace `const DOC_ID = 'director_notes';` with `const docId = (projectId) => `${projectId}:director_notes`;`, and:

```js
export async function getDirectorNotes(projectId) {
  projectId = await resolveProjectId(projectId);
  const doc = await col().findOne({ _id: docId(projectId) });
  if (!doc) return { _id: docId(projectId), project_id: projectId, notes: [] };
  const notes = (Array.isArray(doc.notes) ? doc.notes : []).map(backfillNote);
  return { ...doc, notes };
}

async function writeNotes(projectId, notes) {
  await col().updateOne(
    { _id: docId(projectId) },
    { $set: { notes, project_id: projectId, updated_at: new Date() } },
    { upsert: true },
  );
  return getDirectorNotes(projectId);
}

// For the y-doc persist write-back in src/web/roomRegistry.js, which
// previously wrote updateOne({_id:'director_notes'}) directly.
export async function writeDirectorNotesArray(projectId, notes) {
  projectId = await resolveProjectId(projectId);
  return writeNotes(projectId, notes);
}
```

Uniform transformation for the remaining exports — object-arg helpers gain a `projectId` key, positional helpers gain a `projectId` first param; each resolves once, then threads into `getDirectorNotes(projectId)` / `writeNotes(projectId, …)`. Two real examples:

Before (line 42) / after:
```js
export async function addDirectorNote({ text, position } = {}) {
export async function addDirectorNote({ projectId, text, position } = {}) {
  projectId = await resolveProjectId(projectId);
  // ... const current = await getDirectorNotes(projectId);
  // ... await writeNotes(projectId, notes);
```
Before (line 137) / after:
```js
export async function pullDirectorNoteImage(noteId, imageId) {
export async function pullDirectorNoteImage(projectId, noteId, imageId) {
  projectId = await resolveProjectId(projectId);
  const current = await getDirectorNotes(projectId);
  // ... await writeNotes(projectId, notes);
```
Resulting signatures: `getDirectorNotes(projectId)`, `addDirectorNote({projectId, text, position})`, `editDirectorNote({projectId, noteId, text})`, `removeDirectorNote({projectId, noteId})`, `reorderDirectorNotes({projectId, noteIds})`, `pushDirectorNoteImage(projectId, noteId, imageMeta, setAsMain)`, `pullDirectorNoteImage(projectId, noteId, imageId)`, `setDirectorNoteMainImage(projectId, noteId, imageId)`, `pushDirectorNoteAttachment(projectId, noteId, attachmentMeta)`, `pullDirectorNoteAttachment(projectId, noteId, attachmentId)`, `writeDirectorNotesArray(projectId, notes)`. `getDirectorNote(notes, noteId)` is pure and unchanged.

`src/web/roomRegistry.js` lines 414-420 — replace the raw write inside `describeNotesRoom().persistFields`:

Before:
```js
      if (!changed) return { changed: false };
      await col.updateOne(
        { _id: 'director_notes' },
        { $set: { notes: nextNotes, updated_at: new Date() } },
      );
```
After (add `writeDirectorNotesArray` to the line-24 import from `'../mongo/directorNotes.js'`; the `const col = getDb().collection('prompts');` at the top of `persistFields` becomes unused — delete it):
```js
      if (!changed) return { changed: false };
      await writeDirectorNotesArray(undefined, nextNotes);
```
(`undefined` → default project until the rooms phase threads the parsed room project id.)

`src/seed/defaults.js` — replace `seedDefaults` (lines 28-47) with the split (imports gain `getPlot` from `../mongo/plots.js` and `getDefaultProject, listProjects` from `../mongo/projects.js`):

```js
// Seed one project's defaults: clone the default character/plot templates and
// create the project's empty plot doc. Called at project creation (POST
// /api/projects) and for every project during the startup pass below.
export async function seedProjectDefaults(projectId) {
  const existing = await getCharacterTemplate(projectId);
  if (!existing) {
    await setCharacterTemplate(projectId, { fields: DEFAULT_CHARACTER_FIELDS });
  } else {
    const optionalDefaults = DEFAULT_CHARACTER_FIELDS.filter((f) => !f.core);
    if (optionalDefaults.length) {
      await updateCharacterTemplateFields({ projectId, add: optionalDefaults });
    }
    const currentFields = existing.fields || [];
    const hasRetired = currentFields.some((f) => RETIRED_CORE_FIELDS.includes(f.name));
    if (hasRetired) {
      const trimmed = currentFields.filter((f) => !RETIRED_CORE_FIELDS.includes(f.name));
      await setCharacterTemplate(projectId, { fields: trimmed });
    }
  }
  if (!(await getPlotTemplate(projectId))) {
    await setPlotTemplate(projectId, DEFAULT_PLOT_TEMPLATE);
  }
  await getPlot(projectId); // lazily creates (or claims) the plot doc
}

// Startup pass: guarantee the default project exists, then backfill/retire
// fields for EVERY project (today's behavior, per project).
export async function seedDefaults() {
  await getDefaultProject();
  const projects = await listProjects();
  for (const p of projects) {
    await seedProjectDefaults(p._id.toString());
  }
}
```
`src/index.js:22` (`await seedDefaults();`) needs no change.

- [ ] **Step 5: MECHANICAL SWEEP — directorNotes positional call sites.** Enumerate:

```
grep -rn -E "(pushDirectorNoteImage|pullDirectorNoteImage|setDirectorNoteMainImage|pushDirectorNoteAttachment|pullDirectorNoteAttachment)\(" src/ --include='*.js' | grep -v '^src/mongo/directorNotes.js' | grep -v import | grep -v ' from '
```
Site list at planning time:
```
src/agent/handlers.js: 1491,1524,1532,1569,1597,1625,2614,2633
src/mongo/attachments.js: 317,413
src/mongo/files.js: 37
src/web/gateway.js: 1181,1279,1293,1302,1311,1320,1329
```
Uniform transformation: prepend `undefined, `. Example, `src/web/gateway.js:1311` before/after:
```js
  const result = await setDirectorNoteMainImage(String(noteId), imageId);
  const result = await setDirectorNoteMainImage(undefined, String(noteId), imageId);
```
(The detach branches in `files.js:37` / `attachments.js:317` also take `undefined` — director notes can't be located by note id alone yet; Task 20's pre-flip threading replaces these with the owning file's `file.metadata.project_id`.) Verification (expect zero output):
```
grep -rnP "\b(pushDirectorNoteImage|pullDirectorNoteImage|setDirectorNoteMainImage|pushDirectorNoteAttachment|pullDirectorNoteAttachment)\(\s*(?=\S)(?!undefined|projectId)" src --include='*.js' | grep -v '^src/mongo/directorNotes.js' | grep -v import | grep -v ' from '
```
Object-arg callers of `addDirectorNote`/`editDirectorNote`/`removeDirectorNote`/`reorderDirectorNotes` and all `getDirectorNotes()` zero-arg reads (30 sites) need **no** edit.

- [ ] **Step 6: Fix legacy-id fixtures in tests.** `tests/defaults.test.js` inserts `{_id: 'character_template'}` directly (line ~46 and in the retired-fields tests further down). Composite-id transformation for every such insert — example:

Before:
```js
    await fakeDb.collection('prompts').insertOne({
      _id: 'character_template',
```
After:
```js
    const def = await Projects.getDefaultProject();
    await fakeDb.collection('prompts').insertOne({
      _id: `${def._id.toString()}:character_template`,
```
Verification: `grep -n "_id: 'character_template'\|_id: 'plot_template'\|_id: 'director_notes'" tests/defaults.test.js tests/director-notes.test.js tests/director-notes-attachments.test.js` → zero matches. (`tests/director-notes-attachments.test.js` exercises attach flows through object-arg helpers — update any direct positional calls with the Step 5 prepend rule.)

- [ ] **Step 7: Run, expect PASS** — `npx vitest run tests/director-notes.test.js tests/defaults.test.js tests/director-notes-attachments.test.js` → pass; then `npm test` → green (fix stragglers with the Step 5 rule).

- [ ] **Step 8: Commit**

```
git add src/mongo/prompts.js src/mongo/directorNotes.js src/web/roomRegistry.js src/seed/defaults.js src/agent/handlers.js src/mongo/files.js src/mongo/attachments.js src/web/gateway.js tests
git commit -m "✨ Key prompts and director notes per project"
```

### Task 4: Characters scoped per project + compound name index

Files:
- Modify: `src/mongo/characters.js` (lines 12-54 list/get; line 56 create; uniform first-param on all other exports)
- Modify: `src/mongo/client.js` (line 95 index swap)
- Modify: `src/mongo/artworks.js` (lines 51-60 `loadCharacter`, line 86 `loadHost` character branch)
- Modify: `src/web/storyboardGenerate.js` (line 730 `findCharactersInBeat`)
- Modify: `src/mongo/files.js`, `src/mongo/attachments.js` (character attach/detach helpers gain `projectId`)
- Modify (sweep): call sites in Step 6
- Create: `tests/characters-projects.test.js`

- [ ] **Step 1: Write the failing test** — create `tests/characters-projects.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Characters = await import('../src/mongo/characters.js');
const Projects = await import('../src/mongo/projects.js');

let p1;
let p2;

beforeEach(async () => {
  fakeDb.reset();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
  p2 = (await Projects.createProject('Beta'))._id.toString();
});

describe('multi-project characters', () => {
  it('the same name resolves independently per project', async () => {
    const a = await Characters.createCharacter({ projectId: p1, name: 'Steve' });
    const b = await Characters.createCharacter({ projectId: p2, name: 'Steve' });
    expect(a.project_id).toBe(p1);
    expect(b.project_id).toBe(p2);
    const got1 = await Characters.getCharacter(p1, 'steve');
    const got2 = await Characters.getCharacter(p2, 'steve');
    expect(got1._id.toString()).toBe(a._id.toString());
    expect(got2._id.toString()).toBe(b._id.toString());
  });

  it('id lookup verifies project_id — mismatch is not-found', async () => {
    const a = await Characters.createCharacter({ projectId: p1, name: 'Steve' });
    expect(await Characters.getCharacter(p2, a._id.toString())).toBe(null);
    expect((await Characters.getCharacter(p1, a._id.toString()))._id.toString()).toBe(
      a._id.toString(),
    );
  });

  it('listCharacters / findAllCharacters / searchCharacters are scoped', async () => {
    await Characters.createCharacter({ projectId: p1, name: 'Steve' });
    await Characters.createCharacter({ projectId: p2, name: 'Wendy' });
    expect((await Characters.listCharacters(p1)).map((c) => c.name)).toEqual(['Steve']);
    expect((await Characters.findAllCharacters(p2)).map((c) => c.name)).toEqual(['Wendy']);
    expect(await Characters.searchCharacters(p1, 'wendy')).toEqual([]);
    expect((await Characters.searchCharacters(p2, 'wendy'))[0].name).toBe('Wendy');
  });

  it('the stripMarkdown fallback scan stays inside the project', async () => {
    await Characters.createCharacter({ projectId: p1, name: '**Bold Bob**' });
    await Characters.createCharacter({ projectId: p2, name: '**Bold Bob**' });
    // Corrupt p1's name_lower so the direct lookup misses and the scan runs.
    await fakeDb.collection('characters').updateOne(
      { project_id: p1 },
      { $set: { name_lower: '**bold bob**' } },
    );
    const found = await Characters.getCharacter(p1, 'Bold Bob');
    expect(found.project_id).toBe(p1);
  });

  it('legacy docs without project_id are visible (lenient until migration)', async () => {
    await fakeDb.collection('characters').insertOne({
      name: 'Legacy', name_lower: 'legacy', fields: {},
      created_at: new Date(), updated_at: new Date(),
    });
    expect(await Characters.getCharacter(p1, 'legacy')).toBeTruthy();
    expect((await Characters.listCharacters(p1)).map((c) => c.name)).toContain('Legacy');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/characters-projects.test.js` → e.g. `expected null to be truthy` / `expected undefined to be '66…'` (old signatures treat the project id as the identifier and don't stamp `project_id`).

- [ ] **Step 3: Implement `src/mongo/characters.js`.** Add `import { resolveProjectId } from './projects.js';` and a lenient membership helper (lenient toward unstamped legacy docs; strictness arrives with the migration):

```js
function inProject(doc, projectId) {
  return !doc.project_id || doc.project_id === projectId;
}
```
Replace the read helpers:

```js
export async function listCharacters(projectId) {
  projectId = await resolveProjectId(projectId);
  const all = await col()
    .find({}, { projection: { name: 1, hollywood_actor: 1, main_image_id: 1, project_id: 1 } })
    .sort({ name: 1 })
    .toArray();
  return all.filter((c) => inProject(c, projectId));
}

export async function findAllCharacters(projectId) {
  projectId = await resolveProjectId(projectId);
  const all = await col().find({}).sort({ name: 1 }).toArray();
  return all.filter((c) => inProject(c, projectId));
}

export async function getCharacter(projectId, identifier) {
  projectId = await resolveProjectId(projectId);
  const c = col();
  const id = maybeId(identifier);
  if (id) {
    const byId = await c.findOne({ _id: id });
    // Locate by globally-unique id, then VERIFY project — a stale id from
    // another project's chat history must fail as not-found, not leak.
    if (byId && inProject(byId, projectId)) return backfillSheetIds(byId);
    if (byId) return null;
  }
  const lc = String(identifier).toLowerCase();
  const direct = await c.findOne({ project_id: projectId, name_lower: lc });
  if (direct) return backfillSheetIds(direct);
  const legacy = await c.findOne({ name_lower: lc, project_id: { $exists: false } });
  if (legacy) return backfillSheetIds(legacy);
  // stripMarkdown fallback scan — same as before, but project-scoped.
  const stripped = stripMarkdown(String(identifier)).toLowerCase();
  if (!stripped) return null;
  const all = await c.find({}).toArray();
  const match = all.find(
    (d) => inProject(d, projectId) && stripMarkdown(d.name || '').toLowerCase() === stripped,
  );
  return match ? backfillSheetIds(match) : null;
}
```
`createCharacter` gains a `projectId` key and stamps:

```js
export async function createCharacter({ projectId, name, hollywood_actor, fields = {} }) {
  projectId = await resolveProjectId(projectId);
  const now = new Date();
  const doc = {
    project_id: projectId,
    name,
    name_lower: stripMarkdown(name).toLowerCase(),
    hollywood_actor: hollywood_actor || null,
    fields,
    created_at: now,
    updated_at: now,
  };
```
(rest unchanged). `searchCharacters(projectId, query)` resolves and changes its scan line to `const all = (await col().find({}).toArray()).filter((c) => inProject(c, projectId));`. **Uniform transformation** for the remaining exports (`updateCharacter`, `deleteCharacter`, `pushCharacterImage`, `replaceCharacterImage`, `pullCharacterImage`, `pushCharacterAttachment`, `pushCharacterArtwork`, `replaceCharacterArtwork`, `pullCharacterArtwork`, `pullCharacterAttachment`): gain `projectId` first param, resolve, and thread into the internal `getCharacter(projectId, identifier)` lookup (their writes stay keyed on `c._id`). Two real examples:

Before (line 71) / after:
```js
export async function updateCharacter(identifier, patch) {
export async function updateCharacter(projectId, identifier, patch) {
  projectId = await resolveProjectId(projectId);
  // ... const existing = await getCharacter(projectId, identifier);
  // ... return getCharacter(projectId, existing._id.toString());
```
Before (line 281) / after:
```js
export async function pullCharacterImage(identifier, imageId) {
export async function pullCharacterImage(projectId, identifier, imageId) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, identifier);
```

- [ ] **Step 4: Index swap in `src/mongo/client.js`** (line 95). Before/after:

```js
  await db.collection('characters').createIndex({ name_lower: 1 }, { unique: true });
  await db.collection('characters').createIndex({ project_id: 1, name_lower: 1 }, { unique: true });
```
Note for the migration task: `createIndex` cannot drop the legacy `{name_lower:1}` unique index — `scripts/migrate-multi-project.js` step 5 must `dropIndex` it, otherwise same-named characters across projects E11000 on real Mongo (the fake doesn't enforce this; covered by a helper-level test only).

- [ ] **Step 5: Companion modules.**

`src/mongo/artworks.js` — replace `loadCharacter` (lines 51-60) with the scoped helper and thread `loadHost`'s existing `projectId` (from Task 2):

```js
import { getCharacter } from './characters.js';
// ...
async function loadHost(projectId, hostType, hostId) {
  assertHostType(hostType);
  if (hostType === 'character') {
    const c = await getCharacter(projectId, String(hostId));
    if (!c) throw new Error(`Character not found: ${hostId}`);
    return { kind: 'character', doc: c, _id: c._id };
  }
```
(delete the local `loadCharacter` function entirely).

`src/web/storyboardGenerate.js` line 730 — `export async function findCharactersInBeat(projectId, beat) {` with the inner lookup `const c = await getCharacter(projectId, stripped);`. Its callers get the prepend: internal `src/web/storyboardGenerate.js:592,1138` and `src/web/entityRoutes.js:485,529,2254,4430,4464` become `findCharactersInBeat(undefined, beat)` (entityRoutes:4458 passes the function by reference into a helper — check that helper's invocation inside `storyboardGenerate.js` is covered by the line-592/1138 edits).

`src/mongo/files.js` — the character helpers gain `projectId` (object key on object-arg fns, first param on positional ones) and thread it: `attachImageToCharacter({projectId, character, sourceUrl, filename, caption, setAsMain})`, `attachExistingImageToCharacter({projectId, character, imageId, caption, setAsMain})`, `listCharacterImages(projectId, character)`, `setMainCharacterImage({projectId, character, imageId})`, `removeCharacterImage({projectId, character, imageId})` — each replaces `await getCharacter(character)` with `await getCharacter(projectId, character)` and `pushCharacterImage(c._id.toString(), meta, setAsMain)` with `pushCharacterImage(projectId, c._id.toString(), meta, setAsMain)`. The detach branch (line 34) becomes `await pullCharacterImage(undefined, ownerId, file._id)` (character `_id`s are globally unique; real threading arrives in Task 20's pre-flip threading via `file.metadata.project_id`).

`src/mongo/attachments.js` — same pattern: `attachToCharacter({projectId, character, ...})`, `attachExistingAttachmentToCharacter({projectId, character, attachmentId, caption})`, `listCharacterAttachments(projectId, character)`, `removeCharacterAttachment({projectId, character, attachmentId})` thread `getCharacter(projectId, character)`; detach branch (line 314) → `pullCharacterAttachment(undefined, ownerId, file._id)`. (The module-local `pushCharacterAttachment(characterId, meta)` at line 269 writes by `_id` directly — unchanged.)

`src/rag/indexer.js:186` → `const c = await getCharacter(undefined, idStr(characterId));`.

- [ ] **Step 6: MECHANICAL SWEEP — remaining call sites.** Enumerate:

```
grep -rn -E "(getCharacter|searchCharacters|updateCharacter|deleteCharacter|pushCharacterImage|replaceCharacterImage|pullCharacterImage|pushCharacterAttachment|pushCharacterArtwork|replaceCharacterArtwork|pullCharacterArtwork|pullCharacterAttachment)\(" src/ --include='*.js' | grep -v '^src/mongo/characters.js' | grep -v import | grep -v ' from ' | grep -v getCharacterTemplate
```
Site list at planning time (`files.js`/`attachments.js`/`rag/indexer.js`/`artworks.js`/`storyboardGenerate.js:736` handled in Step 5):
```
src/agent/entityLinks.js: 135
src/agent/handlers.js: 362,932,1048,1133,1311,1369,1379,1391,1394,1761,2040,2285,2370,2483,2506,2582,3049,3107,3155
src/pdf/export.js: 567,607
src/web/artworkJobs.js: 53
src/web/downloads.js: 161
src/web/entityRoutes.js: 614,637,1391,1424,1448,1473,1487,1582,1616,1658,1733,1817,1842,1868,1996,2045,2183,2247
src/web/gateway.js: 262,407,410,620,654,676,752,754,762,772,782,784,961,963,988,991,1111,1137,1216,1263,1266,1989
src/web/roomRegistry.js: 300,366
src/web/storyboardReferenceAggregator.js: 58
```
Uniform transformation: prepend `undefined, `. Two real examples — `src/web/gateway.js:262` and `src/pdf/export.js:567`:
```js
    const c = await getCharacter(entityId);
    const c = await getCharacter(undefined, entityId);
```
```js
    const resolved = await Promise.all(charNames.map((n) => getCharacter(n)));
    const resolved = await Promise.all(charNames.map((n) => getCharacter(undefined, n)));
```
Multiline call sites (first arg on its own line): `src/agent/handlers.js:2370,2582`, `src/web/gateway.js:1137`. Zero-arg `listCharacters()` / `findAllCharacters()` reads and `createCharacter({...})` object calls need no edit. Verification (expect zero output):
```
grep -rnP "\b(getCharacter|searchCharacters|updateCharacter|deleteCharacter|pushCharacterImage|replaceCharacterImage|pullCharacterImage|pushCharacterAttachment|pushCharacterArtwork|replaceCharacterArtwork|pullCharacterArtwork|pullCharacterAttachment)\(\s*(?=\S)(?!undefined|projectId)" src --include='*.js' | grep -v '^src/mongo/characters.js' | grep -v import | grep -v ' from ' | grep -v getCharacterTemplate
```
Then sweep tests the same way — candidates: `grep -rln -E "(getCharacter|searchCharacters|updateCharacter|deleteCharacter|pushCharacter|pullCharacter|replaceCharacter)\(" tests/*.test.js | xargs grep -ln "mongo/characters.js"` (20 files at planning time; only direct positional calls on the real module need the prepend — `createCharacter({...})` fixtures need no edit and keep working unstamped via the lenient filter).

- [ ] **Step 7: Run, expect PASS** — `npx vitest run tests/characters-projects.test.js` → pass; `npm test` → green.

- [ ] **Step 8: Commit**

```
git add src/mongo/characters.js src/mongo/client.js src/mongo/artworks.js src/mongo/files.js src/mongo/attachments.js src/rag/indexer.js src/agent src/web src/pdf tests
git commit -m "✨ Scope characters per project with compound name index"
```

### Task 5: Messages — stamp `project_id`, project filter on search

Files:
- Modify: `src/mongo/messages.js` (lines 30, 60, 104, 285-294; `loadHistoryForLlm` lines 344-369 **unchanged**)
- Create: `tests/messages-projects.test.js`

All four touched helpers already take a single options object → they gain a `projectId` **key** (no caller sweep; `src/discord/messageHandler.js:145-235` and `src/agent/handlers.js:3248` stay as-is until the agent-loop phase threads `context.projectId`).

- [ ] **Step 1: Write the failing test** — create `tests/messages-projects.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Messages = await import('../src/mongo/messages.js');
const Projects = await import('../src/mongo/projects.js');

const CHANNEL = 'chan-1';

function fakeMsg() {
  return {
    channelId: CHANNEL,
    guildId: null,
    thread: null,
    id: 'discord-1',
    author: { id: 'u1', tag: 'steve#1', bot: false },
    createdAt: new Date(),
  };
}

beforeEach(() => fakeDb.reset());

describe('message project stamping', () => {
  it('recordUserMessage stamps project_id (default project when omitted)', async () => {
    await Messages.recordUserMessage({ msg: fakeMsg(), text: 'hi', attachments: [] });
    const doc = await fakeDb.collection('messages').findOne({ role: 'user' });
    const def = await Projects.getDefaultProject();
    expect(doc.project_id).toBe(def._id.toString());
  });

  it('recordAssistantMessage and recordAgentTurns stamp an explicit projectId', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    await Messages.recordAssistantMessage({ projectId: p1, channelId: CHANNEL, text: 'yo' });
    await Messages.recordAgentTurns({
      projectId: p1,
      channelId: CHANNEL,
      turns: [{ role: 'assistant', content: 'turn' }],
    });
    const docs = await fakeDb.collection('messages').find({}).toArray();
    expect(docs).toHaveLength(2);
    for (const d of docs) expect(d.project_id).toBe(p1);
  });

  it('searchMessages filters by project only when projectId is passed', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    await Messages.recordAssistantMessage({ projectId: p1, channelId: CHANNEL, text: 'needle one' });
    await Messages.recordAssistantMessage({ projectId: p2, channelId: CHANNEL, text: 'needle two' });
    const all = await Messages.searchMessages({
      channelId: CHANNEL, regex: /needle/i, limit: 10, contextChars: 40,
    });
    expect(all.results).toHaveLength(2);
    const scoped = await Messages.searchMessages({
      projectId: p1, channelId: CHANNEL, regex: /needle/i, limit: 10, contextChars: 40,
    });
    expect(scoped.results).toHaveLength(1);
    expect(scoped.results[0].excerpt).toMatch(/needle one/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/messages-projects.test.js` → `expected undefined to be '66…'` (no stamping yet) and the scoped search returns 2 results.

- [ ] **Step 3: Implement in `src/mongo/messages.js`.** Add `import { resolveProjectId } from './projects.js';`. The three recorders gain `projectId` and stamp the resolved value — exact diffs:

Line 30 before/after (and add the stamp as the first doc field):
```js
export async function recordUserMessage({ msg, text, attachments, displayName = null }) {
export async function recordUserMessage({ projectId, msg, text, attachments, displayName = null }) {
  const project_id = await resolveProjectId(projectId);
  const doc = {
    project_id,
    channel_id: msg.channelId,
```
Line 60:
```js
export async function recordAssistantMessage({ channelId, guildId = null, threadId = null, text }) {
export async function recordAssistantMessage({ projectId, channelId, guildId = null, threadId = null, text }) {
  const project_id = await resolveProjectId(projectId);
  const doc = {
    project_id,
    channel_id: channelId,
```
Line 104:
```js
export async function recordAgentTurns({ channelId, guildId = null, threadId = null, turns }) {
export async function recordAgentTurns({ projectId, channelId, guildId = null, threadId = null, turns }) {
  if (!turns || !turns.length) return;
  const project_id = await resolveProjectId(projectId);
  const now = Date.now();
  const docs = turns.map(({ role, content }, i) => ({
    project_id,
    channel_id: channelId,
```
`searchMessages` (line 285) gains an **opt-in** filter — deliberately NOT default-resolved, so un-migrated callers keep today's whole-channel search until the agent phase threads `context.projectId` (filtering by default project before the migration stamps old rows would hide them):
```js
export async function searchMessages({
  projectId,
  channelId,
  regex,
  sinceDays,
  untilDays,
  role,
  limit,
  contextChars,
}) {
  const query = { channel_id: channelId };
  if (projectId) query.project_id = String(projectId);
```
`loadHistoryForLlm` is **unchanged** (channel-scoped by design — spec decision).

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/messages-projects.test.js tests/messageSearch.test.js tests/messages-format.test.js` → pass; `npm test` → green.

- [ ] **Step 5: Commit**

```
git add src/mongo/messages.js tests/messages-projects.test.js
git commit -m "✨ Stamp project_id on recorded messages"
```

### Task 6: Storyboards + dialogs — denormalized `project_id`

Files:
- Modify: `src/mongo/storyboards.js` (lines 350-367 `listStoryboards`/`countStoryboardsByBeat`, 391-460 `createStoryboard`, 949-951 `ensureIndexes`; re-sign line 369 `getStoryboard`, 379 `getPreviousStoryboardInBeat`, 469 `updateStoryboard`, 811 `setFramePrompt`)
- Modify: `src/mongo/dialogs.js` (lines 51-66, 75-103, 188-190 — same shapes; re-sign line 68 `getDialog`, 108 `updateDialog`)
- Modify: `src/mongo/client.js` (storyboards/dialogs index lines)
- Modify (mechanical sweep): caller bridge for the six re-signed helpers — sites listed in Step 4
- Test: `tests/storyboards.test.js`, `tests/dialogs.test.js` (+ test sweep, Step 4)

`GET /api/toc` (`src/web/entityRoutes.js:405-420`) calls `countStoryboardsByBeat()`, `countDialogsByBeat()`, `listDialogs()`, `listStoryboards()` with no args — after this task those resolve to the default project; the REST phase threads `req.projectId`. No route edit here. Beat-filtered calls (`listStoryboards({beatId})`) stay beat-scoped — beat ObjectIds are globally unique. Six id-addressed helpers — `getStoryboard`, `updateStoryboard`, `setFramePrompt`, `getPreviousStoryboardInBeat`, `getDialog`, `updateDialog` — **are re-signed** to `(projectId, id, …)` with verify-after-locate semantics per the spec rule (Tasks 14/15 call them as `(req.projectId, id)` / `(projectId, id)` — the signatures here must match exactly); their callers get the `undefined,` bridge in Step 4. The remaining id-addressed helpers (`deleteStoryboard`, `deleteStoryboardsForBeat`, the frame mutators, `reorderStoryboardsForBeat`, `deleteDialog`, `deleteDialogsForBeat`, `reorderDialogsForBeat`) keep their single-id signatures via an unverified internal loader (Step 3).

- [ ] **Step 1: Write failing tests.** In `tests/storyboards.test.js` add `const Projects = await import('../src/mongo/projects.js');` next to the existing imports and append:

```js
describe('multi-project storyboards', () => {
  it('createStoryboard stamps project_id and listing/counting are scoped', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const sb = await Storyboards.createStoryboard({ projectId: p1, beatId: beatA });
    expect(sb.project_id).toBe(p1);
    expect(await Storyboards.listStoryboards({ projectId: p1 })).toHaveLength(1);
    expect(await Storyboards.listStoryboards({ projectId: p2 })).toHaveLength(0);
    expect((await Storyboards.countStoryboardsByBeat(p1)).get(beatA.toString())).toBe(1);
    expect((await Storyboards.countStoryboardsByBeat(p2)).size).toBe(0);
  });

  it('id-addressed helpers verify project after locate — stale id ⇒ not-found', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const sb = await Storyboards.createStoryboard({ projectId: p1, beatId: beatA });
    expect((await Storyboards.getStoryboard(p1, sb._id)).project_id).toBe(p1);
    expect(await Storyboards.getStoryboard(p2, sb._id)).toBe(null);
    await expect(
      Storyboards.updateStoryboard(p2, sb._id, { summary: 'cross-project write' }),
    ).rejects.toThrow(/not found/i);
    expect((await Storyboards.updateStoryboard(p1, sb._id, { summary: 'ok' })).summary).toBe('ok');
    await expect(
      Storyboards.setFramePrompt(p2, sb._id, 'frame-x', 'nope'),
    ).rejects.toThrow(/not found/i);
    expect(
      (await Storyboards.getPreviousStoryboardInBeat(p1, beatA, sb.order + 1))._id.toString(),
    ).toBe(sb._id.toString());
    expect(await Storyboards.getPreviousStoryboardInBeat(p2, beatA, sb.order + 1)).toBe(null);
  });

  it('legacy storyboards without project_id stay reachable from any project', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const legacy = await insertLegacy();
    expect((await Storyboards.getStoryboard(p1, legacy._id))._id.toString()).toBe(
      legacy._id.toString(),
    );
  });
});
```
In `tests/dialogs.test.js`, add the same `const Projects = await import('../src/mongo/projects.js');` import and the mirror-image block:

```js
describe('multi-project dialogs', () => {
  it('createDialog stamps project_id and listing/counting are scoped', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const d = await Dialogs.createDialog({ projectId: p1, beatId: beatA });
    expect(d.project_id).toBe(p1);
    expect(await Dialogs.listDialogs({ projectId: p1 })).toHaveLength(1);
    expect(await Dialogs.listDialogs({ projectId: p2 })).toHaveLength(0);
    expect((await Dialogs.countDialogsByBeat(p1)).get(beatA.toString())).toBe(1);
    expect((await Dialogs.countDialogsByBeat(p2)).size).toBe(0);
  });

  it('getDialog/updateDialog verify project after locate — stale id ⇒ not-found', async () => {
    const p1 = (await Projects.createProject('Alpha'))._id.toString();
    const p2 = (await Projects.createProject('Beta'))._id.toString();
    const d = await Dialogs.createDialog({ projectId: p1, beatId: beatA, body: 'hi' });
    expect((await Dialogs.getDialog(p1, d._id)).body).toBe('hi');
    expect(await Dialogs.getDialog(p2, d._id)).toBe(null);
    await expect(Dialogs.updateDialog(p2, d._id, { body: 'x' })).rejects.toThrow(/not found/i);
    expect((await Dialogs.updateDialog(p1, d._id, { body: 'edited' })).body).toBe('edited');
  });
});
```
(`beatA` already exists in both files' setup — a module-level `new ObjectId()`; `insertLegacy` is `tests/storyboards.test.js`'s existing raw-doc fixture helper.)

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/storyboards.test.js tests/dialogs.test.js` → `expected undefined to be '66…'` (no stamp), the `p2` listings/counts are non-empty, and the verify-after-locate tests fail with `TypeError: Cannot read properties of null (reading 'project_id')` / `(reading 'body')` — the old single-id signatures parse the 24-hex project id as the storyboard/dialog id and find nothing.

- [ ] **Step 3: Implement.** In `src/mongo/storyboards.js` add `import { resolveProjectId } from './projects.js';`. Replace `listStoryboards` / `countStoryboardsByBeat` (lines 350-367):

```js
export async function listStoryboards({ projectId, beatId } = {}) {
  let docs;
  if (beatId) {
    docs = await col().find({ beat_id: toOid(beatId) }).sort({ order: 1 }).toArray();
  } else {
    const pid = await resolveProjectId(projectId);
    // Lenient toward legacy rows with no project_id (pre-migration).
    docs = (await col().find({}).sort({ order: 1 }).toArray()).filter(
      (d) => !d.project_id || d.project_id === pid,
    );
  }
  const out = [];
  for (const d of docs) out.push(backfill(await ensureFrames(d)));
  return out;
}

export async function countStoryboardsByBeat(projectId) {
  const pid = await resolveProjectId(projectId);
  const docs = await col()
    .find({}, { projection: { beat_id: 1, project_id: 1 } })
    .toArray();
  const counts = new Map();
  for (const d of docs) {
    if (d.project_id && d.project_id !== pid) continue;
    const k = d.beat_id?.toString?.();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}
```
`createStoryboard` gains a `projectId` key (line 391) and stamps the doc (line 423):
```js
export async function createStoryboard({
  projectId,
  beatId,
  order,
  // ... rest of the existing params unchanged
} = {}) {
  if (!beatId) throw new Error('beatId required');
  const pid = await resolveProjectId(projectId);
  // ... unchanged until the doc literal:
  const doc = {
    _id: new ObjectId(),
    project_id: pid,
    beat_id: beatOid,
```
`ensureIndexes` (line 949) gains the compound index:
```js
export async function ensureIndexes() {
  await col().createIndex({ beat_id: 1, order: 1 });
  await col().createIndex({ project_id: 1, beat_id: 1 });
}
```
**Re-sign the four id-addressed storyboard helpers** (verify-after-locate: locate by globally-unique `_id`, then verify `project_id`; mismatch ⇒ not-found; docs with **no** stamp are in-project until the migration). First add the unverified internal loader — the id-addressed helpers that do NOT gain a `projectId` (`mutateFrame` and everything built on it, `deleteStoryboard`, `deleteStoryboardsForBeat`, `addFrame`, `removeFrame`, `reorderFrames`, `rotateFrameImageEdit`, `undoFrameImageEdit`, `reorderStoryboardsForBeat`) keep today's any-project behavior through it:

```js
// Unverified internal loader. The id-addressed helpers that did not gain a
// projectId param locate through this — same any-project behavior as today.
async function getStoryboardAnyProject(id) {
  const oid = maybeOid(id);
  if (!oid) return null;
  const doc = await col().findOne({ _id: oid });
  return backfill(await ensureFrames(doc));
}
```

`getStoryboard` (line 369) before:
```js
export async function getStoryboard(id) {
  const oid = maybeOid(id);
  if (!oid) return null;
  const doc = await col().findOne({ _id: oid });
  return backfill(await ensureFrames(doc));
}
```
after:
```js
export async function getStoryboard(projectId, id) {
  const doc = await getStoryboardAnyProject(id);
  if (!doc) return null;
  // Verify-after-locate: a stale id from another project's history reads as
  // not-found. Unstamped legacy docs are in-project (lenient until migration).
  const pid = await resolveProjectId(projectId);
  if (doc.project_id && doc.project_id !== pid) return null;
  return doc;
}
```

`getPreviousStoryboardInBeat` (line 379) before:
```js
export async function getPreviousStoryboardInBeat(beatId, currentOrder) {
  const beatOid = maybeOid(beatId);
  if (!beatOid) return null;
  if (!Number.isFinite(Number(currentOrder))) return null;
  const docs = await col()
    .find({ beat_id: beatOid, order: { $lt: Number(currentOrder) } })
    .sort({ order: -1 })
    .limit(1)
    .toArray();
  return docs[0] ? backfill(await ensureFrames(docs[0])) : null;
}
```
after (beat ids are globally unique, so every candidate shares one project — verifying the single located doc covers the whole result set):
```js
export async function getPreviousStoryboardInBeat(projectId, beatId, currentOrder) {
  const beatOid = maybeOid(beatId);
  if (!beatOid) return null;
  if (!Number.isFinite(Number(currentOrder))) return null;
  const docs = await col()
    .find({ beat_id: beatOid, order: { $lt: Number(currentOrder) } })
    .sort({ order: -1 })
    .limit(1)
    .toArray();
  if (!docs[0]) return null;
  const pid = await resolveProjectId(projectId);
  if (docs[0].project_id && docs[0].project_id !== pid) return null;
  return backfill(await ensureFrames(docs[0]));
}
```

`updateStoryboard` (line 469) — exactly three lines change; the long validation body stays byte-identical:
```js
export async function updateStoryboard(id, patch) {            // line 469
  const existing = await getStoryboard(id);                    // line 473
  return getStoryboard(existing._id);                          // line 609
```
→
```js
export async function updateStoryboard(projectId, id, patch) {
  const existing = await getStoryboard(projectId, id);
  return getStoryboard(projectId, existing._id);
```
(a cross-project id makes `existing` null ⇒ the existing `Storyboard not found: ${id}` throw at line 474 — that IS the mismatch ⇒ not-found behavior).

`setFramePrompt` (line 811) before:
```js
export async function setFramePrompt(id, frameId, prompt) {
  return mutateFrame(id, frameId, (frame) => {
    frame.prompt = String(prompt ?? '');
  });
}
```
after (verify first, then reuse the unverified `mutateFrame`):
```js
export async function setFramePrompt(projectId, storyboardId, frameId, prompt) {
  const sb = await getStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  return mutateFrame(sb._id, frameId, (frame) => {
    frame.prompt = String(prompt ?? '');
  });
}
```

In-file mechanical bit: every OTHER internal `getStoryboard(` call switches to `getStoryboardAnyProject(` — lines 255, 264 (`mutateFrame`), 613 (`deleteStoryboard`), 673, 696 (`addFrame`), 703, 714 (`removeFrame`), 722, 744 (`reorderFrames`), 759 (`rotateFrameImageEdit`), 785 (`undoFrameImageEdit`). In-file verification: `grep -n "getStoryboard([^p]" src/mongo/storyboards.js` → **zero matches** (every surviving `getStoryboard(` call passes `projectId` first).

**`src/mongo/dialogs.js`** — add `import { resolveProjectId } from './projects.js';` after the line-16 `logger` import, then the same shapes plus the two re-signs.

`listDialogs` (line 51) becomes:
```js
export async function listDialogs({ projectId, beatId } = {}) {
  if (beatId) {
    const docs = await col().find({ beat_id: toOid(beatId) }).sort({ order: 1 }).toArray();
    return docs.map(backfill);
  }
  const pid = await resolveProjectId(projectId);
  // Lenient toward legacy rows with no project_id stamp (pre-migration).
  const docs = (await col().find({}).sort({ order: 1 }).toArray()).filter(
    (d) => !d.project_id || d.project_id === pid,
  );
  return docs.map(backfill);
}
```

`countDialogsByBeat` (line 57):
```js
export async function countDialogsByBeat(projectId) {
  const pid = await resolveProjectId(projectId);
  const docs = await col()
    .find({}, { projection: { beat_id: 1, project_id: 1 } })
    .toArray();
  const counts = new Map();
  for (const d of docs) {
    if (d.project_id && d.project_id !== pid) continue;
    const k = d.beat_id?.toString?.();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}
```

`getDialog` (line 68) re-signed, with its own unverified loader for `deleteDialog`:
```js
// Unverified internal loader — deleteDialog locates through this, keeping its
// single-id signature and any-project behavior.
async function getDialogAnyProject(id) {
  const oid = maybeOid(id);
  if (!oid) return null;
  const doc = await col().findOne({ _id: oid });
  return backfill(doc);
}

export async function getDialog(projectId, id) {
  const doc = await getDialogAnyProject(id);
  if (!doc) return null;
  // Verify-after-locate: cross-project id ⇒ not-found; unstamped ⇒ in-project.
  const pid = await resolveProjectId(projectId);
  if (doc.project_id && doc.project_id !== pid) return null;
  return doc;
}
```

`createDialog` (line 75) gains the key and stamps `project_id` above `beat_id` (complete function):
```js
export async function createDialog({ projectId, beatId, order, body = '', character = '' } = {}) {
  if (!beatId) throw new Error('beatId required');
  const pid = await resolveProjectId(projectId);
  const beatOid = toOid(beatId);
  let nextOrder = order;
  if (nextOrder === undefined || nextOrder === null) {
    const existing = await col()
      .find({ beat_id: beatOid }, { projection: { order: 1 } })
      .toArray();
    nextOrder = existing.length
      ? Math.max(...existing.map((d) => d.order || 0)) + 1
      : 1;
  }
  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    project_id: pid,
    beat_id: beatOid,
    order: Number(nextOrder),
    body: String(body || ''),
    character: String(character || ''),
    audio_file_id: null,
    created_at: now,
    updated_at: now,
  };
  await col().insertOne(doc);
  logger.info(
    `mongo: dialog create id=${doc._id} beat=${beatOid} order=${doc.order}`,
  );
  return backfill(doc);
}
```

`updateDialog` (line 108) — three lines, same shape as `updateStoryboard`:
```js
export async function updateDialog(id, patch) {        // line 108
  const existing = await getDialog(id);                // line 112
  return getDialog(existing._id);                      // line 138
```
→
```js
export async function updateDialog(projectId, id, patch) {
  const existing = await getDialog(projectId, id);
  return getDialog(projectId, existing._id);
```

`deleteDialog` (line 142): `const d = await getDialog(id);` → `const d = await getDialogAnyProject(id);` (signature unchanged; `deleteDialogsForBeat`/`reorderDialogsForBeat` never call `getDialog`).

`ensureIndexes` (line 188):
```js
export async function ensureIndexes() {
  await col().createIndex({ beat_id: 1, order: 1 });
  await col().createIndex({ project_id: 1, beat_id: 1 });
}
```

In-file verification: `grep -n "resolveProjectId" src/mongo/dialogs.js` → exactly **5** matching lines (the import + `listDialogs` + `countDialogsByBeat` + `getDialog` + `createDialog`); `grep -n "getDialog([^p]" src/mongo/dialogs.js` → zero matches.

- [ ] **Step 4: MECHANICAL SWEEP — caller bridge for the six re-signed helpers.** Enumerate (from the repo root):

```
grep -rn -E "\b(getStoryboard|updateStoryboard|setFramePrompt|getPreviousStoryboardInBeat|getDialog|updateDialog)\(" src tests --include='*.js' | grep -v '^src/mongo/storyboards.js' | grep -v '^src/mongo/dialogs.js' | grep -v import | grep -v ' from '
```

Site list at planning time (file: lines):

```
src/web/dialogRegenerate.js: 52
src/web/entityRoutes.js: 2486,2594,2638,2754,2755,3062,3116,3216,3307,3424,3518,3627,3695,3783,3852,3938,4311,4628,4716,4747
src/web/roomRegistry.js: 485,503,575
src/web/storyboardGenerate.js: 450,1199,1595,1621,1753
tests/beat-character-images-endpoint.test.js: 225
tests/dialog-audio-gateway.test.js: 128,129
tests/dialog-gateway.test.js: 57,69,111,123,136,147,158
tests/dialogs.test.js: 69,80,92,101,102,109
tests/fal-video-generate.test.js: 189,191,282,484,548,577
tests/gateway-critique.test.js: 33,46,55
tests/storyboardCritiqueGeneration.test.js: 102,144
tests/storyboard-bulk-images-routes.test.js: 133
tests/storyboard-bulk-images.test.js: 56,100,104
tests/storyboard-clear-images.test.js: 44,50,75,77,96,121
tests/storyboard-frame-edit-with-references.test.js: 64,154
tests/storyboard-frame-regen.test.js: 67,100,140,189,202,261,351,376
tests/storyboard-gateway.test.js: 51,62,215,359,366,368
tests/storyboard-generate-summary.test.js: 103
tests/storyboard-grab-frame.test.js: 113,115,121,129,160,174,192
tests/storyboards-critique-fields.test.js: 32,35,41,42,48
tests/storyboards-room.test.js: 87
tests/storyboards.test.js: 97,108,115,215,447,464,465,483,496,503,511,512,577,587,600,609,616,626,635,646,654,663,702,708
```

No test file mocks these modules (`grep -rn "vi.mock.*storyboards\|vi.mock.*dialogs" tests/` → zero matches), so every listed site is a positional call on the real module. Uniform transformation — prepend `undefined, ` as the first argument (`resolveProjectId(undefined)` → default project, behavior unchanged; Task 14 replaces the SPA-side `undefined`s with `req.projectId`, Task 15 the agent-side with `projectId`). Two real examples:

`src/web/roomRegistry.js:485` before/after:
```js
            await setFramePrompt(sbId, frameId, value);
            await setFramePrompt(undefined, sbId, frameId, value);
```
`src/web/entityRoutes.js:2755` before/after:
```js
      const prev = await getPreviousStoryboardInBeat(sb.beat_id, sb.order);
      const prev = await getPreviousStoryboardInBeat(undefined, sb.beat_id, sb.order);
```

All listed sites are single-line calls (no first-arg-on-its-own-line cases in this sweep). The Step 1 tests already pass `p1`/`p2` explicitly. Verification (expect **zero** output):

```
grep -rnP "\b(getStoryboard|updateStoryboard|setFramePrompt|getPreviousStoryboardInBeat|getDialog|updateDialog)\(\s*(?=\S)(?!undefined|projectId|p1|p2)" src tests --include='*.js' | grep -v '^src/mongo/storyboards.js' | grep -v '^src/mongo/dialogs.js' | grep -v import | grep -v ' from '
```

Then `npm test`; fix any straggler with the same prepend rule until green.

- [ ] **Step 5: Indexes in `src/mongo/client.js`** — after the existing line 105 (`await db.collection('storyboards').createIndex({ beat_id: 1, order: 1 });`) add:

```js
  await db.collection('storyboards').createIndex({ project_id: 1, beat_id: 1 });
  await db.collection('dialogs').createIndex({ project_id: 1, beat_id: 1 });
```

- [ ] **Step 6: Run, expect PASS** — `npx vitest run tests/storyboards.test.js tests/dialogs.test.js` → pass (existing `createStoryboard({beatId})` fixtures keep passing: the omitted key resolves to the default project, which is also what the swept `undefined,` callers and zero-arg `count*`/`list*` resolve to). Then `npm test` → green.

- [ ] **Step 7: Commit**

```
git add src/mongo/storyboards.js src/mongo/dialogs.js src/mongo/client.js src/web/storyboardGenerate.js src/web/entityRoutes.js src/web/roomRegistry.js src/web/dialogRegenerate.js tests
git commit -m "✨ Denormalize project_id onto storyboards and dialogs"
```

**End-of-phase verification:** `npm test` → entire suite green; `grep -rn "'main'" src/mongo/plots.js src/mongo/artworks.js src/rag/indexer.js` → zero matches; `grep -rn "_id: 'director_notes'\|'character_template'\|'plot_template'" src/mongo src/web/roomRegistry.js` → only the composite-id `promptDocId`/`docId` builders match.
## Phase B: Media buckets + RAG

Project scoping for the two GridFS buckets (`images`, `attachments`) and the Chroma RAG index. Depends on Phase A having landed `src/mongo/projects.js` (`createProject`, `listProjects`, `getProjectByTitle`, `getProjectById`, `getDefaultProject`, `resolveProjectId`). Every helper here resolves its project via the transitional `resolveProjectId(projectId)` (falsy → default project), so un-threaded callers stay green until the strict flip.

**Placeholder convention used by this phase (later phases depend on it):** wherever a positional `projectId` first parameter is added and the call site cannot thread a real project yet, the call site is rewritten to pass a literal `undefined` first argument (e.g. `uploadGeneratedImage(undefined, {...})`). Phase C (agent handlers) and Phase D (REST routes) replace those `undefined`s with `context.projectId` / `req.projectId`. Until then `undefined` → default project via `resolveProjectId`.

**Cross-phase file drift warning for the executor:** Phase A's sweeps may have already touched some lines quoted below (e.g. `getCharacter(character)` inside `src/mongo/files.js` may already read `getCharacter(undefined, character)`). When an `old_string` does not match exactly, re-read the file — the *transformation* described is authoritative, the quoted text is the pre-Phase-A baseline unless stated otherwise.

---

### Task 7: images GridFS — project-scoped uploads, library listings, index

**Files:**
- Modify: `src/mongo/images.js` (uploads lines 42–113, `listLibraryImages` 119–124, `listImagesForBeat`/`listImagesForCharacter` 126–138, `listImagesByOwnerType` 150–155, `searchLibraryImages` 290–302)
- Modify: `src/mongo/imageCopy.js` (whole function, lines 11–52)
- Modify: `src/mongo/files.js` (`attachImageToCharacter`, lines 45–67)
- Modify: `src/mongo/client.js` (index block in `connectMongo`, lines 95–105)
- Modify (mechanical sweep): `src/web/entityRoutes.js`, `src/agent/handlers.js`, `src/web/artworkJobs.js`, `src/web/storyboardGrabFrame.js`, `src/web/storyboardGenerate.js`, `src/web/downloads.js`
- Verify unchanged: `src/mongo/imageThumbnails.js` (thumbnails derive via `metadata.source_image_id` / `metadata.thumbnail_id`, uploaded through raw `uploadBuffer` with `kind: 'thumbnail'` — they intentionally carry **no** `project_id` and are excluded from library listings by both the existing `'metadata.kind': { $ne: 'thumbnail' }` clause and the new strict `project_id` match)
- Test: `tests/images-bucket.test.js` (rewrite), `tests/library-image-meta.test.js`, `tests/library-vision-seed.test.js`, `tests/image-copy.test.js`, `tests/editImage.test.js`, `tests/downloads.test.js`, plus mock-signature sweep across storyboard/generate-image test files (enumerated in Step 6)

**New signatures defined by this task:**

```js
uploadGeneratedImage(projectId, { buffer, contentType, prompt, generatedBy, ownerType = null, ownerId = null, filename, name = '', description = '' })
uploadImageFromUrl(projectId, { sourceUrl, filename, ownerType = null, ownerId = null, name = '', description = '' })
listLibraryImages(projectId)
searchLibraryImages({ projectId, query, limit = 20 } = {})
listImagesByOwnerType(projectId, ownerType)
listImagesForBeat(projectId, beatId)               // project-VERIFIED: locate by owner id, lenient to unstamped legacy files
listImagesForCharacter(projectId, characterId)     // same; Tasks 14/15 call these as (req.projectId, c._id)
copyImageToNewOwner({ projectId, imageId, ownerType, ownerId, filenameBase })   // projectId optional; falls back to source file's metadata.project_id
attachImageToCharacter({ projectId, character, sourceUrl, filename, caption, setAsMain })
```

Note: the shared conventions say options-object helpers gain a `projectId` *key*; the task brief explicitly overrides that for the upload pair (`projectId` first param). `searchLibraryImages`, `copyImageToNewOwner`, and `attachImageToCharacter` follow the options-key convention. The per-owner listers `listImagesForBeat`/`listImagesForCharacter` follow the spec's verify-after-locate rule for id-addressed helpers: locate by the (globally unique) owner id, then verify project membership — lenient toward legacy files with no `metadata.project_id` stamp, which count as in-project until the migration stamps them.

- [ ] **Step 1: Write the failing project-scoping tests (rewrite `tests/images-bucket.test.js`).**

Replace the entire file with (GridFS streams can't run against the fake — same constraint documented at the top of `tests/image-copy.test.js` — so upload stamping is exercised through the filter helpers and the complete implementation in Step 3; seeds write `images.files` docs directly):

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Images = await import('../src/mongo/images.js');
const Projects = await import('../src/mongo/projects.js');

let pid; // default project id (hex string), recreated per test by getDefaultProject

beforeEach(async () => {
  fakeDb.reset();
  pid = (await Projects.getDefaultProject())._id.toString();
});

function seedFile({ id, projectId, ownerType = null, ownerId = null, source = 'upload', prompt = null }) {
  const doc = {
    _id: id || new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      project_id: projectId ?? pid,
      owner_type: ownerType,
      owner_id: ownerId,
      source,
      prompt,
      generated_by: source === 'generated' ? 'gemini-2.5-flash-image' : null,
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}

describe('images metadata helpers', () => {
  it('listLibraryImages returns only files with owner_type null', async () => {
    seedFile({ ownerType: null });
    seedFile({ ownerType: 'beat', ownerId: new ObjectId() });
    seedFile({ ownerType: null });

    const lib = await Images.listLibraryImages();
    expect(lib).toHaveLength(2);
    for (const f of lib) expect(f.metadata.owner_type).toBeNull();
  });

  it('listImagesForBeat filters by owner_type and owner_id', async () => {
    const beatA = new ObjectId();
    const beatB = new ObjectId();
    seedFile({ ownerType: 'beat', ownerId: beatA });
    seedFile({ ownerType: 'beat', ownerId: beatA });
    seedFile({ ownerType: 'beat', ownerId: beatB });

    const aImages = await Images.listImagesForBeat(undefined, beatA);
    expect(aImages).toHaveLength(2);
    for (const f of aImages) expect(f.metadata.owner_id.equals(beatA)).toBe(true);
  });

  it('setImageOwner flips ownership from library to a beat', async () => {
    const file = seedFile({ ownerType: null });
    const beatId = new ObjectId();

    await Images.setImageOwner(file._id, { ownerType: 'beat', ownerId: beatId });

    const after = await Images.findImageFile(file._id);
    expect(after.metadata.owner_type).toBe('beat');
    expect(after.metadata.owner_id.equals(beatId)).toBe(true);

    const lib = await Images.listLibraryImages();
    expect(lib).toHaveLength(0);

    const beatImages = await Images.listImagesForBeat(undefined, beatId);
    expect(beatImages).toHaveLength(1);
  });

  it('imageFileToMeta extracts the right fields', () => {
    const file = {
      _id: new ObjectId(),
      filename: 'gen.png',
      contentType: 'image/png',
      length: 1234,
      uploadDate: new Date('2025-01-01'),
      metadata: {
        owner_type: null,
        owner_id: null,
        source: 'generated',
        prompt: 'a cat',
        generated_by: 'gemini-2.5-flash-image',
      },
    };
    const meta = Images.imageFileToMeta(file);
    expect(meta.filename).toBe('gen.png');
    expect(meta.size).toBe(1234);
    expect(meta.source).toBe('generated');
    expect(meta.prompt).toBe('a cat');
    expect(meta.generated_by).toBe('gemini-2.5-flash-image');
  });

  it('ensureObjectId accepts strings and ObjectIds', () => {
    const oid = new ObjectId();
    expect(Images.ensureObjectId(oid)).toBe(oid);
    const fromStr = Images.ensureObjectId(oid.toString());
    expect(fromStr.equals(oid)).toBe(true);
  });
});

describe('images project scoping', () => {
  it('listLibraryImages(projectId) only returns that project\'s library', async () => {
    const other = await Projects.createProject('Other Movie');
    const otherPid = other._id.toString();
    seedFile({ ownerType: null });                       // default project
    seedFile({ ownerType: null, projectId: otherPid });  // other project

    const defaults = await Images.listLibraryImages();   // undefined → default project
    expect(defaults).toHaveLength(1);
    expect(defaults[0].metadata.project_id).toBe(pid);

    const others = await Images.listLibraryImages(otherPid);
    expect(others).toHaveLength(1);
    expect(others[0].metadata.project_id).toBe(otherPid);
  });

  it('listImagesByOwnerType(projectId, ownerType) is project-filtered', async () => {
    const other = await Projects.createProject('Other Movie');
    const otherPid = other._id.toString();
    seedFile({ ownerType: 'character', ownerId: new ObjectId() });
    seedFile({ ownerType: 'character', ownerId: new ObjectId(), projectId: otherPid });

    const defaults = await Images.listImagesByOwnerType(undefined, 'character');
    expect(defaults).toHaveLength(1);
    expect(defaults[0].metadata.project_id).toBe(pid);

    const others = await Images.listImagesByOwnerType(otherPid, 'character');
    expect(others).toHaveLength(1);
  });

  it('listImagesForBeat verifies project but is lenient toward unstamped legacy files', async () => {
    const other = await Projects.createProject('Other Movie');
    const otherPid = other._id.toString();
    const beatId = new ObjectId();
    seedFile({ ownerType: 'beat', ownerId: beatId });                      // default project
    seedFile({ ownerType: 'beat', ownerId: beatId, projectId: otherPid }); // other project
    const legacy = seedFile({ ownerType: 'beat', ownerId: beatId });
    delete legacy.metadata.project_id;                                     // pre-migration file

    const defaults = await Images.listImagesForBeat(undefined, beatId);
    expect(defaults).toHaveLength(2); // default-project file + legacy file

    const others = await Images.listImagesForBeat(otherPid, beatId);
    expect(others).toHaveLength(2); // other-project file + legacy file
  });

  it('files without metadata.project_id are excluded (strict filter; migration stamps legacy files)', async () => {
    const doc = seedFile({ ownerType: null });
    delete doc.metadata.project_id;
    const lib = await Images.listLibraryImages();
    expect(lib).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

```
npx vitest run tests/images-bucket.test.js
```

Expected: the four `images project scoping` tests fail — `listLibraryImages(projectId)` currently ignores its argument and applies no project filter, so e.g. `expected 2 to have a length of 1` / `expected undefined to be '68…'` (`metadata.project_id` is never read), the strict-filter test gets `expected 1 to have a length of 0`, and the leniency test throws `BSONError: input must be a 24 character hex string…` (the old `listImagesForBeat(beatId)` signature binds `undefined` as the beat id → `toObjectId(undefined)`). Two of the five pre-existing tests (`listImagesForBeat filters by owner_type and owner_id`, `setImageOwner flips ownership from library to a beat`) fail with the same `BSONError` — their calls now pass `undefined` first. The other three pre-existing tests still pass.

- [ ] **Step 3: Implement project scoping in `src/mongo/images.js` (complete code).**

Add the import (after the existing `imageBytes.js` import block, line 13):

```js
import { resolveProjectId } from './projects.js';
```

Replace `uploadGeneratedImage` (lines 42–79) with:

```js
export async function uploadGeneratedImage(projectId, {
  buffer,
  contentType,
  prompt,
  generatedBy,
  ownerType = null,
  ownerId = null,
  filename,
  name = '',
  description = '',
} = {}) {
  const pid = await resolveProjectId(projectId);
  const sniffed = validateImageBuffer(buffer);
  const ct = contentType || sniffed;
  const finalFilename =
    filename?.trim() || `generated-${Date.now()}.${extensionForType(ct)}`;
  const metadata = {
    project_id: pid,
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'generated',
    prompt: prompt || null,
    generated_by: generatedBy || null,
    name: String(name || ''),
    description: String(description || ''),
    name_lower: libraryNameLower(name),
  };
  const id = await uploadBuffer({ buffer, filename: finalFilename, contentType: ct, metadata });
  logger.info(
    `mongo: gridfs upload project=${pid} owner=${ownerType || 'library'}/${ownerId || '-'} bytes=${buffer.length} source=generated`,
  );
  return {
    _id: id,
    filename: finalFilename,
    content_type: ct,
    size: buffer.length,
    metadata,
    uploaded_at: new Date(),
  };
}
```

Replace `uploadImageFromUrl` (lines 81–113) with:

```js
export async function uploadImageFromUrl(projectId, {
  sourceUrl,
  filename,
  ownerType = null,
  ownerId = null,
  name = '',
  description = '',
} = {}) {
  const pid = await resolveProjectId(projectId);
  const { buffer, contentType } = await fetchImageFromUrl(sourceUrl);
  const finalFilename = filename?.trim() || deriveImageFilename(sourceUrl, contentType);
  const metadata = {
    project_id: pid,
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'upload',
    prompt: null,
    generated_by: null,
    name: String(name || ''),
    description: String(description || ''),
    name_lower: libraryNameLower(name),
  };
  const id = await uploadBuffer({ buffer, filename: finalFilename, contentType, metadata });
  logger.info(
    `mongo: gridfs upload project=${pid} owner=${ownerType || 'library'}/${ownerId || '-'} bytes=${buffer.length} source=url`,
  );
  return {
    _id: id,
    filename: finalFilename,
    content_type: contentType,
    size: buffer.length,
    metadata,
    uploaded_at: new Date(),
  };
}
```

Replace `listLibraryImages` (lines 119–124) with:

```js
export async function listLibraryImages(projectId) {
  const pid = await resolveProjectId(projectId);
  return filesCol()
    .find({
      'metadata.project_id': pid,
      'metadata.owner_type': null,
      'metadata.kind': { $ne: 'thumbnail' },
    })
    .sort({ uploadDate: -1 })
    .toArray();
}
```

Replace `listImagesByOwnerType` (lines 150–155) with (keep the comment above it):

```js
export async function listImagesByOwnerType(projectId, ownerType) {
  const pid = await resolveProjectId(projectId);
  return filesCol()
    .find({
      'metadata.project_id': pid,
      'metadata.owner_type': ownerType,
      'metadata.kind': { $ne: 'thumbnail' },
    })
    .sort({ uploadDate: -1 })
    .toArray();
}
```

In `searchLibraryImages` (line 290), change only the signature line and the `listLibraryImages` call:

```js
export async function searchLibraryImages({ projectId, query, limit = 20 } = {}) {
  const all = await listLibraryImages(projectId);
```

(the rest of the function body is unchanged).

Replace `listImagesForBeat` and `listImagesForCharacter` (lines 126–138) — these are re-signed to `(projectId, ownerId)` per the verify-after-locate rule because Tasks 14/15 call them as `(req.projectId, c._id)`. Locate by the (globally unique) owner id, then verify project membership in JS — the same fake-Mongo-compatibility reasoning as the existing `searchLibraryImages` comment (the in-memory fake supports neither `$or` nor `$in`). Files with no `metadata.project_id` stamp are legacy pre-migration files and count as in-project (lenient).

Before (lines 126–138):
```js
export async function listImagesForBeat(beatId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'beat', 'metadata.owner_id': toObjectId(beatId) })
    .sort({ uploadDate: 1 })
    .toArray();
}

export async function listImagesForCharacter(characterId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'character', 'metadata.owner_id': toObjectId(characterId) })
    .sort({ uploadDate: 1 })
    .toArray();
}
```

After:
```js
// Lenient project check for owner-addressed listers: the owner ObjectId is
// globally unique, so the query stays id-addressed and the project id is a
// verification, not a key. Files with no metadata.project_id stamp are legacy
// (pre-migration) and count as in-project. Filtered in JS rather than via
// $or/$in so the in-memory fake Mongo used in tests keeps working.
function filterByProject(files, pid) {
  return files.filter(
    (f) => f.metadata?.project_id == null || String(f.metadata.project_id) === String(pid),
  );
}

export async function listImagesForBeat(projectId, beatId) {
  const pid = await resolveProjectId(projectId);
  const files = await filesCol()
    .find({ 'metadata.owner_type': 'beat', 'metadata.owner_id': toObjectId(beatId) })
    .sort({ uploadDate: 1 })
    .toArray();
  return filterByProject(files, pid);
}

export async function listImagesForCharacter(projectId, characterId) {
  const pid = await resolveProjectId(projectId);
  const files = await filesCol()
    .find({ 'metadata.owner_type': 'character', 'metadata.owner_id': toObjectId(characterId) })
    .sort({ uploadDate: 1 })
    .toArray();
  return filterByProject(files, pid);
}
```

`listImagesForDirectorNote` stays id-addressed and unchanged — no other task threads it (its only src caller is `src/web/downloads.js:219`), and the owner ObjectId is globally unique.

- [ ] **Step 4: Thread the pass-throughs: `imageCopy.js`, `files.js`, and the new index in `client.js`.**

`src/mongo/imageCopy.js` — replace `copyImageToNewOwner` (lines 11–52) with:

```js
export async function copyImageToNewOwner({
  projectId,
  imageId,
  ownerType,
  ownerId,
  filenameBase,
}) {
  const src = await readImageBuffer(imageId);
  if (!src) {
    const e = new Error(`source image not found: ${imageId}`);
    e.status = 404;
    throw e;
  }
  const { buffer, file } = src;
  // Copies stay in the source image's project unless the caller pins one.
  const targetProjectId = projectId || file.metadata?.project_id || undefined;
  const contentType =
    file.contentType || file.metadata?.content_type || 'image/png';
  const ext = (() => {
    if (contentType.includes('jpeg')) return 'jpg';
    if (contentType.includes('webp')) return 'webp';
    return 'png';
  })();
  const newFile = await uploadGeneratedImage(targetProjectId, {
    buffer,
    contentType,
    ownerType,
    ownerId,
    filename: `${filenameBase}-${Date.now()}.${ext}`,
    prompt: file.metadata?.prompt || null,
    generatedBy: file.metadata?.generated_by || null,
    name: file.metadata?.name || '',
    description: file.metadata?.description || '',
  });
  return {
    _id: newFile._id,
    filename: newFile.filename,
    content_type: newFile.content_type,
    size: newFile.size,
    source: file.metadata?.source || 'upload',
    prompt: newFile.metadata?.prompt || null,
    generated_by: newFile.metadata?.generated_by || null,
    uploaded_at: newFile.uploaded_at,
  };
}
```

`src/mongo/files.js` — `attachImageToCharacter` (line 45): add the `projectId` options key and thread it into the upload, falling back to the character doc's own `project_id` (stamped by Phase A / migration):

Before (lines 45–54):
```js
export async function attachImageToCharacter({ character, sourceUrl, filename, caption, setAsMain }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);

  const file = await uploadImageFromUrl({
    sourceUrl,
    filename,
    ownerType: 'character',
    ownerId: c._id,
  });
```

After:
```js
export async function attachImageToCharacter({ projectId, character, sourceUrl, filename, caption, setAsMain }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);

  const file = await uploadImageFromUrl(projectId ?? c.project_id, {
    sourceUrl,
    filename,
    ownerType: 'character',
    ownerId: c._id,
  });
```

(If Phase A already rewrote the lookup line to `getCharacter(undefined, character)`, keep that form — only the signature line and the upload call change here.)

`src/mongo/client.js` — in `connectMongo`, immediately after the existing two `images.files` indexes (lines 97–102), add:

```js
  await db
    .collection('images.files')
    .createIndex({ 'metadata.project_id': 1, 'metadata.owner_type': 1 });
```

- [ ] **Step 5: Mechanical sweep — src call sites of the two upload helpers + `listImagesByOwnerType`.**

Enumerate (run this; the list below is the current output):

```
grep -rnE "(uploadGeneratedImage|uploadImageFromUrl)\(\{" src/ | grep -v "src/mongo/images.js"
```

Sites (24 total — 22 to sweep here, 2 already threaded in Step 4):

```
src/web/entityRoutes.js:796,887,1036,1192,1401,1548,1703,2018,2324,2639,3063,3308,3526,3635   uploadGeneratedImage
src/agent/handlers.js:1474,1845                                                               Images.uploadImageFromUrl
src/agent/handlers.js:2341,2554                                                               Images.uploadGeneratedImage
src/web/artworkJobs.js:189,357                                                                uploadGeneratedImage
src/web/storyboardGrabFrame.js:132                                                            uploadGeneratedImage
src/web/storyboardGenerate.js:1503                                                            uploadGeneratedImage
src/mongo/files.js:49        (already threaded in Step 4 — skip)
src/mongo/imageCopy.js:31    (already threaded in Step 4 — skip)
```

Uniform transformation — insert `undefined, ` as the first argument:

```
uploadGeneratedImage({            →  uploadGeneratedImage(undefined, {
Images.uploadGeneratedImage({     →  Images.uploadGeneratedImage(undefined, {
uploadImageFromUrl({              →  uploadImageFromUrl(undefined, {
Images.uploadImageFromUrl({       →  Images.uploadImageFromUrl(undefined, {
```

Real example 1 — `src/agent/handlers.js:2341` (`generate_image`):

```js
    const file = await Images.uploadGeneratedImage({
      buffer,
      contentType,
      prompt: finalPrompt,
```
becomes
```js
    const file = await Images.uploadGeneratedImage(undefined, {
      buffer,
      contentType,
      prompt: finalPrompt,
```

Real example 2 — `src/web/storyboardGenerate.js:1503`:

```js
  const file = await uploadGeneratedImage({
    buffer: result.buffer,
    contentType: result.contentType,
```
becomes
```js
  const file = await uploadGeneratedImage(undefined, {
    buffer: result.buffer,
    contentType: result.contentType,
```

`listImagesByOwnerType` — only 2 sites, both in `src/web/entityRoutes.js`, shown explicitly:

Line 675: `const files = await listImagesByOwnerType('character');` → `const files = await listImagesByOwnerType(undefined, 'character');`
Line 721: `listImagesByOwnerType('beat'),` → `listImagesByOwnerType(undefined, 'beat'),`

`listImagesForBeat` / `listImagesForCharacter` — re-signed in Step 3, so every call site gets the same `undefined, ` bridge. Enumerate (run this; the list below is the current output — import lines have no `(` and stay untouched):

```
grep -rn "listImagesForBeat(\|listImagesForCharacter(" src/ | grep -v "src/mongo/images.js"
```

Sites (4 total):

```
src/web/downloads.js:145:    listImagesForBeat(beatIdHex),
src/web/entityRoutes.js:588:        listImagesForBeat(beatId),
src/web/entityRoutes.js:616:      const files = await listImagesForCharacter(c._id);
src/web/entityRoutes.js:3140:        const files = await listImagesForBeat(beat._id);
```

Real example 1 — `src/web/entityRoutes.js:616` (`GET /character/:id/images`):

```js
      const files = await listImagesForCharacter(c._id);
```
becomes
```js
      const files = await listImagesForCharacter(undefined, c._id);
```
(Task 14 later replaces this `undefined` with `req.projectId` — its sweep calls these as `listImagesForCharacter(req.projectId, c._id)`, which is exactly the signature defined in Step 3.)

Real example 2 — `src/web/downloads.js:145`:

```js
    listImagesForBeat(beatIdHex),
```
becomes
```js
    listImagesForBeat(undefined, beatIdHex),
```
(`downloads.js`'s `undefined` is replaced by Task 20 pre-flip threading.)

`listLibraryImages()` / `searchLibraryImages({ query, limit })` call sites need **no** change (new arg/key is optional → default project) — leave `src/web/entityRoutes.js:659` and `src/agent/handlers.js:1922,1935` alone (Phases C/D thread them), and leave `src/web/downloads.js:193` and `src/pdf/export.js:551` alone (Task 20 pre-flip threading covers those intermediate modules). `src/web/roomRegistry.js:616` also stays unchanged (markdown-render lookup; it stays on the default project until a later task threads it).

Verification — all three expect **zero matches**:

```
grep -rnE "(uploadGeneratedImage|uploadImageFromUrl)\(\{" src/ scripts/
grep -rn "listImagesByOwnerType('" src/
grep -rPn "listImagesFor(Beat|Character)\((?!undefined|projectId|req\.projectId)" src/ | grep -v "src/mongo/images.js"
```

- [ ] **Step 6: Mechanical sweep — test mocks that destructure the first argument.**

Mocks of `src/mongo/images.js` whose `uploadGeneratedImage`/`uploadImageFromUrl` fake reads the **first** argument now receive `undefined` there and must shift to the second. Enumerate:

```
grep -rnE "upload(GeneratedImage|ImageFromUrl): (vi\.fn\()?async \(" tests/
```

Sites and the uniform transformation (`async ({` → `async (_projectId, {`, `async (args)` → `async (_projectId, args)`):

```
tests/storyboard-grab-frame.test.js:39             async ({ buffer, contentType, ownerType, ownerId, filename })  → async (_projectId, { buffer, contentType, ownerType, ownerId, filename })
tests/storyboard-bulk-images.test.js:19            async ({ filename })            → async (_projectId, { filename })
tests/storyboard-locking.test.js:21                async ({ filename, contentType }) → async (_projectId, { filename, contentType })
tests/storyboard-generate.test.js:34               async ({ filename, contentType }) → async (_projectId, { filename, contentType })
tests/storyboard-frame-regen.test.js:29            async ({ filename })            → async (_projectId, { filename })
tests/storyboard-frame-edit-with-references.test.js:28  async ({ filename })       → async (_projectId, { filename })
tests/storyboard-bulk-images-routes.test.js:23     async ({ filename })            → async (_projectId, { filename })
tests/artwork-edit-with-references.test.js:31      async ({ filename })            → async (_projectId, { filename })
tests/editImage.test.js:59                         async ({ buffer, contentType, prompt, generatedBy, ownerType, ownerId }) → async (_projectId, { buffer, contentType, prompt, generatedBy, ownerType, ownerId })
tests/generate-image-provider.test.js:102          async ({ buffer, contentType, prompt, generatedBy, ownerType, ownerId }) → async (_projectId, { buffer, contentType, prompt, generatedBy, ownerType, ownerId })
tests/generate-image-source.test.js:52             async (args)                    → async (_projectId, args)
tests/generateImage-target.test.js:37              async ({ ownerType, ownerId })  → async (_projectId, { ownerType, ownerId })
tests/image-copy.test.js:46                        async (args)                    → async (_projectId, args)
```

Mocks that ignore their arguments stay untouched: `tests/generateImage-usage.test.js:36`, `tests/downloads.test.js:96,113`, `tests/storyboard-clear-images.test.js:20`, `tests/storyboard-preview-prompt.test.js:27`, `tests/describe-image.test.js:15-18`.

The re-signed per-owner listers add one more mock shift — `tests/downloads.test.js:89` (inside the `vi.mock('../src/mongo/images.js', …)` factory):

```js
  listImagesForBeat: async (id) => {
    return id === beatId.toString() ? [beatImage1, beatImage2] : [];
  },
```
becomes
```js
  listImagesForBeat: async (_projectId, id) => {
    return id === beatId.toString() ? [beatImage1, beatImage2] : [];
  },
```

(`listImagesForDirectorNote: async (id)` at `tests/downloads.test.js:92` stays as-is — that lister was not re-signed. `tests/describe-image.test.js:19`'s `listImagesForBeat: vi.fn(),` ignores its arguments and stays untouched.)

One deviation — `tests/editImage.test.js` also **calls** the mocked helper directly to seed images (lines 110, 138, 154, 245, 256, 414). Each `Images.uploadGeneratedImage({` there becomes `Images.uploadGeneratedImage(undefined, {`. Example (line 110):

```js
  const file = await Images.uploadGeneratedImage({
    buffer: PNG_BYTES,
```
becomes
```js
  const file = await Images.uploadGeneratedImage(undefined, {
    buffer: PNG_BYTES,
```

Verification — all three expect **zero matches**:

```
grep -rnE "(uploadGeneratedImage|uploadImageFromUrl)(: vi\.fn\(|: )?\(?async \(\{" tests/
grep -rnE "(uploadGeneratedImage|uploadImageFromUrl)\(\{" tests/
grep -rn "listImagesForBeat: async (id)" tests/
```

- [ ] **Step 7: Update the library-search test seeds (strict project filter).**

`tests/library-image-meta.test.js` — the `beforeEach` (lines 17–19) and `seedLibrary` (lines 21–41) gain the default-project stamp. Add below the `Images` import (line 15):

```js
const Projects = await import('../src/mongo/projects.js');

let pid;
```

Change the `beforeEach` from:
```js
beforeEach(() => {
  fakeDb.reset();
});
```
to:
```js
beforeEach(async () => {
  fakeDb.reset();
  pid = (await Projects.getDefaultProject())._id.toString();
});
```
and inside `seedLibrary`, change the metadata object's first line from:
```js
    metadata: {
      owner_type: null,
```
to:
```js
    metadata: {
      project_id: pid,
      owner_type: null,
```

`tests/library-vision-seed.test.js` — identical treatment: add the `Projects` import + `let pid;`, make `beforeEach` async with `pid = (await Projects.getDefaultProject())._id.toString();` (keep the existing `analyzeMock.mockClear(); describeMock.mockClear();` lines), and add `project_id: pid,` as the first key of `seedLibrary`'s `metadata` object (line ~57). Only the `searchLibraryImages` test (line 118) depends on it, but stamping every seed is harmless.

- [ ] **Step 8: Run the affected files — expect PASS.**

```
npx vitest run tests/images-bucket.test.js tests/library-image-meta.test.js tests/library-vision-seed.test.js tests/image-copy.test.js tests/editImage.test.js tests/downloads.test.js
```
Expected: all pass. Then the full suite:
```
npm test
```
Expected: green (every other caller reaches the default project via `resolveProjectId(undefined)`).

- [ ] **Step 9: Commit.**

```
git add src/mongo/images.js src/mongo/imageCopy.js src/mongo/files.js src/mongo/client.js \
  src/web/entityRoutes.js src/agent/handlers.js src/web/artworkJobs.js \
  src/web/storyboardGrabFrame.js src/web/storyboardGenerate.js src/web/downloads.js \
  tests/images-bucket.test.js tests/library-image-meta.test.js tests/library-vision-seed.test.js \
  tests/downloads.test.js \
  tests/storyboard-grab-frame.test.js tests/storyboard-bulk-images.test.js tests/storyboard-locking.test.js \
  tests/storyboard-generate.test.js tests/storyboard-frame-regen.test.js \
  tests/storyboard-frame-edit-with-references.test.js tests/storyboard-bulk-images-routes.test.js \
  tests/artwork-edit-with-references.test.js tests/editImage.test.js tests/generate-image-provider.test.js \
  tests/generate-image-source.test.js tests/generateImage-target.test.js tests/image-copy.test.js
git commit -m "✨ Scope images GridFS bucket by project"
```

---

### Task 8: attachments GridFS — same treatment

**Files:**
- Modify: `src/mongo/attachments.js` (`uploadAttachmentBuffer` 41–65, `uploadAttachmentFromUrl` 67–94, `copyAttachmentBuffer` 105–125, `listLibraryAttachments` 127–132, `attachToCharacter` 278–297)
- Modify: `src/mongo/client.js` (add the `attachments.files` index next to the one added in Task 7)
- Modify (sweep): `src/web/entityRoutes.js`, `src/agent/handlers.js`, `src/web/falVideoGenerate.js`
- Test: `tests/library-attachment-attach.test.js`, `tests/attachments.test.js`, `tests/audio-mp3-upload.test.js`, `tests/fal-video-generate.test.js`

**New signatures defined by this task:**

```js
uploadAttachmentBuffer(projectId, { buffer, filename, contentType, ownerType = null, ownerId = null })
uploadAttachmentFromUrl(projectId, { sourceUrl, filename, contentType, ownerType = null, ownerId = null })
copyAttachmentBuffer({ projectId, sourceFileId, filename, ownerType = null, ownerId = null })   // projectId optional; falls back to source file's metadata.project_id
listLibraryAttachments(projectId)
attachToCharacter({ projectId, character, sourceUrl, filename, caption })
```

The per-owner attachment listers (`listAttachmentsForCharacter`, `listAttachmentsForBeat`, `listAttachmentsForDirectorNote`, `src/mongo/attachments.js:134–153`) stay id-addressed and unchanged — unlike the image pair re-signed in Task 7, no later task calls them with a project argument (Tasks 14/15's sweeps thread only `listImagesForBeat`/`listImagesForCharacter`), and the owner ObjectId is globally unique. The move-on-attach detach branches (`detachAttachmentFromCurrentOwner` here, `detachImageFromCurrentOwner` in `src/mongo/files.js`) are likewise untouched by this task — they get their project threading (via `file.metadata.project_id`) in Task 20 pre-flip threading.

- [ ] **Step 1: Write the failing test (extend `tests/library-attachment-attach.test.js`).**

Add the `Projects` import + `pid` plumbing (same pattern as Task 7). After the existing imports (line 15 area):

```js
const Projects = await import('../src/mongo/projects.js');

let pid;
```

Change the `beforeEach` (lines 20–22) from:
```js
beforeEach(() => {
  fakeDb.reset();
});
```
to:
```js
beforeEach(async () => {
  fakeDb.reset();
  pid = (await Projects.getDefaultProject())._id.toString();
});
```

In `seedLibraryAttachment` (lines 24–41), change:
```js
    metadata: {
      owner_type: null,
      owner_id: null,
      source: 'upload',
      content_type: 'audio/mpeg',
    },
```
to:
```js
    metadata: {
      project_id: pid,
      owner_type: null,
      owner_id: null,
      source: 'upload',
      content_type: 'audio/mpeg',
    },
```
(Note the second seed in the first test overrides the whole `metadata` object via `extra` — leave it; an entity-owned file without `project_id` should be excluded either way.)

Then extend the `listLibraryAttachments` describe block with:

```js
  it('is project-filtered', async () => {
    const other = await Projects.createProject('Other Movie');
    const otherPid = other._id.toString();
    seedLibraryAttachment();
    seedLibraryAttachment({
      metadata: {
        project_id: otherPid,
        owner_type: null,
        owner_id: null,
        source: 'upload',
        content_type: 'audio/mpeg',
      },
    });

    const defaults = await Attachments.listLibraryAttachments();
    expect(defaults).toHaveLength(1);
    expect(defaults[0].metadata.project_id).toBe(pid);

    const others = await Attachments.listLibraryAttachments(otherPid);
    expect(others).toHaveLength(1);
    expect(others[0].metadata.project_id).toBe(otherPid);
  });
```

- [ ] **Step 2: Run it — expect FAIL.**

```
npx vitest run tests/library-attachment-attach.test.js
```
Expected: the new `is project-filtered` test fails with `expected 2 to have a length of 1` (no project filter exists yet). Existing tests pass.

- [ ] **Step 3: Implement in `src/mongo/attachments.js` (complete code).**

Add the import (after the `attachmentBytes.js` import block, line 18):

```js
import { resolveProjectId } from './projects.js';
```

Replace `uploadAttachmentBuffer` (lines 41–65) with:

```js
export async function uploadAttachmentBuffer(projectId, {
  buffer,
  filename,
  contentType,
  ownerType = null,
  ownerId = null,
} = {}) {
  const pid = await resolveProjectId(projectId);
  const ct = contentType || 'application/octet-stream';
  const finalFilename = filename?.trim() || `attachment-${Date.now()}.bin`;
  const metadata = {
    project_id: pid,
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'upload',
    content_type: ct,
  };
  const id = await uploadBuffer({ buffer, filename: finalFilename, contentType: ct, metadata });
  return {
    _id: id,
    filename: finalFilename,
    content_type: ct,
    size: buffer.length,
    metadata,
    uploaded_at: new Date(),
  };
}
```

Replace `uploadAttachmentFromUrl` (lines 67–94) with:

```js
export async function uploadAttachmentFromUrl(projectId, {
  sourceUrl,
  filename,
  contentType: hintedContentType,
  ownerType = null,
  ownerId = null,
} = {}) {
  const pid = await resolveProjectId(projectId);
  const { buffer, contentType, size } = await fetchAttachmentFromUrl(
    sourceUrl,
    hintedContentType,
  );
  const finalFilename = filename?.trim() || deriveAttachmentFilename(sourceUrl, contentType);
  const metadata = {
    project_id: pid,
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'upload',
    content_type: contentType,
  };
  const id = await uploadBuffer({ buffer, filename: finalFilename, contentType, metadata });
  return {
    _id: id,
    filename: finalFilename,
    content_type: contentType,
    size,
    metadata,
    uploaded_at: new Date(),
  };
}
```

In `copyAttachmentBuffer` (lines 105–125), change the signature and the upload call (keep the doc comment):

```js
export async function copyAttachmentBuffer({
  projectId,
  sourceFileId,
  filename,
  ownerType = null,
  ownerId = null,
}) {
  const read = await readAttachmentBuffer(sourceFileId);
  if (!read) throw new Error(`Attachment not found: ${sourceFileId}`);
  const { buffer, file } = read;
  const ct =
    file.contentType || file.metadata?.content_type || 'application/octet-stream';
  const finalFilename =
    filename?.trim() || file.filename || `copy-${Date.now()}.bin`;
  // Copies stay in the source attachment's project unless the caller pins one.
  return uploadAttachmentBuffer(projectId || file.metadata?.project_id || undefined, {
    buffer,
    filename: finalFilename,
    contentType: ct,
    ownerType,
    ownerId,
  });
}
```

Replace `listLibraryAttachments` (lines 127–132) with:

```js
export async function listLibraryAttachments(projectId) {
  const pid = await resolveProjectId(projectId);
  return filesCol()
    .find({ 'metadata.project_id': pid, 'metadata.owner_type': null })
    .sort({ uploadDate: -1 })
    .toArray();
}
```

In `attachToCharacter` (line 278), change the signature line and upload call:

Before:
```js
export async function attachToCharacter({ character, sourceUrl, filename, caption }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const file = await uploadAttachmentFromUrl({
    sourceUrl,
    filename,
    ownerType: 'character',
    ownerId: c._id,
  });
```
After:
```js
export async function attachToCharacter({ projectId, character, sourceUrl, filename, caption }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const file = await uploadAttachmentFromUrl(projectId ?? c.project_id, {
    sourceUrl,
    filename,
    ownerType: 'character',
    ownerId: c._id,
  });
```
(Same Phase-A drift caveat on the `getCharacter` line as in Task 7.)

`src/mongo/client.js` — directly below the `images.files` project index added in Task 7, add:

```js
  await db
    .collection('attachments.files')
    .createIndex({ 'metadata.project_id': 1, 'metadata.owner_type': 1 });
```

- [ ] **Step 4: Mechanical sweep — src call sites.**

Enumerate:

```
grep -rnE "(uploadAttachmentBuffer|uploadAttachmentFromUrl)\(\{" src/ | grep -v "src/mongo/attachments.js"
```

Sites (11 total):

```
src/web/entityRoutes.js:838,1282,1796,2429,3708,3784,4760   uploadAttachmentBuffer
src/agent/handlers.js:1583,2091,2732                        Attachments.uploadAttachmentFromUrl
src/web/falVideoGenerate.js:740                             uploadAttachmentBuffer
```

Uniform transformation — insert `undefined, `:

```
uploadAttachmentBuffer({               →  uploadAttachmentBuffer(undefined, {
Attachments.uploadAttachmentFromUrl({  →  Attachments.uploadAttachmentFromUrl(undefined, {
```

Real example 1 — `src/agent/handlers.js:2091` (`add_library_attachment`):

```js
    const file = await Attachments.uploadAttachmentFromUrl({
      sourceUrl: source_url,
      filename,
      ownerType: null,
      ownerId: null,
    });
```
becomes
```js
    const file = await Attachments.uploadAttachmentFromUrl(undefined, {
      sourceUrl: source_url,
      filename,
      ownerType: null,
      ownerId: null,
    });
```

Real example 2 — `src/web/falVideoGenerate.js:740`:

```js
    const file = await uploadAttachmentBuffer({
      buffer,
      filename: `storyboard-${storyboard._id}-video-${Date.now()}.mp4`,
```
becomes
```js
    const file = await uploadAttachmentBuffer(undefined, {
      buffer,
      filename: `storyboard-${storyboard._id}-video-${Date.now()}.mp4`,
```

`copyAttachmentBuffer` call sites (`src/web/gateway.js:1871,1918`) need **no** change — it kept the single-options-object shape and inherits the source file's project. `listLibraryAttachments()` no-arg call sites also stay unchanged here: `src/web/entityRoutes.js:660` and `src/agent/handlers.js:2107` are threaded by Phases C/D; `src/pdf/export.js:561` and `src/web/downloads.js:194` by Task 20 pre-flip threading; `src/web/roomRegistry.js:617` stays on the default project until a later task threads it.

Verification — expects **zero matches**:

```
grep -rnE "(uploadAttachmentBuffer|uploadAttachmentFromUrl)\(\{" src/ scripts/
```

- [ ] **Step 5: Mechanical sweep — test mocks and assertions.**

Three files reference the first argument:

`tests/audio-mp3-upload.test.js:32` — mock destructures arg 1:
```js
  uploadAttachmentBuffer: vi.fn(async ({ buffer, filename, contentType, ownerType, ownerId }) => {
```
becomes
```js
  uploadAttachmentBuffer: vi.fn(async (_projectId, { buffer, filename, contentType, ownerType, ownerId }) => {
```

`tests/fal-video-generate.test.js:65` — positional `args`:
```js
  uploadAttachmentBuffer: vi.fn(async (args) => {
```
becomes
```js
  uploadAttachmentBuffer: vi.fn(async (_projectId, args) => {
```

`tests/attachments.test.js:296` — exact-arg-list assertion; the handler now calls with two args:
```js
    expect(Attachments.uploadAttachmentFromUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: 'https://cdn.discord.com/x/recording.ogg',
        ownerType: 'beat',
      }),
```
becomes
```js
    expect(Attachments.uploadAttachmentFromUrl).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        sourceUrl: 'https://cdn.discord.com/x/recording.ogg',
        ownerType: 'beat',
      }),
```

`tests/dialog-audio-gateway.test.js:95` and `tests/storyboard-media-reference-gateway.test.js:70` assert on `copyAttachmentBuffer` with `expect.objectContaining` — unchanged (options-object shape kept; `objectContaining` tolerates the absent/extra `projectId` key). The `attachToCharacter` exact-object assertion at `tests/attachments.test.js:392` is also unchanged in this task (the handler doesn't pass `projectId` until Phase C).

Verification — expects **zero matches**:

```
grep -rnE "(uploadAttachmentBuffer|uploadAttachmentFromUrl)(: vi\.fn\()?\(?async \(\{" tests/
```

- [ ] **Step 6: Run — expect PASS.**

```
npx vitest run tests/library-attachment-attach.test.js tests/attachments.test.js tests/audio-mp3-upload.test.js tests/fal-video-generate.test.js tests/dialog-audio-gateway.test.js tests/storyboard-media-reference-gateway.test.js
```
Expected: all pass. Then `npm test` → green.

- [ ] **Step 7: Commit.**

```
git add src/mongo/attachments.js src/mongo/client.js src/web/entityRoutes.js \
  src/agent/handlers.js src/web/falVideoGenerate.js \
  tests/library-attachment-attach.test.js tests/attachments.test.js \
  tests/audio-mp3-upload.test.js tests/fal-video-generate.test.js
git commit -m "✨ Scope attachments GridFS bucket by project"
```

---

### Task 9: RAG — project metadata on chunks, project-filtered query helper, reindex loop

**Files:**
- Modify: `src/rag/indexer.js` (`buildChunksForField` 45–73, `indexBeat` 158–182, `indexCharacter` 184–217, `indexDirectorNote` 219–236, `indexMessage` 239–268)
- Create: `src/rag/query.js`
- Modify: `scripts/reindex-rag.js`
- Test: `tests/rag-indexer.test.js` (extend), `tests/rag-query.test.js` (new)

**Design notes (why no `projectId` parameter on the indexers):** the reindex queue dispatches on `"<entityType>:<entityId>"` keys with no project info, and changing the key format would ripple through every `enqueueReindex` site. Instead each indexer derives the project from the owning Mongo doc: beats from the containing `plots` doc (looked up by `{'beats._id': oid}` — this also fixes the spec-flagged `{_id:'main'}` lockstep duplicate in the `rag_indexed_at` stamp), characters from `characters.project_id`, director notes from the composite prompts `_id` prefix (`<projectId>:director_notes`), messages from `messageDoc.project_id`. All fall back through `resolveProjectId` (falsy → default project), so legacy/unstamped docs index into the default project. `indexCharacter` switches from `getCharacter(idStr(...))` (which also accepted names) to an id-only collection lookup — every existing caller (queue, script, handlers) passes an `_id`.

**Contract for Phase C (handler threading — do NOT wire the handler in this task):** `src/agent/handlers.js#screenplay_search` (line 3275) currently inlines the Chroma query. Phase C replaces that inline body with:

```js
  async screenplay_search({ query, k, entity_types } = {}, context) {
    if (!query || typeof query !== 'string') return 'Error: `query` is required.';
    const { searchScreenplay } = await import('../rag/query.js');
    const res = await searchScreenplay(context?.projectId, query, {
      k,
      entityTypes: Array.isArray(entity_types) ? entity_types : undefined,
    });
    if (!res.ok) return res.message;
    return compact({ query, match_count: res.hits.length, results: res.hits });
  },
```

The function this task defines and that Phase C calls:

```js
searchScreenplay(projectId, query, { k, entityTypes } = {})
// → { ok: true,  hits: [{ id, score, entity_type, entity_id, entity_label, field, text }] }
// → { ok: false, reason: 'disabled' | 'unreachable' | 'embedding_error' | 'query_error', message: string }
// Never throws. projectId falsy → default project (transitional resolveProjectId).
```

- [ ] **Step 1: Write the failing indexer tests (extend `tests/rag-indexer.test.js`).**

The new tests seed docs directly into the fake (self-contained — no dependence on Phase A's plots/characters helper signatures). Add the import after line 41 (`const Indexer = ...`):

```js
const Projects = await import('../src/mongo/projects.js');
```

Append this describe block at the end of the file:

```js
describe('rag indexer — project metadata', () => {
  it('indexBeat stamps project_id from the owning plot doc and re-keys the rag_indexed_at stamp', async () => {
    const project = await Projects.createProject('Project A');
    const pidA = project._id.toString();
    const beatId = new ObjectId();
    const plotId = new ObjectId();
    fakeDb.collection('plots')._docs.push({
      _id: plotId,
      project_id: pidA,
      beats: [{ _id: beatId, order: 0, name: 'Diner', desc: 'They meet.', body: 'A short body.', images: [] }],
    });

    await Indexer.indexBeat(beatId);

    const meta = fakeChroma._store.get(`beat:${beatId.toString()}:name`).metadata;
    expect(meta.project_id).toBe(pidA);
    const plotAfter = await fakeDb.collection('plots').findOne({ _id: plotId });
    expect(plotAfter.beats[0].rag_indexed_at).toBeInstanceOf(Date);
  });

  it('indexCharacter stamps project_id from the character doc', async () => {
    const project = await Projects.createProject('Project A');
    const pidA = project._id.toString();
    const charId = new ObjectId();
    fakeDb.collection('characters')._docs.push({
      _id: charId,
      project_id: pidA,
      name: 'Alice',
      name_lower: 'alice',
      hollywood_actor: '',
      fields: {},
    });

    await Indexer.indexCharacter(charId);

    const meta = fakeChroma._store.get(`character:${charId.toString()}:name`).metadata;
    expect(meta.project_id).toBe(pidA);
  });

  it('indexDirectorNote stamps project_id from the composite prompts _id', async () => {
    const project = await Projects.createProject('Project A');
    const pidA = project._id.toString();
    const noteId = new ObjectId();
    fakeDb.collection('prompts')._docs.push({
      _id: `${pidA}:director_notes`,
      notes: [{ _id: noteId, text: 'No fast cuts under 90 seconds.' }],
    });

    await Indexer.indexDirectorNote(noteId);

    const meta = fakeChroma._store.get(`director_note:${noteId.toString()}:text:0`).metadata;
    expect(meta.project_id).toBe(pidA);
  });

  it('legacy entities without project info index into the default project', async () => {
    const defaultPid = (await Projects.getDefaultProject())._id.toString();
    const noteId = new ObjectId();
    fakeDb.collection('prompts')._docs.push({
      _id: 'director_notes',
      notes: [{ _id: noteId, text: 'Legacy note before re-key.' }],
    });

    await Indexer.indexDirectorNote(noteId);

    const meta = fakeChroma._store.get(`director_note:${noteId.toString()}:text:0`).metadata;
    expect(meta.project_id).toBe(defaultPid);
  });

  it('indexMessage stamps project_id from the message doc', async () => {
    const project = await Projects.createProject('Project A');
    const pidA = project._id.toString();
    const oid = new ObjectId();
    await Indexer.indexMessage({
      _id: oid,
      role: 'user',
      channel_id: '0',
      project_id: pidA,
      content: 'Hello from project A.',
      author: { tag: 'steve' },
      created_at: new Date('2026-06-01T00:00:00Z'),
    });

    const meta = fakeChroma._store.get(`message:${oid.toString()}`).metadata;
    expect(meta.project_id).toBe(pidA);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

```
npx vitest run tests/rag-indexer.test.js
```

Expected: the five new tests fail. `indexBeat`/`indexDirectorNote` ones fail with `TypeError: Cannot read properties of undefined (reading 'metadata')` (the seeded non-default-project docs aren't found through the project-resolving `getPlot()`/`getDirectorNotes()` paths, so no chunks were written); the `indexCharacter`/`indexMessage`/legacy ones fail with `expected undefined to be '68…'` (no `project_id` in chunk metadata yet). Pre-existing tests pass.

- [ ] **Step 3: Implement the indexer changes (complete code).**

In `src/rag/indexer.js`, replace the entity-helper imports (lines 26–28):

```js
import { getPlot } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
```
with:

```js
import { resolveProjectId } from '../mongo/projects.js';
```

Add below `idStr` (line 34):

```js
function asObjectId(id) {
  if (id instanceof ObjectId) return id;
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}
```

In `buildChunksForField` (line 45), add `projectId` to the destructured params and the metadata:

```js
function buildChunksForField({ entityType, entityId, entityLabel, field, markdown, projectId }) {
```
and in the returned chunk metadata (lines 62–70), add `project_id` after `entity_label`:

```js
      metadata: {
        entity_type: entityType,
        entity_id: idStr(entityId),
        entity_label: entityLabel,
        project_id: projectId || null,
        field,
        chunk_index: i,
        text_md: c.text_md,
        updated_at: new Date().toISOString(),
      },
```

Replace `indexBeat` (lines 158–182) with:

```js
export async function indexBeat(beatId) {
  return safeRun(`beat:${beatId}`, async (col) => {
    // Locate the owning plot doc directly (one doc per project) — the queue
    // key carries no project, so the beat's host doc is the source of truth.
    const oid = asObjectId(beatId);
    const plotDoc = oid
      ? await getDb().collection('plots').findOne({ 'beats._id': oid })
      : null;
    const beat = plotDoc
      ? (plotDoc.beats || []).find((b) => b._id && idStr(b._id) === idStr(beatId))
      : null;
    if (!beat) {
      // Entity gone — clean up any chunks for it.
      try { await col.delete({ where: { $and: [{ entity_type: 'beat' }, { entity_id: idStr(beatId) }] } }); } catch {}
      return;
    }
    const projectId = await resolveProjectId(plotDoc.project_id);
    const label = entityLabelOf('beat', beat);
    const chunks = [
      ...buildChunksForField({ entityType: 'beat', entityId: beat._id, entityLabel: label, field: 'name', markdown: beat.name, projectId }),
      ...buildChunksForField({ entityType: 'beat', entityId: beat._id, entityLabel: label, field: 'desc', markdown: beat.desc, projectId }),
      ...buildChunksForField({ entityType: 'beat', entityId: beat._id, entityLabel: label, field: 'body', markdown: beat.body, projectId }),
    ];
    await syncEntityChunks(col, 'beat', beat._id, chunks);
    // Stamp rag_indexed_at into the embedded beat for resumable backfill.
    try {
      await getDb().collection('plots').updateOne(
        { _id: plotDoc._id, 'beats._id': beat._id },
        { $set: { 'beats.$.rag_indexed_at': new Date() } },
      );
    } catch {}
  });
}
```

Replace `indexCharacter` (lines 184–217) with:

```js
export async function indexCharacter(characterId) {
  return safeRun(`character:${characterId}`, async (col) => {
    // Id-only lookup (every caller passes an _id); the doc's own project_id
    // is the source of truth for chunk metadata.
    const oid = asObjectId(characterId);
    const c = oid ? await getDb().collection('characters').findOne({ _id: oid }) : null;
    if (!c) {
      try { await col.delete({ where: { $and: [{ entity_type: 'character' }, { entity_id: idStr(characterId) }] } }); } catch {}
      return;
    }
    const projectId = await resolveProjectId(c.project_id);
    const label = entityLabelOf('character', c);
    const chunks = [
      ...buildChunksForField({ entityType: 'character', entityId: c._id, entityLabel: label, field: 'name', markdown: c.name, projectId }),
      ...buildChunksForField({ entityType: 'character', entityId: c._id, entityLabel: label, field: 'hollywood_actor', markdown: c.hollywood_actor, projectId }),
    ];
    const fields = (c.fields && typeof c.fields === 'object') ? c.fields : {};
    for (const [k, v] of Object.entries(fields)) {
      const text = typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
      chunks.push(
        ...buildChunksForField({
          entityType: 'character',
          entityId: c._id,
          entityLabel: label,
          field: `fields.${k}`,
          markdown: text,
          projectId,
        }),
      );
    }
    await syncEntityChunks(col, 'character', c._id, chunks);
    try {
      await getDb().collection('characters').updateOne(
        { _id: c._id },
        { $set: { rag_indexed_at: new Date() } },
      );
    } catch {}
  });
}
```

Replace `indexDirectorNote` (lines 219–236) with:

```js
export async function indexDirectorNote(noteId) {
  return safeRun(`director_note:${noteId}`, async (col) => {
    const oid = asObjectId(noteId);
    const doc = oid
      ? await getDb().collection('prompts').findOne({ 'notes._id': oid })
      : null;
    const note = doc
      ? (doc.notes || []).find((n) => n._id && idStr(n._id) === idStr(noteId))
      : null;
    if (!note) {
      try { await col.delete({ where: { $and: [{ entity_type: 'director_note' }, { entity_id: idStr(noteId) }] } }); } catch {}
      return;
    }
    // Composite prompts ids are '<projectId>:director_notes'; the legacy
    // pre-migration id 'director_notes' has no prefix → default project.
    const docId = String(doc._id);
    const projectId = await resolveProjectId(docId.includes(':') ? docId.split(':')[0] : null);
    const chunks = buildChunksForField({
      entityType: 'director_note',
      entityId: note._id,
      entityLabel: 'note',
      field: 'text',
      markdown: note.text,
      projectId,
    });
    await syncEntityChunks(col, 'director_note', note._id, chunks);
  });
}
```

In `indexMessage` (lines 239–268), add the project resolve and metadata key. After `const id = ...` (line 245), the metadata object becomes:

```js
    const id = `message:${idStr(messageDoc._id)}`;
    const projectId = await resolveProjectId(messageDoc.project_id);
    const metadata = {
      entity_type: 'message',
      entity_id: idStr(messageDoc._id),
      entity_label: entityLabelOf('message', messageDoc),
      project_id: projectId,
      field: 'content',
      chunk_index: 0,
      text_md,
      channel_id: messageDoc.channel_id || null,
      role: messageDoc.role || null,
      created_at: messageDoc.created_at instanceof Date
        ? messageDoc.created_at.toISOString()
        : (messageDoc.created_at ? String(messageDoc.created_at) : null),
      updated_at: new Date().toISOString(),
    };
```

`deleteEntity`, `pruneMessagesOlderThan`, `reindexByKey`, and `_internals` are unchanged (entity ids are globally unique; pruning stays channel-scoped).

- [ ] **Step 4: Run the indexer tests — expect PASS.**

```
npx vitest run tests/rag-indexer.test.js
```
Expected: all pass, including the five new project-metadata tests.

- [ ] **Step 5: Write the failing query-helper test (new file `tests/rag-query.test.js`).**

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import { createFakeChroma } from './_fakeChroma.js';

const fakeDb = createFakeDb();
const fakeChroma = createFakeChroma();

let ragEnabled = true;
let chromaUp = true;

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/rag/chromaClient.js', () => ({
  isRagEnabled: () => ragEnabled,
  getCollection: async () => (chromaUp ? fakeChroma : null),
  chromaHealthcheck: async () => chromaUp,
  resetForTests: () => {},
}));

function fakeVector(text, dim = 16) {
  const v = new Array(dim).fill(0);
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    v[i % dim] += s.charCodeAt(i) / 255;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

vi.mock('../src/rag/embeddings.js', () => ({
  embedTexts: vi.fn(async (texts) => texts.map((t) => fakeVector(t))),
  RagDisabledError: class extends Error {},
}));

const Projects = await import('../src/mongo/projects.js');
const { searchScreenplay } = await import('../src/rag/query.js');

beforeEach(() => {
  fakeDb.reset();
  fakeChroma._store.clear();
  ragEnabled = true;
  chromaUp = true;
});

async function seedChunk({ id, text, projectId, entityType = 'beat' }) {
  await fakeChroma.upsert({
    ids: [id],
    embeddings: [fakeVector(text)],
    metadatas: [{
      entity_type: entityType,
      entity_id: id,
      entity_label: text.slice(0, 20),
      project_id: projectId,
      field: 'body',
      chunk_index: 0,
      text_md: text,
    }],
    documents: [text],
  });
}

describe('searchScreenplay', () => {
  it('filters hits to the given project', async () => {
    const a = await Projects.createProject('Project A');
    const b = await Projects.createProject('Project B');
    const pidA = a._id.toString();
    const pidB = b._id.toString();
    await seedChunk({ id: 'beat:1:body:0', text: 'a tense diner argument', projectId: pidA });
    await seedChunk({ id: 'beat:2:body:0', text: 'a tense diner argument', projectId: pidB });

    const res = await searchScreenplay(pidA, 'diner argument');
    expect(res.ok).toBe(true);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].id).toBe('beat:1:body:0');
    expect(res.hits[0].text).toBe('a tense diner argument');
    expect(typeof res.hits[0].score).toBe('number');
  });

  it('falsy projectId resolves to the default project (transitional)', async () => {
    const defaultPid = (await Projects.getDefaultProject())._id.toString();
    const other = await Projects.createProject('Other');
    await seedChunk({ id: 'beat:def:body:0', text: 'default project beat', projectId: defaultPid });
    await seedChunk({ id: 'beat:oth:body:0', text: 'default project beat', projectId: other._id.toString() });

    const res = await searchScreenplay(undefined, 'default project beat');
    expect(res.ok).toBe(true);
    expect(res.hits.map((h) => h.id)).toEqual(['beat:def:body:0']);
  });

  it('combines the project filter with entityTypes', async () => {
    const a = await Projects.createProject('Project A');
    const pidA = a._id.toString();
    await seedChunk({ id: 'beat:3:body:0', text: 'rooftop chase at night', projectId: pidA, entityType: 'beat' });
    await seedChunk({ id: 'character:9:name', text: 'rooftop chase at night', projectId: pidA, entityType: 'character' });

    const res = await searchScreenplay(pidA, 'rooftop chase', { entityTypes: ['character'] });
    expect(res.ok).toBe(true);
    expect(res.hits.map((h) => h.id)).toEqual(['character:9:name']);
  });

  it('returns ok:false reason:disabled when RAG is not configured', async () => {
    ragEnabled = false;
    const res = await searchScreenplay(undefined, 'anything');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('disabled');
    expect(res.message).toMatch(/VOYAGE_API_KEY/);
  });

  it('returns ok:false reason:unreachable when Chroma is down', async () => {
    chromaUp = false;
    const res = await searchScreenplay(undefined, 'anything');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unreachable');
    expect(res.message).toMatch(/ChromaDB not reachable/);
  });
});
```

- [ ] **Step 6: Run it — expect FAIL.**

```
npx vitest run tests/rag-query.test.js
```
Expected failure: `Error: Failed to load url ../src/rag/query.js` / `Cannot find module` — the module does not exist yet.

- [ ] **Step 7: Create `src/rag/query.js` (complete code).**

```js
// Project-scoped semantic search over the Chroma screenplay index.
//
// searchScreenplay(projectId, query, opts) is the single query entry point:
// the screenplay_search agent handler (and any future REST search endpoint)
// calls this instead of talking to chromaClient directly. It never throws —
// failures come back as { ok: false, reason, message } with a user-facing
// message string the handler can return verbatim.
//
//   searchScreenplay(projectId, query, { k, entityTypes } = {})
//     → { ok: true,  hits: [{ id, score, entity_type, entity_id, entity_label, field, text }] }
//     → { ok: false, reason: 'disabled' | 'unreachable' | 'embedding_error' | 'query_error', message }
//
// projectId is a 24-hex string; falsy → default project (transitional
// resolveProjectId semantics, strict after the Phase F flip).

import { config } from '../config.js';
import { isRagEnabled, getCollection } from './chromaClient.js';
import { embedTexts } from './embeddings.js';
import { resolveProjectId } from '../mongo/projects.js';

export async function searchScreenplay(projectId, query, { k, entityTypes } = {}) {
  if (!isRagEnabled()) {
    return {
      ok: false,
      reason: 'disabled',
      message:
        'Semantic search is unavailable: VOYAGE_API_KEY is not configured. Use `search_beats` / `search_characters` / `search_message_history` as alternatives.',
    };
  }
  const col = await getCollection();
  if (!col) {
    return {
      ok: false,
      reason: 'unreachable',
      message:
        'Semantic search is temporarily unavailable: ChromaDB not reachable (run `docker compose up -d chroma`). Falling back: try `search_beats` / `search_characters` / `search_message_history`.',
    };
  }
  const pid = await resolveProjectId(projectId);
  const topK = Math.min(20, Math.max(1, Number(k) || config.rag.defaultK));
  const clauses = [{ project_id: pid }];
  if (Array.isArray(entityTypes) && entityTypes.length) {
    clauses.push(
      entityTypes.length === 1
        ? { entity_type: entityTypes[0] }
        : { entity_type: { $in: entityTypes } },
    );
  }
  const where = clauses.length === 1 ? clauses[0] : { $and: clauses };
  let queryVec;
  try {
    [queryVec] = await embedTexts([query], { inputType: 'query' });
  } catch (e) {
    return {
      ok: false,
      reason: 'embedding_error',
      message: `Semantic search failed (embedding error): ${e.message}`,
    };
  }
  let res;
  try {
    res = await col.query({ queryEmbeddings: [queryVec], nResults: topK, where });
  } catch (e) {
    return {
      ok: false,
      reason: 'query_error',
      message: `Semantic search failed (chroma query error): ${e.message}`,
    };
  }
  const ids = res?.ids?.[0] || [];
  const distances = res?.distances?.[0] || [];
  const metadatas = res?.metadatas?.[0] || [];
  const documents = res?.documents?.[0] || [];
  const hits = ids.map((id, i) => {
    const m = metadatas[i] || {};
    const dist = typeof distances[i] === 'number' ? distances[i] : null;
    const score = dist == null ? null : Math.max(0, Math.min(1, 1 - dist));
    return {
      id,
      score: score == null ? null : Number(score.toFixed(4)),
      entity_type: m.entity_type || null,
      entity_id: m.entity_id || null,
      entity_label: m.entity_label || null,
      field: m.field || null,
      text: m.text_md || documents[i] || '',
    };
  });
  return { ok: true, hits };
}
```

(The error-message strings, score math, and hit shape are copied verbatim from the current inline handler at `src/agent/handlers.js:3275-3333` so Phase C's rewiring is behavior-preserving.)

- [ ] **Step 8: Run — expect PASS.**

```
npx vitest run tests/rag-query.test.js
```
Expected: all 5 tests pass.

- [ ] **Step 9: Make `scripts/reindex-rag.js` loop all projects.**

Add to the imports (after the `getDirectorNotes` import, line 26):

```js
import { listProjects, getDefaultProject } from '../src/mongo/projects.js';
```

Replace the body of `main()` from `const types = args.types;` (line 85) through the end of the `director_note` block (line 121) with:

```js
  const types = args.types;
  const want = (t) => !types || types.has(t);
  const messageCap = Number(args.messages) || config.rag.messageWindow;

  const projects = await listProjects();
  if (!projects.length) projects.push(await getDefaultProject());
  console.log(`projects: ${projects.length}`);

  for (const project of projects) {
    const pid = project._id.toString();
    console.log(`\n=== project "${project.title}" (${pid}) ===`);

    if (want('beat')) {
      const plot = await getPlot(pid);
      const beats = plot.beats || [];
      console.log(`beats: ${beats.length} candidates`);
      const stats = await runConcurrent(beats, async (b) => {
        if (args.since && isAfter(b.rag_indexed_at, args.since)) return 'skip';
        await indexBeat(b._id);
        return 'ok';
      });
      console.log(`beats: ok=${stats.ok} skipped=${stats.skip} err=${stats.err}`);
    }

    if (want('character')) {
      const chars = await findAllCharacters(pid);
      console.log(`characters: ${chars.length} candidates`);
      const stats = await runConcurrent(chars, async (c) => {
        if (args.since && isAfter(c.rag_indexed_at, args.since)) return 'skip';
        await indexCharacter(c._id);
        return 'ok';
      });
      console.log(`characters: ok=${stats.ok} skipped=${stats.skip} err=${stats.err}`);
    }

    if (want('director_note')) {
      const doc = await getDirectorNotes(pid);
      const notes = doc.notes || [];
      console.log(`director_notes: ${notes.length} candidates`);
      const stats = await runConcurrent(notes, async (n) => {
        await indexDirectorNote(n._id);
        return 'ok';
      });
      console.log(`director_notes: ok=${stats.ok} err=${stats.err}`);
    }
  }
```

The `message` block (lines 123–135) stays **outside** the project loop and unchanged — messages are channel-scoped, and `indexMessage` stamps `project_id` from each doc. (`getPlot(pid)` / `findAllCharacters(pid)` / `getDirectorNotes(pid)` are the Phase A signatures; if Phase A is not yet merged when this runs, do not start this task.)

There is no test harness for scripts; verify by syntax check:

```
node --check scripts/reindex-rag.js
```
Expected: no output, exit 0.

- [ ] **Step 10: Full suite + commit.**

```
npm test
```
Expected: green (notably `tests/rag-indexer.test.js`, `tests/rag-query.test.js`, `tests/rag-handler.test.js` — the handler is untouched this task, and chunk metadata gains are additive).

```
git add src/rag/indexer.js src/rag/query.js scripts/reindex-rag.js tests/rag-indexer.test.js tests/rag-query.test.js
git commit -m "✨ Stamp RAG chunks with project_id and add project-filtered searchScreenplay"
```

---

### Phase B exit criteria

- `npx vitest run tests/images-bucket.test.js tests/library-attachment-attach.test.js tests/rag-indexer.test.js tests/rag-query.test.js` → all pass.
- `npm test` → green.
- `grep -rnE "(uploadGeneratedImage|uploadImageFromUrl|uploadAttachmentBuffer|uploadAttachmentFromUrl)\(\{" src/ scripts/ tests/` → zero matches (no caller left on the old single-options-object shape).
- Phase C/D pickup points: replace the `undefined` placeholder first args (`grep -rn "uploadGeneratedImage(undefined" src/` etc., plus `grep -rn "listImagesForBeat(undefined\|listImagesForCharacter(undefined" src/`) with `context.projectId` / `req.projectId` — the entityRoutes lister sites go to Tasks 14/15, the `src/web/downloads.js:145` lister site to Task 20 pre-flip threading; rewire `screenplay_search` to `searchScreenplay(context.projectId, query, { k, entityTypes })`.
## Phase C: Agent loop, handlers & set_project (Tasks 10–13)

**Depends on:** Section A's `src/mongo/projects.js` (`createProject`, `listProjects`, `getProjectByTitle`, `getProjectById`, `getDefaultProject`, `resolveProjectId`) and Section B's re-signed Mongo helpers (`getPlot(projectId)`, `getCharacter(projectId, idOrName)`, `listCharacters(projectId)`, …, plus `searchScreenplay(projectId, query, { k, entityTypes })` from Task 9's `src/rag/query.js`). Every helper still falls back to the default project via the transitional `resolveProjectId`, which is what lets each task below land green on its own.

**Phase invariant:** the agent context object is `{ discordUser, channelId, projectId, projectTitle }`. `projectId` is a 24-hex string; `projectTitle` is the plain-text project title used for `/p/<title>` URLs. `set_project` mutates this object **in place**, so everything that reads project state mid-turn must read it from `context` at call time, never capture it in a local at turn start.

---

### Task 10: Channel project pointer (`src/mongo/channelState.js`)

The agent's per-channel "which project am I in" pointer, following the existing `history_cleared_at` pattern (doc `_id` = Discord channel id, upserted `$set`).

**Files:**
- Modify: `src/mongo/channelState.js` (21 lines today; append two exports)
- Test: `tests/channel-state.test.js` (append a new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/channel-state.test.js`. Update the existing import line (line 11):

```js
const { getHistoryClearedAt, setHistoryClearedAt, getCurrentProjectId, setCurrentProjectId } =
  await import('../src/mongo/channelState.js');
```

Append this block after the existing `describe('channelState', ...)`:

```js
describe('channelState current project pointer', () => {
  const PID_A = 'a'.repeat(24);
  const PID_B = 'b'.repeat(24);

  it('returns null for an unknown channel', async () => {
    expect(await getCurrentProjectId('nope')).toBeNull();
  });

  it('returns null when channelId is empty on get', async () => {
    expect(await getCurrentProjectId('')).toBeNull();
  });

  it('round-trips a project id via upsert', async () => {
    const returned = await setCurrentProjectId('chan-1', PID_A);
    expect(returned).toBe(PID_A);
    expect(await getCurrentProjectId('chan-1')).toBe(PID_A);
  });

  it('overwrites a previous project id on a second call', async () => {
    await setCurrentProjectId('chan-2', PID_A);
    await setCurrentProjectId('chan-2', PID_B);
    expect(await getCurrentProjectId('chan-2')).toBe(PID_B);
  });

  it('keeps project pointer isolated per channel', async () => {
    await setCurrentProjectId('chan-a', PID_A);
    expect(await getCurrentProjectId('chan-a')).toBe(PID_A);
    expect(await getCurrentProjectId('chan-b')).toBeNull();
  });

  it('coexists with history_cleared_at on the same doc', async () => {
    const when = new Date('2026-06-01T10:00:00Z');
    await setHistoryClearedAt('chan-3', when);
    await setCurrentProjectId('chan-3', PID_A);
    expect(await getHistoryClearedAt('chan-3')).toEqual(when);
    expect(await getCurrentProjectId('chan-3')).toBe(PID_A);
  });

  it('rejects an empty channelId on set', async () => {
    await expect(setCurrentProjectId('', PID_A)).rejects.toThrow(/channelId required/);
  });

  it('rejects a non-hex projectId on set', async () => {
    await expect(setCurrentProjectId('chan-4', 'not-a-hex-id')).rejects.toThrow(/24-hex/);
    await expect(setCurrentProjectId('chan-4', null)).rejects.toThrow(/24-hex/);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

```
npx vitest run tests/channel-state.test.js
```

Expected: the original 7 tests pass; the 8 new tests fail with `TypeError: getCurrentProjectId is not a function` / `setCurrentProjectId is not a function`.

- [ ] **Step 3: Implement**

Append to `src/mongo/channelState.js` (after `setHistoryClearedAt`):

```js
const HEX24_RE = /^[a-f0-9]{24}$/i;

export async function getCurrentProjectId(channelId) {
  if (!channelId) return null;
  const doc = await col().findOne({ _id: channelId });
  return typeof doc?.current_project_id === 'string' && doc.current_project_id
    ? doc.current_project_id
    : null;
}

export async function setCurrentProjectId(channelId, projectId) {
  if (!channelId) throw new Error('channelId required');
  if (typeof projectId !== 'string' || !HEX24_RE.test(projectId)) {
    throw new Error('projectId must be a 24-hex string');
  }
  await col().updateOne(
    { _id: channelId },
    { $set: { current_project_id: projectId, updated_at: new Date() } },
    { upsert: true },
  );
  return projectId;
}
```

- [ ] **Step 4: Run the test — expect PASS**

```
npx vitest run tests/channel-state.test.js
```

Expected: all 15 tests pass.

- [ ] **Step 5: Full suite + commit**

```
npm test
git add src/mongo/channelState.js tests/channel-state.test.js
git commit -m "✨ Add current-project pointer to channel state"
```

---

### Task 11: Project context plumbing — messageHandler → runAgent → buildSystem

**Files:**
- Modify: `src/discord/messageHandler.js` (imports at lines 10–18; mutex body lines 109–246)
- Modify: `src/agent/loop.js` (`buildSystem` lines 134–159; `runAgent` signature line 401; context line 428; buildSystem call sites lines 488, 493, 502; `resolveEntityLinks` call sites lines 566, 649; return objects lines 568, 651; set_project hook after line 627)
- Modify: `src/agent/overview.js` (`buildOverview` line 71)
- Modify: `src/agent/entityLinks.js` (`resolveEntityLinks` line 96; new `clearTouchedEntities` export)
- Modify: `src/agent/systemPrompt.js` (`buildVolatileText` line 254; `buildSystemPrompt` line 324)
- Test: `tests/agent-loop-project-context.test.js` (new)

**Design statements (read before executing):**
- `dispatchTool` **already** passes context to every handler — `src/agent/handlers.js:3543` reads `return await fn(decodeEscapes(input) || {}, context);`. No dispatch change is needed in this task; the spec's "only 2 of ~95 receive it" refers to declared handler signatures, which Task 12 sweeps.
- **Mid-turn switch stamping:** `recordAgentTurns` is called with the **final** `context.projectId` — i.e. a mid-turn `set_project` stamps the whole turn's message docs with the project active at turn END. `runAgent` returns `projectId: context.projectId` for this purpose.
- entityLinks gets its **Mongo reads** scoped here; its **URL-builder calls** keep the legacy no-arg/one-arg form until Task 12 re-signs `src/web/links.js` (otherwise this commit would pass a title string where the old builders expect an entity object).

- [ ] **Step 1: Write the failing test**

Create `tests/agent-loop-project-context.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

const messagesCreate = vi.fn();
const countTokensMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: messagesCreate, countTokens: countTokensMock };
    }
  },
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/mongo/characters.js', () => ({
  listCharacters: async () => [],
}));
vi.mock('../src/mongo/prompts.js', () => ({
  getCharacterTemplate: async () => ({ fields: [] }),
  getPlotTemplate: async () => ({ synopsis_guidance: '', beat_guidance: '' }),
}));
vi.mock('../src/mongo/plots.js', () => ({
  getPlot: async () => ({ _id: 'main', beats: [] }),
}));
vi.mock('../src/mongo/directorNotes.js', () => ({
  getDirectorNotes: async () => ({ _id: 'director_notes', notes: [] }),
}));
vi.mock('../src/mongo/imageBytes.js', () => ({
  fetchImageFromUrl: async () => ({ buffer: Buffer.alloc(0), contentType: 'image/png' }),
  ALLOWED_IMAGE_TYPES: new Set(['image/png', 'image/jpeg', 'image/webp']),
}));

const dispatchToolMock = vi.hoisted(() => vi.fn(async () => 'ok'));
vi.mock('../src/agent/handlers.js', () => ({
  dispatchTool: dispatchToolMock,
}));

const entitySpies = vi.hoisted(() => ({ clearTouchedEntities: vi.fn() }));
vi.mock('../src/agent/entityLinks.js', async (importOriginal) => ({
  ...(await importOriginal()),
  clearTouchedEntities: entitySpies.clearTouchedEntities,
}));

const { runAgent } = await import('../src/agent/loop.js');

const PID = 'a1b2c3d4e5f6a1b2c3d4e5f6';

function endTurn(text = 'done') {
  return {
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 10 },
    content: [{ type: 'text', text }],
  };
}

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
  dispatchToolMock.mockReset();
  dispatchToolMock.mockResolvedValue('ok');
  entitySpies.clearTouchedEntities.mockReset();
});

describe('runAgent project context', () => {
  it('passes projectId/projectTitle/channelId to dispatched tool handlers', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 't1', name: 'list_beats', input: {} }],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'list beats',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'My Movie',
    });

    expect(dispatchToolMock).toHaveBeenCalledWith(
      'list_beats',
      {},
      expect.objectContaining({ channelId: 'c1', projectId: PID, projectTitle: 'My Movie' }),
    );
  });

  it('returns the final projectId in the result', async () => {
    messagesCreate.mockResolvedValueOnce(endTurn());
    const result = await runAgent({
      history: [],
      userText: 'hi',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'My Movie',
    });
    expect(result.projectId).toBe(PID);
  });

  it('names the current project in the volatile system block', async () => {
    messagesCreate.mockResolvedValueOnce(endTurn());
    await runAgent({
      history: [],
      userText: 'hi',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'My Movie',
    });
    const system = messagesCreate.mock.calls[0][0].system;
    const joined = system.map((b) => b.text || '').join('\n');
    expect(joined).toContain('Current project: "My Movie"');
  });

  it('a successful set_project clears pre-switch touched entities', async () => {
    dispatchToolMock.mockImplementation(async (name) =>
      name === 'set_project' ? 'Switched to project "B".' : 'ok',
    );
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'update_beat', input: { identifier: '5' } },
        { type: 'tool_use', id: 't2', name: 'set_project', input: { title: 'B' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'switch',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'A',
    });

    expect(entitySpies.clearTouchedEntities).toHaveBeenCalledTimes(1);
  });

  it('a failed set_project does NOT clear touched entities', async () => {
    dispatchToolMock.mockImplementation(async (name) =>
      name === 'set_project'
        ? 'Tool error (set_project): no project titled "B". Available projects: "A".'
        : 'ok',
    );
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 't1', name: 'set_project', input: { title: 'B' } }],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'switch',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'A',
    });

    expect(entitySpies.clearTouchedEntities).not.toHaveBeenCalled();
  });

  it('rebuilds the system prompt for the NEW project on the iteration after a successful set_project', async () => {
    const PID_B = 'b'.repeat(24);
    dispatchToolMock.mockImplementation(async (name, _input, context) => {
      if (name === 'set_project') {
        // Mirrors the real handler (Task 13): mutates the shared context in place.
        context.projectId = PID_B;
        context.projectTitle = 'New Movie';
        return 'Switched to project "New Movie".';
      }
      return 'ok';
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 't1', name: 'set_project', input: { title: 'New Movie' } }],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'switch',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'Old Movie',
    });

    // set_project starts with 'set_' (MUTATING_PREFIXES) → systemDirty flips →
    // the loop rebuilds the system from context.projectId/projectTitle at the
    // top of the next iteration, BEFORE the second messages.create call.
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    const joinSystem = (call) => call[0].system.map((b) => b.text || '').join('\n');
    expect(joinSystem(messagesCreate.mock.calls[0])).toContain('Current project: "Old Movie"');
    expect(joinSystem(messagesCreate.mock.calls[1])).toContain('Current project: "New Movie"');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```
npx vitest run tests/agent-loop-project-context.test.js
```

Expected failures: test 1 fails with `expected "spy" to be called with arguments: [ 'list_beats', {}, ObjectContaining{…} ]` (context lacks `projectId`); test 2 `expected undefined to be 'a1b2c3d4e5f6a1b2c3d4e5f6'`; test 3 `expected '…' to contain 'Current project: "My Movie"'`; test 4 `expected "spy" to be called 1 times, but got 0 times`; test 5 passes vacuously; test 6 fails on its first system assertion — `expected '…' to contain 'Current project: "Old Movie"'` (no project line in the system prompt yet).

- [ ] **Step 3: `src/agent/overview.js` — `buildOverview(projectId)`**

Change line 71:

```js
export async function buildOverview() {
  const [characters, plot, template] = await Promise.all([
    findAllCharacters(),
    getPlot(),
    getCharacterTemplate(),
  ]);
```

becomes

```js
export async function buildOverview(projectId = null) {
  const [characters, plot, template] = await Promise.all([
    findAllCharacters(projectId),
    getPlot(projectId),
    getCharacterTemplate(projectId),
  ]);
```

(The `get_overview` handler call site changes in Task 12's sweep; until then `buildOverview()` resolves the default project via the transitional `resolveProjectId` inside the helpers.)

- [ ] **Step 4: `src/agent/entityLinks.js` — scoped reads + `clearTouchedEntities`**

Change the `resolveEntityLinks` signature and its three Mongo reads (the URL-builder calls stay legacy-form until Task 12):

```js
export async function resolveEntityLinks(touched, context = null) {
```

Inside, the current-beat resolver (lines 116–124):

```js
        currentBeatPromise = safeCall(async () => {
          const plot = await getPlot();
```
becomes
```js
        currentBeatPromise = safeCall(async () => {
          const plot = await getPlot(context?.projectId);
```

Line 128:

```js
      beat = await safeCall(() => getBeat(ref));
```
becomes
```js
      beat = await safeCall(() => getBeat(context?.projectId, ref));
```

Line 135:

```js
    const character = await safeCall(() => getCharacter(ref));
```
becomes
```js
    const character = await safeCall(() => getCharacter(context?.projectId, ref));
```

Append after `createTouchedEntities` (line 156):

```js
// Drop every touch accumulated so far. Called by the agent loop when a
// set_project succeeds mid-turn: pre-switch refs belong to the previous
// project and must not be resolved into links against the new one.
export function clearTouchedEntities(touched) {
  if (!touched) return;
  touched.beats.clear();
  touched.characters.clear();
  touched.notes = false;
}
```

- [ ] **Step 5: `src/agent/systemPrompt.js` — `# Current project` volatile line**

`buildVolatileText` (line 254) gains `projectTitle`:

```js
function buildVolatileText({ characters, plot, directorNotes, senderName, projectTitle }) {
```

and its return statement (line 311) changes from:

```js
  return `# Current state
${titleLine}${senderLine}
```

to:

```js
  const projectLine = projectTitle
    ? `Current project: "${projectTitle}". Every read and write below applies to this project only.\n`
    : '';

  return `# Current state
${projectLine}${titleLine}${senderLine}
```

`buildSystemPrompt` (line 324) gains the param and threads it:

```js
export function buildSystemPrompt({
  characters,
  characterTemplate,
  plotTemplate,
  plot,
  directorNotes,
  cache = true,
  botName = 'Screenplay Bot',
  senderName = null,
  webBaseUrl = spaBaseUrl(),
  reviewMode = false,
  projectTitle = null,
}) {
  const stable = buildStableText({ characterTemplate, plotTemplate, botName, webBaseUrl });
  const volatile = buildVolatileText({ characters, plot, directorNotes, senderName, projectTitle });
```

**Note:** the *stable* switch-guidance text (a `# Projects` section in `buildStableText`, inserted between the `# Web UI` block and `# Character template`) is added in **Task 13** together with the `set_project` tool it describes — adding guidance for a tool that doesn't exist yet would invite hallucinated calls.

- [ ] **Step 6: `src/agent/loop.js` — context, buildSystem threading, set_project hook, return values**

(a) Import `clearTouchedEntities` — lines 7–12 become:

```js
import {
  recordEntityTouch,
  resolveEntityLinks,
  appendEntityLinks,
  createTouchedEntities,
  clearTouchedEntities,
} from './entityLinks.js';
```

(b) `buildSystem` (lines 134–159) gains `projectId`/`projectTitle` and threads its five reads:

```js
async function buildSystem({
  omitDirectorNotes = false,
  cache = config.cache.enabled,
  senderName = null,
  reviewMode = false,
  projectId = null,
  projectTitle = null,
} = {}) {
  const [characters, characterTemplate, plotTemplate, plot, directorNotes] =
    await Promise.all([
      listCharacters(projectId),
      getCharacterTemplate(projectId),
      getPlotTemplate(projectId),
      getPlot(projectId),
      getDirectorNotes(projectId),
    ]);
  return buildSystemPrompt({
    characters,
    characterTemplate,
    plotTemplate,
    plot,
    directorNotes: omitDirectorNotes ? null : directorNotes,
    cache,
    botName: getBotDisplayName(),
    senderName,
    reviewMode,
    projectTitle,
  });
}
```

(c) `runAgent` signature (line 401) gains the two params:

```js
export async function runAgent({
  history,
  userText,
  attachments = [],
  discordUser = null,
  channelId = null,
  enhancementNotes = null,
  projectId = null,
  projectTitle = null,
}) {
```

(d) Context (line 428):

```js
  const context = { discordUser, channelId };
```
becomes
```js
  const context = { discordUser, channelId, projectId, projectTitle };
```

(e) All three `buildSystem` call sites read from `context` (NOT the destructured params — `set_project` mutates `context` in place and the post-mutation rebuild must see the new project). Line 488:

```js
    let cachedSystem = await buildSystem({ senderName, reviewMode });
```
becomes
```js
    let cachedSystem = await buildSystem({
      senderName,
      reviewMode,
      projectId: context.projectId,
      projectTitle: context.projectTitle,
    });
```

Line 493 (`if (systemDirty) { cachedSystem = await buildSystem({ senderName, reviewMode }); …`) and line 502 (`const systemNoDirectorNotes = await buildSystem({ omitDirectorNotes: true, senderName, reviewMode });`) get the identical two extra keys.

(f) set_project clearing hook — insert between the `realResults` dispatch (line 618–627) and the `recordEntityTouch` loop (line 629):

```js
      // A successful set_project invalidates every entity touched so far this
      // turn: those refs belong to the pre-switch project. Drop them so the
      // end-of-turn link resolution can't mislink into the new project.
      // (Touches recorded below for THIS batch resolve against the final
      // project at end of turn; pre-switch ids simply fail as not-found and
      // are dropped by resolveEntityLinks' safeCall.)
      const switchedProject = realToolUses.some((tu) => {
        if (tu.name !== 'set_project') return false;
        const res = realResults.find((r) => r.tool_use_id === tu.id);
        return !!res && !res.is_error;
      });
      if (switchedProject) {
        const dropped =
          touchedEntities.beats.size +
          touchedEntities.characters.size +
          (touchedEntities.notes ? 1 : 0);
        if (dropped) {
          logger.info(`set_project: dropped ${dropped} pre-switch touched entity ref(s)`);
        }
        clearTouchedEntities(touchedEntities);
      }
```

(`set_project` starts with `set_`, which is already in `MUTATING_PREFIXES`, so `systemDirty` flips and the next iteration rebuilds the system prompt from `context.projectId` — no extra code needed for that.)

(g) Both `resolveEntityLinks` call sites (lines 566 and 649):

```js
        const entityUrls = await resolveEntityLinks(touchedEntities);
```
becomes
```js
        const entityUrls = await resolveEntityLinks(touchedEntities, context);
```

(h) Both return objects (lines 568–573 and 651–656) gain the final project id:

```js
        return {
          text: finalText,
          attachmentPaths,
          attachmentLinks,
          projectId: context.projectId,
          agentMessages: messages.slice(agentStart),
        };
```

- [ ] **Step 7: `src/discord/messageHandler.js` — resolve the project inside the mutex**

(a) Imports — line 16 becomes:

```js
import {
  getHistoryClearedAt,
  getCurrentProjectId,
  setCurrentProjectId,
} from '../mongo/channelState.js';
import { getDefaultProject, getProjectById } from '../mongo/projects.js';
```

(b) Inside the mutex callback, hoist project vars and resolve. Line 111–113:

```js
    logger.info(`entered channel mutex after ${Date.now() - mutexT0}ms`);
    let typingTimer;
    let attachmentPaths = [];
    try {
      fireAndForgetTyping(msg.channel);
      typingTimer = setInterval(() => fireAndForgetTyping(msg.channel), 8000);
```
becomes
```js
    logger.info(`entered channel mutex after ${Date.now() - mutexT0}ms`);
    let typingTimer;
    let attachmentPaths = [];
    let projectId = null;
    let projectTitle = null;
    try {
      fireAndForgetTyping(msg.channel);
      typingTimer = setInterval(() => fireAndForgetTyping(msg.channel), 8000);

      // Resolve the channel's active project (inside the mutex, so a
      // set_project from a concurrent message can never race this read).
      projectId = await loggedStep('mongo getCurrentProjectId', () =>
        getCurrentProjectId(msg.channelId),
      );
      let project = projectId ? await getProjectById(projectId) : null;
      if (!project) {
        project = await getDefaultProject();
        projectId = project._id.toString();
        await setCurrentProjectId(msg.channelId, projectId);
        logger.info(`project pointer initialized → "${project.title}" (${projectId})`);
      }
      projectTitle = project.title;
```

(The `!project` branch covers both "no pointer yet" and "pointer references a deleted/unknown project"; in both cases the fallback choice is persisted, per the spec.)

(c) `recordUserMessage` (line 145–147) stamps the project:

```js
      await loggedStep('mongo recordUserMessage', () =>
        recordUserMessage({ msg, text, attachments, displayName, projectId }),
      );
```

(d) The prompt-enhancer's Mongo reads (lines 150–152) gain the project:

```js
      const [characters, plot] = await loggedStep('mongo listCharacters+getPlot', () =>
        Promise.all([listCharacters(projectId), getPlot(projectId)]),
      );
```

(`enhancePrompt` itself receives plain data — no signature change there.)

(e) `runAgent` call (lines 188–195) gains both values:

```js
          runAgent({
            history,
            userText: text,
            attachments,
            discordUser,
            channelId: msg.channelId,
            enhancementNotes: enhancement.notes,
            projectId,
            projectTitle,
          }),
```

(f) `recordAgentTurns` (lines 209–214) is stamped with the **turn-END** project — `result.projectId` reflects any mid-turn `set_project` (falling back to the turn-start id if absent):

```js
        await recordAgentTurns({
          channelId: msg.channelId,
          guildId: msg.guildId || null,
          threadId: msg.thread?.id || null,
          projectId: result.projectId ?? projectId,
          turns: result.agentMessages,
        });
```

(g) The error-path `recordAssistantMessage` (lines 234–239) uses the turn-start id (no `result` exists on this path):

```js
        await recordAssistantMessage({
          channelId: msg.channelId,
          guildId: msg.guildId || null,
          threadId: msg.thread?.id || null,
          projectId,
          text: replyText,
        });
```

- [ ] **Step 8: Run the new test — expect PASS; then full suite**

```
npx vitest run tests/agent-loop-project-context.test.js
```
Expected: 6 tests pass.

```
npm test
```
Expected: all green (existing agent-loop tests mock the Mongo modules with arg-agnostic stubs; the transitional `resolveProjectId` covers everything else).

- [ ] **Step 9: Commit**

```
git add src/discord/messageHandler.js src/agent/loop.js src/agent/overview.js src/agent/entityLinks.js src/agent/systemPrompt.js tests/agent-loop-project-context.test.js
git commit -m "✨ Thread project context through message handler and agent loop"
```

---

### Task 12: Handler sweep + project-prefixed SPA links

THE mechanical sweep: all ~92 handlers gain `(input, context)` where needed, every namespaced Mongo/Gateway call threads `context.projectId`, the two hard-coded channel reads switch to `context.channelId`, search tools gain the project filter, and `src/web/links.js` builders gain `projectTitle`.

**Files:**
- Modify: `src/agent/handlers.js` (3548 lines — sweep)
- Modify: `src/web/links.js` (full rewrite shown below)
- Modify: `src/agent/entityLinks.js` (3 URL-builder call sites deferred from Task 11)
- Test: `tests/handlers-project-threading.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/handlers-project-threading.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const spies = vi.hoisted(() => ({
  listCharacters: vi.fn(async () => []),
  getPlot: vi.fn(async () => ({ _id: 'p', beats: [], current_beat_id: null })),
  searchMessages: vi.fn(async () => ({ results: [], scanned: 0, scan_limit_hit: false })),
}));

vi.mock('../src/mongo/characters.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listCharacters: spies.listCharacters,
}));
vi.mock('../src/mongo/plots.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getPlot: spies.getPlot,
}));
vi.mock('../src/mongo/messages.js', async (importOriginal) => ({
  ...(await importOriginal()),
  searchMessages: spies.searchMessages,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const { beatUrl, characterUrl, notesUrl, libraryUrl } = await import('../src/web/links.js');

const PID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const ctx = { discordUser: null, channelId: 'chan-9', projectId: PID, projectTitle: 'My Movie' };

beforeEach(() => {
  fakeDb.reset();
  spies.listCharacters.mockClear();
  spies.getPlot.mockClear();
  spies.searchMessages.mockClear();
});

describe('handler projectId threading (representative sweep checks)', () => {
  it('list_characters threads context.projectId as first arg', async () => {
    await HANDLERS.list_characters({}, ctx);
    expect(spies.listCharacters).toHaveBeenCalledWith(PID);
  });

  it('get_plot threads context.projectId as first arg', async () => {
    await HANDLERS.get_plot({}, ctx);
    expect(spies.getPlot).toHaveBeenCalledWith(PID);
  });

  it('search_message_history uses context.channelId and the project filter', async () => {
    await HANDLERS.search_message_history({ pattern: 'foo' }, ctx);
    expect(spies.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'chan-9', projectId: PID }),
    );
  });
});

describe('project-prefixed SPA links', () => {
  it('builders prefix /p/<encoded title>', () => {
    expect(beatUrl('My Movie', { order: 2 })).toMatch(/\/p\/My%20Movie\/beat\/2$/);
    expect(characterUrl('My Movie', { name: 'Steve' })).toMatch(
      /\/p\/My%20Movie\/character\/Steve$/,
    );
    expect(notesUrl('My Movie')).toMatch(/\/p\/My%20Movie\/notes$/);
    expect(libraryUrl('My Movie')).toMatch(/\/p\/My%20Movie\/library$/);
  });

  it('legacy un-prefixed calls keep working (transitional shim)', () => {
    expect(beatUrl({ order: 2 })).toMatch(/\/beat\/2$/);
    expect(beatUrl({ order: 2 })).not.toContain('/p/');
    expect(characterUrl({ name: 'Steve' })).toMatch(/\/character\/Steve$/);
    expect(notesUrl()).toMatch(/\/notes$/);
    expect(notesUrl()).not.toContain('/p/');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```
npx vitest run tests/handlers-project-threading.test.js
```

Expected: `list_characters` / `get_plot` fail with `expected "spy" to be called with arguments: [ 'a1b2…' ]` but `received: []`; `search_message_history` fails on `channelId: 'chan-9'` (it's currently `config.discord.movieChannelId`) and missing `projectId`; the `/p/` link test fails with `expected null to match …` (old `beatUrl('My Movie', …)` treats the title string as the beat).

- [ ] **Step 3: Rewrite `src/web/links.js`**

Replace the file body (keep `withSpaLink` verbatim). All seven builders gain `projectTitle` as the FIRST param (the assignment names four; `aboutUrl` is called 3× in handlers.js and `storyboardUrl`/`homeUrl` go along for uniformity):

```js
import { config } from '../config.js';
import { stripMarkdown } from '../util/markdown.js';

function publicBase() {
  return (config.web.publicBaseUrl || `http://localhost:${config.web.port}`).replace(/\/+$/, '');
}

// '/p/<encodeURIComponent(title)>' path segment for a project-scoped SPA URL.
// Falsy/blank titles produce no segment: the SPA redirects legacy un-prefixed
// paths into the viewer's last-used project, so links built by not-yet-migrated
// callers remain functional.
function projectSegment(projectTitle) {
  if (typeof projectTitle !== 'string') return '';
  const t = projectTitle.trim();
  if (!t) return '';
  return `/p/${encodeURIComponent(t)}`;
}

// TRANSITIONAL (deleted in Task 20 pre-flip threading): detect legacy single-argument calls
// (`beatUrl(beat)`) from not-yet-migrated callers and shift the argument.
// Entity args are objects; projectTitle is always a string or null.
function shiftLegacyArgs(projectTitle, entity) {
  if (entity === undefined && projectTitle !== null && typeof projectTitle === 'object') {
    return [null, projectTitle];
  }
  return [projectTitle, entity];
}

export function spaBaseUrl() {
  return publicBase();
}

export function homeUrl(projectTitle) {
  return `${publicBase()}${projectSegment(projectTitle)}/`;
}

export function libraryUrl(projectTitle) {
  return `${publicBase()}${projectSegment(projectTitle)}/library`;
}

export function characterUrl(projectTitle, character) {
  [projectTitle, character] = shiftLegacyArgs(projectTitle, character);
  if (!character?.name) return null;
  const slug = stripMarkdown(character.name).trim();
  if (!slug) return null;
  return `${publicBase()}${projectSegment(projectTitle)}/character/${encodeURIComponent(slug)}`;
}

export function beatUrl(projectTitle, beat) {
  [projectTitle, beat] = shiftLegacyArgs(projectTitle, beat);
  if (!beat || !Number.isFinite(beat.order)) return null;
  return `${publicBase()}${projectSegment(projectTitle)}/beat/${beat.order}`;
}

export function storyboardUrl(projectTitle, beat) {
  [projectTitle, beat] = shiftLegacyArgs(projectTitle, beat);
  if (!beat || !Number.isFinite(beat.order)) return null;
  return `${publicBase()}${projectSegment(projectTitle)}/storyboard/${beat.order}`;
}

export function notesUrl(projectTitle) {
  return `${publicBase()}${projectSegment(projectTitle)}/notes`;
}

export function aboutUrl(projectTitle) {
  return `${publicBase()}${projectSegment(projectTitle)}/about`;
}

export function withSpaLink(text, url) {
  if (!url) return text;
  return `${String(text).replace(/\s+$/, '')}\nEdit in browser: ${url}`;
}
```

The shim keeps the un-migrated callers in `src/web/announceHelpers.js`, `src/web/artworkJobs.js`, `src/web/storyboardGenerate.js`, and `src/web/falVideoGenerate.js` working unchanged. The 9 legacy call sites (`announceHelpers.js` 61/82/103/125, `artworkJobs.js` 50/57, `storyboardGenerate.js` 712/1848, `falVideoGenerate.js` 785) are migrated — and this shim deleted — in **Task 20's pre-flip threading steps**.

- [ ] **Step 4: Sweep A — handler signatures gain `context`**

Enumerate the 92 handlers (re-run; line numbers drift after each step):

```
grep -n "^  async [a-z_]*(" src/agent/handlers.js
```

Current output (92 lines):

```
1032:  async get_overview()
1036:  async list_characters()
1047:  async get_character({ identifier, full_fields } = {})
1058:  async edit(input = {})
1154:  async set_field(input = {})
1216:  async create_character(input)
1223:  async bulk_update_character_field({ field_name, updates, batch_size } = {})
1304:  async revise_character({ identifier, instructions } = {})
1378:  async search_characters({ query })
1390:  async delete_character({ identifier })
1400:  async get_character_template()
1404:  async update_character_template({ add = [], remove = [] })
1409:  async list_director_notes()
1433:  async add_director_note({ text, position } = {})
1441:  async add_film_dialogue_sample({ film, sample, note } = {})
1462:  async remove_director_note({ note_id } = {})
1467:  async reorder_director_notes({ note_ids } = {})
1472:  async add_director_note_image({ note_id, source_url, filename, caption, set_as_main } = {})
1505:  async list_director_note_images({ note_id } = {})
1523:  async set_main_director_note_image({ note_id, image_id } = {})
1531:  async remove_director_note_image({ note_id, image_id } = {})
1545:  async attach_library_image_to_director_note({ image_id, note_id, set_as_main } = {})
1581:  async add_director_note_attachment({ note_id, source_url, filename, caption } = {})
1608:  async list_director_note_attachments({ note_id } = {})
1624:  async remove_director_note_attachment({ note_id, attachment_id } = {})
1636:  async get_plot()
1647:  async list_beats()
1653:  async get_beat({ identifier, full_body } = {})
1663:  async create_beat({ name, desc, body, characters, order })
1669:  async read_beat_body({ beat, line_start, line_count } = {})
1687:  async search_in_beat_body({
1723:  async outline_beat_body({ beat } = {})
1737:  async read_director_note({ note_id, line_start, line_count } = {})
1754:  async read_character_field({ character, field, line_start, line_count } = {})
1787:  async search_beats({ query })
1803:  async delete_beat({ identifier })
1809:  async link_character_to_beat({ beat, character })
1818:  async unlink_character_from_beat({ beat, character })
1827:  async set_current_beat({ identifier })
1832:  async get_current_beat()
1838:  async clear_current_beat()
1843:  async add_beat_image({ beat, source_url, filename, caption, set_as_main })
1876:  async list_beat_images({ beat } = {})
1894:  async set_main_beat_image({ beat, image_id })
1906:  async remove_beat_image({ beat, image_id })
1921:  async list_library_images()
1931:  async search_library_images({ query, limit } = {})
1944:  async show_library_image({ image_id, note } = {})
1957:  async replace_library_image({ source_image_id, new_image_id, copy_metadata } = {})
1980:  async attach_library_image_to_beat({ image_id, beat, set_as_main })
2015:  async move_image_to_library({ image_id } = {})
2067:  async attach_library_image_to_character({ image_id, character, set_as_main, caption } = {})
2090:  async add_library_attachment({ source_url, filename, caption } = {})
2106:  async list_library_attachments()
2116:  async attach_library_attachment_to_beat({ attachment_id, beat, caption } = {})
2136:  async attach_library_attachment_to_character({ attachment_id, character, caption } = {})
2156:  async attach_library_attachment_to_director_note({ attachment_id, note_id, caption } = {})
2176:  async show_image({ image_id })
2181:  async describe_image({ image_id, prompt })
2208:  async show_attachment({ attachment_id })
2214:  async generate_image(
2399:  async edit_image(
2654:  async export_pdf({ title, characters, beats_query, dossier_character } = {})
2668:  async export_csv({ entity, columns, filter, group_by, sort, limit, filename } = {})
2680:  async add_character_image({ character, source_url, filename, caption, set_as_main })
2697:  async list_character_images({ character })
2712:  async set_main_character_image({ character, image_id })
2720:  async remove_character_image({ character, image_id })
2730:  async add_beat_attachment({ beat, source_url, filename, caption })
2757:  async list_beat_attachments({ beat } = {})
2773:  async remove_beat_attachment({ beat, attachment_id })
2786:  async add_character_attachment({ character, source_url, filename, caption })
2803:  async list_character_attachments({ character })
2820:  async remove_character_attachment({ character, attachment_id })
2831:  async tmdb_search_movie({ query, year })
2846:  async tmdb_get_movie({ movie_id })
2872:  async tmdb_get_movie_credits({ movie_id })
2887:  async tmdb_search_person({ query })
2904:  async tmdb_show_image({ url, caption })
2916:  async tavily_search({
2970:  async tavily_show_image({ url, caption })
2979:  async find_repeated_phrases({ fields, sizes, min_count, top_k } = {})
3023:  async check_similarity({ target_type, identifier, text, threshold, top_k } = {})
3101:  async find_character_phrases({ character, sizes, fields, top_k } = {})
3153:  async similar_character({ character, focus, max_works } = {})
3185:  async similar_works({ scope, beat, focus, max_works } = {})
3229:  async search_message_history({
3275:  async screenplay_search({ query, k, entity_types } = {})
3334:  async analyze_dramatic_arc({ metric, fields } = {})
3388:  async calculator({ expression, precision } = {})
3407:  async run_code({ code, timeout_ms } = {})
3415:  async token_usage_report({ window, user } = {})
```

**Uniform transformation** — append `, context = null` to the parameter list of every handler whose body references project-scoped helpers or URL builders. `dispatchTool` already passes it (`handlers.js:3543`: `return await fn(decodeEscapes(input) || {}, context);`) — only the declarations change.

Example 1 (real, line 1047):
```js
  async get_character({ identifier, full_fields } = {}) {
```
becomes
```js
  async get_character({ identifier, full_fields } = {}, context = null) {
```

Example 2 (real, no-input handler, line 1636):
```js
  async get_plot() {
```
becomes
```js
  async get_plot(_input = {}, context = null) {
```

(Same `_input` shape for `get_overview`, `list_characters`, `get_character_template`, `list_director_notes`, `list_beats`, `get_current_beat`, `clear_current_beat`, `list_library_images`, `list_library_attachments`.)

**Already done (skip):** `generate_image` (line 2229) and `edit_image` (line 2411) already declare `context = null`.

**Exclusions (no `context` param — they touch no project-scoped state):** `tmdb_search_movie`, `tmdb_get_movie`, `tmdb_get_movie_credits`, `tmdb_search_person`, `tmdb_show_image`, `tavily_search`, `tavily_show_image`, `calculator`, `run_code`, `token_usage_report` (token_usage stays global per spec).

- [ ] **Step 5: Sweep B — thread `context.projectId` into every namespaced helper call**

**Read first:** after the Phase A/B bridge sweeps, the GridFS upload-helper sites (`uploadGeneratedImage`, `uploadImageFromUrl`, `uploadAttachmentBuffer`, `uploadAttachmentFromUrl`) already carry a literal `undefined` first argument — the transformation REPLACES that `undefined` with `context?.projectId`; never insert a second leading argument.

Enumerate (re-run before editing; paste below is the current state, 149 sites):

```
grep -nE "(Characters|Plots|Prompts|DirectorNotes|Files|Images|Attachments|Gateway|Messages)\.[a-zA-Z_]+\(" src/agent/handlers.js
```

Site list (current line numbers):

```
Characters.: 362 424 932 1037 1048 1133 1217 1311 1369 1379 1391 1394 1761 2040 2285 2370 2483 2506 2582 2670 3042 3049 3107 3155
Plots.:      393 399 434 777 1001 1146 1393 1637 1648 1654 1664 1788 1804 1811 1820 1828 1833 1839 2007 2026 2331 2388 2488 2600 2630 2674 2746 2775 2985 3060 3067 3111 3196 3338
Prompts.:    1401 1405
DirectorNotes.: 408 409 1410 1468 1491 1524 1532 1569 1597 1625 2494 2614 2633
Files.:      376 1556 1994 2068 2625 2681 2698 2713 2721
Images.:     1395 1474 1536 1547 1557 1805 1845 1912 1922 1925 1935 1938 1946 1952 1982 1995 2017 2177 2182 2261 2341 2392 2446 2462 2554 2631 2637 2639 2646
Attachments.: 1396 1583 1629 2091 2107 2110 2118 2137 2158 2209 2732 2779 2787 2805 2821
Gateway.:    1004 1017 1105 1117 1434 1450 1463 1862 1896 1908 1964 2030 2042 2052 2354 2566
             (1193 1211 1263 deliberately EXCLUDED — see the exclusion note below)
Messages.:   2298 3248
```

**Uniform transformation 1 — positional helpers** (Section B re-signed them with `projectId` FIRST):

Example 1 (real, line 1048, `get_character`):
```js
    const c = await Characters.getCharacter(identifier);
```
becomes
```js
    const c = await Characters.getCharacter(context?.projectId, identifier);
```

Example 2 (real, line 1637, `get_plot`):
```js
    const plot = await Plots.getPlot();
```
becomes
```js
    const plot = await Plots.getPlot(context?.projectId);
```

Example 3 (real, line 1379, `search_characters`):
```js
    const results = await Characters.searchCharacters(query);
```
becomes
```js
    const results = await Characters.searchCharacters(context?.projectId, query);
```

(`Plots.createBeat` at line 1664 is NOT positional — it takes `projectId` as an options KEY; see Uniform transformation 3 Example 3 below.)

Example 4 (real, line 1922, `list_library_images`):
```js
    const files = await Images.listLibraryImages();
```
becomes
```js
    const files = await Images.listLibraryImages(context?.projectId);
```

Example 5 (real, line 2698, `list_character_images`):
```js
    const { character: name, images, main_image_id } = await Files.listCharacterImages(character);
```
becomes
```js
    const { character: name, images, main_image_id } = await Files.listCharacterImages(
      context?.projectId,
      character,
    );
```

Example 6 (real, line 1410, `list_director_notes`):
```js
    const doc = await DirectorNotes.getDirectorNotes();
```
becomes
```js
    const doc = await DirectorNotes.getDirectorNotes(context?.projectId);
```

Example 7 (real, line 1401, `get_character_template`):
```js
    return compact(await Prompts.getCharacterTemplate());
```
becomes
```js
    return compact(await Prompts.getCharacterTemplate(context?.projectId));
```

**Exclusion — the three positional Gateway sites stay UNTOUCHED in this task.** Lines 1193 (`const beat = await Gateway.updateBeatViaGateway(identifier, { [field]: value });` in `set_field`), 1211 (`const c = await Gateway.updateCharacterViaGateway(identifier, { unset: value });` in `set_field`), and 1263 (`const updated = await Gateway.updateCharacterViaGateway(row.character, {` in `bulk_update_character_field`) keep their legacy two-arg form here. They are re-signed in **Task 15 Step 7d**, atomically with the gateway signature change to `updateBeatViaGateway(projectId, identifier, patch)` / `updateCharacterViaGateway(projectId, identifier, patch)` — threading them now would pass an extra argument into the not-yet-re-signed gateway. Step 9(a)'s verification grep excludes these two helper names for the same reason; Task 15 removes that exclusion.

**Uniform transformation 2 — GridFS upload helpers (positional `undefined` replacement).** Section B re-signed the four GridFS upload helpers POSITIONALLY — `uploadGeneratedImage(projectId, {…})`, `uploadImageFromUrl(projectId, {…})`, `uploadAttachmentBuffer(projectId, {…})`, `uploadAttachmentFromUrl(projectId, {…})` — and its bridge sweep left a literal `undefined` first argument at the 7 handlers.js sites: `Images.uploadImageFromUrl` (lines 1474, 1845), `Images.uploadGeneratedImage` (lines 2341, 2554), `Attachments.uploadAttachmentFromUrl` (lines 1583, 2091, 2732). Replace that `undefined` with `context?.projectId` — do NOT add a `projectId:` key to the options object, and do NOT insert a second leading argument.

Example 1 (real, lines 1845–1850, `add_beat_image` — post-bridge state):
```js
    const file = await Images.uploadImageFromUrl(undefined, {
      sourceUrl: source_url,
      filename,
      ownerType: 'beat',
      ownerId: target._id,
    });
```
becomes
```js
    const file = await Images.uploadImageFromUrl(context?.projectId, {
      sourceUrl: source_url,
      filename,
      ownerType: 'beat',
      ownerId: target._id,
    });
```

Example 2 (real, lines 2341–2348, `generate_image` — post-bridge state):
```js
    const file = await Images.uploadGeneratedImage(undefined, {
      buffer,
      contentType,
      prompt: finalPrompt,
      generatedBy: usedModel,
      ownerType,
      ownerId,
    });
```
becomes
```js
    const file = await Images.uploadGeneratedImage(context?.projectId, {
      buffer,
      contentType,
      prompt: finalPrompt,
      generatedBy: usedModel,
      ownerType,
      ownerId,
    });
```

Verification (run now, and again as Step 9(e) — expect ZERO matches):
```
grep -nE "(uploadGeneratedImage|uploadImageFromUrl|uploadAttachmentFromUrl|uploadAttachmentBuffer)\(undefined" src/agent/handlers.js
```

**Uniform transformation 3 — options-object helpers** gain a `projectId` key. RULE for greppability: in multi-line calls, `projectId: context?.projectId,` is always the **first property line**.

Example 1 (real, lines 1862–1866, `add_beat_image`):
```js
    const { is_main } = await Gateway.addBeatImageViaGateway({
      beatId: target._id.toString(),
      imageMeta: meta,
      setAsMain: set_as_main,
    });
```
becomes
```js
    const { is_main } = await Gateway.addBeatImageViaGateway({
      projectId: context?.projectId,
      beatId: target._id.toString(),
      imageMeta: meta,
      setAsMain: set_as_main,
    });
```

Example 2 (real, line 1468, `reorder_director_notes`):
```js
    const reordered = await DirectorNotes.reorderDirectorNotes({ noteIds: note_ids });
```
becomes
```js
    const reordered = await DirectorNotes.reorderDirectorNotes({ projectId: context?.projectId, noteIds: note_ids });
```

Example 3 (real, line 1664, `create_beat` — `createBeat` takes `projectId` as an options KEY, not positionally):
```js
    const b = await Plots.createBeat({ name, desc, body, characters, order });
```
becomes
```js
    const b = await Plots.createBeat({ projectId: context?.projectId, name, desc, body, characters, order });
```

Example 4 (real, line 1405, `update_character_template`):
```js
    const tpl = await Prompts.updateCharacterTemplateFields({ add, remove });
```
becomes
```js
    const tpl = await Prompts.updateCharacterTemplateFields({ projectId: context?.projectId, add, remove });
```

Example 5 (real, lines 2681–2687, `add_character_image`):
```js
    const meta = await Files.attachImageToCharacter({
      character,
      sourceUrl: source_url,
      filename,
      caption,
      setAsMain: set_as_main,
    });
```
becomes
```js
    const meta = await Files.attachImageToCharacter({
      projectId: context?.projectId,
      character,
      sourceUrl: source_url,
      filename,
      caption,
      setAsMain: set_as_main,
    });
```

**Pure transformers — NO change:** `Images.imageFileToMeta(f)` (lines 1925, 1938), `Attachments.attachmentFileToMeta(f)` (line 2110), `DirectorNotes.getDirectorNote(doc.notes || [], noteId)` (line 409 — operates on an in-memory array).

- [ ] **Step 6: Sweep B deviations — module-level helpers (shown explicitly)**

These seven helpers sit outside `HANDLERS` and have no `context` in scope; thread it through their signatures. Every caller inside `HANDLERS` passes `context?.projectId` (or `context` where the title is needed for links):

1. `maybeAutoFetchActorPortrait(characterIdentifier)` (line 359) → `maybeAutoFetchActorPortrait(projectId, characterIdentifier)`. Inside: `Characters.getCharacter(projectId, characterIdentifier)` (line 362) and `Files.attachImageToCharacter({ projectId, character: c._id.toString(), … })` (line 376). Callers (lines 1138, 1218): `maybeAutoFetchActorPortrait(context?.projectId, …)`.

2. `resolveBeat(identifier, { allowCurrent } = {})` (line 390) → `resolveBeat(projectId, identifier, { allowCurrent = true } = {})`. Inside: `Plots.getCurrentBeat(projectId)` (line 393), `Plots.getBeat(projectId, String(identifier))` (line 399). ~14 callers become `resolveBeat(context?.projectId, beat)` (e.g. lines 1844, 2277, 2293).

3. `resolveDirectorNote(noteId)` (line 404) → `resolveDirectorNote(projectId, noteId)`. Inside: `DirectorNotes.getDirectorNotes(projectId)` (line 408).

4. `appendSimilarityHeadsUp(type, item, baseMessage)` (line 417) → `appendSimilarityHeadsUp(projectId, type, item, baseMessage)`. Inside: `Characters.findAllCharacters(projectId)` (line 424), `Plots.listBeats(projectId)` (line 434). Callers (lines 1134, 1147, 1220, 1666): prepend `context?.projectId`.

5. `resolveEditTarget({ collection, identifier, field })` (line 908) → `resolveEditTarget(context, { collection, identifier, field })` — it needs BOTH the id (for `resolveBeat`/`Characters.getCharacter`/`resolveDirectorNote`) and the title (for `urlForLink`). Inside:
   - line 910: `const target = await resolveBeat(context?.projectId, identifier);`
   - line 925: `urlForLink: beatUrl(context?.projectTitle, target),`
   - line 932: `const c = await Characters.getCharacter(context?.projectId, identifier);`
   - line 958: `urlForLink: characterUrl(context?.projectTitle, c),`
   - line 968: `const note = await resolveDirectorNote(context?.projectId, identifier);`
   - line 975: `urlForLink: notesUrl(context?.projectTitle),`
   Caller (line 1100 in `edit`): `const target = await resolveEditTarget(context, { collection, identifier, field });`

6. `editPlotEntity({ field, edits, isWholeReplace })` (line 997) → `editPlotEntity(context, { field, edits, isWholeReplace })`. Inside: line 1001 `String((await Plots.getPlot(context?.projectId))[field] || '')`; both Gateway calls gain `projectId: context?.projectId,` as first key (lines 1004, 1017); both `aboutUrl()` calls become `aboutUrl(context?.projectTitle)` (lines 1014, 1027). Caller (line 1097 in `edit`): `return await editPlotEntity(context, { field, edits, isWholeReplace });`

7. `runCsvExport({ entity, docs, … })` (line 746) → gains a `projectId` key. Inside, line 777: `const beats = await Plots.listBeats(projectId);`. Both callers in `export_csv` (lines 2672, 2676): `runCsvExport({ projectId: context?.projectId, entity, docs, columns, filter, group_by, sort, limit, filename })`.

Also one cross-module options call: `export_pdf` (line 2663) becomes
```js
    const result = await exportToPdf({ projectId: context?.projectId, title, characters, beats_query, dossier_character });
```
(`exportToPdf`'s internals (`src/pdf/export.js`) are threaded in **Task 20's pre-flip threading steps**; passing the key here is forward-compatible — unknown keys are ignored until then.)

`kickoffLibraryVisionSeed(file._id, buffer, contentType)` (lines 2352, 2564): NO change — the worker keys off the GridFS file, whose `metadata.project_id` is set at upload by Section B.

- [ ] **Step 7: Sweep B special cases — channel hard-codes + search project filters (shown explicitly)**

(a) `generate_image` include_recent_chat (line 2298):
```js
      const history = await Messages.loadHistoryForLlm(config.discord.movieChannelId);
```
becomes
```js
      const history = await Messages.loadHistoryForLlm(context?.channelId || config.discord.movieChannelId);
```
(History stays channel-scoped by design — NO projectId here. The config fallback covers context-less CLI/test callers; production always passes context.)

(b) `search_message_history` (lines 3248–3256):
```js
    const { results, scanned, scan_limit_hit } = await Messages.searchMessages({
      channelId: config.discord.movieChannelId,
      regex,
```
becomes
```js
    const { results, scanned, scan_limit_hit } = await Messages.searchMessages({
      projectId: context?.projectId,
      channelId: context?.channelId || config.discord.movieChannelId,
      regex,
```
(Section B's `searchMessages` treats `projectId` as a filter: `if (projectId) query.project_id = projectId;` — pre-migration docs without the stamp are matched only when the filter is absent; the migration stamps everything, so post-deploy this is a strict filter.)

(c) `screenplay_search` (lines 3275–3332) — replace the whole inline Chroma body with a delegation to Task 9's extracted helper (`src/rag/query.js`), keeping the handler responsible only for arg validation and formatting:

```js
  async screenplay_search({ query, k, entity_types } = {}, context = null) {
    if (!query || typeof query !== 'string') return 'Error: `query` is required.';
    const { searchScreenplay } = await import('../rag/query.js');
    const res = await searchScreenplay(context?.projectId, query, {
      k,
      entityTypes: Array.isArray(entity_types) ? entity_types : undefined,
    });
    if (!res.ok) return res.message;
    return compact({ query, match_count: res.hits.length, results: res.hits });
  },
```

Contract (defined by Task 9, authoritative): `searchScreenplay(projectId, query, { k, entityTypes } = {})` returns `{ ok: true, hits }` on success, or `{ ok: false, reason, message }` when RAG is unavailable or the query fails — `message` is the user-facing string (the same strings the current inline body produces for no VOYAGE_API_KEY / Chroma unreachable / embedding error). The dynamic import preserves the handler's existing lazy-load of the RAG dependencies.

- [ ] **Step 8: Sweep C — URL-builder call sites gain `context?.projectTitle`**

Enumerate (re-run; the import line at 13 does not match because no `(` follows the names there):

```
grep -nE "(beatUrl|characterUrl|notesUrl|aboutUrl)\(" src/agent/handlers.js
```

Current site lines (62 call sites; lines 925/958/975/1014/1027 were already handled in Step 6):

```
1014 1027 1052 1198-1200 1213 1220 1317-1319 1364-1366 1375 1430 1435 1456-1458 1464
1469 1502 1520 1525-1527 1537-1541 1554 1575-1577 1605 1621 1630-1632 1660 1666
1672-1683 1711-1719 1726-1733 1740-1750 1772-1783 1812-1814 1821-1823 1873 1891
1900-1902 1913-1917 1989-1991 2009-2011 2034-2036 2046-2048 2056-2058 2074 2076 2082
2124-2126 2130-2132 2142 2144 2150 2164-2166 2170-2172 2694 2709 2714-2716 2722-2726
2754 2770 2780-2782 2800 2817 2825-2827
```

**Uniform transformation** — prepend `context?.projectTitle` (the Task-12 shim makes argument order unambiguous):

Example 1 (real, line 1660, `get_beat`):
```js
    return withSpaLink(compact(serializeBeat(b, { fullBody: !!full_body })), beatUrl(b));
```
becomes
```js
    return withSpaLink(
      compact(serializeBeat(b, { fullBody: !!full_body })),
      beatUrl(context?.projectTitle, b),
    );
```

Example 2 (real, line 1052, `get_character`):
```js
      characterUrl(c),
```
becomes
```js
      characterUrl(context?.projectTitle, c),
```

Example 3 (real, line 1435, `add_director_note`):
```js
    return withSpaLink(`Added director's note ${note._id}: ${preview(note.text)}`, notesUrl());
```
becomes
```js
    return withSpaLink(
      `Added director's note ${note._id}: ${preview(note.text)}`,
      notesUrl(context?.projectTitle),
    );
```

(`withSpaLink(summary, target.urlForLink)` at line 1150 needs NO change — `resolveEditTarget` already builds the prefixed URL in Step 6.)

Then the 3 deferred sites in `src/agent/entityLinks.js` (`resolveEntityLinks` body):
- line 107: `push(notesUrl());` → `push(notesUrl(context?.projectTitle));`
- line 130: `push(beatUrl(beat));` → `push(beatUrl(context?.projectTitle, beat));`
- line 136: `push(characterUrl(character));` → `push(characterUrl(context?.projectTitle, character));`

And the deferred `get_overview` call site in handlers.js (line 1033):
```js
    return compact(await buildOverview());
```
becomes
```js
    return compact(await buildOverview(context?.projectId));
```

- [ ] **Step 9: Verification greps — expect ZERO matches each**

(a) Single-line namespaced calls missing the project arg:
```
grep -nE "(Characters|Plots|Prompts|DirectorNotes|Files|Images|Attachments|Gateway|Messages)\.[a-zA-Z_]+\(" src/agent/handlers.js \
  | grep -vE "projectId|context\." \
  | grep -vE "imageFileToMeta|attachmentFileToMeta|getDirectorNote\(|getBotDisplayName" \
  | grep -vE "updateBeatViaGateway|updateCharacterViaGateway" \
  | grep -vE "\(\{?\s*$"
```
Expected output: **nothing** (exit code 1). (The `updateBeatViaGateway|updateCharacterViaGateway` exclusion covers the three deliberately untouched Step 5 sites at lines 1193/1211/1263 — Task 15 Step 7d re-signs them and removes this exclusion.)

(b) Multi-line calls whose first argument line lacks the project key (grep -A1 prints follow-lines with a `-` separator; every follow-line of a matched call must carry `projectId`):
```
grep -n -A1 -E "(Characters|Plots|Prompts|DirectorNotes|Files|Images|Attachments|Gateway|Messages)\.[a-zA-Z_]+\(\{?\s*$" src/agent/handlers.js \
  | grep -E "^[0-9]+-" | grep -v "projectId"
```
Expected output: **nothing**.

(c) URL builders still called without a title in the swept files:
```
grep -nE "(beatUrl|characterUrl|notesUrl|aboutUrl|libraryUrl)\(" src/agent/handlers.js src/agent/entityLinks.js | grep -v "projectTitle"
```
Expected output: only the two `import {...} from` lines (no `(` directly after a builder name there, so typically **nothing**; if your grep shows the import lines, they are the only acceptable matches).

(d) Hard-coded channel reads gone:
```
grep -n "config.discord.movieChannelId" src/agent/handlers.js
```
Expected output: exactly the 2 fallback positions from Step 7 (`context?.channelId || config.discord.movieChannelId`), nothing else.

(e) GridFS upload helpers still carrying the Phase-B literal `undefined` first argument:
```
grep -nE "(uploadGeneratedImage|uploadImageFromUrl|uploadAttachmentFromUrl|uploadAttachmentBuffer)\(undefined" src/agent/handlers.js
```
Expected output: **nothing** (every one of the 7 sites now passes `context?.projectId` positionally).

- [ ] **Step 10: Run tests — expect PASS**

```
npx vitest run tests/handlers-project-threading.test.js
```
Expected: 5 tests pass.

```
npm test
```
Expected: all green. (Existing handler tests call `HANDLERS.x(input)` without context → `context?.projectId` is `undefined` → Section B's transitional `resolveProjectId` resolves the default project, same doc the fakes seeded.)

- [ ] **Step 11: Commit**

```
git add src/agent/handlers.js src/agent/entityLinks.js src/web/links.js tests/handlers-project-threading.test.js
git commit -m "♻️ Thread projectId through tool handlers and project-prefix SPA links"
```

---

### Task 13: `set_project` tool

**Files:**
- Modify: `src/agent/tools.js` (append tool entry before the closing `];` at line 1697; do NOT touch `CORE_TOOL_NAMES`)
- Modify: `src/agent/handlers.js` (imports + new handler at the end of `HANDLERS`)
- Modify: `src/agent/systemPrompt.js` (stable `# Projects` guidance section)
- Modify: `src/discord/client.js` (ready handler — startup announce names the active project)
- Test: `tests/setProject.test.js` (new)

**Pre-verified — no loop change needed:** `MUTATING_PREFIXES` in `src/agent/loop.js` (lines 37–54) already contains `'set_'`. The real list:

```js
const MUTATING_PREFIXES = [
  'create_',
  'update_',
  'delete_',
  'add_',
  'remove_',
  'edit_',
  'set_',
  'clear_',
  'link_',
  'unlink_',
  'attach_',
  'append_',
  'reorder_',
  'bulk_',
  'revise_',
  'generate_image',
];
```

So `set_project` automatically (a) flips `systemDirty` → the next iteration rebuilds the system prompt from the mutated `context.projectId`, and (b) is blocked in review mode. **State: no change to loop.js in this task.** Likewise `tests/tools-schema.test.js` enforces TOOLS↔HANDLERS parity generically — adding both halves below satisfies it with **zero test-file changes**.

- [ ] **Step 1: Write the failing tests**

Create `tests/setProject.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const { createProject } = await import('../src/mongo/projects.js');
const { getCurrentProjectId } = await import('../src/mongo/channelState.js');

beforeEach(() => {
  fakeDb.reset();
});

function makeContext(overrides = {}) {
  return {
    discordUser: { id: 'u1', displayName: 'Steve' },
    channelId: 'chan-1',
    projectId: 'a'.repeat(24),
    projectTitle: 'Old Project',
    ...overrides,
  };
}

describe('set_project handler', () => {
  it('switches to a known project (case-insensitive) and reports the title', async () => {
    await createProject('Heist Movie');
    const ctx = makeContext();
    const out = await HANDLERS.set_project({ title: 'heist movie' }, ctx);
    expect(out).toBe('Switched to project "Heist Movie".');
  });

  it('mutates context in place so later same-turn tools see the new project', async () => {
    const p = await createProject('Heist Movie');
    const ctx = makeContext();
    await HANDLERS.set_project({ title: 'Heist Movie' }, ctx);
    expect(ctx.projectId).toBe(p._id.toString());
    expect(ctx.projectTitle).toBe('Heist Movie');
  });

  it('persists the switch to channel_state', async () => {
    const p = await createProject('Heist Movie');
    await HANDLERS.set_project({ title: 'Heist Movie' }, makeContext());
    expect(await getCurrentProjectId('chan-1')).toBe(p._id.toString());
  });

  it('unknown title returns an error listing all available titles', async () => {
    await createProject('Alpha');
    await createProject('Beta');
    const ctx = makeContext();
    const out = await HANDLERS.set_project({ title: 'Gamma' }, ctx);
    expect(out).toMatch(/^Tool error \(set_project\)/);
    expect(out).toContain('"Alpha"');
    expect(out).toContain('"Beta"');
    // and nothing was switched or persisted
    expect(ctx.projectId).toBe('a'.repeat(24));
    expect(await getCurrentProjectId('chan-1')).toBeNull();
  });

  it('requires a title', async () => {
    const out = await HANDLERS.set_project({}, makeContext());
    expect(out).toMatch(/`title` is required/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```
npx vitest run tests/setProject.test.js
```

Expected: all 5 fail with `TypeError: HANDLERS.set_project is not a function`.

- [ ] **Step 3: Tool schema entry in `src/agent/tools.js`**

Append as the last element of `TOOLS` (immediately before the closing `];` that currently follows the `token_usage_report` entry at line 1696). NOT added to `CORE_TOOL_NAMES` — it is lazy-loaded via `tool_search` (its keywords below feed the BM25-lite scorer; the `set_project` name itself prefix-matches "project"):

```js
  {
    name: 'set_project',
    keywords: ['project', 'switch', 'workspace', 'open'],
    description:
      'Switch this Discord channel\'s active screenplay project by title (case-insensitive). All subsequent reads and writes — characters, beats, director\'s notes, images, exports, searches — apply to the newly selected project, and the choice persists across restarts. On an unknown title the tool returns the list of available project titles; relay them to the user. Projects are created in the web UI only (click the project title in the browser header) — never invent a project by retrying with a new title.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The project title to switch to (case-insensitive, as shown in the project list).',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
```

- [ ] **Step 4: Handler in `src/agent/handlers.js`**

Add imports next to the existing mongo imports (after line 10, `import * as Attachments …`):

```js
import { getProjectByTitle, listProjects } from '../mongo/projects.js';
import { setCurrentProjectId } from '../mongo/channelState.js';
```

Append as the last entry of `HANDLERS` (after `token_usage_report`):

```js
  async set_project({ title } = {}, context = null) {
    if (typeof title !== 'string' || !title.trim()) {
      return 'Tool error (set_project): `title` is required.';
    }
    const project = await getProjectByTitle(title);
    if (!project) {
      const all = await listProjects();
      const titles = all.map((p) => `"${p.title}"`).join(', ');
      return `Tool error (set_project): no project titled "${title.trim()}". Available projects: ${titles || '(none)'}.`;
    }
    const projectId = project._id.toString();
    // Mutate the shared per-turn context IN PLACE so every later tool call in
    // this turn — and the end-of-turn recordAgentTurns stamp — uses the new
    // project. The loop's MUTATING_PREFIXES ('set_') rebuilds the system
    // prompt on the next iteration, and the loop drops pre-switch touched
    // entities (see entityLinks.clearTouchedEntities).
    if (context && typeof context === 'object') {
      context.projectId = projectId;
      context.projectTitle = project.title;
    }
    if (context?.channelId) {
      await setCurrentProjectId(context.channelId, projectId);
    } else {
      logger.warn('set_project: no channelId in context — switch not persisted to channel_state');
    }
    return `Switched to project "${project.title}".`;
  },
```

- [ ] **Step 5: Stable system-prompt guidance in `src/agent/systemPrompt.js`**

Insert into `buildStableText`'s template, between the `# Web UI` block's final paragraph and `# Character template` — i.e. after the line:

```
Mutations already auto-append "Edit in browser: <url>" footers via the entity-link layer, so you don't need to repeat those URLs in your reply text. But for *read* requests like "give me a link to all the beats" or "where can I see this in the browser", emit the URL yourself.
```

add:

```
# Projects
This deployment hosts multiple independent screenplay projects. You work in exactly ONE project at a time — the "Current project" line in the "# Current state" section names it, and every read and write (characters, beats, notes, images, exports, searches) applies to that project only. Browser URLs you share are automatically scoped to the current project.

When the user asks to switch projects ("switch to X", "open the X project", "let's work on X"), load and call \`set_project({ title })\` (find it via \`tool_search({ query: "switch project" })\`). Titles match case-insensitively. If the title is unknown, the tool returns the list of available projects — relay it and let the user pick; never guess or retry with invented titles. Creating projects is web-only: if the user asks for a new project, tell them to click the project title in the browser header. After a switch, entity ids from earlier in the conversation belong to the previous project and will come back "not found" — re-look entities up by name instead of reusing stale ids.
```

(No `stableTextCache` key change is needed: the key already covers everything variable; this added text is static per deploy.)

- [ ] **Step 6: Startup online message names the active project (`src/discord/client.js`)**

Spec requirement: the startup announce names the channel's active project. Same resolution chain as the message handler (pointer → project doc → default), but **read-only** — the announce must not persist a fallback pointer; Task 11's message handler does that on the first real message.

Add imports after line 6 (`import { setBotDisplayName } from '../web/gateway.js';`):

```js
import { getCurrentProjectId } from '../mongo/channelState.js';
import { getDefaultProject, getProjectById } from '../mongo/projects.js';
```

In the `ready` handler, lines 31–33:

```js
      setBotDisplayName(resolvedName);
      logger.info(`bot display name: ${resolvedName}`);
      await channel.send(`🎬 Lucas online (${new Date().toISOString()})`);
```

become

```js
      setBotDisplayName(resolvedName);
      logger.info(`bot display name: ${resolvedName}`);
      let project = null;
      try {
        const projectId = await getCurrentProjectId(config.discord.movieChannelId);
        project = projectId ? await getProjectById(projectId) : null;
        if (!project) project = await getDefaultProject();
      } catch (e) {
        logger.warn(`startup project lookup failed: ${e.message}`);
      }
      const projectNote = project ? ` — project "${project.title}"` : '';
      await channel.send(`🎬 Lucas online${projectNote} (${new Date().toISOString()})`);
```

**Verification is manual.** The ready handler has no unit test today (nothing under `tests/` imports `src/discord/client.js`), and mocking discord.js's `Client`/`channels.fetch` chain for one template literal isn't worth the new fixture — a unit test here is explicitly optional and skipped. Instead: with Mongo running, start `npm run dev` and confirm the channel announce reads `🎬 Lucas online — project "<default project title>" (<ISO timestamp>)`. The `try/catch` keeps a Mongo hiccup from suppressing the announce entirely (it degrades to the legacy no-project message).

- [ ] **Step 7: Run tests — expect PASS**

```
npx vitest run tests/setProject.test.js tests/tools-schema.test.js
```

Expected: `setProject.test.js` 5/5 pass; `tools-schema.test.js` passes unchanged (its parity loop picks up `set_project` automatically — schema fields valid, handler present, not a metaTool).

- [ ] **Step 8: Full suite + commit**

```
npm test
```
Expected: all green.

```
git add src/agent/tools.js src/agent/handlers.js src/agent/systemPrompt.js src/discord/client.js tests/setProject.test.js
git commit -m "✨ Add set_project tool for switching the agent's active project"
```
## Phase D: Web backend — REST, rooms, gateway

Scope: the Express `/api` layer (project middleware, project CRUD endpoints, threading
`req.projectId` through every route), the Hocuspocus room registry (project-scoped
singleton rooms, entity-room project verification), and the mutation gateway
(project-aware room names + `projectId` params on every helper).

Both tasks lean on the **transitional `resolveProjectId`** contract from the Mongo
phase: every project-scoped helper internally resolves a falsy `projectId` to the
default project, so each commit below leaves `npm test` green even while other call
sites are still un-threaded.

Pre-flight assumption check (run before starting; both must succeed):

```bash
grep -n "export async function resolveProjectId" src/mongo/projects.js
grep -n "export async function seedProjectDefaults" src/seed/defaults.js
```

If either is missing, the Mongo/seed tasks from the earlier phases have not landed —
stop and finish those first.

---

### Task 14: REST layer — project middleware, `/api/projects`, project-scoped routes

> **Bridge-arg rule for this task's before-quotes:** after the Phase A/B sweeps, positional Mongo-helper call sites in the real files carry a literal `undefined` first argument (e.g. `getBeat(undefined, beatId)`, `getCharacter(undefined, id)`) even where a before-quote below shows the original one-arg shape. The transformation REPLACES that `undefined` with `req.projectId` — never insert a second leading argument. Options-object helpers gain a `projectId` key instead.

Files:

- Create: `src/web/projectMiddleware.js`
- Create: `tests/projectMiddleware.test.js`
- Create: `tests/project-routes.test.js`
- Modify: `src/web/entityRoutes.js`
  - imports block (after line 13 `import { requireSession } from './auth.js';`)
  - `buildApiRouter()` opening (lines 315–318: mount point)
  - `GET /info` (lines 391–401)
  - new `/projects` routes (insert after `/info`)
  - route sweep across the whole file (~150 mongo-helper sites + 74 gateway sites)

- [ ] **Step 1: Write the failing middleware test**

Create `tests/projectMiddleware.test.js` with exactly:

```js
// resolveProject() Express middleware: X-Project-Id header, ?project_id= query
// fallback (SSE), default-project fallback, 404 on unknown ids. Tested as a
// plain async function with stub req/res/next (no HTTP server needed).
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

const { resolveProject } = await import('../src/web/projectMiddleware.js');
const Projects = await import('../src/mongo/projects.js');

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function stubReq({ header, query } = {}) {
  const headers = header ? { 'x-project-id': header } : {};
  return {
    headers,
    query: query || {},
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

describe('resolveProject middleware', () => {
  beforeEach(() => fakeDb.reset());

  it('resolves a known X-Project-Id header into req.projectId/req.projectTitle', async () => {
    const p = await Projects.createProject('Western');
    const req = stubReq({ header: p._id.toString() });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.projectId).toBe(p._id.toString());
    expect(req.projectTitle).toBe('Western');
  });

  it('falls back to ?project_id= when the header is missing (SSE / EventSource)', async () => {
    const p = await Projects.createProject('Western');
    const req = stubReq({ query: { project_id: p._id.toString() } });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.projectId).toBe(p._id.toString());
    expect(req.projectTitle).toBe('Western');
  });

  it('prefers the header over the query when both are present', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const req = stubReq({
      header: a._id.toString(),
      query: { project_id: b._id.toString() },
    });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(req.projectId).toBe(a._id.toString());
  });

  it('uses the default project when neither header nor query is present', async () => {
    const req = stubReq();
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // Empty collection → getDefaultProject lazily creates "Screenplay".
    expect(req.projectTitle).toBe('Screenplay');
    expect(req.projectId).toMatch(/^[a-f0-9]{24}$/);
  });

  it('404s {error:"unknown project"} for an unknown 24-hex id', async () => {
    await Projects.createProject('Western');
    const req = stubReq({ header: new ObjectId().toString() });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'unknown project' });
  });

  it('404s for a malformed (non-hex) id', async () => {
    const req = stubReq({ header: 'not-a-project-id' });
    const res = stubRes();
    const next = vi.fn();
    await resolveProject()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'unknown project' });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
npx vitest run tests/projectMiddleware.test.js
```

Expected: suite fails to load with a module-resolution error for
`../src/web/projectMiddleware.js` (`Failed to load url ../src/web/projectMiddleware.js`
/ `Cannot find module`). All 6 tests unrun.

- [ ] **Step 3: Implement `src/web/projectMiddleware.js`**

Create the file with exactly:

```js
// projectMiddleware.js
//
// Resolves the request's project for the /api router. The SPA sends an
// X-Project-Id header on every call; the SSE route cannot set custom headers
// (EventSource), so a ?project_id= query parameter is accepted as a fallback.
//
//   missing header+query → default project (stale cached SPA bundles keep
//                          working across the multi-project deploy)
//   unknown / malformed  → 404 {error:'unknown project'}
//
// Sets req.projectId (24-hex string) and req.projectTitle.

import { getProjectById, getDefaultProject } from '../mongo/projects.js';

const HEX24 = /^[a-f0-9]{24}$/i;

export function resolveProject() {
  return async (req, res, next) => {
    try {
      const fromHeader = typeof req.get === 'function' ? req.get('x-project-id') : null;
      const raw = String(fromHeader || req.query?.project_id || '').trim();
      if (!raw) {
        const project = await getDefaultProject();
        req.projectId = project._id.toString();
        req.projectTitle = project.title;
        return next();
      }
      const project = HEX24.test(raw) ? await getProjectById(raw) : null;
      if (!project) {
        return res.status(404).json({ error: 'unknown project' });
      }
      req.projectId = project._id.toString();
      req.projectTitle = project.title;
      return next();
    } catch (e) {
      return next(e);
    }
  };
}
```

- [ ] **Step 4: Run it — expect PASS**

```bash
npx vitest run tests/projectMiddleware.test.js
```

Expected: 6 passed.

- [ ] **Step 5: Commit the middleware**

```bash
git add src/web/projectMiddleware.js tests/projectMiddleware.test.js
git commit -m "✨ Add resolveProject middleware for per-request project scoping"
```

- [ ] **Step 6: Write the failing endpoint tests**

Create `tests/project-routes.test.js` (same harness pattern as
`tests/storyboard-bulk-images-routes.test.js`: real Express server on port 0,
`requireSession` mocked to pass-through, `fetch` against it):

```js
// REST endpoints for project management + project-scoped /api/info.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

const Projects = await import('../src/mongo/projects.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r()));
});
beforeEach(() => fakeDb.reset());

const post = (path, body, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const get = (path, headers = {}) => fetch(`${baseUrl}/api${path}`, { headers });

describe('GET /api/projects', () => {
  it('lists projects as {projects:[{id,title,created_at}]}', async () => {
    await Projects.createProject('Western');
    const r = await get('/projects');
    expect(r.status).toBe(200);
    const body = await r.json();
    const titles = body.projects.map((p) => p.title);
    expect(titles).toContain('Western');
    for (const p of body.projects) {
      expect(p.id).toMatch(/^[a-f0-9]{24}$/);
      expect(p.title).toBeTruthy();
      expect(p.created_at).toBeTruthy();
    }
  });
});

describe('POST /api/projects', () => {
  it('creates a project, seeds templates + an empty plot doc, returns 201', async () => {
    const r = await post('/projects', { title: 'Space Opera' });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.id).toMatch(/^[a-f0-9]{24}$/);
    expect(body.title).toBe('Space Opera');
    // seedProjectDefaults ran: composite-keyed templates + a plot doc exist.
    const prompts = fakeDb.collection('prompts')._docs;
    expect(prompts.some((d) => d._id === `${body.id}:character_template`)).toBe(true);
    expect(prompts.some((d) => d._id === `${body.id}:plot_template`)).toBe(true);
    const plots = fakeDb.collection('plots')._docs;
    expect(plots.some((d) => String(d.project_id) === body.id)).toBe(true);
  });

  it('400s on invalid titles (empty, slash, >120 chars, missing)', async () => {
    expect((await post('/projects', { title: '   ' })).status).toBe(400);
    expect((await post('/projects', { title: 'a/b' })).status).toBe(400);
    expect((await post('/projects', { title: 'x'.repeat(121) })).status).toBe(400);
    expect((await post('/projects', {})).status).toBe(400);
  });

  it('409s on a duplicate title (case-insensitive)', async () => {
    await Projects.createProject('Noir');
    const r = await post('/projects', { title: 'noir' });
    expect(r.status).toBe(409);
  });
});

describe('GET /api/info', () => {
  it('returns the default project when no header is sent', async () => {
    const r = await get('/info');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.project_id).toMatch(/^[a-f0-9]{24}$/);
    expect(body.project_title).toBe('Screenplay'); // lazily created default
    expect(body).toHaveProperty('hocuspocus_url');
    expect(body).toHaveProperty('screenplay_title');
  });

  it('scopes to the X-Project-Id header project', async () => {
    const p = await Projects.createProject('Western');
    const r = await get('/info', { 'X-Project-Id': p._id.toString() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.project_id).toBe(p._id.toString());
    expect(body.project_title).toBe('Western');
  });

  it('404s {error:"unknown project"} for an unknown project id', async () => {
    const r = await get('/info', { 'X-Project-Id': new ObjectId().toString() });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'unknown project' });
  });
});
```

> Note: the seeding assertion peeks at `fakeDb.collection('prompts')._docs` directly —
> the same `_docs` poke pattern `tests/library-room.test.js` uses. If
> `seedProjectDefaults` stores templates differently than the composite-`_id`
> convention, fix the *seed*, not this test: the composite ids
> `<projectId>:character_template` / `<projectId>:plot_template` are the shared
> convention every other phase depends on.

- [ ] **Step 7: Run it — expect FAIL**

```bash
npx vitest run tests/project-routes.test.js
```

Expected failures: `GET /api/projects` → 404 (route doesn't exist, Express falls
through), `POST /api/projects` → 404, `GET /api/info` tests fail on
`body.project_id` being `undefined` and the unknown-header test getting 200 instead
of 404.

- [ ] **Step 8: Mount the middleware + add the endpoints + scope `/info`**

All edits in `src/web/entityRoutes.js`.

**8a — imports.** Current lines 12–13:

```js
import { convertToMp3 } from './audioTranscode.js';
import { requireSession } from './auth.js';
```

becomes:

```js
import { convertToMp3 } from './audioTranscode.js';
import { requireSession } from './auth.js';
import { resolveProject } from './projectMiddleware.js';
import { createProject, getProjectByTitle, listProjects } from '../mongo/projects.js';
import { seedProjectDefaults } from '../seed/defaults.js';
```

**8b — mount point.** The SSE route (`GET /storyboard/:id/video-job/:jobId/events`,
line 322) is registered **before** `router.use(requireSession())` (line 388) because
EventSource cannot set headers. `resolveProject()` must therefore mount **before the
SSE route**, not literally next to `requireSession()` — otherwise the SSE route never
gets `req.projectId` and the `?project_id=` fallback is dead code. Current lines
315–317:

```js
export function buildApiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
```

becomes:

```js
export function buildApiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  // Resolve the viewer's project for every /api route. Mounted BEFORE the SSE
  // route below (not next to requireSession) because EventSource cannot set
  // custom headers — the SSE route relies on this middleware's ?project_id=
  // query fallback. resolveProject never reads the session, so the early
  // mount grants nothing to unauthenticated callers beyond a 404 oracle.
  router.use(resolveProject());
```

No change inside the SSE route itself: `req.projectId` is now populated from
`?project_id=` by the middleware before the route runs (the SPA's `apiSseUrl()`
appends it — SPA phase).

**8c — `GET /info`.** Current lines 390–401:

```js
  // Connection metadata for the SPA so it knows where to open WebSockets.
  router.get('/info', async (_req, res) => {
    const wsUrl =
      config.web.hocuspocusPublicUrl ||
      `ws://${'localhost'}:${config.web.hocuspocusPort}`;
    const plot = await getPlot();
    res.json({
      hocuspocus_url: wsUrl,
      bot_color: config.web.botColor,
      screenplay_title: stripMarkdown(plot?.title || ''),
    });
  });
```

becomes:

```js
  // Connection metadata for the SPA so it knows where to open WebSockets.
  router.get('/info', async (req, res) => {
    const wsUrl =
      config.web.hocuspocusPublicUrl ||
      `ws://${'localhost'}:${config.web.hocuspocusPort}`;
    const plot = await getPlot(req.projectId);
    res.json({
      hocuspocus_url: wsUrl,
      bot_color: config.web.botColor,
      screenplay_title: stripMarkdown(plot?.title || ''),
      project_id: req.projectId,
      project_title: req.projectTitle,
    });
  });
```

**8d — project endpoints.** Insert directly after the `/info` route:

```js
  // ── projects ─────────────────────────────────────────────────────────────

  // {projects:[...]} envelope deliberately wraps the spec's bare array for
  // forward-compat; SPA consumers read data.projects.
  router.get('/projects', async (_req, res, next) => {
    try {
      const projects = await listProjects();
      res.json({
        projects: projects.map((p) => ({
          id: p._id.toString(),
          title: p.title,
          created_at: p.created_at || null,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/projects', async (req, res, next) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (!title || title.length > 120 || title.includes('/')) {
        return res
          .status(400)
          .json({ error: 'title must be 1–120 characters and must not contain "/"' });
      }
      if (await getProjectByTitle(title)) {
        return res.status(409).json({ error: 'a project with that title already exists' });
      }
      let project;
      try {
        project = await createProject(title);
      } catch (e) {
        // Unique-index race on title_lower (two simultaneous creates). The
        // fake Mongo never throws this — the getProjectByTitle pre-check above
        // is what the test suite exercises.
        if (e?.code === 11000) {
          return res.status(409).json({ error: 'a project with that title already exists' });
        }
        throw e;
      }
      await seedProjectDefaults(project._id.toString());
      res.status(201).json({ id: project._id.toString(), title: project.title });
    } catch (e) {
      next(e);
    }
  });
```

- [ ] **Step 9: Run it — expect PASS, then commit**

```bash
npx vitest run tests/project-routes.test.js tests/projectMiddleware.test.js
```

Expected: all tests pass. Also run the neighboring route suites to confirm the early
`resolveProject()` mount didn't disturb them (it lazily creates the default project
on first use, which is harmless):

```bash
npx vitest run tests/storyboard-bulk-images-routes.test.js tests/beats-featuring-character.test.js tests/image-copy.test.js
```

Expected: all pass. Commit:

```bash
git add src/web/entityRoutes.js tests/project-routes.test.js
git commit -m "✨ Add project REST endpoints and project-scoped /api/info"
```

- [ ] **Step 10: Route sweep A — zero-arg project-scoped helpers**

MECHANICAL SWEEP. Enumerate:

```bash
grep -nE '\b(getPlot|listBeats|findAllCharacters|getDirectorNotes|getCharacterTemplate|getPlotTemplate|listLibraryImages|listLibraryAttachments|listImagesByOwnerType|countStoryboardsByBeat|countDialogsByBeat|listCharacters)\(' src/web/entityRoutes.js
```

Site list at planning time (line numbers will have shifted by ~+45 after Step 8; the
grep is authoritative):

```
395:    const plot = await getPlot();            ← already done in Step 8c
413:        findAllCharacters(),
414:        listBeats(),
415:        getDirectorNotes(),
416:        countStoryboardsByBeat(),
417:        countDialogsByBeat(),
435:      getCharacterTemplate(),
436:      getPlotTemplate(),
644:    const doc = await getDirectorNotes();
659:      listLibraryImages(),
660:      listLibraryAttachments(),
675:      const files = await listImagesByOwnerType('character');
688:        const all = await findAllCharacters();
721:        listImagesByOwnerType('beat'),
722:        getPlot(),
2209:      const beats = await listBeats();
2251:      const beats = await listBeats();
2291:      const doc = await getDirectorNotes();
3862:      const plot = await getPlot();
3863:      const characters = await listCharacters();
3940:      const plot = await getPlot();
3998:      const characters = await listCharacters();
4965:      const plot = await getPlot();
```

Uniform transformation: pass `req.projectId` as the first argument. Where the route
handler binds its request as `_req`, rename it to `req` (affects at least `/toc` line
405, `/template` line 433, `/notes` line 643, `/library` line 656).

Real example 1 — the `/toc` route, current lines 405–420:

```js
  router.get('/toc', async (_req, res) => {
    // findAllCharacters (not listCharacters) — we need fields.{...} content for
    // the deep filter to match on description/body-style template fields.
    // listDialogs() / listStoryboards() unfiltered return every row; we group
    // them per beat in buildTocResponse to back the dialog/storyboard tab
    // filter without forcing N+1 round trips here.
    const [characters, beatList, notes, storyboardCounts, dialogCounts, allDialogs, allStoryboards] =
      await Promise.all([
        findAllCharacters(),
        listBeats(),
        getDirectorNotes(),
        countStoryboardsByBeat(),
        countDialogsByBeat(),
        listDialogs(),
        listStoryboards(),
      ]);
```

after:

```js
  router.get('/toc', async (req, res) => {
    // findAllCharacters (not listCharacters) — we need fields.{...} content for
    // the deep filter to match on description/body-style template fields.
    // listDialogs() / listStoryboards() unfiltered return every row; we group
    // them per beat in buildTocResponse to back the dialog/storyboard tab
    // filter without forcing N+1 round trips here.
    const [characters, beatList, notes, storyboardCounts, dialogCounts, allDialogs, allStoryboards] =
      await Promise.all([
        findAllCharacters(req.projectId),
        listBeats(req.projectId),
        getDirectorNotes(req.projectId),
        countStoryboardsByBeat(req.projectId),
        countDialogsByBeat(req.projectId),
        listDialogs({ projectId: req.projectId }),
        listStoryboards({ projectId: req.projectId }),
      ]);
```

(`listDialogs`/`listStoryboards` already take a single options object, so they gain a
`projectId` key per the shared convention, not a positional arg.)

Real example 2 — the `/library` route, current lines 656–664:

```js
  router.get('/library', async (_req, res) => {
    const [images, attachments] = await Promise.all([
      listLibraryImages(),
      listLibraryAttachments(),
    ]);
```

after:

```js
  router.get('/library', async (req, res) => {
    const [images, attachments] = await Promise.all([
      listLibraryImages(req.projectId),
      listLibraryAttachments(req.projectId),
    ]);
```

Positional-with-existing-args example — line 675:
`listImagesByOwnerType('character')` → `listImagesByOwnerType(req.projectId, 'character')`.

Verification (expect **no output**):

```bash
grep -nE '\b(getPlot|listBeats|findAllCharacters|getDirectorNotes|getCharacterTemplate|getPlotTemplate|listLibraryImages|listLibraryAttachments|countStoryboardsByBeat|countDialogsByBeat|listCharacters|listStoryboards|listDialogs)\(\)' src/web/entityRoutes.js
grep -Pn '\blistImagesByOwnerType\(\s*(?!req\.projectId)' src/web/entityRoutes.js
```

- [ ] **Step 11: Route sweep B — id/name-addressed helpers**

MECHANICAL SWEEP. Enumerate:

```bash
grep -nE '\b(getBeat|getCharacter|getStoryboard|getDialog|getPreviousStoryboardInBeat|listImagesForBeat|listImagesForCharacter)\(' src/web/entityRoutes.js
```

At planning time: 56 `getBeat` sites, 22 `getCharacter` sites, 19
`getStoryboard`/`getDialog` sites, plus `listImagesForBeat`/`listImagesForCharacter`/
`getPreviousStoryboardInBeat` (one or two each). `getBeat` sites:
465, 467, 483, 527, 589, 877, 910, 931, 956, 970, 1070, 1106, 1147, 1222, 1303,
1328, 1354, 1990, 2039, 2177, 2498, 2522, 2618, 2667, 2704, 2772, 3118, 3236, 3253,
3428, 3598, 3663, 3730, 3753, 3809, 3832, 4080, 4118, 4328, 4359 … (the grep output
is authoritative). `getCharacter` sites: 614, 637, 1391, 1424, 1448, 1473, 1487,
1582, 1616, 1658, 1733, 1817, 1842, 1868, 1996, 2045, 2183, 2247, 3863(?-adjacent),
plus the grep remainder. `getStoryboard`/`getDialog` sites: 2486, 2594, 2638, 2754,
3062, 3116, 3216, 3307, 3424, 3518, 3627, 3695, 3783, 3852, 3938, 4311, 4628, 4716,
4747.

Uniform transformation: insert `req.projectId` as the first argument; existing
arguments shift right.

Real example 1 — `GET /beat`, current lines 461–468:

```js
  router.get('/beat', async (req, res) => {
    const { order, id } = req.query;
    let beat = null;
    if (id && isOidHex(String(id))) {
      beat = await getBeat(String(id));
    } else if (order != null) {
      beat = await getBeat(String(order));
    }
```

after:

```js
  router.get('/beat', async (req, res) => {
    const { order, id } = req.query;
    let beat = null;
    if (id && isOidHex(String(id))) {
      beat = await getBeat(req.projectId, String(id));
    } else if (order != null) {
      beat = await getBeat(req.projectId, String(order));
    }
```

Real example 2 — `GET /character/:id/images`, current lines 612–616:

```js
  router.get('/character/:id/images', async (req, res, next) => {
    try {
      const c = await getCharacter(req.params.id);
      if (!c) return res.status(404).json({ error: 'character not found' });
      const files = await listImagesForCharacter(c._id);
```

after:

```js
  router.get('/character/:id/images', async (req, res, next) => {
    try {
      const c = await getCharacter(req.projectId, req.params.id);
      if (!c) return res.status(404).json({ error: 'character not found' });
      const files = await listImagesForCharacter(req.projectId, c._id);
```

Also update the file-local helper `resolveBeatId(req)` (defined inside
`buildApiRouter`, used by ~40 routes): inside it, thread `req.projectId` into its
`getBeat` call(s) the same way — it already receives `req`, so no signature change.

Verification (expect **no output**; PCRE lookahead via `grep -P`):

```bash
grep -Pn '\b(getBeat|getCharacter|getStoryboard|getDialog|getPreviousStoryboardInBeat|listImagesForBeat|listImagesForCharacter)\(\s*(?!req\.projectId)' src/web/entityRoutes.js
```

- [ ] **Step 12: Route sweep C — gateway calls + GridFS uploads**

MECHANICAL SWEEP. Enumerate:

```bash
grep -nE '(ViaGateway|uploadGeneratedImage|uploadAttachmentBuffer)\(' src/web/entityRoutes.js
```

At planning time, 74 `ViaGateway(` call sites (lines 805, 827, 895, 927, 1056, 1098,
1139, 1201, 1251, 1270, 1289, 1321, 1347, 1379, 1409, 1441, 1568, 1608, 1650, 1712,
1762, 1784, 1803, 1835, 1861, 1980, 2029, 2152, 2302, 2312, 2332, 2357, 2390, 2415,
2436, 2466, 2524, 2538, 2569, 2602, 2620, 2652, 2693, 2731, 2951, 3028, 3075, 3174,
3320, 3356, 3390, 3435, 3476, 3537, 3582, 3647, 3715, 3745, 3794, 3824, 4070, 4108,
4313, 4350, 4511, 4581, 4662, 4677, 4707, 4711, 4767, 4798, 4825, 4888) and 21
`uploadGeneratedImage`/`uploadAttachmentBuffer` sites (796, 838, 887, 1036, 1192,
1282, 1401, 1548, 1703, 1796, 2018, 2324, 2429, 2639, 3063, 3308, 3526, 3635, 3708,
3784, 4760).

Two uniform transformations:

1. **Gateway helpers** (`*ViaGateway`) take a single options object — add
   `projectId: req.projectId,` as the **first key**. (Task 15 makes the gateway
   destructure it; until then the extra key is ignored — harmless, tests stay
   green.)
2. **GridFS upload helpers are positional** since the Mongo phase:
   `uploadGeneratedImage(projectId, { ... })` and
   `uploadAttachmentBuffer(projectId, { ... })`. The Phase B sweep left a literal
   `undefined` first argument at every call site — replace it with `req.projectId`:
   - `uploadGeneratedImage(undefined, {` → `uploadGeneratedImage(req.projectId, {`
   - `uploadAttachmentBuffer(undefined, {` → `uploadAttachmentBuffer(req.projectId, {`

Real example 1 — beat image upload, current lines 895–905:

```js
      const result = await addBeatImageViaGateway({
        beatId,
        imageMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          source: 'upload',
          uploaded_at: file.uploaded_at,
        },
        setAsMain,
      });
```

after:

```js
      const result = await addBeatImageViaGateway({
        projectId: req.projectId,
        beatId,
        imageMeta: {
          _id: file._id,
          filename: file.filename,
          content_type: file.content_type,
          size: file.size,
          source: 'upload',
          uploaded_at: file.uploaded_at,
        },
        setAsMain,
      });
```

Real example 2 — single-line form, current line 927:

```js
      const result = await removeBeatImageViaGateway({ beatId, imageId: req.params.imageId });
```

after:

```js
      const result = await removeBeatImageViaGateway({
        projectId: req.projectId,
        beatId,
        imageId: req.params.imageId,
      });
```

Real example 3 — positional upload, library image route, current lines 796–804
(shown post-Phase-B, i.e. with the sweep's `undefined` already in place):

```js
      const meta = await uploadGeneratedImage(undefined, {
        buffer,
        contentType,
        prompt: null,
        generatedBy: null,
        ownerType: null,
        ownerId: null,
        filename: safeFilename(req.file.originalname, `library-${Date.now()}.png`),
      });
```

after:

```js
      const meta = await uploadGeneratedImage(req.projectId, {
        buffer,
        contentType,
        prompt: null,
        generatedBy: null,
        ownerType: null,
        ownerId: null,
        filename: safeFilename(req.file.originalname, `library-${Date.now()}.png`),
      });
```

**Deviating site (do NOT touch in this step):** line 1379 calls the *positional*
gateway helper:

```js
      const result = await updateBeatViaGateway(beatId, patch);
```

Its signature changes to `updateBeatViaGateway(projectId, identifier, patch)` in
Task 15 Step 7d — this call site is updated there, atomically with the signature.

Verification — gateway calls (expect output `0`):

```bash
grep -Pzo '(?:[a-zA-Z]+ViaGateway)\(\{\s*(?!projectId)' src/web/entityRoutes.js | wc -c
```

(`-Pz` treats the file as one buffer so `\s*` spans newlines; a match means some call
site's options object does not start with `projectId`.)

Verification — upload calls (expect **no output**):

```bash
grep -n "uploadGeneratedImage(undefined\|uploadImageFromUrl(undefined\|uploadAttachmentBuffer(undefined\|uploadAttachmentFromUrl(undefined" src/web/entityRoutes.js
```

The same grep widened to the whole web layer —

```bash
grep -rn "uploadGeneratedImage(undefined\|uploadImageFromUrl(undefined\|uploadAttachmentBuffer(undefined\|uploadAttachmentFromUrl(undefined" src/web/
```

— still prints exactly five sites after this step (planning-time lines:
`artworkJobs.js:189`, `artworkJobs.js:357`, `storyboardGenerate.js:1503`,
`storyboardGrabFrame.js:132`, `falVideoGenerate.js:740`). Those live inside
intermediate modules whose internals are threaded in Task 20's pre-flip steps;
after that threading this widened grep returns zero matches.

- [ ] **Step 13: Route sweep D — intermediate web-helper entry points**

These route-called helpers live in other `src/web/*` modules. Where they take an
options object, add `projectId: req.projectId` so the value is available the moment
those modules thread it internally — their internals are threaded in Task 20's
pre-flip steps; they run on the transitional default-project fallback until then.
Enumerate:

```bash
grep -nE '\b(startVideoGenerationJob|buildVideoPayloadPreview|startGenerateArtworkJob|startRegenerateArtworkJob|startEditArtworkJob|undoArtworkEdit|deleteArtwork|grabFrameFromPrevious|collectStoryboardReferenceIds)\(' src/web/entityRoutes.js
```

Sites at planning time: 1951 (`startGenerateArtworkJob`), 2067
(`startRegenerateArtworkJob`), 2109 (`startEditArtworkJob`), 2133 (`undoArtworkEdit`),
2172 (`deleteArtwork`), 2763 (`grabFrameFromPrevious`), 3429
(`collectStoryboardReferenceIds`), 4184 (`buildVideoPayloadPreview`), 4250
(`startVideoGenerationJob`). All take a single options object → add
`projectId: req.projectId,` as the first key (same transformation as Step 12,
example: line 2133 `await undoArtworkEdit({ hostType, hostId, artworkId })` →
`await undoArtworkEdit({ projectId: req.projectId, hostType, hostId, artworkId })`).

Leave unchanged (and why):

- `streamBeatZip(req, res)` / `streamCharacterZip` / `streamLibraryZip` /
  `streamNotesZip` (lines 758–782) — they already receive `req` and can read
  `req.projectId` directly when `src/web/downloads.js` is threaded in Task 20's
  pre-flip steps.
- `announceBeatMedia({ req, ... })` and friends — already receive `req`.
- `findCharactersInBeat(undefined, beat)` (lines 485, 529, 2254, 4430, 4464 — the
  literal `undefined` left by the Phase B sweep is replaced with `req.projectId`
  in Task 20's pre-flip threading) and `kickoffImageVisionSeed(...)` /
  `kickoffLibraryVisionSeed(...)` — positional signatures owned by
  `storyboardGenerate.js` / `libraryVisionWorker.js`; they resolve the project
  transitionally. Their internals are threaded in Task 20's pre-flip steps.

Verification (expect output `0`):

```bash
grep -Pzo '(?:startVideoGenerationJob|buildVideoPayloadPreview|startGenerateArtworkJob|startRegenerateArtworkJob|startEditArtworkJob|undoArtworkEdit|deleteArtwork|grabFrameFromPrevious|collectStoryboardReferenceIds)\(\{\s*(?!projectId)' src/web/entityRoutes.js | wc -c
```

- [ ] **Step 14: Full suite + commit**

```bash
npm test
```

Expected: green. The sweep only *adds* arguments/keys; every helper resolves a falsy
`projectId` transitionally, and route tests that don't send `X-Project-Id` resolve to
the lazily-created default project. If a route test fails on a "not found", the most
likely cause is a helper that received `req.projectId` for an entity created under a
*different* (garbage) project id in that test — fix the test to create its fixtures
through the same default project (no explicit id), not by weakening the route.

```bash
git add src/web/entityRoutes.js
git commit -m "♻️ Thread req.projectId through every /api route helper and gateway call"
```

---

### Task 15: Rooms + gateway — project-scoped y-doc rooms, projectId through the gateway

> **Bridge-arg rule for this task's before-quotes:** after the Phase A/B sweeps, positional Mongo-helper call sites in the real files carry a literal `undefined` first argument (e.g. `setFramePrompt(undefined, sbId, frameId, value)`, `getBeat(undefined, beatId)`, `updateBeat(undefined, beatId, …)`) even where a before-quote below shows the original one-arg shape. The transformation REPLACES that `undefined` with `projectId` — never insert a second leading argument. Options-object helpers gain a `projectId` key instead.

Files:

- Modify: `src/web/roomRegistry.js`
  - `parseRoomName`/`buildRoomName` (lines 60–86)
  - `describeBeatRoom` (line 218), `describeCharacterRoom` (299), `describeNotesRoom`
    (389), `describeStoryboardsRoom` (449), `describeDialogsRoom` (529),
    `describeLibraryRoom` (614), `describePlotRoom` (713), `resolveRoom` (743)
- Modify: `src/web/hocuspocus.js` — `onAuthenticate` (lines 30–39), import (line 19)
- Modify: `src/web/gateway.js` — text core (lines 237–515), singleton literals
  (enumerated below), every exported helper (87 exports)
- Create: `tests/roomRegistry-projects.test.js`
- Test (update): `tests/plot-room.test.js`, `tests/library-room.test.js`,
  `tests/web-gateway-fallback.test.js`; check `tests/owned-image-room.test.js`,
  `tests/owned-attachment-room.test.js`, `tests/storyboards-room.test.js`,
  `tests/roomRegistry-scene-bible.test.js`, `tests/dialog-notes.test.js`,
  `tests/gateway-plot.test.js`, `tests/gateway-critique.test.js`,
  `tests/dialog-gateway.test.js`, `tests/storyboard-gateway.test.js`,
  `tests/dialog-audio-gateway.test.js`,
  `tests/storyboard-media-reference-gateway.test.js`, `tests/downloads.test.js`

- [ ] **Step 1: Write the failing roomRegistry tests**

Create `tests/roomRegistry-projects.test.js`:

```js
// Project-scoped singleton rooms (notes/library/plot become notes:<projectId>
// etc.), entity rooms unchanged, and project verification for room access.
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
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({}));

const { buildRoomName, parseRoomName, resolveRoom, assertRoomProjectKnown } =
  await import('../src/web/roomRegistry.js');
const Projects = await import('../src/mongo/projects.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');

beforeEach(() => fakeDb.reset());

describe('project-scoped room names', () => {
  it('buildRoomName/parseRoomName round-trip the three singleton rooms', () => {
    const pid = new ObjectId().toString();
    for (const type of ['notes', 'library', 'plot']) {
      const name = buildRoomName(type, pid);
      expect(name).toBe(`${type}:${pid}`);
      expect(parseRoomName(name)).toEqual({ type, projectId: pid });
    }
  });

  it('bare legacy singleton names are no longer managed rooms', () => {
    expect(parseRoomName('notes')).toBeNull();
    expect(parseRoomName('library')).toBeNull();
    expect(parseRoomName('plot')).toBeNull();
  });

  it('buildRoomName throws for a singleton room without a valid project id', () => {
    expect(() => buildRoomName('notes')).toThrow(/project/i);
    expect(() => buildRoomName('library', 'not-hex')).toThrow(/project/i);
  });

  it('entity rooms are unchanged', () => {
    const id = new ObjectId().toString();
    expect(buildRoomName('beat', id)).toBe(`beat:${id}`);
    expect(parseRoomName(`character:${id}`)).toEqual({ type: 'character', id });
    expect(parseRoomName(`storyboards:${id}`)).toEqual({ type: 'storyboards', id });
  });

  it('assertRoomProjectKnown accepts known projects and rejects unknown ones', async () => {
    const p = await Projects.createProject('Western');
    await expect(
      assertRoomProjectKnown(`notes:${p._id.toString()}`),
    ).resolves.toMatchObject({ type: 'notes', projectId: p._id.toString() });
    await expect(
      assertRoomProjectKnown(`notes:${new ObjectId().toString()}`),
    ).rejects.toThrow(/unknown project/i);
    await expect(assertRoomProjectKnown('garbage-room')).rejects.toThrow(/unknown room/i);
  });

  it('resolveRoom returns null for a singleton room of an unknown project', async () => {
    expect(await resolveRoom(`library:${new ObjectId().toString()}`)).toBeNull();
    expect(await resolveRoom(`notes:${new ObjectId().toString()}`)).toBeNull();
    expect(await resolveRoom(`plot:${new ObjectId().toString()}`)).toBeNull();
  });

  it('notes rooms are independent per project and persist to the composite prompts _id', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const aid = a._id.toString();
    const bid = b._id.toString();
    const noteA = await DirectorNotes.addDirectorNote({ projectId: aid, text: 'alpha' });

    const descA = await resolveRoom(`notes:${aid}`);
    expect(descA.fields).toEqual([`note:${noteA._id.toString()}:text`]);
    const descB = await resolveRoom(`notes:${bid}`);
    expect(descB.fields).toEqual([]);

    const result = await descA.persistFields({
      [`note:${noteA._id.toString()}:text`]: 'alpha v2',
    });
    expect(result.changed).toBe(true);
    expect((await DirectorNotes.getDirectorNotes(aid)).notes[0].text).toBe('alpha v2');
    expect((await DirectorNotes.getDirectorNotes(bid)).notes || []).toHaveLength(0);
    // The write landed on the composite-keyed doc, not the legacy singleton.
    const prompts = fakeDb.collection('prompts')._docs;
    expect(prompts.some((d) => d._id === `${aid}:director_notes`)).toBe(true);
    expect(prompts.some((d) => d._id === 'director_notes')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```bash
npx vitest run tests/roomRegistry-projects.test.js
```

Expected: import error first —
`assertRoomProjectKnown` is not exported (`undefined is not a function` /
`does not provide an export named 'assertRoomProjectKnown'`). After that hurdle the
round-trip assertions would fail (`buildRoomName('notes', pid)` returns `'notes'`,
`parseRoomName('notes')` returns `{ type: 'notes' }`).

- [ ] **Step 3: Implement project-scoped room names in `roomRegistry.js`**

> **Bridge-arg rule for this step's before-quotes:** after the Phase A/B sweeps, the positional Mongo-helper calls quoted below carry a literal `undefined` first argument in the real file (e.g. `setFramePrompt(undefined, sbId, frameId, value)`, `getBeat(undefined, beatId)`, `updateBeat(undefined, beatId, …)`, `getCharacter(undefined, characterId)`). The transformation REPLACES that `undefined` with `projectId` — never insert a second leading argument. Options-object calls (`listStoryboards({ beatId })`, `listDialogs({ beatId })`) match the quotes as-is and gain a `projectId` key.

**3a — parse/build.** Current lines 60–86:

```js
export function parseRoomName(roomName) {
  if (typeof roomName !== 'string') return null;
  if (roomName === 'notes') return { type: 'notes' };
  if (roomName === 'library') return { type: 'library' };
  if (roomName === 'plot') return { type: 'plot' };
  const m = roomName.match(/^([a-z_]+):(.+)$/);
  if (!m) return null;
  const [, type, rest] = m;
  if (
    type === 'beat' ||
    type === 'character' ||
    type === 'storyboards' ||
    type === 'dialogs'
  ) {
    if (!isOidHex(rest)) return null;
    return { type, id: rest };
  }
  return null;
}

export function buildRoomName(type, id) {
  if (type === 'notes') return 'notes';
  if (type === 'library') return 'library';
  if (type === 'plot') return 'plot';
  if (!isOidHex(String(id))) throw new Error(`invalid id for room: ${id}`);
  return `${type}:${id}`;
}
```

becomes:

```js
const SINGLETON_ROOM_TYPES = new Set(['notes', 'library', 'plot']);

export function parseRoomName(roomName) {
  if (typeof roomName !== 'string') return null;
  const m = roomName.match(/^([a-z_]+):(.+)$/);
  if (!m) return null;
  const [, type, rest] = m;
  // Singleton rooms are keyed by project: notes:<projectId>, library:<...>,
  // plot:<...>. The bare legacy names ('notes', 'library', 'plot') are no
  // longer managed — the multi-project migration renames the yjs_docs rows.
  if (SINGLETON_ROOM_TYPES.has(type)) {
    if (!isOidHex(rest)) return null;
    return { type, projectId: rest };
  }
  if (
    type === 'beat' ||
    type === 'character' ||
    type === 'storyboards' ||
    type === 'dialogs'
  ) {
    if (!isOidHex(rest)) return null;
    return { type, id: rest };
  }
  return null;
}

export function buildRoomName(type, id) {
  if (SINGLETON_ROOM_TYPES.has(type)) {
    if (!isOidHex(String(id))) {
      throw new Error(`invalid projectId for ${type} room: ${id}`);
    }
    return `${type}:${id}`;
  }
  if (!isOidHex(String(id))) throw new Error(`invalid id for room: ${id}`);
  return `${type}:${id}`;
}
```

**3b — project verification helpers.** Add below `isManagedRoom` (line 88), plus the
two imports at the top of the file
(`import { getProjectById } from '../mongo/projects.js';` next to the existing
`import { getDb } from '../mongo/client.js';`, and `ObjectId` is already imported):

```js
// Throws when the room name is unparseable or names a project that doesn't
// exist. Used by the Hocuspocus onAuthenticate hook so stale SPA tabs fail
// closed instead of joining a dead room.
export async function assertRoomProjectKnown(roomName) {
  const parsed = parseRoomName(roomName);
  if (!parsed) throw new Error(`Unknown room: ${roomName}`);
  if (parsed.projectId && !(await getProjectById(parsed.projectId))) {
    throw new Error(`Unknown project for room: ${roomName}`);
  }
  return parsed;
}

// Owning-project resolution for entity rooms. The room name only carries the
// entity ObjectId; the project comes from the entity doc itself.
async function projectIdForBeat(beatIdHex) {
  const doc = await getDb()
    .collection('plots')
    .findOne({ 'beats._id': new ObjectId(beatIdHex) });
  return doc?.project_id ? String(doc.project_id) : null;
}

async function projectIdForCharacter(charIdHex) {
  const doc = await getDb()
    .collection('characters')
    .findOne({ _id: new ObjectId(charIdHex) });
  return doc?.project_id ? String(doc.project_id) : null;
}

// Resolve + verify in one go: null when the entity is unknown, carries no
// project, or names a project that no longer exists.
async function verifiedProjectIdForBeat(beatIdHex) {
  const pid = await projectIdForBeat(beatIdHex);
  if (!pid || !(await getProjectById(pid))) return null;
  return pid;
}

async function verifiedProjectIdForCharacter(charIdHex) {
  const pid = await projectIdForCharacter(charIdHex);
  if (!pid || !(await getProjectById(pid))) return null;
  return pid;
}
```

(`tests/_fakeMongo.js` supports dotted-path queries across arrays — see its
`valuesAtPath` walker — so `{'beats._id': ObjectId}` works in tests and in real
Mongo alike.)

**3c — descriptor functions.** Each `describe*Room` gains its project. The diffs are
small and uniform; every changed line is shown:

`describeBeatRoom` (line 218) — before:

```js
async function describeBeatRoom(id) {
  const plot = await getPlot();
```

after:

```js
async function describeBeatRoom(id) {
  const projectId = await verifiedProjectIdForBeat(id);
  if (!projectId) return null;
  const plot = await getPlot(projectId);
```

and inside its `persistFields`:
`await setBeatSceneBible(id, bible);` → `await setBeatSceneBible(projectId, id, bible);`
`await updateBeat(id, patch);` → `await updateBeat(projectId, id, patch);`

`describeCharacterRoom` (line 299) — before:

```js
async function describeCharacterRoom(id) {
  const c = await getCharacter(id);
  if (!c) return null;
  const template = (await getCharacterTemplate())?.fields || [];
```

after:

```js
async function describeCharacterRoom(id) {
  const projectId = await verifiedProjectIdForCharacter(id);
  if (!projectId) return null;
  const c = await getCharacter(projectId, id);
  if (!c) return null;
  const template = (await getCharacterTemplate(projectId))?.fields || [];
```

and inside its `persistFields`:
`await updateCharacter(id, patch);` → `await updateCharacter(projectId, id, patch);`
(the inline `name_lower` recompute via `getDb().collection('characters').updateOne`
filters on `{ _id: c._id }` — globally unique, no change).

`describeNotesRoom` (line 389) — before:

```js
async function describeNotesRoom() {
  const doc = await getDirectorNotes();
```

after:

```js
async function describeNotesRoom(projectId) {
  if (!(await getProjectById(projectId))) return null;
  const doc = await getDirectorNotes(projectId);
```

and inside its `persistFields` — by this task, Task 3 has already replaced the
direct `prompts`-collection write with the directorNotes helper (and removed the
`col` binding), so exactly two lines change. Before:

```js
      const fresh = await getDirectorNotes();
```
```js
      await writeDirectorNotesArray(undefined, nextNotes);
```

after:

```js
      const fresh = await getDirectorNotes(projectId);
```
```js
      await writeDirectorNotesArray(projectId, nextNotes);
```

(`writeDirectorNotesArray(projectId, ...)` lands the write on the composite
`<projectId>:director_notes` doc — exactly what the Step 1 test asserts.)

`describeStoryboardsRoom` (line 449) — before:

```js
async function describeStoryboardsRoom(beatId) {
  const sbs = await listStoryboards({ beatId });
```

after:

```js
async function describeStoryboardsRoom(beatId) {
  const projectId = await verifiedProjectIdForBeat(beatId);
  if (!projectId) return null;
  const sbs = await listStoryboards({ projectId, beatId });
```

and inside its `persistFields`:
`await setFramePrompt(sbId, frameId, value);` → `await setFramePrompt(projectId, sbId, frameId, value);`
`await updateStoryboard(sbId, { [fieldName]: value });` → `await updateStoryboard(projectId, sbId, { [fieldName]: value });`

`describeDialogsRoom` (line 529) — before:

```js
async function describeDialogsRoom(beatId) {
  const dialogs = await listDialogs({ beatId });
  // The beat itself carries a shared "Dialogue Notes" fragment, alongside the
  // per-item body/character fragments. It steers generation/regeneration/critique.
  const beat = await getBeat(beatId).catch(() => null);
```

after:

```js
async function describeDialogsRoom(beatId) {
  const projectId = await verifiedProjectIdForBeat(beatId);
  if (!projectId) return null;
  const dialogs = await listDialogs({ projectId, beatId });
  // The beat itself carries a shared "Dialogue Notes" fragment, alongside the
  // per-item body/character fragments. It steers generation/regeneration/critique.
  const beat = await getBeat(projectId, beatId).catch(() => null);
```

and inside its `persistFields`:
`await updateBeat(beatId, { dialog_notes: snapshot.dialog_notes });` → `await updateBeat(projectId, beatId, { dialog_notes: snapshot.dialog_notes });`
`await updateDialog(dId, { [fieldName]: value });` → `await updateDialog(projectId, dId, { [fieldName]: value });`

`describeLibraryRoom` (line 614) — before:

```js
async function describeLibraryRoom() {
  const [files, attachmentFiles] = await Promise.all([
    listLibraryImages(),
    listLibraryAttachments(),
  ]);
```

after:

```js
async function describeLibraryRoom(projectId) {
  if (!(await getProjectById(projectId))) return null;
  const [files, attachmentFiles] = await Promise.all([
    listLibraryImages(projectId),
    listLibraryAttachments(projectId),
  ]);
```

(`setLibraryImageMeta` / `setLibraryAttachmentMeta` / `setOwnedImageMeta` /
`setOwnedAttachmentMeta` / `findImageFile` / `findAttachmentFile` stay GridFS-id-
addressed — `GET /image/:fileId` is id-addressed by design, per the spec.)

`describePlotRoom` (line 713) — before:

```js
async function describePlotRoom() {
  const plot = await getPlot();
```

after:

```js
async function describePlotRoom(projectId) {
  if (!(await getProjectById(projectId))) return null;
  const plot = await getPlot(projectId);
```

and inside its `persistFields`:
`await updatePlot(patch);` → `await updatePlot(projectId, patch);`

**3d — resolver.** Current lines 743–764 switch — the three singleton cases change:

```js
    case 'notes':
      return describeNotesRoom();
    case 'plot':
      return describePlotRoom();
    case 'library':
      return describeLibraryRoom();
```

becomes:

```js
    case 'notes':
      return describeNotesRoom(parsed.projectId);
    case 'plot':
      return describePlotRoom(parsed.projectId);
    case 'library':
      return describeLibraryRoom(parsed.projectId);
```

This is also how "EntitySync passes the parsed projectId into the persist functions"
is satisfied: `afterLoadDocument`/`onStoreDocument` call `resolveRoom(documentName)`,
and the returned descriptor's `persistFields` closure captures the project — the
hooks themselves need no signature change (verified against
`src/web/hocuspocus.js:54-101`).

- [ ] **Step 4: Run it — expect PASS**

```bash
npx vitest run tests/roomRegistry-projects.test.js
```

Expected: all 7 pass.

- [ ] **Step 5: Update the existing singleton-room tests**

`npx vitest run tests/plot-room.test.js tests/library-room.test.js` now fails
(bare `'plot'`/`'library'` rooms no longer parse). Update both files.

`tests/plot-room.test.js` — add after the existing imports block:

```js
const Projects = await import('../src/mongo/projects.js');

async function pid() {
  return (await Projects.getDefaultProject())._id.toString();
}
```

and update the assertions/calls (every changed line shown; current → new):

```js
    expect(parseRoomName('plot')).toEqual({ type: 'plot' });
```
→
```js
    const p = await pid();
    expect(parseRoomName(`plot:${p}`)).toEqual({ type: 'plot', projectId: p });
    expect(parseRoomName('plot')).toBeNull();
```
(make the test callback `async`), and:
```js
    expect(buildRoomName('plot')).toBe('plot');
```
→
```js
    const p = await pid();
    expect(buildRoomName('plot', p)).toBe(`plot:${p}`);
```
and the three `const desc = await resolveRoom('plot');` sites (lines 39, 50, 66) →
`const desc = await resolveRoom(`plot:${await pid()}`);`.

`tests/library-room.test.js` — same treatment for its `'library'` assertions (lines
50, 54) and five `resolveRoom('library')` sites (61, 78, 94, 125, 139), plus: the
`seedLibrary` fixture inserts GridFS docs directly with
`metadata: { owner_type: null, ... }`. Since `listLibraryImages(projectId)` now
filters on `metadata.project_id`, thread the project into the fixture — change the
helper signature and metadata:

```js
function seedLibrary({ id, name = '', description = '', projectId } = {}) {
  const doc = {
    _id: id || new ObjectId(),
    filename: 'a.png',
    contentType: 'image/png',
    length: 100,
    uploadDate: new Date(),
    metadata: {
      owner_type: null,
      owner_id: null,
      project_id: projectId,
      source: 'upload',
      prompt: null,
      generated_by: null,
      name,
      description,
      name_lower: name.toLowerCase(),
    },
  };
  fakeDb.collection('images.files')._docs.push(doc);
  return doc;
}
```

and pass `projectId: await pid()` at each `seedLibrary(...)` call site.

Then sweep the remaining room-descriptor tests — they use entity rooms
(`beat:<id>`, `character:<id>`, `storyboards:<id>`), which now require (a) the entity
doc to carry `project_id` and (b) that project to exist in the `projects` collection:

```bash
npx vitest run tests/owned-image-room.test.js tests/owned-attachment-room.test.js tests/storyboards-room.test.js tests/roomRegistry-scene-bible.test.js tests/dialog-notes.test.js
```

For any failure where `resolveRoom(...)` now returns `null`: the fixture entity was
created under a project id that has no `projects` row. Fix by creating fixtures via
the default project — `const pid = (await Projects.getDefaultProject())._id.toString();`
and pass it as an options key: `createBeat({ projectId: pid, ... })`,
`createCharacter({ projectId: pid, ... })`, `createStoryboard({ projectId: pid, ... })`
(the Mongo phase added the `projectId` option to each of those options-object
helpers). Do not relax the verification in `roomRegistry.js`.

- [ ] **Step 6: Hocuspocus `onAuthenticate` rejects unknown-project rooms**

`src/web/hocuspocus.js`. Current import (line 19):

```js
import { isManagedRoom, resolveRoom } from './roomRegistry.js';
```

becomes:

```js
import { assertRoomProjectKnown, resolveRoom } from './roomRegistry.js';
```

Current hook (lines 30–39):

```js
    async onAuthenticate({ token, documentName }) {
      if (!isManagedRoom(documentName)) {
        throw new Error(`Unknown room: ${documentName}`);
      }
      const session = await getSession(token);
      if (!session) throw new Error('invalid session');
      // Refresh last_seen but don't await — auth check should be fast.
      touchSession(token).catch(() => {});
      return { user: { name: session.username, sessionId: session.session_id } };
    },
```

becomes:

```js
    async onAuthenticate({ token, documentName }) {
      // Throws "Unknown room" for unparseable names and "Unknown project" for
      // singleton rooms whose project id no longer resolves — stale SPA tabs
      // fail closed at connect time.
      await assertRoomProjectKnown(documentName);
      const session = await getSession(token);
      if (!session) throw new Error('invalid session');
      // Refresh last_seen but don't await — auth check should be fast.
      touchSession(token).catch(() => {});
      return { user: { name: session.username, sessionId: session.session_id } };
    },
```

(`isManagedRoom` keeps its export in `roomRegistry.js` — nothing else imports it, but
removing exports isn't this task's job. The hook's behavior is covered by the
`assertRoomProjectKnown` tests from Step 1; there is no Hocuspocus server harness in
the suite.)

Run the targeted suites:

```bash
npx vitest run tests/roomRegistry-projects.test.js tests/plot-room.test.js tests/library-room.test.js
```

Expected: all pass. Commit:

```bash
git add src/web/roomRegistry.js src/web/hocuspocus.js tests/roomRegistry-projects.test.js tests/plot-room.test.js tests/library-room.test.js tests/owned-image-room.test.js tests/owned-attachment-room.test.js tests/storyboards-room.test.js tests/roomRegistry-scene-bible.test.js tests/dialog-notes.test.js
git commit -m "✨ Project-scope singleton y-doc rooms and verify entity-room projects"
```

(Trim the `git add` list to the test files actually touched in Step 5.)

- [ ] **Step 7: Gateway core — text helpers, fallback path, positional helpers**

All edits in `src/web/gateway.js`.

**7a — imports + room helper.** Add to the import block (next to line 34's
`import { buildRoomName } from './roomRegistry.js';`):

```js
import { resolveProjectId } from '../mongo/projects.js';
```

Add below `broadcastFieldsUpdated` (line 207):

```js
const SINGLETON_ENTITY_TYPES = new Set(['notes', 'library', 'plot']);

// Room name for a gateway mutation. Singleton rooms are keyed by project id;
// entity rooms by the entity's own ObjectId hex. `projectId` must already be
// resolved (24-hex) by the caller via resolveProjectId.
function roomNameFor(entityType, entityId, projectId) {
  if (SINGLETON_ENTITY_TYPES.has(entityType)) {
    return buildRoomName(entityType, projectId);
  }
  return buildRoomName(entityType, entityId);
}
```

**7b — text mutation core.** `setEntityFieldMarkdown` (line 450) — before:

```js
export async function setEntityFieldMarkdown({ entityType, entityId, field, markdown }) {
  if (!isHocuspocusRunning()) {
    await fallbackTextWrite({ entityType, entityId, field, op: 'set', markdown });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return;
  }
  const { setFragmentMarkdown } = await he();
  const roomName = buildRoomName(entityType, entityId);
```

after:

```js
export async function setEntityFieldMarkdown({ projectId, entityType, entityId, field, markdown }) {
  projectId = await resolveProjectId(projectId);
  if (!isHocuspocusRunning()) {
    await fallbackTextWrite({ projectId, entityType, entityId, field, op: 'set', markdown });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return;
  }
  const { setFragmentMarkdown } = await he();
  const roomName = roomNameFor(entityType, entityId, projectId);
```

Apply the identical four-line transformation to `editEntityFieldMarkdown` (line 468),
`appendEntityFieldMarkdown` (line 497), and `getEntityFieldMarkdown` (line 2275:
destructure `projectId`, resolve it, `roomNameFor(...)` — it has no fallback branch).

**7c — fallback readers/writers.** `readEntityField` (line 237) and
`fallbackTextWrite` (line 343) both gain `projectId` in their destructured options
(`{ projectId, entityType, entityId, field, ... }`) and thread it into the Mongo
helpers per the shared signatures. Every changed call inside them:

| current | new |
|---|---|
| `getBeat(entityId)` / `Plots.getBeat(entityId)` | `getBeat(projectId, entityId)` / `Plots.getBeat(projectId, entityId)` |
| `getCharacter(entityId)` | `getCharacter(projectId, entityId)` |
| `getDirectorNotes()` | `getDirectorNotes(projectId)` |
| `Plots.getPlot()` | `Plots.getPlot(projectId)` |
| `Plots.updatePlot({ [field]: args.markdown })` | `Plots.updatePlot(projectId, { [field]: args.markdown })` |
| `Plots.setBeatBody(entityId, args.markdown)` | `Plots.setBeatBody(projectId, entityId, args.markdown)` |
| `Plots.editBeatBody(entityId, args.edits)` | `Plots.editBeatBody(projectId, entityId, args.edits)` |
| `Plots.appendBeatBody(entityId, args.content)` | `Plots.appendBeatBody(projectId, entityId, args.content)` |
| `Plots.updateBeat(entityId, { ... })` | `Plots.updateBeat(projectId, entityId, { ... })` |
| `Plots.setBeatSceneBible(entityId, {...})` | `Plots.setBeatSceneBible(projectId, entityId, {...})` |
| `updateCharacter(entityId, { ... })` | `updateCharacter(projectId, entityId, { ... })` |
| `editDirectorNote({ noteId, text: args.markdown })` | `editDirectorNote({ projectId, noteId, text: args.markdown })` |
| `mongoGetStoryboard(fm[1])` etc. | `mongoGetStoryboard(projectId, fm[1])` |
| `mongoSetFramePrompt(fm[1], fm[2], args.markdown)` | `mongoSetFramePrompt(projectId, fm[1], fm[2], args.markdown)` |
| `mongoUpdateStoryboard(m[1], { ... })` | `mongoUpdateStoryboard(projectId, m[1], { ... })` |
| `mongoGetDialog(m[1])` | `mongoGetDialog(projectId, m[1])` |
| `mongoUpdateDialog(m[1], { ... })` | `mongoUpdateDialog(projectId, m[1], { ... })` |

GridFS metadata calls (`setOwnedImageMeta`, `setOwnedAttachmentMeta`,
`setLibraryImageMeta`, `setLibraryAttachmentMeta`, `findImageFile`,
`findAttachmentFile`) stay id-addressed — unchanged. The two recursive
`fallbackTextWrite({...})` self-calls inside the `edit`/`append` branches must pass
`projectId` through.

**7d — the five positional helpers** gain `projectId` as their first parameter, and
every caller is updated in the same commit (callers enumerated:
`src/web/entityRoutes.js:1379`, `src/agent/handlers.js:1193,1211,1263`,
`tests/web-gateway-fallback.test.js`, `tests/downloads.test.js:170-171` mock).
New signatures (bodies thread `projectId` into the calls shown):

```js
export async function setBeatBodyViaGateway(projectId, beatId, body) {
  return setEntityFieldMarkdown({
    projectId,
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    markdown: body,
  });
}

export async function editBeatBodyViaGateway(projectId, beatId, edits) {
  return editEntityFieldMarkdown({
    projectId,
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    edits,
  });
}

export async function appendBeatBodyViaGateway(projectId, beatId, content) {
  return appendEntityFieldMarkdown({
    projectId,
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    content,
  });
}
```

`updateBeatViaGateway(identifier, patch)` (line 548) → `updateBeatViaGateway(projectId, identifier, patch)`;
inside it: `const beat = await getBeat(identifier);` → `const beat = await getBeat(projectId, identifier);`,
both `setEntityFieldMarkdown({ entityType: 'beat', ... })` calls gain `projectId,`,
`await mongoUpdateBeat(beatId, onlyDiscrete);` → `await mongoUpdateBeat(projectId, beatId, onlyDiscrete);`,
and the trailing `return getBeat(beatId);` → `return getBeat(projectId, beatId);`.

`updateCharacterViaGateway(identifier, patch)` (line 599) → `updateCharacterViaGateway(projectId, identifier, patch)`;
inside: `getCharacter(identifier)` → `getCharacter(projectId, identifier)`, the
`setEntityFieldMarkdown` loop call gains `projectId,`, `mongoUpdateCharacter(cid, { unset })`
→ `mongoUpdateCharacter(projectId, cid, { unset })`, `return getCharacter(cid);` →
`return getCharacter(projectId, cid);`.

Caller updates (exact sites):

`src/web/entityRoutes.js:1379` —
`const result = await updateBeatViaGateway(beatId, patch);` →
`const result = await updateBeatViaGateway(req.projectId, beatId, patch);`

`src/agent/handlers.js:1193` —
`const beat = await Gateway.updateBeatViaGateway(identifier, { [field]: value });` →
`const beat = await Gateway.updateBeatViaGateway(context?.projectId, identifier, { [field]: value });`
(and equivalently for the two `updateCharacterViaGateway` sites at 1211 and 1263;
the agent phase already passes `context` into every handler — use whatever variable
holds it at those sites).

`tests/downloads.test.js:170-171` mock — arity-agnostic stubs, no change needed.

- [ ] **Step 8: Gateway sweep — singleton room literals**

MECHANICAL SWEEP. Enumerate:

```bash
grep -nE "broadcastFieldsUpdated\('(notes|library)'|entityId: '(notes|library)'" src/web/gateway.js
```

Site list at planning time (34 sites — line numbers shift after Step 7; re-grep):

```
659:    entityId: 'notes',            (editDirectorNoteViaGateway)
669:    entityId: 'notes',            (editDirectorNoteTextViaGateway)
691:  broadcastFieldsUpdated('notes', {        (addDirectorNoteViaGateway)
701:  broadcastFieldsUpdated('notes', {        (removeDirectorNoteViaGateway)
1012:    broadcastFieldsUpdated('library', {   (broadcastPriorImageOwner)
1026:    broadcastFieldsUpdated('notes', {     (broadcastPriorImageOwner)
1038:    broadcastFieldsUpdated('library', {   (broadcastPriorAttachmentOwner)
1052:    broadcastFieldsUpdated('notes', {     (broadcastPriorAttachmentOwner)
1186:  broadcastFieldsUpdated('notes', {       (attachExistingImageToDirectorNote…)
1240:    broadcastFieldsUpdated('notes', {     (attachExistingAttachmentToDirectorNote…)
1255:  broadcastFieldsUpdated('library', {     (moveBeatImageToLibrary…)
1271:  broadcastFieldsUpdated('library', {     (moveCharacterImageToLibrary…)
1281:  broadcastFieldsUpdated('notes', {       (moveDirectorNoteImageToLibrary…)
1285:  broadcastFieldsUpdated('library', {     (moveDirectorNoteImageToLibrary…)
1294:  broadcastFieldsUpdated('notes', {       (addDirectorNoteImage…)
1303:  broadcastFieldsUpdated('notes', {       (removeDirectorNoteImage…)
1312:  broadcastFieldsUpdated('notes', {       (setDirectorNoteMainImage…)
1321:  broadcastFieldsUpdated('notes', {       (addDirectorNoteAttachment…)
1330:  broadcastFieldsUpdated('notes', {       (removeDirectorNoteAttachment…)
2096/2104:  entityType/entityId: 'library'    (setLibraryImageMetaViaGateway ×2)
2110:  broadcastFieldsUpdated('library', {    (setLibraryImageMetaViaGateway)
2164/2172:  entityId: 'library'               (setLibraryAttachmentMetaViaGateway ×2)
2178:  broadcastFieldsUpdated('library', {    (setLibraryAttachmentMetaViaGateway)
2226:  broadcastFieldsUpdated('library', {    (addLibraryImageViaGateway)
2235:  broadcastFieldsUpdated('library', {    (removeLibraryImageViaGateway)
2265:  broadcastFieldsUpdated('library', {    (replaceLibraryImageViaGateway)
```

Uniform transformation, two forms:

1. `broadcastFieldsUpdated('notes', {...})` → `broadcastFieldsUpdated(buildRoomName('notes', projectId), {...})`
   (same for `'library'`), where `projectId` is the enclosing helper's resolved
   project — every enclosing helper begins with
   `projectId = await resolveProjectId(projectId);` (added in Step 9's sweep; for the
   helpers in this list add it now).
2. `setEntityFieldMarkdown({ entityType: 'notes', entityId: 'notes', ... })` →
   `setEntityFieldMarkdown({ projectId, entityType: 'notes', entityId: 'notes', ... })`
   — the literal `entityId` stays (it is ignored by `roomNameFor` for singleton
   types) so the diff stays minimal.

Real example 1 — `addDirectorNoteViaGateway`, current lines 686–697:

```js
export async function addDirectorNoteViaGateway({ text, position }) {
  // Add the note in Mongo (it gets a fresh _id), then ping the room so the
  // /notes page renders the new editor for its text fragment. The fragment
  // itself will be seeded from the just-written `text` on first connection.
  const note = await mongoAddDirectorNote({ text, position });
  broadcastFieldsUpdated('notes', {
    changed: ['notes'],
    added_note_id: note._id.toString(),
  });
  enqueueReindex('director_note', note._id.toString());
  return note;
}
```

after:

```js
export async function addDirectorNoteViaGateway({ projectId, text, position }) {
  projectId = await resolveProjectId(projectId);
  // Add the note in Mongo (it gets a fresh _id), then ping the room so the
  // /notes page renders the new editor for its text fragment. The fragment
  // itself will be seeded from the just-written `text` on first connection.
  const note = await mongoAddDirectorNote({ projectId, text, position });
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: ['notes'],
    added_note_id: note._id.toString(),
  });
  enqueueReindex('director_note', note._id.toString());
  return note;
}
```

Real example 2 — `broadcastPriorImageOwner` (private helper, lines 1010–1034): gains
a leading `projectId` parameter (already resolved by its callers) —

```js
function broadcastPriorImageOwner(movedFrom) {
  if (!movedFrom) {
    broadcastFieldsUpdated('library', { changed: ['library_images'] });
    return;
  }
```

after:

```js
function broadcastPriorImageOwner(projectId, movedFrom) {
  if (!movedFrom) {
    broadcastFieldsUpdated(buildRoomName('library', projectId), {
      changed: ['library_images'],
    });
    return;
  }
```

with its `'notes'` branch becoming
`broadcastFieldsUpdated(buildRoomName('notes', projectId), {...})`, identically for
`broadcastPriorAttachmentOwner(projectId, movedFrom)`, and the six call sites
(`broadcastPriorImageOwner(movedFrom)` → `broadcastPriorImageOwner(projectId, movedFrom)`,
etc.) inside `attachExistingImageToBeat/Character/DirectorNoteViaGateway` and
`attachExistingAttachmentTo*ViaGateway`.

Verification (expect **no output**):

```bash
grep -nE "broadcastFieldsUpdated\('(notes|library)'" src/web/gateway.js
```

- [ ] **Step 9: Gateway sweep — `projectId` on every exported helper**

MECHANICAL SWEEP across the 87 exports. Enumerate:

```bash
grep -nE '^export (async )?function' src/web/gateway.js
```

(Planning-time list: lines 143, 147, 450, 468, 497, 519, 528, 537, 548, 599, 657,
666, 675, 686, 699, 711, 719, 727, 735, 743, 751, 761, 771, 781, 812, 842, 885, 893,
919, 940, 949, 960, 974, 987, 1062, 1106, 1149, 1194, 1212, 1231, 1249, 1262, 1278,
1292, 1301, 1310, 1319, 1328, 1356, 1367, 1378, 1392, 1444, 1459, 1477, 1485, 1498,
1532, 1562, 1573, 1583, 1595, 1614, 1632, 1650, 1662, 1677, 1698, 1738, 1783, 1851,
1902, 1953, 1982, 2001, 2029, 2047, 2055, 2067, 2092, 2121, 2160, 2187, 2225, 2233,
2244, 2275.)

Exclusions: `setBotDisplayName`/`getBotDisplayName` (143/147 — not project-scoped);
the five positional helpers and four text-core functions already done in Step 7; the
literal-bearing helpers already done in Step 8.

Uniform transformation for every remaining options-object helper:

1. Add `projectId` as the **first destructured key**.
2. If the body builds a singleton room name or needs the value before a Mongo call
   resolves it, prepend `projectId = await resolveProjectId(projectId);` as the first
   statement. Helpers that only forward to already-resolving Mongo helpers and
   entity-room broadcasts may pass it through unresolved.
3. Thread it into every Mongo helper call: positional helpers get it as the new
   first argument (`pushBeatImage(projectId, String(beatId), imageMeta, !!setAsMain)`);
   options-object helpers get it as a key
   (`mongoCreateStoryboard({ projectId, beatId, ... })`).
4. Internal `setEntityFieldMarkdown`/`editEntityFieldMarkdown` calls gain the
   `projectId,` key.

Real example 1 — `addBeatImageViaGateway`, current lines 711–717:

```js
export async function addBeatImageViaGateway({ beatId, imageMeta, setAsMain }) {
  const result = await pushBeatImage(String(beatId), imageMeta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}
```

after:

```js
export async function addBeatImageViaGateway({ projectId, beatId, imageMeta, setAsMain }) {
  const result = await pushBeatImage(projectId, String(beatId), imageMeta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}
```

Real example 2 — `setStoryboardTextPromptViaGateway`, current lines 1356–1365:

```js
export async function setStoryboardTextPromptViaGateway({ storyboardId, text }) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  return setEntityFieldMarkdown({
    entityType: 'storyboards',
    entityId: sb.beat_id.toString(),
    field: storyboardItemField(sb._id.toString(), 'text_prompt'),
    markdown: text,
  });
}
```

after:

```js
export async function setStoryboardTextPromptViaGateway({ projectId, storyboardId, text }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  return setEntityFieldMarkdown({
    projectId,
    entityType: 'storyboards',
    entityId: sb.beat_id.toString(),
    field: storyboardItemField(sb._id.toString(), 'text_prompt'),
    markdown: text,
  });
}
```

Explicit deviating sites (not covered by the uniform rule):

- `setLibraryImageMetaViaGateway` / `setLibraryAttachmentMetaViaGateway` /
  `addLibraryImageViaGateway` / `removeLibraryImageViaGateway` /
  `replaceLibraryImageViaGateway` — already handled in Step 8 (they need the
  resolved `projectId` for `buildRoomName('library', projectId)` even on the
  no-Hocuspocus path, so each begins with
  `projectId = await resolveProjectId(projectId);`).
- `deleteStoryboardViaGateway` / `deleteDialogViaGateway` — also call
  `listStoryboards({ beatId })` / `listDialogs({ beatId })` for the reorder
  recompaction → those become `listStoryboards({ projectId, beatId })` /
  `listDialogs({ projectId, beatId })`.
- `setDialogCharacterViaGateway` — calls `getCharacter(raw)` for roster matching →
  `getCharacter(projectId, raw)`.
- `createArtworkFromImageViaGateway` — also passes through to
  `copyImageToNewOwner({ imageId, ownerType, ownerId, filenameBase })`, which gains a
  `projectId` key (GridFS copies must stamp `metadata.project_id`).
- `attachExistingImageTo*` / `attachExistingAttachmentTo*` /
  `moveDirectorNoteImageToLibraryViaGateway` — combine Step 8's literal replacement
  with this step's threading; each starts with
  `projectId = await resolveProjectId(projectId);` because they broadcast to
  `notes`/`library` rooms.
- `getDirectorNotes()` calls inside `attachExistingImageToDirectorNoteViaGateway`
  → `getDirectorNotes(projectId)`.

Verification (expect output `0`, then **no output**):

```bash
grep -Pzo 'export async function [a-zA-Z]+ViaGateway\(\{\s*(?!projectId)' src/web/gateway.js | wc -c
grep -nE "broadcastFieldsUpdated\('(notes|library)'|entityId: '(notes|library)'" src/web/gateway.js | grep -v "projectId" | grep "broadcastFieldsUpdated('"
```

- [ ] **Step 10: Update gateway tests + add fallback-scoping coverage**

`tests/web-gateway-fallback.test.js` — the positional-helper calls must match the new
signatures. Add near the imports:

```js
const Projects = await import('../src/mongo/projects.js');
```

and update the five call sites (current → new):

```js
    await Gateway.setBeatBodyViaGateway(beat._id.toString(), 'Once upon a time...');
```
→
```js
    const pid = (await Projects.getDefaultProject())._id.toString();
    await Gateway.setBeatBodyViaGateway(pid, beat._id.toString(), 'Once upon a time...');
```
likewise `appendBeatBodyViaGateway(pid, beat._id.toString(), 'second')`,
`editBeatBodyViaGateway(pid, beat._id.toString(), [...])`,
`updateBeatViaGateway(pid, '1', 'not-an-object')` (and the other
`updateBeatViaGateway`/`updateCharacterViaGateway` sites:
`Gateway.updateCharacterViaGateway(pid, c._id.toString(), {...})`).

Append one new cross-project isolation test to the same file:

```js
  it('director-note gateway helpers stay scoped to the passed project', async () => {
    const a = await (await import('../src/mongo/projects.js')).createProject('A');
    const b = await (await import('../src/mongo/projects.js')).createProject('B');
    const aid = a._id.toString();
    const bid = b._id.toString();
    const note = await Gateway.addDirectorNoteViaGateway({ projectId: aid, text: 'scoped' });
    await Gateway.editDirectorNoteViaGateway({
      projectId: aid,
      noteId: note._id.toString(),
      text: 'scoped v2',
    });
    expect((await DirectorNotes.getDirectorNotes(aid)).notes[0].text).toBe('scoped v2');
    expect((await DirectorNotes.getDirectorNotes(bid)).notes || []).toHaveLength(0);
  });
```

Then run every gateway-touching suite and fix fallout (the transitional resolver
means most pass untouched — failures indicate a call site where an argument landed in
the wrong position, i.e. a real sweep mistake):

```bash
npx vitest run tests/web-gateway-fallback.test.js tests/gateway-plot.test.js tests/gateway-critique.test.js tests/dialog-gateway.test.js tests/storyboard-gateway.test.js tests/dialog-audio-gateway.test.js tests/storyboard-media-reference-gateway.test.js tests/downloads.test.js tests/spa-links-handlers.test.js
```

Expected: all pass.

- [ ] **Step 11: Full suite + commit**

```bash
npm test
```

Expected: green. Then:

```bash
git add src/web/gateway.js src/web/entityRoutes.js src/agent/handlers.js tests/web-gateway-fallback.test.js
git commit -m "♻️ Thread projectId through gateway helpers and project-scoped room broadcasts"
```

#### End-of-task verification (Task 14 + 15 together)

```bash
npx vitest run tests/projectMiddleware.test.js tests/project-routes.test.js tests/roomRegistry-projects.test.js tests/plot-room.test.js tests/library-room.test.js tests/web-gateway-fallback.test.js
npm test
```

Expected: every named file passes; full suite green.
## Phase E: SPA

The backend phases gave us: `GET /api/projects` / `POST /api/projects`, the
`resolveProject()` middleware (`X-Project-Id` header, `?project_id=` SSE query
fallback, missing-header → default project), project-scoped `GET /api/info`
(now returns `project_id` + `project_title`), and project-scoped singleton
y-doc rooms (`plot:<projectId>`, `notes:<projectId>`, `library:<projectId>`)
in `roomRegistry`/`onAuthenticate`. This phase makes the browser speak that
protocol: project in the URL, project header on every fetch, project-scoped
room names, and a Project Manager dialog.

**Test-infra reality check (verified):** there is no web test harness.
`web/` contains only `index.html`, `src/`, `dist/`, `vite.config.js` — **no
`web/package.json`** (SPA deps live in the root `package.json`; root
`devDependencies` are only `@vitejs/plugin-react`, `vite`, `vitest` — no
jsdom/@testing-library). Root `vitest.config.js` is:

```js
export default {
  test: {
    setupFiles: ['./tests/setup.js'],
  },
};
```

and no `*.test.*` files exist under `web/`. Per the agreed convention we do
**not** invent a test harness: every task in this phase is verified by
`npm run build:web` succeeding (Vite catches syntax/import errors), `npm test`
staying green (these tasks touch nothing the Node suite imports), and explicit
manual QA steps.

**Routing approach (decision, affects all three tasks):** the SPA has ~17
app-absolute internal links/navigations (`navigate('/')` in `Beat.jsx:95`,
`About.jsx:14`, `Character.jsx:91`, `Library.jsx:29`, `Notes.jsx:34`;
`<Link to="/about">` in `Header.jsx:55` and `DialogIndex.jsx:80`;
`<Link to="/">` in `StoryboardIndex.jsx:59` and `DialogIndex.jsx:66`;
`basePath="/beat"`/`"/storyboard"`/`"/dialog"` BeatPager props; the
`BeatTabs.jsx` `base:` strings; `Toc.jsx:297` `/beat/${b.order}` links; the
`/character/…` links in `Toc.jsx:123-124` and `BeatCharacters.jsx:91-92`).
We do **not** sweep them. Under the new route tree they resolve outside
`/p/*` and land on the catch-all `RedirectToProject`, which immediately
(client-side `navigate`, no reload, no network) bounces back into the
correct project. Two-tab isolation is preserved because `RedirectToProject`
prefers the **per-tab module store** (`getCurrentProject()`, set by
`ProjectProvider` on this tab) over localStorage. A link sweep to
project-prefixed paths is an optional follow-up, not v1.

**Expected interim breakage (harmless, called out so QA isn't a surprise):**
the backend room renames (Phase on rooms/gateway) landed before this phase, so
until Task 18 commits, the About/Notes/Library pages' `CollabSurface` still
requests the bare `plot`/`notes`/`library` rooms and shows
"Collaboration error: Auth failed: …" (Hocuspocus `onAuthenticate` rejects
unknown-project rooms). Build and `npm test` stay green throughout; entity
rooms (beat/character/storyboards/dialogs pages) work the whole time. Task 16
and 17 manual QA therefore avoids asserting on those three surfaces.

### Task 16: Project context + routing

**Files:**
- Modify: `web/src/api.js` (store after `withBase` at lines 8–10; `authHeaders` at lines 12–18; `apiSseUrl` at lines 135–139)
- Create: `web/src/project/ProjectContext.jsx`
- Create: `web/src/project/RedirectToProject.jsx`
- Modify: `web/src/App.jsx` (authed return block, lines 57–74, plus imports)
- Test: none (no web harness — `npm run build:web` + manual QA, see preamble)

- [ ] **Step 1: Confirm test-infra status and current code (read-only)**

  Run and eyeball — these ground the edits below:

  ```bash
  ls web/                       # expect: dist  index.html  src  vite.config.js  (NO package.json)
  npx vitest list 2>/dev/null | grep -c web   # expect: 0
  npm run build:web             # expect: "✓ built in …" (baseline green)
  ```

- [ ] **Step 2: Add the module-level project store to `web/src/api.js`**

  Current code at the top of the file (lines 8–10):

  ```js
  function withBase(p) {
    return `${BASE}${p}`;
  }
  ```

  Insert immediately **after** that block (before `authHeaders`):

  ```js
  // ---------------------------------------------------------------------------
  // Current-project store (module-level, not a hook — same pattern as
  // auth/session.js#loadSession). ProjectProvider calls setCurrentProject()
  // once the URL's :projectTitle resolves; every subsequent fetch carries the
  // X-Project-Id header and SSE URLs carry &project_id=.
  // ---------------------------------------------------------------------------

  const PROJECT_KEY = 'screenplay_project_v1';

  let currentProject = null; // { id, title } | null

  export function setCurrentProject(p) {
    currentProject = p?.id && p?.title
      ? { id: String(p.id), title: String(p.title) }
      : null;
    if (!currentProject) return;
    try {
      localStorage.setItem(
        PROJECT_KEY,
        JSON.stringify({ project_id: currentProject.id, title: currentProject.title }),
      );
    } catch {
      // localStorage unavailable (private mode) — the header still works for this tab.
    }
  }

  export function getCurrentProject() {
    return currentProject;
  }

  // Last project this BROWSER viewed (vs getCurrentProject() = this TAB).
  // Used by RedirectToProject for legacy URLs opened in a fresh tab.
  export function loadStoredProject() {
    try {
      const raw = localStorage.getItem(PROJECT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.project_id || !parsed?.title) return null;
      return { id: String(parsed.project_id), title: String(parsed.title) };
    } catch {
      return null;
    }
  }

  // Canonical URL of a project's TOC. Full-reload project switches use
  // location.assign(projectHomeUrl(title)).
  export function projectHomeUrl(title) {
    return withBase(`/p/${encodeURIComponent(title)}/`);
  }
  ```

  (`projectHomeUrl` lives here, not in ProjectContext.jsx, deliberately:
  api.js already owns `BASE`, and it avoids an ESM cycle when
  `ProjectManagerDialog` — imported by ProjectContext in Task 17 — needs it.)

- [ ] **Step 3: `authHeaders` adds `X-Project-Id`**

  Current code (lines 12–18):

  ```js
  function authHeaders(extra = {}) {
    const s = loadSession();
    return {
      ...extra,
      ...(s?.session_id ? { 'X-Session-Id': s.session_id } : {}),
    };
  }
  ```

  Replace with:

  ```js
  function authHeaders(extra = {}) {
    const s = loadSession();
    return {
      ...extra,
      ...(s?.session_id ? { 'X-Session-Id': s.session_id } : {}),
      ...(currentProject?.id ? { 'X-Project-Id': currentProject.id } : {}),
    };
  }
  ```

  (When the store is unset — login screen, `/api/projects` fetches inside
  ProjectProvider/RedirectToProject — no header is sent and the server-side
  middleware falls back to the default project. That is the designed behavior
  for stale bundles too.)

- [ ] **Step 4: `apiSseUrl` appends `project_id`**

  Current code (lines 135–139):

  ```js
  export function apiSseUrl(path) {
    const s = loadSession();
    const sep = path.includes('?') ? '&' : '?';
    return `${withBase(`/api${path}`)}${sep}session_id=${encodeURIComponent(s?.session_id || '')}`;
  }
  ```

  Replace with:

  ```js
  export function apiSseUrl(path) {
    const s = loadSession();
    const sep = path.includes('?') ? '&' : '?';
    const project = currentProject?.id
      ? `&project_id=${encodeURIComponent(currentProject.id)}`
      : '';
    return `${withBase(`/api${path}`)}${sep}session_id=${encodeURIComponent(s?.session_id || '')}${project}`;
  }
  ```

  The single caller (`web/src/widgets/GenerateVideoDialog.jsx:357`,
  `apiSseUrl(`/storyboard/${storyboardId}/video-job/${jobId}/events`)`) needs
  no change — the param is appended for every SSE URL and the
  `resolveProject()` middleware reads the `?project_id=` query fallback.

- [ ] **Step 5: Create `web/src/project/ProjectContext.jsx`**

  Complete new file:

  ```jsx
  // ProjectContext
  //
  // Resolves the /p/:projectTitle URL segment to { id, title } via
  // GET /api/projects (title match is case-insensitive, mirroring the
  // /character/Steve human-identifier convention), then:
  //   - publishes it to the module store in api.js (authHeaders →
  //     X-Project-Id, apiSseUrl → &project_id=) BEFORE any child renders, so
  //     every child fetch is project-scoped;
  //   - persists it to localStorage 'screenplay_project_v1' as this browser's
  //     last-used project (read back by RedirectToProject);
  //   - sets document.title to the project title.
  // Unknown titles render a "project not found" screen instead of children.
  // Modeled on editor/PresenceContext.jsx.

  import { createContext, useContext, useEffect, useState } from 'react';
  import { useParams } from 'react-router-dom';
  import { apiGet, setCurrentProject, projectHomeUrl } from '../api.js';

  const ProjectContext = createContext(null);

  export function useProject() {
    const ctx = useContext(ProjectContext);
    if (!ctx) throw new Error('useProject must be inside <ProjectProvider>');
    return ctx; // { id, title }
  }

  export function ProjectProvider({ children }) {
    const { projectTitle } = useParams();
    const [state, setState] = useState({ status: 'loading' });

    useEffect(() => {
      let cancelled = false;
      setState({ status: 'loading' });
      (async () => {
        let projects;
        try {
          const data = await apiGet('/projects');
          projects = data?.projects || [];
        } catch (e) {
          if (!cancelled) setState({ status: 'error', message: e.message });
          return;
        }
        if (cancelled) return;
        const wanted = String(projectTitle || '').trim().toLowerCase();
        const match = projects.find(
          (p) => String(p.title).trim().toLowerCase() === wanted,
        );
        if (!match) {
          setState({ status: 'not_found', projects });
          return;
        }
        const project = { id: String(match.id), title: String(match.title) };
        setCurrentProject(project);
        document.title = project.title;
        setState({ status: 'ready', project });
      })();
      return () => { cancelled = true; };
    }, [projectTitle]);

    if (state.status === 'loading') {
      return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading project…</p></div>;
    }
    if (state.status === 'error') {
      return <div className="app"><div className="error-banner">Could not load projects: {state.message}</div></div>;
    }
    if (state.status === 'not_found') {
      return <ProjectNotFound title={projectTitle} projects={state.projects} />;
    }
    return (
      <ProjectContext.Provider value={state.project}>
        {children}
      </ProjectContext.Provider>
    );
  }

  function ProjectNotFound({ title, projects }) {
    return (
      <main className="app">
        <h1>Project not found</h1>
        <p style={{ color: 'var(--fg-muted)' }}>
          No project is titled “{title}”.
        </p>
        {projects.length > 0 && (
          <>
            <p>Available projects:</p>
            <ul>
              {projects.map((p) => (
                <li key={p.id}>
                  <a href={projectHomeUrl(p.title)}>{p.title}</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    );
  }
  ```

  Note on sequencing: the assigned design says this screen has "a button
  opening the Project Manager" — that dialog is built in **Task 17**, which
  also upgrades this screen to use it. Task 16 ships the screen fully
  functional with direct project links so no step here depends on
  not-yet-written code.

- [ ] **Step 6: Create `web/src/project/RedirectToProject.jsx`**

  Complete new file:

  ```jsx
  // RedirectToProject
  //
  // Catch-all target for every path that is NOT under /p/:projectTitle/* —
  // both legacy shared URLs (/beat/2, /character/Steve, bare /) and the
  // app's own absolute internal links (navigate('/'), <Link to="/about">),
  // which intentionally still use legacy paths. Re-enters the project tree,
  // preserving the path, by this priority:
  //   1. getCurrentProject() — per-TAB module store, set by ProjectProvider.
  //      Keeps in-app clicks inside their own project even when another tab
  //      viewed a different project more recently (two-tab isolation).
  //   2. loadStoredProject() — this browser's last-used project (localStorage).
  //   3. First project from GET /api/projects (the backend lazily creates a
  //      default project, so the list is never empty in practice).
  // Uses react-router navigate (no reload): location.pathname from
  // useLocation() is already basename-relative, and navigate() re-applies
  // the basename.

  import { useEffect, useState } from 'react';
  import { useLocation, useNavigate } from 'react-router-dom';
  import { apiGet, getCurrentProject, loadStoredProject } from '../api.js';

  export function RedirectToProject() {
    const location = useLocation();
    const navigate = useNavigate();
    const [error, setError] = useState(null);

    useEffect(() => {
      let cancelled = false;
      (async () => {
        let target = getCurrentProject() || loadStoredProject();
        if (!target) {
          try {
            const data = await apiGet('/projects');
            const first = data?.projects?.[0];
            target = first ? { id: String(first.id), title: String(first.title) } : null;
          } catch (e) {
            if (!cancelled) setError(e.message);
            return;
          }
        }
        if (cancelled) return;
        if (!target) {
          setError('No projects exist yet.');
          return;
        }
        const suffix = `${location.pathname}${location.search}${location.hash}`;
        navigate(`/p/${encodeURIComponent(target.title)}${suffix}`, { replace: true });
      })();
      return () => { cancelled = true; };
      // Run once for the location we mounted with; a successful run navigates away.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (error) {
      return <div className="app"><div className="error-banner">{error}</div></div>;
    }
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading…</p></div>;
  }
  ```

  (Bare `/` produces `/p/<title>/`; `/beat/2` produces `/p/<title>/beat/2` —
  legacy deep links keep their target page.)

- [ ] **Step 7: Restructure `web/src/App.jsx`**

  Current authed return block (lines 57–74) — this is the code being
  replaced, quoted exactly:

  ```jsx
    return (
      <>
        <Header session={session} onLogout={() => { clearSession(); setSession(null); }} />
        <Routes>
          <Route path="/" element={<Toc session={session} />} />
          <Route path="/beat/:order" element={<Beat session={session} />} />
          <Route path="/character/:name" element={<Character session={session} />} />
          <Route path="/notes" element={<Notes session={session} />} />
          <Route path="/library" element={<Library session={session} />} />
          <Route path="/storyboard" element={<StoryboardIndex session={session} />} />
          <Route path="/storyboard/:order" element={<StoryboardBeat session={session} />} />
          <Route path="/dialog" element={<DialogIndex session={session} />} />
          <Route path="/dialog/:order" element={<DialogBeat session={session} />} />
          <Route path="/about" element={<About session={session} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </>
    );
  }
  ```

  Replace the whole file with (only the route structure and two imports
  change; the session-check effect and login branch are untouched):

  ```jsx
  import { useEffect, useState } from 'react';
  import { Routes, Route, Navigate } from 'react-router-dom';
  import { Login } from './routes/Login.jsx';
  import { Toc } from './routes/Toc.jsx';
  import { Beat } from './routes/Beat.jsx';
  import { Character } from './routes/Character.jsx';
  import { Notes } from './routes/Notes.jsx';
  import { Library } from './routes/Library.jsx';
  import { StoryboardIndex } from './routes/StoryboardIndex.jsx';
  import { StoryboardBeat } from './routes/StoryboardBeat.jsx';
  import { DialogIndex } from './routes/DialogIndex.jsx';
  import { DialogBeat } from './routes/DialogBeat.jsx';
  import { About } from './routes/About.jsx';
  import { Header } from './widgets/Header.jsx';
  import { ProjectProvider } from './project/ProjectContext.jsx';
  import { RedirectToProject } from './project/RedirectToProject.jsx';
  import { loadSession, validateSession, clearSession } from './auth/session.js';

  // Everything project-scoped lives under /p/:projectTitle/*. ProjectProvider
  // resolves the title (and blocks children until the api.js store is set);
  // the descendant <Routes> match against the splat remainder, so the
  // existing route paths are unchanged. The Header moves inside the provider
  // because it shows the project title (Task 17).
  function ProjectShell({ session, onLogout }) {
    return (
      <ProjectProvider>
        <Header session={session} onLogout={onLogout} />
        <Routes>
          <Route path="/" element={<Toc session={session} />} />
          <Route path="/beat/:order" element={<Beat session={session} />} />
          <Route path="/character/:name" element={<Character session={session} />} />
          <Route path="/notes" element={<Notes session={session} />} />
          <Route path="/library" element={<Library session={session} />} />
          <Route path="/storyboard" element={<StoryboardIndex session={session} />} />
          <Route path="/storyboard/:order" element={<StoryboardBeat session={session} />} />
          <Route path="/dialog" element={<DialogIndex session={session} />} />
          <Route path="/dialog/:order" element={<DialogBeat session={session} />} />
          <Route path="/about" element={<About session={session} />} />
          {/* Unknown subpath: bounce via the app-root catch-all
              (RedirectToProject re-enters this project from the per-tab store). */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ProjectProvider>
    );
  }

  export function App() {
    const [session, setSession] = useState(undefined); // undefined = checking, null = none, object = active

    useEffect(() => {
      let cancelled = false;
      (async () => {
        const stored = loadSession();
        if (!stored) {
          if (!cancelled) setSession(null);
          return;
        }
        const ok = await validateSession(stored.session_id);
        if (cancelled) return;
        if (ok?.valid) {
          setSession({ session_id: stored.session_id, username: ok.username });
        } else {
          clearSession();
          setSession(null);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []);

    if (session === undefined) {
      return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading…</p></div>;
    }

    if (!session) {
      return (
        <Routes>
          <Route
            path="*"
            element={<Login onAuthed={(s) => setSession(s)} />}
          />
        </Routes>
      );
    }

    return (
      <Routes>
        <Route
          path="/p/:projectTitle/*"
          element={
            <ProjectShell
              session={session}
              onLogout={() => { clearSession(); setSession(null); }}
            />
          }
        />
        <Route path="*" element={<RedirectToProject />} />
      </Routes>
    );
  }
  ```

- [ ] **Step 8: Build — expect success**

  ```bash
  npm run build:web
  ```

  Expected: Vite finishes with `✓ built in …` and no errors. (Before Step 7
  exists, importing `./project/ProjectContext.jsx` would fail the build with
  `Could not resolve "./project/ProjectContext.jsx"` — creating the files
  first keeps every intermediate state buildable.)

- [ ] **Step 9: Manual QA (Task 16 scope only — skip About/Notes/Library, see phase preamble)**

  With Mongo migrated (Phase migration task) and the bot + Hocuspocus
  running (`npm run dev`), in another terminal `npm run dev:web`, then in a
  browser:

  1. Visit `http://localhost:5173/` → URL becomes
     `http://localhost:5173/p/<DefaultTitle>/` and the TOC renders.
  2. Visit a legacy deep link `http://localhost:5173/beat/1` → URL becomes
     `/p/<DefaultTitle>/beat/1` and that beat renders (entity room connects).
  3. DevTools → Network → any `/api/toc` request carries the
     `X-Project-Id: <24-hex>` request header.
  4. `localStorage.getItem('screenplay_project_v1')` in the console returns
     `{"project_id":"<24-hex>","title":"<DefaultTitle>"}`.
  5. The tab title (document.title) equals the project title.
  6. Visit `http://localhost:5173/p/NoSuchProject/` → "Project not found"
     screen listing the existing project(s) as links; clicking one lands on
     its TOC.

- [ ] **Step 10: Keep the Node suite green, then commit**

  ```bash
  npm test
  ```

  Expected: all existing tests pass (nothing in `tests/` imports `web/src`).

  ```bash
  git add web/src/api.js web/src/project/ProjectContext.jsx web/src/project/RedirectToProject.jsx web/src/App.jsx
  git commit -m "✨ Add project context, /p/:projectTitle routing, and legacy redirects to SPA"
  ```

**Task 16 verification:** `npm run build:web` → `✓ built in …`; `npm test` →
all tests pass; manual QA items 1–6 above behave as described.

### Task 17: Header brand + ProjectManagerDialog

**Files:**
- Create: `web/src/widgets/ProjectManagerDialog.jsx`
- Modify: `web/src/widgets/Header.jsx` (whole component, lines 1–63)
- Modify: `web/src/project/ProjectContext.jsx` (ProjectNotFound gains the dialog)
- Modify: `web/src/styles.css` (after the `.app-header .brand` rule, lines 74–79)
- Test: none (no web harness — `npm run build:web` + manual QA)

- [ ] **Step 1: Create `web/src/widgets/ProjectManagerDialog.jsx`**

  Built on `widgets/Modal.jsx` exactly as its other consumers use it
  (`open`/`title`/`onClose`/`footer` props; Modal autofocuses the first
  `input` inside the body, which here is the create-title field — a nice
  default). `currentProjectId` is a **prop**, not `useProject()`, because the
  "project not found" screen renders this dialog when no project context
  exists. Switching and create-then-switch use `location.assign` (full
  reload) per the design — one move that kills every stale WebSocket,
  EventSource, and job poll.

  Complete new file:

  ```jsx
  // ProjectManagerDialog
  //
  // v1 scope: list + switch + create (rename/delete deferred). Opened from
  // the Header brand and from the "project not found" screen. Switching
  // navigates with a FULL page load (location.assign) so every Hocuspocus
  // socket, EventSource, and poller from the old project is torn down.

  import { useEffect, useState } from 'react';
  import { Modal } from './Modal.jsx';
  import { apiGet, apiPostJson, projectHomeUrl } from '../api.js';

  export function ProjectManagerDialog({ open, onClose, currentProjectId = null }) {
    const [projects, setProjects] = useState(null); // null = loading
    const [error, setError] = useState(null);
    const [title, setTitle] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      if (!open) return;
      let cancelled = false;
      setError(null);
      setTitle('');
      setProjects(null);
      (async () => {
        try {
          const data = await apiGet('/projects');
          if (!cancelled) setProjects(data?.projects || []);
        } catch (e) {
          if (!cancelled) setError(e.message);
        }
      })();
      return () => { cancelled = true; };
    }, [open]);

    function switchTo(projectTitle) {
      location.assign(projectHomeUrl(projectTitle));
    }

    async function create(e) {
      e?.preventDefault();
      const trimmed = title.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setError(null);
      try {
        const created = await apiPostJson('/projects', { title: trimmed });
        switchTo(created.title);
        // No state reset — location.assign tears this page down.
      } catch (err) {
        // 409 duplicate / 400 invalid title surface here: api.js check()
        // extracts the JSON {error} body into err.message.
        setError(err.message);
        setBusy(false);
      }
    }

    return (
      <Modal
        open={open}
        title="Projects"
        onClose={onClose}
        footer={<button type="button" onClick={onClose}>Close</button>}
      >
        {error && <div className="error-banner">{error}</div>}

        {!projects && !error && (
          <p style={{ color: 'var(--fg-muted)' }}>Loading projects…</p>
        )}

        {projects && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {projects.map((p) => {
              const current = p.id === currentProjectId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => { if (!current) switchTo(p.title); }}
                    disabled={current}
                    style={{ width: '100%', textAlign: 'left' }}
                    title={current ? 'Current project' : `Switch to ${p.title}`}
                  >
                    {p.title}
                    {current && (
                      <span style={{ color: 'var(--fg-muted)', marginLeft: 8, fontSize: 12 }}>
                        current
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={create} style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New project title"
            maxLength={120}
            style={{ flex: 1 }}
          />
          <button type="submit" className="primary" disabled={busy || !title.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </form>
      </Modal>
    );
  }
  ```

- [ ] **Step 2: Rewrite the Header brand**

  Current `web/src/widgets/Header.jsx` — the parts being changed, quoted
  exactly. Imports (lines 1–5):

  ```jsx
  import { useEffect, useState } from 'react';
  import { Link } from 'react-router-dom';
  import { apiGet } from '../api.js';
  import { useConnectedUsers } from '../editor/PresenceContext.jsx';
  import { SavedIndicator } from './SavedIndicator.jsx';
  ```

  Component (lines 29–63):

  ```jsx
  export function Header({ session, onLogout }) {
    const users = useConnectedUsers();
    const [title, setTitle] = useState('');
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const info = await apiGet('/info');
          if (!cancelled) setTitle(info?.screenplay_title || '');
        } catch {
          // Header just falls back to "Screenplay" if /info fails.
        }
      })();
      return () => { cancelled = true; };
    }, []);
    const seen = new Map();
    for (const u of users) {
      const key = u?.name || Math.random();
      if (!seen.has(key)) seen.set(key, u);
    }
    const list = Array.from(seen.values());
    const brand = title.trim() || 'Screenplay';
    return (
      <header className="app-header">
        <Link to="/" className="brand" title={brand}>{brand}</Link>
        <div className="meta">
          <Link to="/about" title="Project name, synopsis & global dialogue style">About</Link>
          <SavedIndicator />
          <div className="presence-dots">{list.map((u, i) => <Dot key={i} user={u} />)}</div>
          <span>signed in as <strong>{session.username}</strong></span>
          <button onClick={onLogout} title="Clear local session">Logout</button>
        </div>
      </header>
    );
  }
  ```

  Replace imports with (the `/info` fetch and its `useEffect`/`apiGet` go
  away — the brand is now the project title from context, which the spec
  says replaces the screenplay's own `title` content field as the brand):

  ```jsx
  import { useState } from 'react';
  import { Link } from 'react-router-dom';
  import { useConnectedUsers } from '../editor/PresenceContext.jsx';
  import { useProject } from '../project/ProjectContext.jsx';
  import { SavedIndicator } from './SavedIndicator.jsx';
  import { ProjectManagerDialog } from './ProjectManagerDialog.jsx';
  ```

  and replace the component with:

  ```jsx
  export function Header({ session, onLogout }) {
    const users = useConnectedUsers();
    const project = useProject();
    const [managerOpen, setManagerOpen] = useState(false);
    const seen = new Map();
    for (const u of users) {
      const key = u?.name || Math.random();
      if (!seen.has(key)) seen.set(key, u);
    }
    const list = Array.from(seen.values());
    const brand = project.title;
    return (
      <header className="app-header">
        <button
          type="button"
          className="brand"
          title={`${brand} — switch or create projects`}
          onClick={() => setManagerOpen(true)}
        >
          {brand}
        </button>
        <div className="meta">
          <Link to="/about" title="Project name, synopsis & global dialogue style">About</Link>
          <SavedIndicator />
          <div className="presence-dots">{list.map((u, i) => <Dot key={i} user={u} />)}</div>
          <span>signed in as <strong>{session.username}</strong></span>
          <button onClick={onLogout} title="Clear local session">Logout</button>
        </div>
        <ProjectManagerDialog
          open={managerOpen}
          onClose={() => setManagerOpen(false)}
          currentProjectId={project.id}
        />
      </header>
    );
  }
  ```

  (The `Dot` helper and `colorForUser` at the top of the file are untouched.
  Header renders inside `ProjectProvider` — Task 16 moved it into
  `ProjectShell` — so `useProject()` is safe.)

- [ ] **Step 3: Style the brand button like the old brand link**

  The global `button` rule (styles.css lines 29–37) adds a background,
  border, and padding that would turn the brand into a chip. Current rule
  being extended (lines 74–79):

  ```css
  .app-header .brand {
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--fg);
    text-decoration: none;
  }
  ```

  Insert immediately after it:

  ```css
  /* The brand is now a <button> (opens the Project Manager) — strip the
     global button chrome so it still reads as the wordmark. */
  .app-header button.brand {
    background: none;
    border: none;
    border-radius: 0;
    padding: 0;
    cursor: pointer;
  }
  ```

- [ ] **Step 4: "Project not found" screen opens the Project Manager**

  In `web/src/project/ProjectContext.jsx` (created in Task 16), replace the
  `ProjectNotFound` component:

  ```jsx
  function ProjectNotFound({ title, projects }) {
    return (
      <main className="app">
        <h1>Project not found</h1>
        <p style={{ color: 'var(--fg-muted)' }}>
          No project is titled “{title}”.
        </p>
        {projects.length > 0 && (
          <>
            <p>Available projects:</p>
            <ul>
              {projects.map((p) => (
                <li key={p.id}>
                  <a href={projectHomeUrl(p.title)}>{p.title}</a>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    );
  }
  ```

  with:

  ```jsx
  function ProjectNotFound({ title, projects }) {
    const [managerOpen, setManagerOpen] = useState(false);
    return (
      <main className="app">
        <h1>Project not found</h1>
        <p style={{ color: 'var(--fg-muted)' }}>
          No project is titled “{title}”.
        </p>
        {projects.length > 0 && (
          <>
            <p>Available projects:</p>
            <ul>
              {projects.map((p) => (
                <li key={p.id}>
                  <a href={projectHomeUrl(p.title)}>{p.title}</a>
                </li>
              ))}
            </ul>
          </>
        )}
        <p>
          <button className="primary" onClick={() => setManagerOpen(true)}>
            Open Project Manager
          </button>
        </p>
        <ProjectManagerDialog
          open={managerOpen}
          onClose={() => setManagerOpen(false)}
          currentProjectId={null}
        />
      </main>
    );
  }
  ```

  and add the import at the top of the file (after the existing api.js
  import):

  ```jsx
  import { ProjectManagerDialog } from '../widgets/ProjectManagerDialog.jsx';
  ```

  (`useState` is already imported in this file. The dialog imports
  `projectHomeUrl` from `api.js`, not from this file, so there is no import
  cycle.)

- [ ] **Step 5: Build — expect success**

  ```bash
  npm run build:web
  ```

  Expected: `✓ built in …`, no errors.

- [ ] **Step 6: Manual QA**

  With the same dev setup as Task 16 QA:

  1. Header brand shows the project title; hovering shows
     "<title> — switch or create projects"; visually identical weight/color
     to the old wordmark (no button chrome).
  2. Click the brand → modal titled "Projects" lists every project; the
     current one is disabled and marked "current"; the title input has focus.
  3. Type a new title (e.g. `Second Feature`) → Create → full page reload at
     `/p/Second%20Feature/` showing an empty TOC; the header brand now reads
     "Second Feature".
  4. Open the dialog again and create a duplicate (`second feature`) →
     inline `error-banner` with the server's duplicate-title message; the
     dialog stays open; no navigation.
  5. Click the first project in the list → full reload back into it.
  6. Visit `/p/NoSuchProject/` → not-found screen now has an
     "Open Project Manager" button that opens the same dialog (no current
     project highlighted) and can switch/create from there.

- [ ] **Step 7: Keep the Node suite green, then commit**

  ```bash
  npm test
  ```

  Expected: all existing tests pass.

  ```bash
  git add web/src/widgets/ProjectManagerDialog.jsx web/src/widgets/Header.jsx web/src/project/ProjectContext.jsx web/src/styles.css
  git commit -m "✨ Show project title in header and add Project Manager dialog"
  ```

**Task 17 verification:** `npm run build:web` → `✓ built in …`; `npm test` →
all tests pass; manual QA items 1–6 above behave as described.

### Task 18: Singleton room consumers + serving verification + final QA

**Files:**
- Modify: `web/src/routes/About.jsx` (line 22)
- Modify: `web/src/widgets/NotesPanel.jsx` (line 20)
- Modify: `web/src/widgets/LibraryPanel.jsx` (line 72)
- Verify only: `web/src/widgets/SceneBiblePanel.jsx` (line 107), `src/server/index.js` (lines 154–165), `web/vite.config.js`
- Test: none (no web harness — `npm run build:web` + manual QA)

This is a three-site sweep of the only string-literal `room=` props in the
SPA. Enumeration command and its current output:

```bash
grep -rn 'room="' web/src --include='*.jsx'
```

```
web/src/widgets/NotesPanel.jsx:20:      <CollabSurface room="notes" session={session} onPing={onChange}>
web/src/routes/About.jsx:22:      <CollabSurface room="plot" session={session}>
web/src/widgets/LibraryPanel.jsx:72:    <CollabSurface room="library" session={session} onPing={onChange}>
```

Every other `room=` prop is already an entity-room template literal
(`beat:${...}` / `character` / `storyboards` / `dialogs` rooms built from
`_id`s in `Beat.jsx:125`, `Character.jsx:116`, `StoryboardBeat.jsx:475`,
`DialogBeat.jsx:343`, `SceneBiblePanel.jsx:107`) and entity rooms are
unchanged in this design. The transformation is uniform — add
`useProject()` and project-scope the room string — and all three sites are
shown in full below.

- [ ] **Step 1: `About.jsx` → room `plot:<projectId>`**

  Current code (lines 1–3 imports and line 22), quoted exactly:

  ```jsx
  import { useNavigate } from 'react-router-dom';
  import { CollabSurface } from '../editor/CollabSurface.jsx';
  import { CollabField } from '../editor/CollabField.jsx';
  ```

  ```jsx
      <CollabSurface room="plot" session={session}>
  ```

  New imports:

  ```jsx
  import { useNavigate } from 'react-router-dom';
  import { CollabSurface } from '../editor/CollabSurface.jsx';
  import { CollabField } from '../editor/CollabField.jsx';
  import { useProject } from '../project/ProjectContext.jsx';
  ```

  Inside the component, the current opening (lines 8–9):

  ```jsx
  export function About({ session }) {
    const navigate = useNavigate();
  ```

  becomes:

  ```jsx
  export function About({ session }) {
    const navigate = useNavigate();
    const { id: projectId } = useProject();
  ```

  and the surface line becomes:

  ```jsx
      <CollabSurface room={`plot:${projectId}`} session={session}>
  ```

- [ ] **Step 2: `NotesPanel.jsx` → room `notes:<projectId>`**

  Current code (lines 1–6 and line 20), quoted exactly:

  ```jsx
  import { apiDelete, apiPostJson } from '../api.js';
  import { CollabSurface } from '../editor/CollabSurface.jsx';
  import { CollabField } from '../editor/CollabField.jsx';
  import { ImageGallery } from './ImageGallery.jsx';

  export function NotesPanel({ notes, session, onChange }) {
  ```

  ```jsx
        <CollabSurface room="notes" session={session} onPing={onChange}>
  ```

  New:

  ```jsx
  import { apiDelete, apiPostJson } from '../api.js';
  import { CollabSurface } from '../editor/CollabSurface.jsx';
  import { CollabField } from '../editor/CollabField.jsx';
  import { ImageGallery } from './ImageGallery.jsx';
  import { useProject } from '../project/ProjectContext.jsx';

  export function NotesPanel({ notes, session, onChange }) {
    const { id: projectId } = useProject();
  ```

  ```jsx
        <CollabSurface room={`notes:${projectId}`} session={session} onPing={onChange}>
  ```

  (The per-note fragment names `note:${note._id}:text` at line 34 are
  fragments *within* the room and derive from note ObjectIds — unchanged.)

- [ ] **Step 3: `LibraryPanel.jsx` → room `library:<projectId>`**

  Current code (lines 1–5 imports, line 20 component opening, line 72
  surface), quoted exactly:

  ```jsx
  import { useMemo, useRef, useState } from 'react';
  import { apiDelete, apiPostMultipart, imageUrl, thumbUrl } from '../api.js';
  import { CollabSurface } from '../editor/CollabSurface.jsx';
  import { CollabField } from '../editor/CollabField.jsx';
  import { AttachmentList } from './AttachmentList.jsx';
  ```

  ```jsx
  export function LibraryPanel({ data, session, onChange, query }) {
    const [busy, setBusy] = useState(false);
  ```

  ```jsx
      <CollabSurface room="library" session={session} onPing={onChange}>
  ```

  New:

  ```jsx
  import { useMemo, useRef, useState } from 'react';
  import { apiDelete, apiPostMultipart, imageUrl, thumbUrl } from '../api.js';
  import { CollabSurface } from '../editor/CollabSurface.jsx';
  import { CollabField } from '../editor/CollabField.jsx';
  import { AttachmentList } from './AttachmentList.jsx';
  import { useProject } from '../project/ProjectContext.jsx';
  ```

  ```jsx
  export function LibraryPanel({ data, session, onChange, query }) {
    const { id: projectId } = useProject();
    const [busy, setBusy] = useState(false);
  ```

  ```jsx
      <CollabSurface room={`library:${projectId}`} session={session} onPing={onChange}>
  ```

  (The `library:${img._id}:name` / `library:${img._id}:description` fragment
  names at lines 114 and 118 are fragments within the room, keyed on GridFS
  file ids — unchanged. Note: `useProject()` is called before the
  `if (!session?.session_id)` early return at line 62, satisfying the rules
  of hooks.)

- [ ] **Step 4: Sweep verification grep — expect zero matches**

  ```bash
  grep -rn 'room="' web/src --include='*.jsx'
  ```

  Expected output: *(nothing — exit code 1)*. All `room=` props are now
  template literals.

- [ ] **Step 5: Verify `SceneBiblePanel` reuses an entity room (no change)**

  Current code at `web/src/widgets/SceneBiblePanel.jsx:107`, quoted exactly:

  ```jsx
          <CollabSurface room={`beat:${beatId}`} session={session}>
  ```

  `beat:<hex>` is an entity room (ObjectId-derived); entity rooms are
  unchanged by this design — the backend resolves the owning project from
  the beat document itself. **No edit.** Record in the executor's notes that
  this was checked.

- [ ] **Step 6: Verify the Express SPA fallback already serves `/p/*` (no change)**

  Current code at `src/server/index.js:154-165`, quoted exactly:

  ```js
    // Serve the built SPA (vite build output) if present. Fallback to index.html
    // so client-side routing works (Login, /beat/:order, /character/:name, etc.).
    if (config.web.staticDir && fs.existsSync(config.web.staticDir)) {
      app.use(express.static(config.web.staticDir));
      app.get(/^\/(?!auth|api|health|pdf|image|attachment).*/, (_req, res, next) => {
        const indexPath = path.join(config.web.staticDir, 'index.html');
        fs.access(indexPath, fs.constants.R_OK, (err) => {
          if (err) return next();
          res.sendFile(indexPath);
        });
      });
    }
  ```

  The negative lookahead only excludes paths starting with
  `auth|api|health|pdf|image|attachment`; `/p/<anything>` (including a
  project literally titled "api", whose URL is `/p/api/...` — the lookahead
  tests the segment right after the leading `/`) falls through to
  `index.html`. **Verify-only; no edit.** Likewise the Vite dev server needs
  nothing: `web/vite.config.js` proxies only
  `/api`, `/auth`, `/image`, `/attachment`, `/pdf`, and Vite's default
  `appType: 'spa'` history fallback serves `index.html` for `/p/*`.

  Spot-check after the build in Step 7:

  ```bash
  curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://localhost:3000/p/Whatever/beat/2
  ```

  Expected: `200 text/html; charset=UTF-8`.

- [ ] **Step 7: Build — expect success**

  ```bash
  npm run build:web
  ```

  Expected: `✓ built in …`, no errors.

- [ ] **Step 8: Full multi-project manual QA checklist**

  Backend + Hocuspocus running with a migrated DB (`npm run dev`), SPA via
  `npm run dev:web` (and optionally the built bundle via Express on :3000
  for the Step 6 curl):

  1. **Default flow**: open `http://localhost:5173/` → redirected to
     `/p/<DefaultTitle>/`; TOC, beats, characters all render.
  2. **Singleton rooms connect again** (this task un-breaks the interim
     state): `/p/<DefaultTitle>/about`, `/notes`, `/library` each show their
     CollabFields (no "Collaboration error"), and typing in the About
     synopsis shows the Saved indicator cycle.
  3. **Create project**: brand → Project Manager → create `Project B` →
     full reload at `/p/Project%20B/`.
  4. **Isolation, content**: in Project B, About/synopsis is empty; add a
     director's note and a library image; switch back to the default project
     → its notes/library do NOT contain Project B's items, and vice versa.
  5. **Isolation, two tabs**: tab 1 on `/p/<DefaultTitle>/notes`, tab 2 on
     `/p/Project%20B/notes`. Edits in one tab never appear in the other.
     In tab 1 click "← Back to TOC" and the About link — both stay under
     `/p/<DefaultTitle>/...` even though tab 2 (Project B) was opened more
     recently (per-tab module store wins over localStorage in
     RedirectToProject).
  6. **Legacy URL redirect**: open `http://localhost:5173/beat/1` in a fresh
     tab → lands on `/p/<lastUsedTitle>/beat/1` (last-used per
     localStorage); clear localStorage
     (`localStorage.removeItem('screenplay_project_v1')`) and repeat → lands
     in the first/default project.
  7. **Presence**: with both tabs in the SAME project's notes page, each
     tab's presence dot appears in the other's header; across DIFFERENT
     projects, it does not.

- [ ] **Step 9: Keep the Node suite green, then commit**

  ```bash
  npm test
  ```

  Expected: all existing tests pass.

  ```bash
  git add web/src/routes/About.jsx web/src/widgets/NotesPanel.jsx web/src/widgets/LibraryPanel.jsx
  git commit -m "✨ Scope About/Notes/Library collab rooms to the current project"
  ```

**Task 18 verification:** `grep -rn 'room="' web/src --include='*.jsx'` →
zero matches; `npm run build:web` → `✓ built in …`; `npm test` → all tests
pass; manual QA items 1–7 above behave as described.
## Phase F: Migration + strict flip + docs

This phase ships the one-shot data migration, threads the intermediate web/pdf modules
that earlier phases deliberately left on the transitional fallback, removes the
transitional default-project fallback (failing closed on any missed threading site),
proves cross-project isolation with a dedicated suite, and updates CLAUDE.md / the
system prompt to match reality.

Phase F depends on Phases A–E being complete: `src/mongo/projects.js` exists with the
transitional `resolveProjectId`, every mongo helper takes `projectId` (first positional
parameter, or an options key for single-options-object helpers), and the SPA/REST/agent
layers thread it. **Do not start Task 20 until `npm test` is green on the prior phases.**

---

### Task 19: Migration script (`scripts/migrate-multi-project.js`)

Implements the spec's 7 numbered migration steps (spec § "Migration",
`docs/superpowers/specs/2026-06-09-multi-project-design.md` lines 210–233), modeled on
the established script shape in `scripts/migrate-character-images.js` (shebang, doc
comment, `connectMongo`/`closeMongo` from `src/mongo/client.js`, console progress lines,
non-zero `process.exitCode` on failure). One deliberate deviation from that precedent:
the new script exports a `migrate(db, opts)` function and only auto-runs `main()` when
executed directly, so the Vitest suite can import the logic against the fake db without
side effects.

**Files:**
- Create: `scripts/migrate-multi-project.js`
- Test: `tests/migrateMultiProject.test.js`
- Modify: `tests/_fakeMongo.js` (add `updateMany` to `makeCollection()`, after `updateOne` which ends at line 354)
- Modify (guarded verification): `src/mongo/client.js:95` (characters unique index — owned by the Phase B sweep; verify it landed, fix if missed)

**Fake-db capability notes (read `tests/_fakeMongo.js` first — already done while writing this plan):**
- Supported: `findOne`, `insertOne`, `insertMany`, `updateOne` (`$set`/`$push`/`$pull`/`$unset`, upsert), `deleteOne`, `find().sort().limit().toArray()`, no-op `createIndex`.
- Missing: `updateMany` (added below — needed for the stamping sweep), `dropIndex` (NOT added; the script guards the index drop behind `typeof col.dropIndex === 'function'`, which the fake fails trivially, per the "capability check" pattern).
- `deepClone` in the fake mangles BSON `Binary`/`Uint8Array` values (they fall through to the plain-object branch). The migration script copies `yjs_docs.state` opaquely via spread (`{ ...legacy, _id: newId }`), so the test seeds **string markers** (`'BIN_PLOT'` etc.) instead of real `Binary` — asserting the same "bytes are carried over untouched" property without fighting the clone.
- The fake's `$exists: false` on a dotted path (`metadata.project_id`) only matches when the parent object exists. Real GridFS files always have `metadata` in this codebase, and the test seeds GridFS-shaped docs with `metadata` objects, so behavior matches real Mongo for every doc we care about.

- [ ] **Step 1: Write the failing test**

Create `tests/migrateMultiProject.test.js` with exactly this content:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
  closeMongo: async () => {},
}));

const { migrate } = await import('../scripts/migrate-multi-project.js');

const CHANNEL_ID = 'chan-123';
const beatId = new ObjectId();
const entityRoomId = `beat:${beatId.toString()}`;

async function seedLegacy() {
  await fakeDb.collection('plots').insertOne({
    _id: 'main',
    title: '**The Heist**',
    synopsis: 'A crew plans one last job.',
    notes: '',
    beats: [
      {
        _id: beatId,
        name: 'Opening',
        desc: 'The vault.',
        body: '',
        images: [],
        main_image_id: null,
      },
    ],
    current_beat_id: null,
    updated_at: new Date(),
  });
  await fakeDb.collection('prompts').insertMany([
    {
      _id: 'character_template',
      fields: [{ name: 'bio', description: 'Bio', required: false, core: true }],
    },
    {
      _id: 'plot_template',
      synopsis_guidance: 'Keep it short.',
      beat_guidance: 'One scene per beat.',
    },
    {
      _id: 'director_notes',
      notes: [{ _id: new ObjectId(), text: 'More dogs.', images: [] }],
    },
  ]);
  await fakeDb.collection('yjs_docs').insertMany([
    { _id: 'plot', state: 'BIN_PLOT', updated_at: new Date() },
    { _id: 'notes', state: 'BIN_NOTES', updated_at: new Date() },
    { _id: 'library', state: 'BIN_LIBRARY', updated_at: new Date() },
    { _id: entityRoomId, state: 'BIN_BEAT', updated_at: new Date() },
  ]);
  await fakeDb.collection('characters').insertMany([
    { _id: new ObjectId(), name: 'Steve', name_lower: 'steve', fields: {} },
    { _id: new ObjectId(), name: 'Alice', name_lower: 'alice', fields: {} },
  ]);
  await fakeDb.collection('messages').insertMany([
    { _id: new ObjectId(), channel_id: CHANNEL_ID, role: 'user', content: 'hi', created_at: new Date() },
    { _id: new ObjectId(), channel_id: CHANNEL_ID, role: 'assistant', content: 'hello', created_at: new Date() },
  ]);
  await fakeDb.collection('storyboards').insertOne({ _id: new ObjectId(), beat_id: beatId, shots: [] });
  await fakeDb.collection('dialogs').insertOne({ _id: new ObjectId(), beat_id: beatId, lines: [] });
  await fakeDb.collection('images.files').insertOne({
    _id: new ObjectId(),
    filename: 'lib.png',
    length: 3,
    chunkSize: 261120,
    uploadDate: new Date(),
    metadata: { owner_type: null, owner_id: null, source: 'upload', kind: null },
  });
  await fakeDb.collection('attachments.files').insertOne({
    _id: new ObjectId(),
    filename: 'notes.txt',
    length: 3,
    chunkSize: 261120,
    uploadDate: new Date(),
    metadata: { owner_type: 'beat', owner_id: beatId },
  });
}

describe('migrate-multi-project', () => {
  beforeEach(async () => {
    fakeDb.reset();
    await seedLegacy();
  });

  it('creates the default project titled from the stripped plot title', async () => {
    const summary = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(summary.createdProject).toBe(true);
    expect(summary.title).toBe('The Heist');
    const projects = await fakeDb.collection('projects').find({}).toArray();
    expect(projects).toHaveLength(1);
    expect(projects[0].title).toBe('The Heist');
    expect(projects[0].title_lower).toBe('the heist');
    expect(projects[0].created_at).toBeInstanceOf(Date);
    expect(summary.projectId).toBe(projects[0]._id.toString());
  });

  it('stamps project_id on content docs and GridFS metadata', async () => {
    const { projectId } = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect((await fakeDb.collection('plots').findOne({ _id: 'main' })).project_id).toBe(projectId);
    for (const c of await fakeDb.collection('characters').find({}).toArray()) {
      expect(c.project_id).toBe(projectId);
    }
    for (const m of await fakeDb.collection('messages').find({}).toArray()) {
      expect(m.project_id).toBe(projectId);
    }
    for (const s of await fakeDb.collection('storyboards').find({}).toArray()) {
      expect(s.project_id).toBe(projectId);
    }
    for (const d of await fakeDb.collection('dialogs').find({}).toArray()) {
      expect(d.project_id).toBe(projectId);
    }
    for (const f of await fakeDb.collection('images.files').find({}).toArray()) {
      expect(f.metadata.project_id).toBe(projectId);
    }
    for (const f of await fakeDb.collection('attachments.files').find({}).toArray()) {
      expect(f.metadata.project_id).toBe(projectId);
    }
  });

  it('re-keys the three prompts singletons to composite ids', async () => {
    const { projectId } = await migrate(fakeDb, { channelId: CHANNEL_ID });
    for (const key of ['character_template', 'plot_template', 'director_notes']) {
      expect(await fakeDb.collection('prompts').findOne({ _id: key })).toBeNull();
      const moved = await fakeDb.collection('prompts').findOne({ _id: `${projectId}:${key}` });
      expect(moved).not.toBeNull();
      expect(moved.project_id).toBe(projectId);
    }
    const tpl = await fakeDb.collection('prompts').findOne({ _id: `${projectId}:character_template` });
    expect(tpl.fields[0].name).toBe('bio');
  });

  it('renames the singleton yjs rooms preserving state and leaves entity rooms alone', async () => {
    const { projectId } = await migrate(fakeDb, { channelId: CHANNEL_ID });
    for (const [room, marker] of [
      ['plot', 'BIN_PLOT'],
      ['notes', 'BIN_NOTES'],
      ['library', 'BIN_LIBRARY'],
    ]) {
      expect(await fakeDb.collection('yjs_docs').findOne({ _id: room })).toBeNull();
      const moved = await fakeDb.collection('yjs_docs').findOne({ _id: `${room}:${projectId}` });
      expect(moved).not.toBeNull();
      expect(moved.state).toBe(marker);
    }
    const beatRoom = await fakeDb.collection('yjs_docs').findOne({ _id: entityRoomId });
    expect(beatRoom.state).toBe('BIN_BEAT');
  });

  it('points channel_state at the default project without clobbering an existing pointer', async () => {
    const { projectId } = await migrate(fakeDb, { channelId: CHANNEL_ID });
    const cs = await fakeDb.collection('channel_state').findOne({ _id: CHANNEL_ID });
    expect(cs.current_project_id).toBe(projectId);
    // Simulate the operator having switched projects, then re-running the migration.
    await fakeDb
      .collection('channel_state')
      .updateOne({ _id: CHANNEL_ID }, { $set: { current_project_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
    await migrate(fakeDb, { channelId: CHANNEL_ID });
    const after = await fakeDb.collection('channel_state').findOne({ _id: CHANNEL_ID });
    expect(after.current_project_id).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('is idempotent: a second run is a no-op on converged state', async () => {
    const first = await migrate(fakeDb, { channelId: CHANNEL_ID });
    const second = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(second.createdProject).toBe(false);
    expect(second.renamedProject).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(second.title).toBe(first.title);
    expect(second.promptsRekeyed).toBe(0);
    expect(second.yjsRenamed).toBe(0);
    for (const count of Object.values(second.stamped)) expect(count).toBe(0);
    expect(await fakeDb.collection('projects').find({}).toArray()).toHaveLength(1);
    expect(await fakeDb.collection('prompts').find({}).toArray()).toHaveLength(3);
    expect(await fakeDb.collection('yjs_docs').find({}).toArray()).toHaveLength(4);
  });

  it('recovers when the NEW code restarted before the migration (startup seeding ran first): adopts + renames the lazy "Screenplay" project and lets legacy templates overwrite the freshly-seeded defaults', async () => {
    // Simulate the wrong deploy order: the restarted bot's first request ran
    // getDefaultProject() (lazily creating a "Screenplay" project) and
    // seedProjectDefaults cloned FRESH default templates for it. The legacy
    // singletons (with the user's customizations) still exist, and the main
    // plot doc is still un-stamped.
    const lazyId = new ObjectId();
    const lazyPid = lazyId.toString();
    await fakeDb.collection('projects').insertOne({
      _id: lazyId,
      title: 'Screenplay',
      title_lower: 'screenplay',
      created_at: new Date(),
    });
    await fakeDb.collection('prompts').insertMany([
      {
        _id: `${lazyPid}:character_template`,
        project_id: lazyPid,
        fields: [{ name: 'fresh_default', description: 'D', required: false, core: true }],
      },
      {
        _id: `${lazyPid}:plot_template`,
        project_id: lazyPid,
        synopsis_guidance: 'fresh default',
        beat_guidance: 'fresh default',
      },
    ]);

    const summary = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(summary.createdProject).toBe(false);
    expect(summary.renamedProject).toBe(true);
    expect(summary.projectId).toBe(lazyPid);
    expect(summary.title).toBe('The Heist');
    const projects = await fakeDb.collection('projects').find({}).toArray();
    expect(projects).toHaveLength(1);
    expect(projects[0].title).toBe('The Heist');
    expect(projects[0].title_lower).toBe('the heist');

    // The user's CUSTOMIZED legacy templates won over the freshly-seeded defaults.
    const tpl = await fakeDb.collection('prompts').findOne({ _id: `${lazyPid}:character_template` });
    expect(tpl.fields.map((f) => f.name)).toContain('bio');
    expect(tpl.fields.map((f) => f.name)).not.toContain('fresh_default');
    const plotTpl = await fakeDb.collection('prompts').findOne({ _id: `${lazyPid}:plot_template` });
    expect(plotTpl.synopsis_guidance).toBe('Keep it short.');
    for (const key of ['character_template', 'plot_template', 'director_notes']) {
      expect(await fakeDb.collection('prompts').findOne({ _id: key })).toBeNull();
    }
    expect(await fakeDb.collection('prompts').find({}).toArray()).toHaveLength(3);

    // Idempotent from the recovered state too.
    const second = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(second.createdProject).toBe(false);
    expect(second.renamedProject).toBe(false);
    expect(second.promptsRekeyed).toBe(0);
    expect(await fakeDb.collection('projects').find({}).toArray()).toHaveLength(1);
  });

  it('falls back to "Screenplay" when there is no plot title', async () => {
    fakeDb.reset(); // empty DB — fresh install path
    const summary = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(summary.title).toBe('Screenplay');
    expect(summary.createdProject).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

```
npx vitest run tests/migrateMultiProject.test.js
```

Expected failure: the file fails at the top-level dynamic import with
`Error: Failed to load url ../scripts/migrate-multi-project.js (resolved id: ...) in /home/mulligan/code/screenplay/tests/migrateMultiProject.test.js. Does the file exist?`
(Vitest's "cannot find module" wording). Zero tests run.

- [ ] **Step 3: Extend the fake with `updateMany`**

In `tests/_fakeMongo.js`, inside `makeCollection()`, insert immediately after the
closing brace of `updateOne` (currently `return { matchedCount: 1 }; },` at lines
353–354) and before `async deleteOne(query) {`:

```js
    async updateMany(query, update, options = {}) {
      const matched = docs.filter((d) => matchQuery(d, query));
      const arrayFilters = options.arrayFilters || [];
      for (const target of matched) {
        const positional = findPositionalIndex(target, query);
        if (update.$set) {
          for (const [path, value] of Object.entries(update.$set)) {
            const resolved = resolveUpdatePath(target, path, positional, arrayFilters);
            for (const parts of resolved) setAtPath(target, parts, deepClone(value));
          }
        }
        if (update.$unset) {
          for (const path of Object.keys(update.$unset)) {
            const resolved = resolveUpdatePath(target, path, positional, arrayFilters);
            for (const parts of resolved) deleteAtPath(target, parts);
          }
        }
      }
      return { matchedCount: matched.length, modifiedCount: matched.length };
    },
```

(Only `$set`/`$unset` — the ops the migration needs. Extend further only when a future
code path requires it, per the CLAUDE.md fake-extension policy.)

- [ ] **Step 4: Write the migration script**

Create `scripts/migrate-multi-project.js` with exactly this content:

```js
#!/usr/bin/env node
/**
 * One-shot migration: single-project deployment -> multi-project.
 *
 * Implements the 7 steps from docs/superpowers/specs/2026-06-09-multi-project-design.md
 * § "Migration":
 *   1. Create the default project, titled from the current screenplay title
 *      (stripMarkdown(plot.title), fallback "Screenplay"). Idempotency anchor:
 *      if a project already exists, the oldest one (by created_at) is adopted.
 *      Hardening: if the NEW code restarted before this script ran, its first
 *      request lazily created a project titled "Screenplay" — when the main
 *      plot doc is still un-stamped and that adopted project has no stamped
 *      data, it is RENAMED from the plot title instead of staying generic
 *      (and instead of a duplicate project being created).
 *   2. Stamp project_id on plots/characters/messages/storyboards/dialogs docs
 *      and metadata.project_id on images/attachments GridFS files; ensure the
 *      plots {project_id:1} partial unique index (same as startup creates in
 *      src/mongo/client.js).
 *   3. Re-key the three prompts singletons to composite _ids
 *      (<projectId>:character_template etc.) via insert-new + delete-old
 *      (_id is immutable in Mongo; a rename is impossible). While the legacy
 *      singleton still exists it is AUTHORITATIVE: any composite doc already
 *      present (a freshly-seeded default from a premature restart, or a
 *      half-finished previous run) is overwritten by the legacy content —
 *      the user's customized templates always win over seeded defaults.
 *   4. Rename the three yjs_docs singleton rows (plot/notes/library ->
 *      <name>:<projectId>) preserving the CRDT binary state bytes. Entity rooms
 *      (beat:/character:/storyboards:/dialogs:<hex>) are untouched.
 *   5. Swap the characters unique index: drop {name_lower:1}, create
 *      {project_id:1, name_lower:1}. Guarded behind a dropIndex capability
 *      check so the in-memory test fake skips it.
 *   6. Point channel_state.current_project_id at the default project for the
 *      configured channel (only when unset — never clobbers a later switch).
 *   7. Print a reminder to run scripts/reindex-rag.js (full Chroma reindex
 *      with the new project_id metadata).
 *
 * Properties:
 *   - Idempotent. Every step is guarded ($exists filters / lookup-before-insert),
 *     so re-running is a no-op.
 *   - Run BEFORE the restarted bot serves traffic (see the Multi-project
 *     runbook in CLAUDE.md).
 *
 * Usage (inside the bot container):
 *   docker compose exec bot node scripts/migrate-multi-project.js
 */

import { ObjectId } from 'mongodb';
import { pathToFileURL } from 'node:url';
import { connectMongo, closeMongo } from '../src/mongo/client.js';
import { stripMarkdown } from '../src/util/markdown.js';

const STAMPED_COLLECTIONS = ['plots', 'characters', 'messages', 'storyboards', 'dialogs'];
const GRIDFS_FILE_COLLECTIONS = ['images.files', 'attachments.files'];
const PROMPT_KEYS = ['character_template', 'plot_template', 'director_notes'];
const SINGLETON_ROOMS = ['plot', 'notes', 'library'];

// Project titles are plain text: trimmed, non-empty, max 120 chars, no '/'.
function deriveProjectTitle(plot) {
  const raw = stripMarkdown(String(plot?.title || '')).replace(/\//g, ' ').trim();
  const title = raw.slice(0, 120).trim();
  return title || 'Screenplay';
}

// True when any content doc / GridFS file is already stamped with this
// project id — i.e. the project genuinely owns data and must not be renamed.
async function projectHasStampedData(db, projectId) {
  for (const name of STAMPED_COLLECTIONS) {
    if (await db.collection(name).findOne({ project_id: projectId })) return true;
  }
  for (const name of GRIDFS_FILE_COLLECTIONS) {
    if (await db.collection(name).findOne({ 'metadata.project_id': projectId })) return true;
  }
  return false;
}

export async function migrate(db, { channelId = null } = {}) {
  const summary = {
    createdProject: false,
    renamedProject: false,
    projectId: null,
    title: null,
    stamped: {},
    promptsRekeyed: 0,
    yjsRenamed: 0,
    channelStateSet: false,
  };

  // --- 1. Default project (idempotency anchor: oldest existing project wins).
  //
  // Hardening for the "restart ran before the migration" deploy mistake: the
  // NEW code's getDefaultProject() lazily creates a project titled
  // "Screenplay" on its first request. If the legacy plot is still un-stamped
  // (so the screenplay's real title hasn't been claimed by anyone) and the
  // adopted oldest project is that empty lazy "Screenplay", rename it from the
  // plot title rather than leaving the generic name or creating a duplicate.
  const projects = db.collection('projects');
  const plot = await db.collection('plots').findOne({ _id: 'main' });
  const unstampedLegacyPlot = plot && !plot.project_id ? plot : null;
  const existing = await projects.find({}).sort({ created_at: 1 }).limit(1).toArray();
  let project = existing[0] || null;
  if (!project) {
    const title = deriveProjectTitle(plot);
    project = {
      _id: new ObjectId(),
      title,
      title_lower: title.toLowerCase(),
      created_at: new Date(),
    };
    await projects.insertOne(project);
    summary.createdProject = true;
    console.log(`Created default project "${title}" (${project._id})`);
  } else if (
    unstampedLegacyPlot &&
    project.title === 'Screenplay' &&
    !(await projectHasStampedData(db, project._id.toString()))
  ) {
    const title = deriveProjectTitle(unstampedLegacyPlot);
    const collides =
      title.toLowerCase() !== 'screenplay' &&
      (await projects.findOne({ title_lower: title.toLowerCase() }));
    if (title !== 'Screenplay' && !collides) {
      await projects.updateOne(
        { _id: project._id },
        { $set: { title, title_lower: title.toLowerCase() } },
      );
      project = { ...project, title, title_lower: title.toLowerCase() };
      summary.renamedProject = true;
      console.log(
        `Renamed lazily-created default project "Screenplay" -> "${title}" (${project._id})`,
      );
    } else {
      console.log(`Default project already present: "${project.title}" (${project._id})`);
    }
  } else {
    console.log(`Default project already present: "${project.title}" (${project._id})`);
  }
  const projectId = project._id.toString();
  summary.projectId = projectId;
  summary.title = project.title;

  // --- 2. Stamp project_id on content docs + GridFS file metadata.
  for (const name of STAMPED_COLLECTIONS) {
    const res = await db
      .collection(name)
      .updateMany({ project_id: { $exists: false } }, { $set: { project_id: projectId } });
    summary.stamped[name] = res.modifiedCount ?? 0;
    console.log(`Stamped ${name}: ${summary.stamped[name]} docs`);
  }
  for (const name of GRIDFS_FILE_COLLECTIONS) {
    const res = await db
      .collection(name)
      .updateMany(
        { 'metadata.project_id': { $exists: false } },
        { $set: { 'metadata.project_id': projectId } },
      );
    summary.stamped[name] = res.modifiedCount ?? 0;
    console.log(`Stamped ${name}: ${summary.stamped[name]} files`);
  }

  // Plots are one-doc-per-project post-migration. Ensure the same partial
  // unique index startup creates (src/mongo/client.js), so a restored
  // pre-migration dump converges without waiting for the next restart. The
  // partialFilterExpression skips any doc still missing the string stamp.
  await db
    .collection('plots')
    .createIndex(
      { project_id: 1 },
      { unique: true, partialFilterExpression: { project_id: { $type: 'string' } } },
    );
  console.log('plots index: {project_id:1} unique (partial) ensured');

  // --- 3. Re-key prompts singletons to composite ids (insert-new + delete-old).
  // The legacy singleton is AUTHORITATIVE while it exists: if a composite doc
  // is already present, it is either a freshly-seeded default (the new code
  // restarted and seedProjectDefaults ran before this script) or the leftover
  // of a run that died between insert and delete-legacy. In both cases the
  // legacy content — which carries the user's customizations — wins, so we
  // OVERWRITE (delete composite, re-insert from legacy) and only then delete
  // the legacy doc. Re-running from any crash point converges: as long as the
  // legacy doc exists the composite is rebuilt from it; once the legacy doc is
  // gone the composite is the live document and is never touched again.
  const prompts = db.collection('prompts');
  for (const key of PROMPT_KEYS) {
    const legacy = await prompts.findOne({ _id: key });
    if (!legacy) continue;
    const newId = `${projectId}:${key}`;
    await prompts.deleteOne({ _id: newId });
    await prompts.insertOne({ ...legacy, _id: newId, project_id: projectId });
    await prompts.deleteOne({ _id: key });
    summary.promptsRekeyed++;
    console.log(`Re-keyed prompts/${key} -> ${newId} (legacy content wins over any seeded default)`);
  }

  // --- 4. Rename the three yjs singleton rows preserving CRDT state bytes.
  const yjs = db.collection('yjs_docs');
  for (const room of SINGLETON_ROOMS) {
    const legacy = await yjs.findOne({ _id: room });
    if (!legacy) continue;
    const newId = `${room}:${projectId}`;
    const already = await yjs.findOne({ _id: newId });
    if (!already) {
      await yjs.insertOne({ ...legacy, _id: newId });
    }
    await yjs.deleteOne({ _id: room });
    summary.yjsRenamed++;
    console.log(`Renamed yjs_docs/${room} -> ${newId}`);
  }

  // --- 5. Swap the characters unique index. dropIndex is guarded behind a
  // capability check so the in-memory test fake (no dropIndex) skips it; on
  // real Mongo a missing legacy index is a warning, not a failure.
  const characters = db.collection('characters');
  if (typeof characters.dropIndex === 'function') {
    await characters.dropIndex('name_lower_1').catch((e) => {
      console.warn(`dropIndex name_lower_1 skipped: ${e.message}`);
    });
  }
  await characters.createIndex({ project_id: 1, name_lower: 1 }, { unique: true });
  console.log('characters index: {project_id:1, name_lower:1} unique ensured');

  // --- 6. Point the agent channel at the default project (only when unset).
  if (channelId) {
    const channelState = db.collection('channel_state');
    const doc = await channelState.findOne({ _id: channelId });
    if (!doc?.current_project_id) {
      await channelState.updateOne(
        { _id: channelId },
        { $set: { current_project_id: projectId, updated_at: new Date() } },
        { upsert: true },
      );
      summary.channelStateSet = true;
      console.log(`channel_state/${channelId}.current_project_id -> ${projectId}`);
    } else {
      console.log(
        `channel_state/${channelId} already points at ${doc.current_project_id}; left untouched`,
      );
    }
  }

  // --- 7. Operator reminder.
  console.log(
    'Reminder: run `node scripts/reindex-rag.js` next — full Chroma reindex with project_id metadata.',
  );

  return summary;
}

async function main() {
  const { config } = await import('../src/config.js');
  const db = await connectMongo();
  const summary = await migrate(db, { channelId: config.discord.movieChannelId });
  console.log(JSON.stringify(summary, null, 2));
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((e) => {
      console.error('Migration failed:', e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeMongo();
    });
}
```

- [ ] **Step 5: Run the test — expect PASS**

```
npx vitest run tests/migrateMultiProject.test.js
```

Expected: `Test Files  1 passed (1)` / `Tests  8 passed (8)`.

- [ ] **Step 6: Verify the startup index swap landed (Phase B item — guard, don't duplicate)**

The migration's index swap is durable only if startup stops re-creating the global
unique index. Run:

```
grep -n "name_lower" src/mongo/client.js
```

Expected (Phase B already swapped it):
`await db.collection('characters').createIndex({ project_id: 1, name_lower: 1 }, { unique: true });`

If instead it still shows the pre-multi-project line 95:

```js
  await db.collection('characters').createIndex({ name_lower: 1 }, { unique: true });
```

then the Phase B sweep missed it — apply this edit now (and note it in the PR
description as a Phase B catch-up):

```js
  await db
    .collection('characters')
    .createIndex({ project_id: 1, name_lower: 1 }, { unique: true });
```

- [ ] **Step 7: Full suite green**

```
npm test
```

Expected: all test files pass (the fake extension is additive; nothing else touches
`updateMany`).

- [ ] **Step 8: Commit**

```
git add scripts/migrate-multi-project.js tests/migrateMultiProject.test.js tests/_fakeMongo.js src/mongo/client.js
git commit -m "🔧 Add idempotent multi-project migration script"
```

(Drop `src/mongo/client.js` from the `git add` if Step 6 required no change.)

**End-of-task verification:** `npx vitest run tests/migrateMultiProject.test.js` → 8 passed; `npm test` → green.

---

### Task 20: Thread remaining modules, strict resolveProjectId flip + cross-project isolation suite

Two halves. **Pre-flip threading (Steps 4–13)**: the intermediate `src/web/*` and
`src/pdf/*` modules that Phases A–E deliberately left on the transitional fallback
(their call sites carry the literal `undefined` first args the Phase A/B sweeps
planted, or zero-arg reads) get their real `projectId`/`projectTitle` threaded
through, the 9 legacy URL-builder call sites are migrated, and the `links.js`
`shiftLegacyArgs` shim is deleted. **The flip (Steps 14–18)**: `resolveProjectId`
becomes strict — a falsy id throws — proving every threading site landed.

Commit policy (stated explicitly): **one commit for the whole pre-flip threading
chunk** (Step 13) — the per-module edits are interdependent (entry-point signatures
and their `entityRoutes.js` call sites must move together) and the tree only needs to
be green at the chunk boundary; plus the isolation-suite commit (Step 3) and the flip
commit (Step 18).

**Files:**
- Modify (pre-flip threading): `src/pdf/export.js`, `src/web/downloads.js`,
  `src/web/announceHelpers.js`, `src/web/artworkJobs.js`, `src/web/dialogContext.js`,
  `src/web/dialogGenerate.js`, `src/web/dialogRegenerate.js`, `src/web/dialogCritique.js`,
  `src/web/sceneBibleAutofill.js`, `src/web/storyboardGenerate.js`,
  `src/web/storyboardGrabFrame.js`, `src/web/storyboardReferenceAggregator.js`,
  `src/web/falVideoGenerate.js`, `src/mongo/files.js`, `src/mongo/attachments.js`,
  `src/web/entityRoutes.js` (the call sites Task 14 explicitly deferred here),
  `src/web/links.js` (delete the `shiftLegacyArgs` shim), `tests/web-links.test.js`,
  `tests/handlers-project-threading.test.js` (delete the shim test)
- Modify (flip): `src/mongo/projects.js` (the `resolveProjectId` export — Phase A created it)
- Modify: `tests/projects.test.js` (replace the transitional-fallback test)
- Create: `tests/multiProjectIsolation.test.js`
- Possibly modify: any straggler caller surfaced by the full-suite run and the no-arg grep (Step 17)

- [ ] **Step 1: Write the isolation suite (passes under the transitional fallback too — every call passes an explicit id)**

Create `tests/multiProjectIsolation.test.js` with exactly this content. Signatures
follow the Phase A–C conventions: positional helpers take `projectId` first
(`getCharacter(projectId, idOrName)`, `listCharacters(projectId)`, `getPlot(projectId)`,
`listBeats(projectId)`, `getCharacterTemplate(projectId)`,
`setCharacterTemplate(projectId, doc)`, `listLibraryImages(projectId)`); helpers that
take a single options object gain a `projectId` key (`createCharacter({ projectId, ... })`,
`createBeat({ projectId, ... })`). `createProject(title)` returns the inserted project
doc with an ObjectId `_id` (Phase A contract).

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const { createCharacter, getCharacter, listCharacters } = await import(
  '../src/mongo/characters.js'
);
const { getPlot, createBeat, listBeats } = await import('../src/mongo/plots.js');
const { getCharacterTemplate, setCharacterTemplate } = await import('../src/mongo/prompts.js');
const { listLibraryImages } = await import('../src/mongo/images.js');

describe('multi-project isolation', () => {
  let pidA;
  let pidB;

  beforeEach(async () => {
    fakeDb.reset();
    pidA = (await createProject('Project A'))._id.toString();
    pidB = (await createProject('Project B'))._id.toString();
  });

  it('resolves the same character name independently per project', async () => {
    await createCharacter({ projectId: pidA, name: 'Steve' });
    await createCharacter({ projectId: pidB, name: 'Steve' });
    const a = await getCharacter(pidA, 'Steve');
    const b = await getCharacter(pidB, 'Steve');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a._id.toString()).not.toBe(b._id.toString());
    expect(a.project_id).toBe(pidA);
    expect(b.project_id).toBe(pidB);
  });

  it('does not leak characters across project listings', async () => {
    await createCharacter({ projectId: pidA, name: 'OnlyInA' });
    const a = await listCharacters(pidA);
    const b = await listCharacters(pidB);
    expect(a.map((c) => c.name)).toContain('OnlyInA');
    expect(b).toHaveLength(0);
  });

  it("returns not-found for project A's character id looked up under project B", async () => {
    const created = await createCharacter({ projectId: pidA, name: 'Steve' });
    const cross = await getCharacter(pidB, created._id.toString());
    expect(cross).toBeNull();
    // sanity: the id resolves fine under its own project
    const home = await getCharacter(pidA, created._id.toString());
    expect(home).not.toBeNull();
  });

  it('keeps plots and beats scoped per project', async () => {
    await createBeat({ projectId: pidA, name: 'A1', desc: 'first beat in A' });
    const plotA = await getPlot(pidA);
    const plotB = await getPlot(pidB);
    expect(plotA.beats).toHaveLength(1);
    expect(plotB.beats).toHaveLength(0);
    expect(String(plotA._id)).not.toBe(String(plotB._id));
    expect(await listBeats(pidB)).toHaveLength(0);
  });

  it('keeps library listings scoped per project', async () => {
    await fakeDb.collection('images.files').insertOne({
      _id: new ObjectId(),
      filename: 'a.png',
      uploadDate: new Date(),
      metadata: { owner_type: null, owner_id: null, kind: null, project_id: pidA },
    });
    const a = await listLibraryImages(pidA);
    const b = await listLibraryImages(pidB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('keeps character templates independent per project', async () => {
    await setCharacterTemplate(pidA, {
      fields: [{ name: 'secret_skill', description: 'x', required: false, core: false }],
    });
    const a = await getCharacterTemplate(pidA);
    const b = await getCharacterTemplate(pidB);
    expect(a.fields.map((f) => f.name)).toContain('secret_skill');
    expect((b?.fields || []).map((f) => f.name)).not.toContain('secret_skill');
  });
});
```

- [ ] **Step 2: Run it — expect PASS**

```
npx vitest run tests/multiProjectIsolation.test.js
```

Expected: `Tests  6 passed (6)`. **If any test fails here, it is a scoping bug in a
Phase A–C helper (not in this suite) — use systematic debugging on the failing helper
and fix it there before proceeding to the flip.** (If `createProject` seeds templates
via `seedProjectDefaults`, the last test still passes — it asserts B *lacks*
`secret_skill`, not that B's template is null.)

- [ ] **Step 3: Commit the suite**

```
git add tests/multiProjectIsolation.test.js
git commit -m "✅ Add cross-project isolation test suite"
```

- [ ] **Step 4: Pre-flip threading — `src/pdf/export.js`**

`exportToPdf` already receives a `projectId` option key from its only caller
(`export_pdf` in `src/agent/handlers.js`, Task 12: `exportToPdf({ projectId:
context?.projectId, title, characters, beats_query, dossier_character })`). Destructure
it and thread it down. Edits (grouped 4a–4e):

4a. `loadLibrary` (line ~550) — before:

```js
async function loadLibrary() {
  const orphanFiles = await listLibraryImages();
```
and (line ~561)
```js
  const attachments = await listLibraryAttachments();
```

after:

```js
async function loadLibrary(projectId) {
  const orphanFiles = await listLibraryImages(projectId);
```
```js
  const attachments = await listLibraryAttachments(projectId);
```

4b. `buildExportData` signature (line ~565) — before/after:

```js
async function buildExportData({ characters: charNames, beats_query, dossier_character }) {
```
```js
async function buildExportData({ projectId, characters: charNames, beats_query, dossier_character }) {
```

4c. The Phase A sweep's `undefined` placeholders inside `buildExportData` (planning-time
lines 567, 588, 607) — uniform transformation, replace `undefined` with `projectId`:

```js
    const resolved = await Promise.all(charNames.map((n) => getCharacter(undefined, n)));
    const matches = await searchBeats(undefined, beats_query);
    const character = await getCharacter(undefined, dossier_character);
```
become
```js
    const resolved = await Promise.all(charNames.map((n) => getCharacter(projectId, n)));
    const matches = await searchBeats(projectId, beats_query);
    const character = await getCharacter(projectId, dossier_character);
```

4d. The zero-arg reads (planning-time lines 609, 630–632, 637) — before:

```js
    const plot = await getPlot();
```
(dossier branch) and
```js
  const characters = await findAllCharacters();
  const plot = await getPlot();
  const directorNotes = await getDirectorNotes();
```
and `loadLibrary(),` in the `Promise.all` — after:

```js
    const plot = await getPlot(projectId);
```
```js
  const characters = await findAllCharacters(projectId);
  const plot = await getPlot(projectId);
  const directorNotes = await getDirectorNotes(projectId);
```
and `loadLibrary(projectId),`.

4e. `exportToPdf` (line ~655) — before:

```js
export async function exportToPdf({ title, characters, beats_query, dossier_character } = {}) {
  const result = await buildExportData({ characters, beats_query, dossier_character });
```
and the title fallback (line ~661)
```js
    const persistedTitle = (result.plot?.title || (await getPlot()).title || '').trim();
```

after:

```js
export async function exportToPdf({ projectId, title, characters, beats_query, dossier_character } = {}) {
  const result = await buildExportData({ projectId, characters, beats_query, dossier_character });
```
```js
    const persistedTitle = (result.plot?.title || (await getPlot(projectId)).title || '').trim();
```

Verification (expect **no output** for both):

```
grep -nE "(getPlot|findAllCharacters|getDirectorNotes|listLibraryImages|listLibraryAttachments)\(\)" src/pdf/export.js
grep -n "(undefined, " src/pdf/export.js
```

- [ ] **Step 5: Pre-flip threading — `src/web/downloads.js`**

The four entry points (`streamBeatZip`, `streamCharacterZip`, `streamLibraryZip`,
`streamNotesZip`) are mounted by `entityRoutes.js` as `(req, res)` handlers — Task 14
deliberately left them alone because they already receive `req`. Rename the unused
`_req` params to `req` (`streamLibraryZip`, `streamNotesZip`), then apply the uniform
transformation across the file: every literal `undefined` first arg left by the
Phase A/B sweeps becomes `req.projectId`, and the zero-arg project-scoped reads
(`listLibraryImages()`, `listLibraryAttachments()`, `getDirectorNotes()`) gain
`req.projectId`. Enumerate:

```
grep -nE "\(undefined, |listLibraryImages\(\)|listLibraryAttachments\(\)|getDirectorNotes\(\)|_req" src/web/downloads.js
```

Real example 1 — `streamBeatZip` (planning-time lines 138–147), before:

```js
export async function streamBeatZip(req, res) {
  const idOrOrder = req.params.id;
  const beat = await getBeat(undefined, idOrOrder);
  if (!beat) return res.status(404).json({ error: 'beat not found' });

  const beatIdHex = beat._id.toString();
  const [images, attachments] = await Promise.all([
    listImagesForBeat(undefined, beatIdHex),
    listAttachmentsForBeat(undefined, beatIdHex),
  ]);
```

after:

```js
export async function streamBeatZip(req, res) {
  const idOrOrder = req.params.id;
  const beat = await getBeat(req.projectId, idOrOrder);
  if (!beat) return res.status(404).json({ error: 'beat not found' });

  const beatIdHex = beat._id.toString();
  const [images, attachments] = await Promise.all([
    listImagesForBeat(req.projectId, beatIdHex),
    listAttachmentsForBeat(req.projectId, beatIdHex),
  ]);
```

(If the Phase B agent kept a per-owner lister id-addressed — no re-sign, so no
`undefined` placeholder at its call site — there is nothing to replace there; the grep
enumeration is authoritative.)

Real example 2 — `streamLibraryZip` (planning-time lines 191–195), before:

```js
export async function streamLibraryZip(_req, res) {
  const [images, attachments] = await Promise.all([
    listLibraryImages(),
    listLibraryAttachments(),
  ]);
```

after:

```js
export async function streamLibraryZip(req, res) {
  const [images, attachments] = await Promise.all([
    listLibraryImages(req.projectId),
    listLibraryAttachments(req.projectId),
  ]);
```

Same pattern for the remaining sites: `getCharacter(undefined, idOrName)` →
`getCharacter(req.projectId, idOrName)` (line ~161) plus the
`listAttachmentsForCharacter` placeholder below it, and in `streamNotesZip`
(`_req` → `req`) `getDirectorNotes()` → `getDirectorNotes(req.projectId)` plus the
per-note lister placeholders (planning-time lines 219–220).

Verification (expect **no output**):

```
grep -nE "\(undefined, |listLibraryImages\(\)|listLibraryAttachments\(\)|getDirectorNotes\(\)|_req" src/web/downloads.js
```

- [ ] **Step 6: Pre-flip threading — `src/web/announceHelpers.js` URL builders**

Every helper here already receives `req` inside its options object; the Task 14
middleware sets `req.projectTitle`. Five one-line edits (these are 4 of the 9 legacy
URL-builder call sites from the plan-wide list, plus `libraryUrl()` at line 145 which
goes along so the announcement links land in the right project):

Line 61: `entityUrl: beatUrl(beat),` → `entityUrl: beatUrl(req?.projectTitle ?? null, beat),`
Line 82: `entityUrl: characterUrl(character),` → `entityUrl: characterUrl(req?.projectTitle ?? null, character),`
Line 103: `entityUrl: notesUrl(),` → `entityUrl: notesUrl(req?.projectTitle ?? null),`
Line 125: `entityUrl: storyboardUrl(beat),` → `entityUrl: storyboardUrl(req?.projectTitle ?? null, beat),`
Line 145: `entityUrl: libraryUrl(),` → `entityUrl: libraryUrl(req?.projectTitle ?? null),`

(`announceMediaEventDirect` takes a pre-built payload — its callers build their own
URLs and are migrated in Steps 7–10.)

Verification (expect **no output**):

```
grep -nE "(beatUrl|characterUrl|notesUrl|storyboardUrl|libraryUrl)\((beat|character)?\)" src/web/announceHelpers.js
```

- [ ] **Step 7: Pre-flip threading — `src/web/artworkJobs.js`**

Task 14 Step 13 already passes `projectId: req.projectId` into all five exported entry
points. Thread it through the module:

7a. Add the import (after the `getCharacter` import, line 36):

```js
import { getProjectById } from '../mongo/projects.js';
```

7b. Replace `announceArtwork` (lines 39–71) with (the project title for the SPA link is
looked up from the id because this runs in a background job with no `req`):

```js
async function announceArtwork({ projectId, hostType, hostId, username, verb, fileId, prompt }) {
  try {
    if (!username) return;
    const project = projectId ? await getProjectById(projectId) : null;
    const projectTitle = project?.title ?? null;
    let entityLabel = null;
    let entityUrl = null;
    if (hostType === 'beat') {
      const beat = await getBeat(projectId, String(hostId));
      if (beat) {
        const name = stripMarkdown(beat.name || '').trim();
        const order = Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
        entityLabel = name ? `${order}: ${name}` : order;
        entityUrl = beatUrl(projectTitle, beat);
      }
    } else if (hostType === 'character') {
      const character = await getCharacter(projectId, String(hostId));
      if (character) {
        const name = stripMarkdown(character.name || '').trim() || 'character';
        entityLabel = `Character: ${name}`;
        entityUrl = characterUrl(projectTitle, character);
      }
    }
    announceMediaEvent({
      username,
      verb,
      entityLabel,
      entityUrl,
      imageFileId: fileId,
      prompt,
    }).catch(() => {});
  } catch (e) {
    logger.warn(`announceArtwork failed: ${e?.message || e}`);
  }
}
```

(This step also covers the Phase A `undefined` placeholders the sweep left at the old
lines 45/53 — they are inside this replaced function.)

7c. Entry-point destructures + pass-through. `startGenerateArtworkJob`,
`startRegenerateArtworkJob`, `startEditArtworkJob` each add `projectId = null,` to
their options destructure and `projectId,` to (i) the `runGenerate(...)`/`runEdit(...)`
opts object inside `setImmediate` and (ii) every `*ViaGateway({ ... })` options object
in their bodies. `undoArtworkEdit` and `deleteArtwork` become:

```js
export async function undoArtworkEdit({ projectId, hostType, hostId, artworkId }) {
  const { artwork } = await undoArtworkEditViaGateway({ projectId, hostType, hostId, artworkId });
  return artwork;
}
```
```js
export async function deleteArtwork({ projectId, hostType, hostId, artworkId }) {
  return removeArtworkViaGateway({ projectId, hostType, hostId, artworkId });
}
```

7d. Runners. `runGenerate` and `runEdit` add `projectId,` to their `opts` destructure,
pass `projectId,` into every `*ViaGateway({ ... })` call and into `announceArtwork({ ... })`,
and replace the Phase B placeholders at lines 189/357 — before/after (line 189; 357 is
identical but with the `-artwork-edit-` filename):

```js
    const file = await uploadGeneratedImage(undefined, {
```
```js
    const file = await uploadGeneratedImage(projectId, {
```

Verification (expect **no output**, then output `0`):

```
grep -nE "uploadGeneratedImage\(undefined|\(undefined, " src/web/artworkJobs.js
grep -Pzo '(?:[a-zA-Z]+ViaGateway|announceArtwork)\(\{\s*(?!projectId)' src/web/artworkJobs.js | wc -c
```

- [ ] **Step 8: Pre-flip threading — dialog modules + `sceneBibleAutofill.js` (+ their route call sites)**

These entry points were NOT in Task 14 Step 13's options list, so their
`entityRoutes.js` call sites gain the `projectId` key here, atomically with the
signature changes.

8a. `src/web/dialogContext.js` — re-sign both exports with `projectId` first:

```js
export async function loadCharacterDocs(projectId, characterNames) {
```
with line 44 `const all = await listCharacters().catch(() => []);` →
`const all = await listCharacters(projectId).catch(() => []);`, and

```js
export async function buildDialogContext(projectId, beat) {
```
with line 76 `const plot = await getPlot().catch(() => null);` →
`const plot = await getPlot(projectId).catch(() => null);` and line 122
`const characters = await loadCharacterDocs(beat?.characters || []);` →
`const characters = await loadCharacterDocs(projectId, beat?.characters || []);`.
(`listDialogs({ beatId: prev._id })` at line 102 stays — beat-scoped, ObjectId-unique.)

8b. `src/web/dialogGenerate.js` —

```js
export async function startDialogGenerationJob({ projectId, beatId }) {
  const beat = await getBeat(projectId, beatId);
```
(replacing the sweep's `getBeat(undefined, beatId)` at line 144). Thread `projectId`
into the runner: `withBeatLock(beat._id, () => runDialogGenerationJob({ job, beat, projectId }))`,
`async function runDialogGenerationJob({ job, beat, projectId })`, the two gateway calls
gain the key (`deleteAllDialogsForBeatViaGateway({ projectId, beatId: beat._id })`,
`createDialogViaGateway({ projectId, beatId: beat._id, ... })`), and the extractor:
`extractEntries({ beat, projectId })` / `async function extractEntries({ beat, projectId })`
with line 217 `const context = await buildDialogContext(projectId, beat);`.

8c. `src/web/dialogRegenerate.js` —

```js
export async function generateAlternatives({ projectId, dialogId, count = ALTERNATIVE_COUNT } = {}) {
  const dialog = await getDialog(projectId, dialogId);
  if (!dialog) throw new Error(`Dialog not found: ${dialogId}`);
  const beat = await getBeat(projectId, dialog.beat_id.toString());
```
(replacing the sweep placeholders at lines 52/54) and line 72
`const context = await buildDialogContext(projectId, beat);`.

8d. `src/web/dialogCritique.js` —

```js
export async function critiqueDialog({ projectId, beatId } = {}) {
  const beat = await getBeat(projectId, String(beatId));
```
(line 66 placeholder) and line 79 `const context = await buildDialogContext(projectId, beat);`.

8e. `src/web/sceneBibleAutofill.js` —

```js
export async function buildSceneBibleContext(projectId, beat) {
```
with line 75 `getPlot()` → `getPlot(projectId)`, line 93
`loadCharacterDocs(beat?.characters || [])` → `loadCharacterDocs(projectId, beat?.characters || [])`,
line 99 `getDirectorNotes()` → `getDirectorNotes(projectId)`; and

```js
export async function autofillSceneBible({ projectId, beatId } = {}) {
  const beat = await getBeat(projectId, String(beatId));
```
(line 111 placeholder), line 119 `buildSceneBibleContext(projectId, beat)`, and the
gateway write loop gains the key:
`await setEntityFieldMarkdown({ projectId, entityType: 'beat', ... })`.

8f. `src/web/entityRoutes.js` call sites (all have `req` in scope) — add
`projectId: req.projectId,` as the first key:

- line 4848: `startDialogGenerationJob({ beatId: beat._id.toString() })` →
  `startDialogGenerationJob({ projectId: req.projectId, beatId: beat._id.toString() })`
- line 4938: `generateAlternatives({ dialogId: dId })` →
  `generateAlternatives({ projectId: req.projectId, dialogId: dId })`
- line 4954: `critiqueDialog({ beatId: beat._id.toString() })` →
  `critiqueDialog({ projectId: req.projectId, beatId: beat._id.toString() })`
- line 3256: `autofillSceneBible({ beatId: beat._id.toString() })` →
  `autofillSceneBible({ projectId: req.projectId, beatId: beat._id.toString() })`

Verification (expect **no output**, then output `0`):

```
grep -nE "\(undefined, |getPlot\(\)|listCharacters\(\)|getDirectorNotes\(\)" src/web/dialogContext.js src/web/dialogGenerate.js src/web/dialogRegenerate.js src/web/dialogCritique.js src/web/sceneBibleAutofill.js
grep -Pzo '(?:startDialogGenerationJob|generateAlternatives|critiqueDialog|autofillSceneBible)\(\{\s*(?!projectId)' src/web/entityRoutes.js | wc -c
```

- [ ] **Step 9: Pre-flip threading — `src/web/storyboardGenerate.js`, `storyboardGrabFrame.js`, `storyboardReferenceAggregator.js` (+ route call sites)**

9a. `src/web/storyboardReferenceAggregator.js` — Task 14 already passes the key at
`entityRoutes.js:3429`. Re-sign + thread:

```js
export async function collectStoryboardReferenceIds({
  projectId,
  beat,
  charactersInScene,
  existingIds = [],
}) {
```
and line 58 `c = await getCharacter(undefined, stripped);` →
`c = await getCharacter(projectId, stripped);`.

9b. `src/web/storyboardGrabFrame.js` — Task 14 already passes the key at
`entityRoutes.js:2763`. Re-sign + thread:

```js
export async function grabFrameFromPrevious({ projectId, currentSbId, prev }) {
```
with the Phase B placeholder at line 132 — before/after:

```js
    const file = await uploadGeneratedImage(undefined, {
```
```js
    const file = await uploadGeneratedImage(projectId, {
```

and the frame write gains the key:
`addStoryboardFrameViaGateway({ projectId, storyboardId: currentSbId, imageId: file._id })`.

9c. `src/web/storyboardGenerate.js` — MECHANICAL SWEEP plus two announce blocks shown
in full. Signature changes (every options-object entry point gains a `projectId` key,
every internal runner threads it):

| function (planning-time line) | change |
|---|---|
| `loadDirectorNotesForPlanner()` (101) | → `loadDirectorNotesForPlanner(projectId)`; inside, `getDirectorNotes()` (103) → `getDirectorNotes(projectId)` |
| `critiqueShotsForBeat({ beat, ... })` (235) | → `critiqueShotsForBeat({ projectId, beat, ... })`; `setStoryboardCritiqueViaGateway({ ... })` (251) gains `projectId,` |
| `startBulkFrameGenerationJob({ beatId, imageModel })` (324) | → `({ projectId, beatId, imageModel })`; `getBeat(undefined, beatId)` (328) → `getBeat(projectId, beatId)`; `runBulkFrameGenerationJob({ job, beat, targets, imageModel })` gains `projectId` (destructure + pass into `regenerateStoryboardFrameInternal`) |
| `startCritiqueJob({ storyboardId, target })` (449) | → `({ projectId, storyboardId, target })`; `getStoryboard(undefined, storyboardId)` (450) and `getBeat(undefined, ...)` (452) → `projectId`; `loadDirectorNotesForPlanner()` (470) → `(projectId)`; `setStoryboardCritiqueViaGateway` (490) gains `projectId,` |
| `startStoryboardGenerationJob({ beatId, ... })` (511) | → `({ projectId, beatId, ... })`; `getBeat(undefined, beatId)` (518) → `projectId`; `runStoryboardGenerationJob({ ... })` gains `projectId` |
| `runStoryboardGenerationJob` (576) | destructure `projectId`; `findCharactersInBeat(undefined, beat)` (592) → `(projectId, beat)`; `loadDirectorNotesForPlanner()` (595) → `(projectId)`; `setBeatSceneBible(undefined, beat._id, sceneBible)` (609) → `(projectId, ...)`; `deleteAllStoryboardsForBeatViaGateway({ beatId: beat._id })` (630) gains `projectId,`; `createPlannedStoryboardEntry({ beat, frame, order })` (655) gains `projectId,`; `critiqueShotsForBeat({ beat, ... })` (689) gains `projectId,`; announce block (708–723) shown below |
| `createPlannedStoryboardEntry({ beat, frame, order })` (1397) | → `({ projectId, beat, frame, order })`; `createStoryboardViaGateway` (1410), `collectStoryboardReferenceIds` (1432), `addStoryboardFrameViaGateway` (1448) all gain `projectId,` |
| `reExpandShotInner({ sb, beat, critiqueGuidance })` (1137) | → `({ projectId, sb, beat, critiqueGuidance = '' })`; `findCharactersInBeat(undefined, beat)` (1138) → `(projectId, beat)`; `loadDirectorNotesForPlanner()` (1139) → `(projectId)`; `setStoryboardTextPromptViaGateway` (1170), `setStoryboardFramePromptViaGateway` (1179), `addStoryboardFrameViaGateway` (1185) gain `projectId,` |
| `reExpandShot({ storyboardId, critiqueGuidance })` (1198) | → `({ projectId, storyboardId, critiqueGuidance = '' })`; placeholders at 1199/1201 → `projectId`; forwards `projectId` to `reExpandShotInner` |
| `startReExpandAllJob({ beatId })` (1222) | → `({ projectId, beatId })`; placeholder at 1223 → `projectId`; `reExpandShotInner({ sb, beat })` (1238) gains `projectId,` |
| `persistFrameImage({ ... })` (1494) | gains `projectId` key; `uploadGeneratedImage(undefined, {` (1503) → `uploadGeneratedImage(projectId, {`; both `setStoryboardFrame*ViaGateway` calls gain `projectId,` |
| `regenerateStoryboardFrame({ ... })` (1582) | gains `projectId` key; placeholders at 1595/1599 → `projectId`; forwards into `regenerateStoryboardFrameInternal` |
| `previewFrameGenerationPrompt({ storyboardId, frameId })` (1620) | → `({ projectId, storyboardId, frameId })`; placeholders at 1621/1625 → `projectId` |
| `regenerateStoryboardFrameInternal({ ... })` (1641) | gains `projectId` key; `setStoryboardFramePromptViaGateway` (1693) gains `projectId,`; `persistFrameImage({ ... })` (1712) gains `projectId,` |
| `startFrameGenerationJob({ ... })` (1739) | gains `projectId` key; placeholders at 1753/1757 → `projectId`; `runFrameGenerationJob({ ... })` gains `projectId` |
| `runFrameGenerationJob` (1806) | destructure `projectId`; forwards into `regenerateStoryboardFrameInternal`; announce block (1834–1855) shown below |

(`listMissingStartFrameTargets(beatId)` stays id-addressed — `listStoryboards({ beatId })`
is beat-scoped and ObjectIds are globally unique.)

The batch announce in `runStoryboardGenerationJob` (planning-time 708–723) — the URL
caller at line 712 — before:

```js
  if (announceUsername && job.completed > 0) {
    try {
      const { announceText } = await import('../discord/announcer.js');
      const { storyboardUrl } = await import('./links.js');
      const url = storyboardUrl(beat);
```

after:

```js
  if (announceUsername && job.completed > 0) {
    try {
      const { announceText } = await import('../discord/announcer.js');
      const { storyboardUrl } = await import('./links.js');
      const { getProjectById } = await import('../mongo/projects.js');
      const project = projectId ? await getProjectById(projectId) : null;
      const url = storyboardUrl(project?.title ?? null, beat);
```

(the rest of the block is unchanged). The per-frame announce in
`runFrameGenerationJob` (planning-time 1834–1851) — the URL caller at line 1848 —
before:

```js
      const { announceMediaEvent } = await import('../discord/announcer.js');
      const { storyboardUrl } = await import('./links.js');
      const { stripMarkdown } = await import('../util/markdown.js');
      const name = stripMarkdown(beat.name || '').trim();
```
…
```js
        entityUrl: storyboardUrl(beat),
```

after:

```js
      const { announceMediaEvent } = await import('../discord/announcer.js');
      const { storyboardUrl } = await import('./links.js');
      const { stripMarkdown } = await import('../util/markdown.js');
      const { getProjectById } = await import('../mongo/projects.js');
      const project = projectId ? await getProjectById(projectId) : null;
      const name = stripMarkdown(beat.name || '').trim();
```
…
```js
        entityUrl: storyboardUrl(project?.title ?? null, beat),
```

9d. `src/web/entityRoutes.js` call sites deferred from Task 14 (all in route handlers
with `req` in scope):

- `findCharactersInBeat(undefined, beat)` at lines 485, 529, 2254, 4430, 4464 →
  `findCharactersInBeat(req.projectId, beat)` (line 2254 uses the loop variable `b`).
- `loadDirectorNotesForPlanner()` at line 4465 → `loadDirectorNotesForPlanner(req.projectId)`.
- Options-object entry points gain `projectId: req.projectId,` as the first key:
  `startFrameGenerationJob` (2850, 2912), `previewFrameGenerationPrompt` (2989),
  `startCritiqueJob` (3200), `reExpandShot` (3221), `startReExpandAllJob` (3240),
  `startStoryboardGenerationJob` (4399), `startBulkFrameGenerationJob` (4539).
  Real example (line 3200):
  `await startCritiqueJob({ storyboardId: sbId, target })` →
  `await startCritiqueJob({ projectId: req.projectId, storyboardId: sbId, target })`.

Verification (expect **no output**, then `0` twice):

```
grep -nE "\(undefined, |getDirectorNotes\(\)|loadDirectorNotesForPlanner\(\)" src/web/storyboardGenerate.js src/web/storyboardGrabFrame.js src/web/storyboardReferenceAggregator.js src/web/entityRoutes.js
grep -Pzo '(?:startFrameGenerationJob|previewFrameGenerationPrompt|startCritiqueJob|reExpandShot|startReExpandAllJob|startStoryboardGenerationJob|startBulkFrameGenerationJob)\(\{\s*(?!projectId)' src/web/entityRoutes.js | wc -c
grep -Pzo '(?:[a-zA-Z]+ViaGateway|collectStoryboardReferenceIds|persistFrameImage|createPlannedStoryboardEntry|critiqueShotsForBeat)\(\{\s*(?!projectId)' src/web/storyboardGenerate.js | wc -c
```

- [ ] **Step 10: Pre-flip threading — `src/web/falVideoGenerate.js`**

Task 14 Step 13 already passes `projectId: req.projectId` into both exported entry
points (`buildVideoPayloadPreview` at entityRoutes 4184, `startVideoGenerationJob` at
4250). Thread it through:

10a. `startVideoGenerationJob({ ... } = {})` (line 165) — add `projectId = null,` to the
destructure; `mongoGetStoryboard(undefined, storyboardId)` (185) →
`mongoGetStoryboard(projectId, storyboardId)`; the `runVideoGenerationJob({ ... })`
opts object (217) gains `projectId,`.

10b. `buildVideoPayloadPreview({ ... } = {})` (line 421) — add `projectId = null,`;
`mongoGetStoryboard(undefined, storyboardId)` (440) → `(projectId, storyboardId)`;
`loadDirectorNotesForPrompt()` (513) → `loadDirectorNotesForPrompt(projectId)`.

10c. `runVideoGenerationJob({ ... })` (606) — add `projectId = null,` to the destructure;
`loadDirectorNotesForPrompt()` (660) → `(projectId)`; the Phase B placeholder (740):

```js
    const file = await uploadAttachmentBuffer(undefined, {
```
becomes
```js
    const file = await uploadAttachmentBuffer(projectId, {
```

`setStoryboardVideoViaGateway({ ... })` (748) gains `projectId,` as the first key; and
the announce block (768–793) — the URL caller at line 785 — before:

```js
        const { announceMediaEvent } = await import('../discord/announcer.js');
        const { storyboardUrl } = await import('./links.js');
        const { stripMarkdown } = await import('../util/markdown.js');
        const { getBeat } = await import('../mongo/plots.js');
        const beat = await getBeat(undefined, String(storyboard.beat_id));
```
…
```js
          entityUrl: beat ? storyboardUrl(beat) : null,
```

after:

```js
        const { announceMediaEvent } = await import('../discord/announcer.js');
        const { storyboardUrl } = await import('./links.js');
        const { stripMarkdown } = await import('../util/markdown.js');
        const { getBeat } = await import('../mongo/plots.js');
        const { getProjectById } = await import('../mongo/projects.js');
        const beat = await getBeat(projectId, String(storyboard.beat_id));
        const project = projectId ? await getProjectById(projectId) : null;
```
…
```js
          entityUrl: beat ? storyboardUrl(project?.title ?? null, beat) : null,
```

10d. `loadDirectorNotesForPrompt()` (865) → `loadDirectorNotesForPrompt(projectId)`;
inside, `getDirectorNotes()` (867) → `getDirectorNotes(projectId)`.

Verification (expect **no output**):

```
grep -nE "\(undefined, |getDirectorNotes\(\)|loadDirectorNotesForPrompt\(\)" src/web/falVideoGenerate.js
```

- [ ] **Step 11: Pre-flip threading — detach branches in `src/mongo/files.js` + `src/mongo/attachments.js`**

Plan-wide convention (binding): the detach helpers derive the project from **the
file's own metadata stamp** — `file.metadata?.project_id` — not from a host-doc
lookup. Replace whatever transitional first args the Phase A sweep left on the
`pull*` calls (literal `undefined`, or a `findPlotByBeatId(...)`-derived value if that
variant landed). Replace `detachImageFromCurrentOwner` in `src/mongo/files.js`
(lines 24–43) with:

```js
export async function detachImageFromCurrentOwner(file) {
  const ownerType = file?.metadata?.owner_type;
  const ownerId = file?.metadata?.owner_id;
  if (!ownerType || !ownerId) return null;
  // The file's own stamp is the source of truth for which project the owner
  // lives in. Legacy files uploaded before the migration have no stamp; the
  // pull* helpers are lenient about unstamped docs, and post-migration every
  // file is stamped.
  const projectId = file?.metadata?.project_id;
  let priorName = null;
  try {
    if (ownerType === 'beat') {
      const res = await pullBeatImage(projectId, ownerId, file._id);
      priorName = res?.beat?.name || null;
    } else if (ownerType === 'character') {
      const res = await pullCharacterImage(projectId, ownerId, file._id);
      priorName = res?.character || null;
    } else if (ownerType === 'director_note') {
      await pullDirectorNoteImage(projectId, ownerId, file._id);
    }
  } catch (e) {
    if (!/not attached|not found/i.test(e?.message || '')) throw e;
  }
  return { prior_owner_type: ownerType, prior_owner_id: ownerId, prior_owner_name: priorName };
}
```

And `detachAttachmentFromCurrentOwner` in `src/mongo/attachments.js` (lines 304–323)
with the mirror image (same body, `pullBeatAttachment` / `pullCharacterAttachment` /
`pullDirectorNoteAttachment` in place of the image pulls). If the Phase A variant
introduced a `findPlotByBeatId` import into either file and nothing else in that file
uses it after this replacement, delete the now-unused import.

Verification (expect **no output**; the second grep guards the import cleanup):

```
grep -nE "pull(Beat|Character|DirectorNote)(Image|Attachment)\((undefined|hostPlot)" src/mongo/files.js src/mongo/attachments.js
grep -n "findPlotByBeatId" src/mongo/files.js src/mongo/attachments.js
```

- [ ] **Step 12: Delete the `links.js` legacy-args shim (+ migrate its tests)**

Every caller of the entity URL builders now passes a `projectTitle` first argument
(Task 12 migrated `handlers.js`/`entityLinks.js`; Steps 6–10 above migrated
`announceHelpers.js`, `artworkJobs.js`, `storyboardGenerate.js`, `falVideoGenerate.js`).
The transitional shim is dead code — delete it:

12a. In `src/web/links.js`, delete the `shiftLegacyArgs` function (the block Task 12
added, beginning `// TRANSITIONAL (delete in Task 20): detect legacy single-argument calls`)
and the three shim lines inside the builders:

```js
  [projectTitle, character] = shiftLegacyArgs(projectTitle, character);
```
(in `characterUrl`) and the matching
```js
  [projectTitle, beat] = shiftLegacyArgs(projectTitle, beat);
```
lines in `beatUrl` and `storyboardUrl`.

12b. In `tests/handlers-project-threading.test.js`, delete the whole shim test:

```js
  it('legacy un-prefixed calls keep working (transitional shim)', () => {
    expect(beatUrl({ order: 2 })).toMatch(/\/beat\/2$/);
    expect(beatUrl({ order: 2 })).not.toContain('/p/');
    expect(characterUrl({ name: 'Steve' })).toMatch(/\/character\/Steve$/);
    expect(notesUrl()).toMatch(/\/notes$/);
    expect(notesUrl()).not.toContain('/p/');
  });
```

12c. In `tests/web-links.test.js`, the pre-multi-project assertions call the builders
in the legacy one-arg form, which only worked through the shim. MECHANICAL SWEEP —
enumerate:

```
grep -nE "(characterUrl|beatUrl|storyboardUrl|notesUrl|homeUrl|libraryUrl|aboutUrl)\(" tests/web-links.test.js
```

Uniform transformation: insert `null` as the first argument (a null title produces no
`/p/` segment, so every expected URL string is unchanged). Two real examples:

```js
    expect(characterUrl({ name: 'Steve' })).toBe('http://localhost:3000/character/Steve');
```
→
```js
    expect(characterUrl(null, { name: 'Steve' })).toBe('http://localhost:3000/character/Steve');
```
and
```js
    expect(beatUrl({ order: 3 })).toBe('http://localhost:3000/beat/3');
```
→
```js
    expect(beatUrl(null, { order: 3 })).toBe('http://localhost:3000/beat/3');
```

Verification (expect **no output** for all three):

```
grep -rn "shiftLegacyArgs" src/ tests/
grep -rnE "\b(beatUrl|characterUrl|storyboardUrl)\((beat|character|b|target)\b" src/
grep -rnE "\b(notesUrl|libraryUrl)\(\)" src/
```

- [ ] **Step 13: Full suite + ONE commit for the threading chunk**

```
npm test
```

Expected: green — the transitional `resolveProjectId` is still in place, so every
newly threaded value that a legacy test leaves undefined still resolves to the default
project, while route/gateway tests that pass explicit ids now exercise the real
threading. If `tests/downloads.test.js` or a dialog/storyboard job test fails with a
"not found", the fixture was created under a different project than the one the
route's `req.projectId` resolves to — fix the test fixture, not the module.

```
git add src/pdf/export.js src/web/downloads.js src/web/announceHelpers.js \
  src/web/artworkJobs.js src/web/dialogContext.js src/web/dialogGenerate.js \
  src/web/dialogRegenerate.js src/web/dialogCritique.js src/web/sceneBibleAutofill.js \
  src/web/storyboardGenerate.js src/web/storyboardGrabFrame.js \
  src/web/storyboardReferenceAggregator.js src/web/falVideoGenerate.js \
  src/mongo/files.js src/mongo/attachments.js src/web/entityRoutes.js \
  src/web/links.js tests/web-links.test.js tests/handlers-project-threading.test.js
git commit -m "♻️ Thread projectId through pdf/downloads/jobs/dialog modules; drop links shim"
```

- [ ] **Step 14: Write the failing strict-flip test**

Locate the transitional-fallback test that Phase A added:

```
grep -n "resolveProjectId" tests/projects.test.js
```

Delete the test asserting the fallback (it asserts something like
`expect(await resolveProjectId(undefined)).toBe(defaultId)` / "falls back to the default
project") and replace it with:

```js
  it('resolveProjectId throws on a falsy projectId (strict mode)', async () => {
    await expect(resolveProjectId(undefined)).rejects.toThrow(/projectId required/);
    await expect(resolveProjectId(null)).rejects.toThrow(/projectId required/);
    await expect(resolveProjectId('')).rejects.toThrow(/projectId required/);
  });

  it('resolveProjectId stringifies truthy ids', async () => {
    const project = await createProject('Stringify Me');
    expect(await resolveProjectId(project._id)).toBe(project._id.toString());
    expect(await resolveProjectId(project._id.toString())).toBe(project._id.toString());
  });
```

- [ ] **Step 15: Run it — expect FAIL**

```
npx vitest run tests/projects.test.js
```

Expected failure on the new strict test:
`AssertionError: promise resolved "<24-hex id>" instead of rejecting`
(the transitional version resolves to the default project's id instead of throwing).

- [ ] **Step 16: Flip `resolveProjectId` to strict**

In `src/mongo/projects.js`, the transitional version (quoted from the Phase A
conventions — Section 1 wrote exactly this shape):

```js
// TRANSITIONAL: falls back to the default project so un-migrated callers keep
// working during the threading sweep. Task 20 flips this to throw.
export async function resolveProjectId(projectId) {
  if (projectId) return String(projectId);
  return (await getDefaultProject())._id.toString();
}
```

Replace with the strict version:

```js
// STRICT: every caller must thread an explicit projectId. A throw here means a
// missed threading site — fix the caller; never re-add a default fallback.
export async function resolveProjectId(projectId) {
  if (!projectId) throw new Error('projectId required');
  return String(projectId);
}
```

(Keep it `async` — every helper awaits it, and the strict version must stay drop-in.)
If Phase A's comment text differs slightly, match on the function body — the
`if (projectId) return String(projectId);` / `getDefaultProject()` pair is the
load-bearing part.

- [ ] **Step 17: Run the project tests, then the FULL suite — fix stragglers by threading, never by defaulting**

```
npx vitest run tests/projects.test.js
npm test
```

Expected: `tests/projects.test.js` passes. For `npm test`: **every failure that
surfaces `Error: projectId required` is a missed threading site from the Phase B–E
sweeps.** The fix is always the same — thread an explicit id from the caller's context
(`context.projectId` in handlers, `req.projectId` in routes, a created test project in
tests). It is NEVER acceptable to re-add a default inside a helper or to pass the
default project's id as a literal.

Uniform test-side transformation (for any legacy test still calling a helper bare):

```js
// BEFORE (legacy single-project test)
const plot = await getPlot();

// AFTER
const project = await createProject('Test Project');
const projectId = project._id.toString();
const plot = await getPlot(projectId);
```

Enumerate remaining no-arg call sites of the project-scoped read helpers across
runtime code AND scripts (tests are covered by the suite run):

```
grep -rnE "getPlot\(\)|listCharacters\(\)|findAllCharacters\(\)|getDirectorNotes\(\)|getCharacterTemplate\(\)|getPlotTemplate\(\)|getCurrentBeat\(\)|listBeats\(\)|listLibraryImages\(\)|listLibraryAttachments\(\)" src scripts
```

Expected output after this step: **zero matches.**

Also sweep for surviving Phase A/B `undefined` placeholders that every threading step
should have consumed — restricted to the re-signed helper names so an unrelated
`undefined` argument elsewhere can't false-positive:

```
grep -rnE "\b(getPlot|getBeat|searchBeats|getCharacter|listCharacters|findAllCharacters|getDirectorNotes|getCharacterTemplate|getPlotTemplate|getStoryboard|updateStoryboard|setFramePrompt|getPreviousStoryboardInBeat|getDialog|updateDialog|listImagesForBeat|listImagesForCharacter|listImagesForDirectorNote|listAttachmentsForBeat|listAttachmentsForCharacter|listAttachmentsForDirectorNote|listImagesByOwnerType|uploadGeneratedImage|uploadImageFromUrl|uploadAttachmentBuffer|uploadAttachmentFromUrl|findCharactersInBeat|setBeatSceneBible|linkCharacterToBeat|unlinkCharacterFromBeat|pushBeatImage|pullBeatImage|pushBeatAttachment|pullBeatAttachment|pushCharacterImage|pullCharacterImage|pullCharacterAttachment|pullDirectorNoteImage|pullDirectorNoteAttachment|updateBeatViaGateway|updateCharacterViaGateway)\(undefined, " src/ scripts/
```

Expected output: **zero matches.** Any hit is a threading site the pre-flip steps (or
an earlier phase's pickup pass) missed — thread the real id from the enclosing
context, never delete the argument.

Contingency for `scripts/reindex-rag.js` (only if Task 9's rewrite is somehow
missing): Task 9 Step 9 already rewrote `main()` to loop projects, and the no-arg grep
above returns zero matches for it. If the grep DOES show bare
`getPlot()`/`findAllCharacters()`/`getDirectorNotes()` inside `scripts/reindex-rag.js`,
do not improvise a new loop here — **re-apply Task 9 Step 9's replacement body
verbatim**. Two contract reminders when doing so: the indexers are ONE-ARGUMENT
(`indexBeat(b._id)`, `indexCharacter(c._id)`, `indexDirectorNote(n._id)` — each
derives `project_id` from its owning doc); only the read helpers take the id
(`getPlot(pid)`, `findAllCharacters(pid)`, `getDirectorNotes(pid)`), and the
`message` block stays outside the project loop (channel-scoped; `indexMessage(d)`
reads each doc's own `project_id` stamp).

Re-run after fixes:

```
npm test
```

Expected: all test files pass.

- [ ] **Step 18: Commit the flip**

```
git add src/mongo/projects.js tests/projects.test.js
git commit -m "♻️ Make resolveProjectId strict — missing projectId now throws"
```

If Step 17 fixed stragglers, add those files to the same commit (e.g.
`git add scripts/reindex-rag.js`) — the flip and its enabling fixes belong together so
the tree is never red.

**End-of-task verification:**
`npx vitest run tests/multiProjectIsolation.test.js tests/projects.test.js` → all pass;
`npm test` → green; both Step 17 greps (no-arg reads, `(undefined, ` placeholders) →
zero matches; `grep -rn "shiftLegacyArgs" src/ tests/` → zero matches.

---

### Task 21: Docs (CLAUDE.md, system prompt cross-check) + deploy runbook

**Files:**
- Modify: `CLAUDE.md` (lines 20–22 insert anchor; lines 33–39 Room naming; line 73 CORE_TOOL_NAMES; lines 82–86 MongoDB layout bullets)
- Modify: `src/agent/systemPrompt.js` (line 77 — `# Tool loading` always-available list only)
- README.md: **verified — no change needed.** `grep -c "conversations" README.md` returns `0`, and README's only "collection" hits (lines 222, 307) are the `edit` tool's `collection:` parameter, not Mongo collections. The affected collections (`plots`, `prompts`, `yjs_docs`, `messages`) are not documented in README. (Bonus: CLAUDE.md's parenthetical claiming README mentions a `conversations` collection is itself stale — removed in Step 5 below.)

- [ ] **Step 1: Cross-check that Phase C landed the system-prompt project changes (do NOT duplicate them here)**

Phase C (agent loop + system prompt tasks) owns: the `# Current project` header line,
`set_project` guidance, and rewriting the `# Web UI` URL list
(`src/agent/systemPrompt.js` lines 41–49) plus `src/web/links.js` to the
`/p/<projectTitle>/...` form. Verify it landed:

```
grep -n "Current project" src/agent/systemPrompt.js
grep -n "/p/" src/agent/systemPrompt.js src/web/links.js
```

Expected: at least one match per grep. **If either grep returns nothing, STOP — go
execute the Phase C system-prompt/links task first; Task 21 must not re-implement it.**

- [ ] **Step 2: Fix the `# Tool loading` always-available list (incidental accuracy fix — Phase C does not touch this list)**

`CORE_TOOL_NAMES` (src/agent/tools.js:1703–1713) contains 9 names including `edit`, but
the prompt's always-available list omits it. In `src/agent/systemPrompt.js` line 77,
replace (note the template-literal `\`` escapes — match them exactly):

```
- \`get_overview\`, \`list_characters\`, \`list_beats\`, \`get_plot\`, \`get_current_beat\`, \`search_message_history\`, \`screenplay_search\` — read-only state inspection
```

with:

```
- \`get_overview\`, \`list_characters\`, \`list_beats\`, \`get_plot\`, \`get_current_beat\`, \`search_message_history\`, \`screenplay_search\` — read-only state inspection
- \`edit\` — the universal text editor for beat/character/note/plot fields
```

- [ ] **Step 3: CLAUDE.md — rewrite the Room naming section (three singleton rooms, project-scoped; corrects the stale notes-only claim)**

Replace CLAUDE.md lines 33–39, currently exactly:

```markdown
### Room naming

- `beat:<beat _id hex>` — fields `body`, `name`, `desc`
- `character:<character _id hex>` — fields `name`, `hollywood_actor`, `fields.<each non-core template field>`
- `notes` — one shared y-doc for all director's notes; each note's text is fragment `note:<note _id>:text`

URLs use the human-meaningful identifier (`/beat/2` for the beat at order=2; `/character/Steve` for the character whose stripped name is "Steve") and the route resolver maps to the stable `_id` for the y-doc room name. Reordering beats breaks shared URLs but never shuffles y-doc state across the wrong rooms.
```

with:

```markdown
### Room naming

- `beat:<beat _id hex>` — fields `body`, `name`, `desc`
- `character:<character _id hex>` — fields `name`, `hollywood_actor`, `fields.<each non-core template field>`
- `storyboards:<beat _id hex>` / `dialogs:<beat _id hex>` — per-beat storyboard and dialog rooms
- **Three project-scoped singleton rooms**: `plot:<projectId>` (fields `title`, `synopsis`, `dialogue_style`), `notes:<projectId>` (one y-doc for all of a project's director's notes; each note's text is fragment `note:<note _id>:text`), `library:<projectId>` (library image/attachment names and descriptions)

Entity rooms are ObjectId-derived and carry no project segment — `resolveRoom` resolves (and verifies) the owning project from the entity doc itself. URLs use the human-meaningful identifier under the project prefix (`/p/<projectTitle>/beat/2` for the beat at order=2; `/p/<projectTitle>/character/Steve` for the character whose stripped name is "Steve") and the route resolver maps to the stable `_id` for the y-doc room name. Reordering beats breaks shared URLs but never shuffles y-doc state across the wrong rooms.
```

- [ ] **Step 4: CLAUDE.md — correct the CORE_TOOL_NAMES count (line 73)**

Replace:

```markdown
- `src/agent/tools.js` exports `CORE_TOOL_NAMES` (a Set) — `tool_search`, `get_overview`, `list_characters`, `list_beats`, `get_plot`, `get_current_beat`, `search_message_history`. These are always present.
```

with:

```markdown
- `src/agent/tools.js` exports `CORE_TOOL_NAMES` (a Set of 9) — `tool_search`, `get_overview`, `list_characters`, `list_beats`, `get_plot`, `get_current_beat`, `search_message_history`, `screenplay_search`, `edit`. These are always present.
```

- [ ] **Step 5: CLAUDE.md — update the MongoDB layout bullets (lines 82–86)**

Five surgical edits in the `### MongoDB layout (src/mongo/)` section.

5a. `characters` bullet — replace:

```markdown
- `characters` — one doc per character. Custom template fields live under `fields.{...}`; core fields (`name`, `plays_self`, `hollywood_actor`, `own_voice`) are top-level. `name_lower` has a unique index. `getCharacter` accepts either a 24-char hex `_id` or a case-insensitive name.
```

with:

```markdown
- `characters` — one doc per character, stamped with `project_id`. Custom template fields live under `fields.{...}`; core fields (`name`, `plays_self`, `hollywood_actor`, `own_voice`) are top-level. `(project_id, name_lower)` has a compound unique index — the same name can exist in two projects. `getCharacter(projectId, idOrName)` accepts either a 24-char hex `_id` (verified against `project_id`; cross-project ids behave as not-found) or a case-insensitive name.
```

5b. `plots` bullet — replace:

```markdown
- `plots` — singleton `{ _id: 'main' }` with an **embedded `beats` array** (no separate beats collection). Each beat has its own ObjectId, an `images[]` of metadata, and a `main_image_id`. `getPlot` lazily backfills `_id`, `images`, `main_image_id`, `current_beat_id` on legacy docs (see `ensureBeatIds`) — keep that path working when changing the schema.
```

with:

```markdown
- `plots` — one doc per project (keyed by `project_id`; the pre-migration legacy doc keeps `_id: 'main'`) with an **embedded `beats` array** (no separate beats collection). Each beat has its own ObjectId, an `images[]` of metadata, and a `main_image_id`. `getPlot(projectId)` lazily backfills `_id`, `images`, `main_image_id`, `current_beat_id` on legacy docs (see `ensureBeatIds`), lazy-claims the un-stamped `{_id:'main'}` doc for the default project, and lazily creates an empty plot doc for new projects — keep those paths working when changing the schema.
```

5c. `messages` bullet — replace (this also removes the stale "README mentions
`conversations`" parenthetical; README no longer mentions it — verified above):

```markdown
- `messages` — rolling Discord transcript. Indexed on `(channel_id, created_at)`. The `recordAgentTurns` writer assigns `created_at = Date.now() + i` to preserve intra-turn ordering. (Note: the README mentions a `conversations` collection — that's stale, the code uses `messages`.)
```

with:

```markdown
- `messages` — rolling Discord transcript, stamped with `project_id` (history loading stays channel-scoped by design; the stamp exists for search/RAG filtering). Indexed on `(channel_id, created_at)`. The `recordAgentTurns` writer assigns `created_at = Date.now() + i` to preserve intra-turn ordering.
```

5d. `prompts` bullet — replace:

```markdown
- `prompts` — singleton docs `_id: 'character_template'`, `_id: 'plot_template'`, and `_id: 'director_notes'`. The first two are seeded by `src/seed/defaults.js` on startup; removing fields marked `core: true` is rejected. The `director_notes` doc holds an embedded `notes[]` array; each note can carry its own `images[]`/`main_image_id`/`attachments[]` (mirrors the beat schema). `getDirectorNotes` lazily backfills the missing arrays on legacy notes.
```

with:

```markdown
- `prompts` — per-project docs with composite string ids `_id: '<projectId>:character_template'`, `'<projectId>:plot_template'`, and `'<projectId>:director_notes'`. The first two are cloned from defaults at project creation (`seedProjectDefaults` in `src/seed/defaults.js`; the startup pass iterates all projects); removing fields marked `core: true` is rejected. The `director_notes` doc holds an embedded `notes[]` array; each note can carry its own `images[]`/`main_image_id`/`attachments[]` (mirrors the beat schema). `getDirectorNotes(projectId)` lazily backfills the missing arrays on legacy notes. No lazy claim for prompts — `scripts/migrate-multi-project.js` handles the re-keying.
```

5e. GridFS bullet — within the `images` bucket bullet, replace the sentence pair:

```markdown
Filtered by `metadata.owner_type` (`'beat'`, `'character'`, `'director_note'`, or `null` for library) and `metadata.owner_id`. Indexed on `(metadata.owner_type, metadata.owner_id)`.
```

with:

```markdown
Filtered by `metadata.owner_type` (`'beat'`, `'character'`, `'director_note'`, or `null` for library), `metadata.owner_id`, and `metadata.project_id` (stamped on every upload; library listings filter on it). Indexed on `(metadata.owner_type, metadata.owner_id)` and `(metadata.project_id, metadata.owner_type)`.
```

- [ ] **Step 6: CLAUDE.md — add the Multi-project subsection**

Insert immediately after the `## Architecture` intro paragraph (line 20, ending
"URLs use `WEB_PUBLIC_BASE_URL` when set.") and before `### Collaborative editor (SPA)`
(line 22). Edit anchor — replace:

```markdown
### Collaborative editor (SPA)

`src/web/` is the backend half; `web/` is the React/Vite SPA.
```

with:

```markdown
### Multi-project

- `projects` collection: `{ _id: ObjectId, title, title_lower, created_at }` (`src/mongo/projects.js`). Titles are plain text: trimmed, non-empty, max 120 chars, no `/`; `title_lower` has a unique index. The **default project** is the oldest by `created_at`; `getDefaultProject()` lazily creates one titled "Screenplay" on an empty collection.
- **`project_id` convention**: stored as a 24-hex *string* (`projects._id.toString()`) on every content doc (`plots`, `characters`, `messages`, `storyboards`, `dialogs`, the composite `prompts` ids) and in GridFS `metadata.project_id`. Every project-scoped helper in `src/mongo/*` takes `projectId` as its first parameter (or as an options key on single-options-object helpers) and **throws `projectId required`** on a falsy value — a throw means a missed threading site; fix the caller, never re-add a default. ObjectId-addressed lookups locate by id, then verify the doc's `project_id`; mismatches behave as not-found (this is what makes stale entity ids from pre-switch chat history fail safely).
- **Agent**: the channel's active project lives in `channel_state.current_project_id`; `handleMessage` resolves it inside the per-channel mutex and threads `{projectId, projectTitle}` through the agent `context` (passed by `dispatchTool` to all handlers). The lazy-loaded `set_project` tool (input `{title}`) switches it, mutates the context in place for later same-turn calls, and — via the `set_` mutating prefix — forces a system-prompt rebuild. Project creation is web-only.
- **REST**: `src/web/projectMiddleware.js#resolveProject()` reads the `X-Project-Id` header (`?project_id=` query fallback for SSE, since `EventSource` can't set headers) into `req.projectId`/`req.projectTitle`; missing → default project, unknown id → 404 `{error:'unknown project'}`. `GET /api/projects` lists, `POST /api/projects {title}` creates (201; 400 invalid title, 409 duplicate), `GET /api/info` additionally returns `project_id`/`project_title`.
- **SPA**: all routes nest under `/p/:projectTitle/*`; legacy paths redirect into the viewer's last-used project (localStorage key `screenplay_project_v1`). `web/src/project/ProjectContext.jsx` resolves the title and primes the module-level store in `web/src/api.js` (`setCurrentProject` → `authHeaders()` adds `X-Project-Id`, `apiSseUrl()` appends `project_id`). Switching projects is a full-page `location.assign` to the new `/p/<title>/` URL.
- **Migration runbook** (one-shot, idempotent; also applies when restoring a pre-multi-project dump). MIGRATE BEFORE RESTART: a restarted bot on the new code lazily creates a "Screenplay" project (and seeds fresh default templates) on its first request, which the migration would then have to rename and overwrite. The source is bind-mounted (`./src`, `./scripts` → `/app/...`), so new code ships without a restart and runs via `docker compose exec` while the old process keeps executing the old code: 1) rsync the new source to the host WITHOUT restarting (deploy.sh's rsync line, minus its `docker compose up -d bot && docker compose restart bot` tail — do NOT run plain `./deploy.sh` for this first multi-project deploy; it always restarts right after rsync), 2) `ssh <host> 'cd <dir> && docker compose exec bot node scripts/migrate-multi-project.js'` (the exec'd process is NEW code via the mount; creates the default project titled from the screenplay title, stamps `project_id` everywhere, re-keys `prompts` — legacy customized templates overwrite any freshly-seeded defaults — renames the three singleton y-doc rooms preserving CRDT state, ensures the plots/characters indexes, points `channel_state` at the default project), 3) `ssh <host> 'cd <dir> && docker compose exec bot node scripts/reindex-rag.js'` (full Chroma reindex with `project_id` metadata), 4) `ssh <host> 'cd <dir> && docker compose up -d bot && docker compose restart bot'` — only now does the bot load the new code, against fully-migrated data. Subsequent deploys go back to plain `./deploy.sh`. Backup/restore remains whole-DB (`mongodump` / `mongorestore --drop`): restoring to fix project A rolls back every other project too — no per-project backup or export in v1.

### Collaborative editor (SPA)

`src/web/` is the backend half; `web/` is the React/Vite SPA.
```

- [ ] **Step 7: Verify docs accuracy with greps**

```
grep -c "conversations" README.md            # expect: 0  (no README change needed)
grep -n "Set of 9" CLAUDE.md                 # expect: 1 match (line ~73 area)
grep -n "plot:<projectId>" CLAUDE.md         # expect: ≥1 match (Room naming)
grep -n "### Multi-project" CLAUDE.md        # expect: 1 match
grep -n "conversations" CLAUDE.md            # expect: 0 (stale parenthetical removed)
```

- [ ] **Step 8: Run the suite (docs + one prompt line changed — `npm test` must stay green)**

```
npm test
```

Expected: all test files pass (no test asserts the exact `# Tool loading` bullet text;
if one does — `npx vitest run tests/agent-loop-tool-search.test.js` is the likely
candidate — update its expected string to include the new `edit` bullet).

- [ ] **Step 9: Commit**

```
git add CLAUDE.md src/agent/systemPrompt.js
git commit -m "📝 Document multi-project architecture, room scoping, and migration runbook"
```

- [ ] **Step 10: Rollout (MANUAL GATE — operator action, do not run unprompted; no commit — operator-gated; the task's code work ends at Step 9)**

The deploy itself is Steve's call ("deploy this shit" = `./deploy.sh`) — but **plain
`./deploy.sh` is wrong for this one deploy**: it always restarts immediately after
rsync (`docker compose up -d bot && docker compose restart bot`), and the restarted
NEW code lazily creates a "Screenplay" project + fresh default templates on its first
request, before the migration can name the project from the screenplay title. (Task
19's hardening recovers from that, but don't lean on it.) The container bind-mounts
`./src` and `./scripts` (docker-compose.yml), so rsynced files are visible inside the
running container immediately while the old node process keeps executing the old code
it loaded at startup — `docker compose exec` then runs the migration as a fresh
process on the NEW code. Present this runbook and **stop for confirmation** before
executing anything:

```bash
# 0. From the repo root. SSH_PATH=user@host:/absolute/path comes from .env,
#    exactly as deploy.sh reads it.
SSH_PATH="$(grep -E '^SSH_PATH=' .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
SSH_HOST="${SSH_PATH%%:*}"; REMOTE_DIR="${SSH_PATH#*:}"

# 1. Tests + SPA build, mirroring deploy.sh (prod base path from the REMOTE .env).
npm test
WEB_BASE_PATH="$(ssh "$SSH_HOST" "grep -E '^WEB_BASE_PATH=' '$REMOTE_DIR/.env' 2>/dev/null | tail -n1" | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')" npm run build:web

# 2. Ship the new source WITHOUT restarting — this is deploy.sh's rsync block
#    verbatim, just not followed by its restart step.
rsync -avz --delete --human-readable \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.claude/' \
  --exclude='*.log' \
  --exclude='mongo-data/' \
  --exclude='exports/' \
  --exclude='backups/' \
  --exclude='coverage/' \
  --exclude='tmp/' \
  --exclude='.DS_Store' \
  ./ "$SSH_PATH/"

# 3. Run the migration as a NEW process inside the running container — it reads
#    the NEW source via the bind mounts; the old bot process (still running
#    pre-multi-project code) cannot lazily create a "Screenplay" project.
#    Keep the Discord channel/SPA quiet between this step and step 5: the old
#    code writes un-stamped docs. If something does slip in, re-run this step
#    after the restart — the $exists-guarded stamping pass picks the docs up.
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose exec bot node scripts/migrate-multi-project.js"

# 4. Full Chroma reindex with project_id metadata, same exec mechanism.
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose exec bot node scripts/reindex-rag.js"

# 5. NOW restart onto the new code, against fully-migrated data.
ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose up -d bot && docker compose restart bot"
```

6. Smoke-check: open the SPA root (redirects into `/p/<title>/`), confirm the header
   brand shows the project title (the screenplay's title, NOT "Screenplay" — a generic
   "Screenplay" means the bot served traffic before step 3 ran; the data is intact
   under that project, Task 19's hardening protected the templates, and only the title
   is generic — rename it via the SPA's project manager), and post a message in the
   Discord channel to confirm the bot answers against the same project.
7. Subsequent deploys return to plain `./deploy.sh`.

**End-of-task verification:** `npm test` → green; the five greps in Step 7 return the
stated counts; `git log --oneline -3` shows the 📝 commit on top.
