# Plan — Mission Delivery Arc, rewrite around A′ (integration branch, per-task PRs)

**Status:** §6 done — `docs/design/mission-delivery-arc.md` has been rewritten
around **A′** (2026-09-04). The design doc is now the readable artifact; this
plan remains only as the audit record behind it. §3 (prerequisites) and §5
(fix-regardless bugs) are **not started** and are tracked in that doc's
Implementation sketch as Track 2 and Track 1.
**Next action:** Track 1 item 1 — fix §5.1 / finding B10 (mission tasks falling
back to the shared main clone), with a failing test first. Everything else
builds on `context.headBranch`.
**Resolved since writing:** the CI-trigger question (§2.3, §8) is answered — see
the note below. It does *not* change the A′ recommendation.
**Audit date:** 2026-09-04, against `dev` at `d3d0221c`. §3.9 was added later
the same day from a separate live-fleet measurement of the codebase-memory
cache, against `dev` at `fe18cbd8` — it is the one section not produced by the
five-agent audit, and it is owned by this arc rather than filed as an open
question.

> Nothing in this plan has been implemented. No code was changed during the
> audit. Every `path:line` below was read, not remembered — but line numbers
> drift, so re-confirm before editing.

---

## 0. The question that was being answered

Does buildd release *missions*, or does it release *whatever is on `dev`*? The
arc — idea → decomposition → execution → review → verification → release — is
six independently-correct mechanisms with no shared state and no surface that
shows the whole trip. Three options were on the table:

- **Option A** — mission is the release unit. All tasks of a mission share one
  integration branch and produce **one PR**; no per-task PRs. This is what
  `docs/SPEC.md:79` and `docs/specs/mission-task-lifecycle.md:264` already
  claim happens.
- **Option B** — mission is an attribution set. Per-task PRs into `dev` stay;
  "released" means every PR of the mission is contained in a `healthy` release.
  Requires a `partially_shipped` state.
- **Option A′** — *the recommendation.* Per-task branches and per-task PRs are
  kept, but they **target the mission integration branch instead of `dev`**.
  The mission branch then opens **one** PR into `dev`. Standard stacked
  integration-branch workflow.

**Decision: A′.** A is unbuildable on today's machinery (§1). B works but
requires the UI to learn a half-shipped state that A′ makes structurally
impossible.

---

## 1. Why Option A is dead (do not revisit without reading this)

### 1.1 Three deadlocks, all intra-mission

Scoping A to "finite missions only" dodges none of these — they are all inside
one mission.

| Deadlock | Mechanism | Why it never clears |
|---|---|---|
| **Dep gate** | `apps/web/src/app/api/workers/claim/deps-gate.ts:39-60` — a dep is satisfied only when `status ∈ {completed,cancelled}` AND no worker on it holds `pr_url NOT NULL AND merged_at NULL` | The mission PR is open for the mission's whole life. Task A completes → A's worker holds the mission PR → task B (`dependsOn: [A]`) is withheld → mission never finishes → PR never merges. Every mission with one DAG edge stalls. |
| **`all_prs_merged`** | `packages/core/mission-helpers.ts:253-289` — filters workers by `prUrl`, fails on any unmerged one, and **never inspects base ref** (`branchName` is passed at `mission-criteria-eval.ts:253` and never read) | Reads `fail` → `criteria_failed` → no completion → no merge. Closed loop, no timeout. |
| **`path_overlap`** | `claim/route.ts:1273-1280` via `findBlockingPr` / `packages/core/path-overlap.ts:144-169` — defers a task whose manifest overlaps a task holding an open PR | Every mission worker carries the same open PR, so overlapping siblings defer each other forever. This is a **soft** deferral the spec requires to self-clear (`docs/specs/mission-task-lifecycle.md:157-160`, rule CG-6) — so it becomes an invisible permanent stall that violates its own contract. |

You cannot escape the dep gate by suppressing per-task PRs:
`apps/web/src/app/api/workers/[id]/route.ts:466-497` queries GitHub at
completion for open PRs matching the worker's branch and stamps the first one
onto the worker. On a shared branch that is the mission PR. And if the mission
PR does not exist yet, `pr_required` hard-400s the completion (`:499-505`) —
`apps/web/src/lib/default-roles.ts:118` sets `pr_required` on generated builder
steps, so this is the common path, not an edge.

Two more variants of the `all_prs_merged` problem, worth writing into the doc:
- If **no worker owns** the mission PR, `deliverableWorkers` is empty →
  `UNVERIFIED` → `criteria_unverified` (`mission-completion.ts:319-324`). Same
  standstill, softer code, and it means **every finite mission sits permanently
  at `AWAITING VERIFICATION`** (`mission-helpers.ts:159,172-173`).
- If sub-PRs **do** merge into the mission branch, the criterion **passes with
  zero lines on `dev`**. A false green is worse than a stall. This case is
  reachable under A′ too — see §3.1.

### 1.2 The runner destroys work on disk

- `apps/runner/src/git-operations.ts:149-150` keys the worktree **directory** by
  sanitized branch name, so two mission tasks compute the identical path.
