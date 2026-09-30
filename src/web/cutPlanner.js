// src/web/cutPlanner.js
// The Prompts tab's scene → cut planner (Passes 1–4 of the design in
// docs/superpowers/specs/2026-09-30-scene-cut-prompting-and-comfyui-video-design.md).
//
//   Pass 0  loadFullBeatContext (beatContext.js) — the whole beat, once.
//   Pass 1  break_beat_into_scenes — scenes with a director's read, intention,
//           scope buckets, floor plan and the dialogue lines each scene holds.
//   Pass 2  plan_cuts (one call per scene) — the shot table: one row per cut,
//           every column filled; durations from the load score (cutLoad.js).
//   Pass 3  write_cut_prompts (one call per scene) — each row compiled into a
//           bare present-tense block ending in a lock line; linted
//           (cutPromptLint.js).
//   Pass 4  derive_start_frames (one call per scene) — the t=0 still prompt
//           and the end-frame still prompt (the picture the clip lands on)
//           per cut, plus the artwork picks for every subject in each frame.
//
// Everything is generated in memory first; only when every pass succeeds are
// the beat's scenes and cuts wiped and recreated (an empty result keeps the
// existing rows — the Prompts-tab precedent). Pass 5 (rendering the start and
// end frames) lives in cutStartFrames.js and runs inside the same job when asked.
//
// Every tool schema is strict and carries no numeric minimum/maximum (the
// Messages API rejects them); bounds are enforced in the normalizers.

import { ObjectId } from 'mongodb';
import { getAnthropic } from '../anthropic/client.js';
import { modelFor } from '../llm/modelSlots.js';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { recordAnthropicTextUsage } from '../mongo/tokenUsage.js';
import {
  CUT_ANGLES,
  CUT_MOVEMENTS,
  CUT_SIZES,
  DEPTHS_OF_FIELD,
  listVideoPrompts,
  normalizeCamera,
  recomputeCutOrderForBeat,
} from '../mongo/videoPrompts.js';
import { DIRECTORS_READ_FIELDS, SCOPE_BUCKETS, getVideoScene } from '../mongo/videoScenes.js';
import { stripMarkdown } from '../util/markdown.js';
import { loadFullBeatContext } from './beatContext.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { latestJobForBeat } from './jobLookup.js';
import { estimateCutDuration, sceneLoad } from './cutLoad.js';
import { lintCut } from './cutPromptLint.js';
import {
  BLOCK_FORM_RULES,
  CARRIER_TABLE_RULES,
  CUT_ANTI_SLOP_RULES,
  CUT_DIALOGUE_RULES,
  DIRECTORS_READ_RULES,
  EIGHT_RULES,
  EXEMPLAR_SCENE,
  FEELING_RULES,
  FLOOR_PLAN_RULES,
  LOCK_LINE_RULES,
  REFERENCE_BINDING_RULES,
  SCOPE_RULES,
  SHOT_TABLE_RULES,
  STARTING_STACKS_RULES,
  START_FRAME_RULES,
  END_FRAME_RULES,
} from './cutRules.js';
import {
  createVideoPromptViaGateway,
  createVideoSceneViaGateway,
  deleteAllVideoScenesForBeatViaGateway,
  deleteVideoPromptViaGateway,
  updateVideoSceneViaGateway,
} from './gateway.js';
import { formatDialogAudioMark } from './beatPlanShared.js';
import {
  ANTI_SLOP_RULES,
  CAMERA_COHERENCE_RULES,
  CAMERA_MOTION_RULES,
  CONTINUITY_STATE_RULES,
  FRAGILITY_RULES,
  NO_TEXT_RULES,
  OCCUPANT_PLACEHOLDER_RULES,
  SHOT_SIZE_FIDELITY_RULES,
  STILL_FRAMING_RULES,
} from './promptConstraints.js';
import { buildReferenceCatalog } from './referenceCatalog.js';

export const MAX_SCENES = 12;
export const MAX_CUTS_PER_SCENE = 12;
const PRIMARY_SPENDS = ['identity', 'motion', 'world'];

// ─── Tool schemas ───────────────────────────────────────────────────────────

const READ_PROPS = Object.fromEntries(
  DIRECTORS_READ_FIELDS.map((f) => [f, { type: 'string', description: `The ${f.replace(/_/g, ' ')} of this scene. Concrete, never a mood word, never blank.` }]),
);
const SCOPE_PROPS = Object.fromEntries(
  SCOPE_BUCKETS.map((b) => [b, { type: 'array', items: { type: 'string' }, description: `Story facts bucketed as ${b.replace(/_/g, ' ')}.` }]),
);

export const BREAK_SCENES_TOOL = {
  name: 'break_beat_into_scenes',
  strict: true,
  description:
    'Break the beat into its scenes (one location and time each, in order) and give every scene its director\'s read, intention, scope buckets, floor plan and the dialogue lines it holds.',
  input_schema: {
    type: 'object',
    properties: {
      scenes: {
        type: 'array',
        description: 'Ordered scenes covering the WHOLE beat with no gaps.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short label, 2–6 words ("Tom arrives soaked").' },
            slug: { type: 'string', description: 'Screenplay slugline for the scene: INT./EXT. LOCATION — TIME.' },
            set_names: { type: 'array', items: { type: 'string' }, description: 'The beat\'s set names this scene plays in, copied exactly. Usually one.' },
            character_names: { type: 'array', items: { type: 'string' }, description: 'Every named character present in the scene, copied exactly from the beat\'s character list.' },
            text_span: {
              type: 'object',
              description: 'Verbatim anchors into the beat body so the span can be located: the first ~8 words and the last ~8 words of this scene\'s prose.',
              properties: {
                starts_with: { type: 'string' },
                ends_with: { type: 'string' },
              },
              required: ['starts_with', 'ends_with'],
              additionalProperties: false,
            },
            directors_read: {
              type: 'object',
              description: 'The ten-field director\'s read. No blanks, no generic mood words.',
              properties: READ_PROPS,
              required: [...DIRECTORS_READ_FIELDS],
              additionalProperties: false,
            },
            intention: { type: 'string', description: 'ONE sentence: what this scene must do to the audience.' },
            scope: {
              type: 'object',
              description: 'The scope firewall: what has already happened, what this scene shows, what is reserved for later, what must not be shown yet.',
              properties: SCOPE_PROPS,
              required: [...SCOPE_BUCKETS],
              additionalProperties: false,
            },
            floor_plan: { type: 'string', description: 'Three or four sentences a stranger could draw from: landmarks, who is where at the start and facing what, the light source and its colour, the axis.' },
            dialog_lines: { type: 'array', items: { type: 'integer' }, description: 'The NUMBERS of the dialogue lines that fall inside this scene, in order (contiguous). Empty when the scene has no lines.' },
          },
          required: ['title', 'slug', 'set_names', 'character_names', 'text_span', 'directors_read', 'intention', 'scope', 'floor_plan', 'dialog_lines'],
          additionalProperties: false,
        },
      },
    },
    required: ['scenes'],
    additionalProperties: false,
  },
};

