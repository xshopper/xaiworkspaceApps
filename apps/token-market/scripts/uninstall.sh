#!/bin/bash
# Uninstall Token Market — stop server, remove files
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.token-market"

echo "Stopping Token Market..."
pm2 delete token-market-server 2>/dev/null || true
pkill -u "$(id -u)" -f 'token-market/server.js' 2>/dev/null || true
sleep 1

echo "Removing app directory..."
rm -rf "${APP_DIR}"

echo "Token Market uninstalled"
