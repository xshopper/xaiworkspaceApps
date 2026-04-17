#!/bin/bash
set -euo pipefail

APP_DIR="${HOME}/apps/com.done24bot.browser"
cd "$APP_DIR"

# Install if needed
if [ ! -d node_modules/puppeteer-core ]; then
  bash scripts/install.sh
fi

# Check if already running
if curl -s http://127.0.0.1:3471/api/status > /dev/null 2>&1; then
  echo "[done24bot] Server already running"
  curl -s http://127.0.0.1:3471/api/status
  exit 0
fi

echo "[done24bot] Starting server on port 3471..."
APP_DIR="$APP_DIR" node server.js &
disown

# Wait for startup
for i in 1 2 3 4 5; do
  sleep 1
  if curl -s http://127.0.0.1:3471/api/status > /dev/null 2>&1; then
    echo "[done24bot] Server started"
    curl -s http://127.0.0.1:3471/api/status
    exit 0
  fi
done

echo "[done24bot] Server may have failed to start — check logs"
exit 1
