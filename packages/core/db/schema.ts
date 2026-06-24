import {
  pgTable, uuid, text, timestamp, jsonb, integer, decimal, boolean, index, uniqueIndex, primaryKey, bigint, pgEnum, customType
} from 'drizzle-orm/pg-core';

// Custom pgvector column type. HNSW + GIN indexes are added in the migration SQL.
const vectorType = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(',').map(Number);
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

export const agentBackendEnum = pgEnum('agent_backend', ['claude', 'codex']);
import { relations } from 'drizzle-orm';
import type { WorkerEnvironment } from '@buildd/shared';

// Teams table for multi-tenancy ownership
export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().$type<'free' | 'pro' | 'team'>().default('free'),
  memoryApiKey: text('memory_api_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

  // Aggregate monthly budget tracking across all token-accounts owned by this team.
  // Replaces the per-account fields so that a single $100/mo SDK credit pool is
  // correctly tracked regardless of which API token the worker ran under.
  // monthlyBudgetUsd: cap (e.g. 100); null falls back to BUDGET_MONTHLY_USD env.
  // monthlyCostUsd accumulates spend for monthlyCostMonth (UTC "YYYY-MM"); resets on the 1st.
  // budgetAlertsSent records which percent thresholds have already alerted this month.
  monthlyBudgetUsd: decimal('monthly_budget_usd', { precision: 10, scale: 2 }),
  monthlyCostUsd: decimal('monthly_cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  monthlyCostMonth: text('monthly_cost_month'),
  budgetAlertsSent: jsonb('budget_alerts_sent').default([]).$type<number[]>().notNull(),

  // Team-level provider enablement mask. NULL (or empty) = all providers enabled
  // — the default, so existing teams are unaffected. When a provider is disabled
  // here, tasks that resolve to it are masked to an enabled provider at claim time
  // WITHOUT mutating per-workspace/role/mission/task settings. Re-enabling lifts
  // the mask and restores prior behavior automatically (no stored state to undo).
  // This is a reversible toggle layered ABOVE the resolution chain, not another
  // default in it. See packages/core/backend-policy.ts.
  enabledBackends: agentBackendEnum('enabled_backends').array(),
}, (t) => ({
  slugIdx: uniqueIndex('teams_slug_idx').on(t.slug),
}));

// Team membership
export const teamMembers = pgTable('team_members', {
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  role: text('role').notNull().$type<'owner' | 'admin' | 'member'>(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamId, t.userId] }),
  teamIdx: index('team_members_team_idx').on(t.teamId),
  userIdx: index('team_members_user_idx').on(t.userId),
}));

// Users table for multi-tenancy
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleId: text('google_id').unique(),  // from token.sub / account.providerAccountId
  githubId: text('github_id').unique(),
  email: text('email').notNull(),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  googleIdIdx: uniqueIndex('users_google_id_idx').on(t.googleId),
  githubIdIdx: uniqueIndex('users_github_id_idx').on(t.githubId),
  emailIdx: index('users_email_idx').on(t.email),
}));

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull().$type<'user' | 'service' | 'action'>(),
  level: text('level').default('worker').notNull().$type<'trigger' | 'worker' | 'admin'>(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  apiKeyPrefix: text('api_key_prefix'),
  githubId: text('github_id'),

  // Authentication type
  authType: text('auth_type').default('api').notNull().$type<'api' | 'oauth'>(),

  // For API-based auth (pay-per-token)
  anthropicApiKey: text('anthropic_api_key'),
  maxCostPerDay: decimal('max_cost_per_day', { precision: 10, scale: 2 }),
  totalCost: decimal('total_cost', { precision: 10, scale: 2 }).default('0').notNull(),

  // For OAuth-based auth (seat-based)
  // @deprecated — OAuth tokens are now stored encrypted in the `secrets` table (purpose='oauth_token').
  // This column is kept for backward compatibility and will be removed in a future migration.
  oauthToken: text('oauth_token'),
  seatId: text('seat_id'),
  maxConcurrentSessions: integer('max_concurrent_sessions'),
  activeSessions: integer('active_sessions').default(0).notNull(),

  // Budget exhaustion tracking (OAuth accounts)
  budgetExhaustedAt: timestamp('budget_exhausted_at', { withTimezone: true }),
  budgetResetsAt: timestamp('budget_resets_at', { withTimezone: true }),

  // Monthly budget tracking (Agent SDK credit pool, post 2026-06-15).
  // monthlyBudgetUsd is the cap (e.g. 100); null falls back to the BUDGET_MONTHLY_USD env.
  // monthlyCostUsd accumulates spend for monthlyCostMonth (UTC "YYYY-MM"); both reset on the 1st.
  // budgetAlertsSent records which percent thresholds have already alerted this month.
  monthlyBudgetUsd: decimal('monthly_budget_usd', { precision: 10, scale: 2 }),
  monthlyCostUsd: decimal('monthly_cost_usd', { precision: 12, scale: 6 }).default('0').notNull(),
  monthlyCostMonth: text('monthly_cost_month'),
  budgetAlertsSent: jsonb('budget_alerts_sent').default([]).$type<number[]>().notNull(),

  // Common
  maxConcurrentWorkers: integer('max_concurrent_workers').default(3).notNull(),
  totalTasks: integer('total_tasks').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),

  // Multi-tenancy: team that owns this account
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({
  apiKeyIdx: uniqueIndex('accounts_api_key_idx').on(t.apiKey),
  githubIdIdx: index('accounts_github_id_idx').on(t.githubId),
  authTypeIdx: index('accounts_auth_type_idx').on(t.authType),
  seatIdIdx: index('accounts_seat_id_idx').on(t.seatId),
  teamIdx: index('accounts_team_idx').on(t.teamId),
}));

export const accountWorkspaces = pgTable('account_workspaces', {
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  canClaim: boolean('can_claim').default(true).notNull(),
  canCreate: boolean('can_create').default(false).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.workspaceId] }),
}));

// Git workflow configuration type
export interface WorkspaceGitConfig {
  // Branching
  defaultBranch: string;              // 'main', 'master', 'dev'
  branchingStrategy: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
  branchPrefix?: string;              // 'feature/', 'buildd/', null for none
  useBuildBranch?: boolean;          // Use buildd/task-id naming

  // Commit conventions
  commitStyle: 'conventional' | 'freeform' | 'custom';
  commitPrefix?: string;              // '[JIRA-123]', null

  // PR/Merge behavior
  requiresPR: boolean;
  targetBranch?: string;              // Where PRs should target
  autoCreatePR: boolean;

  // Agent instructions (prepended to prompt)
  agentInstructions?: string;         // Free-form, admin-defined
  useClaudeMd: boolean;               // Whether to load CLAUDE.md (default: true if exists)

