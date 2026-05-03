import crypto from 'node:crypto';
import { getDb } from './client.js';
import { logger } from '../log.js';

const REQUESTS_COL = 'auth_requests';
const SESSIONS_COL = 'auth_sessions';

const requests = () => getDb().collection(REQUESTS_COL);
const sessions = () => getDb().collection(SESSIONS_COL);

let indexesPromise;

export async function ensureAuthIndexes() {
  if (indexesPromise) return indexesPromise;
  indexesPromise = (async () => {
    await requests().createIndex({ request_id: 1 }, { unique: true });
    await requests().createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0 },
    );
    await sessions().createIndex({ session_id: 1 }, { unique: true });
  })();
  return indexesPromise;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

export async function createAuthRequest({ username, ttlMs }) {
  await ensureAuthIndexes();
  const now = new Date();
  const doc = {
    request_id: newId('req'),
    username: String(username || '').trim(),
    status: 'pending',
    created_at: now,
    decided_by: null,
    decided_by_id: null,
    decided_at: null,
    expires_at: new Date(now.getTime() + ttlMs),
    session_id: null,
  };
  await requests().insertOne(doc);
  logger.info(`auth: request created id=${doc.request_id} user="${doc.username}"`);
  return doc;
}

export async function getAuthRequest(requestId) {
  await ensureAuthIndexes();
  return requests().findOne({ request_id: requestId });
}

export async function approveAuthRequest({ requestId, deciderTag, deciderId }) {
  await ensureAuthIndexes();
  const existing = await requests().findOne({ request_id: requestId });
  if (!existing) return { result: 'not_found' };
  if (existing.status !== 'pending') return { result: 'already_decided', request: existing };
  const sessionId = newId('sess');
  const now = new Date();
  await requests().updateOne(
    { request_id: requestId, status: 'pending' },
    {
      $set: {
        status: 'approved',
        decided_by: deciderTag || null,
        decided_by_id: deciderId || null,
        decided_at: now,
        session_id: sessionId,
      },
    },
  );
  await sessions().insertOne({
    session_id: sessionId,
    username: existing.username,
    created_at: now,
    last_seen: now,
  });
  logger.info(`auth: approved id=${requestId} user="${existing.username}" by=${deciderTag}`);
  const updated = await requests().findOne({ request_id: requestId });
  return { result: 'approved', request: updated, sessionId };
}

export async function denyAuthRequest({ requestId, deciderTag, deciderId }) {
  await ensureAuthIndexes();
  const existing = await requests().findOne({ request_id: requestId });
  if (!existing) return { result: 'not_found' };
  if (existing.status !== 'pending') return { result: 'already_decided', request: existing };
  await requests().updateOne(
    { request_id: requestId, status: 'pending' },
    {
      $set: {
        status: 'denied',
        decided_by: deciderTag || null,
        decided_by_id: deciderId || null,
        decided_at: new Date(),
      },
    },
  );
  logger.info(`auth: denied id=${requestId} user="${existing.username}" by=${deciderTag}`);
  return { result: 'denied', request: await requests().findOne({ request_id: requestId }) };
}

export async function setRequestDiscordMessage(requestId, { messageId, channelId }) {
  await ensureAuthIndexes();
  await requests().updateOne(
    { request_id: requestId },
    { $set: { discord_message_id: messageId, discord_channel_id: channelId } },
  );
}

export async function getSession(sessionId) {
  await ensureAuthIndexes();
  if (!sessionId || typeof sessionId !== 'string') return null;
  return sessions().findOne({ session_id: sessionId });
}

export async function touchSession(sessionId) {
  if (!sessionId) return;
  await sessions().updateOne(
    { session_id: sessionId },
    { $set: { last_seen: new Date() } },
  );
}
