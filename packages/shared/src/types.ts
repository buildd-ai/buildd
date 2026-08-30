// ============================================================================
// UTILS
// ============================================================================

/** System workspaces (prefixed with __) are auto-managed and hidden from UI */
export function isSystemWorkspace(name: string): boolean {
  return name.startsWith('__');
}

/** Returns a user-friendly display name for a workspace, replacing internal names */
export function displayWorkspaceName(name: string): string {
  if (isSystemWorkspace(name)) return 'Organizer';
  return name;
}

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
  FILE: 'file',
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
  ORCHESTRATOR: 'orchestrator',
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
  REVIEW: 'review',
} as const;

export type TaskCategoryValue = typeof TaskCategory[keyof typeof TaskCategory];

export const MissionStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
} as const;

export type MissionStatusValue = typeof MissionStatus[keyof typeof MissionStatus];

export type AgentBackend = 'claude' | 'codex';

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
  budgetExhaustedAt: string | null;
  budgetResetsAt: string | null;
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
  accessMode?: 'open' | 'restricted';
  dataClass?: 'standard' | 'sensitive';
  createdAt: Date;
  updatedAt: Date;
  taskCount?: number;
  activeWorkerCount?: number;
}

export interface Mission {
  id: string;
  teamId: string;
  workspaceId: string | null;
  title: string;
  description: string | null;
  status: MissionStatusValue;
  priority: number;
  defaultBackend?: AgentBackend | null;
  scheduleId: string | null;
  parentMissionId: string | null;
  createdByUserId: string | null;
  requiresReview: boolean;
  mergePolicy?: MergePolicy | null;
  startAt?: Date | null;
  startResolution?: 'explicit' | 'relative' | 'known_budget_reset' | 'default_budget_window' | null;
  createdAt: Date;
  updatedAt: Date;
  // Relations
  workspace?: Workspace;
  tasks?: Task[];
  subMissions?: Mission[];
  parentMission?: Mission;
  // Computed
  progress?: number;
  totalTasks?: number;
  completedTasks?: number;
}

// ============================================================================
// WORKSPACE POLICY — semantic risk classes and preset tiers
// ============================================================================

/** A workspace-level policy preset. Controls how each risk class is escalated. */
export type WorkspacePolicyPreset = 'cautious' | 'balanced' | 'autonomous';

/**
 * Universal semantic risk classes — these are the same across every repo.
 * What paths satisfy each class is detected per-repo, never hand-typed.
 */
export type RiskClassName =
  | 'destructive_schema_change'  // ORM migrations + schema files
  | 'ci_deploy_config'           // GitHub Actions, Dockerfiles, deploy configs
  | 'auth_and_secrets'           // Auth modules, secret loaders, .env schemas
  | 'dependency_bump'            // Lockfiles and package manifests
  | 'public_api_contract';       // Shared types, OpenAPI specs, public surface

/** Action for a risk class within a given preset tier. */
export type RiskClassAction = 'human' | 'agent-review' | 'auto';

/** One risk class entry in a workspace policy. Paths are always detected, never typed. */
export interface RiskClassEntry {
  name: RiskClassName;
  /** Auto-detected paths for this class in this repo. Set by init scan, never by user. */
  detectedPaths: string[];
  /** Optional user additions — visible, editable, but empty by default. */
  userPaths?: string[];
}

/**
 * New workspace policy model — supersedes `agentReview.escalateToPaths` when present.
 * A single preset selects per-class escalation behavior; detected paths are derived,
 * not authored. The reviewer sees intent ("destructive schema changes escalate here"),
 * not a raw glob list.
 */
export interface WorkspacePolicyConfig {
  preset: WorkspacePolicyPreset;
  riskClasses: RiskClassEntry[];
  /** Required when preset implies agent-review escalation for any class. */
  reviewerRole?: string;
}

// ============================================================================
// MERGE POLICY
// ============================================================================

export type MergePolicyTier =
  | 'auto-threshold'  // Tier 1 — CI-gated with size/path constraints
  | 'agent-review'    // Tier 2 — agent reviewer judges before merging
  | 'human';          // Tier 3 — explicit human gate, no auto-merge

