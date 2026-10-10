import {
  pgTable, uuid, text, timestamp, jsonb, integer, decimal, real, boolean, index, uniqueIndex, primaryKey, bigint, pgEnum, customType, check, varchar, date, unique
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

// Custom tsvector column type — used for the stored generated lexical search column below.
const tsvectorType = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const agentBackendEnum = pgEnum('agent_backend', ['claude', 'codex']);
export const connectorAuthModeEnum = pgEnum('connector_auth_mode', ['none', 'header', 'oauth', 'assertion']);
export const connectorTransportEnum = pgEnum('connector_transport', ['http', 'stdio']);
import { relations, sql } from 'drizzle-orm';
import { DEFAULT_ENABLED_DECISION_SHADOWS } from '../inference-policy';
import type { ScheduleDelegation } from '../token-delegation';
import type { WorkerEnvironment, SkillModel, MergePolicy, LoopConfig, LoopState, TaskSubjectAnchor, PathDeclaration, TaskStatusValue, WorkerStatusValue, MissionStatusValue, WorkspaceOnboardingConfig, WorkspaceQualityScoutConfig, DerivedFileRule, FailureIncidentSeverity, FailureIncidentStatus, FailureIncidentRule, FailureIncidentAffectedRefs, FailureIncidentEvidenceRef } from '@buildd/shared';

// Teams table for multi-tenancy ownership
export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),

  // The team's canonical working zone (IANA, e.g. 'America/New_York'). NULL = UTC, so
  // teams that never set one behave exactly as before. Used for anything rendered to a
  // shared or external surface — PR activity comments, new schedule defaults, mission
  // active hours — where there is no single known viewer. Seeded from the detected zone
  // of the first member to sign in. See packages/core/timezone.ts.
  timezone: text('timezone'),

  // Per-team permission grants: permission name -> team roles that hold it. An
  // absent key = the registry default (apps/web/src/lib/permission-registry.ts).
  // Read only through sanitizeOverrides; owners always hold everything, and
  // locked permissions ignore this. Written by PUT /api/teams/[id]/permissions.
  permissionOverrides: jsonb('permission_overrides').$type<Record<string, string[]>>().default({}).notNull(),
  // Hosted plan assignment for Buildd-managed runners: { plan, ...overrides }.
  // NULL = the deployment default (BUILDD_DEFAULT_MANAGED_PLAN), unlimited when
  // that is unset, so a self-hosted install has no commercial limit. Written by
  // hosted billing; read only through resolveManagedRunnerEntitlement
  // (apps/web/src/lib/entitlements/plans.ts).
  managedRunnerPlan: jsonb('managed_runner_plan').$type<{
    plan: string;
    concurrency?: number | null;
    monthlyRunnerHours?: number | null;
    overage?: 'block' | 'allow';
  } | null>(),
  // Monthly hosted (cloud) runner allowance, in counted hours: wall time on the
  // hosted runner weighted by container size (standard 1x, large 2x), summed
  // from `runner_usage`. NULL = no cap. Written by hosted billing; read only
  // through apps/web/src/lib/hosted-runner-usage-store.ts.
  hostedRunnerHours: integer('hosted_runner_hours'),
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

  // DEPRECATED — nothing reads or writes this. The 'worker' batched-evaluator
  // branch it selected was removed; prose criteria pick a grader per criterion
  // (criterion > gitConfig.criteriaGrader > auto). Drop in a follow-up release,
  // after the code that stopped selecting it is live: db:migrate runs before the
  // new build serves, so dropping it in the same release breaks the old build.
  criteriaEvaluationStrategy: text('criteria_evaluation_strategy').$type<'inline' | 'worker' | null>(),

  // DEPRECATED — nothing reads or writes this. It was the opt-in allowlist of
  // inference call sites; replaced by always-on chat (interactive), built-in
  // decision calls (always on when a key resolves) and inferenceFeatureModes.
  // Drop in a follow-up release (schema-change skill).
  enabledInferenceCapabilities: text('enabled_inference_capabilities').array(),
  // Per-feature overrides for server-side features (goal grading, visual QA
  // judgment, mission summaries): { [feature]: 'server' | 'runner' }. NULL or an
  // absent feature = the default, which follows the billing model (a team key
  // resolves → server-side, else the runner). See packages/core/inference-policy.ts.
  inferenceFeatureModes: jsonb('inference_feature_modes').$type<import('../inference-policy').FeatureModes | null>(),
  // The `opt_in` decision capabilities this team turned on (e.g.
  // 'task_role_shadow'). NULL = off. A new team starts with every one
  // (insert-time default, no DDL); an opt_in capability added later is not
  // switched on for existing teams. See packages/core/inference-policy.ts.
  enabledDecisionShadows: text('enabled_decision_shadows').array().$defaultFn(() => [...DEFAULT_ENABLED_DECISION_SHADOWS]),
  // Daily cap on agent-chat spend in USD, reset at midnight in the team's
  // timezone. NULL = DEFAULT_CHAT_DAILY_BUDGET_USD (apps/web/src/lib/chat/limits.ts),
  // never "no cap". Metered from conversation_messages.usage (generative turns
  // plus their routing decision calls); never touches accounts.maxCostPerDay,
  // which meters runner work.
  chatDailyBudgetUsd: decimal('chat_daily_budget_usd', { precision: 10, scale: 2 }),
  // Per-person daily share of that budget, in USD. NULL = DEFAULT_CHAT_USER_SHARE
  // of the team budget. Always clamped to the team budget.
  chatUserDailyBudgetUsd: decimal('chat_user_daily_budget_usd', { precision: 10, scale: 2 }),
  // Whose provider key server-side AI spends (packages/core/inference-keys.ts
  // enforces it): 'team' = the team key for everyone, personal keys ignored;
  // 'team_or_own' = the team key, and a person may use their own instead;
  // 'own' = each person's own key, no team fallback — team work with no person
  // (grading, visual QA) then finds no key and takes its runner path.
  inferenceKeyPolicy: text('inference_key_policy').$type<'team' | 'team_or_own' | 'own'>().notNull().default('team'),
  // Whose credential every provider spends — chat, inference AND agent runs:
  // 'team' = team keys only, personal ones ignored; 'personal_first' = the
  // requesting person's own key, else the team's; 'personal_only' = no team key
  // at all. NULL = not chosen yet: read inferenceKeyPolicy through
  // credentialPolicyOf (apps/web/src/lib/inference-key-policy.ts), which maps
  // team/team_or_own/own one-to-one. inferenceKeyPolicy is dropped later.
  credentialPolicy: text('credential_policy').$type<'team' | 'personal_first' | 'personal_only'>(),
  // Which model answers the team's decision calls (packages/core/decision-model.ts).
  // NULL = Jev on OpenRouter. Otherwise any chat model, via OpenRouter or the
  // team's LiteLLM gateway, with confidence from token logprobs.
  decisionModel: jsonb('decision_model').$type<import('../decision-model').DecisionModelConfig | null>(),
  // DEPRECATED — nothing reads or writes this. It was the admin kill switch for
  // chat; chat is now always on and runs whenever a key resolves. Drop in a
  // follow-up release, after the build that stopped reading it is live
  // (schema-change skill).
  chatDisabled: boolean('chat_disabled').notNull().default(false),
  // The chat tier a new conversation's composer caps at ('budget' | 'standard' |
  // 'premium'). NULL = auto: no cap. Only read when chatCapNewSessionTier is on
  // (apps/web/src/lib/chat/composer-prefs.ts resolveInitialTier).
  chatDefaultTier: text('chat_default_tier'),
  // Admin policy: a new conversation starts at min(person's last tier, the
  // default tier above) — reset down to it, never up. Off = the person's last tier.
  chatCapNewSessionTier: boolean('chat_cap_new_session_tier').notNull().default(false),
  // How this team's catalog-resolved tiers advance to newly certified models:
  // { mode: 'latest-compatible' | 'soak' | 'manual', soakHours?, adoptedThrough?,
  // setBy?, setAt? }. NULL = latest-compatible. A workspace's own value wins.
  // Read only through packages/core/model-upgrade-policy.ts (readUpgradePolicy).
  modelUpgradePolicy: jsonb('model_upgrade_policy').$type<import('../model-upgrade-policy').ModelUpgradePolicy | null>(),
  // Chat session retros (experiment, apps/web/src/lib/chat-retro/). Opt-in per
  // team: NULL or a missing key = off. `lessons` records content-free lesson
  // rows in chat_retros; `proposals` (requires lessons) lets the daily pass
  // file suggested improvements as tasks. Removal: see chat-retro/REMOVAL.md.
  chatRetro: jsonb('chat_retro').$type<{ lessons?: boolean; proposals?: boolean } | null>(),
  // Enforceable model-tier ceilings (most restrictive layer wins): the team's
  // cap, per-workspace caps, what an auto tier over the cap does, and an audit
  // tail. NULL = no ceiling, routing unchanged. Distinct from chatDefaultTier,
  // which only seeds a new chat. Read/written only through
  // packages/core/model-tier-ceiling-store.ts; contract in
  // docs/specs/model-tier-ceilings.md.
  modelTierCeilings: jsonb('model_tier_ceilings').$type<import('@buildd/shared').TeamTierCeilingPolicy | null>(),

  // Enforceable Coding provider / payment-source restrictions (team layer and
  // per-workspace layers). NULL = unrestricted, which is every existing team.
  // A denial is a refusal, never a redirect (unlike enabledBackends). Read
  // through packages/core/coding-policy-store.ts; rule in coding-policy.ts.
  codingPolicy: jsonb('coding_policy').$type<import('../coding-policy').TeamCodingPolicy | null>(),

  // Billing (knowledge-base: buildd/plans/billing-v1.md). Never read directly by a
  // gate — read packages/core/entitlements.ts entitlements(team), which also
  // honours the BILLING_ENFORCED switch (off = unlimited for everyone). An unknown
  // `plan` value reads as 'free'. Written by the Stripe webhook (later task).
  plan: text('plan').$type<import('@buildd/shared').TeamPlan>().notNull().default('free'),
  // Stripe subscription status as last reported ('active', 'trialing',
  // 'past_due', 'canceled', ...). NULL = never subscribed.
  billingStatus: text('billing_status'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  // Seats paid for on the Team plan (subscription quantity). NULL = none; the
  // Team plan still covers TEAM_PLAN_MIN_SEATS members.
  paidSeats: integer('paid_seats'),
}, (t) => ({
  slugIdx: uniqueIndex('teams_slug_idx').on(t.slug),
  stripeCustomerIdx: uniqueIndex('teams_stripe_customer_id_idx').on(t.stripeCustomerId),
}));

// Stripe webhook events already applied, keyed by Stripe's event id — the
// webhook's idempotency ledger (apps/web/src/app/api/webhooks/stripe/route.ts).
// A row is claimed before the event is applied and deleted again if applying
// fails, so a Stripe retry of a failed event runs, a replay of a done one doesn't.
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
});

// Team membership
export const teamMembers = pgTable('team_members', {
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  role: text('role').notNull().$type<'owner' | 'admin' | 'member'>(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  // Chat tool groups (apps/web/src/lib/chat/registry.ts TOOL_GROUPS) this person
  // set to "Allow": a write in one of them may run without its approval card
  // for THIS person only, and only when nothing a tool read is in the model's
  // context (apps/web/src/lib/chat/permissions.ts). Empty = ask for every write.
  chatAllowedToolGroups: text('chat_allowed_tool_groups').array().notNull().default(sql`'{}'::text[]`),
  // The composer choices this person last made in this team (Home card,
  // /app/chat, the canvas): { workspaceId?, tier? }. A present key with a null
  // value is a choice (all workspaces / auto); an absent key was never chosen.
  // Seeds every new conversation (apps/web/src/lib/chat/composer-prefs.ts).
  chatComposerPrefs: jsonb('chat_composer_prefs').$type<{ workspaceId?: string | null; tier?: string | null }>(),
  // This person's model-tier ceilings in this team: `admin` (set by a team
  // admin, the member cannot lift it) and `self` (their own, only lowers).
  // NULL = none. See teams.modelTierCeilings.
  modelTierCeilings: jsonb('model_tier_ceilings').$type<import('@buildd/shared').MemberTierCeilings | null>(),
  // This person's own Coding provider restriction. It can only narrow what the
  // team and workspace allow, and applies only to tasks they requested.
  codingPolicy: jsonb('coding_policy').$type<import('../coding-policy').CodingPolicyLayer | null>(),
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

  // Derived silently from the browser (Intl.DateTimeFormat().resolvedOptions().timeZone),
  // never asked for. The zone THIS person sees their own dashboard in; falls back to the
  // team zone, then UTC.
  timezone: text('timezone'),
  // Keycap-style shortcut hints (1/2/3, Esc, the chat shortcut). Off by default:
  // the shortcuts always work, the chips only show for people who ask for them
  // (Settings -> Profile).
  showKeyboardHints: boolean('show_keyboard_hints').default(false).notNull(),
  // Chat retro account dogfood (experiment, apps/web/src/lib/chat-retro/).
  // Set = every team this person owns, now and later, runs retros with
  // lessons + proposals on, and a per-team "off" is refused. NULL = off: the
  // teams keep the opt-in. Removal: see chat-retro/REMOVAL.md.
  chatRetroDogfoodAt: timestamp('chat_retro_dogfood_at', { withTimezone: true }),
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
  // NULL preserves legacy levels; an empty list grants no capabilities.
  scopes: jsonb('scopes').$type<string[]>(),
  workspaceIds: jsonb('workspace_ids').$type<string[]>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  githubId: text('github_id'),
  // The person who minted this key. NULL = minted before this was recorded, or
  // by no person (system/runner bootstrap). Bounds the key when its creator's
  // team role drops (key-level-policy.ts).
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),

  // Authentication type
  authType: text('auth_type').default('api').notNull().$type<'api' | 'oauth'>(),

  // For API-based auth (pay-per-token)
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

  // Daily cap, in USD, on the model spend a sibling app reports under this key
  // (ai_usage receipts, day in the team's timezone). POST /api/ai/plan answers
  // `downgrade` from 80% of it and `deny` at 100%. NULL = no buildd-side cap:
  // the app's own provider-key limit is the hard ceiling
  // (knowledge-base: buildd/design/shared-ai-kit.md §2). Never touches maxCostPerDay (runner work).
  aiDailyBudgetUsd: decimal('ai_daily_budget_usd', { precision: 10, scale: 2 }),

  // A long-lived host runner key, flagged explicitly by a team owner/admin.
  // Only such a key may use the credential lease / refresh routes or list the
  // team's secrets (lib/credential-custody.ts); any other key gets team
  // credentials only as handed to it at claim time.
  hostRunner: boolean('host_runner').default(false).notNull(),

  // A Buildd-managed runner key: hosted compute Buildd pays for. Its claims
  // count against the team's managed-runner entitlement (teams.managedRunnerPlan,
  // packages/shared/src/entitlements.ts). Set by hosted provisioning, never by a
  // team: a self-hosted runner key is false and no commercial limit applies to it.
  managedRunner: boolean('managed_runner').default(false).notNull(),

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

// Which git workflow a new mission uses by default — see resolveBranchStrategy()
// in branch-strategy.ts, the single place a workspace resolves to one of these.
//   - 'mission-branch': task PRs base on the mission's shared integration
//     branch; one mission PR carries the batch into the workspace's default
//     branch, reviewed and revertable as one commit.
//   - 'direct': every task PR merges into the default branch on its own.
export type BranchStrategy = 'mission-branch' | 'direct';

/**
 * Cheap checks run before CI (docs/specs/workflow-state-kernel.md §6.10, S31).
 * Advisory for the workflow kernel: a runner or server without them is no less
 * safe, only noisier. Every field is off when absent.
 */
export interface WorkspacePreflightConfig {
  /** create_pr refuses a title/body that CI's No Production Data prose scan would reject (counts, UUIDs). */
  prProseScan?: boolean;
  /**
   * Shell commands the runner runs in the worktree before a push or create_pr
   * (e.g. `bun run no-prod-data:check`). A failure denies that call with the
   * output as the agent's next instruction; the attempt stays open.
   */
  commands?: string[];
  /**
   * CI check or workflow names (case-insensitive substrings) whose failure a
   * preflight should have caught. A kernel CI failure naming one is tagged
   * `preflight_miss` so the miss rate is measurable. Absent: the built-in
   * production-data check name.
   */
  ciChecks?: string[];
}

// Git workflow configuration type
export interface WorkspaceGitConfig {
  // Branching
  defaultBranch: string;              // 'main', 'master', 'dev'
  branchingStrategy: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
  branchPrefix?: string;              // 'feature/', 'buildd/', null for none
  useBuildBranch?: boolean;          // Use buildd/task-id naming

  // Default branch strategy for NEW missions (resolved via resolveBranchStrategy()
  // in branch-strategy.ts — never inline `gitConfig?.branchStrategy ?? '...'` at a
  // call site, that is how two defaults end up disagreeing six weeks apart).
  // Applies only at mission-create time, setting the new mission's own
  // `integrationBranchEnabled`; an existing mission's flag is the runtime truth
  // from then on (see `missionIntegrationBase()` in mission-integration.ts).
  //
  // Absent ⇒ 'mission-branch' (opt-OUT): an unconfigured workspace gets the
  // newer, batched-PR default, not the legacy per-task one.
  branchStrategy?: BranchStrategy;

  // Other same-team workspaces whose `docs` corpus this workspace's agents may
  // also search (recall / query_knowledge and the claim-time knowledge context).
  // A request, not a grant: resolveLinkedDocsWorkspaces (apps/web/src/lib/
  // linked-knowledge.ts) only honours an id the calling account could reach
  // anyway — same team, not sensitive, token restriction respected.
  linkedKnowledgeWorkspaces?: string[];

  // Opt-in: a person (dashboard or OAuth session, never an API key or runner)
  // must also hold read or higher on the linked GitHub repo before Buildd
  // shows them code, files tasks for them, or lets chat work over this
  // workspace. Absent ⇒ 'off': team membership is the whole check. Read only
  // through resolveMemberRepoAccessMode (apps/web/src/lib/member-repo-access-shared.ts).
  memberRepoAccess?: 'off' | 'require_read';

  // Commit conventions
  commitStyle: 'conventional' | 'freeform' | 'custom';
  commitPrefix?: string;              // '[JIRA-123]', null

  // PR/Merge behavior
  requiresPR: boolean;
  targetBranch?: string;              // Where PRs should target
  autoCreatePR: boolean;
  subjectPolicy?: import('../subject-anchor-observe').SubjectPolicy;

  // Agent instructions (prepended to prompt)
  agentInstructions?: string;         // Free-form, admin-defined

  // GitHub credentials for agents on self-hosted runners
  // (@buildd/core/agent-github-credentials). Absent ⇒ a task-scoped GitHub App
  // token once the rollout reaches this workspace. 'runner' is the explicit
  // opt-out for a workspace without the GitHub App: its agents keep the runner
  // operator's own GitHub credentials. JSON field, no migration.
  agentGitHubCredentials?: 'runner';
  useClaudeMd: boolean;               // Whether to load CLAUDE.md (default: true if exists)

  // Permission mode
  bypassPermissions?: boolean;        // Allow agent to bypass permission prompts (dangerous commands still blocked)

  // Claim-time memory as an index (one line per memory, bodies pulled with
  // `recall` id=) instead of pasted bodies. Absent / false = today's output.
  // See packages/core/memory-claim-index.ts and docs/design/memory-done-right.md.
  memoryIndexInjection?: boolean;
  memoryIndexTokenBudget?: number;   // estimated tokens (chars/4); default 800

  // New `learn` / `buildd_memory save` writes land as candidates (not pushed at
  // claim, recallable with includeCandidates) and are promoted by the
  // lifecycle pass; failed tasks and changes-requested reviews are extracted
  // into candidates. Absent / false = today's behaviour.
  // See packages/core/memory-candidates.ts.
  memoryCandidateWrites?: boolean;

  // Default agent backend for tasks in this workspace, when neither the task
  // (task.backend) nor its role (role.defaultBackend) specifies one. Resolution
  // precedence: task.backend → role.defaultBackend → workspace default → 'claude'.
  defaultBackend?: 'claude' | 'codex';

  // Workspace-wide ENV_NAME → secret label mapping, resolved at claim time
  // against the `secrets` table (purpose='role_env_secret') the same way a
  // role's own `requiredEnvVars` is. Applies to every role in the workspace as
  // a base; a role's own `requiredEnvVars` overrides the same key. See
  // docs/design/reliable-env-provisioning.md → "Private registry credentials".
  envMapping?: Record<string, string>;

  // Who grades prose (`description`) goal criteria in this workspace:
  // 'api' (inference call, per-token), 'runner' (read-only task on a runner's
  // own credential, e.g. an OAuth seat), or 'auto' (api when a key resolves,
  // else runner). A criterion's own `grader` wins; absent here means 'auto'.
  criteriaGrader?: 'auto' | 'api' | 'runner';

  // Claim-time batch planner (packages/core/claim-planner.ts) in the claim
  // route: 'off' = the legacy first-eligible walk, untouched; 'record' (the
  // default when absent) = plan beside the legacy picks and write both to the gate ledger;
  // 'apply' = claim in plan order. Read only through resolveClaimPlannerConfig()
  // (apps/web/src/app/api/workers/claim/claim-plan-input.ts).
  claimPlanner?: 'off' | 'record' | 'apply';
  // Planner thresholds. Absent = declared/observed scope only: predictions
  // are ignored and the no-scope mission mutex stays.
  claimPlannerThresholds?: { thetaOrder: number; thetaSoft: number; thetaIdle: number } | null;

  // Where the visual auditor's pages come from: 'sandbox' (absent = today's
  // in-worker boot), 'vercel-preview', or 'auto'. Read only through
  // resolveVisualQaConfig(). See docs/design/visual-qa-auditor.md → "Page source".
  visualQa?: import('../visual-qa-page-source').VisualQaConfig;

  // Cloud-runner container class. Absent = derived from recent run reports
  // (apps/web/src/lib/runner-size.ts); an explicit value always wins.
  runnerSize?: 'standard' | 'large';
  // Written by buildd, never by the settings form: the first derivation that
  // moved this workspace to `large`, kept so one light run does not move it back.
  runnerSizeDerived?: { size: 'large'; reason: 'memory_pressure' | 'low_disk' | 'container_restart' | 'large_checkout'; at: string };

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
    // Credential-read blocking for sandboxed commands (SDK v0.3.187)
    // Prevents sandboxed bash commands from reading sensitive credential files or env vars.
    credentials?: {
      files?: Array<{ path: string; mode: 'deny' }>;
      environment?: Array<{ name: string; mode: 'deny' | 'mask'; injectHosts?: string[] }>;
    };
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

  // Path-claim enforcement (knowledge-base: buildd/design/conflict-aware-orchestration.md §2). Off by
  // default ('advisory' or absent). 'enforce': a confirmed live holder denies
  // Edit/Write/MultiEdit before the write, and a checkpoint sweep that finds a
  // collision (Bash/untracked/Codex writes) stops push/completion and defers the task.
  pathClaimEnforcement?: 'advisory' | 'enforce' | null;

  // Policy checks before PR creation and push (docs/specs/workflow-state-kernel.md
  // §6.10, S31). All off by default; advisory for the workflow kernel.
  preflight?: WorkspacePreflightConfig | null;
  // Files a runner regenerates instead of merging (see DerivedFileRule). Absent
  // or empty: runners register no merge driver and conflicts go to the agent.
  derivedFiles?: DerivedFileRule[];
  // Register mergiraf (structural merge) as a driver in runner clones for the
  // languages it parses. Off by default; skipped quietly if the binary is absent.
  mergiraf?: boolean;
  // Explicit overlap hotspots: paths or `dir/**` patterns where a same-file
  // overlap with an in-flight task is a deterministic hold, never a claim-time
  // HOLD/START decision (apps/web/src/lib/hard-overlap-surfaces.ts). Absent:
  // only migrations, generated files and serialized surfaces are hard.
  overlapHotspots?: string[] | null;

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

  // Change-intent coordination (see docs/design/change-intent.md)
  // conflictSurfaces: paths/globs to watch for concurrent-PR collisions. When a PR
  // touches a declared surface, warning notes are posted on all open-PR tasks that
  // also touch it. Default action is warn+guide; never blocks.
  conflictSurfaces?: Array<{
    pattern: string;  // prefix or glob, e.g. "packages/core/drizzle/**" or "bun.lock"
    label: string;    // shown in warning notes, e.g. "Drizzle migrations"
    // Opt-in merge ordering (conflict-aware-orchestration.md §3). With
    // `surfaceOrdering` on, a PR touching a serialized surface merges only after
    // every earlier open PR on that surface has closed. Absent/false: warn only.
    serialize?: boolean;
  }>;
  // sequenceNamespaces: directories where file-name distinctness does NOT prevent
  // integer-index collisions (Drizzle migrations, ADR numbering). At task-creation
  // time, any task whose pathManifest touches one of these dirs gets the anchorFile
  // auto-appended — making the claim-route serialization fire on _journal.json instead
  // of the individual migration filename (where pathsOverlap() would otherwise miss it).
  sequenceNamespaces?: Array<{
    dir: string;        // e.g. "packages/core/drizzle"
    anchorFile: string; // e.g. "packages/core/drizzle/meta/_journal.json"
    label: string;
    // Paths outside `dir` whose edit generates into the namespace (e.g.
    // "packages/core/db/schema.ts"): a manifest touching one gets the anchor too,
    // and a PR diff touching one counts as touching the namespace.
    triggers?: string[];
    // Opt-in: the namespace (dir + anchor + triggers, generated files included)
    // is one serialized merge surface under `surfaceOrdering`. See conflictSurfaces.
    serialize?: boolean;
  }>;
  // Surface merge ordering (conflict-aware-orchestration.md §3). Off by default
  // (absent/'off': no reads, no gate). 'shadow' records what it would defer;
  // 'enforce' defers a PR behind earlier open PRs on a serialized surface and
  // fails closed when intent state cannot be verified.
  surfaceOrdering?: 'off' | 'shadow' | 'enforce' | null;
  // Semantic check before a clean base refresh (conflict-aware-orchestration.md
  // §4, apps/web/src/lib/semantic-refresh.ts). Off by default (no extra reads).
  // 'shadow' records same-symbol / unknown verdicts and refreshes as before;
  // 'enforce' sends a verified same-symbol edit to a semantic conflict review and
  // withholds clearance when symbol coverage is unknown (bounded rechecks, then a
  // diagnostic). No revision-pinned symbol index is reachable server-side yet,
  // so under 'enforce' a shared-file refresh is never auto-cleared.
  semanticRefresh?: 'off' | 'shadow' | 'enforce' | null;

  // When true, tasks with outputRequirement='pr_required' that do not already declare a
  // loopConfig automatically get loopConfig = { exitCondition: { type: 'pr_checks_green' }, maxLoops: 3 }
  // at task-creation time. The existing loop machinery handles re-queuing.
  enforceGreenCI?: boolean;

  /**
   * @deprecated Inert. No merge gate reads it: `resolvePolicy` decides from
   * `mergePolicy` (migration 0113 converted these flags to a mergePolicy and
   * stripped them). Kept in the type only so old stored rows still parse.
   */
  autoMergePR?: boolean;

  /**
   * @deprecated Inert, same as `autoMergePR`. The dashboard used to write it from
   * an "Auto-merge on green CI" checkbox that changed nothing; the config route
   * no longer writes it. Use `mergePolicy.tier` (auto-threshold = merge on green CI).
   */
  autoMergeOnGreenCI?: boolean;

  // Safety rails for autoMergePR — legacy, no longer consulted.
  /** @deprecated Hand-written paths are refused on write (400); paths are auto-detected via policyConfig. */
  autoMergeDenyPaths?: string[];
  autoMergeMaxLines?: number;         // total additions+deletions threshold (default 800)

  // Default runner preference for new tasks created in this workspace
  // Controls which type of runner (user/service/action) can claim tasks by default
  // Can be overridden per-task at creation time
  defaultRunnerPreference?: 'any' | 'user' | 'service' | 'action';

  // Merge policy — supersedes autoMerge* fields when set.
  // null / absent → fall back to legacy autoMerge* fields (backward compat).
  mergePolicy?: MergePolicy;

  // Semantic risk-class policy — the only source of merge-policy paths.
  // Paths are derived by init scan (re-scan to refresh); never hand-typed. Reviewer sees class intent, not raw globs.
  policyConfig?: import('@buildd/shared').WorkspacePolicyConfig;

  // Early release of dependent tasks before their upstream's PR merges
  // (knowledge-base: buildd/design/early-release.md). Absent / 'off' = no
  // early release — today's merge-gated behaviour. 'rule_only' runs just the
  // Layer 1 deterministic override (early-release-rules.ts) on the upstream
  // PR's diff and never calls the decision model. 'rule_and_jev' runs the
  // full `buildd.early_release` kind (early-release-decision.ts), asking Jev
  // when no rule fires. Read only through resolveEarlyReleaseMode() in
  // apps/web/src/lib/early-release-mode.ts; PATCH /api/workspaces/[id] rejects
  // any other value, and GET /api/workspaces/[id]/settings reports the resolved
  // mode. Clear with `earlyRelease: null`.
  earlyRelease?: { mode?: 'off' | 'rule_only' | 'rule_and_jev' } | null;

  // Auto-resolve merge conflicts by dispatching a same-branch needs-work retry.
  // Absent / true = ON (default). Set to false to disable auto-dispatch and let
  // the human trigger resolution manually from the escalation card.
  autoResolveMergeConflicts?: boolean;

  // The 'Jev keeps agents moving' question gate (docs/design/human-question-gate.md,
  // packages/core/question-gate.ts): Jev decides, holds or asks on every agent
  // question, and the brief-quality pushback runs unconditionally. Absent / true
  // = ON (default). Set to false — the one emergency kill switch — to revert to
  // exactly pre-mission behaviour: every question reaches a person unchanged,
  // with no pushback and no decide/hold.
  jevQuestionGate?: boolean;

  // Workflow state kernel (docs/specs/workflow-state-kernel.md §14). Absent /
  // true = ON: a PR delivery opened from then on is owned by the kernel (review
  // rounds, fix loop, delivery proof). Set to false, the emergency kill switch,
  // to hand every kernel delivery of this workspace back to the legacy paths
  // (sticky per delivery) and open no new ones.
  workflowKernel?: boolean;

  // Trunk circuit breaker (docs/specs/workflow-state-kernel.md §6.10). Absent =
  // ON with the base-red rule: a kernel PR whose failing checks also fail on
  // its base branch's own head joins one trunk incident instead of filing a
  // per-PR CI retry. `{ minDeliveries, windowMinutes }` also opens an incident
  // when that many deliveries hit one signature inside the window (opt-in).
  // `false` turns the breaker off.
  trunkBreaker?: false | { minDeliveries?: number; windowMinutes?: number };

  // PR landing function rollout (`apps/web/src/lib/pr-landing.ts`, design:
  // knowledge-base: buildd/design/pr-landing-guarantee.md §K). `off`: the retained per-door merge
  // paths only. `shadow` (absent = shadow): the landing decision is computed and
  // recorded on the gate ledger beside the legacy action, which still runs.
  // `enforce`: doors act on the landing outcome.
  landing?: { mode?: 'off' | 'shadow' | 'enforce' };

  // Supersession precheck: ratio threshold for the drift-ratio detector.
  // When live GitHub PR stats are ≥ this multiple larger than recorded stats,
  // the drift detector fires. Requires content-already-upstream to also fire
  // before the retry chain is halted. Default: 10 (10×).
  supersessionDriftRatioThreshold?: number;

  // Data classification for privacy enforcement. Absent / 'standard' = normal retention.
  // 'sensitive' = structured-only retention: free-text fields (progress messages, summaries,
  // artifacts, error traces) are dropped at the control-plane boundary; only schema-validated
  // structuredOutput flows through. The outputSchema denylist in create_task enforces
  // that even the schema-validated carve-out contains no content-bearing field names.
  // TODO: migrate to a first-class workspaces.data_class column (task cb34697b).
  dataClass?: 'standard' | 'sensitive';

  // Spec conformance (docs/design/spec-conformance.md §14): where THIS
  // workspace's checkable specs live. Absent ⇒ buildd's own layout
  // (docs/specs, docs/design, packages/core/drizzle) — see
  // `resolveConformanceConfig` in spec-conformance.ts, which these values
  // feed as overrides. `manage_workspaces action=init` detects and proposes
  // this from the repo's file tree (spec-conformance-detect.ts) the same
  // way it proposes `policyConfig`; `spec-conformance-schedule.ts` reads it
  // when building the Tier-3 weekly cron's `create_schedule` params.
  specConformance?: {
    specsRoot?: string;
    designRoot?: string;
    migrationsDir?: string;
  };

  // Owner decisions the repo cannot tell us (docs/design/workspace-onboarding.md §2).
  // The readiness report itself is recomputed, never stored. Absent ⇒ current behaviour.
  onboarding?: WorkspaceOnboardingConfig;

  // Post-session quality loop (artifact post-session-quality-loop-spec §11).
  // Read only through `resolvePostSessionQualityMode` — absent or unrecognised
  // ⇒ 'shadow' (record, never file). 'off' stops new runs; 'propose' applies
  // the follow-up action policy.
  postSessionQuality?: import('../post-session-quality').PostSessionQualityConfig;

  // Quality Scout probe declarations: verification command, test environment,
  // CLI/API journeys, UI routes, fixture setup, write constraints. Read only
  // through resolveScoutExtension() in scout-capabilities.ts. Absent ⇒ Scout
  // uses what the readiness report detects, read-only.
  qualityScout?: WorkspaceQualityScoutConfig;
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

// When a release fires relative to work completing.
// Back-compat default: absent ⇒ 'every_merge' (preserves current behaviour).
export type ReleaseTrigger =
  | 'every_merge'          // release per completed non-skipped task (current default)
  | 'on_mission_complete'  // release once after all tasks in a mission reach terminal state
  | 'manual'               // no auto-fire; owner calls trigger_release explicitly
  | 'scheduled';           // PHASE 2 — nightly/periodic cron (shape TBD, not implemented)

// Release configuration for a workspace — controls whether/how releases happen.
// Stored as jsonb, so this is a free-form shape (no migration on change). All
// step-specific fields are optional; `resolveReleaseStrategy` validates them
// per the chosen strategy.
export interface WorkspaceReleaseConfig {
  // Whether this workspace is configured for releases. Projects without this never release.
  enabled: boolean;

  // Which strategy this workspace uses. Absent ⇒ 'branch_merge' (legacy default).
  strategy?: ReleaseStrategy;

  // When a release fires. Absent ⇒ 'every_merge' (preserves pre-trigger behaviour).
  trigger?: ReleaseTrigger;

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

  // When set, executeRelease looks for an open PR from releaseBranch → prodBranch
  // rather than merging the worker's feature branch. Use when the release task
  // creates an intermediary PR (e.g. dev→main via `bun run release`) instead of
  // the worker's own branch being the ship unit. The PR CI must be green before
  // buildd merges it; CI failure or no open PR marks the release task FAILED.
  releaseBranch?: string;

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
  // 'pending_ci': release PR found, CI not yet green — webhook will complete/fail the task.
  status: 'completed' | 'failed' | 'skipped' | 'not_configured' | 'pending_ci';
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
  // Release PR number being tracked (set when status='pending_ci' or during merge)
  releasePrNumber?: number;
  // Release PR URL for quick links in alerts
  releasePrUrl?: string;
  // GitHub Actions run ID — set at workflow_dispatch time; updated by workflow_run webhook.
  runId?: number;
  // Link to the GitHub Actions workflow run
  runUrl?: string;
  // Workflow run status: 'queued' | 'in_progress' | 'completed'
  runStatus?: string;
  // Workflow run conclusion: 'success' | 'failure' | 'timed_out' | null (while running)
  runConclusion?: string | null;
  // The `releases` row this dispatch created. Without it the task knows it
  // triggered a release and the release does not know which task triggered it,
  // which is the same gap `release_tasks` attribution keeps falling into.
  releaseId?: string;
}

// Work tracker configuration — links a workspace to an external issue tracker.
// `provider='linear'` reaches the tracker via an MCP connector (`connectorId`,
// OAuth). `provider='github'` reaches it via the workspace's existing GitHub App
// installation (no connector — `connectorId` omitted). See
// docs/specs/work-tracker-integration.md.
export interface WorkspaceWorkTrackerConfig {
  provider: 'linear' | 'github';
  // Required for provider='linear'; omitted for provider='github' (uses the App).
  connectorId?: string;
  // Inbound trigger label (provider='github'): an issue with this label creates a
  // linked task. Defaults to 'buildd'/'ai' when unset. See work-tracker spec §3.
  inboundLabel?: string;
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
  // Optional: which dispatch events this webhook receives (apps/web/src/lib/task-dispatch.ts).
  // Absent = the legacy set, new and unblocked tasks only. Retries, approved-plan
  // children and deferred-start re-dispatches reach a webhook only when listed here;
  // otherwise they wake runners over Pusher. A listed config also has runnerPreference
  // applied to unblocked dispatches. 'task.resume' (cloud runner park → answer)
  // is only ever sent to a webhook that lists it. 'task.scheduled' (also only when
  // listed): a task deferred to a future startAt (<= 24 h) is sent at once with
  // `notBefore`, and the consumer starts it then; the deferred sweep stays the backstop.
  events?: Array<'task.created' | 'task.unblocked' | 'task.retry' | 'task.resume' | 'task.scheduled'>;
  // The same column also carries POST /api/webhooks/ingest's keys (webhookSecret,
  // labelFilter, ...). PATCH /api/workspaces/[id] merges onto the stored object, so
  // setting or clearing the dispatch keys above leaves those untouched.
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
  // The role every task this schedule spawns runs as, stated once. Applied at
  // fire time only if the slug still resolves to a role in the task's
  // workspace (knowledge-base: buildd/design/role-routing.md §3.1); otherwise the task files
  // role-less.
  roleSlug?: string;
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
  /** Set by the stale-worker reaper when it auto-completes a task that delivered a PR/artifact. */
  reaperAutoCompleted?: boolean;
  /** Reaper audit trail moved here so result.summary carries the outcome, not forensics. See spec B.5. */
  reaperForensics?: string;
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
}

// Per-model token usage from SDK result
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

/**
 * What a session's `Bash` calls were FOR, as counts.
 *
 * Written by the runner's classifier (`apps/runner/src/bash-classify.ts`,
 * which owns the bucket definitions and the pipeline/chain dominance rule).
 * Bash is the most-called tool and `toolCounts` records it as one opaque bar,
 * so a shell `grep`/`rg`/VCS content search was indistinguishable from a build
 * or a `cat`.
 *
 * Counts only, bounded at a few hundred bytes per worker. `searchShapes` is a
 * coarse shape of the search pattern (bare identifier / regex / quoted phrase
 * with spaces / path-glob), never the pattern text: a search term can carry a
 * secret or a customer identifier, so no command or pattern text is stored.
 */
export interface BashCommandCounts {
  /** Bash calls classified — equals the `Bash` entry of `toolCounts`. */
  total: number;
  /** Calls per intent bucket (`code_search`, `file_find`, `test`, …). Sparse. */
  buckets: Record<string, number>;
  /** Pattern shapes for the `code_search` bucket only. Sparse. */
  searchShapes: Record<string, number>;
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
  /**
   * Set when the worker was blocked by the runner's provision gate (never started
   * the agent). `code` is a stable classification the server keys requeue/escalate
   * policy off. See docs/design/reliable-env-provisioning.md.
   */
  provisionFailure?: { code: string; phase: string; message: string };
  /**
   * Where an abnormally terminated worker's work went: `origin/<branch>@<sha>`
   * (WIP checkpoint pushed to the task branch) or `archive:<path>` on the runner.
   * The retry's context carries it so the next attempt resumes, not restarts.
   */
  recoveryRef?: string;
  /**
   * Every tool_use in the session counted by exact tool name (`Bash`, `Edit`,
   * `mcp__buildd__buildd`, …), written by the runner at terminal state. Counts,
   * not events — unlike `workers.mcpCalls` this is never truncated.
   *
   * Absent on workers that predate the histogram (runner release) or that called
   * no tools. Consumers must treat absence as "unknown", not zero — see
   * `apps/web/src/lib/usage-stats.ts`, which reports tool coverage explicitly.
   */
  toolCounts?: Record<string, number>;
  /**
   * Decomposition of the `Bash` entry of `toolCounts` into intent buckets, plus
   * coarse search-pattern shapes. Absent on workers that predate the classifier
   * or made no Bash call — absence is "unknown", not zero.
   */
  bashCommandCounts?: BashCommandCounts;
  /**
   * File tool calls (Read, Edit, Write, MultiEdit, NotebookEdit) per repo area:
   * tool -> area -> calls. The area is the worktree's top-level directory (two
   * levels for apps/ and packages/), "(repo root)", "(outside the repo)" or
   * "(other)" past a per-tool cap. Never a path or content. Absent on workers
   * that predate the capture or made no file tool call.
   */
  fileToolAreas?: Record<string, Record<string, number>>;
  /**
   * Outcome of the one-shot "closing turn" the runner gives a session that
   * ended without the agent calling `complete_task`, before it falls back to
   * `summarySource: 'fallback'`. 'authored' = the closing turn called
   * complete_task itself (the ordinary fallback text/tagging never applied).
   * 'declined' = the closing turn ran but still didn't call it, so the
   * fallback summary was used anyway; `declined:<reason>` = same, but the
   * closing turn ended on its own error (`max_turns`, or `error` for any other
   * error result / thrown error) — never a task failure. `skipped:<reason>` = no closing turn was
   * attempted at all (session not resumable, or the original session ended by
   * error/abort/rate-limit/credential-failure/cancellation rather than
   * naturally) — reason names why. Absent entirely when the agent's own
   * complete_task call already won the race before this decision was made,
   * which keeps that path byte-identical to before this field existed.
   */
  closingTurnOutcome?: 'authored' | 'declined' | `declined:${string}` | `skipped:${string}`;
  /**
   * Every end-of-session push the runner gave this worker (classifying why a
   * session was ending without delivering, then sending label-specific text —
   * see apps/runner/src/session-end-classification.ts) before its eventual
   * terminal outcome: which label, when, and the exact text sent. Lets
   * "pushes per session and how often a push led to delivery" be answered
   * directly from completed-task result rows, without new telemetry infra.
   */
  sessionEndPushes?: Array<{
    label: 'waiting_on_background_job' | 'asking_permission_it_has' | 'believes_done_no_deliverable' | 'genuinely_blocked';
    at: number;
    text: string;
  }>;
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
  // 'open' lets any authenticated user reach the workspace without team
  // membership (verifyWorkspaceAccess returns role 'member' for them). That is
  // useful for a single-tenant install and wrong as a default the moment a
  // second person signs up, so new workspaces are 'restricted'. Existing rows
  // are deliberately left alone — flipping them would revoke access people
  // currently rely on.
  accessMode: text('access_mode').default('restricted').notNull().$type<'open' | 'restricted'>(),
  // Data sensitivity class — controls knowledge ingestion, transcript retention, and redaction.
  // 'standard': default behaviour. 'sensitive': opts out of telemetry consumers.
  dataClass: text('data_class').default('standard').notNull().$type<'standard' | 'sensitive'>(),
  // Which transport delivers this workspace's dispatch outbox rows.
  // 'dispatch' (default): handed off to the Dispatch Worker; the in-app drain
  // only takes rows the Worker never acked, and nothing is published at all
  // unless DISPATCH_URL and DISPATCH_PUBLISH_SECRET are set, so a self-hosted
  // install without the Worker keeps in-app delivery. 'in_app': the Vercel
  // drain only (the per-workspace kill switch). 'shadow': published and
  // recorded, in-app still delivers (webhook-less workspaces only while
  // webhooks are live on the Worker).
  dispatchTransport: text('dispatch_transport').default('dispatch').notNull().$type<'in_app' | 'shadow' | 'dispatch'>(),

  // Max tasks from this workspace that may have an active worker at once. Repo-backed
  // workspaces isolate each task in its own git worktree, so parallel work is safe;
  // this caps it to bound merge-conflict surface. Default 3. No effect on repo-less
  // workspaces (those are never serialized by the per-repo guard).
  maxConcurrentTasks: integer('max_concurrent_tasks').default(3).notNull(),

  // "Pause new starts until <time>": until then runner claims skip this
  // workspace's tasks (the claim route's workspacePaused gate). Running work
  // carries on and a person's interactive claim is never paused. NULL or a
  // past time = not paused, so it resumes on its own. By = the user who set it.
  newStartsPausedUntil: timestamp('new_starts_paused_until', { withTimezone: true }),
  newStartsPausedBy: text('new_starts_paused_by'),

  // Git workflow configuration
  gitConfig: jsonb('git_config').$type<WorkspaceGitConfig>(),
  // Workspace override of teams.modelUpgradePolicy. NULL = inherit the team's.
  modelUpgradePolicy: jsonb('model_upgrade_policy').$type<import('../model-upgrade-policy').ModelUpgradePolicy | null>(),
  configStatus: text('config_status').default('unconfigured').notNull().$type<'unconfigured' | 'admin_confirmed'>(),

  // Webhook configuration for external agent dispatch (OpenClaw, etc.)
  webhookConfig: jsonb('webhook_config').$type<WorkspaceWebhookConfig>(),

  // Release configuration — controls whether tasks can trigger a prod deploy
  releaseConfig: jsonb('release_config').$type<WorkspaceReleaseConfig>(),

  // Work tracker integration — links a connector as the external issue tracker (e.g. Linear)
  workTrackerConfig: jsonb('work_tracker_config').$type<WorkspaceWorkTrackerConfig>(),

  // Atomic migration-number counter. Incremented by POST /api/workspaces/[id]/migration-slot
  // so concurrent branches get distinct sequential numbers. Starts at 0 (agents read the git
  // journal directly to bootstrap the right initial value on first use).
  lastMigrationNumber: integer('last_migration_number').default(0).notNull(),

  // When true, connector failures are advisory rather than blocking for tasks that
  // have no requiredConnectors. The agent receives a degradedConnectors notice in its
  // system prompt instead of the task being silently deferred. Total degradation (all
  // connectors for the role unavailable) still holds the task regardless of this flag.
  connectorAdvisoryMode: boolean('connector_advisory_mode').default(false).notNull(),

  // DEPRECATED — nothing reads or writes this; see teams.criteriaEvaluationStrategy.
  // The workspace grader lives in gitConfig.criteriaGrader. Drop in a follow-up release.
  criteriaEvaluationStrategy: text('criteria_evaluation_strategy').$type<'inline' | 'worker' | null>(),

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
  status: text('status').default('active').notNull().$type<MissionStatusValue>(),
  costBudgetUsd: decimal('cost_budget_usd', { precision: 10, scale: 2 }),
  priority: integer('priority').default(0).notNull(),
  defaultOutputRequirement: text('default_output_requirement').$type<'pr_required' | 'artifact_required' | 'none' | 'auto'>(),
  // Default agent backend for tasks generated under this mission. An explicit
  // per-task backend still wins; otherwise this overrides the role's hint.
  defaultBackend: agentBackendEnum('default_backend'),
  scheduleId: uuid('schedule_id'),
  parentMissionId: uuid('parent_mission_id'),
  // Optional parent initiative — an execution-free planning container above missions.
  // Null = mission is ungrouped and behaves exactly as before (default no-op).
  initiativeId: uuid('initiative_id').references(() => initiatives.id, { onDelete: 'set null' }),
  // The agent-chat conversation this mission was filed from, if any. Planning
  // updates (plan ready, a worker asking) post back into it. NULL = not from chat.
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  lastEvaluationTaskId: uuid('last_evaluation_task_id'),
  // Mission-level dependency sequencing: this mission won't run until the gate condition
  // is met on dependsOnMissionId. 'merged' = upstream PRs landed; 'completed' = mission.status='completed'.
  dependsOnMissionId: uuid('depends_on_mission_id'),
  gateCondition: text('gate_condition').notNull().default('merged').$type<'merged' | 'completed'>(),
  // Set by checkAndUnblockDependentMissions when the gate condition is satisfied.
  dependencyMetAt: timestamp('dependency_met_at', { withTimezone: true }),
  contextArtifactIds: jsonb('context_artifact_ids').default([]).$type<string[]>(),
  maxConcurrentTasks: integer('max_concurrent_tasks'),
  // Pacing controls: 'eager' starts every claimable task immediately (current default).
  // 'paced' enforces a minimum interval between task starts for this mission:
  // at most pacingMaxPerHour starts per hour (default 1 when null).
  // lastTaskStartedAt is updated atomically each time a task from this mission is claimed.
  pacingMode: text('pacing_mode').default('eager').notNull().$type<'eager' | 'paced'>(),
  pacingMaxPerHour: integer('pacing_max_per_hour'),
  lastTaskStartedAt: timestamp('last_task_started_at', { withTimezone: true }),
  // Mission integration branch, shape `mission/<slug>-<id8>`. Generated lazily on
  // first task creation.
  //
  // Each mission task still gets its OWN branch and its OWN PR — this branch is
  // their shared BASE, not a branch everyone commits to directly, and it does not
  // by itself collapse mission work into a single PR. It only acts as that base
  // when `integrationBranchEnabled` is true; while that flag is false the column
  // is inert bookkeeping and task PRs target trunk as they always have.
  workingBranch: text('working_branch'),
  primaryPrNumber: integer('primary_pr_number'),
  primaryPrUrl: text('primary_pr_url'),
  // Dedup key for PR-ready push notifications — set to PR head SHA after each notify.
  lastNotifiedSha: text('last_notified_sha'),
  // When true, worker PRs for tasks in this mission must be reviewed by a human before merging.
  requiresReview: boolean('requires_review').default(false).notNull(),
  // Per-mission merge policy override. When set, takes precedence over workspace.gitConfig.mergePolicy.
  // null means "use workspace default".
  mergePolicy: jsonb('merge_policy').$type<MergePolicy | null>(),
  // Per-mission opt-in to mission integration branches: task PRs are based on
  // `workingBranch` instead of trunk, and one mission PR takes the integration
  // branch into trunk when the mission's work is done. The merge-policy tier then
  // applies to that ONE mission PR; task PRs into the (quarantined) integration
  // branch run auto-threshold — see resolvePolicy() in apps/web/src/lib/merge-policy.ts.
  //
  // Default false: nothing about any existing mission changes until this is true.
  integrationBranchEnabled: boolean('integration_branch_enabled').default(false).notNull(),
  // ATTEMPT clock for sweepMissionIntegrationPrs (lib/pr-reconcile.ts), mirroring
  // workers.prLastCheckedAt. Advanced on every candidate this sweep looks at,
  // regardless of outcome — including a failed open attempt. The sweep's
  // candidate query gates on THIS column, not `updatedAt`: `updatedAt` is bumped
  // by any unrelated write (e.g. a task completing, via maybeRetriggerMission's
  // debounce), so a mission that keeps genuinely failing to open its PR never
  // ages out of the window as long as something else keeps touching it — and,
  // symmetrically, a mission nothing else ever touches again ages out forever
  // with no re-entry. Null = never attempted.
  prSweepLastCheckedAt: timestamp('pr_sweep_last_checked_at', { withTimezone: true }),
  // Keeping the integration branch current with dev (docs/design/mission-delivery-arc.md
  // P5, superseded): the trunk SHA last confirmed merged into (or already an
  // ancestor of) `workingBranch`. A refresh compares this against trunk's live
  // head and skips the GitHub call entirely when they already match — the
  // idempotency half of debouncing a burst of dev merges. Null means never
  // refreshed (or opted in after the column existed).
  branchRefreshHeadSha: text('branch_refresh_head_sha'),
  // Single-flight lease for the refresh itself: a claim sets this to now() +
  // the lease window, and a second caller racing the same mission (the
  // concurrency half of debouncing a burst) only proceeds once it is null or
  // in the past. Always cleared at the end of the attempt that set it.
  branchRefreshLeaseUntil: timestamp('branch_refresh_lease_until', { withTimezone: true }),
  /** Ownership token prevents expired callers from changing a successor's refresh. */
  branchRefreshLeaseToken: text('branch_refresh_lease_token'),
  // The open conflict-resolution task dispatched after a 409 merging dev into
  // this mission's integration branch — at most one at a time (mirrors
  // conflict-retry's one-live-retry-per-PR rule). Non-null and non-terminal
  // means "stop refreshing this mission until that task finishes"; the next
  // refresh attempt self-heals the column to null once it observes the task
  // reached a terminal status.
  branchRefreshConflictTaskId: uuid('branch_refresh_conflict_task_id'),
  // Controls whether the orchestrator acts autonomously ('auto') or only when explicitly triggered
  // by a human ('manual'). In manual mode, heartbeat cron and loop retriggering are suppressed;
  // tasks filed into the mission still execute normally. 'Run now' always works as a one-shot.
  orchestrationMode: text('orchestration_mode').default('auto').notNull().$type<'auto' | 'manual'>(),
  // Set after the organizer's first evaluation detects pre-filed tasks linked to this mission.
  // When true, the organizer operates in coordinate-only mode: it runs the coordination
  // checklist (retry failures, PR conflict handling, completion detection) but does not
  // decompose/create new build tasks on its own initiative. This prevents duplicate work when
  // a creator files a task chain at the same time as an auto-decomposing mission.
  decompositionSkipped: boolean('decomposition_skipped').default(false).notNull(),
  // When true, tasks filed under this mission are not claimable by workers. Arm the
  // mission (set isHeld=false) to release all tasks at once. Force-starting a single
  // task bypasses this gate via context.bypassHeldGate. Distinct from orchestrationMode
  // (which controls organizer initiative) — held is purely about worker claim eligibility.
  isHeld: boolean('is_held').default(false).notNull(),
  // Who executes the mission's tasks. 'runner' (default): background runners
  // auto-claim them. 'local': a person runs them from their own interactive
  // session — runners never auto-claim, but a verified interactive session may
  // claim_task {taskId} explicitly and gets a normal tracked worker. Orthogonal
  // to isHeld: held is a pure pause and wins over both.
  executor: text('executor').default('runner').notNull().$type<'runner' | 'local'>(),
  // Earliest time autonomous orchestration may begin. Deferred missions remain
  // active, but their schedule and organizer are inert until this floor.
  startAt: timestamp('start_at', { withTimezone: true }),
  startResolution: text('start_resolution').$type<'explicit' | 'relative' | 'known_budget_reset' | 'default_budget_window' | null>(),
  // Phase 2 of the mission release claim: set only AFTER a dispatch or merge
  // reported success. Non-null means the mission's work was actually shipped.
  // Nothing resets it; it is terminal.
  releasedAt: timestamp('released_at', { withTimezone: true }),
  // Phase 1 of the mission release claim (trigger=on_mission_complete). The first
  // caller whose UPDATE wins the isNull guard owns the attempt; concurrent
  // completions see a non-null value and skip. Cleared on a failed attempt so the
  // mission can be released again — previously `releasedAt` itself was claimed
  // up-front, so any failure after the claim (strategy not configured, dispatch
  // throw, executeRelease 'skipped') left the mission permanently marked released
  // with nothing deployed and no way back.
  //
  // Safety bound: a stale attempt (process died between the two phases) is
  // reclaimable only after MISSION_RELEASE_ATTEMPT_STALE_MS, and only while
  // `releasedAt IS NULL`. That caps retries at roughly one per stale window
  // rather than one per task completion.
  releaseAttemptedAt: timestamp('release_attempted_at', { withTimezone: true }),
  // External issue tracker link (e.g. Linear project) — set via /link-linear or API
  externalIssueId: text('external_issue_id'),
  externalIssueUrl: text('external_issue_url'),
  // Goal criteria: declared outcome conditions that gate mission completion.
  // null = no criteria (completion driven by task progress alone).
  // Max 20 criteria; empty array treated as null (no gate).
  goalCriteria: jsonb('goal_criteria').$type<import('@buildd/shared').GoalCriterion[] | null>(),
  // Last evaluation result, persisted by evaluateGoalCriteria callers.
  goalCriteriaState: jsonb('goal_criteria_state').$type<import('@buildd/shared').GoalCriteriaState | null>(),
  // When false, organizer never auto-evaluates criteria; on-demand still works.
  // null reads as true (default: auto-verify ON when criteria are set).
  autoVerify: boolean('auto_verify'),
  // Re-arm bookkeeping for the criteria consumer (see lib/criteria-rearm.ts).
  // A non-pass verdict dispatches ONE organizer cycle carrying the verdict text;
  // these columns are what stop that from becoming an infinite loop. The
  // fingerprint is the verdict shape last re-armed on, the counter how many
  // consecutive cycles it has stayed that shape. Deliberately NOT stored inside
  // goalCriteriaState: that jsonb is the evaluator's snapshot, and every fresh
  // verdict overwrites it wholesale, which would erase the consumer's memory of
  // having already tried.
  criteriaRearmFingerprint: text('criteria_rearm_fingerprint'),
  criteriaRearmCycles: integer('criteria_rearm_cycles').default(0).notNull(),
  criteriaRearmedAt: timestamp('criteria_rearmed_at', { withTimezone: true }),
  // Set when the loop guard gave up and handed the mission to its owner. Non-null
  // means "a human owes this mission a decision" — heartbeats stay off until the
  // verdict shape changes.
  criteriaEscalatedAt: timestamp('criteria_escalated_at', { withTimezone: true }),
  // Per-PR reviewer findings on this mission's prose criteria, newest first.
  // Written by the reviewer-outcome handler at verdict time — the one moment a
  // model has the diff in front of it — and read by the completion-time
  // evaluator as first-class evidence.
  //
  // A sibling column for the same reason criteriaRearm* are: this accumulates
  // across PRs over the life of the mission, and goalCriteriaState is a
  // snapshot that every fresh evaluation overwrites wholesale.
  criteriaReviewerFindings: jsonb('criteria_reviewer_findings')
    .$type<import('@buildd/shared').CriteriaReviewerReport[] | null>(),
  // When true (default), a builder task created under this mission whose
  // pathManifest touches a UI surface directory (apps/web/src/app/**,
  // apps/web/src/components/**) auto-appends a `[surface audit]` task —
  // see ensureMissionSurfaceAudit in apps/web/src/lib/mission-surface-audit.ts.
  // Set false to opt a non-UI or intentionally-unaudited mission out.
  autoSurfaceAudit: boolean('auto_surface_audit').default(true).notNull(),
  // Stamped once, the first time status transitions to 'completed' (the
  // automated predicate in mission-completion.ts, or an explicit human PATCH).
  // Never reset. Null means "not completed, or completed before this column
  // existed" — both read as no-baseline, never as "just now", to a derived
  // metric keyed off it (docs/design/derived-metric-availability.md).
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // Stored flight-strip geometry (docs/design/mission-flight-strip.md, Rule P-1).
  // Same lifecycle as `completedAt`: written once, by the same code paths, at
  // the moment status transitions to 'completed', and never recomputed —
  // a completed mission's worker spans don't change, so the strip can't either.
  // Null means "not completed yet" or "completed before this column existed /
  // before the backfill ran" — the list query (Rule P-2) reads this directly
  // and skips task/worker fan-out entirely for completed missions; it does
  // NOT compute-on-read when null, matching goalCriteriaState's snapshot model.
  flightStripCache: jsonb('flight_strip_cache').$type<import('../mission-helpers').MissionFlightStripData | null>(),
  // Set when the token-free heartbeat circuit breaker (lib/heartbeat-circuit-
  // breaker.ts) pauses this mission after N consecutive died-early heartbeat
  // cycles — a provider outage or similar has no supervisor otherwise, since
  // the organizer IS a Claude worker. Deliberately never cleared on re-arm: the
  // breaker's own "last N heartbeat tasks" window is bounded to tasks created
  // AFTER this timestamp, so re-arming (status -> active) naturally gives the
  // mission a fresh run of N attempts before it can trip again, with no
  // separate clear step to keep in sync.
  heartbeatBreakerTrippedAt: timestamp('heartbeat_breaker_tripped_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('missions_team_idx').on(t.teamId),
  workspaceIdx: index('missions_workspace_idx').on(t.workspaceId),
  statusIdx: index('missions_status_idx').on(t.status),
  parentIdx: index('missions_parent_idx').on(t.parentMissionId),
  dependsOnIdx: index('missions_depends_on_idx').on(t.dependsOnMissionId),
  initiativeIdx: index('missions_initiative_idx').on(t.initiativeId),
  conversationIdx: index('missions_conversation_idx').on(t.conversationId),
}));

// Denormalized initiative rollup. Shape mirrors InitiativeProgress in
// mission-helpers.ts (kept as a local interface to avoid a schema→helpers import).
export interface InitiativeProgressCache {
  totalMissions: number;
  completedMissions: number;
  totalTasks: number;
  completedTasks: number;
  progress: number;
  status: 'empty' | 'active' | 'blocked' | 'paused' | 'completed';
  computedAt: string;
}

// Initiatives — a pure planning container above missions. Deliberately carries
// NONE of the mission execution columns (no orchestrationMode, budget, schedule,
// workingBranch, release trigger): an initiative structurally cannot trip the
// orchestrator/heartbeat/release/budget engine. mission = project, task = issue.
export const initiatives = pgTable('initiatives', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // Nullable — an initiative may group missions across repos (like missions can be workspace-null).
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  // Human-set lifecycle, Linear's initiative statuses plus paused/archived.
  // Nothing derives or auto-advances it. 'planned' needs no migration: text column.
  status: text('status').default('active').notNull().$type<'planned' | 'active' | 'paused' | 'completed' | 'archived'>(),
  priority: integer('priority').default(0).notNull(),
  // Who answers for the initiative. NULL reads as createdByUserId.
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Optional calendar target, no time of day ('YYYY-MM-DD').
  targetDate: date('target_date', { mode: 'string' }),
  // DEPRECATED — unread and unwritten. Drop in a later release (schema-change
  // skill, "Dropping a table or column").
  progressCache: jsonb('progress_cache').$type<InitiativeProgressCache | null>(),
  // Curated artifact-id pointers for context assembly (mirrors missions.contextArtifactIds).
  contextArtifactIds: jsonb('context_artifact_ids').default([]).$type<string[]>(),
  // DEPRECATED — initiative KPIs were removed; nothing reads or writes these
  // three columns. Drop in a later release (schema-change skill).
  kpis: jsonb('kpis').$type<import('@buildd/shared').InitiativeKPI[] | null>(),
  kpiState: jsonb('kpi_state').$type<import('@buildd/shared').InitiativeKPIState | null>(),
  autoVerify: boolean('auto_verify'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('initiatives_team_idx').on(t.teamId),
  workspaceIdx: index('initiatives_workspace_idx').on(t.workspaceId),
  statusIdx: index('initiatives_status_idx').on(t.status),
}));

// Per-user snapshot of the last initiative-rollup progress a user saw, so the
// Home arc headline can detect a milestone CROSSING ("crossed 75%") since their
// last visit. Purely a UI memory — no execution semantics. Refreshed to current
// on every Home render; a first view seeds the baseline without a headline.
export const initiativeProgressSeen = pgTable('initiative_progress_seen', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  initiativeId: uuid('initiative_id').references(() => initiatives.id, { onDelete: 'cascade' }).notNull(),
  lastProgress: integer('last_progress').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.initiativeId] }),
}));


