#!/bin/bash
# start-gateway.sh — Wrapper that sources secrets.env before starting OpenClaw
# Used by pm2 ecosystem config as the gateway entry point.
set -euo pipefail
set -a
[ -f /etc/xai/secrets.env ] && source /etc/xai/secrets.env
set +a
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_BIN="${APP_DIR}/node_modules/.bin/openclaw"
# "$@" with zero args is safe under `set -u` (bash does not treat it as
# unset) — we keep it as-is.
exec "$OPENCLAW_BIN" gateway run "$@"
