import type { Book, SearchResult } from './types';

const BASE = 'http://localhost:3210';

export async function listLibrary(): Promise<Book[]> {
  const res = await xai.http<{ books: Book[] }>(`${BASE}/api/books`);
  return res.data.books || [];
}

export async function getBook(id: string): Promise<Book> {
  const res = await xai.http<Book>(`${BASE}/api/books/${encodeURIComponent(id)}`);
  return res.data;
}

export async function deleteBook(id: string): Promise<void> {
  await xai.http(`${BASE}/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function searchGutenberg(query: string): Promise<SearchResult[]> {
  const res = await xai.http<{ results: SearchResult[] }>(
    `${BASE}/api/search?q=${encodeURIComponent(query)}`,
  );
  return res.data.results || [];
}

export async function importBook(payload: { sourceUrl?: string; gutenbergId?: string | number }): Promise<Book> {
  const res = await xai.http<Book>(`${BASE}/api/books/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.data;
}

export interface AudioStatusChapter {
  idx: number;
  generated: boolean;
  durationSec: number | null;
}
export interface AudioStatusJob {
  id: string;
  bookId: string;
  chapterIdx: number;
  status: 'queued' | 'running' | 'done' | 'error';
  percent: number;
  error: string | null;
}
export interface AudioStatus {
  chapters: AudioStatusChapter[];
  jobs: AudioStatusJob[];
}

export async function getAudioStatus(bookId: string): Promise<AudioStatus> {
  const res = await xai.http<AudioStatus>(
    `${BASE}/api/books/${encodeURIComponent(bookId)}/audio-status`,
  );
  return res.data;
}

export async function generate(bookId: string, opts: { voice?: string; speed?: number; chapterIdx?: number } = {}): Promise<void> {
  await xai.http(`${BASE}/api/books/${encodeURIComponent(bookId)}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
}

export async function fetchAudioBlob(bookId: string, idx: number): Promise<string> {
  const res = await xai.http<{ b64: string; contentType: string }>(
    `${BASE}/api/books/${encodeURIComponent(bookId)}/chapters/${idx}/audio-b64`,
  );
  const bin = atob(res.data.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: res.data.contentType || 'audio/mpeg' }));
}

export async function saveProgress(bookId: string, chapterIdx: number, posSec: number): Promise<void> {
  await xai.http(`${BASE}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId, chapterIdx, posSec }),
  });
}

// ── Share ────────────────────────────────────────────────────────────────

export interface ShareResult {
  id: string;
  url: string;
}

export async function shareBook(bookId: string): Promise<ShareResult> {
  const res = await xai.http<ShareResult>(`${BASE}/api/books/${encodeURIComponent(bookId)}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return res.data;
}

export async function unshareBook(bookId: string): Promise<void> {
  await xai.http(`${BASE}/api/books/${encodeURIComponent(bookId)}/share`, { method: 'DELETE' });
}

// ── Voices ───────────────────────────────────────────────────────────────

import type { Voice } from './types';

export async function listVoices(): Promise<Voice[]> {
  const res = await xai.http<{ voices: Voice[] }>(`${BASE}/api/voices`);
  return res.data.voices || [];
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = await b.arrayBuffer();
  let bin = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

/**
 * Upload a recorded voice sample.
 *
 * The sandbox `xai.http` proxy only accepts string bodies, so we base64-encode
 * the audio Blob and POST it as JSON to the app server's b64 endpoint. Direct
 * fetch from the iframe to localhost:3210 fails (null-origin / CSP), so all
 * calls must go through `xai.http`.
 */
export async function uploadVoice(blob: Blob, opts: { label: string; consent: boolean }): Promise<Voice> {
  const b64 = await blobToBase64(blob);
  const res = await xai.http<Voice>(`${BASE}/api/voices/b64`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: opts.label,
      consent: opts.consent,
      contentType: blob.type || 'audio/webm',
      b64,
    }),
  });
  return res.data;
}

export async function deleteVoice(id: string): Promise<void> {
  await xai.http(`${BASE}/api/voices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
