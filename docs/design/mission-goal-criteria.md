---
status: implemented
assertions:
  - type: symbol
    name: goalCriteria
    path: packages/core/db/schema.ts
  - type: symbol
    name: GoalCriterion
    path: packages/shared/src/types.ts
  - type: symbol
    name: evaluateGoalCriteria
    path: packages/core/mission-helpers.ts
  - type: route
    method: POST
    path: /api/missions/[id]/evaluate
    file: apps/web/src/app/api/missions/[id]/evaluate/route.ts
  - type: symbol
    name: kpis
    path: packages/core/db/schema.ts
  - type: symbol
    name: InitiativeKPI
    path: packages/shared/src/types.ts
  - type: symbol
    name: evaluateInitiativeKPIs
    path: packages/core/mission-helpers.ts
---

# Mission Goal Criteria & Initiative KPIs

**Status:** Proposed
**Related:**
`packages/core/db/schema.ts` (missions, initiatives tables),
`packages/core/mission-helpers.ts` (computeMissionProgress, computeInitiativeProgress),
`packages/shared/src/types.ts` (GoalCriterion, CriterionVerdict, InitiativeKPI),
`packages/core/mcp-tools.ts` (manage_missions, manage_initiatives actions),
`apps/web/src/app/api/missions/route.ts`,
`apps/web/src/app/api/missions/[id]/route.ts`,
`apps/web/src/lib/loop-dispatcher.ts`,
`docs/design/loop-until-verified.md`,
`docs/design/mission-state-progress.md`,
`docs/design/convergence-layer.md`

---

## Problem

A mission today completes when `computeMissionProgress` returns 100% — all
deliverable tasks are `completed`. There is no mechanism for a mission to declare
**what "done" means beyond task closure**. Two failure modes follow:

1. **False completion**: a mission whose tasks are all done but whose actual
   goal is unmet (e.g. PRs merged but a key artifact not created, or a metric
   still below threshold) transitions to `completed` anyway. The organizer
   stops. Work that should have continued, doesn't.

2. **Ambiguous initiative closure**: an initiative today marks itself completed
   when `computeInitiativeProgress` returns `status = 'completed'`, which fires
   when all child missions reach `status = 'completed'`. There is no way for an
   initiative to hold itself open pending an outcome-level indicator — a
   business metric, a rollup threshold, a percentage threshold across child
   missions — that outlives individual task completion.

Neither missions nor initiatives can currently express **outcome-oriented
completion conditions** that are distinct from task-level progress. The
organizer has no machine-checkable signal to distinguish "tasks done, goal
met" from "tasks done, goal not yet verified."

---

## Proposal

**Crux:** the evaluation authority. The evaluator runs *after* the organizer
observes 100% task progress, not during task execution. The organizer is the
sole caller for automatic evaluation; it never spawns a parallel verifier.
If the evaluator is wrong about this it will double-fire, produce split
verdicts, and leave missions with contradictory blocker notes. The evaluation
path must be a single, guarded call site.

### 1. goalCriteria schema (missions)

Add `goalCriteria` as a nullable JSONB column to the `missions` table.
When null (the default), completion behaviour is unchanged.

```ts
// packages/shared/src/types.ts

export type GoalCriterionType =
  | 'all_prs_merged'
  | 'command'
  | 'no_open_tasks'
  | 'artifact_exists'
  | 'metric';

export type GoalCriterion =
  | {
      type: 'all_prs_merged';
      // "done means merged-and-branch-deleted": every task PR in the mission must
      // have mergedAt set AND the head branch must no longer exist on the remote.
      // A PR that is merged but whose branch is still open is NOT satisfied.
      requireBranchDeleted?: boolean; // default true
      label?: string;
    }
  | {
      type: 'command';
      // Shell command run in the workspace repo root. Exit code 0 = pass.
      // The command runs as a worker task via the runner (not in-process on
      // the web server). Secrets from the workspace's env manifest are injected.
      command: string;
      label?: string;
    }
  | {
      type: 'no_open_tasks';
      // All mission tasks in { completed | cancelled | failed }; zero tasks in
      // { pending | assigned | in_progress }. Cancelled tasks satisfy this
      // criterion — "closed" in any way counts.
      label?: string;
    }
  | {
      type: 'artifact_exists';
      // At least one artifact attached to this mission matches all non-null filters.
      key?: string;   // artifact.key exact match
      artifactType?: string; // artifact.type exact match (content, report, data, …)
      label?: string;
    }
  | {
      type: 'metric';
      // Evaluated by a workspace-registered metric query.
      // The platform fetches the metric value and compares:
      //   value <operator> threshold  → pass when true
      query: string;
      operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
      threshold: number;
      unit?: string;  // display only; not used in comparison
      label?: string;
    };
```

