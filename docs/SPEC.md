# Buildd — Product & Architecture Spec

> **Status: canonical.** This is the single source of truth for what buildd *is*,
> derived from the code (schema + API routes + runner), not from marketing or docs.
> Downstream artifacts (`buildd-docs`, `buildd-site`, `knowledge-base`) are *outputs*
> of this spec, not inputs. When they disagree with this file, this file wins —
> and a drift task should be filed against them.
>
> **Derived from:** `packages/core/db/schema.ts`, `apps/web/src/app/api/**`,
> `apps/runner/**`, and the implemented specs in `docs/` (codex, credentials,
> knowledge-store), as of **2026-06-24** (§3a: **2026-09-26**).
> **Maintenance:** see `docs/SPEC.md` §10 and the `spec-sync` skill.

---

## 1. What buildd is

Buildd is a **task-coordination system for AI coding agents**. Humans (or agents)
declare goals; agents decompose them into tasks, claim them, execute on external
runners, and deliver outcomes (PRs, artifacts, research). The web app is
**coordination-only** — it stores state and brokers work but never runs agents
itself (Vercel can't host multi-minute agent executions; runners are external).
It does make short **server-side model calls** (chat turns, grading, visual QA
judgment, classification) on metered API keys — see §3a.

**Current product narrative:** *"Dispatch missions, not tasks."* Set an objective →
agents break it down, connect to your tools (MCP), and deliver. The user-facing
verbs are **Dispatch / Connect / Deliver**.

**Two execution backends** (pluggable, per-task): **Claude** (Agent SDK) and
**Codex** (OpenAI Codex SDK).

---

## 2. Domain model

The authoritative entity set is the 30 tables in `schema.ts`. Core entities:

### Team
Multi-tenancy root. Owns accounts, workspaces, missions. Tracks an **aggregate
monthly budget** (`monthlyBudgetUsd` / `monthlyCostUsd` / `budgetAlertsSent`) across
all token-accounts — a single SDK credit pool regardless of which API token ran.
Plans: `free | pro | team` (`teams.plan`, default `free`, plus Stripe customer /
subscription ids, `billingStatus` and `paidSeats`). Gates read only
`entitlements(team)` (`packages/core/entitlements.ts`): members, knowledge-base
document cap, and whether decision calls run on buildd's key. The `BILLING_ENFORCED`
env switch is off by default, and while off every team is unlimited.
Stripe is the billing system: the signed, event-id-idempotent webhook
(`POST /api/webhooks/stripe`, ledger `stripe_events`) is the only writer of plan,
billing status, subscription id and paid seats. Owners/admins (`manage_billing`,
locked) open Checkout, the customer portal, or change Team seats under
`/api/teams/[id]/billing/*`; Settings → Billing renders it. Team is per seat,
minimum 5; adding, inviting (pending invitations hold a seat) or accepting a member
past the paid seats is refused with a 402 that points the owner at adding seats,
never charged silently. Rules: `packages/core/billing.ts`.
When on (`packages/core/billing-limits.ts`): new `docs`-corpus documents past
`knowledgeBaseCap` (distinct files across the team's workspaces) are not ingested,
while updates to stored documents, the code index and recall are unaffected and
nothing stored is ever removed. Decision calls (not chat, not agent work) for a team
with no OpenRouter key of its own run on `BUILDD_PLATFORM_DECISION_KEY` (with Jev, or
`BUILDD_PLATFORM_DECISION_MODEL`) when `decisionCallsIncluded`; a team's own key
always wins.

### User
SSO identity (`googleId`, `githubId`, `email`). Belongs to teams via `team_members`
(`owner | admin | member`). Invited via `team_invitations`; only the invited
email may accept. Every team-role decision is a named permission in one
registry with per-team overrides (`docs/specs/team-permissions.md`): admins move
people between member and admin, only owners touch `owner` (assign, remove,
transfer), any member may leave except the last owner, and a person's keys drop
to what their new role may mint when their role drops or they leave. Members
may create personal agent roles, private until shared.

### Account
An API/OAuth client that claims and runs tasks. Two **auth types** with different
billing:
- **`api`** — pay-per-token (`bld_xxx` key). Cost-limited (`maxCostPerDay`, monthly budget).
- **`oauth`** — seat-based, session-limited (`maxConcurrentSessions`, `activeSessions`,
  `budgetExhaustedAt`/`budgetResetsAt`).

`type`: `user | service | action`. `level`: `trigger | worker | admin`. A team
typically has separate trigger vs. worker accounts. New API tokens carry explicit
named capabilities (`tasks:read`, `tasks:write`, `tasks:admin`, `workers:write`, `workers:admin`, `missions:admin`,
`analytics:read`, `releases`, `secrets`, `skills:admin`, `workspaces:admin`,
`schedules:write`, `knowledge:write`, `knowledge:admin`, `admin`) from runner, CI, analytics and admin
presets. REST authentication and MCP dispatch enforce the same vocabulary;
optional workspace restrictions never widen team access. Expiry applies on cache
hits, and successful authentication records last use at most once per minute.
`scopes = NULL` retains legacy level behavior. A scoped token's stored level is
derived from its scopes (`admin` only with the `admin` scope). Every in-handler
gate that legacy tokens pass with `level = admin` requires an explicit admin-tier
capability from a scoped token, never the route's ordinary scope (force merge and
force claim need `admin`). Workspace-restricted tokens cannot access team-wide
credentials or reports lacking real workspace filters, and every surface that
picks workspaces itself (claim candidates, reach lists, ingest jobs) is bounded
by the token's list. An unrestricted token is auto-linked to open workspaces
only; linking a token to a restricted workspace takes `manage_team_keys` (owner or admin by default). `account_workspaces` is the
M2M grant of which workspaces an account `canClaim` / `canCreate` from.

A per-task token (`bldt_`) is confined to its own task's workspace. The one
exception is a **schedule delegation** (`task_schedules.delegation`,
`packages/core/token-delegation.ts`): a holder of `delegate_schedule_access` (owner or admin by default) may grant the tasks
one schedule spawns `analytics:read` (decision ledger, decision/coordination stats,
gate ledger, workspace name resolution) and/or `tasks:create` (the normal create
path, no mission, dependencies or foreign parent) on named workspaces of the same
team. It is stored on the schedule, never the task, records who granted it and
when, is re-read on every request, and never exceeds the minting account's reach.
Analytics reads a reviewer depends on report `status` — `OK` / `NO_DATA` reached
the data; `FORBIDDEN` / `UNAUTHORIZED` / `TOOL_UNAVAILABLE` did not and are never
evidence of zero rows.

> **Deprecated:** the `accounts.oauthToken` column — credentials now live in the
> `secrets` table. Kept for back-compat, slated for removal. The parallel
> `anthropicApiKey` column has already been dropped.

### Workspace
A repo + config boundary. Holds tasks, workers, missions, roles/skills, schedules.
Key config (all JSONB, migration-free to evolve):
- **`gitConfig`** (`WorkspaceGitConfig`) — branching strategy, commit style, PR/merge
  behavior, agent instructions, sandbox, model/thinking/effort defaults,
  **`defaultBackend`** (`claude | codex`), CI auto-retry (`maxCiRetries`), and
  **`mergePolicy`** — the merge-policy tier (§4a). The legacy `autoMerge*` flags are
  not consulted by `resolvePolicy`. Hand-written path lists (`autoMergeDenyPaths`,
  `escalateToPaths`, `threshold.denyPaths`, `policyConfig.riskClasses[].userPaths`) are
  refused on every write with a 400 pointing at "Re-scan repo"; merge-policy paths are
  auto-detected only (`policyConfig`). A legacy stored `denyPaths` / `escalateToPaths` is
  still read by the merge gate for one fallback release.
- **`policyConfig`** (`WorkspacePolicyConfig`) — risk classes (`destructive_schema_change`,
  `ci_deploy_config`, `auth_and_secrets`, `dependency_bump`, `public_api_contract`) and a
  preset (`cautious | balanced | autonomous`) that assigns each class an action
  (`auto | agent-review | human`). Paths per class are detected by `POST /policy-init`
  and refreshed by re-scanning (settings "Re-scan repo" shows the per-class diff first).
  `destructive_schema_change` fires on the EXPAND/CONTRACT migration verdict
  (`migration-safety.ts`), not on path alone: additive migrations do not trigger it.
  Also carries `reviewerPatchEvidence` (opt-in: pre-inject the PR patch into the
  reviewer task, §4a).
- **`releaseConfig`** (`WorkspaceReleaseConfig`) — release strategy
  (`workflow_dispatch | branch_merge | script`), deploy target, post-deploy hooks,
  verification URL.
- **`webhookConfig`**, **`discordConfig`**, **`slackConfig`** — external dispatch/notify.
- `accessMode`: `open` (open within the owning team: the team's tokens claim; another team's only through an explicit link) | `restricted` (linked accounts only).

### Mission
A first-class **goal** that aggregates tasks. Status: `active | paused | completed |
archived` (lifecycle is stored; *health* is derived from task state via
`deriveMissionHealth`, not stored).

**How an auto mission moves** (`docs/design/event-driven-mission-replanning.md`,
`docs/specs/mission-heartbeat-schedule-lifecycle.md` § Role): events plan the
next step. A task of the mission reaching a terminal state re-plans through
`maybeRetriggerMission`; a dependency met, a resume, a budget raise, a PR merged
by webhook, or an owner note or answer re-plans through `wakeMission`. The
heartbeat (check-in) schedule does not drive progress. It is an hourly,
token-free backstop that dispatches the organizer (`triggerSource: 'backstop'`)
only when `isMissionStuck` holds: the state changed, nothing is open or
planning, and no organizer run started within `BACKSTOP_GRACE_MS` (2 hours).
Every new auto mission gets one by default; `isHeartbeat: false` opts out.

Notable fields:
- **`workingBranch`** + `primaryPrNumber`/`primaryPrUrl` — the mission's **integration
  branch** (shape `mission/<slug>-<id8>`, generated lazily once the mission's workspace
  has a repo) and the mission-level PR that tracks it. Mission tasks do **not** share a
  branch: every task gets its own branch and its own PR, always. `workingBranch` is the
  **base** those task PRs are cut from only for a mission with
  `missions.integrationBranchEnabled` set. That flag is resolved once, when the mission is
  created (`POST /api/missions`, which every creation path goes through: dashboard, MCP
  `manage_missions`, chat, discrepancy promotion), from the request's `branchStrategy`
  or else the workspace's `gitConfig.branchStrategy` via `resolveBranchStrategy`, which
  resolves an unconfigured workspace to **`mission-branch`** — so a new mission is on the
  integration branch by default, and `direct` is the opt-out. (The column's own DB default
  of `false` is never what a new mission gets; it only describes rows created before the
  workspace default existed.) An existing mission's flag is the runtime truth from then
  on; changing the workspace default never retargets it. For a mission-branch mission the
  task PRs merge into the integration branch, and the mission's work reaches trunk
  through a single PR from that branch — the mission integration PR, which is the
  mission's one human gate. That PR is opened automatically: when a task PR merges,
  the `pull_request` webhook calls `maybeOpenMissionIntegrationPr`, which opens it
  (via `openMissionIntegrationPr`) once no deliverable task of the mission is left
  unfinished or unmerged. A `direct` mission (`integrationBranchEnabled` false) behaves as
  missions did before the integration branch existed: each task PR targets the workspace's
  trunk branch and nothing retargets it.
  `primaryPrNumber`/`primaryPrUrl` are reserved for a **trunk-based** PR under the
  mission, i.e. the mission integration PR where one exists; a PR based on the mission
  branch never claims the slot. Both fields stay null for workspace-less missions.
- `scheduleId` — link to a `task_schedule` for recurring missions. **Lifecycle rule:** heartbeat schedules are owned by their mission. An *explicit* status write to `completed` or `archived` (dashboard / MCP) **deletes** the linked schedule; an *automated* completion through `completeMissionIfVerified` **disables** it (`enabled = false`) instead, so a mission that later reopens — or one refused by the goal-criteria gate — keeps its heartbeat. When the mission is `paused`, the schedule is disabled (not deleted). When the mission is re-activated (`active`), the schedule is re-enabled. A transition to `budget_exhausted` deliberately does neither (the cron dispatcher defers instead of disabling, because a budget-raise auto-resume flips status back to `active` but does not re-enable schedules — disabling here would strand the mission dormant). Deleting a mission also deletes its schedule. Either way a heartbeat schedule cannot outlive the mission that owns it — **except the auto-archive path** (`archiveStaleDoneMissions`), which today writes `archived` without deleting the schedule it leaves disabled; this is a known gap, not an intended fifth case — see `docs/specs/mission-heartbeat-schedule-lifecycle.md` and `knowledge-base: buildd/reports/mission-heartbeat-schedule-lifecycle-audit.md`.
- **`goalCriteria`** (jsonb) + **`goalCriteriaState`** (jsonb) + `autoVerify` — the
  completion gate. `goalCriteria` is a list of outcome criteria
  (`command | all_prs_merged | no_open_tasks | artifact_exists | description`);
  `goalCriteriaState` stores the last verdict per criterion plus a folded
  `overall`. **A mission MUST NOT be closed by any automated path unless
  `overall = 'pass'`** — completion requests a verdict, the verdict gates
  completion, and the absence of a verdict (`NOT_EVALUATED`, `PENDING`,
  `UNVERIFIED`) is never a pass. A mission whose work is finished but whose
  criteria have not passed stays `active` and renders as *awaiting verification*:
  it keeps its heartbeat and is exempt from auto-archive. `command` criteria are
  verified by RUNNING the command (a dispatched verification task whose exit code
  is the verdict), never by asking a model. `autoVerify = false` suppresses
  automatic evaluation only — on-demand evaluation still works, and the mission
  stays gated until someone asks. See `docs/specs/mission-task-lifecycle.md`
  § Mission Completion Gate.
- `parentMissionId` — sub-missions.
- `requiresReview` — human review gate before merge.
- `defaultOutputRequirement`, `maxConcurrentTasks`, `contextArtifactIds`.
- **`activeHoursStart` / `activeHoursEnd` / `activeHoursTimezone`** — restrict
  the window in which the mission's heartbeat schedule fires (0–23 hour range,
  IANA timezone string). When set, the cron skips firing outside the window.
  Used to implement calendar-seasonal dormancy (e.g., annual-cycle missions that
  are active Jan–Mar only): the mission stays `status = 'active'` year-round
  while the heartbeat self-suppresses outside the season. See the dormancy
  pattern in `docs/specs/mission-task-lifecycle.md`.
