import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';

let client;
let db;

const SLOW_COMMAND_MS = 2000;
const STALE_HEARTBEAT_MS = 30000;
const HEARTBEAT_WATCHDOG_MS = 15000;
let lastHeartbeatAt = 0;
let lastHeartbeatWarnAt = 0;
let heartbeatWatchdog;
const inFlightCommands = new Map();

function attachMongoMonitoring(c) {
  c.on('commandStarted', (event) => {
    const slowTimer = setTimeout(() => {
      logger.warn(
        `mongo: ${event.commandName} (requestId=${event.requestId}) still pending after ${SLOW_COMMAND_MS}ms`,
      );
    }, SLOW_COMMAND_MS);
    if (slowTimer.unref) slowTimer.unref();
    inFlightCommands.set(event.requestId, {
      name: event.commandName,
      startedAt: Date.now(),
      slowTimer,
    });
  });

  c.on('commandSucceeded', (event) => {
    const entry = inFlightCommands.get(event.requestId);
    if (!entry) return;
    clearTimeout(entry.slowTimer);
    inFlightCommands.delete(event.requestId);
    const elapsed = Date.now() - entry.startedAt;
    if (elapsed >= SLOW_COMMAND_MS) {
      logger.warn(`mongo: ${entry.name} completed in ${elapsed}ms (slow)`);
    }
  });

  c.on('commandFailed', (event) => {
    const entry = inFlightCommands.get(event.requestId);
    if (entry) clearTimeout(entry.slowTimer);
    inFlightCommands.delete(event.requestId);
    const reason = event.failure?.message || String(event.failure || 'unknown');
    logger.warn(`mongo: ${event.commandName} failed: ${reason}`);
  });

  c.on('serverHeartbeatSucceeded', () => {
    if (lastHeartbeatAt === 0) {
      logger.info('mongo: first heartbeat ok');
    } else if (lastHeartbeatWarnAt > lastHeartbeatAt) {
      logger.info(
        `mongo: heartbeat recovered after ${Date.now() - lastHeartbeatAt}ms`,
      );
    }
    lastHeartbeatAt = Date.now();
  });

  c.on('serverHeartbeatFailed', (event) => {
    const reason = event.failure?.message || String(event.failure || 'unknown');
    logger.warn(`mongo: heartbeat failed for ${event.connectionId}: ${reason}`);
    lastHeartbeatWarnAt = Date.now();
  });

  c.on('topologyDescriptionChanged', (event) => {
    const servers = [...(event.newDescription?.servers?.values?.() ?? [])]
      .map((s) => `${s.address}=${s.type}`)
      .join(', ');
    logger.info(`mongo topology: type=${event.newDescription?.type} ${servers}`);
  });

  heartbeatWatchdog = setInterval(() => {
    if (lastHeartbeatAt === 0) return;
    const elapsed = Date.now() - lastHeartbeatAt;
    if (elapsed > STALE_HEARTBEAT_MS) {
      logger.warn(
        `mongo: no successful heartbeat in ${elapsed}ms — Mongo may be unreachable`,
      );
      lastHeartbeatWarnAt = Date.now();
    }
  }, HEARTBEAT_WATCHDOG_MS);
  if (heartbeatWatchdog.unref) heartbeatWatchdog.unref();
}

export async function connectMongo() {
  if (db) return db;
  client = new MongoClient(config.mongo.uri, { monitorCommands: true });
  attachMongoMonitoring(client);
  await client.connect();
  db = client.db(config.mongo.db);
  logger.info(`Mongo connected: ${config.mongo.db}`);

  await db.collection('characters').createIndex({ project_id: 1, name_lower: 1 }, { unique: true });
  await db.collection('projects').createIndex({ title_lower: 1 }, { unique: true });
  await db.collection('messages').createIndex({ channel_id: 1, created_at: 1 });
  await db
    .collection('images.files')
    .createIndex({ 'metadata.owner_type': 1, 'metadata.owner_id': 1 });
  await db
    .collection('images.files')
    .createIndex({ 'metadata.owner_type': 1, 'metadata.name_lower': 1 });
  await db
    .collection('images.files')
    .createIndex({ 'metadata.project_id': 1, 'metadata.owner_type': 1 });
  await db.collection('token_usage').createIndex({ discord_user_id: 1, created_at: -1 });
  await db.collection('token_usage').createIndex({ created_at: -1 });
  await db.collection('storyboards').createIndex({ beat_id: 1, order: 1 });
  await db.collection('storyboards').createIndex({ project_id: 1, beat_id: 1 });
  await db.collection('dialogs').createIndex({ project_id: 1, beat_id: 1 });
  await db.collection('plots').createIndex(
    { project_id: 1 },
    { unique: true, partialFilterExpression: { project_id: { $type: 'string' } } },
  );

  return db;
}

export function getDb() {
  if (!db) throw new Error('Mongo not connected');
  return db;
}

export function getMongoHealth() {
  return {
    lastHeartbeatAt,
    msSinceHeartbeat: lastHeartbeatAt ? Date.now() - lastHeartbeatAt : null,
    inFlightCommands: inFlightCommands.size,
  };
}

export async function closeMongo() {
  if (heartbeatWatchdog) {
    clearInterval(heartbeatWatchdog);
    heartbeatWatchdog = undefined;
  }
  for (const entry of inFlightCommands.values()) clearTimeout(entry.slowTimer);
  inFlightCommands.clear();
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
  lastHeartbeatAt = 0;
  lastHeartbeatWarnAt = 0;
}