  // Permission mode
  bypassPermissions?: boolean;        // Allow agent to bypass permission prompts (dangerous commands still blocked)

  // Default agent backend for tasks in this workspace, when neither the task
  // (task.backend) nor its role (role.defaultBackend) specifies one. Resolution
  // precedence: task.backend → role.defaultBackend → workspace default → 'claude'.
  defaultBackend?: 'claude' | 'codex';


  // Maximum budget in USD per worker session (passed to SDK as maxBudgetUsd)
  // The SDK will stop the agent when this limit is reached
  maxBudgetUsd?: number;

  // Sandbox configuration for worker isolation (SDK v0.2.44+)
  sandbox?: {
    enabled?: boolean;
    autoAllowBashIfSandboxed?: boolean;
    network?: {
      allowedDomains?: string[];
      allowLocalBinding?: boolean;
    };
    excludedCommands?: string[];
  };

  // SDK debug logging (SDK v0.2.44+)
  debug?: boolean;               // Enable verbose SDK debug output to stderr
  debugFile?: string;             // File path to write SDK debug logs to

  // Fallback model (SDK v0.2.45+)
  // Automatically switches to this model if the primary model fails (e.g., rate limited, unavailable).
  // Can be overridden per-task via task.context.fallbackModel.
  fallbackModel?: string;

  // 1M context window beta (SDK v0.2.45+)
  // Enables 'context-1m-2025-08-07' beta for Sonnet models (4.5, 4.6+).
  // Reduces context compaction at higher cost — useful for large codebases.
  // Can be overridden per-task via task.context.extendedContext.
  extendedContext?: boolean;

  // Thinking / effort controls (SDK v0.2.45+)
  // Controls Claude's reasoning behavior. Can be overridden per-task via task.context.thinking / task.context.effort.
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' };
  effort?: 'low' | 'medium' | 'high' | 'max';

  // Block config file changes during worker sessions (SDK v0.2.49+ ConfigChange hook)
  // When true, returns { continue: false } to prevent agents from modifying config files.
  blockConfigChanges?: boolean;

  // Worktree isolation for subagents (SDK v0.2.49+)
  // When enabled, skill-as-subagent definitions include `isolation: 'worktree'`
  // so each subagent runs in its own temporary git worktree, preventing file conflicts
  // during parallel work. Requires git repo context — non-git workspaces ignore this.
  useWorktreeIsolation?: boolean;

  // Background agents (SDK v0.2.49+)
  // When enabled, skill-as-subagent definitions include `background: true`
  // so subagents always run as background tasks, useful for long-running monitoring,
  // parallel background work, or audit/logging agents alongside the primary task.
  // Can be overridden per-task via task.context.useBackgroundAgents.
  useBackgroundAgents?: boolean;

  // CI failure auto-retry: max number of retry attempts when CI fails on a worker's PR
  // Defaults to 3 if not set. Set to 0 to disable CI retries entirely.
  maxCiRetries?: number;

  // Auto-merge PRs via GitHub's auto-merge feature (requires branch protection + CI)
  // When enabled, PRs created by workers will have auto-merge enabled with squash method
  autoMergePR?: boolean;

  // Replaces autoMergePR — defaults to TRUE when neither field is set, making auto-merge opt-OUT.
  // Takes precedence over autoMergePR when present.
  autoMergeOnGreenCI?: boolean;

  // Safety rails for autoMergePR — if set, PRs that violate these are NOT auto-merged
  // even when CI is green. A mission notification is sent instead.
  autoMergeDenyPaths?: string[];      // e.g. ["drizzle/", "src/lib/auth/"] — any touched path starting with these blocks auto-merge
  autoMergeMaxLines?: number;         // total additions+deletions threshold (default 800)

  // Default runner preference for new tasks created in this workspace
  // Controls which type of runner (user/service/action) can claim tasks by default
  // Can be overridden per-task at creation time
  defaultRunnerPreference?: 'any' | 'user' | 'service' | 'action';

}

// How a workspace performs a release. buildd owns the envelope (resolve →
// preflight → dispatch → readback); each workspace declares the steps here.
// Absent ⇒ 'branch_merge' for backward-compat (the original, pre-strategy shape).
//   - workflow_dispatch: dispatch the repo's own release workflow (most general;
//     release semantics live in the repo's Actions). buildd's own dev→main is
//     just one workspace configured this way — nothing special about it.
//   - branch_merge: buildd merges a source ref into prodBranch via the GitHub
//     API, then verifies the deploy + runs hooks. For repos with no workflow.
//   - script: spawn a worker task that runs the repo's own release command.
export type ReleaseStrategy = 'workflow_dispatch' | 'branch_merge' | 'script';

// Release configuration for a workspace — controls whether/how releases happen.
// Stored as jsonb, so this is a free-form shape (no migration on change). All
// step-specific fields are optional; `resolveReleaseStrategy` validates them
// per the chosen strategy.
export interface WorkspaceReleaseConfig {
  // Whether this workspace is configured for releases. Projects without this never release.
  enabled: boolean;

  // Which strategy this workspace uses. Absent ⇒ 'branch_merge' (legacy default).
  strategy?: ReleaseStrategy;

  // ── strategy: 'workflow_dispatch' ──────────────────────────────────────────
  // Workflow file to dispatch on the target repo, e.g. 'release.yml'.
  workflowFile?: string;
  // Git ref the workflow runs on, e.g. 'dev'.
  ref?: string;
  // Extra workflow_dispatch inputs (string-valued, per the GitHub API).
  inputs?: Record<string, string>;

  // ── strategy: 'branch_merge' (legacy default) ──────────────────────────────
  // The production branch to merge changes into (e.g., 'main')
  prodBranch?: string;

  // Deploy target for verifying the production deploy completed
  deployTarget?: {
    type: 'vercel';
    // Vercel project slug or ID (used to look up deployments)
    projectId?: string;
    // Vercel team slug or ID (required for team projects)
    teamId?: string;
  };

  // Post-deploy hooks — run after a successful deploy is confirmed.
  // e.g., workspace re-link, cache warm, notification
  postDeployHooks?: Array<{
    // Type of hook. 'buildd_mcp' calls the buildd MCP tool; 'http' POSTs to a URL.
    type: 'buildd_mcp' | 'http';
    description: string;
    // For type='buildd_mcp': the action and params passed to the buildd tool
    action?: string;
    params?: Record<string, unknown>;
    // For type='http': the URL and optional headers
    url?: string;
    headers?: Record<string, string>;
  }>;

  // Optional URL to GET after deploy to verify prod is healthy (expects 2xx)
  verificationUrl?: string;

  // ── strategy: 'script' ─────────────────────────────────────────────────────
  // Shell command a spawned worker task runs to release (e.g. 'bun run release').
  command?: string;
}

