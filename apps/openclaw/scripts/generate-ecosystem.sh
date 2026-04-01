#!/bin/bash
set -euo pipefail
# generate-ecosystem.sh — Generate pm2 ecosystem.config.js from runtime environment
#
# Reads: /etc/openclaw/secrets.env (written by cloud-init)
# Writes: ~/apps/com.xshopper.openclaw/ecosystem.config.js
#
# Uses Node.js for JSON serialization to prevent code injection from manifest values.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Source secrets for environment values
[ -f /etc/openclaw/secrets.env ] && set -a && source /etc/openclaw/secrets.env && set +a

: "${PORT:=19001}"
: "${CHAT_ID:=unknown}"

# Resolve client user from HOME
CLIENT_USER="${CLIENT_USER:-$(stat -c '%U' "$HOME" 2>/dev/null || echo "root")}"
CLIENT_UID=$(id -u "$CLIENT_USER" 2>/dev/null || echo "0")
CLIENT_GID=$(id -g "$CLIENT_USER" 2>/dev/null || echo "0")
S3_BUCKET="${S3_BUCKET:-}"
EFS_REGION="${AWS_DEFAULT_REGION:-ap-southeast-2}"
HAS_INOTIFY=$(command -v inotifywait &>/dev/null && echo "true" || echo "false")

# Export _* prefixed vars so Node.js can read them from process.env
export _APP_DIR="$APP_DIR"
export _HOME="$HOME"
export _CLIENT_USER="$CLIENT_USER"
export _CLIENT_UID="$CLIENT_UID"
export _CLIENT_GID="$CLIENT_GID"
export _PORT="$PORT"
export _S3_BUCKET="$S3_BUCKET"
export _EFS_REGION="$EFS_REGION"
export _CHAT_ID="$CHAT_ID"
export _HAS_INOTIFY="$HAS_INOTIFY"

# Use Node.js to build the config safely (JSON.stringify escapes all untrusted values)
node -e '
const fs = require("fs");
const path = require("path");
const yaml = (() => { try { return require("js-yaml"); } catch { return null; } })();

const APP_DIR = process.env._APP_DIR;
const HOME = process.env._HOME;
const CLIENT_USER = process.env._CLIENT_USER;
const CLIENT_UID = parseInt(process.env._CLIENT_UID || "0");
const CLIENT_GID = parseInt(process.env._CLIENT_GID || "0");
const PORT = process.env._PORT;
const S3_BUCKET = process.env._S3_BUCKET;
const EFS_REGION = process.env._EFS_REGION;
const CHAT_ID = process.env._CHAT_ID;
const HAS_INOTIFY = process.env._HAS_INOTIFY === "true";

const apps = [
  {
    name: "openclaw",
    script: path.join(APP_DIR, "scripts", "start-gateway.sh"),
    args: ["--port", PORT, "--bind", "lan", "--allow-unconfigured"],
    interpreter: "/bin/bash",
    cwd: HOME,
    uid: CLIENT_UID,
    gid: CLIENT_GID,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: "768M",
    kill_timeout: 5000,
  },
  {
    name: "bridge",
    script: path.join(APP_DIR, "bridge.js"),
    interpreter: "node",
    cwd: APP_DIR,
    uid: CLIENT_UID,
    gid: CLIENT_GID,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    env: { NODE_OPTIONS: "--dns-result-order=ipv4first" },
  },
  {
    name: "stunnel",
    script: "/usr/bin/stunnel",
    args: "/etc/stunnel/openclaw.conf",
    interpreter: "none",
    autorestart: true,
    restart_delay: 3000,
  },
];

if (HAS_INOTIFY) {
  apps.push({
    name: "config-sync",
    script: "/usr/local/bin/openclaw-config-sync.sh",
    args: [CLIENT_USER, S3_BUCKET, CHAT_ID, EFS_REGION],
    interpreter: "/bin/bash",
    autorestart: true,
    max_restarts: 5,
    restart_delay: 10000,
  });
}

