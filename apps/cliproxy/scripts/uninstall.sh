#!/bin/bash
# Uninstall CLIProxyAPI — stop process, remove all files
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

echo "Stopping CLIProxyAPI..."
pkill -f "cli-proxy-api" 2>/dev/null || true
sleep 1

echo "Removing app directory..."
rm -rf "${APP_DIR}"

echo "Removing systemd service (if any)..."
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user stop cliproxy 2>/dev/null || true
systemctl --user disable cliproxy 2>/dev/null || true
rm -f ~/.config/systemd/user/cliproxy.service
systemctl --user daemon-reload 2>/dev/null || true

echo "✅ CLIProxy uninstalled"
