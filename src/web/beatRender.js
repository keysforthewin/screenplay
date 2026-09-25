// Beat render job: prompts → (auto keyframe) → one clip per shot → beat MP4.
//
// The storyboard planner leaves each shot with ONE self-contained prompt, a
// scored reference list, and the dialogue lines it covers. This module turns
// a whole beat into video in one action:
//
//   plan   buildBeatRenderPlan picks a MODE per shot —
//            lipsync    every covered line has a recording → avatar model,
//                       recordings joined into the shot's scene audio
//            direct     a reference-to-video model is configured → prompt +
//                       scored references, no still needed
//            start_only otherwise → the shot's still (rendered on demand)
//                       drives an image-to-video model
//          and flags AUTO-KEYFRAME shots: the chosen model wants a start
//          frame the shot doesn't have yet, so the still is rendered first.
//   run    one withBeatLock for the whole beat; a small pool renders shots
//          through runShotVideoInline (per-shot jobs keep their own SSE
//          streams; their snapshots are merged into this job's `shots[]`).
//          Failures mark the shot and continue.
//   join   when every shot has a clip, beatAssemble concatenates them and
//          points beat.video_file_id at the result; otherwise the job ends
//          'partial' and a re-run with skipRendered renders only what is
//          missing, then assembles.
//
// Real voices only: the audio a lipsync shot receives is the concatenation
// of the covered lines' recordings. Dialogue words never enter a prompt.

import { config } from '../config.js';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { listStoryboards, getStoryboard } from '../mongo/storyboards.js';
import { listDialogs, ensureDialogAudioDurations } from '../mongo/dialogs.js';
import { getModelDefaults } from '../mongo/projectSettings.js';
import { readAttachmentBuffer, uploadAttachmentBuffer } from '../mongo/attachments.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { setStoryboardAudioViaGateway } from './gateway.js';
import { concatAudioToMp3 } from './audioTranscode.js';
import { auditShotCoverage } from './shotCoverageAudit.js';
import { estimateShotDuration } from './shotTiming.js';
import {
  INPUT_NEEDS,
  resolveVideoModelByAnyId,
  resolveFrameAssignment,
  validateAssignment,
  getVideoModelCatalogMeta,
  getMaxAudioSeconds,
} from '../fal/videoModels.js';
import { isConfigured as falIsConfigured } from '../fal/client.js';
import {
  runShotVideoInline,
  subscribeToJob,
  unsubscribeFromJob,
  computeCost,
  pickDurationSeconds,
  FalNotConfiguredError,
} from './falVideoGenerate.js';

export const MODES = Object.freeze({ LIPSYNC: 'lipsync', DIRECT: 'direct', START_ONLY: 'start_only' });
export const FALLBACK_LIPSYNC_MODEL_ID = 'kling-avatar-v2-pro';
export const CONCAT_GAP_SECONDS = 0.25;
export const CONCAT_TAIL_SECONDS = 0.3;

const TERMINAL = new Set(['done', 'partial', 'error']);
const TERMINAL_RETENTION_MS = 10 * 60 * 1000;
const MAX_EVENTS = 300;

const jobs = new Map();
const listeners = new Map();

