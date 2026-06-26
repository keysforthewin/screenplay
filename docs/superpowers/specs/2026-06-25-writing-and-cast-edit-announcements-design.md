# Discord announcements for writing & cast edits

**Date:** 2026-06-25
**Status:** Approved design, pre-implementation

## Goal

Surface SPA editing activity in the Discord channel the same way media events
already are (artwork created/deleted, images attached, etc.), for two kinds of
activity that currently go unannounced:

1. **Writing edits** — a human changes a beat's `body`, `name`, or `desc` in the
   browser.
2. **Cast changes** — a human assigns or removes a character from a beat.
3. **Character edits** — a human changes any text field of a character (`name`,
   `hollywood_actor`, or any custom template field).

All three are **rate-limited per editor** so the channel doesn't get spammed
while someone works: at most one announcement per editor per target per rolling
24-hour window.

## Decisions (from brainstorming)

- **Writing fields that count:** `body`, `name`, **and** `desc`.
- **Throttle persistence:** Mongo-backed, so the window survives bot
  restarts/deploys (a mid-window deploy must not re-announce).
- **Cast changes:** throttled the same way (not announced one-by-one).
- **Character edits:** any text field counts.
- **Throttle bucket granularity:**
  - **Beats:** *one* bucket per `(editor, beat)` covering **both** writing edits
    and cast changes. Whichever activity happens first announces; that editor is
    then silent on that beat for 24h (writing **or** cast).
  - **Characters:** a separate bucket per `(editor, character)`.
