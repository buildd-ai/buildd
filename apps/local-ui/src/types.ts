// Worker status
export type WorkerStatus = 'idle' | 'working' | 'done' | 'error' | 'stale' | 'waiting';

// Waiting for user input (question/permission)
export interface WaitingFor {
  type: 'question' | 'plan_approval';
  prompt: string;
  options?: Array<{
    label: string;
    description?: string;
  }>;
  toolUseId?: string;  // The SDK tool_use block id — needed for parent_tool_use_id in responses
}

// Meaningful checkpoint events that map to actual worker activity
export const CheckpointEvent = {
  SESSION_STARTED: 'session_started',
  FIRST_READ: 'first_read',
  FIRST_EDIT: 'first_edit',
  FIRST_COMMIT: 'first_commit',
  PLAN_SUBMITTED: 'plan_submitted',
  TASK_COMPLETED: 'task_completed',
  TASK_ERROR: 'task_error',
} as const;

export type CheckpointEventType = typeof CheckpointEvent[keyof typeof CheckpointEvent];

// Human-readable labels for checkpoint events
export const CHECKPOINT_LABELS: Record<CheckpointEventType, string> = {
  session_started: 'Session started',
  first_read: 'First file read',
  first_edit: 'First file edit',
  first_commit: 'First commit',
  plan_submitted: 'Plan submitted',
  task_completed: 'Task completed',
  task_error: 'Task failed',
};

// Milestone for progress tracking (typed union — no legacy format)
export type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number }
  | { type: 'checkpoint'; event: CheckpointEventType; label: string; ts: number };

// Tool call tracking
export interface ToolCall {
  name: string;
  timestamp: number;
  input?: any;
}

// File checkpoint (from SDK files_persisted events)
export interface Checkpoint {
  uuid: string;  // The message UUID — used for rewindFiles()
  timestamp: number;
  files: Array<{ filename: string; file_id: string }>;
}

// Chat message for unified timeline
export type ChatMessage =
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'tool_use'; name: string; input?: any; timestamp: number }
  | { type: 'user'; content: string; timestamp: number };

// Agent team member
export interface TeamMember {
  name: string;
  role?: string;
  status: 'active' | 'idle' | 'done';
  spawnedAt: number;
}

// Inter-agent message
export interface TeamMessage {
  from: string;
  to: string | 'broadcast';
  content: string;
  summary?: string;
  timestamp: number;
}

// Subagent task lifecycle tracking (from SDK task_started / task_notification messages)
export interface SubagentTask {
  taskId: string;
  toolUseId: string;
  description: string;
  taskType: string;
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
  completedAt?: number;
  message?: string;
}

// Team state for a worker
export interface TeamState {
  teamName: string;
  members: TeamMember[];
  messages: TeamMessage[];
  createdAt: number;
}

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
  completedAt?: number;  // When task completed/errored (for sorting)
  milestones: Milestone[];
  currentAction: string;
  commits: Array<{ sha: string; message: string }>;
  output: string[];  // Recent output lines
  toolCalls: ToolCall[];  // Track tool calls for post-execution summary
  messages: ChatMessage[];  // Unified chronological timeline
  sessionId?: string;
  error?: string;
  waitingFor?: WaitingFor;  // Set when agent asks a question
  planContent?: string;  // Extracted plan markdown when ExitPlanMode fires
  planStartMessageIndex?: number;  // messages.length when EnterPlanMode fires — used to extract full plan
  planFilePath?: string;  // Path to persisted plan markdown file (~/.buildd/plans/{workerId}.md)
  teamState?: TeamState;  // Set when agent spawns a team
  subagentTasks: SubagentTask[];  // Subagent task lifecycle (task_started → task_notification)
  worktreePath?: string;  // Git worktree path (isolated cwd for this worker)
  checkpoints: Checkpoint[];  // File checkpoints for rollback support
  checkpointEvents: Set<CheckpointEventType>;  // Tracks which meaningful checkpoints have fired
  lastAssistantMessage?: string;  // Final agent response text (from SDK Stop hook)
  // Phase tracking (reasoning text → tool call grouping)
  phaseText: string | null;
  phaseStart: number | null;
  phaseToolCount: number;
  phaseTools: string[];  // Notable tool labels in current phase, cap 5
  // SDK result metadata (populated on completion)
  resultMeta?: ResultMeta | null;
}

