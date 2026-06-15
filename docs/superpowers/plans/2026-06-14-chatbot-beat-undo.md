# AI Chatbot Beat Undo/Redo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add undo/redo buttons to the web AI-chat window that revert the current beat's text fields (`name`, `desc`, `body`) across a 10-deep history of chatbot edits.

**Architecture:** A pure client-side transaction-stack module tracks `{before, after}` snapshots per beat (capped at 10) in `Header` state. The `ChatDialog` snapshots the beat before each send, records a transaction when the run changes the text, and exposes Undo/Redo buttons. Restoring a snapshot calls a new `PATCH /api/beat/:id/text` endpoint, which writes through the existing gateway → CRDT path so the change propagates live to every open editor (and persists to Mongo via the gateway fallback when Hocuspocus is down).

**Tech Stack:** Node/Express (server endpoint), React (SPA UI), Vitest (tests), the existing `setEntityFieldMarkdown` gateway helper.

---

## File Structure

- **Create** `web/src/widgets/beatEditHistory.js` — pure, React-free transaction-stack logic (snapshot equality, record, undo, redo, cap at 10). One responsibility: history math.
- **Create** `tests/beat-edit-history.test.js` — unit tests for the pure module (node env, no Mongo).
- **Create** `tests/beat-text-patch-route.test.js` — endpoint test for `PATCH /api/beat/:id/text` against `tests/_fakeMongo.js`.
- **Modify** `src/web/entityRoutes.js` — add the `PATCH /beat/:id/text` route and import `setEntityFieldMarkdown`.
- **Modify** `web/src/widgets/Header.jsx` — host the per-beat history map state and pass it to `ChatDialog`.
- **Modify** `web/src/widgets/ChatDialog.jsx` — capture-before-send, record-after-done, Undo/Redo buttons; import `apiGet`/`apiPatchJson` and the history module.
- **Modify** `web/src/styles.css` — styling for the undo/redo control row.

---

## Task 1: Pure history module

**Files:**
- Create: `web/src/widgets/beatEditHistory.js`
- Test: `tests/beat-edit-history.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/beat-edit-history.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  MAX_HISTORY,
  emptyHistory,
  snapshotsEqual,
  recordEdit,
  undo,
  redo,
  canUndo,
  canRedo,
} from '../web/src/widgets/beatEditHistory.js';

const snap = (name, desc, body) => ({ name, desc, body });

describe('beatEditHistory', () => {
  it('emptyHistory has empty stacks and no undo/redo', () => {
    const h = emptyHistory();
    expect(h.undo).toEqual([]);
    expect(h.redo).toEqual([]);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('snapshotsEqual compares all three fields', () => {
    expect(snapshotsEqual(snap('a', 'b', 'c'), snap('a', 'b', 'c'))).toBe(true);
    expect(snapshotsEqual(snap('a', 'b', 'c'), snap('a', 'b', 'X'))).toBe(false);
  });

  it('recordEdit pushes a transaction and clears redo', () => {
    let h = emptyHistory();
    h = recordEdit(h, snap('a', '', ''), snap('b', '', ''));
    expect(h.undo).toHaveLength(1);
    expect(h.undo[0]).toEqual({ before: snap('a', '', ''), after: snap('b', '', '') });
    expect(h.redo).toEqual([]);
    expect(canUndo(h)).toBe(true);
  });

  it('recordEdit ignores no-op edits (before === after)', () => {
    let h = emptyHistory();
    h = recordEdit(h, snap('a', '', ''), snap('a', '', ''));
    expect(h.undo).toHaveLength(0);
  });

  it('recordEdit caps the undo stack at MAX_HISTORY, dropping the oldest', () => {
    let h = emptyHistory();
    for (let i = 0; i < MAX_HISTORY + 3; i++) {
      h = recordEdit(h, snap(`v${i}`, '', ''), snap(`v${i + 1}`, '', ''));
    }
    expect(h.undo).toHaveLength(MAX_HISTORY);
    // Oldest surviving transaction is the 4th one recorded (index 3).
    expect(h.undo[0].before).toEqual(snap('v3', '', ''));
  });

  it('undo returns the before-snapshot and moves the txn to redo', () => {
    let h = recordEdit(emptyHistory(), snap('a', '', ''), snap('b', '', ''));
    const r = undo(h);
    expect(r.snapshot).toEqual(snap('a', '', ''));
    expect(r.history.undo).toHaveLength(0);
    expect(r.history.redo).toHaveLength(1);
    expect(canRedo(r.history)).toBe(true);
  });

  it('undo on empty history returns null snapshot and unchanged history', () => {
    const h = emptyHistory();
    const r = undo(h);
    expect(r.snapshot).toBe(null);
    expect(r.history).toBe(h);
  });

  it('redo returns the after-snapshot and moves the txn back to undo', () => {
    let h = recordEdit(emptyHistory(), snap('a', '', ''), snap('b', '', ''));
    const afterUndo = undo(h).history;
    const r = redo(afterUndo);
    expect(r.snapshot).toEqual(snap('b', '', ''));
    expect(r.history.redo).toHaveLength(0);
    expect(r.history.undo).toHaveLength(1);
  });

  it('redo on empty redo stack returns null snapshot', () => {
    const h = recordEdit(emptyHistory(), snap('a', '', ''), snap('b', '', ''));
    const r = redo(h);
    expect(r.snapshot).toBe(null);
    expect(r.history).toBe(h);
  });

  it('back-and-forth across several edits stays consistent', () => {
    let h = emptyHistory();
    h = recordEdit(h, snap('a', '', ''), snap('b', '', ''));
    h = recordEdit(h, snap('b', '', ''), snap('c', '', ''));
    const u1 = undo(h); // -> b
    expect(u1.snapshot).toEqual(snap('b', '', ''));
    const u2 = undo(u1.history); // -> a
    expect(u2.snapshot).toEqual(snap('a', '', ''));
    const r1 = redo(u2.history); // -> b
    expect(r1.snapshot).toEqual(snap('b', '', ''));
    const r2 = redo(r1.history); // -> c
    expect(r2.snapshot).toEqual(snap('c', '', ''));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/beat-edit-history.test.js`
