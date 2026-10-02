// src/web/cutRoutes.js
// REST surface of the Prompts tab's scene/cut model. Mounted on the main API
// router (after requireSession + requireProjectAccess) by entityRoutes.js:
//
//   GET    /video-scenes?beat_id=            scenes with their cuts (+ unsorted legacy rows)
//   POST   /video-scenes/generate            run the planner (202 job)        {beat_id, direction?, render_start_frames?, image_model?}
//   GET    /cuts/jobs?beat_id=               reattach: running / just-finished {plan, start_frames, assemble, render,
//                                           comfy_videos: [per-cut ComfyUI render jobs, queued/running/recent]}
//   GET    /video-scenes/generate/:jobId     planner / replan job snapshot (steps, events, live)
//          (pre-auth SSE twin: /video-scenes/generate/:jobId/events?session_id= in entityRoutes.js)
//   POST   /video-scene/:id/replan           re-plan ONE scene's cuts (202)   {direction?, render_start_frames?, image_model?}
//   POST   /cut/:id/replan                   regenerate ONE cut in place (202) {note?, render_start_frames?, image_model?}
//   PATCH  /video-scene/:id                  scalar scene fields
//   DELETE /video-scene/:id                  scene + its cuts
//   POST   /video-scenes/reorder             {beat_id, ordered_ids}
//   POST   /video-scenes/clear               {beat_id} — every scene and cut
//   POST   /cut                              blank cut {scene_id} (or {beat_id} for an unsorted row)
//   PATCH  /cut/:id                          structured cut fields (see PATCHABLE)
//   DELETE /cut/:id
//   POST   /cuts/reorder                     {scene_id, ordered_ids}
//   POST   /cut/:id/lint                     recompute the lint from the stored block
//   POST   /cut/:id/start-frame/generate     202 job {image_model?, prompt?, mode?, edit_prompt?, edit_reference_image_ids?, comfy_params?}
//          (every /cut/:id/start-frame… route has an /cut/:id/end-frame… twin for the cut's end frame)
//          (image_model `comfy:<id>` renders on the local ComfyUI; comfy_params are its width/height/steps/seed…)
//   POST   /cuts/start-frames/generate       202 job {beat_id, cut_ids?, frames?: ['start'|'end'], skip_rendered?, image_model?,
//                                            check?: bool — check + repair each finished pair (default: on when end frames are asked for)}
//   POST   /cut/:id/frames/check             202 job {repair?: bool, image_model?} — vision check of the cut's two stills;
//                                            with repair, fix what disagrees (≤ 2 rounds). 400 unless both frames are rendered.
//   GET    /cuts/start-frames/job/:jobId
//   POST   /cuts/start-frames/job/:jobId/cancel   stop after the renders in flight
//   PATCH  /cut/:id/start-frame            {reference_ids} — ordered artwork ids for the still
//   DELETE /cut/:id/start-frame
//   DELETE /cuts/start-frames?beat_id=&frames=start,end   every start/end frame of the beat (409 while a job holds it)
//   POST   /cut/:id/start-frame/undo
//   POST   /video-scene/:id/assemble         202 job — join the scene's cut clips into its MP4
//   POST   /video-scenes/assemble            202 job {beat_id} — join every cut clip into the beat's Prompts-tab MP4
//   GET    /cuts/assemble/job/:jobId
//   POST   /cuts/render/preview             plan + cost {beat_id, provider?, models?, params_by_model?, skip_rendered?}
//   POST   /cuts/render                     202 job — render every cut (lip-sync where recorded) then the beat MP4
//                                           {…preview body, confirm_spend?, image_model?}
//   GET    /cuts/render/job/:jobId          (+ pre-auth SSE /cuts/render/job/:jobId/events in entityRoutes.js)
//   DELETE /video-scene/:id/video            discard the scene MP4 (clips stay)
//   DELETE /video-scenes/video?beat_id=      discard the beat's Prompts-tab MP4
//
// Cut VIDEO routes live elsewhere: ComfyUI in comfyRoutes.js, fal + the shared
// job lookup + /cuts/candidates in cutVideoRoutes.js. Text edits flow through
// the video_prompts:<beatId> y-doc room.