export const PLAN_CUTS_TOOL = {
  name: 'plan_cuts',
  strict: true,
  description:
    'The shot table for ONE scene: one row per cut (one camera setup), every column filled, in order.',
  input_schema: {
    type: 'object',
    properties: {
      cuts: {
        type: 'array',
        description: 'Ordered cuts covering the whole scene.',
        items: {
          type: 'object',
          properties: {
            camera: {
              type: 'object',
              properties: {
                size: { type: 'string', enum: [...CUT_SIZES], description: 'Framing size.' },
                angle: { type: 'string', enum: [...CUT_ANGLES] },
                height: { type: 'string', description: 'Camera height in words: "deck height", "seated eye level", "waist height", "from the floor".' },
                lens_mm: { type: 'integer', description: 'Focal length: 18, 24, 35 for wides; 50 for mediums; 85 or 135 for close shots.' },
                side: { type: 'string', description: 'Which side of the room the camera stands on, relative to a named landmark, and what it looks toward ("from the counter end, looking down the aisle to the door").' },
                movement: { type: 'string', enum: [...CUT_MOVEMENTS], description: 'At most one move; "static" when the camera holds.' },
                motivation: { type: 'string', description: 'What the move follows or reveals. Empty when static.' },
                depth_of_field: { type: 'string', enum: [...DEPTHS_OF_FIELD] },
                lighting: { type: 'string', description: 'The light source and its colour, in the floor plan\'s words.' },
              },
              required: ['size', 'angle', 'height', 'lens_mm', 'side', 'movement', 'motivation', 'depth_of_field', 'lighting'],
              additionalProperties: false,
            },
            in_frame: {
              type: 'array',
              description: 'Every principal visible in this cut, where they are relative to a landmark, which way they face, and whether they ACT (the one action) or only hold/react.',
              items: {
                type: 'object',
                properties: {
                  character: { type: 'string', description: 'Exact character name from the scene.' },
                  position: { type: 'string', description: 'Position relative to a named landmark ("seated in the window booth", "just inside the door").' },
                  facing: { type: 'string', description: 'What they face ("the door", "her", "the window").' },
                  acts: { type: 'boolean', description: 'true for the one who performs the cut\'s action; false for someone who holds or reacts.' },
                },
                required: ['character', 'position', 'facing', 'acts'],
                additionalProperties: false,
              },
            },
            action_by: { type: 'string', description: 'The ONE person who acts in this cut (exact name), or empty for an insert with no person.' },
            reaction: { type: 'boolean', description: 'true when this cut is a reaction shot (half a beat).' },
            eyeline: { type: 'string', description: 'Where the eyes go, relative to the lens; for a reaction the camera stands where the thing reacted to is.' },
            action: { type: 'string', description: 'The ONE action: a reaction as a plain feeling word + one physical anchor; a prop as the hand, the grip, the tilt, where it ends; a covered line as speaker + voice + eyes + the face after the last word (never the words).' },
            others: { type: 'string', description: 'One line of idle business for everyone else in frame. Empty only when no one else is in frame.' },
            last_frame: { type: 'string', description: 'What the frame holds when the cut ends; visible from this camera.' },
            sound: { type: 'string', description: 'The cue(s) that must land in this cut.' },
            sound_on_action: { type: 'boolean', description: 'true when a sound cue must land exactly on an action.' },
            crossing: { type: 'boolean', description: 'true when this cut carries a move between landmarks (a crossing gets its own row).' },
            contact: { type: 'boolean', description: 'true when body-to-body or body-to-prop contact must land in this cut.' },
            dialog_lines: { type: 'array', items: { type: 'integer' }, description: 'The numbers of the scene\'s dialogue lines this cut COVERS (speaker framed, mouth visible). Every line of the scene goes to exactly one cut, in order.' },
            sets_in_scene: { type: 'array', items: { type: 'string' }, description: 'The set(s) this cut plays in, copied exactly. Usually one.' },
            primary_spend: { type: 'string', enum: PRIMARY_SPENDS, description: 'What this cut spends its fidelity budget on.' },
            felt_intent: { type: 'string', description: 'What the viewer should feel or notice here — the scene\'s intention narrowed to this cut.' },
          },
          required: ['camera', 'in_frame', 'action_by', 'reaction', 'eyeline', 'action', 'others', 'last_frame', 'sound', 'sound_on_action', 'crossing', 'contact', 'dialog_lines', 'sets_in_scene', 'primary_spend', 'felt_intent'],
          additionalProperties: false,
        },
      },
      load_notes: { type: 'string', description: 'One or two sentences on the load: how many beats, where the load points are, what you split to keep each cut to one visible beat.' },
    },
    required: ['cuts', 'load_notes'],
    additionalProperties: false,
  },
};

export const WRITE_CUT_PROMPTS_TOOL = {
  name: 'write_cut_prompts',
  strict: true,
  description: 'Compile every shot-table row of this scene into its prose block. One entry per cut, in order.',
  input_schema: {
    type: 'object',
    properties: {
      cuts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cut_index: { type: 'integer', description: '1-based index of the table row this block compiles.' },
            title: { type: 'string', description: 'Short label for the cut, 2–6 words.' },
            prompt: { type: 'string', description: 'The full block: camera in words → the one action → space change and idle business → "Sound:" → the lock line → the ending inside the frame → any clip-scope exclusion last. Present tense, no brackets, no seconds, no shot number, 60–140 words.' },
            lock_line: { type: 'string', description: 'The lock-line sentences exactly as they appear inside prompt (light, each principal\'s identity + position + facing, the camera side).' },
            reference_binding: { type: 'string', description: 'For reference-to-video models only: the @Image binding clauses with their jobs and non-transfer ("@Image1 controls Sarah\'s identity and wardrobe only; ignore the room and the light from it."). One clause per subject in frame, then the set. Empty when there is no artwork to bind.' },
            exclusions: { type: 'array', items: { type: 'string' }, description: 'The clip-scope exclusion sentences that end the block ("Do not show the street outside yet."), also present verbatim at the end of prompt. Usually empty.' },
          },
          required: ['cut_index', 'title', 'prompt', 'lock_line', 'reference_binding', 'exclusions'],
          additionalProperties: false,
        },
      },
    },
    required: ['cuts'],
    additionalProperties: false,
  },
};

export const DERIVE_START_FRAMES_TOOL = {
  name: 'derive_start_frames',
  strict: true,
  description: 'For every cut of this scene, the prompts for its start frame (the t=0 still) and end frame (the still the clip lands on), and the artwork picks for each subject in each frame.',
  input_schema: {
    type: 'object',
    properties: {
      cuts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cut_index: { type: 'integer' },
            start_frame_prompt: { type: 'string', description: 'The still prompt: camera first, each principal as a frozen moment placed relative to a landmark, light source and colour, continuity state, the set\'s construction in a clause or two when it is in view; visual handles, never names; 80–140 words; no feeling words.' },
            reference_picks: {
              type: 'array',
              description: 'For each character in in_frame, the artwork that best matches this cut\'s framing and state; for the cut\'s set, an artwork ONLY when this camera sees the part of the set it shows (may be empty). Omit subjects with no artwork listed.',
              items: {
                type: 'object',
                properties: {
                  subject: { type: 'string', description: 'The subject name exactly as listed in the artwork catalog.' },
                  artwork_index: { type: 'integer', description: '1-based index into that subject\'s artwork list.' },
                  use: { type: 'string', enum: ['look', 'framing'], description: 'Sets only (characters: "look"). "framing" only when this camera essentially reproduces the artwork\'s own viewpoint; otherwise "look" — the place\'s construction and palette, rebuilt from this cut\'s camera.' },
                },
                required: ['subject', 'artwork_index', 'use'],
                additionalProperties: false,
              },
            },
            end_frame_prompt: { type: 'string', description: 'The end-frame still prompt: the camera where it STOPS (after its move, or the same framing when it holds), each principal frozen in the last_frame state placed relative to a landmark, the same light, handles and set-construction words as the start frame; 80–140 words; no feeling words.' },
            end_reference_picks: {
              type: 'array',
              description: 'The artwork picks for the END frame, by the same rules: characters in frame at the end, and a set artwork ONLY when the camera\'s final position sees the part of the set it shows (a tilt from the sky onto the building picks the exterior artwork here, not for the start frame). May be empty.',
              items: {
                type: 'object',
                properties: {
                  subject: { type: 'string', description: 'The subject name exactly as listed in the artwork catalog.' },
                  artwork_index: { type: 'integer', description: '1-based index into that subject\'s artwork list.' },
                  use: { type: 'string', enum: ['look', 'framing'], description: 'Sets only (characters: "look"). "framing" only when the end camera essentially reproduces the artwork\'s own viewpoint.' },
                },
                required: ['subject', 'artwork_index', 'use'],
                additionalProperties: false,
              },
            },
          },
          required: ['cut_index', 'start_frame_prompt', 'reference_picks', 'end_frame_prompt', 'end_reference_picks'],
          additionalProperties: false,
        },
      },
    },
    required: ['cuts'],
    additionalProperties: false,
  },
};

// ─── System prompts ─────────────────────────────────────────────────────────

export const SCENES_SYSTEM_PROMPT = [
  'You are a film director reading one beat of a screenplay before it is shot. Break it into scenes and read each one. Return your work via the break_beat_into_scenes tool.',
  '',
  '# What a scene is',
  '- A continuous stretch of the beat in one location and one time. The sluglines the body declares are the boundaries; a beat with no sluglines is one scene unless the prose plainly changes location or time. Never split a continuous exchange into two scenes for length — cuts do that later.',
  '- Cover the WHOLE beat in order with no gaps. Give each scene verbatim text anchors (the first and last words of its prose) so it can be located.',
  '- set_names and character_names are copied EXACTLY from the beat\'s lists. A scene names only the characters physically present in it.',
  '- Every numbered dialogue line belongs to exactly one scene, in order, contiguous.',
  '',
  '# The read',
  DIRECTORS_READ_RULES,
  '',
  '# What the read becomes (so you write carriers, not moods)',
  CARRIER_TABLE_RULES,
  '',
  '# Scope',
  SCOPE_RULES,
  '',
  '# Floor plan',
  FLOOR_PLAN_RULES,
  '',
  '# Language',
  FEELING_RULES,
  '',
  'Be concrete in every field: an object, a gesture, a line of light, a fact from the prose. A field that would fit any other story is a blank.',
].join('\n');

