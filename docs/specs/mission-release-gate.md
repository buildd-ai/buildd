---
title: Mission Release Gate
status: draft
owner: max
last_verified: 2026-09-10
summary: For a mission with an integration base, canCompleteMission, the on_mission_complete release trigger, and the goal-criteria evaluator MUST all treat production release as the single, shared definition of mission "done".
domain: releases
surfaces: [apps/web/src/lib/mission-completion.ts, apps/web/src/lib/mission-release.ts, apps/web/src/lib/mission-pr.ts, apps/web/src/lib/mission-production-status.ts]
related: [mission-task-lifecycle, release-flow, pr-lifecycle-reconciliation]
keywords: [on_mission_complete, canCompleteMission, findMissionPrOwner, released criterion, integration branch, dev to main, workflow_run skipped, self-referential guard, integration_pr_unmerged]
supersedes: []
---

# Mission Release Gate

**Capability statement**: A mission with an integration base ships through a
fixed line — task PRs merge into the integration branch, the integration
branch merges into trunk through exactly one PR, and trunk deploys to
production through a release. "Complete" may be asserted at exactly one point
on that line, and `canCompleteMission`, the `on_mission_complete` release
trigger, and the goal-criteria evaluator MUST all read the same point. None of
the three may treat an earlier point — every deliverable task's PR merged into
the integration branch, or the mission's own PR merged into a non-production
branch — as this mission class's "done".

This spec formalizes a gap two independent investigations found with live
evidence: an `on_mission_complete` release firing while a mission's actual
code sat only on an unreleased integration branch, and a mission whose sole
deliverable was a merge-enforcement guard closing as "verified" while that
guard itself had not yet reached the server it was meant to run on. Both are
instances of the same root cause — the platform has more than one place that
answers "is this mission done?", and they do not all ask the strict question.

Status is `draft`: the invariants below describe target behaviour and name the
one new refusal code, one new goal-criterion type, and two changed call sites
this requires. None of it is implemented yet. Promote to `active` once the
call sites below exist and are covered by tests named in `verified_by`.

---

## The ship-line invariant

**Invariants**:
- A mission's `integrationBranchEnabled` flag (`missions` table) decides which
  line applies. `false`/absent (the `direct` strategy) is unaffected by this
  spec — a task PR there already targets trunk directly, and the existing
  per-deliverable `awaiting_merge` check (`mission-task-lifecycle.md`, Mission
  Completion Gate) is the whole story.
- For `integrationBranchEnabled = true` (the `mission-branch` strategy), "done"
  is defined as: the mission's own PR (`findMissionPrOwner`,
  `apps/web/src/lib/mission-pr.ts`) has `state = 'merged'`, **and** — wherever a
  caller is asserting shipped rather than merely merged — that merge is
  contained in a release that reached `state = 'healthy'`. "Merged" and
  "shipped" are deliberately kept as two distinct, separately checkable facts
  (Decisions 1 and 2 below); collapsing them into one check is what let a
  release fire on data that had only reached the first fact.
- Every one of the following MUST read the same fact through the same
  accessor, never re-derive it: `canCompleteMission` (all callers — heartbeat,
  dormancy, the independent evaluation task, the on-demand evaluate route),
  the `on_mission_complete` release trigger (both call sites —
  `fireMissionReleaseIfComplete` and the `pull_request merged` webhook path),
  and a mission's `released` goal criterion (Decision 2). A caller that reads
  only `countPendingTasksForMission` (task terminality) without also reading
  this fact is answering a different, weaker question and MUST NOT be trusted
  as a completion or release gate for an integration-base mission.

---

## Decision 1 — `canCompleteMission` gates on the mission PR's merge state

**Capability statement**: For an integration-base mission,
`canCompleteMission` MUST refuse completion until the mission's own PR has
merged into trunk, independent of whether the mission happens to have stated
an `all_prs_merged` goal criterion.

Today, `canCompleteMission`'s `awaiting_merge` check walks deliverable tasks
only (`isDeliverableTask`). The mission-PR-owner task is created by
`openMissionIntegrationPr` as a `bookkeeping`-class row specifically so
merge-surface tooling can find it — the same classification that makes
`isDeliverableTask` exclude it from every deliverable-scoped check. The result
is a mission with every deliverable's PR merged into the integration branch,
zero pending tasks, and no goal criteria stated can pass `canCompleteMission`
today with its own PR still open, because nothing in the default (no
criteria) path ever looks at `findMissionPrOwner`. `evaluateGoalCriteria`'s
`all_prs_merged` arm already asks the right question and already accounts for
Option A' correctly (it requires the mission PR's base ref to show it landed
outside the integration branch before passing) — but only for a mission that
explicitly stated `all_prs_merged`. A mission with no stated criteria, or
criteria that don't include it, has nothing checking this today.

