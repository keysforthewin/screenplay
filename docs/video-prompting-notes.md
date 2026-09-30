# How Emily converts prose into video-gen prompts

Notes on `github.com/Emily2040/seedance-2.0` (7.5k stars, v6.7.0, last pass
2026-09-27). Read 2026-09-30. Everything below is her method; where she marks a
rule as official ByteDance doc, learned from a paid render, or an unbenchmarked
heuristic, I keep the tag. Her repo is scoped to Seedance 2.0 (4–15 s clips);
she calls 30 s / integer timestamps "a 2.5 leak", but the writing method is the
same for any Seedance-class model.

The one-line version: **she never writes the prompt from the prose. She writes
a ten-field "director's read", then a shot table, then renders prose from the
table, one shot block per row, each block ending in a lock line.** The prompt
is bare present-tense prose. No brackets, no timestamps, no JSON, no style tags.

---

## 1. The pipeline

### Step 1. Director's Read (prose → ten fields, never shipped)

Before any drafting, the beat is reduced to ten mandatory fields. "Do not leave
blanks and do not substitute a generic mood word."

| Field | What it is |
|---|---|
| dramatic function | what the beat earns: introduce, deepen, turn, test, reveal, decide, pay off |
| turn | "the single before-to-after value change visible in the beat" |
| POV | whose experience organizes what the viewer sees, hears, learns |
| power shift | who controls the beat at the start, who at the end, what changes it |
| hidden want | what the focal subject is trying to get, protect, avoid, prove, conceal |
| obstacle / tactic | what blocks the want, then "the playable action used against it" |
| subtext / contradiction | the gap between stated surface and underlying action |
| visible suppressed behavior | "one small filmable action that shows an impulse being contained, redirected, or leaked" |
| non-transferable detail | one object, ritual, sound or location fact "another generic story could not inherit unchanged" |
| stock solution refused | the genre's easiest default this beat will not use ("no tearful close-up and score swell for grief") |

"The read is an internal brief and handoff object, never final generation
prose." It is compiled through a fixed carrier table, and this table is the
actual prose-to-prompt conversion:

| Internal read | Becomes in the prompt |
|---|---|
| POV | shot position, information withheld or revealed, eyeline, sound perspective |
| power shift | height, frame share, distance, who moves first, who yields space |
| hidden want | a task, prop action, approach, retreat, delay, or repeated attempt |
| obstacle / tactic | visible interference followed by one playable response |
| subtext | "words against body, smile against grip, agreement against retreat" |
| suppressed behavior | one timed gesture the camera can hold long enough to read |
| turn | a legible before/after state and a camera endpoint |
| non-transferable detail | the exact object, ritual, sound preserved in the shot |
| stock solution refused | a physical exclusion only when needed, paired with the replacement |

Her worked example. Brief: *A hotel night clerk sees her missing brother on a
security monitor but must keep serving the waiting guest.* Read: turn =
"professional control to nearly exposed urgency"; suppressed behavior = "her
finger hovers over replay, then she straightens a brass Room 214 key tag
instead"; refused = "no tearful close-up, flashback, or swelling grief score".
Compiled:

> Stay at the night clerk's side of the counter as she stamps a receipt for the
> waiting guest. A familiar face crosses the small security monitor behind the
> register; her stamping stops mid-impact, one finger reaches toward replay,
> then she pulls it back and carefully straightens the worn brass Room 214 key
> tag. Hold the guest soft in the foreground, let the monitor hum and the stamp
> click carry the silence, and end on her hand still pinning the tag flat.

"The compiled prompt never names the hidden want, subtext, power shift, or
emotion. The camera, interrupted task, withheld reach, exact prop, sound, and
endpoint carry them."

### Step 2. One intention, every instrument

