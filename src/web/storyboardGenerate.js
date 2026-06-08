// Storyboard auto-generation pipeline.
//
// Triggered from POST /api/storyboards/generate. Returns immediately with a
// job id; the work runs in the background and broadcasts progress to the
// "storyboards:<beatId>" room as each storyboard is persisted.
//
// Pipeline:
//   1. Outline pass (Anthropic): break the beat body / desc / characters into
//      an ordered shot list. Each entry has a one-sentence description of what
//      happens in the clip, a shot_type, duration, and the characters in
//      frame. No detailed visual prompts yet.
//   2. Refine pass (Anthropic), one call per frame in narrative order so each
//      call sees its predecessors. Each call produces three outputs:
//      - video_prompt        — the clip-gen prompt (motion / action / camera
//                              move during the clip, assuming the start frame
//                              image already exists). Stored as text_prompt
//                              and sent verbatim to the video model.
//      - start_frame_prompt  — still-image prompt for the opening composition.
//                              Seeds the SPA's start-frame slot.
//      - end_frame_prompt    — still-image prompt for the closing composition.
//                              Seeds the SPA's end-frame slot (used by video
//                              models that take end-frame conditioning).
//   3. Persist one storyboard row per frame via the gateway. The y-doc
//      fragments for text_prompt, start_frame_prompt, and end_frame_prompt
//      are seeded from the refiner output. No images are generated here —
//      the user triggers per-frame stills + video gen from the SPA.
//
// Errors in a single frame are swallowed (logged) so other frames still land —
// the user can re-run "generate" and just fill in missing rows.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { readImageBuffer, uploadGeneratedImage } from '../mongo/images.js';
import {
  getStoryboard,
  listStoryboards,
  SHOT_TYPES,
  clampDuration,
  MAX_CHARS_PER_SHOT,
  MAX_TRANSITION_LEN,
} from '../mongo/storyboards.js';
import { stripMarkdown } from '../util/markdown.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { dispatchStoryboardImage } from './storyboardImageDispatch.js';
import {
  createStoryboardViaGateway,
  deleteAllStoryboardsForBeatViaGateway,
  addStoryboardFrameViaGateway,
  setStoryboardFrameImageViaGateway,
  setStoryboardFrameEditResultViaGateway,
  setStoryboardFramePromptViaGateway,
} from './gateway.js';
import { collectStoryboardReferenceIds } from './storyboardReferenceAggregator.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import {
  CAMERA_MOTION_RULES,
  SUBJECT_MOTION_RULES,
  REVEAL_HANDLING,
  FRAMING_RULES,
  STILL_FRAMING_RULES,
} from './storyboardConstraints.js';
import { renderSceneBibleBlock, normalizeSceneBible, isEmptySceneBible } from '../mongo/sceneBible.js';

const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_REFERENCE_IMAGES = 12; // cap input images per Nano Banana call
// Every LLM call in the storyboard pipeline runs on the top-tier model.
// Hardcoded (not config-driven) on purpose — this surface is meant to be
// "primo", so we don't want silent downgrades via ANTHROPIC_MODEL or similar.
const STORYBOARD_MODEL = 'claude-opus-4-7';
export const DEFAULT_TARGET_COUNT = 11;
export const MIN_TARGET_COUNT = 3;
export const MAX_TARGET_COUNT = 30;
const MAX_DIRECTION_CHARS = 4000;

function clampTargetCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TARGET_COUNT;
  return Math.min(MAX_TARGET_COUNT, Math.max(MIN_TARGET_COUNT, Math.round(v)));
}

function sanitizeDirection(s) {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_DIRECTION_CHARS
    ? trimmed.slice(0, MAX_DIRECTION_CHARS)
    : trimmed;
}

// Fetch the project-wide director's notes for inclusion in the planner prompt.
// Swallows errors (returns []) so a transient DB hiccup doesn't fail the whole
// generation job — the notes are guidance, not load-bearing.
export async function loadDirectorNotesForPlanner() {
  try {
    const doc = await getDirectorNotes();
    return Array.isArray(doc?.notes) ? doc.notes : [];
  } catch (e) {
    logger.warn(`storyboard gen: loadDirectorNotesForPlanner failed: ${e?.message || e}`);
    return [];
  }
}

// Stage A: outline-only tool. Produces the shot list (description, shot_type,
// duration, transition_in, characters_in_scene) but NOT the detailed video /
// still-image prompts — those move to Stage B where each frame gets its own
// focused call.
const OUTLINE_TOOL = {
  name: 'plan_storyboard_outline',
  description:
    'Break the beat into an ordered shot list. For each frame, pick a description, ' +
    'shot_type, on-screen duration, and (when relevant) the characters visible in ' +
    'frame and how the cut picks up from the previous shot. Do NOT write the ' +
    'detailed video / still-image prompts — those are produced in a separate per-frame pass.',
  input_schema: {
    type: 'object',
    properties: {
      frames: {
        type: 'array',
        description: 'Ordered list of storyboard frames covering the entire beat.',
        items: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description:
                'One-sentence narrative summary of what happens in this frame.',
            },
            shot_type: {
              type: 'string',
              enum: [...SHOT_TYPES],
              description:
                'Framing/coverage class. Drives the duration cap. ' +
                'establishing/cinematic_wide/insert ≤ 15s, medium ≤ 10s, ' +
                'close_up/reaction/two_shot/over_the_shoulder ≤ 5s.',
            },
            duration_seconds: {
              type: 'integer',
              minimum: 1,
              maximum: 15,
              description:
                'On-screen hold time. Must respect the cap implied by shot_type.',
            },
            transition_in: {
              type: 'string',
              description:
                'Brief one-line continuity note describing how this shot picks up from the previous one. Empty for the first frame. ' +
                'Examples: "Picks up the door swing from #3"; "Match cut from the spinning coin to the diner sign".',
            },
            characters_in_scene: {
              type: 'array',
              description:
                'Names of characters visible in this frame, exactly as listed in the beat metadata. ' +
                'AT MOST 2 names. Embellishment shots (atmospheric cutaways, establishing wides, inserts of objects) may be empty.',
              items: { type: 'string' },
            },
            reverse_in_post: {
              type: 'boolean',
              description:
                'True if this is a reveal shot whose video should be played in reverse during post. ' +
                'AI video models cannot synthesize forward reveals coherently (a pan that lands on a previously-hidden ' +
                'subject glitches as the model tries to spatially anchor the new element). Workaround: generate the ' +
                'shot backwards — write the `description` as the REVERSED action that the camera and subject perform ' +
                'during generation (subject starts centered and fully visible, then exits / shrinks / is occluded ' +
                'as the clip plays). The per-frame refiner will then invert the still-image prompts to match (start frame = ' +
                'final revealed state, end frame = initial hidden state) and write the video prompt as the camera ' +
                'move in generation direction. The clip is reversed in post and from the audience\'s perspective ' +
                'the camera discovers the subject. Default false. Use sparingly, only for shots whose dramatic intent ' +
                'is a reveal.',
            },
          },
          required: ['description', 'shot_type', 'duration_seconds'],
          additionalProperties: false,
        },
      },
    },
    required: ['frames'],
    additionalProperties: false,
  },
};

// Stage B: per-frame visual prompt refinement. Called once per frame in
// narrative order so each call sees its predecessor's refined prompts and can
// compose match cuts / motion vectors against the actual neighbor text.
//
// Three outputs per call:
//   - video_prompt        — what happens in the clip. Assumes the start frame
//                           image exists; describes camera motion + subject
//                           action. This is what gets sent to the video model.
//   - start_frame_prompt  — still-image prompt for the opening composition.
//   - end_frame_prompt    — still-image prompt for the closing composition
//                           (same shot, motion progressed) — useful for video
//                           models that condition on a final frame.
const REFINE_TOOL = {
  name: 'refine_storyboard_frame',
  description:
    'Produce the video-gen prompt and the start-frame / end-frame still-image prompts ' +
    'for ONE storyboard frame, given the full outline and the previously refined frames. ' +
    'The video_prompt describes what HAPPENS in the clip (camera + subject motion) assuming ' +
    'the start frame already exists. The start_frame_prompt and end_frame_prompt are static ' +
    'image descriptions for the opening and closing compositions of the same shot.',
  input_schema: {
    type: 'object',
    properties: {
      video_prompt: {
        type: 'string',
        description:
          'Clip-gen prompt for the image-to-video model. Assume the start frame image already exists; describe what HAPPENS during the clip — camera motion (or hold), subject action, what changes. ~2 sentences. Do NOT re-describe the start composition (that is already locked in by the start frame image); lead with the motion. Example: "Sarah turns her head a quarter to look toward the doorway; camera holds. Hair settles, breath visible." One simple camera motion per shot, or none. No reveals, no rotations, no two-subject contact, no readable text — see the system prompt\'s video constraints.',
      },
      start_frame_prompt: {
        type: 'string',
        description:
          'Concrete still-image prompt for the START frame: subject, action, framing, lighting, mood. ~2 sentences. Will be passed to the image generator together with character/set reference photos — do not re-describe face/wardrobe/location.',
      },
      end_frame_prompt: {
        type: 'string',
        description:
          'Concrete still-image prompt for the END frame (the same shot moments later, showing motion progression from the start). Same camera, same composition, slightly different pose/position. NOT a different angle, NOT a different beat. ~2 sentences.',
      },
      reverse_in_post: {
        type: 'boolean',
        description:
          'Optional override. Set to TRUE if you detect that the outline frame requires a reveal-in-reverse but was not marked reverse_in_post by the outline planner — i.e. the shot would have to contain a new subject / new element / a camera move that arrives on a subject that was not visible at the start. When you set this to true, you MUST invert the temporal direction across all three outputs: write start_frame_prompt as the FINAL revealed state (subject centered, fully visible), end_frame_prompt as the INITIAL hidden state (camera pulled back / subject exited / element occluded), and video_prompt as the camera move IN GENERATION DIRECTION (push-in, subject shrinks/exits) — the clip will be reversed in post and the audience experiences the reveal. Set to FALSE only if you explicitly disagree with an outline that marked reverse_in_post: true. Omit (leave undefined) to inherit the outline\'s value.',
      },
    },
    required: ['video_prompt', 'start_frame_prompt', 'end_frame_prompt'],
    additionalProperties: false,
  },
};

