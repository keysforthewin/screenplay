# Beat Critique System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Critique** sub-tab to the Writing tab that runs a 7-facet, scored, streamed AI critique of a beat, persists it, and can rewrite the beat body from the critique — plus a **Normalize** button on the Background tab for screenplay-format reformatting, both sharing one Undo slot.

**Architecture:** Mirrors the existing **storyboard critique** (scored, lensed critique → regenerate-from-critique) and **fal video-job SSE** (in-memory job registry + pub/sub) patterns. Each facet is one forced-tool Anthropic call returning `{score, comments}`; facets run in parallel and stream to the SPA as full job snapshots over SSE; results persist as a single overwritten `beat.critique` object via atomic `arrayFilters` writes. Body rewrites go through `setBeatBodyViaGateway` so collaborative editors stay in sync.

**Tech Stack:** Node ESM, Express (`src/web/entityRoutes.js`), MongoDB (embedded `plots.beats[]`), Anthropic SDK (`getAnthropic()`, `claude-opus-4-8`), React/Vite SPA (`web/src/`), Vitest + in-memory fake Mongo + supertest-style route tests.

## Global Constraints

- **Model:** `claude-opus-4-8` for facet scoring and body rewrites (define `CRITIQUE_MODEL = 'claude-opus-4-8'` locally; `analyzeText` already defaults to `config.anthropic.model` which is `claude-opus-4-8`).
- **Project scoping:** every `src/mongo/*` and `src/web/*` helper takes `projectId` first and calls `resolveProjectId(projectId)`; ObjectId lookups verify the owning project (cross-project ids behave as not-found).
- **Atomic writes:** all beat sub-document writes use `col().updateOne({ project_id }, { $set: {...} }, { arrayFilters: [{ 'b._id': beatOid }, ...] })` keyed on `beats.$[b]` — never whole-array `$set` (lost-update risk). The fake Mongo (`tests/_fakeMongo.js`) supports nested `arrayFilters`.
- **No co-author tags** in commits. Commit messages use the repo's emoji-prefix style (`✨`, `🐛`, `📝`).
- **Persistence is latest-only:** `beat.critique` is a single object, overwritten each run. No history.
- **ESM only**, `.js` extensions on relative imports.

## Critique data shapes (used across tasks)

```js
// Facet stub (pending) — created from the registry before any model call:
{ key, label, scope, score: null, comments: '', status: 'pending', error_message: null }

// Persisted critique object on the beat:
beat.critique = {
  generated_at: Date,
  model: 'claude-opus-4-8',
  status: 'pending' | 'running' | 'done' | 'partial' | 'error',
  overall: number | null,                 // rounded mean of done facet scores (1-10)
  facets: [ { key, label, scope, score: number|null, comments: string,
              status: 'pending'|'done'|'error', error_message: string|null } ],
} | null

beat.previous_body = string | null         // single Undo slot, shared by Normalize + Regenerate
```

---

### Task 1: Beat schema backfill (`critique` + `previous_body`)

**Files:**
- Modify: `src/mongo/plots.js` (`ensureBeatIds`, ~lines 40-99)
- Test: `tests/critiques-schema.test.js` (create)

**Interfaces:**
- Produces: every beat returned by `getPlot`/`getBeat`/`listBeats` carries `critique` (default `null`) and `previous_body` (default `null`).

- [ ] **Step 1: Write the failing test**

Create `tests/critiques-schema.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
});

describe('beat critique schema backfill', () => {
  it('defaults critique and previous_body on a new beat', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.critique).toBeNull();
    expect(fresh.previous_body).toBeNull();
  });

  it('backfills legacy beats missing the fields', async () => {
    // Simulate a legacy plot doc with a beat lacking the new fields.
    await fakeDb.collection('plots').insertOne({
      _id: 'legacy', project_id: projectId, title: '', synopsis: '',
      beats: [{ order: 1, name: 'Old', body: 'x' }], current_beat_id: null, updated_at: new Date(),
    });
    const beats = await Plots.listBeats(projectId);
    expect(beats[0].critique).toBeNull();
    expect(beats[0].previous_body).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/critiques-schema.test.js`
Expected: FAIL — `critique` is `undefined`, not `null`.

- [ ] **Step 3: Add the backfill**

In `src/mongo/plots.js`, inside `ensureBeatIds`'s `.map((b) => { ... })`, after the `scene_bible` block (~line 69), add:

```js
    if (next.critique === undefined) {
      next.critique = null;
      changed = true;
    }
    if (next.previous_body === undefined) {
      next.previous_body = null;
      changed = true;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/critiques-schema.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mongo/plots.js tests/critiques-schema.test.js
git commit -m "✨ Backfill beat critique + previous_body schema fields"
```

---

### Task 2: Mongo critique helpers (`src/mongo/critiques.js`)

**Files:**
- Create: `src/mongo/critiques.js`
- Test: `tests/critiques-mongo.test.js` (create)

**Interfaces:**
- Consumes: `getBeat` (plots.js), `resolveProjectId` (projects.js).
- Produces:
  - `getBeatCritique(projectId, beatId) -> critique|null`
  - `setCritiquePending(projectId, beatId, { model, facets }) -> void` (writes `beat.critique = { generated_at, model, status:'pending', overall:null, facets }`)
  - `updateCritiqueFacet(projectId, beatId, facetKey, patch) -> void` (patch keys: `score`, `comments`, `status`, `error_message`)
  - `finalizeCritique(projectId, beatId, { status, overall }) -> void`
  - `stashPreviousBody(projectId, beatId, body) -> void`
  - `getPreviousBody(projectId, beatId) -> string|null`
  - `clearPreviousBody(projectId, beatId) -> void`

- [ ] **Step 1: Write the failing test**

Create `tests/critiques-mongo.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const C = await import('../src/mongo/critiques.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
});

const STUBS = [
  { key: 'format', label: 'Screenplay format', scope: 'focused', score: null, comments: '', status: 'pending', error_message: null },
  { key: 'pacing', label: 'Pacing', scope: 'focused', score: null, comments: '', status: 'pending', error_message: null },
];

describe('critiques mongo helpers', () => {
  it('sets a pending critique then reads it back', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await C.setCritiquePending(projectId, beat._id.toString(), { model: 'claude-opus-4-8', facets: STUBS });
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.status).toBe('pending');
    expect(c.model).toBe('claude-opus-4-8');
    expect(c.facets).toHaveLength(2);
    expect(c.facets[0].key).toBe('format');
  });

  it('updates a single facet by key', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await C.setCritiquePending(projectId, beat._id.toString(), { model: 'm', facets: STUBS });
    await C.updateCritiqueFacet(projectId, beat._id.toString(), 'pacing', { score: 7, comments: 'tight', status: 'done' });
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    const pacing = c.facets.find((f) => f.key === 'pacing');
    expect(pacing.score).toBe(7);
    expect(pacing.comments).toBe('tight');
    expect(pacing.status).toBe('done');
    expect(c.facets.find((f) => f.key === 'format').status).toBe('pending');
  });

  it('finalizes status + overall', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await C.setCritiquePending(projectId, beat._id.toString(), { model: 'm', facets: STUBS });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 6 });
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.status).toBe('done');
    expect(c.overall).toBe(6);
  });

  it('stashes, reads, and clears previous_body', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'orig' });
    await C.stashPreviousBody(projectId, beat._id.toString(), 'orig');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('orig');
    await C.clearPreviousBody(projectId, beat._id.toString());
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBeNull();
  });

  it('returns null for a beat in another project', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const otherProjectId = (await createProject('Other'))._id.toString();
    expect(await C.getBeatCritique(otherProjectId, beat._id.toString())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/critiques-mongo.test.js`
Expected: FAIL — `Cannot find module '../src/mongo/critiques.js'`.

