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

export const TaskMode = {
  EXECUTION: 'execution',
  PLANNING: 'planning',
} as const;

export type TaskModeValue = typeof TaskMode[keyof typeof TaskMode];

export const TaskStatus = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  REVIEW: 'review',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];

export const AccountType = {
  USER: 'user',
  SERVICE: 'service',
  ACTION: 'action',
} as const;

export type AccountTypeValue = typeof AccountType[keyof typeof AccountType];

export const AuthType = {
  API: 'api',
  OAUTH: 'oauth',
} as const;

export type AuthTypeValue = typeof AuthType[keyof typeof AuthType];

export const RunnerPreference = {
  ANY: 'any',
  USER: 'user',
  SERVICE: 'service',
  ACTION: 'action',
} as const;

export type RunnerPreferenceValue = typeof RunnerPreference[keyof typeof RunnerPreference];

export const ArtifactType = {
  IMPL_PLAN: 'impl_plan',
  SCREENSHOT: 'screenshot',
  RECORDING: 'recording',
  DIFF: 'diff',
  WALKTHROUGH: 'walkthrough',
  SUMMARY: 'summary',
  CONTENT: 'content',
  REPORT: 'report',
  DATA: 'data',
  LINK: 'link',
  EMAIL_DRAFT: 'email_draft',
  SOCIAL_POST: 'social_post',
  ANALYSIS: 'analysis',
  RECOMMENDATION: 'recommendation',
  ALERT: 'alert',
  CALENDAR_EVENT: 'calendar_event',
} as const;

export type ArtifactTypeValue = typeof ArtifactType[keyof typeof ArtifactType];

export const CreationSource = {
  DASHBOARD: 'dashboard',
  API: 'api',
  MCP: 'mcp',
  GITHUB: 'github',
  LOCAL_UI: 'local_ui',
  SCHEDULE: 'schedule',
  WEBHOOK: 'webhook',
} as const;

export type CreationSourceValue = typeof CreationSource[keyof typeof CreationSource];

export const TaskCategory = {
  BUG: 'bug',
  FEATURE: 'feature',
  REFACTOR: 'refactor',
  CHORE: 'chore',
  DOCS: 'docs',
  TEST: 'test',
  INFRA: 'infra',
  DESIGN: 'design',
} as const;

export type TaskCategoryValue = typeof TaskCategory[keyof typeof TaskCategory];

export const ObjectiveStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
} as const;

export type ObjectiveStatusValue = typeof ObjectiveStatus[keyof typeof ObjectiveStatus];

export const OutputRequirement = {
  PR_REQUIRED: 'pr_required',
  ARTIFACT_REQUIRED: 'artifact_required',
  NONE: 'none',
  AUTO: 'auto',
} as const;

export type OutputRequirementValue = typeof OutputRequirement[keyof typeof OutputRequirement];

// ============================================================================
// ENTITIES
// ============================================================================

export const TeamRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
} as const;

export type TeamRoleValue = typeof TeamRole[keyof typeof TeamRole];

export type TeamPlan = 'free' | 'pro' | 'team';

export interface Team {
  id: string;
  name: string;
  slug: string;
  plan: TeamPlan;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMember {
  teamId: string;
  userId: string;
  role: TeamRoleValue;
  joinedAt: Date;
}

export interface TeamInvitation {
  id: string;
  teamId: string;
  email: string;
  role: 'admin' | 'member';
  token: string;
  invitedBy: string | null;
  status: 'pending' | 'accepted' | 'expired';
  createdAt: Date;
  expiresAt: Date;
}

export interface Account {
  id: string;
  type: AccountTypeValue;
  name: string;
  apiKey: string;
  apiKeyPrefix: string | null;
  githubId: string | null;

  // Authentication type
  authType: AuthTypeValue;

  // For API-based auth (pay-per-token)
  anthropicApiKey: string | null;
  maxCostPerDay: number | null;
  totalCost: number;

