# Storyboard Acting Objectives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the generated storyboard video prompts carry acting objectives — blocking, speech turns, facial beats, listener behavior, and in-clip state changes — by retiring the 2024-era motion-constraint layer and feeding the beat's dialogue into the planner.

**Architecture:** The storyboard pipeline is two Anthropic calls in `src/web/storyboardGenerate.js`. Pass 1 (`plan_scene`) writes a scene bible plus a shot skeleton; Pass 2 (`expand_shots`) writes each shot's `start_frame_prompt` (still) and `video_prompt` (motion). Both system prompts are assembled from shared text blocks exported by `src/web/storyboardConstraints.js`. Only `video_prompt` reaches the video model (`buildTextPrompt`, `storyboardGenerate.js:1589`), so all acting guidance is prose inside those two strings — no Mongo, SPA, or critique changes. This plan rewrites the constraint blocks, rewires the two system prompts, updates the two tool schemas, and threads the `dialogs` collection into the planner context.

**Tech Stack:** Node ESM, Vitest, MongoDB (in-memory fake for tests), Anthropic SDK.

## Global Constraints

- **Never write dialogue words into any prompt.** Speech is choreography only (mouth, jaw, breath, turn order). Real voices are dubbed and lip-synced in post. This rule currently lives inside `SUBJECT_MOTION_RULES`, which Task 3 deletes — it must survive in `PERFORMANCE_RULES`.
- Run the full suite with `npm test`; a single file with `npx vitest run tests/<file>`; a single test with `npx vitest run -t "<name>"`.
- Every constraint export is a `[...].join('\n')` string array in `src/web/storyboardConstraints.js`. Keep that shape.
- `reverse_in_post` is removed from the LLM tool schemas ONLY. The Mongo field, the `PATCH` route, and the manual SPA toggle stay.
- `transition_in` stays a free-form string. Do not convert it to a JSON enum — existing stored values would be rejected.
- Commit after every task. No `Co-Authored-By` or attribution trailers (repo policy).
- Spec: `docs/superpowers/specs/2026-07-27-storyboard-acting-objectives-design.md`

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/web/storyboardConstraints.js` | Modify | Single source of truth for the shared prompt rule blocks. Gains `PERFORMANCE_RULES` + `CONTINUITY_STATE_RULES`; loses `SUBJECT_MOTION_RULES`, `REVEAL_HANDLING`, `FRAMING_RULES`. |
| `src/web/storyboardGenerate.js` | Modify | Both system prompts, both tool schemas, and the dialogue plumbing. |
| `src/web/entityRoutes.js` | Modify (`~5072`) | Preview endpoint passes dialogs so the preview matches the real run. |
| `tests/storyboardConstraints.test.js` | Modify | Asserts on the rule-block text. |
| `tests/storyboardSceneGeneration.test.js` | Modify | Asserts the blocks reach the two system prompts. |
| `tests/storyboardDialogueContext.test.js` | Create | Covers the dialogue block in `buildBeatContextBlock`. |
| `tests/storyboard-preview-prompt.test.js` | Modify | Covers dialogue reaching the preview endpoint. |

---

### Task 1: Add the two new rule blocks

Adds `PERFORMANCE_RULES` and `CONTINUITY_STATE_RULES` to the constraints module. Nothing consumes them yet — Task 3 wires them into the system prompt. Splitting it this way keeps the module importable at every commit.

**Files:**
- Modify: `src/web/storyboardConstraints.js` (append after `OCCUPANT_PLACEHOLDER_RULES`, before `CAMERA_COHERENCE_RULES`)
- Test: `tests/storyboardConstraints.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const PERFORMANCE_RULES: string`, `export const CONTINUITY_STATE_RULES: string`.

- [ ] **Step 1: Write the failing tests**

Add to the import list at the top of `tests/storyboardConstraints.test.js`:

```js
  PERFORMANCE_RULES,
  CONTINUITY_STATE_RULES,
```

Add these tests inside the existing `describe('storyboard constraints', ...)` block:

```js
  it('performance rules name all five acting objectives', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('blocking');
    expect(t).toContain('speech turns');
    expect(t).toContain('facial beats');
    expect(t).toContain('listener behavior');
    expect(t).toContain('state change');
  });

  it('performance rules forbid writing the words themselves (survives the SUBJECT_MOTION_RULES deletion)', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('never write the words');
    expect(t).toContain('voice-over');
    expect(t).toContain('sound effects');
    expect(t).toContain('lip-synced in post');
  });

  it('performance rules demand an expression change, not a static expression', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('start state');
    expect(t).toContain('end state');
  });

  it('performance rules require a beat for every non-speaking listener', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('never neutral');
    expect(t).toContain('each listener');
  });

  it('continuity-state rules make wardrobe drift explicit and carry it forward', () => {
    const t = CONTINUITY_STATE_RULES.toLowerCase();
    expect(t).toContain('default look');
    expect(t).toContain('reverts to the reference');
    expect(t).toContain('carry it forward');
    expect(t).toContain('differs from the default');
  });

  it('continuity-state rules join the still to the in-clip state change', () => {
    const t = CONTINUITY_STATE_RULES.toLowerCase();
    expect(t).toContain('state before it');
    expect(t).toContain('video_prompt performs the change');
    expect(t).toContain('state after');
  });
