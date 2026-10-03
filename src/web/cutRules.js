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
  '- action (blank → "the first verb understood; the rest dropped"): the ONE action. A reaction = a plain feeling word + one physical anchor. A prop = which hand holds what, by which part, the tilt, where the material goes, where the object ends. A covered line = the speaker + voice + eyes + what the face does after the last word (never the words). An accident = where the attention is + the grip going slack + the object leaving on its own + where it lands (see the accident rules).',
  '- others (blank → "a freeze, or invention"): one line of idle business for everyone else in frame. Only objects are still.',
  '- light (blank → "drift, warm to blue"): the source and its colour, in the same words as the floor plan.',
  '- last_frame (blank → "an ending the shot cannot see"): what the frame holds when the cut ends; it must be visible from the camera cell. A two-shot cannot end on an insert of a cup.',
  '- A crossing between landmarks gets its own row: a cut from the door to a hand at the table is a teleport. Every crossing of a room is on screen.',
  '- Anything a hand does in one continuous motion under two seconds is one cut; anything with two grips or a mid-air change of orientation is split into its own cut.',
  'Paper render: before returning, read the table as a crew that never met you, cannot ask a question and takes every word at face value. Any "unstated" or "presumably" is a fault found for free — fix it in the table.',
].join('\n');

export const BLOCK_FORM_RULES = [
  'Block form — bare present-tense prose. No brackets, no timestamps, no JSON, no style tags, no shot numbers inside the block. Each cut is compiled from its table row in this order:',
  '1. The camera IN WORDS with the side of the room: size, side relative to a landmark, height, lens, and the one move with its motivation, its travel and its one even speed — or that the camera holds. ("Medium shot from the aisle at deck height, 50mm, the camera holding:" / "Wide shot from the lobby doors at eye level, 24mm, the camera already panning right at one slow, even speed from the box office toward the concession counter:")',
  '2. ONE action by ONE person, expression written as feeling + anchor; props as hand mechanics; a covered line as speaker + voice + eyes + the face after the last word.',
  '3. The position or space change, then the idle business of everyone else in frame.',
  '4. Sound: the cues that must land in this cut, as a "Sound:" clause; "no music during the line" whenever a line is covered.',
  '5. The lock line (see the lock line rules), in the same words every cut of the scene.',
  '6. The ending, always inside the frame the camera can see: "End with …", "Stop when …", "Hold on this frame as …". Never "fade out". The ending is the picture the cut\'s END FRAME will show, so the block reads as the path from the opening picture to that one. When the camera moves, name the framing the move has REACHED at the last frame and keep it travelling ("End with the marquee filling the frame, the tilt still moving at the same slow speed") — never "settles on", "comes to rest", "stops on": the model slows the whole move to obey them. An involuntary outcome (a drop, a slip, a spill, a coat caught in a door) is written only as an ACCIDENT by the accident rules, with its result in the last frame; as a bare verb the model stages it as a deliberate act.',
  'No seconds inside a block: felt length is written as behaviour ("hold on the settled fan for one beat"), never "hold 2 s". Duration is a parameter. One camera move per cut; a locked camera is written in prose.',
  'Negatives, exactly two kinds and nowhere else: a reference non-transfer clause immediately after a binding (kept in reference_binding, not in the block), and a clip-scope exclusion at the very end ("Do not show the vehicle departing yet."), plus the three standing ones (no subtitles, no logo, no watermark). Everything else is stated as the positive state that IS there. Never a generic negative dump.',
  'Length: 60–140 words per cut; a cut of 2 s or less is ONE motion already under way in the first frame and finished by the last, one clause of idle business at most, 40–80 words. Compression removes duplicate style adjectives, generic quality words, background detail the references already show, secondary camera moves, secondary actions and speculative emotional labels. It never removes a lock line, a stated position, or a feeling word.',
].join('\n');