  // For OAuth-based auth (seat-based)
  /** @deprecated OAuth tokens are now stored encrypted in the secrets table. */
  oauthToken: string | null;
  seatId: string | null;
  maxConcurrentSessions: number | null;
  activeSessions: number;
  /** Single-use ref for retrieving the encrypted OAuth token (set during claim). */
  oauthSecretRef?: string;

  // Common
  maxConcurrentWorkers: number;
  totalTasks: number;
  createdAt: Date;
}

export interface AccountWorkspace {
  accountId: string;
  workspaceId: string;
  canClaim: boolean;
  canCreate: boolean;
}

export interface WebhookConfig {
  url: string;
  token: string;
  enabled: boolean;
  runnerPreference?: 'any' | 'user' | 'service' | 'action';
}

export interface WorkspaceProject {
  name: string;
  path?: string;
  description?: string;
  color?: string;
}

export interface Workspace {
  id: string;
  name: string;
  repo: string | null;
  localPath: string | null;
  memory: Record<string, unknown>;
  projects?: WorkspaceProject[];
  webhookConfig?: WebhookConfig | null;
  createdAt: Date;
  updatedAt: Date;
  taskCount?: number;
  activeWorkerCount?: number;
}

export interface Objective {
  id: string;
  teamId: string;
  workspaceId: string | null;
  title: string;
  description: string | null;
  status: ObjectiveStatusValue;
  priority: number;
  cronExpression: string | null;
  scheduleId: string | null;
  parentObjectiveId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  // Relations
  workspace?: Workspace;
  tasks?: Task[];
  subObjectives?: Objective[];
  parentObjective?: Objective;
  // Computed
  progress?: number;
  totalTasks?: number;
  completedTasks?: number;
}

export interface McpToolCall {
  server: string;
  tool: string;
  ts: number;
  ok: boolean;
  durationMs?: number;
}

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
  structuredOutput?: Record<string, unknown>;
  mcpServers?: string[];
}

export interface Task {
  id: string;
  workspaceId: string;
  externalId: string | null;
  externalUrl: string | null;
  title: string;
  description: string | null;
  context: Record<string, unknown>;
  status: TaskStatusType;
  priority: number;
  mode: TaskModeValue;
  runnerPreference: RunnerPreferenceValue;
  requiredCapabilities: string[];
  claimedBy: string | null;
  claimedAt: Date | null;
  expiresAt: Date | null;
  // Creator tracking
  createdByAccountId: string | null;
  createdByWorkerId: string | null;
  creationSource: CreationSourceValue;
  parentTaskId: string | null;
  project?: string | null;
  category?: TaskCategoryValue | null;
  outputRequirement?: OutputRequirementValue;
  outputSchema?: Record<string, unknown> | null;
  // Objective linking
  objectiveId: string | null;
  // Workflow DAG: task IDs that must complete before this task is claimable
  dependsOn: string[];
  result: TaskResult | null;
  createdAt: Date;
  updatedAt: Date;
  workspace?: Workspace;
  objective?: Objective;
  worker?: Worker;
  account?: Account;
  // Creator tracking relations
  creatorAccount?: Account;
  creatorWorker?: Worker;
  parentTask?: Task;
  subTasks?: Task[];
}

export interface Worker {
  id: string;
  taskId: string | null;
  workspaceId: string;
  accountId: string | null;
  name: string;
  runner: string;
  branch: string;
  status: WorkerStatusType;
  waitingFor: WaitingFor | null;
  costUsd: number;
  turns: number;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  mcpCalls?: McpToolCall[];
  task?: Task;
  workspace?: Workspace;
  account?: Account;
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
  workspaceId: string | null;
  key: string | null;
  type: ArtifactTypeValue;
  title: string | null;
  content: string | null;
  storageKey: string | null;
  shareToken: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  url?: string;
}