- `:174-183` then `git worktree remove --force`s whatever is there. Verified:
  this returns **exit 0 on a worktree with uncommitted changes**. There is no
  liveness check, and the agent session is fire-and-forget
  (`apps/runner/src/workers.ts:1417`, not awaited).
- `:276` `git branch -D` then succeeds because the holding worktree is gone —
  the sibling's unpushed commits are deleted. The destroying side logs it as
  *"Cleaning up stale worktree at …"*.
- If the removal fails instead: `:289` `git worktree add -b` fails with
  `fatal: a branch named 'X' already exists` → `setupWorktree` returns null →
  `workers.ts:1434-1436` falls back to the **shared main clone**. Two agents
  editing one working tree with `git add -A`.
- **The runner never pushes.** Pushing is prompted in prose
  (`apps/runner/src/prompt-builder.ts:208-209`,
  `.claude/skills/buildd-workflow/SKILL.md:142`). No retry, no `pull --rebase`,
  no lock, and no deny rule on `push --force` anywhere. One confused agent's
  force-push erases every sibling's mission work.
- Serializing does **not** fix it: `setupWorktree` always creates the branch
  fresh from base with `-b`, so task N+1 does not start from task N's work
  unless the mission branch arrives as `resumeBranch` — and a healthy multi-day
  mission branch crosses the `count > 50` divergence heuristic
  (`git-operations.ts:240`), is classified `diverged`, and silently falls back
  to `origin/dev` (`worktree-utils.ts:60-69`) while the worktree is still
  *named* `mission/x`.
- `worktree-utils.ts:178-181` `isBuilddTaskBranch` matches only `buildd/` and
  `--e2e-test-`, so `mission/*` worktrees leak forever; and `classifyOwner`
  (`:264-267`) keys on path/branch, both non-unique under A, so a live worktree
  can be classified terminal and swept (`doctor.ts:242-258`).

Escape hatch that was verified to work, if A is ever revived:
`git worktree add --detach <path> origin/<branch>` succeeds in **two**
simultaneous worktrees of one clone, and `git push origin HEAD:refs/heads/<branch>`
works from a detached worktree. That inverts the current design, which tells the
agent it is "on" a branch.

### 1.3 "One PR, N workers" breaks the merge machinery's cardinality

Every PR→worker lookup in the merge path is a `findFirst`:
`apps/web/src/app/api/github/webhook/route.ts:343, 370, 405, 506, 625, 880, 1267`
(11 `workerOwnsPr` + `findFirst` sites in that file), plus
`apps/web/src/app/api/prs/[prNumber]/merge/route.ts:60-104,233-237`, which
deliberately fetches all matching workers and then takes `matchingWorkers[0]`.

On merge, only **one** worker gets `mergedAt` stamped (`webhook:624-636`) and
one task auto-completes (`:702-707`). N−1 mission workers keep `mergedAt = NULL`
forever, which strands everything gated behind that single lookup:
`releaseAndNotify` path-claim release (`:653`), `closeIntentsForPr` (`:659`),
`sweepSubjectAnchoredTasks` (`:665`), `shutdownDeadBuilddPrs` (`:673`),
`checkDependsOnResolved` (`:770`), `evaluateAndAdvanceLoopOnMerge` (`:777`),
work-tracker Done, and the release trigger (`:722-800`). The `merged_at` heal
tiers repair the column but never re-fire these effects. **Stranded
`path_claims` then block unrelated future work** via `claim/route.ts:1284-1310`.

**PR-keyed dedupe indexes become cross-task mutexes.** `hasActiveReviewerFixTask`
(`auto-merge.ts:422-434`) is `eq(tasks.reviewerRetryPrNumber, prNumber)` with no
`taskId`. The conflict-retry unique index is `(workspaceId, prNumber, headSha)`
(`packages/core/db/schema.ts:918`), and CI-retry dedupes the same way
(`webhook:956-1017`). Under A, a legitimate fix task for task B is **silently
suppressed** because task A already has one open on the shared PR.

### 1.4 Premature auto-merge — the first failure a user would see

With the default `auto-threshold` tier, `check_suite` success on the mission PR
runs the existing per-worker path: it picks **one arbitrary worker**
(`webhook:402-407`), resolves policy from *that* worker's task (`:433-441`), and
squash-merges (`auto-merge.ts:224`). So **the first task's green CI merges the
partial mission into `dev`.** Conversely, once you *want* it merged it won't:
`DEFAULT_MERGE_POLICY` is `maxLines: 800` (`merge-policy.ts:26-29`) and
`evaluateAutoMergeSafety` rejects on aggregate source lines
(`auto-merge.ts:121-131`), which a mission-sized diff always exceeds.

`applyPolicyConfigToMergePolicy` (`workspace-policy.ts:443-487`) also only ever
ratchets *more* restrictive, and the mission PR's file list is the union of every
task's files — so any risk-classed path anywhere in the mission escalates the
whole thing to `human`. **The tier system collapses to one tier.**

