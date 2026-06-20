# SPA Chat: Isolated History, Clear, Token Count, Fullscreen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the in-browser AI chat its own persisted, per-username+project conversation thread with a clear button, a live token-count readout, and a fullscreen layout with a close button.

**Architecture:** The web chat already routes every turn through a `channelId`-keyed pipeline that hardcodes the shared Discord channel. Swapping that to a synthetic `web:<projectId>:<username>` channel id isolates history per user+project with no schema change. A new `src/web/chatHistory.js` module owns the channel-id helper, display-transcript reconstruction, and token-stat computation; two new REST routes expose history-load and clear; `ChatDialog.jsx` goes fullscreen with a toolbar (token readout + Clear + Close) and loads persisted history on open.

**Tech Stack:** Node + Express (backend), MongoDB (via in-process helpers + in-memory fake for tests), Vitest, React + Vite (SPA), Yjs/Tiptap unaffected.

## Global Constraints

- Every project-scoped Mongo helper takes `projectId` first and throws `projectId required` on falsy — never re-add a default. (Not directly hit here, but keep when touching helpers.)
- Synthetic web channel id format is exactly: `web:<projectId>:<username>` (projectId = 24-hex string, username = `session.username` trimmed, falling back to `web visitor`).
- Clear is **non-destructive**: it sets the existing `history_cleared_at` watermark in `channel_state`; it never deletes message rows.
- Token readout shows **both**: primary estimated history size (live) and secondary actual last-request `input_tokens`.
- Reuse existing helpers — `loadHistoryForLlm`, `estimateMessageTokens`, `getHistoryClearedAt`/`setHistoryClearedAt`, `recordAnthropicTextUsage` — do not duplicate them.
- Tests use the in-memory fake (`tests/_fakeMongo.js`) mocked into `../src/mongo/client.js`; dynamic-import modules after the mock is registered; call `fakeDb.reset()` in `beforeEach`.
- Commit after each task. Run the full suite with `npm test` (or a single file with `npx vitest run tests/<file>`).

---

### Task 1: `chatHistory.js` — synthetic channel id + display-transcript reconstruction

Pure, dependency-free helpers, unit-tested in isolation. No DB access in this task.

**Files:**
- Create: `src/web/chatHistory.js`
- Test: `tests/web-chat-history.test.js`

**Interfaces:**
- Produces:
  - `webChannelId(projectId: string, username?: string): string` → `web:<projectId>:<username|'web visitor'>`
  - `reconstructDisplayTranscript(docs: Array<{role, content}>): Array<{role:'user'|'assistant', text:string}>` — keeps user/assistant **text** only; drops tool_use/tool_result blocks and empty turns.

- [ ] **Step 1: Write the failing test**

Create `tests/web-chat-history.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { webChannelId, reconstructDisplayTranscript } from '../src/web/chatHistory.js';

describe('webChannelId', () => {
  it('builds a per-project, per-username channel id', () => {
    expect(webChannelId('abc123', 'Steve')).toBe('web:abc123:Steve');
  });
  it('falls back to "web visitor" and trims', () => {
    expect(webChannelId('abc123', '  ')).toBe('web:abc123:web visitor');
    expect(webChannelId('abc123', undefined)).toBe('web:abc123:web visitor');
    expect(webChannelId('abc123', '  Ann ')).toBe('web:abc123:Ann');
  });
  it('isolates different usernames and different projects', () => {
    expect(webChannelId('p1', 'a')).not.toBe(webChannelId('p1', 'b'));
    expect(webChannelId('p1', 'a')).not.toBe(webChannelId('p2', 'a'));
  });
});

describe('reconstructDisplayTranscript', () => {
  it('keeps plain user + assistant text, drops tool plumbing and empties', () => {
    const docs = [
      { role: 'user', content: 'add a beat' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 't1', name: 'create_beat', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done — added beat 3.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'x', input: {} }] },
    ];
    expect(reconstructDisplayTranscript(docs)).toEqual([
      { role: 'user', text: 'add a beat' },
      { role: 'assistant', text: 'On it.' },
      { role: 'assistant', text: 'Done — added beat 3.' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-chat-history.test.js`
Expected: FAIL — `Failed to resolve import "../src/web/chatHistory.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/chatHistory.js`:

