#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: @done24bot browse <url>"
  echo "Example: @done24bot browse https://example.com"
  exit 1
fi

# Build JSON safely using node
DATA=$(node -e "process.stdout.write(JSON.stringify({url:process.argv[1]}))" -- "$1")
RESULT=$(curl -s -X POST http://127.0.0.1:3471/api/browse \
  -H 'Content-Type: application/json' \
  -d "$DATA" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
  echo "[done24bot] Server not running. Start with: bash ~/apps/com.done24bot.browser/scripts/start.sh"
  exit 1
fi

echo "$RESULT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  if (d.error) { console.log('Error: ' + d.error); process.exit(1); }
  console.log('Title: ' + (d.title || '(none)'));
  console.log('URL: ' + (d.url || ''));
  console.log('');
  console.log(d.text || '(no content)');
"
