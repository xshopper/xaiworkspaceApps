#!/bin/bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Workspace Agent install ==="
cp "$APP_DIR/bridge.js" /opt/bootstrap/bridge.js
chmod +x /opt/bootstrap/bridge.js
echo "Installed workspace-agent bridge.js"

# Restart in background after short delay so install_result can be sent first
(sleep 1 && pm2 restart workspace-agent --update-env 2>/dev/null) &
echo "=== Workspace Agent install complete (restarting) ==="
