# Writing & Cast Edit Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Announce in the Discord channel when a human edits a beat's writing (body/name/desc) or its cast, or edits a character's text fields — rate-limited to one announcement per editor per target per 24h.

**Architecture:** A Mongo-backed throttle (`edit_announcements`, TTL-expiring rows) gates announcements via `claimAnnouncement()`. Text edits are detected in a new Hocuspocus `onChange` hook that diffs a per-room markdown cache and attributes each change to its originating connection (skipping `actor:'bot'`). Cast changes are detected by diffing the `characters` name array in `PATCH /beat/:id`. All messages reuse the existing `announceMediaEvent` embed.

**Tech Stack:** Node ESM, MongoDB driver, Hocuspocus 2.15, Vitest with the in-memory `tests/_fakeMongo.js`.

## Global Constraints

- **Project-scoping:** every project-scoped Mongo helper takes `projectId` (24-hex string) as its first parameter and **throws `projectId required`** on a falsy value. Copy this guard into `claimAnnouncement`.
- **Optional-integration pattern:** announcement code is best-effort. A failure in the announce path must never throw into y-doc persistence, the agent loop, or a REST response. Wrap fire calls so they log and swallow.
- **No co-author/attribution lines in commits** (a hook strips them). Use the emoji-prefixed commit style already in the repo history.
- **Bot edits are excluded:** any text mutation whose Hocuspocus connection context has `actor === 'bot'` (gateway writes, AI-chat undo/redo) must never announce.
- **`beat.characters` is an array of plain name strings**, deduped case-insensitively (`dedupeNames` in `src/mongo/plots.js`). Cast diffing is a string-set comparison.
- Run the full suite with `npm test` (Vitest). Single file: `npx vitest run tests/<file>.test.js`.

---

### Task 1: Throttle store — `claimAnnouncement` + indexes

**Files:**
- Create: `src/mongo/editAnnouncements.js`
- Modify: `src/mongo/client.js` (add two indexes inside `connectMongo()`, after the existing `createIndex` block ending near line 118)
- Test: `tests/editAnnouncements.test.js`

**Interfaces:**
- Consumes: `getDb()` from `src/mongo/client.js`.
- Produces:
  - `claimAnnouncement({ projectId, targetType, targetId, editor }): Promise<boolean>` — returns `true` exactly once per `(projectId, targetType, targetId, editor)` per ~24h window (first caller inserts the row and gets `true`; later callers get `false` until the row TTL-expires).

**Design note:** Implemented with an idempotent upsert (`$setOnInsert`) rather than insert-then-catch, so it works against `tests/_fakeMongo.js` unchanged. `created_at` is set only on insert; a TTL index expires the row ~24h later, giving a fixed (non-sliding) window. `E11000` from a concurrent-upsert race is treated as "not claimed" (`false`).

- [ ] **Step 1: Write the failing test**

