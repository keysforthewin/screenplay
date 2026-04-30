import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';

let client;
let db;

export async function connectMongo() {
  if (db) return db;
  client = new MongoClient(config.mongo.uri);
  await client.connect();
  db = client.db(config.mongo.db);
  logger.info(`Mongo connected: ${config.mongo.db}`);

  await db.collection('characters').createIndex({ name_lower: 1 }, { unique: true });
  await db.collection('messages').createIndex({ channel_id: 1, created_at: 1 });
  await db
    .collection('images.files')
    .createIndex({ 'metadata.owner_type': 1, 'metadata.owner_id': 1 });
  await db.collection('token_usage').createIndex({ discord_user_id: 1, created_at: -1 });
  await db.collection('token_usage').createIndex({ created_at: -1 });

  process.on('SIGINT', async () => {
    if (client) await client.close();
    process.exit(0);
  });
  return db;
}

export function getDb() {
  if (!db) throw new Error('Mongo not connected');
  return db;
}

export async function closeMongo() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
}
