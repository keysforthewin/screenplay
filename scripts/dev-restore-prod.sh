#!/usr/bin/env bash
#
# Copy the production screenplay database into the LOCAL dev compose stack.
#
#   ./scripts/dev-restore-prod.sh            # dump prod → restore into screenplay-mongo-1 → restart bot
#   ./scripts/dev-restore-prod.sh <archive>  # skip the dump, restore an existing mongodump archive
#
# The dump streams straight over ssh (`mongodump --archive --gzip` inside prod's
# mongo container), so nothing is written on the prod host — its backups/ dir is
# root-owned. Locally the archive is restored with --drop into the dev stack's
# Mongo (GridFS images/attachments ride along: they live in Mongo), then the bot
# is restarted so nothing lazily created against the empty DB lingers.
#
# Reads SSH_PATH (user@host:/path) from .env like deploy.sh. Dev stack must be
# up: docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)
ARCHIVE="${1:-}"

if [[ -z "$ARCHIVE" ]]; then
  SSH_PATH="$(grep -E '^SSH_PATH=' .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
  [[ "$SSH_PATH" == *:* ]] || { echo "SSH_PATH missing from .env" >&2; exit 1; }
  HOST="${SSH_PATH%%:*}"; DIR="${SSH_PATH#*:}"
  mkdir -p tmp
  ARCHIVE="tmp/prod-$(date +%Y%m%d-%H%M).archive.gz"
  echo "==> dumping prod ($HOST:$DIR) → $ARCHIVE"
  ssh "$HOST" "cd '$DIR' && docker compose exec -T mongo mongodump --archive --gzip --db screenplay" > "$ARCHIVE"
  ls -lh "$ARCHIVE"
fi

echo "==> restoring $ARCHIVE into the dev stack's mongo (--drop)"
"${COMPOSE[@]}" exec -T mongo mongorestore --archive --gzip --drop --nsInclude='screenplay.*' < "$ARCHIVE"

echo "==> restarting bot"
"${COMPOSE[@]}" restart bot >/dev/null
sleep 6
"${COMPOSE[@]}" exec -T mongo mongosh --quiet screenplay --eval '
  const c = db.getCollectionNames();
  print("projects:", db.projects.countDocuments(), "plots:", db.plots.countDocuments(), "characters:", db.characters.countDocuments(), "images.files:", db.images.files.countDocuments());
  db.projects.find({}, {title:1}).forEach(p => print("  -", p.title));
'
echo "==> done — http://localhost:5173/"
