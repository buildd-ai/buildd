---
title: Claim Overlap Scheduling
status: draft
owner: max
last_verified: 2026-10-11
summary: An inferred path-overlap hold MUST bind only to live work (a live worker, a held lease or an open PR on the same base); overlap between unstarted tasks is settled by the first claim's lease.
domain: tasks
surfaces: [apps/web/src/app/api/workers/claim/deps-gate.ts, apps/web/src/app/api/workers/claim/soft-overlap-gate.ts, apps/web/src/app/api/workers/claim/open-pr-target-base.ts, apps/web/src/lib/explain-coordination.ts]
related: [path-claim-ownership, orchestration-decisions-shadow, force-start, task-dispatch-authority, claim-ordering, runner-liveness]
keywords: [path_overlap, soft_overlap, inferredDependsOn, softOverlaps, legacy_inferred, unstarted holder, schema lane, migration lane, starvation, claim_loop_deferral, update drain, claims halted, dependency.satisfied]
verified_by: [apps/web/src/app/api/workers/claim/deps-gate.test.ts, apps/web/src/app/api/workers/claim/soft-overlap-gate.test.ts, apps/web/src/app/api/workers/claim/open-pr-target-base.test.ts, apps/web/src/lib/explain-coordination.test.ts, packages/core/__tests__/dispatch-dependents.test.ts, apps/web/src/lib/conflict-retry.test.ts]
---

# Claim Overlap Scheduling

Path-overlap inference exists to stop two tasks editing the same migration
index, schema or hard surface **at the same time**. A task that has not started
is editing nothing. This spec makes every overlap hold say what it is waiting
on, makes that thing live work, and makes the first claim of an unstarted pair
the decision.

