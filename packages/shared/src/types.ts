// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export const WorkerStatus = {
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  WAITING_INPUT: 'waiting_input',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ERROR: 'error',
} as const;

export type WorkerStatusType = typeof WorkerStatus[keyof typeof WorkerStatus];

export const TaskStatus = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  REVIEW: 'review',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];

export const ArtifactType = {
  TASK_PLAN: 'task_plan',
  IMPL_PLAN: 'impl_plan',
  SCREENSHOT: 'screenshot',
  RECORDING: 'recording',
  DIFF: 'diff',
  WALKTHROUGH: 'walkthrough',
  SUMMARY: 'summary',
} as const;

export type ArtifactTypeValue = typeof ArtifactType[keyof typeof ArtifactType];

export const SourceType = {
  MANUAL: 'manual',
  GITHUB: 'github',
  JIRA: 'jira',
  LINEAR: 'linear',
} as const;

export type SourceTypeValue = typeof SourceType[keyof typeof SourceType];

// ============================================================================
// ENTITIES
// ============================================================================

export interface Workspace {
  id: string;
  name: string;
  repo: string | null;
  localPath: string | null;
  memory: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  taskCount?: number;
  activeWorkerCount?: number;
}

export interface Source {
  id: string;
  workspaceId: string;
  type: SourceTypeValue;
  name: string;
  config: Record<string, unknown>;
  createdAt: Date;
}

export interface Task {
  id: string;
  workspaceId: string;
  sourceId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  title: string;
  description: string | null;
  context: Record<string, unknown>;
  status: TaskStatusType;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
  workspace?: Workspace;
  source?: Source;
  worker?: Worker;
}

export interface Worker {
  id: string;
  taskId: string | null;
  workspaceId: string;
  name: string;
  branch: string;
  worktreePath: string | null;
  status: WorkerStatusType;
  waitingFor: WaitingFor | null;
  progress: number;
  sdkSessionId: string | null;
  costUsd: number;
  turns: number;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  task?: Task;
  workspace?: Workspace;
  artifacts?: Artifact[];
}

export interface WaitingFor {
  type: 'question' | 'permission' | 'confirmation';
  prompt: string;
  options?: string[];
}

export interface Artifact {
  id: string;
  workerId: string;
  type: ArtifactTypeValue;
  title: string | null;
  content: string | null;
  storageKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  url?: string;
  comments?: Comment[];
}

export interface Comment {
  id: string;
  artifactId: string | null;
  workerId: string | null;
  content: string;
  selection: SelectionRange | null;
  resolved: boolean;
  createdAt: Date;
}

export interface SelectionRange {
  start: number;
  end: number;
  text?: string;
}

export interface Message {
  id: string;
  workerId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  toolOutput: string | null;
  costUsd: number | null;
  createdAt: Date;
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  messageId: string;
  filename: string;
  mimeType: string;
  storageKey: string;
  url?: string;
  createdAt: Date;
}

// ============================================================================
// API INPUT TYPES
// ============================================================================

export interface CreateWorkspaceInput {
  name: string;
  repo?: string;
  localPath?: string;
}

export interface CreateTaskInput {
  workspaceId: string;
  sourceId?: string;
  externalId?: string;
  externalUrl?: string;
  title: string;
  description?: string;
  context?: Record<string, unknown>;
  priority?: number;
}

export interface CreateWorkerInput {
  workspaceId: string;
  taskId?: string;
  name?: string;
  branch?: string;
}

export interface StartWorkerInput {
  prompt: string;
  attachments?: string[];
}

export interface SendMessageInput {
  content: string;
  attachments?: string[];
}

// ============================================================================
// SSE EVENTS
// ============================================================================

export type SSEEventType =
  | 'worker:status'
  | 'worker:progress'
  | 'worker:message'
  | 'worker:artifact'
  | 'worker:cost'
  | 'worker:error'
  | 'worker:waiting'
  | 'worker:completed'
  | 'task:updated';

export interface SSEEvent<T = unknown> {
  type: SSEEventType;
  workspaceId?: string;
  workerId?: string;
  taskId?: string;
  data: T;
  timestamp: Date;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+[\/~]/,
  /sudo\s+/,
  />\s*\/dev\//,
  /mkfs\./,
  /dd\s+if=/,
  /:(){.*};:/,
  /chmod\s+777/,
  /curl.*\|\s*sh/,
] as const;

export const SENSITIVE_PATHS = [
  /^\/etc\//,
  /^\/usr\//,
  /^\/var\//,
  /^\/root\//,
  /\.env$/,
  /\.ssh\//,
  /id_rsa/,
] as const;
