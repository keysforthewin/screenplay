# Web Chat Page Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pass the web visitor's current page (beat / character / dialog / storyboard / overview) into the browser AI chat so the agent resolves "this beat", "here", "this character" to what the visitor is viewing.

**Architecture:** The SPA parses `useLocation().pathname` into a small `{ kind, ref }` descriptor (`web/src/project/pageContext.js`) and sends it with the chat text. `POST /api/chat` validates it against a kind allowlist (drops invalid, never 400s) and `chatRuns.js` re-resolves it against live Mongo into a short authoritative note (`src/web/pageContext.js`), which rides the existing ephemeral content-block mechanism in `buildUserContent` — so the shared Discord transcript stays clean.

**Tech Stack:** Node/Express backend, React/Vite SPA (react-router), Vitest + in-memory fake Mongo (`tests/_fakeMongo.js`).

**Spec:** `docs/superpowers/specs/2026-06-13-web-chat-page-context-design.md`

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `web/src/project/pageContext.js` | Pure: URL path → `{ kind, ref, label }` | **create** |
| `web/src/widgets/ChatDialog.jsx` | Read location, render chip, send `context` | modify |
| `web/src/styles.css` | `.chat-context-chip` styling | modify |
| `src/web/pageContext.js` | Pure-ish: `{ kind, ref }` → agent note via live Mongo | **create** |
| `src/web/entityRoutes.js` | `POST /chat` context validation | modify |
| `src/web/chatRuns.js` | Thread `context` → resolve note → pass `pageContext` | modify |
| `src/agent/loop.js` | `buildUserContent` + `runAgent` accept `pageContext` | modify |
| `tests/pageContextFromPath.test.js` | Parser unit test | **create** |
| `tests/pageContext.test.js` | Resolver unit test (fakeMongo) | **create** |
| `tests/buildUserContent-pagecontext.test.js` | Loop content-block test | **create** |
| `tests/web-chat-route.test.js` | Route integration assertions | modify |

`src/discord/messageHandler.js` is **deliberately untouched** — it calls `runAgent` without `pageContext`, which defaults `null`, so the Discord path is unchanged.

Task order is dependency-correct: 1 (parser) and 2 (resolver) and 3 (loop) are independent; 4 (route/run) depends on 2 and 3; 5 (client) depends on 1 and 4.

---

## Task 1: SPA page-context path parser

**Files:**
- Create: `web/src/project/pageContext.js`
- Test: `tests/pageContextFromPath.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/pageContextFromPath.test.js`:

```js
// Pure parser: the SPA's current path → the { kind, ref, label } descriptor
// the AI chat sends to the server. Lives in tests/ (node env) because the
// module under test has no React/JSX dependency.
import { describe, it, expect } from 'vitest';
import { pageContextFromPath } from '../web/src/project/pageContext.js';

describe('pageContextFromPath', () => {
  it('maps the project root to the overview', () => {
    expect(pageContextFromPath('/p/Heist/')).toEqual({ kind: 'overview', ref: null, label: 'Overview' });
    expect(pageContextFromPath('/p/Heist')).toEqual({ kind: 'overview', ref: null, label: 'Overview' });
  });

  it('maps a beat path to its order', () => {
    expect(pageContextFromPath('/p/Heist/beat/2')).toEqual({ kind: 'beat', ref: '2', label: 'Beat 2' });
  });

  it('maps a character path to its (decoded) name', () => {
    expect(pageContextFromPath('/p/Heist/character/Steve')).toEqual({
      kind: 'character', ref: 'Steve', label: 'Character: Steve',
    });
    expect(pageContextFromPath('/p/Heist/character/Steve%20Rogers')).toEqual({
      kind: 'character', ref: 'Steve Rogers', label: 'Character: Steve Rogers',
    });
  });

  it('distinguishes storyboard/dialog indexes from per-beat pages', () => {
    expect(pageContextFromPath('/p/Heist/storyboard')).toEqual({ kind: 'storyboard-index', ref: null, label: 'Storyboards' });
    expect(pageContextFromPath('/p/Heist/storyboard/3')).toEqual({ kind: 'storyboard', ref: '3', label: 'Storyboard · Beat 3' });
    expect(pageContextFromPath('/p/Heist/dialog')).toEqual({ kind: 'dialog-index', ref: null, label: 'Dialogs' });
    expect(pageContextFromPath('/p/Heist/dialog/3')).toEqual({ kind: 'dialog', ref: '3', label: 'Dialog · Beat 3' });
  });

  it('maps the singleton section pages', () => {
    expect(pageContextFromPath('/p/Heist/notes').kind).toBe('notes');
    expect(pageContextFromPath('/p/Heist/library').kind).toBe('library');
    expect(pageContextFromPath('/p/Heist/about').kind).toBe('about');
  });

  it('falls back to overview for unknown subpaths', () => {
    expect(pageContextFromPath('/p/Heist/something/weird').kind).toBe('overview');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pageContextFromPath.test.js`
