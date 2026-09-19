---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# auto-merge-safety, green-ci-policy and migration-journal-guard all genuinely
# shipped (Candidates 2 and 4 below) but the doc must stay 'partially' until
# merge-order-edges' mergeAfter (Candidate 3) ships too, so those three would
# be reclassified code_ahead and redispatched forever under a non-terminal
# status. Suppressed below (skip_until) rather than left to redispatch.
assertions:
  - id: "auto-merge-safety"
    type: "symbol"
    name: "evaluateAutoMergeSafety"
    path: "apps/web/src/lib/auto-merge.ts"
    skip_until: "2026-12-19"
    skip_reason: "evaluateAutoMergeSafety genuinely shipped (Candidate 2, §Shipped note) — this isn't a false positive — but the doc must stay 'partially' until merge-order-edges (Candidate 3's mergeAfter) ships, so this assertion will pass forever under a non-terminal status. merge-order-edges is the assertion that tracks real remaining progress."
  - id: "green-ci-policy"
    type: "config_key"
    key: "enforceGreenCI"
    file: "packages/core/db/schema.ts"
    skip_until: "2026-12-19"
    skip_reason: "enforceGreenCI genuinely shipped (Candidate 2, §Shipped note) — this isn't a false positive — but the doc must stay 'partially' until merge-order-edges (Candidate 3's mergeAfter) ships, so this assertion will pass forever under a non-terminal status. merge-order-edges is the assertion that tracks real remaining progress."
  - id: "merge-order-edges"
    type: "config_key"
    key: "mergeAfter"
    file: "packages/shared/src/types.ts"
  - id: "migration-journal-guard"
    type: "test_file"
    path: "packages/core/__tests__/migration-journal-ordering.test.ts"
    skip_until: "2026-12-19"
    skip_reason: "migration-journal-ordering.test.ts genuinely covers the shipped Candidate 4 substitute (the CI-script guard, §Shipped note) — this isn't a false positive — but the doc must stay 'partially' until merge-order-edges (Candidate 3's mergeAfter) ships, so this assertion will pass forever under a non-terminal status. merge-order-edges is the assertion that tracks real remaining progress."
---
# Convergence Layer: Audit and Spec

**Status:** Partially Implemented — Candidates 1, 2 and 5 shipped (5 with a
materially different design than proposed here); Candidate 4 was correctly
skipped, as recommended. Candidate 3 (`mergeAfter`) did **not** ship as
specified — the problem it targeted was instead addressed by a softer,
warn-only mechanism. See the per-candidate "Shipped" notes in Phase 2 below.
**Related:**
`apps/web/src/app/api/tasks/route.ts`,
`apps/web/src/app/api/workers/claim/route.ts`,
`apps/web/src/app/api/workers/[id]/route.ts`,
`apps/web/src/app/api/github/webhook/route.ts`,
`apps/web/src/app/api/github/webhook/dark-check-detection.ts`,
`apps/web/src/lib/auto-merge.ts`,
`apps/web/src/lib/change-intent.ts`,
`apps/web/src/lib/loop-dispatcher.ts`,
`packages/core/path-overlap.ts`,
`packages/core/mcp-tools.ts`,
`packages/core/loop-config.ts`,
`apps/runner/src/runner-verification.ts`,
`docs/design/loop-until-verified.md`,
`docs/design/worker-pr-automerge.md`,
`docs/design/change-intent.md`

---

## Problem

Four parallel workers each produced a migration numbered `0022_*.sql`. Those
branches merged with zero git conflicts — each file had a distinct name, each
journal entry was an additive append. The collision detonated only at migrate
time. Separately: a task marked itself SUCCESS with the summary "PR #136 is
open" — the PR was open, unmergeable, and had two required checks red. And a
downstream task's PR merged ahead of the upstream PR it depended on, because
`dependsOn` gates claiming, not merging.

None of these are agent misbehaviour. All three are structural gaps in what the
platform can see or enforce.

---

## Phase 1 — Audit

### 1. pathManifest serialization

**What it locks on.** `pathsOverlap` in `packages/core/path-overlap.ts`
performs two comparisons: exact file-path equality and directory-prefix
matching (one path is a prefix of the other plus `/`). Glob patterns are
compared as literal strings — not evaluated.

**When it runs.** At create time (`apps/web/src/app/api/tasks/route.ts`
lines 418–436): queries all `pending | assigned | in_progress` tasks with a
non-null `pathManifest`, finds overlaps, and injects those task IDs into
`resolvedDependsOn`. At claim time (`apps/web/src/app/api/workers/claim/route.ts`
lines 820–939): a secondary backstop; calls `findBlockingPr`, defers the claim
without permanently blocking if an open-PR task overlaps.

