---
title: Mission & Task Lifecycle
status: active
owner: max
last_verified: 2026-08-29
supersedes: []
---
# Mission and Task Lifecycle

**Capability statement**: The buildd coordination layer MUST enforce the defined
state machines for both tasks and missions, allowing only documented transitions,
deriving mission health from live task state (never storing it), and unblocking
downstream DAG tasks when a task reaches a terminal state.

---

## Task State Machine

**States**: `pending` → `assigned` | `claimed` → `in_progress` → `review` →
`completed` | `failed`

The authoritative status string is `tasks.status`. The schema uses `text` (not
an enum) to allow extension without migrations.

| Status | Meaning |
|--------|---------|
| `pending` | Available for a runner to claim. |
| `assigned` | Reserved for a specific runner (not yet started). |
| `claimed` | Claimed optimistically; worker row being created. |
| `in_progress` | Worker has started (runner transitions via PATCH). |
| `running` | Worker is actively running (worker status, not task). |
| `review` | Output submitted; awaiting human review. |
| `completed` | Terminal: deliverable produced (or promoted from stale worker with deliverables). |
| `failed` | Terminal: all retry attempts exhausted or permanent error. |

**Invariants**:
- A task with `dependsOn` set MUST remain `pending` (non-claimable) until all
  listed task IDs are `completed`.
- `claimedBy` MUST be set atomically with `status = 'claimed'` using an
  `UPDATE … WHERE status = 'pending'` optimistic lock.
- A task with an active worker (status in `running`, `starting`, `waiting_input`,
  `idle`) MUST NOT be reset to `pending` while that worker is alive.
- `outputRequirement = 'pr_required'` MUST block `complete_task` unless
  `workers.prUrl` is set.
- A task transitions to `failed` permanently after `MAX_WORKER_RETRIES = 3`
  failed workers with no deliverables.
- A task with `roleSlug = null` is claimable by any runner with access to the
  workspace — this is the normal case for dashboard-created tasks. Routing via
  `roleSlug` is primarily used by MCP `create_task`, orchestrator agents, and
  schedules. `context.skillSlugs` (JSON field) carries advisory skill hints to
  the executing agent but does NOT restrict claim routing.

**Acceptance criteria**:
- AC-1: GIVEN a task with `dependsOn: [taskA]` and `taskA.status = 'pending'`
  WHEN `claim_task` is called THEN the task is NOT returned (still blocked).
- AC-2: GIVEN `taskA.status` transitions to `completed` WHEN
  `resolveCompletedTask` runs THEN the dependent task's status becomes `pending`
  and a `task:unblocked` Pusher event is fired.
- AC-3: GIVEN `outputRequirement = 'pr_required'` and `prUrl` is null WHEN
  `complete_task` is called THEN the server returns an error — the task is NOT
  completed.
- AC-4: GIVEN a task that has had 3 prior `failed` workers WHEN the 4th worker
  is marked stale THEN `tasks.status = 'failed'` (permanent, no more retries).
- AC-5: GIVEN a concurrent claim race WHEN two runners call `claim_task`
  simultaneously THEN exactly one succeeds and the other receives an appropriate
  error or empty result.

**Code surface**:
- Claim route: `apps/web/src/app/api/workers/claim/route.ts`
- Worker update (PATCH): `apps/web/src/app/api/workers/[id]/route.ts`
- Dependency resolution: `apps/web/src/lib/task-dependencies.ts` —
  `resolveCompletedTask()`
- Stale reclaim: `apps/web/src/lib/stale-workers.ts` — `resolveStaleTask()`
- Schema: `packages/core/db/schema.ts` — `tasks` table

---

## Claim-gate legibility contract

Every condition that withholds a `pending` task from the claim query is a
**gate**. Gates are not optional machinery — they prevent duplicate PRs, budget
overruns and file collisions. What is not optional is that an operator can tell
a gate apart from an idle queue.

Two prod incidents defined this contract: task `aeb80faf` was unclaimable for 5
days and `640e7da2` for 24, both rendering as ordinary `QUEUED` rows, both
because a gate excluded them with no signal and no override. `aeb80faf` was
additionally the root of a 20-task dependency funnel, so one invisible gate
stalled a whole workspace.

