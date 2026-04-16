#!/bin/bash
# test-expense-tracker.sh — Test the Expense Tracker app (apps/expense-tracker).
# Usage: ./test/test-expense-tracker.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0

info "=== Phase 1: Core Functionality (manual) ==="
info "  '@expense-tracker add coffee \$4.50' — confirms amount, assigns category, saves"
info "  '@expense-tracker show this week' — lists expenses by category with totals"

info ""
info "=== Phase 2: Receipt Processing (manual) ==="
info "  Trigger: event file.uploaded (image/jpeg, image/png, application/pdf)"
info "  Upload receipt photo — bot extracts vendor/amount/items and categorizes"

info ""
info "=== Phase 3: Google Sheets Export ==="
if oauth_connected google; then
  TOKEN=$(oauth_token google)
  if [ -n "$TOKEN" ]; then
    HTTP=$(http_code "https://sheets.googleapis.com/v4/spreadsheets" \
      "Authorization: Bearer $TOKEN")
    # 400 is expected (empty body); anything other than 401/000 proves auth works.
    assert "Google Sheets API reachable (got: $HTTP)" \
      "$([ "$HTTP" != "401" ] && [ "$HTTP" != "000" ] && echo true || echo false)"
  fi
else
  skip "Google Sheets export — Google not connected (run /authorize)"
fi
info "  '@expense-tracker export this month' — asks approval, then creates spreadsheet"

info ""
info "=== Phase 4: Approval Gates ==="
info "  approvalRequired: expense.delete, report.export"

summary