Expected: FAIL — `Failed to resolve import "../web/src/widgets/beatEditHistory.js"`.

- [ ] **Step 3: Write the module**

Create `web/src/widgets/beatEditHistory.js`:

```js
// Pure, React-free undo/redo history for a single beat's text fields.
// A "snapshot" is { name, desc, body } (markdown strings). A "transaction" is
// { before, after } — the beat text immediately before and after one chatbot
// edit. History = { undo: Transaction[], redo: Transaction[] }.
//
// Undo applies a transaction's `before` and moves it to the redo stack; redo
// applies `after` and moves it back. The undo stack is capped at MAX_HISTORY
// (the "ten change window"); the oldest transaction is dropped past the cap.
// Kept free of React so it is unit-testable in the node test runner.

export const MAX_HISTORY = 10;

export function emptyHistory() {
  return { undo: [], redo: [] };
}

export function snapshotsEqual(a, b) {
  if (!a || !b) return false;
  return a.name === b.name && a.desc === b.desc && a.body === b.body;
}

function capped(stack) {
  const next = stack.slice();
  while (next.length > MAX_HISTORY) next.shift();
  return next;
}

// Record a completed edit. No-op edits (before === after) are ignored so the
// history only ever holds real changes. Recording clears the redo stack.
export function recordEdit(history, before, after) {
  if (snapshotsEqual(before, after)) return history;
  return {
    undo: capped([...history.undo, { before, after }]),
    redo: [],
  };
}

// Returns { history, snapshot }. `snapshot` is the text to apply (the `before`
// of the most recent transaction), or null if there is nothing to undo.
export function undo(history) {
  if (!history.undo.length) return { history, snapshot: null };
  const undoStack = history.undo.slice();
  const tx = undoStack.pop();
  return {
    history: { undo: undoStack, redo: [...history.redo, tx] },
    snapshot: tx.before,
  };
}

// Returns { history, snapshot }. `snapshot` is the text to re-apply (the
// `after` of the most recently undone transaction), or null if nothing to redo.
export function redo(history) {
  if (!history.redo.length) return { history, snapshot: null };
  const redoStack = history.redo.slice();
  const tx = redoStack.pop();
  return {
    history: { undo: capped([...history.undo, tx]), redo: redoStack },
    snapshot: tx.after,
  };
}

export function canUndo(history) {
  return history.undo.length > 0;
}

export function canRedo(history) {
  return history.redo.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/beat-edit-history.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/widgets/beatEditHistory.js tests/beat-edit-history.test.js
git commit -m "✨ Add pure undo/redo history module for beat text edits"
```

---

## Task 2: Server endpoint `PATCH /api/beat/:id/text`

**Files:**
- Modify: `src/web/entityRoutes.js` (add to the gateway import block ending at the `} from './gateway.js';` near line 116; add route after the existing `PATCH /beat/:id` at ~line 1566-1580)
- Test: `tests/beat-text-patch-route.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/beat-text-patch-route.test.js`:

