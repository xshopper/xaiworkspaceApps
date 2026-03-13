#!/bin/bash
# test-cliproxy.sh — Test the CLI Proxy app (apps/cliproxy)
# Run on a provisioned EC2 instance where OpenClaw is running.
# Usage: ./test/test-cliproxy.sh [--install-only]

set -euo pipefail
PASS=0; FAIL=0; SKIP=0
APP_DIR="$HOME/apps/com.xshopper.cliproxy"

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
info "=== Phase 1: Binary Installation ==="
# Expected: @cliproxy auto-installs CLIProxyAPI from GitHub on first interaction
# User says: "@cliproxy status"
# Bot should: detect cli-proxy-api missing, download from GitHub, install, confirm
# ============================================================================

# Test: GitHub release is accessible
info "Checking GitHub release availability..."
TAG=$(curl -sL https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest | jq -r '.tag_name')
assert "GitHub latest release exists (got: $TAG)" "$([ -n "$TAG" ] && [ "$TAG" != "null" ] && echo true || echo false)"

# Test: Download URL is valid
VERSION=${TAG#v}
ARCH=$(uname -m)
case "$ARCH" in aarch64) ARCH="arm64" ;; x86_64) ARCH="amd64" ;; esac
URL="https://github.com/router-for-me/CLIProxyAPI/releases/download/${TAG}/CLIProxyAPI_${VERSION}_linux_${ARCH}.tar.gz"
HTTP_CODE=$(curl -sL -o /dev/null -w '%{http_code}' "$URL")
assert "Download URL returns 200 (got: $HTTP_CODE)" "$([ "$HTTP_CODE" = "200" ] && echo true || echo false)"

# Test: Binary can be extracted
if [ "$HTTP_CODE" = "200" ]; then
  curl -sL "$URL" -o /tmp/cliproxy-test.tar.gz
  CONTENTS=$(tar -tzf /tmp/cliproxy-test.tar.gz 2>/dev/null || echo "")
  assert "Archive contains cli-proxy-api binary" "$(echo "$CONTENTS" | grep -q 'cli-proxy-api' && echo true || echo false)"
  rm -f /tmp/cliproxy-test.tar.gz
fi

[ "${1:-}" = "--install-only" ] && { echo ""; echo "Install checks: $PASS passed, $FAIL failed"; exit $FAIL; }

# ============================================================================
info ""
info "=== Phase 2: Service Setup ==="
# Expected: After install, CLIProxyAPI runs as user systemd service on port 4001
# ============================================================================

if command -v cli-proxy-api &>/dev/null || [ -x "$APP_DIR/bin/cli-proxy-api" ]; then
  assert "cli-proxy-api binary installed" "true"
else
  skip "cli-proxy-api not installed — run '@cliproxy status' first to trigger install"
  echo ""; echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"; exit 0
fi

assert "config directory exists" "$([ -d "$APP_DIR" ] && echo true || echo false)"
assert "config.yaml exists" "$([ -f "$APP_DIR/config.yaml" ] && echo true || echo false)"
assert "auths directory exists" "$([ -d "$APP_DIR/auths" ] && echo true || echo false)"

# Test: systemd service
if systemctl --user is-active cliproxy &>/dev/null; then
  assert "cliproxy service is running" "true"
else
  assert "cliproxy service is running" "false"
fi

# Test: port 4001 is listening
if curl -s http://localhost:4001/v1/models &>/dev/null; then
  assert "CLIProxyAPI responds on port 4001" "true"
else
  assert "CLIProxyAPI responds on port 4001" "false"
fi

# ============================================================================
info ""
info "=== Phase 3: API Key Provider (connect/disconnect) ==="
# User flow:
#   User: "@cliproxy connect grok"
#   Bot:  "Paste your xAI API key."
#   User: "xai-test123..."
#   Bot:  "Connected! Models available: grok-3, grok-3-mini"
#
# Expected result:
#   - config.yaml updated with openai-compatibility section for xai
#   - curl localhost:4001/v1/models includes grok-3
#   - openclaw.json updated with cliproxy provider
# ============================================================================

if [ -f "$APP_DIR/config.yaml" ]; then
  # Check config.yaml is valid YAML
  if python3 -c "import yaml; yaml.safe_load(open('$APP_DIR/config.yaml'))" 2>/dev/null; then
    assert "config.yaml is valid YAML" "true"
  else
    assert "config.yaml is valid YAML" "false"
  fi

  # Check if any providers are connected
  CONNECTED=$(python3 -c "
import yaml
with open('$APP_DIR/config.yaml') as f:
    cfg = yaml.safe_load(f) or {}
providers = []
if cfg.get('openai-compatibility'): providers += [e.get('name','?') for e in cfg['openai-compatibility']]
if cfg.get('claude-api-key'): providers.append('claude-api')
if cfg.get('gemini-api-key'): providers.append('gemini-api')
if cfg.get('codex-api-key'): providers.append('codex-api')
print(','.join(providers) if providers else 'none')
" 2>/dev/null || echo "error")
  info "  Connected API key providers: $CONNECTED"
fi

# Test: models endpoint
if curl -s http://localhost:4001/v1/models &>/dev/null; then
  MODEL_COUNT=$(curl -s http://localhost:4001/v1/models | jq '.data | length' 2>/dev/null || echo "0")
  info "  Available models: $MODEL_COUNT"
  if [ "$MODEL_COUNT" -gt 0 ]; then
    assert "at least one model available" "true"
    curl -s http://localhost:4001/v1/models | jq -r '.data[].id' 2>/dev/null | while read -r m; do
      info "    - $m"
    done
  else
    skip "no models connected yet — use '@cliproxy connect {provider}' to add one"
  fi
fi

# ============================================================================
info ""
info "=== Phase 4: CLI Subscription Provider ==="
# User flow:
#   User: "@cliproxy connect claude"
#   Bot:  "Starting Claude Code auth... Open this URL: https://..."
#   User: (opens URL, completes browser login)
#   Bot:  "Connected! Models: claude-opus-4-6, claude-sonnet-4-6"
#
# Expected result:
#   - Auth file created in ~/apps/com.xshopper.cliproxy/auths/
#   - Token auto-refreshes in background
#   - curl localhost:4001/v1/models includes claude models
# ============================================================================

AUTH_COUNT=$(ls -1 "$APP_DIR/auths/" 2>/dev/null | grep -v '.gitkeep' | wc -l)
info "  CLI auth files: $AUTH_COUNT"
if [ "$AUTH_COUNT" -gt 0 ]; then
  assert "CLI subscription auth files present" "true"
  ls -1 "$APP_DIR/auths/" 2>/dev/null | grep -v '.gitkeep' | while read -r f; do
    info "    - $f"
  done
else
  skip "no CLI subscriptions connected — use '@cliproxy connect claude' etc."
fi

# ============================================================================
info ""
info "=== Phase 5: OpenClaw Integration ==="
# Expected: openclaw.json has models.providers.cliproxy section
#           with models from localhost:4001
# ============================================================================

OC_CONFIG="$HOME/.openclaw/openclaw.json"
if [ -f "$OC_CONFIG" ]; then
  HAS_CLIPROXY=$(python3 -c "
import json
with open('$OC_CONFIG') as f:
    cfg = json.load(f)
p = cfg.get('models',{}).get('providers',{}).get('cliproxy')
print('true' if p else 'false')
" 2>/dev/null || echo "false")
  assert "openclaw.json has cliproxy provider" "$HAS_CLIPROXY"

  if [ "$HAS_CLIPROXY" = "true" ]; then
    OC_MODELS=$(python3 -c "
import json
with open('$OC_CONFIG') as f:
    cfg = json.load(f)
models = cfg.get('models',{}).get('providers',{}).get('cliproxy',{}).get('models',[])
print(len(models))
" 2>/dev/null || echo "0")
    info "  Models in openclaw.json: $OC_MODELS"
  fi
else
  skip "openclaw.json not found (not on a provisioned EC2?)"
fi

# ============================================================================
echo ""
echo "========================================="
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "========================================="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
