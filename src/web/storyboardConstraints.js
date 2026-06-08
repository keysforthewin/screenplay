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
  '- Do NOT introduce new people or props mid-clip. Everyone the clip ends with must already be in the start frame.',
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
  `- State the subject's ORIENTATION and HEADING explicitly — which way it faces and, for anything in motion, the direction it is traveling. Pair every framing term ("three-quarter rear", "profile") with that heading so the model cannot invent a nonsensical pose (a car slewed diagonally across the road, a figure facing the wrong way).`,
  `- State WHERE the subject sits in the geography the beat requires (in its lane on the road's center axis, at the head of the table, in the doorway). This is shot-specific blocking — it is NOT a restatement of the scene bible.`,
  '- Pull the load-bearing concrete details from the beat into the still. If the beat says the subject is driving / fleeing / hiding / waiting, the still must read as exactly that. Do not flatten a specific dramatic state into a generic composition.',
  '- Place the subject (or both, in a two-shot) centered, not clipped at the frame edge; keep it unoccluded and the foreground clear of its silhouette.',
  '- Specify a simple, separable background when the set allows ("dark interior", "soft blurred street lights").',
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
  '3. At most ONE hero temporal change — the single time-based event that defines the clip (e.g. the sodium glow sweeping across the body as it passes each lamp). Make it the centerpiece; do not scatter competing "pulsing / warm / glowing" clauses.',
  '4. End with the stillness constraint, verbatim: "Everything else holds still — no other movement." This stops the model inventing background motion.',
  'Strip ALL static description from the video_prompt: no subject identity (make / model / color / year / name), no setting or location, no composition or framing. Those live in the start_frame_prompt only — the video_prompt assumes the frame is already correct.',
].join('\n');
