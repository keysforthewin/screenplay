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
  await db.collection('conversations').createIndex({ channel_id: 1 }, { unique: true });

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
