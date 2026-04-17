#!/usr/bin/env bash
# Stop done24bot server process
pkill -u "$(id -u)" -f 'done24bot.*server.js' 2>/dev/null || true
