---
title: Mission Release Gate
status: active
owner: max
last_verified: 2026-10-15
summary: For a mission with an integration base, canCompleteMission and the on_mission_complete release trigger MUST gate on the mission PR's merge into trunk through one shared accessor.
domain: releases
surfaces: [apps/web/src/lib/mission-completion.ts, apps/web/src/lib/mission-release.ts, apps/web/src/lib/release/subscribers.ts, apps/web/src/lib/mission-pr.ts, apps/web/src/lib/mission-production-status.ts]
related: [mission-task-lifecycle, release-flow, pr-lifecycle-reconciliation]
keywords: [on_mission_complete, canCompleteMission, findMissionPrOwner, awaiting_mission_pr, integration_pr_unmerged, released criterion, integration branch, dev to main, workflow_run skipped, self-referential guard]
verified_by: [apps/web/src/lib/mission-completion.test.ts, apps/web/src/app/api/github/webhook/route.test.ts, apps/web/src/lib/mission-release.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "completion-gate"
    type: "symbol"
    name: "canCompleteMission"
    path: "apps/web/src/lib/mission-completion.ts"
  - id: "completion-reads-integration-pr"
    type: "symbol_reachable"
    symbol: "findMissionPrOwner"
    entry: "apps/web/src/lib/mission-completion.ts"
    as: "read"
---

# Mission Release Gate

**Capability statement**: A mission with an integration base ships through a
fixed line. Task PRs merge into the integration branch, the integration
branch merges into trunk through exactly one PR, and trunk deploys to
production through a release. "Complete" may be asserted at exactly one point
on that line, and `canCompleteMission`, the `on_mission_complete` release
trigger, and the goal-criteria evaluator MUST all read the same point. None of
the three may treat an earlier point (every deliverable task's PR merged into
the integration branch, or the mission's own PR merged into a non-production
branch) as this mission class's "done".

This spec formalizes a gap two independent investigations found with live
evidence: an `on_mission_complete` release firing while a mission's actual
code sat only on an unreleased integration branch, and a mission whose sole
deliverable was a merge-enforcement guard closing as "verified" while that
guard itself had not yet reached the server it was meant to run on. Both are
instances of the same root cause: the platform has more than one place that
answers "is this mission done?", and they do not all ask the strict question.

## Implementation status

Six decisions were proposed to close this gap, numbered D-1 to D-6 below.
Two shipped (D-1, D-3); four remain design-only. This spec stays `active`
because the shipped pair already satisfies the ship-line invariant above for
every mission today. The open decisions are additive (an opt-in stricter
gate, a bug-fix reclassification, a merge-time guard) and are marked NOT
IMPLEMENTED in place below rather than silently dropped, per `SPEC-FORMAT.md`
rule 8. Only the shipped decisions carry graded criteria (AC-n). An open
decision lists its target checks as plain bullets; they become criteria when
the decision is built.

- Decision D-1 (`canCompleteMission` gates on the mission PR's merge state):
  IMPLEMENTED. Shipped with one naming change from the original proposal:
  the refusal code is `awaiting_mission_pr`, not `integration_pr_unmerged`.
  Covered by `apps/web/src/lib/mission-completion.test.ts`.
- Decision D-2 (a `released` goal-criterion type): NOT IMPLEMENTED.
  `GoalCriterionType` (`packages/shared/src/types.ts`) has no `released`
  member, `evaluateGoalCriteria` (`packages/core/mission-helpers.ts`) has no
  arm for it, and the write boundary does not reject it on a non-integration
  mission: there is no such value to reject. `loadMissionProductionStatus`,
  the function this decision would reuse, already exists and already answers
  the right question for the Delivery-block UI; it is not yet called from the
  criteria evaluator.
- Decision D-3 (one claim guards every mission release): IMPLEMENTED. Every
  path that can fire an `on_mission_complete` release reads
  `canCompleteMission` and then takes the same atomic attempt claim, so D-1
  makes all of them inert until the mission PR merges. Covered by
  `apps/web/src/app/api/github/webhook/route.test.ts` and
  `apps/web/src/lib/mission-release.test.ts`.
- Decision D-4 (a `skipped` workflow run is not a failed release): NOT
  IMPLEMENTED, and current code takes the opposite position deliberately.
  `mapWorkflowConclusionToReleaseState`
  (`apps/web/src/lib/release/workflow-run.ts`) maps `skipped` to `failed`,
  with a docstring arguing that recording a no-op run as a failed release "is
  accurate, not pessimistic." Anyone revisiting this decision needs to engage
  that argument, not just wire up the mapping the original proposal wanted.
- Decision D-5 (trunk CI red at mission-PR-merge time): NOT IMPLEMENTED.
  `guardMissionPrMerge` (`apps/web/src/lib/mission-pr.ts`) refuses on an open
  task PR on the integration branch, an unfinished task with no PR yet, a
  delivery target that can no longer reach trunk, and an open visual review.
  It does not query trunk's latest commit status, and there is no override
  parameter for a human-initiated merge to bypass such a check.
- Decision D-6 (a mission cannot fully protect its own task PRs): NOT
  IMPLEMENTED. Its only proposed mechanism is a self-referential mission
  stating a D-2 `released` criterion; since D-2 does not exist, neither does
  this.

---

## The ship-line invariant

**Invariants**:
- A mission's `integrationBranchEnabled` flag (`missions` table) decides which
  line applies (read through `missionIntegrationBase`,
  `packages/core/mission-integration.ts`, which also needs a `workingBranch`).
  `false`/absent (the `direct` strategy) is unaffected by this spec: a task PR there already targets trunk directly, and the existing
  per-deliverable `awaiting_merge` check (`mission-task-lifecycle.md`, Mission
  Completion Gate) is the whole story.
- For `integrationBranchEnabled = true` (the `mission-branch` strategy), "done"
  is defined as: the mission's own PR (`findMissionPrOwner`,
  `apps/web/src/lib/mission-pr.ts`) has `state = 'merged'`, **and**, wherever a
  caller is asserting shipped rather than merely merged, that merge is
  contained in a release that reached `state = 'healthy'`. "Merged" and
  "shipped" are deliberately kept as two distinct, separately checkable facts
  (D-1 and D-2 below); collapsing them into one check is what let a
  release fire on data that had only reached the first fact.
- Every one of the following MUST read the same fact through the same
  accessor, never re-derive it: `canCompleteMission` (all callers: heartbeat,
  dormancy, the independent evaluation task, the on-demand evaluate route),
  the `on_mission_complete` release trigger (both call sites:
  `fireMissionReleaseIfComplete` and the `task.pr_merged` subscriber in
  `apps/web/src/lib/release/subscribers.ts`), and a mission's `released` goal
  criterion (D-2). A caller that reads
  only `countPendingTasksForMission` (task terminality) without also reading
  this fact is answering a different, weaker question and MUST NOT be trusted
  as a completion or release gate for an integration-base mission.

---

## D-1: `canCompleteMission` gates on the mission PR's merge state (IMPLEMENTED)

**Capability statement**: For an integration-base mission,
`canCompleteMission` MUST refuse completion until the mission's own PR has
merged into trunk, independent of whether the mission happens to have stated
an `all_prs_merged` goal criterion.

Before this decision shipped, `canCompleteMission`'s `awaiting_merge` check
walked deliverable tasks only (`isDeliverableTask`). The mission-PR-owner task
is created by `openMissionIntegrationPr` as a `bookkeeping`-class row
specifically so merge-surface tooling can find it, the same classification
that makes `isDeliverableTask` exclude it from every deliverable-scoped check.
The result was a mission with every deliverable's PR merged into the
integration branch, zero pending tasks, and no goal criteria stated passing
`canCompleteMission` with its own PR still open, because nothing in the
default (no criteria) path ever looked at `findMissionPrOwner`.
`evaluateGoalCriteria`'s `all_prs_merged` arm already asked the right question
and already accounted for Option A' correctly (it requires the mission PR's
base ref to show it landed outside the integration branch before passing),
but only for a mission that explicitly stated `all_prs_merged`. A mission
with no stated criteria, or criteria that don't include it, had nothing
checking this.

