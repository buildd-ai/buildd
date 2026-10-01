---
title: Path Claim Ownership
status: active
owner: max
last_verified: 2026-10-01
summary: Edit leases MUST be acquired exclusively per workspace, narrowed only by their owner, released on terminal status, and reconciled to a PR's pinned actual diff without ever treating missing data as an empty diff.
domain: tasks
surfaces: [packages/core/path-claim.ts, apps/web/src/lib/path-claim-check.ts, apps/web/src/lib/path-claim-release.ts, apps/web/src/lib/pr-scope-reconcile.ts]
related: [orchestration-decisions-shadow, mission-task-lifecycle]
keywords: [path_claims, check_path_claim, lease, narrow, pathManifest, path_declaration, path_claim_revision, waiter, retry scope]
verified_by: [packages/core/__tests__/path-claim-ownership.test.ts, apps/web/src/lib/pr-scope-reconcile.test.ts, apps/web/src/app/api/tasks/[id]/path-claim/route.test.ts, apps/web/src/lib/approve-plan.test.ts]
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
  - id: "reconcile-pr-scope"
    type: "symbol"
    name: "reconcilePrBackedScope"
    path: "apps/web/src/lib/pr-scope-reconcile.ts"
  - id: "release-notify-uses-release"
    type: "symbol_reachable"
    symbol: "releaseClaims"
    entry: "apps/web/src/lib/path-claim-release.ts"
    as: "call"
  - id: "path-claim-ownership-test"
    type: "test_file"
    path: "packages/core/__tests__/path-claim-ownership.test.ts"
  - id: "pr-scope-reconcile-test"
    type: "test_file"
    path: "apps/web/src/lib/pr-scope-reconcile.test.ts"
supersedes: []
---
# Path Claim Ownership

**Capability statement**: Buildd MUST let at most one open task hold an edit
lease on any overlapping path in a workspace. Acquisition, narrowing and
release are serialized on the same ownership revision. On by default, no flag.

**Invariants**:

- `acquirePathClaims` decides inside one locked statement under a workspace
  lock; the unlocked pre-read only discounts stale holders (terminal, or parked
  past the TTL) and never grants anything.
- A declaration is all-or-nothing: one blocked path returns kind `conflict`
  naming the blocker and inserts nothing. Observed touches lease each free path
  and leave the manifest unchanged.
- Overlap is exact or directory-prefix in either direction after trailing-slash
  normalization. A holder in another workspace never blocks; a terminal holder
  never blocks.
- A task that is not open gets kind `task_closed` and no lease, so an append
  racing a cancellation cannot leave a cancelled task holding a lease.
- The repo-wide sentinel is never a lease and is rejected with HTTP 400.
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
  reconciliation never adds a path.
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

**Code surface**:

- `packages/core/path-claim.ts`: `acquirePathClaims`, `acquireObservedPaths`,
  `narrowPathClaims`, `releaseClaims`, `releaseLeaseRows`, `rearmWaiter`,
  `normalizeClaimPaths`.
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
  `path_manifest`, `path_declaration` and `path_claim_revision` columns in
  `packages/core/db/schema.ts`.

**Out of scope**: removing dependency edges inferred at creation (they are
recorded, not removed); adding scope during reconciliation; pre-write denial
(see checkpoint-sweeps).
