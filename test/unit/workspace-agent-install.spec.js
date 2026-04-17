/**
 * workspace-agent / bridge.js — install-path regression tests.
 *
 * Full bridge.js cannot be imported in a unit test (it opens a WS
 * connection to the router on module load). These tests instead:
 *   1. Static-check the source for the mandatory sha256 + no-op install
 *      rejection paths.
 *   2. Unit-test the allowlist + regex predicates themselves.
 *
 * If anyone removes the sha256 guard or the no-op rejection, these tests
 * should fail loudly.
 */

const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../apps/workspace-agent/bridge.js'),
  'utf8'
);

describe('workspace-agent install — sha256 mandatory check', () => {
  test('source enforces /^[a-f0-9]{64}$/i on msg.sha256', () => {
    // The exact predicate shape is the contract: any deviation (e.g.
    // allowing shorter hex, relaxing to optional) must be caught here.
    expect(BRIDGE_SRC).toMatch(/\/\^\[a-f0-9\]\{64\}\$\/i\.test\(msg\.sha256\)/);
  });

  test('source rejects with a user-visible error message on missing sha256', () => {
    expect(BRIDGE_SRC).toMatch(/Missing or invalid sha256 digest/);
  });

  test('source crypto-verifies sha256 after download', () => {
    expect(BRIDGE_SRC).toMatch(/createHash\('sha256'\)/);
    expect(BRIDGE_SRC).toMatch(/Artifact integrity check failed/);
  });
});

describe('workspace-agent install — no-op install rejection', () => {
  test('source rejects when neither artifactUrl nor sourceUrl provided', () => {
    expect(BRIDGE_SRC).toMatch(/Install source missing: neither artifactUrl nor sourceUrl was provided/);
  });
});

describe('workspace-agent install — GitHub tree URL branch pinning', () => {
  test('source passes --branch for tree/<ref>/ URLs', () => {
    // The tree-URL clone must pass the captured branch/ref via --branch so
    // we don't silently clone the repo default.
    expect(BRIDGE_SRC).toMatch(/clone',[^)]*'--branch', branchOrRef/);
  });

  test('source warns on mutable refs (non-40-char-sha)', () => {
    expect(BRIDGE_SRC).toMatch(/pin a 40-char commit SHA for integrity/);
  });
});

describe('workspace-agent install — URL allowlist semantics', () => {
  // Re-implementation of isUrlTrusted() so we can exercise it in isolation.
  const TRUSTED = new Set([
    'github.com',
    'api.github.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
    'registry.npmjs.org',
    'xaiworkspace.com',
    'router.xaiworkspace.com',
    'apps.xaiworkspace.com',
  ]);
  const SUFFIX = new Set(['xaiworkspace.com']);

  function isTrusted(u) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:') return false;
      if (TRUSTED.has(parsed.hostname)) return true;
      for (const d of SUFFIX) {
        if (parsed.hostname === d || parsed.hostname.endsWith('.' + d)) return true;
      }
      return false;
    } catch { return false; }
  }

  test.each([
    ['https://github.com/user/repo/archive/main.zip', true],
    ['https://api.github.com/repos/user/repo/tarball/main', true],
    ['https://apps.xaiworkspace.com/com.xshopper.agent-0.1.0.zip', true],
    ['https://cdn.xaiworkspace.com/foo', true],   // suffix match on xaiworkspace.com
    ['https://test-apps.xaiworkspace.com/x.zip', true],
    ['https://objects.githubusercontent.com/x', true],
  ])('accepts trusted URL %s', (u, _) => {
    expect(isTrusted(u)).toBe(true);
  });

  test.each([
    ['http://github.com/x'],                      // http scheme
    ['https://evil.github.io/x'],                 // github.io not in allowlist
    ['https://pages.github.com/x'],               // subdomain match not enabled
    ['https://xaiworkspace.com.evil.com/x'],      // suffix hijack attempt
    ['ftp://github.com/x'],
    ['not-a-url'],
  ])('rejects untrusted URL %s', (u) => {
    expect(isTrusted(u)).toBe(false);
  });

  test('codeload.github.com is NOT in allowlist (round 2 fix)', () => {
    expect(isTrusted('https://codeload.github.com/user/repo/zip/main')).toBe(false);
  });
});

