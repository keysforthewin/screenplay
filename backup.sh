#!/usr/bin/env bash
#
# Trigger an immediate MongoDB backup. Writes a single
# screenplay-*.archive.gz into ./backups (which the bot container
# bind-mounts to /data/backups) and prunes any older than 48h.
#
# If the bot container is currently running under docker compose, the
# backup runs inside it (so it picks up the in-container mongodb-tools).
# Otherwise it falls back to running locally — local mongodump must be
# on $PATH.
set -euo pipefail
cd "$(dirname "$0")"

if docker compose ps --status running --services 2>/dev/null | grep -qx bot; then
  exec docker compose exec bot node scripts/backup-now.js
fi

exec node scripts/backup-now.js
