# Task Tier Presentation Contract

**Status:** Proposed
**Related:**
- `packages/core/db/schema.ts:915` — `tasks.task_class` column definition
- `packages/core/mission-helpers.ts` — `isWork`, `isBookkeeping`, `isAttempt`, `attachAttempts`, `computeMissionProgress`, `isDeliverableTask`
- `docs/design/task-classification-and-wait.md` — Part A (taskClass column, creation paths, read-site census). Already shipped as PR #1730.
- `docs/design/derived-metric-availability.md` — DerivedMetric precedent for typed-accessor enforcement
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx:293` — the `allTasksCount` bug (includes bookkeeping in "View all N tasks")
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx:438–443` — current timeline split (`work` vs. everything else)
- Mission 04449d1d (the mission that surfaced three simultaneous denominators for one mission)

---

## Problem

Mission 04449d1d rendered 16/20 in the progress bar, 46 in "View all tasks", and 33 orchestrator runs collapsed under a single footer separator. Three denominators for the same mission. Only ~5 of the 46 rows were genuine deliverables; the rest were heartbeat planner runs, reviewer tasks, retries, and aggregators.

The `taskClass` discriminator column already exists and is correct (`'work' | 'attempt' | 'bookkeeping'`, schema.ts:915). What is missing is:

1. A settled contract mapping `taskClass` values to named presentation tiers.
2. A rule for what each numeric surface counts, stated tier-first.
3. A default-view ruling for the mission timeline (which tiers are visible without any interaction).
4. Structural enforcement that makes an untiered count unrepresentable at the type level.

---

## Current State

**`allTasksCount` (missions/[id]/page.tsx:291–293):**
```typescript
// Raw count for "View all N tasks" links — includes bookkeeping and cancelled,
const allTasksCount = (mission.tasks || []).filter(t => t.taskClass !== 'attempt').length;
```
This predicate excludes `attempt` rows but includes `bookkeeping` rows. For a mission with 5 `work`, 8 `attempt`, and 33 `bookkeeping` tasks, it returns 38 — far above the 5 deliverables the user cares about.

**Timeline split (missions/[id]/page.tsx:435–443):**
```typescript
// taskClass='work' → timeline; 'attempt'|'bookkeeping' → housekeeping footer.
const isBookkeeping = (t: typeof allTasks[0]): boolean => t.taskClass !== 'work';
const timelineTasks = allTasks.filter(t => !isBookkeeping(t));
const bookkeepingTasksRaw = allTasks.filter(t => isBookkeeping(t));
```
`attempt` and `bookkeeping` are treated identically — both go to a single collapsible "housekeeping footer". The timeline correctly renders only `work` tasks as primary cards, but retries and reviewers are not distinguished from orchestration planner runs; a reviewer that produced important feedback and a `Mission:` heartbeat look alike.

**Progress bar (packages/core/mission-helpers.ts:569–643):**
`computeMissionProgress` uses `isDeliverableTask`, whose fast path is `t.taskClass === 'work'`. Correct. No change needed here.

---

## Proposal

### 1. Presentation Tiers → `taskClass` Mapping

Three presentation tiers. Each maps to exactly one `taskClass` value. No fourth value is needed — `bookkeeping` already covers all orchestration rows.

| Presentation tier | `taskClass` value | What it represents |
|---|---|---|
| **Work** | `'work'` | Builder tasks that produce a PR or artifact. The unit of mission progress. Primary card in the timeline. |
| **Auxiliary** | `'attempt'` | Reviewer runs, CI retries, review-retries. Real agent execution over an existing deliverable. Collapses under its parent `work` task. Never a separate denominator entry. |
| **Orchestration** | `'bookkeeping'` | Code-driven coordination: heartbeat planner runs (`Mission:` title), aggregators (`Aggregate results:`), evaluators (`Evaluate mission completion:`), close tasks (`Close mission`), friction self-reports (`[friction]`). No independent deliverable. Hidden from the timeline by default. |

**`bookkeeping` covers orchestration** — the user-facing term "orchestration" is a presentational alias for `taskClass='bookkeeping'` tasks whose `mode='planning'` or whose title matches a machine-generated coordination prefix. No schema change is required. The three-way split is complete.

**`deriveTaskType()` survives in two roles** (per task-classification-and-wait.md §A.3):
1. Badge subtype label text (`'retry' | 'review' | 'review-retry'`), rendered by `TaskTypeBadge`.
2. Backfill: not needed for new rows (which are written with explicit `taskClass`).

