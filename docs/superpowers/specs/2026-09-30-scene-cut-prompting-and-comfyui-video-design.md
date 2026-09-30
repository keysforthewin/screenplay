# Scene → cut prompting, start frames, and ComfyUI video

- **Date:** 2026-09-30
- **Status:** Proposed (design); pending review, then an implementation plan
- **Area:** Prompts tab (`/p/<title>/prompts/<order>`) — the standalone beat → prompts → video path
- **Source method:** `docs/video-prompting-notes.md` (Emily's seedance-2.0 pipeline, read 2026-09-30)

## Summary

Replace the Prompts tab's single-call generator (`src/web/videoPromptGenerate.js`)
with a staged pipeline that works the way Emily converts prose into video prompts:
the **entire beat** (plus director's notes, dialogue, characters, sets, scene bible,
directorial voice) is assembled once and reused by every LLM step; the beat is broken
into **scenes**; each scene gets a ten-field **director's read** and a **floor plan**;
each scene is planned as a **shot table** of **cuts** (one camera setup each, with full
photography and framing); each cut's table row is compiled into a bare present-tense
**prose block ending in a lock line**; an LLM pass derives a **start-frame prompt**
from each cut; the start frame is rendered from that prompt plus the **artwork of every
character in frame and the set**; and the video for each cut is rendered through the
**ComfyUI MCP server** with a user-chosen model and user-set parameters.

The unit of generation becomes the **cut** (one start frame, one clip). Scenes group
cuts and carry the shared planning state. The existing fal.ai render path stays as a
second provider; ComfyUI is additive.

## What is wrong today

Measured against `src/web/videoPromptGenerate.js` and the notes' §9:

| Today | Consequence |
|---|---|
| The beat body is clipped at `BEAT_TEXT_CAP = 12000` chars; character fields at 300 chars (`clipField`) | Long beats lose their tail; the "whole beat in context" requirement fails silently |
| One LLM call writes 1–N prompts straight from the prose | No director's read, no floor plan, no shot table — the prompt is written from the prose, which is the thing Emily never does |
| Prompts use `[Wide shot, static]` brackets and a per-shot time budget | She writes the cut in words and forbids seconds inside shot blocks |
| No lock line | Her single strongest rendered finding; light and blocking drift across cuts |
| "One to four shots" chosen by feel; 2.5 words/s heuristic | She derives shot count and clip length from a load score |
| `@Image1 is Sarah` | Handles say who, not what they control; no non-transfer clause |
| No lint for trap phrases / bare feeling words | "furious", "his face fell" reach the model |
| No idle business for secondary people, no reverse-angle rule for reactions, no `Sound:` line, no named last frame | The four remaining §9 divergences |
| No scene structure; no rendered start frame per prompt — `@Image1` (an artwork) doubles as the start frame for i2v models | A character portrait is not the first frame of the shot |
| Video renders only through fal | The local GPU (RTX 5070 Ti, ComfyUI already running) is unused |

## Decisions (recommended defaults — each has an alternative noted)

1. **Home: evolve the Prompts tab, leave the Storyboard tab untouched.** The user has
   twice chosen the Prompts tab as the place to iterate; the storyboard pipeline stays as
   is. We *reuse* storyboard library code (reference candidates + scoring, image dispatch,
   beat lock, job/SSE registry, dialogue formatting) as functions, never the
   `storyboards` collection. *Alternative:* rebuild `plan_scene`/`expand_shots` in place.
   Rejected for now: it would change the tab the user chose not to change. If the Prompts
   path wins, the Storyboard tab can be retired later.
2. **Unit of generation = the cut.** Every cut gets its own start frame and its own clip.
   Scene-level multi-shot renders (several cut blocks in one Seedance / LTX-2.5
   generation, numbered `Shot N.`) are a Phase 3 option, not the default.
3. **Two planning calls per scene (shot table, then prose), not one.** Emily's method is
   table → paper render → prose; keeping them separate stops the model writing prose
   first and backfilling the table. Cost is small next to renders.
4. **Whole-beat context is a shared, prompt-cached block.** No body cap; only a safety
   ceiling (60k chars) that *warns* instead of clipping. Every LLM step in the pipeline
   receives the same block, so the "when possible" clause in the requirement means: every
   text step; the image and video models get only their prompt and images.
5. **Dialogue words never enter a prompt** (project rule, unchanged). Emily's dialogue
   rules are adapted: speaker tag + locked framing + delivery/eyes/after-the-line
   direction + "no music during the line"; one speaker on screen per cut; the second voice
   off frame. Lip-sync from recordings is Phase 3 (LTX-2.3 image+audio→video template is
   installed locally).
6. **Negation policy: adopt Emily's two structured negatives.** The project's
   `ANTI_SLOP_RULES` bans all negation. Her rendered takes allow exactly two kinds: a
   reference non-transfer clause right after the binding, and a clip-scope exclusion at
   the end (`Do not show the vehicle departing yet.`), plus the three official ones (no
   subtitles / logo / watermark). The body of a block still states positive states only.
   The lint enforces this shape. *Alternative:* keep the blanket ban and drop the
   exclusion line. Flagged for the user.
7. **ComfyUI transport: spawn `comfy-mcp` over stdio from the bot, using
   `@modelcontextprotocol/sdk`.** comfy-mcp 0.10.0 is stdio-only (`mcp.run(transport="stdio")`),
   so the bot speaks MCP as a client to a child process. This is one new npm dependency and
   a one-time image rebuild (`./deploy.sh --rebuild`), which prod needs anyway to get
   `comfy-mcp` (Python, `uv tool install`) into the image. *Alternative:* call ComfyUI's
   HTTP API (`/prompt`, `/history`, `/upload/image`, `/ws`) directly — zero new deps, but
   not "the MCP server", and we lose the template gallery, `local_check`, slot addressing
   and spend gating. Direct HTTP stays a fallback idea, not the plan.
8. **Model choice = a comfy model registry with per-template parameter maps + an
   Advanced raw-slot editor.** Canonical parameters (prompt, negative prompt, start image,
   duration, width/height, fps, seed, steps, cfg, prompt-enhance, audio, reference images)
   map to each template's slot addresses; everything else the template exposes is
   editable in Advanced via `list_workflow_slots` / `set_workflow_slot`. Per-project
   default model + per-model last-used parameters persist. Template discovery/registration
   from the gallery is Phase 3.
9. **Optional-integration pattern.** No `COMFYUI_URL` / comfy-mcp → the ComfyUI provider
   reports unconfigured (503), fal keeps working, nothing throws at boot.

## Pipeline

All passes run as one background job under `withBeatLock`, with a polled job snapshot
(status, phase, per-scene / per-cut progress, warnings) like the current generator.
Every LLM call uses `modelFor('storyboard')` resolved at call time; every tool schema is
`strict: true` with no numeric `minimum`/`maximum` (bounds enforced in post-processing).

### Pass 0 — Context assembly (`src/web/beatContext.js`, new; pure + loaders)

`buildFullBeatContext({projectId, beat, direction})` returns one text block, reused
verbatim by every pass and marked with `cache_control` so passes 1–4 share the cache:

- Directorial voice (`plots.directorial_voice`) — Emily's project-wide "voice", first.
- Beat `#order: name`, `desc`, and the **whole body** (Fountain-flavoured; no cap). A
  deterministic slugline scan (`^(INT|EXT|INT\/EXT|I\/E)[.\s]`) lists the sluglines found,
  as hints for the scene split.
- Neighbour beats: previous and next beat name + desc (one line each) so the scope
  firewall (`already_happened` / `reserved_for_later`) has something to point at.
- Characters in the beat with **full** fields (cap 2000 chars per field, not 300): actor
  likeness (skipping voice-only/mocap casting via `NON_VISUAL_CASTING`), role, look,
  memes, faction, and any other template field.
- Sets in the beat with full descriptions.
- Scene bible if present (`renderSceneBibleBlock`).
- **All director's notes** (text; `loadDirectorNotesForPlanner`).
- Dialogue, numbered by list position with the audio mark (`formatDialogLines`) — turn
  order and delivery only; the standing never-write-the-words rule is restated.
- Director's commentary (the optional per-run `direction`).

### Pass 1 — Scene breakdown + director's read (`break_beat_into_scenes` tool, one call)

Returns ordered `scenes[]`, each:

- `title`, `slug` (`INT./EXT. LOCATION — TIME`), `set_names[]` (exact beat set names),
  `character_names[]`, `text_span: {starts_with, ends_with}` (verbatim anchors into the
  body so the UI can highlight the span and later passes can quote it).
- **Director's read** — the ten mandatory fields, no blanks, no generic mood words:
  `dramatic_function`, `turn`, `pov`, `power_shift`, `hidden_want`, `obstacle_tactic`,
  `subtext`, `suppressed_behavior`, `non_transferable_detail`, `stock_solution_refused`.
- `intention` — the one sentence ("make the audience feel her certainty crack").
- `scope`: `already_happened[]`, `this_scene_only[]`, `reserved_for_later[]`,
  `do_not_show_yet[]` (the scope firewall).
- **Floor plan** — three or four sentences a stranger could draw from: landmarks, who is
  where at the start and facing what, the light source with its colour, the axis.
- `dialog_lines[]` — the numbered lines that fall inside this scene (contiguous).

A beat with no sluglines and no location/time change is one scene. Post-processing
verifies set/character names against the beat rosters, checks that scene dialog ranges
partition the beat's lines in order, and records repairs as job warnings.

### Pass 2 — Shot table per scene (`plan_cuts` tool, one call per scene)

Input: the context block + this scene's read, intention, scope, floor plan, text span,
and the previous scene's final cut (for the handoff). Output `cuts[]`, one per camera
setup, each a shot-table row with every column filled (a blank column is a fault, per
the notes' defaults table):

- `camera`: `size` (enum: extreme_wide, wide, medium_wide, medium, medium_close_up,
  close_up, extreme_close_up, insert, over_the_shoulder, two_shot), `angle` (eye_level,
  low, high, dutch, top_down), `height` (words: "deck height", "waist height"), `lens_mm`
  (integer: 18/24/35/50/85/135), `side` ("from the counter side of the room, looking down
  the aisle to the door" — relative to a named landmark), `movement` (static, push_in,
  pull_out, pan, tilt, truck, track, handheld, crane) + `motivation`, `depth_of_field`
  (deep, shallow), `lighting` (source + colour, the same words every row).
- `in_frame[]`: `{character, position (relative to a landmark), facing}`.
- `eyeline`: for a reaction, the camera on the side of the thing reacted to.
- `action`: the ONE action; a reaction = plain feeling word + one physical anchor; a
  prop = the hand, the grip, the tilt, where the object ends; a line = speaker + voice +
  eyes (never the words).
- `others`: one line of idle business for everyone else in frame.
- `last_frame`: what the frame holds when the cut ends; visible from the camera cell.
- `sound`: the cue(s) that must land.
- `dialog_lines[]`: numbers covered (contiguous, script order, speaker framed with the
  mouth visible, one speaker on screen per cut).
- `sets_in_scene[]`, `characters_in_scene[]` (derived from `in_frame`), `primary_spend`
  (identity | motion | world), `felt_intent`.
- `crossing: boolean` — a move between landmarks gets its own row.

Scene-level output: `load` = `{beats, load_points, notes}` per the load table (camera
move 0.5, a line 1 per 8 words min 1, extra acting principal 1, held second person 0.5,
contact 1, location change 2, sound-on-action 0.5; reactions and inserts count half).
We recompute it deterministically in `src/web/cutLoad.js` and derive each cut's
`duration_seconds`: recorded audio length wins (`formatDialogAudioMark` /
`dialogs.audio_duration_seconds`), else `ceil(3 × (1 + load_of_this_cut))` clamped to
the model's range at render time. A scene whose `S = Σduration ÷ (beats + load)` falls
below 2.0 is flagged Ambitious with the instruction to split, never reroll.

The system prompt carries: the read → prompt **carrier table** (POV → shot position /
eyeline; power shift → height, frame share, who moves first; hidden want → a task or
prop action; subtext → words against body; suppressed behaviour → one timed gesture;
turn → before/after state and a camera endpoint; non-transferable detail → the exact
object; stock refused → a physical exclusion paired with its replacement), the starting
stacks by scene type, `SHOT_SIZE_FIDELITY_RULES`, `CAMERA_COHERENCE_RULES`,
`DIALOGUE_COVERAGE_RULES` (adapted: one speaker per cut, second voice off frame), and
the "paper render" instruction: read the table back as a crew that never met you; any
"unstated" or "presumably" is a fault to fix before returning.

### Pass 3 — Compile the prose per cut (`write_cut_prompts` tool, one call per scene)

Input: the context block, the scene's read + floor plan, and its full shot table.
Output per cut: `prompt` (the block), `lock_line`, `reference_binding` (see below),
`exclusions[]` (clip-scope `Do not yet…` lines, may be empty).

Block form — bare present-tense prose, no brackets, no timestamps, no JSON, no style
tags, 60–140 words, in the official block order plus her lock line:

1. The cut/camera **in words** with the side of the room: "Medium shot from the aisle,
   at deck height, 50mm:" (size, side, height, lens, one move with its motivation or
   "the camera holds").
2. **One action by one person**, expression as feeling + anchor; props as hand mechanics;
   a covered line as speaker tag + voice + eyes + what the face does after the last word.
3. Position or space change, then idle business for the others ("the waitress keeps
   wiping").
4. `Sound:` for the cut (and "no music during the line" when a line is covered).
5. **Lock line**, same words every cut of the scene: "Same light: one warm tungsten lamp
   overhead. Sarah: thirties, dark hair tied back, grey wool coat, seated in the window
   booth, facing the door. Camera on the counter side."
6. Ending inside the frame: `End with …` / `Stop when …` / `Hold on this frame as …`.
   Never "fade out"; never an involuntary outcome as the endpoint.

`reference_binding` is stored separately and prepended **only** when the chosen video
model takes reference images (r2v): `@Image1 controls Sarah's identity and wardrobe
only; ignore the room and the light from it. @Image2 controls the diner interior only;
ignore any figures in it.` One owner per dimension; 4–5 assets even though the cap is
9; an asset that owns nothing is dropped. For i2v models the start frame carries
identity and the binding is omitted.

The system prompt embeds the eight rules (literal-and-alive, one action + others keep
living, lock line every cut, prop mechanics, the frame holds only what the cut contains,
secondary people alive, direct the delivery, the check before delivery), the emotion
rule (feeling word only as a label on an anchor), the anti-slop classes, the length
rule, and **one worked exemplar**: the notes' diner conversion (§9) with the spoken words
replaced by speaker tags, so the model sees the target shape rather than a description
of it.

### Pass 4 — Start-frame prompt per cut (`derive_start_frames` tool, one call per scene)

Input: the context block, the scene's floor plan, and each cut's table row + prose block.
Output per cut: `start_frame_prompt` and `reference_picks[]`
(`{subject: character|set name, artwork_index}` chosen from each subject's numbered
artwork list — the same catalog `buildReferenceCatalog` builds today, per subject).

The still is the frozen t=0 composition of the cut: the camera vantage named first
(size, angle, height, lens, side), the subject as a frozen moment of the action with
orientation and heading, the exact sub-location with a positive anchoring cue, the
continuity state (`CONTINUITY_STATE_RULES`), the light source and colour, depth of
field, and characters referred to by **visual handle** (actor likeness / described look),
never by name — image models cannot resolve names. `STILL_FRAMING_RULES`,
`CAMERA_COHERENCE_RULES`, `NO_TEXT_RULES`, `OCCUPANT_PLACEHOLDER_RULES` apply.
"Prompt only what the image cannot show": wardrobe and faces come from the references,
so the still prompt spends its words on placement, pose, light and lens.

### Pass 5 — Render start frames (`src/web/cutStartFrames.js`)

For each cut (pool of 2, under the same beat lock, skippable per cut):

- References = the picked artwork of **every character in `in_frame`** + the artwork of
  the cut's set(s). When the model made no pick for a subject, fall back to
  `selectFrameReferencesForShot` (candidates from `buildFrameReferenceCandidates` given a
  cut-shaped `{characters_in_scene, sets_in_scene, beat_id}`, scored by
  `scoreFrameReferences`, per-source floor so each character and the set are always
  represented), capped by the image model's reference limit.
- Image model: project default `image_with_refs`, else `nano-banana-pro`; dispatched
  through `dispatchStoryboardImage({prompt, model, inputImages, mode: 'generate'})`.
- Persist to the GridFS `images` bucket (`owner_type: 'beat'`, `owner_id: beatId`,
  `metadata.generated_by: 'cut-start-frame'`, `metadata.cut_id`); store on the cut as
  `start_frame: {image_id, prompt, reference_ids, reference_scores, model, generated_at,
  previous_image_id}`. Re-render replaces and keeps one undo step (the storyboard
  frame's `previous_image_id` pattern); inline edit mode reuses the storyboard edit path.
- Per-cut failure → job `partial`; a re-run with `skip_rendered` (default) fills gaps.

### Pass 6 — Video per cut via ComfyUI (`src/web/comfyVideoGenerate.js`)

Described in its own section below. Inputs per cut: the start frame (i2v) or the
reference images (r2v), the prose block (+ binding for r2v, + exclusions), and the
user's model + parameters. Output: MP4 persisted through the existing
`setVideoPromptVideoViaGateway` (previous clip deleted), so the inline player and the
fal path keep working unchanged.

### Emily rule → where it lands

| Notes section | Lands in |
|---|---|
| §1 Step 1 director's read (ten fields) + carrier table | Pass 1 tool fields; Pass 2/3 system prompts |
| §1 Step 2 one intention, project voice, starting stacks | `intention` per scene; `directorial_voice` first in context; Pass 2 prompt |
| §1 Step 3 one primary spend | `primary_spend` per cut (kept from the storyboard planner) |
| §1 Step 4 one beat per generation, scope firewall | cut = one visible beat with an endpoint; `scope` buckets per scene |
| §1 Step 5 shape + load score | `cutLoad.js` (pure): S, verdict, per-cut duration |
| §1 Step 6 shot table + floor plan + paper render | Pass 2 tool schema (every column required); floor plan on the scene |
| §1 Step 7 compile order + checks | Pass 3 system prompt; `cutPromptLint.js` |
| §2 block order, lock line, no seconds, ending inside the frame, two negatives | Pass 3 output shape; lint |
| §3 eight rules + trap phrases | Pass 3 system prompt; lint (trap list verbatim) |
| §4 feeling as a label on an anchor | Pass 2 `action`; lint (bare feeling word → warning) |
| §5 dialogue (one speaker per shot, off-frame second voice, stabilisers, delivery) | Pass 2 coverage rules; Pass 3 delivery direction; words never appear |
| §6 references with jobs + non-transfer, one owner per dimension, 4–5 assets | `reference_binding`; render-time prepend for r2v only |
| §7 anti-slop classes, length | Pass 3 prompt; lint (empty evaluators, image-model tokens, adjective stacks) |
| §8 retakes: name the failed criterion, one variable per retry | Phase 3 retake note per cut |

## Data model

### `video_scenes` (new collection, `src/mongo/videoScenes.js`)

```
{ _id, project_id: string(24-hex), beat_id: ObjectId, order: 1..N,
  title, slug, set_names: [string], character_names: [string],
  text_span: { starts_with, ends_with },
  directors_read: { dramatic_function, turn, pov, power_shift, hidden_want,
                    obstacle_tactic, subtext, suppressed_behavior,
                    non_transferable_detail, stock_solution_refused },
  intention: string, scope: { already_happened: [], this_scene_only: [],
                              reserved_for_later: [], do_not_show_yet: [] },
  floor_plan: string (markdown; collab fragment),
  dialog_ids: [ObjectId],
  load: { beats, load_points, total_seconds, s, verdict: 'safe'|'stretch'|'ambitious' },
  created_at, updated_at }
```

Index `(project_id, beat_id)`. Cascaded by beat delete and project delete.

### `video_prompts` rows become cuts (extend `src/mongo/videoPrompts.js`)

Keep the collection name (no migration); add:

```
  scene_id: ObjectId | null,        // null = legacy flat prompt ("Unsorted")
  cut_index: number,                // 1..N within the scene
  camera: { size, angle, height, lens_mm, side, movement, motivation,
            depth_of_field, lighting },
  in_frame: [{ character, position, facing }], eyeline, action, others,
  last_frame, sound, crossing,
  characters_in_scene: [string], sets_in_scene: [string],
  primary_spend, felt_intent,
  dialog_ids: [ObjectId],           // verified against the beat, like storyboards
  lock_line: string, reference_binding: string, exclusions: [string],
  lint: [{ code, message, severity }],
  start_frame: { image_id, prompt (collab fragment), reference_ids,
                 reference_scores, model, generated_at, previous_image_id } | null,
  // existing: title, prompt (collab), duration_seconds, reference_images[] (r2v),
  // video_* (shared with storyboards so StoryboardVideoPanel renders unchanged)
  video_provider: 'fal' | 'comfy', video_comfy: { template, params, prompt_id } | null
```

`order` stays the global order within the beat (scene order × cut index), maintained
on every create/delete/reorder so the fal path and the TOC counts keep working.

### Rooms and gateway

- `video_prompts:<beatId>` keeps `item:<cutId>:title|prompt` and gains
  `item:<cutId>:start_frame_prompt` and `scene:<sceneId>:floor_plan`. Everything else is
  structured and patched via gateway helpers with a `fields_updated` ping
  (`updateCutScalarsViaGateway`, `updateSceneViaGateway`, `setCutStartFrameViaGateway`,
  `createSceneViaGateway`, `deleteSceneViaGateway` (cascades its cuts),
  `deleteAllScenesForBeatViaGateway`). Fallback branches write Mongo directly when
  Hocuspocus is down, like today.
- Legacy rows (`scene_id: null`) render under an "Unsorted" heading and keep every
  existing action; "Auto generate" replaces everything (wipe-and-recreate, existing rows
  preserved when the pipeline returns nothing — the current precedent).

## ComfyUI integration

### What exists (verified 2026-09-30)

- ComfyUI 0.38.0 runs on the Windows host, reached from WSL at `http://127.0.0.1:8188`;
  RTX 5070 Ti, 16 GB VRAM. `comfy-mcp` 0.10.0 (stdio only) wraps comfy-cli 1.22.0;
  `.mcp.json` already points it at that URL.
- Installed local video models (`diffusion_models`): Wan 2.2 i2v/t2v 14B fp8 (high+low),
  LTX-2.5 22B distilled int8, MiniMax H3 (fl2va, ref2va), FastVideo FastH3, HunyuanVideo
  1.5 720p i2v, Wan 2.1 SCAIL; `checkpoints`: LTX-2.3 22B dev fp8.
- Templates that pass `local_check.runnable: true` today: `video_wan2_2_14B_i2v`,
  `video_ltx2_5_i2v` (also present in the gallery: `video_ltx2_3_ia2v` image+audio→video
  lip-sync, `video_minimax_h3_i2v`, `video_fastvideo_fasth3_i2v`). Paid `API`-tagged
  templates: `api_seedance2_0_r2v`, `api_seedance2_5_i2v_1080p`, `api_kling_v3_video`,
  `api_kling_o3_i2v`, `api_minimax_h3_r2v`, `api_wan3_0_i2v`, and more; twelve partner
  aliases for `partner_generate` (`seedance`, `kling-i2v`, `kling-lipsync`, …).
- Slot addresses (from `list_workflow_slots`) — the parameter map is template-specific:

| Canonical param | `video_ltx2_5_i2v` | `video_wan2_2_14B_i2v` |
|---|---|---|
| start image | `395.image` (LoadImage) | `97.image` (LoadImage) |
| prompt | `398.value` | `129.text` |
| negative prompt | `398/373.text` | `129/89.text` |
| duration (s) | `398.value_2` (int, 5) | `129.value_1` (float, 5); frames derived `floor(fps×dur+1)` |
| width / height | `398.value_3` / `398.value_4` (1280×720), or `403.aspect_ratio` + `403.megapixels` | `129.width` / `129.height` (640×640) |
| fps | `398.value_5` (24) | `129/94.fps` (16) |
| seed | `398.noise_seed` | `129.noise_seed` |
| steps / cfg | fixed sigmas (distilled) | `129/86.steps` 4, `129/86.cfg` 1 (Lightning LoRA path; switches `129/116…120` expose the 20-step path) |
| prompt enhancer | `398.value_1` (bool, off) | — |
| output | `75.filename_prefix`, `75.format` | `108.filename_prefix`, `108.format` |

  The LTX prompt enhancer stays **off**: our prompts are already compiled and the
  enhancer would rewrite them.

### Client (`src/comfy/client.js`)

- Spawns `comfy-mcp` (command from `COMFY_MCP_COMMAND`, default `comfy-mcp`; env passes
  `COMFYUI_URL`, `COMFY_BIN`) once per process via `@modelcontextprotocol/sdk`
  `StdioClientTransport`; lazy, restarted on exit, `isConfigured()` = `COMFYUI_URL` set
  and the binary spawnable. `server_info` on first use verifies `server.running`.
- Thin typed wrappers over the tools we use: `serverInfo`, `searchTemplates`,
  `getTemplate`, `fetchTemplate`, `listWorkflowSlots`, `setWorkflowSlot`, `uploadFile`,
  `runWorkflow({wait:false})`, `job({action})`, `fetchOutputs`, `listWorkflowNotes`,
  `listPartnerModels`, `partnerModelSchema`. Test seam `_setComfyClientForTests`.
- Filesystem contract: `upload_file` takes absolute paths and `fetch_outputs` writes to a
  directory **on the machine running comfy-mcp**, so comfy-mcp runs on the bot's host
  (child process) while comfy-cli targets ComfyUI over `COMFYUI_URL`, which may be
  remote (comfy-cli ≥ 1.14 uploads to a remote target). Job files live under
  `config.comfy.workDir` (default `os.tmpdir()/screenplay-comfy/<jobId>/`) and are
  deleted after persistence.

### Registry (`src/comfy/videoModels.js`)

Mirrors `src/fal/videoModels.js`: one entry per template with `id`, `label`, `template`,
`kind: 'local' | 'api'`, `spends_credits`, `inputs` (`startFrame` required/optional/unused,
`referenceImages`, `audio`), `params` (canonical param → `{address, type, default,
min, max, step, enum}`), `derived` (e.g. Wan `length` from fps × duration), `constraints`
(resolution multiples: 32 for LTX, 16 for Wan; duration ranges), and `notes` (from
`list_workflow_notes`, shown as help). Seeded entries: `ltx-2.5-i2v`, `wan-2.2-14b-i2v`,
`minimax-h3-i2v`, `hunyuan-1.5-i2v`, `ltx-2.3-ia2v` (audio, Phase 3), `seedance-2.0-r2v`
(api), `seedance-2.5-i2v-1080p` (api), `kling-3.0` (api). Template JSON is fetched once
into `data/comfy/templates/<name>.json` and re-fetched when `get_template` reports a
newer date. Registration of any gallery template from the SPA (auto-mapping slots by
node type: `LoadImage` → start image, the long-text STRING → prompt, `noise_seed`,
`fps`, `width`/`height`) is Phase 3.

Overrides persist in `app_settings {_id:'comfy_models'}` (admin) — same pattern as the
model slots — so a param map can be corrected without a deploy.

### Job flow (per cut)

1. `POST /api/cut/:id/video/generate {provider:'comfy', model_id, params, advanced:
   [{address, value}], confirm_spend}` → validate against the registry (400 unknown
   model, 400 out-of-range param, 402 `spend_consent_required` for `api` models without
   `confirm_spend`, 409 beat busy, 503 unconfigured) → 202 `{job_id}`.
2. Runner (global ComfyUI queue, concurrency 1 — one GPU): copy the template JSON to the
   job dir → write the start frame PNG (and reference PNGs for r2v) → `upload_file`
   (overwrite, unique names `cut-<id>-<ts>.png`) → `set_workflow_slot` with structured
   overrides (canonical params mapped + advanced passthrough, `stdout:false` onto the job
   copy) → `run_workflow(wait:false, confirm_spend)` → poll `job(status)` every 4 s (up
   to 60 min; local 14B renders can take minutes), `job(error)` on failure → `fetch_outputs`
   → persist the MP4 (`setVideoPromptVideoViaGateway`, `generated_by: 'comfy/<template>'`,
   `video_provider: 'comfy'`, `video_comfy: {template, params, prompt_id}`) → cleanup.
3. Snapshots use the same shape as fal jobs (`serializeJob`) and the same pre-auth SSE
   handler (`/api/cut/:id/video-job/:jobId/events`), so `StoryboardVideoPanel` and the
   progress UI need no fork. Usage is recorded per job (GPU seconds for local; credits
   flagged for api) alongside the existing `token_usage` pattern.
4. `POST …/video/preview` returns the resolved slot overrides and the final prompt (with
   or without the binding) so the user can approve what ships — the fal dialog's
   precedent.

### Prod topology (decision needed)

The prod bot runs in Docker on a remote host; ComfyUI runs on the user's Windows GPU
box. Options: (a) Tailscale/VPN and `COMFYUI_URL=http://<gpu-host>:8188` in prod `.env`,
with `comfy-mcp` added to the bot image (python3 + `uv tool install comfy-mcp`, one
`--rebuild`); (b) run the bot locally on WSL for video sessions (works today with zero
infra). Recommended: build it dev-local first (b), then (a) once it earns it.

## REST surface (all under `/api`, `requireSession` + `requireProjectAccess`)

- `GET /video-scenes?beat_id=` → `{beat, scenes:[{…, cuts:[…]}], unsorted:[…]}`
- `POST /video-scenes/generate {beat_id, direction?, render_start_frames?: bool}` → 202
  `{job_id}` (409 busy); `GET /video-scenes/generate/:jobId` → snapshot with phase
  (`context` | `scenes` | `cuts:<n>/<N>` | `prose` | `start_frame_prompts` |
  `start_frames:<k>/<K>` | `done` | `partial` | `error`), warnings, lint counts.
- `POST /video-scenes/:sceneId/replan` (re-run Passes 2–4 for one scene, keeps others),
  `PATCH /video-scene/:id` (read fields, floor plan scalars, title), `DELETE /video-scene/:id`,
  `POST /video-scenes/reorder`.
- `PATCH /cut/:id` (camera, in_frame, action, others, last_frame, sound, dialog_ids
  (verified against the beat), duration, reference_images, lock_line, exclusions),
  `POST /cuts/reorder {scene_id, ordered_ids}`, `POST /cut` (blank cut in a scene),
  `DELETE /cut/:id`.
- `POST /cut/:id/start-frame/generate {image_model?, prompt?}` → 202 job (regenerate /
  edit modes like storyboard frames), `POST /cuts/start-frames/generate {beat_id,
  skip_rendered}` (bulk), `DELETE /cut/:id/start-frame`.
- `GET /comfy/models` (registry + configured flag + `server_info` freshness),
  `GET /comfy/models/:id/slots` (raw slot list for Advanced), `POST /cut/:id/video/preview`,
  `POST /cut/:id/video/generate`, `GET /cut/:id/video-job/:jobId` (+ pre-auth `/events`),
  `DELETE /cut/:id/video`.
- Existing `/video-prompt*` routes stay as aliases during the transition and are removed
  once the SPA no longer calls them.

## SPA (`web/src/routes/PromptsBeat.jsx` → scenes & cuts)

- Header: **✨ Auto generate** (Passes 1–4; checkbox "also render start frames"),
  **Direction…**, **Render all start frames**, **Render all videos…** (ComfyUI, one model
  + params for the run), **Delete all**. Confirm dialogs as today.
- **Scene card** (collapsible): slug, load badge (Safe / Stretch / Ambitious with S),
  floor plan (collab field), director's read (10-row table, editable), intention, scope
  buckets, "Replan this scene", drag to reorder scenes.
- **Cut row** under its scene (DnD within the scene): number, camera chips
  (`wide · low · 35mm · truck · counter side`), the prose block (collab field), the lock
  line and exclusions (muted, editable), `DialogLineChips`, lint badges with the fix
  hint, **start frame** thumbnail + prompt (collab field) + reference strip (character and
  set artwork with the existing pickers) + Render / Regenerate / Edit / Undo,
  **Generate video** (provider switch: ComfyUI | fal.ai), inline player, discard.
- **ComfyUI video dialog** (`ComfyVideoDialog.jsx`): model picker grouped Local (free) /
  API (spends credits — explicit consent checkbox), canonical parameter form with the
  model's ranges and defaults, **Advanced** disclosure listing the template's raw slots
  with current values, "Preview payload", per-project default model + per-model
  last-used params (`project_settings.comfy_video`), runnable/unconfigured states with the
  `local_check` errors surfaced verbatim.
- `PromptsIndex.jsx` shows per-beat scene / cut / start-frame / video counts.

## Pure modules and lint

- `src/web/cutLoad.js` — load points per cut, scene S and verdict, per-cut duration
  (recorded audio wins). Unit-tested against the notes' worked cases (15 s, two people,
  two six-word lines, one reaction → S = 2.5 Stretch; the diner → S ≈ 2.1).
- `src/web/cutPromptLint.js` — per-cut warnings: trap phrases (the notes' list,
  verbatim), bare feeling words not followed by an anchor clause, brackets or
  `\d+\s*s(ec)?` inside a block, empty evaluators / image-model tokens / stacked
  adjectives, negation outside the two sanctioned positions, missing lock-line
  components (light, each `in_frame` principal, position, facing, camera side), ending
  not inside the frame (no `End with` / `Stop when` / `Hold on`), dialogue words
  detected (any covered line's text appearing verbatim), a reaction cut whose camera
  side is not the reverse. Severity `warn`; nothing blocks generation.
- `src/comfy/paramMap.js` — canonical params → slot overrides, derived values,
  constraint clamping with warnings; unit-tested per registry entry with the fetched
  template JSON as a fixture.

## Tests

- fakeMongo pattern for `videoScenes.js`, the extended `videoPrompts.js`, gateway
  helpers (both Hocuspocus and fallback branches), cascades (beat delete, project delete).
- Pipeline with writer seams (`_setSceneBreakerForTests`, `_setCutPlannerForTests`,
  `_setCutWriterForTests`, `_setStartFrameDeriverForTests`) and the image dispatcher seam:
  scene partitioning of dialog lines, name verification, wipe-and-recreate, empty result
  keeps rows, partial start-frame job + `skip_rendered` re-run, busy guard.
- Context assembly: whole body preserved past 12k chars, sluglines listed, neighbour
  beats, all notes present, cache marker on the shared block.
- Lint and load: table-driven cases from the notes.
- Comfy: client mocked; job runner state machine (upload → set slots → run → poll →
  fetch → persist → cleanup; error and timeout paths); route validation (unknown model,
  out-of-range, spend consent, unconfigured 503); param maps against fixture JSON.
- Route tests for the new endpoints (mock `requireSession` only through
  `src/web/permissions.js`, never adding exports to `src/web/auth.js`).
- One live smoke script (`scripts/comfy-smoke.js`): `server_info`, fetch LTX-2.5,
  render a 3 s clip from a fixture PNG, fetch outputs — run by hand, not in CI.

## Phasing

- **Phase 1 — prompt quality (no new infra).** Pass 0–5, data model, gateway, routes,
  lint, load, SPA scenes/cuts view, start-frame render via the existing image dispatch.
  Video still through fal (unchanged), so the tab is useful the day this lands.
- **Phase 2 — ComfyUI.** MCP client, registry for the installed local templates +
  Seedance / Kling API templates, param maps, job runner + SSE, the ComfyUI dialog,
  per-project defaults. Dev-local topology.
- **Phase 3.** Scene-level multi-shot render (numbered blocks + one `Sound:` line) for
  Seedance / LTX-2.5; LTX-2.3 image+audio→video for cuts that cover recorded lines
  (recordings joined by `concatAudioToMp3`); assemble cuts → scene → beat MP4 through
  `beatAssemble.js`; retake note + critique lens per cut; template discovery /
  registration from the gallery; agent tools (`plan_cuts`, `render_cut_start_frames`,
  `render_cut_video`, `get_cut_job_status`); prod topology; retire the old
  `/video-prompt*` aliases; update `ATTRIBUTION.md` with the new rows in the table above.

## Open questions

1. Prompts tab as the home (recommended) or rebuild the Storyboard tab in place?
2. Emily's two structured negatives (recommended) or keep the blanket no-negation rule?
3. Spawn comfy-mcp over stdio with the MCP SDK (recommended, one new dep + rebuild) or
   call ComfyUI's HTTP API directly?
4. Prod topology: Tailscale to the GPU box, or bot-runs-locally for video work?
5. Default local model for the "Render all videos" button: LTX-2.5 (24 fps, 1280×720,
   synchronized audio, fastest of the installed set) or Wan 2.2 14B i2v (4-step Lightning,
   16 fps)? Recommended: LTX-2.5, with Wan as the quality alternative to test at 832×480.

## Appendix — local inventory (2026-09-30)

- ComfyUI 0.38.0, frontend 1.53.6, templates 0.11.70, on the Windows host at
  `127.0.0.1:8188`; comfy-cli 1.22.0; comfy-mcp 0.10.0 at `~/.local/bin/comfy-mcp`.
- GPU: NVIDIA GeForce RTX 5070 Ti, 16 GB; host RAM 64 GB (Windows), 32 GB (WSL).
- `local_check.runnable: true`: `video_wan2_2_14B_i2v`, `video_ltx2_5_i2v`.
