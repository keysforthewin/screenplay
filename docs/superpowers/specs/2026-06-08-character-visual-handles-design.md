# Character visual handles in storyboard prompts (drop proper names)

**Date:** 2026-06-08
**Status:** Approved — implementing

## Problem

Storyboard `start_frame_prompt`s refer to characters by their screenplay proper name
("Young Keys"). Image models can't resolve a made-up name, so they drop or merge the
figure or misplace it (the boy meant to be alone in the back seat rendered up front next
to "Mom" — an archetype the model *can* resolve). Generic role names (Mom/Dad) work
precisely because they're archetypes.

There is **no single "description" field** to lean on. The live character template is
`name, hollywood_actor, background_story, origin_story, arc, events, memes,
alternate_names, name_changes, faction`. Appearance actually lives in two places:

- **`hollywood_actor`** — populated for most characters (Tom Green, Jake Gyllenhaal,
  David Morrissey…). A real actor name is the single strongest handle for an image model.
- **Prose in `background_story` / `memes`** — e.g. Tuna is "a fish in a black-and-yellow
  Mass Effect space suit, sealed helmet, glowing teal visor." For voice-only/non-human
  characters (Tuna's actor is voice-only) the actor gives no face, so the look must come
  from this prose.

## Goal

In image prompts, refer to each character by a concise **visual handle** derived from
their real data — the actor's likeness for on-screen roles, the described look for
voice-only/non-human ones — and **never** the proper name. Reference photos still lock
exact likeness; placement comes from the beat blocking.

## Design

Two changes, both in `src/web/storyboardGenerate.js`. No new fields, no scene-bible
change, no SPA change — uses the character data that's already linked to each shot.

### 1. Enrich the character context block

`formatCharacterLines` (consumed by `buildBeatContextBlock`, which feeds **both** Pass 1
and Pass 2 and the prompt-preview endpoint) currently emits only `- {name}` (the
`role`/`description` lookup hits nothing on this template). Change it to emit, per
character, the appearance-bearing fields, markdown-stripped and length-clipped to keep
the prompt lean:

```
- {name} — played by {hollywood_actor}
  look: {background_story clipped}
  memes: {memes clipped}
  faction: {faction clipped}
```

- Pull `hollywood_actor` (core, top-level `c.hollywood_actor`), `background_story`,
  `memes`, `faction` (custom, `c.fields.*`). Skip any that are empty.
- Clip each field to ~300 chars (whitespace-collapsed, `…` suffix when truncated) via a
  small local `clip()` helper. The name stays as the mapping key for `characters_in_scene`.

### 2. Pass-2 naming rule

In `SHOT_EXPAND_SYSTEM_PROMPT`, replace the current "Character faces… Do not describe
them" bullet with a rule that:

- Forbids the proper name in `start_frame_prompt` ("image models can't resolve a made-up
  name — they drop or merge the figure").
- Says to use a concise visual handle: the actor's likeness when the character is played
  on-screen by a real actor (e.g. *"the pilot, played by Jake Gyllenhaal"*), the
  described physical look for voice-only / non-human characters (e.g. *"the fish in the
  black-and-yellow armored suit"*).
- Keeps "reference photos lock exact likeness — keep the handle short, don't re-describe
  faces in detail," and preserves the placeholder-occupants exception added earlier.

Pass 2 writes the whole shot list in one call, so handles stay consistent across shots
without any persisted cast structure.

## Out of scope

- No dedicated scene-bible `cast` field; no new character template fields.
- `voice_notes` excluded (it's about how a character sounds, useless for a still).
- The `docker-compose.yml` `27017:27107` host-port typo is a separate, optional fix.

## Testing

- `buildBeatContextBlock` includes a character's `hollywood_actor` / `background_story` /
  `memes` / `faction`, and clips long values.
- `SHOT_EXPAND_SYSTEM_PROMPT` contains the "never use the proper name / use a visual
  handle" rule.
- Full `npm test` green.
- Real validation: regenerate the back-seat frame and confirm the boy renders as a
  distinct child alone in the back, parents up front.

## Risks

- **Prompt size:** truncation bounds it; only appearance-relevant fields are pulled.
- **Mapping handle→figure:** the actor + described look gives the model enough to place
  the right figure; characters with neither actor nor visual prose fall back to
  role/relationship inferred from the beat — still better than a bare name.
- **Markdown:** all pulled fields are markdown; `stripMarkdown` is applied (already
  imported).