- [ ] **Step 3: Implement `src/mongo/critiques.js`**

```js
// Per-beat critique persistence. A critique is a single overwritten object on
// the beat (latest-only, no history) plus a one-slot `previous_body` for Undo.
// All writes are atomic arrayFilter updates on plots.beats.$[b] (and the nested
// facets.$[f]) — never whole-array $set — mirroring src/mongo/artworks.js.

import { getDb } from './client.js';
import { logger } from '../log.js';
import { getBeat } from './plots.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('plots');

// Resolve {projectId, beatId} to the canonical beat ObjectId (id|order|name),
// scoped to the project. Returns null if not found.
async function resolveBeatOid(projectId, beatId) {
  const beat = await getBeat(projectId, String(beatId));
  return beat?._id || null;
}

export async function getBeatCritique(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  return beat?.critique || null;
}

export async function setCritiquePending(projectId, beatId, { model, facets } = {}) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  const critique = {
    generated_at: now,
    model: String(model || ''),
    status: 'pending',
    overall: null,
    facets: (facets || []).map((f) => ({ ...f })),
  };
  const result = await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].critique': critique, 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': oid }] },
  );
  if (!result.matchedCount) throw new Error(`setCritiquePending: beat ${oid} not found`);
  logger.info(`mongo: critique pending beat=${oid} facets=${critique.facets.length}`);
}

export async function updateCritiqueFacet(projectId, beatId, facetKey, patch = {}) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  const $set = { 'beats.$[b].updated_at': now, updated_at: now };
  for (const k of ['score', 'comments', 'status', 'error_message']) {
    if (patch[k] !== undefined) $set[`beats.$[b].critique.facets.$[f].${k}`] = patch[k];
  }
  const result = await col().updateOne(
    { project_id: projectId },
    { $set },
    { arrayFilters: [{ 'b._id': oid }, { 'f.key': String(facetKey) }] },
  );
  if (!result.matchedCount) throw new Error(`updateCritiqueFacet: beat ${oid} facet ${facetKey} not found`);
}

export async function finalizeCritique(projectId, beatId, { status, overall } = {}) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    {
      $set: {
        'beats.$[b].critique.status': status,
        'beats.$[b].critique.overall': overall ?? null,
        'beats.$[b].critique.generated_at': now,
        'beats.$[b].updated_at': now,
        updated_at: now,
      },
    },
    { arrayFilters: [{ 'b._id': oid }] },
  );
  logger.info(`mongo: critique finalize beat=${oid} status=${status} overall=${overall ?? 'null'}`);
}

export async function stashPreviousBody(projectId, beatId, body) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].previous_body': String(body ?? ''), 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': oid }] },
  );
}

export async function getPreviousBody(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  const prev = beat?.previous_body;
  return prev == null || prev === '' ? null : String(prev);
}

export async function clearPreviousBody(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const oid = await resolveBeatOid(projectId, beatId);
  if (!oid) throw new Error(`Beat not found: ${beatId}`);
  const now = new Date();
  await col().updateOne(
    { project_id: projectId },
    { $set: { 'beats.$[b].previous_body': null, 'beats.$[b].updated_at': now, updated_at: now } },
    { arrayFilters: [{ 'b._id': oid }] },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/critiques-mongo.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mongo/critiques.js tests/critiques-mongo.test.js
git commit -m "✨ Add per-beat critique + previous_body mongo helpers"
```

---

### Task 3: Facet registry (`src/web/critiqueFacets.js`)

**Files:**
- Create: `src/web/critiqueFacets.js`
- Test: `tests/critiqueFacets.test.js` (create)

**Interfaces:**
- Consumes: `stripMarkdown` (`src/util/markdown.js`), `SCREENPLAY_STYLE_GUIDE` (`src/agent/screenplayStyle.js`).
- Produces:
  - `FACETS` — ordered array of `{ key, label, scope, required, systemPrompt, buildContext(ctx) }` (7 entries).
  - `getFacet(key) -> facet|undefined`.
  - `facetStubs() -> [ {key,label,scope,score:null,comments:'',status:'pending',error_message:null} ]`.

- [ ] **Step 1: Write the failing test**

Create `tests/critiqueFacets.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { FACETS, getFacet, facetStubs } from '../src/web/critiqueFacets.js';

const MIN_CTX = {
  beat: { order: 2, name: 'Confrontation', desc: 'they clash', body: 'INT. ROOM — NIGHT\nThey clash.' },
  prevBeat: { order: 1, name: 'Setup', body: 'Setup body' },
  nextBeat: { order: 3, name: 'Fallout', body: 'Fallout body' },
  plot: { title: 'T', synopsis: 'A synopsis.' },
  spine: [{ order: 1, name: 'Setup', desc: 'd1' }, { order: 2, name: 'Confrontation', desc: 'd2' }],
  directorNotes: [{ text: 'Keep it tense.' }],
  characters: [{ name: 'Alice', hollywood_actor: '', fields: {} }],
  styleGuide: 'STYLE GUIDE TEXT',
};

describe('critique facet registry', () => {
  it('has 7 facets with unique keys', () => {
    expect(FACETS).toHaveLength(7);
    const keys = FACETS.map((f) => f.key);
    expect(new Set(keys).size).toBe(7);
  });

  it('marks exactly format + direction as required', () => {
    const req = FACETS.filter((f) => f.required).map((f) => f.key).sort();
    expect(req).toEqual(['direction', 'format']);
  });

  it('has exactly one story-scoped facet (story_fit)', () => {
    const story = FACETS.filter((f) => f.scope === 'story');
    expect(story.map((f) => f.key)).toEqual(['story_fit']);
  });

  it('every facet is well-formed and builds non-empty context', () => {
    for (const f of FACETS) {
      expect(typeof f.key).toBe('string');
      expect(typeof f.label).toBe('string');
      expect(['focused', 'story']).toContain(f.scope);
      expect(typeof f.systemPrompt).toBe('string');
      expect(f.systemPrompt.length).toBeGreaterThan(20);
      expect(typeof f.buildContext).toBe('function');
      const text = f.buildContext(MIN_CTX);
      expect(typeof text).toBe('string');
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it('getFacet finds by key; facetStubs mirrors the registry', () => {
    expect(getFacet('format').label).toBe('Screenplay format');
    const stubs = facetStubs();
    expect(stubs).toHaveLength(7);
    expect(stubs[0]).toMatchObject({ score: null, comments: '', status: 'pending', error_message: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/critiqueFacets.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/critiqueFacets.js`**

```js
// Beat-critique facet registry — the single source of truth for what facets
// exist and how each is prompted. Each facet runs one forced-tool Anthropic
// call (see critiqueGenerate.js) that returns { score: 1-10, comments }.
//
// scope: 'focused' = judge THIS beat (with prev/next as immediate context);
//        'story'   = judge how this beat fits the whole screenplay.
// required: always-run facets the user mandated (format + director's notes).

import { stripMarkdown } from '../util/markdown.js';
import { SCREENPLAY_STYLE_GUIDE } from '../agent/screenplayStyle.js';

function txt(s) {
  return stripMarkdown(String(s || '')).trim();
}

function beatBlock(beat) {
  return [
    `Beat #${beat?.order ?? '?'}: ${txt(beat?.name) || 'Untitled'}`,
    '',
    'Description:',
    txt(beat?.desc) || '(none)',
    '',
    'Body:',
    txt(beat?.body) || '(none)',
  ].join('\n');
}

function neighborBlock(label, beat) {
  if (!beat) return `${label}: (none — this is an end beat)`;
  return [`${label} — Beat #${beat.order}: ${txt(beat.name) || 'Untitled'}`, txt(beat.body) || '(no body)'].join('\n');
}

