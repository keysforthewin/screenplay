// src/web/cutRules.js
// The prose-to-prompt method the Prompts tab's scene/cut planner follows,
// adapted from Emily's seedance-2.0 research (docs/video-prompting-notes.md,
// https://github.com/Emily2040/seedance-2.0 — see ATTRIBUTION.md). Every
// block is ready-to-embed text for a system prompt. The one project rule that
// overrides hers everywhere: dialogue WORDS never enter a prompt — real
// actors are recorded and lip-synced in post — so her "quote the line"
// rules become speaker tag + delivery direction.
//
// Companion pure modules: cutLoad.js (the load score) and cutPromptLint.js
// (the checks). promptConstraints.js still owns the image-model rules
// the start-frame pass embeds (STILL_FRAMING_RULES, CAMERA_COHERENCE_RULES,
// NO_TEXT_RULES, CONTINUITY_STATE_RULES, OCCUPANT_PLACEHOLDER_RULES).

export const DIRECTORS_READ_RULES = [
  "Director's read — before any drafting, reduce the scene to these ten fields. Do not leave blanks and do not substitute a generic mood word. The read is an internal brief and handoff object; it is never final generation prose.",
  '- dramatic_function: what the scene earns — introduce, deepen, turn, test, reveal, decide, pay off.',
  '- turn: the single before-to-after value change visible in the scene (waiting for him → leaving before he finishes).',
  '- pov: whose experience organizes what the viewer sees, hears and learns.',
  '- power_shift: who controls the scene at the start, who at the end, and what changes it.',
  '- hidden_want: what the focal subject is trying to get, protect, avoid, prove or conceal.',
  '- obstacle_tactic: what blocks the want, then the playable action used against it.',
  '- subtext: the gap between the stated surface and the underlying action.',
  '- suppressed_behavior: one small filmable action that shows an impulse being contained, redirected or leaked ("her finger hovers over replay, then she straightens the brass key tag instead").',
  '- non_transferable_detail: one object, ritual, sound or location fact another generic story could not inherit unchanged.',
  '- stock_solution_refused: the genre\'s easiest default this scene will not use ("no tearful close-up and score swell for grief"), paired with what replaces it.',
  'Then collapse the read to ONE intention sentence — what the scene must do to the audience ("make the audience feel her certainty crack") — and set every instrument to it: shot size, angle, lens, movement, light, blocking, performance, sound, cut.',
].join('\n');

export const CARRIER_TABLE_RULES = [
  'The carrier table is the actual prose-to-prompt conversion. The compiled cut never NAMES the hidden want, subtext, power shift or emotion; the camera, the interrupted task, the withheld reach, the exact prop, the sound and the endpoint carry them:',
  '- pov → shot position, information withheld or revealed, eyeline, sound perspective.',
  '- power_shift → height, frame share, distance, who moves first, who yields space.',
  '- hidden_want → a task, prop action, approach, retreat, delay or repeated attempt.',
  '- obstacle_tactic → visible interference followed by one playable response.',
  '- subtext → words against body, smile against grip, agreement against retreat.',
  '- suppressed_behavior → one timed gesture the camera can hold long enough to read.',
  '- turn → a legible before/after state and a camera endpoint.',
  '- non_transferable_detail → the exact object, ritual or sound preserved in the shot.',
  '- stock_solution_refused → a physical exclusion only when needed, paired with the replacement.',
].join('\n');

export const STARTING_STACKS_RULES = [
  'Starting stacks by scene type (adjust to the directorial voice, never to a default):',
  '- intimate dialogue: medium close-up, eye level, longer lens, minimal motion, soft motivated key, sparse sound.',
  '- confrontation: opposed angles, height encodes status, light splits warm/cool, blocking closes distance.',
  '- decision: push-in to isolate the chooser; the world quiets; one gesture commits the choice.',
  'Allocation: identity fidelity, motion boldness and scene density compete for the same generation budget. Name the one thing each cut is FOR (primary_spend), pick one secondary, and economize everything else on purpose. Bold motion and a close-up face: choose one.',
].join('\n');

export const SCOPE_RULES = [
  'Scope — one cut normally carries ONE visible beat with a changed endpoint: before state → visible action → changed final state. Bucket the story around the scene as already_happened / this_scene_only / reserved_for_later / do_not_show_yet. Story context must never make a cut perform future events, reveal future information, solve later problems, or skip physical handoff states.',
  'Density: too much duration for too little content and the model improvises; too little duration for several actions and the content garbles. The remedy is always to split into another cut, never to cram.',
].join('\n');

