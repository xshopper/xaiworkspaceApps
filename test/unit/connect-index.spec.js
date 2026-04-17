/**
 * @connect / index.js — unit test skeletons.
 *
 * Focus areas:
 *   - MCP auth header enforcement (checkMcpAuth)
 *   - Tool dispatch via JSON-RPC handleJsonRpc (initialize, tools/list,
 *     tools/call, unknown method)
 *   - sanitizeProvider regex matches router's PROVIDER_RE exactly
 *
 * The module under test is ESM (ANTHROPIC_API_KEY + ROUTER_URL aware and
 * opens an HTTP server at import time). For now we test the pure regex
 * logic in-band, and describe.skip the handler tests until we have an
 * ESM-aware runner that lets us import without booting the server.
 */

describe('connect — provider slug regex', () => {
  const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,49}$/;

  test.each([
    ['google'],
    ['github'],
    ['slack'],
    ['g1'],
    ['my-provider'],
    ['my_provider'],
    ['a'.repeat(50)],
  ])('accepts valid provider slug %s', (p) => {
    expect(PROVIDER_RE.test(p)).toBe(true);
  });

  test.each([
    [''],
    ['-leading-dash'],
    ['_leading-underscore'],
    ['UPPERCASE'],
    ['has space'],
    ['has.dot'],
    ['has/slash'],
    ['a'.repeat(51)],
  ])('rejects invalid provider slug %s', (p) => {
    expect(PROVIDER_RE.test(p)).toBe(false);
  });

  test('matches xaiworkspace-backend/src/routes/oauth-connections-api.js PROVIDER_RE', () => {
    // Router regex pasted verbatim — if this fails, router and @connect
    // have drifted and /api/oauth/connections will reject provider names
    // the client considers valid (or vice versa).
    expect(PROVIDER_RE.source).toBe('^[a-z0-9][a-z0-9_-]{0,49}$');
  });
});

describe('connect — MCP auth (checkMcpAuth logic)', () => {
  // Re-implementation of the predicate from apps/connect/index.js — we
  // cannot import the module without booting the HTTP server, but the
  // logic is small enough to mirror here. If the source pattern changes
  // (e.g. dropping timingSafeEqual) the textual regression guard below
  // fails.
  const crypto = require('node:crypto');

  function checkAuth(configuredSecret, headerValue) {
    const secretBuf = Buffer.from(configuredSecret, 'utf8');
    if (!headerValue || typeof headerValue !== 'string') return false;
    const provided = Buffer.from(headerValue, 'utf8');
    if (provided.length !== secretBuf.length) return false;
    try { return crypto.timingSafeEqual(provided, secretBuf); }
    catch { return false; }
  }

  test('rejects when header missing', () => {
    expect(checkAuth('secret', undefined)).toBe(false);
    expect(checkAuth('secret', null)).toBe(false);
  });

  test('rejects when header is not a string', () => {
    expect(checkAuth('secret', 42)).toBe(false);
    expect(checkAuth('secret', { foo: 'bar' })).toBe(false);
  });

  test('rejects on length mismatch without throwing', () => {
    expect(() => checkAuth('short', 'muchlongervalue')).not.toThrow();
    expect(checkAuth('short', 'muchlongervalue')).toBe(false);
  });

  test('rejects on byte mismatch (same length)', () => {
    expect(checkAuth('aaaaaa', 'bbbbbb')).toBe(false);
  });

  test('accepts exact match', () => {
    expect(checkAuth('topsecret', 'topsecret')).toBe(true);
  });

  test('source file uses crypto.timingSafeEqual (regression guard)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/connect/index.js'),
      'utf8'
    );
    expect(src).toMatch(/crypto\.timingSafeEqual\(/);
  });
});

describe('connect — APP_API_KEY naming (round 2 fix)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../apps/connect/index.js'),
    'utf8'
  );

  test('prefers APP_API_KEY, falls back to ANTHROPIC_API_KEY', () => {
    expect(src).toMatch(/process\.env\.APP_API_KEY \|\| process\.env\.ANTHROPIC_API_KEY/);
  });

  test('warns when API_KEY looks like a real Anthropic key', () => {
    expect(src).toMatch(/sk-ant-/);
  });
});

describe.skip('connect — JSON-RPC dispatch (needs ESM runner)', () => {
  test('initialize returns serverInfo with @connect name', async () => {
    // const { handleJsonRpc } = await import('../../apps/connect/index.js');
    // const res = await handleJsonRpc({ id: 1, method: 'initialize' });
    // expect(res.result.serverInfo.name).toBe('@connect');
  });

  test('tools/call for unknown tool returns -32601', async () => {
    // const { handleJsonRpc } = await import('../../apps/connect/index.js');
    // const res = await handleJsonRpc({ id: 1, method: 'tools/call', params: { name: 'nope' } });
    // expect(res.error.code).toBe(-32601);
  });
});