```

Also extend the `'every block is a non-empty string'` array with `PERFORMANCE_RULES,` and `CONTINUITY_STATE_RULES,`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/storyboardConstraints.test.js`
Expected: FAIL — `PERFORMANCE_RULES` and `CONTINUITY_STATE_RULES` are `undefined`, so `.toLowerCase()` throws `TypeError: Cannot read properties of undefined`.

- [ ] **Step 3: Add the two blocks**

Append to `src/web/storyboardConstraints.js`:

```js
// The acting layer. Every shot with a character on screen carries a performance
// objective, not just a camera move. Replaces the old SUBJECT_MOTION_RULES,
// which capped a clip at one motion and banned dialogue outright — and which
// is where the "no words in a prompt" rule used to live. That rule survives
// here, narrowed: mouths move, words never appear, because the real voices are
// recorded and lip-synced in post.
export const PERFORMANCE_RULES = [
  'Performance — every shot with a character on screen carries an acting objective. Write these into the video_prompt, in this order, including only what the shot actually contains:',
  '- BLOCKING — where each character moves through the frame over the clip: who crosses to whom, who stands, who turns away, who closes distance. Give direction and endpoint. If no one relocates, say the blocking holds and describe the weight shift instead.',
  '- SPEECH TURNS — exactly who is speaking at each point and in what order: "the woman speaks through the first half, then falls silent as the man answers over her." Describe the mouth and jaw working, the breath, the head punctuating. NEVER write the words themselves, quoted lines, voice-over, or sound effects — real performances are dubbed and lip-synced in post, and a synthesized voice would have to be thrown away.',
  '- FACIAL BEATS — the expression CHANGE, never a static expression. Name the start state and the end state: "the flat courtesy drains out of her face into open alarm." Brows, eyes, mouth corners, jaw, a swallow, a blink held a beat too long.',
  '- LISTENER BEHAVIOR — what every non-speaking character on screen does while the other talks. A listener is never neutral: holds the speaker\'s eyes, looks away, nods, stiffens, starts to answer and stops. Name one for each listener present. Silence is a performance.',
  '- STATE CHANGE — any change to dress, held props, or physical condition occurring during the clip: a jacket pulled off and dropped, a tie loosened, a weapon drawn, rain soaking through. Give it a beginning and an end inside the clip.',
].join('\n');

// The still's half of the state story: the character's condition AT THIS POINT
// IN THE STORY. Reference photos pin the DEFAULT look, so anything the story
// has since changed must be said out loud or the image model silently reverts.
// The last bullet is the seam where this meets PERFORMANCE_RULES' STATE CHANGE.
export const CONTINUITY_STATE_RULES = [
  "Continuity state — the character's condition at THIS point in the story, written into the start_frame_prompt:",
  '- Reference photos and the scene bible carry the DEFAULT look. Anything the story has changed since must be stated explicitly or the image model reverts to the reference: jacket now off, sleeves rolled, shirt bloodied, hair soaked, the bag she picked up two beats ago now in her hand.',
  '- This is the SECOND sanctioned exception to "do not re-describe wardrobe" (the first is the subject\'s sub-location). State only what DIFFERS from the default — not a full costume description.',
  '- Carry it forward: once a beat has changed a state, every later shot shows the changed state until something changes it again. Check the earlier shots in the skeleton before writing each still.',
  "- When a state change happens DURING a clip, the still opens in the state BEFORE it, the video_prompt performs the change, and the next shot's still opens in the state AFTER.",
].join('\n');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/storyboardConstraints.test.js`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardConstraints.js tests/storyboardConstraints.test.js
git commit -m "✨ Storyboard prompts: add performance + continuity-state rule blocks"
```

---

### Task 2: Rewrite the surviving blocks

`VIDEO_PROMPT_RULES` and `CAMERA_MOTION_RULES` are rewritten; `STILL_FRAMING_RULES` and `OCCUPANT_PLACEHOLDER_RULES` are trimmed. The three deletions happen in Task 3 — these blocks are still consumed by both system prompts throughout this task, so the module stays importable.

**Files:**
- Modify: `src/web/storyboardConstraints.js`
- Test: `tests/storyboardConstraints.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: same four exported names, new contents.

- [ ] **Step 1: Update the failing tests**

In `tests/storyboardConstraints.test.js`, **replace** these three existing tests:

```js
  it('camera rules name the locked-off default and forbid yaw/pan', () => {
  it('video-prompt rules put the camera first and end on a stillness constraint', () => {
  it('video-prompt hero temporal change may be a non-solid effect absent from the start frame', () => {
```

with:

