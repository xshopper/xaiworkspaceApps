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
import { query } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGENT_NAME = process.env.APP_INSTANCE_NAME || 'default';
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
const CWD = process.env.AGENT_CWD || process.env.HOME || '/root';

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

  return `${base}

## Inter-Agent Messaging

You can send messages to other agents by running this command:
curl -s -X POST ${BRIDGE_URL}/api/app-message \\
  -H 'Content-Type: application/json' \\
  -d '{"from":"${AGENT_NAME}","to":"TARGET_AGENT_NAME","message":"YOUR_MESSAGE"}'

Replace TARGET_AGENT_NAME with the agent's instance name (e.g. "pm-01", "dev-01").
Messages are freetext — write naturally.`;
}

// ---------------------------------------------------------------------------
// Claude Code session management
// ---------------------------------------------------------------------------

let sessionId = null;
let busy = false;
const messageQueue = [];

async function runClaude(prompt) {
  const options = {
    cwd: CWD,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
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

async function processMessage(msg) {
  if (busy) {
    if (messageQueue.length >= 100) {
      console.warn(`[agent:${AGENT_NAME}] Queue full (100), dropping message`);
      return;
    }
    messageQueue.push(msg);
    console.log(`[agent:${AGENT_NAME}] Queued message (${messageQueue.length} pending)`);
    return;
  }

  busy = true;
  try {
    let prompt;

    if (msg.type === 'app_message') {
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
      headers: { 'Content-Type': 'application/json' },
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
    json(res, 200, { ok: true, message: 'Session reset' });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.setTimeout(600_000);

server.listen(PORT, '127.0.0.1', () => {
  const actualPort = server.address().port;

  // Write port file so bridge knows where to deliver messages
  fs.writeFileSync(`/tmp/agent-${AGENT_NAME}.port`, String(actualPort));

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
  try { fs.unlinkSync(`/tmp/agent-${AGENT_NAME}.port`); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
