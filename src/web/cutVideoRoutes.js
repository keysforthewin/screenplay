// Cut video routes shared by both providers, mounted from entityRoutes.js:
//
//   POST   /cut/:id/fal-video/preview     fal.ai payload preview for a cut
//   POST   /cut/:id/fal-video/generate    202 fal.ai render of a cut
//   DELETE /cut/:id/video                 discard a cut's clip (either provider)
//   GET    /cut/:id/video-job/:jobId      job snapshot — ComfyUI registry first, then fal
//   GET    /cuts/candidates?beat_id=      the reference catalog the picker offers
//   + cutVideoJobEventsHandler, the pre-auth SSE for /cut/:id/video-job/:jobId/events
//
// The ComfyUI routes (POST /cut/:id/video/preview|generate) live in
// comfyRoutes.js — the two request bodies share nothing. A cut is a
// video_prompts row (src/mongo/videoPrompts.js); the fal path renders it
// through falVideoGenerate's video_prompt owner shim.

import { logger } from '../log.js';
import { resolveVideoRenderer } from './videoDefault.js';
import { getSession, touchSession } from '../mongo/auth.js';
import { getBeat } from '../mongo/plots.js';
import { getVideoPrompt } from '../mongo/videoPrompts.js';
import { deleteAttachment } from '../mongo/attachments.js';
import { ERR, parseResolutionField, parseFpsField } from './videoRouteParams.js';

const HEX24 = /^[a-f0-9]{24}$/i;

// Parse the shared body of the fal cut routes. Differences from the
// storyboard routes: no frame_assignment (the cut's start frame and ordered
// references ARE the assignment), duration up to 60 s (Seedance 2.5 renders
// 30 s; the model snaps anything longer), and generate_audio /
// include_director_notes default OFF — the block already folded the notes
// in, and real voices are recorded separately.
async function parseFalBody(req, res) {
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim() ? req.body.prompt.trim() : null;
  if (prompt && prompt.length > 2000) {
    res.status(400).json({ error: 'prompt must be ≤ 2000 chars' });
    return ERR;
  }
  const rawDuration = req.body?.duration_seconds;
  let durationSeconds = null;
  if (rawDuration != null && rawDuration !== '') {
    const n = Number(rawDuration);
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      res.status(400).json({ error: 'duration_seconds must be a number between 1 and 60' });
      return ERR;
    }
    durationSeconds = n;
  }
  let modelId = typeof req.body?.model_id === 'string' && req.body.model_id.trim() ? req.body.model_id.trim() : null;
  if (!modelId) {
    // The admin's default video renderer, when it is a fal.ai model.
    try {
      modelId = (await resolveVideoRenderer({ provider: 'fal' })).modelId;
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, code: e.code });
      return ERR;
    }
  }
  const generateAudio = Boolean(req.body?.generate_audio);
  const includeDirectorNotes = Boolean(req.body?.include_director_notes);
  const resolution = parseResolutionField(req.body?.resolution, res);
  if (resolution === ERR) return ERR;
  const fps = parseFpsField(req.body?.fps, res);
  if (fps === ERR) return ERR;
  return { prompt, durationSeconds, modelId, generateAudio, includeDirectorNotes, resolution, fps };
}

function sendFalRouteError(e, res) {
  if (e?.code === 'CUT_BUSY') return res.status(409).json({ error: e.message, code: e.code, job_id: e.job_id });
  if (e?.code === 'MISSING_INPUTS') return res.status(400).json({ error: e.message, missing: e.missing });
  if (e?.code === 'FAL_NOT_CONFIGURED') return res.status(503).json({ error: e.message });
  if (e?.code === 'UNKNOWN_MODEL') return res.status(400).json({ error: e.message });
  throw e;
}

// A cut's job by id across both registries, or null.
async function lookupCutJob(jobId) {
  const Comfy = await import('./comfyVideoGenerate.js');
  const comfy = Comfy.getComfyVideoJob(jobId);
  if (comfy) {
    return {
      provider: 'comfy',
      snapshot: () => Comfy.serializeComfyJob(Comfy.getComfyVideoJob(jobId) || comfy),
      subscribe: Comfy.subscribeToComfyJob,
      unsubscribe: Comfy.unsubscribeFromComfyJob,
    };
  }
  const Fal = await import('./falVideoGenerate.js');
  const fal = Fal.getVideoGenerationJob(jobId);
  if (fal) {
    return {
      provider: 'fal',
      snapshot: () => Fal.serializeJob(Fal.getVideoGenerationJob(jobId) || fal),
      subscribe: Fal.subscribeToJob,
      unsubscribe: Fal.unsubscribeFromJob,
    };
  }
  return null;
}

