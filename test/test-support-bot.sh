#!/bin/bash
# test-support-bot.sh — Test the Support Bot agent (agents/support-bot).
# Usage: ./test/test-support-bot.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0

info "=== Phase 1: Ticket Triage (manual) ==="
info "  '@support-bot I can't login' — empathetic ack, ticket number, diagnostic questions"
info "  (persona rule: use simple language)"

info ""
info "=== Phase 2: Common Question Handling (manual) ==="
info "  '@support-bot how do I change my password' — step-by-step w/ ticket reference"

info ""
info "=== Phase 3: Approval Gates (manual) ==="
info "  approvalRequired: refund.issue, account.modify"
info "  '@support-bot I want a refund' — reviews account, escalates (never promises directly)"
info "  '@support-bot change my email address' — asks approval before modifying"

info ""
info "=== Phase 4: Triggers ==="
info "  event support.ticket.created — auto picks up new tickets"
info "  event chat.message filter 'help' — responds when user says 'help' in any context"

info ""
info "=== Phase 5: Model Selection ==="
info "  primary: claude-haiku-4-5-20251001  fallback: claude-sonnet-4-6"

summary
