#!/bin/bash
# Connect a provider to CLIProxyAPI
# Usage:
#   connect.sh                          → show category selection
#   connect.sh apikey                   → list API key providers
#   connect.sh apikey <provider>        → show instructions for API key entry
#   connect.sh sub                      → list CLI subscription providers
#   connect.sh sub <provider>           → start OAuth flow
#   connect.sh local                    → show local model instructions
#   connect.sh local <host:port>        → discover and register local models
#   connect.sh <provider>               → legacy: auto-detect category and connect
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

# Ensure CLIProxyAPI is running
ensure_running() {
  if ! curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" >/dev/null 2>&1; then
    echo "CLIProxyAPI not running. Starting..."
    bash "${APP_DIR}/scripts/start.sh"
  fi
}

# Register models with the platform router
register_models() {
  local ROUTER_URL="${ROUTER_URL:-${ANTHROPIC_BASE_URL%/v1}}"
  local API_KEY="${ANTHROPIC_API_KEY:-local-only}"
  if [ -n "$ROUTER_URL" ] && [ "$ROUTER_URL" != "local-only" ]; then
    local MODELS
    MODELS=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" \
      | jq '[.data[] | {name: .id, provider: "cliproxy"}]')
    local REG_RESULT
    REG_RESULT=$(curl -sf -X POST "${ROUTER_URL}/api/models/register" \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --argjson models "$MODELS" '{models: $models, port: 4001, registeredBy: "cliproxy"}')" 2>/dev/null) || true
    if echo "$REG_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
      local REG_COUNT
      REG_COUNT=$(echo "$REG_RESULT" | jq '.models | length')
      echo ""
      echo "Registered ${REG_COUNT} model(s) with the platform. Type /models to switch."
    fi
  fi
}

# Show available models
show_models() {
  echo ""
  echo "Available models:"
  curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" | jq -r '.data[].id'
}

# ── CLI subscription providers ──
CLI_PROVIDERS="claude codex gemini qwen iflow"
# ── API key providers ──
API_PROVIDERS="grok openai anthropic gemini-api groq mistral zai"

SUBCMD="${1:-}"
PROVIDER="${2:-}"

# ── No arguments: show category selection ──
if [ -z "$SUBCMD" ]; then
  cat << 'RESPONSE'
{"text":"**Connect a Provider**\n\nChoose a connection type:","buttons":[[{"text":"🔑 API Key","callback_data":"@cliproxy connect apikey"},{"text":"🌐 CLI Subscription","callback_data":"@cliproxy connect sub"}],[{"text":"💻 Local Models","callback_data":"@cliproxy connect local"}]],"format":"markdown"}
RESPONSE
  exit 0
fi

# ── Subcommand: apikey ──
if [ "$SUBCMD" = "apikey" ]; then
  ensure_running

  if [ -z "$PROVIDER" ]; then
    cat << 'RESPONSE'
{"text":"**API Key Providers**\n\nSelect a provider to connect:","buttons":[[{"text":"Grok","callback_data":"@cliproxy connect apikey grok"},{"text":"OpenAI","callback_data":"@cliproxy connect apikey openai"}],[{"text":"Anthropic","callback_data":"@cliproxy connect apikey anthropic"},{"text":"Gemini API","callback_data":"@cliproxy connect apikey gemini-api"}],[{"text":"Groq","callback_data":"@cliproxy connect apikey groq"},{"text":"Mistral","callback_data":"@cliproxy connect apikey mistral"}],[{"text":"Z.ai","callback_data":"@cliproxy connect apikey zai"},{"text":"← Back","callback_data":"@cliproxy connect"}]],"format":"markdown"}
RESPONSE
    exit 0
  fi

  # Validate provider
  if [[ " $API_PROVIDERS " != *" $PROVIDER "* ]]; then
    echo "Unknown API key provider: $PROVIDER"
    echo "Valid providers: $API_PROVIDERS"
    exit 1
  fi

  # Provider-specific hints
  case "$PROVIDER" in
    grok)       HINT="Get your key at https://console.x.ai" ;;
    openai)     HINT="Get your key at https://platform.openai.com/api-keys" ;;
    anthropic)  HINT="Get your key at https://console.anthropic.com/settings/keys" ;;
    gemini-api) HINT="Get your key at https://aistudio.google.com/apikey" ;;
    groq)       HINT="Get your key at https://console.groq.com/keys" ;;
    mistral)    HINT="Get your key at https://console.mistral.ai/api-keys" ;;
    zai)        HINT="Get your key at https://z.ai" ;;
    *)          HINT="" ;;
  esac

  jq -n --arg provider "$PROVIDER" --arg hint "$HINT" \
    '{text: ("**Connect " + $provider + "**\n\n" + $hint + "\n\nPaste your API key below:\n\n`@cliproxy setkey " + $provider + " YOUR_API_KEY`"), buttons: [[{"text": "← Back to providers", "callback_data": "@cliproxy connect apikey"}, {"text": "← Back to categories", "callback_data": "@cliproxy connect"}]], format: "markdown"}'
  exit 0
