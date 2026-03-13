#!/bin/bash
# test-code-reviewer.sh — Test the Code Reviewer app (apps/code-reviewer)
# Usage: ./test/test-code-reviewer.sh

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
# Expected: GitHub OAuth connected via /authorize
# ============================================================================

GITHUB_CONNECTED="false"
if command -v oc-secret &>/dev/null; then
  if oc-secret list 2>/dev/null | grep -q 'oauth/github'; then
    GITHUB_CONNECTED="true"
  fi
fi

if [ "$GITHUB_CONNECTED" = "true" ]; then
  assert "GitHub OAuth connected" "true"
  TOKEN=$(oc-secret get oauth/github --field accessToken 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/user" 2>/dev/null || echo "000")
    assert "GitHub API responds with token (got: $HTTP_CODE)" \
      "$([ "$HTTP_CODE" = "200" ] && echo true || echo false)"
  fi
else
  skip "GitHub not connected — run /authorize and connect GitHub first"
fi

# ============================================================================
info ""
info "=== Phase 2: Manual PR Review ==="
# User flow:
#   User: "@code-reviewer review https://github.com/org/repo/pull/42"
#   Bot:  "Reviewing PR #42: 'Add user authentication'
#          Files changed: 5 (+230, -15)
#
#          ## Issues Found
#          1. **Security** auth.js:45 — SQL injection risk in user lookup
#          2. **Bug** session.js:12 — Token expiry not checked
#          3. **Style** utils.js:8 — Dead code (unused import)
#
#          ## Good Patterns
#          - Proper CSRF token validation
#          - Clean separation of concerns
#
#          Overall: Request changes (2 critical issues)"
#
# Expected: bot fetches PR files, analyzes code, provides structured review
# ============================================================================

info "  Manual test: send '@code-reviewer review {PR_URL}'"
info "  Expected: structured review with issues, suggestions, and good patterns"
info "  Expected: uses summarize-text skill for long diffs (dependency)"

# ============================================================================
info ""
info "=== Phase 3: Webhook Trigger ==="
# Expected: fires on pull_request.opened and pull_request.synchronize
# Automatically reviews new PRs
# ============================================================================

info "  Trigger: webhook /hooks/github-pr"
info "  Events: pull_request.opened, pull_request.synchronize"
info "  Expected: bot automatically reviews when PR is opened or updated"

# ============================================================================
info ""
info "=== Phase 4: Dependencies ==="
# Expected: code-reviewer depends on summarize-text skill
# ============================================================================

SUMMARIZE_MANIFEST="$(cd "$(dirname "$0")/.." && pwd)/skills/summarize-text/manifest.yml"
assert "summarize-text dependency exists" "$([ -f "$SUMMARIZE_MANIFEST" ] && echo true || echo false)"

# ============================================================================
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
