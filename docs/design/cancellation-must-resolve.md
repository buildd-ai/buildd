# Cancellation Must Resolve: Edge Semantics, Disposition, and Stranded Detection

**Status:** Proposed  
**Related:**
- `apps/web/src/app/api/workers/claim/deps-gate.ts` — `DEP_SATISFYING_STATUSES`, `dependenciesSatisfied` SQL
- `apps/web/src/lib/task-dependencies.ts` — `checkDependsOnResolved`, `resolveCompletedTask`
- `apps/web/src/lib/task-presentation.ts` — `isGateSatisfied` (line 210)
- `apps/web/src/lib/condensed-timeline.ts` — `allDepsGateSatisfied`, `TimelineGroups`, `waitingOnYou`
- `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` — Waiting on you section
- `apps/web/src/app/app/(protected)/home/page.tsx` — `waitingOnYou`, `buildActionQueue`
- `packages/core/db/schema.ts` — `tasks.dependsOn` (jsonb string[]), `tasks.pathManifest`
- `packages/core/mission-helpers.ts` — `computeMissionProgress`, `evaluateGoalCriteria`, `no_open_tasks`
- `packages/core/mcp-tools.ts` — `update_task`, `create_task` action handlers
- `apps/web/src/app/api/tasks/[id]/route.ts` — cancel PATCH handler (line 291)
- docs/design/task-classification-and-wait.md — `taskClass` discriminator spec
- docs/design/review-gate-ux.md — `mergedAt` gate, `isGateSatisfied` contract

---

## Problem

Task `875ff446` ("Budget Forecast UI: stop presenting a p25 floor as high confidence") has sat `pending` for >24h. Its two `dependsOn` parents (`2ba59fa1`, `f5129ca0`) are both `cancelled`. The claim gate (`deps-gate.ts:18`) lists `cancelled` as a satisfying status — if the dependent were dispatched it would be claimable. But it never is: `checkDependsOnResolved` fires only on task completion (called from the PR-merge webhook, the merge route, the loop dispatcher, and the PR state refresher), never on cancellation. The dependent sits invisible in the `pending` pool indefinitely.

Three compounding defects:

1. **No dispatch on cancel.** `apps/web/src/app/api/tasks/[id]/route.ts` line 291 handles `status === 'cancelled'` by pushing an abort command to any active worker and optionally checking dormancy — but never calls `checkDependsOnResolved` or any equivalent. Dependents are never woken.

2. **No edge type.** `tasks.dependsOn` (`packages/core/db/schema.ts:828`) is a plain `string[]`. All edges are homogeneous — neither the claim SQL nor any display logic can distinguish "I need the parent's output" from "I just need to run after the parent." The claim gate happens to treat `cancelled` as satisfying (a reasonable footgun-prevention heuristic), but this is not a contract and there is no way to express a genuine data dependency.

3. **No stranded detection.** A pending task whose hard-edge parents are permanently terminal-but-not-completed is invisible: the mission shows 75% with its PR merged while carrying an unclaimable task; no alert surfaces, no queue entry appears, the `no_open_tasks` goal criterion silently fails.

Separately: `isGateSatisfied` (`task-presentation.ts:210`) requires `dep.status === 'completed'` and never returns `true` for a `cancelled` dep — contradicting the claim SQL that already treats cancelled as satisfying. This means `condensed-timeline.ts:allDepsGateSatisfied` puts tasks whose only blocker is a cancelled parent in the `blocked` group, not `nextQueued`, even though the claim route would serve them immediately.

---

## Non-goals

- Changing what causes a task to be cancelled in the first place.
- Reworking pathManifest edge generation beyond classifying existing edges as soft.
- Any implementation — this doc files the contract; build tasks are created after review.
- Making `stranded` a stored `tasks.status` value — it is derived from existing columns and must remain so.

---

## Current State

```
deps-gate.ts:18   export const DEP_SATISFYING_STATUSES = ['completed', 'cancelled'] as const;
task-presentation.ts:214   if (dep.status !== 'completed') return false;  // never true for cancelled
task-dependencies.ts:309   // Fired on: PR merge webhook, merge route, loop dispatcher, PR state refresh.
                            // NOT fired on: cancel.
tasks/[id]/route.ts:291   if (status === 'cancelled') { /* abort push, no dep wakeup */ }
```

---

## Part A: Edge Semantics

