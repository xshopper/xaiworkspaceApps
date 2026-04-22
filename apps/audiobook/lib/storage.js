/**
 * Local storage for book metadata + raw text under APP_DATA_DIR.
 *
 * Layout:
 *   $APP_DATA_DIR/
 *     books/
 *       <bookId>/
 *         meta.json     (title, author, sourceType, chapters[])
 *         text.txt      (full extracted text)
 *         source.{epub,pdf,txt,html}
 *         chapters/
 *           <idx>.mp3   (phase 2+)
 *     progress.json     (map bookId → { chapterIdx, posSec, updatedAt })
 *
 * Phase 1 keeps everything local; later phases add oc_app_data sync.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.APP_DATA_DIR || path.resolve('./data');

// Shared bookId validator used at every entry point. Allows lowercase/upper
// alphanumerics plus dash/underscore; first char must be alphanumeric so we
// never accept ".", "..", or leading dashes that could be misread as flags.
const BOOK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,200}$/;
export function validBookId(id) {
  return typeof id === 'string' && BOOK_ID_RE.test(id);
}
export function assertValidBookId(id) {
  if (!validBookId(id)) throw new Error('invalid bookId');
}

/**
 * Atomic JSON write: write to `<p>.tmp` then rename. `rename` on the same
 * filesystem is atomic, so readers never observe a truncated file even if
 * the process crashes mid-write.
 */
export async function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, p);
}

export function booksDir() {
  return path.join(DATA_DIR, 'books');
}

export function bookDir(bookId) {
  const safe = String(bookId).replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(booksDir(), safe);
}

export async function listBooks() {
  try {
    const entries = await fs.readdir(booksDir(), { withFileTypes: true });
    const books = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(booksDir(), e.name, 'meta.json'), 'utf8'));
        books.push(meta);
      } catch {
        // skip corrupted entries
      }
    }
    return books.sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export async function getBook(bookId) {
  assertValidBookId(bookId);
  const meta = JSON.parse(await fs.readFile(path.join(bookDir(bookId), 'meta.json'), 'utf8'));
  return meta;
}

export async function getBookText(bookId) {
  assertValidBookId(bookId);
  return fs.readFile(path.join(bookDir(bookId), 'text.txt'), 'utf8');
}

export function audioPath(bookId, chapterIdx) {
  return path.join(bookDir(bookId), 'chapters', `${chapterIdx}.mp3`);
}

export async function setShareId(bookId, shareId, shareUrl) {
  assertValidBookId(bookId);
  const metaPath = path.join(bookDir(bookId), 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  meta.share = shareId ? { id: shareId, url: shareUrl, sharedAt: new Date().toISOString() } : null;
  await writeJsonAtomic(metaPath, meta);
  return meta;
}

export async function audioExists(bookId, chapterIdx) {
  try {
    const st = await fs.stat(audioPath(bookId, chapterIdx));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export async function updateChapterMeta(bookId, chapterIdx, patch) {
  assertValidBookId(bookId);
  const metaPath = path.join(bookDir(bookId), 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  if (!meta.chapters[chapterIdx]) throw new Error('chapter not found');
  Object.assign(meta.chapters[chapterIdx], patch);
  await writeJsonAtomic(metaPath, meta);
  return meta.chapters[chapterIdx];
}

export async function saveBook({ id, title, author, sourceType, sourceUrl, text, chapters }) {
  assertValidBookId(id);
  const dir = bookDir(id);
  await fs.mkdir(dir, { recursive: true });
  const meta = {
    id,
    title,
    author,
    sourceType,
    sourceUrl: sourceUrl || null,
    chapters: chapters.map(({ idx, title, startChar, endChar }) => ({ idx, title, startChar, endChar })),
    chars: text.length,
    importedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  await fs.writeFile(path.join(dir, 'text.txt'), text);
  return meta;
}

export async function deleteBook(bookId) {
  assertValidBookId(bookId);
  await fs.rm(bookDir(bookId), { recursive: true, force: true });
}

export async function readProgress() {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'progress.json'), 'utf8'));
  } catch {
    return {};
  }
}

export async function writeProgress(bookId, { chapterIdx, posSec }) {
  assertValidBookId(bookId);
  const all = await readProgress();
  all[bookId] = {
    chapterIdx: chapterIdx || 0,
    posSec: posSec || 0,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(path.join(DATA_DIR, 'progress.json'), all);
  return all[bookId];
}
