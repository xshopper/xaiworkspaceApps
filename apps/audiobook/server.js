/**
 * Audiobook — HTTP server (default port 3210).
 *
 * Phase 1 + 2 routes:
 *
 *   Library (Phase 1)
 *     GET    /health
 *     GET    /api/search?q=...
 *     POST   /api/books/import
 *     GET    /api/books
 *     GET    /api/books/:id
 *     DELETE /api/books/:id
 *     GET    /api/books/:id/chapters
 *     GET    /api/books/:id/chapters/:idx/text
 *
 *   TTS generation (Phase 2)
 *     POST   /api/books/:id/generate          { voice, speed, chapterIdx? }
 *     GET    /api/books/:id/chapters/:idx/audio        (range-request mp3)
 *     GET    /api/books/:id/chapters/:idx/audio-b64    (base64 envelope for iframe)
 *     GET    /api/books/:id/audio-status               (per-chapter generated flag)
 *     GET    /api/jobs/:id                    (single job status)
 *     GET    /api/jobs/:id/events             (SSE progress)
 *
 *   Sharing (Phase 2)
 *     POST   /api/books/:id/share             (mint/return share id)
 *     DELETE /api/books/:id/share             (revoke share id)
 *
 *   Voices (Phase 2 — voice cloning)
 *     GET    /api/voices
 *     POST   /api/voices                      (binary upload, up to MAX_VOICE_BODY)
 *     POST   /api/voices/b64                  (JSON { b64, contentType, consent } envelope)
 *     DELETE /api/voices/:id
 *
 *   Progress (Phase 1)
 *     GET    /api/progress
 *     POST   /api/progress
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { searchGutenberg, importFromUrl, getGutenbergBook } from './lib/ingest.js';
import { detectChapters } from './lib/chapters.js';
import {
  listBooks,
  getBook,
  getBookText,
  saveBook,
  deleteBook,
  bookDir,
  audioPath,
  audioExists,
  updateChapterMeta,
  setShareId,
  readProgress,
  writeProgress,
  validBookId,
} from './lib/storage.js';
import { tts, setKokoroPaths } from './lib/tts.js';
import { jobs } from './lib/jobs.js';
import { ensureTtsReady } from './lib/tts-install.js';
import { listVoices, saveVoice, deleteVoice } from './lib/voices.js';

const PORT = parseInt(process.env.APP_PORT ?? '3210', 10);
const BRIDGE_URL = process.env.BRIDGE_URL || '';
const APP_BRIDGE_TOKEN = process.env.APP_BRIDGE_TOKEN || '';
// Bug 16: ROUTER_URL has a single, explicit source. The previous
// ANTHROPIC_BASE_URL fallback silently masked misconfiguration and produced
// confusing 500s later at /share. If unset, share routes hard-fail with a
// specific message.
const ROUTER_URL = process.env.ROUTER_URL || '';
const ROUTER_TOKEN = process.env.ANTHROPIC_API_KEY || '';
// Share IDs come back from the router; we validate them before interpolating
// into the PUT URL so a compromised or misbehaving router can't coerce us into
// fetching arbitrary paths.
const SHARE_ID_RE = /^[A-Za-z0-9_-]{6,16}$/;
// Size cap for /audio-b64 — a 30 MB mp3 becomes ~40 MB base64, which is the
// upper limit we're willing to buffer in memory for the iframe JSON wrapper.
const MAX_AUDIO_B64_BYTES = 30 * 1024 * 1024;
// Concurrency guard: a user hammering /generate while an earlier request is
// still enqueueing would otherwise add the same (bookId, chapterIdx) to the
// TTS queue multiple times. audioExists() doesn't help once the first job is
// mid-flight but hasn't written the mp3 yet.
const enqueuedSet = new Set();
const enqueueKey = (bookId, chapterIdx) => `${bookId}:${chapterIdx}`;
const MAX_BODY = 1024 * 1024;
// Voice samples are larger (up to 10 MB raw audio), so /api/voices requests
// raise the ceiling just for that endpoint.
const MAX_VOICE_BODY = 12 * 1024 * 1024;
const DEFAULT_VOICE = getParam('defaultVoice', 'af_sky');
const DEFAULT_SPEED = parseFloat(getParam('defaultSpeed', '1.0')) || 1.0;

function getParam(key, fallback) {
  try {
    const p = JSON.parse(process.env.APP_PARAMETERS || '{}');
    return p[key] ?? fallback;
  } catch {
    return fallback;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`Body too large (max ${maxBytes} bytes)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function readBinaryBody(req, maxBytes = MAX_VOICE_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`Body too large (max ${maxBytes} bytes)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function notFound(res) {
  send(res, 404, { error: 'not found' });
}

function badRequest(res, msg) {
  send(res, 400, { error: msg });
}

function serverError(res, err) {
  console.error('[audiobook]', err);
  send(res, 500, { error: err.message || 'internal error' });
}

// Early reject oversize uploads based on Content-Length before we buffer a
// single byte. Without this, a 13 MB POST still streams ~12 MB into readBody/
// readBinaryBody before tripping the internal cap. Clients that omit or lie
// about Content-Length still hit the per-chunk check inside the body readers.
function checkContentLength(req, res, maxBytes) {
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (Number.isFinite(len) && len > maxBytes) {
    send(res, 413, { error: `body too large (${len} > ${maxBytes})` });
    return false;
  }
  return true;
}

// ── WS progress bridge ──────────────────────────────────────────────────

async function postToChat(text, buttons) {
  if (!BRIDGE_URL) return;
  try {
    await fetch(`${BRIDGE_URL}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(APP_BRIDGE_TOKEN ? { 'X-App-Bridge-Token': APP_BRIDGE_TOKEN } : {}),
      },
      body: JSON.stringify({ text, buttons, format: 'markdown' }),
    });
  } catch (e) {
    console.error('[audiobook] chat post failed:', e.message);
  }
}

// ── Range file serving ──────────────────────────────────────────────────

async function serveAudioRange(req, res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return notFound(res);
  }
  const size = stat.size;
  const range = req.headers.range;
  const headers = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  // pipeline() propagates read/write errors instead of silently dropping them
  // (raw .pipe() swallows source errors and can leave the socket half-open).
  if (!range) {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    try {
      await pipeline(fs.createReadStream(filePath), res);
    } catch (e) {
      console.error('[audiobook] audio stream failed:', e.message);
    }
    return;
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  // RFC 7233 suffix-length form `bytes=-500` = "last 500 bytes". The previous
  // code treated the empty start as 0 which is the opposite of the spec.
  let start;
  let end;
  if (match[1] === '' && match[2] !== '') {
    const suffixLen = parseInt(match[2], 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    start = Math.max(0, size - suffixLen);
    end = size - 1;
  } else {
    start = match[1] ? parseInt(match[1], 10) : 0;
    end = match[2] ? parseInt(match[2], 10) : size - 1;
  }
  if (start >= size || end >= size || end < start) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    ...headers,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  try {
    await pipeline(fs.createReadStream(filePath, { start, end }), res);
  } catch (e) {
    console.error('[audiobook] audio range stream failed:', e.message);
  }
}

// ── TTS event wiring ────────────────────────────────────────────────────

tts.on('progress', ({ jobId, percent, chunk, chunks }) => {
  jobs.update(jobId, { status: 'running', percent });
});

tts.on('done', async ({ jobId, mp3Path, durationSec }) => {
  const job = jobs.update(jobId, { status: 'done', percent: 100, durationSec });
  if (!job) return;
  // Free the dedupe slot so a re-generate (e.g. user changed voice) can proceed.
  enqueuedSet.delete(enqueueKey(job.bookId, job.chapterIdx));
  try {
    await updateChapterMeta(job.bookId, job.chapterIdx, {
      durationSec,
      audioPath: path.relative(bookDir(job.bookId), mp3Path),
    });
  } catch (e) {
    console.error('[audiobook] chapter meta update failed:', e.message);
  }
  await postToChat(
    `**Audiobook**\n\nChapter ${job.chapterIdx + 1} ready (${Math.round(durationSec)}s).`,
    [[
      { text: 'Play', callback_data: `@audiobook play ${job.bookId} ${job.chapterIdx}` },
    ]],
  );
});

tts.on('error', ({ jobId, message }) => {
  jobs.update(jobId, { status: 'error', error: message });
  const job = jobs.get(jobId);
  if (job) {
    enqueuedSet.delete(enqueueKey(job.bookId, job.chapterIdx));
    postToChat(`**Audiobook**\n\nChapter ${job.chapterIdx + 1} failed: ${message}`);
  }
});

tts.on('fatal', ({ message }) => {
  console.error('[audiobook] TTS fatal:', message);
});

// ── SSE helpers ─────────────────────────────────────────────────────────

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function attachJobSse(res, jobId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const snapshot = jobs.get(jobId);
  if (snapshot) sseWrite(res, snapshot);
  const listener = (job) => {
    if (job.id !== jobId) return;
    sseWrite(res, job);
    if (job.status === 'done' || job.status === 'error') {
      res.end();
      jobs.off('update', listener);
    }
  };
  jobs.on('update', listener);
  res.on('close', () => jobs.off('update', listener));
}

// ── Routes ──────────────────────────────────────────────────────────────

const routes = [
  { method: 'GET', path: /^\/health$/, handler: (req, res) => send(res, 200, { ok: true, version: '0.2.0' }) },

  {
    method: 'GET',
    path: /^\/api\/search$/,
    handler: async (req, res, url) => {
      const q = url.searchParams.get('q');
      if (!q) return badRequest(res, 'missing q');
      send(res, 200, { results: await searchGutenberg(q) });
    },
  },
  {
    method: 'POST',
    path: /^\/api\/books\/import$/,
    handler: async (req, res) => {
      const body = await jsonBody(req);
      if (!body) return badRequest(res, 'invalid JSON');
      const { sourceUrl, gutenbergId, forcedType } = body;
      let finalUrl = sourceUrl;
      let sourceType = 'url';
      let meta = null;
      if (gutenbergId) {
        meta = await getGutenbergBook(gutenbergId);
        const preferred = meta.downloads.epub || meta.downloads.pdf || meta.downloads.txt || meta.downloads.html;
        if (!preferred) return badRequest(res, 'no downloadable format on Gutendex');
        finalUrl = preferred;
        sourceType = 'gutenberg';
      }
      if (!finalUrl) return badRequest(res, 'missing sourceUrl or gutenbergId');
      const id = meta?.id || `url-${Buffer.from(finalUrl).toString('base64url').slice(0, 16)}`;
      const dir = bookDir(id);
      const extracted = await importFromUrl(finalUrl, dir, { forcedType });
      const chapters = detectChapters(extracted);
      const saved = await saveBook({
        id,
        title: meta?.title || extracted.title,
        author: meta?.author || extracted.author,
        sourceType,
        sourceUrl: finalUrl,
        text: extracted.text,
        chapters,
      });
      send(res, 200, saved);
    },
  },
  { method: 'GET', path: /^\/api\/books$/, handler: async (req, res) => send(res, 200, { books: await listBooks() }) },
  {
    method: 'GET',
    path: /^\/api\/books\/([^/]+)$/,
    handler: async (req, res, url, [, bookId]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      try {
        send(res, 200, await getBook(id));
      } catch (e) {
        if (e.code === 'ENOENT') return notFound(res);
        throw e;
      }
    },
  },
  {
    method: 'GET',
    path: /^\/api\/books\/([^/]+)\/chapters$/,
    handler: async (req, res, url, [, bookId]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      try {
        const meta = await getBook(id);
        send(res, 200, { chapters: meta.chapters });
      } catch (e) {
        if (e.code === 'ENOENT') return notFound(res);
        throw e;
      }
    },
  },
  {
    method: 'GET',
    path: /^\/api\/books\/([^/]+)\/chapters\/(\d+)\/text$/,
    handler: async (req, res, url, [, bookId, idxStr]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      try {
        const meta = await getBook(id);
        const idx = parseInt(idxStr, 10);
        const chapter = meta.chapters[idx];
        if (!chapter) return notFound(res);
        const full = await getBookText(id);
        const text = full.slice(chapter.startChar, chapter.endChar);
        send(res, 200, { idx, title: chapter.title, text });
      } catch (e) {
        if (e.code === 'ENOENT') return notFound(res);
        throw e;
      }
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/books\/([^/]+)$/,
    handler: async (req, res, url, [, bookId]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      await deleteBook(id);
      send(res, 200, { ok: true });
    },
  },

  // ── TTS generation ─────────────────────────────────────────────────────
  {
    method: 'POST',
    path: /^\/api\/books\/([^/]+)\/generate$/,
    handler: async (req, res, url, [, bookId]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      const body = (await jsonBody(req)) || {};
      const voice = body.voice || DEFAULT_VOICE;
      const speed = typeof body.speed === 'number' ? body.speed : DEFAULT_SPEED;
      // Number.isInteger rejects floats (3.5), NaN, and Infinity — typeof
      // 'number' let all of those through and crashed later on meta.chapters
      // index access.
      const explicitIdx = Number.isInteger(body.chapterIdx) ? body.chapterIdx : null;

      let meta;
      try {
        meta = await getBook(id);
      } catch {
        return notFound(res);
      }
      const fullText = await getBookText(id);

      const targets =
        explicitIdx !== null
          ? [meta.chapters[explicitIdx]].filter(Boolean)
          : meta.chapters;

      if (!targets.length) return badRequest(res, 'no chapters to generate');

      // Lazy install on first generate call. Subsequent calls no-op once the
      // marker + assets are present. Failures surface as a 500 with the exact
      // missing binary / step so the operator can act.
      try {
        const paths = await ensureTtsReady((progress) => {
          postToChat(
            `**Audiobook — TTS install**\n\n${progress.step}: ${progress.status}${progress.message ? `\n${progress.message}` : ''}${progress.percent != null ? `\n${progress.percent}%` : ''}`,
          );
        });
        setKokoroPaths(paths);
      } catch (e) {
        return serverError(res, e);
      }

      // Track the keys we reserve so we can roll them back if the enqueue
      // loop throws halfway through; otherwise a failed mkdir mid-batch would
      // leave enqueuedSet permanently blocking those chapters.
      const reserved = [];
      const enqueued = [];
      try {
        for (const ch of targets) {
          const key = enqueueKey(id, ch.idx);
          // Re-check audioExists + in-flight set atomically-ish in JS: both
          // happen inside the same microtask before we await anything. Two
          // concurrent /generate calls would otherwise each pass their own
          // audioExists check and then both enqueue.
          if (enqueuedSet.has(key)) {
            enqueued.push({ chapterIdx: ch.idx, status: 'in-progress' });
            continue;
          }
          if (await audioExists(id, ch.idx)) {
            enqueued.push({ chapterIdx: ch.idx, status: 'skipped' });
            continue;
          }
          enqueuedSet.add(key);
          reserved.push(key);
          const mp3 = audioPath(id, ch.idx);
          await fsp.mkdir(path.dirname(mp3), { recursive: true });
          const text = fullText.slice(ch.startChar, ch.endChar);
          const ttsJobId = tts.enqueue({ text, voice, speed, mp3Path: mp3 });
          const job = jobs.create({
            bookId: id,
            chapterIdx: ch.idx,
            voice,
            speed,
            mp3Path: mp3,
            ttsJobId,
          });
          enqueued.push({ chapterIdx: ch.idx, jobId: job.id, status: 'queued' });
        }
      } catch (e) {
        // Roll back every slot we claimed on this call. The tts.done/error
        // handlers will clean up the slots for any jobs that actually made it
        // to the queue, so we only remove reservations that haven't already
        // been consumed by a successful enqueue.
        for (const key of reserved) enqueuedSet.delete(key);
        return serverError(res, e);
      }
      send(res, 202, { bookId: id, enqueued });
    },
  },
  {
    method: 'GET',
    path: /^\/api\/books\/([^/]+)\/chapters\/(\d+)\/audio$/,
    handler: async (req, res, url, [, bookId, idxStr]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      const idx = parseInt(idxStr, 10);
      await serveAudioRange(req, res, audioPath(id, idx));
    },
  },
  // ── base64 wrapper endpoints (Bug 15) ──────────────────────────────────
  // The iframe-hosted UI goes via xai.http → router → worker which doesn't
  // tunnel binary bodies or Range requests. Agent B (UI) reads audio through
  // this wrapper; keep the raw /audio endpoint for future direct streaming.
  {
    method: 'GET',
    path: /^\/api\/books\/([^/]+)\/chapters\/(\d+)\/audio-b64$/,
    handler: async (req, res, url, [, bookId, idxStr]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      const idx = parseInt(idxStr, 10);
      const mp3 = audioPath(id, idx);
      let stat;
      try {
        stat = await fsp.stat(mp3);
      } catch {
        return notFound(res);
      }
      // A 30 MB mp3 becomes ~40 MB base64 + JSON overhead. Reject anything
      // larger so we don't OOM the worker on a very long chapter.
      if (stat.size > MAX_AUDIO_B64_BYTES) {
        return send(res, 413, {
          error: `chapter mp3 is ${stat.size} bytes; b64 wrapper caps at ${MAX_AUDIO_B64_BYTES}. Use /audio range endpoint.`,
        });
      }
      let durationSec = null;
      try {
        const meta = await getBook(id);
        durationSec = meta.chapters?.[idx]?.durationSec ?? null;
      } catch {
        /* chapter may still be generating */
      }
      const buf = await fsp.readFile(mp3);
      send(res, 200, {
        b64: buf.toString('base64'),
        contentType: 'audio/mpeg',
        durationSec,
      });
    },
  },
  {
    method: 'GET',
    path: /^\/api\/books\/([^/]+)\/audio-status$/,
    handler: async (req, res, url, [, bookId]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      let meta;
      try {
        meta = await getBook(id);
      } catch {
        return notFound(res);
      }
      const statuses = await Promise.all(
        meta.chapters.map(async (c) => ({
          idx: c.idx,
          generated: await audioExists(id, c.idx),
          durationSec: c.durationSec || null,
        })),
      );
      const activeJobs = jobs.listForBook(id).filter((j) => j.status === 'queued' || j.status === 'running');
      send(res, 200, { chapters: statuses, jobs: activeJobs });
    },
  },
  {
    method: 'GET',
    path: /^\/api\/jobs\/([^/]+)$/,
    handler: async (req, res, url, [, jobId]) => {
      const job = jobs.get(jobId);
      if (!job) return notFound(res);
      send(res, 200, job);
    },
  },
  {
    method: 'GET',
    path: /^\/api\/jobs\/([^/]+)\/events$/,
    handler: async (req, res, url, [, jobId]) => {
      attachJobSse(res, jobId);
    },
  },

  // ── Share (Phase 7) ─────────────────────────────────────────────────────
  {
    method: 'POST',
    path: /^\/api\/books\/([^/]+)\/share$/,
    handler: async (req, res, url, [, bookId]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      let meta;
      try {
        meta = await getBook(id);
      } catch {
        return notFound(res);
      }
      if (meta.sourceType !== 'gutenberg' && meta.sourceType !== 'original') {
        return badRequest(res, `Source type "${meta.sourceType}" is not publishable. Only gutenberg/original books can be shared.`);
      }
      if (!ROUTER_URL) {
        return serverError(res, new Error('ROUTER_URL env var not set on this install; share disabled'));
      }

      // Build chapter manifest; every chapter must already have generated audio.
      const missing = [];
      for (const ch of meta.chapters) {
        if (!(await audioExists(id, ch.idx))) missing.push(ch.idx);
      }
      if (missing.length) return badRequest(res, `Chapters not generated: ${missing.join(', ')}`);

      // Step 1: create share record.
      const createResp = await fetch(`${ROUTER_URL}/api/audiobooks/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ROUTER_TOKEN}`,
        },
        body: JSON.stringify({
          bookTitle: meta.title,
          author: meta.author,
          sourceType: meta.sourceType === 'gutenberg' ? 'gutenberg' : 'original',
          sourceRef: meta.sourceUrl,
          chapters: meta.chapters.map((c) => ({
            idx: c.idx,
            title: c.title,
            durationSec: c.durationSec || 0,
          })),
        }),
      });
      if (!createResp.ok) {
        const err = await createResp.json().catch(() => ({ error: `share create failed: ${createResp.status}` }));
        return serverError(res, new Error(err.error || `share failed (${createResp.status})`));
      }
      const share = await createResp.json();
      // Validate the share id the router handed back before splicing it into
      // the PUT URL. A compromised router that returns `../../foo` would
      // otherwise let us write outside /api/audiobooks/share/.
      if (typeof share?.id !== 'string' || !SHARE_ID_RE.test(share.id)) {
        return serverError(res, new Error(`router returned invalid share id: ${JSON.stringify(share?.id)}`));
      }

      // Step 2: stream each chapter mp3 up.
      for (const ch of meta.chapters) {
        const mp3 = audioPath(id, ch.idx);
        const body = await fsp.readFile(mp3);
        const upResp = await fetch(`${ROUTER_URL}/api/audiobooks/share/${share.id}/chapters/${ch.idx}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'audio/mpeg',
            Authorization: `Bearer ${ROUTER_TOKEN}`,
            'Content-Length': String(body.length),
          },
          body,
        });
        if (!upResp.ok) {
          const err = await upResp.json().catch(() => ({ error: `upload failed: ${upResp.status}` }));
          return serverError(res, new Error(`Ch ${ch.idx}: ${err.error || upResp.status}`));
        }
      }

      await setShareId(id, share.id, share.url);
      await postToChat(
        `**Audiobook shared**\n\n**${meta.title}**\n${share.url}\n\nAnyone with the link can listen.`,
        [[{ text: 'Copy link', callback_data: `@audiobook share ${id}` }]],
      );
      send(res, 201, share);
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/books\/([^/]+)\/share$/,
    handler: async (req, res, url, [, bookId]) => {
      const id = decodeURIComponent(bookId);
      if (!validBookId(id)) return badRequest(res, 'invalid bookId');
      let meta;
      try {
        meta = await getBook(id);
      } catch {
        return notFound(res);
      }
      if (!meta.share?.id) return badRequest(res, 'Book is not shared');
      if (!ROUTER_URL) {
        return serverError(res, new Error('ROUTER_URL env var not set on this install; share disabled'));
      }
      // Re-validate the id we stored — a tampered meta.json shouldn't let us
      // issue arbitrary DELETEs against the router.
      if (!SHARE_ID_RE.test(meta.share.id)) {
        return serverError(res, new Error(`stored share id failed validation: ${meta.share.id}`));
      }
      const resp = await fetch(`${ROUTER_URL}/api/audiobooks/share/${meta.share.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ROUTER_TOKEN}` },
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `unshare failed: ${resp.status}` }));
        return serverError(res, new Error(err.error || `unshare failed (${resp.status})`));
      }
      await setShareId(id, null, null);
      send(res, 200, { ok: true });
    },
  },

  // ── Voices (Phase 6) ───────────────────────────────────────────────────
  {
    method: 'GET',
    path: /^\/api\/voices$/,
    handler: async (req, res) => send(res, 200, { voices: await listVoices() }),
  },
  {
    method: 'POST',
    path: /^\/api\/voices$/,
    handler: async (req, res, url) => {
      // Binary body: raw audio bytes. Metadata comes via query params so we
      // avoid parsing multipart on a tiny server. `consent=true` is mandatory.
      const label = url.searchParams.get('label') || undefined;
      const consent = url.searchParams.get('consent') === 'true';
      const contentType = req.headers['content-type'] || '';
      if (!consent) return badRequest(res, 'consent=true required');
      if (!checkContentLength(req, res, MAX_VOICE_BODY)) return;
      const bytes = await readBinaryBody(req);
      try {
        const meta = await saveVoice({ label, consent, sourceBytes: bytes, sourceContentType: contentType });
        send(res, 200, meta);
      } catch (e) {
        badRequest(res, e.message);
      }
    },
  },
  // Mirror of POST /api/voices that accepts a JSON envelope with base64 audio.
  // Iframe uploads via xai.http which only carries string bodies, so the UI
  // serializes the recorded Blob to base64 and posts here.
  {
    method: 'POST',
    path: /^\/api\/voices\/b64$/,
    handler: async (req, res) => {
      // Parse inline with MAX_VOICE_BODY (12 MB) instead of jsonBody()'s 1 MB cap.
      // A 20-second 16 kHz mono WAV is already ~853 KB base64, so higher sample
      // rates / stereo / longer recordings would hit the default limit. Mirrors
      // the binary POST /api/voices path which uses readBinaryBody(MAX_VOICE_BODY).
      if (!checkContentLength(req, res, MAX_VOICE_BODY)) return;
      let body;
      try {
        const raw = await readBody(req, MAX_VOICE_BODY);
        body = JSON.parse(raw);
      } catch (e) {
        return badRequest(res, e.message || 'invalid JSON');
      }
      if (!body) return badRequest(res, 'invalid JSON');
      const { label, consent, contentType, b64 } = body;
      if (consent !== true) return badRequest(res, 'consent: true required');
      if (typeof b64 !== 'string' || !b64) return badRequest(res, 'b64 required');
      let bytes;
      try {
        bytes = Buffer.from(b64, 'base64');
      } catch {
        return badRequest(res, 'invalid base64');
      }
      if (!bytes.length) return badRequest(res, 'empty upload');
      try {
        const meta = await saveVoice({
          label,
          consent: true,
          sourceBytes: bytes,
          sourceContentType: typeof contentType === 'string' ? contentType : 'audio/webm',
        });
        send(res, 200, meta);
      } catch (e) {
        badRequest(res, e.message);
      }
    },
  },
  {
    method: 'DELETE',
    path: /^\/api\/voices\/([^/]+)$/,
    handler: async (req, res, url, [, voiceId]) => {
      await deleteVoice(decodeURIComponent(voiceId));
      send(res, 200, { ok: true });
    },
  },

  // ── Progress ───────────────────────────────────────────────────────────
  { method: 'GET', path: /^\/api\/progress$/, handler: async (req, res) => send(res, 200, await readProgress()) },
  {
    method: 'POST',
    path: /^\/api\/progress$/,
    handler: async (req, res) => {
      const body = await jsonBody(req);
      if (!body?.bookId) return badRequest(res, 'missing bookId');
      // Bug 2: reject bogus bookIds before they become keys in progress.json.
      // Without this, a client could write `__proto__` / `toString` / paths
      // with traversal characters and poison the store.
      if (!validBookId(body.bookId)) return badRequest(res, 'invalid bookId');
      const saved = await writeProgress(body.bookId, {
        chapterIdx: body.chapterIdx,
        posSec: body.posSec,
      });
      send(res, 200, saved);
    },
  },
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = url.pathname.match(route.path);
      if (match) return await route.handler(req, res, url, match);
    }
    notFound(res);
  } catch (err) {
    serverError(res, err);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[audiobook] listening on 127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => {
  tts.shutdown();
  server.close(() => process.exit(0));
});
