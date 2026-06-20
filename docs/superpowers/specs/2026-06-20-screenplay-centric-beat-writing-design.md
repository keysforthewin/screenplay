# Screenplay-centric beat writing

**Date:** 2026-06-20
**Status:** Approved, ready for implementation plan

## Problem

The agent writes a beat's `body` in a narrative-novel prose style. The system
prompt's "# Beats" section (`src/agent/systemPrompt.js:118-146`) describes `body`
only as "long-form developing content" — it gives **no guidance on writing
style**, so the model defaults to prose.

This hurts the downstream goal: the storyboard planner
(`src/web/storyboardGenerate.js`, `SCENE_PLAN_SYSTEM_PROMPT`) reads the
markdown-stripped beat body to derive a scene bible (location, time of day,
lighting, palette, mood, blocking, camera language) and a shot list. Narrative
prose buries the photographable details — looks, nods, glances, blocking, who is
where — that an accurate storyboard needs. We want beat bodies written in a
screenplay-centric style: cinematic **action lines** rich in photographable
detail, **sparing camera/shot direction**, and **baseline dialogue**, so the
scene reads properly and images generate accurately.

## Approach

This is a **writing-guidance** feature, not a structural one. No schema change,
no new beat fields. The agent already routes all body writing through
`load_writing_context` → `edit`, and the storyboard planner already reads the
body. We steer *what* the agent writes and help the planner exploit it.

### Decisions (from brainstorming)

- **Format:** pragmatic screenplay, Fountain-flavored. Real screen action with
  optional sluglines, present-tense action lines, sparing shot cues, and
  character cues + parentheticals + dialogue. Loose enough for lore/world-building
  beats that aren't literal scenes.
- **Dialogue:** the beat body carries a few **sparse anchor lines** so the scene
  reads and storyboards correctly. The separate dialogue generator +
  `dialogs` collection remains **canonical** for full dialogue and is
  **unchanged**. Body dialogue is illustrative, not authoritative.
- **Storyboard side:** include a **light nudge** to the scene-planner prompt so it
  reads sluglines/action lines/shot cues structurally.
- **Existing beats:** **forward-only + reformat on request.** New writing follows
  the convention; the agent may reformat an existing prose beat to screenplay
  style when the user asks (no bulk migration, no new tool).

## Components

### 1. Single source-of-truth style guide (new `src/agent/screenplayStyle.js`)

One module owns the convention text so it never drifts between consumers.
Exports:

- `SCREENPLAY_STYLE_GUIDE` — the full, actionable craft guide (~150–250 words).
  Covers:
  - **Scene heading / slug** when the beat is a literal scene:
    `INT./EXT. LOCATION — TIME OF DAY`. Optional; skip for non-scene lore beats.
  - **Present-tense action lines** that are visually concrete and
    *photographable*: looks, nods, glances, gestures, posture, blocking, spatial
    relationships — write what the **camera can see**, not interior monologue.
  - **Sparing shot/camera cues** (`CLOSE ON`, `WIDE`, `PUSH IN`, `ANGLE ON`) —
    only where they matter; do not over-direct every line.
  - **Character cues + parentheticals + baseline dialogue** — a few key/anchor
    lines that establish voice and beat; the full dialogue lives in the separate
    dialogue generator, so keep body dialogue sparse and illustrative.
  - **Loose for non-scene beats** — lore/world-building beats may stay
    descriptive, but should still be present-tense and visual.
  - **Reformat-on-request** — one line stating the agent may convert an existing
    prose beat into this style when the user asks for it.
- `SCREENPLAY_STYLE_SUMMARY` — a 1–2 sentence version for the always-on system
  prompt (keeps per-request tokens lean; the full guide loads on demand).

This module is plain strings, no dependencies — trivially unit-testable.

### 2. `load_writing_context` returns the full guide (`src/agent/writingContext.js`)

`buildWritingContext(projectId, beat, characterNames)` already assembles a block
with the beat, logline, dialogue style, and character bios (the `sections`
array). Append a new section:

```
# Writing in screenplay format
<SCREENPLAY_STYLE_GUIDE>
```

