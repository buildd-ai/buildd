# Release Management UI — Design Spec

> **Status:** Proposed — awaiting Max approval before implementation.
> **Fills the gap flagged in:** `docs/design/unified-app-ia.md §D.4`
> (Release management: "MCP/API only; no dashboard; recommended: workspace tab").
> **Prereq reading:** `docs/design/release-handoff-workflow.md` (release code audit +
> credential/strategy migration spec). This doc layers the `trigger` policy + UI
> on top of that foundation; do not re-derive release architecture from first principles.

---

## 1. Current State (Evidence)

### 1.1 Where `releaseConfig` is stored and set

`WorkspaceReleaseConfig` is a JSONB blob on the `workspaces` table
(`packages/core/db/schema.ts:266–314, 452`):

```ts
export interface WorkspaceReleaseConfig {
  enabled: boolean;
  strategy?: ReleaseStrategy;   // 'workflow_dispatch' | 'branch_merge' | 'script'
  workflowFile?: string;        // workflow_dispatch
  ref?: string;                 // workflow_dispatch / script
  inputs?: Record<string, string>;
  prodBranch?: string;          // branch_merge
  deployTarget?: { type: 'vercel'; projectId?: string; teamId?: string };
  postDeployHooks?: Array<...>;
  verificationUrl?: string;
  command?: string;             // script (unimplemented)
}
```

Per-task override (`schema.ts:559`):
```ts
release: text('release').default('inherit').$type<'true' | 'false' | 'inherit'>()
```

**No `trigger` field exists today.**

Set/read paths today: `manage_workspaces update releaseConfig` (MCP), `trigger_release`
(MCP), `release_status` (MCP). **There is no UI for any of this.**

### 1.2 The double-fire problem

Two independent paths can both run a release for the same workspace event.

**Path A — completion-side (`executeRelease`)**
`apps/web/src/app/api/workers/[id]/route.ts:653–673` — fires on `PATCH /api/workers/[id]`
when a worker reports `status: 'completed'`. Calls `executeRelease()` in
`apps/web/src/lib/release-executor.ts:171–335`. Handles **`branch_merge` only**:
merges the worker's branch into `prodBranch` via the GitHub API, then polls Vercel for
up to 5 minutes.

**Path B — webhook-side (`pull_request.closed`)**
`apps/web/src/app/api/github/webhook/route.ts:374–401` — fires when a buildd worker's
PR merges. Dispatches `release.yml` (hardcoded filename; ignores `resolveReleaseStrategy`)
for any workspace with `releaseConfig.enabled === true`, using
`workspace.gitConfig.defaultBranch ?? 'dev'` as `ref`. Fire-and-forget: no `runId` persisted.

**Conflict:** a `branch_merge` workspace with `enabled: true` currently fires Path A
(merge + Vercel poll) AND Path B (dispatch `release.yml`). One merge event → two releases.
This is the primary noise source. See `release-handoff-workflow.md §2` for the full
diagnosis and the strategy-migration fix. The `trigger` policy built here makes the cadence
contractual, which is a prerequisite to safe single-path enforcement.

### 1.3 How success/failure surfaces today

- `executeRelease` (Path A): writes `tasks.releaseResult` with `status: 'completed' | 'failed'`.
  On failure, the summary line `"Release: FAILED — …"` appears in `task.result.releaseSummary`.
  **Known bug:** a failed release marks the originating task as failed (release-coupling). The
  `release-handoff-workflow.md §4` readback spec (single path via `workflow_run` webhook) partially
  addresses this by making the release outcome async and non-blocking on the task.
- Path B: fire-and-forget — no status read-back at all today.
- `release_status` MCP action: available to agents; returns preflight info (commits ahead, CI
  state, open release PR). Not surfaced in the dashboard.
- No last-release status, no recent-releases list, no Vercel deploy link in the UI.

---

## 2. Scoping Model (reuse unified IA)

`docs/design/unified-app-ia.md §A` is the canonical scoping model. Release management
follows it exactly:

| Layer | Scoping | Source |
|---|---|---|
| **Release config** (strategy / branches / trigger / deployTarget) | **Workspace-scoped** — one config per workspace, no team-level default | `workspaces.releaseConfig` JSONB |
| **Vercel token** | **Team-scoped** — held in `secrets` table (purpose `vercel_token`); shared across all workspaces in the team | existing `AgentBackendsSection` pattern |
| **Per-task skip** | **Task-scoped** — `tasks.release` enum `'true' | 'false' | 'inherit'` | existing |

