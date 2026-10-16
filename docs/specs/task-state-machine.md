---
title: Task and Worker State Machines
status: active
owner: max
last_verified: 2026-10-15
summary: Task and worker transitions MUST preserve output requirements, terminal-state guards and dependency resolution.
domain: tasks
surfaces: [apps/web/src/app/api/workers/[id]/route.ts, packages/core/db/schema.ts]
related: [claim-gate-legibility, mission-completion, organizer-context, mission-surface-audit]
verified_by: [apps/web/src/app/api/workers/[id]/route.test.ts, apps/web/src/lib/task-dependencies.test.ts]
assertions:
  - id: "local-strand"
    type: "symbol"
    name: "deriveLocalStrand"
    path: "apps/web/src/lib/local-strand.ts"
  - id: "local-strand-tests"
    type: "test_file"
    path: "apps/web/src/lib/local-strand.test.ts"
  - id: guard-1
    type: test_file
    path: apps/web/src/app/api/workers/[id]/route.test.ts
  - id: guard-2
    type: test_file
    path: apps/web/src/lib/task-dependencies.test.ts
---
# Task and Worker State Machines

**Capability statement**: Task and worker transitions MUST preserve output requirements, terminal-state guards and dependency resolution.

## Task State Machine

**States**: `pending` → `assigned` | `claimed` → `in_progress` → `review` →
`completed` | `failed`

The authoritative status string is `tasks.status`. The schema uses `text` (not
an enum) to allow extension without migrations.

| Status | Meaning |
|--------|---------|
| `pending` | Available for a runner to claim. |
| `assigned` | Reserved for a specific runner (not yet started). |
| `claimed` | Claimed optimistically; worker row being created. |
| `in_progress` | Worker has started (runner transitions via PATCH). |
| `running` | Worker is actively running (worker status, not task). |
| `review` | Output submitted; awaiting human review. |
| `completed` | Terminal: deliverable produced (or promoted from stale worker with deliverables). |
| `failed` | Terminal: all retry attempts exhausted or permanent error. |

**Invariants**:
- A task with `dependsOn` set MUST remain `pending` (non-claimable) until all
  listed task IDs are `completed`.
- `claimedBy` MUST be set atomically with `status = 'claimed'` using an
  `UPDATE … WHERE status = 'pending'` optimistic lock.
- A task with an active worker (status in `running`, `starting`, `waiting_input`,
  `idle`) MUST NOT be reset to `pending` while that worker is alive.
- `outputRequirement = 'pr_required'` MUST block `complete_task` unless
  `workers.prUrl` is set, an open PR is auto-detected on the worker's own
  branch, or the referenced-PR fallback (AC-48) resolves one.