**Validation rules:**
- `command` must be a non-blank string for the `command` type.
- `query` and `operator` and `threshold` are all required for `metric`.
- The array has a maximum length of 20 criteria. Longer arrays are rejected at
  write time. This prevents unbounded evaluation loops.
- An empty array (`[]`) is stored as-is but treated as "no criteria" — the
  mission completes on task progress alone, same as `null`.

**`all_prs_merged` branch-deleted semantics:**
The platform checks `workers.mergedAt IS NOT NULL` for all deliverable-task
workers (existing gate) PLUS calls `GET /repos/{repo}/git/refs/heads/{branch}`
for the mission's `workingBranch` — a 404 from GitHub means the branch is gone.
When `requireBranchDeleted: false`, only `mergedAt` is checked. Default is
`true` because a merged-but-live branch is the pre-cleanup state in a shared-
feature-branch mission.

### 2. Initiative KPI model

Add `kpis` as a nullable JSONB column to the `initiatives` table. When null,
completion is the existing `computeInitiativeProgress().status === 'completed'`.

```ts
// packages/shared/src/types.ts

export interface InitiativeKPI {
  name: string;          // human-readable label, e.g. "P95 latency under 200ms"
  metric: string;        // workspace metric query identifier
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  threshold: number;
  unit?: string;         // display only
  // When true, an unmet KPI blocks initiative completion even after all child
  // missions complete. When false, this KPI is informational only.
  blocking?: boolean;    // default true
}
```

**KPI evaluation model:**
- KPIs are **outcome-oriented indicators evaluated across child missions**. They
  do not replace mission goalCriteria — they add an initiative-level gate.
- A blocking KPI unmet after all child missions complete keeps the initiative
  `status = 'active'`. The initiative's `progressCache.status` cannot enter
  `'completed'` while any blocking KPI is unmet.
- KPI values are fetched at evaluation time via the same workspace metric query
  mechanism as the mission `metric` criterion. No rollup logic is applied server-
  side — the query is expected to aggregate across the initiative's scope.
- **Machine-readable KPI state** for orchestrator polling lives in
  `kpiState` (a new JSONB column on `initiatives`), detailed in §3 below.

### 3. Verification state machine

#### Mission verification

```text
Mission task-complete candidacy:
  computeMissionProgress(tasks).progress === 100 AND goalCriteria is non-empty

  ↓ organizer or on-demand trigger calls evaluateGoalCriteria(missionId)

  Evaluate each criterion in order:
    all_prs_merged   → query workers + GitHub branch API
    command          → dispatch a one-shot worker task; verdict from exit code
    no_open_tasks    → query tasks table
    artifact_exists  → query artifacts table
    metric           → call workspace metric query; apply operator

  Per-criterion verdict: 'pass' | 'fail' | 'UNVERIFIED'
    pass        — criterion evaluated and satisfied
    fail        — criterion evaluated and not satisfied
    UNVERIFIED  — evaluation was not attempted (command task pending,
                  metric unreachable, or evaluation skipped)

  All criteria → 'pass':
    → set mission.status = 'completed'  (COMPLETE transition)

  Any criterion → 'fail' or 'UNVERIFIED':
    → leave mission.status = 'active'   (NEEDS_VERIFICATION)
    → write goalCriteriaState with per-criterion verdicts
    → post a mission note (type: 'warning') listing failed/unverified criteria
    → organizer enters coordination-only mode for this mission (no new tasks)
```

**State storage:**

```ts
// Stored in missions.goalCriteriaState (new JSONB column)
export interface GoalCriteriaState {
  evaluatedAt: string;          // ISO 8601
  evaluatedBy: 'auto' | 'manual' | 'mcp';
  overall: 'pass' | 'fail' | 'UNVERIFIED';
  criteria: Array<{
    index: number;
    type: GoalCriterionType;
    label?: string;
    verdict: 'pass' | 'fail' | 'UNVERIFIED';
    evidence?: string;          // brief human-readable rationale, max 500 chars
    workerTaskId?: string;      // for 'command' type: the dispatch task ID
  }>;
}
```

