#!/bin/bash
# test-tools.sh — Test the Google Sheets and GitHub Issues tools.
# Usage: ./test/test-tools.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0

info "=== Google Sheets Tool ==="
if oauth_connected google; then
  TOKEN=$(oauth_token google)
  if [ -n "$TOKEN" ]; then
    HTTP=$(http_code \
      "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.spreadsheet%27&fields=files(id%2Cname)" \
      "Authorization: Bearer $TOKEN")
    assert "Google Sheets: list operation ($HTTP)" \
      "$([ "$HTTP" = "200" ] && echo true || echo false)"
  fi
else
  skip "Google Sheets — Google not connected"
fi
info "  Example: @expense-tracker export to sheets → google-sheets.create + append"

info ""
info "=== GitHub Issues Tool ==="
if oauth_connected github; then
  TOKEN=$(oauth_token github)
  if [ -n "$TOKEN" ]; then
    HTTP=$(http_code "https://api.github.com/user/repos?per_page=1" \
      "Authorization: Bearer $TOKEN" "Accept: application/vnd.github+json")
    assert "GitHub Issues: list-repos operation ($HTTP)" \
      "$([ "$HTTP" = "200" ] && echo true || echo false)"
  fi
else
  skip "GitHub Issues — GitHub not connected"
fi
info "  Example: @code-reviewer creates review comments → github-issues.comment"

summary