Expected: FAIL — `Failed to resolve import "../web/src/project/pageContext.js"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `web/src/project/pageContext.js`:

```js
// Derive the "what page am I on" descriptor for the AI chat from the SPA's
// current location. Pure function (no React) so it is unit-testable and can be
// imported from the node test runner. The chat sends { kind, ref } to the
// server, which re-resolves the live entity; `label` is the terse chip text.
//
// Routes live under /p/:projectTitle/* (see web/src/App.jsx); strip that prefix
// and match the remainder against the project-scoped route table. Per-beat
// storyboard/dialog regexes are checked before the bare index paths.

export function pageContextFromPath(pathname) {
  const remainder = String(pathname || '').replace(/^\/p\/[^/]+/, '') || '/';

  const beat = remainder.match(/^\/beat\/(.+)$/);
  if (beat) {
    const ref = decodeURIComponent(beat[1]);
    return { kind: 'beat', ref, label: `Beat ${ref}` };
  }
  const character = remainder.match(/^\/character\/(.+)$/);
  if (character) {
    const ref = decodeURIComponent(character[1]);
    return { kind: 'character', ref, label: `Character: ${ref}` };
  }
  const storyboardBeat = remainder.match(/^\/storyboard\/(.+)$/);
  if (storyboardBeat) {
    const ref = decodeURIComponent(storyboardBeat[1]);
    return { kind: 'storyboard', ref, label: `Storyboard · Beat ${ref}` };
  }
  const dialogBeat = remainder.match(/^\/dialog\/(.+)$/);
  if (dialogBeat) {
    const ref = decodeURIComponent(dialogBeat[1]);
    return { kind: 'dialog', ref, label: `Dialog · Beat ${ref}` };
  }
  if (remainder === '/storyboard') return { kind: 'storyboard-index', ref: null, label: 'Storyboards' };
  if (remainder === '/dialog') return { kind: 'dialog-index', ref: null, label: 'Dialogs' };
  if (remainder === '/notes') return { kind: 'notes', ref: null, label: 'Notes' };
  if (remainder === '/library') return { kind: 'library', ref: null, label: 'Library' };
  if (remainder === '/about') return { kind: 'about', ref: null, label: 'About' };

  return { kind: 'overview', ref: null, label: 'Overview' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pageContextFromPath.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/project/pageContext.js tests/pageContextFromPath.test.js
git commit -m "✨ Add SPA page-context path parser"
```

---

## Task 2: Backend page-context resolver

**Files:**
- Create: `src/web/pageContext.js`
- Test: `tests/pageContext.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/pageContext.test.js`:

```js
// resolvePageContextNote turns the SPA's { kind, ref } page descriptor into a
// short authoritative note injected into the web chat agent turn. Entity kinds
// resolve against live Mongo (here: the in-memory fake); a ref that no longer
// resolves yields null so the caller omits the block.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const Projects = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const { resolvePageContextNote } = await import('../src/web/pageContext.js');

let pid;
beforeEach(async () => {
  fakeDb.reset();
  const project = await Projects.createProject('Western');
  pid = project._id.toString();
  await Plots.createBeat({ projectId: pid, name: 'The Heist', desc: 'heist', body: 'rob bank', order: 2 });
  await Characters.createCharacter({ projectId: pid, name: 'Steve' });
});

const resolve = (context) => resolvePageContextNote({ projectId: pid, projectTitle: 'Western', context });

describe('resolvePageContextNote', () => {
  it('resolves a beat by order to a note with name + id', async () => {
    const note = await resolve({ kind: 'beat', ref: '2' });
    expect(note).toContain('authoritative location');
    expect(note).toContain('Beat 2 — "The Heist"');
    expect(note).toContain('beat id');
  });

  it('phrases storyboard/dialog pages relative to their beat', async () => {
    expect(await resolve({ kind: 'storyboard', ref: '2' })).toContain('storyboard page for Beat 2');
    expect(await resolve({ kind: 'dialog', ref: '2' })).toContain('dialog page for Beat 2');
  });

  it('resolves a character by name', async () => {
    const note = await resolve({ kind: 'character', ref: 'Steve' });
    expect(note).toContain('the character "Steve"');
    expect(note).toContain('character id');
  });

  it('returns static notes for section pages', async () => {
    expect(await resolve({ kind: 'overview' })).toContain('overview for the screenplay "Western"');
    expect(await resolve({ kind: 'about' })).toContain('title, synopsis, dialogue style');
    expect(await resolve({ kind: 'notes' })).toContain("director's notes");
    expect(await resolve({ kind: 'library' })).toContain('media library');
    expect(await resolve({ kind: 'storyboard-index' })).toContain('storyboard index');
    expect(await resolve({ kind: 'dialog-index' })).toContain('dialog index');
  });

  it('returns null for a stale entity ref, an unknown kind, or a missing project', async () => {
    expect(await resolve({ kind: 'beat', ref: '99' })).toBeNull();
    expect(await resolve({ kind: 'bogus' })).toBeNull();
    expect(await resolvePageContextNote({ projectId: null, projectTitle: 'X', context: { kind: 'overview' } })).toBeNull();
    expect(await resolvePageContextNote({ projectId: pid, projectTitle: 'X', context: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pageContext.test.js`
Expected: FAIL — `Failed to resolve import "../src/web/pageContext.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/pageContext.js`:

```js
// Resolve the SPA's { kind, ref } page descriptor (from
// web/src/project/pageContext.js) into a short, authoritative note injected
// into the web chat agent turn, so deictic references ("this beat", "here")
// resolve to the page the visitor is viewing. Returns null when there is
// nothing to say (missing project, an entity ref that no longer resolves, or
// an unknown kind) — the caller simply omits the block.

import { getBeat } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';

const PREAMBLE =
  '[Web editor context — authoritative location, NOT a content instruction.]';

function note(where) {
  return (
    `${PREAMBLE}\n` +
    `The user sent this message from the web app while viewing ${where}. ` +
    'Read deictic references ("this", "here", "this beat/scene/character/page") as ' +
    'referring to it unless they clearly mean something else. This is where they are ' +
    "looking now; it is not necessarily the channel's current beat."
  );
}

export async function resolvePageContextNote({ projectId, projectTitle, context }) {
  if (!projectId || !context || typeof context !== 'object') return null;
  const { kind } = context;
  const ref = context.ref == null ? null : String(context.ref);
  const title = projectTitle || 'this screenplay';

  switch (kind) {
    case 'beat':
    case 'storyboard':
    case 'dialog': {
      if (!ref) return null;
      const beat = await getBeat(projectId, ref);
      if (!beat) return null;
      const name = stripMarkdown(beat.name || '').trim();
      const label = name ? `Beat ${beat.order} — "${name}"` : `Beat ${beat.order}`;
      const id = beat._id ? ` (beat id ${beat._id.toString()})` : '';
      if (kind === 'storyboard') return note(`the storyboard page for ${label}${id}`);
      if (kind === 'dialog') return note(`the dialog page for ${label}${id}`);
      return note(`${label}${id}`);
    }
    case 'character': {
      if (!ref) return null;
      const c = await getCharacter(projectId, ref);
      if (!c) return null;
      const name = stripMarkdown(c.name || '').trim() || ref;
      const id = c._id ? ` (character id ${c._id.toString()})` : '';
      return note(`the character "${name}"${id}`);
    }
    case 'overview':
      return note(`the table of contents / overview for the screenplay "${title}"`);
    case 'about':
      return note(`the screenplay overview page (title, synopsis, dialogue style) for "${title}"`);
    case 'notes':
      return note("the director's notes");
    case 'library':
      return note('the media library');
    case 'storyboard-index':
      return note("the storyboard index (all beats' storyboards)");
    case 'dialog-index':
      return note("the dialog index (all beats' dialogs)");
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pageContext.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/pageContext.js tests/pageContext.test.js
git commit -m "✨ Add web chat page-context resolver"
```

---

## Task 3: Thread `pageContext` through the agent loop

**Files:**
- Modify: `src/agent/loop.js` (`buildUserContent` ~169-216, `runAgent` ~405-438)
- Test: `tests/buildUserContent-pagecontext.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/buildUserContent-pagecontext.test.js`:

```js
// The web chat injects a page-context block into the live agent turn. It must
// appear only when provided, and sit after the user text but before the
// (non-authoritative) prompt-enhancer notes block.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() { this.messages = { create: vi.fn(), countTokens: vi.fn() }; }
  },
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => ({}),
  connectMongo: async () => ({}),
}));

const { buildUserContent } = await import('../src/agent/loop.js');

const texts = (content) => content.filter((c) => c.type === 'text').map((c) => c.text);

describe('buildUserContent pageContext block', () => {
  it('omits the block when pageContext is null', () => {
    expect(texts(buildUserContent('hello', [], null, null, null))).toEqual(['hello']);
  });

  it('appends the block after the user text', () => {
    expect(texts(buildUserContent('hello', [], null, null, 'PAGE NOTE'))).toEqual(['hello', 'PAGE NOTE']);
  });

  it('orders page context before enhancement notes', () => {
    const out = texts(buildUserContent('hello', [], 'ENH', null, 'PAGE NOTE'));
    expect(out[0]).toBe('hello');
    expect(out[1]).toBe('PAGE NOTE');
    expect(out[2]).toContain('ENH');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/buildUserContent-pagecontext.test.js`
Expected: FAIL — the second test gets `['hello']` (no page block appended yet) and the assertion `toEqual(['hello', 'PAGE NOTE'])` fails.

- [ ] **Step 3a: Add the `pageContext` parameter and block to `buildUserContent`**

In `src/agent/loop.js`, change the signature (around line 169):

```js
export function buildUserContent(
  userText,
  attachments,
  enhancementNotes = null,
  senderName = null,
  pageContext = null,
) {
```

Then, where the main text block is pushed (around line 208), insert the page-context block between it and the enhancement-notes block:

```js
  content.push({ type: 'text', text });
  if (typeof pageContext === 'string' && pageContext.trim()) {
    content.push({ type: 'text', text: pageContext.trim() });
  }
  if (typeof enhancementNotes === 'string' && enhancementNotes.trim()) {
    content.push({
      type: 'text',
      text: `${ENHANCEMENT_PREAMBLE}\n\n${enhancementNotes.trim()}`,
    });
  }
  return content;
```

- [ ] **Step 3b: Pass `pageContext` from `runAgent`**

In `runAgent`'s destructured options (around line 415), add the param after `webRun = false,`:

```js
  onEvent = null,
  webRun = false,
  pageContext = null,
}) {
```

And update the `buildUserContent` call (around line 436):

```js
      content: buildUserContent(userText, attachments, enhancementNotes, senderName, pageContext),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/buildUserContent-pagecontext.test.js`
Expected: PASS (3 tests).

Then confirm the existing loop test still passes:
Run: `npx vitest run tests/agent-loop-onevent.test.js`
Expected: PASS (unchanged — `pageContext` defaults `null`).

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.js tests/buildUserContent-pagecontext.test.js
git commit -m "✨ Thread pageContext through the agent loop"
```

---

## Task 4: Wire page context into the web chat route + run

**Files:**
- Modify: `src/web/entityRoutes.js` (module scope near line 182; `POST /chat` ~478-497)
- Modify: `src/web/chatRuns.js` (imports; `startChatRun` ~144; `executeChatRun` ~178-259)
- Test: `tests/web-chat-route.test.js` (imports ~37-40; new `it` blocks in `describe('POST /api/chat')`)

- [ ] **Step 1: Write the failing tests**

In `tests/web-chat-route.test.js`, add a `Plots` import next to the existing dynamic imports (after line 39, `const ChatRuns = ...`):

```js
const Plots = await import('../src/mongo/plots.js');
```

Then add these two tests inside `describe('POST /api/chat', () => {` (e.g. after the existing `'400s on empty or oversized text'` test):

```js
  it('resolves the page context and threads it to the agent', async () => {
    const project = await Projects.createProject('Western');
    const pid = project._id.toString();
    await Plots.createBeat({ projectId: pid, name: 'The Heist', desc: 'heist', body: 'rob bank', order: 1 });

    const r = await post(
      '/chat',
      { text: 'make this beat tenser', context: { kind: 'beat', ref: '1' } },
      { 'X-Project-Id': pid },
    );
    expect(r.status).toBe(202);
    const { run_id } = await r.json();
    await waitForRun(run_id);

    const args = runAgentMock.mock.calls[0][0];
    expect(args.pageContext).toContain('Beat 1 — "The Heist"');
    expect(args.pageContext).toContain('authoritative location');
  });

  it('omits page context when none is sent and ignores invalid context without erroring', async () => {
    const project = await Projects.createProject('Western');
    const pid = project._id.toString();

    const r1 = await post('/chat', { text: 'hello' }, { 'X-Project-Id': pid });
    expect(r1.status).toBe(202);
    await waitForRun((await r1.json()).run_id);
    expect(runAgentMock.mock.calls[0][0].pageContext).toBeNull();

    runAgentMock.mockClear();
    const r2 = await post('/chat', { text: 'hello', context: { kind: 'bogus' } }, { 'X-Project-Id': pid });
    expect(r2.status).toBe(202); // invalid context is dropped, not a 400
    await waitForRun((await r2.json()).run_id);
    expect(runAgentMock.mock.calls[0][0].pageContext).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web-chat-route.test.js -t "page context"`
Expected: FAIL — `args.pageContext` is `undefined` (route/run don't pass it yet), so `expect(...).toContain(...)` / `toBeNull()` fail.

- [ ] **Step 3a: Validate `context` in the route**

In `src/web/entityRoutes.js`, add a module-scope allowlist + parser near the other constants (e.g. just after `const HEX24 = ...` around line 182):

```js
const ALLOWED_CONTEXT_KINDS = new Set([
  'overview', 'beat', 'character', 'notes', 'library',
  'storyboard', 'storyboard-index', 'dialog', 'dialog-index', 'about',
]);

// Parse the SPA's optional page-context hint from a /chat body. Unknown/malformed
// context returns null and is simply not forwarded — a stale SPA bundle must
// never turn a chat message into a 400.
function parseChatContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = String(raw.kind || '');
  if (!ALLOWED_CONTEXT_KINDS.has(kind)) return null;
  let ref = raw.ref == null ? null : String(raw.ref).trim().slice(0, 80);
  if (ref === '') ref = null;
  return { kind, ref };
}
```

Then, in the `router.post('/chat', ...)` handler, replace the `startChatRun({...})` call (around line 487) with a version that parses and forwards `context`:

```js
      const context = parseChatContext(req.body?.context);
      const run = startChatRun({
        projectId: req.projectId,
        projectTitle: req.projectTitle,
        session: req.session,
        text,
        context,
      });
```

- [ ] **Step 3b: Resolve + forward `pageContext` in the run**

In `src/web/chatRuns.js`, add the resolver import next to the other imports (after the `pdfLink` import around line 31):

```js
import { resolvePageContextNote } from './pageContext.js';
```

Change `startChatRun`'s signature (around line 144) to accept `context` and forward it:

```js
export function startChatRun({ projectId, projectTitle, session, text, context = null }) {
```

and update the `executeChatRun` invocation inside it (around line 161):

```js
    .run(channelId, () => executeChatRun({ run, channelId, projectId, projectTitle, session, text, context }))
```

Change `executeChatRun`'s signature (around line 178) to accept `context`:

```js
async function executeChatRun({ run, channelId, projectId, projectTitle, session, text, context }) {
```

Then resolve the note just before the `addProgress(run, 'thinking…')` line (around line 243) and pass it into `runAgent` (around line 244-259):

```js
    let pageContext = null;
    try {
      pageContext = await resolvePageContextNote({ projectId, projectTitle, context });
    } catch (e) {
      logger.warn(`chat run: page context resolve failed: ${e.message}`);
    }

    addProgress(run, 'thinking…');
    const result = await runAgent({
      history,
      userText: text,
      attachments: [],
      discordUser,
      channelId,
      enhancementNotes: enhancement.notes,
      projectId,
      projectTitle,
      webRun: true,
      pageContext,
      onEvent: (ev) => {
        if (ev?.type === 'tools') {
          for (const name of ev.tools || []) addProgress(run, `calling ${name}…`);
        }
      },
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/web-chat-route.test.js`
Expected: PASS (all tests in the file, including the two new ones and the unchanged originals).

- [ ] **Step 5: Commit**

```bash
git add src/web/entityRoutes.js src/web/chatRuns.js tests/web-chat-route.test.js
git commit -m "✨ Wire page context into the web chat route"
```

---

## Task 5: Send & show current-page context in the chat dialog

**Files:**
- Modify: `web/src/widgets/ChatDialog.jsx`
- Modify: `web/src/styles.css` (after `.chat-interpreted`, ~line 2603)

No automated test — the repo has no React component test harness (Vitest runs node-env backend tests). The parser logic is covered by Task 1; this task is verified by a production build + manual smoke.

- [ ] **Step 1: Read the current location and send it**

In `web/src/widgets/ChatDialog.jsx`, update the React import (line 1) to add `useMemo`:

```js
import { useEffect, useMemo, useRef, useState } from 'react';
```

Add the router + parser imports below the existing imports (after line 4):

```js
import { useLocation } from 'react-router-dom';
import { pageContextFromPath } from '../project/pageContext.js';
```

At the top of the `ChatDialog` component body (right after `export function ChatDialog(...) {`, line 69), derive the page context:

```js
  const location = useLocation();
  const pageCtx = useMemo(() => pageContextFromPath(location.pathname), [location.pathname]);
```

In `send()`, change the POST (line 114) to include the context:

```js
      const r = await apiPostJson('/chat', { text, context: { kind: pageCtx.kind, ref: pageCtx.ref } });
```

- [ ] **Step 2: Render the context chip**

In the dialog JSX, add the chip between the error banner and the input row (around line 181-182):

```jsx
        {error && <div className="error-banner">{error}</div>}
        <div className="chat-context-chip" title="The agent is told which page you're on">
          Context: {pageCtx.label}
        </div>
        <div className="chat-input-row">
```

- [ ] **Step 3: Style the chip**

In `web/src/styles.css`, add after the `.chat-interpreted { ... }` block (around line 2603, before `.chat-input-row`):

```css
.chat-context-chip {
  align-self: flex-start;
  margin-bottom: 8px;
  padding: 2px 10px;
  border: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.35));
  border-radius: 999px;
  color: var(--fg-muted);
  font-size: 12px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
```

- [ ] **Step 4: Verify the SPA builds**

Run: `npm run build:web`
Expected: build succeeds with no errors (catches JSX/import mistakes). 

- [ ] **Step 5: Manual smoke (requires Mongo + running app)**

Run the app (`npm run dev`, with the SPA dev server `npm run dev:web` or a built SPA), open a project, navigate to a beat (e.g. `/p/<title>/beat/2`), open **✨ AI chat**, and confirm:
1. A `Context: Beat 2` chip shows above the input.
2. Asking "what is this beat about?" makes the agent answer about beat 2 (not the channel's current beat).
3. Network tab: the `POST /api/chat` body contains `context: { kind: 'beat', ref: '2' }`.

- [ ] **Step 6: Commit**

```bash
git add web/src/widgets/ChatDialog.jsx web/src/styles.css
git commit -m "✨ Send & show current-page context in AI chat"
```

---

## Task 6: Full verification

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — the whole suite green, including the four new/extended test files.

- [ ] **Step 2: Build the SPA one more time**

Run: `npm run build:web`
Expected: success.

- [ ] **Step 3: Confirm the Discord path is untouched**

Run: `npx vitest run tests/agent-loop-onevent.test.js`
Expected: PASS — `runAgent` without `pageContext` behaves exactly as before (`pageContext` defaults `null`, no extra content block).

---

## Self-review notes

- **Spec coverage:** parser (§1 → Task 1), resolver + note format + kind mapping (§5 → Task 2), loop injection + ordering (§7 → Task 3), route validation + drop-not-400 + run threading (§4/§6 → Task 4), client send + chip + CSS (§1/§2/§3 → Task 5), Discord-unaffected (Task 3 step 4 + Task 6 step 3). Testing section (§Testing) → Tasks 1,2,3,4 tests.
- **Type/name consistency:** `pageContextFromPath` returns `{ kind, ref, label }` everywhere; `resolvePageContextNote({ projectId, projectTitle, context })` and `parseChatContext(raw) → { kind, ref } | null` match between route, run, and tests; `runAgent`/`buildUserContent` use `pageContext` consistently.
- **No content snippets / no enhancer change / no per-message tags** — honored (spec non-goals).