It does NOT gate any counting or visibility decision.

---

### 2. What Each Count Means

Every numeric surface that counts tasks must declare its tier composition. A count whose tier composition is unstated is the defect. When two surfaces legitimately count differently, they must carry different labels at the point of render — the same label with different numbers is always a bug.

| Surface | Counts | Label | Current state | Action |
|---|---|---|---|---|
| Mission progress bar (numerator / denominator) | `work` only, excluding cancelled | `N / M tasks` | Correct — `computeMissionProgress` via `isDeliverableTask` fast-paths `taskClass === 'work'` | None |
| Mission list task count (`/api/missions` response) | `work` only, excluding cancelled | `N tasks` | Correct (uses `computeMissionProgress`) | None |
| **"View all N tasks"** link count | `work` only, excluding cancelled | `N tasks` | **Bug**: `t.taskClass !== 'attempt'` includes `bookkeeping` rows (missions/[id]/page.tsx:293) | Change predicate to `t.taskClass === 'work'` |
| Initiative rollup task count | Sum of child missions' `work`-only counts | `N tasks total` | Correct (follows from child mission counts) | None |
| Timeline group headers | `work` tasks in the group | `N tasks` in the group header | Correct — group count is derived from `timelineTasks` (work only) | None |
| Auxiliary inline count | `attempt` tasks under a parent work task | `→ N retries` / `→ N reviews` | Currently: attempt rows go to a shared footer with bookkeeping rows | Separate attempt nesting from bookkeeping footer (see §3) |
| `action=get` API response | Returns three separate fields | `tasks.work`, `tasks.auxiliary`, `tasks.orchestration` | Currently: single `tasks` array; no tier breakdown in the response | Add `tierCounts: TieredCount` field to the response (see §4) |

**The invariant:** The number behind "View all N tasks" must match the mission progress denominator (`computeMissionProgress.totalTasks`). These are the same concept — "how many deliverables does this mission have?" — and any divergence is a bug.

---

### 3. Default View

**Rule:** Orchestration is code-driven bookkeeping. The burden of proof is on showing it, not hiding it. A user who wants to see planner heartbeats and aggregator tasks is asking for a debug view; that view requires an explicit affordance. Retries and reviewer runs belong to a specific deliverable; they are secondary context, not a second category of invisible noise.

| Tier | Default visibility | Affordance to see more |
|---|---|---|
| Work (`'work'`) | Visible — primary timeline card | None needed (this is the resting state) |
| Auxiliary (`'attempt'`) | Collapsed under parent work task | Inline disclosure on the work card: `→ N retries` / `→ N reviews` using the subtype label from `deriveTaskType()`. Clicking expands the attempt cards inline. |
| Orchestration (`'bookkeeping'`) | Hidden | "Show N orchestration runs" toggle at the bottom of the mission timeline, distinct from the attempt disclosure. Machine-generated coordination rows; not visible by default. |

**Crux:** The current footer groups `attempt` and `bookkeeping` together as a homogeneous "housekeeping" section. Separating them matters because:
- An `attempt` row is semantically tied to a specific `work` task (via `parentTaskId`). Its context is most useful next to that parent, not at the bottom of the page with unrelated planner runs.
- A `bookkeeping` row has no parent work task — it is orchestration state. It belongs in a separate global section.

**Current footer (`bookkeepingTasksRaw = allTasks.filter(t => isBookkeeping(t))` at line 443):**
Split into two groups:
- `auxiliaryTasks`: `t.taskClass === 'attempt'` — attach to parent `work` task via `attachAttempts()` (already exported from `mission-helpers.ts:487`).
- `orchestrationTasks`: `t.taskClass === 'bookkeeping'` — feed the existing "Show orchestration" footer, now with a tier-specific label.

**Label text for the attempt disclosure** uses `deriveTaskType()` to choose the right word:
- `'retry'` or `'review-retry'` → "N retries"
- `'review'` → "N reviews"
- multiple subtypes present → "N runs"

---

### 4. Enforcement: `TieredCount`

Precedent from `DerivedMetric<T>` (docs/design/derived-metric-availability.md §5): a typed accessor makes an unguarded access a compile error.

Apply the same pattern to task counts. A raw `number` used as a task count does not tell the reader — or the compiler — which tiers it includes.

