// Rate-limit store for SPA edit announcements. One row means "this editor has
// already been announced for this target within the current ~24h window". Rows
// self-expire via a TTL index on `created_at` (see connectMongo in client.js),
// so the window is fixed from the announcement and resets automatically.

import { getDb } from './client.js';

const COLLECTION = 'edit_announcements';

// Returns true exactly once per (projectId, targetType, targetId, editor) per
// window. The first caller inserts the row (true); later callers match the
// existing row and get false until it TTL-expires.
export async function claimAnnouncement({ projectId, targetType, targetId, editor }) {
  if (!projectId) throw new Error('projectId required');
  const key = {
    project_id: projectId,
    target_type: targetType,
    target_id: targetId,
    editor,
  };
  try {
    const res = await getDb()
      .collection(COLLECTION)
      .updateOne(key, { $setOnInsert: { ...key, created_at: new Date() } }, { upsert: true });
    return res.upsertedId != null || res.upsertedCount === 1;
  } catch (e) {
    // Concurrent upsert race under the unique index surfaces as E11000 — treat
    // it as "someone else already claimed this window".
    if (e?.code === 11000) return false;
    throw e;
  }
}