function spineText(spine) {
  const lines = (spine || [])
    .map((b) => `${b.order}. ${txt(b.name) || 'Untitled'} — ${txt(b.desc) || '(no description)'}`);
  return lines.length ? lines.join('\n') : '(no beats)';
}

function notesText(notes) {
  const items = (notes || []).map((n) => txt(n?.text)).filter(Boolean);
  return items.length ? items.map((t) => `- ${t}`).join('\n') : "(no director's notes recorded)";
}

function charactersText(characters) {
  const items = (characters || [])
    .map((c) => {
      const name = txt(c?.name);
      if (!name) return null;
      const actor = txt(c?.hollywood_actor);
      const role = txt(c?.fields?.role);
      const suffix = actor ? ` — played by ${actor}` : role ? ` — ${role}` : '';
      return `- ${name}${suffix}`;
    })
    .filter(Boolean);
  return items.length ? items.join('\n') : '(no named characters in this beat)';
}

export const FACETS = [
  {
    key: 'format',
    label: 'Screenplay format',
    scope: 'focused',
    required: true,
    systemPrompt: [
      'You are a screenplay format editor. Judge ONLY how well the beat body conforms to standard screenplay style — not its content quality.',
      'Score 10 = textbook screenplay format; 1 = novel prose ignoring all convention.',
      'Weigh: sluglines for literal scenes (INT./EXT. LOCATION — TIME), present-tense photographable action lines, sparing camera cues, and correctly-formatted dialogue (CAPS speaker cue, optional parenthetical, line).',
      'In comments, name the top 2-3 concrete format fixes. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        '# Screenplay format guide (the standard to measure against)',
        ctx.styleGuide,
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'direction',
    label: "Director's notes",
    scope: 'focused',
    required: true,
    systemPrompt: [
      "You check whether the project's director's notes (and any beat-level direction) are actually reflected in this beat.",
      'Score 10 = every applicable note is clearly honored; 1 = the beat ignores or contradicts the notes.',
      'In comments, cite which notes are met and which are missing or violated, with a concrete fix. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        "# Director's notes (project-wide guidance)",
        notesText(ctx.directorNotes),
        '',
        '# Beat-level direction (dialog_notes)',
        txt(ctx.beat?.dialog_notes) || '(none)',
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'pacing',
    label: 'Pacing & momentum',
    scope: 'focused',
    required: false,
    systemPrompt: [
      'You are a script editor judging pacing and momentum within this beat and across its neighbors.',
      'Score 10 = taut, every moment earns its place, clean escalation; 1 = dead spots, rushed turns, or wrong scene length.',
      'Use the previous and next beats only to judge whether this beat enters and exits at the right tempo. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        neighborBlock('PREVIOUS beat', ctx.prevBeat),
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
        '',
        neighborBlock('NEXT beat', ctx.nextBeat),
      ].join('\n'),
  },
  {
    key: 'voice',
    label: 'Character voice',
    scope: 'focused',
    required: false,
    systemPrompt: [
      'You judge whether the characters in this beat are consistent and distinct in how they act and speak.',
      'Score 10 = each character is unmistakably themselves; 1 = interchangeable or out-of-character.',
      'In comments, name any character whose voice slips, with a concrete fix. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        '# Characters present in this beat',
        charactersText(ctx.characters),
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'cinematic',
    label: 'Cinematic craft',
    scope: 'focused',
    required: false,
    systemPrompt: [
      'You judge show-don\'t-tell: is this beat written as photographable action a camera can capture, or as interior prose it cannot?',
      'Score 10 = every line is visible on screen; 1 = thoughts, backstory, and abstractions the camera cannot show.',
      'In comments, point to the most un-filmable lines and how to externalize them. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        '# Screenplay craft reference',
        ctx.styleGuide,
        '',
        '# The beat to evaluate',
        beatBlock(ctx.beat),
      ].join('\n'),
  },
  {
    key: 'dialogue',
    label: 'Dialogue & subtext',
    scope: 'focused',
    required: false,
    systemPrompt: [
      'You are a dialogue editor judging the anchor lines in this beat.',
      'Score 10 = sharp, in-voice, carrying subtext; 1 = on-the-nose, wooden, or expository.',
      'In comments, flag the weakest lines and what subtext they should be playing. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      ['# The beat to evaluate', beatBlock(ctx.beat)].join('\n'),
  },
  {
    key: 'story_fit',
    label: 'Story fit',
    scope: 'story',
    required: false,
    systemPrompt: [
      'You judge how this single beat fits into the whole screenplay: does it earn its place in the arc, avoid redundancy, and maintain continuity with the surrounding story?',
      'Score 10 = the beat is essential and well-placed; 1 = redundant, misplaced, or contradicts the larger story.',
      'Use the synopsis and the full beat spine to judge placement. In comments, say whether to keep, move, merge, or cut, and why. Return your judgement via the critique_facet tool.',
    ].join('\n'),
    buildContext: (ctx) =>
      [
        '# Story synopsis',
        txt(ctx.plot?.synopsis) || '(no synopsis)',
        '',
        '# Full beat spine (the whole screenplay in order)',
        spineText(ctx.spine),
        '',
        `# The beat to evaluate — currently at position #${ctx.beat?.order ?? '?'}`,
        beatBlock(ctx.beat),
      ].join('\n'),
  },
];

export function getFacet(key) {
  return FACETS.find((f) => f.key === key);
}

export function facetStubs() {
  return FACETS.map((f) => ({
    key: f.key,
    label: f.label,
    scope: f.scope,
    score: null,
    comments: '',
    status: 'pending',
    error_message: null,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/critiqueFacets.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/critiqueFacets.js tests/critiqueFacets.test.js
git commit -m "✨ Add beat-critique facet registry (7 scored facets)"
```

---

### Task 4: Critique context assembly (`src/web/critiqueContext.js`)

**Files:**
- Create: `src/web/critiqueContext.js`
- Test: `tests/critiqueContext.test.js` (create)

**Interfaces:**
- Consumes: `getPlot`, `listBeats` (plots.js); `getDirectorNotes` (directorNotes.js); `getCharacter` (characters.js); `stripMarkdown` (util/markdown.js); `SCREENPLAY_STYLE_GUIDE` (screenplayStyle.js). Deliberately does **not** import `storyboardGenerate.js` (heavy tree); the two helpers it needs are inlined.
- Produces: `buildCritiqueContext(projectId, beat) -> ctx` where `ctx = { beat, prevBeat, nextBeat, plot:{title,synopsis}, spine:[{order,name,desc}], directorNotes, characters, styleGuide }`. `beat` is the resolved beat doc (pass it in to avoid a re-fetch).

- [ ] **Step 1: Write the failing test**

Create `tests/critiqueContext.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const { buildCritiqueContext } = await import('../src/web/critiqueContext.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  await Plots.updatePlot(projectId, { synopsis: 'The whole story.' });
});

describe('buildCritiqueContext', () => {
  it('finds prev/next neighbors by order and builds the spine', async () => {
    await Plots.createBeat({ projectId, name: 'One', desc: 'd1', body: 'b1', order: 1 });
    const mid = await Plots.createBeat({ projectId, name: 'Two', desc: 'd2', body: 'b2', order: 2 });
    await Plots.createBeat({ projectId, name: 'Three', desc: 'd3', body: 'b3', order: 3 });
    const beat = await Plots.getBeat(projectId, mid._id.toString());
    const ctx = await buildCritiqueContext(projectId, beat);
    expect(ctx.prevBeat.order).toBe(1);
    expect(ctx.nextBeat.order).toBe(3);
    expect(ctx.spine).toHaveLength(3);
    expect(ctx.plot.synopsis).toBe('The whole story.');
    expect(ctx.styleGuide.length).toBeGreaterThan(20);
  });

  it('returns null neighbors at the ends', async () => {
    const first = await Plots.createBeat({ projectId, name: 'One', body: 'b1', order: 1 });
    await Plots.createBeat({ projectId, name: 'Two', body: 'b2', order: 2 });
    const beat = await Plots.getBeat(projectId, first._id.toString());
    const ctx = await buildCritiqueContext(projectId, beat);
    expect(ctx.prevBeat).toBeNull();
    expect(ctx.nextBeat.order).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/critiqueContext.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/critiqueContext.js`**

```js
// Assemble the shared context a critique run feeds to every facet.
// Cheap: reuses plot synopsis + the ordered beat spine (name/desc already on the
// plot doc) rather than re-summarizing every body. The director-notes and
// characters-in-beat helpers are inlined (rather than imported from the heavy
// storyboardGenerate.js) to keep this module light and easy to test.

import { getPlot, listBeats } from '../mongo/plots.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';
import { SCREENPLAY_STYLE_GUIDE } from '../agent/screenplayStyle.js';

async function loadDirectorNotes(projectId) {
  try {
    const doc = await getDirectorNotes(projectId);
    return Array.isArray(doc?.notes) ? doc.notes : [];
  } catch {
    return []; // notes are guidance, not load-bearing
  }
}

async function charactersInBeat(projectId, beat) {
  const out = [];
  for (const raw of beat?.characters || []) {
    const name = stripMarkdown(raw || '').trim();
    if (!name) continue;
    try {
      const c = await getCharacter(projectId, name);
      if (c) out.push(c);
    } catch {
      // skip unresolved names
    }
  }
  return out;
}

export async function buildCritiqueContext(projectId, beat) {
  const plot = await getPlot(projectId);
  const beats = await listBeats(projectId); // already sorted by order
  const idx = beats.findIndex((b) => b._id && beat._id && b._id.equals(beat._id));
  const prevBeat = idx > 0 ? beats[idx - 1] : null;
  const nextBeat = idx >= 0 && idx < beats.length - 1 ? beats[idx + 1] : null;
  const spine = beats.map((b) => ({ order: b.order, name: b.name, desc: b.desc }));
  const directorNotes = await loadDirectorNotes(projectId);
  const characters = await charactersInBeat(projectId, beat);
  return {
    beat,
    prevBeat,
    nextBeat,
    plot: { title: plot.title || '', synopsis: plot.synopsis || '' },
    spine,
    directorNotes,
    characters,
    styleGuide: SCREENPLAY_STYLE_GUIDE,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/critiqueContext.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/critiqueContext.js tests/critiqueContext.test.js
git commit -m "✨ Add critique context assembly (prev/next + story spine)"
```

---

### Task 5: Critique run engine + SSE job registry (`src/web/critiqueGenerate.js`)

**Files:**
- Create: `src/web/critiqueGenerate.js`
- Test: `tests/critiqueGenerate.test.js` (create)

**Interfaces:**
- Consumes: `FACETS`, `facetStubs` (critiqueFacets.js); `buildCritiqueContext` (critiqueContext.js); `setCritiquePending`, `updateCritiqueFacet`, `finalizeCritique`, `getBeatCritique` (critiques.js); `getBeat` (plots.js); `getAnthropic` (anthropic/client.js); `resolveProjectId` (projects.js).
- Produces:
  - `CRITIQUE_MODEL = 'claude-opus-4-8'`
  - `createCritiqueJob(beatId) -> job` (registers a pending job in the in-memory map)
  - `runCritique({ projectId, job }) -> Promise<job>` (the awaitable worker; full persistence)
  - `startCritiqueJob({ projectId, beatId }) -> Promise<jobId>` (busy-guard, persists pending, fires `runCritique` via `setImmediate`, returns id; throws `{status:409}` if a run is already active for the beat)
  - `getCritiqueJob(jobId)`, `subscribeToCritiqueJob(jobId, cb)`, `unsubscribeFromCritiqueJob(jobId, cb)`, `serializeCritiqueJob(job)`
  - `_setFacetGeneratorForTests(fn)` — override the per-facet call; `fn(facet, ctx) -> {score, comments}` (throw to fail one facet)

- [ ] **Step 1: Write the failing test**

Create `tests/critiqueGenerate.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const C = await import('../src/mongo/critiques.js');
const G = await import('../src/web/critiqueGenerate.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  await Plots.updatePlot(projectId, { synopsis: 'S' });
});
afterEach(() => {
  G._setFacetGeneratorForTests(null);
});

async function seedBeat() {
  await Plots.createBeat({ projectId, name: 'A', body: 'a', order: 1 });
  const b = await Plots.createBeat({ projectId, name: 'B', body: 'INT. ROOM — DAY\nShe waits.', order: 2 });
  await Plots.createBeat({ projectId, name: 'C', body: 'c', order: 3 });
  return b;
}

describe('runCritique', () => {
  it('scores every facet, persists, and sets overall', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async (facet) => ({ score: 8, comments: `c-${facet.key}` }));
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('done');
    expect(done.overall).toBe(8);
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.status).toBe('done');
    expect(c.overall).toBe(8);
    expect(c.facets).toHaveLength(7);
    expect(c.facets.every((f) => f.status === 'done' && f.score === 8)).toBe(true);
  });

  it('marks a single failing facet error and the run partial', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async (facet) => {
      if (facet.key === 'pacing') throw new Error('model boom');
      return { score: 6, comments: 'ok' };
    });
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('partial');
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    const pacing = c.facets.find((f) => f.key === 'pacing');
    expect(pacing.status).toBe('error');
    expect(pacing.score).toBeNull();
    expect(pacing.error_message).toMatch(/boom/);
    expect(c.overall).toBe(6); // mean of the 6 successful 6s
  });

  it('marks the run error when every facet fails', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async () => { throw new Error('all down'); });
    const job = G.createCritiqueJob(beat._id.toString());
    const done = await G.runCritique({ projectId, job });
    expect(done.status).toBe('error');
    const c = await C.getBeatCritique(projectId, beat._id.toString());
    expect(c.overall).toBeNull();
  });

  it('publishes snapshots to SSE subscribers', async () => {
    const beat = await seedBeat();
    G._setFacetGeneratorForTests(async () => ({ score: 5, comments: 'x' }));
    const job = G.createCritiqueJob(beat._id.toString());
    const snaps = [];
    G.subscribeToCritiqueJob(job.job_id, (s) => snaps.push(s));
    await G.runCritique({ projectId, job });
    expect(snaps.length).toBeGreaterThan(0);
    const last = snaps[snaps.length - 1];
    expect(last.status).toBe('done');
    expect(last.facets).toHaveLength(7);
  });
});

describe('startCritiqueJob busy guard', () => {
  it('rejects a second concurrent run on the same beat with 409', async () => {
    const beat = await seedBeat();
    let release;
    const gate = new Promise((r) => { release = r; });
    G._setFacetGeneratorForTests(async () => { await gate; return { score: 5, comments: 'x' }; });
    const id1 = await G.startCritiqueJob({ projectId, beatId: beat._id.toString() });
    expect(id1).toBeTruthy();
    await expect(
      G.startCritiqueJob({ projectId, beatId: beat._id.toString() }),
    ).rejects.toMatchObject({ status: 409 });
    // Let the first (gated) run finish so its background work can't leak into
    // the next test, which clears the facet-generator override in afterEach.
    release();
    const terminal = (s) => ['done', 'partial', 'error'].includes(s);
    for (let i = 0; i < 100; i++) {
      const j = G.getCritiqueJob(id1);
      if (!j || terminal(j.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/critiqueGenerate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/critiqueGenerate.js`**

```js
// Beat-critique run engine. Runs all facets in parallel as forced-tool Anthropic
// calls returning {score, comments}, persists each as it lands, and streams full
// job snapshots to SSE subscribers (registry + pub/sub replicated from
// falVideoGenerate.js). Latest-only persistence via src/mongo/critiques.js.

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { getAnthropic } from '../anthropic/client.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { FACETS, facetStubs } from './critiqueFacets.js';
import { buildCritiqueContext } from './critiqueContext.js';
import {
  setCritiquePending,
  updateCritiqueFacet,
  finalizeCritique,
} from '../mongo/critiques.js';

export const CRITIQUE_MODEL = 'claude-opus-4-8';
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;

const jobs = new Map();
const listeners = new Map();
const busyBeats = new Set();

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function makeJobId() {
  return new ObjectId().toString();
}

export function getCritiqueJob(jobId) {
  return jobs.get(jobId) || null;
}

export function subscribeToCritiqueJob(jobId, cb) {
  let set = listeners.get(jobId);
  if (!set) { set = new Set(); listeners.set(jobId, set); }
  set.add(cb);
}

export function unsubscribeFromCritiqueJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

export function serializeCritiqueJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    beat_id: job.beat_id,
    status: job.status,
    overall: job.overall,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    facets: job.facets.map((f) => ({ ...f })),
  };
}

function publish(job) {
  const set = listeners.get(job.job_id);
  if (!set || !set.size) return;
  const snap = serializeCritiqueJob(job);
  for (const cb of set) {
    try { cb(snap); } catch (e) { logger.warn(`critique gen: listener threw: ${e.message}`); }
  }
}

export function createCritiqueJob(beatId) {
  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    beat_id: String(beatId),
    status: 'queued',
    overall: null,
    error: null,
    started_at: new Date(),
    finished_at: null,
    facets: facetStubs(),
  };
  jobs.set(jobId, job);
  return job;
}

function updateJobFacet(job, key, patch) {
  const f = job.facets.find((x) => x.key === key);
  if (f) Object.assign(f, patch);
}

// The CRITIQUE_FACET tool — one score + a prose critique. Mirrors dialogCritique.
const CRITIQUE_FACET_TOOL = {
  name: 'critique_facet',
  description: 'Return a 1-10 score and a short prose critique for this one facet.',
  input_schema: {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 1, maximum: 10, description: '10 = excellent on this facet; 1 = seriously deficient.' },
      comments: { type: 'string', description: 'A few sentences: what works, what is weak, and the single most important concrete fix.' },
    },
    required: ['score', 'comments'],
    additionalProperties: false,
  },
};

function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return Math.min(10, Math.max(1, v));
}

// Default per-facet generator: one forced-tool Anthropic call. Override in tests.
let facetGeneratorOverride = null;
export function _setFacetGeneratorForTests(fn) {
  facetGeneratorOverride = fn;
}

async function generateFacet(facet, ctx) {
  if (facetGeneratorOverride) return facetGeneratorOverride(facet, ctx);
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: CRITIQUE_MODEL,
    max_tokens: 1024,
    system: facet.systemPrompt,
    tools: [CRITIQUE_FACET_TOOL],
    tool_choice: { type: 'tool', name: 'critique_facet' },
    messages: [{ role: 'user', content: [{ type: 'text', text: facet.buildContext(ctx) }] }],
  });
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'critique_facet');
  if (!toolUse) throw new Error('model did not return a critique');
  return {
    score: clampScore(toolUse.input?.score),
    comments: typeof toolUse.input?.comments === 'string' ? toolUse.input.comments : '',
  };
}

async function runOneFacet(facet, ctx, job, projectId, beatId) {
  try {
    const { score, comments } = await generateFacet(facet, ctx);
    updateJobFacet(job, facet.key, { score, comments, status: 'done', error_message: null });
    await updateCritiqueFacet(projectId, beatId, facet.key, { score, comments, status: 'done', error_message: null });
  } catch (e) {
    updateJobFacet(job, facet.key, { score: null, comments: '', status: 'error', error_message: e.message });
    await updateCritiqueFacet(projectId, beatId, facet.key, { score: null, status: 'error', error_message: e.message })
      .catch((err) => logger.warn(`critique gen: persist facet error failed: ${err.message}`));
    logger.warn(`critique gen: facet ${facet.key} failed: ${e.message}`);
  } finally {
    publish(job);
  }
}

// The awaitable worker. Assembles context, runs facets in parallel, persists,
// streams snapshots, and finalizes with an overall score. Returns the job.
export async function runCritique({ projectId, job }) {
  projectId = await resolveProjectId(projectId);
  try {
    const beat = await getBeat(projectId, job.beat_id);
    if (!beat) throw new Error(`beat not found: ${job.beat_id}`);
    await setCritiquePending(projectId, beat._id, { model: CRITIQUE_MODEL, facets: facetStubs() });
    job.status = 'running';
    publish(job);

    const ctx = await buildCritiqueContext(projectId, beat);
    await Promise.allSettled(FACETS.map((f) => runOneFacet(f, ctx, job, projectId, beat._id)));

    const done = job.facets.filter((f) => f.status === 'done');
    const errored = job.facets.filter((f) => f.status === 'error');
    const overall = done.length
      ? Math.round(done.reduce((s, f) => s + f.score, 0) / done.length)
      : null;
    job.overall = overall;
    job.status = errored.length === 0 ? 'done' : done.length ? 'partial' : 'error';
    job.finished_at = new Date();
    await finalizeCritique(projectId, beat._id, { status: job.status, overall });
    publish(job);
    logger.info(`critique gen: beat=${beat._id} status=${job.status} overall=${overall ?? 'null'}`);
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    publish(job);
    logger.error(`critique gen: run crashed: ${e.message}`);
  } finally {
    const id = job.job_id;
    setTimeout(() => { jobs.delete(id); listeners.delete(id); }, TERMINAL_RETENTION_MS).unref?.();
  }
  return job;
}

// Start a run in the background. Returns the job id immediately (202). Throws a
// 409 httpError if a run is already active for this beat.
export async function startCritiqueJob({ projectId, beatId }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const busyKey = beat._id.toString();
  if (busyBeats.has(busyKey)) {
    throw httpError('A critique is already running for this beat.', 409);
  }
  busyBeats.add(busyKey);
  const job = createCritiqueJob(busyKey);
  setImmediate(() => {
    runCritique({ projectId, job })
      .catch((e) => logger.error(`critique gen: background run failed: ${e.message}`))
      .finally(() => busyBeats.delete(busyKey));
  });
  return job.job_id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/critiqueGenerate.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/critiqueGenerate.js tests/critiqueGenerate.test.js
git commit -m "✨ Add critique run engine + SSE job registry"
```

---

### Task 6: Body rewrite core (`src/web/beatRewrite.js`)

**Files:**
- Create: `src/web/beatRewrite.js`
- Test: `tests/beatRewrite.test.js` (create)

**Interfaces:**
- Consumes: `analyzeText` (llm/analyze.js); `getBeat` (plots.js); `getBeatCritique`, `stashPreviousBody`, `getPreviousBody`, `clearPreviousBody` (critiques.js); `setBeatBodyViaGateway` (gateway.js); `SCREENPLAY_STYLE_GUIDE` (screenplayStyle.js); `resolveProjectId` (projects.js).
- Produces:
  - `normalizeBeatBody(body) -> Promise<string>` (format-only rewrite)
  - `regenerateBeatBody({ beat, critique }) -> Promise<string>` (critique-driven rewrite + format)
  - `normalizeBeat(projectId, beatId) -> Promise<{ body }>` (stash + write via gateway)
  - `regenerateBeat(projectId, beatId) -> Promise<{ body }>` (throws `{status:409}` if no critique)
  - `restoreBeatBody(projectId, beatId) -> Promise<{ restored: boolean, body? }>`

- [ ] **Step 1: Write the failing test**

Create `tests/beatRewrite.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// beatRewrite → gateway pulls in the announce helpers; stub them (same as the
// route tests) so importing the gateway tree is side-effect-free.
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const C = await import('../src/mongo/critiques.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
const R = await import('../src/web/beatRewrite.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  // Stub Anthropic: analyzeText returns the text content.
  _setAnthropicClientForTests({
    messages: { create: async () => ({ content: [{ type: 'text', text: 'REWRITTEN' }] }) },
  });
});
afterEach(() => { _setAnthropicClientForTests(null); });

describe('normalizeBeat', () => {
  it('stashes the old body and writes the rewrite', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'prose body' });
    const res = await R.normalizeBeat(projectId, beat._id.toString());
    expect(res.body).toBe('REWRITTEN');
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.body).toBe('REWRITTEN');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('prose body');
  });
});

