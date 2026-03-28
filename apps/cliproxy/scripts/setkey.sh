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
if ! echo "$VALID_PROVIDERS" | grep -qw "$PROVIDER"; then
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

# Set the API key via CLIProxyAPI admin endpoint
RESULT=$(curl -sf -X POST http://localhost:4001/admin/token \
  -H "Authorization: Bearer local-only" \
  -H "Content-Type: application/json" \
  -d "{\"provider\": \"${PROVIDER}\", \"access_token\": \"${API_KEY}\"}" 2>/dev/null) || true

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

  # Append to config.yaml if not already present
  CONFIG_FILE="${APP_DIR}/config.yaml"
  if grep -q "^${CONFIG_KEY}:" "$CONFIG_FILE" 2>/dev/null; then
    # Replace existing key
    sed -i "s|^${CONFIG_KEY}:.*|${CONFIG_KEY}: \"${API_KEY}\"|" "$CONFIG_FILE"
  else
    echo "${CONFIG_KEY}: \"${API_KEY}\"" >> "$CONFIG_FILE"
  fi

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
    -d "{\"models\": ${MODELS}, \"port\": 4001, \"registeredBy\": \"cliproxy\"}" 2>/dev/null) || true
  if echo "$REG_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
    REG_COUNT=$(echo "$REG_RESULT" | jq '.models | length')
    echo ""
    echo "Registered ${REG_COUNT} model(s) with the platform. Type /models to switch."
  fi
fi
