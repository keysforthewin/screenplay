// Bulk reference-image reassignment for a beat's storyboard frames.
//
// Wipes every frame's references and re-runs the SAME scored auto-suggest
// pipeline used by the per-frame "Auto-suggest" button (selectFrameReferencesForShot),
// applied to every frame in every storyboard of the beat. Status lives in an
// in-memory job map the SPA polls — same convention as the bulk start-frame
// generation job. Held under the per-beat lock so it can't race plan generation
// or per-frame edits.

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { listStoryboards } from '../mongo/storyboards.js';
import { getBeat } from '../mongo/plots.js';
import { selectFrameReferencesForShot, REFERENCE_LIST_MAX } from './frameReferences.js';
import { setStoryboardFrameReferenceImagesViaGateway } from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { BeatBusyError } from './storyboardGenerate.js';

const MAX_JOB_EVENTS = 100;
const jobs = new Map();

export function getReassignReferencesJob(jobId) {
  return jobs.get(jobId) || null;
}

function makeJobId() {
  return new ObjectId().toString();
}

function recordProgress(job, { phase, step, frame = null, total = null, message }) {
  if (!job) return;
  const ts = new Date();
  job.progress = { ts, phase, step, frame, total, message, started_at: ts };
  if (!Array.isArray(job.events)) job.events = [];
  job.events.push({ ts, phase, step, frame, total, message });
  if (job.events.length > MAX_JOB_EVENTS) {
    job.events.splice(0, job.events.length - MAX_JOB_EVENTS);
  }
}

// Compose the shot text the scorer sees for one frame — identical to the
// per-frame auto-populate endpoint (entityRoutes.js ~3910) so bulk and
// single-frame results match exactly.
export function buildFrameShotText(sb, frame) {
  return [sb?.summary, sb?.text_prompt, frame?.prompt]
    .map((s) => stripMarkdown(String(s || '')).trim())
    .filter(Boolean)
    .join('\n');
}

async function runReassignJob({ projectId, job, beatId }) {
  try {
    const storyboards = await listStoryboards({ beatId });
    const targets = [];
    for (const sb of storyboards) {
      for (const frame of sb.frames || []) targets.push({ sb, frame });
    }
    job.planned = targets.length;
    if (!targets.length) {
      job.status = 'done';
      job.finished_at = new Date();
      recordProgress(job, { phase: 'done', step: 'job_done_empty', message: 'No frames to reassign.' });
      return;
    }
    job.status = 'rendering';
    recordProgress(job, {
      phase: 'rendering', step: 'reassign_start', total: targets.length,
      message: `Reassigning references for ${targets.length} frame${targets.length === 1 ? '' : 's'}…`,
    });
    for (let index = 0; index < targets.length; index += 1) {
      const { sb, frame } = targets[index];
      const order = index + 1;
      try {
        const frameText = buildFrameShotText(sb, frame);
        const { ids, referenceScores } = await selectFrameReferencesForShot({
          projectId, sb, frameText, maxTotal: REFERENCE_LIST_MAX,
        });
        // mode 'replace' wipes the prior refs/scores AND writes the new set in
        // one atomic step — even when ids is empty (the requested "remove all
        // references" behavior).
        await setStoryboardFrameReferenceImagesViaGateway({
          projectId, storyboardId: sb._id, frameId: frame._id,
          imageIds: ids, mode: 'replace', scores: referenceScores,
        });
        job.completed += 1;
        recordProgress(job, {
          phase: 'rendering', step: 'frame_done', frame: order, total: targets.length,
          message: `Frame ${order}/${targets.length}: ${ids.length} reference${ids.length === 1 ? '' : 's'}`,
        });
      } catch (e) {
        job.failed += 1;
        recordProgress(job, {
          phase: 'rendering', step: 'frame_failed', frame: order, total: targets.length,
          message: `Frame ${order}/${targets.length}: failed — ${e.message}`,
        });
        logger.warn(`reassign refs ${job.job_id} frame ${order} failed: ${e.message}`);
      }
    }
    job.status = job.failed > 0 ? 'partial' : 'done';
    job.finished_at = new Date();
    recordProgress(job, {
      phase: job.status, step: 'job_done',
      message: `Done — ${job.completed} reassigned${job.failed ? `, ${job.failed} failed` : ''}.`,
    });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'job_crashed', message: `Reassign crashed: ${e.message}` });
    logger.error(`reassign refs job ${job.job_id} crashed: ${e.message}`);
  }
}

// Start a background reassignment job. Returns { job_id, planned, beat_id }
// immediately. Throws BeatBusyError if the beat is locked.
export async function startReassignReferencesJob({ projectId, beatId }) {
  const beat = await getBeat(projectId, beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());

  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    beat_id: beat._id.toString(),
    project_id: projectId,
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    planned: 0,
    completed: 0,
    failed: 0,
    progress: null,
    events: [],
  };
  jobs.set(jobId, job);
  recordProgress(job, { phase: 'queued', step: 'job_queued', message: 'Queued reference reassignment…' });

  withBeatLock(beat._id, () => runReassignJob({ projectId, job, beatId: beat._id })).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    recordProgress(job, { phase: 'error', step: 'job_crashed', message: `Reassign crashed: ${e.message}` });
    logger.error(`reassign refs job ${jobId} crashed (outer): ${e.message}`);
  });

  return { job_id: jobId, planned: 0, beat_id: beat._id.toString() };
}