The global header selects the active team (as in unified IA §A.3). The Release surface
is a **section on the workspace config page** (`/app/workspaces/[id]/config`), so the
workspace is already selected by route context — no additional workspace selector needed.

Vercel token status is **read-only** on this surface (configured / missing) with a link to
`/app/settings` (Connections) where it is managed — exactly as the task description requests
and consistent with how credential status is displayed elsewhere (e.g., GitHub App status on
the workspace config page).

---

## 3. The `trigger` Policy Enum

### 3.1 Definition

Add `releaseConfig.trigger` to `WorkspaceReleaseConfig`:

```ts
export type ReleaseTrigger =
  | 'every_merge'         // current behavior — release fires per merged task (default)
  | 'on_mission_complete' // batch — release fires once when a mission goes all-terminal
  | 'manual'              // owner fires trigger_release; nothing auto-fires
  | 'scheduled';          // PHASE 2 — nightly / periodic cron (shape below)
```

**Back-compat default:** absent `trigger` ⇒ `'every_merge'`. Existing workspaces that
have not set a `trigger` keep today's behaviour exactly. This is a pure JSONB addition —
no DB migration.

**buildd's own recommended default for new workspaces:** `on_mission_complete`.
Rationale: typical work arrives in mission-shaped batches; releasing per task is noisy
and risks shipping half a feature. A workspace calling `manage_workspaces create` should
default to `on_mission_complete` unless it opts out.

### 3.2 Mode semantics

#### `every_merge` (current behavior, preserved)

A release fires each time a worker task completes (and the task is not `skipRelease`).
Path A runs for `branch_merge` workspaces; Path B for `workflow_dispatch`. After
the single-path fix (§4), exactly one path fires per merge event — the mechanism is
determined by `strategy`, the cadence by `trigger: 'every_merge'`.

**Cadence:** one release per completed non-skipped task.
**Use case:** repos that release on every merge; or urgent hotfix workspaces.

#### `on_mission_complete` (new — recommended)

A release fires exactly once after a mission reaches the **all-tasks-terminal** state
(all tasks `completed | failed`, none `pending | in_progress`). Individual task
completions do not trigger a release.

**Mission-complete detection:**

After every task status transition, the worker PATCH route already derives mission
health via `deriveMissionHealth` (`packages/core/mission-helpers.ts`). Augment the
post-completion hook (same location as the existing `executeRelease` call,
`workers/[id]/route.ts:653–673`) to check:

```ts
if (trigger === 'on_mission_complete' && task.missionId) {
  const pending = await countPendingTasksForMission(task.missionId);
  if (pending === 0) {
    await fireMissionRelease(workspaceId, task.missionId);
  }
}
```

**Dedup (exactly one release per mission):**

Use an atomic optimistic-lock pattern (consistent with `db.transaction()` prohibition):

```ts
// Atomic claim — only the worker whose update sets released_at wins
const claimed = await db
  .update(missions)
  .set({ releasedAt: new Date() })
  .where(
    and(
      eq(missions.id, task.missionId),
      isNull(missions.releasedAt),   // unclaimed
    )
  )
  .returning({ id: missions.id });

if (claimed.length === 0) return; // another task beat us — skip
await executeRelease({ ... });
```

Add `releasedAt` column (nullable timestamp) to the `missions` table. This is a proper
schema change: `bun db:generate && bun db:migrate`.

**Commit range shipped:** whatever is on the source ref (e.g. `dev`) ahead of `prodBranch`
at the time of the release. No special per-task commit tracking — the mission's accumulated
commits are all on the branch by the time the last task finishes. For `workflow_dispatch`
workspaces this is handled inside the release workflow (CI gate checks `dev` ahead of `main`).

**Cadence:** at most one release per mission, regardless of how many tasks it contains.
**Use case:** feature missions; sprint-based workflows; the buildd workspace itself.

#### `manual`

No release fires automatically on task or mission completion. The owner fires
`trigger_release` via MCP or the 'Release now' button on the workspace config page.

**Cadence:** owner-driven, no automation.
**Use case:** repos with their own release cadence, external release pipelines, or
workspaces that release rarely.

