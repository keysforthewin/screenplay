# Multi-Project Support — Design

**Date:** 2026-06-09
**Status:** Approved (brainstorming complete; pending implementation plan)

## Summary

Support multiple independent screenplay projects in one deployment. The web SPA
gets a Project Manager dialog (opened by clicking the brand title in the header)
to create projects and switch between them; switching affects only the current
browser. The Discord agent is assigned to exactly one project at a time and can
switch via a new `set_project` tool addressed by project title. Every *content*
collection gains a project relation. No new permissions: any web user approved
through the existing Discord flow can see and edit any project.

## Decisions (user-confirmed)

| Decision | Choice |
|---|---|
| Threading model | **Explicit `projectId` parameters** on every project-scoped helper — no AsyncLocalStorage / implicit context. Larger but mechanical, maximally greppable diff. |
| Agent conversation memory on switch | **Channel-scoped history is kept** (no project filter on `loadHistoryForLlm`). Safety comes from the data layer: stale entity ids from the previous project fail as "not found". New message docs are stamped with `project_id` regardless. |
| Templates & media library | **Both per-project.** Character/plot templates are cloned from defaults at project creation; the GridFS image/attachment library (`owner_type: null`) is filtered by `metadata.project_id`. |
| URLs | **Project in the URL**: all SPA routes nest under `/p/:projectTitle/*`. Legacy paths redirect into the viewer's last-used (or default) project. |
| Project Manager dialog scope (v1) | **Create + switch only.** Rename and delete deferred. |
| "Every collection" scope | Content collections only. `auth_requests`/`auth_sessions` stay user-level (no-new-permissions rule), `token_usage` stays global (billing), `channel_state` is the agent's project pointer, not project data. |

## Project identity

New `projects` collection:

```js
{ _id: ObjectId, title: String, title_lower: String, created_at: Date }
```

- `title` is **plain text** (not markdown — unlike character names), set at
  creation in the dialog. Unique case-insensitively via a unique index on
  `title_lower` (computed with the existing `stripMarkdown`/lowercase pattern).
- The title is what the dialog lists, what the agent's `set_project` resolves,
  what URLs carry (`/p/<encodeURIComponent(title)>/...`), and what the header
  brand displays.
- The screenplay's own `title` field (About page, collaborative y-doc) remains a
  content field; it is no longer the header brand. The migration names the
  default project from the current screenplay title, so the header looks
  unchanged after deploy.
- **Default project** := the oldest project by `created_at` (post-migration
  there is exactly one). Used as fallback when no project is specified.

## Data model changes

