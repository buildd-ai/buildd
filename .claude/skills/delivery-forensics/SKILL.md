---
name: delivery-forensics
description: Measure buildd's own delivery loop from raw sources — prod DB, GitHub Actions, the Coder runner, KB and CBM. Use when asked why PRs conflict, why CI fails, how long the fail→resolve loop takes, whether PRs merge eventually, or for any "analyse the last N missions/PRs" question. Carries the access recipes that are non-obvious or actively broken.
---

# Delivery forensics

Four sources. Each answers something the others cannot. Use the DB for
*outcomes*, GitHub for *causes*, the runner for *liveness*, KB/CBM for *why the
code is shaped that way*.

## 1. Prod DB — the only place outcomes live

**Direct `psql` to Neon times out from a laptop** (5432 is not reachable; the
sandbox is not the problem — `dangerouslyDisableSandbox` fails identically).
Go over the neon HTTP driver instead, which is what the app itself uses.

```bash
S=<scratchpad>
grep -m1 '^DATABASE_URL=' apps/web/.env.local | sed 's/^DATABASE_URL=//; s/^"//; s/"$//' > $S/dburl
bun .claude/skills/delivery-forensics/scripts/q.ts $S/dburl $S/queries.sql
```

`apps/web/.env.local` is **live prod**. The repo-root `.env` is a stale Feb-era
branch — never analyse from it. `vercel env pull` returns no `DATABASE_URL`.

`q.ts` splits on `;\n`, prints one TSV block per statement, and prints `ERR <msg>`
instead of aborting, so a whole batch survives one bad column name.

### Which column answers which question

| Question | Where |
|---|---|
| Did the PR merge, and when | `workers.merged_at`, `workers.pr_lifecycle_status` (`merged`/`closed`/`ci_running`/`pr_open`/`unresolvable`) |
| How many times CI went red on it | `workers.pr_check_failure_count` |
| Was it a conflict | `workers.conflict_detected_at`, `workers.pr_unresolvable_reason` |
| Was this task remediation or real work | `tasks.task_class` ∈ `work` / `attempt` / `bookkeeping` |
| Which remediation kind, and for which PR | `tasks.ci_retry_pr_number` / `conflict_retry_pr_number` / `reviewer_retry_pr_number` |
| Retry rounds on one PR | `count(*)` of the above grouped by the PR number |
| Why the worker stopped | `workers.exit_cause` (`code_failure`/`infra_failure`/`sandbox_mount_gap`/`silent_start`/`budget_limited`/`never_started`) |
| Collision *avoidance* coverage | `path_claims` — join back to `tasks` to get the adoption rate; zero contention means low adoption, not a working lock |
| Mission rollup | `missions` + `tasks.mission_id` + `workers.task_id`; `missions.integration_branch_enabled`, `merge_policy` |

Gotchas:
- **Four PR columns are effectively unpopulated — do not build a metric on
  them** (verified across ~1.6k PR rows, all-time, 2026-09-21):
  `conflict_detected_at` ~15 rows, `pr_unresolvable_reason` **1 row
  table-wide**, `pr_check_failure_count > 0` ~14 rows, and `files_changed` zero
  on every integration PR while GitHub reports real sizes. So the
  `pr_unresolvable_reason` *mix* is not determinable from the DB at all.
  Dense substitutes: remediation dispatch (`tasks.*_retry_pr_number`) for
  "went red / conflicted", the Actions API for CI outcomes, and `gh` for PR size.
- `worker_error_traces` has **no `created_at`** — check
  `information_schema.columns` before writing a windowed query.
- Retry-task *status* matters as much as count: a large `cancelled` share means
  the remediation was thrown away, not that it succeeded.
- `tasks.title` carries the loop depth in prose (`[Conflict Retry #1] [reviewer
  retry #2] …`). Grouping on `regexp_replace(title,'^\[[^]]+\]\s*','')` finds
  duplicate remediation of the same subject.

## 2. GitHub Actions — the only place causes live

```bash
# runs: paginate; ~250 runs/day, so 18 pages ≈ 7 days
for p in $(seq 1 18); do
  gh api "/repos/buildd-ai/buildd/actions/runs?per_page=100&page=$p" \
    -q '.workflow_runs[]|[.id,.name,.head_branch,.head_sha[0:7],.event,.status,.conclusion,.run_attempt,.created_at,.updated_at]|@tsv'
done > $S/runs.tsv
```

