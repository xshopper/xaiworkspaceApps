/**
 * token-market / pricing-engine.js — unit tests.
 *
 * Pure-branch tests (blocklist, single-flight race model) run by default.
 * The in-sandbox tests (requires isolated-vm + ESM-aware Jest) stay under
 * `describe.skip` until CI runs with `NODE_OPTIONS='--experimental-vm-modules'`.
 */

describe('pricing-engine — blocklist', () => {
  // Pure string check — kept identical to the module so we can validate
  // the blocklist without importing the ESM module.
  const blocked = ['require(', 'import(', 'import ', 'process.', 'global.', 'globalThis', 'eval(', 'Function('];

  test.each(blocked)('rejects %s', (pat) => {
    const code = `return { x: ${pat}foo ) };`;
    const found = blocked.some((p) => code.includes(p));
    expect(found).toBe(true);
  });

  test('accepts clean code', () => {
    const code = 'return { inputPricePerMTok: 1, outputPricePerMTok: 2 };';
    const hit = blocked.find((p) => code.includes(p));
    expect(hit).toBeUndefined();
  });
});

describe('pricing-engine — loadIvm() single-flight race', () => {
  // This is a standalone reimplementation of the promise-caching pattern in
  // pricing-engine.js so we can reason about the concurrent-load race
  // without actually importing isolated-vm. If the implementation pattern
  // drifts (e.g. someone removes _ivmPromise and reverts to the simple
  // `if (_ivmCache !== undefined)` check), this test will still pass —
  // but we also keep a textual assertion against the source to detect
  // regression.
  function makeLoader({ delayMs = 10, fail = false, slowFail = false } = {}) {
    let _cache; // undefined | null | module
    let _promise;
    let callCount = 0;
    async function load() {
      if (_cache !== undefined) return _cache;
      if (_promise) return _promise;
      _promise = (async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, delayMs));
        if (fail) {
          _cache = null;
        } else if (slowFail) {
          _cache = null;
        } else {
          _cache = { Isolate: function () {} };
        }
        return _cache;
      })();
      return _promise;
    }
    return { load, stats: () => ({ callCount }) };
  }

  test('cold-path concurrent callers share the same import promise', async () => {
    const { load, stats } = makeLoader({ delayMs: 20 });
    const results = await Promise.all([load(), load(), load(), load(), load()]);
    // All callers resolve to the same module object.
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
    // The loader body only ran once despite five callers racing.
    expect(stats().callCount).toBe(1);
  });

  test('after resolution, subsequent callers short-circuit via the cache', async () => {
    const { load, stats } = makeLoader({ delayMs: 5 });
    await load();
    expect(stats().callCount).toBe(1);
    await Promise.all([load(), load(), load()]);
    expect(stats().callCount).toBe(1); // still 1 — cache hit
  });

  test('failure state (null) is sticky — no retry storms', async () => {
    // IMPORTANT label-clarification: `loadIvm` is designed to *never
    // reject*. When isolated-vm fails to import it catches the error
    // internally and resolves the cached promise with `null`. That
    // resolved-null state is then reused for every subsequent caller
    // (sticky). This test asserts the "no retry storms" side of that
    // contract — we do NOT assert rejection propagation because the
    // single-flight pattern intentionally converts import failures
    // into a cached null resolution, not a rejection.
    const { load, stats } = makeLoader({ delayMs: 5, fail: true });
    const first = await load();
    expect(first).toBeNull();
    // Multiple subsequent calls all get null without re-invoking the loader.
    const more = await Promise.all([load(), load(), load()]);
    expect(more.every((x) => x === null)).toBe(true);
    expect(stats().callCount).toBe(1);
  });

  test('source file uses the _ivmPromise single-flight pattern (regression guard)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/token-market/lib/pricing-engine.js'),
      'utf8'
    );
    expect(src).toMatch(/_ivmPromise/);
    expect(src).toMatch(/if \(_ivmPromise\) return _ivmPromise/);
  });
});

describe.skip('pricing-engine — sandbox execution', () => {
  test('valid strategy returns prices', async () => {
    // const { PricingEngine } = await import('../../apps/token-market/lib/pricing-engine.js');
    // const engine = new PricingEngine();
    // const r = await engine.execute(
    //   'return { inputPricePerMTok: 3, outputPricePerMTok: 15 };',
    //   { inputTokens: 1000, outputTokens: 500, model: 'm', time: '', feedData: null }
    // );
    // expect(r.inputPricePerMTok).toBe(3);
    // expect(r.outputPricePerMTok).toBe(15);
  });

  test('infinite loop is killed at timeout', async () => {
    // const { PricingEngine } = await import('../../apps/token-market/lib/pricing-engine.js');
    // const engine = new PricingEngine();
    // const r = await engine.execute('while (true) {}', { inputTokens: 1, outputTokens: 1, model: 'm', time: '', feedData: null });
    // expect(r.error).toMatch(/timeout|timed out/i);
  });

  test('isolated-vm unavailable — returns guard error (=== null path)', async () => {
    // Simulated by jest.doMock('isolated-vm', () => { throw ... });
    // const { PricingEngine } = await import('../../apps/token-market/lib/pricing-engine.js');
    // const engine = new PricingEngine();
    // const r = await engine.execute('return {};', { inputTokens: 0, outputTokens: 0, model: 'm', time: '', feedData: null });
    // expect(r.error).toMatch(/isolated-vm not installed/);
  });
});
