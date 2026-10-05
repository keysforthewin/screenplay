// cutRoutes.js
//
// REST surface of the Scenes tab: a beat's scenes, their cuts, and each cut's
// start and end frame.
//
//   GET    /video-scenes?beat_id=            { beat, scenes:[{…, cuts}] }
//   POST   /video-scene {beat_id, title?}    append a scene
//   DELETE /video-scene/:id                  the scene and its cuts
//   POST   /video-scenes/reorder {beat_id, ordered_ids}
//   POST   /cut {scene_id}                   append a cut to a scene
//   PATCH  /cut/:id {duration_seconds}
//   DELETE /cut/:id
//   POST   /cuts/reorder {scene_id, ordered_ids}
//   POST   /cut/:id/{start,end}-frame/generate {image_model?, comfy_params?}  202 {job_id}
//   PATCH  /cut/:id/{start,end}-frame {reference_ids}
//   DELETE /cut/:id/{start,end}-frame        the rendered image (prompt + references kept)
//   POST   /cut/:id/{start,end}-frame/undo
//   GET    /cuts/frames/job/:jobId
//   GET    /cuts/jobs?beat_id=               { frames, comfy_videos } — reattach
//
// Names and prompts are y-doc fragments of the video_prompts:<beatId> room,
// not REST fields. Cut VIDEO routes live elsewhere: ComfyUI in comfyRoutes.js,
// fal + the shared job lookup + /cuts/candidates in cutVideoRoutes.js.

import { getBeat } from '../mongo/plots.js';
import { MAX_REFERENCE_IMAGES, getVideoPrompt, listVideoPrompts } from '../mongo/videoPrompts.js';
import { getVideoScene, listVideoScenes } from '../mongo/videoScenes.js';
import { MAX_SCENE_TITLE, cleanIdList, isOidHex, isValidCutDuration } from './cutValidation.js';


function cleanImageModel(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null;
}

// Per-render parameters for a local ComfyUI image model (`comfy:<id>`):
// a flat object of scalars, validated against the model's own spec later.
function cleanComfyParams(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [key, value] of Object.entries(v).slice(0, 20)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = typeof value === 'string' ? value.slice(0, 4000) : value;
  }
  return Object.keys(out).length ? out : null;
}

