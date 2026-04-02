#!/bin/bash
# status.sh — Show status of all OpenClaw managed processes
# No set -euo pipefail: status checks use || fallbacks intentionally

[ -f /etc/xai/secrets.env ] && set -a && source /etc/xai/secrets.env && set +a

echo "=== OpenClaw Process Status ==="
pm2 list --no-color 2>/dev/null || echo "pm2 not running"

echo ""
echo "=== Bridge Health ==="
BRIDGE_HEALTH_PORT="${BRIDGE_HEALTH_PORT:-19099}"
curl -s --connect-timeout 2 "http://127.0.0.1:${BRIDGE_HEALTH_PORT}/health" 2>/dev/null || echo "Bridge health endpoint not reachable"

echo ""
echo "=== Gateway Port ==="
PORT="${PORT:-19001}"
if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
  echo "Gateway listening on port ${PORT}"
else
  echo "Gateway NOT listening on port ${PORT}"
fi