```js
// Tests for PATCH /api/beat/:id/text — the endpoint the AI-chat undo/redo
// buttons call to restore a beat's text fields. With Hocuspocus not running
// (as in tests), the gateway falls back to writing Mongo directly.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
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
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(),
  announceCharacterMedia: vi.fn(),
  announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(),
  announceLibraryMedia: vi.fn(),
  announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function patch(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('PATCH /api/beat/:id/text', () => {
  it('restores all three text fields and persists to Mongo', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Old', desc: 'old d', body: 'old b' });
    const { status, json } = await patch(`/api/beat/${beat._id}/text`, {
      name: 'New name',
      desc: 'New desc',
      body: 'New body',
    });
    expect(status).toBe(200);
    expect(json.beat.name).toBe('New name');
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.name).toBe('New name');
    expect(fresh.desc).toBe('New desc');
    expect(fresh.body).toBe('New body');
  });

  it('accepts a partial patch (body only) without touching other fields', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Keep', desc: 'keep d', body: 'old b' });
    const { status } = await patch(`/api/beat/${beat._id}/text`, { body: 'just body' });
    expect(status).toBe(200);
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.name).toBe('Keep');
    expect(fresh.desc).toBe('keep d');
    expect(fresh.body).toBe('just body');
  });

  it('resolves a beat by order number in the URL', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Ordered', body: 'b' });
    const order = beat.order;
    const { status } = await patch(`/api/beat/${order}/text`, { name: 'By order' });
    expect(status).toBe(200);
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.name).toBe('By order');
  });

  it('returns 400 when no text fields are provided', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'X', body: 'b' });
    const { status, json } = await patch(`/api/beat/${beat._id}/text`, { foo: 'bar' });
    expect(status).toBe(400);
    expect(json.error).toMatch(/no text fields/);
  });

  it('returns 404 for an unknown beat', async () => {
    const { status } = await patch(`/api/beat/999/text`, { name: 'nope' });
    expect(status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/beat-text-patch-route.test.js`
Expected: FAIL — the 200 assertions fail (route not found yields 404, or method-not-allowed), because `PATCH /beat/:id/text` does not exist yet.

- [ ] **Step 3: Add the gateway import**

In `src/web/entityRoutes.js`, the import block that ends with `} from './gateway.js';` (the one containing `updateBeatViaGateway`, around line 116) — add `setEntityFieldMarkdown,` to it. For example change:

```js
  updateBeatViaGateway,
  updateStoryboardScalarsViaGateway,
} from './gateway.js';
```

to:

```js
  setEntityFieldMarkdown,
  updateBeatViaGateway,
  updateStoryboardScalarsViaGateway,
} from './gateway.js';
```

- [ ] **Step 4: Add the route**

In `src/web/entityRoutes.js`, immediately after the existing `router.patch('/beat/:id', ...)` handler (the one that ends around line 1580), add:

```js
  // Restore a beat's text fields to a prior snapshot. Used by the AI-chat
  // undo/redo controls. Each field is written through the gateway so the change
  // applies as a CRDT op to any open editor (and falls back to a direct Mongo
  // write when Hocuspocus isn't running). Always overwrites current text — no
  // concurrent-edit guard (see the design spec).
  router.patch('/beat/:id/text', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { name, desc, body } = req.body || {};
      const fields = [];
      if (typeof name === 'string') fields.push(['name', name]);
      if (typeof desc === 'string') fields.push(['desc', desc]);
      if (typeof body === 'string') fields.push(['body', body]);
      if (!fields.length) return res.status(400).json({ error: 'no text fields' });
      for (const [field, markdown] of fields) {
        await setEntityFieldMarkdown({
          projectId: req.projectId,
          entityType: 'beat',
          entityId: beatId,
          field,
          markdown,
        });
      }
      const beat = await getBeat(req.projectId, beatId);
      res.json({ beat });
    } catch (e) {
      next(e);
    }
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/beat-text-patch-route.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the schema/parity guard to confirm nothing else broke**

Run: `npx vitest run tests/beat-text-patch-route.test.js tests/beat-character-images-endpoint.test.js`
Expected: PASS (both files).

- [ ] **Step 7: Commit**

```bash
git add src/web/entityRoutes.js tests/beat-text-patch-route.test.js
git commit -m "✨ Add PATCH /api/beat/:id/text endpoint for chat undo/redo"
```

---

## Task 3: Host per-beat history in Header

**Files:**
- Modify: `web/src/widgets/Header.jsx`

History must live above `ChatDialog` because the dialog's `Modal` unmounts when closed; keeping the map in `Header` lets undo/redo history survive closing and reopening the chat (matching how `chatMessages` already persists there).

- [ ] **Step 1: Add the history state and pass it down**

In `web/src/widgets/Header.jsx`, add a state hook beside the existing `chatMessages` state:

```js
  const [chatMessages, setChatMessages] = useState([]);
  const [beatHistories, setBeatHistories] = useState({});
