# Private Task Execution

**Status:** Spec (audit + design) — no implementation yet  
**Author:** Agent  
**Date:** 2026-07-17  
**Related:** MCP OAuth (`/api/mcp-oauth/[workspace]`), credentials architecture (`docs/credentials-architecture.md`)

---

## 1. Problem

Cue uses Buildd as its execution substrate. Every Cue-originated mission and task currently renders in the Buildd dashboard alongside human-created work. The Buildd UI is a _human_ workspace; exposing Cue's internal system tasks there creates noise, potential data leakage, and confusion about which tasks humans should pay attention to.

The goal is **private execution**: tasks that run normally (claim → work → complete) but are invisible to users logging into the Buildd UI — readable only by:

- The originating app (Cue) via its MCP OAuth `client_id`
- Admin accounts with an explicit "show system tasks" escape hatch

---

## 2. Audit: Current State

### 2.1 Auth identity model

Two auth paths today:

| Path | Token shape | `client_id` available? |
|------|-------------|----------------------|
| API key (`bld_xxx`) | Looked up in `accounts.apiKey` | No — accounts have no clientId field |
| OAuth JWT | `{ sub: userId, client_id, workspace_id }` | **Yes** — `oauthClients.clientId` in JWT |

The MCP OAuth route (`/api/mcp-oauth/[workspace]/route.ts`) extracts `client_id` from the verified JWT and uses it for the `ActionContext`. However, **it does not record `client_id` on created tasks**. Once a task is created, there is no record of which OAuth client originated it.

### 2.2 Task creation tracking today

`tasks` table has:
- `createdByAccountId` — the `accounts.id` that created the task (FK)
- `createdByWorkerId` — if created by another worker
- `creationSource` — enum (`'dashboard' | 'api' | 'mcp' | 'github' | 'schedule' | 'webhook' | 'orchestrator'`)

What's missing: the **originating OAuth client identity** (`client_id`) is not stored anywhere on the task.

### 2.3 Read-path leak points (full audit)

Every path below currently returns private tasks to human workspace members:

| Path | Location | Notes |
|------|----------|-------|
| `GET /api/tasks` | `apps/web/src/app/api/tasks/route.ts` | Lists all tasks in workspace IDs; no visibility filter |
| `GET /api/tasks/[id]` | `apps/web/src/app/api/tasks/[id]/route.ts` | Returns any task if workspace member |
| `/app/tasks` UI page | `apps/web/src/app/app/(protected)/tasks/page.tsx` | Direct DB query, no visibility filter |
| `/app/tasks/[id]` detail page | Protected route | No visibility filter |
| Mission detail panel | `apps/web/src/app/app/(protected)/missions/[id]/` | Shows linked tasks |
| Mission context builder | `apps/web/src/lib/mission-context.ts` | Queries active tasks for orchestrator prompt |
| `GET /api/missions/[id]` | Mission API | Returns linked task summaries |
| MCP `list_tasks` | `packages/core/mcp-tools.ts:542` | Calls `GET /api/tasks` — inherits fix if API fixed |
| MCP `get_task` | `packages/core/mcp-tools.ts:581` | Calls `GET /api/tasks/[id]` |
| Heartbeat evaluator | `apps/web/src/lib/mission-context.ts:buildMissionContext` | Includes private tasks in evaluation context |
| Worker status `PATCH /api/workers/[id]` | On completion — triggers knowledge ingest | Private task outcomes land in team-visible `{workspaceId}:task` corpus |
| `/app/home` timeline | `apps/web/src/app/app/(protected)/home/` | Shows recent tasks |
| `/api/workspaces/[id]/last-release` | Release view | May include task references |

### 2.4 Pusher broadcast leak points

Pusher channels:
- `workspace-{id}` — broadcasts `task:created`, `task:claimed`, `task:completed`, `task:failed`
- `task-{id}` — per-task progress events (worker progress, waiting input)
- `mission-{id}` — mission feed events including `mission:note_posted`

All Pusher events on the workspace channel are currently sent regardless of task visibility. A human subscriber to `workspace-{id}` would receive `task:created` for private Cue tasks.

