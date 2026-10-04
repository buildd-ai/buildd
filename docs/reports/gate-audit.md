# Gate audit — server-side refusals, deferrals and bypasses

Generated audit output. Rebuildable, may be stale — never a source of truth.
Line numbers are against the commit that WIRED these sites, not the read-only
pass that first listed them — the instrumentation itself shifted them.

## Why

A gate refuses or defers, nothing records it, and the miss is found weeks later
by a human tailing logs. That has happened at least six times: a swallowed
non-2xx claim rejection, per-reason claim counts that lived only in an
unpersisted diagnostics object, session-limit deferrals that stranded work for
nearly two weeks, a completion 400 that discarded the agent's summary, a bare
409 indistinguishable from a real blocker, and a creation-time lint that
rejected ordinary descriptions for three weeks before the rate was visible.

The common shape is not the individual bug. It is that **a refusal is a
decision the platform makes about a caller's request, and it was the only class
of decision buildd never wrote down.** `get_failure_analytics` cannot see any
of it, because a creation-time 400 is not a worker failure.

This audit enumerates the sites. The `gate_events` table and `recordGateEvent`
helper that follow give every one of them a row.

## Vocabulary

| outcome | meaning |
|---|---|
| `rejected` | the request was refused; the caller got a 4xx |
| `deferred` | the request was accepted but not acted on yet — a wait, a queue, a single-flight |
| `bypassed` | a gate fired but the caller carried an explicit escape hatch and the work proceeded |
| `warned` | advisory only — the response carries a warning and the work proceeded |
| `stranded` | a task deferred long enough that the sweep flagged it; excluded from the bypass-rate denominator, same as `deferred` |

`bypassed` is the load-bearing one. A lint's bypass rate over its total fire
count *is* its false-positive rate, measured directly instead of inferred from
however many friction reports someone had the patience to file.

## Sites

### POST /api/tasks — `apps/web/src/app/api/tasks/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 1 | `route.ts:411` | `task_param_vocabulary` | rejected | out-of-vocabulary `kind` |
| 2 | `route.ts:423` | `task_param_vocabulary` | rejected | out-of-vocabulary `complexity` |
| 3 | `route.ts:1219` | `prose_gate` | warned | advisory dependency-gate lint; the three-week false-positive case |
| 4 | `route.ts:559` | `friction_dedupe` | rejected | `[friction]` filing appended to an open task with the same signature |
| 5 | `route.ts:762` | `subject_dedupe` | rejected | pre-dispatch attach on an identifying subject anchor |
| 6 | `route.ts:734` | `subject_dedupe` | bypassed | `fileAnywayReason` supplied against a live attach-eligible match |
| 7 | `route.ts:929` | `manifest_required` | rejected | mission PR task with no concrete `pathManifest` (carried a `TODO(gate ledger)` naming this task) |
| 8 | `route.ts:1122` | `subject_dedupe` | bypassed | `intakeSubject` resolved `filed_anyway` under an enforcing subject policy |
| 9 | `route.ts:1248` | `file_anyway` | rejected | `fileAnywayReason` blank |
| 10 | `route.ts:1261` | `file_anyway` | rejected | `fileAnywayReason` not permitted for this filing origin |
| 11 | `route.ts:986` | `kind_absent` | warned | mission task filed with no `kind`; advisory only — see `docs/specs/mission-legibility.md` Rule K2-13 |
| 12 | `route.ts:561` | `emits_plan_manifest_required` | rejected | `emitsPlan: true` task filed with no `pathManifest` naming the spec document it authors — see `docs/design/spec-to-build-pattern.md` |

Sites 1 and 2 fire before the route resolves a workspace. They are recorded
through a wrapper that resolves the caller's raw workspace reference in the
fire-and-forget path, so they are still attributable without reordering the
validation (which would change which error a doubly-invalid request gets).

### Missions — `apps/web/src/app/api/missions/route.ts`, `apps/web/src/app/api/missions/[id]/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 11 | `missions/route.ts:156` | `branch_strategy` | rejected | create: invalid `branchStrategy` |
| 12 | `missions/route.ts:232` | `goal_criteria` | rejected | create: `validateGoalCriteria`, including the `notMechanizableReason` requirement on prose criteria |
| 13 | `missions/[id]/route.ts:228` | `branch_strategy` | rejected | update: invalid `branchStrategy` |
| 14 | `missions/[id]/route.ts:478` | `goal_criteria` | rejected | update: same validator, plus the stored-criteria comparison |
| 14a | `goal-criteria-quality-shadow.ts:runGoalQualityShadow` (from `missions/route.ts` POST, `missions/[id]/route.ts` PATCH) | `goal_criteria_quality` | warned / bypassed | advisory only, never blocks: `warned` = one row per new criterion the `mission_goal_quality` decision graded weak (no user-noticeable outcome, or not checkable without reading prose); `bypassed` = once per (mission, fingerprint) when a later PATCH keeps a warned criterion, deterministic and capability-independent. `detail` is fingerprint, type, labels, confidences and mode, never criterion text. See `docs/specs/mission-goal-criteria-quality.md` |

