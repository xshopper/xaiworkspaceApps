#!/bin/bash
# Connect a provider to CLIProxyAPI
# Usage: connect.sh <provider>
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"
PROVIDER="${1:-}"
ROUTER_URL="${ROUTER_URL:-http://10.14.176.1:8080}"

if [ -z "$PROVIDER" ]; then
  echo "Usage: connect.sh <provider>"
  echo ""
  echo "CLI Subscriptions (browser OAuth):"
  echo "  claude, codex, gemini, qwen, iflow"
  echo ""
  echo "API Keys (paste your key):"
  echo "  grok, openai, anthropic, gemini-api, groq, mistral"
  exit 1
fi

# Ensure running
if ! curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" >/dev/null 2>&1; then
  echo "CLIProxyAPI not running. Starting..."
  bash "${APP_DIR}/scripts/start.sh"
fi

# CLI subscription providers — get auth URL from CLIProxyAPI, show to user
CLI_PROVIDERS="claude codex gemini qwen iflow"
if echo "$CLI_PROVIDERS" | grep -qw "$PROVIDER"; then
  # Map provider to CLIProxyAPI auth endpoint
  case "$PROVIDER" in
    claude) ENDPOINT="/anthropic-auth-url" ;;
    codex)  ENDPOINT="/codex-auth-url" ;;
    gemini) ENDPOINT="/gemini-auth-url" ;;
    qwen)   ENDPOINT="/qwen-auth-url" ;;
    iflow)  ENDPOINT="/iflow-auth-url" ;;
  esac

  echo "Getting OAuth URL for ${PROVIDER}..."
  AUTH=$(curl -sf "http://localhost:4001${ENDPOINT}" -H "Authorization: Bearer local-only" 2>&1)
  URL=$(echo "$AUTH" | jq -r '.url // empty')
  STATE=$(echo "$AUTH" | jq -r '.state // empty')

  if [ -z "$URL" ]; then
    echo "ERROR: Could not get OAuth URL. CLIProxyAPI response:"
    echo "$AUTH"
    exit 1
  fi

  echo ""
  echo "Open this link to authenticate:"
  echo "$URL"
  echo ""
  echo "The xAI Workspace Chrome addon will handle the callback automatically."
  echo "If you don't have it, install 'xAI Workspace OAuth Bridge' from the Chrome Web Store."
  echo ""
  echo "Waiting for authentication..."

  # Poll via router (picks up Chrome addon callbacks from DB and delivers to CLIProxyAPI)
  API_KEY="${ANTHROPIC_API_KEY:-local-only}"
  for i in $(seq 1 120); do
    STATUS=$(curl -sf "${ROUTER_URL}/api/cliproxy/oauth/poll?state=${STATE}&provider=${PROVIDER}" \
      -H "Authorization: Bearer ${API_KEY}" 2>/dev/null | jq -r '.status // "wait"')
    if [ "$STATUS" = "ok" ]; then
      echo ""
      echo "✅ ${PROVIDER} connected successfully!"
      echo ""
      echo "Available models:"
      curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" | jq -r '.data[].id'
      exit 0
    fi
    if [ "$STATUS" = "error" ]; then
      echo ""
      echo "❌ Authentication failed. Please try again."
      exit 1
    fi
    sleep 3
  done
  echo ""
  echo "⏰ Timed out waiting for authentication. Please try again."
  exit 1
fi

# API key providers — need key as second argument or prompt
echo "API key provider: ${PROVIDER}"
echo "Please provide your API key (it will be added to config.yaml)"
echo "Pass it as: connect.sh ${PROVIDER} YOUR_KEY"