### 2.5 Artifact & share URL leak

Artifacts created by a private task's worker have a `shareToken`. The `/share/[token]` route is **publicly accessible** — no auth. A private task with visible artifacts or PR links leaks its content via share URL.

The `POST /api/workers/[id]/artifacts` route creates artifacts with `shareToken` and returns `shareUrl` to the worker. The share route reads `artifacts.shareToken` with no visibility check.

### 2.6 Knowledge store ingestion leak

On `complete_task`, the worker route calls the knowledge store upsert pipeline:

- Task outcomes ingested into `{workspaceId}:task` namespace (shared with all workspace/team members via `query_knowledge corpus=task`)
- Artifacts ingested into `{workspaceId}:artifact` namespace

Private task outcomes would surface in `query_knowledge` results visible to human workspace members (and to all other workers in the workspace).

### 2.7 Notifications & mission feed

- Pusher `mission:note_posted` events — if a private task has a `missionId`, notes posted by its worker appear in the mission feed
- Pushover notifications (via `apps/web/src/lib/pushover.ts`) — workspace-level alerts include task references; not audited for per-task filtering
- Callback URL (`tasks.callbackUrl`) — already scoped to the task creator; no change needed

### 2.8 Orchestrator / heartbeat

`buildMissionContext()` queries the active task list for a mission when evaluating the heartbeat. If Cue-originated private tasks are linked to a _public_ mission, they would appear in the orchestrator's context and potentially be referenced in notes/questions posted to the mission feed.

If private tasks are linked to a _private mission_, and the mission itself is not filtered, the mission would still appear in the mission list.

---

## 3. Approaches Evaluated

### Option 1: Visibility flag (soft privacy)

Add `tasks.visibility: 'private' | 'workspace'` (default `'workspace'`). UI list/detail queries filter `WHERE visibility = 'workspace'`. 

**Pros:** Simple, one column, easy to understand.  
**Cons:** Soft — only hides from UI; API reads (non-session auth) still expose all tasks to any account with workspace access.

### Option 2: Principal-scoped ownership (read-layer enforcement)

Record the creating MCP OAuth `client_id` on private tasks. Read paths enforce: `WHERE visibility = 'workspace' OR (visibility = 'private' AND ownerClientId = <requesting client's id>)`.

**Pros:** Enforced at the data layer, not just UI. Any read path that goes through the enforced query is automatically safe. Maps naturally to the OAuth client identity model already in the JWT.  
**Cons:** More logic in read paths; the `client_id` is only available on OAuth-authenticated requests — API key requests can only see private tasks via the admin escape hatch.

### Option 3: System workspace

A workspace flagged `workspaces.type = 'system'` that never renders in the UI. All Cue tasks run in this workspace.

**Pros:** Simple containment — no per-task filtering.  
**Cons:** Blunt; billing rollups by workspace are preserved but task-level attribution is lost. Requires Cue to use a different workspace than it does for public tasks.

### Recommendation

**MVP = Option 2 (principal-scoped ownership).** Option 1 alone is insufficient (API leaks). Option 3 requires workspace restructuring and can't selectively hide tasks within a shared workspace. Option 2 is the right shape for a generic "app-owned tasks" feature that composes with the MCP OAuth client model.

Option 3 (system workspace) remains a useful hardening layer for Phase 2, if Cue moves entirely to a dedicated workspace.

---

## 4. Recommended Design

### 4.1 Schema changes

**`tasks` table — two new columns:**

```sql
-- Which principal owns this task (null = public/workspace-scoped)
ALTER TABLE tasks ADD COLUMN owner_client_id text REFERENCES oauth_clients(client_id) ON DELETE SET NULL;

-- Visibility: 'workspace' = default, visible to all workspace members
--             'private'   = visible only to ownerClientId + admin accounts
ALTER TABLE tasks ADD COLUMN visibility text NOT NULL DEFAULT 'workspace'
  CHECK (visibility IN ('private', 'workspace'));
```

**Index:**