### PATCH /api/workers/[id] — `apps/web/src/app/api/workers/[id]/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 15 | `route.ts:1087` | `mission_base_adoption` | rejected | auto-detected PR on the worker's branch targets the wrong base |
| 16-18 | `route.ts:1143` | `output_requirement` | rejected | `pr_required` / `artifact_required` / `auto`. All three refuse through `persistRejectedCompletionPayload`, so the ledger row is written there — a fourth arm cannot be added that preserves the payload and forgets the ledger |
| — | `route.ts` completion gate | `silent_completion` | rejected | Empty editing session with a fallback, fragmented or forward-looking summary; preserves rejected payload, fails worker, retries once independently of mission membership, then posts a warning |
| 19 | `route.ts:1249` | `output_requirement` | bypassed | `discardEdits` acknowledged the edits as scratch |
| 19a | `route.ts` terminal block | `worker_patch_refused` | rejected | the runner reporting that a prior mutation of ours was refused with a non-gate 4xx (or an unqueueable 5xx). Those reports are exempt from the task's retry budget, so this row is what keeps the exemption countable: a rise here means we are rejecting the runner's requests, not that agents are failing. An output-gate refusal is deliberately excluded — it already has its `output_requirement` row from sites 16-18 |
| 19b | `route.ts` terminal block | `handoff_required` | rejected | completing task has an unfinished dependent and no `structuredOutput.handoff.delivered` |
| 19c | `route.ts` self-reported PR / `pr_required` fallback | `pr_ownership` | rejected | the PR an agent run reports (or the `#N` fallback adopts) is not one its task owns, is outside the linked repo, or targets the wrong mission base. The PR fields are dropped; the rest of the PATCH still applies |

Site 19 is the direct read on how often the `auto` gate is being talked out of
a refusal, which is the number that would have shown the reviewer-task
regression without a human noticing nine dead runs.

### create_pr — `apps/web/src/app/api/github/pr/route.ts` (POST)

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 20 | `pr/route.ts:687` | `pr_head_mismatch` | rejected | PR head is not the worker's own branch |
| 21 | `pr/route.ts:705` | `pr_base_mismatch` | rejected | PR base disagrees with the mission integration branch |
| 21a | `pr/route.ts:refusePrOwnership` | `pr_ownership` | rejected | an agent run recording a PR its task does not own: `head_not_owned`, `protected_head`, or `pr_outside_linked_repo` (adoption). Runs on fresh create, dedup-by-head and `prUrl` adoption; people and teammates are exempt. See `lib/agent-capabilities/pr-ownership.ts` |

### merge_pr — `apps/web/src/app/api/github/pr/route.ts` (PUT)

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 22 | `pr/route.ts:1112` | `merge_policy` | rejected | `force` without an admin token |
| 23 | `pr/route.ts:1122` | `merge_policy` | bypassed | `force` accepted from an admin token — policy deliberately skipped |
| 24 | `pr/route.ts:1141` | `merge_policy` | rejected | PR head unreadable, so policy cannot be evaluated (fails closed) |
| 25 | `pr/route.ts:1166` | `merge_policy` | rejected | tier `human` |
| 26 | `pr/route.ts:1193` | `merge_policy` | rejected | tier `agent-review`, no self-mergeable approval |
| 27 | `pr/route.ts:1214` | `merge_policy` | rejected | `evaluateAutoMergeSafety` refused |
| 28 | `pr/route.ts:1236` | `mission_pr_lifecycle` | deferred | sibling task PRs still open against the integration branch |

### check_path_claim — `apps/web/src/lib/path-claim-check.ts` (shared by the MCP tool and `POST /api/tasks/[id]/path-claim`)