// Stage A system prompt — covers shot list / coverage / rhythm / continuity.
// Trimmed: the start/end-prompt rules move to the Stage B system prompt so
// each call ships the smallest input it needs. Exported so the SPA's prompt
// preview tab can render the exact text the planner will see.
export const OUTLINE_SYSTEM_PROMPT = [
  'You are a Hollywood storyboard artist breaking a screenplay beat into a cinematic shot list. Return your plan via the plan_storyboard_outline tool.',
  '',
  '# FRAME COUNT IS NON-NEGOTIABLE',
  '- The user message specifies an EXACT target frame count. You MUST produce that many frames — not fewer, not more.',
  '- If you think the beat could be told in fewer frames, pad with embellishment shots until you hit the count: establishing wides, set details, atmospheric cutaways, prop inserts, reaction close-ups, alternate-angle coverage of the same moment.',
  '- A "short" beat at a 30-frame count is a stylistic choice by the director — interpret it as "give this beat extended, deliberate coverage" and deliver the full count.',
  '',
  'Each frame is one visually distinct moment with a concrete shot description (camera angle, who is in frame, what they are doing).',
  "Do not invent characters that aren't already in the beat's character list.",
  '',
  '# Coverage and rhythm',
  '- Plan for cinematic rhythm, not just narrative coverage. Pad the shot list with embellishment shots:',
  '  - Open with an establishing wide of the location.',
  '  - Insert close-ups for objects, hands, eyes, props that carry meaning.',
  '  - Reaction close-ups after key beats.',
  '  - Atmospheric cutaways (rain on glass, ticking clock, empty hallway) when the beat needs breathing room.',
  '  - Use over_the_shoulder for two-person dialogue.',
  '- Vary framing across the sequence — wides, mediums, close-ups in rotation, not three close-ups in a row.',
  '',
  '# Adjacency / continuity',
  '- Adjacent frames must hand off cleanly. The shot following another should pick up something the previous shot left — a shared subject, a matching motion vector, or a deliberate match cut.',
  '- Use transition_in on each frame after the first to state the continuity link in one sentence.',
  '',
  '# AI video generation constraints (Kling / Veo / Sora)',
  'These shots will be animated by an AI image-to-video model. The model has fixed flaws — plan the shot list around them, not against them.',
  '',
  '## These rules OVERRIDE the beat\'s literal description',
  'The beat description is written for narrative clarity, not for the video model. It may say "the camera pans to reveal X", "Sarah enters through the door", "the building rises into view as we approach", "a crowd parts to show the hero". You must NOT plan such shots in their literal forward direction — the model cannot synthesize them and the resulting clip will be broken.',
  '',
  'Decision order when the beat asks for a rule-violating shot:',
  '1. If the violation is a SPATIAL reveal or entry (subject becomes visible, element enters frame, camera arrives on a subject) → set reverse_in_post: true on the frame and rewrite the description as the REVERSED action (start with the subject centered, end with the subject smaller / exited / occluded). See "Reveal-shot pattern" below.',
  '2. If the violation is NOT invertible (lighting state change, irreversible physics, audio-driven beat, camera turn/tilt rotation) → substitute with separate static shots that cover the same dramatic content. Spend extra frame count on cuts rather than one impossible move.',
  '3. NEVER emit a forward-revealing or subject-entering shot just because the beat said so. Honoring the beat narrative literally is a planning bug; re-interpreting it into video-gen-friendly coverage is your job.',
  '',
  '## Mandatory reveal / entry detection',
  'Read each beat sentence and your own draft descriptions for these signal phrases. When you find one, you MUST either set reverse_in_post: true (preferred when invertible) or substitute with separate shots.',
  '',
  'Signal phrases that mean "this is a reveal — set reverse_in_post: true":',
  '- "is revealed", "reveals", "we see X for the first time", "comes into view", "appears", "emerges", "rises into view", "materializes"',
  '- "X enters the frame", "X walks in", "X steps into shot", "we discover X", "the door opens to show X"',
  '- "the camera pans to find X", "tracks until X is centered", "pulls out to show X", "lands on X"',
  '- "the building grows from a dot to fill the frame", "starts small and fills the frame"',
  '- end-state contains anything that was not visible at the start',
  '',
  'When you set reverse_in_post: true, write the `description` field as the action that the camera/subject performs DURING GENERATION (which is the reverse of the audience experience). Example:',
  '  Beat says: "The skyscraper looms into view as we slowly tilt up from the street, dwarfing the heroes."',
  '  WRONG forward plan: description "Slow tilt-up the building from street to spire" (rotation, can\'t be reversed, can\'t be synthesized).',
  '  WRONG forward-reveal plan: description "Camera pulls back from the street to reveal the full skyscraper" (push-out reveal, forward-direction is unsynthesizable).',
  '  RIGHT reverse-in-post plan: description "Skyscraper centered in frame; camera slowly pushes in toward the building so it fills the frame more by the end. (Generated in reverse for the reveal — reverse the clip in post: audience sees the building shrink-to-grow / pull-out reveal.) reverse_in_post: true."',
  '',
  'When reverse_in_post will NOT work — substitute with cuts:',
  '- Lighting changes ("the lamp turns on", "dawn breaks") — both directions fail. Use two static shots, one per state.',
  '- Irreversible physics ("the vase shatters", "the door slams") — use a cut from before to after.',
  '- Camera-rotation reveals (yaw/pitch — "the camera turns to look at…", "tilts up the building") — neither direction is synthesizable. Substitute with multiple static angles of different parts of the subject.',
  '- Audio-driven beats ("the music swells as the camera rises") — substitute with static coverage; audio is added in post anyway.',
  '',
  '## Verification step (do this before emitting the frames array)',
  'For each frame you have drafted, walk through this checklist:',
  '1. Does the end-state of the shot show anything that is NOT in the start-state? (a person, an object, a building, an environment) → set reverse_in_post: true and rewrite the description, OR split into two static shots.',
  '2. Does the description mention the camera turning, pivoting, tilting, or arriving on a subject? → these are rotation-based reveals; reverse_in_post does NOT fix rotation. Substitute with static coverage from the discovered angle.',
  '3. Does the description mention extras entering, crowds moving independently, hand details, readable text, mirrors, reflections, lighting changes, or two-subject contact (handshake/hug/kiss/fight)? → rewrite the description to avoid those elements. Cut around them with inserts or alternate framing.',
  '4. Is the camera doing more than one motion (push-in then tilt; lateral then turn)? → keep one simple motion per shot, or none.',
  'A frame that fails any of these checks is a planning bug. Fix it before emitting.',
  '',
  'Avoid in any frame:',
  '- Crowds, background extras, or any third person in a two-shot. Identity drifts; faces morph. If a beat happens "in a crowded bar", shoot tight close-ups and inserts that frame the named characters cleanly against a dark / blurred background.',
  "- Subjects entering the frame from off-screen mid-shot. The model can't spatially anchor new elements — write the shot so everyone who matters is already on-screen at the first frame. Subjects LEAVING frame is fine. Random extras drifting into frame is the worst-case glitch source.",
  '- Camera moves that reveal new subjects. A pan that finishes on a previously-hidden character is a "reveal", which fails for the same reason. For deliberate reveals, see the reverse-in-post pattern below.',
  '- Subjects partially obscured by foreground (foliage, bars, crowd silhouettes, fences, glass) when the camera is moving. The model warps the occluder over the subject. Static camera + occluder is OK; moving camera + occluder is not.',
  '- Mirrors, water reflections, polished glass showing a reflection of a character. The reflection drifts independently of the source.',
  '- Readable text or logos that the audience is supposed to read. Signs, screens, books, t-shirt slogans, license plates, badges — they warp into gibberish. If text matters, describe it as off-screen ("Sarah reads the headline" without showing the page) or as an insert close-up so short the warp doesn\'t have time to develop.',
  '- Precise hand action: writing, typing, threading a needle, counting bills, tying a knot, juggling. Fingers merge. Use an insert close-up of the result instead of the action.',
  '- Two-character contact: handshakes, hugs, kisses, fights, dancing. Limbs merge and identities swap. Cover with alternating singles or over-the-shoulder, not the contact itself.',
  '- Subjects passing in front of each other in the same shot. Identity swap is near-guaranteed. Stage them at different depths, or cut between them.',
  '- Lighting changes mid-shot (a lamp turning on, day shifting to night, a flash going off). The model cannot transition lighting states.',
  '',
  'Prefer in any frame:',
  '- One subject centered. Two-shots are OK but every additional named character compounds drift.',
  '- Subject(s) clearly silhouetted against a simple background — a wall, a dark interior, sky, blurred bokeh. Busy textured backgrounds dissolve under camera motion.',
  '- Actions whose start AND end pose are clearly imaginable inside the shot\'s duration: a head turning, a glance shifting, a hand lifting a cup, a slow nod, fabric or hair caught in a breeze, smoke rising, rain hitting a window. Ambient motion is the model\'s strongest suit.',
  '',
  '# Camera motion hierarchy',
  'The AI video model does not have a true 3D understanding of the scene — it animates what it can see in the start frame, but it cannot reconstruct space that was never in frame. Pick the camera move accordingly. Prefer choices higher on this list; treat lower ones with caution; never use what is in the "Avoid" list.',
  '',
  'Best → acceptable (use this hierarchy when describing how the camera behaves in the shot):',
  '  1. Locked-off / tripod static. The single most reliable choice. No new space ever has to be invented. When in doubt, pick this.',
  '  2. Subtle handheld breath — micro-shake or small drift while the camera stays essentially in place. Adds life without inventing space.',
  '  3. Slow push-in toward the subject along the subject axis. The model just enlarges what is already in frame; near-perfect stability.',
  '  4. Slow pull-out from the subject along the subject axis. Works, but requires the model to invent peripheral background — keep it short and ensure the surrounding space is simple.',
  '  5. Slow lateral move (camera trucks left or right while keeping the subject framed). Only when the destination area is continuous and similar to the starting frame (a wall continues, a hallway extends, a sky stretches). Risky over complex backgrounds.',
  '',
  'Avoid entirely (these break the model):',
  '- The camera turning / pivoting in place to look at something off-frame (yaw rotation — "the camera turns to reveal…", "we pan from Alice over to Bob"). The model has no reference for what is off-axis and will hallucinate. This is true even for slow turns. If you need this beat, cover it with two shots instead of one.',
  '- The camera tilting up or down to reveal a new subject (pitch rotation). Same failure mode as turning.',
  '- Crane, jib, drone, aerial, and Steadicam-following moves. Any vertical, arcing, or subject-tracking trajectory.',
  '- Whip pans, fast zooms, dolly-zooms (Vertigo effect), rolls, sweeps, orbits around a subject.',
  '- Two-stage moves in one shot (push-in then tilt-down; lateral then turn). One simple motion per shot, or none.',
  '',
  'Style note: shots that survive video gen best are the ones where the camera does not move and only the subject moves slightly. When the beat naturally calls for camera motion (a chase, a discovery, a reveal), substitute static coverage from multiple angles instead — or use the reverse-in-post pattern below for reveals.',
  '',
  '# Reveal-shot pattern (reverse in post)',
  'When the beat requires a SPATIAL reveal (a subject becoming visible, an element entering, a camera arriving on a subject), you MUST NOT plan it as a forward shot. The video model cannot synthesize forward reveals coherently — the previously-hidden element appears as a glitch.',
  '',
  'Plan it backwards: the shot STARTS with the reveal target centered in frame (fully visible), and ENDS with the camera pulled away / the subject exited / the element shrunk. Set reverse_in_post: true on that frame. The video is played in reverse during post, producing a coherent reveal that the model could not synthesize forwards.',
  '',
  'Worked example — beat says "we slowly pan across the empty diner to find Sarah hiding in the corner booth":',
  '  description: "Sarah sits centered in the corner booth (fully revealed start). Camera slowly pulls back and trucks left until she is small against the empty diner. (Generated in reverse — reverse the clip in post for the discovery effect.)"',
  '  shot_type: cinematic_wide',
  '  duration_seconds: 5',
  '  reverse_in_post: true',
  '',
  'This is not optional or stylistic. Any shot that matches a signal phrase in the Mandatory reveal / entry detection section above MUST be planned this way. If the reveal is not spatially invertible (lighting, rotation, physics), substitute with cuts as described in the decision order.',
  '',
  '# Duration discipline',
  '- Video drift grows with clip length. For each shot_type, pick the SHORTEST duration that still feels like the shot has read. Default to the lower half of the allowed range:',
  '  - establishing / cinematic_wide / insert → prefer 5–8s, 15s only for slow atmospheric shots with near-static framing',
  '  - medium → prefer 4–6s',
  '  - close_up / reaction / two_shot / over_the_shoulder → prefer 2–4s',
  '- A storyboard of many short shots survives video gen better than one of few long shots. If you have headroom in frame count, prefer cutting more.',
  '',
  '# Audio',
  '- Generated audio is unreliable and will be replaced in post. Do not write the description as if it were dialogue or sound design — describe the visible action only.',
  '',
  '# Hard constraints',
  '- Maximum 2 named characters in characters_in_scene per frame. If a beat has 4 people in a room, alternate coverage (two_shot of A+B, then two_shot of C+D, then a wide).',
  '- shot_type drives duration_seconds:',
  '  - establishing / cinematic_wide / insert → 1..15s',
  '  - medium → 1..10s',
  '  - close_up / reaction → 1..5s',
  '  - two_shot / over_the_shoulder → 1..5s',
  '- The director may attach free-form direction in the user message; honor it within the constraints above.',
  '- Final reminder: emit EXACTLY the number of frames requested in the user message. Under-delivering is a bug.',
].join('\n');

