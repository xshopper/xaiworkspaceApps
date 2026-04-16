#!/bin/bash
# validate-manifests.sh — Validate every manifest.yml referenced by openclaw-workspace.yml.
# Usage: ./test/validate-manifests.sh

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0

VALID_KINDS="app agent skill tool plugin mcp"
VALID_MODELS="claude-opus-4-6 claude-sonnet-4-6 claude-haiku-4-5-20251001"
VALID_SANDBOX="strict relaxed none"
VALID_TRIGGER_KINDS="cron event webhook watch"
VALID_PERMISSIONS="storage email database functions chat.send chat.read chat.listen tool.execute tool.list memory.read memory.write device.camera device.location device.clipboard device.share device.info device.network device.files"
VALID_INTEGRATIONS="google github linkedin"

assert_set()   { assert "$1 is set" "$([ -n "$2" ] && echo true || echo false)"; }
assert_match() { assert "$1 ${3:+(got: $3)}" "$(echo "$3" | grep -qE "$2" && echo true || echo false)"; }
word_in()      { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

PATHS=$(python3 -c "
import yaml
for entry in yaml.safe_load(open('$ROOT/openclaw-workspace.yml')).get('apps', []):
    print(entry['path'])
")

for app_path in $PATHS; do
  manifest="$ROOT/$app_path/manifest.yml"
  info "--- $app_path ---"

  assert "manifest.yml exists" "$([ -f "$manifest" ] && echo true || echo false)"
  [ -f "$manifest" ] || continue

  if python3 -c "import yaml; yaml.safe_load(open('$manifest'))" 2>/dev/null; then
    assert "valid YAML" "true"
  else
    assert "valid YAML" "false"
    continue
  fi

  # eval is safe here: json.dumps always emits shell-safe quoted strings/bools.
  eval "$(python3 - "$manifest" <<'PY'
import sys, yaml, json
m = yaml.safe_load(open(sys.argv[1])) or {}
for k, default in (
    ('slug',''), ('identifier',''), ('kind',''), ('name',''),
    ('description',''), ('icon',''), ('version',''), ('model',''),
    ('sandbox','strict'),
):
    print(f'{k.upper()}={json.dumps(m.get(k, default))}')
for k, var in (
    ('persona','HAS_PERSONA'), ('permissions','HAS_PERMISSIONS'),
    ('triggers','HAS_TRIGGERS'), ('input','HAS_INPUT'),
    ('output','HAS_OUTPUT'), ('operations','HAS_OPERATIONS'),
    ('authProvider','HAS_AUTH_PROVIDER'), ('baseUrl','HAS_BASE_URL'),
):
    print(f'{var}={json.dumps(k in m)}')
PY
)"

  assert_set slug         "$SLUG"
  assert_set identifier   "$IDENTIFIER"
  assert_set kind         "$KIND"
  assert_set name         "$NAME"
  assert_set description  "$DESCRIPTION"
  assert_set version      "$VERSION"

  assert_match "slug format valid"       '^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$' "$SLUG"
  assert_match "identifier format valid" '^com\.xshopper\.[a-z0-9-]+$'       "$IDENTIFIER"
  assert_match "version is semver"       '^[0-9]+\.[0-9]+\.[0-9]+$'          "$VERSION"

  DIR_NAME=$(basename "$app_path")
  assert "slug matches directory ($DIR_NAME)" \
    "$([ "$SLUG" = "$DIR_NAME" ] && echo true || echo false)"

  assert "kind is valid ($KIND)"       "$(word_in "$KIND" "$VALID_KINDS" && echo true || echo false)"
  assert "sandbox is valid ($SANDBOX)" "$(word_in "$SANDBOX" "$VALID_SANDBOX" && echo true || echo false)"
  [ -n "$MODEL" ] && assert "model is valid ($MODEL)" \
    "$(word_in "$MODEL" "$VALID_MODELS" && echo true || echo false)"

  # app/agent must carry an icon for the UI
  if [ "$KIND" = "app" ] || [ "$KIND" = "agent" ]; then
    assert_set icon "$ICON"
  fi

  if [ "$HAS_PERMISSIONS" = "true" ]; then
    BAD_PERMS=$(python3 -c "
import yaml
valid = set('$VALID_PERMISSIONS'.split())
valid_integrations = set('$VALID_INTEGRATIONS'.split())
with open('$manifest') as f:
    m = yaml.safe_load(f)
perms = m.get('permissions', {})
bad = []
for v in perms.get('resources', []):
    if v not in valid:
        bad.append(v)
for v in perms.get('chat', []):
    if v not in valid:
        bad.append(v)
for v in perms.get('device', []):
    if v not in valid:
        bad.append(v)
for v in perms.get('integrations', []):
    if v not in valid_integrations:
        bad.append(v)
print(','.join(bad))
" 2>/dev/null)
    if [ -z "$BAD_PERMS" ]; then
      assert "permissions are valid" "true"
    else
      assert "permissions are valid (invalid: $BAD_PERMS)" "false"
    fi
  fi

  if [ "$HAS_TRIGGERS" = "true" ]; then
    BAD_TRIGGERS=$(python3 -c "
import yaml
valid = set('$VALID_TRIGGER_KINDS'.split())
with open('$manifest') as f:
    m = yaml.safe_load(f)
triggers = m.get('triggers', [])
bad = [t.get('kind','<missing>') for t in triggers if t.get('kind') not in valid]
print(','.join(bad))
" 2>/dev/null)
    if [ -z "$BAD_TRIGGERS" ]; then
      assert "trigger kinds are valid" "true"
    else
      assert "trigger kinds are valid (invalid: $BAD_TRIGGERS)" "false"
    fi
  fi

  STARTUP_CLEANUP_ERRORS=$(python3 -c "
import yaml, re
with open('$manifest') as f:
    m = yaml.safe_load(f)
errors = []
for field in ('startup', 'cleanup'):
    val = m.get(field)
    if val is None:
        continue
    if not isinstance(val, str):
        errors.append(f'{field} must be a string')
        continue
    if len(val) > 500:
        errors.append(f'{field} exceeds 500 chars ({len(val)})')
    if field == 'startup':
        # startup runs pre-app-boot in a shared shell, so disallow command substitution/eval.
        if re.search(r'\\\$\(', val):
            errors.append(f'{field} contains dangerous \\\$() pattern')
        if chr(96) in val:
            errors.append(f'{field} contains dangerous backtick')
        if re.search(r'\\beval\\b', val):
            errors.append(f'{field} contains dangerous eval')
print(','.join(errors))
" 2>/dev/null)
  if [ -z "$STARTUP_CLEANUP_ERRORS" ]; then
    assert "startup/cleanup fields are safe" "true"
  else
    assert "startup/cleanup fields are safe ($STARTUP_CLEANUP_ERRORS)" "false"
  fi

  COMMANDS_ERRORS=$(python3 -c "
import yaml, re
with open('$manifest') as f:
    m = yaml.safe_load(f)
cmds = m.get('commands')
if cmds is None or not isinstance(cmds, dict):
    pass
else:
    bad = [k for k in cmds if not re.match(r'^[a-zA-Z_][a-zA-Z0-9_-]*$', str(k))]
    if bad:
        print(','.join(bad))
" 2>/dev/null)
  if [ -z "$COMMANDS_ERRORS" ]; then
    assert "commands keys are valid identifiers" "true"
  else
    assert "commands keys are valid identifiers (invalid: $COMMANDS_ERRORS)" "false"
  fi

  case "$KIND" in
    app|agent)
      assert "app/agent has persona" "$HAS_PERSONA"
      assert "app/agent has model" "$([ -n "$MODEL" ] && echo true || echo false)"
      ;;
    skill)
      assert "skill has input schema" "$HAS_INPUT"
      assert "skill has output schema" "$HAS_OUTPUT"
      assert "skill has model" "$([ -n "$MODEL" ] && echo true || echo false)"
      ;;
    tool)
      assert "tool has authProvider" "$HAS_AUTH_PROVIDER"
      assert "tool has baseUrl" "$HAS_BASE_URL"
      assert "tool has operations" "$HAS_OPERATIONS"
      ;;
  esac

  echo ""
done

summary
