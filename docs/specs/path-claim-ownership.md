---
title: Path Claim Ownership
status: active
owner: max
last_verified: 2026-10-07
summary: Edit leases MUST be acquired exclusively per workspace, narrowed only by their owner, released on terminal status, kept equal to a task's current owned file set by an authoritative delta/ACK protocol, proven complete before any ship, handed to the open PR when the worker ends, and reconciled to a PR's pinned actual diff without ever treating missing data as an empty diff.
domain: tasks
surfaces: [packages/core/path-claim.ts, packages/core/working-set.ts, packages/core/path-coordination-signal.ts, apps/web/src/lib/path-claim-check.ts, apps/web/src/lib/path-claim-release.ts, apps/web/src/lib/pr-scope-reconcile.ts, apps/web/src/lib/working-set-sync.ts, apps/runner/src/working-set.ts, apps/runner/src/ship-checkpoint.ts]
related: [orchestration-decisions-shadow, mission-task-lifecycle, claim-ordering]
keywords: [path_claims, check_path_claim, lease, narrow, pathManifest, path_declaration, path_claim_revision, waiter, retry scope, working set, ship checkpoint, observedTouches, coverage_unknown_at_ship, observation_truncated]
verified_by: [packages/core/__tests__/path-claim-ownership.test.ts, packages/core/__tests__/working-set-reconcile.test.ts, packages/core/__tests__/path-coordination-signal.test.ts, apps/web/src/lib/working-set-sync.test.ts, apps/runner/__tests__/unit/working-set-tracker.test.ts, apps/runner/__tests__/unit/ship-checkpoint.test.ts, apps/runner/__tests__/unit/path-claim-hook.test.ts, apps/web/src/lib/pr-scope-reconcile.test.ts, apps/web/src/app/api/tasks/[id]/path-claim/route.test.ts, apps/web/src/lib/approve-plan.test.ts]
assertions:
  - id: "acquire-path-claims"
    type: "symbol"
    name: "acquirePathClaims"
    path: "packages/core/path-claim.ts"
  - id: "narrow-path-claims"
    type: "symbol"
    name: "narrowPathClaims"
    path: "packages/core/path-claim.ts"
  - id: "release-claims"
    type: "symbol"
    name: "releaseClaims"
    path: "packages/core/path-claim.ts"
  - id: "reconcile-working-set"
    type: "symbol"
    name: "reconcileWorkingSet"
    path: "packages/core/working-set.ts"
  - id: "promote-leases-to-pr-scope"
    type: "symbol"
    name: "promoteLeasesToPrScope"
    path: "packages/core/working-set.ts"
  - id: "classify-path-coordination-event"
    type: "symbol"
    name: "classifyPathCoordinationEvent"
    path: "packages/core/path-coordination-signal.ts"
  - id: "run-ship-checkpoint"
    type: "symbol"
    name: "runShipCheckpoint"
    path: "apps/runner/src/ship-checkpoint.ts"
  - id: "reconcile-pr-scope"
    type: "symbol"
    name: "reconcilePrBackedScope"
    path: "apps/web/src/lib/pr-scope-reconcile.ts"
  - id: "release-notify-uses-release"
    type: "symbol_reachable"
    symbol: "releaseClaims"
    entry: "apps/web/src/lib/path-claim-release.ts"
    as: "call"
  - id: "worker-patch-applies-working-set"
    type: "symbol_reachable"
    symbol: "applyWorkingSetSync"
    entry: "apps/web/src/app/api/workers/[id]/route.ts"
    as: "call"
  - id: "path-claim-ownership-test"
    type: "test_file"
    path: "packages/core/__tests__/path-claim-ownership.test.ts"
  - id: "working-set-reconcile-test"
    type: "test_file"
    path: "packages/core/__tests__/working-set-reconcile.test.ts"
  - id: "ship-checkpoint-test"
    type: "test_file"
    path: "apps/runner/__tests__/unit/ship-checkpoint.test.ts"
  - id: "pr-scope-reconcile-test"
    type: "test_file"
    path: "apps/web/src/lib/pr-scope-reconcile.test.ts"
supersedes: []
---
# Path Claim Ownership