**Invariants**: for every gate,
- **CG-1 (named)**: the gate MUST produce a stable `gateReason` string, and
  `/api/tasks/[id]/start` MUST return `422` with that reason rather than a `200`
  that dispatches nothing. A success response for a task that cannot be claimed
  is a lie the operator acts on.
- **CG-2 (visible)**: the blocking state MUST be derivable by the display layer
  from data the task list already selects, and MUST NOT render as `QUEUED`.
  Surfaces using explicit `columns` MUST select the fields their gate predicate
  reads — an unselected column reads as `undefined` and silently re-hides the
  state.
- **CG-3 (overridable or declared)**: a gate MUST either honour a documented
  bypass key (see `apps/web/src/lib/bypass-flags.ts`) or declare
  `blockClass: 'capability'`, meaning force-start is refused on purpose. A
  bypass key that no gate reads, or a gate that ignores its own key, is a false
  safety net — `bypassStartGate` and `capExempt` were both in that state.
- **CG-4 (one predicate)**: a gate's SQL prefilter and its in-loop guard MUST
  derive from one shared contract module, never two hand-synchronised copies.
  See `dep-gate-contract.ts`, `subject-gate-contract.ts`, `bypass-flags.ts`.
  Divergence in either direction is a defect: SQL stricter than TS strands the
  task, TS stricter than SQL admits work that should have waited.
- **CG-5 (terminal gates terminate)**: when a gate concludes a task can never
  become claimable, the task MUST be moved to a terminal status rather than left
  `pending`. `cancelled` is the dependency gate's satisfying status, so
  terminating a dead task is also what releases its dependents; leaving it
  `pending` starves them indefinitely.
- **CG-6 (transient gates self-clear)**: a gate that is expected to clear MUST
  do so without human action, and MUST be expressed as a soft deferral —
  `continue` plus a `deferrals` counter, retried next poll — never as a stored
  `dependsOn` edge, which waits for `completed` + PR `merged`.

**Gate inventory** (`gateReason` → class):

| gateReason | Clears by | Class |
|---|---|---|
| `deferred_start` | time (`startAt`) | policy, forceable |
| `dep_missing` / `dep_failed` / `unmerged_dep_pr` | upstream terminal state | policy, forceable |
| `mission_held` | arming the mission | policy, forceable |
| `mission_budget_exhausted` | raising the mission budget | policy, forceable |
| `subject_dead` | never (terminal) | policy, forceable |
| `workspace_cap_reached` | drain | policy, forceable |
| `connector_routing_mismatch` | fixing the connector | capability |

`StartTaskButton` also renders a `capability_mismatch` branch that no route
emits. That is deliberate, not an oversight: the capability abstraction whose
only real check was "does this backend have a credential" was removed in PR
#1864 and replaced by the onboarding/workspace-configuration path (see
`docs/SPEC.md` → Removed concepts). A task whose backend has no credential is
therefore still stranded without a task-level gateReason — a known gap that must
be closed through onboarding surfacing, NOT by reviving the gate.

Soft deferrals are counted in `ClaimDiagnostics.deferrals` and MUST all
self-clear: `path_overlap`, `advisory_manifest`, `mission_concurrent`,
`mission_paced`, `budget_paused`, `provider_unavailable`. They are not
`gateReason` values — `/start` does not reject on them, because by the time an
operator reads the response the deferral has usually already cleared.

They are still reportable: `/api/cron/queue-stall` names a soft deferral once a
task has been held by one for longer than the stall threshold, since "transient"
stops being an excuse at that point. `advisory_manifest` is the case that
matters — its blocking peer may be parked in `waiting_input`, holding the slot
until a human answers, which never self-clears in practice.

Two entries appear in the hard-gate table above rather than here, because the
claim loop counts them but `/start` also rejects on them: `subject_dead`
(terminal) and `workspace_cap` / `workspace_cap_reached`.

**Acceptance criteria**:
- AC-CG-1: GIVEN a task excluded by any gate WHEN `/start` is called without
  `forceOverride` THEN the response is `422` with a `gateReason`, no Pusher
  broadcast is emitted and the priority is unchanged.
- AC-CG-2: GIVEN a gate with a bypass key WHEN `/start` is called with
  `forceOverride` THEN the key is written to `task.context` AND the claim query
  admits the task on the next poll.
- AC-CG-3: GIVEN a bypass key written as boolean `true` or string `'true'` THEN
  both the SQL prefilter and the in-loop guard accept it.