**Why it failed for migration 0022.** The contested resource was the integer
index namespace inside `drizzle/meta/_journal.json`. Four agents each
independently read the journal, saw `0021` as the max, and wrote
`0022_<distinct_name>.sql` — distinct filenames, additive journal entries. From
`pathsOverlap`'s perspective there is zero overlap: the migration SQL files
have different names, and `_journal.json` itself is not typically listed in the
tasks' pathManifests (organizers list the schema file or the migration SQL
glob, not the journal). The conflict is in an integer namespace that git cannot
model and that pathManifest, as an identity-based mechanism, cannot see.

### 2. Task status determination

**The path.** An agent calls the `complete_task` MCP action →
`packages/core/mcp-tools.ts` line 1040 PATCHes `/api/workers/{id}` with
`{ status: 'completed', summary: '...agent text...' }` → the worker PATCH
handler (`apps/web/src/app/api/workers/[id]/route.ts` lines 1134–1223)
stores `task.result.summary = body.summary` and atomically sets
`tasks.status = 'completed'`.

**What is NOT checked.** There is no CI check on the agent's own PR before
this transition. The `outputRequirement = 'pr_required'` gate (lines 436–475)
verifies that `worker.prUrl` exists — it does not inspect whether the PR is
mergeable or whether CI is green. The agent's prose summary becomes task state
verbatim. An agent that writes "PR #136 is open" in its summary and calls
`complete_task` transitions the task to `completed` regardless of PR
mergeability or CI conclusion.

The only paths that check CI externally are: (a) `executeRelease()`, which runs
post-completion only for workspaces with a release configuration; and (b) the
`pr_checks_green` loop exit condition, which reads webhook-persisted
`prLifecycleStatus` — but this condition is opt-in via `loopConfig` and is
not applied to ordinary tasks.

### 3. verificationCommand and loopUntilVerified

**What `loopUntilVerified` does.** It is syntactic sugar for
`loopConfig = { exitCondition: { type: 'command' }, command: verificationCommand }`.
The runner executes the command as a local shell process in the task worktree
after the agent finishes (`apps/runner/src/runner-verification.ts:94–165`,
`child_process.exec`, 60 s timeout). Exit code 0 = satisfied; any other code
requeues the task. This is a local check only — it cannot observe CI.

**`pr_checks_green`.** A different exit condition type already exists:
`{ type: 'pr_checks_green' }`. Evaluated in
`apps/web/src/lib/loop-dispatcher.ts:99–115` — it reads
`workers.prLifecycleStatus` from the DB (populated by `check_suite.completed`
webhook events) and is satisfied when `prLifecycleStatus === 'ci_green'` or
`'merged'`. No polling. No runner execution. This is an external-state check
driven entirely by GitHub webhooks.

**Extension verdict.** Extending the loop mechanism to cover external state is
a natural extension of the existing `pr_checks_green` path — the subsystem
already exists and is driven by the correct event source. It is not a different
subsystem.

### 4. dependsOn semantics

**What it gates.** Two points: (a) claim eligibility — the claim route
(`apps/web/src/app/api/workers/claim/route.ts` lines 248–270) requires all
`dependsOn` task IDs to have `status = 'completed'` AND their latest worker's
`mergedAt IS NOT NULL`; and (b) dispatch — `checkDependsOnResolved` fires a
`TASK_UNBLOCKED` event and dispatches the downstream task when all deps satisfy
the above.

**What it does NOT gate.** Auto-merge. Once a dependent worker has claimed its
task and opened a PR, nothing in the `check_suite.completed` → `tryAutoMergeWorkerPr`
path inspects whether the dependency's PR has merged. In the incident: task B
(`dependsOn` task A) claimed correctly — A was complete and its PR was merged.
But a different instance of the pattern occurred: migration tasks with no
`dependsOn` relationship ran fully in parallel and merged in the order their
CI finished, not the order their indices required.

### 5. GitHub check-run / deployment_status ingestion

The webhook handler at `apps/web/src/app/api/github/webhook/route.ts` handles
these event types:

| Event | Handled? | What it does |
|---|---|---|
| `check_suite.requested / rerequested` | Yes | Sets `prLifecycleStatus = 'ci_running'` |
| `check_suite.completed` (success) | Yes | Verifies all suites passed, calls `tryAutoMergeWorkerPr`, updates `prLifecycleStatus = 'ci_green'` |
| `check_suite.completed` (failure) | Yes | Sets `prLifecycleStatus = 'ci_failed'`, creates CI retry tasks |
| `check_suite.completed` (other) | No | Returns immediately; `skipped` / `neutral` conclusions are not handled |
| `check_run` | **No** | Not wired |
| `deployment_status` | **No** | Not wired |
| `pull_request` (opened / synchronize) | Yes | Updates lifecycle status, dispatches reviewer |
| `pull_request` (closed / merged) | Yes | Stamps `mergedAt`, unblocks dependents |
| `workflow_run` | Yes | Reads back release workflow outcomes |

The existing `check_suite` path is the correct extension point for merge-order
gating and dark-check detection. `check_run` and `deployment_status` are not
wired and their absence is not load-bearing for any current feature.

### 6. autoMergePR with red or unreported checks

The merge path is: `check_suite.completed (success)` → `allCheckSuitesPassed`
→ `tryAutoMergeWorkerPr` → `evaluateAutoMergeSafety` → `mergePullRequest`.

**Red CI:** Blocked. `evaluateAutoMergeSafety` (`apps/web/src/lib/auto-merge.ts`
lines 31–47) calls `GET /repos/{repo}/commits/{sha}/check-runs` and blocks if
any run has `status = in_progress | queued` or `conclusion = failure`.

**Skipped checks:** Not blocked. `allCheckSuitesPassed` (`apps/web/src/lib/github.ts`
lines 288–292) accepts `conclusion = 'skipped' | 'neutral'` as passing.
`evaluateAutoMergeSafety` only blocks on `conclusion = 'failure'`; a skipped
run has no such conclusion. A check that is consistently Skipped is
indistinguishable from a check that is green.

**Checks that never triggered:** Not detected. If a required check is
configured in GitHub branch protection but never triggered on a PR (no
matching event, no path filter match), it does not appear in the check-runs
list. Neither `allCheckSuitesPassed` nor `evaluateAutoMergeSafety` consults
GitHub's branch protection rules (`GET /repos/{repo}/branches/{branch}/protection`
is never called). The `missingChecks` logic in `evaluateAutoMergeSafety`
(lines 50–58) only emits a `console.warn` — it does not block the merge.