| Target | Change | Why / breakage if missed |
|---|---|---|
| `plots` (today singleton `{_id:'main'}`) | One doc per project: add `project_id` with unique index `{project_id:1}`. Embedded `beats[]` model unchanged. All `{_id:'main'}` filters become `{project_id}` — ~15 sites in `src/mongo/plots.js` (`getPlot`, `updatePlot`, `editPlotField`, `deleteBeat`, `replaceBeatImage`, `setCurrentBeat`, `ensureBeatIds`, …) **plus lockstep duplicates**: `src/mongo/artworks.js` (own `{_id:'main'}` reads/writes), `src/rag/indexer.js` (`rag_indexed_at` stamp), and the beat-host resolution in `src/mongo/files.js` / `src/mongo/attachments.js` detach paths. | Un-updated filters silently no-op or write to the wrong project's doc. `current_beat_id` and beat-order resolution become per-project for free. |
| `prompts` (singletons `character_template`, `plot_template`, `director_notes`) | Composite string `_id`s: `<projectId>:character_template`, `<projectId>:plot_template`, `<projectId>:director_notes`. Templates seeded per-project at creation; `director_notes` stays lazily created by `getDirectorNotes` (just project-keyed, never seeded). Also update the direct `updateOne({_id:'director_notes'})` in `src/web/roomRegistry.js` (y-doc persist write-back). | Shared templates couple every project's character schema (`roomRegistry.describeCharacterRoom` derives character-room fragments from the template). Shared director_notes + a shared `notes` room is the one true cross-project data-corruption path. |
| `characters` | Add `project_id`. **Drop global unique `{name_lower:1}`; create compound unique `{project_id:1, name_lower:1}`** in `src/mongo/client.js`. Scope `listCharacters`/`findAllCharacters`/`searchCharacters`, `getCharacter`'s name lookup *and* its full-collection stripMarkdown fallback scan, `artworks.js#loadCharacter`, and `findCharactersInBeat` (`src/web/storyboardGenerate.js`). The 24-hex `_id` branch of `getCharacter` locates by id, then **verifies `project_id`**. | E11000 on same-named characters across projects until the index is swapped (note: `tests/_fakeMongo.js` doesn't enforce unique indexes, so this only surfaces against real Mongo). Unscoped name lookups silently return another project's character. |
| `messages` | Stamp `project_id` in `recordUserMessage`/`recordAssistantMessage`/`recordAgentTurns`. `loadHistoryForLlm` stays channel-scoped (decision above). `searchMessages` / `search_message_history` gain a project filter; message RAG metadata gains `project_id`. | Without stamping, retroactive filtering and RAG scoping are impossible. |
| `storyboards`, `dialogs` | Denormalize `project_id`; index `{project_id:1, beat_id:1}`. Filter the unscoped `listStoryboards({})`/`listDialogs({})` calls in `GET /api/toc`. | Not a correctness bug if skipped (beat ObjectIds are globally unique) but toc counts would scan all projects. |
| GridFS `images` bucket | `metadata.project_id` on every upload (`uploadGeneratedImage`, `uploadImageFromUrl` in `src/mongo/images.js`; pass-through in `imageCopy.js`). Filter `listLibraryImages`/`searchLibraryImages` (`owner_type:null`) and `listImagesByOwnerType`. Index `{metadata.project_id, metadata.owner_type}`. Thumbnails derive via `source_image_id` — no change. `GET /image/:fileId` stays id-addressed. | `/library` page, 8+ library tools, and SPA by-owner pickers leak across projects. |
| GridFS `attachments` bucket | Same: `metadata.project_id` on upload; `listLibraryAttachments` filtered. | Same leak for attachments. |
| `yjs_docs` | The **three** singleton rooms get project-scoped names: `notes:<projectId>`, `library:<projectId>`, `plot:<projectId>`. Entity rooms (`beat:<hex>`, `character:<hex>`, `storyboards:<hex>`, `dialogs:<hex>`) are ObjectId-derived and unchanged. Migration renames the three existing rows **preserving CRDT binary state**. | Without the rename, two projects' SPAs join the same room and `persistFields` cross-writes Mongo; without preserving binary state, EntitySync re-seeds from Mongo and silently resets CRDT history. |
| `channel_state` | Add `current_project_id` on the existing per-channel doc (`_id` = Discord channel id). Read in `messageHandler` before `runAgent`; written by `set_project`. | The agent's pointer must survive restarts and be inspectable. |
| `auth_requests` / `auth_sessions` | **No change.** Sessions are user-level. | Scoping these breaks the no-new-permissions rule. |
| `token_usage` | **No change** (global, per-user billing). | Reporting granularity only; revisit later if wanted. |
| Chroma RAG | `project_id` metadata on every embedded doc (`rag/indexer.js`); `screenplay_search` filters by the active project. Full reindex after migration (`scripts/reindex-rag.js` loops projects). | `screenplay_search` is a core tool loaded every iteration — an unfiltered index leaks every project into every search. |

## Backend threading (explicit params)

Every project-scoped helper in `src/mongo/*` gains `projectId` as its **first
parameter** and throws if it is missing/falsy — fail closed. Examples:
`getPlot(projectId)`, `getCharacter(projectId, idOrName)`,
`listCharacters(projectId)`, `getCharacterTemplate(projectId)`.

ObjectId-addressed helpers still locate by id (ObjectIds are globally unique)
but **verify the resolved doc's `project_id` against the passed one** before
returning or mutating. Globally-unique ids are a lookup convenience, not a
safety property — this guard is what makes stale entity ids from pre-switch
chat history fail as "not found" instead of writing into the wrong project.

### Agent loop

- `src/discord/messageHandler.js#handleMessage` reads
  `channel_state.current_project_id` **inside the existing `keyedMutex`**
  (defaulting to the default project and persisting that choice), resolves the
  project title, and passes both down. The per-channel mutex means a switch can
  never race another message in the same channel.
- `runAgent`'s `context` object (`{discordUser, channelId}`) gains `projectId`
  and `projectTitle`. `dispatchTool` passes `context` to **all** handlers
  (today only 2 of ~95 receive it); each Mongo-touching handler threads
  `context.projectId` into its helper calls.
- `buildSystem` (and `buildOverview`, `entityLinks.resolveEntityLinks`, the
  prompt-enhancer in `messageHandler`) take `projectId` explicitly. The system
  prompt gains a `# Current project` line plus `set_project` guidance.
  `entityLinks` resolves with the turn's *starting* project; a mid-turn switch
  re-resolves links for entities touched after the switch only (pre-switch
  touches are dropped with a log line rather than mislinked).
- The two handlers that hard-code `config.discord.movieChannelId`
  (`generate_image` include_recent_chat, `search_message_history`) switch to
  `context.channelId`.