#### `scheduled` *(PHASE 2 — spec the shape, defer implementation)*

A cron expression governs when the next release fires. The scheduled trigger would be
owned by a task schedule (existing `taskSchedules` table), not baked into `releaseConfig`
directly. Shape placeholder:

```ts
// PHASE 2 — not implemented in this iteration
scheduledTrigger?: {
  cronExpression: string;   // e.g. '0 2 * * *' (nightly at 2am)
  timezone?: string;        // e.g. 'America/New_York'
  lastFiredAt?: string;     // ISO timestamp, updated on each fire
};
```

Implementation deferred. Do not block phase-1 work on this.

---

## 4. Collapsing the Double-Fire

### 4.1 The contract

> **The `trigger` policy is authoritative. The execution mechanism is determined by
> `strategy`. The completion-side (Path A) checks both before firing. The webhook
> side (Path B) defers to strategy and must not fire for `branch_merge` workspaces.**

### 4.2 Single-trigger enforcement

**Path A (completion-side) changes — `release-executor.ts` + `workers/[id]/route.ts`:**

1. Read `releaseConfig.trigger` (default `every_merge` if absent).
2. **`trigger: 'manual'`** → return `{ status: 'skipped', message: 'trigger=manual' }` immediately.
3. **`trigger: 'on_mission_complete'`** → skip per-task release; the mission-complete hook
   (§3.2) handles it separately.
4. **`trigger: 'every_merge'`** → proceed as today for `branch_merge`; skip for
   `workflow_dispatch` (Path B fires it).

**Path B (webhook) changes — `webhook/route.ts:374–401`:**

Replace the hardcoded `release.yml` dispatch with:

```ts
const resolution = resolveReleaseStrategy(mergedWorkspace.releaseConfig);
if (!resolution.ok) return; // not configured

const trigger = mergedWorkspace.releaseConfig?.trigger ?? 'every_merge';

// branch_merge workspaces are handled by Path A — never fire Path B for them
if (resolution.strategy.kind === 'branch_merge') return;

// trigger=manual: never auto-fire
if (trigger === 'manual') return;

// trigger=on_mission_complete: only fire if this task's mission is now all-terminal
if (trigger === 'on_mission_complete') {
  if (!mergedTask.missionId) return;
  const pending = await countPendingTasksForMission(mergedTask.missionId);
  if (pending > 0) return;
  // dedup via missions.releasedAt (same atomic pattern as §3.2)
}

// every_merge or on_mission_complete (terminal): dispatch the configured workflow
await githubApi(installationId, `/repos/${repo}/actions/workflows/${resolution.strategy.workflowFile}/dispatches`, {
  method: 'POST',
  body: JSON.stringify({ ref: resolution.strategy.ref, inputs: { force: 'false' } }),
});
// persist runId when available (per release-handoff-workflow.md §4)
```

This eliminates the double-fire. The invariant:
- `branch_merge` workspace → Path A fires (completion-side merge + Vercel poll). Path B skips.
- `workflow_dispatch` workspace → Path A skips (returns early). Path B dispatches.
- `manual` → neither path auto-fires.
- `on_mission_complete` → the mission-complete hook fires once (§3.2); per-task paths skip.

---

## 5. UI Spec — Release Section on Workspace Config

### 5.1 Placement

The Release section is a new card/section on `/app/workspaces/[id]/config`, after the
existing GitConfigForm and WebhookConfigForm sections. It does not require a separate
route or tab — it is co-located with other workspace-scoped configuration. (The unified
IA spec §D.4 named `/app/workspaces/[id]/releases` as an option; a section within
`/config` is functionally equivalent and avoids adding a new workspace sub-tab.)

### 5.2 Elements

#### Strategy selector

Dropdown: `branch_merge | workflow_dispatch | script (disabled) | none`.
- Default (no config): "None — releases not configured".
- Selecting `branch_merge`: show branch pickers below.
- Selecting `workflow_dispatch`: show workflow file + ref fields.
- Selecting `none` (or disabling): hide all release-specific fields; `releaseConfig.enabled = false`.

**Acceptance criteria:**
- AC-1: Selecting a strategy saves `releaseConfig.strategy` and `enabled: true` via
  `PATCH /api/workspaces/[id]/config`.