### A.1 Edge Types

Every dependency edge is either **soft** or **hard**.

| Type | Semantics | Satisfied by |
|------|-----------|-------------|
| **soft** | Ordering / serialization constraint. Dependent can proceed once the parent exits, regardless of how. | Any terminal status: `completed`, `cancelled`, `failed` |
| **hard** | Data dependency. Dependent consumes the parent's output and cannot proceed without it. | `completed` only (plus PR merged if the parent produced one); a cancelled or failed hard-edge parent leaves the dependent **unresolvable** |

**pathManifest-derived edges** are always soft. They are ordering/path-lock constraints injected at claim time to prevent parallel workers touching the same files. They carry no output dependency. When a pathManifest parent cancels, the lock is vacated and the dependent can proceed.

**Explicit `dependsOn` edges** declared via `create_task` default to **hard**. Most hand-declared edges express "I need the result of that task" — the correct default. Agents may opt out by passing `edgeType: 'soft'` per edge (see §A.2).

### A.2 Schema Change

`tasks.dependsOn` (`packages/core/db/schema.ts:828`) changes from a plain `string[]` to a typed array:

```typescript
// Each element is either a bare ID string (legacy / soft) or a typed object.
type DependsOnElement = string | { id: string; edgeType: 'hard' | 'soft' };

// Column type after migration:
dependsOn: jsonb('depends_on').default([]).$type<DependsOnElement[]>();
```

**Backward compatibility:** bare string elements are treated as **soft** — this matches the current claim-route behavior (cancelled satisfies). No existing task becomes stranded by the migration.

**pathManifest-derived edges** are written as `{ id: ..., edgeType: 'soft' }` objects by the orchestrator code that computes overlap and calls `addDependsOn` (see `packages/shared/src/types.ts:OverlapEdge`). Existing pathManifest-derived entries are bare strings → soft → no change in gate behavior.

**New explicit edges** written by `create_task` are `{ id: ..., edgeType: 'hard' }` by default. The API parameter is:

```
dependsOn?: Array<string | { id: string; edgeType?: 'hard' | 'soft' }>
```

A bare string in the API input defaults to `edgeType: 'hard'` on write (new behavior after this ships). This matches agent intent: if you name a dependency in `create_task`, you mean it.

### A.3 Migration Default for Pre-existing Edges

All pre-existing `dependsOn` rows remain as bare strings, which are treated as **soft**. The backfill (Part D) identifies tasks that are stranded under the conservative assumption that all legacy edges behave as hard; the soft-default prevents the migration itself from stranding anything new.

### A.4 Gate Updates

Two read sites must be updated:

**`deps-gate.ts:dependenciesSatisfied`** — currently treats both `completed` and `cancelled` as satisfying for all edges. After migration, the SQL distinguishes:
- Elements where `edgeType = 'soft'` (or element is a bare string): satisfied by `completed`, `cancelled`, or `failed`
- Elements where `edgeType = 'hard'`: satisfied by `completed` only (plus PR merged check)

The SQL fragment must parse the JSONB element to extract `id` and `edgeType`. This replaces the flat `jsonb_array_elements_text` call with a normalized read that handles both legacy strings and typed objects.

**`isGateSatisfied` (`task-presentation.ts:210`)** — currently requires `status === 'completed'`. It must gain a `edgeType` parameter (default `'soft'`) and return `true` for `cancelled` or `failed` when `edgeType === 'soft'`. All callers that derive this from the dependency list must pass the correct type.

```typescript
export function isGateSatisfied(
  dep: { status: string },
  depWorkers: Array<{ prUrl: string | null; mergedAt: string | null }>,
  edgeType: 'hard' | 'soft' = 'soft',   // NEW parameter; legacy callers default to soft
): boolean {
  if (edgeType === 'soft') {
    return ['completed', 'cancelled', 'failed'].includes(dep.status)
      && !depWorkers.some((w) => w.prUrl !== null && w.mergedAt === null && dep.status === 'completed');
  }
  // hard
  if (dep.status !== 'completed') return false;
  return !depWorkers.some((w) => w.prUrl !== null && w.mergedAt === null);
}
```

`allDepsGateSatisfied` in `condensed-timeline.ts:69` must pass `edgeType` derived from the stored element type.

---

## Part B: Disposition Contract at Cancel Time

### B.1 Cancel as a Distinct Operation