- **`workspaceId`** (nullable) — a mission with `workspaceId = null` is valid.
  Used for personal-agent missions (financial tasks, email triage) and
  cross-workspace coordination. `workingBranch` and `primaryPrNumber` are
  inapplicable for workspace-less missions (always null). Task creation from a
  workspace-less mission requires the organizer or heartbeat agent to supply an
  explicit `workspaceId` on each created task — there is no automatic inference.
  See `docs/specs/mission-task-lifecycle.md` for workspace-less mission invariants.

### Task
A concrete unit of work. `status` defaults `pending` (lifecycle:
pending → claimed/assigned → in_progress → review → completed/failed). Key axes:
- **`mode`**: `execution | planning` (planning tasks produce a plan, not code).
- **`outputRequirement`**: `pr_required | artifact_required | none | auto` — enforced
  on completion. `outputSchema` drives SDK structured output.
- **`runnerPreference`** (`any | user | service`, plus the legacy stored value
  `action` from the removed GitHub Actions runner, which the dashboard no
  longer offers) +
  **`roleSlug`** — claim-time routing constraints. `roleSlug` is nullable: when
  set, only runners that advertise this skill in `availableSkills` can claim the
  task; when null, any runner with workspace access can claim it. **Null is the
  normal case for dashboard-created tasks** — most carry no `roleSlug` at all.
  The dashboard's `/skill` typeahead stores
  the chosen skill in `context.skillSlugs` (advisory JSON field on the task)
  rather than in `roleSlug`. `context.skillSlugs` tells the executing agent
  which skill prompt to load but does NOT restrict which runner can claim the
  task. `roleSlug`-based routing is primarily used by MCP `create_task` with
  an explicit `roleSlug`, the organizer agent, and schedules.
  — `requiredCapabilities` (`string[]`) still exists as a schema column
  (`packages/core/db/schema.ts`) but is **no longer enforced at claim time** (removed
  in PR #1864). It is a candidate for schema removal — see "Removed concepts" below.
- **`backend`** (`claude | codex`, enum, default `claude`) — which agent runs it.
- **`dependsOn`** (task IDs) — workflow DAG; task isn't claimable until deps complete.
- **`missionId`**, `parentTaskId`, `category`, `project`, `priority`.
- **Smart routing:** `kind` (`coordination | engineering | research | writing | design
  | analysis | observation`), `complexity` (`simple | normal | complex`),
  `predictedModel`, `classifiedBy` (`organizer | classifier | user | default`).
- **Release:** `release` (`true | false | inherit`) + `releaseResult`.
- **`requiresReview`** — a per-task human gate. Set on the task (or inherited from its
  mission) it forces tier `human` for that PR regardless of the workspace tier (§4a).
- `creationSource`: `dashboard | api | mcp | github | local_ui | schedule | webhook | orchestrator`.

### Worker
An agent execution **session** on a task (a runner claims a task → spawns a worker).
Holds all telemetry: `status`, `waitingFor` (question to user), `costUsd`,
input/output tokens, `turns`, `milestones`, git stats (commits/files/lines),
`prUrl`/`prNumber`, `resultMeta` (SDK result), `mcpCalls` log, `pendingInstructions` +
`instructionHistory` (admin nudges; an entry is marked delivered only when the
runner confirms the exact text it injected, and `supportsInstructionAck` records
whether a runner speaks that protocol), `localUiUrl` (direct runner access),
`currentAction`. Resumable: Claude via session id, Codex via thread id.

### Role / Skill (`workspace_skills`)
A skill is a `SKILL.md` registered to a workspace. A **role** is a skill with
`isRole: true` — an agent persona. Fields: `model` (`sonnet | opus | haiku | inherit`),
`defaultBackend` (`claude | codex`), `allowedTools`, `canDelegateTo`, `mcpServers`,
`requiredEnvVars`, `maxTurns`, `background`, `color`, `configStorageKey` (R2 tarball
of CLAUDE.md + .mcp.json).
**`allowedTools` scope:** it governs the tools of a **skill subagent** spawned from this
row, and does **not** narrow the primary agent on a task — that agent's allowlist is
built from skill scoping (`Skill(<slug>)`) alone, so a role with no skills attached runs
on SDK defaults. The UI labels the field accordingly ("Subagent Tools"); enforcing it on
the primary agent is a runner change that has not shipped. Default roles seeded per workspace: **Organizer, Builder,
Researcher** (+ `ops` used by watchers). Tasks route to runners via `roleSlug` ∩
runner `availableSkills`.

### Secret (`secrets`)
**The single, unified credential store.** One row per scoped credential; `purpose` ∈
`anthropic_api_key | oauth_token | codex_credential | webhook_token | mcp_credential |
vercel_token | custom | claude_credential | inference_key | decision_key | …`. Scoped
by team (always) + optional account + optional workspace (+ optional `userId`, for a
person's own `inference_key` only); a team-wide row (account/workspace/user NULL)
covers everything. Multi-field
creds are encrypted JSON in `encryptedValue`. Expiring tokens use `tokenExpiresAt` +
`lastRefreshedAt` (the latter doubles as the optimistic-lock column for refresh).
**Do not add per-integration credential tables** — add a `purpose`. See
`docs/credentials-architecture.md`.

### Knowledge (`knowledge_chunks`)
Hybrid semantic + lexical retrieval over `memory | code | docs | task | artifact | pr |
plan | session | spec` corpora. namespace = `{workspaceId}:{corpus}`. pgvector (1024-dim,
HNSW) + tsvector BM25, fused via RRF, optional cross-encoder rerank. **Per-corpus
embedder selection**: `voyage-code-3` for `code/docs/spec`; `voyage-4-large` for
`memory/task/pr/plan/artifact/session`. Both output 1024-dim vectors — single HNSW
index, namespace-scoped queries. Falls back to lexical-only when `VOYAGE_API_KEY` is
unset. `spec_compare` reads `{workspaceId}:code` + `{workspaceId}:spec` (unified store,
no separate namespace). Swappable `KnowledgeStore` interface (same pattern as
`AgentBackend`). See `docs/knowledge-store.md`.

### Supporting tables
`worker_heartbeats` (runner liveness, independent of workers), `worker_error_traces`
(pattern-matched tool errors, throttled), `artifacts` (deliverables, S3/R2-backed,
shareable via `shareToken`), `mission_notes` (append-only agent↔user feed),
`task_schedules` (cron + conditional triggers + suggestions), `task_outcomes`
(routing-calibration telemetry), `watched_projects` + `watcher_events` (CI/prod health monitors that auto-file tasks),
`github_installations` + `github_repos`, `device_codes` (CLI device-code auth),
`oauth_clients`/`oauth_codes`/`oauth_refresh_tokens` (OAuth 2.1 PKCE for MCP clients),
`user_feedback`, `system_cache`, `tenant_budgets`.

---

## 3. Execution: runners & backends

- **Runner** (`apps/runner`, Bun) — external worker process. Claims tasks via
  `POST /api/workers/claim`, runs the agent, reports progress via `PATCH
  /api/workers/[id]`. Turn-based loop with multi-turn resume, review gates, abort.
- **Runner liveness** — runners send a heartbeat to `POST /api/workers/heartbeat`
  every `BUILDD_RUNNER_POLL_MIN` minutes (default 60; env-configurable). Liveness
  thresholds in `packages/shared/src/runner-liveness.ts` derive from the same env
  var: **online** = last beat within 1.5× the interval; **stale** = 1.5×–2.5×;
  **excluded** (dropped from DB queries) beyond 2.5×. Heartbeats are independent
  of task claims — the claim path must not be used as a liveness proxy (cf. the
  Jun 2026 outage where that coupling hid a broken claim route). To change the
  interval: update `BUILDD_RUNNER_POLL_MIN` on both the runner host and the server
  env (Vercel) so the cutoffs scale together.
- **Backends** (`apps/runner/src/backends/`) — pluggable. `claude-backend.ts`
  (Agent SDK) and `codex-backend.ts` (Codex SDK), behind a common event-adapter
  interface. Backend resolution: `task.backend → role.defaultBackend → workspace
  default → 'claude'`. Codex invariants (events, multi-turn, resume, threads) are
  specified in `docs/specs/codex-backend-spec.md`.
- **Server-managed credentials** — runners need not hold local creds. The claim
  response delivers the resolved `oauth_token` / `api_key` from `secrets`; runners
  poll and back off on failure.
- **Smart model routing** — `task.kind`/`complexity` (set at creation, by organizer,
  classifier, or schedule cadence) → router picks a model at claim time
  (`predictedModel`); actual outcome logged to `task_outcomes`; a calibration cron
  (`/api/cron/routing-calibration`) closes the loop.

---

## 3a. Where AI runs & who pays

Two places, never mixed. Subscription (OAuth) auth is runner-anchored and has no
per-request form, so server-side calls **structurally cannot** use a seat.

| | Server-side model call | Runner-side agent run |
|---|---|---|
| Runs | in the web app, seconds | on the team's runner, minutes to hours |
| Shape | one call or a short streaming turn; no repo, no shell | Claude Code (Agent SDK) or Codex harness, worktree + tools |
| Used for | interactive AI (chat and its per-turn routing), goal-criteria grading, the task-category shadow check | all engineering/research tasks, planning, prose-criteria grading fallback |
| Credential | API key: `inference_key` (label `anthropic` \| `openai` \| `openrouter`), or `anthropic_api_key` for Anthropic, `decision_key` (legacy) for OpenRouter | `oauth_token` / `claude_credential` (Claude subscription), `anthropic_api_key`, `codex_credential` (ChatGPT/Codex auth.json) or runner-local `OPENAI_API_KEY`, runner-local `LLM_PROVIDER=openrouter` |
| Billing | metered per token | seat/session window (virtual cost) or per token |
| Code | `inference-client.ts` (`inferenceCall`), `decision-client.ts`, `apps/web/src/lib/chat/` | `apps/runner/src/backends/` |

- **One key resolver** — `packages/core/inference-keys.ts`. Precedence: caller's own
  key (`secrets.userId`) → calling API account → workspace → team → legacy
  account row (no-account callers) → provider env var (only outside production, or
  `BUILDD_ALLOW_ENV_INFERENCE_KEYS=1` for self-hosting). OAuth rows are never read.
  Runners never use these keys.
- **Key policy** — `teams.inferenceKeyPolicy` (default `team`; Settings → Model
  providers → "Whose key": "Team key" / "Each person's own key") binds every
  server-side call: `team` = team key for everyone, personal keys ignored;
  `team_or_own` = a person's own key wins, team key covers the rest; `own` = own
  key only, no fallback, so work with no person (grading, cron) finds no key and
  takes its runner path. Personal keys are managed via `/api/inference-keys` (any
  member) and never served to anyone else.
- **Which calls may spend** (`packages/core/inference-policy.ts`, `isInferenceAllowed`):
  - *Interactive* (chat and its per-turn routing): always on, no switch; it
    runs whenever a key resolves (`teams.chatDisabled` is deprecated and
    unread). Never falls back to a runner or seat. With no key the Chat entry
    point still shows, its page says who can fix it, and the mission form stays.
  - *Built-in* decision calls (`task_category`):
    no toggle; they run whenever a key resolves.
  - *Server-side features* (`criteria_grading`; `visual_qa`, `mission_summary`
    and the retired `heartbeat_triage` keep their ids so stored overrides
    validate, and are not shown in Settings).
    `heartbeat_triage` no longer runs: the heartbeat's stuck check
    (`isMissionStuck`) answers deterministically whether a cycle needs the
    organizer, so its cron call site was removed and its experiment concluded
    (`docs/design/heartbeat-triage.md`, superseded). The module, the
    `heartbeat_triage_looks` table and the experiment kind remain until a
    follow-up drops them. All default by billing
    model — a team key resolves → server-side, else the runner — with per-feature
    overrides (`server` | `runner`) in `teams.inferenceFeatureModes`. buildd's own
    CI visual QA judges on an OAuth seat via `claude-code-action`, not through this.
  - The old opt-in allowlist `teams.enabledInferenceCapabilities` is deprecated
    (nothing reads it).
- **Budgets** — interactive spend is capped by `teams.chatDailyBudgetUsd` (default
  $20/day, never uncapped) and a per-person cap (`chatUserDailyBudgetUsd`, default
  half); under `own` there is no team cap and the per-person cap defaults to none.
  Settings → Budgets shows each person's spend split into Interactive and Agent runs
  (agent runs attributed to the mission's creator), per person for admins.
- **Routes** — a tier names a *vendor* and model; a *route* is where the call goes
  (`ROUTES` in `packages/ai-kit/src/models/routes.ts`: `anthropic`, `openai`,
  `openrouter`, `litellm`). Chat and `inferenceCall` share one resolver
  (`packages/core/inference-route.ts`) and one order: the vendor's own API, then
  OpenRouter, then the team's **LiteLLM gateway** (`packages/core/litellm-gateway.ts`),
  which serves the model as `vendor/model` on its OpenAI-compatible API. Receipts
  and prices keep the planned vendor and model whatever the route. `openai-codex`
  is an agent backend, not a route (`unsupported_provider`). Decision calls:
  OpenRouter, or the team's decision model.
- **Agent model endpoint** — one `secrets` row, purpose `agent_endpoint`
  (`packages/core/agent-endpoint.ts`, team-wide or one workspace): where
  runner-spawned agents send model traffic (the team gateway, OpenRouter, or any
  Anthropic-compatible URL). Ranked against the Anthropic key, OAuth seat and
  Claude credential in one precedence: the most specific scope wins, a tie goes
  to the endpoint, and only the winner is delivered. Host runners that declare
  the `agent_endpoint` runner feature get it on the claim (`modelEndpoint`,
  stripped from cloud claims; any other runner keeps today's credentials); the
  cloud dispatcher, which forwards only the model API paths,
  fetches it from `POST /api/runner/model-endpoint`. A runner's per-machine
  `LLM_PROVIDER` still wins. Endpoint runs are metered. **Codex**: the same row
  routes Codex tasks too, when the kind has an OpenAI-compatible wire —
  `gateway` (LiteLLM) and `openrouter` do, `anthropic-compatible` doesn't
  (`cloudflare` does only through an OpenRouter upstream with no gateway
  token). A `cloudflare` endpoint sends agents through the team's Cloudflare AI
  Gateway on its stored Anthropic or OpenRouter key; a Run-only gateway token
  rides as a header, so only a runner that applies headers gets one. A
  Codex task ranks the endpoint against `openai_api_key` / `codex_credential`
  instead (`resolveAgentModelRoute`'s `backend: 'codex'`), and the runner
  applies it as `OPENAI_BASE_URL` + `OPENAI_API_KEY` (not the Anthropic auth
  vars), with a per-machine `OPENAI_BASE_URL` still winning the same way
  `LLM_PROVIDER` does for Claude. An `anthropic-compatible`-only endpoint can't
  serve Codex at all — the task fails with a clear message rather than
  silently falling back to local Codex auth. Host-runner only; cloud-runner
  Codex support is a separate, unimplemented gap (`POST
  /api/runner/model-endpoint` 404s a Codex task outright).
  **Deferred tool loading**: the row's `capabilities.toolSearch` (OpenRouter
  on by default, gateway and custom URL off unless set) tells a host runner
  to set `ENABLE_TOOL_SEARCH=true` for a Claude run through the winning
  endpoint — per run, never runner-global (`effectiveToolSearch`,
  `applyModelEnv`).
- **Decision model** — `teams.decision_model` (`packages/core/decision-model.ts`):
  null = Jev on OpenRouter; otherwise any chat model via OpenRouter or the gateway,
  with confidence from token logprobs (`@builddai/ai-kit/decide` chat endpoint).
  Thresholds were measured on Jev, so a call site that auto-applies (task
  category) records another model's pick without applying it.
- **Decision calls** (`decisionCall`) — fixed-label classifications. Chat uses them
  to pick each turn's tier and tool set, confidence-gated, defaulting to `standard`
  with all tools. The task-category check is shadow only
  (`docs/design/decision-calls.md`).

### Model tiers

Callers ask for a **tier**, never a vendor model: `premium-plus` (opt-in only;
nothing routes there on its own) · `premium` · `standard` · `budget`
(`packages/core/model-tier-defaults.ts`). An admin maps tier → `(provider, model)` in
`model_tier_registry` (Settings → Model tiers, or `manage_model_tiers`); provider ∈
`anthropic | openai | openai-codex | openrouter`. Resolution (`resolveTierEntry`,
60s cache): workspace row → team row → the catalog's newest in-band release →
`TIER_DEFAULTS`. Agent runs resolve at **claim** time, so a remap applies to queued
tasks. Chat and inference calls resolve per call; for chat, a tier on Anthropic or
OpenAI with only an OpenRouter key is served through OpenRouter. An explicit `model` on a task or a
role's full-ID pin bypasses tiers. **Tier model pools** (several models per tier with
traffic splits) are proposed, not shipped (`knowledge-base: buildd/design/tier-model-pools.md`).

---

## 4. API surface (coordination layer)

`apps/web/src/app/api/**`, grouped. (~95 routes; representative, not exhaustive —
the route tree is authoritative.)

- **Auth:** `auth/[...nextauth]`, `auth/cli`, `auth/device/{code,approve,token}`.
- **OAuth 2.1 (MCP clients):** `oauth/{authorize,register,token}`,
  `mcp-oauth/[workspace]` (workspace-scoped JWT enforcement).
- **Accounts:** `accounts`, `accounts/me`, `accounts/[id]`, `.../regenerate-key`,
  `.../ai-budget` (an app key's daily AI cap, owner/admin).
- **Model plans for sibling apps** (`knowledge-base: buildd/design/shared-ai-kit.md` §2): `ai/plan`
  (tier → model on the app's providers, from the team's registry and chat pools,
  with an `ok`/`downgrade`/`deny` spend decision and a TTL), `ai/usage`
  (content-free, identity-free receipts; unknown fields rejected; an optional
  `kind` of `chat`/`inference`/`decision` is stored as the row's surface, and a
  Jev `decision` receipt needs no tier). Any-level `bld_`
  key, team from the key. Code: `apps/web/src/lib/ai/`.
- **Tasks:** `tasks` (+ `bulk`, `cleanup`, `waiting-input`), `tasks/[id]` (+ `start`,
  `run`, `messages`, `reassign`, `summary`, `error-traces`, `workers`,
  `approve-plan`, `reject-plan`).
- **Workers:** `workers` (+ `active`, `mine`, `claim`, `heartbeat`), `workers/[id]`
  (+ `cmd`, `instruct`, `recover`, `respond`, `activity`, `artifacts`,
  `error-traces`, `sessions`).
- **Missions:** `missions`, `missions/[id]` (+ `run`, `artifacts`, `notes`,
  `notes/[noteId]/reply`).
- **Workspaces:** `workspaces` (+ `by-repo`, `match-repos`, `create-repo`),
  `workspaces/[id]/{config,runners,schedules,skills,memory,projects,
  watched-projects,webhook,codex-credential}` and nested CRUD.
- **Teams:** `teams`, `teams/[id]` (+ `members`, `invitations`), `invitations/[token]/accept`.
- **Roles/Skills:** `roles`; skill CRUD under `workspaces/[id]/skills`.
- **Secrets:** `secrets`.
- **Artifacts:** `artifacts`, `artifacts/[id]`, `artifacts/upload-url`, `share/[token]`.

### Artifact UI contracts

The artifact detail page (`/app/artifacts/[id]`) and artifact list cards (`/app/artifacts`,
`/app/workspaces/[id]/artifacts`) **MUST** expose a create-task action on all supported
viewports, including mobile. The action links to `/app/tasks/new` pre-filled with:
- `title` — `Implement: <artifact title>`
- `description` — excerpt referencing the artifact title and content (≤500 chars of content)
- `artifactId` — for the source badge shown on the task form
- `artifactTitle` — display name of the artifact

The `/app/tasks/new` form reads these params and shows an "From artifact:" reference badge
when `artifactId` + `artifactTitle` are present. This contract is tested in
`apps/web/src/components/artifact-helpers.test.ts` (`buildCreateTaskUrl` suite).
- **GitHub:** `github/{install,callback,installations,installations/[id]/repos,pr,webhook}`.
- **MCP:** `mcp` (HTTP dispatch), `mcp/registry`.
- **Cron:** `cron/{schedules,codex-token-refresh,routing-calibration,feedback-digest}`.
- **Integrations:** `integrations/{slack,discord}`, `webhooks/ingest`.
- **Releases:** `releases/{status,trigger}`.
- **Misc:** `version`, `feedback`, `memory/quickstart`, `admin/refresh-model-aliases`.

---

## 4a. Merge policy — who is allowed to end a PR

The single primitive governing every route to a merge. Resolved by `resolvePolicy`
from, in precedence order: `task.requiresReview` → a task PR based on its mission's
integration branch (forced `auto-threshold`) → `mission.mergePolicy` →
`mission.requiresReview` → `workspace.gitConfig.mergePolicy` → the default
(`auto-threshold`).

The legacy `gitConfig` flags `autoMergePR` / `autoMergeOnGreenCI` are **not** part of
that chain: migration `0113` converted them to a `mergePolicy` and nothing reads them
since. The dashboard no longer offers an "Auto-merge on green CI" checkbox (it wrote
`autoMergeOnGreenCI` and changed nothing); "merge on green CI" is the `auto-threshold`
tier, set on the workspace merge policy page. The config route ignores the flag if a
client still sends it, and the PR-create response's `autoMergeEnabled` is derived from
the resolved policy.

| Tier | Who ends the PR |
|------|-----------------|
| `auto-threshold` | The platform, unattended, once `evaluateAutoMergeSafety` passes: CI green (every check run on every page completed `success`/`neutral`/`skipped` and every commit status `success`; anything else, or an unverifiable read, refuses), no `denyPaths` hit, diff under the source-line cap, migration operation-class inspector satisfied, no conflicts. |
| `agent-review` | A **reviewer agent**. A `reviewer`-role task is spawned on PR open and returns `{verdict, confidence, summary, feedback?, escalationReason?, recommendation?, correctedLede?}` as structured output. `approve` may merge; `request-changes` sends the PR back to the authoring agent for up to `maxIterations` (default 3); `escalate` goes to a human. |
| `human` | A person, from the escalation inbox. No automated merge. |

**Every route to a merge runs the same gate.** There are three: auto-merge on green
CI, the reviewer `approve` path, and the MCP `merge_pr` action. `merge_pr` is
policy-gated — under `agent-review` a self-merge is refused (the reviewer's verdict is
the gate and a self-merge routes around it), under `human` it is refused, and under
`auto-threshold` it is permitted only if the same safety check auto-merge applies
passes. An `admin`-level token may pass `force: true`.

That is a guarantee about buildd's own code paths, not about the GitHub credential a
cloud-sandboxed agent holds — that credential carries `pull_requests:write` +
`contents:write`, enough on its own to call GitHub's merge endpoint or push over a
protected branch directly. The cloud runner's egress handler refuses those two shapes
before the credential is ever attached, independent of the gate above — see
`docs/specs/cloud-egress-merge-guard.md`.

**The escalate triggers are enforced server-side from the PR's file list**, never from
the model's `escalationReason` — that text is downstream of an untrusted contributor
diff. `enforceServerSideEscalation` re-derives them at verdict time, because
`preflightEscalationCheck` runs only on the webhook's `opened` action and therefore
misses a file added during a request-changes iteration.

**What a model `approve` may merge into is bounded by the PR's base ref.** Under the
mission integration branch model (per-mission `integrationBranchEnabled`), a task PR
based on the mission's `workingBranch` may be merged unattended, because that branch is
itself reviewed at the single mission → trunk PR. A PR based on trunk (`dev`, the
workspace target/default branch, `main`) escalates to a human regardless of verdict.
The bound additionally requires that the build/test workflow **reported success** for
the head SHA — an absent check run is not a passing one.

**Reviewer evidence.** The reviewer task's description is assembled by
`buildReviewerContext`: the task, its path manifest, the policy's intent sentences, the
changed-file list, and — when `policyConfig.reviewerPatchEvidence` is set — the PR patch
itself, rendered in a hunk format where **only added lines carry a line number**, so a
cited `path:line` is provably a line the PR introduced. PR-authored text (task
description, title, lede) is stripped of injection carriers and fenced as data before it
enters the prompt.

**The PR lede.** Every PR body opens with a one-sentence plain-language lede, composed
into the body at creation behind `<!-- buildd-lede -->` markers so that GitHub, `get_pr`
and the `pr` knowledge corpus all read it first without knowing the field exists.
`lede` is **required** on `create_pr` and can fail only by being ABSENT — nothing
inspects or grades what is written, and no PR is ever refused over its prose. The
`prUrl` adoption path, which registers a pull request that already exists on GitHub,
takes a deterministic title-derived lede instead of a refusal. Only the lede is bounded
(240 characters, truncated not rejected); the body is never capped, because it is the
durable record the corpus searches.

A reviewer may return `correctedLede` when the lede **contradicts the diff** — spec
conformance applied one object over. A lede that is accurate but clumsy is taste and is
left alone. The agent proposes; `handleReviewerOutcomeIfNeeded` applies, keeping the
author's original visible in the body and on the PR activity comment, and surfacing the
correction on the decision note. A failed body edit is logged and dropped: it never
gates, delays or alters the verdict.

---

## 5. MCP

Four tools exposed (HTTP MCP at `/api/mcp`): **`buildd`** (task + admin actions —
claim/update/create_pr/merge_pr/create_artifact/complete/get_task/
send_agent_message/memory_delete/consolidate_knowledge/…; the action set available
is gated by explicit token scopes (legacy tokens use `trigger | worker | admin`), and `merge_pr` is additionally
gated by the merge policy tier — see §4a), **`recall`** (read knowledge), **`learn`**
(write knowledge), and **`buildd_memory`** (deprecated — superseded by
recall/learn in #1944, still routed for compatibility). claude.ai and other MCP
clients connect via workspace-scoped OAuth (`mcp-oauth/[workspace]`).

---

## 6. Integrations

GitHub App (installations, repo linking, PR routing, webhooks, auto-mission
creation), Slack + Discord (`/buildd` slash commands, notifications/approvals),
generic webhook dispatch (`webhookConfig`, used by OpenClaw), CI/prod health
watchers (`watched_projects`) that auto-file ops tasks + Pushover alerts.

---

## 7. Auth model summary

| Auth type | Credential | Billing | Limits |
|-----------|-----------|---------|--------|
| `api`     | `bld_xxx` API key → `secrets:anthropic_api_key` | pay-per-token | `maxCostPerDay`, team monthly budget |
| `oauth`   | `secrets:oauth_token` | seat-based | `maxConcurrentSessions`, budget reset windows |

Check `authType` to know which limits apply. CLI auth via device-code flow
(`device_codes`). MCP clients via OAuth 2.1 PKCE.

**Repository access.** By default, team membership is the whole check: a member
can see everything Buildd can see in the workspace's repository through its
GitHub App installation, whatever their own GitHub rights. A workspace admin can
set `gitConfig.memberRepoAccess: 'require_read'`; then a person (dashboard or
OAuth MCP session) must also hold read or higher on the linked repo on GitHub to
create tasks, read diff artifacts, chat over the workspace or recall its `code`
corpus. A person with no linked GitHub account, or whom GitHub cannot confirm,
is refused. API keys and runners are unaffected (`lib/member-repo-access.ts`).

---

## 8. What is live vs. retired

**Live & maintained:** `apps/web`, `apps/runner`, `packages/{core,shared}`.
Shipped subsystems: dual backends, unified `secrets`, server-managed creds, hybrid
knowledge store, smart routing + calibration, workspace-scoped MCP OAuth, missions
with shared working branch, schedules with conditional triggers, watchers,
brutalist UI.

**Retired / empty scaffolds (cleanup candidates):** `apps/agent`, `apps/mcp-server`,
`apps/local-ui` — no source, node_modules only. The MCP server moved to
`apps/web/src/app/api/mcp`.

**Removed concepts (do not reintroduce in docs):**
- **Objectives** — never existed as a table; superseded by **Missions**.
- **"The heartbeat is the evaluation authority"** — retired. The heartbeat is an
  LLM reading a checklist; its `missionComplete = true` is a proposal, and one
  predicate (`canCompleteMission`) decides. Goal criteria are a gate, not
  advisory metadata: an unevaluated criterion blocks completion.
- **Recipes** — removed (~Apr 2026).
- **Heartbeat as a feature** — folded into missions/health; `worker_heartbeats` is
  infra liveness, not a user feature.
- **`observations` table** — memory moved to the knowledge store / external service.
- **`codex_credentials` table** — dropped (migration 0047); use `secrets`.
- **`checkCapabilityMatch` / `requiredCapabilities` matching** — removed from the
  claim route and `/start` in PR #1864; `claim-gates.ts` (the hand-mirrored gate
  module) deleted in PR #1868. The capability abstraction was a single check (does
  Codex have credentials) with a general-sounding name; it has been replaced by the
  onboarding/workspace-configuration approach.
- **`apps/web/src/lib/claim-gates.ts`** — deleted (PR #1868). `/start` now imports
  directly from the canonical gate modules in `apps/web/src/app/api/workers/claim/`
  (`connector-gate.ts`, `held-gate.ts`, `workspace-cap-gate.ts`, `deps-gate.ts`).
  There is no longer a hand-mirrored copy of the gate predicates.

**Planned, not in this repo:** iOS app (`buildd-ios`, separate repo;
`buildd-mobile.pen` design + `knowledge-base: buildd/plans/ios-app-mvp.md`).

---

## 9. `docs/` map (implemented specs)

| Doc | Subject | Status |
|-----|---------|--------|
| `SPEC.md` (this file) | Canonical product/architecture spec | Live |
| `specs/` (+ `specs/INDEX.md`) | Per-capability contracts (linted) | Live |
| `specs/codex-backend-spec.md` | Codex backend invariants | Implemented |
| `credentials-architecture.md` | Unified `secrets` scoping + refresh | Implemented |
| `knowledge-store.md` | Hybrid retrieval design | Implemented |
| `design/workspace-knowledge-management.md` | Per-PR ingestion, code graph, consolidation | Draft |
| `design/reviewer-evidence-and-verification.md` | Reviewer patch evidence, filters, verification | Partly shipped |
| `design/cross-workspace-retrieval.md` | Team-scoped docs retrieval across workspaces | Proposed |
| `design/mission-delivery-arc.md` | Mission integration branch (Option A′) | Implemented |
| `design/inference-calls-primitive.md` | Server-side `inferenceCall`, capability policy | Partly shipped |
| `design/decision-calls.md` | Fixed-label `decisionCall` (shadow) | Partly shipped |
| `design/model-tiers.md` | Tier vocabulary + registry | Implemented |
| `design/agent-chat.md` | Server-side chat on API keys | Partly shipped |
| `design/tier-model-pools.md` | Multiple models per tier | Proposed |
| `testing.md`, `testing-strategy.md` | TDD, test layers, fixtures | Implemented |
| `plans/archive/remove-objectives.md` | Objectives→Mission port | Shipped/historical |
| `plans/ios-app-mvp.md` | iOS MVP | Planned (separate repo) |

---

## 10. Activity feed (mobile UX contracts)

The Activity tab (`/app/tasks`, `TaskGrid.tsx`) is the primary task-navigation surface on mobile. The following behaviours are **testable contracts**:

### Default grouping
- **Contract:** The default `groupBy` on first load (no stored preference) is `none` — a flat, recency-sorted list. `Group: None` is the first option in the dropdown to reinforce this as the default.
- **Rationale:** Grouping by mission degenerates to a single "No mission" bucket when tasks are ad-hoc; the flat list avoids the extra toggle and exposes tasks directly.

### Auto-flatten rule
- **Contract:** When `groupBy === 'mission'` **and** one mission group contains **>75%** of the filtered (non-waiting-input) tasks, `effectiveGroupBy` resolves to `'none'` — the list renders flat regardless of the stored preference.
- **Testable:** Given 3 active tasks all with `missionId = null` (one "No mission" group = 100% > 75%), the task list must render flat with no group header, even if `groupBy` state equals `'mission'`.

### Persisted preferences
- **Contract:** The user's chosen `filter` (All / Active / Completed / Failed) and `groupBy` are persisted to `localStorage` under key `buildd-activity-prefs` and restored on next load.
- **Scope:** Persistence is skipped when TaskGrid is rendered in mission-scoped mode (`missionFilter` prop set).

### Recency access path
- **Contract:** The most recently updated active task is reachable in **≤ 2 taps** from anywhere in the app — (1) tap the Activity nav item → (2) task is immediately visible in the flat recency list (if Active filter was last used) or visible in the "Running now" strip (mobile only).
- **Running now strip:** When the current filter is not `active`, the top of the Activity page shows a horizontal-scrollable strip (mobile-only, `sm:hidden`) of up to 5 most recently updated non-completed tasks as direct task links.

### Multi-line task titles on mobile
- **Contract:** Task title spans inside mobile cards use `line-clamp-2` (not `truncate`) — titles may wrap to a second line before being cut. This ensures enough context to distinguish similar task names.

---

## 11. Spec maintenance (spec-driven development)

This file is the input; docs/site are outputs. To keep it from rotting:
1. **Schema/route changes** that alter the domain model update §2/§4 in the same PR.
2. The **`spec-sync` skill** ingests code + all four doc sources into the knowledge
   store (separate dev-loop pipeline; see the skill) and diffs *claims vs. reality*,
   filing drift as tasks.
3. `buildd-docs` and `buildd-site` are reconciled *against this file*, never the
   reverse. Drift is **regenerated on demand** by the `spec-sync` skill — do not
   act on a checked-in drift list. A stale one is worse than none: the last
   committed punchlist told a reader to delete two docs pages that had since
   been rewritten into accurate ones.
