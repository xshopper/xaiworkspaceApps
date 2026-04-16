#!/bin/bash
# test-skills.sh — Validate the summarize-text and extract-data skill manifests.
# Usage: ./test/test-skills.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0
ROOT="$(cd "$DIR/.." && pwd)"

# check_schema <manifest> <section:input|output> <required_prop> [extra_prop...]
check_schema() {
  local manifest="$1" section="$2"; shift 2
  python3 - "$manifest" "$section" "$@" <<'PY' 2>/dev/null || return 1
import sys, yaml
path, section, *props = sys.argv[1:]
m = yaml.safe_load(open(path))
s = m.get(section) or {}
assert s.get('type') == 'object', f'{section} not an object'
for p in props:
    assert p in s.get('properties', {}), f'{p} missing from properties'
if section == 'input':
    assert props[0] in s.get('required', []), f'{props[0]} not in required'
PY
}

check_skill() {
  local slug="$1" title="$2"
  info "=== $title ==="
  local manifest="$ROOT/skills/$slug/manifest.yml"
  assert "manifest exists" "$([ -f "$manifest" ] && echo true || echo false)"
  [ -f "$manifest" ] || return 0
  assert "input schema valid" \
    "$(check_schema "$manifest" input text && echo true || echo false)"
  assert "output schema valid" \
    "$(check_schema "$manifest" output "${3:-summary}" && echo true || echo false)"
}

check_skill summarize-text "Summarize Text Skill" summary
info ""
check_skill extract-data "Extract Data Skill" extracted

summary
