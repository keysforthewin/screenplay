// projectMiddleware.js
//
// Resolves the request's project for the /api router. The SPA sends an
// X-Project-Id header on every call; the SSE route cannot set custom headers
// (EventSource), so a ?project_id= query parameter is accepted as a fallback.
//
//   missing header+query → default project (stale cached SPA bundles keep
//                          working across the multi-project deploy)
//   unknown / malformed  → 404 {error:'unknown project'}
//
// Sets req.projectId (24-hex string) and req.projectTitle.

import { getProjectById, getDefaultProject } from '../mongo/projects.js';

const HEX24 = /^[a-f0-9]{24}$/i;

export function resolveProject() {
  return async (req, res, next) => {
    try {
      const fromHeader = typeof req.get === 'function' ? req.get('x-project-id') : null;
      const raw = String(fromHeader || req.query?.project_id || '').trim();
      if (!raw) {
        const project = await getDefaultProject();
        req.projectId = project._id.toString();
        req.projectTitle = project.title;
        return next();
      }
      const project = HEX24.test(raw) ? await getProjectById(raw) : null;
      if (!project) {
        return res.status(404).json({ error: 'unknown project' });
      }
      req.projectId = project._id.toString();
      req.projectTitle = project.title;
      return next();
    } catch (e) {
      return next(e);
    }
  };
}