```sql
CREATE INDEX tasks_visibility_idx ON tasks (visibility);
CREATE INDEX tasks_owner_client_idx ON tasks (owner_client_id);
```

**Migration file:** `packages/core/drizzle/0NNN_private_task_execution.sql`

**Schema TS (`packages/core/db/schema.ts`):**

```ts
// In tasks table definition:
ownerClientId: text('owner_client_id'), // FK to oauthClients.clientId, nullable
visibility: text('visibility').notNull().default('workspace')
  .$type<'private' | 'workspace'>(),
```

No migration is needed for existing tasks — `DEFAULT 'workspace'` makes all existing rows public, which is the correct behavior (no backfill required).

### 4.2 Task creation: recording the owning client

When a task is created via MCP OAuth, the JWT carries `client_id`. The creation flow must propagate this:

**In `apps/web/src/app/api/mcp-oauth/[workspace]/route.ts`** — the `ActionContext` already has the JWT claims; extend it with `oauthClientId: string | null`:

```ts
// In createMcpServer(), add to ActionContext:
oauthClientId: claims.client_id,  // from the verified JWT
```

**In `packages/core/mcp-tools.ts`** — the `create_task` handler calls `POST /api/tasks`. Add `ownerClientId` and `visibility` to the forwarded body when `ctx.oauthClientId` is set:

```ts
// In create_task handler:
if (ctx.oauthClientId && taskBody.visibility === 'private') {
  taskBody.ownerClientId = ctx.oauthClientId;
}
```

**In `apps/web/src/app/api/tasks/route.ts` (POST)** — write `ownerClientId` and `visibility` to the DB.

**API surface:** `create_task` gains an optional `visibility?: 'private' | 'workspace'` param. Setting `visibility: 'private'` on a task created by a non-OAuth-client request is a no-op (visibility is stored but no `ownerClientId` → admin escape hatch is the only read path).

### 4.3 Read-path enforcement

Define a reusable helper:

```ts
// apps/web/src/lib/task-visibility.ts
export type ReadPrincipal =
  | { type: 'admin' }                    // admin account — sees everything
  | { type: 'oauth_client'; clientId: string }  // OAuth app — sees its own private tasks
  | { type: 'user' }                     // human session — sees only workspace tasks
  | { type: 'worker'; clientId?: string }  // worker account — same as oauth_client if clientId set

export function visibilityFilter(principal: ReadPrincipal) {
  switch (principal.type) {
    case 'admin':
      return undefined;  // no filter — admin sees all
    case 'oauth_client':
      return or(
        eq(tasks.visibility, 'workspace'),
        and(eq(tasks.visibility, 'private'), eq(tasks.ownerClientId, principal.clientId))
      );
    case 'user':
    case 'worker':
      if (principal.clientId) {
        return or(
          eq(tasks.visibility, 'workspace'),
          and(eq(tasks.visibility, 'private'), eq(tasks.ownerClientId, principal.clientId))
        );
      }
      return eq(tasks.visibility, 'workspace');
  }
}
```

**Apply at every read path:**

| Read path | Enforcement action |
|-----------|-------------------|
| `GET /api/tasks` | Add `visibilityFilter(principal)` to the `where` clause |
| `GET /api/tasks/[id]` | After fetching task, check `isVisible(task, principal)` → 404 if not visible |
| `/app/tasks` page (DB query) | Add filter to `findMany` where clause |
| `/app/tasks/[id]` detail page | Fetch task → redirect 404 if not visible to session user |
| `/app/home` timeline | Add filter |
| Mission detail linked tasks | Filter linked tasks in mission detail query |
| Mission context builder | Filter task list in `buildMissionContext()` |
| MCP `list_tasks` / `get_task` | Inherits fix via `GET /api/tasks` if those routes are fixed |
| Artifact list for worker/task | No change needed — artifact is already scoped to the worker; access is through the task |
| `/share/[token]` artifact share | See §4.5 |

**Determining the principal at each read path:**

