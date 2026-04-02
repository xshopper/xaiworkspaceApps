#!/bin/bash
# start-gateway.sh — Wrapper that sources secrets.env before starting OpenClaw
# Used by pm2 ecosystem config as the gateway entry point.
set -a
[ -f /etc/xai/secrets.env ] && source /etc/xai/secrets.env
set +a
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_BIN="${APP_DIR}/node_modules/.bin/openclaw"
exec "$OPENCLAW_BIN" gateway run "$@"