export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  externalId: text('external_id'),
  externalUrl: text('external_url'),
  // External issue tracker link (e.g. Linear issue) — set by agent or webhook integration
  externalIssueId: text('external_issue_id'),
  externalIssueUrl: text('external_issue_url'),
  title: text('title').notNull(),
  // Short 2–4 word display label (scope chip + label). Supplied by whoever files
  // the task, else filled by the creation-time classifier. NULL on legacy rows —
  // read it through taskDisplayLabel (packages/core/task-label.ts), never raw.
  label: varchar('label', { length: 48 }),
  description: text('description'),
  context: jsonb('context').default({}).$type<Record<string, unknown>>(),
  status: text('status').default('pending').notNull().$type<TaskStatusValue>(),
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
  // The person this task is for: the signed-in creator, or — for a task an agent,
  // schedule or mission files — the person behind its parent task, schedule or
  // mission. NULL = no person (pure API-key creation). Personal credentials and
  // personal roles serve only this person's tasks.
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  creationSource: text('creation_source').default('api').$type<'dashboard' | 'api' | 'mcp' | 'github' | 'local_ui' | 'schedule' | 'webhook' | 'orchestrator' | 'conflict'>(),
  // Direct link to the task_schedule that spawned this task (when creationSource = 'schedule' or 'orchestrator').
  // Enables reverse lookup: given a stray task, find the schedule that created it.
  scheduleId: uuid('schedule_id'),  // FK constraint defined in migration (circular ref with task_schedules)
  // Identity of the schedule tick this cycle belongs to: `${scheduleId}:${schedule.lastRunAt}`.
  // Set by the cron dispatcher on every mission-linked cycle, and by the failure-triggered
  // auto-retry path (mission-loop.ts's retriggerMissionOnFailure) when retrying within the
  // same tick. A second insert sharing the anchor collides on the unique index below instead
  // of dispatching a second worker for a cycle the next heartbeat will run anyway.
  heartbeatTickAnchor: text('heartbeat_tick_anchor'),
  parentTaskId: uuid('parent_task_id'),  // FK constraint for self-reference defined in migration
  // Stable identity for webhook-created CI retries. One failed commit may emit
  // several check-suite deliveries, but it must create only one retry task.
  ciRetryPrNumber: integer('ci_retry_pr_number'),
  ciRetryHeadSha: text('ci_retry_head_sha'),
  // Stable identity for conflict-resolution retries. A conflict observation fires
  // from multiple paths (auto-merge, human merge); only one retry task per PR+SHA.
  conflictRetryPrNumber: integer('conflict_retry_pr_number'),
  conflictRetryHeadSha: text('conflict_retry_head_sha'),
  // Stable identity for reviewer-requested-changes retries. The reviewer may re-run
  // on the same headSha; only one fix task per (workspace, PR, headSha).
  reviewerRetryPrNumber: integer('reviewer_retry_pr_number'),
  reviewerRetryHeadSha: text('reviewer_retry_head_sha'),
  // Workflow kernel attempt linkage (docs/specs/workflow-state-kernel.md §5.6):
  // the delivery this task is an attempt of, and its role in it. NULL = not a
  // kernel delivery's attempt (legacy, or not PR work). No FK: the delivery row
  // references tasks (owner_task_id), and a delivery is never deleted on its own.
  deliveryId: uuid('delivery_id'),
  deliveryRole: text('delivery_role').$type<'owner' | 'fix' | 'ci_fix' | 'conflict_fix' | 'review'>(),
  // Task category for visual grouping
  category: text('category').$type<'bug' | 'feature' | 'refactor' | 'chore' | 'docs' | 'test' | 'infra' | 'design' | 'review' | 'research'>(),
  // How `category` was decided, once the decision model has looked at the task
  // (apps/web/src/lib/task-category-decision.ts). NULL = not looked at yet: the
  // sweep picks it up. Carries the prompt/model version, the keyword result and
  // the model's pick, so every write is reversible and re-scoreable.
  categoryDecision: jsonb('category_decision').$type<{
    v: string;
    source: 'caller' | 'keyword' | 'jev';
    keyword: string | null;
    jev: string | null;
    confidence: number | null;
    skipped?: 'sensitive' | 'unconfigured';
    at: string;
  }>(),
  // The task verdict's cached decision (apps/web/src/lib/task-verdict-decision.ts):
  // the wording/actions the decision model picked for the state the rules
  // derived, its error-class calls and the orchestration_decisions ids behind
  // them. Written on a state change only; the page reads it, never computes it.
  // Shape: StoredVerdictDecision in apps/web/src/lib/task-verdict.ts.
  verdictDecision: jsonb('verdict_decision').$type<Record<string, unknown>>(),
  project: text('project'),
  // Output requirement — controls what deliverables are enforced on completion
  outputRequirement: text('output_requirement').default('auto').$type<'pr_required' | 'artifact_required' | 'none' | 'auto'>(),
  // JSON Schema for structured output — passed to SDK outputFormat
  outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
  // Mission linking
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
  // Mission PHASE — the named stretch of a plan this task belongs to.
  // See docs/specs/mission-legibility.md §1. Deliberately NOT called `phase`:
  // `deriveTaskPhase` (apps/web/src/lib/task-presentation.ts) already owns that
  // word and means a task's LIFECYCLE state, which is an unrelated concept.
  //
  // Written exactly once, by approvePlan (from the plan's own `phase` labels) or
  // by the attempt-inheritance copy that gives a retry its parent's phase. Never
  // updated afterwards, and never inferred from a title or description.
  // Both columns are NULL or both are set — enforced by the check constraint below.
  missionPhaseIndex: integer('mission_phase_index'),
  missionPhaseLabel: text('mission_phase_label'),
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
  // Requested intelligence tier — set at creation time, immutable after.
  // Resolved to a concrete model ID via the team's model_tier_registry at claim time.
  // NULL means "use the resolution chain starting from the role."
  tier: text('tier').$type<'premium-plus' | 'premium' | 'standard' | 'budget'>(),
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
  // Declared files/globs this task expects to create or modify.
  // Used by the orchestrator to add dependsOn edges between tasks that touch the same paths,
  // and by the claim-time guard to defer a task whose paths overlap an open PR.
  pathManifest: jsonb('path_manifest').$type<string[] | null>(),
  // What was declared, kept apart from the effective pathManifest above, plus
  // which dependsOn edges were inferred and every narrowing. See PathDeclaration.
  pathDeclaration: jsonb('path_declaration').$type<PathDeclaration | null>(),
  // Ownership revision: bumped by lease acquisition, narrowing and terminal
  // release (packages/core/path-claim.ts) so a narrow can CAS on what it read.
  pathClaimRevision: integer('path_claim_revision').default(0).notNull(),
  // Connector IDs (subset of the role's connectorRefs) that this task MUST have available.
  // The claim route hard-blocks only on connectors in this list; missing connectors outside
  // it are advisory and do not prevent claiming.
  requiredConnectors: uuid('required_connectors').array(),
  // Earliest claim time. Shared by explicit scheduling and budget-limited resume;
  // writers always retain the later floor.
  startAt: timestamp('start_at', { withTimezone: true }),
  // Loop primitive — null when not a looped task; see docs/design/loop-until-verified.md
  loopConfig: jsonb('loop_config').$type<LoopConfig | null>(),
  loopIteration: integer('loop_iteration').default(0).notNull(),
  loopState: text('loop_state').$type<LoopState | null>(),
  // Subject anchor — normalized external identity for what this task acts on.
  // See docs/design/task-subject-anchors.md §1.
  subjectAnchor: jsonb('subject_anchor').$type<TaskSubjectAnchor | null>(),
  // Write-through relational projections of subjectAnchor for indexed lookup.
  // These are kept in sync with subjectAnchor by the write path; never written independently.
  subjectKind: text('subject_kind').$type<'pull_request' | 'error' | 'mission' | 'branch'>(),
  subjectPrNumber: integer('subject_pr_number'),
  subjectHeadSha: text('subject_head_sha'),
  subjectBranch: text('subject_branch'),
  subjectErrorSignature: text('subject_error_signature'),
  subjectMissionId: uuid('subject_mission_id'),
  // 'active' = participates in dedupe; 'retry_chain' = lineage-only; 'none' = explicit file-anyway.
  subjectDedupeScope: text('subject_dedupe_scope').$type<'active' | 'retry_chain' | 'none'>(),
  subjectSupersededByTaskId: uuid('subject_superseded_by_task_id'),
  subjectResolution: text('subject_resolution').$type<'attached' | 'superseded' | 'filed_anyway' | 'reconciled'>(),
  // Stored discriminator — set at insert time by every creation path.
  // 'work': deliverable task counted in mission progress.
  // 'attempt': CI retry or reviewer pass; collapses under its parent in all tallies.
  // 'bookkeeping': coordination/housekeeping; excluded from progress denominator.
  taskClass: text('task_class').notNull().default('work').$type<'work' | 'attempt' | 'bookkeeping'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('tasks_workspace_idx').on(t.workspaceId),
  statusIdx: index('tasks_status_idx').on(t.status),
  claimedByIdx: index('tasks_claimed_by_idx').on(t.claimedBy),
  runnerPrefIdx: index('tasks_runner_pref_idx').on(t.runnerPreference),
  modeIdx: index('tasks_mode_idx').on(t.mode),
  createdByAccountIdx: index('tasks_created_by_account_idx').on(t.createdByAccountId),
  createdByUserIdx: index('tasks_created_by_user_idx').on(t.createdByUserId),
  parentTaskIdx: index('tasks_parent_task_idx').on(t.parentTaskId),
  projectIdx: index('tasks_project_idx').on(t.project),
  missionIdx: index('tasks_mission_idx').on(t.missionId),
  scheduleIdx: index('tasks_schedule_idx').on(t.scheduleId),
  kindIdx: index('tasks_kind_idx').on(t.kind),
  startAtIdx: index('tasks_start_at_idx').on(t.startAt),
  taskClassIdx: index('tasks_task_class_idx').on(t.taskClass),
  // Partial expression index for the github workflow_run webhook's runId
  // lookup, which fires on every completed CI workflow of every push and was
  // sequentially scanning this whole table. Partial because only tasks that
  // dispatched a release carry release_result at all; indexed as TEXT because
  // the query compares ->> output directly (a ::bigint cast would throw 22P02
  // both here at build time and per-row at query time on any malformed value).
  releaseRunIdIdx: index('tasks_release_run_id_idx')
    .on(sql`((release_result->>'runId'))`)
    .where(sql`release_result IS NOT NULL`),
  ciRetryEventIdx: uniqueIndex('tasks_ci_retry_event_unique')
    .on(t.workspaceId, t.ciRetryPrNumber, t.ciRetryHeadSha)
    .where(sql`${t.creationSource} = 'webhook' AND ${t.ciRetryPrNumber} IS NOT NULL AND ${t.ciRetryHeadSha} IS NOT NULL`),
  conflictRetryEventIdx: uniqueIndex('tasks_conflict_retry_event_unique')
    .on(t.workspaceId, t.conflictRetryPrNumber, t.conflictRetryHeadSha)
    .where(sql`${t.conflictRetryPrNumber} IS NOT NULL AND ${t.conflictRetryHeadSha} IS NOT NULL`),
  reviewerRetryEventIdx: uniqueIndex('tasks_reviewer_retry_event_unique')
    .on(t.workspaceId, t.reviewerRetryPrNumber, t.reviewerRetryHeadSha)
    .where(sql`${t.reviewerRetryPrNumber} IS NOT NULL AND ${t.reviewerRetryHeadSha} IS NOT NULL`),
  // Partial unique index — at most one still-pending webhook CI retry per PR,
  // regardless of which head SHA triggered it. ciRetryEventIdx above dedupes an
  // identical event (workspace+PR+headSha) — but a rebase bot force-pushing
  // several times in quick succession produces several DISTINCT head SHAs for the
  // same still-unclaimed failure, and each one passed that check. Once the pending
  // retry is claimed (status leaves 'pending'), a later genuinely-new failure is
  // free to dispatch its own retry. Scoped to ci_retry_pr_number on purpose:
  // reviewer passes and conflict retries are attempt children of the same parent
  // and must neither block nor be blocked by a pending CI retry.
  onePendingCiRetryPerPrIdx: uniqueIndex('tasks_one_pending_ci_retry_per_pr_unique')
    .on(t.workspaceId, t.ciRetryPrNumber)
    .where(sql`${t.status} = 'pending' AND ${t.creationSource} = 'webhook' AND ${t.ciRetryPrNumber} IS NOT NULL`),
  // Partial unique index — the review idempotency key: at most one pending
  // review per (workspace, PR, head SHA). Several producers file reviews for the
  // same PR head (create_pr's auto-review and the PR `opened` webhook fire
  // within milliseconds), and createReviewerTask's live probe cannot stop two
  // that both probe before either inserts. Pending-only because every review is
  // pending at insert time; claimed rows are covered by the probe. Conflict and
  // CI retries carry the same subject anchor, so `category` scopes it to reviews;
  // `creation_source = 'webhook'` + a parent scopes it to createReviewerTask rows,
  // so a human/API filing auto-classified as 'review' never collides with it.
  deliveryIdx: index('tasks_delivery_idx').on(t.deliveryId).where(sql`${t.deliveryId} IS NOT NULL`),
  onePendingReviewPerHeadIdx: uniqueIndex('tasks_one_pending_review_per_head_unique')
    .on(t.workspaceId, t.subjectPrNumber, t.subjectHeadSha)
    .where(sql`${t.category} = 'review' AND ${t.status} = 'pending' AND ${t.creationSource} = 'webhook' AND ${t.parentTaskId} IS NOT NULL AND ${t.subjectPrNumber} IS NOT NULL AND ${t.subjectHeadSha} IS NOT NULL`),
  // Partial unique index — prevents duplicate concurrent planning tasks for the same mission.
  // Only covers non-terminal rows so completed/failed planning tasks don't block new cycles.
  activePlanningPerMissionIdx: uniqueIndex('tasks_active_planning_per_mission').on(t.missionId).where(
    sql`${t.mode} = 'planning' AND ${t.status} IN ('pending', 'assigned', 'in_progress')`
  ),
  // Partial unique index — one cycle per schedule tick, regardless of the prior
  // attempt's current status. activePlanningPerMissionIdx above only blocks while
  // the earlier cycle is still non-terminal, so a cycle that fails fast (e.g. a
  // budget-limited planning task) frees it up again within the same tick and lets
  // an auto-retry dispatch a second full worker for work the next heartbeat would
  // have covered anyway.
  heartbeatTickAnchorIdx: uniqueIndex('tasks_heartbeat_tick_anchor_unique').on(t.heartbeatTickAnchor).where(
    sql`${t.heartbeatTickAnchor} IS NOT NULL`
  ),
  // Subject anchor lookup indexes — hot paths for dedupe, liveness, and recall queries.
  subjectKindIdx: index('tasks_subject_kind_idx').on(t.workspaceId, t.subjectKind),
  subjectPrIdx: index('tasks_subject_pr_idx').on(t.workspaceId, t.subjectPrNumber),
  subjectHeadShaIdx: index('tasks_subject_head_sha_idx').on(t.workspaceId, t.subjectHeadSha),
  subjectErrorIdx: index('tasks_subject_error_idx').on(t.workspaceId, t.subjectErrorSignature),
  subjectMissionIdx: index('tasks_subject_mission_idx').on(t.workspaceId, t.subjectMissionId),
  subjectDedupeScopeIdx: index('tasks_subject_dedupe_scope_idx').on(t.workspaceId, t.subjectDedupeScope),
  // Mission phase lookup — every reader asks "the phases of THIS mission, in order".
  missionPhaseIdx: index('tasks_mission_phase_idx').on(t.missionId, t.missionPhaseIndex),
  // A half-set phase is not a degraded phase, it is a corrupt one: an index with
  // no label renders as a header with no name, a label with no index has nowhere
  // to sort. Rejected in the database so no write path can produce one.
  missionPhasePaired: check(
    'tasks_mission_phase_paired',
    sql`(${t.missionPhaseIndex} IS NULL) = (${t.missionPhaseLabel} IS NULL)`,
  ),
}));

