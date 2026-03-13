#!/bin/bash
# test-expense-tracker.sh — Test the Expense Tracker app (apps/expense-tracker)
# Usage: ./test/test-expense-tracker.sh

set -euo pipefail
PASS=0; FAIL=0; SKIP=0

red()   { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$1"; }
info()  { printf "\033[36m%s\033[0m\n" "$1"; }

assert() {
  if [ "$2" = "true" ]; then green "  PASS: $1"; PASS=$((PASS+1))
  else red "  FAIL: $1"; FAIL=$((FAIL+1)); fi
}

skip() { yellow "  SKIP: $1"; SKIP=$((SKIP+1)); }

# ============================================================================
info "=== Phase 1: Core Functionality ==="
# User flow:
#   User: "@expense-tracker add lunch $15.50 at cafe"
#   Bot:  "Recorded: Lunch — $15.50 (Food & Dining). Confirm? [yes]"
#   User: "yes"
#   Bot:  "Expense saved. Today's total: $42.30"
#
# Expected: bot confirms amount, categorizes, stores in local DB
# ============================================================================

info "  Manual test: send '@expense-tracker add coffee $4.50'"
info "  Expected: bot confirms amount, assigns category, saves"
info "  Manual test: send '@expense-tracker show this week'"
info "  Expected: bot lists expenses grouped by category with totals"

# ============================================================================
info ""
info "=== Phase 2: Receipt Processing ==="
# User flow:
#   User: (uploads photo of receipt)
#   Bot:  "Receipt from Staples — $127.43
#          Items: Printer paper ($24.99), Ink cartridge ($89.99), Pens ($12.45)
#          Category: Office Supplies. Save?"
#
# Expected: file.uploaded trigger fires, bot extracts data from image
# ============================================================================

info "  Trigger: event file.uploaded (image/jpeg, image/png, application/pdf)"
info "  Manual test: upload a receipt photo"
info "  Expected: bot extracts vendor, amount, items, categorizes automatically"

# ============================================================================
info ""
info "=== Phase 3: Google Sheets Export ==="
# User flow:
#   User: "@expense-tracker export March report to sheets"
#   Bot:  "Exporting 47 expenses ($2,341.50) to Google Sheets..."
#   Bot:  "Report created: [link to spreadsheet]"  [requires approval]
#
# Expected: requires Google OAuth, creates spreadsheet with expense data
# ============================================================================

GOOGLE_CONNECTED="false"
if command -v oc-secret &>/dev/null; then
  if oc-secret list 2>/dev/null | grep -q 'oauth/google'; then
    GOOGLE_CONNECTED="true"
  fi
fi

if [ "$GOOGLE_CONNECTED" = "true" ]; then
  TOKEN=$(oc-secret get oauth/google --field accessToken 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "https://sheets.googleapis.com/v4/spreadsheets" 2>/dev/null || echo "000")
    # 400 is expected (no body), but proves API is reachable with token
    assert "Google Sheets API reachable (got: $HTTP_CODE)" \
      "$([ "$HTTP_CODE" != "401" ] && [ "$HTTP_CODE" != "000" ] && echo true || echo false)"
  fi
else
  skip "Google Sheets export test — Google not connected"
  info "  To enable: run /authorize and connect Google"
fi

info "  Manual test: send '@expense-tracker export this month'"
info "  Expected: bot asks approval (report.export), then creates spreadsheet"

# ============================================================================
info ""
info "=== Phase 4: Approval Gates ==="
# Expected: expense.delete and report.export require user approval
# ============================================================================

info "  approvalRequired: expense.delete, report.export"
info "  Manual test: send '@expense-tracker delete last expense'"
info "  Expected: bot shows expense details and asks for explicit approval"

# ============================================================================
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
