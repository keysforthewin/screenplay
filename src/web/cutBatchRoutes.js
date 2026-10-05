// Whole-beat video routes of the Scenes tab, mounted from entityRoutes.js:
//
//   POST /cuts/videos/generate-all     202 { batch } — render every cut that has both frames
//        { beat_id, provider: 'comfy'|'fal', model_id, skip_existing?,
//          params?, confirm_spend?            (ComfyUI)
//          resolution?, fps?, generate_audio? (fal.ai) }
//   GET  /cuts/videos/batch?beat_id=   { batch | null } — what the page polls
//   POST /cuts/videos/batch/cancel     { batch } — stop after the renders in flight
//   POST /cuts/videos/download         202 { job } — join every clip into one MP4 (ffmpeg)
//   GET  /cuts/videos/download/:jobId  { job }
//   GET  /cuts/videos/download/:jobId/file   the MP4
//
// The batch runner is cutVideoBatch.js, the ffmpeg join cutVideoJoin.js.

import fs from 'fs';
import { getBeat } from '../mongo/plots.js';
import { ComfyNotConfiguredError } from '../comfy/client.js';
import { ERR, parseResolutionField, parseFpsField } from './videoRouteParams.js';
import {
  BATCH_PROVIDERS,
  cancelCutVideoBatch,
  getCutVideoBatchForBeat,
  serializeCutBatch,
  startCutVideoBatch,
} from './cutVideoBatch.js';
import { getCutVideoJoinJob, serializeJoinJob, startCutVideoJoinJob } from './cutVideoJoin.js';

// The typed errors of both providers and of the batch itself → an HTTP answer.
function sendBatchError(e, res) {
  const body = { error: e.message };
  if (e.code) body.code = e.code;
  if (Array.isArray(e.errors)) body.errors = e.errors;
  if (Array.isArray(e.missing)) body.missing = e.missing;
  if (Number.isInteger(e?.status) && e.status >= 400 && e.status < 600) return res.status(e.status).json(body);
  if (e instanceof ComfyNotConfiguredError || e?.code === 'FAL_NOT_CONFIGURED' || e?.code === 'FFMPEG_MISSING') return res.status(503).json(body);
  if (e?.code === 'MISSING_INPUTS' || e?.code === 'UNKNOWN_MODEL') return res.status(400).json(body);
  return null;
}

export function registerCutBatchRoutes(router) {
  async function resolveBeat(req, ref) {
    if (ref == null || ref === '') return null;
    return getBeat(req.projectId, String(ref));
  }

  router.post('/cuts/videos/generate-all', async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.beat_id == null || body.beat_id === '') return res.status(400).json({ error: 'beat_id required' });
      if (!BATCH_PROVIDERS.includes(body.provider)) return res.status(400).json({ error: 'provider must be "comfy" or "fal"' });
      const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
      if (!modelId) return res.status(400).json({ error: 'model_id required' });
      const resolution = parseResolutionField(body.resolution, res);
      if (resolution === ERR) return;
      const fps = parseFpsField(body.fps, res);
      if (fps === ERR) return;
      try {
        const batch = await startCutVideoBatch({
          projectId: req.projectId,
          beatId: body.beat_id,
          provider: body.provider,
          modelId,
          params: body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {},
          confirmSpend: body.confirm_spend === true,
          resolution,
          fps,
          generateAudio: body.generate_audio === true,
          skipExisting: body.skip_existing !== false,
          announceUsername: req?.session?.username || null,
        });
        res.status(202).json({ batch: serializeCutBatch(batch) });
      } catch (e) {
        if (sendBatchError(e, res)) return;
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/cuts/videos/batch', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.query.beat_id);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      res.json({ batch: serializeCutBatch(getCutVideoBatchForBeat(beat._id.toString())) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/cuts/videos/batch/cancel', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.body?.beat_id);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const batch = await cancelCutVideoBatch(beat._id.toString());
      if (!batch) return res.status(404).json({ error: 'no batch for this beat' });
      res.json({ batch: serializeCutBatch(batch) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/cuts/videos/download', async (req, res, next) => {
    try {
      if (req.body?.beat_id == null || req.body.beat_id === '') return res.status(400).json({ error: 'beat_id required' });
      try {
        const job = await startCutVideoJoinJob({
          projectId: req.projectId,
          beatId: req.body.beat_id,
          projectTitle: req.projectTitle || '',
        });
        res.status(202).json({ job: serializeJoinJob(job) });
      } catch (e) {
        if (sendBatchError(e, res)) return;
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // A join job belongs to the project of its beat: an id from another
  // project is not found.
  async function resolveJoinJob(req) {
    const job = getCutVideoJoinJob(req.params.jobId);
    if (!job) return null;
    return (await getBeat(req.projectId, job.beat_id)) ? job : null;
  }

  router.get('/cuts/videos/download/:jobId', async (req, res, next) => {
    try {
      const job = await resolveJoinJob(req);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job: serializeJoinJob(job) });
    } catch (e) {
      next(e);
    }
  });

  router.get('/cuts/videos/download/:jobId/file', async (req, res, next) => {
    try {
      const job = await resolveJoinJob(req);
      if (!job) return res.status(404).json({ error: 'job not found' });
      if (job.status !== 'done') return res.status(409).json({ error: 'the video is not ready' });
      res.set({
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${job.filename}"`,
        ...(job.size ? { 'Content-Length': String(job.size) } : {}),
      });
      const stream = fs.createReadStream(job.path);
      stream.on('error', (e) => {
        if (res.headersSent) res.destroy(e);
        else next(e);
      });
      stream.pipe(res);
    } catch (e) {
      next(e);
    }
  });
}