// Reports attached to a task's subject anchor — one row per observation/filing.
// Created when a second filer hits an existing subject claim instead of inserting
// a duplicate task. Also used for enrichment, conflict notes, and escalation records.
// See docs/design/task-subject-anchors.md §1.
export const taskSubjectReports = pgTable('task_subject_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The canonical task this report is attached to.
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  // The task that triggered this report (when an agent/worker filed the duplicate).
  reportingTaskId: uuid('reporting_task_id'),
  // Who/what filed this report: 'webhook' | 'watcher' | 'api' | 'mcp' | 'organizer' | 'system'
  origin: text('origin').notNull(),
  // Account that filed the duplicate (nullable — system origins may not have one).
  reporterId: uuid('reporter_id').references(() => accounts.id, { onDelete: 'set null' }),
  note: text('note'),
  // Snapshot of the subject anchor at the time of filing (immutable audit trail).
  anchorSnapshot: jsonb('anchor_snapshot').$type<TaskSubjectAnchor | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index('task_subject_reports_task_idx').on(t.taskId),
  reportingTaskIdx: index('task_subject_reports_reporting_task_idx').on(t.reportingTaskId),
  createdAtIdx: index('task_subject_reports_created_at_idx').on(t.taskId, t.createdAt),
}));

// Atomic dedupe ledger — one active row per (workspace, key_type, key_hash).
// The UNIQUE partial index (WHERE state = 'active') is the authoritative guard
// against concurrent duplicate task creation. Read-then-write is explicitly
// insufficient; the INSERT ... ON CONFLICT pattern is required.
// See docs/design/task-subject-anchors.md §4.
export const taskSubjectClaims = pgTable('task_subject_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  // Taxonomy of the dedupe key: 'pr_generation' | 'error' | 'mission_intent' | 'branch'
  keyType: text('key_type').notNull(),
  // SHA-256 hex of the canonical key fields (e.g. prNumber+fullHeadSha for pr_generation).
  keyHash: text('key_hash').notNull(),
  // The one canonical task that owns this subject generation.
  // Null while a short-lived reservation owns the key but has not inserted its task yet.
  canonicalTaskId: uuid('canonical_task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  reservationToken: uuid('reservation_token'),
  reservationExpiresAt: timestamp('reservation_expires_at', { withTimezone: true }),
  // Monotonic counter bumped by every rotation of this row (a supersession, or a
  // replacement of a terminal canonical task) — and, because the row is reused in
  // place rather than replaced, it is ALSO the optimistic-lock token that makes a
  // rotation from a stale reader fail. See `rotateClaim` in
  // apps/web/src/lib/subject-intake-db.ts: the guarded UPDATE matches on the
  // generation the caller read and increments it in the same statement, so a
  // caller that observed generation N cannot rotate away the successor a
  // concurrent caller installed at N+1 (an ABA lost update that would leave two
  // live owners for one dedupe key and drop a retry-chain edge).
  generation: integer('generation').default(1).notNull(),
  // Only 'active' is ever written. Supersession happens by rotating this row in
  // place (see rotateClaim), which keeps the retry-chain and prior-terminal links
  // that a release-and-reinsert would discard, so there is deliberately no code
  // path that retires a claim. The index predicate below is therefore
  // constant-true today; it is kept as the extension point for a release
  // lifecycle if one is ever needed (docs/design/deliverable-uniqueness.md §4 is
  // still Proposed, and would re-add its own timestamp column).
  state: text('state').notNull().default('active').$type<'active'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('task_subject_claims_workspace_idx').on(t.workspaceId),
  canonicalTaskIdx: index('task_subject_claims_canonical_task_idx').on(t.canonicalTaskId),
  // THE critical constraint: exactly one active claim per (workspace, key_type, key_hash).
  // Concurrent inserts for the same key collide here; the loser reads canonical_task_id
  // and attaches a report instead of creating a second task.
  activeClaimIdx: uniqueIndex('task_subject_claims_active_unique')
    .on(t.workspaceId, t.keyType, t.keyHash)
    .where(sql`${t.state} = 'active'`),
}));

// Early-release ledger — docs/design/early-release.md "Data model". One row per
// decision to release (or hold) a dependent task before its upstream's PR has
// merged. Append-only: a reconciler revoking a release stamps revokedAt /
// revokedReason on the existing row rather than deleting it, so the decision
// history stays auditable. Every row written here also fires the
// `early_release` gate event.
export const dependencyReleases = pgTable('dependency_releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  dependentTaskId: uuid('dependent_task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  upstreamTaskId: uuid('upstream_task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  // The upstream PR the decision was made against.
  upstreamPrNumber: integer('upstream_pr_number').notNull(),
  // start_now: dependent may claim off trunk. start_stacked: claim off the
  // upstream's branch (baseBranch). wait: keep the dependsOn gate closed.
  decision: text('decision').notNull().$type<'start_now' | 'wait' | 'start_stacked'>(),
  // Who decided: a deterministic rule, the decision model, or the fallback when
  // the model was unavailable or unsure.
  source: text('source').notNull().$type<'rule' | 'model' | 'fallback'>(),
  // Stable machine-readable reason, e.g. which rule matched.
  reasonCode: text('reason_code').notNull(),
  // Branch the dependent was released onto; set for start_stacked.
  baseBranch: text('base_branch'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
}, (t) => ({
  dependentUpstreamIdx: index('dependency_releases_dependent_upstream_idx').on(t.dependentTaskId, t.upstreamTaskId),
}));

// The discrepancy ledger — docs/design/spec-conformance.md §7. A row is the
// derived GAP between a spec's declared status and what the checker actually
// found, not a re-derived report line: identity is the exact
// (workspace, spec_path, assertion_id) triple, never a fuzzy match on the
// assertion's prose, so the same finding across runs updates one row instead
// of manufacturing a new one each time (the `path-claims.md` failure §7
// documents — DRIFTED twice with no state carried between the two reports).
export const specDiscrepancies = pgTable('spec_discrepancies', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  specPath: text('spec_path').notNull(),
  assertionId: text('assertion_id').notNull(),
  // §8: which way the gap runs. code_ahead/contradicted may be written by
  // Tier-2 CI; spec_ahead is written only by the Tier-3 cron (slice 7) after
  // its deeper search rules out a rename — CI never writes it directly.
  direction: text('direction').notNull().$type<'spec_ahead' | 'code_ahead' | 'contradicted'>(),
  // §9: open -> accepted is a parked, not closed, state; -> resolved happens
  // only when a re-run's assertion result lands cleanly, never by self-report.
  status: text('status').notNull().default('open').$type<'open' | 'accepted' | 'resolved'>(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).defaultNow().notNull(),
  // Required when status = accepted (same discipline as the assertion escape
  // hatch's skip_reason) — enforced by the adjudication path, not here.
  acceptedReason: text('accepted_reason'),
  promotedMissionId: uuid('promoted_mission_id').references(() => missions.id, { onDelete: 'set null' }),
  // §8: the docs-only follow-up task dispatched to reconcile this spec with the
  // shipped code. THE dedupe key for "Dispatch doc fix": claimed by an atomic
  // `UPDATE ... WHERE doc_fix_task_id IS NULL`, so a double-tap (or a sibling
  // row on the same spec path) attaches to the task that already exists instead
  // of filing a second one. Never a closure signal — a row still closes only
  // when a checker re-run resolves its assertion (§9).
  docFixTaskId: uuid('doc_fix_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  // When a forced ledger re-run (the ledger workflow dispatched with the §4
  // delta gate bypassed) was last requested for this row after its doc fix
  // merged. The dedupe key for that dispatch, and what lets the card say "re-run
  // dispatched" only when one actually was. Never a closure signal (§9).
  recheckRequestedAt: timestamp('recheck_requested_at', { withTimezone: true }),
  // The ONE automatic follow-up doc-fix task this row gets when a merged doc
  // fix was rechecked and the gap is still open. Non-null means the cap is
  // spent: a second follow-up never auto-dispatches, and the next still-open
  // recheck surfaces the card to the owner with the evidence.
  autoFollowUpTaskId: uuid('auto_follow_up_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  // The human's reason for rejecting a doc-fixer's net-enhancement proposal,
  // retained on the row so the next reader sees that the enhancement was
  // considered and declined rather than never noticed.
  proposalRejectedReason: text('proposal_rejected_reason'),
  // The exact read that produced the current verdict — never a similarity score.
  evidence: jsonb('evidence').$type<Record<string, unknown>>(),
}, (t) => ({
  workspaceIdx: index('spec_discrepancies_workspace_idx').on(t.workspaceId),
  // THE identity constraint (§7): exactly one row per (workspace, spec, assertion).
  identityUnique: uniqueIndex('spec_discrepancies_identity_unique').on(t.workspaceId, t.specPath, t.assertionId),
  // The doc-fix claim is read per spec path, not per assertion — the grouped
  // card and the dispatch route both resolve "is a fix already in flight for
  // this doc" before offering the CTA.
  specPathIdx: index('spec_discrepancies_spec_path_idx').on(t.workspaceId, t.specPath),
}));

/**
 * One answer choice on a worker's open question. The runner forwards the SDK's
 * AskUserQuestion options as objects; older rows and hand-written callers still
 * send bare strings, so readers must accept both.
 */
export type WaitingForOption = string | { label: string; description?: string; recommended?: boolean; consequence?: string };

/**
 * `context`, `recommended` and `where` are the question brief
 * (module header: packages/core/question-brief.ts). All optional: rows written before
 * it carry none and still render.
 */
export type WorkerWaitingFor = {
  type: string;
  prompt: string;
  options?: WaitingForOption[];
  toolUseId?: string;
  context?: string;
  recommended?: { label: string; reason?: string };
  where?: { taskTitle?: string; branch?: string; file?: string };
};

/**
 * One entry of `workers.milestones`, as the runner and the progress API write it.
 * `label` is optional because sensitive workspaces strip it server-side. Action
 * milestones may carry structured tool data (runner >= structured-milestones);
 * older rows carry only the label, so readers must degrade to parsing it.
 */
export type WorkerMilestone =
  | {
      type: 'phase';
      /** The assistant text that opened the phase (first sentence) — kept verbatim for audit. */
      label?: string;
      toolCount: number;
      ts: number;
      pending?: boolean;
      /**
       * Distinct operations the phase called, in order (`get_decision`, `Edit`,
       * `Bash`): the MCP action or tool name, never its input. Lets readers name
       * a phase by what it did when its text was only a lead-in to the calls.
       * Absent on older runners.
       */
      ops?: string[];
    }
  | { type: 'status'; label?: string; progress?: number; ts: number; origin?: 'agent' }
  | { type: 'plan'; label?: string; progress?: number; ts: number; origin?: 'agent' }
  | { type: 'checkpoint'; event: string; label?: string; ts: number }
  | {
      type: 'action';
      label?: string;
      ts: number;
      tool?: 'Edit' | 'Write' | 'MultiEdit' | 'Read' | 'Bash';
      path?: string;
      add?: number;
      rem?: number;
      cmd?: string;
      count?: number;
    };

export const workers = pgTable('workers', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  // The person whose OAuth session claimed this worker (the session's JWT
  // subject, a users.id). An OAuth session acts as an account its whole team
  // shares, so accountId alone cannot tell one member's claim from another's;
  // the worker owner check (lib/worker-owner.ts) requires this to match the
  // caller's session user. NULL: claimed by a bld_ key, which owns by account.
  // No FK on purpose: a deleted user must not turn the claim back into an
  // account-owned (NULL) one.
  claimedByUserId: uuid('claimed_by_user_id'),
  name: text('name').notNull(),
  runner: text('runner').notNull(),
  branch: text('branch').notNull(),
  status: text('status').default('idle').notNull().$type<WorkerStatusValue>(),
  waitingFor: jsonb('waiting_for').$type<WorkerWaitingFor | null>(),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }).default('0').notNull(),
  // How costUsd and the tokens were charged: real (per token) | virtual (plan
  // usage at list price) | mixed | unknown. Reported by whoever picked the
  // credential (packages/core/cost-basis.ts). NULL = no usage recorded.
  costBasis: text('cost_basis').$type<import('../cost-basis').CostBasis | null>(),
  // Token usage (for seat-based accounts where cost isn't meaningful)
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  turns: integer('turns').default(0).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  // Worker liveness lease. Renewed by the owning runner's 60s liveness timer
  // (deterministic code, NOT the agent loop) so a worker sitting inside one long
  // silent tool call keeps asserting liveness — the case that made "no update in
  // N minutes" indistinguishable from a dead process.
  //
  // NULL means the owning runner does not renew leases (older build). Such rows
  // MUST fall back to the legacy updatedAt staleness rule; never treat NULL as
  // an expired lease, or every worker on an un-upgraded runner is reaped at once.
  // Because of that, nothing may seed this at claim time: renewal is the only
  // writer, so NULL unambiguously means "this runner doesn't do leases".
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  error: text('error'),
  // Runner direct access URL (e.g., https://runner--workspace.coder.dev or http://100.x.x.x:8766)
  localUiUrl: text('local_ui_url'),
  // Current action/status line from runner
  currentAction: text('current_action'),
  // Milestones stored as JSON array
  milestones: jsonb('milestones').default([]).$type<WorkerMilestone[]>(),
  // PR tracking
  prUrl: text('pr_url'),
  prNumber: integer('pr_number'),
  // Set by webhook when the worker's PR is merged; used by dependsOn gate to
  // distinguish "task completed before PR merged" from "PR actually landed".
  mergedAt: timestamp('merged_at', { withTimezone: true }),
  // PR/git lifecycle state — kept live by GitHub webhook events.
  // null = no PR yet or status unknown (pre-migration workers).
  // 'unresolvable' is TERMINAL and is written only by the reconcile sweep, after
  // a row has failed to resolve against GitHub UNRESOLVABLE_FAILURE_THRESHOLD
  // times and is older than UNKNOWN_TTL_MS (see lib/pr-freshness.ts). It exists
  // so a row buildd genuinely cannot resolve stops being treated as an open PR
  // forever — it leaves Home for the health surface instead of sitting on the
  // action queue as a merge CTA nobody can act on.
  prLifecycleStatus: text('pr_lifecycle_status').$type<'pr_open' | 'ci_running' | 'ci_green' | 'ci_failed' | 'merged' | 'conflict' | 'closed' | 'unresolvable' | null>(),
  // Set the first time prLifecycleStatus transitions to 'conflict'. Used to measure
  // conflictDeadDays. Never cleared (even if PR later becomes mergeable).
  conflictDetectedAt: timestamp('conflict_detected_at', { withTimezone: true }),
  // Last time we ATTEMPTED to check this PR's state against GitHub — advanced
  // on every outcome, including a failed call. Null = never attempted. Drives
  // ORDER BY queue rotation (reconcileStalePrWorkers, refreshStaleWorkersFor-
  // Workspaces, dead-zone-sweep) so a row that keeps failing still rotates to
  // the back of the batch instead of pinning the head forever.
  //
  // This is deliberately NOT what "is this row's state fresh?" reads — that a
  // check was ATTEMPTED says nothing about whether it SUCCEEDED. See
  // prLastVerifiedAt below and lib/pr-freshness.ts.
  prLastCheckedAt: timestamp('pr_last_checked_at', { withTimezone: true }),
  // Last time GitHub actually CONFIRMED this row's PR state (merged / closed /
  // still open) — never touched by a failed check. Null = never confirmed.
  // This is the column lib/pr-freshness.ts reads to decide whether a row's
  // lifecycle state is fresh enough to render as a merge CTA; prLastCheckedAt
  // cannot answer that question because recordFailure() advances it too.
  prLastVerifiedAt: timestamp('pr_last_verified_at', { withTimezone: true }),
  // Consecutive failed attempts to resolve this PR against GitHub (404, dead
  // installation, no repo). Reset to 0 on any successful resolution. Drives the
  // transition to prLifecycleStatus='unresolvable'.
  prCheckFailureCount: integer('pr_check_failure_count').default(0).notNull(),
  // Why the row went terminal-unresolvable. Rendered on the health surface so
  // an orphaned PR is visible rather than silently dropped (facae217 AC-6).
  prUnresolvableReason: text('pr_unresolvable_reason'),
  // Base branch SHA at the time the PR was opened (captured by create_pr).
  // Used by the base-history-rewrite detector to identify force-pushes that
  // orphan the PR's merge base.
  prOpenedBaseSha: text('pr_opened_base_sha'),
  // The PR's base ref as GitHub reports it — recorded at open time from
  // `pull_request.base.ref` and refreshed by the pull_request webhook (which is
  // what catches a RETARGET, i.e. someone changing a PR's base after it opened).
  // This is the local source of truth for "did this land on trunk, or on a
  // mission integration branch", which decides whether the merge-policy tier
  // applies to this PR (see resolvePolicy()).
  //
  // Nullable: pre-migration workers and non-PR workers have none. A null must
  // NEVER be read as "trunk" — unknown has to degrade to the existing gate,
  // because guessing wrong here silently deletes a human review gate.
  prBaseRef: text('pr_base_ref'),
  // Whether the PR is in draft status. Kept live by GitHub webhook events.
  // null = no PR yet or status unknown (pre-migration workers).
  prIsDraft: boolean('pr_is_draft'),
  // Supersession edge (task fcaf83d5): this worker's PR closed without merging,
  // but its diff landed anyway under a DIFFERENT, merged PR — e.g. a mission
  // integration branch got deleted out from under an open PR (#2355) and the
  // work was re-opened as a fresh PR rather than resurrecting the old one.
  // `canCompleteMission`'s awaiting-merge gate (mission-completion.ts) is
  // deliberately strict about closed-unmerged PRs — that is the correct rule
  // from the M4 incident — so this is the one sanctioned escape hatch: a
  // durable, auditable claim, not a status the agent can assert its way past.
  //
  // Write-time only. `recordPrSupersession` (lib/pr-supersession.ts) verifies
  // the target PR is real and MERGED before setting these columns, so a read
  // never has to re-check GitHub — a merge is permanent, so a stored claim
  // stays valid forever once written. All four columns are set together or
  // not at all; there is no partial-write state to defend against.
  supersededByPrNumber: integer('superseded_by_pr_number'),
  supersededByPrUrl: text('superseded_by_pr_url'),
  // Required at write time — the whole point is that this is never a silent
  // agent assertion (see canCompleteMission's "Do NOT" doctrine).
  supersededReason: text('superseded_reason'),
  // Free-text actor label (user email, or 'agent:<taskId>') — same convention
  // as missionNotes.actorLabel, not a foreign key, so the audit trail survives
  // the account being deleted.
  supersededRecordedBy: text('superseded_recorded_by'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  // A closed-unmerged PR a person declared abandoned: the work is deliberately
  // not shipping, and the reason says why. Not a supersession (nothing landed)
  // and not a fake one — `prShipState` reads it as its own `abandoned` state,
  // which no longer blocks mission completion. Reason required at write time
  // (lib/pr-supersession.ts `recordPrAbandonment`).
  abandonedReason: text('abandoned_reason'),
  abandonedRecordedBy: text('abandoned_recorded_by'),
  abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
  // Where automatic supersession detection (lib/pr-supersession-detect.ts)
  // looked last, and the unverified candidate it found, if any. A suggestion
  // here is NEVER an edge: only content verification writes the columns above.
  // `supersessionScannedAt` mirrors `supersessionScan.scannedAt` so the backfill
  // sweep can select stale rows without a jsonb cast.
  supersessionScan: jsonb('supersession_scan').$type<import('../pr-shipped').SupersessionScan | null>(),
  supersessionScannedAt: timestamp('supersession_scanned_at', { withTimezone: true }),
  // Git stats - updated by agent on progress reports
  lastCommitSha: text('last_commit_sha'),
  commitCount: integer('commit_count').default(0),
  filesChanged: integer('files_changed').default(0),
  linesAdded: integer('lines_added').default(0),
  linesRemoved: integer('lines_removed').default(0),
  // Runner-reported `git status --porcelain` (tracked files only, untracked
  // excluded) at the worktree the worker session is using. Kept fresh by the
  // periodic sync loop so the value is current by the time complete_task is
  // called — that call reaches the server directly from the agent's MCP tool,
  // with no local git access of its own, so the completion gate has nothing
  // else to read at the instant it needs to decide.
  dirtyWorktree: boolean('dirty_worktree').default(false).notNull(),
  // Admin instructions — the delivery queue. Handed to a consuming runner on its
  // next check-in and cleared ONLY when that runner confirms it injected the text
  // (PATCH `instructionsDelivered`). Multiple queued instructions concatenate, so
  // a second instruction never overwrites an undelivered first one.
  pendingInstructions: text('pending_instructions'),
  // Instruction history - log of sent instructions and worker responses
  instructionHistory: jsonb('instruction_history').default([]).$type<Array<{
    /** Server-generated at enqueue; consumers settle and acknowledge by it. Absent on older entries. */
    id?: string;
    type: 'instruction' | 'response';
    /** Omitted for sensitive workspaces — the {type, ts} envelope is kept only. */
    message?: string;
    timestamp: number;
    // 'pending' = queued (shown as Queued); 'delivered' = a consumer (the
    // runner, or an MCP read) confirmed the text reached the agent session;
    // 'acknowledged' = the agent's turn read it (observed, never inferred).
    // Never set to 'delivered' at write time — that recorded deliveries that
    // never happened. Undelivered is derived (run ended first), never stored.
    // Read through messageDeliveryStatus (apps/web/src/lib/worker-instructions.ts).
    deliveryState?: 'pending' | 'delivered' | 'acknowledged';
    deliveredAt?: number;
    acknowledgedAt?: number;
    /** Settled by id: its consumer reports reads, so an unread one is undelivered once the run ends. */
    awaitsAck?: true;
    turnAtSend?: number;
  }>>(),
  // Transitional capability flag: true once this worker's runner has checked in
  // with `consumeInstructions: true`, i.e. it speaks the delivery-confirmation
  // protocol (serve → inject → ack). Urgent (Pusher) instructions are only ALSO
  // queued as a fallback for such runners; older runners would inject the Pusher
  // copy and then the queued copy, duplicating the message. Drop this column once
  // no pre-ack runner can check in.
  supportsInstructionAck: boolean('supports_instruction_ack').default(false).notNull(),
  // Cloud runner (docs/design/cloudflare-sandbox-runner.md, Phase 2 "Resumable
  // runs"): set when a --once runner parked this worker — uploaded its branch,
  // uncommitted work and transcript, then let its container go — and cleared
  // by POST /api/workers/[id]/reattach or on expiry. While it is in the future
  // the worker counts as holding its transcript (answer-resume.ts G2) and is
  // exempt from the offline-runner sweep. NULL for every other runner.
  parkedUntil: timestamp('parked_until', { withTimezone: true }),
  // A person asked this running worker to pause (POST /api/workers/[id]/pause).
  // Served to the runner on every PATCH response (`pauseRequested`) until the
  // worker parks as waiting_input or ends, so a missed realtime push still
  // lands. Cleared on that park, or on any terminal status.
  pauseRequestedAt: timestamp('pause_requested_at', { withTimezone: true }),
  // SDK result metadata - captured from SDKResultSuccess/SDKResultError on completion
  resultMeta: jsonb('result_meta').$type<ResultMeta | null>(),
  // What the agent actually sent on a completion the outputRequirement gate
  // refused (400) — summary/structuredOutput/resultMeta, verbatim. Without
  // this, a rejected `complete_task` call (e.g. a 60-turn review with no PR/
  // artifact) discarded the agent's payload entirely; a human investigating
  // the failure had nothing to read. Written right before the gate's 400
  // response, never cleared — each rejection is a distinct worker row, so
  // there is nothing later to go stale against.
  rejectedCompletionPayload: jsonb('rejected_completion_payload').$type<Record<string, unknown> | null>(),
  // Latest loop verification evidence (command exit condition) the runner
  // recorded for this worker. The runner's PreToolUse hook runs the command
  // and writes it here BEFORE the agent's own complete_task reaches the
  // server — that PATCH carries no evidence, so the loop dispatch falls back
  // to this column. Bound to workerId + iteration inside the object.
  verificationEvidence: jsonb('verification_evidence').$type<Record<string, unknown> | null>(),
  // MCP tool call log - appended by runner during execution
  mcpCalls: jsonb('mcp_calls').default([]).$type<Array<{
    server: string;
    tool: string;
    ts: number;
    ok: boolean;
    durationMs?: number;
  }>>(),
  // Exit cause taxonomy — set when a worker reaches a terminal state.
  // code_failure:       the agent or task logic failed (default for unknown failures).
  // budget_limited:     session/usage cap hit — not a real failure; task auto-resumes.
  // infra_failure:      runner went offline or worker timed out (heartbeat/stale kill).
  // never_started:      row was created at claim but no runner ever started it (started_at NULL);
  //                     a bookkeeping artifact of over-claim — never charged to the task's retries.
  // silent_start:       session reached started_at but streamed nothing (≤2 turns, $0 spend);
  //                     points at the runner/SDK stream, not the task. Task requeues.
  // reassigned:         worker was superseded by a newer session.
  // condition_unmet:    loop exit condition evaluated false; task requeues (not a failure).
  // sandbox_mount_gap:  bwrap allowlist missing a path (npm postinstall, config file, tool binary);
  //                     task requeues; fix by adding path to BUILDD_MOUNT_ALLOWLIST_EXTRA.
  // server_refused:     WE refused one of the runner's mutations (4xx, or an unqueueable 5xx) —
  //                     a decision about the REQUEST, not the work. Never charged to the task's
  //                     retries; bounded instead by the PATCH route's infraRetryCount budget.
  // output_unmet:       a declared output gate refused the completion — the session ran and
  //                     shipped nothing reviewable. Charged, but not as a code failure.
  // task_cancelled:     the task was cancelled while the session was still running — whatever
  //                     the session reported afterwards is moot. Bookkeeping; never charged.
  // null: worker is still active, completed successfully, or predates this column.
  exitCause: text('exit_cause').$type<'code_failure' | 'budget_limited' | 'infra_failure' | 'never_started' | 'silent_start' | 'reassigned' | 'condition_unmet' | 'sandbox_mount_gap' | 'needs_input' | 'server_refused' | 'output_unmet' | 'task_cancelled' | null>(),
  // Subagent spans flushed once at worker terminal state (not on every progress event).
  // JSONB (v1): keeps the change small; migrate to a worker_subagents table when per-span
  // querying is needed (e.g. mission skyline v2 lanes-within-a-bar).
  subagentSpans: jsonb('subagent_spans').default([]).$type<Array<{
    taskId: string;
    toolUseId: string;
    agentId?: string;
    parentAgentId?: string;
    description: string;
    taskType: string;
    startedAt: number;
    completedAt?: number;
    status: 'running' | 'completed' | 'failed';
    isBackground: boolean;
    durationMs?: number;
    toolCount?: number;
    cumulativeUsage?: { inputTokens: number; outputTokens: number; costUsd: number };
  }>>(),
  // Total task_started events observed during the session. May exceed subagentSpans.length
  // when the 100-span in-memory cap was hit. When observedCount > length, span-derived
  // metrics (e.g. backgroundAgentMs) are floors, not exact totals.
  subagentSpansObserved: integer('subagent_spans_observed').default(0).notNull(),
  // Sum of durationMs for isBackground=true spans.
  // Mission agent-time = Σ(worker wall-clock) + Σ(backgroundAgentMs).
  // Foreground subagents are excluded — their time is already inside the parent's wall clock.
  backgroundAgentMs: integer('background_agent_ms').default(0).notNull(),
  // Connectors that were degraded (failed health check) when this worker claimed
  // under advisory mode (connectorAdvisoryMode=true). Persisted for audit trail.
  degradedConnectors: jsonb('degraded_connectors').$type<Array<{
    id: string;
    name: string;
    failureMode: 'never_mounted' | 'expired_or_revoked' | 'transient';
    detail?: string;
  }> | null>(),
  // Cumulative observed file paths collected from git diff --name-only on each
  // update_progress PATCH. Appended server-side (deduped, capped at 500). Cleared
  // on terminal worker status. Used by passive collision detection (§6d).
  observedTouches: jsonb('observed_touches').$type<string[] | null>(),
  // A runner terminal PATCH (status=failed/error) that arrives for a worker
  // ALREADY `superseded` (POST /api/workers/[id]/respond answered its question
  // first) cannot go through the normal terminal-transition write — that CAS is
  // reserved by whichever write reaches the row first, and superseded already
  // won. Without this column that later report had nowhere durable to land: the
  // PATCH 409s before `error` is ever set, so a real backend-auth failure on the
  // answered session was invisible to the owner and never reached credential
  // health. Set only by that late-PATCH path in workers/[id]/route.ts, never by
  // the normal terminal-transition write — a superseded worker's OWN outcome
  // stays whatever `/respond` recorded; this is strictly an out-of-band report
  // about what happened to the session afterward. Deliberately excluded from
  // failure-analytics signatures/rate (keyed off `status`, not this column) —
  // see lib/failure-analytics.ts's superseded-error lookup for how it still
  // surfaces to `get_failure_analytics(error=...)`.
  postSupersessionError: text('post_supersession_error'),
  postSupersessionErrorAt: timestamp('post_supersession_error_at', { withTimezone: true }),
  // The `Continue: <title>` task /respond created when this worker's question
  // was answered. Written back after that insert succeeds, so the worker row
  // — surfaced in the UI long after the continuation is the only task anyone
  // still looks at — carries a durable pointer to it instead of requiring a
  // reverse lookup through `tasks.context.previousAttempt.workerId`.
  continuationTaskId: uuid('continuation_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index('workers_task_idx').on(t.taskId),
  workspaceIdx: index('workers_workspace_idx').on(t.workspaceId),
  accountIdx: index('workers_account_idx').on(t.accountId),
  statusIdx: index('workers_status_idx').on(t.status),
  accountStatusIdx: index('workers_account_status_idx').on(t.accountId, t.status),
  // Webhook "which worker owns this PR" lookups (workerOwnsPr / workerOwnsPrUrl in lib/repo-scope.ts)
  // and knowledge ingest's by-URL lookup. Partial: most workers never open a PR.
  prNumberIdx: index('workers_pr_number_idx').on(t.prNumber).where(sql`${t.prNumber} IS NOT NULL`),
  prUrlIdx: index('workers_pr_url_idx').on(t.prUrl).where(sql`${t.prUrl} IS NOT NULL`),
}));

/**
 * Presence of a person's interactive coding session (Claude Code, Codex,
 * Cursor) reported by the buildd agent plugin's lifecycle hooks. A row here is
 * presence, never a worker: it holds no concurrency seat and no task. It is
 * bound to a worker only after that same session's own verified `claim_task`
 * minted one (`workers.runner = 'mcp'`); see apps/web/src/lib/local-session.ts
 * and docs/specs/local-agent-presence.md.
 *
 * No transcript, prompt or response content is ever stored. The client's
 * session id is kept only as a SHA-256 hash.
 */
export const localSessions = pgTable('local_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Owner when the hook authenticated with an account API key. Exactly one of accountId / userId. */
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  /** Owner when the hook authenticated with the person's presence token (presenceTokens). */
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Resolved from the session's git remote among the workspaces the account reaches; null if none matched. */
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  /** 'claude' | 'codex' | 'cursor' | 'other' */
  clientKind: text('client_kind').notNull(),
  /** SHA-256 of the client's own session/conversation id. Opaque. */
  clientSessionHash: text('client_session_hash').notNull(),
  clientVersion: text('client_version'),
  /** owner/name of the session's git remote, credentials stripped. */
  repo: text('repo'),
  /** False when the client says the session is a background agent. */
  interactive: boolean('interactive').default(true).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endReason: text('end_reason'),
  /**
   * Legacy: the single worker a session could hold before multi-claim. Read
   * (never written) so a session bound before localSessionWorkers existed still
   * releases its worker; the bindings live in localSessionWorkers now.
   */
  boundWorkerId: uuid('bound_worker_id').references(() => workers.id, { onDelete: 'set null' }),
  boundAt: timestamp('bound_at', { withTimezone: true }),
}, (t) => ({
  clientIdx: uniqueIndex('local_sessions_client_idx').on(t.accountId, t.clientKind, t.clientSessionHash),
  userClientIdx: uniqueIndex('local_sessions_user_client_idx').on(t.userId, t.clientKind, t.clientSessionHash),
  oneOwner: check('local_sessions_one_owner', sql`num_nonnulls(${t.accountId}, ${t.userId}) = 1`),
  boundWorkerIdx: uniqueIndex('local_sessions_bound_worker_idx').on(t.boundWorkerId),
  workspaceSeenIdx: index('local_sessions_workspace_seen_idx').on(t.workspaceId, t.lastSeenAt),
}));

/**
 * The interactive workers a local session holds: one row per claim its own
 * claim_task (or a subagent's) minted. The worker is the primary key, so a
 * worker belongs to at most one session, ever; a session may hold several.
 */
export const localSessionWorkers = pgTable('local_session_workers', {
  workerId: uuid('worker_id').primaryKey().references(() => workers.id, { onDelete: 'cascade' }),
  localSessionId: uuid('local_session_id').references(() => localSessions.id, { onDelete: 'cascade' }).notNull(),
  boundAt: timestamp('bound_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  sessionIdx: index('local_session_workers_session_idx').on(t.localSessionId),
}));

