---
title: Claim Overlap Scheduling
status: draft
owner: max
last_verified: 2026-10-23
summary: Overlapping work MUST start by default, undeclared scope included; an overlap holds a claim only on an unmergeable surface (one list in code, migrations, hard surfaces) and only while its holder is live.
domain: tasks
surfaces: [apps/web/src/app/api/workers/claim/overlap-policy.ts, packages/core/unmergeable-surfaces.ts, apps/web/src/app/api/workers/claim/start-lease.ts, apps/web/src/app/api/workers/claim/deps-gate.ts]
related: [path-claim-ownership, orchestration-decisions-shadow, force-start, task-dispatch-authority, claim-ordering, runner-liveness]
keywords: [unmergeable surface, overlap start, undeclared scope, scope_undeclared_mutex, advisory_manifest, no_scope_mutex, soft_overlap_start, path_overlap, soft_overlap, inferredDependsOn, softOverlaps, legacy_inferred, unstarted holder, schema lane, migration lane, starvation, claim_loop_deferral, update drain, claims halted, dependency.satisfied]
verified_by: [packages/core/__tests__/unmergeable-surfaces.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/tests/db/undeclared-scope-starts.test.ts, packages/core/__tests__/claim-planner.test.ts, apps/web/src/app/api/workers/claim/claim-plan-input.test.ts, apps/web/src/app/api/workers/claim/coordination-gates.test.ts, apps/web/src/app/api/workers/claim/deps-gate.test.ts, apps/web/src/app/api/workers/claim/start-lease.test.ts, apps/web/src/app/api/workers/claim/open-pr-target-base.test.ts, apps/web/src/lib/explain-coordination.test.ts, packages/core/__tests__/orchestration-soft-start-readout.test.ts, apps/web/src/lib/orchestration-decision-stats-query.test.ts, apps/web/src/lib/claim-order-queue.test.ts, apps/runner/__tests__/unit/top-queue.test.ts, packages/core/__tests__/dispatch-dependents.test.ts, apps/web/src/lib/conflict-retry.test.ts]
assertions:
  - id: open-pr-overlap-policy
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: symbol
    name: findHoldingOpenPr
    path: apps/web/src/app/api/workers/claim/overlap-policy.ts
  - id: claim-route
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: route
    method: POST
    path: "/api/workers/claim"
    file: apps/web/src/app/api/workers/claim/route.ts
---

# Claim Overlap Scheduling

Two tasks that touch the same files start together by default, and the merge
settles the overlap (runner pre-merge with mergiraf, mission refresh, the
conflict resolver). An overlap holds a claim only when the shared paths are an
**unmergeable surface**, where the merge tooling cannot settle a conflict, and
only while the holder is live work. A task that has not started is editing
nothing and holds no one, and a task that declares no files is not held for
that: scope makes the policy more precise, it is never a condition to start. Every overlap hold says what it is waiting on, every
overlap start is recorded with its paths, and no model is asked.

Being replaced by the living spec *Overlap scheduling: serial lanes and file
locks*. Already in effect from it (R-1 to R-3): nothing is guessed at creation
(no inferred edge, no soft overlap), a stored soft overlap holds nothing, a
live lease holds at claim only on an unmergeable path whatever the
workspace's lease enforcement, and the HOLD/START model is not asked.

## Terms

- **Inferred edge**: an id in `tasks.dependsOn` that is also listed in
  `pathDeclaration.inferredDependsOn`, on older rows only: task creation and
  conflict retry no longer write them. Every other id in `dependsOn` is a
  **declared edge**.
- **Soft overlap**: an entry in `pathDeclaration.softOverlaps` on older rows,
  never a dependsOn edge, and it holds nothing at claim.
- **Live holder**: a task that, right now, has a worker in
  `LIVE_WORKER_STATUSES`, an active `path_claims` lease, or a worker whose PR is
  open and unmerged on the candidate's landing base.
- **Unstarted holder**: a `pending` task that is not a live holder. A pending
  task whose `startAt` is in the future, or whose mission is held, is always
  unstarted.
- **Unmergeable surface**: a path on the list in
  `packages/core/unmergeable-surfaces.ts` (`UNMERGEABLE_SURFACES`), any
  migration or schema path in any repo (`isMigrationPath`), or a workspace hard
  surface (serialized surface, `derivedFiles` generated file, `overlapHotspots`
  entry: `lib/hard-overlap-surfaces.ts`).
