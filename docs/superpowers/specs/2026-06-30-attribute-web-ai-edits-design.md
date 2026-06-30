# Attribute web-AI edits to the requesting user

**Date:** 2026-06-30
**Status:** Approved (design)

## Problem

When a logged-in web user manually types into a beat/character text field in the
SPA, a Discord notification is posted ("<name> edited the writing in Beat 3"),
throttled to once per 24h per editor+target. This works well.

But when the same web user drives the **AI chat** (or any other in-app AI-assist
feature) to edit a beat, **no notification is posted** — the edit goes through the
mutation gateway, which tags every text write with `actor: 'bot'`, and
`handleRoomChange` (the announce hook) explicitly bails on `actor === 'bot'`.

We want web-AI edits to surface the same notification as manual edits, attributed
to the **web user who triggered them** (not the bot), sharing the manual edit's
24h cooldown. The Discord bot's own edits must stay silent (they're already
visible as the bot's replies in the channel).

## Background — how the existing notification works

- **Trigger:** `src/web/hocuspocus.js` `onChange` hook → `handleRoomChange`
  (`src/web/editAnnounce.js`). Fires on every y-doc content update.
- **Attribution:** reads `context.user.name`. For manual keyboard edits this comes
  from the SPA's authenticated Hocuspocus connection (`onAuthenticate` returns
  `{ user: { name: session.username, ... } }`). Manual edits have
  `context.actor === undefined`.
- **Skip rule:** `if (context?.actor === 'bot') return;` — bot edits never announce.
- **Coverage:** `announceFieldsForDesc` only treats **beat** `name`/`body`/`desc`
  (explicitly excluding `scene_bible.*` and image/attachment captions) and
  **character** text fields as announce-worthy. Plus **cast** changes via
  `maybeAnnounceCast`. Edits to dialog/storyboard/library/plot/notes rooms never
  announce.
- **Throttle:** `claimAnnouncement` (`src/mongo/editAnnouncements.js`) upserts a doc
  keyed `{ project_id, target_type, target_id, editor }` with a 24h TTL index;
  returns `true` only on the first claim in the window. A process-local
  `recentClaims` memo in `editAnnounce.js` short-circuits repeat Mongo hits.

## Why AI edits are silent today

Both the AI chat and the other AI-assist features route text mutations through
`src/web/gateway.js`. Its three text-write functions
(`setEntityFieldMarkdown`, `editEntityFieldMarkdown`, `appendEntityFieldMarkdown`)
and the dialogs text write all call:

```js
await withDirectDocument(roomName, { actor: 'bot' }, (document) => { ... });
```

That `{ actor: 'bot' }` becomes the `context` in `onChange` → `handleRoomChange`
skips it. The agent's cast changes go through `updateBeatViaGateway`'s non-text
branch (`mongoUpdateBeat({ characters })` + `broadcastFieldsUpdated`), which never
calls `maybeAnnounceCast` at all.

## Design

### Decisions (confirmed with user)

1. **Shared cooldown** — AI edits use the same web-session username as the editor,
   so they share the manual edit's `{project_id, target_type, target_id, editor}`
   throttle bucket. One notification per person-per-target per 24h, whether the
   change came from typing or the AI.
2. **Scope of announcements** — beats + characters (text) + cast changes.
3. **AI surfaces** — all web AI features attribute to the requesting user, not just
   the chat. (In practice this only produces a *notification* where the edit lands
   on an announce-worthy room; everything else wraps harmlessly.)

### Component 1 — `src/web/editAttribution.js` (new)

A module-level `AsyncLocalStorage` (first use in the repo) carrying the
"on behalf of" editor identity for the current async scope.

```js
import { AsyncLocalStorage } from 'node:async_hooks';

const editorStore = new AsyncLocalStorage();

// Run `fn` with `name` as the attributed editor. Falsy name → run fn unchanged
// (no attribution scope), so callers don't need to branch.
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

Notes:
- `runAsEditor` returns whatever `fn` returns (sync value or Promise) so it wraps
  both `next()` (sync) and `runAgent(...)` (async) transparently.
- Nesting: an inner `runAsEditor` shadows the outer for its scope (standard ALS).

### Component 2 — `src/web/gateway.js`

**a. Dynamic edit context.** Add a helper and use it for all four
`withDirectDocument` text-write calls (currently lines ~472, ~500, ~522, ~2381):

```js
import { currentEditor } from './editAttribution.js';