Create `tests/editAnnouncements.test.js` (header mirrors `tests/beats.test.js`: synchronous `_fakeMongo` import + top-level `fakeDb`, then `vi.mock`, then the dynamic import of the module under test):

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { claimAnnouncement } = await import('../src/mongo/editAnnouncements.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('claimAnnouncement', () => {
  const base = { projectId: 'p1', targetType: 'beat', targetId: 'b1', editor: 'alice' };

  it('returns true the first time and false the second time for the same key', async () => {
    expect(await claimAnnouncement(base)).toBe(true);
    expect(await claimAnnouncement(base)).toBe(false);
  });

  it('returns true for a different editor on the same target', async () => {
    expect(await claimAnnouncement(base)).toBe(true);
    expect(await claimAnnouncement({ ...base, editor: 'bob' })).toBe(true);
  });

  it('returns true for a different target for the same editor', async () => {
    expect(await claimAnnouncement(base)).toBe(true);
    expect(await claimAnnouncement({ ...base, targetId: 'b2' })).toBe(true);
  });

  it('throws when projectId is falsy', async () => {
    await expect(claimAnnouncement({ ...base, projectId: '' })).rejects.toThrow('projectId required');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editAnnouncements.test.js`
Expected: FAIL — cannot resolve `../src/mongo/editAnnouncements.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mongo/editAnnouncements.js`:

```js
// Rate-limit store for SPA edit announcements. One row means "this editor has
// already been announced for this target within the current ~24h window". Rows
// self-expire via a TTL index on `created_at` (see connectMongo in client.js),
// so the window is fixed from the announcement and resets automatically.

import { getDb } from './client.js';

const COLLECTION = 'edit_announcements';

// Returns true exactly once per (projectId, targetType, targetId, editor) per
// window. The first caller inserts the row (true); later callers match the
// existing row and get false until it TTL-expires.
export async function claimAnnouncement({ projectId, targetType, targetId, editor }) {
  if (!projectId) throw new Error('projectId required');
  const key = {
    project_id: projectId,
    target_type: targetType,
    target_id: targetId,
    editor,
  };
  try {
    const res = await getDb()
      .collection(COLLECTION)
      .updateOne(key, { $setOnInsert: { ...key, created_at: new Date() } }, { upsert: true });
    return res.upsertedId != null || res.upsertedCount === 1;
  } catch (e) {
    // Concurrent upsert race under the unique index surfaces as E11000 — treat
    // it as "someone else already claimed this window".
    if (e?.code === 11000) return false;
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editAnnouncements.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the indexes**

In `src/mongo/client.js`, inside `connectMongo()`, immediately after the `plots` index block (around line 118-124, before `}` closing the index section), add:

```js
  await db
    .collection('edit_announcements')
    .createIndex(
      { project_id: 1, target_type: 1, target_id: 1, editor: 1 },
      { unique: true },
    );
  await db
    .collection('edit_announcements')
    .createIndex({ created_at: 1 }, { expireAfterSeconds: 86400 });
```

- [ ] **Step 6: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: PASS (existing tests + the 4 new ones).

- [ ] **Step 7: Commit**

```bash
git add src/mongo/editAnnouncements.js src/mongo/client.js tests/editAnnouncements.test.js
git commit -m "✨ Add edit-announcement throttle store (claimAnnouncement + TTL)"
```

---

### Task 2: Pure announce helpers — selectors, cast diff, message payloads

**Files:**
- Create: `src/web/editAnnounce.js` (pure-helper section only; stateful section added in Task 3)
- Test: `tests/editAnnounce.helpers.test.js`

**Interfaces:**
- Consumes: `stripMarkdown` from `src/util/markdown.js`; `beatUrl`, `characterUrl` from `src/web/links.js`.
- Produces:
  - `announceFieldsForDesc(desc): string[]` — beat → `['name','body','desc']` (intersected with `desc.fields`); character → `desc.fields` minus any field starting with `image:` or `attachment:`; anything else → `[]`.
  - `diffCast(oldNames, newNames): { added: string[], removed: string[] }` — case-insensitive set diff preserving the casing from each side; `added` from `newNames`, `removed` from `oldNames`.
  - `joinNames(names): string` — `"A"`, `"A and B"`, `"A, B, and C"`.
  - `buildWritingPayload({ who, beat, projectTitle }): object` — `announceMediaEvent` payload.
  - `buildCharacterPayload({ who, character, projectTitle }): object`.
  - `buildCastPayload({ who, beat, projectTitle, added, removed }): object`.
  - `beatLabel(beat): string` / `characterLabel(character): string` (mirrors the existing private helpers in `announceHelpers.js`).

- [ ] **Step 1: Write the failing test**

Create `tests/editAnnounce.helpers.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  announceFieldsForDesc,
  diffCast,
  joinNames,
  buildWritingPayload,
  buildCharacterPayload,
  buildCastPayload,
} from '../src/web/editAnnounce.js';

describe('announceFieldsForDesc', () => {
  it('returns name/body/desc for a beat, excluding scene_bible and captions', () => {
    const desc = {
      type: 'beat',
      fields: ['name', 'body', 'desc', 'scene_bible.location', 'image:aaa:name'],
    };
    expect(announceFieldsForDesc(desc).sort()).toEqual(['body', 'desc', 'name']);
  });

  it('returns text fields for a character, excluding image/attachment captions', () => {
    const desc = {
      type: 'character',
      fields: ['name', 'hollywood_actor', 'fields.bio', 'image:aaa:name', 'attachment:bbb:description'],
    };
    expect(announceFieldsForDesc(desc).sort()).toEqual(['fields.bio', 'hollywood_actor', 'name']);
  });

  it('returns [] for other room types', () => {
    expect(announceFieldsForDesc({ type: 'storyboards', fields: ['item:x:summary'] })).toEqual([]);
  });
});

describe('diffCast', () => {
  it('detects adds and removes case-insensitively', () => {
    expect(diffCast(['Steve', 'Mary'], ['mary', 'Bob'])).toEqual({ added: ['Bob'], removed: ['Steve'] });
  });
  it('returns empty arrays when unchanged', () => {
    expect(diffCast(['A'], ['a'])).toEqual({ added: [], removed: [] });
  });
});

describe('joinNames', () => {
  it('formats one, two, and three names', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B, and C');
  });
});

describe('message payload builders', () => {
  const beat = { _id: 'b1', order: 22, name: '**The Heist**' };
  it('writing payload', () => {
    const p = buildWritingPayload({ who: 'Steve', beat, projectTitle: 'Film' });
    expect(p.username).toBe('Steve');
    expect(p.verb).toBe('edited the writing in');
    expect(p.entityLabel).toBe('Beat 22: The Heist');
  });
  it('character payload', () => {
    const p = buildCharacterPayload({ who: 'Steve', character: { name: 'Mary' }, projectTitle: 'Film' });
    expect(p.verb).toBe('edited');
    expect(p.entityLabel).toBe('Character: Mary');
  });
  it('cast payload: only adds', () => {
    const p = buildCastPayload({ who: 'Steve', beat, projectTitle: 'Film', added: ['Mary'], removed: [] });
    expect(p.verb).toBe('added Mary to');
    expect(p.entityLabel).toBe('Beat 22: The Heist');
  });
  it('cast payload: only removes', () => {
    const p = buildCastPayload({ who: 'Steve', beat, projectTitle: 'Film', added: [], removed: ['Bob'] });
    expect(p.verb).toBe('removed Bob from');
  });
  it('cast payload: mixed uses generic verb + detail prompt', () => {
    const p = buildCastPayload({ who: 'Steve', beat, projectTitle: 'Film', added: ['Mary'], removed: ['Bob'] });
    expect(p.verb).toBe('changed the cast of');
    expect(p.prompt).toContain('Added Mary');
    expect(p.prompt).toContain('removed Bob');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editAnnounce.helpers.test.js`
Expected: FAIL — cannot resolve `../src/web/editAnnounce.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/editAnnounce.js`:

```js
// Announcements for SPA writing edits (beat body/name/desc), character text
// edits, and beat cast changes. Pure helpers here; the Hocuspocus-facing cache
// and fire functions live in the second half of this file (added in Task 3).

import { stripMarkdown } from '../util/markdown.js';
import { beatUrl, characterUrl } from './links.js';

const BEAT_WRITING_FIELDS = ['name', 'body', 'desc'];

// Which fragments in a resolved room count as an announce-worthy text edit.
// Beats: name/body/desc only (excludes scene_bible.* and image/attachment
// captions). Characters: every text field except media caption fragments.
export function announceFieldsForDesc(desc) {
  if (!desc) return [];
  if (desc.type === 'beat') {
    return (desc.fields || []).filter((f) => BEAT_WRITING_FIELDS.includes(f));
  }
  if (desc.type === 'character') {
    return (desc.fields || []).filter(
      (f) => !f.startsWith('image:') && !f.startsWith('attachment:'),
    );
  }
  return [];
}

export function diffCast(oldNames, newNames) {
  const norm = (s) => String(s).trim().toLowerCase();
  const oldSet = new Set((oldNames || []).map(norm));
  const newSet = new Set((newNames || []).map(norm));
  const added = (newNames || []).filter((n) => !oldSet.has(norm(n)));
  const removed = (oldNames || []).filter((n) => !newSet.has(norm(n)));
  return { added, removed };
}

export function joinNames(names) {
  const arr = (names || []).map((n) => stripMarkdown(String(n)).trim()).filter(Boolean);
  if (arr.length <= 1) return arr.join('');
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`;
}

export function beatLabel(beat) {
  if (!beat) return 'a beat';
  const name = stripMarkdown(beat.name || '').trim();
  const order = Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
  return name ? `${order}: ${name}` : order;
}

export function characterLabel(character) {
  if (!character) return 'a character';
  const name = stripMarkdown(character.name || '').trim() || 'character';
  return `Character: ${name}`;
}

export function buildWritingPayload({ who, beat, projectTitle }) {
  return {
    username: who,
    verb: 'edited the writing in',
    entityLabel: beatLabel(beat),
    entityUrl: beatUrl(projectTitle ?? null, beat),
  };
}

export function buildCharacterPayload({ who, character, projectTitle }) {
  return {
    username: who,
    verb: 'edited',
    entityLabel: characterLabel(character),
    entityUrl: characterUrl(projectTitle ?? null, character),
  };
}

export function buildCastPayload({ who, beat, projectTitle, added, removed }) {
  const a = joinNames(added);
  const r = joinNames(removed);
  let verb;
  let prompt;
  if (a && !r) {
    verb = `added ${a} to`;
  } else if (r && !a) {
    verb = `removed ${r} from`;
  } else {
    verb = 'changed the cast of';
    const parts = [];
    if (a) parts.push(`Added ${a}`);
    if (r) parts.push(`removed ${r}`);
    prompt = `${parts.join('; ')}.`;
  }
  return {
    username: who,
    verb,
    entityLabel: beatLabel(beat),
    entityUrl: beatUrl(projectTitle ?? null, beat),
    ...(prompt ? { prompt } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editAnnounce.helpers.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/editAnnounce.js tests/editAnnounce.helpers.test.js
git commit -m "✨ Add pure helpers for writing/cast edit announcements"
```

---

### Task 3: Stateful layer — room cache, change handler, cast announce

**Files:**
- Modify: `src/web/editAnnounce.js` (append the stateful section)
- Test: `tests/editAnnounce.integration.test.js`

**Interfaces:**
- Consumes: `claimAnnouncement` (Task 1); pure helpers (Task 2); `fragmentToMarkdown` from `src/web/headlessEditor.js`; `announceMediaEvent` from `src/discord/announcer.js`; `getDb` from `src/mongo/client.js`; `getProjectById` from `src/mongo/projects.js`; `logger` from `src/log.js`; `ObjectId` from `mongodb`.
- Produces:
  - `primeRoomCache(documentName, desc): void` — stores `{ type, announceFields, values: Map<field,string> }` for beat/character rooms; no-op otherwise.
  - `forgetRoomCache(documentName): void`.
  - `handleRoomChange({ documentName, document, context }): Promise<void>` — best-effort; renders the cached announce-fields, diffs, attributes to `context.user.name` (skips `context.actor==='bot'` and missing user), claims, and fires.
  - `maybeAnnounceCast({ projectId, projectTitle, beat, editor, added, removed }): Promise<void>` — claims the beat bucket and fires the cast payload if claimed; best-effort.
  - `_resetCacheForTests(): void` — clears the module cache between tests.

- [ ] **Step 1: Write the failing test**

Create `tests/editAnnounce.integration.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import { ObjectId } from 'mongodb';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

// Stub the JSDOM-heavy markdown renderer: return whatever text the test stashed
// on the fake document for that field.
vi.mock('../src/web/headlessEditor.js', () => ({
  fragmentToMarkdown: (document, field) => document.__fields[field] ?? '',
  setFragmentMarkdown: () => {},
}));

const announceCalls = [];
vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: async (payload) => {
    announceCalls.push(payload);
  },
  announceText: async () => {},
}));

const Projects = await import('../src/mongo/projects.js');
const {
  primeRoomCache,
  forgetRoomCache,
  handleRoomChange,
  maybeAnnounceCast,
  _resetCacheForTests,
} = await import('../src/web/editAnnounce.js');

let projectId;
let beatId;

beforeEach(async () => {
  fakeDb.reset();
  announceCalls.length = 0;
  _resetCacheForTests();
  const proj = await Projects.createProject('Film');
  projectId = proj._id.toString();
  beatId = new ObjectId();
  await fakeDb.collection('plots').insertOne({
    _id: new ObjectId(),
    project_id: projectId,
    title: 'Film',
    beats: [{ _id: beatId, order: 1, name: 'Scene One', body: 'old body', desc: '', images: [], attachments: [] }],
  });
});
```

Add the test bodies:

```js
function beatRoom() {
  return `beat:${beatId.toString()}`;
}

function fakeDoc(fields) {
  return { __fields: fields };
}

const beatDesc = () => ({
  type: 'beat',
  id: beatId.toString(),
  fields: ['name', 'body', 'desc', 'scene_bible.location'],
  seed: { name: 'Scene One', body: 'old body', desc: '', 'scene_bible.location': '' },
});

describe('handleRoomChange (beat writing edits)', () => {
  it('announces once for a human body edit', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'NEW body', desc: '' }),
      context: { user: { name: 'Alice' } },
    });
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].verb).toBe('edited the writing in');
    expect(announceCalls[0].username).toBe('Alice');
  });

  it('does not announce a second edit by the same person within the window', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    const ctx = { user: { name: 'Alice' } };
    await handleRoomChange({ documentName: beatRoom(), document: fakeDoc({ name: 'Scene One', body: 'b1', desc: '' }), context: ctx });
    await handleRoomChange({ documentName: beatRoom(), document: fakeDoc({ name: 'Scene One', body: 'b2', desc: '' }), context: ctx });
    expect(announceCalls).toHaveLength(1);
  });

  it('never announces bot edits', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'bot wrote this', desc: '' }),
      context: { actor: 'bot' },
    });
    expect(announceCalls).toHaveLength(0);
  });

  it('does not announce when only a non-announce field changed', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      // body/name/desc unchanged vs seed; scene_bible isn't an announce field
      document: fakeDoc({ name: 'Scene One', body: 'old body', desc: '' }),
      context: { user: { name: 'Alice' } },
    });
    expect(announceCalls).toHaveLength(0);
  });

  it('forgetRoomCache makes a later change a no-op (room not primed)', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    forgetRoomCache(beatRoom());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'NEW', desc: '' }),
      context: { user: { name: 'Alice' } },
    });
    expect(announceCalls).toHaveLength(0);
  });
});