**Default setting:** `autoMergeOnGreenCI` defaults to `true` (opt-out).
The buildd workspace's current value is `gitConfig.autoMergeOnGreenCI ??
gitConfig.autoMergePR ?? true`.

**Since shipped:** `evaluateAutoMergeSafety` now takes a `MergePolicy`
(`packages/shared/src/types.ts`), not a raw `gitConfig` read — `WorkspaceGitConfig.mergePolicy`
supersedes the `autoMergeOnGreenCI`/`autoMergePR` pair when set, with the pair kept only
as the legacy fallback for workspaces that have not configured `mergePolicy`. The tier
(`auto-threshold` / `agent-review` / `human`) drives merge behaviour where this section
still describes a flat CI-green boolean.

---

## Phase 2 — Spec

The incident is an instance of the platform treating agent-authored prose as
external truth, treating file identity as the only contested resource, and
having no merge queue. Each of the five candidate improvements is evaluated
below with a BUILD or SKIP verdict.

---

### Candidate 1 — Sequence claims

**Mechanism proposed.** Workspace declares an append-only monotonic namespace
(a directory + anchor file). At claim time, the platform atomically reads the
anchor file, determines the next available index, and leases it to the claiming
worker. Concurrent claimants get distinct indices instead of the same one.

**Generality pressure test.**

| Framework | Index style | Collision class exists? |
|---|---|---|
| Drizzle | Sequential integer (`0022_*.sql` + `_journal.json`) | Yes |
| Prisma | Timestamp directory (`20231201143500_name/`) | No — timestamps diverge if workers run at different times; collision is astronomically unlikely |
| Alembic | Random hash revision ID | No |
| Rails | Timestamp integer (`20231201143500_name.rb`) | No — same as Prisma |
| Changesets | Random per-change ID | No |
| ADR numbering | Sequential integer (`0042-decision.md`) | Yes — lower stakes, no migration to apply |
| Protobuf field numbers | Per-message integers, no global index | No |

The collision class exists only for sequential-integer-indexed namespaces: Drizzle
migrations and ADR numbering. Everything else is timestamp- or hash-based and
does not collide. The "sequence claim" primitive as a general framework-agnostic
abstraction collapses to a Drizzle-specific lease.

**The pathManifest fix.** The simplest resolution to the Drizzle case is to
require that all tasks touching a declared migrations directory include the
journal file (`drizzle/meta/_journal.json`) in their pathManifest. The existing
overlap detection then serializes migration tasks automatically — no new
primitive required. This does not involve a lease; it prevents parallel
execution of migration tasks entirely, which is the correct behaviour for
schema changes anyway.

The problem with relying on doctrine alone: organizers must know to include the
journal file. They routinely omit it. A workspace-level declaration that
identifies "anchor files" for a directory (files that must always be co-locked
when any file in the directory is declared) would make the doctrine automatic.

**Data model.** Add `sequenceNamespaces?: Array<{ dir: string; anchorFile: string }>`
to `WorkspaceGitConfig`. Example: `[{ dir: "packages/core/drizzle", anchorFile: "drizzle/meta/_journal.json" }]`. At task creation time, when pathManifest includes any file under `dir`, automatically add `anchorFile` to the effective pathManifest before the overlap check. No new table. No claim-time lease. The existing overlap mechanism handles serialization.

**Customer-facing surface.** Workspace settings UI: a "Sequential namespaces"
section under Git config. MCP `manage_workspaces` action=update accepts
`gitConfig.sequenceNamespaces`.

**Value:** HIGH — migration index collisions are recurrent (memory entries
document three incidents). The fix prevents the class of collision permanently
for any workspace that declares the namespace.

**Effort:** LOW — one config field added to `WorkspaceGitConfig`, one loop in
the task creation route that appends anchor files to pathManifest before the
overlap check. No schema migration required (JSONB). Two days.

**Recommendation: BUILD.** Scoped to workspace-declared sequential namespaces
(not a general sequence-claim primitive). The Drizzle migration case justifies
it; the other frameworks do not.

**Shipped.** `sequenceNamespaces` lives on `WorkspaceGitConfig`
(`packages/core/db/schema.ts`), matching the proposed shape exactly. Anchor
injection is `resolveAnchorInjections` in `apps/web/src/lib/change-intent.ts`,
consumed at task-creation time in `apps/web/src/app/api/tasks/route.ts`. See
`docs/design/change-intent.md`.

---

### Candidate 2 — External-truth completion gate

**Mechanism proposed.** A task cannot transition to `completed` on agent
narrative alone when an output requirement involves a PR. Gate on PR
mergeability and required-check conclusions.

**What already exists.** The `pr_checks_green` loop exit condition
(`apps/web/src/lib/loop-dispatcher.ts:99–115`) already implements this for
looped tasks. It reads `prLifecycleStatus` from the DB (set by the webhook),
checks `ci_green` or `merged`, and requeues the task if CI hasn't passed. The
design is sound (`docs/design/loop-until-verified.md`).

**The gap.** Two problems:
1. `pr_checks_green` is opt-in. Ordinary `pr_required` tasks never set a `loopConfig`.
2. `pr_checks_green` reads `prLifecycleStatus` but does not check `mergeable_state`. A
   PR can be `ci_green` and still unmergeable due to a conflict with a recently-merged
   sibling. The `evaluateAutoMergeSafety` function in `auto-merge.ts` checks CI run
   conclusions but not `mergeable_state` (gap G1 in `docs/design/worker-pr-automerge.md`).

**Proposed mechanism.** Two changes:

(a) Add `enforceGreenCI?: boolean` to `WorkspaceGitConfig` (default `false`). When
set, the task creation route implicitly adds `loopConfig = { exitCondition: { type:
'pr_checks_green' }, maxLoops: 3 }` to every task with `outputRequirement =
'pr_required'`, unless the task already declares a `loopConfig`. The agent's
`complete_task` call then triggers a condition evaluation; if CI is not green, the
task requeues rather than completing. No new routes; existing loop machinery handles
it.

(b) Add `mergeable_state` check to `evaluateAutoMergeSafety` before the merge
attempt: call `GET /repos/{repo}/pulls/{prNumber}`, inspect `mergeable_state`.
Return `ok: false` with a retryable reason on `dirty` or `blocked` (as already
proposed in `docs/design/worker-pr-automerge.md` spec section S1). The `ci_green`
webhook already sets a prerequisite; this adds the conflict check in the merge
path, not in the loop evaluation.

**Customer-facing surface.** Workspace settings UI: "Require green CI before
task completion" toggle under Git config. MCP `manage_workspaces` accepts
`gitConfig.enforceGreenCI`.

**Value:** HIGH — directly fixes the "SUCCESS on bad PR" class of incident. An
agent that calls `complete_task` with a red or conflicted PR will be requeued
rather than landing as completed.

**Effort:** LOW — `enforceGreenCI` is a config field + one conditional in the
task creation route. The loop machinery is already in place. The `mergeable_state`
check in `evaluateAutoMergeSafety` is a one-line addition. Two to three days total.

**Recommendation: BUILD.** The mechanism exists. This is a policy knob and one
targeted extension to the auto-merge safety check.

**Shipped, with one path correction.** `enforceGreenCI` lives on
`WorkspaceGitConfig` in `packages/core/db/schema.ts` — not
`packages/shared/src/types.ts`, where `WorkspaceGitConfig`'s sibling type
`MergePolicy` lives instead. The loop-injection logic is in
`apps/web/src/app/api/tasks/route.ts` (`enforceGreenCI === true` implies the
`pr_checks_green` loop), matching the proposal. The `mergeable_state` check
also shipped: `evaluateAutoMergeSafety` in `apps/web/src/lib/auto-merge.ts`
reads `mergeable_state` from `GET /repos/{repo}/pulls/{prNumber}` and blocks
on `dirty` or `blocked`, then dispatches a same-branch conflict-retry task
rather than just surfacing the block to a human.

---

### Candidate 3 — Merge-order edges

**Mechanism proposed.** A `mergeAfter` relation distinct from `dependsOn`, so
ordering is enforced in the merge queue rather than at dispatch.

**Why `dependsOn` is insufficient for this.** `dependsOn` gates claiming: the
downstream task cannot start until the upstream task is complete and its PR is
merged. This prevents B from starting before A is done. But if A and B are
independent tasks that happen to produce artefacts requiring ordered application
(two Drizzle migrations), there is no existing mechanism to prevent B's PR from
merging before A's PR. They run in parallel, both create PRs, both get CI green,
and the `check_suite.completed` handler merges whichever PR's CI finishes first.

**Data model.** Add `mergeAfter?: string[]` (task IDs) to `tasks.context` as a
JSONB field — no schema migration required. Alternatively, a DB column
`tasks.merge_after text[]` gives index support for the webhook lookup.

**Mechanism.** In `handleCheckSuiteEvent`, after `allCheckSuitesPassed` and
before the `requiresReview` gate, add:

```ts
if (task.context?.mergeAfter?.length) {
  const depWorkers = await db.query.workers.findMany({
    where: and(
      inArray(workers.taskId, task.context.mergeAfter),
      isNull(workers.mergedAt),
    ),
    columns: { id: true, taskId: true, mergedAt: true },
  });
  const unmerged = depWorkers.filter(w => !w.mergedAt);
  if (unmerged.length > 0) {
    // Defer. When dep merges, pull_request.closed fires → stamps mergedAt → 
    // TASK_UNBLOCKED dispatch causes re-evaluation via checkMergeAfterResolved.
    return;
  }
}
```

When the dependency PR merges (`pull_request.closed` handler already stamps
`mergedAt`), add a call analogous to `checkDependsOnResolved` to retry any tasks
whose `mergeAfter` is now fully satisfied.

**MCP surface.** `create_task` accepts `mergeAfter?: string[]` — a list of task
IDs whose PRs must be merged before this task's PR is auto-merged. Distinct from
`dependsOn` (which gates work, not merge).

**Value:** MEDIUM — the incident involved no `dependsOn` at all between migration
tasks. For customers who want parallel work with ordered merging, `mergeAfter` is
the right primitive. For DB-schema repos specifically, the combination of
sequence-namespace anchoring (candidate 1) and `mergeAfter` gives a complete
solution: serialized work via pathManifest + ordered merge via `mergeAfter`.

**Effort:** LOW — one field in task context, one check in the webhook handler, one
new `checkMergeAfterResolved` call in the PR-merged path. Two days.

**Recommendation: BUILD.** Small, targeted, self-contained. Adds a guarantee
that `dependsOn` does not provide and that generalizes beyond migrations to any
scenario where parallel work must converge in order.

**Not shipped as specified.** There is no `mergeAfter` field anywhere in the
codebase, and nothing in `handleCheckSuiteEvent` defers a merge pending a
sibling PR. What shipped instead, in `docs/design/change-intent.md`, is
`WorkspaceGitConfig.conflictSurfaces` + the `changeIntents` table
(`packages/core/db/schema.ts`): when a PR touches a declared surface,
`apps/web/src/lib/change-intent.ts` posts a warning note on every other
open-PR task touching the same surface. That closes the *visibility* gap this
candidate identified — but it is warn-and-guide, not a gate. Nothing stops
either PR's auto-merge, and out-of-order merges are still possible; an agent
has to act on the warning. The hard merge-order gate this candidate argued for
remains unbuilt.

---

### Candidate 4 — Schema drift verification

**Mechanism proposed.** A mountable skill for workspaces declaring a migrations
directory: apply all migrations from zero against an ephemeral DB, introspect
the resulting schema, diff against the ORM schema definition. Catches drift,
duplicate/gapped indices, and non-idempotent migrations.

**Why not a platform primitive.**

1. **Framework specificity.** Applying migrations from zero requires invoking
   the framework's migration runner (Drizzle `db:migrate`, Prisma `migrate deploy`,
   Alembic `upgrade head`, Rails `db:migrate`). Introspecting the result requires
   framework-specific tooling. A "mountable skill" would in practice be four
   separate implementations.

2. **Infra requirements.** An ephemeral database must be provisioned (Neon
   branch, local Docker, SQLite shim). This is a CI concern — runners already run
   in isolated worktrees, and adding DB provisioning adds complexity and cost to
   every agent session.

3. **Already documentable.** `docs/design/migration-doctrine.md` describes this
   as a best practice. The regression guard at
   `packages/core/__tests__/migration-journal-ordering.test.ts` is the correct
   implementation for the Drizzle case — a test that runs in CI and fails on
   journal ordering violations. Extending that pattern to each workspace's CI
   is documentation work, not platform work.

4. **Dark-check detection (candidate 5) is the platform's role here.** If the
   migration drift test is not running — because the check is skipped, the CI
   config is missing, or the workspace never set it up — the platform should
   surface that gap. Schema drift is what the check prevents; the platform's job
   is to ensure the check runs, not to re-implement it.

**Value:** MEDIUM in theory; LOW in practice because the correct implementation
is a CI script per workspace, not a platform feature.

**Effort:** HIGH — multi-framework, DB provisioning, schema introspection logic
that must be maintained as frameworks evolve.

**Recommendation: SKIP.** This is a CI script concern. The platform's contribution
is dark-check detection (candidate 5), which surfaces when migration tests are not
running.

**Confirmed skipped, as recommended.** No platform-level migration-drift
runner exists. `packages/core/__tests__/migration-journal-ordering.test.ts` is
the CI-script guard this section anticipated.

---

### Candidate 5 — Dark-check detection

**Mechanism proposed.** Platform-level health signal when a required check has
not reported a non-skipped conclusion across N consecutive agent PRs in a workspace.

**Why the platform and not the agent.** No individual agent can observe this
pattern. Each agent sees only its own PR's check results at the time it
completes. The workspace-level pattern ("this check has been Skipped on
every PR for two months") is only visible to a component that aggregates across
PRs. That component is the webhook handler.

**What "Skipped" means.** GitHub `conclusion = 'skipped'` is emitted when a
check's conditions are not met (path filter, branch filter, workflow trigger
condition). It is not a failure. `evaluateAutoMergeSafety` and
`allCheckSuitesPassed` both pass on `skipped`. A workspace where required checks
are consistently skipped is merging without real CI verification — silently.

**Data model.** Add `checkHealthLog?: Record<string, number>` to
`WorkspaceGitConfig` (JSONB). Keys are check names (e.g. `"build"`, `"typecheck"`);
values are the count of consecutive completed suites where that check was
`skipped` or absent. Reset to 0 when the check reports `success` or `failure`.

In `handleCheckSuiteEvent` on `conclusion = 'success'`, after calling the
GitHub check-runs API (already done in `evaluateAutoMergeSafety`), tally
`skipped` conclusions per check name against a workspace-scoped counter. When
any check's count exceeds the threshold (default: 5 consecutive PRs), emit a
workspace health event and a Pushover notification:

> **Dark check detected**: `build` has been Skipped on the last 5 agent PRs
> in workspace `sibling-app`. If this is a required check, your CI is not
> running. Check the workflow trigger conditions.

**Threshold.** 5 consecutive PRs before alerting. Configurable per workspace
via `WorkspaceGitConfig.darkCheckThreshold` (default 5, minimum 3).

**Customer-facing surface.** Workspace health dashboard section (new
"Check health" panel). Pushover alert (non-urgent, priority 0). MCP
`manage_workspaces` action=get returns current `checkHealthLog`.

**Value:** HIGH — directly addresses the "two required checks silently Skipped
for months" failure. Any workspace where CI is misconfigured gets an alert
within 5 merged PRs instead of staying silently broken indefinitely.

**Effort:** MEDIUM — the data is already in the `check_suite.completed` payload
plus the check-runs API call already made in `evaluateAutoMergeSafety`. Adding
the counter update and threshold alert is ~3 days. The dashboard panel adds
1–2 days. Total: one week.

**Recommendation: BUILD.** The signal is platform-unique (no agent can see it),
the data is already available, and the failure mode is silent and long-lived.

**Shipped, with a better design than proposed.** The mechanism lives in
`apps/web/src/app/api/github/webhook/dark-check-detection.ts`
(`detectDarkChecksForClosedPr`, called from the `pull_request` closed/merged
handler in `route.ts` — not from `check_suite.completed` as sketched here).
Two differences from the proposal, both improvements:
- Counters are a dedicated `darkCheckAlerts` table (`packages/core/db/schema.ts`),
  not a `checkHealthLog` JSONB blob on `WorkspaceGitConfig`.
- Before counting a check as dark, it calls
  `GET /repos/{repo}/branches/{branch}/protection` to fetch the checks the
  *base branch itself* requires, and only tallies skips against that set. That
  closes the exact gap Phase 1 §6 of this document flagged in
  `evaluateAutoMergeSafety`/`allCheckSuitesPassed`: neither of those ever
  consulted branch protection, so the doc's own audit under-scoped what
  candidate 5 needed to check. The threshold (default 5, matching this
  proposal) is a hardcoded constant, not the configurable
  `darkCheckThreshold` gitConfig field this section proposed.

---

## The mega-branch question

An agent asked to "unblock four PRs" collapsed them into one unbisectable
mega-branch, cherry-picking all four into a single PR rather than handling each
separately.

**Is there a platform-level detection?**

Weak signals exist: a PR that touches files across many unrelated pathManifest
domains, or a branch with many merge commits from other branches. But these
signals are noisy — integration PRs and release PRs legitimately combine
changes. Distinguishing a legitimate integration from an agent collapsing
four separate concerns into one PR requires semantic scope analysis that the
platform cannot do reliably.

**Verdict: prompting concern, not a platform feature.** Role prompts should
include explicit doctrine: "one task, one PR, one coherent concern — do not
combine sibling tasks into a single branch." The mission organizer should
create separate tasks with appropriate `dependsOn` and `mergeAfter` edges
rather than a single unblocking task.

The platform can reinforce this with `pathManifest` overlap detection (which
serializes but does not merge concerns) and with `mergeAfter` edges that
maintain ordering without collapsing parallelism. But the collapse itself is
an agent decision that prompting must address.

---

## Summary of recommendations

| # | Candidate | Verdict | Effort | Rationale | Shipped? |
|---|---|---|---|---|---|
| 1 | Sequence claims | **BUILD** (as manifest auto-anchoring) | LOW (2 days) | Direct fix for migration index collision; generalizes to any workspace with sequential namespaces | Yes, as specified |
| 2 | External-truth completion gate | **BUILD** | LOW (2–3 days) | Most direct fix for "SUCCESS on bad PR"; mechanism already exists, this is a policy knob | Yes, as specified (path corrected above) |
| 3 | Merge-order edges | **BUILD** | LOW (2 days) | Fills the gap between `dependsOn` (gates claiming) and ordering at merge time | No — a warn-only substitute shipped instead; see above |
| 4 | Schema drift verification | **SKIP** | HIGH | CI script per workspace, not platform primitive; framework-specific; maintenance burden | N/A — confirmed still skipped |
| 5 | Dark-check detection | **BUILD** | MEDIUM (1 week) | Platform-unique signal; silently broken CI is undetectable any other way | Yes, with a better design than proposed |

---

## Filing-ready follow-up tasks

All four tasks below were filed and executed (Task 2's literal `mergeAfter`
design was superseded mid-build by the `conflictSurfaces` warning mechanism —
see Candidate 3's "Shipped" note above). Kept here for historical reference;
the per-candidate notes above and `docs/design/change-intent.md` describe what
actually landed.

Tasks listed smallest-valuable-slice first. Each is independent; each should
be filed with `outputRequirement=pr_required` and a `pathManifest` covering the
files it touches.

### Task 1 — External-truth completion gate
**Title:** `feat: enforceGreenCI workspace config + mergeable_state check in auto-merge`

**Description:**
Add `enforceGreenCI?: boolean` to `WorkspaceGitConfig`. When set, the task
creation route implicitly adds `loopConfig = { exitCondition: { type: 'pr_checks_green' }, maxLoops: 3 }` to any task with `outputRequirement = 'pr_required'` that does not already declare a `loopConfig`. No new routes; loop machinery is in place.

Also add `mergeable_state` check to `evaluateAutoMergeSafety` before calling
`mergePullRequest`: fetch PR state, return `ok: false` on `dirty` or `blocked`
(as specified in `docs/design/worker-pr-automerge.md` spec section S1).

Expose via workspace settings UI toggle ("Require green CI before task
completion") and `manage_workspaces` gitConfig update.

**pathManifest:**
```json
[
  "apps/web/src/app/api/tasks/route.ts",
  "apps/web/src/lib/auto-merge.ts",
  "packages/shared/src/types.ts",
  "apps/web/src/app/app/(protected)/settings/page.tsx"
]
```

---

### Task 2 — Merge-order edges
**Title:** `feat: mergeAfter task field — gate auto-merge on dependency PR landing`

**Description:**
Add `mergeAfter?: string[]` to task context schema. In `handleCheckSuiteEvent`,
after `allCheckSuitesPassed`, check that all tasks listed in
`task.context.mergeAfter` have their latest worker's `mergedAt IS NOT NULL`;
defer the merge if not. Add a `checkMergeAfterResolved` call in the
`pull_request.closed` webhook path (analogous to `checkDependsOnResolved`) to
re-evaluate pending tasks when a dependency merges.

Expose `mergeAfter` as a `create_task` MCP parameter. Document the distinction
from `dependsOn`.

**pathManifest:**
```json
[
  "apps/web/src/app/api/github/webhook/route.ts",
  "packages/core/mcp-tools.ts",
  "packages/shared/src/types.ts"
]
```

---

### Task 3 — Manifest auto-anchoring for sequential namespaces
**Title:** `feat: sequenceNamespaces workspace config — auto-add anchor files to pathManifest`

**Description:**
Add `sequenceNamespaces?: Array<{ dir: string; anchorFile: string }>` to
`WorkspaceGitConfig`. In the task creation route, after pathManifest is
validated, iterate `sequenceNamespaces`: if any declared file in pathManifest
is under `dir`, append `anchorFile` to the effective pathManifest before the
overlap check. This causes all tasks touching the declared directory to
serialize on the anchor file.

Expose via workspace settings UI ("Sequential namespaces" section) and
`manage_workspaces` gitConfig update. Document the Drizzle use case:
`{ dir: "packages/core/drizzle", anchorFile: "packages/core/drizzle/meta/_journal.json" }`.

**pathManifest:**
```json
[
  "apps/web/src/app/api/tasks/route.ts",
  "packages/shared/src/types.ts",
  "apps/web/src/app/app/(protected)/settings/page.tsx"
]
```

---

### Task 4 — Dark-check detection
**Title:** `feat: dark-check detection — alert when a named check is consistently Skipped across agent PRs`

**Description:**
In `handleCheckSuiteEvent` on `conclusion = success`, after the check-runs API
call made in `evaluateAutoMergeSafety`, tally `skipped` and absent conclusions
per check name into `workspace.gitConfig.checkHealthLog` (a running counter per
check name, reset to 0 on `success` or `failure`). When any check's count
reaches `workspace.gitConfig.darkCheckThreshold` (default 5), emit a workspace
health event, post a mission note if `missionId` exists, and send a Pushover
alert (priority 0).

Add a "Check health" panel to the workspace settings/dashboard page showing the
current `checkHealthLog`. Expose `darkCheckThreshold` via `manage_workspaces`
gitConfig update.

**pathManifest:**
```json
[
  "apps/web/src/app/api/github/webhook/route.ts",
  "apps/web/src/lib/auto-merge.ts",
  "packages/shared/src/types.ts",
  "apps/web/src/app/app/(protected)/settings/page.tsx"
]
```

---

## Non-goals

- Schema drift verification as a platform primitive (CI script per workspace).
- Replacing `dependsOn` with `mergeAfter` — they serve different purposes.
- General sequence-claim leases (Prisma, Alembic, Rails migration timestamps
  are not sequential integers and do not have this collision class).
- Polling GitHub for CI status (webhooks are the fact producer; the `pr_checks_green`
  condition reads persisted state, not live GitHub API).
- Changing `dependsOn` semantics for non-migration tasks.
- Preventing the mega-branch pattern at the platform level (prompting concern).
