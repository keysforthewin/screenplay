// src/web/storyboardConstraints.js
// Single source of truth for the AI image-to-video failure-mode rules. Both
// the scene-plan prompt and the shot-expand prompt reference these so the
// guidance is written once. Each export is a ready-to-embed text block.
//
// Several blocks here (ANTI_SLOP_RULES, SHOT_SIZE_FIDELITY_RULES,
// ENDING_PROFILE_RULES, FRAGILITY_RULES, the ensemble tiers in
// PERFORMANCE_RULES) are adapted from Emily's seedance-2.0 research —
// https://github.com/Emily2040/seedance-2.0. See ATTRIBUTION.md at the repo
// root for the per-idea mapping and for what we deliberately did not adopt.

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

// Empty evaluation language is expensive: every word competes for the model's
// finite conditioning budget, and a word that names a judgement ("cinematic")
// spends that budget on nothing. The negation half is the same failure from the
// other side — text conditioning moves probability TOWARD every concept it
// mentions, so "no blur" summons blur. Both passes embed this.
export const ANTI_SLOP_RULES = [
  'Anti-slop — every phrase you write must be something a camera, a microphone, a light meter, or a stopwatch could detect. If it fails that test, rewrite it as the observable detail that earns it.',
  '- FORBIDDEN as prompt words: cinematic, epic, stunning, breathtaking, beautiful, gorgeous, dramatic, dynamic, moody, atmospheric, evocative, striking, hauntingly, masterpiece, award-winning, 8K, ultra-HD, hyper-detailed, photorealistic, high quality. They add tokens and zero signal.',
  '- Replace, do not delete: "dramatic" becomes the blocking, the shadow, the silence, or the camera pressure that made you reach for the word. "Beautiful" becomes the color, texture, material, or light behavior. "Dynamic" becomes the specific movement, its speed, and where it ends.',
  '- Do NOT stack synonyms. Three adjectives for one quality make one weak claim — pick the single detail that matters.',
  '- NO NEGATION. Naming a thing plants it: "no blur", "she does not look away", "nothing else moves" all summon exactly what they forbid. Write the positive state instead — "hands rest still on the table", "she holds his eyes", "the rain keeps falling behind them".',
  '- Genre and medium language IS allowed when it is paired with concrete direction: "hard venetian-blind shadows across the hallway" is useful; "dramatic noir vibes" is not.',
].join('\n');

// Detail capacity scales with screen area: a face at 2% of the frame gets
// roughly 2% of the spatial representation and cannot hold fine structure.
// This is why asking for a facial beat in an establishing wide produces smear.
// Shared by Pass 1 (so the planner assigns beats to shots that can hold them)
// and Pass 2 (so the written performance matches the framing).
export const SHOT_SIZE_FIDELITY_RULES = [
  'Shot size decides what the shot can actually hold — match the beat to the framing:',
  '- establishing / cinematic_wide: geography, scale, arrival, weather, screen direction. Faces are too small to act. Stage feeling in POSTURE, gait, distance, and where a figure stands relative to others — never in an expression.',
  '- medium / two_shot / over_the_shoulder: blocking, relationship, distance closing or opening, gesture, the shape of an exchange. Broad facial beats read; micro-expressions do not.',
  '- close_up / reaction / insert: this is where micro-acting lives — the eyes, the jaw, the swallow, the held blink, the hands on a prop. Keep the camera still and the action small so the detail survives.',
  '- ONE PRIMARY SPEND PER SHOT. Identity fidelity, motion boldness, and scene density compete for the same budget; a shot demanding a perfect face AND committed physical action AND a crowded frame lands none of them. Name what the shot is FOR, then economize the rest on purpose.',
  '- If a beat needs both a big action and a readable face, that is TWO shots. Split it rather than asking one shot for both.',
].join('\n');