**Invariants**:
- For any mission with `integrationBranchEnabled = true`, `canCompleteMission`
  MUST call `findMissionPrOwner(missionId)` and refuse with a new code
  `integration_pr_unmerged` whenever the owner is absent or its `state` is not
  `'merged'`. This check is unconditional — it does not depend on `goalCriteria`
  containing `all_prs_merged`, and it runs even when `goalCriteria` is empty
  (today's "zero criteria means no gate" rule for goal criteria is unchanged;
  this is a structural gate, not a stated one).
- The check is placed in the refusal order immediately after `awaiting_merge`:
  `mission_not_found` → `mission_not_active` → `pending_deliverables` →
  `no_deliverables` → `infra_stalled` → `awaiting_merge` →
  `integration_pr_unmerged` → `criteria_failed` / `criteria_pending` /
  `criteria_unverified`. Deliverable PRs merging into the integration branch is
  a precondition for the mission PR existing at all, so checking them first
  gives the more specific, actionable refusal.
- `fireMissionReleaseIfComplete` and the webhook's `on_mission_complete` block
  both already call `canCompleteMission` with `evaluateCriteria: false` — no
  new call site is required for the release trigger; both inherit this fix
  automatically once the predicate itself covers it, because they read the
  predicate's `ok` field and nothing else.
- Missions with `integrationBranchEnabled` false/absent are untouched:
  `findMissionPrOwner` MUST NOT be queried for them, and behaviour is
  byte-identical to before this spec.

**Acceptance criteria**:
- AC-RG-1: GIVEN a mission with `integrationBranchEnabled = true`, every
  deliverable task's PR merged into the integration branch, no mission-PR-owner
  task yet, and no stated `goalCriteria` WHEN `canCompleteMission` runs THEN it
  refuses with `code = 'integration_pr_unmerged'`.
- AC-RG-2: GIVEN the same mission WHEN its mission PR later merges into trunk
  THEN a subsequent `canCompleteMission` call no longer refuses on this code.
- AC-RG-3: GIVEN a mission with `integrationBranchEnabled = true` and its
  mission PR merged into trunk WHEN a task completion triggers
  `fireMissionReleaseIfComplete` THEN the release fires only once this check
  has already passed — never on a merge event earlier than the mission PR's own
  merge.
- AC-RG-4: GIVEN a mission with `integrationBranchEnabled` false WHEN
  `canCompleteMission` runs THEN `findMissionPrOwner` is not queried and the
  decision is unchanged from current behaviour.

---

## Decision 2 — a `released` goal-criterion type

**Capability statement**: A mission MAY gate its own completion on production
release, not merely trunk merge, via a new mechanical `GoalCriterion` type,
`released`.

**Invariants**:
- New `GoalCriterionType` value: `{ type: 'released', label?: string }`. No
  other fields — the mission being evaluated is implicit.
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
  numbers out of merge- and squash-commit messages — not via comparing
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
  on a mission whose `integrationBranchEnabled` is not `true` — that mission
  has no single owning PR for `loadMissionProductionStatus` to check, so the
  criterion would read `unavailable` forever, exactly the "criterion that can
  never resolve" case `metric` is already rejected for.
- `released` is mechanical: `isLlmEligible('released')` MUST be `false`, and
  unlike `command` it MUST NOT dispatch a verification task — the verdict is
  answered by the same DB round-trip `all_prs_merged` already uses.
- Policy, not a mechanical write-time requirement: a mission whose deliverable
  changes merge/claim/release enforcement itself SHOULD state a `released`
  criterion (carried as guidance in the default Organizer role prompt,
  `apps/web/src/lib/default-roles.ts`) — "this mission changes enforcement
  code" is not a predicate the platform can decide from task rows alone, so
  this is convention, not validation. Any mission MAY opt in regardless of
  subject matter.

**Acceptance criteria**:
- AC-RG-5: GIVEN a mission with `integrationBranchEnabled = true`,
  `goalCriteria: [{ type: 'released' }]`, and a merged mission PR whose commit
  is not yet attributed to any `healthy` release WHEN criteria are evaluated
  THEN the criterion reads `fail` and the mission does not complete.
- AC-RG-6: GIVEN the same mission WHEN a release reaches `healthy` with a
  `release_tasks` row attributing the mission-PR-owner task to it THEN the
  criterion reads `pass` on the next evaluation.
- AC-RG-7: GIVEN `POST /api/missions` with `goalCriteria: [{ type: 'released'
  }]` and `integrationBranchEnabled` not `true` THEN the request is rejected
  with HTTP 400 naming why (no single owning PR to check).
- AC-RG-8: GIVEN a `released` criterion WHEN criteria evaluation runs THEN no
  verification or grading task is dispatched.