**Verdict vocabulary rules:**
- Exactly three values: `pass`, `fail`, `UNVERIFIED`. No synonyms. No booleans.
- `UNVERIFIED` is not a failure but it blocks completion — a criterion that
  could not be checked is treated as unknown, not as passing. This is the
  conservative default: an unevaluated criterion never silently grants completion.
- `command` criteria issue a one-shot worker task and enter `UNVERIFIED` until
  the worker completes. On worker completion, the criterion is re-evaluated and
  set to `pass` or `fail`. A `command` criterion that remains `UNVERIFIED` for
  more than 24 hours is marked `fail` with evidence "evaluation task timed out".

#### Initiative KPI verification

```text
Initiative completion candidacy:
  computeInitiativeProgress(children).status === 'completed' AND kpis is non-empty

  ↓ organizer calls evaluateInitiativeKPIs(initiativeId)

  For each KPI with blocking: true:
    Fetch metric value via workspace query
    Apply operator and threshold

  All blocking KPIs → 'pass':
    → allow initiative.status = 'completed'

  Any blocking KPI → 'fail' or 'UNVERIFIED':
    → hold initiative.status = 'active'
    → write kpiState with per-KPI verdicts
    → post initiative note listing unmet KPIs

  Non-blocking KPIs (blocking: false) are evaluated and stored in kpiState
  but do not affect initiative.status.
```

**KPI state storage:**

```ts
// Stored in initiatives.kpiState (new JSONB column)
export interface InitiativeKPIState {
  evaluatedAt: string;
  evaluatedBy: 'auto' | 'manual' | 'mcp';
  overall: 'pass' | 'fail' | 'UNVERIFIED';
  kpis: Array<{
    index: number;
    name: string;
    verdict: 'pass' | 'fail' | 'UNVERIFIED';
    observedValue?: number;
    evidence?: string;
  }>;
}
```

### 4. Trigger modes and defaults

Three modes are defined. All three are explicit — no implicit evaluation
happens outside the organizer heartbeat path or a user/MCP on-demand call.

#### (a) Auto-verify — enabled by default when criteria/KPIs are set

When `goalCriteria` is non-empty on a mission and `autoVerify !== false`, the
organizer's heartbeat checklist evaluation runs `evaluateGoalCriteria` as the
final step after detecting 100% task progress. No new cron or verifier service.
This reuses the existing heartbeat dispatch path in `apps/web/src/lib/loop-dispatcher.ts`.

**Default: auto-verify is ON whenever goalCriteria/kpis are set.** A mission
with goalCriteria and `autoVerify` unset behaves as if `autoVerify: true`.

#### (b) Per-mission / per-initiative autoVerify: false toggle (disabled-orchestrator mode)

Add `autoVerify?: boolean` (default: true) to the missions and initiatives
update schema. When `autoVerify: false`:
- The organizer **never** runs `evaluateGoalCriteria` automatically.
- The mission can still complete via task progress alone (same as no criteria).
- On-demand evaluation via the UI button or MCP action still works.
- This toggle is the escape hatch for missions where orchestration is manual
  and the operator wants full control of completion timing.

**Nothing runs unattended when `autoVerify: false`.** This mirrors
`orchestrationMode: 'manual'` semantics — the platform cedes initiative to the
human operator.

#### (c) On-demand evaluation

Both missions and initiatives expose an on-demand evaluation path:

- **UI**: a "Verify criteria" button appears on the mission detail page when
  `goalCriteria` is non-empty. It calls `POST /api/missions/[id]/evaluate`.
  The button is always visible regardless of `autoVerify` setting.
- **MCP**: `buildd` action `manage_missions` extended with `action: 'evaluate'`
  (see §5). Returns the structured `GoalCriteriaState` result synchronously
  for non-`command` criteria; for `command` criteria, returns the dispatched
  worker task ID and an `UNVERIFIED` state.

On-demand evaluation does not change `autoVerify` — it is a one-shot check,
not a toggle.

**Rate limit:** on-demand evaluation is rate-limited to 6 calls per mission per
hour to prevent polling abuse. The UI button is debounced (10 s).

