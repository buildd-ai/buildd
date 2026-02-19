// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export const WorkerStatus = {
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  WAITING_INPUT: 'waiting_input',
  AWAITING_PLAN_APPROVAL: 'awaiting_plan_approval',
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
  BLOCKED: 'blocked',
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
  TASK_PLAN: 'task_plan',
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
} as const;

export type ArtifactTypeValue = typeof ArtifactType[keyof typeof ArtifactType];

export const SourceType = {
  MANUAL: 'manual',
  GITHUB: 'github',
  JIRA: 'jira',
  LINEAR: 'linear',
} as const;

export type SourceTypeValue = typeof SourceType[keyof typeof SourceType];

export const CreationSource = {
  DASHBOARD: 'dashboard',
  API: 'api',
  MCP: 'mcp',
  GITHUB: 'github',
  LOCAL_UI: 'local_ui',
  SCHEDULE: 'schedule',
} as const;

export type CreationSourceValue = typeof CreationSource[keyof typeof CreationSource];

export const ObservationType = {
  DISCOVERY: 'discovery',
  DECISION: 'decision',
  GOTCHA: 'gotcha',
  PATTERN: 'pattern',
  ARCHITECTURE: 'architecture',
  SUMMARY: 'summary',
} as const;

export type ObservationTypeValue = typeof ObservationType[keyof typeof ObservationType];

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
  oauthToken: string | null;
  seatId: string | null;
  maxConcurrentSessions: number | null;
  activeSessions: number;

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

export interface Workspace {
  id: string;
  name: string;
  repo: string | null;
  localPath: string | null;
  memory: Record<string, unknown>;
  webhookConfig?: WebhookConfig | null;
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
  blockedByTaskIds?: string[];
  outputSchema?: Record<string, unknown> | null;
  result: TaskResult | null;
  createdAt: Date;
  updatedAt: Date;
  workspace?: Workspace;
  source?: Source;
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
  type: ArtifactTypeValue;
  title: string | null;
  content: string | null;
  storageKey: string | null;
  shareToken: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  url?: string;
}

export interface CreateArtifactInput {
  type: ArtifactTypeValue;
  title: string;
  content?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface Observation {
  id: string;
  workspaceId: string;
  workerId: string | null;
  taskId: string | null;
  type: ObservationTypeValue;
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

export interface Skill {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  description: string | null;
  contentHash: string;
  content: string | null;
  source: string | null;
  sourceVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillRef {
  skillId: string;
  slug: string;
  contentHash: string;
}

export type WorkspaceSkillOrigin = 'scan' | 'manual' | 'promoted';

export interface WorkspaceSkill {
  id: string;
  workspaceId: string;
  skillId: string | null;
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
// WORKER ENVIRONMENT
// ============================================================================

export interface WorkerTool {
  name: string;
  version?: string;
}

export interface WorkerEnvironment {
  tools: WorkerTool[];
  envKeys: string[];
  mcp: string[];
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
  sourceId?: string;
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
  // Task dependency — blocked tasks start as 'blocked' and auto-unblock when all blockers complete
  blockedByTaskIds?: string[];
  // Skill reference — server resolves slug to contentHash
  skillRef?: { slug: string };
  // JSON Schema for structured output — passed to SDK outputFormat
  outputSchema?: Record<string, unknown>;
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

export interface ClaimTasksResponse {
  workers: Array<{
    id: string;
    taskId: string;
    branch: string;
    task: Task;
    skillBundles?: SkillBundle[];
    childResults?: Array<{ id: string; title: string; status: string; result: TaskResult | null }>;
  }>;
}

export interface CreateObservationInput {
  type: ObservationTypeValue;
  title: string;
  content: string;
  files?: string[];
  concepts?: string[];
  workerId?: string;
  taskId?: string;
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

export interface RegisterSkillInput {
  slug: string;
  name: string;
  description?: string;
  contentHash: string;
  content?: string;
  source?: string;
  sourceVersion?: string;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  contentHash?: string;
  content?: string;
  source?: string;
  sourceVersion?: string;
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

export interface SyncWorkspaceSkillsInput {
  skills: Array<{
    slug: string;
    name: string;
    description?: string;
    content: string;
    contentHash: string;
    source?: string;
  }>;
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
  | 'worker:notification'
  | 'worker:session_start'
  | 'worker:session_end'
  | 'worker:permission_request'
  | 'worker:rate_limit'
  | 'task:updated'
  | 'task:unblocked'
  | 'task:children_completed';

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

// ============================================================================
// REMOTE SKILL INSTALLATION
// ============================================================================

export const DEFAULT_SKILL_INSTALLER_ALLOWLIST = [
  'buildd skill install',
] as const;

export interface SkillInstallPayload {
  requestId: string;
  skillSlug: string;
  /** Content push — mutually exclusive with installerCommand */
  bundle?: SkillBundle;
  /** Command execution — mutually exclusive with bundle */
  installerCommand?: string;
  /** Targeting (optional) — only the matching local-ui handles the install */
  targetLocalUiUrl?: string | null;
}

export interface SkillInstallResult {
  requestId: string;
  skillSlug: string;
  localUiUrl?: string;
  success: boolean;
  method: 'content_push' | 'installer_command';
  output?: string;
  error?: string;
  timestamp: number;
}

export function validateInstallerCommand(
  command: string,
  config: {
    workspaceAllowlist?: string[];
    localAllowlist?: string[];
    rejectAll?: boolean;
  }
): { allowed: boolean; reason?: string } {
  if (config.rejectAll) {
    return { allowed: false, reason: 'Worker rejects remote installer commands' };
  }
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: 'Blocked by dangerous pattern' };
    }
  }
  const allowlist = config.localAllowlist ?? config.workspaceAllowlist ?? [...DEFAULT_SKILL_INSTALLER_ALLOWLIST];
  const trimmed = command.trim();
  if (!allowlist.some(prefix => trimmed.startsWith(prefix))) {
    return { allowed: false, reason: `No matching allowlist prefix. Allowed: ${allowlist.join(', ')}` };
  }
  return { allowed: true };
}
