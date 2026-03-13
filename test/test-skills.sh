#!/bin/bash
# test-skills.sh — Test summarize-text and extract-data skills
# Usage: ./test/test-skills.sh

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

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ============================================================================
info "=== Summarize Text Skill ==="
# Input:  { text: "...", maxPoints: 5, style: "bullets" }
# Output: { summary: "...", pointCount: 3 }
# Model:  claude-haiku-4-5-20251001 (fast, low-latency)
#
# Used by: code-reviewer (declared dependency)
# ============================================================================

MANIFEST="$ROOT/skills/summarize-text/manifest.yml"
assert "manifest exists" "$([ -f "$MANIFEST" ] && echo true || echo false)"

# Validate input schema
INPUT_VALID=$(python3 -c "
import yaml
with open('$MANIFEST') as f:
    m = yaml.safe_load(f)
inp = m.get('input', {})
assert inp.get('type') == 'object'
assert 'text' in inp.get('properties', {})
assert 'text' in inp.get('required', [])
print('true')
" 2>/dev/null || echo "false")
assert "input schema valid (requires text)" "$INPUT_VALID"

# Validate output schema
OUTPUT_VALID=$(python3 -c "
import yaml
with open('$MANIFEST') as f:
    m = yaml.safe_load(f)
out = m.get('output', {})
assert out.get('type') == 'object'
assert 'summary' in out.get('properties', {})
print('true')
" 2>/dev/null || echo "false")
assert "output schema valid (has summary)" "$OUTPUT_VALID"

info "  Style options: bullets, paragraph, tldr"
info "  AI usage: '@summarize-text' or called by other apps as dependency"
info ""
info "  Example interaction:"
info "    User: '@summarize-text Summarize this article: [long text]'"
info "    Bot:  '- Key point 1"
info "           - Key point 2"
info "           - Key point 3'"

# ============================================================================
info ""
info "=== Extract Data Skill ==="
# Input:  { text: "...", schema: {...}, hints: "..." }
# Output: { extracted: {...}, confidence: 0.95 }
# Model:  claude-sonnet-4-6 (reasoning required)
#
# Used by: expense-tracker (for receipt parsing)
# ============================================================================

MANIFEST="$ROOT/skills/extract-data/manifest.yml"
assert "manifest exists" "$([ -f "$MANIFEST" ] && echo true || echo false)"

# Validate input schema
INPUT_VALID=$(python3 -c "
import yaml
with open('$MANIFEST') as f:
    m = yaml.safe_load(f)
inp = m.get('input', {})
assert inp.get('type') == 'object'
assert 'text' in inp.get('properties', {})
assert 'schema' in inp.get('properties', {})
assert 'text' in inp.get('required', [])
print('true')
" 2>/dev/null || echo "false")
assert "input schema valid (requires text, has schema)" "$INPUT_VALID"

# Validate output schema
OUTPUT_VALID=$(python3 -c "
import yaml
with open('$MANIFEST') as f:
    m = yaml.safe_load(f)
out = m.get('output', {})
assert out.get('type') == 'object'
assert 'extracted' in out.get('properties', {})
assert 'confidence' in out.get('properties', {})
print('true')
" 2>/dev/null || echo "false")
assert "output schema valid (has extracted, confidence)" "$OUTPUT_VALID"

info ""
info "  Example interaction:"
info "    User: '@extract-data Extract invoice data from: Invoice #1234, Date: March 1..."
info "    Bot:  '{ invoice_number: \"1234\", date: \"2026-03-01\", ... }'"
info "           Confidence: 0.95'"

# ============================================================================
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
