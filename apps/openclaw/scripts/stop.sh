#!/bin/bash
set -euo pipefail
# stop.sh — Stop all OpenClaw managed processes

echo "Stopping OpenClaw processes..."
pm2 stop openclaw bridge config-sync config-pull workspace-pull health-watchdog 2>/dev/null || true
pm2 save 2>/dev/null || true

echo ""
pm2 list --no-color 2>/dev/null || true
