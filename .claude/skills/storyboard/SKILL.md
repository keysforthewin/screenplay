---
name: storyboard
description: Storyboard a screenplay beat end to end through the screenplay MCP server - read the beat, plan scenes and cuts (one continuous shot = ONE cut pinned by keyframes at times inside it; multi-shot LTX clips for short sequences), write an LTX-2.5 video prompt and a Nano Banana prompt for every start frame, keyframe and end frame that names each reference image by number, assign 4 reference images to each frame, then render every frame on fal.ai with Nano Banana Pro; on request, render the clips through the app's render_videos MCP tool with the Admin page's default video renderer (never a hand-picked model). Works one scene at a time with keyframe, clip and seam checks (constant object speed, holds, morphs, joins), fixes clips in post, and keeps a per-beat notes file of corrections that it offers to fold back into the story. Use when the user asks to storyboard a beat, plan its scenes/cuts/frames, fill the Scenes tab, (re)render a beat's start/end frames, or render/encode a beat's videos.
---

# Storyboard a beat

Input: a beat (number, name or id) and optionally a project title. Output: the beat's Scenes tab filled in — scenes, cuts, a video prompt per cut, a prompt for its start frame, each of its keyframes and its end frame, 4 references per frame, every frame rendered — and a short report of what still needs a human eye.

Everything is stored through the `screenplay` MCP server (`mcp__screenplay__*`). Rendering goes through the app's own renderer via `scripts/render.mjs`. No repo code changes.

## Fixed choices