export const CUTS_SYSTEM_PROMPT = [
  'You are a director and DP building the shot table for ONE scene of a screenplay beat. You have the scene\'s director\'s read, intention, scope, floor plan and its dialogue lines. Return the table via the plan_cuts tool — every row, every column.',
  '',
  '# The table',
  SHOT_TABLE_RULES,
  '',
  '# From the read to the instruments',
  CARRIER_TABLE_RULES,
  '',
  STARTING_STACKS_RULES,
  '',
  '# How many cuts',
  '- One cut carries ONE visible beat with a changed endpoint (before state → action → changed state). Story beats are one cut each; a reaction or an insert is half a beat and gets its own row when the audience must be told how to feel. A crossing between landmarks is its own row.',
  '- Each cut becomes ONE generation with its own start frame, so a row must be a single camera setup a still could open on. A shot that needs a big action AND a readable face is two cuts.',
  '- As many cuts as the scene\'s beats need and no more; do not pad with coverage. Keep it under twelve.',
  '',
  '# Dialogue coverage',
  CUT_DIALOGUE_RULES,
  '',
  '# Emotion',
  FEELING_RULES,
  '',
  '# Rules learned from rendered faults',
  EIGHT_RULES,
  '',
  '# Framing decides what a cut can hold',
  SHOT_SIZE_FIDELITY_RULES,
  '',
  '# One coherent eyeline per cut',
  CAMERA_COHERENCE_RULES,
  '',
  '# Camera moves',
  CAMERA_MOTION_RULES,
  '',
  '# What breaks in generation',
  FRAGILITY_RULES,
  '',
  '# Text is a post-production layer',
  NO_TEXT_RULES,
  '',
  '# Hard constraints',
  '- in_frame lists EVERY principal this camera can see, by exact name, each with a position relative to a landmark and a facing. Exactly one of them has acts: true (the action_by), unless the cut is an insert with no person.',
  '- lens_mm is a real focal length; height, side and lighting are words a crew could act on; lighting uses the floor plan\'s source and colour.',
  '- last_frame must be visible from this camera. others is never blank when anyone else is in frame.',
  '- sets_in_scene copies the scene\'s set names exactly.',
].join('\n');

export const PROSE_SYSTEM_PROMPT = [
  'You are compiling a scene\'s shot table into generation prompts for a video model, one block per cut. The model is a crew that has never met you, cannot ask a question and takes every word at face value. Return every block via the write_cut_prompts tool.',
  '',
  '# The block',
  BLOCK_FORM_RULES,
  '',
  '# The lock line',
  LOCK_LINE_RULES,
  '',
  '# What the read becomes',
  CARRIER_TABLE_RULES,
  '',
  '# Rules learned from rendered faults',
  EIGHT_RULES,
  '',
  '# Emotion',
  FEELING_RULES,
  '',
  '# Dialogue',
  CUT_DIALOGUE_RULES,
  '',
  '# Reference binding (a separate field, never inside the block)',
  REFERENCE_BINDING_RULES,
  '',
  '# Language',
  CUT_ANTI_SLOP_RULES,
  '',
  '# Text is a post-production layer',
  NO_TEXT_RULES,
  '',
  '# The target shape',
  EXEMPLAR_SCENE,
  '',
  '# Output',
  '- Compile each row from the table exactly: the same camera, the same people in the same places facing the same way, the same one action, the same last frame. The table is the truth; the block is its rendering.',
  '- Do NOT begin a block with "Cut N." or any number — the labels in the exemplar are for reading only. Each block stands alone.',
  '- Write the lock line into the block AND copy it into lock_line verbatim. Write any exclusion at the very end of the block AND list it in exclusions verbatim.',
  '- Physical identity in the lock line (age band, hair, wardrobe, distinguishing object) comes from the character context; keep it to a phrase per person and use the same words in every cut of the scene.',
  '- A covered line is never quoted. It is the speaker, the voice, the eyes and the face after the last word, plus "no music during the line" in the Sound clause.',
].join('\n');

export const START_FRAMES_SYSTEM_PROMPT = [
  'You are deriving, for every cut of a scene, the prompts an image model will render as that cut\'s START FRAME — the frozen first frame the clip opens on — and its END FRAME — the frozen last frame the clip lands on — and picking the reference artwork for each subject in each frame. Return everything via the derive_start_frames tool.',
  '',
  START_FRAME_RULES,
  '',
  END_FRAME_RULES,
  '',
  '# Opening composition',
  STILL_FRAMING_RULES,
  '',
  '# One coherent eyeline',
  CAMERA_COHERENCE_RULES,
  '',
  '# Continuity state',
  CONTINUITY_STATE_RULES,
  '',
  '# Placeholder occupants',
  OCCUPANT_PLACEHOLDER_RULES,
  '',
  '# Text is a post-production layer',
  NO_TEXT_RULES,
  '',
  '# Language',
  ANTI_SLOP_RULES,
  '',
  '# Reference picks',
  '- For every character in the cut\'s in_frame, pick ONE artwork from that subject\'s numbered list: the one whose description best matches this cut\'s framing (full body for wides, face for close shots), state and time of day. Skip a subject that has no artwork listed. Never invent an index.',
  '- A set artwork is a picture of ONE part of the place from ONE camera. Pick it only when this cut\'s camera sees that part of the set (an exterior artwork is never picked for a shot inside the building; a wide of the building is useless for a close-up whose background is a seat back). No fitting artwork → no set pick; that is the right answer, not a gap.',
  '- Every set pick says how the image model should use it. "look" (the default): the same place — architecture, materials, colours, signage style — rebuilt from THIS cut\'s camera; the artwork\'s framing is ignored. "framing": only when this cut\'s camera essentially reproduces the artwork\'s own viewpoint and composition. Character picks are always "look".',
  '- The start and end frames are picked separately (reference_picks, end_reference_picks). A camera that holds usually picks the same artwork twice; a camera that moves picks what it sees at each end — the set artwork belongs to whichever frame actually shows that part of the place.',
].join('\n');

// ─── Formatting helpers (pure) ──────────────────────────────────────────────