```js
  it('camera rules offer a preference ordering, not a ban list', () => {
    const t = CAMERA_MOTION_RULES.toLowerCase();
    expect(t).toContain('locked-off');
    expect(t).toContain('pan');
    // The NEVER list is gone — pans and cranes are available again.
    expect(t).not.toContain('never (these break the model)');
    expect(t).toContain('motivation');
  });

  it('video-prompt rules put the camera first and then demand performance', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    expect(t).toContain('locked-off');
    expect(t).toContain('blocking');
    expect(t).toContain('performance');
  });

  it('video-prompt rules ban the stillness closer that killed listener beats', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    // Present only as a prohibition, never as a template to emit.
    expect(t).toContain('do not write');
    expect(t).toContain('everything else holds still');
    expect(t).not.toContain('verbatim: "everything else holds still');
  });

  it('video-prompt rules no longer cap the clip at one motion', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    expect(t).not.toContain('one primary motion');
    expect(t).not.toContain('at most one hero temporal change');
  });

  it('video-prompt rules still strip static description into the still', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    expect(t).toContain('strip all static description');
    expect(t).toContain('start_frame_prompt');
  });
```

**Replace** the t=0 test:

```js
  it('still-framing rules withhold mid-clip non-solid effects from the still (shooting-star fix)', () => {
```

with:

```js
  it('still-framing rules drop the t=0 non-solid-effect withholding clause', () => {
    const t = STILL_FRAMING_RULES.toLowerCase();
    expect(t).not.toContain('shooting star');
    expect(t).not.toContain('non-solid');
  });

  it('still-framing rules keep the readable-text warning rescued from FRAMING_RULES', () => {
    const t = STILL_FRAMING_RULES.toLowerCase();
    expect(t).toContain('gibberish');
  });
```

Add:

```js
  it('occupant placeholders may now move', () => {
    const t = OCCUPANT_PLACEHOLDER_RULES.toLowerCase();
    expect(t).not.toContain('do not move');
  });
```

Leave the `'still-framing rules treat the start frame as the initial state at t=0'` test alone — the "initial state" / "first frame" bullet is retained.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/storyboardConstraints.test.js`
Expected: FAIL on the new assertions — e.g. `expected '…' to contain 'motivation'`, and `expected '…' not to contain 'shooting star'`.

- [ ] **Step 3: Rewrite the four blocks**

Replace `CAMERA_MOTION_RULES` entirely:

```js
export const CAMERA_MOTION_RULES = [
  'Camera motion — pick the move the shot needs and name it explicitly. This is a preference ordering, not a ban list: every move below is available, and the earlier ones are the most reliable.',
  '- Locked-off / tripod static. The camera does not move, only the subject does. Still the best choice when the performance is the event.',
  '- Subtle handheld breath — micro-shake or small drift while the camera stays essentially in place.',
  '- Slow push-in toward the subject, or slow pull-out, along the subject axis.',
  '- Lateral truck or dolly, following or crossing the subject.',
  '- Pan or tilt to hold or find a subject.',
  '- Crane, jib, drone, Steadicam, orbit, or a compound two-stage move.',
  'Craft notes:',
  '- Name ONE primary move per shot and give its MOTIVATION — what the move is following or revealing. An unmotivated move reads as drift.',
  '- The bigger the move, the more peripheral space the model must invent. Give a big move a simple, continuous destination space.',
].join('\n');
```

Replace `VIDEO_PROMPT_RULES` entirely:

```js
export const VIDEO_PROMPT_RULES = [
  'Video-prompt structure — describe what happens over the clip; the start frame already holds the scene. 4-8 sentences, in this order:',
  '1. CAMERA FIRST, explicitly, as the opening words. For a held shot write "Static, locked-off camera." verbatim — never bury the camera mid-sentence. For a moving shot, name the move and its motivation as the first clause.',
  '2. BLOCKING — how the bodies move through the frame, with direction and endpoint.',
  '3. PERFORMANCE — the speech turns, the facial beats, the listener behavior, and any state change, per the performance rules. This is the SUBSTANCE of the shot. Do not skip it because the shot looks simple: a shot of two people talking is a shot about two performances, not about a camera.',
  '4. At most ONE environmental event — weather turning, a light source changing, a passing vehicle. Keep it in service of the performance, never competing with it.',
  'Strip ALL static description from the video_prompt: no subject identity (make / model / color / year / name), no setting or location, no composition or framing. Those live in the start_frame_prompt only — the video_prompt assumes the frame is already correct.',
  'Do NOT write a stillness closer. The line "Everything else holds still — no other movement." and any variant of it are FORBIDDEN: they freeze every listener, every reaction, and every background life cue, and a scene where exactly one thing moves reads as dead.',
].join('\n');
```

In `STILL_FRAMING_RULES`, **delete** the entire second bullet (the one beginning ``` `- The still is the clip's FIRST frame — the INITIAL STATE at t=0. Render only what is present at that instant.` ``` and running through `only effects that newly occur mid-clip are withheld.`) and **replace** it with:

```js
  `- The still is the clip's FIRST frame — the INITIAL STATE at t=0. Render the moment the clip opens on, then let the video_prompt carry everything that happens afterward.`,
```

Then append one bullet to the end of the same array (rescued from the deleted `FRAMING_RULES`):

```js
  '- Readable text or logos the audience is meant to read (signs, screens, books, plates) warp to gibberish — keep them out of frame or out of focus.',
