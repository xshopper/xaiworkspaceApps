#!/bin/bash
set -euo pipefail
# generate-ecosystem.sh — Generate pm2 ecosystem.config.js from runtime environment
#
# Reads: /etc/xai/secrets.env (written by cloud-init)
# Writes: ~/apps/com.xshopper.openclaw/ecosystem.config.js
#
# Uses Node.js for JSON serialization to prevent code injection from manifest values.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Source secrets for environment values
[ -f /etc/xai/secrets.env ] && set -a && source /etc/xai/secrets.env && set +a

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

// Scan other installed mini apps for startup entries.
//
// SECURITY MODEL (tightened from the original character allowlist):
//
// The previous regex `^[\w ./\-~&=:\x27"]+$` accepted anything built from
// alphanumerics, spaces, slashes, hyphens, quotes, and equals — which
// happily let strings like `rm -rf /` pass validation. Since the startup
// string is passed to `bash -c`, any argv we tolerate becomes unsandboxed
// shell.
//
// New model: the startup value must either be a path under the apps
// directory, OR it must begin with an allowlisted interpreter followed by
// a space. After the prefix we still reject shell metacharacters that would
// let the command branch into unrelated binaries (backtick, dollar-paren,
// pipes, semicolons, redirection, comment markers).
// `bash `/`sh ` are intentionally excluded — they would let
// `bash evil.sh` pass the prefix allowlist. First-party apps use
// node/pnpm/npm; path-resolution below still accepts direct shell
// scripts that live under the apps directory (e.g. `./run.sh`).
const ALLOWED_STARTUP_PREFIXES = [
  "node ",
  "python3 ",
  "pnpm ",
  "npm ",
];
// Characters that enable command chaining / substitution / redirection.
// Even if the prefix is safe, an attacker could tack on `; evil` after a
// legitimate `node index.js` to execute arbitrary code.
const FORBIDDEN_STARTUP_CHARS = /[`$|;<>(){}]/;
const appsDir = path.join(HOME, "apps");
if (fs.existsSync(appsDir)) {
  for (const entry of fs.readdirSync(appsDir)) {
    const manifestPath = path.join(appsDir, entry, "manifest.yml");
    if (!fs.existsSync(manifestPath)) continue;
    const appDir = path.join(appsDir, entry);
    if (appDir === APP_DIR) continue; // skip ourselves
    // Skip workspace-agent — it is managed by the bootstrap ecosystem (/opt/bootstrap/)
    // and its startup command (pm2 restart) would cause a self-kill loop
    const dirName = path.basename(appDir);
    if (dirName === "com.xshopper.workspace-agent" || dirName === "workspace-agent") continue;

    let manifest;
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      manifest = yaml.load(raw);
    } catch { continue; }

    const slug = manifest.slug || entry;
    const startup = manifest.startup;
    if (!startup || startup === "null" || startup === "None") continue;

    // Block control characters (newlines, tabs, carriage returns)
    if (/[\x00-\x1f\x7f]/.test(startup)) {
      console.error("WARNING: Skipping app-" + slug + " — startup contains control characters");
      continue;
    }
    // Block standalone `&` (background operator) but allow the exact
    // two-character `&&` (command chaining). First-party apps commonly use
    // `cd ~/apps/... && node ...`. `FORBIDDEN_STARTUP_CHARS` still blocks
    // `|`, `;`, backtick, `$`, `{}`, so `&&` cannot be combined with
    // other metacharacters to branch into unrelated binaries.
    //
    // Two-stage check:
    //   1. Reject `&&&+` — negative-lookbehind alone skips this because
    //      every `&` in a run of 3+ has a neighbour on one side. We need
    //      an explicit triple-or-more rejection.
    //   2. Reject lone `&` (not part of a `&&` pair).
    if (/&{3,}/.test(startup)) {
      console.error("WARNING: Skipping app-" + slug + " — startup contains run of 3+ '&' (only exact && is permitted)");
      continue;
    }
    if (/(?<!&)&(?!&)/.test(startup)) {
      console.error("WARNING: Skipping app-" + slug + " — startup contains lone & (background operator)");
      continue;
    }
    if (FORBIDDEN_STARTUP_CHARS.test(startup)) {
      console.error("WARNING: Skipping app-" + slug + " — startup contains forbidden shell metacharacter: " + startup.slice(0, 100));
      continue;
    }
    if (startup.length > 500) {
      console.error("WARNING: Skipping app-" + slug + " — startup too long (" + startup.length + " chars)");
      continue;
    }

    // Startup must either (a) begin with an allowlisted interpreter + space
    // or (b) be a path inside the app directory (resolved with realpath
    // equivalence; symlinks that point outside are rejected).
    const hasAllowedPrefix = ALLOWED_STARTUP_PREFIXES.some((p) => startup.startsWith(p));
    let startupOk = hasAllowedPrefix;
    if (!startupOk) {
      // Treat the first whitespace-separated token as the command path.
      const firstTok = startup.split(/\s+/)[0] || "";
      try {
        const resolved = path.resolve(appDir, firstTok);
        const realAppDir = fs.realpathSync(appDir);
        // realpathSync may fail if the file does not exist — fall back to
        // resolved path containment.
        let realResolved = resolved;
        try { realResolved = fs.realpathSync(resolved); } catch { /* ok */ }
        const rootWithSep = realAppDir.endsWith(path.sep) ? realAppDir : realAppDir + path.sep;
        startupOk = realResolved === realAppDir || realResolved.startsWith(rootWithSep);
      } catch { startupOk = false; }
    }
    if (!startupOk) {
      console.error("WARNING: Skipping app-" + slug + " — startup must begin with an allowed interpreter (" + ALLOWED_STARTUP_PREFIXES.map((p) => p.trim()).join(", ") + ") or resolve to a path under " + appDir + ". Got: " + startup.slice(0, 100));
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
