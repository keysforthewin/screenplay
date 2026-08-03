// Per-project authorization. Active only when ADMIN_USERNAME is set (the
// "permission system master switch" — see config.web.adminUsername); unset
// means legacy open mode where every session sees every project.
//
// The admin is the session whose username matches ADMIN_USERNAME
// (case-insensitive string compare — knowingly informal, this is a
// friends-only deployment). Admin-ness is derived here at request time and
// never stored on user docs. Everyone else is checked against the `users`
// collection's project_ids grants (src/mongo/users.js).
//
// IMPORTANT: this module must stay separate from src/web/auth.js. Dozens of
// test files replace that module wholesale via vi.mock with only
// requireSession — any new export there that entityRoutes.js imports would
// break them all.

import { config } from '../config.js';
import { userHasProject, findUserByName } from '../mongo/users.js';
import { listProjects } from '../mongo/projects.js';
import { projectIdForRoom } from './roomRegistry.js';

export function permissionsEnabled() {
  return !!config.web.adminUsername;
}

export function isAdmin(username) {
  if (!permissionsEnabled()) return false;
  const name = String(username ?? '').trim().toLowerCase();
  if (!name) return false;
  return name === config.web.adminUsername.trim().toLowerCase();
}

export async function canAccessProject(username, projectId) {
  if (!permissionsEnabled()) return true;
  if (isAdmin(username)) return true;
  if (!username || !projectId) return false;
  return userHasProject(username, String(projectId));
}

// The project list as seen by this user — the SPA treats GET /api/projects as
// its authorization oracle (selector contents, URL resolution, redirect
// target), so filtering here is what makes ungranted projects invisible.
export async function listProjectsFor(username) {
  const projects = await listProjects();
  if (!permissionsEnabled() || isAdmin(username)) return projects;
  const user = username ? await findUserByName(username) : null;
  if (!user) return [];
  const granted = new Set((user.project_ids || []).map((id) => String(id).toLowerCase()));
  return projects.filter((p) => granted.has(p._id.toString().toLowerCase()));
}

// Mounted right after requireSession() in the /api router: req.projectId was
// already set by resolveProject(), req.session by requireSession(). No-ops
// when req.projectId is absent — exactly the /projects* and /admin* paths
// that resolveProject exempts (they carry their own authorization).
export function requireProjectAccess() {
  return async (req, res, next) => {
    try {
      if (!permissionsEnabled() || !req.projectId) return next();
      if (await canAccessProject(req.session?.username, req.projectId)) return next();
      return res.status(403).json({ error: 'forbidden project' });
    } catch (e) {
      return next(e);
    }
  };
}

export function requireAdmin() {
  return (req, res, next) => {
    if (!permissionsEnabled()) return next();
    if (isAdmin(req.session?.username)) return next();
    return res.status(403).json({ error: 'admin only' });
  };
}

// Hocuspocus onAuthenticate helper: throw unless the user may join the room's
// owning project. Bot/gateway writes use openDirectConnection, which never
// runs onAuthenticate — this only ever gates browser websockets.
export async function assertRoomAccess(username, roomName) {
  if (!permissionsEnabled() || isAdmin(username)) return;
  const projectId = await projectIdForRoom(roomName);
  if (!projectId || !(await canAccessProject(username, projectId))) {
    throw new Error(`forbidden room: ${roomName}`);
  }
}
