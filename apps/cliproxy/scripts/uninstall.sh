#!/bin/bash
# Uninstall CLIProxyAPI — unregister models, stop process, remove all files
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

# Unregister models from the platform
ROUTER_URL="${ROUTER_URL:-${ANTHROPIC_BASE_URL%/v1}}"
API_KEY="${ANTHROPIC_API_KEY:-local-only}"
if [ -n "$ROUTER_URL" ] && [ "$ROUTER_URL" != "local-only" ]; then
  echo "Unregistering models from platform..."
  MODELS=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null \
    | jq '[.data[].id]' 2>/dev/null || echo '[]')
  if [ "$MODELS" != "[]" ]; then
    curl -sf -X POST "${ROUTER_URL}/api/models/unregister" \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"models\": ${MODELS}}" 2>/dev/null || true
    echo "Models unregistered"
  fi
fi

echo "Stopping CLIProxyAPI..."
pkill -f "cli-proxy-api" 2>/dev/null || true
sleep 1

echo "Removing app directory..."
rm -rf "${APP_DIR}"

echo "Removing systemd service (if any)..."
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user stop cliproxy 2>/dev/null || true
systemctl --user disable cliproxy 2>/dev/null || true
rm -f ~/.config/systemd/user/cliproxy.service
systemctl --user daemon-reload 2>/dev/null || true

echo "✅ CLIProxy uninstalled"