describe('maybeAnnounceCast', () => {
  it('announces a cast add once, then throttles the same editor on that beat', async () => {
    const beat = { _id: beatId, order: 1, name: 'Scene One' };
    await maybeAnnounceCast({ projectId, projectTitle: 'Film', beat, editor: 'Alice', added: ['Mary'], removed: [] });
    await maybeAnnounceCast({ projectId, projectTitle: 'Film', beat, editor: 'Alice', added: ['Bob'], removed: [] });
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].verb).toBe('added Mary to');
  });

  it('shares the beat bucket with writing edits (writing first → cast suppressed)', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'NEW', desc: '' }),
      context: { user: { name: 'Alice' } },
    });
    const beat = { _id: beatId, order: 1, name: 'Scene One' };
    await maybeAnnounceCast({ projectId, projectTitle: 'Film', beat, editor: 'Alice', added: ['Mary'], removed: [] });
    expect(announceCalls).toHaveLength(1); // only the writing edit
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editAnnounce.integration.test.js`
Expected: FAIL — `primeRoomCache` / `handleRoomChange` / `maybeAnnounceCast` / `_resetCacheForTests` are not exported.

- [ ] **Step 3: Write the stateful section**

Append to `src/web/editAnnounce.js`:

```js
// ── Stateful layer (Hocuspocus-facing) ──────────────────────────────────────

