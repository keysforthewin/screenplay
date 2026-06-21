// Single source of truth for the screenplay-centric beat-writing convention.
//
// SCREENPLAY_STYLE_GUIDE is the full, actionable craft guide returned by the
// agent's load_writing_context tool (src/agent/writingContext.js) right before
// it composes a beat body. SCREENPLAY_STYLE_SUMMARY is the short version carried
// in the always-on system prompt (src/agent/systemPrompt.js). Define the text
// ONCE here so the two placements never drift.

export const SCREENPLAY_STYLE_GUIDE = [
  'Write beat bodies as screen action a camera can shoot — not novel prose.',
  '',
  '- Scene heading: when the beat is a literal scene, open with a slugline — `INT./EXT. LOCATION — TIME OF DAY` (e.g. `INT. DINER — NIGHT`). Skip it for lore or world-building beats that are not a single place and time.',
  "- Mini-slugs (secondary headings): once a scene is established, mark a move to a sub-location WITHIN it with a short ALL-CAPS line of its own — `BACK SEAT`, `AT THE WINDOW`, `DRIVER'S SEAT`, `BACK TO SCENE` — with no INT./EXT. and no time of day. Use these (not a fresh slugline) to pin where the action sits inside the location; reserve full sluglines for a real change of place or time.",
  '- Action lines: present tense, third person, concrete and photographable. Describe what is SEEN — looks, nods, glances, gestures, posture, where people stand and move, how they handle props. Do not write interior thoughts or backstory the camera cannot show; turn them into a visible action or a spoken line.',
  '- Spatial geography & blocking: establish WHERE characters and key props sit within the set, anchored to concrete features (the back seat, the doorway, the head of the table; foreground/background, near/far, left/right), and RE-establish a position whenever a later moment depends on it. Prefer position-and-movement verbs — "slides into the back seat", "crosses to the window", "presses against the far door" — over vague placement. If a placement matters but the camera could not tell where someone is, make it explicit (a mini-slug or a blocking line) — downstream image generators read this geography literally, so "in the minivan" when you mean the back seat lands a figure in the front.',
  '- Camera/shot cues: use sparingly, only where the shot matters — `CLOSE ON`, `WIDE`, `PUSH IN`, `ANGLE ON`, `POV`. Do not direct every line; let most action imply its own framing.',
  "- Dialogue: include a few anchor lines that establish voice and carry the beat. Put the speaker's name in CAPS on its own line, an optional `(parenthetical)` for delivery, then the line. Keep it sparse — the full dialogue is written separately by the dialogue generator, so the body only needs the key beats.",
  '- Non-scene beats: lore and world-building may stay descriptive, but still write in present tense and favour the concrete and visual over the abstract.',
  '- Reformatting: if the user asks you to convert an existing prose beat into screenplay style, rewrite its body to follow this guide.',
].join('\n');

export const SCREENPLAY_STYLE_SUMMARY =
  'Beat bodies are written as screenplay action, not prose: present-tense, photographable action lines (looks, nods, blocking — what the camera sees), with the spatial geography nailed down — where people and props sit in the set, using mini-slugs like BACK SEAT to pin a sub-location — plus sparing shot cues (CLOSE ON, WIDE) and a few anchor lines of dialogue. `load_writing_context` returns the full screenplay-format guide — follow it whenever you compose or edit a body.';
