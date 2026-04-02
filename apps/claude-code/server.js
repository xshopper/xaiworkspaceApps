/**
 * Claude Code mini-app server
 *
 * HTTP server that runs Claude Code sessions via @anthropic-ai/claude-agent-sdk.
 * Claude Code gets full access to the workspace container: Read, Write, Edit,
 * Bash, Glob, Grep — the same tools as the CLI.
 *
 * Requires: ANTHROPIC_API_KEY env var
 */

import http from 'node:http';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const PORT = parseInt(process.env.APP_PORT ?? '3457', 10);
const CWD = process.env.CLAUDE_CODE_CWD ?? process.env.HOME ?? '/root';

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[claude-code] WARNING: ANTHROPIC_API_KEY is not set.');
}

/** Active query handles by sessionId — used for cancellation */
const activeQueries = new Map();

// ---------------------------------------------------------------------------
// Run a Claude Code query
// ---------------------------------------------------------------------------

let queryCounter = 0;

async function runQuery(prompt, sessionId, cwd) {
  const outputParts = [];
  let resolvedSessionId = sessionId;
  let stopReason = null;

  // Use a unique temp key so concurrent new-session queries don't clobber each other
  const tempKey = `pending-${++queryCounter}`;
  const queryKey = resolvedSessionId ?? tempKey;

  const controller = new AbortController();
  activeQueries.set(queryKey, controller);

  const options = {
    cwd: cwd || CWD,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 50,
    abortController: controller,
  };

  // Resume sends the prompt as a continuation of the existing session
  if (sessionId) {
    options.resume = sessionId;
  }

  try {
    // When resuming, prompt is the new user message within the session
    for await (const message of query({ prompt, options })) {
      // Capture session ID from init
      if (message.type === 'system' && message.subtype === 'init') {
        resolvedSessionId = message.session_id;
        // Re-key the controller with the real session ID
        activeQueries.delete(queryKey);
        activeQueries.set(resolvedSessionId, controller);
      }

      // Collect final result — the SDK's result already summarizes the full work
      // (intermediate assistant messages would duplicate content in the result)
      if (message.type === 'result' && message.subtype === 'success') {
        outputParts.push(message.result);
        stopReason = message.stop_reason ?? 'end_turn';
      } else if (message.type === 'result') {
        // Error result — has errors[] instead of result
        const errText = message.errors?.join(', ') ?? message.subtype ?? 'unknown error';
        outputParts.push(`Error: ${errText}`);
        stopReason = message.stop_reason ?? 'end_turn';
      }
    }
  } finally {
    activeQueries.delete(resolvedSessionId ?? queryKey);
  }

  return {
    output: outputParts.join('\n\n') || '(no output)',
    sessionId: resolvedSessionId,
    stopReason,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MAX_BODY = 1024 * 1024; // 1 MB

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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // -----------------------------------------------------------------------
  // GET /health
  // -----------------------------------------------------------------------
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, {
      ok: true,
      port: PORT,
      cwd: CWD,
      activeQueries: activeQueries.size,
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    });
    return;
  }

  // -----------------------------------------------------------------------
  // GET /sessions — list past Claude Code sessions
  // -----------------------------------------------------------------------
  if (req.method === 'GET' && req.url === '/sessions') {
    try {
      const sessions = await listSessions({ limit: 20 });
      json(res, 200, {
        ok: true,
        sessions: sessions.map(s => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          summary: s.summary,
          tag: s.tag,
        })),
      });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // -----------------------------------------------------------------------
  // POST endpoints
  // -----------------------------------------------------------------------
  if (req.method === 'POST') {
    const body = await readBody(req);

    // POST /query — run a Claude Code prompt
    if (req.url === '/query') {
      const { prompt, sessionId, cwd } = body;
      if (!prompt?.trim()) {
        json(res, 400, { ok: false, error: 'prompt is required' });
        return;
      }
      // Reject if a query is already running for this session
      if (sessionId && activeQueries.has(sessionId)) {
        json(res, 409, { ok: false, error: 'A query is already running for this session' });
        return;
      }
      try {
        const result = await runQuery(prompt.trim(), sessionId, cwd);
        json(res, 200, { ok: true, ...result });
      } catch (err) {
        console.error('[claude-code] query error:', err.message);
        json(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    // POST /stop — cancel an active query
    if (req.url === '/stop') {
      const { sessionId } = body;
      const controller = activeQueries.get(sessionId);
      if (controller) {
        controller.abort();
        activeQueries.delete(sessionId);
        json(res, 200, { ok: true, message: 'Query cancelled' });
      } else {
        json(res, 200, { ok: true, message: 'No active query for this session' });
      }
      return;
    }

    // POST /session-messages — get messages from a past session
    if (req.url === '/session-messages') {
      const { sessionId, limit } = body;
      if (!sessionId) {
        json(res, 400, { ok: false, error: 'sessionId is required' });
        return;
      }
      try {
        const messages = await getSessionMessages(sessionId, { limit: limit ?? 50 });
        json(res, 200, { ok: true, messages });
      } catch (err) {
        json(res, 500, { ok: false, error: err.message });
      }
      return;
    }
  }

  res.writeHead(404);
  res.end();
});

// Allow long-running queries (10 min) before HTTP timeout
server.setTimeout(600_000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[claude-code] ready on http://127.0.0.1:${PORT}`);
  console.log(`[claude-code] working directory: ${CWD}`);
});

server.on('error', err => {
  console.error('[claude-code] server error:', err.message);
  process.exit(1);
});