Cancellation is today a generic field write: `PATCH /api/tasks/:id { status: 'cancelled' }`. There is no point in this path where downstream effects on dependents can be computed or asked for. The fix introduces a **distinct cancel operation** that carries a required `dependentDisposition` when the task has pending dependents.

**MCP surface** — new action `cancel_task`:

```
cancel_task: {
  taskId: string;                              // required
  dependentDisposition?: 'unblock' | 'cascade' | 'escalate';
    // Required when the task has one or more pending dependents (hard-edge
    // only, in the steady-state; soft-edge dependents are auto-unblocked
    // because the gate already satisfies on terminal status).
    // No default — the agent must decide. Cancelling a task with no hard-edge
    // pending dependents accepts no disposition and succeeds in a single call.
  reason?: string;                             // audit trail
}
```

**UI surface** — the cancel button in the task detail row and the mission timeline:
- When the task has **no hard-edge pending dependents**: cancels immediately, no modal.
- When the task has **one or more hard-edge pending dependents**: opens a modal that names each affected task (title + status) and offers the three-option selector, pre-selecting `unblock`. Confirm commits the cancel with the chosen disposition.

**`update_task status='cancelled'`** (existing MCP action) continues to work for tasks with no hard-edge dependents and for backward-compat callers. When it is called on a task that has hard-edge pending dependents, it defaults to disposition `unblock` (the safest non-blocking choice) and logs a warning that the explicit `cancel_task` action should be used. It does not reject — that would break existing agents.

### B.2 Disposition Semantics

#### `unblock`

Drop the hard edge between the cancelled parent and each pending dependent. Concretely: for each dependent, rewrite its `hardDependsOn` list removing the cancelled parent's ID. The element in `dependsOn` remains (for audit), but its `edgeType` is downgraded from `hard` to `soft`. The gate re-evaluates immediately: if all remaining hard deps are satisfied, call the cancellation equivalent of `checkDependsOnResolved` to dispatch the dependent.

**Expected default.** Most cancels are supersede/dedupe kills (the work turned out to be redundant), not invalidations. The dependent's description often remains valid independently.

**Disposition propagation:** `unblock` does not recurse. It acts only on direct hard-edge dependents of the cancelled task. If a dependent itself has further dependents, those are unaffected — they depend on the now-unblocked task, which is still pending and will complete normally.

#### `cascade`

Cancel all pending hard-edge dependents transitively, applying the same `cascade` disposition at each level. Semantics:

- **Depth:** recursive, unbounded. The cascade stops when it reaches a task with no pending hard-edge dependents, or a task that is already terminal.
- **Cycle guard:** a set of visited task IDs is maintained; if a cycle is detected (a dependent was already seen in the current cascade), that branch stops without error.
- **Active workers:** if a task being cascaded has a live worker (status `assigned`, worker status `running`/`starting`/`idle`/`waiting_input`), the cascade sends an abort command to the worker (same abort push used by the existing cancel handler, `tasks/[id]/route.ts:305`) and sets the task to `cancelled`. The worker may still complete — if it does after the cancel, the standard post-complete logic runs but the task status is already terminal so no loop dispatch fires.
- **Re-prompt:** cascade does NOT re-prompt at each depth level. The original disposition cascades uniformly. Adding an interactive confirmation per depth would make cascades unusable for long chains.
- **Result:** the cancel API returns the list of transitively cancelled task IDs so the caller can confirm scope.

#### `escalate`

Hold the dependent as `pending` (do not dispatch it, do not cancel it) and surface it in the Waiting on you queue with a note explaining why it is blocked. The hard edge is retained. The task is now **stranded** (by the definition in Part C) and is treated identically to any other stranded task: visible in Waiting on you, excluded from active progress, inline unblock/cancel actions available.

Use this when you are unsure whether the dependent is still valid and want a human to decide.

### B.3 Write Path

The implementation of `cancel_task` must:
1. Validate that the task is not already terminal.
2. Fetch all pending tasks whose `dependsOn` JSONB contains the target ID with `edgeType = 'hard'` (or bare string treated as hard).
3. If dependents exist and `dependentDisposition` is absent: reject with a descriptive error naming the affected tasks.
4. Apply the disposition (§B.2).
5. Write `tasks.status = 'cancelled'` on the target task.
6. Abort any live worker on the target task.
7. For `unblock`: call the cancellation wakeup function (equivalent to `checkDependsOnResolved` but triggered by a cancel event, not a completion event) for each newly unblocked dependent. This fires a `TASK_UNBLOCKED` Pusher event and re-dispatches the task into the claim pool.
8. Emit a structured cancel event via `emit_event` including `{ disposition, affectedTaskIds }` for audit.