- AC-CG-4: GIVEN a task pending beyond `QUEUE_STALL_THRESHOLD` with no
  successful claim THEN `/api/cron/queue-stall` reports it with the first gate
  actually blocking it — never a bare "stalled".
- AC-CG-5: GIVEN a subject-dead task with a binding anchor WHEN the
  reconciliation sweep runs THEN the task becomes `cancelled` AND its dependents
  become claimable.

**Code surface**:
- Per-gate modules: `apps/web/src/app/api/workers/claim/` —
  `connector-gate.ts`, `deferred-gate.ts`, `deps-gate.ts`, `held-gate.ts`,
  `mission-budget-gate.ts`, `pacing-gate.ts`, `subject-gate.ts`,
  `workspace-cap-gate.ts`. Each holds its SQL predicate and its per-task check
  side by side, so the claim route and `/start` cannot drift (rule CG-4). There
  is deliberately no aggregate `lib/claim-gates.ts` — it was a hand-mirrored
  copy of these predicates and was deleted in PR #1868.
- Gate contracts: `apps/web/src/lib/dep-gate-contract.ts`,
  `apps/web/src/lib/subject-gate-contract.ts`,
  `apps/web/src/lib/bypass-flags.ts`
- Override surface: `apps/web/src/app/api/tasks/[id]/start/route.ts`
- Display: `apps/web/src/lib/task-presentation.ts` — `deriveTaskPhase()`,
  `apps/web/src/components/StageChip.tsx` — `deriveStage()`
- Watchdog: `apps/web/src/app/api/cron/queue-stall/route.ts`

---

## Worker State Machine

Workers are execution sessions. A worker's `status` is separate from the task
status and tracks the agent's runtime state:

| Status | Meaning |
|--------|---------|
| `idle` | Worker row created; agent not yet started. |
| `starting` | Runner is launching the agent. |
| `running` | Agent is actively processing. |
| `waiting_input` | Agent paused, waiting for a human response. |
| `completed` | Agent finished successfully. |
| `failed` | Agent or runner encountered a terminal error. |
| `error` | System-level error (distinct from agent failure). |

**Invariants**:
- A terminal worker (`completed`, `failed`, `error`) MUST NOT accept status
  updates except a single `running` reactivation (for follow-up messages from
  the runner, with a guard on `isCleanupExpiry`).
- `waitingFor` MUST be cleared (`null`) automatically when status transitions
  to `running`.
- `workers.startedAt` is set the first time status becomes `running`.

**Acceptance criteria**:
- AC-6: GIVEN `worker.status = 'failed'` WHEN a PATCH with `status = 'running'`
  is received THEN the reactivation is allowed ONLY if the caller passes the
  cleanup-expiry guard; otherwise HTTP 409 is returned.
- AC-7: GIVEN `worker.status = 'waiting_input'` WHEN a PATCH with
  `status = 'running'` arrives THEN `waitingFor` is set to `null` in the same
  update.

**Code surface**:
- PATCH handler: `apps/web/src/app/api/workers/[id]/route.ts`
- Reactivation guard: same file, lines ~88–109

---

## Mission State Machine

**States**: `active` → `paused` → `active` (reversible) | `completed` →
`archived`

Mission `status` is stored in `missions.status`. Mission **health** is NEVER
stored — it is derived on read from the state of associated tasks via
`deriveMissionHealth` / `isDeliverableTask`.

**Invariants**:
- Mission status transitions (`active ↔ paused`, `active → completed`,
  `completed → archived`) are driven by human action (dashboard or MCP) or
  mission loop evaluation tasks — not by any automatic side effect.
- Health is computed from deliverable tasks only (`isDeliverableTask` filters out
  `kind = 'coordination'`, `mode = 'planning'`, and housekeeping titles).
- A paused mission MUST NOT spawn new tasks from its schedule while paused.
- A mission's `activeHoursStart/End/Timezone` fields restrict when its heartbeat
  schedule fires. When set, the cron skips firing outside the active window.
  `activeHours` gates firing cadence only — it does NOT change mission status.
  A `completed` or `paused` mission with `activeHours` set MUST NOT treat the
  active-hours window as a resume signal.
