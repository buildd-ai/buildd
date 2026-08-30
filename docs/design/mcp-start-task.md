# MCP `start_task` action: expose the existing /start route over MCP

**Status:** Proposed — prerequisites merged (capability gate removed in PRs #1864, #1868; claim-gates.ts deleted; /start now imports from canonical gate modules)  
**Related:**
- `apps/web/src/app/api/tasks/[id]/start/route.ts` — the existing /start implementation
- `apps/web/src/app/api/workers/claim/` — canonical gate modules (`connector-gate.ts`, `held-gate.ts`, `workspace-cap-gate.ts`, `deps-gate.ts`, `deferred-gate.ts`, `pacing-gate.ts`)
- `apps/web/src/app/api/workers/claim/route.ts` — the authoritative claim gate
- `packages/core/mcp-tools.ts` — MCP action registry
- `apps/web/src/lib/task-dependencies.ts` — `dispatchUnblockedTask` (dep-resolution broadcast)
- PR #1241 — dep-PR gate + forceOverride
- PR #1512 — connector_routing_mismatch, mission_held, workspace_cap_reached gates
- PR #1677 (task 8fe56c91) — durable priority boost + manualStartAt stamp

---

## Problem

On 2026-08-28, five CI-passing PRs (#1857–#1861) sat unreviewed with their
`[reviewer]` tasks in `pending` state. An agent (or Max) looking at the queue had
no way to prod those tasks into motion without making a raw HTTP call.

The proximate cause is not a cadence gap. **Dispatch is pull-based**: workers poll
`POST /api/workers/claim` and take the highest-priority matching task. A manual
trigger (`POST /api/tasks/[id]/start`) already exists and is already hardened with
gate checks, but it is **not exposed over MCP**. Agents cannot use it.

---

## Step 1 Audit: every claim entry point

The table below enumerates how a task can go from `pending` to claimed. This is
the evidence base for deciding what to expose.

| # | Entry point | File | Trigger | MCP-exposed today? | Notes |
|---|---|---|---|---|---|
| 1 | `POST /api/workers/claim` | `apps/web/src/app/api/workers/claim/route.ts` | Runner polls on its own cadence | No | Single authoritative gate; enforces all SQL-level filters. Workers call this; it is never user-initiated. |
| 2 | `POST /api/tasks/[id]/start` | `apps/web/src/app/api/tasks/[id]/start/route.ts` | UI button or raw API key call | **No** — the gap | Runs pre-flight gate checks (dep-PR, deferred-start, connector routing, mission-held, workspace cap). On pass: stamps `context.manualStartAt`, boosts `priority+1`, broadcasts `TASK_ASSIGNED` via Pusher. Idempotent: a second call re-broadcasts but does not compound the priority boost. |
| 3 | `GET /api/cron/schedules` | `apps/web/src/app/api/cron/schedules/route.ts` | External scheduler (cron-job.org) hourly (`0 * * * *`) | No | **Creates** tasks from `taskSchedules` rows (not claims). After INSERT, calls `dispatchNewTask()` which fires `TASK_CREATED` + `TASK_ASSIGNED`. Tasks then sit in the claim queue for runner #1 to pick up. |
| 4 | `dispatchUnblockedTask()` | `apps/web/src/lib/task-dependencies.ts:496` | Called from completion route when a dependency resolves | No | Re-broadcasts `TASK_ASSIGNED` for tasks whose deps just cleared. Not user-triggered. |
| 5 | `POST /api/missions/[id]/run` | `apps/web/src/app/api/missions/[id]/run/route.ts` | Manual one-shot trigger, admin API key | Indirectly via `manage_missions` action on the MCP `buildd` tool | Creates + dispatches a planning task for a mission. Does not target an existing pending task. |

**Conclusion:** entry point #2 (`/start`) is the only user-initiated way to nudge
a specific pending task, and it is the only one absent from MCP. That is the gap.

---

## Current state of /start

`POST /api/tasks/[id]/start` (PR #1241, #1512, #1677):

**Gate checks (in order):** each returns `422 { gateReason, blockClass, ... }` with gate-specific extra fields:
1. `deferred_start` — task has a future `startAt` and `!forceOverride` · `blockClass: 'policy'` · `canForce: true`
2. `unmerged_dep_pr` — dependency is completed but has an unmerged PR · `blockClass: 'policy'` · `canForce: true` · `blockingDeps[]`
3. `connector_routing_mismatch` — task's role requires connectors missing or expired · `blockClass: 'capability'` · **no `canForce`** · `connectorFailures[]` · optional `alternativeRole`
4. `mission_held` — parent mission is held (startMode=held) and `!forceOverride` · `blockClass: 'policy'` · `canForce: true`
5. `workspace_cap_reached` — workspace is at `maxConcurrentTasks` · `blockClass: 'policy'` · `canExempt: true` (not `canForce`) · `active`, `cap`, `queuePosition`

**On pass:**
- Stamps `context.manualStartAt = now.toISOString()` (durable; survives Pusher drops)
- Boosts `tasks.priority += 1` once (idempotent: skipped if `manualStartAt` already set)
- Broadcasts `TASK_ASSIGNED` via Pusher to the workspace channel
- Writes `bypassDepsGate`, `bypassHeldGate`, `bypassSubjectGate`, `bypassMissionBudget`, `capExempt` to `task.context` when `forceOverride=true` (keys defined in `apps/web/src/lib/bypass-flags.ts`). There is deliberately no `bypassStartGate`: the deferred-start gate is a plain `startAt` comparison and the same UPDATE nulls `startAt`, so a second mechanism would only let a task render "Starts 3pm" while running.

**Body params:**
```ts
{
  targetLocalUiUrl?: string  // pin to specific runner instance
  forceOverride?: boolean    // bypass dep-PR, deferred-start, mission-held gates
  capExempt?: boolean        // bypass workspace cap for this one task
}
```

---

## Proposal

Add `start_task` as an MCP action on the existing `buildd` tool. The action is a
**thin wrapper around `POST /api/tasks/[id]/start`** via the internal API; it does
not reimplement gate logic.

### Crux

The design turns on one decision: **should `start_task` accept a list of task IDs
(bulk) or only a single ID?**

A single-ID action is safe and predictable. A bulk action multiplies the blast
radius and must itself respect concurrency caps — otherwise one call can push a
workspace past `maxConcurrentTasks` by racing multiple Pusher broadcasts before
the claim route can enforce the cap. See the *Team scope* section below for the
recommendation.

### Action signature

```ts
start_task({
  taskId: string,            // required; the pending task to start
  forceOverride?: boolean,   // bypass dep-PR, deferred-start, mission-held gates
  capExempt?: boolean,       // bypass workspace cap for this one task (single exception)
  targetLocalUiUrl?: string, // pin to a specific runner instance URL (rarely needed)
})
```

**Returns (success):**
```ts
{ started: true, taskId: string, targetLocalUiUrl: string | null }
```

**Returns (gate blocked — do not auto-retry):**
```ts
{
  started: false,
  gateReason: 'deferred_start'
            | 'unmerged_dep_pr'
            | 'connector_routing_mismatch'
            | 'mission_held'
            | 'workspace_cap_reached',
  blockClass: 'policy' | 'capability',
  canForce?: boolean,         // policy gates only; absent for connector_routing_mismatch
  canExempt?: boolean,        // workspace_cap_reached only
  blockingDeps?: { taskId, taskTitle, prUrl, prNumber }[],
  connectorFailures?: { connectorId, connectorName, mode }[],
  alternativeRole?: string,
  active?: number,
  cap?: number,
  queuePosition?: number,
}
```

**Returns (task not in pending state):**
```ts
{ started: false, error: string, status: string }  // 400
```

The caller must surface `gateReason` to the user (or decision-making agent) and
**never silently apply `forceOverride`**. If `forceOverride` is appropriate, it must
be set explicitly in the next call. The MCP tool description must state this
constraint.

### Token level

`start_task` requires an **admin-level token** (same as `send_agent_message`,
`manage_missions`, etc.). Rationale: it bypasses the normal claim-queue ordering
and can change which task a runner picks up next. A worker token can `create_task`
(which joins the queue naturally) but not jump the queue for an existing task.

### Implementation sketch

1. Add `'start_task'` to `adminActions` in `packages/core/mcp-tools.ts`.
2. In `handleBuilddAction()`, add a `start_task` branch that calls:
   ```ts
   await api(`/api/tasks/${params.taskId}/start`, {
     method: 'POST',
     body: JSON.stringify({
       forceOverride: params.forceOverride ?? false,
       capExempt: params.capExempt ?? false,
       targetLocalUiUrl: params.targetLocalUiUrl ?? undefined,
     }),
   });
   ```
3. Map the HTTP 200 / 400 / 404 / 422 responses to the structured return shapes
   above. Do not let a 422 become an MCP error — surface it as a successful
   tool call with `started: false` so the caller can inspect `gateReason`.
4. Add the action to `buildParamsDescription` (the action enum in the tool
   description); document `forceOverride` never being applied silently.
5. Add a route-test at
   `apps/web/src/app/api/tasks/[id]/start/route.test.ts` asserting
   the 422 gate shapes haven't drifted from the MCP description.

---

## Open question: team scope and bulk variant

### Should agents be able to start multiple tasks at once?

The 2026-08-28 scenario had **five** pending reviewer tasks. A single-ID action
requires five sequential calls. A bulk `start_tasks({ taskIds: string[] })` or a
filter-based `start_tasks({ filter: { workspaceId, status: 'pending', roleSlug? }, limit: N })`
would cover the scenario in one call.

**Argument for bulk:**
- The motivating incident involved five tasks. N sequential `start_task` calls work
  but feel mechanical. A bulk action is the natural idiom.

**Argument against unconstrained bulk:**
- Bulk broadcasts race against the claim route's cap enforcement. If a workspace is
  at `maxConcurrentTasks = 3` and the bulk action fires five `TASK_ASSIGNED` events
  simultaneously, all five runners see the events and attempt `POST /api/workers/claim`.
  The claim route serialises correctly (it uses SQL-level filtering on live worker
  count), so at most `cap` tasks will actually be claimed — the rest return empty and
  the runners discard them. But the caller receives `started: true` for all five, which
  is misleading. A runner that is not active will still pick it up when it becomes free,
  since the durable priority boost persists in the DB.

**Recommendation:** implement single-ID `start_task` first. Add
`start_tasks({ taskIds: string[], capExempt?: boolean })` as a second admin action
with the following constraint: the action checks `checkWorkspaceCap()` before
broadcasting each task and stops (with `{ started: false, gateReason: 'workspace_cap_reached' }`)
for the remainder if the cap is reached. It does not batch across workspaces (each
`taskId` belongs to one workspace; cap checks are per-workspace). This matches
`maxConcurrentTasks` semantics without a new concurrency primitive.

**Team-wide fan-out** (start all pending tasks across all workspaces) is out of scope.
It multiplies the blast radius by the number of workspaces, is not needed for the
incident scenario (all five tasks are in one workspace), and has no natural cap to
enforce. If the need arises, it belongs in a separate design.

---

## Resolved thread: backend credential surfacing after capability gate removal

**Status: ADDRESSED (configuration-time surfacing, no gate).** See
`docs/specs/mission-task-lifecycle.md` → Claim-gate legibility contract.
`apps/web/src/lib/backend-strand.ts` counts pending tasks whose *effective*
backend (`resolveEffectiveBackend`: stored backend + team provider mask) has no
credential, and three read-only surfaces consume it: Settings → Agent backends
(via `GET /api/teams/[id]/backend-readiness`), Health → Problems, and the
`backend_credential_missing` stall reason in `/api/cron/queue-stall`. Still
explicitly NOT a claim gate — nothing in that path withholds a task.

The `capability_mismatch` gate that previously blocked Codex tasks when credentials
were absent has been removed from both the claim route and `/start` (PRs #1864,
#1868). This was deliberate: backend credential presence is a workspace-configuration
and onboarding problem, not a per-task claim gate.

The consequence: a Codex task can now be claimed and dispatched to a runner, which
then fails at execution time if the runner cannot resolve valid credentials. This
failure surfaces in worker telemetry but is not proactively shown to the task creator.

**Where it should surface instead:**
- Workspace settings / onboarding flow — detect missing backend credentials and prompt
  the user before they create or start Codex tasks.
- `GET /api/workspaces/[id]/backends` (PR #1858) already returns
  `{ id, label, available, reason }` using the same logic the old gate used.
  The task-creation UI (`EditTaskModal`, `QuickCreateModal`) fetches this on mount and
  disables unavailable backends with a tooltip. The gap is at the _workspace level_:
  a new workspace with no Codex credential should surface that during setup, not
  only when a task fails.

**Explicitly NOT a claim gate.** Per the mission design: do not build a generalized
backend-credential gate in the claim path. Implement in onboarding/settings UI.

**What shipped.** The workspace-level gap above is now covered team-wide rather
than per-workspace: the count is the operator-facing consequence ("Codex has no
credential — 7 pending tasks can never be claimed"), not another chip.
`GET /api/workspaces/[id]/backends` (task-creation UI) is unchanged and remains
the per-workspace availability check.

---

## Open thread: Pusher socket lifecycle may explain why /start times out

**Status: OPEN — not delivered in PR #1677 and not addressed since. Unrelated to gate consolidation.**

PR #1677 (task `8fe56c91`) had three acceptance items:
1. ✅ Durable priority boost via `context.manualStartAt` + `priority+1`
2. ✅ `bypassDepsGate` / `bypassHeldGate` / `bypassSubjectGate` / `bypassMissionBudget` / `capExempt` context flags

**Item 3 was not delivered:** diagnose why manual Start acceptance never succeeded
for Max, with runner-side Pusher subscription lifecycle as the prime suspect (a
runner that looks online but holds a dead socket between `/start` broadcasts and
the runner's `handleEvent` call).

The symptom: the runner is visible in the dashboard (heartbeat OK), `TASK_ASSIGNED`
is broadcast, but the task is never claimed. If the runner's Pusher client
reconnects after the event fires, the event is lost (Pusher does not replay missed
messages to reconnected clients). The durable priority boost (#1677 item 1) ensures
the task stays at the front of the queue so the *next* poll cycle picks it up — but
if the poll interval is long (60 min default), the operator still waits.

This is a separate investigation, not a blocker for this design. File as its own
task referencing `8fe56c91`. The MCP action will face the same Pusher delivery
uncertainty; the durable priority boost already mitigates it.

---

## Why this is not engineering around the claim route

The claim route (`POST /api/workers/claim`) remains the **single authority for task
claiming**. This design adds no new claiming logic and no new concurrency primitive.
`start_task` does two things the claim route already trusts:
1. Pre-flight gate checks (same predicates as the canonical gate modules in `apps/web/src/app/api/workers/claim/`)
2. Priority boost + Pusher broadcast (already done by the dashboard's Start button)

The runner still calls `POST /api/workers/claim`; the only change is that an MCP
caller can trigger the same pre-flight + boost that a human clicking the UI button
does today. No gate is bypassed by default. No claiming happens on the server side.

---

## Non-goals

- Changing the claim route, the claim cadence, or claim logic.
- Changing any cron expression.
- A team-wide bulk start (fan-out across all workspaces).
- Auto-force: the action never silently applies `forceOverride`.
- Creating new tasks (use `create_task` for that).
- Diagnosing the Pusher socket lifecycle issue (separate task `8fe56c91`).