- `src/web/links.js` URL builders gain a project segment:
  `/p/<encodeURIComponent(projectTitle)>/beat/3` etc., fed from
  `context.projectTitle`, so links the bot posts to Discord open in the right
  project regardless of the viewer's last-used project.

### `set_project` tool

- Regular TOOLS + HANDLERS pair — `tests/tools-schema.test.js` parity applies.
- Named with the `set_` prefix **deliberately**: `MUTATING_PREFIXES` in
  `loop.js` already contains `set_`, so the system prompt is rebuilt after a
  switch (required — the whole prompt is project state) and review mode blocks
  switching (desired — a mid-review switch changes what every subsequent read
  returns). `switch_project` would silently get neither.
- **Not** in `CORE_TOOL_NAMES`; lazy-loaded via `tool_search` with keywords
  `['project', 'switch', 'workspace', 'open']`.
- Input `{ title }`. Resolves via `projects.title_lower`; on unknown title
  returns an error string listing available project titles. Writes
  `channel_state.current_project_id`. No create-from-Discord — project creation
  is web-only.
- The tool result names the project switched to; the startup "online" message
  names the active project so channel readers always know where the bot writes.

### REST layer

- One middleware next to `requireSession` resolves the **`X-Project-Id`
  header** (with `?project_id=` query fallback for the SSE route, since
  `EventSource` cannot set headers) into `req.projectId`, validated against the
  `projects` collection. Missing header → **default project** (stale cached SPA
  bundles keep working across the deploy). Unknown/invalid id → 404.
- All `/api/*` routes pass `req.projectId` explicitly into helpers/gateway.
- New endpoints:
  - `GET /api/projects` → `[{ id, title, created_at }]` (no auth beyond the
    existing session check).
  - `POST /api/projects { title }` → validates non-empty + unique
    (case-insensitive), inserts the project, seeds its templates and an empty
    plot doc, returns the new project. 409 on duplicate title.
- `GET /api/info` becomes project-scoped and additionally returns
  `project_title` and `project_id`.

### Hocuspocus / rooms / gateway

- `src/web/roomRegistry.js#buildRoomName`/`parseRoomName`/`resolveRoom` gain
  the project segment for the three singleton rooms; entity rooms resolve the
  owning project from the entity doc itself and verify it exists.
- `onAuthenticate` rejects connections to rooms referencing unknown projects
  (stale tabs fail closed). EntitySync `afterLoadDocument`/`onStoreDocument`
  pass the parsed `projectId` explicitly into the persist functions.
- `src/web/gateway.js` replaces its ~10 hardcoded `'notes'`/`'library'` room
  string literals with `buildRoomName(type, projectId)`; gateway helpers gain a
  `projectId` parameter passed by callers (handlers / REST routes). Everything
  else inherits scoping from the now-explicit Mongo helpers.
- The Hocuspocus fallback path (`isHocuspocusRunning()` false → direct Mongo
  writes) keeps working: the fallback helpers receive the same `projectId`.

### Seeding

`src/seed/defaults.js` splits into:
1. `seedProjectDefaults(projectId)` — clones the default character/plot
   templates and creates the project's empty plot doc; called at project
   creation (the migration skips it for the default project, which already
   has both).