// Result of a release sequence — stored in tasks.release_result
export interface ReleaseResult {
  status: 'completed' | 'failed' | 'skipped' | 'not_configured';
  message: string;
  // When the merge to prod branch completed
  mergedAt?: string;
  // Final Vercel deployment URL (if verified)
  deployUrl?: string;
  // Vercel deployment state (READY, ERROR, etc.)
  deployState?: string;
  // Results from post-deploy hooks
  hooksRan?: Array<{ description: string; success: boolean; error?: string }>;
  // Error details if status='failed'
  error?: string;
}

// Webhook configuration for external agent dispatch (e.g., OpenClaw)
export interface WorkspaceWebhookConfig {
  // Webhook endpoint URL (e.g., http://localhost:18789/hooks/agent)
  url: string;
  // Bearer token for authentication
  token: string;
  // Whether to dispatch new tasks to this webhook
  enabled: boolean;
  // Optional: only dispatch tasks with specific runner preference
  runnerPreference?: 'any' | 'user' | 'service' | 'action';
}

// Schedule trigger - conditional check before creating a task
export interface ScheduleTrigger {
  type: 'rss' | 'http-json';
  url: string;
  // Dot-notation path to extract a value (e.g., ".tag_name", ".feed.entry[0].title")
  path?: string;
  // Optional HTTP headers (e.g., for GitHub API auth)
  headers?: Record<string, string>;
}

// Task schedule template - defines what task to create on each run
export interface TaskScheduleTemplate {
  title: string;
  description?: string;
  mode?: 'execution' | 'planning';
  priority?: number;
  runnerPreference?: 'any' | 'user' | 'service' | 'action';
  requiredCapabilities?: string[];
  context?: Record<string, unknown>;
  trigger?: ScheduleTrigger;
  // Optional classification overrides. When unset, the cron-schedules route
  // infers them from cadence (`classifyScheduleCadence`). Routing at claim
  // time consumes these via tasks.kind / tasks.complexity.
  kind?: 'coordination' | 'engineering' | 'research' | 'writing' | 'design' | 'analysis' | 'observation';
  complexity?: 'simple' | 'normal' | 'complex';
}

// Task result/deliverable snapshot - populated when worker completes
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
  releaseSummary?: string;
  nextSuggestion?: string;
  phases?: Array<{ label: string; toolCount: number }>;
  lastQuestion?: string;
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

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  repo: text('repo'),
  localPath: text('local_path'),
  memory: jsonb('memory').default({}).$type<Record<string, unknown>>(),
  projects: jsonb('projects').default([]).$type<Array<{ name: string; path?: string; description?: string; color?: string }>>(),
  // GitHub integration
  githubRepoId: uuid('github_repo_id'),  // Will add FK after githubRepos is defined
  githubInstallationId: uuid('github_installation_id'),
  // Access control: 'open' = any token can claim, 'restricted' = only linked accounts
  accessMode: text('access_mode').default('open').notNull().$type<'open' | 'restricted'>(),

  // Max tasks from this workspace that may have an active worker at once. Repo-backed
  // workspaces isolate each task in its own git worktree, so parallel work is safe;
  // this caps it to bound merge-conflict surface. Default 3. No effect on repo-less
  // workspaces (those are never serialized by the per-repo guard).
  maxConcurrentTasks: integer('max_concurrent_tasks').default(3).notNull(),

  // Git workflow configuration
  gitConfig: jsonb('git_config').$type<WorkspaceGitConfig>(),
  configStatus: text('config_status').default('unconfigured').notNull().$type<'unconfigured' | 'admin_confirmed'>(),

  // Webhook configuration for external agent dispatch (OpenClaw, etc.)
  webhookConfig: jsonb('webhook_config').$type<WorkspaceWebhookConfig>(),

  // Discord integration
  discordConfig: jsonb('discord_config').$type<{
    guildId?: string;
    channelId?: string;
    botToken?: string;
    enabled?: boolean;
  }>(),

  // Slack integration
  slackConfig: jsonb('slack_config').$type<{
    teamId?: string;
    channelId?: string;
    botToken?: string;
    enabled?: boolean;
  }>(),

  // Release configuration — controls whether tasks can trigger a prod deploy
  releaseConfig: jsonb('release_config').$type<WorkspaceReleaseConfig>(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

  // Multi-tenancy: team that owns this workspace
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({
  githubRepoIdx: index('workspaces_github_repo_idx').on(t.githubRepoId),
  githubInstallationIdx: index('workspaces_github_installation_idx').on(t.githubInstallationId),
  teamIdx: index('workspaces_team_idx').on(t.teamId),
  configStatusIdx: index('workspaces_config_status_idx').on(t.configStatus),
}));

// Missions — first-class goals that tasks can be linked to
export const missions = pgTable('missions', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('active').notNull().$type<'active' | 'paused' | 'completed' | 'archived'>(),
  priority: integer('priority').default(0).notNull(),
  defaultOutputRequirement: text('default_output_requirement').$type<'pr_required' | 'artifact_required' | 'none' | 'auto'>(),
  // Default agent backend for tasks generated under this mission. An explicit
  // per-task backend still wins; otherwise this overrides the role's hint.
  defaultBackend: agentBackendEnum('default_backend'),
  scheduleId: uuid('schedule_id'),
  parentMissionId: uuid('parent_mission_id'),
  lastEvaluationTaskId: uuid('last_evaluation_task_id'),
  contextArtifactIds: jsonb('context_artifact_ids').default([]).$type<string[]>(),
  maxConcurrentTasks: integer('max_concurrent_tasks'),
  // Shared feature branch for this mission. All mission tasks push commits here;
  // a single PR tracks all mission work. Generated lazily on first task creation.
  workingBranch: text('working_branch'),
  primaryPrNumber: integer('primary_pr_number'),
  primaryPrUrl: text('primary_pr_url'),
  // Dedup key for PR-ready push notifications — set to PR head SHA after each notify.
  lastNotifiedSha: text('last_notified_sha'),
  // When true, worker PRs for tasks in this mission must be reviewed by a human before merging.
  requiresReview: boolean('requires_review').default(false).notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('missions_team_idx').on(t.teamId),
  workspaceIdx: index('missions_workspace_idx').on(t.workspaceId),
  statusIdx: index('missions_status_idx').on(t.status),
  parentIdx: index('missions_parent_idx').on(t.parentMissionId),
}));


