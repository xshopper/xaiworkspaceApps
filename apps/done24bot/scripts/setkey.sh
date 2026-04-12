#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: bash scripts/setkey.sh <api-key>"
  echo ""
  echo "Get your API key at: https://done24bot.com/api-keys"
  exit 1
fi

# Build JSON safely using node
DATA=$(node -e "process.stdout.write(JSON.stringify({apiKey:process.argv[1]}))" -- "$1")
RESULT=$(curl -s -X POST http://127.0.0.1:3470/api/config \
  -H 'Content-Type: application/json' \
  -d "$DATA" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
  # Server not running — write config directly using process.argv (no shell interpolation)
  node -e "
    const fs = require('fs'), path = require('path');
    const configPath = path.join(process.argv[1], 'config.json');
    const c = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath,'utf8')) : {};
    c.apiKey = process.argv[2];
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
    console.log('[done24bot] API key saved (server not running)');
  " "$HOME/apps/com.done24bot.browser" "$1"
  exit 0
fi

echo "$RESULT" | node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (d.ok) console.log('[done24bot] API key saved: ' + d.keyPreview);
    else console.log('[done24bot] Error: ' + (d.error || 'unknown'));
  } catch { console.log('[done24bot] Unexpected response'); }
"
