import { getDb } from './client.js';

const COL = 'channel_state';
const col = () => getDb().collection(COL);

export async function getHistoryClearedAt(channelId) {
  if (!channelId) return null;
  const doc = await col().findOne({ _id: channelId });
  return doc?.history_cleared_at instanceof Date ? doc.history_cleared_at : null;
}

export async function setHistoryClearedAt(channelId, when = new Date()) {
  if (!channelId) throw new Error('channelId required');
  await col().updateOne(
    { _id: channelId },
    { $set: { history_cleared_at: when, updated_at: new Date() } },
    { upsert: true },
  );
  return when;
}

const HEX24_RE = /^[a-f0-9]{24}$/i;

export async function getCurrentProjectId(channelId) {
  if (!channelId) return null;
  const doc = await col().findOne({ _id: channelId });
  return typeof doc?.current_project_id === 'string' && doc.current_project_id
    ? doc.current_project_id
    : null;
}

export async function setCurrentProjectId(channelId, projectId) {
  if (!channelId) throw new Error('channelId required');
  if (typeof projectId !== 'string' || !HEX24_RE.test(projectId)) {
    throw new Error('projectId must be a 24-hex string');
  }
  await col().updateOne(
    { _id: channelId },
    { $set: { current_project_id: projectId, updated_at: new Date() } },
    { upsert: true },
  );
  return projectId;
}
