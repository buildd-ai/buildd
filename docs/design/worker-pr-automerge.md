# Worker PR Auto-Merge — Design Spec

> **Status:** Proposed — awaiting Max's approval before any implementation begins.
> **Task:** 136c9670 · Branch: `buildd/136c9670-recon-spec-read-only-generaliz`
> **Scope:** Track 1 = CI-gated auto-merge reliability + observability. Track 2 = fan-out task primitives (appendix, input to a separate spec).

---

## Recon Findings

### (a) Does CI-gated auto-merge exist for worker→dev PRs today?

**Yes — it exists, and it applies to all worker PRs (including worker→dev feature PRs).**

The `handleCheckSuiteEvent` function in `apps/web/src/app/api/github/webhook/route.ts` (line 229) implements CI-gated auto-merge for every PR associated with a buildd worker:

1. `check_suite.completed` fires with `conclusion: 'success'`
2. Iterates `check_suite.pull_requests`
3. Queries `workspaces` linked to the repo with `autoMergeOnGreenCI` enabled (defaults `true`)
4. Finds the worker by `workers.prNumber = pr.number`
5. Calls `allCheckSuitesPassed` — verifies all suites passed, not just the triggering one
6. Checks `requiresReview` gate (holds PR if task or mission requires human review)
7. Calls `tryAutoMergeWorkerPr` → `evaluateAutoMergeSafety` → squash-merge

This is the general mechanism. It is NOT scoped to release PRs. The release PR path (`handleReleasePrCiSuccess`, line 876) is a separate, parallel mechanism that handles the `pending_ci` release task state.

**The existing mechanism is correct in its happy path.** The problems are:
- Silent merge failures (no notification on dirty state or failed merge call)
- No persistent `autoMergePending` marker, so if check_suite fires before `prNumber` is recorded on the worker, the PR is silently skipped
- No observability when safety rails block a merge

### (b) autoMergePR / autoMergeMaxLines / autoMergeDenyPaths — current values and semantics

These live in `workspaces.gitConfig` (JSONB, `WorkspaceGitConfig` interface). The actual buildd workspace values require a DB query, but the defaults and resolution logic are:

| Field | Default | Precedence logic |
|---|---|---|
| `autoMergeOnGreenCI` | `true` (opt-out) | `gitCfg?.autoMergeOnGreenCI ?? gitCfg?.autoMergePR ?? true` (webhook line 260) |
| `autoMergeMaxLines` | `800` | `gitConfig?.autoMergeMaxLines ?? DEFAULT_AUTO_MERGE_MAX_LINES` (line 843) |
| `autoMergeDenyPaths` | `[]` | `gitConfig?.autoMergeDenyPaths ?? []` (line 842) |

The `autoMergePR` legacy field is kept in sync by the config POST route (`apps/web/src/app/api/workspaces/[id]/config/route.ts` line 249) but `autoMergeOnGreenCI` takes precedence.

`evaluateAutoMergeSafety` (webhook, line 802) enforces in this order:
1. CI completeness: any `in_progress`, `queued`, or `failure` check run → block
2. Deny paths: any touched file whose path starts with a deny prefix → block
3. Line count: `additions + deletions > maxLines` → block

If `evaluateAutoMergeSafety` blocks, a mission notification is sent IF the task has a `missionId`. If there is no `missionId`, the block is **silent** — no notification, no Pushover.

### (c) Mission heartbeat and open PR merging

The health watcher (`apps/web/src/lib/health-watcher.ts`) does **not** enumerate open worker PRs or attempt merges. Its job is:
- `checkFailingReleasePRs`: finds CI-failing release PRs and fires fix tasks
- `checkProdReleaseHealth`: checks Vercel prod deployment health

The mission heartbeat (a scheduled task with `context.heartbeat = true`) runs planner logic — it creates and prioritizes tasks, but does NOT directly merge PRs.

PRs are merged only by:
1. The `check_suite.completed` webhook handler (`tryAutoMergeWorkerPr`)
2. The `pull_request.opened` handler for no-CI repos (`maybeAutoMergeNoCiPr`)
3. `executeRelease` (branch_merge strategy, on task completion via `PATCH /api/workers/[id]`)

