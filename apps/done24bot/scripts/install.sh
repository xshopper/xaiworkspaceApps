#!/bin/bash
set -e

APP_DIR=~/apps/com.done24bot.browser
cd "$APP_DIR"

echo "=== Installing Done24Bot Browser ==="

# Install puppeteer-core (no bundled Chrome — we connect to remote browser)
if [ ! -d node_modules/puppeteer-core ]; then
  npm install --no-save puppeteer-core 2>&1
  echo "[done24bot] puppeteer-core installed"
else
  echo "[done24bot] puppeteer-core already installed"
fi

# Create screenshots directory
mkdir -p screenshots

# Save API key from install parameters if provided
if [ -n "$APP_PARAMETERS" ]; then
  API_KEY=$(echo "$APP_PARAMETERS" | node -e "try{const p=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));if(p.apiKey)console.log(p.apiKey)}catch{}")
  if [ -n "$API_KEY" ]; then
    node -e "
      const fs = require('fs');
      const p = 'config.json';
      const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
      c.apiKey = process.argv[1];
      fs.writeFileSync(p, JSON.stringify(c, null, 2));
    " "$API_KEY"
    echo "[done24bot] API key saved from install parameters"
  fi
fi

echo "=== Done24Bot Browser installed ==="
