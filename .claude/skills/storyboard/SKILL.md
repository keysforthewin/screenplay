---
name: storyboard
description: Storyboard a screenplay beat end to end through the screenplay MCP server - read the beat, plan scenes and cuts, write a start and end frame prompt for every cut, assign 4 reference images to each frame, then render every frame on fal.ai with Nano Banana Pro. Use when the user asks to storyboard a beat, plan its scenes/cuts/frames, fill the Scenes tab, or (re)render a beat's start/end frames.
---

# Storyboard a beat

Input: a beat (number, name or id) and optionally a project title. Output: the beat's Scenes tab filled in — scenes, cuts, both frame prompts, 4 references per frame, both frames rendered — and a short report of what still needs a human eye.

Everything is stored through the `screenplay` MCP server (`mcp__screenplay__*`). Rendering goes through the app's own renderer via `scripts/render.mjs`. No repo code changes.

## Fixed choices

- **Image model: Nano Banana Pro** (app key `nano-banana-pro`, fal endpoint `fal-ai/nano-banana-pro/edit` when references are attached). Do not use Nano Banana 2: the user judged its frames not good enough (2026-10-04). Use another model only when the user names one.
- **4 references on every frame.** On an END frame, reference 1 is the cut's own rendered start frame and the other 3 come from the library.
- **Order of work:** plan and store everything → render all start frames → link end frames → render all end frames → look at every frame → fix and re-render the bad ones.
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

### 3. Plan scenes and cuts

- One scene per location or movement of the beat; one cut per camera setup. Cover every written moment, in page order. Durations 4–8 s.
- Every cut names one camera move from [camera-shots.md](camera-shots.md) (Part 2), or static. Follow the story's cinematography note when there is one.
- **Video prompt** = what happens in the shot, then the move's template as the camera sentence.
- **Start frame prompt** = the first instant; **end frame prompt** = the last instant of the same move — it must show what the template's `End:` clause says. The pair differs only by what the action and the move change.
- Store with `create_scene` passing `cuts[]` (one call per scene): title, `duration_seconds`, `prompt`, both frame prompts, 4 `start_frame_reference_ids`, and 3 library `end_frame_reference_ids` (step 5 adds the start frame).

### 4. Render start frames

```bash
docker compose exec -T -e BEAT=<n> -e FRAME=start bot node --input-type=module - \
  < .claude/skills/storyboard/scripts/render.mjs > <scratchpad>/start.log 2>&1
grep -c '^OK' <scratchpad>/start.log; grep '^FAIL' <scratchpad>/start.log
```

Env: `PROJECT="Title"`, `ONLY=1.1,2.3`, `FORCE=1` (re-render frames that already have an image), `MODEL`, `POOL`. A full pass takes several minutes; give the command a 10-minute timeout. Render ONE cut first (`ONLY=`) and look at it before the full pass.

### 5. Link and render end frames

```bash
python3 .claude/skills/storyboard/scripts/sb.py link-end <beat>
docker compose exec -T -e BEAT=<n> -e FRAME=end bot node --input-type=module - \
  < .claude/skills/storyboard/scripts/render.mjs > <scratchpad>/end.log 2>&1
```

### 6. Verify and fix

```bash
python3 .claude/skills/storyboard/scripts/sb.py verify <beat>
python3 .claude/skills/storyboard/scripts/sb.py sheet <beat> <scratchpad>/frames
```

Read every sheet (tiles are start,end pairs in cut order). Check each frame against the list under "Problems that keep happening". Fix by editing the prompt or references with `update_cut`, then re-render with `FORCE=1 ONLY=<labels>` — start frames first, then the end frames of every cut whose start frame changed. Re-check with `sb.py sheet <beat> <dir> <labels…>`.

### 7. Report

Scene/cut table, what was re-rendered and why, and what still needs a hand (legible signage, pairs whose cameras disagree, cuts with weak references). Tell the user to reload the Scenes page: the render process writes Mongo directly, so open pages do not refresh.

## Rules for prompts

- Open with shot size and angle (camera-shots.md Part 1), then who and what, then light, then the look line from the director's notes (film stock, exposure, aspect).
- Describe a photograph, one instant. No "then", no motion verbs that need time.
- Write each character's wardrobe out in words in every frame they are in, even with a wardrobe reference attached.
- Say "No legible text" and name what must be blank (marquee, posters, plates, signs, tickets). Supers and titles are added in post.
- A cinema/TV/phone screen in shot: say what light or picture it shows. Never render footage of a real film.
- Dialogue words never go into any prompt — say that a character speaks or whispers, not what.
- Characters with no artwork (parents, extras) exist only in words: give each a fixed two-detail description ("woman in a cream cardigan with a shoulder bag") and repeat it identically in every cut.

## Problems that keep happening

1. **The portrait is bound as a place.** The renderer labels a reference by the beat's artwork catalog; an image that is not in it (a character's gallery portrait, `portrait_image_id` from `get_cast`) is treated as a location and the face drifts. For identity use a character ARTWORK that `sb.py catalog` lists (a front headshot), never the gallery portrait.
2. **Set plates that disagree.** A set often has two families of plates showing different buildings. Pick one family for the whole beat — the one matching the set description — and never mix. The set's main image is not automatically the right one.
3. **Recurring props change between cuts.** A vehicle, a prop, the seats: fix its colour and material in words ("burgundy-red 1986 Ford Aerostar", "red velour seats with wooden armrests") and repeat the exact phrase in every frame of every cut it appears in. The start-frame reference alone does not hold it.
4. **Empty rooms.** Plates are empty; the model keeps them empty. State the crowd in every frame ("nearly full house, every row in view packed").
5. **Close-ups lose the set.** "Everything else black" drops the seat and the room. Name one piece of set that stays visible behind the subject.
6. **Green-screen plates.** Screens and marquees in the plates are green/blank for compositing. Say what the surface shows or it renders green.
7. **Signage copied from plates.** Lettering on a plate ("BRITANNIA 6 CINES") comes through. If it must not, say that the sign is blank, and list it in the report when it survives.
8. **Start/end camera mismatch.** If the end frame is from a different position than the move allows, rewrite the end prompt to begin "Same camera position as the opening frame" plus only what changed.
9. **References that are not really relevant.** When the library has nothing for a cut (an arcade, a concession counter), use plates of the same building and period crowd, and name the cut in the report. Do not attach character artwork to a frame the character is not in — the character will appear.
10. **Shell.** The user's shell is zsh: an unquoted `$ids` list is not word-split. Use the scripts here, or `bash -c`.