// A shot is a cut in an edit, so its last frame is a handoff, not a resting
// place. The failure this prevents is unmatched motion — movement at the final
// frame that nothing downstream consumes — and its mirror, a shot that dies
// into stillness when the cut needs it live.
export const ENDING_PROFILE_RULES = [
  'Endpoint — every clip must reach a COMPLETED visual state, and you must decide which kind before you write the last sentence. The clip ends differently depending on what the cut needs next:',
  '- EDIT POINT (the default here — these shots are cut together): picture and action land on a clean boundary. The beat completes; the body settles enough to cut away from without a hitch.',
  '- MOTION HANDOFF: the next shot picks up this movement (a match cut, a continuing walk, a shared motion vector). Leave the motion directionally LIVE through the final frame — do not let it settle, or the cut hitches.',
  '- REVEAL OR PUNCH: the peak lands ON the final frame — the scare, the recognition, the joke. Settle into it; trailing motion softens the beat the shot exists for.',
  '- HOLD: the audience must READ something (a face arriving at a decision, an object, a gesture). Stabilize long enough to be legible.',
  'The error is not motion at the final frame — it is UNMATCHED motion, movement nothing downstream consumes. Do not add drift by reflex to make an ending feel alive, and do not prescribe stillness either. State what has CHANGED by the end: the last frame must differ from the first.',
].join('\n');

// The known-fragile areas of image/video generation. Design around them at
// plan time (Pass 1 picks the shot) and at write time (Pass 2 keeps the fragile
// thing simple, large, or out of frame).
export const FRAGILITY_RULES = [
  'Fragility — these degrade first. Design around them rather than hoping:',
  '- Readable text and logos (signs, screens, plates, books) warp to gibberish. Keep them out of frame, out of focus, or static and unmoving — never redrawn during a move.',
  '- Small, distant, or fast-moving detail starves: background faces, busy fingers, tiny props. If a detail matters, it earns its own shot at a size that can hold it.',
  '- Hands deform under complex action. Keep hand motion simple and slow, or keep the hands out of the main action.',
  '- Character-to-prop contact (lifting, passing, handing over) is fragile with several people on screen. Keep the contact simple, give it its own shot, or let it happen just off-frame.',
  '- Stacked camera moves fight each other. One primary move per shot; a compound move needs a simple, continuous destination space.',
].join('\n');

export const STILL_FRAMING_RULES = [
  'Still-frame composition (for the start_frame_prompt that anchors the clip):',
  `- This still is a FROZEN MOMENT of a live action, not a posed product shot. Translate the shot's motion into a concrete pose: a moving car sits squarely in its lane, body aligned with the road, nose pointed the way it travels; a walking person is caught mid-stride, weight shifting, facing their heading. Never leave the subject in a limp, ambiguous, or default stance.`,
  `- The still is the clip's FIRST frame — the INITIAL STATE at t=0. Render the moment the clip opens on, then let the video_prompt carry everything that happens afterward.`,
  `- State the subject's ORIENTATION and HEADING explicitly — which way it faces and, for anything in motion, the direction it is traveling. Pair every framing term ("three-quarter rear", "profile") with that heading so the model cannot invent a nonsensical pose (a car slewed diagonally across the road, a figure facing the wrong way).`,
  `- State WHERE the subject sits in the geography the beat requires — the exact sub-location the beat or a mini-slug names (the back seat vs the front, at the head of the table, in the doorway, in its travel lane to one side of the centerline). REQUIRED in EVERY still that frames that subject, INCLUDING tight close-ups where the location seems invisible: the image model defaults an unplaced subject to the most generic position (a child at a car window → the front passenger seat), so saying nothing renders the WRONG place. This is shot-specific blocking — write it; it is NOT a forbidden restatement of the scene bible.`,
  `- Pin the sub-location with a POSITIVE ANCHORING CUE held in frame, not just the words: for a back-seat child, show the back of the front-row headrest ahead of him and the rear side-window line, and keep the steering wheel and dashboard OUT of frame; for the head of the table, show the table receding away from him; for the doorway, show the jamb framing him. One or two such cues are enough to fix the placement.`,
  '- Pull the load-bearing concrete details from the beat into the still. If the beat says the subject is driving / fleeing / hiding / waiting, the still must read as exactly that. Do not flatten a specific dramatic state into a generic composition.',
  `- Compose the subject (or both, in a two-shot) within the frame so it reads clearly and is not clipped at the edge — but "centered in frame" never means "centered in the world": a vehicle still sits in its travel lane, not on the centerline. Keep it unoccluded and the foreground clear of its silhouette.`,
  '- Specify a simple, separable background when the set allows ("dark interior", "soft blurred street lights") — but never simplify away the one or two anchoring cues that fix the subject\'s sub-location (see above).',
  '- The opening still is the WHOLE composition — do NOT describe the camera arriving on the subject from off-frame.',
  '- Readable text or logos the audience is meant to read (signs, screens, books, plates) warp to gibberish — keep them out of frame or out of focus.',
].join('\n');

