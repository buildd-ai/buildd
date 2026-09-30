---
status: proposed
---
# PR Merge Reliability: why agent PRs close unmerged, and what stops it

**Status:** Proposed
**Related:**
- `apps/runner/src/git-operations.ts` — `setupWorktree`, `listBranchOwners`, the `unusable()` candidate ladder
- `apps/runner/src/worker-sync.ts` — `evictCompletedWorkers`, `TERMINAL_WORKER_RETENTION_MS`
- `apps/runner/src/worktree-utils.ts` — `resolveWorktreeBase`, `shouldPreserveWorktreeOnSessionEnd`
- `apps/web/src/app/api/github/pr/route.ts` — `create_pr`, `closeAncestorRetryPrs`
- `apps/web/src/lib/auto-merge.ts` — `evaluateAutoMergeSafety`, `tryAutoMergeWorkerPr`
- `apps/web/src/lib/conflict-retry.ts` — `dispatchConflictRetry`, `classifyMergeFailure`
- `apps/web/src/lib/pr-branch-update.ts` — behind-only update-branch
- `apps/web/src/lib/ci-retry.ts` — `buildCIRetryTask`, `DEFAULT_MAX_CI_RETRIES`
- `apps/web/src/lib/change-intent.ts` — `findConflictingIntents`
- `apps/web/src/app/api/cron/pr-reconcile/route.ts`
- `docs/design/retry-continuity.md` (implemented) — the resume-branch contract this doc finds broken in one specific shape
- `docs/design/deliverable-uniqueness.md` (proposed) — authoring-time duplicate prevention; §M5 here is its create-time backstop
- `docs/design/convergence-layer.md` — merge-order edges; §M7 here is the merge-train sibling
- `.claude/skills/delivery-forensics/SKILL.md` — how every observation below was measured

---

## Problem

Measured over the last two weeks of this repo's agent PRs (branches `buildd/*`
and `mission/*`), from GitHub, the production `workers`/`tasks`/`gate_events`
tables and the runner log:

1. **Agent PRs mostly merge.** The large majority of agent-authored PRs merge;
   closed-unmerged is a small minority and open-stale is near zero. Time to
   merge is short at the median and long in the tail (hours), so the loss is
   less "work never lands" than "work lands on its third PR number, hours
   later, after the old ones were closed".

2. **The dominant closed-unmerged cause is self-inflicted supersession.** Well
   over half of all closed-unmerged agent PRs carry the bot comment
   *"This pull request has been superseded by #N (resume branch was
   unavailable; new attempt opened a fresh PR)"*. Every such chain's
   terminal PR merged — no work was lost — but each hop costs a new branch, a
   fresh CI run, a fresh review from zero, and a PR history split across
   numbers. The shape repeats up to four hops on one change
   (`after review #1 → #2 → #3`).

   It is concentrated on **reviewer retries**: of the request-changes retries
   that pushed at all, a clear majority opened a *new* PR instead of
   updating the one under review. CI retries do it occasionally; conflict
   retries almost never.

   The comment's text is wrong about the cause. The resume branch *was*
   available on origin (the PR was still open on it) and the retry task's
   `context.resumeBranch` named it correctly. The runner log shows the actual
   diversion:

   > Cannot check out "buildd/…" in a worktree — it is already checked out in
   > worktree …/.buildd-worktrees/buildd_…. Using "buildd/…-builder-after-r…" instead

   The holder is the **prior attempt's own worktree**, deliberately retained
   after `done` for session resume (`shouldPreserveWorktreeOnSessionEnd`), and
   reclaimed only after `TERMINAL_WORKER_RETENTION_MS` (ten minutes) by
   `evictCompletedWorkers`. A reviewer verdict plus a retry dispatch routinely
   arrives inside that window, so `unusable()` returns `checked_out` for the
   resume branch and the ladder falls to the retry task's own branch. No
   `resume_branch_fallback` trace fires on this path — that trace is only
   raised for `missing`/`diverged` — so the diversion is invisible outside the
   runner's stdout.

3. **The supersede close is best-effort.** `closeAncestorRetryPrs` runs
   fire-and-forget after `create_pr` returns. When it silently does nothing,
   two open PRs carry one fix — observed live at the time of writing (an
   original PR and its after-review successor, both open and both green).

