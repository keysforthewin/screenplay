# Storyboard generation redesign — scene bible + holistic shot expansion

**Date:** 2026-06-07
**Status:** Design approved, pending spec review

## Goal

Produce more cohesive, compelling cinematic storyboards from a beat, and replace
the current unwieldy two-stage prompt pipeline with a cleaner abstraction.

Each shot is defined by two things only:

1. `start_frame_prompt` — the opening still composition
2. `video_prompt` — what happens (subject action referencing the start frame) +
   camera movement

**End-frame generation is removed entirely.** We commit to single-image-to-video
models (Kling i2v, Sora i2v, Veo i2v) and drop first-last-frame models (e.g. Veo
3.1 first-last). The video model infers the ending from `video_prompt`.

## Problem with the current design

`src/web/storyboardGenerate.js` runs a two-stage Anthropic pipeline:

- **Outline pass** (`OUTLINE_SYSTEM_PROMPT`, ~134 lines) → ordered shot skeleton.
- **Refine pass** (`REFINE_SYSTEM_PROMPT`, ~118 lines) → called once per frame,
  sequentially, each producing three outputs (`start_frame_prompt`,
  `video_prompt`, `end_frame_prompt`).

Two structural limits on cohesion:

1. **No shared scene bible.** Each shot re-derives location, lighting, palette,
   blocking from the beat text + reference images. Nothing forces all shots to
   inherit one unified look, so the look drifts and every prompt has to
   re-establish context — which is also why the prompts are huge.
2. **Sequential, myopic refine.** Frame N sees only frames 1…N−1. It can match
   the previous shot but cannot plan the arc (frame 3 doesn't know frame 8
   exists). Local continuity, no global composition.

The three-output-per-frame structure (with end frames) is also the messiest part:
"every person in start must be in end," and the reverse-in-post temporal
inversion has to be applied across three outputs.

## Chosen approach — two-pass, scene-plan then holistic expand (Approach B)

```
Pass 1  Scene Plan   ── 1 Claude call ──▶  scene_bible  +  shot skeleton[]
Pass 2  Shot Expand  ── 1 Claude call ──▶  all shots: {start_frame_prompt, video_prompt}
Pass 3  Render       ── per shot ───────▶  start frame image → image-to-video
```

Pass 2 expands **all** shots in a single call (holistic), inheriting the bible —
not frame-by-frame. The bible is persisted before Pass 2 runs, so it survives to
feed future single-shot regens and a "re-expand" action.

The scene = a **beat**. One scene bible per beat.

## Components

### Scene bible

A compact structured artifact stored on the beat, rendered to a prompt block for
the passes. Fields:

- `location` — where, concretely
- `time_of_day` / `lighting_key` — e.g. "dusk, warm low-angle practical + cool fill"
- `palette` — 3–5 anchor colors / overall grade
- `mood` — tonal one-liner
- `blocking` — character geography: who is where in the space and their spatial
  relationships ("Sarah at the table screen-left, door screen-right behind her")
- `continuity_anchors` — props, wardrobe states, weather that must stay constant
- `camera_language` — the scene's default grammar (e.g. "mostly locked-off,
  occasional slow push")
- `updated_at`

Every shot prompt inherits this, so per-shot prompts stay short (~1–2 sentences)
and the look stays unified. Editable in the SPA. Editing does **not** auto-regen;
it exposes a "re-expand shots from bible" action that reruns Pass 2.

### Prompts & centralized constraints

`src/web/storyboardConstraints.js` — new module, single source of truth for the
AI-video failure-mode rules, exported as named constants:

- `CAMERA_MOTION_RULES` — locked-off preferred; allowed slow push/pull/truck;
  never yaw/pitch/whip/crane/drone/two-stage.
- `SUBJECT_MOTION_RULES` — single-vector ambient motion; no new people/props
  mid-clip; no two-character contact; no precise hand action; no warping geometry
  (wheels/gears/clock hands); no dialogue/SFX.
- `REVEAL_HANDLING` — reveal-detection signal phrases + reverse-in-post rule.
- `FRAMING_RULES` — subject centered/unoccluded, simple separable background, no
  readable text/mirrors/reflections/crowds.

Both system prompts reference these constants instead of duplicating them.

- **`SCENE_PLAN_SYSTEM_PROMPT`** (Pass 1) — direction-focused: derive the bible,
  design coverage/rhythm/shot list to hit target count, mark `reverse_in_post`.
  References constraints only where planning-relevant (reveal detection).
- **`SHOT_EXPAND_SYSTEM_PROMPT`** (Pass 2) — prompt-writing-focused: for each
  shot in the skeleton, emit `start_frame_prompt` + `video_prompt` given the bible
  + full skeleton. Instructed **not to re-describe the bible** (location, lighting,
  palette, blocking) — reference it — so prompts stay short.

**Reverse-in-post simplifies to two outputs:** when `reverse_in_post: true`,
`start_frame_prompt` = the revealed end state, `video_prompt` = the
pull-back/generation-direction motion. Post reverses the clip. No three-way
inversion.

### Data model changes

- `plots.beats[].scene_bible` — new structured sub-doc (fields above). `null` on
  legacy beats (means "not generated yet"); the existing `getPlot` backfill path
  is untouched.
- `storyboards` collection: `end_frame_prompt` is no longer produced or used.
  `frames[]` seeds only start-frame still prompt(s); `video_prompt` stays stored
  as `text_prompt`. `reverse_in_post`, `shot_type`, `duration_seconds`,
  `characters_in_scene` all stay.
- Generation job object gains a `scene_bible` snapshot for traceability.

No destructive migration: existing rows keep their `end_frame_prompt` data
harmlessly; the new flow stops producing/using it.

### Regeneration & re-expansion

- **Single-shot regen** (`regenerateStoryboardFrame`) loads the beat's
  `scene_bible` and feeds it into a one-shot version of Pass 2, so the regenerated
  shot matches the rest of the scene.
- **Re-expand from bible** — new endpoint/action: rerun Pass 2 for all shots of a
  beat against the (possibly edited) bible, without rerunning Pass 1.
- **Full regenerate** — reruns Pass 1 + 2 (overwrites the bible).

### SPA editing surface

- `GET/PUT /api/beats/:beatId/scene-bible` — read/update the structured bible.
- **Scene Bible panel** in the storyboard view: edit the structured fields, a
  "Re-expand shots" button (wired to the re-expand endpoint), and a last
  generated/edited snapshot. Scoped to the existing storyboard modal/page — no new
  route.

## Out of scope (kept as-is)

- Per-beat **target shot count** clamps (`DEFAULT/MIN/MAX_TARGET_COUNT`).
- `shot_type` enum + `duration_seconds` caps machinery.
- Image-model dispatch (`storyboardImageDispatch.js`) and the frame reference-image
  seeding.

## Testing

Using the in-memory fake Mongo pattern and the existing test-injection hooks
(`_setOutlinePlannerForTests` / `_setFrameRefinerForTests` analogs):

- Pass 1 produces a valid `scene_bible` + skeleton at the requested target count.
- Pass 2 produces exactly two fields per shot and never an end frame.
- reverse-in-post inverts correctly across the two outputs.
- Bible persists on the beat; legacy beats read back `null`.
- Re-expand reruns Pass 2 only (Pass 1 not invoked); single-shot regen inherits
  the stored bible.
- The constraint module is imported by both prompts (guard against duplication
  regression).
