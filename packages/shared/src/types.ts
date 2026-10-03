import type { TaskStatusValue, WorkerStatusValue, MissionStatusValue } from './status';
import type { RunnerFleetIdentity } from './runner-fleet';
import type { ClaudeAiArtifactAccess } from './claude-ai-artifacts';

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
  FAILED: 'failed',
  ERROR: 'error',
  SUPERSEDED: 'superseded',
  /** Legacy: old rows only. */
  DONE: 'done',
} as const satisfies Record<string, WorkerStatusValue>;

/** Same union as `WorkerStatusValue` (./status). */
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
  /** Legacy: never written today. */
  REVIEW: 'review',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const satisfies Record<string, TaskStatusValue>;

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

/**
 * The one authoritative artifact vocabulary.
 *
 * Every writer (worker / mission / initiative / upload-url routes and the MCP
 * `create_artifact` action) MUST validate against this via `isArtifactType`.
 * Four sites used to keep private accepted-type sets of 17, 12, 8 and 6 entries,
 * so whether an agent's artifact was accepted depended on which route it hit.
 * Add a type here and it is accepted everywhere; nowhere else gets a list.
 */
export const ARTIFACT_TYPES: readonly ArtifactTypeValue[] = Object.values(ArtifactType);

/** Type guard for untrusted input (request bodies, MCP params). */
export function isArtifactType(value: unknown): value is ArtifactTypeValue {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/**
 * Human labels for the vocabulary, keyed by type. The artifact UI reads these
 * instead of keeping its own table — a duplicated table is how four of these
 * types ended up renderable but unwritable.
 */
export const ARTIFACT_TYPE_LABELS: Record<ArtifactTypeValue, string> = {
  [ArtifactType.IMPL_PLAN]: 'Implementation Plan',
  [ArtifactType.SCREENSHOT]: 'Screenshot',
  [ArtifactType.RECORDING]: 'Recording',
  [ArtifactType.DIFF]: 'Diff',
  [ArtifactType.WALKTHROUGH]: 'Walkthrough',
  [ArtifactType.SUMMARY]: 'Summary',
  [ArtifactType.CONTENT]: 'Content',
  [ArtifactType.REPORT]: 'Report',
  [ArtifactType.DATA]: 'Data',
  [ArtifactType.LINK]: 'Link',
  [ArtifactType.EMAIL_DRAFT]: 'Email Draft',
  [ArtifactType.SOCIAL_POST]: 'Social Post',
  [ArtifactType.ANALYSIS]: 'Analysis',
  [ArtifactType.RECOMMENDATION]: 'Recommendation',
  [ArtifactType.ALERT]: 'Alert',
  [ArtifactType.CALENDAR_EVENT]: 'Calendar Event',
  [ArtifactType.FILE]: 'File',
};

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
  RESEARCH: 'research',
} as const;

export type TaskCategoryValue = typeof TaskCategory[keyof typeof TaskCategory];

export const MissionStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
  BUDGET_EXHAUSTED: 'budget_exhausted',
} as const satisfies Record<string, MissionStatusValue>;

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
  scopes?: string[] | null;
  workspaceIds?: string[] | null;
  expiresAt?: Date | string | null;
  lastUsedAt?: Date | string | null;
  id: string;
  type: AccountTypeValue;
  name: string;
  apiKey: string;
  apiKeyPrefix: string | null;
  githubId: string | null;

  // Authentication type
  authType: AuthTypeValue;

  // For API-based auth (pay-per-token)
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

/**
 * `webhookConfig` as the workspace API returns it: the bearer token is never
 * serialised, only whether one is set (apps/web/src/lib/workspace-public.ts).
 */
export interface PublicWebhookConfig {
  url: string | null;
  enabled: boolean;
  runnerPreference?: 'any' | 'user' | 'service' | 'action';
  hasToken: boolean;
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
  webhookConfig?: PublicWebhookConfig | null;
  accessMode?: 'open' | 'restricted';
  dataClass?: 'standard' | 'sensitive';
  createdAt: Date;
  updatedAt: Date;
  taskCount?: number;
  activeWorkerCount?: number;
}

/**
 * Who executes a mission's tasks. 'runner' (default): background runners
 * auto-claim them. 'local': a person runs them from their own interactive
 * session (explicit claim_task {taskId}); runners never auto-claim. Orthogonal
 * to the held pause, which wins over both.
 */
export type MissionExecutor = 'runner' | 'local';

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
  isHeld?: boolean;
  executor?: MissionExecutor;
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
  /**
   * @deprecated Hand-written additions are no longer accepted on write and are
   * ignored when matching. Refresh `detectedPaths` with a re-scan instead.
   */
  userPaths?: string[];
}

/**
 * Workspace policy model — the only source of merge-policy paths.
 * A single preset selects per-class escalation behavior; detected paths are derived,
 * not authored. The reviewer sees intent ("destructive schema changes escalate here"),
 * not a raw glob list.
 */
