/**
 * TTS job manager — long-lived Python sidecar + FIFO queue.
 *
 * Protocol: line-delimited JSON on stdin/stdout. See tts/tts_worker.py.
 *
 * Post-processing: WAV → MP3 via ffmpeg. ffmpeg and python3 must be on PATH.
 *
 * Events emitted by this module (via EventEmitter):
 *   'progress'   { jobId, chunk, chunks, percent }
 *   'done'       { jobId, outPath, mp3Path, durationSec }
 *   'error'      { jobId, message }
 *   'ready' / 'fatal'
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import crypto from 'node:crypto';

const WORKER_SCRIPT = new URL('../tts/tts_worker.py', import.meta.url).pathname;
const PYTHON = process.env.AUDIOBOOK_PYTHON || 'python3';
const FFMPEG = process.env.AUDIOBOOK_FFMPEG || 'ffmpeg';

// Bug 3: cap the TTS FIFO to protect the server from a runaway caller queuing
// thousands of chapters and exhausting memory / disk (each queued job holds a
// full chapter of text in-memory). `enqueue()` throws at the cap; the server
// handler translates the throw to HTTP 429 so the client can back off.
const MAX_QUEUE = 500;

/**
 * Paths to Kokoro assets. Injected by the lazy installer when it runs; until
 * then the worker falls back to the env-var defaults baked into tts_worker.py.
 */
let kokoroPaths = null;

export function setKokoroPaths(paths) {
  kokoroPaths = paths;
}

/**
 * Best-effort unlink — used in cleanup paths where a missing file is expected.
 */
