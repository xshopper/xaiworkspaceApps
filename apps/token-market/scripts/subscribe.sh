#!/bin/bash
# Subscribe to a listing — @token-market subscribe <listing-id>
set -euo pipefail
BASE="http://localhost:3460"
TOKEN="${ANTHROPIC_API_KEY:-local-only}"
LISTING_ID="${1:-}"

if [ -z "$LISTING_ID" ]; then
  jq -n '{
    text: "**Subscribe to a Listing**\n\nUsage: `@token-market subscribe <listing-id>`\n\nBrowse listings first to find an ID.",
    buttons: [[{"text": "Browse Market", "callback_data": "@token-market browse"}]],
    format: "markdown"
  }'
  exit 0
fi

# Check server
if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Token Market not running. Run: @token-market start"
  exit 1
fi

# Subscribe
RESULT=$(curl -sf -X POST "${BASE}/subscriptions/${LISTING_ID}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" 2>/dev/null)

if [ $? -ne 0 ]; then
  jq -n --arg id "$LISTING_ID" '{
    text: ("**Subscribe Failed**\n\nCould not subscribe to listing " + $id + ". It may not exist or be inactive."),
    buttons: [[{"text": "Browse Market", "callback_data": "@token-market browse"}]],
    format: "markdown"
  }'
  exit 0
fi

# Extract virtual key (masked)
VKEY=$(echo "$RESULT" | jq -r '.virtual_key // "pending"' 2>/dev/null)
MODEL=$(echo "$RESULT" | jq -r '.listing.model_id // "unknown"' 2>/dev/null)
SELLER=$(echo "$RESULT" | jq -r '.listing.seller_id // "unknown"' 2>/dev/null)

if [ "$VKEY" = "pending" ] || [ "$VKEY" = "null" ]; then
  VKEY_DISPLAY="Pending (virtual key generation in progress)"
else
  # Show only first 8 chars of virtual key
  VKEY_DISPLAY="${VKEY:0:8}..."
fi

jq -n --arg model "$MODEL" --arg vkey "$VKEY_DISPLAY" --arg seller "${SELLER:0:8}" '{
  text: ("**Subscribed!**\n\nModel: " + $model + "\nSeller: " + $seller + "...\nVirtual Key: `" + $vkey + "`\n\nUse this virtual key in your API calls. The real API key is never exposed."),
  buttons: [
    [{"text": "My Subscriptions", "callback_data": "@token-market status"},
     {"text": "Browse More", "callback_data": "@token-market browse"}]
  ],
  format: "markdown"
}'