- **Hard-class path**: a path on an unmergeable surface.
- **Mergeable overlap**: an overlap whose shared paths touch no unmergeable
  surface.
- **Overlap START**: a claim that proceeds past an overlap with a live or
  unstarted holder instead of deferring on it.

## Claim route: overlap gates (`POST /api/workers/claim`)

**Statement.** Each overlap gate (open PR, live lease) asks the
one overlap policy (`claim/overlap-policy.ts`). A mergeable overlap STARTs. An
overlap on an unmergeable surface holds while its holder is live.

**Invariants**

- I-1 A declared edge is never lifted, converted or skipped by any rule in
  this spec.
- I-2 An inferred edge onto an unstarted holder does not hold the candidate at
  claim (deps gate, explain, and the dashboard Start probe answer the same).
- I-3 A soft overlap holds nothing at claim, on any surface; the Start probe
  reports none.
- I-4 A claim whose manifest contains a hard-class path, and which starts
  alongside an open PR on mergeable files, acquires those paths (and only
  those) through `acquireStartPaths` before the atomic claim UPDATE,
  all-or-nothing. If
  the acquire fails the candidate defers as `path_overlap` and registers a
  waiter on the lease holder. If the UPDATE loses the race the lease is given
  back.
- I-5 An open PR into a different landing base whose task is a trunk → mission
  branch refresh never blocks a candidate landing on trunk at layer 1, migration
  paths included. Every other cross-base migration carve-out in
  `partitionOpenPrsByLandingBase` is unchanged.
- I-6 At creation (task route, conflict retry and the migration-collision
  retry) nothing is inferred from overlapping manifests: `dependsOn` holds only
  the caller's ids, and no `softOverlaps` or `inferredDependsOn` is written.
- I-27 The unmergeable list is one list in code, `UNMERGEABLE_SURFACES`, with a
  reason per entry: `packages/core/drizzle/**`, `packages/core/db/schema.ts`,
  the lockfiles `bun.lock`, `bun.lockb`, `package-lock.json`, `yarn.lock`,
  `pnpm-lock.yaml`, `Cargo.lock`, `poetry.lock`, `Gemfile.lock` and `go.sum` at
  any depth, `docs/specs/INDEX.md`, `*.snap` at any depth, and `next-env.d.ts`
  at any depth. A pattern ending `/**` covers the directory and everything
  under it; a pattern with no `/` matches the basename at any depth.
- I-28 Layer 1 (open PR on the same landing base) and layer 2 (live lease)
  START on a mergeable overlap. Layer 1 holds only when some
  overlapping open PR (not just the first) shares an unmergeable path, and the
  deferral names that PR.
- I-29 `gitConfig.pathClaimEnforcement: 'enforce'` changes nothing at claim:
  a live lease on a mergeable file does not hold there either. It denies the
  second edit at edit time (409 + waiter), which is where the lock applies.
- I-30 No model is asked about an overlap at claim, and no applied-START
  ledger is read. Earlier `orchestration_claim` decision rows stay readable.
- I-31 A holder that cannot start itself (`holderCannotStart`: pending with a
  future `startAt`, in a held mission, or held by a person) never holds
  through any overlap kind, on any surface: the open-PR and lease checks skip
  the task ids `loadIdleHolderIds` returns. A failed read of that state leaves every hold standing.
- I-32 Fix attempts of one PR (conflict, CI, review) resume on that PR's
  branch: they never wait on their own PR, a PR stacked on it, or their own
  lineage's leases. The PR itself is what serializes them.
- I-33 Every overlap START is recorded once the claim wins, as one accepted
  `soft_overlap_start` row on the `claim_loop_deferral` gate per holder, with
  `gate` (`open_pr_overlap` or `lease_overlap`), the holder task, the PR number
  for an open PR, the shared paths (bounded), the overlap kind, `areaClass` and
  `decidedBy: 'rule'`. Older rows also carry `soft_overlap`.

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
  (deterministic hold).
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
- AC-8 (regressions): the own-PR, subject-PR and stacked-PR exemptions and the
  migration hold on an open PR or a live lease keep their tests green.
- AC-26: GIVEN two pending tasks A and B that both declare
  `apps/web/src/lib/x.ts`, B carrying a soft overlap onto A, WHEN a runner with
  two free slots polls, THEN both are claimed in that poll and neither is
  ordered behind the other.