The cancellation wakeup function is **not a new mechanism** — it is `checkDependsOnResolved` called with the cancelled task ID, after the gate is updated to recognize soft edges as satisfied by `cancelled`. The existing function already checks whether all other deps of each dependent are resolved before dispatching. No new dispatch path is needed; only the trigger point changes.

---

## Part C: Stranded Detection

### C.1 Definition

A task is **stranded** when it satisfies all three conditions simultaneously:

```sql
-- Stranded condition (computable against existing + new columns)
tasks.status = 'pending'
AND EXISTS (
  SELECT 1
  FROM jsonb_array_elements(tasks.depends_on) AS elem
  JOIN tasks dep
    ON dep.id = (
      CASE jsonb_typeof(elem)
        WHEN 'string' THEN elem #>> '{}'       -- bare string = legacy soft → skip
        WHEN 'object' THEN elem->>'id'
      END
    )::uuid
  WHERE
    -- hard edge
    (jsonb_typeof(elem) = 'object' AND elem->>'edgeType' = 'hard')
    -- parent is terminal but not completed
    AND dep.status IN ('cancelled', 'failed')
)
```

**Stranded is derived, not stored.** It is not a new value in `tasks.status`. This is load-bearing: the derived condition can be evaluated against existing rows immediately, before any write-path work ships. The backfill sweep (Part D) uses it to surface the current backlog without any schema prerequisite.

### C.2 Where Stranded Tasks Surface

**Waiting on you queue** — both the mission condensed timeline (`CondensedTimeline.tsx`) and the home page action queue (`home/page.tsx:buildActionQueue`) must include stranded tasks.

A stranded task row in Waiting on you shows:
- Task title and mission name
- "Stranded" label (distinct from the "Waiting" label used for tasks awaiting human PR review)
- Duration: how long the task has been in `pending` state (using `tasks.createdAt`)
- Blocking parent names: the list of terminal-non-completed hard-edge parents with their final status and cancellation date
- Two inline actions: **Unblock** (drop hard edges, dispatch the task) and **Cancel** (cancel the stranded task)

The Waiting on you group in `TimelineGroups` (`condensed-timeline.ts:33`) adds:

```typescript
/** Pending tasks with hard-edge parents that are terminal but not completed. Unresolvable without intervention. */
stranded: T[];
```

Stranded tasks are removed from the `blocked` group (where they currently appear, silently mixed with legitimately-blocked tasks).

### C.3 Mission Progress and Goal Criteria

**Active progress:** `computeMissionProgress` (`mission-helpers.ts:373`) must exclude stranded tasks from the `open` count that drives the progress bar. They are open in status but are not work-in-flight. They should appear as a fourth progress segment (alongside running, queued, done) or be shown as a separate count below the bar — the exact visual treatment is out of scope for this doc and belongs to a UI design pass.

**`no_open_tasks` goal criterion** (`mission-helpers.ts:145`): stranded tasks are still `pending` and therefore block this criterion from passing. This is correct — the mission is not done if it carries work that will never execute without intervention. The criterion must not be modified to silently skip stranded tasks; it must fail explicitly, and the criterion evaluation `evidence` string must name the stranded tasks by title so the evaluator knows what is blocking.

```typescript
// Updated no_open_tasks evaluation (mission-helpers.ts:evaluateGoalCriteria)
case 'no_open_tasks': {
  const deliverable = context.tasks.filter(isDeliverableTask);
  const stranded = deliverable.filter(isStranded);
  const open = deliverable.filter(t =>
    !['completed', 'cancelled', 'failed'].includes(t.status)
  );
  verdict = open.length === 0 ? 'pass' : 'fail';
  const strandedNote = stranded.length > 0
    ? ` (${stranded.length} stranded — requires intervention)`
    : '';
  evidence = open.length === 0
    ? `All ${deliverable.length} deliverable task(s) are closed`
    : `${open.length} task(s) still open${strandedNote}: ${open.map(t => t.title).join(', ')}`;
  break;
}
```

