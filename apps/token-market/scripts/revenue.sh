#!/bin/bash
# Revenue & expense summary — @token-market revenue
set -euo pipefail
BASE="http://localhost:3460"
TOKEN="${ANTHROPIC_API_KEY:-local-only}"

# Check server
if ! curl -sf "${BASE}/health" >/dev/null 2>&1; then
  echo "Token Market not running. Run: @token-market start"
  exit 1
fi

SUMMARY=$(curl -sf "${BASE}/revenue/summary" -H "Authorization: Bearer ${TOKEN}" 2>/dev/null || echo '{}')

# Extract values with defaults
TOTAL_REV=$(echo "$SUMMARY" | jq -r '.total_revenue_cents // 0' 2>/dev/null)
TOTAL_EXP=$(echo "$SUMMARY" | jq -r '.total_expense_cents // 0' 2>/dev/null)
TOTAL_FEE=$(echo "$SUMMARY" | jq -r '.total_platform_fee_cents // 0' 2>/dev/null)
TOTAL_CALLS=$(echo "$SUMMARY" | jq -r '.total_calls // 0' 2>/dev/null)
TODAY_REV=$(echo "$SUMMARY" | jq -r '.today_revenue_cents // 0' 2>/dev/null)
TODAY_CALLS=$(echo "$SUMMARY" | jq -r '.today_calls // 0' 2>/dev/null)

# Convert cents to dollars
REV_DOLLARS=$(echo "scale=2; ${TOTAL_REV} / 100" | bc 2>/dev/null || echo "0.00")
EXP_DOLLARS=$(echo "scale=2; ${TOTAL_EXP} / 100" | bc 2>/dev/null || echo "0.00")
FEE_DOLLARS=$(echo "scale=2; ${TOTAL_FEE} / 100" | bc 2>/dev/null || echo "0.00")
TODAY_DOLLARS=$(echo "scale=2; ${TODAY_REV} / 100" | bc 2>/dev/null || echo "0.00")

jq -n --arg text "**Revenue Summary**\n\n**All Time**\n  Revenue: \$${REV_DOLLARS}\n  Expenses: \$${EXP_DOLLARS}\n  Platform fees: \$${FEE_DOLLARS}\n  Total calls: ${TOTAL_CALLS}\n\n**Today**\n  Revenue: \$${TODAY_DOLLARS}\n  Calls: ${TODAY_CALLS}" \
  '{text: $text, buttons: [
    [{"text": "Refresh", "callback_data": "@token-market revenue"},
     {"text": "Open Panel", "callback_data": "@token-market panel"}]
  ], format: "markdown"}'
