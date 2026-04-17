/**
 * project-manager database layer (SQLite via better-sqlite3).
 *
 * TENANT ISOLATION INVARIANT
 * --------------------------
 * This module is single-tenant by design. There is NO `tenant_id`, `user_id`,
 * or `instance_id` column on any table; every row in this database belongs
 * to the workspace instance that owns the database file.
 *
 * Isolation is enforced at the filesystem layer by the bridge:
 *   - The bridge assigns each installed app instance a unique `APP_DATA_DIR`
 *     under `~/apps/<identifier>/<instance_name>/data/`.
 *   - Each workspace container runs as its own Docker/ECS task, so two
 *     workspaces cannot share a filesystem.
 *   - The bridge sets `APP_DATA_DIR` per pm2 process and never crosses it.
 *
 * If project-manager is ever installed in a multi-tenant mode (shared
 * filesystem, single sqlite file), schema must gain `tenant_id` columns on
 * every table + WHERE-clause filtering on every query. Until that happens,
 * any caller that can reach this process can read/write everything here —
 * HTTP-layer `authenticate()` in server.js is the only access boundary.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db;

function escapeLike(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function init(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','closed')),
      goals TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog','todo','in_progress','review','done')),
      priority TEXT NOT NULL DEFAULT 'P2' CHECK(priority IN ('P0','P1','P2','P3')),
      assignee TEXT DEFAULT '',
      labels TEXT DEFAULT '[]',
      due_date TEXT,
      story_points INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS team (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      capacity_per_sprint INTEGER DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
    CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id);
  `);

  return db;
}

// ── Projects ────────────────────────────────────────────────────────────

export function listProjects() {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM sprints WHERE project_id = p.id) as sprint_count
    FROM projects p ORDER BY created_at DESC
  `).all();
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function createProject({ name, description = '' }) {
  const id = randomUUID();
  db.prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)').run(id, name, description);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function updateProject(id, data) {
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(data)) {
    if (['name', 'description'].includes(k)) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (!fields.length) return getProject(id);
  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getProject(id);
}

export function deleteProject(id) {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

// ── Tasks ───────────────────────────────────────────────────────────────

const TASK_COLS = ['title', 'description', 'status', 'priority', 'assignee', 'labels', 'due_date', 'story_points', 'sprint_id'];

export function listTasks(projectId, filters = {}) {
  let sql = 'SELECT * FROM tasks WHERE project_id = ?';
  const params = [projectId];

  if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
  if (filters.assignee) { sql += ' AND assignee = ?'; params.push(filters.assignee); }
  if (filters.sprint_id) { sql += ' AND sprint_id = ?'; params.push(filters.sprint_id); }
  if (filters.priority) { sql += ' AND priority = ?'; params.push(filters.priority); }
  if (filters.search) { sql += " AND title LIKE ? ESCAPE '\\'"; params.push(`%${escapeLike(filters.search)}%`); }

  sql += ' ORDER BY priority ASC, created_at DESC';
  return db.prepare(sql).all(...params);
}

export function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function createTask(projectId, data) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const task = {
    id, project_id: projectId,
    title: data.title || 'Untitled',
    description: data.description || '',
    status: data.status || 'backlog',
    priority: data.priority || 'P2',
    assignee: data.assignee || '',
    labels: data.labels || '[]',
    due_date: data.due_date || null,
    story_points: data.story_points || 0,
    sprint_id: data.sprint_id || null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, status, priority, assignee, labels, due_date, story_points, sprint_id, created_at, updated_at)
    VALUES (@id, @project_id, @title, @description, @status, @priority, @assignee, @labels, @due_date, @story_points, @sprint_id, @created_at, @updated_at)
  `).run(task);
  return task;
}

export function updateTask(id, data) {
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(data)) {
    if (TASK_COLS.includes(k)) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (!fields.length) return getTask(id);
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTask(id);
}

export function deleteTask(id) {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
}

export function moveTask(id, status) {
  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  return getTask(id);
}

// ── Sprints ─────────────────────────────────────────────────────────────

export function listSprints(projectId) {
  return db.prepare('SELECT * FROM sprints WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
}

export function getSprint(id) {
  return db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
}

export function createSprint(projectId, data) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO sprints (id, project_id, name, start_date, end_date, status, goals)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, data.name || 'Sprint', data.start_date || null, data.end_date || null, 'planned', data.goals || '');
  return getSprint(id);
}

export function updateSprint(id, data) {
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(data)) {
    if (['name', 'start_date', 'end_date', 'goals'].includes(k)) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (!fields.length) return getSprint(id);
  values.push(id);
  db.prepare(`UPDATE sprints SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getSprint(id);
}

export function activateSprint(id) {
  const sprint = getSprint(id);
  if (!sprint) return null;
  if (sprint.status === 'active') return sprint;
  const run = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM sprints WHERE project_id = ? AND status = 'active' AND id != ?").get(sprint.project_id, id);
    if (existing) return { error: 'Another sprint is already active. Close it first.' };
    db.prepare('UPDATE sprints SET status = ? WHERE id = ?').run('active', id);
    return getSprint(id);
  });
  return run();
}

export function closeSprint(id) {
  const sprint = getSprint(id);
  if (!sprint) return null;
  if (sprint.status !== 'active') return { error: 'Only active sprints can be closed' };

  const run = db.transaction(() => {
    db.prepare('UPDATE sprints SET status = ? WHERE id = ?').run('closed', id);

    const incompleteTasks = db.prepare(
      "SELECT * FROM tasks WHERE sprint_id = ? AND status != 'done'"
    ).all(id);

    const nextSprint = db.prepare(
      "SELECT id FROM sprints WHERE project_id = ? AND status = 'planned' ORDER BY created_at ASC LIMIT 1"
    ).get(sprint.project_id);

    const movedTo = nextSprint ? nextSprint.id : null;
    if (incompleteTasks.length) {
      db.prepare('UPDATE tasks SET sprint_id = ? WHERE sprint_id = ? AND status != ?').run(movedTo, id, 'done');
    }

    const completedCount = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE sprint_id = ? AND status = 'done'").get(id).c;
    const totalPoints = db.prepare("SELECT COALESCE(SUM(story_points), 0) as s FROM tasks WHERE sprint_id = ? AND status = 'done'").get(id).s;

    return {
      sprint: getSprint(id),
      completed: completedCount,
      incomplete: incompleteTasks.length,
      moved_to: movedTo ? 'next sprint' : 'backlog',
      velocity: totalPoints,
    };
  });
  return run();
}

export function deleteSprint(id) {
  return db.prepare('DELETE FROM sprints WHERE id = ?').run(id).changes > 0;
}

// ── Team ────────────────────────────────────────────────────────────────

export function listTeam() {
  return db.prepare('SELECT * FROM team ORDER BY name ASC').all();
}

export function getTeamMember(id) {
  return db.prepare('SELECT * FROM team WHERE id = ?').get(id);
}

export function addTeamMember({ name, email, capacity_per_sprint = 10 }) {
  const id = randomUUID();
  db.prepare('INSERT INTO team (id, name, email, capacity_per_sprint) VALUES (?, ?, ?, ?)').run(id, name, email, capacity_per_sprint);
  return db.prepare('SELECT * FROM team WHERE id = ?').get(id);
}

export function updateTeamMember(id, data) {
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(data)) {
    if (['name', 'email', 'capacity_per_sprint'].includes(k)) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
  }
  if (!fields.length) return getTeamMember(id);
  values.push(id);
  db.prepare(`UPDATE team SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTeamMember(id);
}

export function removeTeamMember(id) {
  return db.prepare('DELETE FROM team WHERE id = ?').run(id).changes > 0;
}

// ── Aggregate views ─────────────────────────────────────────────────────

export function boardView(projectId) {
  const activeSprint = db.prepare(
    "SELECT * FROM sprints WHERE project_id = ? AND status = 'active' LIMIT 1"
  ).get(projectId);

  let tasks;
  if (activeSprint) {
    tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND sprint_id = ? ORDER BY priority ASC').all(projectId, activeSprint.id);
  } else {
    tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC').all(projectId);
  }

  const columns = { backlog: [], todo: [], in_progress: [], review: [], done: [] };
  for (const t of tasks) columns[t.status].push(t);

  return { sprint: activeSprint, columns, total: tasks.length };
}

export function capacityView(sprintId) {
  const sprint = getSprint(sprintId);
  if (!sprint) return null;

  const tasks = db.prepare('SELECT assignee, status, story_points FROM tasks WHERE sprint_id = ?').all(sprintId);
  const members = listTeam();

  const byAssignee = {};
  for (const t of tasks) {
    const a = (t.assignee || '').toLowerCase() || '(unassigned)';
    if (!byAssignee[a]) byAssignee[a] = { allocated: 0, completed: 0, tasks: 0 };
    byAssignee[a].allocated += t.story_points;
    byAssignee[a].tasks++;
    if (t.status === 'done') byAssignee[a].completed += t.story_points;
  }

  const matchedKeys = new Set();
  const capacity = members.map(m => {
    const nameKey = m.name.toLowerCase();
    const emailKey = m.email.toLowerCase();
    const stats = byAssignee[nameKey] || byAssignee[emailKey] || { allocated: 0, completed: 0, tasks: 0 };
    if (byAssignee[nameKey]) matchedKeys.add(nameKey);
    if (byAssignee[emailKey]) matchedKeys.add(emailKey);
    return {
      ...m,
      allocated: stats.allocated,
      completed: stats.completed,
      task_count: stats.tasks,
      utilization: m.capacity_per_sprint > 0 ? Math.round((stats.allocated / m.capacity_per_sprint) * 100) : 0,
      over_allocated: stats.allocated > m.capacity_per_sprint,
    };
  });

  const unassignedStats = byAssignee['(unassigned)'];
  if (unassignedStats) {
    capacity.push({ id: null, name: '(Unassigned)', email: '', capacity_per_sprint: 0, ...unassignedStats, utilization: 0, over_allocated: false });
  }

  const totalAllocated = tasks.reduce((s, t) => s + t.story_points, 0);
  const totalCompleted = tasks.filter(t => t.status === 'done').reduce((s, t) => s + t.story_points, 0);
  const totalCapacity = members.reduce((s, m) => s + m.capacity_per_sprint, 0);

  return {
    sprint,
    capacity,
    summary: {
      total_points: totalAllocated,
      completed_points: totalCompleted,
      total_capacity: totalCapacity,
      utilization: totalCapacity > 0 ? Math.round((totalAllocated / totalCapacity) * 100) : 0,
    },
  };
}

export function standupView(projectId) {
  const yesterday = new Date(Date.now() - 86400000).toISOString();

  const recentlyDone = db.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND status = 'done' AND updated_at > ? ORDER BY assignee"
  ).all(projectId, yesterday);

  const inProgress = db.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND status = 'in_progress' ORDER BY assignee"
  ).all(projectId);

  const blockers = db.prepare(`
    SELECT * FROM tasks WHERE project_id = ? AND status IN ('in_progress', 'review')
    AND updated_at < datetime('now', '-3 days') ORDER BY updated_at ASC
  `).all(projectId);

  const activeSprint = db.prepare(
    "SELECT * FROM sprints WHERE project_id = ? AND status = 'active' LIMIT 1"
  ).get(projectId);

  return { recently_done: recentlyDone, in_progress: inProgress, blockers, sprint: activeSprint };
}

export function burndownView(sprintId) {
  const sprint = getSprint(sprintId);
  if (!sprint) return null;
  if (!sprint.start_date) return { sprint, error: 'Sprint has no start_date', days: [] };

  const tasks = db.prepare('SELECT story_points, status, updated_at FROM tasks WHERE sprint_id = ?').all(sprintId);
  const totalPoints = tasks.reduce((s, t) => s + t.story_points, 0);

  const start = new Date(sprint.start_date);
  const end = sprint.end_date ? new Date(sprint.end_date) : new Date();
  const today = new Date();
  const stopDate = today < end ? today : end;

  const days = [];
  for (let d = new Date(start); d <= stopDate; d.setDate(d.getDate() + 1)) {
    const dayStr = d.toISOString().slice(0, 10);
    const completedByDay = tasks.filter(t => t.status === 'done' && t.updated_at && t.updated_at.slice(0, 10) <= dayStr)
      .reduce((s, t) => s + t.story_points, 0);
    days.push({ date: dayStr, remaining: totalPoints - completedByDay, completed: completedByDay });
  }

  return { sprint, total_points: totalPoints, days };
}

export function velocityHistory(projectId, count = 5) {
  const closedSprints = db.prepare(
    "SELECT * FROM sprints WHERE project_id = ? AND status = 'closed' ORDER BY created_at DESC LIMIT ?"
  ).all(projectId, count);

  return closedSprints.map(s => {
    const points = db.prepare(
      "SELECT COALESCE(SUM(story_points), 0) as v FROM tasks WHERE sprint_id = ? AND status = 'done'"
    ).get(s.id).v;
    const totalTasks = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE sprint_id = ?').get(s.id).c;
    const doneTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE sprint_id = ? AND status = 'done'").get(s.id).c;
    return { sprint_id: s.id, name: s.name, start_date: s.start_date, end_date: s.end_date, velocity: points, tasks_total: totalTasks, tasks_done: doneTasks };
  }).reverse();
}

export function searchTasks(query, projectId = null) {
  const pattern = `%${escapeLike(query)}%`;
  const esc = " ESCAPE '\\'";
  if (projectId) {
    return db.prepare(
      `SELECT * FROM tasks WHERE project_id = ? AND (title LIKE ?${esc} OR description LIKE ?${esc}) ORDER BY priority ASC, updated_at DESC`
    ).all(projectId, pattern, pattern);
  }
  return db.prepare(
    `SELECT * FROM tasks WHERE title LIKE ?${esc} OR description LIKE ?${esc} ORDER BY priority ASC, updated_at DESC`
  ).all(pattern, pattern);
}

export function bulkMoveTasks(taskIds, status) {
  const run = db.transaction(() => {
    const now = new Date().toISOString();
    const stmt = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?');
    let moved = 0;
    for (const id of taskIds) {
      moved += stmt.run(status, now, id).changes;
    }
    return { moved, total: taskIds.length };
  });
  return run();
}

export function bulkAssignTasks(taskIds, assignee) {
  const run = db.transaction(() => {
    const now = new Date().toISOString();
    const stmt = db.prepare('UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?');
    let assigned = 0;
    for (const id of taskIds) {
      assigned += stmt.run(assignee, now, id).changes;
    }
    return { assigned, total: taskIds.length };
  });
  return run();
}