### (d) Behavior when mergeable_state is dirty (conflicting sibling PRs)

**Current behavior: silent drop.** The `evaluateAutoMergeSafety` function does **not** check `mergeable_state`. It queries CI runs, deny paths, and line count — but not GitHub's conflict status. When `mergePullRequest` is called and the PR is conflicted, GitHub returns a 405. `tryAutoMergeWorkerPr` (line 793) handles this:

```typescript
const result = await mergePullRequest(installationId, repoFullName, prNumber, 'squash');
if (result.merged) {
  console.log(`Auto-merged PR #${prNumber}...`);
} else {
  console.warn(`Failed to auto-merge PR #${prNumber}...: ${result.message}`);  // ← only a warn log
}
```

No mission notification. No Pushover. No requeue. The PR sits open indefinitely unless a human notices. This is the primary source of "flaky" auto-merge: parallel feature PRs that conflict with each other after the first one merges all fail silently.

### (e) pending_ci task completion gap (flagged in PR #996)

The gap documented in `docs/design/release-handoff-workflow.md` §7.5 ("There is no `check_suite` handler that completes the task when CI on the release PR resolves") **has been closed** in the current codebase. The `handleReleasePrCiSuccess` function (webhook, line 876) was added after PR #996. It:
- Matches tasks with `context.releasePrPending = true` and `context.releasePrNumber = prNumber`
- Verifies all suites passed
- Merges the release PR via `mergePullRequest`
- Updates task status to `completed` or `failed`
- Fires Pushover on failure

**This gap is resolved.** The spec below does not re-address it.

---

## Gap Summary

| # | Gap | Severity | Impact |
|---|---|---|---|
| G1 | Merge failure on dirty state is a silent `console.warn` | High | PR stuck indefinitely; user unaware |
| G2 | Safety rail blocks (deny-path, line cap) emit mission note only if `missionId` present | Medium | Non-mission tasks silently stall |
| G3 | No `autoMergePending` marker at task completion time | Medium | `check_suite` race if CI finishes before `prNumber` recorded |
| G4 | Line cap counts test LOC same as source LOC | Low | Large-test PRs incorrectly blocked |
| G5 | Deny-path/oversized PRs go to a one-line console log, not a human-review queue | Low | No actionable queue for PRs needing human eyes |

---

## Spec

### S1 — Conflict detection before merge attempt

Before calling `mergePullRequest`, query GitHub's PR mergeable state and act deterministically:

```typescript
// In evaluateAutoMergeSafety, after line-count check:
const prData = await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}`);
const mergeableState = prData?.mergeable_state as string | undefined;

if (mergeableState === 'dirty') {
  // Attempt rebase onto base branch via GitHub API
  // POST /repos/{owner}/{repo}/pulls/{pull_number}/update-branch
  try {
    await githubApi(installationId, `/repos/${repoFullName}/pulls/${prNumber}/update-branch`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_head_sha: headSha }),
    });
    // Rebase requested — return ok:false with a retryable reason
    return { ok: false, reason: 'rebase requested — check_suite will re-fire when updated' };
  } catch {
    return { ok: false, reason: 'conflict: PR needs rebase onto base branch' };
  }
}

if (mergeableState === 'blocked') {
  return { ok: false, reason: 'PR blocked (branch protection or review required)' };
}
```

The `update-branch` endpoint asks GitHub to rebase the PR's head onto its base. This triggers a new CI run (which fires a new `check_suite.completed` → new merge attempt). If the rebase fails (e.g., genuine text conflict), the API returns an error, we catch it and return the conflict reason.

**Note:** `mergeable_state = 'unknown'` is returned when GitHub is still computing conflict state. Treat this as a soft retry: return `ok: false, reason: 'mergeable_state unknown — will retry on next check_suite'`. Do NOT block permanently.

### S2 — Notification on every auto-merge skip

Replace the existing notification logic in `tryAutoMergeWorkerPr` with a guaranteed-notification path for all skip reasons:

```typescript
async function tryAutoMergeWorkerPr(params: { ... }): Promise<void> {
  const safetyCheck = await evaluateAutoMergeSafety(...);
  if (!safetyCheck.ok) {
    // Notify via all available channels — NOT just mission notes
    await notifyAutoMergeSkip({
      worker,
      taskId: worker.taskId,
      repoFullName,
      prNumber,
      reason: safetyCheck.reason,
    });
    return;
  }

  const result = await mergePullRequest(installationId, repoFullName, prNumber, 'squash');
  if (!result.merged) {
    // Merge call itself failed (e.g., race condition, server error)
    await notifyAutoMergeSkip({
      worker,
      taskId: worker.taskId,
      repoFullName,
      prNumber,
      reason: `merge API call failed: ${result.message}`,
    });
  }
}
```

The `notifyAutoMergeSkip` helper:
1. **Mission note** (if `missionId`): `type: 'warning'`, title includes PR number and reason
2. **Pushover** (always): `app: 'tasks'`, priority 0, title "Auto-merge skipped", includes PR URL + reason
3. **Console log** (always): retain existing log for server-side visibility

This ensures Max sees every skip via Pushover regardless of whether the task has a mission.

### S3 — autoMergePending marker

**Problem:** if `check_suite.completed` fires and the worker hasn't yet recorded its `prNumber` (e.g., the agent created a PR via `gh pr create` without using the `create_pr` MCP action), the worker lookup returns null and the merge is silently skipped.

**Fix:** at task completion time (`PATCH /api/workers/[id]` with `status: completed`), if the worker has a `prUrl`/`prNumber`, write a marker to `tasks.context`:

```typescript
// In workers route.ts, after PR auto-detection (line 282-304), before executeRelease:
if (worker.prNumber && worker.taskId) {
  const existingCtx = ...;
  await db.update(tasks).set({
    context: {
      ...existingCtx,
      autoMergePending: true,
      autoMergePrNumber: worker.prNumber,
      autoMergeHeadSha: lastCommitSha ?? worker.lastCommitSha,
    },
    updatedAt: new Date(),
  }).where(eq(tasks.id, worker.taskId));
}
```

In `handleCheckSuiteEvent`, add a fallback lookup for PRs not yet recorded on a worker:

```typescript
// After the worker lookup via prNumber fails:
if (!worker) {
  // Fallback: find task with autoMergePending for this PR number
  const pendingTask = await db.query.tasks.findFirst({
    where: sql`(${tasks.context}->>'autoMergePending')::boolean = true
               AND (${tasks.context}->>'autoMergePrNumber')::int = ${pr.number}`,
    with: { workers: { orderBy: desc(workers.createdAt), limit: 1 } },
  });
  if (pendingTask?.workers?.[0]) {
    // Use the task's worker as the merge actor
    worker = pendingTask.workers[0];
  }
}
```

Clear `autoMergePending` from context after a successful merge or terminal skip.

### S4 — Test LOC separation in line cap

The current line cap counts all `additions + deletions` equally. This incorrectly routes large-test PRs to the human-review queue.

**Fix:** add a `autoMergeMaxSourceLines` field to `WorkspaceGitConfig` (distinct from `autoMergeMaxLines`):

```typescript
// WorkspaceGitConfig addition:
autoMergeMaxSourceLines?: number;  // cap on non-test source lines (default: same as autoMergeMaxLines)
```

In `evaluateAutoMergeSafety`, split the file list:

```typescript
const testFiles = files.filter(f =>
  f.filename.includes('.test.') ||
  f.filename.includes('.spec.') ||
  f.filename.includes('/__tests__/') ||
  f.filename.includes('/tests/')
);
const sourceFiles = files.filter(f => !testFiles.includes(f));

const totalLines = files.reduce((s, f) => s + f.additions + f.deletions, 0);
const sourceLines = sourceFiles.reduce((s, f) => s + f.additions + f.deletions, 0);

const maxTotal = gitConfig?.autoMergeMaxLines ?? DEFAULT_AUTO_MERGE_MAX_LINES;
const maxSource = gitConfig?.autoMergeMaxSourceLines ?? maxTotal;

if (sourceLines > maxSource) {
  return { ok: false, reason: `source diff ${sourceLines} lines > source limit ${maxSource} (total ${totalLines})` };
}
if (totalLines > maxTotal) {
  return { ok: false, reason: `diff size ${totalLines} lines > limit ${maxTotal}` };
}
```