`isStranded(task)` is a pure function over the task's `dependsOn` and a map of dependency statuses — it does not require a DB call at evaluation time because `evaluateGoalCriteria` already receives the full task list with dependency info.

### C.4 Invariant

A stranded task must never silently disappear from the Waiting on you queue. If a hard-edge parent is later un-cancelled (e.g., its status is set back to `pending`), the stranded condition clears automatically because the derived query no longer matches. If the stranded task itself is cancelled or completed by a human, it exits the queue through normal terminal state logic.

---

## Part D: Backfill Sweep

### D.1 Purpose

The current codebase has no hard/soft column yet. The backfill sweep identifies all tasks that are observably stranded under the conservative assumption that all edges are hard. It reports but does not auto-resolve — disposition is a judgement call.

### D.2 Query

```sql
-- Stranded tasks (conservative: treats all deps as hard, pre-migration)
SELECT
  t.id,
  t.title,
  t.status,
  t.created_at,
  t.mission_id,
  m.title AS mission_title,
  t.depends_on,
  array_agg(
    json_build_object(
      'id', dep.id,
      'title', dep.title,
      'status', dep.status,
      'cancelled_at', dep.updated_at
    )
  ) AS terminal_parents
FROM tasks t
LEFT JOIN missions m ON m.id = t.mission_id
JOIN tasks dep
  ON dep.id IN (SELECT jsonb_array_elements_text(t.depends_on)::uuid)
WHERE
  t.status = 'pending'
  AND dep.status IN ('cancelled', 'failed')
GROUP BY t.id, t.title, t.status, t.created_at, t.mission_id, m.title, t.depends_on
ORDER BY t.created_at ASC;
```

**Known entry:** task `875ff446` with parents `2ba59fa1` and `f5129ca0` (both `cancelled`) in mission `d480b1fd`. The sweep will surface it and any others in the same condition.

### D.3 Output Format

The sweep produces a report artifact attached to the backfill task, containing for each stranded task:
- Task ID and title
- Mission name (if any)
- Stranded since (duration since `tasks.created_at`)
- Blocking parents: ID, title, final status, date of termination
- Recommended disposition: `unblock` when the task description is independent of the parent's output; `cascade` when the task was derived from the parent and has no standalone value; `escalate` when unclear

The recommendation is advisory. A human or an agent with context reads the report and applies the appropriate `cancel_task` disposition per task. The sweep does not write any state.

### D.4 Frequency

The sweep runs once as a one-time task after this spec ships. If the stranded detection from Part C lands in the UI (Part C.2), the sweep is no longer needed as a standalone operation — Waiting on you surfaces live stranded tasks continuously.

---

## Open Questions

**Q1: Should `failed` deps also satisfy soft-edge dependents?**  
Lean: yes. A soft edge is an ordering constraint; once the parent has exited (for any reason), the ordering constraint is vacated. A failed parent doesn't invalidate the ordering relationship — the downstream work is still valid. Consistent with the existing spirit of `DEP_SATISFYING_STATUSES` expanding as we learn more footguns.

**Q2: Should `update_task status='cancelled'` silently default to `unblock` for hard-edge dependents, or should it reject?**  
Lean: silent `unblock` with a warning log. Rejecting would break existing agent callers that use `update_task` to cancel tasks. Agents are not yet aware of `cancel_task`. The silent default surfaces disposition decisions gradually; a future deprecation warning can nudge agents to switch.

**Q3: Does the stranded visual segment in the mission progress bar need its own color?**  
Lean: yes, but out of scope for this doc. A neutral/warning color distinct from the active (blue) and done (green) segments. File a UI design task after this spec is accepted.

**Q4: Should cascade stop at mission boundaries?**  
Lean: yes. Cascading across missions would cancel work in a sibling mission that may be independently valid. Cascade traverses only tasks within the same `missionId` as the original cancelled task (or tasks with no mission if the original has no mission). Cross-mission hard-edge dependents receive `escalate` by default when cascade is chosen.

---

## Implementation Sketch

Order is important — stranded detection (Part C) can ship independently of the disposition contract (Part B), because stranded is derived from existing columns. Edge types (Part A) must ship before disposition is enforced at the write path.

