---
title: Workflow State Kernel
status: draft
owner: max
last_verified: 2026-10-19
summary: One kernel MUST own each task-to-PR-to-review-to-merge delivery's state, advance it only by version-checked transitions citing GitHub-confirmed evidence, and leave other lifecycle columns fact caches or projections.
domain: tasks
surfaces: [apps/web/src/app/api/workers/[id]/route.ts, apps/web/src/app/api/github/webhook/route.ts, apps/web/src/lib/pr-landing.ts, apps/web/src/lib/workflow/landing.ts]
related: [workflow-kernel-library, mission-task-lifecycle, pr-lifecycle-reconciliation, task-dispatch-authority, surface-merge-ordering]
keywords: [workflow kernel, delivery state, AWAITING_PUSH, review round, head sha binding, outbox, CAS, fix_ended, stale verdict, write sites, review composition, durable findings, merge doors, landing authority, merged over open findings]
verified_by: [apps/web/tests/db/pr-facts.test.ts, packages/workflow-kernel/src/delta-approval.test.ts, apps/web/src/lib/workflow/review-round-metrics.test.ts, packages/core/__tests__/generated-artifacts.test.ts, apps/web/tests/db/workflow-scenarios-repeat.test.ts, packages/core/__tests__/pr-fact-write-sites.test.ts, apps/web/src/lib/workflow/pr-fact-effects.test.ts, apps/web/src/lib/pr-fact-import.test.ts, packages/workflow-kernel/src/projections.test.ts, apps/web/src/lib/workflow/review-composition.test.ts, apps/web/src/lib/workflow/pr-activity-render.test.ts, apps/web/src/lib/action-queue.delivery-view.test.ts, packages/workflow-kernel/src/reducer.test.ts, apps/web/src/lib/workflow/review-effects.test.ts, apps/web/src/lib/workflow/pr-landing-effects.test.ts, apps/web/src/lib/pr-landing.test.ts, apps/web/src/lib/auto-merge.test.ts, apps/web/src/lib/ci-verdict.test.ts, apps/web/tests/db/workflow-probe-github.test.ts, apps/web/tests/db/workflow-probe-concurrency.test.ts, apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts, apps/web/src/app/api/github/pr/route.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/prs/[prNumber]/retry-ci/route.test.ts, apps/web/src/lib/ci-failure-retry.wake.test.ts, apps/web/tests/db/workflow-matrix.test.ts, apps/web/tests/db/review-request-authority.test.ts, apps/web/tests/db/review-provenance.test.ts, packages/core/__tests__/pr-shipped.test.ts, apps/web/src/lib/mission-completion.test.ts, apps/web/src/lib/pr-supersession.test.ts, apps/web/src/app/api/github/pr/supersede/route.test.ts, apps/web/src/app/api/github/pr/review/route.test.ts, apps/web/src/lib/workflow/facts.test.ts, apps/web/src/lib/workflow/github-facts.test.ts, apps/web/src/modules.test.ts, apps/web/src/lib/workflow/conflict-retry-effects.test.ts, apps/web/src/lib/conflict-retry.test.ts, apps/web/src/lib/workflow/trunk.test.ts, apps/web/src/lib/workflow/trunk-inherited.test.ts, apps/web/src/lib/workflow/delivery-display.test.ts, apps/web/src/lib/explain-because.test.ts, apps/web/src/lib/explain.test.ts, apps/web/src/lib/pr-presentation.test.ts, apps/web/src/lib/pr-list.test.ts, packages/core/__tests__/workflow-write-sites.test.ts, apps/web/tests/db/workflow-scenarios-treadmill.test.ts, apps/web/src/lib/workflow/base-delta.test.ts, apps/web/tests/db/workflow-scenarios-lane.test.ts, apps/web/src/lib/repair-completion.test.ts, apps/web/src/lib/mission-state-view.landing.test.ts, apps/web/src/lib/pr-predecessors.test.ts, apps/web/src/lib/retry-pr-supersession.test.ts, apps/web/src/lib/migration-inspector.test.ts, apps/web/src/app/api/workers/claim/claim-plan-input.test.ts, apps/runner/__tests__/unit/worktree-mission-integration-guard.test.ts, apps/runner/__tests__/unit/worktree-base-branch.test.ts, packages/core/__tests__/repair-target.test.ts, apps/web/src/lib/workflow/coordination-owner-review.test.ts, apps/web/src/lib/loop-dispatcher-policy.test.ts]
supersedes: []
---

# Workflow State Kernel

**Status of this document.** Phase 1 of the mission "Workflow kernel: authoritative
task → PR → review → merge state". It is the implementation contract for Phase 2 and
changes no behaviour. It is `draft`: symbols and tables named below that do not exist
yet are the proposal, not a claim about the code. Everything described as "today" was
read from the tree at the base commit of this branch; line numbers drift, so re-grep
the quoted symbol before editing a site.

**Why it lives in `docs/specs/`, not `docs/design/`.** `bun run public-docs:check`
(`scripts/check-public-docs.ts`) fails any `docs/design/*.md` that is not a frontmatter
stub, because design prose belongs in the private knowledge base. This contract has to
be reviewable in the PR and checked by `bun run specs:check`, so it is a draft spec.
When Phase 2 ships, flip `status` to `active` and fill `verified_by` (§16).

**Slice A part 1 is live (no dark phase).** The review fix loop of every PR whose
first review is dispatched after deploy is kernel-owned: deliveries open at the
legacy first-review dispatch points, review rounds, the verdict (T6), fix dispatch
(T8) and claim (T9), attempt end (T4), the §9 completion gate, `synchronize` heads
(T3) and close/reopen facts (T17–T19) run through `apps/web/src/lib/workflow/seam.ts`,
and the legacy write is skipped for those PRs. **Part 2 adds the CI family**: a
red CI result on a kernel-owned PR is T10 on the `ci` ledger (the `check_suite`
webhook, the red-PR sweep and the dashboard "Fix CI" all reach it), the CI fix task
is filed by the `dispatch_ci_fix` effect, pushes are attributed by SHA set (§6.9) and
`isBuilddWorkerCommit` is gone. **Part 3 adds the read side**: a `DeliveryView` with
one owner of the next move feeds Home, the task page and the mission failure
reading; the PR activity comment is regenerated from transitions; release and
integration PRs are checked by composition; S35–S37 hold. **Slice B part 1 moves the
PR fact cache onto one funnel**: `recordPrFact` (`packages/core/pr-facts.ts`) is the
only writer of `workers.prLifecycleStatus` / `mergedAt`, with terminal-wins in its
`WHERE`; `pr-state-reconcile.ts` is deleted and pages no longer write while they
render. **Slice B part 2 adds the conflict and migration families**, mechanical first
(§13.4). **Slice B part 3 adds the trunk circuit breaker**: a CI failure the base
branch shares joins one trunk incident, one trunk fix runs for it, and the blocked
PRs resume when the base is green (§13.5). Its base-red rule is **on by default**; a
workspace turns the breaker off with `gitConfig.trunkBreaker = false`. **Slice C
moves landing and merge**: every merge door keeps its rails and,
for a kernel-owned PR, hands the merge to the kernel (T15 `LandingRequested` → the
`merge_call` effect → T16 `MergeCallResult` → `verify_merge` → T17); the post-merge
work is outbox effects, and a person on a stale version gets HTTP 409 with the
current view. **Slice D moves a closed PR's resolution and mission completion's
input**: supersession is T20 and abandonment T21 for a kernel-owned PR (the worker
columns are their projection), a PR closed because its base branch was deleted is
`CLOSED_UNMERGED(base_deleted)`, the supersession scan is an effect of the close,
and `prShipState` answers from the delivery. **Slice E moves every projection**:
for a kernel-owned delivery the task card stage, the tasks list, the mission
board and Landed strip, the mission feed, the task page's PR tile, card and
shipped header, explain's state chain, history and `because[]`, and the chat
tile, dock and PR object all read `getDeliveryView`, and the duplicate PR-state
maps are deleted (§13.9). What each slice landed and its deviations (§13.1 to
§13.10) is in `knowledge-base: buildd/reports/workflow-state-kernel-history.md`; §14
is the cutover and the kill switch. **§13.13** holds review composition (its
criteria AC-20 through AC-23 stay here) and the findings, repair and landing rules written against PR #4686,
whose criteria and shipped status now live in the native spec "Workflow kernel"
(fa62b865, `workflow-kernel-library.md`).

**Capability statement.** For every deliverable that is meant to reach GitHub as a
pull request, exactly one row (the *delivery*) records where the work stands. That row
changes only through a transition that (a) names the state it expects, (b) carries the
evidence the transition table requires, and (c) is applied with a version compare-and-set
in the same statement that records its follow-up effects. Raw facts from workers,
GitHub and reviewers are recorded as facts; they never assign state by themselves.

---

## 1. Problem

### 1.1 The incident this contract is written against (PR #3754)

A task asked for one authorization fix on the supersede route. Its PR (#3754, one commit
at head `H1`) was reviewed once and the reviewer asked for changes against `H1`: the
route checked the PR owner's task instead of the caller's. A fix task was dispatched and
finished "successfully". The outcome it reported says "PR #3754 updated with corrected
implementation and test cases", and the PR body was rewritten to describe the corrected
check. But the PR's only commit on GitHub stayed `H1`, whose message still describes the
wrong check. The corrected commit existed (at most) in the fix worker's local worktree;
nothing observed that it never reached the remote.

What the platform then did, in order:

1. The PR activity comment recorded `fix_ended` for the fix attempt and moved on.
2. A second reviewer round was queued **against `H1` again** ("Re-reviewing · after fix 1
   of 3 · verdict went stale · PR #3744 is now closed"). Nothing had changed for it to
   review.
3. CI stayed green on `H1`; GitHub reported no reviews. The PR sat open.
4. The friction task that motivated #3754 retried, hit the same 403 (the fix was
   "not yet deployed"), and completed `SUCCESS` with a note that #3754 was still open.
5. The goal criterion "all task PRs merged" stayed red, and the sibling PR whose
   supersession the fix was meant to record stayed unrecorded.

Every individual step was locally reasonable. Four independent writers each believed
"the fix is done": the worker's own completion, `tasks.status`, the activity comment's
`fix_ended`, and the PR body. None of them was a statement about what GitHub holds.

### 1.2 The class, from prior incidents

| Incident | What the model got wrong | Kernel rule that closes it |
|---|---|---|
| #3754 (above) | Fix "done" without a pushed head | §9: leaving `FIXING`/`AWAITING_PUSH` needs an observed GitHub head that advanced |
| #2574 | A verdict at an old head treated as proof a push fixed it | §8: verdict is valid only for the (PR, head, round) it was made on |
| #3420 | Two fix tasks for one verdict; nothing cancelled the loser | §7 CAS + §6 `FixDispatched` keyed by round |
| #3606, #3277 | Approved PR strands on a stale blocker; sweeps cannot repair | §11: sweeps import facts and re-enqueue effects; the reducer reacts |
| webhook finding 1 | A late `synchronize` overwrites `merged`/`closed` | §6 stale-event column; §11 |
| reaper findings G8/G9 | A stale worker with only local commits becomes `completed` with `result.sha` set | §9: reaper reports `AttemptEnded(lost)`, never success |
| friction 8dc52cd9-style stale_approval | Bot base-merge changes head, approval silently resets | §8.3 carry-forward is an explicit recorded transition |

### 1.3 Root cause

There is no canonical lifecycle row. State is spread over `tasks.status`,
`workers.status`, `workers.prLifecycleStatus`, `workers.mergedAt`, the `supersededBy*`
and `abandoned*` columns, reviewer tasks' JSONB (`tasks.result`, `tasks.context`), the
activity comment, and `tasks.context.landing`. About thirty modules write them and each
decides locally what happened. The inventories in §17 are the evidence.

### 1.4 Characterization evidence: the 14-day lifecycle and retry audit

An independent read-only audit (artifact key `pr-lifecycle-retry-audit-14d`; exact
figures stay in the private knowledge base per the repo's no-production-data rule, so
this section is qualitative) measured the same defect class from the outside. It is the
characterization evidence for the rules below; each finding names the section that
answers it.

| Audit finding | Mechanism in the code today | Answered by |
|---|---|---|
| The CI retry cap often never advances; most CI-fix comment rows read "fix 0 of 3" while the task title says #1. A trunk-breakage afternoon produced a storm of "#1" retry tasks on two dependency-bot PRs | `isBuilddWorkerCommit` (`apps/web/src/lib/ci-failure-inspect.ts`) counts a commit as the worker's own only when authored by the bot identity; runner worktrees commit under the owner's git identity, so most worker pushes are classed *foreign* and a foreign push does not advance `context.iteration` | §5.7, §6.9: attempts are allocated at dispatch and recognised by provenance (SHA sets), never by author string |
| Per-PR retry storms when trunk or a policy gate is red | every open PR goes red, each gets its own retry, each retry pushes a workaround | §4 `BLOCKED_ON_TRUNK`, §5.8, T25/T26; §6.10 policy checks before push |
| A meaningful minority of retries were stale or no-ops: the PR was already merged, fixed or approved by the time the task claimed | dispatch decided from a snapshot; nothing re-read GitHub at claim | §10.5: revalidate at dispatch and again at claim; stale dispatch disappears idempotently |
| The persistent PR comment is misleading on about a third of PRs and plainly state-wrong on a meaningful fraction (conflicts never shown; "Approved" headline while CI is red; `merged` missing or displaced; stuck "Reviewing"; duplicate sticky comments) | state lives inside the comment; `appendPrActivity` is an unsynchronised read-modify-write; no kinds exist for CI green, CI red without a retry, or conflicts; entries after a merge displace the headline | §12.1: the comment is a pure projection, regenerated and convergent; explicit kinds; headline from canonical state |
| Conflict and migration retries are mostly mechanical (merge base in, renumber a migration) yet run as agent tasks | one retry task type for everything | §6.7: mechanical platform effects versus agent-required repair |
| Counters are ambiguous: CI and review share `context.iteration`, conflict has its own key, migration renders no number, the manual "Fix CI" path starts again at zero and ignores the workspace cap | budgets live in whichever task's `context` was handy | §5.7: one ledger per family, shared 1-based "attempt N of M" view; infra requeues never count |
| Path-claim enforcement is degraded (leases skipped past a path cap), and claims defer rather than prevent conflicts | advisory lease table | §7.7: the kernel does not rely on path claims for consistency |
| Reviewer prose with no structured verdict, runner hand-off failures ("no confirmed outcome", "commits but no PR", "uncommitted changes"), and PRs that merged with no verdict covering the merged commit | the worker's *completion* is treated as the lifecycle step | §6.6: completion is a fact; only a valid transition moves state |

The audit also fixes a calibration for the design: most PRs need no retry at all, and
most retries that did run were not caused by the PR's own product code. The kernel's
job is therefore less "retry better" than "stop dispatching work that platform
bookkeeping, trunk health or a stale snapshot made unnecessary, and never let a counter
or a comment disagree with GitHub".

---

## 2. Raw facts versus canonical state

A **fact** is something that was observed. It has a source, an observation time and a
natural key, and it can be wrong only by being stale. **Canonical state** is the
workflow's own decision about what happens next. A fact never edits state; a transition
cites facts.

| Fact (immutable observation) | Source of truth | Natural key | Staleness handling |
|---|---|---|---|
| Worker/attempt exited (`completed`, `failed`, `lost`) | Runner PATCH to `/api/workers/[id]`, or reaper | `(attempt_id, 'exit')` | An exit for a superseded attempt is recorded, not applied |
| Local commit exists (`commitCount`, `lastCommitSha`) | Runner `collectGitStats` | `(attempt_id, local_sha)` | **Never evidence of delivery** (§9). Recorded as `local_head_reported` |
| GitHub head SHA of the PR branch | GitHub live read (`GET /pulls/{n}`), after any webhook hint | `(repo, pr, sha)` | Reducer applies the live head, not the payload head (§6.3) |
| CI conclusion | GitHub check suites / runs for one SHA | `(repo, pr, sha, 'ci')` | Applies only if `sha` equals the delivery's current head |
| Mergeability / conflict | GitHub `mergeable_state` for one SHA | `(repo, pr, sha, 'mergeable')` | Same |
| Review verdict | Reviewer task output, bound to the head it reviewed | `(round_id, 'verdict')` | Valid only for its own (PR, head, round) (§8) |
| Human GitHub review | GitHub review with `commit_id` | `(repo, pr, review_id)` | Counts for the head in `commit_id` only |
| PR merged | GitHub read: `merged=true`, `merged_at`, `merge_commit_sha` | `(repo, pr, 'merged')` | Terminal; replay is a no-op |
| PR closed unmerged / reopened | GitHub read: `state` | `(repo, pr, 'closed'|'reopened', updated_at)` | Reducer re-reads; ordering by live state, not arrival |
| PR base changed (retarget) | GitHub read: `base.ref`, after a `pull_request.edited` with `changes.base`, or any live read that disagrees with `delivery.base_ref` | `(repo, pr, from_base, to_base, version)` | The live base wins over the payload and over the stored `base_ref` (T29) |
| Merge call result | GitHub `PUT /merge` response | `(repo, pr, sha, 'merge_call')` | `indeterminate` is a fact, not a verdict |

**Canonical state** is `workflow_deliveries.state` plus its bound attributes (§4–5):
the stage, the current head, the current review round, the owed effects. These are the
only values a decision such as "may this merge", "is a fix owed", "is this mission
complete" reads.

Two rules fall out of this table and are repeated where they bind:

- **R1.** `workers.lastCommitSha` and `commitCount` are runner-reported facts about a
  local worktree. No reader or gate treats them as the GitHub head.
- **R2.** A webhook payload is a hint that something changed. The reducer
  acts on a GitHub read taken after the hint arrived.

---

## 3. Aggregate identity

The aggregate is a **Delivery**: the whole journey of one deliverable from the task
that owns it to its PR, its review rounds, its repairs and its merge.

- **Primary key:** `delivery_id` (uuid, internal).
- **Natural key before a PR exists:** `(workspace_id, owner_task_id)`. `owner_task_id` is
  the task whose output requirement is a pull request. Retry, fix, CI-fix, conflict-fix
  and reviewer tasks are **attempts** of the delivery, not deliveries: they carry
  `delivery_id` and a `role` (`owner`, `fix`, `ci_fix`, `conflict_fix`, `review`).
- **Natural key once a PR exists:** `(workspace_id, repo_full_name, pr_number)`, unique.
  Today the PR owner is found by `(workspaceId, prNumber)` with no repo
  (`resolveOrAdoptPrOwner`, `insertPrOwnerWorker` in `lib/pr-review-request.ts`), which
  collides across two repos in one workspace; the repo MUST be part of the key.
- **Adoption.** A PR buildd did not open (`request_pr_review` on an external PR) gets a
  delivery with a synthetic owner task, as it gets a synthetic owner worker today.
- **Not a delivery:** tasks whose output requirement is `artifact_required` or `none`
  and which never open a PR. They keep `tasks.status` as their only lifecycle. A task
  that is later found to have opened a PR gets a delivery through `PrBound`.
- **One open delivery per PR.** Duplicate worker rows for one PR (original plus
  retries; today `workerOwnsPr` lookups need `orderBy desc(createdAt)` to be
  deterministic) all point at one delivery, so no lookup depends on row order.

Missions are a different aggregate and stay one (`missions.status`,
`canCompleteMission`). They are *readers* of deliveries (§14, §18).

---

## 4. State vocabulary

`workflow_deliveries.state` takes exactly these values. "Owner of the next move" is who
the platform waits on; every non-terminal state has exactly one.

