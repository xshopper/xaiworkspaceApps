#!/bin/bash
# Check CLIProxyAPI status — run by the agent on @cliproxy status
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

# Binary check
if [ ! -x "${APP_DIR}/bin/cli-proxy-api" ]; then
  jq -n '{text: "**CLI Proxy Status**\n\nBinary: NOT INSTALLED\n\nRun: `~/apps/com.xshopper.cliproxy/scripts/install.sh`", format: "markdown"}'
  exit 0
fi

# Service check
if ! curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" >/dev/null 2>&1; then
  jq -n '{text: "**CLI Proxy Status**\n\nBinary: INSTALLED\nService: NOT RUNNING", buttons: [[{"text": "▶️ Start Service", "callback_data": "@cliproxy start"}, {"text": "🔌 Connect Provider", "callback_data": "@cliproxy connect"}]], format: "markdown"}'
  exit 0
fi

# Models
MODELS=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null)
COUNT=$(echo "$MODELS" | jq '.data | length' 2>/dev/null || echo 0)
if [ "$COUNT" -gt 0 ]; then
  MODEL_LIST=$(echo "$MODELS" | jq -r '.data[] | "  \(.owned_by // "unknown"): \(.id)"' 2>/dev/null)
  # Build status text with model list
  STATUS_TEXT=$(printf "**CLI Proxy Status**\n\nBinary: INSTALLED\nService: RUNNING on port 4001\n\n**Connected Providers**\n\`\`\`\n%s\n\`\`\`\n\nTotal: %s model(s)" "$MODEL_LIST" "$COUNT")
  jq -n --arg text "$STATUS_TEXT" \
    '{text: $text, buttons: [[{"text": "📋 Models", "callback_data": "@cliproxy models"}, {"text": "🔌 Connect Another", "callback_data": "@cliproxy connect"}]], format: "markdown"}'
else
  jq -n '{text: "**CLI Proxy Status**\n\nBinary: INSTALLED\nService: RUNNING on port 4001\n\n**Connected Providers**\n  No providers connected.", buttons: [[{"text": "🔌 Connect Provider", "callback_data": "@cliproxy connect"}]], format: "markdown"}'
fi
