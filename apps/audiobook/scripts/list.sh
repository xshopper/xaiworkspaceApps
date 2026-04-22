#!/bin/bash
# @audiobook list — show library
set -euo pipefail
BASE="http://localhost:3210"

if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Audiobook not running."
  exit 1
fi

BOOKS=$(curl -sf "${BASE}/api/books" 2>/dev/null || echo '{"books":[]}')
COUNT=$(echo "$BOOKS" | jq '.books | length' 2>/dev/null || echo 0)

if [ "$COUNT" -eq 0 ]; then
  jq -n '{text: "**Library empty**\n\nUse `@audiobook search <query>` to find books.", format: "markdown"}'
  exit 0
fi

TABLE=$(echo "$BOOKS" | jq -r '.books[] |
  "  \(.title)\n    by \(.author)  —  \(.chapters | length) chapters  —  id: \(.id)"' 2>/dev/null)

BUTTONS=$(echo "$BOOKS" | jq '[.books[:5][] | {"text": ("Chapters: " + (.title[:30])), "callback_data": ("@audiobook chapters " + .id)}]' 2>/dev/null || echo '[]')

jq -n --arg text "**Library — ${COUNT} book(s)**\n\n\`\`\`\n${TABLE}\n\`\`\`" --argjson buttons "$BUTTONS" \
  '{text: $text, buttons: [$buttons], format: "markdown"}'
