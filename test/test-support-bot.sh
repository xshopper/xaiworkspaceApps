#!/bin/bash
# test-support-bot.sh — Test the Support Bot agent (agents/support-bot)
# Usage: ./test/test-support-bot.sh

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
info "=== Phase 1: Ticket Triage ==="
# User flow:
#   User: "@support-bot I can't login to my account"
#   Bot:  "I'm sorry you're having trouble logging in. Let me help.
#          Ticket #SUP-1042 created.
#          Could you tell me:
#          1. What error message do you see?
#          2. Are you using email or social login?
#          3. When did this start happening?"
#
# Expected: empathetic response, ticket number, structured questions
# ============================================================================

info "  Manual test: send '@support-bot I can't login'"
info "  Expected: empathetic acknowledgment, ticket number, diagnostic questions"
info "  Expected: uses simple language (persona rule)"

# ============================================================================
info ""
info "=== Phase 2: Common Question Handling ==="
# User flow:
#   User: "@support-bot how do I change my password?"
#   Bot:  "Here's how to change your password:
#          1. Go to Settings > Security
#          2. Click 'Change Password'
#          3. Enter your current password and new password
#          4. Click 'Save'
#          Ticket #SUP-1043. Anything else I can help with?"
# ============================================================================

info "  Manual test: send '@support-bot how do I change my password'"
info "  Expected: step-by-step instructions with ticket reference"

# ============================================================================
info ""
info "=== Phase 3: Approval Gates ==="
# User flow:
#   User: "@support-bot I want a refund"
#   Bot:  "I understand you'd like a refund. Let me look into your account.
#          [reviews account]
#          I see your last charge of $29.99 on March 1.
#          I'll need to get approval for this refund. [escalates]"
#
# Expected: refund.issue and account.modify require approval
# ============================================================================

info "  approvalRequired: refund.issue, account.modify"
info "  Manual test: send '@support-bot I want a refund'"
info "  Expected: bot reviews account, escalates (never promises refund directly)"
info "  Manual test: send '@support-bot change my email address'"
info "  Expected: bot asks for approval before modifying account"

# ============================================================================
info ""
info "=== Phase 4: Triggers ==="
# Expected: fires on support.ticket.created and chat messages containing "help"
# ============================================================================

info "  Trigger 1: event support.ticket.created"
info "  Expected: bot automatically picks up new tickets"
info "  Trigger 2: event chat.message filter contains 'help'"
info "  Expected: bot responds when user says 'help' in any context"

# ============================================================================
info ""
info "=== Phase 5: Model Selection ==="
# Expected: uses claude-haiku for speed (high volume support)
# Falls back to claude-sonnet for complex issues
# ============================================================================

info "  Primary model: claude-haiku-4-5-20251001 (fast for high volume)"
info "  Fallback: claude-sonnet-4-6 (for complex issues)"

# ============================================================================
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