**Invariants**:
- For any mission whose `missionIntegrationBase` is set and which has put
  work on the integration branch (`evaluateMissionWorkState(missionId)`
  reports `landedOnIntegrationCount > 0`), `canCompleteMission` calls
  `findMissionPrOwner(missionId)` and refuses with code `awaiting_mission_pr`
  whenever the owner is absent, its PR was closed without merging, or it is
  still open. The code is `awaiting_mission_pr`
  (`packages/core/mission-completion-codes.ts`), not the
  `integration_pr_unmerged` name this decision originally proposed. The check
  does not depend on `goalCriteria` containing `all_prs_merged`, and it runs
  even when `goalCriteria` is empty (the "zero criteria means no gate" rule
  for goal criteria is unchanged; this is a structural gate, not a stated
  one).
- A mission that put nothing on the integration branch (all work cancelled,
  or no code PRs) is not asked for a mission PR: cancelled deliverables still
  allow completion, as the earlier checks already say.
- A mission with delivery records (`missionEpochsOf`, see
  `workflow-kernel-library.md` section 6) is judged by them instead: while a
  delivery has work that has not reached trunk (PR not open, open, closed
  unmerged, or PRs still held on its branch), the refusal is the same
  `awaiting_mission_pr` code with a reason naming the delivery.
