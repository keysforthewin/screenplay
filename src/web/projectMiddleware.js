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
//
// Exempted paths: /projects and /projects/* — project resolution is skipped so
// a stale X-Project-Id header naming a vanished project can't 404 the very
// fetch the SPA uses to recover from that situation (carried improvement 3),
// nor a rename/delete addressed at some other project by path id. No route
// under /projects reads req.projectId.

import { getProjectById, getDefaultProject } from '../mongo/projects.js';

const HEX24 = /^[a-f0-9]{24}$/i;

export function resolveProject() {
  return async (req, res, next) => {
    try {
      // The /projects* routes are project-agnostic (they list, or address a
      // project by path id); skip resolution so a stale header for a vanished
      // project doesn't block the SPA's recovery fetch — or a rename/delete
      // aimed at some other project. Same story for /admin*: those routes
      // address users, not the viewer's current project.
      const path = String(req.path || '');
      if (
        path === '/projects' || path.startsWith('/projects/') ||
        path === '/admin' || path.startsWith('/admin/')
      ) {
        return next();
      }
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