- AC-27: GIVEN an open PR on `packages/core/drizzle/0300_x.sql`, WHEN a
  candidate on the same file polls, THEN it defers as `path_overlap` and
  nothing is leased for it.
- AC-28: GIVEN a candidate carrying a stored soft overlap onto a running holder
  on the same migration file, WHEN it polls, THEN it is claimed and no
  `soft_overlap` deferral is written.
- AC-28b: GIVEN an open PR or a live lease on an unmergeable file whose task is
  pending with a future `startAt`, WHEN a candidate on that file polls, THEN it
  is claimed; and GIVEN that holder state cannot be read, THEN it defers as
  `path_overlap`.
- AC-29: GIVEN an open PR whose task declares `apps/web/src/lib/x.ts`, WHEN a
  candidate declaring the same file polls, THEN it is claimed and a
  `soft_overlap_start` row records `gate: open_pr_overlap`, the PR number, the
  holder task and the path.
- AC-30: GIVEN a candidate overlapping one open PR on a mergeable file and a
  second on `packages/core/db/schema.ts`, WHEN it polls, THEN it defers as
  `path_overlap` naming the second PR.
- AC-31: GIVEN two pending tasks sharing `apps/web/src/lib/x.ts`, WHEN a task
  for each is created, THEN neither carries a `dependsOn` or `softOverlaps`
  entry for the other.
- AC-32: GIVEN a live lease on `apps/web/src/lib/widget.ts`, WHEN a candidate on
  that file polls, THEN it is claimed and a `lease_overlap` start is recorded;
  and GIVEN a live lease on `apps/web/bun.lock`, THEN a candidate on it defers
  as `path_overlap`; and GIVEN `pathClaimEnforcement: 'enforce'`, THEN the
  mergeable lease still does not hold.
- AC-33: GIVEN a START whose manifest is `apps/web/src/lib/` and `bun.lock`,
  WHEN it claims, THEN only `bun.lock` is acquired up front, and a refused
  acquire holds the task.
- AC-34: GIVEN an open-PR overlap on an unmergeable file, WHEN the candidate
  polls, THEN it defers and no decision is scheduled.

**Code surface.** Route: `/api/workers/claim`. Data model: `tasks.dependsOn`,
`tasks.pathDeclaration` (`inferredDependsOn`, `softOverlaps`), `path_claims`,
`gate_events`. Helpers: `UNMERGEABLE_SURFACES`, `unmergeableSurfaceOf`,
`overlapHolds`, `findHoldingOpenPr`, `findHoldingLease`, `exclusiveStartPaths`,
`holderCannotStart`, `loadIdleHolderIds`,
`depsGate`, `partitionOpenPrsByLandingBase`, `acquireStartPaths`,
`buildCoordinationHolds`.

**Out of scope.** Edit-time lease enforcement on the runner
(`path-claim-ownership`). Changing Jev thresholds. Any change to declared
dependencies. Asking a model about overlap at claim (removed).

## Claim planner (`planClaimBatch`, `buildClaimPlanInput`)

**Statement.** The batch planner never orders a task behind work it would only
share mergeable files with.

**Invariants**

- I-34 `ClaimPlanInput.overlapHolds` is the claim route's overlap policy. A
  concrete overlap (candidate, in-batch peer, open PR or live lease) is a hard
  edge only when it answers true for the shared paths of both sides; absent,
  every concrete overlap is a hard edge.
- I-35 For a live lease, `overlapHolds` answers as for any other overlap,
  whatever the workspace's lease enforcement (I-29).

**Acceptance criteria**

- AC-35: GIVEN a candidate sharing `src/x.ts` with an open PR, a live lease and
  a task claimed earlier in the batch, WHEN the plan is built, THEN the
  candidate is picked.
- AC-36: GIVEN a candidate declaring `src` and a live lease on `src/bun.lock`,
  WHEN the plan is built, THEN the candidate is ordered behind the lease and
  `overlapHolds` saw both sides' paths.

**Code surface.** Helpers: `planClaimBatch`, `buildClaimPlanInput`.

**Out of scope.** Soft (predicted-scope) planner edges.

## Undeclared scope (`POST /api/workers/claim`, `planClaimBatch`)

**Statement.** A task that declares no files (`pathManifest` null, `[]` or
`['**']`) starts like any other. It runs in its own worktree on its own branch,
and the merge settles an overlap. No gate holds it for having no scope, in the
claim loop, the planner or the Start probe.

