#!/bin/bash
# Start CLIProxyAPI (if not already running)
set -euo pipefail
APP_DIR="${HOME}/apps/com.xshopper.cliproxy"

if curl -sf http://localhost:4001/health >/dev/null 2>&1; then
  echo "CLIProxyAPI already running on port 4001"
  exit 0
fi

if [ ! -x "${APP_DIR}/bin/cli-proxy-api" ]; then
  echo "ERROR: CLIProxyAPI not installed. Run: ~/apps/com.xshopper.cliproxy/scripts/install.sh"
  exit 1
fi

cd "${APP_DIR}"
nohup ./bin/cli-proxy-api --config config.yaml >> cliproxy.log 2>&1 &
sleep 2

if curl -sf http://localhost:4001/health >/dev/null 2>&1; then
  echo "CLIProxyAPI started on port 4001"
else
  echo "ERROR: Failed to start. Check ~/apps/com.xshopper.cliproxy/cliproxy.log"
  exit 1
fi
