import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';

const col = () => getDb().collection('projects');

export const DEFAULT_PROJECT_TITLE = 'Screenplay';
const MAX_TITLE_LEN = 120;

// Title rules: trimmed, non-empty, max 120 chars, must not contain '/'
// (titles are URL path segments: /p/<encodeURIComponent(title)>/...).
export function normalizeProjectTitle(title) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error('project title must be a non-empty string');
  if (t.length > MAX_TITLE_LEN) {
    throw new Error(`project title must be at most ${MAX_TITLE_LEN} characters`);
  }
  if (t.includes('/')) throw new Error('project title must not contain "/"');
  if (t === '.' || t === '..') throw new Error('project title must not be "." or ".."');
  return t;
}

export async function createProject(title) {
  const t = normalizeProjectTitle(title);
  const title_lower = t.toLowerCase();
  // Helper-level duplicate check (tests/_fakeMongo.js does not enforce unique
  // indexes). The unique index on title_lower is the real-Mongo backstop for
  // races — a raced insertOne surfaces E11000 to the caller, same code path.
  const existing = await col().findOne({ title_lower });
  if (existing) {
    const err = new Error(`duplicate project title: ${t}`);
    err.code = 11000;
    throw err;
  }
  const doc = { _id: new ObjectId(), title: t, title_lower, created_at: new Date() };
  await col().insertOne(doc);
  logger.info(`mongo: project create id=${doc._id} title="${t}"`);
  return doc;
}

export async function listProjects() {
  return col().find({}).sort({ created_at: 1, _id: 1 }).toArray();
}

export async function getProjectByTitle(title) {
  const t = String(title ?? '').trim().toLowerCase();
  if (!t) return null;
  return col().findOne({ title_lower: t });
}

export async function getProjectById(id) {
  if (id instanceof ObjectId) return col().findOne({ _id: id });
  if (typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)) {
    return col().findOne({ _id: new ObjectId(id) });
  }
  return null;
}

// Default project := the oldest project by created_at (post-migration there is
// exactly one). Lazily creates 'Screenplay' on a fresh database.
export async function getDefaultProject() {
  const oldest = await col().find({}).sort({ created_at: 1, _id: 1 }).limit(1).toArray();
  if (oldest.length) return oldest[0];
  try {
    return await createProject(DEFAULT_PROJECT_TITLE);
  } catch (e) {
    if (e?.code === 11000) {
      const p = await getProjectByTitle(DEFAULT_PROJECT_TITLE);
      if (p) return p;
    }
    throw e;
  }
}

// STRICT: every caller must thread an explicit projectId. A throw here means a
// missed threading site — fix the caller; never re-add a default fallback.
export async function resolveProjectId(projectId) {
  if (!projectId) throw new Error('projectId required');
  const s = String(projectId);
  if (!/^[a-f0-9]{24}$/i.test(s)) throw new Error(`invalid projectId: ${s}`);
  return s;
}
