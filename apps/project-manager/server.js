import http from 'node:http';
import { URL } from 'node:url';
import { join } from 'node:path';
import * as db from './db.js';

const PORT = parseInt(process.env.APP_PORT ?? '3462', 10);
const DATA_DIR = process.env.APP_DATA_DIR ?? './data';
const DB_PATH = join(DATA_DIR, 'project-manager.db');
const BRIDGE_TOKEN = process.env.APP_BRIDGE_TOKEN || '';

db.init(DB_PATH);

// ── CORS ─────────────────────────────────────────────────────────────────
//
// Restrict CORS to known bridge/iframe origins. A wildcard `*` would let
// any site on the internet fire no-credentials fetches against the API;
// while APP_BRIDGE_TOKEN auth prevents reads, a wildcard is still an
// information leak (404 vs 200 patterns, etc.) and signals to operators
// that we don't care about browser boundaries. Matches the token-market
// allowlist pattern.
const ALLOWED_ORIGINS = [
  /^https:\/\/([a-z0-9-]+\.)?xaiworkspace\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)?xshopper\.com$/i,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function pickAllowedOrigin(origin) {
  if (!origin) return null;
  return ALLOWED_ORIGINS.some((re) => re.test(origin)) ? origin : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const MAX_BODY = 1024 * 1024; // 1 MB
const VALID_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'review', 'done']);
const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

/** Returns true if auth passes; sends 401 and returns false otherwise. */
function authenticate(req, res) {
  if (BRIDGE_TOKEN && req.headers['x-app-bridge-token'] !== BRIDGE_TOKEN) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** Apply CORS headers to the response based on the request's Origin. */
function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowed = pickAllowedOrigin(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-app-bridge-token');
  }
  return !!allowed;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function jsonBody(req) {
  try { return JSON.parse(await readBody(req)); }
  catch { return null; }
}

function json(res, status, data) {
  // CORS headers are applied up-front by applyCors() during the request;
  // here we only set Content-Type (writeHead merges with previously-set
  // headers via setHeader).
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function match(method, pathname, pattern) {
  if (method !== pattern.method) return null;
  const pParts = pattern.path.split('/');
  const uParts = pathname.split('/');
  if (pParts.length !== uParts.length) return null;
  const params = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = uParts[i];
    else if (pParts[i] !== uParts[i]) return null;
  }
  return params;
}

// ── MCP Tool dispatch ───────────────────────────────────────────────────

const mcpTools = {
  // Discovery & overview
  list_projects: () => db.listProjects(),
  board_view: (args) => db.boardView(args.project_id),
  standup: (args) => db.standupView(args.project_id),
  sprint_report: (args) => db.capacityView(args.sprint_id),
  burndown: (args) => db.burndownView(args.sprint_id),
  velocity_history: (args) => db.velocityHistory(args.project_id, args.count),
  search_tasks: (args) => db.searchTasks(args.query, args.project_id),

  // Task CRUD
  create_task: (args) => db.createTask(args.project_id, args),
  update_task: (args) => db.updateTask(args.task_id, args),
  move_task: (args) => {
    if (!VALID_STATUSES.has(args.status)) return { error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}` };
    return db.moveTask(args.task_id, args.status);
  },
  delete_task: (args) => db.deleteTask(args.task_id),
  list_tasks: (args) => db.listTasks(args.project_id, { status: args.status, assignee: args.assignee, sprint_id: args.sprint_id, priority: args.priority, search: args.search }),
  bulk_move_tasks: (args) => {
    if (!VALID_STATUSES.has(args.status)) return { error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}` };
    return db.bulkMoveTasks(args.task_ids, args.status);
  },
  bulk_assign_tasks: (args) => db.bulkAssignTasks(args.task_ids, args.assignee),

  // Project CRUD
  create_project: (args) => db.createProject(args),
  delete_project: (args) => db.deleteProject(args.project_id),

  // Sprint lifecycle
  create_sprint: (args) => db.createSprint(args.project_id, args),
  activate_sprint: (args) => db.activateSprint(args.sprint_id),
  close_sprint: (args) => db.closeSprint(args.sprint_id),

  // Team
  list_team: () => db.listTeam(),
  add_team_member: (args) => db.addTeamMember(args),
  update_team_member: (args) => db.updateTeamMember(args.member_id, args),
  remove_team_member: (args) => db.removeTeamMember(args.member_id),
};

// ── Route handler ───────────────────────────────────────────────────────

