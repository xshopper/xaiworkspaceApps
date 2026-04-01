#!/bin/bash
set -euo pipefail
# start.sh — Start (or restart) all OpenClaw processes via pm2

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ECO="$APP_DIR/ecosystem.config.js"

# Regenerate ecosystem config (picks up env changes, new mini apps)
bash "$APP_DIR/scripts/generate-ecosystem.sh"

if [ ! -f "$ECO" ]; then
  echo "ERROR: ecosystem.config.js not found — run install.sh first"
  exit 1
fi

if [ "${1:-}" = "restart" ]; then
  echo "Restarting all processes..."
  pm2 restart "$ECO"
else
  echo "Starting all processes..."
  # Delete only our owned processes to avoid killing other mini apps (e.g. cliproxy)
  pm2 delete openclaw bridge config-sync config-pull workspace-pull health-watchdog 2>/dev/null || true
  pm2 start "$ECO"
fi

# Persist process list for reboot survival (pm2 startup hook set during install)
pm2 save 2>/dev/null || true

echo ""
pm2 list --no-color 2>/dev/null || true
