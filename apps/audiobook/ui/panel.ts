import type { Book, PanelState, PlayerState, RecorderState, SearchResult, Voice } from './types';
import * as api from './api';

const VOICE_SCRIPT = `The sun rose over the quiet harbour as the tide turned. Small boats creaked at their moorings, and gulls circled above the lighthouse. She tightened the rope, checked the compass, and set her course for the open sea. A single thought stayed with her through the journey: courage is a choice we make each morning. The wind carried the scent of salt and pine, and the horizon shimmered with the promise of distant shores.`;

const MIN_RECORD_SEC = 20;
const MAX_RECORD_SEC = 60;

const VOICES = ['af_sky', 'af_bella', 'am_adam', 'am_michael', 'bf_emma', 'bm_george'];
const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

const state: PanelState = {
  tab: 'library',
  loading: false,
  error: null,
  shareMessage: null,
  library: [],
  search: { query: '', results: [] },
  activeBook: null,
  audioStatus: null,
  player: { bookId: null, chapterIdx: 0, status: 'idle', positionSec: 0, durationSec: 0 },
  voice: 'af_sky',
  speed: 1.0,
  voices: [],
  recorder: { status: 'idle', elapsedSec: 0, preview: null, blob: null, consent: false, label: '', message: null },
};

let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let recorderTimer: number | null = null;
let recorderChunks: BlobPart[] = [];
let recorderStartedAt = 0;

/**
 * Host audio permission is delivered via the `host:init` event AFTER module
 * load, so we cannot capture it as a module-level constant. Call this at each
 * decision site instead. `device.audio` is the canonical name; `audio` is a
 * transitional alias.
 */
function useHostAudio(): boolean {
  return (
    Array.isArray(xai.permissions) &&
    (xai.permissions.includes('device.audio') || xai.permissions.includes('audio'))
  );
}

let statusTimer: number | null = null;
let progressSaveTimer: number | null = null;
let currentAudioBlobUrl: string | null = null;

/**
 * Blob URL lifecycle: a blob URL is created in `playChapter` when a chapter's
 * audio bytes are fetched. It is revoked when (a) the next `playChapter`
 * replaces it, (b) `stopPlayback` tears down playback, or (c) the iframe
 * unloads (browser GC). We intentionally do NOT revoke on tab switch —
 * revoking while an HTMLAudioElement still has it as `src` terminates web
 * playback, and the retained bytes are a single mp3 (~few MB) which the
 * next play/stop naturally releases.
 */
function revokeCurrentAudioBlob() {
  if (currentAudioBlobUrl) {
    URL.revokeObjectURL(currentAudioBlobUrl);
    currentAudioBlobUrl = null;
  }
}

// The xai SDK exposes no .off() for listener removal. If this module is
// re-evaluated inside the same xai instance (iframe hot reload, re-mount),
// the previous listeners remain subscribed. Stamp a module-local id on
// globalThis so earlier closures can recognise themselves as stale and
// bail out — the most recent module load always wins.
const MODULE_ID = Math.random().toString(36).slice(2);
(globalThis as any).__audiobookPanelId = MODULE_ID;

