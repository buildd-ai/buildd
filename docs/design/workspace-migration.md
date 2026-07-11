# Workspace Migration — Design Spec

> **Status:** Proposed — awaiting Max's approval before any implementation begins.
> **Context:** Workspaces are currently pinned to the team that created them. This spec defines
> first-class workspace migration so owners can move a workspace (repo binding, tasks, missions,
> schedules, roles/skills, secrets, connectors, knowledge) to a different team.

---

## Problem Statement

There is no way to move a workspace between teams. Reorganizing a company, splitting teams, or
transferring ownership of a project today requires manually recreating the workspace and losing all
task history, schedules, and configuration. This blocks legitimate restructuring and creates
permanent data silos.

---

## What "Migration" Means

A workspace migration updates `workspaces.teamId` from `sourceTeamId` to `destinationTeamId`.

**The workspace UUID does not change.** All DB rows that reference `workspaces.id` by FK (tasks,
workers, artifacts, schedules, watched projects, file reservations, oauth codes/tokens) remain
valid without modification — the FK target is stable.

What changes:
- `workspaces.teamId` → destination team ID
- `missions.teamId` → updated for workspace-linked missions
- `workspace_skills.teamId` → updated for workspace-scoped skill rows
- `connector_workspaces` rows → deleted (connectors break; see §Connectors)
- Workspace-scoped `secrets` rows → deleted (cannot be re-encrypted; see §Secrets)
- `account_workspaces` rows → cleared and re-added by destination team

---

## Permissions

The initiating user must be **admin or owner on both the source team AND the destination team**.
The migration API validates both `team_members` rows before any other action. Missing either
membership returns a `403` with a clear message:

> "You must be an admin on both teams to migrate a workspace."

---

## Entity Inventory

Audited from `packages/core/db/schema.ts`. Every table in the schema is accounted for.