This allows large-test PRs through while still capping raw source changes.

### S5 — Human-review queue for blocked PRs

PRs blocked by deny-path hits or oversized diffs should route to an explicit queue rather than silently dropping. The notification from S2 covers the Pushover side. Additionally:

**Mission note type `'review_needed'`** (new `MissionNoteType` enum value): post a note that survives until the human explicitly dismisses it. Existing note types cover `decision`, `question`, `warning`, `suggestion`, `update` — add `review_needed` as a distinct type the dashboard can surface with a badge.

Schema change (additive, no migration risk):

```typescript
// missionNotes.type: add 'review_needed'
type: text('type').notNull().$type<
  'decision' | 'question' | 'warning' | 'suggestion' | 'update' | 'reply' | 'guidance' | 'review_needed'
>(),
```

`notifyAutoMergeSkip` posts a `review_needed` note (when `missionId` exists) with:
- `title`: `Auto-merge held: PR #${prNumber} — ${reason}`
- `body`: link to PR, head SHA, specific rule that blocked, and the action required ("rebase branch" / "reduce diff size" / "review deny-path changes")

For non-mission tasks, the Pushover from S2 is sufficient.

---

## Audit → Spec → Code Gate Structure

This spec is for **Max's approval only**. No code changes should begin until:

1. Max approves this spec (or provides revision feedback)
2. A new task is created referencing this spec as the implementation guide
3. That implementation task follows TDD: tests for the new `evaluateAutoMergeSafety` behavior and `notifyAutoMergeSkip` before any production changes

---

## Test Plan

### Unit tests

| File | Test |
|---|---|
| `apps/web/src/app/api/github/webhook/route.test.ts` | `evaluateAutoMergeSafety` returns `ok:false, reason:'conflict: ...'` when `mergeable_state: 'dirty'` and rebase API call fails |
| same | `evaluateAutoMergeSafety` attempts rebase when `mergeable_state: 'dirty'` and returns retryable reason |
| same | `evaluateAutoMergeSafety` passes test-only PRs through `autoMergeMaxSourceLines` cap |
| same | `tryAutoMergeWorkerPr` calls `notifyAutoMergeSkip` on every safety block |
| same | `tryAutoMergeWorkerPr` calls `notifyAutoMergeSkip` when merge API returns `merged: false` |
| `apps/web/src/app/api/workers/[id]/route.test.ts` | Worker completion writes `autoMergePending` marker when `prNumber` is set |

### Integration smoke tests

- Worker PR with CI green + no conflict → auto-merged, no notification
- Worker PR with CI green + conflict → rebase attempted → new CI run fires
- Worker PR blocked by deny path → Pushover sent with PR URL + blocked path
- Worker PR line-count exceeded (source only) → blocked; test-only PR of same size passes

### Manual / pre-release checklist

- [ ] Deploy to preview; open a test PR from a buildd task
- [ ] Confirm auto-merge fires on green CI
- [ ] Manually create a conflict on the test PR; confirm rebase is attempted and Pushover fires
- [ ] Confirm mission notes appear for mission-linked tasks

---

## Migration / Rollout Steps

1. **Schema migration**: `bun db:generate && bun db:migrate` for the `review_needed` note type addition to `missionNotes.type`. This is additive (no existing rows change).
2. **Config migration** (`autoMergeMaxSourceLines`): no DB migration required — it's a new optional field on the JSONB `gitConfig`. Absent value defaults to `autoMergeMaxLines` (backward-compatible).
3. **Deploy order**: webhook handler changes (`S1`, `S2`) first, then workers route change (`S3`), then schema (`S5`). Each is independently deployable.
4. **Feature flag**: none required. `evaluateAutoMergeSafety` changes are additive. Worst case: the rebase call fails, returns a skip reason, and Pushover fires — same observable outcome as today plus a notification.