**Invariants**

- I-46 The claim loop has no scope-undeclared serialization. A scope-undeclared
  candidate is never deferred because another scope-undeclared task of its
  mission is in flight or was claimed earlier in the same poll. The
  `advisory_manifest` deferral (shown as `scope_undeclared_mutex`) is retired:
  nothing writes it, and its diagnostics counter stays at 0 for older readers.
- I-47 The planner adds no edge for a node with no usable scope. A
  scope-undeclared in-flight worker is not a planner node, and no prediction,
  confident or weak, orders undeclared work behind undeclared work.
- I-48 What still holds undeclared work is what holds any work: a declared
  dependency, an explicit hold (held mission, future `startAt`, a person's
  hold), the mission and workspace caps, runner, auth and budget limits, and
  one open fix attempt per PR (`sibling_retry_open`, the same-branch rule).
  Nothing is leased for it up front: it declares no path, so I-4 has nothing
  to acquire. Paths it is seen editing are leased after its first sync, and a
  later candidate that declares one of them holds on that lease if it is
  unmergeable (I-28). Two undeclared tasks can therefore both edit an
  unmergeable surface, a migration included, where the workspace leases are
  advisory (the default): the edit is reported, not denied. The merge step
  (runner pre-merge, the migration layout and commute checks) and CI catch
  that collision. A workspace that sets `pathClaimEnforcement: 'enforce'`
  denies the second edit instead (I-29).
- I-49 The model is not asked about undeclared scope: there is no
  hold/start note for it and no applied-START lookup. A decision row whose
  answering model has no stored measurement is recorded as `suggested` with
  reason `non_jev` and the rule's answer in effect; only an `applied` row
  counts as applied in `get_decision_stats` (`byAppliedAnswer`).

**Acceptance criteria**

- AC-40: GIVEN two pending scope-undeclared tasks of one mission and a runner
  with two free slots, WHEN it polls, THEN both are claimed in that poll.
- AC-41: GIVEN a scope-undeclared task of a mission with a running
  scope-undeclared sibling, WHEN it is claimed, THEN it starts and no
  `advisory_manifest` deferral is counted.
- AC-42: GIVEN a CI repair with no manifest and an unrelated running task with
  no manifest in its mission, WHEN the repair is claimed, THEN it starts.
- AC-43: GIVEN a task whose ledger holds earlier `advisory_manifest` deferrals
  and nothing else holding it, WHEN a runner polls, THEN it is claimed.
- AC-44: GIVEN a live lease on `packages/core/db/schema.ts`, WHEN a candidate on
  that file is claimed, THEN it defers as `path_overlap`; and GIVEN a declared
  dependency on unfinished work, or a mission cap that is full, THEN an
  undeclared candidate stays pending.
- AC-45: GIVEN a suggested START with reason `non_jev`, one with
  `below_threshold` and one applied START, WHEN the ledger is summarized, THEN
  it reports two suggested and one applied, and only the applied one under
  `byAppliedAnswer.START`.

**Code surface.** Route: `/api/workers/claim`. Helpers: `planClaimBatch`,
`buildClaimPlanInput`, `evaluateCoordinationGates`,
`summarizeOrchestrationDecisions`.

**Out of scope.** The task-page wording for waits. Scope inference and
manifest inheritance for repairs (they add precision and stay).

## Measurement (`get_decision_stats`)

**Statement.** The share of overlap STARTs whose PR later hit a merge conflict
is readable by gate and area class.

**Invariants**

- I-36 The soft-start readout (`orchestration-soft-start-readout.ts`, loaded by
  `loadSoftStartReadoutInput`) reads every `soft_overlap_start` row of I-33 and
  grades it on the shared outcome labeller (conflict retry created, path
  collision, merge-base refusal), grouped by `gate` and `areaClass`.
  `summarizeOverlapStartConflicts` reports, per area class and per gate in it,
  the share of those STARTs whose PR later got a conflict retry
  (`conflicted / observed`; a start still running is `pending`, in neither).
  `get_decision_stats` without a capability returns it as `overlapStarts`
  (absent with a `missionId` filter; `overlapStartsError` when the read fails).

**Acceptance criteria**

