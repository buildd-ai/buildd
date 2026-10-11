---
title: Mission Branch Refresh
status: active
owner: max
last_verified: 2026-10-11
summary: A mission's integration branch MUST be brought up to date with trunk when a mission task starts on it, by a daily backstop while the mission is in use, and never by a trunk merge alone.
domain: missions
surfaces: [apps/web/src/lib/mission-branch-refresh.ts, apps/web/src/lib/mission-subscribers.ts, apps/web/src/app/api/workers/claim/route.ts, apps/web/src/app/api/cron/pr-reconcile/route.ts]
related: [mission-release-gate, mission-task-lifecycle, workflow-state-kernel]
keywords: [integration branch, mission/*, merge dev into, chore(mission), branch refresh, branchRefreshHeadSha, branch_refreshed_at, refresh conflict task, requireMergeCommit, trunk merge]
verified_by: [apps/web/src/lib/mission-branch-refresh.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/modules.test.ts, apps/web/src/lib/integration-refresh.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "refresh-entry"
    type: "symbol"
    name: "refreshMissionIntegrationBranch"
    path: "apps/web/src/lib/mission-branch-refresh.ts"
  - id: "start-trigger"
    type: "symbol"
    name: "refreshMissionBranchesBeforeStart"
    path: "apps/web/src/lib/mission-branch-refresh.ts"
  - id: "claim-emits-claimed-tasks"
    type: "symbol_reachable"
    symbol: "emit"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "call"
  - id: "missions-module-refreshes-on-claim"
    type: "symbol_reachable"
    symbol: "refreshMissionBranchesBeforeStart"
    entry: "apps/web/src/lib/mission-subscribers.ts"
    as: "call"
  - id: "backstop"
    type: "symbol"
    name: "sweepMissionBranchRefresh"
    path: "apps/web/src/lib/mission-branch-refresh.ts"
---

# Mission Branch Refresh

A mission with an integration branch (`missions.integrationBranchEnabled`, branch
`missions.workingBranch`) collects its task PRs on that branch, and reaches trunk
through one mission PR. Trunk keeps moving meanwhile. This spec covers when buildd
merges trunk into the integration branch, and what happens when that merge conflicts.

Design rationale and the measurements behind the triggers:
`knowledge-base: buildd/design/mission-branch-refresh-on-demand.md`.

## Refresh mechanism

**Capability statement**: `refreshMissionIntegrationBranch` MUST merge the
workspace's trunk into the mission's integration branch with GitHub's merges API.
It MUST record what it confirmed, and MUST hand a conflict to exactly one
resolution task per mission.

**Invariants**:
- The only write to the integration branch is a merge commit from trunk. There is
  no squash, no rebase and no force-push.
- At most one caller per mission reaches the merges API at a time. The guard is
  the single-flight lease `branchRefreshLeaseUntil` / `branchRefreshLeaseToken`.
- When trunk's head equals `branchRefreshHeadSha`, the call makes no write to
  GitHub.
- `branchRefreshedAt` is set when, and only when, the branch is confirmed to
  contain trunk: a merge commit landed, the merges API answered 204, or the branch
  was freshly cut from trunk.
- A 409 from the merges API dispatches at most one conflict task per mission
  (`missions.branchRefreshConflictTaskId`). Further refreshes coalesce into it
  until it settles: its PR merged and the branch provably contains the trunk sha
  it was dispatched for, or it ended without a merge.
- The conflict task's PR must land as a merge commit (`context.requireMergeCommit`).
- A completed or archived mission, a mission whose own PR into trunk has merged,
  and a mission without an integration branch are never refreshed.

**Acceptance criteria**:
- AC-1: GIVEN trunk has moved and the merge is clean WHEN the refresh runs THEN a
  merge commit lands on the branch, `branchRefreshHeadSha` equals trunk's head,
  `branchRefreshedAt` is set, and no task is created.
- AC-2: GIVEN the merges API answers 409 WHEN the refresh runs THEN exactly one
  task titled `chore(mission): merge <trunk> into the <mission> integration
  branch` is created, and a second refresh while it is open creates none.
- AC-3: GIVEN the merges API answers 409 WHEN the refresh runs THEN
  `branchRefreshedAt` is unchanged.
- AC-4: GIVEN a concurrent burst of refresh calls for one mission WHEN they race
  THEN exactly one reaches the merges API.
- AC-5: GIVEN the conflict task's PR was squash-merged WHEN the next refresh runs
  THEN no replacement task is created and the violation is recorded once.

## When a refresh runs

**Capability statement**: A refresh MUST run when a mission task is about to cut
its branch from the integration branch, and from a daily backstop while the
mission is in use. A trunk merge alone MUST NOT trigger it.

**Invariants**:
- No `pr.merged` subscriber refreshes integration branches. Merging into trunk
  writes nothing to any mission branch.
- **Start trigger.** Once its claimed set is final, the claim route awaits the
  core event `tasks.claimed` before it answers. The missions module's subscriber
  `refresh-mission-branches-before-start` passes the tasks to
  `refreshMissionBranchesBeforeStart`. Core never imports the module
  (`scripts/module-boundaries.test.ts`).
  - It counts only a task whose `context.baseBranch` equals its mission's
    integration branch and which does not carry `context.requireMergeCommit`.
  - It refreshes each mission at most once per call, however many of its tasks
    were claimed.
  - It waits at most `START_REFRESH_BUDGET_MS`. A refresh still running at the
    budget continues on its own.
  - It never throws, and the claim is never refused or failed because of it.
- **Landing.** A mission PR into trunk that is approved and behind is updated by
  the workflow kernel's `refresh_branch` effect, serialized per base by the
  landing lane (`workflow-state-kernel` §13.7). That is a merge of trunk into the
  integration branch too. This spec adds no trigger for it.
- **Backstop.** `sweepMissionBranchRefresh`, run from the pr-reconcile cron,
  refreshes a mission only when both of these hold:
  - `branchRefreshedAt` is null or older than `BRANCH_REFRESH_BACKSTOP_MS`;
  - the mission has a non-terminal task, or its mission PR is open.

  Any other mission costs no GitHub call.

**Acceptance criteria**:
- AC-6: GIVEN a PR merges into trunk WHEN the webhook is processed THEN no mission
  integration branch is refreshed.
- AC-7: GIVEN a mission task whose `context.baseBranch` is its mission's
  integration branch WHEN it is claimed THEN the refresh runs before the claim
  response is returned.
- AC-8: GIVEN three tasks of one mission claimed in one response WHEN the claim
  runs THEN the merges API is called once.
- AC-9: GIVEN a claimed task based on a PR branch (a fix or CI-fix retry), or the
  refresh conflict task itself WHEN it is claimed THEN no refresh runs.
- AC-10: GIVEN the refresh takes longer than its budget WHEN a mission task is
  claimed THEN the claim returns within the budget, and the refresh is reported
  `timed_out`.
- AC-11: GIVEN the refresh lookup throws WHEN a mission task is claimed THEN the
  claim still succeeds.
- AC-12: GIVEN a mission refreshed less than a day ago WHEN the backstop runs THEN
  it makes no GitHub call for that mission.
- AC-13: GIVEN a mission with no non-terminal task and no open mission PR WHEN the
  backstop runs THEN it is skipped, even if never refreshed.
- AC-14: GIVEN a mission never refreshed, with live work WHEN the backstop runs
  THEN it is refreshed.

## Code surface

- `apps/web/src/lib/mission-branch-refresh.ts`: `refreshMissionIntegrationBranch`,
  `refreshMissionBranchesBeforeStart`, `sweepMissionBranchRefresh`,
  `BRANCH_REFRESH_BACKSTOP_MS`, `START_REFRESH_BUDGET_MS`.
- `apps/web/src/app/api/workers/claim/route.ts`: emits `tasks.claimed` once the
  claimed set is final.
- `apps/web/src/lib/mission-subscribers.ts`: the start trigger's subscriber. It
  has no `pr.merged` refresh subscriber (`apps/web/src/modules.test.ts` pins
  both).
- `apps/web/src/lib/core-events.ts`: the `tasks.claimed` event contract.
- `apps/web/src/app/api/cron/pr-reconcile/route.ts`: runs the backstop.
- `apps/web/src/lib/integration-refresh.ts`: `verifyRefreshLanded`, the ancestry
  proof a merged conflict task must pass.
- `packages/core/db/schema.ts`: `missions.branchRefreshHeadSha`,
  `branchRefreshedAt`, `branchRefreshLeaseUntil`, `branchRefreshLeaseToken`,
  `branchRefreshConflictTaskId`.

## Out of scope

- Refreshing a task PR against the integration branch. That is the kernel's
  behind refresh of that PR.
- How the conflict task resolves the merge, and how its PR is reviewed.
- Missions without an integration branch (`branchStrategy: direct`).
