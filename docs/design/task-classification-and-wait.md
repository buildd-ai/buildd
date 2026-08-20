# Task Classification and Wait Primitive

**Status:** Proposed  
**Related:**  
- `packages/core/mission-helpers.ts` — `deriveTaskType`, `isDeliverableTask`, `computeMissionProgress`  
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` — `allTasksCount`, `isBookkeeping` predicate  
- `apps/web/src/app/app/(protected)/tasks/TaskGrid.tsx` — root/child split  
- `apps/web/src/app/app/(protected)/home/page.tsx` — ACTIVITY filter  
- `apps/web/src/lib/stale-workers.ts` — reaper / `resolveStaleTask`  
- `apps/web/src/lib/loop-dispatcher.ts` — loop exit condition evaluation  
- `apps/web/src/app/api/workers/[id]/route.ts` — worker PATCH / loop dispatch  
- `packages/core/db/schema.ts` — `tasks` table  
- `packages/shared/src/types.ts` — `LoopExitCondition`, `LoopConfig`  
- `packages/core/mcp-tools.ts` — `buildCIRetryTask`, `create_task` handler  
- `apps/web/src/lib/ci-retry.ts` — CI retry task builder  
- PR #1706 (attempt filter fix), PR #1721 (ACTIVITY filter), PR #1594 (reaper deliverables split),  
  task 411d39e0 (discriminator column recommendation), task 9cd303dd artifact ac95e3a6  
- Memories: 0d4df506 (parentTaskId dual path), 48eae69a (reaper blind-kill), f88f23be (reaper split), 5cb6a936 (stale cleanup must never evaluate conditions), e1b02fc0 (liveness clock contract)

---

## Problem

Three divergent predicates, three rounds of whack-a-mole:

- **PR #1674**: `filter(t => !t.parentTaskId)` erased spawned builder tasks from mission counts.
- **PR #1706**: `deriveTaskType(t)` introduced as the canonical collapse predicate; taxonomy captured in a comment.
- **2026-08-19, mission de0357c2**: two fresh divergent predicates minted in the same week:  
  - `allTasksCount` (missions/[id]/page.tsx:285) uses `deriveTaskType === null` — misclassifies planning-mode tasks as deliverables in the tile count.  
  - `isBookkeeping` inline (missions/[id]/page.tsx:427) re-derives the same concept differently.  
  - Result: mission detail tile said **TASKS 1**, "View all 2 tasks" showed 2, Activity rendered the orchestrator `Mission:` row as the primary card.

Same mission's worker burned **2h37m on a 4-minute merge**: the merge sub-task's third worker completed saying *"scheduled a check in ~2 minutes"* without merging; the 15-min stale reaper killed it anyway; the COMPLETION SUMMARY read *"Completed by stale-worker reaper: worker delivered 1 artifact before going offline"* instead of *"PR #1721 merged via squash into dev"*.

Root-cause diagnosis from task 411d39e0: if the schema cannot express the difference between a deliverable task and a coordination task, every new read site re-invents the predicate. **Write the discriminator column. Stop the whack-a-mole.**

---

## Non-goals

- Full Activity view redesign (tracked separately, see spec artifact `13551a50` from memory cc334287).
- Metric criterion queries (`type: 'metric'` in goalCriteria) — already deferred in `evaluateGoalCriteria`.
- Stage-chip display (`BLOCKED → QUEUED → RUNNING → …`) — scoped to Activity spec.
- Worker-level process-liveness checks for the reaper beyond what PR #1594 established.
- Codex backend specifics — all rules apply equally to Claude and Codex workers.

---

## Part A: `taskClass` — Stored Discriminator

### A.1 Taxonomy

```
taskClass: 'work' | 'attempt' | 'bookkeeping'
```

| Class | Definition |
|---|---|
| `work` | A genuine deliverable. Counts in TASKS tally and progress denominator. Appears in the timeline as a primary card. |
| `attempt` | A retry or review pass over an existing deliverable. Collapses under its parent in all tallies. Never primary in the timeline. |
| `bookkeeping` | A coordination step with no independent deliverable. Excluded from TASKS tally and progress denominator. Appears in the timeline's "housekeeping" section only. |

**Invariant enforced by this column:**  
`PRS ≤ TASKS` when `TASKS > 0`. Violation = over-collapse (attempt predicate too aggressive) or under-exclude (bookkeeping predicate too loose). Currently a dev-only `console.error` at missions/[id]/page.tsx:294; after migration becomes a test assertion.

### A.2 Creation-Path → Class Table

| Creation path | Title pattern / field signal | `taskClass` | Notes |
|---|---|---|---|
| `create_task` MCP (agent calls) | any | `work` | Default for all agent-initiated tasks |
| Dashboard / API `POST /api/tasks` | any | `work` | Same default |
| Discord / Slack integration tasks | `mode='planning'` set | `bookkeeping` | Integration sets `mode='planning'` at creation |
| Discord / Slack integration tasks | no `mode='planning'` | `work` | Normal execution tasks |
| `approve_plan` children | `mode='execution'`, `parentTaskId = planningTaskId` | `work` | Distinct deliverables — must NOT collapse under parent |
| `buildCIRetryTask` (ci-retry.ts) | `[CI Retry #N]` title prefix, `parentTaskId` set | `attempt` | Webhook-triggered on check_suite failure |
| Conflict-retry task (conflict-retry.ts) | `[CI Retry #N]` title prefix, `parentTaskId` set | `attempt` | Same prefix, same class |
| `createReviewerTask` (github/webhook/route.ts) | `[reviewer] PR #N:` title prefix | `attempt` | PR review dispatch |
| Reviewer retry (workers/[id]/route.ts) | `[reviewer retry #N]` or `[reviewer]` prefix, `parentTaskId` set | `attempt` | Request-changes loop |
| Mission orchestrator planning slot | `mode='planning'`, title starts `Mission:` | `bookkeeping` | Set at missions/route.ts:341-342 |
| Plan rejection retry | `mode='planning'`, `category` unset | `bookkeeping` | reject-plan/route.ts:69 |
| `Aggregate results:` tasks | title prefix (MCP orchestrator) | `bookkeeping` | Sub-tasks spawned by planning workers |
| `Evaluate mission completion:` tasks | title prefix | `bookkeeping` | Sub-tasks spawned by planning workers |
| `Close mission` tasks | title prefix | `bookkeeping` | Sub-tasks spawned by planning workers |
| `[friction]` tasks (CLAUDE.md pattern) | `[friction]` title prefix | `bookkeeping` | Agent self-reports; dedup by frictionSignature |
| Webhook tasks (non-CI-retry, non-reviewer) | `creationSource='webhook'` with no retry signal | `work` | e.g., deploy-triggered work |

**Edge case — orchestrator-only missions where the planning task produced the PR:**  
`computeMissionProgress` already special-cases `t.mode === 'planning' && t.workers?.some(w => w.prUrl)` and counts that task as a deliverable. After migration, `taskClass` for that task is still `bookkeeping`, and this special-case logic **must be preserved** in `computeMissionProgress` — it overrides `taskClass` for the narrow purpose of progress counting when the coordination task is also the PR author. No change to this rule; it is correctly modeled as an exceptional path.

### A.3 Read-Site Census and Kill List

The following predicates must be **deleted or replaced** by a direct `taskClass` column check after migration. No new predicate of these forms may be introduced in UI filter code (see §A.5 enforcement).

| # | File | Line(s) | Current predicate | Kill action |
|---|---|---|---|---|
| (a) | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` | 285–287 | `deriveTaskType({ title, parentTaskId, mode }) === null` — used for `allTasksCount`; misses `mode='planning'` tasks which deriveTaskType returns null for | Replace with `t.taskClass !== 'bookkeeping'` |
| (b) | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` | 427–429 | `isBookkeeping` inline: `deriveTaskType(...) !== null \|\| t.mode === 'planning'` | Replace with `t.taskClass !== 'work'` (bookkeeping OR attempt) |
| (c) | `apps/web/src/app/app/(protected)/tasks/TaskGrid.tsx` | 245 | `visibleTasks.filter(t => !t.parentTaskId)` — raw root/child split; ignores `taskType` already in the GridTask shape | Replace with `t.taskClass === 'work'` (server already ships `taskType`; now also ship `taskClass`) |
| (d) | `packages/core/mission-helpers.ts` | 283–298 | `isDeliverableTask` body with title-prefix matching (`startsWith('Aggregate results:')` etc.) | After backfill, replace body with `t.taskClass === 'work'`. Keep the special-case planning-task override in `computeMissionProgress` (line 390). |
| (e) | `apps/web/src/app/app/(protected)/home/page.tsx` | 487 | `deriveTaskType({ title, parentTaskId, mode }) !== null` (ACTIVITY filter, §3.6) | Replace with `t.taskClass === 'attempt'` (only attempts collapse; bookkeeping tasks are already excluded by the outer planning-mode filter at line 1070) |

**After migration, exactly one exported selector set in `packages/core/mission-helpers.ts`:**

```typescript
export const isWork       = (t: { taskClass?: string | null }) => t.taskClass === 'work';
export const isBookkeeping = (t: { taskClass?: string | null }) => t.taskClass === 'bookkeeping';
export const isAttempt    = (t: { taskClass?: string | null }) => t.taskClass === 'attempt';

/** Attach attempts under their parent work tasks for display (replaces the childrenMap logic in computeMissionProgress). */
export function attachAttempts<T extends { id?: string; taskClass?: string | null; parentTaskId?: string | null }>(
  tasks: T[]
): Map<string, T[]> { ... }
```

`deriveTaskType` survives in two roles only:
1. **Backfill** — used to populate `taskClass` for historical rows (see §A.4).
2. **Attempt subtype labeling** — returns `'retry' | 'review' | 'review-retry' | null` for display-only badge text (`TaskTypeBadge`, `stripTaskTypePrefix`). This display derivation does NOT gate any counting logic.

### A.4 Migration and Backfill Plan

**Step 1: Add nullable column.**
```sql
ALTER TABLE tasks ADD COLUMN task_class text;
```
New rows get `NULL` until the application code is deployed (see step 3). No index yet.

**Step 2: Backfill.**  
Run a one-time script (or migration file) that sets `task_class` for all existing rows using the same derivation logic as `deriveTaskType` + `isDeliverableTask`:

```sql
-- attempt: title-prefix match OR (has parentTaskId AND mode != 'execution')
UPDATE tasks SET task_class = 'attempt'
WHERE task_class IS NULL
  AND (
    title ~* '^\\[(CI )?[Rr]etry'
    OR title ~* '^\\[reviewer'
    OR (parent_task_id IS NOT NULL AND mode IS DISTINCT FROM 'execution')
  );

-- bookkeeping: planning-mode OR known coordination titles OR friction prefix
UPDATE tasks SET task_class = 'bookkeeping'
WHERE task_class IS NULL
  AND (
    mode = 'planning'
    OR title LIKE 'Aggregate results:%'
    OR title LIKE 'Evaluate mission completion:%'
    OR title LIKE 'Mission:%'
    OR title LIKE 'Close mission%'
    OR title ~* '^\\[friction\\]'
    OR kind = 'coordination'
  );

-- work: everything else
UPDATE tasks SET task_class = 'work'
WHERE task_class IS NULL;
```

**Historical counts do not change** — the backfill mirrors the predicates `computeMissionProgress` already uses (`deriveTaskType` + `isDeliverableTask`). The only correctness risk is the `allTasksCount` bug at read-site (a): pre-migration it under-excluded `mode=planning` rows (treating them as work); post-migration `taskClass='bookkeeping'` correctly excludes them. This fixes the "TASKS 1 vs View all 2" discrepancy — not a regression.

**Step 3: Write `taskClass` at creation time.**  
Update every task-creation path (MCP `create_task`, webhook CI retry, reviewer dispatch, mission run, reject-plan) to write `task_class` explicitly at insert time. This is the source-of-truth write; the backfill only covers historical rows.

**Step 4: Enforce NOT NULL.**  
After deploy + backfill verified:
```sql
ALTER TABLE tasks ALTER COLUMN task_class SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN task_class SET DEFAULT 'work';
```
Add index for the most common filter:
```sql
CREATE INDEX tasks_task_class_idx ON tasks (task_class);
```

**Step 5: Delete old predicates (read sites (a)–(e) above).**

### A.5 Enforcement

**Lint rule / grep-test** (add to `packages/core/__tests__/task-class-invariants.test.ts`):

```typescript
// No UI filter code may use these patterns — they are the banned predicates.
const BANNED_PATTERNS = [
  /filter\(.*!.*\.parentTaskId/,        // raw root/child split
  /mode\s*===?\s*['"]planning['"]/,     // mode-equality check in filter context
  /title\??\.(startsWith|match|test).*('Aggregate|'Mission:|'Evaluate|'Close mission)/,
  /deriveTaskType.*!==?\s*null/,        // fragment — old collapse predicate
];
// Verify these do not appear in apps/web/src/app/**/(page|route).tsx
```

**Graduation of the dev-only invariant check** (missions/[id]/page.tsx:294-299):
```typescript
// Remove the NODE_ENV=development guard. Always assert in tests:
// packages/core/__tests__/task-class-invariants.test.ts
it('PRS ≤ TASKS for any mission task list', () => { ... });
```

The console.error in production is retained (non-fatal) but the test asserts the invariant is structurally unrepresentable given the column — if `taskClass` is correctly written at creation time, `PRS > TASKS` becomes impossible without a logic bug that the test will catch.

---

## Part B: Wait Primitive and Honest Completion

### B.1 Existing Loop System (What It Does)

The loop system in `apps/web/src/lib/loop-dispatcher.ts` and `apps/web/src/app/api/workers/[id]/route.ts` (lines 1028–1060) works as follows:

1. Task carries `loopConfig: { exitCondition, maxLoops?, backoffMinutes? }`.
2. Worker runs and calls `PATCH /api/workers/[id]` with `status=completed` (or `failed`).
3. The PATCH handler reads the task's `loopConfig`, evaluates the exit condition against the worker's output, and decides:
   - **Condition met** → worker exits cleanly; task proceeds to terminal state.
   - **Condition unmet** → worker gets `exitCause='condition_unmet'` (excluded from retry caps, per memory 5cb6a936); task `loopState='condition_unmet'`, `loopIteration++`, requeued as `pending` with `startAt` floor (`backoffMinutes`).
4. Stale cleanup (`cleanupStaleWorkers`) may recover abandoned loop iterations but **must never evaluate a condition** — it resets the task to pending without changing `loopIteration`.

**Existing exit condition types** (`packages/shared/src/types.ts:1050-1064`):
- `command` — run a shell command and check exit code; evaluated inside a worker task.
- `pr_checks_green` — check `worker.prLifecycleStatus` from the worker row.
- `structured_predicate` — check a JSON path in `structuredOutput`.

### B.2 PR-Merge Wait via Loop Extension

**Can the existing loop carry merge-waits?** Yes, with one extension.

A "wait for PR merge" is structurally identical to `pr_checks_green` but with a different condition: `worker.mergedAt IS NOT NULL`. The existing machinery reuses cleanly:

```typescript
// New exit condition type — add to LoopExitCondition in packages/shared/src/types.ts
| { type: 'pr_merged' }
```

**Evaluation at PATCH time** (loop-dispatcher.ts, `evaluateExitCondition`):
```typescript
if (exitCondition.type === 'pr_merged') {
  return opts.workerMergedAt != null
    ? { satisfied: true, summary: 'PR merged' }
    : { satisfied: false, summary: 'PR not yet merged' };
}
```

If the worker completes without `mergedAt` set, the loop requeues the task (condition_unmet). The next iteration's worker checks again.

**Webhook-triggered advancement** (eliminates polling):

When the `pull_request` webhook fires with `action=closed` and `merged=true`, the handler already stamps `worker.mergedAt` and calls `checkDependsOnResolved`. It should also **call `evaluateAndAdvanceLoop`** for any task whose latest worker has `exitCause='condition_unmet'` and whose `loopConfig.exitCondition.type === 'pr_merged'`. If the condition is now satisfied, the loop is advanced immediately without waiting for the next poll interval — the task is dispatched as if a new loop iteration fired.

```
pull_request:closed (merged=true)
  → stamp worker.mergedAt
  → checkDependsOnResolved (existing)
  → evaluateAndAdvanceLoop(taskId)   ← NEW: check pr_merged condition, dispatch if met
```

This is NOT a new mechanism. It reuses `dispatchLoopIteration` (already in loop-dispatcher.ts) triggered by an external event rather than a worker PATCH. The dispatcher is already the sole authority for loop advancement (memory 5cb6a936 constraint is preserved — stale cleanup still never evaluates conditions).

**Why NOT a separate `waiting_external` worker state:**  
A separate state would require: (a) a new DB column on `workers`, (b) new claim-route logic, (c) new reaper logic, (d) new Pusher events — all for what is structurally a loop with a webhook exit condition. The loop system already handles the condition-unmet → requeue → event-trigger pipeline. Adding `waiting_external` as a worker status would be a parallel mechanism solving the same problem. We do not introduce it.

### B.3 Reaper Exemption Rules

A task in `loopState='condition_unmet'` is **exempt from the 15-minute staleness kill** when its `loopConfig.exitCondition.type` is a pure event-wait condition (`pr_merged`). The rationale: the worker is already terminated (it exited with `condition_unmet`); there is no in-flight worker to kill. The "stale" check applies to in-flight workers only. Exemption only needs to protect the task from being **failed or abandoned** by the reaper, not from having its worker killed (the worker is already done).

**Current reaper path** (`cleanupStaleWorkers` in stale-workers.ts:173+):
1. Finds workers with no update in 15+ minutes.
2. Marks them `error='Stale worker expired'`.
3. Calls `resolveStaleTask` for each affected task.
4. `resolveStaleTask` may retry, fail, or complete the task.

**Required change:**  
In `resolveStaleTask`, before the retry/fail/complete branch: check if the task is in `loopState='condition_unmet'` with a `pr_merged` exit condition. If so, leave the task as `pending` (already in this state after a condition_unmet requeue) and return early. The task's `startAt` floor already controls when the next worker will be dispatched.

**Wait expiry ceiling:**  
A `pr_merged` loop must not wait forever. Set a bounded ceiling:
- Default: **4 hours** from the most recent `loopIteration` increment.
- After ceiling: reaper may fail the task with `error='PR merge wait expired after 4h'`.
- Ceiling is stored as `loopConfig.waitExpiryMinutes` (new optional field, defaults to 240).

The ceiling prevents indefinitely stuck tasks when a PR is closed without merging. This is a **safety property** required by the design-format rules.

**Reaper must verify death before killing** (memory 48eae69a):  
For non-loop workers, the existing advice stands: check `worker.prUrl` and `worker.commitCount` before declaring the worker dead (PR #1594 already enforces this via the split try-catch in `checkWorkerDeliverables`). For loop-wait tasks, the reaper sees no in-flight worker — the task is pending — so no death-verification is needed; the reaper simply skips.

### B.4 Completion Honesty

**The bug:** The orchestrator's merge sub-task completed normally (worker PATCH with `status=completed`) saying "scheduled a check in ~2 minutes" — but the PR was not merged. The task had no `loopConfig`, so the loop dispatcher was never invoked. The next worker inherited no loop context. Stale kills followed.

**Root cause:** The task was created without `loopConfig`. The worker could not signal "condition unmet" because the loop system was not engaged.

**Fix:**  
When `merge_pr` is the intended outcome of a task, the task **must** be created with:
```json
{ "loopConfig": { "exitCondition": { "type": "pr_merged" }, "maxLoops": 6, "waitExpiryMinutes": 240 } }
```

This is enforced at task creation for tasks with `outputRequirement='pr_required'` and a merge intent — add a `loopUntilMerged` boolean shorthand to `create_task` that expands to the above config (analogous to `loopUntilVerified` which expands to a `command` loop).

**Complete_task handler guard (optional safety net):**  
As a backstop, when `complete_task` fires and `outputRequirement='pr_required'` is set on the task, check if any worker has `mergedAt IS NOT NULL`. If not, log a warning and set `loopState='condition_unmet'` + requeue, even if the worker called complete normally. This is a defensive backstop and should not replace the loop-config discipline above. Implement only if the pattern of "worker completes without merging" recurs after the loopConfig fix.

**Ordinary tasks are unaffected:** Tasks without `outputRequirement` or `loopConfig` behave exactly as today.

### B.5 Outcome-First Summaries

When the reaper auto-completes a task (stale-workers.ts:105–121), `task.result.summary` currently reads:

> *"Completed by stale-worker reaper: worker delivered 1 artifact before going offline."*

This is reaper forensics, not an outcome. The mission COMPLETION SUMMARY surface shows this text verbatim, producing the confusing headline from mission de0357c2.

**Rule:** When the reaper auto-completes a task AND the stale worker's latest artifact has a `structuredOutput.summary` field, use that as `task.result.summary`. Fall back to the current reaper forensics string only when `structuredOutput.summary` is absent.

```typescript
// In resolveStaleTask, after checkWorkerDeliverables returns hasAny=true:
const artifact = await getLatestWorkerArtifactWithStructuredOutput(staleWorker.id);
const outcomeSummary = artifact?.metadata?.structuredOutput?.summary
  ?? `Completed by stale-worker reaper: worker delivered ${deliverables.details} before going offline.`;

result: {
  summary: outcomeSummary,
  reaperAutoCompleted: true,   // extends PR #1594's contract
  reaperForensics: `Worker delivered ${deliverables.details} before going offline.`,  // NEW: moved here
  ...prFields,
}
```

**Contract extension of PR #1594:** `reaperAutoCompleted: true` is already written by the reaper. `reaperForensics` is a new sibling field that preserves the audit trail without polluting the headline. Mission and review surfaces must use `result.summary` (the outcome), not `result.reaperForensics`.

### B.6 PR Attribution Ruling

**Current state:** Missions that merge an EXISTING PR (via `merge_pr` called from an orchestrator worker) show **PRS 0** today, because the orchestrator's task is classified as `bookkeeping` and its worker's `prUrl` is excluded from the mission PR tally.

**Ruling:** The metric is renamed **"PRs merged"** (not "PRs opened"). It counts workers with `mergedAt IS NOT NULL` across tasks with `taskClass='work'` or `taskClass='attempt'` (not bookkeeping). When a `work` task's worker calls `merge_pr`, that worker's `prUrl` and `mergedAt` are already set — counted correctly.

For orchestrator-merges (bookkeeping task merges someone else's PR): the PR was **opened by a `work` task's worker**. Its `prUrl` and `mergedAt` are stamped on that worker when the webhook fires. The count is **not zero** — the PR IS counted via the `work` task's worker, regardless of who triggered the merge. The orchestrator's bookkeeping task gets no separate PR credit because it is `bookkeeping` and should not contribute to the deliverable tally.

**Consequence:** `merge_pr` called from a bookkeeping (orchestrator) worker is attributed to the PR's original work task. The webhook path already handles this — when a PR merges, the system stamps `mergedAt` on the worker that owns the matching `prUrl`, regardless of who triggered the merge API call. This is correct behavior; no schema change required.

**Defer:** A future "merge attribution" feature could stamp `mergedBy: workerId` on the PR to credit the orchestrator for the merge action. This is informational only and explicitly out of scope for this spec.

---

## Delete-List

The following code must be removed or replaced after taskClass backfill is verified:

| # | File | Lines | What to remove |
|---|---|---|---|
| D1 | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` | 285–287 | `deriveTaskType`-based `allTasksCount` predicate |
| D2 | `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` | 427–429 | `isBookkeeping` inline predicate |
| D3 | `apps/web/src/app/app/(protected)/tasks/TaskGrid.tsx` | 245 | `filter(t => !t.parentTaskId)` root/child split |
| D4 | `packages/core/mission-helpers.ts` | 283–298 | `isDeliverableTask` title-prefix match body (preserve function signature for callers; replace body with `t.taskClass === 'work'`) |
| D5 | `apps/web/src/app/app/(protected)/home/page.tsx` | 487 | `deriveTaskType(...) !== null` ACTIVITY filter |
| D6 | `packages/core/mission-helpers.ts` | 354–358 | `childrenMap` / `rootTasks` derivation in `computeMissionProgress` (replace with `attachAttempts`) |

`deriveTaskType` is **NOT deleted** — it is retained for:
1. Backfill SQL generation (during migration window).
2. `TaskTypeBadge` display subtype (`'retry' | 'review' | 'review-retry'`).

---

## Open Questions

**Q1: Where does the `loopUntilMerged` shorthand live?**  
Lean: `create_task` handler in `packages/core/mcp-tools.ts`, parallel to `loopUntilVerified`. The expansion is deterministic and requires no new schema.

**Q2: Should `taskClass` be surfaced in the API response for external clients?**  
Lean: Yes — add to `/api/tasks/[id]` and the mission tasks sub-array. Clients currently see `mode`, `category`, `parentTaskId`; `taskClass` is the canonical summary of all three.

**Q3: `waitExpiryMinutes` ceiling — 4 hours or per-task configurable?**  
Lean: 4 hours default, `loopConfig.waitExpiryMinutes` optional override. The reaper currently uses a flat 15-minute threshold; per-task ceilings are a small extension with no UX exposure needed.

---

## Implementation Sketch

Order matters: the backfill must land before the read-site deletions, and the reaper change must land before the loop extension.

1. **Migration + backfill** (schema PR): add `task_class` nullable column, run backfill SQL, add index. Enforce NOT NULL in a follow-on migration after backfill is verified.
2. **Write `taskClass` at creation time**: update `create_task`, `buildCIRetryTask`, reviewer dispatch, `mission-run.ts`, `reject-plan/route.ts`. Write `'work'` / `'attempt'` / `'bookkeeping'` explicitly.
3. **Export `isWork`, `isBookkeeping`, `isAttempt`, `attachAttempts`** from `mission-helpers.ts`. Migrate `computeMissionProgress` internals.
4. **Replace read sites (a)–(e)**: one PR per surface or batched if non-conflicting. Order: (d) `isDeliverableTask` first (core), then (a)(b) missions page, then (c) TaskGrid, then (e) home.
5. **Delete list D1–D6**.
6. **Add `pr_merged` exit condition type** to `LoopExitCondition` in shared types.
7. **Loop dispatcher + webhook**: add `pr_merged` evaluation in `evaluateExitCondition`; add `evaluateAndAdvanceLoop` call in `pull_request:closed` webhook handler.
8. **Reaper exemption**: add early-return in `resolveStaleTask` for `loopState='condition_unmet'` with `pr_merged` exit condition.
9. **`loopUntilMerged` shorthand** in `create_task`.
10. **Outcome-first summaries**: update `resolveStaleTask` to check `structuredOutput.summary`; add `reaperForensics` field.
11. **Invariant test**: replace `console.error` guard with test assertion in `task-class-invariants.test.ts`.
12. **Lint rule / grep-test**: add banned-predicate tests.

---

## Acceptance Criteria

Build tasks implementing this spec may cite these items by number.

| § | Criterion |
|---|---|
| A.1 | `tasks.task_class` column exists with values `'work'`, `'attempt'`, `'bookkeeping'`; backfill SQL covers all historical rows without changing existing mission progress counts. |
| A.2 | Every task-creation path writes `task_class` explicitly at insert time. No row is `NULL` after the NOT NULL migration lands. |
| A.3 | Read sites (a)–(e) are deleted or replaced. `grep` for `filter.*parentTaskId`, `mode.*planning.*filter`, `startsWith.*Aggregate results` in `apps/web/src/app/**` returns zero results. |
| A.3 | `isWork`, `isBookkeeping`, `isAttempt`, `attachAttempts` are the only exported selector functions in `mission-helpers.ts` for classification. `isDeliverableTask` body uses `taskClass`, not title prefixes. |
| A.4 | Before and after backfill, `SELECT count(*) FROM tasks WHERE task_class IS NULL` = 0. Mission TASKS counts for test fixtures are identical pre/post migration (except the `allTasksCount` bug fix: planning tasks no longer appear in the TASKS tile). |
| A.5 | `packages/core/__tests__/task-class-invariants.test.ts` asserts: (i) banned predicate patterns are absent from UI filter code; (ii) `PRS ≤ TASKS` for any mission task list passed to `computeMissionProgress`. |
| B.2 | `LoopExitCondition` includes `{ type: 'pr_merged' }`. `evaluateExitCondition` returns `satisfied=true` when `workerMergedAt` is non-null. |
| B.2 | `pull_request:closed (merged=true)` webhook handler calls `evaluateAndAdvanceLoop` for tasks with `exitCondition.type='pr_merged'` and `loopState='condition_unmet'`. |
| B.3 | `resolveStaleTask` returns early (no retry, no fail) for tasks with `loopState='condition_unmet'` and `exitCondition.type='pr_merged'` where `loopConfig.waitExpiryMinutes` has not elapsed. After expiry, fails with `'PR merge wait expired'`. |
| B.4 | `create_task` accepts `loopUntilMerged: true` and expands to `loopConfig: { exitCondition: { type: 'pr_merged' }, maxLoops: 6, waitExpiryMinutes: 240 }`. |
| B.5 | `resolveStaleTask` sets `task.result.summary` to `structuredOutput.summary` when present; falls back to forensics string. `task.result.reaperForensics` carries the fallback string in all cases. |
| B.6 | Mission PR tally counts `workers.mergedAt IS NOT NULL` for `work` and `attempt` tasks only. The COMPLETION SUMMARY for a task whose worker merged a PR reads the merge outcome, not reaper forensics. |
