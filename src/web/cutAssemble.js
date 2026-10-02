// Assemble the Prompts tab's rendered cut clips into MP4s: one per SCENE
// (video_scenes.video_*) and one per BEAT (beats.$.prompts_video_*, kept apart
// from the Storyboard tab's video_* so the two tabs never overwrite each
// other's MP4). The ffmpeg work is beatAssemble.js#assembleClips (normalize →
// concat → upload); this module does the cut bookkeeping, the persistence
// through the gateway and the background job wrapper the routes and the agent
// tools use.
//
// Assembled MP4s are cleared by the gateway whenever the cut SET changes (a
// cut or scene deleted or reordered, the beat wiped) — see
// gateway.js#clearAssembledVideosForBeat. A single cut re-render keeps them.

import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { listVideoPrompts } from '../mongo/videoPrompts.js';
import { listVideoScenes } from '../mongo/videoScenes.js';
import { assembleClips } from './beatAssemble.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { trimPolicyForCut } from './cutTiming.js';
import { setBeatPromptsVideoViaGateway, setVideoSceneVideoViaGateway } from './gateway.js';

export class CutAssembleError extends Error {
  constructor(message, { missing = [] } = {}) {
    super(message);
    this.name = 'CutAssembleError';
    this.code = 'CUT_ASSEMBLE_INPUT';
    this.status = 400;
    this.missing = missing;
  }
}

export class BeatBusyError extends Error {
  constructor(beatId) {
    super(`Beat ${beatId} has render work in progress — try again when it finishes.`);
    this.name = 'BeatBusyError';
    this.code = 'BEAT_BUSY';
    this.status = 409;
  }
}

export class SceneNotFoundError extends Error {
  constructor(sceneId) {
    super(`Video scene not found: ${sceneId}`);
    this.name = 'SceneNotFoundError';
    this.code = 'SCENE_NOT_FOUND';
    this.status = 404;
  }
}

// "2.3" for cut 3 of scene 2 (what the SPA shows); "#7" for an unsorted row
// (beat-wide order).
export function cutLabel(cut, sceneOrderById = new Map()) {
  const sceneOrder = cut.scene_id ? sceneOrderById.get(String(cut.scene_id)) : null;
  if (sceneOrder != null && cut.cut_index != null) return `${sceneOrder}.${cut.cut_index}`;
  return `#${cut.order ?? '?'}`;
}

function sceneOrderMap(scenes) {
  return new Map((scenes || []).map((s) => [String(s._id), s.order]));
}

function sortSceneCuts(cuts) {
  return [...cuts].sort(
    (a, b) => (a.cut_index ?? a.order ?? 0) - (b.cut_index ?? b.order ?? 0) || (a.order ?? 0) - (b.order ?? 0),
  );
}

// Every cut needs a rendered clip; the error names the missing ones by label
// so the route (400) and the agent can say which.
function requireClips(cuts, labelFor, unit) {
  if (!cuts.length) throw new CutAssembleError(`No cuts to assemble for this ${unit}.`);
  const missing = cuts.filter((c) => !c.video_file_id).map(labelFor);
  if (missing.length) {
    throw new CutAssembleError(
      `${missing.length} cut${missing.length === 1 ? '' : 's'} without a rendered clip (cut ${missing.join(', ')}).`,
      { missing },
    );
  }
}

// Join one scene's cut clips (cut_index order) into the scene MP4.
export async function assembleSceneVideo({ projectId, scene, cuts, onProgress = null }) {
  const rows = sortSceneCuts(cuts || []);
  const labelFor = (c) => `${scene.order}.${c.cut_index ?? '?'}`;
  requireClips(rows, labelFor, 'scene');
  const clips = rows.map((c, i) => ({
    order: i,
    video_file_id: c.video_file_id,
    video_duration_seconds: c.video_duration_seconds,
    label: labelFor(c),
    trim: trimPolicyForCut(c),
  }));
  const { file, durationSeconds, clipCount } = await assembleClips({
    projectId,
    clips,
    ownerId: scene.beat_id,
    filename: `scene-${scene._id}-video-${Date.now()}.mp4`,
    generatedBy: 'scene-assemble',
    label: 'cut',
    onProgress,
  });
  const updated = await setVideoSceneVideoViaGateway({ projectId, sceneId: scene._id, fileId: file._id, durationSeconds });
  logger.info(`scene assemble: scene=${scene._id} clips=${clipCount} file=${file._id} duration=${durationSeconds ?? '?'}s`);
  return { file, durationSeconds, clipCount, scene: updated };
}