```typescript
// packages/core/task-count.ts (new file)
export type TieredCount = {
  readonly kind: 'tiered';
  readonly work: number;
  readonly auxiliary: number;
  readonly orchestration: number;
};

/** Build a tier-broken-down count from any task list with a taskClass field. */
export function countByTier(
  tasks: ReadonlyArray<{ taskClass?: string | null; status?: string | null }>,
  opts?: { excludeCancelled?: boolean },
): TieredCount {
  let work = 0, auxiliary = 0, orchestration = 0;
  for (const t of tasks) {
    if (opts?.excludeCancelled && t.status === 'cancelled') continue;
    if (t.taskClass === 'work') work++;
    else if (t.taskClass === 'attempt') auxiliary++;
    else if (t.taskClass === 'bookkeeping') orchestration++;
  }
  return { kind: 'tiered', work, auxiliary, orchestration };
}
```

Any call site that renders a single count must extract the tier field explicitly:

```typescript
const counts = countByTier(mission.tasks, { excludeCancelled: true });
// Reviewer can see what tier this number represents:
renderCount(counts.work);
// Passes without thought:
renderCount(counts.work + counts.auxiliary);  // explicitly labelled as "work + auxiliary"
// This is the banned pattern — no field named 'total':
renderCount(counts.total);  // TS2339: Property 'total' does not exist
```

**`action=get` API response change:**
Add `tierCounts: TieredCount` to the mission detail and mission list response shapes. This allows API callers (MCP `manage_missions action=get`, the dashboard, and the runner) to get the tier breakdown without a separate query.

```typescript
// In the API response for /api/missions/[id] and /api/missions:
{
  // existing fields
  tierCounts: countByTier(mission.tasks, { excludeCancelled: true }),
}
```

**Code lever:** The `kind: 'tiered'` discriminant makes the shape nominal. A function that accepts `TieredCount` will not compile if passed a raw number or an object without the `kind` field. Any new route that adds a task count must use `countByTier` or extract `.work` explicitly, making the tier choice visible at the call site.

**Where there is no code lever:** For presentation code in React components, the compiler cannot prevent a developer from reading `allTasks.length` directly. The structural guard here is the banned-predicate test (from task-classification-and-wait.md §A.5, already in `packages/core/__tests__/task-class-invariants.test.ts`). Extend it with one additional banned pattern for the mission task-count context:

```typescript
// Additional banned pattern in task-class-invariants.test.ts:
// No route or page may filter tasks for a count using taskClass !== 'attempt'
// (the old predicate that this spec replaces).
/\.filter\(.*taskClass\s*!==\s*['"]attempt['"]\s*\)\.length/,
```

This catches the exact bug at missions/[id]/page.tsx:293 if it is reintroduced.

---

## Open Questions

**Q1: Should `attempt` disclosure be per work task (inline expansion) or per timeline group (all retries for a group)?**
Lean: per work task. A reviewer run and a CI retry for task A are contextually irrelevant when reading task B. The `attachAttempts()` helper already builds the per-task map.

**Q2: Should `orchestration` tasks be completely excluded from the API `tasks` array in `action=get`, or always included?**
Lean: always included in the raw `tasks` array (no break in the shape contract), but add `tierCounts` so callers can filter client-side without re-deriving. Excluding `bookkeeping` rows server-side would break any caller that currently iterates `tasks` to find the orchestrator's result summary.

**Q3: Should "View all N tasks" open a filtered view (work only) or the unfiltered view?**
Lean: open the unfiltered view (all tasks, all tiers) but pre-select the "Work" filter tab. The full list retains its utility for debugging; the default entry is the filtered view matching the progress bar's denominator.

---

## Non-goals

- New DB columns or schema changes. All three tiers are already expressed by `taskClass`.
- Changes to `computeMissionProgress` progress calculation — it is already correct.
- Retroactive re-classification of historical `taskClass` values — the backfill from task-classification-and-wait.md §A.4 is already shipped.
- Mobile-specific presentation rules — those follow from this contract but are deferred.
- The `Evaluate mission completion:` task's result display in the COMPLETION SUMMARY section — that is a separate concern from tier visibility.

---

## Builder Breakdown

Each task owns a non-overlapping path set. The organizer files these tasks once this spec is approved.

### Task A — Fix `allTasksCount` and add `TieredCount` core type