export interface MergePolicy {
  tier: MergePolicyTier;

  // Tier 1 config (all optional; defaults match existing gitConfig behavior)
  threshold?: {
    maxLines?: number;          // total additions+deletions; default 800
    maxSourceLines?: number;    // non-test lines only; default = maxLines
    denyPaths?: string[];       // block if any touched file starts with these prefixes
  };

  // Tier 2 config (required when tier = 'agent-review')
  agentReview?: {
    reviewerRole: string;               // slug of reviewer skill in workspace_skills
    escalateToPaths?: string[];         // force escalate if any touched file matches
    maxConfidenceThreshold?: number;    // 0–1; escalate if confidence < threshold (default 0.6)
    gateCondition?: 'approve-and-merge' | 'approve-only'; // default 'approve-and-merge'
  };

  // How long a PR can sit at this tier before notifying
  stallNotifyMinutes?: number;  // default: 30 for human/agent-review, 5 for auto-threshold
}

const VALID_TIERS: MergePolicyTier[] = ['auto-threshold', 'agent-review', 'human'];
const KNOWN_TOP_KEYS = new Set(['tier', 'threshold', 'agentReview', 'stallNotifyMinutes']);
const KNOWN_THRESHOLD_KEYS = new Set(['maxLines', 'maxSourceLines', 'denyPaths']);
const KNOWN_AGENT_REVIEW_KEYS = new Set(['reviewerRole', 'escalateToPaths', 'maxConfidenceThreshold', 'gateCondition']);

export type MergePolicyParseResult =
  | { ok: true; policy: MergePolicy }
  | { ok: false; error: string; field?: string };

export function parseMergePolicy(val: unknown): MergePolicyParseResult {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return { ok: false, error: 'mergePolicy must be an object' };
  }
  const obj = val as Record<string, unknown>;

  // Reject unknown top-level keys
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      return { ok: false, error: `mergePolicy has unknown field: ${key}`, field: key };
    }
  }

  if (!VALID_TIERS.includes(obj.tier as MergePolicyTier)) {
    return {
      ok: false,
      error: `mergePolicy.tier must be one of: ${VALID_TIERS.join(', ')}`,
      field: 'tier',
    };
  }

  if (obj.threshold !== undefined) {
    if (!obj.threshold || typeof obj.threshold !== 'object' || Array.isArray(obj.threshold)) {
      return { ok: false, error: 'mergePolicy.threshold must be an object', field: 'threshold' };
    }
    for (const key of Object.keys(obj.threshold as object)) {
      if (!KNOWN_THRESHOLD_KEYS.has(key)) {
        return { ok: false, error: `mergePolicy.threshold has unknown field: ${key}`, field: `threshold.${key}` };
      }
    }
  }

  if (obj.agentReview !== undefined) {
    if (!obj.agentReview || typeof obj.agentReview !== 'object' || Array.isArray(obj.agentReview)) {
      return { ok: false, error: 'mergePolicy.agentReview must be an object', field: 'agentReview' };
    }
    for (const key of Object.keys(obj.agentReview as object)) {
      if (!KNOWN_AGENT_REVIEW_KEYS.has(key)) {
        return { ok: false, error: `mergePolicy.agentReview has unknown field: ${key}`, field: `agentReview.${key}` };
      }
    }
    const ar = obj.agentReview as Record<string, unknown>;
    if (typeof ar.reviewerRole !== 'string' || !ar.reviewerRole) {
      return { ok: false, error: 'mergePolicy.agentReview.reviewerRole must be a non-empty string', field: 'agentReview.reviewerRole' };
    }
  }

  return { ok: true, policy: obj as unknown as MergePolicy };
}

export type MissionNoteAuthorType = 'agent' | 'user' | 'system';
export type MissionNoteType =
  | 'decision'
  | 'question'
  | 'warning'
  | 'suggestion'
  | 'update'
  | 'reply'
  | 'guidance'
  | 'reviewer_approved'
  | 'reviewer_request_changes'
  | 'reviewer_escalated';