fi

# ── Subcommand: sub (CLI subscription) ──
if [ "$SUBCMD" = "sub" ]; then
  ensure_running

  if [ -z "$PROVIDER" ]; then
    cat << 'RESPONSE'
{"text":"**CLI Subscription Providers**\n\nSelect a provider to authenticate via browser OAuth:","buttons":[[{"text":"Claude","callback_data":"@cliproxy connect sub claude"},{"text":"Codex","callback_data":"@cliproxy connect sub codex"},{"text":"Gemini","callback_data":"@cliproxy connect sub gemini"}],[{"text":"Qwen","callback_data":"@cliproxy connect sub qwen"},{"text":"iFlow","callback_data":"@cliproxy connect sub iflow"}],[{"text":"← Back","callback_data":"@cliproxy connect"}]],"format":"markdown"}
RESPONSE
    exit 0
  fi

  # Validate provider
  if [[ " $CLI_PROVIDERS " != *" $PROVIDER "* ]]; then
    echo "Unknown CLI subscription provider: $PROVIDER"
    echo "Valid providers: $CLI_PROVIDERS"
    exit 1
  fi

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

  # Kill any previous orphaned login processes (leftover from timed-out OAuth attempts)
  # Scope to current user and specific login flag to avoid killing unrelated processes
  pkill -u "$(id -u)" -f "cli-proxy-api.*${LOGIN_FLAG}" 2>/dev/null || true
  sleep 0.5

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

  # Output the URL as structured JSON with buttons — exit immediately
  # The login process continues in background; the Chrome addon handles the callback
  jq -n --arg url "$URL" --arg provider "$PROVIDER" \
    '{text: ("**Connect " + $provider + "**\n\nOpen this link to authenticate:\n\n" + $url + "\n\nThe xAI Workspace Chrome addon handles the callback automatically.\n\nAfter authenticating, click **Check Models** below."), buttons: [[{"text": "🔗 Open Auth Link", "url": $url}],[{"text": "📋 Check Models", "callback_data": "@cliproxy models"},{"text": "← Back", "callback_data": "@cliproxy connect sub"}]], format: "markdown"}'
  exit 0
fi

