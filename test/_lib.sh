# _lib.sh — Shared helpers for test/*.sh scripts. Source, don't execute.
# Callers must `set -euo pipefail` themselves and init PASS=0 FAIL=0 SKIP=0.

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
info()   { printf "\033[36m%s\033[0m\n" "$1"; }

assert() {
  if [ "$2" = "true" ]; then green "  PASS: $1"; PASS=$((PASS+1))
  else red "  FAIL: $1"; FAIL=$((FAIL+1)); fi
}

# assert_cond "desc" <shell expr...>  — runs the expression, PASS if exit 0.
assert_cond() {
  local desc="$1"; shift
  if "$@"; then green "  PASS: $desc"; PASS=$((PASS+1))
  else red "  FAIL: $desc"; FAIL=$((FAIL+1)); fi
}

skip() { yellow "  SKIP: $1"; SKIP=$((SKIP+1)); }

# oauth_connected <provider>  — true iff oc-secret lists oauth/<provider>.
oauth_connected() {
  command -v oc-secret >/dev/null 2>&1 || return 1
  oc-secret list 2>/dev/null | grep -q "oauth/$1"
}

# oauth_token <provider>  — prints access token or empty string.
oauth_token() {
  oc-secret get "oauth/$1" --field accessToken 2>/dev/null || true
}

# http_code <url> [header...]  — prints HTTP status code (000 on failure).
http_code() {
  local url="$1"; shift
  local args=()
  for h in "$@"; do args+=(-H "$h"); done
  curl -sL -o /dev/null -w '%{http_code}' "${args[@]}" "$url" 2>/dev/null || echo "000"
}

# summary — print totals and return failure count. Caller decides exit.
summary() {
  echo ""
  echo "========================================="
  echo "Results: $PASS passed, $FAIL failed${SKIP:+, $SKIP skipped}"
  echo "========================================="
  return "$FAIL"
}