const isTerminal = (s) => s === 'done' || s === 'error';

// Pre-auth SSE (EventSource cannot set headers → session id in the query;
// the job id is the capability, the :id segment is ignored).
export const cutVideoJobEventsHandler = async (req, res, next) => {
  try {
    const sid = String(req.query?.session_id || '');
    if (!sid) {
      res.status(401).json({ error: 'missing session' });
      return;
    }
    const session = await getSession(sid);
    if (!session) {
      res.status(401).json({ error: 'invalid session' });
      return;
    }
    touchSession(sid).catch(() => {});
    req.session = session;

    const job = await lookupCutJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    const first = job.snapshot();
    res.write(`event: snapshot\ndata: ${JSON.stringify(first)}\n\n`);

    const listener = (snap) => {
      const terminal = isTerminal(snap.status);
      const eventName = terminal ? snap.status : 'update';
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(snap)}\n\n`);
      if (terminal) {
        job.unsubscribe(snap.job_id, listener);
        res.end();
      }
    };
    job.subscribe(req.params.jobId, listener);

    if (isTerminal(first.status)) {
      job.unsubscribe(req.params.jobId, listener);
      res.end();
      return;
    }
    const keepalive = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 20_000);
    keepalive.unref?.();
    req.on('close', () => {
      clearInterval(keepalive);
      job.unsubscribe(req.params.jobId, listener);
    });
  } catch (e) {
    next(e);
  }
};

export function registerCutFalVideoRoutes(router) {
  async function resolveCutId(req) {
    const { id } = req.params;
    if (!HEX24.test(String(id || ''))) return null;
    const cut = await getVideoPrompt(req.projectId, id);
    return cut?._id?.toString() || null;
  }

  router.get('/cuts/candidates', async (req, res, next) => {
    try {
      const beatRef = req.query.beat_id;
      if (beatRef == null || beatRef === '') return res.status(400).json({ error: 'beat_id required' });
      const beat = await getBeat(req.projectId, String(beatRef));
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { buildReferenceCatalog } = await import('./referenceCatalog.js');
      const catalog = await buildReferenceCatalog(req.projectId, beat);
      res.json({ beat_id: beat._id, candidates: catalog });
    } catch (e) {
      next(e);
    }
  });

  router.post('/cut/:id/fal-video/preview', async (req, res, next) => {
    try {
      const cutId = await resolveCutId(req);
      if (!cutId) return res.status(404).json({ error: 'cut not found' });
      const parsed = await parseFalBody(req, res);
      if (parsed === ERR) return;
      const Fal = await import('./falVideoGenerate.js');
      try {
        const preview = await Fal.buildVideoPayloadPreview({
          projectId: req.projectId,
          ...parsed,
          owner: { kind: Fal.OWNER_VIDEO_PROMPT, id: cutId },
        });
        res.json(preview);
      } catch (e) {
        return sendFalRouteError(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  router.post('/cut/:id/fal-video/generate', async (req, res, next) => {
    try {
      const cutId = await resolveCutId(req);
      if (!cutId) return res.status(404).json({ error: 'cut not found' });
      const parsed = await parseFalBody(req, res);
      if (parsed === ERR) return;
      const Fal = await import('./falVideoGenerate.js');
      try {
        const { job_id } = await Fal.startVideoGenerationJob({
          projectId: req.projectId,
          ...parsed,
          owner: { kind: Fal.OWNER_VIDEO_PROMPT, id: cutId },
          announceUsername: req?.session?.username || null,
        });
        res.status(202).json({ job_id });
      } catch (e) {
        return sendFalRouteError(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/cut/:id/video-job/:jobId', async (req, res, next) => {
    try {
      const job = await lookupCutJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job: job.snapshot() });
    } catch (e) {
      next(e);
    }
  });

  // Discard a cut's clip (either provider): clear the pointer, delete the
  // GridFS attachment (best-effort).
  router.delete('/cut/:id/video', async (req, res, next) => {
    try {
      const cutId = await resolveCutId(req);
      if (!cutId) return res.status(404).json({ error: 'cut not found' });
      const cut = await getVideoPrompt(req.projectId, cutId);
      const oldId = cut?.video_file_id || null;
      const { setVideoPromptVideoViaGateway } = await import('./gateway.js');
      const result = await setVideoPromptVideoViaGateway({ projectId: req.projectId, promptId: cutId, videoFileId: null });
      if (oldId) {
        try {
          await deleteAttachment(oldId);
        } catch (e) {
          logger.warn(`cut video delete: GridFS cleanup ${oldId} failed: ${e.message}`);
        }
      }
      res.json({ prompt: result, cut: result });
    } catch (e) {
      next(e);
    }
  });
}
