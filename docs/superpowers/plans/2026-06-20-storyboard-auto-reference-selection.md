# Automatic Reference-Image Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When generating storyboard frame images, automatically pick the most relevant reference images (library artwork + scene characters) for each frame that has none, write them into `frame.reference_ids` for review, and use them for generation.

**Architecture:** A new text-only LLM selector (`src/llm/frameReferenceSelector.js`) ranks a numbered catalog and returns chosen indices. A new orchestrator (`src/web/frameReferences.js`) builds the catalog (library images via `listLibraryImages` + scene-character portraits via `getCharacter`), calls the selector, and persists picks through the existing gateway. `regenerateStoryboardFrameInternal` calls the orchestrator in its generate branch before loading references. A checkbox on the "Generate all images" dialog toggles the behavior (default on).

**Tech Stack:** Node.js (ESM), Vitest, Anthropic SDK (haiku-tier via `config.anthropic.enhancerModel`), MongoDB GridFS, React/Vite SPA.

## Global Constraints

- **Graceful degradation:** every failure in the selection path (no API key, bad JSON, no candidates, Mongo error) logs a warning and returns `[]` — generation is NEVER blocked or thrown out of. Mirror `src/llm/libraryImageMeta.js`.
- **Never override manual picks:** only auto-fill when `frame.reference_ids` is empty.
- **No image bytes sent to the selector** — text matching on names/descriptions only.
- **Per-frame cap:** `AUTO_REFERENCE_MAX = 6` (under the existing `MAX_FRAME_REFERENCE_IMAGES = 12` and all model caps).
- **Selector model:** `config.anthropic.enhancerModel` (NOT the main model).
- **Commit style:** gitmoji prefix (e.g. `✨`, `🧪`, `🔌`), no `Co-Authored-By`/attribution trailers (repo policy; a hook strips them).
- **Project scoping:** all Mongo helpers take `projectId` first; never add defaults.

## File Structure

- **Create `src/llm/frameReferenceSelector.js`** — `selectFrameReferences({ sceneText, candidates, max })`. Pure LLM ranking; no Mongo. Sibling of `libraryImageMeta.js`.
- **Create `src/web/frameReferences.js`** — `buildFrameReferenceCandidates(...)` + `autoFillFrameReferencesIfEmpty(...)`. Catalog assembly + persistence orchestration.
- **Modify `src/web/storyboardGenerate.js`** — import the orchestrator; call it in the generate branch of `regenerateStoryboardFrameInternal`; thread `autoReferences` through `startBulkFrameGenerationJob` → `runBulkFrameGenerationJob`.
- **Modify `src/web/entityRoutes.js:5012`** — read `auto_references` from the bulk-generate request body.
- **Modify `web/src/widgets/BulkGenerateImagesDialog.jsx`** — add the "Auto-pick reference images" checkbox.
- **Modify `web/src/routes/StoryboardBeat.jsx`** — send `auto_references` in the generate-all POST.
- **Create `tests/frameReferenceSelector.test.js`**, **`tests/frameReferences.test.js`**.

---

## Task 1: LLM reference selector

**Files:**
- Create: `src/llm/frameReferenceSelector.js`
- Test: `tests/frameReferenceSelector.test.js`

**Interfaces:**
- Consumes: `getAnthropic` from `src/anthropic/client.js`; `config.anthropic.{apiKey,enhancerModel}`; `logger`.
- Produces: `selectFrameReferences({ sceneText, candidates, max }) -> Promise<string[]>` where `candidates` is `[{ id: string, kind: 'art'|'char', name: string, description: string }]`. Returns a subset of candidate `id` strings (≤ `max`), preserving model order, deduped; `[]` on any failure.

- [ ] **Step 1: Write the failing test**