### 5. MCP surface

All new parameters are added to existing `manage_missions` and
`manage_initiatives` actions. No new top-level actions are introduced.

#### manage_missions extensions

```
action: 'create' | 'update'
  goalCriteria?: GoalCriterion[]    — set/replace criteria (null clears)
  autoVerify?: boolean              — default true; false = disabled-orchestrator mode

action: 'get'
  response adds: goalCriteria, goalCriteriaState, autoVerify

action: 'evaluate'  ← NEW
  params: { missionId }
  Triggers on-demand evaluation of goalCriteria.
  Returns: GoalCriteriaState (with per-criterion verdicts).
  For 'command' criteria not yet resolved: verdict 'UNVERIFIED' + workerTaskId.
  Rate limit: 6/hour per mission.

action: 'get_criteria_state'  ← NEW
  params: { missionId }
  Returns: last GoalCriteriaState without re-evaluating.
  Cheap read — no evaluation triggered.
```

#### manage_initiatives extensions

```
action: 'create' | 'update'
  kpis?: InitiativeKPI[]            — set/replace KPIs (null clears)
  autoVerify?: boolean              — default true

action: 'get'
  response adds: kpis, kpiState, autoVerify

action: 'evaluate'  ← NEW
  params: { initiativeId }
  Triggers on-demand evaluation of all KPIs.
  Returns: InitiativeKPIState.
  Rate limit: 6/hour per initiative.

action: 'get_kpi_state'  ← NEW
  params: { initiativeId }
  Returns: last InitiativeKPIState without re-evaluating.
```

**Full MCP parity:** every operation available in the UI (set criteria/KPIs,
trigger evaluation, read last results) is available via MCP. There is no UI-
only path for goal criteria management.

### 6. Composition and migration impact

#### Reuse of existing plumbing

- **Loop/verification plumbing**: the `command` criterion dispatches a one-shot
  worker task rather than invoking shell code in-process. This reuses the
  existing task→worker→complete path (`apps/web/src/app/api/workers/[id]/route.ts`)
  with a synthetic task of category `'chore'` and `outputRequirement: 'none'`.
  No new runner command-execution path is introduced.
- **`gateCondition: 'merged'`**: the `all_prs_merged` criterion checks the same
  `mergedAt` predicate already used by `checkAndUnblockDependentMissions`. No
  parallel gating logic.
- **Heartbeat dispatch**: auto-verify fires inside the existing mission
  organizer heartbeat checklist evaluation. The evaluator is called from the
  same point the organizer would otherwise create a "Close mission" coordination
  task. It replaces that heuristic for missions with goalCriteria — rather than
  the organizer guessing completion, it runs the declared criteria.
- **No parallel verifier stack**: there is no separate verifier service,
  scheduler, or cron. The evaluation authority is the organizer heartbeat and
  the on-demand API route — exactly two call sites, both already gated.

#### Migration impact: existing missions

- `goalCriteria = null` is the default. Existing missions have no criteria and
  are not affected. `computeMissionProgress` is unchanged; the 100%-progress
  transition to `completed` continues to fire for missions without criteria.
- `kpis = null` is the default for initiatives. `computeInitiativeProgress` is
  unchanged.
- `autoVerify` is not stored when unset — it defaults to `true` at read time.
  No backfill is required.

#### Schema additions

Four new JSONB columns (no NOT NULL, all nullable, zero backfill):

| Table | Column | Type | Default |
|---|---|---|---|
| `missions` | `goalCriteria` | `jsonb` | `null` |
| `missions` | `goalCriteriaState` | `jsonb` | `null` |
| `missions` | `autoVerify` | `boolean` | `null` (reads as true) |
| `initiatives` | `kpis` | `jsonb` | `null` |
| `initiatives` | `kpiState` | `jsonb` | `null` |
| `initiatives` | `autoVerify` | `boolean` | `null` (reads as true) |

A single Drizzle migration adds all six columns. No index is needed — criteria
are only queried by primary key (mission/initiative ID).

---

## Current State

- `missions` table: `packages/core/db/schema.ts` lines 571–654. No `goalCriteria`
  column exists today. Completion is driven entirely by task-progress percentage
  computed in `computeMissionProgress` (`packages/core/mission-helpers.ts:70–94`).