function plain(v) {
  return stripMarkdown(typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
}

function nameKey(v) {
  return plain(v).toLowerCase();
}

export function groupCatalogBySubject(catalog) {
  const groups = new Map();
  for (const e of catalog || []) {
    const key = `${e.owner_type}:${nameKey(e.owner_name)}`;
    if (!groups.has(key)) {
      groups.set(key, { subject: plain(e.owner_name), owner_type: e.owner_type, entries: [] });
    }
    const g = groups.get(key);
    g.entries.push({ index: g.entries.length + 1, image_id: String(e.image_id), label: e.label, description: e.description || '' });
  }
  return [...groups.values()];
}

export function formatCatalogBySubject(groups) {
  if (!groups?.length) return '(no artwork available for this beat\'s characters and sets — leave reference_picks empty)';
  return groups
    .map((g) => {
      const head = `${g.subject} (${g.owner_type}):`;
      const rows = g.entries.map((e) => {
        // Long enough for the picker to read where the artwork's camera stands.
        const d = e.description ? ` — ${e.description.length > 600 ? `${e.description.slice(0, 600)}…` : e.description}` : '';
        return `  ${e.index}. ${e.label}${d}`;
      });
      return [head, ...rows].join('\n');
    })
    .join('\n');
}

function formatRead(read) {
  return DIRECTORS_READ_FIELDS.map((f) => `- ${f.replace(/_/g, ' ')}: ${read?.[f] || '(blank)'}`).join('\n');
}

function formatScope(scope) {
  return SCOPE_BUCKETS.map((b) => `- ${b.replace(/_/g, ' ')}: ${(scope?.[b] || []).join('; ') || '—'}`).join('\n');
}

// Scene dialogue, keeping the BEAT-WIDE numbering the context block uses.
export function formatSceneDialogLines(dialogs, lineNumbers) {
  const nums = (lineNumbers || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= (dialogs?.length || 0));
  if (!nums.length) return '(no dialogue lines in this scene)';
  return nums
    .map((n) => {
      const d = dialogs[n - 1];
      const speaker = plain(d?.character) || 'UNKNOWN';
      const body = plain(d?.body);
      const dir = plain(d?.direction);
      const words = body ? body.split(/\s+/).length : 0;
      const head = `${n}. ${speaker}: ${body ? `(${words} words)` : '(no line)'} ${formatDialogAudioMark(d)}`;
      return dir ? `${head}\n     direction: ${dir}` : head;
    })
    .join('\n');
}

export function formatSceneBrief(scene, dialogs) {
  return [
    `# Scene ${scene.order ?? ''}: ${scene.title || 'Untitled'}`,
    `Slug: ${scene.slug || '(none)'}`,
    `Sets: ${(scene.set_names || []).join(', ') || '(none)'}`,
    `Characters present: ${(scene.character_names || []).join(', ') || '(none)'}`,
    `Text span: starts "${scene.text_span?.starts_with || ''}" … ends "${scene.text_span?.ends_with || ''}"`,
    '',
    "Director's read:",
    formatRead(scene.directors_read),
    `Intention: ${scene.intention || '(blank)'}`,
    '',
    'Scope:',
    formatScope(scene.scope),
    '',
    'Floor plan:',
    scene.floor_plan || '(blank)',
    '',
    'Dialogue lines in this scene (beat-wide numbers; words withheld on purpose):',
    formatSceneDialogLines(dialogs, scene.dialog_lines),
  ].join('\n');
}

export function formatCutRow(cut, i, dialogs) {
  const c = cut.camera || {};
  const move = c.movement && c.movement !== 'static' ? `${c.movement}${c.motivation ? ` (${c.motivation})` : ''}` : 'static';
  const inFrame = (cut.in_frame || []).length
    ? cut.in_frame.map((p) => `${p.character}${p.acts ? ' [acts]' : ''} — ${p.position} — facing ${p.facing}`).join('; ')
    : '(no one in frame)';
  const lines = (cut.dialog_lines || []).length
    ? cut.dialog_lines.map((n) => {
        const d = dialogs?.[n - 1];
        return `${n} (${plain(d?.character) || '?'}${d?.audio_file_id ? ', recorded' : ''})`;
      }).join(', ')
    : 'none';
  return [
    `Cut ${i + 1}${cut.reaction ? ' (reaction, half a beat)' : ''}${cut.crossing ? ' (crossing)' : ''} — covers lines: ${lines}`,
    `  camera: ${c.size || '?'}, ${c.angle || '?'}, ${c.height || '?'}, ${c.lens_mm ? `${c.lens_mm}mm` : '?'}, ${c.side || '?'}, ${move}, ${c.depth_of_field || '?'} focus`,
    `  light: ${c.lighting || '?'}`,
    `  in frame: ${inFrame}`,
    `  eyeline: ${cut.eyeline || '—'}`,
    `  action (${cut.action_by || 'no one'}): ${cut.action || '—'}`,
    `  others: ${cut.others || '—'}`,
    `  last frame: ${cut.last_frame || '—'}`,
    `  sound: ${cut.sound || '—'}${cut.sound_on_action ? ' (lands on the action)' : ''}${cut.contact ? '; contact must land' : ''}`,
    `  sets: ${(cut.sets_in_scene || []).join(', ') || '—'}; spend: ${cut.primary_spend || '?'}; felt intent: ${cut.felt_intent || '—'}`,
    `  duration: ${cut.duration_seconds ?? '?'} s`,
  ].join('\n');
}

// ─── User texts (pure) ──────────────────────────────────────────────────────

export function buildScenesUserText({ sluglines = [] } = {}) {
  return [
    'Break this beat into its scenes and read each one with the break_beat_into_scenes tool.',
    sluglines.length
      ? `The body declares ${sluglines.length} slugline${sluglines.length === 1 ? '' : 's'}; use them as the scene boundaries unless the prose plainly continues across one.`
      : 'The body declares no sluglines; return one scene unless the prose changes location or time.',
    'Copy set and character names exactly. Assign every numbered dialogue line to exactly one scene, in order.',
  ].join('\n');
}

export function buildCutsUserText({ scene, sceneIndex, sceneCount, previousCut = null, dialogs = [] }) {
  const lines = [
    `Plan the shot table for scene ${sceneIndex + 1} of ${sceneCount} with the plan_cuts tool.`,
    '',
    formatSceneBrief(scene, dialogs),
  ];
  if (previousCut) {
    lines.push('', 'The previous scene ended on this cut (hand off from it; do not restage it):', formatCutRow(previousCut, previousCut.cut_index - 1, dialogs));
  }
  lines.push('', 'Every row, every column. Cover every dialogue line of this scene exactly once, in order.');
  return lines.join('\n');
}

export function buildProseUserText({ scene, cuts, dialogs = [] }) {
  return [
    `Compile every cut of this scene into its block with the write_cut_prompts tool (${cuts.length} cut${cuts.length === 1 ? '' : 's'}).`,
    '',
    formatSceneBrief(scene, dialogs),
    '',
    '# Shot table',
    cuts.map((c, i) => formatCutRow(c, i, dialogs)).join('\n\n'),
    '',
    'One block per row, in order, each ending with its lock line and its ending. The words of a covered line never appear.',
  ].join('\n');
}

export function buildStartFramesUserText({ scene, cuts, dialogs = [], catalogGroups = [] }) {
  const blocks = cuts.map((c, i) => [formatCutRow(c, i, dialogs), `  block: ${c.prompt || '(none)'}`].join('\n'));
  return [
    `Derive the start frame and the end frame for every cut of this scene with the derive_start_frames tool (${cuts.length} cut${cuts.length === 1 ? '' : 's'}).`,
    '',
    `Floor plan: ${scene.floor_plan || '(blank)'}`,
    '',
    '# Cuts (table row, then the compiled block)',
    blocks.join('\n\n'),
    '',
    '# Artwork catalog, per subject (pick by number)',
    formatCatalogBySubject(catalogGroups),
  ].join('\n');
}

// ─── Normalizers (pure) ─────────────────────────────────────────────────────

function matchName(raw, roster) {
  const key = nameKey(raw);
  if (!key) return null;
  return roster.find((n) => nameKey(n) === key) || null;
}

function intList(raw) {
  return (Array.isArray(raw) ? raw : []).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 1);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Partition a list of line numbers across ordered holders. Each holder has a
// `lines` array; `all` is the ordered universe every line must land in
// exactly once. Repairs duplicates and gaps in place, recording warnings.
function repairLinePartition(holders, all, warnings, label) {
  const universe = [...new Set(all)].sort((a, b) => a - b);
  const seen = new Set();
  holders.forEach((h, i) => {
    const kept = [];
    for (const n of h.lines) {
      if (!universe.includes(n)) {
        warnings.push(`${label} ${i + 1}: dropped dialogue line ${n} (not in range).`);
        continue;
      }
      if (seen.has(n)) {
        warnings.push(`${label} ${i + 1}: dialogue line ${n} was assigned twice; kept the first.`);
        continue;
      }
      seen.add(n);
      kept.push(n);
    }
    h.lines = kept.sort((a, b) => a - b);
  });
  if (!holders.length) return;
  for (const n of universe) {
    if (seen.has(n)) continue;
    // Home: the holder covering the nearest lower line, else the first holder
    // covering a higher line, else the last holder.
    let target = null;
    for (let i = holders.length - 1; i >= 0; i--) {
      if (holders[i].lines.some((m) => m < n)) { target = holders[i]; break; }
    }
    if (!target) target = holders.find((h) => h.lines.some((m) => m > n)) || holders[holders.length - 1];
    target.lines = [...target.lines, n].sort((a, b) => a - b);
    warnings.push(`${label}: dialogue line ${n} was unassigned; placed it in ${label.toLowerCase()} ${holders.indexOf(target) + 1}.`);
  }
}

export function normalizeScenes(raw, { characters = [], sets = [], dialogs = [] } = {}) {
  const warnings = [];
  const charNames = characters.map((c) => plain(c.name)).filter(Boolean);
  const setNames = sets.map((s) => plain(s.name)).filter(Boolean);
  const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_SCENES);
  if (Array.isArray(raw) && raw.length > MAX_SCENES) warnings.push(`The model returned ${raw.length} scenes; kept the first ${MAX_SCENES}.`);
  const scenes = [];
  list.forEach((s, i) => {
    const title = str(s?.title) || `Scene ${i + 1}`;
    const setPicks = [];
    for (const n of Array.isArray(s?.set_names) ? s.set_names : []) {
      const m = matchName(n, setNames);
      if (m) { if (!setPicks.includes(m)) setPicks.push(m); }
      else warnings.push(`Scene ${i + 1}: unknown set "${n}" dropped.`);
    }
    const charPicks = [];
    for (const n of Array.isArray(s?.character_names) ? s.character_names : []) {
      const m = matchName(n, charNames);
      if (m) { if (!charPicks.includes(m)) charPicks.push(m); }
      else warnings.push(`Scene ${i + 1}: unknown character "${n}" dropped.`);
    }
    const read = {};
    for (const f of DIRECTORS_READ_FIELDS) {
      read[f] = str(s?.directors_read?.[f]);
      if (!read[f]) warnings.push(`Scene ${i + 1}: director's read field "${f.replace(/_/g, ' ')}" is blank.`);
    }
    const scope = {};
    for (const b of SCOPE_BUCKETS) {
      scope[b] = (Array.isArray(s?.scope?.[b]) ? s.scope[b] : []).map(str).filter(Boolean);
    }
    const floorPlan = str(s?.floor_plan);
    if (!floorPlan) warnings.push(`Scene ${i + 1}: floor plan is blank.`);
    scenes.push({
      order: i + 1,
      title,
      slug: str(s?.slug),
      set_names: setPicks,
      character_names: charPicks,
      text_span: { starts_with: str(s?.text_span?.starts_with), ends_with: str(s?.text_span?.ends_with) },
      directors_read: read,
      intention: str(s?.intention),
      scope,
      floor_plan: floorPlan,
      dialog_lines: intList(s?.dialog_lines),
    });
  });
  const all = dialogs.map((_, i) => i + 1);
  const holders = scenes.map((s) => ({ lines: s.dialog_lines }));
  repairLinePartition(holders, all, warnings, 'Scene');
  scenes.forEach((s, i) => {
    s.dialog_lines = holders[i].lines;
    s.dialog_ids = s.dialog_lines.map((n) => dialogs[n - 1]?._id).filter(Boolean);
  });
  return { scenes, warnings };
}