- The check is placed in the refusal order immediately after `awaiting_merge`:
  `mission_not_found`, `mission_not_active`, `pending_deliverables`,
  `no_deliverables`, `infra_stalled`, `awaiting_merge`,
  `awaiting_mission_pr`, then the visual audit gate (`surface_audit_missing`,
  `visual_review_open`), then `criteria_failed` / `criteria_pending` /
  `criteria_unverified` (the `canCompleteMission` body in
  `apps/web/src/lib/mission-completion.ts`). Deliverable PRs merging into the
  integration branch is a precondition for the mission PR existing at all, so
  checking them first gives the more specific, actionable refusal.
- `fireMissionReleaseIfComplete` and the `task.pr_merged` subscriber's
  `on_mission_complete` branch both call `canCompleteMission` with
  `evaluateCriteria: false`. No separate call site was needed for the release
  trigger; both inherited this fix once the predicate itself covered it,
  because they read the predicate's `ok` field and nothing else.
- Missions with no integration base are untouched: `findMissionPrOwner` is
  not queried for them, and behaviour is unchanged.

**Acceptance criteria**:
- AC-1: GIVEN a mission with `integrationBranchEnabled = true`, every
  deliverable task's PR merged into the integration branch, no mission-PR-owner
  task yet, and no stated `goalCriteria` WHEN `canCompleteMission` runs THEN it
  refuses with `code = 'awaiting_mission_pr'`.
  check: bun run scripts/run-unit-tests.ts apps/web/src/lib/mission-completion.test.ts
- AC-2: GIVEN the same mission WHEN its mission PR later merges into trunk
  THEN a subsequent `canCompleteMission` call no longer refuses on this code.
  check: bun run scripts/run-unit-tests.ts apps/web/src/lib/mission-completion.test.ts
- AC-3: GIVEN a mission with `integrationBranchEnabled = true` and its
  mission PR merged into trunk WHEN a task completion triggers
  `fireMissionReleaseIfComplete` THEN the release fires only once this check
  has already passed, never on a merge event earlier than the mission PR's own
  merge.
- AC-4: GIVEN a mission with `integrationBranchEnabled` false WHEN
  `canCompleteMission` runs THEN `findMissionPrOwner` is not queried and the
  decision is unchanged from current behaviour.
- AC-5: GIVEN a mission with `integrationBranchEnabled = true` whose mission
  PR was closed without merging WHEN `canCompleteMission` runs THEN it
  refuses with `awaiting_mission_pr` and a reason saying it will not resolve
  on its own.
  check: bun run scripts/run-unit-tests.ts apps/web/src/lib/mission-completion.test.ts
- AC-6: GIVEN a mission with `integrationBranchEnabled = true` that put
  nothing on the integration branch WHEN `canCompleteMission` runs THEN it
  does not refuse with `awaiting_mission_pr`.
  check: bun run scripts/run-unit-tests.ts apps/web/src/lib/mission-completion.test.ts