---

## Rollback Note

Each change is a pure enhancement to existing code paths:
- `evaluateAutoMergeSafety` new checks: revert the mergeable_state lookup and rebase call; the existing merge attempt continues as before
- `notifyAutoMergeSkip`: revert to `console.warn` only
- `autoMergePending` marker: revert the write in workers route; the fallback lookup in webhook becomes dead code and can be removed

No data migrations to undo.

---

## Appendix: Track 2 — Fan-Out Task Primitives (Input to a Separate Spec)

> **This is an inventory and gap analysis only.** Nothing below should be implemented as part of this spec. It is input for a separate "fan-out task" spec to be approved independently.

### Existing primitives

**Role/skill delegation:**
- `workspaceSkills.canDelegateTo` (`string[]`): slugs of other skills this role can invoke as subagents. Set in `packages/core/db/schema.ts` line 922.
- `workspaceSkills.background` (`boolean`): when true, the SDK spawns subagents as background tasks (non-blocking). Line 923.
- `workspaceSkills.maxTurns` (`integer`): turn limit per invocation. Line 924.
- `workspaceSkills.isRole` (`boolean`): distinguishes team-visible roles from utility skills. Line 929.

At runtime, `canDelegateTo` is wired into the SDK as subagent configuration (via `role-config.ts`). The lead agent can invoke a delegated skill as a subagent within its single session. Crucially, this is **intra-session** delegation — the subagents share the lead's process and cannot be independently claimed, retried, or observed as separate workers.

**Cross-task coordination:**
- `send_agent_message`: delivers mid-flight messages to a running worker's `pendingInstructions`. Requires the target task to be running and the caller to know the target `taskId`. Not a fan-out broadcast.
- `create_task` + `dependsOn`: a lead task can create child tasks and set dependency relationships. Children are dispatched as independent workers. Each gets its own worktree.

**Worktree allocation:**
- Each worker gets an isolated worktree (`apps/runner/src/worktree-utils.ts`). The base branch is configurable via `task.context.baseBranch` (used in CI retry / Ralph loop).
- Workers cannot share a worktree. There is no mechanism to branch a child off a lead's in-progress worktree.
- A lead could create child tasks with `baseBranch = lead.branch` — children would start from the lead's current branch HEAD — but the lead's branch may not be pushed yet when children are dispatched.

### What's missing for fan-out

| Primitive | Gap |
|---|---|
| Worktree inheritance | No way for a lead to spawn children that branch from its **in-progress, unpushed** worktree |
| Reconciliation gate | No "wait for all children, then merge" step before the lead opens a PR |
| Lead-level merge arbitration | No mechanism for a lead task to receive children's branches and squash/merge them into one branch before opening a single PR |
| File-lock / ownership claims | No way to assign schema ownership to one child to prevent migration conflicts |
| Fan-out broadcast | No way for a lead to send steering to all active children without knowing each `taskId` |

### Feasibility sketch (not a design)

A lead task could:
1. Partition work by file/module boundaries (e.g., "child A owns `packages/core/db/schema.ts` + migrations; child B owns route handlers")
2. Create child tasks with `baseBranch = lead.branch` and `dependsOn: []` (parallel)
3. Receive completion signals by polling child task status or via `send_agent_message` replies
4. On all children terminal: checkout each child branch, merge into lead's branch, run build/test, open a single PR

**Missing primitives needed to implement this:**
1. `autoBaseBranch`: ability to create a task that starts from the lead's branch at its current tip (requires lead to push before creating children)
2. `reconcile` task type: a follow-on task that auto-receives all sibling branch names and runs `git merge` + `bun test` before opening a PR
3. Per-file ownership enforcement: advisory lock on file paths to prevent two children from touching the same schema file

**Recommendation:** Do not implement fan-out as a workaround for the conflict problem. Fix the single-PR auto-merge path (Track 1) first. Fan-out is valuable for large, partition-friendly tasks but requires new primitives that are a 2-3 week investment. Flag as a separate spec after Track 1 ships.