import { ObjectId } from 'mongodb';
import { getDb } from '../mongo/client.js';
import { getProjectById } from '../mongo/projects.js';
import { fragmentToMarkdown } from './headlessEditor.js';
import { announceMediaEvent } from '../discord/announcer.js';
import { claimAnnouncement } from '../mongo/editAnnouncements.js';
import { logger } from '../log.js';

// roomName -> { type: 'beat'|'character', announceFields: string[], values: Map }
const roomCache = new Map();

export function _resetCacheForTests() {
  roomCache.clear();
}

// Called from afterLoadDocument. Captures the announce-relevant field list and
// their baseline markdown so the initial seed is never mistaken for an edit.
export function primeRoomCache(documentName, desc) {
  const announceFields = announceFieldsForDesc(desc);
  if (!announceFields.length) return;
  const values = new Map();
  for (const f of announceFields) values.set(f, String(desc.seed?.[f] ?? ''));
  roomCache.set(documentName, { type: desc.type, announceFields, values });
}

export function forgetRoomCache(documentName) {
  roomCache.delete(documentName);
}

function fire(payload) {
  announceMediaEvent(payload).catch((e) =>
    logger.warn(`editAnnounce: announceMediaEvent threw: ${e?.message || e}`),
  );
}

async function lookupBeat(beatIdHex) {
  const plot = await getDb()
    .collection('plots')
    .findOne({ 'beats._id': new ObjectId(beatIdHex) });
  if (!plot) return null;
  const beat = (plot.beats || []).find((b) => b._id?.toString?.() === beatIdHex);
  if (!beat) return null;
  return { projectId: plot.project_id ? String(plot.project_id) : null, beat };
}

