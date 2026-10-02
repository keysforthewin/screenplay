// Admin-only REST endpoints for the SPA's Admin page: users and their
// granted-project sets, per-feature Claude model slots, and ComfyUI models
// registered from the gallery. Mounted at /api/admin behind requireSession()
// AND requireAdmin() (entityRoutes.js); resolveProject skips /admin* paths so
// a stale X-Project-Id can never 404 these calls.

import fs from 'node:fs/promises';
import express from 'express';
import { listUsers, getUserById, setUserProjects } from '../mongo/users.js';
import { listProjects } from '../mongo/projects.js';
import { getModelSettings, setModelSettings, getComfyModelSettings, setComfyModelSettings } from '../mongo/appSettings.js';
import { describeModelSlots, KNOWN_MODELS } from '../llm/modelSlots.js';
import { comfy, isComfyConfigured, ComfyNotConfiguredError } from '../comfy/client.js';
import {
  getComfyVideoModel,
  listComfyVideoModels,
  listRegisteredComfyVideoModels,
  describeComfyVideoModel,
  validateRegistryEntry,
  COMFY_VIDEO_MODELS,
} from '../comfy/videoModels.js';
import { ensureTemplateFile, templateFilePath, ComfyTemplateNotRunnableError } from '../comfy/templates.js';
import { slotAddressesFromListing } from '../comfy/paramMap.js';
import { autoMapTemplate, inactiveNodeIds, summarizeGalleryRow } from '../comfy/templateMap.js';
import { getAnthropic } from '../anthropic/client.js';
import { describeHarnessProviders } from '../llm/harness/catalog.js';
import { logger } from '../log.js';

const HEX24 = /^[a-f0-9]{24}$/i;

function userShape(u) {
  return {
    id: u._id.toString(),
    name: u.name,
    project_ids: u.project_ids || [],
    created_at: u.created_at || null,
    updated_at: u.updated_at || null,
    last_granted_by: u.last_granted_by || null,
  };
}

