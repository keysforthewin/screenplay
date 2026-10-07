// cutRoutes.js
//
// REST surface of the Scenes tab: a beat's scenes, their cuts, and each cut's
// start and end frame.
//
//   GET    /video-scenes?beat_id=            { beat, scenes:[{…, cuts}] }
//   POST   /video-scene {beat_id, title?}    append a scene
//   DELETE /video-scene/:id                  the scene and its cuts
//   DELETE /video-scenes?beat_id=            every scene of the beat with its cuts
//   POST   /video-scenes/reorder {beat_id, ordered_ids}
//   POST   /cut {scene_id}                   append a cut to a scene
//   PATCH  /cut/:id {duration_seconds}
//   DELETE /cut/:id
//   POST   /cuts/reorder {scene_id, ordered_ids}
//   POST   /cut/:id/{start,end}-frame/generate {image_model?, comfy_params?}  202 {job_id}
//   PATCH  /cut/:id/{start,end}-frame {reference_ids}
//   DELETE /cut/:id/{start,end}-frame        the rendered image (prompt + references kept)
//   POST   /cut/:id/{start,end}-frame/undo
//   POST   /cut/:id/keyframe {at_seconds, strength?, prompt?, reference_ids?}   201 {cut, keyframe_id}
//   PATCH  /cut/:id/keyframe/:kid {at_seconds?, strength?, reference_ids?}
//   DELETE /cut/:id/keyframe/:kid            the keyframe with its images
//   POST   /cut/:id/keyframe/:kid/generate   202 {job_id}   (frame key "kf:<kid>")
//   DELETE /cut/:id/keyframe/:kid/image      the rendered image (entry kept)
//   POST   /cut/:id/keyframe/:kid/undo
//   GET    /cuts/frames/job/:jobId
//   GET    /cuts/jobs?beat_id=               { frames, comfy_videos } — reattach
//
// Names and prompts are y-doc fragments of the video_prompts:<beatId> room,
// not REST fields. Cut VIDEO routes live elsewhere: ComfyUI in comfyRoutes.js,
// fal + the shared job lookup + /cuts/candidates in cutVideoRoutes.js.