import { listDialogs } from '../mongo/dialogs.js';
import { getBeat } from '../mongo/plots.js';
import { MAX_REFERENCE_IMAGES, getVideoPrompt, listVideoPrompts } from '../mongo/videoPrompts.js';
import { getVideoScene, listVideoScenes } from '../mongo/videoScenes.js';

const HEX24 = /^[a-f0-9]{24}$/i;
const isOidHex = (s) => typeof s === 'string' && HEX24.test(s);

const PATCHABLE = new Set([
  'camera', 'in_frame', 'action_by', 'reaction', 'eyeline', 'action', 'others', 'last_frame', 'sound',
  'sound_on_action', 'crossing', 'contact', 'dialog_ids', 'sets_in_scene', 'characters_in_scene',
  'primary_spend', 'felt_intent', 'duration_seconds', 'lock_line', 'exclusions', 'reference_binding',
  'trim_head_seconds', 'trim_tail_seconds',
]);
const SCENE_PATCHABLE = new Set(['title', 'slug', 'intention', 'tempo', 'directors_read', 'scope', 'set_names', 'character_names', 'text_span']);

function sendBusyOr(e, res) {
  if (e?.code === 'BEAT_BUSY') return res.status(409).json({ error: e.message });
  if (e?.code === 'CUT_NOT_FOUND' || e?.code === 'SCENE_NOT_FOUND') return res.status(404).json({ error: e.message });
  if (e?.code === 'BAD_START_FRAME_INPUT') return res.status(400).json({ error: e.message });
  if (e?.code === 'CUT_ASSEMBLE_INPUT') return res.status(400).json({ error: e.message, missing: e.missing || [] });
  if (e?.code === 'CUT_RENDER_EMPTY' || e?.code === 'UNKNOWN_PROVIDER') return res.status(400).json({ error: e.message, code: e.code });
  if (e?.code === 'SPEND_CONSENT_REQUIRED') return res.status(402).json({ error: e.message, code: e.code });
  if (e?.code === 'COMFY_NOT_CONFIGURED' || e?.code === 'FAL_NOT_CONFIGURED') return res.status(503).json({ error: e.message, code: e.code });
  throw e;
}

function cleanModels(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const k of ['lipsync', 'clip']) {
    if (typeof v[k] === 'string' && v[k].trim()) out[k] = v[k].trim().slice(0, 200);
  }
  return out;
}

function cleanParamsByModel(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, p] of Object.entries(v)) {
    if (p && typeof p === 'object' && !Array.isArray(p)) out[String(k).slice(0, 200)] = { ...p };
  }
  return out;
}