- Session auth (`getCurrentUser()`) → principal `{ type: 'user' }`, unless user is team admin → `{ type: 'admin' }`
- API key auth (`authenticateApiKey()`) → check `account.level`: `'admin'` → `{ type: 'admin' }`; otherwise `{ type: 'worker' }`
- OAuth JWT (`verifyAccessToken()`) → `{ type: 'oauth_client', clientId: claims.client_id }`

The `level` column on `accounts` already distinguishes admin from worker. No new tables needed.

### 4.4 Admin escape hatch

**Mechanism:** Admin-level accounts (API key with `accounts.level = 'admin'`, or team owner/admin session users) bypass the visibility filter entirely.

**UI toggle:** A "Show system tasks" toggle in the workspace task list (`/app/tasks`) — only visible to team admins. When toggled on, the page re-fetches with the session's admin bypass. This is a per-session preference (localStorage), not a DB field.

**Implementation:** The `/app/tasks` page already distinguishes user vs. admin via `teamMembers.role`. When `role === 'owner' | 'admin'` and the toggle is active, pass `showPrivate=true` query param to the API route, which then uses the admin principal path.

No environment flag needed for MVP; the account `level` field is the natural gate.

### 4.5 Artifacts and share URLs

**Decision:** Artifacts belonging to private tasks must not be publicly shareable via the `/share/[token]` URL.

**Enforcement:**

1. **Suppress `shareToken` generation** for artifacts belonging to private tasks. In `POST /api/workers/[id]/artifacts`, check `task.visibility === 'private'` → skip `shareToken` generation → return artifact without `shareUrl`.

2. **`/share/[token]` route guard:** Look up the artifact's `workerId` → `workers.taskId` → `tasks.visibility`. If private, return 404 (not 401 — do not confirm the token exists).

