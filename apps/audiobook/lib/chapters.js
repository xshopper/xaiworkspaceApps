/**
 * Chapter detection.
 *
 * Priority:
 *  1. EPUB spine (already produced by ingest extractEpub)
 *  2. PDF outline (from pdf-parse)
 *  3. Heading regex on raw text
 *  4. Fixed-size chunk fallback (~5k chars, on paragraph boundary)
 *
 * Always returns Chapter[] with { idx, title, startChar, endChar }.
 */

const HEADING_PATTERNS = [
  /^\s*(CHAPTER|Chapter)\s+([IVXLCDM]+|\d+)\b.*$/m,
  /^\s*(BOOK|PART)\s+([IVXLCDM]+|\d+)\b.*$/m,
  /^\s*\d+\.\s+[A-Z][^\n]{0,80}$/m,
];

const CHUNK_SIZE = 5000;

export function detectChapters({ text, epubChapters, pdfOutline }) {
  if (Array.isArray(epubChapters) && epubChapters.length > 1) {
    return epubChapters.map((c, idx) => ({
      idx,
      title: c.title || `Chapter ${idx + 1}`,
      startChar: c.startChar,
      endChar: c.endChar,
    }));
  }
  if (pdfOutline && Array.isArray(pdfOutline) && pdfOutline.length > 1) {
    return fromPdfOutline(pdfOutline, text);
  }
  const byHeading = fromHeadings(text);
  if (byHeading.length > 1) return byHeading;
  return fromChunks(text);
}

function fromPdfOutline(outline, text) {
  const flat = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.title) flat.push({ title: n.title });
      if (n.items) walk(n.items);
    }
  };
  walk(outline);
  if (flat.length < 2) return [];
  const result = [];
  let cursor = 0;
  for (let i = 0; i < flat.length; i++) {
    const needle = flat[i].title;
    const idx = text.indexOf(needle, cursor);
    const start = idx >= 0 ? idx : cursor;
    result.push({ idx: i, title: needle, startChar: start });
    cursor = start + 1;
  }
  for (let i = 0; i < result.length; i++) {
    result[i].endChar = i + 1 < result.length ? result[i + 1].startChar : text.length;
  }
  return result;
}

function fromHeadings(text) {
  const matches = [];
  for (const pattern of HEADING_PATTERNS) {
    const global = new RegExp(pattern.source, 'gm');
    let m;
    while ((m = global.exec(text)) !== null) {
      matches.push({ offset: m.index, title: m[0].trim() });
    }
    if (matches.length >= 3) break;
  }
  if (matches.length < 2) return [];
  matches.sort((a, b) => a.offset - b.offset);
  const deduped = [];
  for (const m of matches) {
    if (!deduped.length || m.offset - deduped[deduped.length - 1].offset > 200) {
      deduped.push(m);
    }
  }
  const result = deduped.map((m, i) => ({
    idx: i,
    title: m.title,
    startChar: m.offset,
    endChar: 0,
  }));
  for (let i = 0; i < result.length; i++) {
    result[i].endChar = i + 1 < result.length ? result[i + 1].startChar : text.length;
  }
  return result;
}

function fromChunks(text) {
  const result = [];
  let cursor = 0;
  let idx = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const nextBreak = text.indexOf('\n\n', end);
      if (nextBreak > 0 && nextBreak - end < 500) end = nextBreak;
    }
    result.push({
      idx,
      title: `Part ${idx + 1}`,
      startChar: cursor,
      endChar: end,
    });
    cursor = end;
    idx++;
  }
  return result;
}