- `missions.workingBranch` and `primaryPrNumber` track the shared branch for
  all tasks under the mission; they are generated lazily on first task creation.
  For workspace-less missions (`workspaceId = null`), these fields are always
  null (no repo, no PRs).

**Acceptance criteria**:
- AC-8: GIVEN a mission with all tasks `completed` WHEN health is derived THEN
  the health reflects 100% completion (no failed deliverable tasks).
- AC-9: GIVEN a `planning` mode task linked to a mission WHEN health is derived
  THEN that task is excluded from the deliverable count.
- AC-10: GIVEN `missions.status = 'paused'` WHEN the cron schedule fires THEN
  no new task is created for that mission.
- AC-10b: GIVEN an `active` mission with `activeHoursStart/End` set and the
  current time is outside the configured window WHEN the heartbeat fires THEN
  no new task is created. The mission remains `active` — `activeHours` is a
  firing gate, not a status transition.
- AC-11: GIVEN a mission with `requiresReview = true` WHEN a task PR is created
  THEN auto-merge is suppressed and human review is required before merging.

**Code surface**:
- Mission helpers: `packages/core/mission-helpers.ts` — `isDeliverableTask()`
- Mission context: `apps/web/src/lib/mission-context.ts`
- Mission API: `apps/web/src/app/api/missions/route.ts`,
  `apps/web/src/app/api/missions/[id]/route.ts`
- Schema: `packages/core/db/schema.ts` — `missions` table

---

## Mission Dormancy Pattern (long-horizon missions)

For missions with a defined active season (e.g., annual tax prep Jan–Mar,
quarterly review), the recommended pattern is:

- Keep `status = 'active'` year-round — do NOT use `paused` for seasonal gaps.
- Set `activeHoursStart/End/Timezone` to a narrow window (e.g., 9–10 AM
  Chicago) so the heartbeat fires infrequently and does not spam task creation.
- Write heartbeat logic that checks the current date against the mission's
  documented season window before spawning tasks. When outside the season, the
  heartbeat should log a status note and return without creating tasks.

**Contrast with `paused`**: Use `paused` for human-suspended missions awaiting
explicit manual resume. Use `active + restrictive activeHours + self-suppressing
heartbeat` for missions that auto-manage their own seasonal cadence. Mixing the
two (pausing a seasonal mission to prevent off-season tasks) is valid but means
the heartbeat must be manually re-enabled each season.

**Schema gap**: There is no `resumeAt timestamp` field for formal hibernation
with a scheduled wake date ("pause until 2027-01-15"). The workaround is
heartbeat self-suppression. A `missions.resumeAt` column is a candidate future
addition for missions that need hard-scheduled wake-up semantics.

---

## Workspace-less Missions

Missions with `workspaceId = null` are valid. They are used for:
- **Personal-agent missions**: financial tasks, email triage, annual-cycle
  planning with no code deliverables.
- **Cross-workspace coordination**: an organizer mission that dispatches tasks
  to multiple workspaces, each task carrying an explicit `workspaceId`.

**Invariants**:
- `workingBranch` and `primaryPrUrl` are always null for workspace-less
  missions (no repo, no PRs). Do not treat null values for these fields as an
  error or health failure.
- A mission with `workspaceId = null` and zero deliverable tasks MUST return a
  "no tasks" health signal. This is expected — workspace-less missions may have
  no code deliverables by design.
- Task creation from a workspace-less mission MUST supply an explicit
  `workspaceId` on each created task. There is no automatic inference from the
  mission to the task. If the heartbeat or organizer omits `workspaceId` on a
  task, that task's `workspaceId` is driven by whichever workspace the executing
  runner claims from.

**Acceptance criteria**:
- AC-14: GIVEN a workspace-less mission with no tasks WHEN health is derived
  THEN the result is "no tasks" (not "healthy" and not an error).
- AC-15: GIVEN a workspace-less mission WHEN its detail page loads THEN
  `workingBranch` and `primaryPrUrl` display as absent (not as broken links).

---

## `deriveMissionHealth` contract

**Capability statement**: `deriveMissionHealth` MUST compute the health of a
mission from its live task list without reading from any stored health column.

**Invariants**:
- Only deliverable tasks (`isDeliverableTask()` returns `true`) count.
- A mission with zero deliverable tasks MUST return a "no tasks" or "empty"
  health signal (not "healthy").

