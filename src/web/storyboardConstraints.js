// src/web/storyboardConstraints.js
// Single source of truth for the AI image-to-video failure-mode rules. Both
// the scene-plan prompt and the shot-expand prompt reference these so the
// guidance is written once. Each export is a ready-to-embed text block.

export const CAMERA_MOTION_RULES = [
  'Camera motion — pick at most one per shot, and prefer the top of this list:',
  '- Locked-off / tripod static. Most reliable; the camera does not move, only the subject does. When in doubt, pick this.',
  '- Subtle handheld breath — micro-shake or small drift while the camera stays essentially in place.',
  '- Slow push-in toward the subject along the subject axis.',
  '- Slow pull-out along the subject axis (keep it short; the model must invent peripheral background).',
  '- Slow lateral truck — only when the destination space is continuous and simple.',
  'NEVER (these break the model):',
  '- Turning / panning in place to look off-frame (yaw rotation): "the camera pans to…", "we pan from Alice to Bob".',
  '- Tilting up/down to reveal a new subject (pitch rotation).',
  '- Whip pans, fast zooms, dolly-zooms, rolls, sweeps, orbits.',
  '- Crane / jib / drone / aerial / Steadicam-following moves; any arcing or subject-tracking trajectory.',
  '- Two-stage moves in one shot (push-in then tilt; lateral then turn).',
].join('\n');

export const SUBJECT_MOTION_RULES = [
  'Subject motion — keep it constrained to a single vector:',
  '- Best: a head turn, a gaze shift, a hand lifting, weight shifting, fabric/hair moving, smoke rising, rain falling.',
  '- Do NOT introduce new SOLID things mid-clip — people, animals, vehicles, or held/standing props. Every solid subject the clip ends with must already be in the start frame; solid pop-ins glitch (warped limbs, swapped identities, ghost objects).',
  '- EXCEPTION — non-solid effects MAY appear mid-clip and are the proper payload of the video_prompt: light (a shooting star, lightning, a muzzle flash, a swelling glow, headlight sweep), weather (rain or snow beginning), and particles/fluids (smoke, dust, sparks, spray, a breaking wave). These are NOT in the start frame — the start frame shows the calm state before they occur, and the effect is introduced only in the video_prompt.',
  '- Do NOT describe two-character contact (handshake, hug, kiss, struggle, dance) — limbs merge and identities swap.',
  '- Do NOT describe subjects passing in front of each other — identity swap.',
  '- Do NOT describe lighting changes mid-clip (a lamp turning on, headlights sweeping, a flash).',
  '- Do NOT describe precise hand action (writing, typing, counting bills, threading, tying) — fingers merge.',
  '- Do NOT describe spinning wheels, gear mechanisms, or fast clock hands — repeating geometry warps.',
  '- Do NOT write dialogue, voice-over, or sound effects. Audio is added in post.',
].join('\n');

export const REVEAL_HANDLING = [
  'Reveals and entries break the model: a camera move or cut that lands on a previously-hidden subject glitches.',
  'Detect them via signal phrases: "is revealed", "comes into view", "appears", "emerges", "X enters the frame",',
  '"X walks in", "we discover X", "the camera pans to find X", "pulls out to show X", or any end-state that',
  'contains something not visible at the start.',
  'When a shot is a SPATIAL reveal/entry, mark it reverse_in_post: true and write it BACKWARDS: the shot starts',
  'with the reveal target centered and fully visible, and ends with the camera pulled back / the subject',
  'shrunk or exited. The clip is reversed in post, so the audience experiences the discovery.',
  'When the reveal is NOT spatially invertible (lighting change, irreversible physics, yaw/pitch rotation,',
  'audio-driven beat), do NOT use reverse_in_post — substitute with separate static shots covering the same content.',
].join('\n');

export const FRAMING_RULES = [
  'Framing — what the model cannot draw cleanly, avoid in any shot:',
  '- Crowds or background extras. Frame tight on the named subject(s) against a simple/blurred background.',
  '- Subjects entering from off-screen mid-shot. Everyone who matters is already on-screen at the first frame.',
  '- Subjects partially occluded by foreground while the camera moves (foliage, bars, fences, glass).',
  '- Mirrors, water, or polished-glass reflections of a character — the reflection drifts independently.',
  '- Readable text or logos the audience is meant to read (signs, screens, books, plates) — they warp to gibberish.',
].join('\n');

