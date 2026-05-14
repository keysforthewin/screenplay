// Storyboard auto-generation pipeline.
//
// Triggered from POST /api/storyboards/generate. Returns immediately with a
// job id; the work runs in the background and broadcasts progress to the
// "storyboards:<beatId>" room as each storyboard is persisted.
//
// Pipeline:
//   1. Anthropic call: break the beat body / desc / characters into a
//      prioritized list of N storyboard segments. Each segment specifies a
//      visual prompt, the characters in the shot, and a brief end-frame
//      variation cue.
//   2. For each segment, sequentially (so each frame's start can use the
//      previous frame's end as a continuity reference):
//      - Collect input reference images: each character's character_sheet_image
//        (or main image), plus the beat's main image (set/scene context), plus
//        the previous shot's end frame on frames 2+.
//      - Call Nano Banana once for the start frame, once for the end frame.
//      - Persist a storyboard row via the gateway, then broadcast a ping.
//
// Errors in a single segment are swallowed (logged) so other segments still
// land — the model can re-run "generate" and just fill in missing frames.

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
import { dispatchStoryboardImage } from './storyboardImageDispatch.js';
import {
  createStoryboardViaGateway,
  deleteAllStoryboardsForBeatViaGateway,
  setStoryboardImageViaGateway,
  setStoryboardFramePromptViaGateway,
  setStoryboardFrameReferenceImagesViaGateway,
} from './gateway.js';
import { collectStoryboardReferenceIds } from './storyboardReferenceAggregator.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';

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