/**
 * A person's presence token (apps/web/src/lib/presence-token.ts): what the
 * agent plugin's hooks authenticate with, one per machine. The token itself is
 * signed, never stored; this row is what makes it revocable and lists it in
 * settings. It can only report presence and bind/release that person's own
 * interactive workers.
 */
export const presenceTokens = pgTable('presence_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /** The machine it was issued to (hostname at `buildd login`). */
  label: text('label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  userIdx: index('presence_tokens_user_idx').on(t.userId),
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

/**
 * Per-call event stream for the buildd MCP tool's `action` param. The buildd
 * MCP multiplexes ~55 actions (32 workerActions + 23 adminActions) through
 * one SDK tool name (`mcp__buildd__buildd`), so the tool histogram
 * (`workers.resultMeta.toolCounts`) can only ever show one aggregate bar for
 * the whole surface. An aggregate count map can't decompose it either:
 * whether a call like create_pr/create_artifact/upload_artifact/merge_pr is
 * RUNTIME (the platform forces it, e.g. create_pr under
 * outputRequirement='pr_required') or WORK (the agent chose it) depends on
 * the CALLING TASK's outputRequirement/loopConfig, not the action name alone
 * — so classification has to join each call to its task at query time, which
 * needs a raw event per call, not a count. See health-analytics-spec §4.3
 * item 1 / WU-4. No classification is stored here — that's computed later,
 * by whoever builds the drill-down panel, from `taskId`.
 *
 * A dedicated, indexed table rather than a jsonb array on `workers` —
 * `workers.mcp_calls` capped at the last 100 entries is exactly the failure
 * mode this avoids: a capped in-place array can't be paginated, indexed by
 * time, or pruned by age independently of the worker row. Pruned weekly past
 * ACTION_EVENTS_RETENTION_DAYS by the task-archive cron (see
 * apps/web/src/app/api/cron/task-archive/route.ts) — the drill-down this
 * feeds only ever reads 7d/30d windows, so nothing needs unbounded retention.
 *
 * No backfill: this table has no rows before the runner release that started
 * writing to it. Consumers must read `ACTION_EVENTS_CAPTURED_SINCE`
 * (apps/web/src/lib/action-events.ts) and render "actions recorded since
 * {date}" rather than treating a quiet window as zero activity.
 */
export const workerActionEvents = pgTable('worker_action_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  // Bare action name off the buildd MCP call, e.g. 'create_pr', 'update_progress'.
  action: text('action').notNull(),
  // Runner-reported tool_use time, not insert time — sync can lag up to the
  // 10s periodic flush (or longer on retry), so this is the honest ordering key.
  ts: timestamp('ts', { withTimezone: true }).notNull(),
}, (t) => ({
  workerTsIdx: index('worker_action_events_worker_ts_idx').on(t.workerId, t.ts),
  taskTsIdx: index('worker_action_events_task_ts_idx').on(t.taskId, t.ts),
  actionTsIdx: index('worker_action_events_action_ts_idx').on(t.action, t.ts),
}));

/**
 * One row per prompt build, in both memory-digest arms (see
 * apps/runner/src/memory-digest-policy.ts PromptCompositionRecord). Replaces
 * the two places this record used to land — the per-worker session log
 * (pruned after 48h, shorter than the ciRetry/conflictRetry/reviewerRetry/
 * criteriaRearm chains the experiment is measured across) and runner stdout
 * (outlives the log but isn't queryable).
 *
 * `buildIndex` rather than a column on `workers`: a single worker can build
 * more than one prompt (e.g. the bwrap-retry restart in startSession rebuilds
 * from scratch on the same worker/task), and a column would silently keep
 * only the last build. This table keeps all of them, ordered by buildIndex
 * within (workerId, taskId).
 *
 * `propensity` and `fraction` are recorded as assigned, not recomputed later
 * from the currently configured fraction — the fraction can be reconfigured
 * between assignment and analysis, and an off-policy estimate divides by the
 * propensity that was actually in effect. `policyVersion` must never be
 * pooled across values: a version bump changes what the arms mean.
 *
 * Low volume relative to worker_action_events (one row per prompt build, not
 * per MCP call), so — unlike that table — this one is not pruned by the
 * task-archive cron; the experiment needs the full history across a task's
 * retry chain.
 */
export const workerPromptCompositionEvents = pgTable('worker_prompt_composition_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  // 0-based, ordered per (workerId, taskId) — see rationale above.
  buildIndex: integer('build_index').notNull(),
  // Runner-reported build time, not insert time — same ordering rationale as
  // worker_action_events.ts.
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  policyVersion: text('policy_version').notNull(),
  arm: text('arm').notNull().$type<'full' | 'task_scoped'>(),
  // Probability this unit would have been assigned the arm it actually got,
  // as recorded at assignment time — see table comment.
  propensity: decimal('propensity', { precision: 5, scale: 4 }).notNull(),
  // The configured task_scoped share this assignment was drawn against.
  fraction: decimal('fraction', { precision: 5, scale: 4 }).notNull(),
  digestBytes: integer('digest_bytes').notNull(),
  // Bytes the workspace-wide digest WOULD have occupied under `full`, recorded
  // in both arms so the saving is computable from a control row alone.
  digestBytesAvailable: integer('digest_bytes_available').notNull(),
  digestTruncated: boolean('digest_truncated').notNull(),
  taskMatchBytes: integer('task_match_bytes').notNull(),
  taskMatchCount: integer('task_match_count').notNull(),
  // Which retrieval step produced the matches (declared paths, title fallback,
  // a miss, or not attempted). NULLABLE on purpose: a row written by a runner
  // that predates the field is genuinely UNKNOWN, and defaulting it to any
  // value would encode an inference as data. taskMatchCount alone cannot
  // distinguish five path-overlap hits from five stopword hits, so without
  // this column retrieval quality is unrecoverable from stored rows.
  taskMatchDerivedBy: text('task_match_derived_by'),
  // Agent backend. Also NULLABLE, and for the same reason — the Codex path
  // delivers persona/skills/instructions through a file on disk rather than the
  // prompt, so promptBytes and memoryShare mean a different thing per backend
  // and rows must be segmented, never pooled. Defaulting absent rows to
  // 'claude' would silently pool a Codex row into the Claude cohort.
  backend: text('backend'),
  memoryBlockBytes: integer('memory_block_bytes').notNull(),
  promptBytes: integer('prompt_bytes').notNull(),
  memoryShare: decimal('memory_share', { precision: 5, scale: 4 }).notNull(),
  // Per-section byte accounting for every block the runner's prompt builder
  // considers (see PromptSectionRecord in apps/runner/src/memory-digest-policy.ts):
  // name, bytes, whether it rendered, whether it was truncated. NULLABLE, same
  // discipline as backend/taskMatchDerivedBy above — a row from a runner that
  // predates this field genuinely does not have it, and defaulting to `[]`
  // would read as "every section was empty" rather than "unknown".
  sections: jsonb('sections').$type<Array<{ name: string; bytes: number; rendered: boolean; truncated: boolean }>>(),
}, (t) => ({
  workerBuildIdx: uniqueIndex('worker_prompt_composition_events_worker_build_idx').on(t.workerId, t.buildIndex),
  taskTsIdx: index('worker_prompt_composition_events_task_ts_idx').on(t.taskId, t.ts),
  policyArmIdx: index('worker_prompt_composition_events_policy_arm_idx').on(t.policyVersion, t.arm),
}));

/**
 * The task-area-prediction experiment's own rail — see
 * `packages/core/task-area-prediction.ts`.
 *
 * Deliberately NOT a widening of `worker_prompt_composition_events`. That table
 * is memory-digest-specific down to its `arm` union and half its columns; a
 * second experiment bolted onto it would make both cohorts' queries depend on
 * columns meaningless to the other. `docs/design/experiment-lifecycle.md` says
 * the same thing prospectively: a new experiment brings its own payload table.
 *
 * It is also where the prediction LIVES. There is no `predicted_path_area`
 * column on `tasks`, on purpose: `tasks.path_manifest` feeds path-overlap
 * serialisation and inferred `dependsOn`, and a prediction sitting next to it
 * on the same row is an invitation for a later change to read the wrong one.
 * Retrieval reads `predicted_paths` from here and nothing else does; dropping
 * this table reverts the experiment without touching a task row.
 *
 * One row per (task, policy_version). A retried task draws the same arm — the
 * randomiser hashes the task id, not the worker — so a second claim must not
 * write a second row, and a version bump must not overwrite the old cohort's.
 *
 * Nullable-not-defaulted discipline, same as the composition rail: a column
 * whose value is genuinely unknown for a row stays NULL rather than taking a
 * default that would encode an inference as data.
 */
export const taskAreaPredictionEvents = pgTable('task_area_prediction_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  // Stable experiment identity, stored rather than assumed: the salt includes
  // it, so a readout that filtered on policy_version alone could pool rows from
  // a future experiment that happened to reuse a version string.
  experimentId: text('experiment_id').notNull(),
  policyVersion: text('policy_version').notNull(),
  arm: text('arm').notNull().$type<'regex_paths' | 'neighbour_area'>(),
  // Recorded at assignment time, never reconstructed from `fraction` later —
  // the fraction can be reconfigured between the draw and the analysis.
  propensity: decimal('propensity', { precision: 5, scale: 4 }).notNull(),
  fraction: decimal('fraction', { precision: 5, scale: 4 }).notNull(),
  // The prediction: the capped union of the paths similar completed tasks
  // actually touched. ADVISORY — read by retrieval, by nothing else, and never
  // copied into tasks.path_manifest.
  predictedPaths: jsonb('predicted_paths').$type<string[]>().notNull(),
  // 'diff' or 'manifest' — which side of a neighbour these paths came from.
  predictedPathSource: text('predicted_path_source').notNull().$type<'diff' | 'manifest'>(),
  // The neighbours that actually contributed a path, most similar first.
  neighbourTaskIds: jsonb('neighbour_task_ids').$type<string[]>().notNull(),
  // Neighbours the store returned, BEFORE the similarity floor and the path
  // lookup — the denominator for "how often does the corpus have anything".
  neighboursConsidered: integer('neighbours_considered').notNull(),
  // Best similarity among them. NULL when the store returned nothing: zero
  // would claim a neighbour was found and scored 0.
  topScore: decimal('top_score', { precision: 6, scale: 5 }),
  // The SAME task's paths under the shipped regex (`inferPathsFromText`),
  // computed in the same run. Without this the overlap metric cannot say
  // whether the predictor beat what is already in production.
  regexPaths: jsonb('regex_paths').$type<string[]>().notNull(),
  // What the task's diff actually touched, written once at terminal worker
  // status. NULL until then — an unfinished task has no ground truth, and an
  // empty array would score as "predicted nothing correctly".
  actualPaths: jsonb('actual_paths').$type<string[]>(),
  actualRecordedAt: timestamp('actual_recorded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskPolicyIdx: uniqueIndex('task_area_prediction_events_task_policy_idx').on(t.taskId, t.policyVersion),
  // The readout's cohort scan: every row for a version, split by arm.
  policyArmIdx: index('task_area_prediction_events_policy_arm_idx').on(t.policyVersion, t.arm),
}));

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
  // Initiative-level artifacts (roadmap/spec) not tied to a specific mission.
  initiativeId: uuid('initiative_id').references(() => initiatives.id, { onDelete: 'set null' }),
  key: text('key'),
  type: text('type').notNull(),
  title: text('title'),
  content: text('content'),
  storageKey: text('storage_key'),
  shareToken: text('share_token'),
  // Access control: 'private' = only logged-in workspace members (default);
  // 'public' = anyone with the shareToken link. Set to 'public' only via an
  // explicit Share action, which also (re)generates the shareToken.
  visibility: text('visibility').$type<'private' | 'public'>().notNull().default('private'),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workerIdx: index('artifacts_worker_idx').on(t.workerId),
  shareTokenIdx: uniqueIndex('artifacts_share_token_idx').on(t.shareToken),
  workspaceIdx: index('artifacts_workspace_idx').on(t.workspaceId),
  workspaceKeyIdx: uniqueIndex('artifacts_workspace_key_idx').on(t.workspaceId, t.key),
  missionIdx: index('artifacts_mission_idx').on(t.missionId),
  initiativeIdx: index('artifacts_initiative_idx').on(t.initiativeId),
}));

/**
 * A human's decision on one visual-audit screenshot
 * (docs/design/visual-qa-human-review.md). Append-only: a new decision or an
 * undo sets `supersededAt` on the active row, then inserts. Kept out of
 * `artifacts.metadata.qa` on purpose: the auditor writes that field
 * (update_artifact) and could erase a human decision, and a human "looks
 * right" must never satisfy the auditor's issue → fixTaskId evidence rule.
 *
 * The partial unique index keeps at most one active review per artifact, so a
 * double tap cannot leave two (no db.transaction on neon-http).
 */
/**
 * Hosted (cloud) runner time, one row per attempt, written when the attempt's
 * run report arrives (POST /api/workers/[id]/artifacts with a
 * `cloud-run-report:*` key). The report artifact itself is one per worker and
 * a resumed attempt overwrites it, so the per-attempt seconds are kept here.
 * Read by the monthly roll-up (apps/web/src/lib/hosted-runner-usage-store.ts).
 * `startedAt`/`endedAt`: container running to exit, so a month boundary can
 * split an attempt between two months.
 */
export const runnerUsage = pgTable('runner_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  attempt: integer('attempt').notNull(),
  // packages/shared/src/runner-size.ts RUNNER_SIZES
  size: text('size').$type<'standard' | 'large'>().notNull(),
  runnerSeconds: integer('runner_seconds').notNull(),
  weightedRunnerSeconds: integer('weighted_runner_seconds').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workerAttemptIdx: uniqueIndex('runner_usage_worker_attempt_idx').on(t.workerId, t.attempt),
  workspaceEndedIdx: index('runner_usage_workspace_ended_idx').on(t.workspaceId, t.endedAt),
  taskIdx: index('runner_usage_task_idx').on(t.taskId),
}));

export const visualShotReviews = pgTable('visual_shot_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  artifactId: uuid('artifact_id').references(() => artifacts.id, { onDelete: 'cascade' }).notNull(),
  auditTaskId: uuid('audit_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  round: integer('round').notNull(),
  /** `route|viewport|variant`, the model's cell key (visual-review-model.ts). */
  cellKey: text('cell_key').notNull(),
  route: text('route').notNull(),
  viewport: text('viewport').$type<'mobile' | 'desktop'>().notNull(),
  /** The agent's verdict when the human decided: the stale guard compares it. */
  agentVerdict: text('agent_verdict').$type<'ok' | 'issue' | 'unsure'>().notNull(),
  decision: text('decision').$type<'looks_right' | 'needs_fix'>().notNull(),
  relation: text('relation').$type<'agree' | 'dispute' | 'waive'>().notNull(),
  note: text('note'),
  /** The `[surface fix]` task this decision filed. Never written to qa.fixTaskId. */
  fixTaskId: uuid('fix_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  /** The auditor's fix this decision cancelled (a waive), so undo can reopen it. */
  cancelledFixTaskId: uuid('cancelled_fix_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewerLabel: text('reviewer_label'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  missionActiveIdx: index('visual_shot_reviews_mission_idx').on(t.missionId, t.supersededAt),
  artifactIdx: index('visual_shot_reviews_artifact_idx').on(t.artifactId),
  oneActivePerArtifactIdx: uniqueIndex('visual_shot_reviews_one_active_per_artifact')
    .on(t.artifactId)
    .where(sql`superseded_at IS NULL`),
}));

// ── Evidence storage (docs/specs/byo-evidence-storage.md) ──────────────────

/**
 * BYO evidence storage backend configuration. Holds S3-compatible bucket
 * settings and verification state. Credentials are stored separately in `secrets`
 * with purpose `evidence_storage_credential`.
 */
export const evidenceBackends = pgTable('evidence_backends', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // Nullable: team-scoped default when null, workspace-specific override when set
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  // Provider type: s3, r2, s3_compatible, or buildd_default (env-configured)
  provider: text('provider').notNull().$type<'s3' | 'r2' | 's3_compatible' | 'buildd_default'>(),
  // S3 endpoint URL; set for s3_compatible and some r2 setups
  endpoint: text('endpoint'),
  // AWS region or equivalent
  region: text('region'),
  // Bucket name
  bucket: text('bucket').notNull(),
  // Object key prefix within the bucket
  prefix: text('prefix'),
  // Whether to use path-style addressing (required for some S3-compatible services)
  forcePathStyle: boolean('force_path_style').default(false).notNull(),
  // Foreign key to secrets table, purpose = evidence_storage_credential
  credentialSecretId: uuid('credential_secret_id').references(() => secrets.id, { onDelete: 'set null' }),
  // Server-side encryption: none | AES256 | aws:kms
  sse: text('sse').notNull().$type<'none' | 'AES256' | 'aws:kms'>().default('none'),
  // KMS key ID (set only when sse = aws:kms)
  kmsKeyId: text('kms_key_id'),
  // Retention policy: days to keep objects before deletion
  retentionDays: integer('retention_days').notNull().default(30),
  // Maximum bytes per task's evidence before dropping middle segments
  maxBytesPerTask: integer('max_bytes_per_task').notNull().default(8388608), // 8 MiB default
  // Backend health: unverified | ok | failing
  status: text('status').notNull().$type<'unverified' | 'ok' | 'failing'>().default('unverified'),
  // Last successful verification
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  // Last verification error message
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('evidence_backends_team_idx').on(t.teamId),
  workspaceTeamIdx: index('evidence_backends_workspace_team_idx').on(t.workspaceId, t.teamId),
}));

/**
 * Evidence objects: pointers to blobs in the configured evidence backend.
 * The actual content (logs, transcripts, test reports) lives in the bucket;
 * this table holds metadata, upload state, and indexing state.
 */
export const evidenceObjects = pgTable('evidence_objects', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  // Owner, exactly one of two shapes (CHECK evidence_objects_one_owner below):
  // a task run (task_id + root_task_id + worker_id, scout_run_id null), or a
  // Quality Scout run hosted on a runner (scout_run_id only; it has no task
  // or worker). Null only in the Scout shape.
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  // Root task in a retry chain; for lineage and grouping
  rootTaskId: uuid('root_task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }),
  // A runner-hosted Scout run's command log (artifact quality-scout-runner-host §4).
  scoutRunId: uuid('scout_run_id').references(() => qualityScoutRuns.id, { onDelete: 'cascade' }),
  // PR number if this evidence came from a CI failure on a buildd PR
  prNumber: integer('pr_number'),
  // Kind of evidence: command_output | test_report | ci_job_log | transcript | pr_diff
  kind: text('kind').notNull().$type<'command_output' | 'test_report' | 'ci_job_log' | 'transcript' | 'pr_diff'>(),
  // Foreign key to evidence_backends
  backendId: uuid('backend_id').references(() => evidenceBackends.id, { onDelete: 'set null' }),
  // Object key in the bucket (e.g., evidence/{workspaceId}/{rootTaskId}/{taskId}/{workerId}/{kind}/{ts}-{seq}.jsonl.gz)
  objectKey: text('object_key').notNull(),
  // Size in bytes
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  // SHA256 hash of the uncompressed object
  sha256: text('sha256'),
  // Upload state: pending | stored | failed | unreadable
  uploadState: text('upload_state').notNull().$type<'pending' | 'stored' | 'failed' | 'unreadable'>().default('pending'),
  // Indexing state: skipped | queued | indexed | failed
  indexState: text('index_state').notNull().$type<'skipped' | 'queued' | 'indexed' | 'failed'>().default('skipped'),
  // When the object will expire (created_at + retention_days)
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('evidence_objects_workspace_idx').on(t.workspaceId),
  taskIdx: index('evidence_objects_task_idx').on(t.taskId),
  rootTaskIdx: index('evidence_objects_root_task_idx').on(t.rootTaskId),
  workerIdx: index('evidence_objects_worker_idx').on(t.workerId),
  prNumberIdx: index('evidence_objects_pr_number_idx').on(t.prNumber),
  backendIdx: index('evidence_objects_backend_idx').on(t.backendId),
  // Task lineage: find all evidence for a task and its retry chain
  taskLineageIdx: index('evidence_objects_task_lineage_idx').on(t.workspaceId, t.rootTaskId, t.taskId),
  scoutRunIdx: index('evidence_objects_scout_run_idx').on(t.scoutRunId),
  oneOwner: check(
    'evidence_objects_one_owner',
    sql`(${t.scoutRunId} IS NULL AND ${t.taskId} IS NOT NULL AND ${t.rootTaskId} IS NOT NULL AND ${t.workerId} IS NOT NULL)
      OR (${t.scoutRunId} IS NOT NULL AND ${t.taskId} IS NULL AND ${t.rootTaskId} IS NULL AND ${t.workerId} IS NULL)`,
  ),
}));

// Mission notes — lightweight append-only feed for agent↔user communication
/**
 * Review feedback on a PR, captured for RETRIEVAL rather than for the activity
 * feed.
 *
 * Why this exists separately from `mission_notes`, which already records a
 * reviewer verdict: that row is a timeline entry. It is gated on the task having
 * a mission (dropping the majority of PR-owning workers), it holds no file path,
 * and it is not indexed for lookup. So the most valuable engineering context the
 * system produces — "a reviewer already objected to exactly this, on exactly
 * this file" — could not be surfaced to the next agent about to edit that file.
 *
 * The point is prevention. An objection retrieved BEFORE the code is written
 * avoids a round trip; the same objection read after review has already cost it.
 * That makes this the one corpus whose value does not depend on volume: a single
 * "don't use db.transaction() with the neon-http driver" is useful the first
 * time it is retrieved.
 *
 * Rows are facts about what a reviewer said. Nothing here is derived, scored, or
 * summarised — a later ingest step indexes `body` into the knowledge store and
 * that is where interpretation belongs.
 */
export const reviewFeedback = pgTable('review_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * GitHub's own id for the review or comment. UNIQUE, because the webhook is
   * lossy in both directions: it drops deliveries and it redelivers them. Dedupe
   * has to key on the upstream identity, not on our insert time.
   */
  githubId: text('github_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  /** Nullable: a review can arrive for a PR whose worker row we cannot resolve. */
  taskId: uuid('task_id'),
  workerId: uuid('worker_id'),
  repoFullName: text('repo_full_name').notNull(),
  prNumber: integer('pr_number').notNull(),
  /** Head SHA the review was submitted against — the code actually being judged. */
  headSha: text('head_sha'),
  /**
   * `review` is a top-level submission (carries a verdict, often no path);
   * `inline_comment` is anchored to a file and line, which is what makes it
   * retrievable by path.
   */
  kind: text('kind').notNull().$type<'review' | 'inline_comment'>(),
  state: text('state').$type<'approved' | 'changes_requested' | 'commented'>(),
  /** Repo-relative path this feedback is anchored to. Null for top-level reviews. */
  path: text('path'),
  line: integer('line'),
  /**
   * The diff hunk the comment was left on. Kept because an objection is often
   * unintelligible without the code it points at, and the hunk is the only
   * record of what that code looked like at the time.
   */
  diffHunk: text('diff_hunk'),
  body: text('body').notNull(),
  authorLogin: text('author_login'),
  authorType: text('author_type').notNull().$type<'user' | 'bot'>(),
  /** When GitHub recorded it, not when we did — the webhook can be hours late. */
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  githubIdUnique: uniqueIndex('review_feedback_github_id_unique').on(t.githubId),
  // The retrieval path: "what has a reviewer said about this file before".
  workspacePathIdx: index('review_feedback_workspace_path_idx').on(t.workspaceId, t.path),
  prIdx: index('review_feedback_pr_idx').on(t.workspaceId, t.prNumber),
  taskIdx: index('review_feedback_task_idx').on(t.taskId),
}));

export const missionNotes = pgTable('mission_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id'),
  workerId: uuid('worker_id'),
  // 'mcp' is a caller that is NOT tied to a running task — an external script or
  // agent hitting the API/MCP directly with an account token. 'agent' is a worker
  // acting from inside a task (actorLabel names the task). Keeping them distinct
  // is the point of this table: "System" must not absorb work a human or an
  // outside caller did to the mission.
  authorType: text('author_type').notNull().$type<'agent' | 'user' | 'system' | 'mcp'>(),
  type: text('type').notNull().$type<'decision' | 'question' | 'warning' | 'suggestion' | 'update' | 'reply' | 'guidance' | 'reviewer_approved' | 'reviewer_request_changes' | 'reviewer_escalated' | 'reviewer_superseded'>(),
  title: text('title').notNull(),
  body: text('body'),
  // Human-readable actor detail: user email, "task \"<title>\" (<id>)", account
  // name, or — for authorType='system' — the predicate that fired. Structured
  // separately from `body` so the UI can render it in the feed header rather
  // than requiring a reader to parse prose.
  actorLabel: text('actor_label'),
  // Groups repeated low-signal edits (config churn) from the same actor within a
  // short window into one row instead of one row per field per edit. Null means
  // "never collapse this entry" (status changes, task links, criteria edits).
  collapseKey: text('collapse_key'),
  collapseCount: integer('collapse_count').default(1).notNull(),
  replyTo: uuid('reply_to'),
  defaultChoice: text('default_choice'),
  status: text('status').notNull().default('open').$type<'open' | 'answered' | 'dismissed' | 'superseded'>(),
  // Human-attention disposition of an agent/outside-caller question note
  // (packages/core/needs-you.ts): only 'ask' reaches Needs You;
  // 'recovered' means a repair task owns it. NULL on every other note.
  disposition: text('disposition').$type<'ask' | 'recovered'>(),
  // Set when a retry opens the replacement PR. Kept on the superseded note so
  // the timeline remains an audit trail and can link to the successor.
  supersededByPrNumber: integer('superseded_by_pr_number'),
  // Worker ids this note's content has already been handed to (JSON array of
  // uuids). Delivery of user replies + mission guidance to a live agent is driven
  // off this: a note is selected for worker X only while X is absent from the
  // array, then X is appended. Without it every reply/guidance note was
  // re-injected on every 10s check-in, filling the task timeline with duplicates.
  // Mission-wide guidance still reaches each worker exactly once, which a single
  // global delivered_at flag could not express.
  deliveredTo: jsonb('delivered_to').default([]).$type<string[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  missionIdx: index('mission_notes_mission_idx').on(t.missionId),
  taskIdx: index('mission_notes_task_idx').on(t.taskId),
  replyToIdx: index('mission_notes_reply_to_idx').on(t.replyTo),
  typeIdx: index('mission_notes_type_idx').on(t.type),
  statusIdx: index('mission_notes_status_idx').on(t.status),
  collapseKeyIdx: index('mission_notes_collapse_key_idx').on(t.missionId, t.collapseKey, t.createdAt),
}));

// observations table removed — memory lives in the memories table below

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
  sandboxEnabled: boolean('sandbox_enabled'),
  sandboxProbeAt: timestamp('sandbox_probe_at', { withTimezone: true }),
  // The runner codebase's own git commit and package version — NOT a task
  // commit. Lets the platform tell "this instance is running pre-fix code"
  // from a merged PR alone, instead of requiring SSH into the host.
  runnerCommit: text('runner_commit'),
  runnerVersion: text('runner_version'),
  // The same live update-state the runner reports on its own local
  // /api/version — currentCommit is the commit the RUNNING process loaded
  // (cached at boot / last successful self-update), diskCommit is a fresh
  // `git rev-parse HEAD` read at heartbeat time; a mismatch (commitDrift)
  // means something rewrote the on-disk tree without restarting the runner.
  // All nullable: absent on a runner build that predates this field, or on a
  // heartbeat whose disk read failed — null means "unknown", not "clean".
  currentCommit: text('current_commit'),
  diskCommit: text('disk_commit'),
  commitDrift: boolean('commit_drift'),
  updating: boolean('updating'),
  updateAvailable: boolean('update_available'),
  // Set the moment updateAvailable first flips to true, cleared the moment it
  // stops being true — so "how long has it been behind" is measured from this
  // column instead of inferred from boot age or heartbeat cadence.
  updateAvailableSince: timestamp('update_available_since', { withTimezone: true }),
  // The branch this install tracks (BUILDD_BRANCH) — already sent on every
  // heartbeat to resolve latestCommit (see the heartbeat route), but not
  // persisted until now, so GET /api/workers/active can show it per runner.
  trackedBranch: text('tracked_branch'),
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
  lastDeferralReason: text('last_deferral_reason').$type<'concurrent_cap' | 'active_hours' | 'trigger_unchanged' | 'heartbeat_blocked' | 'heartbeat_no_change' | 'heartbeat_waiting' | 'heartbeat_criteria_blocked' | 'criteria_escalated' | 'orchestration_manual' | 'budget_exhausted' | 'heartbeat_circuit_breaker' | 'heartbeat_planning_backoff' | 'heartbeat_triage_wait' | 'heartbeat_not_stuck'>(),
  lastDeferredAt: timestamp('last_deferred_at', { withTimezone: true }),
  lastHeartbeatStateHash: text('last_heartbeat_state_hash'),
  lastOverdueAlertAt: timestamp('last_overdue_alert_at', { withTimezone: true }),
  pendingSuggestion: jsonb('pending_suggestion').$type<{
    cronExpression?: string;
    enabled?: boolean;
    reason: string;
    suggestedAt: string;
    suggestedByTaskId?: string;
    suggestedByWorkerId?: string;
  }>(),
  // Explicit cross-workspace reach for the tasks this schedule spawns
  // (packages/core/token-delegation.ts). Kept off taskTemplate on purpose:
  // the template is copied into each task, and nothing a task carries may
  // widen its own token. Null = no delegation (the default).
  delegation: jsonb('delegation').$type<ScheduleDelegation>(),
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
  // Who ran the install flow. Without this, an installation is only reachable
  // through workspaces that already point at it — so a user who installs the
  // App before creating any workspace can never select it. Set by
  // /api/github/callback (the only place with a session); null for installs
  // that predate the column.
  installedByUserId: uuid('installed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  installationIdIdx: uniqueIndex('github_installations_installation_id_idx').on(t.installationId),
  accountLoginIdx: index('github_installations_account_login_idx').on(t.accountLogin),
  installedByIdx: index('github_installations_installed_by_idx').on(t.installedByUserId),
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
// so the same PR head SHA or deploy ID doesn't spawn duplicate tasks. Insert-only
// by design: nothing selects these rows, the INSERT *failing* is the read, and
// the writer deletes the task it just created when that happens
// (apps/web/src/lib/health-watcher.ts). Pruned by age in
// /api/cron/task-archive — see WATCHER_EVENTS_RETENTION_DAYS for why the window
// is deliberately long.
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
// teamId (NOT NULL): owning team — mirrors the secrets/missions scoping model.
// workspaceId (NULLABLE): NULL = team-level role; non-null = workspace-specific override row.
export const workspaceSkills = pgTable('workspace_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id')
    .references(() => teams.id, { onDelete: 'cascade' })
    .notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
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
  model: text('model').$type<SkillModel>().notNull().default('inherit'),
  // Default agent backend for tasks routed to this role (a hint — an explicit task.backend wins).
  // null = no preference → falls back to 'claude'. Model selection stays independent: when this is
  // 'codex', the Claude-only `model` field above is ignored. See docs/credentials-architecture.md.
  defaultBackend: agentBackendEnum('default_backend'),
  allowedTools: jsonb('allowed_tools').notNull().default([]).$type<string[]>(), // empty = all tools
  canDelegateTo: jsonb('can_delegate_to').notNull().default([]).$type<string[]>(), // slugs of other skills
  background: boolean('background').notNull().default(false),
  maxTurns: integer('max_turns'), // null = unlimited
  color: text('color').notNull().default('#8A8478'), // avatar color hex
  // @deprecated Superseded by `connectorRefs` (connectors table). Kept for back-compat during
  // rollout; no longer read/written by new code and slated for removal in a follow-up migration.
  mcpServers: jsonb('mcp_servers').notNull().default({}).$type<Record<string, unknown> | string[]>(), // MCP server configs or legacy name array
  // @deprecated See `mcpServers` above — migrated to connectors; do NOT remove yet.
  requiredEnvVars: jsonb('required_env_vars').notNull().default({}).$type<Record<string, string>>(), // env var name → secret label mapping
  // IDs of connectors (connectors table) this role mounts — role-level opt-in to team connectors.
  connectorRefs: jsonb('connector_refs').notNull().default([]).$type<string[]>(),
  // Role-specific fields
  isRole: boolean('is_role').notNull().default(false), // distinguishes roles (Team page) from skills
  configHash: text('config_hash'), // SHA-256 of packaged tarball for cache invalidation
  configStorageKey: text('config_storage_key'), // R2 object key for role config tarball
  repoUrl: text('repo_url'), // for builder roles (git clone target)
  // Personal roles: the member who owns this row. NULL = a team role (the
  // default) or a workspace override. A personal row is always team-level
  // (workspaceId NULL) and its slug is unique per owner, not per team.
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  // Who may run a personal role: 'private' = its owner's tasks only; 'team' =
  // shared, anyone in the team. Team roles are always 'team'.
  visibility: text('visibility').notNull().default('team').$type<'private' | 'team'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // Team-level default: one (team, slug) when workspaceId IS NULL
  // Team-level namespace: one (team, slug) across team roles AND shared
  // personal roles, so two concurrent shares of one slug cannot both land.
  // Private personal rows are outside it (ownerSlugIdx covers them).
  teamSlugIdx: uniqueIndex('ws_skills_team_slug_idx').on(t.teamId, t.slug).where(sql`${t.workspaceId} IS NULL AND (${t.ownerUserId} IS NULL OR ${t.visibility} = 'team')`),
  // Personal roles: one (team, owner, slug)
  ownerSlugIdx: uniqueIndex('ws_skills_owner_slug_idx').on(t.teamId, t.ownerUserId, t.slug).where(sql`${t.ownerUserId} IS NOT NULL`),
  // Workspace override: one (workspace, slug) when workspaceId IS NOT NULL
  workspaceOverrideSlugIdx: uniqueIndex('ws_skills_workspace_slug_idx').on(t.workspaceId, t.slug).where(sql`${t.workspaceId} IS NOT NULL`),
  workspaceIdx: index('workspace_skills_workspace_idx').on(t.workspaceId),
  teamIdx: index('workspace_skills_team_idx').on(t.teamId),
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
  // The worker's classified exit cause at the terminal write (workers.exit_cause),
  // copied so an experiment readout can separate model-attributable failures
  // from infra ones without re-deriving which worker produced the row. NULL on
  // rows written before this column existed and on completions with no cause.
  // Free text on purpose: the classifier's vocabulary is still moving, and a
  // typed union here would turn every new cause into a schema change.
  exitCause: text('exit_cause'),
  // Which worker's terminal report wrote this row. No FK: workers are pruned by
  // the archive cron on a different cadence than outcomes, and a dangling id is
  // more useful to a readout than a cascade-deleted outcome.
  workerId: uuid('worker_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskIdx: index('task_outcomes_task_idx').on(t.taskId),
  createdIdx: index('task_outcomes_created_idx').on(t.createdAt),
  kindIdx: index('task_outcomes_kind_idx').on(t.kind),
}));

/**
 * Experiment registry — one row per declared experiment, scoped to a team.
 *
 * The row is the source of truth for the declaration (hypothesis, arms,
 * treatment share, policy version) and the decision. Nothing enrolls unless a
 * row with `status = 'running'` exists: with no row, every consumer behaves
 * exactly as it did before the registry existed. See
 * docs/design/model-routing-experiment.md and docs/design/experiment-lifecycle.md.
 *
 * `policyVersion` is part of the randomiser's salt
 * (packages/core/experiment-randomizer.ts), so bumping it re-randomises every
 * unit. Bump it when the meaning of an arm changes; never edit arm semantics
 * in place under a running version.
 */
export const experiments = pgTable('experiments', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // Stable, human-chosen handle. Unique per team so two teams can each run a
  // same-named experiment without colliding.
  key: text('key').notNull(),
  title: text('title').notNull(),
  hypothesis: text('hypothesis'),
  status: text('status').notNull().default('draft').$type<'draft' | 'running' | 'paused' | 'concluded'>(),
  // 'tier_pool': one row per tier model pool (tier_pools.experiment_id), so
  // pool draws share this table's salt and assignment rows. See
  // docs/design/tier-model-pools.md.
  kind: text('kind').notNull().$type<'model_routing' | 'tier_pool' | 'heartbeat_triage' | 'question_gate'>(),
  // Share of ELIGIBLE units drawn into the treatment arm. Resolved through
  // resolveEnrolmentFraction, so an out-of-range value runs the control rather
  // than enrolling everyone.
  treatmentFraction: real('treatment_fraction').notNull().default(0.5),
  policyVersion: integer('policy_version').notNull().default(1),
  // Kind-specific shape; for model_routing see ModelRoutingExperimentConfig in
  // packages/core/model-routing-experiment.ts.
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  visibility: text('visibility').notNull().default('admins').$type<'admins' | 'team'>(),
  decision: text('decision'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  concludedAt: timestamp('concluded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamKeyIdx: uniqueIndex('experiments_team_key_idx').on(t.teamId, t.key),
  // The claim-time lookup: "is there a running experiment of this kind for this team?"
  teamStatusKindIdx: index('experiments_team_status_kind_idx').on(t.teamId, t.status, t.kind),
}));

/**
 * One row per (experiment, task) — the arm a task was assigned, recorded at
 * claim time. Intent-to-treat: `arm` is what was drawn; `served` says whether
 * the treatment model actually ran (it may not, e.g. when the runner's client
 * is too old for it — the claim falls back to the control model rather than
 * deferring, so a capability gap cannot bias which tasks reach each arm).
 *
 * Unique on (experiment_id, task_id): a re-claimed task reuses its row, and a
 * retry/attempt task gets its own row carrying the arm INHERITED from its
 * parent (eligibility.inheritedFromTaskId), never a fresh draw.
 */
