// Admin-only REST endpoints for the SPA's Admin page: list users and set a
// user's granted-project set. Mounted at /api/admin behind requireSession()
// AND requireAdmin() (entityRoutes.js); resolveProject skips /admin* paths so
// a stale X-Project-Id can never 404 these calls.

import express from 'express';
import { listUsers, getUserById, setUserProjects } from '../mongo/users.js';
import { listProjects } from '../mongo/projects.js';

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

  return router;
}
