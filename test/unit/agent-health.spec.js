/**
 * apps/agent/index.js — /health response shape regression guards.
 *
 * /health is intentionally unauthenticated so the workspace-agent bridge
 * can probe agent liveness. That means whatever the handler returns leaks
 * to every co-located process. Historically we returned `sessionId:
 * this.sessionId` — the claude-agent-sdk session ID, which is enough to
 * resume or inspect the agent's in-progress conversation from another
 * process on the same worker.
 *
 * Invariant: /health MUST NOT expose `sessionId:` on the response body.
 * A boolean `hasSession` is the public-safe alternative.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../apps/agent/index.js'),
  'utf8'
);

// Isolate the /health response handler block so we don't false-positive on
// e.g. a `sessionId:` key inside /message (which is auth-gated and fine).
// Cut at the first `return;` after the marker — that's the end of the
// /health branch in the current handler shape.
function extractHealthHandler(src) {
  const marker = "req.url === '/health'";
  const idx = src.indexOf(marker);
  if (idx === -1) return '';
  const tail = src.slice(idx);
  const endIdx = tail.indexOf('return;');
  return endIdx === -1 ? tail.slice(0, 600) : tail.slice(0, endIdx);
}

describe('agent /health — no sessionId leakage', () => {
  const block = extractHealthHandler(SRC);

  test('source reaches the /health handler', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  test('/health response object does NOT contain `sessionId:` key', () => {
    // Disallow the shorthand-property leak (`sessionId,` at end of line,
    // mirroring the original bug) and the explicit-key leak
    // (`sessionId: <expr>`). We do NOT disallow `!!sessionId` — that's the
    // boolean-coerce used by hasSession, which is the correct fix.
    expect(block).not.toMatch(/^\s*sessionId\s*,\s*$/m);
    expect(block).not.toMatch(/^\s*sessionId\s*:/m);
  });

  test('/health exposes a boolean `hasSession` instead', () => {
    expect(block).toMatch(/hasSession:\s*!!\s*sessionId/);
  });
});