export const experimentAssignments = pgTable('experiment_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  experimentId: uuid('experiment_id').references(() => experiments.id, { onDelete: 'cascade' }).notNull(),
  // NULL only on a chat-turn assignment (tier pools), which sets message_id
  // instead; the CHECK below requires one of the two.
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  // Chat-turn assignments (kind 'tier_pool', surface 'chat'). One row per
  // served assistant turn; a turn chain reuses its first turn's arm.
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id').references(() => conversationMessages.id, { onDelete: 'cascade' }),
  // The randomisation unit: the mission when the task has one (tasks cluster
  // in missions, so the cluster is randomised), else the task itself; for a
  // chat turn, the conversation.
  unitType: text('unit_type').notNull().$type<'mission' | 'task' | 'conversation'>(),
  unitId: uuid('unit_id').notNull(),
  // 'control' | 'treatment' for the two-arm kinds; the tier_pool_arms id for
  // kind 'tier_pool' (also in arm_id, which carries the FK).
  arm: text('arm').notNull().$type<'control' | 'treatment' | (string & {})>(),
  armId: uuid('arm_id').references(() => tierPoolArms.id, { onDelete: 'set null' }),
  // tier_pools.allocation_version in effect at the draw.
  allocationVersion: integer('allocation_version'),
  // Recorded at assignment, never reconstructed from the fraction later.
  propensity: real('propensity').notNull(),
  policyVersion: integer('policy_version').notNull(),
  // Counterfactual: the model the router would have served with no experiment.
  defaultModel: text('default_model'),
  assignedModel: text('assigned_model'),
  served: boolean('served').notNull(),
  // Snapshot of the inputs eligibility was judged on (budget pressure, kind,
  // complexity, role slug, inheritance source).
  eligibility: jsonb('eligibility').$type<Record<string, unknown>>().notNull().default({}),
  runnerCliVersion: text('runner_cli_version'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  experimentTaskIdx: uniqueIndex('experiment_assignments_experiment_task_idx').on(t.experimentId, t.taskId),
  // NULLs are distinct, so the task index above leaves chat rows alone; this
  // one makes a replayed turn write one row.
  experimentMessageIdx: uniqueIndex('experiment_assignments_experiment_message_idx')
    .on(t.experimentId, t.messageId)
    .where(sql`${t.messageId} IS NOT NULL`),
  armIdx: index('experiment_assignments_arm_idx').on(t.armId),
  taskOrMessage: check(
    'experiment_assignments_task_or_message',
    sql`${t.taskId} IS NOT NULL OR ${t.messageId} IS NOT NULL`,
  ),
  // Readout scan: every row for an experiment/version, split by arm.
  experimentVersionArmIdx: index('experiment_assignments_experiment_version_arm_idx').on(t.experimentId, t.policyVersion, t.arm),
  taskIdx: index('experiment_assignments_task_idx').on(t.taskId),
}));

/**
 * One row per heartbeat triage look (apps/web/src/lib/heartbeat-triage.ts):
 * a decision model's wait/act pick before the organizer is dispatched.
 *
 * The heartbeat_triage experiment's payload table (per-experiment payloads
 * stay in their own tables, docs/design/experiment-lifecycle.md). `taskId` is
 * the organizer task the cycle dispatched, NULL when the look skipped it, so
 * the organizer's own outcome on the same state grades the pick. Kept out of
 * `tasks.context`, which the organizer can read.
 */
export const heartbeatTriageLooks = pgTable('heartbeat_triage_looks', {
  id: uuid('id').primaryKey().defaultRandom(),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'cascade' }).notNull(),
  scheduleId: uuid('schedule_id').references(() => taskSchedules.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  experimentId: uuid('experiment_id').references(() => experiments.id, { onDelete: 'set null' }),
  policyVersion: integer('policy_version'),
  arm: text('arm').$type<'control' | 'treatment'>(),
  promptVersion: text('prompt_version').notNull(),
  model: text('model'),
  pick: text('pick').$type<'wait' | 'act'>(),
  confidence: real('confidence'),
  skipped: boolean('skipped').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  missionCreatedIdx: index('heartbeat_triage_looks_mission_created_idx').on(t.missionId, t.createdAt),
  experimentArmIdx: index('heartbeat_triage_looks_experiment_arm_idx').on(t.experimentId, t.policyVersion, t.arm),
  taskIdx: index('heartbeat_triage_looks_task_idx').on(t.taskId),
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
  // A person's own key (inference_key, pushover_personal). NULL = not personal. `accountId`
  // can't hold this: accounts are API-key identities, not people. A personal row
  // serves only its owner — see packages/core/inference-keys.ts.
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull().$type<'anthropic_api_key' | 'oauth_token' | 'codex_credential' | 'claude_credential' | 'openai_api_key' | 'webhook_token' | 'custom' | 'mcp_credential' | 'vercel_token' | 'pushover' | 'notify_webhook' | 'mcp_connector_credential' | 'signing_key' | 'inference_key' | 'decision_key' | 'role_env_secret' | 'pushover_personal' | 'cloudflare_token' | 'agent_endpoint' | 'evidence_storage_credential' | 'cloudflare_gateway_token'>(),
  label: text('label'),
  encryptedValue: text('encrypted_value').notNull(),
  // Token lifecycle (set only for expiring/refreshing credentials: codex_credential, oauth_token).
  // tokenExpiresAt enables efficient "expiring soon" cron queries.
  // See docs/credentials-architecture.md.
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  // Last time a refresh actually SUCCEEDED — this is what the UI shows as
  // "Last refreshed". For claude_credential / codex_credential it is written only
  // on a successful commit; the refresh lock lives in refreshLockedAt below.
  // (mcp_connector_credential still uses this column as its own lock — see
  // lib/mcp-connector-refresh.ts. Converging the two is a follow-up.)
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
  // Refresh lock. Stamped by the atomic UPDATE that claims the right to call the
  // provider's token endpoint, so only one caller refreshes per 60-minute window.
  // Split out from lastRefreshedAt because one column cannot be both: a lock is
  // stamped on every *attempt*, which made a credential that fails every cycle
  // indistinguishable from one that is working.
  refreshLockedAt: timestamp('refresh_locked_at', { withTimezone: true }),
  // Set when a rotation goes in flight, cleared the moment its outcome is known
  // (success, revocation, or a provider error we actually received). A value still
  // present long afterwards therefore means we never learned the outcome — the
  // provider may have consumed the stored refresh token and issued a replacement
  // that we lost. Providers that rotate the refresh token on every use kill the
  // stored token in that case, so retrying is a guaranteed invalid_grant; the
  // refresh paths fail closed on a stale value instead of retrying into it.
  rotationStartedAt: timestamp('rotation_started_at', { withTimezone: true }),
  // Verification lifecycle (codex_credential only): the last time the credential was
  // smoke-tested against the real provider API, and the error string if it failed.
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  lastVerificationError: text('last_verification_error'),
  // Expiry-alert dedup: set when the team is notified that this credential has
  // expired (or is about to), cleared by the reconnect/refresh success paths so a
  // later expiry is a new episode. Read by /api/cron/connector-block-notify.
  expiryNotifiedAt: timestamp('expiry_notified_at', { withTimezone: true }),
  // mcp_connector_credential only: last time a refresh actually SUCCEEDED, as
  // distinct from lastRefreshedAt, which that path's optimistic lock still stamps
  // on every *attempt*. The claude_credential / codex_credential paths solve the
  // same problem with refreshLockedAt instead and leave this column NULL.
  lastRefreshSucceededAt: timestamp('last_refresh_succeeded_at', { withTimezone: true }),
  // Credential health — set by spawn-time auth failures and active verification.
  // healthy: last use/verify succeeded; degraded: ≥1 auth failure, < threshold;
  // revoked: explicit revocation or ≥3 consecutive auth failures; unknown: never tested.
  healthStatus: text('health_status').default('unknown').notNull().$type<'healthy' | 'degraded' | 'revoked' | 'unknown'>(),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  lastFailureMessage: text('last_failure_message'),
  consecutiveAuthFailures: integer('consecutive_auth_failures').default(0).notNull(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('secrets_team_idx').on(t.teamId),
  accountPurposeLabelIdx: uniqueIndex('secrets_account_purpose_label_idx').on(t.accountId, t.purpose, t.label),
  // Backend-auth credentials are singletons per scope: at most one row per
  // (team, account, workspace, purpose, label). NULLS NOT DISTINCT so team-wide
  // rows (account/workspace/label all NULL) collide instead of piling up — the
  // legacy index above treats NULLs as distinct, which let duplicate team-wide
  // oauth_token/codex rows accumulate and be picked nondeterministically at claim.
  // Partial (auth purposes only) so it never touches rotation-style secrets like
  // signing_key, which intentionally keep multiple rows.
  // NOTE: drizzle-kit (0.45.2) can't express `NULLS NOT DISTINCT`, so the generated
  // migration SQL is hand-edited to add it (see the migration that creates this
  // index). Without NULLS NOT DISTINCT, team-wide rows (NULL account/workspace/label)
  // would not collide and duplicates could still accumulate.
  scopedAuthCredentialIdx: uniqueIndex('secrets_scoped_auth_credential_idx')
    .on(t.teamId, t.accountId, t.workspaceId, t.purpose, t.label)
    .where(sql`${t.purpose} in ('oauth_token','anthropic_api_key','codex_credential','claude_credential')`),
  // One personal inference key per (team, user, provider label). Partial on
  // user_id IS NOT NULL so it binds only personal rows, which are new — it can't
  // fail on any pre-existing row. Team-scope rows stay singletons through
  // replaceScoped, as before. Personal keys are team-wide (workspace NULL) in P1.
  personalInferenceKeyIdx: uniqueIndex('secrets_personal_inference_key_idx')
    .on(t.teamId, t.userId, t.label)
    .where(sql`${t.purpose} = 'inference_key' and ${t.userId} is not null and ${t.workspaceId} is null`),
  userIdx: index('secrets_user_idx').on(t.userId),
}));


// ── Agent chat (knowledge-base: buildd/design/agent-chat.md) ───────────────────────────────────

// One conversation with the buildd agent. Same conversation on web and phone.
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // Default scope for tool calls. NULL = the creator's whole team.
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  // Auto-titled after the first exchange; read through conversationDisplayTitle.
  title: varchar('title', { length: 80 }),
  titleSource: text('title_source').default('auto').notNull().$type<'auto' | 'user'>(),
  agentRoleSlug: text('agent_role_slug').default('organizer').notNull(),
  // The chat tier this conversation is pinned to ('budget' | 'standard' |
  // 'premium'). NULL = routed per turn. A tier, never a model: the tier → model
  // mapping stays the team admin's.
  tier: text('tier').$type<'budget' | 'standard' | 'premium'>(),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userRecentIdx: index('conversations_user_recent_idx').on(t.createdByUserId, t.lastMessageAt),
  teamIdx: index('conversations_team_idx').on(t.teamId),
}));

// One saved message. `parts` are AI SDK UIMessage parts; tool parts carry their
// state and a ChatToolResult (BuilddObjectRef[]) — refs, never snapshots.
export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  role: text('role').notNull().$type<'user' | 'assistant' | 'event'>(),
  parts: jsonb('parts').notNull().$type<Array<{ type: string; [key: string]: unknown }>>(),
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  surface: text('surface').default('web').notNull().$type<'web' | 'slack' | 'discord' | 'teams'>(),
  tier: text('tier'),
  model: text('model'),
  usage: jsonb('usage').$type<{ inputTokens: number; outputTokens: number; costUsd: number | null; latencyMs?: number; routedWorkspaceId?: string }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  conversationCreatedIdx: index('conversation_messages_conversation_created_idx').on(t.conversationId, t.createdAt),
  // Recent messages by author (turn admission itself lives in chat_turn_windows).
  authorCreatedIdx: index('conversation_messages_author_created_idx').on(t.authorUserId, t.createdAt),
}));

// Chat session retro lessons (experiment; knowledge-base: buildd/design/chat-session-retro.md,
// code in apps/web/src/lib/chat-retro/, removal in its REMOVAL.md). One row per
// conversation window the daily pass looked at. Content-free by construction:
// every text column holds a label from a fixed vocabulary, a buildd tool name,
// a signature built from those, or a version string. No column can hold
// message, tool or model text. Written only for teams that opted in
// (teams.chatRetro.lessons); turning it off deletes the team's rows.
export const chatRetros = pgTable('chat_retros', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  /** The window: first and last message it covered. */
  fromMessageId: uuid('from_message_id'),
  toMessageId: uuid('to_message_id'),
  /** Watermark: createdAt of toMessageId. The next window starts after it. */
  toMessageAt: timestamp('to_message_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().$type<'skipped' | 'judged' | 'failed'>(),
  skipReason: text('skip_reason').$type<'trivial' | 'team_cap' | 'state_budget' | 'sensitive' | null>(),
  userTurns: integer('user_turns').notNull().default(0),
  turns: integer('turns').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd'),
  intent: text('intent'),
  intentConf: real('intent_conf'),
  satisfied: text('satisfied'),
  satisfiedConf: real('satisfied_conf'),
  wastedTurns: integer('wasted_turns').notNull().default(0),
  wastedTokens: integer('wasted_tokens').notNull().default(0),
  primaryCause: text('primary_cause'),
  fixClass: text('fix_class'),
  fixClassConf: real('fix_class_conf'),
  toolName: text('tool_name'),
  signature: text('signature'),
  /** Refs and labels only: { turn, messageId, kind, tokens, label, conf }. */
  evidence: jsonb('evidence').$type<Array<{ turn: number; messageId: string; kind: string; tokens: number; label: string | null; conf: number | null }>>().notNull().default([]),
  stateTokens: integer('state_tokens'),
  version: text('version').notNull(),
  latencyMs: integer('latency_ms'),
  jevCostUsd: real('jev_cost_usd'),
  /** Decision error kind when status = failed (timeout, provider_error, ...). */
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamCreatedIdx: index('chat_retros_team_created_idx').on(t.teamId, t.createdAt),
  conversationWatermarkIdx: index('chat_retros_conversation_watermark_idx').on(t.conversationId, t.toMessageAt),
  teamSignatureIdx: index('chat_retros_team_signature_idx').on(t.teamId, t.signature),
}));

// A write the agent proposed, awaiting the user's tap. Decided with an atomic
// UPDATE ... WHERE status = 'pending' RETURNING (no db.transaction on
// neon-http): only the caller whose update returns a row executes the tool, so
// a replayed or concurrent approval files nothing. `result` keeps what the
// execution returned, so a replay answers with it instead of re-running.
export const conversationApprovals = pgTable('conversation_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The AI SDK approval id (tool part `approval.id`) the client echoes back.
  approvalId: text('approval_id').notNull(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  messageId: uuid('message_id').references(() => conversationMessages.id, { onDelete: 'cascade' }).notNull(),
  toolCallId: text('tool_call_id').notNull(),
  toolName: text('tool_name').notNull(),
  // sha256 of the canonical tool input as proposed; an edited input doesn't match.
  inputHash: text('input_hash').notNull(),
  proposedForUserId: uuid('proposed_for_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  status: text('status').default('pending').notNull().$type<'pending' | 'approved' | 'denied' | 'expired'>(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  result: jsonb('result').$type<unknown>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  approvalIdIdx: uniqueIndex('conversation_approvals_approval_id_idx').on(t.approvalId),
  conversationIdx: index('conversation_approvals_conversation_idx').on(t.conversationId),
}));

// Chat turn admission: one row per user holding the start times of their turns
// in the current rate window. A turn is admitted by a single
// INSERT ... ON CONFLICT DO UPDATE ... WHERE <under the limit> RETURNING, which
// takes the row lock, so parallel requests are serialized and at most
// CHAT_RATE_LIMIT get a row back (no db.transaction on neon-http).
export const chatTurnWindows = pgTable('chat_turn_windows', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).primaryKey(),
  turnAt: timestamp('turn_at', { withTimezone: true }).array().notNull().default(sql`'{}'::timestamptz[]`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Chat directives: the person's standing rules ("always open PRs as drafts"),
// confirmed from a card in the thread or written in Settings, loaded into every
// one of their chat turns (packages/core/chat-directives.ts). Owned by the
// person, not the team: only they read or edit them. workspace_id NULL = every
// workspace; set = that workspace's turns only (gone with the workspace).
// Not in `memories`: that pool is team-scoped, retrieved by similarity and
// indexed for everyone, and these must be always-loaded and private.
export const chatDirectives = pgTable('chat_directives', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  // Where it came from: 'chat' (a confirmed card) or 'settings'. Provenance only.
  source: text('source').notNull().default('chat').$type<'chat' | 'settings'>(),
  // The assistant message whose card proposed it; null from Settings. No FK:
  // a deleted conversation leaves the rule in place.
  sourceMessageId: uuid('source_message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userCreatedIdx: index('chat_directives_user_created_idx').on(t.userId, t.createdAt),
  // One copy of a rule per person and scope, race-free: a double tap, a card
  // answered on two devices, or an edit into an existing rule hits this and
  // the write is a no-op (ON CONFLICT DO NOTHING). NULLS NOT DISTINCT makes
  // two "everywhere" copies (workspace_id NULL) collide too.
  userScopeTextUnique: unique('chat_directives_user_scope_text_unique').on(t.userId, t.workspaceId, t.text).nullsNotDistinct(),
}));

export type ChatDirectiveRow = typeof chatDirectives.$inferSelect;

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
// HNSW index on embedding is added in the migration SQL.
export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: text('source_id').notNull(),
  namespace: text('namespace').notNull(),
  corpus: text('corpus').notNull().$type<'memory' | 'code' | 'docs' | 'spec' | 'task' | 'artifact' | 'pr' | 'plan' | 'session' | 'initiative'>(),
  sourceType: text('source_type').notNull(),
  sourcePath: text('source_path'),
  sourceUrl: text('source_url'),
  content: text('content').notNull(),
  lexicalText: text('lexical_text'),
  // Stored generated column so lexical search ranks against a precomputed
  // tsvector instead of recomputing to_tsvector(...) per row on every query.
  // Expression MUST stay identical to the one it replaces.
  lexicalTsv: tsvectorType('lexical_tsv').generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(lexical_text, content))`,
  ),
  embedding: vectorType('embedding', { dimensions: 1024 }),
  embeddingModel: text('embedding_model'),
  metadata: jsonb('metadata').default({}).$type<Record<string, unknown>>().notNull(),
  contentHash: text('content_hash'),
  /** SHA-256 of the full source file content — same for every chunk of a file. Used to skip unchanged files on re-ingest. */
  fileHash: text('file_hash'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // Phase 1: recency + supersession
  sourceTs: timestamp('source_ts', { withTimezone: true }),
  isCurrent: boolean('is_current').notNull().default(true),
  supersededBy: text('superseded_by'),
  // Phase C (C2): retrieval-hit tracking — incremented fire-and-forget on query.
  hitCount: integer('hit_count').notNull().default(0),
  lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
}, (t) => ({
  namespaceIdx: index('knowledge_chunks_namespace_idx').on(t.namespace),
  sourceIdx: uniqueIndex('knowledge_chunks_source_idx').on(t.namespace, t.sourceId),
  contentHashIdx: index('knowledge_chunks_content_hash_idx').on(t.namespace, t.contentHash),
  entityRecencyIdx: index('knowledge_chunks_entity_recency_idx').on(t.namespace, t.isCurrent, t.sourceTs),
  lexicalTsvGinIdx: index('knowledge_chunks_lexical_tsv_gin_idx').using('gin', t.lexicalTsv),
}));

// Memory use ledger: one row per memory a retrieval returned, and how it
// reached the agent. Written fire-and-forget by retrieveMemory
// (packages/core/memory-retrieval.ts), one INSERT per retrieval.
//
// `via` is push (injected into a prompt or reply the agent did not ask for)
// or pull (the agent asked: recall, query_knowledge). `gatedBy` names the rule
// that retrieved the memory but kept it out of the output (score floor,
// handoff exclusion, cross-corpus cap); null means it was shown. `outcome` is
// filled after the task completes (used / ignored / contradicted) and is null
// until then. No FKs: the ledger must never make a claim fail, and it outlives
// the rows it points at.
export const memoryUses = pgTable('memory_uses', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').notNull(),
  workspaceId: uuid('workspace_id'),
  taskId: uuid('task_id'),
  workerId: uuid('worker_id'),
  /** knowledge_chunks.source_id in `{teamId}:memory`; null for a store (ILIKE) search hit. */
  chunkId: text('chunk_id'),
  memoryId: text('memory_id').notNull(),
  /** Which read path retrieved it; see MemoryCaller in packages/core/memory-retrieval.ts. */
  caller: text('caller').notNull(),
  via: text('via').notNull().$type<'push' | 'pull'>(),
  /** 1-based position in the retrieval's result list. */
  rank: integer('rank').notNull(),
  /** Store score; null for a store (ILIKE) search, which has no score. */
  score: real('score'),
  gatedBy: text('gated_by'),
  outcome: text('outcome').$type<'used' | 'ignored' | 'contradicted'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  memoryIdx: index('memory_uses_memory_idx').on(t.teamId, t.memoryId),
  taskIdx: index('memory_uses_task_idx').on(t.taskId),
  createdIdx: index('memory_uses_created_idx').on(t.createdAt),
}));

// Memory decision log: one row per Jev verdict on a memory decision
// (packages/core/memory-decisions.ts, knowledge-base: buildd/design/memory-done-right.md "Where
// Jev helps"). Every row carries the verdict, its confidence, what the current
// rule said and whether the verdict was acted on, so the offline readout
// (packages/core/scripts/memory-decision-readout.ts) can compare Jev, the rule
// and the use ledger's outcome per decision. Content-free: ids, labels and
// numbers only. Spend is also receipted in ai_usage (surface 'decision').
// Written after the response, so a failed insert costs log rows and nothing
// else. Only the team is a FK (cascade, like ai_usage): the other ids point at
// rows the log outlives, same as memory_uses. Pruned after 90 days by the
// memory-digest-guardrail cron (packages/core/memory-uses-retention.ts).
export const memoryDecisions = pgTable('memory_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id'),
  taskId: uuid('task_id'),
  /** The memory the verdict is about; null when none was written (a NOOP, a failed save). */
  memoryId: text('memory_id'),
  /** keep | type | update | use | relevance | promote | chat_tier | directive_scope. */
  decision: text('decision').notNull(),
  /** The decision's `version` (promptVersion|model|kit). */
  version: text('version').notNull(),
  mode: text('mode').notNull().$type<'live' | 'shadow'>(),
  /** Jev's answer as a label ('true'/'false' for a yes/no); null when the call failed. */
  verdict: text('verdict'),
  confidence: real('confidence'),
  /** The yes-probability of a yes/no answer; null for a choice. */
  probability: real('probability'),
  /** What the current rule decided (the caller's type, 'conflict', 'shown', ...). */
  rule: text('rule'),
  applied: boolean('applied').notNull().default(false),
  /** Error kind when the call failed open (timeout, provider_error, parse, ...). */
  error: text('error'),
  /** Which read path, for relevance verdicts (memory_uses.caller). */
  caller: text('caller'),
  latencyMs: integer('latency_ms'),
  costUsd: real('cost_usd'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamDecisionIdx: index('memory_decisions_team_decision_idx').on(t.teamId, t.decision, t.createdAt),
  taskIdx: index('memory_decisions_task_idx').on(t.taskId),
  memoryIdx: index('memory_decisions_memory_idx').on(t.memoryId),
  createdIdx: index('memory_decisions_created_idx').on(t.createdAt),
}));

// Phase 2: knowledge entities — canonical nodes for the entity graph.
// workspace_id doubles as a scope id (team or workspace depending on corpus).
export const knowledgeEntities = pgTable('knowledge_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: text('workspace_id').notNull(),
  kind: text('kind').notNull().$type<'file' | 'symbol' | 'heading' | 'pr' | 'task' | 'mission' | 'initiative' | 'wikilink' | 'concept' | 'feature' | 'component'>(),
  key: text('key').notNull(),
  canonicalName: text('canonical_name').notNull(),
  attributes: jsonb('attributes').default({}).$type<Record<string, unknown>>().notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceKindIdx: index('knowledge_entities_workspace_kind_idx').on(t.workspaceId, t.kind),
  workspaceKeyIdx: uniqueIndex('knowledge_entities_workspace_key_idx').on(t.workspaceId, t.kind, t.key),
}));

// Phase 2: entity aliases for fuzzy resolution without LLM.
export const entityAliases = pgTable('entity_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => knowledgeEntities.id, { onDelete: 'cascade' }),
  alias: text('alias').notNull(),
  source: text('source').notNull().default('system').$type<'scip' | 'system' | 'agent' | 'confirmed'>(),
}, (t) => ({
  entityAliasIdx: uniqueIndex('entity_aliases_entity_alias_idx').on(t.entityId, t.alias),
}));

// Phase 2: chunk↔entity junction — which entities does a chunk define/reference?
export const chunkEntities = pgTable('chunk_entities', {
  chunkSourceId: text('chunk_source_id').notNull(),
  namespace: text('namespace').notNull(),
  entityId: uuid('entity_id').notNull().references(() => knowledgeEntities.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('mentions').$type<'defines' | 'references' | 'mentions'>(),
}, (t) => ({
  pk: primaryKey({ columns: [t.chunkSourceId, t.namespace, t.entityId, t.role] }),
  entityIdx: index('chunk_entities_entity_idx').on(t.entityId),
}));

// Phase 2: unresolved entity refs — queued for auto-heal or one-tap confirm.
export const pendingEntityRefs = pgTable('pending_entity_refs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: text('workspace_id').notNull(),
  rawRef: text('raw_ref').notNull(),
  kindHint: text('kind_hint'),
  sourceChunkId: text('source_chunk_id'),
  source: text('source').$type<'agent' | 'ingest'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedEntityId: uuid('resolved_entity_id').references(() => knowledgeEntities.id),
}, (t) => ({
  workspaceIdx: index('pending_entity_refs_workspace_idx').on(t.workspaceId, t.resolvedAt),
}));

// Phase 3: directed edges between entities — the knowledge graph.
export const knowledgeEdges = pgTable('knowledge_edges', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: text('workspace_id').notNull(),
  fromEntityId: uuid('from_entity_id').notNull().references(() => knowledgeEntities.id, { onDelete: 'cascade' }),
  toEntityId: uuid('to_entity_id').notNull().references(() => knowledgeEntities.id, { onDelete: 'cascade' }),
  type: text('type').notNull().$type<'imports' | 'defines' | 'references' | 'produced' | 'implements' | 'supersedes' | 'references_doc' | 'relates_to' | 'outcome_of' | 'part_of'>(),
  weight: decimal('weight', { precision: 5, scale: 4 }).notNull().default('1.0'),
  sourceChunkId: text('source_chunk_id'),
  rule: text('rule').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceFromIdx: index('knowledge_edges_from_idx').on(t.workspaceId, t.fromEntityId),
  workspaceToIdx: index('knowledge_edges_to_idx').on(t.workspaceId, t.toEntityId),
  uniqueEdge: uniqueIndex('knowledge_edges_unique_idx').on(t.workspaceId, t.fromEntityId, t.toEntityId, t.type),
}));

// Workspace Knowledge Management v2 §3.2 — per-workspace ingest job queue.
// One queue for incremental (diff) and full runs. Enqueued by the GitHub
// webhook on merged PRs and on direct pushes to the default branch; diff jobs execute serverless via the contents API,
// full jobs (backfill / escalated large diffs) run on the runner fleet.
// Idempotent enqueue via the partial unique index on (workspace_id, sha, scope)
// — failed jobs (status = 'error') don't block a retry insert.
//
// Durability: every started job holds a lease (lease_owner / lease_expires_at,
// heartbeat_at). A row still 'running' past its lease has a dead executor and is
// reclaimed — requeued, or parked in 'error' after `attempts` hits the ceiling so
// the idempotency index stops blocking redelivery. See
// apps/web/src/lib/knowledge-ingest-lease.ts.
export const knowledgeIngestJobs = pgTable('knowledge_ingest_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  /** "owner/name" — denormalized so jobs survive repo re-binding. */
  repo: text('repo').notNull(),
  trigger: text('trigger').notNull().$type<'pr_merged' | 'push' | 'backfill' | 'manual' | 'scheduled' | 'repo_link'>(),
  /** Merge SHA (diff jobs) or target SHA (full jobs). */
  sha: text('sha'),
  prNumber: integer('pr_number'),
  scope: text('scope').notNull().$type<'diff' | 'full'>(),
  status: text('status').default('queued').notNull().$type<'queued' | 'running' | 'done' | 'error'>(),
  /**
   * File paths considered by this job (kept + deleted), for the health UI.
   * A `push` job is seeded with its docs paths at enqueue (the push payload is
   * the only record of them) and the executor reads them back from here.
   */
  changedFiles: jsonb('changed_files').$type<string[]>(),
  /** Run stats: filesIngested / filesSkipped / filesDeleted / chunksUpserted / escalated… */
  stats: jsonb('stats').$type<Record<string, unknown>>(),
  error: text('error'),
  /**
   * Lease holder while status='running': the claiming runner's account/runner id,
   * or 'serverless' for the webhook's inline diff executor. NULL on legacy rows
   * (pre-lease) — those stay governed by `started_at`, never treated as leased.
   */
  leaseOwner: text('lease_owner'),
  /**
   * Lease TTL. A row still 'running' past this has a dead executor and is
   * reclaimable (see knowledge-ingest-lease.ts). Extended by /files batches.
   */
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  /** Last proof of forward progress: set on claim, on every batch, and on requeue. */
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  /** Reclaim attempts consumed. At MAX_INGEST_ATTEMPTS the job is parked in 'error'. */
  attempts: integer('attempts').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  workspaceStatusIdx: index('knowledge_ingest_jobs_ws_status_idx').on(t.workspaceId, t.status),
  // Reclaim scan: find rows with a lapsed lease without scanning the whole table.
  leaseExpiresAtIdx: index('knowledge_ingest_jobs_lease_expires_at_idx').on(t.leaseExpiresAt),
  // Idempotent enqueue: one non-errored job per (workspace, sha, scope).
  idempotencyIdx: uniqueIndex('knowledge_ingest_jobs_ws_sha_scope_idx')
    .on(t.workspaceId, t.sha, t.scope)
    .where(sql`${t.status} != 'error'`),
  // At most one active (queued or running) full job per workspace+repo — prevents
  // concurrent diff webhooks from stacking multiple backfill/escalation jobs.
  activeFullIdx: uniqueIndex('knowledge_ingest_jobs_active_full_idx')
    .on(t.workspaceId, t.repo)
    .where(sql`${t.scope} = 'full' AND ${t.status} IN ('queued', 'running')`),
}));

// Reverts recorded from GitHub: a merged PR whose title/body reverts another
// PR, or a commit (on the branch a push or CI run reports) whose message
// reverts a commit. One row per reference per bound workspace; parsed by
// packages/core/pr-reverts.ts. Read by promotionCandidatesQuery
// (packages/core/memory-lifecycle.ts): a candidate memory whose source PR, or
// its merge sha, was reverted is never auto-promoted.
export const prReverts = pgTable('pr_reverts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  /** "owner/name". */
  repo: text('repo').notNull(),
  /** What did the reverting: `pr#N` for a merged PR, else the commit sha. */
  revertedBy: text('reverted_by').notNull(),
  /** The PR it names as reverted; null for a commit reference. */
  revertedPrNumber: integer('reverted_pr_number'),
  /** The commit it names as reverted (lowercase, possibly abbreviated); null for a PR reference. */
  revertedSha: text('reverted_sha'),
  /** `${revertedBy}>${reference}`: a redelivered webhook inserts nothing new. */
  dedupeKey: text('dedupe_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceDedupeIdx: uniqueIndex('pr_reverts_workspace_dedupe_idx').on(t.workspaceId, t.dedupeKey),
  workspacePrIdx: index('pr_reverts_workspace_pr_idx').on(t.workspaceId, t.revertedPrNumber),
}));

// Relations
export const teamsRelations = relations(teams, ({ many }) => ({
  members: many(teamMembers),
  accounts: many(accounts),
  workspaces: many(workspaces),
  missions: many(missions),
  initiatives: many(initiatives),
  invitations: many(teamInvitations),
  workspaceSkills: many(workspaceSkills),
  connectors: many(connectors),
  memories: many(memories),
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
  initiative: one(initiatives, { fields: [missions.initiativeId], references: [initiatives.id] }),
  dependsOnMission: one(missions, { fields: [missions.dependsOnMissionId], references: [missions.id], relationName: 'dependentMissions' }),
  dependentMissions: many(missions, { relationName: 'dependentMissions' }),
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
  initiatives: many(initiatives),
  githubRepo: one(githubRepos, { fields: [workspaces.githubRepoId], references: [githubRepos.id] }),
  githubInstallation: one(githubInstallations, { fields: [workspaces.githubInstallationId], references: [githubInstallations.id] }),
  connectorWorkspaces: many(connectorWorkspaces),
  specDiscrepancies: many(specDiscrepancies),
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
  subjectReports: many(taskSubjectReports),
  subjectClaims: many(taskSubjectClaims),
}));

export const taskSubjectReportsRelations = relations(taskSubjectReports, ({ one }) => ({
  task: one(tasks, { fields: [taskSubjectReports.taskId], references: [tasks.id] }),
  reporter: one(accounts, { fields: [taskSubjectReports.reporterId], references: [accounts.id] }),
}));

export const taskSubjectClaimsRelations = relations(taskSubjectClaims, ({ one }) => ({
  workspace: one(workspaces, { fields: [taskSubjectClaims.workspaceId], references: [workspaces.id] }),
  canonicalTask: one(tasks, { fields: [taskSubjectClaims.canonicalTaskId], references: [tasks.id] }),
}));

export const specDiscrepanciesRelations = relations(specDiscrepancies, ({ one }) => ({
  workspace: one(workspaces, { fields: [specDiscrepancies.workspaceId], references: [workspaces.id] }),
  promotedMission: one(missions, { fields: [specDiscrepancies.promotedMissionId], references: [missions.id] }),
  docFixTask: one(tasks, { fields: [specDiscrepancies.docFixTaskId], references: [tasks.id] }),
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
  initiative: one(initiatives, { fields: [artifacts.initiativeId], references: [initiatives.id] }),
}));

export const initiativesRelations = relations(initiatives, ({ one, many }) => ({
  team: one(teams, { fields: [initiatives.teamId], references: [teams.id] }),
  workspace: one(workspaces, { fields: [initiatives.workspaceId], references: [workspaces.id] }),
  createdByUser: one(users, { fields: [initiatives.createdByUserId], references: [users.id] }),
  ownerUser: one(users, { fields: [initiatives.ownerUserId], references: [users.id] }),
  missions: many(missions),
  artifacts: many(artifacts),
}));

export const evidenceBackendsRelations = relations(evidenceBackends, ({ one }) => ({
  team: one(teams, { fields: [evidenceBackends.teamId], references: [teams.id] }),
  workspace: one(workspaces, { fields: [evidenceBackends.workspaceId], references: [workspaces.id] }),
  credentialSecret: one(secrets, { fields: [evidenceBackends.credentialSecretId], references: [secrets.id] }),
}));

export const evidenceObjectsRelations = relations(evidenceObjects, ({ one }) => ({
  workspace: one(workspaces, { fields: [evidenceObjects.workspaceId], references: [workspaces.id] }),
  task: one(tasks, { fields: [evidenceObjects.taskId], references: [tasks.id] }),
  rootTask: one(tasks, { fields: [evidenceObjects.rootTaskId], references: [tasks.id] }),
  worker: one(workers, { fields: [evidenceObjects.workerId], references: [workers.id] }),
  backend: one(evidenceBackends, { fields: [evidenceObjects.backendId], references: [evidenceBackends.id] }),
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
  team: one(teams, { fields: [workspaceSkills.teamId], references: [teams.id] }),
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

export const secretsRelations = relations(secrets, ({ one, many }) => ({
  team: one(teams, { fields: [secrets.teamId], references: [teams.id] }),
  account: one(accounts, { fields: [secrets.accountId], references: [accounts.id] }),
  workspace: one(workspaces, { fields: [secrets.workspaceId], references: [workspaces.id] }),
  lease: many(credentialLeases),
}));

// Per-credential lease: exactly one broker may hold a given credential's lease at a time.
// The unique index on credential_id is the DB-level enforcement — a second runner racing
// for the same lease gets 0 rows back from the conditional INSERT ON CONFLICT and backs off.
// The broker renews the lease via heartbeat every 60s (TTL = 5 min), so stale leases from
// crashed brokers expire naturally within 5 minutes and become acquirable again.
export const credentialLeases = pgTable('credential_leases', {
  id: uuid('id').primaryKey().defaultRandom(),
  credentialId: uuid('credential_id')
    .notNull()
    .references(() => secrets.id, { onDelete: 'cascade' }),
  heldByRunnerId: text('held_by_runner_id').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  // Broker extends this every heartbeat; if it lapses, a competing runner may steal the lease.
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  credentialIdUniq: uniqueIndex('credential_leases_credential_id_uniq').on(t.credentialId),
  expiresAtIdx: index('credential_leases_expires_at_idx').on(t.expiresAt),
}));

export const credentialLeasesRelations = relations(credentialLeases, ({ one }) => ({
  credential: one(secrets, { fields: [credentialLeases.credentialId], references: [secrets.id] }),
}));

export type CredentialLease = typeof credentialLeases.$inferSelect;
export type NewCredentialLease = typeof credentialLeases.$inferInsert;


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
  connectorBlocked: boolean('connector_blocked').default(true).notNull(),
  artifactReady: boolean('artifact_ready').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: uniqueIndex('notification_preferences_team_idx').on(t.teamId),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  team: one(teams, { fields: [notificationPreferences.teamId], references: [teams.id] }),
}));

