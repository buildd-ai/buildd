---
title: Mission State and Completion
status: active
owner: max
last_verified: 2026-10-17
summary: Missions MUST derive health from live work and refuse completion without passing goal criteria and required reviews.
domain: missions
surfaces: [apps/web/src/lib/mission-completion.ts, packages/core/mission-helpers.ts, apps/web/src/lib/review-verdict-gate.ts, apps/web/src/lib/mission-dependency-gate.ts]
related: [task-state-machine, claim-gate-legibility, organizer-context, mission-surface-audit]
verified_by: [apps/web/src/lib/mission-completion.test.ts, apps/web/src/lib/review-verdict-gate.test.ts, apps/web/src/lib/pr-supersession.test.ts, apps/web/src/lib/mission-dependency-gate.test.ts, apps/web/src/lib/mission-dependency.test.ts]
assertions:
  - id: "completion-gate"
    type: "symbol"
    name: "canCompleteMission"
    path: "apps/web/src/lib/mission-completion.ts"
  - id: "criteria-evaluation"
    type: "symbol"
    name: "evaluateGoalCriteria"
    path: "packages/core/mission-helpers.ts"
  - id: "completion-gate-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-completion.test.ts"
  - id: "review-verdict-gate"
    type: "symbol"
    name: "evaluateReviewVerdictGate"
    path: "apps/web/src/lib/review-verdict-gate.ts"
  - id: "review-verdict-gate-tests"
    type: "test_file"
    path: "apps/web/src/lib/review-verdict-gate.test.ts"
  - id: "pr-supersession-write"
    type: "symbol"
    name: "recordPrSupersession"
    path: "apps/web/src/lib/pr-supersession.ts"
  - id: "pr-supersession-tests"
    type: "test_file"
    path: "apps/web/src/lib/pr-supersession.test.ts"
  - id: "pr-shipped-predicate"
    type: "symbol"
    name: "prShipState"
    path: "packages/core/pr-shipped.ts"
  - id: "pr-shipped-tests"
    type: "test_file"
    path: "packages/core/__tests__/pr-shipped.test.ts"
  - id: "dependency-gate"
    type: "symbol"
    name: "evaluateUpstreamGate"
    path: "apps/web/src/lib/mission-dependency-gate.ts"
  - id: "dependency-gate-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-dependency-gate.test.ts"
  - id: guard-1
    type: test_file
    path: apps/web/src/lib/mission-completion.test.ts
  - id: guard-2
    type: test_file
    path: apps/web/src/lib/review-verdict-gate.test.ts
  - id: guard-3
    type: test_file
    path: apps/web/src/lib/pr-supersession.test.ts
---
# Mission State and Completion

**Capability statement**: Missions MUST derive health from live work and refuse completion without passing goal criteria and required reviews.

## Mission State Machine

**States**: `active` → `paused` → `active` (reversible) | `completed` →
`archived`

Mission `status` is stored in `missions.status`. Mission **health** is NEVER
stored — it is derived on read from the state of associated tasks via
`deriveMissionHealth` / `isDeliverableTask`.

**Invariants**:
- Mission status transitions (`active ↔ paused`, `active → completed`,
  `completed → archived`) are driven by human action (dashboard or MCP) or
  mission loop evaluation tasks — not by any automatic side effect.
- Every automated `active → completed` transition MUST go through
  `completeMissionIfVerified`, which is the only automated writer of
  `missions.status = 'completed'`. An agent's `missionComplete = true` — from the
  heartbeat, a planning task, or the independent evaluation task — is a PROPOSAL
  that this function may refuse.
- Health is computed from deliverable tasks only (`isDeliverableTask` filters out
  `kind = 'coordination'`, `mode = 'planning'`, and housekeeping titles).
- A paused mission MUST NOT spawn new tasks from its schedule while paused.
  Nor does it get unsolicited integration-branch refresh work: the backstop skips
  a paused, held or budget-exhausted mission, and only a start (the resume) or
  the kernel's landing refreshes it (`mission-branch-refresh.md`, Eligibility).
- A mission's `activeHoursStart/End/Timezone` fields restrict when its heartbeat
  schedule fires. When set, the cron skips firing outside the active window.
  `activeHours` gates firing cadence only — it does NOT change mission status.
  A `completed` or `paused` mission with `activeHours` set MUST NOT treat the
  active-hours window as a resume signal.
