# Beat Drag-Reorder + Auto-Renumbering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag-and-drop to reorder beats on the TOC (Beats/Dialog/Storyboards tabs) with automatic sequential renumbering, and make every beat mutation — human or AI — keep `beat.order` a contiguous `1..N` sequence, pushing live updates to open TOC pages.

**Architecture:** `beat.order` becomes a self-maintaining `1..N` invariant enforced in the Mongo layer (`normalizeBeatOrders` inside `createBeat`/`updateBeat`/`deleteBeat`, plus a positional `reorderBeats`). A gateway wrapper broadcasts a `fields_updated` ping to the singleton `plot:<projectId>` room whenever the beat list changes; the SPA subscribes via a new bare-provider `useRoomBroadcast` hook and refetches `/toc`. Drag-and-drop reuses the existing dnd-kit pattern from `DialogBeat.jsx` through a shared `SortableBeatList` widget and a new `POST /beats/reorder` endpoint.

**Tech Stack:** Node/Express, MongoDB (embedded `plots.beats[]` array), Hocuspocus (y-doc + stateless broadcasts), React/Vite SPA, `@dnd-kit` (already a dependency), Vitest.

## Global Constraints

- Beat numbering is **always sequential `1,2,3…`** — no gaps, no ties, no decimals persisted. Every membership/position change renumbers.
- Setting `order = N` means **"move this beat to position N"** (implemented as sort-key `N - 0.5` then normalize), for both the agent and `updateBeat`.
- Every project-scoped Mongo helper takes `projectId` first and **throws `projectId required`** on a falsy value — never re-add a default.
- The Mongo layer must stay broadcast-free (CLI/tests run without Hocuspocus); broadcasts live in the gateway. `broadcastFieldsUpdated` is a safe no-op (returns `false`) when no clients are connected.
- Mongo-touching tests use the in-memory fake (`tests/_fakeMongo.js`) mocked via `vi.mock('../src/mongo/client.js', …)` + dynamic `await import(...)` after the mock. Call `fakeDb.reset()` in `beforeEach`.
- Frontend React components have **no unit-test harness** in this repo (dnd-kit code in `DialogBeat`/`StoryboardBeat` is not unit-tested). Frontend tasks are verified by build + manual check, matching the existing convention.
- Follow existing patterns: `reorderDialogsForBeat` (`src/mongo/dialogs.js:189`), `reorderDialogsViaGateway` (`src/web/gateway.js:2165`), `POST /dialogs/reorder` (`src/web/entityRoutes.js:5504`), `reorder_director_notes` handler (`src/agent/handlers.js:1502`), and the dnd-kit setup in `web/src/routes/DialogBeat.jsx`.

---

### Task 1: `normalizeBeatOrders` helper (Mongo)

**Files:**
- Modify: `src/mongo/plots.js` (add helper near the other beat helpers, above `createBeat` at line 310)
- Test: `tests/beat-reorder.test.js` (new)

**Interfaces:**
- Produces: `normalizeBeatOrders(beats: BeatDoc[]) => BeatDoc[]` — a pure function that sorts by current `order` then rewrites `order` to `1..N`. Returns a new array; beats whose order is already correct are returned unchanged (referentially), others are shallow-cloned with the new `order`. Exported for direct testing.

- [ ] **Step 1: Write the failing test**

Create `tests/beat-reorder.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Reorder Test'))._id.toString();
});

describe('normalizeBeatOrders', () => {
  it('rewrites gapped/tied/decimal orders to a contiguous 1..N by sort', () => {
    const input = [
      { _id: 'a', order: 5 },
      { _id: 'b', order: 1 },
      { _id: 'c', order: 1.5 },
      { _id: 'd', order: 1 },
    ];
    const out = Plots.normalizeBeatOrders(input);
    // Sorted by order (ties keep input order): b(1), d(1), c(1.5), a(5)
    expect(out.map((x) => x._id)).toEqual(['b', 'd', 'c', 'a']);
    expect(out.map((x) => x.order)).toEqual([1, 2, 3, 4]);
  });

  it('does not mutate the input array or its already-correct members', () => {
    const b0 = { _id: 'x', order: 1 };
    const input = [b0, { _id: 'y', order: 2 }];
    const out = Plots.normalizeBeatOrders(input);
    expect(out[0]).toBe(b0); // unchanged reference
    expect(input.map((x) => x.order)).toEqual([1, 2]); // input untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/beat-reorder.test.js -t "normalizeBeatOrders"`
Expected: FAIL — `Plots.normalizeBeatOrders is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/mongo/plots.js`, add above `createBeat` (line 310):

```js
// Beat numbers are a maintained invariant: always the contiguous sequence
// 1..N with no gaps or ties. This is the single place that enforces it —
// callers that change beat membership or position run their array through it
// before persisting. Pure: sorts a copy by current order, then rewrites order
// to 1-based position. Members already at the right number are returned as-is
// (referential identity preserved) so writes stay minimal.
export function normalizeBeatOrders(beats) {
  return [...(beats || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b, i) => (b.order === i + 1 ? b : { ...b, order: i + 1 }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/beat-reorder.test.js -t "normalizeBeatOrders"`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/mongo/plots.js tests/beat-reorder.test.js
