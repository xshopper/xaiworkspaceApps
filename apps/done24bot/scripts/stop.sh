#!/usr/bin/env bash
set -euo pipefail
# Stop done24bot server process. `|| true` already swallows pkill's
# "no processes matched" exit 1, so this is compatible with `set -e`.
pkill -u "$(id -u)" -f 'done24bot.*server.js' 2>/dev/null || true