export function buildAdminRouter() {
  const router = express.Router();

  router.get('/users', async (_req, res, next) => {
    try {
      res.json({ users: (await listUsers()).map(userShape) });
    } catch (e) {
      next(e);
    }
  });

  // Replace a user's granted-project set (set semantics — the Admin page
  // submits the complete new set). Unknown project ids are silently dropped:
  // a checkbox list built from a slightly stale project list should not
  // reject the whole save because one project was deleted meanwhile.
  router.put('/users/:id/projects', async (req, res, next) => {
    try {
      const ids = req.body?.project_ids;
      if (!Array.isArray(ids) || ids.some((id) => !HEX24.test(String(id ?? '')))) {
        return res.status(400).json({ error: 'project_ids must be an array of project ids' });
      }
      const user = await getUserById(req.params.id);
      if (!user) return res.status(404).json({ error: 'unknown user' });
      const known = new Set((await listProjects()).map((p) => p._id.toString().toLowerCase()));
      const kept = ids.map((id) => String(id).toLowerCase()).filter((id) => known.has(id));
      const updated = await setUserProjects(user._id.toString(), kept, {
        grantedBy: req.session?.username || null,
      });
      res.json(userShape(updated));
    } catch (e) {
      next(e);
    }
  });

  // ── Per-feature Claude model selection ────────────────────────────────
  // GET returns every slot (default / override / effective) plus the model
  // catalog the dropdown offers: the static KNOWN_MODELS list merged with
  // whatever the Anthropic Models API says this key can reach (best-effort,
  // cached briefly — an unreachable API just means the static list).
  router.get('/models', async (_req, res, next) => {
    try {
      const settings = await getModelSettings();
      const [catalog, live_catalog] = await fetchModelCatalog();
      res.json({
        slots: describeModelSlots(),
        catalog,
        live_catalog,
        harness: await describeHarnessProviders(),
        updated_at: settings.updated_at,
        updated_by: settings.updated_by,
      });
    } catch (e) {
      next(e);
    }
  });

  // PUT { slots: { writer: 'claude-fable-5-1', dialog: null,
  //               agent: { provider: 'claude-code', model: 'opus', effort: 'high' }, … } }
  // — a partial merge; null reverts a slot to its env default; an object
  // points the slot at a coding-agent harness (400 when not enabled here).
  // Applies in-process immediately (single writer process), so the next
  // Claude call uses it.
  router.put('/models', async (req, res, next) => {
    try {
      const patch = req.body?.slots;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return res.status(400).json({ error: 'slots must be an object' });
      }
      let settings;
      try {
        settings = await setModelSettings(patch, { updatedBy: req.session?.username || null });
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      logger.info(
        `admin: model slots updated by ${req.session?.username || '?'}: ${JSON.stringify(settings.slots)}`,
      );
      res.json({
        slots: describeModelSlots(),
        updated_at: settings.updated_at,
        updated_by: settings.updated_by,
      });
    } catch (e) {
      next(e);
    }
  });

  // ── ComfyUI templates → registered models ─────────────────────────────
  // Browse the ComfyUI gallery, auto-map a template's slots onto a registry
  // entry for confirmation, and store the confirmed entry (applied live).
  // Everything but the stored list needs a configured ComfyUI (503).
  // comfy-mcp's search_templates answers {total, shown, offset, rows}.
  const galleryRows = (r) => (Array.isArray(r) ? r : r?.rows || r?.templates || []);
  // The models (built-in or registered) already rendering with a template —
  // matched by template name, since a proposal's id need not match theirs.
  const modelsUsingTemplate = (name) =>
    listComfyVideoModels()
      .filter((m) => m.template === name)
      .map((m) => ({ id: m.id, label: m.label, builtin: !m.registered }));

  router.get('/comfy/templates', async (req, res, next) => {
    try {
      if (!isComfyConfigured()) return res.status(503).json({ error: new ComfyNotConfiguredError().message, code: 'COMFY_NOT_CONFIGURED' });
      const query = typeof req.query.query === 'string' ? req.query.query.trim().slice(0, 200) : '';
      const excludeApi = req.query.exclude_api === '1' || req.query.exclude_api === 'true';
      // Filter API rows server-side too, so they cannot use up the page.
      const raw = await comfy.searchTemplates(query || 'video', { limit: 50, exclude_api: excludeApi });
      let templates = galleryRows(raw)
        .map(summarizeGalleryRow)
        .filter((t) => t.name)
        .map((t) => ({ ...t, installed_as: modelsUsingTemplate(t.name) }));
      if (excludeApi) templates = templates.filter((t) => !t.api);
      res.json({ query, templates: templates.slice(0, 50) });
    } catch (e) {
      next(e);
    }
  });

  // Template detail + the auto-mapped proposal. Fetches the workflow JSON
  // into the template cache (so the slot listing can run) even when
  // local_check says it is not runnable — the page shows the check either
  // way; running is what the check gates.
  router.get('/comfy/templates/:name', async (req, res, next) => {
    try {
      if (!isComfyConfigured()) return res.status(503).json({ error: new ComfyNotConfiguredError().message, code: 'COMFY_NOT_CONFIGURED' });
      const name = String(req.params.name || '').trim();
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) return res.status(400).json({ error: 'bad template name' });
      let info = null;
      try {
        info = await comfy.getTemplate(name);
      } catch (e) {
        return res.status(404).json({ error: `template not found: ${e.message}` });
      }
      let localCheck = info?.local_check || null;
      let filePath = null;
      try {
        const tpl = await ensureTemplateFile({ template: name });
        filePath = tpl.path;
        localCheck = tpl.local_check || localCheck;
      } catch (e) {
        if (e instanceof ComfyTemplateNotRunnableError) {
          localCheck = e.local_check || localCheck;
          filePath = templateFilePath(name);
        } else {
          throw e;
        }
      }
      const listing = await comfy.listWorkflowSlots(filePath);
      const slots = Array.isArray(listing?.slots) ? listing.slots : Array.isArray(listing) ? listing : [];
      let notes = [];
      try {
        const n = await comfy.listWorkflowNotes(filePath);
        notes = Array.isArray(n?.notes) ? n.notes : Array.isArray(n) ? n : [];
      } catch (e) {
        logger.warn(`admin comfy: notes for ${name} unavailable: ${e.message}`);
      }
      const summary = summarizeGalleryRow({ ...(info || {}), name });
      let inactiveNodes = null;
      try {
        inactiveNodes = inactiveNodeIds(JSON.parse(await fs.readFile(filePath, 'utf8')));
      } catch (e) {
        logger.warn(`admin comfy: could not read ${name} for bypassed nodes: ${e.message}`);
      }
      const { proposal, warnings } = autoMapTemplate({ name, info, slots, api: summary.api, inactiveNodes });
      const installedAs = modelsUsingTemplate(name);
      // Opening a template that is already registered edits that model
      // instead of proposing a second one under the mapper's id.
      const existingModel = getComfyVideoModel(installedAs.find((m) => !m.builtin)?.id || proposal.id);
      res.json({
        template: { ...summary, local_check: localCheck, runnable: localCheck && localCheck.checked ? localCheck.runnable !== false : null },
        local_check: localCheck,
        slots,
        notes,
        proposal,
        warnings,
        installed_as: installedAs,
        existing: existingModel ? describeComfyVideoModel(existingModel) : null,
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/comfy/models', async (_req, res, next) => {
    try {
      const settings = await getComfyModelSettings();
      res.json({
        registered: listRegisteredComfyVideoModels().map(describeComfyVideoModel),
        builtin_ids: COMFY_VIDEO_MODELS.map((m) => m.id),
        updated_at: settings.updated_at,
        updated_by: settings.updated_by,
      });
    } catch (e) {
      next(e);
    }
  });

  // Upsert one registered model. The body is the full registry entry; it is
  // validated against the template's live slot listing so a typo'd address
  // can never reach set_workflow_slot.
  router.put('/comfy/models/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id || '').trim();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (body.id && body.id !== id) return res.status(400).json({ error: 'body id must match the path id' });
      const draft = { ...body, id };
      if (COMFY_VIDEO_MODELS.some((m) => m.id === id)) return res.status(400).json({ error: `"${id}" is a built-in model` });
      if (!isComfyConfigured()) return res.status(503).json({ error: new ComfyNotConfiguredError().message, code: 'COMFY_NOT_CONFIGURED' });
      const template = String(draft.template || '').trim();
      if (!template) return res.status(400).json({ error: 'template is required' });
      const duplicate = modelsUsingTemplate(template).find((m) => m.id !== id);
      if (duplicate) {
        return res.status(409).json({
          error: `template ${template} is already installed as "${duplicate.label}" (${duplicate.id}${duplicate.builtin ? ', built in' : ''})`,
          installed_as: duplicate,
        });
      }
      let addresses = null;
      try {
        let filePath;
        try {
          filePath = (await ensureTemplateFile({ template })).path;
        } catch (e) {
          if (!(e instanceof ComfyTemplateNotRunnableError)) throw e;
          filePath = templateFilePath(template);
        }
        addresses = slotAddressesFromListing(await comfy.listWorkflowSlots(filePath));
      } catch (e) {
        return res.status(400).json({ error: `template ${template} could not be inspected: ${e.message}` });
      }
      const { ok, errors, entry } = validateRegistryEntry(draft, addresses);
      if (!ok) return res.status(400).json({ error: 'invalid registry entry', errors });
      const current = await getComfyModelSettings();
      const models = current.models.filter((m) => m.id !== id);
      models.push(entry);
      const saved = await setComfyModelSettings(models, { updatedBy: req.session?.username || null });
      logger.info(`admin: ComfyUI model ${id} registered by ${req.session?.username || '?'} (template ${template})`);
      res.json({ model: describeComfyVideoModel(getComfyVideoModel(id)), registered: listRegisteredComfyVideoModels().map(describeComfyVideoModel), updated_at: saved.updated_at });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/comfy/models/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id || '').trim();
      if (COMFY_VIDEO_MODELS.some((m) => m.id === id)) return res.status(400).json({ error: `"${id}" is built in and cannot be removed` });
      const current = await getComfyModelSettings();
      if (!current.models.some((m) => m.id === id)) return res.status(404).json({ error: 'unknown registered model' });
      await setComfyModelSettings(current.models.filter((m) => m.id !== id), { updatedBy: req.session?.username || null });
      res.json({ ok: true, registered: listRegisteredComfyVideoModels().map(describeComfyVideoModel) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// Models API list, cached for 10 minutes. Returns [mergedCatalog, liveOk].
let catalogCache = { at: 0, ids: null };
const CATALOG_TTL_MS = 10 * 60 * 1000;
async function fetchModelCatalog() {
  let live = null;
  if (catalogCache.ids && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    live = catalogCache.ids;
  } else {
    try {
      const client = getAnthropic();
      const ids = [];
      const page = await client.models.list({ limit: 100 }, { timeout: 5000 });
      for await (const m of page) {
        if (m?.id) ids.push({ id: m.id, label: m.display_name || m.id });
      }
      live = ids;
      catalogCache = { at: Date.now(), ids };
    } catch (e) {
      logger.warn(`admin: Anthropic models.list failed (using static catalog): ${e?.message || e}`);
    }
  }
  const byId = new Map();
  for (const m of KNOWN_MODELS) byId.set(m.id, { ...m, known: true });
  for (const m of live || []) {
    if (!byId.has(m.id)) byId.set(m.id, { id: m.id, label: m.label, known: false });
  }
  return [Array.from(byId.values()), live !== null];
}
