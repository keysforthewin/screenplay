# AI Chat Popup Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-page AI chat modal with a separate popup browser window so the screenplay editor stays readable while chatting, with the agent's page context live-synced from the editor window.

**Architecture:** The chat becomes a standalone SPA route (`/p/:projectTitle/chat`) opened via `window.open` in a named popup. It reconstructs the conversation from existing server-side endpoints (`GET /api/chat/history` + SSE). The editor window publishes its current page context over a same-origin `BroadcastChannel`; the chat window subscribes. No backend changes.

**Tech Stack:** React 18 + Vite SPA, react-router-dom v6, EventSource (SSE), Web `BroadcastChannel`, Vitest (node-environment unit tests, no React Testing Library).

## Global Constraints

- **No backend changes.** All of `src/web/*` (chat routes, runs, history) is untouched.
- **Test style:** node-environment Vitest, pure-function tests only — the suite has no React renderer (no `@testing-library`, no jsdom env pragma). Make logic testable as plain functions that accept their collaborators (channel, window) as arguments; React hooks/components are thin glue validated by `npm run build:web`.
- **Tests pass with `npx vitest run <file>`** (default node environment). Use a hand-rolled fake channel/window object in tests — never rely on a real `BroadcastChannel`/`window` global.
- **Page-context object shape is fixed:** `{ kind, ref, label }`, exactly what `web/src/project/pageContext.js#pageContextFromPath` returns. Do not change it.
- **`useProject()` returns `{ id, title }`** (both strings). `project.id` is the 24-hex project id; `project.title` is plain text.
- **Commit message style:** the repo uses a leading emoji (e.g. `✨`, `♻️`, `🧪`, `🔥`). End every commit body with `Claude-Session: https://claude.ai/code/session_01SnQy3NT3V9tUEkhD5zg4xL`. Never add Co-Authored-By / attribution trailers.
- Work happens on branch `chat-popup-window` (already created).

---

### Task 1: Page-context sync core (pure functions)

The same-origin messaging primitives, decoupled from React so they're unit-testable in node. Two roles share one channel: the **editor** broadcasts its page context and answers `request` pings; the **chat window** sends a `request` on start and receives `pagectx` updates.

**Files:**
- Create: `web/src/project/pageContextSync.js`
- Test: `tests/pageContextSync.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `OVERVIEW_CONTEXT` → `{ kind: 'overview', ref: null, label: 'Overview' }`
  - `pagectxChannelName(projectId: string): string` → `screenplay-pagectx:<projectId>`
  - `createPageContextBroadcaster(channel, getCtx: () => ctx): { post(): void, stop(): void }` — `post()` sends `{type:'pagectx', ctx: getCtx()}`; auto-replies to any received `{type:'request'}` with the current ctx; `stop()` removes the listener.
  - `createPageContextReceiver(channel, onCtx: (ctx) => void): () => void` — sends `{type:'request'}` immediately, calls `onCtx` for every received `{type:'pagectx'}`; returns a stop function.
  - `channel` is any object exposing `postMessage(msg)`, `addEventListener('message', fn)`, `removeEventListener('message', fn)` (a real `BroadcastChannel` or a test fake).

- [ ] **Step 1: Write the failing test**

Create `tests/pageContextSync.test.js`:

```js
// pageContextSync.js holds the BroadcastChannel messaging primitives for
// live-syncing the editor's page context to the chat popup window. Tested with
// a fake channel (plain object) so no real BroadcastChannel/global is needed.
import { describe, it, expect, vi } from 'vitest';
import {
  OVERVIEW_CONTEXT,
  pagectxChannelName,
  createPageContextBroadcaster,
  createPageContextReceiver,
} from '../web/src/project/pageContextSync.js';

// Minimal stand-in for a BroadcastChannel: records posts and lets the test
// deliver a message to all registered 'message' listeners.
function makeFakeChannel() {
  const listeners = new Set();
  return {
    posted: [],
    postMessage(msg) { this.posted.push(msg); },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    deliver(data) { for (const fn of listeners) fn({ data }); },
  };
}

