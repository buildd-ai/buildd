# Buildd — Product & Architecture Spec

> **Status: canonical.** This is the single source of truth for what buildd *is*,
> derived from the code (schema + API routes + runner), not from marketing or docs.
> Downstream artifacts (`buildd-docs`, `buildd-site`, `knowledge-base`) are *outputs*
> of this spec, not inputs. When they disagree with this file, this file wins —
> and a drift task should be filed against them.
>
> **Derived from:** `packages/core/db/schema.ts`, `apps/web/src/app/api/**`,
> `apps/runner/**`, and the implemented specs in `docs/` (codex, credentials,
> knowledge-store), as of **2026-06-24**.
> **Maintenance:** see `docs/SPEC.md` §10 and the `spec-sync` skill.

---

## 1. What buildd is

Buildd is a **task-coordination system for AI coding agents**. Humans (or agents)
declare goals; agents decompose them into tasks, claim them, execute on external
runners, and deliver outcomes (PRs, artifacts, research). The web app is
**coordination-only** — it stores state and brokers work but never runs agents
itself (Vercel can't host multi-minute agent executions; runners are external).

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
Plans: `free | pro | team`.

### User
SSO identity (`googleId`, `githubId`, `email`). Belongs to teams via `team_members`
(`owner | admin | member`). Invited via `team_invitations`.

### Account
An API/OAuth client that claims and runs tasks. Two **auth types** with different
billing:
- **`api`** — pay-per-token (`bld_xxx` key). Cost-limited (`maxCostPerDay`, monthly budget).
- **`oauth`** — seat-based, session-limited (`maxConcurrentSessions`, `activeSessions`,
  `budgetExhaustedAt`/`budgetResetsAt`).

`type`: `user | service | action`. `level`: `trigger | worker | admin`. A team
typically has separate trigger vs. worker accounts. `account_workspaces` is the
M2M grant of which workspaces an account `canClaim` / `canCreate` from.

> **Deprecated:** `accounts.oauthToken` / `anthropicApiKey` columns — credentials now
> live in the `secrets` table. Columns kept for back-compat, slated for removal.

### Workspace
A repo + config boundary. Holds tasks, workers, missions, roles/skills, schedules.
Key config (all JSONB, migration-free to evolve):
- **`gitConfig`** (`WorkspaceGitConfig`) — branching strategy, commit style, PR/merge
  behavior, agent instructions, sandbox, model/thinking/effort defaults,
  **`defaultBackend`** (`claude | codex`), CI auto-retry (`maxCiRetries`), auto-merge
  rules (`autoMergeOnGreenCI`, `autoMergeDenyPaths`, `autoMergeMaxLines`).
- **`releaseConfig`** (`WorkspaceReleaseConfig`) — release strategy
  (`workflow_dispatch | branch_merge | script`), deploy target, post-deploy hooks,
  verification URL.
- **`webhookConfig`**, **`discordConfig`**, **`slackConfig`** — external dispatch/notify.
- `accessMode`: `open` (any token claims) | `restricted` (linked accounts only).

### Mission
A first-class **goal** that aggregates tasks. Status: `active | paused | completed |
archived` (lifecycle is stored; *health* is derived from task state via
`deriveMissionHealth`, not stored). Notable fields:
- **`workingBranch`** + `primaryPrNumber`/`primaryPrUrl` — all mission tasks push to one
  shared branch tracked by a single PR.
- `scheduleId` — link to a `task_schedule` for recurring missions. **Lifecycle rule:** heartbeat schedules are owned by their mission. When the mission status transitions to `completed` or `archived`, its linked schedule is automatically deleted. When the mission is `paused`, the schedule is disabled (not deleted). When the mission is re-activated (`active`), the schedule is re-enabled. Deleting a mission also deletes its schedule. This ensures heartbeat schedules cannot outlive the mission that owns them.
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
- **`runnerPreference`** (`any | user | service | action`) + `requiredCapabilities` +
  **`roleSlug`** — claim-time routing constraints. `roleSlug` is nullable: when
  set, only runners that advertise this skill in `availableSkills` can claim the
  task; when null, any runner with workspace access can claim it. **Null is the
  normal case for dashboard-created tasks** — approximately 54% of tasks in
  production have `roleSlug = null`. The dashboard's `/skill` typeahead stores
  the chosen skill in `context.skillSlugs` (advisory JSON field on the task)
  rather than in `roleSlug`. `context.skillSlugs` tells the executing agent
  which skill prompt to load but does NOT restrict which runner can claim the
  task. `roleSlug`-based routing is primarily used by MCP `create_task` with
  an explicit `roleSlug`, the organizer agent, and schedules.
- **`backend`** (`claude | codex`, enum, default `claude`) — which agent runs it.
- **`dependsOn`** (task IDs) — workflow DAG; task isn't claimable until deps complete.
- **`missionId`**, `parentTaskId`, `category`, `project`, `priority`.
- **Smart routing:** `kind` (`coordination | engineering | research | writing | design
  | analysis | observation`), `complexity` (`simple | normal | complex`),
  `predictedModel`, `classifiedBy` (`organizer | classifier | user | default`).
- **Release:** `release` (`true | false | inherit`) + `releaseResult`.
- `creationSource`: `dashboard | api | mcp | github | local_ui | schedule | webhook | orchestrator`.

### Worker
An agent execution **session** on a task (a runner claims a task → spawns a worker).
Holds all telemetry: `status`, `waitingFor` (question to user), `costUsd`,
input/output tokens, `turns`, `milestones`, git stats (commits/files/lines),
`prUrl`/`prNumber`, `resultMeta` (SDK result), `mcpCalls` log, `pendingInstructions` +
`instructionHistory` (admin nudges), `localUiUrl` (direct runner access),
`currentAction`. Resumable: Claude via session id, Codex via thread id.

### Role / Skill (`workspace_skills`)
A skill is a `SKILL.md` registered to a workspace. A **role** is a skill with
`isRole: true` — an agent persona. Fields: `model` (`sonnet | opus | haiku | inherit`),
`defaultBackend` (`claude | codex`), `allowedTools`, `canDelegateTo`, `mcpServers`,
`requiredEnvVars`, `maxTurns`, `background`, `color`, `configStorageKey` (R2 tarball
of CLAUDE.md + .mcp.json). Default roles seeded per workspace: **Organizer, Builder,
Researcher** (+ `ops` used by watchers). Tasks route to runners via `roleSlug` ∩
runner `availableSkills`.

### Secret (`secrets`)
**The single, unified credential store.** One row per scoped credential; `purpose` ∈
`anthropic_api_key | oauth_token | codex_credential | webhook_token | mcp_credential |
vercel_token | custom`. Scoped by team (always) + optional account + optional
workspace; a team-wide row (account/workspace NULL) covers everything. Multi-field
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
(routing-calibration telemetry), `file_reservations` (advisory edit locks),
`watched_projects` + `watcher_events` (CI/prod health monitors that auto-file tasks),
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

## 4. API surface (coordination layer)

`apps/web/src/app/api/**`, grouped. (~95 routes; representative, not exhaustive —
the route tree is authoritative.)

- **Auth:** `auth/[...nextauth]`, `auth/cli`, `auth/device/{code,approve,token}`.
- **OAuth 2.1 (MCP clients):** `oauth/{authorize,register,token}`,
  `mcp-oauth/[workspace]` (workspace-scoped JWT enforcement).
- **Accounts:** `accounts`, `accounts/me`, `accounts/[id]`, `.../regenerate-key`.
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
  watched-projects,webhook,integrations/slack,codex-credential}` and nested CRUD.
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

## 5. MCP

Two tools exposed (HTTP MCP at `/api/mcp`): **`buildd`** (task actions —
claim/update/create_pr/create_artifact/complete/get_task/send_agent_message/…) and
**`buildd_memory`** (workspace knowledge — search/save/update/delete). claude.ai and
other MCP clients connect via workspace-scoped OAuth (`mcp-oauth/[workspace]`).

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
- **Recipes** — removed (~Apr 2026).
- **Heartbeat as a feature** — folded into missions/health; `worker_heartbeats` is
  infra liveness, not a user feature.
- **`observations` table** — memory moved to the knowledge store / external service.
- **`codex_credentials` table** — dropped (migration 0047); use `secrets`.

**Planned, not in this repo:** iOS app (`buildd-ios`, separate repo;
`buildd-mobile.pen` design + `docs/plans/ios-app-mvp.md`).

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
   reverse. Open drift items live in `docs/reports/doc-drift-punchlist.md`.
