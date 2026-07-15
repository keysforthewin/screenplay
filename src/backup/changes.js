import fsp from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../mongo/client.js';
import { logger } from '../log.js';

const STATE_FILE = 'backup-state.json';

// Snapshot of the server-wide write opcounters. Every mutation path (agent
// tools, REST gateway, yjs persistence, GridFS uploads, TTL deletions) runs
// against this mongod, so unchanged counters mean unchanged data. Counters
// reset when mongod restarts, which reads as "changed" — an extra backup,
// never a missed one.
export async function fetchWriteSignature() {
  try {
    const status = await getDb().admin().command({ serverStatus: 1 });
    const { insert = 0, update = 0, delete: del = 0 } = status.opcounters ?? {};
    return { insert, update, delete: del };
  } catch (err) {
    logger.warn(`backup: could not read write counters (${err.message}); assuming changed`);
    return null;
  }
}

export function sameSignature(a, b) {
  return (
    !!a && !!b && a.insert === b.insert && a.update === b.update && a.delete === b.delete
  );
}

export function stateFilePath(dir) {
  return path.join(dir, STATE_FILE);
}

export async function readBackupState(dir) {
  try {
    const raw = await fsp.readFile(stateFilePath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeBackupState(dir, signature) {
  const state = { signature, saved_at: new Date().toISOString() };
  await fsp.writeFile(stateFilePath(dir), JSON.stringify(state, null, 2));
}