**Capability statement**: Buildd MUST let at most one open task hold an edit
lease on any overlapping path in a workspace. Acquisition, narrowing and
release are serialized on the same ownership revision. The set of leases a
task holds MUST equal its current owned file set, and at any ship boundary
buildd MUST either know that set is completely coordinated or refuse the ship.
On by default, no flag.

**Core invariant (ship boundary)**: before a `git push`, `gh pr create`,
`create_pr` or a successful `complete_task`, the runner recomputes the task's
whole owned file set from git, reconciles it with the server, and proceeds
only on a server ACK proving complete coverage for that generation. A blocked
path defers with its holder named. A coordinator that is unreachable, or does
not answer, after bounded retries is **coverage unknown**, and in enforce mode
the ship is refused — never let through. A bounded UI/debug history may be
incomplete without weakening this.

**Three sets, three jobs**:

- `path_claims` — the **authoritative current working set**. Leases are what
  coordination is decided on. Live leases are deterministic hard rails;
  scheduling policy (Jev, force, inferred edges) may bypass claim-time
  ordering, never an edit-time lease.
- `tasks.pathManifest` — **scheduling intent** (and, after a PR handoff, the
  open PR's changed-file scope). Not runtime ownership truth.
- `workers.observedTouches` — a **bounded diagnostic sample** for the
  dashboard and explain. Capped (`OBSERVED_TOUCHES_CAP`); hitting the cap is
  an `observation_truncated` advisory, fired once per worker, and never a
  loss of coverage. It is not a safety boundary.

**Protocol**:

- *Runner tracker* (`apps/runner/src/working-set.ts`): the owned set is the
  branch-owned diff from the merge-base with the resolved PR base plus staged,
  unstaged and untracked changes, minus runtime exclusions, the repo-wide
  sentinel and regenerable files (`leasablePaths`). It carries a monotonic
  generation. Every sync tick sends only the **delta** since the server's last
  ACK — at most `WORKING_SET_CHUNK` paths per side — and the steady state
  sends nothing. A sweep that could not see the whole set (git error, a
  configured base that did not resolve) may only add paths, never remove
  them. A restart replays from persisted local state plus the server's held
  list (`includeHeld`), seeding only the intersection with the current sweep
  so a declared lease outside it is never "removed" by the tracker.
- *Server reconcile* (`reconcileWorkingSet`): `add` is one exclusive
  acquisition under the workspace lock (own leases are no-ops: a repeated
  delta is idempotent); `remove` releases exactly the task's leases on those
  paths (`releaseLeaseRows`, never the manifest, never a directory lease
  above a reverted file) and wakes the waiters blocked on them. A closed task
  acknowledges nothing. The ACK names what was acquired, what a live holder
  blocked (with the holder), what was released, and the held count; the
  bounded proof (`WorkingSetRecord`) is kept on
  `tasks.path_declaration.workingSet`. Every applied delta records its size
  bucket (<=50 / <=500 / <=2k / >2k) and latency on the ledger.
- *Ship checkpoint* (`runShipCheckpoint`): the full reconciliation above with
  bounded retries (`SHIP_CHECKPOINT_ATTEMPTS`). Results are `complete`,
  `blocked` (names the holder) or `unknown` (timeout / error /
  sweep_incomplete / server_rejected). Enforce mode refuses the ship on
  `blocked` (checkpoint + deferral) and on `unknown` (retryable refusal, no
  deferral). Advisory mode still reconciles and records the outcome but does
  not refuse. An unproven checkpoint is reported to the server on the next
  sync that lands, as `coverage_unknown_at_ship`.
- *PR handoff* (`promoteLeasesToPrScope`): when a worker completes with its
  PR still open, the leases it holds are promoted into its effective
  manifest before the `pending_merge` release, so the claim route's open-PR
  overlap surface covers the PR's actual changed files even for a task
  created without a manifest or with the repo-wide sentinel. Merge or close
  releases that scope with the PR; the next push's PR-scope reconciliation
  narrows it to the pinned diff. `authoritativeTaskScope` (leases ∪ effective
  manifest) is the one scope any overlap consumer — in-flight merge/push
  notices included — should read; never the sample.

**Sentinel semantics** (`packages/core/path-coordination-signal.ts`): every
`path_claim` / `path_declaration` ledger row is exactly one of
`observation_truncated` (advisory), `claim_blocked` (healthy coordination),
`deadlock_detected` (a conflict, its own count), `coordination_unavailable`
(a real timeout / network / 5xx / DB failure, cause-attributed) or
`coverage_unknown_at_ship` (critical: a ship could not be proven). Only the
last two make an incident. Writers tag `detail.signal`; readers with only the
normalized reason classify from text; `get_failure_analytics family=gate`
reports the split as `pathCoordination`.

**Invariants**:

- `acquirePathClaims` decides inside one locked statement under a workspace
  lock; the unlocked pre-read only discounts stale holders (terminal, or parked
  past the TTL) and never grants anything.
- A declaration is all-or-nothing: one blocked path returns kind `conflict`
  naming the blocker and inserts nothing. Observed touches and working-set
  deltas lease each free path and leave the manifest unchanged.
- Overlap is exact or directory-prefix in either direction after trailing-slash
  normalization. A holder in another workspace never blocks; a terminal holder
  never blocks.
- A task that is not open gets kind `task_closed` and no lease, so an append
  racing a cancellation cannot leave a cancelled task holding a lease; a
  working-set delta for it is acknowledged as not applied.
- The repo-wide sentinel is never a lease and is rejected with HTTP 400.
- A delta never carries more than `WORKING_SET_CHUNK` paths per side; no
  heartbeat resends the cumulative set; a worker row never stores the set.
- A path past the observed-sample cap is leased exactly like any other.
- `narrowPathClaims` releases only the caller's leases on the named paths (and
  under them), removes them from the effective manifest, records the narrowing
  next to the original declaration (at most `MAX_RECORDED_NARROWINGS`) and
  wakes only waiters blocked on a released path. It never edits dependencies.
