---
status: proposed
---
# PR Landing Guarantee: approved and green always lands, or pages once

**Status:** Proposed
**Related:**
- `apps/web/src/lib/auto-merge.ts` — `evaluateAutoMergeSafety`, `tryAutoMergeWorkerPr`, `escalateConflictExhaustion`
- `apps/web/src/lib/review-verdict-gate.ts` — `guardReviewVerdict` and its optional `carryForward` hint
- `apps/web/src/lib/approval-carry-forward.ts` — `carryForwardApprovalIfUnchanged`
- `apps/web/src/lib/pr-content-equivalence.ts` — `isContentEquivalentHead`
- `apps/web/src/lib/conflict-retry.ts` — `dispatchConflictRetry` (`behindOnly`), `DEFAULT_MAX_CONFLICT_ITERATIONS`
- `apps/web/src/lib/pr-branch-update.ts` — `updateBehindPrBranch`
- `apps/web/src/app/api/github/webhook/route.ts` — `handleCheckSuiteEvent`
- `apps/web/src/app/api/workers/[id]/route.ts` — reviewer approve path
- `apps/web/src/lib/reviewer-gate.ts`
- `apps/web/src/app/api/github/pr/route.ts` — `merge_pr` (PUT)
- `apps/web/src/app/api/prs/[prNumber]/merge/route.ts` — dashboard merge
- `apps/web/src/app/api/prs/[prNumber]/apply-recommendation/route.ts`
- `apps/web/src/app/api/cron/pr-reconcile/route.ts`, `cron-manifest.json`, `apps/web/src/lib/cron-due-queue.ts`
- `apps/web/src/lib/notify.ts` (`notifyTeamOf`), `apps/web/src/lib/gate-ledger.ts`, `apps/web/src/lib/github-install-state.ts` (HMAC state pattern)
- `docs/design/worker-pr-automerge.md` (predecessor, see Findings)
- `docs/design/merge-policy.md` §2.1 (gates), §3 (agent-review)
- `docs/design/pr-merge-reliability.md` M3 (orphan PRs), M7 (merge train)
- `docs/design/cron-wake-windows.md` (Redis-gated ticks)
- `docs/design/conflict-aware-orchestration.md` §4 (on its mission branch, not yet on `dev` — see Boundary)

---

## Problem

A PR the reviewer approved, with every required check green, sits open for
hours until a person notices and merges it by hand. Nothing is wrong with the
PR. The dashboard says "waiting on checks"; the checks finished long ago.

Two recent incidents, reconstructed from the gate ledger and the PR's commit
and check-run history (details: task `674bebe6`):

**Incident A — silent freshness refusal.** The reviewer approved. In the same
second the approve path's first merge attempt was refused by
`merge_base_freshness` (the PR was behind `dev`), so `dispatchConflictRetry`
(`behindOnly`) asked GitHub's update-branch API to merge `dev` in, which it
did. The approve path then made its **second** merge attempt — still keyed to
the *old* head SHA. Freshness refused again; `updateBehindPrBranch` sent
`expected_head_sha` = the old head, GitHub refused because the head had just
moved, and `dispatchConflictRetry` treated that refusal as a conflict and filed
an agent "after conflict" task. That task was never claimed. CI went green on
the new head a few minutes later, but `dev` had moved by one commit during
the run, so the check_suite event was refused by freshness again. This time
`dispatchConflictRetry` found the live (unclaimed) agent task, returned
`inFlightTaskId`, and `tryAutoMergeWorkerPr` took its "duplicate dedup hit"
branch: return, no marker, no alert. No further event ever arrived. The
verdict gate was never reached.

**Incident B — stale approval with no re-review.** The reviewer approved
early. The branch was then updated from base twice (content-preserving), then
a person resolved a real conflict in a version bump, which changed the PR's
own lines. CI went green. `handleCheckSuiteEvent`'s agent-review branch ran
`carryForwardApprovalIfUnchanged` first — correctly finding the diff changed —
and `tryAutoMergeWorkerPr` was refused by `guardReviewVerdict` as
`stale_approval` (a `deferred` ledger row). That refusal is right. What is
wrong is what happened next: nothing. No re-review was dispatched, no one was
told. The PR sat until someone requested a review by hand; that review
approved within a minute and the PR merged.

### Root cause

