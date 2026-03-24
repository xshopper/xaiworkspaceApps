#!/bin/bash
# Check CLIProxyAPI status — run by the agent on @cliproxy status
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

echo "=== CLI Proxy Status ==="

# Binary
if [ -x "${APP_DIR}/bin/cli-proxy-api" ]; then
  echo "Binary: INSTALLED"
else
  echo "Binary: NOT INSTALLED (run: ~/apps/com.xshopper.cliproxy/scripts/install.sh)"
  exit 0
fi

# Service
if curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" >/dev/null 2>&1; then
  echo "Service: RUNNING on port 4001"
else
  echo "Service: NOT RUNNING (run: ~/apps/com.xshopper.cliproxy/scripts/start.sh)"
  exit 0
fi

# Models
echo ""
echo "=== Connected Providers ==="
MODELS=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null)
COUNT=$(echo "$MODELS" | jq '.data | length' 2>/dev/null || echo 0)
if [ "$COUNT" -gt 0 ]; then
  echo "$MODELS" | jq -r '.data[] | "  \(.owned_by // "unknown"): \(.id)"' 2>/dev/null
  echo ""
  echo "Total: $COUNT model(s)"
else
  echo "  No providers connected."
  echo "  To connect: @cliproxy connect claude"
fi
