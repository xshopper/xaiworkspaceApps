import * as api from './api';
import type { PanelState, Task, TabKey } from './types';

const STATUSES: Task['status'][] = ['backlog', 'todo', 'in_progress', 'review', 'done'];
const STATUS_LABELS: Record<string, string> = {
  backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done',
};
const PRIORITY_COLORS: Record<string, string> = { P0: '#ef4444', P1: '#f97316', P2: '#eab308', P3: '#3b82f6' };
const TABS: { key: TabKey; label: string }[] = [
  { key: 'board', label: 'Board' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'sprints', label: 'Sprints' },
  { key: 'team', label: 'Team' },
  { key: 'projects', label: 'Projects' },
];

const state: PanelState = {
  loading: true, error: null, success: null,
  activeTab: 'board', currentProjectId: null,
  projects: [], board: null, tasks: [], sprints: [], team: [],
  showNewTaskForm: false, showNewProjectForm: false, showNewSprintForm: false, showNewMemberForm: false,
  editingTaskId: null, filterStatus: '', filterAssignee: '', filterPriority: '',
};

// ── CSS ──────────────────────────────────────────────────────────────────

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #e0e0e0; background: #1a1a2e; }
.container { padding: 12px; }

.project-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding: 8px 12px; background: #16213e; border-radius: 6px; }
.project-bar select { flex: 1; background: #0f3460; color: #e0e0e0; border: 1px solid #333; border-radius: 4px; padding: 4px 8px; font-size: 13px; }
.project-bar .project-name { font-weight: 600; color: #4fc3f7; }

.tab-bar { display: flex; gap: 2px; margin-bottom: 12px; border-bottom: 1px solid #333; }
.tab { padding: 8px 14px; background: none; border: none; color: #999; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; }
.tab:hover { color: #ccc; }
.tab-active { color: #4fc3f7; border-bottom-color: #4fc3f7; }

.board { display: flex; gap: 8px; overflow-x: auto; min-height: 300px; }
.board-col { flex: 1; min-width: 160px; background: #16213e; border-radius: 6px; padding: 8px; }
.board-col-header { font-size: 12px; font-weight: 600; color: #999; text-transform: uppercase; margin-bottom: 8px; display: flex; justify-content: space-between; }
.board-col-count { background: #0f3460; color: #4fc3f7; padding: 1px 6px; border-radius: 10px; font-size: 11px; }

.card { background: #1a1a2e; border: 1px solid #333; border-radius: 4px; padding: 8px; margin-bottom: 6px; cursor: default; }
.card:hover { border-color: #4fc3f7; }
.card-title { font-size: 13px; font-weight: 500; margin-bottom: 4px; }
.card-meta { display: flex; gap: 6px; align-items: center; font-size: 11px; color: #888; flex-wrap: wrap; }
.card-actions { display: flex; gap: 4px; margin-top: 6px; }

.priority-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 700; color: #fff; }
.points-badge { background: #0f3460; color: #4fc3f7; padding: 1px 5px; border-radius: 3px; font-size: 10px; }
.assignee-badge { color: #a78bfa; }

.btn { padding: 4px 8px; border: 1px solid #444; border-radius: 4px; background: #16213e; color: #ccc; cursor: pointer; font-size: 11px; }
.btn:hover { background: #0f3460; color: #fff; }
.btn-primary { background: #0f3460; color: #4fc3f7; border-color: #4fc3f7; }
.btn-primary:hover { background: #4fc3f7; color: #1a1a2e; }
.btn-danger { border-color: #ef4444; color: #ef4444; }
.btn-danger:hover { background: #ef4444; color: #fff; }
.btn-sm { padding: 2px 6px; font-size: 10px; }

.form { background: #16213e; border: 1px solid #333; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
.form-row { margin-bottom: 8px; }
.form-row label { display: block; font-size: 11px; color: #999; margin-bottom: 2px; }
.form-row input, .form-row select, .form-row textarea { width: 100%; background: #0f3460; color: #e0e0e0; border: 1px solid #444; border-radius: 4px; padding: 6px 8px; font-size: 13px; }
.form-row textarea { min-height: 60px; resize: vertical; }
.form-actions { display: flex; gap: 6px; margin-top: 8px; }

.table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #333; }
.table th { font-size: 11px; color: #999; text-transform: uppercase; }
.table tr:hover { background: #16213e; }

.filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.filters select { background: #0f3460; color: #e0e0e0; border: 1px solid #444; border-radius: 4px; padding: 4px 8px; font-size: 12px; }

.capacity-bar { height: 8px; background: #333; border-radius: 4px; overflow: hidden; margin: 4px 0; }
.capacity-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
.capacity-ok { background: #22c55e; }
.capacity-warn { background: #eab308; }
.capacity-over { background: #ef4444; }

.sprint-card { background: #16213e; border: 1px solid #333; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
.sprint-card.active { border-color: #22c55e; }
.sprint-status { font-size: 10px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; font-weight: 600; }
.sprint-status.planned { background: #333; color: #999; }
.sprint-status.active { background: #166534; color: #22c55e; }
.sprint-status.closed { background: #1e1e1e; color: #666; }

.empty { text-align: center; color: #666; padding: 40px 20px; }
.loading { text-align: center; color: #4fc3f7; padding: 40px; }
.error { background: #3b1111; color: #ef4444; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; }
.success { background: #0a2e14; color: #22c55e; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px; }
.header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
`;

// ── Renderers ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderProjectBar(): string {
  if (!state.projects.length) return '';
  const opts = state.projects.map(p =>
    `<option value="${p.id}" ${p.id === state.currentProjectId ? 'selected' : ''}>${esc(p.name)} (${p.task_count ?? 0} tasks)</option>`
  ).join('');
  return `<div class="project-bar"><span class="project-name">Project:</span><select data-action="switch-project">${opts}</select></div>`;
}

function renderTabBar(): string {
  return `<div class="tab-bar">${TABS.map(t =>
    `<button class="tab ${t.key === state.activeTab ? 'tab-active' : ''}" data-tab="${t.key}">${t.label}</button>`
  ).join('')}</div>`;
}

function priorityBadge(p: string): string {
  return `<span class="priority-badge" style="background:${PRIORITY_COLORS[p] || '#666'}">${p}</span>`;
}

function renderTaskCard(t: Task): string {
  const idx = STATUSES.indexOf(t.status);
  const canLeft = idx > 0;
  const canRight = idx < STATUSES.length - 1;
  return `
    <div class="card" data-task-id="${t.id}">
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-meta">
        ${priorityBadge(t.priority)}
        ${t.story_points ? `<span class="points-badge">${t.story_points}pt</span>` : ''}
        ${t.assignee ? `<span class="assignee-badge">${esc(t.assignee)}</span>` : ''}
        ${t.due_date ? `<span>Due ${t.due_date}</span>` : ''}
      </div>
      <div class="card-actions">
        ${canLeft ? `<button class="btn btn-sm" data-action="move-left" data-id="${t.id}" data-status="${STATUSES[idx - 1]}">&#9664;</button>` : ''}
        ${canRight ? `<button class="btn btn-sm" data-action="move-right" data-id="${t.id}" data-status="${STATUSES[idx + 1]}">&#9654;</button>` : ''}
        <button class="btn btn-sm" data-action="edit-task" data-id="${t.id}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="delete-task" data-id="${t.id}">&times;</button>
      </div>
    </div>`;
}

function renderBoardTab(): string {
  if (!state.board) return '<div class="empty">No project selected</div>';
  const { columns, sprint, total } = state.board;
  const sprintInfo = sprint ? `<span style="color:#22c55e">Sprint: ${esc(sprint.name)}</span>` : '<span style="color:#999">No active sprint</span>';
  return `
    <div class="header-row">
      <div>${sprintInfo} &middot; ${total} tasks</div>
      <button class="btn btn-primary" data-action="show-new-task">+ Task</button>
    </div>
    ${state.showNewTaskForm ? renderNewTaskForm() : ''}
    ${state.editingTaskId ? renderEditTaskForm() : ''}
    <div class="board">
      ${STATUSES.map(s => `
        <div class="board-col">
          <div class="board-col-header">${STATUS_LABELS[s]} <span class="board-col-count">${columns[s]?.length ?? 0}</span></div>
          ${(columns[s] || []).map(renderTaskCard).join('')}
        </div>`).join('')}
    </div>`;
}

function renderNewTaskForm(): string {
  const sprintOpts = state.sprints
    .filter(s => s.status !== 'closed')
    .map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  return `
    <div class="form">
      <div class="form-row"><label>Title</label><input id="new-title" placeholder="Task title" /></div>
      <div class="form-row"><label>Description</label><textarea id="new-desc" placeholder="Details..."></textarea></div>
      <div style="display:flex;gap:8px">
        <div class="form-row" style="flex:1"><label>Priority</label>
          <select id="new-priority"><option value="P0">P0 Critical</option><option value="P1">P1 High</option><option value="P2" selected>P2 Medium</option><option value="P3">P3 Low</option></select>
        </div>
        <div class="form-row" style="flex:1"><label>Points</label><input id="new-points" type="number" value="0" min="0" /></div>
        <div class="form-row" style="flex:1"><label>Assignee</label><input id="new-assignee" placeholder="Name" /></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-row" style="flex:1"><label>Sprint</label><select id="new-sprint"><option value="">None</option>${sprintOpts}</select></div>
        <div class="form-row" style="flex:1"><label>Due Date</label><input id="new-due" type="date" /></div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" data-action="create-task">Create</button>
        <button class="btn" data-action="cancel-new-task">Cancel</button>
      </div>
    </div>`;
}

function renderEditTaskForm(): string {
  const t = state.tasks.find(t => t.id === state.editingTaskId) ||
            (state.board ? Object.values(state.board.columns).flat().find(t => t.id === state.editingTaskId) : null);
  if (!t) return '';
  const sprintOpts = state.sprints.filter(s => s.status !== 'closed')
    .map(s => `<option value="${s.id}" ${s.id === t.sprint_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  return `
    <div class="form">
      <div class="form-row"><label>Title</label><input id="edit-title" value="${esc(t.title)}" /></div>
      <div class="form-row"><label>Description</label><textarea id="edit-desc">${esc(t.description)}</textarea></div>
      <div style="display:flex;gap:8px">
        <div class="form-row" style="flex:1"><label>Status</label>
          <select id="edit-status">${STATUSES.map(s => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}</select>
        </div>
        <div class="form-row" style="flex:1"><label>Priority</label>
          <select id="edit-priority">${['P0','P1','P2','P3'].map(p => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
        </div>
        <div class="form-row" style="flex:1"><label>Points</label><input id="edit-points" type="number" value="${t.story_points}" min="0" /></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="form-row" style="flex:1"><label>Assignee</label><input id="edit-assignee" value="${esc(t.assignee)}" /></div>
        <div class="form-row" style="flex:1"><label>Sprint</label><select id="edit-sprint"><option value="">None</option>${sprintOpts}</select></div>
        <div class="form-row" style="flex:1"><label>Due Date</label><input id="edit-due" type="date" value="${t.due_date || ''}" /></div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" data-action="save-task" data-id="${t.id}">Save</button>
        <button class="btn" data-action="cancel-edit">Cancel</button>
      </div>
    </div>`;
}

function renderBacklogTab(): string {
  if (!state.currentProjectId) return '<div class="empty">No project selected</div>';
  const assignees = [...new Set(state.tasks.map(t => t.assignee).filter(Boolean))];
  return `
    <div class="header-row">
      <div>All Tasks (${state.tasks.length})</div>
      <button class="btn btn-primary" data-action="show-new-task">+ Task</button>
    </div>
    <div class="filters">
      <select data-action="filter-status"><option value="">All Statuses</option>${STATUSES.map(s => `<option value="${s}" ${state.filterStatus === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}</select>
      <select data-action="filter-priority"><option value="">All Priorities</option>${['P0','P1','P2','P3'].map(p => `<option value="${p}" ${state.filterPriority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <select data-action="filter-assignee"><option value="">All Assignees</option>${assignees.map(a => `<option value="${a}" ${state.filterAssignee === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
    </div>
    ${state.showNewTaskForm ? renderNewTaskForm() : ''}
    ${state.editingTaskId ? renderEditTaskForm() : ''}
    ${state.tasks.length === 0 ? '<div class="empty">No tasks yet</div>' : `
    <table class="table">
      <thead><tr><th>Priority</th><th>Title</th><th>Status</th><th>Assignee</th><th>Points</th><th>Due</th><th></th></tr></thead>
      <tbody>
        ${state.tasks.map(t => `
          <tr>
            <td>${priorityBadge(t.priority)}</td>
            <td>${esc(t.title)}</td>
            <td>${STATUS_LABELS[t.status]}</td>
            <td>${esc(t.assignee) || '—'}</td>
            <td>${t.story_points || '—'}</td>
            <td>${t.due_date || '—'}</td>
            <td>
              <button class="btn btn-sm" data-action="edit-task" data-id="${t.id}">Edit</button>
              <button class="btn btn-sm btn-danger" data-action="delete-task" data-id="${t.id}">&times;</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`}`;
}

function renderSprintsTab(): string {
  if (!state.currentProjectId) return '<div class="empty">No project selected</div>';
  return `
    <div class="header-row">
      <div>Sprints (${state.sprints.length})</div>
      <button class="btn btn-primary" data-action="show-new-sprint">+ Sprint</button>
    </div>
    ${state.showNewSprintForm ? `
    <div class="form">
      <div class="form-row"><label>Name</label><input id="new-sprint-name" placeholder="Sprint 1" /></div>
      <div style="display:flex;gap:8px">
        <div class="form-row" style="flex:1"><label>Start</label><input id="new-sprint-start" type="date" /></div>
        <div class="form-row" style="flex:1"><label>End</label><input id="new-sprint-end" type="date" /></div>
      </div>
      <div class="form-row"><label>Goals</label><textarea id="new-sprint-goals" placeholder="Sprint goals..."></textarea></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-action="create-sprint">Create</button>
        <button class="btn" data-action="cancel-new-sprint">Cancel</button>
      </div>
    </div>` : ''}
    ${state.sprints.length === 0 ? '<div class="empty">No sprints</div>' : state.sprints.map(s => `
      <div class="sprint-card ${s.status === 'active' ? 'active' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <strong>${esc(s.name)}</strong>
          <span class="sprint-status ${s.status}">${s.status}</span>
        </div>
        ${s.start_date ? `<div style="font-size:11px;color:#888">${s.start_date} → ${s.end_date || '?'}</div>` : ''}
        ${s.goals ? `<div style="font-size:12px;color:#aaa;margin-top:4px">${esc(s.goals)}</div>` : ''}
        <div class="card-actions" style="margin-top:6px">
          ${s.status === 'planned' ? `<button class="btn btn-sm btn-primary" data-action="activate-sprint" data-id="${s.id}">Activate</button>` : ''}
          ${s.status === 'active' ? `<button class="btn btn-sm" data-action="close-sprint" data-id="${s.id}">Close</button>` : ''}
          ${s.status !== 'active' ? `<button class="btn btn-sm btn-danger" data-action="delete-sprint" data-id="${s.id}">&times;</button>` : ''}
        </div>
      </div>`).join('')}`;
}

function renderTeamTab(): string {
  return `
    <div class="header-row">
      <div>Team (${state.team.length})</div>
      <button class="btn btn-primary" data-action="show-new-member">+ Member</button>
    </div>
    ${state.showNewMemberForm ? `
    <div class="form">
      <div style="display:flex;gap:8px">
        <div class="form-row" style="flex:1"><label>Name</label><input id="new-member-name" placeholder="Alice" /></div>
        <div class="form-row" style="flex:1"><label>Email</label><input id="new-member-email" placeholder="alice@team.com" /></div>
        <div class="form-row" style="flex:1"><label>Capacity</label><input id="new-member-cap" type="number" value="10" min="1" /></div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" data-action="create-member">Add</button>
        <button class="btn" data-action="cancel-new-member">Cancel</button>
      </div>
    </div>` : ''}
    ${state.team.length === 0 ? '<div class="empty">No team members</div>' : `
    <table class="table">
      <thead><tr><th>Name</th><th>Email</th><th>Capacity</th><th>Allocated</th><th>Utilization</th><th></th></tr></thead>
      <tbody>
        ${state.team.map(m => {
          const util = m.utilization ?? 0;
          const barClass = util > 100 ? 'capacity-over' : util > 80 ? 'capacity-warn' : 'capacity-ok';
          return `
            <tr>
              <td>${esc(m.name)}</td>
              <td style="color:#888">${esc(m.email)}</td>
              <td>${m.capacity_per_sprint}pt</td>
              <td>${m.allocated ?? 0}pt</td>
              <td style="min-width:100px">
                <div class="capacity-bar"><div class="capacity-fill ${barClass}" style="width:${Math.min(util, 100)}%"></div></div>
                <span style="font-size:11px;color:${util > 100 ? '#ef4444' : '#888'}">${util}%</span>
              </td>
              <td><button class="btn btn-sm btn-danger" data-action="delete-member" data-id="${m.id}">&times;</button></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`}`;
}

function renderProjectsTab(): string {
  return `
    <div class="header-row">
      <div>Projects (${state.projects.length})</div>
      <button class="btn btn-primary" data-action="show-new-project">+ Project</button>
    </div>
    ${state.showNewProjectForm ? `
    <div class="form">
      <div class="form-row"><label>Name</label><input id="new-project-name" placeholder="My Project" /></div>
      <div class="form-row"><label>Description</label><textarea id="new-project-desc" placeholder="Project description..."></textarea></div>
      <div class="form-actions">
        <button class="btn btn-primary" data-action="create-project">Create</button>
        <button class="btn" data-action="cancel-new-project">Cancel</button>
      </div>
    </div>` : ''}
    ${state.projects.length === 0 ? '<div class="empty">No projects. Create one to get started.</div>' : `
    <table class="table">
      <thead><tr><th>Name</th><th>Tasks</th><th>Sprints</th><th>Created</th><th></th></tr></thead>
      <tbody>
        ${state.projects.map(p => `
          <tr>
            <td><a href="#" data-action="select-project" data-id="${p.id}" style="color:#4fc3f7;text-decoration:none">${esc(p.name)}</a></td>
            <td>${p.task_count ?? 0}</td>
            <td>${p.sprint_count ?? 0}</td>
            <td style="color:#888">${p.created_at?.slice(0, 10)}</td>
            <td><button class="btn btn-sm btn-danger" data-action="delete-project" data-id="${p.id}">&times;</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`}`;
}

// ── Main render ─────────────────────────────────────────────────────────

function render() {
  let content = '';
  if (state.loading) {
    content = '<div class="loading">Loading...</div>';
  } else if (state.error) {
    content = `<div class="error">${esc(state.error)}</div>`;
  } else {
    switch (state.activeTab) {
      case 'board': content = renderBoardTab(); break;
      case 'backlog': content = renderBacklogTab(); break;
      case 'sprints': content = renderSprintsTab(); break;
      case 'team': content = renderTeamTab(); break;
      case 'projects': content = renderProjectsTab(); break;
    }
  }

  const successBanner = state.success ? `<div class="success">${esc(state.success)}</div>` : '';

  xai.render(`
    <style>${CSS}</style>
    <div class="container">
      ${renderProjectBar()}
      ${renderTabBar()}
      ${successBanner}
      ${content}
    </div>
  `);

  attachHandlers();
  if (state.success) {
    clearTimeout(successTimer);
    successTimer = setTimeout(() => { state.success = null; render(); }, 2000);
  }
}

let successTimer: ReturnType<typeof setTimeout> | null = null;

// ── Data loading ────────────────────────────────────────────────────────

async function loadProjects() {
  state.projects = await api.listProjects();
  if (!state.currentProjectId && state.projects.length > 0) {
    state.currentProjectId = state.projects[0].id;
  }
}

async function loadTab() {
  state.loading = true;
  state.error = null;
  render();

  try {
    await loadProjects();
    if (state.currentProjectId) {
      switch (state.activeTab) {
        case 'board':
          state.board = await api.getBoard(state.currentProjectId);
          state.sprints = await api.listSprints(state.currentProjectId);
          break;
        case 'backlog':
          const filters: Record<string, string> = {};
          if (state.filterStatus) filters.status = state.filterStatus;
          if (state.filterAssignee) filters.assignee = state.filterAssignee;
          if (state.filterPriority) filters.priority = state.filterPriority;
          state.tasks = await api.listTasks(state.currentProjectId, filters);
          state.sprints = await api.listSprints(state.currentProjectId);
          break;
        case 'sprints':
          state.sprints = await api.listSprints(state.currentProjectId);
          break;
        case 'team':
          state.team = await api.listTeam();
          if (state.sprints.length === 0) state.sprints = await api.listSprints(state.currentProjectId);
          const activeSprint = state.sprints.find(s => s.status === 'active');
          if (activeSprint) {
            const cap = await api.getCapacity(activeSprint.id);
            if (cap) state.team = cap.capacity as any;
          }
          break;
        case 'projects':
          break;
      }
    }
  } catch (err: any) {
    state.error = err.message ?? 'Failed to load data';
  }

  state.loading = false;
  render();
}

// ── Event handlers ──────────────────────────────────────────────────────

function attachHandlers() {
  // Tabs
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(el => {
    el.onclick = () => {
      state.activeTab = el.dataset.tab as TabKey;
      state.showNewTaskForm = false;
      state.showNewProjectForm = false;
      state.showNewSprintForm = false;
      state.showNewMemberForm = false;
      state.editingTaskId = null;
      loadTab();
    };
  });

  // Project switcher
  document.querySelectorAll<HTMLSelectElement>('[data-action="switch-project"]').forEach(el => {
    el.onchange = () => {
      state.currentProjectId = el.value;
      loadTab();
    };
  });

  // Filter changes
  document.querySelectorAll<HTMLSelectElement>('[data-action="filter-status"]').forEach(el => {
    el.onchange = () => { state.filterStatus = el.value; loadTab(); };
  });
  document.querySelectorAll<HTMLSelectElement>('[data-action="filter-priority"]').forEach(el => {
    el.onchange = () => { state.filterPriority = el.value; loadTab(); };
  });
  document.querySelectorAll<HTMLSelectElement>('[data-action="filter-assignee"]').forEach(el => {
    el.onchange = () => { state.filterAssignee = el.value; loadTab(); };
  });

  // Action buttons
  document.querySelectorAll<HTMLElement>('[data-action]').forEach(el => {
    const action = el.dataset.action!;
    if (['switch-project', 'filter-status', 'filter-priority', 'filter-assignee'].includes(action)) return;

    el.onclick = async (e) => {
      e.preventDefault();
      const id = el.dataset.id;

      try {
        switch (action) {
          case 'show-new-task': state.showNewTaskForm = true; state.editingTaskId = null; render(); break;
          case 'cancel-new-task': state.showNewTaskForm = false; render(); break;
          case 'show-new-project': state.showNewProjectForm = true; render(); break;
          case 'cancel-new-project': state.showNewProjectForm = false; render(); break;
          case 'show-new-sprint': state.showNewSprintForm = true; render(); break;
          case 'cancel-new-sprint': state.showNewSprintForm = false; render(); break;
          case 'show-new-member': state.showNewMemberForm = true; render(); break;
          case 'cancel-new-member': state.showNewMemberForm = false; render(); break;
          case 'cancel-edit': state.editingTaskId = null; render(); break;

          case 'edit-task':
            state.editingTaskId = id!;
            state.showNewTaskForm = false;
            render();
            break;

          case 'create-task': {
            const title = (document.getElementById('new-title') as HTMLInputElement)?.value?.trim();
            if (!title) break;
            await api.createTask(state.currentProjectId!, {
              title,
              description: (document.getElementById('new-desc') as HTMLTextAreaElement)?.value ?? '',
              priority: (document.getElementById('new-priority') as HTMLSelectElement)?.value as any ?? 'P2',
              story_points: parseInt((document.getElementById('new-points') as HTMLInputElement)?.value ?? '0', 10),
              assignee: (document.getElementById('new-assignee') as HTMLInputElement)?.value ?? '',
              sprint_id: (document.getElementById('new-sprint') as HTMLSelectElement)?.value || null,
              due_date: (document.getElementById('new-due') as HTMLInputElement)?.value || null,
            } as any);
            state.showNewTaskForm = false;
            state.success = 'Task created';
            loadTab();
            break;
          }

          case 'save-task': {
            const tid = id!;
            await api.updateTask(tid, {
              title: (document.getElementById('edit-title') as HTMLInputElement)?.value,
              description: (document.getElementById('edit-desc') as HTMLTextAreaElement)?.value,
              status: (document.getElementById('edit-status') as HTMLSelectElement)?.value as any,
              priority: (document.getElementById('edit-priority') as HTMLSelectElement)?.value as any,
              story_points: parseInt((document.getElementById('edit-points') as HTMLInputElement)?.value ?? '0', 10),
              assignee: (document.getElementById('edit-assignee') as HTMLInputElement)?.value,
              sprint_id: (document.getElementById('edit-sprint') as HTMLSelectElement)?.value || null,
              due_date: (document.getElementById('edit-due') as HTMLInputElement)?.value || null,
            } as any);
            state.editingTaskId = null;
            state.success = 'Task updated';
            loadTab();
            break;
          }

          case 'move-left':
          case 'move-right':
            await api.moveTask(id!, el.dataset.status as Task['status']);
            loadTab();
            break;

          case 'delete-task':
            await api.deleteTask(id!);
            state.success = 'Task deleted';
            loadTab();
            break;

          case 'create-project': {
            const name = (document.getElementById('new-project-name') as HTMLInputElement)?.value?.trim();
            if (!name) break;
            const proj = await api.createProject({
              name,
              description: (document.getElementById('new-project-desc') as HTMLTextAreaElement)?.value ?? '',
            });
            state.showNewProjectForm = false;
            state.currentProjectId = proj.id;
            state.success = `Project "${name}" created`;
            loadTab();
            break;
          }

          case 'select-project':
            state.currentProjectId = id!;
            state.activeTab = 'board';
            loadTab();
            break;

          case 'delete-project':
            await api.deleteProject(id!);
            if (state.currentProjectId === id) state.currentProjectId = null;
            state.success = 'Project deleted';
            loadTab();
            break;

          case 'create-sprint': {
            const name = (document.getElementById('new-sprint-name') as HTMLInputElement)?.value?.trim();
            if (!name) break;
            await api.createSprint(state.currentProjectId!, {
              name,
              start_date: (document.getElementById('new-sprint-start') as HTMLInputElement)?.value || null,
              end_date: (document.getElementById('new-sprint-end') as HTMLInputElement)?.value || null,
              goals: (document.getElementById('new-sprint-goals') as HTMLTextAreaElement)?.value ?? '',
            } as any);
            state.showNewSprintForm = false;
            state.success = 'Sprint created';
            loadTab();
            break;
          }

          case 'activate-sprint':
            await api.activateSprint(id!);
            state.success = 'Sprint activated';
            loadTab();
            break;

          case 'close-sprint': {
            const result = await api.closeSprint(id!);
            state.success = `Sprint closed: ${result.completed} done, ${result.incomplete} moved to ${result.moved_to}, velocity ${result.velocity}pt`;
            loadTab();
            break;
          }

          case 'delete-sprint':
            await api.deleteSprint(id!);
            state.success = 'Sprint deleted';
            loadTab();
            break;

          case 'create-member': {
            const name = (document.getElementById('new-member-name') as HTMLInputElement)?.value?.trim();
            const email = (document.getElementById('new-member-email') as HTMLInputElement)?.value?.trim();
            if (!name || !email) break;
            await api.addTeamMember({
              name, email,
              capacity_per_sprint: parseInt((document.getElementById('new-member-cap') as HTMLInputElement)?.value ?? '10', 10),
            });
            state.showNewMemberForm = false;
            state.success = `${name} added to team`;
            loadTab();
            break;
          }

          case 'delete-member':
            await api.removeTeamMember(id!);
            state.success = 'Member removed';
            loadTab();
            break;
        }
      } catch (err: any) {
        state.error = err.message ?? 'Action failed';
        state.loading = false;
        render();
      }
    };
  });
}

// ── Init ─────────────────────────────────────────────────────────────────

xai.on('ready', async () => {
  const ok = await api.checkServer();
  if (!ok) {
    state.loading = false;
    state.error = 'Project Manager server not running. Check that the app is installed and started.';
    render();
    return;
  }
  loadTab();
});
