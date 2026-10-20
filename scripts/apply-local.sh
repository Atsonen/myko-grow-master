#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/myko}"
BACKEND_DIR="$APP_DIR/backend"
RUN_INSTALL=auto
RUN_MIGRATE=1
RESTART_WEB=1
RESTART_BACKEND=1
RESTART_MQTT=1

usage() {
  cat <<'EOF'
Myko Valvomo local apply script

Use on Lubuntu after editing files from Windows/Samba/VS Code.

Usage:
  ./scripts/apply-local.sh [options]

Options:
  --install       Run npm install in root and backend unconditionally
  --no-install    Skip npm install completely
  --no-migrate    Skip backend database migrations
  --no-web        Do not restart myko-web
  --no-backend    Do not restart myko-backend
  --no-mqtt       Do not restart myko-mqtt-logger
  --help          Show this help

Environment:
  APP_DIR=/opt/myko  Override application directory
EOF
}

for arg in "$@"; do
  case "$arg" in
    --install) RUN_INSTALL=yes ;;
    --no-install) RUN_INSTALL=no ;;
    --no-migrate) RUN_MIGRATE=0 ;;
    --no-web) RESTART_WEB=0 ;;
    --no-backend) RESTART_BACKEND=0 ;;
    --no-mqtt) RESTART_MQTT=0 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 2 ;;
  esac
done

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33mWARN: %s\033[0m\n' "$*"; }
run() { printf '\033[0;90m$ %s\033[0m\n' "$*"; "$@"; }

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "Not a git repository: $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

log "Repository status"
run git status --short

CHANGED_FILES="$(git diff --name-only HEAD || true)"
UNTRACKED_FILES="$(git ls-files --others --exclude-standard || true)"
ALL_CHANGED="$CHANGED_FILES
$UNTRACKED_FILES"

if [[ -n "${ALL_CHANGED//[$'\n' ]/}" ]]; then
  warn "There are local/uncommitted changes. This script will use them as-is and will not git pull/reset. Good for Samba edits. Bad if you forgot random experiments here."
fi

NEEDS_ROOT_INSTALL=0
NEEDS_BACKEND_INSTALL=0
if echo "$ALL_CHANGED" | grep -Eq '(^|/)(package.json|package-lock.json|bun.lock|pnpm-lock.yaml|yarn.lock)$'; then
  NEEDS_ROOT_INSTALL=1
fi
if echo "$ALL_CHANGED" | grep -Eq '^backend/(package.json|package-lock.json|bun.lock|pnpm-lock.yaml|yarn.lock)$'; then
  NEEDS_BACKEND_INSTALL=1
fi

if [[ "$RUN_INSTALL" == "yes" || ( "$RUN_INSTALL" == "auto" && "$NEEDS_ROOT_INSTALL" == "1" ) ]]; then
  log "Installing root dependencies"
  run npm install
else
  log "Skipping root npm install"
fi

if [[ "$RUN_INSTALL" == "yes" || ( "$RUN_INSTALL" == "auto" && "$NEEDS_BACKEND_INSTALL" == "1" ) ]]; then
  log "Installing backend dependencies"
  (cd "$BACKEND_DIR" && run npm install)
else
  log "Skipping backend npm install"
fi

if [[ "$RUN_MIGRATE" == "1" ]]; then
  log "Running DB migrations"
  (cd "$BACKEND_DIR" && run npm run migrate)
else
  log "Skipping DB migrations"
fi

log "Restarting services"
if [[ "$RESTART_BACKEND" == "1" ]]; then
  run sudo systemctl restart myko-backend
fi
if [[ "$RESTART_MQTT" == "1" ]]; then
  run sudo systemctl restart myko-mqtt-logger
fi
if [[ "$RESTART_WEB" == "1" ]]; then
  run sudo systemctl restart myko-web
fi

log "Service status"
systemctl --no-pager --full status myko-backend | sed -n '1,12p' || true
systemctl --no-pager --full status myko-mqtt-logger | sed -n '1,12p' || true
systemctl --no-pager --full status myko-web | sed -n '1,12p' || true

log "API smoke tests"
if curl -fsS http://localhost:3010/health >/tmp/myko-health.json; then
  cat /tmp/myko-health.json
  echo
else
  warn "Backend health check failed. See: journalctl -u myko-backend -n 80 --no-pager"
fi

if curl -fsS http://localhost:3010/api/environment/latest >/tmp/myko-env-latest.json; then
  if command -v jq >/dev/null 2>&1; then
    jq '.[0:5]' /tmp/myko-env-latest.json
  else
    head -c 1000 /tmp/myko-env-latest.json; echo
  fi
else
  warn "Environment API check failed. See: journalctl -u myko-backend -n 80 --no-pager"
fi

log "Done"
echo "Open: http://192.168.1.51/environment"
