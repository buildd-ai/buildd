// Worker status
export type WorkerStatus = 'idle' | 'working' | 'done' | 'error' | 'stale';

// Milestone for progress tracking
export interface Milestone {
  label: string;
  completed: boolean;
  timestamp?: number;
}

// Local worker state
export interface LocalWorker {
  id: string;
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  workspaceName: string;
  branch: string;
  status: WorkerStatus;
  hasNewActivity: boolean;  // Blue dot
  lastActivity: number;
  milestones: Milestone[];
  currentAction: string;
  commits: Array<{ sha: string; message: string }>;
  output: string[];  // Recent output lines
  sessionId?: string;
  error?: string;
}

// Task from buildd
export interface BuilddTask {
  id: string;
  title: string;
  description: string;
  workspaceId: string;
  workspace?: { name: string; repo?: string };
  status: string;
  priority: number;
  context?: Record<string, unknown>;  // May contain attachments
  attachments?: Array<{ id: string; filename: string; url: string }>;
}

// SSE event types
export type SSEEvent =
  | { type: 'workers'; workers: LocalWorker[] }
  | { type: 'worker_update'; worker: LocalWorker }
  | { type: 'tasks'; tasks: BuilddTask[] }
  | { type: 'output'; workerId: string; line: string }
  | { type: 'milestone'; workerId: string; milestone: Milestone };

// Command from server
export interface WorkerCommand {
  action: 'pause' | 'resume' | 'abort' | 'message';
  text?: string;
  timestamp: number;
}

// Config
export interface LocalUIConfig {
  projectsRoot: string;  // Primary root (backwards compat)
  projectRoots?: string[];  // All roots to search
  builddServer: string;
  apiKey: string;
  maxConcurrent: number;
  model: string;
  // Serverless mode (no server connection)
  serverless?: boolean;
  // Direct access URL for this local-ui instance
  localUiUrl?: string;
  // Pusher config (optional, for command relay)
  pusherKey?: string;
  pusherCluster?: string;
  // Override Anthropic API key (uses own account instead of global settings)
  anthropicApiKey?: string;
}
