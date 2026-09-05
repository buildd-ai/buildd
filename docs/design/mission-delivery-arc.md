# Mission Delivery Arc — Idea to Release

**Status:** Proposed
**Verified against:** `origin/dev` @ `f48cfbb2` (2026-09-04). Every path and line
below was read, not remembered. Line numbers drift — re-confirm before editing.
**Related:** `docs/plans/mission-delivery-arc-rewrite.md` (the audit this rewrite
carries), `docs/specs/mission-task-lifecycle.md`, `docs/specs/release-flow.md`,
`docs/specs/surface-ia-home-missions-initiatives.md`,
`docs/specs/scheduled-task-merge-policy.md`, `docs/design/release-management-ui.md`,
`docs/design/merge-policy.md`, `docs/design/retry-continuity.md`,
`apps/web/src/lib/mission-release.ts`, `apps/web/src/lib/release-executor.ts`,
`apps/web/src/app/api/workers/claim/deps-gate.ts`,
`apps/runner/src/git-operations.ts`, `apps/runner/src/cbm-enforcement.ts`,
`apps/web/src/app/app/(protected)/missions/[id]/page.tsx`,
`apps/web/src/lib/initiative-pulse.ts`

---

## Problem

The arc a mission is supposed to travel — *idea → decomposition → execution →
review → verification → release* — is implemented as six independently-correct
mechanisms with no shared state and no surface that shows the whole trip. Four
observable consequences:

1. **The word "shipped" is already taken, and it does not mean shipped.**
   `deriveMissionHealth` returns `'shipped'` when `mission.status === 'completed'`
   (`apps/web/src/lib/mission-helpers.ts:264`), which is a row transition. It says
   nothing about whether the mission's code is in production. `shippedThisWeek`,
   the count rendered on the Initiatives list and specced as a pending-action chip,
   is derived from that same row transition
   (`apps/web/src/lib/initiative-pulse.ts:245`, from the health value per the
   docstring at `:188`). No code path anywhere answers *is this mission's work in
   production*.

2. **A failed mission release is silent and permanent.**
   `fireMissionReleaseIfComplete` sets `missions.releasedAt` *before* attempting the
   release (`mission-release.ts:86`, and the same pattern at
   `apps/web/src/app/api/github/webhook/route.ts:826`). Every downstream failure —
   `resolveReleaseStrategy` returning `not_configured`, a `workflow_dispatch` throw,
   or `executeRelease` returning `status: 'skipped'` — is a `console.log`. The claim
   is never released. Nothing resets `releasedAt`; the only writers in the codebase
   set it. The mission is now permanently marked as released with nothing deployed,
   and no surface displays `releasedAt` at all.

3. **Mission detail — the page you open to answer "is this done?" — contains the
   string "release" zero times.** The unshipped-commit count exists on the mission
   *card* in the grid (`MissionReleaseFooter`, mounted from `MissionGrid.tsx`) and
   disappears when you open the mission. `Release now` lives at
   `/app/workspaces/[id]/config` and is disabled for `branch_merge` workspaces with
   the tooltip *"branch_merge releases automatically on task completion"* — which,
   per finding B2 below, is not true for mission-scoped releases.

4. **Nothing records who created a task or why.** `tasks` carries
   `createdByAccountId`, `createdByWorkerId`, `creationSource`, `scheduleId`,
   `parentTaskId`, `taskClass` and the three `*RetryPrNumber`/`*RetryHeadSha` pairs
   (`packages/core/db/schema.ts:807–898`). The task detail page renders none of
   them: its `Details` disclosure shows priority, runner, backend, claimed-by,
   worker count, created date, category, project, id
   (`tasks/[id]/page.tsx:1210–1219`). `createdByWorkerId` has exactly one read site
   in the product, a server-side string in `api/tasks/route.ts`. The only published
   signal of lineage is a bracketed title prefix.

---

## Current state, stage by stage

| Stage | Mechanism | Surface | Gap |
|---|---|---|---|
| Idea | `POST /api/missions`, `NewMissionForm` | `/app/missions/new` | No goal-criteria field. Definition of done is captured post-hoc on the detail page or never (U5). |
| Decomposition | `runMission` → organizer planning task → MCP `create_task` | Mission timeline | Working branch generated but not propagated (B9). Planning halts on one arbitrary PR (B7). |
| Execution | claim route → worker → branch → PR | Timeline / task detail | Every task PRs straight into `defaultBranch`; **no mission-scoped diff exists**. Mission tasks additionally fall back to the shared main clone (B10). |
| Review | `resolvePolicy` → `tryAutoMergeWorkerPr` / reviewer / CI retry / conflict retry | Timeline `waitingOnYou`, bookkeeping footer | Attempt chain collapsed to title + timestamp (U8). Two disagreeing classifiers (B5, B6). No `pull_request_review` handler (B14). |
| Verification | `canCompleteMission` + `goalCriteriaState` | `MissionGoalCriteria` panel | Mostly works — but `command` criteria run off the default branch (B16), and the refusal *code* is only in the feed and the logs; `mission:completion_decision` has no subscriber (U10). |
| Release | `fireMissionReleaseIfComplete`, `executeRelease`, `attributeRelease` | none on mission; `/app/releases/[id]` only | B1–B4, B11, U1–U4, U7. |

`releases` + `release_tasks` already model *what shipped*: `attributeRelease`
walks the `previousSha…headSha` compare range and writes one edge per task, by
commit sha for `continuous` archetypes and by merge-commit PR number for gated
ones (`packages/core/release-attribution.ts`). The data to answer "is this mission
in production" exists in shape. Nothing reads it in that direction, and for this
repo's own topology the gated half of it does not actually work (B11).

---

## Findings

Two groups, and the distinction matters for sequencing: **code defects** (B\*) are
true today and worth fixing whichever branch model wins; **surface gaps** (U\*) are
what the frontend does not render.

### Code defects

**B1 — release claim is taken before the release happens.**
`claimMissionRelease` (`mission-release.ts:25`) is an `UPDATE … WHERE released_at
IS NULL`, correct as a dedup primitive and wrong as a commit: it fires at
`mission-release.ts:86`, before strategy resolution, before dispatch, before
`executeRelease`. Every failure path after it leaves a poisoned mission. Same
defect at `api/github/webhook/route.ts:826`.

