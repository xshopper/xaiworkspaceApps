/**
 * token-market / server.js — regression guards.
 *
 * Source-level checks for the structural fixes that don't have a clean
 * unit-test entry point (server binding + timeout are process-level).
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../apps/token-market/server.js'),
  'utf8'
);

describe('token-market — server.listen binds 127.0.0.1 (not 0.0.0.0)', () => {
  test('server.listen includes the loopback address as second arg', () => {
    // Invariant: every pm2-hosted app in the monorepo binds 127.0.0.1. A
    // default-host listen(PORT) call binds 0.0.0.0 which exposes /models +
    // /listings (both unauthenticated) to every network neighbor.
    expect(SERVER_SRC).toMatch(/server\.listen\(PORT,\s*'127\.0\.0\.1'/);
  });

  test('server.listen does NOT use a single-arg form', () => {
    // Negative guard: `server.listen(PORT, () => {` is the bad pattern.
    expect(SERVER_SRC).not.toMatch(/server\.listen\(PORT,\s*\(\)\s*=>/);
  });
});

describe('token-market — server.setTimeout applied (slow-loris defense)', () => {
  test('source calls server.setTimeout with a finite (non-default) value', () => {
    expect(SERVER_SRC).toMatch(/server\.setTimeout\(\s*\d/);
  });
});