- AC-2: Selecting "None" saves `enabled: false`; all other release elements hide.
- AC-3: `script` option is shown but visually disabled with a "coming soon" tooltip.

#### Branch pickers (`branch_merge` only)

Two dropdowns: source branch → target branch. Defaults: `dev → main`.
Populated from the workspace's GitHub repo branches (existing pattern in GitConfigForm).

**Acceptance criteria:**
- AC-4: Labels read "Source (e.g. dev)" and "Production (e.g. main)".
- AC-5: Saving branch picks updates `releaseConfig.ref` (source) and `releaseConfig.prodBranch` (target).
- AC-6: Fields hidden when strategy ≠ `branch_merge`.

#### Workflow + ref fields (`workflow_dispatch` only)

Text input: "Workflow file (e.g. release.yml)"; text input: "Ref (e.g. dev)".

**Acceptance criteria:**
- AC-7: Saving updates `releaseConfig.workflowFile` and `releaseConfig.ref`.
- AC-8: Fields hidden when strategy ≠ `workflow_dispatch`.

#### Trigger-policy selector

Segmented control or dropdown with helptext per option:

| Value | Label | Helptext |
|---|---|---|
| `every_merge` | Every merge | Releases on each completed task. Use for hotfix workspaces or repos that ship continuously. |
| `on_mission_complete` | When mission completes *(recommended)* | Releases once after all tasks in a mission finish. Batches your work into one ship. |
| `manual` | Manual only | Nothing releases automatically. Use the 'Release now' button below or `trigger_release` via MCP. |
| `scheduled` *(Phase 2)* | Scheduled | *(disabled, "coming soon")* Nightly or periodic releases on a cron schedule. |

**Acceptance criteria:**
- AC-9: Selector saves `releaseConfig.trigger`.
- AC-10: `on_mission_complete` is visually highlighted as recommended (badge or default selection for new workspaces).
- AC-11: `scheduled` option shown as disabled with tooltip "Phase 2 — coming soon".
- AC-12: Helptext is visible inline below the selector (not in a tooltip) to aid discoverability.

#### 'Release now' button + last-release status

'Release now' button: calls `POST /api/releases/trigger` (existing `trigger_release` route).
Disabled when `strategy: none` or Vercel token missing.

Last-release status strip (below the button):
- Vercel deployment state badge: `READY` (green) | `BUILDING` (amber, animated) | `ERROR` (red) | `—` (no data).
- Timestamp: "Released 3 minutes ago" (relative), ISO on hover.
- Commit: short SHA with link to GitHub.
- Deploy URL: link labeled "Open →" when available.

Data source: `tasks.releaseResult` on the workspace's most recent completed release task.
The existing `GET /api/releases/status` route returns this data — expose it here.

**Acceptance criteria:**
- AC-13: 'Release now' fires the release and shows a loading state while in progress.
- AC-14: Last-release status auto-refreshes after 'Release now' is fired (poll every 10s
  while `deployState` is not terminal; stop polling at READY/ERROR/TIMEOUT).
- AC-15: Empty state when no release has ever run: "No releases yet" with a muted label.
- AC-16: 'Release now' disabled when `releaseConfig.enabled === false` or token missing;
  tooltip explains why.

#### Recent releases list *(optional — render if cheap)*

Table: date, mission/task link, commit SHA, duration, status. Max 5 rows. Source:
`tasks` where `releaseResult IS NOT NULL` ordered by `completedAt DESC`, scoped to the
workspace. Add a "View all" link if > 5 rows.

**Acceptance criteria:**
- AC-17: List renders with ≤ 5 rows and no pagination; shows empty state if none.
- AC-18: Status badges match the deploy state (READY / ERROR / SKIPPED / FAILED).
- AC-19: If fetching the list would require a new DB query that adds > 50ms to page load,
  load it lazily (client-side fetch after initial render).

#### Vercel token status (read-only)

A small status row: "Vercel token: Configured ✓" or "Vercel token: Not configured ✗".
Resolved from the `secrets` table for this team (purpose `vercel_token`). If missing:
amber warning with link "Configure in Connections →" (`/app/settings`).

