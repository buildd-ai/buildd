# Unified App IA + Scoping Model (SPEC)

> **Status: Phase 1 (Roles schema) and Phase 2 (Settings split) shipped. Phase 3-6 substantially complete. Open gaps: §C.5 Role editor scope control, Release Management UI (§D.4 / release-management-ui.md).** This is the gating deliverable for the
> app-wide IA implementation mission. Agents implementing any task from
> §F below MUST read this doc before starting. Do not re-derive from
> first principles.
>
> **Scope:** Dashboard routes, navigation, DB schema for roles, and
> per-surface scoping changes. No new product features — this is structural
> refactoring.
>
> **Sources of truth (read before this doc):**
> - Recon A — App IA, surfaces + team propagation
> - Recon B — Role & Scoping Model
> - Settings IA Refactor — detailed settings task breakdown
>   (`docs/design/settings-ia-refactor.md`, PR #988)
> - Credentials Architecture — canonical credential scoping pattern
>   (`docs/credentials-architecture.md`)
>
> **Decisions already made by Max (do not reopen):**
> 1. **Single team selector** = the global header (`buildd-team` cookie →
>    `resolveActiveTeamId`). No per-page team selectors.
> 2. **Data surfaces**: team-primary everywhere + one shared optional
>    per-workspace filter component on each surface.
> 3. **Roles**: team-level by default with field-level per-workspace
>    overrides. Resolution: workspace override > team default.
> 4. **Role migration**: promote all per-workspace roles to team-level.
>    Detect and report divergent definitions before dropping copies.

---

## A. Scoping Model — The Spine

This section is the canonical reference. Every entity in buildd that can be
scoped to a team and optionally narrowed to a workspace follows the same
pattern. Implementation tasks that touch scoping MUST match this model.

### A.1 The credential model as the template

The `secrets` table already embodies the correct shape
(`packages/core/db/schema.ts:970–992`; full spec in
`docs/credentials-architecture.md`):

| Column | Type | Meaning |
|---|---|---|
| `teamId` | NOT NULL | Owning team — required on every row |
| `accountId` | NULLABLE | NULL = all accounts in the team |
| `workspaceId` | NULLABLE | NULL = all workspaces in the team |

**Write-time scope encoding** (`settings/AgentBackendsSection.tsx:306–313`):

- *This team* → `{ teamId: T, accountId: null, workspaceId: null }`
- *One workspace* → `{ teamId: T, accountId: null, workspaceId: W }`
- *All my teams* → one team-wide row per team the user manages

**Claim-time resolution precedence** (most specific wins):

```sql
SELECT * FROM secrets
WHERE team_id = T
  AND purpose = :purpose
  AND (account_id IS NULL OR account_id = A)
  AND (workspace_id IS NULL OR workspace_id = W)
ORDER BY
  (workspace_id IS NOT NULL) DESC,
  (account_id  IS NOT NULL) DESC
LIMIT 1
```

Result priority: workspace-specific (1) > account-wide (2) > team-wide (3).

### A.2 The general rule

> **Team is the primary boundary (header-selected). Workspace is an optional
> narrower scope. Workspace-specific config overrides the team default at
> runtime.**

Applied uniformly across all entity types:

| Entity | teamId | workspaceId | Status |
|---|---|---|---|
| `secrets` (credentials) | NOT NULL | NULLABLE | ✅ done — the template |
| `missions` | NOT NULL | NULLABLE | ✅ done — team-wide missions already work |
| `workspaceSkills` (roles) | **MISSING** | NOT NULL | ❌ needs schema change (§C) |
| Data views (Home/Activity/Missions/Health) | resolved via cookie | optional filter | ❌ inconsistent today (§B) |

### A.3 UI representation

The scoping model surfaces in two places:

1. **Global header** — single team selector (`TeamSwitcherRail` on desktop,
   `TeamSwitcher` in `MobilePageHeader`). Switching teams reloads all
   server-rendered content. This is the **only** team selector in the app;
   per-page team selectors are removed.

2. **Optional per-workspace filter** — one shared `WorkspaceFilter` client
   component used on every data surface (Home, Activity, Missions, Health).
   Defaults to "all workspaces in team"; user can narrow to one. State lives
   in the URL (`?workspace=<id>`) so it is shareable and back-button safe.

---

## B. Per-Surface IA

### B.1 Scoping target for each surface

All surfaces adopt: **team-primary + optional per-workspace filter**. The
`WorkspaceFilter` component (§E.2) is added to each surface's header area.
Switching teams (header selector) clears the workspace filter and reloads.

| Surface | Route | Current scoping | Target scoping | Fetch delta |
|---|---|---|---|---|
| **Home** | `/app/home` | Mixed (workers/tasks/schedules by workspaceIds; missions by teamIds) | Team-primary | Change workers/tasks/schedules/roles queries to `teamId`; add WS filter to narrow |

> **Hibernating missions**: Missions with no task activity in the past N days display in a visually muted state (`mission-card-hibernating`). They appear in their health group but with reduced visual weight. This state is not triggered by a mission field — it is derived client-side from task activity recency. The spec does not prescribe a specific N threshold; the current implementation uses the activity window.
| **Activity** | `/app/tasks` | All team workspaces, no filter | Team-primary + WS filter | Add WorkspaceFilter; pass `workspaceId` param to TaskGrid |
| **Missions** | `/app/missions` | Team-scoped ✅ (reference implementation) | Team-primary + WS filter (add filter for drill-down) | Add WorkspaceFilter; filter missions by workspaceId when set |
| **Health** | `/app/health` | Watched projects by workspaceIds; WS filter exists ✅ (Vercel status removed from UI — backend retained) | Team-primary; WS filter already promoted to canonical shared component ✅ | Done: Runners + Usage (30d) + Schedules added; Vercel status stripped (#1066) |

#### Home — fetch changes

Today `home/page.tsx` queries workers/tasks/schedules/roles against
`workspaceIds = getUserWorkspaceIds(userId)` (all the user's workspaces,
across all teams). After this change:

```ts
const teamId = await resolveActiveTeamId(cookieStore, userId);
// All queries filter by teamId directly or via workspaceIds scoped to teamId
const workspaceIds = await getTeamWorkspaceIds(teamId);
// WorkspaceFilter value (from URL param) narrows to one workspaceId
```

Acceptance criteria:
- AC-1: Home renders data for the active team's workspaces only; switching
  teams reloads all sections.
- AC-2: WorkspaceFilter at top of page; null selection = all team workspaces.
- AC-3: GIVEN team with 3 workspaces, WHEN workspace W is selected, THEN
  only W's workers/tasks/schedules appear; missions are filtered to those
  anchored to W.

#### Activity — fetch changes

`tasks/page.tsx` feeds `TaskGrid` with `workspaceIds`. After:

```ts
const workspaceIds = wsFilter ? [wsFilter] : await getTeamWorkspaceIds(teamId);
```

Acceptance criteria:
- AC-1: Activity shows all team tasks by default (up to 200, 30d window).
- AC-2: WorkspaceFilter narrows to one workspace's tasks; URL param
  `?workspace=<id>` preserved across browser navigation.

#### Missions — fetch changes

Missions is already team-scoped (`missions.teamId`). The WorkspaceFilter
adds drill-down:

```ts
const where = wsFilter
  ? and(eq(missions.teamId, teamId), eq(missions.workspaceId, wsFilter))
  : eq(missions.teamId, teamId);
```

Acceptance criteria:
- AC-1: Missions default view unchanged (all team missions).
- AC-2: WorkspaceFilter shows missions anchored to one workspace; team-level
  missions (workspaceId IS NULL) shown regardless of workspace filter (they
  belong to the team, not any one workspace).

#### Health — fetch changes

Health already has a workspace filter; it becomes the canonical instance from
which `WorkspaceFilter` is extracted. Two additions from §B.2 below:

- Runners list moved here from `/app/settings`
- Usage (30d) card added here

**Current state (shipped in v0.126.0):** Health renders four sections —
Runners, Usage (30d), Schedules, and Watched Projects. The Vercel
config/status UI was removed (#1066); backend columns and health-watcher
prod-check code are retained so the feature can be re-enabled via UI later.

**Mobile / desktop parity rule:** Health page sections MUST be identical
across all viewports. Desktop (sidebar rail) and mobile (bottom tab nav)
both route to the same `HealthClient` component — there is no separate
mobile path. No section may be conditionally rendered for a specific
breakpoint. Treat any viewport-only section as a regression equal to the
artifact→task action mobile regression.

Acceptance criteria:
- AC-1: Health shows watched projects for all team workspaces by default.
- AC-2: WorkspaceFilter (shared component) narrows watched projects.
- AC-3: Runners list visible on Health; Usage (30d) visible on Health.
- AC-4: All four sections (Runners, Usage, Schedules, Watched Projects) render
  identically on desktop and mobile; no Vercel section appears on either
  viewport. Data-testid anchors (`health-section-runners`,
  `health-section-usage`, `health-section-schedules`,
  `health-section-watched-projects`) must be present on each `<section>`
  element for E2E verification.

### B.2 Settings 3-surface split

The full detailed breakdown is in `docs/design/settings-ia-refactor.md`
(PR #988). This section states the target IA and cross-references; do not
re-derive the task details from this doc.

| Surface | Route | Holds |
|---|---|---|
| **Account** | `/app/you` | Profile, sign-out, teams list, mobile team switcher (md:hidden, >1 team) |
| **Connections** | `/app/settings` | Agent Backends, Runner Tokens (rename from API Keys), GitHub, Vercel |
| **Notifications** | `/app/settings/notifications` | Pushover/webhook channels, per-event toggles |

**Header-selector correction:** The in-page `TeamSwitcher` at
`settings/page.tsx:220–226` is removed when `/app/settings` becomes
Connections (it is not an Account page). The mobile TeamSwitcher moves to
`/app/you` (AC-3 of #988 §2.1). The global header remains the sole team
switcher for Connections.

**Telemetry relocation:** Runners list and Usage (30d) move from
`/app/settings` to `/app/health`. See #988 §3.1 for the `getRunnerHeartbeats`
extraction detail.

**Connect Claude relocation:** `ConnectClaudeSection` moves to
`/app/workspaces/[id]/config`. See #988 §3.2.

**Dead code:** `DiscordSection.tsx`, `SlackSection.tsx`,
`HeartbeatSection.tsx`, `SkillsSection.tsx` (verified no importers in
recon). Delete in §F Task K.

---

## C. Roles — Team-Level + Field-Level Workspace Overrides

### C.1 Schema changes

Current `workspaceSkills` schema (relevant columns,
`packages/core/db/schema.ts:881–919`):

```ts
workspaceId: uuid('workspace_id').references(...).notNull()  // required today
// teamId: MISSING
// Unique index: UNIQUE(workspaceId, slug)
```

Required changes — mirror the `secrets` scoping model exactly:

**1. Add `teamId` (NOT NULL after backfill):**
```ts
teamId: uuid('team_id')
  .references(() => teams.id, { onDelete: 'cascade' })
  .notNull()
```

**2. Make `workspaceId` nullable:**
```ts
workspaceId: uuid('workspace_id')
  .references(() => workspaces.id, { onDelete: 'cascade' })
  // Remove .notNull()
```
NULL = team-level role (no workspace anchor). Non-null = workspace-specific
override row.

**3. Replace the existing unique index with two partial unique indexes:**
```sql
-- Team-level default: one (team, slug) when no workspace override
CREATE UNIQUE INDEX ws_skills_team_slug_idx
  ON workspace_skills (team_id, slug)
  WHERE workspace_id IS NULL;

-- Workspace override: one (workspace, slug)
CREATE UNIQUE INDEX ws_skills_workspace_slug_idx
  ON workspace_skills (workspace_id, slug)
  WHERE workspace_id IS NOT NULL;
```

This is the same pattern as `secrets` — partial indexes handle the NULL
case correctly where a standard UNIQUE constraint on a nullable column
would not.

**4. Override row semantics:** A workspace override carries the full set of
overridden fields. The resolver picks the workspace row if one exists;
otherwise falls back to the team-level row. Field-level merging (override
only `allowedTools`, inherit `content`) can be added in a future iteration
via a `workspace_role_overrides` table — out of scope here. Start with
full-row workspace overrides.

### C.2 Resolution query (claim-time)

Replaces the current two-step workspace → account lookup in
`claim/route.ts:924–944`:

```sql
SELECT * FROM workspace_skills
WHERE team_id = :teamId
  AND slug = :roleSlug
  AND is_role = true
  AND enabled = true
  AND (workspace_id IS NULL OR workspace_id = :workspaceId)
ORDER BY (workspace_id IS NOT NULL) DESC   -- workspace override wins
LIMIT 1
```

Precedence: workspace override (`workspaceId = W`) > team default
(`workspaceId IS NULL`). This exactly mirrors the credential resolver.

> **Unassigned tasks** (`tasks.roleSlug IS NULL`): The role resolution query is not invoked for tasks without a roleSlug. These tasks are not claimed by role-filtered workers. Role-centric views (Team page, role pills on Home) should show an "Unassigned" count separately. Approximately 54% of tasks in production have no roleSlug — this is a known usage pattern, not an error.

### C.3 Runtime materialization impact

The claim response already carries `roleConfig: { configHash, configUrl,
allowedTools, ... }`. No change to the runner's `syncRoleToLocal` or
`overlayRoleFiles` — the runner receives whichever bundle URL was resolved
at claim time:

- **Team-level role:** one R2 bundle at `roles/<slug>/<hash>.json` shared
  across all workspaces.
- **Workspace override:** its own bundle, scoped to the workspace (e.g.
  `roles/<slug>/<wsId>/<hash>.json`).

The `configStorageKey` column value distinguishes them at bundle cache time.
No change to `apps/runner/src/roles.ts` needed.

`allowedTools` and `canDelegateTo` are applied from whichever DB row the
resolver returns — they are never merged between team and workspace rows.
The workspace override row carries all fields it specifies; anything not in
the override inherits from the team default only at claim time (the resolved
row is the complete config).

### C.4 Migration plan

Execute in this order:

**Step 1 — Add `teamId` column (nullable first):**
```sql
ALTER TABLE workspace_skills ADD COLUMN team_id uuid
  REFERENCES teams(id) ON DELETE CASCADE;
```

**Step 2 — Backfill from workspace's team:**
```sql
UPDATE workspace_skills ws
   SET team_id = w.team_id
  FROM workspaces w
 WHERE w.id = ws.workspace_id;
```

**Step 3 — Make `teamId` NOT NULL:**
```sql
ALTER TABLE workspace_skills ALTER COLUMN team_id SET NOT NULL;
```

**Step 4 — Divergence detection (run before any dedup, report to Max):**

For each `(teamId, slug)` group, compare the hash of
`(content, model, allowedTools, mcpServers)` across all workspace rows.

```sql
SELECT team_id, slug,
       COUNT(DISTINCT md5(content || model || allowedTools::text || mcpServers::text))
         AS distinct_configs,
       array_agg(workspace_id) AS workspace_ids
  FROM workspace_skills
 WHERE is_role = true
 GROUP BY team_id, slug
HAVING COUNT(DISTINCT md5(content || model || allowedTools::text || mcpServers::text)) > 1;
```

Any row in this result set is a **conflict**: the same slug has diverged
across workspaces in the team. **Do not silently discard these.** Output the
report and surface it for Max to resolve before Step 5. Conflicting slugs
become workspace overrides (the per-workspace rows are kept as-is and become
workspace-scoped overrides automatically).

**Step 5 — Dedup convergent rows:**

For each `(teamId, slug)` group where all workspace rows are identical
(same content/model/allowedTools/mcpServers):

1. Delete all per-workspace rows.
2. Insert one team-level row (`workspaceId = NULL, teamId = T`).

Conflicting groups from Step 4 are left as-is (per-workspace rows stay,
become workspace overrides automatically once the schema change lands).

**Step 6 — Drop old unique index; add partial indexes (Step 1 of C.1):**
```sql
DROP INDEX workspace_skills_workspace_slug_idx;
-- Then create the two partial indexes from C.1
```

**What breaks and the fixes:**

| What breaks | Fix |
|---|---|
| `seedDefaultRoles(workspaceId)` called at workspace creation | Change to `seedDefaultRolesForTeam(teamId)` called at **team** creation. Existing per-workspace rows are covered by migration. |
| `UNIQUE(workspaceId, slug)` | Replaced by two partial indexes (Step 6) |
| Team page query `WHERE workspaceId IN (wsIds)` (`team/page.tsx:75–88`) | Add OR clause: `OR (workspaceId IS NULL AND teamId IN (teamIds))` |
| `GET /api/roles` (`api/roles/route.ts:44–56`) | Same expansion — return team-level rows too |
| Claim route role floor fetch (`claim/route.ts:411–434`) | Add `OR (workspaceId IS NULL AND teamId = T)` fallback; replace two-step lookup with the single precedence query from §C.2 |
| `onConflictDoNothing` in seed | Conflict target changes from `(workspaceId, slug)` to `(teamId, slug) WHERE workspaceId IS NULL` |

### C.5 UI — 'Applies to' scope control

The role editor on the Team page gains an **'Applies to'** scope selector,
consistent with the credential UI in `AgentBackendsSection.tsx`:

- *All workspaces in team* → saves `{ teamId: T, workspaceId: null }`
- *One workspace* → saves `{ teamId: T, workspaceId: W }` (workspace
  override row)

Team page role list (`team/page.tsx`) displays:
- Team-level roles: labeled "All workspaces"
- Workspace override rows: labeled with workspace name, shown as a
  sub-item or badge ("2 workspace overrides") with expand to view/edit each

---

## D. Navigation Restructure

### D.1 Current state (problems)

From Recon A §4:

- 5-tab nav exposes 6 routes; 15+ routes exist in the app.
- `/app/health` — functional page, zero nav entry points.
- `/app/you` — redirect stub, not a real tab.
- `/app/workspaces/[id]/*` — 7 sub-pages entirely invisible from nav.
- `/app/artifacts` — in desktop sidebar but mis-bucketed under Settings
  in mobile bottom nav (`MissionsBottomNav.tsx:72–82`).
- Mobile bottom nav active-state lines 72–82 incorrectly map `/app/you`,
  `/app/artifacts`, `/app/teams`, `/app/accounts` to the Settings tab.

### D.2 Target nav

#### Desktop sidebar (`MissionsSidebar.tsx`)

Primary items (top):
1. **Home** → `/app/home`
2. **Missions** → `/app/missions`
3. **Activity** → `/app/tasks`
4. **Team** → `/app/team`
5. **Health** → `/app/health` ← **ADD**

Bottom items:
6. **Connections** → `/app/settings` (rename from "Settings")
7. **`UserAvatarMenu`** → dropdown: *Account* (`/app/you`) + *Sign out*

**Artifacts** moves out of the primary sidebar. It is reachable via
workspace context (`/app/workspaces/[id]/artifacts`) and linked from task
detail pages. Not a primary nav item — demote.

#### Mobile bottom nav (`MissionsBottomNav.tsx`)

5 slots:
| # | Label | Route |
|---|---|---|
| 1 | Home | `/app/home` |
| 2 | Missions | `/app/missions` |
| 3 | Activity | `/app/tasks` |
| 4 | Team | `/app/team` |
| 5 | Health | `/app/health` ← **REPLACE** Settings |

Account (`/app/you`) and Connections (`/app/settings`) are accessed via
a mobile avatar/menu affordance (top-right in `MobilePageHeader`, not a
bottom tab). `MobilePageHeader` should show an avatar icon linking to
`/app/you` alongside the team switcher.

#### Workspace sub-pages

`/app/workspaces/[id]/*` (7 tabs: Missions, Artifacts, Schedules, Skills,
Runners, Memory, Configure) remain reachable via:
- `/app/workspaces` list → click workspace card
- Team page → workspace name link
- Contextual links from Mission detail, task detail (existing)

No primary nav entry for the workspace tree — workspace config is
intentionally a second-level navigation concern, not a first-class tab.

### D.3 Atomic active-state fix (`MissionsBottomNav.tsx:72–82`)

The mobile bottom nav must be updated atomically when the nav restructure
ships. Replace the hard-coded path buckets with explicit mapping:

```ts
const ACTIVE_MAP: Record<string, number> = {
  '/app/home':      0,
  '/app/missions':  1,
  '/app/tasks':     2,
  '/app/team':      3,
  '/app/health':    4,
};

function getActiveTab(pathname: string): number {
  for (const [prefix, idx] of Object.entries(ACTIVE_MAP)) {
    if (pathname.startsWith(prefix)) return idx;
  }
  return -1; // no tab active (settings, you, workspace sub-pages)
}
```

Routes `/app/you`, `/app/settings`, `/app/workspaces/*`, `/app/artifacts`
are no longer attributed to any bottom tab (they are accessed via menu,
not bottom nav).

### D.4 Still-absent surfaces (deferred)

These gaps were identified in Recon A §3 and the prior UI audit. They are
out of scope for this refactor but noted here so the next planning cycle
can place them:

| Surface | Current state | Recommended placement |
|---|---|---|
| **Release management** | MCP/API only; no dashboard UI shipped yet. Design spec exists at `docs/design/release-management-ui.md` (proposed, pending approval). | `/app/workspaces/[id]/releases` (workspace tab) or a Health section; not a primary nav item |
| **Cost/usage (first-class)** | Only in Settings scroll (30d aggregate) | `/app/health` (basic aggregate); per-task token data in task detail; no dedicated surface this cycle |
| **In-app PR review** | Links to GitHub only | Defer; `/app/tasks/[id]` PR section is sufficient for now |

---

## E. Cross-cutting Concerns

### E.1 Team resolution everywhere

`resolveActiveTeamId()` (`lib/team-access.ts:186–206`) is already the
correct mechanism. Every server component that needs the active team MUST
call it independently — do NOT thread the resolved teamId through a shared
layout context. Next.js server component context is not a reliable
pass-down for cookie-dependent values across page boundaries (confirmed in
#988 §5.2).

Pattern for all data surfaces:
```ts
// In every page's server component
const cookieStore = await cookies();
const teamId = await resolveActiveTeamId(cookieStore, userId);
const workspaceFilter = searchParams.workspace ?? null;
const workspaceIds = workspaceFilter
  ? [workspaceFilter]
  : await getTeamWorkspaceIds(teamId);
```

### E.2 Shared `WorkspaceFilter` component

Extract from `/app/health` (which already has a workspace filter dropdown).
New shared location: `apps/web/src/components/WorkspaceFilter.tsx`.

Interface:
```ts
interface WorkspaceFilterProps {
  workspaces: { id: string; name: string }[];
  selectedId: string | null;      // null = all workspaces
}
```

State model: URL query param `?workspace=<id>`. The component reads and
writes `router.replace` with the updated param. This makes the selection
shareable and back-button safe. Server components pass `searchParams.workspace`
into their queries; no client-state-to-server bridging needed.

The workspace list is always fetched server-side (from the page's server
component) and passed as props — the component itself is `'use client'`
only for the dropdown interaction.

Acceptance criteria:
- AC-1: Null selection (default) → all workspaces shown; no `?workspace`
  param in URL.
- AC-2: Selecting workspace W → `?workspace=W` in URL; page re-renders
  with W-scoped data.
- AC-3: Switching teams (header selector, page reload) → `?workspace` param
  cleared.

### E.3 Client vs. server fetch implications

| Data type | Fetch strategy | Why |
|---|---|---|
| Missions, workers, tasks (team-primary) | Server component | Scoped by `buildd-team` cookie; re-validates on team switch (page reload) |
| Workspace list (for WS filter) | Server component → props | Changes infrequently; no need for client fetch |
| WS filter state | URL param | Shareable, back-button safe |
| AgentBackends, GitHub, Vercel (credentials) | `'use client'` with own fetch | Already `'use client'`; can be lifted directly — no structural change |
| Runners / Usage telemetry | Server component (after move to Health) | `getRunnerHeartbeats()` helper; see #988 §3.1 |

Avoid adding `'use client'` wrappers to server components to thread filter
state. Prefer URL params + server re-render over client state + client
re-fetch for filtered views.

### E.4 Account-model hygiene

Carried from #988 §5.4 and Recon B credential analysis:

1. `POST /api/accounts` (`accounts/route.ts`) — remove `oauthToken` write
   to `accounts.oauthToken` column (deprecated; credentials are in
   `secrets`).
2. `PATCH /api/accounts/[id]` — remove `oauthToken` update code path.
3. `/app/accounts/new` form — remove the OAuth field.

Future migration (out of scope here): drop `accounts.anthropicApiKey` and
`accounts.oauthToken` columns after writes are removed.

---

## F. Implementation Breakdown

Sequenced by dependency. Tasks in the same phase can run in parallel.
Each task references the acceptance criteria section where full detail
lives — do not duplicate here.

The settings surface tasks (A–F below) supersede and replace the standalone
task list in `docs/design/settings-ia-refactor.md §6`. This is now the
top-level plan; #988 §6 is the per-task detail source for those tasks.

### Phase 1 — Foundation (no inter-task dependencies)

#### Task A — Roles schema + migration

**Scope:** `packages/core/db/schema.ts`, migration files, `lib/default-roles.ts`,
`app/api/roles/route.ts`, `app/api/workers/claim/route.ts`, `app/app/(protected)/team/page.tsx`

**Changes:**
1. Add `teamId NOT NULL` to `workspaceSkills` with backfill migration
2. Make `workspaceId` nullable
3. Replace `UNIQUE(workspaceId, slug)` with two partial unique indexes
4. Run divergence detector; produce report for Max
5. Dedup convergent rows into team-level rows
6. Update claim route to use §C.2 precedence query
7. Change `seedDefaultRoles(workspaceId)` → `seedDefaultRolesForTeam(teamId)` (call at team creation)
8. Update Team page query and `GET /api/roles` to return team-level rows

**Dependencies:** none (but divergence report must be reviewed by Max before dedup step)

**Acceptance criteria:** §C.1–C.4

**Verification:**
```bash
bun db:generate && bun test
# Claim a task with roleSlug; confirm team-level role resolves
```

---

#### Task B — Extract `WorkspaceFilter` shared component

**Scope:** `apps/web/src/components/WorkspaceFilter.tsx` (new),
`app/app/(protected)/health/page.tsx` (refactor existing filter)

**Changes:**
1. Extract workspace filter dropdown from health page into shared component
2. Implement URL-param state model (`?workspace=<id>`)
3. Update health page to use the shared component

**Dependencies:** none

**Acceptance criteria:** §E.2

**Verification:**
```bash
bun test apps/web/src/app/app/(protected)/health/
# Navigate to /app/health; workspace filter changes URL param
```

---

### Phase 2 — Settings split (parallel, no deps on Phase 1)

These tasks are detailed in `docs/design/settings-ia-refactor.md §6`.
Read that doc for full acceptance criteria and file-level instructions.

#### Task C — Make `/app/you` a real Account page

**Scope:** `app/app/(protected)/you/page.tsx`

**Details:** #988 Task 1 — profile, sign-out, teams list, mobile TeamSwitcher
(`md:hidden`, >1 team). This removes the in-page TeamSwitcher from
`settings/page.tsx:220–226` by moving it here.

**Dependencies:** none

**Acceptance criteria:** #988 §2.1

**Verification:**
```bash
bun test
# Navigate to /app/you — must not redirect; mobile switcher absent for single-team
```

---

#### Task D — Rebuild `/app/settings` as Connections

**Scope:** `app/app/(protected)/settings/page.tsx`, `AgentBackendsSection.tsx`

**Details:** #988 Task 2 — strip Runners/Usage/Workspaces/Browse/ConnectClaude;
rename API Keys → Runner Tokens; remove OAuth buttons; ensure Notifications
accessible via tab/route. Remove in-page `TeamSwitcher` at line 220–226
(it is now in `/app/you` per Task C).

**Dependencies:** none (can run parallel with Task C)

**Acceptance criteria:** #988 §2.2

**Verification:**
```bash
bun test
# /app/settings renders only Agent Backends, Runner Tokens, GitHub, Vercel
```

---

### Phase 3 — Data surface scoping (depends on Phase 1 Task B)

#### Task E — Apply team-primary + WS filter to Home

**Scope:** `app/app/(protected)/home/page.tsx`

**Changes:**
1. Change workers/tasks/schedules/roles queries from `workspaceIds` to `teamId`-scoped
2. Add `WorkspaceFilter` component to page header
3. Pass `?workspace` param through to all queries

**Dependencies:** Task B (WorkspaceFilter component)

**Acceptance criteria:** §B.1 Home

**Verification:**
```bash
bun test apps/web/src/app/app/(protected)/home/
# Two-workspace team: /app/home shows both; ?workspace= shows one
```

---

#### Task F — Apply team-primary + WS filter to Activity

**Scope:** `app/app/(protected)/tasks/page.tsx`, `components/TaskGrid.tsx`

**Changes:**
1. Add `WorkspaceFilter` to page header
2. Pass `workspaceId` param into `TaskGrid` query

**Dependencies:** Task B

**Acceptance criteria:** §B.1 Activity

**Verification:**
```bash
bun test apps/web/src/app/app/(protected)/tasks/
```

---

#### Task G — Add optional WS filter to Missions

**Scope:** `app/app/(protected)/missions/page.tsx`

**Changes:**
1. Add `WorkspaceFilter` component (missions already team-scoped; this adds drill-down)
2. Apply workspace filter to mission query (team-level missions always shown)

**Dependencies:** Task B

**Acceptance criteria:** §B.1 Missions

**Verification:**
```bash
bun test apps/web/src/app/app/(protected)/missions/
```

---

### Phase 4 — Settings relocation (depends on Phase 2)

#### Task H — Relocate telemetry to `/app/health`

**Scope:** `lib/runner-helpers.ts` (new helper), `app/app/(protected)/health/page.tsx`,
`app/app/(protected)/settings/page.tsx`

**Details:** #988 Task 3 — extract `getRunnerHeartbeats`; add Runners + Usage card
to health; remove from settings.

**Dependencies:** Task D (#988 Task 2 must ship first to avoid file conflict)

**Acceptance criteria:** #988 §3.1

**Verification:**
```bash
# /app/health shows Runners + Usage; /app/settings does not
```

---

#### Task I — Move Connect Claude to workspace config

**Scope:** `app/app/(protected)/workspaces/[id]/config/page.tsx`,
`app/app/(protected)/settings/page.tsx`

**Details:** #988 Task 4

**Dependencies:** Task D (parallel with Task H if settings file conflict avoided)

**Acceptance criteria:** #988 §3.2

---

#### Task J — Account-model hygiene

**Scope:** `app/api/accounts/route.ts`, `app/api/accounts/[id]/route.ts`,
`app/app/(protected)/accounts/new/page.tsx`

**Details:** #988 Task 6 — remove oauthToken writes; remove OAuth form field.

**Dependencies:** Task D

**Acceptance criteria:** #988 §5.4 / §E.4

---

### Phase 5 — Nav restructure (depends on Phase 2)

#### Task K — Nav restructure + active-state + dead code

**Scope:** `components/MissionsSidebar.tsx`, `components/MissionsBottomNav.tsx`,
`components/UserAvatarMenu.tsx`, `components/MobilePageHeader.tsx`,
and dead files from #988 §4

**Changes:**
1. Add Health (`/app/health`) to desktop sidebar primary items
2. Rename "Settings" → "Connections" in sidebar
3. Replace mobile bottom nav slot 5 (Settings → Health); move
   Connections + Account to avatar/menu affordance
4. Add mobile avatar icon to `MobilePageHeader` linking to `/app/you`
5. Update `UserAvatarMenu` to offer *Account* (`/app/you`) in dropdown
6. Rewrite `MissionsBottomNav.tsx:72–82` active-state logic (§D.3)
7. Delete `DiscordSection.tsx`, `SlackSection.tsx`, `HeartbeatSection.tsx`,
   `SkillsSection.tsx` (verify no importers first with grep from #988 §4)

**Dependencies:** Task C (`/app/you` must be a real page), Task D (`/app/settings`
as Connections must exist). Also logically depends on Task H so Health page
has content when nav links to it.

**Acceptance criteria:** §D.2, §D.3, #988 §5.1

**Verification:**
```bash
bun test
grep -r "DiscordSection\|SlackSection\|HeartbeatSection\|SkillsSection" apps/web/src
# Returns zero results
# Navigate: /app/health visible in nav; /app/you works; bottom nav active-state correct
```

---

### Phase 6 — Roles UI (depends on Phase 1 Task A)

#### Task L — Role editor scope control + override editor

**Scope:** `app/app/(protected)/team/page.tsx`, role editor component(s)

**Changes:**
1. Add 'Applies to' dropdown to role editor (All workspaces / One workspace)
2. Team page role list: show team-level roles labeled "All workspaces";
   show workspace overrides as sub-items or badge ("N workspace overrides")
3. Override editor: create/edit workspace-scoped override row for an existing
   team-level role

**Dependencies:** Task A (team-level roles must exist in DB)

**Acceptance criteria:** §C.5

**Verification:**
```bash
bun test apps/web/src/app/app/(protected)/team/
# Create team-level role; create workspace override; claim route resolves override for that workspace
```

---

### Dependency graph summary

```
Phase 1 (no deps):
  A (Roles schema)  →  L (Roles UI)
  B (WorkspaceFilter)  →  E (Home)  F (Activity)  G (Missions)

Phase 2 (no deps, parallel with Phase 1):
  C (/app/you)  ─┐
  D (Connections) ─┤→  K (Nav restructure)
                  ├→  H (Telemetry → Health)
                  ├→  I (Connect Claude → WS config)
                  └→  J (Account hygiene)
```

The two phases are fully independent — Roles schema work (Phase 1) does
not block or conflict with Settings split work (Phase 2). Both can proceed
in parallel. The nav restructure (Phase 5 Task K) is the last gated item,
requiring both `/app/you` (Task C) and `/app/settings` as Connections
(Task D) to exist.

---

## G. References

| Doc | Purpose |
|---|---|
| `docs/design/settings-ia-refactor.md` | Per-task detail for Settings 3-surface split (Tasks C, D, H, I, J, K from §F) |
| `docs/credentials-architecture.md` | Canonical credential scoping pattern (template for role scoping in §C) |
| `docs/design/mobile-feed-spec.md` | Mobile feed spec (adjacent context) |
| Recon A artifact `370a87d1` | Current state of all surfaces + nav inventory |
| Recon B artifact `a3399045` | Current role model + generalization analysis |
| PR #988 | Settings IA refactor PR; merged spec and task list for that sub-area |