// Per-model token usage from SDK result
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

// SDK result metadata - captured from SDKResultSuccess/SDKResultError
export interface ResultMeta {
  stopReason: string | null;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  modelUsage: Record<string, ModelUsage>;
  permissionDenials?: Array<{ tool: string; reason: string }>;
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
    teamId?: string;
  };
  status: string;
  priority: number;
  mode?: TaskMode;  // 'planning' or 'execution' (default)
  context?: Record<string, unknown>;  // May contain attachments
  attachments?: Array<{ id: string; filename: string; url: string }>;
  // JSON Schema for structured output — passed to SDK outputFormat
  outputSchema?: Record<string, unknown> | null;
  // Assignment tracking
  claimedBy?: string | null;
  claimedAt?: string | null;
  expiresAt?: string | null;
  // Deliverable snapshot
  result?: {
    summary?: string;
    branch?: string;
    commits?: number;
    sha?: string;
    files?: number;
    added?: number;
    removed?: number;
    prUrl?: string;
    prNumber?: number;
  } | null;
}

// Git workflow configuration (matches server schema)
export interface WorkspaceGitConfig {
  // Branching
  defaultBranch: string;
  branchingStrategy: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
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

  // Maximum budget in USD per worker session
  maxBudgetUsd?: number;

  // Fallback model (SDK v0.2.45+)
  fallbackModel?: string;

  // SDK debug logging
  debug?: boolean;
  debugFile?: string;
}

// SSE event types
export type SSEEvent =
  | { type: 'workers'; workers: LocalWorker[] }
  | { type: 'worker_update'; worker: LocalWorker }
  | { type: 'tasks'; tasks: BuilddTask[] }
  | { type: 'output'; workerId: string; line: string }
  | { type: 'milestone'; workerId: string; milestone: Milestone };

// Extended task result with execution context
export interface TaskResult {
  summary?: string;
  branch?: string;
  commits?: number;
  sha?: string;
  files?: number;
  added?: number;
  removed?: number;
  prUrl?: string;
  prNumber?: number;
  phases?: Array<{ label: string; toolCount: number }>;
  lastQuestion?: string;
}

// Command from server
export interface WorkerCommand {
  action: 'pause' | 'resume' | 'abort' | 'message' | 'skill_install' | 'rollback';
  text?: string;
  timestamp: number;
  // skill_install fields
  bundle?: { slug: string; name: string; content: string; contentHash?: string; files?: any[] };
  installerCommand?: string;
  requestId?: string;
  skillSlug?: string;
  targetLocalUiUrl?: string | null;
  // rollback fields
  checkpointUuid?: string;
}

// Provider configuration for LLM routing
export type LLMProvider = 'anthropic' | 'openrouter';

export interface ProviderConfig {
  provider: LLMProvider;
  // For OpenRouter: the API key (sk-or-...)
  // For Anthropic: uses ANTHROPIC_API_KEY or Claude Code OAuth
  apiKey?: string;
  // Custom base URL (e.g., https://openrouter.ai/api)
  baseUrl?: string;
}

// Config
export interface LocalUIConfig {
  projectsRoot: string;  // Primary root (backwards compat)
  projectRoots?: string[];  // All roots to search
  builddServer: string;
  apiKey: string;
  maxConcurrent: number;
  model: string;
  // LLM provider configuration (default: anthropic)
  llmProvider?: ProviderConfig;
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
  // Remote skill installation
  skillInstallerAllowlist?: string[];
  rejectRemoteInstallers?: boolean;
  // Maximum budget in USD per worker session (local fallback; workspace gitConfig.maxBudgetUsd takes priority)
  maxBudgetUsd?: number;
  // Maximum turns per worker session (default: no limit)
  maxTurns?: number;
}