// ── Subscriptions and the delivery ledger (knowledge-base: buildd/design/subscriptions-and-notifications.md) ──
//
// A subscription is "who wants to hear about what". Exactly one owner column is
// set: a person (owner_user_id), a waiting worker (owner_task_id) or an MCP
// session (owner_account_id). Never hard-deleted: ending a watch stamps
// ended_at, so its ledger rows (cascade on delete) survive as the record.
// Written and read through apps/web/src/lib/subscriptions.ts only.
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // The subject's workspace. Scoping is re-checked against it on every event.
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  ownerTaskId: uuid('owner_task_id').references(() => tasks.id, { onDelete: 'cascade' }),
  ownerAccountId: uuid('owner_account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  // Origin conversation: where a chat-created watch reports back.
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  subjectKind: text('subject_kind').notNull().$type<'task' | 'pr'>(),
  // Match key: the task id, or `owner/repo#N` lowercased for a PR.
  subjectKey: text('subject_key').notNull(),
  subjectRef: jsonb('subject_ref').notNull().$type<Record<string, unknown>>(),
  eventTypes: text('event_types').array().notNull(),
  lifetime: text('lifetime').default('one_shot').notNull().$type<'one_shot' | 'standing'>(),
  createdVia: text('created_via').notNull().$type<'chat' | 'mcp' | 'worker' | 'settings'>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endReason: text('end_reason').$type<'delivered' | 'cancelled'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  exactlyOneOwner: check('subscriptions_exactly_one_owner', sql`num_nonnulls(${t.ownerUserId}, ${t.ownerTaskId}, ${t.ownerAccountId}) = 1`),
  subjectIdx: index('subscriptions_subject_idx').on(t.subjectKind, t.subjectKey).where(sql`${t.endedAt} IS NULL`),
  ownerUserIdx: index('subscriptions_owner_user_idx').on(t.ownerUserId).where(sql`${t.ownerUserId} IS NOT NULL`),
  ownerTaskIdx: index('subscriptions_owner_task_idx').on(t.ownerTaskId).where(sql`${t.ownerTaskId} IS NOT NULL`),
  ownerAccountIdx: index('subscriptions_owner_account_idx').on(t.ownerAccountId).where(sql`${t.ownerAccountId} IS NOT NULL`),
}));

// The delivery ledger, and the inbox. One row per (subscription, event): the
// unique index is the dedupe, so two emitters that see the same fact (webhook
// and reconcile sweep) write one row. Every channel reads from here.
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'cascade' }).notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  eventType: text('event_type').notNull(),
  // Refs and short text only; no prose from a sensitive workspace.
  payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
  urgency: text('urgency').default('normal').notNull().$type<'low' | 'normal' | 'urgent'>(),
  route: text('route'),
  status: text('status').default('pending').notNull()
    .$type<'pending' | 'delivered' | 'read' | 'coalesced' | 'held' | 'dropped' | 'failed'>(),
  attempts: integer('attempts').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
}, (t) => ({
  subscriptionDedupeIdx: uniqueIndex('notification_deliveries_subscription_dedupe_idx').on(t.subscriptionId, t.dedupeKey),
  pendingIdx: index('notification_deliveries_pending_idx').on(t.subscriptionId, t.createdAt).where(sql`${t.status} = 'pending'`),
}));

// User feedback on AI-generated content (thumbs up/down + dismiss)
export const userFeedback = pgTable('user_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  entityType: text('entity_type').notNull().$type<'note' | 'artifact' | 'summary' | 'orchestration' | 'heartbeat' | 'conversation_message'>(),
  entityId: text('entity_id').notNull(),
  signal: text('signal').notNull().$type<'up' | 'down' | 'dismiss'>(),
  comment: text('comment'),
  // Thumbs-down reason on a chat turn: one of CHAT_FEEDBACK_REASONS in
  // packages/core/tier-pool.ts. A label, never free text.
  reason: text('reason').$type<'wrong_answer' | 'wrong_action' | 'made_up' | 'ignored_me' | 'too_slow'>(),
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

// Per-user snooze on a Home/Activity action-queue gate card (MERGE/REVIEW).
// Keyed on the item's subjectKey (see lib/action-queue.ts's ActionQueueItem)
// rather than a PR or task id, since that's the same dedupe key the queue
// itself already uses and survives whichever raw source (escalation vs.
// waitingOnYou) produced the row. snoozedUntil is re-checked against `now` on
// every queue build (lib/action-queue.ts buildActionQueue) — never trusted as
// a standing flag — so an expired snooze silently stops applying.
export const actionQueueSnoozes = pgTable('action_queue_snoozes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  subjectKey: text('subject_key').notNull(),
  snoozedUntil: timestamp('snoozed_until', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userSubjectIdx: uniqueIndex('action_queue_snoozes_user_subject_idx').on(t.userId, t.subjectKey),
  teamIdx: index('action_queue_snoozes_team_idx').on(t.teamId),
}));

export const actionQueueSnoozesRelations = relations(actionQueueSnoozes, ({ one }) => ({
  user: one(users, { fields: [actionQueueSnoozes.userId], references: [users.id] }),
  team: one(teams, { fields: [actionQueueSnoozes.teamId], references: [teams.id] }),
}));

// System cache — generic key-value store for cached data (model lists, etc.)
export const systemCache = pgTable('system_cache', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

// Versioned prompt text (packages/core/prompts.ts). An active row replaces the
// public default compiled into the repo for prompt `id`; with no active row the
// default runs. Rows are append-only versions; at most one is active per id.
// `content_hash` is the sha256 hex of `body`; the loader skips a row whose hash
// does not match. Read in-process by packages/core/prompts-source.ts, never per call.
export const prompts = pgTable('prompts', {
  id: text('id').notNull(),
  version: integer('version').notNull(),
  contentHash: text('content_hash').notNull(),
  body: text('body').notNull(),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.id, t.version] }),
  oneActivePerIdIdx: uniqueIndex('prompts_one_active_per_id').on(t.id).where(sql`${t.active}`),
}));

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

// Provider pause log — one row per observed budget/rate-limit (or auth) wall on
// a specific agent backend. Append-only: the active pause for a backend is the
// newest row whose resetsAt is still in the future. Rows are pruned lazily.
//
// Why a per-backend table rather than more columns on accounts: each provider
// has its own pool. Before this table a Codex rate-limit was recorded on
// accounts.budgetExhaustedAt (the Claude/OAuth pool), so one provider running
// dry paused the other and failover had nowhere to go. Failover reads this to
// pick a backend that is not itself walled — see apps/web/src/lib/backend-failover.ts.
export const backendPauses = pgTable('backend_pauses', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // Provenance only — a provider pool is team-wide, so reads are not scoped by
  // workspace. Kept for "which workspace hit the wall" in the UI/debugging.
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  backend: agentBackendEnum('backend').notNull(),
  /** 'budget' (session/rate-limit) | 'auth' (credential rejected). */
  reason: text('reason').notNull().default('budget'),
  resetsAt: timestamp('resets_at', { withTimezone: true }).notNull(),
  sourceWorkerId: uuid('source_worker_id').references(() => workers.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  activeIdx: index('backend_pauses_team_backend_resets_idx').on(t.teamId, t.backend, t.resetsAt),
}));

export const backendPausesRelations = relations(backendPauses, ({ one }) => ({
  team: one(teams, { fields: [backendPauses.teamId], references: [teams.id] }),
  workspace: one(workspaces, { fields: [backendPauses.workspaceId], references: [workspaces.id] }),
}));

// OAuth budget episodes — one row per observed session/budget exhaustion on a
// seat-based (OAuth) account, recording how much work the window actually held.
// Seat auth reports no cost, so this is the only usable signal for "how many
// workers/turns/tokens does this account get per 5h window". The claim route
// learns a conservative capacity from the recent rows and paces claims against
// it (packages/core/oauth-budget.ts) instead of discovering the wall by hitting
// it. Written by the first worker report that flips accounts.budgetExhaustedAt,
// so concurrent budget failures produce exactly one episode.
export const oauthBudgetEpisodes = pgTable('oauth_budget_episodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }).notNull(),
  /** Start of the window this episode measured (previous resetsAt, or exhaustedAt - 5h). */
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  exhaustedAt: timestamp('exhausted_at', { withTimezone: true }).notNull(),
  /** When the window was expected to reopen — also marks the next window's start. */
  resetsAt: timestamp('resets_at', { withTimezone: true }),
  workerCount: integer('worker_count').default(0).notNull(),
  turns: integer('turns').default(0).notNull(),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  /**
   * Sonnet-equivalent totals (MODEL_WEIGHTS in packages/core/oauth-budget.ts).
   * A window is consumed by cost, not raw counts — 300 opus turns eat ~5x the
   * window that 300 haiku turns do — so capacity is learned in weighted units
   * and stays valid when the model mix changes. Raw columns are kept alongside
   * for auditability. 0 means "not weighted" (pre-weighting rows) and is
   * dropped by the learner rather than treated as a real ceiling.
   */
  weightedTurns: integer('weighted_turns').default(0).notNull(),
  weightedTokens: integer('weighted_tokens').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountExhaustedIdx: index('oauth_budget_episodes_account_exhausted_idx').on(t.accountId, t.exhaustedAt),
}));

export const oauthBudgetEpisodesRelations = relations(oauthBudgetEpisodes, ({ one }) => ({
  account: one(accounts, { fields: [oauthBudgetEpisodes.accountId], references: [accounts.id] }),
}));

// Codex auth now lives in the unified `secrets` table (purpose='codex_credential').
// See docs/credentials-architecture.md. The legacy per-workspace codex_credentials
// table was dropped in migration 0047 (no rows existed).

// ── Cron run history ─────────────────────────────────────────────────────────
//
// Every scheduled sweep already computes a verdict on its own work — how many
// rows it looked at, how many it changed, how many calls failed — and every one
// of them threw that verdict away at the route boundary. Three PR sweeps ran
// hourly for months returning "errors on every row, nothing changed", which is
// a complete description of an outage that nothing was in a position to read
// (PR #2125). This table is where the verdict lands so a trend can be checked.
//
// `changed` is the load-bearing column. A sweep with nothing to do and a sweep
// that cannot do anything both report processed=0; only `errors` and `changed`
// together separate healthy idle from total failure.
export const cronRuns = pgTable('cron_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Route slug, optionally with a scope suffix ('pr-reconcile:merge-state'),
  // because two cadences of one route are two different health signals.
  job: text('job').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  // Did the handler return without throwing. A false here is a harder failure
  // than a non-zero `errors`: the sweep did not finish at all.
  ok: boolean('ok').notNull(),
  // Normalized verdict. Null means the route reported nothing — still a useful
  // heartbeat, but it cannot participate in the health check.
  processed: integer('processed'),
  changed: integer('changed'),
  errors: integer('errors'),
  // The route's own result object, verbatim, for when the normalized numbers
  // say something is wrong but not what.
  result: jsonb('result').$type<Record<string, unknown>>(),
  error: text('error'),
  // Set on the run that fired an alert, so the next few runs stay quiet
  // instead of paging hourly forever.
  alertedAt: timestamp('alerted_at', { withTimezone: true }),
}, (t) => ({
  // Serves the health window query and the per-job retention delete.
  jobStartedIdx: index('cron_runs_job_started_idx').on(t.job, t.startedAt),
}));

// ── OAuth (MCP connector for claude.ai and other MCP clients) ────────────────
// Implements OAuth 2.1 with PKCE. Two token shapes, told apart by which of
// workspace_id / grant_id the code or refresh token carries (exactly one):
//  - legacy: the JWT carries the one workspaceId picked during /authorize, and
//    /api/mcp-oauth/[workspace] rejects tokens whose claim doesn't match the
//    path. Acts as the person (an implicit single-workspace 'person' grant).
//  - grant: the JWT carries a grant_id into mcp_oauth_grants. The workspaces it
//    reaches are resolved server-side on every request as the grant's
//    workspaces ∩ the user's CURRENT team memberships (apps/web/src/lib/mcp-grants.ts),
//    never read from the token. docs/specs/auth-oauth-boundaries.md.
// Refresh tokens rotate on use.

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
  // Legacy single-workspace code. Exactly one of workspaceId / grantId is set.
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  grantId: uuid('grant_id').references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  scope: text('scope'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  expiresIdx: index('oauth_codes_expires_at_idx').on(t.expiresAt),
  oneBinding: check('oauth_codes_one_binding', sql`num_nonnulls(${t.workspaceId}, ${t.grantId}) = 1`),
}));

export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  // SHA-256 (hex) of the refresh token. The token itself is never stored; it
  // is looked up by its hash (apps/web/src/lib/oauth/storage.ts). The column
  // keeps its original name so existing rows were hashed in place.
  tokenHash: text('token').primaryKey(),
  // One family per sign-in: set at the authorization-code exchange and carried
  // by every rotated token. Presenting an already-rotated token revokes the
  // family. `familyIssuedAt` is the sign-in time; the family's absolute
  // lifetime counts from it (REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS).
  familyId: uuid('family_id').defaultRandom().notNull(),
  familyIssuedAt: timestamp('family_issued_at', { withTimezone: true }).defaultNow().notNull(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  // Legacy single-workspace token. Exactly one of workspaceId / grantId is set.
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  // The grant this token refreshes. The grant's workspaces and acts-as kind
  // live on the grant row, so a refresh can never widen or change them.
  grantId: uuid('grant_id').references(() => mcpOauthGrants.id, { onDelete: 'cascade' }),
  scope: text('scope'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  expiresIdx: index('oauth_refresh_tokens_expires_at_idx').on(t.expiresAt),
  userWorkspaceIdx: index('oauth_refresh_tokens_user_workspace_idx').on(t.userId, t.workspaceId),
  grantIdx: index('oauth_refresh_tokens_grant_idx').on(t.grantId),
  familyIdx: index('oauth_refresh_tokens_family_idx').on(t.familyId),
  oneBinding: check('oauth_refresh_tokens_one_binding', sql`num_nonnulls(${t.workspaceId}, ${t.grantId}) = 1`),
}));

/** Who a grant's requests act as. 'person': the signed-in user (a `human:`
 * principal, person-only actions allowed). 'agent': the user's agent
 * (attributed to the user, never a person principal). Chosen at consent; the
 * owner may later downgrade 'person' to 'agent' in Settings, never the reverse
 * (that needs a fresh consent). A legacy workspace-claim token counts as 'person'. */
export type McpGrantActsAs = 'person' | 'agent';
export type McpGrantScope = 'read' | 'write';

/**
 * An account-level MCP OAuth grant: one user's consent for one client to reach
 * a chosen set of workspaces. Tokens carry only the grant id; the workspaces
 * are the child rows, intersected with the user's current team memberships on
 * every request (apps/web/src/lib/mcp-grants.ts). New workspaces are never
 * added implicitly.
 */
export const mcpOauthGrants = pgTable('mcp_oauth_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  clientId: text('client_id').references(() => oauthClients.clientId, { onDelete: 'cascade' }).notNull(),
  actsAs: text('acts_as').notNull().$type<McpGrantActsAs>(),
  scopes: jsonb('scopes').$type<McpGrantScope[]>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  userIdx: index('mcp_oauth_grants_user_idx').on(t.userId),
  actsAsValid: check('mcp_oauth_grants_acts_as_valid', sql`${t.actsAs} in ('person', 'agent')`),
  scopesValid: check('mcp_oauth_grants_scopes_valid', sql`jsonb_typeof(${t.scopes}) = 'array' and jsonb_array_length(${t.scopes}) > 0 and ${t.scopes} <@ '["read","write"]'::jsonb`),
}));

export const mcpOauthGrantWorkspaces = pgTable('mcp_oauth_grant_workspaces', {
  grantId: uuid('grant_id').references(() => mcpOauthGrants.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.grantId, t.workspaceId] }),
  workspaceIdx: index('mcp_oauth_grant_workspaces_workspace_idx').on(t.workspaceId),
}));

// ── MCP Connectors ────────────────────────────────────────────────────────────
// Team-scoped connector registry for generic MCP servers (HTTP+SSE or streamable HTTP).
// Each connector holds the server URL + auth config; per-workspace enablement lives in
// connectorWorkspaces. Discovered AS metadata and DCR results are cached in
// discoveredMetadata to avoid re-running discovery on every auth flow.

export const connectors = pgTable('connectors', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  authMode: connectorAuthModeEnum('auth_mode').notNull().default('none'),
  // Transport: 'http' (remote MCP over HTTP/SSE — uses `url`) or 'stdio' (local
  // process — uses `command`/`args`/`envMapping`). Default 'http' keeps existing rows unchanged.
  transport: connectorTransportEnum('transport').notNull().default('http'),
  // stdio transport: executable to spawn (e.g. 'npx', 'uvx'). Null for http transport.
  command: text('command'),
  // stdio transport: argv passed to `command` (e.g. ['-y', '@some/mcp-server']).
  args: jsonb('args').notNull().default([]).$type<string[]>(),
  // stdio transport: env var name → secret label mapping injected into the spawned process.
  envMapping: jsonb('env_mapping').notNull().default({}).$type<Record<string, string>>(),
  // For authMode='header': the HTTP header name (e.g. 'Authorization', 'X-API-Key').
  // The header value is stored as a secret (purpose='mcp_connector_credential').
  headerName: text('header_name'),
  // Cached AS metadata + DCR result — avoids re-running OAuth discovery on every auth.
  discoveredMetadata: jsonb('discovered_metadata').$type<Record<string, unknown>>(),
  // OAuth client credentials (authMode='oauth')
  clientId: text('client_id'),
  encryptedClientSecret: text('encrypted_client_secret'),
  // Assertion-mode fields (authMode='assertion')
  assertionAudience: text('assertion_audience'),
  assertionTokenEndpoint: text('assertion_token_endpoint'),
  // Display icon as a `data:` URL, resolved best-effort at create time, after
  // OAuth connect, and lazily on list (catalog entry → MCP serverInfo.icons →
  // websiteUrl / site favicon). NULL renders a letter avatar. Legacy rows may
  // still hold a remote URL until the next lazy refresh inlines it.
  // See apps/web/src/lib/connector-icon.ts.
  iconUrl: text('icon_url'),
  // Last icon lookup attempt; gates the lazy refresh to once per TTL.
  iconCheckedAt: timestamp('icon_checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('connectors_team_idx').on(t.teamId),
  teamNameIdx: uniqueIndex('connectors_team_name_idx').on(t.teamId, t.name),
}));

// Per-workspace connector enablement. A connector defined at team level must be
// explicitly enabled for each workspace that should mount it. This gives teams
// fine-grained control without duplicating the connector config.
export const connectorWorkspaces = pgTable('connector_workspaces', {
  connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.connectorId, t.workspaceId] }),
  workspaceIdx: index('connector_workspaces_workspace_idx').on(t.workspaceId),
}));

// Cross-team connector sharing (spec §1b). `connectors.teamId` is the OWNER team;
// a row here grants `sharedWithTeamId` use of the connector, reusing the owner's
// credential. Grantees enable per workspace / opt in per role but never edit the
// connector config or its credential. No self-share rows (owner is implicit).
export const connectorShares = pgTable('connector_shares', {
  connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'cascade' }).notNull(),
  sharedWithTeamId: uuid('shared_with_team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  grantedByAccountId: uuid('granted_by_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.connectorId, t.sharedWithTeamId] }),
  sharedWithTeamIdx: index('connector_shares_shared_with_team_idx').on(t.sharedWithTeamId),
}));

// Connector catalog (marketplace). Presets for remote MCP servers that the
// Add-connection modal offers one-click; installing one still creates an
// ordinary `connectors` row. Built-in presets live in code
// (apps/web/src/lib/connector-catalog.ts); a row here with the same slug and
// team_id NULL overrides or disables a built-in for everyone. team_id NULL =
// platform-wide (platform admins only, /api/admin/connector-catalog); team_id
// set = an entry private to that team (team admins). Merged by
// apps/web/src/lib/connector-catalog-store.ts.
export const connectorCatalogEntries = pgTable('connector_catalog_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  authMode: connectorAuthModeEnum('auth_mode').notNull().default('oauth'),
  headerName: text('header_name'),
  description: text('description').notNull().default(''),
  category: text('category').notNull().default('other'),
  iconUrl: text('icon_url'),
  // false hides the entry (and, for a platform row, the built-in it overrides).
  enabled: boolean('enabled').default(true).notNull(),
  createdByAccountId: uuid('created_by_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  platformSlugIdx: uniqueIndex('connector_catalog_platform_slug_idx').on(t.slug).where(sql`${t.teamId} IS NULL`),
  teamSlugIdx: uniqueIndex('connector_catalog_team_slug_idx').on(t.teamId, t.slug).where(sql`${t.teamId} IS NOT NULL`),
}));

// A team admin's decision about one catalog entry (by slug, so it applies to
// built-in, platform and team entries alike). No row = 'available'.
//   blocked      — hidden from the team's catalog; members cannot add it.
//   available    — offered in the catalog; an admin adds it on demand.
//   preinstalled — buildd creates the connector for the team and enables it
//                  in every workspace, including ones created later. Roles
//                  still opt in via connectorRefs (spec §2).
export const connectorCatalogTeamPolicies = pgTable('connector_catalog_team_policies', {
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  slug: text('slug').notNull(),
  policy: text('policy').notNull().$type<'blocked' | 'available' | 'preinstalled'>(),
  updatedByAccountId: uuid('updated_by_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.teamId, t.slug] }),
}));

export const connectorsRelations = relations(connectors, ({ one, many }) => ({
  team: one(teams, { fields: [connectors.teamId], references: [teams.id] }),
  connectorWorkspaces: many(connectorWorkspaces),
  shares: many(connectorShares),
}));

export const connectorWorkspacesRelations = relations(connectorWorkspaces, ({ one }) => ({
  connector: one(connectors, { fields: [connectorWorkspaces.connectorId], references: [connectors.id] }),
  workspace: one(workspaces, { fields: [connectorWorkspaces.workspaceId], references: [workspaces.id] }),
}));

export const connectorSharesRelations = relations(connectorShares, ({ one }) => ({
  connector: one(connectors, { fields: [connectorShares.connectorId], references: [connectors.id] }),
  sharedWithTeam: one(teams, { fields: [connectorShares.sharedWithTeamId], references: [teams.id] }),
}));

// Generic provider link layer between buildd's native tier (initiatives → missions →
// tasks) and external work trackers (Linear, GitHub). Phase 1 makes a link exist,
// persist, and stay authenticated — it does NOT read progress back or import graphs.
// `builddEntityId` is POLYMORPHIC (points at one of initiatives/missions/tasks) so it
// deliberately carries NO cross-table FK — existence is enforced in app code on write,
// and orphan rows are harmless (filtered on read). Team-cascade covers team deletion.
export const externalLinks = pgTable('external_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  provider: text('provider').notNull().$type<'linear' | 'github'>(),
  builddEntityType: text('buildd_entity_type').notNull().$type<'initiative' | 'mission' | 'task'>(),
  builddEntityId: uuid('buildd_entity_id').notNull(),
  externalId: text('external_id'),
  externalUrl: text('external_url'),
  // Phase 3 echo-suppression watermark — last-seen external mtime.
  externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // Partial unique — idempotent ON CONFLICT DO UPDATE keyed on (provider, externalId);
  // the WHERE clause allows many rows with a null externalId (unlinked entities).
  providerExternalIdx: uniqueIndex('external_links_provider_external_idx')
    .on(t.provider, t.externalId)
    .where(sql`${t.externalId} IS NOT NULL`),
  // Reverse lookup — "links for this mission/initiative/task".
  entityIdx: index('external_links_entity_idx').on(t.builddEntityType, t.builddEntityId),
  teamIdx: index('external_links_team_idx').on(t.teamId),
}));

export const externalLinksRelations = relations(externalLinks, ({ one }) => ({
  team: one(teams, { fields: [externalLinks.teamId], references: [teams.id] }),
}));

// Model tier registry — maps premium-plus/premium/standard/budget → concrete provider + model per team.
// workspace_id = NULL means team-wide default; non-NULL is a workspace override.
// surface = NULL means the row serves agent runs and chat; 'agent' or 'chat'
// scopes it to one surface and wins over the NULL row at the same scope.
// See docs/design/model-tiers.md for the resolution chain.
export const modelTierRegistry = pgTable('model_tier_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  tier: text('tier').notNull().$type<'premium-plus' | 'premium' | 'standard' | 'budget'>(),
  provider: text('provider').notNull().$type<'anthropic' | 'openai' | 'openai-codex' | 'openrouter'>(),
  model: text('model').notNull(),
  surface: text('surface').$type<'agent' | 'chat'>(),
  defaultEffort: text('default_effort').$type<'low' | 'medium' | 'high' | 'xhigh' | 'max'>(),
  defaultMaxTurns: integer('default_max_turns'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqueTierPerTeamWorkspace: uniqueIndex('model_tier_registry_unique').on(t.teamId, t.workspaceId, t.tier, t.surface),
  teamIdx: index('model_tier_registry_team_idx').on(t.teamId),
}));

export const modelTierRegistryRelations = relations(modelTierRegistry, ({ one }) => ({
  team: one(teams, { fields: [modelTierRegistry.teamId], references: [teams.id] }),
  workspace: one(workspaces, { fields: [modelTierRegistry.workspaceId], references: [workspaces.id] }),
}));

// ── Tier model pools (knowledge-base: buildd/design/tier-model-pools.md) ──────────────────────
//
// A tier is served by a pool of one to four arms per surface. With no row here
// a tier resolves exactly as before (model_tier_registry). Pools are created
// lazily when an admin adds the first challenger. Traffic moves only in
// versioned allocations, and every change is a tier_pool_changes row.
export const tierPools = pgTable('tier_pools', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // NULL = team pool. P1 creates team pools only.
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  tier: text('tier').notNull().$type<'premium' | 'standard' | 'budget'>(),
  surface: text('surface').notNull().$type<'agent' | 'chat'>(),
  // `dial`: buildd moves traffic from the cell's one dial and its own outcome
  // evidence (packages/core/tier-dial.ts); `allocation` follows `dial_state`.
  mode: text('mode').notNull().default('pinned').$type<'pinned' | 'split' | 'explore' | 'dial'>(),
  // kind 'tier_pool'; its id and policy_version salt the draw.
  experimentId: uuid('experiment_id').references(() => experiments.id, { onDelete: 'set null' }),
  // Current applied allocation: { [tier_pool_arms.id]: share }.
  allocation: jsonb('allocation').$type<Record<string, number>>().notNull().default({}),
  // Bumped by every allocation write; writes are compare-and-set on it.
  allocationVersion: integer('allocation_version').notNull().default(1),
  // { [tier_pool_arms.id]: 'off'|'low'|'med'|'high' }. `split` only — the
  // input `allocation` is derived from it (knowledge-base: buildd/design/tier-weights.md §1). A
  // pool created before this shipped has `weights = {}`; see
  // `packages/core/tier-weights.ts` `backfillWeights`.
  weights: jsonb('weights').$type<Record<string, 'off' | 'low' | 'med' | 'high'>>().notNull().default({}),
  incumbentFloor: real('incumbent_floor').notNull().default(0.6),
  explorationCap: real('exploration_cap').notNull().default(0.3),
  challengerMin: real('challenger_min').notNull().default(0.05),
  maxStep: real('max_step').notNull().default(0.1),
  costWeight: real('cost_weight').notNull().default(0.1),
  latencyWeight: real('latency_weight').notNull().default(0.05),
  challengerDailyCap: decimal('challenger_daily_cap', { precision: 10, scale: 2 }),
  autoChallenger: boolean('auto_challenger').notNull().default(false),
  autoShift: boolean('auto_shift').notNull().default(false),
  // The cell's dial, 1 (always the primary) .. 5 (cheapest that keeps up).
  // Read in `dial` mode only; 3 is balanced.
  dial: integer('dial').notNull().default(3),
  // `dial` mode state machine: always | learning | shifted | reverted, with
  // the shifted alternate and the last revert reason (DialStateRecord in
  // packages/core/tier-dial.ts). NULL until the first dial evaluation.
  dialState: jsonb('dial_state').$type<Record<string, unknown> | null>(),
  frozenAt: timestamp('frozen_at', { withTimezone: true }),
  frozenBy: uuid('frozen_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // NULLS NOT DISTINCT: two concurrent "add the first challenger" calls must
  // land on one team pool, and a team pool has workspace_id NULL.
  scopeUnique: unique('tier_pools_scope_unique').on(t.teamId, t.workspaceId, t.tier, t.surface).nullsNotDistinct(),
  teamIdx: index('tier_pools_team_idx').on(t.teamId),
}));

export const tierPoolArms = pgTable('tier_pool_arms', {
  id: uuid('id').primaryKey().defaultRandom(),
  poolId: uuid('pool_id').references(() => tierPools.id, { onDelete: 'cascade' }).notNull(),
  route: text('route').notNull().$type<'anthropic' | 'openai' | 'openrouter' | 'runner:claude' | 'runner:codex'>(),
  model: text('model').notNull(),
  role: text('role').notNull().$type<'incumbent' | 'challenger'>(),
  status: text('status').notNull().default('active').$type<'active' | 'paused' | 'removed'>(),
  source: text('source').notNull().default('admin').$type<'admin' | 'auto_challenger' | 'registry'>(),
  // Numbers only (P2 bandit state). No text column exists on this table.
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => ({
  poolIdx: index('tier_pool_arms_pool_idx').on(t.poolId),
  // The same (route, model) is one arm; removed arms may be re-added.
  liveArmUnique: uniqueIndex('tier_pool_arms_live_unique')
    .on(t.poolId, t.route, t.model)
    .where(sql`${t.status} <> 'removed'`),
  oneIncumbent: uniqueIndex('tier_pool_arms_one_incumbent')
    .on(t.poolId)
    .where(sql`${t.role} = 'incumbent' AND ${t.status} <> 'removed'`),
}));

// Append-only audit log: every traffic change, arm change and mode change.
export const tierPoolChanges = pgTable('tier_pool_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  poolId: uuid('pool_id').references(() => tierPools.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull().$type<'allocation' | 'arm_added' | 'arm_removed' | 'mode' | 'freeze' | 'unfreeze' | 'suggestion' | 'suggestion_dismissed' | 'promotion' | 'revert' | 'dial'>(),
  before: jsonb('before').$type<Record<string, unknown>>(),
  after: jsonb('after').$type<Record<string, unknown>>(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorSystem: text('actor_system'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  poolCreatedIdx: index('tier_pool_changes_pool_created_idx').on(t.poolId, t.createdAt),
}));

// Model plans served to sibling apps by POST /api/ai/plan
// (knowledge-base: buildd/design/shared-ai-kit.md §2). One row per plan: which model buildd
// chose for an app account, and the may-spend decision it returned. The model
// call itself runs in the app; buildd never sees its content. Metadata only:
// `kind` is the app's free attribution label, no other text is stored.
export const aiPlans = pgTable('ai_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  requestedTier: text('requested_tier').notNull(),
  // The tier actually served (differs from requestedTier on a downgrade).
  tier: text('tier').notNull(),
  surface: text('surface').notNull().$type<'chat' | 'inference'>(),
  kind: text('kind').notNull(),
  // NULL on a deny: no model was offered.
  provider: text('provider'),
  model: text('model'),
  source: text('source').notNull().$type<'registry' | 'pool' | 'catalog' | 'default'>(),
  // Set when the tier's chat pool drew this plan's arm.
  poolId: uuid('pool_id').references(() => tierPools.id, { onDelete: 'set null' }),
  armId: uuid('arm_id').references(() => tierPoolArms.id, { onDelete: 'set null' }),
  action: text('action').notNull().$type<'ok' | 'downgrade' | 'deny'>(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  teamCreatedIdx: index('ai_plans_team_created_idx').on(t.teamId, t.createdAt),
  accountCreatedIdx: index('ai_plans_account_created_idx').on(t.accountId, t.createdAt),
}));

// Usage receipts from sibling apps, POST /api/ai/usage. Content-free and
// identity-free by construction: no prompt, reply, tool output or end-user id
// column exists, and the route rejects any field outside its metadata schema.
// Feeds model-choice statistics and the per-account daily AI cap
// (accounts.aiDailyBudgetUsd).
export const aiUsage = pgTable('ai_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // The account that reported the receipt (the app's service account). NULL
  // for a buildd-internal decision with no acting account (memory relevance
  // shadow, OAuth MCP, chat): attributed to the team only.
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  // NULL when the app ran on its own fallback plan (buildd was unreachable).
  planId: uuid('plan_id').references(() => aiPlans.id, { onDelete: 'set null' }),
  // NULL only for a planless Jev decision receipt: Jev has no tier.
  tier: text('tier'),
  // chat | inference (the plan's surface) | decision; the receipt's own `kind` wins.
  surface: text('surface'),
  // The plan's free attribution label (ai_plans.kind); NULL without a plan.
  kind: text('kind'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  // How the app got the plan it ran on: a fresh plan's source, or 'cached' / 'fallback'.
  planSource: text('plan_source'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  costUsd: decimal('cost_usd', { precision: 12, scale: 6 }).notNull(),
  costSource: text('cost_source').notNull().$type<'reported' | 'estimated'>(),
  latencyMs: integer('latency_ms').notNull(),
  outcome: text('outcome').notNull().$type<'ok' | 'error' | 'aborted'>(),
  feedback: text('feedback').$type<'up' | 'down'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  accountCreatedIdx: index('ai_usage_account_created_idx').on(t.accountId, t.createdAt),
  teamCreatedIdx: index('ai_usage_team_created_idx').on(t.teamId, t.createdAt),
  planIdx: index('ai_usage_plan_idx').on(t.planId),
}));

// Workspace migration ledger — one row per (runId, phase). Tracks the destructive
// entity-move phases of a workspace team migration so the repair endpoint can resume
// from the first failed phase idempotently. See docs/design/workspace-migration.md §Execution.
// Phases mirror BT-4…BT-10 (identity moves first, destructive deletes last).
export const migrationLog = pgTable('migration_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Groups all phase rows of a single migration attempt. Generated by the execute endpoint.
  runId: uuid('run_id').notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  sourceTeamId: uuid('source_team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  destinationTeamId: uuid('destination_team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  phase: text('phase').notNull().$type<
    | 'workspace_team'
    | 'missions_team'
    | 'skills_team'
    | 'clear_account_workspaces'
    | 'clear_connector_workspaces'
    | 'delete_secrets'
    | 'checklist_artifact'
  >(),
  status: text('status').notNull().default('pending').$type<'pending' | 'completed' | 'failed'>(),
  error: text('error'),
  // Records what the phase touched (counts, deleted labels/names) — feeds the checklist.
  detail: jsonb('detail').default({}).$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  runIdx: index('migration_log_run_idx').on(t.runId),
  workspaceIdx: index('migration_log_workspace_idx').on(t.workspaceId),
  // One ledger row per phase within a run — enables idempotent upsert-style resume.
  runPhaseIdx: uniqueIndex('migration_log_run_phase_idx').on(t.runId, t.phase),
}));

export const migrationLogRelations = relations(migrationLog, ({ one }) => ({
  workspace: one(workspaces, { fields: [migrationLog.workspaceId], references: [workspaces.id] }),
}));

export type MigrationLog = typeof migrationLog.$inferSelect;
export type NewMigrationLog = typeof migrationLog.$inferInsert;

// TypeScript types for new tables
export type Connector = typeof connectors.$inferSelect;
export type NewConnector = typeof connectors.$inferInsert;
export type ConnectorWorkspace = typeof connectorWorkspaces.$inferSelect;
export type NewConnectorWorkspace = typeof connectorWorkspaces.$inferInsert;
export type ConnectorShare = typeof connectorShares.$inferSelect;
export type NewConnectorShare = typeof connectorShares.$inferInsert;

export type ExternalLink = typeof externalLinks.$inferSelect;
export type NewExternalLink = typeof externalLinks.$inferInsert;

// Change-intent rows — one per (workspace, conflictSurface, task) while a PR is open.
// Closed (closedAt set) when the PR merges or is abandoned.
// See docs/design/change-intent.md.
export const changeIntents = pgTable('change_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  // The matched conflictSurface label (e.g. "Drizzle migrations") — human-readable key.
  surface: text('surface').notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  prNumber: integer('pr_number'),
  branch: text('branch'),
  headSha: text('head_sha'),
  // The PR's base branch (GitHub `base.ref`). Surface ordering compares only
  // contenders landing on the same base; NULL = not yet known (treated as a
  // possible same-base contender until a live read says otherwise).
  baseRef: text('base_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({
  workspaceSurfaceOpenIdx: index('change_intents_ws_surface_open_idx')
    .on(t.workspaceId, t.surface)
    .where(sql`${t.closedAt} IS NULL`),
  taskIdx: index('change_intents_task_idx').on(t.taskId),
}));

export const changeIntentsRelations = relations(changeIntents, ({ one }) => ({
  workspace: one(workspaces, { fields: [changeIntents.workspaceId], references: [workspaces.id] }),
  task: one(tasks, { fields: [changeIntents.taskId], references: [tasks.id] }),
}));

export type ChangeIntent = typeof changeIntents.$inferSelect;
export type NewChangeIntent = typeof changeIntents.$inferInsert;

