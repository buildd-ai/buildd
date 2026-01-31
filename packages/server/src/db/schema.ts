import {
  pgTable, uuid, text, timestamp, jsonb, integer, decimal, boolean, index, uniqueIndex, primaryKey
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull().$type<'user' | 'service' | 'action'>(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull().unique(),
  githubId: text('github_id'),
  maxConcurrentWorkers: integer('max_concurrent_workers').default(3).notNull(),
  maxCostPerDay: decimal('max_cost_per_day', { precision: 10, scale: 2 }).default('50.00').notNull(),
  totalCost: decimal('total_cost', { precision: 10, scale: 2 }).default('0').notNull(),
  totalTasks: integer('total_tasks').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  apiKeyIdx: uniqueIndex('accounts_api_key_idx').on(t.apiKey),
  githubIdIdx: index('accounts_github_id_idx').on(t.githubId),
}));

export const accountWorkspaces = pgTable('account_workspaces', {
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  canClaim: boolean('can_claim').default(true).notNull(),
  canCreate: boolean('can_create').default(false).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.accountId, t.workspaceId] }),
}));

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  repo: text('repo'),
  localPath: text('local_path'),
  memory: jsonb('memory').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

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
  runnerPreference: text('runner_preference').default('any').notNull().$type<'any' | 'user' | 'service' | 'action'>(),
  requiredCapabilities: jsonb('required_capabilities').default([]).$type<string[]>(),
  claimedBy: uuid('claimed_by').references(() => accounts.id, { onDelete: 'set null' }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('tasks_workspace_idx').on(t.workspaceId),
  statusIdx: index('tasks_status_idx').on(t.status),
  claimedByIdx: index('tasks_claimed_by_idx').on(t.claimedBy),
  runnerPrefIdx: index('tasks_runner_pref_idx').on(t.runnerPreference),
  sourceExternalIdx: uniqueIndex('tasks_source_external_idx').on(t.sourceId, t.externalId),
}));

export const workers = pgTable('workers', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  branch: text('branch').notNull(),
  worktreePath: text('worktree_path'),
  status: text('status').default('idle').notNull(),
  waitingFor: jsonb('waiting_for').$type<{ type: string; prompt: string; options?: string[] } | null>(),
  progress: integer('progress').default(0).notNull(),
  sdkSessionId: text('sdk_session_id'),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }).default('0').notNull(),
  turns: integer('turns').default(0).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index('workers_task_idx').on(t.taskId),
  workspaceIdx: index('workers_workspace_idx').on(t.workspaceId),
  accountIdx: index('workers_account_idx').on(t.accountId),
  statusIdx: index('workers_status_idx').on(t.status),
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

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  artifactId: uuid('artifact_id').references(() => artifacts.id, { onDelete: 'cascade' }),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  selection: jsonb('selection').$type<{ start: number; end: number; text?: string } | null>(),
  resolved: boolean('resolved').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  artifactIdx: index('comments_artifact_idx').on(t.artifactId),
}));

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  role: text('role').notNull(),
  content: text('content'),
  toolName: text('tool_name'),
  toolInput: jsonb('tool_input').$type<Record<string, unknown> | null>(),
  toolOutput: text('tool_output'),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workerIdx: index('messages_worker_idx').on(t.workerId),
}));

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }).notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  storageKey: text('storage_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  messageIdx: index('attachments_message_idx').on(t.messageId),
}));

// Relations
export const accountsRelations = relations(accounts, ({ many }) => ({
  accountWorkspaces: many(accountWorkspaces),
  tasks: many(tasks),
  workers: many(workers),
}));

export const accountWorkspacesRelations = relations(accountWorkspaces, ({ one }) => ({
  account: one(accounts, { fields: [accountWorkspaces.accountId], references: [accounts.id] }),
  workspace: one(workspaces, { fields: [accountWorkspaces.workspaceId], references: [workspaces.id] }),
}));

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  sources: many(sources),
  tasks: many(tasks),
  workers: many(workers),
  accountWorkspaces: many(accountWorkspaces),
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
}));

export const workersRelations = relations(workers, ({ one, many }) => ({
  task: one(tasks, { fields: [workers.taskId], references: [tasks.id] }),
  workspace: one(workspaces, { fields: [workers.workspaceId], references: [workspaces.id] }),
  account: one(accounts, { fields: [workers.accountId], references: [accounts.id] }),
  artifacts: many(artifacts),
  comments: many(comments),
  messages: many(messages),
}));

export const artifactsRelations = relations(artifacts, ({ one, many }) => ({
  worker: one(workers, { fields: [artifacts.workerId], references: [workers.id] }),
  comments: many(comments),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  artifact: one(artifacts, { fields: [comments.artifactId], references: [artifacts.id] }),
  worker: one(workers, { fields: [comments.workerId], references: [workers.id] }),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  worker: one(workers, { fields: [messages.workerId], references: [workers.id] }),
  attachments: many(attachments),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  message: one(messages, { fields: [attachments.messageId], references: [messages.id] }),
}));
