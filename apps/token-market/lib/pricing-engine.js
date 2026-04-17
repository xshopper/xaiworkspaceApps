/**
 * Pricing Engine — executes user-defined JavaScript pricing strategies
 * in V8 isolates via `isolated-vm`.
 *
 * Each strategy receives:
 *   { inputTokens, outputTokens, model, time, feedData }
 * and must return:
 *   { inputPricePerMTok, outputPricePerMTok }
 *
 * Constraints: 100ms CPU, 8MB memory, no I/O, no async.
 */

// ── isolated-vm lazy loader ──────────────────────────────────────────────
//
// We intentionally avoid top-level `await import('isolated-vm')`:
//   - top-level await fails fast in environments that don't support it
//     (older Node, certain bundlers), which would take the whole app down
//     even though every other pricing-engine code path could still log
//     "engine unavailable" gracefully.
//   - a lazy factory lets us distinguish three states cleanly:
//       _ivmCache === undefined → never attempted
//       _ivmCache === null      → attempted and failed (definitively unavailable)
//       _ivmCache === <module>  → loaded successfully
// The `=== null` guard in execute() is the explicit "unavailable" path;
// `=== undefined` triggers the factory on first use.
let _ivmCache; // undefined | null | module

async function loadIvm() {
  if (_ivmCache !== undefined) return _ivmCache;
  try {
    const mod = await import('isolated-vm');
    // Handle default export for ESM
    _ivmCache = mod.default ?? mod;
    if (!_ivmCache || typeof _ivmCache.Isolate !== 'function') {
      console.error('[FATAL] isolated-vm loaded but exports are unexpected — refusing all code execution for safety');
      _ivmCache = null;
    }
  } catch (err) {
    console.error('[FATAL] isolated-vm not available — pricing engine will refuse all code execution for safety:', err?.message || err);
    console.warn('[WARN] isolated-vm is the sole security boundary for user-defined pricing code. Without it, ALL code execution is blocked. Install isolated-vm to enable the pricing engine.');
    _ivmCache = null;
  }
  return _ivmCache;
}

const MAX_EXECUTION_MS = 100;
const MAX_MEMORY_MB = 8;

/** Cache compiled isolates by strategy code hash (simple Map, evict after 100 entries). */
const isolateCache = new Map();
const MAX_CACHE = 100;

function cacheKey(code) {
  // Simple hash — good enough for cache keying
  let h = 0;
  for (let i = 0; i < code.length; i++) {
    h = ((h << 5) - h + code.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export class PricingEngine {
  /**
   * Validate a pricing strategy code string.
   * @returns {{ valid: boolean, error?: string }}
   */
  async validate(code) {
    if (!code || typeof code !== 'string') {
      return { valid: false, error: 'Code must be a non-empty string' };
    }

    // Basic syntax check
    if (code.length > 10000) {
      return { valid: false, error: 'Code exceeds maximum length (10,000 chars)' };
    }

    // Best-effort blocklist — catches common mistakes in user-submitted code.
    // NOTE: These string checks are trivially bypassable and are NOT a security
    // boundary. The sole security boundary is `isolated-vm` (V8 isolate with no
    // I/O, capped CPU, and capped memory). Do not rely on this list for safety.
    const blocked = ['require(', 'import(', 'import ', 'process.', 'global.', 'globalThis', 'eval(', 'Function('];
    for (const pat of blocked) {
      if (code.includes(pat)) {
        return { valid: false, error: `Forbidden pattern: ${pat}` };
      }
    }

    // Try a dry-run execution with sample data
    try {
      const result = await this.execute(code, {
        inputTokens: 1000,
        outputTokens: 500,
        model: 'test-model',
        time: new Date().toISOString(),
        feedData: null,
      });

      if (result.error) return { valid: false, error: result.error };
      if (typeof result.inputPricePerMTok !== 'number' || typeof result.outputPricePerMTok !== 'number') {
        return { valid: false, error: 'Strategy must return { inputPricePerMTok: number, outputPricePerMTok: number }' };
      }
      if (result.inputPricePerMTok < 0 || result.outputPricePerMTok < 0) {
        return { valid: false, error: 'Prices must be non-negative' };
      }

      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Execution error: ${err.message}` };
    }
  }

  /**
   * Execute a pricing strategy.
   * @param {string} code — the JS function body
   * @param {{ inputTokens: number, outputTokens: number, model: string, time: string, feedData: any }} input
   * @returns {{ inputPricePerMTok: number, outputPricePerMTok: number, error?: string, executionMs?: number }}
   */
  async execute(code, input) {
    const start = performance.now();

    const ivm = await loadIvm();
    // `null` specifically means "attempted load, unavailable" — the guard
    // path under test. `undefined` should never reach this point because
    // loadIvm() always resolves to module-or-null.
    if (ivm === null) {
      return { inputPricePerMTok: 0, outputPricePerMTok: 0, error: 'Pricing engine unavailable: isolated-vm not installed' };
    }
    return this._executeIsolated(ivm, code, input, start);
  }

  /** Execute in an isolated-vm V8 isolate (production). */
  async _executeIsolated(ivm, code, input, start) {
    const key = cacheKey(code);
    let isolate;

    if (isolateCache.has(key)) {
      isolate = isolateCache.get(key);
    } else {
      isolate = new ivm.Isolate({ memoryLimit: MAX_MEMORY_MB });
      // Evict oldest if cache full
      if (isolateCache.size >= MAX_CACHE) {
        const oldest = isolateCache.keys().next().value;
        const old = isolateCache.get(oldest);
        isolateCache.delete(oldest);
        try { old.dispose(); } catch { /* already disposed */ }
      }
      isolateCache.set(key, isolate);
    }

    let context;
    try {
      context = await isolate.createContext();
      const jail = context.global;

      // Inject input data as a frozen global
      await jail.set('__input', new ivm.ExternalCopy(input).copyInto());

      // Wrap user code in a function that receives __input and returns pricing
      const wrappedCode = `
        (function() {
          const input = __input;
          const priceFn = (function() { ${code} });
          const result = priceFn(input);
          if (!result || typeof result !== 'object') {
            throw new Error('Strategy must return an object');
          }
          return JSON.stringify(result);
        })()
      `;

      const script = await isolate.compileScript(wrappedCode);
      const resultStr = await script.run(context, { timeout: MAX_EXECUTION_MS });
      const result = JSON.parse(resultStr);
      const executionMs = Math.round(performance.now() - start);

      return {
        inputPricePerMTok: result.inputPricePerMTok ?? 0,
        outputPricePerMTok: result.outputPricePerMTok ?? 0,
        executionMs,
      };
    } catch (err) {
      // Remove errored isolate from cache and dispose to prevent DoS on co-cached strategies
      isolateCache.delete(key);
      try { isolate.dispose(); } catch { /* ignore */ }

      return {
        inputPricePerMTok: 0,
        outputPricePerMTok: 0,
        error: err.message,
        executionMs: Math.round(performance.now() - start),
      };
    } finally {
      if (context) try { context.release(); } catch { /* already released or disposed */ }
    }
  }

  /** Dispose all cached isolates. */
  dispose() {
    for (const iso of isolateCache.values()) {
      try { iso.dispose(); } catch { /* ignore */ }
    }
    isolateCache.clear();
  }
}
