#!/bin/bash
set -euo pipefail
# uninstall.sh — Stop and remove all pm2-managed processes

echo "Stopping all processes..."
pm2 delete openclaw bridge stunnel config-sync config-pull workspace-pull health-watchdog 2>/dev/null || true
pm2 save --force 2>/dev/null || true

echo "OpenClaw mini app uninstalled. Gateway and bridge stopped."
echo "Note: openclaw npm package and pm2 remain installed globally."