---

## D-2: a `released` goal-criterion type (NOT IMPLEMENTED)

**Capability statement**: A mission MAY gate its own completion on production
release, not merely trunk merge, via a new mechanical `GoalCriterion` type,
provisionally named "released" below. Design only: `GoalCriterionType`
(`packages/shared/src/types.ts`) does not have this member today, and nothing
downstream (the write boundary, `evaluateGoalCriteria`, `isLlmEligible`) has a
case for it. The design is recorded here for whoever picks this up, not as a
description of current behaviour.

**Invariants** (target design; none of the following exists yet):
- New `GoalCriterionType` value: `{ type: 'released', label?: string }`. No
  other fields; the mission being evaluated is implicit.
- The evaluator reuses `loadMissionProductionStatus(missionId)`
  (`apps/web/src/lib/mission-production-status.ts`), which already answers
  exactly this question for a mission with a single owning integration PR:
  `in_production` when the PR's merge commit is attributed (via
  `release_tasks`) to a release that reached `state = 'healthy'`,
  `not_yet_in_production` otherwise, `unavailable` when the mission has no
  single owning PR to check against at all.
- **How "at or after" is computed**: via the existing commit-attribution
  pipeline (`packages/core/release-attribution.ts`), which walks the GitHub
  compare API between a release's `previousSha` and `headSha` and matches PR
  numbers out of merge- and squash-commit messages, not via comparing
  timestamps, and not via a fresh `git merge-base --is-ancestor` check. This is
  a deliberate choice over raw ancestry: a squash-merged commit's original SHA
  is never literally an ancestor of trunk, so an ancestry check would need the
  same commit-message-driven remapping this pipeline already does. Reusing it
  avoids a second, subtly different definition of "shipped" existing beside
  the one `mission-production-status.ts` already uses for the Delivery-block
  UI.
- Mapping: `in_production` → `pass`; `not_yet_in_production` → `fail`;
  `unavailable` → rejected at the write boundary (see below) rather than ever
  produced as a runtime verdict.
- `POST`/`PATCH /api/missions` MUST reject a `released` criterion (HTTP 400)
  on a mission whose `integrationBranchEnabled` is not `true`: that mission
  has no single owning PR for `loadMissionProductionStatus` to check, so the
  criterion would read `unavailable` forever, exactly the "criterion that can
  never resolve" case `metric` is already rejected for.
- `released` is mechanical: `isLlmEligible('released')` MUST be `false`, and
  unlike `command` it MUST NOT dispatch a verification task: the verdict is
  answered by the same DB round-trip `all_prs_merged` already uses.
- Policy, not a mechanical write-time requirement: a mission whose deliverable
  changes merge/claim/release enforcement itself SHOULD state a `released`
  criterion (carried as guidance in the default Organizer role prompt,
  `apps/web/src/lib/default-roles.ts`). "This mission changes enforcement
  code" is not a predicate the platform can decide from task rows alone, so
  this is convention, not validation. Any mission MAY opt in regardless of
  subject matter.

**Target checks** (not graded until D-2 is built):
- GIVEN a mission with `integrationBranchEnabled = true`,
  `goalCriteria: [{ type: 'released' }]`, and a merged mission PR whose commit
  is not yet attributed to any `healthy` release WHEN criteria are evaluated
  THEN the criterion reads `fail` and the mission does not complete.
- GIVEN the same mission WHEN a release reaches `healthy` with a
  `release_tasks` row attributing the mission-PR-owner task to it THEN the
  criterion reads `pass` on the next evaluation.
- GIVEN `POST /api/missions` with `goalCriteria: [{ type: 'released'
  }]` and `integrationBranchEnabled` not `true` THEN the request is rejected
  with HTTP 400 naming why (no single owning PR to check).
- GIVEN a `released` criterion WHEN criteria evaluation runs THEN no
  verification or grading task is dispatched.

---

## D-3: one claim guards every mission release (IMPLEMENTED)

**Capability statement**: However many code paths observe that a mission is
done, at most one release is dispatched for it, and none is dispatched before
`canCompleteMission` passes.

