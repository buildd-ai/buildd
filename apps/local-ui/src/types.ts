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

// Milestone for progress tracking (typed union — no legacy format)
export type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number };

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
  teamState?: TeamState;  // Set when agent spawns a team
  worktreePath?: string;  // Git worktree path (isolated cwd for this worker)
  // Phase tracking (reasoning text → tool call grouping)
  phaseText: string | null;
  phaseStart: number | null;
  phaseToolCount: number;
  phaseTools: string[];  // Notable tool labels in current phase, cap 5
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
  action: 'pause' | 'resume' | 'abort' | 'message' | 'skill_install';
  text?: string;
  timestamp: number;
  // skill_install fields
  bundle?: { slug: string; name: string; content: string; contentHash?: string; files?: any[] };
  installerCommand?: string;
  requestId?: string;
  skillSlug?: string;
  targetLocalUiUrl?: string | null;
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
}
