#!/usr/bin/env bash
#
# Build and deploy the screenplay bot to a remote host via rsync + ssh.
# Configuration is read from .env (SSH_PATH=user@host:/absolute/path).
#
# Source is bind-mounted into the container (see docker-compose.yml), so a normal
# deploy is: build the SPA on the host -> rsync -> restart. No image rebuild.
# Rebuild the deps-only image only when dependencies change (--rebuild).
#
# Usage:
#   ./deploy.sh                # tests + build web + rsync + restart (no image rebuild)
#   ./deploy.sh --rebuild      # also rebuild the deps image (--no-cache); use when deps change
#   ./deploy.sh --skip-tests   # skip the local 'npm test' run
#   ./deploy.sh --help         # show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- argument parsing ---------------------------------------------------------
REBUILD=false
SKIP_TESTS=false

usage() {
  cat <<'EOF'
Build and deploy the screenplay bot to the remote host configured in .env.

The .env file must contain:
  SSH_PATH=user@host:/absolute/path/to/screenplay

Usage:
  ./deploy.sh [options]

App source is bind-mounted into the container, so a normal deploy ships code via
rsync and just restarts the bot — no image rebuild.

Options:
  -r, --rebuild       Rebuild the deps-only bot image with --no-cache and
                      force-recreate the container. Use when dependencies change
                      (package.json / package-lock.json) or to clear a wedged
                      container.
  -s, --skip-tests    Skip the local 'npm test' run.
  -h, --help          Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--rebuild)    REBUILD=true; shift ;;
    -s|--skip-tests) SKIP_TESTS=true; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }

# --- load SSH_PATH from .env --------------------------------------------------
if [[ ! -f .env ]]; then
  err ".env not found at $SCRIPT_DIR/.env"
  exit 1
fi

SSH_PATH="$(grep -E '^SSH_PATH=' .env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"

if [[ -z "$SSH_PATH" ]]; then
  err "SSH_PATH is not set in .env"
  echo "Expected: SSH_PATH=user@host:/absolute/path" >&2
  exit 1
fi

if [[ "$SSH_PATH" != *":"* ]]; then
  err "SSH_PATH must be in user@host:/path form (got: $SSH_PATH)"
  exit 1
fi

SSH_HOST="${SSH_PATH%%:*}"
REMOTE_DIR="${SSH_PATH#*:}"

if [[ -z "$SSH_HOST" || -z "$REMOTE_DIR" || "$REMOTE_DIR" != /* ]]; then
  err "SSH_PATH must be user@host:/absolute/path (got host='$SSH_HOST', dir='$REMOTE_DIR')"
  exit 1
fi

log "Target: $SSH_HOST:$REMOTE_DIR"
log "Mode:   $([[ "$REBUILD" == "true" ]] && echo 'rebuild deps image (--no-cache, force-recreate)' || echo 'restart only (mounted source, no image rebuild)')"

# --- local verification -------------------------------------------------------
if [[ "$SKIP_TESTS" == "true" ]]; then
  log "Skipping tests (--skip-tests)"
else
  log "Running npm test"
  npm test
fi

# --- build the SPA on the host (mounted into the container) --------------------
# web/dist is a build artifact, not source; it is bind-mounted, so build it here
# and rsync ships it. Its Vite `base` must match how PROD serves the SPA (e.g.
# /lucas/ behind the reverse proxy), so we read WEB_BASE_PATH from the *remote*
# .env — prod's own source of truth — NOT the local .env. That keeps `npm run
# dev` / `npm run build:web` on this machine at base '/' (still runnable locally),
# while only this deploy build picks up the prod prefix.
# `|| true`: a no-match grep or an unreachable host under pipefail+set-e must not
# abort the deploy; we fall back to the local .env, then to '/'.
log "Reading WEB_BASE_PATH from remote .env ($REMOTE_DIR/.env)"
WEB_BASE_PATH="$(ssh "$SSH_HOST" "grep -E '^WEB_BASE_PATH=' '$REMOTE_DIR/.env' 2>/dev/null | tail -n1" | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]' || true)"
if [[ -z "$WEB_BASE_PATH" ]]; then
  WEB_BASE_PATH="$(grep -E '^WEB_BASE_PATH=' .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]' || true)"
  [[ -n "$WEB_BASE_PATH" ]] && log "Remote .env had no WEB_BASE_PATH; falling back to local .env value"
fi
log "Building web SPA (base=${WEB_BASE_PATH:-/})"
WEB_BASE_PATH="${WEB_BASE_PATH:-/}" npm run build:web

# --- ensure remote dir exists -------------------------------------------------
log "Ensuring remote directory exists"
ssh "$SSH_HOST" "mkdir -p '$REMOTE_DIR'"

# --- rsync --------------------------------------------------------------------
log "Syncing files to remote"
rsync -avz --delete --human-readable \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.claude/' \
  --exclude='*.log' \
  --exclude='mongo-data/' \
  --exclude='exports/' \
  --exclude='backups/' \
  --exclude='coverage/' \
  --exclude='tmp/' \
  --exclude='.DS_Store' \
  ./ "$SSH_PATH/"

# --- remote build & restart ---------------------------------------------------
if [[ "$REBUILD" == "true" ]]; then
  log "Rebuilding deps image (no cache) and force-recreating"
  ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose build --no-cache bot && docker compose up -d --force-recreate bot"
else
  log "Restarting bot to pick up mounted source (no image rebuild)"
  # `up -d` ensures the container exists with current compose config (applying
  # any volume/env changes); `restart` reloads node against the mounted source.
  ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose up -d bot && docker compose restart bot"
fi

log "Deploy complete."