async function lookupCharacter(charIdHex) {
  const c = await getDb().collection('characters').findOne({ _id: new ObjectId(charIdHex) });
  if (!c) return null;
  return { projectId: c.project_id ? String(c.project_id) : null, character: c };
}

async function projectTitleFor(projectId) {
  if (!projectId) return null;
  const proj = await getProjectById(projectId).catch(() => null);
  return proj?.title ?? null;
}

// Best-effort: called from the Hocuspocus onChange hook on every doc update.
export async function handleRoomChange({ documentName, document, context }) {
  try {
    const state = roomCache.get(documentName);
    if (!state) return; // not a primed beat/character room

    let anyChanged = false;
    for (const field of state.announceFields) {
      let md;
      try {
        md = fragmentToMarkdown(document, field);
      } catch {
        continue;
      }
      if (md !== state.values.get(field)) {
        anyChanged = true;
        state.values.set(field, md);
      }
    }
    if (!anyChanged) return;

    // Attribution: bot writes and seed/server origins never announce. (Cache is
    // already updated above, so the next human edit diffs against fresh text.)
    if (context?.actor === 'bot') return;
    const editor = context?.user?.name;
    if (!editor) return;

    const m = documentName.match(/^(beat|character):([a-f0-9]{24})$/i);
    if (!m) return;
    const [, type, id] = m;

    if (type === 'beat') {
      const found = await lookupBeat(id);
      if (!found?.projectId) return;
      if (!(await claimAnnouncement({ projectId: found.projectId, targetType: 'beat', targetId: id, editor }))) return;
      const projectTitle = await projectTitleFor(found.projectId);
      fire(buildWritingPayload({ who: editor, beat: found.beat, projectTitle }));
    } else {
      const found = await lookupCharacter(id);
      if (!found?.projectId) return;
      if (!(await claimAnnouncement({ projectId: found.projectId, targetType: 'character', targetId: id, editor }))) return;
      const projectTitle = await projectTitleFor(found.projectId);
      fire(buildCharacterPayload({ who: editor, character: found.character, projectTitle }));
    }
  } catch (e) {
    logger.warn(`editAnnounce handleRoomChange failed ${documentName}: ${e?.message || e}`);
  }
}