// Surface merge reservations — at most one PR per (workspace, repo, base branch,
// serialized surface) is between "ordering passed" and "merge returned". Acquired with one
// INSERT ... ON CONFLICT DO UPDATE ... WHERE (expired OR same PR) compare-and-set;
// released by token on success, failure or bounded expiry. GitHub cannot share a
// DB transaction, so an expired holder is reconciled against GitHub before reuse.
// See apps/web/src/lib/surface-ordering.ts and conflict-aware-orchestration.md §3.
export const surfaceReservations = pgTable('surface_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  repoFullName: text('repo_full_name').notNull(),
  // The base branch the PR lands on: two PRs only contend for a slot on the same base.
  baseRef: text('base_ref').notNull(),
  surface: text('surface').notNull(),
  prNumber: integer('pr_number').notNull(),
  headSha: text('head_sha').notNull(),
  baseSha: text('base_sha'),
  token: uuid('token').notNull(),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  surfaceUnique: uniqueIndex('surface_reservations_surface_idx').on(t.workspaceId, t.repoFullName, t.baseRef, t.surface),
}));

export type SurfaceReservation = typeof surfaceReservations.$inferSelect;

export type Initiative = typeof initiatives.$inferSelect;
export type NewInitiative = typeof initiatives.$inferInsert;

export type TaskSubjectReport = typeof taskSubjectReports.$inferSelect;
export type NewTaskSubjectReport = typeof taskSubjectReports.$inferInsert;
export type TaskSubjectClaim = typeof taskSubjectClaims.$inferSelect;
export type NewTaskSubjectClaim = typeof taskSubjectClaims.$inferInsert;

export type SpecDiscrepancy = typeof specDiscrepancies.$inferSelect;
export type NewSpecDiscrepancy = typeof specDiscrepancies.$inferInsert;

// Dark-check detection: tracks required CI checks that consistently report
// 'skipped', signalling a misconfigured gate that silently bypasses CI.
// One row per (workspace, checkName). consecutiveSkips resets to 0 when the
// check reports a non-skipped conclusion. lastAlertedAt guards 24h dedup.
export const darkCheckAlerts = pgTable('dark_check_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  checkName: text('check_name').notNull(),
  consecutiveSkips: integer('consecutive_skips').default(0).notNull(),
  lastAlertedAt: timestamp('last_alerted_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceCheckUnique: uniqueIndex('dark_check_alerts_ws_check_idx').on(t.workspaceId, t.checkName),
}));

export type DarkCheckAlert = typeof darkCheckAlerts.$inferSelect;

// Path claims — held file-path locks for coordinating parallel workers.
// A row per (task, path), from either of two writers: check_path_claim, when an
// agent declares a path up front, and claimObservedPaths on worker sync, which
// leases the paths §6d observed the worker actually touching (minus regenerable
// files and the '**' sentinel). The second writer is what puts traffic through
// the claim-route backstop; a declaration-only table sat idle.
// released_at IS NULL → active hold; set to NOW() on terminal task status,
// PR merged/closed, or worker reaper. No uniqueness constraint on
// (workspace_id, path) because conflict detection uses prefix matching in
// application code via pathsOverlap(). See docs/design/path-claims.md.
export const pathClaims = pgTable('path_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  path: text('path').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
}, (t) => ({
  activeIdx: index('path_claims_active_idx').on(t.workspaceId, t.path).where(sql`${t.releasedAt} IS NULL`),
  taskIdx: index('path_claims_task_idx').on(t.taskId).where(sql`${t.releasedAt} IS NULL`),
}));

export const pathClaimsRelations = relations(pathClaims, ({ one }) => ({
  workspace: one(workspaces, { fields: [pathClaims.workspaceId], references: [workspaces.id] }),
  task: one(tasks, { fields: [pathClaims.taskId], references: [tasks.id] }),
}));

export type PathClaim = typeof pathClaims.$inferSelect;
export type NewPathClaim = typeof pathClaims.$inferInsert;

// Waiter queue — tasks that hit a 409 on check_path_claim are registered here.
// On release, notifyWaiters() fans out to live workers via Pusher.
// UNIQUE on (blocking_task_id, waiting_task_id, blocked_path) prevents duplicate
// registrations when a worker retries the same blocked claim.
export const pathClaimWaiters = pgTable('path_claim_waiters', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  blockingTaskId: uuid('blocking_task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  waitingTaskId: uuid('waiting_task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  blockedPath: text('blocked_path').notNull(),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow().notNull(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
}, (t) => ({
  uniqueWaiter: uniqueIndex('pcw_unique_idx').on(t.blockingTaskId, t.waitingTaskId, t.blockedPath),
  blockingTaskOpenIdx: index('pcw_blocking_task_idx').on(t.blockingTaskId).where(sql`${t.notifiedAt} IS NULL`),
  starvationIdx: index('path_claim_waiters_starvation_idx').on(t.workspaceId, t.registeredAt).where(sql`${t.notifiedAt} IS NULL`),
}));

export const pathClaimWaitersRelations = relations(pathClaimWaiters, ({ one }) => ({
  workspace: one(workspaces, { fields: [pathClaimWaiters.workspaceId], references: [workspaces.id] }),
  blockingTask: one(tasks, { fields: [pathClaimWaiters.blockingTaskId], references: [tasks.id], relationName: 'blockingClaims' }),
  waitingTask: one(tasks, { fields: [pathClaimWaiters.waitingTaskId], references: [tasks.id], relationName: 'waitingClaims' }),
}));

export type PathClaimWaiter = typeof pathClaimWaiters.$inferSelect;
export type NewPathClaimWaiter = typeof pathClaimWaiters.$inferInsert;

// Durable dispatch intent: "something changed that may make this task
// runnable — re-evaluate it". Not a scheduler: the claim route stays the only
// authority on whether the task runs, and the task row stays the truth. A row
// is written atomically with the mutation that caused it (the tasks trigger
// for transitions into `pending`, a CTE/batch for the rest — see
// packages/core/dispatch-outbox.ts), then delivered at-least-once by the
// dispatch consumer (apps/web/src/lib/dispatch-authority.ts).
export const taskDispatchOutbox = pgTable('task_dispatch_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  // DispatchIntent: what kind of delivery this is (work_execution,
  // human_action, notification, incident, external_work). Selects the adapter
  // chain; durable dispatch does not imply autonomous execution. The trigger
  // writes the default.
  intent: text('intent').default('work_execution').notNull(),
  // DispatchCause (packages/core/dispatch-outbox.ts). A coalesced row keeps
  // the first cause; later ones are appended to `causes`.
  cause: text('cause').notNull(),
  causes: jsonb('causes').$type<string[]>().default([]).notNull(),
  notBefore: timestamp('not_before', { withTimezone: true }).defaultNow().notNull(),
  // Pending rows coalesce on (task_id, dedupe_key). 'now' for an immediate
  // wake; a scheduled wake keys on its due time so it is not folded into an
  // earlier immediate one.
  dedupeKey: text('dedupe_key').default('now').notNull(),
  // 'handed_off': acked by the Dispatch transport, which now owns the delivery
  // lifecycle; receipts project back onto this row.
  status: text('status').default('pending').notNull().$type<'pending' | 'delivering' | 'delivered' | 'failed' | 'handed_off'>(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  // How it was delivered ('webhook' | 'pusher' | 'skipped:<why>'), or the error.
  deliveredVia: text('delivered_via'),
  lastError: text('last_error'),
  // Delivery hints that are not task state, e.g. { targetLocalUiUrl }.
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  // Dispatch transport. `publishedAt`: last publish attempt (unacked rows are
  // retried oldest-first). `handedOffAt`: the Worker acked it. `mergedInto`:
  // the Worker folded it into another queued intent with the same dedupe key.
  transport: text('transport').default('in_app').notNull().$type<'in_app' | 'dispatch'>(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  handedOffAt: timestamp('handed_off_at', { withTimezone: true }),
  mergedInto: uuid('merged_into'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  unackedIdx: index('task_dispatch_outbox_unacked_idx').on(t.createdAt).where(sql`${t.status} = 'pending' AND ${t.handedOffAt} IS NULL`),
  handedOffIdx: index('task_dispatch_outbox_handed_off_idx').on(t.notBefore).where(sql`${t.status} = 'handed_off'`),
  pendingDedupeIdx: uniqueIndex('task_dispatch_outbox_pending_dedupe_idx').on(t.taskId, t.dedupeKey).where(sql`${t.status} = 'pending'`),
  dueIdx: index('task_dispatch_outbox_due_idx').on(t.notBefore).where(sql`${t.status} IN ('pending', 'delivering')`),
  taskIdx: index('task_dispatch_outbox_task_idx').on(t.taskId, t.createdAt),
}));

export type TaskDispatchOutboxRow = typeof taskDispatchOutbox.$inferSelect;

// ── Workflow state kernel (docs/specs/workflow-state-kernel.md §5) ──────────
// Only apps/web/src/lib/workflow/ reads or writes these tables
// (packages/core/__tests__/workflow-write-sites.test.ts). Every state change is
// one version-CAS statement written by apps/web/src/lib/workflow/kernel.ts.

// §5.1 — one row per deliverable that is meant to reach GitHub as a PR.
export const workflowDeliveries = pgTable('workflow_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  ownerTaskId: uuid('owner_task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  // Null until PrBound. The repo is part of the PR key: a PR number alone
  // collides across two repos of one workspace.
  repoFullName: text('repo_full_name'),
  prNumber: integer('pr_number'),
  baseRef: text('base_ref'),
  // DeliveryState (apps/web/src/lib/workflow/types.ts); state_reason carries
  // repair_kind / escalation reason / close_cause.
  state: text('state').notNull(),
  stateReason: text('state_reason'),
  // CAS counter (§7): every applied transition increments it.
  version: bigint('version', { mode: 'number' }).default(0).notNull(),
  // The GitHub head the delivery acts on. Set only by HeadObserved-class
  // transitions from a live read, never from a runner-reported local SHA.
  currentHeadSha: text('current_head_sha'),
  currentRound: integer('current_round').default(0).notNull(),
  maxRounds: integer('max_rounds').default(3).notNull(),
  // The attempt (FIXING/REPAIRING: a workflow_attempts id) whose end the
  // delivery is waiting on. Owner attempts are the owner task itself.
  boundAttemptId: uuid('bound_attempt_id'),
  resumeState: text('resume_state'),
  trunkIncidentId: uuid('trunk_incident_id'),
  // Heads covered by a standing review approval: the head a verdict (or a
  // human) approved plus carry-forward equivalents. Exact-head binding.
  approvedHeads: text('approved_heads').array().default(sql`'{}'::text[]`).notNull(),
  // 'verdict' | 'human' | 'composition' | 'policy' — what the standing approval
  // rests on. 'policy' (no review required) is never a verdict at the head.
  approvalBasis: text('approval_basis'),
  // Heads covered ONLY by a verified composition attestation (a release or
  // integration PR assembled from already-reviewed constituents). Kept apart
  // from approved_heads so no reader mistakes it for a verdict at that head.
  compositionHeads: text('composition_heads').array().default(sql`'{}'::text[]`).notNull(),
  ci: text('ci'),
  ciHeadSha: text('ci_head_sha'),
  mergeable: text('mergeable'),
  mergeableHeadSha: text('mergeable_head_sha'),
  // GitHub's values, never receipt time.
  mergedAt: timestamp('merged_at', { withTimezone: true }),
  mergeCommitSha: text('merge_commit_sha'),
  supersededByPr: integer('superseded_by_pr'),
  supersededByUrl: text('superseded_by_url'),
  supersededReason: text('superseded_reason'),
  recordedBy: text('recorded_by'),
  // The newest head-bound policy finding (PolicyEvidenceRecorded, §6.3 T28):
  // { headSha, outcome, reason, destructive }. Evidence for ONE head; a
  // delivery on any other head ignores it.
  policyEvidence: jsonb('policy_evidence').$type<{ headSha: string; outcome: 'human' | 'agent_split'; reason: string; destructive: boolean } | null>(),
  // Who decides for this delivery (§14 cutover): 'kernel', or 'legacy' once the
  // gitConfig.workflowKernel kill switch handed it back. Sticky: a delivery
  // released to legacy finishes there even if the switch is turned on again,
  // so no delivery ever has two authorities.
  authority: text('authority').default('kernel').notNull().$type<'kernel' | 'legacy'>(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  lastTransitionAt: timestamp('last_transition_at', { withTimezone: true }),
}, (t) => ({
  ownerUnique: uniqueIndex('workflow_deliveries_owner_unique').on(t.workspaceId, t.ownerTaskId),
  prUnique: uniqueIndex('workflow_deliveries_pr_unique').on(t.workspaceId, t.repoFullName, t.prNumber).where(sql`${t.prNumber} IS NOT NULL`),
  stateIdx: index('workflow_deliveries_state_idx').on(t.workspaceId, t.state),
}));

export type WorkflowDeliveryRow = typeof workflowDeliveries.$inferSelect;

// §5.2 — a verdict is a property of (PR, head SHA, round); head_sha is set at
// dispatch and never edited.
export const workflowReviewRounds = pgTable('workflow_review_rounds', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').references(() => workflowDeliveries.id, { onDelete: 'cascade' }).notNull(),
  round: integer('round').notNull(),
  headSha: text('head_sha').notNull(),
  kind: text('kind').notNull().$type<'full' | 'delta'>(),
  priorRound: integer('prior_round'),
  // Delta scope: for a composition with a novel delta, only these paths are new.
  scope: jsonb('scope').$type<Record<string, unknown>>(),
  reviewerTaskId: uuid('reviewer_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  status: text('status').default('queued').notNull().$type<'queued' | 'reviewing' | 'decided' | 'failed' | 'superseded'>(),
  verdict: text('verdict').$type<'approve' | 'request_changes' | 'escalate'>(),
  effectiveVerdict: text('effective_verdict').$type<'approve' | 'request_changes' | 'escalate'>(),
  confidence: real('confidence'),
  failureCount: integer('failure_count').default(0).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  roundUnique: uniqueIndex('workflow_review_rounds_round_unique').on(t.deliveryId, t.round),
  // Single flight: one open round per (delivery, head, kind).
  openPerHead: uniqueIndex('workflow_review_rounds_open_per_head').on(t.deliveryId, t.headSha, t.kind).where(sql`${t.status} IN ('queued', 'reviewing')`),
}));

export type WorkflowReviewRoundRow = typeof workflowReviewRounds.$inferSelect;

// §5.3 — append-only observations. A duplicate fact_key is a no-op that
// returns the first application's result. payload holds normalised fields the
// reducer read, never a raw webhook body.
export const workflowFacts = pgTable('workflow_facts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  deliveryId: uuid('delivery_id').references(() => workflowDeliveries.id, { onDelete: 'cascade' }),
  repoFullName: text('repo_full_name'),
  prNumber: integer('pr_number'),
  kind: text('kind').notNull(),
  factKey: text('fact_key').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
  source: text('source').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  appliedTransitionId: uuid('applied_transition_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  factKeyUnique: uniqueIndex('workflow_facts_fact_key_unique').on(t.workspaceId, t.factKey),
  deliveryIdx: index('workflow_facts_delivery_idx').on(t.deliveryId, t.observedAt),
  prIdx: index('workflow_facts_pr_idx').on(t.workspaceId, t.repoFullName, t.prNumber),
}));

export type WorkflowFactRow = typeof workflowFacts.$inferSelect;

// §5.4 — append-only transition log; the one source for the PR activity
// comment, mission notes and explain's because[] chain.
export const workflowTransitions = pgTable('workflow_transitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').references(() => workflowDeliveries.id, { onDelete: 'cascade' }).notNull(),
  fromVersion: bigint('from_version', { mode: 'number' }).notNull(),
  toVersion: bigint('to_version', { mode: 'number' }).notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  command: text('command').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  actor: text('actor').notNull(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().default({}).notNull(),
  bypass: jsonb('bypass').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  idempotencyUnique: uniqueIndex('workflow_transitions_idempotency_unique').on(t.deliveryId, t.idempotencyKey),
  versionUnique: uniqueIndex('workflow_transitions_version_unique').on(t.deliveryId, t.toVersion),
}));

export type WorkflowTransitionRow = typeof workflowTransitions.$inferSelect;

// §5.5 — transactional outbox: inserted by the statement that applied the
// transition, drained at least once by apps/web/src/lib/workflow/effects.ts.
export const workflowEffects = pgTable('workflow_effects', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').references(() => workflowDeliveries.id, { onDelete: 'cascade' }).notNull(),
  transitionId: uuid('transition_id').references(() => workflowTransitions.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  status: text('status').default('pending').notNull().$type<'pending' | 'delivering' | 'done' | 'failed' | 'dead'>(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  notBefore: timestamp('not_before', { withTimezone: true }).defaultNow().notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  lastError: text('last_error'),
  outcome: text('outcome'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  dedupeUnique: uniqueIndex('workflow_effects_dedupe_unique').on(t.dedupeKey),
  dueIdx: index('workflow_effects_due_idx').on(t.notBefore).where(sql`${t.status} IN ('pending', 'delivering')`),
  deliveryIdx: index('workflow_effects_delivery_idx').on(t.deliveryId, t.createdAt),
}));

export type WorkflowEffectRow = typeof workflowEffects.$inferSelect;

// §5.7 — one retry ledger per family; the only source for "attempt N of M".
// Allocation is consumption: the row is inserted by the dispatching statement.
export const workflowAttempts = pgTable('workflow_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').references(() => workflowDeliveries.id, { onDelete: 'cascade' }).notNull(),
  family: text('family').notNull().$type<'review_fix' | 'ci' | 'conflict' | 'migration' | 'trunk'>(),
  attemptNo: integer('attempt_no').notNull(),
  mode: text('mode').notNull().$type<'mechanical' | 'agent'>(),
  boundHeadSha: text('bound_head_sha'),
  triggerFactId: uuid('trigger_fact_id'),
  triggerReason: text('trigger_reason'),
  // No FK, like tasks.delivery_id (§5.6): allocation is consumption, so the
  // dispatching statement writes the attempt row naming its task id BEFORE the
  // dispatch_fix effect inserts that task (and re-inserts it under the same id
  // after a crash). A tasks FK rejects every such allocation.
  taskId: uuid('task_id'),
  trigger: text('trigger').default('automatic').notNull().$type<'automatic' | 'human'>(),
  reportedShas: text('reported_shas').array().default(sql`'{}'::text[]`).notNull(),
  pushedHeadSha: text('pushed_head_sha'),
  status: text('status').default('queued').notNull().$type<'queued' | 'running' | 'ended' | 'skipped' | 'cancelled'>(),
  outcome: text('outcome').$type<'delivered' | 'unproven' | 'failed' | 'noop'>(),
  maxAttempts: integer('max_attempts').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => ({
  attemptUnique: uniqueIndex('workflow_attempts_no_unique').on(t.deliveryId, t.family, t.mode, t.attemptNo),
  taskIdx: index('workflow_attempts_task_idx').on(t.taskId),
}));

export type WorkflowAttemptRow = typeof workflowAttempts.$inferSelect;

// §5.8 — one incident per trunk-red signature; per-PR CI retries are not
// dispatched while it is open.
export const trunkIncidents = pgTable('trunk_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  repoFullName: text('repo_full_name').notNull(),
  baseRef: text('base_ref').notNull(),
  signature: text('signature').notNull(),
  status: text('status').default('open').notNull().$type<'open' | 'fixing' | 'resolved'>(),
  openedByFact: uuid('opened_by_fact'),
  trunkFixTaskId: uuid('trunk_fix_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  // Bounded by the circuit-breaker cap.
  affectedDeliveries: jsonb('affected_deliveries').$type<string[]>().default([]).notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  openSignatureUnique: uniqueIndex('trunk_incidents_open_signature_unique').on(t.workspaceId, t.repoFullName, t.baseRef, t.signature).where(sql`${t.status} <> 'resolved'`),
}));

export type TrunkIncidentRow = typeof trunkIncidents.$inferSelect;

// Releases — one row per deployment/release event for a workspace.
export const releases = pgTable('releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  archetype: text('archetype').notNull().$type<'gated' | 'continuous' | 'store' | 'package' | 'none'>(),
  unit: text('unit'),
  headSha: text('head_sha'),
  previousSha: text('previous_sha'),
  version: text('version'),
  state: text('state').notNull().default('deploying').$type<'dispatched' | 'deploying' | 'healthy' | 'failed' | 'degraded' | 'pending_external'>(),
  verificationStrategy: text('verification_strategy').notNull().default('none').$type<'http' | 'registry' | 'external' | 'none'>(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  deployedAt: timestamp('deployed_at', { withTimezone: true }),
  healthyAt: timestamp('healthy_at', { withTimezone: true }),
  runUrl: text('run_url'),
  deployUrl: text('deploy_url'),
  triggeredBy: text('triggered_by').$type<'user' | 'agent' | 'auto' | 'external'>(),
  failureReason: text('failure_reason'),
  ciStateAtDispatch: text('ci_state_at_dispatch').$type<'passing' | 'failing' | 'pending'>(),
  commitsAheadAtDispatch: integer('commits_ahead_at_dispatch'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index('releases_workspace_idx').on(t.workspaceId),
  stateIdx: index('releases_state_idx').on(t.state),
  // The workflow_run webhook resolves a release by run_url on the same hot
  // path as the runId lookup above.
  runUrlIdx: index('releases_run_url_idx').on(t.runUrl),
  workspaceShaIdx: uniqueIndex('releases_workspace_sha_idx').on(t.workspaceId, t.headSha),
}));

export const releasesRelations = relations(releases, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [releases.workspaceId], references: [workspaces.id] }),
  releaseTasks: many(releaseTasks),
}));

export type Release = typeof releases.$inferSelect;
export type NewRelease = typeof releases.$inferInsert;

// Edge table — tasks shipped in a release (many-to-many).
export const releaseTasks = pgTable('release_tasks', {
  releaseId: uuid('release_id').references(() => releases.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  prNumber: integer('pr_number'),
  commitSha: text('commit_sha'),
}, (t) => ({
  pk: primaryKey({ columns: [t.releaseId, t.taskId] }),
}));

export const releaseTasksRelations = relations(releaseTasks, ({ one }) => ({
  release: one(releases, { fields: [releaseTasks.releaseId], references: [releases.id] }),
  task: one(tasks, { fields: [releaseTasks.taskId], references: [tasks.id] }),
}));

export type ReleaseTask = typeof releaseTasks.$inferSelect;
export type NewReleaseTask = typeof releaseTasks.$inferInsert;

// Memories — absorbed from the standalone memory.buildd.dev service.
// Team-scoped: all workspaces in a team share the same memory pool.
// IDs are preserved from the service so knowledge_chunks source_ids remain valid.
//
// `project` is a canonical scope key: lowercase `owner/repo` for repo-shaped
// values, otherwise the value verbatim (a bare repo name or a sentinel label).
// Always write it through normalizeProject() in packages/core/project-scope.ts;
// migration 0132 canonicalized the history.
export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  type: text('type').notNull().$type<'discovery' | 'decision' | 'gotcha' | 'pattern' | 'architecture' | 'summary'>(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  project: text('project'),
  tags: text('tags').array().notNull().default([]),
  files: text('files').array().notNull().default([]),
  source: text('source'),
  // Id of the memory that replaced this one. Recorded on the row (not only in
  // the index) so the index reconcile pass never re-indexes it as current.
  supersededBy: uuid('superseded_by'),
  // Consecutive failed reconcile attempts to mirror this row into the index.
  // Rows past the cap drop out of reconcile so they cannot block the backlog.
  indexFailures: integer('index_failures').notNull().default(0),
  // Lifecycle (knowledge-base: buildd/design/memory-done-right.md, "Write: candidates, then
  // promotion"; packages/core/memory-candidates.ts). Every row written before
  // this existed is 'active', and writes stay 'active' unless the workspace
  // flag `memoryCandidateWrites` is on. Only 'active' is pushed at claim time;
  // 'candidate' is served to a pull that asks for it; 'expired' and
  // 'invalidated' are readable by id only. Nothing moves a row out of the
  // table: expiry and invalidation are state changes, reversible.
  // Supersession stays `superseded_by` (who replaced it) + `invalidated_at`
  // (when); 'invalidated' is for an invalidation with no replacement.
  state: text('state').notNull().default('active').$type<'candidate' | 'active' | 'expired' | 'invalidated'>(),
  // Provenance: which episode proposed it. source_id is the task id for
  // learn / failed_task, the review_feedback row id for review.
  sourceKind: text('source_kind').$type<'learn' | 'failed_task' | 'review' | 'chat' | 'digest' | 'dashboard' | 'mission_completion'>(),
  sourceId: text('source_id'),
  // Derived from content outside the team (external PR comments, issue text).
  // Hard floor: never auto-promoted.
  external: boolean('external').notNull().default(false),
  // When the row became active by promotion. Null for rows active from birth.
  validFrom: timestamp('valid_from', { withTimezone: true }),
  // When it stopped being current (superseded or invalidated).
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  // A merged PR touched one of its anchored `files` since it was written.
  // A flag for re-verification, never a demotion.
  reverifyFlaggedAt: timestamp('reverify_flagged_at', { withTimezone: true }),
  reverifyRef: text('reverify_ref'),
  // The memory whose episode corroborated this candidate. Written ONLY by the
  // automatic near-duplicate path of `learn` (a different task's repeat of
  // the same lesson in the same project); explicit or band supersedes never
  // set it. Promotion re-checks the linked row in SQL.
  corroboratedBy: uuid('corroborated_by'),
  // Active memories this candidate replaces, applied only when it is
  // promoted: a candidate never hides an active memory from push.
  pendingSupersedes: uuid('pending_supersedes').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  teamIdx: index('memories_team_idx').on(t.teamId),
  stateCreatedIdx: index('memories_state_created_idx').on(t.state, t.createdAt),
  teamUpdatedIdx: index('memories_team_updated_idx').on(t.teamId, t.updatedAt),
  teamProjectIdx: index('memories_team_project_idx').on(t.teamId, t.project),
}));

// One row per episode the memory lifecycle pass tried to extract a candidate
// from (packages/core/memory-lifecycle.ts), whatever the outcome, so a
// failed task or review whose lesson is already recorded is not re-embedded
// on every run. Content-free: ids and a label.
export const memoryExtractionAttempts = pgTable('memory_extraction_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  sourceKind: text('source_kind').notNull().$type<'failed_task' | 'review'>(),
  sourceId: text('source_id').notNull(),
  outcome: text('outcome').notNull().$type<'written' | 'duplicate' | 'skipped'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  sourceUnique: uniqueIndex('memory_extraction_attempts_source_unique').on(t.sourceKind, t.sourceId),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  team: one(teams, { fields: [memories.teamId], references: [teams.id] }),
}));

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

// ── Gate ledger ───────────────────────────────────────────────────────────────
//
// One row per server-side gate decision that a caller can hit WITHOUT a worker
// failing: a refusal, a deferral, an advisory warning, or an explicit bypass.
//
// This class of decision was the only one buildd never wrote down. Six separate
// point fixes were needed before anyone could see a rate, because
// `get_failure_analytics` reads terminal worker rows and a creation-time 400 is
// not a worker failure — it is a decision about a request that never became a
// worker at all. The three-week false-positive lint is the canonical case: it
// took four friction reports (each of which had to bypass the same lint) before
// the frequency was visible, and the analytics table showed zero rows for it
// the whole time.
//
// Writes are fire-and-forget (see packages/core/gate-events.ts). A ledger that
// can fail a request is worse than no ledger — it turns an observability miss
// into an outage — so `recordGateEvent` swallows everything and the gate's own
// behaviour never depends on the insert landing.
export const gateEvents = pgTable('gate_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  // Stable slug naming the RULE, not the message — e.g. 'manifest_required',
  // 'merge_policy', 'prose_gate'. Rename it and you fork the history, so treat
  // it like a migration: see GATE_SLUGS in packages/core/gate-events.ts.
  gate: text('gate').notNull(),
  // Where the decision was made: 'POST /api/tasks', 'PUT /api/github/pr', …
  surface: text('surface').notNull(),
  // Nullable: a handful of gates fire before the route has resolved a
  // workspace. Those rows are unattributable to a team and drop out of every
  // scoped aggregation, which is why the task-creation wrapper resolves the
  // caller's raw workspace reference in the background rather than giving up.
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
  outcome: text('outcome').notNull().$type<'rejected' | 'deferred' | 'bypassed' | 'warned' | 'stranded' | 'accepted'>(),
  // normalizeErrorSignature() of the caller-facing message — the SAME
  // normalizer get_failure_analytics clusters worker errors with, so a family
  // whose message embeds a branch name or an id collapses to one row here too.
  reason: text('reason').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  // 'api' | 'dashboard' | 'worker' | 'system'. Which door the call came in.
  callerOrigin: text('caller_origin'),
}, (t) => ({
  // The aggregation's access pattern: one workspace (or a team's set), one
  // window, grouped by gate.
  workspaceOccurredIdx: index('gate_events_workspace_occurred_idx').on(t.workspaceId, t.occurredAt),
  gateOccurredIdx: index('gate_events_gate_occurred_idx').on(t.gate, t.occurredAt),
  taskIdx: index('gate_events_task_idx').on(t.taskId),
}));

/**
 * One row per capability decision about an agent run: a GitHub repo grant or
 * model endpoint handed to a runner, a per-task token minted, a PR recorded,
 * closed or merged — allowed or refused, and why. Answers "why was worker X
 * allowed to do Y" from data instead of logs.
 *
 * Never holds credential material: no token, no key, no header. `resource`
 * names the thing acted on (`github_repo:<row id>`, `pr:<number>`), and
 * `sideEffect` records what actually happened when it is known (e.g. the PR
 * number a create produced). Written fire-and-forget by
 * apps/web/src/lib/agent-capabilities/audit.ts; pruned after 90 days by the
 * task-archive sweep.
 */
export const agentCapabilityDecisions = pgTable('agent_capability_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  // How the run proved itself: 'dispatch' | 'runner_key' | 'task_token' | 'worker_account'.
  principalVia: text('principal_via'),
  // 'github.repo_grant' | 'model.endpoint' | 'task_token.mint' | 'pr.create' | 'pr.adopt' | 'pr.close' | 'pr.merge'
  capability: text('capability').notNull(),
  resource: text('resource'),
  decision: text('decision').notNull().$type<'allowed' | 'refused'>(),
  reasonCode: text('reason_code'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  sideEffect: jsonb('side_effect').$type<Record<string, unknown>>(),
}, (t) => ({
  workerOccurredIdx: index('agent_capability_decisions_worker_occurred_idx').on(t.workerId, t.occurredAt),
  workspaceOccurredIdx: index('agent_capability_decisions_workspace_occurred_idx').on(t.workspaceId, t.occurredAt),
  occurredIdx: index('agent_capability_decisions_occurred_idx').on(t.occurredAt),
}));

export type AgentCapabilityDecision = typeof agentCapabilityDecisions.$inferSelect;

export const gateEventsRelations = relations(gateEvents, ({ one }) => ({
  workspace: one(workspaces, { fields: [gateEvents.workspaceId], references: [workspaces.id] }),
  mission: one(missions, { fields: [gateEvents.missionId], references: [missions.id] }),
  task: one(tasks, { fields: [gateEvents.taskId], references: [tasks.id] }),
  worker: one(workers, { fields: [gateEvents.workerId], references: [workers.id] }),
}));

export type GateEvent = typeof gateEvents.$inferSelect;
export type NewGateEvent = typeof gateEvents.$inferInsert;

/**
 * Audit trail of deployment actions buildd runs server-side with a stored
 * deploy credential, and of every plaintext reveal of one
 * (apps/web/src/lib/deployments, docs/specs/deployment-actions.md).
 *
 * Unlike gate_events this is not fire-and-forget: the row is written BEFORE
 * the credential is used (outcome 'started') and settled afterwards, and a
 * request whose row cannot be written does not run. A crash mid-deploy
 * therefore still leaves a 'started' row.
 *
 * Holds the credential REFERENCE (a label) only. There is no column a
 * credential value could go in, and `result` is built field by field from an
 * allowlist, never copied from a provider response.
 */
export const deploymentAuditEvents = pgTable('deployment_audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  // Null only for a reveal, which is team-wide.
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  // 'operator': an agent role acting under its workspace grant.
  // 'admin': a human's admin API key, the escape hatch.
  principal: text('principal').notNull().$type<'operator' | 'admin'>(),
  roleSlug: text('role_slug'),
  operation: text('operation').notNull(),
  capabilities: jsonb('capabilities').$type<string[]>().notNull(),
  // True when an elevated capability (secrets:reveal, deployment_secrets:manage) was exercised.
  elevated: boolean('elevated').default(false).notNull(),
  provider: text('provider'),
  project: text('project'),
  environment: text('environment'),
  credentialRef: text('credential_ref'),
  outcome: text('outcome').notNull().$type<'started' | 'denied' | 'succeeded' | 'failed'>(),
  reason: text('reason'),
  result: jsonb('result').$type<Record<string, unknown>>(),
}, (t) => ({
  workspaceOccurredIdx: index('deployment_audit_events_workspace_occurred_idx').on(t.workspaceId, t.occurredAt),
  teamOccurredIdx: index('deployment_audit_events_team_occurred_idx').on(t.teamId, t.occurredAt),
  taskIdx: index('deployment_audit_events_task_idx').on(t.taskId),
}));

export type DeploymentAuditEvent = typeof deploymentAuditEvents.$inferSelect;
export type NewDeploymentAuditEvent = typeof deploymentAuditEvents.$inferInsert;

/**
 * One row per worker session end, on every path — completed, failed, the
 * output-requirement gate refusing a completion, and a runner process death
 * reconciled at the next startup. See packages/core/terminal-records.ts.
 *
 * `workerId` is unique: a worker's session ends exactly once, so a second write
 * for the same worker (a retried reconciliation, a duplicate refusal) is a
 * dedupe, not a new event — recordSessionTerminal upserts via
 * onConflictDoNothing rather than allowing the row to fork.
 */
export const workerTerminalRecords = pgTable('worker_terminal_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  workerId: uuid('worker_id').notNull().references(() => workers.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  // 'completed' | 'failed' | 'refused' | 'crashed' — see TERMINAL_OUTCOMES in
  // packages/core/terminal-records.ts. 'refused' and 'crashed' are not worker
  // statuses (the worker row itself still lands on 'completed'/'failed') — they
  // are the two SESSION shapes a plain status can't tell apart: a completion
  // the output-requirement gate refused, and a process that died without ever
  // reporting.
  outcome: text('outcome').notNull().$type<'completed' | 'failed' | 'refused' | 'crashed'>(),
  // normalizeErrorSignature() of the exit cause — the SAME normalizer
  // gate_events.reason and get_failure_analytics use, so one failure family is
  // one signature everywhere, never re-normalized downstream.
  exitCause: text('exit_cause'),
  turns: integer('turns'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: decimal('cost_usd', { precision: 10, scale: 6 }),
  durationMs: integer('duration_ms'),
  // Whether a PR or artifact shipped from this session — the "was there
  // anything to show" bit orphan-rate and refusal audits need without a join.
  shipped: boolean('shipped').notNull().default(false),
  // 'agent' | 'fallback' | null — same vocabulary as workers.summarySource.
  summaryProvenance: text('summary_provenance'),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
}, (t) => ({
  workerIdx: uniqueIndex('worker_terminal_records_worker_idx').on(t.workerId),
  workspaceOccurredIdx: index('worker_terminal_records_workspace_occurred_idx').on(t.workspaceId, t.occurredAt),
  outcomeOccurredIdx: index('worker_terminal_records_outcome_occurred_idx').on(t.outcome, t.occurredAt),
}));

export const workerTerminalRecordsRelations = relations(workerTerminalRecords, ({ one }) => ({
  worker: one(workers, { fields: [workerTerminalRecords.workerId], references: [workers.id] }),
  task: one(tasks, { fields: [workerTerminalRecords.taskId], references: [tasks.id] }),
  workspace: one(workspaces, { fields: [workerTerminalRecords.workspaceId], references: [workspaces.id] }),
}));

export type WorkerTerminalRecord = typeof workerTerminalRecords.$inferSelect;
export type NewWorkerTerminalRecord = typeof workerTerminalRecords.$inferInsert;

// smoke-test-3-ci-retry-1 20260725

export type CronRun = typeof cronRuns.$inferSelect;
export type NewCronRun = typeof cronRuns.$inferInsert;