export const LOCK_LINE_RULES = [
  'The lock line is the price of a cut — write it even when it feels redundant, because redundancy is how continuity is bought. The model keeps nothing across a cut that the prompt does not repeat, and that includes blocking. Every cut ends its body with, in the SAME WORDS every time:',
  '- the light source and its colour ("Same light: one warm tungsten lamp overhead, black water beyond.");',
  '- for each principal on screen: age band, hair, wardrobe and any distinguishing object, then where they are relative to a fixed landmark and which way they face ("Tom: thirties, short beard, black raincoat, seated opposite her in the window booth, facing her.");',
  '- the camera\'s side ("Camera on the counter side.").',
  'Template: "Same light: <source + colour>. <Name>: <age band>, <hair>, <wardrobe>, <object>, <position relative to landmark>, facing <what>. Camera <side>."',
  '- The <wardrobe> words are the character\'s LOCKED WARDROBE from the cast list, verbatim — never paraphrased, never a different garment, colour or fit; only a change the beat itself stages (jacket off, sleeve torn) is added to them. A character with no lock keeps whatever wardrobe the first cut of the scene gave them, in the same words thereafter.',
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

// How long a cut runs. The planner model chooses it (plan_cuts returns
// duration_seconds per row); cutLoad.js only supplies the speech floor and the
// fallback. Written after a 4-second popcorn handover and a 4-second pan
// across a whole lobby rendered in the same montage.
export const TEMPO_RULES = [
  'Tempo — the length of a cut is the editor\'s choice, not arithmetic: how long the audience needs to READ what the cut is for, and not a frame longer. Every row carries duration_seconds (half-second steps), and the scene carries one tempo line saying how it cuts ("an opening montage on music: quick inserts between two slow wides; no cut holds after its action lands").',
  '- Connective actions are quick: a handover, a door, a ticket torn, a glance — 1 to 2 s. Lingering on filler is the fault: a bucket passed across a counter at 4 s plays as a ceremony.',
  '- A quick cut must be a LOW-LOAD cut or it cannot render at that length: an insert of the hands and the object, ONE motion already under way in the first frame, locked camera, nobody else acting. A two-shot handover with a camera move is not a 1.5 s cut — reframe it as the insert.',
  '- A reaction is 1.5 to 3 s: the look arrives, registers, and the cut leaves.',
  '- A cut that covers a line runs the line: never shorter than the speech (the recorded length when marked), plus a breath.',
  '- A moving camera takes travel ÷ speed (see the camera travel rules). Its length comes from how far the frame moves, never from a default: a 4 s pan across a whole lobby is a whip.',
  '- A hold is earned: only when the audience must read a face deciding, an object, or the picture the scene turns on — then 3 to 5 s.',
  '- A montage on music with no dialogue cuts on rhythm: a run of short cuts (1.5, 1.5, 2), then one longer cut to breathe. Equal lengths read as a slideshow. Read the lengths of the earlier scenes\' cuts when they are given and continue that rhythm.',
  '- No cut longer than 12 s. What needs longer is two cuts from two camera positions.',
].join('\n');

export const CAMERA_TRAVEL_RULES = [
  'Camera travel — a pan, tilt, truck, track or crane has a TRAVEL: how far the frame moves between the cut\'s first frame and its last. Write it in the camera cell from → to in landmarks ("from the box office at the left edge to the concession counter") and as a number of frame-widths (frame-heights for a tilt or crane). Speed = travel ÷ duration.',
  '- The directorial voice sets the speed. In a slow, patient voice a pan covers about ONE frame-width in 6 to 8 s; in a neutral voice, one in 4 to 5 s; faster than one in 3 s only when the voice asks for a whip.',
  '- A pan, tilt, sideways truck/track or crane SLIDES the picture, and its two stills must overlap: travel_widths is at most 0.5, so at least half of the first frame is still in view in the last. The end still is made by sliding the start still and painting only what comes into view; two stills that share nothing give the image model no anchor (it rebuilds the place from another side) and the video model nothing to travel through. Half a frame-width is a full, slow move: 4 s at the slow voice\'s speed, 8 s for a drift. A reveal that needs more than half a frame is two cuts from two camera positions. Give such a move its travel_direction — the way the CAMERA goes (left, right, up, down); a move with no slide (a track forward, a push, a pull, a held camera) is "none".',
  '- When the sweep does not fit the cut, narrow the travel — the last frame sits closer to the first ("the pan covers the counter, not the whole lobby") — or cover the rest in another cut from another camera position. Never a fast sweep, and never one sweep chopped into two cuts: the join shows.',
  '- A moving camera moves at ONE even speed for the whole cut: already moving in the first frame, the same unhurried speed throughout, still moving in the last frame. It never eases in, slows, settles or comes to rest — the editor cuts while the camera is in motion.',
  '- The two stills are the two ends of the travel: the start frame is the framing at the first frame, the end frame is the framing the move has reached at the last. The space between them is simple and continuous.',
  '- static and handheld HOLD their framing: the frame does not travel. A handheld camera breathes in place — it never drifts to a new framing, follows a walker across the set or turns to find someone. If the frame must end somewhere other than where it began, the movement is a pan, truck or track with its travel, not handheld. (A held cut\'s end still is made by editing its start still, so a framing change on a held camera cannot be rendered.)',
  '- push_in and pull_out: the travel is the change of size ("from the wide of the row to a medium of the boy"), one size step in 5 to 8 s in a slow voice; travel_widths is 0.',
].join('\n');

// What the cut is FOR, and how an accident is staged. Written after "he
// forgets the popcorn in his hand and it falls" rendered as a boy picking the
// bucket up and shaking it empty: the block listed movements and lost the point.
export const INTENT_RULES = [
  'The point of the cut — every block states, in one plain clause the model can stage, what this cut is FOR: the row\'s felt intent turned into what the camera sees ("he has forgotten the bucket in his hand"). This is not naming the subtext: it is the visible fact the action proves, and its anchor follows it exactly as a feeling\'s does. A block that lists movements without their point is staged as choreography: "he lowers his hand and the popcorn pours out" renders as a boy emptying a bucket on purpose.',
  'Accidents — an accident is INATTENTION + PHYSICS, written in this order:',
  '- where the attention is, and that it stays there: "his eyes are fixed on the screen, mouth slightly open";',
  '- the grip going slack, small and unwatched: "his fingers loosen around the bucket";',
  '- the object leaving on its own — the object is the subject of the verb, never the person: "the bucket tips out of his hand and falls" (never "he drops the bucket", never "he tips it out");',
  '- where it lands, inside the frame: "it lands on its side on the carpet by his left shoe, popcorn spilling across the floor";',
  '- the attention unchanged afterwards: "his eyes stay on the screen; his empty hand hangs where the bucket was."',
  'The plain words "by accident", "forgotten" and "unnoticed" are allowed and wanted — they tell the model what kind of event this is. State everything positively: "his eyes stay on the screen", never a sentence about what he fails to do. The landing place is in frame from the first frame, and the END FRAME shows the object lying where it fell. An accident is the cut\'s one action.',
].join('\n');

// Both stills of a cut must already BE the cut: the image model never reads
// the block, so whatever the block means has to be in the still as bodies and
// geometry. (A "kid in a hurry pulling his parents toward the doors" came back
// as three people strolling past the building, his face to the lens.)
export const STILL_INTENT_RULES = [
  '- The still carries the cut\'s point. Read the block\'s point clause, the felt intent and the action, and write them into the bodies as mechanics a camera can see — never as feeling words. A hurry is a long stride with the rear heel off the ground, the torso pitched forward, the arms swinging, a jacket hem lifted by the pace; someone pulling the others along is a full step ahead with an adult\'s arm stretched forward to keep hold; an ordinary walk is none of these. If a stranger could not tell the point from the still alone, the still is wrong.',
  '- A person going TO a place is drawn going to it: say where the destination sits in the frame and that their feet, hips and chest point at it ("striding away from the lens toward the glass doors at centre-left, the canopy ahead of them"). Never a walker crossing the frame with the destination as a backdrop parallel to their path, unless the table row says they pass it.',
  '- The eyeline cell and every "Do not show …" sentence of the block bind the stills. State them as what the camera DOES see: "strict left profile, one eye, the far cheek hidden", "from behind, the back of his head and his shoulders, no face". A face the cut withholds is withheld in both stills, and nobody looks at the lens unless the row says so.',
  '- Everyone the others cell names is in the still, in the same state of hurry or idleness the cell gives them, placed relative to the principal.',
].join('\n');

export const START_FRAME_RULES = [
  'Start frame — the still an image model renders as the FIRST frame of this cut, at t=0, before anything in the block has happened. Derive it from the cut, not from the scene: the camera named first (size, side relative to a landmark, angle, height, lens, depth of field), every principal in frame as a FROZEN MOMENT of the action about to begin (pose, orientation, heading, hands and prop as the block will need them), each placed exactly where the table row puts them with one positive anchoring cue that fixes the sub-location, the light source and its colour as the lock line states it, and the continuity state the story has left them in.',
  '- Refer to people by a short VISUAL HANDLE that names their wardrobe in a few words from the lock line ("the boy in the red windbreaker") — the LOCKED WARDROBE words from the cast list when the character has one — never by a proper name, and use the same handle in both stills of the cut; the reference artwork carries the face — spend the other words on placement, pose, lens and light.',
  '- Describe only what THIS camera can see from its stated side. A back to the camera has no face.',
  '- When the camera is about to travel, this still is the framing at the first frame of the travel. When the cut is 2 s or shorter, catch the action already under way (the bucket half across the counter), not about to begin.',
  '- The frame is the whole composition: no camera arriving, no motion trails, no cut-to. Idle business is caught mid-gesture, not described as movement.',
  '- Text is composited in post: every sign, screen, page and label is a blank, unlettered surface.',
  '- When the set is in view, name its construction in a clause or two taken from the set description — massing, materials, colours, the signature features this camera sees ("the curved tan stucco front, gray-blue pylon towers, a glass entrance bay under a bulb-edged marquee"). The set artwork is only a look reference that the image model rebuilds from THIS camera, so the words carry the building from angle to angle; use the same words in every cut that sees the same part of the set.',
  '- 80–140 words. Plain present tense. No feeling words at all — the still shows a body, not a mood.',
  STILL_INTENT_RULES,
].join('\n');

export const END_FRAME_RULES = [
  'End frame — the still an image model renders as the LAST frame of this cut, the picture the clip must land on. A first-last-frame video model interpolates between the start frame and this one, so the end frame is what keeps a moving camera anchored to the real place: without it a tilt down from the sky invents whatever building it finds.',
  '- The camera named first, as the framing the move has REACHED at the last frame: after a pan, tilt, truck, push or crane, the heading, height and size at that frame, never the starting one — the camera is still travelling and the still is one frame of it. When the camera holds, the framing is exactly the start frame\'s and the end prompt is a change list (see the pair rules).',
  '- Every principal frozen in the state the cut\'s last_frame cell and the block\'s ending describe — pose, orientation, hands and prop as they are when the action has finished — each placed relative to a landmark. Nothing mid-move, no motion trails.',
  '- The same light, the same visual handles and the same construction clause for the set as the start frame, word for word where they still apply: the two stills must read as the same place and the same people a few seconds apart.',
  '- The cut\'s point, the eyeline and the block\'s "Do not show …" sentences hold in the end still exactly as in the start still (see the start-frame rules): the same hurry in the bodies, the same withheld face, the same heading toward the destination.',
  '- Describe only what this camera sees at the end. A part of the set that only comes into view during the move is described here, from the set description.',
  '- After a pan, tilt, sideways truck/track or crane the end still IS the start still displaced by the travel (at most half a frame): say where each thing that is still in view has slid to ("the entrance canopy, at the left edge in the first frame, now right of centre"), keep every person who is still in view the same person in the same spot doing the same thing unless the block moves them, and describe what the move has brought in along the leading edge. Never restage: five teenagers at the kerb do not become two other teenagers; the three the slide keeps are those three, where they stood.',
  '- Text is composited in post: every sign, screen, page and label is a blank, unlettered surface.',
  '- 80–140 words for a moving camera, 20–60 for a held camera\'s change list. Plain present tense. No feeling words at all.',
].join('\n');

// The two stills of one cut. Every rule here is a fault that rendered: a
// jacket that became the reference photo's T-shirt, a butter dispenser that
// grew out of a counter, a man who popped into a seat, seat rows that slid
// across the floor, a popcorn bucket that simply ceased to exist.
export const FRAME_PAIR_RULES = [
  'The pair — the two stills of a cut are ONE place a few seconds apart. A first-last-frame model animates every difference between them: an object in one still and not the other grows out of the counter, a person in one and not the other pops into the seat, seats drawn in a different arrangement slide across the floor. Write the pair so the only differences are the ones the block performs.',
  '- Same people. Everyone in the end still is in the start still unless the block shows them enter, and everyone in the start still is in the end still unless the block shows them leave. Background people count: the same number, in the same seats.',
  '- Same things. Every prop, fixture and piece of set dressing the end camera sees that the start camera also sees is in the start prompt, in the same words, in the same place ("a steel butter dispenser at the left end of the counter" in both, or in neither).',
  '- Same layout. Furniture is counted and placed once and repeated word for word: "two rows of six red seats, the aisle on the right". Never "rows of seats" in one still and "a bank of seats" in the other.',
  '- Same clothes. Each person\'s handle names their wardrobe in the lock line\'s words (the LOCKED WARDROBE verbatim when the cast list states one), the same words in both stills, and the SAME artwork is picked for that person in both — a "wardrobe plate" catalog entry is the authority on their clothes and is always a good pick.',
  '- Every object that leaves a hand has a destination in the end still: where it lies, on what, which way up ("the bucket on its side on the carpet by his left shoe, popcorn spilled around it"). An object that is simply absent has vanished, and the model invents how.',
  '- When the camera MOVES, whatever part of the start still is still in view is described in the start prompt\'s words; what the move reveals is new and comes from the set description. A sliding move (pan, tilt, sideways truck/track, crane) keeps at least half of the start still in view, from the same angle at the same size.',
  '- When the camera HOLDS (static or handheld), the end still is made by editing the start still, so the end prompt is not a second description. It is the CHANGE LIST for the same picture: begin "Same frame." and state only what is different at the end, each as the finished state with its place — 20 to 60 words. Everything it does not mention stays exactly as the start still has it; anything it mentions is painted in, so never mention what has not changed.',
  'Check per cut before returning: count the people in each still; list the props in each; read the two furniture clauses side by side. A difference the block does not perform is a fault — fix it, usually by adding the thing to the START still.',
].join('\n');

// Coverage between cuts. Written after two consecutive cuts held the same
// camera on the same boy: in the first he slowly ate one piece of popcorn, the
// second opened on a fist full of it. Each cut is its own generation, so two
// cuts on one setup are two unrelated pictures of the same framing — a jump.
export const COVERAGE_RULES = [
  'Coverage — every cut is a NEW camera setup. Two consecutive cuts never share one: the audience reads the same framing twice in a row as a mistake, and because each cut is rendered on its own, whatever differs between the two (a hand, a prop, a mouthful) jumps.',
  '- Between consecutive cuts change the SUBJECT, or keep the subject and change both the side (at least a third of the way round them) and the size. The setups to reach for: the profile; from behind or over the shoulder; what they are looking at (the screen, the door, the other person — the reverse); an insert of the hands and the object; the wide that shows where everyone is. Someone watching something is covered as watcher → the thing watched → watcher from another side, never watcher → watcher.',
  '- An action too long for one cut is not continued from the same camera: the next cut finds it from somewhere else, or cuts away and comes back.',
  '- The SAME setup twice in a row is allowed only when the director\'s commentary or the director\'s read asks for it (a jump cut, a held stare broken into beats). Then the second row sets continues_previous: true — time is continuous, nothing is restaged, and the cut opens on EXACTLY the frame the previous cut ended on (its start still is the previous cut\'s end still). Otherwise continues_previous is false.',
  '- The hand-off, whatever the setup: a cut opens with every body, hand, prop, mouthful and piece of clothing in the state the previous cut\'s last_frame left it. A bucket that fell in cut 3 lies on the carpet in cut 4; a hand that was empty is empty.',
].join('\n');

// A montage has a job. Written after an opening montage came back as a run of
// pleasant, interchangeable pictures: nothing in any of them to look at, and
// nothing that said what year it was or why we were being shown it.
export const MONTAGE_SCENE_RULES = [
  'Montage — a scene with no continuous action: a run of separate pictures cut together (an opening that sets the time and place, a passage of time, a place waking up). Mark it kind: "montage"; every other scene is kind: "scene".',
  '- A montage has a JOB, and the intention sentence states it: what the audience must know or feel when it ends that they did not before ("we are in a small Ontario town in the summer of 1994, before we have met anyone, and it is the last easy week of the holidays").',
  '- montage_subjects lists what must be SHOWN to do that job — six to twelve concrete, filmable things drawn from the beat, the sets, the characters and the period: what people wear and how they wear it, what they do with a free afternoon, the games, the vehicles, the food, the objects in their hands, the machines of the time, the rituals of this place. Each subject is specific to THIS story and time: "teenagers" is a blank; "three boys taking turns on one skateboard outside the arcade, the others eating freezies" is a subject. A subject that would fit any other film is a blank.',
  '- For a montage the director\'s read is filled from the audience\'s side: dramatic_function = what it sets up; turn = what the audience knows at the end that it did not at the start; pov = whose world this is; power_shift, hidden_want, obstacle_tactic, subtext, suppressed_behavior = what the place and its people are busy with and what that tells us, in filmable terms; never blank.',
].join('\n');

export const MONTAGE_CUT_RULES = [
  'The hook — every cut has ONE thing the eye goes to, the reason this shot is in the film. Write it in the hook cell as what the camera sees. A cut with no hook is a stock shot: correct, and nobody watches it.',
  '- A hook is one of these: SOMETHING HAPPENS (a small event with its payoff inside the cut — the skateboard clears the kerb, the freezie snaps in half, the dog takes the hot dog); GORGEOUS (light on a material, named — low sun through a sprinkler\'s fan, neon on wet asphalt — never an evaluating word); FUNNY (an incongruity or a small failure that reads without a caption); CUTE (the very small or very earnest, doing something with total seriousness); CURIOUS (a detail the viewer leans in to work out).',
  '- The hook is concrete and inside the frame from the first frame; when something happens, it has finished by the last frame and the last_frame cell holds its result. It is the cut\'s one action — never a second thing happening behind it.',
  '- In a dramatic scene the hook is usually the cut\'s point itself (the look that lands, the hand that withdraws). In a MONTAGE it is the whole cut, and these also hold:',
  '- Each cut takes ONE of the scene\'s montage_subjects and shows it doing the montage\'s job: the picture must say the time, the place or the life the intention names, in what people wear, hold and do — never a picture that could open any film.',
  '- No two consecutive cuts share a subject, a kind of hook or a size. Open on the cut that places us; end on the button — the cut that hands over to the story.',
  '- Keep hooks where the model renders well (weather, light, cloth, water, one simple motion, crowds at a distance) and inside what the cut\'s length can hold: a quick cut\'s hook is one motion already under way.',
].join('\n');

export const MONTAGE_RULES = [MONTAGE_SCENE_RULES, MONTAGE_CUT_RULES].join('\n');

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
  '',
  'Worked example, a moving camera (8 s; travel: from the box office at the left edge to the concession counter, about one frame-width). Wide shot from the lobby doors at eye level, 24mm, the camera already panning right at one slow, even speed from the box office toward the concession counter: a dozen people cross the red carpet in ones and twos, coats over their arms; behind the glass counter an attendant in a striped vest fills a paper bucket at the popper. Sound: the popper rattling, low talk, a ticket machine. Same light: warm amber sconces along the walls, a bright white glow over the counter. Camera at the lobby doors. End with the counter filling the right half of the frame, the pan still moving at the same slow speed.',
  '',
  'Worked example, an accident (3 s). Medium shot from the aisle at seated eye level, 50mm, the camera holding: the boy has forgotten the bucket in his hand — his eyes are fixed on the screen, mouth slightly open, blue light on his face. His fingers loosen around the bucket; it tips out of his hand and falls by accident, landing on its side on the carpet by his left shoe, popcorn spilling across the floor. His eyes stay on the screen, his empty hand hanging where the bucket was. The row behind him keeps watching, one man lifting a cup to his mouth. Sound: the soft thud of the bucket, popcorn scattering, the film\'s music. Same light: blue flicker from the screen, dim amber aisle lamps. The boy: ten, short brown hair, red windbreaker, third seat from the aisle, facing the screen. Camera in the aisle. End with the bucket on its side at his shoe and his eyes on the screen.',
].join('\n');
