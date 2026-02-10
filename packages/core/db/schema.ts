import {
  pgTable, uuid, text, timestamp, jsonb, integer, decimal, boolean, index, uniqueIndex, primaryKey, bigint
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Teams table for multi-tenancy ownership
export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().$type<'free' | 'pro' | 'team'>().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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
  level: text('level').default('worker').notNull().$type<'worker' | 'admin'>(),
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
  oauthToken: text('oauth_token'),
  seatId: text('seat_id'),
  maxConcurrentSessions: integer('max_concurrent_sessions'),
  activeSessions: integer('active_sessions').default(0).notNull(),

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

// Task schedule template - defines what task to create on each run
export interface TaskScheduleTemplate {
  title: string;
  description?: string;
  mode?: 'execution' | 'planning';
  priority?: number;
  runnerPreference?: 'any' | 'user' | 'service' | 'action';
  requiredCapabilities?: string[];
  context?: Record<string, unknown>;
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
}

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  repo: text('repo'),
  localPath: text('local_path'),
  memory: jsonb('memory').default({}).$type<Record<string, unknown>>(),
  // GitHub integration
  githubRepoId: uuid('github_repo_id'),  // Will add FK after githubRepos is defined
  githubInstallationId: uuid('github_installation_id'),
  // Access control: 'open' = any token can claim, 'restricted' = only linked accounts
  accessMode: text('access_mode').default('open').notNull().$type<'open' | 'restricted'>(),

  // Git workflow configuration
  gitConfig: jsonb('git_config').$type<WorkspaceGitConfig>(),
  configStatus: text('config_status').default('unconfigured').notNull().$type<'unconfigured' | 'admin_confirmed'>(),

  // Webhook configuration for external agent dispatch (OpenClaw, etc.)
  webhookConfig: jsonb('webhook_config').$type<WorkspaceWebhookConfig>(),

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

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  type: text('type').notNull().$type<'manual' | 'github' | 'jira' | 'linear'>(),
  name: text('name').notNull(),
  config: jsonb('config').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('sources_workspace_idx').on(t.workspaceId),
}));

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
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
  creationSource: text('creation_source').default('api').$type<'dashboard' | 'api' | 'mcp' | 'github' | 'local_ui' | 'schedule'>(),
  parentTaskId: uuid('parent_task_id'),  // FK constraint for self-reference defined in migration
  // Deliverable snapshot - populated on worker completion
  result: jsonb('result').$type<TaskResult | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('tasks_workspace_idx').on(t.workspaceId),
  statusIdx: index('tasks_status_idx').on(t.status),
  claimedByIdx: index('tasks_claimed_by_idx').on(t.claimedBy),
  runnerPrefIdx: index('tasks_runner_pref_idx').on(t.runnerPreference),
  modeIdx: index('tasks_mode_idx').on(t.mode),
  sourceExternalIdx: uniqueIndex('tasks_source_external_idx').on(t.sourceId, t.externalId),
  createdByAccountIdx: index('tasks_created_by_account_idx').on(t.createdByAccountId),
  parentTaskIdx: index('tasks_parent_task_idx').on(t.parentTaskId),
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
  // Local-UI direct access URL (e.g., https://local-ui--workspace.coder.dev or http://100.x.x.x:8766)
  localUiUrl: text('local_ui_url'),
  // Current action/status line from local-ui
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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index('workers_task_idx').on(t.taskId),
  workspaceIdx: index('workers_workspace_idx').on(t.workspaceId),
  accountIdx: index('workers_account_idx').on(t.accountId),
  statusIdx: index('workers_status_idx').on(t.status),
  accountStatusIdx: index('workers_account_status_idx').on(t.accountId, t.status),
}));

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  type: text('type').notNull(),
  title: text('title'),
  content: text('content'),
  storageKey: text('storage_key'),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workerIdx: index('artifacts_worker_idx').on(t.workerId),
}));

// Workspace observations (persistent memory across tasks)
export const observations = pgTable('observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  type: text('type').notNull().$type<'discovery' | 'decision' | 'gotcha' | 'pattern' | 'architecture' | 'summary'>(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  files: jsonb('files').default([]).$type<string[]>(),
  concepts: jsonb('concepts').default([]).$type<string[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('observations_workspace_idx').on(t.workspaceId),
  typeIdx: index('observations_type_idx').on(t.type),
  workerIdx: index('observations_worker_idx').on(t.workerId),
  taskIdx: index('observations_task_idx').on(t.taskId),
}));