And the reviewer never re-runs: `agent-review` dispatches once on
`pull_request.opened` (`webhook:547-559` → `maybeDispatchReviewer:1110-1248`),
so it reviews whatever the first task produced. `synchronize` only stamps
`prLifecycleStatus` (`:500-544`).

### 1.5 The UI cost: ~22–26 files, ~14 with real logic changes

Worst three, with the wrong number each would render:

1. **Mission detail + review summary + timeline.** `awaitingMerge`
   (`missions/[id]/page.tsx:264-269`) counts completed tasks whose latest worker
   has an open PR → 0. Header reads **"14 of 14 tasks complete"** (`:734-741`)
   while the mission PR is unmerged; the merge-policy chip is gated on
   `awaitingMerge > 0` and **vanishes exactly when a human gate is pending**
   (`:706-718`); `MissionReviewSummary.tsx:22-28` partitions on `t.prUrl` and
   prints **"14 tasks completed (no PR)"** with an empty body; and
   `lib/condensed-timeline.ts:57-67` requires `latest.prUrl` for
   `isWaitingOnYou`, so the **"Waiting on you" band renders 0 rows**.
2. **Initiative verdict ladder breaks in both directions from one cause.**
   `awaitingVerification` (`initiative-pulse.ts:232-238`) and `blocked`
   (`:240` ← `countBlockedByPR:279-297`) both go to **0**, so `stuck` becomes
   unreachable and six finished missions parked on unmerged branches read
   **`Dormant`** (`:371`) — which per spec AC-1 contributes no clause, so Home
   renders **no pulse line at all**. Simultaneously `merges7d` (`:489-498`)
   collapses from ~14 to 1 per mission while `attempts7d` still counts every
   task, firing **`Losing`** on an arc that shipped everything (`:356`) and
   `Grinding` on healthy ones (`:364`).
3. **Release queue depth.** `missions/page.tsx:189-201`,
   `home/page.tsx:763-782` → `ReleaseWidget.tsx:67`,
   `MissionReleaseFooter.tsx:43` count workers with `mergedAt` newer than the
   last healthy release. A release of 3 missions × 12 tasks displays
   **"3 unshipped"** instead of 36, with `oldestMergedAt` reporting the
   mission-merge date rather than when the work landed.

**No existing column discriminates the two shapes.** `workingBranch` is set
lazily for *any* mission whose workspace has a repo, monitoring missions
included (`mission-run.ts:201-220`); `primaryPrUrl` is stamped from the first
task PR under any mission (`github/pr/route.ts:892-902`). A would need a new
explicit column (`reviewUnit: 'task' | 'mission'`). A′ needs none.

---

## 2. Option A′ — the recommendation

**Definition.** Each task keeps its own branch and its own PR, exactly as today.
The only change: a mission task's PR **base is the mission integration branch**,
not `dev`. When the mission's work is done, the integration branch opens one PR
into `dev`. That mission PR is the single human gate; the normal dev→main
release promotes it.

**Merge policy placement is the load-bearing half of A′:** the tier applies to
the **mission PR**, not the task PRs. Task PRs into a quarantined integration
branch run `auto-threshold` and land unattended; `human` / `agent-review`
applies once, at the mission PR. This is what delivers the batching win (§2.2).

### 2.1 Every §1 blocker, mapped