export class BeatRenderBusyError extends Error {
  constructor(beatId) {
    super(`Storyboard work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

export class BeatRenderEmptyError extends Error {
  constructor(message = 'Nothing to render: plan shots first.') {
    super(message);
    this.code = 'BEAT_RENDER_EMPTY';
  }
}

// ── job registry / pub-sub ────────────────────────────────────────────────

function makeJobId() {
  return `beat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getBeatRenderJob(jobId) {
  return jobs.get(jobId) || null;
}

export function subscribeToBeatJob(jobId, cb) {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId).add(cb);
}

export function unsubscribeFromBeatJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

function publish(job) {
  const set = listeners.get(job.job_id);
  if (!set || !set.size) return;
  const snap = serializeBeatJob(job);
  for (const cb of set) {
    try {
      cb(snap);
    } catch (e) {
      logger.warn(`beat render: listener threw: ${e.message}`);
    }
  }
}

export function serializeBeatJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    beat_id: job.beat_id,
    status: job.status,
    phase: job.phase,
    planned: job.planned,
    completed: job.completed,
    failed: job.failed,
    skipped: job.skipped,
    progress: job.progress,
    events: job.events.slice(-MAX_EVENTS),
    coverage: job.coverage,
    shots: job.shots.map((s) => ({ ...s })),
    estimated_cost_usd: job.estimated_cost_usd,
    video_file_id: job.video_file_id,
    video_duration_seconds: job.video_duration_seconds,
    assembly_skipped_reason: job.assembly_skipped_reason,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
  };
}

function recordProgress(job, { phase, step, message }) {
  const ts = new Date();
  const entry = { ts, phase, step, message };
  job.phase = phase;
  job.progress = { ...entry, started_at: ts };
  job.events.push(entry);
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  logger.info(`beat render ${job.job_id} [${phase}/${step}] ${message}`);
  publish(job);
}

function scheduleEviction(jobId) {
  setTimeout(() => {
    jobs.delete(jobId);
    listeners.delete(jobId);
  }, TERMINAL_RETENTION_MS).unref?.();
}

export function _resetBeatRenderForTests() {
  jobs.clear();
  listeners.clear();
}

// ── planning ─────────────────────────────────────────────────────────────

const sid = (x) => (x == null ? null : x.toString?.() || String(x));

function coveredDialogsFor(sb, dialogs) {
  const wanted = new Set((sb.dialog_ids || []).map(sid));
  if (!wanted.size) return [];
  return (dialogs || []).filter((d) => wanted.has(sid(d._id)));
}

function accepts(model, key) {
  const need = model?.inputs?.[key];
  return need === INPUT_NEEDS.REQUIRED || need === INPUT_NEEDS.OPTIONAL;
}

function requires(model, key) {
  return model?.inputs?.[key] === INPUT_NEEDS.REQUIRED;
}

function pickModelId(overrides, defaults, key, fallback = null) {
  const o = overrides?.[key];
  if (typeof o === 'string' && o.trim()) return o.trim();
  const d = defaults?.[key];
  if (typeof d === 'string' && d.trim()) return d.trim();
  return fallback;
}

// Which model each mode would use, resolved once per plan.
async function resolvePlanModels({ overrides, modelDefaults }) {
  const ids = {
    lipsync: pickModelId(overrides, modelDefaults, 'lipsync', FALLBACK_LIPSYNC_MODEL_ID),
    direct: pickModelId(overrides, modelDefaults, 'video_direct', null),
    start_only: pickModelId(overrides, modelDefaults, 'video_start_only', config.fal.defaultModelId),
  };
  const out = {};
  for (const [mode, id] of Object.entries(ids)) {
    out[mode] = id ? { id, model: await resolveVideoModelByAnyId(id) } : { id: null, model: null };
  }
  return out;
}

function speechSecondsFor(covered) {
  let total = 0;
  for (const d of covered) total += Number(d.audio_duration_seconds) || 0;
  if (covered.length > 1) total += CONCAT_GAP_SECONDS * (covered.length - 1) + CONCAT_TAIL_SECONDS;
  return total;
}