export const FLOOR_PLAN_RULES = [
  'Floor plan — three or four sentences a stranger could draw from: the landmarks (door, table, counter, window), who is where at the start and facing what, and the light source with its colour. Name the axis (the line the scene plays across, e.g. "the booth to the door"). Every position in every cut is stated relative to these landmarks, never relative to the previous cut.',
].join('\n');

export const SHOT_TABLE_RULES = [
  'Shot table — one row per cut, every column filled. Each column has a default the video model silently uses when the cell is blank, and every one of those defaults is a fault:',
  '- camera (blank → "the head of the table facing the lens"): which side of the room, relative to a named landmark, the size, the angle, the height, the lens and at most ONE move with its motivation. A cut is free; a move within a cut costs load.',
  '- in_frame (blank → "people placed where the model last saw them"): each principal, where they stand or sit relative to a landmark, which way they face.',
  '- eyeline (blank → "eyes to the lens, at nothing"): for a reaction, the camera stands where the thing reacted to is, so the eyes go past the lens toward it. Reactions are reverse angles; write the eyeline.',
  '- action (blank → "the first verb understood; the rest dropped"): the ONE action. A reaction = a plain feeling word + one physical anchor. A prop = which hand holds what, by which part, the tilt, where the material goes, where the object ends. A covered line = the speaker + voice + eyes + what the face does after the last word (never the words).',
  '- others (blank → "a freeze, or invention"): one line of idle business for everyone else in frame. Only objects are still.',
  '- light (blank → "drift, warm to blue"): the source and its colour, in the same words as the floor plan.',
  '- last_frame (blank → "an ending the shot cannot see"): what the frame holds when the cut ends; it must be visible from the camera cell. A two-shot cannot end on an insert of a cup.',
  '- A crossing between landmarks gets its own row: a cut from the door to a hand at the table is a teleport. Every crossing of a room is on screen.',
  '- Anything a hand does in one continuous motion under two seconds is one cut; anything with two grips or a mid-air change of orientation is split into its own cut.',
  'Paper render: before returning, read the table as a crew that never met you, cannot ask a question and takes every word at face value. Any "unstated" or "presumably" is a fault found for free — fix it in the table.',
].join('\n');

export const BLOCK_FORM_RULES = [
  'Block form — bare present-tense prose. No brackets, no timestamps, no JSON, no style tags, no shot numbers inside the block. Each cut is compiled from its table row in this order:',
  '1. The camera IN WORDS with the side of the room: size, side relative to a landmark, height, lens, and the one move with its motivation — or that the camera holds. ("Medium shot from the aisle at deck height, 50mm, the camera holding:")',
  '2. ONE action by ONE person, expression written as feeling + anchor; props as hand mechanics; a covered line as speaker + voice + eyes + the face after the last word.',
  '3. The position or space change, then the idle business of everyone else in frame.',
  '4. Sound: the cues that must land in this cut, as a "Sound:" clause; "no music during the line" whenever a line is covered.',
  '5. The lock line (see the lock line rules), in the same words every cut of the scene.',
  '6. The ending, always inside the frame the camera can see: "End with …", "Stop when …", "Hold on this frame as …". Never "fade out". Never an involuntary outcome (a coat caught in a door, a slip, a spill) — the model stages it as a deliberate act. The ending is the picture the cut\'s END FRAME will show: when the camera moves, say where it stops ("the tilt settles on the marquee"), so the block reads as the path from the opening picture to that one.',
  'No seconds inside a block: felt length is written as behaviour ("hold on the settled fan for one beat"), never "hold 2 s". Duration is a parameter. One camera move per cut; a locked camera is written in prose.',
  'Negatives, exactly two kinds and nowhere else: a reference non-transfer clause immediately after a binding (kept in reference_binding, not in the block), and a clip-scope exclusion at the very end ("Do not show the vehicle departing yet."), plus the three standing ones (no subtitles, no logo, no watermark). Everything else is stated as the positive state that IS there. Never a generic negative dump.',
  'Length: 60–140 words per cut. Compression removes duplicate style adjectives, generic quality words, background detail the references already show, secondary camera moves, secondary actions and speculative emotional labels. It never removes a lock line, a stated position, or a feeling word.',
].join('\n');

