#!/bin/bash
# @audiobook chapters <bookId>
set -euo pipefail
BASE="http://localhost:3210"
ID="${1:-}"

if [ -z "$ID" ]; then
  echo "Usage: @audiobook chapters <bookId>"
  exit 1
fi

if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Audiobook not running."
  exit 1
fi

RES=$(curl -sf "${BASE}/api/books/${ID}/chapters" 2>/dev/null) || {
  echo "Book not found: $ID"
  exit 1
}

COUNT=$(echo "$RES" | jq '.chapters | length' 2>/dev/null || echo 0)

TABLE=$(echo "$RES" | jq -r '.chapters[] |
  "  \(.idx + 1). \(.title)  (\(.endChar - .startChar) chars)"' 2>/dev/null)

jq -n --arg text "**${COUNT} chapter(s)**\n\n\`\`\`\n${TABLE}\n\`\`\`\n\n_Audio generation lands in Phase 2._" \
  '{text: $text, format: "markdown"}'
