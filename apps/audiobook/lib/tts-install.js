/**
 * Lazy installer for TTS runtime dependencies.
 *
 * Runs once on the first /generate call per bridge worker and caches its
 * success marker under $APP_DATA_DIR/.tts-installed. Subsequent calls are
 * no-ops. Every step streams a progress line so the caller can forward
 * status to chat via the bridge.
 *
 * What we install:
 *   - System binaries (python3, ffmpeg) — presence-check only; if missing we
 *     fail fast with an actionable error. Installing system packages requires
 *     root which the mini-app sandbox cannot assume.
 *   - Python packages from tts/requirements.txt via
 *     `pip install --user --quiet -r <requirements>` so they land in the
 *     worker's user site without touching the image.
 *   - Kokoro model assets (kokoro-v0_19.onnx, voices.bin) downloaded from
 *     Hugging Face to $APP_DATA_DIR/kokoro/. Paths exported via env vars that
 *     tts_worker.py reads. When a SHA-256 is pinned below, the download is
 *     re-verified on disk; otherwise the min-size check is the only guard.
 *
 * Idempotency: each step detects existing artefacts and skips. A partial
 * install is safe to resume — file-size checks invalidate truncated downloads.
 *
 * Environment:
 *   AUDIOBOOK_STRICT_VERIFY=true
 *     If set, install fails hard when MODEL_SHA256 or VOICES_SHA256 is null.
 *     Prod/test deploys MUST set this so an MITM on huggingface.co can't
 *     swap the onnx blob for an RCE payload. Dev leaves it unset until the
 *     hashes are pinned after first successful deploy.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';

const DATA_DIR = process.env.APP_DATA_DIR || path.resolve('./data');
const MARKER = path.join(DATA_DIR, '.tts-installed');
const KOKORO_DIR = path.join(DATA_DIR, 'kokoro');
const MODEL_PATH = path.join(KOKORO_DIR, 'kokoro-v0_19.onnx');
const VOICES_PATH = path.join(KOKORO_DIR, 'voices.bin');

const MODEL_URL = 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v0_19.onnx';
const VOICES_URL = 'https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices.bin';
// Expected minimum sizes guard against HTML error pages being saved as the
// model. Actual sizes: model ~320 MB, voices ~24 MB (as of Kokoro v0.19).
const MIN_MODEL_BYTES = 200 * 1024 * 1024;
const MIN_VOICES_BYTES = 10 * 1024 * 1024;

// TODO: Pin actual SHA-256 hashes after first successful deploy by inspecting
// the downloaded files with `sha256sum $APP_DATA_DIR/kokoro/*`. When set to a
// hex string the download is verified; when null only the min-byte guard
// applies. Leaving null for now because we can't fetch HuggingFace from the
// build sandbox to compute the canonical digest.
const MODEL_SHA256 = null;
const VOICES_SHA256 = null;

const REQUIREMENTS_PATH = new URL('../tts/requirements.txt', import.meta.url).pathname;

let runningPromise = null;

export function ttsPaths() {
  return { modelPath: MODEL_PATH, voicesPath: VOICES_PATH };
}

/**
 * Bug 5: exposed so server.js can distinguish "not installed / installing /
 * ready" and return 202 immediately instead of blocking /generate behind a
 * 30s+ pip + 320 MB download (sandbox-proxy has a 15s timeout).
 */
export async function isInstalled() {
  try {
    await fs.access(MARKER);
    const [model, voices] = await Promise.all([fs.stat(MODEL_PATH), fs.stat(VOICES_PATH)]);
    if (model.size < MIN_MODEL_BYTES || voices.size < MIN_VOICES_BYTES) return false;
    return true;
  } catch {
    return false;
  }
}

export function isInstalling() {
  return runningPromise != null;
}

export async function ensureTtsReady(onProgress = () => {}) {
  if (await isInstalled()) return ttsPaths();
  // Coalesce concurrent generate calls so a single install runs.
  if (runningPromise) return runningPromise;
  runningPromise = doInstall(onProgress).finally(() => {
    runningPromise = null;
  });
  return runningPromise;
}

async function doInstall(onProgress) {
  // Bug 2: STRICT_VERIFY guard. Without pinned SHA-256s the Kokoro download
  // trusts huggingface.co + TLS alone; a compromised registry or MITM could
  // swap the onnx blob for an RCE payload that python loads into the worker.
  // Prod/test deploys set AUDIOBOOK_STRICT_VERIFY=true so this path is
  // refused until the hashes are computed from a known-good first deploy.
  if (process.env.AUDIOBOOK_STRICT_VERIFY === 'true' && (MODEL_SHA256 === null || VOICES_SHA256 === null)) {
    throw new Error(
      'AUDIOBOOK_STRICT_VERIFY=true but Kokoro SHA-256 pins are null. '
      + 'Run a trusted install once, compute `sha256sum $APP_DATA_DIR/kokoro/*`, '
      + 'and set MODEL_SHA256 / VOICES_SHA256 in lib/tts-install.js before deploying.',
    );
  }
  await fs.mkdir(KOKORO_DIR, { recursive: true });

  onProgress({ step: 'python', status: 'checking', message: 'Checking python3 availability…' });
  await requireBinary('python3', '--version');
  onProgress({ step: 'python', status: 'ok' });

  onProgress({ step: 'ffmpeg', status: 'checking', message: 'Checking ffmpeg availability…' });
  await requireBinary('ffmpeg', '-version');
  onProgress({ step: 'ffmpeg', status: 'ok' });

  onProgress({ step: 'pip', status: 'installing', message: 'Installing Kokoro Python dependencies (first run ~30s)…' });
  await pipInstall(onProgress);
  onProgress({ step: 'pip', status: 'ok' });

  onProgress({ step: 'model', status: 'downloading', message: 'Downloading Kokoro model (~320 MB)…' });
  await downloadIfMissing(MODEL_URL, MODEL_PATH, MIN_MODEL_BYTES, MODEL_SHA256, onProgress, 'model');
  onProgress({ step: 'model', status: 'ok' });

  onProgress({ step: 'voices', status: 'downloading', message: 'Downloading Kokoro voices (~24 MB)…' });
  await downloadIfMissing(VOICES_URL, VOICES_PATH, MIN_VOICES_BYTES, VOICES_SHA256, onProgress, 'voices');
  onProgress({ step: 'voices', status: 'ok' });

  await fs.writeFile(MARKER, JSON.stringify({ installedAt: new Date().toISOString() }));
  onProgress({ step: 'done', status: 'ok', message: 'TTS ready.' });
  return ttsPaths();
}