export const LOCK_LINE_RULES = [
  'The lock line is the price of a cut — write it even when it feels redundant, because redundancy is how continuity is bought. The model keeps nothing across a cut that the prompt does not repeat, and that includes blocking. Every cut ends its body with, in the SAME WORDS every time:',
  '- the light source and its colour ("Same light: one warm tungsten lamp overhead, black water beyond.");',
  '- for each principal on screen: age band, hair, wardrobe and any distinguishing object, then where they are relative to a fixed landmark and which way they face ("Tom: thirties, short beard, black raincoat, seated opposite her in the window booth, facing her.");',
  '- the camera\'s side ("Camera on the counter side.").',
  'Template: "Same light: <source + colour>. <Name>: <age band>, <hair>, <wardrobe>, <object>, <position relative to landmark>, facing <what>. Camera <side>."',
].join('\n');

export const EIGHT_RULES = [
  'The eight rules — each is a repair for a fault that rendered. The reader is a crew that has never met you, cannot ask a question and takes every word at face value: it renders idioms as pictures, does the first action it understands and drops the rest, forgets the light and the blocking between cuts, and cannot move the camera unless told to.',
  '1. Literal, always; and never lifeless. Write what a camera would record, never what a novelist would say. "His face fell" renders as a face turning grey; a bare list of muscles reads as a sulk. Name the feeling in a plain word the model knows, then give ONE physical anchor: "embarrassed, the polite smile fades and he swallows." Colour is material, never mood: "warm tungsten from the ceiling lamp", not "warm atmosphere".',
  '2. One action per cut, and the others keep living. Four actions in one cut become one. But "hold" told to a room freezes the guests like mannequins: write idle business for everyone else; only objects are still.',
  '3. The lock line, in every cut. Warm lamplight went blue two cuts later; a woman delivered her line from a doorway she had already left because her position was never restated.',
  '4. Prop mechanics, not verbs. "Pours", "flips", "hands over" are outcomes. Write the hand: which hand holds what, by which part, the tilt, where the material goes, where the object ends.',
  '5. The frame can only hold what the cut contains. Write the move that gets there, or the next cut. Cutting from the door to a hand at the table reads as teleportation.',
  '6. Secondary people are alive, and furniture until directed. Groups are described once with one line of idle business that continues in every cut.',
  '7. Direct the delivery, not the absence of it. "Flat" as the only direction renders a dead face. Direct the voice and the eyes: quiet but every word clear; her eyes stay on him; after the line her eyes redden but no tears come. Say what the face does after the last word.',
  '8. The check before delivery, per cut: one action? idle business? feeling + anchor? lock line repeats light, identity, position, facing, camera side? reaction is a reverse? every crossing on screen? ending inside the frame? props as hands? lines given voice and eyes?',
  'Spectacle stays where the model renders well — weather, light, cloth, dust, water, fire and crowds at a distance — and body-to-body contact stays simple and singular.',
  'Trap phrases, never write them: his/her face fell, the smile goes, a look that could, like someone, as if, his/her face darkens, the air freezes, time stands still, nothing else in the frame moves, stay still for the whole shot, does not move, nobody moves.',
].join('\n');

export const FEELING_RULES = [
  'Emotion and interiority — the model renders observable behaviour, not internal states. "She is sad", "he feels betrayed" and "tense atmosphere" are not directable; they have no pixels. Replace the feeling with the one true gesture that proves it: not "grief" but "she folds the letter, presses it flat with both hands, and does not look up." Play an action, not a mood: wants to be believed, is not believed, so she steadies her voice and meets his eyes. Subtext through contradiction: agreeing while stepping back, smiling while gripping the cup. The only allowed form of a feeling word is as a LABEL on an anchor ("embarrassed, the polite smile fades"); a feeling standing alone, as an idiom or as a simile is banned.',
].join('\n');

export const CUT_DIALOGUE_RULES = [
  'Dialogue — the numbered lines in the context are recorded by real actors and lip-synced into the cut that covers them. The WORDS never appear in any prompt; a covered line is written as: the speaker, the voice ("quiet and fast", "every word clear"), the eyes ("her eyes stay on him"), and what the face does after the last word. Then "no music during the line".',
  '- One speaker on screen per cut. Two speakers are fine when each speaks alone in their own cut. The trick for a second voice: put it OFF frame ("from the dark behind the camera a voice shouts") so only one face ever has to sync.',
  '- Turn order = cut order. A reaction cut (half a beat) is where the audience is told how to feel: coverage for a dramatic exchange is the situation, the line that states it, the action, a reaction, the hold on whoever lost.',
  '- Lip-sync stabilisers for a covering cut: locked medium close-up or close-up, a short line, no head turn during the line, no face-touching, no music during the line.',
  '- Every line goes to exactly one cut, in script order, contiguous within a cut; the covering cut frames the speaker with the mouth visible (front or three-quarter front, never from behind, never an insert of hands). A line marked with a recorded length is fixed in time: plan the cut around it.',
].join('\n');

