#!/bin/bash
# Key health & circuit breaker status — @token-market health
set -euo pipefail
BASE="http://localhost:3460"
TOKEN="${ANTHROPIC_API_KEY:-local-only}"

# Check server
if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Token Market not running. Run: @token-market start"
  exit 1
fi

HEALTH=$(curl -sf "${BASE}/health/keys" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null || echo '{}')
ENTRIES=$(echo "$HEALTH" | jq 'to_entries | length' 2>/dev/null || echo 0)

if [ "$ENTRIES" -eq 0 ]; then
  jq -n '{
    text: "**Key Health**\n\nNo health data yet. Health tracking starts when your listings receive traffic.",
    buttons: [[{"text": "My Listings", "callback_data": "@token-market list"}]],
    format: "markdown"
  }'
  exit 0
fi

# Count by state
CLOSED=$(echo "$HEALTH" | jq '[to_entries[] | select(.value.state == "closed")] | length' 2>/dev/null || echo 0)
OPEN=$(echo "$HEALTH" | jq '[to_entries[] | select(.value.state == "open")] | length' 2>/dev/null || echo 0)
HALF=$(echo "$HEALTH" | jq '[to_entries[] | select(.value.state == "half_open")] | length' 2>/dev/null || echo 0)

# Format details
TABLE=$(echo "$HEALTH" | jq -r 'to_entries[] |
  "  \(.key[0:8])..  State: \(.value.state)  Failures: \(.value.failureCount)\n    Last failure: \(.value.lastFailureReason // "none")\n    Disabled until: \(.value.disabledUntil // "n/a")"' 2>/dev/null)

jq -n --arg text "**Key Health**\n\nHealthy (closed): ${CLOSED}\nDisabled (open): ${OPEN}\nTesting (half_open): ${HALF}\n\n\`\`\`\n${TABLE}\n\`\`\`" \
  '{text: $text, buttons: [
    [{"text": "Refresh", "callback_data": "@token-market health"},
     {"text": "My Listings", "callback_data": "@token-market list"}]
  ], format: "markdown"}'