function cleanDirection(v) {
  return typeof v === 'string' ? v.slice(0, 4000) : '';
}

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

  async function resolveScene(req) {
    const { id } = req.params;
    if (!isOidHex(id)) return null;
    return getVideoScene(req.projectId, id);
  }

  router.get('/video-scenes', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.query.beat_id);
      if (req.query.beat_id == null || req.query.beat_id === '') return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const [scenes, cuts, dialogs] = await Promise.all([
        listVideoScenes({ projectId: req.projectId, beatId: beat._id }),
        listVideoPrompts({ projectId: req.projectId, beatId: beat._id }),
        listDialogs({ projectId: req.projectId, beatId: beat._id }).catch(() => []),
      ]);
      const byScene = new Map(scenes.map((s) => [String(s._id), []]));
      const unsorted = [];
      for (const c of cuts) {
        const k = c.scene_id ? String(c.scene_id) : null;
        if (k && byScene.has(k)) byScene.get(k).push(c);
        else unsorted.push(c);
      }
      const sortCuts = (arr) => arr.sort((a, b) => (a.cut_index ?? a.order ?? 0) - (b.cut_index ?? b.order ?? 0) || (a.order ?? 0) - (b.order ?? 0));
      res.json({
        beat: {
          _id: beat._id,
          order: beat.order,
          name: beat.name,
          characters: beat.characters || [],
          sets: beat.sets || [],
          prompts_video_file_id: beat.prompts_video_file_id || null,
          prompts_video_duration_seconds: beat.prompts_video_duration_seconds ?? null,
          prompts_video_generated_at: beat.prompts_video_generated_at || null,
        },
        scenes: scenes.map((s) => ({ ...s, cuts: sortCuts(byScene.get(String(s._id)) || []) })),
        unsorted: unsorted.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        dialogs: Array.isArray(dialogs) ? dialogs : [],
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/video-scenes/generate', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.body?.beat_id);
      if (!req.body?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { startCutPlanJob } = await import('./cutPlanner.js');
      try {
        const jobId = await startCutPlanJob({
          projectId: req.projectId,
          beatId: beat._id.toString(),
          direction: cleanDirection(req.body?.direction),
          renderStartFrames: Boolean(req.body?.render_start_frames),
          imageModel: cleanImageModel(req.body?.image_model),
        });
        res.status(202).json({ job_id: jobId, beat_id: beat._id });
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  // Reattach: the jobs a reopened Prompts page should pick up for this beat —
  // whatever is still running, else what finished in the last few minutes.
  // Jobs live in this process's memory and keep running with no watcher.
  router.get('/cuts/jobs', async (req, res, next) => {
    try {
      if (req.query.beat_id == null || req.query.beat_id === '') return res.status(400).json({ error: 'beat_id required' });
      const beat = await resolveBeat(req, req.query.beat_id);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const beatId = beat._id.toString();
      const [planner, frames, assemble, render, comfyVideo] = await Promise.all([
        import('./cutPlanner.js'),
        import('./cutStartFrames.js'),
        import('./cutAssemble.js'),
        import('./cutBeatRender.js'),
        import('./comfyVideoGenerate.js'),
      ]);
      const renderJob = await render.findCutBeatRenderJobForBeat(beatId);
      res.json({
        beat_id: beatId,
        plan: planner.serializeCutPlanJob(planner.findCutPlanJobForBeat(beatId)),
        start_frames: (await frames.findCutStartFrameJobForBeat(beatId)) || null,
        assemble: (await assemble.findCutAssembleJobForBeat(beatId)) || null,
        render: renderJob ? render.serializeCutBeatJob(renderJob) : null,
        comfy_videos: comfyVideo.listComfyCutJobsForBeat(beatId),
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/video-scenes/generate/:jobId', async (req, res, next) => {
    try {
      const { getCutPlanJob, serializeCutPlanJob } = await import('./cutPlanner.js');
      const job = getCutPlanJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job: serializeCutPlanJob(job) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/video-scene/:id/replan', async (req, res, next) => {
    try {
      const scene = await resolveScene(req);
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const { startSceneReplanJob } = await import('./cutPlanner.js');
      try {
        const jobId = await startSceneReplanJob({
          projectId: req.projectId,
          sceneId: String(scene._id),
          direction: cleanDirection(req.body?.direction),
          renderStartFrames: Boolean(req.body?.render_start_frames),
          imageModel: cleanImageModel(req.body?.image_model),
        });
        res.status(202).json({ job_id: jobId, scene_id: scene._id, beat_id: scene.beat_id });
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  // Regenerate ONE cut: table row, block, both still prompts, review. The
  // row is replaced in place; its frames and clip go with it.
  router.post('/cut/:id/replan', async (req, res, next) => {
    try {
      const cut = await resolveCut(req);
      if (!cut) return res.status(404).json({ error: 'cut not found' });
      if (!cut.scene_id) return res.status(400).json({ error: 'This cut belongs to no scene; replan a scene or auto generate instead.' });
      const { startCutReplanJob } = await import('./cutPlanner.js');
      try {
        const jobId = await startCutReplanJob({
          projectId: req.projectId,
          cutId: String(cut._id),
          note: cleanDirection(req.body?.note),
          renderStartFrames: Boolean(req.body?.render_start_frames),
          imageModel: cleanImageModel(req.body?.image_model),
        });
        res.status(202).json({ job_id: jobId, cut_id: cut._id, scene_id: cut.scene_id, beat_id: cut.beat_id });
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  router.patch('/video-scene/:id', async (req, res, next) => {
    try {
      const scene = await resolveScene(req);
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const body = req.body || {};
      const patch = {};
      for (const [k, v] of Object.entries(body)) {
        if (SCENE_PATCHABLE.has(k)) patch[k] = v;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: `nothing to update (allowed: ${[...SCENE_PATCHABLE].join(', ')})` });
      const { updateVideoSceneViaGateway } = await import('./gateway.js');
      const updated = await updateVideoSceneViaGateway({ projectId: req.projectId, sceneId: String(scene._id), patch });
      res.json({ scene: updated });
    } catch (e) {
      if (/must be|invalid|unknown field/i.test(e?.message || '')) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  router.delete('/video-scene/:id', async (req, res, next) => {
    try {
      const scene = await resolveScene(req);
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const { isBeatLocked } = await import('./beatLocks.js');
      if (isBeatLocked(scene.beat_id)) return res.status(409).json({ error: 'Work in progress for this beat; try again' });
      const { deleteVideoSceneViaGateway } = await import('./gateway.js');
      const result = await deleteVideoSceneViaGateway({ projectId: req.projectId, sceneId: String(scene._id) });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/video-scenes/reorder', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.body?.beat_id);
      if (!req.body?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const orderedIds = req.body?.ordered_ids;
      if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'ordered_ids must be an array' });
      const { reorderVideoScenesViaGateway } = await import('./gateway.js');
      const scenes = await reorderVideoScenesViaGateway({ projectId: req.projectId, beatId: beat._id, orderedIds });
      res.json({ scenes });
    } catch (e) {
      if (/reorder:/.test(e?.message || '')) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  router.post('/video-scenes/clear', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.body?.beat_id);
      if (!req.body?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { isBeatLocked } = await import('./beatLocks.js');
      if (isBeatLocked(beat._id)) return res.status(409).json({ error: 'Work in progress for this beat; try again' });
      const { deleteAllVideoScenesForBeatViaGateway } = await import('./gateway.js');
      const result = await deleteAllVideoScenesForBeatViaGateway({ projectId: req.projectId, beatId: beat._id });
      res.json({ ...result, beat_id: beat._id.toString() });
    } catch (e) {
      next(e);
    }
  });

  // A blank cut. With scene_id it joins that scene (last position); with only
  // beat_id it is an unsorted row (legacy-style).
  router.post('/cut', async (req, res, next) => {
    try {
      const body = req.body || {};
      let scene = null;
      let beat = null;
      if (body.scene_id) {
        if (!isOidHex(String(body.scene_id))) return res.status(400).json({ error: 'invalid scene_id' });
        scene = await getVideoScene(req.projectId, String(body.scene_id));
        if (!scene) return res.status(404).json({ error: 'scene not found' });
        beat = await getBeat(req.projectId, String(scene.beat_id));
      } else {
        beat = await resolveBeat(req, body.beat_id);
        if (!body.beat_id) return res.status(400).json({ error: 'scene_id or beat_id required' });
      }
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { createVideoPromptViaGateway } = await import('./gateway.js');
      let cutIndex = null;
      if (scene) {
        const siblings = await listVideoPrompts({ projectId: req.projectId, beatId: beat._id, sceneId: scene._id });
        cutIndex = siblings.length + 1;
      }
      const created = await createVideoPromptViaGateway({
        projectId: req.projectId,
        beatId: beat._id,
        title: String(body.title || ''),
        prompt: String(body.prompt || ''),
        sceneId: scene ? scene._id : null,
        cutIndex,
        setsInScene: scene ? scene.set_names || [] : [],
        recompute: Boolean(scene),
      });
      const cut = scene ? await getVideoPrompt(req.projectId, String(created._id)) : created;
      res.json({ cut });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/cut/:id', async (req, res, next) => {
    try {
      const cut = await resolveCut(req);
      if (!cut) return res.status(404).json({ error: 'cut not found' });
      const body = req.body || {};
      const patch = {};
      for (const [k, v] of Object.entries(body)) {
        if (PATCHABLE.has(k)) patch[k] = v;
      }
      const hasRefs = Object.prototype.hasOwnProperty.call(body, 'reference_image_ids');
      if (!Object.keys(patch).length && !hasRefs) {
        return res.status(400).json({ error: 'nothing to update' });
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'duration_seconds')) {
        const v = patch.duration_seconds;
        if (v == null || v === '') patch.duration_seconds = null;
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 1 || n > 60) return res.status(400).json({ error: 'duration_seconds must be a number between 1 and 60, or null' });
          patch.duration_seconds = Math.round(n * 2) / 2;
        }
      }
      // Hand-set trims for the assembly; null (or '') = automatic.
      for (const k of ['trim_head_seconds', 'trim_tail_seconds']) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
        const v = patch[k];
        if (v == null || v === '') patch[k] = null;
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 60) return res.status(400).json({ error: `${k} must be a number between 0 and 60, or null` });
          patch[k] = Math.round(n * 100) / 100;
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'dialog_ids')) {
        const ids = patch.dialog_ids;
        if (!Array.isArray(ids) || ids.some((x) => !isOidHex(String(x)))) return res.status(400).json({ error: 'dialog_ids must be an array of dialog ids' });
        const beatDialogs = await listDialogs({ projectId: req.projectId, beatId: cut.beat_id });
        const known = new Set(beatDialogs.map((d) => String(d._id)));
        for (const id of ids) {
          if (!known.has(String(id))) return res.status(400).json({ error: `dialog ${id} does not belong to this beat` });
        }
        // Script order, deduped.
        const order = new Map(beatDialogs.map((d, i) => [String(d._id), i]));
        patch.dialog_ids = [...new Set(ids.map(String))].sort((a, b) => order.get(a) - order.get(b));
      }
      if (hasRefs) {
        const ids = body.reference_image_ids;
        if (!Array.isArray(ids) || ids.some((x) => !isOidHex(String(x)))) return res.status(400).json({ error: 'reference_image_ids must be an array of image ids' });
        if (ids.length > MAX_REFERENCE_IMAGES) return res.status(400).json({ error: `at most ${MAX_REFERENCE_IMAGES} reference images per cut` });
        const beat = await getBeat(req.projectId, String(cut.beat_id));
        const { buildReferenceCatalog } = await import('./referenceCatalog.js');
        const catalog = beat ? await buildReferenceCatalog(req.projectId, beat) : [];
        const byId = new Map(catalog.map((e) => [e.image_id, e]));
        for (const r of cut.reference_images || []) {
          const k = String(r.image_id);
          if (!byId.has(k)) byId.set(k, { image_id: k, owner_type: r.owner_type, owner_name: r.owner_name, label: r.label });
        }
        const refs = [];
        for (const raw of ids) {
          const e = byId.get(String(raw));
          if (!e) return res.status(400).json({ error: `unknown reference image ${raw}` });
          refs.push({ image_id: e.image_id, owner_type: e.owner_type, owner_name: e.owner_name, label: e.label });
        }
        patch.reference_images = refs;
      }
      const { updateVideoPromptScalarsViaGateway } = await import('./gateway.js');
      const updated = await updateVideoPromptScalarsViaGateway({ projectId: req.projectId, promptId: String(cut._id), patch });
      res.json({ cut: updated });
    } catch (e) {
      if (/must be|invalid|unknown field/i.test(e?.message || '')) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  router.delete('/cut/:id', async (req, res, next) => {
    try {
      const cut = await resolveCut(req);
      if (!cut) return res.status(404).json({ error: 'cut not found' });
      const { deleteVideoPromptViaGateway } = await import('./gateway.js');
      const result = await deleteVideoPromptViaGateway({ projectId: req.projectId, promptId: String(cut._id) });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.post('/cuts/reorder', async (req, res, next) => {
    try {
      const sceneId = req.body?.scene_id;
      const orderedIds = req.body?.ordered_ids;
      if (!sceneId || !isOidHex(String(sceneId))) return res.status(400).json({ error: 'scene_id required' });
      if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'ordered_ids must be an array' });
      const scene = await getVideoScene(req.projectId, String(sceneId));
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const { reorderCutsInSceneViaGateway } = await import('./gateway.js');
      const cuts = await reorderCutsInSceneViaGateway({ projectId: req.projectId, sceneId: String(scene._id), orderedIds });
      res.json({ cuts });
    } catch (e) {
      if (/reorder:/.test(e?.message || '')) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  router.post('/cut/:id/lint', async (req, res, next) => {
    try {
      const cut = await resolveCut(req);
      if (!cut) return res.status(404).json({ error: 'cut not found' });
      const [{ lintCut }, { updateVideoPromptScalarsViaGateway }] = await Promise.all([
        import('./cutPromptLint.js'),
        import('./gateway.js'),
      ]);
      const dialogs = await listDialogs({ projectId: req.projectId, beatId: cut.beat_id }).catch(() => []);
      const byId = new Map(dialogs.map((d) => [String(d._id), d]));
      const covered = (cut.dialog_ids || []).map((id) => byId.get(String(id))).filter(Boolean);
      const lint = lintCut(cut, { coveredDialogs: covered });
      const updated = await updateVideoPromptScalarsViaGateway({ projectId: req.projectId, promptId: String(cut._id), patch: { lint } });
      res.json({ cut: updated, lint });
    } catch (e) {
      next(e);
    }
  });

  // Per-cut frame routes, once for the start frame and once for the end
  // frame (/cut/:id/start-frame/… and /cut/:id/end-frame/…).
  for (const frame of ['start', 'end']) {
    const key = frame === 'end' ? 'end_frame' : 'start_frame';
    router.post(`/cut/:id/${frame}-frame/generate`, async (req, res, next) => {
      try {
        const cut = await resolveCut(req);
        if (!cut) return res.status(404).json({ error: 'cut not found' });
        const body = req.body || {};
        const mode = body.mode === 'edit' ? 'edit' : 'generate';
        const { startSingleCutStartFrameJob } = await import('./cutStartFrames.js');
        try {
          const jobId = await startSingleCutStartFrameJob({
            projectId: req.projectId,
            cutId: String(cut._id),
            frame,
            imageModel: cleanImageModel(body.image_model),
            prompt: typeof body.prompt === 'string' ? body.prompt : null,
            mode,
            editPrompt: typeof body.edit_prompt === 'string' ? body.edit_prompt : null,
            editReferenceImageIds: Array.isArray(body.edit_reference_image_ids) ? body.edit_reference_image_ids.filter((x) => isOidHex(String(x))) : [],
            comfyParams: cleanComfyParams(body.comfy_params),
          });
          res.status(202).json({ job_id: jobId, cut_id: cut._id });
        } catch (e) {
          return sendBusyOr(e, res);
        }
      } catch (e) {
        next(e);
      }
    });

    // Edit the frame's reference list (ordered artwork ids from the beat
    // catalog) without rendering. The prompt text is a y-doc fragment.
    router.patch(`/cut/:id/${frame}-frame`, async (req, res, next) => {
      try {
        const cut = await resolveCut(req);
        if (!cut) return res.status(404).json({ error: 'cut not found' });
        const body = req.body || {};
        const hasIds = Object.prototype.hasOwnProperty.call(body, 'reference_ids');
        // `derive` (end frame only): render it by editing the start frame.
        const hasDerive = frame === 'end' && typeof body.derive === 'boolean';
        if (!hasIds && !hasDerive) return res.status(400).json({ error: 'reference_ids must be an array of image ids' });
        const ids = hasIds ? body.reference_ids : null;
        if (hasIds && (!Array.isArray(ids) || ids.some((x) => !isOidHex(String(x))))) {
          return res.status(400).json({ error: 'reference_ids must be an array of image ids' });
        }
        const { setVideoPromptStartFrameViaGateway } = await import('./gateway.js');
        const base = cut[key] || { image_id: null, prompt: '', reference_ids: [], reference_scores: {}, model: null, generated_at: null, previous_image_id: null };
        const next = { ...base };
        if (hasIds) {
          const uniq = [...new Set(ids.map(String))].slice(0, MAX_REFERENCE_IMAGES);
          const scores = {};
          const uses = {};
          for (const id of uniq) {
            if (base.reference_scores?.[id] != null) scores[id] = base.reference_scores[id];
            if (base.reference_uses?.[id]) uses[id] = base.reference_uses[id];
          }
          // A hand-edited list is a choice: an emptied one stays empty at render.
          Object.assign(next, { reference_ids: uniq, reference_scores: scores, reference_uses: uses, references_planned: true });
        }
        if (hasDerive) next.derive = body.derive;
        const updated = await setVideoPromptStartFrameViaGateway({
          projectId: req.projectId,
          promptId: String(cut._id),
          frame,
          startFrame: next,
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
        const { clearCutStartFrame } = await import('./cutStartFrames.js');
        res.json({ cut: await clearCutStartFrame({ projectId: req.projectId, cut, frame }) });
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
        const updated = await undoVideoPromptStartFrameViaGateway({ projectId: req.projectId, promptId: String(cut._id), frame });
        res.json({ cut: updated });
      } catch (e) {
        next(e);
      }
    });
  }

  router.post('/cuts/start-frames/generate', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.body?.beat_id);
      if (!req.body?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const cutIds = Array.isArray(req.body?.cut_ids) ? req.body.cut_ids.filter((x) => isOidHex(String(x))) : null;
      const { startCutStartFramesJob, normalizeFrames } = await import('./cutStartFrames.js');
      try {
        const jobId = await startCutStartFramesJob({
          projectId: req.projectId,
          beatId: beat._id.toString(),
          cutIds: cutIds && cutIds.length ? cutIds : null,
          frames: normalizeFrames(req.body?.frames),
          skipRendered: req.body?.skip_rendered !== false,
          imageModel: cleanImageModel(req.body?.image_model),
          comfyParams: cleanComfyParams(req.body?.comfy_params),
          check: typeof req.body?.check === 'boolean' ? req.body.check : null,
        });
        res.status(202).json({ job_id: jobId, beat_id: beat._id });
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  // The pair check: does the end frame hold the same people, clothes, props
  // and layout as the start frame? `repair` also fixes what disagrees.
  router.post('/cut/:id/frames/check', async (req, res, next) => {
    try {
      const cut = await resolveCut(req);
      if (!cut) return res.status(404).json({ error: 'cut not found' });
      const { startCutFrameCheckJob, StartFrameInputError } = await import('./cutStartFrames.js');
      try {
        const jobId = await startCutFrameCheckJob({
          projectId: req.projectId,
          cutId: String(cut._id),
          repair: req.body?.repair === true,
          imageModel: cleanImageModel(req.body?.image_model),
          comfyParams: cleanComfyParams(req.body?.comfy_params),
        });
        res.status(202).json({ job_id: jobId, cut_id: String(cut._id) });
      } catch (e) {
        if (e instanceof StartFrameInputError) return res.status(400).json({ error: e.message });
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/cuts/start-frames/job/:jobId', async (req, res, next) => {
    try {
      const { getCutStartFrameJob } = await import('./cutStartFrames.js');
      const job = getCutStartFrameJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });

  router.post('/cuts/start-frames/job/:jobId/cancel', async (req, res, next) => {
    try {
      const { cancelCutStartFrameJob } = await import('./cutStartFrames.js');
      const job = cancelCutStartFrameJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });

  // Every start and/or end frame of the beat (?frames=start,end — default
  // both); prompts, references and everything else stay.
  router.delete('/cuts/start-frames', async (req, res, next) => {
    try {
      if (req.query.beat_id == null || req.query.beat_id === '') return res.status(400).json({ error: 'beat_id required' });
      const beat = await resolveBeat(req, req.query.beat_id);
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { clearBeatStartFrames, normalizeFrames, CUT_FRAMES } = await import('./cutStartFrames.js');
      const frames = normalizeFrames(req.query.frames ? String(req.query.frames).split(',') : null, CUT_FRAMES);
      try {
        res.json(await clearBeatStartFrames({ projectId: req.projectId, beatId: beat._id.toString(), frames }));
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  // ── Assembled MP4s (src/web/cutAssemble.js) ──────────────────────────────

  router.post('/video-scene/:id/assemble', async (req, res, next) => {
    try {
      const scene = await resolveScene(req);
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const { startCutAssembleJob } = await import('./cutAssemble.js');
      try {
        const jobId = await startCutAssembleJob({ projectId: req.projectId, beatId: String(scene.beat_id), sceneId: String(scene._id) });
        res.status(202).json({ job_id: jobId, scene_id: scene._id, beat_id: scene.beat_id });
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  router.post('/video-scenes/assemble', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.body?.beat_id);
      if (!req.body?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { startCutAssembleJob } = await import('./cutAssemble.js');
      try {
        const jobId = await startCutAssembleJob({ projectId: req.projectId, beatId: beat._id.toString() });
        res.status(202).json({ job_id: jobId, beat_id: beat._id });
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/cuts/assemble/job/:jobId', async (req, res, next) => {
    try {
      const { getCutAssembleJob } = await import('./cutAssemble.js');
      const job = getCutAssembleJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job });
    } catch (e) {
      next(e);
    }
  });

  // ── Render beat (every cut → clips → beat MP4) ──────────────────────────
  router.post('/cuts/render/preview', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.body?.beat_id);
      if (!req.body?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { buildCutRenderPreview } = await import('./cutBeatRender.js');
      try {
        const preview = await buildCutRenderPreview({
          projectId: req.projectId,
          beatId: String(beat._id),
          provider: typeof req.body?.provider === 'string' ? req.body.provider : null,
          models: cleanModels(req.body?.models),
          paramsByModel: cleanParamsByModel(req.body?.params_by_model),
          skipRendered: req.body?.skip_rendered !== false,
        });
        res.json(preview);
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  router.post('/cuts/render', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.body?.beat_id);
      if (!req.body?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { startCutBeatRenderJob } = await import('./cutBeatRender.js');
      try {
        const started = await startCutBeatRenderJob({
          projectId: req.projectId,
          beatId: String(beat._id),
          provider: typeof req.body?.provider === 'string' ? req.body.provider : null,
          models: cleanModels(req.body?.models),
          paramsByModel: cleanParamsByModel(req.body?.params_by_model),
          skipRendered: req.body?.skip_rendered !== false,
          confirmSpend: Boolean(req.body?.confirm_spend),
          imageModel: cleanImageModel(req.body?.image_model),
          announceUsername: req.session?.username || null,
        });
        res.status(202).json(started);
      } catch (e) {
        return sendBusyOr(e, res);
      }
    } catch (e) {
      next(e);
    }
  });

  router.get('/cuts/render/job/:jobId', async (req, res, next) => {
    try {
      const { getCutBeatRenderJob, serializeCutBeatJob } = await import('./cutBeatRender.js');
      const job = getCutBeatRenderJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ job: serializeCutBeatJob(job) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/video-scene/:id/video', async (req, res, next) => {
    try {
      const scene = await resolveScene(req);
      if (!scene) return res.status(404).json({ error: 'scene not found' });
      const { setVideoSceneVideoViaGateway } = await import('./gateway.js');
      const updated = await setVideoSceneVideoViaGateway({ projectId: req.projectId, sceneId: scene._id, fileId: null });
      res.json({ ok: true, scene: { _id: String(updated._id), video_file_id: updated.video_file_id } });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/video-scenes/video', async (req, res, next) => {
    try {
      const beat = await resolveBeat(req, req.query?.beat_id);
      if (!req.query?.beat_id) return res.status(400).json({ error: 'beat_id required' });
      if (!beat) return res.status(404).json({ error: 'beat not found' });
      const { setBeatPromptsVideoViaGateway } = await import('./gateway.js');
      const updated = await setBeatPromptsVideoViaGateway({ projectId: req.projectId, beatId: beat._id, fileId: null });
      res.json({ ok: true, beat: { _id: String(updated._id), prompts_video_file_id: updated.prompts_video_file_id } });
    } catch (e) {
      next(e);
    }
  });

}
