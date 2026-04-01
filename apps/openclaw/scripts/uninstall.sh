#!/bin/bash
set -euo pipefail
# uninstall.sh — Stop and remove all pm2-managed processes

echo "Stopping all processes..."
# Delete each process individually — deleting all at once stops on first missing process
for proc in openclaw stunnel config-sync config-pull workspace-pull health-watchdog; do
  pm2 delete "$proc" 2>/dev/null || true
done
pm2 save --force 2>/dev/null || true

echo "OpenClaw mini app uninstalled. Gateway stopped."
echo "Note: openclaw npm package and pm2 remain installed globally."
