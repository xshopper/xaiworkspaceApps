#!/bin/bash
# Token Market status — run by agent on @token-market status
set -euo pipefail
BASE="http://localhost:3460"

# Server check
if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  jq -n '{
    text: "**Token Market Status**\n\nServer: NOT RUNNING\n\nStart with: `bash ~/apps/com.xshopper.token-market/scripts/start.sh`",
    buttons: [[{"text": "Start Server", "callback_data": "@token-market start"}]],
    format: "markdown"
  }'
  exit 0
fi

# Get local models from cliproxy
MODELS=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null || echo '{"data":[]}')
MODEL_COUNT=$(echo "$MODELS" | jq '.data | length' 2>/dev/null || echo 0)

# Get user's listings
LISTINGS=$(curl -sf "${BASE}/listings/mine" -H "Authorization: Bearer ${ANTHROPIC_API_KEY:-local-only}" 2>/dev/null || echo '{"listings":[]}')
LISTING_COUNT=$(echo "$LISTINGS" | jq '.listings | length' 2>/dev/null || echo 0)

# Get subscriptions
SUBS=$(curl -sf "${BASE}/subscriptions" -H "Authorization: Bearer ${ANTHROPIC_API_KEY:-local-only}" 2>/dev/null || echo '{"subscriptions":[]}')
SUB_COUNT=$(echo "$SUBS" | jq '.subscriptions | length' 2>/dev/null || echo 0)

# Get health summary
HEALTH=$(curl -sf "${BASE}/health/keys" -H "Authorization: Bearer ${ANTHROPIC_API_KEY:-local-only}" 2>/dev/null || echo '{}')
UNHEALTHY=$(echo "$HEALTH" | jq '[to_entries[] | select(.value.state != "closed")] | length' 2>/dev/null || echo 0)

STATUS_TEXT=$(printf "**Token Market Status**\n\nServer: RUNNING on port 3460\n\n**Inventory**\n  Local models: %s\n  My listings: %s\n  Subscriptions: %s\n  Unhealthy keys: %s" "$MODEL_COUNT" "$LISTING_COUNT" "$SUB_COUNT" "$UNHEALTHY")

jq -n --arg text "$STATUS_TEXT" '{
  text: $text,
  buttons: [
    [{"text": "Browse Market", "callback_data": "@token-market browse"},
     {"text": "My Listings", "callback_data": "@token-market list"}],
    [{"text": "Health", "callback_data": "@token-market health"},
     {"text": "Revenue", "callback_data": "@token-market revenue"}]
  ],
  format: "markdown"
}'