2. A startup pass iterating **all** projects for optional-field backfill and
   `RETIRED_CORE_FIELDS` stripping (today's behavior, per project).

## SPA

### Routing

- All routes nest under `/p/:projectTitle/*` (URL-encoded title, matching the
  `/character/Steve` human-identifier convention): `/p/<t>/`, `/p/<t>/beat/2`,
  `/p/<t>/character/Steve`, `/p/<t>/notes`, `/p/<t>/library`,
  `/p/<t>/storyboard/:order`, `/p/<t>/dialog/:order`, `/p/<t>/about`.
- Bare `/` and **legacy paths** (`/beat/2`, `/character/Steve`, …) redirect
  into the last-used project from localStorage, falling back to the default
  project — old shared links keep working.
- Coexists with the `WEB_BASE_PATH` Vite basename (`basename + /p/...`). The
  Express SPA fallback already serves `index.html` for client routes; `/p/*`
  is covered by it.
- Title renames are out of scope for v1 (no rename in the dialog), so
  title-in-URL instability is not a v1 concern.

### Project context

- A `ProjectProvider` (modeled on the existing `PresenceContext`) resolves
  `:projectTitle` → `{ id, title }` via `GET /api/projects`, then:
  - sets a module-level store in `web/src/api.js` so `authHeaders()` adds
    `X-Project-Id` and `apiSseUrl()` appends `project_id` (api.js functions are
    not hooks — same pattern as `auth/session.js#loadSession`);
  - persists the last project to localStorage key `screenplay_project_v1`;
  - updates `document.title`.
- Unknown title in the URL → "project not found" screen with a link to open
  the Project Manager.

### Header + Project Manager dialog

- `Header.jsx`'s brand link shows the **project title** and opens
  `ProjectManagerDialog` (built on the existing `widgets/Modal.jsx`):
  - list of all projects (from `GET /api/projects`) with the current one
    highlighted;
  - create form: single title input → `POST /api/projects` → switch to it;
  - click a project → switch.
- **Switching navigates with a full page load** (`location.assign('/p/<t>/')`):
  one move that kills every stale WebSocket, EventSource, and job poll instead
  of auditing every component for remount correctness.

### Singleton room consumers

`About.jsx` (room `plot:<projectId>`), `NotesPanel.jsx` (`notes:<projectId>`),
`LibraryPanel.jsx` (`library:<projectId>`) build their `CollabSurface` room
props from the project context. Entity-room pages are unchanged (rooms already
derive from `_id`s the now-scoped API returns).

## Migration

One idempotent one-shot script, `scripts/migrate-multi-project.js` (precedent:
`scripts/migrate-character-images.js`), run **before** deploying feature code:

1. Create the default project, titled from the current screenplay title
   (`stripMarkdown(plot.title)`, fallback `"Screenplay"`), skipping if a
   `projects` collection already has one (idempotency anchor).
2. Stamp `project_id` on: the `plots` doc, all `characters`, all `messages`,
   all `storyboards`/`dialogs`, and `metadata.project_id` on all `images` +
   `attachments` GridFS files.
3. Re-key the three `prompts` singletons to composite `_id`s (insert-new +
   delete-old; `_id`s are immutable in Mongo).
4. Rename the three `yjs_docs` singleton rows (`notes`/`library`/`plot` →
   `<name>:<projectId>`) preserving the CRDT binary state bytes.
5. Drop `characters` `{name_lower:1}` unique index; create
   `{project_id:1, name_lower:1}` unique.
6. Set `channel_state.current_project_id` for the configured channel.
7. Print a reminder to run `scripts/reindex-rag.js` (full Chroma reindex with
   the new `project_id` metadata).

Every step is guarded (`$exists: false` filters / upserts) so re-running is a
no-op. Backup/restore stays whole-DB (`mongodump`/`mongorestore --drop`) for
v1; restoring to fix project A rolls back project B — documented limitation.

## Error handling

- Mongo helpers **throw** on missing `projectId` (programming error, fail
  closed); they return null/"not found" on cross-project id mismatches
  (user-visible, recoverable).
- `set_project` returns a friendly error listing available titles on a miss.
- REST: 404 unknown project; 409 duplicate title on create; default-project
  fallback only for the *missing header* case.
- Hocuspocus rejects unknown-project rooms at `onAuthenticate`.
- SPA: "project not found" screen for bad URLs.

## Testing

- Existing Mongo-touching tests updated mechanically: create/use a test
  project id with the `_fakeMongo` fake (fake shape unchanged; note it does
  not enforce unique indexes, so index-collision behavior is asserted via
  helper-level checks instead).
- New coverage:
  - project helpers: create, list, resolve-by-title (case-insensitive),
    duplicate rejection;
  - `set_project` handler: happy path, unknown title error listing,
    `channel_state` persistence, system-prompt rebuild via `set_` prefix;
  - REST middleware: header resolution, SSE query fallback, default-project
    fallback, 404 on unknown;
  - **cross-project isolation**: same character name in two projects resolves
    independently; library listings don't leak; plot/beat/notes scoping; RAG
    search filter;
  - `roomRegistry` build/parse round-trip for project-scoped singleton rooms;
  - migration script idempotency (run twice on a seeded fake = no-op).
- `tests/tools-schema.test.js` covers `set_project` parity automatically.

## Out of scope (v1)

- Project rename and delete (dialog is create + switch only).
- Per-project permissions of any kind.
- Per-project backup/export.
- Per-project PDF export directory layout — PDF export stays
  filename-addressed in the shared `config.pdf.exportDir` (acceptable since
  all approved users may see all projects).
- Project creation from Discord.
- Filtering agent chat history by project.

## Incidental corrections discovered

- CLAUDE.md "Room naming" lists only the `notes` singleton room; there are
  three (`notes`, `library`, `plot`). Update alongside this work.
- CLAUDE.md says 7 `CORE_TOOL_NAMES`; `src/agent/tools.js` has 9 (adds
  `screenplay_search`, `edit`). Update alongside this work.