// Pass-1 scene-planner tool: scene bible + ordered shot skeleton in one call.
const SCENE_PLAN_TOOL = {
  name: 'plan_scene',
  description:
    'Design the whole scene: first a compact scene bible (the unified visual look every shot inherits), ' +
    'then an ordered shot skeleton covering the entire beat. Do NOT write detailed video / still prompts here.',
  input_schema: {
    type: 'object',
    properties: {
      scene_bible: {
        type: 'object',
        description:
          'The unified visual plan for the whole scene. Every shot inherits this, so keep each field concrete and consistent.',
        properties: {
          location: { type: 'string', description: 'Where the scene takes place, concretely.' },
          time_of_day: { type: 'string', description: 'Time of day / part of day.' },
          lighting_key: { type: 'string', description: 'Lighting key and sources, e.g. "warm low practical + cool fill".' },
          palette: { type: 'string', description: '3–5 anchor colors / overall grade.' },
          mood: { type: 'string', description: 'Tonal one-liner.' },
          blocking: { type: 'string', description: 'Character geography: who is where in the space and their spatial relationships.' },
          continuity_anchors: { type: 'string', description: 'Props, wardrobe states, weather that must stay constant across shots.' },
          camera_language: { type: 'string', description: 'The scene default camera grammar, e.g. "mostly locked-off, occasional slow push".' },
        },
        required: ['location', 'time_of_day', 'lighting_key'],
        additionalProperties: false,
      },
      frames: {
        type: 'array',
        description: 'Ordered shot skeleton covering the entire beat.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'One-sentence narrative summary of what happens in this shot.' },
            shot_type: {
              type: 'string',
              enum: [...SHOT_TYPES],
              description:
                'Framing/coverage class. establishing/cinematic_wide/insert ≤ 15s, medium ≤ 10s, close_up/reaction/two_shot/over_the_shoulder ≤ 5s.',
            },
            duration_seconds: { type: 'integer', minimum: 1, maximum: 15, description: 'On-screen hold time; respect the shot_type cap.' },
            transition_in: { type: 'string', description: 'One-line continuity note: how this shot picks up from the previous one. Empty for the first shot.' },
            characters_in_scene: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of characters visible in this shot, exactly as listed in the beat metadata. AT MOST 2.',
            },
            reverse_in_post: { type: 'boolean', description: 'True for spatial reveal/entry shots that must be generated backwards and reversed in post.' },
          },
          required: ['description', 'shot_type', 'duration_seconds'],
          additionalProperties: false,
        },
      },
    },
    required: ['scene_bible', 'frames'],
    additionalProperties: false,
  },
};

export const SCENE_PLAN_SYSTEM_PROMPT = [
  'You are a Hollywood storyboard artist and DP planning a whole scene from a screenplay beat. Return your plan via the plan_scene tool.',
  '',
  '# Two jobs',
  '1. Write the SCENE BIBLE — a compact, unified visual plan (location, time of day, lighting key, palette, mood, blocking, continuity anchors, camera language). Every shot will inherit this, so make it concrete and self-consistent. Derive it from the beat body, description, characters, and director guidance.',
  '2. Plan the ordered SHOT SKELETON — one entry per shot, covering the whole beat with cinematic rhythm.',
  '',
  '# FRAME COUNT IS NON-NEGOTIABLE',
  '- The user message specifies an EXACT target shot count. Emit exactly that many frames — not fewer, not more.',
  '- If the beat is short, pad with embellishment shots (establishing wides, inserts of props/hands/eyes, reaction close-ups, atmospheric cutaways, alternate-angle coverage).',
  '',
  '# Coverage and rhythm',
  '- Open with an establishing wide. Vary framing (wides, mediums, close-ups in rotation, not three close-ups in a row). Use over_the_shoulder for two-person dialogue.',
  '- Adjacent shots must hand off cleanly: a shared subject, a matching motion vector, or a deliberate match cut. State the link in transition_in.',
  '',
  '# Reveals',
  REVEAL_HANDLING,
  '',
  '# Camera grammar to plan around',
  CAMERA_MOTION_RULES,
  '',
  '# Hard constraints',
  '- Maximum 2 named characters per shot. If a beat has 4 people, alternate coverage.',
  '- shot_type drives duration_seconds: establishing/cinematic_wide/insert ≤ 15s, medium ≤ 10s, close_up/reaction/two_shot/over_the_shoulder ≤ 5s. Prefer the lower half of the range — shorter clips survive video gen better.',
  "- Don't invent characters not in the beat's character list.",
  '- Emit EXACTLY the requested number of frames.',
].join('\n');

// Stage B system prompt — covers the three outputs (video_prompt,
// start_frame_prompt, end_frame_prompt) in detail so the per-frame refinement
// call produces tight, generator-ready text.
const REFINE_SYSTEM_PROMPT = [
  'You are a Hollywood storyboard artist writing the prompts for ONE frame of an already-planned shot list. Return your prompts via the refine_storyboard_frame tool.',
  '',
  'Your prompts will be passed to image / video generators together with reference photographs of each named character and the set. So:',
  "- Describe action, framing, composition, and camera lighting only. Do NOT re-describe a character's face, body, or wardrobe — the reference photo carries that.",
  '- Do NOT re-describe the location, lighting palette, or mood — the set reference carries that. You may direct camera lighting (e.g. "lit from below", "harsh key light").',
  '',
  '# Three outputs per frame',
  'You produce three pieces of text per frame; they have different jobs:',
  '',
  '1. **video_prompt** — the clip-gen prompt. This goes to an image-to-video model (Kling / Veo / Sora) together with the start frame image. The start frame image is already going to anchor the composition, so DO NOT re-describe it. Describe ONLY what HAPPENS during the clip: subject action, what changes, and the camera move (or hold). One simple camera motion per shot, or none. ~2 sentences.',
  '   Good: "Sarah turns her head a quarter to look toward the doorway. Camera holds; her hair settles."',
  '   Good: "Slow push-in toward Sarah; she lifts her gaze from the table to camera."',
  '   Bad (re-describes the start frame): "Wide shot of Sarah at the kitchen table; she turns her head." ← the framing is already locked by the start frame image.',
  '   Bad (too much motion): "Sarah turns, stands up, walks across the room and opens the door." ← that is a different shot, not one clip.',
  '',
  '2. **start_frame_prompt** — a still-image prompt for the opening composition. Subject, action, framing, lighting, mood. ~2 sentences. This image becomes the anchor frame the video model conditions on.',
  '',
  '3. **end_frame_prompt** — a still-image prompt for the SAME shot moments later, showing motion progression. Same camera, same composition, slightly different pose / position. NOT a different angle, NOT a different beat. ~2 sentences. Useful for video models that take an end-frame conditioning image.',
  '',
  'Example of a coherent triple for the same frame:',
  '  start_frame_prompt: "Sarah stands in the doorway, hand on the knob, glancing back over her shoulder. Wide shot, hallway behind her, dim warm practical light from a sconce."',
  '  end_frame_prompt:   "Sarah\'s hand has turned the knob a quarter-turn; her gaze has shifted forward into the room. Same wide shot, same hallway, same sconce."',
  '  video_prompt:       "Sarah turns her gaze from over her shoulder forward into the room and twists the doorknob a quarter-turn. Camera holds."',
  'Example of a BAD end_frame_prompt (do NOT do this): "Sarah enters the room and looks around at the furniture." ← too much progression; that is a different shot.',
  '',
  '# Continuity with neighbors',
  '- The user message shows the full outline and the previously refined frames so you can compose your start_frame_prompt to pick up the prior shot\'s end_frame_prompt (shared subject, motion vector, match cut), and so your video_prompt motion vector lines up with the prior frame\'s motion.',
  '- Honor the outline frame\'s description, shot_type, transition_in, and characters_in_scene. Do not contradict them.',
  '',
  '# AI video generation rules for video_prompt',
  'video_prompt is the motion source for an image-to-video model. Compose accordingly:',
  '',
  'Camera motion — pick at most one, and prefer the top of this list:',
  '- Locked-off / tripod static — the camera does not move; only the subject moves. Most reliable.',
  '- Subtle handheld breath — micro-shake or small drift while the camera stays in place.',
  '- Slow push-in along the subject axis (camera moves closer to subject).',
  '- Slow pull-out along the subject axis. Keep it short; the model has to invent peripheral background.',
  '- Slow lateral truck (left or right) — only when the destination space is continuous and simple.',
  '',
  'NEVER describe the camera doing any of these in video_prompt (they break the model):',
  '- Turning / pivoting in place to look at something off-frame (yaw rotation) — "the camera pans to…", "we pan from Alice over to Bob". The model cannot reference off-axis space.',
  '- Tilting up or down to reveal a new subject (pitch rotation) — "the camera tilts up the building".',
  '- Whip pans, fast zooms, dolly-zooms (Vertigo effect), rolls, sweeps, orbits.',
  '- Crane / jib / drone / aerial / Steadicam-following moves. Any vertical, arcing, or subject-tracking trajectory.',
  '- Two-stage moves in one shot (push-in then tilt-down; lateral then turn).',
  '',
  'Subject motion — keep it constrained:',
  '- A head turn, a gaze shift, a hand lifting, weight shifting, fabric or hair moving, smoke rising, rain falling. Ambient or single-vector motion is the model\'s strongest suit.',
  '- Do NOT introduce new people or new props mid-clip ("Alice walks in", "she pulls out a knife"). Every subject the clip ends with must already be in the start frame.',
  '- Do NOT describe two-character contact (handshake, hug, kiss, struggle, dance) — limbs merge and identities swap. Cover with cuts between singles instead.',
  '- Do NOT describe subjects passing in front of each other within the shot — identity swap.',
  '- Do NOT describe lighting changes mid-clip (a lamp turning on, headlights sweeping, a flash) — the model cannot transition lighting states.',
  '- Do NOT describe precise hand action (writing, typing, counting bills, threading, tying) — fingers merge.',
  '- Do NOT describe vehicle wheels spinning, gear mechanisms turning, clock hands moving fast — the model warps repeating geometry.',
  '- Do NOT write dialogue, voice-over, or sound effects. Audio is added in post.',
  '',
  '# AI generation rules for start_frame_prompt and end_frame_prompt (the stills)',
  'These become reference frames. Compose for clean image generation AND so the start-frame image gives the video model the best possible anchor:',
  '',
  'start_frame_prompt — the opening still:',
  '- Place the subject (or both subjects in a two-shot) centered in frame, not touching the edges. The model warps subjects that start clipped at the edge.',
  "- Subjects should be unoccluded. If there's foreground (railings, foliage, a crowd), keep it clean of the subject's silhouette.",
  '- Specify a simple, separable background ("dark interior", "soft blurred street lights", "plain plaster wall") whenever the set reference allows it. Busy textured backgrounds dissolve under camera motion.',
  '- Do NOT describe the camera arriving on the subject from off-frame. The opening still is the WHOLE composition.',
  '',
  'end_frame_prompt — the closing still, a beat or two later:',
  '- Every person who was in the start_frame_prompt must STILL BE IN FRAME. No one leaves, no one enters, the camera does not re-frame to exclude or include anyone.',
  '- Do NOT introduce any new element — no new person, no new prop arriving in the hand, no new light source. Describe only what was already in the start frame, slightly evolved.',
  '- Keep the change small: a head turn, a gaze shift, a hand reaching, weight shifting, fabric or hair moved. If the change feels like a different shot, it is too much.',
  '- The framing must match the start frame (same focal length, same camera position) unless the video_prompt explicitly involves a push-in / pull-out — in which case the end frame may show the subject larger or smaller, but never different angle / different side.',
  '',
  'Things the model cannot draw cleanly — avoid in any still:',
  '- Crowds or background extras moving independently. Frame to keep only the named subject(s) sharp; let the background blur.',
  '- Mirrors, water reflections, polished glass reflections of a character.',
  "- Readable text (signs, books, screens) that the audience is meant to read. If text matters, use an insert so brief the warp doesn't develop.",
  '',
  '# Reverse-in-post shots',
  '- If the outline frame has reverse_in_post: true, you MUST INVERT the temporal direction across all three outputs. The clip will be played backwards in post; from the audience\'s perspective the camera "discovers" the subject.',
  '  - start_frame_prompt = the FINAL revealed state (subject centered, fully visible).',
  '  - end_frame_prompt   = the INITIAL hidden state (camera pulled back, subject small or partially out of frame).',
  '  - video_prompt       = the camera move IN GENERATION DIRECTION (e.g. "slow pull-out from the subject; subject shrinks to lower frame", or "subject exits screen-right as camera holds"). The video model generates this; post reverses it.',
  '',
  '# You are the second line of defense for the reveal-in-reverse rule',
  'The outline planner is supposed to mark every reveal / entry shot with reverse_in_post: true. It will sometimes miss one — especially when the beat narrative uses forward-reveal language ("the building is revealed as we pull back", "Sarah enters the room", "we pan across to find the killer") and the outline took it literally.',
  '',
  'Before you write your three outputs, look at the outline frame\'s description and ask:',
  '1. Would the end_frame_prompt have to contain a person, object, or environment that was NOT visible in the start_frame_prompt?',
  '2. Would the video_prompt require the camera to arrive on a subject that was not visible at the start?',
  '3. Does the description say the camera reveals / discovers / arrives on / pans-to-find / pulls-back-to-show anything?',
  '4. Does the description mention a subject entering the frame, walking in, stepping into view, emerging, materializing, rising into view?',
  '',
  'If you answer yes to ANY of these AND the outline frame has reverse_in_post: false (or unset), you MUST:',
  '  a. Set reverse_in_post: true in your tool call to override the outline.',
  '  b. INVERT the temporal direction across all three outputs (per the reverse-in-post rules above). NEVER write a forward-reveal in any of the three.',
  '',
  'If the violation is NOT spatially invertible — lighting change, irreversible physics (vase breaking, door slamming), camera-rotation reveal (yaw/pitch turn to look at something new), or audio-driven beat — leave reverse_in_post false and write CONSERVATIVE prompts that ignore the violation. Pick the most visually-complete moment of the shot as the start_frame_prompt; make end_frame_prompt a minimal motion-progression from there; make video_prompt a tiny subject motion with the camera held. Better to ship a usable static-feeling clip than a glitching forward-reveal.',
  '',
  'Worked example. Outline frame says: "The skyscraper looms into view as we slowly tilt up from the street, dwarfing the heroes." reverse_in_post: false.',
  '  This is a rotation (tilt) reveal — NOT invertible. Leave reverse_in_post: false. Write conservative outputs:',
  '    start_frame_prompt: "Wide low-angle shot of the skyscraper filling the frame from base to spire, glass facade reflecting overcast sky. The two heroes stand small at frame bottom, looking up."',
  '    end_frame_prompt:   "Same wide low-angle of the skyscraper. The heroes have shifted slightly — one has taken a half-step back, the other tilts her head a fraction more. The building and framing are unchanged."',
  '    video_prompt:       "Heroes at frame bottom shift weight subtly — one half-steps back, the other tilts her head up another degree. Camera holds locked-off."',
  '  The shot ends up reading as a moment of awe rather than a tilt-up — acceptable degradation.',
  '',
  'Worked example. Outline frame says: "Camera slowly pulls back from a close-up of the postcard to reveal Sarah holding it at her kitchen table." reverse_in_post: false.',
  '  This is a SPATIAL pull-out reveal — IS invertible. Override the outline:',
  '    reverse_in_post: true',
  '    start_frame_prompt: "Medium shot of Sarah at her kitchen table holding the postcard up to read it, soft window light from screen-left, the postcard\'s image clearly visible in her hands."',
  '    end_frame_prompt:   "Same medium of Sarah, but the camera has slowly pushed in toward the postcard — Sarah\'s hands and the postcard now fill more of the frame, her face just visible behind."',
  '    video_prompt:       "Slow push-in toward the postcard in Sarah\'s hands; the postcard grows to fill the frame, her face recedes behind it. Sarah\'s hands stay steady."',
  '  The video model generates this push-in; post reverses it; the audience experiences a pull-out reveal.',
  '',
  '# Constraints',
  '- ~2 sentences per output. Concrete and visual. No wardrobe / face / location re-description.',
  '- video_prompt is action-only (and camera move) — do not re-describe what the start frame looks like.',
  '- The director may attach free-form direction in the user message; honor it within the constraints above.',
].join('\n');

