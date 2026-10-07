// ComfyUI video routes. Two seams are mounted from entityRoutes.js:
//   - buildComfyRouter(): mounted at /comfy after requireSession() — the model
//     registry, a template's raw slot list, and per-project defaults
//   - registerCutVideoRoutes(router): POST /cut/:id/video/preview|generate and
//     POST /cut/:id/video/job/:jobId/cancel (remove a job still waiting for
//     the GPU) on the main router (after auth)
// The job snapshot (GET /cut/:id/video-job/:jobId) and its pre-auth SSE are
// shared with the fal path in src/web/cutVideoRoutes.js.
//
// Optional integration: with COMFYUI_URL unset, GET /comfy/models answers
// { configured: false, ... } and every render route returns 503.

import express from 'express';
import { resolveVideoRenderer } from './videoDefault.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { getVideoPrompt } from '../mongo/videoPrompts.js';
import { getComfyDefaults, setComfyDefaults } from '../mongo/projectSettings.js';
import { comfy, isComfyConfigured, ComfyNotConfiguredError } from '../comfy/client.js';
import { listComfyVideoModels, getComfyVideoModel, describeComfyVideoModel } from '../comfy/videoModels.js';
import { ensureTemplateFile } from '../comfy/templates.js';
import { comfyImageCatalog, comfyImageScanState, startComfyImageScan } from '../comfy/imageModels.js';
import {
  startComfyCutVideoJob,
  buildComfyPayloadPreview,
  cancelComfyCutVideoJob,
  getComfyVideoJob,
} from './comfyVideoGenerate.js';

const HEX24 = /^[a-f0-9]{24}$/i;

function sendComfyError(e, res) {
  const status = Number.isInteger(e?.status) ? e.status : null;
  if (status && status >= 400 && status < 600) {
    const body = { error: e.message };
    if (e.code) body.code = e.code;
    if (e.job_id) body.job_id = e.job_id;
    if (Array.isArray(e.errors)) body.errors = e.errors;
    if (e.local_check) body.local_check = e.local_check;
    res.status(status).json(body);
    return true;
  }
  if (e instanceof ComfyNotConfiguredError) {
    res.status(503).json({ error: e.message, code: e.code });
    return true;
  }
  return false;
}

// ─── /comfy router ──────────────────────────────────────────────────────────

const SERVER_INFO_TTL_MS = 60_000;
const TARGET_PROBE_TIMEOUT_MS = 3_000;
let serverInfoCache = { at: 0, value: null };

export const COMFY_DISABLED_REASON = 'ComfyUI rendering is disabled on this server (COMFYUI_URL is not set).';