**Acceptance criteria:**
- AC-20: Shows "Configured" (green check) when a team-scoped Vercel token secret exists.
- AC-21: Shows "Not configured" (amber warning) with link to `/app/settings` when absent.
- AC-22: Read-only — no edit affordance on this surface.
- AC-23: When token is missing and `strategy` requires Vercel (e.g. `branch_merge` with
  `deployTarget.type = 'vercel'`), 'Release now' is disabled with tooltip
  "Add Vercel token in Connections to release".

#### Empty / disabled states

- **Strategy = none (disabled):** Only the strategy selector is shown. All other elements hidden.
- **No GitHub repo linked:** All release elements hidden with inline note "Link a GitHub repo
  to enable releases".
- **Vercel token missing:** 'Release now' disabled per AC-23; trigger selector and branch pickers still editable.

#### `skipRelease` visibility per task

On the task detail page (`/app/tasks/[id]`), add a small badge in the task metadata row
when `tasks.release = 'false'`: "Skip release" (muted, no icon). When `release = 'true'`:
"Force release" (amber). Omit when `release = 'inherit'` (the default, no noise).

**Acceptance criteria:**
- AC-24: "Skip release" badge visible on task detail when `tasks.release = 'false'`.
- AC-25: "Force release" badge visible when `tasks.release = 'true'`.
- AC-26: No badge rendered for the default `inherit` case.

---

## 6. Implementation Breakdown

Sequenced tasks. Dependencies noted. Each becomes a separate buildd task after Max approves.

### Task 1 — Schema: add `trigger` to `WorkspaceReleaseConfig` + `releasedAt` to `missions`

**Scope:** `packages/core/db/schema.ts`, `packages/core/drizzle/` (migration)

**Changes:**
1. Add `ReleaseTrigger` type and `trigger?: ReleaseTrigger` field to `WorkspaceReleaseConfig`.
   No DB migration — it's JSONB.
2. Add `releasedAt: timestamp('released_at')` (nullable) to the `missions` table.
   **Migration required:** `cd packages/core && bun db:generate`, commit migration files.

**Dependencies:** none

**Verification:**
```bash
cd packages/core && bun db:generate
bun test
# Confirm migration file generated; no type errors
```

---

### Task 2 — Collapse double-fire to single authoritative path

**Scope:** `apps/web/src/app/api/github/webhook/route.ts:374–401`,
`apps/web/src/lib/release-executor.ts`, `apps/web/src/app/api/workers/[id]/route.ts:653–673`

**Changes:**
1. `webhook/route.ts`: replace hardcoded `release.yml` dispatch with `resolveReleaseStrategy`
   call; gate on `trigger` (skip if `manual`; skip if `branch_merge` strategy). Use
   `workflowFile` and `ref` from resolved config.
2. `release-executor.ts`: add trigger-policy early exits — skip if `trigger: 'manual'`
   or `trigger: 'on_mission_complete'`.
3. Write regression test covering: branch_merge workspace → Path B does NOT fire;
   workflow_dispatch workspace → Path A returns skipped; manual workspace → neither fires.

**Dependencies:** Task 1 (type definition for `ReleaseTrigger`)

**Verification:**
```bash
bun test apps/web/src/app/api/github/webhook/
bun test apps/web/src/app/api/workers/
# Confirm double-fire scenario covered by a test
```

---

### Task 3 — `on_mission_complete` batching + dedup

**Scope:** `apps/web/src/app/api/workers/[id]/route.ts`, new helper
`apps/web/src/lib/mission-release.ts`

**Changes:**
1. After a task completes, if `trigger === 'on_mission_complete'` and `task.missionId`:
   count pending tasks for the mission; if zero, attempt atomic claim via `missions.releasedAt`.
2. If claimed: call `executeRelease` (or dispatch workflow) once.
3. Write tests: two tasks completing concurrently → exactly one release fires.

**Dependencies:** Task 1 (schema), Task 2 (single-path enforcement)

**Verification:**
```bash
bun test apps/web/src/app/api/workers/
# Seed a 2-task mission; complete both near-simultaneously; confirm exactly one releaseResult
```

---

### Task 4 — Release UI section on workspace config page

**Scope:** `apps/web/src/app/app/(protected)/workspaces/[id]/config/` (new `ReleaseSection.tsx`),
`apps/web/src/app/api/workspaces/[id]/config/route.ts`

**Changes:**
1. New `ReleaseSection.tsx` client component: strategy selector, branch pickers,
   workflow/ref fields, trigger-policy selector (§5.2).
