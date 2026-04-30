import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../log.js';
import { runBackup, killActiveBackup } from './runner.js';

let timer = null;
let inFlight = null;
let stopped = false;

function probeMongodump() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('mongodump', ['--version'], { stdio: 'ignore' });
    } catch {
      return resolve(false);
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function tick() {
  if (stopped) return;
  inFlight = runBackup().catch((err) => {
    logger.warn(`backup: dump failed: ${err.message}`);
  });
  await inFlight;
  inFlight = null;
  if (stopped) return;
  timer = setTimeout(tick, config.backup.intervalMs);
  timer.unref?.();
}

export async function startBackupScheduler() {
  if (stopped) return;
  if (config.backup.intervalMs <= 0) {
    logger.info('backup: scheduler disabled (BACKUP_INTERVAL_MS=0)');
    return;
  }
  const ok = await probeMongodump();
  if (!ok) {
    logger.warn('backup: mongodump not on PATH; scheduler disabled (set BACKUP_INTERVAL_MS=0 to silence)');
    return;
  }
  logger.info(
    `backup: scheduler armed (dir=${config.backup.dir}, every ${Math.round(
      config.backup.intervalMs / 1000,
    )}s, retain ${Math.round(config.backup.retentionMs / 3600000)}h)`,
  );
  timer = setTimeout(tick, config.backup.startupDelayMs);
  timer.unref?.();
}

export async function stopBackupScheduler() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await killActiveBackup();
  if (inFlight) {
    await inFlight.catch(() => {});
    inFlight = null;
  }
}

export function _resetForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  inFlight = null;
  stopped = false;
}