apps.push(
  {
    name: "config-pull",
    script: "/usr/local/bin/openclaw-config-pull.sh",
    args: [CLIENT_USER, S3_BUCKET, CHAT_ID, EFS_REGION],
    interpreter: "/bin/bash",
    autorestart: false,
    cron_restart: "* * * * *",
  },
  {
    name: "workspace-pull",
    script: "/usr/local/bin/openclaw-workspace-pull.sh",
    args: [CLIENT_USER, S3_BUCKET, EFS_REGION],
    interpreter: "/bin/bash",
    autorestart: false,
    cron_restart: "*/5 * * * *",
  },
  {
    name: "health-watchdog",
    script: "/usr/local/bin/openclaw-health-watchdog.sh",
    args: [PORT, "3"],
    interpreter: "/bin/bash",
    autorestart: false,
    cron_restart: "* * * * *",
  },
);

// Scan other installed mini apps for startup entries
// Allowed: word chars, space, path chars, && for chaining, = : for flags, quotes
// Blocked: newlines, $, backtick, ;, single |, >, <, (, ), {, }
const SAFE_STARTUP_RE = /^[\w ./\-~&=:\x27"]+$/;
const appsDir = path.join(HOME, "apps");
if (fs.existsSync(appsDir)) {
  for (const entry of fs.readdirSync(appsDir)) {
    const manifestPath = path.join(appsDir, entry, "manifest.yml");
    if (!fs.existsSync(manifestPath)) continue;
    const appDir = path.join(appsDir, entry);
    if (appDir === APP_DIR) continue; // skip ourselves

    let manifest;
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      if (yaml) {
        manifest = yaml.load(raw);
      } else {
        // Minimal YAML parsing: extract slug and startup fields
        const slugMatch = raw.match(/^slug:\s*(.+)$/m);
        const startupMatch = raw.match(/^startup:\s*"(.+?)"\s*$/m)
          || raw.match(/^startup:\s*\x27(.+?)\x27\s*$/m)
          || raw.match(/^startup:\s*([^\s#].+?)\s*$/m);
        manifest = {
          slug: slugMatch ? slugMatch[1].trim() : entry,
          startup: startupMatch ? startupMatch[1].trim() : null,
        };
      }
    } catch { continue; }

    const slug = manifest.slug || entry;
    const startup = manifest.startup;
    if (!startup || startup === "null" || startup === "None") continue;

    // Block control characters (newlines, tabs, carriage returns)
    if (/[\x00-\x1f\x7f]/.test(startup)) {
      console.error("WARNING: Skipping app-" + slug + " — startup contains control characters");
      continue;
    }
    // Block standalone & (background operator) — distinct from && (chaining)
    // This check MUST precede SAFE_STARTUP_RE because that regex allows & chars (for &&)
    if (/(?<![&])&(?![&])/.test(startup)) {
      console.error("WARNING: Skipping app-" + slug + " — startup uses background operator &");
      continue;
    }
    // Validate startup command against allowlist to prevent shell injection
    if (!SAFE_STARTUP_RE.test(startup)) {
      console.error("WARNING: Skipping app-" + slug + " — startup contains unsafe characters: " + startup.slice(0, 100));
      continue;
    }
    if (startup.length > 500) {
      console.error("WARNING: Skipping app-" + slug + " — startup too long (" + startup.length + " chars)");
      continue;
    }

    apps.push({
      name: "app-" + slug,
      script: "/bin/bash",
      args: ["-c", startup],
      interpreter: "none",
      cwd: appDir,
      uid: CLIENT_UID,
      gid: CLIENT_GID,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
    });
    console.error("Mini app registered: " + slug);
  }
}

// Write ecosystem config as valid JS module
const output = "module.exports = " + JSON.stringify({ apps }, null, 2) + ";\n";
fs.writeFileSync(path.join(APP_DIR, "ecosystem.config.js"), output, { mode: 0o600 });
console.error("Generated ecosystem.config.js");
' 2>&1

# Clean up exported vars
unset _APP_DIR _HOME _CLIENT_USER _CLIENT_UID _CLIENT_GID _PORT _S3_BUCKET _EFS_REGION _CHAT_ID _HAS_INOTIFY