// Is the ComfyUI at COMFYUI_URL answering? comfy-cli's server_info.running
// only describes a ComfyUI *installed on this machine* — inside the bot
// container (dev compose) that is always false while the Windows-side
// ComfyUI behind the bridge is perfectly reachable. So ask it directly.
let targetProbeImpl = defaultTargetProbe;
export function _setComfyTargetProbeForTests(fn) {
  targetProbeImpl = fn || defaultTargetProbe;
}
async function defaultTargetProbe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TARGET_PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/system_stats`, { signal: ctrl.signal });
    if (!r.ok) return { reachable: false, comfyui_version: null, error: `HTTP ${r.status}` };
    const stats = await r.json().catch(() => null);
    return { reachable: true, comfyui_version: stats?.system?.comfyui_version || null, error: null };
  } catch (e) {
    return { reachable: false, comfyui_version: null, error: e?.name === 'AbortError' ? 'timeout' : e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function probeTarget() {
  const url = config.comfy.url || null;
  if (!url) return { url: null, reachable: null, comfyui_version: null, error: null };
  const probed = await targetProbeImpl(url);
  return { url, ...probed };
}

async function serverSummary() {
  if (!isComfyConfigured()) return null;
  const now = Date.now();
  if (serverInfoCache.value && now - serverInfoCache.at < SERVER_INFO_TTL_MS) return serverInfoCache.value;
  let value;
  try {
    const info = await comfy.serverInfo();
    value = {
      running: !!info?.server?.running,
      url: info?.server?.url || info?.comfy_target?.host
        ? info?.server?.url || `${info.comfy_target.host}:${info.comfy_target.port}`
        : null,
      gpu: info?.hardware?.gpu?.model || null,
      vram_bytes: info?.hardware?.gpu?.vram_bytes ?? null,
      comfy_cli_version: info?.compatibility?.comfy_cli_version || null,
      error: null,
    };
  } catch (e) {
    value = { running: false, url: null, gpu: null, vram_bytes: null, comfy_cli_version: null, error: e?.message || String(e) };
  }
  value.target = await probeTarget();
  serverInfoCache = { at: now, value };
  return value;
}

export function _resetComfyRoutesCacheForTests() {
  serverInfoCache = { at: 0, value: null };
}

export function buildComfyRouter() {
  const router = express.Router();

  router.get('/models', async (_req, res, next) => {
    try {
      const configured = isComfyConfigured();
      const server = configured ? await serverSummary() : null;
      res.json({
        configured,
        reason: configured ? null : COMFY_DISABLED_REASON,
        server,
        models: listComfyVideoModels().map(describeComfyVideoModel),
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/models/:id/slots', async (req, res, next) => {
    try {
      const model = getComfyVideoModel(req.params.id);
      if (!model) return res.status(404).json({ error: 'unknown ComfyUI model' });
      if (!isComfyConfigured()) return res.status(503).json({ error: new ComfyNotConfiguredError().message });
      // A builder model has no template and no slots (its graph is emitted per render).
      if (model.graph) return res.json({ model_id: model.id, template: null, graph: model.graph, local_check: null, slots: [] });
      const tpl = await ensureTemplateFile(model);
      const listing = await comfy.listWorkflowSlots(tpl.path);
      const slots = Array.isArray(listing?.slots) ? listing.slots : Array.isArray(listing) ? listing : [];
      res.json({ model_id: model.id, template: model.template, local_check: tpl.local_check, slots });
    } catch (e) {
      if (sendComfyError(e, res)) return;
      next(e);
    }
  });

  // Local image models that take reference images (start frames). The list
  // is the cached result of the last gallery scan; the first request on a
  // never-scanned server starts one, and the SPA polls `scan.running`.
  router.get('/image-models', async (_req, res, next) => {
    try {
      const configured = isComfyConfigured();
      if (!configured) {
        return res.json({ configured, reason: COMFY_DISABLED_REASON, scanned_at: null, models: [], unavailable: [], scan: comfyImageScanState() });
      }
      let catalog = comfyImageCatalog();
      if (!catalog.scanned_at && !comfyImageScanState().running && !comfyImageScanState().error) startComfyImageScan();
      catalog = comfyImageCatalog();
      res.json({ configured, reason: null, ...catalog, scan: comfyImageScanState() });
    } catch (e) {
      next(e);
    }
  });

  router.post('/image-models/scan', async (_req, res, next) => {
    try {
      if (!isComfyConfigured()) return res.status(503).json({ error: new ComfyNotConfiguredError().message });
      res.status(202).json({ scan: startComfyImageScan() });
    } catch (e) {
      next(e);
    }
  });

  router.get('/defaults', async (req, res, next) => {
    try {
      res.json(await getComfyDefaults(req.projectId));
    } catch (e) {
      next(e);
    }
  });

  router.put('/defaults', async (req, res, next) => {
    try {
      const body = req.body || {};
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(body, 'model_id')) patch.model_id = body.model_id;
      if (Object.prototype.hasOwnProperty.call(body, 'params_by_model')) patch.params_by_model = body.params_by_model;
      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'model_id or params_by_model required' });
      }
      try {
        res.json(await setComfyDefaults(req.projectId, patch));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// ─── Per-cut render routes (main router, after auth) ────────────────────────

const ERR_SENT = Symbol('error sent');

// No `model_id` → the admin's default video renderer (Admin → Video
// renderer), when it is a ComfyUI model; its stored params seed the render's
// params under the request's own. 400 when neither names a model.
async function parseRenderBody(req, res) {
  const body = req.body || {};
  let modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
  let params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
  if (!modelId) {
    try {
      const d = await resolveVideoRenderer({ provider: 'comfy' });
      modelId = d.modelId;
      params = { ...d.params, ...params };
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message, code: e.code });
      return ERR_SENT;
    }
  }
  const advanced = Array.isArray(body.advanced) ? body.advanced : [];
  const confirmSpend = body.confirm_spend === true;
  const promptOverride = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.slice(0, 20_000) : null;
  return { modelId, params, advanced, confirmSpend, promptOverride };
}

export function registerCutVideoRoutes(router) {
  async function resolveCutId(req) {
    const { id } = req.params;
    if (!HEX24.test(String(id || ''))) return null;
    const cut = await getVideoPrompt(req.projectId, id);
    return cut?._id?.toString() || null;
  }

  router.post('/cut/:id/video/preview', async (req, res, next) => {
    try {
      const cutId = await resolveCutId(req);
      if (!cutId) return res.status(404).json({ error: 'cut not found' });
      const parsed = await parseRenderBody(req, res);
      if (parsed === ERR_SENT) return;
      try {
        res.json(await buildComfyPayloadPreview({ projectId: req.projectId, cutId, ...parsed }));
      } catch (e) {
        if (sendComfyError(e, res)) return;
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.post('/cut/:id/video/generate', async (req, res, next) => {
    try {
      const cutId = await resolveCutId(req);
      if (!cutId) return res.status(404).json({ error: 'cut not found' });
      const parsed = await parseRenderBody(req, res);
      if (parsed === ERR_SENT) return;
      try {
        const { job_id } = await startComfyCutVideoJob({
          projectId: req.projectId,
          cutId,
          ...parsed,
          announceUsername: req?.session?.username || null,
        });
        res.status(202).json({ job_id });
      } catch (e) {
        if (sendComfyError(e, res)) return;
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  router.post('/cut/:id/video/job/:jobId/cancel', async (req, res, next) => {
    try {
      const cutId = await resolveCutId(req);
      if (!cutId) return res.status(404).json({ error: 'cut not found' });
      const job = getComfyVideoJob(req.params.jobId);
      if (!job || job.owner_id !== cutId) return res.status(404).json({ error: 'job not found' });
      try {
        res.json({ job: cancelComfyCutVideoJob(job.job_id) });
      } catch (e) {
        if (sendComfyError(e, res)) return;
        throw e;
      }
    } catch (e) {
      next(e);
    }
  });

  logger.debug('comfy: cut video routes registered');
}