Create `tests/frameReferenceSelector.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: messagesCreate };
    }
  },
}));

const warnSpy = vi.fn();
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: warnSpy, debug: () => {}, error: () => {} },
}));

let hasKey = true;
vi.mock('../src/config.js', () => ({
  config: {
    get anthropic() {
      return {
        apiKey: hasKey ? 'test-key' : null,
        enhancerModel: 'claude-haiku-4-5-20251001',
        model: 'claude-opus-4-7',
      };
    },
  },
}));

const { _resetAnthropicClientForTests } = await import('../src/anthropic/client.js');
const { selectFrameReferences } = await import('../src/llm/frameReferenceSelector.js');

const CANDS = [
  { id: 'art1', kind: 'art', name: 'Neon alley', description: 'rain-slick alley at night' },
  { id: 'art2', kind: 'art', name: 'Diner interior', description: 'chrome booths, daylight' },
  { id: 'char1', kind: 'char', name: 'Steve', description: '' },
];

function mockReply(jsonText) {
  messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: jsonText }] });
}

beforeEach(() => {
  messagesCreate.mockReset();
  warnSpy.mockReset();
  hasKey = true;
  _resetAnthropicClientForTests();
});

describe('selectFrameReferences', () => {
  it('maps returned numbers to candidate ids, preserving order', async () => {
    mockReply(JSON.stringify({ ids: [3, 1] }));
    const out = await selectFrameReferences({ sceneText: 'Steve in the alley', candidates: CANDS, max: 6 });
    expect(out).toEqual(['char1', 'art1']);
  });

  it('drops out-of-range and duplicate numbers', async () => {
    mockReply(JSON.stringify({ ids: [1, 1, 9, 0, 2] }));
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(out).toEqual(['art1', 'art2']);
  });

  it('caps the result at max', async () => {
    mockReply(JSON.stringify({ ids: [1, 2, 3] }));
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 2 });
    expect(out).toEqual(['art1', 'art2']);
  });

  it('uses the enhancer model, not the main model', async () => {
    mockReply(JSON.stringify({ ids: [] }));
    await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(messagesCreate.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('returns [] and warns on non-JSON output', async () => {
    mockReply('sorry, not json');
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns [] without calling the SDK when no API key', async () => {
    hasKey = false;
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(out).toEqual([]);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns [] without calling the SDK when candidates empty', async () => {
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: [], max: 6 });
    expect(out).toEqual([]);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns [] without calling the SDK when sceneText is blank', async () => {
    const out = await selectFrameReferences({ sceneText: '   ', candidates: CANDS, max: 6 });
    expect(out).toEqual([]);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frameReferenceSelector.test.js`
Expected: FAIL — cannot resolve `../src/llm/frameReferenceSelector.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/llm/frameReferenceSelector.js`:

```js
// Pick storyboard frame reference images by ranking a numbered catalog with a
// cheap text-only Anthropic call. The catalog mixes library artwork and the
// scene's characters; the model returns the catalog NUMBERS most useful for
// constructing the frame, which we map back to candidate ids. Failures (missing
// key, bad JSON, network) collapse to [] so generation is never blocked.

import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';

const SELECTOR_MODEL = config.anthropic.enhancerModel || 'claude-haiku-4-5-20251001';

const SYSTEM = [
  'You select reference images that help an image model construct a storyboard frame.',
  'You are given a SCENE description and a numbered CATALOG of available images',
  '(library artwork plus characters who may appear).',
  'Return the catalog NUMBERS of the images most useful as visual references —',
  'locations, sets, props, and mood that match the scene, plus characters who appear in it.',
  'Prefer precision over recall. Omit images that are not clearly relevant.',
  'Respond with EXACTLY one line of compact JSON: {"ids": [<numbers>]}.',
  'Use only numbers that appear in the catalog. No markdown, no commentary.',
].join(' ');

function buildCatalogText(candidates) {
  return candidates
    .map((c, i) => {
      const kind = c.kind === 'char' ? 'CHARACTER' : 'ARTWORK';
      const desc = c.description ? ` — ${c.description}` : '';
      return `${i + 1}. [${kind}] ${c.name}${desc}`;
    })
    .join('\n');
}

// Parse {"ids":[...]} into validated, deduped, in-range 1-based indices.
function safeParseIndices(text, count) {
  if (typeof text !== 'string') return null;
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(stripped);
    if (!obj || !Array.isArray(obj.ids)) return null;
    const seen = new Set();
    const out = [];
    for (const raw of obj.ids) {
      const idx = Number(raw);
      if (!Number.isInteger(idx) || idx < 1 || idx > count) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    return out;
  } catch {
    return null;
  }
}

export async function selectFrameReferences({ sceneText, candidates, max = 6 }) {
  if (!config.anthropic?.apiKey) return [];
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const scene = String(sceneText || '').trim();
  if (!scene) return [];

  const userText = [
    `SCENE:\n${scene}`,
    '',
    `CATALOG:\n${buildCatalogText(candidates)}`,
    '',
    `Return at most ${max} item numbers as {"ids": [...]}.`,
  ].join('\n');

  const t0 = Date.now();
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: SELECTOR_MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const indices = safeParseIndices(text, candidates.length);
    if (!indices) {
      logger.warn(`selectFrameReferences: parse failed (${Date.now() - t0}ms)`);
      return [];
    }
    return indices.slice(0, max).map((i) => candidates[i - 1].id);
  } catch (e) {
    logger.warn(`selectFrameReferences: ${e.message} (${Date.now() - t0}ms)`);
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frameReferenceSelector.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/llm/frameReferenceSelector.js tests/frameReferenceSelector.test.js
git commit -m "✨ Add LLM selector for storyboard frame reference images"
```

