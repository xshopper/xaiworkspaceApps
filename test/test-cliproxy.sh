#!/bin/bash
# test-cliproxy.sh — Test the CLI Proxy app (apps/cliproxy).
# Run on a provisioned workspace where pm2 and curl are available.
# Usage: ./test/test-cliproxy.sh [--install-only]

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$DIR/_lib.sh"
PASS=0 FAIL=0 SKIP=0
APP_DIR="$HOME/apps/com.xshopper.cliproxy"

info "=== Phase 1: Binary Installation ==="
# Verifies the GitHub release download path used by the app's first-run installer.

TAG=$(curl -sL https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest \
  | jq -r '.tag_name')
assert "GitHub latest release exists (got: $TAG)" \
  "$([ -n "$TAG" ] && [ "$TAG" != "null" ] && echo true || echo false)"

ARCH=$(uname -m)
case "$ARCH" in aarch64) ARCH="arm64" ;; x86_64) ARCH="amd64" ;; esac
URL="https://github.com/router-for-me/CLIProxyAPI/releases/download/${TAG}/CLIProxyAPI_${TAG#v}_linux_${ARCH}.tar.gz"
HTTP=$(http_code "$URL")
assert "Download URL returns 200 (got: $HTTP)" \
  "$([ "$HTTP" = "200" ] && echo true || echo false)"

if [ "$HTTP" = "200" ]; then
  TMP=$(mktemp --suffix=.tar.gz)
  trap 'rm -f "$TMP"' EXIT
  curl -sL "$URL" -o "$TMP"
  assert "Archive contains cli-proxy-api binary" \
    "$(tar -tzf "$TMP" 2>/dev/null | grep -q cli-proxy-api && echo true || echo false)"
fi

if [ "${1:-}" = "--install-only" ]; then
  summary
  exit
fi

info ""
info "=== Phase 2: Service Setup ==="

if command -v cli-proxy-api >/dev/null 2>&1 || [ -x "$APP_DIR/bin/cli-proxy-api" ]; then
  assert "cli-proxy-api binary installed" "true"
else
  skip "cli-proxy-api not installed — run '@cliproxy status' first to trigger install"
  summary
  exit
fi

assert "config directory exists" "$([ -d "$APP_DIR" ] && echo true || echo false)"
assert "config.yaml exists" "$([ -f "$APP_DIR/config.yaml" ] && echo true || echo false)"
assert "auths directory exists" "$([ -d "$APP_DIR/auths" ] && echo true || echo false)"
assert "cliproxy pm2 process running" \
  "$(pm2 describe cliproxy >/dev/null 2>&1 && echo true || echo false)"
assert "CLIProxyAPI responds on port 4001" \
  "$(curl -sf http://localhost:4001/v1/models -o /dev/null && echo true || echo false)"

info ""
info "=== Phase 3: API Key Provider (connect/disconnect) ==="
# User flow:  '@cliproxy connect grok'  →  paste key  →  models list updates.

if [ -f "$APP_DIR/config.yaml" ]; then
  assert "config.yaml is valid YAML" \
    "$(python3 -c "import yaml; yaml.safe_load(open('$APP_DIR/config.yaml'))" 2>/dev/null && echo true || echo false)"

  CONNECTED=$(python3 - "$APP_DIR/config.yaml" <<'PY' 2>/dev/null || echo error
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1])) or {}
p = []
p += [e.get('name','?') for e in (cfg.get('openai-compatibility') or [])]
for k in ('claude-api-key','gemini-api-key','codex-api-key'):
    if cfg.get(k): p.append(k.replace('-key',''))
print(','.join(p) if p else 'none')
PY
)
  info "  Connected API key providers: $CONNECTED"
fi

if curl -sf http://localhost:4001/v1/models -o /dev/null; then
  MODEL_COUNT=$(curl -s http://localhost:4001/v1/models | jq '.data | length' 2>/dev/null || echo 0)
  info "  Available models: $MODEL_COUNT"
  if [ "$MODEL_COUNT" -gt 0 ]; then
    assert "at least one model available" "true"
    curl -s http://localhost:4001/v1/models | jq -r '.data[].id' 2>/dev/null \
      | while read -r m; do info "    - $m"; done
  else
    skip "no models connected — use '@cliproxy connect {provider}'"
  fi
fi

info ""
info "=== Phase 4: CLI Subscription Provider ==="
# User flow:  '@cliproxy connect claude'  →  OAuth browser flow  →  auth file in auths/.

AUTH_COUNT=$(find "$APP_DIR/auths" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' 2>/dev/null | wc -l)
info "  CLI auth files: $AUTH_COUNT"
if [ "$AUTH_COUNT" -gt 0 ]; then
  assert "CLI subscription auth files present" "true"
  find "$APP_DIR/auths" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -printf '    - %f\n' 2>/dev/null
else
  skip "no CLI subscriptions connected — use '@cliproxy connect claude' etc."
fi

info ""
info "=== Phase 5: OpenClaw Integration ==="

OC_CONFIG="$HOME/.openclaw/openclaw.json"
if [ -f "$OC_CONFIG" ]; then
  HAS_CLIPROXY=$(python3 - "$OC_CONFIG" <<'PY' 2>/dev/null || echo false
import sys, json
cfg = json.load(open(sys.argv[1]))
print('true' if cfg.get('models',{}).get('providers',{}).get('cliproxy') else 'false')
PY
)
  assert "openclaw.json has cliproxy provider" "$HAS_CLIPROXY"

  if [ "$HAS_CLIPROXY" = "true" ]; then
    OC_MODELS=$(python3 - "$OC_CONFIG" <<'PY' 2>/dev/null || echo 0
import sys, json
cfg = json.load(open(sys.argv[1]))
print(len(cfg.get('models',{}).get('providers',{}).get('cliproxy',{}).get('models',[])))
PY
)
    info "  Models in openclaw.json: $OC_MODELS"
  fi
else
  skip "openclaw.json not found (not on a provisioned workspace?)"
fi

summary