// ── Orchestration decision / outcome ledger ──────────────────────────────────
//
// knowledge-base: buildd/design/conflict-aware-orchestration.md §5–§6. One row per look by an
// orchestration decision (creation-time scope prediction, claim-time
// hold/start), written by packages/core/orchestration-decision.ts. Content-free:
// ids, versions, the definition fingerprint, a candidate-set digest, opaque
// labels (anything else is stored hashed) and numbers. The readout groups by
// (decision_id, fingerprint, candidate_policy_version, model, experiment_arm).
// Written best-effort after the decision; a failed insert costs a row, never
// the caller's request. Only workspace/team are FKs that cascade: the task row
// may be deleted while its decision history stays useful as a censored label.
export const orchestrationDecisions = pgTable('orchestration_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  missionId: uuid('mission_id'),
  taskId: uuid('task_id'),
  workerId: uuid('worker_id'),
  // The outcome-join keys, when the decision was about a PR.
  prNumber: integer('pr_number'),
  headSha: text('head_sha'),
  baseRef: text('base_ref'),
  baseSha: text('base_sha'),
  // The inference capability that gated spend (orchestration_manifest | orchestration_claim).
  capability: text('capability').notNull(),
  // defineDecision identity: namespaced id, `promptVersion|model|engine-N`, 12-hex fingerprint.
  decisionId: text('decision_id').notNull(),
  decisionVersion: text('decision_version').notNull(),
  fingerprint: text('fingerprint').notNull(),
  question: text('question').notNull(),
  // Pick index within a repeated choice (§5a); 0 for a single question.
  step: integer('step').notNull().default(0),
  // The kit policy for the question at the time: shadow | gated | live, and its threshold.
  mode: text('mode').notNull().$type<'shadow' | 'gated' | 'live'>(),
  minConfidence: real('min_confidence'),
  // The model that actually answered (a team may route to a non-Jev model; it never applies).
  model: text('model'),
  candidatePolicyVersion: text('candidate_policy_version').notNull(),
  candidateDigest: text('candidate_digest').notNull(),
  candidateCount: integer('candidate_count').notNull(),
  candidateTruncated: boolean('candidate_truncated').notNull().default(false),
  ruleVerdict: text('rule_verdict'),
  suggested: text('suggested'),
  confidence: real('confidence'),
  effective: text('effective'),
  applied: boolean('applied').notNull().default(false),
  status: text('status').notNull().$type<'applied' | 'suggested' | 'fallback'>(),
  // fallback: capability_disabled | missing_key | retrieval_error | no_candidates | deadline | invalid | error
  // suggested: shadow | below_threshold | non_jev | not_in_cohort
  reason: text('reason'),
  errorKind: text('error_kind'),
  latencyMs: integer('latency_ms').notNull(),
  retrievalMs: integer('retrieval_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: real('cost_usd'),
  // Applying-cohort assignment, recorded at draw time (never reconstructed).
  experimentArm: text('experiment_arm').notNull().$type<'apply' | 'observe'>(),
  propensity: real('propensity').notNull(),
  applyingFraction: real('applying_fraction').notNull(),
  // The kit's content-free DecisionReceipt (model, usage, latency, attempts).
  receipt: jsonb('receipt').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceCreatedIdx: index('orchestration_decisions_workspace_created_idx').on(t.workspaceId, t.createdAt),
  decisionGroupIdx: index('orchestration_decisions_group_idx').on(t.decisionId, t.fingerprint, t.experimentArm),
  taskIdx: index('orchestration_decisions_task_idx').on(t.taskId),
}));

export type OrchestrationDecision = typeof orchestrationDecisions.$inferSelect;
export type NewOrchestrationDecision = typeof orchestrationDecisions.$inferInsert;

// ── Decision ledger (generic) ────────────────────────────────────────────────
//
// knowledge-base: buildd/design/decision-calls.md "The decision ledger". One row
// per decision-call attempt for a capability that is not already covered by its
// own specialized table (orchestration's hold/start and manifest decisions keep
// writing to `orchestration_decisions`, which carries cohort/propensity fields
// this table does not need). Written by packages/core/decision-ledger.ts,
// best-effort after the decision; a failed insert costs a row, never the
// caller's request. Content-free beyond the inputs fingerprint and opaque
// labels: no task title, description or criterion text.
export const decisionRecords = pgTable('decision_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  missionId: uuid('mission_id'),
  taskId: uuid('task_id'),
  // The opt_in/built_in InferenceCapability id (e.g. 'task_role_shadow', 'mission_goal_quality').
  capability: text('capability').notNull(),
  // A hash of the inputs the model actually saw (state + question set), so two
  // looks at the same facts are recognizably the same decision.
  fingerprint: text('fingerprint').notNull(),
  promptVersion: text('prompt_version'),
  model: text('model'),
  minConfidence: real('min_confidence'),
  // The deterministic rule's answer, when the site has one (null where there is
  // no prior rule — e.g. role inference had no default before Jev).
  ruleAnswer: text('rule_answer'),
  // What Jev answered, and how confident it was. Null on a failed/fallback call.
  verdict: text('verdict'),
  confidence: real('confidence'),
  // The answer actually in effect after the gate: the rule's answer on fallback,
  // Jev's answer when applied.
  appliedAnswer: text('applied_answer'),
  applied: boolean('applied').notNull().default(false),
  status: text('status').notNull().$type<'applied' | 'suggested' | 'fallback'>(),
  // fallback: capability_disabled | missing_key | timeout | provider_error | parse | no_candidates
  // suggested: below_threshold | not_candidate | unmeasured_model | lost_race | rail_blocked
  reason: text('reason'),
  latencyMs: integer('latency_ms'),
  inputTokens: integer('input_tokens'),
  costUsd: real('cost_usd'),
  // A later human correction of an applied verdict, if any. Set together.
  humanOverride: jsonb('human_override').$type<Record<string, unknown>>(),
  overriddenAt: timestamp('overridden_at', { withTimezone: true }),
  overriddenBy: uuid('overridden_by'),
  // Decision-kind fields (packages/core/decision-policy.ts), null on rows from
  // call sites that predate kinds. The readout groups and counts by these.
  policyVersion: text('policy_version'),
  provider: text('provider'),
  // Model attempts made (cheap + escalation); 0 for a rule or a no-route fallback.
  attemptCount: integer('attempt_count'),
  escalated: boolean('escalated').notNull().default(false),
  // Why nothing was applied, by owner: capability (team switch off) | key (no
  // key/route) | provider (every attempt failed). Null when nothing failed.
  failureClass: text('failure_class').$type<'capability' | 'key' | 'provider'>(),
  // What the decision was about (DecisionSubjectRef): outcomes are labelled by subject.
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  // Set only when the call's assignment came from experiment-randomizer.ts;
  // the readout reports causal lift for these rows and no others.
  experimentId: text('experiment_id'),
  experimentArm: text('experiment_arm'),
  propensity: real('propensity'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceCreatedIdx: index('decision_records_workspace_created_idx').on(t.workspaceId, t.createdAt),
  capabilityCreatedIdx: index('decision_records_capability_created_idx').on(t.capability, t.createdAt),
  taskIdx: index('decision_records_task_idx').on(t.taskId),
  subjectIdx: index('decision_records_subject_idx').on(t.teamId, t.capability, t.subjectType, t.subjectId),
}));

export type DecisionRecord = typeof decisionRecords.$inferSelect;
export type NewDecisionRecord = typeof decisionRecords.$inferInsert;

// Late outcome labels for decision_records (packages/core/decision-outcomes.ts).
// The decision row is never rewritten: a label is its own row, first write wins
// per (decision, source), and a later different label for the same pair is
// reported as a conflict rather than overwriting.
export const decisionOutcomes = pgTable('decision_outcomes', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionRecordId: uuid('decision_record_id').references(() => decisionRecords.id, { onDelete: 'cascade' }).notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  capability: text('capability').notNull(),
  // Who labelled: an adapter id ('task_terminal', 'pr_merged') or 'human'.
  source: text('source').notNull(),
  // The kind's outcome vocabulary, e.g. 'correct' | 'wrong' | 'merged'. Read by the kind's objective callback.
  label: text('label').notNull(),
  value: real('value'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  decisionSourceIdx: uniqueIndex('decision_outcomes_decision_source_idx').on(t.decisionRecordId, t.source),
  teamCapabilityIdx: index('decision_outcomes_team_capability_idx').on(t.teamId, t.capability),
}));

export type DecisionOutcome = typeof decisionOutcomes.$inferSelect;

// Challenger runs against an applied decision (ai-kit runChallenger). Attempted
// or skipped-with-reason; never applied. One row per (decision, challenger).
export const decisionChallengerRuns = pgTable('decision_challenger_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionRecordId: uuid('decision_record_id').references(() => decisionRecords.id, { onDelete: 'cascade' }).notNull(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  capability: text('capability').notNull(),
  // Stable id of the challenger config (provider/model), the idempotency key.
  challengerKey: text('challenger_key').notNull(),
  status: text('status').notNull().$type<'attempted' | 'skipped'>(),
  skipReason: text('skip_reason'),
  provider: text('provider'),
  model: text('model'),
  modelVersion: text('model_version'),
  // The attempt's outcome: decided | below_threshold | unmeasured | failed.
  outcome: text('outcome'),
  decision: text('decision'),
  confidence: real('confidence'),
  appliedAnswer: text('applied_answer'),
  agrees: boolean('agrees'),
  failureKind: text('failure_kind'),
  latencyMs: integer('latency_ms'),
  costUsd: real('cost_usd'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  decisionChallengerIdx: uniqueIndex('decision_challenger_runs_decision_key_idx').on(t.decisionRecordId, t.challengerKey),
  teamCapabilityIdx: index('decision_challenger_runs_team_capability_idx').on(t.teamId, t.capability, t.createdAt),
}));

export type DecisionChallengerRun = typeof decisionChallengerRuns.$inferSelect;

// Prompt evals (apps/web/src/lib/prompt-evals/run.ts): the decision benchmark
// sets scored against the prompt text a deployment runs, or is about to run.
// One run row per eval, one result row per prompt id evaluated. Content-free like the
// decision ledger: prompt ids, row versions, content hashes, model ids, counts
// and rates. Never prompt text, case content or error strings; every result is
// checked against the loaded prompt bodies before it is written.
export const promptEvalRuns = pgTable('prompt_eval_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The team whose key paid for the calls.
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  trigger: text('trigger').notNull().$type<'push' | 'cron' | 'manual'>(),
  status: text('status').notNull().$type<'running' | 'passed' | 'failed' | 'refused' | 'skipped'>(),
  // The prompts repo ref scored (a sha for a push; else the configured ref).
  promptsRef: text('prompts_ref'),
  // The model that answered the decision prompts (the production model unless
  // a per-run override was given), and the model the team's live decisions use.
  evalModel: text('eval_model'),
  prodModel: text('prod_model'),
  // True only when an override differed: the scores then do not predict production behaviour.
  modelMismatch: boolean('model_mismatch').notNull().default(false),
  dryRun: boolean('dry_run').notNull().default(false),
  loadedPrompts: integer('loaded_prompts'),
  costUsd: real('cost_usd'),
  // Why the run failed or was skipped: fixed phrases naming ids and counts, never text.
  problems: jsonb('problems').$type<string[]>(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  startedIdx: index('prompt_eval_runs_started_idx').on(t.startedAt),
}));

export type PromptEvalRun = typeof promptEvalRuns.$inferSelect;

export const promptEvalResults = pgTable('prompt_eval_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').references(() => promptEvalRuns.id, { onDelete: 'cascade' }).notNull(),
  benchmarkSet: text('benchmark_set').notNull(),
  promptId: text('prompt_id').notNull(),
  // 'private' (a prompts-repo row) or 'public default'.
  promptSource: text('prompt_source').notNull(),
  // Row version (null for a public default) and the first 12 hex of the text's sha256.
  promptRowVersion: integer('prompt_row_version'),
  promptHash: text('prompt_hash').notNull(),
  // The decision promptVersion naming the text, e.g. `tc1+p3`.
  promptVersion: text('prompt_version').notNull(),
  model: text('model'),
  // no_eval_set: nothing to score it against (no_cases on older rows).
  status: text('status').notNull().$type<'scored' | 'dry_run' | 'no_eval_set' | 'no_cases'>(),
  cases: integer('cases').notNull(),
  accuracy: real('accuracy'),
  baselineAccuracy: real('baseline_accuracy'),
  coverageAt90: real('coverage_at_90'),
  accuracyAt90: real('accuracy_at_90'),
  errors: integer('errors').notNull().default(0),
  notRun: integer('not_run').notNull().default(0),
  costUsd: real('cost_usd'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  runIdx: index('prompt_eval_results_run_idx').on(t.runId),
  promptCreatedIdx: index('prompt_eval_results_prompt_created_idx').on(t.promptId, t.createdAt),
}));

export type PromptEvalResult = typeof promptEvalResults.$inferSelect;

// The final touched-file label for a decided task, one row per worker session,
// written at terminal worker status BEFORE workers.observed_touches is cleared
// (apps/web/src/app/api/workers/[id]/route.ts). Only for tasks that have an
// orchestration_decisions row, so it grows with the decisions, not with every
// worker. An empty array is a real observation (the session edited nothing);
// a missing row is a missing label. `truncated` = the observation hit the
// observed_touches cap and may be partial.
export const orchestrationTouchLabels = pgTable('orchestration_touch_labels', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
  // The worker's terminal status: completed | failed | error.
  workerStatus: text('worker_status').notNull(),
  touchedPaths: jsonb('touched_paths').$type<string[]>().notNull(),
  truncated: boolean('truncated').notNull().default(false),
  prNumber: integer('pr_number'),
  headSha: text('head_sha'),
  baseRef: text('base_ref'),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskWorkerIdx: uniqueIndex('orchestration_touch_labels_task_worker_idx').on(t.taskId, t.workerId),
  workspaceTaskIdx: index('orchestration_touch_labels_workspace_task_idx').on(t.workspaceId, t.taskId),
}));

export type OrchestrationTouchLabel = typeof orchestrationTouchLabels.$inferSelect;
export type NewOrchestrationTouchLabel = typeof orchestrationTouchLabels.$inferInsert;

// Live sibling conflict probes (apps/web/src/lib/sibling-conflict-probe.ts).
// One row per pair of live workers whose observed touches share a file. The
// cron finds the pair and asks the prober; the prober's runner, which has the
// clone, runs `git merge-tree` against the other branch on its next heartbeat
// and reports the result. The row is the request and the per-pair debounce;
// each result is also a `sibling_conflict_probe` gate event.
export type SiblingProbeStatus = 'requested' | 'dispatched' | 'done';
export type SiblingProbeOutcome = 'clean' | 'conflict' | 'mergiraf_resolved' | 'error';

export const siblingProbes = pgTable('sibling_probes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  // `${lowerWorkerId}:${higherWorkerId}`: one row per pair, whichever side found it.
  pairKey: text('pair_key').notNull(),
  workerAId: uuid('worker_a_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  workerBId: uuid('worker_b_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  // The worker whose runner runs the merge-tree: the one asked to rebase on a conflict.
  proberWorkerId: uuid('prober_worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  sharedFiles: jsonb('shared_files').$type<string[]>().notNull(),
  status: text('status').$type<SiblingProbeStatus>().notNull().default('requested'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  probedAt: timestamp('probed_at', { withTimezone: true }),
  outcome: text('outcome').$type<SiblingProbeOutcome | null>(),
  conflictFiles: jsonb('conflict_files').$type<string[] | null>(),
  // Last time both workers were told.
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  // The two branch heads (sorted, `sha:sha`) of the conflict both workers were
  // last told about. The same heads conflicting again are never re-sent.
  notifiedHeads: text('notified_heads'),
}, (t) => ({
  pairIdx: uniqueIndex('sibling_probes_pair_idx').on(t.workspaceId, t.pairKey),
  proberStatusIdx: index('sibling_probes_prober_status_idx').on(t.proberWorkerId, t.status),
}));

export type SiblingProbe = typeof siblingProbes.$inferSelect;

// Creation-time manifest predictions (knowledge-base: buildd/design/conflict-aware-orchestration.md
// §5a, packages/core/manifest-prediction.ts). One row per task per candidate
// policy, written in shadow AFTER the creation response for teams that opted in
// to `orchestration_manifest`. Each pick also writes a content-free
// orchestration_decisions row; THIS row holds what those rows cannot: the
// ranked candidate files (so a pick's opaque label maps back to a file), each
// pick's dynamic-definition fingerprint and offered-index map, the selection,
// truncation/unknown-scope markers, candidate coverage and the same-task
// baselines. It never feeds tasks.path_manifest or dependsOn.
/**
 * A task's expected size (packages/core/task-size-estimate.ts): the median
 * files/minutes of its completed neighbours, or — with fewer than `k` of
 * those (jev-scheduling §3's "coarser bucket fallback") — a Jev S/M/L bucket
 * mapped to representative figures (packages/core/task-size-bucket-decision.ts).
 */
export type ExpectedTaskSize =
  | {
      files: number;
      minutes: number;
      source: 'neighbours';
      /** Neighbours required. */
      k: number;
      /** Neighbours with a size that were used. */
      n: number;
    }
  | {
      files: number;
      minutes: number;
      source: 'jev';
      bucket: 'S' | 'M' | 'L';
      confidence: number;
    };

export const orchestrationManifestPredictions = pgTable('orchestration_manifest_predictions', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  decisionId: text('decision_id').notNull(),
  promptVersion: text('prompt_version').notNull(),
  candidatePolicyVersion: text('candidate_policy_version').notNull(),
  mode: text('mode').notNull().$type<'shadow' | 'gated' | 'live'>(),
  // The leakage cutoff: neighbours/diffs must predate the task's creation.
  taskCreatedAt: timestamp('task_created_at', { withTimezone: true }).notNull(),
  candidates: jsonb('candidates').$type<string[]>().notNull(),
  candidateSources: jsonb('candidate_sources').$type<string[]>().notNull(),
  candidateCount: integer('candidate_count').notNull(),
  candidateTruncated: boolean('candidate_truncated').notNull().default(false),
  candidateOmitted: integer('candidate_omitted').notNull().default(0),
  // { source, neighbours, neighboursUsed, excludedFuture, revision, revisionPinned, ... }
  coverage: jsonb('coverage').$type<Record<string, unknown>>().notNull(),
  // [{ step, fingerprint, decisionVersion, offered: number[], suggested, path, confidence, status, reason, applied }]
  picks: jsonb('picks').$type<Array<Record<string, unknown>>>().notNull(),
  selected: jsonb('selected').$type<string[]>().notNull(),
  // done | exhausted | pick_cap | deadline | fallback | no_candidates | invalid | missing_key | retrieval_deadline
  stopReason: text('stop_reason').notNull(),
  complete: boolean('complete').notNull().default(false),
  unknownScope: boolean('unknown_scope').notNull().default(true),
  allApplied: boolean('all_applied').notNull().default(false),
  pickCap: integer('pick_cap').notNull(),
  regexPaths: jsonb('regex_paths').$type<string[]>().notNull(),
  neighbourUnionPaths: jsonb('neighbour_union_paths').$type<string[]>().notNull(),
  // Confidence the selected set is right (jev-scheduling §3): the product of
  // the pick confidences, recalibrated later by the readout. Null when there
  // were no picks or any pick carried no confidence.
  setConfidence: real('set_confidence'),
  // { files, minutes, source, k, n } from completed neighbours
  // (task-size-estimate.ts). Null when fewer than k neighbours had a size.
  expectedSize: jsonb('expected_size').$type<ExpectedTaskSize>(),
  latencyMs: integer('latency_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  taskPolicyIdx: uniqueIndex('orchestration_manifest_predictions_task_policy_idx').on(t.taskId, t.candidatePolicyVersion),
  workspaceCreatedIdx: index('orchestration_manifest_predictions_workspace_created_idx').on(t.workspaceId, t.createdAt),
}));

export type OrchestrationManifestPrediction = typeof orchestrationManifestPredictions.$inferSelect;
export type NewOrchestrationManifestPrediction = typeof orchestrationManifestPredictions.$inferInsert;

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

// Stored Jev "is this overlap real" answers (jev-scheduling.md §5,
// packages/core/orchestration-overlap-decision.ts): one row per task pair per
// decision, asked once from the creation-manifest prediction hook for a new
// task's soft pairs (predicted scope overlapping a sibling's declared or
// predicted scope). Read by the claim-time planner (`planClaimBatch`'s
// `overlapAnswers`) keyed by `overlapPairKey(a, b)`; it only ever replaces a
// SOFT weight there and never creates or removes a hard edge — it is not
// consulted by, and never writes, `tasks.path_manifest` or `dependsOn`.
export const orchestrationOverlapAnswers = pgTable('orchestration_overlap_answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  missionId: uuid('mission_id'),
  // Order-independent pair identity: `overlapPairKey(taskAId, taskBId)` (packages/core/claim-planner.ts).
  pairKey: text('pair_key').notNull(),
  taskAId: uuid('task_a_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  taskBId: uuid('task_b_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  decisionId: text('decision_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  answer: text('answer').notNull().$type<'REAL' | 'NOT_REAL'>(),
  confidence: real('confidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // One stored answer per pair per decision; a later ask for the same pair replaces it.
  pairDecisionIdx: uniqueIndex('orchestration_overlap_answers_pair_decision_idx').on(t.workspaceId, t.pairKey, t.decisionId),
  workspaceCreatedIdx: index('orchestration_overlap_answers_workspace_created_idx').on(t.workspaceId, t.createdAt),
}));

export type OrchestrationOverlapAnswer = typeof orchestrationOverlapAnswers.$inferSelect;
export type NewOrchestrationOverlapAnswer = typeof orchestrationOverlapAnswers.$inferInsert;

/**
 * Quality Scout run ledger (artifact workspace-quality-scout-spec §3, §12).
 * One row per Scout run. `candidate_sha` is the exact commit the probes
 * exercised — staleness is "a newer SHA exists on candidate_ref", and the
 * prior run pointer answers "what changed since". Results themselves are
 * shared-substrate VerificationResults on the probe rows.
 *
 * Advisory only (v1): nothing reads these tables to block a merge or release.
 */
export const qualityScoutRuns = pgTable('quality_scout_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
  trigger: text('trigger').notNull().$type<import('../quality-scout/types').ScoutRunTrigger>(),
  // The mode in effect at start; a later config change never reinterprets it.
  mode: text('mode').notNull().$type<import('../quality-scout/types').ScoutRun['mode']>(),
  status: text('status').notNull().default('running').$type<import('../quality-scout/types').ScoutRunStatus>(),
  candidateRef: text('candidate_ref').notNull(),
  candidateSha: text('candidate_sha').notNull(),
  // Plain uuid, not an FK: pruning an old run must not rewrite a newer one.
  priorRunId: uuid('prior_run_id'),
  priorSha: text('prior_sha'),
  budget: jsonb('budget').notNull().$type<import('../quality-scout/types').ScoutBudget>(),
  policyVersion: text('policy_version').notNull(),
  candidatesGenerated: integer('candidates_generated'),
  probesSelected: integer('probes_selected'),
  probesSkipped: integer('probes_skipped'),
  // { total, pass, fail, inconclusive, unsupported } — written when the run ends.
  verdicts: jsonb('verdicts').$type<import('../quality-scout/types').ScoutRunTotals['verdicts'] | null>(),
  costUsd: decimal('cost_usd', { precision: 10, scale: 4 }),
  // Full operational readout (stage cost, actions, dedupe, staleness) — written when the run ends.
  metrics: jsonb('metrics').$type<import('../quality-scout/types').ScoutRunMetrics | null>(),
  error: text('error'),
  // Runner host (status 'awaiting_host'). host_state is frozen at park time:
  // the profile snapshot the server planned against, the plan summary finalize
  // needs, and the runner's duration bound. The candidate {ref, sha} is
  // candidate_ref/candidate_sha above. Kept after the run completes, for the readout.
  hostState: jsonb('host_state').$type<Pick<import('../quality-scout/types').ScoutRunParking, 'parkedAt' | 'runnerMaxDurationMs' | 'profile' | 'plan'> | null>(),
  // Past this, the hourly sweep finalizes unexecuted runner probes `unsupported`.
  hostDeadline: timestamp('host_deadline', { withTimezone: true }),
  // Empty until a runner claims the run; claims are an atomic UPDATE on these.
  hostLeaseHolder: text('host_lease_holder'),
  hostLeaseExpiresAt: timestamp('host_lease_expires_at', { withTimezone: true }),
  hostLeaseLapses: integer('host_lease_lapses').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceCreatedIdx: index('quality_scout_runs_workspace_created_idx').on(t.workspaceId, t.createdAt),
  workspaceRefIdx: index('quality_scout_runs_workspace_ref_idx').on(t.workspaceId, t.candidateRef, t.createdAt),
  // The parked-run queue: runner claims and the expiry sweep both scan it.
  statusHostDeadlineIdx: index('quality_scout_runs_status_host_deadline_idx').on(t.status, t.hostDeadline),
}));

export type QualityScoutRun = typeof qualityScoutRuns.$inferSelect;
export type NewQualityScoutRun = typeof qualityScoutRuns.$inferInsert;

/**
 * Every candidate a run considered — selected or skipped — with the probe
 * contract frozen before execution (spec §6) and, once run, its substrate
 * result. `verdict` and `signature` are lifted out of `result` for queries.
 */
export const qualityScoutProbes = pgTable('quality_scout_probes', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').references(() => qualityScoutRuns.id, { onDelete: 'cascade' }).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  candidateId: text('candidate_id').notNull(),
  family: text('family').notNull().$type<import('../quality-scout/types').ScoutProbeFamily>(),
  probeKind: text('probe_kind').notNull(),
  title: text('title').notNull(),
  invariant: text('invariant').notNull(),
  sourceSignals: jsonb('source_signals').notNull().$type<import('../quality-scout/types').ScoutSourceSignal[]>(),
  preconditions: jsonb('preconditions').notNull().$type<string[]>(),
  executor: text('executor'),
  estimatedCost: text('estimated_cost').notNull().$type<import('../quality-scout/types').ScoutCost>(),
  risk: text('risk').notNull().$type<import('../verification-check').VerificationSeverity>(),
  mutates: boolean('mutates').notNull().default(false),
  evidenceRequirements: jsonb('evidence_requirements').notNull().$type<import('../verification-check').EvidenceRequirement[]>(),
  unsupportedReason: text('unsupported_reason'),
  selection: jsonb('selection').notNull().$type<import('../quality-scout/types').ScoutProbeSelection>(),
  // Where the probe runs ('server' | 'runner'); null on a single-host run.
  host: text('host').$type<import('../quality-scout/types').ScoutProbeHost>(),
  verdict: text('verdict').$type<import('../verification-check').VerificationVerdict>(),
  signature: text('signature'),
  result: jsonb('result').$type<import('../verification-check').VerificationResult | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  runCandidateIdx: uniqueIndex('quality_scout_probes_run_candidate_idx').on(t.runId, t.candidateId),
  workspaceSignatureIdx: index('quality_scout_probes_workspace_signature_idx').on(t.workspaceId, t.signature),
}));

export type QualityScoutProbe = typeof qualityScoutProbes.$inferSelect;
export type NewQualityScoutProbe = typeof qualityScoutProbes.$inferInsert;

/**
 * One deduped Scout defect per (workspace, signature), across runs (spec §9–
 * §10). Only a `fail` creates or recurs a row; inconclusive/unsupported never
 * do, and only a `pass` of the same check resolves one. Writers merge through
 * `applyScoutFailure` and compare-and-set on `occurrence_count`.
 */
export const qualityScoutFindings = pgTable('quality_scout_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  signature: text('signature').notNull(),
  recurrenceKey: text('recurrence_key').notNull(),
  checkId: text('check_id').notNull(),
  family: text('family').notNull().$type<import('../quality-scout/types').ScoutProbeFamily>(),
  invariant: text('invariant').notNull(),
  severity: text('severity').notNull().$type<import('../verification-check').VerificationSeverity>(),
  confidence: real('confidence'),
  observed: text('observed'),
  evidenceRefs: jsonb('evidence_refs').notNull().$type<import('../verification-check').VerificationEvidenceRef[]>(),
  reproducibility: text('reproducibility').notNull().default('unknown').$type<import('../quality-scout/types').ScoutReproducibility>(),
  state: text('state').notNull().default('open').$type<import('../quality-scout/types').ScoutFindingState>(),
  actionState: text('action_state').notNull().default('none').$type<import('../quality-scout/types').ScoutActionState>(),
  actionTaskId: uuid('action_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  occurrenceCount: integer('occurrence_count').notNull().default(1),
  regressionCount: integer('regression_count').notNull().default(0),
  firstSeenRunId: uuid('first_seen_run_id').notNull(),
  firstSeenSha: text('first_seen_sha').notNull(),
  lastSeenRunId: uuid('last_seen_run_id').notNull(),
  lastSeenSha: text('last_seen_sha').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  resolvedRunId: uuid('resolved_run_id'),
  resolvedSha: text('resolved_sha'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  // Set together when state becomes 'dismissed'; the ledger's recurrence write never touches them.
  dismissedReason: text('dismissed_reason'),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  dismissedBy: text('dismissed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceSignatureIdx: uniqueIndex('quality_scout_findings_workspace_signature_idx').on(t.workspaceId, t.signature),
  workspaceCheckIdx: index('quality_scout_findings_workspace_check_idx').on(t.workspaceId, t.checkId, t.state),
  workspaceStateIdx: index('quality_scout_findings_workspace_state_idx').on(t.workspaceId, t.state, t.lastSeenAt),
}));

export type QualityScoutFinding = typeof qualityScoutFindings.$inferSelect;
export type NewQualityScoutFinding = typeof qualityScoutFindings.$inferInsert;

/**
 * Post-session quality loop — one row per (worker attempt, policy version).
 * Spec: artifact post-session-quality-loop-spec §4–§6, §12.
 *
 * The loop is out of band. This table is its ONLY write target for a run: no
 * stage may update the worker or task it describes, so a failure here can
 * never make finished work look unfinished.
 *
 * Idempotency lives in the unique (worker_id, policy_version) index: the
 * collector inserts with ON CONFLICT DO NOTHING and retries only a `failed`
 * (or crashed-`collecting`) row through a compare-and-set on `attempts`, so two
 * sweeps racing over the same worker produce one row and one collection.
 *
 * Stage A writes `facts` (bounded, no free text — see
 * packages/core/post-session-quality.ts); later stages fill the triage,
 * hard-trigger and trace-coverage columns on the same row.
 */
export const postSessionRuns = pgTable('post_session_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }).notNull(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
  policyVersion: text('policy_version').notNull(),
  // The workspace mode in effect when the run was created — a later mode
  // change must not reinterpret what an old run was allowed to do.
  mode: text('mode').notNull().$type<import('../post-session-quality').PostSessionQualityMode>(),
  state: text('state').notNull().default('collecting').$type<import('../post-session-quality').PostSessionRunState>(),
  // Collection attempts so far. The retry CAS keys on it.
  attempts: integer('attempts').notNull().default(1),
  facts: jsonb('facts').$type<import('../post-session-quality').StageAFacts | null>(),
  factsSchemaVersion: integer('facts_schema_version'),
  // Stage A metadata: does a transcript object exist. Not coverage.
  transcriptAvailability: text('transcript_availability').$type<import('../post-session-quality').TranscriptAvailability>(),
  // §12 coverage truth, written by whoever actually reads the transcript.
  // NULL = not established yet — never read as 'full'.
  traceAvailability: text('trace_availability').$type<import('../post-session-quality').TraceAvailability>(),
  traceSource: text('trace_source'),
  traceMissing: jsonb('trace_missing').$type<Record<string, unknown> | null>(),
  // Stage B. NULL until triage ran.
  triage: jsonb('triage').$type<import('../post-session-quality').PostSessionTriageRecord | null>(),
  hardTriggered: boolean('hard_triggered'),
  hardTriggerReasons: jsonb('hard_trigger_reasons').$type<string[] | null>(),
  // The final routing after hard-trigger override — what actually happened.
  finalDecision: text('final_decision').$type<import('../post-session-quality').TriageDecision>(),
  // Failure diagnostics. Bounded at write time; never cleared by a later
  // success so the history of a retried run stays readable.
  errorStage: text('error_stage').$type<import('../post-session-quality').PostSessionFailureStage>(),
  lastError: text('last_error'),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  collectedAt: timestamp('collected_at', { withTimezone: true }),
  triagedAt: timestamp('triaged_at', { withTimezone: true }),
  analysedAt: timestamp('analysed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workerPolicyIdx: uniqueIndex('post_session_runs_worker_policy_idx').on(t.workerId, t.policyVersion),
  workspaceCreatedIdx: index('post_session_runs_workspace_created_idx').on(t.workspaceId, t.createdAt),
  stateUpdatedIdx: index('post_session_runs_state_updated_idx').on(t.state, t.updatedAt),
  taskIdx: index('post_session_runs_task_idx').on(t.taskId),
}));

export type PostSessionRun = typeof postSessionRuns.$inferSelect;
export type NewPostSessionRun = typeof postSessionRuns.$inferInsert;

/**
 * Post-session finding ledger — one row per (workspace, signature, policy
 * version), aggregated across every session that exhibited it (spec §8–§9).
 * Recurrence, highest severity and action state live here so the action
 * policy can promote a repeated medium finding exactly once; the unique index
 * is what makes "same incident reprocessed" an upsert rather than a new row.
 */
export const postSessionFindings = pgTable('post_session_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }).notNull(),
  policyVersion: text('policy_version').notNull(),
  signature: text('signature').notNull(),
  // Broader family key, for "same kind of thing" readouts across signatures.
  recurrenceKey: text('recurrence_key'),
  class: text('class').notNull().$type<import('../post-session-quality').FindingClass>(),
  // Highest severity seen across occurrences.
  severity: text('severity').notNull().$type<import('../post-session-quality').FindingSeverity>(),
  // Highest confidence seen across occurrences.
  confidence: decimal('confidence', { precision: 4, scale: 3 }),
  title: text('title').notNull(),
  summary: text('summary'),
  proposedAction: text('proposed_action').notNull().$type<import('../post-session-quality').FindingProposedAction>(),
  occurrenceCount: integer('occurrence_count').notNull().default(1),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  // Capped by the writer; occurrenceCount stays exact past the cap.
  affectedRefs: jsonb('affected_refs').notNull().default([]).$type<import('../post-session-quality').FindingAffectedRef[]>(),
  evidenceRefs: jsonb('evidence_refs').notNull().default([]).$type<import('../post-session-quality').FindingEvidenceRef[]>(),
  // Run ids ever folded into this row, capped far above affectedRefs so the
  // dedup check in aggregateFindingOccurrence survives affectedRefs aging out.
  seenRunIds: jsonb('seen_run_ids').notNull().default([]).$type<string[]>(),
  actionState: text('action_state').notNull().default('observed').$type<import('../post-session-quality').FindingActionState>(),
  actionTaskId: uuid('action_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  actionArtifactId: uuid('action_artifact_id').references(() => artifacts.id, { onDelete: 'set null' }),
  actionAt: timestamp('action_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceSignaturePolicyIdx: uniqueIndex('post_session_findings_ws_signature_policy_idx').on(t.workspaceId, t.signature, t.policyVersion),
  workspaceRecurrenceIdx: index('post_session_findings_ws_recurrence_idx').on(t.workspaceId, t.recurrenceKey),
  actionStateIdx: index('post_session_findings_action_state_idx').on(t.actionState),
}));

export type PostSessionFinding = typeof postSessionFindings.$inferSelect;
export type NewPostSessionFinding = typeof postSessionFindings.$inferInsert;

/**
 * Failure Pattern Sentinel: one durable incident per systemic failure pattern.
 *
 * NOT a raw event table — the events stay in workers, worker_terminal_records
 * and gate_events. A row here is keyed by the rule engine's stable pattern
 * `signature` + `detector_version` (apps/web/src/lib/failure-pattern-sentinel.ts)
 * and carries only bounded pointers back to those rows. Written by
 * apps/web/src/lib/failure-incident-store.ts: insert is ON CONFLICT DO NOTHING
 * on the unique key and every update is a compare-and-swap on `version`, so two
 * sweeps racing on one pattern converge on one row (neon-http has no
 * interactive transactions).
 */
export const failureIncidents = pgTable('failure_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
  // `<rule>|ws=<id>|<discriminators>` — identity of the pattern, never of one occurrence.
  signature: text('signature').notNull(),
  // Bump instead of reshaping a signature in place; a new version is a new incident.
  detectorVersion: text('detector_version').notNull(),
  rule: text('rule').notNull().$type<FailureIncidentRule>(),
  reasonCode: text('reason_code').notNull(),
  title: text('title').notNull(),
  // Only ever raised on update; a reopen restarts from the rule's minimum.
  severity: text('severity').notNull().$type<FailureIncidentSeverity>(),
  status: text('status').notNull().default('open').$type<FailureIncidentStatus>(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  occurrenceCount: integer('occurrence_count').notNull().default(0),
  // Times it came back after `resolved`.
  recurrenceCount: integer('recurrence_count').notNull().default(0),
  affectedRefs: jsonb('affected_refs').$type<FailureIncidentAffectedRefs>().notNull().default({ taskIds: [], workerIds: [], prNumbers: [] }),
  evidenceRefs: jsonb('evidence_refs').$type<FailureIncidentEvidenceRef[]>().notNull().default([]),
  // Latest impact counters from the rule (a snapshot, overwritten per detection).
  impact: jsonb('impact').$type<Record<string, number>>().notNull().default({}),
  lastAlertedAt: timestamp('last_alerted_at', { withTimezone: true }),
  lastAlertSeverity: text('last_alert_severity').$type<FailureIncidentSeverity>(),
  linkedFixTaskId: uuid('linked_fix_task_id').references(() => tasks.id, { onDelete: 'set null' }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  // Optimistic-lock counter for the compare-and-swap update.
  version: integer('version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  signatureVersionIdx: uniqueIndex('failure_incidents_signature_version_idx').on(t.signature, t.detectorVersion),
  workspaceStatusSeenIdx: index('failure_incidents_workspace_status_seen_idx').on(t.workspaceId, t.status, t.lastSeenAt),
}));

export const failureIncidentsRelations = relations(failureIncidents, ({ one }) => ({
  workspace: one(workspaces, { fields: [failureIncidents.workspaceId], references: [workspaces.id] }),
  linkedFixTask: one(tasks, { fields: [failureIncidents.linkedFixTaskId], references: [tasks.id] }),
}));

export type FailureIncidentRow = typeof failureIncidents.$inferSelect;
export type NewFailureIncidentRow = typeof failureIncidents.$inferInsert;