**B2 — mission release is a no-op on this repo's own release topology.**
For a `branch_merge` workspace with `releaseBranch` set (dev→main),
`executeRelease` returns `skipped` unless the completing task carries
`release: 'true'`. Mission-driven releases arrive with `release: 'inherit'` on a
feature task, so the mission release resolves to *"feature task — code lands on dev
and is promoted to main by the release task"*. `isMissionRelease: true`
(`release-executor.ts:273,305`) bypasses only the trigger-policy block, **not this
gate**. The mission therefore never releases, and never can — after B1 has already
consumed its one release attempt.

**B3 — the webhook release path skips the completion predicate.**
`mission-release.ts` calls `canCompleteMission(…, { evaluateCriteria: false })`
before releasing, as `docs/specs/mission-task-lifecycle.md` requires. The webhook
path checks only `countPendingTasksForMission(…) === 0`
(`api/github/webhook/route.ts:821`) and dispatches. A mission whose stated goal
criteria read `fail` can be shipped by the webhook path and refused by the
completion path, for the same mission, in the same minute.

**B4 — the release-trigger default the UI shows is not the one the server uses.**
`ReleaseSection.tsx` defaults the radio group to `on_mission_complete`; all three
server readers default to `every_merge` (`mission-release.ts:54`,
`release-executor.ts:306`, `api/github/webhook/route.ts:814`). A workspace with a
`releaseConfig` that has no explicit `trigger` displays a policy it is not running.

**B5 — the rework signal behind the `losing` verdict misses a whole retry class.**
`attempts7d` classifies with `deriveTaskType` (imported at
`initiative-pulse.ts:4`), whose prefix set is `[reviewer retry`, `[reviewer]`,
`[(CI )?retry` (`packages/core/mission-helpers.ts:22–39`). Conflict retries are
titled `[Conflict Retry #N]` (`conflict-retry.ts`), match no prefix, carry a
`parentTaskId` and inherit the default `mode: 'execution'` — so `deriveTaskType`
returns `null` and they are counted as fresh deliverable work. A workspace
thrashing on merge conflicts reads `winning`. The same rows carry
`taskClass: 'attempt'`, which is correct.

**B6 — two classifiers for one question, and the gate that was built to stop that
does not cover the file.** `taskClass` is the stored discriminator with predicates
`isWork` / `isBookkeeping` / `isAttempt` / `attachAttempts`
(`packages/core/mission-helpers.ts:435–459`), and
`packages/core/__tests__/task-class-invariants.test.ts` bans the legacy predicates.
Its file scan is limited to `apps/web/src/app/**/{page.tsx,route.ts}` plus
`TaskGrid.tsx`, so `apps/web/src/lib/initiative-pulse.ts` — the one place a stale
classifier changes a rendered verdict — is outside the gate. The banned regex is
also written for the `!== null` form; the live call site uses `=== null` +
`continue`. This is the shape catalogued in the CI-signals-that-measure-nothing
list: a gate that cannot fail on the case it was written for.

**B7 — `primaryPrNumber` means "first PR any mission task opened", and it stops the
mission.** `persistMissionPrIfFirst` (`api/github/pr/route.ts:893–903`) writes it
once, under `isNull(primaryPrNumber)`. `mission-run.ts:184–196` then refuses to
plan any further work while that PR is open, notifies *"Mission PR awaiting
review … Planning paused until it merges"*, and returns
`{ task: null, skippedPrOpen: true }`. `maybeRetriggerMission` does the same. One
arbitrary task's PR gates the whole mission's planning while its sibling PRs sit
open and uncounted. The UI labels it `PR #N` on the mission card as though it were
the mission's PR.

**B8 — `docs/specs/scheduled-task-merge-policy.md` is `status: active` and is not
implemented.** No `tasks.merge_policy` column exists (`merge_policy` appears once
in the schema, on `missions`). `resolvePolicy` has no task-policy step
(`lib/merge-policy.ts:58–77`) and its signature does not accept one. The schedule
cron does not propagate `template.mergePolicy` (zero occurrences in
`api/cron/schedules/route.ts`). `parseMergePolicy` is wired only into
`api/missions/route.ts` and `api/workspaces/[id]/config/route.ts`. AC-1 through
AC-6 of that spec are all unmet. Consequence: mechanical scheduled PRs cannot opt
into auto-merge, so they accumulate in review and inflate every unshipped count.

**B9 — the shared mission branch is written in one place and read in one place.**
`docs/specs/mission-task-lifecycle.md:264–267` states `missions.workingBranch` and
`primaryPrNumber` "track the shared branch for all tasks under the mission". In
code, `context.headBranch` is written only by `mission-run.ts:289` (the organizer's
own planning task) and read only by the claim route
(`api/workers/claim/route.ts:1687–1693`). No other creation path — MCP
`create_task`, dashboard, schedule cron, CI/reviewer/conflict retry — sets it.
Build tasks therefore get `buildd/<taskid>-<title>` and PR into `defaultBranch`.
**There is no mission integration branch and no mission diff.** This is the finding
the whole Proposal turns on.

**B10 — mission tasks running in the shared main clone: FIXED on `dev`, keep the
guard.** The audit found that `context.baseBranch` set to the default branch made
`setupWorktree` fail and `workers.ts` fall back to the shared main clone — no fs
isolation, no CBM. Re-verified 2026-09-04: `git-operations.ts:326-331` now has an
`unusable()` guard returning `'default_branch'` / `'checked_out'`, and the
candidate ladder ends in `` `${branch}-w${workerId.slice(0,8)}` ``, unique per
attempt by construction; `git branch -D` skips branches a live worktree holds.
The comment there records the original failure verbatim. **Residual, unfixed:**
the worktree *directory* is still keyed on the requested `branch`
(`git-operations.ts:189-190`), not on the resolved `actualBranch`, and a stale
path at that location is reclaimed with `git worktree remove --force` (`:217`) —
verified to return exit 0 on a worktree with uncommitted changes. Two workers
asking for the same branch now get distinct branches but still compute the same
directory. Not reachable today (only one non-committing task type sets
`headBranch`); it becomes reachable under any model that shares a branch name
across concurrent workers.