| Entity | Table(s) | FK scope | Migration Behavior |
|---|---|---|---|
| **Workspace row** | `workspaces` | `teamId` | **MOVES CLEANLY** — update `teamId` to destination |
| **Tasks** (all statuses) | `tasks` | `workspaceId` | **MOVES CLEANLY** — FK to unchanged workspace UUID; no row action needed |
| **Workers + milestones** | `workers` | `workspaceId` | **MOVES CLEANLY** — FK unchanged; in-flight workers continue uninterrupted |
| **Worker error traces** | `worker_error_traces` | `workerId` → `workers` | **MOVES CLEANLY** — cascade from workers |
| **Task outcomes** | `task_outcomes` | `taskId` → `tasks` | **MOVES CLEANLY** — cascade from tasks |
| **Artifacts** | `artifacts` | `workspaceId` | **MOVES CLEANLY** — FK unchanged |
| **Mission notes** | `mission_notes` | `missionId` → `missions` | **MOVES CLEANLY** — cascade from missions |
| **Task schedules** | `task_schedules` | `workspaceId` | **MOVES CLEANLY** — FK unchanged; cron continues firing; timezone/active-hours unaffected |
| **Watched projects** | `watched_projects` | `workspaceId` | **MOVES CLEANLY** — FK unchanged |
| **Watcher events** | `watcher_events` | `projectId` → `watched_projects` | **MOVES CLEANLY** — cascade from watched_projects |
| **File reservations** | `file_reservations` | `workspaceId` | **MOVES CLEANLY** (transient; expire naturally; no action needed) |
| **Knowledge — non-memory corpora** | `knowledge_chunks`, `knowledge_entities`, `entity_aliases`, `chunk_entities`, `pending_entity_refs`, `knowledge_edges` | `workspaceId` (text, no FK) | **MOVES CLEANLY** — all use `{workspaceId}:corpus` namespace; workspace UUID unchanged so no re-ingest needed |
| **OAuth MCP tokens** | `oauth_codes`, `oauth_refresh_tokens` | `workspaceId` | **MOVES CLEANLY** — workspace-scoped; existing client sessions remain valid; no user action needed |
| **Missions (workspace-linked)** | `missions` | `teamId` + `workspaceId` | **MOVES CLEANLY** — update `teamId` for rows where `workspaceId = migratingWorkspaceId` |
| **Missions (team-level, workspaceId NULL)** | `missions` | `teamId` only | **LEFT BEHIND** — stays with source team; tasks that reference these missions retain the FK but the mission feed is in source team |
| **Workspace-scoped skills/roles** | `workspace_skills` (where `workspaceId IS NOT NULL`) | `teamId` + `workspaceId` | **MOVES CLEANLY** — update `teamId`; but audit `canDelegateTo` chains (see §Roles) |
| **Team-level skill dependencies** | `workspace_skills` (where `workspaceId IS NULL`) | `teamId` only | **LEFT BEHIND** — source team's shared roles stay in source team; `canDelegateTo` references may break |
| **Connectors** | `connectors` | `teamId` | **LEFT BEHIND** — connector definitions stay with source team |
| **Connector workspace enablements** | `connector_workspaces` | `connectorId` + `workspaceId` | **WILL BREAK** — rows deleted at migration; user must re-add connectors in destination team and re-authorize OAuth |
| **Secrets (workspace-scoped)** | `secrets` (where `workspaceId IS NOT NULL`) | `teamId` + `workspaceId` | **NEEDS RE-ENTRY** — encrypted under source-team key; not portable; rows deleted; user must re-enter |
| **Secrets (team-scoped)** | `secrets` (where `workspaceId IS NULL`) | `teamId` | **LEFT BEHIND** — belong to source team; not affected |
| **Account-workspace access** | `account_workspaces` | `accountId` + `workspaceId` | **WILL BREAK** — source-team runner accounts cleared; destination team must add their accounts |
| **GitHub App installation** | `workspaces.githubInstallationId`, `github_installations`, `github_repos` | GitHub org | **PRECHECK REQUIRED** — destination team must have the App on same org; blocks migration if not |
| **Knowledge — memory corpus** | external memory service (`memory.buildd.dev`) | `{teamId}:memory` | **LEFT BEHIND** — team-keyed namespace stays with source team; see §Knowledge |
| **Notification preferences** | `notification_preferences` | `teamId` | **LEFT BEHIND** — source team's preferences unchanged; destination team has its own row |
| **Worker heartbeats** | `worker_heartbeats` | `accountId`, `workspaceIds[]` | **NOT AFFECTED** — transient runner registration; entries re-register naturally |
| **Team memberships** | `team_members` | `teamId` | **NOT AFFECTED** — membership is per-team; no migration action |
| **Team invitations** | `team_invitations` | `teamId` | **NOT AFFECTED** |
| **Accounts** | `accounts` | `teamId` | **NOT AFFECTED** — accounts belong to teams, not workspaces |
| **User feedback** | `user_feedback` | `teamId` + `userId` | **NOT AFFECTED** — team-scoped signal; stays with source team |
| **System cache** | `system_cache` | global | **NOT AFFECTED** |
| **Tenant budgets** | `tenant_budgets` | `teamId` | **NOT AFFECTED** |
| **Device codes** | `device_codes` | `userId` | **NOT AFFECTED** |
| **OAuth clients** | `oauth_clients` | global | **NOT AFFECTED** |

---

## Entity Behavior Details

### Tasks, Workers, Artifacts

All three are FK'd to the workspace by `workspaceId`. Since the workspace UUID is stable, every
task (all statuses), every worker record, and every artifact moves with the workspace without any
row modification.

**In-flight tasks**: a task `in_progress` at migration time continues running. The worker's
`workspaceId` is unchanged; the runner sees no interruption. The operational concern is that the
worker's `accountId` may be a source-team account. The destination team should add their accounts
to `account_workspaces` promptly. The post-migration checklist flags this.

**Artifacts with R2 storage**: `artifacts.storageKey` references R2 objects. R2 is global (not
team-scoped); objects remain accessible after migration. No re-upload needed.

### Missions

Missions carry both a `teamId` and a nullable `workspaceId`.

**Workspace-linked missions** (`workspaceId = migratingWorkspaceId`): update `teamId` to
destination. These missions belong to the workspace conceptually and follow it.

**Team-level missions** (`workspaceId IS NULL`) and missions for other workspaces: stay with
source team. Tasks in the migrated workspace that reference these missions retain the FK — the
task's `missionId` still points to a mission that now lives in the source team. Those tasks are
visible in the destination workspace's task list but their mission context is in the source team's
feed. Flag each such task in the dry-run report as LEFT BEHIND (mission link).

**Sub-mission and `dependsOnMission` chains**: the dry-run must scan workspace-linked missions'
`parentMissionId` and `dependsOnMissionId`. If the parent or upstream mission is NOT
workspace-linked (stays in source team), flag in the report as WILL BREAK — the
`dependsOnMission` gate will never satisfy from the destination team's perspective. The
recommended resolution is to sever the `dependsOnMissionId` FK on the workspace-linked mission
before migration (user decision).