4. **Duplicate work from parallel tasks.** A smaller cluster: two friction
   tasks filed against the same recurring failure before either fix merged
   produced byte-identical diffs; two tasks built competing models of the
   same feature; a CI-retry "fix" re-applied a change already on the base.
   All closed by a human or the bot after someone noticed.

5. **Contaminated diffs from a moved base.** Another small cluster: branches
   whose diff mixed in an already-merged sibling feature (cut from a mission
   integration branch that was later squash-merged, or resumed from a stale
   branch), so the PR "mechanically reverts" work that landed meanwhile. The
   only remedy applied was close-and-redo. The runner's stale-base check in
   `setupWorktree` is advisory only.

6. **Orphaned open PRs.** An agent PR can sit conflicting with nobody on it:
   a conflict-fix push invalidated the reviewer's approval ("approval was
   made against an earlier commit"), the base moved again, and no second
   conflict retry or escalation followed. It stays open until a human reads
   the list.

7. **The freshness treadmill (latency, not loss).** Since
   `merge_base_freshness` shipped in `evaluateAutoMergeSafety` (refuses at
   `behind_by > 0`), it is the most frequent auto-merge refusal by a wide
   margin. Behind-only refusals already route through GitHub's update-branch
   (`pr-branch-update.ts`) rather than an agent, so this is cheap in tokens,
   but each update re-runs full CI, and under a busy `dev` a PR can be
   refused several times before it lands. This is the long tail of time to
   merge.

8. **Red `dev` after the freshness gate.** `dev` still went red a handful of
   times in the window, including one multi-hour streak. Causes seen: a
   repo-wide invariant test tripped by combining PRs, a skill/vocabulary drift
   test, and a date-sensitive unit test. CI retries dispatched *during* red
   windows were rare, so this is not currently a loss driver, but nothing in
   `ci-retry.ts` would stop an agent being sent to fix a failure that lives
   on the base.

### Already built — not re-proposed here