let dispatcherOverride = null;
export function _setImageDispatcherForTests(fn) {
  dispatcherOverride = fn;
}

// Single image-generation entry point. Tests override this; production routes
// through the model dispatcher. Args carry the model + mode so the override
// can assert which path the pipeline picked.
async function callGenerateImage(args) {
  if (dispatcherOverride) return dispatcherOverride(args);
  return dispatchStoryboardImage(args);
}

// Test hooks for the two-stage planner. Outline override returns the raw
// outline array (objects with description/shot_type/duration_seconds/...).
// Refiner override returns { video_prompt, start_frame_prompt,
// end_frame_prompt, reverse_in_post } or null. Both default to the production
// Anthropic-backed implementations.
let outlinePlannerOverride = null;
export function _setOutlinePlannerForTests(fn) {
  outlinePlannerOverride = fn;
}

let frameRefinerOverride = null;
export function _setFrameRefinerForTests(fn) {
  frameRefinerOverride = fn;
}

// Pass-1 scene-planner override. Returns { sceneBible, outline }.
let scenePlannerOverride = null;
export function _setScenePlannerForTests(fn) {
  scenePlannerOverride = fn;
}

// In-memory job tracker. Sufficient for single-process runtime; status survives
// only as long as the process. The SPA polls /api/storyboards/generate/:job_id.
const jobs = new Map();

function makeJobId() {
  return new ObjectId().toString();
}

// Cap on per-job event log — generation produces ~6 events per frame plus a
// handful of bookkeeping events, so 100 covers a max-size beat (30 frames)
// with headroom. Oldest events are dropped when the cap is hit.
const MAX_JOB_EVENTS = 100;

// Append a progress event to the job AND update the "current step" snapshot.
// `progress` is what the SPA renders as the single big status line; `events`
// is the scrollable history. Also emits a structured logger.info line so the
// backend log shows the same beat-by-beat trace. Safe to call before `job`
// fully exists — no-ops when job is null/undefined.
function recordProgress(job, { phase, step, frame = null, total = null, message }) {
  if (!job) return;
  const ts = new Date();
  const entry = { ts, phase, step, frame, total, message };
  job.progress = { ...entry, started_at: ts };
  if (!Array.isArray(job.events)) job.events = [];
  job.events.push(entry);
  if (job.events.length > MAX_JOB_EVENTS) {
    job.events.splice(0, job.events.length - MAX_JOB_EVENTS);
  }
  const framePart = frame && total ? ` [${frame}/${total}]` : '';
  logger.info(`storyboard gen ${job.job_id} [${phase}/${step}]${framePart} ${message}`);
}

export function getStoryboardGenerationJob(jobId) {
  return jobs.get(jobId) || null;
}

