#!/bin/bash
# Browse marketplace listings — @token-market browse [provider]
set -euo pipefail
BASE="http://localhost:3460"
TOKEN="${ANTHROPIC_API_KEY:-local-only}"
PROVIDER="${1:-}"

# Check server
if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Token Market not running. Run: @token-market start"
  exit 1
fi

# Build query
QUERY=""
if [ -n "$PROVIDER" ]; then
  QUERY="?provider=${PROVIDER}"
fi

LISTINGS=$(curl -sf "${BASE}/listings${QUERY}" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null)
COUNT=$(echo "$LISTINGS" | jq '.listings | length' 2>/dev/null || echo 0)

if [ "$COUNT" -eq 0 ]; then
  if [ -n "$PROVIDER" ]; then
    MSG="No listings found for provider: **${PROVIDER}**"
  else
    MSG="No listings on the marketplace yet."
  fi
  jq -n --arg text "**Token Market**\n\n${MSG}\n\nBe the first to list your models!" \
    '{text: $text, buttons: [[{"text": "List My Models", "callback_data": "@token-market list"}]], format: "markdown"}'
  exit 0
fi

# Format listing table
TABLE=$(echo "$LISTINGS" | jq -r '.listings[] |
  "  \(.display_name // .model_id) (\(.provider))\n    Seller: \(.seller_id[0:8])..  |  Input: $\(.base_price_input_per_mtok // "?")/MTok  |  Output: $\(.base_price_output_per_mtok // "?")/MTok\n    Health: \(.health_state // "unknown")  |  ID: \(.id[0:8])"' 2>/dev/null)

HEADER="**Token Market — Browse**\n\n${COUNT} listing(s) available"
if [ -n "$PROVIDER" ]; then
  HEADER="${HEADER} for **${PROVIDER}**"
fi

# Build subscribe buttons for first 5 listings
BUTTONS=$(echo "$LISTINGS" | jq '[.listings[:5][] | {"text": ("Subscribe: " + (.display_name // .model_id)[:30]), "callback_data": ("@token-market subscribe " + .id)}]' 2>/dev/null || echo '[]')

jq -n --arg text "${HEADER}\n\n\`\`\`\n${TABLE}\n\`\`\`" --argjson buttons "$BUTTONS" \
  '{text: $text, buttons: [$buttons], format: "markdown"}'
