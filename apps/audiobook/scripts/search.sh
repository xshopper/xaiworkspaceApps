#!/bin/bash
# @audiobook search <query> — search Project Gutenberg
set -euo pipefail
BASE="http://localhost:3210"
QUERY="${*:-}"

if [ -z "$QUERY" ]; then
  echo "Usage: @audiobook search <query>"
  exit 1
fi

if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Audiobook not running."
  exit 1
fi

RES=$(curl -sf --get "${BASE}/api/search" --data-urlencode "q=${QUERY}" 2>/dev/null)
COUNT=$(echo "$RES" | jq '.results | length' 2>/dev/null || echo 0)

if [ "$COUNT" -eq 0 ]; then
  jq -n --arg q "$QUERY" '{text: ("No Gutenberg results for **" + $q + "**"), format: "markdown"}'
  exit 0
fi

TABLE=$(echo "$RES" | jq -r '.results[:10][] |
  "  \(.title)\n    by \(.author)  —  id: \(.id)"' 2>/dev/null)

BUTTONS=$(echo "$RES" | jq '[.results[:5][] | {"text": ("Import: " + (.title[:40])), "callback_data": ("@audiobook import " + .id)}]' 2>/dev/null || echo '[]')

jq -n --arg text "**Gutenberg — ${COUNT} result(s)**\n\n\`\`\`\n${TABLE}\n\`\`\`" --argjson buttons "$BUTTONS" \
  '{text: $text, buttons: [$buttons], format: "markdown"}'