**Acceptance criteria**:
- AC-12: GIVEN tasks `[{status:'completed'}, {status:'failed'}, {kind:'coordination'}]`
  WHEN health is derived THEN the coordination task is excluded and health
  reflects 1 completed, 1 failed deliverable.
- AC-13: GIVEN a task with `title: 'Aggregate results: …'` WHEN `isDeliverableTask`
  is called THEN it returns `false`.

**Code surface**:
- `packages/core/mission-helpers.ts` — `isDeliverableTask()`

**Out of scope**: Sub-missions (`parentMissionId`) lifecycle. Mission heartbeat
scheduling (covered by `task-schedules`). The mission loop orchestration agent
logic (runner-side, not coordination layer).

---

## Organizer prior-work retrieval contract

**Capability statement**: Every mission planning pass — whether triggered by cron
(heartbeat) or manually — MUST inject a "Related prior work" block retrieved from
the KnowledgeStore before the organizer decides what tasks to create.

**Corpora queried** (all best-effort, failures silently skipped):

| Corpus | Namespace | Purpose |
|--------|-----------|---------|
| `memory` | `{teamId}:memory` | Team lessons and gotchas |
| `task` | `{workspaceId}:task` | Prior task outcomes |
| `pr` | `{workspaceId}:pr` | Pull request diffs (change history) |
| `code` | `{workspaceId}:code` | Current code index |
| `plan` | `{workspaceId}:plan` | Prior decomposition plans |

Cap: 3 hits per corpus to bound prompt growth.

**Rendering**: Each hit shows `[score] title | type/status | PR ref | age`. Task
hits with `success=true` and a `prUrl` surface the PR number. Memory hits show age.

**Stale-baseline flag**: Any task hit where `metadata.success === true` and
`metadata.prUrl` is set and `createdAt` is within the last 14 days renders with:
> ⚠ MAY ALREADY BE SHIPPED — read the merged diff before specing.

**Path-based lookup**: When active tasks in the mission carry a `pathManifest`,
`buildKnowledgeContext` runs an additional query against `{workspaceId}:pr` using
the path list as query text. Results appear in a separate "Recent work on relevant
paths" section. Composes with PR #1130 overlap serialization.

**Decomposition skip rule**: If a retrieved item scores ≥0.82 cosine similarity
AND its task card `createdAt` is within 14 days with a PR, the organizer MUST NOT
create a task for that scope. Required action: `post_note type=decision` naming
the PR and explaining why decomposition was skipped.

**Invariants**:
- Retrieval failure MUST NOT fail or block a heartbeat or planning pass.
- Sensitive workspaces (`dataClass = 'sensitive'`) skip the `memory` corpus query.

**Code surface**:
- `apps/web/src/lib/knowledge-context.ts` — `buildKnowledgeContext()`
- `apps/web/src/lib/mission-context.ts` — `buildMissionContext()`, `buildHeartbeatContext()`

**Acceptance criteria**:
- AC-16: GIVEN a mission with prior related work WHEN heartbeat context is built
  THEN the "Related prior work" block is present with score, status, and PR ref.
- AC-17: GIVEN a task card with `success=true`, `prUrl` set, `createdAt` 3 days ago
  WHEN knowledge context is built THEN the stale-baseline warning is rendered.
- AC-18: GIVEN the same task card with `createdAt` 30 days ago
  THEN no stale-baseline warning appears.
- AC-19: GIVEN active tasks with `pathManifest` entries
  WHEN knowledge context is built THEN a path-scoped PR query fires.
- AC-20: GIVEN the knowledge store throwing on all queries
  WHEN heartbeat or planning context is built THEN no error is raised and the
  rest of the context is returned normally.

---

## Organizer situational awareness contract

**Capability statement**: Every organizer pass MUST inject a "Workspace Situational
Awareness" block scoped to the trigger cause. This gives the organizer a live
picture of what else is happening in the workspace (sibling missions, held path
claims, open PRs, parent initiative, budget pressure) without a full workspace
dump on every pass.

**Cause enum**:

| Cause | Trigger |
|-------|---------|
| `task_completed` | `resolveCompletedTask` calls the organizer |
| `pr_merged` | GitHub webhook fires after a PR merges |
| `conflict_escalation` | Worker hits a 409 on `check_path_claim` |
| `claim_409` | Same as conflict_escalation (MCP tool variant) |
| `mission_evaluate` | Normal organizer/heartbeat evaluation pass |
| `first_decomposition` | First evaluation of a freshly-created mission |
| `fallback` | Cause unknown or not supplied |