**pathManifest:**
- `packages/core/task-count.ts` (new)
- `packages/core/__tests__/task-count.test.ts` (new)
- `packages/core/index.ts` (or whatever the package entry point is — export `countByTier`, `TieredCount`)

**Work:**
1. Create `packages/core/task-count.ts` with `TieredCount` type and `countByTier()` as specified in §4.
2. Export from the core package.
3. Tests: `countByTier` for a mixed list; `excludeCancelled` option; `work` count matches `computeMissionProgress.totalTasks` for the same input.

**Depends on:** Nothing. Ships first; B and C depend on it.

---

### Task B — Fix "View all N tasks" count and `allTasksCount` predicate

**pathManifest:**
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx`
- `packages/core/__tests__/task-class-invariants.test.ts`

**Work:**
1. Change `allTasksCount` predicate (line 293) from `t.taskClass !== 'attempt'` to `t.taskClass === 'work'` (using `countByTier(...).work` or the `isWork` selector from `mission-helpers.ts`).
2. Add the banned-predicate extension to `task-class-invariants.test.ts` (the `taskClass !== 'attempt'` pattern).
3. Verify that the "View all N tasks" number matches `timelineTasks.length` (the progress denominator). These are both `work` counts; they must agree.

**Depends on:** Task A (for `countByTier`; can use `isWork` directly if A is not yet merged).

---

### Task C — Separate auxiliary (attempt) from orchestration (bookkeeping) in the timeline footer

**pathManifest:**
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` (timeline grouping logic, lines 435–443 and downstream)
- `apps/web/src/components/condensed-timeline/` (or wherever `CondensedTimeline` and `BookkeepingTask` are defined — the footer rendering)

**Work:**
1. Split the current `bookkeepingTasksRaw` array into:
   - `auxiliaryTasks`: `t.taskClass === 'attempt'` — group by `parentTaskId` using `attachAttempts()`.
   - `orchestrationTasks`: `t.taskClass === 'bookkeeping'`.
2. For each `work` task in the timeline, attach its `auxiliaryTasks` and render the inline disclosure (`→ N retries` / `→ N reviews`) using `deriveTaskType()` for the label text.
3. The `orchestrationTasks` remain in the existing collapsible footer, now labelled "Show N orchestration runs" instead of "housekeeping".
4. Update `CondensedTimeline` props accordingly (split `bookkeepingTasks` prop into `auxiliaryTasksByParent` and `orchestrationTasks`).

**Depends on:** Task A (for `TieredCount`; `attachAttempts` is already available).

---

### Task D — Add `tierCounts` to `action=get` API response

**pathManifest:**
- `apps/web/src/app/api/missions/[id]/route.ts`
- `apps/web/src/app/api/missions/route.ts`
- `packages/shared/src/types.ts` (add `TieredCount` to shared API types if needed)

**Work:**
1. Import `countByTier` from the core package.
2. Add `tierCounts: countByTier(tasks, { excludeCancelled: true })` to the API response for both the detail route and the list route.
3. Update `packages/shared/src/types.ts` if the `Mission` type is defined there — add `tierCounts?: TieredCount`.
4. The existing `tasks` array in the response is unchanged — `tierCounts` is additive.

**Depends on:** Task A.

---

### Path Overlap Check

| File | Task |
|---|---|
| `packages/core/task-count.ts` | A only |
| `packages/core/__tests__/task-count.test.ts` | A only |
| `packages/core/index.ts` | A only |
| `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` | B (allTasksCount fix) and C (timeline split) — these two tasks touch the same file. File these as a single PR if the builder is the same agent, or sequence B before C if separate. No path overlap between B and C edits: B touches lines 291–293 and the invariant test; C touches lines 435–443 and downstream components. |
| `packages/core/__tests__/task-class-invariants.test.ts` | B only |
| `apps/web/src/components/condensed-timeline/` | C only |
| `apps/web/src/app/api/missions/[id]/route.ts` | D only |
| `apps/web/src/app/api/missions/route.ts` | D only |
| `packages/shared/src/types.ts` | D only |

**Note on B + C sharing `missions/[id]/page.tsx`:** Because they touch non-overlapping line ranges (B at line 293, C at 435–443), they can be filed as separate tasks with a `dependsOn` relationship (C depends on B), or merged into a single task. The organizer should choose based on the builder's context window — if this is a large page, splitting is safer.
