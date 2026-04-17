/**
 * @agent mini-app — AI agent with configurable persona
 *
 * Thin wrapper around Claude Code SDK. Receives messages via local HTTP server,
 * runs Claude Code with session resume, sends inter-agent messages via bridge
 * HTTP endpoint (curl from Claude Code bash tool).
 *
 * Env vars (set by App Manager multi-instance):
 *   APP_INSTANCE_NAME  — agent instance name (e.g. "dev-01")
 *   APP_PARAMETERS     — JSON string with persona config
 */

import http from 'node:http';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// API key — prefer APP_API_KEY (new name), fall back to ANTHROPIC_API_KEY.
//
// Mirror the `apps/connect/index.js` + `apps/cliproxy/scripts/setkey.sh`
// pattern: the bridge issues a LiteLLM virtual key under `APP_API_KEY`;
// `ANTHROPIC_API_KEY` is the legacy name the Claude Agent SDK reads.
// Copy APP_API_KEY -> ANTHROPIC_API_KEY before we load the SDK so any
// module-load-time client construction picks it up. We use a dynamic
// `await import()` here (rather than a static `import`) specifically so
// the env mutation above runs first; with a static import the SDK's
// module body evaluates before this code regardless of source order.
const APP_API_KEY = process.env.APP_API_KEY || process.env.ANTHROPIC_API_KEY || '';
if (APP_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = APP_API_KEY;
}
if (!APP_API_KEY) {
  console.warn('[agent] WARNING: Neither APP_API_KEY nor ANTHROPIC_API_KEY is set — Claude Agent SDK calls will fail. The bridge should inject APP_API_KEY as the mini-app LiteLLM virtual key (legacy name: ANTHROPIC_API_KEY).');
}
if (APP_API_KEY.startsWith('sk-ant-')) {
  console.warn('[agent] WARNING: APP_API_KEY looks like a real Anthropic API key (sk-ant- prefix). This should be a LiteLLM virtual key issued by the bridge, not a production Anthropic key. Check bridge/pm2 env.');
}

const { query } = await import('@anthropic-ai/claude-agent-sdk');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGENT_NAME = process.env.APP_INSTANCE_NAME || 'default';
// Defense-in-depth: enforce the same name regex the router/bridge validate against
// at install time. Rejects anything that could escape template-literal contexts
// (the system prompt, shell commands in tool-generated curl examples, etc.).
// Router is the authoritative check; this is a last-line safety net.
if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(AGENT_NAME) || AGENT_NAME.includes('--')) {
  console.error(`[agent] FATAL: APP_INSTANCE_NAME "${AGENT_NAME}" does not match ^[a-z0-9][a-z0-9-]{0,49}$ (no "--")`);
  process.exit(1);
}
let PARAMS = {};
try { PARAMS = JSON.parse(process.env.APP_PARAMETERS || '{}'); }
catch (err) { console.error('[agent] Failed to parse APP_PARAMETERS, using defaults:', err.message); }
const PORT = parseInt(process.env.APP_PORT || '0', 10); // 0 = auto-assign
const BRIDGE_URL = (() => {
  const url = process.env.BRIDGE_URL || 'http://127.0.0.1:19099';
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      console.error(`[agent] BRIDGE_URL must be loopback, got: ${parsed.hostname}. Falling back to default.`);
      return 'http://127.0.0.1:19099';
    }
    return url;
  } catch { return 'http://127.0.0.1:19099'; }
})();
const BRIDGE_TOKEN = process.env.APP_BRIDGE_TOKEN || '';
const CWD = process.env.AGENT_CWD || process.env.HOME || '/root';

