---
title: Workflow State Kernel
status: draft
owner: max
last_verified: 2026-10-06
summary: One kernel MUST own each task-to-PR-to-review-to-merge delivery's state, advance it only by version-checked transitions citing GitHub-confirmed evidence, and leave other lifecycle columns fact caches or projections.
domain: tasks
surfaces: [apps/web/src/app/api/workers/[id]/route.ts, apps/web/src/app/api/github/webhook/route.ts, apps/web/src/lib/pr-landing.ts, apps/web/src/lib/pr-review-status.ts]
related: [mission-task-lifecycle, pr-lifecycle-reconciliation, task-dispatch-authority, surface-merge-ordering]
keywords: [workflow kernel, delivery state, AWAITING_PUSH, review round, head sha binding, outbox, CAS, fix_ended, stale verdict, write sites]
verified_by: []
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

`tasks.delivery_id` (nullable) and `tasks.delivery_role`; `workers` keep their rows
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
`equivalent_head_shas` its delivery recorded, and the `landed_sha` in the composed
history) and an explicit `novel_delta` of `none`, `present` (with paths) or
`unverifiable`.

The reducer (`CompositionAttested`, from `AWAITING_REVIEW`, head must be current) checks
each constituent against the ledger: the round is decided `approve` at exactly
`reviewed_head_sha`, and `landed_sha` is that head or a recorded equivalent. With
`none` the delivery becomes `APPROVED` with `approval_basis = composition` and the head
in `composition_heads`; `approved_heads` is untouched and no round is decided at the
aggregate head. With `present` a `delta` round scoped to the novel paths is queued.
`unverifiable` or any failed check claims nothing (`rejected`). Ordinary verdicts stay
exact-head (§8): `headCoverage` reports `verdict`, `human`, `composition` or `none`,
and `PrMerged` records which one covered the merged head.

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
| T15 | `LandingRequested(door)` (the five merge doors, sweep) | `APPROVED`; `CHANGES_REQUESTED`/`ESCALATED` only for the dashboard override door | live read: open, head == `current_head_sha`; `landPr` rails pass (CI, deny paths, size, migration inspector, freshness, surface order, review gate, mission-PR gate); override recorded in `bypass` and never covers red CI or deny paths | `LANDING` | `merge_call(head)` | `merge:{repo}#{pr}:{head}` | head moved → `stale` and T3 path |
| T16 | `MergeCallResult` | `LANDING` | GitHub response | merged → T17 (not asserted here: the merged fact comes from a live read); `indeterminate` → stay, `verify_merge` effect; behind/out-of-date → `REPAIRING(behind)`; conflict → `REPAIRING(conflict)`; policy/other refusal → `ESCALATED(landing_needs_human)` | `refresh_branch` or alert | `mergeresult:{repo}#{pr}:{head}` | result for a head that is no longer current: ignored (`stale`) |
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
("time-bomb") failures are the same case seen first on trunk. Thresholds are policy
values, defaulting to disabled (`workflowKernel` on, `trunkBreaker` off) so merging
the kernel changes nothing until a workspace opts in (DESIGN-FORMAT rule 2); the
safety bound is one trunk-fix attempt per incident and the existing attempt cap on it.

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
| `merge_call` | `PUT /pulls/{n}/merge` with `sha` pinned | the pin makes a replay at the same head a no-op or a clean refusal; `indeterminate` triggers `verify_merge` |
| `verify_merge` | read PR; emit `PrMerged` fact if merged | read-only |
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
| `sweepClosedUnsupersededPrs` (`pr-supersession-detect.ts`) | `scan_supersession` effect; auto-record goes through T20 |
| `completeMissionIfVerified` callers | unchanged readers (§17.3) |

