// Prompts-tab "Render beat": every cut of a beat → one clip each → the beat's
// Prompts-tab MP4. The cut-by-cut twin of src/web/beatRender.js.
//
//   plan   buildCutRenderPlan picks a MODE per cut —
//            lipsync  every covered dialogue line has a recording → the
//                     lip-sync model (ComfyUI ltx-2.3-ia2v / fal avatar
//                     model) with the joined recordings as audio
//            clip     otherwise → the clip model (ComfyUI image-to-video /
//                     fal start-frame model)
//          and flags AUTO START FRAME cuts: the model wants a start frame the
//          cut has not rendered yet, so the still is rendered first.
//   run    one withBeatLock for the whole beat. ComfyUI cuts render one at a
//          time (the GPU queue is serial) through runComfyCutRenderInline;
//          fal cuts run FAL_VIDEO_CONCURRENCY at a time through
//          runShotVideoInline with a video_prompt owner. Per-cut jobs keep
//          their own SSE streams; their snapshots are merged into `cuts[]`.
//   join   when every cut in the beat has a clip, cutAssemble joins them into
//          beats.$.prompts_video_file_id; otherwise the job ends 'partial'
//          and a re-run with skipRendered renders only what is missing.
//
// ComfyUI params come from the per-project defaults the per-cut dialog saved
// (project_settings.comfy_video.params_by_model) — the bulk job never edits
// them. Real voices only: dialogue words never enter a prompt.

import { config } from '../config.js';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { listVideoPrompts, getVideoPrompt } from '../mongo/videoPrompts.js';
import { listVideoScenes } from '../mongo/videoScenes.js';
import { listDialogs, ensureDialogAudioDurations } from '../mongo/dialogs.js';
import { getModelDefaults, getComfyDefaults } from '../mongo/projectSettings.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { setVideoPromptAudioViaGateway } from './gateway.js';
import {
  coveredDialogsFor,
  speechSecondsFor,
  allLinesRecorded,
  buildCoveredDialogueAudio,
  runPool,
} from './dialogueAudio.js';
import { INPUT_NEEDS, resolveVideoModelByAnyId, getVideoModelCatalogMeta, getMaxAudioSeconds } from '../fal/videoModels.js';
import { isConfigured as falIsConfigured } from '../fal/client.js';
import { isComfyConfigured } from '../comfy/client.js';
import { getComfyVideoModel } from '../comfy/videoModels.js';
import {
  runShotVideoInline,
  subscribeToJob,
  unsubscribeFromJob,
  computeCost,
  pickDurationSeconds,
  FalNotConfiguredError,
  OWNER_VIDEO_PROMPT,
} from './falVideoGenerate.js';
import {
  prepareCutRender,
  runComfyCutRenderInline,
  subscribeToComfyJob,
  unsubscribeFromComfyJob,
  SpendConsentRequiredError,
} from './comfyVideoGenerate.js';
import { cutLabel } from './cutAssemble.js';
import { renderSecondsForCut, describeTiming } from './cutTiming.js';
import { frameCheckIsCurrent } from './cutFrameCheck.js';

export const MODES = Object.freeze({ LIPSYNC: 'lipsync', CLIP: 'clip' });
export const PROVIDERS = Object.freeze({ COMFY: 'comfy', FAL: 'fal' });
export const COMFY_DEFAULT_LIPSYNC_MODEL_ID = 'ltx-2.3-ia2v';
export const COMFY_DEFAULT_CLIP_MODEL_ID = 'ltx-2.5-i2v';
export const FAL_FALLBACK_LIPSYNC_MODEL_ID = 'kling-avatar-v2-pro';
export const COMFY_DISABLED_MESSAGE = 'ComfyUI rendering is disabled on this server.';

const TERMINAL = new Set(['done', 'partial', 'error']);
const TERMINAL_RETENTION_MS = 10 * 60 * 1000;
const MAX_EVENTS = 300;

const jobs = new Map();
const listeners = new Map();

