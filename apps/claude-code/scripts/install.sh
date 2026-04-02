#!/bin/bash
set -euo pipefail
: "${HOME:?HOME is not set}"

APP_DIR="${HOME}/apps/com.xshopper.claude-code"

echo "=== Installing Claude Code mini-app ==="

# Install Node.js dependencies
echo "Installing npm dependencies..."
cd "${APP_DIR}" && npm install --production

# Check for claude CLI (optional — server uses the SDK directly)
if ! command -v claude &>/dev/null; then
  echo ""
  echo "Note: 'claude' CLI not found globally."
  echo "The server uses the Agent SDK directly, so the CLI is optional."
  echo "To install the CLI: npm install -g @anthropic-ai/claude-code"
fi

# Verify API key
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo ""
  echo "WARNING: ANTHROPIC_API_KEY is not set."
  echo "Set it before starting: export ANTHROPIC_API_KEY=sk-ant-..."
fi

echo ""
echo "Done. Start with: @claude-code start"
