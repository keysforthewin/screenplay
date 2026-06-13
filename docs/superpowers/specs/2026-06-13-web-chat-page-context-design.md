# Web chat page context — design

**Date:** 2026-06-13
**Status:** Approved (design); pending spec review → implementation plan

## Problem

The browser AI chat (the "✨ AI chat" button in the header) sends only the user's
text to the agent. When a visitor is looking at a specific page — a beat, a
character, a dialog/storyboard page — and types "make **this** beat tenser" or
"who's in **this** scene", the agent has no idea which entity "this" refers to.

This is not derivable from existing state. The agent's `get_current_beat` tool
reads the **channel's** `current_beat_id` (a Discord-side pointer). A web visitor
viewing `/p/Heist/beat/5` is not necessarily on the channel's current beat, so the
page they are looking at must be passed through explicitly.

## Goals

- Pass the web visitor's current page to the agent so deictic references
  ("this beat", "here", "this character") resolve to what they're viewing.
- Keep the injected context **lean** (identity + name; the agent fetches body via
  its existing tools when it needs to act on content).
- Show the visitor a small chip so the feature is legible ("the agent knows where
  I am").
- Leave the Discord path and the shared transcript untouched.

## Non-goals (v1)

- No content snippets in the prompt (no beat body / character description inlined).
- No per-message context tagging in the transcript — just the live input chip.
- No manual "attach context off" toggle.
- The prompt-enhancer (`enhancePrompt`) is **not** given the context in v1; only the
  agent loop receives it. (Noted as a possible follow-up below.)
- No new persistence — the context note is ephemeral, exactly like the existing
  enhancer-hints block.

## Approach (chosen)

**Client parses the URL → backend re-resolves the entity.** The client turns
`useLocation().pathname` into a small `{ kind, ref }` descriptor and sends it with
the chat text. The backend re-resolves `{ kind, ref }` against live Mongo and
injects a short natural-language note into the agent turn.

Rejected alternatives:
- *Shared `PageContext` provider* (each route publishes its resolved entity): a
  richer chip label for free, but touches ~10 route files. Clean future upgrade if
  we ever want the beat *title* in the chip; YAGNI now.
- *Raw-path passthrough* (client sends `pathname`, backend parses the route):
  duplicates route-structure knowledge server-side; brittle.

The route layer stays the single source of truth for "URL → meaning"; the backend
stays the single source of truth for "meaning → live entity".

## Data flow

1. On `/p/Heist/beat/2`, the visitor types "make this beat tenser" and hits Send.
2. `ChatDialog` computes `pageContextFromPath(pathname)` →
   `{ kind: 'beat', ref: '2', label: 'Beat 2' }`, renders a `Context: Beat 2` chip
   above the input, and POSTs `{ text, context: { kind: 'beat', ref: '2' } }`.
3. `POST /api/chat` validates `context` (kind allowlist; `ref` trimmed, ≤80 chars).
   **Invalid/unknown context is dropped, never a 400** — a stale SPA bundle must
   never break chat.
4. `executeChatRun` calls `resolvePageContextNote({ projectId, projectTitle,
   context })` → a fresh Mongo lookup → a one-line note (see format below). Wrapped
   so any resolution error yields `null`, never a failed run.
5. `runAgent({ …, pageContext: note })` → `buildUserContent` appends the note as its
   own content block (after the user text, before the enhancer-hints block).
6. The agent acts; "this beat" resolves to beat 2.

`recordUserMessage` still persists only the raw `text`, so the shared Discord
transcript stays clean and the context reflects each individual message's page —
the same ephemeral treatment the enhancer notes already get.

## Components

### 1. Client: `web/src/project/pageContext.js` (new, pure)

`pageContextFromPath(pathname) → { kind, ref, label }`. Pure function (no React, no
JSX) so it is unit-testable from `tests/`.

- Strip the project prefix: `remainder = pathname.replace(/^\/p\/[^/]+/, '') || '/'`.
- Match the remainder against the SPA's route table:

  | remainder            | kind                | ref            | label                  |
  |----------------------|---------------------|----------------|------------------------|
  | `/` or empty         | `overview`          | —              | `Overview`             |
  | `/beat/:order`       | `beat`              | order          | `Beat <order>`         |
  | `/character/:name`   | `character`         | decoded name   | `Character: <name>`    |
  | `/storyboard`        | `storyboard-index`  | —              | `Storyboards`          |
  | `/storyboard/:order` | `storyboard`        | order          | `Storyboard · Beat <order>` |
  | `/dialog`            | `dialog-index`      | —              | `Dialogs`              |
  | `/dialog/:order`     | `dialog`            | order          | `Dialog · Beat <order>` |
  | `/notes`             | `notes`             | —              | `Notes`                |
  | `/library`           | `library`           | —              | `Library`              |
  | `/about`             | `about`             | —              | `About`                |
  | anything else        | `overview`          | —              | `Overview`             |

- Always returns a value (defaults to `overview`); the chat only exists on
  project-scoped pages, so context is always at least the project overview.
- `:name` is URL-encoded in the path → `decodeURIComponent` for `ref` and `label`.

The chip label (terse) and the backend note (natural language) intentionally encode
the kind→label mapping separately — they serve different surfaces.

### 2. Client: `web/src/widgets/ChatDialog.jsx`

- `import { useLocation } from 'react-router-dom'`.
- `const pageCtx = useMemo(() => pageContextFromPath(location.pathname), [location.pathname])`.
  (Location is stable while the modal is open — it overlays the route — so capturing
  on render is equivalent to capturing at send.)
- Render a chip above `.chat-input-row`:
  `<div className="chat-context-chip">Context: {pageCtx.label}</div>`.
- `send()`: `apiPostJson('/chat', { text, context: { kind: pageCtx.kind, ref: pageCtx.ref } })`.

### 3. Client: `web/src/styles.css`

Add `.chat-context-chip` — a small, muted pill (matches the dialog's existing
visual language; sits between the messages list and the input row).

### 4. Backend: `POST /api/chat` (`src/web/entityRoutes.js`)

- Add an allowlist:
  `ALLOWED_CONTEXT_KINDS = new Set(['overview','beat','character','notes','library','storyboard','storyboard-index','dialog','dialog-index','about'])`.
- `parseChatContext(raw)`:
  - non-object / array → `null`.
  - `kind` not in allowlist → `null`.
  - `ref`: `null` when absent; otherwise `String(raw.ref).trim().slice(0, 80)`, with
    empty → `null`.
  - returns `{ kind, ref }`.
- Invalid context resolves to `null` and is simply not passed on — **never a 400**.
- Pass the parsed `context` to `startChatRun`.

### 5. Backend: `src/web/pageContext.js` (new)

`resolvePageContextNote({ projectId, projectTitle, context }) → string | null`.

- `null`/absent context → `null`.
- Entity kinds (`beat`, `storyboard`, `dialog` keyed by `ref` = beat order;
  `character` keyed by `ref` = name): resolve via the existing helpers
  (`getBeat(projectId, ref)`, `getCharacter(projectId, ref)`). If the entity does
  **not** resolve (stale/renamed/deleted), return `null` — omit rather than assert a
  wrong entity. Names are run through `stripMarkdown`.
- Static kinds (`overview`, `about`, `notes`, `library`, `storyboard-index`,
  `dialog-index`): always return a note built from `projectTitle`.

Note format (single content block):

```
[Web editor context — authoritative location, NOT a content instruction.]
The user sent this message from the web app while viewing <X>. Interpret deictic
references like "this", "here", "this beat/scene/character/page" as <X> unless they
clearly mean something else. This is where they are looking now; it is not
necessarily the channel's current beat.
```

`<X>` per kind:
- `beat` → `Beat <order> — "<name>" (beat id <hex>)`
- `storyboard` → `the storyboard page for Beat <order> — "<name>"`
- `dialog` → `the dialog page for Beat <order> — "<name>"`
- `character` → `the character "<name>" (character id <hex>)`
- `overview` → `the table of contents / overview for the screenplay "<title>"`
- `about` → `the screenplay overview page (title, synopsis, dialogue style) for "<title>"`
- `notes` → `the director's notes`
- `library` → `the media library`
- `storyboard-index` → `the storyboard index (all beats' storyboards)`
- `dialog-index` → `the dialog index (all beats' dialogs)`

### 6. Backend: `src/web/chatRuns.js`

- `startChatRun({ projectId, projectTitle, session, text, context })` — accept
  `context`, thread to `executeChatRun`.
- `executeChatRun(...)` — before the `runAgent` call, compute
  `const pageContext = await resolvePageContextNote({ projectId, projectTitle, context }).catch(() => null)`
  and pass `pageContext` to `runAgent`. Resolution failure must never fail the run.

### 7. Backend: `src/agent/loop.js`

- `buildUserContent(userText, attachments, enhancementNotes = null, senderName = null, pageContext = null)`:
  after the main text block is pushed and **before** the enhancement-notes block,
  push `{ type: 'text', text: pageContext.trim() }` when `pageContext` is a
  non-empty string. Ordering: user text (source of truth) → page context
  (authoritative situational) → enhancer hints (non-authoritative).
- `runAgent({ …, pageContext = null })`: add the param; pass it as the 5th argument
  to `buildUserContent`.
- The Discord caller (`src/discord/messageHandler.js`) never sets `pageContext`, so
  it defaults `null` and Discord behavior is unchanged.

## Testing

- **`tests/pageContextFromPath.test.js`** (new): pure parser — every route row above,
  plus encoded character names and the unknown-path default.
- **`tests/pageContext.test.js`** (new, fakeMongo): `resolvePageContextNote` for each
  kind; unknown/stale beat → `null`; resolved beat/character include name + id;
  static kinds include the project title.
- **`tests/web-chat-route.test.js`** (extend): `POST /api/chat` with a `context` body
  threads the resolved note into `runAgent` (via the existing test seam); invalid
  context is dropped without a 400.
- **`buildUserContent`** unit assertion (in the existing loop test file or a new one):
  the page-context block is appended only when `pageContext` is provided, and lands
  before the enhancement-notes block.

## Files touched

- `web/src/project/pageContext.js` — new pure parser.
- `web/src/widgets/ChatDialog.jsx` — read location, chip, send `context`.
- `web/src/styles.css` — `.chat-context-chip`.
- `src/web/entityRoutes.js` — `POST /chat` context validation.
- `src/web/pageContext.js` — new resolver.
- `src/web/chatRuns.js` — thread `context` → resolve → pass `pageContext`.
- `src/agent/loop.js` — `buildUserContent` + `runAgent` param.
- Tests as above.

## Follow-ups (out of scope)

- Feed the resolved label to `enhancePrompt` so the user-visible "Interpreted:" line
  resolves deictic references too.
- Richer chip (beat *title*, not just order) via a shared `PageContext` provider.
- Per-message context tags in the transcript.
