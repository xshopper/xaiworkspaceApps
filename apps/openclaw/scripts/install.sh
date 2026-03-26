#!/bin/bash
set -euo pipefail
# install.sh — Install OpenClaw gateway + bridge dependencies and generate pm2 config
#
# Expects: secrets.env already written by cloud-init with ROUTER_URL, CHAT_ID, etc.
# Called by the mini app install system or cloud-init.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== OpenClaw mini app install ==="

# ── 1. Install pm2 globally if missing ──────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo "Installing pm2..."
  npm install -g pm2 --loglevel=error
fi

# ── 2. Install bridge dependencies (ws) ─────────────────────────────────────
if [ ! -d "$APP_DIR/node_modules/ws" ] || [ ! -d "$APP_DIR/node_modules/js-yaml" ]; then
  echo "Installing bridge dependencies..."
  cd "$APP_DIR" && npm install --omit=dev --loglevel=error
fi

# ── 3. Persist bridge env vars to secrets.env (if not already present) ───────
SECRETS_FILE="/etc/openclaw/secrets.env"
if [ -f "$SECRETS_FILE" ]; then
  # Add INSTANCE_ID if available and not already in file
  if [ -n "${INSTANCE_ID:-}" ] && ! grep -q '^INSTANCE_ID=' "$SECRETS_FILE" 2>/dev/null; then
    echo "INSTANCE_ID=${INSTANCE_ID}" >> "$SECRETS_FILE"
  fi
  if [ -n "${INSTANCE_TOKEN:-}" ] && ! grep -q '^INSTANCE_TOKEN=' "$SECRETS_FILE" 2>/dev/null; then
    echo "INSTANCE_TOKEN=${INSTANCE_TOKEN}" >> "$SECRETS_FILE"
  fi
  if [ -n "${PORT:-}" ] && ! grep -q '^PORT=' "$SECRETS_FILE" 2>/dev/null; then
    echo "PORT=${PORT}" >> "$SECRETS_FILE"
  fi
  if [ -n "${GW_PASSWORD:-}" ] && ! grep -q '^GW_PASSWORD=' "$SECRETS_FILE" 2>/dev/null; then
    echo "GW_PASSWORD=${GW_PASSWORD}" >> "$SECRETS_FILE"
  fi
fi

# ── 4. Install stunnel if missing ───────────────────────────────────────────
if ! command -v stunnel &>/dev/null; then
  echo "Installing stunnel..."
  apt-get update -qq 2>/dev/null && apt-get install -y -qq stunnel4 2>/dev/null || echo "WARNING: stunnel install failed"
fi

# ── 5. Set up pm2 startup hook (survives EC2 reboot) ─────────────────────────
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# ── 6. Generate ecosystem.config.js ─────────────────────────────────────────
bash "$APP_DIR/scripts/generate-ecosystem.sh"

echo "=== OpenClaw mini app install complete ==="
