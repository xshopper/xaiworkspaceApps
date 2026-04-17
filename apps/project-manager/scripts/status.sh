#!/usr/bin/env bash
set -euo pipefail
BASE="http://localhost:3462"

echo "## Project Manager Status"
echo ""

PROJECTS=$(curl -sf "$BASE/api/projects" 2>/dev/null || echo '{"projects":[]}')
COUNT=$(echo "$PROJECTS" | jq '.projects | length')
echo "**Projects:** $COUNT"
echo ""

echo "$PROJECTS" | jq -r '.projects[] | "### \(.name)\n- Tasks: \(.task_count // 0)\n- Sprints: \(.sprint_count // 0)\n"'

if [ "$COUNT" -gt 0 ]; then
  PID=$(echo "$PROJECTS" | jq -r '.projects[0].id')
  BOARD=$(curl -sf "$BASE/api/board/$PID" 2>/dev/null || echo '{}')
  echo "**Board ($(echo "$PROJECTS" | jq -r '.projects[0].name')):**"
  echo ""
  echo "| Status | Count |"
  echo "|--------|-------|"
  for s in backlog todo in_progress review done; do
    C=$(echo "$BOARD" | jq ".columns.${s} | length" 2>/dev/null || echo 0)
    echo "| $s | $C |"
  done
fi