export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  externalId: text('external_id'),
  externalUrl: text('external_url'),
  title: text('title').notNull(),
  description: text('description'),
  context: jsonb('context').default({}).$type<Record<string, unknown>>(),
  status: text('status').default('pending').notNull(),
  priority: integer('priority').default(0).notNull(),
  mode: text('mode').default('execution').notNull().$type<'execution' | 'planning'>(),
  runnerPreference: text('runner_preference').default('any').notNull().$type<'any' | 'user' | 'service' | 'action'>(),
  requiredCapabilities: jsonb('required_capabilities').default([]).$type<string[]>(),
  claimedBy: uuid('claimed_by').references(() => accounts.id, { onDelete: 'set null' }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  // Task creator tracking
  createdByAccountId: uuid('created_by_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  createdByWorkerId: uuid('created_by_worker_id'),  // FK constraint defined in migration (circular ref with workers)
  creationSource: text('creation_source').default('api').$type<'dashboard' | 'api' | 'mcp' | 'github' | 'local_ui' | 'schedule' | 'webhook' | 'orchestrator'>(),
  // Direct link to the task_schedule that spawned this task (when creationSource = 'schedule' or 'orchestrator').
  // Enables reverse lookup: given a stray task, find the schedule that created it.
  scheduleId: uuid('schedule_id'),  // FK constraint defined in migration (circular ref with task_schedules)
  parentTaskId: uuid('parent_task_id'),  // FK constraint for self-reference defined in migration
  // Task category for visual grouping
  category: text('category').$type<'bug' | 'feature' | 'refactor' | 'chore' | 'docs' | 'test' | 'infra' | 'design'>(),
  project: text('project'),
  // Output requirement — controls what deliverables are enforced on completion
  outputRequirement: text('output_requirement').default('auto').$type<'pr_required' | 'artifact_required' | 'none' | 'auto'>(),
  // JSON Schema for structured output — passed to SDK outputFormat
  outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
  // Mission linking
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
  // Role routing — if set, only runners with this skill can claim
  roleSlug: text('role_slug'),
  // Workflow DAG: task IDs that must complete before this task is claimable
  dependsOn: jsonb('depends_on').default([]).$type<string[]>(),
  // Deliverable snapshot - populated on worker completion
  result: jsonb('result').$type<TaskResult | null>(),
  // Smart model routing — populated at task creation, consumed at claim time.
  // See plans/buildd/smart-model-routing.md for the taxonomy + routing logic.
  kind: text('kind').$type<'coordination' | 'engineering' | 'research' | 'writing' | 'design' | 'analysis' | 'observation'>(),
  complexity: text('complexity').$type<'simple' | 'normal' | 'complex'>(),
  predictedModel: text('predicted_model'),   // model chosen by router at claim
  classifiedBy: text('classified_by').$type<'organizer' | 'classifier' | 'user' | 'default'>(),
  // Agent backend that executes this task
  backend: agentBackendEnum('backend').notNull().default('claude'),
  // When true, the worker PR for this task must be reviewed by a human before auto-merge.
  // Takes precedence over the mission-level requiresReview.
  requiresReview: boolean('requires_review').default(false).notNull(),
  // Release override — whether this task should trigger a prod release on completion.
  // 'true' forces release (errors if workspace has no release config).
  // 'false' suppresses release even when the workspace default is on.
  // 'inherit' (default) uses the workspace release config.
  release: text('release').default('inherit').$type<'true' | 'false' | 'inherit'>(),
  // Release sequence outcome — populated after the release sequence runs (or is skipped).
  releaseResult: jsonb('release_result').$type<ReleaseResult | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('tasks_workspace_idx').on(t.workspaceId),
  statusIdx: index('tasks_status_idx').on(t.status),
  claimedByIdx: index('tasks_claimed_by_idx').on(t.claimedBy),
  runnerPrefIdx: index('tasks_runner_pref_idx').on(t.runnerPreference),
  modeIdx: index('tasks_mode_idx').on(t.mode),
  createdByAccountIdx: index('tasks_created_by_account_idx').on(t.createdByAccountId),
  parentTaskIdx: index('tasks_parent_task_idx').on(t.parentTaskId),
  projectIdx: index('tasks_project_idx').on(t.project),
  missionIdx: index('tasks_mission_idx').on(t.missionId),
  scheduleIdx: index('tasks_schedule_idx').on(t.scheduleId),
  kindIdx: index('tasks_kind_idx').on(t.kind),
}));

export const workers = pgTable('workers', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  runner: text('runner').notNull(),
  branch: text('branch').notNull(),
  status: text('status').default('idle').notNull(),
  waitingFor: jsonb('waiting_for').$type<{ type: string; prompt: string; options?: string[] } | null>(),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }).default('0').notNull(),
  // Token usage (for seat-based accounts where cost isn't meaningful)
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  turns: integer('turns').default(0).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  error: text('error'),
  // Runner direct access URL (e.g., https://runner--workspace.coder.dev or http://100.x.x.x:8766)
  localUiUrl: text('local_ui_url'),
  // Current action/status line from runner
  currentAction: text('current_action'),
  // Milestones stored as JSON array
  milestones: jsonb('milestones').default([]).$type<Array<{ label: string; timestamp: number }>>(),
  // PR tracking
  prUrl: text('pr_url'),
  prNumber: integer('pr_number'),
  // Git stats - updated by agent on progress reports
  lastCommitSha: text('last_commit_sha'),
  commitCount: integer('commit_count').default(0),
  filesChanged: integer('files_changed').default(0),
  linesAdded: integer('lines_added').default(0),
  linesRemoved: integer('lines_removed').default(0),
  // Admin instructions - delivered on next progress update
  pendingInstructions: text('pending_instructions'),
  // Instruction history - log of sent instructions and worker responses
  instructionHistory: jsonb('instruction_history').default([]).$type<Array<{
    type: 'instruction' | 'response';
    message: string;
    timestamp: number;
  }>>(),
  // SDK result metadata - captured from SDKResultSuccess/SDKResultError on completion
  resultMeta: jsonb('result_meta').$type<ResultMeta | null>(),
  // MCP tool call log - appended by runner during execution
  mcpCalls: jsonb('mcp_calls').default([]).$type<Array<{
    server: string;
    tool: string;
    ts: number;
    ok: boolean;
    durationMs?: number;
  }>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index('workers_task_idx').on(t.taskId),
  workspaceIdx: index('workers_workspace_idx').on(t.workspaceId),
  accountIdx: index('workers_account_idx').on(t.accountId),
  statusIdx: index('workers_status_idx').on(t.status),
  accountStatusIdx: index('workers_account_status_idx').on(t.accountId, t.status),
}));

/**
 * Pattern-matched errors observed in agent tool output (Bash results, Read
 * failures, etc.). The runner intercepts the Agent SDK's tool-result messages
 * and writes a row here for each match. Used for UI error-count badges and
 * agent-queryable debugging (see get_error_traces MCP action).
 *
 * Throttled at the runner: same (workerId, pattern) max 1 row per 60s, so a
 * flailing agent doesn't flood (2026-05-25 incident: agent ran `cd …` 8 times
 * in succession; we want one trace, not eight).
 */