Both entry points call `checkPathClaim`; `surface` is `mcp:check_path_claim` or `POST /api/tasks/[id]/path-claim`. Before the extraction the MCP copy fired neither row.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 29 | `path-claim-check.ts:98` | `path_claim` | rejected | wildcard claim |
| 30 | `path-claim-check.ts:176` | `path_claim` | deferred | real overlap; caller registered as a waiter. Reason and `detail.signal` are `claim_blocked` for an ordinary live holder and `deadlock_detected` for a circular wait (`detail.deadlock`) — the distinction a bare 409 could not carry, and one a sentinel must not roll into an outage count |

### Authoritative working set — `apps/web/src/lib/working-set-sync.ts` (from `PATCH /api/workers/[id]`)

The runner's delta/ACK reconciliation of the task-owned file set against `path_claims` (docs/specs/path-claim-ownership.md). Every row carries `detail.signal` from the path-coordination vocabulary in `packages/core/path-coordination-signal.ts`; `get_failure_analytics family=gate` reports them split as `pathCoordination`.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 30a | `working-set-sync.ts:fireObservationTruncated` | `path_claim` | warned | `observation_truncated`: the bounded `workers.observedTouches` SAMPLE crossed its cap. Once per worker. Advisory only — every reported path is leased regardless; this never means enforcement degraded |
| 30b | `working-set-sync.ts:recordShipCheckpointReports` | `path_claim` | deferred / warned | `coverage_unknown_at_ship`: a pre-push / create_pr / complete_task checkpoint could not prove coverage (`detail.cause`: timeout / error / sweep_incomplete / server_rejected, `detail.attempts`). `deferred` = the ship was refused (enforce mode, fail closed); `warned` = let through in advisory mode. Repeats per worker and cause coalesce for ten minutes |
| 30c | `working-set-sync.ts:applyWorkingSetSync` → `recordPathDeclaration` | `path_declaration` | accepted / deferred | One row per applied delta with `detail.sizeBucket` (<=50 / <=500 / <=2k / >2k) and `detail.latencyMs` — the instrumentation that decides whether exact-path leases ever need compressing. `deferred` carries `signal: claim_blocked` |

### request_pr_review — `apps/web/src/app/api/github/pr/review/route.ts`, `apps/web/src/app/api/prs/[prNumber]/re-review/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 31 | `pr/review/route.ts:204` | `reviewer_single_flight` | deferred | one reviewer per PR at a time; `force` never stacks a second |
| 32 | `re-review/route.ts:131` | `reviewer_single_flight` | deferred | same guard on the delta re-review path |

### POST /api/workers/claim — `apps/web/src/app/api/workers/claim/route.ts`