**Invariants**:
- Three paths can fire an `on_mission_complete` release:
  - `fireMissionReleaseIfComplete` (`apps/web/src/lib/mission-release.ts`),
    called by the release policy's `settled` hook after every task completion
    (`releasePolicy`, `apps/web/src/lib/release-completion-policy.ts`);
  - the same function, called by `completeMissionIfVerified`
    (`apps/web/src/lib/mission-completion.ts`, via `attemptMissionRelease`)
    the moment a mission clears the gate on any path: a heartbeat
    evaluation, a merge webhook flipping `all_prs_merged`, or the on-demand
    evaluate route;
  - the `task.pr_merged` subscriber in `apps/web/src/lib/release/subscribers.ts`
    (Path B, `workflow_dispatch` workspaces only).
- Each path first requires every task row of the mission to be terminal
  (`countPendingTasksForMission`), then calls `canCompleteMission` with
  `evaluateCriteria: false`, then takes the atomic attempt claim
  (`claimMissionReleaseAttempt`, resolved by `commitMissionRelease` or
  `abandonMissionReleaseAttempt` on `missions.releasedAt` /
  `releaseAttemptedAt`). The claim resolves concurrent callers to exactly
  one winner; D-3 adds no second dedup mechanism, it relies on D-1 to make
  every path agree on WHEN it may win.
- A merge into a mission integration branch is never a release-triggering
  merge: the `task.pr_merged` subscriber skips it (`isMissionIntegrationBase`).
- `branch_merge` workspaces release on Path A only; the subscriber does not
  dispatch for them.
- No heartbeat or cron path dispatches a release except through
  `completeMissionIfVerified`, and so through the same predicate and claim.

**Acceptance criteria**:
- AC-7: GIVEN two concurrent completions for the same all-terminal mission
  WHEN both reach `claimMissionReleaseAttempt` THEN exactly one wins and
  exactly one release fires for the mission.
  check: bun run scripts/run-unit-tests.ts apps/web/src/lib/mission-release.test.ts
- AC-8: GIVEN a mission with `integrationBranchEnabled = true` and its
  mission PR still open WHEN the heartbeat runs and every task row happens to
  be terminal THEN no release dispatch is attempted.
- AC-9: GIVEN a `workflow_dispatch` workspace with trigger
  `on_mission_complete` WHEN a task PR merges and `canCompleteMission`
  refuses THEN the subscriber dispatches nothing.
  check: bun run scripts/run-unit-tests.ts apps/web/src/app/api/github/webhook/route.test.ts
- AC-10: GIVEN a mission that `completeMissionIfVerified` just completed
  WHEN the workspace trigger is `on_mission_complete` THEN a release attempt
  is made through `fireMissionReleaseIfComplete`, and a failed attempt does
  not reopen the mission.

---

## D-4: a `skipped` workflow run is not a failed release (NOT IMPLEMENTED)

**Capability statement**: A GitHub Actions run that concludes `skipped` MUST
be recorded as "did not ship, safe to retry", never as `failed`.

