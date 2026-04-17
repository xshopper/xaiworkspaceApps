#!/bin/bash
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: @done24bot screenshot <url>"
  echo "Example: @done24bot screenshot https://example.com"
  exit 1
fi

# Build JSON safely using node
DATA=$(node -e "process.stdout.write(JSON.stringify({url:process.argv[1],fullPage:false}))" -- "$1")
RESULT=$(curl -s -X POST http://127.0.0.1:3471/api/screenshot \
  -H 'Content-Type: application/json' \
  -d "$DATA" 2>/dev/null || true)

if [ -z "$RESULT" ]; then
  echo "[done24bot] Server not running. Start with: bash ~/apps/com.done24bot.browser/scripts/start.sh"
  exit 1
fi

echo "$RESULT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  if (d.error) { console.log('Error: ' + d.error); process.exit(1); }
  console.log('Screenshot saved: ' + d.path);
  console.log('Size: ' + (d.size / 1024).toFixed(1) + ' KB');
"
