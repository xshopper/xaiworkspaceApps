#!/bin/bash
# test-tools.sh — Test Google Sheets and GitHub Issues tools
# Usage: ./test/test-tools.sh

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
info "=== Google Sheets Tool ==="
# Tool operations: list, get, read, write, append, create, clear, batch-get
# Requires: Google OAuth via /authorize
# ============================================================================

GOOGLE_CONNECTED="false"
if command -v oc-secret &>/dev/null; then
  oc-secret list 2>/dev/null | grep -q 'oauth/google' && GOOGLE_CONNECTED="true"
fi

if [ "$GOOGLE_CONNECTED" = "true" ]; then
  TOKEN=$(oc-secret get oauth/google --field accessToken 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    # Test: list spreadsheets
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.spreadsheet%27&fields=files(id%2Cname)" \
      2>/dev/null || echo "000")
    assert "Google Sheets: list operation ($HTTP_CODE)" \
      "$([ "$HTTP_CODE" = "200" ] && echo true || echo false)"
  fi
else
  skip "Google Sheets — Google not connected"
fi

info "  AI usage: other apps call this tool via tool.execute permission"
info "  Example: @expense-tracker export to sheets → invokes google-sheets.create + google-sheets.append"

# ============================================================================
info ""
info "=== GitHub Issues Tool ==="
# Tool operations: list, get, create, update, comment, list-comments, close, list-labels, list-repos
# Requires: GitHub OAuth via /authorize
# ============================================================================

GITHUB_CONNECTED="false"
if command -v oc-secret &>/dev/null; then
  oc-secret list 2>/dev/null | grep -q 'oauth/github' && GITHUB_CONNECTED="true"
fi

if [ "$GITHUB_CONNECTED" = "true" ]; then
  TOKEN=$(oc-secret get oauth/github --field accessToken 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    # Test: list repos
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/user/repos?per_page=1" 2>/dev/null || echo "000")
    assert "GitHub Issues: list-repos operation ($HTTP_CODE)" \
      "$([ "$HTTP_CODE" = "200" ] && echo true || echo false)"
  fi
else
  skip "GitHub Issues — GitHub not connected"
fi

info "  AI usage: other apps call this tool via tool.execute permission"
info "  Example: @code-reviewer creates review comments → invokes github-issues.comment"

# ============================================================================
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