// The output contract for the video_prompt: what CHANGES over the clip, in a
// fixed order (camera → blocking → performance → at most one environmental
// event), with every static/scene detail stripped (the start frame already
// carries it). Owns ORDERING/FORMAT; CAMERA_MOTION_RULES owns which camera
// moves are available, PERFORMANCE_RULES owns the acting content.
export const VIDEO_PROMPT_RULES = [
  'Video-prompt structure — describe what happens over the clip; the start frame already holds the scene. 4-8 sentences, in this order:',
  '1. CAMERA FIRST, explicitly, as the opening words. For a held shot write "Static, locked-off camera." verbatim — never bury the camera mid-sentence. For a moving shot, name the move and its motivation as the first clause.',
  '2. BLOCKING — how the bodies move through the frame, with direction and endpoint.',
  '3. PERFORMANCE — the speech turns, the facial beats, the listener behavior, and any state change, per the performance rules. This is the SUBSTANCE of the shot. Do not skip it because the shot looks simple: a shot of two people talking is a shot about two performances, not about a camera.',
  '4. At most ONE environmental event — weather turning, a light source changing, a passing vehicle. Keep it in service of the performance, never competing with it.',
  '5. ENDPOINT — the completed state the clip arrives at, per the endpoint rules.',
  'WRITE CAUSE AND CONSEQUENCE, NOT A LIST. One physical cause with two or three visible consequences reads far stronger than four disconnected instructions: "the heavy door swings shut and the candle flames bend toward it" beats "the door closes; the flames move; the room darkens". A described cause gives the motion something to ride; a list of micro-instructions has no trajectory and gets smoothed away or glitches.',
  'Strip ALL static description from the video_prompt: no subject identity (make / model / color / year / name), no setting or location, no composition or framing. Those live in the start_frame_prompt only — the video_prompt assumes the frame is already correct.',
  'Do NOT write a stillness closer. The line "Everything else holds still — no other movement." and any variant of it are FORBIDDEN: they freeze every listener, every reaction, and every background life cue, and a scene where exactly one thing moves reads as dead. Close on the shot\'s endpoint instead.',
].join('\n');

