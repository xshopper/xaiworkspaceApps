#!/bin/bash

echo "Stopping Claude Code server..."
pm2 stop claude-code-server 2>/dev/null && echo "Stopped." || echo "Not running."