xai.on('audio:state', (s: any) => {
  if ((globalThis as any).__audiobookPanelId !== MODULE_ID) return; // stale listener from prior module load
  if (!s) return;
  if (!useHostAudio()) return;
  state.player.status = s.status || state.player.status;
  state.player.positionSec = s.positionSec ?? 0;
  state.player.durationSec = s.durationSec ?? state.player.durationSec;
  const bar = document.getElementById('ab-bar') as HTMLProgressElement | null;
  const pos = document.getElementById('ab-pos');
  if (bar) bar.value = state.player.positionSec;
  if (pos) pos.textContent = fmtTime(state.player.positionSec);
  schedulePersistProgress();
  if (state.player.status === 'ended') {
    const next = state.player.chapterIdx + 1;
    if (state.activeBook && next < state.activeBook.chapters.length) playChapter(next);
  }
});
xai.on('audio:remoteCommand', (e: any) => {
  if ((globalThis as any).__audiobookPanelId !== MODULE_ID) return; // stale listener from prior module load
  if (!useHostAudio()) return;
  if (!state.activeBook) return;
  if (e.command === 'next') playChapter(state.player.chapterIdx + 1);
  if (e.command === 'previous') playChapter(Math.max(0, state.player.chapterIdx - 1));
});

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(sec: number): string {
  if (!isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ── State transitions ────────────────────────────────────────────────────

function setTab(tab: PanelState['tab']) {
  state.tab = tab;
  state.error = null;
  if (tab === 'library') void refreshLibrary();
  if (tab === 'voice') void refreshVoices();
  if (tab === 'book' && state.activeBook) void refreshAudioStatus();
  render();
}

// ── Voice recorder ───────────────────────────────────────────────────────

async function refreshVoices() {
  try {
    state.voices = await api.listVoices();
  } catch (e: any) {
    state.recorder.message = `Failed to load voices: ${e?.message || e}`;
  }
  render();
}

async function startRecording() {
  if (mediaRecorder) return;
  state.recorder = {
    status: 'requesting',
    elapsedSec: 0,
    preview: null,
    blob: null,
    consent: state.recorder.consent,
    label: state.recorder.label,
    message: null,
  };
  render();
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
  } catch (e: any) {
    state.recorder.status = 'error';
    state.recorder.message = `Microphone permission denied: ${e?.message || e}`;
    render();
    return;
  }
  const mimeType = pickSupportedMimeType();
  recorderChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener('dataavailable', (ev) => {
      if (ev.data && ev.data.size > 0) recorderChunks.push(ev.data);
    });
    mediaRecorder.addEventListener('stop', onRecorderStop);
    mediaRecorder.start(1000);
  } catch (e: any) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    mediaRecorder = null;
    state.recorder.status = 'error';
    state.recorder.message = `Recorder failed to start: ${e?.message || e}`;
    render();
    return;
  }
  recorderStartedAt = Date.now();
  state.recorder.status = 'recording';
  render();
  recorderTimer = window.setInterval(() => {
    state.recorder.elapsedSec = Math.round((Date.now() - recorderStartedAt) / 1000);
    const span = document.getElementById('rec-elapsed');
    if (span) span.textContent = fmtTime(state.recorder.elapsedSec);
    if (state.recorder.elapsedSec >= MAX_RECORD_SEC) stopRecording();
  }, 250);
}

function pickSupportedMimeType(): string | null {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const mt of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mt)) {
      return mt;
    }
  }
  return null;
}

function stopRecording() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (recorderTimer != null) {
    clearInterval(recorderTimer);
    recorderTimer = null;
  }
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
}

function onRecorderStop() {
  if (!mediaRecorder) return;
  const blob = new Blob(recorderChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
  mediaRecorder = null;
  // Compute elapsed from captured start timestamp (not the 250ms timer state,
  // which would read 0 when stop happens faster than the first tick).
  const elapsedSec = recorderStartedAt
    ? Math.round((Date.now() - recorderStartedAt) / 1000)
    : state.recorder.elapsedSec;
  state.recorder.elapsedSec = elapsedSec;
  state.recorder.status = elapsedSec < MIN_RECORD_SEC ? 'error' : 'stopped';
  state.recorder.blob = blob;
  state.recorder.preview = URL.createObjectURL(blob);
  state.recorder.message =
    elapsedSec < MIN_RECORD_SEC
      ? `Recording too short (${elapsedSec}s; need ≥${MIN_RECORD_SEC}s).`
      : null;
  render();
}

function resetRecorder() {
  if (state.recorder.preview) URL.revokeObjectURL(state.recorder.preview);
  state.recorder = { status: 'idle', elapsedSec: 0, preview: null, blob: null, consent: false, label: state.recorder.label, message: null };
  recorderChunks = [];
  render();
}

async function submitRecording() {
  if (!state.recorder.blob) return;
  if (!state.recorder.consent) {
    state.recorder.message = 'Consent required before upload.';
    render();
    return;
  }
  state.recorder.status = 'uploading';
  state.recorder.message = null;
  render();
  try {
    const voice = await api.uploadVoice(state.recorder.blob, {
      label: state.recorder.label || '',
      consent: state.recorder.consent,
    });
    state.voices = [voice, ...state.voices];
    resetRecorder();
  } catch (e: any) {
    state.recorder.status = 'error';
    state.recorder.message = e?.message || 'Upload failed';
    render();
  }
}

// ── Share ────────────────────────────────────────────────────────────────

async function toggleShare() {
  if (!state.activeBook) return;
  const book = state.activeBook;
  if (book.share?.id) {
    if (!confirm('Unshare this book? The public link will stop working.')) return;
    try {
      await api.unshareBook(book.id);
      state.activeBook = await api.getBook(book.id);
      render();
    } catch (e: any) {
      state.error = e?.message || 'Unshare failed';
      render();
    }
    return;
  }
  const publishable = book.sourceType === 'gutenberg';
  if (!publishable) {
    state.error = 'Only public-domain (Gutenberg) imports can be shared.';
    render();
    return;
  }
  if (!confirm('Publish this audiobook to a public URL? Anyone with the link can listen.')) return;
  state.loading = true;
  state.error = null;
  render();
  try {
    await api.shareBook(book.id);
    state.activeBook = await api.getBook(book.id);
  } catch (e: any) {
    state.error = e?.message || 'Share failed';
  } finally {
    state.loading = false;
    render();
  }
}

async function copyShareLink() {
  const url = state.activeBook?.share?.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    state.shareMessage = 'Link copied to clipboard.';
    render();
    window.setTimeout(() => {
      state.shareMessage = null;
      render();
    }, 2000);
  } catch {
    state.shareMessage = 'Copy failed — long-press the link to copy manually.';
    render();
  }
}

