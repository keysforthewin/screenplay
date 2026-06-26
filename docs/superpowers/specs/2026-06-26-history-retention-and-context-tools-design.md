# History retention floor + context tools

**Date:** 2026-06-26
**Status:** Approved, pre-implementation

## Problem

The agent forgets the conversation when the operator walks away for a while.
Two pruning layers cause this:

1. `loadHistoryForLlm` (`src/mongo/messages.js`) filters the Mongo query with
   `created_at >= now - maxAgeMs` (default 1 hour, `config.trim.historyWindowMs`).
   After an idle gap longer than the window, **every** stored doc is filtered
   out and the agent starts the next message with an empty history — it looks
   like amnesia.
2. `trimHistoryForLlm` (`src/agent/historyTrim.js`) applies a 30k-token budget
   (`config.trim.tokenBudget`) and stale-tool-result stubbing on top.

The operator wants a guaranteed retention floor: **the last 6 exchanges are
never pruned**, regardless of how long they've been away or how large the
token budget pressure is. They also want two new affordances: a tool to clear
context on demand, and a way for the agent to page back through full history
that left the context window.

## Goals

- Never prune below the last 6 user + 6 agent turns (the "floor"), in **both**
  pruning layers.
- Otherwise behave exactly as today.
- Add a `clear_context` agent tool.
- Let the agent page through full conversation history newest-first when the
  operator references an earlier conversation.

## Non-goals

- No change to the stale-tool-result stubbing policy.
- No change to RAG / semantic search (`screenplay_search`).
- No new "clear context" UI (Discord button + web endpoint already exist; this
  just exposes the same `setHistoryClearedAt` mechanism to the agent).

## Definition of a "turn floor"

The codebase already defines a turn via `isRealUserMessage` in
`historyTrim.js`: a `role:'user'` message with at least one non-`tool_result`
block. Messages that are entirely `tool_result` blocks are agent-loop dispatch
plumbing, not conversational turns.

**Floor = keep from the 6th-most-recent real user message onward.** That slice
contains 6 user messages plus every agent turn (tool calls + replies) that came
after the oldest of them — i.e. the last ~6 exchanges, ≈ 6 user + 6 agent turns.
Count is configurable (`config.trim.minKeptUserTurns`, default 6).

## Design

### 1. `src/util/turns.js` (new, pure, no imports)

Shared so both the mongo loader and the agent trimmer use one definition.

```js
export function isRealUserMessage(m) { /* moved verbatim from historyTrim.js */ }

// Index of the first message to KEEP so the suffix holds >= minUserTurns real
// user messages (and everything after the oldest of them). Returns 0 when there
// are fewer than minUserTurns user messages — i.e. keep everything.
export function floorStartIndex(messages, minUserTurns = 6) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) {
      count += 1;
      if (count === minUserTurns) return i;
    }
  }
  return 0;
}
```

`historyTrim.js` deletes its local `isRealUserMessage` and imports it from here
(`computeTurnAges` keeps using it). No behavior change to stubbing.

### 2. `loadHistoryForLlm` — age window becomes a soft cut (`src/mongo/messages.js`)

- Mongo query drops the `maxAgeMs` clause. It keeps `since: clearedAt`
  (`$gt`) and `.limit(HISTORY_LIMIT)` (60), `sort({created_at:-1,_id:-1})`.
- Reverse to chronological, map through `docToLlmMessage` (indices stay aligned
  1:1 with the doc array, so `created_at` is recoverable by index).
- Compute:
  - `ageStart` = first index whose doc `created_at >= now - maxAgeMs`
    (`0` when `maxAgeMs` falsy; `docs.length` when all are older).
  - `floorStart` = `floorStartIndex(llmMessages, minKeptUserTurns)`.
  - `start = Math.min(ageStart, floorStart)` — **floor wins when away.**
- Slice from `start`, then existing leading-orphan trim + `balanceToolUses`.
- New option `minKeptUserTurns`, default `config.trim.minKeptUserTurns`.

When not idle (`ageStart <= floorStart`), output is identical to today.