import { getBeat } from '../mongo/plots.js';
import { MAX_REFERENCE_IMAGES, getVideoPrompt, listVideoPrompts } from '../mongo/videoPrompts.js';
import { getVideoScene, listVideoScenes } from '../mongo/videoScenes.js';
import { MAX_SCENE_TITLE, cleanIdList, isOidHex, isValidCutDuration, isValidKeyframeTime, isValidStrength } from './cutValidation.js';


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

  // Every scene of the beat, with every cut and its media.
  router.delete('/video-scenes', async (req, res, next) => {
    try {
      const beatRef = req.query.beat_id ?? req.body?.beat_id;
      if (beatRef == null || beatRef === '') return res.status(400).json({ error: 'beat_id required' });
      const beat = await resolveBeat(req, beatRef);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { deleteAllVideoScenesViaGateway } = await import('./gateway.js');
      res.json(await deleteAllVideoScenesViaGateway({ projectId: req.projectId, beatId: beat._id.toString() }));
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
  // The four frame handlers take a FRAME KEY ('start' | 'end' | 'kf:<id>')
  // and are mounted once per start/end frame path and once per keyframe path.

  // The cut and the frame the request names; answers 404 itself when either
  // is missing and returns null.
  async function resolveFrame(req, res, frameKey) {
    const cut = await resolveCut(req);
    if (!cut) {
      res.status(404).json({ error: 'cut not found' });
      return null;
    }
    const key = typeof frameKey === 'function' ? frameKey(req) : frameKey;
    const { getCutFrame } = await import('./gateway.js');
    if (key.startsWith('kf:') && !getCutFrame(cut, key)) {
      res.status(404).json({ error: 'keyframe not found' });
      return null;
    }
    return { cut, frame: key, sub: getCutFrame(cut, key) };
  }

  async function generateFrame(req, res, next, frameKey) {
    try {
      const r = await resolveFrame(req, res, frameKey);
      if (!r) return;
      const body = req.body || {};
      const { startCutFrameJob } = await import('./cutFrames.js');
      try {
        const jobId = await startCutFrameJob({
          projectId: req.projectId,
          cutId: String(r.cut._id),
          frame: r.frame,
          imageModel: cleanImageModel(body.image_model),
          comfyParams: cleanComfyParams(body.comfy_params),
        });
        res.status(202).json({ job_id: jobId, cut_id: r.cut._id, frame: r.frame });
      } catch (e) {
        if (e?.code === 'CUT_BUSY') return res.status(409).json({ error: e.message, code: e.code, job_id: e.job_id });
        if (e?.code === 'BAD_FRAME_INPUT') return res.status(400).json({ error: e.message });
        throw e;
      }
    } catch (e) {
      next(e);
    }
  }

  // Replace the frame's ordered reference list (image ids) without
  // rendering. The prompt text is a y-doc fragment.
  async function patchFrameReferences(req, res, next, frameKey) {
    try {
      const r = await resolveFrame(req, res, frameKey);
      if (!r) return;
      const ids = cleanIdList(req.body?.reference_ids);
      if (!ids) return res.status(400).json({ error: 'reference_ids must be an array of image ids' });
      const { setVideoPromptStartFrameViaGateway } = await import('./gateway.js');
      const updated = await setVideoPromptStartFrameViaGateway({
        projectId: req.projectId,
        promptId: String(r.cut._id),
        frame: r.frame,
        startFrame: { ...(r.sub || {}), prompt: undefined, reference_ids: [...new Set(ids)].slice(0, MAX_REFERENCE_IMAGES) },
      });
      res.json({ cut: updated });
    } catch (e) {
      next(e);
    }
  }

  async function deleteFrameImage(req, res, next, frameKey) {
    try {
      const r = await resolveFrame(req, res, frameKey);
      if (!r) return;
      const { clearCutFrame } = await import('./cutFrames.js');
      res.json({ cut: await clearCutFrame({ projectId: req.projectId, cut: r.cut, frame: r.frame }) });
    } catch (e) {
      next(e);
    }
  }

  async function undoFrame(req, res, next, frameKey) {
    try {
      const r = await resolveFrame(req, res, frameKey);
      if (!r) return;
      if (!r.sub?.previous_image_id) return res.status(400).json({ error: 'nothing to undo' });
      const { undoVideoPromptStartFrameViaGateway } = await import('./gateway.js');
      let updated = await undoVideoPromptStartFrameViaGateway({ projectId: req.projectId, promptId: String(r.cut._id), frame: r.frame });
      if (r.frame === 'start') {
        const { repointStartFrameReference } = await import('./cutFrames.js');
        updated = await repointStartFrameReference({ projectId: req.projectId, cut: updated, from: r.cut.start_frame.image_id });
      }
      res.json({ cut: updated });
    } catch (e) {
      next(e);
    }
  }

  for (const frame of ['start', 'end']) {
    router.post(`/cut/:id/${frame}-frame/generate`, (req, res, next) => generateFrame(req, res, next, frame));
    router.patch(`/cut/:id/${frame}-frame`, (req, res, next) => patchFrameReferences(req, res, next, frame));
    router.delete(`/cut/:id/${frame}-frame`, (req, res, next) => deleteFrameImage(req, res, next, frame));
    router.post(`/cut/:id/${frame}-frame/undo`, (req, res, next) => undoFrame(req, res, next, frame));
  }

  // ── Keyframes ─────────────────────────────────────────────────────────────
  const kfKey = (req) => `kf:${String(req.params.kid)}`;

  router.post('/cut/:id/keyframe', async (req, res, next) => {
    try {
      const cut = await resolveCut(req);
      if (!cut) return res.status(404).json({ error: 'cut not found' });
      const body = req.body || {};
      if (!(cut.duration_seconds > 0)) return res.status(400).json({ error: 'set the cut’s length before adding keyframes' });
      if (!isValidKeyframeTime(body.at_seconds, cut.duration_seconds)) {
        return res.status(400).json({ error: `at_seconds must be between 0.5 and ${cut.duration_seconds - 0.5} seconds` });
      }
      if (!isValidStrength(body.strength)) return res.status(400).json({ error: 'strength must be between 0 and 1' });
      const ids = body.reference_ids === undefined ? [] : cleanIdList(body.reference_ids);
      if (!ids) return res.status(400).json({ error: 'reference_ids must be an array of image ids' });
      const { addVideoPromptKeyframeViaGateway } = await import('./gateway.js');
      const out = await addVideoPromptKeyframeViaGateway({
        projectId: req.projectId,
        promptId: String(cut._id),
        atSeconds: Number(body.at_seconds),
        strength: body.strength == null || body.strength === '' ? null : Number(body.strength),
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        referenceIds: [...new Set(ids)].slice(0, MAX_REFERENCE_IMAGES),
      });
      res.status(201).json({ cut: out.cut, keyframe_id: out.keyframe_id });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/cut/:id/keyframe/:kid', async (req, res, next) => {
    try {
      const r = await resolveFrame(req, res, kfKey);
      if (!r) return;
      const body = req.body || {};
      const patch = {};
      if (body.at_seconds !== undefined) {
        if (!isValidKeyframeTime(body.at_seconds, r.cut.duration_seconds)) {
          return res.status(400).json({ error: `at_seconds must be between 0.5 and ${(r.cut.duration_seconds || 0) - 0.5} seconds` });
        }
        patch.atSeconds = Number(body.at_seconds);
      }
      if (body.strength !== undefined) {
        if (!isValidStrength(body.strength)) return res.status(400).json({ error: 'strength must be between 0 and 1' });
        patch.strength = body.strength == null || body.strength === '' ? null : Number(body.strength);
      }
      if (body.reference_ids !== undefined) {
        const ids = cleanIdList(body.reference_ids);
        if (!ids) return res.status(400).json({ error: 'reference_ids must be an array of image ids' });
        patch.referenceIds = [...new Set(ids)].slice(0, MAX_REFERENCE_IMAGES);
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });
      const { updateVideoPromptKeyframeViaGateway } = await import('./gateway.js');
      const updated = await updateVideoPromptKeyframeViaGateway({
        projectId: req.projectId,
        promptId: String(r.cut._id),
        keyframeId: String(req.params.kid),
        ...patch,
      });
      res.json({ cut: updated });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/cut/:id/keyframe/:kid', async (req, res, next) => {
    try {
      const r = await resolveFrame(req, res, kfKey);
      if (!r) return;
      const { removeVideoPromptKeyframeViaGateway } = await import('./gateway.js');
      const updated = await removeVideoPromptKeyframeViaGateway({
        projectId: req.projectId,
        promptId: String(r.cut._id),
        keyframeId: String(req.params.kid),
      });
      res.json({ cut: updated });
    } catch (e) {
      next(e);
    }
  });

  router.post('/cut/:id/keyframe/:kid/generate', (req, res, next) => generateFrame(req, res, next, kfKey));
  router.delete('/cut/:id/keyframe/:kid/image', (req, res, next) => deleteFrameImage(req, res, next, kfKey));
  router.post('/cut/:id/keyframe/:kid/undo', (req, res, next) => undoFrame(req, res, next, kfKey));

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
