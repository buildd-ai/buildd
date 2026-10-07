---
title: Workflow State Kernel
status: draft
owner: max
last_verified: 2026-10-07
summary: One kernel MUST own each task-to-PR-to-review-to-merge delivery's state, advance it only by version-checked transitions citing GitHub-confirmed evidence, and leave other lifecycle columns fact caches or projections.
domain: tasks
surfaces: [apps/web/src/app/api/workers/[id]/route.ts, apps/web/src/app/api/github/webhook/route.ts, apps/web/src/lib/pr-landing.ts, apps/web/src/lib/workflow/landing.ts]
related: [mission-task-lifecycle, pr-lifecycle-reconciliation, task-dispatch-authority, surface-merge-ordering]
keywords: [workflow kernel, delivery state, AWAITING_PUSH, review round, head sha binding, outbox, CAS, fix_ended, stale verdict, write sites]
verified_by: [apps/web/tests/db/pr-facts.test.ts, packages/core/__tests__/pr-fact-write-sites.test.ts, apps/web/src/lib/workflow/pr-fact-effects.test.ts, apps/web/src/lib/pr-fact-import.test.ts, apps/web/src/lib/workflow/projections.test.ts, apps/web/src/lib/workflow/review-composition.test.ts, apps/web/src/lib/workflow/pr-activity-render.test.ts, apps/web/src/lib/action-queue.delivery-view.test.ts, apps/web/src/lib/workflow/reducer.test.ts, apps/web/src/lib/workflow/review-effects.test.ts, apps/web/src/lib/workflow/pr-landing-effects.test.ts, apps/web/src/lib/pr-landing.test.ts, apps/web/src/lib/auto-merge.test.ts, apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts, apps/web/src/app/api/github/pr/route.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts, apps/web/src/app/api/workers/claim/route.test.ts, apps/web/src/app/api/prs/[prNumber]/retry-ci/route.test.ts, apps/web/src/lib/ci-failure-retry.wake.test.ts, apps/web/tests/db/workflow-matrix.test.ts, packages/core/__tests__/pr-shipped.test.ts, apps/web/src/lib/mission-completion.test.ts, apps/web/src/lib/pr-supersession.test.ts, apps/web/src/app/api/github/pr/supersede/route.test.ts, apps/web/src/app/api/github/pr/review/route.test.ts, apps/web/src/lib/workflow/facts.test.ts, apps/web/src/lib/workflow/github-facts.test.ts, apps/web/src/modules.test.ts, apps/web/src/lib/workflow/conflict-retry-effects.test.ts, apps/web/src/lib/conflict-retry.test.ts, apps/web/src/lib/workflow/trunk.test.ts, apps/web/src/lib/workflow/delivery-display.test.ts, apps/web/src/lib/explain-because.test.ts, apps/web/src/lib/explain.test.ts, apps/web/src/lib/pr-presentation.test.ts, apps/web/src/lib/pr-list.test.ts, apps/web/src/app/api/tasks/[id]/summary/route.test.ts, packages/core/__tests__/workflow-write-sites.test.ts]
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
maps are deleted (§13.9). §13.1–§13.9 list what landed and the deviations; §14
the cutover and the kill switch.

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
| `ESCALATED` | A person must act; attribute `reason` ∈ `review_escalated`, `review_exhausted`, `review_unavailable` (no valid verdict after the bounded contract retry), `ci_exhausted`, `conflict_exhausted`, `push_undeliverable`, `landing_needs_human`, `policy_human`, `unsafe_to_merge` | human | explicit transitions only |
| `MERGED` | GitHub confirmed the PR merged (terminal) | none | `PrMerged` |
| `CLOSED_UNMERGED` | GitHub confirmed the PR closed without merging; attribute `close_cause` (`manual`, `base_deleted`, `superseded_by_policy`, `unknown`) | platform (supersession scan), then human | `PrClosedUnmerged` |
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
`tasks_one_pending_review_per_head_unique`).

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
2. **Infra requeues are not attempts.** A task requeued by the reaper, a budget wall,
   a mount gap or a provider failover keeps its own `infraRetryCount`/`retryCount`
   (today's behaviour, correct) and never touches a ledger; conversely an attempt row
   is never created for it. A retry that opens a fresh task for the same family always
   allocates a new `attempt_no` instead of inheriting `context.iteration`.
3. **No shared key.** `context.iteration` stops being read for decisions; a reviewer
   task spawned on a CI-fix task does not inherit the CI count.
4. **One 1-based view.** `attemptView(delivery, family) → {n, m}` is the only
   source for "attempt N of M" in the activity comment, task titles, Home chips and
   `explain`. Today the comment shows the raw 0-based value while the title shows value
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

The reducer (`CompositionAttested`, from `AWAITING_REVIEW`, head must be current) checks
each constituent against the ledger. The cited round belongs to that constituent's own
delivery, PR and repo. It is decided `approve` at exactly `reviewed_head_sha`.
`merged_head_sha` is that head or a recorded equivalent. The two patch-ids are present
and equal. With `none` the delivery becomes `APPROVED` with `approval_basis =
composition` and the head in `composition_heads`; `approved_heads` is untouched and no
round is decided at the aggregate head. With `present` a `delta` round scoped to the
novel paths is queued. An approve of that delta round (S33) keeps `approval_basis =
composition`, adds the head to `composition_heads` only, and records the delta round id
in the transition evidence. Its GitHub review and the headline ("Release-only changes
approved") say it covers the novel paths only. `unverifiable` or any failed check claims
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
| T3 | `HeadObserved(H')` fact | any non-terminal | live read confirms `H'` is the PR's current head | per §6.4 | per §6.4 | `head:{repo}#{pr}:{H'}` | webhook payload head ≠ live head → apply the live head; a late event whose live head equals stored head is `duplicate` |
| T4 | `AttemptEnded(a, outcome, L)` (worker PATCH terminal, reaper) | `WORKING`, `FIXING`, `REPAIRING` | attempt `a` is the delivery's bound attempt (else `stale`); `L`, `commitCount` recorded as fact | see §6.5 | project `tasks`/`workers` rows; `announce_fix_ended` only for outcomes below | `end:{a}` | an exit for a non-bound attempt is recorded and returns `stale` |
| T5 | `ReviewRequested(head, forced?)` (webhook `opened`, push, `request_pr_review`, re-review route, stale-approval) | `WORKING`(PR bound), `AWAITING_REVIEW`, `CHANGES_REQUESTED`, `APPROVED`, `ESCALATED` | `head == current_head_sha` (live read); no round with status `queued`/`reviewing` for `(head)`; `forced` needs a human or `force` actor and is recorded in `bypass` | `AWAITING_REVIEW`, round `r+1` queued bound to `head` | `dispatch_review(round)`; announce `review_queued` | `round:{delivery}:{head}:{r+1}` | a request naming a head ≠ current is `rejected(round_head_not_current)`; a request for a head that already has a decided round is `rejected(head_already_reviewed)` unless `forced` |
| T6 | `ReviewVerdictRecorded(round, verdict, headBound)` (reviewer completes) | `AWAITING_REVIEW` | `round.status ∈ {queued,reviewing}`; `headBound == round.head_sha`; server escalation rules (file list, confidence) applied to produce `effective_verdict` | `approve`→`APPROVED` (or `ESCALATED(review_escalated)` if the rules override); `request_changes`→`CHANGES_REQUESTED`; `escalate`→`ESCALATED(review_escalated)`; if `round.head_sha != current_head_sha` the verdict is stored and the round marked `superseded` with **no state change** | `post_review(commit_id=round.head_sha)`; `dispatch_fix(round)` when under budget else transition T7 instead; `supersede_open_fix_on_approve`; `announce_*`; mission note | `verdict:{round}` | stale head or round: `stale` (verdict kept for audit). Replaying the PATCH is `duplicate` (closes the "no already-handled marker" gap) |
| T7 | `ReviewBudgetExhausted` (inside T6/T11) | `CHANGES_REQUESTED`, `FIXING` | `current_round >= max_rounds` | `ESCALATED(review_exhausted)` | `escalate_exhaustion` (mission note + notify) | `exhaust:{delivery}:{head}` | resets only by a new head (T3) |
| T8 | `FixDispatched` (effect completion) | `CHANGES_REQUESTED` | **revalidation (§10.5) passed**: live read shows PR still open, head still the round's head, no newer approve; ledger row `review_fix` allocated (`attempt_no` = previous + 1, `≤ max_attempts`); fix task row created for `(round)`; unique per round | unchanged | link `tasks.delivery_id`, role `fix` | `fix:{delivery}:{round}` | a fix for a round that is no longer current is cancelled (`newer_verdict_supersedes_fix`) |
| T9 | `FixClaimed(a)` (claim route) | `CHANGES_REQUESTED` | `a` is the fix task of the current round; **claim-time revalidation** (§10.5): live read still shows the round's head current, PR open and not approved | `FIXING` bound to `(H, r, a)` | announce `fix_started` | `claim:{a}` | a claim for a fix of a superseded round, or one whose target was resolved meanwhile (merged, approved, head moved), is `rejected(fix_superseded)` / `rejected(fix_not_needed)`; the claim route cancels the task as `skipped` (not failed) and the ledger row becomes `skipped` |
| T10 | `CiFailedObserved(H', signature)` fact | `AWAITING_REVIEW`, `APPROVED`, `LANDING`, `CHANGES_REQUESTED` | `H' == current_head_sha`; live check-suite read; no open trunk incident matches `signature` (else T25); no `ci` attempt already `queued`/`running` for `H'` (a deferral is recorded with its reason, §12.1 `ci_failed`) | `REPAIRING(ci)` (from `CHANGES_REQUESTED` stays, ci attribute only) | `dispatch_ci_fix(head)` allocating a `ci` ledger row (§5.7) under budget, else `ESCALATED(ci_exhausted)`; always `render_activity` with the failure reason, whether or not a retry was dispatched | `ci:{delivery}:{H'}` | `H' != current` → recorded fact only; this is what stops an old-SHA failure overwriting a newer head |
| T11 | `RepairDelivered` = T3 from `REPAIRING` | `REPAIRING`, `AWAITING_PUSH` | §9 proof | `AWAITING_REVIEW` (new round) or `APPROVED` if §8.3 carry-forward holds | as T5 / T13 | via T3 key | as T3 |
| T12 | `ConflictObserved(H')` fact | as T10 | `H' == current`; `mergeable=dirty` or behind-base from a live read taken **now**, not a stored snapshot | `REPAIRING(conflict)` or `REPAIRING(behind)` with `repair_mode` per §6.7 | mechanical attempt first (`refresh_branch`, or `renumber_migration` for a collision); only on a mechanical refusal an `agent` ledger row and `dispatch_conflict_fix` | `conflict:{delivery}:{H'}` | as T10 |
| T13 | `CarryForwardEvaluated(H')` (inside T3 from `APPROVED`/`LANDING`) | `APPROVED`, `LANDING` | content-equivalence of `H'` against the approved head, or the head moved only by the platform's own refresh effect (matched by effect payload `expected_head`) | `APPROVED`, `approved_heads += H'` | none | `carry:{delivery}:{H'}` | not equivalent → T5 (round `r+1`, delta) from `APPROVED` |
| T14 | `HumanApproved(H')` (GitHub human review or dashboard approve on current head) | `ESCALATED`, `CHANGES_REQUESTED`, `AWAITING_REVIEW` | review `commit_id == current_head_sha`; actor holds merge permission | `APPROVED` with `approver=human` | notify; never enables unattended merge (§17.2) | `approve:{repo}#{pr}:{review}` | review on an older commit: recorded, `stale` |
| T15 | `LandingRequested(door)` (the five merge doors, sweep) | `APPROVED`; `AWAITING_REVIEW`/`CHANGES_REQUESTED`/`ESCALATED` only for a person's verdict override (§13.7 deviation 3) | live read: open, head == `current_head_sha`; `landPr` rails pass (CI, deny paths, size, migration inspector, freshness, surface order, review gate, mission-PR gate); override recorded in `bypass` and never covers red CI or deny paths | `LANDING` | `merge_call(head)` | `merge:{repo}#{pr}:{head}:v{version}` (§13.7 deviation 1) | head moved → `stale` and T3 path; a second door while `LANDING` at the head → `duplicate(landing_in_flight)` |
| T16 | `MergeCallResult` | `LANDING` | GitHub response | merged → T17 (not asserted here: the merged fact comes from a live read); `indeterminate` → stay, `verify_merge` effect; `not_merged` (the verify read shows the PR open and unmerged) → `APPROVED`; behind/out-of-date → `REPAIRING(behind)`; conflict → `REPAIRING(conflict)`; policy/other refusal → `ESCALATED(landing_needs_human)` | `refresh_branch` or alert | `mergeresult:{repo}#{pr}:{head}:{landing_version}:{outcome}` | result for a head that is no longer current: ignored (`stale`) |
| T17 | `PrMerged` fact | **any** non-terminal | live read `merged=true`; records GitHub `merged_at` and `merge_commit_sha` | `MERGED` | stamp `workers.mergedAt`/`prLifecycleStatus` on **all** rows of the PR; cancel open review/fix attempts; `task.pr_merged` emit; dependents, mission wake, release attribution, mission-branch deletion (`finalizeMissionPrMerge`); classify merged-over-verdict | `merged:{repo}#{pr}` | replay is `duplicate`; "merged" is never overwritten by a later fact |
| T18 | `PrClosedUnmerged` fact | any non-terminal | live read `state=closed`, `merged=false` | `CLOSED_UNMERGED(close_cause)` | cancel open attempts; `scan_supersession`; mission note; stamp all rows `closed` | `closed:{repo}#{pr}:{updated_at}` | a closed fact older than a later `PrReopened` loses to the live read |
| T19 | `PrReopened` | `CLOSED_UNMERGED` | live read `state=open` | `AWAITING_REVIEW` at the live head | `dispatch_review` | `reopen:{repo}#{pr}:{updated_at}` | none |
| T20 | `SupersessionRecorded(target)` | `CLOSED_UNMERGED` **only** | live read: target PR exists, `merged=true`, is a different PR; caller authorised (§17.1) | `SUPERSEDED` | project `workers.supersededBy*`; mission wake | `supersede:{repo}#{pr}` | not closed → `rejected(not_closed_unmerged)`; fixes today's ability to mark an open PR superseded and to overwrite an edge |
| T21 | `Abandon(reason)` | `CLOSED_UNMERGED` | human actor; reason non-empty | `ABANDONED` | project `workers.abandoned*` | `abandon:{repo}#{pr}` | not closed → `rejected` |
| T22 | `PushRecoveryExhausted` | `AWAITING_PUSH` | `push_recovery` effect hit its attempt cap | `ESCALATED(push_undeliverable)` | notify with branch and reported `L` | `pushdead:{delivery}:{L}` | a head observed meanwhile wins (T3) |
| T23 | `Escalate(reason)` / `HumanResolve(choice)` | `ESCALATED` | human actor; choice ∈ approve (T14), request changes (→ `CHANGES_REQUESTED`), apply recommendation (→ `FIXING` path, new attempt), dismiss with reason (→ `AWAITING_REVIEW` forced round) | per choice | per choice | `resolve:{delivery}:{version}` | resolves only the escalation at the version the human saw (§7) |
| T24 | `DeliveryFailed(reason)` (owner task terminal, no PR) | `WORKING`, `AWAITING_PUSH` | task `failed`/`cancelled`, retry budget spent, no PR bound | `FAILED` | none | `fail:{task}` | with a PR bound, T18/T22 apply instead |
| T25 | `TrunkRedObserved(signature)` (circuit breaker, §6.10) | `AWAITING_REVIEW`, `APPROVED`, `LANDING`, `REPAIRING(ci)` | the same `signature` is failing on the base branch's own head, **or** ≥ the configured count of deliveries in the workspace hit it inside the configured window; open or join the `trunk_incidents` row | `BLOCKED_ON_TRUNK` with `resume_state` = the source | one `dispatch_trunk_fix` per incident (never per PR); cancel queued per-PR `ci` attempts for affected deliveries as `skipped`; `render_activity` ("blocked on trunk") | `trunk:{incident}:{delivery}` | a fact for a head that is no longer current is recorded only |
| T26 | `TrunkRecovered(incident)` (base head green for the signature, or incident resolved by the trunk-fix PR merging) | `BLOCKED_ON_TRUNK` | live read: base branch's CI no longer fails the signature | `resume_state` re-entered at the current head; if that head predates the trunk fix, effect `refresh_branch` then re-run CI is the mechanical repair | none | `trunkok:{incident}:{delivery}` | a still-red re-read keeps the state; the budget of the `ci` family is **not** consumed while blocked |
| T27 | `ReviewRoundFailed(round, reason)` (no valid structured verdict, reviewer died, contract retry spent) | `AWAITING_REVIEW` | round exists and is `queued`/`reviewing`; `reason` ∈ `no_verdict`, `prose_verdict`, `infra` | stay `AWAITING_REVIEW` while the contract/infra retry budget allows (round re-queued at the same head, **not** a new round number), then `ESCALATED(review_unavailable)` | `dispatch_review` retry; `gate_events` row | `roundfail:{round}:{n}` | a prose verdict is a failure, never an approve; the existing prose fallback can only *propose* a verdict that a person confirms, it cannot apply T6 |

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
| `ESCALATED` | `duplicate` | `review_*` escalations at an older head: round `r+1`; other reasons: record only |
| terminal | ignored (recorded) | ignored (recorded) |

### 6.5 `AttemptEnded` by outcome

| State, outcome | Result |
|---|---|
| `WORKING`, success, PR bound and live head `H` contains `L` (or `L` is empty and the output requirement is satisfied by the PR) | `AWAITING_REVIEW`, round queued at `H` per T5 unless one is already open at `H` (§15 step 2). The owner attempt has ended, so `WORKING` (worker owns the next move, §4) would leave the delivery with no owner |
| as above, round already **decided** at `H` | the state that round's verdict maps to, exactly as T6: approve → `APPROVED`; request changes → `CHANGES_REQUESTED` with `dispatch_fix` unless a fix for that round is open (`ESCALATED(review_exhausted)` at the round budget); escalate → `ESCALATED(review_escalated)` |
| as above, the workspace policy requires no review (auto-threshold) | `APPROVED` with `approval_basis = policy`, `state_reason = policy_no_review`: no round, no verdict, `approved_heads` untouched, so it never reads as a reviewer verdict (§8). Policy covers only the current head; a later push stays `APPROVED` by policy. Landing is still gated by T15's rails |
| `WORKING`, success, PR required and `commitCount>0` but live head does not contain `L`, or no PR | `AWAITING_PUSH` with effect `push_recovery` |
| `WORKING`, `failed`/`lost`, retry budget left | stay `WORKING` (task retried, attempt count +1) |
| `WORKING`, `failed`/`lost`, budget spent, PR bound | `ESCALATED(push_undeliverable)` if `L` unproven; else, with the PR open, hand on exactly as row 1 (review round, decided verdict, or policy approval) |
| `WORKING`, `failed`/`lost`, budget spent, PR bound, no open PR head (closed, merged or unreadable) | `ESCALATED(push_undeliverable)`; a later `PrMerged`/`PrClosedUnmerged` still applies from `ESCALATED`. An ended owner attempt with no retry queued never leaves the delivery in `WORKING` |
| `WORKING`, `failed`/`lost`, budget spent, no PR | `FAILED` |
| `FIXING`/`REPAIRING`, success, proof holds | T3 path to `AWAITING_REVIEW` (new round) |
| `FIXING`/`REPAIRING`, success, no proof | `AWAITING_PUSH`; the attempt row stays `completed` as an execution fact; effect `push_recovery` |
| `FIXING`/`REPAIRING`, `failed`/`lost` | back to `CHANGES_REQUESTED`/`REPAIRING` with `fix_attempts+1`; re-dispatch, or T7/`ESCALATED` when the budget is spent |

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

**Circuit breaker.** CI failures are classified by `signature` at ingestion. The kernel
opens a trunk incident (T25) when the same signature (a) is failing on the base
branch's own head, or (b) is failing on at least a configured number of distinct
deliveries inside a configured window. While an incident is open: no per-PR `ci`
attempt is dispatched for that signature; queued ones are cancelled as `skipped`; one
`trunk` family attempt (`dispatch_trunk_fix`) exists per incident; affected deliveries
are `BLOCKED_ON_TRUNK`, visible on the comment and on Home as "blocked on trunk"
rather than "CI failing"; and the `ci` budget is not consumed. Time-dependent
("time-bomb") failures are the same case seen first on trunk. The base-red rule (a)
is ON by default with the kernel (owner decision: the kernel ships live; open
question 7's lean that base-red alone opens the incident); the multi-delivery rule
(b) is opt-in through `gitConfig.trunkBreaker = { minDeliveries, windowMinutes }`,
and `trunkBreaker: false` turns the breaker off (§13.5). The safety bound is one
trunk-fix task per incident, and a PR is blocked only while its every failing check
also fails on the base.

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
   migration 0231 (now in `packages/core/drizzle/0000_baseline.sql`) backs up.
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

### 8.3 Carry-forward is a transition

When the head moves under an `APPROVED` delivery, the kernel decides (T13) whether the
approval still describes what would merge. Evidence is either content-equivalence
(`isContentEquivalentHead`, `approval-carry-forward.ts`) or "the move was our own
`refresh_branch` effect" (head equals the `expected_head` stored in that effect's
payload and the content diff of the PR is unchanged). Both append to `approved_heads`
with the evidence recorded in `workflow_transitions.evidence`; the append is a CAS
write, which removes today's possible double append. When neither holds, a delta
round starts at once, on the push, not at the next merge attempt.

### 8.4 GitHub reviews

`post_review` is an effect that sets `commit_id` to `round.head_sha` and keeps today's
dedupe on `(commit_id, state)`. A human GitHub approval is a fact (`HumanApproved`)
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

**Surfaces this binds:**

- **Completion gate.** For attempts with role `fix`/`ci_fix`/`conflict_fix`, a terminal
  `completed` PATCH is refused with 400 `delivery_not_advanced` when the live head
  has not advanced, telling the worker to push. This sits beside the existing
  `pr_required` gate and closes G1–G3 of §17.4, which accept a `prUrl` or an open PR on
  the branch without comparing heads.
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
| `post_review` | submit GitHub review at `commit_id` | GitHub dedupe on `(commit_id, state)`; the effect checks the posted result and fails on `posted:false` unless the dedupe reason matched (`postPrReview` never throws) |
| `merge_call` | `PUT /pulls/{n}/merge` with `sha` pinned (`pr-landing-effects.ts`) | the pin makes a replay at the same head a no-op or a clean refusal; `indeterminate` triggers `verify_merge`; one per landing request (`merge_call:{delivery}:{head}:v{n}`) |
| `verify_merge` | read PR; `PrMerged` (T17) if merged, `MergeCallResult(not_merged)` if still open at the head | read-only |
| `refresh_branch` | update-branch, records `expected_head` | one in flight per head (existing 60s lease) |
| `push_recovery` | §9 | bounded tries; each try is a read-then-instruct |
| `stamp_pr_rows` | project columns on every worker row of the PR | `WHERE` guarded on `merged_at IS NULL` etc. |
| `renumber_migration` | mechanical migration index fix (§6.7) | computed from live trees; re-running on an already-renumbered head finds nothing to do |
| `dispatch_trunk_fix` | one trunk-fix task per incident | unique per `trunk_incidents` row |
| `render_activity` | regenerate the PR comment from canonical state (§12.1) | a pure function of `(delivery, transitions)`; convergent, coalesced per delivery |
| `notify` / `mission_note` / `wake_mission` / `release_attribution` / `finalize_mission_pr` | existing helpers | keyed by `(delivery, transition)`; helpers already dedupe by marker or note key |
| `scan_supersession` | existing detector | `supersessionScan` rescan gate |

### 10.3 Delivery and leases

Mirror `task_dispatch_outbox` (`packages/core/dispatch-outbox.ts`, `dispatch-authority.ts`):
claim due rows with `FOR UPDATE SKIP LOCKED` in one CTE, set `status='delivering'` and
`attempt_count+1`; a `delivering` row older than the lease (120s) is claimable again;
ack with `WHERE id AND status='delivering'`; failure returns the row to `pending` with
exponential backoff (15s doubling, cap 30m); at 8 attempts the row is `dead`, a
`gate_events` row is written (slug to be added to `GATE_SLUGS`, with the
`gate-slug-coverage` test and `docs/reports/gate-audit.md` row that requires) and, for
effects marked `critical` (`merge_call`, `push_recovery`, `post_review`), the kernel
applies `Escalate`. Delivery is **at least once**; handlers MUST be idempotent as in
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
| Effect permanently failing | `dead` + gate event | `critical` → `ESCALATED`; others alert only |
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
| `sweepClosedUnsupersededPrs` (`pr-supersession-detect.ts`) | `scan_supersession` effect; auto-record goes through T20 (Slice D: the close owes the effect; the hourly sweep stays as the backstop and its write is T20 too, §13.8) |
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
   the round it names is decided or superseded.
5. **Exactly one comment.** The effect finds comments by marker; if more than one exists
   it keeps the oldest, updates it, and minimises or deletes the rest.
6. **Always created.** `PrBound` enqueues a render regardless of who opened the PR
   (today `onlyIfPresent` leaves interactive-session PRs without any comment).
7. **One writer of "merged".** The merge routes, the webhook, sweeps and the landing
   path all reach `PrMerged` (T17); the render is the single path from that to text.

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

### 13.1 What Slice A part 1 shipped, and its deviations

Shipped live (part 1, the review family): schema linkage (§5.6, `authority`);
`seam.ts` (route API), `authority.ts` (kill switch and release), `github-facts.ts`
(live reads), `review-effects.ts` (effects, owned by the reviews module and wired through the composition root `workflowEffectHandlers()`); `openKernelDelivery` at the two legacy
first-review points (the PR `opened` policy after pre-flight and role resolution, and
create_pr's integration-branch review); T4 at the terminal worker PATCH; the
`delivery_not_advanced` gate; T6 in `handleReviewerOutcomeIfNeeded`; T9 at claim;
T3 on `synchronize` (with §8.3 carry-forward through `carryForwardApprovalIfUnchanged`,
which also projects `equivalentHeadShas` for the legacy landing gate); T17–T19 on
close/reopen; T5 for `request_pr_review` and the dashboard re-review; T27 for a
reviewer that ended without a verdict; the outbox floor drain on the `pr-reconcile`
full pass plus an inline drain after every applied transition.

Shipped live in part 2 (the CI family):

- **T10 doors.** `retryCiFailureForPr` (the `check_suite` webhook and the red-PR
  sweep) asks `observeCiFailure` first; for a kernel-owned PR the legacy decision
  does not run, and the kernel's answer is mapped onto the outcomes those doors
  already understand (`kernelCiOutcome`). The head is recorded from a live read
  first, so an old-SHA failure is `stale(head_not_current)`.
- **Ledger.** `ledgerBudget` is the one budget rule: every dispatched row spends one,
  except a `skipped` one (revalidation found nothing to do); the cap is the
  configured `maxCiRetries`, raised only by a `trigger=human` row. `attemptView`
  counts the same rows, so N of M is 1-based and identical in the title, the task
  context and the activity entry.
- **`dispatch_ci_fix`** (`ci-retry-effects.ts`, reviews module, composed into
  `workflowEffectHandlers()`) revalidates at dispatch (PR open, head still the bound
  head, CI not green now), then files the legacy-shaped CI fix or drift-diagnose task
  with `delivery_role = ci_fix`; its task id is the attempt id, so a re-run files
  nothing twice. CI exhaustion escalates through `escalateCiRedHead`.
- **Claim (T9 for `ci`).** `FixClaimed` on a `ci` attempt moves it to `running`; CI
  green at claim resumes the delivery and cancels the task as skipped.
  `RepairNotNeeded` is the dispatch-time equivalent.
- **Provenance (§6.9).** The runner's metric sync appends its local head to the
  attempt's `reported_shas` (`recordLocalHead`); `HeadObserved` attributes a head to
  the bound attempt when the SHA is reported, or the attempt is running and the head
  descends from its bound head (compare API). A head the running attempt cannot
  claim is a `foreignPush` (recorded, no row); one that arrives while the attempt is
  only queued skips that row and is handled by the normal head rules.
- **`BudgetExtended`.** A person's "Fix CI" past the cap allocates exactly one more
  attempt (`trigger=human`, numbered after the last, `bypass` records who and why);
  under the cap it is an ordinary T10 attempt with `trigger=human`. Never
  "iteration 0".
- **§8 / R1 in the CI family.** No CI decision reads `context.iteration` or
  `lastCommitSha` as the head; `buildCIRetryTask` takes `attemptsUsed` explicitly.
  `isBuilddWorkerCommit` and `fetchCommitAuthor` are deleted, and the legacy path
  (PRs opened before cutover) now counts every filed CI retry against the cap.
- **S9.** An owner attempt that ends `lost`/`failed` with commits and no reported
  head is not proof: `AWAITING_PUSH` with `push_recovery` (T22 after its tries). The
  cleanup route no longer promotes a kernel attempt's dead worker to `completed`.

Part 2 deviations:

9. **A running CI attempt blocks a new T10 at any head** (`fix_in_flight`), as the
   legacy in-flight rule did: the worker is still watching its checks. The sweep
   comes back after it ends.
10. **T10 from `AWAITING_REVIEW` leaves the open review round queued**; a verdict
    that lands while `REPAIRING` is stale and kept, and the repaired head starts a new
    round.
11. **The CI signature is a placeholder** (`ci_failed`) at ingestion; the failing
    step digest is read by the dispatch effect. The trunk breaker stays off.
12. **CI green means every check suite completed and none failed**; a running or
    empty suite set is never read as green, so revalidation fails toward doing the
    work.
13. **The owner `lost` case goes to `AWAITING_PUSH`, not straight to
    `ESCALATED(push_undeliverable)`** (§6.5): AC-10 asks for `AWAITING_PUSH`, and T22
    reaches a person after the bounded recovery.
14. **`SupersessionRecorded`'s idempotency key carries the target**, so a second,
    different target reaches the reducer and is refused `edge_exists` instead of
    answering `duplicate`.
15. **Landing, supersession and the treadmill are kernel transitions only.** S10,
    S12 and S15 run `LandingRequested`/`MergeCallResult`/`SupersessionRecorded` on real
    Postgres, and `conflictRepair` bounds base refreshes across heads
    (`DEFAULT_MAX_BEHIND_REFRESHES`, the treadmill default); the doors that would call
    them stay legacy until Slices B–D.
16. A queued mechanical attempt counts as live for attribution (the platform's own
    refresh is in flight from dispatch). The runner's `remoteHeadSha` /
    `unpushedCommits` payload is not added: provenance uses the reported local heads.

Deferred to part 3, which shipped them (§13.2): `DeliveryView` with one owner of the
next move, `render_activity` regenerating the comment from transitions (§12.1),
release composition, explain's `attemptView`, and S35/S37. The conflict and migration
families stay legacy (Slice B).

Deviations, each deliberate:

1. **Round 1 is queued when the owner attempt ends**, not when the PR opens
   (§6.5 row 1, §15 step 2). Opening a delivery dispatches nothing; a delivery opened
   after the owner attempt already ended (the webhook arrived late) applies T4 at once.
2. **Landing stays on the legacy doors.** An applied approve returns to the legacy
   approve tail (`landPr` / `tryAutoMergeWorkerPr`), which reads the reviewer task the
   round created. The kernel posts the GitHub review (`post_review`); the legacy post
   does not run. Slice C moves landing.
3. **The legacy activity comment stayed** in part 1 (`appendPrActivity` from the
   handlers). Part 3 replaced it for kernel-owned PRs (§13.2). Post-merge and
   supersession effects of T17/T18 are still acknowledged `legacy_owns`: the webhook
   runs them.
4. **`push_recovery` re-reads and bounds, it does not instruct.** Each try reads the PR;
   a new head goes through T3, otherwise the next try is enqueued (2m/10m/30m), then
   T22 notifies a person. The live worker is told to push by the completion gate's 400
   instead. Tries after the first ride the hourly floor drain.
5. **A pre-flight human escalation releases the delivery to legacy** (and opens none),
   so no kernel round is queued behind a human gate.
6. **`createReviewerTask` refuses a reviewer for a kernel-owned PR** unless the call is
   the round's own `dispatch_review`; every legacy door (re-dispatch on push, stale
   approval, integration review) is closed in one place.
7. The completion gate reuses the `output_requirement` gate slug with
   `detail.code = delivery_not_advanced`; no new slug.
8. `max_attempts` of a review fix is the delivery's `max_rounds`. A second attempt on
   the same head (the first failed) leaves `reviewerRetryHeadSha` empty: the ledger,
   not that unique index, dedupes it.
9. `workflow_attempts.task_id` has no foreign key (like `tasks.delivery_id`, §5.6).
   Allocation is consumption, so the dispatching statement names the fix task's id
   before `dispatch_fix` inserts that task; the FK the first migration carried rejected
   every allocation, so no fix task was ever filed. The live matrix caught it.


### 13.2 What Slice A part 3 shipped, and its deviations

Shipped live (kill switch only), for kernel-owned deliveries; a legacy-owned or
PR-less task is absent from every map below and keeps today's projection:

- **`DeliveryView`** (`lib/workflow/projections.ts`, pure; loaded in one statement
  per surface by `getDeliveryViewsForTasks` in `lib/workflow/delivery-view.ts`). One
  owner of the next move per §4 state (`worker`, `reviewer`, `platform`, `human`,
  `landing`, `trunk`, `none`); `needsYou` is true only for `human`. A headline and
  the evidence behind it (`detail`, from the delivery and its last transition), the
  ledger's `attempt N of M`, the current attempt, and every earlier attempt marked
  `superseded` for audit.
- **Home** (`buildActionQueue` option `deliveryViews`): the chip of a kernel-owned
  PR comes from `chipForDelivery`, applied after `resolveMergeChip`. Landing keeps the
  legacy merge chip, because the merge rails stay legacy until Slice C. A failed
  attempt of a delivery that is live or merged produces no FAILED card.
- **Task page**: the header pill reads the view; `RealTimeWorkerView` replaces the
  needs-input banner with a "Buildd is handling this" notice when the platform owns
  the next move.
- **Mission failure reading (S35)**: `kernelReplacedFailedTaskIds` marks a failed
  attempt of a live or shipped delivery as superseded, in `explain` and in the mission
  page's fallback (which now also applies the existing title/PR supersession rule it
  skipped).
- **Explain (S28)**: a task subject whose delivery is kernel-owned carries
  `delivery` (state, owner, headline, evidence) with `attemptLine`, the one
  family-labelled "CI 1 of 3 · review 1 of 3" line the comment and titles use.
- **`render_activity`** (`lib/workflow/pr-activity-render.ts`, `pr-activity-effects.ts`):
  the comment is rendered from the delivery row and every `workflow_transitions` row,
  with the headline from canonical state and a `buildd-render-version` marker. A
  render older than the marker is skipped, duplicate comments are reduced to the
  oldest, and a version that advanced during the write owes another render. For a
  kernel-owned PR, `appendPrActivity` no longer writes. It records the entry as an
  `activity_note` fact and enqueues a render. Kinds a transition owns are dropped from
  those notes; the rest (CI, lede corrections, human overrides) are kept until their
  families move.
- **Release composition (§5.9)** (`lib/workflow/review-composition.ts`): before
  `dispatch_review` dispatches a full round on a composition PR (a mission integration
  branch into trunk, or a release PR per `isReleaseBranchPr`), it builds a
  `patch_set_equal` attestation from the compare and per-commit reads, proving each
  constituent by patch-id against its reviewed head's own diff. Zero novel
  delta → `CompositionAttested` → `APPROVED` with `approval_basis = composition` and no
  reviewer. A novel delta → a delta round scoped to those paths, with the
  attestation in the reviewer's prompt. Unverifiable → the normal full review. CI
  still gates the aggregate through the unchanged landing rails. The headline reads
  "Release composition verified", or "Release-only changes approved" once a delta
  round approved the novel paths.
- **S37 conflict recovery** (`dispatchConflictRetry`, `classifyConflictFix`,
  `recoverStalledConflictFix` in `lib/conflict-retry.ts`): a live conflict fix is
  the canonical remediation. A pending one unclaimed for 30 minutes is re-dispatched,
  and a claimed one whose worker ended is requeued. A claimed one whose worker is only
  silent is stalled but left to the reaper. Recovery is a compare-and-set on
  `context.conflictRecovery`, so concurrent sweeps, webhooks and clicks apply it once,
  and no second fix task is filed. The view's CTA reads "Conflict fix stalled" with
  Run fix / Repair, "Resolving conflicts", or "Resolve conflicts" when none exists.

Deviations, each deliberate:

1. **The conflict family is still legacy (Slice B).** S37's recovery lives in the
   legacy conflict-retry path, keyed by the live fix task plus its recovery marker
   (the remediation family is implied by `conflict_retry_pr_number`). It is not a
   kernel effect, and `ConflictObserved` is still not wired; the view reads `mergeable`
   on the current head and the open conflict-fix row.
2. **Explain's state chain, the mission strip and the chat dock** still read their
   own projections (Slice E); explain only adds the `delivery` block. S17 covers
   Home, the task header and the mission failure reading. *Closed by Slice E
   (§13.9).*
3. **A fix worker's own question stays a question.** A worker-owned delivery whose
   worker is `waiting_input` keeps the needs-input banner. Only a platform-owned
   blocker is restated; generic `needs_input` is task 01b8a69d's.
4. **Composition constituents need kernel evidence.** A change reviewed on the
   legacy path is novel delta, so it gets the delta review rather than borrowing a
   verdict. A merge commit's novel delta is approximated as the files both sides
   changed. Release artifacts are recognised by the release automation's commit
   subjects plus a path allowlist (`package.json`, `CHANGELOG.md`, `bun.lock`).
5. **Chips stay in the existing vocabulary.** A kernel-owned card reuses
   `REVIEW_RUNNING`, `FIXING_REVIEW`, `FIXING_CI` and `RESOLVING`, and carries the
   headline as its reason line, so no card component changed.

### 13.3 What the S30/S31 runner signals shipped, and their deviations

S30 (§6.6). The runner reports a hand-off failure after work (an output-gate
refusal of its completion, or an unmet `pr_required`) as `failed` with
`outcome: 'unproven'`, `localHeadSha` and `commitCount`
(`apps/runner/src/hand-off-outcome.ts`). The worker PATCH maps that onto
`AttemptEnded(unproven)` (`apps/web/src/lib/workflow/hand-off.ts`). With commits the
result is `AWAITING_PUSH` plus `push_recovery`, even while the task's own retry is
queued. An owner with nothing local and a retry queued gets a recorded `WORKING`
requeue. An old runner omits the fields and gets today's `failed` mapping.

S31 (§6.10). Tier 1: on a workspace with `gitConfig.preflight.prProseScan`, `create_pr`
refuses a title or body that CI's prose scan would reject, and names the line and
category. Tier 2: the runner runs `gitConfig.preflight.commands` before a push or
`create_pr`, and a failing command denies that one call with its output. Tier 3: a
kernel CI failure is tagged `preflightMiss` on its T10 transition when it names a
preflight class (`gitConfig.preflight.ciChecks`, default the No Production Data
workflow).

Deviations:

1. **The prose rule is a port, not a shared function.** CI runs Python and the
   server cannot. `packages/core/no-prod-data-prose.ts` is the same count/UUID rule
   in TypeScript. A parity test runs both on one fixture set and fails on any
   disagreement. The identifier half needs CI's secret and stays CI-only.
2. **Preflight evidence is not stored on the delivery.** Tier 1 refusals and tier 2
   denials appear in the refusal and the runner milestone. Only tier 3's
   `preflightMiss` is a kernel record.

### 13.4 What Slice B part 2 shipped, and its deviations

Shipped live (kill switch only), for kernel-owned deliveries; a PR the kernel does
not own keeps the legacy conflict retry unchanged:

- **One door (T12).** Every caller that decided a conflict retry (landing, the merge
  routes, auto-merge, the dead-zone sweep, the landing-action tap and the PR-opened
  migration-collision dispatch) reaches `dispatchConflictRetry`, which now asks
  `observeConflict` (`seam.ts`) first. For a kernel-owned PR it takes a live read of
  `mergeable_state` now (the door's own reading is used only when GitHub says
  `unknown`), records the head first, and applies `ConflictObserved`. The legacy
  decision does not run: no `conflictIteration` counter, no spent-key release, no
  behind-only refresh, no task insert. `kernelConflictOutcome` maps the answer onto the
  `DispatchConflictRetryResult` the doors already understand (a landed mechanical
  refresh reads as `branchUpdated`, an agent attempt as `dispatched` with its task, a
  spent budget as `exhausted`).
- **Mechanical first (§6.7), in `conflict-retry-effects.ts`** (composed into
  `workflowEffectHandlers()`). `refresh_branch` runs `refreshBehindPr` pinned to the
  bound head (GitHub update-branch with `expected_head_sha`, so the semantic check, the
  single-flight lease and the operational bound still apply). Success: the new head
  arrives through T3, is attributed to the mechanical row by §6.9, ends it `delivered`,
  and, on an approved head, carries the approval forward as the platform's own refresh
  (T13, no new round). GitHub's textual-conflict 422 or a same-symbol overlap refuses
  the mechanical row and allocates the agent attempt (`ConflictObserved{mechanicalRefused}`,
  with the refusal handed to the task). Up to date: `RepairNotNeeded`. An operational
  dead end (update-branch kept failing, refused, semantic overlap unverifiable) is the
  new `MechanicalRepairFailed` command: the row ends `failed` and landing needs a
  person, never an agent.
- **`renumber_migration`** re-verifies the collision against live trees with the
  migration inspector (which compares only open PRs into the same base, so a mission
  branch lagging trunk is not a collision: `RepairNotNeeded(collision_resolved)`), then
  renames the migration through the git data API into the next index past the PR's
  head, its base, the trunk and the colliding PR's head. The renamed path points at the
  same blob, so it is byte-identical by construction, and the ref update is
  fast-forward only. A directory with a drizzle journal (`meta/`) is refused
  (`journal_regenerate_required`) and becomes an agent attempt with the renumber recipe.
- **`dispatch_conflict_fix`** revalidates at dispatch (§10.5: PR open, head still the
  bound head, still conflicting now, or the collision still there) and files the
  legacy-shaped conflict task with `delivery_role = conflict_fix`; its task id is the
  attempt id, and its title and "attempt N of M" come from the ledger row.
  `conflict_fix` is a repair role, so the §9 completion gate (`delivery_not_advanced`),
  `recordLocalHead` provenance and T4 apply. Claim-time revalidation: a conflict that
  GitHub no longer reports cancels the task as skipped and resumes the delivery.
  Conflict exhaustion escalates through `escalateConflictExhaustion`.
- **S37 under the kernel.** The kernel's live conflict fix is the canonical
  remediation: a second door gets `fix_in_flight` with that task, and a stalled one is
  re-woken or requeued in place by the same `recoverStalledConflictFix` row repair.
  A conflict retry filed by the legacy path (no `delivery_id`) is left to legacy.

Deviations, each deliberate:

1. **The drizzle case is always an agent.** A drizzle migration's journal and snapshot
   chain cannot be renumbered byte-identically server-side (open question 9), so for
   buildd itself the mechanical renumber always refuses; the mechanical rename covers
   plain SQL migration directories. Runner-side regeneration of derived files (task
   a2829bdb, not landed) can make the agent attempt cheap; nothing in the kernel
   assumes a derived-file conflict needs an agent once the mechanical refresh resolves it.
2. **The mechanical refresh is the conflict recheck.** A conflict flagged from a stale
   snapshot that GitHub's own merge of today's base resolves never reaches an agent. A
   sharper pre-agent check (a merge-tree replay against the base tip, task 61dbc148,
   not landed) plugs in at `agentIsOwed` in `conflict-retry-effects.ts`.
3. **A migration collision found at PR open stays legacy** unless the kernel already
   owns the PR: the opened door dispatches the renumber before the kernel opens a
   delivery, so that PR never becomes kernel-owned. A collision on a kernel delivery
   still in `WORKING` is `stale(state_not_allowed)` and falls through to the door's
   normal handling.
4. **A person's "fix the conflict" past the cap** raises the agent budget by the
   configured cap on top of what is spent (as the legacy path did); there is no
   conflict-family `BudgetExtended` row yet.
5. **The landing door's own refresh counter** (`refreshCycleCount` in `pr-landing.ts`)
   still runs before it calls the door. The T15/T16 half of S15 is Slice C's (§13.7):
   a merge call GitHub refuses as behind or conflicting is T16 into the same
   `conflictRepair`, so it runs these handlers, with one addition at the handler: a
   dependency-bot PR reaching `refresh_branch` through T16 (past the doors' own check)
   is never pushed to; the mechanical row ends `failed` and a person lands it (S27).

### 13.5 What Slice B part 3 shipped, and its deviations

Shipped live for kernel-owned deliveries (the trunk circuit breaker, §5.8, §6.10,
T25/T26, S24, AC-15):

- **Signatures at ingestion.** `observeCiFailure` reads the head's check runs and
  replaces the placeholder `ci_failed` (§13.1 deviation 11) with
  `ci:<check>|<check>`: the sorted names of the failing runs, normalised by
  `normalizeErrorSignature` (`lib/workflow/trunk-signature.ts`). The signature is
  the `ci` ledger row's trigger reason; ledger keys and budgets are unchanged. A
  check set that cannot be read keeps the placeholder and never opens an incident.
- **Classification** (`classifyCiFailure`, `lib/workflow/trunk.ts`), only for a
  delivery whose current head is the red one and whose state a CI failure moves:
  join an incident already open on the base whose checks explain the failure;
  else (a) the base branch's own head fails every check the PR fails; else (b) the
  opt-in multi-delivery rule over the `ci` ledger rows in the window. Opening and
  joining is one upsert on `trunk_incidents_open_signature_unique`; the incident
  carries the base's signature (rule a) or the shared one (rule b).
- **T25.** `CiFailedObserved` with the incident routes to `TrunkRedObserved`; a
  delivery already `REPAIRING(ci)` joins too (its queued attempt is `skipped`, it
  spends nothing). A newly opened incident also takes every kernel delivery on the
  same base repairing a failure it explains. `dispatch_trunk_fix`
  (`lib/workflow/ci-red-trunk-effects.ts`) files exactly one trunk-fix task per incident:
  the task id is the incident id, it is linked after it exists (the FK, §13.1
  deviation 9), and a base that is already green at dispatch files nothing. The
  `cancel_open_attempts(blocked_on_trunk)` effect cancels the per-PR CI fix tasks
  that never started. The CI doors map a blocked delivery to the skip reason
  `blocked_on_trunk`, so the red-PR sweep files nothing and does not come back.
- **T26.** `reconcileTrunkIncidents` (seam, on the `pr-reconcile` floor tick)
  re-reads each unresolved incident's base head. When every run there completed and
  none of the incident's checks fails, the incident resolves and each delivery
  blocked on it re-enters `resume_state`; a head that does not contain the new base
  head gets `refresh_branch`. A delivery left blocked on a resolved incident (an
  interrupted pass) is recovered on the next pass.
- **Activity.** `blocked_on_trunk` (with the failing checks) and `trunk_recovered`
  are rendered from their transitions (§12.1).

Deviations, each deliberate:

1. **The base-red rule is ON by default**, not opt-in as §6.10 first said: the
   kernel ships live, and the rule blocks only while the base itself fails every
   check the PR fails. A workspace with no `trunkBreaker` key in its `gitConfig`
   has it. **To turn the breaker off**, set `gitConfig.trunkBreaker = false`
   (`WorkspaceGitConfig.trunkBreaker`, read by `trunkBreakerConfig`): no CI failure
   is classified against the base, no incident opens, and every red PR gets its own
   `ci` attempt as before (S24 off path in the matrix). The multi-delivery rule
   stays opt-in: `trunkBreaker: { minDeliveries, windowMinutes? }`.
2. **"The same signature" is set containment**: the PR's failing checks are a
   subset of the base's. The incident is keyed by the base's signature, so PRs that
   fail different subsets of one red trunk share one incident and one fix.
3. **Recovery is a sweep, not a webhook.** The hourly `pr-reconcile` floor re-reads
   open incidents; a base push does not resume PRs sooner. A trunk-fix task is a
   plain task with no delivery role (it is not an attempt of any PR's delivery).
4. **T26's `refresh_branch` is the conflict family's handler** (§13.4,
   `conflict-retry-effects.ts`): with no ledger row it is a plain GitHub
   update-branch pinned to the head T26 judged stale, skipped if the head moved and
   retried by the outbox on an operational failure. The breaker registers no
   `refresh_branch` of its own: one handler per effect kind.
5. **Legacy (pre-cutover) PRs keep the per-PR CI path**; the breaker reads and
   writes kernel deliveries only. A person's "Fix CI" still records a `manual`
   signature and is not classified.

### 13.6 What Slice B part 1 shipped, and its deviations

Shipped live: the fact-ingestion funnel and terminal-wins for the PR fact cache.

- **`recordPrFact(target, fact)`** (`packages/core/pr-facts.ts`) is one statement
  that applies a PR fact (`merged`, `closed`, `open`, `ci`, `conflict`,
  `unresolvable`) to the targeted worker rows (one row, a set, or every row of the
  PR) and returns the rows it changed with their previous status. The ordering rules
  are in its `WHERE`, so arrival order never matters: `merged` is final and keeps its
  first instant; `closed` yields only to `merged` or an explicit reopen; a CI fact
  whose suite SHA is not the PR's current head is dropped; `conflict_detected_at` is
  first-seen. A pure mirror (`prFactApplies`) answers the same question for a row in
  hand, and the real-Postgres test checks the two agree on every (status, fact) pair.
- **Every writer moved** (§18.2): the webhook's open-state, closed and `check_suite`
  writes; `pr-reconcile.ts`, `pr-state-refresh.ts`, `dead-zone-sweep.ts`,
  `dead-pr-shutdown.ts`, `register-local-pr.ts`, `mission-pr.ts`, the adoption
  insert in `pr-review-request.ts`, the `backfill-merged-prs` route and
  `backfill-mergedat.ts`, the three merge-door stamps, and `stampPrMergedOnAllRows`
  (now a thin caller). `packages/core/__tests__/pr-fact-write-sites.test.ts` fails any
  other module that writes `pr_lifecycle_status` or `merged_at`.
- **Defects closed on the way**: a late `synchronize`/`opened` no longer regresses a
  merged or closed PR to `pr_open`; a closed-unmerged PR is stamped on every row of
  the PR, not one; the webhook stamps GitHub's `merged_at` instead of receipt time;
  red CI is a `ci_failed` fact in the dead-zone sweep, no longer an overloaded
  `conflict`; `conflict_detected_at` is no longer reset on re-entry; the `check_suite`
  terminal guard is in the statement, not a read-then-write.
- **`stamp_pr_rows`** (`lib/workflow/pr-fact-effects.ts`, composed into
  `workflowEffectHandlers()`) is live: T17/T18 project the merge (with the
  delivery's GitHub `merged_at`) or the close onto every row of the PR through the
  funnel. It is no longer acknowledged `legacy_owns`.
- **Importers feed the kernel** (§11): when `pr-reconcile` or `pr-state-refresh`
  finds a merge or close GitHub never delivered, a kernel-owned PR also gets it
  through `observePrState` (T17/T18 from the kernel's own live read).
- **`pr-state-reconcile.ts` is deleted.** `POST /api/missions/[id]/reconcile` and
  `scripts/reconcile-pr-merge-state.ts` use `lib/pr-fact-import.ts`, which imports
  merged/closed facts and writes nothing for an open PR (the old `pr_open` write was
  the regression).
- **No render-time writes**: Home, the task page and the mission page enqueue their
  read-through import with `after()` and render what is stored.
- **An owner in `AWAITING_PUSH` leaves on a push** (§6.4, §9). An owner attempt has
  no ledger row, so its `L` is read from the evidence of the transition that entered
  `AWAITING_PUSH` (`pushPendingLocalHead` on the loaded view; no new column). A head
  that contains `L` and differs from `Hb` goes to `AWAITING_REVIEW` with a new round
  and `dispatch_review`, whether it arrives by `synchronize` or by `push_recovery`'s
  own re-read; a head that does not is recorded, the delivery stays, and recovery is
  re-armed from that head. With `L` unknown (a reaped owner, S9), the proof is "moved
  off `Hb` and the new head descends from it", read through the compare API.

Deviations, each deliberate:

1. **The funnel lives in `@buildd/core`, not `lib/workflow/`.** It writes only the
   `workers` fact cache, never a `workflow_*` table, and the offline backfill script
   in `packages/core/scripts` must use the same statement; the write-site guard is
   its own test.
2. **The merge doors still stamp their own instant** (`merge_pr`, the dashboard
   merge, the `PUT /api/github/pr` race path): they hold GitHub's merge response, not
   its `merged_at`. Through the funnel a later fact never moves that instant; Slice C
   replaces the doors with T16 and `verify_merge`.
3. **Webhooks stay fact importers.** "Hint, not writer" means they no longer write
   lifecycle columns directly and never assign delivery state: they hand facts to the
   funnel (for every PR) and to the kernel (for a kernel-owned PR). Both are
   convergent, so the webhook stamp and `stamp_pr_rows` cannot disagree.
4. **The one-time repair of a wrong-repo `merged` stamp is gone with
   `pr-state-reconcile.ts`.** `merged` is terminal on the fact cache; the repo-scoped
   lookups that caused those stamps shipped long ago.
5. **`register-local-pr.ts` still writes `lastCommitSha` from the PR head** (§12):
   that column is not part of this funnel; Slice E retires the reader that needs it.
6. **Bookkeeping clocks** (`prLastCheckedAt`, `prLastVerifiedAt`,
   `prCheckFailureCount`) are written beside the fact by the importers, unguarded:
   they record that a check ran, not what the PR is.
7. **"The PR's content changed" is approximated by ancestry.** With `L` unknown, a
   new head that descends from `Hb` counts as changed content; an empty commit would
   pass. `push_recovery` re-armed per non-proving head is bounded by the pushes that
   arrive, and each chain still ends in T22.

### 13.7 What Slice C shipped, and its deviations

Shipped live (kill switch only), for kernel-owned deliveries; a legacy PR keeps every
door exactly as it was (AC-11):

- **One merge call per landing, by the kernel.** `landThroughKernel`
  (`lib/workflow/landing.ts`, through `seam.ts`) is the merge of a kernel-owned PR
  for every door: `landPr` (and through it the landing sweep and
  `surface-ordering-wake`), `tryAutoMergeWorkerPr` (now an adapter: its rails run, it
  never calls GitHub's merge or finalizes the mission branch for a kernel-owned PR),
  `POST /api/prs/[prNumber]/merge` and `PUT /api/github/pr` (`merge_pr`). Each door
  runs its rails unchanged and calls it where it used to call `mergePullRequest`,
  inside the same surface-ordering slot. It records the live head (R2), applies T15,
  and drains: `merge_call` (`lib/workflow/pr-landing-effects.ts`) makes the pinned
  `PUT /merge` and applies T16 from GitHub's answer (`classifyMergeCall`); merged and
  indeterminate answers go through `verify_merge`, whose live read is the only thing
  that produces `PrMerged`.
- **Refusals are repair, not a page.** Behind / out-of-date is
  `REPAIRING(behind)` with a mechanical `refresh_branch` (`updateBehindPrBranch`,
  pinned to its `expected_head`; the refreshed head is attributed to the attempt and
  carried forward as the platform's own refresh, §8.3), bounded by the treadmill cap.
  A textual conflict from update-branch hands over to an agent attempt
  (`dispatch_conflict_fix`); a branch already current skips the row and resumes
  `APPROVED`. Anything else GitHub definitely refused is
  `ESCALATED(landing_needs_human)`.
- **Post-merge work is outbox effects.** T17 queues `stamp_pr_rows`,
  `cancel_open_attempts`, `emit_pr_merged` and `finalize_mission_pr`.
  `emit_pr_merged` runs `runMergedPrWork` (`lib/pr-merged-work.ts`, extracted from the
  webhook): the owner task's completion, dependents, path-claim release, the
  `pr.closed` / `task.pr_merge_delivered` / `task.pr_merged` fan-out (mission wake,
  dependent missions, release Path B) and the work-tracker update.
  `finalize_mission_pr` deletes a shipped mission branch whoever merged it. The
  `pull_request.closed` webhook records the fact for a kernel-owned PR and runs none of
  that inline; for a legacy PR it calls the same function.
- **Removed for kernel-owned PRs**: the per-door `recordPrFact(merged)` stamps, the
  doors' inline `finalizeMissionPrMerge`, `checkDependsOnResolved`,
  `reconcileSubjectEvent`, `checkAndUnblockDependentMissions`, the post-merge-call
  conflict dispatch in `tryAutoMergeWorkerPr` and the routes, and the webhook's
  inline post-merge block.
- **S20.** Both merge routes accept `version` (the delivery version the caller read)
  and answer HTTP 409 `{ stale: true, current }` before any rail runs when it is
  stale; the same version rides T15 as `expectedVersion`, so a screen that goes stale
  between the check and the CAS is also refused, and nothing applies.

Deviations, each deliberate:

1. **The landing key carries the version** (`merge:{repo}#{pr}:{head}:v{version}`,
   and `merge_call` / `mergeresult` / `verify_merge` keys name the landing version).
   With the head alone, a landing GitHub refused could never be requested again at
   that head, not even by a person past the escalation. A double door is still one
   landing: the second reads `LANDING` and is `duplicate(landing_in_flight)`.
2. **`not_merged` is a T16 outcome.** After an indeterminate answer, a
   `verify_merge` read that shows the PR still open and unmerged at the head returns
   the delivery to `APPROVED` (the approval stands; a door or the sweep lands it
   again). "Head branch was modified" maps to it too: the new head has its own fact.
   A merge GitHub *accepted* whose read lags is retried by `verify_merge`, never
   turned into `not_merged`.
3. **The override door is a person's verdict override from any review state**
   (`APPROVED`, `AWAITING_REVIEW`, `CHANGES_REQUESTED`, `ESCALATED`), matching the
   dashboard's "Merge anyway", which also overrides an in-flight review. It is
   recorded in `bypass` with the state it overrode; red CI and deny paths stay
   non-overridable, and an agent actor never gets it.
4. **The mission wake and release attribution are not separate T17 effects.** They
   are subscribers of the `task.pr_merged` event `emit_pr_merged` emits, and they read
   the task transition (`flipped` / `already_completed`) that same effect produced; two
   effects racing it would see a different one. `wake_mission` is an effect of
   T20/T21 (handled since Slice D, §13.8); `release_attribution` is declared and
   emitted by no transition.
5. **`landPr`'s own freshness step is unchanged.** A PR found behind *before* the
   merge call is still refreshed by `landPr`'s marker-keyed treadmill (a rail); only a
   merge call GitHub refuses as behind is T16's `refresh_branch`.
6. **T16's `behind` and `conflict` are conflict-family repairs.** The landing family
   registers no `refresh_branch` or `dispatch_conflict_fix` of its own: both are the
   conflict family's handlers (`conflict-retry-effects.ts`, §13.4), so the refresh
   runs `refreshBehindPr` pinned to the bound head and the agent attempt's task is
   filed against its ledger row, exactly as from any other conflict door.
7. **The doc-fix spec recheck stays in the webhook** for every merged worker PR: it
   belongs to the spec-conformance module, which core may not import, and its sweep
   is the backstop.
8. **`version` is accepted, not yet shown.** The routes take it and the kernel
   enforces it; the dashboard card, `get_pr` and the MCP `merge_pr` tool do not send
   or display it yet (Slice E reads the delivery view).

### 13.8 What Slice D shipped, and its deviations

Shipped live (kill switch only), for kernel-owned deliveries; a legacy PR keeps the
direct column writes exactly as they were:

- **T20 is the only write of a supersession edge.** `recordPrSupersession`
  (`lib/pr-supersession.ts`) keeps its validation and its live read of the target
  (exists, merged, a different PR, a repo the work could have moved to) and, for a
  kernel-owned PR, hands the decision to `recordSupersession` (`seam.ts`): T20 from
  `CLOSED_UNMERGED` only, never overwriting an edge. Its callers are all four doors:
  `POST /api/github/pr/supersede` (MCP `record_pr_supersession`), the mission card's
  Confirm, the automatic detector and the hourly sweep. The answer maps to the
  route's status: `not_closed_unmerged`, `edge_exists` and `target_not_merged` are
  409, `same_pr` and `reason_required` 400. The direct `workers` update runs only for
  a legacy PR.
- **T21 is the only write of an abandonment** for a kernel-owned PR
  (`recordPrAbandonment` → `abandonDelivery`), with the person as `human:<who>`.
- **A lost close is caught up first.** Both resolutions read GitHub and record
  `PrClosedUnmerged` before deciding when the delivery has not heard of the close
  (R2), so an edge is never refused for a webhook the platform missed, and the
  kernel, not a stale `prLifecycleStatus`, says whether the PR is closed.
- **`project_supersession` and `wake_mission` are live** (`lib/workflow/supersession-effects.ts`):
  the projection writes `supersededBy*` or `abandoned*` on every row of the PR from
  the delivery (never over an edge already on a row); the wake re-plans the owner
  task's mission, which may now be completable (`MissionWakeReason` `pr_resolved`).
- **`base_deleted` is read, not guessed.** `pr_closed` asks GitHub whether the PR's
  base branch still exists (`branchExists`); a 404 is `CLOSED_UNMERGED(base_deleted)`,
  anything else stays `unknown` (S18).
- **`scan_supersession` runs the detector** for a kernel-owned PR. The
  `pull_request.closed` subscriber skips a kernel-owned PR, so the scan is owed
  durably by T18 rather than run in the request; an edge it proves goes back in as
  T20 with actor `system:auto-supersession`.
- **Mission completion reads the delivery.** `prShipState` takes the delivery's
  state when the kernel owns the PR (`MERGED`, `SUPERSEDED`, `ABANDONED`,
  `CLOSED_UNMERGED` → closed with no edge, every other state → open; `FAILED` and no
  delivery → the columns). `canCompleteMission` and the `all_prs_merged` criterion
  overlay it on the row they judge (`withDeliveryShip`, loaded by
  `deliveryShipsForPrs`, `lib/workflow/delivery-ship.ts`), so neither waits on a
  projection and the gate's own rules are unchanged: the `mission-task-lifecycle`
  acceptance tests pass unmodified (S16).
- **§17.1 (b) holds at the supersede route.** A task token may supersede the PR its
  own run opened **or** a PR its own task names (`taskScopeTaskNamesPr`, shared with
  `POST /api/github/pr/review`), never one the owner's task names; its T20 actor is
  `agent:<its task>` (S21).
- **Found and fixed: Slice C's handlers were never composed.** `modules.ts`
  imported `withLandingEffects` and did not apply it, so in production `merge_call`,
  `verify_merge`, `refresh_branch`, `dispatch_conflict_fix`, `emit_pr_merged` and
  `finalize_mission_pr` had no handler and would have retried until dead (the matrix
  composes its own handler set, so it never saw this). The root now composes
  landing and supersession, and `modules.test.ts` fails when a recorded effect kind
  has no production handler.

Deviations, each deliberate:

1. **The composition is built on first use** (`workflowEffectHandlers()`, which
   replaces the `WORKFLOW_EFFECT_HANDLERS` constant). The handler modules reach
   back into `modules.ts` through `core-emit`, so composing them at load works or
   throws depending on which module a process imports first.
2. **One projection effect for both resolutions.** T21 emits `project_supersession`
   too; the handler reads which edge to write from the delivery's terminal state
   (§12 treats `supersededBy*` and `abandoned*` as one edge).
3. **The hourly sweep still runs the detector** for every closed, unresolved row,
   kernel-owned or not, instead of only re-enqueueing `scan_supersession`. Its write
   is T20 either way, so it is a second door, not a second authority.
4. **An admin API key may abandon** through the mission card route, recorded as
   `human:<key name>`. Agents hold worker-level and task tokens, which that route
   refuses; an admin key is a person's own credential.
5. **Lineage-derived supersession stays a read-time proof.** A closed PR followed
   by a merged PR from its own attempt lineage reads as shipped in the gate
   (`deriveLineageSupersession`) without a T20, as before; the delivery stays
   `CLOSED_UNMERGED` until someone or the scan records the edge.
6. **The reaper needed no change in this slice.** Slice A part 2 already stopped
   `resolveStaleTask` and `tasks/cleanup` promoting a kernel attempt to `completed`
   from local commits; they send `AttemptEnded(lost)` instead, and S9 stays green.
7. **The owner-attempt completion gates G1–G3 (§17.4) are not closed here.** They
   change what plain builders see and are left to their own slice; the kernel still
   only records the mismatch.

### 13.9 What Slice E shipped, and its deviations

Shipped live (kill switch only). A kernel-owned delivery is read from
`getDeliveryView` on every surface below; a legacy-owned or PR-less task keeps
the fact-cache projection until that population drains (§14). There is one
source per row: a surface never combines the delivery with the worker columns.

- **`DeliveryView` carries the PR's own state.** `prState`
  (`deliveryPrState`, `lib/workflow/projections.ts`) comes from the delivery
  row: terminal state first, then a CI or mergeable fact only when it was
  observed on the current head. It also carries `lastTransition`, the newest
  `workflow_transitions` row.
- **One serialisable display, one load per surface.** `DeliveryDisplay`
  (`lib/workflow/delivery-display.ts`, client-safe) is the slice list surfaces
  carry. `getOwnerDeliveryDisplays` loads it for the **owner** task of each
  kernel-owned delivery only, because an attempt row is history of the
  delivery, not the delivery itself (S35). The mission page makes one
  `getDeliveryViewsForTasks` call. Its failure reading (`replacedFailedTaskIds`),
  board, strip and structure view all read that call.
- **One PR accessor.** `resolvePrDisplayState` (`lib/pr-presentation.ts`) returns
  the delivery's `prState` when there is one, else `derivePrDisplayState` over
  the columns. `PR_PILL`, keyed by display state, is the only pill vocabulary.
  The task page's stat tile, PR card and shipped header, the chat PR object,
  explain's history and the mission feed's PR state all call it.
- **Task card stage.** `deriveStage` takes `delivery` and maps it through
  `stageForDelivery`. That adds one chip, `FIXING`, for a fix, repair or push
  recovery in flight. `AWAITING_PUSH` reads Fixing, not "in review". The
  tasks list histogram (`deriveGridTaskStage`) buckets from the same stage. A
  live worker and a worker's own question still lead (§13.2 deviation 3). A
  failed owner attempt of a live delivery reads the delivery, not FAILED.
- **Mission strip, board and feed.** `deriveFeedTaskState` and
  `deriveBoardStatus` read `task.delivery` (`feedStateForDelivery`,
  `boardStatusForDelivery`). Only ESCALATED is yours. Every other live state
  is moving, so a fix in flight is never "needs you" and never FAILED. On
  the Board, a review fix or a push recovery reads `running`. A red PR under
  repair (CI, conflict, a red base) reads `fixing`, the Board's own word for
  it. The strip drawer gives the kernel's headline and evidence
  (`BoardTask.kernelReason`) instead of generic copy. The chat's mission
  object loads the same displays for its board and AT WORK rows.
- **Chat.** The dock badge (`dockToneForDelivery`), the task tile
  (`taskStateForDelivery`) and the PR object (`prStateOf`) read the delivery.
  The dock's insight and closing line carry the kernel's headline and evidence
  instead of "Needs input."
- **Explain.** For the owner of a kernel-owned delivery, the state chain's
  unmerged-PR input is `kernelUnmergedPr`: merged, superseded, abandoned and
  failed deliveries are settled, and `CLOSED_UNMERGED` is closed-unsuperseded.
  The worker's `mergedAt` and `prLifecycleStatus` are not read. The CI-red chain
  takes the delivery's `prState`. Failed attempts the kernel carried past drop
  out of the task's failure input. `because[]` gains a link from the newest `workflow_transitions` row
  (`deliveryTransitionLink`, cited as `DeliveryView.lastTransition`) before the conclusion, and history nodes
  take their PR state from the delivery. The chain loads deliveries once, and
  the `delivery` block reuses that load.

**Retired in this PR:**
- `derivePrLifecycle` and `isPrMerged`. They were the second map, and it
  ignored `mergedAt`.
- TaskCard's private `PR_LIFECYCLE`, which was dead.
- `deriveStage`'s own PR state machine (now `derivePrDisplayState` for legacy
  rows, `stageForDelivery` for kernel ones).
- `deriveGridTaskStage`'s lifecycle read.
- The chat dock's `mergedAt || status === 'completed'` "Landed" rule.
- The chat task tile's column reads.
- The chat PR object's `lifecycleOf` reverse map, which also mislabelled CI
  running as Open.
- Explain's `unmergedPr` column predicate, for kernel-owned PRs.

Deviations, each deliberate:

1. **Legacy rows got one behaviour fix.** "Landed" in the chat dock is no
   longer `status === 'completed'` for a legacy task whose PR is still open
   (§17.5 named it a bug). Every other legacy reading is unchanged; it now runs
   through `derivePrDisplayState` instead of its own column checks.
2. **`get_pr`, `list_prs` and the PR attention ranking are not in this slice.**
   S36 (#3881) already moved their human-ownership reading to the view. Their
   `canonicalState` and terminal sets are API vocabulary that Slice F's column
   drop has to revisit anyway.
3. **The mission card's failure count is task 058285e3's.** The card's strip
   reads the board cells, which accept `delivery`. The Home and missions-list
   loaders do not pass it yet, and the raw failed-task count
   (`mission-card-view.ts`) is left to that task to avoid a conflicting edit.
4. **The mission task drawer (`TaskPanel`) and the unmounted
   `CondensedTimeline` component keep their column reads.** The timeline's
   rows pass `delivery` to `TaskCard`, so its chip is correct. The drawer's PR
   card still takes `prLifecycleStatus` from its own query.
5. **The Board keeps its own needs-you word.** An ESCALATED delivery is
   `review` on the Board, as a legacy PR awaiting you is. The Board's
   `waiting`, its Ask/Reply and its NEEDS YOU count are for an agent's
   question. Home, the task card, the feed, the chip and the chat all say
   "needs you". The strip still counts a red PR under repair as "failed"
   (its tone vocabulary, #3846).
6. **Visual QA ran locally.** The dispatched capture fails at Run migrations
   for any mission-branch ref, because a branch migration sits below prod's
   journal mark and the planner refuses the backfill. That has nothing to do
   with this PR. The fixture was shot locally with `scripts/qa/shoot.sh`
   against Docker Postgres through the neon-sql shim.
7. **The kernel has no "CI running" fact.** An open kernel PR without a verdict
   on its head reads `awaiting_ci` ("Open"), where a legacy row may read
   "CI running".

### 13.10 What Slice F shipped, and what it deferred

Slice F is the reader-removal half of the drop. It drops no column and no
index, because every one the plan names is still read or written by code that
is deployed, or will stay deployed until legacy drains (below).

- **`get_pr` reads the delivery.** For the owner or an attempt of a
  kernel-owned delivery, the merge record and the supersession edge come from
  the delivery (`prRecord`, `lib/pr-presentation.ts`, over
  `DeliveryView.mergedAt` and `DeliveryView.supersededBy`). `canonicalPrState`
  lets GitHub decide open versus closed, and the record fills in a merge that
  GitHub reported as a plain close. The worker's `mergedAt`,
  `prLifecycleStatus` and `supersededBy*` are not read for that PR.
- **`list_prs` and its ranking read the delivery.** `kernelPrStatuses` maps
  each task of a kernel-owned delivery to its `prState`, in the list's own
  lifecycle words (`prListStatus`, the inverse of `derivePrDisplayState`).
  `shapePrRows` lets that decide merged, closed and the state for the PR,
  over every worker row it has. `rankPrs` and `needsAttention` rank that state.
  `conflict` and `ci_failed` now read every open PR and filter after the
  collapse, so a stale column can neither hide a red kernel PR nor list a
  green one.
- **The mission task drawer reads the delivery.** `GET /api/tasks/[id]/summary`
  returns `worker.prState` for a kernel-owned PR, and `TaskPanel`'s PR card
  passes it to `PrCard`, where it wins over `prLifecycleStatus`.
- **The write-site guard blocks, with an empty allowlist.**
  `packages/core/__tests__/workflow-write-sites.test.ts` scans every deployed
  module in `apps`, `packages` and `scripts`. Tests are excluded by the same
  rule as the PR-fact guard. It flags access to a kernel table: raw SQL that
  reads or writes one, or a Drizzle builder or `db.query` over a table object.
  A declaration is not access, so the schema passes without an exemption, and
  the test proves it does declare the tables. `ALLOWED` is asserted empty.
- **The matrix has no todo left.** The one remaining `test.todo` was the live
  S1 integration case (`apps/web/tests/integration/workflow-s1.test.ts`). It is
  retired, not passed. It needs a real reviewer verdict, and a fix worker that
  commits but does not push, against a deployment running the kernel. The
  integration harness can drive neither deterministically. S1 runs end to end
  on real Postgres in `workflow-seam.test.ts` and the matrix (both arms), and
  the route's 400 `delivery_not_advanced` is in the workers route test.

**Drop after legacy drains.** Each item below still has a deployed reader or
writer, so dropping it in this release would break a live path:

| Column, index or key | Still used by | Why it cannot go yet |
|---|---|---|
| `tasks.reviewer_retry_pr_number`, `reviewer_retry_head_sha`, index `tasks_reviewer_retry_event_unique` | the legacy request-changes fix insert (workers route), `supersession.ts` / `supersession-store.ts`, and the kernel's own `dispatch_fix` (`review-effects.ts` stamps the head on the first fix at a head) | The kill switch hands a released delivery back to legacy, and legacy dedupes its fix insert on this index. The kernel stamps the first fix so that a legacy insert after a release still collides. |
| `tasks.ci_retry_pr_number`, `ci_retry_head_sha`, index `tasks_ci_retry_event_unique` (and the pending-retry index beside it) | `ci-failure-retry.ts` (legacy path and the cap count), `retry-ci` route, `apply-recommendation` route, `pr-list.ts` CI-fix counts, the kernel's `ci-retry-effects.ts` | The same kill-switch dedupe, and the CI-fix attempt count `list_prs` reports. |
| `tasks.conflict_retry_pr_number`, `conflict_retry_head_sha`, index `tasks_conflict_retry_event_unique` | `conflict-retry.ts`, `dead-zone-sweep.ts`, `pr-attention.ts`, the delivery view's own remediation lookup (`delivery-view.ts`), the kernel's `conflict-retry-effects.ts` | S37's remediation join reads `conflict_retry_pr_number`. Legacy conflict retries dedupe on the index. |
| `tasks.context.iteration` / `maxIterations` (and `conflictIteration`) | the runner's prompt builder (`apps/runner/src/prompt-builder.ts`, deployed by release), the activity comment's attempt line, `pr-attention.ts`, legacy CI and review paths | No decision reads them for a kernel-owned delivery (§13.1). The runner reads them to word its prompt, and fix tasks created by kernel effects keep carrying them for it (§14, kill switch semantics). |

The safe order is the schema-change skill's. First, a release removes the
legacy writers and readers above, together with the kill switch, because
legacy is the rollback path. That release also moves the runner's prompt off
`context.iteration`, and moves the remediation join to the attempt ledger.
That is possible only after the legacy-owned population has drained: every
delivery with `authority = 'legacy'`, and every PR without a delivery row,
merged or closed. The drop then ships in the next release, when nothing
deployed reads the columns, with the production row counts in its PR. Both
steps are owned by follow-up task `9d7ce2d4` (§14 row F).

Deviations, each deliberate:

1. **No column or index is dropped.** This is the safety rule above, not an
   omission. `bun db:generate` reports no change.
2. **`list_prs`' merged window still comes from the worker stamp.** The
   candidate query keeps `workers.merged_at` for `state: merged`. For a
   kernel-owned PR, `stamp_pr_rows` (T17) writes that stamp, and the instant
   shown is the delivery's. A delivery whose stamp effect has not run yet
   appears once it runs.
3. **`pr-attention.ts` keeps its column pre-filter.** Its open-PR query and
   dead-zone count read the fact cache. For a kernel-owned PR, the inbox
   decision is already the kernel's (S36).
4. **`CondensedTimeline` keeps its column reads.** It is not mounted anywhere,
   and its rows already pass `delivery` to `TaskCard`. It goes away with the
   legacy readers.

---

## 14. Migration plan: no two authorities, ever

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
default-off plan). `false` (or `'off'`) is the emergency rollback. There is no `shadow`
value on purpose.

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
released delivery back, because legacy may have acted on it meanwhile. Effects already
committed still drain (they are decisions already made, and they create legacy-shaped
tasks: fix tasks carry `reviewerRetry*`, `iteration`, `resumeBranch`; reviewer tasks
carry the full legacy context), so legacy can carry a released delivery on. Neither
direction rewrites kernel state.

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
| 10 | Reviewer approves `L2`, CI green | `ReviewVerdictRecorded(round2, approve, head=L2)`, `LandingRequested` | `AWAITING_REVIEW` (v7) | `APPROVED` → `LANDING` → merge pinned at `L2`; `PrMerged` → `MERGED`; the recorded supersession of the sibling PR (`SupersessionRecorded`, T20) is then authorised by "the caller's task names the PR" (§17.1) |

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
| S1 | Fix ends with a local commit, GitHub head unchanged (#3754) | completion gate 400 `delivery_not_advanced`; with worker gone → `AWAITING_PUSH` + `push_recovery`; no round 2; no `fix_ended`-then-review | `apps/web/src/lib/workflow/reducer.test.ts` (new), `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S2 | Approve at `H0`, non-equivalent push to `H1` | `APPROVED → AWAITING_REVIEW`, delta round 2 dispatched **on the push**, not at merge time | `apps/web/src/lib/workflow/reducer.test.ts`, `apps/web/src/lib/reviewer-subscribers.test.ts` (new: the module has no test file today; its re-dispatch cases live in the webhook route test), `apps/web/src/lib/review-verdict-gate.test.ts` |
| S3 | Approve at `H0`, head moves by platform refresh (content-equivalent) | `approved_heads` appended once; concurrent double call appends once | `apps/web/src/lib/approval-carry-forward.test.ts`, reducer test |
| S4 | Late verdict for a superseded head | stored on its round, no state change, no `post_review`, no merge | reducer test; `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S5 | Duplicate webhook delivery and duplicate reviewer PATCH | `duplicate`; effects not doubled | reducer test; `apps/web/src/app/api/github/webhook/route.test.ts` |
| S6 | Out-of-order: `closed(merged)` then late `synchronize`/`opened`/`check_suite` | terminal wins; `workers` columns unchanged; old-SHA CI failure does not overwrite | `apps/web/src/app/api/github/webhook/route.test.ts`, `apps/web/src/lib/pr-state-refresh.test.ts`, `apps/web/tests/db/pr-facts.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts`, `packages/core/__tests__/pr-fact-write-sites.test.ts` |
| S7 | Two fix dispatches race (#3420) | one `dispatch_fix` per `(delivery, round)`; loser `stale`/cancelled; `approve` cancels open fixes | reducer test; `apps/web/src/lib/supersession-store.test.ts` |
| S8 | Request-changes budget exhausted | `ESCALATED(review_exhausted)` once per head | reducer test; existing reviewer exhaustion tests in `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S9 | Reaper/cleanup sees a dead worker with only local commits | `AttemptEnded(lost)` → `AWAITING_PUSH`; task not `completed` with `result.sha` | `apps/web/src/lib/stale-workers.test.ts`, `apps/web/src/app/api/tasks/cleanup/route.test.ts` |
| S10 | Merge response `indeterminate`; double merge call | stays `LANDING`; `verify_merge`; one `PrMerged`; merge pinned at head | `apps/web/src/lib/pr-landing.test.ts`, `apps/web/src/lib/auto-merge.test.ts`, `apps/web/src/app/api/prs/[prNumber]/merge/route.test.ts` |
| S11 | Human merges on GitHub while `AWAITING_REVIEW` | T17 from any state; open attempts cancelled; merged-over-verdict classified | webhook route test; `apps/web/src/lib/review-subscribers.test.ts` (new: none today) |
| S12 | Closed unmerged, work shipped under another PR; caller task names the PR | T20 allowed only from `CLOSED_UNMERGED`; authorised on caller's task, not the owner's; overwrite refused; mission completion treats it as shipped | `apps/web/src/app/api/github/pr/supersede/route.test.ts`, `apps/web/src/lib/pr-supersession.test.ts`, `apps/web/src/lib/mission-completion.test.ts` |
| S13 | Crash between transition and effect; crash mid-effect | effect row present atomically; lease expiry re-runs; idempotent | `apps/web/src/lib/workflow/effects.test.ts` (new), pattern of `apps/web/src/lib/dispatch-reconcile.test.ts` |
| S14 | A sweep tries to assign state | sweep modules import only `ingestFact`/`enqueueMissingEffects`; write-site guard fails on any direct write to a guarded column outside the allowlist | `packages/core/__tests__/workflow-write-sites.test.ts` (new; pattern of `packages/core/__tests__/model-policy-authority.test.ts`) |
| S15 | Base keeps moving under an approved PR | `LANDING`/`REPAIRING(behind)` bounded by the existing treadmill cap; hard gates unchanged | `apps/web/src/lib/pr-landing.test.ts`, `apps/web/src/lib/pr-landing-sweep.test.ts`, `apps/web/src/lib/base-refresh.test.ts` |
| S16 | Mission with a `SUPERSEDED`/`ABANDONED`/open/closed delivery | `canCompleteMission` results identical to today for all legacy inputs | `apps/web/src/lib/mission-completion.test.ts`, `packages/core/__tests__/pr-shipped.test.ts` |
| S17 | UI projections agree | one `DeliveryView` → Home chip, task header and mission failure reading agree (part 3); task card stage, mission strip and feed, chat dock, chat tile, PR pill and explain's state chain agree with it for every §4 state, and none reads the worker columns for a kernel-owned PR (Slice E, §13.9) | `apps/web/src/lib/workflow/delivery-display.test.ts`, `apps/web/src/lib/action-queue.delivery-view.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts`, `apps/web/src/app/app/(protected)/tasks/[id]/lineage-status.test.tsx`, `apps/web/src/lib/explain-because.test.ts` |
| S18 | Mission integration branch deleted under an open task PR (cause of the PR #3744 closure) | `CLOSED_UNMERGED(base_deleted)`, `scan_supersession` finds the re-opened PR, T20 records it | `apps/web/src/lib/pr-supersession-detect.test.ts`, `apps/web/src/lib/mission-pr.test.ts` |
| S19 | Fix worker killed after claim | `FIXING → CHANGES_REQUESTED`, the ledger row ends `failed`, the next dispatch allocates the next `attempt_no`, or exhausts | reducer test |
| S20 | Stale `version` from a human action | `stale` + current view, HTTP 409; nothing applied | reducer test; route tests for `/api/prs/[prNumber]/merge` and `/api/github/pr` |
| S21 | Authorization matrix (§17.1) | owner, caller-names-PR, sibling, other workspace, human | `apps/web/src/app/api/github/pr/supersede/route.test.ts`, `apps/web/src/app/api/github/pr/review/route.test.ts`, `apps/web/src/lib/task-token-auth.test.ts` |
| S22 | Kill switch | with `workflowKernel=false` a delivery is released to legacy (sticky), no new one opens, and a PR with no delivery is untouched by every seam function | `apps/web/tests/db/workflow-seam.test.ts`, `bun run test` |
| S23 | CI provenance (audit): worker pushes under the owner's git identity; worker pushes under the bot identity; a person pushes | the first two are attributed by SHA set and consume a ledger row; the third is `foreign_push` and consumes none; the cap bounds dispatches in all three; manual "Fix CI" uses the configured cap | `apps/web/src/lib/ci-failure-retry.test.ts`, `apps/web/src/app/api/prs/[prNumber]/retry-ci/route.test.ts`, reducer test (replaces the author-string cases around `isBuilddWorkerCommit`) |
| S24 | Trunk breakage: one signature red on trunk and on several PRs | one incident, one trunk-fix task, zero per-PR `ci` attempts, queued ones `skipped`, deliveries `BLOCKED_ON_TRUNK`, `ci` budget untouched, recovery re-enters `resume_state`; two dependency-bot PRs do not accumulate retries | `apps/web/src/lib/workflow/trunk.test.ts`, `apps/web/src/lib/ci-failure-retry.wake.test.ts`, `apps/web/src/lib/workflow/reducer.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S25 | Stale dispatch: target merged / approved / CI green / conflict resolved between trigger and dispatch, and between dispatch and claim | ledger row `skipped`, no task (or task cancelled as skipped, not failed); replay is a no-op; reason recorded | `apps/web/src/lib/workflow/effects.test.ts` (new), `apps/web/src/lib/conflict-retry.test.ts`, `apps/web/src/lib/ci-failure-retry.test.ts` |
| S26 | Comment as projection: concurrent renders, lost-update race (a `reviewing` write racing the merge), entries after merge, duplicate sticky comments, PR with no comment, CI red while approved | final comment equals a fresh render of canonical state; `Merged` stays the headline; one comment; created for every bound PR; "Approved" never heads a `REPAIRING` delivery | `apps/web/src/lib/pr-activity-comment.test.ts`, `apps/web/src/lib/workflow/pr-activity-render.test.ts`, `apps/web/src/lib/workflow/pr-activity-effects.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S27 | Mechanical versus agent repair | behind-only conflict and byte-identical renumber complete with no task; textual conflict and non-identical renumber escalate to an agent attempt; false collision from a lagging mission branch is not a collision; dependency-bot PRs are never pushed to | `apps/web/src/lib/conflict-retry.test.ts`, `apps/web/src/lib/migration-collision-retry.test.ts`, `apps/web/src/lib/base-refresh.test.ts` |
| S28 | Ledger separation | CI, review, conflict, migration, trunk families count independently; a reviewer spawned on a CI-fix task does not inherit the CI count; infra requeues change no ledger; `attemptView` is 1-based and identical in comment, title and `explain` | reducer test; `apps/web/src/lib/pr-activity-comment.test.ts`, `apps/web/src/lib/explain.test.ts` |
| S29 | Reviewer prose or no verdict | round fails (T27), re-queued at the same head without a new round number, then `ESCALATED(review_unavailable)`; prose is never applied as approve | `apps/web/src/lib/reviewer-output.test.ts`, `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S30 | Runner hand-off failures (no confirmed outcome, commits but no PR, uncommitted changes) | `AttemptEnded(unproven)` → `AWAITING_PUSH` or requeue; never `completed` delivery | `apps/runner/__tests__/unit/` (new case beside the existing completion tests), `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S35 | Replacement chains read current, not FAILED | a superseded predecessor attempt stays auditable but the delivery and mission situation project the current attempt; owner of next move is canonical | `apps/web/src/lib/workflow/projections.test.ts`, `apps/web/src/lib/action-queue.delivery-view.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S37 | Conflict remediation already exists | a conflicted PR with a valid pending/stalled conflict-fix task re-dispatches or repairs it instead of filing a second; the recovery effect is keyed by delivery + remediation family; UI says "Conflict fix stalled" vs "Resolve conflicts" | `apps/web/src/lib/conflict-retry.test.ts`, `apps/web/src/lib/workflow/projections.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S31 | Preflight | `create_pr` refuses a body the CI scan would reject, with the reason; runner preflight failure keeps the attempt open; CI miss is tagged `preflight_miss` | `apps/web/src/app/api/github/pr/route.test.ts`, `scripts/check-no-prod-data-local.test.ts` |
| S32 | Release PR composed only of reviewed constituents | composition attestation accepted (`approval_basis = composition`, head in `composition_heads` only); CI still gates; no second reviewer or human escalation; idempotent under duplicate delivery | `apps/web/src/lib/workflow/reducer.test.ts`, `apps/web/src/lib/workflow/review-composition.test.ts`, `apps/web/tests/db/workflow-matrix.test.ts` |
| S33 | Release PR plus a release-only novel delta (conflict resolution, changed migration or generated output) | prior verdicts cover only mapped constituents; a delta round scoped to the novel paths; can still need a human | as S32 |
| S34 | Stale constituent review, head mismatch, missing equivalence proof, incomplete set | composition proof fails closed; the release PR borrows nothing; ordinary PRs stay exact-head bound | as S32 |
| S36 | Needs You reads the kernel, not a raw worker status | Home/task surfaces project the owner of the next move; a recoverable blocker stays platform-owned; failure evidence preserved | `apps/web/src/lib/workflow/projections.test.ts`, `apps/web/src/lib/action-queue.delivery-view.test.ts`, `apps/web/src/app/app/(protected)/tasks/[id]/RealTimeWorkerView.test.tsx`, `apps/web/tests/db/workflow-matrix.test.ts` |

**The live matrix.** `apps/web/tests/db/workflow-matrix.test.ts` (`bun run test:db`) carries
every S-number: a passing case drives the seam and the real review-loop effect handlers on
real Postgres; a scenario that needs later work is a `test.todo` naming the task that owns
it (556cd910 part 2, 7ab4916f part 3) or the spec slice with no task yet, with its intended
assertions beside it. The matrix is accepted when no todo is left, and since Slice F none is
(§13.10). S14 is the static guard in `packages/core/__tests__/workflow-write-sites.test.ts`,
blocking with an empty allowlist.

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
  the routes use today (`agentRunMayActOnPr` / `taskNamesPr` in
  `apps/web/src/lib/agent-capabilities/pr-ownership.ts`, `taskScopeAllowsWorkerPr`,
  team permission registry). The authorisation decision stays in the route; the kernel
  receives `actor` and records it.
- PR #3754 (supersede route) is the live proof that "own PR only" and "caller's task
  names the PR" are different rules: the check MUST be on the **caller's** task. T20's
  actor rules: (a) the owner task's own token; (b) a task token whose own task names
  the PR (`taskNamesPr(callerTask, pr)`); (c) a human with the team permission; (d)
  the automatic detector after verification. A task token never gains `SupersessionRecorded`
  for a PR merely because the *owner's* task names it.
- Version-carrying human actions are authorised before the CAS, never after, so a
  `stale` response cannot be used as an oracle for deliveries the caller cannot read.
- `workflow_*` rows are workspace-scoped like every table; effect handlers act with
  the workspace's GitHub installation, not the caller's token.

### 17.2 Merge-policy safety rails

- The kernel **never lowers a rail.** `LandingRequested` calls the existing rail set
  unchanged (`evaluateAutoMergeSafety`, migration inspector, deny paths, size cap,
  base freshness, surface ordering, review-verdict gate, `guardMissionPrMerge`,
  `resolvePolicy`). `human` and `agent-review` tiers keep their refusals.
- `HumanApproved` makes the delivery `APPROVED` for manual merge; it never satisfies
  an unattended merge for a policy-protected path (matches the Home task that landed
  as #3751).
- Red CI and deny paths stay non-overridable; the dashboard overrides (`verdict`,
  `size`, `freshness`) keep working only from T15's override door and are written to
  `bypass`, which the ledger already counts.
- `release-executor.ts` merges (two direct `PUT .../merge` calls that skip
  `mergePullRequest` and every rail) are **intentionally out of scope** for the
  kernel's first slices (§17.6); they are release PRs, not task deliveries, and are
  called out so no one assumes the kernel gates them.
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

Release PRs and `release-executor.ts`; `missions.status` authority; task claim gates
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

Compiled from five independent read-only sweeps of the tree at the base commit. Line
numbers are the `.update(` or call line then; they drift. `W/` = `apps/web/src/`,
`WID` = `W/app/api/workers/[id]/route.ts`, `R/` = `apps/runner/src/`. Rows marked
(unverified) were seen by grep and not read in full.

### 18.1 Task, worker and attempt state writers

| Site | Writes | Trigger | Evidence checked today | Category |
|---|---|---|---|---|
| `WID` PATCH (`:592`) completion gate `:1596-2250` | 400 refusals only | `completed` PATCH, `complete_task` | `pr_required`/`auto` gates; G1–G6 below | migrate (gate gains `delivery_not_advanced`) |
| `WID:2314`, `:2929`, `:4055` | `workers.status`, `completedAt`, `waitingFor`, `commitCount`, `lastCommitSha` | every PATCH | CAS on `NOT IN terminal` / `finalWriteGuard` | execution fact; stays |
| `WID:3580` | `tasks.status`, `result`, `context`, `loopState` | terminal PATCH | contract, loop, `shouldAutoRetry` | execution fact; stays; emits `AttemptEnded` |
| `WID:1745`, `:1831`, `:1909` | `workers.prUrl/prNumber/branch/prBaseRef` | completion auto-detect / adopt | existence of a PR on the branch; head match only against self-reported `lastCommitSha` | migrate (PrBound with live head compare) |
| `WID:1184` | `prUrl`, `prNumber` | self-reported PR, `verifyReportedWorkerPr` | GitHub when App installed | external-fact ingestion |
| `WID:1958-1975`, `:2488`, `:2718`, `:2816`, `:2888`, `:4188` | `workers.status='failed'`, `tasks.status` pending/failed, `context` | refusal, deferral, budget, mount gap, auth failover | task not cancelled | execution fact; stays |
| `WID:3622-3672` | `tasks.status`, `releaseResult` | release outcomes | release verdict | out of scope (release) |
| `WID:4906` | `result.effectiveVerdict` | reviewer completes | file list / confidence | migrate (→ round `effective_verdict`) |
| `WID:5290-5330` | INSERT fix task with `reviewerRetryPrNumber/HeadSha`, `iteration` | request-changes outcome | iteration cap, unique index | migrate (→ `dispatch_fix` effect) |
| `WID:5392`, `:5195` / `lib/auto-merge.ts:1055` | notify, `reviewerExhaustedHeadSha` | escalate / exhaustion | CAS on context key | migrate (→ T7 effect) |
| `W/app/api/workers/claim/route.ts:2396`, `:2587`, `:2075` | `tasks.status` assigned/pending/failed, `claimedBy` | claim, rollback | CAS on `pending`/`assigned` | execution fact; stays; adds `FixClaimed` |
| `W/lib/stale-workers.ts:695`, `:853`, `:1034`, `:1068` | `workers.status='failed'`, `tasks.status='failed'` | stale, offline, stuck input | none; not CAS (`inArray(id)`) | execution fact; stays; add CAS; emit `AttemptEnded(lost)` |
| `W/lib/stale-workers.ts:251` | `tasks.status='completed'`, `result.sha` | reaper auto-complete | `checkWorkerDeliverables`: bare `commitCount>0` | **migrate** (G8) |
| `W/lib/stale-workers.ts:109`, `:155`, `:171`, `:200`, `:288`-`:336`, `:1203`-`:1281` | task failed/pending, `infraRetryCount`, answers | reaper retry budget, loop wait, unresumed answers | `exitCause`, counts | execution fact; stays |
| `W/app/api/tasks/cleanup/route.ts:48`, `:82`, `:190`, `:266` | task/worker status; `:266` completes an assigned task with `result.sha` | cleanup | `:266` bare `commitCount>0` | `:190`/`:48`/`:82` execution fact; **`:266` migrate** (G9) |
| `W/lib/interactive-detach.ts:116`, `:200` | worker status; `tasks.status='pending'` | TTL / task ended | CAS | execution fact; stays |
| `W/lib/task-cancel.ts`, `tasks/[id]/route.ts:528`, `tasks/bulk/route.ts:153`, `workers/[id]/interrupt/route.ts:96,127`, `tasks/[id]/reassign/route.ts:102-171`, `workers/[id]/recover/route.ts:111`, `workers/[id]/respond/route.ts:240-395` | task/worker status | human and API actions | mixed CAS | execution fact; stays; cancel emits `AttemptEnded`/`DeliveryFailed` |
| `W/lib/supersession-store.ts:275`, `:290` | `tasks.status='cancelled'`, `workers.status='failed'` | supersession rules | CAS on both | migrate (rules become part of T5/T6/T17/T18 effects) |
| `W/lib/task-dependencies.ts:438`, `:781` | task cancelled/failed | dependency resolution | none (`inArray(id)`) | execution fact; stays (reads delivery) |
| `W/lib/loop-webhook.ts:72-104` | `tasks.status='completed'`, `prLifecycleStatus='merged'` | `pr_merged` loop exit | `loopState` | migrate (consumer of `PrMerged`) |
| `W/lib/credential-recovery.ts:82`, `mission-surface-audit.ts:453`, `visual-review-decisions.ts:283,824` | task status | recovery, audits | CAS | intentionally out of scope |
| `W/app/api/webhooks/ingest/route.ts:173,182`, `linear-webhook.ts:170`, `github/webhook/route.ts:332,352` (issues) | task status from external systems | external events | CAS / id | external-fact ingestion (task-level); stays |
| `R/workers.ts:1536`…`:6647`, `R/recovery.ts`, `R/worker-sync.ts` | PATCH status/metrics | runner lifecycle | `prCreated` flag, bounded push nudges `:4781-4864`; `:5097` completion has no remote check | execution fact; stays; add `remoteHeadSha`/`unpushedCommits` |
| `W/lib/ci-failure-inspect.ts` `isBuilddWorkerCommit` and its callers in `ci-failure-retry.ts`, `ci-red-sweep*.ts` | decides whether a failing commit is the worker's own, which advances `context.iteration`; bot-identity-only | **migrate: delete** (§6.9) |
| `W/lib/ci-failure-retry.ts:180,487,612,636`, `conflict-retry.ts:241,422,812`, `migration-collision-retry.ts`, `app/api/prs/[prNumber]/retry-ci/route.ts`, `prs/[prNumber]/apply-recommendation/route.ts:200`, `dead-zone-sweep.ts` (retry insert) | INSERT repair/fix tasks with `*RetryPrNumber/HeadSha`; `escalateCiRedHead` writes `tasks.status='failed'`, `context` | CI red, conflict, human apply | unique indexes, attempt caps | migrate (→ effects, T10/T12/T23) |
| `W/lib/auto-merge.ts:991,1071,1158` | `context.conflictExhaustedHeadSha`, `reviewerExhaustedHeadSha`, `reviewContractFailureEscalated` | caps hit | CAS on key (unverified) | migrate (budgets move to delivery) |
| `W/lib/pr-review-request.ts:418`, `approval-carry-forward.ts:27`, `base-refresh.ts:225`, `pr-landing-marker.ts`, `pr-landing-handoff.ts`, `pr-landing-alert-deps.ts` | `context.reviewCallbackFiredAt`, `equivalentHeadShas`, `baseRefresh`, `landing`, `landingHandoff` | callbacks, carry-forward, refresh, landing | CAS (some not) | callback/refresh bookkeeping stays; `equivalentHeadShas` and `landing` decision content migrate |
| `W/lib/task-evidence-store.ts`, `task-shipped-store.ts`, `task-pr-attach.ts:151,172`, queue-stall, notify stamps | `tasks.result`, `context` stamps | evidence, shipped, attach | mixed | projection-only / out of scope |

**Completion-gate holes found (G-list):** G1 only the `pr_required` fallback compares
the PR head with `lastCommitSha`, which is itself runner-reported; G2 any `prUrl` on
the row passes, with commits after the PR opened never compared; G3 auto-detect adopts
an open PR on the branch without a head compare (a retry's unpushed commits hide
behind an older PR); G4 an artifact satisfies `auto`/`artifact_required`/`none` even
with `commitCount>0`; G5 a row with `mergedAt` skips the gate even if the merge was a
different PR; G6 `commitCount=0` from a worktree that never diverged completes with
nothing; G7 the runner completes with no remote check; G8/G9 reaper and cleanup
promote bare local commits to `completed`; G10 several reaper writes are `inArray(id)`
without a status CAS; G11 dependents trust whichever of these set `tasks.status`.

### 18.2 PR-state and fact writers (`workers` PR columns)

| Site | Writes | Category |
|---|---|---|
| Webhook `handlePullRequestEvent` (`github/webhook/route.ts:620-1050`): base-ref sync `:668`, retarget repair `:735`, open-state lifecycle `:822/833`, closed `:1023` (via `pr-merge-stamp.ts:41`), `:1048` | `prBaseRef`, `prLifecycleStatus` (`pr_open`/`conflict`/`closed`/`merged`), `prIsDraft`, `conflictDetectedAt`, `mergedAt` (receipt time) | external-fact ingestion → `recordPrFact`; **no terminal guard in the open-state write; closed-unmerged stamps one row only** |
| Webhook `handleCheckSuiteEvent` (`:383`, `:412`, `:472`) | `prLifecycleStatus` `ci_running`/`ci_failed`/`ci_green` | external-fact ingestion; terminal guard is read-then-write (TOCTOU); event SHA not compared to current head |
| `lib/register-local-pr.ts:26` | `prUrl`, `prNumber`, `prBaseRef`, `lastCommitSha`(=GitHub head), `prLifecycleStatus='pr_open'` | external-fact ingestion → `PrBound`; stop writing GitHub head into `lastCommitSha` |
| `lib/pr-state-refresh.ts:312` | clocks, `mergedAt`, `merged`/`closed`/CI status | external-fact ingestion (importer); `WHERE id` after a round trip |
| `lib/pr-reconcile.ts:95,307,329,439,520,547` | clocks, `mergedAt`, `merged`/`closed`/`unresolvable`/`conflict` | external-fact ingestion (importer) |
| `lib/dead-zone-sweep.ts:267-311` | `mergedAt`, `merged`/`closed`/`conflict`, `conflictDetectedAt` reset each re-entry, red CI mapped to `conflict` | external-fact ingestion; **migrate** the overloaded `conflict` write |
| `lib/pr-state-reconcile.ts:127` | `mergedAt` (set/null), maps every open PR to `pr_open` | **migrate: delete** (regresses state) |
| `app/api/admin/backfill-merged-prs/route.ts:89`, `packages/core/scripts/backfill-mergedat.ts:157,165` | `unresolvable`, `mergedAt`, `merged`/`closed` | external-fact ingestion; offline import allowed |
| `lib/dead-pr-shutdown.ts:396` | `prLifecycleStatus='closed'` | migrate (after a GitHub close the kernel records `PrClosedUnmerged`) |
| `lib/pr-merge-stamp.ts:31` | `mergedAt`, `merged` on all rows | projection-only (`stamp_pr_rows`) |
| `app/api/github/pr/route.ts:1123,726,772,494,579,1722,1978,2016` | `prUrl`, `prNumber`, `prOpenedBaseSha`, `prBaseRef`, `mergedAt`, `merged` | `create_pr`/adopt: external-fact ingestion → `PrBound` (reset rules on override); merge branches: **migrate** (T15/T16) |
| `app/api/prs/[prNumber]/merge/route.ts:257` | `mergedAt`, `merged` | migrate |
| `lib/mission-pr.ts:658,792,701` | PR fields, `pr_open`, `merged`, owner-row inserts | external-fact ingestion + `DeliveryOpened` for mission PR owner rows |
| `lib/pr-review-request.ts:173` | INSERT adopted owner worker | migrate (`PrBound` adoption; repo-scoped key) |
| `lib/loop-webhook.ts:72` | `merged` | migrate |
| `lib/pr-supersession.ts:236,285,315`, `lib/pr-supersession-detect.ts:342,384,511`, `retry-pr-supersession.ts` | `supersededBy*`, `abandoned*`, `supersessionScan` | `supersededBy*`/`abandoned*`: **migrate** (T20/T21; today no closed-PR requirement, no overwrite guard); `supersessionScan`: projection-only |
| `lastCommitSha` writers: `WID:325,1057` (runner), `register-local-pr.ts` | local head | split: runner stays a local fact; GitHub head moves to `current_head_sha` |

Webhook event map: `pull_request` (opened/reopened/synchronize/ready_for_review/edited/
closed/converted_to_draft; other actions only sync `prBaseRef`), `check_suite`
(`requested`/`rerequested`→`ci_running`, completed `failure`/`success`; cancelled,
timed-out, neutral, skipped, `action_required` return without writing), `pull_request_review`
and review comments (emit only), `push`, `workflow_run`, `issues`, installation events.
No handler for `check_run`, `status`, `issue_comment`. No delivery de-duplication;
`X-GitHub-Delivery` is only logged.

Further defects found by the sweep, each fixed by a rule above: late open-state events
overwrite terminal state (no guard in the `WHERE`); two different CI derivations
(`allCheckSuitesPassed` vs `ciLifecycleFromSuites`); `conflict` never cleared except by
a `pull_request` event; a `closed` row is invisible to every sweep so a lost `reopened`
strands it; two clocks for `mergedAt`; the webhook, create_pr and merge routes never
write `prLastVerifiedAt`; owner lookup by `(workspaceId, prNumber)` without repo.

### 18.3 Review writers and readers

| Site | Role | Category |
|---|---|---|
| `lib/reviewer.ts` `createReviewerTask` `:451`, `findLiveReviewerTaskForHead :420`, `resolvePriorVerdict :201` | create/dedupe reviewer task, bind `context.headSha`, `subject_head_sha` | migrate (T5/`dispatch_review`; bound head moves to round) |
| `lib/reviewer-subscribers.ts` `maybeDispatchReviewer :78`, `maybeReDispatchReviewer :342`, slots `:489`,`:508` | review on open, re-review on push | migrate (decision → reducer; slots become fact hints) |
| `app/api/github/pr/review/route.ts` (`request_pr_review`, `:255-381`), `app/api/prs/[prNumber]/re-review/route.ts`, `lib/stale-approval-re-review.ts:79`, `lib/pr-re-review.ts:43`, `app/api/github/pr/route.ts:80` (`requestIntegrationBranchReview`) | callers of reviewer dispatch | migrate (all call T5; fix `lastCommitSha`-as-head and the non-force "returns stale review" behaviour) |
| `WID:4745` `handleReviewerOutcomeIfNeeded` (+ `:3255-3440` contract enforcement, `:3924` step) | verdict handling; posts review; approve → landing; request-changes → fix; escalate | migrate (T6); **not idempotent today** |
| `lib/reviewer.ts:1571,1613` `supersedeReviewerTaskOnMerge`, `supersedeFixTaskOnApproval`; `lib/supersession.ts:303` rules; `supersession-store.ts` | cancel superseded tasks | migrate (effects of T6/T17/T18) |
| `lib/pr-review-status.ts:141` `derivePrReviewStatus`, `pr-review-request.ts:44,339` `findReviewTaskForPr`/`readPrReviewStatus` | the only definition of "verdict in force"; JSONB lookup, newest row wins, no head filter | migrate (read rounds); `supersession-store.ts:166` and `post-session-store.ts:45` copy its precedence |
| `lib/review-verdict-gate.ts:129,186`, `approval-carry-forward.ts:35` | merge gate over status; carry-forward | migrate (read delivery); carry-forward becomes T13 |
| `lib/reviewer-gate.ts:197,333,387,411,445` `resolveReviewerGate` | UI/inbox "who acts" | projection-only (reads delivery) |
| `lib/github-approval.ts:5` `readGithubApproval` | live GitHub human approval | external-fact ingestion (`HumanApproved`) |
| `lib/review-subscribers.ts:41,109,176` | merged-over-verdict classification; GitHub review → mission note | projection-only / T17 effect |
| `lib/github.ts:259` `postPrReview` | GitHub review submit; never throws | effect handler (`post_review`); MUST check `posted` |

### 18.4 Landing, merge and mission completion

| Site | Role | Category |
|---|---|---|
| Merge API wrapper `lib/github.ts:184` `mergePullRequest` | writes nothing | effect handler (`merge_call`) |
| Doors: `lib/auto-merge.ts:777` `tryAutoMergeWorkerPr`; `lib/pr-landing.ts:882` `landPr`; `app/api/prs/[prNumber]/merge/route.ts:566`; `app/api/github/pr/route.ts:1956`; `webhook/route.ts:1466` (release PR) | five merge doors | first four migrate to T15/T16; release PR door out of scope |
| `lib/release-executor.ts:188,857` | direct merge of release PRs | intentionally out of scope |
| `landPr` callers: merge route `:375`, `PUT /api/github/pr :1704`, webhook `:527`, `WID:5121`, `surface-ordering-wake.ts:84`, `pr-landing-sweep-deps.ts:199`; `tryAutoMergeWorkerPr` callers: webhook `:587,600,1372`, `WID:5142,5170`, `surface-ordering-wake.ts:110` | entry points | migrate (become `LandingRequested` callers) |
| `lib/pr-landing-marker.ts`, `pr-landing-handoff.ts`, `pr-landing-sweep*.ts`, `pr-landing-alert*.ts`, `pr-landing-ownership.ts`, `pr-landing-metrics.ts` | landing bookkeeping and sweep | migrate (decision data → delivery; sweep → effect re-enqueue; metrics read transitions) |
| `lib/base-refresh.ts:425`, `pr-branch-update.ts`, `conflict-retry.ts`, `dead-zone-sweep.ts` | refresh/conflict repair | migrate (`refresh_branch`, T12) |
| `lib/mission-pr.ts` `finalizeMissionPrMerge :1191`, `guardMissionPrMerge :1144`, `findMissionPrOwner :952` | mission PR gate, branch deletion | `finalize` migrates to effect; guard stays (rail) |
| `lib/mission-completion.ts` `canCompleteMission :251`, `completeMissionIfVerified :786`; `packages/core/pr-shipped.ts` `prShipState :40`, `deriveLineageSupersession :148`; `packages/core/mission-helpers.ts:327` (`all_prs_merged`) | mission completion | readers; keep logic; feed from delivery projection |
| `app/api/missions/[id]/route.ts:397,583`, `mission-loop.ts:482`, `mission-archive.ts:90`, `mission-budget.ts:32`, `heartbeat-circuit-breaker.ts:129` | `missions.status` | intentionally out of scope |
| `gate_events` (`packages/core/gate-events.ts`) | refusal ledger | stays; kernel adds slugs (`workflow_effect_dead`, `workflow_transition_rejected`) |
| Cron: `app/api/cron/pr-reconcile/route.ts`, `queue-stall/route.ts`, `mission-invariants/route.ts`, `dispatch-drain/route.ts` | sweeps and drain | migrate to importers/re-enqueuers; add drain |

### 18.5 Projections and readers (re-derivations to retire in Slice E)

| Reader | Re-derives | Cheapest canonical read |
|---|---|---|
| `lib/pr-presentation.ts:48` `derivePrDisplayState` | canonical today for display | extend into `getDeliveryView` |
| `derivePrLifecycle :78`, `isPrMerged :86` | second map ignoring `mergedAt` | **retired (Slice E)**: `resolvePrDisplayState` + `PR_PILL` |
| `components/TaskCard.tsx:132,329,343`; `lib/stage.ts:59` `deriveStage` | duplicate `PR_LIFECYCLE`, own state machine without `conflict`/`unresolvable` | **retired (Slice E)**: `stageForDelivery`; legacy via `derivePrDisplayState` |
| `lib/action-queue.ts:128,161,222,1194,1236,1285` | `resolveMergeChip` 10-rule precedence; `partitionEscalations` omits `unresolvable`/`mergedAt` | one landing-state row |
| `app/app/(protected)/home/page.tsx:789,1220,1354-1438,504` | assembles inputs inline; three SQL/JS filters; refresh-before-read | `getDeliveryView` per PR |
| `lib/pr-attention.ts`, `lib/pr-list.ts:93-256` (`list_prs`), `app/api/github/pr/route.ts:149` (`get_pr` `canonicalState`) | own terminal sets and ranking | view |
| `lib/explain.ts:266,708-716,925`, `explain-because.ts` | local `unmergedPr` conditions | `because[]` from `workflow_transitions` |
| `lib/mission-state-view.ts`, `lib/mission-card-view.ts:182,411`, `lib/mission-board.ts`, `lib/mission-pulse.ts`, `lib/condensed-timeline.ts`, missions/[id] page (`:142-165` refreshes during render, `:536-1064` inline predicates), `CondensedTimeline.tsx`, `tasks/[id]/page.tsx` (~12 inline expressions, `:1615` synthesises `merged`), `PrDetailsCard.tsx`, `PlanChainView.tsx`, `task-eyebrow.ts`, `task-presentation.ts:342` | mix of canonical accessor and inline predicates | `unmergedPrs` from one helper; one `DeliveryView` call per page |
| `app/api/tasks/[id]/summary/route.ts`, `app/api/explain/route.ts`, `health/_lib/health-data.ts`, chat `load-pr-object.ts`, `PrObject.tsx`, `TaskObject.tsx`, `dock-model.ts:68-72` | raw pass-through; chat dock "Landed" for a completed task with an open PR | add derived `deliveryState` next to raw fields |
| `lib/pr-activity-comment.ts` (~18 writer modules) | parallel event log, read-modify-write, last 12 entries | render of transitions |
| `lib/pusher.ts` | no PR event; several writers emit none | `projectDelivery` emits one event |

### 18.6 Checklist: direct writes to lifecycle fields, by disposition

Legend: **M** migrate (becomes a transition or an effect), **P** projection-only
(written only by `projectDelivery`/`stamp_pr_rows`), **F** external-fact ingestion
(only through `recordPrFact`/`ingestFact`), **O** intentionally out of scope. Each box
is a site to tick off in the Phase 2 PR that moves it.

**Migrate (M)**
- [ ] `WID:5290-5330` fix-task insert on request-changes
- [ ] `WID:4745-5404` `handleReviewerOutcomeIfNeeded` branches (approve landing, escalate notify, exhaustion)
- [ ] `WID:4906` `effectiveVerdict` write
- [ ] `WID` completion gate `:1596-2250` (add `delivery_not_advanced`; G1–G3 in Slice D)
- [ ] `WID:1745`, `:1831`, `:1909` PR auto-detect / adopt writes without head compare
- [ ] `lib/reviewer.ts` `createReviewerTask`, `supersedeFixTaskOnApproval`, `supersedeReviewerTaskOnMerge`
- [ ] `lib/reviewer-subscribers.ts` `maybeDispatchReviewer`, `maybeReDispatchReviewer`
- [ ] `lib/stale-approval-re-review.ts`, `lib/pr-re-review.ts`, `app/api/prs/[prNumber]/re-review/route.ts`, `app/api/github/pr/review/route.ts`, `app/api/github/pr/route.ts` (`requestIntegrationBranchReview`)
- [ ] `lib/pr-review-request.ts` `findReviewTaskForPr` / owner lookup / `insertPrOwnerWorker`
- [ ] `lib/supersession-store.ts:275,290` and rules in `lib/supersession.ts`
- [ ] `lib/ci-failure-retry.ts` (`:180,487,612,636`), `app/api/prs/[prNumber]/retry-ci/route.ts`
- [x] `lib/conflict-retry.ts` (`:241,422,812,893,974`), `lib/migration-collision-retry.ts`, `lib/dead-zone-sweep.ts` retry insert (kernel-owned PRs, §13.4)
- [x] `lib/auto-merge.ts` `:777` merge door (Slice C: an adapter calling `LandingRequested` for a kernel-owned PR)
- [ ] `lib/auto-merge.ts` `:991,1055,1071,1141,1158` escalation stamps
- [x] `lib/pr-landing.ts` `landPr` merge call (Slice C: T15/T16; its rails, marker, handoff and sweep are unchanged)
- [ ] `lib/pr-landing-marker.ts`, `pr-landing-handoff.ts`, `pr-landing-sweep*.ts` decision data → delivery
- [x] `app/api/prs/[prNumber]/merge/route.ts:566,257`; `app/api/github/pr/route.ts:1956,1722,1978,2016` (Slice C, kernel-owned PRs)
- [x] `lib/stale-workers.ts:251` auto-complete; `app/api/tasks/cleanup/route.ts:266` assigned-task complete (Slice A part 2: a kernel attempt is never promoted from local commits; `AttemptEnded(lost)`)
- [x] `lib/pr-supersession.ts:236,285`, `lib/pr-supersession-detect.ts:384`, `app/api/github/pr/supersede/route.ts` (Slice D: T20/T21 for a kernel-owned PR; the route authorises on the caller's task)
- [ ] `lib/dead-pr-shutdown.ts:396`; `lib/loop-webhook.ts:72`
- [x] `lib/pr-state-reconcile.ts:127` (delete); `lib/dead-zone-sweep.ts:302` `conflict` overload (Slice B part 1)
- [x] webhook `handlePullRequestEvent` open-state write `:822/833` and closed `:1048`; `check_suite` writes `:383,412,472` (Slice B part 1: through `recordPrFact`)
- [ ] `lib/approval-carry-forward.ts:27` `equivalentHeadShas` append
- [ ] `lib/pr-activity-comment.ts` writers (~18 modules) → `render_activity`
- [ ] `lib/ci-failure-inspect.ts` `isBuilddWorkerCommit` and every `context.iteration` read used for a decision (CI, review, conflict families)
- [ ] `app/api/prs/[prNumber]/retry-ci/route.ts` manual CI path (ignores the workspace cap, restarts at 0)
- [x] `lib/migration-collision-retry.ts`, `lib/conflict-retry.ts` dispatch decisions (mechanical-first, §6.7; §13.4)
- [ ] `lib/ci-red-sweep*.ts`/`ci-red-queue.ts` per-PR retry fan-out (§6.10)
- [ ] `lib/reviewer-output.ts` / `WID:3255-3440` prose-verdict fallback (§6.6, T27)

**Projection-only (P)**
- [x] `workers.supersededBy*`, `abandoned*` (Slice D: `project_supersession`)
- [x] `lib/pr-merge-stamp.ts:31` `stampPrMergedOnAllRows` (Slice B part 1: a funnel caller); `tasks.status='completed'` on merge (Slice C: `emit_pr_merged` → `lib/pr-merged-work.ts` for a kernel-owned PR)
- [ ] mission notes for reviewer verdicts; `workers.mergedAt`/`prLifecycleStatus` after a transition (done, Slice B part 1: `stamp_pr_rows`)
- [ ] `tasks.result.shipped`, evidence stores (`task-shipped-store.ts`, `task-evidence-store.ts`)

**External-fact ingestion (F)**
- [ ] `lib/register-local-pr.ts:26`; webhook base-ref sync `:668` and retarget `:735`
- [x] `lib/pr-state-refresh.ts:312`; `lib/pr-reconcile.ts` writers; `lib/dead-zone-sweep.ts:267-311` merged/closed (Slice B part 1)
- [x] `app/api/admin/backfill-merged-prs/route.ts:89`; `packages/core/scripts/backfill-mergedat.ts` (Slice B part 1)
- [ ] `lib/mission-pr.ts:658,792`; `create_pr` adopt/mirror writes (`github/pr/route.ts:494,579,726,772,1123`)
- [ ] `lib/github-approval.ts` reads; runner metrics `WID:337,1057`, `R/worker-sync.ts`

**Intentionally out of scope (O)**
- [ ] Execution-state writes of `tasks.status` and `workers.status` (claim, cancel, reaper retry budgets, budget/auth/mount deferrals, interactive detach, answers, bulk and Linear/ingest webhooks)
- [ ] Release PR merges and release rows (`release-executor.ts`, `release/subscribers.ts`, `webhook/route.ts:1466-1555`)
- [ ] `missions.status` writers; credential recovery; visual-review/audit task writes
- [ ] Context stamps unrelated to delivery (`queueStall*`, notification stamps, `task-kind`, `task-role-apply`, `subject-intake-db`, `approve-plan`)
- [ ] `task_dispatch_outbox` and `gate_events` (patterns reused, tables unchanged)

---

## 19. Acceptance criteria

- AC-1: GIVEN a delivery in `FIXING` bound to `(H1, r1, a1)` WHEN the attempt ends `success` and the live GitHub head is still `H1` THEN the transition to `AWAITING_REVIEW` is rejected, the delivery ends in `AWAITING_PUSH`, a `push_recovery` effect exists, and no review round is created.
- AC-2: GIVEN a decided round 1 at head `H1` WHEN a review is requested again for `H1` without a human `force` THEN the command is `rejected(head_already_reviewed)`.
- AC-3: GIVEN `APPROVED` at `H0` WHEN the live head becomes `H1` and neither content-equivalence nor an own-refresh match holds THEN the delivery is `AWAITING_REVIEW` with a delta round bound to `H1` created in the same statement.
- AC-4: GIVEN two writers apply a transition at the same `version` THEN exactly one is `applied` and the other is `stale` carrying the current state, version, head and round.
- AC-5: GIVEN a reviewer verdict whose round head differs from `current_head_sha` THEN the verdict is stored, no GitHub review is posted for it, no merge starts, and the state is unchanged.
- AC-6: GIVEN any transition THEN its follow-up effect rows exist if and only if the transition committed.
- AC-7: GIVEN a reconciler run THEN no `workflow_deliveries.state` or guarded column is written outside `apps/web/src/lib/workflow/` (checked by the write-site guard test).
- AC-8: GIVEN `PrMerged` WHEN any later `synchronize`, `check_suite` or `opened` fact arrives THEN the delivery stays `MERGED` and no fact-cache column regresses.
- AC-9: GIVEN `SupersessionRecorded` for a delivery not in `CLOSED_UNMERGED`, or whose target PR is not merged THEN it is rejected, and an existing edge is never overwritten.
- AC-10: GIVEN a task with a delivery WHEN the reaper or cleanup finds its worker dead with only local commits THEN `tasks.status` is not set to `completed`, and the delivery is `AWAITING_PUSH`.
- AC-11: GIVEN `workflowKernel=false` THEN no new delivery opens, an existing one is released to legacy and stays there, and a PR with no delivery behaves exactly as before the kernel.
- AC-12: GIVEN `canCompleteMission` inputs from before the change THEN its results are unchanged.
- AC-13: GIVEN a worker pushes a CI fix under any git author identity WHEN the head advances during or just after its attempt THEN the push is attributed to that attempt by SHA set and the `ci` ledger row exists with `attempt_no` allocated at dispatch.
- AC-14: GIVEN a ledger family with `max_attempts` reached WHEN another dispatch is requested THEN no task is created and the delivery is `ESCALATED(ci_exhausted)` (or the family's equivalent); a human retry records `BudgetExtended` and is never numbered 0.
- AC-15: GIVEN an open trunk incident for a signature WHEN CI on any delivery fails with that signature THEN no per-PR `ci` attempt is dispatched, the delivery is `BLOCKED_ON_TRUNK`, and exactly one trunk-fix attempt exists for the incident.
- AC-16: GIVEN a dispatched fix, CI or conflict task whose target is merged, approved at the current head, green, or no longer conflicting at dispatch or claim time THEN the ledger row is `skipped`, no worker failure is recorded, and replay changes nothing.
- AC-17: GIVEN concurrent `render_activity` runs THEN the comment converges to a render of the latest delivery version, `Merged` is the headline of a merged delivery whatever is appended later, and exactly one comment exists.
- AC-18: GIVEN a behind-only branch or a byte-identical migration renumber THEN it completes as a mechanical attempt with no agent task and consumes no agent budget; GIVEN a textual conflict or a non-identical renumber THEN an agent attempt is allocated.
- AC-19: GIVEN a reviewer ends with prose and no structured verdict THEN the round is `failed` (T27), never approved, and the delivery is `ESCALATED(review_unavailable)` once the bounded retry is spent.

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
- Pattern sources: `packages/core/dispatch-outbox.ts`, `apps/web/src/lib/dispatch-authority.ts`, `packages/core/gate-events.ts`.
- Wired in Slice A part 1: `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/prs/[prNumber]/re-review/route.ts`, `apps/web/src/app/api/cron/pr-reconcile/route.ts`, `apps/web/src/lib/reviewer-subscribers.ts`.
- New (Phase 2): `apps/web/src/lib/workflow/*` (the route seam is `seam.ts`; landing is `landing.ts` and `pr-landing-effects.ts`; a closed PR's resolution is `supersession-effects.ts`; mission completion's input is `delivery-ship.ts`), `apps/web/src/lib/pr-merged-work.ts`, `packages/core/__tests__/workflow-write-sites.test.ts`, `apps/web/tests/db/workflow-seam.test.ts`.

## 23. Out of scope

See §17.6 and §21.
