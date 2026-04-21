#!/bin/bash
# start-gateway.sh — Wrapper that sources secrets.env before starting OpenClaw
# Used by pm2 ecosystem config as the gateway entry point.
set -euo pipefail
set -a
# Prefer the per-user copy written by entrypoint.sh (mode 600, chown $WS_USER).
# /etc/xai/secrets.env is root-owned 600 — sourcing it as the derived user
# aborts the script under set -e with "Permission denied".
for SECRETS_FILE in "$HOME/.openclaw/secrets.env" /etc/xai/secrets.env; do
  if [ -r "$SECRETS_FILE" ]; then
    source "$SECRETS_FILE"
    break
  fi
done
set +a
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_BIN="${APP_DIR}/node_modules/.bin/openclaw"
# "$@" with zero args is safe under `set -u` (bash does not treat it as
# unset) — we keep it as-is.
exec "$OPENCLAW_BIN" gateway run "$@"