describe('workspace-agent install — ghSubdir sanitization (regex + path-resolve defense)', () => {
  // The regex alone is permissive (`..` passes) — it's the path.resolve +
  // startsWith() check after it that actually blocks traversal. Model
  // that combined check here.
  const path = require('node:path');
  const SUBDIR_RE = /^[a-zA-Z0-9._/-]+$/;
  function isSafeSubdir(root, subdir) {
    if (!SUBDIR_RE.test(subdir)) return false;
    const resolved = path.resolve(root, subdir);
    return resolved.startsWith(path.resolve(root) + path.sep);
  }

  test.each([
    ['apps/agent'],
    ['apps/com.xshopper.agent'],
    ['a/b/c'],
  ])('accepts safe subdir %s (passes regex)', (s) => {
    expect(SUBDIR_RE.test(s)).toBe(true);
  });

  test.each([
    ['apps/$(rm -rf /)'],
    ['apps/`evil`'],
    ['apps/;evil'],
    ['apps/*'],
    ['apps/\u0000injection'],
  ])('rejects unsafe subdir via regex %s', (s) => {
    expect(SUBDIR_RE.test(s)).toBe(false);
  });

  test('path traversal ("../etc") is blocked by the resolve + startsWith check', () => {
    expect(isSafeSubdir('/tmp/extract', '../etc')).toBe(false);
    expect(isSafeSubdir('/tmp/extract', 'foo/../../etc')).toBe(false);
  });

  test('in-root paths resolve under root', () => {
    expect(isSafeSubdir('/tmp/extract', 'apps/agent')).toBe(true);
    expect(isSafeSubdir('/tmp/extract', 'a/b/c')).toBe(true);
  });

  test('source uses the two-layer check (regex + resolve containment)', () => {
    expect(BRIDGE_SRC).toMatch(/Subdir escapes extract root/);
  });
});

describe('workspace-agent install — GitHub tree URL percent-decode error surfacing', () => {
  // The bridge percent-decodes the captured `branch` and `subdir` groups
  // out of a GitHub tree URL (to tolerate `%2F` in branch names). If the
  // URL contains a malformed escape (lone `%`, `%GG`, truncated `%A`)
  // decodeURIComponent throws URIError. Without a try/catch that bubbles
  // up as an unhandled rejection and fails the install opaquely. The
  // round-2 fix wraps both calls and throws a typed 'Invalid
  // percent-encoding in source URL' error the user can actually read.
  test('source wraps decodeURIComponent in try/catch with user-visible error', () => {
    expect(BRIDGE_SRC).toMatch(/branchOrRef = decodeURIComponent\(ghMatch\[2\]\);/);
    expect(BRIDGE_SRC).toMatch(/ghSubdir = decodeURIComponent\(ghMatch\[3\]\);/);
    expect(BRIDGE_SRC).toMatch(/Invalid percent-encoding in source URL/);
  });

  // Re-implementation to exercise the decode+error path end-to-end.
  function safeDecodeBranchAndSubdir(rawBranch, rawSubdir) {
    try {
      return { branch: decodeURIComponent(rawBranch), subdir: decodeURIComponent(rawSubdir) };
    } catch {
      throw new Error('Invalid percent-encoding in source URL');
    }
  }

  test.each([
    ['lone %', '%', 'apps/agent'],
    ['%GG invalid hex', '%GG', 'apps/agent'],
    ['truncated %A', '%A', 'apps/agent'],
    ['malformed subdir', 'main', 'apps/%ZZ/evil'],
  ])('rejects %s', (_desc, branch, subdir) => {
    expect(() => safeDecodeBranchAndSubdir(branch, subdir))
      .toThrow(/Invalid percent-encoding in source URL/);
  });

  test('accepts well-formed percent-encoding (feature%2Fbar)', () => {
    const out = safeDecodeBranchAndSubdir('feature%2Fbar', 'apps/agent');
    expect(out.branch).toBe('feature/bar');
    expect(out.subdir).toBe('apps/agent');
  });
});
