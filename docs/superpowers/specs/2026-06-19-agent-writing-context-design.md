# Scoped writing-context loading for the agent

**Date:** 2026-06-19
**Status:** Approved

## Problem

When the chat agent (Discord channel + the same agent embedded in the SPA) composes
story/dialogue into a beat, full character sheets are not in its context — the system
prompt carries only character *names* + casting (`listCharacters` projects just
`name`, `hollywood_actor`, `main_image_id`). Character details are vital for writing;
without them the agent writes voice/personality blind. Today it *can* pull them with
`get_character`, but that's best-effort and unreliable.

The SPA's dedicated dialogue generator (Generate/Regenerate/Critique) already does this
correctly via `buildDialogContext` → `formatCharacterBio`. The *agent* path does not.

## Goal

Guarantee that, before the agent composes or edits a beat **body**, it has loaded the
full sheets for the characters the passage features — scoped to the small subset
(typically 1–5) the agent is actually writing about, **not** every character linked to
the beat (some beats have too many).

## Design

### New tool: `load_writing_context`

**Input:** `{ beat?: identifier (defaults to current beat), characters: string[] }`
The agent names the small subset the passage features.

**Returns** one formatted text block:
- **Beat detail** — name, desc, `dialog_notes`, and the current `body` (full if
  reasonably sized; otherwise a preview + pointer to `outline_beat_body` /
  `read_beat_body`, mirroring `get_beat`'s truncation).
- **Steering** — plot logline (title + synopsis) and project `dialogue_style`.
- **Character sheets** — full bio per named character via the shared
  `formatCharacterBio` (name, `hollywood_actor`, every non-empty custom field).
  Unknown names are reported back, not silently dropped.

**Side effect:** marks that beat `_id` as context-loaded for the current turn.

### Hard gate (in the `edit` handler)

When `collection === 'beat'` and `gatewayField === 'body'`, and that beat `_id` is not
in the current turn's loaded set, return:

> `Tool error (edit): load character & beat context first — call
> load_writing_context({ beat, characters: [the characters this passage features] })
> before composing or editing a beat body.`

Gate applies to **every** body edit (wholesale rewrite and targeted find/replace alike)
— "swap a character's line" is dialogue writing too, and the load also hands the agent
the verbatim current body it needs for find/replace. Once loaded for a beat, all body
edits to that beat in the same turn pass freely (a multi-edit composing session pays the
load cost once).

### Per-turn state

`context.writingContextBeats = new Set()` constructed in `runAgent` (loop.js ~line 449)
alongside the other per-turn context. Resets each turn. `load_writing_context` adds beat
ids; `edit` checks membership.

### Reliability plumbing

- Add `load_writing_context` to `CORE_TOOL_NAMES` so it's always present — a blocked
  `edit` must be immediately recoverable without a `tool_search` round-trip.
- Add an authoritative rule to the system prompt's `# Beats` section.
- Add tool def (`tools.js`) + handler (`handlers.js`) so `tools-schema.test.js` parity
  stays green.

### Refactor

Lift `formatCharacterBio` out of `src/web/dialogContext.js` into a shared
`src/util/characterBio.js`; both `dialogContext.js` and the new agent loader import it
from there (avoids agent code reaching into `web/`).

## Scope / non-goals

- Applies only to the agent's `edit` tool on beat **body** (covers Discord + SPA chat
  agent — both use the shared `runAgent` loop and `edit` handler).
- Untouched: human typing in the Tiptap editor; the SPA Generate/Regenerate/Critique
  buttons (already load bios); character/plot/note edits.

## Testing

- Gate: `edit` on beat body blocked without load; passes after load (same turn);
  other collections/fields never blocked.
- `load_writing_context`: returns named sheets + beat/plot steering; reports unknown
  names; large-body preview path.
- `tools-schema.test.js` parity stays green.
