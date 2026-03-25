#!/bin/bash
# Test a single model via CLIProxyAPI
# Usage: test-model.sh <model-name>
# Output: "OK <model>" or "FAIL <model>"
set -euo pipefail
MODEL="${1:-}"
if [ -z "$MODEL" ]; then
  echo "FAIL unknown"
  exit 0
fi
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
