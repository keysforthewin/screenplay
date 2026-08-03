import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { logger } from '../log.js';

// One doc per human, keyed by the case-insensitive login name. Sessions are
// still the request credential (auth_sessions) — a user doc is the identity
// behind them: `name` keeps the first-seen display casing, `name_lower` is the
// unique join key, and `project_ids` is the full set of granted projects
// (24-hex strings, always replaced wholesale — set semantics). Admin-ness is
// never stored here; it is derived from ADMIN_USERNAME at request time.

const HEX24 = /^[a-f0-9]{24}$/i;

const col = () => getDb().collection('users');

let indexesPromise;

export async function ensureUserIndexes() {
  if (indexesPromise) return indexesPromise;
  indexesPromise = (async () => {
    await col().createIndex({ name_lower: 1 }, { unique: true });
  })();
  return indexesPromise;
}

function nameKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

export async function findUserByName(name) {
  await ensureUserIndexes();
  const key = nameKey(name);
  if (!key) return null;
  return col().findOne({ name_lower: key });
}

export async function findOrCreateUserByName(name) {
  await ensureUserIndexes();
  const display = String(name ?? '').trim();
  if (!display) throw new Error('user name must be a non-empty string');
  // Helper-level duplicate check (tests/_fakeMongo.js does not enforce unique
  // indexes). The unique index on name_lower is the real-Mongo backstop for
  // races — a raced insertOne surfaces E11000 and we re-find.
  const existing = await col().findOne({ name_lower: display.toLowerCase() });
  if (existing) return existing;
  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    name: display,
    name_lower: display.toLowerCase(),
    project_ids: [],
    created_at: now,
    updated_at: now,
    last_granted_by: null,
  };
  try {
    await col().insertOne(doc);
  } catch (e) {
    if (e?.code === 11000) return col().findOne({ name_lower: doc.name_lower });
    throw e;
  }
  logger.info(`mongo: user create id=${doc._id} name="${display}"`);
  return doc;
}

export async function getUserById(id) {
  await ensureUserIndexes();
  if (id instanceof ObjectId) return col().findOne({ _id: id });
  if (typeof id === 'string' && HEX24.test(id)) {
    return col().findOne({ _id: new ObjectId(id) });
  }
  return null;
}

export async function listUsers() {
  await ensureUserIndexes();
  return col().find({}).sort({ name_lower: 1 }).toArray();
}

// Replace the user's granted-project set. Set semantics on purpose: both the
// Discord select menu and the Admin page submit the complete new set, so a
// grant is never additive and a re-submitted menu can also revoke.
export async function setUserProjects(userId, projectIds, { grantedBy = null } = {}) {
  await ensureUserIndexes();
  const user = await getUserById(userId);
  if (!user) return null;
  if (!Array.isArray(projectIds)) throw new Error('project_ids must be an array');
  const ids = [];
  for (const raw of projectIds) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!HEX24.test(s)) throw new Error(`invalid project id: ${raw}`);
    if (!ids.includes(s)) ids.push(s);
  }
  await col().updateOne(
    { _id: user._id },
    { $set: { project_ids: ids, updated_at: new Date(), last_granted_by: grantedBy } },
  );
  logger.info(
    `mongo: user grants set id=${user._id} name="${user.name}" projects=[${ids.join(', ')}] by=${grantedBy || 'unknown'}`,
  );
  return col().findOne({ _id: user._id });
}

export async function userHasProject(name, projectId) {
  const user = await findUserByName(name);
  if (!user) return false;
  const pid = String(projectId ?? '').toLowerCase();
  return (user.project_ids || []).some((id) => String(id).toLowerCase() === pid);
}

// Delete-cascade helper: drop a vanished project from every user's grant set.
export async function removeProjectFromUsers(projectId) {
  await ensureUserIndexes();
  const pid = String(projectId ?? '').toLowerCase();
  const res = await col().updateMany({}, { $pull: { project_ids: pid } });
  return res.modifiedCount ?? 0;
}
