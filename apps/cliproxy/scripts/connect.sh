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

# CLI subscription providers — use built-in OAuth
CLI_PROVIDERS="claude codex gemini qwen iflow"
if echo "$CLI_PROVIDERS" | grep -qw "$PROVIDER"; then
  echo "Starting OAuth for ${PROVIDER}..."
  cd "${APP_DIR}" && ./bin/cli-proxy-api auth add "$PROVIDER"
  exit $?
fi

# API key providers — need key as second argument or prompt
echo "API key provider: ${PROVIDER}"
echo "Please provide your API key (it will be added to config.yaml)"
echo "Pass it as: connect.sh ${PROVIDER} YOUR_KEY"
