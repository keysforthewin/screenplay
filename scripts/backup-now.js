#!/usr/bin/env node
/**
 * Trigger one immediate mongodump, bypassing the 30-min scheduler.
 * Writes a screenplay-*.archive.gz into BACKUP_DIR and prunes any
 * existing archives older than BACKUP_RETENTION_MS, same as the
 * scheduler would.
 *
 * Usage:
 *   node scripts/backup-now.js
 *   docker compose exec bot node scripts/backup-now.js
 *   ./backup.sh    (preferred — wraps both modes from the repo root)
 */

import { runBackup } from '../src/backup/runner.js';

async function main() {
  const out = await runBackup();
  console.log(`Wrote ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backup failed:', err.message || err);
    process.exit(1);
  });
