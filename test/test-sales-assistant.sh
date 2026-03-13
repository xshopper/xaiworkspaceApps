#!/bin/bash
# test-sales-assistant.sh — Test the Sales Assistant agent (agents/sales-assistant)
# Usage: ./test/test-sales-assistant.sh

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
# Expected: Google + LinkedIn OAuth for full functionality
# ============================================================================

GOOGLE_CONNECTED="false"
LINKEDIN_CONNECTED="false"
if command -v oc-secret &>/dev/null; then
  oc-secret list 2>/dev/null | grep -q 'oauth/google' && GOOGLE_CONNECTED="true"
  oc-secret list 2>/dev/null | grep -q 'oauth/linkedin' && LINKEDIN_CONNECTED="true"
fi

[ "$GOOGLE_CONNECTED" = "true" ] && assert "Google OAuth connected" "true" || skip "Google not connected (needed for email/calendar)"
[ "$LINKEDIN_CONNECTED" = "true" ] && assert "LinkedIn OAuth connected" "true" || skip "LinkedIn not connected (needed for social selling)"

# ============================================================================
info ""
info "=== Phase 2: Lead Management ==="
# User flow:
#   User: "@sales-assistant add lead: John Smith, CTO at Acme Corp, met at conference"
#   Bot:  "Lead added: John Smith (CTO, Acme Corp)
#          Source: Conference. Stage: Initial Contact.
#          Want me to draft an intro email?"
#
# User flow:
#   User: "@sales-assistant show pipeline"
#   Bot:  "Pipeline Summary:
#          Initial Contact: 3 leads ($45K estimated)
#          Qualification: 2 leads ($120K)
#          Proposal: 1 lead ($80K)
#          Total pipeline: $245K"
# ============================================================================

info "  Manual test: send '@sales-assistant add lead: Name, Title at Company'"
info "  Expected: bot creates lead record, suggests next action"
info "  Manual test: send '@sales-assistant show pipeline'"
info "  Expected: bot shows leads grouped by MEDDIC stage with values"

# ============================================================================
info ""
info "=== Phase 3: Email Outreach ==="
# User flow:
#   User: "@sales-assistant draft follow-up for John Smith"
#   Bot:  "Draft follow-up:
#          Subject: Great meeting you at TechConf
#          ...
#          Send this? [requires approval]"
#
# Expected: email.send requires approval
# ============================================================================

info "  Manual test: send '@sales-assistant draft follow-up for {lead}'"
info "  Expected: bot drafts email, asks approval before sending"
info "  approvalRequired: email.send, proposal.send"

# ============================================================================
info ""
info "=== Phase 4: Cron Trigger ==="
# Expected: runs weekdays at 9am (cron: "0 9 * * 1-5")
# Sends daily pipeline summary and follow-up reminders
# ============================================================================

info "  Trigger: cron 0 9 * * 1-5 (weekdays at 9am)"
info "  Expected: bot sends daily summary of follow-ups due and pipeline changes"

# ============================================================================
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