- `initiatives` table: lines 671–691. `progressCache.status = 'completed'` is the
  only completion gate. No KPI column exists.
- `computeInitiativeProgress` (`packages/core/mission-helpers.ts:135–156`) rolls
  up child mission statuses. It has no knowledge of outcome indicators.
- Heartbeat organizer creates "Evaluate mission completion:" coordination tasks
  heuristically. Those tasks are excluded from `isDeliverableTask`
  (`packages/core/mission-helpers.ts:22–36`) and are the hook point for
  goal-criteria evaluation.

---

## Implementation sketch

Ordered load-bearing first:

1. **Schema + types**: add six JSONB columns; generate migration; add
   `GoalCriterion`, `GoalCriteriaState`, `InitiativeKPI`, `InitiativeKPIState`
   to `packages/shared/src/types.ts`.

2. **`evaluateGoalCriteria`** in `packages/core/mission-helpers.ts`: stateless
   helper that takes a mission row + task list + worker list + artifact list and
   returns `GoalCriteriaState`. Does not write to the DB — callers persist the
   result. This keeps the helper pure and testable. `command` criteria return
   `UNVERIFIED` and a pending-task payload; callers dispatch the task.

3. **`evaluateInitiativeKPIs`** in `packages/core/mission-helpers.ts`: same
   pattern — pure function, callers persist.

4. **On-demand route**: `POST /api/missions/[id]/evaluate` — evaluates criteria,
   persists state, posts mission note if any fail, returns state. Mirror for
   `POST /api/initiatives/[id]/evaluate`.

5. **Organizer integration**: in the heartbeat evaluation path, after
   `computeMissionProgress().progress === 100`, call `evaluateGoalCriteria`
   before setting `mission.status = 'completed'`. If any criterion is not
   `pass`, leave status `active` and persist state. Skip evaluation when
   `autoVerify === false`.

6. **MCP extensions**: add `goalCriteria`, `autoVerify`, `evaluate`,
   `get_criteria_state` to `manage_missions`; mirror for `manage_initiatives`.

7. **UI**: "Verify criteria" button on mission detail; per-criterion verdict
   chips in a collapsible section. Initiative detail: KPI status row below
   progress bar.

---

## Open questions

**Should `fail`-state missions auto-retry?** When `evaluateGoalCriteria` finds
a failing criterion, should the organizer create a remediation task? Leaning
**no**: the organizer already handles task-level failures (retry tasks, PR
conflict coordination). Goal-criteria failures are outcome-level failures that
may require human judgment. Auto-creating a remediation task risks infinite
loops. The mission note acts as a signal; a human or mission orchestrator
decides the next step.

**`command` criterion: timeout and cost.** A command worker task counts against
the mission's `costBudgetUsd`. A runaway command would exhaust budget. Proposed:
`command` criterion worker tasks have a hard 60-second runner timeout (same as
`runner-verification.ts`). Cost is attributed to the mission. If the command
task fails, the criterion is marked `fail`, not `UNVERIFIED`.

**Metric query registry.** The `metric` and `kpi` types reference a `query`
string against a "workspace metric query". This registry does not exist today.
Leaning: defer metric-type criteria to a follow-on spec. Implement the schema
field and the evaluation stub (returns `UNVERIFIED` with evidence "metric query
not implemented") in this iteration, so the type is locked and the field is
present without a dependency on an unbuilt system.

---

## Non-goals

- **Metric query registry implementation**: the schema accommodates it; the
  evaluator stubs it. Building the registry is a separate spec.
- **Replacing `computeMissionProgress`**: task-count progress and goal-criteria
  are orthogonal. A mission can be 100% tasks done and still have unmet
  criteria. The progress bar reflects task completion; the criteria gate
  reflects outcome verification.
- **Per-task criteria**: criteria live at mission scope. Individual tasks have
  `verificationCommand` and `loopConfig` — mission goal criteria are not a
  replacement.
- **Automatic remediation**: a failing criterion does not auto-create a
  remediation task. The organizer signals the failure; humans or future policy
  decide the response.
- **Cross-mission criteria**: a criterion cannot reference another mission's
  state. Initiative KPIs are the cross-mission aggregation layer.
- **Versioned criteria history**: only the most recent `GoalCriteriaState` is
  stored. Full evaluation history is in the mission notes feed.