// ── Address (Sprint 2 track C) ──────────────────────────────────────────────
// Locked format: domain/worker_id/app_identifier/instance_name
//   domain        — from DOMAIN (SDK v1 contract; set by router, with bridge fallback)
//   worker_id     — from WORKSPACE_INSTANCE_ID (or INSTANCE_ID), unique per worker
//   app_identifier— manifest identifier, com.xaiworkspace.agent
//   instance_name — APP_INSTANCE_NAME (this process)
const APP_IDENTIFIER = process.env.APP_IDENTIFIER || 'com.xaiworkspace.agent';
// Slug is the last dotted segment of the identifier (e.g. "com.xshopper.sales-agent" → "sales-agent").
// Used as the port-file prefix so multiple agent-like apps don't collide on /tmp.
const APP_SLUG = APP_IDENTIFIER.slice(APP_IDENTIFIER.lastIndexOf('.') + 1) || 'agent';
const PORT_FILE = `/tmp/${APP_SLUG}-${AGENT_NAME}.port`;
const DOMAIN = process.env.DOMAIN || 'xaiworkspace.com';
const WORKER_ID = process.env.WORKSPACE_INSTANCE_ID || process.env.INSTANCE_ID || 'unknown';
const IS_PUBLIC = PARAMS.public === true;
// Private agents are addressed as domain/worker_id/app_identifier/instance_name —
// running with WORKER_ID='unknown' means messages can't be routed back to us.
// Public agents can start without one because they're addressable by short form.
if (!IS_PUBLIC && WORKER_ID === 'unknown') {
  console.error('[agent] FATAL: WORKSPACE_INSTANCE_ID/INSTANCE_ID is not set — private agents require a worker id for addressable routing.');
  process.exit(1);
}
// Public agents publish their short form externally, but the worker-scoped
// form is still valid for internal/loopback delivery.
const OWN_ADDRESS = IS_PUBLIC
  ? `${DOMAIN}/${APP_IDENTIFIER}/${AGENT_NAME}`
  : `${DOMAIN}/${WORKER_ID}/${APP_IDENTIFIER}/${AGENT_NAME}`;

// Address parsing/local-target detection lives in the bridge; the agent only
// needs to know its OWN_ADDRESS and pass it as `from` on every outbound call.

// ---------------------------------------------------------------------------
// Persona system prompts
// ---------------------------------------------------------------------------

const PERSONA_PROMPTS = {
  pm: `You are a Project Manager agent named "${AGENT_NAME}".
You coordinate work across a team of agents. Break down user requests into tasks,
assign them to the right agents, and track progress. Be concise and action-oriented.`,

  developer: `You are a Senior Developer agent named "${AGENT_NAME}".
You write, debug, and refactor code. You have full access to the filesystem, shell,
and git. Write clean, well-tested code. Report what you changed when done.`,

  tester: `You are a QA Tester agent named "${AGENT_NAME}".
You write and run tests, check code quality, and report bugs. Be thorough and
methodical. Always report test results clearly.`,

  reviewer: `You are a Code Reviewer agent named "${AGENT_NAME}".
You review code for bugs, security issues, performance problems, and style.
Be constructive and specific. Suggest fixes, not just problems.`,
};

function getSystemPrompt() {
  const persona = PARAMS.persona || 'developer';
  const base = PERSONA_PROMPTS[persona] || PERSONA_PROMPTS.developer;

  // IMPORTANT: do NOT interpolate the literal BRIDGE_TOKEN value into the
  // system prompt. Doing so embeds a high-value secret into Claude's
  // session history (which may be persisted to disk, logged, or echoed
  // back to the user in error traces). Instead, reference the env var by
  // name and have the LLM curl with the shell's own expansion
  // ($APP_BRIDGE_TOKEN) — the token stays in memory + env only.
  return `${base}

## Your Address

You are: ${OWN_ADDRESS}

The address format is: domain/worker_id/app_identifier/instance_name
(public agents use the short form domain/app_identifier/instance_name).

## Inter-Agent Messaging

To send a message to another agent, post the full target address to the
bridge's agent-message endpoint. Use the \`$APP_BRIDGE_TOKEN\` environment
variable (already set in your shell) for the auth header — never hardcode
the token value into commands or chat, that leaks it into logs and
conversation history:

curl -s -X POST ${BRIDGE_URL}/api/agent-message \\
  -H 'Content-Type: application/json' \\
  -H "X-App-Bridge-Token: $APP_BRIDGE_TOKEN" \\
  -d '{"from":"${OWN_ADDRESS}","to":"DOMAIN/WORKER_ID/com.xaiworkspace.agent/TARGET_NAME","message":"YOUR_MESSAGE"}'

Your address is ${OWN_ADDRESS} — always pass it as the 'from' field.
For agents on the same worker, addresses use the same DOMAIN/WORKER_ID prefix
and delivery is fast (loopback). Cross-worker messages are routed via the
router. Public agents are addressable as DOMAIN/com.xaiworkspace.agent/NAME.

Messages are freetext — write naturally.`;
}

