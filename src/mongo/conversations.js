import { getDb } from './client.js';

const MAX_MESSAGES = 60;
const col = () => getDb().collection('conversations');

export async function loadHistory(channelId) {
  const doc = await col().findOne({ channel_id: channelId });
  return doc?.messages || [];
}

export async function saveHistory(channelId, messages) {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await col().updateOne(
    { channel_id: channelId },
    { $set: { channel_id: channelId, messages: trimmed, updated_at: new Date() } },
    { upsert: true },
  );
}

export async function resetHistory(channelId) {
  await col().updateOne(
    { channel_id: channelId },
    { $set: { messages: [], updated_at: new Date() } },
    { upsert: true },
  );
}