The read collapses to one sentence ("make the audience feel her certainty
crack") and every instrument is set to it: shot size, angle, lens, movement,
light, blocking, performance, sound, cut. A project-wide **voice** is chosen
once (Observational naturalist / Composed classicist / Kinetic visceral /
Expressive stylist / Intimate minimalist / Graphic formalist). This is our
`directorial_voice` field.

Starting stacks by scene type: intimate dialogue = "medium close-up, eye-level,
longer lens, minimal motion, soft motivated key, sparse sound"; confrontation =
"opposed angles, height encodes status, light splits warm/cool, blocking closes
distance"; decision = "push-in to isolate the chooser; world quiets; one
gesture commits the choice".

### Step 3. Allocation: one primary spend per generation

"Identity fidelity, motion boldness, and scene density compete for the same
generation budget." Name the one thing the shot is for, pick one secondary,
economize everything else on purpose. "Bold motion and a close-up face: choose
one." Identity carried by `@Image1` is budget the text no longer spends. For a
dialogue close-up: primary = facial stability (locked camera), secondary = the
line, economized = motion and background activity.

### Step 4. Scope: one beat per generation

"One generation should normally carry one visible beat with a changed
endpoint." Beat = `before state → visible action → changed final state`. Story
beats are bucketed `already_happened` / `this_clip_only` / `reserved_for_later`
/ `do_not_show_yet`, and the scope firewall says story context "must not cause
the current clip to perform future events, reveal future information, solve
later problems, or skip physical handoff states."

Official ByteDance density warning she quotes: too much duration for too
little content and the model improvises; too little duration for several shots
and "the content and the lines garble." The remedy is always to split, never
to reroll the same count.

### Step 5. Shape, then load score

**Shape** is a content decision, not a duration decision. *Continuous* (one
scene, one action or state change, at most one speaker) = one paragraph, no
shot labels, phases written `Beginning / Then / Finally`. *Storyboard*
(several events, a location change, a reveal that needs a cut, a comparison)
= numbered `Shot N.` blocks in event order. "A 15-second clip of one woman
reading a letter is one paragraph."

**Load score** (her heuristic, explicitly "not a documented limit") decides how
many shots fit. Each beat is one shot; add load points:

| Element | Load |
|---|---|
| camera move within a shot (a cut is free) | 0.5 |
| a spoken line | 1 per 8 English words, min 1 |
| each additional principal who acts | 1 |
| a second person who only holds or reacts | 0.5 |
| background group with idle business | 0 |
| physical contact that must land | 1 |
| location change | 2 |
| sound cue that must land on an action | 0.5 |

Reaction shots and inserts count half a beat. `S = duration ÷ (beats + load)`.
S ≥ 3.0 Safe, 2.0–3.0 Stretch, < 2.0 Ambitious ("propose two generations
instead"). Her worked case: 15 s, two people, two six-word lines, one reaction.
Beats 3, load 3, S = 2.5, Stretch. Safe is two shots with the reaction held in
line B's framing. Her showcase clips all run at Stretch (S ≈ 2.0) deliberately
and "rendered every cut cleanly with each shot near three seconds."

### Step 6. Shot table before prose (mandatory for >1 shot or >1 person)

Header = a floor plan in words: "three or four sentences that a stranger could
draw from: the landmarks (door, table, counter, window), who is where at the
start and facing what, and the light source with its colour. Name the axis."
Then one row per shot. Every column has a default the model silently uses when
the cell is blank:

| Column | Content | If blank, the model does |
|---|---|---|
| Camera | which side of the room, relative to a named landmark, and the size | "the head of the table facing the lens" |
| In frame | each principal, where they stand or sit, which way they face | "people placed where the model last saw them" |
| Eye-line | for a reaction, camera on the side of the thing reacted to | "eyes to the lens, at nothing" |
| Action | the ONE action; a reaction = plain feeling + one physical anchor; a prop = a hand and a tilt; a line = words + voice + eyes | "the first verb understood; the rest dropped" |
| Others | one line of idle business for everyone else in frame | "a freeze, or invention" |
| Light | source and colour, same words as row one | "drift, warm to blue" |
| Last frame | what the frame holds when the shot ends; must be visible from the Camera cell | "an ending the shot cannot see" |

A crossing between landmarks gets its own row ("a cut from the door to a hand
at the table is a teleport"). Positions are relative to landmarks, never to the
previous shot. Then the **paper render**: read the table as a crew that never
met you; any "unstated" or "presumably" is a fault found for free.

### Step 7. Compile and check

Compile order: reference roles → actual opening state → this clip's one job
with an endpoint → the read's carriers → felt intent as camera/light/
performance/sound → one camera move → light/environment/audio "only
state-critical or intent-critical clauses" → exclusions (`Do not yet…`) →
endpoint (`Stop when…`). Then the eight-rule check (§3), anti-slop review, and
a moderation pre-screen last.

---

## 2. The prompt form

### Continuous clip (one paragraph)

`Subject + action with endpoint + scene. Camera: one move. Lighting: physical source. Sound: cue. Constraint: what must not change. End with/Stop when …`

> Character A stands in a narrow apartment hallway holding an unopened
> envelope sealed with a crooked green library-return sticker. A key enters
> the lock outside. She starts to tear the envelope, stops with the paper
> stretched between both thumbs, smooths the same creased corner flat twice,
> and tucks it behind her back before the lock turns. Camera: locked waist-up
> frame; one slow push-in begins on the key scrape and stops on her hands.
> Lighting: the warm ceiling practical flickers once while cool rain
> reflection holds on the wall. Sound: key scrape, paper crease, distant rain;
> hold the silence instead of adding music. End before the door opens, with
> her shoulders square and the envelope still hidden.

Phased single take: `Beginning: … Then: … Finally: … One continuous camera hold, no cuts.`

### Storyboard clip (numbered blocks)

Per block, in this order (the first four are the official ByteDance order, the
lock line is hers):

1. **cut or camera** — written in words, with the side of the room: "Cut to a medium shot from the counter side:"
2. **one action by one person**, with expression as feeling + anchor
3. **position or space change**
4. **audio for the shot** (or one `Sound:` line for the whole clip at the end)
5. **lock line**: "the light source and its colour; for each principal on screen their age band, hair, wardrobe and any distinguishing object; and where each principal is, relative to a fixed landmark", plus which way they face, plus the camera's side. Same words every shot.

Lock line template:

> Same light: one warm tungsten lamp overhead. The manager: fifties, grey suit,
> steel-rimmed glasses, standing by the counter, facing the chaise. Camera on
> the chaise side.

"The lock line is the price of a cut; write it even when it feels redundant,
because redundancy is how continuity is bought." "The model keeps nothing
across a cut that the prompt does not repeat, and that includes blocking."

**No seconds inside shot blocks.** Official 2.0 doc: the model's support for
exact times "is unstable, forcing a duration may cause abnormal results"; it
"responds to shot numbers, not timestamps." Felt length is written as
behaviour: "hold on the settled fan for one beat", not "hold 2 s". Duration
is the API parameter. One camera move per shot (official); a locked camera is
written in prose.

Ending: last sentence, always inside the frame the last shot can see. `End
with …`, `Stop when …`, `Hold on this frame as …`. Never "fade out."

Negatives: two kinds only. Reference non-transfer clauses right after the
binding, and clip-scope exclusions at the end (`Do not replay the terminal
exit. Do not show the vehicle departing yet.`). Plus the three official
templates: no subtitles, no logo, no watermark. Never a generic negative dump.

### Full example: Clip 02 "Hold the line" (15 s, 4 shots)

Typical brief people type: *epic storm at sea, fisherman fights giant wave,
slow motion, dramatic music, 8k.* Her read: "Turn: a boat about to be lost to
a boat still there. Force: the sea, acting first. Stakes in frame: one rope.
Visible suppressed behaviour: he answers without turning his head.
Non-transferable detail: boots braced against a cleat while water sheets
around them. Stock solution refused: no slow motion, no music, no rescue."

> Shot 1. Wide shot from the landward end of a wooden pier at night in a
> storm, looking out along it: a small fishing boat straining at a single
> mooring rope off the far end, its bow lifting and slamming with each swell,
> rain driven sideways through one sodium lamp, and behind the boat a wave
> building higher than the mast. At the far end of the pier a man leans back
> against the rope with both hands, boots sliding on the wet planks, holding
> on, his back to the camera. Light: one orange sodium lamp on its post at the
> end of the pier, black water beyond, nothing else. The man: forties, short
> beard streaked grey, yellow oilskin with the hood down, black rubber boots,
> at the end of the pier with the rope in both hands, facing the boat. Camera
> at the landward end.
>
> Shot 2. Cut to a medium shot at deck height from the side of the pier: the
> man has both hands on the rope, boots braced against a cleat, arms shaking
> with the strain, the rope creaking as the boat pulls. From the dark behind
> the camera, landward, a voice shouts over the wind: "Let it go, Tom! It's
> only a boat!" He hears it, keeps his eyes on the rope, and his grip
> tightens. Same light: one orange sodium lamp overhead, black water beyond.
> The man: forties, short beard streaked grey, yellow oilskin with the hood
> down, black rubber boots, braced at the cleat, facing the boat. Camera at
> his side.
>
> Shot 3. Cut to a close shot of his face from in front of him, the boat
> behind the camera: rain running off his brow, eyes on the rope, teeth
> clenched; without turning his head he shouts back over his shoulder, angry
> and close to tears: "It's my father's!" Same light: one orange sodium lamp
> overhead, black water beyond. The man: forties, short beard streaked grey,
> yellow oilskin with the hood down, braced at the cleat, facing the boat.
> Camera in front of him.
>
> Shot 4. Cut to a low angle from the pier planks in front of him, looking up
> at him with the boat's bow behind him: the wave breaks over the end of the
> pier and buries him in white water. When the water drains through the
> planks he is still there, bent double and coughing, both hands on the rope,
> the rope taut, the boat still there behind him. Hold on this frame as the
> next swell lifts the bow. Same light: one orange sodium lamp overhead, black
> water beyond. The man: forties, short beard streaked grey, yellow oilskin
> with the hood down, black rubber boots, still braced at the cleat, facing
> the boat. Camera low, in front of him.
>
> Sound: wind, the rope creaking, the two shouts, the wave's impact, water
> draining through the planks, his coughing. No music, no subtitles.

Note what happened to the brief: "slow motion, dramatic music, 8k" became real
speed, no music, no subtitles; "fights giant wave" became one wave that builds
in shot 1 and breaks in shot 4; the premise is carried by two short lines, the
first from off-frame so only one face ever has to sync.

Her other showcase clips (`docs/FRONT_PAGE_CLIPS.md`) follow the identical
shape: 15 s, 4–5 shots, premise legible by shot two, one insert to end on,
every block with a lock line.

---

## 3. The eight rules (each a repair for a rendered fault)

She rendered the same banquet scene three times on 2026-09-26/27 and each take
produced faults that became rules. Her model of the reader: "A video model is
a crew that has never met you, cannot ask a question, and takes every word at
face value. It renders idioms as pictures, does the first action it
understands and drops the rest, forgets the light and the blocking between
cuts, and cannot move the camera unless told to."

1. **Literal, always; and never lifeless.** "Write what a camera would record,
   never what a novelist would say." "His face fell" rendered as a face
   turning grey. But a bare list of muscles ("mouth corners down") read as a
   sulk. The middle: "name the feeling in a plain word the model knows, then
   give one physical anchor": *embarrassed, the polite smile fades and he
   swallows.* "Colour is material, never mood: 'warm tungsten from the ceiling
   lamp', not 'warm atmosphere'."
2. **One action per shot, and the others keep living.** Four actions in one
   shot became one. But "hold" told to a room froze the guests "mid-toast like
   mannequins". Write idle business for everyone else; only objects are still.
3. **The lock line, in every shot.** Warm lamplight went blue two cuts later;
   a woman delivered her line from a doorway she had already left because her
   position was never restated. Reactions are reverse angles: "the camera
   stands where the thing the character reacts to is, so his eyes go past the
   lens toward it. The eye-line has to be written."
4. **Prop mechanics, not verbs.** "'Pours', 'flips', 'hands over' are
   outcomes. Write the hand: which hand holds what, by which part, the tilt,
   where the material goes, where the object ends." A teacup was emptied like
   a bottle. "Anything a human hand does in one continuous motion of under two
   seconds is safe; anything with two grips or a mid-air change of orientation
   is split into its own shot."
5. **The frame can only hold what the shot contains.** "A two-shot cannot end
   on an insert of a cup." Write the move that gets there, or the next shot.
   Every crossing of a room is on screen; cutting from the door to a hand at
   the table "reads as teleportation."
6. **Secondary people are alive, and furniture until directed.** Groups
   described once with one line of idle business that continues in every shot.
7. **Direct the delivery, not the absence of it.** "Flat" as the only
   direction renders a dead face. "Direct the voice and the eyes: quiet but
   every word clear; her eyes stay on him; after the line her eyes redden but
   no tears come. Say what the face does after the last word."
8. **The check before delivery.** Per shot: one action? idle business? feeling
   + anchor? lock line repeats light, identity, position, facing, camera side?
   reaction is a reverse? every crossing on screen? ending inside the frame?
   props as hands? lines given voice and eyes?

Two more physical rules from the same takes: never write an involuntary
outcome as the endpoint (a coat caught in a door, a slip, a spill) because "the
model stages it as a deliberate act"; and keep spectacle where the model
renders well ("weather, light, cloth, dust, water, fire and crowds at a
distance") while keeping body-to-body contact "simple and singular."

Trap phrases her linter fails a block on: *his/her face fell, the smile goes,
a look that could, like someone, as if, his/her face darkens, the air freezes,
time stands still, nothing else in the frame moves, stay still for the whole
shot, does not move, nobody moves.*

---

## 4. Emotion and interiority in prose

"Seedance renders observable behavior, not internal states. 'She is sad,' 'he
feels betrayed,' and 'tense atmosphere' are not directable - they have no
pixels." "Replace the feeling with the one true gesture that proves it: not
'grief' but 'she folds the letter, presses it flat with both hands, and does
not look up.'" "Play an action, not a mood: wants to be believed, is not
believed, so she steadies her voice and meets his eyes." "Subtext through
contradiction: agreeing while stepping back, smiling while gripping the cup."

Her allowed form is a plain feeling word *as a label on an anchor*
("embarrassed, the polite smile fades"). Banned is the feeling standing alone,
as an idiom, or as a simile.

---

## 5. Dialogue

- Lines quoted verbatim with the speaker named; language and register
  preserved.
- **One speaker on screen per shot.** Two speakers "are fine when each speaks
  alone in their own shot, with short lines." Her trick: put the second voice
  off frame so only one face has to sync.
- Turn order = shot order. The reaction shot (half a beat) "is where the
  audience is told how to feel."
- Lip-sync stabilisers: locked medium close-up, short line, "no head turn
  during dialogue", no face-touching, "no music during the line."
- Delivery is voice + eyes + what the face does after the last word.
- Coverage template for a dramatic exchange: "the situation, the line that
  states it, the action, a reaction, the hold on whoever lost."

For this project (recorded actors, words never in the prompt) her rules
assemble to: speaker tag + locked framing + delivery/eyes/after-the-line
direction + `no music during the line`, and the words come from the audio
reference.

---

## 6. Reference images

- Tags are assigned by type and upload order: `@Image1`–`@Image9`. Never
  bracket, translate, renumber or respace a tag; a mistyped tag "silently fails
  to bind."
- **Every tag is written with its job, never alone.** "`@Image1 is Steve`" is
  not enough. Canonical clause: `[Tag] controls [role] only; ignore
  [identity/environment/logo/audio/camera/motion] from that reference.`
- One primary role per asset, one owner per dimension. "Drop any asset that
  ends up owning nothing." Official recommendation is 4–5 assets even though
  the cap is 9.
- "Prompt only what the image cannot show." Re-describing what the reference
  already shows spends budget and, "where the words disagree with the pixels,
  the prose becomes a drift instruction."
- Identity is re-anchored from canonical artwork every few clips, never from
  a previous output. "Video for motion, images for identity."
- Golden example: `@Image1 controls the original character identity and
  wardrobe. @Video1 controls camera rhythm only; ignore its performer, room,
  logo, and costume. The character walks toward the doorway in three steady
  steps as the camera matches the reference rhythm and stops when her hand
  reaches the handle.`

---

## 7. Anti-slop and length

She does not present a banned-word list ("review cues, not automatic deletion
rules"). Six classes: empty evaluators (*cinematic, epic, stunning*), borrowed
image-model tokens (*8K, masterpiece, Unreal Engine*), tag salad, negation
slop (*no blur, no artifacts*), adjective stacking, feel-suffix words
(*vibey*). Each hides a decision: "cinematic" → clarify framing, pacing or
light; "dramatic" → "do not automatically add shadows, silence or camera
pressure"; "8K" → a delivery parameter, not prompt text.

Weak → strong: *make it move naturally* → *shoulders rise once with breathing,
hand releases the cup, final pose holds for one second*; *she feels nervous* →
*Character A inhales, grips the cup tighter, then sets it down without looking
away*.

Length: official ceiling ≤1000 English words, "never paste a full script."
Her single clips run 40–110 words; her 15 s five-shot storyboards run 350–400
words because every block carries a full lock line. Compression cuts "duplicate
style adjectives, generic quality words, background details visible in
references, secondary camera moves, secondary actions, and speculative
emotional labels." It "never removes a lock line, a stated position or a
feeling word."

---

## 8. Retakes

"Name the failed criterion and the evidence: a timestamp, frame, audible
error." "The same failure in two or three takes does not prove that the prompt
is wrong." Change one variable per retry. Six verdicts: keep, fix in post,
edit, re-roll, rewrite, stop. "Recommend one primary repair variable rather
than adding more adjectives." If lines garbled or a shot dropped: split into
two generations, don't reroll the same count. If the geometry is wrong again on
the next take: "the prompt was written as prose and checked only against the
last render. Build the shot table first."

---

## 9. Where our Prompts tab generator diverges

Against the original one-pass Prompts-tab generator (`src/web/videoPromptGenerate.js`, since replaced by the scene → cut planner in `src/web/cutPlanner.js`, which implements the method below):

1. **We emit bracketed camera tags and a time budget.** She writes the cut in
   words inside the block and forbids seconds in shot blocks on 2.0. On 2.5
   integer timestamps are honoured, so this is a model question, but the
   bracket form is not what she uses anywhere.
2. **We have no lock line.** This is her single strongest rendered finding.
   Each shot block must end with light + each principal's identity + position
   relative to a landmark + facing + camera side, in the same words.
3. **We have no director's read.** We hand the model the beat and ask for
   prompts. She extracts turn, suppressed behavior, non-transferable detail
   and refused stock solution first, and the prompt is rendered from those
   carriers. Our `directorial_voice` maps to her voice; our scene bible maps to
   her floor plan; `characters_in_scene` / `sets_in_scene` map to her "In
   frame" column.
4. **We say "one to four shots" by feel.** She derives it from the load score.
   `S = duration ÷ (beats + load)` with Safe ≥ 3 replaces our 2.5 words/s
   heuristic for deciding how many shots fit.
5. **Our handles say who, not what they control.** Bind with a role and a
   do-not-transfer clause: `@Image1 controls Sarah's identity and wardrobe
   only; do not take the room or the light from it.`
6. **We allow "furious", "nervous" etc.** Lint for trap phrases and for
   feeling words standing alone; require feeling + one anchor.
7. **We have no idle-business rule** for the second person in a two-shot, and
   no reverse-angle rule for reactions.
8. **No `Sound:` line, no `no music during the line`, no named last frame.**

### Worked conversion, her way

Beat prose: *Sarah waits in the diner booth. Tom comes in late, soaked. She's
furious but says nothing; he sits, tries to explain, she leaves.*

Director's read (internal): turn = "waiting for him to arrive, to leaving
before he finishes"; POV = hers; power shift = "he arrives apologetic and
loses the table"; hidden want = to be given a reason not to go; obstacle /
tactic = his explanation, met by not looking at him; subtext = she stays
seated while already leaving; suppressed behavior = "she pushes the full cup
one inch toward him instead of answering"; non-transferable detail = the cup
she never drank; stock refused = no shouted line, no tears, no music.

Floor plan: a night diner, the door at the far end, the counter along the
right wall, her window booth on the left near the camera. Sarah in the booth
facing the door. Sodium light through the window, warm ceiling tubes inside.
Axis: the booth to the door.

> Shot 1. Wide shot from the counter end of the diner, looking down the aisle
> to the door: Sarah sits alone in the window booth on the left, both hands
> around a full cup, facing the door; a waitress behind the counter wipes the
> same patch of steel and glances at the clock. Rain streaks the window. The
> door opens and Tom steps in dripping, coat dark with rain, and stops when he
> sees her. Light: warm ceiling tubes inside, orange sodium light through the
> window. Sarah: thirties, dark hair tied back, grey wool coat, seated in the
> window booth, facing the door. Tom: thirties, short beard, black raincoat,
> just inside the door, facing the booth. Camera at the counter end.
>
> Shot 2. Cut to a medium shot from the aisle: Tom walks down the aisle and
> slides into the booth opposite her, water running off his sleeve onto the
> table, and leans in with both hands open on the table, already talking,
> quiet and fast. The waitress keeps wiping. Same light: warm ceiling tubes
> inside, orange sodium light through the window. Sarah: grey wool coat,
> seated in the window booth, facing the door. Tom: black raincoat, seated
> opposite her, facing her. Camera in the aisle.
>
> Shot 3. Cut to a close shot of Sarah from Tom's side of the table, his
> shoulder soft in the foreground. Hurt and holding it, her eyes stay on the
> window, not on him; her thumb presses white against the cup; she pushes the
> full cup one inch toward him and lets go. Same light: orange sodium light
> on her face through the window, warm tubes behind. Sarah: thirties, dark
> hair tied back, grey wool coat, seated in the window booth, facing the
> window. Camera on Tom's side of the table.
>
> Shot 4. Cut to a close shot of Tom from Sarah's side of the table. His
> hands stop mid-gesture; caught out, he closes his mouth, swallows, and his
> eyes drop to the cup. Same light: warm ceiling tubes on his face, sodium
> light from the window on his wet hair. Tom: thirties, short beard, black
> raincoat, seated in the booth, facing her. Camera on Sarah's side.
>
> Shot 5. Cut to the wide shot from the counter end, same framing as shot
> one: Sarah slides out of the booth, pulls her coat closed, and walks down
> the aisle to the door without turning her head; the door swings shut behind
> her. Tom stays in the booth with the full cup in front of him. Hold on the
> cup and the empty seat as the waitress goes back to wiping. Same light:
> warm ceiling tubes inside, orange sodium light through the window. Tom:
> black raincoat, seated in the window booth, facing the empty seat. Camera at
> the counter end.
>
> Sound: rain on the glass, the door bell, his voice low and fast under shot
> two then stopping; no music, no subtitles.

Load: 5 beats, one line (1), one held second person in shots 2 and 3 (1),
no moves (cuts are free), S = 15 ÷ 7 ≈ 2.1, Stretch. Safe version drops shot 4
and holds Tom's reaction inside shot 3's framing. With recorded dialogue in
our pipeline, Tom's "already talking" becomes a speaker tag on an `@Audio`
reference and the words never appear.
