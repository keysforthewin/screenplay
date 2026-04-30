#!/usr/bin/env bash
#
# Interactive restore from a previous backup. Lists every
# screenplay-*.archive.gz in ./backups (newest first), prompts for a
# selection, then runs mongorestore --drop against the configured DB.
#
# IMPORTANT: this drops every collection (including GridFS buckets)
# before restoring. Stop the bot first if you care about consistency:
#
#     docker compose stop bot
#     ./restore.sh
#     docker compose start bot
#
# If the bot container is running, the restore runs inside it. Otherwise
# it falls back to a local node + mongorestore (both must be installed).
set -euo pipefail
cd "$(dirname "$0")"

if docker compose ps --status running --services 2>/dev/null | grep -qx bot; then
  echo "!! NOTE: the bot container is currently running. Restoring while"
  echo "!! the bot is connected can corrupt state — consider stopping it"
  echo "!! first with 'docker compose stop bot'."
  echo ""
  exec docker compose exec bot node scripts/restore-backup.js
fi

exec node scripts/restore-backup.js