export const workerErrorTraces = pgTable('worker_error_traces', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  // Slug for the matched pattern, e.g. 'cd_no_such_file', 'git_fatal', 'oom'
  pattern: text('pattern').notNull(),
  // Truncated raw line from the tool output (max ~500 chars, enforced at write)
  excerpt: text('excerpt').notNull(),
  // Tool that produced the output, e.g. 'bash', 'read', 'edit'
  source: text('source'),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workerTsIdx: index('worker_error_traces_worker_ts_idx').on(t.workerId, t.ts),
  taskTsIdx: index('worker_error_traces_task_ts_idx').on(t.taskId, t.ts),
  patternIdx: index('worker_error_traces_pattern_idx').on(t.pattern),
}));

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
  key: text('key'),
  type: text('type').notNull(),
  title: text('title'),
  content: text('content'),
  storageKey: text('storage_key'),
  shareToken: text('share_token'),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workerIdx: index('artifacts_worker_idx').on(t.workerId),
  shareTokenIdx: uniqueIndex('artifacts_share_token_idx').on(t.shareToken),
  workspaceIdx: index('artifacts_workspace_idx').on(t.workspaceId),
  workspaceKeyIdx: uniqueIndex('artifacts_workspace_key_idx').on(t.workspaceId, t.key),
  missionIdx: index('artifacts_mission_idx').on(t.missionId),
}));

// Mission notes — lightweight append-only feed for agent↔user communication
export const missionNotes = pgTable('mission_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id'),
  workerId: uuid('worker_id'),
  authorType: text('author_type').notNull().$type<'agent' | 'user' | 'system'>(),
  type: text('type').notNull().$type<'decision' | 'question' | 'warning' | 'suggestion' | 'update' | 'reply' | 'guidance'>(),
  title: text('title').notNull(),
  body: text('body'),
  replyTo: uuid('reply_to'),
  defaultChoice: text('default_choice'),
  status: text('status').notNull().default('open').$type<'open' | 'answered' | 'dismissed'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  missionIdx: index('mission_notes_mission_idx').on(t.missionId),
  replyToIdx: index('mission_notes_reply_to_idx').on(t.replyTo),
  typeIdx: index('mission_notes_type_idx').on(t.type),
  statusIdx: index('mission_notes_status_idx').on(t.status),
}));

// observations table removed — memory is now stored in external memory service

// Worker heartbeats - tracks runner instance availability independent of worker records
export const workerHeartbeats = pgTable('worker_heartbeats', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }).notNull(),
  localUiUrl: text('local_ui_url').notNull(),
  viewerToken: text('viewer_token'),
  workspaceIds: jsonb('workspace_ids').default([]).$type<string[]>().notNull(),
  maxConcurrentWorkers: integer('max_concurrent_workers').default(3).notNull(),
  activeWorkerCount: integer('active_worker_count').default(0).notNull(),
  environment: jsonb('environment').$type<WorkerEnvironment>(),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountIdx: index('worker_heartbeats_account_idx').on(t.accountId),
  localUiUrlIdx: uniqueIndex('worker_heartbeats_local_ui_url_idx').on(t.accountId, t.localUiUrl),
  heartbeatIdx: index('worker_heartbeats_heartbeat_idx').on(t.lastHeartbeatAt),
}));

// Task schedules - cron-based automated task creation
export const taskSchedules = pgTable('task_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  cronExpression: text('cron_expression').notNull(),
  timezone: text('timezone').default('UTC').notNull(),
  taskTemplate: jsonb('task_template').notNull().$type<TaskScheduleTemplate>(),
  enabled: boolean('enabled').default(true).notNull(),
  oneShot: boolean('one_shot').default(false).notNull(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastTaskId: uuid('last_task_id'),
  totalRuns: integer('total_runs').default(0).notNull(),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  lastError: text('last_error'),
  maxConcurrentFromSchedule: integer('max_concurrent_from_schedule').default(1).notNull(),
  pauseAfterFailures: integer('pause_after_failures').default(5).notNull(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastTriggerValue: text('last_trigger_value'),
  totalChecks: integer('total_checks').default(0).notNull(),
  lastDeferralReason: text('last_deferral_reason').$type<'concurrent_cap' | 'active_hours' | 'trigger_unchanged'>(),
  lastDeferredAt: timestamp('last_deferred_at', { withTimezone: true }),
  pendingSuggestion: jsonb('pending_suggestion').$type<{
    cronExpression?: string;
    enabled?: boolean;
    reason: string;
    suggestedAt: string;
    suggestedByTaskId?: string;
    suggestedByWorkerId?: string;
  }>(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('task_schedules_workspace_idx').on(t.workspaceId),
  enabledNextRunIdx: index('task_schedules_enabled_next_run_idx').on(t.enabled, t.nextRunAt),
}));

// GitHub App Integration
export const githubInstallations = pgTable('github_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  installationId: bigint('installation_id', { mode: 'number' }).notNull().unique(),
  accountType: text('account_type').notNull().$type<'Organization' | 'User'>(),
  accountLogin: text('account_login').notNull(),
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  accountAvatarUrl: text('account_avatar_url'),
  accessToken: text('access_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  permissions: jsonb('permissions').default({}).$type<Record<string, string>>(),
  repositorySelection: text('repository_selection').$type<'all' | 'selected'>(),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  installationIdIdx: uniqueIndex('github_installations_installation_id_idx').on(t.installationId),
  accountLoginIdx: index('github_installations_account_login_idx').on(t.accountLogin),
}));

export const githubRepos = pgTable('github_repos', {
  id: uuid('id').primaryKey().defaultRandom(),
  installationId: uuid('installation_id').references(() => githubInstallations.id, { onDelete: 'cascade' }).notNull(),
  repoId: bigint('repo_id', { mode: 'number' }).notNull(),
  fullName: text('full_name').notNull(),
  name: text('name').notNull(),
  owner: text('owner').notNull(),
  private: boolean('private').default(false).notNull(),
  defaultBranch: text('default_branch').default('main'),
  htmlUrl: text('html_url'),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  installationIdx: index('github_repos_installation_idx').on(t.installationId),
  repoIdIdx: uniqueIndex('github_repos_repo_id_idx').on(t.repoId),
  fullNameIdx: index('github_repos_full_name_idx').on(t.fullName),
}));