**Section matrix** (which sections render per cause):

| Section | task_completed | pr_merged | conflict_* | mission_evaluate | first_decomposition | fallback |
|---------|:-:|:-:|:-:|:-:|:-:|:-:|
| What landed | ✓ | ✓ | | | | |
| Blocking claim | | | ✓ | | | |
| Sibling missions | | | | ✓ | ✓ | ✓ |
| Held path claims | | | | ✓ | ✓ | ✓ |
| Open PRs | | | | ✓ | ✓ | |
| Parent initiative | | | | ✓ | ✓ | |
| Budget | | | | ✓ | ✓ | |

**Character budget per section** (hard caps — oversized input truncates, never errors):

| Section | Cap (chars) |
|---------|-------------|
| What landed | 400 |
| Blocking claim | 400 |
| Sibling missions | 600 (≤5 shown) |
| Held path claims | 400 (≤10 shown) |
| Open PRs | 400 (≤5 shown) |
| Parent initiative | 200 |
| Budget | 100 |

**Data sources** (one DB query per section, no N+1):

1. **Path claims** — `path_claims WHERE released_at IS NULL`, joined with `tasks` for
   taskTitle and missionId. Age always shown so stale rows are visually obvious.
2. **Sibling missions** — `missions` + aggregated task counts in a single GROUP BY query.
3. **Open PRs** — `workers WHERE pr_url IS NOT NULL AND merged_at IS NULL AND
   pr_lifecycle_status IS DISTINCT FROM 'merged'/'closed'`.
4. **Parent initiative** — `initiatives.progressCache` + `kpiState` (no additional mission
   join; the cache holds the rollup).
5. **Budget** — `teams.monthlyCostUsd / monthlyBudgetUsd` as a one-line percentage.

**Integration points**:
- `buildMissionContext()` reads `templateContext.cause` (defaults to `mission_evaluate`)
  and `templateContext.causeData` to pass into `buildWorkspaceStateContext`.
- `buildHeartbeatContext()` always calls with `cause = 'mission_evaluate'` (heartbeat
  is a broad evaluation pass, not a targeted event).

**Invariants**:
- A source failure (query error, missing data) MUST degrade to omitting that section —
  never block context assembly or propagate an error.
- All five querier calls fire concurrently via `Promise.allSettled`.
- `task_completed` / `pr_merged` / `conflict_*` causes make ZERO querier calls —
  they render inline from `causeData` alone.
- `fallback` omits initiative, open PRs, and budget to cap cost on unknown-trigger passes.

**Acceptance criteria**:
- AC-21: GIVEN cause = `task_completed` WHEN `buildWorkspaceStateContext` runs THEN
  the output contains "What landed" and does NOT contain "Sibling missions".
- AC-22: GIVEN cause = `conflict_escalation` and `blockingMissionId` is a non-null
  string WHEN the block is rendered THEN it says "different mission" with the mission ID.
- AC-23: GIVEN cause = `mission_evaluate` and a sibling mission holds a path claim
  WHEN context is built THEN the holder's taskId and missionId are visible.
- AC-24: GIVEN an `initiativeId` and cause = `mission_evaluate` and the initiative has
  KPI state THEN "KPIs: N/M met" appears in the output.
- AC-25: GIVEN cause = `mission_evaluate` and `initiativeId = null` THEN "Parent
  initiative" section is absent.
- AC-26: GIVEN all querier methods throw WHEN context is built THEN a non-empty string
  is returned without error propagation.
- AC-27: GIVEN cause = `fallback` THEN budget and initiative sections are absent even
  when those queriers would succeed.
- AC-28: GIVEN 20 held claims WHEN the claims section renders THEN at most 10 are shown.

**Code surface**:
- `apps/web/src/lib/workspace-state-context.ts` — `buildWorkspaceStateContext()`
- `apps/web/src/lib/mission-context.ts` — integration in `buildMissionContext()`,
  `buildHeartbeatContext()`
- `apps/web/src/lib/workspace-state-context.test.ts` — 25 tests covering all causes,
  degradation, and budget enforcement
