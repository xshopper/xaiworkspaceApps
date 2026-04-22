#!/bin/bash
# @audiobook import <url|gutenberg-id>
set -euo pipefail
BASE="http://localhost:3210"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  echo "Usage: @audiobook import <url|gutenberg-id>"
  exit 1
fi

if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Audiobook not running."
  exit 1
fi

# gutenberg-123 or bare integer → use gutenbergId
if [[ "$TARGET" =~ ^(gutenberg-)?([0-9]+)$ ]]; then
  GID="${BASH_REMATCH[2]}"
  PAYLOAD=$(jq -n --argjson id "$GID" '{gutenbergId: $id}')
else
  PAYLOAD=$(jq -n --arg url "$TARGET" '{sourceUrl: $url}')
fi

RES=$(curl -sf -X POST "${BASE}/api/books/import" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>&1) || {
  echo "Import failed: $RES"
  exit 1
}

TITLE=$(echo "$RES" | jq -r '.title')
AUTHOR=$(echo "$RES" | jq -r '.author')
CHAPS=$(echo "$RES" | jq '.chapters | length')
ID=$(echo "$RES" | jq -r '.id')

TEXT=$(printf "**Imported**\n\n**%s**\nby %s\n\nChapters: %s\nID: \`%s\`" "$TITLE" "$AUTHOR" "$CHAPS" "$ID")

jq -n --arg text "$TEXT" --arg id "$ID" '{
  text: $text,
  buttons: [[
    {"text": "Chapters", "callback_data": ("@audiobook chapters " + $id)},
    {"text": "Library", "callback_data": "@audiobook list"}
  ]],
  format: "markdown"
}'