// ---------------------------------------------------------------------------
// Claude Code session management
// ---------------------------------------------------------------------------

let sessionId = null;
let busy = false;
const messageQueue = [];

// Persona-specific permission policy.
// Previously every persona ran with `bypassPermissions` + `allowDangerouslySkipPermissions`
// which meant any inter-agent message could trigger unsandboxed shell execution.
// This is especially dangerous for the `tester` and `reviewer` personas (which
// should never write or execute production code) but also inappropriate for
// `pm` (coordinates, doesn't execute) and `developer` (should prompt for
// destructive/system changes).
//
// Policy: always run in the default (approval-required) mode. The manifest
// `approvalRequired` field on the installed app defines which tools require
// explicit user approval; the SDK defers to that when we don't override.
const PERSONA_PERMISSION_MODE = {
  pm: 'default',
  developer: 'default',
  tester: 'default',
  reviewer: 'default',
};

async function runClaude(prompt) {
  const persona = PARAMS.persona || 'developer';
  const permissionMode = PERSONA_PERMISSION_MODE[persona] || 'default';
  const options = {
    cwd: CWD,
    // Never use 'bypassPermissions' — that makes inter-agent messages a
    // remote shell. Stay on the SDK default so manifest `approvalRequired`
    // entries gate sensitive tools.
    permissionMode,
    maxTurns: 50,
    model: PARAMS.model || undefined,
  };

  if (sessionId) {
    options.resume = sessionId;
  }

  let result = null;

  for await (const msg of query({ prompt, systemPrompt: getSystemPrompt(), options })) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      sessionId = msg.session_id;
    }
    if (msg.type === 'result' && msg.subtype === 'success') {
      result = msg.result;
      sessionId = msg.session_id;
    } else if (msg.type === 'result') {
      const errText = msg.errors?.join(', ') ?? msg.subtype ?? 'unknown error';
      result = `Error: ${errText}`;
      sessionId = msg.session_id;
    }
  }

  return result || '(no output)';
}

// ---------------------------------------------------------------------------
// Message processing — sequential to avoid concurrent Claude Code sessions
// ---------------------------------------------------------------------------

const MAX_QUEUE = 100;