`mapWorkflowConclusionToReleaseState` (`apps/web/src/lib/release/workflow-run.ts`)
maps every conclusion other than `success` / `null` / `action_required` to
`failed`, which includes `skipped`, and does so deliberately: its docstring
argues a skipped run "shipped nothing, and recording that as a failed release
is accurate, not pessimistic." That is the opposite of this decision's
invariant. The `'skipped'` member of `MissionReleaseFailure`
(`apps/web/src/lib/mission-release.ts`) that exists today is not this call
site: it is reached only from `fireMissionReleaseIfComplete`'s own
`branch_merge`-strategy skip (an Option A' policy refusal), never from the
`workflow_run` webhook's conclusion mapping. Adopting this decision means
either overriding `mapWorkflowConclusionToReleaseState`'s stated rationale or
retiring the decision. That judgment call belongs to whoever picks this back
up, not to this reconciliation pass.

**Invariants** (target design; not implemented):
- `conclusion = 'skipped'` MUST NOT set `releases.state = 'failed'`.
- On `conclusion = 'skipped'`, the owning mission's release-attempt claim MUST
  be released via the existing `abandonMissionReleaseAttempt(missionId,
  'skipped', reason)` path. The `'skipped'` member of `MissionReleaseFailure`
  already exists in `mission-release.ts` for precisely this outcome; today
  nothing on the `workflow_run` webhook path ever reaches it.
- This is distinct from `force: true` bypassing the empty-commit check at
  dispatch time (`release-flow.md`, `workflow_dispatch` path): D-4
  governs how the RESULT of a run that decided to skip is recorded, not
  whether the skip itself was avoidable.

**Target checks** (not graded until D-4 is built):
- GIVEN a `workflow_run` webhook with `conclusion = 'skipped'` for a
  release row in `dispatched`/`deploying` state WHEN
  `advanceReleaseStateFromWorkflowRun` runs THEN `releases.state` is not set to
  `failed`, and the owning mission's attempt claim is abandoned with reason
  `'skipped'`.
- GIVEN the same mission after a skip is recorded WHEN its next
  qualifying event occurs (a later task completion, or its mission PR merging)
  THEN a release dispatch is attempted again: the mission is not permanently
  blocked by the earlier skip.

---

## D-5: trunk CI red at mission-PR-merge time (NOT IMPLEMENTED)

**Capability statement**: An unattended merge of a mission's PR into trunk
MUST be refused while trunk's own most recent commit has a failing CI status.

`guardMissionPrMerge` (`apps/web/src/lib/mission-pr.ts`) today refuses on an
open sibling task PR still based on the integration branch, an unfinished
deliverable task that hasn't opened a PR yet, a delivery target that can no
longer reach trunk (`deliveryTargetHold`), and an open visual review
(`decideReadyToMerge`). It does not query trunk's latest commit or its
check-runs state, and its signature (`task` only) has no override parameter
for a human-initiated merge to bypass a check that does not exist.

**Invariants** (target design; not implemented):
- `guardMissionPrMerge` (`apps/web/src/lib/mission-pr.ts`) gains a second,
  independent refusal alongside its existing "a sibling task PR based on the
  integration branch is still open" check: the workspace's trunk branch's
  latest commit has a combined check-runs state other than success.
- Recommended over "merge and ship red": landing a mission's aggregate change
  on top of an already-broken trunk compounds the failure and makes the
  eventual bisection ambiguous between the mission's change and the
  pre-existing break.
- Escape hatch: an explicit human-initiated merge (the dashboard merge action,
  or an equivalent explicit override) MAY bypass this specific refusal: the
  same shape of override `metric`less criteria already use elsewhere in the
  gate chain (an explicit action, recorded, not a silent default). An
  unattended path (the auto-merge webhook) MUST NOT bypass it.
- Orthogonal to the PR's own CI status, which `auto-merge.ts` already checks
  before any merge. This decision is about trunk's HEAD state, not the PR's
  diff.

**Target checks** (not graded until D-5 is built):
- GIVEN the workspace's trunk branch's latest commit has a failing
  combined CI status WHEN the auto-merge path attempts to merge a mission PR
  into trunk THEN the merge is refused, naming the failing check.
- GIVEN the same trunk state WHEN a human explicitly merges via the
  override path THEN the merge proceeds and the override is recorded.

---

## D-6: a mission cannot fully protect its own task PRs (NOT IMPLEMENTED)

**Capability statement**: When a mission's own deliverable is the
merge/claim/release guard that would otherwise protect it, the mission MUST
NOT be able to represent itself as verified before that guard is actually
enforcing in production, even though the window in which it cannot protect
itself cannot be closed by more code inside the mission itself.

This decision has no code surface of its own: it is satisfied entirely by
the `released` criterion of D-2 existing. Since D-2 is not implemented,
neither is this.

Recommendation: accept the window (option a in the originating brief), not a
hotfix lane that bypasses the integration branch for enforcement changes
(option b). No in-mission enforcement can close this window because the
enforcement code itself is what is not live yet. The guard lives only on the
mission's own unmerged branch until its own PR merges to trunk AND that merge
deploys, and by construction a mission's task PRs run before its own aggregate
PR exists at all. A bypass lane was rejected because it reintroduces, for
exactly the class of change where getting it right matters most, the failure
mode integration branches exist to prevent: a task PR landing on trunk without
the mission's own aggregate review.

**Invariants**:
- What closes the window is not prevention but visibility: a self-enforcing
  mission stating a `released` criterion (D-2) means its own
  `canCompleteMission` refuses `completed` for as long as the guard is merged
  but not yet shipped, turning a silent gap into a named, visible refusal
  (`criteria_failed`, with evidence naming the criterion) rather than a mission
  that reads `completed` while the thing it built is still inert.
- This does not eliminate the window during which the mission's own task PRs
  are unprotected by their own guard. It ensures the mission cannot be
  mistaken for "verified" while that window is open.

**Target checks** (not graded until D-6 is built):
- GIVEN a mission whose deliverable is a merge-enforcement change and
  which states a `released` criterion covering itself WHEN that change has
  merged to trunk but not yet shipped in a healthy release THEN the mission
  stays `active` with a criteria-blocked code, even though every task is
  terminal and the mission PR is merged.
- GIVEN the same mission once the enforcing release reaches
  `healthy` THEN `canCompleteMission` passes and the mission completes.

---

## Code surface

- Completion predicate: `apps/web/src/lib/mission-completion.ts`:
  `canCompleteMission`, `completeMissionIfVerified`, `attemptMissionRelease`
- Integration base: `packages/core/mission-integration.ts`:
  `missionIntegrationBase`, `isMissionIntegrationBase`
- Release trigger: `apps/web/src/lib/mission-release.ts`:
  `fireMissionReleaseIfComplete`, `countPendingTasksForMission`,
  `claimMissionReleaseAttempt`, `commitMissionRelease`,
  `abandonMissionReleaseAttempt`; `apps/web/src/lib/release-completion-policy.ts`:
  `releasePolicy`
- Mission PR ownership: `apps/web/src/lib/mission-pr.ts`:
  `findMissionPrOwner`, `guardMissionPrMerge`, `evaluateMissionWorkState`;
  `finalizeMissionPrMerge`
- Production-status derivation: `apps/web/src/lib/mission-production-status.ts`:
  `loadMissionProductionStatus`, `classifyMissionProductionStatus`
- Commit attribution: `packages/core/release-attribution.ts`:
  `attributeRelease`
- Mechanical criteria evaluator: `packages/core/mission-helpers.ts`:
  `evaluateGoalCriteria` (the `all_prs_merged` arm is the existing precedent
  for Option A'-aware evaluation); `apps/web/src/lib/mission-criteria-eval.ts`:
  `isLlmEligible`
- Workflow-run mapping: `apps/web/src/lib/release/workflow-run.ts`:
  `mapWorkflowConclusionToReleaseState`
- Webhook reaction: `apps/web/src/lib/release/subscribers.ts`: the
  `task.pr_merged` subscriber's `on_mission_complete` branch (Path B) and the
  `workflow_run.completed` subscriber (`advanceReleaseStateFromWorkflowRun`)
- Merge-time CI/tier resolution: `apps/web/src/lib/auto-merge.ts`
- Criterion types: `packages/shared/src/types.ts`: `GoalCriterion`,
  `GoalCriterionType`, `CriterionVerdict`

## Out of scope

- Retroactively fixing missions that already completed under the old,
  looser predicate.
- `sync-dev` force-reset semantics.
- Building a new git-ancestry mechanism for D-2: the existing
  commit-attribution pipeline is reused instead (see D-2's rationale).
- The metric-query registry (`metric` criterion type remains rejected at
  the write boundary, unrelated to `released`).

## Renumbered

Decisions 1 to 6 became D-1 to D-6. Criteria: AC-RG-1 to AC-RG-4 became
the new AC-1 to AC-4; AC-RG-9 became AC-7; AC-RG-10 became AC-8. The new
criteria AC-5, AC-6, AC-9 and AC-10 were added. The old AC-RG-5 to AC-RG-8
and AC-RG-11 to AC-RG-16 belong to decisions that are not built and
are now unnumbered target checks under D-2, D-4, D-5 and D-6.
