#!/bin/bash
# test-email-manager.sh — Test the Email Manager app (apps/email-manager)
# Run on a provisioned EC2 instance where OpenClaw is running.
# Usage: ./test/test-email-manager.sh

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
info "=== Phase 1: Prerequisites ==="
# Expected: Google OAuth connected via /authorize
# ============================================================================

GOOGLE_CONNECTED="false"
if command -v oc-secret &>/dev/null; then
  if oc-secret list 2>/dev/null | grep -q 'oauth/google'; then
    GOOGLE_CONNECTED="true"
  fi
fi
assert "oc-secret command available" "$(command -v oc-secret &>/dev/null && echo true || echo false)"

if [ "$GOOGLE_CONNECTED" = "true" ]; then
  assert "Google OAuth connected" "true"
else
  skip "Google not connected — run /authorize and connect Google first"
fi

# ============================================================================
info ""
info "=== Phase 2: Gmail API Access ==="
# User flow:
#   User: "@email-manager check my inbox"
#   Bot:  "You have 5 new emails:
#          1. [Important] Meeting tomorrow — from boss@company.com
#          2. [Newsletter] Weekly digest — from news@example.com
#          ..."
#
# Expected: Bot reads Gmail via API, summarizes messages
# ============================================================================

if [ "$GOOGLE_CONNECTED" = "true" ]; then
  TOKEN=$(oc-secret get oauth/google --field accessToken 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    assert "Google access token retrieved" "true"

    # Test: Gmail API is reachable with token
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "https://gmail.googleapis.com/gmail/v1/users/me/labels" 2>/dev/null || echo "000")

    if [ "$HTTP_CODE" = "200" ]; then
      assert "Gmail API responds with token" "true"
    elif [ "$HTTP_CODE" = "401" ]; then
      info "  Token expired — bot should auto-refresh via: oc-secret refresh google"
      skip "Gmail token expired (bot handles refresh automatically)"
    else
      assert "Gmail API responds (got: $HTTP_CODE)" "false"
    fi
  else
    assert "Google access token retrieved" "false"
  fi
else
  skip "Gmail API test — Google not connected"
fi

# ============================================================================
info ""
info "=== Phase 3: Email Actions ==="
# User flow:
#   User: "@email-manager archive all newsletters"
#   Bot:  "I found 3 newsletter emails. Archive them?"  [requires approval]
#   User: "yes"
#   Bot:  "Archived 3 emails."
#
# User flow:
#   User: "@email-manager draft a reply to the meeting email"
#   Bot:  "Here's a draft: ..."  [shows draft, requires approval to send]
#
# Expected:
#   - Bot NEVER deletes without approval (approvalRequired: email.delete)
#   - Bot NEVER sends without approval (approvalRequired: email.send)
#   - Bot always summarizes before acting
# ============================================================================

info "  Manual test: send '@email-manager check my inbox'"
info "  Expected: bot lists emails with subject, sender, priority"
info "  Manual test: send '@email-manager archive newsletters'"
info "  Expected: bot asks for approval before modifying"
info "  Manual test: send '@email-manager draft reply to latest'"
info "  Expected: bot shows draft, asks approval before sending"

# ============================================================================
info ""
info "=== Phase 4: Cron Trigger ==="
# Expected: app runs every 15 minutes (cron: "*/15 * * * *")
# Checks inbox, summarizes new emails, sends notification if important
# ============================================================================

info "  Trigger: cron */15 * * * *"
info "  Expected: bot proactively checks inbox and notifies about important emails"

# ============================================================================
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
