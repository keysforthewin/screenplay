import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';
import {
  fetchWriteSignature,
  readBackupState,
  writeBackupState,
  sameSignature,
} from './changes.js';

const FILE_PREFIX = 'screenplay-';
const FILE_SUFFIX = '.archive.gz';

let active = null;

export function formatBackupFilename(date = new Date()) {
  const iso = date.toISOString();
  const safe = iso.replace(/:/g, '-').replace(/\..+$/, '');
  return `${FILE_PREFIX}${safe}${FILE_SUFFIX}`;
}

export function isBackupFilename(name) {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX);
}

// Scheduler entry point: dump only when the write counters moved since the
// last successful backup. The signature is captured BEFORE the dump starts,
// so writes landing mid-dump still mark the next tick dirty.
export async function runBackupIfChanged({ dir = config.backup.dir, ...rest } = {}) {
  const signature = await fetchWriteSignature();
  if (signature) {
    const state = await readBackupState(dir);
    if (sameSignature(signature, state?.signature) && (await hasBackupFile(dir))) {
      logger.info('backup: skipped (no writes since last backup)');
      return null;
    }
  }
  const out = await runBackup({ dir, ...rest });
  if (signature) await writeBackupState(dir, signature);
  return out;
}

async function hasBackupFile(dir) {
  const entries = await fsp.readdir(dir).catch(() => []);
  return entries.some(isBackupFilename);
}

export async function runBackup({
  dir = config.backup.dir,
  uri = config.mongo.uri,
  retentionMs = config.backup.retentionMs,
  now = () => new Date(),
} = {}) {
  await fsp.mkdir(dir, { recursive: true });

  const filename = formatBackupFilename(now());
  const outPath = path.join(dir, filename);

  logger.info(`backup: starting ${filename}`);

  try {
    await spawnDump(uri, outPath);
  } catch (err) {
    await fsp.unlink(outPath).catch(() => {});
    throw err;
  }

  const stats = await fsp.stat(outPath).catch(() => null);
  logger.info(`backup: wrote ${filename} (${stats?.size ?? 0} bytes)`);

  await pruneOldBackups({ dir, retentionMs });
  return outPath;
}

function spawnDump(uri, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'mongodump',
      [`--uri=${uri}`, `--archive=${outPath}`, '--gzip', '--quiet'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      active = null;
      reject(err);
    });
    child.on('close', (code) => {
      active = null;
      if (code === 0) resolve();
      else reject(new Error(`mongodump exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
    active = { child, outPath };
  });
}

export async function killActiveBackup() {
  const a = active;
  if (!a) return;
  try {
    a.child.kill('SIGTERM');
  } catch {
    // already gone
  }
  await new Promise((resolve) => {
    if (a.child.exitCode !== null || a.child.signalCode !== null) return resolve();
    const done = () => resolve();
    a.child.once('close', done);
    a.child.once('exit', done);
    setTimeout(done, 5000).unref();
  });
  await fsp.unlink(a.outPath).catch(() => {});
}

// Retention is a rolling window anchored to the NEWEST backup, not the wall
// clock: backups only age out when a newer one supersedes them, so an idle
// system keeps its last window of backups forever.
export async function pruneOldBackups({
  dir = config.backup.dir,
  retentionMs = config.backup.retentionMs,
} = {}) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const name of entries) {
    if (!isBackupFilename(name)) continue;
    const full = path.join(dir, name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    files.push({ name, full, mtimeMs: st.mtimeMs });
  }
  if (!files.length) return [];
  const newest = Math.max(...files.map((f) => f.mtimeMs));
  const cutoff = newest - retentionMs;
  const removed = [];
  for (const f of files) {
    if (f.mtimeMs < cutoff) {
      await fsp.unlink(f.full).catch(() => {});
      removed.push(f.name);
      logger.info(`backup: pruned ${f.name}`);
    }
  }
  return removed;
}