function requireBinary(cmd, versionArg) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [versionArg], { stdio: 'ignore' });
    child.on('error', () =>
      reject(new Error(`${cmd} not found on PATH. Install it on the bridge worker and retry.`)),
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
  });
}

function pipInstall(onProgress) {
  return new Promise((resolve, reject) => {
    // Use `-r requirements.txt` so the source of truth for versions is the
    // checked-in file, not a JS array. requirements.txt pins exact versions
    // (avoiding the pip range-resolver surprise when e.g. onnxruntime 1.18
    // tightens its ABI).
    const args = [
      '-m', 'pip', 'install',
      '--user', '--quiet', '--disable-pip-version-check',
      '-r', REQUIREMENTS_PATH,
    ];
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (d) => onProgress({ step: 'pip', status: 'log', message: d.toString().trim() }));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      // Bumped slice from 500 → 2000: pip's "could not find compatible version"
      // errors from the resolver often blow past 500 chars and get truncated.
      else reject(new Error(`pip install failed (${code}): ${stderr.trim().slice(-2000)}`));
    });
  });
}

async function downloadIfMissing(url, outPath, minBytes, expectedSha256, onProgress, step) {
  try {
    const stat = await fs.stat(outPath);
    if (stat.size >= minBytes) {
      // If a hash is pinned, re-verify the on-disk file before skipping.
      if (expectedSha256) {
        const have = await hashFile(outPath);
        if (have === expectedSha256) return;
        // Mismatched — treat as corrupt and re-download.
        await fs.unlink(outPath);
      } else {
        return;
      }
    } else {
      await fs.unlink(outPath);
    }
  } catch {
    // not present — fall through
  }
  // SSRF note: `url` here is always MODEL_URL or VOICES_URL, both hardcoded
  // to huggingface.co/hexgrad/Kokoro-82M above. If these constants ever move
  // to config / env / user input they must route through assertSafeHttpsUrl
  // + fetchFollowingSafeRedirects (see lib/ingest.js importFromUrl) instead
  // of a raw fetch with redirect:'follow'.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${step} download failed: ${res.status} ${res.statusText}`);
  const total = parseInt(res.headers.get('content-length') || '0', 10);
  let lastReported = 0;
  const reporter = new TransformStreamProgress(total, (pct) => {
    if (pct - lastReported >= 5) {
      lastReported = pct;
      onProgress({ step, status: 'progress', percent: pct });
    }
  });
  const readable = res.body;
  const nodeStream = webToNodeReadable(readable);
  const out = createWriteStream(outPath);
  // Tee the byte stream into a SHA-256 hasher via a passthrough Transform.
  // When expectedSha256 is null this still runs cheaply; the hash is just
  // discarded. This keeps the code path uniform.
  const hasher = crypto.createHash('sha256');
  const hashTee = new Transform({
    transform(chunk, _enc, cb) {
      hasher.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(
    nodeStream,
    reporter.toNodeTransform(),
    hashTee,
    out,
  );
  const actualSha256 = hasher.digest('hex');
  const stat = await fs.stat(outPath);
  if (stat.size < minBytes) {
    await fs.unlink(outPath);
    throw new Error(`${step} download too small (${stat.size} < ${minBytes})`);
  }
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    await fs.unlink(outPath);
    throw new Error(
      `${step} SHA-256 mismatch (got ${actualSha256}, expected ${expectedSha256})`,
    );
  }
}

function hashFile(p) {
  // Stream the file through the hasher — the model is ~320 MB and a readFile()
  // here would allocate a 320 MB buffer just to re-verify an on-disk pin.
  //
  // We wire up explicit 'data'/'end'/'error' listeners instead of `for await`
  // on the stream. The async-iterator shim on older Node can swallow mid-read
  // errors (the iterator just returns done), which would return a partial
  // digest for a corrupt file and spuriously pass the pinned-hash check. The
  // event-based form propagates errors via reject().
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = createReadStream(p);
    rs.on('error', reject);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

// ── tiny helpers ─────────────────────────────────────────────────────────

/**
 * Wraps a WebReadableStream into a Node Readable so `pipeline()` can chain it.
 * Node 18+ offers Readable.fromWeb; use that when available, else hand-roll.
 */
function webToNodeReadable(webStream) {
  if (typeof Readable.fromWeb === 'function') return Readable.fromWeb(webStream);
  return Readable.from(webStream);
}

class TransformStreamProgress {
  constructor(total, onTick) {
    this.total = 0;
    this.target = total;
    this.onTick = onTick;
  }
  toNodeTransform() {
    const self = this;
    return new Transform({
      transform(chunk, _enc, cb) {
        self.total += chunk.length;
        if (self.target > 0) self.onTick(Math.round((self.total / self.target) * 100));
        cb(null, chunk);
      },
    });
  }
}
