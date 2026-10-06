---
name: storyboard
description: Storyboard a screenplay beat end to end through the screenplay MCP server - read the beat, plan scenes and cuts (single-shot by default, multi-shot LTX clips for short sequences), write an LTX-2.5 video prompt and a Nano Banana start and end frame prompt for every cut that names each reference image by number, chain the cuts of a continuous shot frame to frame, assign 4 reference images to each frame, then render every frame on fal.ai with Nano Banana Pro; on request, render the clips through the app's render_videos MCP tool with the Admin page's default video renderer (never a hand-picked model). Use when the user asks to storyboard a beat, plan its scenes/cuts/frames, fill the Scenes tab, (re)render a beat's start/end frames, or render/encode a beat's videos.
---

# Storyboard a beat

Input: a beat (number, name or id) and optionally a project title. Output: the beat's Scenes tab filled in — scenes, cuts, a video prompt and both frame prompts per cut, 4 references per frame, both frames rendered — and a short report of what still needs a human eye.

Everything is stored through the `screenplay` MCP server (`mcp__screenplay__*`). Rendering goes through the app's own renderer via `scripts/render.mjs`. No repo code changes.

## Fixed choices

- **Image model: Nano Banana Pro** (app key `nano-banana-pro`, fal endpoint `fal-ai/nano-banana-pro/edit` when references are attached). Do not use Nano Banana 2: the user judged its frames not good enough (2026-10-04). Use another model only when the user names one.
- **Frame prompts are written for the Nano Banana family**: one descriptive paragraph (never a keyword list), and every attached reference is named as `Image N` using the renderer's numbering — see "Reference numbering".
- **Video prompts are written for LTX-2.5** (1–20 s, 24 fps, synchronized audio, native multi-shot; every LTX endpoint takes the same prose). Which model RENDERS a clip is not this skill's choice: `render_videos` uses the Admin page's default video renderer (a first-frame/last-frame model — both frames drive the clip). The end frame also drives chains. The prompt enhancer stays off — our prompts are already complete.
- **4 references on every frame.** On an END frame, 3 come from the library and the cut's own rendered start frame is the LAST one (Image 4).
- **A continuous shot is a chain of cuts.** The next cut's start frame IS the previous cut's end frame — the same picture, copied, never rendered a second time. See "Continuous shots".
- **A cut is one take by default.** A short shot/reverse-shot, insert or reaction run may be one multi-shot cut instead of several cuts. See "Multi-shot cuts".
- **Order of work:** plan and store everything → render all start frames → link end frames → render all end frames (this pass also fills the chained start frames) → look at every frame → fix and re-render the bad ones.
- **Ask once, up front**, only if the user has not said: how fine the cutting should be (roughly how many cuts), because each cut costs two renders. Otherwise proceed without check-ins.

## Steps

### 1. Read

