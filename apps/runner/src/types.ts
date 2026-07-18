import type { RoleConfig } from './roles.js';

// Worker status
export type WorkerStatus = 'idle' | 'working' | 'done' | 'error' | 'stale' | 'waiting';

// Permission suggestion from SDK (PermissionUpdate subset relevant to UI display)
export interface PermissionSuggestion {
  type: 'addRules' | 'replaceRules' | 'removeRules' | 'setMode' | 'addDirectories' | 'removeDirectories';
  label: string;  // Human-readable label for UI display
  raw: unknown;   // Original PermissionUpdate object to pass back to SDK
}

// Waiting for user input (question/permission)
export interface WaitingFor {
  type: 'question' | 'permission';
  prompt: string;
  options?: Array<{
    label: string;
    description?: string;
  }>;
  toolUseId?: string;  // The SDK tool_use block id — needed for parent_tool_use_id in responses
  // Permission-specific fields (when type === 'permission')
  toolName?: string;           // The tool requesting permission
  toolInput?: unknown;         // The tool input that triggered the request
  permissionSuggestions?: PermissionSuggestion[];  // SDK-provided suggestions for auto-fill
}

// Meaningful checkpoint events that map to actual worker activity
export const CheckpointEvent = {
  SESSION_STARTED: 'session_started',
  FIRST_READ: 'first_read',
  FIRST_EDIT: 'first_edit',
  FIRST_COMMIT: 'first_commit',
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
  task_completed: 'Task completed',
  task_error: 'Task failed',
};

// Milestone for progress tracking (typed union — no legacy format)
export type Milestone =
  | { type: 'phase'; label: string; toolCount: number; ts: number; pending?: boolean }
  | { type: 'status'; label: string; progress?: number; ts: number }
  | { type: 'checkpoint'; event: CheckpointEventType; label: string; ts: number }
  | { type: 'action'; label: string; ts: number };