# ── Subcommand: local (local models) ──
if [ "$SUBCMD" = "local" ]; then
  ensure_running

  HOST_PORT="${PROVIDER:-}"

  if [ -z "$HOST_PORT" ]; then
    cat << 'RESPONSE'
{"text":"**Local Models**\n\nEnter your model server address.\n\nType: `@cliproxy connect local host.docker.internal:11434`","buttons":[[{"text":"Ollama (11434)","callback_data":"@cliproxy connect local host.docker.internal:11434"},{"text":"LM Studio (1234)","callback_data":"@cliproxy connect local host.docker.internal:1234"}],[{"text":"← Back","callback_data":"@cliproxy connect"}]],"format":"markdown"}
RESPONSE
    exit 0
  fi

  # Normalize: strip protocol prefix if present
  HOST_PORT=$(echo "$HOST_PORT" | sed 's|^https\?://||')

  # Validate HOST_PORT — only allow known local hostnames or literal private IPs (prevent SSRF)
  HOST="${HOST_PORT%%:*}"
  # Only allow known hostnames or numeric IPs matching private ranges
  case "$HOST" in
    localhost|127.0.0.1|host.docker.internal) ;; # OK — known local
    *)
      # Reject anything that isn't a numeric IP (blocks DNS-based SSRF like 10.evil.com)
      if ! echo "$HOST" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "ERROR: Only localhost, 127.0.0.1, host.docker.internal, or private IPs allowed (got: $HOST)"
        exit 1
      fi
      # Validate private IP ranges
      FIRST_OCTET="${HOST%%.*}"
      case "$FIRST_OCTET" in
        10) ;; # 10.0.0.0/8
        192)
          if ! echo "$HOST" | grep -qE '^192\.168\.'; then
            echo "ERROR: Only private IPs allowed (got: $HOST)"
            exit 1
          fi
          ;;
        172)
          SECOND_OCTET=$(echo "$HOST" | cut -d. -f2)
          if [ "$SECOND_OCTET" -ge 16 ] && [ "$SECOND_OCTET" -le 31 ] 2>/dev/null; then
            : # 172.16-31.0.0/12
          else
            echo "ERROR: Only private IPs allowed (got: $HOST)"
            exit 1
          fi
          ;;
        *)
          echo "ERROR: Only private IPs allowed (got: $HOST)"
          echo "Use localhost:<port>, 127.0.0.1:<port>, or a private IP."
          exit 1
          ;;
      esac
      ;;
  esac

  # Validate port is numeric
  PORT="${HOST_PORT##*:}"
  if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Invalid port: $PORT"
    exit 1
  fi

  echo "Discovering models at ${HOST_PORT}..."
  echo ""

  # Try OpenAI-compatible /v1/models first
  MODELS_JSON=""
  MODELS_JSON=$(curl -sf "http://${HOST_PORT}/v1/models" --max-time 10 2>/dev/null || true)

  if [ -n "$MODELS_JSON" ] && echo "$MODELS_JSON" | jq -e '.data' >/dev/null 2>&1; then
    MODEL_COUNT=$(echo "$MODELS_JSON" | jq '.data | length')
    if [ "$MODEL_COUNT" -gt 0 ]; then
      echo "Found ${MODEL_COUNT} model(s) via OpenAI API:"
      echo "$MODELS_JSON" | jq -r '.data[].id'
    else
      echo "Server responded but no models found."
      exit 1
    fi
  else
    # Try Ollama native API (/api/tags)
    OLLAMA_JSON=$(curl -sf "http://${HOST_PORT}/api/tags" --max-time 10 2>/dev/null || true)
    if [ -n "$OLLAMA_JSON" ] && echo "$OLLAMA_JSON" | jq -e '.models' >/dev/null 2>&1; then
      MODEL_COUNT=$(echo "$OLLAMA_JSON" | jq '.models | length')
      if [ "$MODEL_COUNT" -gt 0 ]; then
        echo "Found ${MODEL_COUNT} Ollama model(s):"
        echo "$OLLAMA_JSON" | jq -r '.models[].name'
      else
        echo "Ollama server responded but no models found. Pull a model first: ollama pull mistral"
        exit 1
      fi
    else
      echo "Could not reach ${HOST_PORT}. Make sure the server is running."
      echo ""
      echo "Tried:"
      echo "  http://${HOST_PORT}/v1/models (OpenAI API)"
      echo "  http://${HOST_PORT}/api/tags (Ollama API)"
      exit 1
    fi
  fi

  echo ""
  echo "To register these models with the platform, the local server must be"
  echo "accessible from your xAI Workspace instance. If running on the same"
  echo "machine, use localhost:${PORT}."
  echo ""

  # Register local models with the platform router
  ROUTER_URL="${ROUTER_URL:-${ANTHROPIC_BASE_URL%/v1}}"
  API_KEY="${ANTHROPIC_API_KEY:-local-only}"
  if [ -n "$ROUTER_URL" ] && [ "$ROUTER_URL" != "local-only" ]; then
    # Build model list from either API format
    if [ -n "$MODELS_JSON" ] && echo "$MODELS_JSON" | jq -e '.data' >/dev/null 2>&1; then
      MODELS=$(echo "$MODELS_JSON" | jq \
        '[.data[] | {name: ("ollama/" + .id), provider: "cliproxy"}]')
    else
      MODELS=$(echo "$OLLAMA_JSON" | jq \
        '[.models[] | {name: ("ollama/" + .name), provider: "cliproxy"}]')
    fi

    # Use jq to build registration JSON safely (PORT already validated as numeric)
    REG_BODY=$(jq -n --argjson models "$MODELS" --argjson port "$PORT" \
      '{models: $models, port: $port, registeredBy: "cliproxy-local"}')
    REG_RESULT=$(curl -sf -X POST "${ROUTER_URL}/api/models/register" \
      -H "Authorization: Bearer ${API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$REG_BODY" 2>/dev/null) || true
    if echo "$REG_RESULT" | jq -e '.ok' >/dev/null 2>&1; then
      REG_COUNT=$(echo "$REG_RESULT" | jq '.models | length')
      echo "Registered ${REG_COUNT} local model(s) with the platform. Type /models to switch."
    else
      echo "Model registration with platform failed. Models are still accessible directly."
    fi
  fi
  exit 0
fi

# ── Legacy: bare provider name (auto-detect category) ──
# For backward compatibility: @cliproxy connect claude → routes to sub flow
# @cliproxy connect grok → routes to apikey flow
if [[ " $CLI_PROVIDERS " == *" $SUBCMD "* ]]; then
  # Re-exec as sub flow
  exec bash "${APP_DIR}/scripts/connect.sh" sub "$SUBCMD"
fi

if [[ " $API_PROVIDERS " == *" $SUBCMD "* ]]; then
  # Re-exec as apikey flow
  exec bash "${APP_DIR}/scripts/connect.sh" apikey "$SUBCMD"
fi

# Unknown subcommand
echo "Unknown provider or subcommand: $SUBCMD"
echo ""
echo "Usage:"
echo "  @cliproxy connect                   — choose a category"
echo "  @cliproxy connect apikey [provider]  — connect an API key"
echo "  @cliproxy connect sub [provider]     — connect a CLI subscription"
echo "  @cliproxy connect local [host:port]  — connect local models"
echo ""
echo "Or use a provider name directly:"
echo "  @cliproxy connect claude             — CLI subscription"
echo "  @cliproxy connect grok               — API key"
exit 1
