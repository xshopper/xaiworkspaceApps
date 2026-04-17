#!/bin/bash
set -euo pipefail

echo "=== Done24Bot Browser Status ==="

# Check server. `|| true` so `set -e` does not abort when the server is
# simply not running — we want to surface a friendly NOT RUNNING message.
STATUS=$(curl -s http://127.0.0.1:3471/api/status 2>/dev/null || true)
if [ -z "$STATUS" ]; then
  echo "Server: NOT RUNNING"
  echo ""
  echo "Start with: bash ~/apps/com.done24bot.browser/scripts/start.sh"
  exit 1
fi

HAS_KEY=$(echo "$STATUS" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.hasApiKey?'yes':'no')}catch{console.log('no')}")
KEY_PREVIEW=$(echo "$STATUS" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.keyPreview||'none')}catch{console.log('none')}")

echo "Server: RUNNING on port 3471"
echo "API Key: $KEY_PREVIEW"

if [ "$HAS_KEY" = "no" ]; then
  echo ""
  echo "No API key configured."
  echo "Get one at: https://done24bot.com/api-keys"
  echo "Then run: bash ~/apps/com.done24bot.browser/scripts/setkey.sh <your-api-key>"
  exit 0
fi

# Test connection to done24bot
echo ""
echo "Testing connection to Done24Bot..."
RESULT=$(curl -s -X POST http://127.0.0.1:3471/api/browse -H 'Content-Type: application/json' -d '{"url":"about:blank"}' 2>/dev/null || true)
ERROR=$(echo "$RESULT" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.error||'')}catch{console.log('parse error')}")

if [ -n "$ERROR" ]; then
  echo "Connection: FAILED — $ERROR"
  echo ""
  echo "Make sure the Done24Bot Chrome extension is installed and connected."
else
  echo "Connection: OK"
fi