// Best-effort: called from PATCH /beat/:id after a cast change is detected.
export async function maybeAnnounceCast({ projectId, projectTitle, beat, editor, added, removed }) {
  try {
    if (!editor) return;
    if (!(added?.length) && !(removed?.length)) return;
    const beatIdHex = beat?._id?.toString?.();
    if (!beatIdHex) return;
    if (!(await claimAnnouncement({ projectId, targetType: 'beat', targetId: beatIdHex, editor }))) return;
    fire(buildCastPayload({ who: editor, beat, projectTitle, added, removed }));
  } catch (e) {
    logger.warn(`editAnnounce maybeAnnounceCast failed: ${e?.message || e}`);
  }
}
```

> Move the new `import` statements to the **top** of the file (ESM requires
> imports at module top level — they cannot sit mid-file). Keep only the code
> after the imports in the appended section. The `import { stripMarkdown }` and
> `import { beatUrl, characterUrl }` from Task 2 stay; add the six new imports
> alongside them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editAnnounce.integration.test.js`
Expected: PASS (7 tests). If `Projects.createProject` isn't available in the fake, confirm the seeding block uses the literal `projectId` string from `createProject(...)._id.toString()` and that `tests/_fakeMongo.js` `reset()` exists (it does).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/editAnnounce.js tests/editAnnounce.integration.test.js
git commit -m "✨ Add room-change cache + cast announce for edit announcements"
```

---

### Task 4: Wire the Hocuspocus hooks

**Files:**
- Modify: `src/web/hocuspocus.js` (the `EntitySync` extension inside `makeServer()`)

**Interfaces:**
- Consumes: `primeRoomCache`, `forgetRoomCache`, `handleRoomChange` from `src/web/editAnnounce.js`.
- Produces: no new exports; behavior only.

- [ ] **Step 1: Add the import**

At the top of `src/web/hocuspocus.js`, alongside the existing `./roomRegistry.js` import, add:

```js
import { primeRoomCache, forgetRoomCache, handleRoomChange } from './editAnnounce.js';
```

- [ ] **Step 2: Prime the cache after load**

In the `afterLoadDocument` hook, after the existing `for (const field of desc.fields)` seeding loop (just before the hook's closing brace), add:

```js
          primeRoomCache(documentName, desc);