// Join every cut clip of the beat (beat-wide `order`: scene order, then cut
// index, then unsorted rows) into the Prompts-tab beat MP4.
export async function assemblePromptsBeatVideo({ projectId, beat, cuts, scenes = [], onProgress = null }) {
  const byScene = sceneOrderMap(scenes);
  const rows = [...(cuts || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const labelFor = (c) => cutLabel(c, byScene);
  requireClips(rows, labelFor, 'beat');
  const clips = rows.map((c, i) => ({
    order: i,
    video_file_id: c.video_file_id,
    video_duration_seconds: c.video_duration_seconds,
    label: labelFor(c),
    trim: trimPolicyForCut(c),
  }));
  const { file, durationSeconds, clipCount } = await assembleClips({
    projectId,
    clips,
    ownerId: beat._id,
    filename: `beat-${beat._id}-prompts-video-${Date.now()}.mp4`,
    generatedBy: 'prompts-beat-assemble',
    label: 'cut',
    onProgress,
  });
  const updated = await setBeatPromptsVideoViaGateway({ projectId, beatId: beat._id, fileId: file._id, durationSeconds });
  logger.info(`prompts beat assemble: beat=${beat._id} clips=${clipCount} file=${file._id} duration=${durationSeconds ?? '?'}s`);
  return { file, durationSeconds, clipCount, beat: updated };
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

const jobs = new Map();
const JOB_RETENTION_MS = 60 * 60 * 1000;

export function getCutAssembleJob(jobId) {
  return jobs.get(jobId) || null;
}

// Beat-level assembly only: scene assemblies are watched by their SceneCard.
export async function findCutAssembleJobForBeat(beatId) {
  const { latestJobForBeat } = await import('./jobLookup.js');
  return latestJobForBeat(jobs, beatId, { filter: (j) => !j.scene_id });
}

function newJob({ beatId, sceneId }) {
  const job = {
    job_id: new ObjectId().toString(),
    kind: 'assemble',
    beat_id: String(beatId),
    scene_id: sceneId ? String(sceneId) : null,
    status: 'queued',
    phase: 'queued',
    video_file_id: null,
    video_duration_seconds: null,
    error: null,
    started_at: new Date(),
    finished_at: null,
  };
  jobs.set(job.job_id, job);
  const t = setTimeout(() => jobs.delete(job.job_id), JOB_RETENTION_MS);
  t.unref?.();
  return job;
}

// Assemble a scene (sceneId) or the whole beat. Inputs are validated before
// the job exists, so a cut without a clip is a synchronous 400 and a locked
// beat a 409; the ffmpeg work then runs under the beat lock in the background.
export async function startCutAssembleJob({ projectId, beatId, sceneId = null }) {
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  const [scenes, cuts] = await Promise.all([
    listVideoScenes({ projectId, beatId: beat._id }),
    listVideoPrompts({ projectId, beatId: beat._id }),
  ]);
  let scene = null;
  if (sceneId) {
    scene = scenes.find((s) => String(s._id) === String(sceneId)) || null;
    if (!scene) throw new SceneNotFoundError(sceneId);
  }
  const byScene = sceneOrderMap(scenes);
  if (scene) {
    const sceneCuts = sortSceneCuts(cuts.filter((c) => c.scene_id && String(c.scene_id) === String(scene._id)));
    requireClips(sceneCuts, (c) => `${scene.order}.${c.cut_index ?? '?'}`, 'scene');
  } else {
    requireClips(cuts, (c) => cutLabel(c, byScene), 'beat');
  }
  const job = newJob({ beatId: beat._id, sceneId: scene?._id || null });
  withBeatLock(beat._id, async () => {
    job.status = 'running';
    job.phase = 'assembling';
    const onProgress = (message) => {
      job.phase = message;
    };
    try {
      // Re-read under the lock so a clip rendered between the check and the
      // job start is the one joined.
      const fresh = await listVideoPrompts({ projectId, beatId: beat._id });
      const r = scene
        ? await assembleSceneVideo({
            projectId,
            scene,
            cuts: fresh.filter((c) => c.scene_id && String(c.scene_id) === String(scene._id)),
            onProgress,
          })
        : await assemblePromptsBeatVideo({ projectId, beat, cuts: fresh, scenes, onProgress });
      job.video_file_id = String(r.file._id);
      job.video_duration_seconds = r.durationSeconds;
      job.status = 'done';
      job.phase = 'done';
    } catch (e) {
      job.status = 'error';
      job.phase = 'error';
      job.error = e?.message || String(e);
      logger.error(`cut assemble job ${job.job_id} failed: ${job.error}`);
    } finally {
      job.finished_at = new Date();
    }
  }).catch((e) => {
    job.status = 'error';
    job.phase = 'error';
    job.error = e?.message || String(e);
    job.finished_at = new Date();
  });
  return job.job_id;
}

export function _clearCutAssembleJobsForTests() {
  jobs.clear();
}
