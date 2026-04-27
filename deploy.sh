#!/usr/bin/env bash
#
# Build and deploy the screenplay bot to a remote host via rsync + ssh.
# Configuration is read from .env (SSH_PATH=user@host:/absolute/path).
#
# Usage:
#   ./deploy.sh                # tests + rsync + cached rebuild & restart
#   ./deploy.sh --rebuild      # same, but rebuild image with --no-cache and force-recreate
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

Options:
  -r, --rebuild       Rebuild the bot image with --no-cache and force-recreate
                      the container. Use after Dockerfile or dependency changes,
                      or to clear a wedged container.
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
log "Mode:   $([[ "$REBUILD" == "true" ]] && echo 'full rebuild (--no-cache, force-recreate)' || echo 'cached rebuild + restart')"

# --- local verification -------------------------------------------------------
if [[ "$SKIP_TESTS" == "true" ]]; then
  log "Skipping tests (--skip-tests)"
else
  log "Running npm test"
  npm test
fi

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
  --exclude='coverage/' \
  --exclude='tmp/' \
  --exclude='.DS_Store' \
  ./ "$SSH_PATH/"

# --- remote build & restart ---------------------------------------------------
if [[ "$REBUILD" == "true" ]]; then
  log "Rebuilding container (no cache) and force-recreating"
  ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose build --no-cache bot && docker compose up -d --force-recreate bot"
else
  log "Building (cached) and restarting bot"
  ssh "$SSH_HOST" "cd '$REMOTE_DIR' && docker compose up -d --build bot"
fi

log "Deploy complete."
