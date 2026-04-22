#!/bin/bash
# @audiobook voices — list recorded voice samples
set -euo pipefail
BASE="http://localhost:3210"

if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Audiobook not running."
  exit 1
fi

RES=$(curl -sf "${BASE}/api/voices" 2>/dev/null || echo '{"voices":[]}')
COUNT=$(echo "$RES" | jq '.voices | length' 2>/dev/null || echo 0)

if [ "$COUNT" -eq 0 ]; then
  jq -n '{text: "**Voices**\n\nNo recorded voices. Open the Audiobook panel → Voice tab to record one.", format: "markdown"}'
  exit 0
fi

TABLE=$(echo "$RES" | jq -r '.voices[] |
  "  \(.label)  —  \(.durationSec)s  —  id: \(.id)  —  ready: \(.engineReady)"' 2>/dev/null)

jq -n --arg text "**Voices (${COUNT})**\n\n\`\`\`\n${TABLE}\n\`\`\`\n\n_Voice cloning engine lands in a later phase._" \
  '{text: $text, format: "markdown"}'
