# Storyboard acting objectives — design

Date: 2026-07-27

## Problem

The storyboard prompts we generate for video describe *cameras and physics* but not *performance*.
A shot expands into a still (`start_frame_prompt`) and a motion prompt (`video_prompt`), and the
motion prompt is capped at "ONE primary motion" plus "at most ONE hero temporal change", closing
with the mandatory line `"Everything else holds still — no other movement."` The result is
technically clean clips with no acting in them.

Seven things are missing or actively forbidden:

| Objective | Status today |
| --- | --- |
| Camera movements | Present, but `CAMERA_MOTION_RULES` bans nearly every move |
| Blocking | Only as static placement in the still; no blocking over time |
| Type of cut | `transition_in` exists on the skeleton but is free prose |
| Facial changes | Only as generic "head turn, gaze shift" subject motion |
| Listener behavior | Absent |
| Dialogue turns | Forbidden outright; the beat's `dialogs` are never loaded |
| Outfit / state changes | Absent, and mid-clip changes are explicitly blocked |

The constraint blocks encoding these limits (`src/web/storyboardConstraints.js`) were written
against 2024-era image-to-video models. Video generation has advanced past them, and the rules now
suppress more good output than bad.

## Decisions

1. **Dialogue is choreography, never words.** Speech turns describe mouths, jaws, breath and
   turn-taking order. The words themselves never enter a prompt. All generation targets lip-sync
   models driven by real recorded voices, so a synthesized voice would be discarded anyway.
2. **Retire the conservative constraint layer.** `SUBJECT_MOTION_RULES`, `REVEAL_HANDLING` and
   `FRAMING_RULES` are deleted; `CAMERA_MOTION_RULES` and `VIDEO_PROMPT_RULES` are rewritten.
3. **Continuity state and in-clip state change are both in scope.** The still carries the
   character's condition at this point in the story; the video prompt performs any change that
   happens during the clip.
4. **Prose, not new schema.** `buildTextPrompt` (`src/web/storyboardGenerate.js:1589`) sends only
   `video_prompt` to the video model — structured fields are deliberately UI chrome kept out of the
   model prompt. Acting objectives are model-facing, so they live in the existing two prose strings.
   No Mongo, SPA, or critique changes.

## Part 1 — `src/web/storyboardConstraints.js`

### Deleted

- `SUBJECT_MOTION_RULES`
- `REVEAL_HANDLING`
- `FRAMING_RULES`

**Regression risk:** the "do NOT write dialogue, voice-over, or sound effects" rule currently lives
as a bullet *inside* `SUBJECT_MOTION_RULES`. Deleting that block silently deletes the one rule
decision 1 depends on. It is re-homed into the SPEECH TURNS bullet of `PERFORMANCE_RULES`, reframed
from "no dialogue at all" to "mouths move, words never appear." A test guards this.

`FRAMING_RULES`' readable-text/logo warning is still true and is preserved — folded into
`STILL_FRAMING_RULES` as a single bullet. The crowds / entering-frame / occlusion / reflection
bullets go.

### New — `PERFORMANCE_RULES`

Embedded in `SHOT_EXPAND_SYSTEM_PROMPT` under `# Performance`, replacing the
`# Subject motion` section.

> Performance — every shot with a character on screen carries an acting objective. Write these into
> the video_prompt, in this order, including only what the shot actually contains:
>
> - BLOCKING — where each character moves through the frame over the clip: who crosses to whom, who
>   stands, who turns away, who closes distance. Give direction and endpoint. If no one relocates,
>   say the blocking holds and describe the weight shift instead.
> - SPEECH TURNS — exactly who is speaking at each point and in what order: "the woman speaks
>   through the first half, then falls silent as the man answers over her." Describe the mouth and
>   jaw working, the breath, the head punctuating. NEVER write the words themselves, quoted lines,
>   voice-over, or sound effects — real performances are dubbed and lip-synced in post, and a
>   synthesized voice would have to be thrown away.
> - FACIAL BEATS — the expression *change*, never a static expression. Name the start state and the
>   end state: "the flat courtesy drains out of her face into open alarm." Brows, eyes, mouth
>   corners, jaw, a swallow, a blink held a beat too long.
> - LISTENER BEHAVIOR — what every non-speaking character on screen does while the other talks. A
>   listener is never neutral: holds the speaker's eyes, looks away, nods, stiffens, starts to answer
>   and stops. Name one for each listener present. Silence is a performance.
> - STATE CHANGE — any change to dress, held props, or physical condition occurring during the clip:
>   a jacket pulled off and dropped, a tie loosened, a weapon drawn, rain soaking through. Give it a
>   beginning and an end inside the clip.

### New — `CONTINUITY_STATE_RULES`

Embedded in `SHOT_EXPAND_SYSTEM_PROMPT` under `# Continuity state`, governing
`start_frame_prompt`.

