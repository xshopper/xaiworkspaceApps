#!/bin/bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Workspace Agent install ==="
cp "$APP_DIR/bridge.js" /opt/bootstrap/bridge.js
cp "$APP_DIR/manifest.yml" /opt/bootstrap/manifest.yml
chmod +x /opt/bootstrap/bridge.js
echo "Installed workspace-agent bridge.js + manifest.yml"

# Restart in background after short delay so install_result can be sent first
(sleep 3 && pm2 restart workspace-agent --update-env) &
echo "=== Workspace Agent install complete (restarting) ==="