2. Wire `PATCH /api/workspaces/[id]/config` to accept `releaseConfig` partial updates.
3. Add `ReleaseSection` to `config/page.tsx` below the existing form sections.
4. Hide section entirely when workspace has no linked GitHub repo.

**Dependencies:** Task 1 (type), Task 2 (no functional dep, but shipping the UI
before fixing double-fire would confuse users)

**Verification:**
```bash
bun test apps/web/src/app/api/workspaces/
DEV_USER_EMAIL=your@email.com bun dev
# Navigate to /app/workspaces/[id]/config; Release section renders; save strategy
```

---

### Task 5 — 'Release now' button + last-release status

**Scope:** `ReleaseSection.tsx` (from Task 4), `apps/web/src/app/api/releases/` routes

**Changes:**
1. Add 'Release now' button wired to `POST /api/releases/trigger`.
2. Add last-release status strip reading `GET /api/releases/status`.
3. Poll every 10s while building; stop at terminal state.
4. Add `skipRelease` badge to task detail page (separate small change).

**Dependencies:** Task 4

**Verification:**
```bash
DEV_USER_EMAIL=your@email.com bun dev
# Fire 'Release now'; confirm loading state; confirm status strip updates
# Check task detail for a task with release='false': 'Skip release' badge visible
```

---

### Task 6 *(Phase 2)* — Scheduled trigger

**Scope:** `packages/core/db/schema.ts` (add `scheduledTrigger` to `WorkspaceReleaseConfig`),
`apps/web/src/lib/mission-release.ts`, release UI section

**Changes:**
1. Add `scheduledTrigger` shape to the type (cron expression, timezone, lastFiredAt).
2. Wire to a `task_schedule` entry that fires `trigger_release` on the cron.
3. Add a read-only "Next release in X" countdown to the UI when scheduled trigger is set.

**Dependencies:** Tasks 1–5

**Note:** This task MUST be opened as a separate, future task. Do not block Tasks 1–5 on
Phase 2 design. The placeholder in the type and disabled UI slot (§5.2) are sufficient
to communicate direction.

---

## 7. Open Questions (non-blocking — record for Max)

1. **Recent releases list (Task 5):** Does Max want this in the initial ship or as a
   follow-on? The acceptance criteria (AC-17) marks it optional. Recommend deferring
   to reduce scope.

2. **`branch_merge` deprecation timeline:** `release-handoff-workflow.md §2` proposes
   migrating all workspaces to `workflow_dispatch`. Once that migration completes, the
   `branch_merge` UI path (branch pickers) becomes dead code. For now, both strategy
   options are shown in the UI.

3. **`on_mission_complete` for orphan tasks (no missionId):** Tasks not associated with
   a mission with `trigger: 'on_mission_complete'` never fire a release. This may be
   intentional (all work should be mission-scoped) or a gotcha. Suggest: when saving
   `trigger: 'on_mission_complete'`, add an inline note "Tasks not in a mission will not
   trigger a release."

4. **`missions.releasedAt` reset:** Should `releasedAt` be clearable (e.g. to re-release
   a mission after a failed deploy)? The 'Release now' button + `manual` trigger serve
   this use case. No change proposed — record for awareness.

---

## 8. References

| Doc | Relationship |
|---|---|
| `docs/design/unified-app-ia.md §D.4` | Identifies Release management as an absent surface; recommends workspace tab placement. This doc fills that gap. |
| `docs/design/unified-app-ia.md §A` | Canonical scoping model (team = primary, workspace = narrower). Release follows this exactly. |
| `docs/design/release-handoff-workflow.md` | Release code audit, double-fire diagnosis, credential/strategy migration. This doc layers trigger policy + UI on top. |
| `docs/credentials-architecture.md` | Vercel token scoping (team-wide secret pattern). |
| `packages/core/db/schema.ts:266–314` | `WorkspaceReleaseConfig` interface — current state. |
| `apps/web/src/lib/release-executor.ts` | Path A implementation. |
| `apps/web/src/app/api/github/webhook/route.ts:374–401` | Path B — double-fire source. |
| `apps/web/src/app/api/workers/[id]/route.ts:653–673` | Path A invocation point. |
| `apps/web/src/app/app/(protected)/workspaces/[id]/config/` | Target UI location. |