// Tool call tracking
export interface ToolCall {
  name: string;
  timestamp: number;
  input?: any;
  /**
   * The originating tool_use block id (Claude SDK `block.id`, or the Codex
   * `item.id` surfaced by the codex-events adapter). Used to correlate a later
   * `tool_result`'s `tool_use_id` back to the source tool for error-trace
   * scanning (workers.ts handleMessage `user`/tool_result branch).
   */
  toolUseId?: string;
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
  isBackground?: boolean;  // SDK v0.2.49+: true when agent definition has `background: true`
  // SDK v0.3.202+: agent identity for reconstructing depth-2+ agent trees.
  // `agentId` is this subagent's SDK id; `parentAgentId` is its spawning agent
  // (absent for direct children of the main worker). Read defensively — older
  // CLIs don't stamp these, in which case the tree renders as a flat list.
  agentId?: string;
  parentAgentId?: string;
  // SDK v0.2.51+: cumulative progress metrics for background subagents
  progress?: {
    toolCount: number;
    durationMs: number;
    agentName: string | null;
    cumulativeUsage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  };
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
  taskMode?: string;  // 'execution' or 'planning'
  taskBackend?: 'claude' | 'codex';  // Which agent backend ran this task
  workspaceId: string;
  workspaceName: string;
  branch: string;
  status: WorkerStatus;
  hasNewActivity: boolean;  // Blue dot
  startedAt: number;  // When worker was created (for cycle time tracking)
  lastActivity: number;
  // True while a tool/subagent call is executing (set on PreToolUse, cleared on
  // PostToolUse / PostToolUseFailure). Long silent tools (e.g. a bash that waits
  // on CI) emit no SDK stream messages, so checkStale exempts in-flight tools
  // from the soft-probe/stale-abort path and relies on the 30-min hard timeout.
  toolInFlight?: boolean;
  completedAt?: number;  // When task completed/errored (for sorting)
  milestones: Milestone[];
  currentAction: string;
  commits: Array<{ sha: string; message: string }>;
  output: string[];  // Recent output lines
  toolCalls: ToolCall[];  // Track tool calls for post-execution summary
  messages: ChatMessage[];  // Unified chronological timeline
  sessionId?: string;
  // Codex thread id (Phase 1C / R5). Captured from the Codex `thread.started`
  // event (surfaced by the adapter as system:init.session_id) and persisted so a
  // follow-up resumes the prior thread via the backend's resumeThreadId. Kept
  // SEPARATE from sessionId so the Claude-vs-Codex resume branch stays explicit.
  codexThreadId?: string;
  error?: string;
  waitingFor?: WaitingFor;  // Set when agent asks a question
  teamState?: TeamState;  // Set when agent spawns a team
  subagentTasks: SubagentTask[];  // Subagent task lifecycle (task_started → task_notification)
  worktreePath?: string;  // Git worktree path (isolated cwd for this worker)
  checkpoints: Checkpoint[];  // File checkpoints for rollback support
  checkpointEvents: Set<CheckpointEventType>;  // Tracks which meaningful checkpoints have fired
  pendingMcpCalls?: Array<{ server: string; tool: string; ts: number; ok: boolean; durationMs?: number }>;  // Buffered MCP tool calls awaiting sync
  pendingErrorTraces?: Array<{ pattern: string; excerpt: string; source?: string }>;  // Buffered agent tool-output error matches awaiting sync
  lastAssistantMessage?: string;  // Final agent response text (from SDK Stop hook)
  // Phase tracking (reasoning text → tool call grouping)
  phaseText: string | null;
  phaseStart: number | null;
  phaseToolCount: number;
  phaseTools: string[];  // Notable tool labels in current phase, cap 5
  // SDK result metadata (populated on completion)
  resultMeta?: ResultMeta | null;
  // Server-managed API key (delivered inline during claim, injected into subprocess env)
  serverApiKey?: string;
  // Server-managed OAuth token (delivered inline during claim, injected as CLAUDE_CODE_OAUTH_TOKEN)
  serverOauthToken?: string;
  // Codex OAuth credential (delivered inline during claim, materialized as CODEX_HOME/auth.json)
  codexCredential?: {
    accessToken: string;
    refreshToken: string;
    accountId: string;
    expiresAt: Date | null;
  };
  // Role config from claim route (for role env resolution)
  roleConfig?: RoleConfig;
  // Assertion connector metadata for mid-task re-auth (spec §F.2)
  assertionConnectors?: Array<{ name: string; mintApiUrl: string; tokenEndpoint: string }>;
  // Per-connector assertion access token cache (in-memory, per-session only)
  assertionTokenCache?: Map<string, { accessToken: string; expiresAt: number }>;
  // Prompt suggestions for follow-up actions (populated on completion)
  promptSuggestions?: string[];
  // Last assistant message text (captured via Stop hook's last_assistant_message)
  lastAssistantMessage?: string;
  // Set after the first loop-guard nudge is injected so we don't double-send
  loopNudgeSent?: boolean;
  // Current prompt UUID (SDK v0.3.196 BaseHookInput.prompt_id) — correlates hook events
  // with SDK-emitted OTel spans at prompt grain (attribute: prompt.id).
  currentPromptId?: string;
  // Command lifecycle counts (SDK v0.3.206 command_lifecycle frames) — tracks the
  // terminal state of each queued message so cancelled/discarded steers surface.
  // Lazily initialized on the first frame; absent on CLIs that never emit it.
  commandLifecycle?: import('./command-lifecycle').CommandLifecycleTracker;
  // Model capabilities discovered via SDK v0.2.49+ supportedModels()
  modelCapabilities?: {
    model?: string;
    capabilities?: {
      supportsEffort: boolean;
      supportedEffortLevels: string[];
      supportsAdaptiveThinking: boolean;
    };
    warnings: string[];
  };
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
  terminalReason?: string | null;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  modelUsage: Record<string, ModelUsage>;
  permissionDenials?: Array<{ tool: string; reason: string }>;
}

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
  mode?: string;
  dependsOn?: string[];
  context?: Record<string, unknown>;  // May contain attachments
  attachments?: Array<{ id: string; filename: string; url: string }>;
  // Task taxonomy
  kind?: 'coordination' | 'engineering' | 'research' | 'writing' | 'design' | 'analysis' | 'observation';
  // Agent backend to use for execution
  backend?: 'claude' | 'codex';
  // Output requirement — what deliverables are enforced on completion
  outputRequirement?: 'pr_required' | 'artifact_required' | 'none' | 'auto';
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

  // Worktree isolation for subagents (SDK v0.2.49+)
  // When enabled, skill-as-subagent definitions include `isolation: 'worktree'`
  useWorktreeIsolation?: boolean;

  // Sandbox configuration for worker isolation (SDK v0.2.44+)
  sandbox?: {
    enabled?: boolean;
    autoAllowBashIfSandboxed?: boolean;
    network?: {
      allowedDomains?: string[];
      allowLocalBinding?: boolean;
    };
    excludedCommands?: string[];
    // Credential-read blocking for sandboxed commands (SDK v0.3.187)
    // Prevents sandboxed bash commands from reading sensitive credential files or env vars.
    credentials?: {
      files?: Array<{ path: string; mode: 'deny' }>;
      environment?: Array<{ name: string; mode: 'deny' | 'mask'; injectHosts?: string[] }>;
    };
  };

  // Auto-merge PRs via GitHub's auto-merge feature
  autoMergePR?: boolean;
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
  action: 'pause' | 'resume' | 'abort' | 'message' | 'rollback' | 'recover';
  text?: string;
  timestamp: number;
  // rollback fields
  checkpointUuid?: string;
  // recovery fields
  recoveryMode?: 'diagnose' | 'complete' | 'restart';
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
  projectRoots: string[];  // All roots to search
  builddServer: string;
  apiKey: string;
  maxConcurrent: number;
  model: string;
  // LLM provider configuration (default: anthropic)
  llmProvider?: ProviderConfig;
  // Serverless mode (no server connection)
  serverless?: boolean;
  // Direct access URL for this runner instance
  localUiUrl?: string;
  // Pusher config (optional, for command relay)
  pusherKey?: string;
  pusherCluster?: string;
  // Channel prefix for environment isolation (e.g. "preview-")
  pusherChannelPrefix?: string;
  // Accept remote task assignments from dashboard (default: true)
  acceptRemoteTasks?: boolean;
  // Bypass permission prompts for bash commands (dangerous commands still blocked)
  bypassPermissions?: boolean;
  // Maximum budget in USD per worker session (local fallback; workspace gitConfig.maxBudgetUsd takes priority)
  maxBudgetUsd?: number;
  // Maximum turns per worker session (default: no limit)
  maxTurns?: number;
  // Controls AskUserQuestion behavior. Default (undefined/true): abort+retry —
  // the worker is marked failed with failReason 'needs_input' and the user
  // responds asynchronously via the dashboard, creating a follow-up task.
  // Set to false to preserve the legacy blocking waiting_input behavior.
  inputAsRetry?: boolean;
}
