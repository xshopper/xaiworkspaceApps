#!/bin/bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Workspace Agent install ==="
echo "APP_DIR=$APP_DIR"
ls -la "$APP_DIR" || true

cp "$APP_DIR/bridge.js" /opt/bootstrap/bridge.js
cp "$APP_DIR/manifest.yml" /opt/bootstrap/manifest.yml
chmod +x /opt/bootstrap/bridge.js

# Write the version to a dedicated env file so bridge.js can read it
# without parsing YAML when manifest.yml placement varies across images.
VERSION="$(grep -E '^version:' "$APP_DIR/manifest.yml" | sed -E 's/^version:[[:space:]]*["'\''"]?([^[:space:]"'\''"]+).*/\1/')"
echo "AGENT_VERSION=$VERSION" > /opt/bootstrap/agent-version.env
echo "Installed bridge.js + manifest.yml + agent-version.env (v$VERSION)"
ls -la /opt/bootstrap/

# Restart in background after short delay so install_result can be sent first
(sleep 3 && pm2 restart workspace-agent --update-env) &
echo "=== Workspace Agent install complete (restarting) ==="
