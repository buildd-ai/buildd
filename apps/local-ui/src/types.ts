// Worker status
export type WorkerStatus = 'idle' | 'working' | 'done' | 'error' | 'stale';

// Milestone for progress tracking
export interface Milestone {
  label: string;
  completed: boolean;
  timestamp?: number;
}

// Tool call tracking
export interface ToolCall {
  name: string;
  timestamp: number;
  input?: any;
}

// Chat message for unified timeline
export type ChatMessage =
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'tool_use'; name: string; input?: any; timestamp: number }
  | { type: 'user'; content: string; timestamp: number };

// Local worker state
export interface LocalWorker {
  id: string;
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
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
  toolCalls: ToolCall[];  // Track tool calls for post-execution summary
  messages: ChatMessage[];  // Unified chronological timeline
  sessionId?: string;
  error?: string;
}

// Task mode
export type TaskMode = 'execution' | 'planning';

// Task from buildd
export interface BuilddTask {
  id: string;
  title: string;
  description: string;
  workspaceId: string;
  workspace?: {
    name: string;
    repo?: string;
    gitConfig?: WorkspaceGitConfig;
    configStatus?: 'unconfigured' | 'admin_confirmed';
    ownerId?: string;
  };
  status: string;
  priority: number;
  mode?: TaskMode;  // 'planning' or 'execution' (default)
  context?: Record<string, unknown>;  // May contain attachments
  attachments?: Array<{ id: string; filename: string; url: string }>;
  // Assignment tracking
  claimedBy?: string | null;
  claimedAt?: string | null;
  expiresAt?: string | null;
}

// Git workflow configuration (matches server schema)
export interface WorkspaceGitConfig {
  // Branching
  defaultBranch: string;
  branchingStrategy: 'trunk' | 'gitflow' | 'feature' | 'custom';
  branchPrefix?: string;
  useBuildBranch?: boolean;

  // Commit conventions
  commitStyle: 'conventional' | 'freeform' | 'custom';
  commitPrefix?: string;

  // PR/Merge behavior
  requiresPR: boolean;
  targetBranch?: string;
  autoCreatePR: boolean;

  // Agent instructions
  agentInstructions?: string;
  useClaudeMd: boolean;

  // Permission mode
  bypassPermissions?: boolean;
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
  // Accept remote task assignments from dashboard (default: true)
  acceptRemoteTasks?: boolean;
  // Bypass permission prompts for bash commands (dangerous commands still blocked)
  bypassPermissions?: boolean;
}
