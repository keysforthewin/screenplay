# Attribute Web-AI Edits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post the existing 24h-throttled Discord edit notification — attributed to the requesting web user — whenever a web-driven AI feature edits a beat/character text field or a beat's cast, while the Discord bot's own edits stay silent.

**Architecture:** Introduce an `AsyncLocalStorage`-based "editor scope" (`runAsEditor`/`currentEditor`). The mutation gateway's text writes swap their hardcoded `{ actor: 'bot' }` context for a dynamic one that names the in-scope web user (`actor: 'web-user'`), which the existing `handleRoomChange` announce hook already honors. Cast-change announcing is centralized in `updateBeatViaGateway`. The chat agent sets the scope explicitly (it detaches onto a mutex); all other AI features get it from one Express middleware after `requireSession`.

**Tech Stack:** Node.js (ESM), `node:async_hooks` AsyncLocalStorage, Express, MongoDB (+ in-memory fake for tests), Hocuspocus/Yjs (production only), Vitest.

## Global Constraints

- Every project-scoped Mongo helper takes `projectId` first and throws `projectId required` on falsy — never add a default; thread the real value.
- Optional-integration pattern: return user-facing error strings, never throw, on missing API keys (not directly relevant here but don't regress).
- Tests use the in-memory fake (`tests/_fakeMongo.js`) mocked via `vi.mock('../src/mongo/client.js', ...)`; dynamic-import the module under test **after** the mock is registered; call `fakeDb.reset()` in `beforeEach`.
- Hocuspocus never runs in tests, so `isHocuspocusRunning()` is `false` and gateway text writes take the Mongo fallback path. The full onChange announce fire is therefore not exercised by unit tests — assert announce behavior only where it is reachable without Hocuspocus (the cast path and `handleRoomChange` called directly).
- No `Co-Authored-By` / attribution trailers in commits.

---

### Task 1: `editAttribution` AsyncLocalStorage module

**Files:**
- Create: `src/web/editAttribution.js`
- Test: `tests/web-edit-attribution.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `runAsEditor(name: string | null | undefined, fn: () => T): T` — runs `fn` inside an editor scope named `name`; falsy/blank `name` runs `fn` with no scope. Returns `fn`'s return value (sync value or Promise).
  - `currentEditor(): string | null` — the trimmed editor name for the current async scope, or `null`.

- [ ] **Step 1: Write the failing test**

Create `tests/web-edit-attribution.test.js`:

```js
import { describe, it, expect } from 'vitest';

const { runAsEditor, currentEditor } = await import('../src/web/editAttribution.js');

describe('editAttribution', () => {
  it('currentEditor is null outside any scope', () => {
    expect(currentEditor()).toBe(null);
  });

  it('exposes the editor name inside runAsEditor', () => {
    const seen = runAsEditor('Steve', () => currentEditor());
    expect(seen).toBe('Steve');
    expect(currentEditor()).toBe(null); // scope ends after fn returns
  });

  it('trims the name and treats blank/falsy as no scope', () => {
    expect(runAsEditor('  Ada  ', () => currentEditor())).toBe('Ada');
    expect(runAsEditor('', () => currentEditor())).toBe(null);
    expect(runAsEditor(undefined, () => currentEditor())).toBe(null);
    expect(runAsEditor(null, () => currentEditor())).toBe(null);
  });

  it('propagates the scope across awaits and returns the promise value', async () => {
    const result = await runAsEditor('Grace', async () => {
      await Promise.resolve();
      return currentEditor();
    });
    expect(result).toBe('Grace');
  });

  it('nested scopes shadow the outer one', () => {
    const out = runAsEditor('Outer', () =>
      runAsEditor('Inner', () => currentEditor()));
    expect(out).toBe('Inner');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-edit-attribution.test.js`
Expected: FAIL — `Cannot find module '../src/web/editAttribution.js'`.

- [ ] **Step 3: Write the module**

Create `src/web/editAttribution.js`:

```js
// editAttribution.js
//
// Carries the "on behalf of" web-user identity for the current async scope so
// the mutation gateway can attribute AI-driven text edits to the human who
// triggered them (instead of tagging them as the bot). Used by the chat agent
// (set explicitly — it detaches onto a mutex) and by an entityRoutes middleware
// that wraps every authenticated request.

import { AsyncLocalStorage } from 'node:async_hooks';

const editorStore = new AsyncLocalStorage();

// Run `fn` with `name` as the attributed editor. A falsy/blank name runs `fn`
// with no scope, so callers don't need to branch. Returns whatever `fn` returns
// (sync value or Promise), so it wraps both `() => next()` and `() => runAgent(...)`.
export function runAsEditor(name, fn) {
  const editor = typeof name === 'string' && name.trim() ? name.trim() : null;
  if (!editor) return fn();
  return editorStore.run({ name: editor }, fn);
}

// The attributed editor name for the current scope, or null.
export function currentEditor() {
  return editorStore.getStore()?.name ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/web-edit-attribution.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/editAttribution.js tests/web-edit-attribution.test.js
git commit -m "✨ Add editAttribution AsyncLocalStorage (runAsEditor/currentEditor)"
```

---

### Task 2: Gateway dynamic edit context (`gatewayEditContext`)

**Files:**
- Modify: `src/web/gateway.js` (add import + helper near line 142; replace the four `{ actor: 'bot' }` literals at lines 472, 500, 522, 2381)
- Test: `tests/web-edit-attribution.test.js` (add a describe block)

**Interfaces:**
- Consumes: `currentEditor()` from Task 1.
- Produces: `gatewayEditContext(): { actor: 'web-user', user: { name: string } } | { actor: 'bot' }` (exported).

- [ ] **Step 1: Write the failing test**

Append to `tests/web-edit-attribution.test.js` (the gateway import requires the Mongo client mock, so add these mocks at the **top** of the file, above the existing `editAttribution` import):

```js
// --- add these mocks at the very top of the file, before any import of gateway ---
import { vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: () => Promise.resolve() }));

const announceCalls = [];
vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: async (payload) => { announceCalls.push(payload); },
  announceText: async () => {},
}));

const Gateway = await import('../src/web/gateway.js');
```

Then add the describe block:

```js
describe('gatewayEditContext', () => {
  it('returns the bot actor outside an editor scope', () => {
    expect(Gateway.gatewayEditContext()).toEqual({ actor: 'bot' });
  });

  it('returns a web-user actor inside an editor scope', () => {
    const ctx = runAsEditor('Steve', () => Gateway.gatewayEditContext());
    expect(ctx).toEqual({ actor: 'web-user', user: { name: 'Steve' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-edit-attribution.test.js -t gatewayEditContext`
Expected: FAIL — `Gateway.gatewayEditContext is not a function`.

- [ ] **Step 3: Implement the helper and replace the literals**

In `src/web/gateway.js`, add the import alongside the other local imports (e.g. just below `import { stripMarkdown } from '../util/markdown.js';`):

```js
import { currentEditor } from './editAttribution.js';
```

Add the helper just below `getBotDisplayName()` (around line 150):

```js
// Context passed to withDirectDocument → surfaces as `context` in the Hocuspocus
// onChange announce hook (editAnnounce.handleRoomChange). When a text edit is
// performed on behalf of a logged-in web user (chat agent or any AI feature
// running inside a runAsEditor scope), attribute it to them so the edit is
// announced + throttled exactly like a manual keyboard edit. Otherwise it's a
// bot/Discord edit and stays silent (handleRoomChange skips actor === 'bot').
export function gatewayEditContext() {
  const editor = currentEditor();
  return editor ? { actor: 'web-user', user: { name: editor } } : { actor: 'bot' };
}
```

Replace each of the four occurrences of
`await withDirectDocument(roomName, { actor: 'bot' }, (document) => {`
(lines 472, 500, 522, 2381) with:
`await withDirectDocument(roomName, gatewayEditContext(), (document) => {`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web-edit-attribution.test.js`
Expected: PASS (editAttribution + gatewayEditContext blocks).

- [ ] **Step 5: Commit**

```bash
git add src/web/gateway.js tests/web-edit-attribution.test.js
git commit -m "✨ Gateway tags text edits with the in-scope web user (gatewayEditContext)"
```

---

### Task 3: Centralize cast-change announcing in the gateway

**Files:**
- Modify: `src/web/gateway.js` (`updateBeatViaGateway`, the `onlyDiscrete` block around lines 607–616; add imports)
- Modify: `src/web/entityRoutes.js` (remove the duplicated cast announce + `before` snapshot at ~1744–1763)
- Test: `tests/web-edit-attribution.test.js` (add a describe block)

**Interfaces:**
- Consumes: `currentEditor()` (Task 1); `maybeAnnounceCast`, `diffCast` from `./editAnnounce.js`; `getProjectById` from `../mongo/projects.js`.
- Produces: no new exports. Behavior: `updateBeatViaGateway` fires `maybeAnnounceCast` (fire-and-forget) when `patch.characters` changed the cast **and** `currentEditor()` is set.

- [ ] **Step 1: Write the failing test**

Append to `tests/web-edit-attribution.test.js`. Reuse the mocks already added in Task 2 (`fakeDb`, `announceCalls`, `Gateway`). Add imports for setup helpers near the other dynamic imports:

```js
import { ObjectId } from 'mongodb';
const Projects = await import('../src/mongo/projects.js');
```

Add the describe block:

```js
describe('updateBeatViaGateway cast announcement', () => {
  let projectId;
  let beatId;

  beforeEach(async () => {
    fakeDb.reset();
    announceCalls.length = 0;
    const proj = await Projects.createProject('Film');
    projectId = proj._id.toString();
    beatId = new ObjectId();
    await fakeDb.collection('plots').insertOne({
      _id: new ObjectId(),
      project_id: projectId,
      title: 'Film',
      beats: [{ _id: beatId, order: 1, name: 'Scene One', body: '', desc: '',
                characters: ['Alice'], images: [], attachments: [] }],
    });
  });

  it('announces a cast change when an editor scope is active', async () => {
    await runAsEditor('Steve', () =>
      Gateway.updateBeatViaGateway(projectId, beatId.toString(), { characters: ['Alice', 'Bob'] }));
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].username).toBe('Steve');
    expect(announceCalls[0].verb).toContain('added');
    expect(announceCalls[0].verb).toContain('Bob');
  });

  it('does NOT announce a cast change with no editor scope (bot edit)', async () => {
    await Gateway.updateBeatViaGateway(projectId, beatId.toString(), { characters: ['Alice', 'Bob'] });
    expect(announceCalls).toHaveLength(0);
  });

  it('does NOT announce when the cast is unchanged', async () => {
    await runAsEditor('Steve', () =>
      Gateway.updateBeatViaGateway(projectId, beatId.toString(), { characters: ['Alice'] }));
    expect(announceCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-edit-attribution.test.js -t "cast announcement"`
Expected: FAIL — first test gets 0 announce calls (gateway doesn't announce cast yet).

- [ ] **Step 3: Implement cast announce in the gateway**

In `src/web/gateway.js`, add imports (group with existing imports):

```js
import { getProjectById } from '../mongo/projects.js';
import { maybeAnnounceCast, diffCast } from './editAnnounce.js';
```

Note: `resolveProjectId` is already imported from `../mongo/projects.js` — add `getProjectById` to that existing import line instead of duplicating, e.g. `import { resolveProjectId, getProjectById } from '../mongo/projects.js';`.

In `updateBeatViaGateway`, replace the `onlyDiscrete` block (currently):

```js
  const onlyDiscrete = {};
  if (patch.order !== undefined) onlyDiscrete.order = patch.order;
  if (Array.isArray(patch.characters)) onlyDiscrete.characters = patch.characters;
  if (Object.keys(onlyDiscrete).length) {
    const { updateBeat: mongoUpdateBeat } = await import('../mongo/plots.js');
    await mongoUpdateBeat(projectId, beatId, onlyDiscrete);
    broadcastFieldsUpdated(buildRoomName('beat', beatId), {
      changed: Object.keys(onlyDiscrete),
    });
  }
  return getBeat(projectId, beatId);
```

with:

```js
  const onlyDiscrete = {};
  if (patch.order !== undefined) onlyDiscrete.order = patch.order;
  if (Array.isArray(patch.characters)) onlyDiscrete.characters = patch.characters;
  if (Object.keys(onlyDiscrete).length) {
    const { updateBeat: mongoUpdateBeat } = await import('../mongo/plots.js');
    await mongoUpdateBeat(projectId, beatId, onlyDiscrete);
    broadcastFieldsUpdated(buildRoomName('beat', beatId), {
      changed: Object.keys(onlyDiscrete),
    });
  }
  const after = await getBeat(projectId, beatId);
  // Attribute a cast change to the in-scope web user (chat agent / AI feature).
  // Bot/Discord edits have no editor scope and stay silent. maybeAnnounceCast is
  // fire-and-forget and applies its own 24h throttle, so we don't await it.
  if (Array.isArray(patch.characters) && currentEditor()) {
    const { added, removed } = diffCast(beat.characters || [], after.characters || []);
    if (added.length || removed.length) {
      const proj = await getProjectById(projectId).catch(() => null);
      maybeAnnounceCast({
        projectId,
        projectTitle: proj?.title ?? null,
        beat: after,
        editor: currentEditor(),
        added,
        removed,
      });
    }
  }
  return after;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web-edit-attribution.test.js`
Expected: PASS (all blocks).

- [ ] **Step 5: Remove the now-duplicated announce from the REST route**

In `src/web/entityRoutes.js`, in the `PATCH /beat/:id` handler, delete the `before` snapshot and the fire-and-forget cast block (currently lines ~1744–1763), so the handler becomes:

```js
      if (Array.isArray(characters)) patch.characters = characters;
      if (typeof order === 'number') patch.order = order;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no patch fields' });

      const result = await updateBeatViaGateway(req.projectId, beatId, patch);
      res.json({ beat: result });
```

The cast announce now happens inside `updateBeatViaGateway` (Task 5's middleware sets `currentEditor()` for this request). If `maybeAnnounceCast`, `diffCast`, or `getBeat` are no longer referenced elsewhere in `entityRoutes.js`, remove their now-unused imports (check with the grep in Step 6 before deleting — `getBeat` is used widely, so likely only `maybeAnnounceCast`/`diffCast` may become unused).

- [ ] **Step 6: Verify no orphaned imports and the suite passes**

Run:
```bash
grep -n "maybeAnnounceCast\|diffCast" src/web/entityRoutes.js
```
Expected: if no remaining usages, remove them from the import statement at the top of `entityRoutes.js`.

Run: `npm test`
Expected: PASS (full suite; existing entityRoutes/announce tests still green).

- [ ] **Step 7: Commit**

```bash
git add src/web/gateway.js src/web/entityRoutes.js tests/web-edit-attribution.test.js
git commit -m "✨ Centralize beat cast-change announcing in updateBeatViaGateway"
```

---

### Task 4: Wire the chat agent into an editor scope

**Files:**
- Modify: `src/web/chatRuns.js` (import + wrap `runAgent` at line 260)

**Interfaces:**
- Consumes: `runAsEditor` (Task 1); `gatewayEditContext`/cast announce (Tasks 2–3) react to the scope.
- Produces: no new exports.

- [ ] **Step 1: Add the import**

In `src/web/chatRuns.js`, add alongside the other `./`-relative imports (e.g. below the `chatHistory.js` import at line 34):

```js
import { runAsEditor } from './editAttribution.js';
```

- [ ] **Step 2: Wrap the runAgent call**

In `executeChatRun`, replace:

```js
    const result = await runAgent({
      history,
      userText: text,
      attachments: [],
      discordUser,
      channelId,
      enhancementNotes: enhancement.notes,
      projectId,
      projectTitle,
      webRun: true,
      pageContext,
      onEvent: (ev) => {
        if (ev?.type === 'tools') {
          for (const name of ev.tools || []) addProgress(run, `calling ${name}…`);
        }
      },
    });
```

with (wrap the whole call so every tool-driven gateway edit runs inside the scope):

```js
    const result = await runAsEditor(session?.username, () => runAgent({
      history,
      userText: text,
      attachments: [],
      discordUser,
      channelId,
      enhancementNotes: enhancement.notes,
      projectId,
      projectTitle,
      webRun: true,
      pageContext,
      onEvent: (ev) => {
        if (ev?.type === 'tools') {
          for (const name of ev.tools || []) addProgress(run, `calling ${name}…`);
        }
      },
    }));
```

- [ ] **Step 3: Verify the suite still passes**

Run: `npm test`
Expected: PASS (no chatRuns unit test exercises this; the change is a transparent wrapper. The existing chat/agent tests must stay green.)

- [ ] **Step 4: Commit**

```bash
git add src/web/chatRuns.js
git commit -m "✨ Attribute chat-agent edits to the requesting web user"
```

---

### Task 5: Attribution middleware for all other web AI features

**Files:**
- Modify: `src/web/entityRoutes.js` (add middleware immediately after `router.use(requireSession())` at line ~551; add import)

**Interfaces:**
- Consumes: `runAsEditor` (Task 1); `req.session.username` (set by `requireSession()`).
- Produces: no new exports. Effect: every authenticated `/api/*` request runs inside an editor scope, so any AI/REST feature whose gateway calls run within the request attributes its beat/character/cast edits to the user.

- [ ] **Step 1: Add the import**

In `src/web/entityRoutes.js`, add to the imports near `import { requireSession } from './auth.js';`:

```js
import { runAsEditor } from './editAttribution.js';
```

- [ ] **Step 2: Mount the middleware after requireSession**

Immediately after `router.use(requireSession());` (line ~551), add:

```js
  // Attribute every gateway text/cast edit made during an authenticated request
  // to the logged-in user, so AI-assist features (beat rewrite, restore, dialog
  // edits, etc.) announce like manual edits. Pure reads and edits to
  // non-announce-worthy rooms wrap harmlessly. The chat run sets its own scope
  // (chatRuns.js) because it detaches onto the channel mutex.
  router.use((req, _res, next) => runAsEditor(req.session?.username, () => next()));
```

- [ ] **Step 3: Verify the suite still passes**

Run: `npm test`
Expected: PASS (existing entityRoutes tests still green; the middleware is a transparent wrapper around `next()`).

- [ ] **Step 4: Commit**

```bash
git add src/web/entityRoutes.js
git commit -m "✨ Attribute all web AI-feature edits to the requesting user"
```

---

### Task 6: Lock in `handleRoomChange` web-user attribution

This task adds a regression test confirming the announce hook honors the new `actor: 'web-user'` context (and still skips `actor: 'bot'`). No production code changes — `handleRoomChange` already keys off `actor !== 'bot'` + `context.user.name`.

**Files:**
- Test: `tests/editAnnounce.integration.test.js` (add two `it` cases to the existing `handleRoomChange (beat writing edits)` describe block)

**Interfaces:**
- Consumes: existing `handleRoomChange`, `primeRoomCache`, `_resetCacheForTests` and the file's `beatRoom`/`fakeDoc`/`beatDesc` helpers.
- Produces: none.

- [ ] **Step 1: Write the tests**

In `tests/editAnnounce.integration.test.js`, inside the existing `describe('handleRoomChange (beat writing edits)', ...)`, add:

```js
  it('announces a web-user (AI-on-behalf-of) body edit', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'NEW body', desc: '' }),
      context: { actor: 'web-user', user: { name: 'Steve' } },
    });
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].username).toBe('Steve');
    expect(announceCalls[0].verb).toBe('edited the writing in');
  });

  it('still skips bot edits', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'NEW body', desc: '' }),
      context: { actor: 'bot', user: { name: 'Screenplay Bot' } },
    });
    expect(announceCalls).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/editAnnounce.integration.test.js`
Expected: PASS — the web-user case announces once; the bot case announces zero. (If the web-user case fails, that's a real signal `handleRoomChange` needs the `actor` check loosened; per the design it should already pass.)

- [ ] **Step 3: Commit**

```bash
git add tests/editAnnounce.integration.test.js
git commit -m "✅ Lock in web-user attribution in handleRoomChange"
```

---

### Task 7: Full-suite verification

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — all files green, including the new `web-edit-attribution` and the extended `editAnnounce.integration` tests.

- [ ] **Step 2: Sanity-check the wiring by grep**

Run:
```bash
grep -rn "actor: 'bot'" src/web/gateway.js   # expect: 0 hits (all replaced by gatewayEditContext())
grep -rn "gatewayEditContext()" src/web/gateway.js  # expect: 4 hits
grep -rn "runAsEditor" src/web/chatRuns.js src/web/entityRoutes.js  # expect: 1 each
```

- [ ] **Step 3: Final commit (if any stray changes)**

```bash
git status   # expect clean; nothing to commit if all tasks committed
```

---

## Self-Review

**Spec coverage:**
- Component 1 (editAttribution) → Task 1. ✓
- Component 2a (dynamic gateway context, 4 call sites) → Task 2. ✓
- Component 2b (cast announce centralized + REST dedup) → Task 3. ✓
- Component 3 (chat agent scope) → Task 4. ✓
- Component 4 (middleware for all AI features) → Task 5. ✓
- `handleRoomChange` unchanged + tested → Task 6. ✓
- Shared 24h cooldown bucket → falls out of reusing the web-session username as `editor` (Tasks 3–5) keyed identically to manual edits; no extra task needed. ✓
- "What stays unchanged" (caret/`withBotPresence`, Discord silence, throttle) → no task touches them; Discord silence verified by Task 6's bot-skip test. ✓
- Known limitation (detached media jobs) → intentionally out of scope; no task. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"write tests for the above" — every code and test step shows full content. ✓

**Type consistency:** `runAsEditor(name, fn)`/`currentEditor()` used identically in Tasks 2–5; `gatewayEditContext()` shape (`{actor:'web-user',user:{name}}` / `{actor:'bot'}`) matches what `handleRoomChange` reads (`context.actor`, `context.user.name`) in Task 6; `maybeAnnounceCast({projectId, projectTitle, beat, editor, added, removed})` matches its definition in `editAnnounce.js`; `diffCast(old, new)` returns `{added, removed}` as used. ✓