```

- [ ] **Step 3: Add the onChange and afterUnloadDocument hooks**

In the same `EntitySync` extension object, after the `onStoreDocument` method, add two methods:

```js
        async onChange({ documentName, document, context }) {
          // Best-effort announcement of human writing/character text edits.
          await handleRoomChange({ documentName, document, context });
        },

        afterUnloadDocument({ documentName }) {
          forgetRoomCache(documentName);
        },
```

- [ ] **Step 4: Verify the wiring is present**

Run: `grep -n "handleRoomChange\|primeRoomCache\|forgetRoomCache" src/web/hocuspocus.js`
Expected: three lines — the import, the `afterLoadDocument` prime call, and the `onChange` call (plus the `forgetRoomCache` in `afterUnloadDocument`).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (no test imports a live Hocuspocus server, so this just confirms nothing regressed).

- [ ] **Step 6: Commit**

```bash
git add src/web/hocuspocus.js
git commit -m "✨ Wire edit-announcement hooks into Hocuspocus"
```

---

### Task 5: Wire cast-change detection into `PATCH /beat/:id`

**Files:**
- Modify: `src/web/entityRoutes.js` (the `router.patch('/beat/:id', …)` handler near line 1733)

**Interfaces:**
- Consumes: `maybeAnnounceCast` from `src/web/editAnnounce.js`; `getBeat` (already imported in entityRoutes); `diffCast` from `src/web/editAnnounce.js`.
- Produces: behavior only.

- [ ] **Step 1: Add the import**

In `src/web/entityRoutes.js`, find the existing import block from `./announceHelpers.js` (around line 36-42) and add a sibling import after it:

```js
import { diffCast, maybeAnnounceCast } from './editAnnounce.js';
```

- [ ] **Step 2: Capture the before-cast, diff, and announce**

Replace the body of the `router.patch('/beat/:id', …)` handler so it reads the beat before the update and announces the cast diff. The current handler is:

```js
  router.patch('/beat/:id', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { characters, order } = req.body || {};
      const patch = {};
      if (Array.isArray(characters)) patch.characters = characters;
      if (typeof order === 'number') patch.order = order;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no patch fields' });
      const result = await updateBeatViaGateway(req.projectId, beatId, patch);
      res.json({ beat: result });
    } catch (e) {
      next(e);
    }
  });
