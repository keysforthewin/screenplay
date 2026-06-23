# AI chat in a separate popup window — design

**Date:** 2026-06-23
**Status:** Approved (design); ready for implementation plan

## Problem

The AI chat is currently a fullscreen in-page modal (`web/src/widgets/ChatDialog.jsx`,
opened from `web/src/widgets/Header.jsx`). While chatting, the modal covers the
editor, so the user can't read the screenplay text they're asking the agent about.

The user wants clicking **✨ AI chat** to open a **separate browser window** (a
popup), so the chat sits beside the editor and both are readable at once.

## Decisions (from brainstorming)

1. **Separate window**: a popup via `window.open` (not a new tab, not a modal).
2. **Modal removed entirely** — the window is the only way to open chat; the
   `ChatDialog` modal code path is deleted.
3. **Page context is live-synced** from the editor window to the chat window in
   real time, so "this scene" keeps working as the user navigates the editor.
4. **Popup size**: 480×800 portrait by default.

## Why this is clean

Conversation state already lives **server-side**:
- `POST /api/chat` starts an agent run, returns `{ run_id }`.
- `GET /api/chat/:runId/events` streams progress over SSE.
- `GET /api/chat/history` returns the persisted transcript + token stats.
- `POST /api/chat/clear` clears it.

Auth lives in `localStorage` (shared across same-origin windows), and project +
auth resolve from the URL through the normal `App` → `ProjectProvider` path. So a
popup window can fully reconstruct and drive the chat with **no backend changes**
and nothing passed cross-window except the page-context hint.

## Architecture

The chat becomes a **standalone SPA route** at `/p/:projectTitle/chat`, opened in a
named popup window. The popup loads the SPA fresh, authenticates from
`localStorage`, resolves the project from its URL, and reloads the transcript from
`GET /api/chat/history` on mount.

```
Editor window                          Chat popup window
─────────────                          ─────────────────
Header "✨ AI chat" button             /p/:title/chat  (ChatWindow → ChatPanel)
  → window.open(chatUrl,                 ├ loads session from localStorage
     'screenplay-chat-<projectId>')      ├ ProjectProvider resolves project from URL
                                         ├ GET /api/chat/history → transcript
useBroadcastPageContext()  ──────────▶  └ useReceivedPageContext()
  posts pageCtx on every nav             BroadcastChannel: screenplay-pagectx:<projectId>
  replies to "request"                   posts "request" on mount, holds latest ctx
```

## Components