```

In `OCCUPANT_PLACEHOLDER_RULES`, delete the final bullet:

```js
  '- Still-frame detail only — occupants do NOT move in the video_prompt; figures seen through glass warp if animated.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/storyboardConstraints.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/storyboardConstraints.js tests/storyboardConstraints.test.js
git commit -m "♻️ Storyboard prompts: rewrite camera + video-prompt rules for performance"
```

---

### Task 3: Delete the retired blocks and rewire both system prompts

The module-breaking task: three exports disappear and both system prompts are re-sectioned in the same commit.

**Files:**
- Modify: `src/web/storyboardConstraints.js` (delete 3 exports)
- Modify: `src/web/storyboardGenerate.js:71-80` (imports), `:196-206` (`SCENE_PLAN_SYSTEM_PROMPT`), `:1033-1056` (`SHOT_EXPAND_SYSTEM_PROMPT`)
- Test: `tests/storyboardConstraints.test.js`, `tests/storyboardSceneGeneration.test.js`

**Interfaces:**
- Consumes: `PERFORMANCE_RULES`, `CONTINUITY_STATE_RULES` (Task 1); the rewritten blocks (Task 2).
- Produces: `SCENE_PLAN_SYSTEM_PROMPT` and `SHOT_EXPAND_SYSTEM_PROMPT` with no reveal/subject-motion/framing sections.

- [ ] **Step 1: Update the failing tests**

In `tests/storyboardConstraints.test.js`: remove `SUBJECT_MOTION_RULES`, `REVEAL_HANDLING`, `FRAMING_RULES` from the import list and from the `'every block is a non-empty string'` array. Delete these three now-obsolete tests entirely:

```js
  it('reveal handling names reverse_in_post', () => { … });
  it('subject-motion rules scope the "already in the start frame" ban to solids and exempt non-solid effects', () => { … });
```

(there are only two such tests; `FRAMING_RULES` has no dedicated test). Then add:

```js
  it('the retired blocks are gone from the module', async () => {
    const mod = await import('../src/web/storyboardConstraints.js');
    expect(mod.SUBJECT_MOTION_RULES).toBeUndefined();
    expect(mod.REVEAL_HANDLING).toBeUndefined();
    expect(mod.FRAMING_RULES).toBeUndefined();
  });