---

## Task 2: Candidate builder + auto-fill orchestrator

**Files:**
- Create: `src/web/frameReferences.js`
- Test: `tests/frameReferences.test.js`

**Interfaces:**
- Consumes: `listLibraryImages(projectId)` + `imageFileToMeta(file)` from `src/mongo/images.js`; `getCharacter(projectId, name)` from `src/mongo/characters.js`; `stripMarkdown` from `src/util/markdown.js`; `selectFrameReferences` from `src/llm/frameReferenceSelector.js` (Task 1); `setStoryboardFrameReferenceImagesViaGateway({ projectId, storyboardId, frameId, imageIds, mode })` from `src/web/gateway.js`.
- Produces:
  - `AUTO_REFERENCE_MAX = 6` (export), `CATALOG_MAX = 120` (export).
  - `buildFrameReferenceCandidates({ projectId, sb, sceneText }) -> Promise<Array<{id,kind,name,description}>>`.
  - `autoFillFrameReferencesIfEmpty({ projectId, sb, frame, sceneText, autoReferences }) -> Promise<string[]>` — guards on `autoReferences` + empty `frame.reference_ids`, persists picks via gateway (`mode:'replace'`), mutates `frame.reference_ids` in place, returns the ids (or `[]`).

**Context:** `sb.characters_in_scene` is an array of character name strings (may contain markdown). `getCharacter` returns the character doc (with `main_image_id`) or `null`. Library GridFS docs carry `metadata.name` / `metadata.description`; `imageFileToMeta` surfaces them as `name` / `description` (default `''`).

- [ ] **Step 1: Write the failing test**

