/**
 * Minimal static file server for the test harness.
 *
 * Routes:
 *   /               → claude-code-panel.html (the harness)
 *   /panel.js       → apps/claude-code/ui/panel.js (the real panel code)
 *   /harness/*      → e2e/harness/* static files
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9457;
const ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_DIR = __dirname;
const PANEL_JS = path.join(ROOT, 'apps', 'claude-code', 'ui', 'panel.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  let filePath;
  if (url.pathname === '/' || url.pathname === '/index.html') {
    filePath = path.join(HARNESS_DIR, 'claude-code-panel.html');
  } else if (url.pathname === '/panel.js') {
    filePath = PANEL_JS;
  } else {
    // Serve from harness dir
    filePath = path.join(HARNESS_DIR, url.pathname);
  }

  // Security: ensure we stay within allowed directories
  if (!filePath.startsWith(HARNESS_DIR) && filePath !== PANEL_JS) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Test harness server listening on http://localhost:${PORT}`);
});