### Task Schedules

Schedules use `workspaceId` FK with `onDelete: cascade`. Since the workspace UUID is stable, the
schedule rows continue referencing the correct workspace after `teamId` update. The cron fires as
before; spawned tasks land in the migrated workspace under the destination team. Timezone,
`activeHoursStart/End`, `activeHoursTimezone`, and `cronExpression` are unaffected.

### Roles / Skills

`workspace_skills` rows have a `teamId` and an optional `workspaceId`:

- **Workspace-scoped rows** (`workspaceId = migratingWorkspaceId`): workspace overrides. Update
  `teamId` to destination. These rows follow the workspace.
- **Team-level rows** (`workspaceId IS NULL`, `teamId = sourceTeamId`): source team's shared
  roles. NOT owned by the workspace. Stay with source team.

**`canDelegateTo` audit**: workspace-scoped skills may list source-team role slugs in
`canDelegateTo`. After migration, those slugs resolve against the destination team's skill
registry. The dry-run report must enumerate every `canDelegateTo` target for workspace-scoped
skills and flag any that do NOT exist in the destination team's skill registry as WILL BREAK.

**`configStorageKey` / `configHash`**: role config tarballs in R2 are global. After migrating the
skill row, the R2 object remains accessible. The next config push will rebuild under destination
team context; no immediate action needed.

**Default roles (Organizer, Builder, Researcher)**: these are seeded at workspace creation from
`apps/web/src/lib/default-roles.ts`. If the source team has workspace-scoped overrides of these
roles, they migrate. If the destination team's team-level roles differ, workspace-scoped overrides
take precedence (existing resolution order). No special handling required.

### Secrets

Secrets are encrypted with a **team-specific key**. Encrypted values cannot be re-encrypted for
the destination team without the original plaintext, which is never stored.

| `purpose` | Workspace-scoped? | Migration behavior |
|---|---|---|
| `anthropic_api_key` | Account-level (`accountId`) | LEFT BEHIND — belongs to source team account |
| `oauth_token` | Account-level | LEFT BEHIND |
| `codex_credential` | Account-level | LEFT BEHIND |
| `mcp_connector_credential` | Team-level (via connector) | WILL BREAK — deleted when connector_workspaces rows are removed |
| `mcp_credential` | May be workspace-scoped | NEEDS RE-ENTRY — list by `label` in dry-run report |
| `vercel_token` | May be workspace-scoped | NEEDS RE-ENTRY |
| `webhook_token` | May be workspace-scoped | NEEDS RE-ENTRY |
| `custom` | May be workspace-scoped | NEEDS RE-ENTRY |
| `pushover` | Team-level | LEFT BEHIND |
| `notify_webhook` | Team-level | LEFT BEHIND |

**Post-migration flow**: workspace-scoped secret rows (where `workspaceId = migratingWorkspaceId`)
are **deleted** at migration time. They are inaccessible once the workspace leaves the source team
(decryption would fail against the wrong team key). The post-migration checklist lists each
deleted secret by `label` so the user knows exactly what to re-enter.

### Connectors / MCP OAuth Grants

`connectors` rows are `teamId`-scoped — they are the source team's connector registry.
`connector_workspaces` is the per-workspace enablement junction.

**OAuth grants FROM external services TO buildd** (stored in `connectors.encryptedClientSecret`
and `secrets` with `purpose='mcp_connector_credential'`): these credentials are issued to the
source team's connector endpoint. They are **not portable** — re-authorization must be performed
under the destination team's context.

**Connector types affected** (all `connectors` rows that have a `connector_workspaces` row for
this workspace):
- `authMode='oauth'`: OAuth client credentials and tokens — NOT portable. User must re-add
  connector in destination team and complete OAuth flow.
- `authMode='header'`: API key stored as `mcp_connector_credential` secret — NOT portable
  (encrypted under source team key). User must re-add connector and re-enter API key.
- `authMode='none'`: connector URL is the only config; no auth token — re-addable without
  re-authorization (just re-add connector in destination team).

**Migration action**:
1. Enumerate `connector_workspaces` rows for the migrating workspace.
2. Include each in dry-run report as NEEDS RE-AUTH (with name and authMode).
3. Delete all `connector_workspaces` rows at migration time.
4. The `connectors` rows stay in source team untouched.