### 3. Token budget respects the floor (`src/agent/historyTrim.js`)

In `applyTokenBudget`, after computing the snapped `cut`, clamp:

```js
const floor = floorStartIndex(messages, opts.minKeptUserTurns ?? 6);
const cut = Math.min(snap, floor);
```

`floorStartIndex` returns a real-user-message index (or 0), so the slice still
starts on a clean turn boundary. `trimHistoryForLlm` threads
`minKeptUserTurns` from `config.trim` via its caller's opts. The last 6
exchanges survive even when they exceed the 30k budget (accepted trade-off:
a single pathological turn can push the request over budget).

### 4. Config (`src/config.js`)

```js
trim: {
  ...
  minKeptUserTurns: Number(process.env.HISTORY_MIN_KEPT_TURNS) || 6,
}
```

Threaded into `loadHistoryForLlm` and `trimHistoryForLlm` opts at every call
site (`messageHandler.js`, `chatRuns.js`; `chatHistory.js` / generate_image
keep defaults).

### 5. `clear_context` tool (`src/agent/tools.js` + `src/agent/handlers.js`)

- TOOL entry: `clear_context`, no required input. Keywords:
  `clear, reset, forget, wipe, fresh, start over, new conversation, amnesia,
  context, history`. Description: clears the channel's short-term conversation
  memory by setting a watermark so prior messages drop out of future context
  windows; **use only when the operator explicitly asks to start fresh / clear
  context / forget the thread**; takes effect on the next message (this reply
  still has its context); nothing is deleted from storage and full history
  stays searchable via `search_message_history`.
- Handler: `clear_context(_input, context)` → returns an error string if no
  `context.channelId`, else `await setHistoryClearedAt(context.channelId)` and
  returns a confirmation including the watermark time.
- `clear_` is already in `MUTATING_PREFIXES` (forces a harmless system-prompt
  rebuild) and is intercepted in review-mode (acceptable — clearing context
  mid-review is undesirable anyway).
- tool_search-loadable, not core. Schema↔handler parity test
  (`tests/tools-schema.test.js`) is satisfied by adding both halves.

### 6. Extend `search_message_history` (no new tool) (`messages.js` + `handlers.js`)

- `pattern` becomes optional in the handler. **Empty/absent pattern → "recent"
  mode**: a chronological newest-first dump.
- `searchMessages` gains an `offset` and gracefully handles `regex == null`:
  - recent mode: `find(query).sort({created_at:-1,_id:-1}).skip(offset)
    .limit(limit).toArray()`, each doc rendered via `extractSearchableText`
    truncated to `contextChars`. Returns `{ results, mode:'recent',
    has_more: docs.length === limit, offset }`.
  - regex mode: unchanged (`mode:'search'`).
- Handler: builds the regex only when `pattern` is a non-empty string; passes
  `offset` (default 0). Result includes `mode`/`has_more`/`offset`.
- Description gains a sentence: omit `pattern` to page back through full history
  newest-first (`offset` to paginate) when the operator references an earlier
  conversation but there's no specific term to grep. Existing gating ("Use when
  the operator asks you to recall something they mentioned earlier") covers the
  "require the user to mention the past conversation" requirement.

## Testing (TDD)

- `tests/turns.test.js` (new): `floorStartIndex` — 0 turns, <6, exactly 6, >6;
  tool-result-only messages don't count; `isRealUserMessage` cases.
- `loadHistoryForLlm`: all docs older than window → returns exactly the last 6
  exchanges; recent docs → unchanged vs. today; `clearedAt` still excludes
  pre-watermark docs even within the floor.
- `applyTokenBudget`: a budget too small for 6 turns still returns the full
  floor (no cut below it).
- `clear_context`: sets the watermark; missing `channelId` → error string.
- `search_message_history`: recent mode returns newest-first paginated by
  `offset`; `has_more` correct; regex mode output unchanged.

## Rollout

Pure code change, no migration. New env vars are optional (defaults preserve
current behavior except the intended floor). Existing tests must stay green.