| §1 blocker | Under A′ |
|---|---|
| Dep gate deadlock | **Gone.** Task PRs merge into the mission branch in minutes; `mergedAt` lands; dependents unblock. No exemption predicate needed. |
| `path_overlap` never self-clears | **Gone.** Task PRs close, so the deferral clears as designed. |
| Runner worktree collision / push contention / divergence fallback | **Not touched.** One branch per task, as today. |
| 11 `findFirst`-by-PR sites, `matchingWorkers[0]`, stranded `path_claims` | **Not touched.** One worker per PR everywhere. |
| PR-keyed dedupe indexes as cross-task mutexes | **Not touched.** Distinct PR numbers per task. |
| Premature auto-merge of partial work into `dev` | **Becomes correct.** Auto-merge merges task PRs into the mission branch, which is precisely where partial work should accumulate. The 800-line threshold applies per task — the right granularity. |
| Reviewer dispatches once on the wrong diff | **Fixed by placement.** Per-task reviewer keeps working on task PRs; the mission PR gets the one human/agent gate. |
| Tier system collapses to one tier | **Gone.** Per-task risk classes still evaluate per task. |
| ~14 UI logic sites | **Mostly untouched.** They read per-task PR state, which still exists: `merges7d`, `awaitingVerification`, `EffortDay.merged`, `isGateSatisfied`, the `half` segment state, the verdict ladder. |
| Two-shapes discriminator column | **Not needed.** |
| `partially_shipped` (Option B's cost) | **Structurally impossible.** One mission, one diff, one merge. |

### 2.2 What A′ buys (state these as the argument, not as decoration)

- **One human decision per mission instead of N.** Today a 14-task mission
  produces 14 MERGE cards (`action-queue.ts:135`, one `subjectKey` per `prUrl`)
  and `home/page.tsx:1013` caps the escalation inbox at `.slice(0, 10)` — so a
  14-PR mission is **structurally unreviewable from Home today; four are
  silently dropped.**
- **The fleet stops stalling on a person.** `isGateSatisfied`
  (`task-presentation.ts:247-264`) blocks the next task until a human merges the
  previous one. Under A′ + per-task `auto-threshold` into the integration
  branch, intra-mission dependents unblock without human action.
- **Five artifacts stop lying** (§4).
- **A mission diff, one review, one revert** — the thing that does not exist
  today in any form.
- **Release attribution can stop being a heuristic**: one mission PR
  number/sha → join on `tasks.missionId`. `release_tasks` already accepts
  nullable `prNumber`/`commitSha` (`schema.ts:2424-2431`) and `releases.unit`
  (`:2390`) is an unused column that reads like it was reserved for `'mission'`.

### 2.3 Costs to state honestly

- N+1 PRs instead of N. More GitHub noise.
- CI runs at two levels (task PRs against the integration branch, plus the
  mission PR against `dev`). **Resolved 2026-09-04:** `build.yml:3-6` triggers
  `push: [dev]` and `pull_request: [main, dev]`, so task PRs based on `mission/*`
  get **no** `pull_request` run today — and because `ci-fix.yml` triggers on
  `workflow_run` of "Build & Test", the CI-retry agent chain goes silent with it.
  The fix is a one-line widening (`'mission/**'` added to
  `pull_request.branches`), so this is a prerequisite, not a blocker, and it does
  not change the recommendation. `build.yml` has no top-level `concurrency:`
  group, so overlapping runs pile up uncancelled — add one in the same change.
  (`preview-tests.yml` no longer exists; `CLAUDE.md:64` and
  `docs/testing-strategy.md:150` still reference it. Integration tests now run
  inside `build.yml`.) Residual real cost: roughly double the CI minutes on
  mission work.
- The integration branch still diverges from `dev` over a long mission, so it
  needs `dev` merged in on a cadence — nothing does that today (§3.5).
- `workers.mergedAt` now means "landed on the integration branch", not "landed
  on `dev`". Release-queue counting needs to know the difference (§3.4).
- **The codebase graph's cache key stops matching the base.** The shared
  codebase-memory seed is keyed by base-clone path alone and can only be indexed
  at the default branch, so under A′ every mission task is served a `dev`-based
  graph *with indexing skipped*. This is a prerequisite rather than a cost — see
  §3.9 — and it is owned by this arc.

---

## 3. A′ prerequisites — the actual work

Each is independently shippable and defaults to current behaviour.

**3.1 `all_prs_merged` must become base-ref-aware.** `mission-helpers.ts:253-289`
never reads base ref, so once every task PR merges into the integration branch
the criterion **passes with nothing on `dev`**. This is A′'s one inherited
false-green and it must be closed in the same change that repoints task PR
bases. The criterion should require: all task PRs merged into the integration
branch **and** the mission PR merged into `dev`. Related dead code to fix or
drop: `requireBranchDeleted` (`:269-282`) is permanently `UNVERIFIED` because
nothing populates `branchDeleted` (`mission-criteria-eval.ts:249-254` maps only
four fields) — and "the mission branch is gone" is exactly the check A′ wants.

**3.2 `persistMissionPrIfFirst` must claim only the mission PR.**
`github/pr/route.ts:893-903` claims `primaryPrNumber` for whichever PR arrives
first under `isNull(primaryPrNumber)`. Under A′ the first *task* PR would steal
the slot. Gate it on base ref = `dev` (or on an explicit `isMissionPr` flag).

**3.3 `runMission` must stop halting planning on an open primary PR.**
`mission-run.ts:182-197` returns `skippedPrOpen` and notifies *"Planning paused
until it merges"* while `primaryPrNumber` is open; `mission-loop.ts:264-289`
(`maybeRetriggerMission`) does the same. Under any mission-PR model that PR is
open for the mission's whole life, so **the organizer stops decomposing**. The
guard should key off "an open PR whose paths overlap the next planned task",
which the path-claim machinery can already answer.

**3.4 One new UI signal: mission integration PR open.** Exactly one MERGE card
and one chip. Everything else on the dashboard keeps working. Specifically:
- Mission detail needs the mission PR represented — `awaitingMerge` counts task
  PRs and will correctly read 0 once they all merge, so without this the header
  still reads "N of N tasks complete" with nothing on `dev`.
- The escalation inbox (`home/page.tsx:793-802`) requires
  `isNotNull(workers.prUrl)`, so **the mission PR must be owned by a worker row**
  or it produces no card at all. `/api/prs/[prNumber]/merge` is also
  worker-keyed (`route.ts:57-64`), so `MergeConfirmButton.tsx:42` and
  `WaitingOnYouMergeCard.tsx:60` would 404. **This single implementation choice
  decides whether the review flow works or silently doesn't.**
- `unblockCount` is only set by the merge-item path (`action-queue.ts:171,185`),
  which requires an upstream task PR with a blocked dependent. Under A′ that
  path survives for intra-mission task PRs, but the mission card needs its own
  count (mission task count, not currently loaded by the queue).
- Release-queue depth must distinguish "merged into an integration branch" from
  "merged into `dev`", or it will count mission work twice.

**3.5 Integration-branch freshness.** Nothing merges `dev` into a mission branch
today. `git-operations.ts:211-229` runs a staleness check but with
`cwd: repoPath` — the **main clone's HEAD**, not the mission branch — so it
measures the wrong tree and only `console.warn`s. Decide: periodic
`dev → mission/*` merge task, or accept that the mission PR resolves it at the
end (GitHub's `pull_request` checks test the base-merged ref, so the mission PR
itself is not fooled by a stale base).

**3.6 `command` criteria must run on the mission branch.**
`mission-criteria-verify.ts:208` selects `workingBranch` and `:253-259` never
puts it in the created verification task's context, so `bun test` runs off
`defaultBranch` and verifies code the mission has not landed. Live bug; A′ makes
it matter more.

**3.7 Rewrite the seeded planner instructions.** `default-roles.ts:107` injects
**"ONE task = ONE branch = ONE PR. Never fan out parallel tasks that touch the
same files"** into every planner prompt. Under A′ the first clause stays true
and the base changes, so the wording needs to name the integration branch —
otherwise organizers keep planning against the wrong model. `:118-119` sets
`pr_required` on builder steps, which stays correct under A′.

**3.8 `approve-plan.ts:116-142` re-derives branch names.** It predicts
`buildd/{id8}-{title}` for a dependency's `baseBranch` — a hand-mirrored copy of
`claim/route.ts:1694-1702` that omits `useBuildBranch` **and the mission
`headBranch` override, so it already predicts a nonexistent branch for every
mission task today.** Under A′ the whole stacked-`baseBranch` mechanism can
mostly go away; at minimum this must read `workers.branch` /
`missions.workingBranch` instead of re-deriving.

**3.9 The shared codebase-memory seed must become base-ref-aware.** A′ breaks
the one assumption the graph cache is built on, and simultaneously raises the
concurrency that already breaks the fallback path. Line numbers here are against
`dev` at `fe18cbd8`, later than the §0 audit commit.

*The key is repo-only, and the seeder cannot produce anything else.*
`buildCbmActivation` (`apps/runner/src/cbm-enforcement.ts:345,359-372`) resolves
a seed via `readCbmSeedRecord(ctx.repoPath)`, keyed by a hash of the **base-clone
path alone** (`:207-211`). The record carries `ref` and `sha` (`:195-197`), but
neither is part of the key and neither is compared at admission — the gate is
just `record && pathExists(<shared>/<record.project>.db)` (`:362`). Nor could a
non-default base ever be seeded: `scripts/cbm-seed.ts:36` takes only a repo path
and `:63-80` resolves the ref from `origin/HEAD`, so "the default branch" is
structural, not configurable, exactly as `cbmSeedRoot()`'s comment states
(`:169-174`). Under A′ one seed exists per repo and it is the wrong base for
every mission task — while `:368-369` returns `sharedCache: true` **and**
`skipBootstrapIndex: true`, so the worker is handed a `dev`-based graph and skips
indexing, with no signal at activation and a "project not found" style failure
only later, on the agent's turn. `spawnCbmSeedRefresh` (`:400`) is likewise
repo-path-keyed and deduped per path per process (`:398`), so nothing would ever
build the mission-branch seed. Required change: key the record and the refresh on
`(repoPath, baseRef)`. Both fields already exist; neither is read.

*The concurrency interaction, which is the load-bearing half.* The per-worker
fallback is a full index under a 60s cap (`cbm-bootstrap.ts:23`), whose own
comment justifies the budget from a measurement taken with one indexer running.
On the live fleet the timeout rate is roughly one in ten when a worker indexes
alone and climbs to about half once three or more bootstraps overlap on one
runner; the `builder` role — the code-touching cohort — fails worst of all.
§2.2's headline win is that intra-mission dependents stop waiting on a human
merge, which is by design *more tasks running at once, on one runner, against one
repo*. A twelve-task mission is exactly the shape that sits in the bad bucket.

The shared seed is the mechanism that removes per-worker indexing altogether, and
it works — where it is reachable. Measured by `bootstrapResult='skipped_warm'`,
which is set at exactly one place gated on the seed branch and is therefore an
exact proxy for admission: roughly seven in ten roleless workers run on the seed,
and **no role-scoped worker ever does** — not one, across builder, organizer,
researcher and the service roles, in the same workspace as the roleless ones. The
cause is structural rather than a defect: `getRoleDir()` is
`$HOME/.buildd/roles/<slug>` (`roles.ts:36`) and `$HOME/.buildd` is itself a git
clone (`install.sh:20`), so a role worker's `repoPath` is a *subdirectory* of a
repo, `isGitRepoRoot` returns false, and `cbm-seed.ts` declines to seed. That
refusal is correct — the guard exists because seeding a role config dir once
produced a duplicate graph of the wrong repo — but its consequence is that
`builder`, the code-touching role, always pays a full per-task index and so
carries the worst timeout rate on the fleet. Under A′ that is the cohort doing
the mission work. (Exact figures in `knowledge-base`, not here.)

Note for anyone re-deriving this: `resultMeta.cbm.sharedCache` looked like the
natural signal and is worthless before the change below — the field was computed
in a local in `startSession` and never reached the metrics payload, so it is
absent on every historical row, and absent reads the same as false.

*A staleness failure that does not exist today.* Currently a stale seed means
`dev` moved since it was indexed — generic drift, mostly harmless. Under A′ the
integration branch accumulates N−1 sibling merges, and those siblings are related
*by construction* — that is what makes them one mission. With
`skipBootstrapIndex: true`, a task's `trace_path` / `search_graph` then returns
the pre-mission answer for precisely the code its siblings just changed: a
confidently wrong graph rather than a missing one, which is the worse of the two.
Refresh incrementally (`detect_changes`) when a task PR merges into the
integration branch rather than re-indexing; that merge event already exists in
the webhook path (`webhook:624-636`).

*What A′ makes genuinely better — argue this in the doc, do not just absorb it.*
N tasks sharing one base is a strictly better cache unit than N tasks each cut
from `dev`: one index per integration-branch advance, amortised across the
mission, against one full index per task. The seed record's `project` field
already decouples the worker's worktree path from the path the graph was indexed
at, so the indirection this needs is built and proven.

**Ownership: this arc, not a hand-off.** Two separable pieces, both landing here.
The seed's non-admission is a live production defect independent of A′ and should
be fixed first, because it is also what makes today's fleet slow. The
`(repoPath, baseRef)` key and the merge-triggered incremental refresh are
A′-specific and gate the rewrite. Neither belongs in §8 — there is no open
question in them, only work.

---

## 4. Artifacts that assert Option A today and are false

Verified, both quoted verbatim:

- `docs/SPEC.md:79` — *"**`workingBranch`** + `primaryPrNumber`/`primaryPrUrl` —
  all mission tasks push to one shared branch tracked by a single PR."*
- `apps/web/src/lib/default-roles.ts:107` — *"**ONE task = ONE branch = ONE
  PR.** Never fan out parallel tasks that touch the same files."*

Also asserting it: `docs/specs/mission-task-lifecycle.md:264-267`, the
`missions.workingBranch` docstring (`schema.ts:668-672`), the planning pause
(`mission-run.ts:182-197`), and the `PR #N` label on mission cards
(`MissionGrid.tsx:787,903`).

In code, `context.headBranch` is written in **exactly one place**
(`mission-run.ts:289`, the organizer's own planning task) and read in **exactly
one place** (`claim/route.ts:1687-1693`). No other creation path — MCP
`create_task`, dashboard, schedule cron, CI/reviewer/conflict retry — sets it.
A′ is the only option that makes all five statements true at once; B makes them
true by deleting the claim.

---

## 5. Live bugs found during the audit — fix regardless of A′

Separable from the arc work. Each wants its own failing test first.

1. **Mission tasks run in the shared main clone on the default branch.**
   `worktree-utils.ts:41-48` treats `context.baseBranch` as a *resume candidate*;
   `mission-run.ts:289` sets `baseBranch` to the **default** branch. So:
   candidate `dev` → probe `rev-list --count origin/dev..origin/dev` = 0 → `ok`
   → `git-operations.ts:267-270` sets `actualBranch = 'dev'` → `:276`
   `git branch -D dev` fails (`error: cannot delete branch 'dev' used by
   worktree at …`, swallowed by the bare catch at `:277-279`) → `:289`
   `git worktree add -b dev` fails (`fatal: a branch named 'dev' already
   exists`) → `setupWorktree` returns null → `workers.ts:1434-1436` falls back
   to the main repo. Invisible today only because `headBranch` is set on one
   non-committing task type. **No test covers it** —
   `apps/runner/__tests__/unit/worktree-base-branch.test.ts` and
   `git-operations.test.ts:251` only use `buildd/...`-shaped `baseBranch` values.
   **Any work built on `context.headBranch` must fix this first.**
2. **Gated release attribution is broken.** `release-attribution.ts:61-75`
   matches only `/Merge pull request #(\d+)/`, but task PRs are squash-merged
   (`auto-merge.ts:224`, `release-executor.ts:165`) which produces
   `title (#N)`. On this repo's topology the only matching commit in a dev→main
   range is the release PR's own merge commit (`release-executor.ts:427-434`,
   `merge_method: 'merge'`), so **every release is attributed to whichever
   worker opened the release PR.** Compounding: no `releases` row is written at
   all for gated `branch_merge` workspaces (`release-executor.ts:228-233`
   early-returns unless archetype is `continuous`), so `MAX(healthy_at)` is NULL
   and the Home release widget hides by construction
   (`api/releases/readiness/route.ts:83-86`).
   `attributeByPr` also keeps a `seenPrs` set and takes the first worker per PR
   (`:144-180`), asserted by name in
   `packages/core/__tests__/release-attribution.test.ts:337`.
3. **`missions.releasedAt` is claimed before the release happens.**
   `mission-release.ts:86` (and `webhook:757`) take the one-shot claim before
   strategy resolution and before `executeRelease`. Nothing in the codebase ever
   resets it — the only writers set it. Failures are `console.log`
   (`mission-release.ts:79-83,122-124,131-136`). Fix: two-phase
   (`releaseAttemptedAt` claimed, `releasedAt` written only on success) plus a
   `missionNotes` row on every decision.
4. **Mission release is a guaranteed no-op on this repo's topology.**
   `release-executor.ts:362-375`: with `releaseBranch` set, any task whose
   `release` flag is `'inherit'` returns `skipped`. `isMissionRelease: true`
   bypasses only the trigger-policy block (`:305-314`), not this gate. So the
   mission release skips — after bug 3 has burned the claim. Under A′, mission
   completion should fire **integration** (mission PR → `dev`), and release stays
   a separate multi-mission dev→main event — which means
   `trigger: 'on_mission_complete'` (`schema.ts:324-328`) is the wrong hook in
   the wrong place.
5. **Release trigger UI shows a default the server does not use.**
   `workspaces/[id]/config/ReleaseSection.tsx:95` defaults to
   `on_mission_complete`; all three server readers default to `every_merge`
   (`mission-release.ts:54`, `release-executor.ts:306`, `webhook:745`).
6. **`/app/tasks` shows two numbers that disagree.** `TaskGrid.tsx:121-122`
   passes `prUrl`/`prNumber` to `TaskCard` but omits `prLifecycleStatus`
   (declared `:27`, consumed `TaskCard.tsx:59`), so a merged task renders chip
   `OPEN #1234` while the histogram at `:217-219` counts it `DONE`.
7. **Mission `gateCondition: 'merged'` clears on the *first* task PR merge**
   (`webhook:714`, `prs/[prNumber]/merge/route.ts:254`) while the UI still says
   "Waiting for mission X PRs to merge" (`mission-dependency.ts:63`).
8. **`attempts7d` misses a whole retry class.** `initiative-pulse.ts:595` uses
   `deriveTaskType`, whose prefixes are `[reviewer retry`, `[reviewer]`,
   `[(CI )?retry` (`packages/core/mission-helpers.ts:29-31`). Conflict retries
   are titled `[Conflict Retry #N]` (`conflict-retry.ts:150`), match nothing,
   carry a `parentTaskId` and inherit `mode: 'execution'` → classified `null` →
   counted as fresh deliverable work. They carry `taskClass: 'attempt'`
   (`:411`), which is correct. **Use `isAttempt` / `taskClass`
   (`mission-helpers.ts:435-459`); retire `deriveTaskType` to display-only.**
   The gate built to prevent this
   (`packages/core/__tests__/task-class-invariants.test.ts`) scans only
   `apps/web/src/app/**/{page.tsx,route.ts}` + `TaskGrid.tsx`, so
   `lib/initiative-pulse.ts` is outside it, and its regex targets the `!== null`
   form while the live site uses `=== null`. **Extend the scan to
   `apps/web/src/lib/**` and cover both forms.**
9. **`docs/specs/scheduled-task-merge-policy.md` is `status: active` and
   entirely unimplemented.** No `tasks.merge_policy` column (`merge_policy`
   appears once in the schema, on `missions`, `:679`); `resolvePolicy`
   (`lib/merge-policy.ts:58-77`) has no task step and its signature cannot take
   one; the schedule cron does not propagate `template.mergePolicy` (zero
   occurrences in `api/cron/schedules/route.ts`); `parseMergePolicy` is wired
   only into `api/missions/route.ts` and `api/workspaces/[id]/config/route.ts`.
   AC-1…AC-6 all unmet. **Decide: implement, or set `status: superseded`.** It
   cannot stay `active` and unbuilt.
10. **`tasks/[id]/page.tsx:563` prints raw enums** (`ci_running`, `pr_open`)
    into the UI. And `StageChip`'s `MERGE` (`:36`), `VERIFY` (`:37`),
    `REVIEWING` (`:33`) are already dead — never produced by `lib/stage.ts`.
11. **For the CI-signals list:** `missions/[id]/page.tsx:299-306` asserts
    `prCount > totalTasks` as a dev invariant. Under A it becomes structurally
    unfalsifiable (`prCount ≤ 1`); it is weak today.
12. **No `pull_request_review` webhook handler exists** (`webhook:59-84`).
    Reviewer approval arrives via the reviewer task's completion PATCH
    (`workers/[id]/route.ts:2226+`), which resolves its worker by
    `findFirst(workspaceId + prNumber)` at `:2296-2302`.
13. **`change-intent.findConflictingIntents`** (`change-intent.ts:142-160`)
    excludes only `excludeTaskId` — no same-branch exemption. Harmless under A′
    (distinct branches) but would produce N² incoherent notes under A.

---

## 6. The doc rewrite — concrete edit plan

Target: `docs/design/mission-delivery-arc.md` (currently `Status: Proposed`,
recommends Option B). Keep DESIGN-FORMAT: Problem → Proposal (naming the crux) →
Open questions → Non-goals, plus Current state and Implementation sketch.

1. **Keep §Problem almost as-is.** All four observations still hold, including
   that `deriveMissionHealth`'s `'shipped'` means `status === 'completed'`
   (`mission-helpers.ts:264`) and that `shippedThisWeek`
   (`initiative-pulse.ts:243`) is derived from that same row transition.
2. **Keep the whole Findings section** (B1–B9, U1–U10). Every item was
   re-confirmed by the audit; B9's "written in one place, read in one place" is
   now corroborated three times over.
3. **Replace the crux.** It currently reads "is a mission a release unit or an
   attribution set?" with a recommendation of B. Rewrite as a three-way: A, A′,
   B — recommend **A′**, and state the crux as **where the merge policy tier
   applies** (mission PR vs task PRs). If that is wrong, A′ degenerates into
   either A's deadlocks (tier on the mission PR *and* no task PRs) or today's
   behaviour (tier on task PRs into `dev`).
4. **Import §1 of this plan as the "why not A" argument**, compressed. The three
   deadlocks and the runner destruction are the load-bearing parts.
5. **Drop `MissionShipState`'s `partially_shipped`.** Under A′ it cannot occur.
   The remaining states are `building | merged_unshipped | shipped |
   release_failed | not_applicable`, still derived, still never stored.
6. **Keep the frontend section largely intact** — Delivery block, `deriveTaskOrigin`
   Origin row, attempt strip via `attachAttempts`, `/app/releases` index as an
   Activity sub-tab, `NewMissionForm` "Done when…" step, surface-IA §5
   completion. A′ does not invalidate any of it; the Delivery block gets simpler
   (three steps, no partial state).
7. **Add §3 of this plan as the prerequisites section**, and §5 as a separate
   "fix regardless" section so the two never get entangled in one PR. §3.9
   splits across both: the seed's non-admission is a live defect and belongs with
   §5, while the `(repoPath, baseRef)` key and the merge-triggered refresh are
   A′-specific and belong with §3.
8. **Add the spec follow-ups** (§7 below) to the implementation sketch.

---

## 7. Spec follow-ups the rewrite must schedule

- `docs/specs/surface-ia-home-missions-initiatives.md` §6.1 field definitions
  survive A′ unchanged (per-task PRs still exist) — **but** add the invariant the
  audit found missing: *a mission whose deliverable work is complete and whose
  integration PR is unmerged MUST contribute exactly 1 to `awaitingVerification`*.
  §5.2 / AC-20 / AC-29 are agreement invariants and cannot catch a surface that
  agrees on `0`.
- `docs/specs/mission-task-lifecycle.md:264-267` becomes true under A′ — update
  the wording to say task PRs target the integration branch, and add the mission
  PR as the single gate. Gate inventory: consider whether an
  `integration_branch_busy` reason is needed (probably not under A′, since task
  PRs serialize normally); `unmerged_dep_pr` keeps its current meaning.
- `docs/SPEC.md:79` — rewrite to describe A′ precisely.
- After touching anything in `docs/specs/`: `bun run specs:check` (CI
  `specs:lint` + the pre-commit hook enforce INDEX + frontmatter).
- Migration steps 4–6 of the surface-IA spec are still unshipped: Home mounts
  `InitiativeRail` (`home/page.tsx:1385`), the dead `groupMissionsByInitiative`
  path still ships with its test, and initiative detail has no verdict block,
  evidence line, pending strip or large sparkline. §3.2's mandated deletion of
  `initiativeGroups` will collide in `MissionGrid.tsx` with any A′ edits — do the
  deletion first.

---

## 8. Still genuinely open

- **A′ vs B.** A′ is the recommendation, but it is not free (§2.3). The CI
  trigger question is **resolved** (§2.3) — a one-line widening, not a blocker.
  What remains open is the doubled CI minutes and the §3.5 freshness cadence.
- **Does `shipped` require production, or is the integration merge enough?**
  Proposed: archetype decides — `gated` requires containment in a healthy `main`
  release, `continuous` requires the deploy, `none` renders no delivery step at
  all rather than a permanently amber one.
- **Which missions get an integration branch?** Finite, deliverable,
  single-workspace, terminating. Monitoring/heartbeat missions never complete, so
  their branch would never merge. Workspace-less and cross-workspace missions
  cannot have one. Under A′ this is a soft choice (both shapes coexist fine
  without a discriminator column), but the organizer needs to know which it is
  planning for.
- **Keep `primaryPrNumber`?** Under A′ it finally has a referent (the mission
  PR) — provided §3.2 lands.
- **Should the mission PR be owned by a worker row?** §3.4 — the escalation
  inbox and the merge route are both worker-keyed, so "no" means the review flow
  silently produces nothing.