export type MissionNoteStatus = 'open' | 'answered' | 'dismissed';

export interface MissionNote {
  id: string;
  missionId: string;
  taskId: string | null;
  workerId: string | null;
  authorType: MissionNoteAuthorType;
  type: MissionNoteType;
  title: string;
  body: string | null;
  replyTo: string | null;
  defaultChoice: string | null;
  status: MissionNoteStatus;
  createdAt: Date;
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
  nextSuggestion?: string;
  /** Set by the stale-worker reaper when it auto-completes a task that delivered a PR/artifact. */
  reaperAutoCompleted?: boolean;
}

/**
 * Structured artifact protocol for task results.
 *
 * This defines the TARGET shape that task results should converge towards.
 * Existing tasks may not match this shape — consumers must handle missing fields.
 * The orchestrator uses this structure to reason about completed work and decide next steps.
 */
export interface TaskArtifactResult {
  type: 'summary' | 'finding' | 'report' | 'review' | 'error';
  output: string;
  status: 'completed' | 'needs_followup' | 'blocked';
  nextSuggestion?: string;
  metadata?: {
    pr?: string;
    prNumber?: number;
    branch?: string;
    filesChanged?: number;
    commitCount?: number;
    custom?: Record<string, unknown>;
  };
}

export interface RetryFailureContext {
  /** Human-readable summary of the failure (CI log excerpt, reviewer feedback, error message). */
  summary: string;
  /** Broad category for programmatic routing. */
  errorType?: 'ci_failure' | 'reviewer_request_changes' | 'runtime_error' | 'timeout' | 'budget_exhausted';
  /** SHA of the last commit on the prior attempt's branch (same as context.lastCommitSha). */
  commitSha?: string;
}

export interface TaskRetryContext {
  /** Branch name from the prior attempt (e.g. "buildd/abc123-fix-login-flow"). */
  resumeBranch?: string;
  /** SHA of the last commit on resumeBranch, captured at failure time. */
  lastCommitSha?: string;
  /** Structured failure context from the prior attempt. */
  failureContext?: RetryFailureContext | string; // string for backward compat with existing tasks
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
  // Mission linking
  missionId: string | null;
  // Workflow DAG: task IDs that must complete before this task is claimable
  dependsOn: string[];
  // Declared files/globs this task expects to create or modify
  pathManifest?: string[] | null;
  // Connector IDs this task requires — subset of the role's connectorRefs.
  // Only these connectors trigger a hard claim-block when unavailable.
  requiredConnectors?: string[] | null;
  result: TaskResult | null;
  backend?: AgentBackend;
  requiresReview?: boolean;
  startAt?: Date | null;
  // Loop primitive — null when not a looped task (behaves exactly as today)
  loopConfig?: LoopConfig | null;
  loopIteration?: number;
  loopState?: LoopState | null;
  createdAt: Date;
  updatedAt: Date;
  workspace?: Workspace;
  mission?: Mission;
  worker?: Worker;
  account?: Account;
  // Creator tracking relations
  creatorAccount?: Account;
  creatorWorker?: Worker;
  parentTask?: Task;
  subTasks?: Task[];
}

export type WorkerExitCause =
  | 'code_failure'
  | 'budget_limited'
  | 'infra_failure'
  | 'reassigned'
  | 'condition_unmet'
  | 'sandbox_mount_gap';

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
  exitCause?: WorkerExitCause | null;
  createdAt: Date;
  updatedAt: Date;
  mcpCalls?: McpToolCall[];
  task?: Task;
  workspace?: Workspace;
  account?: Account;
  artifacts?: Artifact[];
}

export interface WaitingForOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface WaitingFor {
  type: 'question' | 'permission' | 'confirmation';
  prompt: string;
  options?: (string | WaitingForOption)[];
}

/** Normalize mixed options (string[] or WaitingForOption[]) to WaitingForOption[] */
export function normalizeWaitingForOptions(
  raw?: (string | WaitingForOption)[] | null
): WaitingForOption[] | undefined {
  if (!raw?.length) return undefined;
  return raw.map((o) =>
    typeof o === 'string' ? { label: o } : o
  );
}