// Worker heartbeats - tracks local-ui instance availability independent of worker records
export const workerHeartbeats = pgTable('worker_heartbeats', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }).notNull(),
  localUiUrl: text('local_ui_url').notNull(),
  viewerToken: text('viewer_token'),
  workspaceIds: jsonb('workspace_ids').default([]).$type<string[]>().notNull(),
  maxConcurrentWorkers: integer('max_concurrent_workers').default(3).notNull(),
  activeWorkerCount: integer('active_worker_count').default(0).notNull(),
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
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  cronExpression: text('cron_expression').notNull(),
  timezone: text('timezone').default('UTC').notNull(),
  taskTemplate: jsonb('task_template').notNull().$type<TaskScheduleTemplate>(),
  enabled: boolean('enabled').default(true).notNull(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastTaskId: uuid('last_task_id'),
  totalRuns: integer('total_runs').default(0).notNull(),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  lastError: text('last_error'),
  maxConcurrentFromSchedule: integer('max_concurrent_from_schedule').default(1).notNull(),
  pauseAfterFailures: integer('pause_after_failures').default(5).notNull(),
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

// Skill registry — stores hash + metadata, NOT content (content lives on worker filesystem)
export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  contentHash: text('content_hash').notNull(), // SHA-256 hex of SKILL.md
  source: text('source'), // e.g. 'npm:uxtools/ui-audit' or 'github:owner/repo/path'
  sourceVersion: text('source_version'), // npm version or git ref
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamSlugIdx: uniqueIndex('skills_team_slug_idx').on(t.teamId, t.slug),
  teamIdx: index('skills_team_idx').on(t.teamId),
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

// Device code flow for CLI authentication in headless environments
export const deviceCodes = pgTable('device_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userCode: text('user_code').notNull().unique(), // Human-readable code like "ABCD-1234"
  deviceToken: text('device_token').notNull().unique(), // Opaque token for CLI polling
  status: text('status').default('pending').notNull().$type<'pending' | 'approved' | 'expired'>(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  apiKey: text('api_key'), // Plaintext key stored temporarily until CLI retrieves it
  clientName: text('client_name').default('CLI').notNull(),
  level: text('level').default('admin').notNull().$type<'admin' | 'worker'>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userCodeIdx: uniqueIndex('device_codes_user_code_idx').on(t.userCode),
  deviceTokenIdx: uniqueIndex('device_codes_device_token_idx').on(t.deviceToken),
  statusIdx: index('device_codes_status_idx').on(t.status),
  expiresAtIdx: index('device_codes_expires_at_idx').on(t.expiresAt),
}));

// Relations
export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
  accounts: many(accounts),
  workspaces: many(workspaces),
  skills: many(skills),
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
  tasks: many(tasks),
  workers: many(workers),
  createdTasks: many(tasks, { relationName: 'createdTasks' }),
  heartbeats: many(workerHeartbeats),
}));

export const accountWorkspacesRelations = relations(accountWorkspaces, ({ one }) => ({
  account: one(accounts, { fields: [accountWorkspaces.accountId], references: [accounts.id] }),
  workspace: one(workspaces, { fields: [accountWorkspaces.workspaceId], references: [workspaces.id] }),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  team: one(teams, { fields: [workspaces.teamId], references: [teams.id] }),
  sources: many(sources),
  tasks: many(tasks),
  workers: many(workers),
  accountWorkspaces: many(accountWorkspaces),
  observations: many(observations),
  taskSchedules: many(taskSchedules),
  githubRepo: one(githubRepos, { fields: [workspaces.githubRepoId], references: [githubRepos.id] }),
  githubInstallation: one(githubInstallations, { fields: [workspaces.githubInstallationId], references: [githubInstallations.id] }),
}));

export const sourcesRelations = relations(sources, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [sources.workspaceId], references: [workspaces.id] }),
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [tasks.workspaceId], references: [workspaces.id] }),
  source: one(sources, { fields: [tasks.sourceId], references: [sources.id] }),
  account: one(accounts, { fields: [tasks.claimedBy], references: [accounts.id] }),
  workers: many(workers),
  observations: many(observations),
  // Creator tracking relations
  creatorAccount: one(accounts, { fields: [tasks.createdByAccountId], references: [accounts.id], relationName: 'createdTasks' }),
  creatorWorker: one(workers, { fields: [tasks.createdByWorkerId], references: [workers.id], relationName: 'createdTasks' }),
  parentTask: one(tasks, { fields: [tasks.parentTaskId], references: [tasks.id], relationName: 'subTasks' }),
  subTasks: many(tasks, { relationName: 'subTasks' }),
}));

export const workersRelations = relations(workers, ({ one, many }) => ({
  task: one(tasks, { fields: [workers.taskId], references: [tasks.id] }),
  workspace: one(workspaces, { fields: [workers.workspaceId], references: [workspaces.id] }),
  account: one(accounts, { fields: [workers.accountId], references: [accounts.id] }),
  artifacts: many(artifacts),
  observations: many(observations),
  createdTasks: many(tasks, { relationName: 'createdTasks' }),
}));

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  worker: one(workers, { fields: [artifacts.workerId], references: [workers.id] }),
}));

export const observationsRelations = relations(observations, ({ one }) => ({
  workspace: one(workspaces, { fields: [observations.workspaceId], references: [workspaces.id] }),
  worker: one(workers, { fields: [observations.workerId], references: [workers.id] }),
  task: one(tasks, { fields: [observations.taskId], references: [tasks.id] }),
}));

export const workerHeartbeatsRelations = relations(workerHeartbeats, ({ one }) => ({
  account: one(accounts, { fields: [workerHeartbeats.accountId], references: [accounts.id] }),
}));

export const taskSchedulesRelations = relations(taskSchedules, ({ one }) => ({
  workspace: one(workspaces, { fields: [taskSchedules.workspaceId], references: [workspaces.id] }),
  createdByUser: one(users, { fields: [taskSchedules.createdByUserId], references: [users.id] }),
}));

export const githubInstallationsRelations = relations(githubInstallations, ({ many }) => ({
  repos: many(githubRepos),
  workspaces: many(workspaces),
}));

export const githubReposRelations = relations(githubRepos, ({ one, many }) => ({
  installation: one(githubInstallations, { fields: [githubRepos.installationId], references: [githubInstallations.id] }),
  workspaces: many(workspaces),
}));

export const skillsRelations = relations(skills, ({ one }) => ({
  team: one(teams, { fields: [skills.teamId], references: [teams.id] }),
}));

export const deviceCodesRelations = relations(deviceCodes, ({ one }) => ({
  user: one(users, { fields: [deviceCodes.userId], references: [users.id] }),
}));