**OAuth tokens issued BY external MCP clients TO buildd** (`oauth_refresh_tokens`,
`oauth_codes`): these are workspace-scoped (`workspaceId`) and survive migration. Existing client
sessions from tools like claude.ai that connected to this workspace's MCP endpoint remain valid.
No user action needed.

### GitHub App Installation

The GitHub App is installed on a GitHub org/account — not on a buildd team. Multiple buildd
teams can share the same installation.

`workspaces.githubInstallationId` references `github_installations.id`, which holds the GitHub
installation for the repo's org (e.g., `buildd-ai`).

**Precheck**: before migration executes, verify that the destination team has at least one
workspace already referencing the same `githubInstallationId`, OR that at least one
`github_repos` row under this installation is accessible to the destination team. If neither is
true, **migration blocks** with a precheck failure:

> "Migration blocked: The destination team does not have the GitHub App installed on the
> `{repoOrg}` organization. Install the app at github.com/apps/buildd and authorize the org,
> then retry."

**After precheck passes**: `workspaces.githubRepoId` and `githubInstallationId` are unchanged.
GitHub API calls continue using the same installation token. No action needed.

### Knowledge Namespaces

`buildNamespace(scopeId, corpus)` formats namespaces as `"{scopeId}:{corpus}"`.

| Corpus | Namespace key | Behavior after migration |
|---|---|---|
| `code` | `{workspaceId}:code` | **MOVES CLEANLY** — workspaceId unchanged |
| `docs` | `{workspaceId}:docs` | **MOVES CLEANLY** |
| `spec` | `{workspaceId}:spec` | **MOVES CLEANLY** |
| `task` | `{workspaceId}:task` | **MOVES CLEANLY** |
| `artifact` | `{workspaceId}:artifact` | **MOVES CLEANLY** |
| `pr` | `{workspaceId}:pr` | **MOVES CLEANLY** |
| `plan` | `{workspaceId}:plan` | **MOVES CLEANLY** |
| `session` | `{workspaceId}:session` | **MOVES CLEANLY** |
| `memory` | `{teamId}:memory` (external memory service) | **LEFT BEHIND** — team-keyed; stays in source team's namespace |

The memory corpus is the only corpus scoped to `teamId`. Agents that previously saved workspace
memories under `{sourceTeamId}:memory` cannot access those memories after migration without
explicitly copying them to `{destinationTeamId}:memory`. The post-migration checklist notes the
count of memory chunks left behind and provides guidance on optional re-ingest.

`knowledge_entities`, `entity_aliases`, `chunk_entities`, `pending_entity_refs`, and
`knowledge_edges` all store `workspaceId` as a plain text field (no FK). They are not affected by
the workspace's `teamId` change and require no action.

### Account-Workspace Access

`account_workspaces` links buildd API accounts (runner tokens, service accounts) to workspaces.
Accounts are `teamId`-scoped, so source-team accounts are not appropriate for a destination-team
workspace.

**Migration action**:
1. Enumerate `account_workspaces` rows for the migrating workspace.
2. Include source-team account names in the dry-run report as WILL BREAK.
3. Delete all `account_workspaces` rows for the workspace at migration time.
4. Destination team adds their accounts via workspace settings post-migration.

The post-migration checklist includes: "Add runner accounts to workspace access control."

---

## Breakage Policy

Partial breakage is acceptable if surfaced. A migration must never silently destroy data.

**Non-negotiable**: partial breakage must be shown to the user before execution. Every WILL BREAK
and NEEDS RE-ENTRY item requires explicit user acknowledgment. The migration will not proceed
until all items are checked.

**Deletion scope**: only rows that are inaccessible after migration (workspace-scoped secrets,
connector_workspaces, account_workspaces) are deleted. Nothing else is deleted. Team-level rows
that LEFT BEHIND are untouched — the source team retains full access to its own data.

---

## Pre-Migration Report (Dry Run)

The dry-run report is generated by `POST /api/workspaces/[id]/migrate/precheck` and returned
before any mutation occurs. It is also stored as an `artifact` on the source workspace for
audit history.

### Report format

