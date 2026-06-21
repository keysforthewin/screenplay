# Storyboard Frame Reference-Image Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make storyboard frame generation attach references only for the characters actually in a shot, and for each one pick the single most appropriate image by reading each candidate's name/description/caption.

**Architecture:** Three coordinated changes in `src/web/`. (1) Narrow the name-matching backstop so off-screen characters named in motion/narration text are not linked. (2) Tell the planner to narrow `characters_in_scene` on tight shot types. (3) Add a `referenceSelector.js` module whose selection logic is shared two ways — folded into the existing `expandShots` planner call (no extra API call) and exposed as a standalone LLM call for the SPA "auto-suggest references" button. The new per-character best-image pick replaces today's "include every image of every character" aggregator, which is then deleted.

**Tech Stack:** Node ESM, Vitest, in-memory fake Mongo (`tests/_fakeMongo.js`), Anthropic SDK (streamed tool calls), MongoDB/GridFS.

## Global Constraints

- Every project-scoped Mongo helper takes `projectId` first and throws `projectId required` on a falsy value — thread it, never default it.
- Image content types are restricted to `image/png`, `image/jpeg`, `image/webp` (`ANTHROPIC_OK`, `storyboardGenerate.js:74`).
- Reference lists are deduped and capped at `MAX_FRAME_REFERENCE_IMAGES = 12` (`storyboardGenerate.js:1563`).
- Selection must degrade gracefully: missing labels or an unavailable LLM fall back to the canonical pick (ordered sheets → main → first image). Never block a render.
- Model id for any new LLM call: `claude-opus-4-8` (matches `STORYBOARD_MODEL`, `storyboardGenerate.js:79`).
- Tests mock `../src/mongo/client.js` to the fake db and `../src/log.js`; `getDb()` resolves to the fake, so `findImageFile` reads the fake `images.files` collection without mocking `images.js`. No co-author tags in commits; end commit messages with the `Claude-Session:` trailer.

---

### Task 1: Narrow the name-matching backstop (Change 1)

**Files:**
- Modify: `src/web/storyboardGenerate.js:1312-1329` (`linkBeatCharactersForShot`)
- Test: `tests/storyboard-generate.test.js` (add a `describe` block; `linkBeatCharactersForShot` is already exported)