// Stage A: outline-only tool. Produces the shot list (description, shot_type,
// duration, transition_in, characters_in_scene) but NOT the start/end visual
// prompts — those move to Stage B where each frame gets its own focused call.
const OUTLINE_TOOL = {
  name: 'plan_storyboard_outline',
  description:
    'Break the beat into an ordered shot list. For each frame, pick a description, ' +
    'shot_type, on-screen duration, and (when relevant) the characters visible in ' +
    'frame and how the cut picks up from the previous shot. Do NOT write the ' +
    'detailed start/end visual prompts — those are produced in a separate pass.',
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
const REFINE_TOOL = {
  name: 'refine_storyboard_frame',
  description:
    'Produce the START-frame and END-frame visual prompts for ONE storyboard frame, ' +
    'given the full outline and the previously refined frames. ' +
    'The END frame is the same shot a beat or two later (motion progression), NOT a different shot.',
  input_schema: {
    type: 'object',
    properties: {
      start_prompt: {
        type: 'string',
        description:
          'Concrete visual prompt for the START frame: subject, action, framing, lighting, mood. ~2 sentences.',
      },
      end_prompt: {
        type: 'string',
        description:
          'Concrete visual prompt for the END frame (a small variation showing motion progression from the start). ~2 sentences.',
      },
    },
    required: ['start_prompt', 'end_prompt'],
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

// Stage B system prompt — covers start_prompt vs end_prompt rules in detail
// so the per-frame refinement call produces tight, image-generator-ready text.
const REFINE_SYSTEM_PROMPT = [
  'You are a Hollywood storyboard artist writing the visual prompts for ONE frame of an already-planned shot list. Return your prompts via the refine_storyboard_frame tool.',
  '',
  'Your prompts will be passed to an image generator together with reference photographs of each named character and the set. So:',
  "- Describe action, framing, composition, and camera lighting only. Do NOT re-describe a character's face, body, or wardrobe — the reference photo carries that.",
  '- Do NOT re-describe the location, lighting palette, or mood — the set reference carries that. You may direct camera lighting (e.g. "lit from below", "harsh key light").',
  '',
  'start_prompt vs end_prompt for the same frame:',
  '- start_prompt = the moment the action begins.',
  '- end_prompt = the SAME shot moments later, showing motion progression. Same camera, same composition, slightly different pose / position. NOT a different angle, NOT a different beat.',
  '',
  'Example of a good start_prompt / end_prompt pair:',
  '  start_prompt: "Sarah stands in the doorway, hand on the knob, glancing back over her shoulder. Wide shot, hallway behind her, dim warm practical light from a sconce."',
  '  end_prompt:   "Sarah\'s hand has turned the knob a quarter-turn; her gaze has shifted forward into the room. Same wide shot, same hallway, same sconce."',
  'Example of a BAD end_prompt (do NOT do this):',
  '  end_prompt: "Sarah enters the room and looks around at the furniture."  ← too much progression; that is a different shot.',
  'Rule of thumb: the end_prompt describes the same scene a beat or two of action later — a hand has moved, a head has turned, a step has been taken. If you have to mention a new location, a new camera angle, or a new framing, you have written a different shot, not an end frame.',
  '',
  '# Continuity with neighbors',
  '- The user message shows the full outline and the previously refined frames so you can compose your start_prompt to pick up the prior shot\'s end_prompt (shared subject, motion vector, match cut).',
  '- Honor the outline frame\'s description, shot_type, transition_in, and characters_in_scene. Do not contradict them.',
  '',
  '# Constraints',
  '- ~2 sentences per prompt. Concrete and visual. No wardrobe / face / location re-description.',
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
// Refiner override returns { start_prompt, end_prompt } or null. Both default
// to the production Anthropic-backed implementations.
let outlinePlannerOverride = null;
export function _setOutlinePlannerForTests(fn) {
  outlinePlannerOverride = fn;
}

let frameRefinerOverride = null;
export function _setFrameRefinerForTests(fn) {
  frameRefinerOverride = fn;
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
  const planned = await planFrames({
    beat,
    characters: characterDocs,
    targetCount: targetCount || DEFAULT_TARGET_COUNT,
    direction: direction || '',
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

// Block of beat context shared between the outline call and every refinement
// call. Exported via the preview endpoint so the SPA can show users the same
// text the LLM will see.
export function buildBeatContextBlock({ beat, characters, direction }) {
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
  const cleanDirection = sanitizeDirection(direction);
  if (cleanDirection) {
    lines.push('');
    lines.push("Director's direction:");
    lines.push(cleanDirection);
  }
  return lines.join('\n');
}

export function buildOutlineUserText({ beat, characters, targetCount, direction }) {
  const ctx = buildBeatContextBlock({ beat, characters, direction });
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
    'Pick a shot_type and duration_seconds for every frame. Use the plan_storyboard_outline tool. ' +
    'Do NOT write the start_prompt / end_prompt visual prompts — those are produced in a separate per-frame pass. ' +
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
      return parts.join('\n');
    })
    .join('\n');
}

function formatPreviousRefined(previousRefined) {
  if (!previousRefined?.length) return '(this is the first frame)';
  return previousRefined
    .map((f, i) => {
      return [
        `${i + 1}. start_prompt: ${f.start_prompt || '(none)'}`,
        `   end_prompt:   ${f.end_prompt || '(none)'}`,
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
}) {
  const frame = outline[index];
  const ctx = buildBeatContextBlock({ beat, characters, direction });
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
    'Produce the start_prompt and end_prompt for this frame via the refine_storyboard_frame tool. ' +
      'Compose the start_prompt to pick up the prior frame\'s end_prompt where appropriate; ' +
      'the end_prompt is the same shot a beat or two later (motion progression, not a new shot).',
  ].join('\n');
}

async function planOutline({ beat, characters, targetCount, direction }) {
  if (outlinePlannerOverride) {
    return outlinePlannerOverride({ beat, characters, targetCount, direction });
  }
  const userText = buildOutlineUserText({ beat, characters, targetCount, direction });
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

async function refineFramePrompts({
  beat,
  characters,
  direction,
  outline,
  index,
  previousRefined,
}) {
  if (frameRefinerOverride) {
    return frameRefinerOverride({
      beat,
      characters,
      direction,
      outline,
      index,
      previousRefined,
    });
  }
  const userText = buildRefinementUserText({
    beat,
    characters,
    direction,
    outline,
    index,
    previousRefined,
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
  const sp = typeof toolUse.input.start_prompt === 'string'
    ? toolUse.input.start_prompt.trim()
    : '';
  const ep = typeof toolUse.input.end_prompt === 'string'
    ? toolUse.input.end_prompt.trim()
    : '';
  if (!sp || !ep) return null;
  return { start_prompt: sp, end_prompt: ep };
}

function synthesizeFallbackStartPrompt(frame) {
  const base = stripMarkdown(frame.description || '').trim();
  return base ? `Start of the moment: ${base}` : 'Start frame of the shot.';
}

function synthesizeFallbackEndPrompt(frame) {
  const base = stripMarkdown(frame.description || '').trim();
  return base
    ? `Same shot moments later — the action continues: ${base}`
    : 'Same shot moments later, motion progression.';
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
  onRefineFailure = null,
  onProgress = null,
  refineModel = null,
}) {
  const outlineRaw = await planOutline({ beat, characters, targetCount, direction });
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
        start_prompt: synthesizeFallbackStartPrompt(outline[i]),
        end_prompt: synthesizeFallbackEndPrompt(outline[i]),
      };
    }
    refined.push({
      ...outline[i],
      start_prompt: prompts.start_prompt,
      end_prompt: prompts.end_prompt,
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
  if (!f || typeof f.start_prompt !== 'string' || typeof f.end_prompt !== 'string') {
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
  const sb = await createStoryboardViaGateway({
    beatId: beat._id,
    textPrompt,
    summary,
    order,
    seedFragments: { text_prompt: textPrompt, summary },
    durationSeconds: frame.duration_seconds ?? null,
    shotType: frame.shot_type ?? null,
    transitionIn: frame.transition_in ?? null,
    charactersInScene: frame.characters_in_scene ?? [],
  });

  // Pre-populate BOTH per-frame reference lists with every image we'd
  // reasonably want as a visual reference for this shot: the beat's set
  // image(s) plus each in-scene character's sheets and portraits. Failures
  // are swallowed so the row still lands — users can re-trigger via the
  // frame's Auto-suggest button.
  try {
    const { ids } = await collectStoryboardReferenceIds({
      beat,
      charactersInScene: frame.characters_in_scene ?? [],
      existingIds: [],
    });
    if (ids.length) {
      for (const role of ['start_frame', 'end_frame']) {
        await setStoryboardFrameReferenceImagesViaGateway({
          storyboardId: sb._id,
          role,
          imageIds: ids,
          mode: 'append',
        });
      }
    }
  } catch (e) {
    logger.warn(`storyboard gen: auto-populate refs failed: ${e.message}`);
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
  if (frame.description) {
    if (lines.length) lines.push('');
    lines.push(stripMarkdown(frame.description));
  }
  if (frame.transition_in) {
    lines.push('');
    lines.push(`_↳ ${stripMarkdown(frame.transition_in)}_`);
  }
  if (frame.start_prompt) {
    lines.push('');
    lines.push(`**Start frame:** ${stripMarkdown(frame.start_prompt)}`);
  }
  if (frame.end_prompt) {
    lines.push('');
    lines.push(`**End frame:** ${stripMarkdown(frame.end_prompt)}`);
  }
  if (frame.characters_in_scene?.length) {
    lines.push('');
    lines.push(
      `_Characters: ${frame.characters_in_scene.map((n) => stripMarkdown(n)).join(', ')}_`,
    );
  }
  return lines.join('\n');
}

// Build the default suggested prompt for a single frame slot — used by the
// SPA's preview-prompt endpoint when the stored frame prompt is empty so the
// user gets a sensible starting draft they can keep or edit.
function buildSuggestedFramePrompt({ sb, role }) {
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
  lines.push(
    role === 'start_frame'
      ? 'Render the beginning moment of this shot as a cinematic still.'
      : 'Render the end moment of this shot as a cinematic still — show motion progression beyond the start.',
  );
  return lines.join('\n');
}

async function persistFrameImage({ storyboardId, role, result, beatId, orderHint }) {
  const file = await uploadGeneratedImage({
    buffer: result.buffer,
    contentType: result.contentType,
    prompt: null,
    generatedBy: result.model || 'unknown',
    ownerType: 'beat',
    ownerId: beatId,
    filename: `storyboard-${storyboardId}-${orderHint}.png`,
  });
  await setStoryboardImageViaGateway({
    storyboardId,
    role,
    imageId: file._id,
  });
  return file;
}

const FRAME_ROLES = new Set(['start_frame', 'end_frame']);
const MAX_FRAME_REFERENCE_IMAGES = 12;

export class FrameRoleError extends Error {
  constructor(role) {
    super(`unsupported frame role: ${role}`);
    this.code = 'BAD_FRAME_ROLE';
    this.status = 400;
  }
}

export class EditModeError extends Error {
  constructor(message) {
    super(message);
    this.code = 'BAD_EDIT_MODE';
    this.status = 400;
  }
}

function frameImageField(role) {
  return role === 'start_frame' ? 'start_frame_id' : 'end_frame_id';
}

function frameReferenceField(role) {
  return role === 'start_frame'
    ? 'start_frame_reference_ids'
    : 'end_frame_reference_ids';
}

function framePromptDocField(role) {
  return role === 'start_frame' ? 'start_frame_prompt' : 'end_frame_prompt';
}

async function loadFrameReferenceImages(sb, role) {
  const ids = sb[frameReferenceField(role)] || [];
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
// - 'edit': passes only the existing frame image plus the user's `editPrompt`
//   to the chosen image model. Skips reference loading entirely. Use for small
//   inline tweaks ("remove the lamp on the left") on an almost-good image.
//
// Public entry point: validates inputs, resolves sb + beat, refuses if the
// beat lock is held, and delegates to the internal worker. Direct callers
// (tests) get the fail-fast BeatBusyError semantics. The SPA-facing path goes
// through `startFrameGenerationJob` instead, which holds the lock for the
// duration of the run.
export async function regenerateStoryboardFrame({
  storyboardId,
  role,
  imageModel = 'gemini',
  mode = 'generate',
  editPrompt = null,
  prompt = null,
}) {
  if (!FRAME_ROLES.has(role)) throw new FrameRoleError(role);
  if (!['generate', 'edit'].includes(mode)) {
    throw new EditModeError(`Unknown regen mode "${mode}".`);
  }
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beat = await getBeat(sb.beat_id);
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  return regenerateStoryboardFrameInternal({
    sb,
    beat,
    role,
    imageModel,
    mode,
    editPrompt,
    prompt,
  });
}

// Preview the suggested default prompt for a single frame slot. Called by the
// SPA's generate modal on open so the user gets a sensible starting draft
// when the stored prompt is empty.
export async function previewFrameGenerationPrompt({ storyboardId, role }) {
  if (!FRAME_ROLES.has(role)) throw new FrameRoleError(role);
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beat = await getBeat(sb.beat_id);
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  const storedField = framePromptDocField(role);
  const stored = sb[storedField] || '';
  const suggested = buildSuggestedFramePrompt({ sb, role });
  const refIds = sb[frameReferenceField(role)] || [];
  return {
    prompt: stored.trim() ? stored : suggested,
    suggested_prompt: suggested,
    has_stored_prompt: !!stored.trim(),
    reference_count: refIds.length,
    has_existing_frame: !!sb[frameImageField(role)],
  };
}

async function regenerateStoryboardFrameInternal({
  sb,
  beat,
  role,
  imageModel = 'gemini',
  mode = 'generate',
  editPrompt = null,
  prompt = null,
}) {
  let renderPrompt;
  let inputImages;
  let dispatchMode;
  if (mode === 'edit') {
    if (typeof editPrompt !== 'string' || !editPrompt.trim()) {
      throw new EditModeError('Edit mode requires a non-empty editPrompt.');
    }
    const existingId = sb[frameImageField(role)];
    if (!existingId) {
      throw new EditModeError(
        `No existing ${role.replace('_', ' ')} to edit. Use generate mode instead.`,
      );
    }
    const existing = await loadImageInput(existingId);
    if (!existing) {
      throw new EditModeError(
        `Could not read existing ${role.replace('_', ' ')} bytes for editing.`,
      );
    }
    renderPrompt = editPrompt.trim();
    inputImages = [{ buffer: existing.buffer, contentType: existing.contentType }];
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
        role,
        text: renderPrompt,
      });
    } catch (e) {
      logger.warn(
        `storyboard regen: persist ${role} prompt failed: ${e.message}`,
      );
    }
    inputImages = await loadFrameReferenceImages(sb, role);
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
    role,
    result,
    beatId: beat._id,
    orderHint: `${role === 'start_frame' ? 'start' : 'end'}-${sb.order}`,
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
  role,
  imageModel = 'gemini',
  mode = 'generate',
  editPrompt = null,
  prompt = null,
}) {
  if (!FRAME_ROLES.has(role)) throw new FrameRoleError(role);
  if (!['generate', 'edit'].includes(mode)) {
    throw new EditModeError(`Unknown regen mode "${mode}".`);
  }
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beat = await getBeat(sb.beat_id);
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  if (mode === 'edit' && !sb[frameImageField(role)]) {
    throw new EditModeError(
      `No existing ${role.replace('_', ' ')} to edit. Use generate mode instead.`,
    );
  }

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    storyboard_id: sb._id.toString(),
    beat_id: beat._id.toString(),
    role,
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
      role,
      imageModel,
      mode,
      editPrompt,
      prompt,
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
  role,
  imageModel,
  mode,
  editPrompt,
  prompt,
}) {
  job.status = 'running';
  const { image_id } = await regenerateStoryboardFrameInternal({
    sb,
    beat,
    role,
    imageModel,
    mode,
    editPrompt,
    prompt,
  });
  job.image_id = image_id;
  job.status = 'done';
  job.finished_at = new Date();
}