---

## Decision 3 — one path dispatches dev→main

**Capability statement**: Exactly one code path performs the dev→main
dispatch that follows a mission's own PR merging, regardless of which of the
existing call sites observes that merge first.

**Invariants**:
- The dispatch is owned by the GitHub `pull_request merged` webhook handler,
  triggered by the merge of the mission-PR-owner task's own PR — the event
  that literally IS "this mission's work reached trunk" — reusing the existing
  atomic claim (`claimMissionReleaseAttempt` / `commitMissionRelease` /
  `abandonMissionReleaseAttempt` on `missions.releasedAt` /
  `releaseAttemptedAt`).
- `fireMissionReleaseIfComplete` (called from `workers/[id]/route.ts` on every
  task completion) is NOT removed as a call site — Decision 1 makes it
  correctly inert until the mission PR has merged, at which point it and the
  webhook race for the same `releasedAt` claim exactly as any two concurrent
  callers do today. The existing atomic claim already resolves that race to
  exactly one winner; Decision 3 does not add a second dedup mechanism, it
  relies on Decision 1 to make both existing call sites agree on WHEN they are
  allowed to win it.
- The heartbeat/cron mission-loop paths MUST NOT call anything that dispatches
  a release directly. They may call `canCompleteMission` /
  `completeMissionIfVerified`, which decide `missions.status` only.

**Acceptance criteria**:
- AC-RG-9: GIVEN the mission-PR-owner task's PATCH to `completed` and the
  GitHub `pull_request merged` webhook for the same PR arriving within the
  same second WHEN both attempt `claimMissionReleaseAttempt` THEN exactly one
  wins and exactly one release row is created for the mission.
- AC-RG-10: GIVEN a mission with `integrationBranchEnabled = true` and its
  mission PR still open WHEN the heartbeat cron tick runs and every task row
  happens to be terminal THEN no release dispatch is attempted.

---

## Decision 4 — a `skipped` workflow run is not a failed release

**Capability statement**: A GitHub Actions run that concludes `skipped` MUST
be recorded as "did not ship, safe to retry" — never as `failed`.

`mapWorkflowConclusionToReleaseState` (`apps/web/src/lib/release/workflow-run.ts`)
currently maps every conclusion other than `success` / `null` /
`action_required` to `failed`, which includes `skipped`. A `skipped`
conclusion means the workflow's own internal gate (for example, an
empty-commit check) decided there was nothing to ship — it is not a dispatch
failure, and treating it as one produces a false "release failed" record for
a run that, correctly, did nothing.

**Invariants**:
- `conclusion = 'skipped'` MUST NOT set `releases.state = 'failed'`.
- On `conclusion = 'skipped'`, the owning mission's release-attempt claim MUST
  be released via the existing `abandonMissionReleaseAttempt(missionId,
  'skipped', reason)` path — the `'skipped'` member of `MissionReleaseFailure`
  already exists in `mission-release.ts` for precisely this outcome; today
  nothing on the `workflow_run` webhook path ever reaches it.
- This is distinct from `force: true` bypassing the empty-commit check at
  dispatch time (`release-flow.md`, `workflow_dispatch` path): Decision 4
  governs how the RESULT of a run that decided to skip is recorded, not
  whether the skip itself was avoidable.

**Acceptance criteria**:
- AC-RG-11: GIVEN a `workflow_run` webhook with `conclusion = 'skipped'` for a
  release row in `dispatched`/`deploying` state WHEN
  `advanceReleaseStateFromWorkflowRun` runs THEN `releases.state` is not set to
  `failed`, and the owning mission's attempt claim is abandoned with reason
  `'skipped'`.
- AC-RG-12: GIVEN the same mission after a skip is recorded WHEN its next
  qualifying event occurs (a later task completion, or its mission PR merging)
  THEN a release dispatch is attempted again — the mission is not permanently
  blocked by the earlier skip.

---

## Decision 5 — trunk CI red at mission-PR-merge time

**Capability statement**: An unattended merge of a mission's PR into trunk
MUST be refused while trunk's own most recent commit has a failing CI status.

**Invariants**:
- `guardMissionPrMerge` (`apps/web/src/lib/mission-pr.ts`) gains a second,
  independent refusal alongside its existing "a sibling task PR based on the
  integration branch is still open" check: the workspace's trunk branch's
  latest commit has a combined check-runs state other than success.
- Recommended over "merge and ship red": landing a mission's aggregate change
  on top of an already-broken trunk compounds the failure and makes the
  eventual bisection ambiguous between the mission's change and the
  pre-existing break.
- Escape hatch: an explicit human-initiated merge (the dashboard merge action,
  or an equivalent explicit override) MAY bypass this specific refusal — the
  same shape of override `metric`less criteria already use elsewhere in the
  gate chain (an explicit action, recorded, not a silent default). An
  unattended path (the auto-merge webhook) MUST NOT bypass it.
