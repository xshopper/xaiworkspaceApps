#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: @done24bot extract <url> [css-selector]"
  echo "Example: @done24bot extract https://example.com h1"
  echo "Example: @done24bot extract https://news.site.com article"
  exit 1
fi

# Build JSON safely using node
DATA=$(node -e "process.stdout.write(JSON.stringify({url:process.argv[1],selector:process.argv[2]||'body'}))" -- "$1" "$2")
RESULT=$(curl -s -X POST http://127.0.0.1:3471/api/extract \
  -H 'Content-Type: application/json' \
  -d "$DATA" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESULT" ]; then
  echo "[done24bot] Server not running. Start with: bash ~/apps/com.done24bot.browser/scripts/start.sh"
  exit 1
fi

echo "$RESULT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  if (d.error) { console.log('Error: ' + d.error); process.exit(1); }
  console.log('Selector: ' + d.selector);
  console.log('Found: ' + d.count + ' element(s)');
  console.log('');
  for (const el of d.elements || []) {
    if (el.href) console.log('[' + el.tag + '] ' + el.text.slice(0, 200) + ' -> ' + el.href);
    else console.log('[' + el.tag + '] ' + el.text.slice(0, 500));
    console.log('');
  }
"