Create `tests/frameReferences.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
vi.mock('../src/config.js', () => ({ config: { anthropic: { apiKey: 'k' } } }));

const listLibraryImages = vi.fn();
vi.mock('../src/mongo/images.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listLibraryImages,
}));

const getCharacter = vi.fn();
vi.mock('../src/mongo/characters.js', () => ({ getCharacter }));

const selectFrameReferences = vi.fn();
vi.mock('../src/llm/frameReferenceSelector.js', () => ({ selectFrameReferences }));

const setRefs = vi.fn();
vi.mock('../src/web/gateway.js', () => ({
  setStoryboardFrameReferenceImagesViaGateway: setRefs,
}));

const { buildFrameReferenceCandidates, autoFillFrameReferencesIfEmpty, AUTO_REFERENCE_MAX } =
  await import('../src/web/frameReferences.js');

// Minimal GridFS-shaped library doc.
function libDoc(id, name, description) {
  return { _id: id, filename: `${id}.png`, contentType: 'image/png', length: 1, uploadDate: new Date(), metadata: { name, description, owner_type: null } };
}

beforeEach(() => {
  listLibraryImages.mockReset();
  getCharacter.mockReset();
  selectFrameReferences.mockReset();
  setRefs.mockReset();
});

describe('buildFrameReferenceCandidates', () => {
  it('includes captioned artwork + scene-character portraits, drops empties and missing portraits', async () => {
    listLibraryImages.mockResolvedValueOnce([
      libDoc('art1', 'Neon alley', 'rain-slick alley'),
      libDoc('art2', '', ''), // no signal -> dropped
      libDoc('art3', 'Diner', ''),
    ]);
    getCharacter.mockImplementation(async (_pid, name) => {
      if (name === 'Steve') return { _id: 'c1', name: 'Steve', main_image_id: 'p_steve' };
      if (name === 'Mary') return { _id: 'c2', name: 'Mary', main_image_id: null }; // no portrait -> dropped
      return null; // 'Ghost' unknown -> dropped
    });
    const sb = { characters_in_scene: ['**Steve**', 'Ghost', 'Mary'] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, sceneText: 'x' });
    expect(cands).toEqual([
      { id: 'art1', kind: 'art', name: 'Neon alley', description: 'rain-slick alley' },
      { id: 'art3', kind: 'art', name: 'Diner', description: '' },
      { id: 'p_steve', kind: 'char', name: 'Steve', description: '' },
    ]);
  });

  it('trims an oversized catalog to CATALOG_MAX, keeping scene-text matches', async () => {
    const docs = [];
    for (let i = 0; i < 130; i++) docs.push(libDoc(`art${i}`, `Filler ${i}`, 'generic'));
    docs.push(libDoc('match', 'Lighthouse cliff', 'a lighthouse on a rugged cliff'));
    listLibraryImages.mockResolvedValueOnce(docs);
    getCharacter.mockResolvedValue(null);
    const sb = { characters_in_scene: [] };
    const cands = await buildFrameReferenceCandidates({ projectId: 'p', sb, sceneText: 'a lighthouse on a cliff' });
    expect(cands.length).toBe(120);
    expect(cands.some((c) => c.id === 'match')).toBe(true);
  });
});

describe('autoFillFrameReferencesIfEmpty', () => {
  it('does nothing when autoReferences is false', async () => {
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1' }, frame, sceneText: 'x', autoReferences: false });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('skips frames that already have references', async () => {
    const frame = { _id: 'f1', reference_ids: ['existing'] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1' }, frame, sceneText: 'x', autoReferences: true });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
    expect(frame.reference_ids).toEqual(['existing']);
  });

  it('persists picks via the gateway and mutates the frame', async () => {
    listLibraryImages.mockResolvedValueOnce([libDoc('art1', 'Neon alley', 'rain')]);
    getCharacter.mockResolvedValue(null);
    selectFrameReferences.mockResolvedValueOnce(['art1']);
    const frame = { _id: 'f1', reference_ids: [] };
    const sb = { _id: 's1', characters_in_scene: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb, frame, sceneText: 'alley', autoReferences: true });
    expect(out).toEqual(['art1']);
    expect(setRefs).toHaveBeenCalledWith({ projectId: 'p', storyboardId: 's1', frameId: 'f1', imageIds: ['art1'], mode: 'replace' });
    expect(frame.reference_ids).toEqual(['art1']);
    expect(selectFrameReferences.mock.calls[0][0].max).toBe(AUTO_REFERENCE_MAX);
  });

  it('does not persist when there are no candidates', async () => {
    listLibraryImages.mockResolvedValueOnce([]);
    getCharacter.mockResolvedValue(null);
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1', characters_in_scene: [] }, frame, sceneText: 'x', autoReferences: true });
    expect(out).toEqual([]);
    expect(selectFrameReferences).not.toHaveBeenCalled();
    expect(setRefs).not.toHaveBeenCalled();
  });

  it('does not persist when the selector returns nothing', async () => {
    listLibraryImages.mockResolvedValueOnce([libDoc('art1', 'Neon alley', 'rain')]);
    getCharacter.mockResolvedValue(null);
    selectFrameReferences.mockResolvedValueOnce([]);
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1', characters_in_scene: [] }, frame, sceneText: 'x', autoReferences: true });
    expect(out).toEqual([]);
    expect(setRefs).not.toHaveBeenCalled();
    expect(frame.reference_ids).toEqual([]);
  });

  it('swallows gateway errors and returns []', async () => {
    listLibraryImages.mockResolvedValueOnce([libDoc('art1', 'Neon alley', 'rain')]);
    getCharacter.mockResolvedValue(null);
    selectFrameReferences.mockResolvedValueOnce(['art1']);
    setRefs.mockRejectedValueOnce(new Error('gateway down'));
    const frame = { _id: 'f1', reference_ids: [] };
    const out = await autoFillFrameReferencesIfEmpty({ projectId: 'p', sb: { _id: 's1', characters_in_scene: [] }, frame, sceneText: 'x', autoReferences: true });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frameReferences.test.js`
Expected: FAIL — cannot resolve `../src/web/frameReferences.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/web/frameReferences.js`:

```js
// Auto-select reference images for a storyboard frame. Builds a candidate
// catalog from the project's library artwork plus the portraits of the
// characters tagged in the shot, asks the LLM selector to pick the most useful
// ones, and persists them onto the frame via the gateway so they show up in the
// SPA for review. Only fills frames that have no references yet; never throws.

import { config } from '../config.js';
import { logger } from '../log.js';
import { listLibraryImages, imageFileToMeta } from '../mongo/images.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';
import { selectFrameReferences } from '../llm/frameReferenceSelector.js';
import { setStoryboardFrameReferenceImagesViaGateway } from './gateway.js';

export const AUTO_REFERENCE_MAX = 6;
export const CATALOG_MAX = 120;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

// Number of candidate name/description tokens that also appear in the scene.
function overlapScore(candidate, sceneTokens) {
  const tokens = new Set([...tokenize(candidate.name), ...tokenize(candidate.description)]);
  let n = 0;
  for (const t of tokens) if (sceneTokens.has(t)) n += 1;
  return n;
}

export async function buildFrameReferenceCandidates({ projectId, sb, sceneText = '' }) {
  const candidates = [];

  // Library artwork — drop entries with no text signal for the selector.
  let files = [];
  try {
    files = await listLibraryImages(projectId);
  } catch (e) {
    logger.warn(`frameReferences: listLibraryImages failed: ${e.message}`);
  }
  for (const f of files) {
    const m = imageFileToMeta(f);
    const name = (m.name || '').trim();
    const description = (m.description || '').trim();
    if (!name && !description) continue;
    candidates.push({ id: String(m._id), kind: 'art', name, description });
  }

  // Scene characters — include each tagged character's portrait if it has one.
  const names = Array.isArray(sb?.characters_in_scene) ? sb.characters_in_scene : [];
  const seen = new Set();
  for (const raw of names) {
    const nm = stripMarkdown(String(raw || '')).trim();
    const key = nm.toLowerCase();
    if (!nm || seen.has(key)) continue;
    seen.add(key);
    let ch = null;
    try {
      ch = await getCharacter(projectId, nm);
    } catch (e) {
      logger.warn(`frameReferences: getCharacter(${nm}) failed: ${e.message}`);
    }
    if (!ch || !ch.main_image_id) continue;
    candidates.push({ id: String(ch.main_image_id), kind: 'char', name: nm, description: '' });
  }

  // Scaling guard: keep the catalog bounded, preferring scene-text matches.
  if (candidates.length > CATALOG_MAX) {
    const sceneTokens = new Set(tokenize(sceneText));
    logger.info(`frameReferences: catalog ${candidates.length} > ${CATALOG_MAX}, trimming`);
    return candidates
      .map((c, i) => ({ c, i, s: overlapScore(c, sceneTokens) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, CATALOG_MAX)
      .map((x) => x.c);
  }
  return candidates;
}

export async function autoFillFrameReferencesIfEmpty({
  projectId,
  sb,
  frame,
  sceneText,
  autoReferences = true,
}) {
  if (!autoReferences) return [];
  if ((frame?.reference_ids || []).length > 0) return [];
  try {
    const candidates = await buildFrameReferenceCandidates({ projectId, sb, sceneText });
    if (!candidates.length) return [];
    const ids = await selectFrameReferences({ sceneText, candidates, max: AUTO_REFERENCE_MAX });
    if (!ids.length) return [];
    await setStoryboardFrameReferenceImagesViaGateway({
      projectId,
      storyboardId: sb._id,
      frameId: frame._id,
      imageIds: ids,
      mode: 'replace',
    });
    frame.reference_ids = ids; // existing load step in regen picks these up
    return ids;
  } catch (e) {
    logger.warn(`frameReferences: auto-fill failed for frame ${frame?._id}: ${e.message}`);
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frameReferences.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/web/frameReferences.js tests/frameReferences.test.js
git commit -m "✨ Add storyboard frame reference auto-fill orchestrator"
```

---

## Task 3: Wire auto-fill into generation + bulk route

**Files:**
- Modify: `src/web/storyboardGenerate.js` (imports; `regenerateStoryboardFrameInternal` generate branch + signature; `startBulkFrameGenerationJob`/`runBulkFrameGenerationJob` threading)
- Modify: `src/web/entityRoutes.js:5012` (bulk generate-images route)

**Interfaces:**
- Consumes: `autoFillFrameReferencesIfEmpty` from `./frameReferences.js` (Task 2).
- Produces: `startBulkFrameGenerationJob` accepts `autoReferences` (default `true`); the generate path auto-fills empty frames before loading references. Single-frame generation inherits the default (`regenerateStoryboardFrameInternal` defaults `autoReferences = true`), so no single-frame route change is needed.

