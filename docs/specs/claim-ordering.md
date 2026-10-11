---
title: Claim Ordering (Batch Planner)
status: active
owner: max
last_verified: 2026-10-04
summary: The claim route MUST order auto-claims through planClaimBatch only when a workspace opts in, MUST never co-schedule across a hard edge, and MUST use predicted scope only above pinned, evidence-backed thresholds.
domain: tasks
surfaces: [packages/core/claim-planner.ts, apps/web/src/app/api/workers/claim/claim-plan-input.ts, apps/web/src/app/api/workers/claim/claim-plan-store.ts, apps/web/src/app/api/workers/claim/route.ts]
related: [orchestration-decisions-shadow, path-claim-ownership, mission-task-lifecycle]
keywords: [jev, claim planner, claimPlanner, claimPlannerThresholds, thetaOrder, thetaSoft, thetaIdle, ordered_behind, claim_plan, record mode, apply mode, soft edge, hard edge, work conservation]
verified_by: [packages/core/__tests__/claim-planner.test.ts, apps/web/src/app/api/workers/claim/claim-plan-input.test.ts, apps/web/src/app/api/workers/claim/claim-plan-store.test.ts]
assertions:
  - id: "plan-claim-batch"
    type: "symbol"
    name: "planClaimBatch"
    path: "packages/core/claim-planner.ts"
  - id: "pinned-calibration"
    type: "symbol"
    name: "CLAIM_PLANNER_CALIBRATION"
    path: "packages/core/claim-planner.ts"
  - id: "planner-wired"
    type: "symbol_reachable"
    symbol: "planClaimBatch"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "call"
  - id: "config-resolver-wired"
    type: "symbol_reachable"
    symbol: "resolveClaimPlannerConfig"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "call"
  - id: "planner-tests"
    type: "test_file"
    path: "packages/core/__tests__/claim-planner.test.ts"
supersedes: []
---
# Claim Ordering (Batch Planner)

**Capability statement**: For each auto-claim call, buildd MAY choose the set
of tasks to claim with a pure batch planner instead of the first-eligible
walk. It MUST do so only for workspaces that opt in, MUST never let a
prediction override a hard edge, and MUST name, for every task it does not
pick, what it is ordered behind.

## Modes

`gitConfig.claimPlanner` on the workspace, read only through
`resolveClaimPlannerConfig`:

| Mode | Behaviour |
| --- | --- |
| `off` (absent or unrecognised) | The legacy `priority DESC, createdAt ASC` first-eligible walk, with no extra read and no extra write. |
| `record` | The plan is computed beside the legacy walk and both are written to the gate ledger under the `claim_plan` reason. Claims are unchanged. |
| `apply` | Tasks are claimed in plan order. Every claim gate still runs on each pick; a refused or raced pick is dropped and the rest re-planned. Tasks ordered behind a blocker get one `ordered_behind` row per (task, blocker). |

Rollback is setting the mode back to `record` or `off`; nothing persists
between claim calls, so there is no state to unwind.

## Thresholds

`thetaOrder`, `thetaSoft` and `thetaIdle` (`PlannerThresholds`) gate predicted
scope. A workspace's own `gitConfig.claimPlannerThresholds` wins when all
three are in [0, 1]; otherwise the pinned `CLAIM_PLANNER_CALIBRATION` applies.
Thresholds are pinned only from a readout over `record`-mode weeks, together
with the readout they were measured from. As shipped, no such readout exists:
the pinned thresholds are null, its verdict is `insufficient_n`, and no
workspace runs in `apply`. With null thresholds the planner uses declared and
observed scope only, and `apply` is the legacy behaviour plus orientation and
smaller-first ordering.

**Invariants**:
- `planClaimBatch` is pure: the same input in any row order returns the same plan.
- The plan never picks more than the capacity it is given.
- No two picks share a hard edge (concrete path overlap, lease overlap, open-PR pinned files, a shared serialized surface, an unresolved dependency, or the no-scope mission mutex), and no pick has a hard edge to in-flight work.
- Soft edges only delay a task; they never become hard.
- With null thresholds, predicted scope is ignored entirely.
- `CLAIM_PLANNER_CALIBRATION.thresholds` is non-null only together with a `readoutRef`, a `measuredOn` identity and verdict `eligible_for_gated`.
- An explicit `taskId` claim (including every force claim) never goes through the planner.
- A gated START (live since task 7eb191b9) is one more gate on each pick: it can only relax an advisory deferral the pick reaches, so `apply` keeps its order.

**Acceptance criteria**:
- AC-1: GIVEN a workspace with no `claimPlanner` WHEN the claim route runs THEN the planner input is never built and no `claim_plan` row is written.
- AC-2: GIVEN two candidates whose concrete manifests overlap WHEN `planClaimBatch` runs with capacity 2 THEN exactly one is picked and the other is skipped with reason `path_overlap` and names the picked one as its blocker.
- AC-3: GIVEN a candidate with only predicted scope AND null thresholds WHEN `planClaimBatch` runs THEN its prediction creates no soft edge.
- AC-4: GIVEN `claimPlannerThresholds` with any value outside [0, 1] WHEN `resolveClaimPlannerConfig` reads it THEN it returns the pinned calibration's thresholds, never a partial set.
- AC-5: GIVEN `claimPlanner: 'record'` WHEN a claim call completes THEN the claimed tasks are the ones the legacy walk would claim, and the plan is recorded beside them.
- AC-6: GIVEN capacity 0 WHEN `planClaimBatch` runs THEN it returns no picks.

**Code surface**:
- `packages/core/claim-planner.ts` — `planClaimBatch`, `PlannerThresholds`, `CLAIM_PLANNER_CALIBRATION`.
- `apps/web/src/app/api/workers/claim/claim-plan-input.ts` — `resolveClaimPlannerConfig`, `buildClaimPlanInput`, `plannerScopedTaskIds`.
- `apps/web/src/app/api/workers/claim/claim-plan-store.ts` — `loadPlannerSignals`, `fireClaimPlanRecord`, `fireOrderedBehind`.
- `apps/web/src/app/api/workers/claim/route.ts` — mode resolution, record/apply branches.
- `packages/core/db/schema.ts` — `claimPlanner` and `claimPlannerThresholds` on the workspace git config.

**Out of scope**:
- How predicted scope and set confidence are produced (see `orchestration-decisions-shadow`).
- Path leases and their release (see `path-claim-ownership`).
- The readout's metric computation; this spec only fixes how its result is pinned.