**`gh run view <id> --log-failed` returns empty output and exit 0.** It is not a
retention problem. Go through the jobs API:

```bash
gh api "/repos/buildd-ai/buildd/actions/runs/$id/jobs" \
  -q '.jobs[]|select(.conclusion=="failure")|.id'
gh api "/repos/buildd-ai/buildd/actions/jobs/$jid/logs" | sed 's/^[0-9T:.\-]*Z //'
```

Failing *step* names are the cheap first cut — get them from the same jobs call
(`.steps[]|select(.conclusion=="failure")|.name`) before pulling any log.

To name the failing tests, the unit-test digest is at the tail of the `build`
job log, between `unit test files failed:` and `Full output`:

```bash
awk '/unit test files? failed:/,/Full output/'
```

`No Production Data` findings are **masked on purpose** (public repo,
world-readable logs) — you get the category (`PR body` / `commit message` /
`added code`) and the reason, never the value. Categorise on the `##[error]`
line; `^(ERROR|FAIL)` does not match it.

Read `cancelled` as "superseded by a newer push", not as a failure.

## 3. Coder runner — liveness only

See the `coder-workspace` skill for SSH and the restart traps.

`/home/coder/.buildd/logs/*.log` hold **structured events only** — no agent
transcript, no test output, no conflict text. `session_start.detail` is the one
useful field (mode, worktree path). Do not plan a failure analysis around these
logs; grepping 166 of them for "conflict" yields five hits, all of them the task
title. `claims.log` is real signal for starvation (`diagnosticReason`).

`curl -s localhost:8766/api/version` → `currentCommit` vs `diskCommit`/`commitDrift`.

## 4. KB and CBM

- `recall` (`scope:["memory","task"]`) — thin on delivery-loop questions; it
  indexes task summaries, so it answers "has this exact failure been seen"
  better than "what is our conflict rate".
- `codebase-memory` `search_graph` — use it to find the *policy* code behind a
  number, e.g. `DEFAULT_MAX_CI_RETRIES` in `apps/web/src/lib/ci-retry.ts`,
  `classifyMergeFailure` / `dispatchConflictRetry` in `conflict-retry.ts`.

## 5. Base drift — measured, and it does NOT predict merge

**Corrected 2026-09-21 by direct measurement; the earlier claim here was wrong.**
Base drift does not predict merge probability on this repo. Measured
non-circularly (drift in a PR's first 6h, so the window does not depend on the
outcome), merge probability *rises* 88% → 97% as drift climbs, and deciles are
flat at 84–100%. The apparent cliff above 50 drift events is 6 PRs and is an
**artifact of measuring to `now()` for still-open PRs** — a still-open PR
accumulates drift precisely because it has not merged, so naive drift is
circular. If you compute drift, bound the window independently of the outcome.

The arithmetic explains why: at ~20 merges/day on `dev` and a *median
time-to-merge of ~18 minutes*, a typical PR sees its base move 0.25 times. Drift
cannot drive an outcome it never gets the chance to touch.

**Use PR size instead** — it separates cleanly: OPEN p50 ≈ 15 changed files vs
MERGED p50 ≈ 5.

Drift is still worth computing for one narrower question: comparing *branch
strategies*. An integration branch has a slower-moving base than trunk
(measured p90 drift 2 vs 8), and that does track a lower conflict-retry rate —
conflict-retry, not final merge, since most conflicted PRs merge anyway.

Script (keep the outcome-independent window in mind):

```bash
bun .claude/skills/delivery-forensics/scripts/base-drift.ts $S/prs.json
```

Feed it `gh pr list --state all --limit 300 --json number,title,state,createdAt,mergedAt,baseRefName,changedFiles`.
Do **not** add `author`, `commits`, or `reviews` at that limit — the GraphQL node
budget rejects the query.

Concurrent-file contention needs git, not the API: `git log origin/dev --since=…
--pretty=format:'@@%H|%s' --name-only`, map `(#NNNN)` in the squash subject back
to the PR, and intersect file sets across overlapping lifetimes.
