#!/usr/bin/env node
/**
 * Interactive restore CLI. Lists every screenplay-*.archive.gz in
 * BACKUP_DIR (newest first), prompts the user to pick one, then runs
 * `mongorestore --gzip --drop` against the configured Mongo URI.
 *
 * Usage:
 *   node scripts/restore-backup.js
 *   docker compose exec bot node scripts/restore-backup.js
 *
 * The bot should be stopped first — this drops every collection before
 * restoring (including images.* and attachments.* GridFS buckets). The
 * script prints a warning and requires a literal "yes" to proceed.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../src/config.js';
import { isBackupFilename } from '../src/backup/runner.js';

function listBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter(isBackupFilename)
    .map((name) => {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      return { name, full, mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function formatRow(idx, file) {
  const date = new Date(file.mtime).toISOString();
  const mb = (file.size / 1024 / 1024).toFixed(1);
  const num = String(idx + 1).padStart(3, ' ');
  return `  ${num}. ${file.name}  (${date}, ${mb} MB)`;
}

async function main() {
  const dir = config.backup.dir;
  const files = listBackups(dir);
  if (files.length === 0) {
    console.error(`No backups found in ${dir}`);
    process.exit(1);
  }

  console.log(`Backups in ${dir} (newest first):\n`);
  files.forEach((f, i) => console.log(formatRow(i, f)));

  const rl = readline.createInterface({ input, output });
  try {
    const pick = (await rl.question('\nEnter number to restore (q to cancel): ')).trim();
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
    console.log('!! WARNING: this will DROP every collection in the target DB,');
    console.log(`!! including GridFS buckets (images, attachments), and replace`);
    console.log(`!! them with the contents of ${chosen.name}.`);
    console.log('!! Stop the bot first (`docker compose stop bot` or Ctrl-C dev).');
    console.log('');
    console.log(`Target URI: ${config.mongo.uri}`);
    console.log('');

    const confirm = (await rl.question('Type "yes" to proceed: ')).trim();
    if (confirm !== 'yes') {
      console.log('Aborted.');
      return;
    }

    rl.close();

    await runRestore(chosen.full);
  } finally {
    rl.close();
  }
}

function runRestore(archivePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'mongorestore',
      [`--uri=${config.mongo.uri}`, `--archive=${archivePath}`, '--gzip', '--drop'],
      { stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mongorestore exited with code ${code}`));
    });
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
