#!/bin/bash
# validate-manifests.sh — Validate all manifest.yml files in the workspace
# Usage: ./test/validate-manifests.sh

set -euo pipefail
PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

red()   { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
info()  { printf "\033[36m%s\033[0m\n" "$1"; }

assert() {
  local desc="$1" result="$2"
  if [ "$result" = "true" ]; then
    green "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

VALID_KINDS="app agent skill tool plugin"
VALID_MODELS="claude-opus-4-6 claude-sonnet-4-6 claude-haiku-4-5-20251001"
VALID_SANDBOX="strict relaxed none"
VALID_TRIGGER_KINDS="cron event webhook watch"
VALID_PERMISSIONS="storage email database functions chat.send chat.read chat.listen tool.execute tool.list memory.read memory.write device.camera device.location device.clipboard device.share device.info device.network device.files"
VALID_INTEGRATIONS="google github linkedin"

# Read workspace manifest paths
PATHS=$(python3 -c "
import yaml, sys
with open('$ROOT/openclaw-workspace.yml') as f:
    ws = yaml.safe_load(f)
for entry in ws.get('apps', []):
    print(entry['path'])
")

for app_path in $PATHS; do
  manifest="$ROOT/$app_path/manifest.yml"
  info "--- $app_path ---"

  # File exists
  assert "manifest.yml exists" "$([ -f "$manifest" ] && echo true || echo false)"
  [ -f "$manifest" ] || continue

  # Valid YAML
  if python3 -c "import yaml; yaml.safe_load(open('$manifest'))" 2>/dev/null; then
    assert "valid YAML" "true"
  else
    assert "valid YAML" "false"
    continue
  fi

  # Parse fields
  eval "$(python3 -c "
import yaml, json
with open('$manifest') as f:
    m = yaml.safe_load(f)
print(f'SLUG={json.dumps(m.get(\"slug\",\"\"))}')
print(f'IDENTIFIER={json.dumps(m.get(\"identifier\",\"\"))}')
print(f'KIND={json.dumps(m.get(\"kind\",\"\"))}')
print(f'NAME={json.dumps(m.get(\"name\",\"\"))}')
print(f'DESC={json.dumps(m.get(\"description\",\"\"))}')
print(f'ICON={json.dumps(m.get(\"icon\",\"\"))}')
print(f'VERSION={json.dumps(m.get(\"version\",\"\"))}')
print(f'MODEL={json.dumps(m.get(\"model\",\"\"))}')
print(f'SANDBOX={json.dumps(m.get(\"sandbox\",\"strict\"))}')
print(f'HAS_PERSONA={json.dumps(\"persona\" in m)}')
print(f'HAS_PERMISSIONS={json.dumps(\"permissions\" in m)}')
print(f'HAS_TRIGGERS={json.dumps(\"triggers\" in m)}')
print(f'HAS_INPUT={json.dumps(\"input\" in m)}')
print(f'HAS_OUTPUT={json.dumps(\"output\" in m)}')
print(f'HAS_OPERATIONS={json.dumps(\"operations\" in m)}')
print(f'HAS_AUTH_PROVIDER={json.dumps(\"authProvider\" in m)}')
print(f'HAS_BASE_URL={json.dumps(\"baseUrl\" in m)}')
")"

  # Required fields
  assert "slug is set" "$([ -n "$SLUG" ] && echo true || echo false)"
  assert "identifier is set" "$([ -n "$IDENTIFIER" ] && echo true || echo false)"
  assert "kind is set" "$([ -n "$KIND" ] && echo true || echo false)"
  assert "name is set" "$([ -n "$NAME" ] && echo true || echo false)"
  assert "description is set" "$([ -n "$DESC" ] && echo true || echo false)"
  assert "version is set" "$([ -n "$VERSION" ] && echo true || echo false)"

  # Slug format (kebab-case, 3-100 chars)
  if echo "$SLUG" | grep -qE '^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$'; then
    assert "slug format valid" "true"
  else
    assert "slug format valid (got: $SLUG)" "false"
  fi

  # Identifier format (reverse domain)
  if echo "$IDENTIFIER" | grep -qE '^com\.xshopper\.[a-z0-9-]+$'; then
    assert "identifier format valid" "true"
  else
    assert "identifier format valid (got: $IDENTIFIER)" "false"
  fi

  # Slug matches directory name
  DIR_NAME=$(basename "$app_path")
  assert "slug matches directory ($DIR_NAME)" "$([ "$SLUG" = "$DIR_NAME" ] && echo true || echo false)"

  # Valid kind
  assert "kind is valid ($KIND)" "$(echo $VALID_KINDS | grep -qw "$KIND" && echo true || echo false)"

  # Model is valid (if set)
  if [ -n "$MODEL" ]; then
    assert "model is valid ($MODEL)" "$(echo $VALID_MODELS | grep -qw "$MODEL" && echo true || echo false)"
  fi

  # Sandbox is valid (if set — defaults to "strict")
  assert "sandbox is valid ($SANDBOX)" "$(echo $VALID_SANDBOX | grep -qw "$SANDBOX" && echo true || echo false)"

  # Version format (semver: MAJOR.MINOR.PATCH)
  if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    assert "version is semver" "true"
  else
    assert "version is semver (got: $VERSION)" "false"
  fi

  # Icon is set (required for user-facing kinds)
  if [ "$KIND" = "app" ] || [ "$KIND" = "agent" ]; then
    assert "icon is set" "$([ -n "$ICON" ] && echo true || echo false)"
  fi

  # Validate permissions entries (if present)
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

  # Validate trigger kinds (if present)
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

  # Kind-specific checks
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

echo "========================================="
echo "Results: $PASS passed, $FAIL failed"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