1. **Backfill sweep** (no schema required): run the D.2 query, produce the report artifact. Resolves `875ff446` and any peers. This is the load-bearing immediate action.
2. **Schema: `dependsOn` element type** (Part A.2): migrate from `string[]` to `DependsOnElement[]`. Keep bare strings valid. No data migration needed — existing bare strings are soft by the new contract.
3. **Gate updates** (Part A.4): update `deps-gate.ts:dependenciesSatisfied` to parse typed elements; update `isGateSatisfied` signature and callers. Add `edgeType` to `isGateSatisfied` calls in `allDepsGateSatisfied` and `deriveChainPosition`.
4. **`cancel_task` MCP action** (Part B): implement in `packages/core/mcp-tools.ts`. Wire the cancellation wakeup (call `checkDependsOnResolved` after updating edge types for `unblock`). Implement cascade with depth-first traversal and cycle guard.
5. **Cancel PATCH handler** (Part B.3): update `apps/web/src/app/api/tasks/[id]/route.ts:291` to call `cancel_task` logic, defaulting to `unblock` for backward compat.
6. **Stranded query** (Part C.1): extract as a shared utility (e.g., `lib/stranded-tasks.ts`) for use by the UI and goal criteria.
7. **Waiting on you + mission progress** (Part C.2–3): update `condensed-timeline.ts`, `CondensedTimeline.tsx`, `home/page.tsx`, and `mission-helpers.ts:evaluateGoalCriteria`.
8. **UI cancel modal** (Part B.1): add the disposition selector to the task cancel UI, only when hard-edge dependents exist.

---

## Acceptance Criteria

Build tasks implementing this spec may cite these items by number.

| § | Criterion |
|---|---|
| A.2 | `tasks.dependsOn` elements accept `{ id: string; edgeType: 'hard' \| 'soft' }` objects alongside bare strings. Bare strings are treated as soft in all gate logic. |
| A.2 | `create_task` writes `{ id, edgeType: 'hard' }` for each explicitly passed dependency (default). Accepts `edgeType: 'soft'` override per element. pathManifest-derived edges are always written as soft. |
| A.3 | All pre-existing bare-string elements in `tasks.dependsOn` are treated as soft. No existing task becomes stranded as a result of the migration. |
| A.4 | `dependenciesSatisfied()` in `deps-gate.ts` satisfies hard edges on `completed` only; satisfies soft edges on `completed`, `cancelled`, and `failed`. |
| A.4 | `isGateSatisfied` accepts `edgeType` parameter, returns `true` for `cancelled`/`failed` when `edgeType === 'soft'`. All callers in `condensed-timeline.ts` and `task-presentation.ts` pass correct `edgeType`. |
| B.1 | `cancel_task` MCP action exists and is documented in the action schema. |
| B.1 | `cancel_task` requires `dependentDisposition` when the task has pending hard-edge dependents; accepts no disposition for tasks with no hard-edge dependents. |
| B.2 | `unblock` disposition: downgrade hard edges to soft, call `checkDependsOnResolved` (or equivalent) for each newly unblocked dependent. The dependent appears in the claim pool within one poll cycle. |
| B.2 | `cascade` disposition: cancels all pending hard-edge dependents transitively; cycle guard prevents infinite loops; active workers receive abort command; returns list of cancelled task IDs. |
| B.2 | `cascade` does not cross mission boundaries; cross-mission hard-edge dependents are escalated. |
| B.2 | `escalate` disposition: task remains pending, surfaces immediately in Waiting on you with stranded label. |
| B.3 | `update_task status='cancelled'` on a task with hard-edge pending dependents silently applies `unblock` and logs a deprecation warning. Does not reject. |
| C.1 | Stranded query correctly identifies tasks where `status = 'pending'` and any hard-edge dep is in `cancelled` or `failed`. |
| C.2 | Stranded tasks appear in Waiting on you (mission timeline and home page) with stranded label, duration, blocking parent names, and inline Unblock / Cancel actions. |
| C.2 | Stranded tasks are NOT in the `blocked` group of `TimelineGroups`. |
| C.3 | `computeMissionProgress` excludes stranded tasks from the active-work count. |
| C.3 | `no_open_tasks` goal criterion fails when stranded tasks are present; `evidence` string names the stranded tasks and notes they require intervention. |
| D.3 | Backfill sweep produces a report artifact naming at minimum task `875ff446` and its two cancelled parents. |
| — | No occurrence of "release" as a verb or action name for unblocking a dependency gate anywhere in the implementation. Use "unblock" throughout: enum values, UI labels, event names, code identifiers. |