- `outputRequirement = 'auto'` (the default) MUST block `complete_task` when the
  worker has committed at least one commit — or has uncommitted modifications
  to tracked files sitting in its worktree — and has neither a tracked/detected
  PR nor a deliverable artifact. Either shape is a stranded change that a bare
  "completed" status would misrepresent as landed: a commit with no PR/artifact
  never reaches the branch's reviewable history, and an uncommitted edit never
  even reaches a commit. A task with zero commits AND a clean worktree (e.g.
  research/recon) is unaffected. GitHub auto-detection by branch name (not
  worker id) means a branch whose PR was opened by an earlier worker row — e.g.
  a CI/conflict retry continuing on the same branch — still satisfies the gate.
  The dirty-worktree signal is `workers.dirtyWorktree`, refreshed by the
  runner's periodic sync (`git status --porcelain`, tracked files only —
  untracked entries don't count) — `complete_task` calls made directly by the
  agent's MCP tool reach the server with no local git access of their own, so
  the gate reads whatever the sync loop most recently reported. The dispatch
  prompt (`apps/runner/src/prompt-builder.ts`) announces this obligation up
  front for `auto` (previously the only output requirement with no explicit
  section), so the agent learns it before spending the work, not from a 400 on
  its last call. Two additional shapes satisfy the gate without a PR or
  artifact of the worker's own branch: (1) a **cross-branch deliverable** —
  `workers.mergedAt` is set, meaning `merge_pr` was called and GitHub confirmed
  a merge, regardless of whose PR it was (a coordination/conflict-resolution
  task's real output is action against OTHER PRs); and (2) an explicit
  **discard acknowledgement** — `complete_task` was called with a non-empty
  `discardEdits` reason, a first-class success exit for edits that are
  legitimately scratch. Both are recorded: a cross-branch merge is inherent in
  `workers.mergedAt`, and the discard reason is snapshotted onto
  `tasks.result.discardedEdits` for audit. A **reviewer task** (`category =
  'review'`, `context.reviewerFor` set — created by `createReviewerTask`,
  `apps/web/src/lib/reviewer.ts`) is exempt from this entire check: see AC-44.
  Its contract is judged on `structuredOutput.verdict` instead, by the
  review-contract guard in `apps/web/src/app/api/workers/[id]/route.ts`.
  A gate-rejected completion (any of AC-3/AC-39/AC-40/AC-41/AC-45) persists the
  agent's `summary`/`structuredOutput`/`resultMeta` verbatim onto
  `workers.rejectedCompletionPayload` before returning the 400 — a 60-turn
  run's only output must not evaporate along with the 400. That payload is
  exposed read-only (AC-46) and, when the refusal is terminal by construction
  (AC-47), salvaged as an artifact; see below. Persisting it is not enough on
  its own: see AC-46.
- A task transitions to `failed` permanently after `MAX_WORKER_RETRIES = 3`
  failed workers with no deliverables.
- A task with `roleSlug = null` is claimable by any runner with access to the
  workspace — this is the normal case for dashboard-created tasks. Routing via
  `roleSlug` is primarily used by MCP `create_task`, orchestrator agents, and
  schedules. `context.skillSlugs` (JSON field) carries advisory skill hints to
  the executing agent but does NOT restrict claim routing.

**Acceptance criteria**:
- AC-1: GIVEN a task with `dependsOn: [taskA]` and `taskA.status = 'pending'`
  WHEN `claim_task` is called THEN the task is NOT returned (still blocked).
- AC-2: GIVEN `taskA.status` transitions to `completed` WHEN
  `resolveCompletedTask` runs THEN the dependent task's status becomes `pending`
  and a `task:unblocked` Pusher event is fired.
- AC-3: GIVEN `outputRequirement = 'pr_required'` and `prUrl` is null WHEN
  `complete_task` is called THEN the server returns an error — the task is NOT
  completed.
- AC-39: GIVEN `outputRequirement = 'auto'`, `commitCount > 0`, no PR detected
  (worker-reported or via GitHub branch lookup), and no deliverable artifact
  WHEN `complete_task` is called THEN the server returns a 400 with
  `hint: 'create_pr'` — the task is NOT completed. GIVEN the same worker has
  zero commits, completion succeeds unchanged.
- AC-40: GIVEN `outputRequirement = 'auto'`, `commitCount = 0`,
  `workers.dirtyWorktree = true`, no PR detected, and no deliverable artifact
  WHEN `complete_task` is called THEN the server returns a 400 with
  `hint: 'create_pr'` — the task is NOT completed. GIVEN the same worker has a
  clean worktree, or has a deliverable artifact, or its branch already carries
  a PR (e.g. a CI/conflict retry), completion succeeds unchanged regardless of
  the dirty-worktree flag.
- AC-41: GIVEN `outputRequirement = 'auto'`, `summarySource = 'fallback'` (the
  runner's own session-end PATCH, not an agent-authored `complete_task` call —
  see `docs/specs`'s summary-provenance note in workers.ts), no PR detected,
  and no deliverable artifact WHEN `complete_task` is called THEN the server
  returns a 400 with `hint: 'create_pr'` — the task is NOT completed,
  regardless of `commitCount`/`dirtyWorktree`. A fallback summary is a stalled
  session, never a deliberate "nothing to ship" conclusion, so it cannot rely
  on self-reported commit/worktree stats (which a worktree that never
  diverged from its base can misreport as "nothing happened" — see
  `collectGitStats` in `apps/runner/src/git-operations.ts`) as the only gate.
  GIVEN the same completion carries a PR, or `summarySource = 'agent'`,
  completion succeeds unchanged. **Carve-out:** this AC does not apply to a
  reviewer task (`tasks.category = 'review'` with `context.reviewerFor` set,
  created by `createReviewerTask`); see AC-44.
- AC-42: GIVEN `outputRequirement = 'auto'`, no PR of the worker's own, and a
  dirty worktree or commits WHEN `workers.mergedAt` is already set (a prior
  `merge_pr` call GitHub-confirmed a merge, of any PR) AND `complete_task` is
  called THEN completion succeeds — a verified cross-branch deliverable
  satisfies the gate without a PR of the worker's own.
- AC-43: GIVEN the same otherwise-refusing shape as AC-39/AC-40 WHEN
  `complete_task` is called with a non-empty `discardEdits` reason THEN
  completion succeeds and the reason is written to
  `tasks.result.discardedEdits` — an explicit discard is a success, not the
  `failed` status the `error` param produces.
- AC-44: GIVEN a reviewer task (`category = 'review'`, `context.reviewerFor`
  set) WHEN `complete_task` reports `status = 'completed'` THEN the `auto`
  gate's PR/artifact/fallback-summary check (AC-39/AC-40/AC-41) does NOT apply
  — a reviewer task structurally never opens a PR or produces an artifact of
  its own; its deliverable is `structuredOutput.verdict`. The completion is
  instead judged by the review-contract guard: a verdict present ⇒ normal
  reviewer-outcome handling (approve/request-changes/escalate); no verdict at
  all (whether written as prose, or never produced because the session ended
  without an agent-authored `complete_task`, i.e. `summarySource = 'fallback'`)
  ⇒ dropped-verdict handling: requeue the same task once (`context.
  reviewContractRetryCount`), and on a second contract violation, fail
  permanently AND escalate (mission note + Pushover via
  `escalateReviewContractFailure`) — a `review_failed` outcome (no verdict at
  all) has no push that clears it, so nothing re-dispatches a reviewer for
  that exact head SHA outside the webhook's `opened` action, and a silent
  permanent failure here would strand the PR unreviewed forever. This is
  narrower than it once was: a `synchronize` push DOES now re-dispatch a
  reviewer, but only when the PR carries a terminal `changes_requested` /
  `escalated` verdict to re-review (see AC-65), a `review_failed` round
  produced no verdict to react to, so it still depends entirely on this
  requeue-then-escalate path.
- AC-45: GIVEN `outputRequirement = 'none'` and `tasks.taskClass != 'bookkeeping'`,
  `commitCount > 0` or `workers.dirtyWorktree = true`, no PR detected, and no
  deliverable artifact WHEN `complete_task` is called THEN the server returns a
  400 with `hint: 'create_pr'` — the task is NOT completed. `'none'` means "no
  deliverable required," which is correct for a `taskClass = 'bookkeeping'` row
  (every creation site that sets `outputRequirement: 'none'` explicitly is
  bookkeeping: heartbeats, criteria evaluators, the mission-PR owner task —
  those are exempt from this AC entirely, matching AC-41's bookkeeping
  carve-out) and correct for a genuine investigation/diagnosis task that
  concludes with nothing to ship, including via a bare fallback summary alone
  unlike AC-41, `summarySource = 'fallback'` by itself does NOT trigger this
  AC, only real commit/dirty-worktree evidence does. A non-bookkeeping task
  that actually committed code has no legitimate reason to have declared
  `'none'`; before this AC, that declaration silently skipped every
  deliverable check regardless of commits, which is how a task with real,
  unreviewed changes reached `completed` on a fallback summary. The same
  cross-branch-deliverable (`workers.mergedAt`) and `discardEdits`
  satisfiers from AC-42/AC-43 apply here too.
- AC-46: GIVEN a worker row carries `rejectedCompletionPayload` (set by any
  of AC-3/AC-39/AC-40/AC-41/AC-45/AC-47) WHEN `get_task` (`GET
  /api/tasks/[id]?include=workers` and the MCP `get_task` action built on it)
  is called THEN the payload's `reason`, `summary`, and (if present)
  `salvagedArtifactId` are returned/printed, labeled as a **rejected**
  deliverable, never as a satisfied one. Before this AC, persistence alone
  (AC-3/etc.) was not enough: the payload had no read path — `GET
  /api/tasks/[id]` did not select the column, and the MCP tool never asked for
  it — so a preserved 54-turn run's findings were unreadable by any operator
  or agent surface, only the raw 400 text on `worker.error` was visible.
- AC-47: GIVEN an `artifact_required` (or `pr_required`/`auto`/`none`)
  completion is refused (any arm of AC-3/AC-39/AC-40/AC-41/AC-45) AND
  `summarySource = 'fallback'` WHEN the refusal is persisted (AC-3 note) THEN
  a `summary`-type artifact is also created from the preserved summary,
  tagged `metadata: { salvaged: true, rejectedReason }`, and cross-referenced
  as `rejectedCompletionPayload.salvagedArtifactId`. The task still fails —
  salvage is not a satisfier and must never be read as one. Scoped to
  `summarySource = 'fallback'` specifically: that value means this PATCH is
  the runner's own end-of-session completion (`apps/runner/src/workers.ts`,
  the "Actually completed" branch) firing *after* the SDK query loop already
  exited — there is no agent turn left to read the 400's hint and retry, unlike
  a `summarySource = 'agent'` refusal (the agent's own `complete_task` MCP
  call), which already gets an actionable `errorResult` back
  (`packages/core/mcp-tools.ts`) and can call `create_artifact` itself within
  the same session — salvaging there too would risk a stray duplicate
  artifact once that retry succeeds.
- AC-48: GIVEN `outputRequirement = 'pr_required'`, no PR on the worker's own
  branch, and the task's `title`/`description` reference a PR by number
  (`#N`) WHEN `complete_task` is called THEN that PR satisfies the gate two
  ways: (1) it is already `merged` (a concurrent/racing merge left the worker
  with no diff of its own to open a PR for — DONE = MERGED regardless of who
  merged it), or (2) it is still open but its GitHub head SHA equals
  `workers.lastCommitSha` — proof the worker's own push is that PR's current
  state, which covers a task scoped as "rebase/fix PR #N, push to its branch,
  request review" where the worker never owns a branch of its own and review/
  merge can only complete after this worker's session ends. A referenced PR
  that is open with a DIFFERENT head SHA satisfies neither arm and the gate
  still refuses. GIVEN the same shape via `create_pr`'s `prUrl` parameter
  instead (registering an externally-created PR), completion succeeds too,
  unrelated to this fallback.
- AC-49: GIVEN `outputRequirement = 'pr_required'` and no PR of the worker's
  own WHEN `complete_task` is called with `alreadyShippedIn: N` THEN the gate
  reads PR #N from the workspace's linked repo and, if GitHub reports it
  `merged`, completion succeeds: `tasks.result.alreadyShippedIn` records
  `{ prNumber, prUrl }`, an `output_requirement` gate event with outcome
  `accepted` is written, and the PR is NOT adopted onto the worker row (it
  belongs to the task that shipped it). This is the exit for a task whose work
  another task already shipped, where the task text does not name the PR, so
  the check in AC-48 cannot see it. An unmerged, unreadable or non-numeric `N`, or no linked
  repo, still refuses, and the refusal says which. GIVEN the worker also has
  commits or a dirty worktree, completion additionally needs `discardEdits`
  (AC-43), so its own edits are never stranded silently. The plain `pr_required`
  refusal names `alreadyShippedIn` so an agent in this position can find it.
- AC-50: GIVEN completion with effective `auto` or `pr_required`, an ordinary
  work task of kind engineering, writing or design (or with a concrete manifest),
  no commits, changed files, dirty worktree or observed session touches, and no
  registered, auto-detected or referenced PR, deliverable artifact, verified merge
  or explicit `discardEdits`, WHEN the summary has fallback provenance, the fallback
  tail separator, no terminal punctuation, or forward-looking narration without a
  past-tense outcome sentence THEN completion is refused with `silent_completion`.
  The rejected payload is preserved and the worker fails. The task requeues once
  using `context.silentCompletionRetryCount`, whether mission-linked or standalone;
  `failureContext` marks the prior summary unauthored. A recurrence permanently
  fails the task and posts a warning. Reviewer and bookkeeping tasks are exempt;
  `artifact_required` and `none` retain their existing contracts. A punctuated
  authored outcome with no edits remains valid. Reaper completion checks the same
  predicate against its independently verified deliverable evidence.
- AC-4: GIVEN a task that has had 3 prior `failed` workers WHEN the 4th worker
  is marked stale THEN `tasks.status = 'failed'` (permanent, no more retries).
- AC-5: GIVEN a concurrent claim race WHEN two runners call `claim_task`
  simultaneously THEN exactly one succeeds and the other receives an appropriate
  error or empty result.

**Code surface**:
- Claim route: `apps/web/src/app/api/workers/claim/route.ts`
- Worker update (PATCH): `apps/web/src/app/api/workers/[id]/route.ts`
- Dispatch prompt (output-requirement announcement): `apps/runner/src/prompt-builder.ts`
- Dependency resolution: `apps/web/src/lib/task-dependencies.ts` —
  `resolveCompletedTask()`
- Stale reclaim: `apps/web/src/lib/stale-workers.ts` — `resolveStaleTask()`
- Schema: `packages/core/db/schema.ts` — `tasks` table, `workers.rejectedCompletionPayload`
- Rejected-payload exposure: `apps/web/src/app/api/tasks/[id]/route.ts` (GET,
  `include=workers` column select), `packages/core/mcp-tools.ts` (`get_task`
  action, `case 'get_task'` inside `handleBuilddAction` — the file has a
  second, unreachable `case 'get_task'` later in the same switch; the first
  one wins and is the one that matters), task detail page
  (`apps/web/src/app/app/(protected)/tasks/[id]/page.tsx`)
- Salvage-on-terminal-refusal: `persistRejectedCompletionPayload` in
  `apps/web/src/app/api/workers/[id]/route.ts`
- Reviewer task creation: `apps/web/src/lib/reviewer.ts` — `createReviewerTask()`
- Reviewer contract-failure escalation: `apps/web/src/lib/auto-merge.ts` —
  `escalateReviewContractFailure()`

---


## Worker State Machine

Workers are execution sessions. A worker's `status` is separate from the task
status and tracks the agent's runtime state:

| Status | Meaning |
|--------|---------|
| `idle` | Worker row created; agent not yet started. |
| `starting` | Runner is launching the agent. |
| `running` | Agent is actively processing. |
| `waiting_input` | Agent paused, waiting for a human response. |
| `completed` | Agent finished successfully. |
| `failed` | Agent or runner encountered a terminal error. |
| `error` | System-level error (distinct from agent failure). |

**Invariants**:
- A terminal worker (`completed`, `failed`, `error`) MUST NOT accept status
  updates except a single `running` reactivation (for follow-up messages from
  the runner), and that reactivation MUST require BOTH an explicit
  `body.reactivate === true` AND a `worker.error` that
  `isNonReactivatableError` (`apps/web/src/lib/worker-termination.ts`) does not
  flag. Its phrase list, `NON_REACTIVATABLE_ERROR_PHRASES`, covers human
  takeover, task reassignment, a released interactive slot, `expired`,
  `timed out`, `went offline` and `runner restarted`. The PATCH handler in
  `apps/web/src/app/api/workers/[id]/route.ts` checks both as the locals
  `reactivateRequested` and `isNonReactivatableTermination`; failing either
  returns `409`.
- `waitingFor` MUST be cleared (`null`) automatically when status transitions
  to `running`.
- `workers.startedAt` is set the first time status becomes `running`.

**Acceptance criteria**:
- AC-6: GIVEN `worker.status = 'failed'` WHEN a PATCH with `status = 'running'`
  is received THEN the reactivation is allowed ONLY if the caller passes the
  cleanup-expiry guard; otherwise HTTP 409 is returned.
- AC-7: GIVEN `worker.status = 'waiting_input'` WHEN a PATCH with
  `status = 'running'` arrives THEN `waitingFor` is set to `null` in the same
  update.

**Code surface**:
- PATCH handler: `apps/web/src/app/api/workers/[id]/route.ts`
- Reactivation guard: same file, lines ~88–109

---

**Out of scope**: The sibling contracts linked in the frontmatter.