describe('pageContextSync', () => {
  it('builds a project-scoped channel name', () => {
    expect(pagectxChannelName('abc123')).toBe('screenplay-pagectx:abc123');
  });

  it('OVERVIEW_CONTEXT is the default page descriptor', () => {
    expect(OVERVIEW_CONTEXT).toEqual({ kind: 'overview', ref: null, label: 'Overview' });
  });

  it('broadcaster.post() sends the current context', () => {
    const ch = makeFakeChannel();
    const ctx = { kind: 'beat', ref: '3', label: 'Beat 3' };
    const b = createPageContextBroadcaster(ch, () => ctx);
    b.post();
    expect(ch.posted).toEqual([{ type: 'pagectx', ctx }]);
    b.stop();
  });

  it('broadcaster replies to a request with the current context', () => {
    const ch = makeFakeChannel();
    let ctx = { kind: 'overview', ref: null, label: 'Overview' };
    const b = createPageContextBroadcaster(ch, () => ctx);
    ctx = { kind: 'character', ref: 'Steve', label: 'Character: Steve' };
    ch.deliver({ type: 'request' });
    expect(ch.posted).toEqual([{ type: 'pagectx', ctx }]);
    b.stop();
  });

  it('broadcaster.stop() removes the request listener', () => {
    const ch = makeFakeChannel();
    const b = createPageContextBroadcaster(ch, () => OVERVIEW_CONTEXT);
    b.stop();
    ch.deliver({ type: 'request' });
    expect(ch.posted).toEqual([]);
  });

  it('receiver requests on start and forwards pagectx updates', () => {
    const ch = makeFakeChannel();
    const onCtx = vi.fn();
    const stop = createPageContextReceiver(ch, onCtx);
    expect(ch.posted).toEqual([{ type: 'request' }]);
    const ctx = { kind: 'beat', ref: '5', label: 'Beat 5' };
    ch.deliver({ type: 'pagectx', ctx });
    expect(onCtx).toHaveBeenCalledWith(ctx);
    stop();
    ch.deliver({ type: 'pagectx', ctx: { kind: 'notes', ref: null, label: 'Notes' } });
    expect(onCtx).toHaveBeenCalledTimes(1);
  });

  it('receiver ignores its own request echoes and malformed messages', () => {
    const ch = makeFakeChannel();
    const onCtx = vi.fn();
    createPageContextReceiver(ch, onCtx);
    ch.deliver({ type: 'request' });
    ch.deliver({ type: 'pagectx' }); // no ctx
    ch.deliver(null);
    expect(onCtx).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pageContextSync.test.js`
Expected: FAIL — `Failed to resolve import "../web/src/project/pageContextSync.js"` (module doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `web/src/project/pageContextSync.js`:

```js
// Same-origin BroadcastChannel primitives that live-sync the editor window's
// "what page am I on" descriptor to the AI chat popup window. Pure (no React,
// no DOM globals): callers pass in the channel, so this is unit-testable in node
// and the React hooks in usePageContextSync.js are thin glue over it.
//
// Protocol on channel `screenplay-pagectx:<projectId>`:
//   editor  -> { type: 'pagectx', ctx }   (on navigation, on mount, and as a
//                                           reply to a 'request')
//   chat    -> { type: 'request' }         (on mount, to pull current state)
// The ctx shape matches pageContextFromPath: { kind, ref, label }.

export const OVERVIEW_CONTEXT = { kind: 'overview', ref: null, label: 'Overview' };

export function pagectxChannelName(projectId) {
  return `screenplay-pagectx:${projectId}`;
}

// Editor side. `getCtx` returns the current page context at call time.
export function createPageContextBroadcaster(channel, getCtx) {
  const post = () => channel.postMessage({ type: 'pagectx', ctx: getCtx() });
  const onMessage = (ev) => {
    if (ev?.data?.type === 'request') post();
  };
  channel.addEventListener('message', onMessage);
  return {
    post,
    stop: () => channel.removeEventListener('message', onMessage),
  };
}

// Chat side. Calls `onCtx` for every received context; returns a stop function.
export function createPageContextReceiver(channel, onCtx) {
  const onMessage = (ev) => {
    if (ev?.data?.type === 'pagectx' && ev.data.ctx) onCtx(ev.data.ctx);
  };
  channel.addEventListener('message', onMessage);
  channel.postMessage({ type: 'request' });
  return () => channel.removeEventListener('message', onMessage);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pageContextSync.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/project/pageContextSync.js tests/pageContextSync.test.js
git commit -m "$(cat <<'EOF'
✨ Add BroadcastChannel page-context sync primitives

Pure channel-agnostic helpers to live-sync the editor's page context to
the AI chat popup window. React glue follows in a later task.

Claude-Session: https://claude.ai/code/session_01SnQy3NT3V9tUEkhD5zg4xL
EOF
)"
```

---

### Task 2: Chat-window opener helper (pure function)

Extract the `window.open` call into a testable helper so the URL, named-window
key (for dedup/focus on re-click), and features are verified without rendering
the Header.

**Files:**
- Create: `web/src/widgets/openChatWindow.js`
- Test: `tests/openChatWindow.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `chatWindowName(projectId: string): string` → `screenplay-chat-<projectId>`
  - `chatWindowUrl(projectTitle: string): string` → `/p/<encoded title>/chat`
  - `openChatWindow(win, project: { id, title }): Window|null` — calls `win.open(url, name, features)`, focuses the result, returns it.

- [ ] **Step 1: Write the failing test**

Create `tests/openChatWindow.test.js`:

```js
// openChatWindow.js wraps window.open so the Header button can launch the AI
// chat in a named popup. Tested with a fake window object (no real DOM).
import { describe, it, expect, vi } from 'vitest';
import {
  chatWindowName,
  chatWindowUrl,
  openChatWindow,
} from '../web/src/widgets/openChatWindow.js';

describe('openChatWindow', () => {
  it('names the window per project so re-clicks reuse/focus it', () => {
    expect(chatWindowName('64af00000000000000000001')).toBe(
      'screenplay-chat-64af00000000000000000001',
    );
  });

  it('builds the chat route URL with an encoded title', () => {
    expect(chatWindowUrl('My Movie')).toBe('/p/My%20Movie/chat');
  });

  it('opens a named popup at the chat URL and focuses it', () => {
    const focus = vi.fn();
    const win = { open: vi.fn(() => ({ focus })) };
    const project = { id: 'pid1', title: 'Western' };
    const result = openChatWindow(win, project);
    expect(win.open).toHaveBeenCalledTimes(1);
    const [url, name, features] = win.open.mock.calls[0];
    expect(url).toBe('/p/Western/chat');
    expect(name).toBe('screenplay-chat-pid1');
    expect(features).toContain('width=480');
    expect(features).toContain('height=800');
    expect(focus).toHaveBeenCalled();
    expect(result).toEqual({ focus });
  });

  it('does not throw when the popup is blocked (open returns null)', () => {
    const win = { open: vi.fn(() => null) };
    expect(() => openChatWindow(win, { id: 'p', title: 't' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openChatWindow.test.js`
Expected: FAIL — cannot resolve `../web/src/widgets/openChatWindow.js`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/widgets/openChatWindow.js`:

```js
// Launches the AI chat as a separate popup window. Named per project so that
// clicking "AI chat" again reuses and focuses the existing popup instead of
// spawning duplicates (browser window-name reuse). Pure: the caller passes the
// window object, so it's unit-testable and DOM-free in tests.

const CHAT_WINDOW_FEATURES =
  'width=480,height=800,menubar=no,toolbar=no,location=no,status=no';

export function chatWindowName(projectId) {
  return `screenplay-chat-${projectId}`;
}

export function chatWindowUrl(projectTitle) {
  return `/p/${encodeURIComponent(projectTitle)}/chat`;
}

export function openChatWindow(win, project) {
  const w = win.open(
    chatWindowUrl(project.title),
    chatWindowName(project.id),
    CHAT_WINDOW_FEATURES,
  );
  w?.focus?.();
  return w;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openChatWindow.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/widgets/openChatWindow.js tests/openChatWindow.test.js
git commit -m "$(cat <<'EOF'
✨ Add openChatWindow helper for the AI chat popup

Project-named window.open wrapper so re-clicking AI chat focuses the
existing popup. Pure/testable; wired into the Header in a later task.

Claude-Session: https://claude.ai/code/session_01SnQy3NT3V9tUEkhD5zg4xL
EOF
)"
```

---

### Task 3: React hooks + ChatPanel + ChatWindow route component

Wrap the Task 1 primitives in React hooks, extract the chat body out of the
modal into a self-contained `ChatPanel`, and add the `ChatWindow` route page.
These are React glue (no React test runner in this repo); the deliverable gate
is a clean production build.

**Files:**
- Create: `web/src/project/usePageContextSync.js`
- Create: `web/src/widgets/ChatPanel.jsx`
- Create: `web/src/routes/ChatWindow.jsx`
- Reference (read, do not change yet): `web/src/widgets/ChatDialog.jsx`

**Interfaces:**
- Consumes: `pageContextFromPath` (`web/src/project/pageContext.js`); `createPageContextBroadcaster`, `createPageContextReceiver`, `pagectxChannelName`, `OVERVIEW_CONTEXT` (Task 1); `useProject` (`web/src/project/ProjectContext.jsx`, returns `{ id, title }`); existing `apiGet/apiPatchJson/apiPostJson/apiSseUrl` (`web/src/api.js`); `ConfirmDialog` (`web/src/widgets/Modal.jsx`); `beatEditHistory.js` helpers.
- Produces:
  - `useBroadcastPageContext(projectId: string): void` — editor-side hook; broadcasts current route context on mount and on every navigation, answers requests.
  - `useReceivedPageContext(projectId: string): ctx` — chat-side hook; returns the latest `{ kind, ref, label }` (defaults to `OVERVIEW_CONTEXT`).
  - `ChatPanel()` — self-contained chat UI component (owns its own messages/history state); used by `ChatWindow`.
  - `ChatWindow()` — route page rendering `ChatPanel` with no app Header.

- [ ] **Step 1: Create the hooks file**

Create `web/src/project/usePageContextSync.js`:

```js
// React glue over pageContextSync.js. The editor window uses
// useBroadcastPageContext to publish its current route; the chat popup uses
// useReceivedPageContext to follow it. Both no-op gracefully where
// BroadcastChannel is unavailable (the chat window then shows Overview).
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { pageContextFromPath } from './pageContext.js';
import {
  OVERVIEW_CONTEXT,
  pagectxChannelName,
  createPageContextBroadcaster,
  createPageContextReceiver,
} from './pageContextSync.js';

export function useBroadcastPageContext(projectId) {
  const location = useLocation();
  const ctx = pageContextFromPath(location.pathname);
  // Keep the latest ctx in a ref so the broadcaster's request-reply always
  // reads the current value without re-subscribing the channel each nav.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const apiRef = useRef(null);

  useEffect(() => {
    if (!projectId || typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(pagectxChannelName(projectId));
    const api = createPageContextBroadcaster(channel, () => ctxRef.current);
    apiRef.current = api;
    api.post(); // announce current page to any already-open chat window
    return () => {
      api.stop();
      channel.close();
      apiRef.current = null;
    };
  }, [projectId]);

  // Re-broadcast whenever the page identity changes.
  useEffect(() => {
    apiRef.current?.post();
  }, [ctx.kind, ctx.ref]);
}

export function useReceivedPageContext(projectId) {
  const [ctx, setCtx] = useState(OVERVIEW_CONTEXT);
  useEffect(() => {
    if (!projectId || typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(pagectxChannelName(projectId));
    const stop = createPageContextReceiver(channel, setCtx);
    return () => {
      stop();
      channel.close();
    };
  }, [projectId]);
  return ctx;
}
```

- [ ] **Step 2: Create the self-contained ChatPanel**

Create `web/src/widgets/ChatPanel.jsx` (the `ChatDialog` body, minus the `<Modal>`
wrapper; state lifted from the old parent into the panel; page context now comes
from the receiver hook; the `✕` button closes the window):

```jsx
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ConfirmDialog } from './Modal.jsx';
import { apiGet, apiPatchJson, apiPostJson, apiSseUrl } from '../api.js';
import {
  emptyHistory,
  recordEdit,
  undo as undoHistory,
  redo as redoHistory,
  canUndo,
  canRedo,
} from './beatEditHistory.js';
import { useProject } from '../project/ProjectContext.jsx';
import { useReceivedPageContext } from '../project/usePageContextSync.js';

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function Attachment({ att }) {
  if (att.kind === 'image') {
    return (
      <a href={att.url} target="_blank" rel="noreferrer">
        <img className="chat-attachment-image" src={att.url} alt="generated" />
      </a>
    );
  }
  if (att.kind === 'pdf' || att.kind === 'file') {
    return (
      <a href={att.url} target="_blank" rel="noreferrer">
        {att.filename || att.url.split('/').pop() || 'download'}
      </a>
    );
  }
  return (
    <span className="chat-attachment-unavailable">
      generated <code>{att.filename}</code> — ask in Discord to receive this file
    </span>
  );
}

function ChatMessage({ m }) {
  if (m.role === 'user') {
    return <div className="chat-msg chat-msg-user">{m.text}</div>;
  }
  return (
    <div className="chat-msg chat-msg-assistant">
      {m.pending ? (
        <div className="chat-progress">{m.progressLabel || 'thinking…'}</div>
      ) : (
        <>
          <div className="chat-markdown">
            <ReactMarkdown>{m.text || ''}</ReactMarkdown>
          </div>
          {m.attachments?.length > 0 && (
            <div className="chat-attachments">
              {m.attachments.map((att, i) => (
                <Attachment key={i} att={att} />
              ))}
            </div>
          )}
          {m.interpreted && (
            <div className="chat-interpreted">Interpreted: {m.interpreted}</div>
          )}
        </>
      )}
    </div>
  );
}

// Self-contained AI chat panel rendered in its own popup window. Each send
// POSTs /api/chat (running the shared agent loop against the browser's current
// project) and follows the run via SSE. The transcript is reloaded from the
// server on mount, so it survives the window being closed and reopened. The
// page context ("which scene am I on") is live-synced from the editor window.
export function ChatPanel() {
  const project = useProject();
  const pageCtx = useReceivedPageContext(project.id);
  const [messages, setMessages] = useState([]);
  const [beatHistories, setBeatHistories] = useState({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState(null);
  const [estimatedTokens, setEstimatedTokens] = useState(0);
  const [lastInputTokens, setLastInputTokens] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const esRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => () => esRef.current?.close(), []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function patchPending(patch) {
    setMessages((prev) => {
      const next = prev.slice();
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].pending) {
          next[i] = { ...next[i], ...patch };
          break;
        }
      }
      return next;
    });
  }

  function finishStream() {
    esRef.current?.close();
    esRef.current = null;
    setBusy(false);
  }

  // Drop the transient "reverted" status when the active page/beat changes.
  useEffect(() => {
    setRestoreStatus(null);
  }, [pageCtx.kind, pageCtx.ref]);

  // Load persisted history once on mount (the window opening is the "open").
  useEffect(() => {
    (async () => {
      try {
        const data = await apiGet('/chat/history');
        if (Array.isArray(data?.messages)) setMessages(data.messages);
        setEstimatedTokens(data?.estimated_tokens ?? 0);
        setLastInputTokens(data?.last_input_tokens ?? null);
      } catch {
        // best-effort: an empty/missing history just starts fresh
      }
    })();
  }, []);

  const beatRef = pageCtx.kind === 'beat' ? pageCtx.ref : null;
  const history = (beatRef && beatHistories[beatRef]) || emptyHistory();

  async function fetchBeatText(ref) {
    try {
      const { beat } = await apiGet(`/beat?order=${encodeURIComponent(ref)}`);
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

  async function send() {
    const text = input.trim();
    if (!text || busy || restoring) return;
    setError(null);
    setRestoreStatus(null);
    setBusy(true);
    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', text },
      { role: 'assistant', pending: true, progressLabel: 'sending…' },
    ]);
    try {
      const captureRef = pageCtx.kind === 'beat' ? pageCtx.ref : null;
      const before = captureRef ? await fetchBeatText(captureRef) : null;
      const r = await apiPostJson('/chat', { text, context: { kind: pageCtx.kind, ref: pageCtx.ref } });
      const runId = r?.run_id;
      if (!runId) throw new Error('Server did not return a run id.');
      const es = new EventSource(apiSseUrl(`/chat/${runId}/events`));
      esRef.current = es;
      const applySnapshot = (snap) => {
        if (!snap) return;
        if (snap.status === 'done') {
          patchPending({
            pending: false,
            text: snap.text,
            attachments: snap.attachments || [],
            interpreted: snap.interpreted,
          });
          if (typeof snap.estimated_tokens === 'number') setEstimatedTokens(snap.estimated_tokens);
          if (snap.last_input_tokens !== undefined) setLastInputTokens(snap.last_input_tokens);
          if (captureRef && before) recordBeatEdit(captureRef, before);
          finishStream();
        } else if (snap.status === 'error') {
          patchPending({ pending: false, text: `Something went wrong: ${snap.error}` });
          setError(snap.error || 'Agent run failed.');
          finishStream();
        } else {
          const last = snap.progress?.[snap.progress.length - 1];
          if (last?.label) patchPending({ progressLabel: last.label });
        }
      };
      es.addEventListener('snapshot', (ev) => applySnapshot(safeParse(ev.data)));
      es.addEventListener('progress', (ev) => applySnapshot(safeParse(ev.data)));
      es.addEventListener('done', (ev) => applySnapshot(safeParse(ev.data)));
      es.addEventListener('error', (ev) => {
        const data = ev?.data ? safeParse(ev.data) : null;
        if (data) {
          applySnapshot(data);
        } else if (es.readyState === EventSource.CLOSED) {
          patchPending({ pending: false, text: '(connection lost)' });
          setError('Connection lost.');
          finishStream();
        }
      });
    } catch (e) {
      setMessages((prev) => prev.filter((m) => !m.pending));
      setInput(text);
      setError(e.message || 'Failed to send.');
      setBusy(false);
    }
  }

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

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="chat-window">
      <div className="chat-dialog">
        <div className="chat-toolbar">
          <span className="chat-title">AI chat</span>
          <span className="chat-token-readout" title="Estimated tokens in the conversation history sent each run">
            ~{estimatedTokens.toLocaleString()} tokens
            {lastInputTokens != null && (
              <span className="chat-token-secondary"> · last run {lastInputTokens.toLocaleString()}</span>
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
            onClick={() => window.close()}
            title="Close window"
            aria-label="Close chat window"
          >
            ✕
          </button>
        </div>
        <div className="chat-messages" ref={listRef}>
          {messages.length === 0 && (
            <p className="chat-empty">
              Talk to the screenplay agent about this project — the same
              assistant that lives in Discord.
            </p>
          )}
          {messages.map((m, i) => (
            <ChatMessage key={i} m={m} />
          ))}
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div
          className="chat-context-chip"
          title="The agent is told which page you're viewing in the editor window"
          aria-label={`Page context: ${pageCtx.label} — the agent is told which page you're viewing in the editor`}
        >
          Context: {pageCtx.label}
        </div>
        <div className="chat-history-row">
          <button
            type="button"
            className="chat-history-btn"
            onClick={onUndo}
            disabled={busy || restoring || !beatRef || !canUndo(history)}
            title={beatRef ? 'Undo the last AI edit to this beat' : 'Open a beat page in the editor to undo AI edits'}
          >
            ↶ Undo
          </button>
          <button
            type="button"
            className="chat-history-btn"
            onClick={onRedo}
            disabled={busy || restoring || !beatRef || !canRedo(history)}
            title={beatRef ? 'Redo the last undone AI edit' : 'Open a beat page in the editor to redo AI edits'}
          >
            ↷ Redo
          </button>
          {restoreStatus && <span className="chat-history-status">{restoreStatus}</span>}
        </div>
        <div className="chat-input-row">
          <textarea
            rows={2}
            placeholder="Message the agent… (Enter to send, Shift+Enter for a new line)"
            value={input}
            disabled={busy || restoring}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button className="primary" onClick={send} disabled={busy || restoring || !input.trim()}>
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
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
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create the ChatWindow route page**

Create `web/src/routes/ChatWindow.jsx`:

```jsx
// Route page for the AI chat popup (/p/:projectTitle/chat). Renders the chat
// panel full-window with no app Header — this document lives in its own browser
// window beside the editor. Project + auth are resolved by the wrappers in
// App.jsx (ProjectProvider + the top-level session gate).
import { ChatPanel } from '../widgets/ChatPanel.jsx';

export function ChatWindow() {
  return <ChatPanel />;
}
```

- [ ] **Step 4: Verify the new modules compile**

Run: `npm run build:web`
Expected: build succeeds with no "Could not resolve import" / unresolved-reference errors. (`ChatPanel`/`ChatWindow` aren't routed yet — that's Task 4 — but they must transpile cleanly.)

- [ ] **Step 5: Commit**

```bash
git add web/src/project/usePageContextSync.js web/src/widgets/ChatPanel.jsx web/src/routes/ChatWindow.jsx
git commit -m "$(cat <<'EOF'
✨ Add ChatPanel/ChatWindow and page-context sync hooks

Self-contained chat panel (modal-free, owns its own transcript state)
plus the popup route page and the React hooks that live-sync page
context between editor and chat windows. Wiring follows next.

Claude-Session: https://claude.ai/code/session_01SnQy3NT3V9tUEkhD5zg4xL
EOF
)"
```

---

### Task 4: Wire it up — route, Header, CSS; delete the modal

Add the chat route, switch the Header button to the popup opener, broadcast page
context from the editor, style the popup body, and delete the old modal.

**Files:**
- Modify: `web/src/App.jsx` (add chat route)
- Modify: `web/src/widgets/Header.jsx` (open popup + broadcast; drop modal state)
- Modify: `web/src/styles.css` (add `.chat-window`)
- Delete: `web/src/widgets/ChatDialog.jsx`

**Interfaces:**
- Consumes: `ChatWindow` (Task 3), `openChatWindow` (Task 2), `useBroadcastPageContext` (Task 3), `ProjectProvider` (already imported in App.jsx).
- Produces: route `/p/:projectTitle/chat`; a Header `✨ AI chat` button that opens the popup.

- [ ] **Step 1: Add the chat route in App.jsx**

In `web/src/App.jsx`, add the import alongside the other route imports (after line 13, `import { About } ...`):

```jsx
import { ChatWindow } from './routes/ChatWindow.jsx';
```

Then in the authenticated `App` return (the `<Routes>` at lines 87-100), add the
chat route **before** the `/p/:projectTitle/*` shell route so it's listed first:

```jsx
  return (
    <Routes>
      <Route
        path="/p/:projectTitle/chat"
        element={
          <ProjectProvider>
            <ChatWindow />
          </ProjectProvider>
        }
      />
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
```

(The static `chat` segment out-ranks the `*` splat in React Router v6, and the
top-level `if (!session)` gate above still forces Login when unauthenticated, so
the popup is auth-protected like every other route.)

- [ ] **Step 2: Rewire the Header**

Edit `web/src/widgets/Header.jsx`:

Replace the `ChatDialog` import (line 7) with:

```jsx
import { openChatWindow } from './openChatWindow.js';
import { useBroadcastPageContext } from '../project/usePageContextSync.js';
```

Remove the three now-unused state hooks (the `chatOpen`, `chatMessages`,
`beatHistories` lines, currently 35-37). Immediately after `const project = useProject();`,
add the broadcaster:

```jsx
  useBroadcastPageContext(project.id);
```

Change the AI-chat button's handler (currently `onClick={() => setChatOpen(true)}`) to:

```jsx
        onClick={() => openChatWindow(window, project)}
```

Delete the entire `<ChatDialog ... />` block (currently lines 77-84). Leave the
`<ProjectManagerDialog ... />` block in place.

- [ ] **Step 3: Add popup-body CSS**

In `web/src/styles.css`, immediately before the `.chat-dialog {` rule (line 2696),
add:

```css
.chat-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 12px;
  box-sizing: border-box;
}
```

(`.chat-dialog` is `height: 100%`; in the modal it filled the fullscreen card,
now it fills `.chat-window` which fills the popup viewport.)

- [ ] **Step 4: Delete the old modal**

```bash
git rm web/src/widgets/ChatDialog.jsx
```

- [ ] **Step 5: Verify build + no dangling references**

Run: `npm run build:web`
Expected: build succeeds.

Run: `grep -rn "ChatDialog" web/src`
Expected: no output (no remaining references).

- [ ] **Step 6: Run the full test suite (regression gate)**

Run: `npm test`
Expected: PASS — all existing tests plus the two new files (`pageContextSync.test.js`, `openChatWindow.test.js`). No test referenced `ChatDialog`, so nothing else should break.

- [ ] **Step 7: Manual smoke test**

Run the SPA dev servers (`npm run dev:web` with the Express server on 3000), then:
1. Sign in, open a project, navigate to a Beat page.
2. Click **✨ AI chat** → a separate ~480×800 popup window opens showing the chat.
3. Confirm the popup's context chip reads `Context: Beat <n>` matching the editor.
4. Navigate the editor window to another beat/character → the popup chip updates live.
5. Send a message; watch progress stream and the reply render; if you edited a beat, watch the change appear in the editor window.
6. Click **✨ AI chat** again in the editor → the existing popup is focused (no second window).
7. Close the popup; reopen → the transcript reloads from history.

- [ ] **Step 8: Commit**

```bash
git add web/src/App.jsx web/src/widgets/Header.jsx web/src/styles.css
git commit -m "$(cat <<'EOF'
✨ Open AI chat in a separate popup window; remove the modal

The AI chat now launches as its own browser window so the editor stays
readable while chatting. The editor broadcasts page context to the popup
via BroadcastChannel. Deletes the in-page ChatDialog modal.

Claude-Session: https://claude.ai/code/session_01SnQy3NT3V9tUEkhD5zg4xL
EOF
)"
```

---

## Notes for the implementer

- **Why pure helpers (Tasks 1-2):** this repo's Vitest suite runs in the node
  environment with no React renderer. Keeping the channel/window logic in plain
  functions that take their collaborator as an argument is the only way to get
  real test coverage; the React hooks/components are intentionally thin glue
  whose gate is the production build + manual smoke test.
- **Transcript is server-side:** `ChatPanel` deliberately does NOT preserve
  in-memory state across window close/reopen — it reloads `GET /api/chat/history`
  on mount. This is by design (spec "What stays the same").
- **No backend changes** anywhere. If you find yourself editing `src/`, stop —
  it's out of scope.
- **Popup blockers:** opening is user-initiated (a click), so browsers allow it.
  There is intentionally no in-page fallback (spec "Out of scope").
```