**B11 — gated releases write no `releases` row. FIXED.** The audit's first half —
attribution matching only `/Merge pull request #(\d+)/` while task PRs are
squash-merged as `title (#N)` — was already fixed on `dev`:
`release-attribution.ts:64` now carries `SQUASH_COMMIT_RE` plus a bounded
`commits/{sha}/pulls` fallback for anything neither pattern matches. The second
half was live: `maybeCreateReleaseRow`
early-returns unless the archetype is `continuous`
(`release-executor.ts:233`), so no `releases` row is written for gated
`branch_merge` workspaces at all — `MAX(healthy_at)` is NULL and the Home release
widget hides by construction (`api/releases/readiness/route.ts`). `attributeByPr`
also keeps a `seenPrs` set and takes the first worker per PR
(`release-attribution.ts:211–216`), asserted by name in
`packages/core/__tests__/release-attribution.test.ts`.

**B12 — `/app/tasks` shows two numbers that disagree.**
`TaskGrid.tsx:121–122` passes `prUrl`/`prNumber` to `TaskCard` but omits
`prLifecycleStatus` (declared `:27`, and the only thing the histogram consults at
`:217–219`). A merged task renders chip `OPEN #1234` while the histogram counts it
`DONE`. Related and weak: `missions/[id]/page.tsx` asserts `prCount > totalTasks`
as a dev invariant — a comparison that no branch model makes meaningful.

**B13 — mission `gateCondition: 'merged'` clears on the *first* task PR merge.**
The webhook merge path and `prs/[prNumber]/merge/route.ts` resolve the gate on a
single worker's merge, while the UI still says "Waiting for mission X PRs to merge"
(`mission-dependency.ts`). A downstream mission unblocks on 1-of-N.

**B14 — there is no `pull_request_review` webhook handler.** The event switch
(`api/github/webhook/route.ts:62–86`) handles `installation`,
`installation_repositories`, `issues`, `check_suite`, `pull_request`,
`workflow_run`, `ping` — and nothing else. Reviewer approval arrives only via the
reviewer task's completion PATCH (`workers/[id]/route.ts`), which resolves its
worker by `findFirst(workspaceId + prNumber)`. A human approving in GitHub's UI
produces no state change in buildd.

**B15 — the shared codebase-graph seed is implemented, deployed, and never
admitted.** `buildCbmActivation` (`apps/runner/src/cbm-enforcement.ts:345`)
resolves a seed via `readCbmSeedRecord(ctx.repoPath)` (`:230`), keyed by a hash of
the **base-clone path alone** (`:186`). The record carries `ref` and `sha`, but
neither is part of the key and neither is compared at admission — the gate is just
`record && pathExists(join(shared, ...))` (`:361–362`). Nor could a non-default
base ever be seeded: `scripts/cbm-seed.ts` takes only a repo path and resolves the
ref from `origin/HEAD`, so "the default branch" is structural, not configurable.
Across the measured window the seed was admitted for **not one** worker, so every
worker pays the per-worker fallback: a full index under a 60s cap
(`cbm-bootstrap.ts:23`), whose own comment justifies that budget from a measurement
taken with a single indexer running. Timeouts get materially worse once several
bootstraps overlap on one runner, and worst of all for the `builder` role — the
code-touching cohort the graph exists for. This is a live defect independent of any
branch decision. (Figures live in `knowledge-base`, not here.)

**B16 — `command` goal criteria verify the wrong tree.**
`mission-criteria-verify.ts:208` selects `workingBranch`, and the created
verification task's `context` (`:253–259`) carries `criteriaVerification`,
`verificationCommand`, `retryCount` — and no branch. So `bun test` runs off
`defaultBranch` and verifies code the mission has not landed. Today that is
usually harmless because the mission's work *is* on `dev`; under any integration
model it silently verifies the wrong thing.

**B17 — CI does not run on any base except `dev` and `main`.**
`.github/workflows/build.yml:3–6` triggers `push: [dev]` and
`pull_request: [main, dev]`, with no top-level `concurrency:` group. A PR based on
anything else gets **no Build & Test run at all** — and because `ci-fix.yml`
triggers on `workflow_run` of "Build & Test", the CI-retry agent chain goes silent
with it. Not a defect today (nothing targets another base); a hard prerequisite for
the Proposal. Separately, `CLAUDE.md:64` and `docs/testing-strategy.md:150`
reference `.github/workflows/preview-tests.yml`, which was deleted — the
integration tests now run inside `build.yml`.

### Surface gaps

- **U1** Mission detail has no release block. Composition is header → outcome
  summary → Timeline|Feed tabs → goal criteria → settings.
- **U2** There is no `/app/releases` index — only `[id]/page.tsx` — and no nav
  entry (`lib/nav-config.tsx`: Home, Missions, Initiatives, Activity, Team).
  Release history exists only inside workspace config.
- **U3** The Home `Release Queue` widget states the problem (`N unshipped · oldest
  Nd ago`) and offers a link to the *previous* release. It has no verb.
- **U4** `Release now` is three navigations deep and disabled for the strategy this
  repo uses.
- **U5** `NewMissionForm` collects title, description, workspace, backend, budget,
  schedule. No goal criteria, no merge policy, no release intent.
- **U6** No provenance anywhere in the UI (see Problem §4).
- **U7** No task → release link, though `release_tasks` edges are written and the
  release page renders the reverse direction.
- **U8** Attempts and reviewer runs collapse into a bookkeeping footer carrying
  title, timestamp, PR url. Why the attempt exists, which role ran it, and how many
  remain are all absent.
- **U9** `docs/specs/surface-ia-home-missions-initiatives.md` migration steps 4–6
  are unshipped: Home still mounts `InitiativeRail`, the dead
  `groupMissionsByInitiative` path still ships with its test, and initiative detail
  has no verdict block, evidence line, pending-action strip or large sparkline.
- **U10** `MISSION_COMPLETION_DECISION` is emitted for every completion decision
  per spec and has no subscriber (`lib/pusher.ts` is its only occurrence).
