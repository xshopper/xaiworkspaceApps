#!/bin/bash
# @audiobook generate <bookId> [voice] [speed]
set -euo pipefail
BASE="http://localhost:3210"
ID="${1:-}"
VOICE="${2:-}"
SPEED="${3:-}"

if [ -z "$ID" ]; then
  echo "Usage: @audiobook generate <bookId> [voice] [speed]"
  exit 1
fi

if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Audiobook not running."
  exit 1
fi

PAYLOAD='{}'
if [ -n "$VOICE" ]; then
  PAYLOAD=$(jq -n --arg v "$VOICE" '{voice: $v}')
fi
if [ -n "$SPEED" ]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq --argjson s "$SPEED" '. + {speed: $s}')
fi

RES=$(curl -sf -X POST "${BASE}/api/books/${ID}/generate" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" 2>&1) || {
  echo "Generate failed: $RES"
  exit 1
}

TOTAL=$(echo "$RES" | jq '.enqueued | length')
QUEUED=$(echo "$RES" | jq '[.enqueued[] | select(.status=="queued")] | length')
SKIPPED=$(echo "$RES" | jq '[.enqueued[] | select(.status=="skipped")] | length')

TEXT=$(printf "**Audiobook — generation queued**\n\nBook: \`%s\`\nTotal chapters: %s\nQueued: %s\nAlready generated: %s\n\nProgress will post to chat as chapters complete." "$ID" "$TOTAL" "$QUEUED" "$SKIPPED")

jq -n --arg text "$TEXT" --arg id "$ID" '{
  text: $text,
  buttons: [[
    {"text": "Status", "callback_data": ("@audiobook status")},
    {"text": "Play Ch1", "callback_data": ("@audiobook play " + $id + " 0")}
  ]],
  format: "markdown"
}'