export class BeatBusyError extends Error {
  constructor(beatId) {
    super(`Storyboard work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

export async function startStoryboardGenerationJob({
  beatId,
  targetCount,
  imageModel = 'gemini',
  direction = '',
  announceUsername = null,
}) {
  const beat = await getBeat(beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  const cleanDirection = sanitizeDirection(direction);
  const resolvedCount = clampTargetCount(targetCount);
  // Both stages run on STORYBOARD_MODEL. Tracked as separate job fields so the
  // SPA progress display can show which model is doing what; today they are
  // always the same, but the structure stays in case we ever split them.
  const outlineModel = STORYBOARD_MODEL;
  const refineModel = STORYBOARD_MODEL;
  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    beat_id: beat._id.toString(),
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planned: 0,
    completed: 0,
    failed: 0,
    direction: cleanDirection,
    target_count_requested: resolvedCount,
    outline_model: outlineModel,
    refine_model: refineModel,
    image_model: imageModel,
    refine_failures: 0,
    progress: null,
    events: [],
  };
  jobs.set(jobId, job);
  recordProgress(job, {
    phase: 'queued',
    step: 'job_queued',
    message: `Queued — target ${resolvedCount} frames`,
  });
  // Fire and forget; errors are recorded on the job. Holding the per-beat lock
  // for the duration prevents concurrent generates and edit calls from racing
  // the delete-then-recreate window.
  withBeatLock(beat._id, () =>
    runStoryboardGenerationJob({
      job,
      beat,
      targetCount: resolvedCount,
      direction: cleanDirection,
      announceUsername,
    }),
  ).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'error',
      step: 'job_crashed',
      message: `Generation crashed: ${e.message}`,
    });
    logger.error(`storyboard gen job ${jobId} crashed: ${e.message}`);
  });
  return jobId;
}

async function runStoryboardGenerationJob({
  job,
  beat,
  targetCount,
  direction,
  announceUsername = null,
}) {
  // Plan first. If the planner returns nothing (model failure, rate limit,
  // empty body) we preserve the user's existing storyboards rather than
  // wiping them for no result.
  job.status = 'planning';
  recordProgress(job, {
    phase: 'planning',
    step: 'plan_outline_start',
    message: `Planning shot list with ${job.outline_model}…`,
  });
  const characterDocs = await findCharactersInBeat(beat);
  // Director's notes are project-wide guidance; fetch once and pass to both
  // stages so every refinement call sees the same notes without re-querying.
  const directorNotes = await loadDirectorNotesForPlanner();
  const planned = await planFrames({
    beat,
    characters: characterDocs,
    targetCount: targetCount || DEFAULT_TARGET_COUNT,
    direction: direction || '',
    directorNotes,
    onRefineFailure: () => {
      job.refine_failures += 1;
    },
    onProgress: (fields) => recordProgress(job, fields),
    refineModel: job.refine_model,
  });
  job.planned = planned.length;
  if (!planned.length) {
    job.status = 'done';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'done',
      step: 'job_done_empty',
      message: 'Planner returned no frames — existing storyboards preserved.',
    });
    logger.warn(
      `storyboard gen job ${job.job_id} produced no frames; existing items preserved`,
    );
    return;
  }
  // Now that we know we have a plan, clear the existing storyboards so the
  // SPA shows an empty list while new items stream in.
  await deleteAllStoryboardsForBeatViaGateway({ beatId: beat._id });
  job.status = 'rendering';
  recordProgress(job, {
    phase: 'rendering',
    step: 'render_start',
    total: planned.length,
    message: `Creating ${planned.length} storyboard row${planned.length === 1 ? '' : 's'}…`,
  });
  // Auto frame-image generation has been removed: this loop only persists the
  // planned shot list as storyboard rows (text_prompt, shot_type, duration,
  // transition_in, characters_in_scene) and seeds each frame's reference
  // list with beat + character images. Users render start/end frames on
  // demand via the SPA's per-row regen flow (startFrameGenerationJob).
  for (let index = 0; index < planned.length; index++) {
    const frame = planned[index];
    const order = index + 1;
    const frameStart = Date.now();
    recordProgress(job, {
      phase: 'rendering',
      step: 'frame_start',
      frame: order,
      total: planned.length,
      message: `Frame ${order}/${planned.length}: creating row (${frame.shot_type || 'shot'})…`,
    });
    try {
      await createPlannedStoryboardEntry({
        beat,
        frame,
        order,
      });
      job.completed += 1;
      const elapsed = ((Date.now() - frameStart) / 1000).toFixed(1);
      recordProgress(job, {
        phase: 'rendering',
        step: 'frame_done',
        frame: order,
        total: planned.length,
        message: `Frame ${order}/${planned.length}: row created in ${elapsed}s`,
      });
    } catch (e) {
      job.failed += 1;
      const elapsed = ((Date.now() - frameStart) / 1000).toFixed(1);
      recordProgress(job, {
        phase: 'rendering',
        step: 'frame_failed',
        frame: order,
        total: planned.length,
        message: `Frame ${order}/${planned.length}: failed after ${elapsed}s — ${e.message}`,
      });
      logger.warn(
        `storyboard gen frame ${order}/${planned.length} failed: ${e.message}`,
      );
    }
  }
  job.status = job.failed === 0 ? 'done' : 'partial';
  job.finished_at = new Date();
  const totalElapsed = ((job.finished_at - job.started_at) / 1000).toFixed(1);
  recordProgress(job, {
    phase: 'done',
    step: 'job_done',
    total: planned.length,
    message: `Done — ${job.completed} created, ${job.failed} failed (${totalElapsed}s total)`,
  });
  if (announceUsername && job.completed > 0) {
    try {
      const { announceText } = await import('../discord/announcer.js');
      const { storyboardUrl } = await import('./links.js');
      const url = storyboardUrl(beat);
      const name = stripMarkdown(beat.name || '').trim();
      const order = Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
      const beatLabel = name ? `${order}: ${name}` : order;
      const suffix = job.failed > 0 ? ` (${job.failed} failed)` : '';
      announceText(
        `🎬 ${announceUsername} generated ${job.completed} storyboard frame${job.completed === 1 ? '' : 's'} on ${beatLabel}${suffix}${url ? ` — ${url}` : ''}`,
      ).catch(() => {});
    } catch (e) {
      logger.warn(`batch storyboard announce failed: ${e?.message || e}`);
    }
  }
}

// Resolve every character named in a beat's `characters` list to its current
// Mongo doc. Exported so the SPA's pre-generation sheet picker hits the same
// resolution path that the renderer uses — guaranteeing the dropdown reflects
// what the renderer will actually pick up.
export async function findCharactersInBeat(beat) {
  const out = [];
  for (const raw of beat?.characters || []) {
    const stripped = stripMarkdown(raw || '').trim();
    if (!stripped) continue;
    try {
      const c = await getCharacter(stripped);
      if (c) out.push(c);
    } catch (e) {
      logger.warn(`storyboard gen: character lookup "${stripped}" failed: ${e.message}`);
    }
  }
  return out;
}

// Load image bytes + content type + stored description from GridFS metadata.
// The description (when present, populated by the vision seed worker) is
// returned alongside the bytes so callers can build concordant text+image
// references instead of having to infer everything from pixels alone.
async function loadImageInput(imageId) {
  try {
    const result = await readImageBuffer(imageId);
    if (!result) return null;
    const { buffer, file } = result;
    const ct = file.contentType || file.metadata?.contentType;
    if (!ANTHROPIC_OK.has(ct)) return null;
    const description = String(file.metadata?.description || '').trim();
    const name = String(file.metadata?.name || '').trim();
    return { buffer, contentType: ct, _id: file._id, description, name };
  } catch (e) {
    logger.warn(`storyboard gen: read image ${imageId} failed: ${e.message}`);
    return null;
  }
}

// Format the character list the same way for every LLM call so the planner
// and refiner see consistent context.
function formatCharacterLines(characters) {
  if (!characters?.length) return '(no named characters in this beat)';
  return characters
    .map((c) => {
      const name = stripMarkdown(c.name || '');
      const role = c.fields?.role || c.fields?.description || '';
      return `- ${name}${role ? ` — ${stripMarkdown(role)}` : ''}`;
    })
    .join('\n');
}

function formatDirectorNotes(directorNotes) {
  if (!Array.isArray(directorNotes) || !directorNotes.length) return null;
  const items = directorNotes
    .map((n) => {
      const text = stripMarkdown(typeof n?.text === 'string' ? n.text : '').trim();
      return text || null;
    })
    .filter(Boolean);
  if (!items.length) return null;
  return items.map((t) => `- ${t}`).join('\n');
}

// Block of beat context shared between the outline call and every refinement
// call. Exported via the preview endpoint so the SPA can show users the same
// text the LLM will see.
//
// directorNotes is the project-wide list (from getDirectorNotes().notes) —
// every note appears in every shot's prompt because notes are global tone /
// style / continuity guidance, not scene-scoped.
export function buildBeatContextBlock({ beat, characters, direction, directorNotes = [] }) {
  const lines = [
    `# Beat #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    '',
    'Beat description:',
    stripMarkdown(beat.desc || '') || '(none)',
    '',
    'Beat body:',
    stripMarkdown(beat.body || '') || '(none)',
    '',
    'Characters in this beat:',
    formatCharacterLines(characters),
  ];
  const notesBlock = formatDirectorNotes(directorNotes);
  if (notesBlock) {
    lines.push('');
    lines.push("Director's notes (project-wide guidance — apply to every shot):");
    lines.push(notesBlock);
  }
  const cleanDirection = sanitizeDirection(direction);
  if (cleanDirection) {
    lines.push('');
    lines.push("Director's commentary:");
    lines.push(cleanDirection);
  }
  return lines.join('\n');
}

export function buildOutlineUserText({
  beat,
  characters,
  targetCount,
  direction,
  directorNotes = [],
}) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const count = clampTargetCount(targetCount);
  // Lead with the count so the model can't miss it. The system prompt's
  // FRAME COUNT IS NON-NEGOTIABLE section + this leading line + the closing
  // reminder are deliberately redundant — Sonnet 4.6 has a tendency to
  // under-deliver on long lists when the count instruction is buried.
  const lead =
    `Target frame count: EXACTLY ${count} frames. ` +
    `Your tool call MUST contain ${count} entries in the frames array — not fewer.`;
  const instruction =
    `Produce ${count} cinematic storyboard frames covering the whole beat in narrative order, ` +
    'with embellishment shots (establishing/insert/reaction/atmospheric) interleaved among the narrative beats. ' +
    'Each frame must be visually distinct from the previous one (different moment, action, or composition) ' +
    'AND continuous with it (shared element, motion vector, or match cut). ' +
    'Pick a shot_type and duration_seconds for every frame. ' +
    'IMPORTANT: the beat body above may describe reveals, entries, camera moves, or other action that the AI video model cannot synthesize forwards. Re-interpret those into the reverse-in-post pattern (set reverse_in_post: true and write the description as the reversed action) or substitute with separate static shots — see the "These rules OVERRIDE the beat\'s literal description" and "Mandatory reveal / entry detection" sections of the system prompt. Honoring the beat narrative literally is a planning bug. ' +
    'Use the plan_storyboard_outline tool. ' +
    'Do NOT write the detailed video or still-image prompts — those are produced in a separate per-frame pass. ' +
    `Reminder: the frames array MUST have exactly ${count} entries.`;
  return `${lead}\n\n${ctx}\n\n${instruction}`;
}

function formatOutlineForRefinement(outline) {
  return outline
    .map((f, i) => {
      const parts = [
        `${i + 1}. [${f.shot_type || 'shot'} · ${f.duration_seconds || '?'}s]`,
        `   description: ${f.description || ''}`,
      ];
      if (f.transition_in) parts.push(`   transition_in: ${f.transition_in}`);
      if (Array.isArray(f.characters_in_scene) && f.characters_in_scene.length) {
        parts.push(`   characters_in_scene: ${f.characters_in_scene.join(', ')}`);
      }
      if (f.reverse_in_post) parts.push('   reverse_in_post: true (invert temporal direction in prompts)');
      return parts.join('\n');
    })
    .join('\n');
}

function formatPreviousRefined(previousRefined) {
  if (!previousRefined?.length) return '(this is the first frame)';
  return previousRefined
    .map((f, i) => {
      return [
        `${i + 1}. video_prompt:       ${f.video_prompt || '(none)'}`,
        `   start_frame_prompt: ${f.start_frame_prompt || '(none)'}`,
        `   end_frame_prompt:   ${f.end_frame_prompt || '(none)'}`,
      ].join('\n');
    })
    .join('\n');
}

function buildRefinementUserText({
  beat,
  characters,
  direction,
  outline,
  index,
  previousRefined,
  directorNotes = [],
}) {
  const frame = outline[index];
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const outlineBlock = formatOutlineForRefinement(outline);
  const prevBlock = formatPreviousRefined(previousRefined);
  const target = [
    `Refining frame ${index + 1} of ${outline.length}:`,
    `  shot_type: ${frame.shot_type || '(none)'}`,
    `  duration_seconds: ${frame.duration_seconds || '?'}`,
    `  description: ${frame.description || ''}`,
  ];
  if (frame.transition_in) target.push(`  transition_in: ${frame.transition_in}`);
  if (Array.isArray(frame.characters_in_scene) && frame.characters_in_scene.length) {
    target.push(`  characters_in_scene: ${frame.characters_in_scene.join(', ')}`);
  }
  if (frame.reverse_in_post) {
    target.push(
      '  reverse_in_post: true — INVERT temporal direction across all three outputs: start_frame_prompt = final revealed state, end_frame_prompt = initial hidden state, video_prompt = camera move in generation direction (the clip will be reversed in post).',
    );
  }
  return [
    ctx,
    '',
    '# Full outline (for continuity context):',
    outlineBlock,
    '',
    '# Previously refined frames (their finished prompts, for match-cut composition):',
    prevBlock,
    '',
    '# Frame to refine:',
    target.join('\n'),
    '',
    'Produce the video_prompt, start_frame_prompt, and end_frame_prompt for this frame via the refine_storyboard_frame tool. ' +
      'Compose start_frame_prompt to pick up the prior frame\'s end_frame_prompt where appropriate (shared subject, motion vector, match cut); ' +
      'end_frame_prompt is the same shot a beat or two later (motion progression, not a new shot); ' +
      'video_prompt describes what HAPPENS during the clip (camera move + subject action) assuming the start frame image already anchors the composition — do not re-describe the start composition.',
  ].join('\n');
}