async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const method = req.method;

  const allowedOrigin = applyCors(req, res);

  if (method === 'OPTIONS') {
    // Deny preflight from origins not in the allowlist — reflecting an
    // arbitrary Origin back would defeat the allowlist.
    res.writeHead(allowedOrigin ? 204 : 403);
    res.end();
    return;
  }

  try {
    // Health
    if (method === 'GET' && pathname === '/health') {
      return json(res, 200, { status: 'ok', uptime: process.uptime() });
    }

    // MCP tools
    let p = match(method, pathname, { method: 'POST', path: '/mcp/tools/:tool' });
    if (p) {
      if (!authenticate(req, res)) return;
      const fn = mcpTools[p.tool];
      if (!fn) return json(res, 404, { error: `Unknown tool: ${p.tool}` });
      const args = await jsonBody(req) || {};
      return json(res, 200, { result: fn(args) });
    }

    // ── Projects ──────────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/projects') {
      if (!authenticate(req, res)) return;
      return json(res, 200, { projects: db.listProjects() });
    }

    if (method === 'POST' && pathname === '/api/projects') {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      if (!body?.name) return json(res, 400, { error: 'name required' });
      return json(res, 201, db.createProject(body));
    }

    p = match(method, pathname, { method: 'PUT', path: '/api/projects/:id' });
    if (p) {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      const project = db.updateProject(p.id, body || {});
      return project ? json(res, 200, project) : json(res, 404, { error: 'Not found' });
    }

    p = match(method, pathname, { method: 'DELETE', path: '/api/projects/:id' });
    if (p) {
      if (!authenticate(req, res)) return;
      return db.deleteProject(p.id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
    }

    // ── Tasks ─────────────────────────────────────────────────────────

    p = match(method, pathname, { method: 'GET', path: '/api/projects/:pid/tasks' });
    if (p) {
      if (!authenticate(req, res)) return;
      if (!db.getProject(p.pid)) return json(res, 404, { error: 'Project not found' });
      const filters = {};
      for (const [k, v] of url.searchParams) {
        if (['status', 'assignee', 'sprint_id', 'priority', 'search'].includes(k)) filters[k] = v;
      }
      return json(res, 200, { tasks: db.listTasks(p.pid, filters) });
    }

    p = match(method, pathname, { method: 'POST', path: '/api/projects/:pid/tasks' });
    if (p) {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      if (!body?.title) return json(res, 400, { error: 'title required' });
      if (body.status && !VALID_STATUSES.has(body.status)) return json(res, 400, { error: 'Invalid status' });
      if (body.priority && !VALID_PRIORITIES.has(body.priority)) return json(res, 400, { error: 'Invalid priority' });
      return json(res, 201, db.createTask(p.pid, body));
    }

    p = match(method, pathname, { method: 'PUT', path: '/api/tasks/:id' });
    if (p) {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      const task = db.updateTask(p.id, body || {});
      return task ? json(res, 200, task) : json(res, 404, { error: 'Not found' });
    }

    p = match(method, pathname, { method: 'DELETE', path: '/api/tasks/:id' });
    if (p) {
      if (!authenticate(req, res)) return;
      return db.deleteTask(p.id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
    }

    p = match(method, pathname, { method: 'POST', path: '/api/tasks/:id/move' });
    if (p) {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      if (!body?.status) return json(res, 400, { error: 'status required' });
      if (!VALID_STATUSES.has(body.status)) return json(res, 400, { error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}` });
      const task = db.moveTask(p.id, body.status);
      return task ? json(res, 200, task) : json(res, 404, { error: 'Not found' });
    }

    // ── Sprints ───────────────────────────────────────────────────────

    p = match(method, pathname, { method: 'GET', path: '/api/projects/:pid/sprints' });
    if (p) {
      if (!authenticate(req, res)) return;
      return json(res, 200, { sprints: db.listSprints(p.pid) });
    }

    p = match(method, pathname, { method: 'POST', path: '/api/projects/:pid/sprints' });
    if (p) {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      if (!body?.name) return json(res, 400, { error: 'name required' });
      return json(res, 201, db.createSprint(p.pid, body));
    }

    p = match(method, pathname, { method: 'PUT', path: '/api/sprints/:id' });
    if (p) {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      const sprint = db.updateSprint(p.id, body || {});
      return sprint ? json(res, 200, sprint) : json(res, 404, { error: 'Not found' });
    }

    p = match(method, pathname, { method: 'DELETE', path: '/api/sprints/:id' });
    if (p) {
      if (!authenticate(req, res)) return;
      const sprint = db.getSprint(p.id);
      if (!sprint) return json(res, 404, { error: 'Not found' });
      if (sprint.status === 'active') return json(res, 400, { error: 'Cannot delete active sprint. Close it first.' });
      return db.deleteSprint(p.id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
    }

    p = match(method, pathname, { method: 'POST', path: '/api/sprints/:id/activate' });
    if (p) {
      if (!authenticate(req, res)) return;
      const result = db.activateSprint(p.id);
      if (!result) return json(res, 404, { error: 'Not found' });
      if (result.error) return json(res, 400, { error: result.error });
      return json(res, 200, result);
    }

    p = match(method, pathname, { method: 'POST', path: '/api/sprints/:id/close' });
    if (p) {
      if (!authenticate(req, res)) return;
      const result = db.closeSprint(p.id);
      if (!result) return json(res, 404, { error: 'Not found' });
      if (result.error) return json(res, 400, { error: result.error });
      return json(res, 200, result);
    }

    // ── Team ──────────────────────────────────────────────────────────

    if (method === 'GET' && pathname === '/api/team') {
      if (!authenticate(req, res)) return;
      return json(res, 200, { team: db.listTeam() });
    }

    if (method === 'POST' && pathname === '/api/team') {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      if (!body?.name || !body?.email) return json(res, 400, { error: 'name and email required' });
      return json(res, 201, db.addTeamMember(body));
    }

    p = match(method, pathname, { method: 'PUT', path: '/api/team/:id' });
    if (p) {
      if (!authenticate(req, res)) return;
      const body = await jsonBody(req);
      const member = db.updateTeamMember(p.id, body || {});
      return member ? json(res, 200, member) : json(res, 404, { error: 'Not found' });
    }

    p = match(method, pathname, { method: 'DELETE', path: '/api/team/:id' });
    if (p) {
      if (!authenticate(req, res)) return;
      return db.removeTeamMember(p.id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
    }

    // ── Aggregate views ───────────────────────────────────────────────

    p = match(method, pathname, { method: 'GET', path: '/api/board/:project_id' });
    if (p) {
      if (!authenticate(req, res)) return;
      return json(res, 200, db.boardView(p.project_id));
    }

    p = match(method, pathname, { method: 'GET', path: '/api/capacity/:sprint_id' });
    if (p) {
      if (!authenticate(req, res)) return;
      const data = db.capacityView(p.sprint_id);
      return data ? json(res, 200, data) : json(res, 404, { error: 'Sprint not found' });
    }

    p = match(method, pathname, { method: 'GET', path: '/api/standup/:project_id' });
    if (p) {
      if (!authenticate(req, res)) return;
      return json(res, 200, db.standupView(p.project_id));
    }

    p = match(method, pathname, { method: 'GET', path: '/api/burndown/:sprint_id' });
    if (p) {
      if (!authenticate(req, res)) return;
      const data = db.burndownView(p.sprint_id);
      return data ? json(res, 200, data) : json(res, 404, { error: 'Sprint not found' });
    }

    p = match(method, pathname, { method: 'GET', path: '/api/velocity/:project_id' });
    if (p) {
      if (!authenticate(req, res)) return;
      const count = parseInt(url.searchParams.get('count') || '5', 10);
      return json(res, 200, { sprints: db.velocityHistory(p.project_id, count) });
    }

    if (method === 'GET' && pathname === '/api/search') {
      if (!authenticate(req, res)) return;
      const query = url.searchParams.get('q');
      const projectId = url.searchParams.get('project_id');
      if (!query) return json(res, 400, { error: 'q parameter required' });
      return json(res, 200, { tasks: db.searchTasks(query, projectId) });
    }

    // 404
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[project-manager]', err);
    json(res, 500, { error: 'Internal server error' });
  }
}

// ── Start ────────────────────────────────────────────────────────────────

const server = http.createServer(handler);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[project-manager] listening on http://127.0.0.1:${PORT}`);
  console.log(`[project-manager] database: ${DB_PATH}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
//
// Close the SQLite database (better-sqlite3 keeps a file handle open and
// the WAL file will not be checkpointed unless we close cleanly) and
// shut down the HTTP server before pm2 SIGKILLs us.
let _shuttingDown = false;
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[project-manager] ${signal} — shutting down`);
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch { /* ignore */ }
  server.close(() => {
    try { db.close(); } catch (err) { console.warn('[project-manager] db.close error:', err.message); }
    process.exit(0);
  });
  setTimeout(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  }, 4000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