```js
// Per-username+project isolation and display-history reconstruction for the
// SPA AI chat. The web chat keys its conversation off a synthetic channel id
// (web:<projectId>:<username>) so each logged-in user gets their own thread,
// separate from Discord (config.discord.movieChannelId) and from other users.

export function webChannelId(projectId, username) {
  const user = (typeof username === 'string' ? username.trim() : '') || 'web visitor';
  return `web:${projectId}:${user}`;
}

// Turn raw stored message docs into a lightweight display transcript: user and
// assistant *text* only. Tool_use / tool_result blocks and empty turns are
// dropped — the dialog shows the human-readable conversation, not plumbing.
function textFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

export function reconstructDisplayTranscript(docs) {
  const out = [];
  for (const doc of docs || []) {
    if (doc.role !== 'user' && doc.role !== 'assistant') continue;
    const text = textFromContent(doc.content);
    if (text) out.push({ role: doc.role, text });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/web-chat-history.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/web/chatHistory.js tests/web-chat-history.test.js
git commit -m "✨ Add web chat channel-id + display-transcript helpers"
```

---

### Task 2: Token-stat readers + `computeHistoryStats` / `loadWebDisplayHistory`

Add the DB-touching readers and wire them into `chatHistory.js`.

**Files:**
- Modify: `src/mongo/tokenUsage.js` (add `getLastAnthropicInputTokens`)
- Modify: `src/mongo/messages.js` (add `loadChannelMessagesSince`)
- Modify: `src/web/chatHistory.js` (add `loadWebDisplayHistory`, `computeHistoryStats`)
- Test: `tests/web-chat-history.test.js` (extend)

**Interfaces:**
- Consumes: `getHistoryClearedAt` (`src/mongo/channelState.js`), `loadHistoryForLlm` + `HISTORY_LIMIT` (`src/mongo/messages.js`), `estimateMessageTokens` (`src/agent/historyTrim.js`), `config.trim.historyWindowMs` (`src/config.js`).
- Produces:
  - `getLastAnthropicInputTokens(channelId: string): Promise<number|null>`
  - `loadChannelMessagesSince(channelId, { since?: Date|null, limit?: number }): Promise<Array<doc>>` (ascending by `created_at`)
  - `loadWebDisplayHistory(channelId: string): Promise<Array<{role,text}>>`
  - `computeHistoryStats(channelId: string): Promise<{ estimated_tokens: number, last_input_tokens: number|null }>`

- [ ] **Step 1: Write the failing test**