/** Artifact access control. Private artifacts are visible only to logged-in
 *  workspace members; public artifacts are viewable by anyone with the share link. */
export type ArtifactVisibility = 'private' | 'public';

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
  visibility: ArtifactVisibility;
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

export type WorkspaceSkillOrigin = 'scan' | 'manual';

export type SkillModel = 'sonnet' | 'opus' | 'haiku' | 'inherit' | (string & {});

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
  // Role config
  model: SkillModel;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
  color: string;
  /** @deprecated Superseded by `connectorRefs`. Kept for back-compat during rollout. */
  mcpServers: string[];
  /** @deprecated Superseded by `connectorRefs`. Kept for back-compat during rollout. */
  requiredEnvVars: Record<string, string>;
  /** IDs of connectors (connectors table) this role mounts. */
  connectorRefs: string[];
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
  // Role config
  model: SkillModel;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
  /** @deprecated Superseded by `connectorRefs`. Kept for back-compat during rollout. */
  mcpServers: string[];
  /** @deprecated Superseded by `connectorRefs`. Kept for back-compat during rollout. */
  requiredEnvVars: Record<string, string>;
  /** IDs of connectors (connectors table) this role mounts. */
  connectorRefs?: string[];
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'stdio' | 'http';
  url?: string;
}

export interface RoleConfig {
  slug: string;
  configHash: string;
  configUrl: string;
  type: 'builder' | 'service';
  repoUrl?: string;
  model: string;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
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
  // Mission linking
  missionId?: string;
  // Workflow DAG: task IDs that must complete before this task is claimable
  dependsOn?: string[];
  // Declared files/globs this task expects to create or modify
  pathManifest?: string[];
  // Agent backend that executes this task
  backend?: AgentBackend;
}

export interface CreateMissionInput {
  title: string;
  description?: string;
  workspaceId?: string;
  cronExpression?: string;
  priority?: number;
  parentMissionId?: string;
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
  availableSkills?: string[]; // skill slugs this runner can execute
  // Explicit opt-in for a multi-workspace OAuth token to claim the next pending
  // task across ALL its accessible workspaces in one call (server ranks/picks).
  // Distinguishes a deliberate cross-workspace runner poll from an accidental
  // ambiguous claim (the 2026-05-25 misroute class), which stays rejected.
  claimAcrossAccessible?: boolean;
}

export type ClaimDiagnosticReason =
  | 'no_slots'
  | 'no_workspaces'
  | 'no_pending_tasks'
  | 'capability_mismatch'
  | 'race_lost'
  | 'all_candidates_deferred'
  | 'deps_blocked'
  | 'repo_busy'
  | 'budget_exhausted'
  | 'budget_exhausted_partial'
  | 'context_paused'
  | 'path_overlap_blocked';

export interface ClaimDiagnostics {
  reason: ClaimDiagnosticReason;
  pendingTasks?: number;
  matchedTasks?: number;
  activeWorkers?: number;
  maxConcurrent?: number;
  availableSlots?: number;
  /** Populated when reason=path_overlap_blocked: the PR that conflicts with this task's pathManifest */
  blockedByPr?: { prNumber: number | null; prUrl: string | null };
  /**
   * Populated when reason=all_candidates_deferred: per-reason breakdown of why
   * every candidate in the window was skipped without a claim attempt.
   */
  deferrals?: {
    connector_mismatch?: number;
    subject_dead?: number;
    path_overlap?: number;
    /** Scope-undeclared ('**') task held behind a sibling in the same mission. */
    advisory_manifest?: number;
    mission_budget?: number;
    mission_concurrent?: number;
    mission_paced?: number;
    workspace_cap?: number;
    provider_unavailable?: number;
    budget_paused?: number;
    routing_paused?: number;
  };
  /**
   * Learned OAuth budget pressure for this account (seat-based auth only).
   * pct is 0..1 of the capacity learned from past exhaustion episodes; the
   * router downshifts tiers as it rises and pauses priority-0 work at 0.95.
   * Absent when the account is API-billed or has too few episodes to learn from.
   * See packages/core/oauth-budget.ts.
   */
  budgetPressure?: {
    pct: number;
    limiter: 'workers' | 'turns' | 'tokens' | null;
    confidence: 'low' | 'good';
    samples: number;
  };
}

