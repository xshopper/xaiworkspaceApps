#!/bin/bash
# Stop Token Market server
set -euo pipefail
pm2 delete token-market-server 2>/dev/null || true
pkill -u "$(id -u)" -f 'token-market/server.js' 2>/dev/null || true
echo "Token Market stopped"