// Context passed to withDirectDocument → surfaces in the onChange announce hook.
// When an edit is performed on behalf of a logged-in web user, attribute it to
// them so handleRoomChange announces (and throttles) it like a manual edit.
// Otherwise it's a bot/Discord edit and stays silent.
export function gatewayEditContext() {
  const editor = currentEditor();
  return editor ? { actor: 'web-user', user: { name: editor } } : { actor: 'bot' };
}
```

Replace each `{ actor: 'bot' }` literal in `withDirectDocument(...)` with
`gatewayEditContext()`. Exported for unit testing.

**b. Cast-change announcement, centralized.** In `updateBeatViaGateway`, after the
non-text `characters` write (the `onlyDiscrete.characters` branch), if
`currentEditor()` is set and the cast actually changed, fire `maybeAnnounceCast`
(fire-and-forget; it has its own throttle). It already has the "before" beat
(`beat`, fetched at the top) and the "after" (`getBeat` at the end); diff with the
existing `diffCast`. Resolve `projectTitle` via `getProjectById` for the URL (or
pass null — `buildCastPayload`/`beatUrl` tolerate null).

This makes the gateway the single source of truth for cast announcements, covering
both the agent and the REST route. Consequently, **remove** the now-duplicated
explicit `maybeAnnounceCast` block (and its `before` snapshot) from
`PATCH /beat/:id` in `entityRoutes.js` (currently lines ~1744–1763); the gateway
handles it. (Under Component 4's middleware, `currentEditor()` is set for that
request, so the manual REST cast change still announces, attributed to the user.)

`handleRoomChange` needs **no change**: `actor: 'web-user'` ≠ `'bot'`, and
`context.user.name` is the editor, so it announces with the existing throttle.

### Component 3 — Chat agent entry (`src/web/chatRuns.js`)

The chat run detaches onto `channelMutex`, so a request-scoped ALS would not reach
it — set the scope explicitly. Wrap the `runAgent(...)` call in `executeChatRun`:

```js
const result = await runAsEditor(session?.username, () =>
  runAgent({ ... }));
```

`session?.username` is already in scope (used for `username`/`discordUser`). The
Discord bot path (`handleMessage` → `runAgent`) is never wrapped, so its edits stay
`actor: 'bot'` and silent.

### Component 4 — All other web AI features (`src/web/entityRoutes.js`)

Mount a one-line middleware immediately after `router.use(requireSession())`
(line ~551), so every authenticated `/api/*` request runs inside an editor scope:

```js
router.use((req, _res, next) => runAsEditor(req.session?.username, () => next()));
```

This transparently attributes edits made by beatRewrite (normalize/regenerate/
restore beat body), the `/beat/:id/text` restore endpoint, dialog/storyboard edits,
scene-bible autofill, batch field ops, the manual REST PATCH cast change, etc. —
any AI/REST feature whose gateway calls run within the request's async scope.

Pure reads and non-edit mutations wrap harmlessly (the ALS value sits unused unless
a gateway text write or cast change occurs). Edits to non-announce-worthy rooms
(dialog/storyboard/scene-bible/library) wrap harmlessly and stay silent.

The SSE/critique-stream routes mounted **before** `requireSession` (lines ~359–511)
are read-only and intentionally not covered.

### What stays unchanged

- **Live caret** (`withBotPresence`): still shows the bot is doing the typing. Only
  the Discord *notification* attribution changes, not the collaborative-editor
  presence. (The AI genuinely is the one typing; the notification just credits the
  human who asked.)
- **Discord bot** edits: no web user in scope → `actor: 'bot'` → silent.
- **Throttle / cooldown** mechanism, keys, and TTL: unchanged.

### Known limitation

Background media-generation jobs that detach from their originating request
(artwork, fal video, image-sheet, storyboard-reference, library-vision workers)
won't inherit the editor scope, so their edits fall back to `actor: 'bot'`. This is
acceptable: those jobs only touch images/storyboard/library rooms, which never
announce regardless. If a future change makes such a job edit a beat/character text
field and we want attribution, it must capture `currentEditor()` at enqueue time
and re-establish the scope in the worker — out of scope here.

## Testing

Unit tests (Vitest; Hocuspocus does not run in tests, so the full onChange fire is
not exercised — same as the existing announce tests):

- **`editAttribution`**: `currentEditor()` is `null` outside any scope; returns the
  name inside `runAsEditor('Steve', …)`; trims/ignores blank names (no-op wrap);
  nested scopes shadow correctly; `runAsEditor` returns `fn`'s value/Promise.
- **`gatewayEditContext`**: returns `{ actor: 'bot' }` with no editor; returns
  `{ actor: 'web-user', user: { name } }` inside a `runAsEditor` scope.
- **Cast announce gating**: `updateBeatViaGateway` with a `characters` change fires
  `maybeAnnounceCast` (mock/spy) only when `currentEditor()` is set; no editor →
  no cast announce. Verify the REST route no longer double-announces.
- **`handleRoomChange`**: extend existing coverage with an `actor: 'web-user'`,
  `context.user.name` case → announces (not skipped); `actor: 'bot'` still skipped.

Run: `npm test` (full suite), and the focused files via `npx vitest run`.

## Files touched

- `src/web/editAttribution.js` — new.
- `src/web/gateway.js` — `gatewayEditContext()` helper; replace 4 `{ actor:'bot' }`
  literals; cast announce in `updateBeatViaGateway`.
- `src/web/chatRuns.js` — wrap `runAgent` in `runAsEditor`.
- `src/web/entityRoutes.js` — attribution middleware after `requireSession`; remove
  the duplicated `maybeAnnounceCast` block from `PATCH /beat/:id`.
- `tests/` — new `editAttribution` test; gateway context/cast test; `handleRoomChange`
  web-user case.