**Note on testing:** the behavioral logic is fully unit-tested at the `autoFillFrameReferencesIfEmpty` seam in Task 2 (skip-when-set, disable-when-false, no-candidates, selector-empty). This task is thin wiring; verify by running the full suite (no regressions) — the existing `tests/storyboard-*.test.js` exercise the generate path.

- [ ] **Step 1: Add the import**

In `src/web/storyboardGenerate.js`, the gateway import block ends at line 57 (`} from './gateway.js';`). Immediately after the gateway import block (before the `critiquePanel` import on line 58), add:

```js
import { autoFillFrameReferencesIfEmpty } from './frameReferences.js';
```

- [ ] **Step 2: Hook the generate branch**

In `regenerateStoryboardFrameInternal`, find the generate branch tail (currently lines 1735–1736):

```js
    inputImages = await loadFrameReferenceImages(frame);
    dispatchMode = 'generate';
```

Replace with:

```js
    await autoFillFrameReferencesIfEmpty({
      projectId,
      sb,
      frame,
      sceneText: renderPrompt,
      autoReferences,
    });
    inputImages = await loadFrameReferenceImages(frame);
    dispatchMode = 'generate';
```

- [ ] **Step 3: Add `autoReferences` to the internal signature**

In `regenerateStoryboardFrameInternal`'s destructured params (currently ending around lines 1682–1683):

```js
  prompt = null,
  rotateToPrevious = false,
}) {
```

Replace with:

```js
  prompt = null,
  rotateToPrevious = false,
  autoReferences = true,
}) {
```

- [ ] **Step 4: Thread `autoReferences` through the bulk job**

In `startBulkFrameGenerationJob`, change the signature (lines 326–330):

```js
export async function startBulkFrameGenerationJob({
  projectId,
  beatId,
  imageModel = 'nano-banana-pro',
}) {
```

to:

```js
export async function startBulkFrameGenerationJob({
  projectId,
  beatId,
  imageModel = 'nano-banana-pro',
  autoReferences = true,
}) {
```

Then in the same function, the runner dispatch (lines 359–360):

```js
  withBeatLock(beat._id, () =>
    runBulkFrameGenerationJob({ projectId, job, beat, targets, imageModel }),
```

to:

```js
  withBeatLock(beat._id, () =>
    runBulkFrameGenerationJob({ projectId, job, beat, targets, imageModel, autoReferences }),
```

Update `runBulkFrameGenerationJob`'s signature (line 376):

```js
async function runBulkFrameGenerationJob({ projectId, job, beat, targets, imageModel }) {
```

to:

```js
async function runBulkFrameGenerationJob({ projectId, job, beat, targets, imageModel, autoReferences = true }) {
```

And its per-frame call (lines 406–414):

```js
      await regenerateStoryboardFrameInternal({
        projectId,
        sb,
        beat,
        frame,
        imageModel,
        mode: 'generate',
        prompt,
      });
```

to:

```js
      await regenerateStoryboardFrameInternal({
        projectId,
        sb,
        beat,
        frame,
        imageModel,
        mode: 'generate',
        prompt,
        autoReferences,
      });
```

- [ ] **Step 5: Read `auto_references` in the bulk route**

In `src/web/entityRoutes.js`, the bulk route (lines 5018–5034). After the image-model validation block, add the flag and pass it through. Change:

```js
      const imageModel = normalizeImageModel(req.body?.image_model);
      if (!isValidImageModel(imageModel)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
```

to:

```js
      const imageModel = normalizeImageModel(req.body?.image_model);
      if (!isValidImageModel(imageModel)) {
        return res.status(400).json({ error: IMAGE_MODEL_ERROR });
      }
      const autoReferences = req.body?.auto_references !== false; // default on
```

and change:

```js
        const { jobId, planned } = await startBulkFrameGenerationJob({
          projectId: req.projectId,
          beatId: beat._id,
          imageModel,
        });
```

to:

```js
        const { jobId, planned } = await startBulkFrameGenerationJob({
          projectId: req.projectId,
          beatId: beat._id,
          imageModel,
          autoReferences,
        });
```

- [ ] **Step 6: Run the full suite to verify no regressions**

Run: `npm test`
Expected: PASS — all existing tests plus the two new files green.

- [ ] **Step 7: Commit**

```bash
git add src/web/storyboardGenerate.js src/web/entityRoutes.js
git commit -m "🔌 Auto-fill frame references during storyboard generation"
```

---