`get_story` (tone, director's notes on cinematography), `get_beat` (body + dialogue), `get_cast` (wardrobe, sets), `get_scenes` (if scenes already exist, ask whether to replace or extend before writing).

Reference pool — the raw `list_reference_images` answer is too large to read; use:

```bash
python3 .claude/skills/storyboard/scripts/sb.py catalog <beat>
```

### 2. Choose references by looking at them

Descriptions lie about details (seat colour, which building, van model). Shortlist ids from the catalog, then look:

```bash
python3 .claude/skills/storyboard/scripts/sb.py refsheet <scratchpad>/refs.jpg <id> <id> ...
```

and Read the JPEG (tiles are numbered in argument order, 4 per row).

**Props.** List every object the beat's action depends on (handled, thrown, featured in a close-up, coming back later). Each should have a prop plate — a picture of the object alone, tagged `[PROP: name]` in the catalog. Attach it to EVERY frame the object is visible in, start and end, in every cut; it counts as one of the 4 references (drop the least useful set plate to make room). The renderer binds it as that object only, never as a place. A prop with no plate: stop and tell the user to run the beat's artwork critique (Check coverage → Create missing), which now drafts one — do not substitute a scene picture in which the object happens to appear, it is bound as the set.

### 3. Plan scenes and cuts

- One scene per location or movement of the beat; one cut per camera setup. Cover every written moment, in page order. Durations 4–8 s for a single take, up to 12 s for a multi-shot cut (0.5 s steps).
- Every cut names one camera move from [camera-shots.md](camera-shots.md) (Part 2), or static. Follow the story's cinematography note when there is one.
- **Video prompt** = one LTX-2.5 paragraph: shot → scene → action → characters → camera → audio ("Rules for prompts" below). The move's template is rewritten into the camera sentence as prose, never pasted with its labels.
- **Start frame prompt** = the first instant; **end frame prompt** = the last instant of the same move — it must show what the template's `End:` clause says. The pair differs only by what the action and the move change.
- Look for continuous shots and multi-shot runs before counting cuts (next two sections) — they change how the cuts are divided and how their frames are written.
- Decide each frame's references and list them identity → wardrobe plate → prop plate → set plate; the Nth id is `Image N` in the prompt ("Reference numbering" below). Run `sb.py refs <beat>` after storing to check.
- Store with `create_scene` passing `cuts[]` (one call per scene): title, `duration_seconds`, `prompt`, both frame prompts, 4 `start_frame_reference_ids`, and 3 library `end_frame_reference_ids` (step 5 appends the start frame as the 4th).

### Continuous shots

A shot the page describes as ONE unbroken take that is too long, or changes too much, for a single clip: a long descent or tilt, a oner through several rooms, a slow morph of one thing into another, a scale reveal. A video model only gets a first and a last frame, so everything that must happen in between has to be pinned down by a frame of its own.

- **Split it at every change that needs describing.** N+1 keyframes make N cuts; each cut carries ONE change (the sphere enters → it hangs and starts down → the roofline rises behind it → the scale collapses → it lands on a foot). When unsure, add a keyframe: a clip that has to invent two changes between its frames invents them badly. A slow morph needs a keyframe for every state the audience should be able to read — "could be a ship", "something is off about its surface", "it is yarn".
- **Chain the cuts.** Write each keyframe prompt once. It is cut N's end frame prompt and, character for character, cut N+1's start frame prompt. That identical text is the marker: the scripts treat such a cut as chained (same scene, directly after), skip rendering its start frame and copy the previous end frame into it. Chained start frames take no reference ids (the `Image N` handles in their copied text are never read — by design).
- **Each keyframe is conditioned on the one before** (it is the LAST image — Image 4 with 4 references — of the next end frame), but its prompt is a complete standalone picture: shot size, angle, the object, its size, position and surface now, what is in frame, the light, the look line — the fixed descriptions repeated word for word along the whole chain, and Image 4 named only for what to copy ("the sphere exactly as in Image 4, now twice the size and lower in frame"). Never "same shot", "continuing", "as before": the image model sees this prompt and these pictures, nothing earlier. Change one property at a time; a keyframe that changes angle, scale and identity together breaks the link.
- **Video prompts are one move, cut into segments.** One camera move for the whole chain; each cut's paragraph describes its own segment as a complete clip — what is in frame as it opens, the move during these seconds, where it lands — in the same words as the neighbours, and only the last cut's `End:` settles. The video model sees this clip's start frame and this paragraph only, so no "continues", "still", "as before" or mention of another cut: a held object's motion and speed are stated in every cut, slow motion stated in one is stated in all, and the audio sentence is identical along the chain.
- **Not a chain:** separate setups in the same place, a cut on action, a reverse angle. Those are ordinary cuts with their own start frames. Chaining is for footage that must play as one take when the clips are laid end to end. A chain is never multi-shot.
- After storing, `sb.py verify <beat>` prints `continuous shot: 1.1 → 1.2 → …` for every chain it detected. If one is missing, the two prompts differ — make them identical with `update_cut`.

### Multi-shot cuts

LTX-2.5 can hold 2–4 distinct shots joined by explicit cuts inside one clip. Use that for a quick run the page plays as a sequence of glances — a shot/reverse-shot exchange, an insert and the reaction to it, three details of one place — where each shot is too short to earn its own two frames. Everything else stays one take per cut; for an image-to-video clip the guide itself prefers a single take unless the cut away from the opening image is described on purpose.

- **One chronological paragraph.** Shot 1 is the opening image: "The clip opens on …". Every further shot is introduced by a named transition in prose — "A hard cut transitions to a close-up of …", "The view cuts to …", "A match cut connects … to …", "The image dissolves into …" — and then re-established: shot scale, angle, who or what is in frame, the light if it changed. No shot list, numbered beats or sluglines.
- **Give each shot a job** (establish → detail → reaction; wide → medium → close-up) and keep the shots in story order ("Initially…", "A moment later…"). 2–4 shots, 3–4 s each; more cuts need shorter, clearer shots.
- **Re-identify recurring people and objects** with the same identifiers every time ("the man in the grey coat, at the counter in the first shot, now…"). No geography or costume jump between shots unless the cut means a jump in time or place and the paragraph says so.
- **State audio continuity at every cut** — "the lobby hum continues across the cut", "the score drops away; only rain remains" — within the no-speech rule below.
- **Frames.** Start frame = the first instant of shot 1. End frame = the last instant of the LAST shot — a different framing, so the "same camera position as the opening frame" wording does not apply: write it as that shot, and say where the camera is now. The start frame still rides along as Image 4 so the place, people and clothes carry across.
- Name every multi-shot cut in the report.

### 4. Render start frames

```bash
docker compose exec -T -e BEAT=<n> -e FRAME=start bot node --input-type=module - \
  < .claude/skills/storyboard/scripts/render.mjs > <scratchpad>/start.log 2>&1
grep -c '^OK' <scratchpad>/start.log; grep '^FAIL' <scratchpad>/start.log
```

Env: `PROJECT="Title"`, `ONLY=1.1,2.3`, `FORCE=1` (re-render frames that already have an image), `MODEL`, `POOL`, `DRY=1` (print what would be rendered or copied; nothing is written). Chained cuts are listed as `CHAIN` and skipped here. A full pass takes several minutes; give the command a 10-minute timeout. Render ONE cut first (`ONLY=`) and look at it before the full pass.

### 5. Link and render end frames

`link-end` appends each cut's start frame as the LAST reference of its end frame — Image 4, the number the end prompt uses for it (the end pass also does it for any cut it renders, so a skipped `link-end` cannot produce an unlinked end frame). Storyboards stored before 2026-10-05 have it first: run `link-end` once to move it before re-rendering their end frames.

```bash
python3 .claude/skills/storyboard/scripts/sb.py link-end <beat>
docker compose exec -T -e BEAT=<n> -e FRAME=end bot node --input-type=module - \
  < .claude/skills/storyboard/scripts/render.mjs > <scratchpad>/end.log 2>&1
```

The end pass walks each chain in order: render cut N's end frame → copy it into cut N+1's start frame (stamped `chain:<image id>` as its model) and append it as the last reference of N+1's end frame → render that end frame → and so on. Chains run one cut at a time; ordinary cuts and separate chains run in parallel. `link-end` leaves chained cuts alone.

### 6. Verify and fix

```bash
python3 .claude/skills/storyboard/scripts/sb.py verify <beat>
python3 .claude/skills/storyboard/scripts/sb.py refs <beat>
python3 .claude/skills/storyboard/scripts/sb.py sheet <beat> <scratchpad>/frames
```

`verify` also checks every frame prompt against its references: an `Image N` with no Nth image, a reference the prompt never names, a start frame that is not the last end reference. `refs` prints the numbering per frame as the renderer binds it. Read every sheet (tiles are start,end pairs in cut order). Check each frame against the list under "Problems that keep happening". Fix by editing the prompt or references with `update_cut`, then re-render with `FORCE=1 ONLY=<labels>` — start frames first, then the end frames of every cut whose start frame changed. In a chain, fix a keyframe by re-rendering the END frame that produced it (`FRAME=end FORCE=1 ONLY=<label>`); the pass then re-copies it forward and re-renders every end frame after it in the chain, since each was built on the one before — so fix chains from the first bad keyframe, and expect the later ones to change. Never render a chained start frame by itself. A seam is right when the end tile of one cut and the start tile of the next are the same picture on the sheet. Re-check with `sb.py sheet <beat> <dir> <labels…>`.

### 7. Render videos (only when asked)

Clips are rendered ONLY through the screenplay MCP tool `render_videos` — never by calling fal.ai, ComfyUI or any other video model yourself, and never by picking a model: with no `provider`/`model_id` the tool renders with the **default video renderer set on the app's Admin page** (Admin → Video renderer; the user keeps it on the first-frame/last-frame model they want), through the same whole-beat batch the Scenes tab's "Generate all videos" runs, so the open page shows the progress. Name a model only when the user names one in this conversation.

```
render_videos {beat}                 # every cut with both frames and a prompt, skipping cuts that already have a clip
get_video_batch {beat}               # poll every ~15 s until status != "running"; per cut: queued | running | done | error | skipped
```

If `render_videos` answers that no default video renderer is set, stop and tell the user to set one on the Admin page — do not choose one. A local ComfyUI batch renders one cut at a time and can take minutes per cut; report errors per cut from `get_video_batch` (`cancel_video_batch` stops it). A clip is rendered from the cut's stored video prompt, start frame and end frame, so finish steps 4–6 first.

### 8. Report

Scene/cut table (mark chains and multi-shot cuts), what was re-rendered and why, which cuts got a clip (and with which renderer, from `render_videos`'s `renderer`), and what still needs a hand (legible signage, pairs whose cameras disagree, cuts with weak references). Tell the user to reload the Scenes page: the frame render process writes Mongo directly, so open pages do not refresh.

## Reference numbering (what the renderer tells the model)

The renderer (`renderCutFrame`) sends a frame's references **in stored order** — the Nth id in `reference_ids` is Image N, never re-sorted (changed 2026-10-05; it used to sort by role, so a number written against the stored list named the wrong picture). It gives each one a role from the beat's catalog — character artwork = identity, a wardrobe plate = wardrobe, a prop plate = prop, set artwork = look, and on an END frame the cut's own start frame = continuity — and writes one binding line per image above the prompt ("Image 1 is KEYS: take only the face, hair, build and wardrobe from it.", "Image 3 shows the set "Lobby" from a different camera…", "Image 4 is the opening frame of this same shot, a few seconds earlier…") followed by "The shot:" and the stored prompt. So:

- **Use the same handles in the prompt.** Every attached image is named by number at least once, where it belongs in the picture: "KEYS (Image 1), in the outfit of Image 2, stands at the counter of the lobby of Image 3, seen from the mezzanine." A reference the prompt never places still shapes the picture, and a number with no image behind it is ignored — attach exactly what the prompt uses.
- **List references in this order** — identity → wardrobe plate → prop plate → set plate; end frame: the 3 library refs in that order, then the start frame LAST. Edit-style models anchor hardest on image 1, so a face goes first and a place never does. Two characters: both identities first, in the order the prompt names them.
- **End frames:** the opening frame is the LAST image. The renderer's own binding line tells the model what Image 4 is; the prompt still describes the whole picture (camera position and angle in the same words as the start prompt, who and what is where now, light, look) and names Image 4 only for what to copy ("the booth, the seats and KEYS's clothes exactly as in Image 4").
- **Chained start frames** have no references; the handles in their copied text are never read.
- `sb.py refs <beat>` prints each frame's numbering with roles and flags images the prompt does not name; `sb.py verify` reports the same as problems.

## Rules for prompts

### Frame prompts (Nano Banana Pro)

- One flowing paragraph describing a photograph of one instant — no "then", no motion verbs that need time. Not a list of keywords.
- **Standalone.** The image model sees this prompt and its attached images, nothing else — not the other frame, not the cut, not the chain. "Same shot", "same camera position as the opening frame", "continuing", "as before", "the previous keyframe" describe nothing. Every frame carries its full description (shot size, angle, subject, place, light, look); when two frames share a camera or an object, the words are repeated verbatim, and `Image N` is used to say what to copy from an attached picture.
- Open with the shot: "A photorealistic [shot size] [angle] of [subject] in [setting]" (camera-shots.md Part 1), then the light (one coherent light logic), then materials and colours, hyper-specific ("burgundy-red 1986 Ford Aerostar", "red velour seats with wooden armrests"), then the lens/look line from the director's notes (film stock, exposure, aspect).
- Name every reference by number, inline, where it belongs ("Reference numbering" above).
- Write each character's wardrobe out in words in every frame they are in, even with a wardrobe plate attached.
- Positive framing: say what a surface shows, not only what it must not. Name every sign, marquee, poster, plate, screen and ticket in shot and what it carries — "the marquee is a blank white lightbox", "the posters are plain colour fields" — and that it carries no lettering. Supers and titles are added in post.
- A cinema/TV/phone screen in shot: say what light or picture it shows. Never render footage of a real film.
- Dialogue words never go into any prompt — say that a character speaks or whispers, not what.
- Characters with no artwork (parents, extras) exist only in words: give each a fixed two-detail description ("woman in a cream cardigan with a shoulder bag") and repeat it identically in every cut.
- Along a chain the fixed descriptions are repeated word for word; each keyframe changes one property.

### Video prompts (LTX-2.5)

- One flowing paragraph, present tense, 4–8 sentences for a single take (longer only for a multi-shot cut), every sentence adding concrete visual or audio detail. Match detail to scale: a close-up needs more than a wide shot.
- In this order: **shot** (scale, angle, a genre or style term, the look line) → **scene** (light, palette, textures, atmosphere; one light logic — mixed sources confuse the model) → **action** as a sequence from the first instant to the last ("Initially…", "a moment later…") → **characters** (age, hair, clothing in the same words as the frames; emotion as physical cues, never labels like "sad") → **camera** (how and when it moves, relative to the subject, and how the subject sits in frame after the move — the template's `End:`) → **audio** (one sentence).
- **The camera sentence is the move's template rewritten as prose**: "The camera dollies in smoothly at a constant height toward her, and settles on a tight composition of her face" — never the `Movement:/Speed:/Framing:/End:` labels. Static: "The camera holds one fixed position for the whole clip."
- **Audio = ambience and music only.** Room tone, weather, crowd, traffic, the mood of the score. A character who talks is described as talking, mouth moving, with no voice and no words — never quoted speech, never "says". Dialogue is recorded separately.
- Keep the frame focused (a few clear subjects), the physics plausible (chaotic motion makes artefacts; slow motion is fine), and nothing the clip must spell out on screen.
- Multi-shot cuts follow "Multi-shot cuts" above; chains follow "Continuous shots".

## Problems that keep happening

1. **The portrait is bound as a place.** The renderer labels a reference by the beat's artwork catalog; an image that is not in it (a character's gallery portrait, `portrait_image_id` from `get_cast`) is treated as a location and the face drifts. For identity use a character ARTWORK that `sb.py catalog` lists (a front headshot), never the gallery portrait.
2. **Set plates that disagree.** A set often has two families of plates showing different buildings. Pick one family for the whole beat — the one matching the set description — and never mix. The set's main image is not automatically the right one.
3. **Recurring props change between cuts.** A vehicle, a prop, the seats: fix its colour and material in words ("burgundy-red 1986 Ford Aerostar", "red velour seats with wooden armrests") and repeat the exact phrase in every frame of every cut it appears in. The start-frame reference alone does not hold it.
4. **Empty rooms.** Plates are empty; the model keeps them empty. State the crowd in every frame ("nearly full house, every row in view packed").
5. **Close-ups lose the set.** "Everything else black" drops the seat and the room. Name one piece of set that stays visible behind the subject.
6. **Green-screen plates.** Screens and marquees in the plates are green/blank for compositing. Say what the surface shows or it renders green.
7. **Signage copied from plates.** Lettering on a plate ("BRITANNIA 6 CINES") comes through. If it must not, say that the sign is blank, and list it in the report when it survives.
8. **Start/end camera mismatch.** If the end frame is from a different position than the move allows, rewrite the end prompt's opening sentence to state the camera position and angle in the SAME WORDS as the start prompt (a static shot: identical; a move: the start's words plus the move's `End:`), then only what changed — never "same camera position as the opening frame", which the model cannot resolve. (Not for a multi-shot cut, whose end frame is its last shot.)
9. **A prop with no plate, or its plate left off.** Without its plate a prop is re-invented in every frame (the hacky sack came out as a hat, a beanie, a ball). Never attach a prop plate to a frame the object is not in — the same rule as character artwork.
9a. **References that are not really relevant.** When the library has nothing for a cut (an arcade, a concession counter), use plates of the same building and period crowd, and name the cut in the report. Do not attach character artwork to a frame the character is not in — the character will appear.
10. **A continuous shot stored as separate cuts.** Each start frame was rendered on its own, so the object, the sky and the camera jump at every seam (Gold Farm beat 2, the falling hacky sack, 2026-10-05). If the page reads as one take, chain it.
11. **Drift down a chain.** Each keyframe inherits the last one's errors. Look at a chain's frames in order as soon as its end pass finishes, before the rest of the beat, and fix the earliest bad one.
12. **Shell.** The user's shell is zsh: an unquoted `$ids` list is not word-split. Use the scripts here, or `bash -c`.
13. **Prompt and references disagree.** A reference nobody names still shapes the picture; a number the prompt uses that no image has is ignored; a start frame stored first instead of last makes every number in the end prompt off by one. `sb.py verify` flags all three — fix the list (`update_cut`) or the prompt, then re-render.
14. **A multi-shot paragraph with no cut language.** Without "A hard cut transitions to…" LTX plays the whole paragraph as one take from the opening image and skips the later shots. Name every transition.
15. **Relative wording.** "Same shot, continuing", "as in the previous cut", "the tilt down continues" — found in Gold Farm beat 2's chains (2026-10-05). Each prompt goes to a model that sees only that prompt (plus, for a frame, its attached images); the words mean nothing there. Write each frame and each clip complete.