/**
 * Claim payload shape for assertion-mode connectors (spec §E.3).
 * The runner performs the mint + exchange flow before opening the MCP connection.
 */
export interface AssertionConnectorEntry {
  name: string;
  transport?: 'http';
  url: string;
  assertionMode: true;
  mintApiUrl: string;
  audience: string;
  tokenEndpoint: string;
}

/** A connector that failed availability checks but is not hard-required for the task.
 *  Delivered when the workspace has connector_advisory_mode=true and the task has no
 *  requiredConnectors overlap with the failing connector. The runner injects a
 *  system-prompt notice so the agent knows which tools are unavailable. */
export interface DegradedConnector {
  id: string;
  name: string;
  failureMode: 'never_mounted' | 'expired_or_revoked' | 'transient';
  detail?: string;
}

export interface ClaimTasksResponse {
  workers: Array<{
    id: string;
    taskId: string;
    branch: string;
    task: Task;
    skillBundles?: SkillBundle[];
    childResults?: Array<{ id: string; title: string; status: string; result: TaskResult | null }>;
    /** Decrypted server-managed API key (inline) */
    serverApiKey?: string;
    /** Decrypted server-managed OAuth token (inline) */
    serverOauthToken?: string;
    /**
     * Access token from a managed claude_credential (centrally refreshed).
     * When set, the runner creates a per-worker CLAUDE_CONFIG_DIR and writes
     * a credentials file with ONLY this access_token — no refresh_token —
     * preventing in-session token rotation by workers.
     */
    claudeAccessToken?: string;
    /** When the claudeAccessToken expires (epoch ms). Used by the runner for preflight checks. */
    claudeTokenExpiresAt?: string | null;
    /** Credentials expiring within 2 hours — runner pre-refreshes via POST /api/runner/credential-refresh */
    pendingCredentialRefreshes?: Array<{
      secretId: string;
      purpose: 'claude_credential' | 'codex_credential';
      expiresAt: string | null; // ISO 8601 — runner decides whether to refresh
    }>;
    /** Decrypted MCP credential secrets mapped by label (env var name) → value */
    mcpSecrets?: Record<string, string>;
    /** Active MCP connector configs resolved at claim time (URL + optional auth headers, or assertion-mode exchange metadata) */
    mcpConnectors?: Array<
      | { name: string; transport?: 'http' | 'stdio'; url?: string; command?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string> }
      | AssertionConnectorEntry
    >;
    /** Decrypted Codex credential (only present for backend=codex tasks) */
    codexCredential?: {
      credentialType: 'oauth' | 'api_key';
      /** OAuth fields — present when credentialType === 'oauth' */
      accessToken?: string;
      refreshToken?: string;
      accountId?: string;
      /** API key — present when credentialType === 'api_key' */
      apiKey?: string;
      expiresAt: Date | null;
    };
    /** Role configuration for the claimed task's assigned role */
    roleConfig?: RoleConfig;
    /** Connectors that failed availability checks but are not hard-required (advisory mode only).
     *  Present when workspace.connectorAdvisoryMode=true and the task claimed despite connector failures. */
    degradedConnectors?: DegradedConnector[];
  }>;
  diagnostics?: ClaimDiagnostics;
  /** ISO timestamp when the account's OAuth budget resets (present when budget is exhausted but tenant tasks were still served) */
  budgetResetsAt?: string | null;
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
  // Role config
  model?: SkillModel;
  allowedTools?: string[];
  canDelegateTo?: string[];
  background?: boolean;
  maxTurns?: number;
  color?: string;
  /** @deprecated Superseded by `connectorRefs`. Kept for back-compat during rollout. */
  mcpServers?: string[];
  /** @deprecated Superseded by `connectorRefs`. Kept for back-compat during rollout. */
  requiredEnvVars?: Record<string, string>;
  /** IDs of connectors (connectors table) this role mounts. */
  connectorRefs?: string[];
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
// LOOP PRIMITIVE (condition-driven task loops)
// See docs/design/loop-until-verified.md
// ============================================================================

export type LoopExitCondition =
  | { type: 'command'; command?: string }
  | { type: 'pr_checks_green' }
  | { type: 'pr_merged' }
  | {
      type: 'structured_predicate';
      predicate?: {
        /** JSON Pointer into TaskResult.structuredOutput */
        path: string;
        operator: 'eq' | 'neq' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte';
        value?: string | number | boolean | null;
      };
    };

export interface LoopConfig {
  exitCondition: LoopExitCondition;
  /** 1–50, defaults to 5 */
  maxLoops?: number;
  /** 0–10080 (7 days in minutes), defaults to 0 */
  backoffMinutes?: number;
  /** Max minutes to wait for a pr_merged condition before the reaper may fail the task. Default 240 (4h). */
  waitExpiryMinutes?: number;
}

export type LoopState =
  | 'running'
  | 'condition_unmet'
  | 'exhausted'
  | 'satisfied';

export interface LoopHistoryEntry {
  iteration: number;
  workerId: string;
  evaluatedAt: string;
  conditionType: LoopExitCondition['type'];
  satisfied: boolean;
  summary: string;
  evidence?: Record<string, unknown>;
}

// Subject anchor — normalized external identity for what a task acts on.
// Stored as JSONB in tasks.subject_anchor; relational columns are write-through
// projections for indexed lookup. See docs/design/task-subject-anchors.md §1.
export interface TaskSubjectAnchor {
  version: 1;
  kind: 'pull_request' | 'error' | 'mission' | 'branch';
  prNumber?: number;
  headSha?: string;
  branch?: string;
  errorSignature?: string;
  failingCheckNames?: string[];
  subjectMissionId?: string;
  source: 'context' | 'url' | 'text' | 'system' | 'backfill';
  confidence: 'exact' | 'derived';
}

export type SubjectIntakeOutcome =
  | { action: 'attached'; taskId: string; reportId: string }
  | { action: 'superseded'; taskId: string; successorTaskId: string }
  | {
      action: 'filed_anyway';
      taskId: string;
      relatedTaskId: string;
      reason: string;
    }
  | { action: 'created'; taskId: string };

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

// Paths that must not be readable by the agent (runner credential files at known locations).
// Enforced in PreToolUse hook for the Read tool — capability scoping: the env
// simply should not contain these files in readable form from agent context.
export const SENSITIVE_READ_PATHS = [
  /[/\\]\.buildd[/\\]config(\.json)?$/,      // runner API key (~/.buildd/config.json)
  /[/\\]\.claude[/\\]\.credentials\.json$/,  // Claude OAuth token file
] as const;

// Bash command patterns that read runner-level credential files.
// Used by the permission hook alongside DANGEROUS_PATTERNS to block bash
// commands that would exfiltrate runner secrets even if the Read tool is blocked.
export const DANGEROUS_CREDENTIAL_READ_PATTERNS = [
  // Matches cat/head/tail/less/more reading the runner config file
  /\b(?:cat|head|tail|less|more|bat)\b[^|]*[/\\]\.buildd[/\\]config/,
  // Matches reading Claude credential files
  /\b(?:cat|head|tail|less|more|bat)\b[^|]*\.credentials\.json/,
  // Direct printenv/env output that names the runner coordination key
  /\bprintenv\s+BUILDD_API_KEY\b/,
  /\benv\b.*\bBUILD_API_KEY\b/,
] as const;

// Runner capability keys — advertised in WorkerEnvironment.envKeys, matched
// against Task.requiredCapabilities during claim.
// Use these constants everywhere so typos can't cause silent mismatches.
export const CAPABILITY_BROWSER = 'browser';

// ============================================================================
// GOAL CRITERIA & INITIATIVE KPIs
// ============================================================================

export type GoalCriterionType =
  | 'all_prs_merged'
  | 'command'
  | 'no_open_tasks'
  | 'artifact_exists'
  | 'metric'
  | 'description';

/**
 * A criterion's verdict.
 *
 * Only `pass` may gate a mission to `completed`. Everything else — including
 * `PENDING` and `NOT_EVALUATED` — means "we do not have a verdict", which is
 * never the same thing as "satisfied".
 *
 * - `pass` / `fail`      — a verdict was produced from evidence.
 * - `UNVERIFIED`         — checked, but the evidence was ambiguous or absent.
 * - `PENDING`            — a verification run is in flight (e.g. a `command`
 *                          criterion whose verification task is dispatched).
 * - `NOT_EVALUATED`      — never checked: no evaluator was reachable.
 */
export type CriterionVerdict = 'pass' | 'fail' | 'UNVERIFIED' | 'PENDING' | 'NOT_EVALUATED';

export type GoalCriterion =
  | {
      type: 'all_prs_merged';
      requireBranchDeleted?: boolean;
      label?: string;
    }
  | {
      /**
       * Mechanical criterion: a command that must exit 0. Verified by dispatching
       * a verification task whose runner executes the command and returns
       * tamper-evident evidence — never by asking a model whether it would pass.
       */
      type: 'command';
      command: string;
      label?: string;
    }
  | {
      type: 'no_open_tasks';
      label?: string;
    }
  | {
      type: 'artifact_exists';
      key?: string;
      artifactType?: string;
      label?: string;
    }
  | {
      /**
       * Reserved for the metric-query registry, which does not exist yet: these
       * evaluate to UNVERIFIED forever and so would block completion
       * permanently. Rejected at the write boundary — do not use as a gate.
       */
      type: 'metric';
      query: string;
      operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
      threshold: number;
      unit?: string;
      label?: string;
    }
  | {
      /**
       * Free-form natural-language criterion, graded by an LLM against mission
       * evidence. The escape hatch of last resort: its verdict depends on a model
       * being reachable at the moment it is needed, so it is the one criterion
       * form that can silently degrade to NOT_EVALUATED.
       *
       * Because of that, writing one requires stating why no mechanical form
       * (`command` / `all_prs_merged` / `no_open_tasks` / `artifact_exists`)
       * could express the same thing — see `notMechanizableReason`.
       */
      type: 'description';
      description: string;
      /**
       * Why this criterion could not be expressed mechanically. Required on write
       * (POST/PATCH /api/missions); rows written before this field existed are
       * read back unchanged.
       */
      notMechanizableReason?: string;
      label?: string;
    };

export interface GoalCriteriaEvidenceRef {
  type: 'artifact' | 'task';
  id: string;
  title?: string;
}

export interface GoalCriteriaState {
  evaluatedAt: string;
  evaluatedBy: 'auto' | 'manual' | 'mcp';
  overall: CriterionVerdict;
  criteria: Array<{
    index: number;
    type: GoalCriterionType;
    label?: string;
    verdict: CriterionVerdict;
    evidence?: string;
    evidenceRefs?: GoalCriteriaEvidenceRef[];
    /**
     * The verification task that owns this criterion's verdict (`command`
     * criteria). Present while the verdict is PENDING and kept afterwards as
     * the provenance of a pass/fail.
     */
    workerTaskId?: string;
    /**
     * Identity of the criterion this verdict was produced for, from
     * `criterionFingerprint()`. Array index alone is NOT identity: deleting one
     * criterion renumbers the rest, and a cached verdict keyed on index would
     * then be read as belonging to a criterion nobody evaluated. Any reuse of a
     * stored verdict MUST match on this.
     */
    fingerprint?: string;
  }>;
}

export interface InitiativeKPI {
  name: string;
  metric: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  threshold: number;
  unit?: string;
  blocking?: boolean;
}

export interface InitiativeKPIState {
  evaluatedAt: string;
  evaluatedBy: 'auto' | 'manual' | 'mcp';
  overall: CriterionVerdict;
  kpis: Array<{
    index: number;
    name: string;
    verdict: CriterionVerdict;
    observedValue?: number;
    evidence?: string;
  }>;
}
export const CAPABILITY_SANDBOX_MOUNT_ALLOWLIST = 'sandbox:mount-allowlist';
