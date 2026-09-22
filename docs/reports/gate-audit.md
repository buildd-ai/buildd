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

### PATCH /api/workers/[id] — `apps/web/src/app/api/workers/[id]/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 15 | `route.ts:1087` | `mission_base_adoption` | rejected | auto-detected PR on the worker's branch targets the wrong base |
| 16-18 | `route.ts:1143` | `output_requirement` | rejected | `pr_required` / `artifact_required` / `auto`. All three refuse through `persistRejectedCompletionPayload`, so the ledger row is written there — a fourth arm cannot be added that preserves the payload and forgets the ledger |
| 19 | `route.ts:1249` | `output_requirement` | bypassed | `discardEdits` acknowledged the edits as scratch |
| 19a | `route.ts` terminal block | `worker_patch_refused` | rejected | the runner reporting that a prior mutation of ours was refused with a non-gate 4xx (or an unqueueable 5xx). Those reports are exempt from the task's retry budget, so this row is what keeps the exemption countable: a rise here means we are rejecting the runner's requests, not that agents are failing. An output-gate refusal is deliberately excluded — it already has its `output_requirement` row from sites 16-18 |

Site 19 is the direct read on how often the `auto` gate is being talked out of
a refusal, which is the number that would have shown the reviewer-task
regression without a human noticing nine dead runs.

### create_pr — `apps/web/src/app/api/github/pr/route.ts` (POST)

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 20 | `pr/route.ts:687` | `pr_head_mismatch` | rejected | PR head is not the worker's own branch |
| 21 | `pr/route.ts:705` | `pr_base_mismatch` | rejected | PR base disagrees with the mission integration branch |

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

### check_path_claim — `apps/web/src/app/api/tasks/[id]/path-claim/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 29 | `path-claim/route.ts:96` | `path_claim` | rejected | wildcard claim |
| 30 | `path-claim/route.ts:193` | `path_claim` | deferred | real overlap; caller registered as a waiter. `detail.deadlock` separates a circular wait from an ordinary one — the distinction a bare 409 could not carry |

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
| 35 | `claim/route.ts` (`runner` field missing) | `claim_loop_deferral` | rejected | malformed claim request |
| 36 | `claim/route.ts` `deferTask()` — 13 dispatch-loop sites (`connector_mismatch`, `subject_dead`, `path_overlap` ×2, `mission_budget`, `mission_concurrent`, `mission_paced`, `advisory_manifest`, `workspace_cap`, `provider_unavailable`, `budget_paused` ×2, `routing_paused`, `duplicate_worker`, `codex_single_flight`) | `claim_loop_deferral` | deferred | one row per (taskId, reason) per tick, coalesced across polls via `recordOrCoalesceDeferral` into a `detail.consecutiveDeferrals` counter with a `detail.firstDeferredAt` floor. `codex_single_flight` replaces what used to be discovered post-claim, in the runner, by killing a started worker (`apps/runner/src/workers.ts` still keeps that check as a race backstop for two concurrent claim requests this in-batch guard can't see) |
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
