# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — run the bot locally with `node --watch` (needs Mongo on `MONGO_URI`, default `mongodb://localhost:27017`).
- `npm start` — run without watch.
- `npm test` — run the full Vitest suite once (`vitest run`).
- `npx vitest run tests/beats.test.js` — run a single test file.
- `npx vitest run -t "createBeat"` — run a single test by name.
- `npm run build:web` — build the React/Vite SPA into `web/dist/`. The Express server serves it at `/` when present.
- `npm run dev:web` — run the Vite dev server (port 5173) with `/api`, `/auth`, `/image`, `/attachment`, `/pdf` proxied to the Express server on 3000.
- `docker compose up --build -d` — production-style run (bot + Mongo).

`tests/setup.js` (loaded via `vitest.config.js`) populates the env vars `src/config.js` requires, so tests can be run without a real `.env`.

## Architecture

Discord bot + collaborative editor SPA in one Node process: every non-bot message in `MOVIE_CHANNEL_ID` triggers an agentic loop that mutates screenplay state in MongoDB; the same state is editable in the browser by anyone the channel has approved. The Express server (`src/server/index.js`, `WEB_PORT` default 3000) hosts both the SPA (`web/dist/`) and the read endpoints (`GET /health`, `GET /pdf/:filename`, `GET /image/:fileId`, `GET /attachment/:fileId`) plus the new `/auth/*` and `/api/*` REST endpoints. A separate Hocuspocus WebSocket server (`HOCUSPOCUS_PORT` default 3001) handles y-doc sync. URLs use `WEB_PUBLIC_BASE_URL` when set.

### Collaborative editor (SPA)

`src/web/` is the backend half; `web/` is the React/Vite SPA.

- **Auth**: visitors enter a name → `POST /auth/request` posts an embed with Approve/Deny buttons in `MOVIE_CHANNEL_ID` → click handler in `src/discord/interactions.js` updates the `auth_requests` doc → SPA polls `/auth/status` until approved → server returns a `session_id` stored in `localStorage` permanently. No revocation in v1; sessions never expire.
- **Mutation gateway** (`src/web/gateway.js`): single writer for editable entities. The agent loop's tool handlers AND the SPA's REST endpoints both route through it. For text fields it opens a server-side direct connection to the entity's y-doc (via Hocuspocus) and applies edits as CRDT operations through a headless Tiptap editor (`src/web/headlessEditor.js`, runs Tiptap on Node via JSDOM). For non-text mutations (image add/remove, set main, plays_self toggle, etc.) it writes Mongo and broadcasts a stateless `{type:'fields_updated'}` ping to the room so connected SPAs re-render the affected widgets.
- **Bot as collaborator**: when the bot mutates a text field, the gateway briefly sets the room's awareness with the bot's Discord display name and a fixed color (`config.web.botColor`), so connected humans see the bot's caret in the field it's editing. Awareness is cleared once the mutation finishes.
- **Save model**: no Save button. Hocuspocus persists y-doc binary state to the `yjs_docs` collection on every store tick (~2s debounced). The same hook also renders each text fragment to markdown and writes it to the corresponding Mongo entity field via `src/web/roomRegistry.js`. The bot reads from Mongo at the start of each agent iteration, so it sees at most ~2s stale text — acceptable.
- **Gateway fallback**: when Hocuspocus isn't running (tests, CLI scripts), text-mutation gateway calls fall back to writing Mongo directly via the existing helpers (`isHocuspocusRunning()` check). This keeps the test suite working without spinning up a real WebSocket server.
- **Names are markdown**: every text field — including character `name` and `hollywood_actor` — uses the full Tiptap toolkit. `name_lower` is recomputed from `stripMarkdown(name)` so case-insensitive lookups still work (`src/util/markdown.js`). Discord renders markdown natively, so `**Steve**` displays bold there.

### Room naming

- `beat:<beat _id hex>` — fields `body`, `name`, `desc`
- `character:<character _id hex>` — fields `name`, `hollywood_actor`, `fields.<each non-core template field>`
- `notes` — one shared y-doc for all director's notes; each note's text is fragment `note:<note _id>:text`

URLs use the human-meaningful identifier (`/beat/2` for the beat at order=2; `/character/Steve` for the character whose stripped name is "Steve") and the route resolver maps to the stable `_id` for the y-doc room name. Reordering beats breaks shared URLs but never shuffles y-doc state across the wrong rooms.

### Request lifecycle (`src/discord/messageHandler.js` → `src/agent/loop.js`)