- **U11** `tasks/[id]/page.tsx` prints raw enums (`ci_running`, `pr_open`) into the
  UI, and three of `StageChip`'s states (`MERGE`, `VERIFY`, `REVIEWING`) are dead —
  never produced by `lib/stage.ts`.

---

## Proposal

### The crux

**Where does the merge-policy tier apply — to the mission's PR, or to each task's
PR?** That single placement decision determines whether a mission can be a
reviewable, revertable unit, and it is the thing this design turns on.

Three branch models follow from it. All three are live options; the difference
between them is entirely about where the human gate sits.

*Option A — mission is the release unit, no per-task PRs.* All tasks of a mission
share one integration branch and produce **one** PR. This is what `docs/SPEC.md:79`
and `docs/specs/mission-task-lifecycle.md:264` already claim happens. **Dead on
today's machinery — see below.**

*Option B — mission is an attribution set.* Per-task PRs into `dev` stay exactly as
they are; "released" means every PR of the mission is contained in a `healthy`
release. Honest, cheap, and requires the UI to learn a genuinely half-shipped
state.

*Option A′ — per-task PRs, retargeted.* **The recommendation.** Each task keeps its
own branch and its own PR, exactly as today. The only change: a mission task's PR
**base is the mission integration branch**, not `dev`. When the mission's work is
done, the integration branch opens one PR into `dev`. That mission PR is the single
human gate; the normal dev→main release promotes it. A standard stacked
integration-branch workflow.

**Recommendation: A′.** It preserves everything Option A was for — a mission diff,
one review, one revert, `workingBranch` meaning something — while dissolving every
mechanism that kills A, because the merge machinery keeps seeing exactly one worker
per PR.

**The load-bearing half of A′ is the crux itself:** the tier applies to the
**mission PR**, not the task PRs. Task PRs into a quarantined integration branch
run `auto-threshold` and land unattended; `human` / `agent-review` applies once, at
the mission PR. **If that placement is wrong, A′ collapses into one of its
neighbours** — put the tier on the task PRs and you have today's behaviour with an
extra branch; put it on the mission PR *and* suppress task PRs and you have A's
deadlocks.

### Why Option A is dead

Not "slow" or "awkward" — structurally deadlocked and destructive. Do not revisit
without reading this. Scoping A to "finite missions only" dodges none of it: every
deadlock below is *inside* one mission.

| Deadlock | Mechanism | Why it never clears |
|---|---|---|
| **Dep gate** | `claim/deps-gate.ts:54–55` — a dep is satisfied only when its status is terminal AND no worker on it holds `pr_url IS NOT NULL AND merged_at IS NULL` | The mission PR is open for the mission's whole life. Task A completes → A's worker holds the mission PR → task B (`dependsOn: [A]`) is withheld → mission never finishes → PR never merges. **Every mission with one DAG edge stalls.** |
| **`all_prs_merged`** | `packages/core/mission-helpers.ts:253–289` — filters workers by `prUrl`, fails on any unmerged one, and never inspects base ref | Reads `fail` → `criteria_failed` → no completion → no merge. Closed loop, no timeout. |
| **`path_overlap`** | `claim/route.ts:1275–1278` via `findBlockingPr` — defers a task whose manifest overlaps a task holding an open PR | Every mission worker carries the same open PR, so overlapping siblings defer each other forever. This is a **soft** deferral the spec requires to self-clear (rule CG-6), so it becomes an invisible permanent stall that violates its own contract. |

Two more variants of the `all_prs_merged` problem: if **no worker owns** the mission
PR, `deliverableWorkers` is empty (`mission-helpers.ts:255–256`) → `UNVERIFIED` →
`criteria_unverified`, which means **every finite mission sits permanently at
`AWAITING VERIFICATION`**. And if sub-PRs *do* merge into the mission branch, the
criterion **passes with zero lines on `dev`** — a false green, which is worse than a
stall, and which A′ inherits (see prerequisite P1).

You cannot escape the dep gate by suppressing per-task PRs:
`workers/[id]/route.ts` queries GitHub at completion for open PRs matching the
worker's branch and stamps the first one onto the worker. On a shared branch that
is the mission PR. And if the mission PR does not exist yet, `pr_required`
hard-400s the completion — `default-roles.ts:118` sets `pr_required` on generated
builder steps, so this is the common path, not an edge.

**The runner destroys work on disk.** `git-operations.ts:149–150` keys the worktree
*directory* by sanitized branch name, so two mission tasks compute the identical
path; `:177` then `git worktree remove --force`s whatever is there — verified to
return **exit 0 on a worktree with uncommitted changes** — with no liveness check,
while the agent session is fire-and-forget. `:276` `git branch -D` then succeeds
because the holding worktree is gone, and the sibling's unpushed commits are
deleted. The destroying side logs it as *"Cleaning up stale worktree at …"*. If the
removal fails instead, `:289` `git worktree add -b` fails on the existing branch,
`setupWorktree` returns null, and `workers.ts` falls back to the **shared main
clone** — two agents editing one working tree with `git add -A`. **The runner never
pushes**; pushing is prompted in prose, with no retry, no `pull --rebase`, no lock,
and no deny rule on `push --force`. Serializing does not fix it: `setupWorktree`
always creates the branch fresh from base with `-b`, and a healthy multi-day mission
branch crosses the divergence heuristic, is classified `diverged`, and silently
falls back to `origin/dev` (`worktree-utils.ts:65–67`) while the worktree is still
*named* `mission/x`.

**"One PR, N workers" breaks the merge machinery's cardinality.** Every PR→worker
lookup in the merge path is a `findFirst`: 19 `findFirst` calls and 9 `workerOwnsPr`
references in `api/github/webhook/route.ts` alone, plus
`prs/[prNumber]/merge/route.ts`, which deliberately fetches all matching workers and
then takes `matchingWorkers[0]`. On merge, only **one** worker gets `mergedAt`
stamped (`webhook:704`) and one task auto-completes. N−1 mission workers keep
`mergedAt = NULL` forever, stranding everything gated behind that single lookup:
path-claim release, intent closing, subject-anchor sweep, dead-PR shutdown,
`checkDependsOnResolved`, loop advancement, work-tracker Done, and the release
trigger. The `merged_at` heal tiers repair the column but never re-fire these
effects, and stranded `path_claims` then block unrelated future work. Worse,
**PR-keyed dedupe indexes become cross-task mutexes**: `hasActiveReviewerFixTask`
(`auto-merge.ts:422–428`) keys on `(workspaceId, prNumber)` with no `taskId`, and
the conflict-retry unique index is `(workspaceId, prNumber, headSha)`
(`schema.ts:918`) — so a legitimate fix task for task B is silently suppressed
because task A already has one open on the shared PR.

