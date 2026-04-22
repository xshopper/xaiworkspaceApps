/**
 * Book ingest: search Gutendex, download EPUB/PDF, extract plain text.
 *
 * Returns a normalized Book object:
 *   { id, title, author, sourceType, sourceUrl, text, rawBytes }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { EPub } from 'epub2';
import pdfParse from 'pdf-parse';

const GUTENDEX = 'https://gutendex.com/books';
const MAX_BYTES = 50 * 1024 * 1024;

// SSRF guard — reject any URL that doesn't look like a safe public HTTPS
// endpoint. Even Gutendex download URLs go through this since the response is
// attacker-influenceable (a compromised Gutendex mirror could redirect to a
// RFC1918 address to probe the bridge network).
function ipIsPrivate(ip) {
  if (!ip) return true;
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    // fc00::/7 (unique-local, covers fd00::/8), fe80::/10 (link-local), ::ffff: mapped IPv4
    if (/^f[cd]/.test(lower)) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice(7);
      if (net.isIP(mapped) === 4) return ipIsPrivate(mapped);
    }
    return false;
  }
  return true;
}

async function assertSafeHttpsUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(`Only https:// URLs are allowed (got ${u.protocol})`);
  }
  const host = u.hostname;
  // Reject literal IPs that are private.
  if (net.isIP(host)) {
    if (ipIsPrivate(host)) throw new Error(`Refusing to fetch private IP: ${host}`);
    return;
  }
  // Resolve hostname and reject if any A/AAAA points into a private range.
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for ${host}: ${e.message}`);
  }
  for (const r of records) {
    if (ipIsPrivate(r.address)) {
      throw new Error(`Refusing to fetch ${host} — resolves to private address ${r.address}`);
    }
  }
}

export async function searchGutenberg(query, { limit = 20 } = {}) {
  const url = `${GUTENDEX}?search=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gutendex search failed: ${res.status}`);
  const { results = [] } = await res.json();
  return results.slice(0, limit).map(gutenbergToSearchResult);
}

export async function getGutenbergBook(id) {
  const res = await fetch(`${GUTENDEX}/${id}`);
  if (!res.ok) throw new Error(`Gutendex lookup failed: ${res.status}`);
  return gutenbergToSearchResult(await res.json());
}

function gutenbergToSearchResult(entry) {
  const formats = entry.formats || {};
  const epub = formats['application/epub+zip'];
  const plain =
    formats['text/plain; charset=utf-8'] ||
    formats['text/plain; charset=us-ascii'] ||
    formats['text/plain'];
  const pdf = formats['application/pdf'];
  const html = formats['text/html; charset=utf-8'] || formats['text/html'];
  return {
    id: `gutenberg-${entry.id}`,
    title: entry.title,
    author: (entry.authors || []).map((a) => a.name).join(', ') || 'Unknown',
    sourceType: 'gutenberg',
    downloads: {
      epub: epub || null,
      txt: plain || null,
      pdf: pdf || null,
      html: html || null,
    },
  };
}

export async function importFromUrl(url, destDir, { forcedType } = {}) {
  await fs.mkdir(destDir, { recursive: true });
  const type = forcedType || detectTypeFromUrl(url);
  const filename = `source${extensionFor(type)}`;
  const outPath = path.join(destDir, filename);
  // SSRF guard: https-only + no private/metadata IPs. Applied even for
  // Gutendex-sourced URLs because the final download host is attacker-
  // influenceable via the Gutendex response.
  await assertSafeHttpsUrl(url);
  // `redirect: 'manual'` so we can re-validate any Location header against
  // the same allow-list. Without this, a compromised upstream could 302 us
  // to http://169.254.169.254/.
  const res = await fetchFollowingSafeRedirects(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (len > MAX_BYTES) throw new Error(`File too large (${len} bytes, max ${MAX_BYTES})`);
  await pipeline(res.body, createWriteStream(outPath));
  const stat = await fs.stat(outPath);
  if (stat.size > MAX_BYTES) {
    await fs.unlink(outPath);
    throw new Error(`File too large after download (${stat.size} bytes)`);
  }
  const extracted = await extract(outPath, type);
  return { sourcePath: outPath, ...extracted };
}

async function fetchFollowingSafeRedirects(startUrl, maxHops = 5) {
  let current = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, { redirect: 'manual' });
    // fetch() in Node reports opaque redirect as status 0; we use manual so it
    // surfaces 3xx + Location normally.
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current).toString();
      await assertSafeHttpsUrl(next);
      current = next;
      // Drain body to free the socket before following the redirect.
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects starting from ${startUrl}`);
}

function detectTypeFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.includes('.epub')) return 'epub';
  if (lower.includes('.pdf')) return 'pdf';
  if (lower.includes('.txt')) return 'txt';
  if (lower.includes('.html') || lower.includes('.htm')) return 'html';
  return 'epub';
}

function extensionFor(type) {
  return { epub: '.epub', pdf: '.pdf', txt: '.txt', html: '.html' }[type] || '.bin';
}

async function extract(filePath, type) {
  if (type === 'epub') return extractEpub(filePath);
  if (type === 'pdf') return extractPdf(filePath);
  if (type === 'txt') return extractTxt(filePath);
  if (type === 'html') return extractHtml(filePath);
  throw new Error(`Unsupported type: ${type}`);
}

async function extractEpub(filePath) {
  const book = await EPub.createAsync(filePath);
  const title = book.metadata.title || path.basename(filePath);
  const author = book.metadata.creator || 'Unknown';
  const spineItems = book.flow || [];
  const chapters = [];
  let fullText = '';
  for (const item of spineItems) {
    const html = await new Promise((resolve, reject) => {
      book.getChapter(item.id, (err, out) => (err ? reject(err) : resolve(out)));
    });
    const plain = stripHtml(html);
    chapters.push({
      title: item.title || item.id,
      startChar: fullText.length,
      endChar: fullText.length + plain.length,
      text: plain,
    });
    fullText += plain + '\n\n';
  }
  return { title, author, text: fullText, epubChapters: chapters };
}

async function extractPdf(filePath) {
  const buf = await fs.readFile(filePath);
  const data = await pdfParse(buf);
  return {
    title: data.info?.Title || path.basename(filePath, '.pdf'),
    author: data.info?.Author || 'Unknown',
    text: data.text || '',
    pdfOutline: data.outline || null,
  };
}

async function extractTxt(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return { title: path.basename(filePath, '.txt'), author: 'Unknown', text };
}

async function extractHtml(filePath) {
  const html = await fs.readFile(filePath, 'utf8');
  return { title: path.basename(filePath, '.html'), author: 'Unknown', text: stripHtml(html) };
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
