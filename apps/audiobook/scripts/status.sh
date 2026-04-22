#!/bin/bash
# Audiobook status — run by agent on @audiobook status
set -euo pipefail
BASE="http://localhost:3210"

if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  jq -n '{
    text: "**Audiobook**\n\nServer: NOT RUNNING\n\nStart via `pm2 start audiobook` or reinstall the app.",
    format: "markdown"
  }'
  exit 0
fi

BOOKS=$(curl -sf "${BASE}/api/books" 2>/dev/null || echo '{"books":[]}')
COUNT=$(echo "$BOOKS" | jq '.books | length' 2>/dev/null || echo 0)

TEXT=$(printf "**Audiobook Status**\n\nServer: RUNNING on port 3210\nLibrary: %s book(s)\n\nCommands: search, import, list, chapters" "$COUNT")

jq -n --arg text "$TEXT" '{
  text: $text,
  buttons: [
    [{"text": "Discover", "callback_data": "@audiobook search "},
     {"text": "Library", "callback_data": "@audiobook list"}]
  ],
  format: "markdown"
}'