1. `handleMessage` filters for the configured channel, extracts allowed image attachments (PNG/JPEG/WEBP), and serializes per-channel work through `keyedMutex` so two messages in the same channel can never interleave.
2. `loadHistoryForLlm` reads the last 60 docs from the `messages` collection and converts each to an Anthropic SDK message (`docToLlmMessage` in `src/mongo/messages.js`) — including raw `tool_use` / `tool_result` blocks. The agent therefore "remembers" prior tool calls across turns.
3. `runAgent` rebuilds the **system prompt from current Mongo state on every iteration** (`buildSystem` calls `listCharacters`, `getCharacterTemplate`, `getPlotTemplate`, `getPlot` each loop). When a tool call mutates state mid-loop, the next iteration's system prompt reflects the change — tools that update the template (e.g. `update_character_template`) rely on this.
4. The loop runs at most `MAX_TOOL_ITERATIONS = 12` Anthropic round-trips. Anything else returns a "(Agent hit max tool iterations.)" message.
5. After the assistant returns non-tool text, the user/assistant turns from this run (everything from `agentStart` onward, including tool blocks) are persisted via `recordAgentTurns` so they appear in next turn's history.

### Tool result sentinel protocol

Some tool handlers can't return their payload as JSON — they need to upload a file to Discord. The convention (`src/agent/loop.js` → `interceptAttachment`):

- `__PDF_PATH__:<absolute path>` → loop pushes path onto `attachmentPaths`, replaces the tool result with `"PDF generated and queued for upload."`.
- `__IMAGE_PATH__:<absolute path>|<note>|<gridfsId?>` → same, with the optional note becoming the tool result. The optional 3rd segment, if it parses as a 24-hex GridFS file id, is converted into a clickable `imageLink(...)` URL and pushed onto `attachmentLinks`.
- `__IMAGE_PATHS__:<paths_tab_separated>|<note>|<ids_tab_separated?>` → batch form for several images at once.
- `__ATTACHMENT_PATH__:<absolute path>|<note>|<gridfsId?>` → non-image attachments (any content type). The optional id surfaces a `/attachment/<id>` URL via the Express server.
- `__CSV_PATH__:<absolute path>|<note>` → no link (the file lives only on disk).

`sendReply` attaches every collected file to the final Discord reply, then sends one extra footer message listing all download links — PDF links derived from the filename, plus any `imageLink`/`attachmentLink` URLs collected from the sentinels. `cleanupTmpAttachments` deletes anything inside `os.tmpdir()` afterwards. **Never use these sentinels for non-tmp paths** — the cleanup pass refuses to touch files outside `os.tmpdir()`, but the assumption that `attachmentPaths` are temporary is baked in. (PDFs are the exception: they live in `config.pdf.exportDir` and are served by filename, not via the sentinel-id path.)

### Tool / handler parity

`src/agent/tools.js` is the JSON schema list sent to Anthropic; `src/agent/handlers.js` exports `HANDLERS` keyed by tool name. `tests/tools-schema.test.js` enforces a 1:1 mapping for **dispatchable** tools (every entry in TOOLS without `metaTool: true` must have a matching handler) — adding a regular tool requires adding both halves or the test fails. `dispatchTool` wraps every handler so a thrown error becomes `"Tool error (name): message"` text returned to the model rather than crashing the loop.

Each tool entry in TOOLS may carry two **internal-only** fields, stripped from the API payload by `toolDefsForApi` before send:
- `keywords: string[]` — synonyms used by the BM25-lite scorer in `src/agent/toolSearch.js`. Kept separate from `description` so the model isn't bombarded with synonym lists, but the search-by-user-language recall still works.
- `metaTool: true` — marker for loop-level meta tools (currently only `tool_search`) that the loop intercepts inline rather than dispatching through `HANDLERS`.

### Lazy tool loading via `tool_search`

The full tool registry is ~80+ tools. To keep the per-request input small and keep the model focused, the loop only sends a small **core set** in the `tools` parameter on each iteration; everything else is loaded on demand.