> - Reference photos and the scene bible carry the DEFAULT look. Anything the story has changed
>   since must be stated explicitly or the image model reverts to the reference: jacket now off,
>   sleeves rolled, shirt bloodied, hair soaked, the bag she picked up two beats ago now in her hand.
> - This is the SECOND sanctioned exception to "don't re-describe wardrobe" (the first is the
>   subject's sub-location). State only what DIFFERS from the default — not a full costume
>   description.
> - Carry it forward: once a beat has changed a state, every later shot shows the changed state
>   until something changes it again. Check earlier shots in the skeleton before writing each still.
> - When a state change happens DURING a clip, the still opens in the state BEFORE it, the
>   video_prompt performs the change, and the next shot's still opens in the state AFTER.

The final bullet is the seam joining continuity state to in-clip state change.

### Rewritten — `VIDEO_PROMPT_RULES`

- Sentence budget 2–4 → 4–8.
- Ordering becomes: camera → blocking → performance → at most one environmental event.
- The "ONE primary motion" and "at most ONE hero temporal change" caps are removed.
- The mandatory closer `"Everything else holds still — no other movement."` is **inverted into an
  explicit prohibition**, not merely dropped. The model will otherwise keep emitting it from habit,
  and it negates every listener beat by construction.
- The strip-static-description rule is retained verbatim — it is orthogonal to this change and still
  correct (no subject identity, setting, composition, or framing; those live in the still).

### Rewritten — `CAMERA_MOTION_RULES`

The `NEVER` list (pans, tilts, whip pans, dolly-zooms, rolls, orbits, cranes, jibs, drones,
Steadicam, two-stage moves) becomes a preference ordering with no prohibitions, plus a craft note to
name the move and its motivation.

### Trimmed

- `STILL_FRAMING_RULES` — the t=0 non-solid-effect clause is removed (it existed only to pair with
  the deleted solid/non-solid split). Orientation/heading, sub-location, positive anchoring cues and
  frozen-moment posing are all retained. Gains the readable-text bullet rescued from
  `FRAMING_RULES`.
- `OCCUPANT_PLACEHOLDER_RULES` — loses only its final "occupants do NOT move in the video_prompt"
  bullet.
- `CAMERA_COHERENCE_RULES` — **untouched.** One eyeline per shot is a physics constraint, not a
  model limitation.

## Part 2 — wiring

### Dialogue plumbing

`listDialogs({ projectId, beatId })` (`src/mongo/dialogs.js`) returns ordered
`{ character, body, direction }` per line. `direction` is an authored performance note and is the
highest-value input to this feature.

`buildBeatContextBlock` gains an **opt-in `dialogs = []` parameter**. Only the storyboard callers
pass it. This is deliberate: `src/web/beatSheetPlanner.js:137` and `:224` share the helper, and beat
sheet planning is out of scope for this change.

Rendered after the character list:

```
Dialogue in this beat — use it for TURN ORDER, who is on which line, and delivery.
NEVER write these words, or any words, into a prompt; the real performance is dubbed in post.
  1. Sarah: "You said you'd be here."
       direction: quiet, not accusing; she's already decided to leave
```

Threaded through:

- `generateStoryboardForBeat` — loads dialogs, passes to both passes.
- `buildScenePlanUserText` and `buildShotExpandUserText` — accept and forward `dialogs`.
- `src/web/entityRoutes.js:5079` — the SPA prompt-preview endpoint must pass dialogs too, or the
  preview diverges from what actually runs.

### `reverse_in_post`

Removed from **both tool schemas** (`plan_scene` at `storyboardGenerate.js:168`, `expand_shots` at
`:981`) and from both system prompts, so the model stops reasoning about reveals and stops emitting
the flag.

**Retained:** the Mongo field, `sanitize`/`update` handling in `src/mongo/storyboards.js`, the
renderer's `reverseInPost` pass-through, the `PATCH` route in `entityRoutes.js:3104`, and the manual
`↺ REVERSE IN POST` toggle in `web/src/widgets/StoryboardItem.jsx:121`. Reverse-in-post becomes a
deliberate director's choice rather than an automatic model workaround. Existing frames keep working.

### Cut type

`transition_in` stays a free string (an enum would reject existing stored values). The `plan_scene`
schema description gains the vocabulary — hard cut, match cut, smash cut, cutaway, dissolve, J-cut
(sound leads), L-cut (sound lags) — alongside the continuity note it already carries. It stays out
of `buildTextPrompt`: the cut lives between clips, not inside one.

### Tool schema descriptions

- `video_prompt` — rewritten to the 4–8 sentence camera → blocking → performance ordering.
- `start_frame_prompt` — gains the continuity-state carve-out.

## Testing

`tests/storyboardConstraints.test.js` and `tests/storyboardSceneGeneration.test.js` import and
assert on the deleted exports, and on the literal strings `'no other movement'` and `'locked-off'`.
Those assertions are **replaced, not deleted**:

- `PERFORMANCE_RULES` names all five objectives (blocking, speech turns, facial, listener, state
  change).
- The no-words rule survives the `SUBJECT_MOTION_RULES` deletion — explicit regression guard.
- `VIDEO_PROMPT_RULES` no longer contains the stillness closer, and does contain its prohibition.
- `CONTINUITY_STATE_RULES` and `PERFORMANCE_RULES` both reach `SHOT_EXPAND_SYSTEM_PROMPT`.
- `CAMERA_MOTION_RULES` no longer bans panning.
- `buildBeatContextBlock` omits the dialogue block when no dialogs are passed (beat-sheet planner
  path unchanged), and includes it when they are.
- Neither tool schema still declares `reverse_in_post`, while `updateStoryboard` still round-trips
  the field (existing `tests/storyboard-gateway.test.js` coverage stands).

`tests/storyboard-generate.test.js`, `tests/storyboardReExpandAll.test.js` and
`tests/storyboardCritiqueGeneration.test.js` pass `reverse_in_post` through fake planners; these
continue to pass because the field survives on the frame.

## Out of scope

- `src/web/falVideoGenerate.js`, the critique pass, and the Mongo schema are untouched.
- Beat-sheet planning does not receive dialogue context.
- No per-dimension acting fields in the SPA. If independent editing or per-dimension critique
  scoring is wanted later, that is a follow-up that promotes the prose into a structured
  `performance` object.

## Rollback

Every rule change is confined to `src/web/storyboardConstraints.js` plus the two system prompts in
`src/web/storyboardGenerate.js`. Reverting the commit restores the prior behavior; no data migration
is involved.