**Auto-merge ships partial missions, then refuses to ship whole ones.** With the
default `auto-threshold` tier, `check_suite` success on the mission PR runs the
existing per-worker path: it picks one arbitrary worker, resolves policy from *that*
worker's task, and squash-merges. **The first task's green CI merges the partial
mission into `dev`.** Conversely, once you *want* it merged it won't:
`DEFAULT_MERGE_POLICY` is `maxLines: 800` (`merge-policy.ts:26–29`) and
`evaluateAutoMergeSafety` rejects on aggregate source lines, which a mission-sized
diff always exceeds. And because `applyPolicyConfigToMergePolicy` only ever ratchets
*more* restrictive over the union of every task's files, any risk-classed path
anywhere in the mission escalates the whole thing to `human` — **the tier system
collapses to one tier.** The reviewer, meanwhile, dispatches once on
`pull_request.opened` (`webhook:576` → `maybeDispatchReviewer:1290`), so it reviews
whatever the first task produced; `synchronize` only stamps `prLifecycleStatus`.

**And the UI cost is ~22–26 files, ~14 with real logic changes.** Worst three, with
the wrong number each would render: mission detail's `awaitingMerge` counts
completed tasks whose latest worker has an open PR → **0**, so the header reads
"14 of 14 tasks complete" with nothing on `dev`, the merge-policy chip vanishes
*exactly* when a human gate is pending, `MissionReviewSummary` prints "14 tasks
completed (no PR)" with an empty body, and the "Waiting on you" band renders 0 rows.
The initiative verdict ladder breaks in both directions from one cause:
`awaitingVerification` (`initiative-pulse.ts:237`) and `blocked` (`countBlockedByPR`
at `:279`) both go to 0, so `stuck` becomes unreachable and finished missions parked
on unmerged branches read `Dormant` — which per spec AC-1 contributes no clause, so
Home renders **no pulse line at all** — while `merges7d` collapses to 1 per mission
against an `attempts7d` that still counts every task, firing **`Losing`** on an arc
that shipped everything. Release queue depth counts workers with `mergedAt` newer
than the last healthy release, so a release of 3 missions × 12 tasks displays
"3 unshipped" instead of 36.

**And no existing column discriminates the two shapes.** `workingBranch` is set
lazily for *any* mission whose workspace has a repo (`mission-run.ts:201–220`),
monitoring missions included; `primaryPrUrl` is stamped from the first task PR under
any mission. A would need a new explicit column (`reviewUnit: 'task' | 'mission'`).
A′ needs none.

### How A′ dissolves each of those

