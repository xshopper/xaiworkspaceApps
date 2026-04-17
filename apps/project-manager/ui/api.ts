import type { Project, Task, Sprint, TeamMember, BoardView, CapacityView, StandupView, SprintCloseResult } from './types';

const BASE = 'http://localhost:3462';

function check<T>(res: { status: number; data: T }): T {
  if (res.status >= 400) throw new Error((res.data as any)?.error ?? `HTTP ${res.status}`);
  return res.data;
}

async function get<T>(path: string): Promise<T> {
  return check(await xai.http<T>(`${BASE}${path}`));
}

async function post<T>(path: string, data?: any): Promise<T> {
  return check(await xai.http<T>(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  }));
}

async function put<T>(path: string, data: any): Promise<T> {
  return check(await xai.http<T>(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }));
}

async function del(path: string): Promise<void> {
  check(await xai.http(`${BASE}${path}`, { method: 'DELETE' }));
}

// ── Projects ────────────────────────────────────────────────────────────

export async function listProjects(): Promise<Project[]> {
  const d = await get<{ projects: Project[] }>('/api/projects');
  return d.projects;
}

export async function createProject(data: { name: string; description?: string }): Promise<Project> {
  return post<Project>('/api/projects', data);
}

export async function updateProject(id: string, data: Partial<Project>): Promise<Project> {
  return put<Project>(`/api/projects/${id}`, data);
}

export async function deleteProject(id: string): Promise<void> {
  return del(`/api/projects/${id}`);
}

// ── Tasks ───────────────────────────────────────────────────────────────

export async function listTasks(projectId: string, filters?: Record<string, string>): Promise<Task[]> {
  let q = '';
  if (filters) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) { if (v) params.set(k, v); }
    const s = params.toString();
    if (s) q = `?${s}`;
  }
  const d = await get<{ tasks: Task[] }>(`/api/projects/${projectId}/tasks${q}`);
  return d.tasks;
}

export async function createTask(projectId: string, data: Partial<Task>): Promise<Task> {
  return post<Task>(`/api/projects/${projectId}/tasks`, data);
}

export async function updateTask(id: string, data: Partial<Task>): Promise<Task> {
  return put<Task>(`/api/tasks/${id}`, data);
}

export async function deleteTask(id: string): Promise<void> {
  return del(`/api/tasks/${id}`);
}

export async function moveTask(id: string, status: Task['status']): Promise<Task> {
  return post<Task>(`/api/tasks/${id}/move`, { status });
}

// ── Sprints ─────────────────────────────────────────────────────────────

export async function listSprints(projectId: string): Promise<Sprint[]> {
  const d = await get<{ sprints: Sprint[] }>(`/api/projects/${projectId}/sprints`);
  return d.sprints;
}

export async function createSprint(projectId: string, data: Partial<Sprint>): Promise<Sprint> {
  return post<Sprint>(`/api/projects/${projectId}/sprints`, data);
}

export async function updateSprint(id: string, data: Partial<Sprint>): Promise<Sprint> {
  return put<Sprint>(`/api/sprints/${id}`, data);
}

export async function deleteSprint(id: string): Promise<void> {
  return del(`/api/sprints/${id}`);
}

export async function activateSprint(id: string): Promise<Sprint> {
  return post<Sprint>(`/api/sprints/${id}/activate`);
}

export async function closeSprint(id: string): Promise<SprintCloseResult> {
  return post<SprintCloseResult>(`/api/sprints/${id}/close`);
}

// ── Team ────────────────────────────────────────────────────────────────

export async function listTeam(): Promise<TeamMember[]> {
  const d = await get<{ team: TeamMember[] }>('/api/team');
  return d.team;
}

export async function addTeamMember(data: { name: string; email: string; capacity_per_sprint?: number }): Promise<TeamMember> {
  return post<TeamMember>('/api/team', data);
}

export async function updateTeamMember(id: string, data: Partial<TeamMember>): Promise<TeamMember> {
  return put<TeamMember>(`/api/team/${id}`, data);
}

export async function removeTeamMember(id: string): Promise<void> {
  return del(`/api/team/${id}`);
}

// ── Aggregate views ─────────────────────────────────────────────────────

export async function getBoard(projectId: string): Promise<BoardView> {
  return get<BoardView>(`/api/board/${projectId}`);
}

export async function getCapacity(sprintId: string): Promise<CapacityView> {
  return get<CapacityView>(`/api/capacity/${sprintId}`);
}

export async function getStandup(projectId: string): Promise<StandupView> {
  return get<StandupView>(`/api/standup/${projectId}`);
}

export async function checkServer(): Promise<boolean> {
  try {
    const res = await xai.http(`${BASE}/health`);
    return res.status === 200;
  } catch { return false; }
}