```
Workspace Migration Dry Run
Workspace: "{workspaceName}" ({workspaceId})
Source team: {sourceTeamName}
Destination team: {destinationTeamName}
Generated: {ISO timestamp}

PRECHECK STATUS: PASS | FAIL

  GitHub App: {org} — destination team has installation ✓
              — or — FAIL: destination team missing GitHub App on {org}

SUMMARY
  MOVES CLEANLY:    {N} entity classes (tasks, workers, artifacts, schedules, ...)
  NEEDS RE-ENTRY:   {N} secrets (see detail)
  NEEDS RE-AUTH:    {N} connectors
  WILL BREAK:       {N} items (delegation chains, account access)
  LEFT BEHIND:      {N} items (team secrets, team missions, memory corpus)

ENTITY DETAIL

Tasks                 {count} across all statuses       MOVES CLEANLY
Workers               {count} records ({N} in-flight)   MOVES CLEANLY
Artifacts             {count} artifacts                  MOVES CLEANLY
Task Schedules        {count} schedules                  MOVES CLEANLY
  "Daily standup sync" (cron: 0 9 * * 1-5)
  "Weekly report" (cron: 0 8 * * 1)
Watched Projects      {count}                            MOVES CLEANLY

Missions (workspace)  {count} workspace-linked missions  MOVES CLEANLY
  "Sprint 12" (active, 4 tasks in-progress)
  ⚠ "Sprint 10" — dependsOnMission "Team Roadmap" which stays in source team → gate WILL BREAK

Missions (team-level) {count} team missions stay in source team  LEFT BEHIND
  "Team OKRs" (N tasks in this workspace reference this mission — mission feed stays in source)

Roles (workspace)     {count} workspace-scoped roles     MOVES CLEANLY
  ⚠ "Builder" canDelegateTo "researcher" — slug not found in destination team → WILL BREAK
  ⚠ "Builder" canDelegateTo "qa-role" — slug not found in destination team → WILL BREAK
Roles (team-level)    {count} team roles stay in source team  LEFT BEHIND

Secrets               {count} workspace-scoped secrets   NEEDS RE-ENTRY (deleted at migration)
  • mcp_credential "GITHUB_TOKEN"
  • vercel_token "VERCEL_PROD_TOKEN"
  • custom "STRIPE_WEBHOOK_SECRET"

Connectors            {count} connectors enabled for this workspace  NEEDS RE-AUTH (rows deleted)
  • "Linear" (OAuth) — re-add and re-authorize in destination team
  • "GitHub Search" (header) — re-add and re-enter API key in destination team
  • "Internal Tools" (none) — re-add in destination team (no re-auth needed)

Account Access        {count} account-workspace entries  WILL BREAK (rows deleted)
  Source-team runner accounts removed; add destination-team accounts post-migration.

GitHub App            repo: buildd-ai/buildd             MOVES CLEANLY ✓

Knowledge (DB)        {workspaceId}:* namespaces         MOVES CLEANLY
Knowledge (memory)    {teamId}:memory (external service) LEFT BEHIND
  {N} memory chunks remain under source team namespace

OAuth MCP tokens      {count} active client sessions     MOVES CLEANLY (workspace-scoped)
```

### Confirmation gate

Before the "Migrate" button activates:
- Every NEEDS RE-ENTRY item must be individually checked: `☑ I will re-enter "GITHUB_TOKEN" in the destination team`
- Every WILL BREAK item must be individually checked: `☑ I understand "Builder" → "researcher" delegation will break`
- A single checkbox covers all LEFT BEHIND items: `☑ I understand {N} items stay with the source team`
- PRECHECK FAIL blocks the button entirely with instructions to resolve before retrying

---

## Execution Mechanism: Mission-Driven vs. Dedicated API

### Option A: Mission-Driven

Run the migration as a mission/task in the destination team. An agent heartbeat drives phases
(precheck → dry-run report → approval gate → entity moves → verification → checklist artifact).

**Pros**: built-in auditability, retry semantics via task re-claim, existing review-gate UX
handles the approval gate, progress visible in mission feed.

**Cons**: migration logic runs inside an agent turn — slow, non-transactional, agent failures
mid-execution could leave partial state. DB entity moves must be atomic per entity class; an agent
cannot atomically UPDATE + rollback across multiple Neon HTTP calls. The approval gate introduces
a network round-trip inside the agent's context window that may time out.

### Option B: Dedicated API + Transaction

A `POST /api/workspaces/[id]/migrate/execute` endpoint that executes entity moves in a
Neon-HTTP-safe sequence (no `db.transaction()` per CLAUDE.md — use atomic `UPDATE...WHERE` with
`.returning()`).

**Pros**: fast, deterministic, each entity class updated atomically, clear rollback path, no
agent overhead.

