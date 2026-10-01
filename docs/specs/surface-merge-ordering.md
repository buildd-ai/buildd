---
title: Serialized Surface Merge Ordering
status: active
owner: max
last_verified: 2026-10-01
summary: When a workspace opts in, a PR touching a serialized surface MUST wait behind an earlier open PR on the same surface and base branch, and MUST merge inside an atomic per-surface reservation.
domain: tasks
surfaces: [apps/web/src/lib/surface-ordering.ts, apps/web/src/lib/surface-ordering-door.ts, apps/web/src/lib/surface-ordering-config.ts, apps/web/src/lib/change-intent.ts]
related: [path-claim-ownership, db-migration-gates, pr-lifecycle-reconciliation]
keywords: [surfaceOrdering, conflictSurfaces, sequenceNamespaces, serialize, change_intents, mergeAfter, reservation, migration namespace]
verified_by: [apps/web/src/lib/surface-ordering.test.ts, apps/web/src/lib/surface-ordering-wake.test.ts, apps/web/src/lib/surface-ordering-door.test.ts, apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts]
supersedes: []
---
# Serialized Surface Merge Ordering

**Capability statement**: Every merge door MUST defer a PR that shares a
serialized surface with an earlier unclosed change intent on the same base
branch. This applies only when the workspace sets `surfaceOrdering` to `shadow`
or `enforce` (default `off`) and the surface entry is marked `serialize`.
Otherwise no new reads happen.

**Invariants**:

- Contenders are grouped one per PR (`groupContenders`) and ordered by a single
  global key, the earliest open intent time and then the PR number
  (`compareContenders`). Two PRs never wait on each other and a PR never waits
  on itself. A per-surface order that disagrees with the global one is recorded
  as a cross-surface cycle, not followed.
- Only PRs on the same base branch contend (`sameBaseLane`).
- Surfaces come from the PR's pinned actual diff. Under enforce, an unreadable
  diff, a failed intent read or write, a missing base ref or an unreadable
  earlier contender defers the merge as unverified.
- An earlier contender that GitHub shows closed or merged is settled and
  dropped as a missed close event.
- Shadow records a warning and never blocks. Enforce records a deferral. An
  explicit override records a bypass in the gate ledger.
- The merge runs inside one atomic compare-and-set reservation per workspace,
  repository, base and surface (`acquireMergeSlot`, `withMergeSlot`), bounded
  by `SURFACE_RESERVATION_TTL_MS`. The order is rechecked after reserving, and
  the reservation is released on success or failure.
- Closing a PR closes its intents, drops its reservations and, under enforce,
  re-drives the next waiter. Retargeting a PR moves its intents to the new base.

**Acceptance criteria**:

- AC-1: GIVEN enforce mode and two open PRs on one serialized surface and base
  WHEN the later PR tries to merge THEN it is deferred behind the earlier one.
- AC-2: GIVEN the same two PRs on different base branches WHEN either merges
  THEN neither waits.
- AC-3: GIVEN the earlier PR closes WHEN the close is processed THEN the
  waiting PR is re-driven without a resident agent.
- AC-4: GIVEN two concurrent merge attempts on one surface WHEN both reserve
  THEN only one holds the reservation.
- AC-5: GIVEN enforce mode and an unreadable PR diff WHEN the merge is
  evaluated THEN it is deferred as unverified.
- AC-6: GIVEN shadow mode WHEN ordering would defer THEN the merge proceeds and
  a warning is recorded.

**Code surface**:

- `apps/web/src/lib/surface-ordering.ts`: `evaluateSurfaceOrder`,
  `guardSurfaceOrdering`, `acquireMergeSlot`, `withMergeSlot`,
  `settleSurfaceIntentsOnClose`, `retargetSurfaceIntents`.
- `apps/web/src/lib/surface-ordering-door.ts`: `checkSurfaceOrder`,
  `mergeInSurfaceSlot`, called from `apps/web/src/lib/auto-merge.ts`,
  `apps/web/src/lib/pr-landing.ts`, `/api/prs/[prNumber]/merge` and
  `/api/github/pr`.
- `apps/web/src/lib/surface-ordering-wake.ts`: `redriveSurfaceWaiter`, from
  `/api/github/webhook`.
- `apps/web/src/lib/surface-ordering-config.ts`: `resolveSurfaceOrderingMode`,
  `resolveSerializedSurfaces`.
- `apps/web/src/lib/change-intent.ts`: `recordChangeIntents`,
  `closeIntentsForPr`.

**Out of scope**: per-repository intent lanes in a multi-repository workspace
(intents carry no repository yet, so ordering can over-serialize across
repositories, while reservations stay per repository); a global merge queue.