export function registerCutRoutes(router) {
  async function resolveBeat(req, ref) {
    if (ref == null || ref === '') return null;
    return getBeat(req.projectId, String(ref));
  }

  async function resolveCut(req) {
    const { id } = req.params;
    if (!isOidHex(id)) return null;
    return getVideoPrompt(req.projectId, id);
  }

  async function resolveScene(req, id = req.params.id) {
    if (!isOidHex(id)) return null;
    return getVideoScene(req.projectId, id);
  }

  router.get('/video-scenes', async (req, res, next) => {
    try {
      if (req.query.beat_id == null || req.query.beat_id === '') return res.status(400).json({ error: 'beat_id required' });
      const beat = await resolveBeat(req, req.query.beat_id);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const [scenes, cuts] = await Promise.all([
        listVideoScenes({ projectId: req.projectId, beatId: beat._id }),
        listVideoPrompts({ projectId: req.projectId, beatId: beat._id }),
      ]);
      const byScene = new Map(scenes.map((s) => [String(s._id), []]));
      for (const c of cuts) byScene.get(String(c.scene_id))?.push(c);
      res.json({
        beat: { _id: beat._id, order: beat.order, name: beat.name },
        scenes: scenes.map((s) => ({
          ...s,
          cuts: byScene.get(String(s._id)).sort((a, b) => (a.cut_index ?? 0) - (b.cut_index ?? 0)),
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  // ── Scenes ────────────────────────────────────────────────────────────────

  router.post('/video-scene', async (req, res, next) => {
    try {
      const body = req.body || {};
      const beat = await resolveBeat(req, body.beat_id);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { createVideoSceneViaGateway } = await import('./gateway.js');
      const scene = await createVideoSceneViaGateway({
        projectId: req.projectId,
        beatId: beat._id.toString(),
        title: typeof body.title === 'string' ? body.title.slice(0, MAX_SCENE_TITLE) : '',
      });
      res.status(201).json({ scene });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/video-scene/:id', async (req, res, next) => {
    try {
      const scene = await resolveScene(req);
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const { deleteVideoSceneViaGateway } = await import('./gateway.js');
      res.json(await deleteVideoSceneViaGateway({ projectId: req.projectId, sceneId: String(scene._id) }));
    } catch (e) {
      next(e);
    }
  });

  router.post('/video-scenes/reorder', async (req, res, next) => {
    try {
      const body = req.body || {};
      const beat = await resolveBeat(req, body.beat_id);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const ids = cleanIdList(body.ordered_ids);
      if (!ids) return res.status(400).json({ error: 'ordered_ids must be an array of scene ids' });
      const { reorderVideoScenesViaGateway } = await import('./gateway.js');
      try {
        const scenes = await reorderVideoScenesViaGateway({ projectId: req.projectId, beatId: beat._id.toString(), orderedIds: ids });
        res.json({ scenes });
      } catch (e) {
        if (/^reorder:/.test(e?.message || '')) return res.status(400).json({ error: e.message });
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // ── Cuts ──────────────────────────────────────────────────────────────────

  router.post('/cut', async (req, res, next) => {
    try {
      const scene = await resolveScene(req, String(req.body?.scene_id || ''));
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const { createVideoPromptViaGateway } = await import('./gateway.js');
      const cut = await createVideoPromptViaGateway({ projectId: req.projectId, sceneId: String(scene._id) });
      res.status(201).json({ cut });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/cut/:id', async (req, res, next) => {
    try {
      const cut = await resolveCut(req);
      if (!cut) return res.status(404).json({ error: 'cut not found' });
      const body = req.body || {};
      if (!Object.prototype.hasOwnProperty.call(body, 'duration_seconds')) {
        return res.status(400).json({ error: 'duration_seconds required' });
      }
      const raw = body.duration_seconds;
      if (!isValidCutDuration(raw)) {
        return res.status(400).json({ error: 'duration_seconds must be a positive number of seconds or null' });
      }
      const { setVideoPromptDurationViaGateway } = await import('./gateway.js');
      const updated = await setVideoPromptDurationViaGateway({
        projectId: req.projectId,
        promptId: String(cut._id),
        durationSeconds: raw === '' ? null : raw,
      });
      res.json({ cut: updated });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/cut/:id', async (req, res, next) => {
    try {
      const cut = await resolveCut(req);
      if (!cut) return res.status(404).json({ error: 'cut not found' });
      const { deleteVideoPromptViaGateway } = await import('./gateway.js');
      res.json(await deleteVideoPromptViaGateway({ projectId: req.projectId, promptId: String(cut._id) }));
    } catch (e) {
      next(e);
    }
  });

  router.post('/cuts/reorder', async (req, res, next) => {
    try {
      const body = req.body || {};
      const scene = await resolveScene(req, String(body.scene_id || ''));
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const ids = cleanIdList(body.ordered_ids);
      if (!ids) return res.status(400).json({ error: 'ordered_ids must be an array of cut ids' });
      const { reorderCutsInSceneViaGateway } = await import('./gateway.js');
      try {
        const cuts = await reorderCutsInSceneViaGateway({ projectId: req.projectId, sceneId: String(scene._id), orderedIds: ids });
        res.json({ cuts });
      } catch (e) {
        if (/^reorder:/.test(e?.message || '')) return res.status(400).json({ error: e.message });
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  // ── Frames ────────────────────────────────────────────────────────────────
  // Once for the start frame and once for the end frame
  // (/cut/:id/start-frame/… and /cut/:id/end-frame/…).
  for (const frame of ['start', 'end']) {
    const key = frame === 'end' ? 'end_frame' : 'start_frame';

    router.post(`/cut/:id/${frame}-frame/generate`, async (req, res, next) => {
      try {
        const cut = await resolveCut(req);
        if (!cut) return res.status(404).json({ error: 'cut not found' });
        const body = req.body || {};
        const { startCutFrameJob } = await import('./cutFrames.js');
        try {
          const jobId = await startCutFrameJob({
            projectId: req.projectId,
            cutId: String(cut._id),
            frame,
            imageModel: cleanImageModel(body.image_model),
            comfyParams: cleanComfyParams(body.comfy_params),
          });
          res.status(202).json({ job_id: jobId, cut_id: cut._id, frame });
        } catch (e) {
          if (e?.code === 'CUT_BUSY') return res.status(409).json({ error: e.message, code: e.code, job_id: e.job_id });
          if (e?.code === 'BAD_FRAME_INPUT') return res.status(400).json({ error: e.message });
          throw e;
        }
      } catch (e) {
        next(e);
      }
    });

    // Replace the frame's ordered reference list (image ids) without
    // rendering. The prompt text is a y-doc fragment.
    router.patch(`/cut/:id/${frame}-frame`, async (req, res, next) => {
      try {
        const cut = await resolveCut(req);
        if (!cut) return res.status(404).json({ error: 'cut not found' });
        const ids = cleanIdList(req.body?.reference_ids);
        if (!ids) return res.status(400).json({ error: 'reference_ids must be an array of image ids' });
        const { setVideoPromptStartFrameViaGateway } = await import('./gateway.js');
        const updated = await setVideoPromptStartFrameViaGateway({
          projectId: req.projectId,
          promptId: String(cut._id),
          frame,
          startFrame: { ...(cut[key] || {}), prompt: undefined, reference_ids: [...new Set(ids)].slice(0, MAX_REFERENCE_IMAGES) },
        });
        res.json({ cut: updated });
      } catch (e) {
        next(e);
      }
    });

    router.delete(`/cut/:id/${frame}-frame`, async (req, res, next) => {
      try {
        const cut = await resolveCut(req);
        if (!cut) return res.status(404).json({ error: 'cut not found' });
        const { clearCutFrame } = await import('./cutFrames.js');
        res.json({ cut: await clearCutFrame({ projectId: req.projectId, cut, frame }) });
      } catch (e) {
        next(e);
      }
    });

    router.post(`/cut/:id/${frame}-frame/undo`, async (req, res, next) => {
      try {
        const cut = await resolveCut(req);
        if (!cut) return res.status(404).json({ error: 'cut not found' });
        if (!cut[key]?.previous_image_id) return res.status(400).json({ error: 'nothing to undo' });
        const { undoVideoPromptStartFrameViaGateway } = await import('./gateway.js');
        let updated = await undoVideoPromptStartFrameViaGateway({ projectId: req.projectId, promptId: String(cut._id), frame });
        if (frame === 'start') {
          const { repointStartFrameReference } = await import('./cutFrames.js');
          updated = await repointStartFrameReference({ projectId: req.projectId, cut: updated, from: cut.start_frame.image_id });
        }
        res.json({ cut: updated });
      } catch (e) {
        next(e);
      }
    });
  }

  router.get('/cuts/frames/job/:jobId', async (req, res, next) => {
    try {
      const { getCutFrameJob, serializeCutFrameJob } = await import('./cutFrames.js');
      const job = getCutFrameJob(String(req.params.jobId));
      if (!job) return res.status(404).json({ error: 'job not found' });
      const cut = await getVideoPrompt(req.projectId, job.cut_id);
      if (!cut) return res.status(404).json({ error: 'job not found' });
      res.json(serializeCutFrameJob(job));
    } catch (e) {
      next(e);
    }
  });

  // What is still running for this beat — a page that has just opened shows
  // it and follows it. Frame jobs and queued / running ComfyUI video jobs.
  router.get('/cuts/jobs', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.query.beat_id);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const [{ listCutFrameJobsForBeat }, comfy] = await Promise.all([
        import('./cutFrames.js'),
        import('./comfyVideoGenerate.js'),
      ]);
      res.json({
        frames: listCutFrameJobsForBeat(beat._id.toString()),
        comfy_videos: comfy.listComfyCutJobsForBeat(beat._id.toString()),
      });
    } catch (e) {
      next(e);
    }
  });
}