**Cons**: no built-in retry UI; no mission feed visibility.

### Recommendation: Hybrid (Option B initiated by a task)

**Use Option B for the actual migration**, but wrap it in a buildd task:

1. User initiates migration from workspace settings UI. A task is created in the destination team
   (role: admin, category: infra) that will own the migration lifecycle.
2. The task agent calls `POST /api/workspaces/[id]/migrate/precheck` and posts the dry-run report
   as an artifact and a `post_note` (type: `question`) to the mission feed, then awaits user
   confirmation using the existing approval pattern.
3. On user confirmation (`send_agent_message` / note reply), the agent calls
   `POST /api/workspaces/[id]/migrate/execute`. DB work runs server-side in the API handler.
4. The agent creates the post-migration checklist artifact and calls `complete_task`.

This gives auditability (task record, note feed), retry semantics (task can be re-claimed if the
agent crashes), and approval-gate UX — without running DB mutations inside an agent turn.

**Safe execution order** (minimizes partial-failure blast radius):
1. Validate permissions (read-only) — abort if fails
2. Run precheck (read-only) — abort if fails (GitHub App gate)
3. Confirm user approved (check confirmation token or `approvedAt` timestamp)
4. Update `workspaces.teamId` — core identity move (reversible)
5. Update `missions.teamId` for workspace-linked missions — reversible
6. Update `workspace_skills.teamId` for workspace-scoped rows — reversible
7. Delete `account_workspaces` rows — destructive; do after identity moves
8. Delete `connector_workspaces` rows — destructive; do after identity moves
9. Delete workspace-scoped `secrets` — destructive; do last; record labels in checklist first
10. Create post-migration checklist artifact

If step N fails, steps 1..N-1 are already applied. The repair endpoint (BT-13) can resume from
the failed step using the `migration_log` table as an idempotency ledger.

---

## UI Surface

### Entry Point

**Workspace Settings** page → "Danger Zone" section → "Migrate Workspace" button.

Also available from the custom workspace dropdown (when that feature lands, task 135f6057) for
teams managing many workspaces.

### Migration Flow

1. **Destination team picker** — dropdown of teams where the current user is admin, excluding the
   current team. Shows team name + slug + member count.

2. **Dry-run report view** — full entity report rendered inline. Entity groups are collapsible;
   NEEDS RE-ENTRY and WILL BREAK groups are expanded by default. MOVES CLEANLY groups are
   collapsed. A PRECHECK FAIL banner replaces step 3 if the GitHub App gate fails.

3. **Confirmation screen** — per-item checkboxes for every NEEDS RE-ENTRY and WILL BREAK item,
   plus a single acknowledgment checkbox for LEFT BEHIND items. "Migrate" CTA is disabled until
   all checkboxes are checked.

4. **Progress view** — entity-class checkmarks appear as each phase of the migration API call
   completes. Estimated time: < 5 seconds for most workspaces.

5. **Post-migration screen** — "Migration complete. {workspaceName} now belongs to
   {destinationTeamName}." Renders the post-migration checklist inline with links to workspace
   settings for re-entering secrets, the connectors page for re-authorization, and workspace
   settings for adding runner accounts.

### Post-Migration Checklist (artifact)

Stored as `type=report` artifact on the workspace in the destination team. Created by the
migration task agent. Survives the migration and is surfaced on the post-migration screen.

```markdown
# Post-Migration Checklist: {workspaceName}
Migrated: {sourceTeamName} → {destinationTeamName}
Date: {ISO timestamp}

## Required actions

- [ ] Re-enter secret: mcp_credential "GITHUB_TOKEN" in workspace settings → Secrets
- [ ] Re-enter secret: vercel_token "VERCEL_PROD_TOKEN" in workspace settings → Secrets
- [ ] Re-authorize connector "Linear" (OAuth) in destination team → Connections
- [ ] Re-add connector "GitHub Search" (API key) in destination team → Connections
- [ ] Add runner accounts to workspace access (workspace settings → Access)
- [ ] Fix role delegation: "Builder" canDelegateTo "researcher" — create or map role
      in destination team → Team → Roles

## Optional

- [ ] Re-ingest team memories: {N} memory chunks remain under source team namespace.
      Run `buildd_memory action=save` in the destination team to rebuild workspace context.

## Completed automatically

- ✓ {count} tasks, {count} workers, {count} artifacts moved with workspace
- ✓ {count} schedules continue firing unchanged
- ✓ {count} workspace-linked missions moved with workspace
- ✓ GitHub App installation valid for destination team
- ✓ Knowledge graph (code/docs/spec/task/plan corpora) intact — no re-ingest needed
- ✓ Active MCP client sessions remain valid
```