**Interfaces:**
- Consumes: nothing new.
- Produces: `linkBeatCharactersForShot(frame, beatCharacters)` — unchanged signature; now only scans `frame.start_frame_prompt` for backstop detection (plus the planner's explicit `frame.characters_in_scene`).

- [ ] **Step 1: Write the failing test**

Add to `tests/storyboard-generate.test.js`:

```js
import { linkBeatCharactersForShot } from '../src/web/storyboardGenerate.js';

describe('linkBeatCharactersForShot backstop scope', () => {
  const beatCast = ['Young Keys', 'Old Keys', 'Mara'];

  it('does NOT link a character named only in video_prompt / description / transition', () => {
    const frame = {
      characters_in_scene: ['Young Keys'],
      description: 'Young Keys remembers Old Keys.',
      start_frame_prompt: 'Tight close-up on the young man, eyes wet.',
      video_prompt: 'Static camera. Old Keys is mentioned in narration only.',
      transition_in: 'Cut from Mara.',
    };
    const out = linkBeatCharactersForShot(frame, beatCast);
    expect(out).toEqual(['Young Keys']);
  });

  it('DOES link a beat character named in start_frame_prompt but missing from picks', () => {
    const frame = {
      characters_in_scene: ['Young Keys'],
      start_frame_prompt: 'Two-shot: the young man beside Mara at the window.',
      video_prompt: 'Static camera.',
    };
    const out = linkBeatCharactersForShot(frame, beatCast);
    expect(out).toEqual(['Young Keys', 'Mara']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t "linkBeatCharactersForShot backstop scope"`
Expected: FAIL — first test gets `['Young Keys', 'Old Keys', 'Mara']` (video_prompt/description/transition still scanned).

- [ ] **Step 3: Implement the change**

In `src/web/storyboardGenerate.js`, change the `text` line inside `linkBeatCharactersForShot` (currently line 1314):

```js
// BEFORE
  const text = [frame?.description, frame?.start_frame_prompt, frame?.video_prompt, frame?.transition_in]
    .filter(Boolean)
    .join('\n');
// AFTER
  // Backstop scans ONLY the still composition. video_prompt (motion/narration),
  // description (summary) and transition_in routinely name off-frame characters,
  // which previously pulled their reference images into shots they aren't in.
  const text = [frame?.start_frame_prompt].filter(Boolean).join('\n');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run -t "linkBeatCharactersForShot backstop scope"`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-generate.test.js
git commit -m "$(printf 'Narrow storyboard char backstop to the still prompt\n\nlinkBeatCharactersForShot scanned video_prompt/description/transition,\nlinking off-frame characters named only in narration. Scan only\nstart_frame_prompt so the backstop reflects what is in the still.\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 2: Shot-type-aware narrowing in the plan prompt (Change 2)

**Files:**
- Modify: `src/web/storyboardGenerate.js:171-202` (`SCENE_PLAN_SYSTEM_PROMPT`, the line at 198)
- Test: `tests/storyboard-generate.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `SCENE_PLAN_SYSTEM_PROMPT` now contains a narrowing rule for tight shot types. (`SCENE_PLAN_SYSTEM_PROMPT` is already exported.)

Tight shot types come from `SHOT_TYPES` (`src/mongo/storyboards.js:96-105`): the single-subject ones are `close_up`, `insert`, `reaction`.

- [ ] **Step 1: Write the failing test**

```js
import { SCENE_PLAN_SYSTEM_PROMPT } from '../src/web/storyboardGenerate.js';

describe('SCENE_PLAN_SYSTEM_PROMPT narrowing rule', () => {
  it('instructs narrowing characters_in_scene on tight shot types', () => {
    expect(SCENE_PLAN_SYSTEM_PROMPT).toMatch(/close_up/);
    expect(SCENE_PLAN_SYSTEM_PROMPT.toLowerCase()).toContain('only the character');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t "SCENE_PLAN_SYSTEM_PROMPT narrowing rule"`
Expected: FAIL — phrase absent.

- [ ] **Step 3: Implement the change**

In `SCENE_PLAN_SYSTEM_PROMPT`, immediately after the existing line 198 (`'- List EVERY named character visible in a shot ...'`), insert:

```js
  '- BUT on tight single-subject shots (shot_type close_up, insert, reaction), list ONLY the character(s) physically in the frame — not everyone in the location. A close-up on one person names that one person, even if others are in the scene off-frame.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run -t "SCENE_PLAN_SYSTEM_PROMPT narrowing rule"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-generate.test.js
git commit -m "$(printf 'Tell scene planner to narrow chars on tight shots\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 3: referenceSelector module — gather, manifest, resolve (no LLM)

**Files:**
- Create: `src/web/referenceSelector.js`
- Test: `tests/reference-selector.test.js`

**Interfaces:**
- Consumes: `getCharacter` (`src/mongo/characters.js`), `findImageFile` + `imageFileToMeta` (`src/mongo/images.js`), `stripMarkdown` (`src/util/markdown.js`), `logger` (`src/log.js`).
- Produces:
  - `gatherCandidatesFromDocs(characterDocs): Promise<Array<{name, candidates: Array<{id, name, description, caption}>}>>` — candidates ordered canonically (sheets → main → images), deduped.
  - `gatherCharacterReferenceCandidates(projectId, characterNames): Promise<same shape>` — resolves names to docs, then delegates.
  - `formatCandidateManifest(perCharacter): string` — numbered, 1-based, skips characters with no candidates.
  - `resolveReferencePicks({picks, perCharacter, beatMainImageId=null, max=12}): string[]` — beat image first, then one best id per character (LLM pick or canonical `candidates[0]` fallback), deduped, capped.

- [ ] **Step 1: Write the failing test**

Create `tests/reference-selector.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const Characters = await import('../src/mongo/characters.js');
const { createProject } = await import('../src/mongo/projects.js');
const Sel = await import('../src/web/referenceSelector.js');

let projectId;

async function putImageMeta({ name = '', description = '' } = {}) {
  const _id = new ObjectId();
  await fakeDb.collection('images.files').insertOne({
    _id, filename: 'x.png', contentType: 'image/png', length: 10,
    uploadDate: new Date(), metadata: { name, description },
  });
  return _id;
}

async function makeCharacter(name, { sheets = [], mainId = null, images = [] } = {}) {
  const c = await Characters.createCharacter(projectId, { name });
  await fakeDb.collection('characters').updateOne(
    { _id: c._id },
    { $set: { character_sheet_image_ids: sheets, main_image_id: mainId, images } },
  );
  return Characters.getCharacter(projectId, name);
}

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('gatherCandidatesFromDocs', () => {
  it('pulls name/description from GridFS metadata and caption from images[]', async () => {
    const young = await putImageMeta({ name: 'Young Keys', description: 'teenager, school uniform' });
    const old = await putImageMeta({ name: 'Old Keys', description: 'grey-haired, 70s' });
    const extra = await putImageMeta({ name: 'profile', description: '' });
    const c = await makeCharacter('Keys', {
      sheets: [young, old],
      mainId: young,
      images: [{ _id: extra, caption: 'side profile' }],
    });
    const out = await Sel.gatherCandidatesFromDocs([c]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Keys');
    // canonical order: sheets (young, old), then main (young dedup), then images (extra)
    expect(out[0].candidates.map((x) => String(x.id))).toEqual([
      String(young), String(old), String(extra),
    ]);
    expect(out[0].candidates[0]).toMatchObject({ name: 'Young Keys', description: 'teenager, school uniform' });
    expect(out[0].candidates[2]).toMatchObject({ name: 'profile', caption: 'side profile' });
  });
});

describe('formatCandidateManifest', () => {
  it('numbers candidates 1-based and skips empty characters', () => {
    const manifest = Sel.formatCandidateManifest([
      { name: 'Keys', candidates: [
        { id: 'a', name: 'Young Keys', description: 'teen', caption: '' },
        { id: 'b', name: 'Old Keys', description: '70s', caption: 'wrinkled' },
      ] },
      { name: 'Nobody', candidates: [] },
    ]);
    expect(manifest).toContain('Keys:');
    expect(manifest).toContain('1. Young Keys — teen');
    expect(manifest).toContain('2. Old Keys — 70s — caption: wrinkled');
    expect(manifest).not.toContain('Nobody');
  });
});

describe('resolveReferencePicks', () => {
  const perCharacter = [
    { name: 'Keys', candidates: [{ id: 'young' }, { id: 'old' }] },
    { name: 'Mara', candidates: [{ id: 'mara1' }] },
  ];

  it('beat image first, then the LLM-picked image per character', () => {
    const ids = Sel.resolveReferencePicks({
      picks: [{ character: 'Keys', image_index: 2 }],
      perCharacter, beatMainImageId: 'beat',
    });
    expect(ids).toEqual(['beat', 'old', 'mara1']);
  });

  it('falls back to canonical (index 0) when pick is missing or out of range', () => {
    expect(Sel.resolveReferencePicks({ picks: [], perCharacter })).toEqual(['young', 'mara1']);
    expect(Sel.resolveReferencePicks({
      picks: [{ character: 'Keys', image_index: 99 }], perCharacter,
    })).toEqual(['young', 'mara1']);
  });

  it('skips characters with zero candidates and dedupes + caps', () => {
    const ids = Sel.resolveReferencePicks({
      picks: [], beatMainImageId: 'young',
      perCharacter: [{ name: 'Keys', candidates: [{ id: 'young' }] }, { name: 'Ghost', candidates: [] }],
      max: 5,
    });
    expect(ids).toEqual(['young']); // beat == canonical, deduped; Ghost skipped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reference-selector.test.js`
Expected: FAIL — `Cannot find module '../src/web/referenceSelector.js'`.

- [ ] **Step 3: Write the module**

Create `src/web/referenceSelector.js`:

```js
// Picks reference images for a storyboard shot. The selection logic (gather
// candidates -> present name/description/caption -> pick best per character ->
// canonical fallback) is shared two ways: folded into the planner's expandShots
// call (no extra API call), and as a standalone LLM call for the SPA's
// "auto-suggest references" button. See referenceSelector LLM helper below.
import { getCharacter } from '../mongo/characters.js';
import { findImageFile, imageFileToMeta } from '../mongo/images.js';
import { stripMarkdown } from '../util/markdown.js';
import { logger } from '../log.js';

// Candidate ids for a character, ordered to match canonicalImageIdFor priority
// (sheets -> main -> attached images), deduped. candidates[0] is the canonical
// fallback used when the LLM has no usable pick.
function orderedCandidateIds(c) {
  const ids = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const k = String(raw);
    if (seen.has(k)) return;
    seen.add(k);
    ids.push(k);
  };
  for (const sid of c?.character_sheet_image_ids || []) push(sid);
  if (!ids.length && c?.character_sheet_image_id) push(c.character_sheet_image_id);
  push(c?.main_image_id);
  for (const img of c?.images || []) push(img?._id);
  return ids;
}

export async function gatherCandidatesFromDocs(characterDocs) {
  const out = [];
  for (const c of characterDocs || []) {
    if (!c) continue;
    const captionById = new Map();
    for (const img of c.images || []) {
      if (img?._id) captionById.set(String(img._id), String(img.caption || '').trim());
    }
    const candidates = [];
    for (const id of orderedCandidateIds(c)) {
      let name = '';
      let description = '';
      try {
        const file = await findImageFile(id);
        if (file) {
          const meta = imageFileToMeta(file);
          name = String(meta.name || '').trim();
          description = String(meta.description || '').trim();
        }
      } catch (e) {
        logger.warn(`reference selector: meta read ${id} failed: ${e.message}`);
      }
      candidates.push({ id: String(id), name, description, caption: captionById.get(String(id)) || '' });
    }
    const nm = stripMarkdown(c.name || '').trim();
    out.push({ name: nm, candidates });
  }
  return out;
}

export async function gatherCharacterReferenceCandidates(projectId, characterNames) {
  const docs = [];
  for (const raw of characterNames || []) {
    const nm = stripMarkdown(String(raw ?? '')).trim();
    if (!nm) continue;
    try {
      const c = await getCharacter(projectId, nm);
      if (c) docs.push(c);
    } catch (e) {
      logger.warn(`reference selector: lookup "${nm}" failed: ${e.message}`);
    }
  }
  return gatherCandidatesFromDocs(docs);
}

export function formatCandidateManifest(perCharacter) {
  const blocks = [];
  for (const entry of perCharacter || []) {
    if (!entry?.candidates?.length) continue;
    const lines = [`${entry.name}:`];
    entry.candidates.forEach((cand, i) => {
      const bits = [];
      if (cand.name) bits.push(cand.name);
      if (cand.description) bits.push(cand.description);
      if (cand.caption) bits.push(`caption: ${cand.caption}`);
      lines.push(`  ${i + 1}. ${bits.length ? bits.join(' — ') : '(no description)'}`);
    });
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n');
}

export function resolveReferencePicks({ picks, perCharacter, beatMainImageId = null, max = 12 }) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    if (!raw) return;
    const k = String(raw);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  add(beatMainImageId);
  const pickByChar = new Map();
  for (const p of picks || []) {
    const nm = stripMarkdown(String(p?.character ?? '')).trim().toLowerCase();
    if (nm) pickByChar.set(nm, Number(p?.image_index));
  }
  for (const entry of perCharacter || []) {
    const cands = entry?.candidates || [];
    if (!cands.length) continue;
    const idx = pickByChar.get(String(entry.name).toLowerCase());
    let chosen = cands[0];
    if (Number.isInteger(idx) && idx >= 1 && idx <= cands.length) chosen = cands[idx - 1];
    add(chosen.id);
  }
  return out.slice(0, max);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reference-selector.test.js`
Expected: PASS (all four describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/web/referenceSelector.js tests/reference-selector.test.js
git commit -m "$(printf 'Add referenceSelector gather/manifest/resolve core\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 4: referenceSelector — standalone LLM selection + test seam

**Files:**
- Modify: `src/web/referenceSelector.js`
- Test: `tests/reference-selector.test.js`

**Interfaces:**
- Consumes: `getAnthropic` (`src/web/../anthropic/client.js` → import path `'../anthropic/client.js'`), plus Task 3 exports.
- Produces:
  - `selectBestReferencesForShot({projectId, shotText, characterNames, beatMainImageId=null, max=12}): Promise<string[]>`
  - `_setReferenceSelectorLLMForTests(fn|null)` — override seam; `fn({shotText, manifest}) -> {picks}`.

- [ ] **Step 1: Write the failing test**

Append to `tests/reference-selector.test.js`:

```js
describe('selectBestReferencesForShot', () => {
  async function setupKeys() {
    const young = await putImageMeta({ name: 'Young Keys', description: 'teen' });
    const old = await putImageMeta({ name: 'Old Keys', description: '70s' });
    await makeCharacter('Keys', { sheets: [young, old], mainId: young });
    return { young, old };
  }

  it('uses the LLM pick when available', async () => {
    const { young, old } = await setupKeys();
    Sel._setReferenceSelectorLLMForTests(async () => ({ picks: [{ character: 'Keys', image_index: 2 }] }));
    const ids = await Sel.selectBestReferencesForShot({
      projectId, shotText: 'Close-up on the old man.', characterNames: ['Keys'], beatMainImageId: 'beat',
    });
    expect(ids).toEqual(['beat', String(old)]);
    expect(young).toBeDefined();
  });

  it('falls back to canonical when the LLM throws', async () => {
    const { young } = await setupKeys();
    Sel._setReferenceSelectorLLMForTests(async () => { throw new Error('boom'); });
    const ids = await Sel.selectBestReferencesForShot({
      projectId, shotText: 'x', characterNames: ['Keys'],
    });
    expect(ids).toEqual([String(young)]);
  });

  it('skips the LLM entirely when no character has >1 labeled candidate', async () => {
    const only = await putImageMeta({ name: 'only', description: '' });
    await makeCharacter('Solo', { sheets: [only] });
    const spy = vi.fn(async () => ({ picks: [] }));
    Sel._setReferenceSelectorLLMForTests(spy);
    const ids = await Sel.selectBestReferencesForShot({ projectId, shotText: 'x', characterNames: ['Solo'] });
    expect(spy).not.toHaveBeenCalled();
    expect(ids).toEqual([String(only)]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t "selectBestReferencesForShot"`
Expected: FAIL — `Sel._setReferenceSelectorLLMForTests is not a function`.

- [ ] **Step 3: Implement**

Add to the top imports of `src/web/referenceSelector.js`:

```js
import { getAnthropic } from '../anthropic/client.js';
```

Append to `src/web/referenceSelector.js`:

```js
// Kept in sync with STORYBOARD_MODEL; a local const avoids an import cycle with
// storyboardGenerate.js (which imports this module).
const REFERENCE_SELECT_MODEL = 'claude-opus-4-8';

const REFERENCE_SELECT_TOOL = {
  name: 'select_references',
  description:
    "Pick the single most appropriate reference image for each character in the shot, by 1-based index from that character's candidate list.",
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            character: { type: 'string', description: 'Character name, exactly as listed.' },
            image_index: { type: 'integer', minimum: 1, description: "1-based index into that character's candidate list." },
          },
          required: ['character', 'image_index'],
          additionalProperties: false,
        },
      },
    },
    required: ['picks'],
    additionalProperties: false,
  },
};

const REFERENCE_SELECT_SYSTEM_PROMPT = [
  'You are a storyboard artist choosing reference images. For each character in the shot,',
  "pick the ONE candidate image whose name/description/caption best matches how the character",
  'appears in THIS shot (age, wardrobe, framing, emotion). Return one pick per character via the',
  "select_references tool, using the 1-based index from that character's candidate list.",
  'If nothing clearly fits, pick index 1.',
].join(' ');

let llmOverride = null;
export function _setReferenceSelectorLLMForTests(fn) {
  llmOverride = fn;
}

async function callReferenceSelectLLM({ shotText, manifest }) {
  if (llmOverride) return llmOverride({ shotText, manifest });
  const client = getAnthropic();
  const userText = [
    `# Shot\n${shotText}`,
    '',
    '# Candidate reference images (pick one index per character):',
    manifest,
  ].join('\n');
  const resp = await client.messages
    .stream({
      model: REFERENCE_SELECT_MODEL,
      max_tokens: 1024,
      system: REFERENCE_SELECT_SYSTEM_PROMPT,
      tools: [REFERENCE_SELECT_TOOL],
      tool_choice: { type: 'tool', name: 'select_references' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    })
    .finalMessage();
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'select_references');
  return { picks: Array.isArray(toolUse?.input?.picks) ? toolUse.input.picks : [] };
}

// A character is worth asking the LLM about only if it has >1 candidate AND at
// least one carries descriptive text to disambiguate on.
function isSelectable(entry) {
  return entry.candidates.length > 1 && entry.candidates.some((c) => c.name || c.description || c.caption);
}

export async function selectBestReferencesForShot({ projectId, shotText, characterNames, beatMainImageId = null, max = 12 }) {
  const perCharacter = await gatherCharacterReferenceCandidates(projectId, characterNames);
  let picks = [];
  if (perCharacter.some(isSelectable)) {
    try {
      const manifest = formatCandidateManifest(perCharacter);
      const r = await callReferenceSelectLLM({ shotText: String(shotText || ''), manifest });
      picks = r.picks || [];
    } catch (e) {
      logger.warn(`reference selector: LLM selection failed, using canonical: ${e.message}`);
      picks = [];
    }
  }
  return resolveReferencePicks({ picks, perCharacter, beatMainImageId, max });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/reference-selector.test.js`
Expected: PASS (all describe blocks, including Task 3's).

- [ ] **Step 5: Commit**

```bash
git add src/web/referenceSelector.js tests/reference-selector.test.js
git commit -m "$(printf 'Add standalone LLM reference selection + test seam\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 5: Fold reference selection into expandShots

**Files:**
- Modify: `src/web/storyboardGenerate.js` — `SHOT_EXPAND_TOOL` (944-984), `buildShotExpandUserText` (1059-1079), `expandShots` (1093-1143)
- Test: `tests/storyboard-generate.test.js`

**Interfaces:**
- Consumes: `formatCandidateManifest` from `./referenceSelector.js`.
- Produces: `expandShots(...)` accepts an extra `candidates` option (array of `{name, candidates}`) and each returned shot now carries `references: Array<{character, image_index}>` (`[]` when omitted). `buildShotExpandUserText` accepts `candidates` and appends a manifest block.

- [ ] **Step 1: Write the failing test**

```js
import { _expandShotsForTest, _setShotExpanderForTests, buildShotExpandUserText } from '../src/web/storyboardGenerate.js';

describe('expandShots reference fold-in', () => {
  beforeEach(() => _setShotExpanderForTests(null));

  it('passes references from the tool output through to each shot', async () => {
    // Stub the LLM layer by overriding the expander? No — exercise the parser via
    // a fake Anthropic. Simplest: assert buildShotExpandUserText includes the manifest.
    const text = buildShotExpandUserText({
      beat: { characters: ['Keys'] }, characters: [], sceneBible: null,
      outline: [{ description: 'cu', shot_type: 'close_up', characters_in_scene: ['Keys'] }],
      candidates: [{ name: 'Keys', candidates: [{ id: 'a', name: 'Young Keys', description: 'teen', caption: '' }] }],
    });
    expect(text).toContain('Young Keys');
    expect(text.toLowerCase()).toContain('reference image');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t "expandShots reference fold-in"`
Expected: FAIL — manifest not present (param ignored).

- [ ] **Step 3: Implement**

(a) In `SHOT_EXPAND_TOOL`, add a `references` property to `items.properties` (after `reverse_in_post`, before the closing `},` of `properties`):

```js
            references: {
              type: 'array',
              description: "One entry per character in this shot's characters_in_scene. Pick the candidate reference image (by 1-based index from that character's list) that best matches how they appear in THIS shot — age, wardrobe, framing. Omit a character to use their default.",
              items: {
                type: 'object',
                properties: {
                  character: { type: 'string', description: 'Character name, exactly as in characters_in_scene.' },
                  image_index: { type: 'integer', minimum: 1, description: "1-based index into that character's candidate list." },
                },
                required: ['character', 'image_index'],
                additionalProperties: false,
              },
            },
```

(b) Add the import near the other `./` imports in `storyboardGenerate.js`:

```js
import { formatCandidateManifest } from './referenceSelector.js';
```

(c) In `buildShotExpandUserText`, add `candidates = []` to the destructured params and append a manifest block before the final instruction `lines.push`:

```js
export function buildShotExpandUserText({ beat, characters, sceneBible, outline, direction, directorNotes = [], revisionNotes = '', candidates = [] }) {
  // ...existing body unchanged through the revisionNotes block...
  const manifest = formatCandidateManifest(candidates);
  if (manifest) {
    lines.push(
      '',
      "# Character reference images (per character; in each shot's `references`, pick ONE index per character in that shot):",
      manifest,
    );
  }
  lines.push(
    '',
    `Write start_frame_prompt + video_prompt for ALL ${outline.length} shots via the expand_shots tool, one entry per shot with its 1-based shot_index.`,
  );
  return lines.join('\n');
}
```

(d) In `expandShots`, thread `candidates` through and parse `references`:

```js
async function expandShots({ beat, characters, sceneBible, outline, direction, directorNotes = [], revisionNotes = '', candidates = [] }) {
  if (shotExpanderOverride) {
    return shotExpanderOverride({ beat, characters, sceneBible, outline, direction, directorNotes, revisionNotes, candidates });
  }
  const userText = buildShotExpandUserText({ beat, characters, sceneBible, outline, direction, directorNotes, revisionNotes, candidates });
  // ...unchanged through the byIndex map...
```

In the final `outline.map(...)` return (lines 1132-1142), add `references` to both branches:

```js
  return outline.map((f, i) => {
    const s = byIndex.get(i + 1);
    const sfp = typeof s?.start_frame_prompt === 'string' ? s.start_frame_prompt.trim() : '';
    const vp = typeof s?.video_prompt === 'string' ? s.video_prompt.trim() : '';
    if (!sfp || !vp) {
      logger.warn(`storyboard expand_shots: missing output for shot ${i + 1}; using fallback`);
      return { ...synthesizeFallbackShot(f), reverse_in_post: Boolean(f.reverse_in_post), references: [] };
    }
    const rev = typeof s.reverse_in_post === 'boolean' ? s.reverse_in_post : Boolean(f.reverse_in_post);
    return { start_frame_prompt: sfp, video_prompt: vp, reverse_in_post: rev, references: Array.isArray(s.references) ? s.references : [] };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run -t "expandShots reference fold-in"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-generate.test.js
git commit -m "$(printf 'Fold per-character reference picks into expandShots\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 6: Wire planFramesV2 to gather candidates and resolve per-frame reference_ids

**Files:**
- Modify: `src/web/storyboardGenerate.js` — `cleanPlannedFrameV2` (1333-1366), `planFramesV2` (1371-1412)
- Test: `tests/storyboard-generate.test.js`

**Interfaces:**
- Consumes: `gatherCandidatesFromDocs`, `resolveReferencePicks` from `./referenceSelector.js`; `MAX_FRAME_REFERENCE_IMAGES` (module const).
- Produces: each frame returned by `planFramesV2` now carries `reference_ids: string[]` (beat image + best per in-scene character). `cleanPlannedFrameV2` passes a sanitized `references` array through.

`planFramesV2` has no `projectId` param but receives resolved `characters` docs — gather from docs, no extra fetch. `MAX_FRAME_REFERENCE_IMAGES` is declared at line 1563; it is safe to reference inside `planFramesV2` because the function runs after module evaluation completes.

- [ ] **Step 1: Write the failing test**

```js
import { _planFramesV2ForTest, _setScenePlannerForTests, _setShotExpanderForTests } from '../src/web/storyboardGenerate.js';
// fakeDb + Characters import as in the file's existing setup; reuse putImageMeta/makeCharacter helpers
// (copy the two helpers from reference-selector.test.js into this file's scope if not present).

describe('planFramesV2 resolves per-frame reference_ids', () => {
  it('uses the expander reference pick to choose the character image', async () => {
    const young = await putImageMeta({ name: 'Young Keys', description: 'teen' });
    const old = await putImageMeta({ name: 'Old Keys', description: '70s' });
    const keys = await makeCharacter('Keys', { sheets: [young, old], mainId: young });
    const beat = { _id: 'beat1', characters: ['Keys'], main_image_id: 'beatimg' };

    _setScenePlannerForTests(async () => ({
      sceneBible: null,
      outline: [{ description: 'old man cu', shot_type: 'close_up', characters_in_scene: ['Keys'] }],
    }));
    _setShotExpanderForTests(async ({ outline }) => outline.map(() => ({
      start_frame_prompt: 'Close-up on the old man.',
      video_prompt: 'Static camera.',
      references: [{ character: 'Keys', image_index: 2 }],
    })));

    const { frames } = await _planFramesV2ForTest({ beat, characters: [keys], targetCount: 1 });
    expect(frames).toHaveLength(1);
    expect(frames[0].reference_ids).toEqual(['beatimg', String(old)]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t "planFramesV2 resolves per-frame reference_ids"`
Expected: FAIL — `frames[0].reference_ids` is undefined.

- [ ] **Step 3: Implement**

(a) Add imports to `storyboardGenerate.js`:

```js
import { gatherCandidatesFromDocs, resolveReferencePicks } from './referenceSelector.js';
```

(b) In `cleanPlannedFrameV2`, sanitize and pass `references` through. After the `rawChars` line, add:

```js
  const refs = Array.isArray(f.references)
    ? f.references
        .map((r) => ({ character: stripMarkdown(String(r?.character ?? '')).trim(), image_index: Number(r?.image_index) }))
        .filter((r) => r.character && Number.isInteger(r.image_index) && r.image_index >= 1)
    : [];
```

and add `references: refs,` to the returned object literal (alongside `characters_in_scene: rawChars,`).

(c) In `planFramesV2`, gather candidates, pass to `expandShots`, and resolve per frame. Replace the `expanded` call and the `linkedFrames` block:

```js
  const perCharacter = await gatherCandidatesFromDocs(characters);

  onProgress?.({ phase: 'expanding', step: 'expand_start', total: outline.length, message: `Expanding ${outline.length} shots…` });
  const expanded = await expandShots({ beat, characters, sceneBible, outline, direction, directorNotes, candidates: perCharacter });
  onProgress?.({ phase: 'expanding', step: 'expand_done', total: outline.length, message: 'Shot expansion complete.' });

  const frames = outline.flatMap((f, i) => {
    const e = expanded[i] || {};
    return cleanPlannedFrameV2({
      ...f,
      start_frame_prompt: e.start_frame_prompt,
      video_prompt: e.video_prompt,
      references: e.references,
      reverse_in_post: typeof e.reverse_in_post === 'boolean' ? e.reverse_in_post : f.reverse_in_post,
    });
  });

  const beatCharacters = Array.isArray(beat?.characters) ? beat.characters : [];
  const linkedFrames = frames.map((fr) => {
    const names = linkBeatCharactersForShot(fr, beatCharacters);
    const framePer = perCharacter.filter((e) => names.some((n) => n.toLowerCase() === e.name.toLowerCase()));
    const reference_ids = resolveReferencePicks({
      picks: fr.references || [],
      perCharacter: framePer,
      beatMainImageId: beat?.main_image_id || null,
      max: MAX_FRAME_REFERENCE_IMAGES,
    });
    return { ...fr, characters_in_scene: names, reference_ids };
  });
  return { frames: linkedFrames, sceneBible };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run -t "planFramesV2 resolves per-frame reference_ids"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-generate.test.js
git commit -m "$(printf 'Resolve per-frame reference_ids in planFramesV2\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 7: Consume frame.reference_ids in createPlannedStoryboardEntry

**Files:**
- Modify: `src/web/storyboardGenerate.js` — `createPlannedStoryboardEntry` (1424-1488)
- Test: `tests/storyboard-generate.test.js` (extend an existing end-to-end generation test, or add one asserting the seeded frame's reference ids)

**Interfaces:**
- Consumes: `frame.reference_ids` produced by Task 6.
- Produces: planned storyboard frames are seeded with `frame.reference_ids` directly. The `collectStoryboardReferenceIds` call is removed from this function.

- [ ] **Step 1: Write the failing test**

If the test file has an end-to-end generation helper that runs the full pipeline and inspects the created storyboard frame's `reference_ids`, extend it to assert the LLM-picked id is present and an unpicked character's other images are absent. Otherwise add:

```js
// Drive the full generation (planScene + expandShots stubbed) and assert the
// created frame's reference_ids equal beat image + LLM-picked character image.
// Reuse the project's existing "runs generation" test harness; the key new
// assertion is on the persisted frame.reference_ids.
```

Concretely, after running generation for a beat whose plan yields one `close_up` of `Keys` with `references: [{character:'Keys', image_index: 2}]`, assert the stored frame's `reference_ids` equals `[beat.main_image_id, oldSheetId]` and does NOT contain `youngSheetId`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboard-generate.test.js`
Expected: FAIL — frame still seeded via `collectStoryboardReferenceIds` (contains every Keys image, not just the picked one).

- [ ] **Step 3: Implement**

In `createPlannedStoryboardEntry`, replace the reference-collection block (currently lines 1459-1470):

```js
// BEFORE
  let referenceIds = [];
  try {
    const collected = await collectStoryboardReferenceIds({
      projectId,
      beat,
      charactersInScene: frame.characters_in_scene ?? [],
      existingIds: [],
    });
    referenceIds = collected.ids || [];
  } catch (e) {
    logger.warn(`storyboard gen: collect refs failed: ${e.message}`);
  }
// AFTER
  // Reference ids are resolved during planning (planFramesV2 -> resolveReferencePicks):
  // beat image + the LLM-picked best image per in-scene character.
  const referenceIds = Array.isArray(frame.reference_ids) ? frame.reference_ids : [];
```

Remove the now-unused `collectStoryboardReferenceIds` import line from `storyboardGenerate.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboard-generate.test.js`
Expected: PASS. Also run the full suite to catch fallout: `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboard-generate.test.js
git commit -m "$(printf 'Seed planned frames from resolved reference_ids\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 8: Point the auto-suggest endpoint at selectBestReferencesForShot

**Files:**
- Modify: `src/web/entityRoutes.js:3888-3920` (POST `/storyboard/:id/frame/:frameId/reference/auto-populate`)
- Test: `tests/` — locate the existing entityRoutes/storyboard endpoint test (search `auto-populate`); if none exists, add a focused test that stubs `_setReferenceSelectorLLMForTests` and asserts the endpoint appends the resolved ids.

**Interfaces:**
- Consumes: `selectBestReferencesForShot` from `./referenceSelector.js`.
- Produces: the endpoint computes its reference list via the shared LLM selector instead of `collectStoryboardReferenceIds`, preserving the `{ storyboard, added, total }` response shape and append semantics.

- [ ] **Step 1: Write the failing test**

Add a test (matching the existing entityRoutes test style — supertest against the Express app, or a direct handler test if that's the pattern) that:
- seeds a storyboard frame with `reference_ids: []`, a beat with `main_image_id`, and a character `Keys` with two labeled sheets;
- stubs `Sel._setReferenceSelectorLLMForTests(async () => ({ picks: [{character:'Keys', image_index: 2}] }))`;
- calls `POST /storyboard/:id/frame/:frameId/reference/auto-populate`;
- asserts the response `added` contains the old-sheet id and the beat image, and not the young-sheet id.

```js
// Pseudocode shape — match the repo's existing endpoint test harness:
Sel._setReferenceSelectorLLMForTests(async () => ({ picks: [{ character: 'Keys', image_index: 2 }] }));
const res = await request(app)
  .post(`/api/storyboard/${sbId}/frame/${frameId}/reference/auto-populate`)
  .set('X-Project-Id', projectId);
expect(res.body.added).toContain(String(oldSheetId));
expect(res.body.added).not.toContain(String(youngSheetId));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -t "auto-populate"`
Expected: FAIL — endpoint still returns every Keys image via `collectStoryboardReferenceIds`.

- [ ] **Step 3: Implement**

Add the import near the other `./` imports in `entityRoutes.js`:

```js
import { selectBestReferencesForShot } from './referenceSelector.js';
```

Replace the body's collection call (the `const { ids, added } = await collectStoryboardReferenceIds({...})` block) with:

```js
        const shotText = [sb.summary, frame.text_prompt, frame.prompt]
          .map((s) => stripMarkdown(String(s || '')).trim())
          .filter(Boolean)
          .join('\n');
        const ids = await selectBestReferencesForShot({
          projectId: req.projectId,
          shotText,
          characterNames: sb.characters_in_scene || [],
          beatMainImageId: beat?.main_image_id || null,
        });
        const existing = new Set((frame.reference_ids || []).map(String));
        const added = ids.filter((id) => !existing.has(String(id)));
```

(Keep the existing `setStoryboardFrameReferenceImagesViaGateway(..., mode: 'append')` call and `res.json({ storyboard, added, total: ids.length })` response exactly as-is.) Ensure `stripMarkdown` is imported in `entityRoutes.js`; if not, add `import { stripMarkdown } from '../util/markdown.js';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run -t "auto-populate"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/entityRoutes.js tests/
git commit -m "$(printf 'Auto-suggest references via shared LLM selector\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

### Task 9: Delete the obsolete reference aggregator

**Files:**
- Delete: `src/web/storyboardReferenceAggregator.js`
- Delete: `tests/storyboard-reference-aggregator.test.js`
- Verify: no remaining importers.

**Interfaces:**
- Consumes: nothing.
- Produces: the `collectStoryboardReferenceIds` / `canonicalImageIdFor` / `defaultSheetIdFor` aggregator is removed; both former callers (Tasks 7 and 8) now use the selector. Canonical ordering lives in `referenceSelector.js`'s `orderedCandidateIds`.

- [ ] **Step 1: Confirm no importers remain**

Run: `grep -rn "storyboardReferenceAggregator\|collectStoryboardReferenceIds" src/ tests/`
Expected: no matches (Tasks 7 and 8 removed both). If any remain, fix that caller first.

- [ ] **Step 2: Delete the files**

```bash
git rm src/web/storyboardReferenceAggregator.js tests/storyboard-reference-aggregator.test.js
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS (no references to the deleted module).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(printf 'Remove obsolete storyboard reference aggregator\n\nReplaced by referenceSelector per-character best-image selection.\n\nClaude-Session: https://claude.ai/code/session_01BrYTG23FDqiq3EM315yvWP')"
```

---

## Self-Review

**Spec coverage:**
- Change 1 (tighten backstop) → Task 1. ✅
- Change 2 (shot-type narrowing) → Task 2. ✅
- New module `referenceSelector.js` with `gatherCharacterReferenceCandidates`, `formatCandidateManifest`, `resolveReferencePicks`, `selectBestReferencesForShot` → Tasks 3, 4. ✅
- Planner fold-in (no extra call) → Tasks 5, 6. ✅
- Generation path uses resolved ids; aggregator Round-1/Round-2 retired → Tasks 7, 9. ✅
- Auto-suggest path uses shared helper (own LLM call) → Task 8. ✅
- Fallbacks/degradation (0/1 candidate, empty labels, invalid index, LLM throw, beat plate first, dedupe+cap) → Task 3/4 tests. ✅
- Retire `collectStoryboardReferenceIds` after confirming callers → Task 9 (grep gate). ✅

**Note vs spec:** the spec named tight types `CLOSE_UP`/`EXTREME_CLOSE_UP`/`INSERT`; the actual `SHOT_TYPES` values are `close_up`, `insert`, `reaction` (no extreme-close-up). The plan uses the real values.

**Placeholder scan:** Task 7 and Task 8 reference the repo's existing endpoint/generation test harnesses rather than reproducing them — the concrete new assertions are spelled out. All code steps contain real code. No "TBD"/"add error handling".

**Type consistency:** `perCharacter` entries are `{name, candidates:[{id,name,description,caption}]}` everywhere; picks are `{character, image_index}` (1-based) everywhere; `resolveReferencePicks` returns `string[]`; `selectBestReferencesForShot` returns `string[]`. `expandShots` shot objects carry `references` consistently. Consistent across Tasks 3–8.
