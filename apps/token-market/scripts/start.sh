#!/bin/bash
# Start Token Market server (if not already running)
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.token-market"

if curl -sf http://localhost:3460/health >/dev/null 2>&1; then
  echo "Token Market already running on port 3460"
  exit 0
fi

cd "${APP_DIR}"

# Install deps if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --production 2>/dev/null || pnpm install --prod 2>/dev/null || true
fi

nohup node server.js >> token-market.log 2>&1 &
sleep 2

if curl -sf http://localhost:3460/health >/dev/null 2>&1; then
  echo "Token Market started on port 3460"
else
  echo "ERROR: Failed to start. Check ~/apps/com.xshopper.token-market/token-market.log"
  exit 1
fi