3. **Existing artifacts on pre-migration private tasks:** No Cue tasks exist with explicit `visibility = 'private'` today (the column doesn't exist yet). The migration backfill approach (§5.4) can set `visibility = 'private'` on known Cue-created tasks; their share URLs should be reviewed and optionally invalidated by clearing `shareToken`.

### 4.6 Knowledge store ingestion

**Decision:** Private task outcomes must not be ingested into the workspace-shared `{workspaceId}:task` corpus.

**Enforcement in `PATCH /api/workers/[id]` (completion handler):**

```ts
// Before knowledge-store upsert:
if (task.visibility !== 'private') {
  await ingestTaskOutcome(task, knowledgeStore);
}
```

**Alternative namespace (Phase 2):** Instead of suppressing ingestion entirely, private task outcomes could be ingested into `{ownerClientId}:task` — a per-app namespace. This would let Cue's own agents query Cue-specific task history without leaking to human workspace members. This is a Phase 2 concern; MVP suppresses ingestion entirely.

### 4.7 Pusher events

**Decision:** Private tasks must not broadcast to the workspace channel.

**Enforcement:**

In every call to `triggerEvent(channels.workspace(workspaceId), events.TASK_CREATED, ...)`:
- Before sending, check if the task has `visibility = 'private'`
- If private: skip the workspace channel event entirely
- Still send task-channel events (`channels.task(taskId)`) — these are per-task and can only be subscribed to by someone who already knows the task ID (i.e., the owning app)

Worker progress events (`channels.worker(workerId)`) are per-worker and not visible on the workspace channel — no change needed.

**Mission feed:** Notes posted via `post_note` on a private task's mission are suppressed from the Pusher `mission:note_posted` event if the task is private and the mission is also private (or if the note is tagged to a private task). This is handled by the note routing logic checking `task.visibility`.

**Pushover alerts:** Workspace-level Pushover alerts (task assigned/completed) must check `task.visibility !== 'private'` before sending.

### 4.8 Orchestrator / heartbeat

**Decision:** Private tasks must not appear in the orchestrator's context when evaluating a public mission's heartbeat.

**Enforcement in `buildMissionContext()` (`apps/web/src/lib/mission-context.ts`):**

- The active tasks query must add `WHERE visibility = 'workspace'` (or use the admin principal path if the orchestrator is admin-privileged — it currently runs as admin, so it should still see private tasks for private missions but filter them out of public mission context)
- Simpler approach for MVP: orchestrator always uses the `user` principal filter when building context for human-facing missions. Private tasks linked to public missions don't appear in the context.

**Retrigger:** When a heartbeat fires for a private mission, the orchestrator may create new tasks. These inherit `visibility = 'private'` from the mission (see §4.9).

### 4.9 Mission-level privacy (Phase 2)

MVP only supports per-task privacy. A future `missions.visibility` column would:
- Auto-set `visibility = 'private'` on all tasks spawned by a private mission
- Hide the mission itself from the mission list for non-admin users
- Suppress mission feed events (notes, cycle events) from the Pusher `mission-{id}` channel

This is deferred to Phase 2 because the task is the atomic unit and the MVP delivers the key privacy guarantee at the task level. Mission-level privacy is additive.

---

## 5. Cross-cutting concerns

### 5.1 Cost tracking

**Decision:** Private tasks are metered normally. `visibility = 'private'` has no effect on cost attribution.

- Worker `costUsd` / `inputTokens` / `outputTokens` are attributed to the `accounts` row that claimed the task — unchanged
- Team monthly budget (`teams.monthlyCostUsd`) accumulates all spend including private tasks — unchanged
- The billing UI may show private task spend as an aggregate line without task detail (e.g., "System tasks: $X this month") — Phase 2 UI concern

No API or schema change needed for cost tracking.

### 5.2 Worker log / PR URLs

**Worker logs** (error traces, milestones, `instructionHistory`) are stored on the `workers` row and accessed via `GET /api/workers/[id]`. This route must check the linked `tasks.visibility` before returning the full worker detail to non-admin users.

**PR URLs** (`workers.prUrl`) in the GitHub PR body are publicly visible on GitHub. Nothing in Buildd can suppress GitHub PR visibility — this is a Cue-side concern. For true private task execution, Cue should create PRs in private repos or use the `outputRequirement: 'none'` setting.

### 5.3 Search and list API audit summary

Queries that must add `visibilityFilter`:

```
GET /api/tasks                          — task list (API)
GET /api/tasks/[id]                     — task detail (API)
GET /api/missions/[id]                  — linked task summaries
GET /api/workspaces/[id]/last-release   — task reference in release view
/app/tasks page                         — direct DB query
/app/tasks/[id] page                    — direct DB query
/app/home timeline                      — direct DB query
/app/missions/[id] task panel           — direct DB query
buildMissionContext()                   — orchestrator task list
list_tasks MCP tool                     — via /api/tasks (inherits fix)
get_task MCP tool                       — via /api/tasks/[id] (inherits fix)
```

Queries that do NOT need the filter (already scoped or access through task auth):
```
GET /api/workers/[id]                   — worker detail: add task visibility check (see §5.2)
POST /api/workers/claim                 — claim route: private tasks ARE claimable by eligible runners
POST /api/workers/[id]                  — progress/complete: worker already has the task
/api/workers/[id]/artifacts             — artifact CRUD: already scoped to worker
```

### 5.4 Migration and backfill for existing Cue tasks

Existing Cue-created tasks (pre-migration) have no `visibility` column — the default `'workspace'` makes them visible. To retroactively hide them:

1. Identify Cue tasks: `creationSource = 'mcp'` AND created via the Cue OAuth client. The `createdByAccountId` links to the account that holds the Cue OAuth token — this can be resolved via `oauthTokens` / the Cue API key.

2. **Backfill query (run once after migration):**
```sql
UPDATE tasks
SET visibility = 'private', owner_client_id = '<cue-oauth-client-id>'
WHERE creation_source = 'mcp'
  AND created_by_account_id = '<cue-account-id>';
```

The `<cue-oauth-client-id>` is the `clientId` from `oauthClients` for the Cue registration. The `<cue-account-id>` is Cue's API account ID (used to make the request).

3. **No automatic backfill in the migration SQL** — this is a targeted one-time operation requiring the correct IDs, run by an admin after the migration lands.

4. **Share URLs on backfilled tasks:** Existing Cue artifact share URLs should be reviewed. For MVP, they remain valid (the artifact was already created without privacy intent). If stricter privacy is needed, clear `shareToken` on affected artifacts.

---

## 6. MVP Scope

The MVP delivers task-level privacy enforced at the read layer. It does NOT deliver:
- Mission-level privacy (Phase 2)
- Per-app knowledge store namespace (Phase 2)
- Full audit trail of who accessed private tasks (Phase 3)
- Billing UI aggregate for private task spend (Phase 2)

### MVP implementation tasks (ordered)

| # | Task | Files | Size |
|---|------|-------|------|
| 1 | Schema: add `visibility` + `ownerClientId` columns; generate migration | `packages/core/db/schema.ts` + migration | S |
| 2 | Task creation: propagate `oauthClientId` from MCP OAuth context → task | `mcp-oauth/[workspace]/route.ts`, `mcp-tools.ts`, `api/tasks/route.ts` | M |
| 3 | Read enforcement helper (`task-visibility.ts`) + apply to `GET /api/tasks` and `GET /api/tasks/[id]` | `apps/web/src/lib/task-visibility.ts`, two route files | M |
| 4 | UI filter: `/app/tasks` page, `/app/tasks/[id]` page, `/app/home` timeline | Three page files | M |
| 5 | Mission detail: filter linked tasks in mission panel | `apps/web/src/app/app/(protected)/missions/[id]/` | S |
| 6 | Pusher: skip workspace channel events for private tasks | Every `triggerEvent(channels.workspace(...))` caller | M |
| 7 | Share URL: suppress `shareToken` on private task artifacts; gate `/share/[token]` | `api/workers/[id]/artifacts/route.ts`, share route | S |
| 8 | Knowledge store: skip ingestion of private task outcomes | `api/workers/[id]/route.ts` completion handler | S |
| 9 | Mission context / heartbeat: filter private tasks from orchestrator context | `apps/web/src/lib/mission-context.ts` | S |
| 10 | Pushover: skip workspace alerts for private tasks | Pushover send call sites | S |
| 11 | Worker detail: check task visibility before returning to non-admin | `api/workers/[id]/route.ts` GET handler | S |
| 12 | Admin UI toggle: "Show system tasks" in `/app/tasks` for team admins | Task list page + API route param | M |
| 13 | Backfill: one-time SQL to mark existing Cue tasks as private | Ops runbook | S |
| 14 | Tests: smoke test for private task filtering (create private task, verify not in list for user auth, visible for admin auth) | `apps/web/tests/integration/` | M |

**Estimated total:** ~2-3 days of implementation work across 14 tasks.

---

## 7. Non-Goals (Explicitly Out of Scope)

- **Encryption at rest for private task data** — existing database encryption approach is unchanged
- **Per-task ACL (allow specific users to see specific tasks)** — not needed for the Cue use case; admin bypass is sufficient
- **Private tasks in private GitHub repos** — PR visibility is controlled by the repo; out of scope for Buildd
- **Inter-app task delegation** — Cue creating tasks that Anthropic sees but not team members — not needed
- **Audit log of private task access** — Phase 3

---

## 8. Open Questions

1. **Should private tasks be claimable by any runner, or only by runners with the matching `ownerClientId`?** The claim route currently filters by workspace + skills + `runnerPreference`. For MVP, private tasks remain claimable by any eligible runner in the workspace — the privacy is about *visibility*, not about which agent can claim the work. If runner scoping is needed, `tasks.ownerClientId` can be checked in the claim route filter (Phase 2).

2. **Should the `visibility` param be exposed in the public API docs?** Yes — it's a first-class feature. The `create_task` MCP action should document `visibility?: 'private' | 'workspace'` (default `'workspace'`).

3. **What is the Cue client ID string?** The backfill (§5.4) requires knowing the exact `oauthClients.clientId` value for the Cue registration. This must be retrieved from the DB before the backfill is run.

4. **Mission privacy gate condition:** If Cue's missions should also be hidden, is the mission-level `visibility` needed at the same time as task-level, or can task-only privacy suffice for the initial Cue integration? Recommend: start with task-only; evaluate after Cue's first use of the feature.
