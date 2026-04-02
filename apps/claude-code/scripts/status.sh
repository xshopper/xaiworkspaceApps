#!/bin/bash
# status.sh — Show Claude Code server health and environment
# No set -euo pipefail: status checks use || fallbacks intentionally
: "${HOME:?HOME is not set}"

APP_DIR="${HOME}/apps/com.xshopper.claude-code"
PORT="${APP_PORT:-3457}"

echo "=== Claude Code Server ==="
if pm2 describe claude-code-server &>/dev/null; then
  pm2 list --no-color 2>/dev/null | grep -E "Name|claude-code"
else
  echo "Process: not registered with pm2"
fi

echo ""
echo "=== Server Health ==="
if curl -s --connect-timeout 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
  echo ""
else
  echo "Server not reachable on port ${PORT}"
fi

echo ""
echo "=== Claude CLI ==="
if command -v claude &>/dev/null; then
  echo "Claude CLI: $(claude --version 2>/dev/null || echo 'installed')"
else
  echo "Claude CLI: not found"
  echo "Install with: npm install -g @anthropic-ai/claude-code"
fi

echo ""
echo "=== Environment ==="
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ANTHROPIC_API_KEY: set (${#ANTHROPIC_API_KEY} chars)"
else
  echo "ANTHROPIC_API_KEY: NOT SET"
  echo "Set it: export ANTHROPIC_API_KEY=sk-ant-..."
fi
echo "Working dir: ${CLAUDE_CODE_CWD:-${HOME}}"
echo "Port: ${PORT}"
