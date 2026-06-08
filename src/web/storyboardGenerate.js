// Storyboard auto-generation pipeline.
//
// Triggered from POST /api/storyboards/generate. Returns immediately with a
// job id; the work runs in the background and broadcasts progress to the
// "storyboards:<beatId>" room as each storyboard is persisted.
//
// Pipeline (two-pass, holistic):
//   Pass 1 — planScene (Anthropic): in one call, produce a compact SCENE BIBLE
//      (the unified visual look: location, time of day, lighting, palette, mood,
//      blocking, continuity anchors, camera language) plus an ordered shot
//      SKELETON covering the whole beat. Each skeleton entry has a one-sentence
//      description, a shot_type, duration, transition, and the characters in
//      frame. No detailed generation prompts yet. The scene bible is persisted
//      on the beat as soon as the plan succeeds (survives per-shot regen + the
//      SPA editor), even if individual row creation fails below.
//   Pass 2 — expandShots (Anthropic): in one call, expand the whole skeleton —
//      every shot is written together so the scene stays coherent. Two outputs
//      per shot (NO end frame):
//      - start_frame_prompt  — still-image prompt for the opening composition.
//                              Seeded as the row's single start-frame prompt.
//      - video_prompt        — the clip-gen prompt (motion / action / camera
//                              move, assuming the start frame image exists).
//                              Stored as text_prompt and sent to the video model.
//   Persist one storyboard row per shot via the gateway. Only the start prompt
//   is seeded. No images are generated here — the user triggers per-frame stills
//   + video gen from the SPA.
//
// Errors in a single row are swallowed (logged) so other rows still land —
// the user can re-run "generate" and just fill in missing rows.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { getBeat, setBeatSceneBible } from '../mongo/plots.js';
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
  setStoryboardCritiqueViaGateway,
} from './gateway.js';
import { critiquePanel as defaultCritiquePanel } from './storyboardCritique.js';
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

// Pass-1 scene-planner override. Returns { sceneBible, outline }.
let scenePlannerOverride = null;
export function _setScenePlannerForTests(fn) {
  scenePlannerOverride = fn;
}

// Pass-4 critique-panel seam. Tests override to avoid real Anthropic calls.
let critiquePanelOverride = null;
export function _setCritiquePanelForTests(fn) {
  critiquePanelOverride = fn;
}
function runCritiquePanel(args) {
  return (critiquePanelOverride || defaultCritiquePanel)(args);
}

function toCritiqueNeighbor(sb) {
  return { order: sb.order, summary: sb.summary, startFramePrompt: sb.frames?.[0]?.prompt || '' };
}