- AC-37: GIVEN an open-PR overlap START recorded with `gate: open_pr_overlap`
  and `areaClass: other`, WHEN the readout loads, THEN it is graded in the
  `open_pr_overlap` / `other` cell.

**Code surface.** Helpers: `loadSoftStartReadoutInput`,
`summarizeSoftStartReadout`, `summarizeOverlapStartConflicts`,
`fetchOrchestrationDecisionStats`.

## Explain, the Start probe and the Failure Pattern Sentinel

**Statement.** Explain and the dashboard Start probe report exactly the holds
the claim would apply. A claimable task nobody claims, and a hold that names a
non-live holder, are reported with the reason.

**Invariants**

- I-37 The coordination probe (`evaluateCoordinationGates`) uses the claim's
  overlap policy: a mergeable overlap with an open PR or a live lease is not a
  waiting reason, and a stored soft overlap never is.
- I-38 When a task started past an overlap, explain and the runner's top Queue
  say "starts alongside #n (same files, merges at the end)", naming the PR or
  holder. Explain reads it from the task's newest claim's `soft_overlap_start`
  rows (`overlapStartLink`). top's Queue reads it from the queue read's
  `alongside` field (`queueAlongside`: the first open PR, else live lease, a
  queued task shares only mergeable files with) and shows it under the
  selected row; a row something holds says what it waits for instead.
- I-11 **Unclaimed claimable**: pending, `startAt` past or unset, dependency
  gate satisfied, no hold from a live holder, no claim-loop gate event and no
  worker for 2 hours, and at least one online runner that serves the workspace
  and the task's role had a free slot during that window.
- I-12 **False hold**: a candidate deferred for 2 hours or more where every
  holder named in its deferrals is non-live (unstarted, future `startAt`, or a
  cross-base refresh PR). This is a defect signal, not a state.
- I-13 **Parked**: a pending task with a future `startAt` is never reported as
  starved; explain says "scheduled to start at T" and names who set it.
- I-14 Both signals surface in explain's `because` list and as Failure Pattern
  Sentinel incidents with their own rule and reason code, grouped by holder
  task when there is no blocker PR.
- I-15 The `checkStarvation` mission note keeps running and is superseded for
  these shapes by I-14, not deleted.

**Acceptance criteria**

- AC-14: GIVEN a pending task with a future `startAt`, WHEN explain runs, THEN
  the task is reported as parked with its start time, and no Sentinel incident
  is raised for it.
- AC-15: GIVEN a candidate deferred for 2 hours on a soft overlap whose holder
  has a future `startAt`, WHEN the Sentinel sweeps, THEN a false-hold incident
  names the candidate, the holder and the reason "holder never started".
- AC-16: GIVEN a claimable pending task with no gate event for 2 hours and a
  runner that reported a free slot for the workspace, WHEN the Sentinel sweeps,
  THEN an unclaimed-claimable incident is raised; and GIVEN no runner had a free
  slot, THEN none is.
- AC-17: GIVEN the same task, WHEN explain runs, THEN its first `because` names
  the reason (for example "no runner serving role builder was online") instead
  of "dispatch a worker".
- AC-38: GIVEN a task whose only overlap is an open PR on a mergeable file,
  WHEN the Start probe runs, THEN it lists no coordination reason.
- AC-39: GIVEN a task that started alongside PR #n, WHEN explain runs or top
  renders its Queue, THEN the line reads "starts alongside #n (same files,
  merges at the end)".

**Code surface.** Route: `/api/explain`. Helpers: `explainTask`,
`evaluateCoordinationGates`, `buildCoordinationHolds`,
`overlapStartLink`, `queueAlongside`,
`detectFailurePatterns`, `checkStarvation`.

**Out of scope.** Paging policy for the new incidents (they start at the same
severity tier as `path_overlap_stall`). Auto-recovery.

## Wakes: completion and merge

**Statement.** Every event that can satisfy a hold enqueues a dispatch wake for
each pending task it held, through the existing outbox. A wake re-runs the
claim gate; it never bypasses it.

**Invariants**

- I-7 Task completion calls `checkDependsOnResolved`, which wakes dependents
  through `enqueueReadyDependents` with `depsGate`. A merged PR does the same
  through `runMergedPrWork`. Both stay the only wake paths for edges.
- I-8 A holder leaving live state (its worker fails, is detached or re-queues
  the task to `pending` with no open PR) enqueues a `dependency.satisfied` wake
  for each pending task holding an inferred edge or soft overlap onto it,
  since I-2 then releases them.