export const STILL_FRAMING_RULES = [
  'Still-frame composition (for the start_frame_prompt that anchors the clip):',
  `- This still is a FROZEN MOMENT of a live action, not a posed product shot. Translate the shot's motion into a concrete pose: a moving car sits squarely in its lane, body aligned with the road, nose pointed the way it travels; a walking person is caught mid-stride, weight shifting, facing their heading. Never leave the subject in a limp, ambiguous, or default stance.`,
  `- The still is the clip's FIRST frame — the INITIAL STATE at t=0. Render only what is present at that instant. Any NON-SOLID effect that occurs LATER in the clip — a shooting star, a lightning flash, a firework burst, a muzzle flare, a breaking wave, spray, rain or snow starting, smoke or dust kicking up, a glow swelling — has not happened yet at t=0: leave it OUT of the still (a calm, blank sky — never a star caught mid-streak) and introduce it only in the video_prompt as the hero temporal change. This does NOT change how you pose an already-ongoing subject: a car already travelling is still shown mid-travel — only effects that newly occur mid-clip are withheld.`,
  `- State the subject's ORIENTATION and HEADING explicitly — which way it faces and, for anything in motion, the direction it is traveling. Pair every framing term ("three-quarter rear", "profile") with that heading so the model cannot invent a nonsensical pose (a car slewed diagonally across the road, a figure facing the wrong way).`,
  `- State WHERE the subject sits in the geography the beat requires — the exact sub-location the beat or a mini-slug names (the back seat vs the front, at the head of the table, in the doorway, in its travel lane to one side of the centerline). REQUIRED in EVERY still that frames that subject, INCLUDING tight close-ups where the location seems invisible: the image model defaults an unplaced subject to the most generic position (a child at a car window → the front passenger seat), so saying nothing renders the WRONG place. This is shot-specific blocking — write it; it is NOT a forbidden restatement of the scene bible.`,
  `- Pin the sub-location with a POSITIVE ANCHORING CUE held in frame, not just the words: for a back-seat child, show the back of the front-row headrest ahead of him and the rear side-window line, and keep the steering wheel and dashboard OUT of frame; for the head of the table, show the table receding away from him; for the doorway, show the jamb framing him. One or two such cues are enough to fix the placement.`,
  '- Pull the load-bearing concrete details from the beat into the still. If the beat says the subject is driving / fleeing / hiding / waiting, the still must read as exactly that. Do not flatten a specific dramatic state into a generic composition.',
  `- Compose the subject (or both, in a two-shot) within the frame so it reads clearly and is not clipped at the edge — but "centered in frame" never means "centered in the world": a vehicle still sits in its travel lane, not on the centerline. Keep it unoccluded and the foreground clear of its silhouette.`,
  '- Specify a simple, separable background when the set allows ("dark interior", "soft blurred street lights") — but never simplify away the one or two anchoring cues that fix the subject\'s sub-location (see above).',
  '- The opening still is the WHOLE composition — do NOT describe the camera arriving on the subject from off-frame.',
].join('\n');

// The output contract for the video_prompt: motion only, in a fixed order
// (camera → one directional motion → at most one temporal change → stillness),
// with every static/scene detail stripped (the start frame already carries it).
// Owns ORDERING/FORMAT; CAMERA_MOTION_RULES / SUBJECT_MOTION_RULES own which
// moves are allowed.
export const VIDEO_PROMPT_RULES = [
  'Video-prompt structure — describe ONLY what changes over time; the start frame already holds the scene. 2–4 sentences, in this order:',
  '1. CAMERA FIRST, explicitly, as the opening words. For a held shot write "Static, locked-off camera." verbatim — never bury the camera mid-sentence. For a moving shot, name the single move from the camera-motion list as the first clause.',
  '2. ONE primary motion, directional, with an endpoint. Give a vector AND a destination — "recedes straight down the street toward the vanishing point, shrinking", not "glides forward and slightly away". State that motion exactly ONCE; never repeat it in a later sentence.',
  '3. At most ONE hero temporal change — the single time-based event that defines the clip (e.g. the sodium glow sweeping across the body as it passes each lamp). Make it the centerpiece; do not scatter competing "pulsing / warm / glowing" clauses. This hero change MAY be a NON-SOLID effect that is absent from the start frame (a shooting star streaking across the blank sky, a flash, a wave breaking); when it is, the start frame must depict the pre-event state and the effect appears ONLY here, not in the still.',
  '4. End with the stillness constraint, verbatim: "Everything else holds still — no other movement." This stops the model inventing background motion.',
  'Strip ALL static description from the video_prompt: no subject identity (make / model / color / year / name), no setting or location, no composition or framing. Those live in the start_frame_prompt only — the video_prompt assumes the frame is already correct.',
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
  '- Still-frame detail only — occupants do NOT move in the video_prompt; figures seen through glass warp if animated.',
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