export const REFERENCE_BINDING_RULES = [
  'Reference images (for reference-to-video models only; a start frame carries identity on its own):',
  '- Tags are assigned by upload order: @Image1..@Image9. Never bracket, translate, renumber or respace a tag.',
  '- Every tag is written WITH ITS JOB, never alone. "@Image1 is Steve" is not enough. Canonical clause: "@Image1 controls Sarah\'s identity and wardrobe only; ignore the room and the light from it." "@Image2 controls the diner interior only; ignore any figures in it."',
  '- One primary role per asset, one owner per dimension (identity, wardrobe, environment, light). Drop any asset that ends up owning nothing. Four or five assets is the recommendation even though the cap is nine.',
  '- Prompt only what the image cannot show. Re-describing what the reference already shows spends budget, and where the words disagree with the pixels the prose becomes a drift instruction.',
].join('\n');

export const CUT_ANTI_SLOP_RULES = [
  'Anti-slop — six classes, each hides a decision: empty evaluators (cinematic, epic, stunning), borrowed image-model tokens (8K, masterpiece, Unreal Engine), tag salad, negation slop (no blur, no artifacts), adjective stacking, feel-suffix words (vibey). "Cinematic" → clarify framing, pacing or light. "Dramatic" → do not automatically add shadows, silence or camera pressure. "8K" → a delivery parameter, not prompt text.',
  'Weak → strong: "make it move naturally" → "shoulders rise once with breathing, hand releases the cup, final pose holds for one beat". "She feels nervous" → "she inhales, grips the cup tighter, then sets it down without looking away".',
].join('\n');

export const START_FRAME_RULES = [
  'Start frame — the still an image model renders as the FIRST frame of this cut, at t=0, before anything in the block has happened. Derive it from the cut, not from the scene: the camera named first (size, side relative to a landmark, angle, height, lens, depth of field), every principal in frame as a FROZEN MOMENT of the action about to begin (pose, orientation, heading, hands and prop as the block will need them), each placed exactly where the table row puts them with one positive anchoring cue that fixes the sub-location, the light source and its colour as the lock line states it, and the continuity state the story has left them in.',
  '- Refer to people by a short VISUAL HANDLE (actor likeness, or the described look), never by a proper name; the reference artwork carries faces and wardrobe, so do not re-describe them — spend the words on placement, pose, lens and light.',
  '- Describe only what THIS camera can see from its stated side. A back to the camera has no face.',
  '- The frame is the whole composition: no camera arriving, no motion trails, no cut-to. Idle business is caught mid-gesture, not described as movement.',
  '- Text is composited in post: every sign, screen, page and label is a blank, unlettered surface.',
  '- When the set is in view, name its construction in a clause or two taken from the set description — massing, materials, colours, the signature features this camera sees ("the curved tan stucco front, gray-blue pylon towers, a glass entrance bay under a bulb-edged marquee"). The set artwork is only a look reference that the image model rebuilds from THIS camera, so the words carry the building from angle to angle; use the same words in every cut that sees the same part of the set.',
  '- 80–140 words. Plain present tense. No feeling words at all — the still shows a body, not a mood.',
].join('\n');

export const END_FRAME_RULES = [
  'End frame — the still an image model renders as the LAST frame of this cut, the picture the clip must land on. A first-last-frame video model interpolates between the start frame and this one, so the end frame is what keeps a moving camera anchored to the real place: without it a tilt down from the sky invents whatever building it finds.',
  '- The camera named first, WHERE IT STOPS: after a pan, tilt, push or crane, describe the final heading, height and size, never the starting one. When the camera holds, the framing is exactly the start frame\'s and only the subjects have changed.',
  '- Every principal frozen in the state the cut\'s last_frame cell and the block\'s ending describe — pose, orientation, hands and prop as they are when the action has finished — each placed relative to a landmark. Nothing mid-move, no motion trails.',
  '- The same light, the same visual handles and the same construction clause for the set as the start frame, word for word where they still apply: the two stills must read as the same place and the same people a few seconds apart.',
  '- Describe only what this camera sees at the end. A part of the set that only comes into view during the move is described here, from the set description.',
  '- Text is composited in post: every sign, screen, page and label is a blank, unlettered surface.',
  '- 80–140 words. Plain present tense. No feeling words at all.',
].join('\n');

