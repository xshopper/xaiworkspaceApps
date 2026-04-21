#!/bin/bash
set -euo pipefail
# generate-ecosystem.sh — Generate pm2 ecosystem.config.js from runtime environment
#
# Reads: /etc/xai/secrets.env (written by cloud-init)
# Writes: ~/apps/com.xshopper.openclaw/ecosystem.config.js
#
# Uses Node.js for JSON serialization to prevent code injection from manifest values.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Source secrets for environment values.
# Prefer the per-user copy written by entrypoint.sh (mode 600, chown $WS_USER).
# /etc/xai/secrets.env is root-owned 600 — sourcing it as the derived user
# aborts the script under set -e with "Permission denied".
set -a
for SECRETS_FILE in "$HOME/.openclaw/secrets.env" /etc/xai/secrets.env; do
  if [ -r "$SECRETS_FILE" ]; then
    source "$SECRETS_FILE"
    break
  fi
done
set +a

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
// js-yaml is a hard dependency (see package.json). Fail fast if it is
// missing — the previous "minimal fallback parser" below was both
// fragile (couldnt parse non-trivial YAML) and security-surface
// expansion (its startup regex let `rm -rf /` through). Abort on load
// failure rather than silently degrading to an unsafe path.
let yaml;
try {
  yaml = require("js-yaml");
} catch (err) {
  console.error("[generate-ecosystem] FATAL: js-yaml is not installed. Run `pnpm install` in the openclaw app dir.");
  process.exit(1);
}

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

// NOTE: mini-app supervision is owned by workspace-agent (bridge.js), which
// pm2-spawns each installed app under its own slug ("cliproxy", "connect",
// etc.) as part of the install_app handler. Emitting a duplicate
// "app-<slug>" entry here would put two pm2 processes on the same port
// (e.g. cliproxy + app-cliproxy both binding 4001) — a crash-loop as
// pm2 autorestart ping-pongs them on `EADDRINUSE`.
//
// The legacy scan-apps loop was removed in favour of single-supervisor
// ownership by the bridge. If/when openclaw needs to manage a helper
// process that the bridge does NOT install (rare), reintroduce a narrow
// allowlist here — do NOT resurrect the generic enumerate-all-manifests
// loop.

// Write ecosystem config as valid JS module
const output = "module.exports = " + JSON.stringify({ apps }, null, 2) + ";\n";
fs.writeFileSync(path.join(APP_DIR, "ecosystem.config.js"), output, { mode: 0o600 });
console.error("Generated ecosystem.config.js");
' 2>&1

# Clean up exported vars
unset _APP_DIR _HOME _CLIENT_USER _CLIENT_UID _CLIENT_GID _PORT _S3_BUCKET _EFS_REGION _CHAT_ID _HAS_INOTIFY