- `src/agent/tools.js` exports `CORE_TOOL_NAMES` (a Set) — `tool_search`, `get_overview`, `list_characters`, `list_beats`, `get_plot`, `get_current_beat`, `search_message_history`. These are always present.
- The model expands the loaded set by calling `tool_search({ query, limit? })`. The loop intercepts that call (it is `metaTool: true`, has no entry in `HANDLERS`), runs `searchTools(query)` from `src/agent/toolSearch.js`, and adds the matched names to a per-turn `loadedToolNames` Set. The next iteration's `tools` parameter is rebuilt from that set.
- `loadedToolNames` is per-turn (re-initialized on each `runAgent` call). Across-turn re-search is fine — historical `tool_use` blocks in the message array don't need to be in the current `tools` parameter; the API only validates current-turn tool calls.
- The system prompt's `# Tool loading` section instructs the model on this protocol; the prompt also still mentions specific tool names throughout (the model uses those names as search seeds).
- `src/agent/toolSearch.js` is BM25-lite over name (×3) + keywords (×2) + description (×1), with prefix matching so plurals/tenses still hit. `searchTools(query, { limit, minScore, exclude })` returns matched tool names. Adjust scoring there, not in the loop.
- `withToolsCache` in `src/agent/loop.js` puts the standard ephemeral `cache_control` breakpoint on the **last** entry of whatever tools array is currently loaded. When a `tool_search` adds new tools mid-turn the breakpoint moves, so cross-iteration tools-section caching is best-effort — the system prompt has its own independent `cache_control` markers that aren't affected.

### MongoDB layout (`src/mongo/`)

- `characters` — one doc per character. Custom template fields live under `fields.{...}`; core fields (`name`, `plays_self`, `hollywood_actor`, `own_voice`) are top-level. `name_lower` has a unique index. `getCharacter` accepts either a 24-char hex `_id` or a case-insensitive name.
- `plots` — singleton `{ _id: 'main' }` with an **embedded `beats` array** (no separate beats collection). Each beat has its own ObjectId, an `images[]` of metadata, and a `main_image_id`. `getPlot` lazily backfills `_id`, `images`, `main_image_id`, `current_beat_id` on legacy docs (see `ensureBeatIds`) — keep that path working when changing the schema.
- `messages` — rolling Discord transcript. Indexed on `(channel_id, created_at)`. The `recordAgentTurns` writer assigns `created_at = Date.now() + i` to preserve intra-turn ordering. (Note: the README mentions a `conversations` collection — that's stale, the code uses `messages`.)
- `prompts` — singleton docs `_id: 'character_template'`, `_id: 'plot_template'`, and `_id: 'director_notes'`. The first two are seeded by `src/seed/defaults.js` on startup; removing fields marked `core: true` is rejected. The `director_notes` doc holds an embedded `notes[]` array; each note can carry its own `images[]`/`main_image_id`/`attachments[]` (mirrors the beat schema). `getDirectorNotes` lazily backfills the missing arrays on legacy notes.
- **GridFS bucket** `images` (`src/mongo/images.js`) — single bucket for beat images, character portraits, director-note images, and generated/library images. Filtered by `metadata.owner_type` (`'beat'`, `'character'`, `'director_note'`, or `null` for library) and `metadata.owner_id`. Indexed on `(metadata.owner_type, metadata.owner_id)`. `src/mongo/files.js` exposes character-image helpers (`attachImageToCharacter`, `readCharacterImageBuffer`, etc.) that delegate to this bucket — they exist to keep the embedded `characters.images[]` array and `main_image_id` in sync. The legacy `character_images` bucket was retired in `scripts/migrate-character-images.js`; if you ever see it in an old dump, run that migration. The `attachments` bucket follows the same metadata convention for non-image files (`'beat'`, `'character'`, `'director_note'`).

### Optional integrations

- `src/gemini/client.js` — Nano Banana image generation (`gemini-2.5-flash-image`). If `GEMINI_API_KEY` is unset, the `generate_image` handler returns a friendly error string; the rest of the bot keeps working.
- `src/tmdb/client.js` — TMDB v4 read-only. Same pattern: `tmdb_*` tools short-circuit with an error when `TMDB_READ_ACCESS_TOKEN` is missing. `tmdb_show_image` only accepts URLs on `image.tmdb.org` (enforced by `isTmdbImageUrl`).

When adding a new optional integration, follow this pattern (return user-facing error string, don't throw) so a missing API key doesn't break the agent loop.

### Image validation (`src/mongo/imageBytes.js`)

`fetchImageFromUrl` enforces: HTTP(S) only, `<= 25 MB`, content type in `{image/png, image/jpeg, image/webp}`, **and** sniffed magic bytes must match the declared/picked content type. Don't bypass this when adding new image entry points — `validateImageBuffer` is the equivalent for in-memory bytes (e.g. Gemini output).

## Testing patterns

Mongo-touching tests use the in-memory fake from `tests/_fakeMongo.js`, mocked in via:

```js
const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
```

Then `await import('../src/mongo/plots.js')` (dynamic import after the mock is registered). Call `fakeDb.reset()` in `beforeEach` to isolate tests. The fake supports `findOne`/`insertOne`/`insertMany`/`updateOne` with `$set`/`$push`/`$pull`, plus a `find().sort().limit().toArray()` cursor — extend it there if a new code path needs more.