```

In `tests/storyboardSceneGeneration.test.js`: remove `REVEAL_HANDLING` and `SUBJECT_MOTION_RULES` from the import list, add `PERFORMANCE_RULES` and `CONTINUITY_STATE_RULES`. Replace the two prompt-embedding tests:

```js
  it('the scene-plan prompt embeds the shared constraint blocks (no duplication)', () => {
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain(CAMERA_MOTION_RULES);
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain(CAMERA_COHERENCE_RULES);
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain(PERFORMANCE_RULES);
  });

  it('the scene-plan prompt no longer teaches reveal inversion', () => {
    expect(SCENE_PLAN_SYSTEM_PROMPT).not.toContain('reverse_in_post');
  });

  it('exports SHOT_EXPAND_SYSTEM_PROMPT embedding performance + continuity + still-framing + video-prompt rules', () => {
    expect(typeof SHOT_EXPAND_SYSTEM_PROMPT).toBe('string');
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(PERFORMANCE_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(CONTINUITY_STATE_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(STILL_FRAMING_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(VIDEO_PROMPT_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(CAMERA_COHERENCE_RULES);
  });

  it('the shot-expand prompt no longer teaches reveal inversion', () => {
    expect(SHOT_EXPAND_SYSTEM_PROMPT).not.toContain('reverse_in_post');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/storyboardConstraints.test.js tests/storyboardSceneGeneration.test.js`
Expected: FAIL — the prompts still contain `reverse_in_post` and do not contain `PERFORMANCE_RULES`.

- [ ] **Step 3: Delete the blocks and rewire the prompts**

In `src/web/storyboardConstraints.js`, delete the `SUBJECT_MOTION_RULES`, `REVEAL_HANDLING`, and `FRAMING_RULES` exports entirely (including their leading comments).

In `src/web/storyboardGenerate.js`, change the import at `:71-80` to:

```js
import {
  CAMERA_MOTION_RULES,
  STILL_FRAMING_RULES,
  VIDEO_PROMPT_RULES,
  OCCUPANT_PLACEHOLDER_RULES,
  CAMERA_COHERENCE_RULES,
  PERFORMANCE_RULES,
  CONTINUITY_STATE_RULES,
} from './storyboardConstraints.js';
```

In `SCENE_PLAN_SYSTEM_PROMPT`, delete these two lines:

```js
  '# Reveals',
  REVEAL_HANDLING,
```

and replace them with:

```js
  '# Performance to plan around',
  PERFORMANCE_RULES,
```

Then, in the same prompt's `# Coverage and rhythm` section, append one line after the `transition_in` line:

```js
  '- Plan for performance: give dialogue exchanges enough coverage that both the speaker and the listener get their own shots. A reaction shot is not filler — it is where the scene lands.',
```

In `SHOT_EXPAND_SYSTEM_PROMPT`, replace:

```js
  '# Subject motion (for video_prompt)',
  SUBJECT_MOTION_RULES,
```

with:

```js
  '# Performance (for video_prompt)',
  PERFORMANCE_RULES,
```

Replace:

```js
  '# What the model cannot draw',
  FRAMING_RULES,
  '',
  '# Reveals',
  REVEAL_HANDLING,
  'For a reverse_in_post shot, the start_frame_prompt is the FINAL revealed state and the video_prompt is the pull-back / generation-direction move; the clip is reversed in post.',
  '',
```

with:

```js
  '# Continuity state (for start_frame_prompt)',
  CONTINUITY_STATE_RULES,
  '',
```

Finally, update the `# Two outputs per shot (NO end frame)` numbered items in the same prompt:

```js
  '1. start_frame_prompt — the opening still the image-to-video model conditions on. Capture the subject as a frozen moment of the action: its pose, orientation, heading, and where it sits in the geography the beat requires, in the continuity state the story has left them in. ~2–3 sentences. This is the ONLY place the subject/scene appearance is described.',
  '2. video_prompt — what HAPPENS over the clip: the camera first, then the blocking, then the performance, assuming the start frame already exists. 4–8 sentences. Strip every static/scene detail; never re-describe the start composition.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/storyboardConstraints.test.js tests/storyboardSceneGeneration.test.js`
Expected: PASS.

- [ ] **Step 5: Run the whole suite to catch other importers**

Run: `npm test`
Expected: PASS. If anything else imported a deleted block, it surfaces here as a module-resolution failure.

- [ ] **Step 6: Commit**

```bash
git add src/web/storyboardConstraints.js src/web/storyboardGenerate.js tests/storyboardConstraints.test.js tests/storyboardSceneGeneration.test.js
git commit -m "🔥 Storyboard prompts: retire subject-motion, reveal, and framing constraint blocks"
```

---

### Task 4: Update both tool schemas

Schema descriptions are what the model reads at the point of writing each field, so they must mirror the system prompt. Also drops `reverse_in_post` from both schemas and adds the cut vocabulary.

**Files:**
- Modify: `src/web/storyboardGenerate.js:162` (`transition_in`), `:168` (`plan_scene` `reverse_in_post`), `:971-985` (`expand_shots` fields)
- Test: `tests/storyboardSceneGeneration.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SCENE_PLAN_TOOL` and `SHOT_EXPAND_TOOL` (module-private) with no `reverse_in_post` property. `cleanPlannedFrameV2` and `reExpandShotInner` keep reading `reverse_in_post` off the skeleton frame, which now always comes from the stored value rather than the model.

- [ ] **Step 1: Write the failing tests**

Add to `tests/storyboardSceneGeneration.test.js` (the module exports the prompts but not the tools, so assert through the prompts plus a direct source read):

```js
import { readFileSync } from 'node:fs';

describe('tool schemas', () => {
  const src = readFileSync(new URL('../src/web/storyboardGenerate.js', import.meta.url), 'utf8');

  it('neither tool schema declares reverse_in_post any more', () => {
    // The Mongo field, the PATCH route and the SPA toggle survive; only the
    // model-facing schemas drop it.
    expect(src).not.toContain("reverse_in_post: { type: 'boolean'");
    expect(src).not.toMatch(/reverse_in_post:\s*\{\s*\n\s*type: 'boolean'/);
  });

  it('transition_in names the cut vocabulary', () => {
    expect(src).toContain('J-cut');
    expect(src).toContain('L-cut');
    expect(src).toContain('smash cut');
  });

  it('the video_prompt schema description demands performance', () => {
    expect(src).toContain('listener behavior');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js -t "tool schemas"`
Expected: FAIL — `reverse_in_post: { type: 'boolean'` is still present at `:168`.

- [ ] **Step 3: Edit the schemas**

At `:162`, replace the `transition_in` property with:

```js
            transition_in: {
              type: 'string',
              description:
                'How this shot picks up from the previous one: name the cut type — hard cut, match cut, smash cut, cutaway, dissolve, J-cut (sound leads the picture), L-cut (sound lags into the next shot) — plus a one-line continuity note. Empty for the first shot.',
            },
```

At `:168`, delete the `plan_scene` `reverse_in_post` property line entirely.

At `:981-985`, delete the `expand_shots` `reverse_in_post` property entirely.

At `:971-975`, replace the `start_frame_prompt` description with:

```js
                'Still-image prompt for the opening composition. Capture the subject as a FROZEN MOMENT of the action — pose, orientation, heading, and placement in the required geography — so the still reads as the intended moment (a car squarely in its lane, nose down the street, not slewed across it). ~2–3 sentences. Do NOT restate the scene bible (location/lighting/palette/blocking) or character faces/wardrobe — reference them. TWO EXCEPTIONS, both REQUIRED when they apply: (1) always state the framed subject\'s precise sub-location, e.g. back seat vs front — the image model never sees the bible and will otherwise default to the wrong position; (2) always state any CONTINUITY STATE the story has changed since the reference photos — jacket off, shirt bloodied, hair soaked, a prop now in hand — or the model silently reverts to the reference look.',
```

At `:976-980`, replace the `video_prompt` description with:

```js
                'Clip-gen motion prompt, 4–8 sentences. Camera FIRST (write "Static, locked-off camera." verbatim for held shots, otherwise name the move and its motivation), then the BLOCKING, then the PERFORMANCE: who speaks in what order (mouth and jaw working — NEVER the words themselves), the facial beat as a change from one state to another, the listener behavior for every non-speaking character on screen, and any state change during the clip. NO subject identity, setting, composition, or framing — the start frame already holds those. Never close with a stillness clause.',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/storyboardSceneGeneration.test.js`
Expected: PASS.

- [ ] **Step 5: Verify the surviving `reverse_in_post` paths still work**

Run: `npx vitest run tests/storyboard-gateway.test.js tests/storyboard-generate.test.js`
Expected: PASS — these cover `updateStoryboard` round-tripping the field and the fake-planner override flow. The `reverse_in_post override flow` describe block in `storyboard-generate.test.js` drives a stubbed expander directly, so it is unaffected by the schema change.

- [ ] **Step 6: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboardSceneGeneration.test.js
git commit -m "✨ Storyboard tool schemas: performance in video_prompt, cut vocabulary, drop model-side reverse_in_post"
```

---

### Task 5: Thread the beat's dialogue into both passes

The shot expander cannot write turn order without knowing who speaks in what order. `src/mongo/dialogs.js` already stores `{ character, body, direction }` per line, ordered — and `direction` is an authored performance note. None of it currently reaches storyboarding.

`buildBeatContextBlock` is shared with `src/web/beatSheetPlanner.js:137` and `:224`. The `dialogs` parameter is **opt-in and defaults to `[]`** so the beat-sheet planner is untouched.

**Files:**
- Modify: `src/web/storyboardGenerate.js` — new `formatDialogLines` + `loadDialogsForPlanner`; `buildBeatContextBlock` (`:863`), `buildScenePlanUserText` (`:891`), `buildShotExpandUserText` (`:1083`), `planScene` (`:908`), `expandShots` (`:1125`), `planFramesV2` (`:1438`), `reExpandShotInner` (`:1194`), and the job runner at `:616`
- Test: `tests/storyboardDialogueContext.test.js` (create)

**Interfaces:**
- Consumes: `listDialogs({ projectId, beatId })` from `src/mongo/dialogs.js`, returning `[{ _id, beat_id, order, body, character, direction, audio_file_id }]` sorted by `order`.
- Produces:
  - `export function formatDialogLines(dialogs: object[]): string | null` — null when empty.
  - `export async function loadDialogsForPlanner(projectId: string, beatId): Promise<object[]>` — never throws, returns `[]` on error.
  - `buildBeatContextBlock({ beat, characters, direction, directorNotes, dialogs })` — `dialogs` defaults to `[]`.
  - `buildScenePlanUserText` / `buildShotExpandUserText` both accept and forward `dialogs`.

- [ ] **Step 1: Write the failing test**

Create `tests/storyboardDialogueContext.test.js`:

```js
// The beat's dialogue reaches the storyboard planner as TURN ORDER and
// DELIVERY context — never as words to put in a prompt. Also guards the
// opt-in-ness of the parameter: buildBeatContextBlock is shared with the
// beat-sheet planner, which must not start seeing dialogue.
import { describe, it, expect } from 'vitest';
import {
  formatDialogLines,
  buildBeatContextBlock,
  buildScenePlanUserText,
} from '../src/web/storyboardGenerate.js';

const BEAT = { order: 3, name: 'The Argument', desc: 'They fight.', body: 'INT. KITCHEN — NIGHT', characters: [] };

const DIALOGS = [
  { order: 1, character: 'Sarah', body: "You said you'd be here.", direction: 'quiet, not accusing' },
  { order: 2, character: 'Tom', body: 'I was working.', direction: 'defensive, already turning away' },
];

describe('formatDialogLines', () => {
  it('returns null for an empty or missing list', () => {
    expect(formatDialogLines([])).toBeNull();
    expect(formatDialogLines(undefined)).toBeNull();
  });

  it('numbers the lines and surfaces speaker, words and direction', () => {
    const out = formatDialogLines(DIALOGS);
    expect(out).toContain('1. Sarah:');
    expect(out).toContain("You said you'd be here.");
    expect(out).toContain('direction: quiet, not accusing');
    expect(out).toContain('2. Tom:');
  });

  it('skips lines with no speaker and no body', () => {
    const out = formatDialogLines([...DIALOGS, { order: 3, character: '', body: '', direction: '' }]);
    expect(out.split('\n').filter((l) => /^\s*\d+\./.test(l))).toHaveLength(2);
  });

  it('strips markdown out of the speaker name', () => {
    expect(formatDialogLines([{ order: 1, character: '**Sarah**', body: 'Hi.', direction: '' }])).toContain('1. Sarah:');
  });
});

describe('buildBeatContextBlock dialogue block', () => {
  it('omits the dialogue block entirely when no dialogs are passed (beat-sheet planner path)', () => {
    const out = buildBeatContextBlock({ beat: BEAT, characters: [], direction: '', directorNotes: [] });
    expect(out).not.toContain('Dialogue in this beat');
  });

  it('includes the dialogue block with the no-words warning when dialogs are passed', () => {
    const out = buildBeatContextBlock({ beat: BEAT, characters: [], direction: '', directorNotes: [], dialogs: DIALOGS });
    expect(out).toContain('Dialogue in this beat');
    expect(out).toContain('TURN ORDER');
    expect(out).toContain('NEVER write these words');
    expect(out).toContain('1. Sarah:');
  });
});

describe('buildScenePlanUserText', () => {
  it('forwards dialogs into the Pass 1 user message', () => {
    const out = buildScenePlanUserText({
      beat: BEAT, characters: [], targetCount: 5, direction: '', directorNotes: [], dialogs: DIALOGS,
    });
    expect(out).toContain('Dialogue in this beat');
    expect(out).toContain('2. Tom:');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storyboardDialogueContext.test.js`
Expected: FAIL — `formatDialogLines is not a function`.

- [ ] **Step 3: Add the formatter and loader**

In `src/web/storyboardGenerate.js`, add after `formatDirectorNotes` (around `:844`):

```js
// The beat's spoken lines, for TURN ORDER and DELIVERY only. The words
// themselves must never reach a generated prompt — real voices are recorded
// and lip-synced in post — but the expander cannot choreograph who speaks when
// without seeing the exchange, and `direction` is an authored performance note
// that is otherwise wasted.
export function formatDialogLines(dialogs) {
  if (!Array.isArray(dialogs) || !dialogs.length) return null;
  const items = dialogs
    .map((d) => {
      const speaker = stripMarkdown(typeof d?.character === 'string' ? d.character : '').trim();
      const body = clipField(d?.body, 400);
      if (!speaker && !body) return null;
      const dir = clipField(d?.direction, 300);
      const head = `${speaker || 'UNKNOWN'}: ${body || '(no line)'}`;
      return dir ? `${head}\n       direction: ${dir}` : head;
    })
    .filter(Boolean);
  if (!items.length) return null;
  return items.map((t, i) => `  ${i + 1}. ${t}`).join('\n');
}

// Fetch the beat's dialogue for the planner prompts. Swallows errors (returns
// []) for the same reason loadDirectorNotesForPlanner does — context, not
// load-bearing state.
export async function loadDialogsForPlanner(projectId, beatId) {
  try {
    const { listDialogs } = await import('../mongo/dialogs.js');
    const rows = await listDialogs({ projectId, beatId });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    logger.warn(`storyboard gen: loadDialogsForPlanner failed: ${e?.message || e}`);
    return [];
  }
}
```

- [ ] **Step 4: Add the block to `buildBeatContextBlock`**

Change the signature at `:863` to:

```js
export function buildBeatContextBlock({ beat, characters, direction, directorNotes = [], dialogs = [] }) {
```

and insert, immediately after the `notesBlock` `if` block and before the `cleanDirection` lines:

```js
  const dialogBlock = formatDialogLines(dialogs);
  if (dialogBlock) {
    lines.push('');
    lines.push(
      'Dialogue in this beat — use it for TURN ORDER (who speaks, in what sequence), who is on which line, and how each line is delivered.',
      'NEVER write these words, or any words, into a prompt: the real performance is recorded by actors and lip-synced in post.',
    );
    lines.push(dialogBlock);
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/storyboardDialogueContext.test.js`
Expected: PASS.

- [ ] **Step 6: Thread `dialogs` through every caller**

Each of these is a mechanical parameter addition. Add `dialogs = []` to the destructured options and forward it:

- `buildScenePlanUserText` (`:891`) → pass `dialogs` into `buildBeatContextBlock`.
- `buildShotExpandUserText` (`:1083`) → pass `dialogs` into `buildBeatContextBlock`.
- `planScene` (`:908`) → accept `dialogs = []`, forward to `buildScenePlanUserText`, and forward to `scenePlannerOverride(...)` so test overrides still see the same shape.
- `expandShots` (`:1125`) → accept `dialogs = []`, forward to `buildShotExpandUserText`.
- `planFramesV2` (`:1438`) → accept `dialogs = []`, forward to both `planScene` and `expandShots`.
- The job runner at `:616` — load alongside the director's notes:

```js
  const directorNotes = await loadDirectorNotesForPlanner(projectId);
  const dialogs = await loadDialogsForPlanner(projectId, beat._id);
  const { frames: planned, sceneBible } = await planFramesV2({
    projectId,
    beat,
    characters: characterDocs,
    targetCount: targetCount || DEFAULT_TARGET_COUNT,
    direction: direction || '',
    directorNotes,
    dialogs,
    onProgress: (fields) => recordProgress(job, fields),
  });
```

- `reExpandShotInner` (`:1194`) — same, so single-shot re-expansion keeps the dialogue context:

```js
  const directorNotes = await loadDirectorNotesForPlanner(projectId);
  const dialogs = await loadDialogsForPlanner(projectId, beat._id);
```

and add `dialogs,` to the `expandShots({ … })` call below it.

- [ ] **Step 7: Run the storyboard suite**

Run: `npx vitest run tests/storyboardDialogueContext.test.js tests/storyboardSceneGeneration.test.js tests/storyboard-generate.test.js tests/storyboardReExpandAll.test.js tests/storyboardCritiqueGeneration.test.js`
Expected: PASS. The existing tests pass no `dialogs`, so they exercise the default-`[]` path.

- [ ] **Step 8: Confirm the beat-sheet planner is untouched**

Run: `npx vitest run tests/beatSheetPlanner.test.js`
Expected: PASS, unchanged. `beatSheetPlanner.js` calls `buildBeatContextBlock` without `dialogs`, so its prompts must be byte-identical to before this task.

- [ ] **Step 9: Commit**

```bash
git add src/web/storyboardGenerate.js tests/storyboardDialogueContext.test.js
git commit -m "✨ Storyboard planner: feed the beat's dialogue in as turn order and delivery"
```

---

### Task 6: Pass dialogue to the prompt-preview endpoint

Without this, the SPA's "Prompt Preview" tab shows a Pass-1 user message that differs from the one actually sent.

**Files:**
- Modify: `src/web/entityRoutes.js:5070-5086`
- Test: `tests/storyboard-preview-prompt.test.js`

**Interfaces:**
- Consumes: `loadDialogsForPlanner`, `buildScenePlanUserText` (Task 5).
- Produces: no signature change; the `user` field of the JSON response now contains the dialogue block.

- [ ] **Step 1: Write the failing test**

Add to `tests/storyboard-preview-prompt.test.js`. It needs the dialogs module — add near the other dynamic imports at the top:

```js
const Dialogs = await import('../src/mongo/dialogs.js');
```

Then add the test. Note `Plots.createBeat` takes a **single options object** with `projectId` inside it, and `postJson` (already defined in the file) returns `{ status, json }`:

```js
describe('dialogue in the preview', () => {
  it('includes the beat dialogue block with the no-words warning', async () => {
    const beat = await Plots.createBeat({ projectId,
      name: 'The Argument',
      desc: 'They fight.',
      body: 'INT. KITCHEN — NIGHT',
      characters: [],
    });
    const d1 = await Dialogs.createDialog({
      projectId, beatId: beat._id, order: 1, body: "You said you'd be here.", character: 'Sarah',
    });
    await Dialogs.updateDialog(projectId, d1._id, { direction: 'quiet, not accusing' });

    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
    });
    expect(status).toBe(200);
    expect(json.user).toContain('Dialogue in this beat');
    expect(json.user).toContain('1. Sarah:');
    expect(json.user).toContain('direction: quiet, not accusing');
    expect(json.user).toContain('NEVER write these words');
  });
});
```

`createDialog` does not accept `direction` — it is set via `updateDialog`, which is why the test uses two calls.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/storyboard-preview-prompt.test.js -t "dialogue in the preview"`
Expected: FAIL — `expected '…' to contain 'Dialogue in this beat'`.

- [ ] **Step 3: Wire the endpoint**

In `src/web/entityRoutes.js`, add `loadDialogsForPlanner` to the destructured dynamic import (`~:5072`):

```js
      const {
        findCharactersInBeat,
        buildScenePlanUserText,
        loadDirectorNotesForPlanner,
        loadDialogsForPlanner,
        SCENE_PLAN_SYSTEM_PROMPT,
        SHOT_EXPAND_SYSTEM_PROMPT,
      } = await import('./storyboardGenerate.js');
```

and below it:

```js
      const directorNotes = await loadDirectorNotesForPlanner(req.projectId);
      const dialogs = await loadDialogsForPlanner(req.projectId, beat._id);
      const user = buildScenePlanUserText({
        beat,
        characters,
        targetCount: count,
        direction,
        directorNotes,
        dialogs,
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/storyboard-preview-prompt.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/entityRoutes.js tests/storyboard-preview-prompt.test.js
git commit -m "✨ Prompt preview: include the beat dialogue the planner now sees"
```

---

## Verification

After Task 6, the acceptance check is a real generation against a beat with dialogue — the tests prove the prompts are assembled correctly, not that the model writes good acting.

- [ ] Run `npm test` — full suite green.
- [ ] Start the app (`npm run dev`), open a beat that has at least two dialogue lines and two characters, and open the storyboard generation dialog's **Prompt Preview** tab. Confirm the Pass-1 user message shows the dialogue block, and the Pass-2 system prompt shows the `# Performance` and `# Continuity state` sections and no `# Reveals` section.
- [ ] Generate a storyboard for that beat. Spot-check three shots' `video_prompt`: each should name the camera first, then blocking, then who is speaking and what the listener is doing. None should end with "Everything else holds still."
- [ ] Confirm no generated shot contains quoted dialogue or the characters' actual lines.
- [ ] Confirm the `↺ reverse` toggle still works manually on a shot (it is no longer set by the model).