Render-time reads: pages that call `refreshStaleWorkersForWorkspaces` or
`refreshWorkerMergeStateIfStale` while rendering (Home, mission and task pages) MUST
switch to "enqueue an import and render what is stored".

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
| `workers.prLifecycleStatus` | mixed: facts (`ci_*`, `conflict`, `merged`, `closed`, `unresolvable`) used as state | **fact cache** for CI/mergeable/merged/closed plus `unresolvable` (a reconcile-bookkeeping flag). No gate or UI reads it to decide workflow; they read `workflow_deliveries`. Written only through `recordPrFact`, which enforces terminal-wins in the `WHERE`. Retire the redundant `pr_open` meaning. |
| `workers.mergedAt` | merge fact with two clocks | GitHub `merged_at` only; receipt-time stamping removed |
| `workers.conflictDetectedAt`, `prLastCheckedAt`, `prLastVerifiedAt`, `prCheckFailureCount`, `prUnresolvableReason` | reconcile bookkeeping | unchanged; owned by the importers |
| `workers.supersededBy*`, `abandoned*` | the supersession edge | **projection** of T20/T21, written by `projectDelivery`; `canCompleteMission` and `prShipState` keep reading them until Slice D |
| reviewer tasks' `result.structuredOutput`, `effectiveVerdict` | raw model output and server override | raw output stays a fact; the decision lives on `workflow_review_rounds.effective_verdict` |
| `tasks.context.iteration/maxIterations`, `reviewerRetry*`, `ciRetry*`, `conflictRetry*` | budgets and dedupe | budgets move to `fix_attempts`, `current_round`, `repair_attempts`; dedupe keys move to `workflow_effects.dedupe_key` |
| `tasks.context.landing`, `landingHandoff`, `baseRefresh` | landing and refresh bookkeeping | `landing` marker content that decides "what next" moves to delivery attributes/effects; `baseRefresh` stays as refresh-effect state |
| `mission_notes` (reviewer/escalation notes) | human-readable record | projection (written by effects from transitions) |
| PR activity comment | parallel log by ~18 writers | **render** of `workflow_transitions` (`render_activity`); `parsePrActivityState` stops being a read-modify-write source |
| `missions.status` | mission aggregate | unchanged authority; its completion gate reads deliveries |

Readers move to one accessor, `getDeliveryView(...)`, extending `derivePrDisplayState`
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
| `apps/web/src/lib/ci-failure-retry.ts`, `ci-failure-inspect.ts` (`isBuilddWorkerCommit` deleted), `app/api/prs/[prNumber]/retry-ci/route.ts` | CI family on the ledger with provenance (§5.7, §6.9) |
| `apps/web/src/app/api/github/pr/review/route.ts`, `apps/web/src/app/api/prs/[prNumber]/re-review/route.ts` | callers of T5; stop using `worker.lastCommitSha` as head and hard-coded `iteration:0,maxIterations:3` |
| `apps/runner/src/workers.ts`, `apps/runner/src/git-operations.ts` | completion payload carries `remoteHeadSha`, `unpushedCommits` |
| `apps/web/src/lib/stale-workers.ts`, `apps/web/src/app/api/tasks/cleanup/route.ts`, `apps/web/src/lib/worker-deliverables.ts` | stop auto-completing on bare commit count for tasks with a delivery |

Later slices add the files named in §14.

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
| **B** | conflict and migration families (mechanical effects, §6.7), trunk circuit breaker and `BLOCKED_ON_TRUNK` (§6.10, opt-in), fact ingestion funnel and terminal-wins: `recordPrFact` replaces every writer of `prLifecycleStatus`/`mergedAt` (≈25 sites, §17.2); webhook `closed`/`synchronize`/CI become hints | the listed writers; `pr-state-reconcile.ts`; render-time refresh writes; `conflict-retry.ts` and `migration-collision-retry.ts` decision logic | S5, S6, S9–S11, S24, S27; no reader changes yet (columns keep their values and meaning) |
| **C** | landing and merge: the five merge doors and `landPr` run as T15/T16 with `merge_call` effect; post-merge effects become outbox effects | inline `emit()` post-merge work; per-door `mergedAt` stamps; `tryAutoMergeWorkerPr` as a decision-maker (it becomes an adapter calling `LandingRequested`) | S10, S15; `landPr` rails untouched |
| **D** | supersession, abandonment, mission completion inputs, reaper/cleanup | `recordPrSupersession` direct update; reaper auto-complete for deliveries; `prShipState` reads delivery | S9, S12, S16; `canCompleteMission` ACs of `mission-task-lifecycle` still pass unmodified |
| **E** | projections: UI, explain, Home, activity comment read `getDeliveryView`; retire duplicate maps (`derivePrLifecycle`, `isPrMerged`, `TaskCard` `PR_LIFECYCLE`, `deriveStage` PR branch, chat `dock-model`, `TaskObject`) | the re-derivations in §17.5 | S17; visual QA per `/visual-review` |
| **F** | delete retired columns/indexes; turn on the write-site guard in blocking mode | `*RetryHeadSha` unique indexes; `iteration` context keys | guard test green with an empty allowlist beyond the kernel |