Builds on, and does not redo: the hard/soft split and migration 0267 (#3936),
waiter wake on path release (#3446), attempt cycle edges and migration 0282
(#4076), migration-collision repairs skipping migration-only edges (#4340), the
open-PR blocker reading the real diff, and the claim-time lift of an inferred
edge onto a holder that never started (#4434, `inferredEdgeOntoUnstartedHolder`
in `deps-gate.ts`).

## Terms

- **Inferred edge**: an id in `tasks.dependsOn` that is also listed in
  `pathDeclaration.inferredDependsOn` (written by `partitionOverlapEdges` at
  creation or by a conflict retry). Every other id in `dependsOn` is a
  **declared edge**.
- **Soft overlap**: an entry in `pathDeclaration.softOverlaps`, never a
  dependsOn edge.
- **Live holder**: a task that, right now, has a worker in
  `LIVE_WORKER_STATUSES`, an active `path_claims` lease, or a worker whose PR is
  open and unmerged on the candidate's landing base.
- **Unstarted holder**: a `pending` task that is not a live holder. A pending
  task whose `startAt` is in the future is always unstarted.
- **Hard-class path**: a migration or schema path (`isHardOverlapKind`) or a
  workspace hard surface (`lib/hard-overlap-surfaces.ts`).

## Why the schema lane stalled (2026-10-11)

Three defects stacked. Each is fixed by a capability below.

1. **A parked task held the lane.** The lane head was a trigger-gated chore
   filed with a `startAt` ten days out ("do not start before the legacy drains").
   Its dispatch history shows the creation wake was skipped as
   start-at-future, which is correct: it was never claimable, and zero claim
   attempts is the expected record. But every later schema task was given an
   overlap hold on it: inferred dependsOn edges (lifted at claim since #4434,
   still reported as holding by explain), and soft overlaps that
   `evaluateSoftOverlaps` turns into a `deterministic_hold` of kind `migration`
   whatever the holder's state. One candidate recorded hundreds of consecutive
   `soft_overlap` deferrals naming it.
2. **A trunk → mission refresh PR held trunk work.** `partitionOpenPrsByLandingBase`
   keeps a cross-base PR blocking when both sides touch migrations. A refresh
   PR's migration files are trunk's own, merged into the mission branch, so it
   cannot collide with anything landing on trunk. It still deferred every
   trunk-bound schema task as `path_overlap` while it was open.
3. **Nothing reported the stall as a stall.** explain said "pending with no
   live worker, dispatch a worker", list_runners showed free slots, and the
   Failure Pattern Sentinel's `path_overlap_stall` rule groups by blocker PR, so
   a hold on a task with no PR landed under `unknown`.

## Capability 1: inferred holds bind only to live work

**Capability statement.** An inferred edge or soft overlap holds a candidate
only while its holder is a live holder. Between two unstarted tasks the first
claim wins by taking an exclusive lease on its hard-class paths, and the other
defers on that lease.

**Invariants**

- I1.1 A declared edge is never lifted, converted or skipped by any rule in
  this spec.
- I1.2 An inferred edge or soft overlap onto an unstarted holder does not hold
  the candidate at claim (deps gate, soft-overlap gate, explain, and the
  dashboard Start probe answer the same).
- I1.3 An inferred edge or soft overlap onto a live holder keeps its current
  behaviour: a migration or hard-surface overlap is a deterministic hold;
  anything else stays advisory under HOLD/START.
- I1.4 A claim whose manifest contains a hard-class path, and which proceeds
  past any overlap with an unstarted holder, acquires those paths through
  `acquireGatedStartPaths` before the atomic claim UPDATE, all-or-nothing. If
  the acquire fails the candidate defers as `path_overlap` and registers a
  waiter on the lease holder. If the UPDATE loses the race the lease is given
  back.
- I1.5 An open PR into a different landing base whose task is a trunk → mission
  branch refresh never blocks a candidate landing on trunk at layer 1, migration
  paths included. Every other cross-base migration carve-out in
  `partitionOpenPrsByLandingBase` is unchanged.
- I1.6 At creation, `partitionOverlapEdges` (task route and conflict retry)
  records an overlap with an unstarted holder as a soft overlap, never an
  inferred edge, so that the stored row and the claim rule agree. Overlap with a
  live holder still produces the hard edge it does today.

**Acceptance criteria**

- AC-1: GIVEN two pending tasks A and B whose manifests both name
  `packages/core/db/schema.ts`, neither started, and B created after A with an
  overlap onto A, WHEN a runner polls, THEN both are claimable; and WHEN A is
  claimed first, THEN A holds an active lease on the schema path and the next
  poll defers B as `path_overlap` naming A, with a waiter registered on A.
- AC-2: GIVEN the same pair, WHEN B is claimed first, THEN A defers as
  `path_overlap` on B's lease although A has no edge or soft overlap onto B.
- AC-3: GIVEN task A has a live worker or an active lease on the schema path,
  WHEN B (inferred edge or soft overlap onto A) polls, THEN B is deferred
  (deterministic hold), exactly as before this spec.
- AC-4: GIVEN holder A is pending with `startAt` in the future, WHEN B polls,
  THEN no hold names A, and explain for B lists no hold on A.
- AC-5: GIVEN a declared edge from B onto an unstarted A, WHEN B polls, THEN B
  stays blocked on the dependency gate.
- AC-6: GIVEN an open refresh PR merging trunk into a mission branch whose diff
  touches migration files, WHEN a trunk-bound task touching schema polls, THEN
  layer 1 does not defer it on that PR.
- AC-7: GIVEN a lease acquire that fails for a race, WHEN the claim runs, THEN
  the task stays pending, the deferral reason is `path_overlap`, and no lease
  row is left behind for it.
- AC-8 (regressions): the #3936 prefix/same-file advisory behaviour, the #4076
  inverse open-PR exclusion inside `evaluateSoftOverlaps`, and the #4340
  collision-repair skip all keep their existing tests green unchanged.

**Code surface.** Route: `/api/workers/claim`. Data model: `tasks.dependsOn`,
`tasks.pathDeclaration` (`inferredDependsOn`, `softOverlaps`), `path_claims`.
Helpers: `depsGate`, `evaluateSoftOverlaps`, `partitionOpenPrsByLandingBase`,
`acquireGatedStartPaths`, `partitionOverlapEdges`, `buildCoordinationHolds`.

**Out of scope.** Changing which overlaps are hard-class. Changing HOLD/START or
Jev thresholds. Any change to declared dependencies.

## Capability 2: completion and merge wake every dependent

**Capability statement.** Every event that can satisfy a hold enqueues a
dispatch wake for each pending task it held, through the existing outbox. A wake
re-runs the claim gate; it never bypasses it.

**Invariants**

- I2.1 Task completion calls `checkDependsOnResolved`, which wakes dependents
  through `enqueueReadyDependents` with `depsGate`. A merged PR does the same
  through `runMergedPrWork`. Both stay the only wake paths for edges.
- I2.2 A holder leaving live state (its worker fails, is detached or re-queues
  the task to `pending` with no open PR) enqueues a `dependency.satisfied` wake
  for each pending task holding an inferred edge or soft overlap onto it, since
  I1.2 now releases them.
- I2.3 A waiter is woken immediately at registration only when the blocker's
  lease was released after the deferral read it. A deferral against a holder
  that holds no lease does not wake itself. Before this, a pending task could be
  woken many times a minute by its own deferrals.
- I2.4 The repair sweep `findPendingTasksWithResolvedDepsAndNoWake` uses the same
  gate, so a missed wake is recovered by the next maintenance run.

**Acceptance criteria**

- AC-9: GIVEN B has a declared edge onto A, WHEN A completes with no PR, THEN
  one `dependency.satisfied` outbox row for B exists before the completion
  request returns, and the next dispatch cycle delivers it.
- AC-10: GIVEN B's edge onto A is merge-gated (A's worker has an open PR), WHEN
  A completes, THEN B is not woken; and WHEN the PR merges, THEN B is woken
  within one dispatch cycle.
- AC-11: GIVEN A was live and B is deferred on it, WHEN A's worker fails and A
  returns to `pending`, THEN B gets a wake and claims on its next poll.
- AC-12: GIVEN B defers on a soft overlap with an unstarted A that holds no
  lease, WHEN the waiters are registered, THEN no immediate wake is enqueued
  for B.
- AC-13 (regression, #3446): releasing a lease still stamps the waiter and
  enqueues `path_claim.released` in the same statement.

**Code surface.** Helpers: `checkDependsOnResolved`, `enqueueReadyDependents`,
`runMergedPrWork`, `registerClaimDeferralWaiters`,
`findPendingTasksWithResolvedDepsAndNoWake`, `kickDispatch`.

**Out of scope.** Pusher delivery, runner poll intervals, the outbox itself.

## Capability 3: a claimable task that nobody claims is reported

**Capability statement.** A pending task that passes every claim gate but is
not being claimed while runner capacity is free is reported with the reason.
A hold that names a non-live holder is reported as a false hold.

**Invariants**

- I3.1 **Unclaimed claimable**: pending, `startAt` past or unset, dependency
  gate satisfied, no hold from a live holder, no claim-loop gate event and no
  worker for 2 hours, and at least one online runner that serves the workspace
  and the task's role had a free slot during that window.
- I3.2 **False hold**: a candidate deferred for 2 hours or more where every
  holder named in its deferrals is non-live (unstarted, future `startAt`, or a
  cross-base refresh PR). After Capability 1 ships this is a defect signal, not
  a state.
- I3.3 **Parked**: a pending task with a future `startAt` is never reported as
  starved; explain says "scheduled to start at T" and names who set it.
- I3.4 Both signals surface in explain's `because` list and as Failure Pattern
  Sentinel incidents with their own rule and reason code, grouped by holder
  task when there is no blocker PR.
- I3.5 The existing `checkStarvation` mission note keeps running and is
  superseded for these shapes by I3.4, not deleted.

**Acceptance criteria**

- AC-14: GIVEN a pending task with a future `startAt`, WHEN explain runs, THEN
  the task is reported as parked with its start time, and no Sentinel incident
  is raised for it.
- AC-15: GIVEN a candidate deferred for 2 hours on a soft overlap whose holder
  has a future `startAt` (the 2026-10-11 shape), WHEN the Sentinel sweeps, THEN
  a false-hold incident names the candidate, the holder and the reason "holder
  never started".
- AC-16: GIVEN a claimable pending task with no gate event for 2 hours and a
  runner that reported a free slot for the workspace, WHEN the Sentinel sweeps,
  THEN an unclaimed-claimable incident is raised; and GIVEN no runner had a free
  slot, THEN none is.
- AC-17: GIVEN the same task, WHEN explain runs, THEN its first `because` names
  the reason (for example "no runner serving role builder was online") instead
  of "dispatch a worker".

**Code surface.** Route: `/api/explain`. Helpers: `explainTask`,
`buildCoordinationHolds`, `detectFailurePatterns`, `checkStarvation`.

**Out of scope.** Paging policy for the new incidents (they start at the same
severity tier as `path_overlap_stall`). Auto-recovery.

## Capability 4: a runner that stops claiming says so

**Capability statement.** A runner that halts claims reports it on its
heartbeat, and list_runners, explain and the task page show it instead of a
plain "pending".

**Invariants**

- I4.1 Draining for an update stops new claims. That is required: a runner that
  kept claiming would never become idle and never apply the update.
- I4.2 A drain lasts at most `DEFAULT_DRAIN_WINDOW_MIN` (60 minutes, overridable
  per runner by its drain-window environment variable). At the deadline the
  update applies and in-flight sessions are treated as an infra termination,
  as `UpdateDrain` already does. An idle runner applies at once.
- I4.3 The heartbeat carries the claim state: halted or not, the reason
  (`update_drain`, or any other reason the runner halts claims for), when it
  started, and the drain deadline. It is stored in the heartbeat's
  `environment` JSON, so no schema migration is needed.
- I4.4 list_runners prints the claim state per runner. A runner whose claims are
  halted does not count as free capacity for I3.1.
- I4.5 explain and the task page, for a pending task whose only eligible
  runners all have claims halted, say "runner R stopped claiming at T to drain
  for an update; it resumes by T+window".
- I4.6 A heartbeat older than the runner-liveness threshold shows the runner as
  offline, not draining.

**Acceptance criteria**

- AC-18: GIVEN a runner with an update available and busy workers, WHEN it
  heartbeats, THEN the stored claim state is halted with reason `update_drain`
  and a deadline 60 minutes after the drain started.
- AC-19: GIVEN that runner is the only one serving the workspace, WHEN explain
  runs for a claimable pending task, THEN the first `because` names the drain
  and its deadline.
- AC-20: GIVEN the drain is cancelled (update no longer eligible), WHEN the next
  heartbeat lands, THEN the claim state clears and list_runners shows it
  claiming.
- AC-21: GIVEN a runner build that sends no claim state, WHEN list_runners runs,
  THEN the field reads "unknown", not "claiming".

**Code surface.** Routes: `/api/workers/heartbeat`, `/api/workers/active`.
Data model: `worker_heartbeats.environment`. Helpers: `UpdateDrain`,
`readDrainConfig`, `runListRunners`, `explainTask`.

**Out of scope.** Changing the drain window default. Rolling updates across
several runners.

## Capability 5: one-time repair of stored edges

**Capability statement.** Pending rows that already carry inferred edges onto
unstarted holders are converted to soft overlaps once, so the stored row,
explain and the claim gate agree.

**Invariants**

- I5.1 Only ids listed in `pathDeclaration.inferredDependsOn` are touched. A
  declared edge is never moved, even when its holder is unstarted.
- I5.2 For a pending task T and an inferred edge onto holder H that is an
  unstarted holder at repair time: remove H from `dependsOn` and from
  `inferredDependsOn`, append `{ taskId: H, paths: [], kind: 'legacy_inferred' }`
  to `softOverlaps` (the soft gate reclassifies against current manifests, as
  for 0267), and set `overlapPolicy` to `v2`.
- I5.3 The write is a compare-and-set on `dependsOn` and `pathDeclaration`, as
  `reconcilePendingRepairEdges` does, so a concurrent edit wins and the row is
  retried on the next run. Running it twice changes nothing the second time.
- I5.4 It runs as code in the maintenance cron, not as a drizzle migration, so
  it does not take the migration lane it is repairing. Each converted task gets
  a `dependency.satisfied` wake.
- I5.5 It runs only after Capability 1's soft-gate rule is deployed; before
  that, a `legacy_inferred` migration overlap is still a deterministic hold.

**Acceptance criteria**

- AC-22: GIVEN T with one declared edge and one inferred edge, both onto
  unstarted holders, WHEN the repair runs, THEN only the inferred edge moves.
- AC-23: GIVEN T with an inferred edge onto a live holder, WHEN the repair runs,
  THEN T is unchanged.
- AC-24: GIVEN the repair has run, WHEN it runs again, THEN it writes no row.
- AC-25: GIVEN T's `pathDeclaration` changes between the repair's read and
  write, WHEN the repair writes, THEN the write is skipped and T is unchanged.

**Code surface.** Route: the maintenance cron under `/api/cron/maintenance`.
Helpers: `reconcilePendingRepairEdges` (model), `enqueueReadyDependents`.

**Out of scope.** Non-pending rows. Rows written by 0267 or 0282 (already v2;
the repair still applies to their remaining inferred edges by I5.2).

## Rollout and bootstrap

This fix must not queue behind the jam it fixes.

1. Capability 1 ships first. Its manifest names no migration, schema or hard
   surface path, so its own claim cannot take a migration hold. It lands on
   `dev`.
2. The claim route runs on the deployed web app, which deploys only from
   `main`. The fix takes effect only after a release PR (`dev` → `main`)
   merges. The release is a planned step, merged by the owner.
3. Capabilities 2 to 5 follow in the next release. Capability 5 needs no
   migration (I5.4), so it is not ordered behind schema work either.
4. Runner-side changes (Capability 4's heartbeat field) reach the runner only
   when it self-updates from `main`, which itself goes through the drain in
   Capability 4.