export function normalizeCuts(raw, { scene, dialogs = [] } = {}) {
  const warnings = [];
  const sceneLabel = `Scene ${scene?.order ?? ''}`.trim();
  const roster = scene?.character_names || [];
  const setRoster = scene?.set_names || [];
  const list = (Array.isArray(raw) ? raw : []).slice(0, MAX_CUTS_PER_SCENE);
  if (Array.isArray(raw) && raw.length > MAX_CUTS_PER_SCENE) warnings.push(`${sceneLabel}: the model returned ${raw.length} cuts; kept the first ${MAX_CUTS_PER_SCENE}.`);
  const cuts = [];
  list.forEach((c, i) => {
    const label = `${sceneLabel} cut ${i + 1}`;
    const inFrame = [];
    for (const p of Array.isArray(c?.in_frame) ? c.in_frame : []) {
      const m = matchName(p?.character, roster);
      if (!m) { if (str(p?.character)) warnings.push(`${label}: "${p.character}" is not in this scene; dropped from in_frame.`); continue; }
      if (inFrame.some((x) => x.character === m)) continue;
      inFrame.push({ character: m, position: str(p?.position), facing: str(p?.facing), acts: Boolean(p?.acts) });
    }
    let actionBy = matchName(c?.action_by, inFrame.map((p) => p.character)) || '';
    if (!actionBy) {
      const actor = inFrame.find((p) => p.acts) || inFrame[0];
      actionBy = actor?.character || '';
    }
    inFrame.forEach((p) => { p.acts = p.character === actionBy; });
    let sets = [];
    for (const n of Array.isArray(c?.sets_in_scene) ? c.sets_in_scene : []) {
      const m = matchName(n, setRoster);
      if (m && !sets.includes(m)) sets.push(m);
    }
    if (!sets.length) sets = [...setRoster];
    const camera = normalizeCamera(c?.camera);
    if (!camera.size) warnings.push(`${label}: camera size missing or unknown.`);
    if (!camera.lighting) warnings.push(`${label}: light source and colour not stated.`);
    if (inFrame.length > 1 && !str(c?.others)) warnings.push(`${label}: no idle business for the others in frame.`);
    if (!str(c?.last_frame)) warnings.push(`${label}: last frame not stated.`);
    cuts.push({
      cut_index: i + 1,
      camera,
      in_frame: inFrame,
      action_by: actionBy,
      reaction: Boolean(c?.reaction),
      eyeline: str(c?.eyeline),
      action: str(c?.action),
      others: str(c?.others),
      last_frame: str(c?.last_frame),
      sound: str(c?.sound),
      sound_on_action: Boolean(c?.sound_on_action),
      crossing: Boolean(c?.crossing),
      contact: Boolean(c?.contact),
      dialog_lines: intList(c?.dialog_lines),
      sets_in_scene: sets,
      characters_in_scene: inFrame.map((p) => p.character),
      primary_spend: PRIMARY_SPENDS.includes(c?.primary_spend) ? c.primary_spend : null,
      felt_intent: str(c?.felt_intent),
    });
  });
  const holders = cuts.map((c) => ({ lines: c.dialog_lines }));
  repairLinePartition(holders, scene?.dialog_lines || [], warnings, `${sceneLabel} cut`);
  cuts.forEach((c, i) => {
    c.dialog_lines = holders[i].lines;
    c.dialog_ids = c.dialog_lines.map((n) => dialogs[n - 1]?._id).filter(Boolean);
    const covered = c.dialog_lines.map((n) => dialogs[n - 1]).filter(Boolean);
    for (const d of covered) {
      const speaker = matchName(d?.character, c.characters_in_scene);
      if (!speaker) warnings.push(`${sceneLabel} cut ${i + 1}: covers a line spoken by ${plain(d?.character) || 'an unknown speaker'} who is not in frame.`);
    }
    c.duration_seconds = estimateCutDuration(c, { coveredDialogs: covered });
  });
  return { cuts, warnings };
}

function stripLeadingLabel(text) {
  return String(text || '').replace(/^\s*(?:cut|shot)\s*\d+\s*[.:—-]\s*/i, '').trim();
}

function fallbackBlock(cut) {
  const c = cut.camera || {};
  const who = (cut.in_frame || []).map((p) => `${p.character} ${p.position}, facing ${p.facing}`).join('; ');
  return [
    `${c.size ? c.size.replace(/_/g, ' ') : 'Medium'} shot ${c.side || ''}${c.lens_mm ? `, ${c.lens_mm}mm` : ''}, the camera ${c.movement && c.movement !== 'static' ? `${c.movement.replace(/_/g, ' ')}s` : 'holding'}:`,
    who ? `${who}.` : '',
    cut.action || '',
    cut.others || '',
    cut.sound ? `Sound: ${cut.sound}.` : '',
    `Light: ${c.lighting || 'as the floor plan states'}.`,
    cut.last_frame ? `End with ${cut.last_frame}.` : '',
  ].filter(Boolean).join(' ');
}

export function applyProse(raw, cuts, { dialogs = [] } = {}) {
  const warnings = [];
  const byIndex = new Map();
  for (const e of Array.isArray(raw) ? raw : []) {
    const n = Number(e?.cut_index);
    if (Number.isInteger(n) && !byIndex.has(n)) byIndex.set(n, e);
  }
  for (const cut of cuts) {
    const e = byIndex.get(cut.cut_index);
    let prompt = stripLeadingLabel(str(e?.prompt));
    if (!prompt) {
      warnings.push(`Cut ${cut.cut_index}: the model wrote no block; a plain one was built from the table row.`);
      prompt = fallbackBlock(cut);
    }
    cut.title = str(e?.title) || `Cut ${cut.cut_index}`;
    cut.prompt = prompt;
    cut.lock_line = str(e?.lock_line);
    cut.reference_binding = str(e?.reference_binding);
    cut.exclusions = (Array.isArray(e?.exclusions) ? e.exclusions : []).map(str).filter(Boolean);
    const covered = (cut.dialog_lines || []).map((n) => dialogs[n - 1]).filter(Boolean);
    cut.lint = lintCut(cut, { coveredDialogs: covered });
  }
  return { warnings };
}

export function applyStartFrames(raw, cuts, { catalogGroups = [] } = {}) {
  const warnings = [];
  const byIndex = new Map();
  for (const e of Array.isArray(raw) ? raw : []) {
    const n = Number(e?.cut_index);
    if (Number.isInteger(n) && !byIndex.has(n)) byIndex.set(n, e);
  }
  const groupsByKey = new Map(catalogGroups.map((g) => [nameKey(g.subject), g]));
  const resolvePicks = (picks, cut, which) => {
    const ids = [];
    const uses = {};
    for (const p of picks) {
      const g = groupsByKey.get(nameKey(p?.subject));
      if (!g) { warnings.push(`Cut ${cut.cut_index}: ${which} reference pick for unknown subject "${p?.subject}" dropped.`); continue; }
      const entry = g.entries[Number(p?.artwork_index) - 1];
      if (!entry) { warnings.push(`Cut ${cut.cut_index}: ${g.subject} has no artwork #${p?.artwork_index}; dropped.`); continue; }
      if (ids.includes(entry.image_id)) continue;
      ids.push(entry.image_id);
      if (g.owner_type === 'set' && p?.use === 'framing') uses[entry.image_id] = 'framing';
    }
    return { ids, uses };
  };
  const plannedFrame = (prompt, { ids, uses }) => ({
    image_id: null,
    prompt,
    reference_ids: ids,
    reference_scores: {},
    reference_uses: uses,
    // The planner chose these (possibly none): the renderer must not
    // auto-fill an empty list with artwork the camera cannot see.
    references_planned: true,
    model: null,
    generated_at: null,
    previous_image_id: null,
  });
  for (const cut of cuts) {
    const e = byIndex.get(cut.cut_index);
    let prompt = str(e?.start_frame_prompt);
    if (!prompt) {
      warnings.push(`Cut ${cut.cut_index}: no start-frame prompt returned; using the block's opening.`);
      prompt = String(cut.prompt || '').split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');
    }
    const startPicks = resolvePicks(Array.isArray(e?.reference_picks) ? e.reference_picks : [], cut, 'start');
    cut.start_frame = plannedFrame(prompt, startPicks);
    let endPrompt = str(e?.end_frame_prompt);
    if (!endPrompt) {
      warnings.push(`Cut ${cut.cut_index}: no end-frame prompt returned; using the last-frame cell.`);
      endPrompt = str(cut.last_frame);
    }
    // No end picks at all (not even an empty list) → the start picks: the
    // same subjects are the best guess for a camera the model said nothing about.
    const endPicks = Array.isArray(e?.end_reference_picks)
      ? resolvePicks(e.end_reference_picks, cut, 'end')
      : { ids: [...startPicks.ids], uses: { ...startPicks.uses } };
    cut.end_frame = endPrompt ? plannedFrame(endPrompt, endPicks) : null;
  }
  return { warnings };
}