---

## Rollback

### Reversible via reverse migration

A workspace migration is reversible: migrate the workspace back to the source team using the same
flow. The UI should surface "Move workspace back to {sourceTeamName}" on the post-migration
screen.

**Preserved across a round-trip**:
- All tasks, workers, artifacts, schedules, watched projects — FK-stable, unaffected by teamId
- Workspace-scoped skills — `teamId` is restored
- Workspace-linked missions — `teamId` is restored

### NOT reversible

- **Secrets deleted at migration time**: workspace-scoped secrets were deleted because they cannot
  be re-encrypted against the wrong team key. Migrating back does not restore them; re-entry is
  required in the source team after returning.
- **OAuth grants re-issued at destination**: revoking those grants requires manual action in the
  connector's authorization server. Moving back does not revoke them.
- **Team memories written post-migration**: memories saved by agents in the destination team are
  in the destination team's namespace. They do not migrate back automatically.
- **Account-workspace access**: cleared at migration; must be manually re-added in the source
  team after returning.

### Alias period

We recommend **against** a soft-copy/alias period (workspace visible in both teams
simultaneously). Dual-visibility creates ownership ambiguity, billing double-counting, and access
control conflicts. The migration is atomic: the workspace belongs to exactly one team at all
times. The post-migration checklist is the handoff document.

---

## Build Tasks

The following discrete implementation tasks should be filed for approval after Max reviews this
spec. Each is independently shippable in the order listed.

| # | Title | Files / areas | Notes |
|---|---|---|---|
| BT-1 | **Schema: `migration_log` table** | `packages/core/db/schema.ts`, migration SQL | Tracks migration phases (workspaceId, sourceTeamId, destinationTeamId, phase, status, error, startedAt, completedAt). Idempotency ledger for the repair endpoint. Run `bun db:generate`. |
| BT-2 | **API: precheck endpoint** | `apps/web/src/app/api/workspaces/[id]/migrate/precheck/route.ts` | `POST` — validates permissions, runs GitHub App check, returns dry-run report JSON (entity counts + MOVES CLEANLY / NEEDS RE-ENTRY / NEEDS RE-AUTH / WILL BREAK / LEFT BEHIND per class). No mutations. Returns a signed `dryRunToken` (HMAC over `{workspaceId}:{destinationTeamId}:{timestamp}`) required to call the execute endpoint. Test: precheck returns 403 when user is not admin on both teams; returns correct entity counts; returns PRECHECK FAIL when GitHub App missing. |
| BT-3 | **API: execute endpoint** | `apps/web/src/app/api/workspaces/[id]/migrate/execute/route.ts` | `POST {dryRunToken, destinationTeamId, confirmedItems[]}` — validates token freshness (5 min TTL), verifies all WILL BREAK / NEEDS RE-ENTRY items are acknowledged in `confirmedItems`, runs entity moves in safe order (§Execution), writes `migration_log` rows per phase, returns migration summary. |
| BT-4 | **Entity moves: workspace teamId** | Inside BT-3 | `UPDATE workspaces SET team_id = dest WHERE id = X AND team_id = source`. First move; most reversible. |
| BT-5 | **Entity moves: missions teamId** | Inside BT-3 | `UPDATE missions SET team_id = dest WHERE workspace_id = X AND team_id = source`. Sever `dependsOnMissionId` for cross-team chains flagged in dry-run. |
| BT-6 | **Entity moves: workspace_skills teamId** | Inside BT-3 | `UPDATE workspace_skills SET team_id = dest WHERE workspace_id = X AND team_id = source`. |
| BT-7 | **Entity moves: clear account_workspaces** | Inside BT-3 | `DELETE FROM account_workspaces WHERE workspace_id = X`. Record deleted account names in checklist. |
| BT-8 | **Entity moves: clear connector_workspaces** | Inside BT-3 | `DELETE FROM connector_workspaces WHERE workspace_id = X`. Record connector names/authMode in checklist. |
| BT-9 | **Entity moves: delete workspace-scoped secrets** | Inside BT-3 | `DELETE FROM secrets WHERE workspace_id = X`. Record each `label` in checklist before deleting. |
| BT-10 | **Post-migration checklist artifact** | Inside BT-3 | Create `artifact(type=report)` on workspace after execute completes. Content: §Post-Migration Checklist format. |
| BT-11 | **API: repair endpoint** | `apps/web/src/app/api/workspaces/[id]/migrate/repair/route.ts` | `POST` — reads `migration_log` to determine last completed phase, re-runs from first failed phase. Requires admin on destination team. Idempotent per phase (uses migration_log `status` to skip already-completed phases). |
| BT-12 | **Tests: precheck** | `apps/web/src/app/api/workspaces/[id]/migrate/precheck/route.test.ts` | 403 on missing team membership; correct entity counts; PRECHECK FAIL on missing GitHub App; signed token returned. |
| BT-13 | **Tests: execute** | `apps/web/src/app/api/workspaces/[id]/migrate/execute/route.test.ts` | Rejects stale/tampered token; rejects missing confirmedItems; moves teamId correctly; in-flight workers continue; schedule fires post-migration; secrets deleted with checklist entries recorded; test reverse migration restores teamId. |
| BT-14 | **UI: migration entry point** | `apps/web/src/app/app/(protected)/settings/page.tsx` | "Migrate Workspace" button in Danger Zone. Disabled when user is not admin. |
| BT-15 | **UI: destination team picker + dry-run report view** | New component `WorkspaceMigrationModal` | Collapsible entity groups; NEEDS RE-ENTRY / WILL BREAK expanded by default; MOVES CLEANLY collapsed; per-item checkboxes; PRECHECK FAIL banner. |
| BT-16 | **UI: progress + post-migration screen** | Inside `WorkspaceMigrationModal` | Phase checkmarks during execute; "Migration complete" confirmation with checklist link. |

