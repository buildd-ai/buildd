# Gate audit — server-side refusals, deferrals and bypasses

Generated audit output. Rebuildable, may be stale — never a source of truth.
Line numbers are against the commit that introduced this file.

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

`bypassed` is the load-bearing one. A lint's bypass rate over its total fire
count *is* its false-positive rate, measured directly instead of inferred from
however many friction reports someone had the patience to file.

## Sites

### POST /api/tasks — `apps/web/src/app/api/tasks/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 1 | `route.ts:392` | `task_param_vocabulary` | rejected | out-of-vocabulary `kind` |
| 2 | `route.ts:398` | `task_param_vocabulary` | rejected | out-of-vocabulary `complexity` |
| 3 | `route.ts:409` | `prose_gate` | warned | advisory dependency-gate lint; the three-week false-positive case |
| 4 | `route.ts:504` | `friction_dedupe` | rejected | `[friction]` filing appended to an open task with the same signature |
| 5 | `route.ts:689` | `subject_dedupe` | rejected | pre-dispatch attach on an identifying subject anchor |
| 6 | `route.ts:680` | `subject_dedupe` | bypassed | `fileAnywayReason` supplied against a live attach-eligible match |
| 7 | `route.ts:851` | `manifest_required` | rejected | mission PR task with no concrete `pathManifest` (carried a `TODO(gate ledger)` naming this task) |
| 8 | `route.ts:1043` | `subject_dedupe` | bypassed | `intakeSubject` resolved `filed_anyway` under an enforcing subject policy |
| 9 | `route.ts:1133` | `file_anyway` | rejected | `fileAnywayReason` blank |
| 10 | `route.ts:1136` | `file_anyway` | rejected | `fileAnywayReason` not permitted for this filing origin |

Sites 1 and 2 fire before the route resolves a workspace. They are recorded
through a wrapper that resolves the caller's raw workspace reference in the
fire-and-forget path, so they are still attributable without reordering the
validation (which would change which error a doubly-invalid request gets).

### Missions — `apps/web/src/app/api/missions/route.ts`, `apps/web/src/app/api/missions/[id]/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 11 | `missions/route.ts:151` | `branch_strategy` | rejected | create: invalid `branchStrategy` |
| 12 | `missions/route.ts:218` | `goal_criteria` | rejected | create: `validateGoalCriteria`, including the `notMechanizableReason` requirement on prose criteria |
| 13 | `missions/[id]/route.ts:223` | `branch_strategy` | rejected | update: invalid `branchStrategy` |
| 14 | `missions/[id]/route.ts:460` | `goal_criteria` | rejected | update: same validator, plus the stored-criteria comparison |

### PATCH /api/workers/[id] — `apps/web/src/app/api/workers/[id]/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 15 | `route.ts:1085` | `mission_base_adoption` | rejected | auto-detected PR on the worker's branch targets the wrong base |
| 16 | `route.ts:1138` | `output_requirement` | rejected | `pr_required` with no PR |
| 17 | `route.ts:1147` | `output_requirement` | rejected | `artifact_required` with neither PR nor artifact |
| 18 | `route.ts:1203` | `output_requirement` | rejected | `auto` with work done and no deliverable |
| 19 | `route.ts:1197` | `output_requirement` | bypassed | `discardEdits` acknowledged the edits as scratch |

Site 19 is the direct read on how often the `auto` gate is being talked out of
a refusal, which is the number that would have shown the reviewer-task
regression without a human noticing nine dead runs.

### create_pr — `apps/web/src/app/api/github/pr/route.ts` (POST)

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 20 | `pr/route.ts:682` | `pr_head_mismatch` | rejected | PR head is not the worker's own branch |
| 21 | `pr/route.ts:689` | `pr_base_mismatch` | rejected | PR base disagrees with the mission integration branch |

### merge_pr — `apps/web/src/app/api/github/pr/route.ts` (PUT)

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 22 | `pr/route.ts:1065` | `merge_policy` | rejected | `force` without an admin token |
| 23 | `pr/route.ts:1073` | `merge_policy` | bypassed | `force` accepted from an admin token — policy deliberately skipped |
| 24 | `pr/route.ts:1088` | `merge_policy` | rejected | PR head unreadable, so policy cannot be evaluated (fails closed) |
| 25 | `pr/route.ts:1110` | `merge_policy` | rejected | tier `human` |
| 26 | `pr/route.ts:1134` | `merge_policy` | rejected | tier `agent-review`, no self-mergeable approval |
| 27 | `pr/route.ts:1150` | `merge_policy` | rejected | `evaluateAutoMergeSafety` refused |
| 28 | `pr/route.ts:1168` | `mission_pr_lifecycle` | deferred | sibling task PRs still open against the integration branch |

### check_path_claim — `apps/web/src/app/api/tasks/[id]/path-claim/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 29 | `path-claim/route.ts:80` | `path_claim` | rejected | wildcard claim |
| 30 | `path-claim/route.ts:119` | `path_claim` | deferred | real overlap; caller registered as a waiter. `detail.deadlock` separates a circular wait from an ordinary one — the distinction a bare 409 could not carry |

### request_pr_review — `apps/web/src/app/api/github/pr/review/route.ts`, `apps/web/src/app/api/prs/[prNumber]/re-review/route.ts`

| # | file:line | gate | outcome | note |
|---|---|---|---|---|
| 31 | `pr/review/route.ts:197` | `reviewer_single_flight` | deferred | one reviewer per PR at a time; `force` never stacks a second |
| 32 | `re-review/route.ts:128` | `reviewer_single_flight` | deferred | same guard on the delta re-review path |

## Deliberately not wired here

The claim loop's per-reason deferrals, the runner's mirrored `claim_rejected`,
criteria evaluations that resolve to a non-verdict, and stranded-task
detection. Those belong to the sibling dispatch-ledger work, which consumes
this table rather than defining a second one.