Step 0 of this work confirmed in code (not the earlier hypothesis that the
check_suite path lacks carry-forward — it has it):

1. **The dominant blocker is `merge_base_freshness`, and its refusal is
   silent when the refresh primitive does not dispatch.** It is the most
   frequent merge refusal in the gate ledger and is never bypassed. `evaluateAutoMergeSafety` refuses
   on `behind_by > 0`; `tryAutoMergeWorkerPr` (`auto-merge.ts`, the
   `classifyMergeFailure(...) === 'conflict'` block) calls
   `dispatchConflictRetry({ behindOnly })`. On `inFlightTaskId` (a live retry)
   or any non-dispatch other than `exhausted`/`superseded`, it returns with no
   marker and nothing that re-drives the PR. Merges are event-driven only; a
   refused PR whose next event never comes is stranded.
2. **The approve path evaluates a stale head on its second attempt.** It
   calls `tryAutoMergeWorkerPr` twice (bounded, then unbounded) with the SHA
   the reviewer read. When the first attempt updated the branch, the second
   one's update-branch refusal is misread as a conflict and files an agent
   task — which then *blocks* the next refresh through the live-retry dedup.
   (Classifying update-branch failures correctly is §4's job; see Boundary.)
3. **Carry-forward is not on every door.** `handleCheckSuiteEvent`
   (agent-review branch) calls `carryForwardApprovalIfUnchanged` before its
   merge, and the `merge_pr` fix added the `carryForward` hint to
   `guardReviewVerdict` on `PUT /api/github/pr` and
   `POST /api/prs/[prNumber]/merge`. But `tryAutoMergeWorkerPr` calls
   `guardReviewVerdict` **without** the hint. So the auto-threshold tier (which
   never runs the webhook's agent-review branch) and the approve path refuse a
   diff-unchanged new head as `stale_approval`, and reviewer-gate's predicate
   (`resolveReviewerGate`, which does not merge) reports it the same way.
4. **A correct `stale_approval` has no follow-up.** When the diff really
   changed, the right next step is a re-review; nothing dispatches it, and
   `request_pr_review` refuses a second review without `force`.
5. **No backstop.** No sweep re-drives approved + green PRs, so any lost
   event is fatal to latency.

## Findings: what `worker-pr-automerge.md` shipped

That doc's frontmatter says `implemented`; its body said "Proposed". What
actually shipped, checked against the code:

| Section | Shipped? | What exists instead |
|---|---|---|
| S1 rebase-on-dirty | Partly | `mergeable_state` `dirty`/`blocked` refusals are in `evaluateAutoMergeSafety`. A dirty PR dispatches an agent conflict retry (`dispatchConflictRetry`), not update-branch. update-branch is used only for behind-only PRs (`updateBehindPrBranch`), added later with the freshness gate. |
| S2 notify on every skip | No | No `notifyAutoMergeSkip`. A refusal writes a gate-ledger row and, only for mission tasks, a mission-feed note (`notifyMissionPrReady`). Standalone tasks get no push. Pushover fires only on conflict exhaustion, reviewer exhaustion and supersession. |
| S3 `autoMergePending` marker | No | No marker anywhere. The race it addressed (check_suite before `prNumber` is recorded) was closed by `create_pr` recording the PR up front. |
| S4 source-line cap | Yes, differently | `threshold.maxSourceLines` with generated/lockfile exclusion, auto-threshold only. |
| S5 `review_needed` note | No | Escalations use the needs-you inbox (`merge-policy.md` §5.5). |

**Why the freshness gate reintroduced the stall.** The freshness gate was
added after merges on stale greens were observed, and it deliberately phrased
its refusal as "needs rebase" so it would ride the conflict-retry path and
"converge on its own". That convergence argument holds only if every refusal
produces either a push (which re-fires CI) or an escalation. The conflict-retry
path has a third exit — dedup against a live retry — which produces neither.
S2 (notify every skip) and S3 (a marker) were exactly the two pieces that
would have turned that exit into a wait-with-owner; neither shipped. The
freshness gate multiplied how often a PR passes through that exit.

This PR updates `worker-pr-automerge.md`'s body status to say which parts
shipped and points here for the rest.

---

## The contract

> **Invariant.** A PR that is *approved* — a terminal `approve` verdict on its
> current head, or on a head the current head is content-equivalent to — and
> whose required checks are green on a base *within policy* WILL merge within
> a bounded time (target ≤ 30 min after the last required event). Otherwise
> the operator gets **exactly one** Pushover that lets them trigger the fix
> in one tap. There is no third outcome.

"Within policy" is defined by the treadmill bound (§D). "Approved" is defined
by carry-forward (§B). The bound covers the platform's own latency. It does
not cover waiting on a runner to pick up a fix task, which is a separate
`needs_fix` outcome that the alert covers.

## Proposal

**The crux: behind-base is a work item with an owner, never a refusal with
none.** Every non-merge outcome of the landing function must leave the PR in
exactly one of three states: *a push is in flight* (a marker names the SHA whose
green lands it), *a fix is in flight* (a task with a bounded attempt budget),
or *a human has been paged once*. If this is wrong — if any branch can return
"not merged" without one of those three — the stall comes back through that
branch, which is what happened to the freshness gate. The truth-table test in
§J exists to enforce this: every row must map to one of the typed outcomes, and
every non-`merged` outcome must name its owner.

### A. One landing function

`landPr()` in `apps/web/src/lib/pr-landing.ts` (new). Every door calls it; no
door calls `tryAutoMergeWorkerPr` or `mergePullRequest` directly any more.

```ts
type LandingOutcome =
  | { kind: 'merged'; sha: string }
  | { kind: 'updating_branch'; newHeadSha: string }      // marker written
  | { kind: 'waiting_ci'; headSha: string }              // checks pending on the live head
  | { kind: 'needs_fix'; reason: string; fix: FixKind; taskId?: string }
  | { kind: 'needs_human'; reason: string; cause: HumanCause };

type FixKind = 're_review' | 'ci_fix' | 'conflict' | 'renumber_migration';
type HumanCause =
  | 'deny_path' | 'contract_migration' | 'size_cap' | 'blocking_verdict'
  | 'fix_exhausted' | 'refresh_exhausted' | 'human_tier' | 'bound_refused';

landPr(input: {
  workspaceId: string; installationId: number; repoFullName: string;
  prNumber: number;
  /** The SHA the caller's event was about. Advisory only. */
  eventHeadSha: string | null;
  door: 'check_suite' | 'approve' | 'merge_pr' | 'dashboard' | 'sweeper';
  actor: { kind: 'system' } | { kind: 'agent'; workerId: string } | { kind: 'human'; userId: string; override?: HumanOverride };
  mode: 'enforce' | 'shadow';
}): Promise<LandingOutcome>
```

Order of evaluation, each step recording a gate event on refusal (no
console-only branches — every `return` other than `merged` writes exactly one
ledger row with `detail.landingOutcome`):

1. **Read the live PR once.** Head SHA, base ref, `mergeable_state`, state.
   Closed/merged → return early (idempotence for the sweeper). The live head is
   authoritative; `eventHeadSha` only decides whether this event is stale
   (a stale event with a live marker for a newer SHA is a no-op, not a refusal).
2. **Carry-forward, always, before the verdict gate.** Call
   `carryForwardApprovalIfUnchanged` with the live head and base ref, then
   `guardReviewVerdict` **with** the `carryForward` hint. Rules unchanged:
   only `approved` carries; a blocking verdict stays blocking; a push that
   changes the PR's own lines (`isContentEquivalentHead` false) is never
   carried; an unverifiable comparison is "not equivalent".
3. **Verdict outcome.**
   - approved (direct or carried) → continue.
   - `stale_approval` after carry-forward → `needs_fix(re_review)`: dispatch
     a re-review of the live head through the existing `request_pr_review`
     machinery with force semantics for this one case (the prior approval is
     provably not about this code). Bounded by the reviewer retry budget.
   - `changes_requested` / `escalated` → `needs_human(blocking_verdict)` only
     if no reviewer-retry task is live; otherwise `needs_fix` naming it.
   - `in_flight` → `waiting_ci`-equivalent wait (a reviewer is working); no page.
   - Tier `human` → `needs_human(human_tier)` without paging (the tier
     *is* the human's queue; see §H).
4. **Safety rails** — `evaluateAutoMergeSafety` exactly as today (CI,
   deny paths, migration inspector, size cap on auto-threshold, `dirty`,
   `blocked`, freshness, live-head match), with the freshness step replaced by
   §C/§D below. A red required check → `needs_fix(ci_fix)` via the existing
   CI-retry path; never merged past.
5. **Merge** via `mergePullRequest(..., expectedHeadSha)`; clear the marker;
   `finalizeMissionPrMerge` as today. A merge-API conflict → §C.

The approve path's *bound* (`ModelApproveBound`) stays: it is an extra input,
`landPr` evaluates it where `tryAutoMergeWorkerPr` did, and a bound refusal on a
PR whose stored approval is self-mergeable under the unbounded rule proceeds
under that rule inside the same call (today this is the approve path's second
attempt; it becomes a branch in one evaluation, on one live head).

### B. Carry-forward on every door

Step 2 above is inside `landPr`, so every door gets it by construction. The
only behavioural change for the doors that already had it (`merge_pr`,
dashboard) is none. For the auto-threshold tier, the approve path and
reviewer-gate it removes the `stale_approval` refusal on a diff-unchanged head.
The equivalence predicate itself is not changed.

### C. Behind-base is a work item

When freshness (or GitHub's `behind`, or a merge-API "base modified" race)
blocks the merge and the §D bound does not accept it:

1. Call the **existing** refresh primitive — `dispatchConflictRetry({
   behindOnly: true })`, which calls `updateBehindPrBranch` pinned to the
   **live** head (not the event's head). `landPr` does not classify
   update-branch failures itself; that is §4's (Boundary).
2. On `branchUpdated`, read the new head SHA and write the **landing marker**,
   then return `updating_branch`.
3. On `inFlightTaskId` (a live retry task), return `needs_fix(conflict)`
   naming the task — never a silent return. The alert rules in §H decide
   whether that deserves a page (a task sitting unclaimed past the bound does).
4. On `exhausted`, `superseded`, `dependencyBot`, `baseRewritten` → the existing
   escalations, mapped to `needs_human`.

**The marker.** Stored on the PR's owning worker task, in `tasks.context`,
next to the keys conflict/CI retry already keep there — no schema change:

```jsonc
"landing": {
  "prNumber": 123,
  "pendingHeadSha": "abc…",   // the SHA whose green lands this PR
  "baseShaAtUpdate": "def…",  // base tip the update merged in
  "refreshCount": 1,          // refreshes since the last human-visible event
  "firstApprovedGreenAt": "…",// clock for the 30-minute bound and the metric
  "lastOutcome": "updating_branch",
  "pagedKeys": ["…"]          // alert dedupe, see §H
}
```

Written with the atomic `jsonb_set … WHERE` pattern (no transactions on
neon-http). `handleCheckSuiteEvent` on success for `pendingHeadSha` calls
`landPr` (it already calls a merge on every green; the change is only that a
green for a SHA **other** than the live head is a no-op). Why task context and
not a column: the owning task is already resolved on every door (the worker →
task lookup exists everywhere a PR is mapped), the sweeper's query can use an
expression index on `(context->'landing'->>'pendingHeadSha')` only if it needs
one (it does not at current volume — it enumerates open mapped PRs), and a
column would force a migration for a field with at most one live value per
PR. If a later need (cross-workspace listing, a dashboard filter) makes the
JSON path hot, promote it to a column then, using the `schema-change` skill.

### D. Treadmill control

**Decision: bounded tolerance after a refresh, plus a refresh cap.** A green
on `pendingHeadSha` is accepted when *all* of:

- the head was produced by a refresh in this landing cycle (the marker
  exists and matches), so the green was measured on a base at most one CI
  duration old; and
- the base has moved by at most **N = 3** commits since `baseShaAtUpdate`; and
- none of those base commits touch any file the PR touches (path
  intersection from the compare API, both sides already fetched); and
- neither side touches migrations (`packages/core/drizzle/**`,
  `packages/core/db/schema.ts`) or a lockfile — those collide on index or
  resolution without a textual conflict.

Otherwise refresh again, up to **R = 3** refreshes per landing cycle; the
fourth loss of the race is `needs_human(refresh_exhausted)` (one page: "lost
the race to dev 3 times").

**Reasoning.** CI takes a few minutes; `dev` receives a steady stream of merges
that bunch into evening bursts, where several land within half an hour. So for a single CI window the chance that `dev` moves is small on
average but real in a burst — incident A lost exactly that race with one
commit. Requiring zero movement makes landing probabilistic in a burst and
starves the slowest PR; requiring nothing brings back the stale-green merges
the freshness gate was built to stop. The bound limits staleness in *time*
(one CI run) and in *content* (no shared files, no migrations), which is the
region where the risk of a merge-result break is lowest and the post-merge
integration run on `dev` still catches the remainder. When §4's same-symbol
check lands, the "no shared files" test is replaced by "no shared symbols"
(strictly more permissive, with CBM-unknown treated as shared).

**Rejected: serialized landing / merge train** (`pr-merge-reliability.md`
M7). It is the stronger guarantee but the larger change: a per-base queue,
ordering state and head-push eviction. At current merge volume the tolerance
rule converges in one or two refreshes, and it composes with a train later —
M7 remains the upgrade if the refresh-exhaustion rate is non-trivial after
rollout. **Rejected: merge-result CI** (required up-to-date branch): on a
moving trunk it never converges and a blocked merge never retries.

### E. Approve-after-green lands immediately

The approve path calls `landPr(door: 'approve')` **once**, replacing both
`tryAutoMergeWorkerPr` calls. If checks on the live head already finished green,
it merges in that call. If the PR is behind, it refreshes once and writes the
marker — and because it evaluates the *live* head there is no second attempt
against a superseded SHA, so no spurious conflict task. Under `agent-review`, a
stored terminal `approve` on the live head (or a carried head) authorises
`merge_pr` from any caller; the tier refusal "a reviewer decides this PR" applies
only when no such verdict exists.

### F. Backstop sweeper

A missed webhook must cost latency, not the PR. Today nothing re-drives a
merge: `pr-reconcile?scope=merge-state` stamps merged/closed state and marks
conflicts, but never calls a merge. **Decision: a new Redis-gated
scope on the existing route** — `/api/cron/pr-reconcile?scope=landing&gate=due`
at `*/10`, all hours, declared in `cron-manifest.json` (not `vercel.json`,
whose crons do not fire here). The existing hourly
`pr-reconcile?scope=merge-state` tick becomes its **floor**: it runs the same
landing pass unconditionally and reseeds the due set.

- `landPr` writes `buildd:due:pr-landing` (score = when the PR next needs a
  look: `updating_branch` → now + expected CI p90 + margin; `waiting_ci` →
  now + CI p90; `needs_fix` → the fix task's expected pickup deadline) and
  clears it on `merged` / closed.
- The gated tick reads `ZCOUNT`; zero returns without touching Postgres
  (`gateOnDueQueue`, fail-open on `null`), so `*/10` costs Redis reads and no
  extra Neon wake. Due entries → `landPr(door: 'sweeper')` for each, capped per
  run.
- The floor enumerates open buildd-mapped PRs that are approved (stored verdict)
  and have a green head, and runs `landPr` on each: idempotent because
  `landPr` reads live state and merges with `expected_head_sha`.

Why not a separate ~10–15 min route: an ungated sub-hourly DB tick keeps
Neon's compute awake all day, the cost every comment in `cron-manifest.json`
warns about. Why not just ride the hourly tick: worst-case detection of a lost
event is then about an hour plus CI, which cannot meet a 30-minute target.
The gated tick meets it and costs nothing when idle. This sweeper subsumes the
"approved-but-stale" clause of `pr-merge-reliability.md` M3 for approved PRs;
M3's conflict/red-CI clauses for unapproved PRs are unchanged.

### G. Doors

| Door | Today | After |
|---|---|---|
| check_suite webhook, agent-review tier | carry-forward → stored-verdict check → `tryAutoMergeWorkerPr` | `landPr(door:'check_suite')`; a green for a non-live SHA is a no-op |
| check_suite webhook, auto-threshold tier | `tryAutoMergeWorkerPr` (no carry-forward) | same `landPr` call |
| Reviewer approve path (`workers/[id]/route.ts`) | two `tryAutoMergeWorkerPr` attempts — bounded, then (agent-review, self-mergeable confidence) unbounded — both on the reviewed SHA; the second only logs on failure | **one** `landPr(door:'approve', bound)` call on the live head. The `approve-only` gate condition still stops before it. |
| reviewer-gate (`reviewer-gate.ts`) | pure predicate (`resolveReviewerGate`): decides whether the next move is human, agent or platform, using the verdict gate without carry-forward; does not merge | stays a predicate, but reads the carried head (`equivalentHeadShas`) and `context.landing.lastOutcome`, so "platform will merge" is shown only when a marker or live landing owns the PR, and a carried approval is not shown as stale |
| `merge_pr` (`PUT /api/github/pr`) | tier check (stored approve over threshold may self-merge), verdict gate with carry-forward hint, safety rails; when behind, updates the branch and returns 409 "wait for CI, then call merge_pr again" | `landPr(door:'merge_pr', actor: agent)`; behind → `updating_branch` with a marker, so the PR lands on the green without a second call. Admin `force` stays outside `landPr`, unchanged. |
| Dashboard merge (`POST /api/prs/[prNumber]/merge`) | session auth; mission-PR gate and verdict gate (with carry-forward); `override` bypasses only the verdict; **no CI or freshness check** of its own — relies on GitHub and the pinned head | `landPr(door:'dashboard', actor: human)` — now runs CI and freshness too |
| Sweeper (new) | — | `landPr(door:'sweeper')` |

**Human override on the dashboard.** A person may override: a blocking or
missing verdict (recorded as a `review_verdict` bypass, as today), the size
cap, and the freshness/treadmill bound (merge on an old green, recorded as a
`merge_base_freshness` bypass). A person may **not** override red required CI
or a deny path through `landPr`; those return `needs_fix` / `needs_human` with
the reason, and the dashboard shows it. That is a behaviour change for the
dashboard route (it now refuses red CI), and it is intended: the guardrail is
"never merge past red CI", with no door exempt.

### H. Alerting

**When to page.** Exactly one Pushover per
`(workspaceId, prNumber, headSha, reason)` when `landPr` returns:

- `needs_human` for any cause except `human_tier` (a human-tier PR is already in
  the human's queue; paging for it is noise); or
- `needs_fix` whose fix task has not been claimed, or has not pushed, within
  the bound (checked by the sweeper, not at dispatch time — a fix that is
  progressing is not paged); or
- the invariant clock: approved + green for more than 45 minutes and still
  not merged, whatever the outcome says (this is the alarm on the alarm).

**Never** page for `updating_branch` or `waiting_ci` inside budget, or for a
PR with a live worker making commits.

**Dedupe.** The same atomic CAS pattern `escalateConflictExhaustion` uses:
append the key to `context.landing.pagedKeys` with `UPDATE … WHERE NOT
(context->'landing'->'pagedKeys' ? key) RETURNING`; only the row that wins
sends. A new head SHA is a new key (new code, new situation); the same head
losing the same way twice is not.

**Channel.** The team's own channel through `notifyTeamOf(subject,
'needsAttention', payload)` in `notify.ts` — the same call
`escalateConflictExhaustion` makes — so it respects team preferences and the
team's Pushover key. `pushover.ts`'s `notifyOperator` is for platform health
and is not used here.

**Copy** (priority 0; priority 1 only for the 45-minute invariant alarm):

```
Title:   PR #<n> won't land: <plain reason>
Message: <PR title>
         Approved <age> ago · checks green · stuck <duration>.
         <one-line specific cause>
Button:  <fix verb>   → signed action URL (below)
```

Examples of the cause line: "CI `build` red on the new head: <failing test>";
"Conflicts in a.ts, b.ts"; "Lost the race to dev 3 times"; "Reviewer approval
is on an older commit and a re-review was not picked up in 30 min"; "Fix task
queued 40 min, no runner took it". Fix verbs: *Dispatch CI fix*,
*Resolve conflicts*, *Re-review*, *Retry landing*, *Merge anyway* (only when
policy allows a human override for this cause).

**Tap flow — decision: a signed one-time action URL with a confirm screen.**
The URL is `https://buildd.dev/app/prs/<n>/act?t=<token>` where `token` is an
HMAC-signed payload `{ workspaceId, prNumber, headSha, action, reason, exp, nonce }`.

- **Auth.** The token only selects the action; the page still requires a
  signed-in session belonging to the workspace's team. A token alone never
  acts, so a forwarded or leaked notification cannot merge anything.
- **Confirm.** The page shows the PR, the cause, the proposed action and the
  live head. One tap confirms. If the live head differs from `headSha` the
  page says so and re-runs `landPr` instead of acting on stale advice.
- **Expiry.** 24 hours. Expired → the page falls back to the PR's current
  state with the normal actions.
- **Replay.** The nonce is consumed atomically on first confirm (stored in
  `context.landing.actions`, next to `pagedKeys`, as `claimed` then `done` with
  the result; a failed action releases it so the person can tap again); a
  second confirm shows "already done" with the result. `reason` in the token
  decides which options the confirm screen offers.
- **Signing.** Reuse the HMAC + TTL pattern of `signInstallState` /
  `readInstallState` (`github-install-state.ts`) in a small
  `landing-action-token.ts`; no new secret material.
- **Action.** Fix actions go through
  `POST /api/prs/[prNumber]/apply-recommendation`, which today dispatches one
  fix task on the PR branch (session auth, dedupe per PR head, its own
  iteration cap) but only when an open `reviewer_escalated` note exists. It is
  widened to accept a verified landing page key as the alternative
  precondition, and a `fix` kind (`ci_fix`, `conflict`, `re_review`) that picks
  the existing dispatcher (CI retry, `dispatchConflictRetry`,
  `request_pr_review`). *Retry landing* calls `landPr(door:'dashboard')`;
  *Merge anyway* is the dashboard merge route with `override`, now itself
  behind `landPr` — so it still cannot pass red CI. No parallel route.

Rejected: linking straight to the PR page. It costs the person a diagnosis
("what's wrong, which button") on a phone, which is exactly the step the page
exists to remove.

### I. Boundary with conflict-aware orchestration §4

`docs/design/conflict-aware-orchestration.md` §4 ("Deterministic base
refresh and semantic escalation") lives on that mission's branch and has
**not** reached `dev`. It owns:

- update-branch **failure classification**: changed head → re-read;
  transient/auth/rate-limit/unknown → bounded retry or defer; verified textual
  conflict → the conflict agent. ("An API error alone is not conflict
  evidence" — incident A is exactly the failure this prevents.)
- refresh **dedupe and single-flight** (by PR/head/base, one mutation in
  flight);
- the CBM **same-symbol** semantic check before a clean refresh;
- the refresh **attempt cap** for operational failures.

This spec owns: the decide-and-act landing function, carry-forward on every
door, the treadmill bound, the landing marker, the sweeper and the alerting.

`landPr` **calls** the existing refresh primitive (`dispatchConflictRetry`
with `behindOnly`, i.e. `updateBehindPrBranch`) and consumes its result; it
does not re-implement §4's classification. Until §4 lands, the one piece of
incident A that is §4's — an update-branch refused for a changed head being
misread as a conflict — is avoided here only by construction (`landPr` always
passes the live head, and the approve path makes one call), not by
classification. This work stays **outside** that mission: a fix merged into a
mission integration branch does not reach `main` until the mission does.

### J. Test plan

All unit tests use the isolated runner (`bun run scripts/run-unit-tests.ts
<file>`).

**Unit — truth table** (`apps/web/src/lib/pr-landing.test.ts`), one row per
combination of:

| Axis | Values |
|---|---|
| verdict | none, in_flight, approved (live head), approved (carried), approved (not equivalent), changes_requested, escalated |
| CI on live head | pending, green, red required, red non-required |
| behind count | 0, 1..N disjoint, 1..N overlapping, >N, migration touched |
| `mergeable_state` | clean, unknown, dirty, blocked |
| refresh / fix count | 0, below cap, at cap |
| tier | auto-threshold, agent-review, human |

Assertions: every row yields one `LandingOutcome`; every non-`merged` outcome
names an owner (marker, task id, or page key); no row merges with red required
CI or a deny path; no row carries a non-equivalent approval; each non-`merged`
return writes exactly one gate event.

**Replays** (fixtures reconstructed from the incidents, no production ids):

1. Approved early, then fell behind → refresh, marker, green on marker SHA merges.
2. Approve-after-green → merges inside the approve call.
3. Approved but refused on tier (agent-review, `merge_pr` by an agent) →
   stored approve authorises the merge.
4. Unrelated-flake red CI → `needs_fix(ci_fix)`; never merged; one page only
   if the CI-retry budget is exhausted.
5. Approval followed in the same minute by a base-merge push, then green
   (incident A) → carried approval, one refresh, **no** conflict task, merged.
6. Approval, then a conflict resolution that changes the diff, then green
   (incident B) → `needs_fix(re_review)`, a re-review is dispatched once.

**Webhook** (`webhook/route.test.ts`): green on the marker SHA merges; green on a
stale SHA does nothing (no gate event, no refresh).

**Approve path** (`workers/[id]/route.test.ts`): approving a PR that is behind
`dev` updates the branch **once** and files **no** conflict-fix task.

**Sweeper** (`cron/pr-reconcile/route.test.ts`): two consecutive runs over the
same state → one merge call, one page at most; a gated tick with an empty due
set issues no DB query; `countDue` `null` falls through to the query.

**Alert**: one Pushover per key under concurrent callers; a new head SHA is a
new key; the signed URL rejects a replayed nonce, an expired token, a token for
another workspace, and a live head that moved (re-evaluates instead).

**Metric**: record `landing.firstApprovedGreenAt` → merge time as a
`time_to_land` gate-ledger detail on the `merged` event, and expose p50/p90
through `get_failure_analytics family=gate` so a regression is visible
without a new panel.

### K. Rollout and rollback

Flag `gitConfig.landing.mode`: `off` (default — today's code paths, unchanged)
→ `shadow` → `enforce`.

1. **Shadow.** Every door runs its current logic *and* `landPr(mode:'shadow')`,
   which evaluates everything, writes the gate event with
   `detail.shadowOutcome`, and performs no merge, refresh, dispatch or page.
   Compare shadow outcomes with what actually happened for a week: every PR
   a human hand-merged should show a shadow `merged`, `updating_branch` or
   page; no shadow `merged` should have red CI.
2. **Enforce** per workspace. Doors switch to `landPr` only; the sweeper tick
   is enabled in `cron-manifest.json` in the same change (it no-ops for
   workspaces not in `enforce`).
3. **Rollback.** Set the mode back to `shadow` or `off`; doors fall back to the
   retained paths. Markers in `tasks.context.landing` are inert when the mode
   is not `enforce`; nothing to migrate back. The due-set in Redis is derived
   and can be dropped.

The retained paths are removed one release after `enforce` has been the
default with no rollback.

### Safety properties

- Refreshes: at most R per landing cycle per PR; conflict agent retries keep
  `DEFAULT_MAX_CONFLICT_ITERATIONS`; re-reviews keep the reviewer retry budget.
- Pages: at most one per `(workspace, PR, head, reason)`.
- Merges: always `expected_head_sha`-pinned; never past red required CI or a
  deny path; never on an approval that is not about this code.
- Sweeper: capped PRs per run; idempotent by live read.

## Implementation sketch

Load-bearing piece first:

1. `pr-landing.ts` with the truth table, shadow mode and gate events; no door
   wired. (Tests: truth table, replays 1–6.)
2. Marker read/write helpers and the check_suite wiring (both tiers).
3. Approve path → one `landPr` call (the approve-path test); reviewer-gate
   predicate reads the carried head and the marker.
4. `merge_pr` and the dashboard route → `landPr` (red-CI refusal on the dashboard).
5. Sweeper scope + due-set writes + `cron-manifest.json` entry.
6. Alerting: dedupe CAS, Pushover copy, signed action page, `apply-recommendation`
   additions.
7. Flip buildd's own workspace to `shadow`, then `enforce`.

## Open questions

- **N and R.** Leaning N = 3, R = 3 from current volume; shadow mode will
  show the real refresh-count distribution before enforce. If the p90 is
  above 1, prefer building M7's train over raising N.
- **Page for `needs_fix` at all?** Leaning yes but only past the bound (a
  fix nobody picked up is the operator's problem too). The alternative — page
  only on `needs_human` — would have missed incident A, whose fix task was
  never claimed.
- **Dashboard override of the treadmill bound.** Leaning allow (a person
  looking at a green PR one commit behind is the judgement the bound
  approximates), recorded as a bypass. Red CI stays non-overridable.

## Non-goals

- Changing what the reviewer checks, the confidence threshold, or any tier's
  policy. Carry-forward stays diff-equivalence only.
- Update-branch failure classification, refresh single-flight and semantic
  (CBM) checks — §4 of conflict-aware orchestration.
- Unapproved PRs with conflicts or red CI (`pr-merge-reliability.md` M3).
- Release PRs (`handleReleasePrCiSuccess`) and dependency-bot PRs, which keep
  their own paths.
- A GitHub-side merge queue or required up-to-date branches.
