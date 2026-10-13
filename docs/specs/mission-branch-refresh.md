---
title: Mission Branch Refresh
status: active
owner: max
last_verified: 2026-10-13
summary: A mission's integration branch MUST be refreshed from trunk on task start or a daily backstop, never per trunk merge; every writer is fenced, owned and reconciled.
domain: missions
surfaces: [apps/web/src/lib/mission-branch-refresh.ts, apps/web/src/lib/mission-subscribers.ts, apps/web/src/app/api/workers/claim/route.ts, apps/web/src/app/api/cron/pr-reconcile/route.ts]
related: [workflow-kernel-library, mission-release-gate, mission-task-lifecycle, workflow-state-kernel]
keywords: [integration branch, mission/*, merge dev into, chore(mission), branch refresh, branchRefreshHeadSha, branch_refreshed_at, refresh conflict task, requireMergeCommit, trunk merge, refresh lease, abandoned lease, conflict reservation, paused mission refresh, mission branch concurrency]
verified_by: [apps/web/src/lib/mission-branch-refresh.test.ts, apps/web/src/lib/mission-pr-merged.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts, scripts/resolve-generated-conflicts.test.ts, apps/web/src/lib/conflict-retry.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/modules.test.ts, apps/web/src/lib/integration-refresh.test.ts]
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
  - id: "generated-conflict-resolver"
    type: "symbol"
    name: "resolveGeneratedConflicts"
    path: "scripts/resolve-generated-conflicts.ts"
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
  and a mission without an integration branch are never refreshed. Which
  trigger may refresh a paused mission is in "Eligibility" below.

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
  - It waits at most `START_REFRESH_BUDGET_MS`. What happens to a refresh
    still running at the budget is "Bounded start" below.
  - It never throws, and the claim is never refused or failed because of it.
- **Landing.** A mission PR into trunk that is approved and behind is updated by
  the workflow kernel's `refresh_branch` effect, serialized per base by the
  landing lane (`workflow-state-kernel` §13.7). That is a merge of trunk into the
  integration branch too. This spec adds no trigger for it.
- **Backstop.** `sweepMissionBranchRefresh`, run from the hourly pr-reconcile
  cron, considers only missions it may write to (see "Eligibility"), and
  refreshes one when both of these hold:
  - it is due: `branchRefreshedAt` is null or older than
    `BRANCH_REFRESH_BACKSTOP_MS`, **or** its lease is abandoned
    (`branchRefreshLeaseUntil` set and past), **or** it has a conflict pointer
    to settle (`branchRefreshConflictTaskId` set);
  - the mission has a non-terminal task, or its mission PR is open.

  Any other mission costs no GitHub call. The two extra due conditions are the
  reconciler for work a request left unfinished ("Liveness").

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
- AC-12: GIVEN a mission refreshed less than a day ago, with no abandoned lease and
  no conflict pointer WHEN the backstop runs THEN it makes no GitHub call for that
  mission.
- AC-13: GIVEN a mission with no non-terminal task and no open mission PR WHEN the
  backstop runs THEN it is skipped, even if never refreshed.
- AC-14: GIVEN a mission never refreshed, with live work WHEN the backstop runs
  THEN it is refreshed.

## Lifecycle and concurrency

> Amended 2026-10-13 by `workflow-kernel-library.md` §6: refresh becomes an effect of the mission delivery's writable epoch and reads shipped from delivery state, not `workers.mergedAt`.

This section is the cross-operation contract: who writes the integration branch
and the mission PR, how those writers coordinate, and what keeps every unfinished
operation moving. It owns no state of its own. Each fact it relies on has one
authority, named in the table below, and this spec only adds the refresh's own
columns on `missions` (`branchRefresh*`).

### Authorities

| State | Authority | This spec's relation |
| --- | --- | --- |
| Mission status (`active`, `paused`, `budget_exhausted`, `completed`, `archived`), `isHeld` | `mission-task-lifecycle` (Mission State Machine); `completeMissionIfVerified` is the one automated writer of `completed` | Reads it at entry and as a WHERE fence at each commit boundary. Never writes it. |
| A task PR's and the mission PR's delivery (review, CI, repair, landing, merged) | `workflow-state-kernel` (deliveries, §6, §8, §13.7) | The refresh is a foreign writer to the mission PR's head (§6.9 rule 3). It adds no PR state. |
| Mission PR merged, and merged-versus-released | `mission-release-gate` (ship-line invariant; `findMissionPrOwner`), with the mission PR's kernel delivery and GitHub as fallbacks (`missionShippingPrMerged`, see "Eligibility") | Reads "merged" as "never refresh again". Never writes it. |
| Task status | `mission-task-lifecycle` (Task State Machine) | Reads the conflict task's status. Creates the conflict task, never completes it. |
| The refresh itself | this spec: `branchRefreshHeadSha`, `branchRefreshedAt`, `branchRefreshLeaseUntil`, `branchRefreshLeaseToken`, `branchRefreshConflictTaskId` | Sole writer. |

Task done, PR merged and released stay three separate facts, each read from its own
authority. A conflict task reaching `completed` is not the refresh being settled,
and the mission PR merging is not the mission being released.

### Writers to the integration branch and the mission PR

| # | Writer | Writes | Coordination | Evidence before it counts |
| --- | --- | --- | --- | --- |
| W1 | Mission refresh (`refreshMissionIntegrationBranch`) | A merge commit of trunk into the branch, via `POST /merges` | Single-flight lease per mission (W1 against W1 only). Fenced on mission state at the commit boundary. GitHub's ref compare-and-swap against every other writer. | `branchRefreshHeadSha`/`branchRefreshedAt` only after a 201 or 204, or a fresh cut |
| W2 | Conflict task PR landing (kernel merge door) | A merge commit (`resolveMergeMethod`) of the resolution branch into the integration branch | The kernel's landing, pinned to the approved head. Normal review and CI for a PR into the integration branch. | The pointer clears only on `verifyRefreshLanded` against the live head |
| W3 | Task PR landings (kernel merge door) | Squash of a task PR into the integration branch | The kernel's landing, pinned to that PR's head; the landing lane per repo + base (`mission/*`) when enabled | The kernel's `PrMerged` fact |
| W4 | Kernel `refresh_branch` on the mission PR | GitHub update-branch: trunk merged into the integration branch | Pinned to the bound head (`expected_head_sha`); the landing lane per repo + trunk | The kernel's own-refresh evidence (§8.3) |
| W5 | Mission PR landing (kernel `merge_call`) | The integration branch into trunk | Pinned to the head T15 approved; `verify_merge` turns the answer into a fact | `PrMerged` through `ingestFact` |
| W6 | Branch creation (`ensureMissionIntegrationBranch`) | Creates the ref from trunk | Create-only: fails if the ref exists | A fresh cut is current by construction |
| W7 | A person on GitHub | Anything | None. The kernel records it as a foreign push. | Same as any foreign push |

**Invariants**:
- No writer force-pushes or rebases the integration branch, and only W3 and W5
  squash, each into its own target. W1, W2 and W4 add merge commits only. Every
  write is a ref compare-and-swap on GitHub, so two writers never overwrite each
  other: one lands and the other is refused or re-applied on top. No commit is
  lost by any ordering of W1–W6.
- The refresh lease serializes W1 callers for one mission and nothing else. It
  does not cover W2–W7, and it is not taken by them. There is no lock across
  missions and none across writers. A reproduced interleaving that needs one
  would be the reason to add it.
- W1 and W4 can both merge trunk into the same branch. Neither needs to know
  about the other: whichever lands second gets a 204, a small merge commit, or (W4
  only) a refused pinned update that the kernel re-derives from the moved head.
- **W1 moving the mission PR's head.** A refresh is a head change the kernel did
  not make (§6.9 rule 3). A landing pinned to the old head is refused, so nothing
  unreviewed reaches trunk. The kernel then decides by its own rules: the
  approval carries forward only when the PR's diff is unchanged
  (`content_equivalent`, §8.3), and otherwise a delta round starts. CI runs on
  the new head as on any head. This spec adds no review or CI rule.
- **W1 moving task PRs' base.** A task PR's head and its approval do not move, so
  its pinned landing still lands, on top of the refresh. A task PR the base move
  made behind or conflicting is the kernel's behind or conflict repair of that
  PR. This is why a refresh runs on demand and not per trunk merge: each one
  moves the base under every open task PR.

### Eligibility

| Mission state | Start trigger (a task claimed) | Backstop | In flight when the state changes |
| --- | --- | --- | --- |
| `active`, not held | refreshes | refreshes when due and in use | proceeds |
| `active`, idle (no live task, no open mission PR) | n/a: a claim makes it in use | skipped, no GitHub call | n/a |
| `paused`, `budget_exhausted`, or `isHeld` | refreshes: the claim is an authorized start (resume, force-start) | skipped, no GitHub call | a backstop refresh stops at the next commit boundary with `mission_paused`; a start's continues |
| resumed (`paused` → `active`, or armed) | refreshes | refreshes when due | n/a |
| `completed`, `archived` | skipped | skipped | stops at the next commit boundary with `mission_terminal`: no merge and no conflict task |
| mission PR merged | skipped (`mission_pr_merged`) | skipped | re-read just before the merges call and just before finishing a reserved conflict task: stops with `mission_pr_merged` |
| no integration branch | skipped | skipped | n/a |

**Invariants**:
- **"Mission PR merged" is read from three sources**, cheapest first, stopping
  at the first that shows the merge (`missionShippingPrMerged`,
  `apps/web/src/lib/mission-pr-merged.ts`): the owner worker row's `mergedAt`
  (`findMissionPrOwner`); the mission PR's kernel delivery in state `MERGED`
  (any authority); one live GitHub read of the PR (`merged: true`). The worker
  row alone misses a merge whose webhook was lost, and the refresh then kept
  merging trunk into a shipped branch and filing conflict tasks for it. A
  failed read is "not shown merged", never merged. With no PR recorded for the
  mission there is nothing to read and the refresh proceeds. This is interim:
  the end state is refresh as a kernel effect that reads "shipped" from
  delivery state (`workflow-kernel-library` §6, AC-21).
- A paused, held or budget-exhausted mission gets no unsolicited refresh work: no
  merge and no conflict task from the backstop. Only a start, or an explicit
  authorized delivery action (the kernel's W4 on an approved mission PR), writes
  to it.
- Eligibility is checked on entry, and again as a WHERE clause on the two writes
  that commit to new work: the lease renewal immediately before the merges API,
  and the conflict-task reservation. A fenced write returns the state's reason
  (`mission_terminal`, `mission_paused`) rather than `in_flight`.
- The mission PR's merge state is read on entry (after the repo is resolved,
  before the lease), re-read immediately before the merges API, and re-read
  immediately before a reserved conflict task is finished, since a reservation
  can be older than the merge. None of them files a task for a merged mission.
  What remains is the gap between that read and GitHub's write. A refresh that
  lands in it merges trunk, which already contains the mission, into a branch
  nothing will merge again. That adds no mission content, loses nothing and
  changes no fact. If the branch was deleted on merge, the API answers an error
  outcome with no side effect.
- **Delivery epochs.** "Mission PR merged" here means the mission's current
  delivery. Task `f3bda4e1` (mission lifecycle with delivery epochs) owns
  rotation to a successor delivery. When that lands, this check reads the
  current delivery's PR, and a refresh targets the current delivery's branch.
  This spec does not model epochs and does not rotate branches.

### Bounded start

**Invariants**:
- The claim waits at most `START_REFRESH_BUDGET_MS` (4 s). After it, the task
  starts on the integration branch head as it then is. That base is recorded
  where git records it: the task branch's fork point, which its PR's compare
  reports. `branchRefreshHeadSha` records the last trunk sha the branch was
  confirmed to contain. Nothing asserts the base is fresh: a stale base costs a
  later behind refresh of the task PR, never correctness.
- A refresh still running at the budget is handed to `keepAlive`. The claim's
  subscriber passes `after()`, so the platform keeps the request alive while it
  finishes. Nothing depends on that: ownership is the lease row, not the
  promise.
- If the request is torn down mid-refresh, its lease is left set and expires
  after `BRANCH_REFRESH_LEASE_MS`. Every exit path clears the lease, so a set,
  expired lease means an abandoned refresh. The next hourly backstop treats it as
  due, whatever `branchRefreshedAt` says. Until then a start coalesces into the
  live lease (`in_flight`), and after expiry any caller may take it over.
- The abandoned caller cannot act on a successor's work. Every write after
  acquisition is fenced on its lease token. An expired caller that resumes
  cannot release the successor's lease, record `branchRefreshHeadSha` or
  `branchRefreshedAt`, or reserve a conflict task. It can still reach the
  merges API if its lease expired during the call itself. That is a second merge
  of trunk, answered 204 or as one more clean merge commit: idempotent, never a
  lost commit.

### Race safety

**Invariants**:
- **No lost commits.** See "Writers". Every write is a merge or a pinned
  landing, and every ref update is compare-and-swap.
- **No writes to a terminal mission.** See "Eligibility". Fences sit at both
  commit boundaries.
- **Stale lease holders.** A holder whose lease was taken over cannot clear the
  successor's lease or pointer, or publish completion
  (`branchRefreshHeadSha`/`branchRefreshedAt`). Each of those writes requires its
  token.
- **Unknown GitHub outcomes.** A merges call that fails without a definite answer
  (5xx, network) is an `error` outcome and records nothing. The retry re-asks
  GitHub: a merge that did land answers 204 and is recorded then. A 409 is
  definite. A reservation made under it is completed rather than repeated (see
  "Conflict task").
- **Duplicate and delayed events.** A duplicate start, a backstop pass or a late
  trigger is one more caller. The lease, the `branchRefreshHeadSha` idempotency
  check and the conflict pointer coalesce any number of them into at most one
  merges call per trunk head, and one conflict task.
- **Concurrent landings.** The refresh lease does not cover W2–W5, and it does not
  need to: their safety is GitHub's compare-and-swap plus the kernel's pinned
  merges and head rules ("Writers").

### Conflict task

**Invariants**:
- A mission has at most one conflict task, named by `branchRefreshConflictTaskId`.
  The pointer is reserved under the lease token before the row is inserted. The
  insert uses that id and is idempotent on it.
- **A reservation is completed, never abandoned.** A pointer that names no row
  means a dispatch has not inserted yet, or died first. The next lease holder
  finishes it under the same id, without another merges call: the reservation is
  evidence of the 409. A slow original and the finisher produce one row between
  them, and the slower one reports `dispatched: false`. A crash between
  reservation and insert cannot stop refreshing.
- **Settlement, not completion, clears the pointer.** It stays set while:
  - the task is non-terminal;
  - a retry it spawned (`parentTaskId`) is non-terminal;
  - its PR is open;
  - its PR merged but the live branch head does not yet prove ancestry
    (`refresh_unverified`, recorded once).

  It clears only when the merged PR's ancestry is proven on the live head
  (`verifyRefreshLanded`: the trunk sha it was dispatched for and the mission
  head it started from are both ancestors), or when the task, and any retry,
  ended with no merged PR (a person's judgment, or a failure). A worker
  completing with its PR open settles nothing.
- **A refresh task can complete without a PR** (the `pr_required` gate in
  `PATCH /api/workers/[id]`, for a task whose context carries
  `requireMergeCommit` and the refresh trunk sha). It counts as done, with no
  PR of its own, when either:
  - the integration branch already contains the trunk sha the task was filed
    for (the compare reads `ahead` or `identical`). GitHub refuses an empty PR,
    so a builder that finds the merge already there has nothing to open;
  - or the mission's shipping PR merged (`missionShippingPrMerged`). The
    refresh is moot, and the branch may already be deleted, which makes the
    ancestry read fail.

  The evidence is recorded on the task result as `refreshAlreadyLanded`
  (`evidence: branch_contains_trunk_sha`, or `mission_pr_merged` with
  `missionPrNumber`). With neither, completion is refused by the same
  `output_requirement` gate as any `pr_required` task. A worker with its own
  commits or edits still needs `discardEdits`. End state: `workflow-kernel-library`
  §6, AC-22.
- The conflict task's PR lands as a merge commit at every buildd merge door
  (`resolveMergeMethod`). A squash that slips through (a person on GitHub) is
  `refresh_unverified`: no replacement task. One real merge of trunk into the
  branch repairs it, and settlement then clears the pointer.
- The repair re-enters the normal flow. The conflict task's PR is a kernel
  delivery into the integration branch, with review and CI as for any task PR.
  Generated-file recovery is "Resolving a refresh conflict"; review reuse is
  `workflow-state-kernel` §5.9. Landing it moves the integration branch, so an
  open mission PR re-runs CI on its new head and its approval is carried or
  re-reviewed by §8.3. Once settled, the next refresh merges trunk again, and the
  kernel's W4 keeps an approved, behind mission PR current.

### Liveness

Every non-terminal operation has an owner and a durable next action:

| Operation state | Owner | Next action (durable) |
| --- | --- | --- |
| Refresh lease held | the holder's request | it releases on every exit; if it dies, the lease expires (`BRANCH_REFRESH_LEASE_MS`) and the hourly backstop retries |
| Conflict pointer reserved, no row | the next lease holder | hourly backstop or next start finishes the insert under the same id |
| Conflict task pending or running | the task system (claim, worker) | the task's own lifecycle; the backstop re-checks hourly |
| Conflict PR open | the kernel's delivery for that PR | review, CI, repair and landing (`workflow-state-kernel`) |
| Conflict PR merged, not yet settled | the refresh | hourly backstop or next start settles it |
| `refresh_unverified` (squashed) | a person | concrete blocker: the mission note names the PR, the missing sha and the one repair; refreshing resumes on its own once the live head proves ancestry |
| Mission paused or held | a person | no refresh work is pending; the next start or resume refreshes |

**Invariants**:
- No operation waits on an in-memory promise, a single webhook delivery, or a
  worker's report alone. Each state above is a database row, plus the hourly
  backstop that re-reads it.
- Reconciling never creates a second conflict task (the pointer), never clears
  the pointer without settlement, and never leaves the pointer set past the
  task's real end (settlement re-runs hourly while the mission is in use).
- The only state the system cannot clear by itself is `refresh_unverified`. It is
  a concrete human blocker with a named repair, not a stuck "Repairing".

### User surface

**Invariants**:
- The mission surfaces show the delivery facts the kernel projects for the
  conflict task's PR and the mission PR (`workflow/projections.ts`): "Updating
  branch" or "Waiting to update branch" while it is brought current, "Approved ·
  awaiting merge" or "Ready to land" while it waits to merge, and "Merged". This
  spec adds no status card, no "Why this?" and no raw state.
- A refresh conflict appears as its task, linked like any mission task. A
  refresh that cannot settle appears as one mission note, posted once, naming
  the PR and the repair.
- Coordination internals (leases, tokens, reservations, outcomes such as
  `in_flight`) stay in diagnostics: the gate ledger (`mission_branch_refresh`),
  the cron's sweep result, and logs.

### Decision history

Knowledge decision `c5898e01` ("dev→mission/* refresh is now automatic") prescribed
a refresh on every trunk merge. Its reversal of `mission-delivery-arc` P5 (keep
the integration branch current automatically) stands. Its trigger does not: the
per-trunk-merge subscriber was removed for the on-demand triggers above
(`knowledge-base: buildd/design/mission-branch-refresh-on-demand.md`), and its
"exactly one task until terminal" settlement became settlement by proven
ancestry. This spec is the authority on both.

**Acceptance criteria**:
- AC-21: GIVEN a refresh in flight WHEN its mission is completed or archived
  before the merges call THEN no merge is made and the lease is released.
- AC-22: GIVEN a 409 WHEN the mission is archived before the conflict task is
  reserved THEN no conflict task exists.
- AC-23: GIVEN the mission PR merges while a refresh is in flight WHEN the refresh
  reaches the merges call THEN it stops with `mission_pr_merged`.
- AC-24: GIVEN a paused, held or budget-exhausted mission WHEN the backstop runs
  THEN it makes no write. A backstop refresh paused mid-flight makes none either.
- AC-25: GIVEN a paused and held mission WHEN one of its tasks is claimed THEN the
  refresh runs.
- AC-26: GIVEN a merges call whose answer was lost after it landed WHEN the
  refresh is retried THEN GitHub's 204 is recorded, and no commit or task is
  duplicated.
- AC-27: GIVEN a failed conflict task whose retry is running WHEN a refresh runs
  THEN no second conflict task is created.
- AC-28: GIVEN a reservation whose insert outlives the lease, or whose caller died
  WHEN the next caller runs THEN exactly one task exists, under the reserved id.
- AC-29: GIVEN a start refresh past its budget whose request is torn down WHEN its
  lease expires THEN the next backstop refreshes the mission, even inside its
  daily window.
- AC-30: GIVEN a conflict pointer WHEN the backstop runs inside the daily window
  THEN the pointer is settled.
- AC-31: GIVEN a real conflict WHEN the repair lands as a merge commit across a
  task landing and further trunk moves THEN the pointer clears on proven
  ancestry, one task was created, and the branch holds every side's commits.
- AC-32: GIVEN a refresh and a task PR landing in either order THEN both land and
  the branch holds every commit.
- AC-33: GIVEN a mission PR approved at head H WHEN a refresh moves it to H' THEN
  a landing pinned to H is refused with nothing reaching trunk, and after the
  mission PR merged the refresh never writes the branch again.
- AC-34: GIVEN a mission whose shipping PR merged but whose owner worker row has
  no `mergedAt`, and its kernel delivery or GitHub shows it merged WHEN a task
  starts or the backstop runs THEN no merges call is made and no refresh task is
  filed.
- AC-35: GIVEN a reserved conflict task WHEN the mission PR merged after the
  reservation THEN finishing it files no task.
- AC-36: GIVEN a refresh task with no PR WHEN it completes and the branch
  contains its trunk sha, or the mission's shipping PR merged THEN completion
  succeeds and the evidence is on the task result; with neither it is refused.

### Spec-to-test matrix

| Invariant / AC | Test |
| --- | --- |
| AC-1–AC-5, single-flight, stale holder fencing | `apps/web/src/lib/mission-branch-refresh.test.ts` › `refreshMissionIntegrationBranch` (incl. "an expired caller cannot dispatch twice or release its successor lease", "does not merge after its lease expires…") |
| AC-6, AC-7 (no `pr.merged` trigger; claim emits) | `apps/web/src/modules.test.ts`, `apps/web/src/app/api/workers/claim/route.test.ts` |
| AC-8–AC-14 | `mission-branch-refresh.test.ts` › `refreshMissionBranchesBeforeStart`, `sweepMissionBranchRefresh` |
| AC-21–AC-27, AC-29, AC-30 | `mission-branch-refresh.test.ts` › "interleavings: mission state, unknown outcomes, and request termination" |
| AC-28 | `mission-branch-refresh.test.ts` › "a reservation whose insert outlives the lease…", "a caller that died between reserving and inserting…" |
| AC-31–AC-33 (real Git ancestry, lost commits, pinned landing) | `mission-branch-refresh.test.ts` › "real Git: refresh, task landings, the repair and the mission PR interleave…" |
| Squash detected on the live head | same, "a squash-landed repair is caught by the live ancestry check…"; `apps/web/src/lib/integration-refresh.test.ts` |
| Merge-commit-only at every door | `apps/web/src/lib/integration-refresh.test.ts`, `apps/web/src/lib/conflict-retry.test.ts` |
| Approval carried or re-reviewed when the mission PR's head moves (§8.3) | `packages/workflow-kernel/src/reducer.test.ts` ("APPROVED (S2)…", "APPROVED (S3)…", "LANDING: aborts landing to a new round when not equivalent"); `apps/web/tests/db/workflow-matrix.test.ts` (carry-forward, S10 pinned landing) |
| A moved head refuses a pinned merge | `apps/web/src/lib/workflow/pr-landing-effects.test.ts` ("a moved head is not a refusal…") |
| Generated-file recovery (AC-15–AC-20) | `scripts/resolve-generated-conflicts.test.ts` |
| AC-34, AC-35 | `mission-branch-refresh.test.ts` › "the shipping PR merged but the owner worker row has no mergedAt"; `apps/web/src/lib/mission-pr-merged.test.ts` |
| AC-36 | `apps/web/src/app/api/workers/[id]/route.test.ts` › "mission-branch refresh already on the branch" |

The real-Git cases run the production refresh and `verifyRefreshLanded` against a
local repository that stands in for GitHub, one atomic operation per API call.
The database side of those cases is the in-memory row the rest of the file uses,
which applies each `UPDATE … WHERE` predicate the code builds, lease token and
state fence included. The kernel's real-Postgres suite (`apps/web/tests/db/`)
already covers the delivery side of AC-33.

## Resolving a refresh conflict

**Capability statement**: `scripts/resolve-generated-conflicts.ts` (`bun run
conflicts:generated`) MUST resolve the conflicted files a script writes by
regenerating them. It MUST leave every other conflict untouched, and MUST exit
non-zero while any conflict remains. The refresh conflict task and the per-PR
conflict retry both tell the agent to run it first.

**Invariants**:
- It refuses to run outside a merge in progress (`MERGE_HEAD`).
- It edits only paths `isGeneratedArtifactPath` accepts.
- `docs/specs/INDEX.md` is regenerated by `specs:check`. While another
  `docs/specs/` file is conflicted, it waits.
- `scripts/design-check.baseline.json` is merged per file with git's three-way
  rule:
  - a count both sides agree on, or only one side changed, is kept;
  - when both changed it differently, both changes are kept.

  Then `design:check --update` lowers it to today's counts. While a file under
  `apps/web/src/` is conflicted, it waits, because conflict markers would make
  each count include both sides.
- `packages/core/drizzle/` is repaired by `regenerateAgainstBase` against
  `MERGE_HEAD`. That is trunk's migration folders as they are, plus this
  branch's schema change regenerated on top of them (a conflict here is a branch
  cut before the drizzle v1 cutover: its journal was modified, trunk deleted it).
  It runs last, and waits while any other conflict remains.
- A regenerated migration whose SQL differs from the one it replaced is left for
  a person.
- Exit 0: no conflicts remain. Exit 2: some remain, and each is listed. Exit 1:
  not in a merge.

**Acceptance criteria**:
- AC-15: GIVEN only `docs/specs/INDEX.md` conflicts WHEN it runs THEN the index is
  regenerated and staged, and it exits 0.
- AC-16: GIVEN only the drizzle journal and snapshots conflict WHEN it runs THEN
  the migration renumber runs against the trunk being merged, and it exits 0.
- AC-17: GIVEN a source file conflicts WHEN it runs THEN that file is unchanged,
  listed as remaining, and the exit is 2.
- AC-18: GIVEN both sides already lowered a baseline count to the same value WHEN
  it runs THEN that value is kept, not subtracted twice.
- AC-19: GIVEN the regenerated migration's SQL differs from what it replaced WHEN
  it runs THEN the drizzle step is reported for a person, and the exit is 2.
- AC-20: GIVEN no merge is in progress WHEN it runs THEN it refuses, with exit 1.

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
- `apps/web/src/lib/mission-pr-merged.ts`: `missionShippingPrMerged`, the
  three-source "mission PR merged" read.
- `apps/web/src/app/api/workers/[id]/route.ts`: the `pr_required` arm that
  completes a refresh task without a PR (`refreshAlreadyLanded`).
- `scripts/resolve-generated-conflicts.ts`: `resolveGeneratedConflicts`,
  `mergeBaselineCounts`.
- `packages/core/generated-artifacts.ts`: `isGeneratedArtifactPath`,
  `isCiVerifiedGeneratedPath`, `isMigrationSqlPath`.
- `packages/core/db/migration-layout.ts`: `regenerateAgainstBase`.
- `packages/core/db/schema.ts`: `missions.branchRefreshHeadSha`,
  `branchRefreshedAt`, `branchRefreshLeaseUntil`, `branchRefreshLeaseToken`,
  `branchRefreshConflictTaskId`.

## Out of scope

- Refreshing a task PR against the integration branch. That is the kernel's
  behind refresh of that PR.
- How a refresh PR is reviewed: `workflow-state-kernel` §5.9 (a composition
  whose only novel delta is what the merge decided).
- Missions without an integration branch (`branchStrategy: direct`).