- A stale expected revision returns HTTP 409 with the current revision and
  `retryable: true`, and changes nothing.
- `releaseLeaseRows` gives back exactly the rows one acquisition inserted
  (`insertedIds`), for this task only, leaves the manifest alone, and releases
  nothing when the task's status is in the caller's keep set, re-checked under
  the lock.
- `releaseClaims` wakes every pending waiter even when nothing is left to
  release; a failed delivery is re-armed (`rearmWaiter`).
- PR-backed scope reconciliation reads the full, head/base-pinned PR file list.
  A moved head or base, a truncated list, a failed read or a closed PR narrows
  nothing and records why. A live PR owner is never narrowed, and
  reconciliation never adds a path. The PR handoff is the one write that
  widens a manifest, and only at the owner's terminal transition.
- Plan approval persists each step's manifest; doc-fix scope wins over the
  step's own.

**Acceptance criteria**:

- AC-1: GIVEN two tasks declaring prefix-overlapping paths at once WHEN both
  acquire THEN exactly one is granted and the other receives kind `conflict`.
- AC-2: GIVEN a holder whose task is terminal WHEN a fresh task declares an
  overlapping path THEN the fresh task acquires it.
- AC-3: GIVEN a cancelled task WHEN an acquisition for it runs THEN the result
  is kind `task_closed` and no lease row exists.
- AC-4: WHEN a task narrows a directory it holds THEN its leases under that
  directory are released, the manifest drops them and only waiters on those
  paths are woken.
- AC-5: WHEN a narrowing passes a stale expected revision THEN the route
  rejects with HTTP 409 and no lease changes.
- AC-6: WHEN a path claim names the repo-wide sentinel THEN the route rejects
  with HTTP 400.
- AC-7: GIVEN a PR whose file list cannot be read completely WHEN retry scope
  is reconciled THEN no lease is released and the reason is recorded.
- AC-8: GIVEN a task that changes more paths than the observed-sample cap
  (2,000 included) WHEN its runner syncs THEN the sample stays bounded, one
  `observation_truncated` advisory is recorded, and every non-regenerable
  current path is leased.
- AC-9: GIVEN a sibling holding one of those paths WHEN the runner reaches a
  ship checkpoint THEN the checkpoint result is `blocked` naming the holder
  and, in enforce mode, the ship is refused.
- AC-10: GIVEN a coordinator that is unreachable at a ship checkpoint WHEN
  bounded retries are exhausted THEN the result is `unknown`, enforce mode
  refuses the push / `create_pr` / `complete_task`, and the next sync records
  `coverage_unknown_at_ship`.
