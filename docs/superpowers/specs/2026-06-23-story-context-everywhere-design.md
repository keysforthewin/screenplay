# Story context in every LLM flow — design

**Date:** 2026-06-23
**Status:** Approved (design); pending spec review

## Problem

The three project-level "About page" fields — the plot **synopsis**, the project
**dialogue style** (`plot.dialogue_style`), and the **director's notes** — are the
creative North Star for everything the bot does. But they are inconsistently
present across the various places that assemble context for an LLM call. Most
notably, the **conversational agent** (the system prompt shared by the Discord bot
*and* the web AI chat) sees the director's notes but **not** the synopsis text
(only a "Synopsis on file" status line) and **not** the dialogue style at all.

The user's request: make sure synopsis, dialogue style, and director's notes are
in the conversational agent's context on every request, and sweep the specialized
flows so the same three travel together wherever it makes sense.

## Goal & principle

Every place that assembles story context for a model should see the project's
creative North Star — *what the story is* (synopsis), *how characters talk*
(dialogue style), *the standing rules* (director's notes) — **unless a flow is
deliberately narrow** (e.g. a purely visual brief).

Both the Discord bot and the web AI chat call the same
`runAgent` → `buildSystem` → `buildSystemPrompt`, so fixing the conversational
agent once covers both surfaces. The plot doc is already fetched in `buildSystem`,
so Part A adds **no new DB calls**.

## Current-state audit

| Context path | Function | Synopsis | Dialogue style | Director's notes |
|---|---|:--:|:--:|:--:|
| **Conversational agent** (Discord + web chat) | `buildVolatileText` (`src/agent/systemPrompt.js`) | ❌ status line only | ❌ | ✅ |
| Dialogue flows (generate/critique/regen/direction) | `buildDialogContext` (`src/web/dialogContext.js`) | ✅ | ✅ | ❌ |
| Beat-body writing (`load_writing_context`) | `buildWritingContext` (`src/agent/writingContext.js`) | ✅ | ✅ | ❌ |
| Beat critique | `buildCritiqueContext` + `critiqueFacets` (`src/web/critiqueContext.js`, `critiqueFacets.js`) | ✅ (story_fit facet) | ❌ | ✅ (direction facet) |
| Storyboard pipeline (planner / shot expander / critique) | `buildBeatContextBlock` etc. (`src/web/storyboardGenerate.js`) | ❌ | ❌ | ✅ |
| Scene-bible autofill | `buildSceneBibleContext` (`src/web/sceneBibleAutofill.js`) | ✅ | ❌ *(intentional)* | ✅ |
| Prompt enhancer | `enhancePrompt` (`src/agent/promptEnhance.js`) | ⚠️ referenced, not loaded | ❌ | ❌ |

## Part A — Conversational agent (primary fix)

**File:** `src/agent/systemPrompt.js`, function `buildVolatileText`.

Render the actual **synopsis text** and the **dialogue style** in the volatile
block (director's notes already there). Concretely:

- Add a **Synopsis** sub-block inside `# Current state`, right after the title
  line: `Synopsis:\n<plot.synopsis>` — or `Synopsis:\nNo synopsis yet.` when empty.
- Replace the existing vague `Plot status: Synopsis on file. N beat(s) outlined.`
  line with a pure count: `Plot status: N beat(s) outlined.` (the real synopsis
  now lives in its own block, so the status line no longer needs to encode
  presence).
- Add a sibling **`# Dialogue style`** section (same shape as the existing
  `# Director's Notes` block), placed just before director's notes, with a
  one-line lead ("The project's voice and influences — apply to all dialogue and
  prose you write.") followed by `plot.dialogue_style`. **Omit the whole section
  when the field is empty** (mirrors how the dialogue-style section is omitted in
  `writingContext.js`).

**Markdown:** render raw (not stripped), consistent with how this block already
renders director's notes and beat names/descs.

**Caching:** both fields go in the **volatile** block, never the 1h-cached stable
block. Editing synopsis/dialogue style therefore does not bust the expensive
stable-block cache breakpoint — identical treatment to beats/characters/director's
notes today. The volatile block is re-sent each turn but cached transitively in
the downstream message breakpoint's prefix until one of these fields changes.

## Part B — Close the one-leg gaps in specialized flows

Each specialized flow is missing exactly one leg. Fill the genuine gaps:

1. **Dialogue flows → add director's notes.**
   `src/web/dialogContext.js` `buildDialogContext(projectId, beat)` already loads
   `plot` and has `projectId`. Load `getDirectorNotes(projectId)` and append a
   `# Director's notes` section. Standing rules absolutely govern dialogue. All of
   generate/critique/regenerate/direction inherit this via `buildDialogContext`.

2. **Beat-body writing → add director's notes.**
   `src/agent/writingContext.js` `buildWritingContext(projectId, beat, names)` has
   `projectId`. Add a `# Director's notes` section (the standing rules apply when
   writing a beat body just as much as when generating dialogue). *Note:* the
   agent already carries director's notes in its system prompt, but
   `buildWritingContext` should be self-sufficient and the section keeps the rules
   adjacent to the craft guidance the tool injects.

3. **Storyboard pipeline → add synopsis.**
   `src/web/storyboardGenerate.js`. `buildBeatContextBlock` is the shared renderer
   for both the scene planner and the shot expander. Add a `synopsis` (story)
   parameter to `buildBeatContextBlock`, pass it through
   `buildScenePlanUserText` / `buildShotExpandUserText` and their callers
   (`planScene`, `expandShots`), and load it once per run alongside the existing
   `loadDirectorNotesForPlanner(projectId)` (a sibling `getPlot(projectId)` read in
   `planFramesV2` and the regen path). Director's notes already present; dialogue
   style intentionally skipped (storyboards are visual — see Skips).

4. **Beat critique → add dialogue style, surfaced in the `dialogue` and `voice`
   facets.**
   `src/web/critiqueContext.js` `buildCritiqueContext` builds a `ctx` object whose
   `ctx.plot` currently carries `{ title, synopsis }`. Add `dialogue_style`. Then
   in `src/web/critiqueFacets.js`, render `ctx.plot.dialogue_style` inside the
   `dialogue` facet (a dialogue editor judging anchor lines) and the `voice` facet
   (judging character voice) — their natural home. Leave the other facets'
   per-facet scoping untouched (synopsis stays in `story_fit`, notes in
   `direction`).

### Correction vs. the initially-approved sketch

The initial proposal said "scene-bible autofill → add dialogue style." **Dropped.**
`buildSceneBibleContext` feeds a *deliberately visual-only* brief: the comment at
`sceneBibleAutofill.js:71` states "no previous-beat dialogue / dialogue style," and
the model is prompted as a cinematographer/production designer filling visual
fields (palette, mood, lighting, location, wardrobe). It already carries synopsis +
director's notes. Injecting dialogue style into a look-book is noise, so the scene
bible is **left unchanged**.

## Skips (deliberate non-changes)

- **Dialogue style in the storyboard pipeline** — storyboards are visual; dialogue
  style is about spoken voice. Skipped.
- **Prompt enhancer (`enhancePrompt`)** — a fast, cheap interpretive pre-processor.
  Full story context adds cost for little gain. Left as-is.
- **Scene-bible autofill** — visual-only by design (see Correction above). Left
  unchanged.
- **Critique facets other than `dialogue`/`voice`** — deliberately scoped; their
  per-facet selection is left alone.

## Shared helper

Add `src/util/storyContext.js` with small pure extractors so the new additions
read the three fields consistently (single source for which field, trimming, and
the markdown-strip choice):

- `synopsisText(plot, { strip = true })` → trimmed synopsis string, or `''`.
- `dialogueStyleText(plot, { strip = true })` → trimmed dialogue-style string, or `''`.
- `directorNoteTexts(directorNotes, { strip = true })` → array of note strings, or `[]`.

Callers own their own section headings (formats differ across surfaces: the agent
block renders raw markdown; the web flows strip). The conversational agent (Part A)
passes `{ strip: false }`; the web flows use the default. Existing working
formatters (`storyboardGenerate.formatDirectorNotes`,
`storyboardCritique.formatDirectorNotesForCritique`, and the inline notes renderer
in `systemPrompt.js`) are **not** refactored onto this helper — out of scope.

## Testing

- **`storyContext.js`** — unit tests: extraction, `strip` option, and empty-input
  handling for all three helpers.
- **`buildVolatileText`** — asserts the volatile block contains the synopsis text
  and a `# Dialogue style` section when those fields are set; shows
  `No synopsis yet.` and omits the dialogue-style section when empty.
- **`buildDialogContext`** — output includes a director's-notes section when notes
  exist; absent/empty when none.
- **`buildWritingContext`** — includes director's notes when present.
- **Storyboard** — `buildBeatContextBlock` / `buildScenePlanUserText` include the
  synopsis when one is passed.
- **Beat critique** — the `dialogue` (and `voice`) facet prompt includes the
  dialogue-style text when set.

## Out of scope / non-goals

- No config flag or toggle — this context is always on.
- No new backup/restore, migration, or schema changes (fields already exist).
- No refactor of the existing director's-notes formatters.
- No change to the prompt enhancer or the scene bible.