export interface WorkspacePolicyConfig {
  preset: WorkspacePolicyPreset;
  riskClasses: RiskClassEntry[];
  /** Required when preset implies agent-review escalation for any class. */
  reviewerRole?: string;
  /**
   * Pre-inject the PR's patch text into the reviewer task, instead of only the
   * changed-filename list. Off by default: it changes what the reviewer's
   * verdict is based on, so a workspace opts in rather than discovering it.
   * See `docs/design/reviewer-evidence-and-verification.md`.
   */
  reviewerPatchEvidence?: boolean;
  /** Token ceiling for that patch. Defaults to `REVIEWER_PATCH_TOKEN_BUDGET`. */
  reviewerPatchTokenBudget?: number;
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
    /**
     * @deprecated Hand-written; rejected on write. Still read (prefix match) as a
     * one-release fallback for stored values — see `LEGACY_PATH_FALLBACK_NOTE`.
     */
    denyPaths?: string[];
  };

  // Tier 2 config (required when tier = 'agent-review')
  agentReview?: {
    reviewerRole: string;               // slug of reviewer skill in workspace_skills
    /**
     * @deprecated Hand-written; rejected on write. Still read (prefix match) as a
     * one-release fallback for stored values — see `LEGACY_PATH_FALLBACK_NOTE`.
     */
    escalateToPaths?: string[];
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

// ── Removed hand-written path fields ────────────────────────────────────────
//
// Merge-policy paths are auto-detected from the repo (POST /policy-init →
// policyConfig.riskClasses[].detectedPaths). The hand-typed lists below are
// refused on every write path; stored values are still read for one release.

/**
 * Dated marker for the read-only fallback that still honours stored
 * `escalateToPaths` / `denyPaths`. Added 2026-09-24; remove the fallback (and
 * these fields from the types) in the next release.
 */
export const LEGACY_PATH_FALLBACK_NOTE = 'legacy-hand-written-paths: read-only fallback added 2026-09-24, remove next release';

/** 400 body text for a request that carries a removed path field. */
export function removedPolicyPathFieldError(field: string): string {
  return `${field} is no longer accepted: merge-policy paths are detected from the repo, not typed. ` +
    `Use "Re-scan repo" on the workspace Merge Policy page (or MCP manage_workspaces action=init) to refresh them.`;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** First removed path field present in a MergePolicy-shaped value, as a dotted path under `prefix`. */
export function findRemovedPathFieldInMergePolicy(mp: unknown, prefix = 'mergePolicy'): string | null {
  if (!isObj(mp)) return null;
  if (isObj(mp.threshold) && 'denyPaths' in mp.threshold) return `${prefix}.threshold.denyPaths`;
  if (isObj(mp.agentReview) && 'escalateToPaths' in mp.agentReview) return `${prefix}.agentReview.escalateToPaths`;
  return null;
}

/** First removed path field present in a WorkspacePolicyConfig-shaped value. */
export function findRemovedPathFieldInPolicyConfig(pc: unknown, prefix = 'policyConfig'): string | null {
  if (!isObj(pc) || !Array.isArray(pc.riskClasses)) return null;
  const hit = pc.riskClasses.findIndex((e) => isObj(e) && 'userPaths' in e);
  return hit === -1 ? null : `${prefix}.riskClasses[${hit}].userPaths`;
}

/**
 * First removed path field present in a gitConfig-shaped write body (a full
 * gitConfig, a partial one, or the config form's flat body). Presence is what
 * counts — an empty array is refused too, so a stale client learns immediately.
 */
export function findRemovedPathFieldInGitConfig(gc: unknown, prefix = ''): string | null {
  if (!isObj(gc)) return null;
  const at = (k: string) => (prefix ? `${prefix}.${k}` : k);
  for (const key of ['autoMergeDenyPaths', 'escalateToPaths']) {
    if (key in gc) return at(key);
  }
  return findRemovedPathFieldInMergePolicy(gc.mergePolicy, at('mergePolicy'))
    ?? findRemovedPathFieldInPolicyConfig(gc.policyConfig, at('policyConfig'));
}

export type MergePolicyParseResult =
  | { ok: true; policy: MergePolicy }
  | { ok: false; error: string; field?: string };

/**
 * Shape-check a MergePolicy. Deliberately still tolerates the deprecated
 * `threshold.denyPaths` / `agentReview.escalateToPaths` keys, because this also
 * backs the fail-soft READ path — rejecting them here would drop a stored legacy
 * policy to the default. Write paths must call
 * `findRemovedPathFieldInMergePolicy` first and refuse with
 * `removedPolicyPathFieldError`.
 */
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

export type MissionNoteAuthorType = 'agent' | 'user' | 'system' | 'mcp';
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
  actorLabel: string | null;
  collapseKey: string | null;
  collapseCount: number;
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

export interface TaskHandoff {
  /** One-line delivery summary, required when handoff exists. */
  delivered: string;
  /** Interfaces/exports added — function/type/route/table names, not prose. */
  interfaces?: string[];
  /** Decisions made, each with a one-line why. */
  decisions?: Array<{ decision: string; why: string }>;
  /** Non-obvious traps a consumer of this work would otherwise re-discover. */
  gotchas?: string[];
  /** Named, explicitly — not "everything else". */
  leftUndone?: string[];
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
  /** The summary this replaced, when an admin corrected it after completion. See correct_task_result. */
  previousSummary?: string;
  /** ISO timestamp of the last admin correction to `summary`. */
  summaryCorrectedAt?: string;
  /** Identifier of the caller that made the correction (worker id or token label). */
  correctedBy?: string;
  /**
   * Provenance of `summary`. 'agent' = the agent explicitly passed it to
   * complete_task. 'fallback' = the runner derived it from the SDK's last
   * assistant message because the session ended without a complete_task
   * call — often a stray conversational aside, not an outcome. Consumers
   * (KB ingestion, UI) must not present a 'fallback' summary as an
   * authored outcome. Missing = written before this field existed.
   */
  summarySource?: 'agent' | 'fallback';
  /** Compact failure evidence written on a terminal state. See TaskEvidence. */
  evidence?: TaskEvidence;
  /** Claims the record contradicts. See TaskMismatch. */
  mismatch?: TaskMismatch[];
}

export const TASK_EVIDENCE_ERROR_CLASSES = [
  'test_failure', 'type_error', 'lint_ratchet', 'timeout', 'infra', 'auth', 'unknown',
] as const;
export type TaskEvidenceErrorClass = (typeof TASK_EVIDENCE_ERROR_CLASSES)[number];

/**
 * A small, structured record of what a task hit — the key error lines, never
 * the full log. Written by the server on a terminal state (`result.evidence`).
 */
export interface TaskEvidence {
  errorClass: TaskEvidenceErrorClass;
  /** Up to ~40 lines: failing test names and assertion/error messages, cleaned and redacted. */
  keyLines: string[];
  /** The last Bash command that exited non-zero, redacted, with its exit code. */
  lastFailingCommand?: { command: string; exitCode: number | null };
  /** Each check's name and state when the task ended. */
  ciChecks?: Array<{ name: string; state: 'passed' | 'failed' | 'pending'; url: string | null }>;
  /** Server-recorded diff size. */
  diff: { files: number; added: number; removed: number };
  /** Pointers only: the full log stays on GitHub. */
  links: { ciRunUrl?: string; prUrl?: string; fullLogUrl?: string };
  /** Where keyLines came from. `ci_digest` = seeded from the digest the task was given. */
  keyLinesSource: 'traces' | 'ci_digest' | 'error' | 'none';
  capturedAt: string;
}

export type TaskMismatchKind = 'pushed_without_diff' | 'success_with_red_check' | 'last_command_failed';

/** One claim the task made that its own record contradicts. */
export interface TaskMismatch {
  kind: TaskMismatchKind;
  detail: string;
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
  /** Short 2–4 word display label (≤48 chars). Supplied by the creator or the
   * creation-time classifier; NULL on legacy rows. Draw it via
   * `taskDisplayLabel` (`@buildd/core/task-label`), which falls back to the title. */
  label?: string | null;
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
  // Declaration snapshot + provenance for pathManifest (see PathDeclaration)
  pathDeclaration?: PathDeclaration | null;
  // Ownership revision: bumped by every lease acquisition, narrowing and release
  pathClaimRevision?: number;
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
  /** Row created at claim, never started by any runner (over-claim artifact). */
  | 'never_started'
  /** Session started but streamed no output at all (0 turns, $0). */
  | 'silent_start'
  | 'reassigned'
  | 'condition_unmet'
  | 'sandbox_mount_gap'
  /**
   * The agent correctly stopped to ask a human a question (AskUserQuestion),
   * and nobody answered before the waiting_input timeout — not a crash, not a
   * code defect. Excluded from the failure rate and failure-signature ranking,
   * but still queryable by this exit cause.
   */
  | 'needs_input'
  /**
   * This server refused a mutation from the session (a 4xx, or an unqueueable
   * 5xx) rather than the session crashing. Describes the REQUEST, not the work
   * — not charged against the task's retry budget, but bounded by the PATCH
   * route's infraRetryCount budget so the exemption cannot loop forever.
   */
  | 'server_refused'
  /**
   * A declared output gate refused the completion: the session ran and shipped
   * nothing reviewable. Charged — but not as a code failure.
   */
  | 'output_unmet'
  /**
   * The task was cancelled while this worker's session was still running.
   * Bookkeeping — excluded from the failure rate, never charged a retry.
   */
  | 'task_cancelled';

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
  /**
   * What choosing this option leads to, in one line (question brief). Absent
   * on older questions; renderers fall back to `description`.
   */
  consequence?: string;
}

/**
 * Where a question was asked from, filled in by the runner from facts it has
 * (never by the agent): the task, its branch, the file last edited.
 */
export interface QuestionWhere {
  taskTitle?: string;
  branch?: string;
  file?: string;
}

/** Claim-time marker for the question-gate experiment (see ClaimTasksResponse). */
export interface QuestionGateMarker {
  experimentId: string;
  policyVersion: number;
  arm: 'control' | 'treatment';
  /** Pushbacks per worker before a question is sent as-is. */
  maxPushbacks: number;
}

/** The agent's recommended default for a question, and why (one line). */
export interface QuestionRecommendation {
  label: string;
  reason?: string;
}

export interface WaitingFor {
  type: 'question' | 'permission' | 'confirmation';
  prompt: string;
  options?: (string | WaitingForOption)[];
  /**
   * Set server-side when a `question` carries no real prompt (the runner's
   * fallback text, or empty/whitespace) — the agent stopped and asked, but the
   * contract that it state what it needs was not met. Surfaced distinctly
   * rather than accepted silently.
   */
  contractViolation?: boolean;
  /**
   * Question brief (module header: packages/core/question-brief.ts): at most two
   * sentences saying which task this is and exactly what is being decided.
   * Optional; questions without it still render.
   */
  context?: string;
  /** The agent's recommended option and why. */
  recommended?: QuestionRecommendation;
  /** Deterministic origin facts the runner adds. */
  where?: QuestionWhere;
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

/**
 * The role's persona text, delivered on every claim whose task resolves a role
 * row — packaged to object storage or not.
 *
 * `RoleConfig` above only exists for roles that were packaged to R2, and a
 * seeded default role never is. The persona is the one part of a role the agent
 * cannot do without, so it rides the claim response directly rather than
 * through the bundle.
 */
export interface RoleInstructions {
  slug: string;
  name: string;
  content: string;
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
  /**
   * Claude Code CLI version bundled by this runner's installed
   * @anthropic-ai/claude-agent-sdk (read from its manifest.json, not the SDK's
   * own npm version). Lets the claim route refuse a task whose resolved model
   * needs a newer client before a worker session starts — see
   * packages/core/model-capability-requirements.ts. Absent on runner builds
   * that predate this field; the claim gate fails open in that case.
   */
  claudeCliVersion?: string;
  /**
   * Post-update canary status (apps/runner/src/update-canary.ts). Present on
   * runner builds that ship the canary; `lastTrip` is the loud part — a role
   * that failed deterministically right after an update, and whether the
   * runner rolled itself back.
   */
  updateCanary?: RunnerUpdateCanaryReport;
  /**
   * What this runner is in the fleet (./runner-fleet): a `--once` run reports
   * `ephemeral: true`, concurrency 1, its executor and, in a cloud container,
   * the dispatcher's group. Absent on host runners and on older builds; the
   * server then derives it from the heartbeat URL.
   */
  fleet?: RunnerFleetIdentity;
}

export interface RunnerUpdateCanaryReport {
  enabled: boolean;
  onProbation: boolean;
  probationFrom: string | null;
  probationTo: string | null;
  probationStartedAt: string | null;
  claimsHalted: boolean;
  /** Commit the updater refuses to re-apply until a newer one is published. */
  skippedCommit: string | null;
  lastTrip: {
    at: string;
    role: string;
    badCommit: string;
    rolledBackTo: string;
    failures: number;
    signature: string;
    rollbackStatus: 'pending' | 'started' | 'succeeded' | 'failed' | 'not_attempted';
    rollbackError?: string;
  } | null;
}

/**
 * The runner's own live update-state — the same fields it reports on its
 * local, unauthenticated-off-box `/api/version` endpoint
 * (`apps/runner/src/index.ts`) — now also sent on every heartbeat (see
 * `apps/runner/src/updater.ts`'s `getRunnerUpdateSnapshot` and
 * `apps/runner/src/buildd.ts`'s `sendHeartbeat`) and persisted on
 * `worker_heartbeats`. Lets `GET /api/workers/active` show a runner's
 * drift/update status without SSH into the host.
 */
export interface RunnerUpdateSnapshot {
  /** The commit this process loaded at boot (or after its last successful self-update) — not a fresh disk read. */
  currentCommit: string | null;
  /** Fresh `git rev-parse HEAD`, read at snapshot time. */
  diskCommit: string | null;
  /** True when diskCommit and currentCommit disagree — an external process rewrote the tree without restarting this runner. */
  commitDrift: boolean;
  updating: boolean;
  updateAvailable: boolean;
  /** The branch this install tracks (its `BUILDD_BRANCH`). */
  trackedBranch: string;
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
  /** Optional short 2–4 word display label (≤48 chars, e.g. "rates service").
   * Omit it and the server derives one from the title. */
  label?: string;
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
  // Spec-to-build opt-in: forces mode: 'planning' + context.requiresPlanApproval: true
  // (non-overridable) and requires a non-empty pathManifest naming the spec document
  // this task authors. Default false — every other caller is unaffected.
  emitsPlan?: boolean;
}

/** Task model tier vocabulary (mirrors @buildd/core model-tier-defaults TIERS). */
export type TaskModelTier = 'premium-plus' | 'premium' | 'standard' | 'budget';

/**
 * Body of PATCH /api/tasks/[id] (MCP `update_task`). Every field is optional;
 * `null` clears an override.
 */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: number;
  project?: string | null;
  status?: 'pending' | 'completed' | 'failed' | 'cancelled';
  backend?: AgentBackend | null;
  /**
   * Tier pin for the NEXT claim or retry (never the running session). Setting
   * a tier without `model` also drops an existing model pin.
   */
  tier?: TaskModelTier | null;
  /**
   * Exact model pin (Anthropic id) for the NEXT claim or retry; stored as
   * `context.model` with `context.modelPinned: true`. Outranks `tier`.
   */
  model?: string | null;
  maxLoops?: number;
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
  // Skill slugs this runner can execute. Omitted/empty = may claim any
  // role-routed task EXCEPT the opt-in EXPLICIT_ROLE_SLUGS, which always need
  // an explicit match.
  availableSkills?: string[];
  // Explicit opt-in for a multi-workspace OAuth token to claim the next pending
  // task across ALL its accessible workspaces in one call (server ranks/picks).
  // Distinguishes a deliberate cross-workspace runner poll from an accidental
  // ambiguous claim (the 2026-05-25 misroute class), which stays rejected.
  claimAcrossAccessible?: boolean;
  /**
   * Protocol features this runner build implements, so the server does not send
   * a payload field an older runner would silently ignore. See
   * CBM_WITHHOLD_RUNNER_FEATURE in @buildd/core/cbm-access-experiment.
   */
  runnerFeatures?: string[];
  /**
   * Admin-only, only with `taskId`, and only for a task in the admin's own
   * team's workspace: claim that one task past the gates a person may override,
   * the MCP equivalent of the dashboard's "Start with override". Skips
   * dependencies, a held mission, a dead subject, a future startAt, mission
   * concurrency and pacing, path overlap and the workspace cap. Never skips a
   * live worker, a person's hold on the task, the mission budget,
   * scope-undeclared serialization, role/runner routing, provider walls or
   * account limits. Ignored otherwise. Audited on the task and the gate ledger.
   */
  forceOverride?: boolean;
  /**
   * Where this runner executes (see ./executor). `cloud`: the claim response
   * carries no credential material at all (CLAIM_CREDENTIAL_FIELDS). Omitted
   * means a host runner. Any other value is rejected with 400.
   */
  executor?: 'host' | 'cloud';
  /**
   * True when this runner has a per-machine model provider (LLM_PROVIDER other
   * than `anthropic`), which beats the team's agent model endpoint. A boolean
   * only, never the provider's values.
   */
  llmProviderOverride?: boolean;
}

/** The agent model endpoint as a claim delivers it (packages/core/agent-endpoint.ts). */
export interface ClaimModelEndpoint {
  kind: 'gateway' | 'openrouter' | 'anthropic-compatible';
  /** Anthropic-compatible root; the agent's ANTHROPIC_BASE_URL. */
  baseUrl: string;
  authToken: string;
  /** `authorization` ⇒ ANTHROPIC_AUTH_TOKEN (Bearer); `x-api-key` ⇒ ANTHROPIC_API_KEY. */
  authHeader: 'authorization' | 'x-api-key';
  /** Native model id → proxy alias (gateway / anthropic-compatible only). */
  models: Record<string, string>;
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
  | 'path_overlap_blocked'
  /** An interactive session's explicit claim of this task came too soon after its last one. */
  | 'rate_limited';

/**
 * Which gate excluded an explicitly requested task (claim with `taskId`). The
 * SQL-level codes come from the probe in
 * apps/web/src/app/api/workers/claim/explicit-task-exclusion.ts; the
 * dispatch-loop codes are the `deferrals` keys, set when the named task itself
 * was the one deferred. There is deliberately no "unknown": every exclusion
 * names its filter (friction cad81659).
 */
export type ClaimTaskExclusionCode =
  | 'not_found'
  | 'not_pending'
  | 'already_claimed'
  | 'deferred'
  | 'active_worker'
  | 'task_held'
  | 'mission_held'
  | 'mission_local'
  | 'deps_blocked'
  | 'subject_dead'
  | 'runner_preference'
  | 'role_mismatch'
  | 'runner_cooldown'
  | 'workspace_cap'
  | 'path_overlap'
  /** Codex task and this caller can run neither Codex nor its credential. */
  | 'capability_mismatch'
  /** Pinned to a project the workspace does not have; the task was failed. */
  | 'workspace_mismatch'
  /** The account filled its concurrent-worker limit before this task's insert. */
  | 'account_cap'
  /** Every filter passes on re-check: the task changed between query and probe. Retry. */
  | 'state_changed'
  /** An interactive session claimed this task too recently; retry after the window. */
  | 'rate_limited'
  | keyof NonNullable<ClaimDiagnostics['deferrals']>;

export interface ClaimTaskExclusion {
  code: ClaimTaskExclusionCode;
  /** One human sentence, including the override when there is one. */
  detail: string;
}

export interface ClaimDiagnostics {
  reason: ClaimDiagnosticReason;
  /**
   * The specific gate that excluded an explicit `taskId` claim. Set either when
   * the claim query filtered the task out entirely (reason `no_pending_tasks`),
   * or when the task reached the dispatch loop but was itself the one deferred
   * by the path-overlap backstop (reason `all_candidates_deferred`/`race_lost`)
   * — the two mechanisms that can silently exclude a named task without a claim
   * attempt ever being made.
   */
  taskExclusion?: ClaimTaskExclusion;
  pendingTasks?: number;
  matchedTasks?: number;
  activeWorkers?: number;
  maxConcurrent?: number;
  availableSlots?: number;
  /**
   * Set when any candidate in this poll was deferred on layer-1 path overlap
   * (its pathManifest overlaps an open PR): the first such PR. Appears on
   * all_candidates_deferred and race_lost responses.
   */
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
    /** Task already had a live worker when the atomic insert ran (dup guard). */
    duplicate_worker?: number;
    /** Codex task deferred: the workspace's one Codex slot is already taken. */
    codex_single_flight?: number;
    /** Resolved model needs a newer Claude Code CLI than this runner reports. */
    runner_capability?: number;
    /**
     * Claude task held because learned OAuth pressure lowered this seat's
     * session cap and the seat is at it. Never applies to explicit starts,
     * Codex, or tenant work. See `budgetPressure` for the reading behind it.
     */
    oauth_parallelism?: number;
    /**
     * Its role (or workspace envMapping) declares env vars no delivery channel
     * can satisfy — no role_env_secret under the mapped label, no mcp_credential
     * of that name, not runner-provided. Held rather than claimed to run
     * degraded or fail at provisioning. See claim/role-env-injection.ts.
     */
    role_env_unsatisfied?: number;
  };
  /**
   * Learned OAuth budget pressure for this seat (seat-based auth only).
   * pct is 0..1 of the capacity learned from past exhaustion episodes. Its only
   * effect is a lower per-seat concurrent-session cap (never below one live
   * session, restored when the window resets); it does not change the routed
   * tier and never pauses or delays claims. Absent when the account is
   * API-billed, pacing is off, or there are too few episodes to learn from.
   * See packages/core/oauth-budget.ts (`oauthParallelismCap`).
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

/**
 * A credential the runner's broker should pre-refresh (expiring within 2 hours).
 *
 * Metadata only — never token material. `secretId` names the row; the runner
 * exchanges it for a fresh token via POST /api/runner/credential-refresh.
 */
export interface PendingCredentialRefresh {
  secretId: string;
  purpose: 'claude_credential' | 'codex_credential';
  expiresAt: string | null; // ISO 8601 — runner decides whether to refresh
}

export interface ClaimTasksResponse {
  workers: Array<{
    id: string;
    taskId: string;
    branch: string;
    task: Task;
    skillBundles?: SkillBundle[];
    childResults?: Array<{ id: string; title: string; status: string; result: TaskResult | null }>;
    /**
     * Set when the task is enrolled in a running `cbm_access` experiment.
     * `withheld: true` means the runner must run it WITHOUT codebase-memory:
     * no mount, no steering, every CBM tool denied.
     */
    cbmExperiment?: { experimentId: string; policyVersion: number; arm: 'control' | 'treatment'; withheld: boolean };
    /**
     * Set when the team runs a `question_gate` experiment and the runner sent
     * the `question_gate` feature. The runner then routes AskUserQuestion
     * through POST /api/workers/[id]/question-check before parking.
     */
    questionGate?: QuestionGateMarker;
    /**
     * claude.ai artifact access for this session, resolved from the role's
     * `metadata.claudeAiArtifacts` and the task's `context.claudeAiArtifacts`.
     * Absent means off. See claude-ai-artifacts.ts.
     */
    claudeAiArtifacts?: ClaudeAiArtifactAccess;
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
    /**
     * OAuth scopes the managed claude_credential was granted, when recorded
     * (the dashboard login records them). The runner writes these into the
     * worker's .credentials.json; absent means the legacy `['user:inference']`.
     */
    claudeTokenScopes?: string[];
    /**
     * The team's agent model endpoint, when it won the §2 ranking for this task
     * (docs/design/agent-model-endpoint.md). When set, serverApiKey,
     * serverOauthToken, claudeAccessToken and pendingCredentialRefreshes are
     * absent for this worker: it is the only model credential the agent sees.
     */
    modelEndpoint?: ClaimModelEndpoint;
    /**
     * True when an endpoint won but the runner reported `llmProviderOverride`:
     * the machine routes to its own provider, so the key is not sent. Carries
     * no credential; it only lets the runner log that the team setting was
     * bypassed.
     */
    modelEndpointIgnored?: boolean;
    /** Credentials expiring within 2 hours, scoped to THIS task's workspace team.
     *  Kept per-worker because the runner also reads the claude_credential secretId
     *  off it to wire the worker to the broker at spawn time, and because a claim
     *  may serve a workspace outside the authenticated account's own team. */
    pendingCredentialRefreshes?: PendingCredentialRefresh[];
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
    /** Role configuration for the claimed task's assigned role — packaged roles only */
    roleConfig?: RoleConfig;
    /** Role persona for the claimed task's assigned role — present whenever a role row resolves */
    roleInstructions?: RoleInstructions;
    /**
     * Decrypted secrets resolved against the role's (or workspace's) declared
     * ENV_NAME → secret label mapping (purpose='role_env_secret'), keyed by the
     * ENV_NAME the value should be injected under. Merged into the role env by
     * the runner's `resolveWorkerRoleEnv`, alongside whatever the local
     * env-mapping.json/process-env resolution already provides.
     */
    roleEnvSecrets?: Record<string, string>;
    /** ENV_NAME keys declared in that mapping with no matching secrets row — surfaced as a degraded-role-env milestone. */
    roleEnvMissing?: string[];
    /** Connectors that failed availability checks but are not hard-required (advisory mode only).
     *  Present when workspace.connectorAdvisoryMode=true and the task claimed despite connector failures. */
    degradedConnectors?: DegradedConnector[];
  }>;
  diagnostics?: ClaimDiagnostics;
  /** ISO timestamp when the account's OAuth budget resets (present when budget is exhausted but tenant tasks were still served) */
  budgetResetsAt?: string | null;
  /**
   * Credentials of the AUTHENTICATED ACCOUNT'S OWN TEAM that expire within 2 hours.
   *
   * Announced on every claim poll — including polls that claim nothing — because
   * the claim call is the runner's heartbeat. The per-worker field above only
   * exists when something was claimed, so an idle-but-online runner's credential
   * broker never discovered the credentials it is responsible for and never
   * refreshed them. This is that discovery channel.
   *
   * Scope is a single team (the account's), never wider. Metadata only.
   */
  pendingCredentialRefreshes?: PendingCredentialRefresh[];
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

/**
 * Declaration snapshot + provenance for a task's pathManifest, stored as JSONB
 * in tasks.path_declaration. `pathManifest` is the current *effective* scope
 * and shrinks when a stale claim is narrowed; this keeps what was declared so
 * conformance checks and audits can compare the two. First write wins:
 * `declared` is set at creation, or on the first runtime mutation for a task
 * created before this column existed. See
 * knowledge-base: buildd/design/conflict-aware-orchestration.md §1.
 */
export interface PathDeclaration {
  declared: string[] | null;
  source: 'creation' | 'runtime';
  snapshotAt: string;
  /**
   * dependsOn edges added at creation because manifests overlapped, as opposed
   * to caller-supplied edges. Only these may ever be removed on narrowing.
   */
  inferredDependsOn?: string[];
  /** Most recent narrowings, oldest first, capped. */
  narrowings?: PathNarrowing[];
  /**
   * Where `declared` came from when it was not the task's own filer: a plan
   * step (approvePlan), or the doc-fix override, which outranks the step.
   */
  origin?: { kind: 'plan_step' | 'doc_fix'; planningTaskId: string; stepRef?: string };
  /**
   * The last reconciliation of this task's scope against its PR's actual diff
   * (lib/pr-scope-reconcile.ts). `status` other than `complete` means the read
   * could not be trusted and nothing was narrowed; `reason` says why.
   */
  prScope?: PrScopeRecord;
  /**
   * The last enforce-mode checkpoint collision (lib/path-collision-deferral.ts):
   * a path this task had already changed was held by another live task, so the
   * runner checkpointed and deferred. `path` was appended to the effective
   * manifest so the claim route holds the task until the holder releases.
   */
  collision?: PathCollisionRecord;
}

/** Enforce-mode path claims: why a task was deferred at a checkpoint. */
export interface PathCollisionRecord {
  path: string;
  blockingTaskId: string;
  blockingTaskTitle?: string | null;
  blockingPath?: string | null;
  source: 'hook_flush' | 'sync' | 'pre_push' | 'completion';
  checkpoint?: { committed: boolean; sha?: string; pushed: boolean; reason?: string };
  recordedAt: string;
}

/** Workspace opt-in for path-claim enforcement (gitConfig.pathClaimEnforcement). Absent = advisory. */
export type PathClaimEnforcementMode = 'advisory' | 'enforce';

/**
 * A path a worker's sync reported as changed that another live task holds —
 * returned on the worker PATCH response as `pathCollisions`.
 */
export interface PathCollisionNotice {
  path: string;
  blockingTaskId: string;
  blockingTaskTitle: string | null;
  blockingPath: string;
}

export interface PrScopeRecord {
  prNumber: number;
  /**
   * `live_writer`: the PR owner's worker was live, so its own declaration was
   * left whole (a remote snapshot cannot see its dirty worktree).
   */
  status: 'complete' | 'incomplete' | 'closed' | 'revision_conflict' | 'live_writer';
  reason: string | null;
  headSha: string | null;
  baseSha: string | null;
  /** Distinct paths in the diff, rename sources included. Null unless complete. */
  fileCount: number | null;
  /** Paths this reconciliation gave back. */
  dropped: string[];
  /** Paths an earlier reconciliation dropped that this read found in the diff, put back. */
  restored?: string[];
  readAt: string;
}

export interface PathNarrowing {
  at: string;
  dropped: string[];
  surface: string;
  reason: string | null;
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
  /**
   * Coordination-step classification (wait/aggregate/merge/verify), set only on
   * kind='mission' anchors created for planner-generated coordination tasks.
   * Lets successive heartbeat cycles dedupe repeated wait/monitor/aggregate/merge
   * steps by INTENT instead of by title wording — see approve-plan.ts.
   */
  coordinationIntent?: 'wait' | 'aggregate' | 'merge' | 'verify';
  /**
   * Sorted, deduped PR numbers referenced by a coordination step's own title/
   * description — the "subject PR set" half of its dedupe key. Empty when the
   * step names no specific PR (the common case for generic wait/aggregate steps).
   */
  subjectPrNumbers?: number[];
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
  // Excludes a subdirectory of /tmp or /var/tmp (optionally quoted) — the
  // `$(mktemp -d)` scratch-directory cleanup pattern is a safe, isolated
  // backup/test/restore idiom, not a destructive command. The bare root
  // (`rm -rf /tmp`) and everything else under [/~] is still blocked.
  /rm\s+-rf\s+["']?(?!\/tmp\/|\/var\/tmp\/)[\/~]/,
  // The exemption above only checks the literal prefix, not where the path
  // actually resolves — `/tmp/../etc` starts with `/tmp/` but escapes it.
  // Re-block any /tmp or /var/tmp path containing a `..` segment.
  /rm\s+-rf\s+["']?\/(?:tmp|var\/tmp)\/[^\s"']*\.\.[^\s"']*/,
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

// Role slug for the mission visual auditor (see docs/design/visual-qa-auditor.md).
// Its tasks need a runner that can actually launch a browser, so a runner
// advertises this slug in `availableSkills` only when env-scan reports
// CAPABILITY_BROWSER.
export const VISUAL_AUDITOR_ROLE_SLUG = 'visual-auditor';

// Role slugs that are opt-in: a task routed to one of these is claimable ONLY
// by a runner that lists the slug in `availableSkills`. Every other roleSlug
// keeps the legacy rule (an empty `availableSkills` list claims anything).
export const EXPLICIT_ROLE_SLUGS: readonly string[] = [VISUAL_AUDITOR_ROLE_SLUG];

// ============================================================================
// VISUAL REVIEW (docs/design/visual-qa-human-review.md)
// ============================================================================
//
// One model every surface reads: cells (route × viewport × variant) with their
// round history, the audit phase, a triage queue and a summary. Built by
// `buildVisualReviewModel` (apps/web/src/lib/visual-review-model.ts), served by
// GET /api/missions/[id]/visual-review. Human decisions live in the
// `visual_shot_reviews` table, never in `artifacts.metadata.qa`.

export type VisualQaVerdict = 'ok' | 'issue' | 'unsure';
export type VisualQaViewport = 'mobile' | 'desktop';

/** The two buttons a human sees, whatever the agent said. */
export type VisualReviewDecision = 'looks_right' | 'needs_fix';
export const VISUAL_REVIEW_DECISIONS: readonly VisualReviewDecision[] = ['looks_right', 'needs_fix'];

/** How the human decision relates to the agent's verdict. Derived by the server, never sent. */
export type VisualReviewRelation = 'agree' | 'dispute' | 'waive';

/**
 * The relation a decision implies (the table in the design doc, part 1):
 * ok + looks right = agree, ok + needs fix = dispute, issue + looks right =
 * dispute (it waives the fix), issue + needs fix = agree, unsure + looks right
 * = waive, unsure + needs fix = dispute (a fix is filed, as for ok).
 */
export function visualReviewRelation(agentVerdict: VisualQaVerdict, decision: VisualReviewDecision): VisualReviewRelation {
  if (agentVerdict === 'unsure') return decision === 'looks_right' ? 'waive' : 'dispute';
  const agentSaysFine = agentVerdict === 'ok';
  return agentSaysFine === (decision === 'looks_right') ? 'agree' : 'dispute';
}

/** The audit as a whole, one value. Phase copy is written in one place (visual-review-model.ts). */
export const VISUAL_REVIEW_PHASES = [
  'off',
  'waiting_deps',
  'queued',
  'no_browser_runner',
  'capturing',
  'boot_failed',
  'stalled',
  'failed',
  'needs_you',
  'fixing',
  'reviewed',
] as const;
export type VisualReviewPhase = (typeof VISUAL_REVIEW_PHASES)[number];

/** `artifacts.metadata.qa`, validated (`parseQaMeta`). Written only by visual-auditor workers. */
export interface VisualQaMeta {
  /** `''` when the auditor sent none. */
  runKey: string;
  /** The route pattern (`/app/tasks/:id`), not a concrete URL. */
  route: string;
  viewport: VisualQaViewport;
  finding: string;
  verdict: VisualQaVerdict;
  theme?: string;
  /** The auditor's own fix link. A human-filed fix is on the review row instead. */
  fixTaskId?: string;
  variant?: string;
  /**
   * The branch the shot was captured from, and why that branch
   * (`CaptureRefSource` in @buildd/core/visual-qa-capture-ref). Absent on
   * shots that predate the capture ref; those are never judged wrong-ref.
   */
  ref?: string;
  refSource?: string;
}

/**
 * A shot captured from a ref other than the mission's capture ref, with a
 * correct-ref shot at the same route, viewport and state. Hidden from the deck;
 * the artifact is kept for audit (docs/design/visual-qa-auditor.md, "Page source").
 */
export interface VisualReviewSupersededShot {
  shotId: string;
  route: string;
  viewport: VisualQaViewport;
  /** The ref the shot recorded, normalized. */
  ref: string;
  expectedRef: string;
  /** The correct-ref shot that replaces it. */
  supersededBy: string;
}

/**
 * A wrong-ref shot with no correct-ref sibling: a capture the auditor still
 * owes, never a question for a person.
 */
export interface VisualReviewCaptureGap {
  shotId: string;
  route: string;
  viewport: VisualQaViewport;
  ref: string;
  expectedRef: string;
  auditTaskId: string | null;
  round: number;
}

/** One audit screenshot, as every surface renders it. */
export interface VisualReviewShot {
  /** The artifact id. */
  id: string;
  workerId?: string | null;
  /** The visual-auditor task whose worker wrote the shot, when known. */
  auditTaskId: string | null;
  /** The audit round of that task (`surfaceAuditRound`); 1 when unknown. */
  round: number;
  createdAt: string;
  /** Always `/api/artifacts/:id/download` for real rows, never a signed URL. */
  src: string;
  title?: string | null;
  qa: VisualQaMeta;
  /** The distinguishing variant in the caption (`withVariants`). */
  variant?: string | null;
}

/** A human decision on one shot: a `visual_shot_reviews` row. */
export interface HumanShotReview {
  id: string;
  artifactId: string;
  auditTaskId: string | null;
  round: number;
  cellKey: string;
  route: string;
  viewport: VisualQaViewport;
  /** The agent's verdict when the human decided. */
  agentVerdict: VisualQaVerdict;
  decision: VisualReviewDecision;
  relation: VisualReviewRelation;
  note: string | null;
  /** The `[surface fix]` task this decision filed. */
  fixTaskId: string | null;
  /** The auditor's fix this decision cancelled, so undo can reopen it. */
  cancelledFixTaskId: string | null;
  reviewerUserId: string | null;
  reviewerLabel: string | null;
  createdAt: string;
  /** Null while active. At most one active review per artifact. */
  supersededAt: string | null;
}

/** A `[surface fix]` task as a cell shows it. */
export interface VisualReviewFixTask {
  id: string;
  title: string;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  mergedAt: string | null;
  /** Who filed it: the auditor (`qa.fixTaskId`) or a human decision (the review row). */
  origin: 'auditor' | 'human';
}

/** One round's look at a cell. */
export interface VisualReviewCellEntry {
  round: number;
  shot: VisualReviewShot;
  agentVerdict: VisualQaVerdict;
  finding: string;
  fixTask: VisualReviewFixTask | null;
  /** The active human review of this shot, if any. */
  review: HumanShotReview | null;
}

/** A thumbnail's human-review marker: hollow, solid, strike. */
export type VisualReviewMarker = 'awaiting' | 'confirmed' | 'disputed' | 'waived';

/** One route × viewport × variant, across rounds. */
export interface VisualReviewCell {
  /** `route|viewport|variant` (`visualReviewCellKey`). */
  key: string;
  route: string;
  viewport: VisualQaViewport;
  variant: string | null;
  /** The newest round that shot this cell. A cell a later round did not re-shoot stays current. */
  current: VisualReviewCellEntry;
  /** One entry per round that shot the cell, oldest round first. */
  history: VisualReviewCellEntry[];
  /** The active human decision if there is one (looks right = ok, needs fix = issue), else the agent's verdict. */
  effectiveVerdict: VisualQaVerdict;
  marker: VisualReviewMarker;
  /** An unsure cell nobody has decided: the only kind that needs a human. */
  needsHuman: boolean;
}

export interface VisualReviewSummary {
  /** Current cells. Equals `summarizeVisualRun(...).shots` for a single-run mission. */
  shots: number;
  /** Agent verdicts over current cells. */
  ok: number;
  issues: number;
  unsure: number;
  /** `effectiveVerdict` over current cells: the human decision where there is one. For display copy; parity reads the agent counts above. */
  effectiveOk: number;
  effectiveIssues: number;
  /** Current cells with an active human review, and without one. */
  reviewed: number;
  unreviewed: number;
  /** Current unsure cells without an active review (`needsHuman`). */
  awaitingHuman: number;
  confirmed: number;
  disputed: number;
  waived: number;
  /** Required route × viewport cells, when code named routes. */
  required?: number;
  covered?: number;
  bootFailed?: boolean;
  rounds: number;
  /** `[surface fix]` tasks of the mission still open. */
  openFixes: number;
  /** Wrong-ref shots with no correct-ref sibling (`VisualReviewModel.captureGaps`). */
  captureGaps?: number;
}

export interface VisualReviewAuditTask {
  id: string;
  title: string;
  status: string;
  round: number;
  createdAt: string | null;
  /** When it reached completed, failed or cancelled (the task's `updatedAt` then); null while live. */
  endedAt?: string | null;
  /** `result.errorType`, e.g. `infra_stalled`. */
  errorType: string | null;
  /** Why it ended as it did, when known: the task's result summary, else its newest worker's error. */
  why?: string | null;
}

/**
 * Why the audit needs a human. `question`: the auditor's worker waits on a
 * question that is not the boot failure. `unsure`: unsure cells nobody
 * decided. `round_cap`: the round-cap note is open.
 */
export type VisualReviewNeedsYouReason = 'question' | 'unsure' | 'round_cap';

export interface VisualReviewNeedsYou {
  reason: VisualReviewNeedsYouReason;
  /** For `question`: the worker's prompt, answered like the boot-failure question. */
  prompt?: string;
  taskId?: string;
  workerId?: string;
}

export interface VisualReviewModel {
  missionId: string;
  phase: VisualReviewPhase;
  /** For `capturing`: shots of the running round so far, of `expected` (null when code named no route). */
  progress: { captured: number; expected: number | null } | null;
  /** The latest visual-auditor task (highest round, newest). */
  audit: VisualReviewAuditTask | null;
  /** Every visual-auditor task of the mission, cancelled and failed ones too: round, then oldest first. */
  audits?: VisualReviewAuditTask[];
  /** For `boot_failed`: the parked worker and its question. */
  bootFailure: { taskId: string; workerId: string; prompt: string } | null;
  /** The round-cap question note is open. */
  roundCapOpen: boolean;
  /** For `needs_you`: why, and for a question the parked worker and its prompt. Null in every other phase. */
  needsYou: VisualReviewNeedsYou | null;
  cells: VisualReviewCell[];
  /** Cell keys in review order: unsure, issue, ok, then already reviewed. */
  queue: string[];
  summary: VisualReviewSummary;
  fixTasks: VisualReviewFixTask[];
  /** Wrong-ref shots hidden because a correct-ref sibling exists. Never in `cells` or `queue`. */
  superseded?: VisualReviewSupersededShot[];
  /** Wrong-ref shots the auditor still has to recapture. Never in `cells` or `queue`. */
  captureGaps?: VisualReviewCaptureGap[];
  generatedAt: string;
}

// ── Decisions contract (POST /api/missions/[id]/visual-review/decisions) ────

export const VISUAL_REVIEW_MAX_ARTIFACTS = 50;
/** Longest `note` the decisions route accepts. */
export const VISUAL_REVIEW_NOTE_MAX = 2000;

export interface VisualReviewDecisionRequest {
  /** 1..VISUAL_REVIEW_MAX_ARTIFACTS shots of this mission (both viewports of a route: one fix). */
  artifactIds: string[];
  decision: VisualReviewDecision;
  note?: string;
  /** The agent verdict the client saw per artifact: the stale guard. */
  expected: Record<string, VisualQaVerdict>;
}

export interface VisualReviewDecisionResponse {
  reviews: HumanShotReview[];
  /** The fix filed (needs fix on ok or unsure). */
  fixTaskId: string | null;
  /** The auditor fix cancelled (looks right on issue, fix still pending and unclaimed). */
  cancelledFixTaskId: string | null;
  /** The fix that got a `guidance` note instead, because it had started. */
  guidanceTaskId: string | null;
  /**
   * Every fix of the request, for a request that spans routes (one fix per
   * route; both viewports of a route share one). The singular fields above
   * are the first of each, or null.
   */
  fixTaskIds: string[];
  cancelledFixTaskIds: string[];
  /** Fixes annotated with a `guidance` note (started, so not cancelled; or a needs-fix note on the auditor's fix). */
  guidanceTaskIds: string[];
  /** Why each fix in `guidanceTaskIds` got a note instead of a cancel, for an honest toast. */
  annotated: VisualReviewAnnotation[];
  model: VisualReviewModel;
}

/**
 * `started`: a looks-right could not cancel the fix because it had started.
 * `still_linked`: another viewport or screen still links the fix, so it stays open.
 * `note`: a needs-fix note sent to the open fix.
 */
export interface VisualReviewAnnotation {
  fixTaskId: string;
  reason: 'started' | 'still_linked' | 'note';
}

/** DELETE /api/missions/[id]/visual-review/decisions/[reviewId] (undo). */
export interface VisualReviewUndoResponse {
  superseded: string;
  /** Every review of the same decision (one tap on both viewports writes two rows; undo takes both back). */
  supersededIds: string[];
  /** The reviews this decision had replaced, active again: undo returns the cells to their state before the tap. */
  restoredIds: string[];
  /** The first of each list below, or null. */
  reopenedFixTaskId: string | null;
  cancelledFixTaskId: string | null;
  /** Every fix the undo reopened or cancelled (a request can span routes, one fix per route). */
  reopenedFixTaskIds: string[];
  cancelledFixTaskIds: string[];
  model: VisualReviewModel;
}

/**
 * Errors: 409 `stale` (a newer-round shot exists or the agent verdict
 * changed), 409 `fix_started` (undo after the fix was claimed), 409
 * `round_ceiling` (at MAX_TOTAL_SURFACE_AUDIT_ROUNDS), 422 `not_in_mission`.
 */
export type VisualReviewDecisionError =
  /** Every stale cell of the request (both viewports can go stale at once), plus the fresh model to re-render from. */
  | { error: 'stale'; stale: true; cells: VisualReviewCell[]; model: VisualReviewModel }
  | { error: 'fix_started'; fixTaskId: string }
  | { error: 'round_ceiling'; message: string }
  | { error: 'not_in_mission'; artifactIds: string[] };

/** Realtime: fired on the mission channel after a decision or an undo. */
export const VISUAL_REVIEW_EVENT = 'mission:visual_review';

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
       * Free-form natural-language criterion, graded by an inference call
       * (`api`) or a read-only runner task (`runner`) — see {@link CriteriaGrader}.
       * The escape hatch of last resort: its verdict is a model's judgment, so it
       * is the one criterion form that can land NOT_EVALUATED (no key, no runner,
       * an `unsure` answer).
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
      /**
       * Who grades this criterion. Overrides the workspace's
       * `gitConfig.criteriaGrader`; absent falls through to it, then to `auto`.
       * See {@link CriteriaGrader}.
       */
      grader?: CriteriaGrader;
      label?: string;
    };

/**
 * How a `description` (prose) criterion is graded.
 *
 * - `api`    — one inference call against the team's API-key credential (or the
 *              server env fallback). Seconds, billed per token. With no key the
 *              criterion reads NOT_EVALUATED saying so; it never switches to a
 *              runner behind the caller's back.
 * - `runner` — a read-only verification task per criterion, claimed by one of the
 *              team's runners on whatever agent credential it has (an OAuth seat
 *              included). Asynchronous; no per-token call from the web app.
 * - `auto`   — `api` when the inference client resolves a key for the team,
 *              otherwise `runner`. The default.
 *
 * Resolution: criterion `grader` > workspace `gitConfig.criteriaGrader` > `auto`.
 */
export type CriteriaGrader = 'auto' | 'api' | 'runner';

export const CRITERIA_GRADERS: readonly CriteriaGrader[] = ['auto', 'api', 'runner'];

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
     * When this criterion's own verdict was produced (a runner-graded prose
     * criterion lands asynchronously, after the state-level `evaluatedAt`).
     */
    evaluatedAt?: string;
    /**
     * Set while a runner-graded criterion's verification task has sat unclaimed
     * past the wait bound: no runner has picked it up, so the verdict is not
     * merely slow — it is waiting on capacity someone may need to provide.
     */
    awaitingRunner?: boolean;
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

/**
 * What a PR reviewer said about one prose criterion, from the one moment the
 * evidence is actually in front of a model: the diff review.
 *
 * Deliberately NOT a `CriterionVerdict`. A reviewer judges one PR, not the
 * mission — "this PR supports the criterion" is not "the criterion passes", and
 * collapsing the two would let a single approved PR complete a mission.
 * Folding findings into a verdict is `applyReviewerFindings`'s job.
 */
export type CriterionReviewerFinding = 'supports' | 'contradicts' | 'not_applicable';

export interface CriteriaReviewerFindingEntry {
  /** Criterion index as it stood when the reviewer was prompted. */
  index: number;
  /**
   * Criterion identity from `criterionFingerprint()`. Index is a position and
   * positions get reused when criteria are edited; a finding whose fingerprint
   * no longer matches is discarded rather than transplanted onto a new claim.
   */
  fingerprint?: string;
  finding: CriterionReviewerFinding;
  /** One line, citing what in the diff justifies it. */
  reason: string;
}

/**
 * One reviewer's report on a mission's prose criteria, appended to
 * `missions.criteriaReviewerFindings` when the reviewer task completes.
 *
 * Append-only and newest-first. Merged-ness is deliberately NOT stored: a
 * report is recorded at verdict time, usually before the PR merges, so it is
 * resolved at read time from the PR's worker row instead.
 */
export interface CriteriaReviewerReport {
  prNumber: number;
  headSha?: string;
  /** The reviewer task that produced this report. */
  reviewerTaskId: string;
  /** The task whose PR was reviewed — the join key for merged-ness. */
  originalTaskId?: string;
  /** ISO 8601. The recency key: reports are stored and read newest-first. */
  recordedAt: string;
  /** The reviewer's own verdict, recorded for provenance only. */
  verdict?: 'approve' | 'request-changes' | 'escalate';
  findings: CriteriaReviewerFindingEntry[];
}

/** @deprecated Initiative KPIs were removed; kept only to type the column until it is dropped. */
export interface InitiativeKPI {
  name: string;
  metric: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  threshold: number;
  unit?: string;
  blocking?: boolean;
}

/** @deprecated See InitiativeKPI. */
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

// ============================================================================
// WORKER FAILURE ANALYTICS
// ============================================================================

/** Selectable lookback windows for failure analytics. */
export type FailureWindow = '24h' | '7d' | '30d';

/** Exit-cause bucket, with `null` exit causes surfaced as 'unclassified'. */
export type FailureExitCauseBucket = WorkerExitCause | 'unclassified';

export interface FailureTotals {
  /** Workers created inside the window. NOT the failure-rate denominator. */
  started: number;
  /**
   * Workers created inside the window that have since reached a terminal status
   * (completed / failed / error / anything not still in flight). This is the
   * failure-rate denominator: an in-flight worker has not had the chance to fail
   * yet, so counting it biases the rate down and makes it drift as work lands.
   */
  terminal: number;
  /** started − terminal — workers still in flight, a STATE, not a trend. */
  stillRunning: number;
  completed: number;
  failed: number;
  /** failed / terminal, 0-100, rounded. */
  failureRatePct: number;
  /** Failures with turns <= 2 AND costUsd === 0 — consumed a slot, produced nothing. */
  diedEarly: number;
  /** diedEarly / failed, 0-100, rounded. */
  diedEarlySharePct: number;
}

export interface FailureExitCauseRow {
  exitCause: FailureExitCauseBucket;
  count: number;
  /** Share of all failures in the window, 0-100, rounded. */
  sharePct: number;
}

/** A cluster of failures whose error messages normalize to the same signature. */
export interface FailureSignatureRow {
  /** Normalized error text (UUIDs/numbers/paths/timestamps replaced by placeholders). */
  signature: string;
  count: number;
  /** ISO timestamp of the earliest failure in the cluster. */
  firstSeen: string;
  /** ISO timestamp of the most recent failure in the cluster. */
  lastSeen: string;
  /** Up to 3 worker IDs for drill-down. */
  exampleWorkerIds: string[];
  /** Raw (un-normalized) error text from one member of the cluster. */
  exampleError: string | null;
  /** A task ID from the cluster, for linking into the dashboard. */
  exampleTaskId: string | null;
  /** How many members of this cluster are in the died-early cohort. */
  diedEarlyCount: number;
  /** Distinct exit causes observed in this cluster, sorted. */
  exitCauses: FailureExitCauseBucket[];
}

export interface FailureRoleRow {
  /** Role slug, or '(no role)' for workers whose task had no role. */
  roleSlug: string;
  started: number;
  /** Terminal subset of `started` — the failure-rate denominator. */
  terminal: number;
  failed: number;
  /** failed / terminal, 0-100, rounded. */
  failureRatePct: number;
}

export interface FailureWorkspaceRow {
  workspaceId: string;
  workspaceName: string;
  started: number;
  /** Terminal subset of `started` — the failure-rate denominator. */
  terminal: number;
  failed: number;
  /** failed / terminal, 0-100, rounded. */
  failureRatePct: number;
}

/** A task that burned more than one worker inside the window. */
export interface FailureRepeatTaskRow {
  taskId: string;
  taskTitle: string | null;
  workspaceId: string;
  failedWorkers: number;
  lastFailureAt: string;
}

export interface FailureAnalytics {
  window: FailureWindow;
  /** ISO timestamp the report was computed at. */
  generatedAt: string;
  /** ISO timestamp of the window's lower bound. */
  windowStart: string;
  totals: FailureTotals;
  byExitCause: FailureExitCauseRow[];
  signatures: FailureSignatureRow[];
  /** Signature ranking restricted to the died-early cohort. */
  diedEarlySignatures: FailureSignatureRow[];
  byRole: FailureRoleRow[];
  byWorkspace: FailureWorkspaceRow[];
  repeatFailureTasks: FailureRepeatTaskRow[];
}

/**
 * Answer to "is this error already a known failure pattern?" for one error
 * string, resolved against the signature clusters in the requested window.
 *
 * Decision-shaped on purpose: an agent about to file a friction report needs
 * known/unknown, how often, and a dedupe key — not the whole dashboard payload.
 */
export interface FailureSignatureLookup {
  /** The caller's error text, truncated for echo-back. */
  query: string;
  /** The caller's text run through the same normalizer the clusters use. */
  signature: string;
  /**
   * `namespace:slug` key safe to pass as `create_task` context.frictionSignature,
   * so a report about this failure appends to any existing friction task
   * instead of filing a duplicate.
   */
  frictionSignature: string;
  /** True when this signature already appears in the window. */
  known: boolean;
  /** Occurrences in the window. 0 when `known` is false. */
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** How many occurrences never did any billable work (turns <= 2 at $0). */
  diedEarlyCount: number;
  exitCauses: FailureExitCauseBucket[];
  /** A task ID from the cluster, for drill-down. Null when unknown. */
  exampleTaskId: string | null;
  /**
   * True when the signature ranking covered every failure in the window, so a
   * `known: false` answer is definitive. False when the ranking was capped,
   * in which case a rare match may have been missed.
   */
  exhaustive: boolean;
  /**
   * True when every occurrence came from a worker `/respond` had already
   * marked `superseded` (its question was answered) by the time the error
   * landed — recorded via `workers.postSupersessionError`, never counted in
   * `analytics.totals`/`signatures` at all, because a superseded worker's
   * outcome must not move the failure rate. Absent when `known` is false, or
   * when the match came from the normal failure population.
   */
  supersededOnly?: boolean;
}

/**
 * Aggregate rollup across every failure signature sharing a literal prefix.
 *
 * Built for a family of errors that differ only in embedded free text (e.g.
 * `needs_input: <question>`, `Sandbox mount gap: "<quoted text>"`) — each
 * variant normalizes to its own singleton signature, so none individually
 * rank into the top-N `FailureAnalytics.signatures` list and the family's
 * true size is invisible to both the overview and an exact-match lookup.
 */
export interface FailureSignatureFamily {
  /** The literal prefix the caller searched for. */
  prefix: string;
  /** True when at least one signature in the window starts with the prefix. */
  known: boolean;
  /** Total failed workers across every signature in the family. */
  count: number;
  /** How many distinct normalized signatures share this prefix. */
  distinctSignatures: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** How many family occurrences never did any billable work. */
  diedEarlyCount: number;
  exitCauses: FailureExitCauseBucket[];
  /** A task ID from the family, for drill-down. Null when unknown. */
  exampleTaskId: string | null;
  /** Dedupe key derived from the prefix — shared by every occurrence in the family. */
  frictionSignature: string;
  /** Up to 5 most common distinct signatures in the family, for spot-checking the match. */
  topSignatures: { signature: string; count: number }[];
}

/** Response body of GET /api/health/failures. */
export interface FailureAnalyticsResponse {
  analytics: FailureAnalytics;
  /** Present only when the request carried an `error` param. */
  lookup?: FailureSignatureLookup;
  /** Present only when the request carried an `errorPrefix` param. */
  family?: FailureSignatureFamily;
  /** Present only when the request carried `family=gate`. */
  gates?: GateAnalytics;
  /** Present only when the request carried `family=gate` AND `errorPrefix`. */
  gateFamily?: GateReasonFamily;
}

// ── Gate ledger analytics ─────────────────────────────────────────────────────
//
// The gate ledger answers a question the failure table structurally cannot:
// how often does the platform REFUSE, DEFER, WARN or get TALKED OUT OF a
// decision, for a caller that never became a failed worker? Same windows and
// the same first/last-seen framing as `FailureAnalytics`, deliberately.

/** Shares the failure vocabulary — one window concept across both surfaces. */
export type GateWindow = FailureWindow;

export type GateOutcome = 'rejected' | 'deferred' | 'bypassed' | 'warned' | 'stranded';

export interface GateOutcomeCounts {
  rejected: number;
  deferred: number;
  bypassed: number;
  warned: number;
  /** A task deferred long enough to be flagged by the stranded-task sweep. Excluded from bypassRatePct's denominator, same as `deferred`. */
  stranded: number;
}

/** One normalized reason within a gate. */
export interface GateReasonRow {
  /** Already normalized on write — never re-normalized by the aggregation. */
  reason: string;
  count: number;
  outcomes: GateOutcomeCounts;
  /** See `bypassRatePct` — deferrals are excluded from the denominator. */
  bypassRatePct: number;
  firstSeen: string;
  lastSeen: string;
}

export interface GateRow {
  /** Stable rule slug, e.g. 'manifest_required'. */
  gate: string;
  /** Every route/tool that fired this gate in the window. */
  surfaces: string[];
  count: number;
  outcomes: GateOutcomeCounts;
  /**
   * bypassed / (bypassed + rejected + warned). For a lint, this IS its
   * false-positive rate — measured, not inferred from friction reports.
   */
  bypassRatePct: number;
  firstSeen: string;
  lastSeen: string;
  /** A task from this gate's events, for drill-down. Null when unknown. */
  exampleTaskId: string | null;
  distinctReasons: number;
  topReasons: GateReasonRow[];
}

export interface GateAnalytics {
  window: GateWindow;
  generatedAt: string;
  windowStart: string;
  totals: GateOutcomeCounts & {
    events: number;
    distinctGates: number;
  };
  /** Ranked by count. */
  gates: GateRow[];
  /** How many gates ranked out of `gates`. Zero means the list is exhaustive. */
  truncatedGates: number;
}

/** One full knowledge-ingest job no runner has taken (GET /api/health/failures `stalledIngest`). */
export interface StalledIngestJob {
  id: string;
  workspaceId: string;
  /** "owner/name" */
  repo: string;
  /** `stalled`: queued past the stall window, waiting on the serverless fallback. `fallback`: the fallback is running it. */
  state: 'stalled' | 'fallback';
  /** How long the job has waited (queued age, or since creation once the fallback runs it). */
  ageMs: number;
  attempts: number;
  /** Why the last runner to claim it handed it back (e.g. its checkout cannot fetch). */
  checkoutReason?: string;
  /** Fallback cursor over the repo's ingestible files. */
  progress?: { cursor: number; total: number | null };
  /** Last failing fallback slice, when the most recent tick failed. */
  lastError?: string;
}

/**
 * Full knowledge-ingest jobs that are stuck or being rescued. These never
 * become failed workers, so without this block they are invisible to
 * get_failure_analytics. Omitted from the response when there are none.
 */
export interface StalledIngestReport {
  stalled: number;
  inFallback: number;
  oldestAgeMs: number;
  /** Oldest first, capped; the counts cover every job. */
  jobs: StalledIngestJob[];
}

/**
 * How long approved-and-green PRs wait before they land, from the `pr_landing`
 * gate events (knowledge-base: buildd/design/pr-landing-guarantee.md §J). A regression shows up
 * here before anyone files a friction report.
 */
export interface LandingMetrics {
  window: GateWindow;
  /** PRs merged by the landing function in the window. */
  landed: number;
  /** Of those, how many had no measurable start (no approval or check time was readable). */
  unmeasured: number;
  /** Approved-and-green to merge, over the measured landings. Null when none were measured. */
  timeToLand: { count: number; p50Ms: number; p90Ms: number; maxMs: number } | null;
  stuck: {
    /** A PR approved and green for longer than this without merging is stuck. */
    thresholdMs: number;
    /** Open PRs whose latest landing decision found them approved and green, past the threshold. */
    count: number;
    /** Age of the longest-waiting one, in ms; null when none are stuck. */
    oldestMs: number | null;
  };
}

/**
 * A rollup across every gate reason sharing a literal prefix — the gate-ledger
 * counterpart to `FailureSignatureFamily`, for a reason family whose surviving
 * free text makes each occurrence its own singleton.
 */
export interface GateReasonFamily {
  prefix: string;
  known: boolean;
  count: number;
  distinctReasons: number;
  /** Gates that produced a reason in this family — usually one. */
  gates: string[];
  outcomes: GateOutcomeCounts;
  bypassRatePct: number;
  firstSeen: string | null;
  lastSeen: string | null;
  exampleTaskId: string | null;
  /** Dedupe key derived from the prefix, for friction reports. */
  frictionSignature: string;
  topReasons: { reason: string; count: number }[];
}

// ── Experiments (/api/experiments, MCP manage_experiments) ──────────────────

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'concluded';
export type ExperimentVisibility = 'admins' | 'team';
export type ExperimentKind = 'model_routing' | 'cbm_access' | 'heartbeat_triage' | 'question_gate';

/** An `experiments` row as the API returns it. Dates are ISO strings. */
export interface Experiment {
  id: string;
  key: string;
  title: string;
  hypothesis: string | null;
  status: ExperimentStatus;
  kind: ExperimentKind;
  treatmentFraction: number;
  /**
   * Salt of the arm draw. Bumped whenever the fraction or config changes after
   * the experiment first started, so rows drawn under different settings are
   * read out separately rather than pooled.
   */
  policyVersion: number;
  config: Record<string, unknown>;
  visibility: ExperimentVisibility;
  decision: string | null;
  startedAt: string | null;
  concludedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/experiments. Status always starts at `draft`. */
export interface CreateExperimentInput {
  key: string;
  title: string;
  hypothesis?: string | null;
  kind?: ExperimentKind;
  treatmentFraction?: number;
  config?: Record<string, unknown>;
  visibility?: ExperimentVisibility;
}

/**
 * PATCH /api/experiments/[id]. Legal status moves: draft→running,
 * running⇄paused, draft|running|paused→concluded (needs `decision`).
 * `concluded` is terminal.
 */
export interface UpdateExperimentInput {
  title?: string;
  hypothesis?: string | null;
  treatmentFraction?: number;
  config?: Record<string, unknown>;
  visibility?: ExperimentVisibility;
  status?: ExperimentStatus;
  decision?: string;
}

/**
 * One enrolment-health finding for a running experiment
 * (packages/core/experiment-health.ts). Returned as `health` by
 * GET /api/experiments/[id]/readout (an array, or null when the check failed)
 * and GET /api/experiments (a map of experiment id → findings, running only).
 */
export type ExperimentHealthCode =
  | 'no_recent_assignments'
  | 'arm_never_drawn'
  | 'split_imbalance'
  | 'unit_concentration'
  | 'past_duration_cap';

export interface ExperimentHealthFinding {
  code: ExperimentHealthCode;
  severity: 'warning' | 'critical';
  detail: string;
  arm?: string;
  unitId?: string;
}

// ── Error traces ─────────────────────────────────────────────────────────────

/** One recurring trace pattern in a workspace, from GET /api/workspaces/[id]/error-traces. */
export interface WorkspaceErrorTracePattern {
  /** Pattern slug, e.g. 'git_fatal', 'cd_no_such_file'. */
  pattern: string;
  /** Trace rows matching this pattern in the window. */
  count: number;
  /** Distinct tasks that hit it. */
  taskCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Excerpt and source of the most recent occurrence. */
  exampleExcerpt: string;
  exampleSource: string | null;
  /** Up to three task ids that hit this pattern. */
  exampleTaskIds: string[];
}

export interface WorkspaceErrorTracesResponse {
  workspaceId: string;
  since: string;
  limit: number;
  patterns: WorkspaceErrorTracePattern[];
}

// ─── Home fleet (runners × slots) ─────────────────────────────────────────────

/**
 * One bar on a lane timeline: a worker's run on one runner slot. Generic
 * `{ lane, bars[] }` shape, shared by Home's fleet panel and any other lane
 * grid, so the two can render through one component.
 */
export interface LaneBar {
  id: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms; null while still running. */
  end: number | null;
  /** The task's short label ("reconcile exports spec"). */
  label: string;
  /** One-word scope chip ("exports"), or null. */
  scope?: string | null;
  /** Full task title, for the hover tooltip. */
  title?: string | null;
  /** Role colour from the role's own data; null = neutral. */
  color: string | null;
  roleSlug?: string | null;
  state: 'running' | 'waiting' | 'done' | 'failed';
  href?: string | null;
}

export interface Lane {
  id: string;
  bars: LaneBar[];
}

/** A live worker occupying a runner slot. */
export interface FleetSlotWorker {
  workerId: string;
  taskId: string | null;
  missionId: string | null;
  /** One-word task name ("checkout") and its short label. */
  label: string;
  rest: string;
  roleSlug: string | null;
  roleName: string | null;
  roleColor: string | null;
  status: string;
  /** 0..100, or null when the runner has not reported progress. */
  progress: number | null;
  startedAt: string | null;
  /** Set while the worker is parked on a question. */
  question: string | null;
}

export interface FleetSlot {
  index: number;
  worker: FleetSlotWorker | null;
  /**
   * Last finished run on this slot, for an idle slot's "last …" line. `label`
   * is the task's own short label (null when it has none worth showing);
   * `scope` the one-word chip; `at` when it ended (epoch ms).
   */
  last: { label: string | null; scope: string | null; prNumber: number | null; fix: boolean; failed?: boolean; at?: number | null } | null;
  lane: Lane;
}

export interface FleetRunner {
  /** Heartbeat id, or a synthetic key for workers on an unknown runner. */
  id: string;
  name: string;
  /** Readable machine description ("Mac Studio", "macOS · arm64"), or null. */
  machine: string | null;
  maxSlots: number;
  online: boolean;
  slots: FleetSlot[];
  /**
   * Set when this row is an elastic group of ephemeral `--once` runs (one cloud
   * dispatcher, lib/fleet-view.ts) rather than one machine. Its slots are its
   * live runs, one each; finished runs leave the group.
   */
  elastic?: {
    executor: 'host' | 'cloud' | null;
    group: string | null;
    /** Live runs in the group now (== slots.length). */
    running: number;
  };
}

export interface FleetSnapshot {
  runners: FleetRunner[];
  live: number;
  capacity: number;
  /** Timeline window, epoch ms. */
  window: { from: number; to: number };
}

// ── GET /api/prs (list_prs) ─────────────────────────────────────────────────

/** Which PRs `GET /api/prs` lists. There is deliberately no `closed`. */
export type PrListState = 'open' | 'attention' | 'conflict' | 'ci_failed' | 'merged';

/** One PR, collapsed from all the workers that share it (apps/web/src/lib/pr-list.ts). */
export interface PrListItem {
  workerId: string;
  prNumber: number | null;
  prUrl: string;
  status: string | null;
  mergedAt: string | null;
  lastCheckedAt: string | null;
  conflictDetectedAt: string | null;
  startedAt: string | null;
  workspaceId: string;
  workspaceName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  missionId: string | null;
  missionTitle: string | null;
  baseRef: string | null;
  // Present only when they matter (apps/web/src/lib/pr-list.ts prSignals):
  /** Why a person is needed: the escalation inbox's decision. */
  waitingOnYou?: string;
  /** An agent is already on it. */
  resolving?: 'conflict' | 'ci' | 'review';
  /** CI fix tasks buildd has dispatched for this PR (red only). */
  ciFixAttempts?: number;
  /** Targets a mission integration branch. */
  intoMissionBranch?: string;
  /** State last read from GitHub this many hours ago (over an hour). */
  checkedHoursAgo?: number;
}

export interface ListPrsResponse {
  state: PrListState;
  /** How many workspaces the list covered. */
  workspaceCount: number;
  /** merged only: the window. */
  sinceDays?: number;
  prs: PrListItem[];
}

// ── Evidence reads (docs/specs/byo-evidence-storage.md, "Read paths") ──────

export type EvidenceKind = 'command_output' | 'test_report' | 'ci_job_log' | 'transcript' | 'pr_diff';

/** One `evidence_objects` pointer as the read routes list it. Never a bucket URL. */
export interface EvidenceObjectSummary {
  id: string;
  workspaceId: string;
  taskId: string;
  rootTaskId: string;
  workerId: string;
  prNumber: number | null;
  kind: EvidenceKind;
  bytes: number;
  uploadState: 'pending' | 'stored' | 'failed' | 'unreadable';
  indexState: 'skipped' | 'queued' | 'indexed' | 'failed';
  createdAt: string;
  expiresAt: string | null;
}

/** Text cut from one object: at most 64 KB, redacted. */
export interface EvidenceReadResult {
  text: string;
  /** More matched than fits the cap, or the scan hit one of its bounds. */
  truncated: boolean;
  /** Pass back as `cursor=` to continue a forward read; null when nothing is left, and in tail mode. */
  cursor: string | null;
  fromLine: number | null;
  toLine: number | null;
  lineCount: number;
  scannedLines: number;
  /** The decompressed-size bound was hit before the end of the object. */
  scanLimited: boolean;
}

/** GET /api/tasks/:id/evidence (no evidenceId). */
export interface TaskEvidenceListResponse {
  taskId: string;
  workspaceId: string;
  objects: EvidenceObjectSummary[];
  resolvedFrom?: string;
}

/** GET /api/tasks/:id/evidence?evidenceId=… */
export interface TaskEvidenceReadResponse extends EvidenceReadResult {
  taskId: string;
  workspaceId: string;
  object: EvidenceObjectSummary;
}

/** GET /api/evidence?workspaceId=&prNumber=|evidenceId=&kind= */
export interface EvidenceLookupResponse {
  workspaceId: string;
  prNumber: number | null;
  taskIds: string[];
  objects: EvidenceObjectSummary[];
}

/** Aggregate coordination telemetry; no worker, user or cost details. */
export interface CoordinationMetricFilters {
  window: '24h' | '7d' | '30d';
  windowStart: string;
  workspaceIds: string[];
  missionId: string | null;
}
export interface ManifestCoverageCounts {
  total: number;
  concrete: number;
  advisory: number;
  none: number;
  /** Fraction in [0, 1]; null for an empty population. */
  concreteShare: number | null;
}
export interface CoordinationDecisionCapability {
  workspaceId: string;
  capability: string;
  status: 'enabled' | 'capability_disabled';
}
export interface ManifestCoverageStats extends CoordinationMetricFilters, ManifestCoverageCounts {
  decisionCapabilities?: CoordinationDecisionCapability[];
  groups: Array<ManifestCoverageCounts & { workspaceId: string; missionId: string | null; kind: string | null }>;
}
export interface PathClaimCallCounts {
  claimed: number;
  blocked: number;
  deadlock: number;
  rejected: number;
}
export interface PathClaimStats extends CoordinationMetricFilters, PathClaimCallCounts {
  decisionCapabilities?: CoordinationDecisionCapability[];
  calls: number;
  bySurface: Array<PathClaimCallCounts & { surface: string; firstRecordedAt: string | null }>;
  coverage: { completeHistoricalCalls: boolean; note: string };
}
export interface CoordinationStats {
  manifestCoverage: ManifestCoverageStats;
  pathClaims: PathClaimStats;
}

// ── Workspace onboarding (docs/design/workspace-onboarding.md §2) ──────────
// The readiness report is recomputed from the repo on every request and never
// stored; only what the repo cannot tell us is persisted, in
// `workspaces.gitConfig.onboarding`. Absent means current behaviour.

export type WorkspaceReadinessItemId =
  | 'agent-instructions'
  | 'spec-root'
  | 'spec-format'
  | 'test-command'
  | 'typecheck-command'
  | 'build-command'
  | 'env-manifest'
  | 'migrations-dir'
  | 'merge-policy'
  | 'release-path'
  | 'visual-qa-source';

export type WorkspaceReadinessNextStep =
  | 'link-repo'
  | 'review-policy'
  | 'propose-fixes'
  | 'author-spec'
  | 'first-mission'
  | 'done';

export interface WorkspaceOnboardingConfig {
  /** Items the owner said are not for this repo. */
  waived?: Record<string, { reason: string; at: string }>;
  /** The open scaffold PR, when one exists. */
  scaffoldPr?: { number: number; branch: string };
  lastSeenPolicyInitAt?: string;
}

export interface WorkspaceReadinessItem {
  id: WorkspaceReadinessItemId;
  label: string;
  /** `unknown` = could not tell (truncated tree, unreadable manifest, detector not available). */
  status: 'detected' | 'missing' | 'unknown';
  importance: 'core' | 'recommended';
  evidence: Array<{ kind: 'path' | 'manifest' | 'signal' | 'absent'; paths?: string[]; note: string }>;
  fix: {
    kind: 'scaffold' | 'apply-config' | 'owner-decision' | 'none';
    summary: string;
    templateId?: string;
    configPatch?: Record<string, unknown>;
  } | null;
  /** The detected value when there is one: a command, a directory, a source name. */
  value?: string;
  waived?: { reason: string; at: string };
}

/** Response of `GET /api/workspaces/[id]/readiness`. */
export interface WorkspaceReadinessReport {
  items: WorkspaceReadinessItem[];
  nextStep: WorkspaceReadinessNextStep;
  skill: 'workspace-onboarding';
  /** The git tree response was truncated. */
  truncated: boolean;
}
