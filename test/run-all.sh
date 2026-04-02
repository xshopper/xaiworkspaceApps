#!/bin/bash
# run-all.sh — Run all test suites
# Usage: ./test/run-all.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TOTAL_PASS=0; TOTAL_FAIL=0

echo "============================================="
echo "  xAI Workspace Apps — Test Suite"
echo "============================================="
echo ""

for test in "$DIR"/validate-manifests.sh "$DIR"/test-*.sh; do
  [ -f "$test" ] || continue
  NAME=$(basename "$test" .sh)
  echo ">>> Running: $NAME"
  if bash "$test"; then
    TOTAL_PASS=$((TOTAL_PASS + 1))
    echo ""
  else
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    echo ""
  fi
done

echo "============================================="
if [ "$TOTAL_FAIL" -eq 0 ]; then
  printf "\033[32mAll %d test suite(s) passed.\033[0m\n" "$TOTAL_PASS"
else
  printf "\033[31m%d passed, %d failed.\033[0m\n" "$TOTAL_PASS" "$TOTAL_FAIL"
fi
echo "============================================="
[ "$TOTAL_FAIL" -eq 0 ] && exit 0 || exit 1