// Project health watcher — periodic checks on external repos/deploys.
// One row per (workspace, repo). Auto-creates a buildd task + Pushover alert
// when CI fails on a release PR or prod release is unhealthy, unless suppressed
// by an in-flight task or recent commit activity. GH and Vercel creds are
// global (env-based) for now; per-row override columns can be added later.
export const watchedProjects = pgTable('watched_projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  repo: text('repo').notNull(), // "owner/name"
  vercelProjectId: text('vercel_project_id'), // null disables prod-release check
  vercelTokenSecretId: uuid('vercel_token_secret_id'), // null = fall back to VERCEL_API_TOKEN env
  releasePrFilter: jsonb('release_pr_filter').default({}).$type<{
    base?: string;        // PR target branch; default "main"
    label?: string;       // optional label filter
    titlePrefix?: string; // optional title prefix filter
  }>().notNull(),
  inFlightWindowMin: integer('in_flight_window_min').default(60).notNull(),
  prodGraceMin: integer('prod_grace_min').default(60).notNull(),
  roleSlug: text('role_slug').default('ops').notNull(),
  pushoverApp: text('pushover_app').default('alerts').notNull().$type<'tasks' | 'alerts'>(),
  notes: text('notes'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('watched_projects_workspace_idx').on(t.workspaceId),
  enabledIdx: index('watched_projects_enabled_idx').on(t.enabled),
  workspaceRepoIdx: uniqueIndex('watched_projects_workspace_repo_idx').on(t.workspaceId, t.repo),
}));

// Dedupe ledger for watcher firings. Unique on (projectId, kind, dedupeKey)
// so the same PR head SHA or deploy ID doesn't spawn duplicate tasks.
export const watcherEvents = pgTable('watcher_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => watchedProjects.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull().$type<'failing_release_pr' | 'prod_unhealthy'>(),
  dedupeKey: text('dedupe_key').notNull(),
  taskId: uuid('task_id'), // task auto-created in response (may be null if creation failed)
  meta: jsonb('meta').default({}).$type<Record<string, unknown>>(),
  firedAt: timestamp('fired_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  projectKindKeyIdx: uniqueIndex('watcher_events_project_kind_key_idx').on(t.projectId, t.kind, t.dedupeKey),
  projectIdx: index('watcher_events_project_idx').on(t.projectId),
}));

// Workspace-scoped skills (roles) — per-project bindings, discovered locally or manually registered
export const workspaceSkills = pgTable('workspace_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  content: text('content').notNull(), // Full SKILL.md content
  contentHash: text('content_hash').notNull(), // SHA-256 for verification
  source: text('source'), // 'local_scan', 'manual', 'github:owner/repo', etc.
  enabled: boolean('enabled').default(true).notNull(),
  origin: text('origin').default('manual').notNull().$type<'scan' | 'manual'>(),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(), // referenceFiles, version, author
  // Role config
  model: text('model').$type<'sonnet' | 'opus' | 'haiku' | 'inherit'>().notNull().default('inherit'),
  // Default agent backend for tasks routed to this role (a hint — an explicit task.backend wins).
  // null = no preference → falls back to 'claude'. Model selection stays independent: when this is
  // 'codex', the Claude-only `model` field above is ignored. See docs/credentials-architecture.md.
  defaultBackend: agentBackendEnum('default_backend'),
  allowedTools: jsonb('allowed_tools').notNull().default([]).$type<string[]>(), // empty = all tools
  canDelegateTo: jsonb('can_delegate_to').notNull().default([]).$type<string[]>(), // slugs of other skills
  background: boolean('background').notNull().default(false),
  maxTurns: integer('max_turns'), // null = unlimited
  color: text('color').notNull().default('#8A8478'), // avatar color hex
  mcpServers: jsonb('mcp_servers').notNull().default({}).$type<Record<string, unknown> | string[]>(), // MCP server configs or legacy name array
  requiredEnvVars: jsonb('required_env_vars').notNull().default({}).$type<Record<string, string>>(), // env var name → secret label mapping
  // Role-specific fields
  isRole: boolean('is_role').notNull().default(false), // distinguishes roles (Team page) from skills
  configHash: text('config_hash'), // SHA-256 of packaged tarball for cache invalidation
  configStorageKey: text('config_storage_key'), // R2 object key for role config tarball
  repoUrl: text('repo_url'), // for builder roles (git clone target)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceSlugIdx: uniqueIndex('workspace_skills_workspace_slug_idx').on(t.workspaceId, t.slug),
  workspaceIdx: index('workspace_skills_workspace_idx').on(t.workspaceId),
  accountIdx: index('workspace_skills_account_idx').on(t.accountId),
}));

// Per-task routing outcome — captured on completion/failure so the calibration
// cron can quantify whether the router's model pick matched reality.
// See plans/buildd/smart-model-routing.md — feedback loop requires this table.
export const taskOutcomes = pgTable('task_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  // Taxonomy at the time the task ran — copied from tasks.kind / tasks.complexity.
  kind: text('kind'),
  complexity: text('complexity'),
  classifiedBy: text('classified_by'),
  // Router output: the model the claim route chose (alias or full ID).
  predictedModel: text('predicted_model'),
  // What the worker actually ran on (full ID resolved by worker-runner).
  actualModel: text('actual_model'),
  // True if the router downshifted away from the baseline for this task.
  downshifted: boolean('downshifted').default(false).notNull(),
  outcome: text('outcome').notNull().$type<'completed' | 'failed'>(),
  // Numeric-as-text to match accounts.totalCost convention (Postgres numeric).
  totalCostUsd: text('total_cost_usd'),
  totalTurns: integer('total_turns'),
  durationMs: integer('duration_ms'),
  // Retried at least once before terminal outcome (mission auto-retry path).
  wasRetried: boolean('was_retried').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index('task_outcomes_task_idx').on(t.taskId),
  createdIdx: index('task_outcomes_created_idx').on(t.createdAt),
  kindIdx: index('task_outcomes_kind_idx').on(t.kind),
}));

// Team invitations for multi-tenancy
export const teamInvitations = pgTable('team_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  email: text('email').notNull(),
  role: text('role').notNull().$type<'admin' | 'member'>(),
  token: text('token').notNull().unique(),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  status: text('status').notNull().$type<'pending' | 'accepted' | 'expired'>().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  tokenIdx: uniqueIndex('team_invitations_token_idx').on(t.token),
  teamIdx: index('team_invitations_team_idx').on(t.teamId),
  emailIdx: index('team_invitations_email_idx').on(t.email),
}));

// Encrypted secrets store (server-managed credentials for shared workers)
export const secrets = pgTable('secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull().$type<'anthropic_api_key' | 'oauth_token' | 'codex_credential' | 'webhook_token' | 'custom' | 'mcp_credential' | 'vercel_token' | 'pushover' | 'notify_webhook'>(),
  label: text('label'),
  encryptedValue: text('encrypted_value').notNull(),
  // Token lifecycle (set only for expiring/refreshing credentials: codex_credential, oauth_token).
  // tokenExpiresAt enables efficient "expiring soon" cron queries; lastRefreshedAt doubles as
  // the optimistic-lock column for the refresh-rotation pattern. See docs/credentials-architecture.md.
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
  // Verification lifecycle (codex_credential only): the last time the credential was
  // smoke-tested against the real provider API, and the error string if it failed.
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  lastVerificationError: text('last_verification_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('secrets_team_idx').on(t.teamId),
  accountPurposeLabelIdx: uniqueIndex('secrets_account_purpose_label_idx').on(t.accountId, t.purpose, t.label),
}));


