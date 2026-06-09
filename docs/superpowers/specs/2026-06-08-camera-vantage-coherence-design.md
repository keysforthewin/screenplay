# Camera-vantage coherence for storyboard shots

**Date:** 2026-06-08
**Status:** Approved — implementing

## Problem

A generated `start_frame_prompt` merged two incompatible camera vantages into one
frame: *"Interior wide from the rear cargo area looking forward up the length of the
cabin"* (camera behind everyone, seeing backs of heads) **and** the boy's face, frontal
gesture ("both hands raised … in front of his chest"), "body angled toward the window,"
and "moonlit spill on the right side of his face." To satisfy both, the image model
turned the boy around to face the rear camera — "facing the wrong direction."

A from-behind master and a look-at-the-character coverage shot are two different camera
setups. The pipeline has **no rule enforcing that the described details are visible from
the stated camera position.** `STILL_FRAMING_RULES` constrains the *subject's*
orientation/heading and blocking, but nothing ties the *camera's* eyeline to what it can
see (confirmed: no eyeline/vantage/POV language exists anywhere in the prompts).

## Goal

Each shot commits to ONE coherent camera vantage, and the prompt describes only what that
camera can actually see. A character's emotional/action beat gets its own shot angled to
see them, rather than being bolted onto a master pointed the other way.

## Design

One new shared constraint block + two wiring points. No code/schema change.

### 1. New `CAMERA_COHERENCE_RULES` (src/web/storyboardConstraints.js)

```
Camera vantage — ONE coherent eyeline per shot:
- A shot is a single camera position. Plan and describe only what that camera can
  actually see; the vantage and the subjects' visible aspect must agree.
- Looking at the BACK of the subjects ("from behind, forward up the cabin" / "down the
  road") shows backs of heads, shoulders, and the space ahead — NOT faces, expressions,
  or front-of-body gestures.
- To show a character's FACE, expression, or frontal action (hands raised at the chest,
  an eyeline to someone), the camera must FACE them, from the front or the side.
- NEVER merge two vantages in one frame: a from-behind master that also shows a face is
  two separate shots. An establishing/wide reads geography (backs, the road, the room);
  a reaction/close-up/medium faces the character whose beat it is.
- When a character has an emotional or action beat, it gets its OWN shot angled to see
  them — don't bolt it onto a master pointed the other way.
```

### 2. Wiring

- Embed `CAMERA_COHERENCE_RULES` in **`SHOT_EXPAND_SYSTEM_PROMPT`** (Pass 2 — so each
  written still is single-vantage) and **`SCENE_PLAN_SYSTEM_PROMPT`** (Pass 1 — so the
  planner doesn't *create* two-vantage shots). This matches how `CAMERA_MOTION_RULES` /
  `REVEAL_HANDLING` are already shared across both passes.

### Nuance (not a frame-count change)

This is not "split one shot into two extra frames" — the requested frame count is exact.
Each of the N planned shots commits to one coherent vantage, and the planner allocates
coverage so a character beat gets its own angled shot *within* the N budget (the master +
reverse the user described, as two of the planned shots rather than one impossible one).

## Out of scope

- No new shot_type; no schema change. (`over_the_shoulder` already encodes a specific
  vantage and is unaffected.)
- The `reverse_in_post` reveal flow is unchanged — its start frame is still a single
  coherent vantage (the final revealed state).

## Testing

- `CAMERA_COHERENCE_RULES` is a non-empty string naming the eyeline / backs-vs-faces /
  "two separate shots" ideas.
- `SHOT_EXPAND_SYSTEM_PROMPT` **and** `SCENE_PLAN_SYSTEM_PROMPT` embed the block.
- Full `npm test` green.
- Real validation: regenerate the cabin frame — the boy faces forward with everyone else,
  or his beat becomes its own reverse/closer shot.

## Risks

- **Rule interaction:** verify the new block doesn't contradict `over_the_shoulder`,
  `REVEAL_HANDLING`/`reverse_in_post`, or the placeholder-occupants rule (occupants seen
  through glass from outside is still one coherent vantage — consistent).
- **Efficacy:** prompt rules are probabilistic; the real test is regeneration. The rule is
  phrased with the concrete failure mode (from-behind + face) to maximize adherence.
