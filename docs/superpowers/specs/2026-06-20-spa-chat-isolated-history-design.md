# SPA chat: isolated history, clear, token count, fullscreen

**Date:** 2026-06-20
**Status:** Approved, ready for implementation plan

## Problem

The in-browser AI chat (`web/src/widgets/ChatDialog.jsx`) loses its visible transcript
whenever the dialog is closed or the page reloads — the messages live only in React
state in `Header.jsx`. Meanwhile the *backend* already persists every web chat turn to
the `messages` collection, but under the single shared Discord channel
(`config.discord.movieChannelId`), so all web visitors and the Discord bot share one
conversation context.

We want the SPA chat to:

1. **Persist** its history so it survives closing the window / reloading, **isolated per
   logged-in username** (and per project) — not mingled with Discord or other users.
2. Provide a **Clear / start-fresh** button.
3. Show a live **token count** of the dialogue history so the user knows how much is
   being sent each request.
4. Be **fullscreen** (it's currently a cramped `wide` modal) with an explicit **Close**
   button.

## Approach

Reuse existing infrastructure wherever possible. The key insight: the entire history /
persistence / clear / token machinery already keys off a `channelId` string. Swapping the
web channel id from the shared Discord channel to a **synthetic per-username+project id**
delivers isolation with no schema changes.

### Scope decision

- **History scope:** per-username, isolated, and additionally per-project (a username's
  conversation about Project A must not bleed into Project B).
- **Clear behavior:** non-destructive **watermark** (reuses the existing
  `history_cleared_at` mechanism in `channel_state`). Rows remain in Mongo.
- **Token count:** show **both** — primary live *estimated* size of stored history, plus
  a secondary *actual* `input_tokens` from the most recent request.

## Components

### 1. Synthetic web channel id (backend)

Add a helper (in `src/web/chatRuns.js`, or a small adjacent util):

```js
// web:<projectId>:<username>
export function webChannelId(projectId, username) { ... }
```

- `projectId` is the 24-hex project id string; `username` is `session.username`.
- Normalize `username` (trim; it is the stable auth username, so no aggressive casing
  changes needed) so the same person maps to one channel.
- This string becomes the `channelId` used everywhere a web run currently passes
  `config.discord.movieChannelId`.

### 2. `chatRuns.js` rewiring (backend)

In `startChatRun` / `executeChatRun`:

- Compute `channelId = webChannelId(projectId, session.username)` instead of
  `config.discord.movieChannelId`.
- Everything downstream is already `channelId`-parameterized and needs no change:
  `getHistoryClearedAt`, `loadHistoryForLlm`, `recordUserMessage`, `recordAgentTurns`,
  `recordAssistantMessage`, `recordAnthropicTextUsage`, and the `channelMutex` (each
  username+project now serializes independently — correct, they are separate
  conversations).
- `runAgent({ channelId })` receives the synthetic id; token-usage attribution and any
  channel-scoped history tool now operate on the isolated thread (consistent with
  isolation).

Update the file's header comment, which currently states "Web and Discord share one
conversation" — that is no longer true.

### 3. `computeHistoryStats(channelId)` helper (backend)

A shared function (in `chatRuns.js`) returning:

```js
{
  estimated_tokens,   // estimateMessageTokens/totalTokens over loadHistoryForLlm result
  last_input_tokens,  // most recent anthropic_text token_usage row's meta.input_tokens
}
```

- `estimated_tokens`: load history for the channel since its watermark
  (`loadHistoryForLlm(channelId, { since: clearedAt })`) and sum
  `estimateMessageTokens` (from `src/agent/historyTrim.js`). This is the pre-trim
  estimate of the stored dialogue — "tokens in the current dialogue history."
- `last_input_tokens`: query `token_usage` for `{ channel_id, kind: 'anthropic_text' }`,
  newest first, read `meta.input_tokens` (null if none yet). Reflects the actual
  trimmed+system+tools payload of the last real request.

Used by both the history endpoint and the SSE `done` snapshot (DRY).

### 4. `GET /api/chat/history` (backend)

New route in `src/web/entityRoutes.js`, behind `requireSession()`, project-scoped:

- `channelId = webChannelId(req.projectId, req.session.username)`.
- Read raw message docs for that channel since `getHistoryClearedAt(channelId)`.
- Reconstruct a **display transcript** (not LLM format): iterate chronologically; for a
  `user` doc emit `{ role: 'user', text }`; for an `assistant` doc emit
  `{ role: 'assistant', text }` using only its text blocks — skip `tool_use` /
  `tool_result` blocks and intermediate tool plumbing. (A dedicated lightweight
  reconstructor, not `docToLlmMessage`, which produces speaker-labelled LLM blocks.)
- Return `{ messages: [...], ...computeHistoryStats(channelId) }`.

**Limitation (documented, v1):** generated-image **attachments from past sessions do not
re-render** on reload — their renderable links live on the in-memory run object, not the
stored message. The live session still shows them. Persisting attachment links per
message is a future enhancement.

### 5. `POST /api/chat/clear` (backend)

New route, behind `requireSession()`, project-scoped:

- `channelId = webChannelId(req.projectId, req.session.username)`.
- `setHistoryClearedAt(channelId)` (watermark = now).
- Return `{ ok: true, estimated_tokens: 0, last_input_tokens: null }`.

### 6. SSE `done` snapshot carries token stats (backend)

In `executeChatRun`, after `recordAgentTurns`, populate `run.estimated_tokens` and
`run.last_input_tokens` via `computeHistoryStats(channelId)`; add both fields to
`serializeChatRun`. The frontend then refreshes the readout from the `done` event with no
extra fetch.

### 7. `ChatDialog.jsx` (frontend)

- Switch `<Modal ... size="wide">` to `size="fullscreen"`.
- Add a **toolbar** row at the top of `.chat-dialog` containing:
  - **Token readout** — e.g. `~4,210 tokens` (estimated, primary) with a secondary
    `· last request 6,830` when `last_input_tokens` is known.
  - **Clear** button → opens a `ConfirmDialog` → `POST /api/chat/clear` → on success
    `setMessages([])` and reset token state to `{ estimated: 0, lastInput: null }`.
  - **✕ Close** button → `onClose` (ESC and backdrop still close too).
- **Load on open:** when the dialog first opens with an empty transcript (e.g. after a
  page reload), fetch `GET /api/chat/history`, seed `setMessages(...)` and the token
  state. Guard so it fetches once per mount, not on every open toggle.
- **Token state:** new local state `estimatedTokens` / `lastInputTokens`, set from the
  history fetch and updated from each `done` snapshot.
- The existing Undo/Redo beat-edit row is unchanged.

### 8. Styling (`web/src/styles.css`)

- `.chat-dialog` fills the fullscreen modal height (flex column, `min-height: 0`).
- `.chat-messages` grows to fill available space in fullscreen (drop the `55vh` cap when
  fullscreen; `flex: 1 1 auto`).
- Add `.chat-toolbar`, `.chat-token-readout`, and Close/Clear button styles consistent
  with existing chat button styling.

## Data flow

```
open dialog (transcript empty)
  → GET /api/chat/history?project_id=…           (X-Session-Id → username)
      channelId = web:<projectId>:<username>
      → { messages, estimated_tokens, last_input_tokens }
  → seed transcript + token readout

send message
  → POST /api/chat  → run_id                      (startChatRun, synthetic channel)
  → EventSource /api/chat/:runId/events
      progress… → done { ..., estimated_tokens, last_input_tokens }
  → append reply + refresh token readout

clear
  → POST /api/chat/clear                          (setHistoryClearedAt watermark)
  → empty transcript + token readout → 0
```

## Testing

Vitest with the in-memory fake mongo (`tests/_fakeMongo.js`):

- **Isolation:** two different usernames (same project) produce two channel ids; a
  message recorded under one is invisible to the other's `loadHistoryForLlm`. Same
  username, two projects → two channels.
- **`GET /api/chat/history` reconstruction:** seed user + assistant docs (including an
  assistant doc with array content containing tool_use/tool_result) under a synthetic
  channel; assert the display transcript contains the user text and assistant text only,
  no tool plumbing.
- **Token stats:** `computeHistoryStats` returns a positive `estimated_tokens` for a
  non-empty thread and reads `last_input_tokens` from a seeded `token_usage` row.
- **Clear:** after `POST /api/chat/clear`, `loadHistoryForLlm(channelId, { since })` and
  the history endpoint return nothing prior to the watermark; `estimated_tokens` → 0.
- **Fake-mongo prerequisite:** verify `updateOne` with `{ upsert: true }` is supported
  (needed by `setHistoryClearedAt`); extend `tests/_fakeMongo.js` if not.

## Out of scope (v1)

- Per-message persistence of generated-image attachment links (history reload shows text
  only).
- `search_message_history` / RAG cross-channel isolation — search may still span channels
  within a project. Acceptable: it is retrieval, not the live conversation thread.
- Session expiry / history retention limits (sessions never expire today; the 60-message
  `HISTORY_LIMIT` window still applies to what the agent sees).

## Files touched

- `src/web/chatRuns.js` — `webChannelId`, synthetic channel wiring, `computeHistoryStats`,
  token stats on `done`, header comment.
- `src/web/entityRoutes.js` — `GET /api/chat/history`, `POST /api/chat/clear`.
- `web/src/widgets/ChatDialog.jsx` — fullscreen, toolbar (token readout + Clear + Close),
  load-on-open, token state.
- `web/src/api.js` — `apiGet('/chat/history')` already covered by `apiGet`; add a small
  helper if convenient for the clear POST.
- `web/src/styles.css` — toolbar + fullscreen chat layout.
- `tests/` — new test file(s) for isolation, history reconstruction, token stats, clear;
  possibly extend `tests/_fakeMongo.js`.