## Task 4: SPA toggle on "Generate all images"

**Files:**
- Modify: `web/src/widgets/BulkGenerateImagesDialog.jsx`
- Modify: `web/src/routes/StoryboardBeat.jsx` (`generateAllImages`)

**Interfaces:**
- Consumes: the bulk route's new `auto_references` body field (Task 3).
- Produces: dialog `onSubmit({ imageModel, autoReferences })`; `generateAllImages` posts `auto_references`.

- [ ] **Step 1: Add the checkbox to the dialog**

In `web/src/widgets/BulkGenerateImagesDialog.jsx`, add an `autoReferences` state after the `imageModel` state (line 16):

```js
  const [autoReferences, setAutoReferences] = useState(true);
```

Change the submit handler (line 36) from:

```js
            onClick={() => onSubmit({ imageModel })}
```

to:

```js
            onClick={() => onSubmit({ imageModel, autoReferences })}
```

Update the helper copy (lines 53–56) from:

```jsx
        <p className="modal-help" style={{ margin: 0 }}>
          Each frame uses its own configured prompt and references. Frames with no
          saved prompt fall back to an auto-suggested one.
        </p>
```

to:

```jsx
        <p className="modal-help" style={{ margin: 0 }}>
          Each frame uses its own configured prompt and references. Frames with no
          saved prompt fall back to an auto-suggested one.
        </p>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <input
            type="checkbox"
            checked={autoReferences}
            onChange={(e) => setAutoReferences(e.target.checked)}
          />
          <span className="modal-help" style={{ margin: 0 }}>
            Auto-pick reference images for frames that have none, from the library
            artwork and the characters in each scene.
          </span>
        </label>
```

- [ ] **Step 2: Send the flag from the POST**

In `web/src/routes/StoryboardBeat.jsx`, change `generateAllImages` (lines 306–316) from:

```js
  async function generateAllImages({ imageModel }) {
    if (!data?.beat) return;
    setImageGenError(null);
    setImageGenerating(true);
    setShowProgressLog(true);
    setImageJobStatus({ status: 'queued', completed: 0, planned: 0, failed: 0 });
    try {
      const r = await apiPostJson('/storyboards/generate-images', {
        beat_id: data.beat._id,
        image_model: imageModel,
      });
```

to:

```js
  async function generateAllImages({ imageModel, autoReferences = true }) {
    if (!data?.beat) return;
    setImageGenError(null);
    setImageGenerating(true);
    setShowProgressLog(true);
    setImageJobStatus({ status: 'queued', completed: 0, planned: 0, failed: 0 });
    try {
      const r = await apiPostJson('/storyboards/generate-images', {
        beat_id: data.beat._id,
        image_model: imageModel,
        auto_references: autoReferences,
      });
```

(`onGenDialogImagesSubmit` already forwards the full settings object, so no change there.)

- [ ] **Step 3: Build the SPA to verify it compiles**

Run: `npm run build:web`
Expected: build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/widgets/BulkGenerateImagesDialog.jsx web/src/routes/StoryboardBeat.jsx
git commit -m "✨ Add auto-pick references toggle to Generate all images"
```

---

## Self-Review

**Spec coverage:**
- Behavior contract (auto-fill empty frames, reviewable, skip manual) → Task 2 (`autoFillFrameReferencesIfEmpty`) + Task 3 (hook).
- Candidate pool (library + scene characters) → Task 2 (`buildFrameReferenceCandidates`).
- Unified LLM selector, text-only, numbered catalog → Task 1.
- Persistence via gateway (`mode:'replace'`, broadcasts to SPA) → Task 2.
- `AUTO_REFERENCE_MAX = 6`, `CATALOG_MAX` guard → Task 2.
- Toggle default-on, checkbox on "Generate all" → Task 4; route default → Task 3 Step 5.
- Single-frame inherits default → Task 3 (default param; no route change).
- Failure handling (never block) → Task 1 + Task 2 try/catch; tested.
- Tests → Tasks 1 & 2.

**Placeholder scan:** none — every step has concrete code/commands/expected output.

**Type consistency:** `candidates` shape `{id,kind,name,description}` identical across Tasks 1–2; `selectFrameReferences({sceneText,candidates,max})` and `setStoryboardFrameReferenceImagesViaGateway({projectId,storyboardId,frameId,imageIds,mode})` signatures match call sites; `autoReferences` default `true` consistent across route → bulk start → runner → internal.
