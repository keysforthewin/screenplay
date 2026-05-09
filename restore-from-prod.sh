#!/usr/bin/env bash
#
# Pull a MongoDB backup off the production host (configured via SSH_PATH
# in .env) and restore it into the LOCAL dev database. Wraps
# scripts/restore-from-prod.js — see that file for full details.
#
# IMPORTANT: this DROPS every collection in the local DB (including GridFS
# buckets) before restoring.
#
# When docker compose's `mongo` service is running, the JS script restores
# inside the mongo container via `docker compose exec` (no port exposure
# needed) and stops/starts the `bot` container around the restore
# automatically. Otherwise it falls back to running mongorestore on the
# host against MONGO_URI from your local .env — in that case Ctrl-C any
# `npm run dev` first.
set -euo pipefail
cd "$(dirname "$0")"
exec node scripts/restore-from-prod.js