- **One task, one branch, one PR — in every branch shape.** Tasks under a mission
  MUST NOT share a branch and MUST NOT be represented by a single PR.
  `missions.workingBranch` is the mission's *integration* branch (shape
  `mission/<slug>-<id8>`), and it is the **base** of the mission's task PRs only
  when that mission has opted in (`missions.integrationBranchEnabled`, resolved
  once at mission creation from the request's `branchStrategy` or the
  workspace's configured default). Both the flag and the branch name MUST be
  written in the same operation that creates the mission, and the ref MUST be
  ensured on the remote there too: a mission-branch mission must never exist in
  the enabled-but-inert state where a task can be claimed before its base
  exists. For an opted-in mission, task PRs merge into the integration
  branch and the mission's work reaches trunk through exactly one PR from that
  branch — the mission integration PR, which is the mission's single human gate.
  That PR is opened automatically: the `pull_request` webhook calls
  `maybeOpenMissionIntegrationPr` when a task PR merges, and
  `openMissionIntegrationPr` opens it once every deliverable task of the mission is
  terminal and every deliverable PR has merged into the integration branch. For every
  other mission, each task PR targets the workspace's trunk branch
  and `workingBranch` retargets nothing.
- **A task PR's base is refused at every door, not only at the front one.** For a
  task whose mission has an integration base, a pull request whose base is not
  that branch MUST be refused wherever buildd would otherwise record it against
  the worker: PR creation (`create_pr`), adoption of a caller-supplied `prUrl`,
  adoption of a PR that already exists on the worker's branch, and the
  completion handler's GitHub auto-detect. A base buildd cannot read is illegal —
  unknown MUST NOT resolve to a passing check. The `pull_request` webhook cannot
  refuse anything, so its enforcement form is repair: when a task PR is observed
  based off the integration branch, buildd retargets it back and announces it,
  falling back to the lost-gate report when the branch no longer exists. The
  exemptions are exactly those of the base derivation itself — the mission-PR
  owner task (`MISSION_PR_TASK_PREFIX`, whose base IS trunk by design), a
  stacked-plan phase (`isStackedPhaseBase`), a mission with no integration base,
  and a task with no mission.
- **A merged mission PR is one delivery, not the mission** (`workflow-kernel-library.md`
  §6, task `f3bda4e1`). Each integration branch and its PR into trunk is a
  delivery epoch the kernel records (`workflow_mission_epochs`). When one merges
  with work left, the mission rotates to exactly one successor delivery on a new
  branch (`<branch>-delivery-<n>`) cut from the merge commit, and
  `missions.workingBranch` moves to it in the same statement; every later task PR
  bases on it, and a task filed under the merged delivery is claimed onto it.
  The merged branch is deleted only after the PRs left on it are settled
  (`mission-branch-refresh.md`, "Settlement before branch retirement"), never at
  merge. Mission completion is held while the writable delivery carries landed
  work that has not reached trunk; "a mission PR merged" is never sufficient on
  its own, and the mission's goal criteria still decide after that.
- **The mission PR MUST NOT merge while the mission's work is unfinished.**
  Merging it retires the integration branch once the PRs left on it are settled
  (`finalizeMissionPrMerge` records the merge with the kernel), so the gate in front of that merge
  (`guardMissionPrMerge`, shared by all three merge call sites) asks whether the
  mission's work is finished — NOT merely whether any task PR is open. It MUST
  refuse while any deliverable task of the mission is in a non-terminal state
  (`pending` / `assigned` / `in_progress`) and has not landed a PR, as well as
  while a deliverable PR is open, and the refusal MUST name what holds it.
  Bookkeeping rows (including the mission-PR owner itself, which would make the
  gate self-referential), `attempt` rows (reviewer / CI-retry / conflict-retry),
  planning rows and cancelled tasks MUST NOT hold the gate — cancelling is a
  decision that the work will not happen, not an absence of one.
- **A task whose integration base no longer exists MUST still be able to
  deliver.** When a mission task's PR is created and the mission's integration
  branch is absent from the remote, buildd MUST re-cut that branch from trunk
  and proceed, so the mission keeps reaching trunk through one merge per round
  of work (a second mission PR, which `openMissionIntegrationPr` already
  supports by design). Only when the branch can neither be found nor created
  MAY the PR fall back to trunk. Either outcome MUST be recorded as a mission
  note; neither may be silent, and neither may leave the worker with no way to
  open its PR. Existence MUST be read live from GitHub (`GET
  /repos/{repo}/git/ref/heads/{branch}`), never from a local remote-tracking
  ref, which reports a deleted branch as present until something prunes it.
- **The prompt and the guard MUST read the same source for the delivery base.**
  One function — `resolveTaskPrBase` in `packages/core/mission-integration.ts` —
  answers "what base does this task's PR take", and both the runner's Git
  Workflow prompt block and the `create_pr` derivation MUST call it. A worker
  cannot tell a wrong instruction from a wrong refusal from inside its sandbox,
  so a divergence there is unrecoverable without a human.
- `missions.primaryPrNumber`/`primaryPrUrl` MUST only ever be claimed by a PR
  whose base ref is a trunk branch of the workspace (`gitConfig.targetBranch`,
  `gitConfig.defaultBranch`, or the repo default). A PR based on the mission
  integration branch — i.e. any task PR under an opted-in mission — MUST NOT
  claim the slot, and an unknown base ref MUST NOT claim it either. The slot
  therefore names the mission integration PR wherever one exists.
- For workspace-less missions (`workspaceId = null`), `workingBranch` and
  `primaryPrNumber`/`primaryPrUrl` are always null (no repo, no PRs).
- **A PR carrying an outstanding non-approve verdict, or a review round still
  in flight, MUST NOT merge through any buildd door.** The rule lives once, in
  `apps/web/src/lib/review-verdict-gate.ts`, and every door asks it —
  `merge_pr`, the unattended auto-merge path (`tryAutoMergeWorkerPr`, reached by
  the CI-green webhook, the no-CI webhook and the reviewer approve handler), the
  dashboard merge route, and release promotion. It applies at EVERY tier, not
  only `agent-review`: a task PR based on the mission integration branch
  resolves to `auto-threshold` by construction while
  `requestIntegrationBranchReview` dispatches a reviewer at it on purpose, so a
  tier-conditional check leaves the Option A′ population ungated.
  - A `request-changes`/`escalated` verdict blocks regardless of whether a
    later push moved the head — a push is no longer, on its own, treated as
    proof the finding was addressed. The webhook re-dispatches a reviewer on
    `synchronize` whenever the PR carries exactly that kind of terminal
    verdict (`maybeReDispatchReviewer`), and `readPrReviewStatus` reads the
    newest reviewer task, so a fresh round simply replaces the stale verdict
    once it lands; until it does, the gate keeps blocking. This closes the
    incident shape the gate exists to prevent: a merge landing on the exact
    commit a reviewer had just rejected, because an unrelated earlier push had
    already made the SHAs differ.
  - An `approved` verdict is the opposite default — it passes unless a later
    push is PROVABLY a different commit from the one approved, in which case
    it blocks as `stale_approval`. Unlike the block kinds above, this is not
    re-dispatched on push (re-reviewing every push after every approval would
    fire far more often, since most approved PRs merge before another push
    lands) — the gate itself is the explicit recorded decision that the
    approval no longer covers what would merge. The re-review is sent at merge
    time instead: when an unattended merge attempt (`tryAutoMergeWorkerPr`, or
    `landPr`'s `re_review` fix) hits `stale_approval` after carry-forward
    failed, it dispatches a delta re-review through `resolveReReviewPlan` and
    `createReviewerTask` (`stale-approval-re-review.ts`), single-flight per PR
    and head. A human or a fresh re-review request can still clear it sooner.
    Exception: a push that leaves the PR's own
    diff unchanged (rebase or base merge — `base...sha` compared at both
    commits, hunk positions ignored) is recorded on the approving review as
    `context.equivalentHeadShas`, and the gate treats those heads as covered
    (`approval-carry-forward.ts`). A forced or dashboard re-review of such a
    head carries the approval forward instead of dispatching a reviewer.
    Unverifiable comparisons (read failure, truncated file list, binary
    patch) are not equivalent. Only `approve` carries forward.
  - If either commit is unknown, or the review status cannot be read, the gate
    fails closed for every kind above EXCEPT `stale_approval`, which starts
    from a pass and so treats an unprovable comparison as "cannot show this
    approval is stale" rather than manufacturing a block. Same doctrine as the
    CI read in `evaluateAutoMergeSafety`.
  - `review_failed` (a reviewer that produced no verdict) does NOT block: there
    is no finding to protect, nothing can clear it, and it has its own
    escalation (`escalateReviewContractFailure`).
  - A refusal MUST name the blocking verdict and what would clear it, and MUST
    land in the gate ledger under `review_verdict` — never a silent no-op.
  - A human MAY override, and only from the dashboard route, where a person is
    present; the override is recorded as a `bypassed` ledger row plus the
    existing mission note and PR activity entry. Nothing unattended may override
    a verdict.
- **The verdict that applies is the one the gate reads.** When
  `enforceServerSideEscalation` turns a model `approve` into an `escalate`, the
  effective verdict MUST be persisted (`tasks.result.effectiveVerdict`) so
  `derivePrReviewStatus` reports `escalated`. Leaving only the agent's raw
  output makes a server-escalated PR read as `approved` to both the self-merge
  check and this gate.

**Acceptance criteria**:
- AC-8: GIVEN a mission with all tasks `completed` WHEN health is derived THEN
  the health reflects 100% completion (no failed deliverable tasks).
- AC-9: GIVEN a `planning` mode task linked to a mission WHEN health is derived
  THEN that task is excluded from the deliverable count.
- AC-10: GIVEN `missions.status = 'paused'` WHEN the cron schedule fires THEN
  no new task is created for that mission.
- AC-57: GIVEN an `active` mission with `activeHoursStart/End` set and the
  current time is outside the configured window WHEN the heartbeat fires THEN
  no new task is created. The mission remains `active` — `activeHours` is a
  firing gate, not a status transition.
- AC-11: GIVEN a mission with `requiresReview = true` WHEN a task PR is created
  THEN auto-merge is suppressed and human review is required before merging.
- AC-58: GIVEN two tasks under the same mission WHEN each opens a PR THEN the
  two PRs carry different head refs and different PR numbers — neither shape
  produces one PR for the mission's task work.
- AC-59: GIVEN a mission with `workingBranch` set WHEN a task PR based on that
  `workingBranch` is registered THEN `missions.primaryPrNumber` is NOT written
  and the rejection is recorded with the base ref that was seen; GIVEN the same
  registration with a base ref of the workspace trunk and `primaryPrNumber`
  still null THEN the slot is claimed.

- AC-60: GIVEN an opted-in mission with zero open task PRs and one deliverable
  task still `pending` WHEN the mission PR merge is attempted at any of the
  three merge call sites THEN it is refused, naming that task and its status;
  GIVEN the same mission with that task `cancelled` THEN the merge proceeds.
- AC-61: GIVEN an opted-in mission whose only non-terminal rows are
  bookkeeping, `attempt` or planning tasks WHEN the mission PR merge is
  attempted THEN it proceeds.
- AC-62: GIVEN a task whose mission has an integration base that is absent
  from the remote WHEN `create_pr` runs THEN the branch is re-cut from trunk,
  a mission note records it, and the PR opens against the integration branch;
  GIVEN the branch cannot be created either THEN the PR opens against trunk, a
  mission note records the breach, and the call does NOT fail.
- AC-63: GIVEN any task WHEN the runner builds its Git Workflow prompt and
  `create_pr` derives the PR base THEN both report the same base, because both
  call `resolveTaskPrBase` with the same mission and task.
- AC-64: GIVEN a PR whose latest review round ended `request-changes` (or
  `escalate`) at the PR's current head SHA WHEN a merge is attempted at any
  door — `merge_pr`, the unattended auto-merge path, the dashboard route, or
  release promotion — THEN it is refused, the refusal names the verdict and
  what would clear it, and a `review_verdict` row is written to the gate
  ledger. This holds under `auto-threshold` as well as `agent-review`.
- AC-65: GIVEN the same PR after a push moves its head SHA WHEN a merge is
  attempted THEN it is STILL refused — a push is no longer, by itself, treated
  as proof the finding was addressed. GIVEN the workspace's effective policy
  for that PR is `agent-review` THEN the `synchronize` webhook dispatches
  exactly one fresh reviewer round against the new head
  (`maybeReDispatchReviewer`), single-flight with the existing
  one-reviewer-per-PR rule, and inheriting the same retry-round budget the
  request-changes fix loop already tracks — so it is subject to the same
  round cap and escalates through the same path
  (`escalateReviewerExhaustion`) on exhaustion. GIVEN instead a later review
  round that ended `approve` at the PR's current head THEN the merge proceeds;
  GIVEN an `approve` recorded at an EARLIER head than the one being merged
  THEN it is refused as `stale_approval` instead — an approval is not silently
  re-used past the commit it was made against, and (unlike request-changes) is
  not re-dispatched on push but at the next unattended merge attempt, which
  sends one delta re-review per PR head — UNLESS the PR diff at the merged
  head is identical to the diff at the approved head, in which case the
  approval carries forward and the merge proceeds once CI is green.
- AC-66: GIVEN a blocking verdict WHEN a human merges from the dashboard with
  `override: true` THEN the merge proceeds and is recorded as a `bypassed`
  ledger row naming the overridden verdict and the person; GIVEN the same
  verdict on the unattended path THEN there is no override and the merge is
  deferred.

**Mission integration PRs: findings, repairs and every merge door (#4686).**
The contract is in `workflow-state-kernel.md` §13.13, which carries the full merge
door inventory (D1–D13) and AC-20 to AC-37. Its implementation is pending. It is
repeated here only where it changes mission rules:
- The door list in AC-64 names four doors, and that list is not all of them. The release executors,
  compose release, `merge_pr` with admin `force`, a policy-rule merge, and a manual
  merge on GitHub do not consult this gate today (§13.13 D5, D8–D12).
- A mission integration PR is owned by a `bookkeeping` task that does no work
  (`openMissionIntegrationPr`). A review fix for it MUST be a builder with the open
  findings as its description and a pinned `repairTarget`. It MUST NOT inherit the
  owner's "performs no work" description (§13.13 rule 3).
- A `COMMENTED` GitHub review is never an approval. buildd's verdict on its own PR
  posts as `COMMENTED` because GitHub refuses the alternative, so the verdict has to
  be visible as a status GitHub can require (§13.13 rule 7).
- A mission whose integration PR merged over open findings is not "shipped clean".
  The open findings stay attached, and one follow-up fix task against trunk is filed
  (§13.13 rule 10).

- AC-67: GIVEN a request-changes verdict on a mission integration PR owned by a
  `bookkeeping` task WHEN the fix task is created THEN its description lists the
  findings, does not contain "performs no work", and its context carries
  `repairTarget` for the integration branch head. Implementation pending.
- AC-68: GIVEN that fix task ends with zero diff THEN completion is refused and the
  verdict still blocks every door. Implementation pending.
- AC-69: GIVEN a mission integration PR merged on GitHub by a person while findings
  are open THEN the mission's PR is recorded merged over open findings, a fix task
  against trunk is filed under the mission, and `canCompleteMission` does not treat
  the findings as resolved. Implementation pending.

**Code surface**:
- Mission helpers: `packages/core/mission-helpers.ts` — `isDeliverableTask()`
- Mission context: `apps/web/src/lib/mission-context.ts`
- Mission API: `apps/web/src/app/api/missions/route.ts`,
  `apps/web/src/app/api/missions/[id]/route.ts`
- Integration branch generation: `apps/web/src/lib/mission-run.ts` — writes
  `missions.workingBranch` under `isNull` so the first writer wins
- Mission-PR slot gate: `apps/web/src/lib/mission-pr.ts` —
  `claimMissionPrimaryPr`, base ref checked against `trunkBranches`; called from
  `apps/web/src/app/api/github/pr/route.ts` and from the mission-PR opener, one
  implementation for both
- Mission integration PR: `apps/web/src/lib/mission-pr.ts` —
  `openMissionIntegrationPr` creates the `bookkeeping` task and worker row that
  own it, so every worker-keyed merge surface can see and merge it
- Option A′ predicates: `packages/core/mission-integration.ts` —
  `missionIntegrationBase`, `isMissionIntegrationBase`, `resolveTaskPrBase`
  (the one delivery-base answer, called by both the guard and the prompt)
- Mission-PR merge gate + branch lifecycle: `apps/web/src/lib/mission-pr.ts` —
  `evaluateMissionWorkState`, `guardMissionPrMerge`, `finalizeMissionPrMerge`
- Review-verdict merge gate: `apps/web/src/lib/review-verdict-gate.ts` —
  `evaluateReviewVerdictGate` (the pure rule), `guardReviewVerdict` (the read);
  called from `apps/web/src/lib/auto-merge.ts`,
  `apps/web/src/app/api/github/pr/route.ts` (PUT),
  `apps/web/src/app/api/prs/[prNumber]/merge/route.ts` and
  `apps/web/src/app/api/github/webhook/route.ts` (release promotion). The review
  state it reads comes from `apps/web/src/lib/pr-review-status.ts`
  (`derivePrReviewStatus`, including `reviewHeadSha` and `effectiveVerdict`)
- Integration-branch existence + re-cut:
  `apps/web/src/lib/mission-integration-branch.ts` —
  `ensureMissionIntegrationBranch`, `ensureIntegrationBaseForTaskPr`
- Delivery-base prompt block: `apps/runner/src/prompt-builder.ts` (Git Workflow
  section), fed the mission's integration fields by
  `apps/web/src/app/api/workers/claim/route.ts`
- Seeded planner rules for both shapes: `apps/web/src/lib/default-roles.ts`
  (Organizer, "Sequencing Rules")
- Schema: `packages/core/db/schema.ts` — `missions` table

---


## Mission Completion Gate

**Capability statement**: A mission MUST NOT reach `completed` without a passing
goal-criteria verdict; completion REQUESTS a verdict, the verdict GATES
completion, and the absence of a verdict is never a pass.

One predicate — `canCompleteMission(missionId)` — answers the question for every
caller: the heartbeat's `missionComplete` signal, the heartbeat prepass, the
dormancy check, the independent evaluation task, the on-demand criteria route,
and the `on_mission_complete` release trigger. It returns
`{ ok, code, reason, pendingDeliverables, pendingByStatus, pendingAllTasks,
awaitingMerge, awaitingMergeDetails, criteriaVerdict, ... }`, and
`completeMissionIfVerified` performs the write.

Refusal order (first failure is the reported `code`): `mission_not_found` →
`mission_not_active` → `pending_deliverables` → `no_deliverables` →
`infra_stalled` → `awaiting_merge` → `criteria_failed` / `criteria_pending` /
`criteria_unverified`.

**Invariants**:
- No completion path is exempt from the predicate. In particular the heartbeat
  is NOT an evaluation authority: it is an LLM reading a checklist and does not
  count task rows.
- A refused completion MUST be diagnosable. `completeMissionIfVerified` emits a
  `mission:completion_decision` Pusher event carrying the predicate inputs
  (pending count by status, criteria verdict, deciding path) for every decision
  it makes, allowed or refused, and logs the same payload. Callers that only READ
  the predicate (`canCompleteMission` direct, e.g. the release trigger) log but
  do not emit — they decided nothing.
- A mission whose work is done but whose criteria do not pass stays `active`
  (awaiting verification), and keeps its schedule enabled for as long as the
  verdict can still be acted on. It MUST NOT be auto-archived by
  `selectMissionsToArchive` while a stated criterion lacks a passing verdict. The
  one case that stands the schedule down is escalation to the owner — see
  *Blocked-Verdict Consumer* below; the mission stays `active` and un-archived
  there too, waiting on a person rather than on a cadence.
- Any non-terminal task that is not housekeeping blocks completion — `work` AND
  `attempt`, so a pending CI retry counts. Housekeeping rows (including a
  criterion's own verification task) MUST NOT block, or a `command` criterion
  would block on itself and the mission could never close.
- **A task's terminal status is not its terminal state — its PR's state is**
  (task facae217). A `completed` deliverable whose latest worker produced a PR
  that has not merged (`prUrl` set, `mergedAt` null — open, conflicted,
  CI-failing, or closed without merging) blocks completion with
  `code = 'awaiting_merge'`, naming the task title and PR number in `reason`
  and `awaitingMergeDetails`. This check runs BEFORE the `pending_deliverables`
  short-circuit would otherwise matter and before criteria evaluation, because
  `pending_deliverables` only ever sees non-terminal rows — a deliverable that
  already reached `completed` with an unmerged PR sails past it. It also runs
  regardless of whether criteria are stated or would pass: an unmerged PR means
  the deliverable did not ship, independent of what the criteria say. Observed
  as mission 50d29836 ("M4"): dormancy's own reason string read "All
  deliverables terminal; mission states no goal criteria" while the sole
  deliverable's PR sat open with a reviewer's "changes requested" verdict and a
  retry queued — dormancy is not exempt from this check any more than the
  heartbeat is; both route through the same predicate. The refusal note posts
  unconditionally for `awaiting_merge` (not gated on `opts.proposed`), unlike
  the criteria block notes, because dormancy never sets `proposed` and the
  M4 refusal must still be visible in the feed.
- The `awaiting_merge` gate does not distinguish "queued retry in flight" from
  "nobody has looked at it yet" — both are an unmerged PR on a completed task,
  and both block. A mission progress surface may render them differently (see
  `mission-structure-view.md` / `CondensedTimeline.tsx`'s `waitingOnYou` group,
  which every completed task with an unmerged PR enters unconditionally — no
  merge-policy-tier or reviewer-verdict carve-out decides group placement,
  after the same incident revealed one had silently reintroduced this bug at
  the UI layer), but the completion predicate treats every unmerged-PR shape
  the same way: blocked, no exceptions — UNLESS a supersession edge (below)
  resolves it.
- What a blocked task is WAITING ON is a separate question, and there a queued
  retry does change the answer. At mission scope an open `attempt` row already
  refuses as `pending_deliverables` before `awaiting_merge` is reached. At task
  and PR scope, `explain` passes the newest open attempt to
  `deriveMissionStateView` as `openAttempt`, and that fact (rule 6½) outranks
  the merge fact: the headline reads "waiting on fix N of M (queued, no worker
  yet)" or "(in progress)", never "waiting on you to merge", while a fix is in
  flight.
- **PR supersession** (task fcaf83d5) is the one sanctioned exception to
  "unmerged PR blocks, no exceptions", and it exists because a closed PR is
  not always abandoned work: a mission integration branch can be deleted out
  from under an open PR (the race `mission-integration-branch.md`/#2355
  addresses prospectively), forcing the same diff to re-land as a brand-new
  PR under a different number. The gate had no way to tell that apart from a
  PR nobody ever came back to. `workers.supersededByPrNumber` (+
  `supersededByPrUrl`, `supersededReason`, `supersededRecordedBy`,
  `supersededAt`) is a durable, auditable edge recorded by
  `recordPrSupersession` (`apps/web/src/lib/pr-supersession.ts`), exposed as
  the `record_pr_supersession` MCP action. A claim is valid ONLY if written
  against a real, ALREADY-MERGED PR in the SAME repo as the superseded PR's
  workspace — verified against GitHub at write time (an unmerged or
  nonexistent target is rejected with the specific reason, never silently
  accepted) — and requires a non-blank `reason`. Once recorded, the edge is
  trusted at read time without a second GitHub round-trip: a GitHub merge is
  permanent, so the claim cannot go stale.
  `canCompleteMission`'s `awaitingMerge` filter excludes any deliverable whose
  latest worker carries `supersededByPrNumber` — it counts as shipped, the
  same as a direct merge, and is reported separately via
  `supersededCount`/`supersededDetails` so a reader can see the mission closed
  with rerouted work rather than an ordinary merge. This is NOT a loosening of
  the gate: an agent's assertion never satisfies it, and a closed PR with no
  recorded edge blocks exactly as before, with `awaitingMergeDetails[].
  closedUnsuperseded = true` and a `reason` that says "no supersession
  recorded" rather than the generic "not merged" — the phrasing that tells an
  owner the remedy exists. `computeMissionProgress` and `CondensedTimeline`
  render a superseded deliverable as done (`solid` segment state), naming the
  successor PR on the row rather than reading as an ordinary "closed — not
  merged". The hourly mission-invariants sweep (`unresolved_pr_supersession`)
  reports a completed deliverable whose PR closed unmerged with no
  supersession recorded past 24h, so an unaddressed instance surfaces instead
  of sitting silently.
  "Did this PR ship?" has ONE implementation, `prShipState`/`isPrShipped` in
  `packages/core/pr-shipped.ts`: merged, or superseded, is shipped; open and
  closed-unsuperseded are not. `canCompleteMission`, `computeMissionProgress`
  and the `all_prs_merged` goal criterion all call it, so the gate and the
  criterion cannot disagree about a superseded PR. The criterion judges per
  PR (a PR several worker rows carry is one PR), and its failure evidence
  lists the offending PR numbers split into `open: …` and `closed, no
  supersession recorded: …`, naming `record_pr_supersession` as the remedy.
  Supersession is also DERIVED, never asserted, in one mechanical case
  (`deriveLineageSupersession`): a PR that closed unmerged is superseded by a
  merged PR with a higher number from the SAME attempt lineage (the
  `parentTaskId` chain through `taskClass = 'attempt'` rows — CI retry,
  after-review builder, conflict retry), because the platform opened that
  replacement itself. It never applies to an open PR, to an earlier merged
  PR, or across independent deliverables; a derived edge carries a
  `supersededReason` starting "derived:" and is not written back to the row.
- A mission with no deliverable rows at all MAY be completed only by an explicit
  proposal (`proposed: true`), never by dormancy: a monitoring mission's output
  is its heartbeat cycles, which are housekeeping rows.
- When all deliverables are terminal and criteria are stated, the predicate MUST
  attempt evaluation rather than reading a possibly-absent stored verdict. The
  evaluator MUST NOT skip on the grounds that pending work exists — that was the
  deadlock: the skip condition and the completion condition were the same
  condition.
- Verdicts are not one-shot. Mechanical criteria are re-evaluated on every
  request; a `command` verdict older than `COMMAND_VERDICT_TTL_MS` is re-run; an
  LLM-graded verdict is reused for at most `LLM_REVERIFY_MS`.
- Reuse of a stored verdict MUST match on `criterionFingerprint`, never on array
  index alone: deleting one criterion renumbers the rest, and an index-keyed
  cache would transplant a verdict onto a criterion nobody evaluated.
- A task's terminal status is NOT a verdict. A `command` criterion may only be
  passed on evidence that the command ran (runner `verificationEvidence`, or the
  `loopHistory` written from it) — a task can reach `completed` without running
  it, e.g. a stale-worker retry clone that carries no `loopConfig`.
- No command criterion is dispatched while another criterion already reads
  `fail`: the fold cannot pass this round, so the run would buy nothing.
- `command` criteria MUST be verified by execution: buildd dispatches a
  `taskClass = 'bookkeeping'` verification task carrying
  `loopConfig.exitCondition = { type: 'command', command }`, and the runner's
  evidence — not an agent's summary — decides. A `command` criterion MUST NOT be
  graded by the LLM evaluator.
- `description` (prose) criteria have two graders, chosen per criterion by
  `grader` on the criterion, else the workspace's `gitConfig.criteriaGrader`,
  else `auto`:
  - `api` — one batched `inferenceCall` on the team's API-key credential,
    billed per token. When the inference client finds no path (no key, a
    provider that cannot serve inference, capability switched off) the
    criterion reads `NOT_EVALUATED` naming the cause; it MUST NOT switch to a
    runner behind the owner's back.
  - `runner` — one read-only `kind = 'analysis'`, `taskClass = 'bookkeeping'`,
    `outputRequirement = 'none'` verification task per criterion, claimed by a
    runner on whatever backend credential the team connected (an OAuth seat
    included). No inference call is made. The task's `outputSchema` is
    `{ verdict: 'pass'|'fail'|'unsure', reason ≤ 400 chars, evidence?: string[] }`
    and its prompt carries the criterion, the mission title and goal, the
    deliverable tasks with status / PR link / merged state, and artifacts as
    ids and titles only.
  - `auto` (default) — `api` when the inference client resolves a key for the
    team, `runner` otherwise. The check is the inference client's own credential
    resolution, not a second lookup.
  A prose criterion MUST NOT depend on `ANTHROPIC_API_KEY` being present in the
  web app's environment for a team without one: under `auto` it goes to a runner.
- While a runner task is open the criterion reads `PENDING` ("Verifying on
  runner…") with its `workerTaskId`; the completion gate reports
  `criteria_pending`, and neither counts as a pass. Other criteria are evaluated
  independently. A task still unclaimed after `RUNNER_WAIT_BOUND_MS` sets
  `awaitingRunner` on the criterion, and the mission situation reads "waiting for
  a runner to verify ‹criterion›" instead of the quiet "not yet verified".
- Runner verdict mapping: `pass`/`fail` land as-is; `unsure` lands
  `NOT_EVALUATED` with the reason; a `failed`/`cancelled` task, or one that
  completed without well-formed structured output, lands `NOT_EVALUATED` with an
  infra reason — never a silent pass or fail. The criterion records
  `evaluatedAt` and `workerTaskId` (the link to the task).
- A runner task is deduplicated per (mission, criterion index) on its
  `context.criteriaProseEval` marker, matched in SQL, and reused while open; a
  mission completing while one is in flight reuses it. A terminal task for the
  same criterion fingerprint younger than `PROSE_VERDICT_TTL_MS` is reused as the
  verdict (including an empty one — the loop guard); past it, the next
  evaluation round dispatches a fresh task. The on-demand route's
  6-per-mission-per-hour limit applies to every grader.
- A runner verdict MUST be written back only onto the criterion it graded,
  matched on `criterionFingerprint` of the criterion as it is now: an agent MUST
  NOT be able to overwrite a mechanically-derived verdict with prose, and a
  criterion edited while its task ran MUST NOT receive the old answer.
- No prose criterion is dispatched while another criterion already reads `fail`
  — the same economics as the command path.
- A prose criterion is graded at PR review time wherever it can be, BEFORE the
  standalone evaluator is chosen. A reviewer task dispatched for a PR whose task
  belongs to a mission with `description` criteria carries those criteria in its
  prompt and returns, per criterion, `supports | contradicts | not_applicable`
  with a one-line cited reason. That section is strictly ADDITIVE: it MUST NOT
  change `verdict` or `confidence`, and a mission criterion is never grounds to
  approve, request changes on, or escalate one PR.
- Reviewer findings are appended to `missions.criteriaReviewerFindings`
  (newest-first, capped, one report per reviewer task) — a sibling column, NOT
  `goalCriteriaState`, for the same reason the `criteriaRearm*` columns are
  siblings: findings accumulate over the life of the mission and every fresh
  evaluation overwrites `goalCriteriaState` wholesale.
- The fold from findings to a verdict counts only MERGED PRs — a `supports` on a
  branch that was closed or is still open is a statement about code that is not
  in the product. Reports are read newest-first and one PR gets one voice, its
  most recent reading. Any `contradicts` on a merged PR grades the criterion
  `fail`; otherwise ≥1 `supports` and no `contradicts` grades it `pass` with the
  reviewer citations as evidence. A criterion every reviewer called
  `not_applicable`, or that no merged PR spoke to, falls through untouched and
  the standalone evaluator runs for it exactly as before.
- A finding is matched to its criterion by `criterionFingerprint`, captured on
  the reviewer task's `context.missionCriteria` at dispatch. A finding whose
  fingerprint no longer matches is discarded, never transplanted.
- Reviewer findings MUST NOT decide a `command` or structural criterion. A model
  cannot know whether a command exits 0, and only prose criteria are ever put in
  front of a reviewer.
- The release trigger keeps one additional bar above the predicate: no task of
  the mission in `pending`, `assigned`, or `in_progress`, housekeeping rows
  included (`countPendingTasksForMission`). It MUST NOT be loosened to match a
  weaker completion predicate. It reads the criteria verdict rather than
  producing one (`evaluateCriteria: false`), and accepts a mission that is
  already `completed`/`archived` — that mission passed the gate when it closed.
- `POST`/`PATCH /api/missions` MUST reject a `description` criterion that omits
  `notMechanizableReason` (HTTP 400), a `command` criterion with no command, and
  a `metric` criterion (no evaluator exists, so it would block permanently).
  A criterion byte-identical to one already stored on the mission is
  grandfathered, so history cannot block the edit that would fix it.
- An explicit `PATCH status: 'completed'` bypasses the gate by design (a person
  may override) but MUST post a `Goal criteria gate overridden` note naming the
  actor when the stored verdict is not `pass` — the endpoint is also reachable
  with an admin API key.

**Acceptance criteria**:
- AC-70: GIVEN a heartbeat planning task with `result.missionComplete = true`
  and one deliverable task in `pending` WHEN the mission loop runs THEN the
  mission status remains `active` and a `Mission awaiting verification` note
  names the pending count.
- AC-71: GIVEN all deliverables terminal and `goalCriteriaState.overall` absent
  WHEN completion is attempted THEN criteria evaluation is invoked, and if it
  still yields no passing verdict the mission remains `active` with
  `code = 'criteria_unverified'`.
- AC-72: GIVEN all deliverables terminal and every criterion `pass` WHEN
  completion is attempted THEN `missions.status` becomes `completed`, the linked
  schedule is disabled, and the `on_mission_complete` release trigger also
  passes its own check.
- AC-73: GIVEN a mission with a `description` criterion whose grader resolves
  to `runner` (explicitly, or `auto` with no API key) and a connected agent
  backend credential WHEN criteria are evaluated THEN one `analysis` verification
  task is dispatched for that criterion, no inference call is made, the
  criterion reads `PENDING` with that task id, and `overall` is `UNVERIFIED` —
  and WHEN that task completes with `{ verdict: 'pass', reason }` THEN the
  verdict lands on the criterion, `overall` is re-folded, and completion is
  re-attempted in the same request.
- AC-74: GIVEN a `description` criterion with `grader: 'api'` and no API key
  WHEN criteria are evaluated THEN no task is dispatched and the criterion reads
  `NOT_EVALUATED` with evidence naming the missing key.
- AC-75: GIVEN the same mission with NO agent backend credential connected WHEN
  criteria are evaluated THEN no task is dispatched and the criterion reads
  `NOT_EVALUATED` with evidence naming Settings → Models.
- AC-76: GIVEN a `command` criterion WHEN a verdict is owed THEN a verification
  task is dispatched, the criterion reads `PENDING` with its `workerTaskId`, and
  the mission does NOT complete until that task's evidence resolves it.
- AC-77: GIVEN `POST /api/missions` with
  `goalCriteria: [{ type: 'description', description: '...' }]` and no
  `notMechanizableReason` THEN the request is rejected with HTTP 400 naming
  `notMechanizableReason`.
- AC-78: GIVEN an `active` mission with all tasks completed, no enabled
  schedule, 24h of quiet, and a stated criterion whose verdict is not `pass`
  WHEN the archive sweep runs THEN the mission is NOT archived.
- AC-79: GIVEN a mission with one completed deliverable and one `pending` task
  of `taskClass = 'attempt'` (a CI retry) WHEN completion is attempted THEN it is
  refused with `pending_deliverables`.
- AC-80: GIVEN a mission whose only rows are housekeeping (a monitoring mission)
  WHEN a heartbeat proposes completion and criteria pass THEN the mission
  completes; WHEN dormancy checks the same mission THEN it is refused with
  `no_deliverables`.
- AC-81: GIVEN a completed `command` verification task carrying no record that
  the command ran WHEN its outcome is handed back THEN the criterion is NOT set
  to `pass`.
- AC-82: GIVEN a mission with one `completed` deliverable whose latest worker
  has `prUrl` set and `mergedAt` null, and no `goalCriteria` stated (the M4
  shape) WHEN dormancy OR the heartbeat attempts completion THEN the mission
  stays `active` with `code = 'awaiting_merge'`, the reason and
  `awaitingMergeDetails` name the task title and PR number, and a feed note
  posts even though nothing "proposed" completion.
- AC-83: GIVEN the same mission WHEN the PR merges (`mergedAt` set) THEN a
  subsequent completion attempt with no other blockers succeeds.
- AC-84: GIVEN a mission with a `completed` deliverable whose PR was closed
  without merging (`prLifecycleStatus = 'closed'`, `mergedAt` null) and no
  supersession edge recorded WHEN completion is attempted THEN it is refused
  with `code = 'awaiting_merge'`, and `awaitingMergeDetails[].
  closedUnsuperseded = true` with `reason` naming "no supersession recorded" —
  a closed-unmerged PR is not a passing outcome either, unless AC-86 below
  applies.
- AC-85: GIVEN a task whose PR is closed and unmerged WHEN
  `record_pr_supersession` (or `recordPrSupersession`) is called with a
  `supersedingPrNumber` that is unmerged, or does not exist in the same repo,
  or with a blank `reason` THEN the write is rejected (400/404/409) naming
  which check failed, and no edge is written.
- AC-86: GIVEN the same task WHEN `record_pr_supersession` is called with a
  `supersedingPrNumber` that IS merged in the same repo and a non-blank
  `reason` THEN `workers.supersededByPrNumber` (+ `supersededByPrUrl`,
  `supersededReason`, `supersededRecordedBy`, `supersededAt`) is written, and a
  subsequent `canCompleteMission` no longer counts that deliverable in
  `awaitingMerge` — it is reported in `supersededCount`/`supersededDetails`
  instead, and completion succeeds if nothing else blocks.
- AC-87 (regression): GIVEN the M4 shape, one completed deliverable, PR
  OPEN with a reviewer's "changes requested" verdict, no supersession edge —
  WHEN completion is attempted THEN it is still refused with
  `code = 'awaiting_merge'` and `closedUnsuperseded` is NOT set (the PR is
  open, not closed) — supersession never substitutes for a merge on a PR that
  could still merge.
- AC-88: GIVEN a superseded deliverable WHEN mission progress is computed
  (`computeMissionProgress`) THEN its segment state is `solid` (counted in
  `completedTasks`, not `awaitingMerge`), and `CondensedTimeline`'s task row
  names the successor PR rather than rendering "closed — not merged".
- AC-89: GIVEN a mission with an `all_prs_merged` criterion WHEN every
  unmerged PR is closed and carries a supersession edge to a merged PR
  (recorded, or derived from its own attempt lineage) THEN the criterion
  passes, and `canCompleteMission` does not report `awaiting_merge` — the two
  agree on the same fixture. A closed PR with no edge fails the criterion with
  evidence naming it under "closed, no supersession recorded"; an open PR
  (the M4 shape) still fails, listed under "open".
- AC-90: GIVEN a completed deliverable whose PR has been closed-unmerged
  with no supersession edge for more than 24h WHEN the hourly mission-invariant
  sweep runs THEN `unresolved_pr_supersession` reports it (report-only, not
  filed as a task).
- AC-91: GIVEN a mission with a `description` criterion WHEN a reviewer task is
  dispatched for one of its task PRs THEN the reviewer prompt carries that
  criterion with its index, the reviewer task's `context.missionCriteria` carries
  its fingerprint, and the prompt states the criteria do not change the verdict —
  and GIVEN a task in no mission, the assembled prompt is byte-identical to the
  pre-criteria one.
- AC-92: GIVEN that reviewer completes with
  `criteriaFindings: [{ index, finding: 'supports', reason }]` and its PR
  subsequently merges WHEN criteria are evaluated THEN the criterion reads `pass`
  with evidence citing `PR #<n>`, and NO prose grading task is dispatched.
- AC-93: GIVEN the same shape with `finding: 'contradicts'` on a merged PR THEN
  the criterion reads `fail`; GIVEN `supports` on a PR that never merged, or
  `not_applicable` from every reviewer, THEN the criterion is untouched and the
  standalone evaluator is dispatched as before.

### Blocked-Verdict Consumer

**Capability statement**: A non-passing verdict MUST have a consumer. A mission
that can be BLOCKED by its criteria but cannot file the work to unblock itself is
a deadlock, and a verdict re-produced on a cadence and read by nobody is that
deadlock's signature.

Observed shape: with every deliverable terminal and criteria failing, the
heartbeat prepass proposed completion, the gate refused, the schedule deferred,
and the tick ended — so the only branch that dispatches an organizer cycle
(`invoke_llm`, which requires open deliverables) was structurally unreachable.
Four missions sat in that state, one for ~40 cycles, each finished by hand.

**Invariants**:
- A refusal whose `code` satisfies `isCriteriaBlockCode` MUST dispatch exactly ONE
  organizer cycle per distinct verdict shape, carrying the per-criterion verdict
  text into the planning description — the `failureContext` pattern, applied to a
  criteria failure.
- Verdict shape is `criteriaFingerprint`: `overall` plus each criterion's verdict
  keyed on `criterionFingerprint` (falling back to index). Evidence WORDING is
  excluded: an LLM re-grading the same failure phrases it differently every run,
  and treating rewording as new information defeats the loop guard.
- The EVALUATOR MUST NOT file work. Prose criteria are LLM-graded and the least
  reliable signal in the system; a grader with write access to the backlog turns a
  hallucinated verdict into hallucinated scope. The consumer decides only whether
  to WAKE the organizer; the organizer decides what to file.
- Re-arming MUST NOT loop. An unchanged verdict escalates: after
  `MAX_REARM_CYCLES` unchanged cycles, or immediately once the organizer has seen
  that exact verdict and filed nothing against it, buildd posts a `question` note
  naming the blocking criteria and disables the heartbeat schedule. A criteria
  failure nobody can move is a decision, not a retry.
- While work filed against the current verdict is still open, the consumer waits
  rather than re-arming — otherwise it duplicates the work in flight.
- Escalating and un-escalating are each owned by exactly one writer, and no
  other code path may touch `criteriaEscalatedAt` directly. `escalateCriteriaFailure()`
  (`apps/web/src/lib/criteria-escalation.ts`) is the ONLY writer that STAMPS
  the column: it claims the row atomically (`UPDATE ... WHERE criteriaEscalatedAt
  IS NULL OR criteriaRearmFingerprint IS DISTINCT FROM the new fingerprint`),
  files the owner-facing note, and stands the heartbeat schedule down — all
  three or none, so the column and the notification can never drift apart. The
  atomic claim is also the dedup: a mission re-evaluated with an identical
  verdict does not file a second note, but a verdict that gets WORSE while
  already escalated re-notifies once for the new shape. Before this existed,
  `criteria-rearm.ts`'s escalate branch and the explicit completion override in
  `PATCH /api/missions/[id]` each decided "has this mission escalated"
  independently — the heartbeat path stamped the column, the completion
  override only posted a passive warning note and never touched the column at
  all, so a mission whose criteria were failing when a human force-completed it
  (skipping the heartbeat's N-cycle budget entirely) left `criteriaEscalatedAt`
  null forever with no notification ever having been sent.
- Escalation MUST be self-clearing, but NOT via a re-arm tick alone: escalating
  disables the mission's heartbeat schedule, so no tick can ever run again to
  observe a later verdict change — the code that would clear
  `criteriaEscalatedAt` on that path is structurally unreachable from the state
  that sets it. Clearing is instead the job of `resolveCriteriaEscalation()`
  (same module), the single writer for un-escalating a mission. It nulls
  `criteriaEscalatedAt`, closes the open `question` note as `answered` (the
  owner acted — never `dismissed`), and re-enables the heartbeat schedule if
  one still exists, so a later tick CAN run again. Every live exit routes
  through it: `applyCriteriaRearm`'s own 'rearm' branch (verdict genuinely
  changed, reason `verdict_changed` — reachable again only once something else
  has re-enabled the schedule), a **previously-escalated** mission closing to
  `completed`/`archived` (reason `mission_completed`/`waived`), and a
  `goalCriteria` edit on `PATCH /api/missions/[id]` (reason `criteria_edited` —
  the exit the escalation note itself advertises). It is a no-op on a mission
  that was never escalated and never files a task. A completion/archival close
  is routed to `resolveCriteriaEscalation()` ONLY when `criteriaEscalatedAt` was
  already set before the request's own writes — a mission escalating for the
  first time via the override path (previous bullet) must not have its own
  fresh stamp erased by this same request.
- A re-arm cycle MUST NOT write `lastHeartbeatStateHash`. Mission state is
  unchanged by construction (every deliverable is terminal), so persisting it
  would make the next tick read "no change" and suppress the cycle just
  authorised.
- Coordinate-only mode (`decompositionSkipped`) is LIFTED, narrowly, for gaps
  named in a non-passing criterion. Pre-filed tasks are a reason not to duplicate
  decomposition; they are not a reason to be unable to fix a criterion the mission
  is failing. The lift MUST NOT authorize re-decomposition of anything the
  blocking criteria do not name.
- A mission holding `criteriaEscalatedAt` while terminal (`completed` or
  `archived`), or while its verdict already passes, is inconsistent — every
  write site above is supposed to clear it on its own exit, so this state
  existing at all is evidence one of them didn't. The hourly
  `mission-invariants` sweep (`stale_criteria_escalation`) is the backstop: it
  resolves the row directly through `resolveCriteriaEscalation()` and counts
  it, rather than filing a task or notifying — there is nothing for a human to
  act on, only a stranded flag. A sweep doing steady-state work here means a
  write site is still wrong, not that the backstop is doing its job.
- The DECIDE chip on the Home action queue (`buildDecideItems()` in
  `apps/web/src/lib/action-queue.ts`) MUST re-derive membership from the
  mission's current `status` and `criteriaOverallVerdict` rather than trusting
  `criteriaEscalatedAt` alone, for the same reason the sweep above exists: the
  column records WHEN an escalation happened, never whether it still holds
  now. This is one instance of a queue-wide rule — every actionable chip
  asserts something about its subject's CURRENT state and may only render
  while that state is known live (documented next to `ActionChip` in
  `action-queue.ts`); MERGE/REVIEW already enforce it via the STALE gate, and
  QUESTION/RECONNECT/APPROVE are exempt by construction because each is built
  from a live re-check on every queue build rather than a persisted flag.

**Acceptance criteria**:
- AC-94: GIVEN a heartbeat mission with every deliverable terminal and
  `overall = fail` WHEN the cron tick runs THEN one planning task is created for
  the mission and its context carries `criteriaRearm` with the non-passing
  criterion lines — not a bare deferral.
- AC-95: GIVEN the same mission on a later tick with the verdict shape unchanged
  and no task filed since the last re-arm WHEN the tick runs THEN no cycle is
  created, a `Goal criteria blocked — owner decision needed` note is posted, and
  the heartbeat schedule is disabled with
  `lastDeferralReason = 'criteria_escalated'`.
- AC-96: GIVEN an escalated, still-`active`/`paused` mission WHEN its
  `goalCriteria` is edited via `PATCH /api/missions/[id]` THEN
  `resolveCriteriaEscalation()` clears `criteriaEscalatedAt`, closes the open
  question note as `answered`, and re-enables the heartbeat schedule — making a
  later tick reachable again, rather than a tick itself clearing the flag (no
  tick can run while the schedule it would need is the very thing escalation
  disabled).
- AC-97: GIVEN a completion refused for a non-criteria reason (e.g.
  `infra_stalled`) WHEN the tick runs THEN no re-arm is attempted.
- AC-98: GIVEN a re-arm cycle WHEN the schedule row is written THEN
  `lastHeartbeatStateHash` is not among the written columns.
- AC-99: GIVEN a **previously escalated** mission WHEN its status is set to
  `completed` or `archived` via `PATCH /api/missions/[id]` THEN
  `resolveCriteriaEscalation()` clears `criteriaEscalatedAt` and closes the
  open question note, even though the schedule row itself is deleted (not
  re-enabled) by the same request — a terminal mission has nothing left to
  re-arm.
- AC-100: GIVEN a mission that was NEVER escalated (the heartbeat's N-cycle
  budget never ran — e.g. it is force-completed immediately) WHEN its status is
  set to `completed` or `archived` via `PATCH /api/missions/[id]` WHILE its
  stored `goalCriteria` is non-empty and `goalCriteriaState.overall !== 'pass'`
  THEN `escalateCriteriaFailure()` is called instead of a bare warning note —
  `criteriaEscalatedAt` is stamped and the "Goal criteria gate overridden" note
  is filed with `status: 'answered'` (the override already IS the decision, so
  nothing is left open) — and `resolveCriteriaEscalation()` is NOT also called
  for this close, since there is nothing to resolve and doing so would
  immediately null the column this same request just stamped.
- AC-101: GIVEN a mission with `criteriaEscalatedAt` set WHILE `status` is
  `completed`/`archived`, or WHILE `goalCriteriaState.overall = 'pass'` WHEN
  the hourly `mission-invariants` sweep runs THEN the row is resolved through
  `resolveCriteriaEscalation()` and counted as `stale_criteria_escalation` —
  not filed as a task, not notified — and a second run against the same
  (now-fixed) row finds nothing.
- AC-102: GIVEN a mission with `criteriaEscalatedAt` set and an open question
  note WHEN it is either terminal (`completed`/`archived`) or its
  `goalCriteriaState.overall = 'pass'` THEN `buildDecideItems()` produces zero
  DECIDE items for it, regardless of the stored flag or note state.
- AC-103: GIVEN a task created with `missionId` set (any origin, dashboard,
  API, MCP) WHEN `POST /api/tasks` succeeds THEN
  `resolveCriteriaEscalation(missionId, 'work_filed', actor)` is called —
  "file the work", the escalation note's first advertised exit, is reachable
  from ordinary task creation rather than requiring a bespoke endpoint. A
  no-op on a mission that was never escalated, per the helper's own contract.
- AC-104: GIVEN a **previously escalated** mission WHEN `PATCH
  /api/missions/[id]` sets `status` to `completed`/`archived` WHILE its stored
  `goalCriteria` is non-empty and `goalCriteriaState.overall !== 'pass'` THEN
  `resolveCriteriaEscalation()` is called with reason `'waived'`, not
  `'mission_completed'` — reaching this close with the flag still set can only
  happen via an override (a passing verdict would already have cleared it
  through the `'verdict_changed'` exit), and the "Goal criteria gate
  overridden" warning posted for the same condition is the audit trail that
  makes waiving safe to offer as a one-click exit on the mission-detail
  decision sheet. See AC-100 for the same condition on a mission that was
  never escalated in the first place.
- AC-105: GIVEN an open `missionNotes` question row whose title is the
  escalation note's title (`CRITERIA_ESCALATION_NOTE_TITLE`) WHEN
  `MissionFeed` renders it THEN no Reply/Skip affordance is shown. Both route
  through `POST /api/missions/[id]/notes/[noteId]/reply`, which only flips
  `status` to `'answered'` — it never touches `criteriaEscalatedAt` or
  re-enables the schedule, so replying would mute the card while leaving the
  mission stood down forever. The mission-detail decision sheet (file the
  work / fix the criterion / waive), which routes every exit through
  `resolveCriteriaEscalation()`, is the only surface that can clear it.

**Code surface**:
- Predicate + writer: `apps/web/src/lib/mission-completion.ts` —
  `canCompleteMission()`, `completeMissionIfVerified()`, `isCriteriaBlockCode()`
- Blocked-verdict consumer: `apps/web/src/lib/criteria-rearm.ts` —
  `criteriaFingerprint()`, `decideCriteriaRearm()`, `applyCriteriaRearm()`
- Single writer for escalating: `apps/web/src/lib/criteria-escalation.ts` —
  `escalateCriteriaFailure()`. Called from `applyCriteriaRearm()`'s 'escalate'
  branch and from `PATCH /api/missions/[id]` (a never-escalated mission closing
  to completed/archived with a non-passing verdict).
- Single writer for un-escalating: same module —
  `resolveCriteriaEscalation()`. Called from `applyCriteriaRearm()`'s 'rearm'
  branch, from `PATCH /api/missions/[id]` (a previously-escalated mission's
  status → completed/archived; a `goalCriteria` edit), and from the
  `stale_criteria_escalation` invariant.
- Terminal-mission / passing-verdict backstop:
  `apps/web/src/lib/mission-invariants.ts` (`stale_criteria_escalation`
  invariant) + `apps/web/src/app/api/cron/mission-invariants/route.ts`
  (reconciles, does not file)
- DECIDE-card derivation: `apps/web/src/lib/action-queue.ts` —
  `buildDecideItems()`, `EscalatedMissionCandidate`
- Home DECIDE card (one CTA, recommendation only — never a pre-selected
  exit): `apps/web/src/components/WaitingOnYouDecideCard.tsx`
- Mission-detail decision sheet (the three goal-criteria exits — file the work
  / fix the criterion / waive — plus the two visual-audit exits, see the
  surface-audit gate below): `apps/web/src/app/app/(protected)/missions/[id]/MissionDecisionSheet.tsx`,
  `apps/web/src/lib/criteria-decision-links.ts` (task-composer link),
  `apps/web/src/lib/goal-criterion-label.ts` (client-safe criterion labeling)
- "File the work" resolution: `apps/web/src/app/api/tasks/route.ts` (POST,
  fire-and-forget block on `task.missionId`)
- Reply exclusion for the escalation note: `apps/web/src/lib/escalation-note-title.ts`
  (`CRITERIA_ESCALATION_NOTE_TITLE`), `apps/web/src/lib/mission-note-reply.ts`
  (`isReplyableQuestion()`), consumed by
  `apps/web/src/app/app/(protected)/missions/[id]/MissionFeed.tsx`
- Re-arm prompt injection: `apps/web/src/lib/mission-context.ts` —
  `buildMissionContext()` (`criteriaRearm` block + coordinate-only lift)
- Verdict producer: `apps/web/src/lib/mission-criteria-eval.ts` —
  `ensureCriteriaVerdict()`, `evaluateCriteriaNow()`
- Command criteria: `apps/web/src/lib/mission-criteria-verify.ts` —
  `resolveCommandCriterion()`, `handleCriteriaVerificationOutcome()`
- Prose criteria, runner grader: `apps/web/src/lib/mission-criteria-prose.ts` —
  `resolveProseCriterion()`, `mapProseOutcome()`, `handleProseEvalOutcome()`;
  grader choice: `apps/web/src/lib/mission-criteria-grader.ts` —
  `pickCriteriaGrader()`, and `resolveWorkspaceCriteriaGrader()` in
  `apps/web/src/lib/mission-criteria-strategy.ts`
- Prose criteria graded at review time:
  `apps/web/src/lib/criteria-reviewer-findings.ts` —
  `loadMissionProseCriteria()`, `renderMissionCriteriaGuidance()`,
  `recordReviewerCriteriaFindings()`, `applyReviewerFindings()`; injected by
  `apps/web/src/lib/reviewer.ts` (`buildReviewerContext()`,
  `REVIEWER_TASK_OUTPUT_SCHEMA.criteriaFindings`) and recorded from
  `apps/web/src/app/api/workers/[id]/route.ts`
  (`handleReviewerOutcomeIfNeeded()`)
- Pure evaluator + form validation: `packages/core/mission-helpers.ts` —
  `evaluateGoalCriteria()`, `recalculateOverall()`, `validateGoalCriteria()`,
  `computeMissionProgress()` (`awaitingMerge` count, `MissionSegmentState`
  `'half'` = awaiting merge / `'notch'` = closed-unmerged or failed —
  `completedTasks` counts only `'solid'` segments, never `'half'`)
- Timeline group placement: `apps/web/src/lib/condensed-timeline.ts` —
  `isWaitingOnYou()` (every `completed` task with an unmerged, non-closed PR
  enters `waitingOnYou`, unconditionally), consumed by
  `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` and
  `CondensedTimeline.tsx` (`PrStatusLine` renders closed-unmerged distinctly)
- Callers: `apps/web/src/lib/mission-loop.ts`,
  `apps/web/src/app/api/cron/schedules/route.ts` (heartbeat prepass site),
  `apps/web/src/lib/mission-evaluation.ts`,
  `apps/web/src/lib/mission-release.ts`,
  `apps/web/src/app/api/missions/[id]/evaluate/route.ts`,
  `apps/web/src/app/api/workers/[id]/route.ts`
- Archive guard: `apps/web/src/lib/mission-archive.ts` —
  `selectMissionsToArchive()`
- Display: `apps/web/src/lib/mission-state-view.ts` —
  `deriveMissionStateView()` (`awaiting_verification`)

**Out of scope**: The `metric` criterion evaluator (no metric-query registry
exists yet, so `metric` criteria stay `UNVERIFIED` and block completion by
design) and initiative KPI evaluation, which has no evaluator at all.

---


## Mission Dependency Gates

**Capability statement**: A mission that depends on another (`missions.dependsOnMissionId`)
MUST be released exactly when its upstream meets the declared `gateCondition`, read from the
upstream's live state, and a blocked mission MUST name the condition still unmet.

`gateCondition` is one of:

| Gate | Met when | Never reads |
|------|----------|-------------|
| `completed` | the upstream's `status` is `completed` (written only by the completion gate above, or a person's override) | anything else: the status is that predicate's answer |
| `merged` | the upstream is `completed`, or its work has shipped (below) | goal criteria, the visual review, any verification |

The `merged` gate's predicate is `evaluateUpstreamGate` (`apps/web/src/lib/mission-dependency-gate.ts`, pure).
It is shut by:

1. an unfinished build or repair task (its PR is still to come);
2. a build or repair task whose latest PR has not shipped (`prShipState`, the same predicate the
   completion gate uses, with lineage-derived supersession and the kernel delivery as authority):
   open, or closed without merging and with no supersession or abandonment recorded;
3. any other row still holding an open PR (a retry attempt's own PR);
4. on a mission branch that carried work, the mission PR not merged;
5. nothing shipped yet: an active upstream with no merged work (no tasks filed yet, or all of it
   cancelled) releases a dependent only by completing.

Verification tasks (`[surface audit]`, final verification) and maintenance (a trunk refresh of the
integration branch, and its attempts) never hold it. One PR has one answer: a merge recorded on any
row naming the PR settles it for every row naming it.

**Invariants**:
- `isMissionBlocked` decides from the upstream's live state whenever `dependencyMetAt` is null, and
  stamps `dependencyMetAt` (guarded on `IS NULL`) when the gate is met. The events that also stamp it
  (`checkAndUnblockDependentMissions` from a PR merge, the reconcile sweep, the merge route, and
  mission completion) are lossy and are not the only path.
- Mission completion releases dependents of both gates: completion already required everything the
  `merged` gate asks.
- A met `merged` gate never waits on a fresh verification. Verification still gates the upstream's
  own completion exactly as above; it is not bypassed, only not re-asked by its dependents.
- The blocked reason names the gate and the first unmet condition with its task and PR, then how many
  more (`gateBlockedReason`); `explain` lists each one as a causal link with `taskId`/`prNumber` refs.

**Acceptance criteria**:
- AC-106: GIVEN a `merged`-gate mission whose upstream is `completed` and `dependencyMetAt` is null
  WHEN `isMissionBlocked` runs THEN it is not blocked and `dependencyMetAt` is stamped.
- AC-107: GIVEN an upstream whose build PRs and mission PR merged, with a trunk-refresh PR closed
  unmerged and a `[surface audit]` still pending WHEN the `merged` gate is evaluated THEN it is met.
- AC-108: GIVEN an upstream build PR that is open, or closed with no supersession or abandonment,
  WHEN the `merged` gate is evaluated THEN it is shut and the reason names that PR and its task.
- AC-109: GIVEN a mission-branch upstream whose task PRs merged into the integration branch and whose
  mission PR is open or not yet opened WHEN the `merged` gate is evaluated THEN it is shut, naming
  the mission PR.
- AC-110: GIVEN an upstream mission completes WHEN its dependents are released THEN `merged`-gate
  dependents are released with the `completed`-gate ones.

**Code surface**:
- `apps/web/src/lib/mission-dependency-gate.ts` — `evaluateUpstreamGate`, `gateBlockedReason`
- `apps/web/src/lib/mission-dependency.ts` — `isMissionBlocked`, `evaluateMissionGate`, `checkAndUnblockDependentMissions`

**Verified by**: `apps/web/src/lib/mission-dependency-gate.test.ts`, `apps/web/src/lib/mission-dependency.test.ts`

---


## Mission Dormancy Pattern (long-horizon missions)

For missions with a defined active season (e.g., annual tax prep Jan–Mar,
quarterly review), the recommended pattern is:

- Keep `status = 'active'` year-round — do NOT use `paused` for seasonal gaps.
- Set `activeHoursStart/End/Timezone` to a narrow window (e.g., 9–10 AM
  Chicago) so the heartbeat fires infrequently and does not spam task creation.
- Write heartbeat logic that checks the current date against the mission's
  documented season window before spawning tasks. When outside the season, the
  heartbeat should log a status note and return without creating tasks.

**Contrast with `paused`**: Use `paused` for human-suspended missions awaiting
explicit manual resume. Use `active + restrictive activeHours + self-suppressing
heartbeat` for missions that auto-manage their own seasonal cadence. Mixing the
two (pausing a seasonal mission to prevent off-season tasks) is valid but means
the heartbeat must be manually re-enabled each season.

**Schema gap**: There is no `resumeAt timestamp` field for formal hibernation
with a scheduled wake date ("pause until 2027-01-15"). The workaround is
heartbeat self-suppression. A `missions.resumeAt` column is a candidate future
addition for missions that need hard-scheduled wake-up semantics.

---


## Workspace-less Missions

Missions with `workspaceId = null` are valid. They are used for:
- **Personal-agent missions**: financial tasks, email triage, annual-cycle
  planning with no code deliverables.
- **Cross-workspace coordination**: an organizer mission that dispatches tasks
  to multiple workspaces, each task carrying an explicit `workspaceId`.

**Invariants**:
- `workingBranch` and `primaryPrUrl` are always null for workspace-less
  missions (no repo, no PRs). Do not treat null values for these fields as an
  error or health failure.
- A mission with `workspaceId = null` and zero deliverable tasks MUST return a
  "no tasks" health signal. This is expected — workspace-less missions may have
  no code deliverables by design.
- Task creation from a workspace-less mission MUST supply an explicit
  `workspaceId` on each created task. There is no automatic inference from the
  mission to the task. If the heartbeat or organizer omits `workspaceId` on a
  task, that task's `workspaceId` is driven by whichever workspace the executing
  runner claims from.

**Acceptance criteria**:
- AC-14: GIVEN a workspace-less mission with no tasks WHEN health is derived
  THEN the result is "no tasks" (not "healthy" and not an error).
- AC-15: GIVEN a workspace-less mission WHEN its detail page loads THEN
  `workingBranch` and `primaryPrUrl` display as absent (not as broken links).

---


## `deriveMissionHealth` contract

**Capability statement**: `deriveMissionHealth` MUST compute the health of a
mission from its live task list without reading from any stored health column.

**Invariants**:
- Only deliverable tasks (`isDeliverableTask()` returns `true`) count.
- A mission with zero deliverable tasks MUST return a "no tasks" or "empty"
  health signal (not "healthy").

**Acceptance criteria**:
- AC-12: GIVEN tasks `[{status:'completed'}, {status:'failed'}, {kind:'coordination'}]`
  WHEN health is derived THEN the coordination task is excluded and health
  reflects 1 completed, 1 failed deliverable.
- AC-13: GIVEN a task with `title: 'Aggregate results: …'` WHEN `isDeliverableTask`
  is called THEN it returns `false`.

**Code surface**:
- `packages/core/mission-helpers.ts` — `isDeliverableTask()`

**Out of scope**: Sub-missions (`parentMissionId`) lifecycle. Mission heartbeat
scheduling (covered by `task-schedules`). The mission loop orchestration agent
logic (runner-side, not coordination layer).

---

**Out of scope**: The sibling contracts linked in the frontmatter.
