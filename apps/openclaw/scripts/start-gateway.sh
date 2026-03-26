#!/bin/bash
# start-gateway.sh — Wrapper that sources secrets.env before starting OpenClaw
# Used by pm2 ecosystem config as the gateway entry point.
set -a
[ -f /etc/openclaw/secrets.env ] && source /etc/openclaw/secrets.env
set +a
OPENCLAW_BIN=$(command -v openclaw 2>/dev/null || echo /usr/local/bin/openclaw)
exec "$OPENCLAW_BIN" gateway run "$@"