This is the highest-leverage placement — the guide lands in-context exactly when
the agent is about to compose or edit a body, right beside the bios and dialogue
style it already uses. Append it as the final section so it is the freshest
guidance before the `edit` call.

### 3. System prompt nudge (`src/agent/systemPrompt.js`, "# Beats" section)

- Reframe the `body` bullet (line ~122) from "long-form developing content" to
  describe it as **screenplay-format scene content** (action + sparing camera
  direction + baseline dialogue).
- Insert `SCREENPLAY_STYLE_SUMMARY` into the section.
- Leave the `load_writing_context` gate paragraph and all `edit` mechanics
  (targeted edits, wholesale rewrite, append, large-body navigation, error
  handling) **exactly as written**.
- Import `SCREENPLAY_STYLE_SUMMARY` and interpolate it into the template string.

Keeping the detailed guide out of the always-on prompt (it loads via #2) avoids
paying its token cost on every request.

### 4. Storyboard planner nudge (`src/web/storyboardGenerate.js`)

In `SCENE_PLAN_SYSTEM_PROMPT` (the array starting line 169), near the "Derive it
from the beat body, description, characters, and director guidance." line (173),
add one entry: beat bodies are screenplay-formatted — read **sluglines** for
location/time-of-day/lighting, **action lines** for blocking, and **shot cues**
for camera language. Text-only; no logic change.

### 5. Explicitly unchanged (out of scope)

- Beat `name` and `desc` stay plain text.
- The dialogue generator (`src/web/dialogGenerate.js`, `dialogContext.js`), the
  `dialogs` collection, `dialog_notes`, and the `scene_bible` schema are
  untouched. The generator does not read the beat body, so adding anchor
  dialogue to the body creates no conflict or competing source of truth.
- No bulk migration / reformat tool. No new agent tool.

## Data flow

```
agent about to write a beat body
  → load_writing_context({ beat, characters })
      buildWritingContext → beat + logline + dialogue style + character bios
        + NEW "# Writing in screenplay format" (SCREENPLAY_STYLE_GUIDE)
  → edit({collection:'beat', field:'body', ...})  // body written in screenplay style
  → body stored (single markdown string, now screenplay-formatted)

storyboard generation
  → planScene reads screenplay-formatted body
      SCENE_PLAN_SYSTEM_PROMPT (NEW nudge) → sluglines→location/time,
        action lines→blocking, shot cues→camera
  → more accurate scene bible + shots
```

## Error handling

Prompt/text changes introduce no new runtime failure modes. `writingContext.js`
already guards plot/character loads with `.catch(() => null)`; appending a static
string section cannot throw. The storyboard nudge is a constant-array string.

## Testing

- **`tests/screenplay-style.test.js`** (new, small): `SCREENPLAY_STYLE_GUIDE` and
  `SCREENPLAY_STYLE_SUMMARY` export non-empty strings and the guide contains
  anchor substrings proving coverage (a slugline token like `INT.`, "action",
  "photographable" or "camera", and "dialogue").
- **`tests/writing-context.test.js`** (extend): assert `buildWritingContext`
  output now includes the `# Writing in screenplay format` heading and a known
  phrase from `SCREENPLAY_STYLE_GUIDE`, in addition to the existing beat / bios /
  logline / dialogue-style assertions.
- **Storyboard prompt** (new tiny test or extend an existing storyboard test):
  assert `SCENE_PLAN_SYSTEM_PROMPT` joined text contains the screenplay-format
  note (e.g. a "slugline" / "screenplay" token).

Prompt-text assertions are kept to short, stable anchor substrings to avoid
brittleness.

## Files touched

- **Create:** `src/agent/screenplayStyle.js` — `SCREENPLAY_STYLE_GUIDE`,
  `SCREENPLAY_STYLE_SUMMARY`.
- **Modify:** `src/agent/writingContext.js` — append the screenplay-format
  section.
- **Modify:** `src/agent/systemPrompt.js` — reframe the `body` bullet + inject
  `SCREENPLAY_STYLE_SUMMARY` into the "# Beats" section.
- **Modify:** `src/web/storyboardGenerate.js` — add the planner nudge bullet.
- **Tests:** new `tests/screenplay-style.test.js`; extend
  `tests/writing-context.test.js`; storyboard-prompt assertion.