### 1. `web/src/widgets/ChatPanel.jsx` (new)
The current `ChatDialog` body, **minus the `<Modal>` wrapper**, made
**self-contained**:
- Owns its own state: `messages`, `beatHistories`, `input`, `busy`, `error`,
  `estimatedTokens`, `lastInputTokens`, `confirmClear`, `restoring`,
  `restoreStatus` (currently `messages`/`beatHistories` are lifted to `Header`;
  in a dedicated window there's no reopen-preservation need, so they move local).
- Loads history from `GET /api/chat/history` on mount (drop the `open`-gated
  one-shot guard; the window mounting *is* the open event).
- Page context comes from `useReceivedPageContext()` (see below) instead of
  `useLocation()` + `pageContextFromPath`.
- Toolbar `✕` button calls `window.close()` (instead of an `onClose` prop).
- Everything else (SSE send flow, beat undo/redo, clear-confirm) is unchanged
  logic, lifted verbatim.

### 2. `web/src/routes/ChatWindow.jsx` (new)
Thin route page: renders `ChatPanel` full-window, **without** the app `Header`
(so there's no nested "AI chat" button and no editor chrome). Receives `session`
like other routes.

### 3. `web/src/widgets/Header.jsx` (modified)
- Remove `chatOpen`, `chatMessages`, `beatHistories` state and the `<ChatDialog>`
  render.
- The `✨ AI chat` button calls `openChatWindow()`:
  ```js
  function openChatWindow() {
    const url = `/p/${encodeURIComponent(project.title)}/chat`;
    const features = 'width=480,height=800,menubar=no,toolbar=no,location=no,status=no';
    const w = window.open(url, `screenplay-chat-${project.id}`, features);
    w?.focus();
  }
  ```
  The **named** window (`screenplay-chat-<projectId>`) makes the browser reuse the
  same popup on re-click — built-in dedup/focus, no manual ref tracking.
- Add `useBroadcastPageContext(project.id)` so the editor window publishes its
  current page context.

### 4. `web/src/widgets/ChatDialog.jsx` (deleted)
Its body moves to `ChatPanel.jsx`; the modal wrapper is gone.

### 5. `web/src/App.jsx` (modified)
Add the chat route as a sibling of the project shell, ranked ahead of the `/*`
shell route (React Router ranks the static `chat` segment above the splat, but
list it explicitly for clarity):
```jsx
<Route path="/p/:projectTitle/chat" element={
  <ProjectProvider><ChatWindow session={session} /></ProjectProvider>
} />
<Route path="/p/:projectTitle/*" element={<ProjectShell .../>} />
```
`ChatWindow` is wrapped in `ProjectProvider` (to resolve project + prime the
`api.js` store) but **not** `ProjectShell` (no Header). Auth gating is handled by
the existing top-level `App` session check, same as every other route.

## Live page-context sync

A same-origin `BroadcastChannel` named `screenplay-pagectx:<projectId>` (scoped by
project so two projects open in separate windows don't cross-talk).

### `web/src/project/usePageContextSync.js` (new)
Two hooks over one channel; reuses the existing pure `pageContextFromPath`.

- **`useBroadcastPageContext(projectId)`** — used in the editor `Header`:
  - On every `useLocation().pathname` change, post
    `{ type: 'pagectx', ctx: pageContextFromPath(pathname) }`.
  - On receiving `{ type: 'request' }`, re-post the current context (so a
    just-opened chat window gets the current value immediately).
  - No-op / guarded if `BroadcastChannel` is undefined (older browsers) — chat
    window then falls back to Overview.

- **`useReceivedPageContext(projectId)`** — used in `ChatPanel`:
  - Subscribes to the channel; stores the latest `ctx` in state.
  - On mount, post `{ type: 'request' }` to pull the current state.
  - Returns the latest context (default `{ kind: 'overview', ref: null,
    label: 'Overview' }` until the first broadcast arrives or if the editor
    window is closed).

The shape returned by `useReceivedPageContext` is identical to what
`pageContextFromPath` returns today, so the existing chip + beat-scoped Undo/Redo
in the panel consume it unchanged.

## What stays the same

- All backend code (`src/web/entityRoutes.js`, `chatRuns.js`, `chatHistory.js`):
  untouched.
- POST `/api/chat` → SSE → done flow, history/clear endpoints: untouched.
- Beat undo/redo logic (`beatEditHistory.js`): unchanged, lives in `ChatPanel`.
- `pageContextFromPath` (`web/src/project/pageContext.js`): unchanged, now also
  imported by the sync hook.
- Agent edits continue to appear live in the editor window via existing Yjs sync —
  a nice side effect of the two windows being open at once.

## Testing

- **`pageContext` tests**: unchanged (pure fn reused).
- **`usePageContextSync` tests** (new): mock `BroadcastChannel`; verify
  - editor hook posts `pagectx` on pathname change,
  - editor hook replies to a `request` with current context,
  - chat hook posts `request` on mount and updates state on `pagectx`,
  - graceful no-op when `BroadcastChannel` is undefined.
- **`Header` test** (new/updated): clicking `✨ AI chat` calls `window.open` with
  the project-scoped name (`screenplay-chat-<id>`) and the `/p/<title>/chat` URL.
- Remove any test that asserted modal open/close behavior for `ChatDialog`.

## Out of scope (YAGNI)

- No new tab option, no in-page modal fallback (popup blockers are rare for
  user-initiated clicks; if blocked, nothing opens — acceptable for v1).
- No cross-window transcript streaming (history reload on mount is sufficient).
- No backend changes.