export interface CreateArtifactInput {
  type: ArtifactTypeValue;
  title: string;
  content?: string;
  url?: string;
  key?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateArtifactInput {
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

/** @deprecated Use Memory service types instead. Kept for backward compat. */
export interface Observation {
  id: string;
  workspaceId: string;
  workerId: string | null;
  taskId: string | null;
  project: string | null;
  type: 'discovery' | 'decision' | 'gotcha' | 'pattern' | 'architecture' | 'summary';
  title: string;
  content: string;
  files: string[];
  concepts: string[];
  createdAt: Date;
}

export interface TaskScheduleTemplate {
  title: string;
  description?: string;
  mode?: TaskModeValue;
  priority?: number;
  runnerPreference?: RunnerPreferenceValue;
  requiredCapabilities?: string[];
  context?: Record<string, unknown>;
}

export interface TaskSchedule {
  id: string;
  workspaceId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  taskTemplate: TaskScheduleTemplate;
  enabled: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastTaskId: string | null;
  totalRuns: number;
  consecutiveFailures: number;
  lastError: string | null;
  maxConcurrentFromSchedule: number;
  pauseAfterFailures: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Recipe {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  category?: 'content' | 'research' | 'code' | 'ops' | 'custom' | null;
  steps: RecipeStep[];
  variables: Record<string, { type: string; description?: string; default?: string }>;
  isPublic: boolean;
  createdAt: string;
}

export interface RecipeStep {
  ref: string;
  title: string;
  description?: string;
  mode?: 'execution' | 'planning';
  dependsOn?: string[];
  requiredCapabilities?: string[];
  outputRequirement?: 'pr_required' | 'artifact_required' | 'none' | 'auto';
  priority?: number;
}

export type WorkspaceSkillOrigin = 'scan' | 'manual';

export interface WorkspaceSkill {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  contentHash: string;
  source: string | null;
  enabled: boolean;
  origin: WorkspaceSkillOrigin;
  metadata: SkillMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillBundleFile {
  path: string;
  content: string;
  executable?: boolean;
  encoding?: 'utf-8' | 'base64';
}

export interface SkillBundle {
  slug: string;
  name: string;
  description?: string;
  content: string;
  contentHash?: string;
  referenceFiles?: Record<string, string>;
  files?: SkillBundleFile[];
}

export interface SkillMetadata {
  version?: string;
  author?: string;
  referenceFiles?: Record<string, string>;
  repoUrl?: string;
  commitSha?: string;
}

// ============================================================================
// MODEL CAPABILITIES (SDK v0.2.49+)
// ============================================================================

export interface ModelCapabilities {
  supportsEffort: boolean;
  supportedEffortLevels: string[];
  supportsAdaptiveThinking: boolean;
}

export interface ModelCapabilitiesEvent {
  model: string;
  capabilities: ModelCapabilities | null;
  warnings: string[];
}

// ============================================================================
// WORKER ENVIRONMENT
// ============================================================================

export interface WorkerTool {
  name: string;
  version?: string;
}

export interface McpServerInfo {
  name: string;
  requiredVars: string[];
  resolved: boolean;
}

export interface WorkerEnvironment {
  tools: WorkerTool[];
  envKeys: string[];
  mcp: string[] | McpServerInfo[];
  mcpServers?: McpServerInfo[];
  labels: Record<string, string>;
  scannedAt: string;
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
  externalId?: string;
  externalUrl?: string;
  title: string;
  description?: string;
  context?: Record<string, unknown>;
  priority?: number;
  mode?: TaskModeValue;
  // Optional creator tracking (typically set by API)
  createdByWorkerId?: string;
  parentTaskId?: string;
  creationSource?: CreationSourceValue;
  // Project scoping
  project?: string;
  // Task category
  category?: TaskCategoryValue;
  // Output requirement — what deliverables are enforced on completion
  outputRequirement?: OutputRequirementValue;
  // JSON Schema for structured output — passed to SDK outputFormat
  outputSchema?: Record<string, unknown>;
  // Objective linking
  objectiveId?: string;
  // Workflow DAG: task IDs that must complete before this task is claimable
  dependsOn?: string[];
}

export interface CreateObjectiveInput {
  title: string;
  description?: string;
  workspaceId?: string;
  cronExpression?: string;
  priority?: number;
  parentObjectiveId?: string;
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

export interface CreateAccountInput {
  type: AccountTypeValue;
  name: string;
  githubId?: string;
  maxConcurrentWorkers?: number;

  // Auth type selection
  authType?: AuthTypeValue;

  // For API auth
  anthropicApiKey?: string;
  maxCostPerDay?: number;

  // For OAuth auth
  /** @deprecated Use the secrets API (purpose='oauth_token') instead. */
  oauthToken?: string;
  seatId?: string;
  maxConcurrentSessions?: number;
}

export interface ClaimTasksInput {
  workspaceId?: string;
  taskId?: string;
  capabilities?: string[];
  maxTasks?: number;
  runner: string;
  environment?: WorkerEnvironment;
}

export type ClaimDiagnosticReason =
  | 'no_slots'
  | 'no_workspaces'
  | 'no_pending_tasks'
  | 'capability_mismatch'
  | 'race_lost';

export interface ClaimDiagnostics {
  reason: ClaimDiagnosticReason;
  pendingTasks?: number;
  matchedTasks?: number;
  activeWorkers?: number;
  maxConcurrent?: number;
  availableSlots?: number;
}

export interface ClaimTasksResponse {
  workers: Array<{
    id: string;
    taskId: string;
    branch: string;
    task: Task;
    skillBundles?: SkillBundle[];
    childResults?: Array<{ id: string; title: string; status: string; result: TaskResult | null }>;
    /** Single-use secret reference for server-managed API key (redeem via GET /api/workers/secret/:ref) */
    secretRef?: string;
    /** Single-use secret reference for server-managed OAuth token (redeem via GET /api/workers/secret/:ref) */
    oauthSecretRef?: string;
    /** Decrypted server-managed API key (inline, no redemption needed) */
    serverApiKey?: string;
    /** Decrypted server-managed OAuth token (inline, no redemption needed) */
    serverOauthToken?: string;
  }>;
  diagnostics?: ClaimDiagnostics;
}

/** @deprecated Use Memory service types instead. Kept for backward compat. */
export interface CreateObservationInput {
  type: 'discovery' | 'decision' | 'gotcha' | 'pattern' | 'architecture' | 'summary';
  title: string;
  content: string;
  files?: string[];
  concepts?: string[];
  workerId?: string;
  taskId?: string;
  project?: string;
}

export interface CreateScheduleInput {
  name: string;
  cronExpression: string;
  timezone?: string;
  taskTemplate: TaskScheduleTemplate;
  enabled?: boolean;
  maxConcurrentFromSchedule?: number;
  pauseAfterFailures?: number;
}

export interface CreateWorkspaceSkillInput {
  slug?: string;
  name: string;
  description?: string;
  content: string;
  source?: string;
  metadata?: SkillMetadata;
  enabled?: boolean;
}


export interface UpdateScheduleInput {
  name?: string;
  cronExpression?: string;
  timezone?: string;
  taskTemplate?: TaskScheduleTemplate;
  enabled?: boolean;
  maxConcurrentFromSchedule?: number;
  pauseAfterFailures?: number;
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
  | 'worker:tool_failure'
  | 'worker:task_started'
  | 'worker:task_notification'
  | 'worker:task_progress'
  | 'worker:notification'
  | 'worker:session_start'
  | 'worker:session_end'
  | 'worker:permission_request'
  | 'worker:config_change'
  | 'worker:rate_limit'
  | 'worker:model_capabilities'
  | 'task:updated'
  | 'task:children_completed'
  | 'task:unblocked';

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
  />\s*\/dev\/(?!null)/,
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