Checked against `git log origin/dev`: behind-only update-branch before any agent
dispatch; the dependency-bot CI-retry storm (a renovate PR once drew a dozen
CI-retry tasks) now gated; path-overlap self-blocking on a task's own PR
(#2736, #2773, #3102); one reviewer per PR head (#2691); merged ancestors skipped
on supersede; never deleting a local branch with unpushed commits (#2671);
reviewer-retry `baseBranch` no longer duplicating `resumeBranch` (#2674);
release PRs merged with a merge commit rather than a squash, which ended the
dev-history rewrite that used to conflict every open PR. The stale "CI running"
read (a GitHub App check suite with no runs) and the list_prs "needs you / who is
on it" signals are on branch `feat/pr-list-signals` and assumed to land before
this work.

---

## Proposal

Seven mechanisms, ordered by expected effect. Each names its detection signal,
owner component, safety bound and fallback. Every one ships behind a default
that reproduces today's behaviour.

**The crux is M1: may a retry take a branch away from a retained, terminal
worktree of the *same lineage*?** If yes, the dominant closure cause disappears
at the source and M2 becomes a rare-path safety net. If that is wrong — if a
retained `done` session can still be resumed (follow-up message, answered
question) and push to the branch — two writers share one branch and a resume
pushes stale work over the retry's. The design therefore takes the branch only
from a holder that (a) is terminal, (b) belongs to an ancestor in the retry
lineage, and (c) is marked non-resumable in the same step.

### M1 — Release a lineage-held resume branch instead of diverting (load-bearing)

**Where:** `setupWorktree` in `apps/runner/src/git-operations.ts`, at the point
`unusable(resumeCandidate)` returns `checked_out`.

**Change:** when the holder worktree belongs to a worker in `this.workers` that
is `done` or `error` (never `waiting`, never live) and whose task is the retry
task's parent or an `attempt`-class ancestor:

1. Run `git -C <holder> switch --detach` (keeps the tree and any uncommitted
   files for forensics; frees the branch ref). If the holder has commits not on
   `origin/<resumeBranch>`, refuse — that is `protectUnpushed` territory and the
   existing fallback applies.
2. Mark the holder worker non-resumable (clear its session resume handle), so a
   late follow-up message starts a fresh session rather than resuming onto a
   detached tree.
3. Check out `resumeBranch` for the retry as the ladder intended.

**Detection:** new error-trace pattern `resume_branch_held` raised on *every*
`checked_out` diversion (today it raises nothing), with `released: true|false`.
Outcome metric: share of reviewer/CI retries whose `workers.pr_number` equals the
parent's — the "same-PR convergence rate". Target: conflict-retry parity (near
total).

**Bound:** one release per setup; never touches a `waiting` or live holder; never
a holder outside the lineage.

**Fallback:** today's behaviour — task branch, new PR, M2 supersede.

**Flag:** `BUILDD_RELEASE_LINEAGE_HELD_BRANCH`, default off.

### M2 — Make supersession synchronous, verified and honest

**Where:** `closeAncestorRetryPrs` in `apps/web/src/app/api/github/pr/route.ts`.

**Change:** await the close inside `create_pr` (bounded, e.g. one retry on
GitHub 5xx) and return `supersededPrs: [{number, closed: bool, reason}]` in the
response. Rewrite the comment to name the actual cause the runner reported
(`checked_out` / `missing` / `diverged`) — carried from the worker's
`resume_branch_*` trace — instead of always claiming the branch was unavailable.
Carry the prior PR's open review findings into the successor's body so the new
reviewer does not start from zero.

**Detection:** `pr-reconcile` cron gains a check: two open agent PRs whose
workers share a retry-lineage root. It closes the older (same guards as today:
read live state, never touch merged) and emits a gate event.

**Bound:** closes only `attempt`-lineage ancestors, same walk as today.

**Fallback:** if the close still fails, the successor PR body names the
unclosed ancestor and list_prs marks both "duplicate lineage".

### M3 — No orphan PRs: every open agent PR has an owner or a needs-you item

**Where:** `apps/web/src/app/api/cron/pr-reconcile/route.ts`, reading
`workers.pr_lifecycle_status` and active remediation tasks
(`tasks.*_retry_pr_number`).

**Invariant:** an open agent PR in `conflict`, `ci_failed`, or approved-but-stale
state has, within a bounded window, either a live remediation task, a pending
reviewer, or an escalation in the needs-you inbox. When none holds, the sweep
dispatches the next step the existing policy would have (conflict retry if the
cap allows; a re-review when the only blocker is an approval against an earlier
head), or escalates via the existing `escalateConflictExhaustion` path.

**Detection:** count of open agent PRs with no owner older than the window —
should be zero.

**Bound:** uses existing per-PR caps; never a new cap; one action per PR per
sweep.

**Fallback:** needs-you escalation; nothing is ever silently closed by this sweep.

### M4 — Contaminated-diff guard at `create_pr` and on synchronize

**Where:** `create_pr` route and the `pull_request.synchronize` webhook.

**Detection:** compute `git patch-id` for each commit in `base...head` (via the
compare API's commit list) and flag commits whose patch-id already exists on the
base — the signature of a branch carrying pre-squash copies of work that landed.
Secondary signal: fraction of changed files outside the task's `pathManifest`.

**Action:** above a threshold, refuse auto-merge with a reason phrased so
`classifyMergeFailure` routes it to a conflict retry whose instruction is
"rebuild your own commits onto a fresh branch from the base" (cherry-pick, not
merge). Below it, warn in the PR activity comment.

**Bound:** one rebuild attempt, then needs-you.

**Fallback:** warn-only.

### M5 — Duplicate-diff guard at `create_pr`

**Where:** `create_pr`, alongside the existing `findConflictingIntents` call.

**Detection:** whole-diff patch-id equal to an open PR's or to a PR merged in the
last few days, or the task's subject PR already merged.

**Action:** equal to a merged PR → do not open; complete the task as
superseded via the existing `record_pr_supersession` edge. Equal to an open PR →
open as draft, link both, flag in list_prs. This is the create-time backstop for
`deliverable-uniqueness.md`, which prevents the duplicate at authoring time.

**Fallback:** warn-only.

### M6 — Base-red awareness in CI retry

**Where:** CI-retry dispatch (`buildCIRetryTask` caller in the webhook).

**Detection:** the failing check's test files also fail on the latest completed
`build.yml` push run of the PR's base.

**Action:** do not dispatch an agent; mark the PR `ci_failed (base red)` and
re-run its checks when the base goes green. Reuses the existing retry cap if the
base signal is unavailable.

**Bound:** read-only on the base; never dispatches more than today.

**Fallback:** today's dispatch.

### M7 — Per-base merge train for green-but-behind PRs (latency)

**Where:** `tryAutoMergeWorkerPr` / `evaluateAutoMergeSafety`.

**Change:** when the only refusal is `merge_base_freshness`, enqueue instead of
racing: at most one update-branch → CI → merge cycle in flight per base ref;
others wait their turn. Today every behind PR updates at once, all re-run CI, the
first to merge makes the rest behind again. The freshness rule itself stays:
green must be proven against the tree that will be produced.

**Detection:** freshness refusals per PR before merge; target at most one.

**Bound:** queue position times CI duration; a head push or refusal of another
kind drops the PR from the queue.

**Fallback:** today's concurrent update-branch.

---

## Rollout order

1. **M1 trace only** — raise `resume_branch_held` on every `checked_out`
   diversion; no behaviour change. Confirms the cause at population scale (the
   runner log only covers the time since the last restart).
2. **M1 release** behind its flag on one runner; watch the same-PR convergence
   rate and for any `waiting` holder touched (must be none).
3. **M2** synchronous close + honest comment + lineage-duplicate sweep.
4. **M3** orphan-PR invariant in `pr-reconcile`, dry-run (log the action it would
   take) for a week, then on.
5. **M4 / M5** warn-only, then enforce once false positives are read off the
   gate ledger (bypass rate = false-positive rate).
6. **M6**, then **M7** — lowest loss impact, latency only.

## Test plan

- **M1** — `apps/runner/__tests__/unit/`: real git fixture repo (bare origin + two
  worktrees). Prior worker `done` holding `resumeBranch`, retry setup →
  checks out `resumeBranch`, holder detached, holder marked non-resumable.
  Negative cases: holder `waiting`; holder live; holder outside the lineage;
  holder with unpushed commits — each keeps today's diversion and raises
  `resume_branch_held` with `released:false`. Regression test first: today's code
  diverts in the `done`-holder case.
- **M2** — co-located `route.test.ts`: close awaited and reported; comment names
  the runner-reported reason; a GitHub failure leaves the response
  `closed:false` and the successor body names the ancestor. Sweep test renders
  the lineage query through `PgDialect` so the WHERE scoping is asserted, not
  mocked away.
- **M3** — sweep table test over lifecycle × owner-present × cap-remaining,
  asserting exactly one action or none; SQL rendered, not mocked.
- **M4 / M5** — pure functions over fixture commit lists (patch-id equality,
  out-of-manifest ratio); route tests for warn vs enforce.
- **M6** — webhook test: base run failing on the same file suppresses dispatch;
  base signal unreadable falls back to dispatch.
- **M7** — queue unit tests: one in flight per base; head push dequeues; a
  non-freshness refusal dequeues.
- **Outcome check** after each step, via the delivery-forensics recipes:
  supersession-comment rate on closed agent PRs, same-PR convergence rate,
  orphan open PRs, freshness refusals per merged PR.

## Open questions

- **Should the retained worktree exist at all for a task that has a PR under
  review?** Leaning keep: resume-on-follow-up is real value, and M1's
  release-on-demand is narrower than changing retention globally. Shortening
  `TERMINAL_WORKER_RETENTION_MS` would shrink the race window but not close it.
- **Detach or push-to-upstream?** The alternative to M1 is cutting the retry on
  its own local name with upstream set to `resumeBranch`. Leaning detach: agents
  push by explicit branch name, and `workers.branch` must equal the pushed ref
  for `create_pr`.
- **M3's window.** Leaning one reconcile interval past the longest normal CI
  run; a human should confirm how long an unowned conflicting PR is acceptable.
- **M7 vs GitHub's native merge queue.** Native queue needs branch rules on
  `dev`, which previously became a trap (a blocked PR never retries). Leaning
  app-side.
- **Reviewer single-flight after a head change.** Refusals of "this PR already
  has a review" appear often in the gate ledger; whether any of them block the
  re-review M3 wants to dispatch needs checking before M3 enforces.

## Non-goals

- Changing the freshness rule's strictness — green must still be proven against
  the merged tree.
- Authoring-time duplicate prevention (`deliverable-uniqueness.md` owns it).
- Human-authored branches and release PRs; this covers agent PRs only.
- Retry caps and budgets — no mechanism here raises one.
- Flaky-test quarantine; M6 only stops agents being sent at base failures.