```

Replace it with:

```js
  router.patch('/beat/:id', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { characters, order } = req.body || {};
      const patch = {};
      if (Array.isArray(characters)) patch.characters = characters;
      if (typeof order === 'number') patch.order = order;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'no patch fields' });

      // Snapshot the cast before the update so we can diff for the announcement.
      const before = patch.characters ? await getBeat(req.projectId, beatId) : null;

      const result = await updateBeatViaGateway(req.projectId, beatId, patch);
      res.json({ beat: result });

      // Fire-and-forget cast-change announcement (after the response).
      if (patch.characters) {
        const { added, removed } = diffCast(before?.characters || [], patch.characters);
        if (added.length || removed.length) {
          maybeAnnounceCast({
            projectId: req.projectId,
            projectTitle: req.projectTitle ?? null,
            beat: result,
            editor: req.session?.username || null,
            added,
            removed,
          });
        }
      }
    } catch (e) {
      next(e);
    }
  });
```

> `getBeat` is already imported in `entityRoutes.js` (used throughout). If a
> lint error says otherwise, add it to the existing `from '../mongo/plots.js'`
> import. `result` is the updated beat doc returned by `updateBeatViaGateway`
> and carries `_id`, `order`, and `name` for the label.

- [ ] **Step 3: Verify the wiring**

Run: `grep -n "maybeAnnounceCast\|diffCast" src/web/entityRoutes.js`
Expected: the import line plus the two usages inside the PATCH handler.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/entityRoutes.js
git commit -m "✨ Announce beat cast changes from PATCH /beat/:id"
```

---

## Manual smoke test (after all tasks)

With Mongo + the bot running locally (`npm run dev`) and the SPA built/served, in a beat editor:

1. Edit a beat's body in the browser → within ~2s a Discord embed "**<you> edited the writing in Beat N: …**" appears in `MOVIE_CHANNEL_ID`.
2. Edit the same beat's name again → **no** second announcement (same editor, same beat, within 24h).
3. Assign a character to the beat via the cast UI → no announcement (beat bucket already claimed by step 1). From a *different* approved browser session (different username), assign a character → "**<them> added <name> to Beat N**".
4. Edit a character's bio field → "**<you> edited Character: <name>**" (separate bucket from beats).
5. Confirm the bot's own edits (ask the agent in Discord to rewrite a beat) produce the normal agent reply but **no** separate "edited the writing" announcement.

## Self-review notes

- **Spec coverage:** throttle store (Task 1) ✓; writing-field selectors incl. desc (Task 2) ✓; cast diff + messages (Task 2) ✓; per-room cache + bot exclusion + per-editor attribution (Task 3) ✓; shared beat bucket / separate character bucket (Tasks 1+3) ✓; Hocuspocus wiring (Task 4) ✓; REST cast wiring (Task 5) ✓.
- **`_fakeMongo` change:** not needed — `claimAnnouncement` uses upsert + `$setOnInsert`, which the fake already supports (`updateOne` upsert returns `upsertedId`). This deviates from the spec's "extend the fake" note; the upsert approach is simpler and equally correct.
- **Type consistency:** `claimAnnouncement({projectId,targetType,targetId,editor})`, `announceFieldsForDesc(desc)`, `diffCast(old,new)→{added,removed}`, `buildCastPayload({...,added,removed})`, `handleRoomChange({documentName,document,context})`, `maybeAnnounceCast({projectId,projectTitle,beat,editor,added,removed})` — names match across tasks.
