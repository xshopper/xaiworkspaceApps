/** @type {import('jest').Config} */
//
// Jest here runs unit tests only — fast, no network, no browser. The
// ts-based Puppeteer integration specs under `e2e/` are opt-in via the
// `E2E=1` env var (they are slow and require credentials).
//
// Source of truth:
//   - test/unit/**/*.spec.js — unit tests (Node, no deps on running
//     services). Default test set.
//   - e2e/**/*.spec.ts      — integration tests against a live browser
//     via done24bot WS. Enabled by `E2E=1 npm test`.
const runE2E = !!process.env.E2E;

module.exports = {
  preset: runE2E ? 'ts-jest' : undefined,
  testEnvironment: 'node',
  testMatch: runE2E
    ? ['<rootDir>/e2e/**/*.spec.ts']
    : ['<rootDir>/test/unit/**/*.spec.js'],
  testTimeout: runE2E ? 120_000 : 10_000,
  maxWorkers: 1,
};
