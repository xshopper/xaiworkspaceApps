/**
 * Voice sample storage.
 *
 * A voice is a 20–60 second audio recording of the user reading a guided
 * passage, used later to clone their narration via a voice-cloning TTS engine
 * (Chatterbox/XTTS — Phase 6.5). Until the clone engine ships, samples are
 * stored but marked `engineReady: false` so the UI can hide them from the
 * voice picker used by /generate.
 *
 * Layout:
 *   $APP_DATA_DIR/voices/
 *     <voiceId>/
 *       meta.json    — { id, label, consent, createdAt, durationSec, sampleRate }
 *       sample.wav   — canonical 16-bit PCM mono ≥16 kHz
 *       source.*     — original upload (may be webm/ogg/wav)
 *
 * Validation: duration 20–60s, size ≤10 MB, sample rate ≥16 kHz after decode.
 * ffmpeg is used to probe + transcode into canonical wav.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const DATA_DIR = process.env.APP_DATA_DIR || path.resolve('./data');
const VOICES_DIR = path.join(DATA_DIR, 'voices');

const MIN_DURATION_SEC = 20;
const MAX_DURATION_SEC = 60;
const MIN_SAMPLE_RATE = 16000;
const MAX_BYTES = 10 * 1024 * 1024;

export function voicesDir() {
  return VOICES_DIR;
}

export function voiceDir(voiceId) {
  const safe = String(voiceId).replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(VOICES_DIR, safe);
}

export async function listVoices() {
  try {
    const entries = await fs.readdir(VOICES_DIR, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(VOICES_DIR, e.name, 'meta.json'), 'utf8'));
        out.push(meta);
      } catch {
        // skip
      }
    }
    return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export async function deleteVoice(voiceId) {
  await fs.rm(voiceDir(voiceId), { recursive: true, force: true });
}

export async function saveVoice({ label, consent, sourceBytes, sourceContentType }) {
  if (!consent) throw new Error('Consent is required to store a voice sample.');
  if (!sourceBytes || !sourceBytes.length) throw new Error('Empty upload.');
  if (sourceBytes.length > MAX_BYTES) throw new Error(`Upload too large (${sourceBytes.length} > ${MAX_BYTES})`);

  const ext = extensionFor(sourceContentType) || 'bin';
  const id = `voice-${crypto.randomBytes(4).toString('hex')}`;
  const dir = voiceDir(id);
  await fs.mkdir(dir, { recursive: true });
  const sourcePath = path.join(dir, `source.${ext}`);
  const wavPath = path.join(dir, 'sample.wav');
  await fs.writeFile(sourcePath, sourceBytes);

  try {
    await transcodeToWav(sourcePath, wavPath);
    const probe = await probeDurationAndRate(wavPath);
    if (probe.durationSec < MIN_DURATION_SEC) {
      throw new Error(`Sample too short (${probe.durationSec.toFixed(1)}s; need ≥${MIN_DURATION_SEC}s).`);
    }
    if (probe.durationSec > MAX_DURATION_SEC) {
      throw new Error(`Sample too long (${probe.durationSec.toFixed(1)}s; max ${MAX_DURATION_SEC}s).`);
    }
    if (probe.sampleRate < MIN_SAMPLE_RATE) {
      throw new Error(`Sample rate too low (${probe.sampleRate} < ${MIN_SAMPLE_RATE}).`);
    }
    const meta = {
      id,
      label: (label || `My voice ${new Date().toLocaleDateString()}`).slice(0, 80),
      consent: true,
      createdAt: new Date().toISOString(),
      durationSec: Math.round(probe.durationSec * 10) / 10,
      sampleRate: probe.sampleRate,
      engineReady: false,
      engine: null,
    };
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

function extensionFor(ct) {
  if (!ct) return null;
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('ogg')) return 'ogg';
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  if (ct.includes('wav') || ct.includes('x-wav') || ct.includes('wave')) return 'wav';
  if (ct.includes('mp4') || ct.includes('m4a')) return 'm4a';
  return null;
}

function transcodeToWav(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-loglevel', 'error',
      '-i', inPath,
      '-ac', '1',
      '-ar', '22050',
      '-acodec', 'pcm_s16le',
      outPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`))));
  });
}

function probeDurationAndRate(wavPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', wavPath,
      '-hide_banner',
      '-f', 'null',
      '-',
    ];
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('exit', (code) => {
      // Ignoring the exit code masked ffmpeg failures (e.g. corrupt/truncated
      // input would still match a leftover `Hz` from the stream header and
      // produce a bogus duration). Treat any non-zero code as a probe error.
      if (code !== 0) {
        return reject(new Error(`ffmpeg probe exit ${code}: ${stderr.slice(-300)}`));
      }
      const durMatch = /time=(\d+):(\d+):(\d+\.\d+)/.exec(stderr);
      const hzMatch = /(\d+)\s*Hz/.exec(stderr);
      const durationSec = durMatch
        ? parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3])
        : 0;
      const sampleRate = hzMatch ? parseInt(hzMatch[1], 10) : 0;
      if (!durationSec || !sampleRate) return reject(new Error(`Failed to probe wav: ${stderr.slice(-300)}`));
      resolve({ durationSec, sampleRate });
    });
  });
}
