#!/bin/bash
# Connect a provider to CLIProxyAPI
# Usage: connect.sh <provider>
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"
PROVIDER="${1:-}"

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

# CLI subscription providers
CLI_PROVIDERS="claude codex gemini qwen iflow"
if echo "$CLI_PROVIDERS" | grep -qw "$PROVIDER"; then
  # Map provider to CLI login flag
  case "$PROVIDER" in
    claude) LOGIN_FLAG="--claude-login" ;;
    codex)  LOGIN_FLAG="--codex-login" ;;
    gemini) LOGIN_FLAG="--login" ;;
    qwen)   LOGIN_FLAG="--qwen-login" ;;
    iflow)  LOGIN_FLAG="--iflow-login" ;;
  esac

  # Count models before connecting
  BEFORE=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null | jq '.data | length' 2>/dev/null || echo 0)

  # Run CLI login in background — captures URL output, waits for callback
  LOG_FILE="/tmp/cliproxy-oauth-${PROVIDER}.log"
  cd "${APP_DIR}" && ./bin/cli-proxy-api ${LOGIN_FLAG} --no-browser --config config.yaml > "${LOG_FILE}" 2>&1 &
  LOGIN_PID=$!

  # Wait for the auth URL to appear in the log (max 10s)
  URL=""
  for i in $(seq 1 20); do
    sleep 0.5
    URL=$(grep -oE 'https://[^ ]+' "${LOG_FILE}" 2>/dev/null | head -1 || true)
    [ -n "$URL" ] && break
  done

  if [ -z "$URL" ]; then
    echo "ERROR: Could not get OAuth URL. Log:"
    cat "${LOG_FILE}" 2>/dev/null
    kill $LOGIN_PID 2>/dev/null || true
    exit 1
  fi

  echo ""
  echo "Open this link to authenticate:"
  echo "$URL"
  echo ""
  echo "The xAI Workspace Chrome addon will handle the callback automatically."
  echo ""
  echo "Waiting for authentication..."

  # Poll for new models to appear (indicates successful auth)
  for i in $(seq 1 120); do
    # Check if login process completed
    if ! kill -0 $LOGIN_PID 2>/dev/null; then
      # Process exited — check if models increased
      AFTER=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null | jq '.data | length' 2>/dev/null || echo 0)
      if [ "$AFTER" -gt "$BEFORE" ]; then
        echo ""
        echo "✅ ${PROVIDER} connected successfully!"
        echo ""
        echo "Available models:"
        curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" | jq -r '.data[].id'

        # Register models with the platform so they appear in /models
        ROUTER_URL="${ROUTER_URL:-${ANTHROPIC_BASE_URL%/v1}}"
        API_KEY="${ANTHROPIC_API_KEY:-local-only}"
        if [ -n "$ROUTER_URL" ] && [ "$ROUTER_URL" != "local-only" ]; then
          MODELS=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" \
            | jq '[.data[] | {name: .id, provider: "cliproxy"}]')
          REG_RESULT=$(curl -sf -X POST "${ROUTER_URL}/api/models/register" \
            -H "Authorization: Bearer ${API_KEY}" \
            -H "Content-Type: application/json" \
            -d "{\"models\": ${MODELS}, \"port\": 4001, \"registeredBy\": \"cliproxy\"}" 2>/dev/null)
          if echo "$REG_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
            REG_COUNT=$(echo "$REG_RESULT" | jq '.models | length')
            echo ""
            echo "📋 Registered ${REG_COUNT} model(s) with the platform. Type /models to switch."
          else
            echo ""
            echo "⚠️ Model registration failed: $(echo "$REG_RESULT" | head -c 200)"
          fi
        fi

        rm -f "${LOG_FILE}"
        exit 0
      else
        echo ""
        echo "❌ Authentication completed but no new models appeared."
        echo "Log:"
        cat "${LOG_FILE}" 2>/dev/null
        rm -f "${LOG_FILE}"
        exit 1
      fi
    fi
    sleep 3
  done

  # Timeout — kill the background process
  kill $LOGIN_PID 2>/dev/null || true
  rm -f "${LOG_FILE}"
  echo ""
  echo "⏰ Timed out waiting for authentication. Please try again."
  exit 1
fi

# API key providers — need key as second argument or prompt
echo "API key provider: ${PROVIDER}"
echo "Please provide your API key (it will be added to config.yaml)"
echo "Pass it as: connect.sh ${PROVIDER} YOUR_KEY"