| State | Meaning | Owner of next move | Entered when |
|---|---|---|---|
| `WORKING` | An owner attempt is running or queued; local commits can exist | worker | delivery opened; attempt retried |
| `AWAITING_PUSH` | An attempt ended owing delivery: local commits exist (or a PR is required) but GitHub's head does not contain them | platform (`push_recovery` effect), then human | §9 |
| `AWAITING_REVIEW` | A PR head `H` exists and review round `r` is queued or running against `H` | reviewer attempt | head observed with no verdict at `H`; or a verdict at an older head was superseded |
| `CHANGES_REQUESTED` | Round `r` at `H` ended `request_changes`; a fix attempt is owed or queued | platform (`dispatch_fix` effect) | §6 `ReviewVerdictRecorded` |
| `FIXING` | A fix attempt claimed against `(H, r)` is running | fix worker | `FixClaimed` |
| `REPAIRING` | CI red, conflict, behind-base or migration collision on current head, with a repair owed or running; attributes `repair_kind` ∈ `ci`, `conflict`, `behind`, `migration` and `repair_mode` ∈ `mechanical` (platform effect, no agent) or `agent` (§6.7) | platform effect or repair attempt | §6 `CiFailedObserved`, `ConflictObserved` |
| `BLOCKED_ON_TRUNK` | The current head's CI failure matches an open trunk incident (§5.8): the base branch itself is red on the same failure, so no per-PR repair is dispatched. Attribute `resume_state` (the state to return to) and `trunk_incident_id` | trunk-fix attempt (one per incident) | T25 |
| `APPROVED` | An `approve` verdict is bound to the current head (or to a head recorded as equivalent) and nothing blocks landing except gates not yet satisfied | landing | `ReviewVerdictRecorded(approve)`; `HumanApproved` |
| `LANDING` | A merge or branch-refresh attempt for the current head is claimed | landing effect | `LandingRequested` |
| `ESCALATED` | A person must act; attribute `reason` ∈ `review_escalated`, `review_exhausted`, `review_unavailable` (no valid verdict after the bounded contract retry, or the round's `dispatch_review` went `dead`), `ci_exhausted`, `conflict_exhausted`, `push_undeliverable`, `landing_needs_human`, `effect_dead` (a critical effect went `dead` and no more specific reason fits, §10.3), `policy_human`, `unsafe_to_merge` | human | explicit transitions only |
| `MERGED` | GitHub confirmed the PR merged (terminal) | none | `PrMerged` |
| `CLOSED_UNMERGED` | GitHub confirmed the PR closed without merging; attribute `close_cause` (`manual`: a person on GitHub; `buildd_close`: a buildd door, from its `pr.close` capability decision; `base_deleted`, `superseded_by_policy`, `unknown`), with the closer (webhook sender, the door's worker/task and reason) on the transition | platform (supersession scan), then human | `PrClosedUnmerged` |
| `SUPERSEDED` | Closed unmerged, and a verified merged PR carries the work (terminal) | none | `SupersessionRecorded` |
| `ABANDONED` | Closed unmerged and a human declared the work dropped (terminal) | none | `Abandon` |
| `FAILED` | The owner task ended terminally failed or cancelled with no PR to carry (terminal for the delivery; a new owner task opens a new delivery or reopens by `DeliveryOpened`); attribute `reason` | none | `AttemptEnded` with no retries left |

Rules over the vocabulary:

1. **Terminal states are `MERGED`, `SUPERSEDED`, `ABANDONED`, `FAILED`.** A terminal
   state wins over any later non-terminal fact (generalising invariant I-2 of
   `pr-lifecycle-reconciliation`). `CLOSED_UNMERGED` is terminal for the PR but reopens
   on `PrReopened`, and is the only non-terminal state from which `SUPERSEDED`/`ABANDONED`
   are reachable.
2. **CI and mergeability are facts on a head, not states.** A delivery in
   `AWAITING_REVIEW`, `APPROVED` or `LANDING` records `ci` and `mergeable` for its
   current head as attributes; only a red/conflict fact on the *current* head moves it
   to `REPAIRING`.
3. **`AWAITING_PUSH` is entered from `WORKING`, `FIXING` and `REPAIRING`** and leaves
   only through an observed head that satisfies §9 (or `ESCALATED(push_undeliverable)`).
4. **No state is derived from a timer.** Elapsed time creates retry effects and
   alerts, never a state (§11).
5. The legacy name `ci_running` etc. is a fact attribute (`ci: running|green|red|none`),
   not a state.

---

## 5. Data model

All new tables live in `packages/core/db/schema.ts`; generate the migration with
`cd packages/core && bun db:generate` and follow `.claude/skills/schema-change/`
(the migration index must be re-compared with `origin/dev` immediately before pushing;
at the base commit of this branch the last index is 0248).

### 5.1 `workflow_deliveries` (the aggregate)

| Column | Notes |
|---|---|
| `id` uuid pk, `workspace_id` | cascade with workspace |
| `owner_task_id` unique with workspace | the deliverable's task |
| `repo_full_name`, `pr_number` | null until `PrBound`; unique `(workspace_id, repo_full_name, pr_number)` where not null |
| `state` text, `state_reason` text | vocabulary of §4; `state_reason` is `repair_kind`/`reason`/`close_cause` |
| `version` bigint not null default 0 | CAS counter (§7); incremented by every applied transition |
| `current_head_sha` | the GitHub head the delivery is acting on; set only by `HeadObserved` |
| `current_round` int, `max_rounds` int | review round bound to `current_head_sha`; `max_rounds` copies today's `maxIterations` (default 3) |
| `resume_state`, `trunk_incident_id` | set only while `BLOCKED_ON_TRUNK` |
| (no counters) | attempt budgets are rows of `workflow_attempts` (§5.7), one ledger per family; the delivery row holds no `iteration` number, so no two code paths can disagree about it |
| `approved_heads` text[] | heads covered by the standing approval: the approved head plus content-equivalent heads (today `context.equivalentHeadShas`) |
| `approval_basis` | `verdict`, `human`, `composition` or `policy` (no review required; never a verdict): what the standing approval rests on |
| `composition_heads` text[] | heads covered **only** by a verified composition attestation (§5.9); kept apart from `approved_heads` so no reader takes it for a verdict at that head |
| `bound_attempt_id` | the attempt whose end the delivery waits on in `FIXING`/`REPAIRING` (the `a` of `(H, r, a)`) |
| `ci` text, `ci_head_sha`, `mergeable`, `mergeable_head_sha` | latest fact for the *current* head only |
| `merged_at`, `merge_commit_sha` | GitHub's values, never receipt time |
| `superseded_by_pr`, `superseded_by_url`, `superseded_reason`, `recorded_by` | the existing supersession edge, owned here |
| `authority` (`kernel`\|`legacy`, default `kernel`), `released_at` | who decides (§14). `legacy` once the kill switch handed the delivery back; sticky |
| `created_at`, `updated_at`, `last_transition_at` | |

### 5.2 `workflow_review_rounds` (exact-head binding, §8)

`id`, `delivery_id`, `round` (unique with `delivery_id`), `head_sha` (not null),
`kind` (`full`|`delta`), `prior_round`, `reviewer_task_id` (nullable until dispatched),
`status` (`queued`|`reviewing`|`decided`|`failed`|`superseded`), `verdict`
(`approve`|`request_changes`|`escalate`|null), `effective_verdict`, `confidence`,
`decided_at`. Unique `(delivery_id, head_sha, kind)` over rounds whose status is
`queued` or `reviewing` (the single-flight rule, replacing the pending-only
`tasks_one_pending_review_per_head_unique`). `scope.trigger` records why the round
started (`RoundTrigger`, §8.3a) and `scope.endReason` how a superseded round ended
(`superseded_by_push` when a push replaced it); the read model lifts both out of `scope`.

### 5.3 `workflow_facts` (append-only)

`id`, `delivery_id` (nullable until bound), `repo_full_name`, `pr_number`, `kind`,
`fact_key` (**unique per workspace**), `workspace_id`, `observed_at`, `source` (`webhook:<event>`, `sweep:<name>`,
`runner`, `reviewer`, `merge_call`, `import`), `payload` jsonb (bounded), `applied_transition_id`
nullable. A duplicate `fact_key` is a no-op that returns the first application's
result. `payload` MUST NOT hold raw webhook bodies (size, secrets); it holds the
normalised fields the reducer read.

### 5.4 `workflow_transitions` (append-only log)

`id`, `delivery_id`, `from_version`, `to_version`, `from_state`, `to_state`,
`command` (§6 name), `idempotency_key` (**unique with `delivery_id`**), `actor`
(`runner`, `reviewer`, `webhook`, `sweep:<name>`, `human:<user>`, `agent:<task>`,
`kernel`), `evidence` jsonb (the fact ids and live-read values the table required),
`bypass` jsonb null (human override record), `created_at`. This table is the single
source for the PR activity comment, mission notes and the explain `because[]` chain.

### 5.5 `workflow_effects` (transactional outbox, §10)

`id`, `delivery_id`, `transition_id`, `kind`, `dedupe_key` (**unique**), `payload`,
`status` (`pending`|`delivering`|`done`|`failed`|`dead`), `attempt_count`, `not_before`,
`lease_until`, `last_error` (≤500 chars), timestamps.

### 5.6 Attempt linkage

`tasks.delivery_id` (nullable, indexed, no FK: the delivery row already references
its owner task) and `tasks.delivery_role` (`owner`, `fix`, `ci_fix`, `conflict_fix`,
`review`; a reviewer task of a round carries `review` and `context.workflowRoundId`,
a fix task `fix` and `context.workflowAttemptId`); `workers` keep their rows
unchanged. `tasks.reviewer_retry_pr_number`/`reviewer_retry_head_sha` and the other
`*RetryPrNumber`/`*RetryHeadSha` columns keep their unique indexes until Slice C, when
`dedupe_key` on `workflow_effects` replaces them as the dedupe authority (an index on
a column no code reads is dead weight, not a second authority, but delete it).

### 5.7 `workflow_attempts` (one retry ledger per family)

The single source for "attempt N of M". Every unit of repair work, mechanical or
agent, is a row.

| Column | Notes |
|---|---|
| `id`, `delivery_id`, `family` | `review_fix`, `ci`, `conflict`, `migration`, `trunk`; **no `infra` family** (below) |
| `attempt_no` int | 1-based, allocated by the dispatch statement; unique `(delivery_id, family, mode, attempt_no)` (a mechanical attempt has its own budget, so it has its own numbering) |
| `mode` | `mechanical` or `agent` (§6.7); a mechanical attempt has its own small budget and never consumes the agent budget of its family |
| `bound_head_sha`, `trigger_fact_id`, `trigger_reason` | the head it repairs and the fact that justified it (CI signature, `mergeable=dirty`, round id) |
| `task_id` | null for a mechanical attempt |
| `trigger` | `automatic` or `human`; a human retry is recorded as an explicit `BudgetExtended` transition, never as "iteration 0" |
| `reported_shas` text[], `pushed_head_sha` | provenance (§6.9): SHAs the attempt's worker reported or the kernel observed arriving while the attempt ran |
| `status` | `queued`, `running`, `ended`, `skipped` (stale, §10.5), `cancelled` |
| `outcome` | `delivered` (§9 proof held), `unproven`, `failed`, `noop` |
| `max_attempts` | frozen at allocation from `gitConfig` (`maxCiRetries` and siblings) or the policy default; the manual CI path uses the same source |

Rules:

1. **Allocation is consumption.** The attempt row is inserted, with its `attempt_no`,
   in the statement that dispatches it. A budget is spent when work is *dispatched*,
   not inferred later from who authored the resulting commit. The cap therefore
   bounds dispatches even if provenance recognition fails.
   One exception (a90fc99b): an attempt that ended `unproven` (reported success with
   nothing provable on GitHub) is not a try at the fix, so up to
   `UNPROVEN_ATTEMPT_ALLOWANCE` of them per family do not spend the cap; past it they
   count, so an agent that always claims success still ends.
   A second (295486ba): a `ci` attempt whose task is cancelled while the row is still
   `queued` (nobody claimed it) with nothing local is `skipped`, not a failure. It did
   no work, so it spends nothing, and the repair ends without filing the next attempt:
   the cancel was someone deciding this fix should not run. The red reading stays, so
   "Fix CI" or a new red head starts one again. A cancel after a claim, or the reaper's
   `lost` end, still spends the attempt.
2. **Infra requeues are not attempts.** A task requeued by the reaper, a budget wall,
   a mount gap or a provider failover keeps its own `infraRetryCount`/`retryCount`
   (today's behaviour, correct) and never touches a ledger; conversely an attempt row
   is never created for it. A retry that opens a fresh task for the same family always
   allocates a new `attempt_no` instead of inheriting `context.iteration`.
3. **No shared key.** `context.iteration` stops being read for decisions; a reviewer
   task spawned on a CI-fix task does not inherit the CI count.
4. **One 1-based view.** `attemptView(delivery, family) → {n, m}` is the only
   source for "attempt N of M" in the activity comment, task titles, Home chips and
   `explain`. One row's N is `attemptOrdinal`: its place among the family's
   dispatched (not `skipped`) rows. `attempt_no` is the row's identity and a skipped
   row also takes one, so it is never shown as N; it would read "4 of 3" past a
   budget of three (295486ba). Today the comment shows the raw 0-based value while the title shows value
   plus one.
5. **Manual retry.** "Fix CI", `apply-recommendation` and `retry-ci` are `trigger=human`
   attempts; they use the workspace's configured `maxCiRetries` like automatic ones
   (today the manual path ignores it), and exceeding the cap is a visible
   `BudgetExtended` transition by that human.

### 5.8 `trunk_incidents`

`id`, `workspace_id`, `repo_full_name`, `base_ref`, `signature` (normalised failing
step or test name, reusing `normalizeErrorSignature` and the CI digest from
`apps/web/src/lib/ci-failure-digest.ts`), `status` (`open`, `fixing`, `resolved`),
`opened_by_fact`, `trunk_fix_task_id`, `first_seen_at`, `resolved_at`, plus the set of
affected deliveries (a join table, or a jsonb list bounded by the circuit-breaker
cap). Unique per `(workspace_id, repo_full_name, base_ref, signature)` while not
`resolved`.

### 5.9 Composition attestation (release and integration PRs)

A PR assembled from changes that were already reviewed (a release PR, a mission
integration PR) is not reviewed again change by change, but it never borrows a verdict
either. The fact `composition_attested` (key `compose:{repo}#{pr}:{aggregate_head}`)
carries a `CompositionAttestation`: the base SHA, the aggregate head, a mechanical
`method` (`tree_equal` or `patch_set_equal`), one entry per constituent (its delivery,
the round whose verdict it cites, that round's `reviewed_head_sha`, the
`equivalent_head_shas` its delivery recorded, the `merged_head_sha` GitHub merged, the
`landed_sha` of the composed commit in the aggregate's own history, and two patch-ids)
and an explicit `novel_delta` of `none`, `present` (with paths) or `unverifiable`.

The proof is computed, not asserted. GitHub's commit→PR association only says which
reviewed change a composed commit claims to be. The collector reads the composed
commit's own diff (`landed_patch_id`) and, separately, the reviewed head's diff against
that commit's parent (`reviewed_patch_id`). A patch-id keeps every added and removed
line and drops hunk positions and context, like `git patch-id`. A file with no patch is
identified by its resulting blob. Equal ids make the commit a constituent. Different ids
(a conflict resolved while squashing into the base, a hand edit in the squash) make the
differing paths a novel delta. An unreadable diff makes the result `unverifiable`. The
live PR head is read before the compare, and a head that has moved attests nothing.

A **mission branch refresh PR** is composed too. That is the PR the refresh conflict task
opens to merge trunk into a mission's working branch (owner task context carries
`requireMergeCommit`, read by `integrationRefreshOf`; base = that mission's working branch;
an ordinary task PR into the same branch is not one). `isCompositionPr` recognises it by
`refreshTrunk`, and the collector changes in three ways:

1. Its constituents are the trunk PRs its commits landed through, matched on the PR's
   base being trunk rather than the PR's own head branch.
2. A merge commit whose second parent is on trunk is read from four whole trees (the
   merge base, the mission side, the trunk side and the merge itself, via
   `git/trees?recursive=1`, so GitHub's 300-file diff cap does not apply).
   `classifyRefreshMerge` returns every path the merge decided instead of inheriting:
   - a path both sides changed, including one where a side was taken whole;
   - a path whose result is not what the one side that changed it left there (a dropped
     change);
   - a path neither side changed but the merge did.

   Those paths are novel even when the PR diff does not list them, because taking the
   mission side whole drops a trunk change without leaving a line in the diff.
3. Paths CI regenerates and compares for equality (`isCiVerifiedGeneratedPath`: the
   specs index and the drizzle journal and snapshots under `meta/`) are left out of what
   the merge decided. Two generated kinds stay novel. The design-check baseline is only
   ratcheted by CI. A migration `.sql` can hold a hand-written step that the
   up-to-date check never sees.
4. A migration the merge only moved to a free index is left out too
   (`renumberedMigrations`). That means a mission-side `.sql` the merge dropped, paired
   one to one with a new `.sql` that holds the same blob and is on neither side. This
   is what the generated-conflict resolver's renumber produces. A moved migration whose
   content changed, or one written in the merge, stays novel. The merge-safety
   inspector reads the same shape in a refresh PR's diff as a renumber, not lineage,
   using the same pairing (`pairMovedMigrations`, db-migration-gates.md "A renumber in
   a refresh PR is not lineage").

A truncated or unreadable tree makes the result `unverifiable` (full review). With
nothing left novel, the refresh is approved on composition with no reviewer. Otherwise a
delta round reviews only the resolved paths. Release and integration PRs are unchanged.

The reducer (`CompositionAttested`, from `AWAITING_REVIEW`, head must be current) checks
each constituent against the ledger. The cited round belongs to that constituent's own
delivery, PR and repo. It is decided `approve` at exactly `reviewed_head_sha`.
`merged_head_sha` is that head or a recorded equivalent. The two patch-ids are present
and equal. With `none` the delivery becomes `APPROVED` with `approval_basis =
composition` and the head in `composition_heads`; `approved_heads` is untouched and no
round is decided at the aggregate head. With `present` a `delta` round scoped to the
novel paths is queued. An approve of that delta round (S33) keeps `approval_basis =
composition`, adds the head to `composition_heads` only, and records the delta round id
in the transition evidence. Its GitHub review and the headline ("New changes
approved") say it covers the novel paths only. The copy names no PR kind, because a
release, a mission integration PR and a mission branch refresh PR all compose this way. `unverifiable` or any failed check claims
nothing (`rejected`). Ordinary verdicts stay exact-head (§8): `headCoverage` reports
`verdict`, `human`, `composition` or `none`, and `PrMerged` records which one covered
the merged head.

---

## 6. Transitions

### 6.1 Result shape

Every command returns exactly one of:

| Result | Meaning | Caller behaviour |
|---|---|---|
| `applied` | transition committed, `version` advanced | proceed; effects are already queued |
| `duplicate` | `idempotency_key` seen | return the first result unchanged |
| `stale` | `expectedVersion` or bound head/round no longer current | carries `current {state, version, head, round}`; caller MUST NOT retry blindly (§7) |
| `rejected` | precondition or evidence missing | carries `reason` and the missing evidence; caller MUST surface it (HTTP 409 for API callers) |

### 6.2 Notation

`H` current head; `r` current round; `L` the attempt's reported local head; "live read"
means a GitHub call made by the kernel after the command arrived; "proof" is §9.

### 6.3 Transition table

Facts enter through `ingestFact` (a recorded fact plus one reducer pass). The reducer
turns a fact into the command shown; a human or agent caller issues commands directly.

| # | Command / event | Allowed from | Required evidence / preconditions | Result state | Durable effects (same statement) | Idempotency key | Stale-event behaviour |
|---|---|---|---|---|---|---|---|
| T1 | `DeliveryOpened` (claim of a PR-deliverable task) | none | task exists, output requirement needs a PR | `WORKING` | none | `open:{task}` | duplicate returns existing delivery |
| T2 | `PrBound` (create_pr, adopt, webhook `opened`) | `WORKING`, `AWAITING_PUSH`, none (adoption) | live read: PR open, same repo as workspace, `head.repo == repo` (fork guard), base ref recorded | unchanged, except adoption creates `AWAITING_REVIEW` | project PR columns; `dispatch_review` if policy requires it and `H` has no round | `bind:{repo}#{pr}` | a second bind with a different PR number for the same delivery is `rejected(pr_already_bound)`; it does NOT reset merge or lifecycle columns (fixes adopt-override finding 8). A bound PR leaves `WORKING` when the owner attempt ends (§6.5 row 1): to `AWAITING_REVIEW`, or to `APPROVED` with `approval_basis = policy` when the policy requires no review |
| T3 | `HeadObserved(H')` fact | any non-terminal | live read confirms `H'` is the PR's current head | per §6.4 | per §6.4 | `head:{repo}#{pr}:{H}->{H'}@v{version}` (the move, read at the delivery's version: a head that returns to an earlier SHA, A→B→A, is a new observation) | webhook payload head ≠ live head → apply the live head; a late event whose live head equals stored head is `duplicate` (a redelivery after the move landed answers with that move's fact, §5.3) |
| T4 | `AttemptEnded(a, outcome, L)` (worker PATCH terminal, reaper) | `WORKING`, `FIXING`, `REPAIRING` | attempt `a` is the delivery's bound attempt (else `stale`); `L`, `commitCount` recorded as fact | see §6.5 | project `tasks`/`workers` rows; `announce_fix_ended` only for outcomes below | `end:{a}` | an exit for a non-bound attempt is recorded and returns `stale` |
| T5 | `ReviewRequested(head, forced?)` (webhook `opened`, push, `request_pr_review`, re-review route, stale-approval) | `WORKING`(PR bound), `AWAITING_REVIEW`, `CHANGES_REQUESTED`, `APPROVED`, `ESCALATED`; `LANDING` for a person's `forced` round only, while the merge call has not answered (AC-31: the queued `merge_call` skips once the delivery leaves `LANDING`; after a `merged`/`indeterminate` answer, `stateReason = merge_called`, it is `rejected(merge_in_flight)`) | `head == current_head_sha` (the recorded head; explicit review requests revalidate GitHub in the dispatch effect before filing a reviewer); no round with status `queued`/`reviewing` for `(head)`; `forced` needs a `human:` actor (a signed-in person or the person's own interactive OAuth session; runner agents always act as `agent:`, never `human:`; an API key or per-task token is never a person, whatever its level — `lib/request-person.ts`) and is recorded in `bypass`; from `ESCALATED`, a non-human actor is accepted only when the reason is `review_escalated` or `review_unavailable` (every other escalation is left by a person, §4); a spent review budget (`review_exhausted`, or a repair that started from it) takes only a `forced` round, so only a person asks again (2ded4e88) | `AWAITING_REVIEW`, round `r+1` queued bound to `head` | `dispatch_review(round)`; announce `review_queued` | `round:{delivery}:{head}:{r+1}` | a request naming a head ≠ current is `rejected(round_head_not_current)`; a request for a head that already has a decided round is `rejected(head_already_reviewed)` unless `forced`; a non-human `forced` is `rejected(force_requires_human)`; a non-human request from a non-review escalation is `rejected(escalation_needs_human)`; an unforced request while the review budget is spent is `rejected(review_budget_spent)` |
| T6 | `ReviewVerdictRecorded(round, verdict, headBound)` (reviewer completes) | `AWAITING_REVIEW`; `LANDING` before the merge call answered (a round still open when a person's override landed, AC-31) | `round.status ∈ {queued,reviewing}`; `headBound == round.head_sha`; server escalation rules (file list, confidence) applied to produce `effective_verdict` | `approve`→`APPROVED` (or `ESCALATED(review_escalated)` if the rules override); `request_changes`→`CHANGES_REQUESTED`; `escalate`→`ESCALATED(review_escalated)`; if `round.head_sha != current_head_sha` the verdict is stored and the round marked `superseded` with **no state change**. A verdict for the **current** head and round that arrives while `REPAIRING` or `BLOCKED_ON_TRUNK` decides its round with **no state change**; leaving the hold (T11's resume, `RepairNotNeeded`, a no-push `AttemptEnded`, T26) re-enters that verdict at the head exactly as §6.5 row 2 does, and a head move before then supersedes it. It is never superseded at the same head, so the resume never starts a second round there (b666505e). From `LANDING` (AC-31) an approval stays `LANDING` with the head approved; any other outcome leaves it as from `AWAITING_REVIEW`, so the queued `merge_call` skips; once the merge call answered (`merge_called`) the verdict decides its round with no state change | `post_review(commit_id=round.head_sha)`; `dispatch_fix(round)` when under budget else transition T7 instead; `supersede_open_fix_on_approve`; `announce_*`; mission note | `verdict:{round}` | stale head or round: `stale` (verdict kept for audit). Replaying the PATCH is `duplicate` (closes the "no already-handled marker" gap) A completed reviewer always settles its round (7105282e): every send of one reviewer's verdict on one round carries one key (`record_review_verdict:{reviewerTask}:{round}`), a send the control plane did not apply is sent once more and an unanswered one is parked for the floor (`command-outbox.ts`); a verdict T6 answers `rejected` or `stale` while its round stays open (a head the round was not for, an evidence mismatch while held) is followed at once by T27 (`verdict_not_applied`), and a round still waiting on a reviewer task that ended with nothing recorded is failed by the floor (T27 `reviewer_ended`) |
| T7 | `ReviewBudgetExhausted` (inside T6/T11) | `CHANGES_REQUESTED`, `FIXING` | counted rounds (`current_round` less re-checks after an approval, §8.2) `>= max_rounds`, and the current round is not a re-check (a re-check's request for changes is owed one repair cycle, c1d66a6a) | `ESCALATED(review_exhausted)` | `escalate_exhaustion` (mission note + notify) | `exhaust:{delivery}:{head}@v{version}` (the version read: a person who resolves back to the same head and sees it exhaust again gets a second escalation and a second notice, 10658a4c) | final for the delivery until a person acts (2ded4e88): a new head is recorded only (T3), and a CI or conflict repair out of the escalation carries the hold in `resume_state = ESCALATED` through `REPAIRING`, `BLOCKED_ON_TRUNK`, `AWAITING_PUSH`, `CLOSED_UNMERGED` (T18/T19) and an escalation on top of it (`push_undeliverable`, a spent CI or conflict budget), so its end returns to `ESCALATED(review_exhausted)` with no round; a person's forced T5, a T23 resolve or an approval lifts it; a replay is answered by the state, which has left `CHANGES_REQUESTED`/`FIXING` (`stale(state_moved)`) |
| T8 | `FixDispatched` (effect completion) | `CHANGES_REQUESTED` | **revalidation (§10.5) passed**: live read shows PR still open, head still the round's head, no newer approve; ledger row `review_fix` allocated (`attempt_no` = previous + 1, `≤ max_attempts`); fix task row created for `(round)`; unique per round | unchanged; past `max_attempts` (failed fixes spend the ledger faster than rounds, so T6 can owe a fix the budget cannot pay) → `ESCALATED(review_exhausted)` with `escalate_exhaustion`, key `fixbudget:{delivery}:{round}`, never a silent refusal (AC-14) | link `tasks.delivery_id`, role `fix` | `fix:{delivery}:{round}` | a fix for a round that is no longer current is cancelled (`newer_verdict_supersedes_fix`) |
| T9 | `FixClaimed(a)` (claim route) | `CHANGES_REQUESTED` | `a` is the fix task of the current round; **claim-time revalidation** (§10.5): live read still shows the round's head current, PR open and not approved | `FIXING` bound to `(H, r, a)` | announce `fix_started` | `claim:{a}` | a claim for a fix of a superseded round, or one whose target was resolved meanwhile (merged, approved, head moved), is `rejected(fix_superseded)` / `rejected(fix_not_needed)`; the claim route cancels the task as `skipped` (not failed) and the ledger row becomes `skipped` |
| T10 | `CiFailedObserved(H', signature)` fact | `AWAITING_REVIEW`, `APPROVED`, `LANDING`, `CHANGES_REQUESTED`; `ESCALATED` with a review or policy reason (`review_*`, `policy_human`: a person can't merge a red head, so the CI fix runs first; a spent budget there is `rejected(budget_exhausted)` and keeps the escalation's reason) | `H' == current_head_sha`; live check-suite read; no open trunk incident matches `signature` (else T25); no `ci` attempt already `queued`/`running` for `H'` (a deferral is recorded with its reason, §12.1 `ci_failed`) | `REPAIRING(ci)` (from `CHANGES_REQUESTED` stays, ci attribute only) | `dispatch_ci_fix(head)` allocating a `ci` ledger row (§5.7) under budget, else `ESCALATED(ci_exhausted)`; always `render_activity` with the failure reason, whether or not a retry was dispatched | `ci:{delivery}:{H'}:{n}` (§13.1 deviation 17) | `H' != current` → recorded fact only; CI not red on `H'` in the live read → `rejected(ci_not_red)`; this is what stops an old-SHA failure overwriting a newer head |
| T11 | `RepairDelivered` = T3 from `REPAIRING` | `REPAIRING`, `AWAITING_PUSH` | §9 proof | `AWAITING_REVIEW` (new round) or `APPROVED` if §8.3 carry-forward holds: the host reads the evidence at the attempt's end as it does for T3 (`AttemptEnded.carryForward`), so a repair whose end arrives before its push webhook still carries, and an empty bounded delta from the approval carries too (92a439a6) | as T5 / T13 | via T3 key | as T3 |
| T12 | `ConflictObserved(H')` fact | as T10; from `ESCALATED(review_*/policy_human/landing_needs_human)` only for a conflict or a migration collision, never a behind-only refresh | `H' == current`; `mergeable=dirty` or behind-base from a live read taken **now**, not a stored snapshot | `REPAIRING(conflict)` or `REPAIRING(behind)` with `repair_mode` per §6.7 | mechanical attempt first (`refresh_branch`, or `renumber_migration` for a collision); only on a mechanical refusal an `agent` ledger row and `dispatch_conflict_fix` | `conflict:{delivery}:{H'}` | as T10; behind with the live base delta (S15 disjoint-delta rule, §13.7 item 10) on an `APPROVED` covered head that the rule tolerates → `rejected(behind_tolerated)`: no refresh, no escalation, a door lands it through T15; a spent treadmill the rule does not tolerate escalates with `evidence.cause` `refresh_unsafe` (shared files or risky paths, named in `evidence.files`, told apart by `evidence.deltaBasis` `overlap` / `risky_path`; a base manifest whose gap diff only changes its `"version"` field, a release bump, is not risky; a migration or `schema.ts` on either side is risky only when the other side also has a migration or schema change (base side 92a439a6, PR side #5522: the PR's own migration was applied over every base migration in the tree its merge-ref CI tested, and the T15 stale-parent inspector re-checks the chain), while lockfiles, dependency manifests, CI workflows and repo-wide invariant tests stay risky on either side) or `refresh_exhausted` (gap too big, unlistable, or the base requires up-to-date branches) |
| T13 | `CarryForwardEvaluated(H')` (inside T3 from `APPROVED`/`LANDING`) | `APPROVED`, `LANDING` | the previous head is covered by the delivery's own approval (`headCoverage`: `approved_heads` or `composition_heads`, any basis) **and** the PR diff is unchanged from it to `H'`; recorded as `own_refresh` when the previous head is the one a `refresh_branch` effect of this delivery was pinned to (payload `headSha`), else `content_equivalent`. From `REPAIRING`, a head attributed to the queued behind refresh carries as `own_refresh` without the caller's evidence **unless** the fact layer's compare read the PR diff as changed (`diffChanged`): attribution credits any descending push to a queued refresh, so it never proves the diff (edc02148). Never decided from a reviewer task row | `APPROVED`, `approved_heads += H'` (`composition_heads += H'` for a composition basis) | `equivalentHeadShas` projected onto the approving round's reviewer after the transition commits | `carry:{delivery}:{H'}` | not equivalent → T5 (round `r+1`, a delta round only under §8.3a, else full) from `APPROVED` |
| T14 | `HumanApproved(H')` (GitHub human review or dashboard approve on current head) | `ESCALATED`, `CHANGES_REQUESTED`, `AWAITING_REVIEW` | review `commit_id == current_head_sha`; actor holds merge permission | `APPROVED` with `approver=human` | notify; never enables unattended merge (§17.2) | `approve:{repo}#{pr}:{review}` | review on an older commit: recorded, `stale` |
| T14b | `PolicyMergeApproved(H', reason)` (the escalation gate's `policy_merge` rule, lib/merge-policy-rule-executor.ts) | `ESCALATED` with `review_*` or `policy_human` | actor `rule:<name>` (never a model, never a person); `H' == current_head_sha`; no destructive `policy_evidence`; the caller already checked the workspace merge policy lets the platform land | `APPROVED` with `approval_basis = policy_rule` and `H'` in `approved_heads` (exact head: a later push is not covered) | none (the landing doors land it, every rail evaluated again); recorded as a bypass | `policymerge:{repo}#{pr}:{H'}` | another state: `stale`; a hand-off or spent-budget reason, a destructive migration, a non-rule actor: `rejected` |
| T15 | `LandingRequested(door)` (the five merge doors, sweep) | `APPROVED`; `AWAITING_REVIEW`/`CHANGES_REQUESTED`/`ESCALATED` only for a person's verdict override, and `ESCALATED(landing_needs_human)` for a person's freshness / size override or an agent run's under a person's task grant (§13.7 deviation 3) | live read: open, head == `current_head_sha`; `landPr` rails pass (CI, deny paths, size, migration inspector, freshness, surface order, review gate, mission-PR gate; on a kernel-owned PR the door's review gate is the delivery itself, never the legacy reviewer row, and the landing sweep picks kernel candidates from deliveries in `APPROVED`); override recorded in `bypass` and never covers red CI or deny paths | `LANDING` | `merge_call(head)` | `merge:{repo}#{pr}:{head}:v{version}` (§13.7 deviation 1) | head moved → `stale` and T3 path; a second door while `LANDING` at the head → `duplicate(landing_in_flight)`; a draft PR (live `draft`, or `mergeable_state: draft`) → `rejected(pr_is_draft)` from every door, the override included: no merge call, the delivery stays where it was; a door landing a head behind its base carries the base delta read at merge time and T15 lands only if the S15 disjoint-delta rule still holds (`evidence.freshness {optimistic, behindBy, baseFiles, rule}`), else `rejected(behind_not_tolerated)` and the door refreshes; a freshness override skips the rule |
| T16 | `MergeCallResult` | `LANDING` | GitHub response | merged → T17 (not asserted here: the merged fact comes from a live read); `indeterminate` → stay with `stateReason = merge_called` (nothing interrupts the landing after this, AC-31), `verify_merge` effect; `not_merged` (the verify read shows the PR open and unmerged, a rate limit, or a draft made between the read and the call) → `APPROVED`, with `retryAt` when GitHub said when to come back; a 5xx → `indeterminate`; behind/out-of-date → `REPAIRING(behind)`; conflict → `REPAIRING(conflict)`; policy/other refusal → `ESCALATED(landing_needs_human)` | `refresh_branch` or alert | `mergeresult:{repo}#{pr}:{head}:{landing_version}:{outcome}` | result for a head that is no longer current: ignored (`stale`) |
| T17 | `PrMerged` fact | **any** non-terminal | live read `merged=true`; records GitHub `merged_at` and `merge_commit_sha` | `MERGED` | stamp `workers.mergedAt`/`prLifecycleStatus` on **all** rows of the PR; cancel open review/fix attempts and their unstarted tasks, named as in T18 (reason `merged`, b6cfdbb9); `task.pr_merged` emit; dependents, mission wake, release attribution, mission-branch deletion (`finalizeMissionPrMerge`); classify merged-over-verdict | `merged:{repo}#{pr}` | replay is `duplicate`; "merged" is never overwritten by a later fact |
| T18 | `PrClosedUnmerged` fact | any non-terminal | live read `state=closed`, `merged=false` | `CLOSED_UNMERGED(close_cause)`; a spent review budget (T7's hold) keeps `resume_state = ESCALATED` through the close, every other `resume_state` is cleared (79649a80) | cancel open attempts, and their tasks: `cancel_open_attempts` (reason `closed`) names every open repair's task and every open round's reviewer, and the kernel cancels each one nobody started (a repair not yet linked to its task: that role's unstarted tasks, while the PR is still closed) (b6cfdbb9); `scan_supersession`; mission note; stamp all rows `closed` | `closed:{repo}#{pr}:{updated_at}` | a closed fact older than a later `PrReopened` loses to the live read |
| T19 | `PrReopened` | `CLOSED_UNMERGED` | live read `state=open` | `AWAITING_REVIEW` at the live head; closed with a spent review budget: `ESCALATED(review_exhausted)` at the live head, no round (a close and a reopen is not a person lifting the budget, 79649a80) | `dispatch_review`; when the budget is spent, no `dispatch_review` and instead `escalate_exhaustion` (`{ family: review_fix, rounds, reopened: true }`, key `exhaust:{delivery}:{head}@v{version}`), so the person is told the PR is back with them once per reopen | `reopen:{repo}#{pr}:{updated_at}` | a reopen arrives only as a GitHub fact (webhook or live read), so it carries no person: every reopen of a held delivery goes back to the person |
| T20 | `SupersessionRecorded(target)` | `CLOSED_UNMERGED` **only** | live read: target PR exists, `merged=true`, is a different PR; caller authorised (§17.1) | `SUPERSEDED` | project `workers.supersededBy*`; carry the open findings to the replacement delivery, ids kept (`carry_findings`); mission wake | `supersede:{repo}#{pr}` | not closed → `rejected(not_closed_unmerged)`; fixes today's ability to mark an open PR superseded and to overwrite an edge |
| T21 | `Abandon(reason)` | `CLOSED_UNMERGED` | human actor; reason non-empty | `ABANDONED` | project `workers.abandoned*` | `abandon:{repo}#{pr}` | not closed → `rejected` |
| T22 | `PushRecoveryExhausted` | `AWAITING_PUSH` | `push_recovery` effect hit its attempt cap | `ESCALATED(push_undeliverable)` | notify with branch and reported `L` | `pushdead:{delivery}:{L}` on the first visit to `AWAITING_PUSH`, `pushdead:{delivery}:{L}@v{N}` on a later one (`N` the version it entered at, §9) | a head observed meanwhile wins (T3): before the escalation applies, the cap is `stale`; after it, a head with §9 proof against `L` still returns the delivery to `AWAITING_REVIEW` (§6.4), so a person who pushes the branch need not also dismiss the escalation |
| T22b | `EffectDead(effect)` (the drain, §10.3) | the state that owed the effect: `LANDING` (`merge_call`, `verify_merge`), `AWAITING_PUSH` (`push_recovery`), `CHANGES_REQUESTED` (`dispatch_fix`), `AWAITING_REVIEW` (`dispatch_review`), `REPAIRING` (`refresh_branch`, `renumber_migration`: only the bound ledger row's effect, key `<kind>:<delivery>:<head>:mechanical:<n>` at the current head; a trunk-recovery refresh or an older head's is `stale`), any non-terminal (`post_review`) | the effect is `critical` and went `dead` | `ESCALATED(landing_needs_human)` for landing and for a dead behind refresh (a person may land past freshness, T15), the bound mechanical row ended `failed`, `ESCALATED(push_undeliverable)` for `push_recovery`, `ESCALATED(review_unavailable)` for `dispatch_review` (the round is not being served, T27's outcome, so T5 lets anyone ask again; its open round is closed `failed` as T27 closes one), else `ESCALATED(effect_dead)` | notify a person | `effectdead:{effect}` | the delivery left that state → `stale(state_moved)`; already `ESCALATED` → `duplicate`; a non-critical kind → `rejected(not_critical)` |
| T23 | `Escalate(reason)` / `HumanResolve(choice)` | `ESCALATED` | human actor; choice ∈ approve (T14's evidence: the approved commit is the live `current_head_sha` and the actor holds merge permission, else `stale(review_on_older_commit)` / `rejected(no_merge_permission)`), request changes (→ `CHANGES_REQUESTED`), apply recommendation (→ `FIXING` path, new attempt), dismiss with reason (→ `AWAITING_REVIEW` forced round) | per choice | per choice | `resolve:{delivery}:{version}` | resolves only the escalation at the version the human saw (§7); apply/request changes need a review round at the current head (`no_review_at_head`) and dispatch a `trigger=human` T8 carrying the person's instructions |
| T24 | `DeliveryFailed(reason)` (owner task terminal, no PR) | `WORKING`, `AWAITING_PUSH` | task `failed`/`cancelled`, retry budget spent, no PR bound | `FAILED` | none | `fail:{task}` | with a PR bound, T18/T22 apply instead. The key never repeats by design: `FAILED` is terminal, so there is no second occurrence to drop |
| T25 | `TrunkRedObserved(signature)` (circuit breaker, §6.10) | `AWAITING_REVIEW`, `APPROVED`, `LANDING`, `REPAIRING(ci)` | the same `signature` is failing on the base branch's own head, **or** was failing at the PR's branch point on its base or the trunk (rule (c), §6.10), **or** ≥ the configured count of deliveries in the workspace hit it inside the configured window; open or join the `trunk_incidents` row | `BLOCKED_ON_TRUNK` with `resume_state` = the source | one `dispatch_trunk_fix` per incident (never per PR); cancel queued per-PR `ci` attempts for affected deliveries as `skipped`; `render_activity` ("blocked on trunk") | `trunk:{incident}:{delivery}` | a fact for a head that is no longer current is recorded only |
| T26 | `TrunkRecovered(incident)` (base head green for the signature, or incident resolved by the trunk-fix PR merging) | `BLOCKED_ON_TRUNK` | live read: base branch's CI no longer fails the signature | `resume_state` re-entered at the current head; if that head predates the trunk fix, effect `refresh_branch` then re-run CI is the mechanical repair. `APPROVED` (or `AWAITING_REVIEW`) re-enters only what the head is owed: covered → `APPROVED`; a round open at the head → `AWAITING_REVIEW`; a round decided at the head (a verdict that arrived while blocked, T6) → its verdict's state; otherwise round `r+1` at the head → `AWAITING_REVIEW`. Never an `APPROVED` no verdict covers (47be5f6c) | none | `trunkok:{incident}:{delivery}` | a still-red re-read keeps the state; the budget of the `ci` family is **not** consumed while blocked |
| T27 | `ReviewRoundFailed(round, reason)` (no valid structured verdict, reviewer died, contract retry spent, a person interrupted the reviewer) | `AWAITING_REVIEW` | round exists and is `queued`/`reviewing`; `reason` ∈ `no_verdict`, `prose_verdict`, `infra`, `human_takeover`, `evidence_not_at_head`, `verdict_not_applied` (the reviewer's verdict reached T6 and was refused or kept stale while the round stayed open), `reviewer_ended` (the floor: the round's bound reviewer task is terminal, it and the round have been still for `ENDED_REVIEWER_GRACE_MS`, and no verdict or end of that reviewer is parked) | stay `AWAITING_REVIEW` while the contract/infra retry budget allows (round re-queued at the same head, **not** a new round number), then `ESCALATED(review_unavailable)`; `human_takeover` (`POST /api/workers/[id]/interrupt`) is never re-queued and escalates at once | `dispatch_review` retry; `gate_events` row | `roundfail:{round}:{reviewerTask}` (the reviewer task whose run failed; `roundfail:{round}:{n}` only for a kernel-side failure where no reviewer was ever asked) | a repeated report of one reviewer's failure (a retried PATCH, the reaper, a second floor pass over the same ended reviewer) is `duplicate`, and a reviewer task that is not the round's recorded reviewer is `stale(reviewer_not_current)`: the round's contract budget is spent once per reviewer (04a79514); a prose verdict is a failure, never an approve; the existing prose fallback can only *propose* a verdict that a person confirms, it cannot apply T6 |
| T28 | `PolicyEvidenceRecorded(evidence)` (the PR-open pre-flight finding; `workflow_deliveries.policy_evidence`) | any non-terminal | `evidence.headSha == current_head_sha`. `outcome` is `human` (destructive or uninspectable SQL, deny path, human-tier policy) or `agent_split` (a PR mixing EXPAND and CONTRACT migrations, a mechanical-split job for an agent) | from `AWAITING_REVIEW`/`APPROVED`, or `LANDING` before the merge call answered (AC-31: the queued `merge_call` skips), with no open attempt: `human` → `ESCALATED(policy_human)`, open rounds superseded; `agent_split` → `REPAIRING(migration)` with one agent `migration` ledger row (past 2 rows → `ESCALATED(policy_human)`). Every other state (a running owner, an open repair, an owed fix, a landing whose merge call already answered) **records** the finding and acts on nothing: the platform already owns the PR, so no human is notified and no second branch writer is queued. An owner hand-off (§6.5 row 1) at exactly that head applies the recorded finding instead of queuing a review round | `notify(policy_human)` (admitted only while the delivery is still `ESCALATED` at that head); `dispatch_conflict_fix(repairKind=migration_split)` | `policy:{delivery}:{head}:{outcome}@v{version}` | a finding for any other head is `stale(head_not_current)` and never re-escalates a newer head; the same finding replays as `duplicate` while the delivery holds it (`policy_evidence` equal, `evidence_recorded`), so a person's resolution at that head stands against a redelivered import. Once the delivery has dropped the finding (T29 clears it), the same finding applies again (10658a4c). It never bypasses CI or T15's rails |
| T29 | `BaseChanged(live)` (`pull_request.edited` with `changes.base`; GitHub's retarget of a PR stacked on a merged, deleted branch; or a live read at a CI, landing or floor door whose `base.ref` differs from `delivery.base_ref`) | any non-terminal | live read: PR open, `base.ref != base_ref` | `base_ref` follows the live base. Unless the PR's diff against the new base equals its diff against the old one (`diffEquivalent`: each side's `base...head` diff less the files whose head content that base's tip already holds, e.g. a squash-landed parent of a stacked PR, compared per file patch; fails closed, so an unreadable or deleted old base is not equivalent), every approval is dropped (`approved_heads`, `composition_heads`, `approval_basis`, `policy_evidence` cleared) and rounds decided at the head are `superseded`. From `APPROVED`, `LANDING`, `AWAITING_REVIEW`: round `r+1` at the head → `AWAITING_REVIEW` (a queued `merge_call` skips once the delivery left `LANDING`). From `BLOCKED_ON_TRUNK`: `resume_state = APPROVED` becomes `AWAITING_REVIEW`. Every other state keeps its owner and only records | `dispatch_review` when a round starts | `base:{repo}#{pr}:{from}->{to}@v{version}` | same base: `duplicate(base_unchanged)`. T15 refuses a landing whose live read names another base than `base_ref` (`stale(base_moved)`); the landing door records T29 first. CI classification and incident joins (§6.10) read the live base over the stored one (24e1cfad) |

**Migration stale-parent at landing.** The landing door (T15, via the `landPr` safety-check rail) runs the migration inspector; for a drizzle v1 PR whose new snapshot parent is no longer a leaf of the base it returns `kind: stale_parent` with a "needs rebase" reason. `landPr` treats that as work, not a decision: it refreshes the branch onto the base (`refresh`, the same path as behind-base), so CI runs fresh on the new base before the PR can land. It is never parked as a human `migration` decision. The kernel already carries the base state; no new table.

### 6.4 `HeadObserved(H')` by state

| State | `H'` equals `current_head_sha` | `H'` differs |
|---|---|---|
| `WORKING` | `duplicate` | record head; stay (owner pushed mid-attempt) |
| `AWAITING_PUSH` | `duplicate` | if proof (§9) holds: `AWAITING_REVIEW`, new round, effect `dispatch_review`; else record, stay, schedule next `push_recovery` |
| `AWAITING_REVIEW` | `duplicate` | round `r` → `superseded`; round `r+1` (delta from the last decided head if any) bound to `H'` |
| `CHANGES_REQUESTED` | `duplicate` | cancel the unclaimed fix task; round `r+1` as above |
| `FIXING` | `duplicate` | record head; stay `FIXING` while the attempt runs (mid-fix pushes are normal); round advances at `AttemptEnded` |
| `REPAIRING` | `duplicate` | proof (§9) → T11 |
| `APPROVED` | `duplicate` | T13 carry-forward, else round `r+1`; **this replaces today's "re-review only when a merge is attempted"** |
| `LANDING` | `duplicate` | abort landing; as `APPROVED` |
| `BLOCKED_ON_TRUNK` | `duplicate` | record head; stay blocked (T26 re-enters). With `resume_state = APPROVED`: T13 carry-forward evidence keeps the approval (the head joins `approved_heads`); without it `resume_state` becomes `AWAITING_REVIEW`, so recovery reviews the new head instead of landing it (47be5f6c) |
| `ESCALATED` | `duplicate` | `review_escalated` / `review_unavailable` at an older head: round `r+1`; `review_exhausted`: record only (a spent budget is final until a person acts, 2ded4e88); `push_undeliverable`: as `AWAITING_PUSH` — if proof (§9) holds against the escalated `L`, `AWAITING_REVIEW`, new round (the escalation's cause is gone: the work arrived), else record only (no new `push_recovery`: a person owns it now); `conflict_exhausted`: a head whose live `mergeable_state` is not `dirty` is `AWAITING_REVIEW`, new round (the spent budget only asked a person to resolve the conflict, and a repaired head answers that whoever pushed it; earlier no-progress conflict attempts never hold a repaired head back from review and landing), a `dirty` one is recorded only; other reasons: record only |
| terminal | ignored (recorded) | ignored (recorded) |

### 6.5 `AttemptEnded` by outcome

| State, outcome | Result |
|---|---|
| `WORKING`, success, PR bound and live head `H` contains `L` (or `L` is empty and the output requirement is satisfied by the PR) | `AWAITING_REVIEW`, round queued at `H` per T5 unless one is already open at `H` (§15 step 2). The owner attempt has ended, so `WORKING` (worker owns the next move, §4) would leave the delivery with no owner |
| as above, round already **decided** at `H` | the state that round's verdict maps to, exactly as T6: approve → `APPROVED`; request changes → `CHANGES_REQUESTED` with `dispatch_fix` unless a fix for that round is open (`ESCALATED(review_exhausted)` at the round budget, counted as in T7; also under a held budget (2ded4e88), and for a re-check whose one repair cycle is used: a fix was dispatched for it or a later counted round was decided); escalate → `ESCALATED(review_escalated)` |
| as above, the workspace policy requires no review (auto-threshold) | `APPROVED` with `approval_basis = policy`, `state_reason = policy_no_review`: no round, no verdict, `approved_heads` untouched, so it never reads as a reviewer verdict (§8). Policy covers only the current head; a later push stays `APPROVED` by policy. Landing is still gated by T15's rails |
| as row 1, the live read of the head's check runs shows a failing check | T10's outcome, under T4's key: `REPAIRING(ci)` with one `ci` ledger row and `dispatch_ci_fix(H)`, or `ESCALATED(ci_exhausted)` at the cap; no round is queued (the repair's resume starts one, so a reviewer is never spent on a red head). A trunk-explained failure (§6.10) hands on as row 1 and then takes T25. A policy finding (T28) or a verdict already decided at `H` is applied first; an unreadable check read hands on as row 1. Why: a `CiFailedObserved` hint that arrived while `WORKING` was `stale(state_not_allowed)` (the owner owned the move, and is never interrupted), so the hand-off is the first point the platform can act on it (§13.1 deviation 18) |
| `WORKING`, success, PR required and `commitCount>0` but live head does not contain `L`, or no PR | `AWAITING_PUSH` with effect `push_recovery` |
| `WORKING`, `failed`/`lost`, retry budget left | stay `WORKING` (task retried, attempt count +1) |
| `WORKING`, `failed`/`lost`, budget spent, PR bound | `ESCALATED(push_undeliverable)` if `L` unproven; else, with the PR open, hand on exactly as row 1 (review round, decided verdict, or policy approval) |
| `WORKING`, `failed`/`lost`, budget spent, PR bound, no open PR head (closed, merged or unreadable) | `ESCALATED(push_undeliverable)`; a later `PrMerged`/`PrClosedUnmerged` still applies from `ESCALATED`. An ended owner attempt with no retry queued never leaves the delivery in `WORKING` |
| `WORKING`, `failed`/`lost`, budget spent, no PR | `FAILED` |
| `FIXING`/`REPAIRING`, success, proof holds | T3 path to `AWAITING_REVIEW` (new round) |
| `FIXING`/`REPAIRING`, success, no proof | `AWAITING_PUSH`; the attempt row stays `completed` as an execution fact; effect `push_recovery` |
| `FIXING`/`REPAIRING`, `failed`/`lost` | back to `CHANGES_REQUESTED`/`REPAIRING` with `fix_attempts+1`; re-dispatch, or T7/`ESCALATED` when the budget is spent |
| `FIXING`, `failed`/`lost`, the head moved during the fix (a mid-fix push recorded in `FIXING`, §6.4) | the round advances as §6.4 says: round `r+1` at the current head (delta from the last decided head), `AWAITING_REVIEW`, ledger row `failed`; or the verdict a decided round at that head maps to. The stale round's fix is not re-dispatched (T8 would refuse it, `newer_verdict_supersedes_fix`), whatever the fix budget |

### 6.6 Completion is a fact, not a transition

A worker that "completed" has produced one raw fact. It becomes a lifecycle step only
when a transition's evidence is also present. The recurring non-transitions:

| What the worker or reviewer reported | Why it is not the step it names | Result |
|---|---|---|
| Fix/CI/conflict attempt `completed`, GitHub head unchanged | no §9 proof | `AWAITING_PUSH` (T4) |
| Reviewer finished with prose and no structured verdict, or a malformed one | no verdict exists for the round | T27; never inferred as approve or as request-changes |
| Runner/hand-off failure after work ("no confirmed outcome", "commits but no PR", "uncommitted changes", output requirement unmet) | the work is not on GitHub | `AttemptEnded(outcome=unproven)`: `AWAITING_PUSH` when commits exist, `WORKING` requeue (execution fact, bounded by the task's own retry count, not a ledger) when nothing exists |
| Reviewer verdict for a superseded head | wrong head or round | stored on its round; state unchanged (T6) |
| Agent "SUCCESS" outcome text claims a PR was updated | text is not evidence | ignored; only a head observation counts (§9) |
| PR merged by a person with no verdict covering the merged commit | policy-relevant fact | T17 applies and records `merged_unreviewed` / `merged_over_verdict` so the audit can see it; it is never undone |

### 6.7 Mechanical operations versus agent-required repair

The model distinguishes **who can do the repair** by recording `repair_mode`:

| Operation | Mode | Executor | Preconditions | Falls back to agent when |
|---|---|---|---|---|
| Bring the base branch into the PR branch (update-branch / merge of the base) | `mechanical` | effect `refresh_branch` (GitHub update-branch; `pr-branch-update.ts`, `base-refresh.ts`) | live `mergeable_state` says behind or dirty **now**; PR is not a dependency-bot PR (`isDependencyBotPrContext`) | GitHub refuses with a textual conflict |
| Migration index collision with a byte-identical renumber | `mechanical` | effect `renumber_migration`: rename the file and journal entry to the next free index computed against the PR's real base **and** the current trunk (a mission branch that lags trunk MUST NOT be read as a collision on its own) | collision verified against live trees; renumbered content hashes identical except for the index | content differs, or the regenerate check cannot be done server-side |
| CI failure whose cause is a trunk signature | none (blocked) | T25 | §6.10 | — |
| CI failure with a product cause (tests, types, build) | `agent` | `dispatch_ci_fix` | ledger budget | — |
| Policy/ratchet failure (e.g. production-data scan) | `agent`, but see §6.10 for moving it before push | `dispatch_ci_fix` | ledger budget | — |
| Real semantic conflict | `agent` | `dispatch_conflict_fix` | mechanical attempt refused | — |
| Reviewer request-changes | `agent` | `dispatch_fix` | round budget | — |

A mechanical attempt is a ledger row with `mode=mechanical`, its own small bound per
head (default 2, a policy value), no task, and the same `HeadObserved` proof (§9). It
never consumes the agent budget of its family, because a platform operation is not a
failed agent attempt; its failure is what *creates* an agent attempt. Cascades are
visible instead of silent: a renumber followed by a trunk move that conflicts again is
two ledger rows with their triggering facts, not one opaque loop.

### 6.8 Dispatch is idempotent and self-cancelling

Every `dispatch_*` effect, and every `Claimed` command, begins with a live read and
ends in exactly one of `dispatched`, `skipped(reason)` or `rejected`. A dispatch whose
target no longer needs work (merged, closed, approved at the current head, conflict
already resolved, CI green on the current head, head moved) writes the ledger row as
`skipped`, creates no task, and records the reason in `workflow_transitions.evidence`
(§10.5). Replaying the effect is a no-op.

### 6.9 Provenance: whose push was it

A delivery attributes a head change to an attempt by **SHA sets and timing, never by
author string**:

1. An attempt's `reported_shas` come from the worker's metric sync and final PATCH
   (`lastCommitSha` history), and from the platform's own mechanical effects (their
   `expected_head`).
2. A `HeadObserved(H')` that arrives while an attempt of the delivery is `running` or
   within the grace window after it ended, and where `H'` is in that attempt's
   `reported_shas` or descends from its bound head per the compare API, is attributed
   to that attempt (`pushed_head_sha = H'`, outcome `delivered`).
3. A head change that no attempt can claim is a `foreign_push` fact (a person, a
   dependency bot, another session). It records the new head and starts the normal head
   rules (§6.4) but consumes no ledger row.
4. Git author and committer identity MAY be shown as a diagnostic and MUST NOT decide
   attribution or budget. The current rule (`isBuilddWorkerCommit`) is what lets
   owner-identity worker commits count as foreign and leaves the cap unadvanced; the
   kernel replaces it, and because allocation is consumption (§5.7 rule 1) the cap
   holds even when attribution is wrong.

### 6.10 Trunk health and where policy checks run

**Circuit breaker.** CI failures are classified by `signature` at ingestion. A
signature is taken at test level where it can be: a failing Actions job's tests come
from its log (`apps/web/src/lib/workflow/failing-tests.ts`), because a sharded job's
normalised name is shared by unrelated failures. Two failures of one job match only
on the same test, and a job whose tests could not be read never matches. The base
explains a PR only when every failing entry of the PR also fails on the base. The
recovery sweep reads the least recently rechecked incidents first, sends every one it
leaves unresolved to the back, and pages past incidents it cannot read. That sweep is
the hourly backstop: an incident is also rechecked on its own within minutes of its
base's check suite completing, or at a short fallback, by the control plane's
per-minute tick (`workflow-kernel-library.md` §3, trunk recovery). The kernel
opens a trunk incident (T25) when the same signature (a) is failing on the base
branch's own head, (b) is failing on at least a configured number of distinct
deliveries inside a configured window, or (c) was already failing at the PR's
branch point: the commit where the head branched from (or last took in) its base,
and for a base other than the trunk also its branch point on the trunk, since a
mission branch runs no CI of its own and a mission refresh is how a trunk defect
reaches it. Rule (c) catches a failure the base has fixed since the PR was cut: the
base reads green, so no trunk fix is dispatched (`dispatch_trunk_fix` skips a base
that passes the incident's checks, including one still running only other checks),
the recheck resolves the incident, and T26 refreshes the head. The remedy is a
refresh, never a builder re-diagnosing the trunk's defect. While an incident is open: no per-PR `ci`
attempt is dispatched for that signature; queued ones are cancelled as `skipped`; one
`trunk` family attempt (`dispatch_trunk_fix`) exists per incident, and one trunk-fix
task runs per red base however many incidents it holds; affected deliveries
are `BLOCKED_ON_TRUNK`, visible on the comment and on Home as "blocked on trunk"
rather than "CI failing"; and the `ci` budget is not consumed. Time-dependent
("time-bomb") failures are the same case seen first on trunk. The base-red rule (a)
is ON by default with the kernel (owner decision: the kernel ships live; open
question 7's lean that base-red alone opens the incident); the multi-delivery rule
(b) is opt-in through `gitConfig.trunkBreaker = { minDeliveries, windowMinutes }`,
and `trunkBreaker: false` turns the breaker off (§13.5). The safety bound is one
open trunk-fix task per base branch (an incident opened while another unresolved
incident on that base has an unfinished fix joins that fix), and a PR is blocked
only while its every failing check also fails on the base.

**Policy checks before PR creation and push.** Failures of rules that are known before
CI runs (production-data scan of PR body and commits, ratchet and drift tests, lint
ratchets) are the largest avoidable class in the audit. The contract places them in
three tiers, each recorded on the delivery as `preflight` evidence:

1. `create_pr` validates the body and title server-side with the same rule CI runs and
   refuses with the reason (it already refuses on missing `lede`); the body check is a
   function shared with the CI script, not a copy.
2. The runner runs the configured preflight commands (`gitConfig.preflight`, default
   empty, e.g. `bun run no-prod-data:check`) before the final push in the completion
   sequence; a failure keeps the attempt in `WORKING`/`FIXING` with the output as its
   next instruction.
3. CI remains the backstop; a CI failure whose signature belongs to a preflight class
   is tagged `preflight_miss` on the fact so the miss rate is measurable.

Preflight is advisory for the state machine (never a transition precondition) so a
runner without it is no less safe, only noisier.

---

## 7. Version and compare-and-set semantics

1. **Every state-changing statement is one conditional write:**
   `UPDATE workflow_deliveries SET state=…, version=version+1, … WHERE id=$1 AND version=$2 AND state = ANY($allowed) RETURNING …`.
   Zero rows returned means the transition did not happen; the caller then re-reads and
   returns `stale` (version moved) or `rejected` (state not allowed). This is the
   existing atomic `UPDATE … WHERE … RETURNING` rule from `CLAUDE.md`; there is no
   `db.transaction()` (neon-http), so the transition row, fact link and effect rows are
   written by the **same single statement** using data-modifying CTEs, the pattern
   `enqueueDispatchSql` in `packages/core/dispatch-outbox.ts` uses and the trigger in
   migration 0231 (now in `packages/core/drizzle/20261006230118_baseline/migration.sql`) backs up.
2. **Who supplies `expectedVersion`.**
   - Human and agent callers (dashboard, MCP, task token) receive `version` with every
     read of a delivery and send it back; a stale one gets `stale` plus the current
     view, so a human who clicked "merge" on a screen that is one transition behind is
     told, not obeyed (HTTP 409 with `current`).
   - Reducer-driven transitions (webhooks, sweeps, reviewer completion, runner PATCH)
     do not hold a version; they read the row, evaluate the table, and write with the
     version they read. On CAS failure they re-read and re-evaluate **once**, then
     return `stale` — the interleaving writer already moved the state, and re-deciding
     against the new state is the whole point.
3. **Bound objects are checked in addition to the version.** A command that names a
   head, round or attempt (T5, T6, T9, T10, T15, T16) carries it; the `WHERE` clause
   includes `current_head_sha = $head` or `current_round = $r` so a verdict, a CI
   result or a merge outcome for a superseded object cannot apply even when the
   version happens to match (the version advances on any transition; the bound check
   is what ties a result to the exact object it describes).
4. **Idempotency is separate from CAS.** `idempotency_key` is unique per delivery in
   `workflow_transitions`. A replay returns the original `applied` result even though
   `version` has since moved.
5. **Read-your-write for effects.** A handler that runs an effect re-reads the
   delivery and acts only if the effect's `transition_id` still describes the current
   state (§10.4).
6. **No writer bypass.** Code outside `apps/web/src/lib/workflow/` MUST NOT update
   `workflow_*` tables or call the guarded column writers of §17. Enforced by the
   write-site guard test (§16).

7. **Path claims are not a consistency mechanism.** Claims are advisory leases; enforcement is
   degraded when a task touches more paths than the lease cap (the over-cap case is
   logged and not leased), and they defer work instead of preventing it. The kernel
   therefore relies only on version CAS, head and round binding and idempotent effects
   for correctness. A path claim MAY still reduce wasted work and MUST NOT be read as
   evidence that two attempts cannot interleave. A globally serialised migration slot
   would remove the collision class at the source but is a separate primitive (§21).

---

## 8. Exact-head review binding

### 8.1 Rule

A verdict is a property of **(PR, head SHA, round)**. It is stored on
`workflow_review_rounds` with `head_sha` set at dispatch and never edited. It counts
for a decision only when `round.head_sha` equals the delivery's `current_head_sha` or
is listed in `approved_heads` for an approve.

Today the same idea is spread over `context.headSha`, `subject_head_sha`, a JSONB
`context->>'prNumber'` lookup that returns the newest reviewer task whatever its head
(`findReviewTaskForPr`), and `handleReviewerOutcomeIfNeeded` acting on the dispatch-time
head instead of the live one. Round is today "newest `createdAt`".

### 8.2 Consequences

- A request-changes verdict at `H1` blocks until a round at a **different** head
  decides. A push alone never clears it (the #2574 rule) and neither does a second
  round at the same head (#3754 step 2): T5 rejects `head_already_reviewed`.
- A late verdict for a superseded head is stored, not applied; no GitHub review is
  posted for it and no merge is started from it.
- `isApprovalSelfMergeable` gets the head check it lacks today: it reads
  `approved_heads`.
- Round numbering is explicit and monotonic; `max_rounds` counts rounds, not fix
  cycles, and replaces `iteration/maxIterations` as the budget.
- A re-check after an approval spends no budget (c1d66a6a). A round that starts
  after an approval at another head is a verification of what changed since
  (`startRound` records it as `scope.deltaApproval`). The counted rounds are
  `current_round` less those re-checks. A re-check that asks for changes gets
  one repair cycle even with the counted budget spent, past a spent fix ledger
  too, recorded as `recheckCycle`. Exactly one: a second fix for the same round
  is not free, and the review of that repair counts as usual. A delivery that was
  never approved spends exactly as before, and once the budget is spent the hold
  is final (T7, 2ded4e88). The `review_exhausted` copy names what happened:
  "Approved twice, then a later change was refused twice", not "without an
  approval" for a PR that had one.

### 8.3 Carry-forward is a transition

When the head moves under an `APPROVED` delivery, the kernel decides (T13) whether the
approval still describes what would merge. The evidence is computed by the fact funnel
(`carryForwardEvidence` in `facts.ts`) from the delivery itself, never from the newest
reviewer task row: the previous head must be one the delivery's approval covers
(`headCoverage` over `approved_heads` and `composition_heads`, so a composition
approval carries like a verdict), and the PR diff must be unchanged from it to the live
head (`isContentEquivalentHead` through the GitHub reader's `contentEquivalent`). When
the previous head is also the one this delivery's `refresh_branch` effect was pinned to
(payload `headSha`, the `expected_head_sha` it sent), the evidence is `own_refresh`;
otherwise `content_equivalent`. Either appends to `approved_heads` (or
`composition_heads`) with the evidence recorded in `workflow_transitions.evidence`; the
append is a CAS write, which removes today's possible double append. Only after that
transition commits is `context.equivalentHeadShas` projected onto the reviewer task of
the approving round, for the legacy merge gate; a refused carry writes nothing. When
neither holds, a new round starts at once, on the push, not at the next merge
attempt; §8.3a decides whether it is a delta or a full review. A `refresh_branch` that
GitHub answered on an approved head under `REPAIRING` keeps its implied `own_refresh`
(the attempt row is the evidence).

An agent repair's end carries the same way (T11, 92a439a6). A conflict repair that only
merged the base in leaves the PR's diff as it was, and its end often arrives before the push
webhook; the later `HeadObserved` is then `head_unchanged` and reads nothing. So the host
reads the evidence when the repair ends (`carryForwardReading` in `seam.attemptEnded`) and
sends it as `AttemptEnded.carryForward`; an applied carry projects `equivalentHeadShas` as
T13's does. A delta read from the approval that lists no file (§8.3a) is the same
evidence: the PR's own diff is the approved one, so it carries with no round (evidence
`emptyDelta`, `carriedFrom`).

The carry is a rule of `APPROVED`, `LANDING`, `BLOCKED_ON_TRUNK` and `REPAIRING` only. A
review fix (`FIXING`) has an open verdict, so a base merge pushed while it runs is never
carried, whatever evidence the command holds: it is a foreign push, and the fix's end queues
a `base_refresh` round (workflow-kernel-library AC-79).

### 8.3a Delta approval and round triggers (58c8961e)

An approval at `A` plus a passing delta review of `A..B` is the approval at `B`: the
delta round's own approve puts `B` in `approved_heads` (evidence `deltaApproval
{fromHeadSha, toHeadSha, roundId}`), so the merge door's question is unchanged. The
round after a reviewer's approval is a `delta` round only when
`deltaApprovalEligibility` holds for the fact layer's read of the delta (`delta` on
`HeadObserved`/`AttemptEnded`, read by `GithubFactReader.reviewedDelta`, bounded
against the base at both ends, and only when `A` is an ancestor of `B`: compare status
`ahead`): the last decided round approved, the basis is a reviewer verdict covering that
round's head, no finding is open, the read starts at the last full review's approved
head (`deltaApprovalSource`: a chain of carried deltas is measured as one delta from
it), every touched file was in the PR there or is a test (by file name, `__tests__/`, or
a top-level `tests/` root) or an exact vitest/jest/playwright config being added or
modified, and the delta is at most `DELTA_MAX_FILES` files and `DELTA_MAX_LINES` lines.
The delta reviewer diffs exactly that range (`deltaFromHeadSha` in the dispatch detail),
and any delta reviewer whose prior head is not an ancestor of the new head (diverged,
behind, unreadable) gets a full review instead.
Anything else, an unread delta included, is a `full` round, with the reason in
`scope.deltaApproval`. A read that lists no file at all is no round: it is §8.3's content
equivalence and carries (`emptyDeltaCarry`, 92a439a6), under the same conditions. A round after a request for changes stays a delta review of the
fix. The delta reviewer of an approval gets the weakened-tests checklist (deleted or
loosened assertions, added skips, a raised timeout, an expectation changed to match the
output) and runs on the standard tier.

Every round records its trigger: `first_pass`, `changes_requested_fix`, `ci_fix`,
`new_commits`, `base_refresh`, `manual_force`, `superseded_by_push` (a push while a round
was still open), and the kernel's own `verify_findings` and `composition`. A round a
push supersedes ends `superseded` with `endReason = superseded_by_push`, never with no
end. The activity comment's round rows and `explain` name the trigger, and
`get_failure_analytics` (family `gate`) reports rounds per merged PR by trigger.

### 8.4 GitHub reviews

`post_review` is an effect that sets `commit_id` to `round.head_sha` and keeps today's
dedupe on `(commit_id, state)`. An approval posts **no** review or comment: the
`Buildd / Review approval` commit status is its only GitHub surface. A request for changes
posts only the reviewer's actionable findings, with no verdict line, confidence, head, round,
scope or provenance and no note about GitHub's limits; those stay in buildd. An escalation
posts nothing to the PR (a person is told through buildd). A human GitHub approval is a fact (`HumanApproved`)
valid for its `commit_id` only. Internal approval never claims to satisfy GitHub branch
protection; `ESCALATED(policy_human)` / "Approve on GitHub" stays an explicit state.

---

## 9. Push and delivery invariant

> **A local commit is never delivery.** A delivery leaves `AWAITING_PUSH`, and a fix
> or repair attempt leaves `FIXING`/`REPAIRING`, only on an observed GitHub head that
> (a) differs from the head the round or repair was bound to, and (b) contains the
> attempt's work.

**Proof (`deliveryProof`).** Given the attempt's bound head `Hb` and reported local head
`L`, and a live read of the PR head `H'`:

1. `H' != Hb` — the remote moved.
2. `H'` contains `L`: `H' == L`, or the compare API reports `L` as an ancestor of `H'`
   (a rebase or a refresh merge by the platform keeps content-equivalence evidence
   instead: §8.3). When `L` is unknown (runner crashed before reporting) proof is (1)
   alone plus a changed content diff for the PR relative to `Hb`.
3. For a delivery with no PR yet: the branch exists on GitHub and a PR is open on it,
   verified by a live read, not by the worker's `prUrl` string.

If the proof fails the kernel does not guess: the attempt's end moves the delivery to
`AWAITING_PUSH` and enqueues `push_recovery`.

**`push_recovery` effect.** Bounded (default 3 tries, backoff 2m/10m/30m, then T22).
Each try: (1) if the runner that owned the worker is live, send an instruction through
the existing worker instruct path to push the branch and report `git rev-parse
HEAD` and `git ls-remote` output; (2) otherwise requeue a recovery attempt on the same
branch (`resumeBranch`, as retries already do); (3) re-read GitHub. A head observed at
any point ends recovery through T3.

One chain per visit to `AWAITING_PUSH`: `push_recovery:{delivery}:{L}:{n}` on the first
visit, `push_recovery:{delivery}:{L}@v{N}:{n}` on a later one, `N` the version of the
transition that entered it (the view's `pushEntries` / `pushPendingSince`). A delivery a
person took out of `ESCALATED(push_undeliverable)` whose work comes back unpushed at the
same `L` gets its own tries and its own T22, never the first visit's spent keys (10658a4c).

**Surfaces this binds:**

- **Completion gate.** For attempts with role `fix`/`ci_fix`/`conflict_fix`, a terminal
  `completed` PATCH is refused with 400 `delivery_not_advanced` when the live head
  has not advanced, telling the worker to push. This sits beside the existing
  `pr_required` gate and closes G1–G3 of §17.4, which accept a `prUrl` or an open PR on
  the branch without comparing heads. Conflict and migration repairs read one
  verdict, kernel-owned or legacy, defined in §13.11.
- **Runner.** The completion payload gains `remoteHeadSha` (from `git ls-remote`
  after the final push attempt) and `unpushedCommits` (from `rev-list origin/<branch>..HEAD`).
  Both are facts for diagnosis; the server still verifies against GitHub (R2). Today
  only the worktree-removal path in `git-operations.ts` and `doctor.ts` check pushed state.
- **Reaper and cleanup.** `resolveStaleTask` auto-complete and the
  `tasks/cleanup` assigned-task reconcile both call `checkWorkerDeliverables`, where a
  bare `commitCount>0` counts as a deliverable and `result.sha` is recorded as if it
  landed. Under the kernel they MUST end the attempt with `AttemptEnded(lost, L)` and
  let T4 decide; they MUST NOT write `tasks.status='completed'` for a task with a
  delivery.
- **Dependents.** Anything keyed on `tasks.status='completed'` as "work delivered" (the
  dependency gate, `resolveCompletedTask`) is a reader of the delivery projection, not
  of the task row (§12).
- **Author is not provenance.** Which push belongs to which attempt is decided by §6.9, not by commit author.
- **Body is not head.** `update_pr`, `create_pr` dedup-adoption and lede corrections
  edit text. They emit no fact and cannot move a delivery. This is the #3754 PR body.

---

### 9.x PR scope, owner-blocked fixes, and review findings across attempts

Four rules keep a PR from stalling silently when its work is not the task's alone.

1. **Scope guard at PR time.** When `create_pr` registers (or adopts) a head an interactive session chose itself (`interactive_head`), the commits on that head since its merge-base with the PR base are compared with the task's claim. A non-merge commit authored before the task's worker was claimed is foreign; the call is refused (`scope_foreign_commits`, 400) naming the commits and the two fixes (a fresh branch from the base, or move those commits off the head). A session may pass `scopeOverride` with a reason; it is recorded as a `bypassed` PR-ownership gate event and an `allowed` capability decision (`scope_override`). The check fails open on anything it cannot read. Code: `apps/web/src/lib/pr-scope.ts`, wired in `apps/web/src/app/api/github/pr/route.ts`.
2. **Claim-time hint.** An interactive claim that reports `sessionBranch` and `sessionCommitsAhead > 0` for a branch other than the assigned one gets `branchHint` on the claimed worker, recommending the assigned branch. The session's branch is never changed. Code: `apps/web/src/lib/claim-branch-hint.ts`.
3. **Owner-blocked fixes are needs-you.** A fix attempt that ended on an open blocking question (a question, or a `post_note` question with no default) makes `deriveDeliveryView` report `owner: human`, `stage: needs_you` and the question as `detail`, in any non-terminal state, instead of `fix queued`. `landing-blocker` reads it as `human_decision`. The claim holds that attempt (`awaiting_owner_answer`) until the note is answered, so it is not requeued into the same question. Code: `apps/web/src/lib/owner-blocked-fix.ts`, `packages/workflow-kernel/src/projections.ts`.
4. **No silent cancel.** A review fix cancelled because another attempt holds the PR (`open_retry_supersedes_duplicate`) hands its description, the review findings, to the holding attempts: appended to their task once (marker `review-findings-carried:<id8>`) and queued to any live worker. Code: `carryFindings` in `apps/web/src/lib/supersession-store.ts`.

## 10. Transactional outbox and effects

### 10.1 Contract

Every consequence of a transition is a row in `workflow_effects` inserted by the
statement that applied the transition (§7.1). Nothing performs a side effect inline
while holding the decision. Today post-merge work runs in-request through `emit()`
(`core-emit.ts`), is not durable, and is healed only by sweeps; a function killed
between "merge accepted" and "`task.pr_merged` emitted" loses the effect.

### 10.2 Effect kinds and their idempotency

| Kind | Does | Idempotent because |
|---|---|---|
| `dispatch_review` | create the reviewer task for a round, announce, wake | one task per `(delivery, round)`; `createReviewerTask` dedupe by `(PR, head)` remains as backstop |
| `dispatch_fix` / `dispatch_ci_fix` / `dispatch_conflict_fix` | create the attempt task | unique `dedupe_key`; existing `*_retry_event_unique` indexes until Slice C |
| `post_review` | submit GitHub review at `commit_id` | GitHub dedupe on `(commit_id, state)`; the effect checks the posted result and fails on `posted:false` unless the dedupe reason matched (`postPrReview` never throws). GitHub refuses an approve or request-changes from the PR's own author with a 422, and buildd's App opens the PRs it reviews: `postPrReview` then posts the same findings as a `COMMENT` review at the same commit (`isOwnPrReviewRefusal`), unglossed and deduped on `(commit_id, COMMENTED, body)`, and the effect records `ok:commented_own_pr` with no mission warning. An approval's effect records `skipped:approval_is_status` and posts nothing. The verdict is the kernel's own record, never this review |
| `merge_call` | `PUT /pulls/{n}/merge` with `sha` pinned (`pr-landing-effects.ts`) | the pin makes a replay at the same head a no-op or a clean refusal; `indeterminate` triggers `verify_merge`; one per landing request (`merge_call:{delivery}:{head}:v{n}`) |
| `verify_merge` | read PR; `PrMerged` (T17) if merged, `MergeCallResult(not_merged)` if still open at the head | read-only |
| `refresh_branch` | update-branch, records `expected_head` | one in flight per head (existing 60s lease) |
| `push_recovery` | §9 | bounded tries; each try is a read-then-instruct |
| `stamp_pr_rows` | project columns on every worker row of the PR | `WHERE` guarded on `merged_at IS NULL` etc. |
| `renumber_migration` | mechanical migration index fix (§6.7) | computed from live trees; re-running on an already-renumbered head finds nothing to do |
| `dispatch_trunk_fix` | one open trunk-fix task per red base | unique per `trunk_incidents` row; the task id is the base's anchor incident (§13.5) |
| `render_activity` | regenerate the PR comment from canonical state (§12.1) | a pure function of `(delivery, transitions)`; convergent, coalesced per delivery |
| `notify` / `mission_note` / `wake_mission` / `release_attribution` / `finalize_mission_pr` | existing helpers | keyed by `(delivery, transition)`; helpers already dedupe by marker or note key |
| `scan_supersession` | existing detector | `supersessionScan` rescan gate |
| `cancel_open_attempts` | `head_moved` / `ci_green` / `closed` / `merged`: cancel the tasks the transition named (`Work.cancel`, unstarted only); `approved`: the role-wide fix cancel; `blocked_on_trunk`: the trunk handler's | a named task already started or ended is untouched; a role-wide fallback runs only while the delivery is still in the state its transition entered |

### 10.3 Delivery and leases

> Amended 2026-10-13 by the native spec "Workflow kernel" (fa62b865; repo copy `workflow-kernel-library.md`) §3: in production the drain runs only on the execution control plane, never inline in a Vercel request or from a Vercel cron.

Mirror `task_dispatch_outbox` (`packages/core/dispatch-outbox.ts`, `dispatch-authority.ts`):
claim due rows with `FOR UPDATE SKIP LOCKED` in one CTE, set `status='delivering'` and
`attempt_count+1`; a `delivering` row older than the lease (120s) is claimable again.
A batch is claimed under one lease but its handlers run one after another, so each row
is renewed for itself just before its turn (`renewEffectLeaseSql`: `WHERE id AND
status='delivering' AND attempt_count` = the claim's) and kept alive while its handler
runs; no row back means another drain re-claimed it after the batch lease ran out, and
this drain skips it (`lost`) instead of running it a second time. §10.4's current-ness
check reads the delivery as returned by that renewal, not the claim-time snapshot. Ack
and failure are fenced the same way (`WHERE id AND status='delivering' AND
attempt_count`), so a stale attempt can neither settle nor re-open the attempt that
re-claimed its row (625449c7). Failure returns the row to `pending` with
exponential backoff (15s doubling, cap 30m); at 8 attempts the row is `dead`, a
`gate_events` row is written (`workflow_effect_dead`: `stranded` for a critical
effect, `warned` otherwise; `dead-effects.ts`) and, for effects marked `critical`
(`merge_call`, `verify_merge`, `push_recovery`, `post_review`, `dispatch_fix`,
`dispatch_review`, and the mechanical repairs `refresh_branch` / `renumber_migration`
from `REPAIRING`: each the only exit of the state that owed it), the drain applies
`EffectDead` (T22b), which escalates the delivery while it is still in that state.
Every drain path runs this (`runEffects`), so no caller has to remember to. Delivery is **at least once**; handlers MUST be idempotent as in
§10.2. Drain runs from the existing `/api/cron/pr-reconcile` floor tick and from a
new due-queue-gated drain route (NOT IMPLEMENTED), plus an opportunistic drain at the end of any request
that applied a transition so that the common path does not wait for a cron.

### 10.4 Crash recovery

| Crash point | State after | Recovery |
|---|---|---|
| Before the transition statement | nothing changed | caller retries (idempotency key) |
| After the statement, before any effect | transition + effect rows exist atomically | drain picks the effect up |
| Mid-effect (e.g. after GitHub accepted the merge, before ack) | effect `delivering` | lease expires; handler re-runs; merge replay at pinned head is refused or already merged; `verify_merge` reads truth; `PrMerged` fact arrives idempotently |
| After effect success, before ack | same | idempotent re-run |
| Effect permanently failing | `dead` + gate event | `critical` → `EffectDead` → `ESCALATED` (T22b); others alert only. If that escalation itself was lost, the floor (§11) re-owes the state's exit: `AWAITING_PUSH` its last `push_recovery` try, `LANDING` a `verify_merge` |
| Effect belongs to a transition the delivery has moved past | handler re-reads; if `transition_id` no longer describes the state (version moved and state differs) the effect is marked `done` with `skipped:superseded` | e.g. a queued `dispatch_fix` for a round that a push superseded |
| Webhook lost | no fact | §11 sweep imports the fact; same reducer |

### 10.5 Revalidate before dispatch and again at claim

Today a retry is dispatched from a snapshot (a stored mergeable state, a CI webhook, a
verdict) that a later merge, approval or push can invalidate; a sampled share of
retries found their target already merged, fixed or approved. The kernel closes this at
two points:

1. **At dispatch** the handler re-reads the PR from GitHub and the delivery row. It
   proceeds only if the *trigger fact is still true for the current head*: CI still red
   for `H`, still dirty or behind, the round's head still current and unapproved,
   delivery state still the one that owes this work. Otherwise: ledger row `skipped`,
   effect `done(skipped:<reason>)`, no task.
2. **At claim** (`FixClaimed` and the CI/conflict equivalents) the same predicate runs
   again, because a task can wait in the queue for a long time. A task whose target is
   resolved is cancelled as `skipped` with the reason; this is not a worker failure and
   does not appear in failure analytics.

A skipped dispatch is idempotent: redelivery of the same fact finds the ledger row and
the transition key and does nothing. "A fix is already in flight" is likewise recorded
as a deferral with its reason (and rendered, §12.1) instead of vanishing.

---

## 11. Reconciliation

> Amended 2026-10-13 by the native spec "Workflow kernel" (fa62b865; repo copy `workflow-kernel-library.md`) §1 and §3: the floor runs on the control plane, and page renders never write.

Reconcilers exist because webhooks are lost, reordered and unretried
(`webhook/route.ts` documents that App webhooks are not redelivered; `X-GitHub-Delivery`
is logged and never stored). They are bounded by three permitted operations:

1. **Import a fact.** Read GitHub, build the fact with a `fact_key`, call `ingestFact`.
   The reducer, not the sweep, decides what it means. Source label `sweep:<name>`.
2. **Re-enqueue a missing effect.** For each state, the kernel defines the effects that
   MUST exist (e.g. `CHANGES_REQUESTED` ⇒ a `dispatch_fix` for the round; `AWAITING_REVIEW`
   ⇒ a live review attempt or queued `dispatch_review`; `APPROVED` with ci green ⇒ a
   `merge_call` or a recorded hold reason; `AWAITING_PUSH` ⇒ a `push_recovery`;
   `MERGED` ⇒ all post-merge effects done). A sweep inserts the missing row with the
   effect's own `dedupe_key`. `enqueueMissingEffects(delivery)` is a pure function of
   `(state, attributes, existing effects)` so it is unit-testable.
3. **Raise an invariant alert** (gate event / `notifyOperator`) when a delivery has
   stayed in a non-terminal state with no effect due and no owner past a stated bound.

**The kernel floor.** `reconcileKernelDeliveries` (seam.ts, on the hourly
`pr-reconcile` pass) is the floor for kernel deliveries. It reads every open
delivery with a bound PR, stalest first and capped per pass, and skips any
that moved in the last few minutes so it never races a webhook in flight. For
each one it reads the PR once and imports what GitHub says through
`ingestFact`, source `sweep:kernel-floor`:
- the head, when it differs from `current_head_sha` (T3);
- merged or closed, when the delivery has not recorded it (T17/T18);
- reopened, for a `CLOSED_UNMERGED` delivery whose PR is open again (T19).
- the owner's end, for a `WORKING` delivery whose owner task is terminal and whose
  latest owner worker ended (T4): `AttemptEnded` rebuilt from that workers row, keyed
  `end:{worker}` like the runner's, so an end the kernel already holds is a
  `duplicate`. It also stamps a missing `tasks.delivery_id`. An owner end can be lost
  three ways, and this is the one repair for all of them: a completion that races the
  PR open (each side reads the other's row before it is written), a crash between the
  open's transitions and its `tasks.delivery_id` stamp, and a command that loses the
  version check twice (`stale(cas_conflict)`). The open's own late hand-off re-reads the
  task and worker at the hand-off rather than trusting its first read (bb6a3a56).
- the end of a review round nobody settled, for an `AWAITING_REVIEW` delivery whose
  current round is `queued`/`reviewing` and bound to a reviewer task that is terminal
  (`roundWaitingOnReviewer`, `endedReviewerSql` in reconcile.ts): once the task and the
  round have both been still for `ENDED_REVIEWER_GRACE_MS` and no verdict or end of that
  reviewer is parked, `ReviewRoundFailed(reason: reviewer_ended)` (T27), keyed per
  reviewer, so a second pass is a `duplicate`. A reviewer's verdict can be lost before it
  reaches T6 (its completion follow-up never ran, a command that could not be parked);
  without this the round waits on a reviewer that will never answer, and the PR's
  required status stays pending (7105282e, #5211).

It then inserts whatever `enqueueMissingEffects` (`enqueue-missing.ts`) says the
state owes and the delivery lacks:
- `CHANGES_REQUESTED`: a `dispatch_fix` for the current round at the current head;
- `AWAITING_REVIEW`: a `dispatch_review` for the queued round at the current head; a
  queued round with no reviewer whose every `dispatch_review` key is `done` (one acked
  `skipped:*` while the delivery was briefly elsewhere, e.g. a not-needed repair that
  resumed the round) owes a fresh one per version
  (`dispatch_review:{delivery}:{round}:floor:v{version}`) (a6cbd241);
- `AWAITING_PUSH`: a `push_recovery` chain; a chain whose every try is `dead` owes its
  last try (`push_recovery:{delivery}:{L}:final`, in the current visit's chain, §9), which is T22 when the head has not moved;
- `LANDING`: with no `merge_call` or `verify_merge` still pending or delivering, one
  `verify_merge` per version (`verify_merge:{delivery}:{head}:floor:v{version}`): it
  re-reads the PR and is T17, a head fact, or `MergeCallResult(not_merged)` → `APPROVED`.

A `dead` key otherwise still counts as held. Each owed effect is keyed exactly as the reducer keys it and attached to the
delivery's latest transition, pinned to the version read. A delivery released
by the kill switch is skipped. A missed `synchronize`, including a push to a
draft PR (the webhook observes drafts too), or a missed `closed` therefore
costs at most one pass. `APPROVED` ⇒ `merge_call` stays with `sweepLandingPrs`
and `MERGED` ⇒ post-merge effects with the drain.

A reconciler MUST NOT: write `workflow_deliveries.state`, write a guarded column
directly, create a task outside an effect, or derive a state from elapsed time. Today's
violations are listed in §17.3 (`pr-state-reconcile` regressing `ci_green` to `pr_open`,
`dead-zone-sweep` writing `conflict` for red CI, `pr-state-refresh` writing during a
page render, the reaper writing `completed`).

| Existing sweep | Becomes |
|---|---|
| `reconcileStalePrWorkers` (`pr-reconcile.ts`), `sweepDeadZonePrs`, `refreshStaleWorkers` (`pr-state-refresh.ts`), `refreshWorkerMergeStateIfStale`, `backfill-merged-prs` | fact importers (`merged`, `closed`, `head`, `ci`, `mergeable`) over the one `recordPrFact` funnel |
| `pr-state-reconcile.ts` (`reconcileWorkerPrState`) | deleted; its `merged`/`closed` correction is a fact import, its `pr_open` write is the bug |
| `sweepLandingPrs` (`pr-landing-sweep*.ts`), `sweepCiRedPrs`, queue-stall | effect re-enqueuers for `APPROVED`/`REPAIRING`; landing still runs through `LandingRequested` |
| `cleanupStaleWorkers`, `tasks/cleanup`, `interactive-detach` | emit `AttemptEnded(lost)`; keep their task-row requeue logic |
| `mission-invariants` | invariant alerts reading deliveries; its `files:true` task creation moves behind effects |
| `sweepClosedUnsupersededPrs` (`pr-supersession-detect.ts`) | `scan_supersession` effect; auto-record goes through T20 (Slice D: the close owes the effect; the hourly sweep stays as the backstop and its write is T20 too, §13.8). A merge re-checks too (`rescanOnMerge`, b6cfdbb9): the closed PRs the merged one names, was suggested for, or shares a mission with are scanned again with it as a candidate, because a scan at close time cannot see a re-land opened after the close; the content check still decides |
| `completeMissionIfVerified` callers | unchanged readers (§17.3) |

Render-time reads: pages that call `refreshStaleWorkersForWorkspaces` or
`refreshWorkerMergeStateIfStale` while rendering (Home, mission and task pages) MUST
switch to "enqueue an import and render what is stored". Done in Slice B part 1: each
page runs the import in `after()`.

---

## 12. Existing fields: retained, projected, or retired

Rule: **a column is a fact cache (written only by `recordPrFact` / the runner PATCH),
or a projection (written only by `projectDelivery`), or retired. Never two.**

| Field | Today's meaning | After |
|---|---|---|
| `tasks.status` | execution state of one task **and**, for PR work, a proxy for "delivered" | **Execution fact** of an attempt (pending → assigned → completed/failed/cancelled). Retained and still written by the worker PATCH, claim, cancel. It MUST NOT be read as "work delivered" for a task with a delivery. `webhook/route.ts` flipping the owner task to `completed` on merge becomes a `stamp` effect of T17. |
| `workers.status`, `completedAt`, `waitingFor` | attempt execution | execution fact; unchanged |
| `workers.lastCommitSha`, `commitCount`, `dirtyWorktree` | runner-reported | local facts (R1); `registerLocalPr` stops writing `lastCommitSha = pr.head.sha` (a fact about GitHub stored in a field named for local state); GitHub head lives in `current_head_sha` |
| `workers.prUrl`, `prNumber`, `prBaseRef`, `prIsDraft`, `prOpenedBaseSha` | PR identity and facts | fact cache via `PrBound`; the adopt-override paths stop replacing them without a reset (T2 rejects) |
| `workers.prLifecycleStatus` | mixed: facts (`ci_*`, `conflict`, `merged`, `closed`, `unresolvable`) used as state | **fact cache** for CI/mergeable/merged/closed plus `unresolvable` (a reconcile-bookkeeping flag). No gate or UI reads it to decide workflow; they read `workflow_deliveries`. Written only through `recordPrFact` (shipped in Slice B part 1, §13.6), which enforces terminal-wins in the `WHERE`. Retire the redundant `pr_open` meaning. |
| `workers.mergedAt` | merge fact with two clocks | GitHub `merged_at` (webhook payload, live read, `stamp_pr_rows` from T17); the first instant recorded is never moved. A merge door stamps nothing for a kernel-owned PR (Slice C, §13.7); it still stamps its own instant for a legacy PR (opened before cutover or released by the kill switch) |
| `workers.conflictDetectedAt`, `prLastCheckedAt`, `prLastVerifiedAt`, `prCheckFailureCount`, `prUnresolvableReason` | reconcile bookkeeping | unchanged; owned by the importers |
| `workers.supersededBy*`, `abandoned*` | the supersession edge | **projection** of T20/T21, written by the `project_supersession` effect for a kernel-owned PR (Slice D); `prShipState` answers from the delivery when there is one and from these columns for a legacy PR |
| reviewer tasks' `result.structuredOutput`, `effectiveVerdict` | raw model output and server override | raw output stays a fact; the decision lives on `workflow_review_rounds.effective_verdict` |
| `tasks.context.iteration/maxIterations`, `reviewerRetry*`, `ciRetry*`, `conflictRetry*` | budgets and dedupe | budgets move to `fix_attempts`, `current_round`, `repair_attempts`; dedupe keys move to `workflow_effects.dedupe_key`. **Retired, drop after legacy drains** (§13.10): the legacy paths, the runner's prompt and the kill switch still read them |
| `tasks.context.landing`, `landingHandoff`, `baseRefresh` | landing and refresh bookkeeping | `landing` marker content that decides "what next" moves to delivery attributes/effects; `baseRefresh` stays as refresh-effect state |
| `mission_notes` (reviewer/escalation notes) | human-readable record | projection (written by effects from transitions) |
| PR activity comment | parallel log by ~18 writers | **render** of `workflow_transitions` (`render_activity`); `parsePrActivityState` stops being a read-modify-write source |
| `missions.status` | mission aggregate | unchanged authority; its completion gate reads deliveries |

Readers move to one accessor, `getDeliveryViewsForTasks(...)` (`lib/workflow/delivery-view.ts`, over the pure `deriveDeliveryView` in `lib/workflow/projections.ts`), extending `derivePrDisplayState`
(`lib/pr-presentation.ts`, the one existing PR accessor) the way
`deriveMissionStateView` already works for missions: sealed return type,
`stage`/`waitingOn`/`nextAction` computed once.

### 12.1 The PR activity comment is a projection, never an authority

Measured against canonical state, the comment is wrong or misleading on a large share
of PRs because it is a log *and* the store of that log: state lives inside a GitHub
comment that `appendPrActivity` updates by an unsynchronised read-modify-write
(`lib/pr-activity-comment.ts`), so concurrent writers drop each other's entries (a
`merged` row lost to a same-second `reviewing` write), entries appended after a merge
displace the headline, duplicates appear, and whole classes of transitions have no
kind at all.

Contract:

1. **No reader and no decision uses the comment.** It is output only. `parsePrActivityState`
   stops being a data source; the hidden state block is dropped in favour of a
   `render_version` marker holding the delivery `version` it was rendered from.
2. **Regenerate, never append.** `render_activity` computes the whole body from the
   delivery row and `workflow_transitions` (full history, not the last 12). The comment
   shows a bounded window for readability; the window is a display choice, not
   storage.
3. **Convergence instead of locking.** GitHub issue comments have no conditional
   update, so concurrency is handled by construction: (a) all renders for a delivery
   share one `dedupe_key` (`render:{delivery}`), so at most one is pending and one
   delivering; (b) the handler reads the delivery version `v`, writes the comment
   with marker `v`, then re-reads the version; if it advanced, it enqueues another
   render. The final committed render is always the one for the latest version, so a
   stale writer can delay the correct text but cannot leave a wrong one. A render
   whose `v` is lower than the marker already on the comment is skipped.
4. **Headline from state.** The headline is a pure function of `delivery.state`
   (precedence: `MERGED`/`SUPERSEDED`/`CLOSED_UNMERGED`/`ABANDONED`, then `ESCALATED`,
   then `BLOCKED_ON_TRUNK`/`REPAIRING`, then `APPROVED`/`LANDING`, then
   `AWAITING_REVIEW`/`CHANGES_REQUESTED`/`FIXING`/`AWAITING_PUSH`, then `WORKING`).
   Entries recorded after a terminal state appear in the history below the headline
   only. "Approved" cannot head a delivery whose current head has red CI, because that
   delivery is `REPAIRING`, not `APPROVED`. A stuck "Reviewing" is impossible once
   the round it names is decided or superseded. "Repairing" heads only an agent
   repair: `REPAIRING(behind)` (a mechanical base refresh) reads "Updating branch",
   and a plain `APPROVED` reads "Approved · awaiting merge" until the merge fact.
   The task page's track uses the same mapping (docs/specs/task-page.md, State mapping).
5. **Exactly one comment.** The effect finds comments by marker; if more than one exists
   it keeps the oldest, updates it, and minimises or deletes the rest.
6. **Always created.** `PrBound` enqueues a render regardless of who opened the PR
   (today `onlyIfPresent` leaves interactive-session PRs without any comment).
7. **One writer of "merged".** The merge routes, the webhook, sweeps and the landing
   path all reach `PrMerged` (T17); the render is the single path from that to text.
8. **Keep GitHub activity concise.** The activity comment shows current state and a
   bounded timeline with links to Buildd. It MUST NOT append review-round summaries,
   finding lists or explanations of GitHub's self-review restrictions. Actionable
   findings belong in the review submission; detailed rounds, finding dispositions
   and provenance remain available in Buildd. A required human decision may still
   show the question and necessary action. The authoritative commit status and
   merge gates are unchanged. Check:
   `bun run scripts/run-unit-tests.ts apps/web/src/lib/workflow/pr-activity-render.test.ts`.

**Canonical kinds.** The projection's vocabulary is derived from transitions and
facts, one per row of `workflow_transitions` plus attributes. It MUST cover, in
addition to today's kinds: `ci_passed`; `ci_failed` carrying `reason` (signature,
and for a no-dispatch case one of `fix_in_flight`, `already_retried_head`,
`blocked_on_trunk`, `budget_exhausted`); `conflict_detected`, `conflict_resolving`,
`conflict_resolved` (with `mode` mechanical/agent); `fix_started` and `fix_ended` for
**every** family (review, CI, conflict, migration, trunk); `merged`;
`closed_unmerged`; `blocked_on_trunk` and `trunk_recovered`; `push_pending`
(AWAITING_PUSH) and `push_undeliverable`. Every attempt line renders from
`attemptView` (§5.7): 1-based `attempt N of M`, family-labelled
("CI 1 of 3 · review 0 of 3 · conflict 1 of 3"), identical in the comment, the task
title and `explain`.

---

## 13. Narrowest realistic implementation seam

**The seam is the fix-loop hand-off**: the place a request-changes verdict becomes a fix
attempt, the fix attempt ends, and a new review is queued. It is where #3754, #3420 and
#2574 all happened, it touches every state a delivery needs (`AWAITING_REVIEW`,
`CHANGES_REQUESTED`, `FIXING`, `AWAITING_PUSH`, rounds, head binding) but no landing and
no mission completion, and it has a natural fact-cache boundary: the existing
`prLifecycleStatus` columns stay untouched as facts. The attempt ledger (§5.7) is part
of the seam for the **review and CI families**: both dispatch fix attempts into
`FIXING`/`REPAIRING`, the CI counter is the audited accounting defect, and the ledger
is also the dispatch dedupe key. Conflict, migration and trunk families join in Slice B/C.

Files that change in the seam (Slice A):

| File | Change |
|---|---|
| `packages/core/db/schema.ts` + generated migration | §5 tables; `tasks.delivery_id/delivery_role` |
| `packages/shared/src/types.ts` | `DeliveryState`, `DeliveryView`, command/result types |
| `apps/web/src/lib/workflow/` (new): `reducer.ts` (pure table of §6), `kernel.ts` (CAS statement builder), `facts.ts`/`github-facts.ts` (live reads), `effects.ts` (handlers + drain), `projections.ts`, `enqueue-missing.ts` | the kernel |
| `apps/web/src/app/api/workers/[id]/route.ts` | completion gate `delivery_not_advanced`; `handleReviewerOutcomeIfNeeded` calls T6 and stops inserting the fix task itself (T8 effect); `announceFixEnded` becomes a transition projection; `AttemptEnded` call at terminal PATCH |
| `apps/web/src/app/api/workers/claim/route.ts` | `FixClaimed` (T9) and release on `rejected(fix_superseded)` |
| `apps/web/src/lib/reviewer-subscribers.ts`, `reviewer.ts`, `stale-approval-re-review.ts`, `pr-re-review.ts`, `pr-review-request.ts` | dispatch through T5/`dispatch_review`; `findReviewTaskForPr`/`derivePrReviewStatus` read rounds |
| `apps/web/src/app/api/github/webhook/route.ts` | `synchronize` emits `HeadObserved` hint; `closed` emits `PrMerged`/`PrClosedUnmerged` hints (Slice A only for the head path) |
| `apps/web/src/lib/pr-activity-fix-claimed.ts`, `pr-activity-comment.ts`, `pr-activity-comment.STYLE.md` | renders from transitions (§12.1); new kinds |
| `apps/web/src/lib/ci-failure-retry.ts`, `ci-failure-inspect.ts` (author helpers deleted), `app/api/prs/[prNumber]/retry-ci/route.ts` | CI family on the ledger with provenance (§5.7, §6.9) |
| `apps/web/src/app/api/github/pr/review/route.ts`, `apps/web/src/app/api/prs/[prNumber]/re-review/route.ts` | callers of T5; stop using `worker.lastCommitSha` as head and hard-coded `iteration:0,maxIterations:3` |
| `apps/runner/src/workers.ts`, `apps/runner/src/git-operations.ts` | completion payload carries `remoteHeadSha`, `unpushedCommits` |
| `apps/web/src/lib/stale-workers.ts`, `apps/web/src/app/api/tasks/cleanup/route.ts`, `apps/web/src/lib/worker-deliverables.ts` | stop auto-completing on bare commit count for tasks with a delivery |

Later slices add the files named in §14.

### 13.1 to 13.10 Slice history

What each slice (A to F) shipped and its deviations now lives in the knowledge base as `knowledge-base: buildd/reports/workflow-state-kernel-history.md`; a reference to §13.1 to §13.10 in this file or in code points there.

### 13.11 PR recovery: exact-target repair, evidence-gated completion, landing truth

**The incident.** A mission integration PR conflicted with trunk. Each conflict,
CI and migration-collision attempt filed for it carried `resumeBranch` = the PR's
head, a `mission/<slug>` branch. The runner's resume probe (`fetchBranch` in
`apps/runner/src/git-operations.ts`) counts any resume branch more than 50 commits
ahead of trunk as "diverged" and falls back to trunk. A mission branch is ahead of
trunk by construction. So every attempt logged `resume_branch_fallback` ("diverged
on remote — starting fresh from dev"), changed nothing on the PR, and still
completed: no gate compared heads on a legacy (non-kernel) repair task. `explain`
then reported the PR as READY FOR REVIEW while the newest `pr_landing` row said
`mergeable_state: dirty` plus a migration collision. A sibling PR's still-open
predecessor could also hold its migration slot, and a pending retry could be
deferred behind its own lineage's PR.

**Rules.** Each is the contract; the regression it pins is named.

1. **A repair targets the exact existing remote head.** A *repair target* is a
   task context carrying `resumeBranch` together with the PR it repairs
   (`prNumber`, or `failureContext.prNumber`). Conflict, migration and CI attempts
   name the PR's actual `head.ref` as `resumeBranch`/`baseBranch` when GitHub
   reported one, and stamp `repairTarget: { prNumber, headRef, headSha, baseRef }`.
   For a repair target the runner:
   - treats `'diverged'` as expected, never a veto. The worktree is cut from
     `origin/<head>` exactly as fetched, and the agent reconciles from there by
     merging the PR's base in;
   - treats `'missing'` as a hard setup failure (`repair_target_missing`). It never
     starts fresh from trunk, because a fresh branch cannot update the PR;
   - may check the target out even when it is a mission integration branch. The
     integration-branch guard exists to stop ordinary work landing on the shared
     branch. Repairing that branch's own PR is the one job that must push there.

   Divergence still vetoes a resume branch that is not a repair target (a
   runaway prior attempt). Regression: `worktree-mission-integration-guard.test.ts`
   and `worktree-base-branch.test.ts`, "diverged mission branch repair".

2. **A conflict or migration repair completes only on evidence.** One pure
   verdict (`repairCompletionVerdict`, `apps/web/src/lib/repair-completion.ts`)
   decides, from a live GitHub read of the PR:
   - PR closed or merged, or GitHub unreadable → allowed. The unreadable case
     fails open, as the kernel gate already does.
   - `conflict` with live `mergeable_state: dirty` → refused
     `repair_still_conflicted`, whether or not the head moved.
   - `migration` with the collision still present at the live head → refused
     `repair_still_colliding`.
   - head moved off the bound head → allowed (`head_advanced`).
   - head unchanged → allowed only when the PR is verifiably fine without the
     repair (`no_repair_needed`): `conflict` with a mergeable state other than
     `dirty` or `unknown`, or `migration` with the collision gone. Anything else
     is refused `repair_not_advanced`.

   Kernel `conflict_fix` attempts read it through `fixCompletionGate`; legacy
   conflict and migration retries (`conflictRetryPrNumber`, no `deliveryId`)
   read it through `legacyRepairCompletionGate`. A refusal is a 400 on the
   completion PATCH under gate `output_requirement`. A runner session that ends
   without delivering fails the attempt, and the existing budget and escalation
   (`escalateConflictExhaustion`, kernel T22) decide the next step. No loop is
   added: every refusal consumes the same per-head budget. Regression:
   `repair-completion.test.ts`, "zero-diff false success".

3. **A PR that cannot land never reads as ready.** `deriveMissionStateView`
   takes `landingBlocked`, one entry per unmerged PR, built in `explain.ts` from
   current landing facts. Precedence: kernel delivery state (`REPAIRING`,
   `BLOCKED_ON_TRUNK`, `ESCALATED`, and any state not yet approved on its current
   head: `AWAITING_REVIEW` is `review_pending`, `CHANGES_REQUESTED` and `FIXING`
   are `fix_pending`, `AWAITING_PUSH` is `push_pending`, all platform-owned), then the newest `pr_landing` gate row, then
   `prLifecycleStatus = 'conflict'`. When every unmerged PR has a blocker, the
   verdict is `blocked` with a `landing_blocked` descriptor, not `review`. The
   descriptor carries the cause (`conflicted`, `migration_collision`,
   `repair_queued`, `repair_running`, `repair_exhausted`, `human_decision`,
   `trunk_blocked`, `ci_pending`, `review_pending`, `fix_pending`,
   `push_pending`), the owner (`platform` or `person`) and the
   next action. A person-owned blocker is `blocked` and counts as needs-you. A
   platform-owned one is `waiting`. Only refusing landing outcomes
   (`deferred`, `stranded`, `rejected`) are facts; shadow `warned` rows are not. A mixed
   set keeps the `merge` reading, as `ci_red` does. Regression:
   `mission-state-view.test.ts`, "dirty PR mislabeled ready"; the in-flight
   delivery states: `mission-state-view.landing.test.ts`, PR 5211 shape. The
   review status a caller polls (`get_pr_review`) counts the review-fix budget
   (`attempts.review_fix`), not rounds, unless changes are being requested: every
   new head opens a round, so "round 11 of 3" counted pushes. A round in flight
   carries no summary or feedback from an earlier round's reviewer task. A history
   node of a delivery with no projected PR state reads `open`, never the worker
   row's cached CI state.

4. **An attempt is never blocked by its own lineage.** For `taskClass: 'attempt'`
   the claim route's open-PR backstop exempts every PR in
   `context.lineagePrNumbers` and every PR opened by an ancestor task
   (`parentTaskId`, `context.rootTaskId`). The active-path-claim layer exempts
   claims held by those ancestors. Other tasks' PRs and claims still block.
   Regression: `claim-plan-input.test.ts` and the claim route test, "pending
   retry blocked by own lineage".

5. **A superseded predecessor holds no migration slot, and is retired only on
   verified content.**
   - `inspectPullRequestMigrations` takes `ignorePrNumbers`. The landing door and
     the conflict effects pass the PR's own lineage and recorded predecessors, so
     a successor is never told to renumber around the PR it replaces.
   - `closeAncestorRetryPrs` closes an open ancestor only when
     `verifyByContent(ancestor files, successor files)` holds, ignoring
     regenerated migration artifacts. Otherwise the ancestor stays open and is
     named on the successor.

   Regressions: `migration-inspector.test.ts` and `retry-pr-supersession.test.ts`,
   "superseded predecessor migration reservation".

**Deviations and remaining gaps.**

1. The kernel CI fix (`ciFixWork`, `ci-retry-effects.ts`) does not read the live PR, so it
   carries no `repairTarget`. It resumes the worker's branch as before. Legacy CI
   retries and every conflict and migration attempt carry the stamp.
2. A supersession stated only in prose (a PR body saying "Supersedes #N") is not
   a recorded edge, so it neither frees the predecessor's slot nor retires it.
   `record_pr_supersession` still requires a merged successor. Recording an open
   successor's claim is follow-up work.
3. Explain never calls GitHub. A legacy PR's landing row is trusted until a
   repair completes after it. Because rule 2 gates that completion on evidence,
   the row stays current until the landing door writes a newer one.

**Base churn.** Bounded landing coordination stays the kernel's landing lane
(`landing-lane.ts`) plus the per-basis conflict budget. A new conflict basis gets one
attempt, and the same basis twice escalates to a person. This change adds no freeze.
Rule 2 means a no-progress attempt can no longer read as success and reset the
cycle. Each conflict therefore spends budget until it escalates.

---

### 13.12 Review, refresh and landing while an owner keeps running (edc02148)

> Amended 2026-10-13 by the native spec "Workflow kernel" (fa62b865; repo copy `workflow-kernel-library.md`) §3: these rules run on the execution control plane, not `apps/web`.

PR #4413 sat open for half an hour with green CI and, once asked, an approval. Its owner was a
coordination task that stayed assigned after `create_pr` to watch other PRs. So the delivery
stayed `WORKING`, and no reviewer was asked until a person called `request_pr_review`. The
approval then sent it to the landing door. The door found the head far behind `dev` and queued
a mechanical `refresh_branch` (T12, `REPAIRING(behind)`). That effect's first inline try did
not finish, and nothing re-drove it. Every `merge_pr` answered "the delivery is REPAIRING"
without running it, and only the hourly floor drains the outbox. Had it gone `dead`, nothing
would have left `REPAIRING`, because `refresh_branch` was not critical. The kernel's own refresh
did land about ten minutes later and the PR merged at the refreshed head. This section states
the contract that path relies on, and what changed.

**Which record is authoritative for what.** Each question has one owner, and a reader never
answers it from another's row:

| Question | Authority | Not decided by |
|---|---|---|
| Where the delivery is (`AWAITING_REVIEW`, `APPROVED`, `REPAIRING`, `MERGED`, ...) | `workflow_deliveries.state` at its `version` (§4, §7) | a task's or worker's status, the activity comment |
| Whether a head is approved | the delivery's `approved_heads` / `composition_heads` / `approval_basis` (§8) | a reviewer task row, `get_pr_review`'s summary |
| Whether a review is running or done | `workflow_review_rounds` for `(delivery, head)` | the reviewer task's status |
| Whether a repair is owed or running | the bound `workflow_attempts` row plus its effect row | the owner task's or a repair task's status |
| Whether the PR merged | GitHub's live `merged`/`merged_at` (T17), projected to `workers.mergedAt` | any task completing |
| Whether it shipped to production | the release record (`release-flow`): a `dev` merge is not a release | the delivery's `MERGED` |

So **a reviewer task that completes means a verdict on one round's head, never "shipped".** A
completed reviewer under a still-open owner task is the normal case. The delivery says
`APPROVED`, the parent's PR is unmerged until T17, and the owner task's own status is
independent of both.

**Review dispatch does not wait on an owner that will not hand off.** The owner hand-off
(§6.5 row 1) queues the first review. A coordination owner's deliverable is action taken
elsewhere, so it stays assigned after it opens its PR, and its hand-off can be hours away.
For an owner task of kind `coordination`, `openKernelDelivery` asks for the review when the
PR opens: T5 from `WORKING` at the live head, open and not a draft
(`reviewOwedWhileOwnerRuns`). Its later `AttemptEnded` is `stale(attempt_not_bound)` and moves
nothing, so the approval stands. Other owners keep the hand-off, which carries §9's
unpushed-work check. A coordination owner gives that check up for its PR; a push it makes
later is a new head (§6.4 `AWAITING_REVIEW`: round `r+1`).

**Event identity and the current head.** Every fact is keyed by its natural key (T3:
`head:{repo}#{pr}:{H}->{H'}@v{version}`), read against the live PR, never the payload head.
A redelivered or reordered event is therefore one of three things:
- `duplicate`: the same move, or a head equal to the stored head.
- `stale`: a verdict for a superseded round, an exit of an attempt the delivery is no longer
  bound to, or a dead effect for an older head.
- terminal-ignored: any fact after `MERGED`.

`PrMerged` applies from any non-terminal state, including `REPAIRING` with a refresh queued.
That covers a person's merge, a merge through another door, or one the floor (§11) imports
after a missed webhook. Its effects cancel the open attempts and stamp every row of the PR,
so attempt counters and read models follow the kernel and are never patched by hand.

**A queued refresh and provenance.** While a mechanical refresh is queued, §6.9 credits it
with any push that descends from its pinned head. So the push may be the platform's own
update-branch, a person's, or a live owner's. Attribution therefore never proves the diff.
From `REPAIRING`, the approval carries (`own_refresh`) unless the fact layer's compare read
the PR diff as changed (`HeadObserved.diffChanged`, `carryForwardReading`). In that case the
head gets a delta round. An unread compare keeps the prior behaviour (carry), so a GitHub
outage costs nothing new.

**Refresh lease expiry and bounded recovery.** Three leases can hold a behind refresh, and
each expires on its own:
- the outbox row's lease: 120s, re-claimable after.
- `base-refresh`'s single-flight lease on the owner task: 60s, or 460s with the semantic check.
- the landing lane: 20 minutes, renewed only while its holder is in the refresh window.

A refresh that throws (`in_flight`, `deferred`, `semantic_deferred`) backs off 15s, doubling,
capped at 30 minutes, and is retried by:
1. any landing door. `landPr` on a `REPAIRING` delivery now runs that delivery's due effects
   (`drainDelivery`) and reads the state again, landing if the repair brought it back to
   `APPROVED`.
2. the hourly floor's `drainDueEffects`.

At 8 tries the row is `dead`, and `refresh_branch` / `renumber_migration` are now critical
(T22b). A dead behind refresh at the current head escalates to
`ESCALATED(landing_needs_human)`, with its ledger row ended `failed` and a person notified. A
person may land past freshness (T15's override) or retry. A dead conflict refresh or renumber
escalates to `effect_dead`. A stale marker cannot hold landing past that bound. The lane holds
only while its holder is `APPROVED`, `LANDING` or `REPAIRING(behind)`. The base-refresh lease
is keyed to one head and expires. The delivery is never left in `REPAIRING` with nobody owing
the next move.

**Unknown and blocked mergeability.** GitHub's `mergeable_state` is a fact on a head (§4 rule
2), not a state:
- `dirty`: a conflict (T12).
- `behind`: freshness (T12 / S15).
- `unknown`: GitHub is still computing. It is not a conflict. The landing rail defers to the
  merge API's own answer (T16), and a spent conflict escalation (`ESCALATED(conflict_exhausted)`,
  #4413) treats an `unknown` head as repaired and reviews it.
- `blocked`: branch protection or a required review. The landing door hands it to a person
  (`branch_protection`); it never merges around it.

None of these is an approval, and none skips T15's rails (CI on the head, deny paths, size,
migration inspector, freshness, review gate).

**What a person decided stays decided.** A forced round, a verdict override, a freshness
override or a `HumanResolve` is recorded in `bypass` at the version the person saw (§7). None
of the changes above re-escalates it or re-opens a round at that head.

**Rollout.** These rules are server-side (`apps/web`) and take effect on the production
deploy that carries them (`release-flow`), not on the `dev` merge. They need no runner
change. Verify the deploy separately from the merge.

Regressions: `reducer.test.ts` "EffectDead … a dead mechanical repair is REPAIRING's only
exit" and "review, refresh and landing while a coordination owner keeps running";
`pr-landing.test.ts` "a REPAIRING delivery: the door re-drives its due repair";
`facts.test.ts` "carryForwardReading"; `coordination-owner-review.test.ts`.

---

**An owner loop waits while the kernel owns the PR (92a439a6).** A loop task whose exit
condition is `pr_checks_green` or `pr_merged` and that owns a kernel delivery reads the
delivery when an owner session completes (`loopPolicy`). While the delivery is
`AWAITING_REVIEW`, `REPAIRING`, `LANDING`, `APPROVED` or `BLOCKED_ON_TRUNK`, the next move is
the kernel's, so the loop holds for the webhook and spends no iteration, however many
sessions complete meanwhile. A `MERGED` delivery satisfies either condition. Any other state
(the owner's `WORKING`, a person's `ESCALATED`) is evaluated as before.

### 13.13 Integration reviews, durable findings, repair builders and landing authority (#4686)

**Status.** Rule 1 (composition) is built and checked by AC-20 to AC-23 (§19):
`packages/workflow-kernel/src/reducer.test.ts` ("composition attestation") and
`apps/web/src/lib/workflow/review-composition.test.ts`. Where the code differs today,
a rule says so under "Today" or "As built". The findings, repair, landing, GitHub-status, projection and external-merge
rules (2 to 10) are owned by the native spec "Workflow kernel" (fa62b865,
`workflow-kernel-library.md` §4, §5 and §7), which carries their criteria and what has
shipped (S3b, S5); §19 maps the old ids to it.

**The incident.** A mission integration PR into trunk was owned by the mission's
`bookkeeping` task (`openMissionIntegrationPr`, `mission-pr.ts`). No delivery was ever
opened for it, so the legacy authority handled it end to end. Evidence: the landing row
was written by `guardReviewVerdict`, a kernel PR skips that gate, and a zero-diff fix
completed even though `fixCompletionGate` would refuse one. The sequence:

1. The landing door found the PR green with no review on file and requested one
   (`pr_landing` deferred).
2. Reviewer `c487c022` asked for changes: two copy findings, each tied to a file and
   line, at the PR's head. GitHub refuses `REQUEST_CHANGES` from a PR's own author, and
   the buildd App had opened this PR, so `postPrReview` posted the verdict as a
   `COMMENTED` review (own-PR fallback, `lib/github.ts`).
3. The legacy fix `8eedeae9` (`workers/[id]/route.ts`, reviewer-outcome handler) copied
   the owner's description verbatim, including "It performs no work of its own". It got
   no builder role and no `repairTarget`. It made zero edits and reported no work, and
   nothing refused that: no completion gate covers a legacy review fix.
4. The next push was a person's merge of trunk into the mission branch. It was not a
   fix. Re-review `5d910273` found both findings still unaddressed and again posted as
   `COMMENTED`.
5. The landing door refused the PR on the outstanding verdict (`pr_landing`
   `stranded`). **The buildd gate held.**
6. A person's own GitHub account then merged the PR. The committer was GitHub's
   `web-flow` and the merge carried no app attribution. Every buildd door merges with
   the installation token, which GitHub attributes to the App's bot, so this was a
   **manual merge outside buildd** (GitHub UI or a personal-token CLI). After the merge,
   `measureMergeAgainstReview` wrote one `review_verdict` `bypassed` row. Nothing else
   recorded the bypass: no finding record, no task, no note.
7. `get_pr` printed "Reviews: none". Its summary keeps only GitHub `APPROVED` /
   `CHANGES_REQUESTED` reviews, so it drops `COMMENTED` and never reads buildd's own
   verdict.

Both findings are still on trunk.

**COMMENTED does not explain it on its own.** Trunk has no required review and no
required check that carries buildd's verdict, and admins are not bound. So a genuine
`CHANGES_REQUESTED` review would not have stopped this merge either. The verdict lived
only in buildd's rows, and nothing projected it onto the one surface GitHub enforces. The
gap is "landing authority stops at buildd's own doors", not "the review was the wrong
type".

#### Rules

1. **Review composition reuses evidence and never invents approval.** An integration,
   release or refresh PR reuses each constituent's head-bound review (§5.9). Only the
   novel or uncovered delta is reviewed. An `unverifiable` composition, or one whose
   constituents cannot all be proved, means a full review. It is never approval. A
   constituent counts only when its *latest* decided round at the cited head is
   `approve` and its delivery is not `CHANGES_REQUESTED`/`ESCALATED` at that head. An
   approve round that a later request-changes round superseded at the same head does
   not count.
   *As built:* `coveringRound` (`review-composition.ts`) and `verifyCompositionAttestation`
   (kernel `reducer.ts`) take only a constituent's latest decided round at the head, and
   refuse one whose delivery is `CHANGES_REQUESTED`/`ESCALATED` at that head or has an open
   required finding (`constituent_approval_superseded`, `constituent_delivery_blocked`,
   `constituent_open_findings`). An attestation on a PR with its own open finding is
   rejected (`open_findings`). The attesting effect writes a four-part composition block
   into the PR description (`composition-description.ts`): reviewed constituent work,
   composition verification, uncovered-delta review, final policy gate.
   A mission integration PR is composed like any other since S6 gave it a delivery
   (it had none at #4686 and was reviewed whole).
2. **Findings are durable.** A request-changes verdict creates findings, one per
   distinct issue, each pinned to the round, head, path and line it was raised on.
   A finding stays open across later pushes, CI results, base refreshes,
   composition, re-review rounds that do not re-read its path, and replacement of the
   owner task or worker. It closes only when one of these happens:
   - a later round at a head that contains the change explicitly resolves it;
   - a person waives it (recorded with who and why);
   - the PR closes unmerged (the finding moves to the superseding PR, if any).

   An open finding blocks landing at every door (rule 6).
   Amended by `workflow-kernel-library.md` §5 (slice S5): a finding's id is stable
   across rounds (derived from the round that raised it and its position, kept when a
   later round restates it); `addressed` (a push touched its path) is an interim state
   that still blocks; `deferred` (to a named task, by a reviewer or a person, with who
   and why) is a fourth closure.
   *As built (S5):* `workflow_findings`, written by the kernel's transition statement;
   the gate, T15, the policy-merge rule and `buildd/landing` read open required
   findings. An approval that leaves one unverified queues a verification round at the
   same head instead of approving it (library §5, "As built").
3. **A repair is an executable builder pinned to the exact target.** A review fix,
   whether kernel `dispatch_fix` or legacy, carries all of the following:
   - its own description: the open findings, verbatim, as its task. The owner's
     description appears only as background, and a `bookkeeping` or `coordination`
     owner's "performs no work" text is never copied;
   - a builder role;
   - `repairTarget: { prNumber, headRef, headSha, baseRef }` (§13.11 rule 1), so it
     resumes the PR head even when that head is a mission branch far ahead of trunk.

   *As built (S5):* the kernel's review fix (`fixWork`) and CI fix (`ciFixWork`) are builders
   (role `builder` when the owner has none or is coordination-only), stamp `repairTarget`
   from the PR head GitHub reports, and never copy a coordination or bookkeeping owner's
   description (`workflow-kernel-library.md` §5, "As built"). *Today* (legacy, a PR with no
   delivery): the `workers/[id]/route.ts` reviewer-outcome fix still copies the owner's
   description and inherits its role.
4. **Completion evidence has three separate states.** A task ending is not a repair
   published, and a repair published is not a finding resolved. A review fix completes
   only on one of these:
   - a push to the PR head that changes at least one path named by an open finding
     (or a path the reviewer's feedback names);
   - a verified no-op: a live read showing the finding's text or condition is already
     absent at the current head, recorded as evidence.

   A zero diff, a diff that touches none of the findings' paths, or a head that moved
   only because of a refresh or someone else's push keeps the blocker. The task fails
   and spends the attempt budget. Reporting success does not stop that.
   *As built (S5):* the kernel's `fixCompletionGate` refuses an unmoved head without a
   verified no-op claim, and a moved head whose diff changes nothing near any open
   finding nor any path the feedback names (the library's §5 "As built" says what "near"
   is and why it is wide). A no-op claim ends the attempt "no change" and owes a
   verification round; a fix that ends with the head unmoved is "no change" too.
   *Today:* a legacy review fix (a PR with no delivery) is gated the same way
   (`legacyReviewFixCompletionGate`: head moved, diff near the review's paths), and a
   refresh push credited to a running fix by §6.9 is not told apart from the fix's own.
5. **A refresh push is not a fix.** A push whose only new content is a merge of the
   base, or the platform's own `refresh_branch`, starts a delta round scoped to what
   the merge decided (§5.9 refresh). It never counts as the fix attempt's output and
   never closes a finding.
6. **One landing authority, at every merge door, checked when the merge runs.** Every
   path that can merge a PR asks one question before the `PUT .../merge` call: is the
   PR covered at this exact head, with no open finding and no unresolved
   request-changes or escalation? The paths are each door, the sweep, the kernel's
   `merge_call` effect, a policy-rule merge and the release executors, and the door
   inventory below lists them. The `merge_call` effect asks again when it runs, not
   only at T15. A verdict or finding recorded while the delivery is `APPROVED` or
   `LANDING` moves it out of landing (`CHANGES_REQUESTED`). A rule can never turn a
   request-changes into approval. `PolicyMergeApproved` may lift a policy escalation.
   It may not lift `review_exhausted` while a finding is open. Only a person's
   recorded override (dashboard, §7 `bypass`) passes an open finding.
   *Today:* see the door inventory. The release executors and compose release do not
   consult the gate. `merge_pr` `force` with an admin token skips it for a non-kernel
   PR. `tryAutoMergeWorkerPr` skips it when it cannot resolve a workspace. The kernel
   does not recheck a review at `merge_call`, and `ReviewVerdictRecorded` outside
   `AWAITING_REVIEW` is `stale`. `PolicyMergeApproved` lifts `review_exhausted`.
7. **buildd's verdict reaches GitHub as something GitHub enforces.** While a finding is
   open, buildd publishes a failing commit status (or check run) at the PR head that
   names the open findings. Workspaces can make that status required on trunk. A
   `COMMENTED` review is **never** approval and never clears anything (it already is
   not; `readGithubApproval` skips it). The own-PR fallback stays, because GitHub
   refuses the alternative, but it can no longer be the only signal.
   *Today:* no status or check carries the verdict. Trunk protection can only see CI.
8. **Projections read canonical delivery state.** `get_pr`, `get_pr_review`, explain,
   the activity comment and the task page report the reviews, open findings and
   landing blockers that the delivery (or, for a legacy PR, the reviewer rows plus
   findings) records. They never report only GitHub's review states. "Reviews: none"
   with an open request-changes is a defect.
   *Today:* `get_pr`'s summary reads GitHub reviews only (`api/github/pr/route.ts`) and
   drops `COMMENTED`.
9. **Recovery, idempotency and retry exhaustion.** Each finding has one fix lineage.
   Re-dispatch for the same `(finding set, head)` is single-flight. A fix attempt that
   fails rule 4 counts against the round budget (`max_rounds`). At exhaustion the
   delivery is `ESCALATED(review_exhausted)` with the open findings attached, and a
   person is notified. Nothing merges it unattended (rule 6). A replay of any effect
   at the same head and version is a no-op.
   *As built (S5):* `workflow-kernel-library.md` §5, "the review loop never stalls":
   an outside reviewer's verdict at the current head is adopted, never dropped; a round
   whose reviewer could not be filed fails (T27) rather than staying open; a green CI
   run at the head a CI repair was bound to ends that repair without spending it.
10. **An external merge records the truth and approves nothing.** When GitHub reports
    a merge buildd did not make while findings were open, the delivery becomes
    `MERGED` (T17 accepts any non-terminal state). The record says `merged over open
    findings`, with the merge actor and path as GitHub reported them (app bot versus a
    person's account, committer), and every open finding stays open and attached to
    the merged PR. A follow-up fix task is filed against trunk for those findings, and
    a person is notified. The merge is never counted as an approval, a resolution or
    a waiver.
    *Today:* a `review_verdict` `bypassed` ledger row only (`review-subscribers.ts`).

#### Merge door inventory

Read from the code at this section's commit. Line numbers drift, so re-grep the
symbol. Every REST merge goes through `mergePullRequest` (`lib/github.ts`, pinned with
`sha`) except where noted. No GraphQL merge, no `enablePullRequestAutoMerge` and no
workflow `gh pr merge` exists.

| # | Door | Merge call | Reached from | Review gate (as shipped, S3b) |
|---|---|---|---|---|
| D1 | Kernel `merge_call` effect | `workflow/pr-landing-effects.ts` `mergeCall` | T15 `LandingRequested` (`reducer.ts`), drained by `landThroughKernel` (`workflow/landing.ts`) and the cron drain | kernel state at T15 only. At run time it checks `LANDING` + head, and no review recheck |
| D2 | `landPr` | `lib/pr-landing.ts` (legacy `mergePullRequest`, else `landThroughKernel`) | `check_suite` webhook, `PUT /api/github/pr`, dashboard route, reviewer approve (`workers/[id]`), surface wake, landing sweep (`pr-landing-sweep-deps.ts`, cron `pr-reconcile`) | `guardReviewVerdict` (legacy PR), kernel `APPROVED` (kernel PR) |
| D3 | Landing sweep, kernel arm | via D2 → D1 | `listApprovedKernelPrs` (`workflow/landing.ts`) | kernel `APPROVED`, including composition and `policy_rule` approvals |
| D4 | `tryAutoMergeWorkerPr` | `lib/auto-merge.ts` | `check_suite` webhook (shadow/off), `maybeAutoMergeNoCiPr`, reviewer approve, surface wake | `guardReviewVerdict`, refuses when no workspace id resolves (S3b) |
| D5 | `PUT /api/github/pr` (MCP `merge_pr`) | `app/api/github/pr/route.ts` | MCP `merge_pr` (`packages/core/mcp-tools.ts`) | `landPr` in enforce. Otherwise `guardReviewVerdict`. Admin `force` keeps the review verdict (S3b) |
| D6 | `POST /api/prs/[prNumber]/merge` (dashboard, chat `merge_pr`, compose include) | `app/api/prs/[prNumber]/merge/route.ts` | dashboard, chat registry, `release/compose-runtime.ts` | `landPr` in enforce, otherwise `guardReviewVerdict`. A person may override |
| D7 | Release PR on green CI | `app/api/github/webhook/route.ts` `handleReleasePrCiSuccess` | `check_suite` success | `guardReviewVerdict` (legacy rows). A kernel-owned PR lands through the kernel (S3b) |
| D8 | `executeRelease`, release-PR path | `lib/release-executor.ts` (`release/pinned-merge.ts`, pinned with `sha` since S3b) | worker completion (`release-completion-policy.ts`), mission release | the review gate, merging only the verified head (AC-16) |
| D9 | `executeRelease`, `mergeIntoProd` | `lib/release-executor.ts` `mergeIntoProd` → `release/pinned-merge.ts` (squash, pinned with `sha`) | same, `every_merge` strategy | CI read at the worker PR's live head (red refuses, running holds the release on the PR, none reported leaves it to GitHub's required checks), then the review gate, merging only that head (AC-16). A worker branch with no PR is refused, never merged: `failed` when the task asked for a release, else `skipped` |
| D10 | Compose release | `release/compose-actions.ts` → `release/compose-runtime.ts` `mergePr` | `api/releases/compose` | GitHub reviews at the candidate SHA (`packages/core/release-compose.ts`), plus the review gate on the pinned head (S3b, AC-16) |
| D11 | Policy-rule merge | `workflow/seam.ts` `policyMergeThroughKernel` → `PolicyMergeApproved` → D3/D1 | escalation gate `policy_merge` (`packages/core/escalation-gate.ts`, `merge-policy-rule-executor.ts`) | creates the approval. Lifts `review_exhausted`. Mission ship PRs are excluded |
| D12 | Manual merge on GitHub | — | a person's account, UI or CLI | not a gate: recorded as an external merge, with a trunk fix filed once (AC-15). `buildd/landing` stops it once trunk requires that status (rule 7). This is the #4686 door |
| D13 | Agent self-merge | — | local runner Bash (only `gh pr merge` denied, `apps/runner/src/pr-mutation-enforcement.ts`), cloud runner egress (REST and GraphQL merge blocked, `apps/cloud-runner/src/outbound.ts`) | deny lists, not a gate |
| D14 | Living Spec generated repo copy | `lib/specs/repo-copy.ts` `landSpecRepoCopy`, and `lib/specs/retire-repo-file.ts` `landRetirementPr` for a retired spec's copy removal, both through `mergeGeneratedSpecPr` (pinned with `sha`) | `check_suite` success on a spec's generated PR | only the generator's own commit at the approved revision, or the removal commit buildd wrote (living-specs R-35, R-78); not a kernel delivery |

**S3b (workflow-kernel-library.md §4):** D1 now asks the gate when it runs (fresh read,
review half, rails port; AC-14); D4 refuses with no workspace; D5 `force` keeps the
review verdict; D7 lands a kernel PR through the kernel; D8–D10 take the review gate and
merge only the verified head (`release/pinned-merge.ts`, AC-16); D11's policy-rule
approval passes an escalation, never an open request for changes, at merge time; D12 is
recorded as an external merge with a trunk fix filed once (AC-15) and is what
`buildd/landing` exists to stop once trunk requires it; D13 is unchanged (deny lists).
The inventory is held to the code by `apps/web/src/lib/workflow/merge-door-inventory.test.ts`.

Branch-to-branch merges that do not go through a PR (`mission-branch-refresh.ts`,
`scripts/sync-dev.sh`, `release-refresh.yml`) are not landing doors. They move a base,
and §5.9 refresh composition reviews what that merge decided. The release executor used
to be on this list with a `POST /merges` of a worker branch that had no PR straight into
the prod branch. That merge moved production, not a base, so §5.9 never reviewed it, and
it read no verdict and no CI and pinned no head. A branch with no PR has no verdict and no
delivery to gate, so the executor now refuses it (D9) and a release needs a PR.
The mission delivery settlement's tree probe (`workflow/delivery-epochs.ts`,
`workflow-kernel-library.md` §6) is not a door either: it test-merges a PR head into a
scratch ref cut at the delivery's merge commit, reads the tree, and deletes the ref in
the same step. Nothing it writes is ever a base or a branch anything reads.

**Which already use the kernel gate:** D1 (as T15), D2 and D3 for a kernel-owned PR,
D4–D6 via T15 for a kernel-owned PR after their own legacy gate, D7 for a kernel-owned
PR, D8–D10 through the review gate on the pinned head (S3b), and D11 (but it
manufactures the approval). D12 and D13 never consult the kernel. A mission integration
PR has had a delivery since S6 (`openMissionPrDelivery` binds it to its bookkeeping
task, one delivery per epoch), so it gets the same gate at every door; at the #4686
commit it had none.

Regressions: AC-20 to AC-23 (§19) here; the rest in fa62b865 (§19 maps them).

## 14. Migration plan: no two authorities, ever

> Amended 2026-10-13 by the native spec "Workflow kernel" (fa62b865; repo copy `workflow-kernel-library.md`) §3: the kill switch and cutover are per host mode; in production the kernel runs only on the control plane.

**Principle.** Authority is assigned per field family, in order, and each slice ends
with the previous authority for that family *deleted*, not shadowed. A "shadow" that
writes the same decision as the legacy path is a second authority the moment any
reader trusts it; the plan therefore has no shadow phase that a reader can see.
Dual-running is allowed only in the sense that **new code is dark**: kernel tables
exist, no reader or gate reads them, nothing writes them except the backfill, until
the cutover commit moves the whole family at once.

| Slice | Authority moves | Legacy removed in the same PR | Gate before merging |
|---|---|---|---|
| **A0** | none (schema, reducer as pure code with the §16 matrix green; no wiring) | — | `bun run test` on new files; migration generated |
| **A** (seam) | review rounds, fix loop, delivery proof, **review and CI attempt ledgers with provenance (§5.7, §6.9)**, dispatch revalidation (§10.5), the activity comment as a regenerated projection (§12.1), for deliveries whose policy is `agent-review`; delivery rows created at `PrBound` with a **one-time import** from GitHub live read plus legacy rows | `handleReviewerOutcomeIfNeeded` fix-task insert, `findReviewTaskForPr` newest-row rule, `announceFix*` direct writes, `maybeReDispatchReviewer` decision logic, `dispatchStaleApprovalReReview` decision logic, `isBuilddWorkerCommit` and every read of `context.iteration` for a decision, `appendPrActivity` read-modify-write | S1–S8, S23, S25, S26, S28 green; flag `workflow.kernel` per workspace; **a workspace is either entirely kernel-owned for the family or entirely legacy**, never both |
| **B** | conflict and migration families (mechanical effects, §6.7), trunk circuit breaker and `BLOCKED_ON_TRUNK` (§6.10; base-red rule on by default, `trunkBreaker: false` turns it off), fact ingestion funnel and terminal-wins: `recordPrFact` replaces every writer of `prLifecycleStatus`/`mergedAt` (≈25 sites, §17.2); webhook `closed`/`synchronize`/CI become hints | the listed writers; `pr-state-reconcile.ts`; render-time refresh writes; `conflict-retry.ts` and `migration-collision-retry.ts` decision logic | S5, S6, S9–S11, S24, S27; no reader changes yet (columns keep their values and meaning) |
| **C** | landing and merge: the five merge doors and `landPr` run as T15/T16 with `merge_call` effect; post-merge effects become outbox effects | inline `emit()` post-merge work; per-door `mergedAt` stamps; `tryAutoMergeWorkerPr` as a decision-maker (it becomes an adapter calling `LandingRequested`) | S10, S15; `landPr` rails untouched |
| **D** | supersession, abandonment, mission completion inputs, reaper/cleanup | `recordPrSupersession` direct update; reaper auto-complete for deliveries; `prShipState` reads delivery | S9, S12, S16; `canCompleteMission` ACs of `mission-task-lifecycle` still pass unmodified |
| **E** | projections: UI, explain, Home, activity comment read `getDeliveryView`; retire duplicate maps (`derivePrLifecycle`, `isPrMerged`, `TaskCard` `PR_LIFECYCLE`, `deriveStage` PR branch, chat `dock-model`, `TaskObject`) | the re-derivations in §17.5 | S17; visual QA per `/visual-review` |
| **F** | delete retired columns/indexes; turn on the write-site guard in blocking mode | the last column readers for kernel-owned PRs (`get_pr`, `list_prs`, the mission drawer, §13.10); `*RetryHeadSha` unique indexes and `iteration` context keys **after legacy drains** (task `9d7ce2d4`: a reader-and-kill-switch removal release, then the drop one release later) | guard test green with an empty allowlist beyond the kernel |

**Backfill and import.** `PrBound` on a PR that already has legacy rows creates the
delivery by a **live read**, not by trusting legacy columns: GitHub says open/merged/
closed and the head; the latest decided reviewer task whose `context.headSha` equals the
live head becomes round 1's verdict (otherwise round 1 is queued fresh), fix tasks with
a live attempt are bound as `FIXING`. In-flight legacy retries finish under the legacy
code path only for workspaces still flagged off.

**Per-workspace kill switch.** `gitConfig.workflowKernel` is a boolean, absent = on:
the kernel ships live, not dark (owner decision for Slice A, superseding the earlier
default-off plan). `false` is the emergency rollback. There is no `shadow` value on
purpose.

*One reading.* The key is read in exactly one place per language:
`kernelEnabled(gitConfig)` in TypeScript and `kernelOnSql(gitConfigColumn)` in SQL
(`apps/web/src/lib/workflow/authority.ts`); no other code parses it, and a test runs
both over the same value forms and requires them to agree
(`apps/web/tests/db/workflow-probe-killswitch.test.ts`). The outbox drain reads it
through the kernel's `Policy` port (`builddPolicy`, `kernel-policy.ts`, over
`kernelEnabled`), not in the effect claim statement, which reports only the
delivery row's own authority. The kernel is **on** only
when the key is absent, JSON `null`, `true`, or the string `'true'` or `'on'` (a
`git_config` that is null or not an object reads as absent). **Every other value is
off**: `false`, `'false'`, `'off'`, and anything unrecognised (`'no'`, `'TRUE'`,
`0`, an empty string, an object). An emergency switch fails toward legacy, the path
that needs no kernel at all, and an operator never needs the exact spelling to stop
it. A write is stricter than a read: the workspace `PATCH` accepts only `true`,
`false` or `null` for the key and answers 400 otherwise, so no new string form is
stored; the read tolerates the forms already stored.

*A read that fails.* Ownership is a database read, so it can fail. Kernel-side
decisions **fail closed**: an effect whose claim (which reads the switch in the same
statement) fails is not run and is retried with backoff; a sweep row whose authority
cannot be resolved is skipped and counted as an error; a seam function throws to its
caller. No kernel decision is made on an unknown answer. The two legacy doors that ask
"is this PR the kernel's?" (the PR-opened policy and the `synchronize` re-review)
fall back to legacy on an unreadable answer, as they did before the kernel: a legacy
door has no floor to retry it, so failing closed there would lose a review, which is
the stranding this section forbids; the duplicate it risks is bounded by
`createReviewerTask`'s per-head single-flight guard. Display reads degrade to the
legacy projection, which the kernel keeps current (§12).

**Cutover: pre-existing deliveries finish on legacy.** A delivery row is opened only at
the point the legacy code would dispatch a PR's first review, so a PR that is already
open (mid-review, mid-fix) at deploy has no row and every seam function answers "not
mine" for it; it finishes exactly as before. Lazy adoption of in-flight PRs was
rejected: the import would have to trust legacy columns (reviewer JSONB, `iteration`)
for state the kernel did not see, which is the ambiguity the kernel exists to remove,
and the population drains on its own as those PRs merge or close.

**Kill switch semantics.** With the switch off, the first kernel touch of a delivery
releases it (`authority = 'legacy'`, `released_at`) in the same statement that reads
it; no new delivery opens. The release is sticky: switching back on does not hand a
released delivery back, because legacy may have acted on it meanwhile. Neither
direction rewrites kernel state. "A kernel touch" is every path that would decide for
a delivery, including the sweeps: the reconciliation floor, the treadmill restart,
the trunk recovery sweep and its incident join each resolve authority per delivery
before acting, so a sweep never applies a transition or pushes to a PR branch in a
switched-off workspace. Read-only surfaces (delivery views, the PR activity
diversion, the ship state, landing's candidate lists) apply the same reading, so a
switched-off delivery is shown and landed by legacy before anything has released it.

*The kernel decides nothing for a released delivery.* `applyCommand` refuses any
command on a delivery whose `authority` is `legacy` (`rejected: legacy_owns`), and the
transition write itself is guarded on `authority = 'kernel'`, so a release that lands
between the read and the write wins. Whatever asks (a draining effect reporting back,
a sweep, a door that raced the release), no new transition is recorded.

*Committed effects drain, narrowed.* The effect runner reads who decides in the
statement that claims an effect. For a delivery the kernel no longer owns it first
releases a switched-off one, then:

- the kinds that act on GitHub for the kernel's own landing and repair loop,
  `merge_call`, `refresh_branch`, `renumber_migration` and `push_recovery`
  (`KERNEL_ONLY_EFFECTS`), are done as `skipped:legacy_owns` and never run. Their
  answer is something only the kernel reads (a merge answered `behind` becomes a
  refresh, a refresh a new head, a new head an approval), and a merge is the one
  action an emergency rollback must be able to stop, so a merge queued before the
  switch never lands after it;
- every other kind still drains: projections and notifications, and the dispatches,
  which are decisions already made and create legacy-shaped tasks (fix tasks carry
  `reviewerRetry*`, `iteration`, `resumeBranch`; reviewer tasks carry the full legacy
  context), so legacy can carry the delivery on. A committed `dispatch_review` must
  drain: skipping it would leave a PR whose round was queued with no reviewer from
  either authority. What a draining handler reports back is refused by the rule
  above, so a drained effect never starts a new kernel decision chain. A dead effect
  on a released delivery records its gate event and escalates nothing.

*Switch-off hands live deliveries to legacy.* A delivery is opened where legacy would
file a PR's first review, and the kernel's first round is queued only when the owner
attempt ends (§6.5 row 1). A delivery the switch releases before then has had no
review from either authority, and legacy files a first review only when the PR opens,
which has passed. So when an owner attempt ends on a released delivery that has no
round, in a workspace whose switch is off, for a PR that is still open, the seam
(`handOffToLegacy`, the package's `handOffToLegacyOn`, reading the switch from `Policy`) runs
legacy's first review through the reviews module's `HandOff` port (`handOffHost`,
`review-handoff.ts`): one reviewer task at the live head with no
`workflowRound` (legacy's), announced and woken, and the PR's `review_queued` line; a
delivery opened with a pre-flight finding gets legacy's answer to that instead, a
`human_review_required` line and a team notice. The policy is not re-run, because the
delivery exists only where the policy already asked for a review. It runs once per
owner task (`tasks.context.workflowLegacyHandoff`); a failure clears the claim so the
next owner end tries again. A delivery released while the switch is on was handed
over by a legacy decision (a pre-flight escalation, an unbindable PR) that already
answered it, and is not handed off again. A delivery released after its first round
was queued is carried by the drained `dispatch_review` above.

**Rollback.** Turning the flag off returns the family to legacy, and the projections
(`workers.*`, `tasks.*`) already hold correct values because the kernel projects into
them (§12); the delivery rows are ignored, not deleted.

---

## 15. Worked example: replaying PR #3754

Illustrative identifiers: `H1` is the PR's only commit on GitHub; `L2` is the fix
worker's local commit; rounds and versions are as the kernel would number them.

| # | Event (what happened) | Kernel input | Source state (v) | Kernel result |
|---|---|---|---|---|
| 1 | Builder opens PR #3754 at `H1` | `PrBound`, `HeadObserved(H1)` | `WORKING` (v1) | `WORKING`, `current_head=H1` (v2); `dispatch_review` queued for round 1 |
| 2 | Builder attempt completes | `AttemptEnded(success, L=H1)`; live head `H1` contains `L` | `WORKING` (v2) | `AWAITING_REVIEW` round 1 at `H1` (v3) |
| 3 | Reviewer: request changes, "check the caller's task, not the owner's" | `ReviewVerdictRecorded(round1, request_changes, head=H1)` | `AWAITING_REVIEW` (v3) | `CHANGES_REQUESTED` (v4); effects `dispatch_fix(round 1)`, `post_review(commit H1)`, activity |
| 4 | Fix task created and claimed | `FixDispatched`, `FixClaimed(a1)` | `CHANGES_REQUESTED` (v4) | `FIXING` bound `(H1, r1, a1)` (v5) |
| 5 | Fix worker commits `L2` locally, edits the PR body to describe the corrected check, and completes "SUCCESS". The runner reports `commitCount=1`, `lastCommitSha=L2`. GitHub head is still `H1` | `AttemptEnded(a1, success, L=L2)`; the `complete_task` PATCH first hits the completion gate | `FIXING` (v5) | **Gate:** `delivery_not_advanced` (400) — live head `H1 == Hb`. If the worker is already gone, T4 applies: `FIXING → AWAITING_PUSH` (v6), `push_recovery` queued. **`FIXING → AWAITING_REVIEW` is not reachable** (needs §9 proof (1) `H' != Hb`) |
| 6 | Today: `fix_ended` appended, then a second review round queued against `H1` ("Re-reviewing · after fix 1 of 3") | `ReviewRequested(head=H1)` | `AWAITING_PUSH` (v6) | **`rejected(head_already_reviewed)`** — round 1 already decided at `H1`; and from `AWAITING_PUSH` T5 is not an allowed source state at all. No round 2, no second reviewer run, no stale-verdict loop |
| 7 | Today: the PR body now describes the corrected check | `update_pr` | any | **No fact, no transition.** Body text never counts as delivery |
| 8 | Push recovery: runner is told to push; or recovery attempt pushes `L2` | `HeadObserved(L2)` live head `L2`, contains `L2`, `!= H1` | `AWAITING_PUSH` (v6) | proof holds → `AWAITING_REVIEW`, round 2 bound to `L2`, kind `delta` from `H1` (v7); `dispatch_review` |
| 9 | If recovery cannot push (runner lost, three tries spent) | `PushRecoveryExhausted` | `AWAITING_PUSH` (v6) | `ESCALATED(push_undeliverable)` (v7): a person sees the branch and `L2`, instead of an open PR that looks "in review" |
| 10 | Reviewer approves `L2`, CI green | `ReviewVerdictRecorded(round2, approve, head=L2)`, `LandingRequested` | `AWAITING_REVIEW` (v7) | `APPROVED` → `LANDING` → merge pinned at `L2`; `PrMerged` → `MERGED`; the recorded supersession of the sibling PR (`SupersessionRecorded`, T20) is then authorised by "the caller's task's records link the PR" (§17.1) |

**The exact rejected transitions** are two: `FIXING → AWAITING_REVIEW` at step 5
(evidence `H' != Hb` absent, result `AWAITING_PUSH`/`delivery_not_advanced`) and
`ReviewRequested(H1)` at step 6 (`head_already_reviewed`, and wrong source state).
Neither depends on the reviewer, the worker's honesty, or a sweep.

Why the same mistakes could not recur in each existing writer: the completion path
cannot report success without the gate; the activity comment is rendered from
transitions so it never says "fix ended, re-reviewing" without a matching round;
`tasks.status='completed'` on the fix attempt is an execution fact and is not read as
delivery; the retry task of the friction ticket would have seen `AWAITING_PUSH` /
`ESCALATED(push_undeliverable)` from `explain` rather than "PR open, CI green".

---

## 16. Test matrix

Run a file with `bun run scripts/run-unit-tests.ts <file>`; the full unit suite is
`bun run test` (4–6 minutes: give the shell a long timeout; failures are in
`.test-report.log`). Spec checks: `bun run specs:check`. Integration (live server):
`bun run test:integration`. A "(new)" file does not exist yet. Phase 2 adds each new
directory to `UNIT_TEST_ROOTS` in `scripts/run-unit-tests.ts` (the
`scripts/collector-coverage.test.ts` check fails otherwise).

| # | Scenario | Asserts | Target test file(s) |
|---|---|---|---|
| S1 | Fix ends with a local commit, GitHub head unchanged (#3754) | completion gate 400 `delivery_not_advanced`; with worker gone → `AWAITING_PUSH` + `push_recovery`; no round 2; no `fix_ended`-then-review | `packages/workflow-kernel/src/reducer.test.ts` (new), `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S2 | Approve at `H0`, non-equivalent push to `H1` | `APPROVED → AWAITING_REVIEW`, round 2 dispatched **on the push**, not at merge time: a delta round only under §8.3a, else full | `packages/workflow-kernel/src/reducer.test.ts`, `apps/web/src/lib/reviewer-subscribers.test.ts` (new: the module has no test file today; its re-dispatch cases live in the webhook route test), `apps/web/src/lib/review-verdict-gate.test.ts` |
| S3 | Approve at `H0`, head moves by platform refresh (content-equivalent) | `approved_heads` appended once; concurrent double call appends once; a composition approval carries the same way (`composition_heads`); a newer reviewer row at another head does not decide it; `own_refresh` when the previous head is a `refresh_branch` pin; `equivalentHeadShas` projected only after the transition | `apps/web/src/lib/approval-carry-forward.test.ts`, reducer test, `apps/web/tests/db/workflow-matrix.test.ts` (T13 describe, S32/T13), `apps/web/tests/db/workflow-seam.test.ts` |
| S4 | Late verdict for a superseded head | stored on its round, no state change, no `post_review`, no merge | reducer test; `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S5 | Duplicate webhook delivery and duplicate reviewer PATCH | `duplicate`; effects not doubled | reducer test; `apps/web/src/app/api/github/webhook/route.test.ts` |
| S6 | Out-of-order: `closed(merged)` then late `synchronize`/`opened`/`check_suite` | terminal wins; `workers` columns unchanged; old-SHA CI failure does not overwrite | `apps/web/src/app/api/github/webhook/route.test.ts`, `apps/web/src/lib/pr-state-refresh.test.ts`, `apps/web/tests/db/pr-facts.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts`, `packages/core/__tests__/pr-fact-write-sites.test.ts` |
| S7 | Two fix dispatches race (#3420) | one `dispatch_fix` per `(delivery, round)`; loser `stale`/cancelled; `approve` cancels open fixes | reducer test; `apps/web/src/lib/supersession-store.test.ts` |
| S8 | Request-changes budget exhausted | `ESCALATED(review_exhausted)` once per head | reducer test; existing reviewer exhaustion tests in `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S9 | Reaper/cleanup sees a dead worker with only local commits | `AttemptEnded(lost)` → `AWAITING_PUSH`; task not `completed` with `result.sha` | `apps/web/src/lib/stale-workers.test.ts`, `apps/web/src/app/api/tasks/cleanup/route.test.ts` |
| S10 | Merge response `indeterminate`; double merge call | stays `LANDING`; `verify_merge`; one `PrMerged`; merge pinned at head | `apps/web/src/lib/pr-landing.test.ts`, `apps/web/src/lib/auto-merge.test.ts`, `apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts` |
| S11 | Human merges on GitHub while `AWAITING_REVIEW` | T17 from any state; open attempts cancelled; merged-over-verdict classified | webhook route test; `apps/web/src/lib/review-subscribers.test.ts` (new: none today) |
| S12 | Closed unmerged, work shipped under another PR; caller task links the PR | T20 allowed only from `CLOSED_UNMERGED`; authorised on caller's task, not the owner's; overwrite refused; mission completion treats it as shipped | `apps/web/src/app/api/github/pr/supersede/route.test.ts`, `apps/web/src/lib/pr-supersession.test.ts`, `apps/web/src/lib/mission-completion.test.ts` |
| S13 | Crash between transition and effect; crash mid-effect | effect row present atomically; lease expiry re-runs; idempotent | `apps/web/src/lib/workflow/effects.test.ts` (new), pattern of `apps/web/src/lib/dispatch-reconcile.test.ts` |
| S14 | A sweep tries to assign state | sweep modules import only `ingestFact`/`enqueueMissingEffects`; write-site guard fails on any direct write to a guarded column outside the allowlist | `packages/core/__tests__/workflow-write-sites.test.ts` (new; pattern of `packages/core/__tests__/model-policy-authority.test.ts`) |
| S15 | Base keeps moving under an approved PR | `LANDING`/`REPAIRING(behind)` bounded by the treadmill cap per cycle; an approved head whose base delta is small, disjoint and risk-free lands across it (the disjoint-delta rule, §13.7 item 10) instead of escalating; otherwise a spent cycle escalates with the cause (`refresh_unsafe` naming the files, or `refresh_exhausted`), restarts after the cooldown up to `MAX_TREADMILL_CYCLES`, then stays with a person, whose freshness override lands it; the bound stays, and a refresh that leaves the PR's diff unchanged (mechanical, or an agent conflict repair that only merged the base) carries the approval (T11/T13) instead of re-arming a review round, so the budget is not spent waiting on reviewers while the base moves (92a439a6); a migration on one side of the gap is not a risky path unless the other side has one too (T12; #5522); under `gitConfig.landingLane` one behind refresh per repo + base is in flight and the rest park until it frees (item 11); hard gates unchanged | `apps/web/tests/db/workflow-scenarios-treadmill.test.ts`, `apps/web/tests/db/workflow-scenarios-lane.test.ts`, `apps/web/src/lib/workflow/base-delta.test.ts`, `apps/web/src/lib/pr-landing.test.ts`, `apps/web/src/lib/pr-landing-sweep.test.ts`, `apps/web/src/lib/base-refresh.test.ts` |
| S16 | Mission with a `SUPERSEDED`/`ABANDONED`/open/closed delivery | `canCompleteMission` results identical to today for all legacy inputs | `apps/web/src/lib/mission-completion.test.ts`, `packages/core/__tests__/pr-shipped.test.ts` |
| S17 | UI projections agree | one `DeliveryView` → Home chip, task header and mission failure reading agree (part 3); task card stage, mission strip and feed, chat dock, chat tile, PR pill and explain's state chain agree with it for every §4 state, and none reads the worker columns for a kernel-owned PR (Slice E, §13.9) | `apps/web/src/lib/workflow/delivery-display.test.ts`, `apps/web/src/lib/action-queue.delivery-view.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts`, `apps/web/src/app/app/(protected)/tasks/[id]/lineage-status.test.tsx`, `apps/web/src/lib/explain-because.test.ts` |
| S18 | Mission integration branch deleted under an open task PR (cause of the PR #3744 closure) | `CLOSED_UNMERGED(base_deleted)`, `scan_supersession` finds the re-opened PR, T20 records it | `apps/web/src/lib/pr-supersession-detect.test.ts`, `apps/web/src/lib/mission-pr.test.ts` |
| S19 | Fix worker killed after claim | `FIXING → CHANGES_REQUESTED`, the ledger row ends `failed`, the next dispatch allocates the next `attempt_no`, or exhausts | reducer test |
| S20 | Stale `version` from a human action | `stale` + current view, HTTP 409; nothing applied | reducer test; route tests for `/api/prs/[prNumber]/merge`, `/api/github/pr` and `/api/prs/[prNumber]/apply-recommendation`; `apps/web/tests/db/workflow-matrix.test.ts` (S20, T23) |
| S21 | Authorization matrix (§17.1) | owner, caller-names-PR, sibling, other workspace, human | `apps/web/src/app/api/github/pr/supersede/route.test.ts`, `apps/web/src/app/api/github/pr/review/route.test.ts`, `apps/web/src/lib/task-token-auth.test.ts` |
| S22 | Kill switch | with `workflowKernel=false` a delivery is released to legacy (sticky), no new one opens, and a PR with no delivery is untouched by every seam function; the string `"false"` reads the same in TypeScript and SQL; a queued `merge_call` never merges or refreshes after the switch; the trunk sweep decides nothing; a PR released before its first round gets legacy's first review | `apps/web/tests/db/workflow-seam.test.ts`, `apps/web/tests/db/workflow-probe-killswitch.test.ts`, `bun run test` |
| S23 | CI provenance (audit): worker pushes under the owner's git identity; worker pushes under the bot identity; a person pushes | the first two are attributed by SHA set and consume a ledger row; the third is `foreign_push` and consumes none; the cap bounds dispatches in all three; manual "Fix CI" uses the configured cap | `apps/web/src/lib/ci-failure-retry.test.ts`, `apps/web/src/app/api/prs/[prNumber]/retry-ci/route.test.ts`, reducer test (replaces the author-string cases around `isBuilddWorkerCommit`) |
| S24 | Trunk breakage: one signature red on trunk and on several PRs | one incident, one trunk-fix task, zero per-PR `ci` attempts, queued ones `skipped`, deliveries `BLOCKED_ON_TRUNK`, `ci` budget untouched, recovery re-enters `resume_state`; two dependency-bot PRs do not accumulate retries; a second incident on a base whose fix is open joins that fixer (one task, in either drain order), and a red after recovery files a new one | `apps/web/src/lib/workflow/trunk.test.ts`, `apps/web/src/lib/ci-failure-retry.wake.test.ts`, `packages/workflow-kernel/src/reducer.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S25 | Stale dispatch: target merged / approved / CI green / conflict resolved between trigger and dispatch, and between dispatch and claim | ledger row `skipped`, no task (or task cancelled as skipped, not failed); replay is a no-op; reason recorded | `apps/web/src/lib/workflow/effects.test.ts` (new), `apps/web/src/lib/conflict-retry.test.ts`, `apps/web/src/lib/ci-failure-retry.test.ts` |
| S26 | Comment as projection: concurrent renders, lost-update race (a `reviewing` write racing the merge), entries after merge, duplicate sticky comments, PR with no comment, CI red while approved | final comment equals a fresh render of canonical state; `Merged` stays the headline; one comment; created for every bound PR; "Approved" never heads a `REPAIRING` delivery | `apps/web/src/lib/pr-activity-comment.test.ts`, `apps/web/src/lib/workflow/pr-activity-render.test.ts`, `apps/web/src/lib/workflow/pr-activity-effects.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S27 | Mechanical versus agent repair | behind-only conflict and byte-identical renumber complete with no task; textual conflict and non-identical renumber escalate to an agent attempt; false collision from a lagging mission branch is not a collision; dependency-bot PRs are never pushed to | `apps/web/src/lib/conflict-retry.test.ts`, `apps/web/src/lib/migration-collision-retry.test.ts`, `apps/web/src/lib/base-refresh.test.ts` |
| S28 | Ledger separation | CI, review, conflict, migration, trunk families count independently; a reviewer spawned on a CI-fix task does not inherit the CI count; infra requeues change no ledger; `attemptView` is 1-based and identical in comment, title and `explain` | reducer test; `apps/web/src/lib/pr-activity-comment.test.ts`, `apps/web/src/lib/explain.test.ts` |
| S29 | Reviewer prose or no verdict | round fails (T27, reason `prose_verdict` / `no_verdict` / `infra`; a reviewer interrupt is `human_takeover` and escalates at once), re-queued at the same head without a new round number, then `ESCALATED(review_unavailable)`; prose is never applied as approve or request-changes; no legacy requeue and no legacy `reviewer_escalated` note beside it | `apps/web/src/lib/reviewer-output.test.ts`, `apps/web/src/app/api/workers/[id]/route.test.ts`, `apps/web/src/app/api/workers/[id]/interrupt/route.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S30 | Runner hand-off failures (no confirmed outcome, commits but no PR, uncommitted changes) | `AttemptEnded(unproven)` → `AWAITING_PUSH` or requeue; never `completed` delivery | `apps/runner/__tests__/unit/` (new case beside the existing completion tests), `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S35 | Replacement chains read current, not FAILED | a superseded predecessor attempt stays auditable but the delivery and mission situation project the current attempt; owner of next move is canonical | `packages/workflow-kernel/src/projections.test.ts`, `apps/web/src/lib/action-queue.delivery-view.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S37 | Conflict remediation already exists | a conflicted PR with a valid pending/stalled conflict-fix task re-dispatches or repairs it instead of filing a second; the recovery effect is keyed by delivery + remediation family; UI says "Conflict fix stalled" vs "Resolve conflicts" | `apps/web/src/lib/conflict-retry.test.ts`, `packages/workflow-kernel/src/projections.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S31 | Preflight | `create_pr` refuses a body the CI scan would reject, with the reason; runner preflight failure keeps the attempt open; CI miss is tagged `preflight_miss` | `apps/web/src/app/api/github/pr/route.test.ts`, `scripts/check-no-prod-data-local.test.ts` |
| S32 | Release PR composed only of reviewed constituents | composition attestation accepted (`approval_basis = composition`, head in `composition_heads` only); CI still gates; no second reviewer or human escalation; idempotent under duplicate delivery | `packages/workflow-kernel/src/reducer.test.ts`, `apps/web/src/lib/workflow/review-composition.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S33 | Release PR plus a release-only novel delta (conflict resolution, changed migration or generated output) | prior verdicts cover only mapped constituents; a delta round scoped to the novel paths; can still need a human | as S32 |
| S34 | Stale constituent review, head mismatch, missing equivalence proof, incomplete set | composition proof fails closed; the release PR borrows nothing; ordinary PRs stay exact-head bound | as S32 |
| S38 | Mission branch refresh PR (trunk merged into the integration branch by the refresh conflict task) | trunk commits proven as constituents against their trunk PRs; the merge read from whole trees; only paths the merge decided are novel, a dropped trunk change included; CI-regenerated files left out; nothing novel → `approval_basis = composition`, no reviewer; a migration renumbered unchanged is not novel, one edited in the merge is; real code → delta round scoped to it; unreadable tree → full review; the same PR without the refresh context stays ordinary | `apps/web/src/lib/workflow/review-composition.test.ts`, `apps/web/src/lib/workflow/review-effects.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` (S38), `packages/core/__tests__/generated-artifacts.test.ts` |
| S36 | Needs You reads the kernel, not a raw worker status | Home/task surfaces project the owner of the next move; a recoverable blocker stays platform-owned; failure evidence preserved | `packages/workflow-kernel/src/projections.test.ts`, `apps/web/src/lib/action-queue.delivery-view.test.ts`, `apps/web/src/app/app/(protected)/tasks/[id]/RealTimeWorkerView.test.tsx`, `apps/web/tests/db/workflow-matrix.test.ts` |

**The live matrix.** `apps/web/tests/db/workflow-matrix.test.ts` (`bun run test:db`) carries
every S-number: a passing case drives the seam and the real review-loop effect handlers on
real Postgres; a scenario that needs later work is a `test.todo` naming the task that owns
it (556cd910 part 2, 7ab4916f part 3) or the spec slice with no task yet, with its intended
assertions beside it. The matrix is accepted when no todo is left, and since Slice F none is
(§13.10). S14 is the static guard in `packages/core/__tests__/workflow-write-sites.test.ts`,
blocking with an empty allowlist.

**The conformance matrix.** Every row above is covered by a scenario in
`packages/workflow-kernel/src/conformance/` (`scenarios.ts` and `matrix-scenarios.ts`, joined
by `all.ts`), which runs on the in-memory store and on Postgres (`bun run test:db`) with the same
expectations. `matrix-coverage.ts` names the scenarios of each row, and a row the kernel does not
decide (S14) carries a recorded exemption with its reason. `packages/core/__tests__/workflow-kernel-matrix-coverage.test.ts`
fails when a row of this table has no scenario, when a named scenario does not exist, and when
an exemption has no reason. A row that also has a part the kernel does not decide (a route's
HTTP answer, a UI surface, a fact reader) names that part in `matrix-coverage.ts`; the host's
own tests carry it.

Slice A part 1 coverage of the live path: S1 (both arms), S2, S3, S4, S5, S7, S8, S25,
the cutover and the kill switch run end to end on real Postgres in
`apps/web/tests/db/workflow-seam.test.ts` (`bun run test:db`). Part 2 adds, in
`apps/web/tests/db/workflow-matrix.test.ts`: S9 (owner and CI fix reaped), S23 (CI
provenance by SHA set, the cap, an old-SHA failure, `BudgetExtended`), S25 for the CI
family (green at dispatch and at claim, head moved before dispatch), S28 (CI and review
families on one delivery), and the kernel transitions of S10, S12 and S15; the route wiring (the
legacy write does not run beside the kernel) in the route tests named above and in
`apps/web/src/app/api/github/webhook/route.test.ts`, `.../github/pr/review/route.test.ts`,
`.../prs/[prNumber]/re-review/route.test.ts` and `apps/web/src/lib/reviewer.test.ts`.

Slice B part 1 adds S6 on the live path: the merge reaches every worker row through
`stamp_pr_rows`, late open-state and CI facts leave the rows as the merge set them, and
an old-SHA CI failure neither moves the delivery nor the fact cache
(`apps/web/tests/db/workflow-matrix.test.ts`); every (status, fact) ordering of the
funnel runs on real Postgres in `apps/web/tests/db/pr-facts.test.ts`.

Slice C adds S10, S15 and S20 on the live path: the four merge doors call
`landThroughKernel`, which lands through T15 → one pinned merge call → T16 →
`verify_merge` → T17 and runs the post-merge effects (S10, including an indeterminate
answer verified before anything re-calls, a double door, and a person's override
after a refusal); a merge refused as behind is refreshed by `refresh_branch` pinned to
its head, and a conflict from update-branch becomes an agent attempt (S15); a stale
version is refused with the current view and applies nothing (S20)
(`apps/web/tests/db/workflow-matrix.test.ts`). Each door's wiring and the routes' HTTP
409 are in `apps/web/src/lib/pr-landing.test.ts`, `apps/web/src/lib/auto-merge.test.ts`,
`apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts`,
`apps/web/src/app/api/github/pr/route.test.ts` and the webhook route test.

Slice D adds S12, S16, S18 and S21 on the live path, through the real writers
(`recordPrSupersession`, `recordPrAbandonment`) and the real detector with GitHub
faked: T20 by the caller after a lost close is caught up, refused on an open PR and
on an overwrite, projected onto every row; the completion gate reading `MERGED`
before its stamp, `CLOSED_UNMERGED`, `ABANDONED` and a legacy PR's columns; a deleted
integration branch closing the PR as `base_deleted` and the scan recording T20; the
caller's own task deciding §17.1 (`apps/web/tests/db/workflow-matrix.test.ts`). The
route-level authorization matrix is in `apps/web/src/app/api/github/pr/supersede/route.test.ts`
and `apps/web/src/app/api/github/pr/review/route.test.ts`, the gate's reading of the
delivery in `apps/web/src/lib/mission-completion.test.ts` and
`packages/core/__tests__/pr-shipped.test.ts`. Slice B part 3 then made the trunk breaker
(S24) a live case, which left the matrix with no todo.

Integration: retired in Slice F (§13.10). A live S1 case needs a real reviewer verdict and a
fix worker that commits but does not push, against a deployment that runs the kernel. The
integration harness can drive neither deterministically, so the placeholder was a
`test.todo` that could never pass. S1 is covered end to end on real Postgres (both arms) and
by the workers route test.

---

## 17. Compatibility and risk

### 17.1 Authorization

- The kernel adds **no new capability**: T-commands call the same permission checks
  the routes use today (`agentRunMayActOnPr` / `taskLinksPr` in
  `apps/web/src/lib/agent-capabilities/pr-links.ts`, `taskScopeAllowsWorkerPr`,
  team permission registry). The authorisation decision stays in the route; the kernel
  receives `actor` and records it.
- PR #3754 (supersede route) is the live proof that "own PR only" and "caller's task
  links the PR" are different rules: the check MUST be on the **caller's** task. T20's
  actor rules: (a) the owner task's own token; (b) a task token whose own task's records
  link the PR (`taskLinksPr(callerTask, pr)`); (c) a human with the team permission; (d)
  the automatic detector after verification. A task token never gains `SupersessionRecorded`
  for a PR merely because the *owner's* task links it.
- A task's records link a PR through its retry column (`ciRetryPrNumber`,
  `conflictRetryPrNumber`, `reviewerRetryPrNumber`), a person's landing grant, or the
  PR link stamped when it was filed (`context.prReach`, `apps/web/src/lib/pr-reach-grant.ts`):
  a person's filing links the PRs it names; an agent run's filing links only PRs its own
  task already reaches. A PR named only in a task's title, description or context links
  nothing.
- Version-carrying human actions are authorised before the CAS, never after, so a
  `stale` response cannot be used as an oracle for deliveries the caller cannot read.
- `workflow_*` rows are workspace-scoped like every table; effect handlers act with
  the workspace's GitHub installation, not the caller's token.

### 17.2 Merge-policy safety rails

- The kernel **never lowers a rail.** `LandingRequested` calls the existing rail set
  unchanged (`evaluateAutoMergeSafety`, migration inspector, deny paths, size cap,
  base freshness, surface ordering, review-verdict gate, `guardMissionPrMerge`,
  `resolvePolicy`). `human` and `agent-review` tiers keep their refusals.
- The CI rail is an allow-list and fails closed (`apps/web/src/lib/ci-verdict.ts`,
  shared with the kernel's GitHub reader so the two cannot drift). CI is green on a
  head only when every check run, read across every page (`per_page=100` until
  GitHub's `total_count` is covered), is `completed` with conclusion `success`,
  `neutral` or `skipped`, and every commit status (the Statuses API, for CI that
  posts no check runs) is `success`. Any other conclusion (`timed_out`,
  `cancelled`, `startup_failure`, `action_required`, `stale`, none), any unfinished
  run (`queued`, `in_progress`, `waiting`, `requested`, `pending`), any `failure`,
  `error` or `pending` status, and any read that comes back short or fails, refuses
  the landing. Re-runs are judged by the latest run per check name, so a failed run
  superseded by a green re-run does not block. Only `failure`, `timed_out` and
  `startup_failure` are red enough to file a CI fix; the rest wait.
- `HumanApproved` makes the delivery `APPROVED` for manual merge; it never satisfies
  an unattended merge for a policy-protected path (matches the Home task that landed
  as #3751).
- Red CI and deny paths stay non-overridable; the dashboard overrides (`verdict`,
  `size`, `freshness`) keep working only from T15's override door and are written to
  `bypass`, which the ledger already counts.
- `release-executor.ts` merges (two direct `PUT .../merge` calls that skip
  `mergePullRequest` and every rail) were out of scope for the kernel's first
  slices (§17.6). §13.13 rule 6 brings them into scope **for the review gate
  only**: they keep their release semantics, but no door may merge over an open
  finding. Implementation pending (doors D8–D10).
- `landing.mode` (`off|shadow|enforce`) keeps its meaning; `shadow` still computes and
  records without acting. The kernel flag is separate (`workflowKernel`).
- Merge idempotency: the `sha` pin is the only merge-side idempotency GitHub gives;
  the kernel adds the `LANDING` state and `merge:{repo}#{pr}:{head}` key so a retry
  after `indeterminate` verifies before re-calling.

### 17.3 Mission completion

- `canCompleteMission` (`lib/mission-completion.ts`) and `deriveMissionHealth` keep
  their rules and tests. The awaiting-merge gate reads `prShipState` over latest-worker
  columns; since Slice D it is fed the delivery (`MERGED`→merged, `SUPERSEDED`,
  `ABANDONED`, `CLOSED_UNMERGED`/others → unshipped) overlaid on the same row
  (`withDeliveryShip`), so the gate's rules are unchanged (§13.8).
- The deliberate strictness (closed unmerged does not count as shipped) is
  preserved: `CLOSED_UNMERGED` blocks; only `SUPERSEDED` (verified) or `ABANDONED`
  (human) unblock.
- `all_prs_merged` criterion and the integration-branch/`mission PR` rules stay;
  `completeMissionIfVerified` keeps its atomic `WHERE status='active'` claim and its
  ~14 callers. The kernel adds one trigger: `MERGED` of a mission PR enqueues
  `wake_mission`, replacing the in-request `emit()` that today can be lost.
- The mission-branch deletion after ship (`finalizeMissionPrMerge`) becomes an
  effect, so a mission PR merged by hand on GitHub gets it too.
- Human `PATCH /api/missions/[id]` status writes bypass `canCompleteMission` on
  purpose; unchanged.

### 17.4 Completion-gate compatibility

The output-requirement gate (`pr_required`, `artifact_required`, `auto`, `none`) has
documented holes (G1–G9 in §18.1). Slice A closes only the fix/repair-attempt hole
(`delivery_not_advanced`). Closing G1–G3 for owner attempts (a `prUrl` or a branch PR
accepted without a head compare) was planned for Slice D and is not in it (§13.8
deviation 7), because it changes what plain builders see; until it ships those gates
are unchanged and the kernel only *records* the mismatch as a fact
(`local_head_reported` vs live head) for the activity timeline.

### 17.5 UI projections

- Stage chips, Home "Needs You", task detail, mission strip, explain, chat dock and
  `get_pr`/`list_prs` each re-derived state (§18.2). Since part 3, Home, the task
  header, the worker banner and the mission failure reading consume `DeliveryView`
  for kernel-owned deliveries (§13.2); since Slice E the task card, tasks list,
  mission board, strip and feed, the task page's PR surfaces, explain and the
  chat tile, dock and PR object do too (§13.9). `get_pr`/`list_prs` and the
  mission drawer remain (§13.9 deviations 2 and 4). Visible differences to expect and to review: a task whose fix did not
  push now shows `AWAITING_PUSH`/needs-you instead of "in review"; the activity comment
  header comes from the last transition, so "Re-reviewing" appears only with a real
  round; chat "Landed" is no longer `mergedAt || status==='completed'`.
- Pusher: today no PR event exists and several writers emit nothing. `projectDelivery`
  emits one workspace event per applied transition, which is additive.
- Copy and mobile layout follow `docs/design/design-system.md`; every changed surface
  needs phone- and desktop-width screenshots (`/visual-review`).

### 17.6 Intentionally out of scope

Release PRs and `release-executor.ts`, except the review gate every merge door
must ask (§13.13 rule 6); `missions.status` authority; task claim gates
and dependency resolution (`task-dependencies.ts` keeps its rules; it reads the
projection); credentials; dispatch outbox (separate table, same pattern); Linear/issue
webhooks; knowledge ingestion; CI log retrieval; agent prompts.

### 17.7 Risks

| Risk | Mitigation |
|---|---|
| Live read on every fact adds GitHub calls and latency to webhooks | reducer reads only when the fact is not provably a duplicate (`fact_key` hit short-circuits); reads reuse installation tokens; sweeps already read the same endpoints |
| GitHub rate limits during bursts | importers are batch-capped as today; effects back off; `stale` is a valid outcome, not an error |
| Backfill misclassifies an in-flight PR | import is from live GitHub read + decided reviewer task at the live head only; anything ambiguous imports as `AWAITING_REVIEW` (the safe re-review), never `APPROVED` |
| Per-workspace flag leaves two behaviours in production | by design the two never share a family for one workspace; the write-site guard test reports sites that write guarded columns outside the kernel when the flag is on |
| Over-strict gate blocks a worker that legitimately pushed to a different head (rebase) | proof allows ancestry or content-equivalence evidence; `rejected` carries the observed heads so the worker can answer |
| Effect storms on a bug | per-delivery effect cap and the existing 8-attempt dead letter; `critical` kinds escalate once |
| `workflow_effects` growth | prune `done`/`dead` after 14 days like `pruneDispatchOutbox`; `workflow_transitions` kept (audit) with a documented retention decision before launch |
| Path claims assumed to prevent interleaving | §7.7: correctness never depends on them; degraded enforcement is a known state, not a precondition |
| Trunk breaker hides a genuinely broken PR behind a signature match | a PR is `BLOCKED_ON_TRUNK` only while trunk itself fails the same signature; on `TrunkRecovered` the PR's own CI re-runs and a remaining failure is its own `ci` attempt; one trunk-fix attempt per incident bounds the cost; the base-red rule is on by default and a workspace turns the breaker off with `gitConfig.trunkBreaker = false` |
| Provenance by SHA set misattributes a push | allocation is consumption (§5.7 rule 1), so misattribution can only mislabel an outcome (`delivered` vs `unproven`), never lift the cap |
| Mechanical renumber or update-branch pushes onto a PR a person or bot owns | dependency-bot and human-owned PRs are excluded by the existing `isDependencyBotPrContext` rule; every mechanical push is an effect with a recorded `expected_head` and counts as a push door that other doors must check |
| Regenerating the comment on every transition costs GitHub calls | renders coalesce per delivery; a burst of transitions yields one render per quiescent point |
| Schema collision with concurrent migrations | follow `.claude/skills/schema-change/`; compare the index against `origin/dev` right before push |

---

## 18. Inventory: every lifecycle writer and reader found

The writer and reader inventory (§18.1 to §18.6) now lives in the knowledge base as `knowledge-base: buildd/reports/workflow-state-kernel-history.md`; the live debt list is §9 of the Workflow kernel spec (fa62b865, `workflow-kernel-library.md`).

## 19. Acceptance criteria

- AC-1: GIVEN a delivery in `FIXING` bound to `(H1, r1, a1)` WHEN the attempt ends `success` and the live GitHub head is still `H1` THEN the transition to `AWAITING_REVIEW` is rejected, the delivery ends in `AWAITING_PUSH`, a `push_recovery` effect exists, and no review round is created.
- AC-2: GIVEN a decided round 1 at head `H1` WHEN a review is requested again for `H1` without a human `force` THEN the command is `rejected(head_already_reviewed)`.
- AC-3: GIVEN `APPROVED` at `H0` WHEN the live head becomes `H1` and neither content-equivalence nor an own-refresh match holds THEN the delivery is `AWAITING_REVIEW` with a round bound to `H1` created in the same statement: `delta` when §8.3a's delta-approval rule holds for the read delta, `full` otherwise (an unread delta included).
- AC-4: GIVEN two writers apply a transition at the same `version` THEN exactly one is `applied` and the other is `stale` carrying the current state, version, head and round.
- AC-5: GIVEN a reviewer verdict whose round head differs from `current_head_sha` THEN the verdict is stored, no GitHub review is posted for it, no merge starts, and the state is unchanged.
- AC-6: GIVEN any transition THEN its follow-up effect rows exist if and only if the transition committed.
- AC-7 (amended by `workflow-kernel-library.md` §1 and §2: the guarded path also covers the kernel package): GIVEN a reconciler run THEN no `workflow_deliveries.state` or guarded column is written outside `apps/web/src/lib/workflow/` (checked by the write-site guard test).
- AC-8: GIVEN `PrMerged` WHEN any later `synchronize`, `check_suite` or `opened` fact arrives THEN the delivery stays `MERGED` and no fact-cache column regresses.
- AC-9: GIVEN `SupersessionRecorded` for a delivery not in `CLOSED_UNMERGED`, or whose target PR is not merged THEN it is rejected, and an existing edge is never overwritten.
- AC-10: GIVEN a task with a delivery WHEN the reaper or cleanup finds its worker dead with only local commits THEN `tasks.status` is not set to `completed`, and the delivery is `AWAITING_PUSH`.
- AC-11: GIVEN `workflowKernel=false` THEN no new delivery opens, an existing one is released to legacy and stays there, and a PR with no delivery behaves exactly as before the kernel. AND no effect queued before the switch merges, refreshes, renumbers or pushes for it, no sweep applies a transition to it, and a PR it released before its first review round gets legacy's first review (§14).
- AC-12: GIVEN `canCompleteMission` inputs from before the change THEN its results are unchanged.
- AC-13: GIVEN a worker pushes a CI fix under any git author identity WHEN the head advances during or just after its attempt THEN the push is attributed to that attempt by SHA set and the `ci` ledger row exists with `attempt_no` allocated at dispatch.
- AC-14: GIVEN a ledger family with `max_attempts` reached WHEN another dispatch is requested THEN no task is created and the delivery is `ESCALATED(ci_exhausted)` (or the family's equivalent); a human retry records `BudgetExtended` and is never numbered 0.
- AC-15: GIVEN an open trunk incident for a signature WHEN CI on any delivery fails with that signature THEN no per-PR `ci` attempt is dispatched, the delivery is `BLOCKED_ON_TRUNK`, and exactly one trunk-fix attempt exists for the incident; a second incident on the same base while the first one's fix is open files no second trunk-fix task.
- AC-16: GIVEN a dispatched fix, CI or conflict task whose target is merged, approved at the current head, green, or no longer conflicting at dispatch or claim time THEN the ledger row is `skipped`, no worker failure is recorded, and replay changes nothing.
- AC-17: GIVEN concurrent `render_activity` runs THEN the comment converges to a render of the latest delivery version, `Merged` is the headline of a merged delivery whatever is appended later, and exactly one comment exists.
- AC-18: GIVEN a behind-only branch or a byte-identical migration renumber THEN it completes as a mechanical attempt with no agent task and consumes no agent budget; GIVEN a textual conflict or a non-identical renumber THEN an agent attempt is allocated.
- AC-19: GIVEN a reviewer ends with prose and no structured verdict THEN the round is `failed` (T27), never approved, and the delivery is `ESCALATED(review_unavailable)` once the bounded retry is spent.

§13.13 criteria, review composition (rule 1):

- AC-20 (composition reuse): GIVEN an integration PR whose every constituent's latest decided round at its merged head is `approve` and the composition is `tree_equal` with no novel delta WHEN review is requested THEN the delivery is `APPROVED` with `approval_basis = composition` and no reviewer task is created.
- AC-21 (novel delta only): GIVEN the same PR with a novel delta on paths P THEN exactly one `delta` round is created and its scope is P.
- AC-22 (unknown composition is not approval): GIVEN a composition `unverifiable`, or a constituent with no decided round, THEN the delivery is not `APPROVED` and a full-scope round is queued.
- AC-23 (superseded constituent approval): GIVEN a constituent whose approve round at head H was followed by a request-changes round at H THEN the attestation is `rejected` and the composed PR is not `APPROVED`.

§13.13 criteria AC-24 to AC-37 (findings, repair builders, landing at every door, the
GitHub status, projections, external merges) now live in the native spec "Workflow
kernel" (fa62b865, `workflow-kernel-library.md`), which states them against what shipped:

| Old criterion here (number) | Now in fa62b865 |
|---|---|
| 24, findings survive | AC-18, AC-13 |
| 25, explicit resolution | AC-37 |
| 26, repair is a builder | AC-35 |
| 27, zero diff keeps the blocker | AC-19 |
| 28, refresh is not a fix | AC-36 |
| 29, verified no-op | AC-38 |
| 30, every door asks | AC-13 |
| 31, recheck at execution | AC-31 |
| 32, no rule overrides a finding | AC-32 |
| 33, admin force does not pass a finding | AC-33 |
| 34, COMMENTED is never approval | AC-34 |
| 35, verdict visible to GitHub | AC-13 (`buildd/landing`) |
| 36, projections from canonical state | AC-24 |
| 37, external merge with open findings | AC-15 |

## 20. Open questions

1. **Retry budget unit.** Lean: count review *rounds* (`max_rounds`) and keep the default 3. Alternative is to keep counting fix cycles (`iteration`); rounds is the quantity the loop actually bounds and the one the #2574 fix inherited by accident.
2. **Should `AWAITING_PUSH` be visible as its own Home "Needs You" item or only after recovery is exhausted?** Lean: only `ESCALATED(push_undeliverable)` interrupts a person; `AWAITING_PUSH` shows as machine-owned with a visible owner.
3. **Fork PRs.** `head.repo != repo` is refused at `PrBound` today for webhook registration. Lean: keep refusing; a fork PR is adopted only by an explicit human action and carries `policy_human`.
4. **Retention of `workflow_transitions`.** Lean: keep indefinitely with a monthly partition decision after launch; it replaces the 12-entry activity comment log and the explain `history[]`.
5. **Whether `landPr` becomes the kernel's `LandingRequested` executor or stays beside it.** Lean: keep `landPr` as the executor (its rails and metrics are tested), so Slice C moves who records the outcome, not what is decided.
6. **A delivery per mission PR.** Mission integration PRs have owner rows and different rules (`guardMissionPrMerge`). Lean: model them as deliveries with `kind='mission_pr'` in Slice C, not Slice A.

7. **Trunk-breaker thresholds** (how many deliveries, what window) and whether the base-branch-red condition alone is sufficient. Lean: base-red alone opens the incident; the multi-PR rule covers trunks whose CI does not run on the base branch.
8. **Where preflight commands are configured.** Lean: `gitConfig.preflight` per workspace with an empty default, plus the shared no-production-data function wired into `create_pr` unconditionally for this repo.
9. **Mechanical renumber executor.** A server-side commit through the GitHub contents/trees API versus a short-lived runner job. Lean: the API path for the byte-identical case; anything needing `bun db:generate` stays an agent attempt.
10. **How long a foreign push keeps a PR in `BLOCKED_ON_TRUNK` or `REPAIRING`.** Lean: a foreign head always re-enters the normal head rules (§6.4), which re-evaluate from live facts.

## 21. Non-goals

- No reviewer prompt, model, confidence-threshold or policy-tier change.
- No change to what `landPr` or `evaluateAutoMergeSafety` decide.
- No new UI in Phase 1 or Slice A; Slice E changes presentation only.
- No replacement of `task_dispatch_outbox`, `gate_events` or the cron framework.
- No global migration-slot reservation: it would remove the collision class at the source and belongs in its own contract; the kernel only makes renumbering mechanical and visible.
- No restoration of path-claim leasing, and no dependency on it (§7.7).
- No fix for runner provisioning noise (shared git config locking) or reviewer prompt quality; the kernel only treats their outputs as facts (§6.6).
- No attempt to prove a worker's code correct; the kernel proves only that the work it names is on GitHub and reviewed at that head.

## 22. Code surface

- Existing, to be migrated or wrapped: `apps/web/src/app/api/workers/[id]/route.ts`, `apps/web/src/app/api/github/webhook/route.ts`, `apps/web/src/app/api/github/pr/route.ts`, `apps/web/src/app/api/github/pr/review/route.ts`, `apps/web/src/app/api/github/pr/supersede/route.ts`, `apps/web/src/lib/pr-landing.ts`, `apps/web/src/lib/auto-merge.ts`, `apps/web/src/lib/pr-review-status.ts`, `apps/web/src/lib/review-verdict-gate.ts`, `apps/web/src/lib/reviewer.ts`, `apps/web/src/lib/pr-activity-comment.ts`, `apps/web/src/lib/pr-presentation.ts`, `apps/web/src/lib/mission-completion.ts`, `packages/core/pr-shipped.ts`, `packages/core/db/schema.ts`.
- PR recovery (§13.11): `packages/core/repair-target.ts`, `apps/runner/src/worktree-utils.ts`, `apps/runner/src/git-operations.ts`, `apps/web/src/lib/repair-completion.ts`, `apps/web/src/lib/landing-blocker.ts`, `apps/web/src/lib/pr-predecessors.ts`, `apps/web/src/lib/retry-pr-supersession.ts`, `apps/web/src/lib/attempt-lineage.ts`.
- Review findings and landing authority (§13.13): `apps/web/src/lib/review-verdict-gate.ts`, `apps/web/src/lib/review-subscribers.ts`, `apps/web/src/lib/workflow/review-composition.ts`, `apps/web/src/lib/workflow/review-effects.ts`, `apps/web/src/lib/workflow/pr-landing-effects.ts`, `apps/web/src/lib/workflow/landing.ts`, `apps/web/src/lib/release-executor.ts`, `apps/web/src/lib/release/compose-runtime.ts`, `packages/core/release-compose.ts`, `packages/core/escalation-gate.ts`, `apps/web/src/lib/mission-pr.ts`.
- Pattern sources: `packages/core/dispatch-outbox.ts`, `apps/web/src/lib/dispatch-authority.ts`, `packages/core/gate-events.ts`.
- Wired in Slice A part 1: `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/prs/[prNumber]/re-review/route.ts`, `apps/web/src/app/api/cron/pr-reconcile/route.ts`, `apps/web/src/lib/reviewer-subscribers.ts`.
- New (Phase 2): `apps/web/src/lib/workflow/*` (the route seam is `seam.ts`; landing is `landing.ts` and `pr-landing-effects.ts`; a closed PR's resolution is `supersession-effects.ts`; mission completion's input is `delivery-ship.ts`), `apps/web/src/lib/pr-merged-work.ts`, `packages/core/__tests__/workflow-write-sites.test.ts`, `apps/web/tests/db/workflow-seam.test.ts`.

## 23. Out of scope

See §17.6 and §21.
