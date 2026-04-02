#!/bin/bash
# Show user's own listings — @token-market list
set -euo pipefail
BASE="http://localhost:3460"
TOKEN="${ANTHROPIC_API_KEY:-local-only}"

# Check server
if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Token Market not running. Run: @token-market start"
  exit 1
fi

# Get local models (available for listing)
MODELS=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null || echo '{"data":[]}')
MODEL_COUNT=$(echo "$MODELS" | jq '.data | length' 2>/dev/null || echo 0)

# Get current listings
LISTINGS=$(curl -sf "${BASE}/listings/mine" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null)
LISTING_COUNT=$(echo "$LISTINGS" | jq '.listings | length' 2>/dev/null || echo 0)

if [ "$LISTING_COUNT" -eq 0 ]; then
  MSG="You have no listings yet."
  if [ "$MODEL_COUNT" -gt 0 ]; then
    MODEL_LIST=$(echo "$MODELS" | jq -r '.data[].id' 2>/dev/null | head -10)
    MSG="${MSG}\n\nYou have **${MODEL_COUNT}** local model(s) available to list:\n\`\`\`\n${MODEL_LIST}\n\`\`\`"
  fi
  jq -n --arg text "**My Listings**\n\n${MSG}" \
    '{text: $text, buttons: [[{"text": "Create Listing", "callback_data": "@token-market pricing"}]], format: "markdown"}'
  exit 0
fi

# Format listing table
TABLE=$(echo "$LISTINGS" | jq -r '.listings[] |
  "  \(.display_name // .model_id)\n    Provider: \(.provider)  |  Active: \(.is_active)\n    Input: $\(.base_price_input_per_mtok // 0)/MTok  |  Output: $\(.base_price_output_per_mtok // 0)/MTok\n    Subscribers: \(.subscriber_count // 0)  |  ID: \(.id[0:8])"' 2>/dev/null)

jq -n --arg text "**My Listings** (${LISTING_COUNT})\n\n\`\`\`\n${TABLE}\n\`\`\`\n\nLocal models available: ${MODEL_COUNT}" \
  '{text: $text, buttons: [
    [{"text": "Create Listing", "callback_data": "@token-market pricing"},
     {"text": "Browse Market", "callback_data": "@token-market browse"}]
  ], format: "markdown"}'