- I-9 A waiter is woken immediately at registration only when the blocker's
  lease was released after the deferral read it. A deferral against a holder
  that holds no lease does not wake itself.
- I-10 The repair sweep `findPendingTasksWithResolvedDepsAndNoWake` uses the same
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
- AC-13 (regression): releasing a lease still stamps the waiter and enqueues
  `path_claim.released` in the same statement.

**Code surface.** Helpers: `checkDependsOnResolved`, `enqueueReadyDependents`,
`runMergedPrWork`, `registerClaimDeferralWaiters`,
`findPendingTasksWithResolvedDepsAndNoWake`, `kickDispatch`.

**Out of scope.** Pusher delivery, runner poll intervals, the outbox itself.

## Runner heartbeat and `list_runners`

**Statement.** A runner that halts claims reports it on its heartbeat, and
list_runners, explain and the task page show it instead of a plain "pending".

**Invariants**

- I-16 Draining for an update stops new claims: a runner that kept claiming
  would never become idle and never apply the update.
- I-17 A drain lasts at most `DEFAULT_DRAIN_WINDOW_MIN` (60 minutes, overridable
  per runner by its drain-window environment variable). At the deadline the
  update applies and in-flight sessions are treated as an infra termination,
  as `UpdateDrain` does. An idle runner applies at once.
- I-18 The heartbeat carries the claim state: halted or not, the reason
  (`update_drain`, or any other reason the runner halts claims for), when it
  started, and the drain deadline. It is stored in the heartbeat's
  `environment` JSON.
- I-19 list_runners prints the claim state per runner. A runner whose claims are
  halted does not count as free capacity for I-11.
- I-20 explain and the task page, for a pending task whose only eligible
  runners all have claims halted, say "runner R stopped claiming at T to drain
  for an update; it resumes by T+window".
- I-21 A heartbeat older than the runner-liveness threshold shows the runner as
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

## Maintenance cron: repair of stored edges (`/api/cron/maintenance`)

**Statement.** Pending rows that carry inferred edges onto unstarted holders
are converted to soft overlaps once, so the stored row, explain and the claim
gate agree.

**Invariants**

- I-22 Only ids listed in `pathDeclaration.inferredDependsOn` are touched. A
  declared edge is never moved, even when its holder is unstarted.
- I-23 For a pending task T and an inferred edge onto holder H that is an
  unstarted holder at repair time: remove H from `dependsOn` and from
  `inferredDependsOn`, append `{ taskId: H, paths: [], kind: 'legacy_inferred' }`
  to `softOverlaps` (the soft gate reclassifies against current manifests), and
  set `overlapPolicy` to `v2`.
- I-24 The write is a compare-and-set on `dependsOn` and `pathDeclaration`, as
  `reconcilePendingRepairEdges` does, so a concurrent edit wins and the row is
  retried on the next run. Running it twice changes nothing the second time.
- I-25 It runs as code in the maintenance cron, not as a drizzle migration, so
  it does not take the migration lane it is repairing. Each converted task gets
  a `dependency.satisfied` wake.
- I-26 It runs only where the claim route already applies I-2 to
  `legacy_inferred` soft overlaps.

**Acceptance criteria**

- AC-22: GIVEN T with one declared edge and one inferred edge, both onto
  unstarted holders, WHEN the repair runs, THEN only the inferred edge moves.
- AC-23: GIVEN T with an inferred edge onto a live holder, WHEN the repair runs,
  THEN T is unchanged.
- AC-24: GIVEN the repair has run, WHEN it runs again, THEN it writes no row.
- AC-25: GIVEN T's `pathDeclaration` changes between the repair's read and
  write, WHEN the repair writes, THEN the write is skipped and T is unchanged.

**Code surface.** Helpers: `reconcilePendingRepairEdges` (model),
`enqueueReadyDependents`.

**Out of scope.** Non-pending rows. Rows already at `overlapPolicy: v2` keep
any remaining inferred edges subject to I-23.

## Deployment constraints

- The claim route runs on the deployed web app, which deploys only from
  `main`: a claim-route rule takes effect only after a release.
- A claim-route change whose own manifest names no unmergeable surface cannot
  take an overlap hold on its own claim.
- Runner-side changes (the heartbeat claim state, top's Queue line) reach a
  runner only when it self-updates from `main`, through the drain above.