**Backfill and import.** `PrBound` on a PR that already has legacy rows creates the
delivery by a **live read**, not by trusting legacy columns: GitHub says open/merged/
closed and the head; the latest decided reviewer task whose `context.headSha` equals the
live head becomes round 1's verdict (otherwise round 1 is queued fresh), fix tasks with
a live attempt are bound as `FIXING`. In-flight legacy retries finish under the legacy
code path only for workspaces still flagged off.

**Per-workspace flag.** `gitConfig.workflowKernel = 'off' | 'on'`, default `off` so
merging changes nothing (DESIGN-FORMAT rule 2). Flipping to `on` is the cutover for
that family; there is no `shadow` value on purpose.

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
| S6 | Out-of-order: `closed(merged)` then late `synchronize`/`opened`/`check_suite` | terminal wins; `workers` columns unchanged; old-SHA CI failure does not overwrite | `apps/web/src/app/api/github/webhook/route.test.ts`, `apps/web/src/lib/pr-state-refresh.test.ts` |
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
| S17 | UI projections agree | one `DeliveryView` → Home chip, task card stage, mission strip, explain, chat dock all show the same stage for a table of states | `apps/web/src/lib/pr-presentation.test.ts`, `apps/web/src/lib/action-queue.test.ts`, `apps/web/src/lib/mission-state-view.test.ts`, `apps/web/src/components/TaskCard.test.tsx`, `apps/web/src/components/chat/dock-model.test.ts` |
| S18 | Mission integration branch deleted under an open task PR (cause of the PR #3744 closure) | `CLOSED_UNMERGED(base_deleted)`, `scan_supersession` finds the re-opened PR, T20 records it | `apps/web/src/lib/pr-supersession-detect.test.ts`, `apps/web/src/lib/mission-pr.test.ts` |
| S19 | Fix worker killed after claim | `FIXING → CHANGES_REQUESTED`, the ledger row ends `failed`, the next dispatch allocates the next `attempt_no`, or exhausts | reducer test |
| S20 | Stale `version` from a human action | `stale` + current view, HTTP 409; nothing applied | reducer test; route tests for `/api/prs/[prNumber]/merge` and `/api/github/pr` |
| S21 | Authorization matrix (§17.1) | owner, caller-names-PR, sibling, other workspace, human | `apps/web/src/app/api/github/pr/supersede/route.test.ts`, `apps/web/src/app/api/github/pr/review/route.test.ts`, `apps/web/src/lib/task-token-auth.test.ts` |
| S22 | Flag off | with `workflowKernel='off'` every legacy test passes unchanged | `bun run test` |
| S23 | CI provenance (audit): worker pushes under the owner's git identity; worker pushes under the bot identity; a person pushes | the first two are attributed by SHA set and consume a ledger row; the third is `foreign_push` and consumes none; the cap bounds dispatches in all three; manual "Fix CI" uses the configured cap | `apps/web/src/lib/ci-failure-retry.test.ts`, `apps/web/src/app/api/prs/[prNumber]/retry-ci/route.test.ts`, reducer test (replaces the author-string cases around `isBuilddWorkerCommit`) |
| S24 | Trunk breakage: one signature red on trunk and on several PRs | one incident, one trunk-fix task, zero per-PR `ci` attempts, queued ones `skipped`, deliveries `BLOCKED_ON_TRUNK`, `ci` budget untouched, recovery re-enters `resume_state`; two dependency-bot PRs do not accumulate retries | `apps/web/src/lib/ci-red-sweep.test.ts`, `apps/web/src/lib/ci-failure-retry.test.ts`, `apps/web/src/lib/workflow/trunk.test.ts` (new) |
| S25 | Stale dispatch: target merged / approved / CI green / conflict resolved between trigger and dispatch, and between dispatch and claim | ledger row `skipped`, no task (or task cancelled as skipped, not failed); replay is a no-op; reason recorded | `apps/web/src/lib/workflow/effects.test.ts` (new), `apps/web/src/lib/conflict-retry.test.ts`, `apps/web/src/lib/ci-failure-retry.test.ts` |
| S26 | Comment as projection: concurrent renders, lost-update race (a `reviewing` write racing the merge), entries after merge, duplicate sticky comments, PR with no comment, CI red while approved | final comment equals a fresh render of canonical state; `Merged` stays the headline; one comment; created for every bound PR; "Approved" never heads a `REPAIRING` delivery | `apps/web/src/lib/pr-activity-comment.test.ts`, `apps/web/src/lib/pr-activity-fix-claimed.test.ts`, `apps/web/src/lib/workflow/projections.test.ts` (new) |
| S27 | Mechanical versus agent repair | behind-only conflict and byte-identical renumber complete with no task; textual conflict and non-identical renumber escalate to an agent attempt; false collision from a lagging mission branch is not a collision; dependency-bot PRs are never pushed to | `apps/web/src/lib/conflict-retry.test.ts`, `apps/web/src/lib/migration-collision-retry.test.ts`, `apps/web/src/lib/base-refresh.test.ts` |
| S28 | Ledger separation | CI, review, conflict, migration, trunk families count independently; a reviewer spawned on a CI-fix task does not inherit the CI count; infra requeues change no ledger; `attemptView` is 1-based and identical in comment, title and `explain` | reducer test; `apps/web/src/lib/pr-activity-comment.test.ts`, `apps/web/src/lib/explain.test.ts` |
| S29 | Reviewer prose or no verdict | round fails (T27), re-queued at the same head without a new round number, then `ESCALATED(review_unavailable)`; prose is never applied as approve | `apps/web/src/lib/reviewer-output.test.ts`, `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S30 | Runner hand-off failures (no confirmed outcome, commits but no PR, uncommitted changes) | `AttemptEnded(unproven)` → `AWAITING_PUSH` or requeue; never `completed` delivery | `apps/runner/__tests__/unit/` (new case beside the existing completion tests), `apps/web/src/app/api/workers/[id]/route.test.ts` |
| S31 | Preflight | `create_pr` refuses a body the CI scan would reject, with the reason; runner preflight failure keeps the attempt open; CI miss is tagged `preflight_miss` | `apps/web/src/app/api/github/pr/route.test.ts`, `scripts/check-no-prod-data-local.test.ts` |

Integration (needs a live server): extend `apps/web/tests/integration/` with one
end-to-end case for S1 against the dev preview (open PR, request changes, fix attempt
that does not push, assert state via `explain`). Run with `bun run test:integration`.

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
  columns; Slice D feeds it from the delivery (`MERGED`→merged, `SUPERSEDED`,
  `ABANDONED`, `CLOSED_UNMERGED`/others → unshipped) by projecting the same columns, so
  the function is unchanged.
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
accepted without a head compare) is part of Slice D, because it changes what plain
builders see; until then those gates are unchanged and the kernel only *records* the
mismatch as a fact (`local_head_reported` vs live head) for the activity timeline.

### 17.5 UI projections

- Stage chips, Home "Needs You", task detail, mission strip, explain, chat dock and
  `get_pr`/`list_prs` currently each re-derive state (§18.2). Slice E replaces them
  with `getDeliveryView`; until then they keep reading fact-cache columns, which keep
  their values. Visible differences to expect and to review: a task whose fix did not
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
| Trunk breaker hides a genuinely broken PR behind a signature match | a PR is `BLOCKED_ON_TRUNK` only while trunk itself fails the same signature; on `TrunkRecovered` the PR's own CI re-runs and a remaining failure is its own `ci` attempt; one trunk-fix attempt per incident bounds the cost; breaker is opt-in |
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
| `derivePrLifecycle :78`, `isPrMerged :86` | second map ignoring `mergedAt` | take `DeliveryView.stage` |
| `components/TaskCard.tsx:132,329,343`; `lib/stage.ts:59` `deriveStage` | duplicate `PR_LIFECYCLE`, own state machine without `conflict`/`unresolvable` | stage from view |
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
- [ ] `lib/conflict-retry.ts` (`:241,422,812,893,974`), `lib/migration-collision-retry.ts`, `lib/dead-zone-sweep.ts` retry insert
- [ ] `lib/auto-merge.ts` (`:777` merge door; `:991,1055,1071,1141,1158` escalation stamps)
- [ ] `lib/pr-landing.ts` `landPr` decision and `lib/pr-landing-marker.ts`, `pr-landing-handoff.ts`, `pr-landing-sweep*.ts`
- [ ] `app/api/prs/[prNumber]/merge/route.ts:566,257`; `app/api/github/pr/route.ts:1956,1722,1978,2016`
- [ ] `lib/stale-workers.ts:251` auto-complete; `app/api/tasks/cleanup/route.ts:266` assigned-task complete
- [ ] `lib/pr-supersession.ts:236,285`, `lib/pr-supersession-detect.ts:384`, `app/api/github/pr/supersede/route.ts`
- [ ] `lib/dead-pr-shutdown.ts:396`; `lib/loop-webhook.ts:72`
- [ ] `lib/pr-state-reconcile.ts:127` (delete); `lib/dead-zone-sweep.ts:302` `conflict` overload
- [ ] webhook `handlePullRequestEvent` open-state write `:822/833` and closed `:1048`; `check_suite` writes `:383,412,472`
- [ ] `lib/approval-carry-forward.ts:27` `equivalentHeadShas` append
- [ ] `lib/pr-activity-comment.ts` writers (~18 modules) → `render_activity`
- [ ] `lib/ci-failure-inspect.ts` `isBuilddWorkerCommit` and every `context.iteration` read used for a decision (CI, review, conflict families)
- [ ] `app/api/prs/[prNumber]/retry-ci/route.ts` manual CI path (ignores the workspace cap, restarts at 0)
- [ ] `lib/migration-collision-retry.ts`, `lib/conflict-retry.ts` dispatch decisions (mechanical-first, §6.7); `lib/ci-red-sweep*.ts`/`ci-red-queue.ts` per-PR retry fan-out (§6.10)
- [ ] `lib/reviewer-output.ts` / `WID:3255-3440` prose-verdict fallback (§6.6, T27)

**Projection-only (P)**
- [ ] `workers.supersededBy*`, `abandoned*`
- [ ] `lib/pr-merge-stamp.ts:31` `stampPrMergedOnAllRows`; `tasks.status='completed'` on merge (`webhook/route.ts:1141,1221`)
- [ ] mission notes for reviewer verdicts; `workers.mergedAt`/`prLifecycleStatus` after a transition
- [ ] `tasks.result.shipped`, evidence stores (`task-shipped-store.ts`, `task-evidence-store.ts`)

**External-fact ingestion (F)**
- [ ] `lib/register-local-pr.ts:26`; webhook base-ref sync `:668` and retarget `:735`
- [ ] `lib/pr-state-refresh.ts:312`; `lib/pr-reconcile.ts` writers; `lib/dead-zone-sweep.ts:267-311` merged/closed
- [ ] `app/api/admin/backfill-merged-prs/route.ts:89`; `packages/core/scripts/backfill-mergedat.ts`
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
- AC-11: GIVEN `workflowKernel='off'` THEN every legacy test and route behaves exactly as before the change.
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
- New (Phase 2): `apps/web/src/lib/workflow/*`, `packages/core/__tests__/workflow-write-sites.test.ts`.

## 23. Out of scope

See §17.6 and §21.