// Device code flow for CLI authentication in headless environments
export const deviceCodes = pgTable('device_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userCode: text('user_code').notNull().unique(), // Human-readable code like "ABCD-1234"
  deviceToken: text('device_token').notNull().unique(), // Opaque token for CLI polling
  status: text('status').default('pending').notNull().$type<'pending' | 'approved' | 'expired'>(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  apiKey: text('api_key'), // Plaintext key stored temporarily until CLI retrieves it
  clientName: text('client_name').default('CLI').notNull(),
  level: text('level').default('admin').notNull().$type<'trigger' | 'worker' | 'admin'>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userCodeIdx: uniqueIndex('device_codes_user_code_idx').on(t.userCode),
  deviceTokenIdx: uniqueIndex('device_codes_device_token_idx').on(t.deviceToken),
  statusIdx: index('device_codes_status_idx').on(t.status),
  expiresAtIdx: index('device_codes_expires_at_idx').on(t.expiresAt),
}));

// Knowledge chunks — unified semantic + lexical retrieval store.
// namespace = "{workspaceId}:{corpus}" (e.g. "ws-abc:memory").
// HNSW index on embedding and GIN index on tsvector are added in the migration SQL.
export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Source id (e.g. memoryId) — stable, used for idempotent upsert
  sourceId: text('source_id').notNull(),
  // "{workspaceId}:{corpus}"
  namespace: text('namespace').notNull(),
  // Column is plain `text`, so widening this union needs NO DB migration.
  corpus: text('corpus').notNull().$type<'memory' | 'code' | 'docs' | 'spec' | 'task' | 'artifact' | 'pr' | 'plan' | 'session'>(),
  sourceType: text('source_type').notNull(),
  sourcePath: text('source_path'),
  sourceUrl: text('source_url'),
  content: text('content').notNull(),
  // Separate field for BM25/tsvector search (may be title + content for memories)
  lexicalText: text('lexical_text'),
  // pgvector embedding (voyage-code-3: 1024 dims; stored as string "[0.1,...]")
  embedding: vectorType('embedding', { dimensions: 1024 }),
  // Model name + dim stored so re-embeds are detectable
  embeddingModel: text('embedding_model'),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>().notNull(),
  // SHA-256 of content for idempotency — skip re-embed when unchanged
  contentHash: text('content_hash'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  namespaceIdx: index('knowledge_chunks_namespace_idx').on(t.namespace),
  // Unique per (namespace, sourceId) — enforces one chunk per source entity per namespace
  sourceIdx: uniqueIndex('knowledge_chunks_source_idx').on(t.namespace, t.sourceId),
  contentHashIdx: index('knowledge_chunks_content_hash_idx').on(t.namespace, t.contentHash),
}));

// Relations
export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
  accounts: many(accounts),
  workspaces: many(workspaces),
  missions: many(missions),
  invitations: many(teamInvitations),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));

export const teamInvitationsRelations = relations(teamInvitations, ({ one }) => ({
  team: one(teams, { fields: [teamInvitations.teamId], references: [teams.id] }),
  inviter: one(users, { fields: [teamInvitations.invitedBy], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  teamMembers: many(teamMembers),
  deviceCodes: many(deviceCodes),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  team: one(teams, { fields: [accounts.teamId], references: [teams.id] }),
  accountWorkspaces: many(accountWorkspaces),
  tasks: many(tasks, { relationName: 'claimedTasks' }),
  workers: many(workers),
  createdTasks: many(tasks, { relationName: 'accountCreatedTasks' }),
  heartbeats: many(workerHeartbeats),
}));

export const accountWorkspacesRelations = relations(accountWorkspaces, ({ one }) => ({
  account: one(accounts, { fields: [accountWorkspaces.accountId], references: [accounts.id] }),
  workspace: one(workspaces, { fields: [accountWorkspaces.workspaceId], references: [workspaces.id] }),
}));

export const missionsRelations = relations(missions, ({ one, many }) => ({
  team: one(teams, { fields: [missions.teamId], references: [teams.id] }),
  workspace: one(workspaces, { fields: [missions.workspaceId], references: [workspaces.id] }),
  createdByUser: one(users, { fields: [missions.createdByUserId], references: [users.id] }),
  parentMission: one(missions, { fields: [missions.parentMissionId], references: [missions.id], relationName: 'subMissions' }),
  subMissions: many(missions, { relationName: 'subMissions' }),
  tasks: many(tasks),
  schedule: one(taskSchedules, { fields: [missions.scheduleId], references: [taskSchedules.id] }),
  artifacts: many(artifacts),
  notes: many(missionNotes),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  team: one(teams, { fields: [workspaces.teamId], references: [teams.id] }),
  tasks: many(tasks),
  workers: many(workers),
  accountWorkspaces: many(accountWorkspaces),

  artifacts: many(artifacts),
  taskSchedules: many(taskSchedules),
  workspaceSkills: many(workspaceSkills),
  missions: many(missions),
  githubRepo: one(githubRepos, { fields: [workspaces.githubRepoId], references: [githubRepos.id] }),
  githubInstallation: one(githubInstallations, { fields: [workspaces.githubInstallationId], references: [githubInstallations.id] }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [tasks.workspaceId], references: [workspaces.id] }),
  account: one(accounts, { fields: [tasks.claimedBy], references: [accounts.id], relationName: 'claimedTasks' }),
  mission: one(missions, { fields: [tasks.missionId], references: [missions.id] }),
  schedule: one(taskSchedules, { fields: [tasks.scheduleId], references: [taskSchedules.id] }),
  workers: many(workers, { relationName: 'taskWorkers' }),

  // Creator tracking relations
  creatorAccount: one(accounts, { fields: [tasks.createdByAccountId], references: [accounts.id], relationName: 'accountCreatedTasks' }),
  creatorWorker: one(workers, { fields: [tasks.createdByWorkerId], references: [workers.id], relationName: 'workerCreatedTasks' }),
  parentTask: one(tasks, { fields: [tasks.parentTaskId], references: [tasks.id], relationName: 'subTasks' }),
  subTasks: many(tasks, { relationName: 'subTasks' }),
}));

export const workersRelations = relations(workers, ({ one, many }) => ({
  task: one(tasks, { fields: [workers.taskId], references: [tasks.id], relationName: 'taskWorkers' }),
  workspace: one(workspaces, { fields: [workers.workspaceId], references: [workspaces.id] }),
  account: one(accounts, { fields: [workers.accountId], references: [accounts.id] }),
  artifacts: many(artifacts),

  createdTasks: many(tasks, { relationName: 'workerCreatedTasks' }),
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  worker: one(workers, { fields: [artifacts.workerId], references: [workers.id] }),
  workspace: one(workspaces, { fields: [artifacts.workspaceId], references: [workspaces.id] }),
  mission: one(missions, { fields: [artifacts.missionId], references: [missions.id] }),
}));

export const missionNotesRelations = relations(missionNotes, ({ one }) => ({
  mission: one(missions, { fields: [missionNotes.missionId], references: [missions.id] }),
}));


export const workerHeartbeatsRelations = relations(workerHeartbeats, ({ one }) => ({
  account: one(accounts, { fields: [workerHeartbeats.accountId], references: [accounts.id] }),
}));

export const taskSchedulesRelations = relations(taskSchedules, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [taskSchedules.workspaceId], references: [workspaces.id] }),
  createdByUser: one(users, { fields: [taskSchedules.createdByUserId], references: [users.id] }),
  tasks: many(tasks),
}));

