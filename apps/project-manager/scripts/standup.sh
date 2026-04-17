#!/usr/bin/env bash
set -euo pipefail
BASE="http://localhost:3462"

PROJECTS=$(curl -sf "$BASE/api/projects" 2>/dev/null || echo '{"projects":[]}')
PID=$(echo "$PROJECTS" | jq -r '.projects[0].id // empty')

if [ -z "$PID" ]; then
  echo "No projects found."
  exit 0
fi

PNAME=$(echo "$PROJECTS" | jq -r '.projects[0].name')
STANDUP=$(curl -sf "$BASE/api/standup/$PID" 2>/dev/null || echo '{}')

echo "## Daily Standup — $PNAME"
echo ""

SPRINT=$(echo "$STANDUP" | jq -r '.sprint.name // "No active sprint"')
echo "**Sprint:** $SPRINT"
echo ""

echo "### Completed (last 24h)"
echo "$STANDUP" | jq -r '.recently_done[] | "- [x] \(.title) (\(.assignee // "unassigned"))"' 2>/dev/null || echo "- None"
echo ""

echo "### In Progress"
echo "$STANDUP" | jq -r '.in_progress[] | "- [ ] \(.title) (\(.assignee // "unassigned")) — \(.priority)"' 2>/dev/null || echo "- None"
echo ""

echo "### Blockers"
BLOCKERS=$(echo "$STANDUP" | jq '.blockers | length' 2>/dev/null || echo 0)
if [ "$BLOCKERS" -gt 0 ]; then
  echo "$STANDUP" | jq -r '.blockers[] | "- ⚠ \(.title) — stalled since \(.updated_at | split("T")[0])"' 2>/dev/null
else
  echo "- None"
fi