The dispatch-ledger follow-up (task b2d38227) to the audit above: the claim
loop's per-reason deferrals (previously an unpersisted `deferrals` object that
died with the response — #1510), the auth/validation refusals a runner sees as
a thrown `claim_rejected` client-side (#1511), and the stranded-task sweep's
`outcome: 'stranded'` rows all share one gate, `claim_loop_deferral`, so the
whole claim-loop decision surface aggregates as one thing in `get_failure_
analytics family='gate'` and the health page's Gates block.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 33 | `claim/route.ts` (invalid API key) | `claim_loop_deferral` | rejected | mirrors the runner's local `claim_rejected` log |
| 34 | `claim/route.ts` (trigger-level token) | `claim_loop_deferral` | rejected | trigger tokens cannot claim |
| 35 | `claim/route.ts` (`runner` field missing) | `claim_loop_deferral` | rejected | malformed claim request. A client that omits `runner` does so on every poll, so this site is collapsed via `recordOrCoalesceRepeat` to one row per account per hour: `detail.accountId`, `detail.count`, `detail.lastSeenAt`, plus `detail.userAgent` and `detail.bodyKeys` to identify the client |
| 36 | `claim/route.ts` `deferTask()` — 13 dispatch-loop sites (`connector_mismatch`, `subject_dead`, `path_overlap` ×2, `mission_budget`, `mission_concurrent`, `mission_paced`, `advisory_manifest`, `workspace_cap`, `provider_unavailable`, `budget_paused` ×2, `routing_paused`, `duplicate_worker`, `codex_single_flight`) | `claim_loop_deferral` | deferred | one row per (taskId, reason) per tick, coalesced across polls via `recordOrCoalesceDeferral` into a `detail.consecutiveDeferrals` counter with a `detail.firstDeferredAt` floor. `codex_single_flight` replaces what used to be discovered post-claim, in the runner, by killing a started worker (`apps/runner/src/workers.ts` still keeps that check as a race backstop for two concurrent claim requests this in-batch guard can't see) |
| 36b | `claim/claim-plan-store.ts` `fireOrderedBehind` / `fireClaimPlanRecord` — claim planner, only for a workspace with `gitConfig.claimPlanner` `record` or `apply` | `claim_loop_deferral` | deferred / accepted | `ordered_behind` (apply): one row per (taskId, blocker) EVER via `recordDeferralOnce` — a repeat poll behind the same blocker writes nothing, so a task's row count is its starvation credit; `detail.blockedBy`, `detail.edge`, `detail.orientation`. `claim_plan` (accepted, record and apply): the plan beside the picks actually made, collapsed via `recordOrCoalesceRepeat` per (mode, workspace, plan signature) per hour; `detail.planned`, `detail.actual`, `detail.agree`, `detail.orderedBehind` |
| 36c | `claim/route.ts` `emptyClaim` → `explicit-task-exclusion.ts:explicitExclusionGateEvent` — an explicit-`taskId` claim (a runner's wake claim, `claim_task {taskId}`) that a claim-query WHERE gate dropped (`workspace_cap`, `deps_blocked`, `subject_dead`, `mission_held`, …) | `claim_loop_deferral` | deferred | reason = the exclusion code, `detail.explicitClaim: true` + the caller-facing sentence, coalesced like row 36. Not written for codes meaning the task was not claimable at all (`not_found`, `not_pending`, `already_claimed`, `active_worker`, `state_changed`). Before this a WHERE-gate refusal recorded nothing, so a woken task refused on every wake had an empty gate history |
| 37 | `stranded-tasks-sweep.ts:sweepStrandedTasks` | `claim_loop_deferral` | stranded | pending past `startAt` by 2h, or the same deferral reason for `STRAND_CONSECUTIVE_THRESHOLD` consecutive polls; posts one open `mission_notes` warning per task, cleared when the task re-arms |

### Mission goal-criteria evaluation — `apps/web/src/lib/mission-criteria-eval.ts`, `mission-criteria-verify.ts`, `mission-criteria-worker-eval.ts`

The counterpart to criteria escalation: escalation decides what to do about a
non-verdict, this counts how often one was needed and why.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 38 | `mission-criteria-eval.ts` (worker-eval unavailable) | `criteria_not_evaluated` | warned | reason `evaluator_unavailable` |
| 39 | `mission-criteria-eval.ts` (evaluator returned nothing) | `criteria_not_evaluated` | warned | reason `evaluator_no_output` |
| 40 | `mission-criteria-eval.ts` (inline inference error) | `criteria_not_evaluated` | warned | reason = the raw `inferenceError.kind` |
| 41 | `mission-criteria-eval.ts` `setAll('NOT_EVALUATED', ...)` ×3 (read-only, already-failing, dispatch failed) | `criteria_not_evaluated` | warned | reason `no_api_key` / `unsupported_provider` / `capability_disabled` |
| 42 | `mission-criteria-verify.ts:handleCriteriaVerificationOutcome` (no run evidence) | `criteria_not_evaluated` | warned | reason `evaluator_no_output` |
| 43 | `mission-criteria-verify.ts:handleCriteriaVerificationOutcome` (UNVERIFIED verdict) | `criteria_not_evaluated` | warned | reason `timeout` / `exec_error` |
| 44 | `mission-criteria-worker-eval.ts:handleCriteriaWorkerEvalOutcome` (criterion edited mid-flight) | `criteria_not_evaluated` | warned | reason `criterion_changed` |
| 45 | `mission-criteria-worker-eval.ts:handleCriteriaWorkerEvalOutcome` (no verdict returned) | `criteria_not_evaluated` | warned | reason `evaluator_no_output` |
| 46 | `mission-criteria-worker-eval.ts:handleCriteriaWorkerEvalOutcome` (fail downgraded to UNVERIFIED) | `criteria_not_evaluated` | warned | reason `exec_error` / `exit_126_127` |

### Review-verdict gate — every merge door

`apps/web/src/lib/review-verdict-gate.ts` is the one rule; these are the doors
that ask it. It exists because whether a reviewer's `request-changes` held a
door used to depend on which door was used and on which tier the PR resolved
to: `merge_pr` and the CI-green auto-merge consulted the verdict only under
`agent-review`, and the dashboard merge button consulted it at no tier at all —
while `auto-threshold` is exactly what every Option A′ task PR resolves to, and
those PRs get a reviewer dispatched at them on purpose.

Only the dashboard door carries a bypass, because only there is a human
present. Nothing unattended may override a verdict.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 47 | `pr/route.ts` (PUT, after the tier checks) | `review_verdict` | rejected | outstanding non-approve verdict, or a review in flight, at the commit being merged |
| 48 | `auto-merge.ts:tryAutoMergeWorkerPr` | `review_verdict` | deferred | same rule on the unattended path (CI-green webhook, no-CI webhook, reviewer approve) |
| 49 | `prs/[prNumber]/merge/route.ts` | `review_verdict` | rejected | dashboard merge with no `override` |
| 50 | `prs/[prNumber]/merge/route.ts` | `review_verdict` | bypassed | `override: true` — an explicit human decision, recorded rather than passing unmarked |
| 51 | `webhook/route.ts:handleReleasePrCiSuccess` | `review_verdict` | deferred | release promotion held by a verdict on the release PR itself |

### Base-freshness gate — every merge door (`evaluateAutoMergeSafety`)

`dev` has no GitHub-side branch protection, so a PR's CI result is proof about
its head SHA only — nothing already checked whether the base branch had moved
past that SHA since. `evaluateAutoMergeSafety` in `apps/web/src/lib/auto-merge.ts`
compares the head against the PR's live base ref via GitHub's compare API and
refuses when the head is behind. Every caller of `evaluateAutoMergeSafety`
inherits this for free — same shared-function shape as the review-verdict gate
above.

The refusal reason ends in "needs rebase onto base branch", the same suffix
`mergeable_state: dirty` uses, so `classifyMergeFailure` routes it through the
identical conflict-retry dispatch: a same-branch retry task merges the base in
and pushes, which re-triggers CI on a head that is fresh. The PR converges
without a human, the same way a real conflict does.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 52 | `auto-merge.ts:evaluateAutoMergeSafety` | `merge_base_freshness` | rejected | head is N commits behind the base branch's current tip — CI never ran against those commits |

### Dependency-bot PRs — adoption and every push door (`lib/dependency-bot-pr.ts`)

Renovate and Dependabot own their branches: they rebase and force-push them
themselves, and stop doing so the moment anyone else commits. Automatic
adoption skips their PRs; an explicit `request_pr_review` still adopts and
reviews one, but nothing buildd runs may push to its branch.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 53 | `ci-failure-retry.ts:retryCiFailureForPr` | `dependency_bot_pr` | rejected | CI failed on a bot PR buildd does not own — not adopted, no CI-fix task |
| 54 | `ci-failure-retry.ts:retryCiFailureForPr` | `dependency_bot_pr` | rejected | a bot PR buildd already owns (explicit review) — no CI-fix task |
| 55 | `prs/[prNumber]/retry-ci/route.ts` | `dependency_bot_pr` | rejected | dashboard "fix CI" on a bot PR |
| 56 | `conflict-retry.ts:dispatchConflictRetry` | `dependency_bot_pr` | rejected | no update-branch and no conflict-resolution agent on a bot branch |
| 57 | `github/pr/route.ts` (merge) | `dependency_bot_pr` | rejected | behind-base merge refusal does not update a bot branch |
| 58 | `workers/[id]/route.ts` (reviewer request-changes) | `dependency_bot_pr` | rejected | no `[builder · after review]` follow-up on a bot branch |
| 59 | `pr/review/route.ts` | `dependency_bot_pr` | bypassed | explicit `request_pr_review` adopted a bot PR — reviewed, never pushed to |

### Skipped CI retries (`lib/ci-failure-retry.ts`, `lib/ci-red-sweep.ts`)

Every red CI result on a buildd PR that does not get a CI-fix task writes one
row, from the `check_suite` webhook (`surface: webhook:check_suite`) or the
red-PR sweep (`surface: cron:ci-red`). `detail.skipReason` is the stable code;
`detail.prNumber` / `detail.headSha` / `detail.repo` say which PR and head. The
reason text is fixed per code so repeats coalesce.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 59a | `ci-failure-retry.ts:retryCiFailureForPr` | `ci_retry_skipped` | rejected | `owner_stopped` (owner task failed or cancelled), `pr_terminal` (lifecycle merged/closed/unresolvable), `no_workspace`, `draft`, `pr_merged`, `pr_closed`, `head_already_retried` (an attempt already ran on this head), `retries_exhausted`, `retries_disabled`, `duplicate` (the insert lost a race for this PR + head) |
| 59b | `ci-failure-retry.ts:retryCiFailureForPr` | `ci_retry_skipped` | deferred | `fix_in_flight` — a review, conflict or CI fix attempt for the PR is still pending or running; `detail.inFlightTaskId` names it and the red-PR sweep is scheduled to look again |
| 59c | `ci-failure-retry.ts:escalateCiRedHead` | `ci_retry_skipped` | stranded | the red-PR sweep found a head an attempt already ran on, nothing pushed and nothing in flight: escalated to a human once per PR + head (`detail.escalated: true`) |

### Retry-lineage PR supersession (`lib/retry-pr-supersession.ts`)

When a retry attempt opens a fresh PR instead of updating its parent's, the
parent's PR is closed so only one PR per fix can merge. A close that did not
happen is recorded rather than logged, and the hourly pr-reconcile sweep retries it.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 60 | `retry-pr-supersession.ts:closeAncestorRetryPrs` | `retry_pr_supersession` | stranded | ancestor PR left open: state unreadable or close failed (create_pr or sweep) |
| 61 | `retry-pr-supersession.ts:closeAncestorRetryPrs` | `retry_pr_supersession` | warned | sweep found two open PRs in one retry lineage and closed the older |
| 61e | `github/pr/route.ts` (`retry-fresh-pr-gate.ts`) | `retry_pr_supersession` | rejected | create_pr refused a fresh PR from a retry whose subject PR is still open and whose head is an ancestor of the new branch (or vice versa), or diverged from it with no runner trace proving the subject branch missing or diverged (`detail.resumeCause`): the retry must update the subject PR |
| 61f | `github/pr/route.ts` (`retry-fresh-pr-gate.ts`) | `retry_pr_supersession` | warned | a retry opened a fresh PR while its subject PR was open: `detail.freshPrReason` is `diverged` (GitHub compare, plus the runner's `detail.resumeCause` of `missing` or `diverged`) or `unverified` (unreadable, failed open) |

### Automatic supersession of closed PRs (`lib/pr-supersession-detect.ts`)

A closed-unmerged PR is checked for where its work landed (webhook on close,
hourly pr-reconcile backfill). Claims and sibling tasks only nominate; an edge
is recorded only when the content verifies.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 61a | `pr-supersession-detect.ts:recordVerified` | `auto_pr_supersession` | accepted | candidate's merged diff carries the closed PR's changes; edge recorded with `detail.method` (patch-id or content) and `detail.confidence` |
| 61b | `pr-supersession-detect.ts:detectPrSupersession` | `auto_pr_supersession` | deferred | candidate found but not content-verified: suggestion stored for the mission card, no edge |

### Supersession reconciler (`lib/supersession.ts`, `lib/supersession-store.ts`)

One rule table decides which queued or running work a subject event made
obsolete: a reviewer verdict, a PR merged or closed (webhook and both merge
routes), a task cancelled, a task whose PR merged. Every cancel is a status
CAS; only the caller that wins it writes the ledger row, so two doors seeing
the same event record one cancellation.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 61c | `supersession-store.ts:recordSupersession` | `supersession` | accepted | one row per task a rule cancelled; `detail.rule` is the rule id, `detail.event` the subject event, `surface` the door |
| 61d | `supersession-store.ts:recordBulkRefusal` | `supersession` | rejected | one event matched more than the per-event cap: nothing cancelled, `detail.wouldCancel` holds the set, and a warning note is posted |

The dispatch guard also runs the table before a fix or CI retry is created
(`checkDispatch`) and against the inserted row (`guardDispatchedTask`).
`open_retry_supersedes_duplicate` keeps one subject PR to one open retry: a
newcomer is not filed, and of two racing inserts the newer cancels itself —
recorded as row 61c with that rule id. The open set covers the whole retry
family (`collectRetryFamily`), so a sibling fixing a sibling's PR blocks too.
The claim route runs the same rule (`guardClaimedRetry`) before starting an
attempt: one with an older open sibling, or a newer one already running, is
cancelled (row 61c, surface `POST /api/workers/claim`) and counted as the
`sibling_retry_open` claim-loop deferral.

### Auto-merge — the unattended merge path (`lib/auto-merge.ts:tryAutoMergeWorkerPr`)

Every reason the unattended path did not merge a PR, so "why didn't this green
PR merge" has an answer after the fact. `detail.reasonClass` names the rail
(`ci`, `deny_path`, `migration`, `size`, `conflict`, `blocked`, `model_bound`,
`stale_head`, `github_read`, `other`, or `merge_api` for a failed merge call).
Refusals a later webhook re-evaluates on its own (`ci`, `stale_head`,
`github_read`) are `deferred`; the rest are `rejected`. Base freshness and
review verdicts keep their own slugs (sites 48 and 52) and are not recorded
twice. A merge that lands writes no row; `workers.mergedAt` already records it.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 62 | `auto-merge.ts:tryAutoMergeWorkerPr` (safety rails) | `auto_merge` | rejected / deferred | `evaluateAutoMergeSafety` refused; `detail.reasonClass` + `detail.tier` |
| 63 | `auto-merge.ts:tryAutoMergeWorkerPr` (mission-PR gate) | `mission_pr_lifecycle` | deferred | mission PR waits on sibling task work, same rule as `merge_pr` |
| 64 | `auto-merge.ts:tryAutoMergeWorkerPr` (merge call) | `auto_merge` | rejected | GitHub merge API refused; `detail.mergeFailureClass` from `classifyMergeFailure` |

### Chat retro proposals (`lib/chat-retro/run.ts`, experiment)

The daily chat retro pass files suggested improvements for teams that opted
in to proposals. A pattern it declined to file is recorded, so the backlog is
visible without being filed. Removal: `lib/chat-retro/REMOVAL.md`.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 65 | `chat-retro/run.ts:proposeForTeam` | `chat_retro_proposal` | deferred | eligible pattern over the per-team daily proposal cap |
| 66 | `chat-retro/run.ts:proposeForTeam` | `chat_retro_proposal` | rejected | signature muted until its evidence doubles, or no workspace to file into |

### Mission integration branch resolution (`lib/mission-integration-branch.ts`)

A mission-branch mission whose integration branch cannot be resolved on the
remote. Not a refusal: every site records what it did instead, under one
reason built from closed vocabularies (`where`, `cause`, `fallback`) so repeats
group; the branch name and mission are in `detail`. The runner reports the same
failure as the error-trace pattern `mission_branch_unresolved` when it cuts a
worktree from trunk instead (`describeWorktreeFallback`, `@buildd/core/mission-branch-trace`).

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 67 | `mission-integration-branch.ts:ensureIntegrationBaseForTaskPr` | `mission_branch_unresolved` | warned | create_pr found the branch absent and re-cut it from trunk (`fallback: recut_from_trunk`) |
| 68 | `mission-integration-branch.ts:ensureIntegrationBaseForTaskPr` | `mission_branch_unresolved` | stranded | branch absent and not creatable; task PR opened against trunk (`fallback: trunk_pr_base`) |
| 69 | `missions/route.ts` POST, `missions/[id]/route.ts` PATCH, `mission-run.ts:runMission`, `tasks/route.ts` POST | `mission_branch_unresolved` | stranded | ensure failed at mission create / opt-in / organizer pass / first task filed (`fallback: none`) |

### PR landing function (`lib/pr-landing.ts:landPr`)

The one decide-and-act function for a PR that may be ready to merge. Every
non-`merged` outcome (`updating_branch`, `waiting_ci`, `needs_fix`,
`needs_human`) writes exactly one row whose `detail.landingOutcome` is the typed
outcome, with `detail.prNumber` and `detail.headSha`. Shadow mode records the
same decision as `warned` with `detail.shadowOutcome` and acts on nothing. A
merge writes an `accepted` row carrying `detail.timeToLandMs`.

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 70 | `pr-landing.ts:landPr` | `pr_landing` | deferred / rejected / warned / accepted | the landing decision; `deferred` = a wait with an owner (branch update in flight, checks pending, fix queued), `rejected` = a human is needed, `warned` = shadow, `accepted` = merged |

### Coordination telemetry additions

| Site | Gate | Outcome | Meaning |
|------|------|---------|---------|
| `apps/web/src/lib/change-intent.ts:postConflictNote` | `change_intent` | warned | One delivered conflict warning note per affected task, including both sides; task/workspace/mission attribution and overlapping surfaces are retained; `detail.advisory: true` — it never gates a merge. |
| `apps/web/src/lib/surface-ordering.ts:guardSurfaceOrdering` | `surface_ordering` | deferred / warned / bypassed | Opt-in surface merge ordering (conflict-aware-orchestration §3). `deferred` = an enforcing wait behind an earlier open PR on a serialized surface (`detail.kind: ordering`, with `counterpartPrNumber`, `surface`, `headSha`, `baseSha`) or unverifiable intent/diff state (`kind: unverified`); repeats coalesce. `warned` = shadow would-defer, or a reported cross-surface order inversion (`kind: cross_surface_cycle`). `bypassed` = `merge_pr force`. |
| `apps/web/src/lib/surface-ordering.ts:acquireMergeSlot` | `surface_ordering` | accepted / deferred | `accepted` = a merge reservation was taken (the denominator for the waits above); `deferred` = another PR holds the surface reservation, or the post-reserve recheck found a newly earlier PR. |
| `apps/web/src/lib/base-refresh.ts:refreshBehindPr` | `base_refresh` | accepted / deferred / warned / rejected | Deterministic refresh of a behind-only PR (conflict-aware-orchestration §4). `accepted` = GitHub update-branch merged the base in, no agent. `deferred` = an operational update failure (`detail.failure`: rate_limit / auth / transient / unknown, with `attempts`), an enforcing semantic check whose symbol coverage is unknown (bounded rechecks), or a verified same-symbol edit sent to semantic review (`detail.verdict`, `evidence`); repeats coalesce. `warned` = shadow semantic verdict or a moved head. `rejected` = attempts or rechecks exhausted, with one diagnostic note posted. A textual conflict is not recorded here; it goes to the conflict agent. |
| `apps/web/src/lib/path-declaration-ledger.ts:recordPathDeclaration` | `path_declaration` | accepted / deferred / warned | Declaration denominators: `accepted` = declared/acquired, `deferred` = denied by a live holder (`detail.signal: claim_blocked`), `warned` = `coordination_unavailable` (runner could not reach coordination; `detail.pathCount` is the delta, `detail.causes` splits timeout from network/5xx so a slow round trip is never an outage). `detail.provenance` = creation / plan_step / doc_fix / check_path_claim / observed / hook; creation rows carry `detail.shape` (none / sentinel / concrete / mixed). |
| `apps/web/src/lib/path-claim-check.ts:checkPathClaim` | `path_claim` | accepted | Each successful call, including an already-held-path no-op; excluded from friction rankings and bypass rates. |
| `apps/web/src/app/api/tasks/route.ts:POST` | `decomposition_refused` | rejected | Re-checks, at the moment the organizer's own planning task tries to create a non-retry child, whether sibling tasks were pre-filed against the mission after that planning task was created. `runMission()`'s own pre-filed-task detection only runs once, inside the SAME request that creates the mission — too early to see tasks a creator files right after. `detail.preFiledTaskIds`, `detail.organizerTaskId`; persists `missions.decompositionSkipped=true` and a mission note on the first trip. Exempt: manual-orchestration missions, and any create with an explicit `parentTaskId` (a retry naming the failing task). |
| `apps/web/src/lib/workflow/dead-effects.ts:escalateDeadEffect` | `workflow_effect_dead` | stranded / warned | A workflow-kernel effect went `dead` after its last retry (§10.3). `stranded` = a critical effect (`merge_call`, `verify_merge`, `push_recovery`, `post_review`, `dispatch_fix`, `dispatch_review`): the kernel applied `EffectDead`, moving the delivery to ESCALATED unless it had already left the state that owed the effect (`detail.applied`, `detail.result`). `warned` = a non-critical effect; nothing escalates. `detail.kind`, `detail.deliveryId`, `detail.dedupeKey`. |
| `apps/web/src/lib/base-advance-notice-store.ts:recordNotice` | `base_advance_notice` | warned | Advisory. A merged PR or a push landed on a live worker's base and touched files in its scope (observed touches ∪ declared `pathManifest`, prefix-aware, `**` never matches), so one rebase instruction was queued on the instruct path. Never the authoring worker. Debounced per worker+base: changes inside the window fold into the row (`detail.coalesced`, `detail.coalescedChanges`). `detail.baseRef`, `prNumber`, `sha`, `overlappingFiles`, `source` (pull_request / push), `strategy` (rebase / merge). Denominator for comparing conflict rates of notified and un-notified workers. |
| `apps/web/src/lib/mission-branch-refresh.ts:refreshMissionIntegrationBranch` | `mission_branch_refresh` | accepted / stranded | Keeping a mission's integration branch current with dev (docs/design/mission-delivery-arc.md P5, superseded). `accepted` = GitHub's merges API landed dev cleanly, a merge commit, no agent. `stranded` = a 409 conflict dispatched the one conflict-resolution task this mission is allowed to have open at a time (`detail.conflictTaskId`), or one was already open and nothing new was dispatched (`detail.dispatched: false`). A clean skip (already current, single-flight lease held, mission's own PR already merged, mission terminal) writes no row — only an actual merge attempt or a conflict is worth a ledger line. |

`get_manifest_coverage`, `get_path_claim_stats` and `get_decision_stats` read aggregate REST metrics.
Use `get_failure_analytics` with `family=gate` and
`errorPrefix="Change intent conflict"` to count delivered change-intent warnings.