// Pure-ish (reads nothing beyond its arguments once models are resolved).
// Returns the per-shot plan the preview shows and the runner executes.
export async function buildBeatRenderPlan({
  projectId,
  beat,
  shots,
  dialogs,
  modelDefaults,
  overrides = {},
  skipRendered = true,
}) {
  const models = await resolvePlanModels({ overrides, modelDefaults });
  const ordered = [...(shots || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const planned = [];

  for (const sb of ordered) {
    const covered = coveredDialogsFor(sb, dialogs);
    const allRecorded = covered.length > 0 && covered.every((d) => d.audio_file_id);
    const warnings = [];
    const entry = {
      storyboard_id: sid(sb._id),
      order: sb.order ?? 0,
      shot_type: sb.shot_type || null,
      summary: (sb.summary || '').trim() || null,
      has_prompt: Boolean((sb.text_prompt || '').trim()),
      has_still: Boolean(sb.frames?.[0]?.image_id),
      has_clip: Boolean(sb.video_file_id),
      covered_dialog_ids: covered.map((d) => sid(d._id)),
      covered_lines: covered.length,
      recorded_lines: covered.filter((d) => d.audio_file_id).length,
      speech_seconds: allRecorded ? speechSecondsFor(covered) : null,
      mode: null,
      model_id: null,
      model_label: null,
      fal_model: null,
      auto_keyframe: false,
      skipped: false,
      skip_reason: null,
      missing: [],
      warnings,
      duration_seconds: null,
      status: 'pending',
      step: null,
      job_id: null,
      error: null,
      video_file_id: sb.video_file_id ? sid(sb.video_file_id) : null,
      estimated_cost_usd: null,
    };

    if (skipRendered && sb.video_file_id) {
      entry.skipped = true;
      entry.skip_reason = 'already rendered';
      entry.status = 'skipped';
      planned.push(entry);
      continue;
    }
    if (!entry.has_prompt) {
      entry.skipped = true;
      entry.skip_reason = 'no prompt';
      entry.status = 'skipped';
      warnings.push('Shot has no prompt — write one (or re-plan) before rendering.');
      planned.push(entry);
      continue;
    }

    // Mode + model.
    let mode = null;
    let chosen = null;
    if (allRecorded && models.lipsync.model) {
      mode = MODES.LIPSYNC;
      chosen = models.lipsync;
    } else {
      if (covered.length && !allRecorded) {
        warnings.push(
          `${covered.length - entry.recorded_lines} of ${covered.length} covered line(s) have no recording — rendering without lip-sync.`,
        );
      } else if (allRecorded && !models.lipsync.model) {
        warnings.push(`Lip-sync model "${models.lipsync.id}" is unknown — rendering without lip-sync.`);
      }
      if (models.direct.model) {
        mode = MODES.DIRECT;
        chosen = models.direct;
      } else {
        if (models.direct.id) warnings.push(`Direct model "${models.direct.id}" is unknown — using the start-frame model.`);
        mode = MODES.START_ONLY;
        chosen = models.start_only;
      }
    }
    entry.mode = mode;
    entry.model_id = chosen?.id || null;
    const model = chosen?.model || null;
    if (!model) {
      entry.missing.push('video model');
      warnings.push(`No usable video model for ${mode} (configure one in Models).`);
      entry.status = 'blocked';
      planned.push(entry);
      continue;
    }
    entry.model_label = model.label;
    entry.fal_model = model.falModel;

    // Auto-keyframe: the model wants a start frame the shot doesn't have.
    const wantsStart = requires(model, 'startFrame') || (mode === MODES.START_ONLY && accepts(model, 'startFrame'));
    if (wantsStart && !entry.has_still) entry.auto_keyframe = true;

    // Required-input check, discounting what the run will supply.
    const assignment = resolveFrameAssignment(model, sb, null);
    const missing = validateAssignment(model, assignment, sb).filter((m) => {
      if (/start frame/i.test(m) && entry.auto_keyframe) return false;
      if (/audio/i.test(m) && mode === MODES.LIPSYNC) return false;
      return true;
    });
    if (missing.length) {
      entry.missing = missing;
      entry.status = 'blocked';
      warnings.push(`Missing for ${model.label}: ${missing.join(', ')}.`);
    }

    if (mode === MODES.LIPSYNC) {
      if (sb.audio_file_id) warnings.push('Existing scene audio will be replaced by the covered lines’ recordings.');
      const cap = getMaxAudioSeconds(model.falModel, null);
      if (cap && entry.speech_seconds > cap) {
        warnings.push(`Covered speech (${entry.speech_seconds.toFixed(1)}s) exceeds ${model.label}’s ${cap}s audio cap — it will be trimmed.`);
      }
    }
    if (mode === MODES.DIRECT && !assignment.referenceImageIds.length) {
      warnings.push('No reference images matched this shot — the direct model renders from the prompt alone.');
    }

    // Duration the clip will be requested at.
    if (mode === MODES.LIPSYNC) {
      entry.duration_seconds = Math.ceil(entry.speech_seconds + 0.8);
    } else {
      entry.duration_seconds = pickDurationSeconds({ requested: null, storyboard: sb, model });
    }

    planned.push(entry);
  }

  return {
    models: {
      lipsync: { id: models.lipsync.id, label: models.lipsync.model?.label || null, known: Boolean(models.lipsync.model) },
      direct: { id: models.direct.id, label: models.direct.model?.label || null, known: Boolean(models.direct.model) },
      start_only: { id: models.start_only.id, label: models.start_only.model?.label || null, known: Boolean(models.start_only.model) },
    },
    shots: planned,
  };
}

async function loadBeatInputs(projectId, beatRef) {
  const beat = await getBeat(projectId, beatRef);
  if (!beat) throw new Error(`Beat not found: ${beatRef}`);
  const shots = await listStoryboards({ beatId: beat._id });
  const rawDialogs = await listDialogs({ beatId: beat._id });
  const dialogs = await ensureDialogAudioDurations(projectId, rawDialogs).catch(() => rawDialogs);
  const modelDefaults = await getModelDefaults(projectId);
  return { beat, shots, dialogs, modelDefaults };
}

// Cost + coverage on top of the plan, for the Render beat dialog.
export async function buildBeatRenderPreview({ projectId, beatId, overrides = {}, skipRendered = true }) {
  const { beat, shots, dialogs, modelDefaults } = await loadBeatInputs(projectId, beatId);
  const plan = await buildBeatRenderPlan({ projectId, beat, shots, dialogs, modelDefaults, overrides, skipRendered });
  let total = 0;
  let anyCost = false;
  let autoKeyframes = 0;
  for (const entry of plan.shots) {
    if (entry.skipped || entry.status === 'blocked') continue;
    if (entry.auto_keyframe) autoKeyframes += 1;
    try {
      const model = await resolveVideoModelByAnyId(entry.model_id);
      if (!model) continue;
      const catalogMeta = await getVideoModelCatalogMeta(model.falModel || model.id);
      const bundle = {
        durationSeconds: entry.duration_seconds,
        generateAudio: false,
        audioDurationSeconds: entry.mode === MODES.LIPSYNC ? entry.speech_seconds : null,
      };
      const cost = computeCost({
        model,
        bundle,
        payload: {},
        catalogRow: catalogMeta ? { ...catalogMeta, price_text: catalogMeta.pricing?.note || null } : null,
      });
      if (cost?.totalUsd != null) {
        entry.estimated_cost_usd = cost.totalUsd;
        total += cost.totalUsd;
        anyCost = true;
      }
    } catch (e) {
      logger.warn(`beat render preview: cost for shot ${entry.storyboard_id} failed: ${e.message}`);
    }
  }
  const renderable = plan.shots.filter((s) => !s.skipped && s.status !== 'blocked');
  const blocked = plan.shots.filter((s) => s.status === 'blocked');
  const willAssemble =
    plan.shots.length > 0 &&
    blocked.length === 0 &&
    plan.shots.every((s) => !s.skipped || s.has_clip);
  return {
    beat: { _id: sid(beat._id), order: beat.order, name: beat.name, video_file_id: beat.video_file_id ? sid(beat.video_file_id) : null },
    fal_configured: falIsConfigured(),
    ...plan,
    coverage: auditShotCoverage({ shots, dialogs }),
    counts: {
      total: plan.shots.length,
      to_render: renderable.length,
      skipped: plan.shots.filter((s) => s.skipped).length,
      blocked: blocked.length,
      auto_keyframes: autoKeyframes,
      lipsync: renderable.filter((s) => s.mode === MODES.LIPSYNC).length,
      direct: renderable.filter((s) => s.mode === MODES.DIRECT).length,
      start_only: renderable.filter((s) => s.mode === MODES.START_ONLY).length,
    },
    total_estimated_cost_usd: anyCost ? total : null,
    will_assemble: willAssemble,
  };
}

// ── running ──────────────────────────────────────────────────────────────

export async function startBeatRenderJob({
  projectId,
  beatId,
  overrides = {},
  skipRendered = true,
  includeDirectorNotes = true,
  imageModel = null,
  announceUsername = null,
}) {
  if (!falIsConfigured()) throw new FalNotConfiguredError();
  const { beat, shots, dialogs, modelDefaults } = await loadBeatInputs(projectId, beatId);
  if (!shots.length) throw new BeatRenderEmptyError();
  if (isBeatLocked(beat._id)) throw new BeatRenderBusyError(sid(beat._id));

  const plan = await buildBeatRenderPlan({ projectId, beat, shots, dialogs, modelDefaults, overrides, skipRendered });
  const toRender = plan.shots.filter((s) => !s.skipped && s.status !== 'blocked');
  const blocked = plan.shots.filter((s) => s.status === 'blocked');
  const allHaveClips = plan.shots.every((s) => s.has_clip);
  if (!toRender.length && !allHaveClips) {
    throw new BeatRenderEmptyError(
      blocked.length
        ? `Nothing renderable: ${blocked.length} shot(s) are missing inputs (${blocked[0].missing.join(', ')}).`
        : 'Nothing to render.',
    );
  }

  const job = {
    job_id: makeJobId(),
    beat_id: sid(beat._id),
    status: 'queued',
    phase: 'queued',
    planned: toRender.length,
    completed: 0,
    failed: 0,
    skipped: plan.shots.length - toRender.length,
    progress: null,
    events: [],
    coverage: auditShotCoverage({ shots, dialogs }),
    shots: plan.shots,
    estimated_cost_usd: null,
    video_file_id: null,
    video_duration_seconds: null,
    assembly_skipped_reason: null,
    started_at: new Date(),
    finished_at: null,
    error: null,
  };
  jobs.set(job.job_id, job);
  recordProgress(job, {
    phase: 'queued',
    step: 'job_queued',
    message: `Queued — ${toRender.length} shot${toRender.length === 1 ? '' : 's'} to render` +
      (job.skipped ? `, ${job.skipped} skipped` : ''),
  });

  const resolvedImageModel =
    (typeof imageModel === 'string' && imageModel.trim()) ||
    modelDefaults?.image_with_refs ||
    'nano-banana-pro';

  withBeatLock(beat._id, () =>
    runBeatRenderJob({ projectId, job, beat, dialogs, includeDirectorNotes, imageModel: resolvedImageModel, announceUsername }),
  )
    .catch((e) => {
      if (!TERMINAL.has(job.status)) {
        job.status = 'error';
        job.error = e?.message || String(e);
        job.finished_at = new Date();
        recordProgress(job, { phase: 'error', step: 'job_crashed', message: `Render crashed: ${job.error}` });
      }
      logger.error(`beat render job ${job.job_id} crashed: ${e?.message || e}`);
    })
    .finally(() => scheduleEviction(job.job_id));

  return { job_id: job.job_id, planned: job.planned, skipped: job.skipped };
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = Array.from({ length: n }, async () => {
    while (next < items.length) {
      const idx = next++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function attachConcatAudio({ projectId, job, entry, dialogs }) {
  const covered = dialogs.filter((d) => entry.covered_dialog_ids.includes(sid(d._id)));
  const buffers = [];
  for (const d of covered) {
    const read = await readAttachmentBuffer(d.audio_file_id);
    if (!read?.buffer?.length) throw new Error(`Recording for line ${d.order} could not be read.`);
    buffers.push(read.buffer);
  }
  const mp3 = await concatAudioToMp3(buffers, { gapSeconds: CONCAT_GAP_SECONDS, tailSeconds: CONCAT_TAIL_SECONDS });
  const file = await uploadAttachmentBuffer(projectId, {
    buffer: mp3,
    filename: `shot-${entry.storyboard_id}-dialog-${Date.now()}.mp3`,
    contentType: 'audio/mpeg',
    ownerType: 'beat',
    ownerId: job.beat_id,
    generatedBy: 'dialog-concat',
  });
  await setStoryboardAudioViaGateway({ projectId, storyboardId: entry.storyboard_id, audioFileId: file._id });
  return file;
}

async function renderOneShot({ projectId, job, beat, entry, dialogs, includeDirectorNotes, imageModel }) {
  const label = `Shot ${entry.order + 1}`;
  entry.status = 'preparing';
  entry.step = 'Preparing';
  publish(job);
  try {
    let sb = await getStoryboard(projectId, entry.storyboard_id);
    if (!sb) throw new Error('Storyboard row disappeared.');

    if (entry.auto_keyframe && !sb.frames?.[0]?.image_id) {
      entry.step = 'Rendering still';
      recordProgress(job, { phase: 'rendering', step: 'keyframe_start', message: `${label}: rendering start frame…` });
      const { renderShotStillInternal } = await import('./storyboardGenerate.js');
      sb = await renderShotStillInternal({ projectId, sb, beat, imageModel });
      entry.has_still = Boolean(sb.frames?.[0]?.image_id);
      if (!entry.has_still) throw new Error('Start frame render produced no image.');
    }

    if (entry.mode === MODES.LIPSYNC) {
      entry.step = 'Joining recordings';
      recordProgress(job, { phase: 'rendering', step: 'audio_concat', message: `${label}: joining ${entry.covered_lines} recording(s)…` });
      await attachConcatAudio({ projectId, job, entry, dialogs });
    }

    entry.step = 'Submitting';
    recordProgress(job, { phase: 'rendering', step: 'shot_start', message: `${label}: ${entry.mode} via ${entry.model_label}…` });
    let listener = null;
    const shotJob = await runShotVideoInline({
      projectId,
      storyboardId: entry.storyboard_id,
      modelId: entry.model_id,
      durationSeconds: entry.mode === MODES.LIPSYNC ? null : entry.duration_seconds,
      generateAudio: false,
      includeDirectorNotes,
      announceUsername: null,
      onJobCreated: (j) => {
        entry.job_id = j.job_id;
        listener = (snap) => {
          entry.status = snap.status;
          entry.step = snap.step;
          entry.queue_position = snap.queue_position;
          if (snap.estimated_cost_usd != null) entry.estimated_cost_usd = snap.estimated_cost_usd;
          publish(job);
        };
        subscribeToJob(j.job_id, listener);
      },
    });
    if (listener) unsubscribeFromJob(shotJob.job_id, listener);

    if (shotJob.status === 'done' && shotJob.video_file_id) {
      entry.status = 'done';
      entry.step = 'Done';
      entry.video_file_id = shotJob.video_file_id;
      entry.has_clip = true;
      entry.error = null;
      if (shotJob.estimated_cost_usd != null) entry.estimated_cost_usd = shotJob.estimated_cost_usd;
      job.completed += 1;
      recordProgress(job, { phase: 'rendering', step: 'shot_done', message: `${label}: clip ready` });
    } else {
      throw new Error(shotJob.error || 'Video generation failed.');
    }
  } catch (e) {
    entry.status = 'failed';
    entry.step = 'Failed';
    entry.error = e?.message || String(e);
    job.failed += 1;
    recordProgress(job, { phase: 'rendering', step: 'shot_failed', message: `${label}: ${entry.error}` });
  }
}

async function runBeatRenderJob({ projectId, job, beat, dialogs, includeDirectorNotes, imageModel, announceUsername }) {
  job.status = 'rendering';
  const toRender = job.shots.filter((s) => !s.skipped && s.status !== 'blocked');
  if (toRender.length) {
    recordProgress(job, {
      phase: 'rendering',
      step: 'render_start',
      message: `Rendering ${toRender.length} shot${toRender.length === 1 ? '' : 's'} (${config.fal.videoConcurrency} at a time)…`,
    });
    await runPool(toRender, config.fal.videoConcurrency, (entry) =>
      renderOneShot({ projectId, job, beat, entry, dialogs, includeDirectorNotes, imageModel }),
    );
  }
  job.estimated_cost_usd = job.shots.reduce((sum, s) => sum + (Number(s.estimated_cost_usd) || 0), 0) || null;

  // Assemble only when every shot in the beat has a clip.
  const shots = await listStoryboards({ beatId: beat._id });
  const blocked = job.shots.filter((s) => s.status === 'blocked').length;
  const missingClips = shots.filter((s) => !s.video_file_id).length;
  if (job.failed || blocked || missingClips || !shots.length) {
    job.status = 'partial';
    job.assembly_skipped_reason = job.failed
      ? `${job.failed} shot${job.failed === 1 ? '' : 's'} failed`
      : blocked
        ? `${blocked} shot${blocked === 1 ? '' : 's'} missing inputs`
        : missingClips
          ? `${missingClips} shot${missingClips === 1 ? '' : 's'} without a clip`
          : 'no shots';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'partial',
      step: 'assembly_skipped',
      message: `Beat video not assembled: ${job.assembly_skipped_reason}. Re-run "Render beat" to fill in the gaps.`,
    });
    return;
  }

  job.status = 'assembling';
  recordProgress(job, { phase: 'assembling', step: 'assemble_start', message: `Joining ${shots.length} clips into the beat video…` });
  try {
    const { assembleBeatVideo } = await import('./beatAssemble.js');
    const { file, durationSeconds } = await assembleBeatVideo({
      projectId,
      beat,
      shots,
      onProgress: (message) => recordProgress(job, { phase: 'assembling', step: 'assemble_step', message }),
    });
    job.video_file_id = sid(file._id);
    job.video_duration_seconds = durationSeconds;
    job.status = 'done';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'done',
      step: 'job_done',
      message: `Beat video ready${durationSeconds ? ` (${Math.round(durationSeconds)}s)` : ''}.`,
    });
    if (announceUsername) announceBeatVideo({ projectId, beat, fileId: file._id, username: announceUsername }).catch(() => {});
  } catch (e) {
    job.status = 'partial';
    job.assembly_skipped_reason = e?.message || String(e);
    job.finished_at = new Date();
    recordProgress(job, { phase: 'partial', step: 'assemble_failed', message: `Clips rendered but assembly failed: ${job.assembly_skipped_reason}` });
  }
}

async function announceBeatVideo({ projectId, beat, fileId, username }) {
  try {
    const { announceMediaEvent } = await import('../discord/announcer.js');
    const { storyboardUrl } = await import('./links.js');
    const { stripMarkdown } = await import('../util/markdown.js');
    const { getProjectById } = await import('../mongo/projects.js');
    const project = projectId ? await getProjectById(projectId) : null;
    const name = stripMarkdown(beat.name || '').trim();
    const order = Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
    await announceMediaEvent({
      username,
      verb: 'rendered the beat video for',
      entityLabel: name ? `${order}: ${name}` : order,
      entityUrl: storyboardUrl(project?.title ?? null, beat),
      mediaFileId: fileId,
      mediaLabel: 'beat video',
      prompt: null,
    });
  } catch (e) {
    logger.warn(`beat render announce failed: ${e?.message || e}`);
  }
}
