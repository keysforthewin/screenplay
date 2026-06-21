# Beat Critique System — Design

**Date:** 2026-06-20
**Status:** Approved, ready for planning
**Scope:** A new **Critique** sub-tab in the Writing tab that generates multi-facet AI critiques of a beat, persists them, and can regenerate the beat body from them — plus a **Normalize** button on the Background sub-tab for pure screenplay-format reformatting.

## Problem

The Writing tab lets you edit a beat's Name and Body (Background sub-tab) but offers no structured feedback on the writing. Authors want:

1. A **focused** critique of the current beat across several craft dimensions.
2. A **story-level** critique of how the beat fits the whole screenplay.
3. A one-click way to **rewrite the beat** using that critique.
4. A one-click way to **normalize** a beat body to standard screenplay format, independent of critique.

Two facets are mandatory per the user: **screenplay-format conformance** and **director's-notes adherence**.

## Prior art / related code (read before implementing)

- `2026-06-08-storyboard-critique-scene-bible-ui-design.md` + `docs/superpowers/plans/2026-06-08-storyboard-critique-panel.md` — an existing *storyboard* critique panel. This is a **different** surface (storyboard images, not beat prose) but may have reusable UI/streaming patterns. Skim it; don't force-fit it.
- `src/web/imageSheetJobs.js` and `src/web/storyboardGenerate.js` — the canonical async-job + parallel-generation patterns this feature mirrors.
- `src/web/beatSheetPlanner.js` — example of a server-side Anthropic call (`getAnthropic()`, `claude-opus-4-8`, streamed `finalMessage()`).
- The storyboard video-job SSE endpoint in `src/web/entityRoutes.js` — the SSE pattern this feature mirrors (`text/event-stream`, session/project via query string).

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Regenerate / Normalize apply behavior | **Direct apply + Undo** (rewrite body in place via gateway; stash previous body for one-click revert) |
| Critique generation mode | **Parallel + stream (SSE)** — facets run concurrently, each card fills in as it completes |
| Persistence | **Latest only** — each run overwrites; no history |
| Optional focused facets | Pacing & momentum, Character voice, Cinematic craft, Dialogue & subtext (all four selected) |

## The facets (7 critiques per run)

A central registry (`src/web/critiqueFacets.js`) is the single source of truth. Each facet:

```js
{ key, label, scope /* 'focused' | 'story' */, required /* bool */, systemPrompt, buildContext(ctx) }
```

**Focused** (scope `'focused'`) — judge the current beat, with prev/next beats as immediate context:

| key | label | required | Checks |
|---|---|---|---|
| `format` | Screenplay format | ✅ | Conformance to `SCREENPLAY_STYLE_GUIDE`: sluglines, present-tense photographable action, sparse camera cues, dialogue cue/parenthetical/line format |
| `direction` | Director's notes | ✅ | Whether the project director's notes (+ the beat's own `dialog_notes`, if set) are actually reflected in this beat |
| `pacing` | Pacing & momentum | | Dead spots, rushed turns, scene length |
| `voice` | Character voice | | Consistency and distinctness of the characters present |
| `cinematic` | Cinematic craft | | Show-don't-tell; photographable action vs. interior prose the camera can't see |
| `dialogue` | Dialogue & subtext | | Anchor-line quality; on-the-nose vs. layered |

**Story-level** (scope `'story'`) — one critique:

| key | label | Checks |
|---|---|---|
| `story_fit` | Story fit | Redundancy, continuity, arc placement; whether the beat earns its position in the whole |

`required: true` facets always run. The other five (four focused + story_fit) always run in v1 too — there is no per-run facet picker in v1 (YAGNI). The `required` flag exists so the registry documents intent and a future picker can respect it.

## Context each critique sees (`buildContext`)

A shared context object is assembled once per run and passed to every facet's `buildContext`:

```js
ctx = {
  beat,              // current beat: { order, name, desc, body, characters, dialog_notes }
  prevBeat,          // immediately previous beat (body included) or null
  nextBeat,          // immediately next beat (body included) or null
  plot,              // { title, synopsis }
  spine,             // ordered [{ order, name, desc }] of ALL beats — the "summary of all beats"
  directorNotes,     // project director's notes text (from getDirectorNotes) — the `direction` facet
                     //   also reads beat.dialog_notes from `beat` above
  characters,        // roster: [{ name, ...voice-relevant fields }]
  styleGuide,        // SCREENPLAY_STYLE_GUIDE
}
```

- **Focused facets** use `beat` + `prevBeat` + `nextBeat`, plus facet-specific extras (`styleGuide` for `format`; `directorNotes` for `direction`; `characters` for `voice`).
- **`story_fit`** uses `plot.synopsis` + `spine` + this beat's full `body` and `order`. This is the cheap "summary of all beats" — it reuses `name`/`desc` already on the plot doc rather than re-summarizing every body.

## Backend architecture

New modules, mirroring `imageSheetJobs.js` / `storyboardGenerate.js`:

- **`src/web/critiqueFacets.js`** — facet registry (above). Exports `FACETS` (ordered array) and helpers (`getFacet(key)`).
- **`src/web/critiqueGenerate.js`** — orchestration:
  - `runCritique({ projectId, beatId, onFacet })` — assembles `ctx`, sets the critique to `pending` with all 7 facet stubs, then runs all facets **in parallel** via `getAnthropic()` on `claude-opus-4-8`. As each facet resolves it (a) persists that facet (`updateCritiqueFacet`), (b) calls `onFacet(facetResult)` for SSE. A single facet failure marks that facet `error` and the run `partial`; all-fail → `error`; all-succeed → `done`. Ends with one `fields_updated` broadcast.
  - An in-memory job registry (`jobs` Map keyed by `job_id`) like `imageSheetJobs.js`, holding status + an event buffer so the SSE endpoint can replay events to a late subscriber.
- **`src/web/beatRewrite.js`** — shared body-rewrite core, used by both endpoints:
  - `normalizeBeatBody(body)` → Opus call with `SCREENPLAY_STYLE_GUIDE` + body, returns reformatted body (format only, no content change).
  - `regenerateBeatBody({ beat, critique })` → Opus call with body + all critique facet text + `SCREENPLAY_STYLE_GUIDE`, returns a rewrite that addresses the critique **and** conforms to format.
  - Both callers stash the old body (`stashPreviousBody`) before writing the new one via `setBeatBodyViaGateway(projectId, beatId, body)` (gateway.js:535) so collaborative editors stay in sync.
- **`src/mongo/critiques.js`** — Mongo helpers (fake-Mongo compatible):
  - `getBeatCritique(projectId, beatId)`
  - `setCritiquePending(projectId, beatId, { model, facets })` — initialize the overwritten object
  - `updateCritiqueFacet(projectId, beatId, facetKey, patch)` — flip one facet pending→done/error
  - `finalizeCritique(projectId, beatId, status)`
  - `stashPreviousBody(projectId, beatId, body)` / `restorePreviousBody(projectId, beatId)` — undo slot
  - All use `arrayFilters` on `plots.beats.$[b]` exactly like `src/mongo/artworks.js`.

### Endpoints (`src/web/entityRoutes.js`, under `/beat`)

All behind the existing `resolveProject()` + `requireSession()` middleware; beat resolved by id-or-order; cross-project id → 404 (existing helper).

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/beat/:id/critique` | Return persisted `beat.critique` (or `null`) |
| `POST` | `/beat/:id/critique` | Start a run; return `{ job_id }` (202). Rejects with 409 if a run for this beat is already active |
| `GET` | `/beat/:id/critique/:jobId/events` | SSE: one `event: facet` per completion, then `event: done` / `event: error`. Session + project via query string (EventSource can't set headers) |
| `POST` | `/beat/:id/regenerate` | Rewrite body from persisted critique; stash previous; return `{ body }`. 409 if no critique exists yet |
| `POST` | `/beat/:id/normalize` | Reformat body; stash previous; return `{ body }` |
| `POST` | `/beat/:id/restore-body` | Restore stashed `previous_body`; no-op (200, `{ restored: false }`) if nothing stashed |

## Data model (latest-only)

On each beat (embedded in `plots.beats[]`), normalized lazily in `src/mongo/plots.js` like other beat arrays:

```js
beat.critique = {
  generated_at,                 // Date
  model,                        // 'claude-opus-4-8'
  status,                       // 'pending' | 'done' | 'partial' | 'error'
  facets: [                     // 7 entries, in registry order
    { key, label, scope, text, status /* 'pending'|'done'|'error' */, error_message }
  ]
} | null

beat.previous_body = "<text>" | null   // single undo slot, shared by Normalize + Regenerate (last write wins)
```

Incremental persistence (each facet flips pending→done as it streams) means a mid-run page refresh shows partial progress. The final `fields_updated` broadcast syncs other open clients.

## Regenerate & Normalize

Both route body writes through the gateway and share the one `previous_body` undo slot:

- **Normalize** (Background tab): `previous_body ← current body`, then `body ← normalizeBeatBody(body)`. Format only.
- **Regenerate** (Critique tab): `previous_body ← current body`, then `body ← regenerateBeatBody({ beat, critique })`. Substance + format. Requires a persisted critique (else 409).
- **Undo**: `restore-body` swaps `previous_body` back into `body` (via gateway) and clears the slot. The button appears in both tabs whenever `previous_body` is set.

Model: `claude-opus-4-8` (same constant pattern as `STORYBOARD_MODEL`) for both, for quality parity with the agent. Configurable later if cost matters.

## SPA

- **`web/src/widgets/CritiqueTab.jsx`** (new):
  - **Run critique** button → `POST /beat/:id/critique`, then open `EventSource` on the events URL (built via `apiSseUrl`-style helper with `project_id` + session in the query). Each `facet` event updates/inserts that facet's card; `done`/`error` ends the stream.
  - Facet cards: label, a scope badge (Focused / Story), the critique text (markdown), per-card `pending` spinner and `error` state.
  - **Regenerate beat** button → `POST /beat/:id/regenerate`; disabled until a critique exists. On success, body updates live through the collaborative editor; show **Undo**.
  - On mount, `GET /beat/:id/critique` to hydrate the last persisted run.
- **`web/src/routes/Beat.jsx`**: add `'critique'` to `TABS` (right after `'background'`), a `tabLabel` case (`'Critique'`), and the `<div className="tab-panel" hidden={activeTab !== 'critique'}>` rendering `<CritiqueTab>`.
- **Background panel** (`Beat.jsx`): add a `.tab-actions` row above the Body field with a **Normalize** button (`POST /beat/:id/normalize`) and, when `previous_body` is set, an **Undo** button (`POST /beat/:id/restore-body`).
- **`web/src/api.js`**: reuse `apiGet` / `apiPostJson` / `authHeaders`; add a small SSE URL helper if one doesn't already cover this shape.

Plain CSS in `web/src/styles.css`; `.primary` buttons, `.tab-actions` wrapper, a `.critique-card` block following existing card styling. New CSS for scope badges and card states.

## Testing (Vitest, fake Mongo)

- **Facet registry**: every facet has `key`/`label`/`scope`/`systemPrompt`/`buildContext`; keys unique; exactly two `required`; `buildContext` returns a non-empty string for a minimal `ctx`.
- **`runCritique`** with a stubbed `getAnthropic`: persists all 7 facets, calls `onFacet` once per facet, marks run `done`; one stubbed facet throwing → that facet `error` + run `partial`; all throwing → `error`.
- **`beatRewrite`**: Normalize and Regenerate both stash `previous_body` before writing; `restorePreviousBody` brings it back and clears the slot; restore with nothing stashed is a safe no-op.
- **Mongo helpers**: `setCritiquePending` / `updateCritiqueFacet` round-trip through fake Mongo with `arrayFilters`; `getBeatCritique` cross-project id → not found.
- **Endpoints**: critique persistence GET/POST; regenerate 409 with no critique; project scoping (cross-project beat id → 404).

## Out of scope (v1, YAGNI)

- Critique history (only latest is kept).
- A per-run facet picker (all 7 always run).
- A `normalize_beat` **agent** tool — but `normalizeBeatBody()` is written standalone so a one-line agent-tool wrapper can be added later for parity.
- Token-level streaming within a facet (card-level streaming only).
