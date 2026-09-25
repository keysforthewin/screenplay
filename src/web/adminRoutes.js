// Admin-only REST endpoints for the SPA's Admin page: list users and set a
// user's granted-project set. Mounted at /api/admin behind requireSession()
// AND requireAdmin() (entityRoutes.js); resolveProject skips /admin* paths so
// a stale X-Project-Id can never 404 these calls.

import express from 'express';
import { listUsers, getUserById, setUserProjects } from '../mongo/users.js';
import { listProjects } from '../mongo/projects.js';
import { getModelSettings, setModelSettings } from '../mongo/appSettings.js';
import { describeModelSlots, KNOWN_MODELS } from '../llm/modelSlots.js';
import { getAnthropic } from '../anthropic/client.js';
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
        updated_at: settings.updated_at,
        updated_by: settings.updated_by,
      });
    } catch (e) {
      next(e);
    }
  });

  // PUT { slots: { writer: 'claude-fable-5-1', dialog: null, … } } — a partial
  // merge; null reverts a slot to its env default. Applies in-process
  // immediately (single writer process), so the next Claude call uses it.
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