async function planOutline({
  beat,
  characters,
  targetCount,
  direction,
  directorNotes = [],
}) {
  if (outlinePlannerOverride) {
    return outlinePlannerOverride({
      beat,
      characters,
      targetCount,
      direction,
      directorNotes,
    });
  }
  const userText = buildOutlineUserText({
    beat,
    characters,
    targetCount,
    direction,
    directorNotes,
  });
  const model = STORYBOARD_MODEL;
  const client = getAnthropic();
  // max_tokens is sized for the upper bound of MAX_TARGET_COUNT (30) frames.
  // Each outline frame serializes to ~120 tokens of JSON, so 30 frames is
  // ~3.6K tokens. 16K leaves ample headroom — sized too low previously
  // (4096) led to truncated responses for big counts.
  const resp = await client.messages.create({
    model,
    max_tokens: 16000,
    system: OUTLINE_SYSTEM_PROMPT,
    tools: [OUTLINE_TOOL],
    tool_choice: { type: 'tool', name: 'plan_storyboard_outline' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  if (resp.stop_reason === 'max_tokens') {
    logger.warn(
      `storyboard outline: hit max_tokens cap (model=${model}, target=${targetCount}); response may be truncated`,
    );
  }
  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'plan_storyboard_outline',
  );
  if (!toolUse) {
    logger.warn(
      `storyboard outline: model did not call plan_storyboard_outline (stop_reason=${resp.stop_reason})`,
    );
    return [];
  }
  const frames = Array.isArray(toolUse.input?.frames) ? toolUse.input.frames : [];
  const want = clampTargetCount(targetCount);
  if (frames.length < want) {
    logger.warn(
      `storyboard outline: model returned ${frames.length} frames; user requested ${want}. ` +
        `(stop_reason=${resp.stop_reason}, model=${model})`,
    );
  }
  return frames;
}

export function buildScenePlanUserText({ beat, characters, targetCount, direction, directorNotes = [] }) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const count = clampTargetCount(targetCount);
  const lead =
    `Target shot count: EXACTLY ${count} frames. Your frames array MUST contain ${count} entries.`;
  const instruction =
    `First write the scene_bible (the unified look). Then produce ${count} cinematic shots in narrative order, ` +
    'with embellishment shots interleaved among the narrative beats. Each shot must be visually distinct from ' +
    'the previous AND continuous with it. Pick a shot_type and duration_seconds for every shot. ' +
    'Re-interpret any reveals/entries/camera-moves the beat describes per the reveal rules. ' +
    `Use the plan_scene tool. Reminder: exactly ${count} frames.`;
  return `${lead}\n\n${ctx}\n\n${instruction}`;
}

// Pass 1. Returns { sceneBible, outline } where sceneBible is a normalized
// bible object and outline is the raw frames array (cleaned later). Returns
// { sceneBible: null, outline: [] } on model failure.
async function planScene({ beat, characters, targetCount, direction, directorNotes = [] }) {
  if (scenePlannerOverride) {
    return scenePlannerOverride({ beat, characters, targetCount, direction, directorNotes });
  }
  const userText = buildScenePlanUserText({ beat, characters, targetCount, direction, directorNotes });
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: STORYBOARD_MODEL,
    max_tokens: 16000,
    system: SCENE_PLAN_SYSTEM_PROMPT,
    tools: [SCENE_PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'plan_scene' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  if (resp.stop_reason === 'max_tokens') {
    logger.warn(
      `storyboard plan_scene: hit max_tokens cap (model=${STORYBOARD_MODEL}, target=${targetCount}); response may be truncated`,
    );
  }
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'plan_scene');
  if (!toolUse) {
    logger.warn(`storyboard plan_scene: model did not call the tool (stop_reason=${resp.stop_reason})`);
    return { sceneBible: null, outline: [] };
  }
  const sceneBible = normalizeSceneBible(toolUse.input.scene_bible);
  const outline = Array.isArray(toolUse.input.frames) ? toolUse.input.frames : [];
  const want = clampTargetCount(targetCount);
  if (outline.length < want) {
    logger.warn(
      `storyboard plan_scene: model returned ${outline.length} frames; requested ${want} (stop_reason=${resp.stop_reason})`,
    );
  }
  return { sceneBible, outline };
}

// Test seam.
export function _planSceneForTest(args) {
  return planScene(args);
}

// Pass-2 shot-expansion tool: expand the WHOLE skeleton in one call, emitting
// two outputs per shot — start_frame_prompt + video_prompt (NO end frame).
const SHOT_EXPAND_TOOL = {
  name: 'expand_shots',
  description:
    'Given the scene bible and the full ordered shot skeleton, write the two generation prompts for EVERY shot: ' +
    'a start_frame_prompt (the opening still that anchors the clip) and a video_prompt (what happens + camera move). ' +
    'Return one entry per shot, in skeleton order.',
  input_schema: {
    type: 'object',
    properties: {
      shots: {
        type: 'array',
        description: 'One entry per skeleton shot, in order.',
        items: {
          type: 'object',
          properties: {
            shot_index: { type: 'integer', minimum: 1, description: '1-based index into the skeleton this entry expands.' },
            start_frame_prompt: {
              type: 'string',
              description:
                'Still-image prompt for the opening composition: subject, action, framing, camera lighting. ~2 sentences. Do NOT re-describe the scene bible (location/lighting/palette/blocking) or character faces/wardrobe — reference them.',
            },
            video_prompt: {
              type: 'string',
              description:
                'Clip-gen prompt: what HAPPENS (subject action + one camera move or hold), assuming the start frame already exists. ~2 sentences. Do NOT re-describe the start composition.',
            },
            reverse_in_post: {
              type: 'boolean',
              description:
                'Override the skeleton if you detect a reveal it missed. When true, invert: start_frame_prompt = final revealed state, video_prompt = the pull-back/generation-direction move (reversed in post). Omit to inherit the skeleton value.',
            },
          },
          required: ['shot_index', 'start_frame_prompt', 'video_prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['shots'],
    additionalProperties: false,
  },
};

export const SHOT_EXPAND_SYSTEM_PROMPT = [
  'You are a Hollywood storyboard artist writing the generation prompts for an already-planned shot list. Return all prompts via the expand_shots tool.',
  '',
  'You see the SCENE BIBLE (the unified look) and the FULL shot skeleton at once, so you can compose the whole scene coherently: each shot picks up its neighbor, and every shot honors the same bible.',
  '',
  '# Two outputs per shot (NO end frame)',
  '1. start_frame_prompt — the opening still that the image-to-video model conditions on. Subject, action, framing, camera lighting. ~2 sentences.',
  '2. video_prompt — what HAPPENS during the clip (subject action + one camera move, or a hold), assuming the start frame already exists. ~2 sentences. Lead with the motion; do NOT re-describe the start composition.',
  '',
  '# Inherit the bible — do not re-describe it',
  '- The scene bible already fixes location, time of day, lighting key, palette, mood, blocking, and camera language. Reference them; never restate them.',
  '- Character faces, bodies, and wardrobe come from reference photos. Do not describe them.',
  '- This is WHY your prompts can be short: the shared context is carried by the bible + reference images.',
  '',
  '# Continuity',
  "- Compose each start_frame_prompt to pick up the prior shot's motion vector / match cut, per the skeleton's transition_in.",
  '- Honor each shot\'s description, shot_type, transition_in, and characters_in_scene.',
  '',
  '# Camera motion (for video_prompt)',
  CAMERA_MOTION_RULES,
  '',
  '# Subject motion (for video_prompt)',
  SUBJECT_MOTION_RULES,
  '',
  '# Still composition (for start_frame_prompt)',
  STILL_FRAMING_RULES,
  '',
  '# What the model cannot draw',
  FRAMING_RULES,
  '',
  '# Reveals',
  REVEAL_HANDLING,
  'For a reverse_in_post shot, the start_frame_prompt is the FINAL revealed state and the video_prompt is the pull-back / generation-direction move; the clip is reversed in post.',
  '',
  '# Output',
  '- Return one entry per skeleton shot, each with its 1-based shot_index. Emit ALL shots.',
].join('\n');

let shotExpanderOverride = null;
export function _setShotExpanderForTests(fn) {
  shotExpanderOverride = fn;
}

function formatSkeletonForExpand(outline) {
  return outline
    .map((f, i) => {
      const parts = [
        `${i + 1}. [${f.shot_type || 'shot'} · ${f.duration_seconds || '?'}s] ${f.description || ''}`,
      ];
      if (f.transition_in) parts.push(`   transition_in: ${f.transition_in}`);
      if (Array.isArray(f.characters_in_scene) && f.characters_in_scene.length) {
        parts.push(`   characters_in_scene: ${f.characters_in_scene.join(', ')}`);
      }
      if (f.reverse_in_post) parts.push('   reverse_in_post: true (invert temporal direction)');
      return parts.join('\n');
    })
    .join('\n');
}

export function buildShotExpandUserText({ beat, characters, sceneBible, outline, direction, directorNotes = [] }) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const bibleBlock = renderSceneBibleBlock(sceneBible);
  const lines = [ctx];
  if (bibleBlock) {
    lines.push('', '# Scene bible (the unified look — inherit, do not re-describe):', bibleBlock);
  }
  lines.push(
    '',
    '# Full shot skeleton:',
    formatSkeletonForExpand(outline),
    '',
    `Write start_frame_prompt + video_prompt for ALL ${outline.length} shots via the expand_shots tool, one entry per shot with its 1-based shot_index.`,
  );
  return lines.join('\n');
}

// Two-output fallback when the model omits a shot's prompts.
function synthesizeFallbackShot(frame) {
  const base = stripMarkdown(frame.description || '').trim();
  return {
    start_frame_prompt: base ? `Opening composition of the shot: ${base}` : 'Opening composition of the shot.',
    video_prompt: base ? `The action plays out: ${base}. Camera holds.` : 'Subject performs the action; camera holds.',
  };
}

// Pass 2. One call expands the whole skeleton. Returns an array aligned to the
// skeleton (index i -> shot i+1); omitted entries are filled with a synthesized
// fallback so downstream persistence always gets a usable prompt.
async function expandShots({ beat, characters, sceneBible, outline, direction, directorNotes = [] }) {
  if (shotExpanderOverride) {
    return shotExpanderOverride({ beat, characters, sceneBible, outline, direction, directorNotes });
  }
  const userText = buildShotExpandUserText({ beat, characters, sceneBible, outline, direction, directorNotes });
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: STORYBOARD_MODEL,
    max_tokens: 16000,
    system: SHOT_EXPAND_SYSTEM_PROMPT,
    tools: [SHOT_EXPAND_TOOL],
    tool_choice: { type: 'tool', name: 'expand_shots' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  if (resp.stop_reason === 'max_tokens') {
    logger.warn(
      `storyboard expand_shots: hit max_tokens cap (model=${STORYBOARD_MODEL}, shots=${outline.length}); response may be truncated`,
    );
  }
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'expand_shots');
  const raw = Array.isArray(toolUse?.input?.shots) ? toolUse.input.shots : [];
  // Index by shot_index so a misordered/partial response still maps correctly;
  // fall back to array position when shot_index is missing.
  const byIndex = new Map();
  raw.forEach((s, pos) => {
    const idx = Number.isFinite(Number(s?.shot_index)) ? Number(s.shot_index) : pos + 1;
    if (byIndex.has(idx)) {
      logger.warn(`storyboard expand_shots: duplicate shot_index ${idx}; later entry wins`);
    }
    if (idx > outline.length) {
      logger.warn(`storyboard expand_shots: shot_index ${idx} exceeds skeleton length ${outline.length}; ignored`);
    }
    byIndex.set(idx, s);
  });
  return outline.map((f, i) => {
    const s = byIndex.get(i + 1);
    const sfp = typeof s?.start_frame_prompt === 'string' ? s.start_frame_prompt.trim() : '';
    const vp = typeof s?.video_prompt === 'string' ? s.video_prompt.trim() : '';
    if (!sfp || !vp) {
      logger.warn(`storyboard expand_shots: missing output for shot ${i + 1}; using fallback`);
      return { ...synthesizeFallbackShot(f), reverse_in_post: Boolean(f.reverse_in_post) };
    }
    const rev = typeof s.reverse_in_post === 'boolean' ? s.reverse_in_post : Boolean(f.reverse_in_post);
    return { start_frame_prompt: sfp, video_prompt: vp, reverse_in_post: rev };
  });
}

// Test seam.
export function _expandShotsForTest(args) {
  return expandShots(args);
}

// Two-output validator for the new pipeline (parallels the old three-output
// cleanPlannedFrame). Drops a frame only if it lacks start_frame_prompt or
// video_prompt; otherwise clamps shot_type / duration / characters / transition.
function cleanPlannedFrameV2(f) {
  if (!f || typeof f.start_frame_prompt !== 'string' || typeof f.video_prompt !== 'string') {
    return [];
  }
  const shotType = SHOT_TYPES.includes(f.shot_type) ? f.shot_type : null;
  const clampedDur = clampDuration(f.duration_seconds, shotType);
  const rawChars = Array.isArray(f.characters_in_scene)
    ? f.characters_in_scene.map((n) => stripMarkdown(String(n ?? '')).trim()).filter(Boolean)
    : [];
  const transition =
    typeof f.transition_in === 'string' && f.transition_in.trim()
      ? f.transition_in.trim().slice(0, MAX_TRANSITION_LEN)
      : null;
  return [{
    ...f,
    shot_type: shotType,
    duration_seconds: clampedDur,
    transition_in: transition,
    characters_in_scene: rawChars.slice(0, MAX_CHARS_PER_SHOT),
    reverse_in_post: Boolean(f.reverse_in_post),
  }];
}

// New two-pass planner. Returns { frames, sceneBible }. frames carry
// start_frame_prompt + video_prompt (no end_frame_prompt). On planner failure
// returns { frames: [], sceneBible } (bible may still be present/null).
async function planFramesV2({ beat, characters, targetCount, direction = '', directorNotes = [], onProgress = null }) {
  onProgress?.({ phase: 'planning', step: 'plan_scene_start', message: 'Planning scene bible + shot list…' });
  const { sceneBible, outline: outlineRaw } = await planScene({ beat, characters, targetCount, direction, directorNotes });
  if (!Array.isArray(outlineRaw) || !outlineRaw.length) {
    onProgress?.({ phase: 'planning', step: 'plan_scene_empty', message: 'Scene planner returned no shots.' });
    return { frames: [], sceneBible };
  }
  onProgress?.({ phase: 'planning', step: 'plan_scene_done', total: outlineRaw.length, message: `Scene plan complete: ${outlineRaw.length} shots.` });

  const outline = outlineRaw.map((f) => ({
    description: typeof f?.description === 'string' ? f.description : '',
    shot_type: f?.shot_type ?? null,
    duration_seconds: f?.duration_seconds ?? null,
    transition_in: typeof f?.transition_in === 'string' ? f.transition_in : '',
    characters_in_scene: Array.isArray(f?.characters_in_scene) ? f.characters_in_scene : [],
    reverse_in_post: Boolean(f?.reverse_in_post),
  }));

  onProgress?.({ phase: 'refining', step: 'expand_start', total: outline.length, message: `Expanding ${outline.length} shots…` });
  const expanded = await expandShots({ beat, characters, sceneBible, outline, direction, directorNotes });
  onProgress?.({ phase: 'refining', step: 'expand_done', total: outline.length, message: 'Shot expansion complete.' });

  const frames = outline.flatMap((f, i) => {
    const e = expanded[i] || {};
    return cleanPlannedFrameV2({
      ...f,
      start_frame_prompt: e.start_frame_prompt,
      video_prompt: e.video_prompt,
      reverse_in_post: typeof e.reverse_in_post === 'boolean' ? e.reverse_in_post : f.reverse_in_post,
    });
  });
  return { frames, sceneBible };
}

// Test seam.
export function _planFramesV2ForTest(args) {
  return planFramesV2(args);
}

async function refineFramePrompts({
  beat,
  characters,
  direction,
  outline,
  index,
  previousRefined,
  directorNotes = [],
}) {
  if (frameRefinerOverride) {
    return frameRefinerOverride({
      beat,
      characters,
      direction,
      outline,
      index,
      previousRefined,
      directorNotes,
    });
  }
  const userText = buildRefinementUserText({
    beat,
    characters,
    direction,
    outline,
    index,
    previousRefined,
    directorNotes,
  });
  const model = STORYBOARD_MODEL;
  const client = getAnthropic();
  const resp = await client.messages.create({
    model,
    max_tokens: 800,
    system: REFINE_SYSTEM_PROMPT,
    tools: [REFINE_TOOL],
    tool_choice: { type: 'tool', name: 'refine_storyboard_frame' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'refine_storyboard_frame',
  );
  if (!toolUse?.input) return null;
  const vp = typeof toolUse.input.video_prompt === 'string'
    ? toolUse.input.video_prompt.trim()
    : '';
  const sfp = typeof toolUse.input.start_frame_prompt === 'string'
    ? toolUse.input.start_frame_prompt.trim()
    : '';
  const efp = typeof toolUse.input.end_frame_prompt === 'string'
    ? toolUse.input.end_frame_prompt.trim()
    : '';
  if (!vp || !sfp || !efp) return null;
  // reverse_in_post is an optional override. `null` (the default below) means
  // "inherit the outline's value"; only an explicit boolean overrides it.
  const rev =
    typeof toolUse.input.reverse_in_post === 'boolean'
      ? toolUse.input.reverse_in_post
      : null;
  return {
    video_prompt: vp,
    start_frame_prompt: sfp,
    end_frame_prompt: efp,
    reverse_in_post: rev,
  };
}

function synthesizeFallbackPrompts(frame) {
  const base = stripMarkdown(frame.description || '').trim();
  const startFramePrompt = base
    ? `Opening composition of the shot: ${base}`
    : 'Opening composition of the shot.';
  const endFramePrompt = base
    ? `Same shot moments later, motion progressed: ${base}`
    : 'Same shot moments later, motion progression.';
  const videoPrompt = base
    ? `The action plays out: ${base}. Camera holds.`
    : 'Subject performs the action of the shot; camera holds.';
  return {
    video_prompt: videoPrompt,
    start_frame_prompt: startFramePrompt,
    end_frame_prompt: endFramePrompt,
  };
}

// Two-stage planner. Stage A produces the outline (Sonnet by default). Stage B
// refines each frame's start/end prompts sequentially with rolling context
// (Opus by default), so each refinement sees the full outline and the
// already-refined neighbors. A failed refinement does not abort the pipeline —
// it falls back to a synthesized prompt and increments `onRefineFailure` so
// the job's `refine_failures` counter records it.
async function planFrames({
  beat,
  characters,
  targetCount,
  direction = '',
  directorNotes = [],
  onRefineFailure = null,
  onProgress = null,
  refineModel = null,
}) {
  const outlineRaw = await planOutline({
    beat,
    characters,
    targetCount,
    direction,
    directorNotes,
  });
  if (!Array.isArray(outlineRaw) || !outlineRaw.length) {
    onProgress?.({
      phase: 'planning',
      step: 'plan_outline_empty',
      message: 'Outline planner returned no frames.',
    });
    return [];
  }
  onProgress?.({
    phase: 'planning',
    step: 'plan_outline_done',
    total: outlineRaw.length,
    message: `Outline complete: ${outlineRaw.length} frames planned.`,
  });

  // Normalize outline before refinement so downstream code (the formatted
  // prompt, the cleaner) sees the same field types we'll persist.
  const outline = outlineRaw.map((f) => ({
    description: typeof f?.description === 'string' ? f.description : '',
    shot_type: f?.shot_type ?? null,
    duration_seconds: f?.duration_seconds ?? null,
    transition_in: typeof f?.transition_in === 'string' ? f.transition_in : '',
    characters_in_scene: Array.isArray(f?.characters_in_scene)
      ? f.characters_in_scene
      : [],
    reverse_in_post: Boolean(f?.reverse_in_post),
  }));

  const refined = [];
  for (let i = 0; i < outline.length; i++) {
    onProgress?.({
      phase: 'refining',
      step: 'refine_frame_start',
      frame: i + 1,
      total: outline.length,
      message: `Refining visual prompts for frame ${i + 1}/${outline.length}${refineModel ? ` with ${refineModel}` : ''}…`,
    });
    let prompts = null;
    try {
      prompts = await refineFramePrompts({
        beat,
        characters,
        direction,
        outline,
        index: i,
        previousRefined: refined.slice(),
        directorNotes,
      });
    } catch (e) {
      logger.warn(
        `storyboard refine frame ${i + 1}/${outline.length}: ${e?.message || e}`,
      );
    }
    if (!prompts) {
      logger.warn(
        `storyboard refine frame ${i + 1}/${outline.length}: falling back to synthesized prompts`,
      );
      onRefineFailure?.(i);
      onProgress?.({
        phase: 'refining',
        step: 'refine_frame_fallback',
        frame: i + 1,
        total: outline.length,
        message: `Frame ${i + 1}/${outline.length}: refinement failed, using synthesized fallback prompts.`,
      });
      prompts = {
        ...synthesizeFallbackPrompts(outline[i]),
        reverse_in_post: null,
      };
    }
    // The refiner may flip reverse_in_post if it caught a reveal the outline
    // missed (or set it false if it disagrees). Only an explicit boolean from
    // the refiner overrides the outline's value; null/undefined inherits.
    const refinedReverse =
      typeof prompts.reverse_in_post === 'boolean'
        ? prompts.reverse_in_post
        : Boolean(outline[i].reverse_in_post);
    if (refinedReverse !== Boolean(outline[i].reverse_in_post)) {
      logger.info(
        `storyboard refine frame ${i + 1}/${outline.length}: refiner overrode reverse_in_post ${outline[i].reverse_in_post} → ${refinedReverse}`,
      );
    }
    refined.push({
      ...outline[i],
      video_prompt: prompts.video_prompt,
      start_frame_prompt: prompts.start_frame_prompt,
      end_frame_prompt: prompts.end_frame_prompt,
      reverse_in_post: refinedReverse,
    });
  }

  onProgress?.({
    phase: 'refining',
    step: 'refine_done',
    total: outline.length,
    message: `Refinement complete (${outline.length} frames).`,
  });

  return refined.flatMap(cleanPlannedFrame);
}

// Validate, clamp, and normalize a single planner-emitted frame. Returns
// either [cleanedFrame] or [] (drop the frame). Co-located with planFrames so
// the warn logs read in line with where the bad model output came from.
function cleanPlannedFrame(f) {
  if (
    !f ||
    typeof f.video_prompt !== 'string' ||
    typeof f.start_frame_prompt !== 'string' ||
    typeof f.end_frame_prompt !== 'string'
  ) {
    return [];
  }
  const shotType = SHOT_TYPES.includes(f.shot_type) ? f.shot_type : null;
  if (!shotType && f.shot_type != null) {
    logger.warn(`storyboard plan: dropping invalid shot_type "${f.shot_type}"`);
  }
  const clampedDur = clampDuration(f.duration_seconds, shotType);
  if (
    f.duration_seconds != null &&
    Number.isFinite(Number(f.duration_seconds)) &&
    Number(f.duration_seconds) !== clampedDur
  ) {
    logger.warn(
      `storyboard plan: duration ${f.duration_seconds}s clamped to ${clampedDur}s for shot_type=${shotType}`,
    );
  }
  const rawChars = Array.isArray(f.characters_in_scene)
    ? f.characters_in_scene
        .map((n) => stripMarkdown(String(n ?? '')).trim())
        .filter(Boolean)
    : [];
  if (rawChars.length > MAX_CHARS_PER_SHOT) {
    logger.warn(
      `storyboard plan: trimming characters_in_scene from ${rawChars.length} to ${MAX_CHARS_PER_SHOT}`,
    );
  }
  const transition =
    typeof f.transition_in === 'string' && f.transition_in.trim()
      ? f.transition_in.trim().slice(0, MAX_TRANSITION_LEN)
      : null;
  return [
    {
      ...f,
      shot_type: shotType,
      duration_seconds: clampedDur,
      transition_in: transition,
      characters_in_scene: rawChars.slice(0, MAX_CHARS_PER_SHOT),
      reverse_in_post: Boolean(f.reverse_in_post),
    },
  ];
}

// Persist one planned frame as a storyboard row. No image generation —
// start_frame_id and end_frame_id stay null on the new row, and users render
// them on demand via the SPA's per-row regen flow. Each frame's reference
// list is seeded from the beat + in-scene characters' images so the modal's
// default ref grid is non-empty.
async function createPlannedStoryboardEntry({
  beat,
  frame,
  order,
}) {
  // seedFragments populates the y-doc text_prompt + summary fragments before
  // the gateway's broadcast, so the SPA's CollabFields render immediately
  // rather than appearing empty until reload. The planner's `description` is
  // the LLM-generated one-sentence summary of the shot (per OUTLINE_TOOL's
  // schema), so we feed it straight into the summary field.
  const textPrompt = buildTextPrompt(frame);
  const summary = stripMarkdown(frame.description || '').replace(/\s+/g, ' ').trim();
  const startFramePrompt = stripMarkdown(frame.start_frame_prompt || '').trim();
  const endFramePrompt = stripMarkdown(frame.end_frame_prompt || '').trim();
  const sb = await createStoryboardViaGateway({
    beatId: beat._id,
    textPrompt,
    summary,
    order,
    seedFragments: {
      text_prompt: textPrompt,
      summary,
    },
    durationSeconds: frame.duration_seconds ?? null,
    shotType: frame.shot_type ?? null,
    transitionIn: frame.transition_in ?? null,
    charactersInScene: frame.characters_in_scene ?? [],
    reverseInPost: Boolean(frame.reverse_in_post),
  });

  // Collect the visual references for this shot once (beat set image(s) plus
  // each in-scene character's sheets and portraits) and seed every planned
  // frame's reference list with them so the modal's default ref grid is
  // non-empty. Failures are swallowed so the row still lands.
  let referenceIds = [];
  try {
    const collected = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: frame.characters_in_scene ?? [],
      existingIds: [],
    });
    referenceIds = collected.ids || [];
  } catch (e) {
    logger.warn(`storyboard gen: collect refs failed: ${e.message}`);
  }

  // The planner produces an opening and a closing still prompt; seed them as
  // the first two frames of the pool. Frames with no prompt are skipped so a
  // sparse planner output doesn't create empty frames.
  for (const prompt of [startFramePrompt, endFramePrompt]) {
    if (!prompt) continue;
    try {
      await addStoryboardFrameViaGateway({
        storyboardId: sb._id,
        prompt,
        referenceIds,
      });
    } catch (e) {
      logger.warn(`storyboard gen: add planned frame failed: ${e.message}`);
    }
  }
}

function buildTextPrompt(frame) {
  const lines = [];
  const headerParts = [];
  if (frame.shot_type) {
    headerParts.push(`**${frame.shot_type.replace(/_/g, ' ').toUpperCase()}**`);
  }
  if (Number.isFinite(Number(frame.duration_seconds))) {
    headerParts.push(`${frame.duration_seconds}s`);
  }
  if (headerParts.length) lines.push(headerParts.join(' · '));
  if (frame.reverse_in_post) {
    if (lines.length) lines.push('');
    lines.push(
      '**↺ REVERSE IN POST** — generated camera/action runs backwards; reverse the clip in post for the intended reveal.',
    );
  }
  if (frame.description) {
    if (lines.length) lines.push('');
    lines.push(stripMarkdown(frame.description));
  }
  if (frame.transition_in) {
    lines.push('');
    lines.push(`_↳ ${stripMarkdown(frame.transition_in)}_`);
  }
  if (frame.video_prompt) {
    lines.push('');
    lines.push(stripMarkdown(frame.video_prompt));
  }
  if (frame.characters_in_scene?.length) {
    lines.push('');
    lines.push(
      `_Characters: ${frame.characters_in_scene.map((n) => stripMarkdown(n)).join(', ')}_`,
    );
  }
  return lines.join('\n');
}

// Build the default suggested prompt for a frame — used by the SPA's
// preview-prompt endpoint when the stored frame prompt is empty so the user
// gets a sensible starting draft they can keep or edit.
function buildSuggestedFramePrompt({ sb }) {
  const lines = [];
  if (sb.shot_type) {
    lines.push(`Shot type: ${sb.shot_type.replace(/_/g, ' ').toUpperCase()}.`);
  }
  const body = stripMarkdown(sb.text_prompt || '').trim();
  if (body) lines.push(body);
  if (Array.isArray(sb.characters_in_scene) && sb.characters_in_scene.length) {
    lines.push(
      `Characters in scene: ${sb.characters_in_scene
        .map((n) => stripMarkdown(n))
        .filter(Boolean)
        .join(', ')}.`,
    );
  }
  lines.push('');
  lines.push('Render this moment of the shot as a cinematic still.');
  return lines.join('\n');
}

async function persistFrameImage({
  storyboardId,
  frameId,
  result,
  beatId,
  orderHint,
  rotateToPrevious = false,
  editPrompt = null,
}) {
  const file = await uploadGeneratedImage({
    buffer: result.buffer,
    contentType: result.contentType,
    prompt: null,
    generatedBy: result.model || 'unknown',
    ownerType: 'beat',
    ownerId: beatId,
    filename: `storyboard-${storyboardId}-${orderHint}.png`,
  });
  if (rotateToPrevious) {
    await setStoryboardFrameEditResultViaGateway({
      storyboardId,
      frameId,
      newImageId: file._id,
      editPrompt: editPrompt || '',
    });
  } else {
    await setStoryboardFrameImageViaGateway({
      storyboardId,
      frameId,
      imageId: file._id,
    });
  }
  return file;
}

const MAX_FRAME_REFERENCE_IMAGES = 12;

export class FrameNotFoundError extends Error {
  constructor(frameId) {
    super(`frame not found: ${frameId}`);
    this.code = 'FRAME_NOT_FOUND';
    this.status = 404;
  }
}

export class EditModeError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BAD_EDIT_MODE';
    this.status = 400;
  }
}

// Locate a frame within a backfilled storyboard by its stable id.
function getFrame(sb, frameId) {
  return (sb.frames || []).find((f) => f._id.toString() === String(frameId)) || null;
}

async function loadFrameReferenceImages(frame) {
  const ids = frame?.reference_ids || [];
  const out = [];
  for (const id of ids.slice(0, MAX_FRAME_REFERENCE_IMAGES)) {
    const ref = await loadImageInput(id);
    if (ref) {
      out.push({ buffer: ref.buffer, contentType: ref.contentType });
    }
  }
  return out;
}

// Regenerate a single frame (start_frame | end_frame). Two modes:
//
// - 'generate' (default): renders the frame from the user's `prompt` plus the
//   persisted per-frame reference list. The prompt is also saved back to the
//   stored frame prompt field so the textarea state survives a refresh.
//
// - 'edit': passes the existing frame image plus optional one-shot
//   `editReferenceImageIds` along with the user's `editPrompt` to the chosen
//   image model. Skips the persisted per-frame reference list entirely — only
//   the caller-supplied refs (if any) are sent. Use for small inline tweaks
//   ("remove the lamp on the left") or for tweaks that need to incorporate
//   a specific extra image ("add the hat from this reference").
//
// Public entry point: validates inputs, resolves sb + beat, refuses if the
// beat lock is held, and delegates to the internal worker. Direct callers
// (tests) get the fail-fast BeatBusyError semantics. The SPA-facing path goes
// through `startFrameGenerationJob` instead, which holds the lock for the
// duration of the run.
export async function regenerateStoryboardFrame({
  storyboardId,
  frameId,
  imageModel = 'gemini',
  mode = 'generate',
  editPrompt = null,
  editReferenceImageIds = [],
  prompt = null,
  rotateToPrevious = false,
}) {
  if (!['generate', 'edit'].includes(mode)) {
    throw new EditModeError(`Unknown regen mode "${mode}".`);
  }
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const frame = getFrame(sb, frameId);
  if (!frame) throw new FrameNotFoundError(frameId);
  const beat = await getBeat(sb.beat_id);
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  return regenerateStoryboardFrameInternal({
    sb,
    beat,
    frame,
    imageModel,
    mode,
    editPrompt,
    editReferenceImageIds,
    prompt,
    rotateToPrevious,
  });
}

// Preview the suggested default prompt for a frame. Called by the SPA's
// generate modal on open so the user gets a sensible starting draft when the
// stored prompt is empty.
export async function previewFrameGenerationPrompt({ storyboardId, frameId }) {
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const frame = getFrame(sb, frameId);
  if (!frame) throw new FrameNotFoundError(frameId);
  const beat = await getBeat(sb.beat_id);
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  const stored = frame.prompt || '';
  const suggested = buildSuggestedFramePrompt({ sb });
  return {
    prompt: stored.trim() ? stored : suggested,
    suggested_prompt: suggested,
    has_stored_prompt: !!stored.trim(),
    reference_count: (frame.reference_ids || []).length,
    has_existing_frame: !!frame.image_id,
  };
}

async function regenerateStoryboardFrameInternal({
  sb,
  beat,
  frame,
  imageModel = 'gemini',
  mode = 'generate',
  editPrompt = null,
  editReferenceImageIds = [],
  prompt = null,
  rotateToPrevious = false,
}) {
  const frameId = frame._id;
  let renderPrompt;
  let inputImages;
  let dispatchMode;
  if (mode === 'edit') {
    if (typeof editPrompt !== 'string' || !editPrompt.trim()) {
      throw new EditModeError('Edit mode requires a non-empty editPrompt.');
    }
    const existingId = frame.image_id;
    if (!existingId) {
      throw new EditModeError('No existing frame image to edit. Use generate mode instead.');
    }
    const existing = await loadImageInput(existingId);
    if (!existing) {
      throw new EditModeError('Could not read existing frame bytes for editing.');
    }
    renderPrompt = editPrompt.trim();
    const extras = [];
    for (const refId of editReferenceImageIds || []) {
      const ref = await loadImageInput(refId);
      if (!ref) {
        throw new EditModeError(`Reference image ${refId} not found.`);
      }
      extras.push({ buffer: ref.buffer, contentType: ref.contentType });
    }
    // Match imageReplaceDispatch ordering: primary (existing) first, refs
    // follow as supplementary inputs.
    inputImages = [
      { buffer: existing.buffer, contentType: existing.contentType },
      ...extras,
    ];
    dispatchMode = 'edit';
  } else {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new EditModeError('Generate mode requires a non-empty prompt.');
    }
    renderPrompt = prompt.trim();
    // Persist the user's customized prompt before dispatching so the textarea
    // state survives a refresh even mid-job. Failures collapse silently — the
    // prompt is still sent to the model, the persisted value just lags.
    try {
      await setStoryboardFramePromptViaGateway({
        storyboardId: sb._id,
        frameId,
        text: renderPrompt,
      });
    } catch (e) {
      logger.warn(`storyboard regen: persist frame prompt failed: ${e.message}`);
    }
    inputImages = await loadFrameReferenceImages(frame);
    dispatchMode = 'generate';
  }

  const result = await callGenerateImage({
    prompt: renderPrompt,
    model: imageModel,
    mode: dispatchMode,
    inputImages,
  });

  const file = await persistFrameImage({
    storyboardId: sb._id,
    frameId,
    result,
    beatId: beat._id,
    orderHint: `frame-${frameId}`,
    rotateToPrevious: rotateToPrevious && mode === 'edit',
    editPrompt: mode === 'edit' ? renderPrompt : null,
  });

  return { image_id: file._id.toString() };
}

// Background-job table for per-frame regeneration. Separate from the batch
// `jobs` Map at the top of the file — different shape, different polling
// endpoint, different lock semantics (each frame job runs serially inside its
// beat's lock; the batch job already owns the lock for its whole pipeline).
const frameJobs = new Map();

export function getFrameGenerationJob(jobId) {
  return frameJobs.get(jobId) || null;
}

// SPA entry point for "Generate" / "Regenerate" buttons. Returns a job_id
// immediately; the SPA polls /storyboard/frame-generate/job/:jobId to see when
// the work lands or fails. The runner holds the per-beat lock for its
// duration so it can't race the batch pipeline.
export async function startFrameGenerationJob({
  storyboardId,
  frameId,
  imageModel = 'gemini',
  mode = 'generate',
  editPrompt = null,
  editReferenceImageIds = [],
  prompt = null,
  rotateToPrevious = false,
  announceUsername = null,
}) {
  if (!['generate', 'edit'].includes(mode)) {
    throw new EditModeError(`Unknown regen mode "${mode}".`);
  }
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const frame = getFrame(sb, frameId);
  if (!frame) throw new FrameNotFoundError(frameId);
  const beat = await getBeat(sb.beat_id);
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  if (mode === 'edit' && !frame.image_id) {
    throw new EditModeError('No existing frame image to edit. Use generate mode instead.');
  }

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    storyboard_id: sb._id.toString(),
    beat_id: beat._id.toString(),
    frame_id: frame._id.toString(),
    image_model: imageModel,
    mode,
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    image_id: null,
  };
  frameJobs.set(jobId, job);

  withBeatLock(beat._id, () =>
    runFrameGenerationJob({
      job,
      sb,
      beat,
      frame,
      imageModel,
      mode,
      editPrompt,
      editReferenceImageIds,
      prompt,
      rotateToPrevious,
      announceUsername,
    }),
  ).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    logger.error(`frame gen job ${jobId} crashed: ${e.message}`);
  });

  return jobId;
}

