#!/bin/bash
# test-sales-assistant.sh — Test the Sales Assistant agent (agents/sales-assistant).
# Usage: ./test/test-sales-assistant.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0

info "=== Phase 1: Prerequisites ==="
if oauth_connected google; then assert "Google OAuth connected" "true"
else skip "Google not connected (needed for email/calendar)"; fi
if oauth_connected linkedin; then assert "LinkedIn OAuth connected" "true"
else skip "LinkedIn not connected (needed for social selling)"; fi

info ""
info "=== Phase 2: Lead Management (manual) ==="
info "  '@sales-assistant add lead: Name, Title at Company' — creates lead, suggests next action"
info "  '@sales-assistant show pipeline' — leads grouped by MEDDIC stage with values"

info ""
info "=== Phase 3: Email Outreach (manual) ==="
info "  '@sales-assistant draft follow-up for {lead}' — drafts, asks approval"
info "  approvalRequired: email.send, proposal.send"

info ""
info "=== Phase 4: Cron Trigger ==="
info "  cron 0 9 * * 1-5 — daily summary of follow-ups due and pipeline changes"

summary
