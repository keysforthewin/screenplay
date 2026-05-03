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
