#!/bin/bash
# test-code-reviewer.sh — Test the Code Reviewer app (apps/code-reviewer).
# Usage: ./test/test-code-reviewer.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0

info "=== Phase 1: Prerequisites ==="

if oauth_connected github; then
  assert "GitHub OAuth connected" "true"
  TOKEN=$(oauth_token github)
  if [ -n "$TOKEN" ]; then
    HTTP=$(http_code "https://api.github.com/user" \
      "Authorization: Bearer $TOKEN" "Accept: application/vnd.github+json")
    assert "GitHub API responds with token (got: $HTTP)" \
      "$([ "$HTTP" = "200" ] && echo true || echo false)"
  fi
else
  skip "GitHub not connected — run /authorize and connect GitHub first"
fi

info ""
info "=== Phase 2: Manual PR Review ==="
info "  Send '@code-reviewer review {PR_URL}' and expect structured review"
info "  (issues, suggestions, good patterns). Uses summarize-text skill for long diffs."

info ""
info "=== Phase 3: Webhook Trigger ==="
info "  Trigger: webhook /hooks/github-pr on pull_request.opened/synchronize"

info ""
info "=== Phase 4: Dependencies ==="
SUMMARIZE_MANIFEST="$(cd "$DIR/.." && pwd)/skills/summarize-text/manifest.yml"
assert "summarize-text dependency exists" \
  "$([ -f "$SUMMARIZE_MANIFEST" ] && echo true || echo false)"

summary