export const githubInstallationsRelations = relations(githubInstallations, ({ many }) => ({
  repos: many(githubRepos),
  workspaces: many(workspaces),
}));

export const githubReposRelations = relations(githubRepos, ({ one, many }) => ({
  installation: one(githubInstallations, { fields: [githubRepos.installationId], references: [githubInstallations.id] }),
  workspaces: many(workspaces),
}));

export const workspaceSkillsRelations = relations(workspaceSkills, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceSkills.workspaceId], references: [workspaces.id] }),
  account: one(accounts, { fields: [workspaceSkills.accountId], references: [accounts.id] }),
}));

export const watchedProjectsRelations = relations(watchedProjects, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [watchedProjects.workspaceId], references: [workspaces.id] }),
  events: many(watcherEvents),
}));

export const watcherEventsRelations = relations(watcherEvents, ({ one }) => ({
  project: one(watchedProjects, { fields: [watcherEvents.projectId], references: [watchedProjects.id] }),
}));

export const deviceCodesRelations = relations(deviceCodes, ({ one }) => ({
  user: one(users, { fields: [deviceCodes.userId], references: [users.id] }),
}));

export const secretsRelations = relations(secrets, ({ one }) => ({
  team: one(teams, { fields: [secrets.teamId], references: [teams.id] }),
  account: one(accounts, { fields: [secrets.accountId], references: [accounts.id] }),
  workspace: one(workspaces, { fields: [secrets.workspaceId], references: [workspaces.id] }),
}));

// Per-team notification preferences (config, not a credential — the channel
// itself lives in `secrets` as purpose 'pushover' / 'notify_webhook').
// One row per team; each boolean toggles an event type. Defaults preserve the
// previous always-on behaviour while making each event individually muteable.
export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull().unique(),
  taskClaimed: boolean('task_claimed').default(true).notNull(),
  taskCompleted: boolean('task_completed').default(true).notNull(),
  taskFailed: boolean('task_failed').default(true).notNull(),
  credentialExpired: boolean('credential_expired').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: uniqueIndex('notification_preferences_team_idx').on(t.teamId),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  team: one(teams, { fields: [notificationPreferences.teamId], references: [teams.id] }),
}));

// User feedback on AI-generated content (thumbs up/down + dismiss)
export const userFeedback = pgTable('user_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  entityType: text('entity_type').notNull().$type<'note' | 'artifact' | 'summary' | 'orchestration' | 'heartbeat'>(),
  entityId: text('entity_id').notNull(),
  signal: text('signal').notNull().$type<'up' | 'down' | 'dismiss'>(),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userEntityIdx: uniqueIndex('user_feedback_user_entity_idx').on(t.userId, t.entityType, t.entityId),
  entityIdx: index('user_feedback_entity_idx').on(t.entityType, t.entityId),
  teamIdx: index('user_feedback_team_idx').on(t.teamId),
}));

export const userFeedbackRelations = relations(userFeedback, ({ one }) => ({
  user: one(users, { fields: [userFeedback.userId], references: [users.id] }),
  team: one(teams, { fields: [userFeedback.teamId], references: [teams.id] }),
}));

// Advisory file reservations — prevents concurrent workers from editing the same files
export const fileReservations = pgTable('file_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  filePath: text('file_path').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  // Only one active reservation per file per workspace (enforced at app level with expiry check)
  workspaceFileIdx: uniqueIndex('file_reservations_workspace_file_idx').on(t.workspaceId, t.filePath),
  workerIdx: index('file_reservations_worker_idx').on(t.workerId),
  expiresIdx: index('file_reservations_expires_idx').on(t.expiresAt),
}));

export const fileReservationsRelations = relations(fileReservations, ({ one }) => ({
  workspace: one(workspaces, { fields: [fileReservations.workspaceId], references: [workspaces.id] }),
  worker: one(workers, { fields: [fileReservations.workerId], references: [workers.id] }),
}));

// System cache — generic key-value store for cached data (model lists, etc.)
export const systemCache = pgTable('system_cache', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

// Tenant budget exhaustion tracking (Dispatch multi-tenant mode)
export const tenantBudgets = pgTable('tenant_budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  budgetExhaustedAt: timestamp('budget_exhausted_at', { withTimezone: true }).notNull(),
  budgetResetsAt: timestamp('budget_resets_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  tenantTeamIdx: uniqueIndex('tenant_budgets_tenant_team_idx').on(t.tenantId, t.teamId),
}));

export const tenantBudgetsRelations = relations(tenantBudgets, ({ one }) => ({
  team: one(teams, { fields: [tenantBudgets.teamId], references: [teams.id] }),
}));

// Codex auth now lives in the unified `secrets` table (purpose='codex_credential').
// See docs/credentials-architecture.md. The legacy per-workspace codex_credentials
// table was dropped in migration 0047 (no rows existed).

// ── OAuth (MCP connector for claude.ai and other MCP clients) ────────────────
// Implements OAuth 2.1 with PKCE. Tokens are workspace-scoped: each issued
// JWT carries the workspaceId the user picked during /authorize, and the
// /api/mcp-oauth/[workspace] route rejects tokens whose claim doesn't match
// the URL path. Refresh tokens rotate on use.

export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name'),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  grantTypes: jsonb('grant_types').$type<string[]>().notNull().default(['authorization_code', 'refresh_token']),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const oauthCodes = pgTable('oauth_codes', {
  code: text('code').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  scope: text('scope'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  expiresIdx: index('oauth_codes_expires_at_idx').on(t.expiresAt),
}));

export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  token: text('token').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  scope: text('scope'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  expiresIdx: index('oauth_refresh_tokens_expires_at_idx').on(t.expiresAt),
  userWorkspaceIdx: index('oauth_refresh_tokens_user_workspace_idx').on(t.userId, t.workspaceId),
}));