// ─── LLM calls ──────────────────────────────────────────────────────────────

let callsOverride = null;
// Test seam: fn({ pass, contextText, userText, scene, cuts }) → raw tool input.
export function _setCutPlannerCallsForTests(fn) {
  callsOverride = fn;
}

async function callPass({ pass, system, tool, contextText, userText, extra = {}, usage, job = null }) {
  if (callsOverride) return callsOverride({ pass, contextText, userText, ...extra });
  const client = getAnthropic();
  const model = modelFor('storyboard');
  // tool_choice stays 'auto': the Claude 5 family rejects forced tool use
  // ("type \"tool\" and \"any\" are not supported for this model"). The prompt
  // asks for the tool; if the model answers in prose anyway we retry once with
  // an explicit nudge, then give up (the callers treat null as an empty pass).
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: contextText, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: userText },
      ],
    },
  ];
  let toolUse = null;
  for (let attempt = 0; attempt < 2 && !toolUse; attempt++) {
    if (job) {
      job.live = { pass, items: 0, item_label: null, tail: null, chars: 0, started_at: new Date().toISOString() };
      logEvent(job, `${attempt ? 'Retrying — asking' : 'Asking'} ${model} (${tool.name})…`);
    }
    const stream = client.messages.stream({
      model,
      max_tokens: 16000,
      system,
      tools: [tool],
      tool_choice: { type: 'auto' },
      messages,
    });
    if (job) stream.on('inputJson', (partialJson, snapshot) => updateLive(job, pass, partialJson, snapshot));
    const resp = await stream.finalMessage();
    if (resp.stop_reason === 'max_tokens') {
      logger.warn(`cut planner ${pass}: hit max_tokens (model=${model}); response may be truncated`);
      if (job) warn(job, `${tool.name}: the model hit its output limit; the result may be truncated.`);
    }
    if (usage && resp.usage) {
      usage.input_tokens += Number(resp.usage.input_tokens) || 0;
      usage.output_tokens += Number(resp.usage.output_tokens) || 0;
      usage.model = model;
      if (job) {
        job.usage.input_tokens += Number(resp.usage.input_tokens) || 0;
        job.usage.output_tokens += Number(resp.usage.output_tokens) || 0;
        logEvent(job, `${model} answered: ${job.live?.items || 0} item(s), ${Number(resp.usage.output_tokens) || 0} output tokens`);
      }
    }
    toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name) || null;
    if (!toolUse) {
      logger.warn(
        `cut planner ${pass}: model did not call ${tool.name} (stop_reason=${resp.stop_reason}, attempt ${attempt + 1})`,
      );
      if (attempt === 0) {
        messages.push({ role: 'assistant', content: resp.content?.length ? resp.content : [{ type: 'text', text: '(no output)' }] });
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: `Do not answer in prose. Call the ${tool.name} tool now with the complete result.` }],
        });
      }
    }
  }
  if (job) job.live = null;
  return toolUse?.input || null;
}

async function recordUsage(usage) {
  try {
    if (!usage || (!usage.input_tokens && !usage.output_tokens)) return;
    await recordAnthropicTextUsage({
      discordUser: null,
      channelId: null,
      model: usage.model,
      totals: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    });
  } catch (e) {
    logger.warn(`cut planner: usage record failed: ${e?.message || e}`);
  }
}

// ─── Pipeline (in memory) ───────────────────────────────────────────────────