```

Then pass the two new props to `<ChatDialog>`:

```js
      <ChatDialog
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        messages={chatMessages}
        setMessages={setChatMessages}
        beatHistories={beatHistories}
        setBeatHistories={setBeatHistories}
      />
```

- [ ] **Step 2: Verify the SPA still builds**

Run: `npm run build:web`
Expected: build succeeds with no errors (the new props are unused until Task 4, which is fine).

- [ ] **Step 3: Commit**

```bash
git add web/src/widgets/Header.jsx
git commit -m "✨ Host per-beat chat edit history in Header"
```

---

## Task 4: Wire capture/record + Undo/Redo buttons into ChatDialog

**Files:**
- Modify: `web/src/widgets/ChatDialog.jsx`

- [ ] **Step 1: Extend the imports**

At the top of `web/src/widgets/ChatDialog.jsx`, change the api import and add the history-module import:

```js
import { apiPostJson, apiSseUrl } from '../api.js';
```

to:

```js
import { apiGet, apiPatchJson, apiPostJson, apiSseUrl } from '../api.js';
import {
  emptyHistory,
  recordEdit,
  undo as undoHistory,
  redo as redoHistory,
  canUndo,
  canRedo,
} from './beatEditHistory.js';
```

- [ ] **Step 2: Accept the new props and add restore state**

Change the component signature:

```js
export function ChatDialog({ open, onClose, messages, setMessages }) {
```

to:

```js
export function ChatDialog({ open, onClose, messages, setMessages, beatHistories, setBeatHistories }) {
```

Add restore state beside the existing `useState` hooks (after `const [error, setError] = useState(null);`):

```js
  const [restoring, setRestoring] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState(null);
```

- [ ] **Step 3: Add the beat-text helpers**

Inside the component, after the `finishStream` function, add:

```js
  const beatRef = pageCtx.kind === 'beat' ? pageCtx.ref : null;
  const history = (beatRef && beatHistories[beatRef]) || emptyHistory();

  async function fetchBeatText(ref) {
    try {
      const { beat } = await apiGet(`/beat?id=${encodeURIComponent(ref)}`);
      if (!beat) return null;
      return {
        name: beat.name || '',
        desc: beat.desc || '',
        body: beat.body || '',
      };
    } catch {
      return null;
    }
  }

  async function recordBeatEdit(ref, before) {
    if (!ref || !before) return;
    const after = await fetchBeatText(ref);
    if (!after) return;
    setBeatHistories((prev) => ({
      ...prev,
      [ref]: recordEdit(prev[ref] || emptyHistory(), before, after),
    }));
  }

  async function applyRestore(ref, snapshot, nextHistory) {
    setRestoring(true);
    setError(null);
    setRestoreStatus(null);
    try {
      await apiPatchJson(`/beat/${encodeURIComponent(ref)}/text`, snapshot);
      setBeatHistories((prev) => ({ ...prev, [ref]: nextHistory }));
      setRestoreStatus('Reverted beat text');
    } catch (e) {
      setError(e.message || 'Failed to restore beat text.');
    } finally {
      setRestoring(false);
    }
  }

  function onUndo() {
    if (!beatRef) return;
    const { history: next, snapshot } = undoHistory(beatHistories[beatRef] || emptyHistory());
    if (snapshot) applyRestore(beatRef, snapshot, next);
  }

  function onRedo() {
    if (!beatRef) return;
    const { history: next, snapshot } = redoHistory(beatHistories[beatRef] || emptyHistory());
    if (snapshot) applyRestore(beatRef, snapshot, next);
  }
```

Note: `onUndo`/`onRedo` read the current `beatHistories[beatRef]` synchronously. This dialog is the only writer of a beat's history, so there is no real race; keeping it simple and synchronous is intentional.

- [ ] **Step 4: Capture the before-snapshot on send and record after done**

In `send()`, capture the beat text before opening the EventSource. Change the start of the `try` block:

```js
    try {
      const r = await apiPostJson('/chat', { text, context: { kind: pageCtx.kind, ref: pageCtx.ref } });
      const runId = r?.run_id;
      if (!runId) throw new Error('Server did not return a run id.');
```

to:

```js
    try {
      const captureRef = pageCtx.kind === 'beat' ? pageCtx.ref : null;
      const before = captureRef ? await fetchBeatText(captureRef) : null;
      const r = await apiPostJson('/chat', { text, context: { kind: pageCtx.kind, ref: pageCtx.ref } });
      const runId = r?.run_id;
      if (!runId) throw new Error('Server did not return a run id.');
```

Then, in the `applySnapshot` function, add the record call in the `done` branch:

```js
        if (snap.status === 'done') {
          patchPending({
            pending: false,
            text: snap.text,
            attachments: snap.attachments || [],
            interpreted: snap.interpreted,
          });
          if (captureRef && before) recordBeatEdit(captureRef, before);
          finishStream();
        } else if (snap.status === 'error') {
```

- [ ] **Step 5: Add the Undo/Redo control row to the UI**

In the returned JSX, between the `chat-context-chip` div and the `chat-input-row` div, insert:

```jsx
        <div className="chat-history-row">
          <button
            type="button"
            className="chat-history-btn"
            onClick={onUndo}
            disabled={busy || restoring || !beatRef || !canUndo(history)}
            title={beatRef ? 'Undo the last AI edit to this beat' : 'Open a beat page to undo AI edits'}
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="chat-history-btn"
            onClick={onRedo}
            disabled={busy || restoring || !beatRef || !canRedo(history)}
            title={beatRef ? 'Redo the last undone AI edit' : 'Open a beat page to redo AI edits'}
          >
            ↷ Redo
          </button>
          {restoreStatus && <span className="chat-history-status">{restoreStatus}</span>}
        </div>
```

- [ ] **Step 6: Verify the SPA builds**

Run: `npm run build:web`
Expected: build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/widgets/ChatDialog.jsx
git commit -m "✨ Add undo/redo buttons for beat edits to AI chat dialog"
```

---

## Task 5: Style the control row

**Files:**
- Modify: `web/src/styles.css`

- [ ] **Step 1: Add styles**

Append to `web/src/styles.css` (place near the other `.chat-*` rules if present; otherwise at end of file):

```css
.chat-history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 6px;
}

.chat-history-btn {
  font-size: 0.85rem;
  padding: 2px 10px;
  cursor: pointer;
}

.chat-history-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.chat-history-status {
  font-size: 0.8rem;
  color: var(--muted, #888);
}
```

- [ ] **Step 2: Verify the SPA builds**

Run: `npm run build:web`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/styles.css
git commit -m "🎨 Style the AI chat undo/redo control row"
```

---

## Task 6: Full suite + manual verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — including the two new files (`beat-edit-history`, `beat-text-patch-route`). No previously-passing test regresses.

- [ ] **Step 2: Manual smoke test (documented, not automated)**

The UI wiring (Header/ChatDialog) has no automated coverage — the repo has no React component test harness — so verify by hand:

1. `npm run dev:web` (plus the Express server via `npm run dev`).
2. Open a beat page (`/p/<title>/beat/1`), open **✨ AI chat**.
3. Ask the agent to change the beat (e.g. "rewrite the body"). Confirm the beat text updates live.
4. Click **↶ Undo** — the beat text reverts to its pre-edit state; status shows "Reverted beat text".
5. Click **↷ Redo** — the AI's edit comes back.
6. Make 11+ edits; confirm Undo only walks back 10.
7. Navigate to a non-beat page (e.g. About) — confirm both buttons are disabled.

- [ ] **Step 3: Final confirmation**

Confirm `npm test` output shows all green and the manual steps pass before considering the feature complete.

---

## Self-Review Notes

- **Spec coverage:** scope (beat text only) → Task 2 route + Task 4 capture; transaction stack capped at 10 → Task 1; record-after-done / undo / redo semantics → Task 1 + Task 4; restore via gateway CRDT path → Task 2; in-memory per-beat session history → Task 3 (Header) + Task 4; concurrent edits overwrite (no guard) → Task 2 route comment; UI in chat footer → Task 4/5; testing (reducer unit + endpoint) → Task 1/2; manual UI check → Task 6.
- **Type consistency:** snapshot shape `{name, desc, body}` and history shape `{undo, redo}` are used identically across Tasks 1, 2, and 4. `undo`/`redo` are imported aliased as `undoHistory`/`redoHistory` in ChatDialog to avoid shadowing.
- **No placeholders:** every code step contains complete code and exact commands.