- AC-11: GIVEN a coordinator that fails and then recovers during editing WHEN
  the runner retries THEN the deltas converge with no path offered twice and
  no duplicate lease, and the ship proceeds only after the ACK.
- AC-12: GIVEN a path the task reverted WHEN the next trusted sweep runs THEN
  its lease is released, its waiter woken, and a declared lease above it kept.
- AC-13: GIVEN a runner restart WHEN the new session syncs THEN it converges
  from persisted state plus the server's held list without releasing a
  declared lease outside the sweep.
- AC-14: GIVEN a rebase onto a moved base WHEN the owned set is recomputed
  THEN it is the diff from the new merge-base, not the branch history.
- AC-15: GIVEN a worker completing with an open PR WHEN its leases are
  released THEN the PR's changed files remain on the open-PR overlap surface
  until merge or close.
- AC-16: GIVEN the same delta or checkpoint sent twice WHEN applied THEN the
  second acquires nothing, releases nothing, and costs the same bounded
  number of statements.
- AC-17: GIVEN a window of sample-truncation advisories and blocked claims
  WHEN summarised THEN no incident is reported; one `coordination_unavailable`
  or `coverage_unknown_at_ship` event is.
- AC-18: GIVEN a runner that predates the delta protocol WHEN it reports
  touched paths THEN they are leased regardless of the sample cap.

**Code surface**:

- `packages/core/path-claim.ts`: `acquirePathClaims`, `acquireObservedPaths`,
  `narrowPathClaims`, `releaseClaims`, `releaseLeaseRows`, `rearmWaiter`,
  `normalizeClaimPaths`; re-exports the working-set surface below.
- `packages/core/working-set.ts`: `reconcileWorkingSet`, `recordWorkingSet`,
  `workingSetRecord`, `promoteLeasesToPrScope`, `planPrHandoff`,
  `authoritativeTaskScope`, `activeLeasePaths`.
- `packages/core/path-overlap.ts`: `leasablePaths` (shared by both sides).
- `packages/core/path-coordination-signal.ts`:
  `classifyPathCoordinationEvent`, `summarizePathCoordination`,
  `PATH_SIGNAL_REASONS`; surfaced through `packages/core/gate-analytics.ts`.
- `apps/runner/src/working-set.ts`: `observeWorkingSet`,
  `nextWorkingSetDelta`, `applyWorkingSetAck`, `workingSetCoverage`.
- `apps/runner/src/ship-checkpoint.ts`: `runShipCheckpoint`; wired by the
  ship guard in `apps/runner/src/hook-factory.ts`
  (`createPathCheckpointGuardHook`) and the sync tick in
  `apps/runner/src/worker-sync.ts`.
- `apps/web/src/lib/working-set-sync.ts`: `applyWorkingSetSync`,
  `boundedObservedSample`, `recordShipCheckpointReports`, `handoffPrScope`;
  called from `apps/web/src/app/api/workers/[id]/route.ts`.
- `apps/web/src/lib/path-claim-check.ts`: `checkPathClaim`, `narrowPathClaim`,
  shared by the route `/api/tasks/[id]/path-claim` and the `check_path_claim`
  MCP action at `/api/mcp`.
- `apps/web/src/lib/path-claim-release.ts`: `releaseAndNotify`,
  `deliverPathReleased`.
- `apps/web/src/lib/pr-scope-reconcile.ts`: `readPinnedPrScope`,
  `planScopeNarrowing`, `reconcilePrBackedScope`.
- `apps/web/src/lib/approve-plan.ts`: `approvePlan`;
  `apps/web/src/lib/path-declaration.ts`: `conformanceManifest`.
- Data model: `path_claims`, `path_claim_waiters`, and the task's
  `path_manifest`, `path_declaration` (`workingSet`, `prHandoff`) and
  `path_claim_revision` columns in `packages/core/db/schema.ts`; the shared
  wire types `WorkingSetDelta` / `WorkingSetAck` / `ShipCheckpointReport` in
  `packages/shared/src/types.ts`.

**Out of scope**: removing dependency edges inferred at creation (they are
recorded, not removed); adding scope during reconciliation other than the PR
handoff; making broad/prefix scheduling overlap a soft hold (claim-ordering);
notifying running workers of base changes (consumers of
`authoritativeTaskScope`).
