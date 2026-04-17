export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  task_count?: number;
  sprint_count?: number;
}

export interface Task {
  id: string;
  project_id: string;
  sprint_id: string | null;
  title: string;
  description: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  assignee: string;
  labels: string;
  due_date: string | null;
  story_points: number;
  created_at: string;
  updated_at: string;
}

export interface Sprint {
  id: string;
  project_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: 'planned' | 'active' | 'closed';
  goals: string;
  created_at: string;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  capacity_per_sprint: number;
  created_at: string;
  allocated?: number;
  completed?: number;
  task_count?: number;
  utilization?: number;
  over_allocated?: boolean;
}

export interface BoardView {
  sprint: Sprint | null;
  columns: Record<Task['status'], Task[]>;
  total: number;
}

export interface CapacityView {
  sprint: Sprint;
  capacity: TeamMember[];
  summary: {
    total_points: number;
    completed_points: number;
    total_capacity: number;
    utilization: number;
  };
}

export interface StandupView {
  recently_done: Task[];
  in_progress: Task[];
  blockers: Task[];
  sprint: Sprint | null;
}

export interface SprintCloseResult {
  sprint: Sprint;
  completed: number;
  incomplete: number;
  moved_to: string;
  velocity: number;
}

export type TabKey = 'board' | 'backlog' | 'sprints' | 'team' | 'projects';

export interface PanelState {
  loading: boolean;
  error: string | null;
  success: string | null;
  activeTab: TabKey;
  currentProjectId: string | null;
  projects: Project[];
  board: BoardView | null;
  tasks: Task[];
  sprints: Sprint[];
  team: TeamMember[];
  showNewTaskForm: boolean;
  showNewProjectForm: boolean;
  showNewSprintForm: boolean;
  showNewMemberForm: boolean;
  editingTaskId: string | null;
  filterStatus: string;
  filterAssignee: string;
  filterPriority: string;
}