describe('regenerateBeat', () => {
  it('rejects with 409 when there is no critique', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await expect(R.regenerateBeat(projectId, beat._id.toString())).rejects.toMatchObject({ status: 409 });
  });

  it('rewrites from an existing critique and stashes the old body', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'old body' });
    await C.setCritiquePending(projectId, beat._id.toString(), {
      model: 'm',
      facets: [{ key: 'pacing', label: 'Pacing', scope: 'focused', score: 4, comments: 'slow', status: 'done', error_message: null }],
    });
    await C.finalizeCritique(projectId, beat._id.toString(), { status: 'done', overall: 4 });
    const res = await R.regenerateBeat(projectId, beat._id.toString());
    expect(res.body).toBe('REWRITTEN');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBe('old body');
  });
});

describe('restoreBeatBody', () => {
  it('restores the stashed body and clears the slot', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'orig' });
    await R.normalizeBeat(projectId, beat._id.toString()); // body -> REWRITTEN, prev -> orig
    const res = await R.restoreBeatBody(projectId, beat._id.toString());
    expect(res).toMatchObject({ restored: true, body: 'orig' });
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.body).toBe('orig');
    expect(await C.getPreviousBody(projectId, beat._id.toString())).toBeNull();
  });

  it('is a safe no-op when nothing is stashed', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const res = await R.restoreBeatBody(projectId, beat._id.toString());
    expect(res).toEqual({ restored: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/beatRewrite.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/beatRewrite.js`**

```js
// Shared beat-body rewrite core: Normalize (format-only) and Regenerate
// (critique-driven), plus Undo. Both stash the previous body before writing the
// new one through the gateway (so collaborative editors stay in sync) and share
// the single previous_body Undo slot. Uses analyzeText (returns plain text).

import { logger } from '../log.js';
import { analyzeText } from '../llm/analyze.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { getBeatCritique, stashPreviousBody, getPreviousBody, clearPreviousBody } from '../mongo/critiques.js';
import { setBeatBodyViaGateway } from './gateway.js';
import { SCREENPLAY_STYLE_GUIDE } from '../agent/screenplayStyle.js';

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const NORMALIZE_SYSTEM = [
  'You reformat a screenplay beat body to standard screenplay style WITHOUT changing its content, meaning, or events.',
  'Keep every story beat, character, and line; only fix the formatting to follow the guide below.',
  'Return ONLY the reformatted beat body as plain text — no preamble, no commentary, no code fences.',
  '',
  SCREENPLAY_STYLE_GUIDE,
].join('\n');

const REGEN_SYSTEM = [
  'You are a screenwriter revising one beat of a screenplay using a structured critique.',
  'Rewrite the beat body to address the critique comments while preserving the story\'s intent and the characters present.',
  'The rewrite MUST also conform to standard screenplay format per the guide below.',
  'Return ONLY the rewritten beat body as plain text — no preamble, no commentary, no code fences.',
  '',
  SCREENPLAY_STYLE_GUIDE,
].join('\n');

export async function normalizeBeatBody(body) {
  const out = await analyzeText({
    system: NORMALIZE_SYSTEM,
    user: `Reformat this beat body:\n\n${String(body || '')}`,
    maxTokens: 4000,
  });
  return out.trim();
}

function formatCritiqueForRewrite(critique) {
  const lines = (critique?.facets || [])
    .filter((f) => f.status === 'done' && (f.comments || '').trim())
    .map((f) => `## ${f.label} (score ${f.score ?? '—'}/10)\n${f.comments.trim()}`);
  return lines.length ? lines.join('\n\n') : '(no actionable critique comments)';
}

export async function regenerateBeatBody({ beat, critique }) {
  const user = [
    '# Critique to address',
    formatCritiqueForRewrite(critique),
    '',
    '# Current beat body to rewrite',
    String(beat?.body || ''),
  ].join('\n');
  const out = await analyzeText({ system: REGEN_SYSTEM, user, maxTokens: 4000 });
  return out.trim();
}

export async function normalizeBeat(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  await stashPreviousBody(projectId, beat._id, String(beat.body || ''));
  const body = await normalizeBeatBody(beat.body);
  await setBeatBodyViaGateway(projectId, beat._id, body);
  logger.info(`beatRewrite: normalize beat=${beat._id} chars=${body.length}`);
  return { body };
}

export async function regenerateBeat(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const critique = await getBeatCritique(projectId, beat._id);
  if (!critique || !(critique.facets || []).some((f) => f.status === 'done')) {
    throw httpError('No critique to regenerate from. Run a critique first.', 409);
  }
  await stashPreviousBody(projectId, beat._id, String(beat.body || ''));
  const body = await regenerateBeatBody({ beat, critique });
  await setBeatBodyViaGateway(projectId, beat._id, body);
  logger.info(`beatRewrite: regenerate beat=${beat._id} chars=${body.length}`);
  return { body };
}

export async function restoreBeatBody(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const prev = await getPreviousBody(projectId, beat._id);
  if (prev == null) return { restored: false };
  await setBeatBodyViaGateway(projectId, beat._id, prev);
  await clearPreviousBody(projectId, beat._id);
  logger.info(`beatRewrite: restore beat=${beat._id} chars=${prev.length}`);
  return { restored: true, body: prev };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/beatRewrite.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/web/beatRewrite.js tests/beatRewrite.test.js
git commit -m "✨ Add beat body normalize/regenerate/restore core"
```

---

### Task 7: REST endpoints (`src/web/entityRoutes.js`)

**Files:**
- Modify: `src/web/entityRoutes.js` (SSE route into the pre-`requireSession` block ~line 493; the five `/beat/:id/*` routes after `resolveBeatId` ~line 1094)
- Test: `tests/critique-routes.test.js` (create)

**Interfaces:**
- Consumes everything from Tasks 2, 5, 6.
- Produces HTTP routes: `GET /beat/:id/critique`, `POST /beat/:id/critique`, `GET /beat/:id/critique/:jobId/events` (SSE), `POST /beat/:id/regenerate`, `POST /beat/:id/normalize`, `POST /beat/:id/restore-body`.

- [ ] **Step 1: Write the failing test**

Create `tests/critique-routes.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const C = await import('../src/mongo/critiques.js');
const G = await import('../src/web/critiqueGenerate.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl, projectId;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  await Plots.updatePlot(projectId, { synopsis: 'S' });
});
afterEach(() => { G._setFacetGeneratorForTests(null); _setAnthropicClientForTests(null); });

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}
async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}

describe('critique routes', () => {
  it('GET /beat/:id/critique returns null before any run', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const { status, json } = await get(`/api/beat/${beat._id}/critique`);
    expect(status).toBe(200);
    expect(json.critique).toBeNull();
  });

  it('GET /beat/:id/critique 404s for an unknown beat', async () => {
    const { status } = await get('/api/beat/999/critique');
    expect(status).toBe(404);
  });

  it('POST /beat/:id/critique returns 202 + job_id', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b', order: 1 });
    G._setFacetGeneratorForTests(async () => ({ score: 7, comments: 'ok' }));
    const { status, json } = await post(`/api/beat/${beat._id}/critique`, {});
    expect(status).toBe(202);
    expect(json.job_id).toBeTruthy();
    // Drain the fire-and-forget run so it completes under the test's override.
    const terminal = (s) => ['done', 'partial', 'error'].includes(s);
    for (let i = 0; i < 100; i++) {
      const j = G.getCritiqueJob(json.job_id);
      if (!j || terminal(j.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  it('POST /beat/:id/normalize rewrites the body', async () => {
    _setAnthropicClientForTests({ messages: { create: async () => ({ content: [{ type: 'text', text: 'NORM' }] }) } });
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'prose' });
    const { status, json } = await post(`/api/beat/${beat._id}/normalize`, {});
    expect(status).toBe(200);
    expect(json.body).toBe('NORM');
  });

  it('POST /beat/:id/regenerate 409s with no critique', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const { status } = await post(`/api/beat/${beat._id}/regenerate`, {});
    expect(status).toBe(409);
  });

  it('POST /beat/:id/restore-body returns restored:false when nothing stashed', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const { status, json } = await post(`/api/beat/${beat._id}/restore-body`, {});
    expect(status).toBe(200);
    expect(json).toEqual({ restored: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/critique-routes.test.js`
Expected: FAIL — routes return 404 (not yet registered).

- [ ] **Step 3a: Add the SSE route (before `requireSession`)**

In `src/web/entityRoutes.js`, immediately after the chat-events route closes (after line 493, before `router.use(requireSession());` at line 495), insert:

```js
  // SSE stream of a beat critique run. Registered BEFORE requireSession() —
  // EventSource cannot set headers, so the session id arrives in the query.
  router.get('/beat/:id/critique/:jobId/events', async (req, res, next) => {
    try {
      const sid = String(req.query?.session_id || '');
      if (!sid) { res.status(401).json({ error: 'missing session' }); return; }
      const session = await getSession(sid);
      if (!session) { res.status(401).json({ error: 'invalid session' }); return; }
      touchSession(sid).catch(() => {});
      req.session = session;

      const {
        getCritiqueJob, subscribeToCritiqueJob, unsubscribeFromCritiqueJob, serializeCritiqueJob,
      } = await import('./critiqueGenerate.js');
      const job = getCritiqueJob(req.params.jobId);
      if (!job) { res.status(404).json({ error: 'job not found' }); return; }

      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`event: snapshot\ndata: ${JSON.stringify(serializeCritiqueJob(job))}\n\n`);

      const listener = (snap) => {
        const terminal = snap.status === 'done' || snap.status === 'partial' || snap.status === 'error';
        const eventName = terminal ? (snap.status === 'error' ? 'error' : 'done') : 'update';
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(snap)}\n\n`);
        if (terminal) { unsubscribeFromCritiqueJob(snap.job_id, listener); res.end(); }
      };
      subscribeToCritiqueJob(req.params.jobId, listener);

      if (job.status === 'done' || job.status === 'partial' || job.status === 'error') {
        unsubscribeFromCritiqueJob(req.params.jobId, listener);
        res.end();
        return;
      }

      const keepalive = setInterval(() => { res.write(`: keepalive ${Date.now()}\n\n`); }, 20_000);
      keepalive.unref?.();
      req.on('close', () => { clearInterval(keepalive); unsubscribeFromCritiqueJob(req.params.jobId, listener); });
    } catch (e) { next(e); }
  });
```

- [ ] **Step 3b: Add the five beat routes (after `resolveBeatId`)**

In `src/web/entityRoutes.js`, immediately after the `resolveBeatId` function closes (after line 1094, before `router.post('/beat/:id/image', ...)` at line 1096), insert:

```js
  router.get('/beat/:id/critique', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { getBeatCritique } = await import('../mongo/critiques.js');
      const critique = await getBeatCritique(req.projectId, beatId);
      res.json({ critique: critique || null });
    } catch (e) { next(e); }
  });

  router.post('/beat/:id/critique', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { startCritiqueJob } = await import('./critiqueGenerate.js');
      const jobId = await startCritiqueJob({ projectId: req.projectId, beatId });
      res.status(202).json({ job_id: jobId, beat_id: beatId });
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/beat/:id/regenerate', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { regenerateBeat } = await import('./beatRewrite.js');
      const result = await regenerateBeat(req.projectId, beatId);
      res.json(result);
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/beat/:id/normalize', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { normalizeBeat } = await import('./beatRewrite.js');
      const result = await normalizeBeat(req.projectId, beatId);
      res.json(result);
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.post('/beat/:id/restore-body', async (req, res, next) => {
    try {
      const beatId = await resolveBeatId(req);
      if (!beatId) return res.status(404).json({ error: 'beat not found' });
      const { restoreBeatBody } = await import('./beatRewrite.js');
      const result = await restoreBeatBody(req.projectId, beatId);
      res.json(result);
    } catch (e) {
      if (e?.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/critique-routes.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS (all existing + new tests green)

- [ ] **Step 6: Commit**

```bash
git add src/web/entityRoutes.js tests/critique-routes.test.js
git commit -m "✨ Add beat critique/normalize/regenerate/restore endpoints"
```

---

### Task 8: SPA — Critique tab, Background Normalize/Undo, styles

**Files:**
- Create: `web/src/widgets/CritiqueTab.jsx`
- Modify: `web/src/routes/Beat.jsx` (TABS, tabLabel, critique panel, Background Normalize/Undo)
- Modify: `web/src/styles.css` (scope-badge style)
- Verify: `npm run build:web`

**Interfaces:**
- Consumes endpoints from Task 7; `apiGet`, `apiPostJson`, `apiSseUrl` (api.js); `scoreBand` (`web/src/widgets/critiqueDisplay.js`).

- [ ] **Step 1: Create `web/src/widgets/CritiqueTab.jsx`**

```jsx
import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson, apiSseUrl } from '../api.js';
import { scoreBand } from './critiqueDisplay.js';

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export function CritiqueTab({ beatId, hasPreviousBody, onRefresh }) {
  const [critique, setCritique] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(null); // 'regen' | 'undo' | null
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/beat/${beatId}/critique`);
        if (!cancelled) setCritique(r.critique || null);
      } catch (e) { if (!cancelled) setError(e.message); }
    })();
    return () => { cancelled = true; if (esRef.current) esRef.current.close(); };
  }, [beatId]);

  function closeStream() { if (esRef.current) { esRef.current.close(); esRef.current = null; } }

  async function runCritique() {
    setRunning(true); setError(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/critique`, {});
      const jobId = r?.job_id;
      if (!jobId) throw new Error('server did not return a job id');
      const es = new EventSource(apiSseUrl(`/beat/${beatId}/critique/${jobId}/events`));
      esRef.current = es;
      const apply = (ev) => { const snap = safeParse(ev.data); if (snap) setCritique(snap); };
      es.addEventListener('snapshot', apply);
      es.addEventListener('update', apply);
      es.addEventListener('done', (ev) => { apply(ev); setRunning(false); closeStream(); });
      es.addEventListener('error', (ev) => {
        const data = ev?.data ? safeParse(ev.data) : null;
        if (data) { setCritique(data); setError('Critique finished with errors.'); setRunning(false); closeStream(); }
        else if (es.readyState === EventSource.CLOSED) { setRunning(false); setError('Connection lost.'); }
      });
    } catch (e) { setRunning(false); setError(e.message); }
  }

  async function regenerate() {
    setBusy('regen'); setError(null);
    try { await apiPostJson(`/beat/${beatId}/regenerate`, {}); await onRefresh?.(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function undo() {
    setBusy('undo'); setError(null);
    try { await apiPostJson(`/beat/${beatId}/restore-body`, {}); await onRefresh?.(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  const facets = critique?.facets || [];
  const hasCritique = facets.some((f) => f.status === 'done');

  return (
    <div className="critique-panel">
      <p className="tab-intro">
        Run a multi-facet AI critique of this beat — using the previous and next beats and the whole-story spine
        as context — then optionally rewrite the beat from the critique. Rewrites also normalize to screenplay format.
      </p>
      <div className="tab-actions critique-head">
        {critique?.overall != null ? (
          <span className={`critique-overall ${scoreBand(critique.overall)}`}>{critique.overall}<span className="max">/10</span></span>
        ) : <span className="critique-overall none">not critiqued</span>}
        <span className="spacer" />
        <button type="button" className="primary" disabled={running} onClick={runCritique}>
          {running ? 'Critiquing…' : critique ? 'Re-run critique' : 'Run critique'}
        </button>
        <button type="button" disabled={busy || running || !hasCritique} onClick={regenerate}>
          {busy === 'regen' ? 'Regenerating…' : 'Regenerate beat from critique'}
        </button>
        {hasPreviousBody && (
          <button type="button" disabled={busy} onClick={undo}>{busy === 'undo' ? 'Undoing…' : 'Undo rewrite'}</button>
        )}
      </div>
      {error && <div className="critique-error">{error}</div>}
      {facets.map((f) => (
        <div className="critique-lens" key={f.key}>
          <span className="lens-name">
            {f.label} <span className={`critique-scope scope-${f.scope}`}>{f.scope === 'story' ? 'Story' : 'Focused'}</span>
          </span>
          {f.status === 'pending' && <span className="lens-comment">scoring…</span>}
          {f.status === 'error' && <span className="lens-comment">errored: {f.error_message}</span>}
          {f.status === 'done' && (
            <>
              <span className={`lens-score ${scoreBand(f.score)}`}>{f.score}</span>
              <span className="lens-bar"><i className={scoreBand(f.score)} style={{ width: `${(f.score / 10) * 100}%` }} /></span>
              <span className="lens-comment">{f.comments}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wire the tab into `web/src/routes/Beat.jsx`**

Change the TABS array (line 15) to add `'critique'` after `'background'`:

```js
const TABS = ['characters', 'background', 'critique', 'attachments', 'references', 'artwork'];
```

Add the import (after line 13's `BeatTabs` import):

```js
import { CritiqueTab } from '../widgets/CritiqueTab.jsx';
```

Add a `tabLabel` case (in the `switch` ~line 226, after the `background` case):

```js
    case 'critique': return 'Critique';
```

Add the critique panel — inside the `<CollabSurface>`, immediately after the background `</div>` (after line 133), insert:

```jsx
        <div className="tab-panel" hidden={activeTab !== 'critique'}>
          <CritiqueTab
            beatId={beat._id}
            hasPreviousBody={Boolean(beat.previous_body)}
            onRefresh={onRefresh}
          />
        </div>
```

- [ ] **Step 3: Add Normalize + Undo to the Background panel in `web/src/routes/Beat.jsx`**

Add the handlers inside the `Beat` component (after the `onRefresh` function, ~line 83):

```js
  const [bgBusy, setBgBusy] = useState(null); // 'normalize' | 'undo' | null
  async function normalizeBody() {
    setBgBusy('normalize');
    try { await apiPostJson(`/beat/${beat._id}/normalize`, {}); onRefresh(); }
    catch (e) { setError(e.message); } finally { setBgBusy(null); }
  }
  async function undoBody() {
    setBgBusy('undo');
    try { await apiPostJson(`/beat/${beat._id}/restore-body`, {}); onRefresh(); }
    catch (e) { setError(e.message); } finally { setBgBusy(null); }
  }
```

Add `apiPostJson` to the api.js import (line 3):

```js
import { apiGet, apiPostJson } from '../api.js';
```

Replace the background panel body (lines 130-133) with:

```jsx
        <div className="tab-panel" hidden={activeTab !== 'background'}>
          <div className="tab-actions">
            <button type="button" disabled={bgBusy} onClick={normalizeBody}>
              {bgBusy === 'normalize' ? 'Normalizing…' : 'Normalize to screenplay format'}
            </button>
            {beat.previous_body && (
              <button type="button" disabled={bgBusy} onClick={undoBody}>
                {bgBusy === 'undo' ? 'Undoing…' : 'Undo'}
              </button>
            )}
          </div>
          <CollabField label="Name" field="name" />
          <CollabField label="Body" field="body" multiline />
        </div>
```

- [ ] **Step 4: Add the scope-badge style to `web/src/styles.css`**

Append (the `.critique-*` / `.lens-*` / `good|medium|bad` classes already exist from the storyboard CritiquePanel):

```css
.critique-scope {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  margin-left: 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  vertical-align: middle;
}
.critique-scope.scope-story { color: var(--accent); border-color: var(--accent); }
```

- [ ] **Step 5: Build the SPA to verify it compiles**

Run: `npm run build:web`
Expected: build completes with no errors; `web/dist/` is written.

- [ ] **Step 6: Manual verification checklist**

Run `npm run dev:web` (Vite on 5173) + the server (`npm run dev`), open a beat, and confirm:
- The **Critique** sub-tab appears between Background and Attachments.
- **Run critique** streams facet cards in live (scores + bars + scope badges + comments); an overall score appears.
- **Regenerate beat from critique** rewrites the Body (visible in the Background tab), and an **Undo rewrite** button appears.
- On the **Background** tab, **Normalize to screenplay format** reformats the Body; **Undo** restores the prior text.

- [ ] **Step 7: Commit**

```bash
git add web/src/widgets/CritiqueTab.jsx web/src/routes/Beat.jsx web/src/styles.css
git commit -m "✨ Add Critique tab + Background normalize/undo to the SPA"
```

---

## Final verification

- [ ] Run the whole backend suite: `npm test` — expect all green.
- [ ] Build the SPA: `npm run build:web` — expect a clean build.
- [ ] Confirm the feature end-to-end via the manual checklist in Task 8, Step 6.

## Notes for the implementer

- **Route ordering matters.** The SSE route (`/beat/:id/critique/:jobId/events`) MUST be registered before `router.use(requireSession())` (it authenticates via `?session_id=`), exactly like the storyboard video-job and chat SSE routes. The other five routes go after `resolveBeatId` is defined (inside `buildApiRouter`, after `requireSession`).
- **No route shadowing.** There is no `GET /beat/:id`, so `GET /beat/:id/critique` is safe. `/beat/:id/critique/:jobId/events` is deeper than `/beat/:id/critique`, so they don't collide.
- **Cross-client sync (deferred, YAGNI).** v1 does not broadcast a `fields_updated` ping for the critique object — the active client streams via SSE; other clients see the latest critique on their next mount/`GET`. Body rewrites DO sync live because they go through `setBeatBodyViaGateway` (the y-doc). If you later want live cross-client critique updates, add a `broadcastFieldsUpdated(buildRoomName('beat', beatId), { changed:['critique'] })` call in `finalizeCritique`'s gateway wrapper.
- **Model cost.** Seven Opus calls per run + one per rewrite. If cost matters later, drop the focused facets to `config.anthropic.enhancerModel` (Haiku) — the `format`/`direction`/`story_fit` facets benefit most from Opus.
- **No new agent tool.** `normalizeBeatBody()` is standalone so a `normalize_beat` agent tool could wrap it later (out of scope here).
```