async function removeVoice(id: string) {
  if (!confirm('Delete this voice sample?')) return;
  try {
    await api.deleteVoice(id);
    state.voices = state.voices.filter((v) => v.id !== id);
    render();
  } catch (e: any) {
    state.recorder.message = `Delete failed: ${e?.message || e}`;
    render();
  }
}

async function refreshLibrary() {
  state.loading = true;
  render();
  try {
    state.library = await api.listLibrary();
    state.error = null;
  } catch (e: any) {
    state.error = e?.message || 'Failed to load library';
  } finally {
    state.loading = false;
    render();
  }
}

async function runSearch(query: string) {
  state.search.query = query;
  state.loading = true;
  render();
  try {
    state.search.results = await api.searchGutenberg(query);
    state.error = null;
  } catch (e: any) {
    state.error = e?.message || 'Search failed';
  } finally {
    state.loading = false;
    render();
  }
}

async function importGutenberg(id: string) {
  state.loading = true;
  state.error = null;
  render();
  try {
    const numericId = id.replace(/^gutenberg-/, '');
    const book = await api.importBook({ gutenbergId: numericId });
    await openBook(book.id);
    await refreshLibrary();
  } catch (e: any) {
    state.error = e?.message || 'Import failed';
  } finally {
    state.loading = false;
    render();
  }
}

