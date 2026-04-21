#!/bin/bash
set -euo pipefail
# install.sh — Install OpenClaw gateway + bridge dependencies and generate pm2 config
#
# Expects: secrets.env already written by cloud-init with ROUTER_URL, CHAT_ID, etc.
# Called by the mini app install system or cloud-init.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== OpenClaw mini app install ==="

# ── 1. Install openclaw CLI + dependencies into app directory ───────────────
# Do NOT silence stderr — pnpm failures (network / ENOSPC / resolution
# conflicts) must surface in the install_result.error payload. The 55 MB
# openclaw tarball + postinstall hooks routinely take >120s on cold cold
# workers, so failure output is the only signal the bridge has about
# whether the node_modules tree is complete.
echo "Installing dependencies..."
cd "$APP_DIR" && pnpm install --prod --reporter=append-only

# ── 3. Persist bridge env vars to secrets.env (if not already present) ───────
SECRETS_FILE="/etc/xai/secrets.env"
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

# ── 4. Set up pm2 startup hook (survives EC2 reboot) ─────────────────────────
pm2 startup systemd -u root --hp /root 2>/dev/null || true

# ── 5. Configure OpenClaw gateway (auth + controlUi for Docker/LAN mode) ────
OC_DIR="$HOME/.openclaw"
OC_CONFIG="$OC_DIR/openclaw.json"
mkdir -p "$OC_DIR"
if [ ! -f "$OC_CONFIG" ]; then
  # First install — create config with password auth matching GW_PASSWORD
  GW_PASS="${GW_PASSWORD:-$(openssl rand -hex 16)}"
  node -e "
    const fs = require('fs');
    const cfg = {
      gateway: {
        mode: 'local',
        auth: { mode: 'password', password: process.env.GW_PASSWORD || '$GW_PASS' },
        controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
      },
    };
    fs.writeFileSync('$OC_CONFIG', JSON.stringify(cfg, null, 2));
    console.log('Created openclaw.json with password auth');
  "
else
  # Existing config — ensure auth mode is password and controlUi is set
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$OC_CONFIG', 'utf8'));
    if (!cfg.gateway) cfg.gateway = {};
    if (!cfg.gateway.auth) cfg.gateway.auth = {};
    // Switch from token to password mode if GW_PASSWORD is set
    if (process.env.GW_PASSWORD && cfg.gateway.auth.mode === 'token') {
      cfg.gateway.auth.mode = 'password';
      cfg.gateway.auth.password = process.env.GW_PASSWORD;
      delete cfg.gateway.auth.token;
      console.log('Switched gateway auth to password mode');
    }
    if (!cfg.gateway.controlUi) cfg.gateway.controlUi = {};
    cfg.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
    fs.writeFileSync('$OC_CONFIG', JSON.stringify(cfg, null, 2));
    console.log('Updated openclaw.json');
  "
fi

# ── 6. Generate ecosystem.config.js ─────────────────────────────────────────
bash "$APP_DIR/scripts/generate-ecosystem.sh"

echo "=== OpenClaw mini app install complete ==="