// When the beat puts characters INSIDE something the shot frames from the
// OUTSIDE, the interior must not read as empty. These figures are deliberately
// low-detail placeholders (no reference photos reach them) — a rough build/hair
// cue is enough to fix the count and silhouettes; real actors get swapped in
// later. This is the one sanctioned exception to "don't describe characters".
export const OCCUPANT_PLACEHOLDER_RULES = [
  'Placeholder occupants — when the beat puts characters INSIDE something the shot frames from OUTSIDE (a vehicle on the road, a lit window, a glass-walled room), the interior must not read as empty:',
  '- Render the right NUMBER of figures, dimly visible through the glass, roughly matching each named occupant\'s build, hair, and wardrobe color from the character list. They are low-detail PLACEHOLDERS — silhouetted heads and shoulders, not rendered faces — to be replaced later.',
  '- Keep occupants INSIDE and low-contrast behind the glass; do NOT promote them to framed subjects. The exterior object (the vehicle / the building) stays the hero of the shot.',
  '- This is the ONE exception to "do not describe character appearance": there are no reference photos reaching tiny through-glass figures, so a rough build / hair / wardrobe cue is what keeps the count and silhouettes right.',
].join('\n');

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
  '- FACIAL BEATS — the expression CHANGE, never a static expression. Name the start state and the end state: "the flat courtesy drains out of her face into open alarm." Brows, eyes, mouth corners, jaw, a swallow, a blink held a beat too long. Only ask for this where the framing can hold it (see the shot-size rules) — at wide sizes, put the same beat in the body instead.',
  '- LISTENER BEHAVIOR — what every non-speaking character on screen does while the other talks. A listener is never neutral: holds the speaker\'s eyes, looks away, nods, stiffens, starts to answer and stops. Name one for each listener present. Silence is a performance.',
  '- STATE CHANGE — any change to dress, held props, or physical condition occurring during the clip: a jacket pulled off and dropped, a tie loosened, a weapon drawn, rain soaking through. Give it a beginning and an end inside the clip.',
  '',
  'EMOTION IS NOT DIRECTABLE — behavior is. "She is devastated" and "the mood is tense" have no pixels. Convert every feeling into the one true gesture that proves it: not "grief" but "she folds the letter, presses it flat with both hands, and does not look up". Give the performer an objective and an obstacle, then write the visible tactic.',
  '',
  'ENSEMBLE DISCIPLINE — when more than one person is on screen, assign every visible figure to exactly ONE of three tiers. This is the strongest stabilizer for multi-person shots; without it the model tries to animate everyone equally and faces and hands smear:',
  '  1. PERSISTENT MICRO-MOTION — the default for everyone who is not the focus: breathing, blinks, a small shoulder shift, drifting gaze, hair movement. Continuous, no gaps.',
  '  2. ONE FOCUSED BEAT — exactly one character gets the shot\'s real reaction, and it gets a window inside the clip: "her lip corner lifts and she holds the look for a beat".',
  '  3. LARGE ACTION — standing, walking, turning the whole body, picking something up. Allowed ONLY when it is this shot\'s single beat. Otherwise exclude it: say the others hold their positions.',
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

// A shot is ONE camera position. The failure this prevents: a prompt that names
// a from-behind vantage ("looking forward up the cabin") and then describes the
// subjects' faces / frontal gestures — physically two shots, which makes the
// model spin a character around to face the rear camera. Shared by Pass 1 (so
// the planner doesn't create two-vantage shots) and Pass 2 (so each written
// still is single-vantage).
export const CAMERA_COHERENCE_RULES = [
  'Camera vantage — ONE coherent eyeline per shot:',
  '- Name the vantage explicitly at the start of the still ("frontal medium", "three-quarter rear wide", "profile close-up"), then describe only what that camera can see from it.',
  '- A subject whose BACK is to the camera shows the back of the head and shoulders — you CANNOT describe their face, expression, or front-of-body gesture. A from-behind master ("forward up the cabin" / "down the road") shows backs and the space ahead.',
  "- To show a character's FACE, expression, or frontal action, the camera must FACE them: front or three-quarter FRONT shows the face; profile shows a side; three-quarter REAR and full rear do NOT. If the camera can't physically see a face from your stated angle, don't describe it.",
  '- THE BUG TO AVOID: one frame that describes the FACES of people whose backs are to the camera (a from-behind master + frontal detail). That is two separate shots — give the character beat its own shot angled to see them.',
  '- This does NOT forbid a person seen from behind in frame. Standard grammar is fine — over_the_shoulder shows the near person from behind (no face described) while the camera FACES the far character whose beat it is; a two-shot may show one character facing the camera (face visible) and another facing away (back visible). Both are one coherent eyeline.',
  '- The single test: every face or expression you describe must belong to someone this one camera can actually see.',
].join('\n');