**Order recommendation**: BT-1 → BT-2 → {BT-3 through BT-10 as a single PR, ordered internally} → BT-11 → {BT-12, BT-13 in parallel} → BT-14 → BT-15 → BT-16.

BT-1 (schema) is the prerequisite for everything. BT-2 (precheck) can be shipped and used in UI
before BT-3 (execute) is ready, allowing the dry-run UX to be tested independently. BT-11
(repair) can follow once BT-3 is stable in production.

---

## Test Plan

### Unit tests

| File | Test |
|---|---|
| `precheck/route.test.ts` | Returns 403 when user is not admin on source team |
| same | Returns 403 when user is not admin on destination team |
| same | Returns PRECHECK FAIL when GitHub App installation not shared with destination team |
| same | Returns correct entity counts for all MOVES CLEANLY classes |
| same | Flags workspace-scoped secrets as NEEDS RE-ENTRY with correct labels |
| same | Flags connector_workspaces rows as NEEDS RE-AUTH with connector names |
| same | Flags broken `canDelegateTo` chains as WILL BREAK |
| `execute/route.test.ts` | Rejects request with stale dry-run token (>5 min old) |
| same | Rejects request with tampered token |
| same | Rejects request when confirmedItems missing a WILL BREAK item |
| same | Updates `workspaces.teamId` to destination team |
| same | Updates `missions.teamId` for workspace-linked missions only |
| same | Does NOT update missions where `workspaceId IS NULL` |
| same | Updates `workspace_skills.teamId` for workspace-scoped rows only |
| same | Deletes `account_workspaces` rows for migrated workspace |
| same | Deletes `connector_workspaces` rows for migrated workspace |
| same | Deletes workspace-scoped secrets; leaves team-scoped secrets intact |
| same | Creates post-migration checklist artifact in destination team |
| same | In-flight worker `workspaceId` remains unchanged and valid post-migration |
| same | Reverse migration (source ← destination) restores `teamId` on all entity classes |
| same | Task schedule continues to spawn tasks under destination team after migration |

### Integration smoke test

End-to-end against a preview environment:

1. Precheck returns correct dry-run report for a workspace with tasks, schedules, a connector, and a secret
2. Execute migrates the workspace; tasks visible in destination team's dashboard
3. In-flight worker completes successfully post-migration
4. Cron schedule fires and creates task under destination team post-migration
5. Reverse migration moves workspace back; source team regains access

---

## Migration / Rollout Notes

- BT-1 migration SQL: additive new table — safe to deploy independently. Run `bun db:generate && bun db:migrate`.
- The precheck and execute endpoints are admin-only (`level: 'admin'` account check). No worker-token access.
- No feature flags required. The UI entry point is gated on user admin membership.
- No effect on non-migrating workspaces or teams.