export class CutRenderBusyError extends Error {
  constructor(beatId) {
    super(`Prompts-tab work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
    this.status = 409;
  }
}

export class CutRenderEmptyError extends Error {
  constructor(message = 'Nothing to render: plan cuts first.') {
    super(message);
    this.code = 'CUT_RENDER_EMPTY';
    this.status = 400;
  }
}

export class ComfyDisabledError extends Error {
  constructor() {
    super(COMFY_DISABLED_MESSAGE);
    this.code = 'COMFY_NOT_CONFIGURED';
    this.status = 503;
  }
}

export class UnknownProviderError extends Error {
  constructor(provider) {
    super(`Unknown video provider: ${provider} (expected "comfy" or "fal").`);
    this.code = 'UNKNOWN_PROVIDER';
    this.status = 400;
  }
}

// ── job registry / pub-sub ────────────────────────────────────────────────

function makeJobId() {
  return `cuts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getCutBeatRenderJob(jobId) {
  return jobs.get(jobId) || null;
}

export async function findCutBeatRenderJobForBeat(beatId) {
  const { latestJobForBeat } = await import('./jobLookup.js');
  return latestJobForBeat(jobs, beatId);
}

export function subscribeToCutBeatJob(jobId, cb) {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId).add(cb);
}

export function unsubscribeFromCutBeatJob(jobId, cb) {
  const set = listeners.get(jobId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(jobId);
}

function publish(job) {
  const set = listeners.get(job.job_id);
  if (!set || !set.size) return;
  const snap = serializeCutBeatJob(job);
  for (const cb of set) {
    try {
      cb(snap);
    } catch (e) {
      logger.warn(`cut render: listener threw: ${e.message}`);
    }
  }
}

export function serializeCutBeatJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    kind: 'cut_render',
    beat_id: job.beat_id,
    provider: job.provider,
    status: job.status,
    phase: job.phase,
    planned: job.planned,
    completed: job.completed,
    failed: job.failed,
    skipped: job.skipped,
    progress: job.progress,
    events: job.events.slice(-MAX_EVENTS),
    models: job.models,
    cuts: job.cuts.map((c) => ({ ...c })),
    spends_credits: job.spends_credits,
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
  logger.info(`cut render ${job.job_id} [${phase}/${step}] ${message}`);
  publish(job);
}

function scheduleEviction(jobId) {
  setTimeout(() => {
    jobs.delete(jobId);
    listeners.delete(jobId);
  }, TERMINAL_RETENTION_MS).unref?.();
}

export function _resetCutBeatRenderForTests() {
  jobs.clear();
  listeners.clear();
}

// ── planning ─────────────────────────────────────────────────────────────

const sid = (x) => (x == null ? null : x.toString?.() || String(x));

function requires(model, key) {
  return model?.inputs?.[key] === INPUT_NEEDS.REQUIRED;
}
function accepts(model, key) {
  const need = model?.inputs?.[key];
  return need === INPUT_NEEDS.REQUIRED || need === INPUT_NEEDS.OPTIONAL;
}

function pick(...candidates) {
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim();
  return null;
}

export function defaultProvider() {
  return isComfyConfigured() ? PROVIDERS.COMFY : PROVIDERS.FAL;
}

function normalizeProvider(provider) {
  if (provider == null || provider === '') return defaultProvider();
  const p = String(provider).toLowerCase();
  if (p === PROVIDERS.COMFY || p === PROVIDERS.FAL) return p;
  throw new UnknownProviderError(provider);
}

// Which model each mode uses for this provider, resolved once per plan.
async function resolvePlanModels({ provider, models = {}, modelDefaults, comfyDefaults }) {
  const out = {};
  if (provider === PROVIDERS.COMFY) {
    const ids = {
      lipsync: pick(models.lipsync, COMFY_DEFAULT_LIPSYNC_MODEL_ID),
      clip: pick(models.clip, comfyDefaults?.model_id, COMFY_DEFAULT_CLIP_MODEL_ID),
    };
    for (const [mode, id] of Object.entries(ids)) {
      const m = getComfyVideoModel(id);
      out[mode] = { id, model: m && m.available !== false ? m : null };
    }
  } else {
    const ids = {
      lipsync: pick(models.lipsync, modelDefaults?.lipsync, FAL_FALLBACK_LIPSYNC_MODEL_ID),
      clip: pick(models.clip, modelDefaults?.video_start_only, config.fal.defaultModelId),
    };
    for (const [mode, id] of Object.entries(ids)) {
      out[mode] = { id, model: id ? await resolveVideoModelByAnyId(id) : null };
    }
  }
  return out;
}

function describeModel(entry, provider) {
  const m = entry?.model || null;
  return {
    id: entry?.id || null,
    label: m?.label || null,
    known: Boolean(m),
    provider,
    spends_credits: provider === PROVIDERS.COMFY ? Boolean(m?.spends_credits) : false,
    kind: provider === PROVIDERS.COMFY ? m?.kind || null : 'fal',
  };
}

function effectiveComfyParams(model, paramsByModel) {
  const saved = paramsByModel && typeof paramsByModel === 'object' ? paramsByModel[model.id] : null;
  return saved && typeof saved === 'object' ? { ...saved } : {};
}

// Returns { provider, models, cuts } — the per-cut plan the preview shows and
// the runner executes. Reads nothing beyond its arguments once models resolve.
export async function buildCutRenderPlan({
  beat,
  cuts,
  scenes = [],
  dialogs = [],
  provider,
  models = {},
  modelDefaults = null,
  comfyDefaults = null,
  paramsByModel = null,
  skipRendered = true,
}) {
  const prov = normalizeProvider(provider);
  const resolved = await resolvePlanModels({ provider: prov, models, modelDefaults, comfyDefaults });
  const sceneOrder = new Map((scenes || []).map((s) => [String(s._id), s.order]));
  const ordered = [...(cuts || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const effectiveParams = paramsByModel || comfyDefaults?.params_by_model || {};
  const planned = [];

  for (const cut of ordered) {
    const covered = coveredDialogsFor(cut, dialogs);
    const recorded = allLinesRecorded(covered);
    const warnings = [];
    const entry = {
      cut_id: sid(cut._id),
      label: cutLabel(cut, sceneOrder),
      order: cut.order ?? 0,
      scene_id: cut.scene_id ? sid(cut.scene_id) : null,
      title: (cut.title || '').trim() || null,
      has_prompt: Boolean((cut.prompt || '').trim()),
      has_start_frame: Boolean(cut.start_frame?.image_id),
      has_start_frame_prompt: Boolean((cut.start_frame?.prompt || '').trim()),
      has_end_frame: Boolean(cut.end_frame?.image_id),
      has_end_frame_prompt: Boolean((cut.end_frame?.prompt || '').trim()),
      has_clip: Boolean(cut.video_file_id),
      covered_dialog_ids: covered.map((d) => sid(d._id)),
      covered_lines: covered.length,
      recorded_lines: covered.filter((d) => d.audio_file_id).length,
      speech_seconds: recorded ? speechSecondsFor(covered) : null,
      mode: null,
      provider: prov,
      model_id: null,
      model_label: null,
      spends_credits: false,
      auto_start_frame: false,
      auto_end_frame: false,
      skipped: false,
      skip_reason: null,
      missing: [],
      warnings,
      duration_seconds: null,
      params: null,
      status: 'pending',
      step: null,
      job_id: null,
      error: null,
      video_file_id: cut.video_file_id ? sid(cut.video_file_id) : null,
      estimated_cost_usd: null,
    };

    if (skipRendered && cut.video_file_id) {
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
      warnings.push('Cut has no prompt block — write one (or re-plan the scene) before rendering.');
      planned.push(entry);
      continue;
    }

    let mode;
    let chosen;
    if (recorded && resolved.lipsync.model) {
      mode = MODES.LIPSYNC;
      chosen = resolved.lipsync;
    } else {
      if (covered.length && !recorded) {
        warnings.push(
          `${covered.length - entry.recorded_lines} of ${covered.length} covered line(s) have no recording — rendering without lip-sync.`,
        );
      } else if (recorded && !resolved.lipsync.model) {
        warnings.push(`Lip-sync model "${resolved.lipsync.id}" is unknown — rendering without lip-sync.`);
      }
      mode = MODES.CLIP;
      chosen = resolved.clip;
    }
    entry.mode = mode;
    entry.model_id = chosen?.id || null;
    const model = chosen?.model || null;
    if (!model) {
      entry.missing.push('video model');
      warnings.push(`No usable ${prov === PROVIDERS.COMFY ? 'ComfyUI' : 'fal'} model for ${mode} (${chosen?.id || 'none configured'}).`);
      entry.status = 'blocked';
      planned.push(entry);
      continue;
    }
    entry.model_label = model.label;
    entry.spends_credits = prov === PROVIDERS.COMFY && Boolean(model.spends_credits);

    // Auto start frame: the model wants a still the cut has not rendered.
    if (accepts(model, 'startFrame') && !entry.has_start_frame) {
      if (requires(model, 'startFrame') || !accepts(model, 'referenceImages')) {
        if (entry.has_start_frame_prompt) entry.auto_start_frame = true;
        else {
          entry.missing.push('start frame');
          warnings.push('No start frame and no start-frame prompt — render or write one first.');
        }
      }
    }
    // Auto end frame: a first-last-frame model lands on the cut's end frame.
    // Rendered whenever the model takes one and the cut has a prompt for it;
    // only a model that REQUIRES it is blocked without one.
    if (accepts(model, 'endFrame') && !entry.has_end_frame) {
      if (entry.has_end_frame_prompt) entry.auto_end_frame = true;
      else if (requires(model, 'endFrame')) {
        entry.missing.push('end frame');
        warnings.push('No end frame and no end-frame prompt — render or write one first.');
      }
    }
    if (requires(model, 'referenceImages') && !(cut.reference_images || []).length) {
      entry.missing.push('reference images');
    }
    if (entry.missing.length) {
      entry.status = 'blocked';
      warnings.push(`Missing for ${model.label}: ${entry.missing.join(', ')}.`);
    }
    // A pair the frame check could not get past a blocking fault on still
    // renders (a failed pair is a warning) — but the plan says so, in red.
    if (accepts(model, 'endFrame') && frameCheckIsCurrent(cut) && cut.frame_check?.blocking) {
      entry.frame_blocking = true;
      const notes = cut.frame_check.issues.filter((i) => i.severity === 'blocking').map((i) => i.note).join(' ');
      warnings.push(`${cut.frame_check.blocking} blocking problem${cut.frame_check.blocking === 1 ? '' : 's'} between the start and end frames — the clip will show it: ${notes}`);
    }

    if (mode === MODES.LIPSYNC) {
      if (cut.audio_file_id) warnings.push('The previous joined recording will be replaced.');
      if (prov === PROVIDERS.FAL) {
        const cap = getMaxAudioSeconds(model.falModel, null);
        if (cap && entry.speech_seconds > cap) {
          warnings.push(`Covered speech (${entry.speech_seconds.toFixed(1)}s) exceeds ${model.label}’s ${cap}s audio cap — it will be trimmed.`);
        }
      } else {
        const max = model.params?.duration_seconds?.max;
        if (max && entry.speech_seconds > max) {
          warnings.push(`Covered speech (${entry.speech_seconds.toFixed(1)}s) exceeds ${model.label}’s ${max}s cap — the audio will be trimmed.`);
        }
      }
    }

    if (prov === PROVIDERS.COMFY) {
      const params = effectiveComfyParams(model, effectiveParams);
      if (mode === MODES.LIPSYNC) {
        params.duration_seconds = Math.max(1, Math.ceil(entry.speech_seconds || 1));
      } else {
        // The cut's own length (plus a travelling camera's handles), never a
        // remembered one — cutTiming.js.
        const timing = renderSecondsForCut(cut, model.params?.duration_seconds);
        if (timing) {
          params.duration_seconds = timing.seconds;
          entry.cut_seconds = timing.cut_seconds;
          entry.timing = timing;
          const note = describeTiming(timing, model.label);
          if (note) warnings.push(note);
        }
      }
      entry.params = params;
      entry.duration_seconds = params.duration_seconds ?? model.params?.duration_seconds?.default ?? null;
    } else if (mode === MODES.LIPSYNC) {
      entry.duration_seconds = Math.ceil(entry.speech_seconds + 0.8);
    } else {
      // fal: the same request, snapped UP to the model's allowed lengths so
      // the handles survive (nearest would round them away).
      const timing = renderSecondsForCut(cut, null);
      entry.duration_seconds = pickDurationSeconds({
        requested: timing?.requested ?? null,
        row: { duration_seconds: cut.duration_seconds },
        model,
        roundUp: Boolean(timing),
      });
      if (timing) {
        entry.cut_seconds = timing.cut_seconds;
        entry.timing = { ...timing, seconds: entry.duration_seconds };
      }
    }

    planned.push(entry);
  }

  return {
    provider: prov,
    models: {
      lipsync: describeModel(resolved.lipsync, prov),
      clip: describeModel(resolved.clip, prov),
    },
    cuts: planned,
  };
}

async function loadCutInputs(projectId, beatRef) {
  const beat = await getBeat(projectId, beatRef);
  if (!beat) throw new Error(`Beat not found: ${beatRef}`);
  const [cuts, scenes, rawDialogs, modelDefaults, comfyDefaults] = await Promise.all([
    listVideoPrompts({ projectId, beatId: beat._id }),
    listVideoScenes({ projectId, beatId: beat._id }),
    listDialogs({ projectId, beatId: beat._id }),
    getModelDefaults(projectId),
    getComfyDefaults(projectId),
  ]);
  const dialogs = await ensureDialogAudioDurations(projectId, rawDialogs).catch(() => rawDialogs);
  return { beat, cuts, scenes, dialogs, modelDefaults, comfyDefaults };
}

// Plan + cost (fal only) + will_assemble, for the Render beat dialog.
export async function buildCutRenderPreview({ projectId, beatId, provider = null, models = {}, paramsByModel = null, skipRendered = true }) {
  const inputs = await loadCutInputs(projectId, beatId);
  const plan = await buildCutRenderPlan({ ...inputs, provider, models, paramsByModel, skipRendered });
  let total = 0;
  let anyCost = false;
  let autoStartFrames = 0;
  let autoEndFrames = 0;
  for (const entry of plan.cuts) {
    if (entry.skipped || entry.status === 'blocked') continue;
    if (entry.auto_start_frame) autoStartFrames += 1;
    if (entry.auto_end_frame) autoEndFrames += 1;
    if (plan.provider !== PROVIDERS.FAL) continue;
    try {
      const model = await resolveVideoModelByAnyId(entry.model_id);
      if (!model) continue;
      const catalogMeta = await getVideoModelCatalogMeta(model.falModel || model.id);
      const cost = computeCost({
        model,
        bundle: {
          durationSeconds: entry.duration_seconds,
          generateAudio: false,
          audioDurationSeconds: entry.mode === MODES.LIPSYNC ? entry.speech_seconds : null,
        },
        payload: {},
        catalogRow: catalogMeta ? { ...catalogMeta, price_text: catalogMeta.pricing?.note || null } : null,
      });
      if (cost?.totalUsd != null) {
        entry.estimated_cost_usd = cost.totalUsd;
        total += cost.totalUsd;
        anyCost = true;
      }
    } catch (e) {
      logger.warn(`cut render preview: cost for cut ${entry.cut_id} failed: ${e.message}`);
    }
  }
  const renderable = plan.cuts.filter((c) => !c.skipped && c.status !== 'blocked');
  const blocked = plan.cuts.filter((c) => c.status === 'blocked');
  const willAssemble = plan.cuts.length > 0 && blocked.length === 0 && plan.cuts.every((c) => !c.skipped || c.has_clip);
  const { beat } = inputs;
  return {
    beat: {
      _id: sid(beat._id),
      order: beat.order,
      name: beat.name,
      prompts_video_file_id: beat.prompts_video_file_id ? sid(beat.prompts_video_file_id) : null,
    },
    comfy_configured: isComfyConfigured(),
    comfy_disabled_reason: isComfyConfigured() ? null : COMFY_DISABLED_MESSAGE,
    fal_configured: falIsConfigured(),
    ...plan,
    spends_credits: renderable.some((c) => c.spends_credits),
    counts: {
      total: plan.cuts.length,
      to_render: renderable.length,
      skipped: plan.cuts.filter((c) => c.skipped).length,
      blocked: blocked.length,
      auto_start_frames: autoStartFrames,
      auto_end_frames: autoEndFrames,
      lipsync: renderable.filter((c) => c.mode === MODES.LIPSYNC).length,
      clip: renderable.filter((c) => c.mode === MODES.CLIP).length,
    },
    total_estimated_cost_usd: anyCost ? total : null,
    will_assemble: willAssemble,
  };
}

// ── running ──────────────────────────────────────────────────────────────

export async function startCutBeatRenderJob({
  projectId,
  beatId,
  provider = null,
  models = {},
  paramsByModel = null,
  skipRendered = true,
  confirmSpend = false,
  imageModel = null,
  announceUsername = null,
}) {
  const prov = normalizeProvider(provider);
  if (prov === PROVIDERS.COMFY && !isComfyConfigured()) throw new ComfyDisabledError();
  if (prov === PROVIDERS.FAL && !falIsConfigured()) throw new FalNotConfiguredError();
  const inputs = await loadCutInputs(projectId, beatId);
  const { beat, cuts } = inputs;
  if (!cuts.length) throw new CutRenderEmptyError();
  if (isBeatLocked(beat._id)) throw new CutRenderBusyError(sid(beat._id));

  const plan = await buildCutRenderPlan({ ...inputs, provider: prov, models, paramsByModel, skipRendered });
  const toRender = plan.cuts.filter((c) => !c.skipped && c.status !== 'blocked');
  const blocked = plan.cuts.filter((c) => c.status === 'blocked');
  const allHaveClips = plan.cuts.every((c) => c.has_clip);
  if (!toRender.length && !allHaveClips) {
    throw new CutRenderEmptyError(
      blocked.length
        ? `Nothing renderable: ${blocked.length} cut(s) are missing inputs (${blocked[0].missing.join(', ')}).`
        : 'Nothing to render.',
    );
  }
  const spending = toRender.filter((c) => c.spends_credits);
  if (spending.length && !confirmSpend) throw new SpendConsentRequiredError(spending[0].model_label);

  const job = {
    job_id: makeJobId(),
    beat_id: sid(beat._id),
    provider: prov,
    status: 'queued',
    phase: 'queued',
    planned: toRender.length,
    completed: 0,
    failed: 0,
    skipped: plan.cuts.length - toRender.length,
    progress: null,
    events: [],
    models: plan.models,
    cuts: plan.cuts,
    spends_credits: spending.length > 0,
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
    step: 'job_created',
    message: `Render planned: ${toRender.length} cut${toRender.length === 1 ? '' : 's'} via ${prov === PROVIDERS.COMFY ? 'ComfyUI' : 'fal.ai'}, ${job.skipped} skipped.`,
  });

  withBeatLock(beat._id, () =>
    runCutRenderJob({ projectId, job, beat, dialogs: inputs.dialogs, confirmSpend, imageModel, announceUsername }),
  )
    .catch((e) => {
      job.status = 'error';
      job.error = e?.message || String(e);
      job.finished_at = new Date();
      recordProgress(job, { phase: 'error', step: 'job_failed', message: job.error });
    })
    .finally(() => scheduleEviction(job.job_id));

  return { job_id: job.job_id, planned: job.planned, skipped: job.skipped };
}

async function ensureStartFrame({ projectId, job, beat, entry, cut, imageModel }) {
  if (!entry.auto_start_frame || cut.start_frame?.image_id) return cut;
  entry.step = 'Rendering start frame';
  recordProgress(job, { phase: 'rendering', step: 'start_frame', message: `Cut ${entry.label}: rendering start frame…` });
  const { renderCutStartFrame } = await import('./cutStartFrames.js');
  const result = await renderCutStartFrame({ projectId, cut, beat, imageModel });
  const fresh = result?.cut || (await getVideoPrompt(projectId, sid(cut._id)));
  entry.has_start_frame = Boolean(fresh?.start_frame?.image_id);
  if (!entry.has_start_frame) throw new Error('Start frame render produced no image.');
  return fresh;
}

// After ensureStartFrame, so the end frame gets the fresh start frame as its
// continuity reference.
async function ensureEndFrame({ projectId, job, beat, entry, cut, imageModel }) {
  if (!entry.auto_end_frame || cut.end_frame?.image_id) return cut;
  entry.step = 'Rendering end frame';
  recordProgress(job, { phase: 'rendering', step: 'end_frame', message: `Cut ${entry.label}: rendering end frame…` });
  const { renderCutStartFrame } = await import('./cutStartFrames.js');
  const result = await renderCutStartFrame({ projectId, cut, beat, frame: 'end', imageModel });
  let fresh = result?.cut || (await getVideoPrompt(projectId, sid(cut._id)));
  entry.has_end_frame = Boolean(fresh?.end_frame?.image_id);
  if (!entry.has_end_frame) throw new Error('End frame render produced no image.');
  // The model is about to animate every difference between the two stills:
  // check the pair and repair what disagrees. A pair that still differs
  // renders anyway, with a warning on the cut.
  if (fresh.start_frame?.image_id) {
    entry.step = 'Checking frames';
    recordProgress(job, { phase: 'rendering', step: 'frame_check', message: `Cut ${entry.label}: checking the start and end frames…` });
    try {
      const { reconcileCutFrames } = await import('./cutFrameCheck.js');
      const r = await reconcileCutFrames({ projectId, beat, cut: fresh, imageModel });
      if (r.cut) fresh = r.cut;
      if (r.frame_check?.status === 'fail') {
        if (r.frame_check.blocking) entry.frame_blocking = true;
        entry.warnings.push(`${r.frame_check.blocking ? 'BLOCKING — ' : ''}The start and end frames still disagree: ${r.frame_check.issues.map((i) => i.note).join(' ')}`);
      }
    } catch (e) {
      logger.warn(`cut beat render: frame check failed for cut ${entry.cut_id}: ${e?.message || e}`);
    }
  }
  return fresh;
}

function mergeSnapshot(entry, snap, job) {
  entry.status = snap.status;
  entry.step = snap.step;
  entry.queue_position = snap.queue_position ?? null;
  if (snap.estimated_cost_usd != null) entry.estimated_cost_usd = snap.estimated_cost_usd;
  publish(job);
}

async function renderOneCut({ projectId, job, beat, entry, dialogs, confirmSpend, imageModel }) {
  const label = `Cut ${entry.label}`;
  entry.status = 'preparing';
  entry.step = 'Preparing';
  publish(job);
  try {
    let cut = await getVideoPrompt(projectId, entry.cut_id);
    if (!cut) throw new Error('Cut disappeared.');
    cut = await ensureStartFrame({ projectId, job, beat, entry, cut, imageModel });
    cut = await ensureEndFrame({ projectId, job, beat, entry, cut, imageModel });

    let cutJob;
    if (job.provider === PROVIDERS.COMFY) {
      entry.step = 'Preparing ComfyUI job';
      const prep = await prepareCutRender({
        projectId,
        cutId: entry.cut_id,
        modelId: entry.model_id,
        params: entry.params || {},
        confirmSpend,
      });
      entry.warnings.push(...(prep.warnings || []).filter((w) => !entry.warnings.includes(w)));
      recordProgress(job, { phase: 'rendering', step: 'cut_start', message: `${label}: ${entry.mode} via ${entry.model_label}…` });
      let listener = null;
      cutJob = await runComfyCutRenderInline({
        prep,
        projectId,
        confirmSpend,
        announceUsername: null,
        onJobCreated: (j) => {
          entry.job_id = j.job_id;
          listener = (snap) => mergeSnapshot(entry, snap, job);
          subscribeToComfyJob(j.job_id, listener);
        },
      });
      if (listener) unsubscribeFromComfyJob(cutJob.job_id, listener);
    } else {
      if (entry.mode === MODES.LIPSYNC) {
        entry.step = 'Joining recordings';
        recordProgress(job, { phase: 'rendering', step: 'audio_concat', message: `${label}: joining ${entry.covered_lines} recording(s)…` });
        const covered = dialogs.filter((d) => entry.covered_dialog_ids.includes(sid(d._id)));
        const { file } = await buildCoveredDialogueAudio({
          projectId,
          beatId: beat._id,
          covered,
          filename: `cut-${entry.cut_id}-dialogue-${Date.now()}.mp3`,
        });
        await setVideoPromptAudioViaGateway({ projectId, promptId: entry.cut_id, audioFileId: file._id });
      }
      entry.step = 'Submitting';
      recordProgress(job, { phase: 'rendering', step: 'cut_start', message: `${label}: ${entry.mode} via ${entry.model_label}…` });
      let listener = null;
      cutJob = await runShotVideoInline({
        projectId,
        owner: { kind: OWNER_VIDEO_PROMPT, id: entry.cut_id },
        modelId: entry.model_id,
        durationSeconds: entry.mode === MODES.LIPSYNC ? null : entry.duration_seconds,
        generateAudio: false,
        includeDirectorNotes: false,
        announceUsername: null,
        onJobCreated: (j) => {
          entry.job_id = j.job_id;
          listener = (snap) => mergeSnapshot(entry, snap, job);
          subscribeToJob(j.job_id, listener);
        },
      });
      if (listener) unsubscribeFromJob(cutJob.job_id, listener);
    }

    if (cutJob.status === 'done' && cutJob.video_file_id) {
      entry.status = 'done';
      entry.step = 'Done';
      entry.video_file_id = sid(cutJob.video_file_id);
      entry.has_clip = true;
      entry.error = null;
      if (cutJob.estimated_cost_usd != null) entry.estimated_cost_usd = cutJob.estimated_cost_usd;
      job.completed += 1;
      recordProgress(job, { phase: 'rendering', step: 'cut_done', message: `${label}: clip ready` });
    } else {
      throw new Error(cutJob.error || 'Video generation failed.');
    }
  } catch (e) {
    entry.status = 'failed';
    entry.step = 'Failed';
    entry.error = e?.message || String(e);
    job.failed += 1;
    recordProgress(job, { phase: 'rendering', step: 'cut_failed', message: `${label}: ${entry.error}` });
  }
}

async function runCutRenderJob({ projectId, job, beat, dialogs, confirmSpend, imageModel, announceUsername }) {
  job.status = 'rendering';
  const toRender = job.cuts.filter((c) => !c.skipped && c.status !== 'blocked');
  const concurrency = job.provider === PROVIDERS.COMFY ? 1 : config.fal.videoConcurrency;
  if (toRender.length) {
    recordProgress(job, {
      phase: 'rendering',
      step: 'render_start',
      message: `Rendering ${toRender.length} cut${toRender.length === 1 ? '' : 's'} (${concurrency} at a time)…`,
    });
    await runPool(toRender, concurrency, (entry) =>
      renderOneCut({ projectId, job, beat, entry, dialogs, confirmSpend, imageModel }),
    );
  }
  job.estimated_cost_usd = job.cuts.reduce((sum, c) => sum + (Number(c.estimated_cost_usd) || 0), 0) || null;

  const cuts = await listVideoPrompts({ projectId, beatId: beat._id });
  const blocked = job.cuts.filter((c) => c.status === 'blocked').length;
  const missingClips = cuts.filter((c) => !c.video_file_id).length;
  if (job.failed || blocked || missingClips || !cuts.length) {
    job.status = 'partial';
    job.assembly_skipped_reason = job.failed
      ? `${job.failed} cut${job.failed === 1 ? '' : 's'} failed`
      : blocked
        ? `${blocked} cut${blocked === 1 ? '' : 's'} missing inputs`
        : missingClips
          ? `${missingClips} cut${missingClips === 1 ? '' : 's'} without a clip`
          : 'no cuts';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: 'partial',
      step: 'assembly_skipped',
      message: `Beat video not assembled: ${job.assembly_skipped_reason}. Re-run "Render beat" to fill in the gaps.`,
    });
    return;
  }

  job.status = 'assembling';
  recordProgress(job, { phase: 'assembling', step: 'assemble_start', message: `Joining ${cuts.length} clips into the beat video…` });
  try {
    const { assemblePromptsBeatVideo } = await import('./cutAssemble.js');
    const scenes = await listVideoScenes({ projectId, beatId: beat._id });
    const { file, durationSeconds } = await assemblePromptsBeatVideo({
      projectId,
      beat,
      cuts,
      scenes,
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
    if (announceUsername) announceCutBeatVideo({ projectId, beat, fileId: file._id, username: announceUsername }).catch(() => {});
  } catch (e) {
    job.status = 'partial';
    job.assembly_skipped_reason = e?.message || String(e);
    job.finished_at = new Date();
    recordProgress(job, { phase: 'partial', step: 'assemble_failed', message: `Clips rendered but assembly failed: ${job.assembly_skipped_reason}` });
  }
}

async function announceCutBeatVideo({ projectId, beat, fileId, username }) {
  try {
    const { announceMediaEvent } = await import('../discord/announcer.js');
    const { promptsUrl } = await import('./links.js');
    const { stripMarkdown } = await import('../util/markdown.js');
    const { getProjectById } = await import('../mongo/projects.js');
    const project = projectId ? await getProjectById(projectId) : null;
    const name = stripMarkdown(beat.name || '').trim();
    const order = Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
    await announceMediaEvent({
      username,
      verb: 'rendered the beat video for',
      entityLabel: name ? `${order}: ${name}` : order,
      entityUrl: promptsUrl(project?.title ?? null, beat),
      mediaFileId: fileId,
      mediaLabel: 'beat video',
      prompt: null,
    });
  } catch (e) {
    logger.warn(`cut render announce failed: ${e?.message || e}`);
  }
}