| Blocker | Under A′ |
|---|---|
| Dep-gate deadlock | **Gone.** Task PRs merge into the mission branch in minutes; `mergedAt` lands; dependents unblock. No exemption predicate needed. |
| `path_overlap` never self-clears | **Gone.** Task PRs close, so the deferral clears as designed. |
| Runner worktree collision, push contention, divergence fallback | **Not touched.** One branch per task, as today. |
| 19 `findFirst`-by-PR sites, `matchingWorkers[0]`, stranded `path_claims` | **Not touched.** One worker per PR everywhere. |
| PR-keyed dedupe indexes as cross-task mutexes | **Not touched.** Distinct PR numbers per task. |
| Premature auto-merge of partial work into `dev` | **Becomes correct.** Auto-merge merges task PRs into the mission branch — precisely where partial work should accumulate. The 800-line threshold applies per task, the right granularity. |
| Reviewer dispatches once on the wrong diff | **Fixed by placement.** The per-task reviewer keeps working on task PRs; the mission PR gets the one human/agent gate. |
| Tier system collapses to one tier | **Gone.** Per-task risk classes still evaluate per task. |
| ~14 UI logic sites | **Mostly untouched.** They read per-task PR state, which still exists. |
| Two-shapes discriminator column | **Not needed.** |
| `partially_shipped` (Option B's cost) | **Structurally impossible.** One mission, one diff, one merge. |

### What A′ buys

- **One human decision per mission instead of N.** Today a 14-task mission produces
  14 MERGE cards (`action-queue.ts:145`, one `subjectKey` per `prUrl`) and
  `home/page.tsx:1013` caps the escalation inbox at `.slice(0, 10)` — so a 14-PR
  mission is **structurally unreviewable from Home today, and four cards are
  silently dropped.**
- **The fleet stops stalling on a person.** `isGateSatisfied`
  (`task-presentation.ts`) blocks the next task until a human merges the previous
  one. Under A′ plus per-task `auto-threshold` into the integration branch,
  intra-mission dependents unblock without human action.
- **A mission diff, one review, one revert** — which does not exist today in any
  form.
- **Five artifacts stop lying** (see below).
- **Release attribution can stop being a heuristic**: one mission PR number/sha →
  join on `tasks.missionId`. `release_tasks` already accepts nullable
  `prNumber`/`commitSha`, and `releases.unit` (`schema.ts:2390`) is an unused column
  that reads like it was reserved for exactly this.

### The five artifacts that assert Option A today, and are false

- `docs/SPEC.md:79` — *"**`workingBranch`** + `primaryPrNumber`/`primaryPrUrl` — all
  mission tasks push to one shared branch tracked by a single PR."*
- `apps/web/src/lib/default-roles.ts:107` — *"**ONE task = ONE branch = ONE PR.**
  Never fan out parallel tasks that touch the same files."*
- `docs/specs/mission-task-lifecycle.md:264–267`, the `missions.workingBranch`
  docstring in `schema.ts`, the planning pause (`mission-run.ts:184–196`), and the
  `PR #N` label on mission cards.

**A′ is the only option that makes all of these true at once.** B makes them true by
deleting the claim.

### Costs, stated honestly

- N+1 PRs instead of N. More GitHub noise.
- **CI must be widened** — see B17. Task PRs based on `mission/*` currently get no
  `pull_request` run, and no `ci-fix.yml` run either. Adding `'mission/**'` to
  `build.yml`'s `pull_request.branches` is a one-line change, but without it A′
  accumulates unverified commits on the integration branch, which destroys its main
  safety argument. Add a `concurrency:` group in the same change; neither
  `build.yml` nor its downstream has one, so overlapping runs pile up uncancelled.
- CI then runs at two levels (task PRs against the integration branch, plus the
  mission PR against `dev`). Roughly double the minutes on mission work.
- The integration branch diverges from `dev` over a long mission and needs `dev`
  merged in on a cadence. Nothing does that today (P5).
- `workers.mergedAt` now means "landed on the integration branch", not "landed on
  `dev`". Release-queue counting must learn the difference (P4).
- **The codebase graph's cache key stops matching the base**, and A′
  simultaneously raises the concurrency that already breaks the fallback path
  (B15, P9).

### The missing dimension: ship state

Mission health answers *is work moving*. Goal criteria answer *is it correct*.
Neither answers *is it out*. Add one derived — never stored — dimension:

```ts
type MissionShipState =
  | 'building'          // open work or an open mission PR remains
  | 'merged_unshipped'  // mission PR merged to dev, not in a healthy release
  | 'shipped'           // the mission's merge is contained in a healthy release
  | 'release_failed'    // release attempted, no healthy release contains the work
  | 'not_applicable';   // workspace-less mission, or archetype 'none'
```

Under A′ there is **no `partially_shipped`** — one mission, one diff, one merge, so
the half-shipped state is structurally impossible. That is the single biggest
simplification A′ buys the frontend, and the reason to prefer it over B even though
B is closer to today's code.

Derivation, one query, no new columns: the mission's merge commit, joined through
`release_tasks` → `releases`, partitioned on `releases.state = 'healthy'`.
`release_failed` is "an attempt was recorded" with an empty healthy set — the state
B1 currently produces silently.

`deriveMissionHealth`'s `'shipped'` value is renamed `'closed'` in the same change;
it means the row closed and should stop claiming otherwise. `shippedThisWeek` on the
initiative surfaces is re-derived from ship state, not from row status, which makes
the Initiatives-list chip mean what its label says.

### Frontend

**Mission detail — a Delivery block**, mounted directly below the outcome summary
(the natural place: the outcome summary already ends at "merged"). Three steps, each
with its own evidence, each rendering nothing when it has no signal:

```
DELIVERY
  ● Integrated   6/6 task PRs merged into mission/checkout-abc123
  ● Verified     3/3 criteria pass · re-verified 4h ago
  ○ Shipped      mission PR #1204 merged to dev · awaiting release  [ Release now ]
```

Rules:
- The step rail is the mission's answer to *what is left*. A step with no evidence
  renders no row, per the surface-IA no-empty-chrome invariant.
- `Release now` appears only in `merged_unshipped`, only when the workspace has a
  usable strategy, and it POSTs `/api/releases/trigger`. When the strategy is
  unusable the button is **replaced by the reason**, not disabled with a tooltip.
- `release_failed` renders the recorded failure and a `Retry release` control, which
  is the UI half of the B1 fix.
- Every PR chip links to the PR; the release name links to `/app/releases/<id>`.

**Missions list.** `MissionReleaseFooter` is replaced by the ship-state chip from
the same loader, so card and detail cannot disagree (the §5.2 agreement invariant
extended to delivery).

**Home.** The Release Queue widget gains the verb it lacks: `N unshipped · oldest Nd
ago` + `Release` + the names of the missions in the queue. It stays suppressed on
`ci_blocking`, unchanged.

**`/app/releases` index.** A release history list: version, state, CI at dispatch,
task/PR count, age. Reached from the Home widget, the mission Delivery block, and a
`Tasks | Releases` segmented control on Activity — *not* a sixth nav tab. Activity
already answers *what happened*; a release is the largest unit of that.

**Task detail — an Origin row**, above the description, derived from stored columns
by one new pure function `deriveTaskOrigin(task)`:

```
ORIGIN  Organizer agent · mission heartbeat cycle 4     → worker, mission, schedule
        CI retry #2 of 3 · PR #1204 check_suite failed  → parent task, PR, run
        You · dashboard                                  → —
```

Precedence: `creationSource` names the mechanism; `createdByWorkerId` /
`createdByAccountId` names the actor; `scheduleId`, `parentTaskId`,
`ciRetryPrNumber` / `reviewerRetryPrNumber` / `conflictRetryPrNumber` supply the
because-clause and its link. A `Shipped in <release>` row joins from `release_tasks`
(U7). No title parsing: the same function replaces the `deriveTaskType` call sites,
and `deriveTaskType` is retired to a display-only title cleaner
(`stripTaskTypePrefix` keeps its job).

**Attempt strip.** The bookkeeping footer keeps its housekeeping rows, but attempts
move onto their parent row via `attachAttempts`:
`●●○ 3 attempts · CI ×2 · reviewer ×1`, expanding in place. That is the agent chain
the operator is asking about, rendered where the work is, with the reason from
`deriveTaskOrigin` on each attempt.

**Mission creation.** `NewMissionForm` gains a *Done when…* step offering the
mechanical criterion types first (`command`, `all_prs_merged`, `no_open_tasks`,
`artifact_exists`), with `description` requiring its `notMechanizableReason` inline
— the same validation `POST /api/missions` already enforces, surfaced before the 400
instead of after. A mission created with no criteria is legal and says so: *"No
criteria — this mission closes on task progress alone."*

**Initiative detail.** Finish surface-IA §5 (verdict + evidence + pending strip +
`≥168×32` sparkline) and delete the dead grouping path. The verdict's evidence line
gains the delivery clause it is missing: `3 merged · 11 attempts · 2 unshipped ·
240k tokens · 7d`.

### A′ prerequisites

Each is independently shippable and each **defaults to current behaviour** — none
alters anything until a mission is opted into an integration branch.

**P0 — fix B10 first.** `context.baseBranch` resolving to `dev` makes the runner
fall back to the shared main clone. Every option here builds on `context.headBranch`.
Failing test first: a `baseBranch` equal to the default branch must not produce
`actualBranch === defaultBranch`.

**P1 — `all_prs_merged` must become base-ref-aware.** `mission-helpers.ts:253–289`
never reads base ref, so once every task PR merges into the integration branch the
criterion **passes with nothing on `dev`**. This is A′'s one inherited false-green
and must close in the same change that repoints task PR bases. The criterion becomes:
all task PRs merged into the integration branch **and** the mission PR merged into
`dev`. Related dead code to fix or drop: `requireBranchDeleted`
(`mission-helpers.ts:269–282`) is permanently `UNVERIFIED` because nothing populates
`branchDeleted` — and "the mission branch is gone" is exactly the check A′ wants.

**P2 — `persistMissionPrIfFirst` must claim only the mission PR.**
`api/github/pr/route.ts:893–903` claims `primaryPrNumber` for whichever PR arrives
first. Under A′ the first *task* PR steals the slot. Gate it on base ref = `dev`, or
on an explicit `isMissionPr` flag.

**P3 — `runMission` must stop halting planning on an open primary PR** (B7). Under
any mission-PR model that PR is open for the mission's whole life, so the organizer
stops decomposing. The guard should key off "an open PR whose paths overlap the next
planned task", which the path-claim machinery can already answer.

**P4 — one new UI signal: mission integration PR open.** Exactly one MERGE card and
one chip; everything else on the dashboard keeps working. Three specifics decide
whether this works at all:
- **The mission PR must be owned by a worker row.** The escalation inbox requires
  `isNotNull(workers.prUrl)` (`home/page.tsx:796`), and
  `/api/prs/[prNumber]/merge` is worker-keyed, so `MergeConfirmButton` and
  `WaitingOnYouMergeCard` would 404. This single implementation choice decides
  whether the review flow works or silently produces nothing.
- Mission detail needs the mission PR represented — `awaitingMerge` counts task PRs
  and correctly reads 0 once they all merge, so without this the header reads
  "N of N tasks complete" with nothing on `dev`.
- Release-queue depth must distinguish "merged into an integration branch" from
  "merged into `dev`", or it counts mission work twice.

**P5 — integration-branch freshness, with a stated bound.** Nothing merges `dev`
into a mission branch today. `git-operations.ts:211–229` runs a staleness check but
with `cwd: repoPath` — the **main clone's HEAD**, not the mission branch — so it
measures the wrong tree and only `console.warn`s. Decide: a periodic
`dev → mission/*` merge task (bounded: at most one open refresh task per mission at
a time, and it stops after a conflicting merge rather than retrying), or accept that
the mission PR resolves divergence at the end. GitHub's `pull_request` checks test
the base-merged ref, so the mission PR itself is not fooled by a stale base.

**P6 — `command` criteria must run on the mission branch** (B16). Put
`workingBranch` into the verification task's context.

**P7 — rewrite the seeded planner instructions.** `default-roles.ts:107` injects
*"ONE task = ONE branch = ONE PR"* into every planner prompt. Under A′ that clause
stays true and the **base** changes, so the wording must name the integration
branch — otherwise organizers keep planning against the wrong model. `:118–119`
setting `pr_required` on builder steps stays correct.

**P8 — `approve-plan.ts:116–130` re-derives branch names.** It predicts
`buildd/{id8}-{title}` for a dependency's `baseBranch` — a hand-mirrored copy of the
claim route's generator that omits `useBuildBranch` **and the mission `headBranch`
override, so it already predicts a nonexistent branch for every mission task
today.** Under A′ the stacked-`baseBranch` mechanism can mostly go away; at minimum
this must read `workers.branch` / `missions.workingBranch` instead of re-deriving.

**P9 — the codebase-memory seed must become base-ref-aware.** Two pieces. First, fix
B15 — it is a live defect and it is also what makes today's fleet slow. Second, key
the seed record and `spawnCbmSeedRefresh` on `(repoPath, baseRef)`; both fields
already exist on the record and neither is read. Without this, A′ hands every mission
task a `dev`-based graph **with `skipBootstrapIndex: true`**
(`cbm-enforcement.ts:368–369`), so a task's `trace_path` returns the *pre-mission*
answer for precisely the code its siblings just changed — a confidently wrong graph
rather than a missing one, which is the worse failure. Refresh incrementally
(`detect_changes`) when a task PR merges into the integration branch; that merge
event already exists in the webhook path. Bound: one refresh in flight per
`(repoPath, baseRef)`, dropped rather than queued.

Argue the upside too: N tasks sharing one base is a strictly **better** cache unit
than N tasks each cut from `dev` — one index per integration-branch advance,
amortised across the mission, against one full index per task. The seed record's
`project` field already decouples the worker's worktree path from the path the graph
was indexed at, so the indirection this needs is built and proven.

### Invariants to promote into specs

1. **A release claim is two-phase.** `releaseAttemptedAt` is claimed; `releasedAt`
   is written only after a dispatch or merge returns success. A failure clears the
   attempt and posts a `missionNotes` row of type `decision`. **No automated release
   decision may terminate in `console.log` alone.**
2. **Every release decision has one gate.** The webhook path calls
   `canCompleteMission` exactly as `mission-release.ts` does (B3). One predicate,
   named callers.
3. **One classifier.** `taskClass` is the only answer to "what kind of row is this".
   The banned-predicate scan extends to `apps/web/src/lib/**` and covers the
   `=== null` form (B5, B6).
4. **The UI never displays a policy default the server does not use** (B4). The
   effective policy is resolved server-side and passed in; forms do not re-guess
   defaults.
5. **A mission whose deliverable work is complete and whose integration PR is
   unmerged contributes exactly 1 to `awaitingVerification`.** The surface-IA spec's
   §5.2 / AC-20 / AC-29 are *agreement* invariants and cannot catch a surface that
   agrees on `0` — which is exactly the failure the A audit found. This invariant is
   the missing one.
6. **Every PR carries a CI verdict.** A base ref that `build.yml` does not trigger
   on is not a legal target for an agent-opened PR (B17).

---

## Open questions

- **A′ vs B.** A′ is the recommendation, and B17 — the one thing that could have
  changed the answer — is now resolved and cheap (a one-line trigger widening). What
  remains is the doubled CI minutes and the P5 freshness cadence. If A′ is wrong, the
  failure mode is that mission branches rot and every mission ends in a conflict
  resolution; B's failure mode is that operators want one revertable mission diff and
  cannot get it. The first is recoverable per-mission; the second is permanent.
- **Does `shipped` require production, or is the `dev` merge enough?** Proposed:
  archetype decides — `gated` requires containment in a healthy `main` release,
  `continuous` requires the deploy, `none` renders no delivery step at all rather
  than a permanently amber one.
- **Which missions get an integration branch?** Finite, deliverable,
  single-workspace, terminating. Monitoring/heartbeat missions never complete, so
  their branch would never merge; workspace-less and cross-workspace missions cannot
  have one. Under A′ this is a *soft* choice — both shapes coexist without a
  discriminator column — but the organizer needs to know which it is planning for,
  which makes it a prompt question (P7) rather than a schema question.
- **Keep `primaryPrNumber`?** Under A′ it finally has a referent (the mission PR),
  provided P2 lands. Under B it has none.
- **Nav.** Releases as an Activity sub-tab (proposed) vs a sixth tab. The surface-IA
  invariant argues sub-tab; operator habit may argue otherwise.
- **B8.** Implement `tasks.mergePolicy` per the active spec, or retire the spec to
  `superseded`. It cannot stay `active` and unbuilt.

## Non-goals

- Rollback and revert mechanics; version bumping and changelog generation (the
  repo's own release workflow owns those, per `docs/specs/release-flow.md`).
- Multi-repo missions and cross-workspace release ordering.
- Replacing mission health or the initiative verdict. Ship state is a third
  dimension alongside them, not a merge of them.
- A human-declared delivery status. Same reasoning as surface-IA §6.5's non-goal: a
  claim nobody can audit is what the evidence line exists to prevent.
- Real-time release state. Refresh on navigation is sufficient.
- Reviving Option A. The evidence above is the record; reopening it needs new
  machinery, not a new argument.

## Implementation sketch

Three tracks. **They must not share a PR** — the fix-regardless track is true today
and should not wait on a branch-model decision, and the arc track should not carry
unrelated bug risk.

**Track 1 — fix regardless of the decision. SHIPPED (2026-09-04),** on branch
`fix/mission-delivery-arc`, in three commits. Every fix got a regression test
that was confirmed to fail before the fix — not merely to pass after it.

| Item | Outcome |
|---|---|
| **B1 + B3** | Fixed. Two-phase claim (`releaseAttemptedAt` → `releasedAt`), one completion gate on both paths, a `decision` note on every failure. New nullable column + migration. |
| **B5 + B6** | Fixed. `attempts7d` reads `taskClass`; the gate now scans `apps/web/src/lib/**` and matches both null-comparison directions. Widening it surfaced a third live violation in `task-dependencies.ts`. |
| **B11** | Fixed (second half). `releases` rows are now written for `gated`, so `release_tasks` edges exist. The attribution half was already fixed on `dev`. |
| **B12, B13, B14, B16, B4** | Fixed. |
| **B8** | Resolved as `draft`, not superseded — see the finding. |
| **B17** | Doc half fixed. The CI trigger widening belongs to Track 2. |
| **B10** | Already fixed on `dev`; the doc now records the residual worktree-path collision instead. |
| **B15** | **Not done.** Seed admission is a deploy/runtime fact this branch cannot verify or test. Still owed, and still what makes today's fleet slow. |
| **U11** | Already fixed on `dev` — the raw enums are gone from that page. |

Two gaps the work opened rather than closed, both recorded here so they are not
lost:

- **Nothing promotes a release to `healthy`.** `verifyReleaseDeployment`
  (`release-verification.ts`) is the only writer of `state: 'healthy'` and has
  **zero callers**; the health-check cron only *degrades* rows already marked
  healthy (`eq(releases.state, 'healthy')`). So `MAX(healthy_at)` is NULL for
  every archetype, and `MissionShipState`'s `shipped` has nothing to read. The
  baseline ladder hides this by degrading to `deployedAt`, which is why it went
  unnoticed. **This gates Track 3 step 1** and wants a policy decision: promote
  on deploy success, or require the `verificationUrl` probe.
- **`build.yml`'s own comment is false.** It justifies skipping release PRs with
  "dev already ran full integration before the promotion", but `changes` is gated
  on `base_ref == 'main'`, so `dev` never runs integration at all — meaning
  integration and E2E never gate a dev→main promotion.

**Track 2 — A′ itself,** in dependency order: B17's CI widening → P2 → P1 → P3 →
P7/P8 → P4 → P9 → P5. The first mission opted in behind a flag, one mission at a
time.

**Track 3 — the frontend arc,** which mostly does not depend on Track 2 landing:

1. **`deriveMissionShipState` + loader**, unit-tested against the five states before
   anything renders it. Rename health `'shipped'` → `'closed'` in the same change.
2. **Mission detail Delivery block** + ship-state chip on the card from the same
   loader (U1, U3's missing verb, U4).
3. **`deriveTaskOrigin`** + Origin row + attempt strip + `Shipped in` link (U6, U7,
   U8), retiring `deriveTaskType` from classification duty.
4. **`/app/releases` index** + Activity sub-tab (U2).
5. **`NewMissionForm` criteria step** (U5).
6. **Surface-IA §5 + dead-path deletion** (U9), and a subscriber for
   `mission:completion_decision` (U10). **Do the `initiativeGroups` deletion before
   any A′ edit to `MissionGrid.tsx`**, or the two collide.

**Spec follow-ups this schedules.** `docs/SPEC.md:79` and
`docs/specs/mission-task-lifecycle.md:264–267` are rewritten to describe A′
precisely — task PRs target the integration branch, the mission PR is the single
gate. `docs/specs/surface-ia-home-missions-initiatives.md` §6.1 field definitions
survive A′ unchanged (per-task PRs still exist); add invariant 5 above. Consider
whether the gate inventory needs an `integration_branch_busy` reason — probably not
under A′, since task PRs serialize normally, and `unmerged_dep_pr` keeps its current
meaning. After touching anything in `docs/specs/`, run `bun run specs:check`.
