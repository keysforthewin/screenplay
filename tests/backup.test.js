import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const { spawn } = await import('node:child_process');
const {
  runBackup,
  pruneOldBackups,
  formatBackupFilename,
  isBackupFilename,
  killActiveBackup,
} = await import('../src/backup/runner.js');
const { startBackupScheduler, stopBackupScheduler, _resetForTests } = await import(
  '../src/backup/scheduler.js'
);

function fakeChild({ code = 0, stderr = '', error = null, writeArchive = null } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.exitCode = null;
  child.signalCode = null;
  setImmediate(async () => {
    if (error) {
      child.emit('error', error);
      return;
    }
    if (writeArchive) {
      await fsp.writeFile(writeArchive, 'fake-archive-bytes');
    }
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.exitCode = code;
    child.emit('close', code);
  });
  return child;
}

let tmpdir;

beforeEach(async () => {
  spawn.mockReset();
  _resetForTests();
  tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'backup-test-'));
});

afterEach(async () => {
  await fsp.rm(tmpdir, { recursive: true, force: true });
});

describe('formatBackupFilename', () => {
  it('produces a filesystem-safe sortable filename', () => {
    const d = new Date('2026-04-30T14:23:07.123Z');
    expect(formatBackupFilename(d)).toBe('screenplay-2026-04-30T14-23-07.archive.gz');
  });

  it('roundtrips through isBackupFilename', () => {
    const name = formatBackupFilename(new Date('2026-01-01T00:00:00Z'));
    expect(isBackupFilename(name)).toBe(true);
    expect(isBackupFilename('exports/foo.pdf')).toBe(false);
    expect(isBackupFilename('screenplay-bogus.txt')).toBe(false);
  });
});

describe('pruneOldBackups', () => {
  it('removes only files older than retention and ignores other filenames', async () => {
    const now = Date.now();
    const old = path.join(tmpdir, 'screenplay-2026-04-25T00-00-00.archive.gz');
    const recent = path.join(tmpdir, 'screenplay-2026-04-30T00-00-00.archive.gz');
    const unrelated = path.join(tmpdir, 'README.md');
    await fsp.writeFile(old, 'old');
    await fsp.writeFile(recent, 'recent');
    await fsp.writeFile(unrelated, 'keep me');

    const threeDaysAgo = (now - 3 * 24 * 60 * 60 * 1000) / 1000;
    await fsp.utimes(old, threeDaysAgo, threeDaysAgo);
    const oneHourAgo = (now - 60 * 60 * 1000) / 1000;
    await fsp.utimes(recent, oneHourAgo, oneHourAgo);

    const removed = await pruneOldBackups({
      dir: tmpdir,
      retentionMs: 48 * 60 * 60 * 1000,
    });

    expect(removed).toEqual([path.basename(old)]);
    const remaining = await fsp.readdir(tmpdir);
    expect(remaining.sort()).toEqual(['README.md', path.basename(recent)].sort());
  });

  it('returns [] when the directory does not exist', async () => {
    const missing = path.join(tmpdir, 'does-not-exist');
    const removed = await pruneOldBackups({ dir: missing, retentionMs: 1000 });
    expect(removed).toEqual([]);
  });
});

describe('runBackup', () => {
  it('spawns mongodump with the right args, writes the archive, and prunes', async () => {
    let observedArgs = null;
    spawn.mockImplementation((cmd, args) => {
      observedArgs = { cmd, args };
      const archive = args.find((a) => a.startsWith('--archive='))?.slice('--archive='.length);
      return fakeChild({ code: 0, writeArchive: archive });
    });

    const stale = path.join(tmpdir, 'screenplay-2025-01-01T00-00-00.archive.gz');
    await fsp.writeFile(stale, 'stale');
    const old = (Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000;
    await fsp.utimes(stale, old, old);

    const out = await runBackup({
      dir: tmpdir,
      uri: 'mongodb://localhost:27017',
      retentionMs: 48 * 60 * 60 * 1000,
      now: () => new Date('2026-04-30T12:00:00Z'),
    });

    expect(observedArgs.cmd).toBe('mongodump');
    expect(observedArgs.args).toEqual([
      '--uri=mongodb://localhost:27017',
      `--archive=${out}`,
      '--gzip',
      '--quiet',
    ]);
    expect(out).toBe(path.join(tmpdir, 'screenplay-2026-04-30T12-00-00.archive.gz'));

    const stat = await fsp.stat(out);
    expect(stat.size).toBeGreaterThan(0);

    const remaining = await fsp.readdir(tmpdir);
    expect(remaining).not.toContain(path.basename(stale));
  });

  it('rejects with stderr text and removes the partial file when mongodump exits non-zero', async () => {
    spawn.mockImplementation((cmd, args) => {
      const archive = args.find((a) => a.startsWith('--archive='))?.slice('--archive='.length);
      return fakeChild({
        code: 2,
        stderr: 'mongodump: connection refused\n',
        writeArchive: archive,
      });
    });

    await expect(
      runBackup({
        dir: tmpdir,
        uri: 'mongodb://nope',
        retentionMs: 60 * 1000,
        now: () => new Date('2026-04-30T12:00:00Z'),
      }),
    ).rejects.toThrow(/mongodump exited 2/);

    const remaining = await fsp.readdir(tmpdir);
    expect(remaining).toEqual([]);
  });

  it('rejects when mongodump cannot be spawned (ENOENT)', async () => {
    spawn.mockImplementation(() => fakeChild({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }));
    await expect(runBackup({ dir: tmpdir, uri: 'mongodb://x', retentionMs: 1000 })).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe('startBackupScheduler', () => {
  afterEach(async () => {
    await stopBackupScheduler();
    _resetForTests();
  });

  it('disables itself when the mongodump probe fails (ENOENT)', async () => {
    spawn.mockImplementationOnce(() =>
      fakeChild({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
    );

    await startBackupScheduler();
    // Give any latent async settle a tick.
    await new Promise((r) => setTimeout(r, 30));

    // Only the probe call. No dump should have been attempted.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('mongodump', ['--version'], expect.any(Object));
  });
});

describe('killActiveBackup', () => {
  it('is a no-op when nothing is running', async () => {
    await expect(killActiveBackup()).resolves.toBeUndefined();
  });
});
