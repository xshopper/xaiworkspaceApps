#!/bin/bash
# Pricing strategies — @token-market pricing [model]
set -euo pipefail
BASE="http://localhost:3460"
TOKEN="${ANTHROPIC_API_KEY:-local-only}"
MODEL="${1:-}"

# Check server
if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Token Market not running. Run: @token-market start"
  exit 1
fi

# Get user's pricing strategies
STRATEGIES=$(curl -sf "${BASE}/pricing" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null || echo '{"strategies":[]}')
STRAT_COUNT=$(echo "$STRATEGIES" | jq '.strategies | length' 2>/dev/null || echo 0)

if [ "$STRAT_COUNT" -eq 0 ]; then
  jq -n '{
    text: "**Pricing Strategies**\n\nYou have no pricing strategies yet.\n\nA pricing strategy is a JavaScript function that computes the price per token.\nIt receives `{ inputTokens, outputTokens, model, time, feedData }` and must return `{ inputPricePerMTok, outputPricePerMTok }`.\n\n**Templates:**\n\n1. **Flat Rate** — fixed price per million tokens\n2. **Time-of-Day** — higher prices during peak hours\n3. **Demand-Responsive** — adjust based on feed data\n\nUse the panel UI to create and test strategies.",
    buttons: [
      [{"text": "Open Panel", "callback_data": "@token-market panel"},
       {"text": "My Listings", "callback_data": "@token-market list"}]
    ],
    format: "markdown"
  }'
  exit 0
fi

# Format strategies
TABLE=$(echo "$STRATEGIES" | jq -r '.strategies[] |
  "  \(.name)\n    Valid: \(.is_valid)  |  Max exec: \(.max_execution_ms)ms\n    ID: \(.id[0:8])  |  Updated: \(.updated_at[0:10])"' 2>/dev/null)

jq -n --arg text "**Pricing Strategies** (${STRAT_COUNT})\n\n\`\`\`\n${TABLE}\n\`\`\`\n\nUse the panel UI to edit, test, and assign strategies to listings." \
  '{text: $text, buttons: [
    [{"text": "Open Panel", "callback_data": "@token-market panel"},
     {"text": "My Listings", "callback_data": "@token-market list"}]
  ], format: "markdown"}'