- **Image model: Nano Banana Pro** (app key `nano-banana-pro`, fal endpoint `fal-ai/nano-banana-pro/edit` when references are attached). Do not use Nano Banana 2: the user judged its frames not good enough (2026-10-04). Use another model only when the user names one.
- **Frame prompts are written for the Nano Banana family**: one descriptive paragraph (never a keyword list), and every attached reference is named as `Image N` using the renderer's numbering — see "Reference numbering".
- **Video prompts are written for LTX-2.5** (24 fps, synchronized audio, native multi-shot; every LTX endpoint takes the same prose). Which model RENDERS a clip is not this skill's choice: `render_videos` uses the Admin page's default video renderer. The user keeps it on the **keyframe model** (`ltx-2.5-keyframes`): the start frame, every keyframe of the cut at its time and the end frame pin ONE generation — up to 20 s natively, longer with the model's `long_clip` (context windows). A plain first/last-frame default renders the two frames only and IGNORES keyframes — the clip gate shows it (every keyframe "missed"); stop and tell the user. The prompt enhancer stays off — our prompts are already complete.
- **Keyframes pin what happens between the frames, and their spacing is the speed.** A keyframe is a picture of the shot at a time inside the cut (0.5 s steps, ≥ 0.5 s from either end), with its own prompt and references, stored on the cut (`keyframes[]`, each with an `id`, `at_seconds`, an optional `strength`). The clip is conditioned on all of them at once, so the physics lives in the plan: equal distance per equal time is constant speed, a slow-motion stretch and a full-speed stretch are two spacings of the same object in one cut, and an apex is two keyframes at the same position. See "Planning for a keyframe video model".
- **4 references on every frame.** On a KEYFRAME, 3 come from the library and the picture it follows (the previous keyframe, else the start frame) is the LAST one (Image 4); on the END frame the last keyframe (else the start frame) is Image 4. `render.mjs` puts that picture last itself before rendering.
- **A continuous shot is ONE cut with keyframes.** Chaining cuts frame to frame (the next cut's start frame IS the previous cut's end frame, copied) is kept only for a shot longer than the clip cap when `long_clip` is not wanted, and for a camera change inside a take. See "Continuous shots".
- **A cut is one take by default.** A short shot/reverse-shot, insert or reaction run may be one multi-shot cut instead of several cuts. See "Multi-shot cuts".
- **One scene at a time (the user's rule, 2026-10-06).** Plan, render, check and show ONE scene, get the user's verdict, and only then plan the next — what a scene teaches changes how the next is planned. Per scene: plan it (with each cut's acceptance criteria) and store it → render its start frames → its end frames → keyframe gate → fix → (when the user wants clips) render its clips → clip and seam gates → fix (trim, retime, re-roll, re-plan) → a stitched preview of the scene → the user's verdict → corrections and the offer to update the story (step 9). The direction checklist (step 3) is made for the whole beat once, up front, so nothing falls between scenes.
- **The beat's notes file** `.claude/storyboard/<project-slug>/beat-<N>.md` (tracked in git, outlives the session) holds the direction checklist, each cut's acceptance criteria, the post-production recipe of every stored clip, the corrections log and the story changes waiting to be proposed. Read it before anything else; write to it as you go. See step 9.
- **Ask once, up front**, only if the user has not said: how fine the cutting should be (roughly how many cuts), because each cut costs two renders. Otherwise proceed without check-ins.

## Steps

### 1. Read

The beat's notes file first (`.claude/storyboard/<project-slug>/beat-<N>.md`; create it from the template in step 9 if it does not exist): its corrections are mistakes already made on this beat — plan around every one of them, even the ones whose story change has not been applied yet. Then `get_story` (tone, director's notes on cinematography), `get_beat` (body + dialogue), `get_cast` (wardrobe, sets), `get_scenes` (if scenes already exist, ask whether to replace or extend before writing).

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

Read "Planning for a keyframe video model" below first — it decides how a moment becomes one cut, where its keyframes sit, and when a cut has to be split anyway.

- **Direction checklist.** Before cutting anything, list every explicit direction in the beat's text — speed ("SLOW MOTION", "Normal speed. On the landing"), camera ("the camera tilts down with it"), action verbs that must be seen ("flicks", "snatches", "lands on the instep"), continuity ("CHAINED from Beat#1": the first frame is the last frame of the beat before). Every item is assigned to a cut, or named in the report as deliberately left out. Gold Farm beat 2 lost "Normal speed. On the landing" to a rule below and the user had to ask for it (2026-10-06).
- One scene per location or movement of the beat; one cut per camera setup — a continuous take is ONE cut however much happens in it. Cover every written moment, in page order. Durations 4–8 s for a simple take, up to 20 s for a keyframed take (longer means `long_clip` — say so in the plan), up to 12 s for a multi-shot cut (0.5 s steps).
- Every cut names one camera move from [camera-shots.md](camera-shots.md) (Part 2), or static. Follow the story's cinematography note when there is one.
- **Video prompt** = one LTX-2.5 paragraph: shot → scene → action → characters → camera → audio ("Rules for prompts" below). The move's template is rewritten into the camera sentence as prose, never pasted with its labels.
- **Start frame prompt** = the first instant; **end frame prompt** = the last instant of the same move — it must show what the template's `End:` clause says. The pair differs only by what the action and the move change. **Keyframe prompts** = the instant at each `at_seconds`, each an edit of the picture before it ("Image 4 exactly — … with one difference: …"); the end frame of a keyframed cut is an edit of the last keyframe.
- Look for continuous shots and multi-shot runs before counting cuts (next two sections) — they change how the cuts are divided and how their frames are written.
- Decide each frame's references and list them identity → wardrobe plate → prop plate → set plate; the Nth id is `Image N` in the prompt ("Reference numbering" below). Run `sb.py refs <beat>` after storing to check.
- Store with `create_scene` passing `cuts[]` (one call per scene): title, `duration_seconds`, `prompt`, both frame prompts, 4 `start_frame_reference_ids`, 3 library `end_frame_reference_ids` (the render passes append the picture each frame follows as the 4th), and `keyframes: [{at_seconds, prompt, reference_ids (3 library refs), strength?}]` in time order. Later changes: `add_keyframe`, `update_keyframe`, `delete_keyframe` (an `update_cut` never touches keyframes).
- **Acceptance criteria, written now.** Before rendering, write them under the scene's heading in the beat's notes file: per cut (label and cut id) — *opens on* (the start keyframe in a sentence), *ends on*, *must happen* (each assigned direction from the checklist), *moving object* (what, from where to where, at what speed — and "constant" for anything in flight), *camera* (locked off or the move), *speed* (slow motion or normal, and any ramp made in post), *must not* (the failures this cut invites: a string above a falling object, a morph, a lone shoe, the camera drifting, the object hanging at the end), and for a keyframed cut the **keyframe table**: one row per frame — time | what is where (the object's position in frame-heights, the pose) | speed from the previous row (distance ÷ interval, "constant" along a flight, "slow motion" / "full speed" by stretch) | strength. Every gate in steps 6 and 7b checks frames and clips against this file, so the check is the plan, not a fresh impression.

### Planning for a keyframe video model

The default renderer is the LTX-2.5 keyframe model: it gets the cut's start frame, every keyframe at its time, the end frame and one paragraph, and renders the whole cut in ONE generation, passing through each picture at its moment. Between two pictures it still takes the shortest path and still eases a little into each one — so everything the story needs to happen is pinned by a picture of its own, and the TIMES of those pictures are the physics. These rules grew out of Gold Farm beat 2's opening, first as a chain of seven first/last-frame clips fixed in post (2026-10-05/06), then as keyframes.

- **Keyframes are the plan.** Lay the shot out as a timeline first: t = 0 the start frame, t = duration the end frame, and a keyframe at every moment the model would otherwise have to invent — the object leaving frame, at its apex, coming back in, in contact, the hand arriving. Write the keyframe table (step 3) before any prompt.
- **Spacing is speed.** The model moves an object from one keyframe to the next in exactly the time between them. Constant speed = the same distance (in frame-heights) per second between every pair of keyframes along the flight: compute `at_seconds` from distance ÷ speed, snap to 0.5 s. A slow-motion stretch and a full-speed stretch are two spacings in one cut (the sack covers 0.3 H per second while it rises in slow motion, 3 H per second once the foot comes in) — the speed ramp is placed by the keyframes, not made in post. The paragraph names the speed of each stretch in the same words.
- **An apex is allowed again** — as two keyframes at the same position a short interval apart (the hang), or as one keyframe at the top when the object should just turn around. Off-screen turnarounds (leave the frame, an empty keyframe, come back) are still fine when the page wants them.
- **Strength.** A keyframe's `strength` is how hard the model holds it (the template's 0.7 when blank). Drop to 0.4–0.5 for a composited or approximate keyframe whose POSITION matters but whose pixels should not be copied; keep the default for a real rendered state. Never raise above 0.8 — the clip stutters into a slideshow.
- **Keyframes sit on an 8-frame grid** (every 1/3 s at 24 fps; the renderer snaps a time down to it). Two keyframes under 1 s apart make the model jitter between them — merge them or spread them. `sb.py verify` flags pairs under 1 s.
- **Whatever moves in the cut is in a keyframe at its true size** before it has to move. An object entering frame gets a keyframe already partly in view at the edge it enters from; the video model never sees a prop plate.
- **The 20 s line.** A cut up to 20 s renders in one pass. Longer needs `long_clip` (context windows) — allowed, but say so in the plan; the user may prefer two cuts. Over 60 s is always several cuts.
- **Render the physical truth, never the metaphor.** "It reads as a sphere ship" describes what the AUDIENCE thinks; the object on screen is still a hacky sack — distance, light and framing make it read as a ship. Never put the metaphor's words (ship, metal, glow, hull, spacecraft) in a frame or video prompt unless the thing really is one: the model draws them, and two frames then show two different objects that the clip morphs between.
- **One change per keyframe interval.** The stretch between two consecutive pictures carries ONE change (rise; hang; fall; contact). A stretch that must invent two changes invents one badly — add a keyframe.
- **The model takes the shortest path between two pictures.** Asked to go from "sack on the shoe" to "sack in a hand", the hand picks it off the shoe — the kick never happens. Anything that must happen BETWEEN two pictures needs a keyframe of its own: the object out of frame, at the top of an arc, in contact.
- **A moving object keeps ONE constant speed through a flight (the user's rule, 2026-10-06)** unless the page names a ramp. With keyframes that is arithmetic — equal distance per equal time — and it is checked, not hoped for: `qc.py clips … --bg <clean plate>` prints the measured speed per keyframe interval. A catch still needs the catcher in place first (a keyframe with the hand waiting while the object is out of frame), and a join between two CUTS inside a flight still states the same speed in both paragraphs.
- **Every keyframe after the first is an edit of the one before**, same camera: "Image 4 exactly — <the fixed list: camera height and tilt, framing, each object in frame> all exactly as they are in Image 4 — with one difference: …", with the previous picture as the LAST reference (Image 4) and only the props the difference needs before it. The end frame of a keyframed cut is an edit of the last keyframe. A frame written as a fresh picture rebuilds the place (a different theatre, a different van). `render.mjs` renders a prompt that opens "Image N exactly" as an EDIT of its Nth reference and puts the right picture last itself (step 4b). `qc.py frames` walks start → keyframes → end and flags an edit that rebuilt the place, with a grid of where it changed.
- **When the image model will not hold an edit, composite it.** After two rebuilt or drifted attempts, make the keyframe in ffmpeg instead: the previous picture untouched, plus the object cut from a render where it looked right (a feathered circle `geq` alpha, `overlay`), and upload it (`/upload?cut_id=…&target=keyframe&keyframe_id=<id>&model=composite:<what>`), with a soft strength (0.5) if only its position matters. Its seams are perfect by construction.
- **Locked-off camera by default.** A camera move is its own cut, and nothing else changes in it except what the move reveals.
- **Video prompts: words get drawn, in motion too.** "Crocheted", "yarn", "drops into the frame" grew a cord above the falling sack (a beanbag on a string). Describe the object as it should look moving ("a small, firm, round beanbag ball with red and navy panels"), say "a loose ball in free fall with nothing attached to it", and keep texture words for the frame prompts, where the prop plate holds them.
- **Body geometry, stated.** When a limb comes into frame, say how it enters and where it leaves frame ("his right foot planted in the right third of frame, the red-banded sock and jeans hem above it, his shin rising out of the top right of frame"). "Only the shoe is visible" rendered an empty sneaker lying in the lot.
- **A new camera setup takes set plates, never a frame of the previous shot.** A previous frame passed as a look reference is copied framing and all — the reveal of Keys came out as the same low shot with a small boy in it.
- **Post is the fallback, not the plan.** Trims, retimes and patches (step 7b) fix a take that missed; a plan that NEEDS them is missing a keyframe. Clips still act early and then hold still at times — `qc.py clips` reports how much.

### Continuous shots

A shot the page describes as ONE unbroken take: a long descent or tilt, a oner through several rooms, a slow morph of one thing into another, a scale reveal. **It is ONE cut with keyframes** — every state the audience must read (the sphere enters → it hangs and starts down → the roofline rises behind it → the scale collapses → it lands on a foot; "could be a ship" → "something is off about its surface" → "it is yarn") is a keyframe at its time, and the whole thing renders in one generation, so there are no seams to match and no speed to re-time. Split it into chained cuts only when it runs past 20 s and `long_clip` is not wanted, or when the camera changes setup mid-take. The chain rules:

- **Split at a keyframe.** The split picture is cut N's end frame and, character for character, cut N+1's start frame prompt; each side keeps its own keyframes. A chained cut never carries keyframes across the split.
- **Chain the cuts.** Write each keyframe prompt once. It is cut N's end frame prompt and, character for character, cut N+1's start frame prompt. That identical text is the marker: the scripts treat such a cut as chained (same scene, directly after), skip rendering its start frame and copy the previous end frame into it. Chained start frames take no reference ids (the `Image N` handles in their copied text are never read — by design).
- **Each keyframe is conditioned on the one before** (it is the LAST image — Image 4 with 4 references — of the next end frame), but its prompt is a complete standalone picture: shot size, angle, the object, its size, position and surface now, what is in frame, the light, the look line — the fixed descriptions repeated word for word along the whole chain, and Image 4 named only for what to copy ("the sphere exactly as in Image 4, now twice the size and lower in frame"). Never "same shot", "continuing", "as before": the image model sees this prompt and these pictures, nothing earlier. Change one property at a time; a keyframe that changes angle, scale and identity together breaks the link.
- **Video prompts are one move, cut into segments.** One camera move for the whole chain; each cut's paragraph describes its own segment as a complete clip — what is in frame as it opens, the move during these seconds, where it lands — in the same words as the neighbours, and only the last cut's `End:` settles. The video model sees this clip's start frame and this paragraph only, so no "continues", "still", "as before" or mention of another cut: a moving object's motion and speed are stated in every cut in the same words (one constant speed — see the rule above), each cut's paragraph names the playback speed that cut renders at (a planned slow-motion-to-normal change is made in post, never by changing the words mid-chain without a plan), and the audio sentence is identical along the chain.
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

### 4. Render start frames, then keyframes

```bash
docker compose exec -T -e BEAT=<n> -e FRAME=start bot node --input-type=module - \
  < .claude/skills/storyboard/scripts/render.mjs > <scratchpad>/start.log 2>&1
grep -c '^OK' <scratchpad>/start.log; grep '^FAIL' <scratchpad>/start.log
```

Env: `PROJECT="Title"`, `ONLY=1.1,2.3`, `FORCE=1` (re-render frames that already have an image), `MODEL`, `POOL`, `DRY=1` (print what would be rendered or copied; nothing is written), `ONE=1` (with `ONLY=`: render exactly those frames — no chain copy and no re-render of the later end frames of a chain; the way to fix one keyframe by hand, then re-copy it forward yourself only if the next cut's start must change). Chained cuts are listed as `CHAIN` and skipped here. A full pass takes several minutes; give the command a 10-minute timeout. Render ONE cut first (`ONLY=`) and look at it before the full pass.

**Edit frames.** A frame prompt that opens "Image N exactly — …" is rendered by the script itself as an edit of its Nth reference (logged `edit-of=Image N`): that picture is bound as "the frame to edit — the same camera, place and light", every other reference keeps the app's binding (prop plate, identity, wardrobe, look). The app's own renderer would bind a previous frame as a set "from a different camera — rebuild it" (it is in no catalog) or, as an end frame's continuity frame, as a picture whose framing must not be copied — both rebuild the place.

**4b. Keyframes** (after the start frames exist):

```bash
docker compose exec -T -e BEAT=<n> -e FRAME=kf bot node --input-type=module - \
  < .claude/skills/storyboard/scripts/render.mjs > <scratchpad>/kf.log 2>&1
```

Each cut's keyframes render in time order, one after another: before a keyframe renders, the picture it follows (the previous keyframe, else the start frame) is put LAST in its references, so its "Image 4 exactly" edits the right picture. `ONLY=1.1` renders every keyframe of cut 1.1, `ONLY=1.1@2.5` the one at 2.5 s (with `FORCE=1` to redo one); a re-rendered keyframe does not re-render the ones after it — look at them, and re-render forward with `FORCE=1 ONLY=1.1@<t>` where they no longer match. Different cuts render in parallel.

### 5. Link and render end frames

`link-end` appends each cut's start frame as the LAST reference of its end frame — Image 4, the number the end prompt uses for it (the end pass also does it for any cut it renders, so a skipped `link-end` cannot produce an unlinked end frame; for a KEYFRAMED cut the end pass puts the last keyframe there instead — run the end pass after 4b). Storyboards stored before 2026-10-05 have it first: run `link-end` once to move it before re-rendering their end frames.

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
python3 -I .claude/skills/storyboard/scripts/qc.py frames <beat> [labels…]   # the keyframe gate
```

**Frame gate** — every frame passes before any clip is rendered: (1) `qc.py frames`: a chained start frame is the previous end frame (similarity ≈ 1), and along start → keyframes → end every edit kept the picture it edits (≥ 0.8) with a change grid that lights up only where the stated difference is; (2) the sheet (start, keyframes, end per cut, in time order), read against the scene's acceptance criteria and keyframe table in the notes file — the object's size and identity, its position at each time, body geometry, the empty keyframes really empty, the pose a catch or a kick needs. A frame that fails is fixed now, never "left for the video model". `verify` also lists each keyframed cut with its times and flags a keyframe without an image or prompt, outside the cut, not written as an edit, under 1 s from its neighbour, or whose last reference is not the picture it follows.

`verify` also checks every frame prompt against its references: an `Image N` with no Nth image, a reference the prompt never names, a start frame that is not the last end reference. `refs` prints the numbering per frame as the renderer binds it. Read every sheet (tiles are start,end pairs in cut order). Check each frame against the list under "Problems that keep happening". Fix by editing the prompt or references with `update_cut`, then re-render with `FORCE=1 ONLY=<labels>` — start frames first, then the end frames of every cut whose start frame changed. In a chain, fix a keyframe by re-rendering the END frame that produced it (`FRAME=end FORCE=1 ONLY=<label>`); the pass then re-copies it forward and re-renders every end frame after it in the chain, since each was built on the one before — so fix chains from the first bad keyframe, and expect the later ones to change. Never render a chained start frame by itself. A seam is right when the end tile of one cut and the start tile of the next are the same picture on the sheet. Re-check with `sb.py sheet <beat> <dir> <labels…>`.

### 7. Render videos (only when asked)

Clips are rendered ONLY through the screenplay MCP tool `render_videos` — never by calling fal.ai, ComfyUI or any other video model yourself, and never by picking a model: with no `provider`/`model_id` the tool renders with the **default video renderer set on the app's Admin page** (Admin → Video renderer; the user keeps it on the first-frame/last-frame model they want), through the same whole-beat batch the Scenes tab's "Generate all videos" runs, so the open page shows the progress. Name a model only when the user names one in this conversation.

```
render_videos {beat}                 # every cut with both frames and a prompt, skipping cuts that already have a clip
get_video_batch {beat}               # poll every ~15 s until status != "running"; per cut: queued | running | done | error | skipped
```

If `render_videos` answers that no default video renderer is set, stop and tell the user to set one on the Admin page — do not choose one. A keyframed cut over 20 s needs the keyframe model's `long_clip` on (Admin → Video renderer → params, or `render_videos` with `params: {long_clip: true}` only when the user asks for it); without it the batch reports the cut as an error naming `long_clip`. A cut whose clip "misses" every keyframe in the clip gate was rendered by a model that ignores keyframes — tell the user which renderer the batch used (`renderer` in the answer). A local ComfyUI batch renders one cut at a time and can take minutes per cut; report errors per cut from `get_video_batch` (`cancel_video_batch` stops it). A clip is rendered from the cut's stored video prompt, start frame and end frame, so finish steps 4–6 first. `render_videos` renders every cut of the beat without a clip — to render only the current scene, the other scenes' cuts must already have clips or be left without frames.

**Local ComfyUI.** Comfy Desktop has crashed (access violation in the LTX text encoder) loading a new prompt after a long render. Before a batch, and for each prompt it starts, `POST http://127.0.0.1:8188/free {"unload_models": true, "free_memory": true}` — a watcher that polls `/queue` and frees each new running prompt does it (the flag is consumed when that prompt finishes). A cut that errors with "Error executing tool job" / "upload_file": wait for ComfyUI to come back, free, re-run `render_videos`.

### 7b. Check the clips, fix them, stitch the scene

```bash
python3 -I .claude/skills/storyboard/scripts/qc.py clips <beat> <dir> [labels…]   # clip + seam gates; numbered sheets <dir>/<label>.jpg
python3 -I .claude/skills/storyboard/scripts/qc.py track <clip> --bg <clean plate> [--color red|dark] [--roi x0,x1,y0,y1]
python3 -I .claude/skills/storyboard/scripts/qc.py seam <a.mp4> <b.mp4> [--bg …]
python3 -I .claude/skills/storyboard/scripts/qc.py retime|constant|stitch|diff|ssim …   # see the script's header
```

**Clip gate**, per clip, against the cut's acceptance criteria: `qc.py clips` reports a clip that opens or ends off its frames (< 0.8), **whether it hits each keyframe** (the clip's frame at the keyframe's time vs the keyframe image — a miss under 0.7 is named; with `--bg <clean plate>` it also prints the measured speed per keyframe interval, to read against the keyframe table), how long nothing moves at the start and the end (the model acts early and then holds — trim it), and writes a numbered sheet of every third frame: read it, every frame, for the "must not" list (morphs, strings, a hanging object, a camera drift, an object that changes size). For anything in flight, `qc.py track` with a clean plate (an empty keyframe of the same shot) prints its position and speed per frame and flags where it slows down or speeds up; the flight must be constant. The tracker follows colour, so a red sock band or a tail light can leak in — narrow `--roi`, and always confirm on a cropped, numbered tile of the frames in question (`ffmpeg … select=between(n,A,B),crop=…,drawtext=%{n},tile=…`), with a pixel grid (`drawgrid`) before placing any patch.

**Seam gate**, per join: the last frame of one clip and the first of the next are the same picture (`qc.py clips` prints each chained seam, ≥ 0.85), and a moving object keeps its direction and speed across it (`qc.py seam`). Off-screen time between an exit and a re-entry must be physically plausible (a kick to above the frame and back: about a second).

**Fixes, cheapest first** — and record every one in the notes file as the cut's post recipe. For a keyframed cut, a wrong speed or a missed moment is first a PLAN fix (move a keyframe, add one, change a strength) and a re-render — post is for what is left:
1. **Trim** the held head and tail (`ffmpeg … trim=start_frame=A:end_frame=B`).
2. **Retime** to the planned speed: `qc.py retime` (segments) or `qc.py constant` (a flight resampled to one constant speed; frames that move too little are skipped, sped-up frames get a shutter blend). With keyframes this should be a trim of a few frames at most; a stretch that needs a real retime has its keyframes in the wrong places.
3. **Paint out** a small artefact in a STATIC part of the frame with the same region from a clean frame of the same clip (camera locked: `overlay … enable=…`). Not for anything that moves with the action — keyed fills over a moving cord left visible seams.
4. **Re-roll** — up to two more takes for a one-off failure (clear the clip, keep the old file as take A, change the prompt if a word caused it, render again).
5. **Re-plan** — the same failure twice means the plan is wrong: add the keyframe the model was missing, split the clip, or composite the keyframe.

Post-processed clips replace the stored clip: `curl -T <file> -H "Content-Type: video/mp4" "http://localhost:3002/upload?cut_id=<id>&target=video&model=<renderer>+post:<recipe>"`. Then stitch the scene (`qc.py stitch <out> <clips in order>` — a chained clip's repeated first frame is dropped), watch the sheet of the joined file, and send the preview to the user (SendUserFile when available).

### 8. Report (per scene)

Scene/cut table (mark chains and multi-shot cuts), what was re-rendered and why, which cuts got a clip (and with which renderer, from `render_videos`'s `renderer`), the post recipe of every edited clip, what the gates still flag and why it was left (e.g. a hold the user approved), and what still needs a hand (legible signage, pairs whose cameras disagree, cuts with weak references). Send the stitched preview. Tell the user to reload the Scenes page: the frame render process writes Mongo directly, so open pages do not refresh. Then ask for the verdict on this scene before planning the next.

### 9. Corrections, and updating the story

When the output is corrected, two things change, at different times:

- **The plan, at once.** Log every significant correction in the beat's notes file the moment it is made. Significant means a re-planned cut, a new or composited keyframe, a prompt rewritten because a word was drawn, a speed or trim fixed in post, or anything the user had to point out. Each entry gives what the output did → what changed (and the post recipe) → what the beat text should say so a fresh run gets it right the first time. Step 1 reads this log before any planning, so a re-render after a restart does not repeat the mistake.
- **The story, only when the user says so.** The beat text is what a storyboard is planned from, so the lessons belong in it too. But the corrections keep changing while a scene is being worked on, so never change the text mid-scene. Collect the proposed wording under "Story changes to propose" in the notes file, as before → after passages. **Offer to apply them:**
  - at the end of every scene the user accepts;
  - whenever three or more significant corrections have piled up since the last offer;
  - always when the beat is done.

  Show the passages and apply nothing without a yes. The default is to keep collecting until the beat is done. Mark the entries `applied` afterwards.
- **How to apply.** The screenplay MCP server cannot write beat text. A script that writes Mongo directly is overwritten by the open editor's y-doc, so never do that. Give the user the new passages to paste into the beat's Story tab, or to hand to the bot in Discord. Or offer to add a beat-text tool to the MCP server (an app change; ask first).
- **Lessons that are not about this beat** (a failure mode of a model, a script bug) are offered for this file's "Problems that keep happening" at the same moments.

Notes file template (`.claude/storyboard/<project-slug>/beat-<N>.md`; see `gold-farm/beat-2.md` for a filled one):

```markdown
# <Project> — beat <N> "<name>": storyboard notes
## Direction checklist            (table: direction in the text | cut | status)
## Scene <n>: <title> — status: planning | frames | clips | shown <date> | accepted <date>
#### <label> <title> (`<cut id>`), <seconds>
- Opens on / Ends on (keyframe ids) · Must happen · Moving object · Camera · Speed · Must not
- Clip: <take> · Post: <recipe>
## Corrections                    (C<k> date · cuts · seen → changed → story: "…" (pending | applied | not needed))
## Story changes to propose       (passage → new wording, from C<k>; open questions for the user)
```

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
12. **Shell.** The user's shell is zsh: an unquoted `$ids` list is not word-split, and zsh arrays start at 1. Use the scripts here, or write a throwaway script file in the scratchpad and run it with `bash <file>` (a long `bash -c '…'` can be refused by the permission check).
13. **Prompt and references disagree.** A reference nobody names still shapes the picture; a number the prompt uses that no image has is ignored; a start frame stored first instead of last makes every number in the end prompt off by one. `sb.py verify` flags all three — fix the list (`update_cut`) or the prompt, then re-render.
14. **A multi-shot paragraph with no cut language.** Without "A hard cut transitions to…" LTX plays the whole paragraph as one take from the opening image and skips the later shots. Name every transition.
15. **Relative wording.** "Same shot, continuing", "as in the previous cut", "the tilt down continues" — found in Gold Farm beat 2's chains (2026-10-05). Each prompt goes to a model that sees only that prompt (plus, for a frame, its attached images); the words mean nothing there. Write each frame and each clip complete.
16. **An object that hangs or eases at the end of a clip.** First/last-frame models ease into and out of their keyframes, so a thrown ball slows to a hover where it meets an end frame (Gold Farm beat 2, the kick and the fall back, 2026-10-06). Plan exits and re-entries through the frame edge, keep the catcher in place before the object arrives, then measure with `qc.py track` and retime with `qc.py constant`.
17. **The shortest path.** Asked to go from "sack on the shoe" to "sack in a hand", the model has the hand pick it off the shoe; asked for "sack in the air", it lifts the sack and stops. Every event between two frames that the story needs (a kick, a flight out of frame) needs a keyframe of its own.
18. **Edits that rebuild.** An "Image N exactly" keyframe came back as a different cinema with a lettered CINEMA sign, in daylight. `render.mjs` now binds the base as the frame to edit; if it still rebuilds twice, composite (see the planning rules). `qc.py frames` catches a rebuild (similarity < 0.8) but not a flipped hand. Read the change grid.
19. **Clips edited in post must be re-done after a re-render.** A stored clip may be trimmed, retimed or patched. Its recipe lives in the notes file and in the upload's `model` label (`…+post:<recipe>`). A fresh `render_videos` for that cut replaces it with a raw clip, so re-apply the recipe and re-check it.
20. **Two keyframes on one grid slot.** Keyframes snap down to 8-frame slots (1/3 s at 24 fps); two under 0.35 s apart land on the same slot and the later one wins silently (the render preview warns). Keep keyframes ≥ 1 s apart unless a hang is intended — and even a hang is two keyframes ≥ 0.5 s apart.
21. **Keyframes too close make the model jitter.** A run of keyframes 0.5 s apart holding slightly different poses came out as a flicker. Fewer, further apart, with the paragraph carrying the motion between them.
22. **A soft keyframe for a composite.** A composited or approximate keyframe at full strength copies its seams into the clip; at 0.4–0.5 the model keeps the position and shape and draws the pixels itself. Full strength for a real rendered state.
