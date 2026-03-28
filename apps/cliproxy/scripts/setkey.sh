#!/bin/bash
# Register an API key with CLIProxyAPI
# Usage: setkey.sh <provider> <api-key>
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

PROVIDER="${1:-}"
API_KEY="${2:-}"

if [ -z "$PROVIDER" ] || [ -z "$API_KEY" ]; then
  echo "Usage: @cliproxy setkey <provider> <api-key>"
  echo ""
  echo "Providers: grok, openai, anthropic, gemini-api, groq, mistral, zai"
  exit 1
fi

# Valid API key providers
VALID_PROVIDERS="grok openai anthropic gemini-api groq mistral zai"
if [[ " $VALID_PROVIDERS " != *" $PROVIDER "* ]]; then
  echo "Unknown API key provider: $PROVIDER"
  echo "Valid providers: $VALID_PROVIDERS"
  exit 1
fi

# Ensure running
if ! curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" >/dev/null 2>&1; then
  echo "CLIProxyAPI not running. Starting..."
  bash "${APP_DIR}/scripts/start.sh"
fi

# Count models before setting key
BEFORE=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null | jq '.data | length' 2>/dev/null || echo 0)

# Set the API key via CLIProxyAPI admin endpoint (use jq to prevent JSON injection)
JSON_BODY=$(jq -n --arg provider "$PROVIDER" --arg key "$API_KEY" '{provider: $provider, access_token: $key}')
RESULT=$(curl -sf -X POST http://localhost:4001/admin/token \
  -H "Authorization: Bearer local-only" \
  -H "Content-Type: application/json" \
  -d "$JSON_BODY" 2>/dev/null) || true

if echo "$RESULT" | jq -e '.ok' >/dev/null 2>&1; then
  echo "${PROVIDER} API key configured successfully!"
else
  # Fallback: write directly to config.yaml
  echo "Admin endpoint failed. Configuring via config file..."

  # Map provider to config.yaml key name
  case "$PROVIDER" in
    grok)       CONFIG_KEY="xai-api-key" ;;
    openai)     CONFIG_KEY="openai-api-key" ;;
    anthropic)  CONFIG_KEY="anthropic-api-key" ;;
    gemini-api) CONFIG_KEY="gemini-api-key" ;;
    groq)       CONFIG_KEY="groq-api-key" ;;
    mistral)    CONFIG_KEY="mistral-api-key" ;;
    zai)        CONFIG_KEY="zai-api-key" ;;
    *)          CONFIG_KEY="${PROVIDER}-api-key" ;;
  esac

  # Safely update config.yaml — use Python to handle YAML-special characters in keys
  CONFIG_FILE="${APP_DIR}/config.yaml"
  python3 -c "
import sys, re
config_key = sys.argv[1]
api_key = sys.argv[2]
config_file = sys.argv[3]

# Read existing config
try:
    with open(config_file, 'r') as f:
        lines = f.readlines()
except FileNotFoundError:
    lines = []

# Escape the key value for YAML (wrap in quotes)
safe_value = '\"' + api_key.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"') + '\"'
new_line = config_key + ': ' + safe_value + '\n'

# Replace existing key or append
found = False
for i, line in enumerate(lines):
    if line.startswith(config_key + ':'):
        lines[i] = new_line
        found = True
        break

if not found:
    lines.append(new_line)

with open(config_file, 'w') as f:
    f.writelines(lines)
" "$CONFIG_KEY" "$API_KEY" "$CONFIG_FILE"

  # Restart CLIProxyAPI to pick up the new key
  pkill -f "cli-proxy-api --config" 2>/dev/null || true
  sleep 1
  bash "${APP_DIR}/scripts/start.sh" 2>/dev/null
  sleep 2

  echo "${PROVIDER} API key configured!"
fi

# Wait briefly for models to appear
sleep 2

# Check for new models
AFTER=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null | jq '.data | length' 2>/dev/null || echo 0)
NEW_MODELS=$((AFTER - BEFORE))

echo ""
if [ "$NEW_MODELS" -gt 0 ]; then
  echo "${NEW_MODELS} new model(s) available:"
else
  echo "Models:"
fi
curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" | jq -r '.data[].id'

# Register models with the platform
ROUTER_URL="${ROUTER_URL:-${ANTHROPIC_BASE_URL%/v1}}"
PLATFORM_KEY="${ANTHROPIC_API_KEY:-local-only}"
if [ -n "$ROUTER_URL" ] && [ "$ROUTER_URL" != "local-only" ]; then
  MODELS=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" \
    | jq '[.data[] | {name: .id, provider: "cliproxy"}]')
  REG_RESULT=$(curl -sf -X POST "${ROUTER_URL}/api/models/register" \
    -H "Authorization: Bearer ${PLATFORM_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --argjson models "$MODELS" '{models: $models, port: 4001, registeredBy: "cliproxy"}')" 2>/dev/null) || true
  if echo "$REG_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
    REG_COUNT=$(echo "$REG_RESULT" | jq '.models | length')
    echo ""
    echo "Registered ${REG_COUNT} model(s) with the platform. Type /models to switch."
  fi
fi
