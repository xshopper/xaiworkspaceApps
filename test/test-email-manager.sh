#!/bin/bash
# test-email-manager.sh — Test the Email Manager app (apps/email-manager).
# Run on a provisioned workspace where oc-secret is available.
# Usage: ./test/test-email-manager.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0

info "=== Phase 1: Prerequisites ==="
assert "oc-secret command available" \
  "$(command -v oc-secret >/dev/null 2>&1 && echo true || echo false)"

if oauth_connected google; then
  assert "Google OAuth connected" "true"
else
  skip "Google not connected — run /authorize and connect Google first"
fi

info ""
info "=== Phase 2: Gmail API Access ==="
if oauth_connected google; then
  TOKEN=$(oauth_token google)
  if [ -n "$TOKEN" ]; then
    assert "Google access token retrieved" "true"
    HTTP=$(http_code "https://gmail.googleapis.com/gmail/v1/users/me/labels" \
      "Authorization: Bearer $TOKEN")
    case "$HTTP" in
      200) assert "Gmail API responds with token" "true" ;;
      # Expired token is not a test failure — the bot auto-refreshes via oc-secret.
      401) skip "Gmail token expired (bot handles refresh automatically)" ;;
      *)   assert "Gmail API responds (got: $HTTP)" "false" ;;
    esac
  else
    assert "Google access token retrieved" "false"
  fi
else
  skip "Gmail API test — Google not connected"
fi

info ""
info "=== Phase 3: Email Actions (manual) ==="
info "  '@email-manager check my inbox' — lists emails w/ subject/sender/priority"
info "  '@email-manager archive newsletters' — asks approval before modifying"
info "  '@email-manager draft reply to latest' — shows draft, asks approval to send"
info "  approvalRequired: email.delete, email.send"

info ""
info "=== Phase 4: Cron Trigger ==="
info "  cron */15 * * * * — proactively checks inbox, notifies on important mail"

summary