async function safeUnlink(p) {
  if (!p) return;
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

export class TtsManager extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.ready = false;
    this.queue = [];
    this.active = null;
    this.fatal = null;
  }

  ensureStarted() {
    if (this.worker || this.fatal) return;
    const env = { ...process.env };
    if (kokoroPaths) {
      env.KOKORO_MODEL = kokoroPaths.modelPath;
      env.KOKORO_VOICES = kokoroPaths.voicesPath;
    }
    // Honour the --user site installed by the lazy installer so importing
    // kokoro_onnx works without a global install. Parenthesised to fix an
    // operator-precedence bug: `A || B ? C : D` is `(A||B) ? C : D`, so with
    // PYTHONUSERBASE unset we were always taking the HOME branch — harmless
    // then, but any non-empty PYTHONUSERBASE would be masked by the ternary.
    env.PYTHONUSERBASE =
      env.PYTHONUSERBASE || (process.env.HOME ? `${process.env.HOME}/.local` : undefined);
    this.worker = spawn(PYTHON, [WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const rl = readline.createInterface({ input: this.worker.stdout });
    rl.on('line', (line) => this._handleLine(line));
    // readline's 'error' fires if stdout closes mid-decode. Don't let that
    // kill the process — the 'exit' handler below is responsible for cleanup.
    rl.on('error', (e) => {
      console.error('[tts] stdout readline error:', e.message);
    });
    this.worker.stderr.on('data', (d) => {
      console.error('[tts] stderr:', d.toString());
    });
    this.worker.on('exit', (code) => {
      console.error(`[tts] worker exited code=${code}`);
      const deadWorker = this.worker;
      this.worker = null;
      this.ready = false;
      // Fail every in-flight + queued job so callers aren't left hanging. The
      // next `enqueue()` will lazily spawn a fresh worker.
      const dropped = [];
      if (this.active) {
        dropped.push(this.active);
        this.active = null;
      }
      dropped.push(...this.queue.splice(0, this.queue.length));
      for (const job of dropped) {
        safeUnlink(job.wavPath);
        this.emit('error', { jobId: job.jobId, message: `worker exited (${code})` });
      }
      // Detach listeners so a zombie process can't leak them.
      if (deadWorker?.stdout) deadWorker.stdout.removeAllListeners();
      if (deadWorker?.stderr) deadWorker.stderr.removeAllListeners();
    });
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === 'ready') {
      this.ready = true;
      this.emit('ready');
      this._drain();
      return;
    }
    if (msg.event === 'fatal') {
      this.fatal = msg.message;
      this.emit('fatal', msg);
      return;
    }
    if (msg.event === 'progress') {
      const percent = msg.chunks ? Math.round((msg.chunk / msg.chunks) * 100) : 0;
      this.emit('progress', { jobId: msg.jobId, chunk: msg.chunk, chunks: msg.chunks, percent });
      return;
    }
    if (msg.event === 'done') {
      const job = this.active;
      this.active = null;
      this._finalize(job, msg).then(() => this._drain()).catch((e) => {
        // Finalize failed — ensure we don't leave stray wav/mp3 partials.
        safeUnlink(job?.mp3Path);
        safeUnlink(msg?.outPath);
        this.emit('error', { jobId: msg.jobId, message: String(e) });
        this._drain();
      });
      return;
    }
    if (msg.event === 'error') {
      const active = this.active;
      const jobId = msg.jobId || active?.jobId;
      this.active = null;
      // Clean up the wav partial the worker may have started writing before
      // it bailed; otherwise $APP_DATA_DIR accumulates stale half-synthesised
      // audio over repeated failures.
      if (active) safeUnlink(active.wavPath);
      this.emit('error', { jobId, message: msg.message });
      this._drain();
    }
  }

  async _finalize(job, msg) {
    const mp3Path = job.mp3Path;
    await convertWavToMp3(msg.outPath, mp3Path);
    await safeUnlink(msg.outPath);
    this.emit('done', {
      jobId: job.jobId,
      outPath: msg.outPath,
      mp3Path,
      durationSec: msg.durationSec,
    });
  }

  _drain() {
    if (!this.ready || this.active || this.queue.length === 0) return;
    const next = this.queue.shift();
    this.active = next;
    // stdin.write can throw EPIPE synchronously (or emit 'error' async) if the
    // worker died between the previous line and this one. Guard against both
    // so the job fails cleanly instead of crashing the mini-app server.
    try {
      this.worker.stdin.write(
        JSON.stringify({
          jobId: next.jobId,
          text: next.text,
          voice: next.voice,
          speed: next.speed,
          outPath: next.wavPath,
        }) + '\n',
      );
    } catch (e) {
      this.active = null;
      safeUnlink(next.wavPath);
      this.emit('error', { jobId: next.jobId, message: `stdin write failed: ${e.message}` });
      // Tear down the likely-dead worker so 'exit' fires and lazy-restart kicks
      // in on the next enqueue.
      try { this.worker?.kill(); } catch { /* ignore */ }
      this.worker = null;
      this.ready = false;
      // Schedule the next drain so any remaining queued jobs get restarted.
      setImmediate(() => this._drain());
    }
  }

  enqueue({ text, voice, speed, mp3Path }) {
    if (this.fatal) throw new Error(`TTS worker fatal: ${this.fatal}`);
    // Bug 3: bound the queue so a caller can't DoS the worker by spamming
    // thousands of chapters. 500 is well above any legitimate book (a long
    // novel rarely exceeds 50 chapters) but low enough to bound memory.
    if (this.queue.length >= MAX_QUEUE) {
      const err = new Error('TTS queue full; try again later');
      err.code = 'QUEUE_FULL';
      throw err;
    }
    // ensureStarted is idempotent; calling here means a crashed worker auto-
    // restarts on the next enqueue without any external orchestration.
    this.ensureStarted();
    const jobId = crypto.randomUUID();
    const wavPath = mp3Path.replace(/\.mp3$/, '.wav');
    this.queue.push({ jobId, text, voice, speed, mp3Path, wavPath });
    this._drain();
    return jobId;
  }

  shutdown() {
    if (this.worker) {
      try {
        this.worker.stdin.write(JSON.stringify({ action: 'shutdown' }) + '\n');
      } catch {
        /* ignore */
      }
      this.worker.kill();
      this.worker = null;
    }
  }
}

function convertWavToMp3(wavPath, mp3Path) {
  // Bug 1: write to <mp3Path>.part and rename on success. If ffmpeg is killed
  // mid-write (SIGTERM, OOM, crash) the partial file never takes the final
  // name, so `audioExists()` (size > 0 on final path) never falsely reports
  // "generated" for a truncated mp3. Mirrors writeJsonAtomic pattern.
  const partPath = `${mp3Path}.part`;
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, [
      '-y',
      '-loglevel', 'error',
      '-i', wavPath,
      '-codec:a', 'libmp3lame',
      '-qscale:a', '5',
      partPath,
    ]);
    ff.on('error', async (e) => {
      await safeUnlink(partPath);
      reject(e);
    });
    ff.on('exit', async (code) => {
      if (code === 0) {
        try {
          await fs.rename(partPath, mp3Path);
          resolve(mp3Path);
        } catch (renameErr) {
          await safeUnlink(partPath);
          reject(renameErr);
        }
      } else {
        await safeUnlink(partPath);
        reject(new Error(`ffmpeg exit ${code}`));
      }
    });
  });
}

// Singleton shared across the server.
export const tts = new TtsManager();