- **Cast message specificity:** name the triggering change (e.g. "added Mary to
  Beat 22"), reflecting whichever cast diff first tripped the bucket.

## Background: how edits flow today

- **Media / structural mutations** (image add/remove, set-main, attachments,
  storyboards, library) go through REST endpoints in
  `src/web/entityRoutes.js`, which fire `announce*Media` helpers
  (`src/web/announceHelpers.js` → `announceMediaEvent` in
  `src/discord/announcer.js`). These are unthrottled, one embed per action. They
  stay exactly as they are.
- **Text edits** (`body`/`name`/`desc`, character fields) do **not** hit REST.
  They sync through the Hocuspocus WebSocket server. Persistence happens in the
  `onStoreDocument` hook (`src/web/hocuspocus.js`), which calls
  `resolveRoom(documentName).persistFields(snapshot)`
  (`src/web/roomRegistry.js`). `persistFields` already diffs the rendered
  markdown against the Mongo baseline and returns `{ changed, fields }`.
- **Bot text writes** go through the gateway via
  `withDirectDocument(roomName, { actor: 'bot' }, …)` — so the originating
  connection context carries `actor: 'bot'`. The AI-chat undo/redo route
  (`PATCH /beat/:id/text` → `setEntityFieldMarkdown`) also uses
  `{ actor: 'bot' }`, so it is naturally excluded from announcements.
- **`beat.characters`** is an array of **name strings** (deduped by
  `dedupeNames` in `src/mongo/plots.js`). Cast diffing is a plain string-set
  comparison — no id resolution needed.
- **Cast changes from the SPA** go through `PATCH /beat/:id` with a `characters`
  array (`src/web/entityRoutes.js:1733`). Agent (bot) cast changes go through
  tool handlers, not this route, so they won't reach our REST announce — matching
  the existing "agent activity surfaces via sendReply, not announcer" convention.

## Architecture

### 1. Throttle store — `edit_announcements` collection

New module `src/mongo/editAnnouncements.js`. One row means "this editor has
already been announced for this target inside the current window." The row is
self-cleaning via a TTL index.

Document shape:

```js
{
  project_id: '<24-hex string>',
  target_type: 'beat' | 'character',
  target_id:   '<24-hex string>',   // beat _id or character _id
  editor:      '<spa username>',
  created_at:  <Date>,              // when the announcement fired
}
```

Indexes (added to `connectMongo()` in `src/mongo/client.js`):

- **Unique:** `{ project_id: 1, target_type: 1, target_id: 1, editor: 1 }`
- **TTL:** `{ created_at: 1 }` with `expireAfterSeconds: 86400`

API:

```js
// Returns true exactly once per (project, target, editor) per ~24h window.
// First caller in a window inserts the row and gets true (→ announce);
// subsequent callers hit the duplicate-key error and get false (→ skip).
// The row expires ~24h after it was inserted, after which the next edit
// re-announces. The window is fixed from the announcement, not sliding.
export async function claimAnnouncement({ projectId, targetType, targetId, editor })
```

Implementation: `insertOne({ ...key, created_at: new Date() })`; return `true`
on success, `false` on `E11000` duplicate-key error, rethrow anything else.
Atomic — no read-modify-write race between the Hocuspocus path and the REST
path competing for the same beat bucket.

TTL caveat: Mongo's TTL monitor runs ~every 60s, so the effective window is
24h + up to ~60s. Acceptable.

> Note on `new Date()`: this runs in normal server code (not a Workflow
> script), so `new Date()` is fine here.

### 2. Announce orchestration — `src/web/editAnnounce.js`

Holds the announce-field selectors, the per-room markdown cache, the cache
lifecycle hooks, and the three message builders. Depends on
`claimAnnouncement`, `announceMediaEvent` (`src/discord/announcer.js`), the URL
helpers (`src/web/links.js`), and `stripMarkdown`.

**Announce-relevant field selectors** (given a resolved room `desc`):

- Beat: `['name', 'body', 'desc']`.
- Character: `['name', 'hollywood_actor', ...customTemplateFields]` — derived
  from `desc.fields` by excluding anything starting with `image:` or
  `attachment:` (those are media caption fragments and have their own
  unthrottled media announcements).

Only these fields are rendered/diffed; `scene_bible.*` and caption fragments are
ignored.

**Per-room markdown cache:** `Map<roomName, Map<field, lastMarkdown>>`.

- `primeRoomCache(documentName, desc)` — called from `afterLoadDocument`; seeds
  the cache from `desc.seed` for the announce-relevant fields (the Mongo
  baseline), so the seeding itself is never mistaken for an edit.
- `forgetRoomCache(documentName)` — called from `afterUnloadDocument`; drops the
  room's cache when the last client disconnects.

**`handleRoomChange({ documentName, document, context })`** — called from
`onChange`:

1. Resolve the room (`resolveRoom`); bail if not a beat/character room.
2. Compute the announce-relevant field list and render each to markdown
   (`fragmentToMarkdown`), comparing to the cache.
3. Determine `changedFields` = fields whose markdown differs from cache.
4. Update the cache to the freshly rendered values (always, regardless of who).
5. Attribution:
   - `context?.actor === 'bot'` → return (cache already updated; no announce).
     This excludes bot/gateway writes and AI-chat undo/redo.
   - No `context?.user?.name` → return (server seed / unknown origin).
   - Human with non-empty `changedFields`:
     - Beat room → `claimAnnouncement({ targetType: 'beat', targetId, editor })`;
       if claimed, fire the **writing-edit** message.
     - Character room → `claimAnnouncement({ targetType: 'character', … })`; if
       claimed, fire the **character-edit** message.

Per-update attribution is precise: each `onChange` carries the originating
connection's context, so two people editing the same beat concurrently are
attributed independently (a user who only touched `scene_bible` produces no
`changedFields` and is not announced).

Cost: a few small fragment renders per active editor while typing — bounded and
comparable to the existing `onStoreDocument` render path.

**Message builders** (all via `announceMediaEvent`, which renders
`"{who} {verb} {entityLabel}"`):

- Writing edit: `verb: 'edited the writing in'`, `entityLabel: beatLabel(beat)`,
  `entityUrl: beatUrl(...)` → "Steve edited the writing in Beat 22: The Heist".
- Character edit: `verb: 'edited'`, `entityLabel: characterLabel(character)`,
  `entityUrl: characterUrl(...)` → "Steve edited Character: Mary".
- Cast change (see §3 for the diff): builder takes `{ added: [], removed: [] }`:
  - only adds → `verb: 'added ' + list(added) + ' to'` → "Steve added Mary to
    Beat 22".
  - only removes → `verb: 'removed ' + list(removed) + ' from'` → "Steve removed
    Steve from Beat 22".
  - both → `verb: 'changed the cast of'`, plus `prompt`/description listing
    "Added Mary; removed Steve." → "Steve changed the cast of Beat 22" with the
    detail in the embed body.
  - `list([...])` joins names naturally ("Mary", "Mary and Bob", "Mary, Bob,
    and Sue").

`beatLabel`/`characterLabel`/`beatUrl`/`characterUrl` mirror the existing
helpers in `announceHelpers.js`/`links.js` (reuse, don't duplicate, where
practical — factor shared label helpers out if needed).

### 3. Cast-change detection — `PATCH /beat/:id` (`src/web/entityRoutes.js`)

When the patch includes `characters`:

1. Read the beat **before** the update (already need the beat for the label).
2. After `updateBeatViaGateway`, diff old vs new character name sets
   (case-insensitive, matching `dedupeNames` semantics):
   - `added = new \ old`, `removed = old \ new`.
3. If `added.length || removed.length`, and `req.session?.username` is present:
   - `claimAnnouncement({ projectId: req.projectId, targetType: 'beat',
     targetId: beatId, editor: req.session.username })`.
   - If claimed, fire the cast-change message with `{ added, removed }`.

Fire-and-forget; never block or fail the API response (wrap like
`announceHelpers.fire`).

Because the beat bucket is shared with writing edits, a user who already tripped
the bucket by editing the body earlier in the window will silently change the
cast (and vice versa) — exactly the "one announcement per editor+beat per 24h"
semantics chosen.

### 4. Hocuspocus wiring — `src/web/hocuspocus.js`

In the `EntitySync` extension:

- `afterLoadDocument`: after the existing seed loop, call
  `primeRoomCache(documentName, desc)`.
- Add `onChange({ documentName, document, context })`:
  `handleRoomChange(...)`, wrapped so a throw is logged and swallowed (never
  disrupt sync).
- Add `afterUnloadDocument({ documentName })`: `forgetRoomCache(documentName)`.

All new work is best-effort and isolated from persistence: a failure in the
announce path must never affect y-doc storage or the edit itself.

## Edge cases

- **Bot edits / AI-chat undo-redo:** excluded by `context.actor === 'bot'`.
- **Seeding on first load:** cache primed from Mongo baseline in
  `afterLoadDocument`, so a fresh connection that merely loads existing text
  announces nothing.
- **Two concurrent human editors on one beat:** each is attributed by their own
  `onChange` context and each gets at most one announcement (per the per-editor
  bucket). A user touching only non-announce fields (e.g. `scene_bible`)
  produces no `changedFields` and is not announced.
- **Cast change + writing edit by same user same day:** one announcement total
  (shared beat bucket); the first activity wins the message.
- **Deploy mid-window:** TTL row persists in Mongo, so no re-announce.
- **Hocuspocus not running (tests/CLI):** `onChange` simply never fires; the
  REST cast path still works (gateway falls back to direct Mongo writes, and the
  cast diff/announce runs in the route regardless of Hocuspocus).
- **Missing `MOVIE_CHANNEL_ID` / Discord client:** `announceMediaEvent` already
  no-ops safely.

## Testing

Unit (no Mongo or with `_fakeMongo`):

- `claimAnnouncement`: first call returns `true` and inserts; second call with
  the same key returns `false`; different editor / different target returns
  `true`. (Requires extending `tests/_fakeMongo.js` to honor a unique index and
  throw an `E11000`-shaped error from `insertOne` on duplicate key.)
- Cast diff + message builder: only-adds, only-removes, and mixed produce the
  expected verb/description; name-list joining ("A", "A and B", "A, B, and C").
- Announce-field selectors: beat selector excludes `scene_bible.*`; character
  selector excludes `image:`/`attachment:` fragments and includes custom
  template fields.

Integration (with `_fakeMongo` + a stubbed announcer that records calls):

- `handleRoomChange` on a beat room: a human `body` change announces once;
  a second human change in-window does **not**; a `context.actor:'bot'` change
  never announces; a change to a non-announce field (cache unchanged) does not
  announce.
- `PATCH /beat/:id` cast diff: assigning a character announces once, then is
  throttled within the window; a writing edit afterward by the same editor is
  also throttled (shared bucket).

## Files

- **New:** `src/mongo/editAnnouncements.js` (`claimAnnouncement`).
- **New:** `src/web/editAnnounce.js` (cache, selectors, `handleRoomChange`,
  `primeRoomCache`, `forgetRoomCache`, message builders, cast-diff helper).
- **Changed:** `src/web/hocuspocus.js` (wire the three hooks).
- **Changed:** `src/web/entityRoutes.js` (cast diff + announce in
  `PATCH /beat/:id`).
- **Changed:** `src/mongo/client.js` (two indexes on `edit_announcements`).
- **Changed:** `tests/_fakeMongo.js` (unique-index / duplicate-key support).
- **New tests:** `tests/editAnnouncements.test.js` (+ cast/route coverage as
  fits existing test layout).