git commit -m "✨ Add normalizeBeatOrders helper (contiguous 1..N invariant)"
```

---

### Task 2: Renumber on create / update / delete (Mongo)

**Files:**
- Modify: `src/mongo/plots.js` — `createBeat` (310-346), `updateBeat` order block (405-421), `deleteBeat` (513-532)
- Test: `tests/beat-reorder.test.js` (extend)

**Interfaces:**
- Consumes: `normalizeBeatOrders` (Task 1).
- Produces: unchanged signatures — `createBeat({projectId,name,desc,body,characters,order})`, `updateBeat(projectId, identifier, patch)`, `deleteBeat(projectId, identifier)` — but all now guarantee `1..N` afterward, and `order` in create/update means "target position".

- [ ] **Step 1: Write the failing tests**

Append to `tests/beat-reorder.test.js`:

```js
describe('beat mutations keep order contiguous 1..N', () => {
  async function makeBeats(names) {
    const beats = [];
    for (const n of names) beats.push(await Plots.createBeat({ projectId, name: n, body: 'x' }));
    return beats;
  }
  const orders = async () =>
    (await Plots.listBeats(projectId)).map((b) => b.order);
  const names = async () =>
    (await Plots.listBeats(projectId)).map((b) => b.name);

  it('createBeat with order=N inserts at position N and renumbers', async () => {
    await makeBeats(['A', 'B', 'C']); // 1,2,3
    const inserted = await Plots.createBeat({ projectId, name: 'NEW', body: 'x', order: 2 });
    expect(inserted.order).toBe(2);
    expect(await names()).toEqual(['A', 'NEW', 'B', 'C']);
    expect(await orders()).toEqual([1, 2, 3, 4]);
  });

  it('createBeat without order appends at the end', async () => {
    await makeBeats(['A', 'B']);
    const inserted = await Plots.createBeat({ projectId, name: 'Z', body: 'x' });
    expect(inserted.order).toBe(3);
    expect(await names()).toEqual(['A', 'B', 'Z']);
  });

  it('updateBeat order=N moves the beat to position N and renumbers', async () => {
    const [a, b, c, d] = await makeBeats(['A', 'B', 'C', 'D']);
    const moved = await Plots.updateBeat(projectId, d._id.toString(), { order: 2 });
    expect(moved.order).toBe(2);
    expect(await names()).toEqual(['A', 'D', 'B', 'C']);
    expect(await orders()).toEqual([1, 2, 3, 4]);
  });

  it('updateBeat order past the end clamps to last', async () => {
    const [a, b, c] = await makeBeats(['A', 'B', 'C']);
    await Plots.updateBeat(projectId, a._id.toString(), { order: 99 });
    expect(await names()).toEqual(['B', 'C', 'A']);
    expect(await orders()).toEqual([1, 2, 3]);
  });

  it('deleteBeat closes the numbering gap', async () => {
    const [a, b, c, d] = await makeBeats(['A', 'B', 'C', 'D']);
    await Plots.deleteBeat(projectId, b._id.toString());
    expect(await names()).toEqual(['A', 'C', 'D']);
    expect(await orders()).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/beat-reorder.test.js -t "contiguous 1..N"`
Expected: FAIL — e.g. `createBeat order=2` currently yields duplicate order `2` / wrong sequence; `deleteBeat` leaves `[1,3,4]`.

- [ ] **Step 3: Implement — `createBeat`**

In `src/mongo/plots.js`, replace the order/insert block in `createBeat` (currently lines 320-343):

```js
  const now = new Date();
  const insertKey =
    order === undefined || order === null
      ? (existing.length ? Math.max(...existing.map((b) => b.order || 0)) + 1 : 1)
      // "Insert at position N": land just before whoever currently holds N,
      // then normalize turns the fractional key into a clean integer.
      : Number(order) - 0.5;
  const beat = {
    _id: new ObjectId(),
    order: insertKey,
    name: finalName,
    desc: finalDesc,
    body: String(body || ''),
    characters: dedupeNames(characters),
    dialog_notes: '',
    images: [],
    main_image_id: null,
    scene_bible: null,
    attachments: [],
    artworks: [],
    created_at: now,
    updated_at: now,
  };
  const beats = normalizeBeatOrders([...existing, beat]);
  const persisted = beats.find((b) => b._id.equals(beat._id));
  const extra = plot.current_beat_id ? {} : { current_beat_id: beat._id };
  await persistBeatsFullArray(projectId, beats, extra);
  logger.info(`mongo: beat create id=${beat._id} order=${persisted.order} name="${beat.name}"`);
  return persisted;
```

- [ ] **Step 4: Implement — `updateBeat` order block**

Replace the `orderChanging` handling (currently lines 405-420). The set key becomes fractional; the post-write pass normalizes:

```js
  const orderChanging = patch.order !== undefined && patch.order !== null;
  // "Move to position N": write a fractional sort key so the beat lands just
  // before whoever currently holds N, then renumber the whole array to 1..N.
  if (orderChanging) set['beats.$.order'] = Number(patch.order) - 0.5;

  await updateBeatFields(projectId, beat._id, set);
  const patchFields = Object.keys(patch || {});
  logger.info(`mongo: beat update id=${beat._id} fields=[${patchFields.join(',')}]`);

  if (orderChanging) {
    const fresh = await getPlot(projectId);
    const normalized = normalizeBeatOrders(fresh.beats || []);
    await persistBeatsFullArray(projectId, normalized);
    return normalized.find((b) => b._id && b._id.equals(beat._id));
  }
  return fetchBeat(projectId, beat._id);
```

- [ ] **Step 5: Implement — `deleteBeat`**

Replace the write in `deleteBeat` (currently lines 520-526) so removal + renumber is a single full-array write:

```js
  const wasCurrent =
    plot.current_beat_id && plot.current_beat_id.equals(beat._id);
  const remaining = normalizeBeatOrders(
    (plot.beats || []).filter((b) => !b._id.equals(beat._id)),
  );
  const extra = wasCurrent ? { current_beat_id: null } : {};
  await persistBeatsFullArray(projectId, remaining, extra);
  logger.info(`mongo: beat delete id=${beat._id} name="${beat.name}"`);
```

(Keep the `return { _id, name, image_ids }` block below unchanged.)

- [ ] **Step 6: Run the new tests + the existing beats suite**

Run: `npx vitest run tests/beat-reorder.test.js tests/beats.test.js`
Expected: PASS. If any existing `beats.test.js` case asserted literal post-move `order` values under the old "set literal value" semantics, update that assertion to the move-to-position result (the move-to-position behavior is the new intended contract).

- [ ] **Step 7: Commit**

```bash
git add src/mongo/plots.js tests/beat-reorder.test.js tests/beats.test.js
git commit -m "✨ Auto-renumber beats 1..N on create/update/delete (move-to-position order)"
```

---

### Task 3: `reorderBeats` positional reorder (Mongo)

**Files:**
- Modify: `src/mongo/plots.js` (add `reorderBeats`, after `deleteBeat`)
- Test: `tests/beat-reorder.test.js` (extend)

**Interfaces:**
- Consumes: `getPlot`, `persistBeatsFullArray`, `resolveProjectId`.
- Produces: `reorderBeats(projectId, orderedIds: string[]) => Promise<BeatDoc[]>` — validates the id list is a full permutation of the plot's beats, then assigns `order = i+1` by array position and persists. Returns the reordered, renumbered beats. Throws on length mismatch / duplicate id / unknown id (mirrors `reorderDialogsForBeat`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/beat-reorder.test.js`:

```js
describe('reorderBeats', () => {
  it('renumbers by array position', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const C = await Plots.createBeat({ projectId, name: 'C', body: 'x' });
    const out = await Plots.reorderBeats(projectId, [
      C._id.toString(), A._id.toString(), B._id.toString(),
    ]);
    expect(out.map((x) => x.name)).toEqual(['C', 'A', 'B']);
    expect(out.map((x) => x.order)).toEqual([1, 2, 3]);
    const persisted = await Plots.listBeats(projectId);
    expect(persisted.map((x) => x.name)).toEqual(['C', 'A', 'B']);
  });

  it('rejects a mismatched length', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    await expect(Plots.reorderBeats(projectId, [A._id.toString()])).rejects.toThrow(/length/);
  });

  it('rejects a duplicate id', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    await expect(
      Plots.reorderBeats(projectId, [A._id.toString(), A._id.toString()]),
    ).rejects.toThrow(/duplicate/);
  });

  it('rejects an unknown id', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const { ObjectId } = await import('mongodb');
    await expect(
      Plots.reorderBeats(projectId, [A._id.toString(), new ObjectId().toString()]),
    ).rejects.toThrow(/not in this plot/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/beat-reorder.test.js -t "reorderBeats"`
Expected: FAIL — `Plots.reorderBeats is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/mongo/plots.js` after `deleteBeat`:

```js
// Positional reorder: `orderedIds` must be every beat _id in the desired
// sequence. Assigns order = i+1 by array position (mirrors
// reorderDialogsForBeat). The dedicated path the drag-and-drop UI and the
// agent's reorder_beats tool call.
export async function reorderBeats(projectId, orderedIds) {
  projectId = await resolveProjectId(projectId);
  if (!Array.isArray(orderedIds)) throw new Error('orderedIds must be an array');
  const plot = await getPlot(projectId);
  const beats = plot.beats || [];
  if (orderedIds.length !== beats.length) {
    throw new Error(
      `reorder: orderedIds length ${orderedIds.length} != current ${beats.length}`,
    );
  }
  const byId = new Map(beats.map((b) => [b._id.toString(), b]));
  const seen = new Set();
  const reordered = [];
  for (const rawId of orderedIds) {
    const key = String(rawId);
    if (seen.has(key)) throw new Error(`reorder: duplicate id ${key}`);
    seen.add(key);
    const beat = byId.get(key);
    if (!beat) throw new Error(`reorder: id ${key} not in this plot`);
    reordered.push(beat);
  }
  const normalized = reordered.map((b, i) => (b.order === i + 1 ? b : { ...b, order: i + 1 }));
  await persistBeatsFullArray(projectId, normalized);
  logger.info(`mongo: beats reorder count=${normalized.length}`);
  return normalized;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/beat-reorder.test.js -t "reorderBeats"`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/mongo/plots.js tests/beat-reorder.test.js
git commit -m "✨ Add reorderBeats(projectId, orderedIds) positional reorder"
```

---

### Task 4: Gateway wrappers + `plot:` room broadcast

**Files:**
- Modify: `src/web/gateway.js` — add helpers near `reorderDialogsViaGateway` (2165); augment `updateBeatViaGateway` order path (619-629)
- Test: `tests/beat-reorder-gateway.test.js` (new)

**Interfaces:**
- Consumes: `reorderBeats`, `createBeat`, `deleteBeat` (Mongo, via dynamic import — matches the existing `await import('../mongo/plots.js')` at line 624), `broadcastFieldsUpdated`, `buildRoomName` (already used in this file).
- Produces:
  - `broadcastBeatsChanged(projectId)` → pings `plot:<projectId>` with `{changed:['beats']}`; returns the broadcast result.
  - `reorderBeatsViaGateway({projectId, orderedIds})` → `reorderBeats` + broadcast; returns beats.
  - `createBeatViaGateway(opts)` → `createBeat(opts)` + broadcast; returns the beat.
  - `deleteBeatViaGateway(projectId, identifier)` → `deleteBeat` + broadcast; returns `{_id,name,image_ids}`.

- [ ] **Step 1: Write the failing test**

Create `tests/beat-reorder-gateway.test.js`. Hocuspocus is not running in tests, so `broadcastFieldsUpdated` is a no-op — we assert the data path (renumbering) works and does not throw:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Gateway = await import('../src/web/gateway.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  vi.clearAllMocks();
  projectId = (await createProject('GW Reorder'))._id.toString();
});

describe('reorderBeatsViaGateway', () => {
  it('renumbers and returns the reordered beats without a running Hocuspocus', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const out = await Gateway.reorderBeatsViaGateway({
      projectId,
      orderedIds: [B._id.toString(), A._id.toString()],
    });
    expect(out.map((x) => x.name)).toEqual(['B', 'A']);
    expect(out.map((x) => x.order)).toEqual([1, 2]);
  });
});

describe('create/deleteBeatViaGateway', () => {
  it('createBeatViaGateway inserts + renumbers', async () => {
    await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const b = await Gateway.createBeatViaGateway({ projectId, name: 'NEW', body: 'x', order: 1 });
    expect(b.order).toBe(1);
    expect((await Plots.listBeats(projectId)).map((x) => x.name)).toEqual(['NEW', 'A']);
  });

  it('deleteBeatViaGateway removes + closes the gap', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    await Gateway.deleteBeatViaGateway(projectId, A._id.toString());
    expect((await Plots.listBeats(projectId)).map((x) => x.order)).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/beat-reorder-gateway.test.js`
Expected: FAIL — `Gateway.reorderBeatsViaGateway is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/web/gateway.js`, add near `reorderDialogsViaGateway` (after line 2171):

```js
// Ping the project-wide singleton room so any open Table of Contents refetches
// its beat list. Beat CONTENT lives in per-beat rooms; this only signals "the
// beat list/order changed". No-op (returns false) when no clients are connected.
export function broadcastBeatsChanged(projectId) {
  return broadcastFieldsUpdated(buildRoomName('plot', String(projectId)), {
    changed: ['beats'],
  });
}

export async function reorderBeatsViaGateway({ projectId, orderedIds }) {
  const { reorderBeats } = await import('../mongo/plots.js');
  const beats = await reorderBeats(projectId, orderedIds);
  broadcastBeatsChanged(projectId);
  return beats;
}

export async function createBeatViaGateway(opts) {
  const { createBeat } = await import('../mongo/plots.js');
  const beat = await createBeat(opts);
  broadcastBeatsChanged(opts.projectId);
  return beat;
}

export async function deleteBeatViaGateway(projectId, identifier) {
  const { deleteBeat } = await import('../mongo/plots.js');
  const res = await deleteBeat(projectId, identifier);
  broadcastBeatsChanged(projectId);
  return res;
}
```

Then, in `updateBeatViaGateway`, augment the discrete-write block (currently 623-629) so an order change also pings the TOC:

```js
  if (Object.keys(onlyDiscrete).length) {
    const { updateBeat: mongoUpdateBeat } = await import('../mongo/plots.js');
    await mongoUpdateBeat(projectId, beatId, onlyDiscrete);
    broadcastFieldsUpdated(buildRoomName('beat', beatId), {
      changed: Object.keys(onlyDiscrete),
    });
    if (onlyDiscrete.order !== undefined) broadcastBeatsChanged(projectId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/beat-reorder-gateway.test.js`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/web/gateway.js tests/beat-reorder-gateway.test.js
git commit -m "✨ Gateway beat reorder/create/delete wrappers + plot-room broadcast"
```

---

### Task 5: `POST /beats/reorder` REST endpoint

**Files:**
- Modify: `src/web/entityRoutes.js` — import (line 100 block) + new route (near `/dialogs/reorder`, 5504)
- Test: `tests/beats-reorder-route.test.js` (new)

**Interfaces:**
- Consumes: `reorderBeatsViaGateway` (Task 4), `req.projectId` (set by `resolveProject` middleware).
- Produces: `POST /beats/reorder` — body `{ordered_ids: string[]}`; `400` if `ordered_ids` is not an array; success → `{beats: [...]}`.

- [ ] **Step 1: Write the failing test**

Create `tests/beats-reorder-route.test.js` (mirrors the harness in `tests/beat-cast-patch-route.test.js`):

```js
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => { req.session = undefined; next(); },
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl, projectId;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Route Reorder'))._id.toString();
});

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('POST /api/beats/reorder', () => {
  it('renumbers beats into the given order', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const { status, json } = await post('/api/beats/reorder', {
      ordered_ids: [B._id.toString(), A._id.toString()],
    });
    expect(status).toBe(200);
    expect(json.beats.map((b) => b.name)).toEqual(['B', 'A']);
    expect(json.beats.map((b) => b.order)).toEqual([1, 2]);
  });

  it('returns 400 when ordered_ids is not an array', async () => {
    const { status, json } = await post('/api/beats/reorder', { ordered_ids: 'nope' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/ordered_ids/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/beats-reorder-route.test.js`
Expected: FAIL — 404 (route not registered) on the first case.

- [ ] **Step 3: Add the import**

In `src/web/entityRoutes.js`, add `reorderBeatsViaGateway` to the existing gateway import block that already contains `reorderDialogsViaGateway` (line 100). Example:

```js
  reorderDialogsViaGateway,
  reorderBeatsViaGateway,
```

- [ ] **Step 4: Add the route**

In `src/web/entityRoutes.js`, add just above `router.post('/dialogs/reorder', …)` (line 5504):

```js
  router.post('/beats/reorder', async (req, res, next) => {
    try {
      const orderedIds = req.body?.ordered_ids;
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'ordered_ids must be an array' });
      }
      const beats = await reorderBeatsViaGateway({
        projectId: req.projectId,
        orderedIds,
      });
      res.json({ beats });
    } catch (e) {
      next(e);
    }
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/beats-reorder-route.test.js`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add src/web/entityRoutes.js tests/beats-reorder-route.test.js
git commit -m "✨ Add POST /beats/reorder endpoint"
```

---

### Task 6: Agent `reorder_beats` tool + auto-renumber wiring

**Files:**
- Modify: `src/agent/tools.js` (add `reorder_beats` schema near other beat tools ~587-669)
- Modify: `src/agent/handlers.js` — add `reorder_beats` handler; route `create_beat` (1720) + `delete_beat` (1863) through the new gateway wrappers; update `set_field` beat-order help text (1219)
- Test: `tests/beat-reorder-handler.test.js` (new); `tests/tools-schema.test.js` (auto-enforced parity)

**Interfaces:**
- Consumes: `Gateway.reorderBeatsViaGateway`, `Gateway.createBeatViaGateway`, `Gateway.deleteBeatViaGateway` (Task 4); `withSpaLink`, `homeUrl` (from `src/web/links.js`).
- Produces: `HANDLERS.reorder_beats({beat_ids}, context)` → returns a confirmation string with a TOC link.

- [ ] **Step 1: Write the failing test**

Create `tests/beat-reorder-handler.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

let projectId, ctx;
beforeEach(async () => {
  fakeDb.reset();
  vi.clearAllMocks();
  projectId = (await createProject('Handler Reorder'))._id.toString();
  ctx = { projectId, projectTitle: 'Handler Reorder' };
});

describe('reorder_beats handler', () => {
  it('reorders and renumbers, returning a confirmation', async () => {
    const A = await Plots.createBeat({ projectId, name: 'A', body: 'x' });
    const B = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const C = await Plots.createBeat({ projectId, name: 'C', body: 'x' });
    const out = await HANDLERS.reorder_beats(
      { beat_ids: [C._id.toString(), A._id.toString(), B._id.toString()] },
      ctx,
    );
    expect(out).toMatch(/Reordered 3 beat/);
    const beats = await Plots.listBeats(projectId);
    expect(beats.map((b) => b.name)).toEqual(['C', 'A', 'B']);
    expect(beats.map((b) => b.order)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/beat-reorder-handler.test.js`
Expected: FAIL — `HANDLERS.reorder_beats is not a function`.

- [ ] **Step 3: Add the tool schema**

In `src/agent/tools.js`, add near the other beat tools (e.g. after `delete_beat` ~669):

```js
  {
    name: 'reorder_beats',
    description:
      'Reorder ALL beats into a new sequence; they are renumbered 1..N automatically. Pass every beat _id exactly once, in the order you want. Beat numbers are always kept sequential automatically — do NOT set beat.order by hand to renumber. To move a single beat, either use this with the full new order, or set its order to its target position (that also renumbers).',
    keywords: ['move', 'reorder', 'renumber', 'sequence', 'rearrange', 'sort', 'order beats'],
    input_schema: {
      type: 'object',
      properties: {
        beat_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'All beat _ids (24-hex strings) in the desired order. Must include every beat exactly once.',
        },
      },
      required: ['beat_ids'],
    },
  },
```

- [ ] **Step 4: Add the handler + route create/delete through the gateway**

In `src/agent/handlers.js`, add the import for `homeUrl` to the existing `links.js` import (line 15):

```js
import { aboutUrl, beatUrl, characterUrl, homeUrl, notesUrl, withSpaLink } from '../web/links.js';
```

Add the handler (near `create_beat`/`delete_beat`):

```js
  async reorder_beats({ beat_ids } = {}, context = null) {
    if (!Array.isArray(beat_ids)) {
      return 'Tool error (reorder_beats): `beat_ids` must be an array of beat _id strings.';
    }
    const beats = await Gateway.reorderBeatsViaGateway({
      projectId: context?.projectId,
      orderedIds: beat_ids,
    });
    return withSpaLink(
      `Reordered ${beats.length} beat(s) and renumbered them 1–${beats.length}.`,
      homeUrl(context?.projectTitle),
    );
  },
```

Change `create_beat` (line 1721) to use the gateway wrapper so it pings the TOC:

```js
    const b = await Gateway.createBeatViaGateway({ projectId: context?.projectId, name, desc, body, characters, order });
```

Change `delete_beat` (line 1864) similarly:

```js
    const res = await Gateway.deleteBeatViaGateway(context?.projectId, identifier);
```

- [ ] **Step 5: Update the `set_field` order help text**

In `src/agent/handlers.js`, the `set_field` beat branch error/help text (around 1219) currently lists `order, characters, scene_sheet_image_id`. Update the order guidance so the model understands positional + automatic renumbering. Change the beat-field error string to:

```js
        return `Tool error (set_field): beat field must be one of order, characters, scene_sheet_image_id; got "${field}". Setting order=N moves the beat to position N and renumbers all beats automatically (you never set beat numbers by hand). For text fields (name, desc, body) use \`edit\` instead.`;
```

- [ ] **Step 6: Run the handler test + tool/handler parity test**

Run: `npx vitest run tests/beat-reorder-handler.test.js tests/tools-schema.test.js`
Expected: PASS — the parity test confirms `reorder_beats` has both a TOOLS entry and a HANDLERS entry.

- [ ] **Step 7: Commit**

```bash
git add src/agent/tools.js src/agent/handlers.js tests/beat-reorder-handler.test.js
git commit -m "✨ Add reorder_beats agent tool; route create/delete beat through gateway"
```

---

### Task 7: `useRoomBroadcast` SPA hook

**Files:**
- Create: `web/src/hooks/useRoomBroadcast.js`

**Interfaces:**
- Consumes: `@hocuspocus/provider`, `yjs`, `apiGet` (`web/src/api.js`) for the `/info` ws URL — the same resolution `CollabSurface` uses (`info.hocuspocus_url || ws://<host>:3001`).
- Produces: `useRoomBroadcast(room: string|null, session, onBroadcast: (msg) => void)` — connects a bare `HocuspocusProvider` to `room`, invokes `onBroadcast(msg)` for each parsed `{type:'fields_updated'}` stateless ping, and tears down on unmount / dependency change. No editor, no awareness, no presence side effects.

- [ ] **Step 1: Create the hook**

Create `web/src/hooks/useRoomBroadcast.js`:

```js
// Subscribe to a Hocuspocus room's stateless {type:'fields_updated'} pings
// WITHOUT rendering an editor. CollabSurface does this too, but it also mounts
// awareness/presence and expects CollabField children — this is the bare
// listen-only version, used by pages (e.g. the TOC) that just need to refetch
// REST data when the server signals a change.
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { apiGet } from '../api.js';

export function useRoomBroadcast(room, session, onBroadcast) {
  const cbRef = useRef(onBroadcast);
  cbRef.current = onBroadcast;

  useEffect(() => {
    if (!room || !session?.session_id) return undefined;
    let cancelled = false;
    let provider;
    let doc;
    (async () => {
      let info;
      try {
        info = await apiGet('/info');
      } catch {
        return; // best-effort: no live updates if /info is unreachable
      }
      if (cancelled) return;
      const wsUrl = info.hocuspocus_url || `ws://${location.hostname}:3001`;
      doc = new Y.Doc();
      provider = new HocuspocusProvider({
        url: wsUrl,
        name: room,
        document: doc,
        token: session.session_id,
      });
      provider.on('stateless', ({ payload }) => {
        try {
          const msg = typeof payload === 'string' ? JSON.parse(payload) : payload;
          if (msg?.type === 'fields_updated') cbRef.current?.(msg);
        } catch {
          // ignore non-JSON messages
        }
      });
    })();
    return () => {
      cancelled = true;
      try { provider?.destroy(); } catch { /* noop */ }
      try { doc?.destroy(); } catch { /* noop */ }
    };
  }, [room, session?.session_id]);
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build:web`
Expected: build succeeds (no import/syntax errors). The hook has no consumer yet — that lands in Task 9.

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useRoomBroadcast.js
git commit -m "✨ Add useRoomBroadcast hook (bare Hocuspocus stateless listener)"
```

---

### Task 8: `SortableBeatList` widget

**Files:**
- Create: `web/src/widgets/SortableBeatList.jsx`

**Interfaces:**
- Consumes: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `react-router-dom` `Link`, `apiPostJson` (`web/src/api.js`).
- Produces: `<SortableBeatList items onReordered onError disabled />` where:
  - `items: Array<{ id: string, to: string, content: ReactNode, title?: string }>` in current display order (`id` is the beat `_id`).
  - `disabled: boolean` — when true, renders a plain list with no drag handles/DnD (used while a search filter is active).
  - On drag end, optimistically reorders locally, `POST /beats/reorder {ordered_ids}`, then calls `onReordered()` on success; on failure reverts and calls `onError(message)`.

- [ ] **Step 1: Create the widget**

Create `web/src/widgets/SortableBeatList.jsx`:

```jsx
// Drag-and-drop reorderable beat list for the Table of Contents. Reordering
// posts the full new id sequence to /beats/reorder, which renumbers beats
// 1..N server-side. Mirrors the dnd-kit wiring in DialogBeat.jsx. `items` are
// pre-sorted rows; `content` is the caller's per-tab label so the Beats /
// Dialog / Storyboard tabs keep their distinct row text.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiPostJson } from '../api.js';

function SortableRow({ id, to, content, title }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <li ref={setNodeRef} style={style} className="toc-sortable-row">
      <button
        type="button"
        className="toc-drag-handle"
        aria-label="Drag to reorder beat"
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </button>
      <Link to={to} title={title}>{content}</Link>
    </li>
  );
}

export function SortableBeatList({ items, onReordered, onError, disabled }) {
  const [order, setOrder] = useState(() => items.map((i) => i.id));
  // Keep local order in sync when the parent refetches (ids/length change).
  useEffect(() => { setOrder(items.map((i) => i.id)); }, [items]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const rows = useMemo(() => order.map((id) => byId.get(id)).filter(Boolean), [order, byId]);

  if (disabled) {
    return (
      <ul>
        {items.map((i) => (
          <li key={i.id}><Link to={i.to} title={i.title}>{i.content}</Link></li>
        ))}
      </ul>
    );
  }

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(active.id);
    const newIndex = order.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const prev = order;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    try {
      await apiPostJson('/beats/reorder', { ordered_ids: next });
      onReordered?.();
    } catch (e) {
      setOrder(prev); // revert optimistic move
      onError?.(`Reorder failed: ${e.message}`);
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <ul className="toc-sortable-list">
          {rows.map((i) => (
            <SortableRow key={i.id} id={i.id} to={i.to} content={i.content} title={i.title} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
```

- [ ] **Step 2: Add minimal styles**

Append to `web/src/styles.css`:

```css
.toc-sortable-list { list-style: none; padding-left: 0; }
.toc-sortable-row { display: flex; align-items: center; gap: 8px; }
.toc-drag-handle {
  cursor: grab; background: none; border: none; color: var(--fg-muted);
  padding: 2px 4px; font-size: 14px; line-height: 1; touch-action: none;
}
.toc-drag-handle:active { cursor: grabbing; }
```

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build:web`
Expected: build succeeds. No consumer yet — Task 9 wires it in.

- [ ] **Step 4: Commit**

```bash
git add web/src/widgets/SortableBeatList.jsx web/src/styles.css
git commit -m "✨ Add SortableBeatList drag-reorder widget"
```

---

### Task 9: Wire drag-reorder + live refetch into the TOC

**Files:**
- Modify: `web/src/routes/Toc.jsx`

**Interfaces:**
- Consumes: `SortableBeatList` (Task 8), `useRoomBroadcast` (Task 7), `useProject` (`web/src/project/ProjectContext.jsx`).
- Produces: the Beats / Dialog / Storyboard tabs render `SortableBeatList`; drag disabled while a filter is active; an open TOC refetches `/toc` when a `plot:<projectId>` `{changed:['beats']}` ping arrives.

- [ ] **Step 1: Add imports + refetch + live subscription**

In `web/src/routes/Toc.jsx`, add imports:

```js
import { SortableBeatList } from '../widgets/SortableBeatList.jsx';
import { useRoomBroadcast } from '../hooks/useRoomBroadcast.js';
import { useProject } from '../project/ProjectContext.jsx';
```

Refactor the initial `/toc` fetch (lines 34-45) into a reusable `refetchToc` callback and subscribe to the plot room. Add inside the component body:

```js
  const { id: projectId } = useProject();

  const refetchToc = useCallback(async () => {
    try {
      const t = await apiGet('/toc');
      setToc(t);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refetchToc(); }, [refetchToc]);

  // Live update: the server pings plot:<projectId> with {changed:['beats']}
  // whenever the beat list is reordered/renumbered (drag, or the AI agent).
  useRoomBroadcast(
    projectId ? `plot:${projectId}` : null,
    session,
    useCallback((msg) => {
      if (msg?.changed?.includes('beats')) refetchToc();
    }, [refetchToc]),
  );
```

Delete the old inline `useEffect` that fetched `/toc` (lines 34-45), since `refetchToc` replaces it.

- [ ] **Step 2: Replace the Beats tab list**

Replace the Beats `<ul>` (lines 296-307) with:

```jsx
            <SortableBeatList
              disabled={!!filter}
              onReordered={refetchToc}
              onError={setError}
              items={beats.map((b) => ({
                id: b.key,
                to: b.to,
                title: b.bodyEmpty ? 'Beat body is empty' : undefined,
                content: `${b.bodyEmpty ? '* ' : ''}${b.label}`,
              }))}
            />
```

- [ ] **Step 3: Replace the Dialog tab list**

Replace the Dialog `<ul>` (lines 321-336) with:

```jsx
            <SortableBeatList
              disabled={!!filter}
              onReordered={refetchToc}
              onError={setError}
              items={dialogBeats.map((b) => ({
                id: b.key,
                to: b.to,
                title: b.missing ? 'No dialog for this beat yet' : undefined,
                content: `${b.missing ? '* ' : ''}#${b.order} — ${b.title}${b.missing ? '' : ` (${b.count})`}`,
              }))}
            />
```

- [ ] **Step 4: Replace the Storyboard tab list**

Replace the Storyboard `<ul>` (lines 350-365) with:

```jsx
            <SortableBeatList
              disabled={!!filter}
              onReordered={refetchToc}
              onError={setError}
              items={storyboardBeats.map((b) => ({
                id: b.key,
                to: b.to,
                title: b.missing ? 'No storyboards for this beat yet' : undefined,
                content: `${b.missing ? '* ' : ''}#${b.order} — ${b.title}${b.missing ? '' : ` (${b.count})`}`,
              }))}
            />
```

- [ ] **Step 5: Verify the build compiles**

Run: `npm run build:web`
Expected: build succeeds.

- [ ] **Step 6: Manual verification (dev)**

Run `npm run dev` (Mongo up) + `npm run dev:web`, open the TOC:
- On Beats/Dialog/Storyboards tabs, drag a beat by its `⋮⋮` handle → the list reorders and numbers re-sequence after refetch.
- Type in the filter → drag handles disappear (drag disabled while filtered).
- In a second browser tab, have the AI agent (or a second window) reorder beats → the first tab's TOC refetches without reload.
Expected: all three behave as described.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/Toc.jsx
git commit -m "✨ Drag-reorder beats on TOC tabs with live renumber updates"
```

---

### Task 10: Full suite + docs

**Files:**
- Modify: `CLAUDE.md` (Room naming / lifecycle notes if warranted)

- [ ] **Step 1: Run the whole backend suite**

Run: `npm test`
Expected: PASS (the deploy gate). Investigate and fix any regressions — pay attention to older `beats.test.js` / `plot-*` tests that may have asserted pre-change order semantics.

- [ ] **Step 2: Build the SPA**

Run: `npm run build:web`
Expected: success.

- [ ] **Step 3: Note the invariant in CLAUDE.md**

Add one line to the `### MongoDB layout` beats bullet in `CLAUDE.md` noting that `beat.order` is a maintained contiguous `1..N` invariant (renumbered on create/update/delete/reorder; `order=N` means "move to position N"), and that `POST /beats/reorder` + the `reorder_beats` tool + the `plot:<projectId>` `{changed:['beats']}` broadcast keep the TOC live. Keep it to 1-2 sentences.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "📝 Document beat 1..N ordering invariant + reorder paths"
```

---

## Self-Review

**Spec coverage:**
- Sequential-`1..N` invariant → Tasks 1-3 (Mongo). ✓
- Move-to-position `order=N` semantics → Task 2 (`updateBeat`), Task 6 (agent help text). ✓
- Drag-and-drop on all three TOC tabs → Tasks 8-9. ✓
- Positional reorder endpoint mirroring `/dialogs/reorder` → Task 5. ✓
- Agent auto-renumber + `reorder_beats` tool → Task 6. ✓
- Live TOC updates via `plot:` broadcast + subscription → Tasks 4, 7, 9. ✓
- Drag disabled under active filter → Tasks 8-9. ✓

**Type consistency:** `normalizeBeatOrders`, `reorderBeats`, `reorderBeatsViaGateway`, `createBeatViaGateway`, `deleteBeatViaGateway`, `broadcastBeatsChanged`, `useRoomBroadcast`, `SortableBeatList` names/signatures are used consistently across producing and consuming tasks. `ordered_ids` (REST/wire) vs `orderedIds` (JS) vs `beat_ids` (agent tool input) are intentional and each mapped at its boundary. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓
