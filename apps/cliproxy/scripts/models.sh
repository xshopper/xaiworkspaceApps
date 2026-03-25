#!/bin/bash
# List all models from CLIProxyAPI and test each one
set -euo pipefail

if ! curl -sf http://localhost:4001/health >/dev/null 2>&1; then
  echo "CLIProxyAPI not running. Run: ~/apps/com.xshopper.cliproxy/scripts/start.sh"
  exit 1
fi

MODELS_JSON=$(curl -sf http://localhost:4001/v1/models -H "Authorization: Bearer local-only" 2>/dev/null || echo '{"data":[]}')
MODEL_IDS=$(echo "$MODELS_JSON" | jq -r '.data[].id' 2>/dev/null)

if [ -z "$MODEL_IDS" ]; then
  echo "No models available"
  exit 0
fi

COUNT=$(echo "$MODEL_IDS" | wc -l)
echo "=== Testing ${COUNT} model(s) ==="

for MODEL in $MODEL_IDS; do
  RESULT=$(curl -sf -X POST http://localhost:4001/v1/chat/completions \
    -H "Authorization: Bearer local-only" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" \
    --max-time 15 2>&1 || echo "FAIL")
  if echo "$RESULT" | jq -e '.choices[0]' >/dev/null 2>&1; then
    echo "OK ${MODEL}"
  else
    echo "FAIL ${MODEL}"
  fi
done
