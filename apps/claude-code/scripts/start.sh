#!/bin/bash
set -euo pipefail
: "${HOME:?HOME is not set}"

APP_DIR="${HOME}/apps/com.xshopper.claude-code"
export APP_PORT="${APP_PORT:-3457}"

# Install deps if needed
if [ ! -d "${APP_DIR}/node_modules" ]; then
  echo "Installing dependencies..."
  cd "${APP_DIR}" && npm install --production
fi

# Start or restart
if [ "${1:-}" = "restart" ]; then
  echo "Restarting Claude Code server..."
  pm2 restart claude-code-server --update-env 2>/dev/null || \
    pm2 start "${APP_DIR}/server.js" --name claude-code-server --cwd "${APP_DIR}" --interpreter node
else
  if pm2 describe claude-code-server &>/dev/null; then
    echo "Claude Code server already running."
    pm2 list --no-color 2>/dev/null | grep -E "Name|claude-code"
  else
    echo "Starting Claude Code server on port ${APP_PORT}..."
    pm2 start "${APP_DIR}/server.js" --name claude-code-server --cwd "${APP_DIR}" --interpreter node
  fi
fi

pm2 save 2>/dev/null || true

# Verify it started
sleep 1
if curl -s --connect-timeout 3 "http://127.0.0.1:${APP_PORT}/health" &>/dev/null; then
  echo "Server ready on port ${APP_PORT}"
else
  echo "Warning: server not responding on port ${APP_PORT} yet — check logs with @claude-code logs"
fi