async function openBook(id: string) {
  // Clear any polling from the previously active book before we switch.
  if (statusTimer != null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  state.loading = true;
  render();
  try {
    state.activeBook = await api.getBook(id);
    state.tab = 'book';
    state.error = null;
    await Promise.all([refreshAudioStatus(), refreshVoices()]);
  } catch (e: any) {
    state.error = e?.message || 'Failed to open book';
  } finally {
    state.loading = false;
    render();
  }
}

async function refreshAudioStatus() {
  if (!state.activeBook) return;
  try {
    state.audioStatus = await api.getAudioStatus(state.activeBook.id);
  } catch {
    state.audioStatus = null;
  }
  render();
  ensureStatusPolling();
}

function ensureStatusPolling() {
  const hasActiveJobs = !!state.audioStatus?.jobs?.some(
    (j) => j.status === 'queued' || j.status === 'running',
  );
  if (hasActiveJobs && statusTimer == null) {
    statusTimer = window.setInterval(() => {
      void refreshAudioStatus();
    }, 2000);
  } else if (!hasActiveJobs && statusTimer != null) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

async function removeBook(id: string) {
  if (!confirm('Remove this book from the library?')) return;
  try {
    await api.deleteBook(id);
    if (state.activeBook?.id === id) {
      state.activeBook = null;
      state.tab = 'library';
      stopPlayback();
    }
    await refreshLibrary();
  } catch (e: any) {
    state.error = e?.message || 'Delete failed';
    render();
  }
}

async function generateBook(chapterIdx?: number) {
  if (!state.activeBook) return;
  try {
    const payload: { voice: string; speed: number; chapterIdx?: number } = {
      voice: state.voice,
      speed: state.speed,
    };
    if (typeof chapterIdx === 'number') payload.chapterIdx = chapterIdx;
    await api.generate(state.activeBook.id, payload);
    await refreshAudioStatus();
  } catch (e: any) {
    state.error = e?.message || 'Generate failed';
    render();
  }
}

// ── Player ───────────────────────────────────────────────────────────────

let webAudio: HTMLAudioElement | null = null;

async function playChapter(chapterIdx: number) {
  if (!state.activeBook) return;
  const status = state.audioStatus?.chapters.find((c) => c.idx === chapterIdx);
  if (!status?.generated) {
    state.error = 'Chapter audio not yet generated.';
    render();
    return;
  }
  const book = state.activeBook;
  const chapterIdxAtStart = chapterIdx;
  state.player = {
    bookId: book.id,
    chapterIdx,
    status: 'loading',
    positionSec: 0,
    durationSec: status.durationSec ?? 0,
  };
  render();

  // Revoke any previously created blob URL before we fetch a new chapter.
  revokeCurrentAudioBlob();

  let url: string;
  try {
    url = await api.fetchAudioBlob(book.id, chapterIdx);
  } catch (e: any) {
    state.error = e?.message || 'Failed to load audio';
    state.player.status = 'error';
    render();
    return;
  }

  // User may have switched books OR chapters (on the same book) while the
  // fetch was in flight — abort to avoid blasting stale audio into the
  // current player target.
  if (state.activeBook?.id !== book.id || state.player.chapterIdx !== chapterIdxAtStart) {
    URL.revokeObjectURL(url);
    return;
  }
  currentAudioBlobUrl = url;

  const chapter = book.chapters[chapterIdx];

  if (useHostAudio()) {
    try {
      const loadOpts: XaiAudioLoadOpts = {
        url,
        title: `${book.title} — ${chapter?.title || `Chapter ${chapterIdx + 1}`}`,
        artist: book.author,
        album: book.title,
        bookId: book.id,
        chapterIdx,
      };
      if (status.durationSec) loadOpts.durationSec = status.durationSec;
      await xai.audio.load(loadOpts);
      await xai.audio.setRate(state.speed);
      await xai.audio.play();
    } catch (e: any) {
      state.error = e?.message || 'Playback failed';
      render();
    }
    return;
  }

  mountWebAudio(url);
}

function mountWebAudio(src: string) {
  if (!webAudio) {
    webAudio = document.createElement('audio');
    webAudio.preload = 'auto';
    webAudio.controls = false;
    webAudio.addEventListener('loadedmetadata', () => {
      state.player.durationSec = webAudio!.duration ?? state.player.durationSec;
      render();
    });
    webAudio.addEventListener('timeupdate', () => {
      state.player.positionSec = webAudio!.currentTime;
      schedulePersistProgress();
      const span = document.getElementById('ab-pos');
      if (span) span.textContent = fmtTime(state.player.positionSec);
      const bar = document.getElementById('ab-bar') as HTMLProgressElement | null;
      if (bar) bar.value = state.player.positionSec;
    });
    webAudio.addEventListener('play', () => { state.player.status = 'playing'; render(); });
    webAudio.addEventListener('pause', () => { state.player.status = 'paused'; render(); });
    webAudio.addEventListener('ended', () => {
      const next = state.player.chapterIdx + 1;
      if (state.activeBook && next < state.activeBook.chapters.length) {
        void playChapter(next);
      } else {
        state.player.status = 'idle';
        render();
      }
    });
    webAudio.addEventListener('error', () => { state.player.status = 'error'; render(); });
  }
  webAudio.src = src;
  webAudio.currentTime = 0;
  void webAudio.play();
}

async function togglePlay() {
  if (useHostAudio()) {
    if (state.player.status === 'playing') await xai.audio.pause();
    else await xai.audio.play();
    return;
  }
  if (!webAudio) return;
  if (webAudio.paused) void webAudio.play();
  else webAudio.pause();
}

async function stopPlayback() {
  if (useHostAudio()) {
    await xai.audio.stop();
  } else if (webAudio) {
    webAudio.pause();
    webAudio.src = '';
  }
  state.player.status = 'idle';
  revokeCurrentAudioBlob();
}

async function seekRelative(deltaSec: number) {
  if (useHostAudio()) {
    await xai.audio.seekRelative(deltaSec);
    return;
  }
  if (!webAudio) return;
  webAudio.currentTime = Math.max(0, webAudio.currentTime + deltaSec);
}

async function setSpeed(speed: number) {
  state.speed = speed;
  if (useHostAudio()) await xai.audio.setRate(speed);
  else if (webAudio) webAudio.playbackRate = speed;
  render();
}

function schedulePersistProgress() {
  if (progressSaveTimer != null) return;
  progressSaveTimer = window.setTimeout(async () => {
    progressSaveTimer = null;
    if (!state.player.bookId) return;
    try {
      await api.saveProgress(state.player.bookId, state.player.chapterIdx, state.player.positionSec);
    } catch {
      /* ignore */
    }
  }, 10000);
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderTabs(): string {
  const btn = (id: PanelState['tab'], label: string) => `
    <button class="tab ${state.tab === id ? 'active' : ''}" data-action="tab:${id}">${label}</button>
  `;
  return `<div class="tabs">${btn('library', 'Library')}${btn('discover', 'Discover')}${state.activeBook ? btn('book', 'Book') : ''}${btn('voice', 'Voice')}</div>`;
}

function renderShareStrip(b: Book): string {
  const publishable = b.sourceType === 'gutenberg';
  const toast = state.shareMessage ? `<div class="share-toast">${esc(state.shareMessage)}</div>` : '';
  if (b.share?.id) {
    return `
      <div class="share-strip shared">
        <span class="share-label">Public link:</span>
        <a href="${esc(b.share.url)}" target="_blank" rel="noopener noreferrer">${esc(b.share.url)}</a>
        <button data-action="share-copy">Copy</button>
        <button class="danger" data-action="share-off">Unshare</button>
      </div>
      ${toast}`;
  }
  return `
    <div class="share-strip">
      <button ${publishable ? '' : 'disabled title="Only Gutenberg sources are publishable"'} data-action="share-on">Publish public link</button>
      ${publishable ? '' : '<span class="hint">Only Gutenberg imports can be shared.</span>'}
    </div>
    ${toast}`;
}

function renderVoiceTab(): string {
  const r = state.recorder;
  const voices = state.voices
    .map(
      (v: Voice) => `
      <li class="voice-row">
        <span class="v-label">${esc(v.label)}</span>
        <span class="v-meta">${v.durationSec.toFixed(1)}s · ${v.sampleRate}Hz${v.engineReady ? '' : ' · not usable yet'}</span>
        <button class="danger" data-action="voice-del:${esc(v.id)}">Delete</button>
      </li>`,
    )
    .join('');

  const recControls =
    r.status === 'idle' || r.status === 'error'
      ? `<button class="primary" data-action="rec-start">● Record</button>`
      : r.status === 'requesting'
        ? `<button disabled>Requesting mic…</button>`
        : r.status === 'recording'
          ? `<button class="danger" data-action="rec-stop">■ Stop (<span id="rec-elapsed">${fmtTime(r.elapsedSec)}</span>)</button>`
          : r.status === 'uploading'
            ? `<button disabled>Uploading…</button>`
            : `
              <button data-action="rec-reset">Redo</button>
              <button class="primary" data-action="rec-submit" ${r.consent ? '' : 'disabled'}>Upload</button>
            `;

  const preview = r.preview
    ? `<audio controls src="${esc(r.preview)}" style="width:100%;margin:8px 0;"></audio>`
    : '';

  const msg = r.message ? `<div class="error">${esc(r.message)}</div>` : '';

  return `
    <div class="voice">
      <h2>Record your voice</h2>
      <p class="hint">Read the passage below for 20–60 seconds. Your voice sample is stored locally on your workspace and used only to narrate your own library. Do not record another person's voice.</p>
      <div class="voice-script">${esc(VOICE_SCRIPT)}</div>
      ${msg}
      <div class="voice-controls">${recControls}</div>
      ${preview}
      <div class="voice-form">
        <label>Label
          <input id="voiceLabel" type="text" placeholder="My reading voice" value="${esc(r.label)}" maxlength="80" />
        </label>
        <label class="consent">
          <input id="voiceConsent" type="checkbox" ${r.consent ? 'checked' : ''} />
          I consent to storing this voice sample for personal TTS use.
        </label>
      </div>
      <h3>Recorded voices</h3>
      ${voices ? `<ul class="voices-list">${voices}</ul>` : '<div class="hint">No voices yet.</div>'}
    </div>
  `;
}

function renderLibrary(): string {
  if (state.loading && state.library.length === 0) return `<div class="hint">Loading…</div>`;
  if (state.library.length === 0) {
    return `<div class="hint">Library empty. Try <b>Discover</b> to find public-domain books.</div>`;
  }
  const items = state.library
    .map(
      (b) => `
      <div class="card" data-action="open:${esc(b.id)}">
        <div class="title">${esc(b.title)}</div>
        <div class="meta">${esc(b.author)} · ${b.chapters.length} chapters · ${b.chars.toLocaleString()} chars</div>
        <button class="danger" data-action="remove:${esc(b.id)}">Remove</button>
      </div>`,
    )
    .join('');
  return `<div class="grid">${items}</div>`;
}

function renderDiscover(): string {
  const q = esc(state.search.query);
  const results = state.search.results
    .map(
      (r: SearchResult) => `
      <div class="card">
        <div class="title">${esc(r.title)}</div>
        <div class="meta">${esc(r.author)} · ${esc(r.id)}</div>
        <button data-action="import:${esc(r.id)}">Import</button>
      </div>`,
    )
    .join('');
  return `
    <div class="search">
      <input type="text" id="searchInput" placeholder="Search Project Gutenberg…" value="${q}" />
      <button data-action="search">Search</button>
    </div>
    ${state.loading ? `<div class="hint">Searching…</div>` : ''}
    ${results ? `<div class="grid">${results}</div>` : state.search.query && !state.loading ? `<div class="hint">No results.</div>` : ''}
  `;
}

function statusForChapter(idx: number) {
  const jobs = state.audioStatus?.jobs || [];
  const job = jobs.find((j) => j.chapterIdx === idx && (j.status === 'queued' || j.status === 'running'));
  if (job) return { kind: 'pending' as const, percent: job.percent };
  const ch = state.audioStatus?.chapters.find((c) => c.idx === idx);
  return ch?.generated ? { kind: 'ready' as const, duration: ch.durationSec } : { kind: 'none' as const };
}

function renderPlayer(): string {
  const p = state.player;
  if (!state.activeBook) return '';
  if (!p.bookId || p.bookId !== state.activeBook.id) return '';
  const ch = state.activeBook.chapters[p.chapterIdx];
  if (!ch) return '';
  const label = p.status === 'playing' ? 'Pause' : 'Play';
  return `
    <div class="player">
      <div class="np">
        <div class="np-title">${esc(ch.title)}</div>
        <div class="np-sub">Chapter ${p.chapterIdx + 1} · ${p.status}</div>
      </div>
      <div class="controls">
        <button data-action="seek:-30">−30s</button>
        <button data-action="toggle" class="play">${label}</button>
        <button data-action="seek:30">+30s</button>
        <button data-action="stop">Stop</button>
      </div>
      <div class="scrubber">
        <span id="ab-pos">${fmtTime(p.positionSec)}</span>
        <progress id="ab-bar" value="${p.positionSec}" max="${Math.max(1, p.durationSec)}"></progress>
        <span>${fmtTime(p.durationSec)}</span>
      </div>
      <div class="speed">
        ${SPEEDS.map((s) => `<button class="${s === state.speed ? 'active' : ''}" data-action="speed:${s}">${s}x</button>`).join('')}
      </div>
    </div>`;
}

function renderBook(): string {
  const b = state.activeBook;
  if (!b) return `<div class="hint">No book selected.</div>`;
  const chapters = b.chapters
    .map((c) => {
      const s = statusForChapter(c.idx);
      let statusCell = '';
      if (s.kind === 'ready') {
        statusCell = `<button class="play-ch" data-action="play:${c.idx}">▶ ${fmtTime(s.duration || 0)}</button>`;
      } else if (s.kind === 'pending') {
        statusCell = `<span class="badge">generating ${s.percent}%</span>`;
      } else {
        statusCell = `<button class="gen-ch" data-action="gen:${c.idx}">Generate</button>`;
      }
      return `
        <li>
          <span class="idx">${c.idx + 1}.</span>
          <span class="ctitle">${esc(c.title)}</span>
          ${statusCell}
        </li>`;
    })
    .join('');
  return `
    <div class="book">
      <h2>${esc(b.title)}</h2>
      <div class="meta">${esc(b.author)} · ${b.chapters.length} chapters</div>
      ${renderShareStrip(b)}
      <div class="toolbar">
        <label>Voice
          <select id="voiceSel">
            <optgroup label="Kokoro (built-in)">
              ${VOICES.map((v) => `<option value="${v}" ${v === state.voice ? 'selected' : ''}>${v}</option>`).join('')}
            </optgroup>
            ${state.voices.length
              ? `<optgroup label="My recordings">
                  ${state.voices
                    .map(
                      (v) =>
                        `<option value="user:${esc(v.id)}" ${!v.engineReady ? 'disabled' : ''}>${esc(v.label)}${v.engineReady ? '' : ' (engine pending)'}</option>`,
                    )
                    .join('')}
                </optgroup>`
              : ''}
          </select>
        </label>
        <label>Speed
          <select id="speedSel">
            ${SPEEDS.map((s) => `<option value="${s}" ${s === state.speed ? 'selected' : ''}>${s}x</option>`).join('')}
          </select>
        </label>
        <button data-action="gen-all">Generate all</button>
        <button data-action="refresh-status">Refresh</button>
      </div>
      ${renderPlayer()}
      <ol class="chapters">${chapters}</ol>
    </div>
  `;
}

function render() {
  const body =
    state.tab === 'library'
      ? renderLibrary()
      : state.tab === 'discover'
        ? renderDiscover()
        : state.tab === 'voice'
          ? renderVoiceTab()
          : renderBook();
  const err = state.error ? `<div class="error">${esc(state.error)}</div>` : '';
  xai.render(`
    <style>
      .tabs { display: flex; gap: 4px; border-bottom: 1px solid #2a2a2a; margin-bottom: 12px; }
      .tab { background: transparent; border: none; color: #999; padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; }
      .tab.active { color: #fff; border-bottom-color: #4a9eff; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
      .card { border: 1px solid #2a2a2a; border-radius: 6px; padding: 12px; cursor: pointer; }
      .card .title { font-weight: 600; margin-bottom: 4px; }
      .card .meta { color: #888; font-size: 12px; margin-bottom: 8px; }
      .hint { color: #888; padding: 16px 0; }
      .error { background: #3a1a1a; color: #ff9; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; }
      .search { display: flex; gap: 8px; margin-bottom: 12px; }
      .search input { flex: 1; padding: 6px 10px; background: #1a1a1a; border: 1px solid #2a2a2a; color: #fff; border-radius: 4px; }
      .book h2 { margin: 0 0 4px 0; }
      .toolbar { display: flex; gap: 12px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
      .toolbar label { color: #888; font-size: 12px; }
      .toolbar select { margin-left: 4px; background: #1a1a1a; color: #fff; border: 1px solid #2a2a2a; padding: 2px 6px; border-radius: 4px; }
      .player { border: 1px solid #2a2a2a; border-radius: 6px; padding: 12px; margin: 12px 0; background: #161616; }
      .player .np-title { font-weight: 600; }
      .player .np-sub { color: #888; font-size: 12px; }
      .player .controls { display: flex; gap: 8px; margin: 8px 0; }
      .player .controls .play { background: #4a9eff; color: #000; font-weight: 600; }
      .scrubber { display: flex; gap: 8px; align-items: center; font-variant-numeric: tabular-nums; color: #aaa; font-size: 12px; }
      .scrubber progress { flex: 1; height: 6px; }
      .speed { display: flex; gap: 4px; margin-top: 6px; }
      .speed button.active { background: #4a9eff; color: #000; }
      .chapters { list-style: none; padding: 0; margin: 0; }
      .chapters li { padding: 6px 0; border-bottom: 1px solid #2a2a2a; display: flex; gap: 8px; align-items: baseline; }
      .chapters .idx { color: #666; width: 2em; }
      .chapters .ctitle { flex: 1; }
      .badge { color: #888; font-size: 12px; }
      button { background: #2a2a2a; border: none; color: #fff; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
      button:hover { background: #3a3a3a; }
      button.danger { background: #3a1a1a; }
      button.play-ch { background: #1f3a1f; }
      button.gen-ch { background: #2a2a3a; }
      button.primary { background: #4a9eff; color: #000; font-weight: 600; }
      .share-strip { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border: 1px solid #2a2a2a; border-radius: 6px; margin: 8px 0; font-size: 13px; flex-wrap: wrap; }
      .share-strip.shared { border-color: #2a4a2a; background: #132013; }
      .share-strip .share-label { color: #888; }
      .share-strip a { color: #4a9eff; word-break: break-all; }
      .share-toast { background: #1f3a1f; color: #d0ffd0; padding: 6px 10px; border-radius: 4px; margin: 4px 0 8px; font-size: 12px; }
      .voice { max-width: 640px; }
      .voice-script { background: #151515; border: 1px solid #2a2a2a; border-radius: 6px; padding: 12px; margin: 12px 0; font-style: italic; line-height: 1.5; white-space: pre-wrap; }
      .voice-controls { display: flex; gap: 8px; margin: 8px 0; }
      .voice-form { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
      .voice-form label { color: #ccc; font-size: 13px; }
      .voice-form input[type=text] { margin-top: 4px; width: 100%; padding: 6px 10px; background: #1a1a1a; border: 1px solid #2a2a2a; color: #fff; border-radius: 4px; }
      .voice-form .consent { display: flex; gap: 8px; align-items: center; }
      .voices-list { list-style: none; padding: 0; margin: 0; }
      .voice-row { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid #2a2a2a; }
      .v-label { flex: 1; }
      .v-meta { color: #888; font-size: 12px; }
    </style>
    ${renderTabs()}
    ${err}
    ${body}
  `);

  document.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const action = el.dataset.action!;
      if (action.startsWith('tab:')) return setTab(action.slice(4) as PanelState['tab']);
      if (action.startsWith('open:')) return openBook(action.slice(5));
      if (action.startsWith('remove:')) return removeBook(action.slice(7));
      if (action.startsWith('import:')) return importGutenberg(action.slice(7));
      if (action.startsWith('play:')) return void playChapter(parseInt(action.slice(5), 10));
      if (action.startsWith('gen:')) return generateBook(parseInt(action.slice(4), 10));
      if (action.startsWith('seek:')) return void seekRelative(parseInt(action.slice(5), 10));
      if (action.startsWith('speed:')) return void setSpeed(parseFloat(action.slice(6)));
      if (action === 'gen-all') return generateBook();
      if (action === 'refresh-status') return void refreshAudioStatus();
      if (action === 'toggle') return void togglePlay();
      if (action === 'stop') return void stopPlayback();
      if (action === 'share-on') return void toggleShare();
      if (action === 'share-off') return void toggleShare();
      if (action === 'share-copy') return void copyShareLink();
      if (action === 'rec-start') return void startRecording();
      if (action === 'rec-stop') return stopRecording();
      if (action === 'rec-reset') return resetRecorder();
      if (action === 'rec-submit') return void submitRecording();
      if (action.startsWith('voice-del:')) return void removeVoice(action.slice('voice-del:'.length));
      if (action === 'search') {
        const input = document.getElementById('searchInput') as HTMLInputElement | null;
        if (input?.value.trim()) void runSearch(input.value.trim());
      }
    });
  });
  const input = document.getElementById('searchInput') as HTMLInputElement | null;
  if (input) {
    input.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter' && input.value.trim()) {
        void runSearch(input.value.trim());
      }
    });
  }
  const voiceSel = document.getElementById('voiceSel') as HTMLSelectElement | null;
  if (voiceSel) voiceSel.addEventListener('change', () => (state.voice = voiceSel.value));
  const speedSel = document.getElementById('speedSel') as HTMLSelectElement | null;
  if (speedSel) speedSel.addEventListener('change', () => void setSpeed(parseFloat(speedSel.value)));
  const labelInput = document.getElementById('voiceLabel') as HTMLInputElement | null;
  if (labelInput) labelInput.addEventListener('input', () => (state.recorder.label = labelInput.value));
  const consentInput = document.getElementById('voiceConsent') as HTMLInputElement | null;
  if (consentInput) consentInput.addEventListener('change', () => {
    state.recorder.consent = consentInput.checked;
    render();
  });
}

// Boot
void refreshLibrary();
