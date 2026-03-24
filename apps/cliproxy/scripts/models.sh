#!/bin/bash
# List all models from CLIProxyAPI
set -euo pipefail

if ! curl -sf http://localhost:4001/health >/dev/null 2>&1; then
  echo "CLIProxyAPI not running. Run: ~/apps/com.xshopper.cliproxy/scripts/start.sh"
  exit 1
fi

echo "=== Available Models ==="
curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" \
  | jq -r '.data[] | "\(.owned_by // "unknown"): \(.id)"' 2>/dev/null || echo "No models available"