async function runFrameGenerationJob({
  job,
  sb,
  beat,
  frame,
  imageModel,
  mode,
  editPrompt,
  editReferenceImageIds = [],
  prompt,
  rotateToPrevious = false,
  announceUsername = null,
}) {
  job.status = 'running';
  const { image_id } = await regenerateStoryboardFrameInternal({
    sb,
    beat,
    frame,
    imageModel,
    mode,
    editPrompt,
    editReferenceImageIds,
    prompt,
    rotateToPrevious,
  });
  job.image_id = image_id;
  job.status = 'done';
  job.finished_at = new Date();
  if (announceUsername) {
    try {
      const { announceMediaEvent } = await import('../discord/announcer.js');
      const { storyboardUrl } = await import('./links.js');
      const { stripMarkdown } = await import('../util/markdown.js');
      const name = stripMarkdown(beat.name || '').trim();
      const order = Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
      const beatLabel = name ? `${order}: ${name}` : order;
      const orderHint = Number.isFinite(sb.order) ? ` (shot ${sb.order + 1})` : '';
      const verb = mode === 'edit' ? 'edited a frame on' : 'generated a frame on';
      announceMediaEvent({
        username: announceUsername,
        verb,
        entityLabel: `Storyboard — ${beatLabel}${orderHint}`,
        entityUrl: storyboardUrl(beat),
        imageFileId: image_id,
        prompt: prompt || editPrompt || null,
      }).catch(() => {});
    } catch (e) {
      logger.warn(`frame gen announce failed: ${e?.message || e}`);
    }
  }
}