// Pass 4: auto prompt-tier critique. Runs the four-lens panel over every shot of
// the beat (bible + director's notes + neighbors) and persists prompt_critique.
// Per-shot failures are swallowed so a bad critique never fails the job.
async function critiqueShotsForBeat({ beat, sceneBible, directorNotes, onProgress = null }) {
  const shots = await listStoryboards({ beatId: beat._id });
  for (let i = 0; i < shots.length; i++) {
    const sb = shots[i];
    onProgress?.({ phase: 'critiquing', step: 'critique_shot_start', frame: i + 1, total: shots.length, message: `Critiquing shot ${i + 1}/${shots.length}…` });
    try {
      const shot = {
        order: sb.order,
        summary: sb.summary,
        text_prompt: sb.text_prompt,
        startFramePrompt: sb.frames?.[0]?.prompt || '',
        shot_type: sb.shot_type,
      };
      const prevShot = i > 0 ? toCritiqueNeighbor(shots[i - 1]) : null;
      const nextShot = i < shots.length - 1 ? toCritiqueNeighbor(shots[i + 1]) : null;
      const critique = await runCritiquePanel({ target: 'prompt', sceneBible, directorNotes, shot, prevShot, nextShot });
      await setStoryboardCritiqueViaGateway({ storyboardId: sb._id, beatId: beat._id, target: 'prompt', critique });
    } catch (e) {
      logger.warn(`storyboard critique: shot ${i + 1} failed: ${e?.message || e}`);
    }
  }
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

// On-demand single-shot critique. Separate in-memory job table from the batch
// `jobs` Map — different shape and polling endpoint. target 'prompt' judges the
// written prompts; 'image' loads frames[0].image_id and judges the rendered
// start-frame image (errors if none rendered).
const critiqueJobs = new Map();
export function getCritiqueJob(jobId) {
  return critiqueJobs.get(jobId) || null;
}

export async function startCritiqueJob({ storyboardId, target = 'prompt' }) {
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beat = await getBeat(sb.beat_id.toString());
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    storyboard_id: String(sb._id),
    beat_id: String(beat._id),
    target,
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    overall: null,
  };
  critiqueJobs.set(jobId, job);
  (async () => {
    job.status = 'running';
    try {
      const directorNotes = await loadDirectorNotesForPlanner();
      const shots = await listStoryboards({ beatId: beat._id });
      const idx = shots.findIndex((s) => String(s._id) === String(sb._id));
      const prevShot = idx > 0 ? toCritiqueNeighbor(shots[idx - 1]) : null;
      const nextShot = idx >= 0 && idx < shots.length - 1 ? toCritiqueNeighbor(shots[idx + 1]) : null;
      let imageInput = null;
      if (target === 'image') {
        const imgId = sb.frames?.[0]?.image_id;
        if (!imgId) throw new Error('no rendered image to critique on this shot');
        imageInput = await loadImageInput(imgId);
        if (!imageInput) throw new Error('rendered image could not be read or is an unsupported type');
      }
      const shot = {
        order: sb.order,
        summary: sb.summary,
        text_prompt: sb.text_prompt,
        startFramePrompt: sb.frames?.[0]?.prompt || '',
        shot_type: sb.shot_type,
      };
      const critique = await runCritiquePanel({ target, sceneBible: beat.scene_bible, directorNotes, shot, prevShot, nextShot, imageInput });
      await setStoryboardCritiqueViaGateway({ storyboardId: sb._id, beatId: beat._id, target, critique });
      job.overall = critique.overall;
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      logger.warn(`storyboard critique job ${jobId} failed: ${e.message}`);
    } finally {
      job.finished_at = new Date();
    }
  })();
  return jobId;
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
  // Both passes run on STORYBOARD_MODEL; surfaced on the job so the SPA
  // progress display can name the model doing the work.
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
    model: STORYBOARD_MODEL,
    image_model: imageModel,
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
    step: 'plan_start',
    message: `Planning scene with ${job.model}…`,
  });
  const characterDocs = await findCharactersInBeat(beat);
  // Director's notes are project-wide guidance; fetch once and pass to both
  // passes so every shot sees the same notes without re-querying.
  const directorNotes = await loadDirectorNotesForPlanner();
  const { frames: planned, sceneBible } = await planFramesV2({
    beat,
    characters: characterDocs,
    targetCount: targetCount || DEFAULT_TARGET_COUNT,
    direction: direction || '',
    directorNotes,
    onProgress: (fields) => recordProgress(job, fields),
  });
  // Persist the scene bible on the beat as soon as the plan succeeds, so it
  // survives for per-shot regen and the SPA editor (later plans), even if
  // individual row creation fails below.
  if (sceneBible && !isEmptySceneBible(sceneBible)) {
    try {
      await setBeatSceneBible(beat._id, sceneBible);
    } catch (e) {
      logger.warn(`storyboard gen: persist scene bible failed: ${e.message}`);
    }
  }
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
  // Pass 4: auto prompt-critique. Best-effort — never flips the job to error.
  if (job.completed > 0) {
    job.status = 'critiquing';
    recordProgress(job, { phase: 'critiquing', step: 'critique_start', total: planned.length, message: 'Critiquing shots…' });
    try {
      await critiqueShotsForBeat({
        beat,
        sceneBible,
        directorNotes,
        onProgress: (fields) => recordProgress(job, fields),
      });
    } catch (e) {
      logger.warn(`storyboard gen: critique pass failed: ${e.message}`);
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

// Format the character list the same way for every LLM call so all passes
// (planScene + expandShots) see consistent context.
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

// Block of beat context shared between the scene-plan call (Pass 1) and the
// shot-expand call (Pass 2). Exported via the preview endpoint so the SPA can show users the same
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

// Two-output validator. Drops a frame only if it lacks start_frame_prompt or
// video_prompt; otherwise clamps shot_type / duration / characters / transition.
function cleanPlannedFrameV2(f) {
  if (!f || typeof f.start_frame_prompt !== 'string' || typeof f.video_prompt !== 'string') {
    return [];
  }
  const shotType = SHOT_TYPES.includes(f.shot_type) ? f.shot_type : null;
  if (!shotType && f.shot_type != null) {
    logger.warn(`storyboard plan (v2): dropping invalid shot_type "${f.shot_type}"`);
  }
  const clampedDur = clampDuration(f.duration_seconds, shotType);
  if (
    f.duration_seconds != null &&
    Number.isFinite(Number(f.duration_seconds)) &&
    Number(f.duration_seconds) !== clampedDur
  ) {
    logger.warn(
      `storyboard plan (v2): duration ${f.duration_seconds}s clamped to ${clampedDur}s for shot_type=${shotType}`,
    );
  }
  const rawChars = Array.isArray(f.characters_in_scene)
    ? f.characters_in_scene.map((n) => stripMarkdown(String(n ?? '')).trim()).filter(Boolean)
    : [];
  if (rawChars.length > MAX_CHARS_PER_SHOT) {
    logger.warn(
      `storyboard plan (v2): trimming characters_in_scene from ${rawChars.length} to ${MAX_CHARS_PER_SHOT}`,
    );
  }
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

  onProgress?.({ phase: 'expanding', step: 'expand_start', total: outline.length, message: `Expanding ${outline.length} shots…` });
  const expanded = await expandShots({ beat, characters, sceneBible, outline, direction, directorNotes });
  onProgress?.({ phase: 'expanding', step: 'expand_done', total: outline.length, message: 'Shot expansion complete.' });

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
  // the LLM-generated one-sentence summary of the shot (per the plan_scene
  // tool's schema), so we feed it straight into the summary field.
  const textPrompt = buildTextPrompt(frame);
  const summary = stripMarkdown(frame.description || '').replace(/\s+/g, ' ').trim();
  const startFramePrompt = stripMarkdown(frame.start_frame_prompt || '').trim();
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

  // The planner produces an opening still prompt; seed it as the first frame
  // of the pool. A frame with no prompt is skipped so a sparse planner output
  // doesn't create an empty frame.
  for (const prompt of [startFramePrompt]) {
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