- Orthogonal to the PR's own CI status, which `auto-merge.ts` already checks
  before any merge — this decision is about trunk's HEAD state, not the PR's
  diff.

**Acceptance criteria**:
- AC-RG-13: GIVEN the workspace's trunk branch's latest commit has a failing
  combined CI status WHEN the auto-merge path attempts to merge a mission PR
  into trunk THEN the merge is refused, naming the failing check.
- AC-RG-14: GIVEN the same trunk state WHEN a human explicitly merges via the
  override path THEN the merge proceeds and the override is recorded.

---

## Decision 6 — a mission cannot fully protect its own task PRs

**Capability statement**: When a mission's own deliverable is the
merge/claim/release guard that would otherwise protect it, the mission MUST
NOT be able to represent itself as verified before that guard is actually
enforcing in production — even though the window in which it cannot protect
itself cannot be closed by more code inside the mission itself.

Recommendation: accept the window (option a in the originating brief), not a
hotfix lane that bypasses the integration branch for enforcement changes
(option b). No in-mission enforcement can close this window because the
enforcement code itself is what is not live yet — the guard lives only on the
mission's own unmerged branch until its own PR merges to trunk AND that merge
deploys, and by construction a mission's task PRs run before its own aggregate
PR exists at all. A bypass lane was rejected because it reintroduces, for
exactly the class of change where getting it right matters most, the failure
mode integration branches exist to prevent: a task PR landing on trunk without
the mission's own aggregate review.

**Invariants**:
- What closes the window is not prevention but visibility: a self-enforcing
  mission stating a `released` criterion (Decision 2) means its own
  `canCompleteMission` refuses `completed` for as long as the guard is merged
  but not yet shipped — turning a silent gap into a named, visible refusal
  (`criteria_failed`, with evidence naming the criterion) rather than a mission
  that reads `completed` while the thing it built is still inert.
- This does not eliminate the window during which the mission's own task PRs
  are unprotected by their own guard. It ensures the mission cannot be
  mistaken for "verified" while that window is open.

**Acceptance criteria**:
- AC-RG-15: GIVEN a mission whose deliverable is a merge-enforcement change and
  which states a `released` criterion covering itself WHEN that change has
  merged to trunk but not yet shipped in a healthy release THEN the mission
  stays `active` with a criteria-blocked code, even though every task is
  terminal and the mission PR is merged.
- AC-RG-16: GIVEN the same mission once the enforcing release reaches
  `healthy` THEN `canCompleteMission` passes and the mission completes.

---

## Code surface

- Completion predicate: `apps/web/src/lib/mission-completion.ts` —
  `canCompleteMission`, `completeMissionIfVerified`
- Release trigger: `apps/web/src/lib/mission-release.ts` —
  `fireMissionReleaseIfComplete`, `countPendingTasksForMission`,
  `claimMissionReleaseAttempt`, `commitMissionRelease`,
  `abandonMissionReleaseAttempt`
- Mission PR ownership: `apps/web/src/lib/mission-pr.ts` —
  `findMissionPrOwner`, `guardMissionPrMerge`, `finalizeMissionPrMerge`
- Production-status derivation: `apps/web/src/lib/mission-production-status.ts`
  — `loadMissionProductionStatus`, `classifyMissionProductionStatus`
- Commit attribution: `packages/core/release-attribution.ts` —
  `attributeRelease`
- Mechanical criteria evaluator: `packages/core/mission-helpers.ts` —
  `evaluateGoalCriteria` (the `all_prs_merged` arm is the existing precedent
  for Option A'-aware evaluation); `apps/web/src/lib/mission-criteria-eval.ts`
  — `isLlmEligible`
- Workflow-run mapping: `apps/web/src/lib/release/workflow-run.ts` —
  `mapWorkflowConclusionToReleaseState`
- Webhook dispatch: `apps/web/src/app/api/github/webhook/route.ts` —
  the `pull_request` merged handler's `on_mission_complete` block,
  `advanceReleaseStateFromWorkflowRun`
- Merge-time CI/tier resolution: `apps/web/src/lib/auto-merge.ts`
- Criterion types: `packages/shared/src/types.ts` — `GoalCriterion`,
  `GoalCriterionType`, `CriterionVerdict`

## Out of scope

- Retroactively fixing missions that already completed under the old,
  looser predicate.
- `sync-dev` force-reset semantics.
- Building a new git-ancestry mechanism for Decision 2 — the existing
  commit-attribution pipeline is reused instead (see Decision 2's rationale).
- The metric-query registry (`metric` criterion type remains rejected at
  the write boundary, unrelated to `released`).