Append to `tests/web-chat-history.test.js`. Add the fake-mongo mock at the **top** of the file (above the existing imports it already has — the pure tests don't use the DB, but these do):

```js
// --- add near the top of the file, before existing imports ---
import { vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
```

```js
// --- add as a new describe block; dynamic-import after the mock above ---
const { recordUserMessage, recordAgentTurns } = await import('../src/mongo/messages.js');
const { setHistoryClearedAt } = await import('../src/mongo/channelState.js');
const { loadWebDisplayHistory, computeHistoryStats } = await import('../src/web/chatHistory.js');
const { getLastAnthropicInputTokens } = await import('../src/mongo/tokenUsage.js');

const PID = 'p'.repeat(24);
const CH = 'web:' + PID + ':tester';

async function seedThread() {
  await recordUserMessage({
    projectId: PID,
    msg: { channelId: CH, guildId: null, thread: null, id: null,
      author: { id: 'web:tester', tag: 'web:tester', bot: false }, createdAt: new Date() },
    text: 'add a beat', attachments: [], displayName: 'tester',
  });
  await recordAgentTurns({
    projectId: PID, channelId: CH,
    turns: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
  });
}

describe('chatHistory DB helpers', () => {
  beforeEach(() => fakeDb.reset());

  it('loadWebDisplayHistory returns the reconstructed transcript', async () => {
    await seedThread();
    const msgs = await loadWebDisplayHistory(CH);
    expect(msgs).toEqual([
      { role: 'user', text: 'add a beat' },
      { role: 'assistant', text: 'Done.' },
    ]);
  });

  it('respects the clear watermark', async () => {
    await seedThread();
    await setHistoryClearedAt(CH, new Date(Date.now() + 1000));
    expect(await loadWebDisplayHistory(CH)).toEqual([]);
  });

  it('computeHistoryStats estimates tokens and reads last input tokens', async () => {
    await seedThread();
    await fakeDb.collection('token_usage').insertOne({
      kind: 'anthropic_text', channel_id: CH, meta: { input_tokens: 4242 },
      created_at: new Date(),
    });
    const stats = await computeHistoryStats(CH);
    expect(stats.estimated_tokens).toBeGreaterThan(0);
    expect(stats.last_input_tokens).toBe(4242);
  });

  it('getLastAnthropicInputTokens picks the newest row, null when none', async () => {
    expect(await getLastAnthropicInputTokens(CH)).toBeNull();
    await fakeDb.collection('token_usage').insertOne({
      kind: 'anthropic_text', channel_id: CH, meta: { input_tokens: 10 },
      created_at: new Date(1000),
    });
    await fakeDb.collection('token_usage').insertOne({
      kind: 'anthropic_text', channel_id: CH, meta: { input_tokens: 99 },
      created_at: new Date(2000),
    });
    expect(await getLastAnthropicInputTokens(CH)).toBe(99);
  });
});
```

Add `import { describe, it, expect, beforeEach } from 'vitest';` at the top if not already importing `beforeEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-chat-history.test.js`
Expected: FAIL — `loadWebDisplayHistory`/`computeHistoryStats`/`getLastAnthropicInputTokens` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/mongo/tokenUsage.js`, add (the `col` helper and `KIND_ANTHROPIC_TEXT` already exist at the top of the file):

```js
export async function getLastAnthropicInputTokens(channelId) {
  if (!channelId) return null;
  const docs = await col()
    .find({ kind: KIND_ANTHROPIC_TEXT, channel_id: channelId })
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();
  const v = docs[0]?.meta?.input_tokens;
  return Number.isFinite(v) ? v : null;
}
```

In `src/mongo/messages.js`, add (`col` and `HISTORY_LIMIT` already exist):

```js
// Raw stored docs for a channel since an optional watermark, oldest first.
// Used by the SPA chat to rebuild its visible transcript on open.
export async function loadChannelMessagesSince(channelId, { since = null, limit = HISTORY_LIMIT } = {}) {
  const query = { channel_id: channelId };
  if (since instanceof Date) query.created_at = { $gt: since };
  const docs = await col()
    .find(query)
    .sort({ created_at: -1, _id: -1 })
    .limit(limit)
    .toArray();
  docs.reverse();
  return docs;
}
```

In `src/web/chatHistory.js`, add the imports and two functions:

```js
import { config } from '../config.js';
import { getHistoryClearedAt } from '../mongo/channelState.js';
import { loadHistoryForLlm, loadChannelMessagesSince } from '../mongo/messages.js';
import { estimateMessageTokens } from '../agent/historyTrim.js';
import { getLastAnthropicInputTokens } from '../mongo/tokenUsage.js';

export async function loadWebDisplayHistory(channelId) {
  const clearedAt = await getHistoryClearedAt(channelId);
  const docs = await loadChannelMessagesSince(channelId, { since: clearedAt });
  return reconstructDisplayTranscript(docs);
}

// Estimated size of the history actually sent to the model (post-watermark,
// HISTORY_LIMIT window) plus the real input_tokens of the most recent request.
export async function computeHistoryStats(channelId) {
  const clearedAt = await getHistoryClearedAt(channelId);
  const history = await loadHistoryForLlm(channelId, {
    maxAgeMs: config.trim.historyWindowMs,
    since: clearedAt,
  });
  const estimated_tokens = history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const last_input_tokens = await getLastAnthropicInputTokens(channelId);
  return { estimated_tokens, last_input_tokens };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/web-chat-history.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/mongo/tokenUsage.js src/mongo/messages.js src/web/chatHistory.js tests/web-chat-history.test.js
git commit -m "✨ Add web-chat history load + token-stat helpers"
```

---

### Task 3: Rewire `chatRuns.js` to the synthetic channel + attach token stats on done

**Files:**
- Modify: `src/web/chatRuns.js`
- Test: `tests/web-chat-route.test.js` (update existing channel assertions)

**Interfaces:**
- Consumes: `webChannelId`, `computeHistoryStats` (`src/web/chatHistory.js`).
- Produces: web runs persist under `web:<projectId>:<username>`; `serializeChatRun` gains `estimated_tokens` and `last_input_tokens`.

- [ ] **Step 1: Update the existing failing test**

In `tests/web-chat-route.test.js`, the shared-channel assertions must become synthetic-channel assertions. Replace the body of the first test (`'starts a run scoped to the browser project and records the shared transcript'`) assertions about channel id:

Change:
```js
    expect(args.channelId).toBe(config.discord.movieChannelId);
```
to:
```js
    expect(args.channelId).toBe(`web:${pid}:tester`);
```

Change:
```js
    expect(user.channel_id).toBe(config.discord.movieChannelId);
```
to:
```js
    expect(user.channel_id).toBe(`web:${pid}:tester`);
```

In the test `'records an apology to the shared transcript when the agent fails'`, change:
```js
    expect(assistant.channel_id).toBe(config.discord.movieChannelId);
```
to:
```js
    expect(assistant.channel_id).toBe(`web:${pid}:tester`);
```

Add one new assertion at the end of the first test to lock in the token stats on the run:
```js
    expect(typeof run.estimated_tokens).toBe('number');
    expect(run.estimated_tokens).toBeGreaterThan(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-chat-route.test.js`
Expected: FAIL — channel id still `movieChannelId`; `run.estimated_tokens` undefined.

- [ ] **Step 3: Write the implementation**

In `src/web/chatRuns.js`:

Add to imports:
```js
import { webChannelId, computeHistoryStats } from './chatHistory.js';
```

In `serializeChatRun` (the returned object), add two fields:
```js
    finished_at: run.finished_at,
    estimated_tokens: run.estimated_tokens ?? null,
    last_input_tokens: run.last_input_tokens ?? null,
```

In `startChatRun`, replace:
```js
  const channelId = config.discord.movieChannelId;
```
with:
```js
  const channelId = webChannelId(projectId, session?.username);
```

In the `run` object literal in `startChatRun`, add the two stat fields so they serialize from the first snapshot:
```js
    finished_at: null,
    estimated_tokens: null,
    last_input_tokens: null,
```

In `executeChatRun`, after the successful `recordAgentTurns` block and before `run.text = ...`, populate the stats (best-effort; never fail the run on a stats error):
```js
    try {
      const stats = await computeHistoryStats(channelId);
      run.estimated_tokens = stats.estimated_tokens;
      run.last_input_tokens = stats.last_input_tokens;
    } catch (e) {
      logger.warn(`chat run: history stats failed: ${e.message}`);
    }
```

Update the file's top-of-file comment block: replace the sentence "Web and Discord share one conversation (channel_id = movieChannelId in the messages collection), so runs serialize through the same channelMutex the Discord handler uses." with:
```
// Each web user gets an isolated conversation keyed by a synthetic channel id
// (web:<projectId>:<username>, see chatHistory.js), separate from Discord and
// from other users. Runs for the same user+project serialize through the
// channelMutex on that synthetic id; different users never block each other.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web-chat-route.test.js tests/web-chat-history.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/chatRuns.js tests/web-chat-route.test.js
git commit -m "✨ Isolate web chat per username+project and report history token stats"
```

---

### Task 4: `GET /api/chat/history` + `POST /api/chat/clear` routes

**Files:**
- Modify: `src/web/entityRoutes.js`
- Test: `tests/web-chat-route.test.js` (add a new describe block)

**Interfaces:**
- Consumes: `webChannelId`, `loadWebDisplayHistory`, `computeHistoryStats` (`src/web/chatHistory.js`), `setHistoryClearedAt` (`src/mongo/channelState.js`), `req.projectId`, `req.session.username`.
- Produces:
  - `GET /api/chat/history` → `{ messages: [{role,text}], estimated_tokens, last_input_tokens }`
  - `POST /api/chat/clear` → `{ ok: true, estimated_tokens: 0, last_input_tokens: null }`

- [ ] **Step 1: Write the failing test**

Add to `tests/web-chat-route.test.js`. First add a `get` helper next to the existing `post` helper:
```js
const get = (path, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, { headers });
```

Then a new describe block:
```js
describe('GET /api/chat/history + POST /api/chat/clear', () => {
  it('returns the persisted transcript and token stats, then clears it', async () => {
    const project = await Projects.createProject('Western');
    const pid = project._id.toString();

    // One real turn so there is history to load.
    const r = await post('/chat', { text: 'add a beat' }, { 'X-Project-Id': pid });
    await waitForRun((await r.json()).run_id);

    const hist = await get('/chat/history', { 'X-Project-Id': pid });
    expect(hist.status).toBe(200);
    const body = await hist.json();
    expect(body.messages).toEqual([
      { role: 'user', text: 'add a beat' },
      { role: 'assistant', text: 'hi there' },
    ]);
    expect(body.estimated_tokens).toBeGreaterThan(0);

    const cleared = await post('/chat/clear', {}, { 'X-Project-Id': pid });
    expect(cleared.status).toBe(200);
    expect((await cleared.json())).toMatchObject({ ok: true, estimated_tokens: 0 });

    const after = await get('/chat/history', { 'X-Project-Id': pid });
    expect((await after.json()).messages).toEqual([]);
  });
});
```

Note: the mocked `requireSession` in this file sets `req.session = { username: 'tester' }`, and these routes run under the same router, so the synthetic channel resolves to `web:<pid>:tester`. `apiGet`/headers are not used here — raw `fetch` with `X-Project-Id` is enough because `resolveProject` reads that header.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/web-chat-route.test.js -t "persisted transcript"`
Expected: FAIL — 404 (routes not defined).

- [ ] **Step 3: Write the implementation**

In `src/web/entityRoutes.js`, add to the imports near the other `src/web` imports:
```js
import { webChannelId, loadWebDisplayHistory, computeHistoryStats } from './chatHistory.js';
import { setHistoryClearedAt } from '../mongo/channelState.js';
```

Add the two routes immediately **after** the existing `router.post('/chat', ...)` handler (so they are behind `router.use(requireSession())` and have `req.projectId`/`req.session`):
```js
  // Persisted transcript + token stats for this user's isolated thread.
  router.get('/chat/history', async (req, res, next) => {
    try {
      const channelId = webChannelId(req.projectId, req.session?.username);
      const [messages, stats] = await Promise.all([
        loadWebDisplayHistory(channelId),
        computeHistoryStats(channelId),
      ]);
      res.json({ messages, ...stats });
    } catch (e) {
      next(e);
    }
  });

  // Non-destructive clear: set the history watermark for this user's thread.
  router.post('/chat/clear', async (req, res, next) => {
    try {
      const channelId = webChannelId(req.projectId, req.session?.username);
      await setHistoryClearedAt(channelId);
      res.json({ ok: true, estimated_tokens: 0, last_input_tokens: null });
    } catch (e) {
      next(e);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web-chat-route.test.js`
Expected: PASS (existing + new block).

- [ ] **Step 5: Commit**

```bash
git add src/web/entityRoutes.js tests/web-chat-route.test.js
git commit -m "✨ Add /api/chat/history and /api/chat/clear endpoints"
```

---

### Task 5: `ChatDialog.jsx` — fullscreen, toolbar (token readout + Clear + Close), load-on-open

No component test harness exists in this repo; verification is a successful web build plus the manual check listed. Keep changes scoped to `ChatDialog.jsx` and `api.js`.

**Files:**
- Modify: `web/src/widgets/ChatDialog.jsx`
- Modify: `web/src/api.js` (no new helper needed — confirm `apiGet`/`apiPostJson` are exported and imported)

**Interfaces:**
- Consumes: `GET /api/chat/history`, `POST /api/chat/clear` (Task 4); `apiGet`, `apiPostJson` (already exported from `web/src/api.js`); `ConfirmDialog` from `./Modal.jsx`.

- [ ] **Step 1: Switch to fullscreen and import ConfirmDialog**

In `web/src/widgets/ChatDialog.jsx`:

Change the import line:
```js
import { Modal } from './Modal.jsx';
```
to:
```js
import { Modal, ConfirmDialog } from './Modal.jsx';
```

Change the `<Modal>` opening tag (currently `size="wide"`) to fullscreen and drop the built-in title (the toolbar will own the header):
```js
    <Modal open={open} title={null} onClose={onClose} size="fullscreen">
```

- [ ] **Step 2: Add token + history state and load-on-open effect**

Add these near the other `useState`/`useRef` declarations at the top of `ChatDialog`:
```js
  const [estimatedTokens, setEstimatedTokens] = useState(0);
  const [lastInputTokens, setLastInputTokens] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const loadedRef = useRef(false);
```

Add this effect (after the existing effects). It fetches persisted history the first time the dialog opens; it seeds messages only when the in-session transcript is empty, but always refreshes the token readout:
```js
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        const data = await apiGet('/chat/history');
        if (messages.length === 0 && Array.isArray(data?.messages)) {
          setMessages(data.messages);
        }
        setEstimatedTokens(data?.estimated_tokens ?? 0);
        setLastInputTokens(data?.last_input_tokens ?? null);
      } catch {
        // best-effort: an empty/missing history just starts fresh
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
```

Make sure `apiGet` and `apiPostJson` are in the existing import from `'../api.js'` (the file already imports `apiGet, apiPatchJson, apiPostJson, apiSseUrl` — no change needed; if `apiGet` is missing, add it).

- [ ] **Step 3: Refresh token readout when a run finishes**

In `send()`, inside `applySnapshot`, in the `snap.status === 'done'` branch (right after `patchPending({...})`), add:
```js
          if (typeof snap.estimated_tokens === 'number') setEstimatedTokens(snap.estimated_tokens);
          if (snap.last_input_tokens !== undefined) setLastInputTokens(snap.last_input_tokens);
```

- [ ] **Step 4: Add the clear handler**

Add this function inside `ChatDialog` (near `send`):
```js
  async function doClear() {
    setConfirmClear(false);
    setError(null);
    try {
      await apiPostJson('/chat/clear', {});
      setMessages([]);
      setEstimatedTokens(0);
      setLastInputTokens(null);
    } catch (e) {
      setError(e.message || 'Failed to clear history.');
    }
  }
```

- [ ] **Step 5: Add the toolbar JSX and the confirm dialog**

Inside the `<div className="chat-dialog">`, as the **first** child (above `.chat-messages`), add the toolbar:
```jsx
        <div className="chat-toolbar">
          <span className="chat-title">AI chat</span>
          <span className="chat-token-readout" title="Estimated tokens in the conversation history sent each request">
            ~{estimatedTokens.toLocaleString()} tokens
            {lastInputTokens != null && (
              <span className="chat-token-secondary"> · last request {lastInputTokens.toLocaleString()}</span>
            )}
          </span>
          <span className="chat-toolbar-spacer" />
          <button
            type="button"
            className="chat-history-btn"
            onClick={() => setConfirmClear(true)}
            disabled={busy || restoring || messages.length === 0}
            title="Clear this conversation and start fresh"
          >
            🧹 Clear
          </button>
          <button
            type="button"
            className="chat-close-btn"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close chat"
          >
            ✕
          </button>
        </div>
```

Add the confirm dialog as the **last** child inside `.chat-dialog` (after `.chat-input-row`):
```jsx
        <ConfirmDialog
          open={confirmClear}
          title="Clear conversation?"
          message="This hides the current conversation and starts fresh. It can't be undone here."
          confirmLabel="Clear"
          cancelLabel="Cancel"
          danger
          onConfirm={doClear}
          onCancel={() => setConfirmClear(false)}
        />
```

- [ ] **Step 6: Build the SPA to verify it compiles**

Run: `npm run build:web`
Expected: build succeeds with no errors referencing `ChatDialog.jsx`.

- [ ] **Step 7: Manual verification**

Run the app (`npm run dev` + `npm run dev:web`, or use a built SPA). With an approved session:
1. Open AI chat → it is fullscreen with a top toolbar showing `~N tokens`, a 🧹 Clear button, and an ✕ Close button.
2. Send a message; after the reply the token readout updates and shows `· last request M`.
3. Close the dialog and reopen → the transcript is still there (persisted).
4. Reload the page, open chat → the transcript loads from the server.
5. Click 🧹 Clear → confirm → transcript empties and the readout drops to `~0 tokens`.
6. ✕ Close and Esc both close the dialog.

- [ ] **Step 8: Commit**

```bash
git add web/src/widgets/ChatDialog.jsx web/src/api.js
git commit -m "✨ Make SPA chat fullscreen with token readout, clear, and close"
```

---

### Task 6: Styling for fullscreen chat + toolbar

**Files:**
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: the class names introduced in Task 5 (`chat-toolbar`, `chat-title`, `chat-token-readout`, `chat-token-secondary`, `chat-toolbar-spacer`, `chat-close-btn`). `.chat-dialog`, `.chat-messages`, `.chat-history-btn` already exist (around `styles.css:2500-2651`).

- [ ] **Step 1: Make the chat fill the fullscreen modal and style the toolbar**

In `web/src/styles.css`, find the existing `.chat-dialog` rule (near line 2500). Ensure it stretches to fill the fullscreen card and that the message list grows. Update `.chat-dialog` and `.chat-messages` and append the new toolbar rules. Replace the existing `.chat-dialog` and `.chat-messages` blocks with:

```css
.chat-dialog {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  gap: 10px;
}
.chat-messages {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 4px;
}
```

(If those blocks contain other declarations you rely on — e.g. background or border — keep them; only the sizing properties above need to change.)

- [ ] **Step 2: Append the toolbar + close-button styles**

Add at the end of the chat section of `styles.css`:

```css
.chat-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border, #333);
}
.chat-title {
  font-weight: 600;
  font-size: 1rem;
}
.chat-token-readout {
  font-size: 0.8rem;
  color: var(--text-muted, #9aa0a6);
  font-variant-numeric: tabular-nums;
}
.chat-token-secondary {
  opacity: 0.75;
}
.chat-toolbar-spacer {
  flex: 1 1 auto;
}
.chat-close-btn {
  background: transparent;
  border: 1px solid var(--border, #333);
  color: var(--text, #e8e8e8);
  border-radius: 6px;
  width: 30px;
  height: 30px;
  cursor: pointer;
  line-height: 1;
  font-size: 0.95rem;
}
.chat-close-btn:hover {
  background: var(--bg-elevated, #2a2a2e);
}
```

- [ ] **Step 3: Build to verify styles compile**

Run: `npm run build:web`
Expected: build succeeds.

- [ ] **Step 4: Manual verification**

Reopen the chat: the toolbar sits across the top, the message list fills the rest of the screen and scrolls, the token readout uses tabular numerals, and the ✕ button is right-aligned and hover-highlights.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles.css
git commit -m "💄 Style fullscreen chat layout and toolbar"
```

---

### Task 7: Full-suite regression + wrap-up

- [ ] **Step 1: Run the whole backend suite**

Run: `npm test`
Expected: PASS. Pay attention to any other test that asserted the web chat shares `movieChannelId` — search and update if present:

Run: `grep -rn "movieChannelId" tests/`
Any remaining web-chat history/channel assertion should expect `web:<pid>:<username>`; update and re-run.

- [ ] **Step 2: Build the SPA**

Run: `npm run build:web`
Expected: success.

- [ ] **Step 3: Final commit (only if Step 1 surfaced extra fixes)**

```bash
git add -A
git commit -m "✅ Update remaining tests for isolated web chat channel"
```

---

## Self-Review

**Spec coverage:**
- Per-username+project isolation → Task 1 (`webChannelId`) + Task 3 (rewire). ✓
- Persist + reload transcript → Task 2 (`loadWebDisplayHistory`) + Task 4 (`GET /chat/history`) + Task 5 (load-on-open). ✓
- Token count (both estimated + actual) → Task 2 (`computeHistoryStats`, `getLastAnthropicInputTokens`) + Task 3 (done snapshot) + Task 5 (readout). ✓
- Clear / start fresh (watermark) → Task 4 (`POST /chat/clear`) + Task 5 (button + confirm). ✓
- Fullscreen + close button → Task 5 (`size="fullscreen"`, toolbar) + Task 6 (CSS). ✓
- Documented v1 limitation (past-session attachments not re-rendered) → inherent in `reconstructDisplayTranscript` (text-only); no task needed. ✓
- Tests for isolation, reconstruction, token stats, clear → Tasks 1–4. ✓
- Fake-mongo upsert prerequisite → confirmed supported (`tests/_fakeMongo.js` `updateOne` handles `options.upsert`); no extension needed.

**Placeholder scan:** none — every code step shows complete content.

**Type consistency:** `webChannelId(projectId, username)`, `reconstructDisplayTranscript(docs)`, `computeHistoryStats(channelId) → {estimated_tokens, last_input_tokens}`, `loadWebDisplayHistory(channelId)`, `getLastAnthropicInputTokens(channelId)`, `loadChannelMessagesSince(channelId, {since, limit})` are referenced consistently across Tasks 1–5. Run object / `serializeChatRun` fields `estimated_tokens` / `last_input_tokens` match the SSE consumer in Task 5.
