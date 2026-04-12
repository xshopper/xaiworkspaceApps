#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.APP_PORT || '3470', 10);
const APP_DIR = process.env.APP_DIR || path.dirname(process.argv[1]);
const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const SCREENSHOTS_DIR = path.join(APP_DIR, 'screenshots');

// --- Config ---

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[done24bot] config.json parse error — treating as empty');
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getApiKey() {
  const cfg = loadConfig();
  if (cfg.apiKey) return cfg.apiKey;
  // Fall back to install parameter
  try {
    const params = JSON.parse(process.env.APP_PARAMETERS || '{}');
    if (params.apiKey) {
      saveConfig({ ...cfg, apiKey: params.apiKey });
      return params.apiKey;
    }
  } catch {}
  return null;
}

// --- Auto-provision ---

async function autoProvision() {
  if (getApiKey()) return; // Already configured

  // Try to load from workspace secret store
  try {
    const { execFileSync } = require('child_process');
    const key = execFileSync('oc-secret', ['get', 'done24bot/apikey'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (key && key.startsWith('dk_')) {
      const cfg = loadConfig();
      cfg.apiKey = key;
      saveConfig(cfg);
      console.log('[done24bot] API key loaded from workspace secret store');
    }
  } catch {}
}

// Run auto-provision on startup (non-blocking)
autoProvision().catch(() => {});

// --- Puppeteer ---

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch {
  console.error('[done24bot] puppeteer-core not installed. Run: npm install puppeteer-core');
  process.exit(1);
}

const API_KEY_REGEX = /^dk_[A-Za-z0-9_-]+$/;

function validateApiKey(key) {
  if (!key || !API_KEY_REGEX.test(key)) {
    throw new Error('Invalid API key format (expected dk_...)');
  }
  return key;
}

async function connectBrowser() {
  const apiKey = validateApiKey(getApiKey());
  const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://w.done24bot.com?apiKey=${encodeURIComponent(apiKey)}`,
    defaultViewport: { width: 1280, height: 800 },
  });
  return browser;
}

async function withPage(fn, opts = {}) {
  const browser = await connectBrowser();
  try {
    const page = await browser.newPage();
    try {
      if (opts.url) {
        await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (opts.waitFor) {
          await page.waitForSelector(opts.waitFor, { timeout: 10000 }).catch(() => {});
        }
      }
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    try { browser.disconnect(); } catch {}
  }
}

// --- Routes ---

async function handleBrowse(body) {
  if (!body.url) return { error: 'url is required' };
  return withPage(async (page) => {
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 50000) || '');
    return { title, url: page.url(), text };
  }, { url: body.url, waitFor: body.waitFor });
}

const MAX_SCREENSHOTS = 50;

async function handleScreenshot(body) {
  if (!body.url) return { error: 'url is required' };
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  // Cap retained screenshots — delete oldest when limit exceeded
  try {
    const files = fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('.png')).sort();
    while (files.length >= MAX_SCREENSHOTS) {
      fs.unlinkSync(path.join(SCREENSHOTS_DIR, files.shift()));
    }
  } catch {}
  const filename = `screenshot-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  return withPage(async (page) => {
    await page.screenshot({ path: filepath, fullPage: body.fullPage || false });
    const stat = fs.statSync(filepath);
    return { path: filepath, filename, size: stat.size };
  }, { url: body.url, waitFor: body.waitFor });
}

async function handleExtract(body) {
  if (!body.url) return { error: 'url is required' };
  return withPage(async (page) => {
    const selector = body.selector || 'body';
    const elements = await page.$$eval(selector, els =>
      els.slice(0, 100).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: el.innerText?.slice(0, 5000) || '',
        href: el.href || undefined,
        src: el.src || undefined,
      }))
    );
    return { selector, count: elements.length, elements };
  }, { url: body.url, waitFor: body.waitFor });
}

function handleStatus() {
  const apiKey = getApiKey();
  return {
    status: apiKey ? 'configured' : 'no_api_key',
    hasApiKey: !!apiKey,
    keyPreview: apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : null,
    port: PORT,
    screenshotsDir: SCREENSHOTS_DIR,
  };
}

function handleSetConfig(body) {
  if (!body.apiKey) return { error: 'apiKey is required' };
  if (!API_KEY_REGEX.test(body.apiKey)) return { error: 'Invalid API key format (expected dk_...)' };
  const cfg = loadConfig();
  cfg.apiKey = body.apiKey;
  saveConfig(cfg);
  return { ok: true, keyPreview: `${body.apiKey.slice(0, 6)}...${body.apiKey.slice(-4)}` };
}

// --- Server ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS for sandbox
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, handleStatus());
    }

    if (req.method !== 'POST') {
      return sendJson(res, { error: 'Method not allowed' }, 405);
    }

    const body = await parseBody(req);

    switch (url.pathname) {
      case '/api/browse':     return sendJson(res, await handleBrowse(body));
      case '/api/screenshot': return sendJson(res, await handleScreenshot(body));
      case '/api/extract':    return sendJson(res, await handleExtract(body));
      case '/api/config':     return sendJson(res, handleSetConfig(body));
      default:                return sendJson(res, { error: 'Not found' }, 404);
    }
  } catch (err) {
    console.error(`[done24bot] ${req.method} ${url.pathname} error:`, err.message);
    const status = err.message.includes('No API key') ? 401 : 500;
    sendJson(res, { error: err.message }, status);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[done24bot] Server listening on http://127.0.0.1:${PORT}`);
  const status = handleStatus();
  console.log(`[done24bot] API key: ${status.hasApiKey ? status.keyPreview : 'NOT SET'}`);
});