async function processMessage(msg) {
  if (busy) {
    if (messageQueue.length >= MAX_QUEUE) {
      console.warn(`[agent:${AGENT_NAME}] Queue full (${MAX_QUEUE}), rejecting message`);
      // Surface the drop back to the caller so they know the work was
      // rejected rather than silently accepted.
      if (msg.type === 'user_input') {
        await sendToBridge({
          type: 'agent_response',
          agentName: AGENT_NAME,
          result: `Error: agent queue full (${MAX_QUEUE} pending) — please retry shortly`,
          error: 'queue_full',
        });
      }
      return { ok: false, error: 'queue_full' };
    }
    messageQueue.push(msg);
    console.log(`[agent:${AGENT_NAME}] Queued message (${messageQueue.length} pending)`);
    return { ok: true, queued: true, depth: messageQueue.length };
  }

  busy = true;
  try {
    let prompt;

    if (msg.type === 'agent_message_deliver') {
      // New address-based envelope (Sprint 2 track C)
      const fromAddress = msg.envelope?.from || 'unknown';
      const text = msg.payload?.message || JSON.stringify(msg.payload);
      prompt = `Message from agent ${fromAddress}:\n${text}`;
    } else if (msg.type === 'app_message') {
      // Legacy short-form (kept for in-flight migrations)
      const fromName = msg.from?.name || msg.from || 'unknown';
      prompt = `Message from agent "${fromName}":\n${msg.payload?.message || JSON.stringify(msg.payload)}`;
    } else if (msg.type === 'user_input') {
      prompt = msg.payload?.instruction || msg.payload?.message || JSON.stringify(msg.payload);
    } else {
      console.log(`[agent:${AGENT_NAME}] Unknown message type: ${msg.type}`);
      return;
    }

    console.log(`[agent:${AGENT_NAME}] Running Claude Code...`);
    const result = await runClaude(prompt);
    console.log(`[agent:${AGENT_NAME}] Done. Result: ${result.slice(0, 200)}...`);

    // Send result back to user via bridge WS (the bridge forwards to router → frontend)
    if (msg.type === 'user_input') {
      await sendToBridge({
        type: 'agent_response',
        agentName: AGENT_NAME,
        result,
      });
    }
  } catch (err) {
    console.error(`[agent:${AGENT_NAME}] Error:`, err.message);
    if (msg.type === 'user_input') {
      await sendToBridge({
        type: 'agent_response',
        agentName: AGENT_NAME,
        result: `Error: ${err.message}`,
      });
    }
  } finally {
    busy = false;

    // Process next queued message
    if (messageQueue.length > 0) {
      const next = messageQueue.shift();
      processMessage(next);
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge communication
// ---------------------------------------------------------------------------

async function sendToBridge(payload) {
  try {
    await fetch(`${BRIDGE_URL}/api/agent-response`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BRIDGE_TOKEN && { 'X-App-Bridge-Token': BRIDGE_TOKEN }),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[agent:${AGENT_NAME}] Failed to send to bridge:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP server — receives messages from bridge
// ---------------------------------------------------------------------------

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BODY) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, {
      ok: true,
      agent: AGENT_NAME,
      persona: PARAMS.persona,
      busy,
      queued: messageQueue.length,
      sessionId,
    });
    return;
  }

  // POST /message — receive app_message or user_input from bridge
  if (req.method === 'POST' && req.url === '/message') {
    try {
      const body = await readBody(req);
      // Fast-path for the overflow case: respond 429 synchronously and
      // DO NOT also kick off processMessage(). Previously we did both,
      // which resulted in a double-signal: the HTTP caller got 429 *and*
      // processMessage re-invoked sendToBridge with a queue_full error
      // bubble, duplicating the failure notification in chat.
      if (busy && messageQueue.length >= MAX_QUEUE) {
        json(res, 429, { ok: false, error: 'queue_full', depth: messageQueue.length, max: MAX_QUEUE });
        return;
      }
      json(res, 200, { ok: true, queued: busy });
      processMessage(body);
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  // POST /reset — clear session (start fresh)
  if (req.method === 'POST' && req.url === '/reset') {
    sessionId = null;
    messageQueue.length = 0;
    // Clearing `busy` is essential: if /reset arrives while a Claude Code
    // session is in flight, the old `busy = true` will survive the reset,
    // the in-flight `finally` drain will see an empty queue and no-op, and
    // every subsequent message will be queued forever. Forcing `busy=false`
    // unblocks the queue immediately. The in-flight `runClaude()` may still
    // complete asynchronously and write to `sessionId`, but `/reset` is an
    // explicit "start over" signal so we accept that — the next processed
    // message will resume the new (or absent) session.
    busy = false;
    json(res, 200, { ok: true, message: 'Session reset' });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.setTimeout(600_000);

server.listen(PORT, '127.0.0.1', () => {
  const actualPort = server.address().port;

  // Write port file so bridge knows where to deliver messages.
  // Filename uses the manifest slug so multiple agent-like apps can coexist.
  fs.writeFileSync(PORT_FILE, String(actualPort));

  console.log(`[agent:${AGENT_NAME}] ready on http://127.0.0.1:${actualPort}`);
  console.log(`[agent:${AGENT_NAME}] persona=${PARAMS.persona} cwd=${CWD}`);
});

server.on('error', err => {
  console.error(`[agent:${AGENT_NAME}] server error:`, err.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — clean up port file
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`[agent:${AGENT_NAME}] ${signal} — shutting down`);
  try { fs.unlinkSync(PORT_FILE); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
