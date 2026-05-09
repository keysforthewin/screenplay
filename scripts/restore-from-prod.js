#!/usr/bin/env node
/**
 * Pull a MongoDB backup from the production host (configured via SSH_PATH
 * in .env) and restore it into the LOCAL dev database.
 *
 * Flow:
 *   1. Optionally run ./backup.sh on the remote host so the archive
 *      reflects right-now state.
 *   2. List screenplay-*.archive.gz files in <remote>/backups/, newest
 *      first, and prompt the user to pick one (same UI as
 *      scripts/restore-backup.js).
 *   3. rsync the chosen file into ./backups/from-prod/<name> on the host.
 *   4. mongorestore --gzip --drop against config.mongo.uri.
 *
 * Usage:
 *   node scripts/restore-from-prod.js
 *   ./restore-from-prod.sh   (preferred wrapper)
 *
 * !!! DESTRUCTIVE: drops every collection in the local DB (including
 * GridFS buckets) before restoring. Stop the local bot first.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../src/config.js';

function parseSshPath(raw) {
  if (!raw || !raw.includes(':')) return null;
  const colonIdx = raw.indexOf(':');
  const host = raw.slice(0, colonIdx);
  const dir = raw.slice(colonIdx + 1);
  if (!host || !dir || !dir.startsWith('/')) return null;
  return { host, dir };
}

function hostnameOf(sshHost) {
  const at = sshHost.lastIndexOf('@');
  return at >= 0 ? sshHost.slice(at + 1) : sshHost;
}

function runInherit(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });
}

async function dockerComposeRunningServices() {
  try {
    const out = await runCapture('docker', ['compose', 'ps', '--status', 'running', '--services']);
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function runStdinRestore(archivePath, dockerExecArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerExecArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    child.on('error', settle);
    child.on('close', (code) => {
      settle(code === 0 ? null : new Error(`mongorestore exited with code ${code}`));
    });
    const stream = fs.createReadStream(archivePath);
    stream.on('error', (err) => {
      try { child.kill('SIGTERM'); } catch {}
      settle(err);
    });
    stream.pipe(child.stdin);
    child.stdin.on('error', (err) => settle(err));
  });
}

async function listRemoteBackups(ssh) {
  const remoteCmd = [
    `cd '${ssh.dir}/backups' 2>/dev/null || exit 0`,
    `for f in screenplay-*.archive.gz; do [ -f "$f" ] && stat -c '%Y %s %n' "$f"; done`,
  ].join('; ');
  const out = await runCapture('ssh', [ssh.host, remoteCmd]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('screenplay-*'))
    .map((line) => {
      const [mtimeS, sizeS, ...rest] = line.split(/\s+/);
      return {
        name: rest.join(' '),
        mtime: Number(mtimeS) * 1000,
        size: Number(sizeS),
      };
    })
    .filter((f) => f.name && Number.isFinite(f.mtime) && Number.isFinite(f.size))
    .sort((a, b) => b.mtime - a.mtime);
}

function formatRow(idx, file) {
  const date = new Date(file.mtime).toISOString();
  const mb = (file.size / 1024 / 1024).toFixed(1);
  const num = String(idx + 1).padStart(3, ' ');
  return `  ${num}. ${file.name}  (${date}, ${mb} MB)`;
}

async function main() {
  const ssh = parseSshPath(process.env.SSH_PATH || '');
  if (!ssh) {
    console.error('SSH_PATH is not set in .env (or is malformed).');
    console.error('Expected: SSH_PATH=user@host:/absolute/path/to/screenplay');
    process.exit(1);
  }

  const runningServices = await dockerComposeRunningServices();
  const useDocker = runningServices.has('mongo');
  const botWasRunning = runningServices.has('bot');
  const targetUri = useDocker
    ? 'mongodb://localhost:27017 (inside docker compose mongo container, via exec)'
    : config.mongo.uri;
  const prodHost = hostnameOf(ssh.host);
  if (prodHost && config.mongo.uri.includes(prodHost)) {
    console.error(`Refusing to run: target Mongo URI contains the prod host.`);
    console.error(`  SSH_PATH host : ${prodHost}`);
    console.error(`  MONGO_URI     : ${config.mongo.uri}`);
    console.error('This script restores prod data into a *local* dev database.');
    process.exit(1);
  }

  console.log(`Source : ${ssh.host}:${ssh.dir}/backups/`);
  console.log(`Target : ${targetUri}`);
  console.log('');

  const rl = readline.createInterface({ input, output });
  try {
    const fresh = (await rl.question('Trigger a fresh backup on the remote first? [Y/n]: ')).trim().toLowerCase();
    if (fresh === '' || fresh === 'y' || fresh === 'yes') {
      console.log(`\nRunning ./backup.sh on ${ssh.host} ...`);
      await runInherit('ssh', [ssh.host, `cd '${ssh.dir}' && ./backup.sh`]);
      console.log('');
    }

    const files = await listRemoteBackups(ssh);
    if (files.length === 0) {
      console.error(`No backups found in ${ssh.host}:${ssh.dir}/backups/`);
      process.exit(1);
    }

    console.log(`Remote backups in ${ssh.host}:${ssh.dir}/backups/ (newest first):\n`);
    files.forEach((f, i) => console.log(formatRow(i, f)));

    const pick = (await rl.question('\nEnter number to pull (q to cancel): ')).trim();
    if (!pick || pick.toLowerCase() === 'q') {
      console.log('Cancelled.');
      return;
    }
    const idx = Number.parseInt(pick, 10) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= files.length) {
      console.error('Invalid selection.');
      process.exit(1);
    }
    const chosen = files[idx];

    console.log('');
    console.log('!! WARNING: this will DROP every collection in your LOCAL DB,');
    console.log('!! including GridFS buckets (images, attachments), and replace');
    console.log(`!! them with the contents of ${chosen.name}`);
    console.log(`!! pulled from ${ssh.host}.`);
    if (useDocker && botWasRunning) {
      console.log('!! The bot container will be stopped before restoring and restarted after.');
    } else if (!useDocker) {
      console.log('!! Stop any local bot process first (Ctrl-C `npm run dev`).');
    }
    console.log('');
    console.log(`Source : ${ssh.host}:${ssh.dir}/backups/${chosen.name}`);
    console.log(`Target : ${targetUri}`);
    if (useDocker) {
      console.log('Mode   : docker compose exec mongo mongorestore (archive piped via stdin)');
    }
    console.log('');

    const confirm = (await rl.question('Type "yes" to proceed: ')).trim();
    if (confirm !== 'yes') {
      console.log('Aborted.');
      return;
    }

    rl.close();

    const stageDir = path.join(config.backup.dir, 'from-prod');
    await fsp.mkdir(stageDir, { recursive: true });
    const localPath = path.join(stageDir, chosen.name);

    console.log(`\nDownloading via rsync to ${localPath} ...`);
    await runInherit('rsync', [
      '-avz',
      '--human-readable',
      '--progress',
      `${ssh.host}:${ssh.dir}/backups/${chosen.name}`,
      localPath,
    ]);

    if (useDocker) {
      if (botWasRunning) {
        console.log('\nStopping bot container (`docker compose stop bot`) ...');
        await runInherit('docker', ['compose', 'stop', 'bot']);
      }

      let restoreErr = null;
      try {
        console.log('\nRestoring via docker compose exec mongo (archive streamed over stdin) ...');
        await runStdinRestore(localPath, [
          'compose', 'exec', '-T', 'mongo',
          'mongorestore',
          '--uri=mongodb://localhost:27017',
          '--gzip',
          '--drop',
          '--archive',
        ]);
      } catch (err) {
        restoreErr = err;
      }

      if (botWasRunning) {
        console.log('\nStarting bot container (`docker compose start bot`) ...');
        try {
          await runInherit('docker', ['compose', 'start', 'bot']);
        } catch (startErr) {
          console.error(`Failed to restart bot container: ${startErr.message || startErr}`);
          if (!restoreErr) restoreErr = startErr;
        }
      }

      if (restoreErr) throw restoreErr;
    } else {
      console.log(`\nRestoring into ${targetUri} ...`);
      await runInherit('mongorestore', [
        `--uri=${targetUri}`,
        `--archive=${localPath}`,
        '--gzip',
        '--drop',
      ]);
    }

    console.log(`\nDone. Archive kept at ${localPath}`);
  } finally {
    rl.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
