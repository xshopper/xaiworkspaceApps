#!/bin/bash
# @audiobook play <bookId> [chapterIdx]
# Emits an audio card so the chat UI can play the mp3 directly.
set -euo pipefail
BASE="http://localhost:3210"
ID="${1:-}"
IDX="${2:-0}"

if [ -z "$ID" ]; then
  echo "Usage: @audiobook play <bookId> [chapterIdx]"
  exit 1
fi

if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Audiobook not running."
  exit 1
fi

META=$(curl -sf "${BASE}/api/books/${ID}" 2>/dev/null) || {
  echo "Book not found: $ID"
  exit 1
}
TITLE=$(echo "$META" | jq -r '.title')
CHAP=$(echo "$META" | jq -r --argjson i "$IDX" '.chapters[$i].title // ("Chapter " + ($i|tostring))')

AUDIO_URL="${BASE}/api/books/${ID}/chapters/${IDX}/audio"

TEXT=$(printf "**Now Playing**\n\n**%s**\nChapter %s: %s\n\n[Audio](%s)" "$TITLE" "$((IDX+1))" "$CHAP" "$AUDIO_URL")

jq -n --arg text "$TEXT" --arg url "$AUDIO_URL" --arg id "$ID" --arg idx "$IDX" '{
  text: $text,
  audio: {url: $url, title: "Audiobook"},
  buttons: [[
    {"text": "Prev", "callback_data": ("@audiobook play " + $id + " " + (($idx|tonumber-1)|tostring))},
    {"text": "Next", "callback_data": ("@audiobook play " + $id + " " + (($idx|tonumber+1)|tostring))},
    {"text": "Chapters", "callback_data": ("@audiobook chapters " + $id)}
  ]],
  format: "markdown"
}'