// Runs passes 2–4 for one scene. Returns the fully populated cuts.
async function planSceneCuts({ ctx, scene, sceneIndex, sceneCount, previousCut, catalogGroups, contextText, job, usage }) {
  const dialogs = ctx.dialogs;
  setPhase(job, `cuts:${sceneIndex + 1}/${sceneCount}`);
  const cutsRaw = await callPass({
    pass: 'cuts',
    system: CUTS_SYSTEM_PROMPT,
    tool: PLAN_CUTS_TOOL,
    contextText,
    userText: buildCutsUserText({ scene, sceneIndex, sceneCount, previousCut, dialogs }),
    extra: { scene },
    usage,
    job,
  });
  const { cuts, warnings: w1 } = normalizeCuts(cutsRaw?.cuts, { scene, dialogs });
  w1.forEach((w) => warn(job, w));
  endStep(job, `cuts:${sceneIndex + 1}/${sceneCount}`, { detail: `${cuts.length} cut(s)${cuts.length ? `: ${cuts.map((c) => c.title || `#${c.cut_index}`).join(' · ')}` : ''}` });
  if (!cuts.length) return [];
  setPhase(job, `prose:${sceneIndex + 1}/${sceneCount}`);
  const proseRaw = await callPass({
    pass: 'prose',
    system: PROSE_SYSTEM_PROMPT,
    tool: WRITE_CUT_PROMPTS_TOOL,
    contextText,
    userText: buildProseUserText({ scene, cuts, dialogs }),
    extra: { scene, cuts },
    usage,
    job,
  });
  applyProse(proseRaw?.cuts, cuts, { dialogs }).warnings.forEach((w) => warn(job, w));
  {
    const lint = cuts.reduce((m, c) => m + (c.lint?.length || 0), 0);
    endStep(job, `prose:${sceneIndex + 1}/${sceneCount}`, { detail: `${cuts.length} block(s)${lint ? `, ${lint} lint finding(s)` : ''}` });
  }
  setPhase(job, `start_frame_prompts:${sceneIndex + 1}/${sceneCount}`);
  const sfRaw = await callPass({
    pass: 'start_frames',
    system: START_FRAMES_SYSTEM_PROMPT,
    tool: DERIVE_START_FRAMES_TOOL,
    contextText,
    userText: buildStartFramesUserText({ scene, cuts, dialogs, catalogGroups }),
    extra: { scene, cuts },
    usage,
    job,
  });
  applyStartFrames(sfRaw?.cuts, cuts, { catalogGroups }).warnings.forEach((w) => warn(job, w));
  endStep(job, `start_frame_prompts:${sceneIndex + 1}/${sceneCount}`, {
    detail: `${cuts.filter((c) => c.start_frame?.prompt).length}/${cuts.length} start + ${cuts.filter((c) => c.end_frame?.prompt).length}/${cuts.length} end still prompt(s), ${cuts.reduce((n, c) => n + (c.start_frame?.reference_ids?.length || 0) + (c.end_frame?.reference_ids?.length || 0), 0)} artwork pick(s)`,
  });
  const coveredByCut = new Map();
  cuts.forEach((c, i) => coveredByCut.set(String(i), (c.dialog_lines || []).map((n) => dialogs[n - 1]).filter(Boolean)));
  scene.load = sceneLoad(cuts, { coveredDialogsByCut: coveredByCut });
  if (scene.load?.verdict === 'ambitious') {
    warn(job, `Scene ${scene.order}: load is Ambitious (S = ${scene.load.s?.toFixed?.(1)}); consider splitting a cut rather than shortening it.`);
  }
  job.cuts_total += cuts.length;
  return cuts;
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function persistCut({ projectId, beatId, sceneId, cut, order, job }) {
  const row = await createVideoPromptViaGateway({
    projectId,
    beatId,
    order,
    title: cut.title,
    prompt: cut.prompt,
    durationSeconds: cut.duration_seconds,
    referenceImages: [],
    sceneId,
    cutIndex: cut.cut_index,
    camera: cut.camera,
    inFrame: cut.in_frame,
    actionBy: cut.action_by,
    reaction: cut.reaction,
    eyeline: cut.eyeline,
    action: cut.action,
    others: cut.others,
    lastFrame: cut.last_frame,
    sound: cut.sound,
    crossing: cut.crossing,
    contact: cut.contact,
    soundOnAction: cut.sound_on_action,
    charactersInScene: cut.characters_in_scene,
    setsInScene: cut.sets_in_scene,
    primarySpend: cut.primary_spend,
    feltIntent: cut.felt_intent,
    dialogIds: cut.dialog_ids,
    lockLine: cut.lock_line,
    referenceBinding: cut.reference_binding,
    exclusions: cut.exclusions,
    lint: cut.lint,
    startFrame: cut.start_frame,
    endFrame: cut.end_frame || null,
    seedFragments: {
      title: cut.title,
      prompt: cut.prompt,
      start_frame_prompt: cut.start_frame?.prompt || '',
      end_frame_prompt: cut.end_frame?.prompt || '',
    },
  });
  job.cuts_done += 1;
  return row;
}

async function persistScene({ projectId, beatId, scene, job }) {
  const row = await createVideoSceneViaGateway({
    projectId,
    beatId,
    order: scene.order,
    title: scene.title,
    slug: scene.slug,
    setNames: scene.set_names,
    characterNames: scene.character_names,
    textSpan: scene.text_span,
    directorsRead: scene.directors_read,
    intention: scene.intention,
    scope: scene.scope,
    floorPlan: scene.floor_plan,
    dialogIds: scene.dialog_ids,
    load: scene.load || null,
    seedFragments: { floor_plan: scene.floor_plan },
  });
  job.scenes_done += 1;
  return row;
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

const jobs = new Map();
const JOB_RETENTION_MS = 30 * 60 * 1000;
const MAX_EVENTS = 300;
const NOTIFY_THROTTLE_MS = 200;

export function getCutPlanJob(jobId) {
  return jobs.get(jobId) || null;
}

// The plan/replan job a reopened page should reattach to (see jobLookup.js).
export function findCutPlanJobForBeat(beatId) {
  return latestJobForBeat(jobs, beatId);
}

export class BeatBusyError extends Error {
  constructor(beatId) {
    super(`Work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

// ─── Live progress (steps · activity log · streamed LLM output) ────────────
//
// Every job carries `steps[]` (one per planner pass, in run order:
// pending → running → done|error|skipped), `events[]` (a capped activity
// log) and `live` (what the model is streaming RIGHT NOW: how many items of
// the tool input have arrived, the label of the last one, output size).
// Subscribers get a throttled snapshot on every change; the SSE route in
// entityRoutes.js relays them, and the plain GET returns the same shape.

const listeners = new Map();

export function subscribeToCutPlanJob(jobId, cb) {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId).add(cb);
}

export function unsubscribeFromCutPlanJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

export function serializeCutPlanJob(job) {
  if (!job) return null;
  const { _notify, ...rest } = job;
  return {
    ...rest,
    steps: job.steps.map((st) => ({ ...st })),
    events: job.events.slice(),
    warnings: job.warnings.slice(),
    live: job.live ? { ...job.live } : null,
    usage: { ...job.usage },
  };
}

function isTerminalStatus(s) {
  return s === 'done' || s === 'partial' || s === 'error';
}

function emit(job) {
  const set = listeners.get(job.job_id);
  if (!set?.size) return;
  const snap = serializeCutPlanJob(job);
  for (const cb of set) {
    try {
      cb(snap);
    } catch (e) {
      logger.warn(`cut plan job listener failed: ${e?.message || e}`);
    }
  }
  if (isTerminalStatus(job.status)) listeners.delete(job.job_id);
}

function notify(job, { immediate = false } = {}) {
  job.updated_at = new Date();
  if (immediate || isTerminalStatus(job.status)) {
    if (job._notify) { clearTimeout(job._notify); job._notify = null; }
    emit(job);
    return;
  }
  if (job._notify) return;
  job._notify = setTimeout(() => {
    job._notify = null;
    emit(job);
  }, NOTIFY_THROTTLE_MS);
  job._notify.unref?.();
}

function logEvent(job, text) {
  job.events.push({ at: new Date().toISOString(), text });
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  notify(job);
}

function warn(job, text) {
  job.warnings.push(text);
  logEvent(job, `⚠ ${text}`);
}

function stepLabel(phase) {
  const [name, frac] = String(phase).split(':');
  const scene = frac ? ` · scene ${frac}` : '';
  return (
    {
      context: 'Read the beat',
      scenes: 'Break into scenes',
      cuts: `Shot table${scene}`,
      prose: `Write the blocks${scene}`,
      start_frame_prompts: `Start & end still prompts${scene}`,
      writing: 'Save scenes & cuts',
      start_frames: 'Render start & end frames',
    }[name] || phase
  );
}

function findStep(job, key) {
  return job.steps.find((st) => st.key === key) || null;
}

// Pre-declare the pending steps once the scene count is known so the stepper
// shows the whole road ahead, not just the passes already run.
function planSteps(job, { sceneCount, firstScene = 1, renderStartFrames }) {
  const add = (key) => {
    if (!findStep(job, key)) job.steps.push({ key, label: stepLabel(key), status: 'pending', started_at: null, finished_at: null, detail: null });
  };
  for (let i = firstScene; i <= sceneCount; i++) {
    for (const pass of ['cuts', 'prose', 'start_frame_prompts']) add(`${pass}:${i}/${sceneCount}`);
  }
  add('writing');
  if (renderStartFrames) add('start_frames');
  notify(job);
}

function setPhase(job, phase) {
  const running = job.steps.find((st) => st.status === 'running');
  if (running && running.key !== phase) {
    running.status = 'done';
    running.finished_at = new Date().toISOString();
  }
  job.phase = phase;
  job.live = null;
  if (!isTerminalStatus(phase)) {
    let step = findStep(job, phase);
    if (!step) {
      step = { key: phase, label: stepLabel(phase), status: 'pending', started_at: null, finished_at: null, detail: null };
      job.steps.push(step);
    }
    step.status = 'running';
    step.started_at = new Date().toISOString();
    logEvent(job, `${step.label}…`);
  }
  notify(job, { immediate: true });
}

function endStep(job, key, { status = 'done', detail = null } = {}) {
  const step = findStep(job, key);
  if (!step) return;
  step.status = status;
  step.finished_at = new Date().toISOString();
  if (detail) step.detail = detail;
  if (detail) logEvent(job, `${step.label} — ${detail}`);
  notify(job);
}

// Called for every streamed tool-input delta: the SDK hands us the partially
// parsed input, so we can count the items written so far and name the last one.
function updateLive(job, pass, partialJson, snapshot) {
  if (!job) return;
  const live = job.live || (job.live = { pass, items: 0, item_label: null, tail: null, chars: 0, started_at: new Date().toISOString() });
  live.chars += partialJson?.length || 0;
  const list = snapshot && typeof snapshot === 'object' ? Object.values(snapshot).find((v) => Array.isArray(v)) : null;
  if (list) {
    live.items = list.length;
    const last = list[list.length - 1];
    if (last && typeof last === 'object') {
      live.item_label = str(last.title) || str(last.slug) || str(last.name) || (last.cut_index != null ? `cut ${last.cut_index}` : null) || null;
      let longest = '';
      for (const v of Object.values(last)) if (typeof v === 'string' && v.length > longest.length) longest = v;
      live.tail = longest ? longest.slice(-160) : null;
    }
  }
  notify(job);
}

function newJob({ beatId, kind, sceneId = null }) {
  const job = {
    job_id: new ObjectId().toString(),
    kind,
    beat_id: String(beatId),
    scene_id: sceneId ? String(sceneId) : null,
    status: 'queued',
    phase: 'queued',
    scenes_total: 0,
    scenes_done: 0,
    cuts_total: 0,
    cuts_done: 0,
    warnings: [],
    lint_count: 0,
    start_frames: null,
    steps: [],
    events: [],
    live: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    error: null,
    started_at: new Date(),
    updated_at: new Date(),
    finished_at: null,
    _notify: null,
  };
  jobs.set(job.job_id, job);
  const timer = setTimeout(() => jobs.delete(job.job_id), JOB_RETENTION_MS + 60 * 60 * 1000);
  timer.unref?.();
  return job;
}

function finish(job, status) {
  const running = job.steps.find((st) => st.status === 'running');
  if (running) {
    running.status = status === 'error' ? 'error' : 'done';
    running.finished_at = new Date().toISOString();
  }
  for (const st of job.steps) if (st.status === 'pending') st.status = 'skipped';
  job.status = status;
  job.finished_at = new Date();
  job.phase = status;
  job.live = null;
  const secs = Math.round((job.finished_at - job.started_at) / 1000);
  logEvent(
    job,
    status === 'error'
      ? `✗ Failed after ${secs}s: ${job.error || 'unknown error'}`
      : `${status === 'partial' ? '◐' : '✓'} ${status === 'partial' ? 'Finished with failures' : 'Done'} in ${secs}s — ${job.scenes_done} scene(s), ${job.cuts_done} cut(s), ${job.warnings.length} warning(s)`,
  );
  notify(job, { immediate: true });
}

let startFramesRendererOverride = null;
export function _setStartFramesRendererForTests(fn) {
  startFramesRendererOverride = fn;
}

async function maybeRenderStartFrames({ projectId, beat, cuts, imageModel, job }) {
  if (!cuts.length) return;
  setPhase(job, 'start_frames');
  const render = startFramesRendererOverride || (await import('./cutStartFrames.js')).renderStartFramesForCuts;
  job.start_frames = { planned: cuts.length * 2, rendered: 0, failed: 0 };
  await render({
    projectId,
    beat,
    cutIds: cuts.map((c) => String(c._id)),
    frames: ['start', 'end'],
    imageModel,
    onProgress: (p) => {
      job.start_frames = { ...job.start_frames, ...p };
      const sf = job.start_frames;
      logEvent(job, `Frames: ${sf.rendered}/${sf.planned} rendered${sf.failed ? `, ${sf.failed} failed` : ''}`);
    },
    onWarning: (w) => warn(job, w),
  });
  endStep(job, 'start_frames', {
    status: job.start_frames?.failed ? 'error' : 'done',
    detail: `${job.start_frames?.rendered || 0}/${job.start_frames?.planned || 0} rendered${job.start_frames?.failed ? `, ${job.start_frames.failed} failed` : ''}`,
  });
}

// The whole pipeline for a beat. 202-style: returns the job id at once.
export async function startCutPlanJob({ projectId, beatId, direction = '', renderStartFrames = false, imageModel = null }) {
  const beat = await getBeat(projectId, beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  const job = newJob({ beatId: beat._id, kind: 'plan' });
  withBeatLock(beat._id, () => runPlanJob({ job, beat, projectId, direction, renderStartFrames, imageModel })).catch((e) => {
    job.error = e?.message || String(e);
    finish(job, 'error');
    logger.error(`cut plan job ${job.job_id} crashed: ${job.error}`);
  });
  return job.job_id;
}

async function runPlanJob({ job, beat, projectId, direction, renderStartFrames, imageModel }) {
  job.status = 'running';
  const usage = { input_tokens: 0, output_tokens: 0, model: null };
  try {
    setPhase(job, 'context');
    const ctx = await loadFullBeatContext({ projectId, beat, direction });
    ctx.warnings.forEach((w) => warn(job, w));
    const catalog = await buildReferenceCatalog(projectId, beat);
    const catalogGroups = groupCatalogBySubject(catalog);
    const contextText = ctx.text;
    endStep(job, 'context', {
      detail: `${Math.round(contextText.length / 1000)}k chars, ${ctx.dialogs?.length || 0} dialogue line(s), ${catalog.length} artwork(s)`,
    });

    setPhase(job, 'scenes');
    const scenesRaw = await callPass({
      pass: 'scenes',
      system: SCENES_SYSTEM_PROMPT,
      tool: BREAK_SCENES_TOOL,
      contextText,
      userText: buildScenesUserText({ sluglines: ctx.sluglines }),
      usage,
      job,
    });
    const { scenes, warnings } = normalizeScenes(scenesRaw?.scenes, ctx);
    warnings.forEach((w) => warn(job, w));
    job.scenes_total = scenes.length;
    endStep(job, 'scenes', { detail: `${scenes.length} scene(s)${scenes.length ? `: ${scenes.map((sc) => sc.title || sc.slug).join(' · ')}` : ''}` });
    if (!scenes.length) {
      warn(job, 'The model returned no scenes; the existing scenes and cuts were kept.');
      finish(job, 'done');
      return;
    }
    planSteps(job, { sceneCount: scenes.length, renderStartFrames });

    const planned = [];
    let previousCut = null;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const cuts = await planSceneCuts({ ctx, scene, sceneIndex: i, sceneCount: scenes.length, previousCut, catalogGroups, contextText, job, usage });
      if (!cuts.length) warn(job, `Scene ${scene.order}: the model planned no cuts.`);
      planned.push({ scene, cuts });
      previousCut = cuts[cuts.length - 1] || previousCut;
    }
    job.lint_count = planned.reduce((n, p) => n + p.cuts.reduce((m, c) => m + (c.lint?.length || 0), 0), 0);

    setPhase(job, 'writing');
    await deleteAllVideoScenesForBeatViaGateway({ projectId, beatId: beat._id });
    const createdCuts = [];
    let order = 1;
    for (const { scene, cuts } of planned) {
      const sceneRow = await persistScene({ projectId, beatId: beat._id, scene, job });
      for (const cut of cuts) {
        try {
          const row = await persistCut({ projectId, beatId: beat._id, sceneId: sceneRow._id, cut, order, job });
          createdCuts.push(row);
          order += 1;
        } catch (e) {
          logger.warn(`cut plan: persist cut ${scene.order}/${cut.cut_index} failed: ${e.message}`);
          warn(job, `Scene ${scene.order} cut ${cut.cut_index} could not be saved: ${e.message}`);
        }
      }
    }
    endStep(job, 'writing', { detail: `${job.scenes_done} scene(s), ${job.cuts_done} cut(s) saved` });
    if (renderStartFrames) {
      await maybeRenderStartFrames({ projectId, beat, cuts: createdCuts, imageModel, job });
    }
    finish(job, job.start_frames?.failed ? 'partial' : 'done');
    logger.info(`cut plan job ${job.job_id} ${job.status} scenes=${job.scenes_done} cuts=${job.cuts_done} warnings=${job.warnings.length} lint=${job.lint_count}`);
  } finally {
    await recordUsage(usage);
  }
}

// Re-run passes 2–4 for ONE existing scene (keeps the scene doc and every
// other scene; replaces this scene's cuts).
export async function startSceneReplanJob({ projectId, sceneId, direction = '', renderStartFrames = false, imageModel = null }) {
  const scene = await getVideoScene(projectId, sceneId);
  if (!scene) throw new Error(`Scene not found: ${sceneId}`);
  const beat = await getBeat(projectId, String(scene.beat_id));
  if (!beat) throw new Error(`Beat not found for scene ${sceneId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  const job = newJob({ beatId: beat._id, kind: 'replan', sceneId: scene._id });
  withBeatLock(beat._id, () => runReplanJob({ job, beat, scene, projectId, direction, renderStartFrames, imageModel })).catch((e) => {
    job.error = e?.message || String(e);
    finish(job, 'error');
    logger.error(`scene replan job ${job.job_id} crashed: ${job.error}`);
  });
  return job.job_id;
}

async function runReplanJob({ job, beat, scene, projectId, direction, renderStartFrames, imageModel }) {
  job.status = 'running';
  const usage = { input_tokens: 0, output_tokens: 0, model: null };
  try {
    setPhase(job, 'context');
    const ctx = await loadFullBeatContext({ projectId, beat, direction });
    ctx.warnings.forEach((w) => warn(job, w));
    const catalogGroups = groupCatalogBySubject(await buildReferenceCatalog(projectId, beat));
    endStep(job, 'context', { detail: `${Math.round(ctx.text.length / 1000)}k chars, ${ctx.dialogs?.length || 0} dialogue line(s)` });
    const { listVideoScenes } = await import('../mongo/videoScenes.js');
    const allScenes = await listVideoScenes({ projectId, beatId: beat._id });
    const idx = allScenes.findIndex((s) => String(s._id) === String(scene._id));
    // The in-memory scene shape the passes expect: beat-wide line numbers.
    const lineByDialogId = new Map(ctx.dialogs.map((d, i) => [String(d._id), i + 1]));
    const memScene = {
      ...scene,
      order: idx >= 0 ? idx + 1 : scene.order,
      dialog_lines: (scene.dialog_ids || []).map((id) => lineByDialogId.get(String(id))).filter(Boolean),
    };
    let previousCut = null;
    if (idx > 0) {
      const prevCuts = await listVideoPrompts({ projectId, beatId: beat._id, sceneId: allScenes[idx - 1]._id });
      const last = prevCuts[prevCuts.length - 1];
      if (last) {
        previousCut = { ...last, dialog_lines: (last.dialog_ids || []).map((id) => lineByDialogId.get(String(id))).filter(Boolean) };
      }
    }
    job.scenes_total = 1;
    planSteps(job, { sceneCount: allScenes.length || 1, firstScene: memScene.order, renderStartFrames });
    // Only this scene's passes run; the other scenes' pending steps would mislead.
    job.steps = job.steps.filter((st) => !/:\d+\//.test(st.key) || st.key.includes(`:${memScene.order}/`));
    const cuts = await planSceneCuts({ ctx, scene: memScene, sceneIndex: memScene.order - 1, sceneCount: allScenes.length || 1, previousCut, catalogGroups, contextText: ctx.text, job, usage });
    job.lint_count = cuts.reduce((m, c) => m + (c.lint?.length || 0), 0);
    if (!cuts.length) {
      warn(job, 'The model planned no cuts; the scene\'s existing cuts were kept.');
      finish(job, 'done');
      return;
    }
    setPhase(job, 'writing');
    const existing = await listVideoPrompts({ projectId, beatId: beat._id, sceneId: scene._id });
    for (const row of existing) {
      await deleteVideoPromptViaGateway({ projectId, promptId: String(row._id) });
    }
    const createdCuts = [];
    let order = 1;
    for (const cut of cuts) {
      try {
        const row = await persistCut({ projectId, beatId: beat._id, sceneId: scene._id, cut, order, job });
        createdCuts.push(row);
        order += 1;
      } catch (e) {
        warn(job, `Cut ${cut.cut_index} could not be saved: ${e.message}`);
      }
    }
    endStep(job, 'writing', { detail: `${createdCuts.length} cut(s) saved` });
    // The new rows were appended with scene-local orders; renumber the whole
    // beat (scene order, then cut_index) so the SPA lists them in place.
    await recomputeCutOrderForBeat(beat._id);
    await updateVideoSceneViaGateway({ projectId, sceneId: String(scene._id), patch: { load: memScene.load || null } });
    job.scenes_done = 1;
    if (renderStartFrames) {
      await maybeRenderStartFrames({ projectId, beat, cuts: createdCuts, imageModel, job });
    }
    finish(job, job.start_frames?.failed ? 'partial' : 'done');
  } finally {
    await recordUsage(usage);
  }
}

export function _clearCutPlanJobsForTests() {
  jobs.clear();
}