// Emily's diner conversion (notes §9), rewritten to this project's form: the
// spoken words are replaced by speaker + delivery, and each block carries a
// lock line and an ending. Used as the one worked exemplar in the prose
// system prompt so the model sees the target shape rather than a description.
export const EXEMPLAR_SCENE = [
  'Worked example. Beat prose: "Sarah waits in the diner booth. Tom comes in late, soaked. She\'s furious but says nothing; he sits, tries to explain, she leaves."',
  '',
  'Read: turn = waiting for him to arrive → leaving before he finishes; pov = hers; power_shift = he arrives apologetic and loses the table; hidden_want = to be given a reason not to go; obstacle_tactic = his explanation, met by not looking at him; subtext = she stays seated while already leaving; suppressed_behavior = she pushes the full cup one inch toward him instead of answering; non_transferable_detail = the cup she never drank; stock_solution_refused = no shouted line, no tears, no music.',
  '',
  'Floor plan: a night diner. The door at the far end, the counter along the right wall, her window booth on the left near the camera. Sarah in the booth facing the door. Orange sodium light through the window, warm ceiling tubes inside. Axis: the booth to the door.',
  '',
  'Cut 1. Wide shot from the counter end of the diner, looking down the aisle to the door, eye level, 24mm, the camera holding: Sarah sits alone in the window booth on the left, both hands around a full cup, facing the door; a waitress behind the counter wipes the same patch of steel and glances at the clock. Rain streaks the window. The door opens and Tom steps in dripping, coat dark with rain, and stops when he sees her. Sound: rain on the glass, the door bell. Light: warm ceiling tubes inside, orange sodium light through the window. Sarah: thirties, dark hair tied back, grey wool coat, seated in the window booth, facing the door. Tom: thirties, short beard, black raincoat, just inside the door, facing the booth. Camera at the counter end. End with Tom still in the doorway, the door swinging shut behind him.',
  '',
  'Cut 2. Medium shot from the aisle at seated height, 50mm, the camera holding: Tom walks down the aisle and slides into the booth opposite her, water running off his sleeve onto the table, and leans in with both hands open on the table, already speaking — quiet and fast, his eyes on her face; after the last word his hands stay open. The waitress keeps wiping. Sound: his voice low and fast, rain on the glass; no music during the line. Same light: warm ceiling tubes inside, orange sodium light through the window. Sarah: grey wool coat, seated in the window booth, facing the door. Tom: black raincoat, seated opposite her, facing her. Camera in the aisle. End with his hands open on the table between them.',
  '',
  'Cut 3. Close shot of Sarah from Tom\'s side of the table, his shoulder soft in the foreground, eye level, 85mm, the camera holding: hurt and holding it, her eyes stay on the window, not on him; her thumb presses white against the cup; she pushes the full cup one inch toward him and lets go. Sound: the cup sliding on the table, rain. Same light: orange sodium light on her face through the window, warm tubes behind. Sarah: thirties, dark hair tied back, grey wool coat, seated in the window booth, facing the window. Camera on Tom\'s side of the table. Stop when her hand leaves the cup.',
  '',
  'Cut 4. Close shot of Tom from Sarah\'s side of the table, eye level, 85mm, the camera holding: his hands stop mid-gesture; caught out, he closes his mouth, swallows, and his eyes drop to the cup. Sound: rain, the waitress\'s cloth on steel. Same light: warm ceiling tubes on his face, sodium light from the window on his wet hair. Tom: thirties, short beard, black raincoat, seated in the booth, facing her. Camera on Sarah\'s side. Hold on this frame as his eyes settle on the cup.',
  '',
  'Cut 5. Wide shot from the counter end, the same framing as cut one, the camera holding: Sarah slides out of the booth, pulls her coat closed, and walks down the aisle to the door without turning her head; the door swings shut behind her. Tom stays in the booth with the full cup in front of him. The waitress goes back to wiping. Sound: her steps on the tile, the door bell, rain. Same light: warm ceiling tubes inside, orange sodium light through the window. Tom: black raincoat, seated in the window booth, facing the empty seat. Camera at the counter end. Hold on the cup and the empty seat as the waitress wipes. Do not show the street outside yet.',
  '',
  'Load: 5 beats, one line (1), one held second person in cuts 2 and 3 (1), no moves; 15 s ÷ 7 ≈ 2.1, Stretch. The safe version drops cut 4 and holds Tom\'s reaction inside cut 3\'s framing.',
].join('\n');
