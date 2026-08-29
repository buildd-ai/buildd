# DerivedMetric Availability Contract

**Status:** Proposed
**Related:**
- `packages/core/derived-metric.ts` — existing type shipped by PR #1897
- `apps/web/src/components/DerivedMetricDisplay.tsx` — existing render primitive
- `packages/core/mission-helpers.ts` — `computeMissionProgress`, `computeInitiativeProgress`, `evaluateGoalCriteria`
- `apps/web/src/lib/release-readiness.ts` — `computeReleaseWidgetDecision`
- `docs/design/status-reconciliation.md` — where `CachedVerdict<T>` was proposed (never implemented)
- Mission: Empty-source rendering (04449d1d)

---

## Problem

Three bugs share the same shape: a derived number, percentage, or verdict is computed against an empty or uninitialized source and rendered as if it were a real measured value.

1. **Release queue null baseline** — `queueDepth` is `workers.mergedAt > last releases row`. When no releases row exists, the null baseline silently degrades to epoch and counts every ever-merged worker. The home page displayed `859 unshipped · oldest 193d ago` while `release_status` reported 4 commits ahead of main. `0 unshipped` and `859 unshipped` are both wrong in the same way: a number implies a pipeline that exists and has been measured.

2. **Goal criteria zero-set auto-pass** — `evaluateGoalCriteria` in `packages/core/mission-helpers.ts` returns `overall: 'pass'` when `criteria.length === 0` (line 212: `results.length === 0 ? 'pass'`). A mission with no goal criteria evaluates as "all criteria met," indistinguishable from a mission that genuinely passed all of its checks.

3. **Initiative denominator inflation** — `computeInitiativeProgress` is task-weighted: when a new undecomposed mission is added (0 tasks), it contributes nothing. But when that mission plans its tasks (goes from 0 to N pending tasks), `totalTasks` grows immediately while `completedTasks` stays the same, so the initiative percentage falls. Discovered scope becomes a retroactive penalty.

All three share one root: **the call site chose a silent fallback** (epoch, auto-pass, 0%) instead of naming the absent-input case and letting the render layer decide what to show.

The spec already contains the correct ruling for one instance: the `none` release archetype renders NOTHING, never `0 unshipped`, because a number implies a pipeline that does not exist. This contract generalises that ruling.

---

## Current State

PR #1897 shipped a `DerivedMetric<T>` discriminated union:

```ts
// packages/core/derived-metric.ts (as of PR #1897)
export type DerivedMetric<T> =
  | { kind: 'value'; value: T }
  | { kind: 'unavailable'; reason: string }
```

The `reason` is an untyped string. `DerivedMetricDisplay` renders a neutral em-dash on `unavailable` and uses `reason` as a tooltip, but does not branch on the reason value. No existing call site has migrated to the type yet — the three bug-fix builder tasks (61c380cd, 4e08dd7c, c3ea1d05) are still pending.

`CachedVerdict<T>` — referenced in `docs/design/status-reconciliation.md` (PR #1630) — **does not exist in code** (confirmed via grep across `packages/`). It is a proposed concept only.

---

## Proposal

### 1. The type

Narrow `reason` from `string` to a typed enum. Three reasons, derived from the actual bug inventory — no invented cases, no collapsed cases:

```ts
export type DerivedMetricReason =
  | 'no_baseline'    // no historical record to derive from (null releases row, no usage history)
  | 'no_scope'       // input set is empty — there is nothing to count yet (0 tasks, 0 criteria)
  | 'not_evaluated'  // a verdict could be computed but has not been run yet

export type DerivedMetric<T> =
  | { kind: 'value'; value: T }
  | { kind: 'unavailable'; reason: DerivedMetricReason; detail?: string }
```

`detail` is an optional human-readable note for tooltips. Constructor helpers:

```ts
derivedValue<T>(value: T): DerivedMetric<T>
derivedUnavailable<T>(reason: DerivedMetricReason, detail?: string): DerivedMetric<T>
```

**Crux:** The reason enum must stay exactly as wide as the rendering rules require and no wider. Every reason that renders differently gets its own member; reasons that render identically are collapsed. The three above render differently (see §3) and each hits a real call site.

### 2. Relationship to CachedVerdict\<T\>

Staleness and absence are orthogonal axes:

| | Presence known | Presence unknown |
|---|---|---|
| **Fresh** | `{ kind: 'value', value: X }` | `{ kind: 'unavailable', reason }` |
| **Stale** | stale `value` — true N minutes ago | stale `unavailable` — was missing N minutes ago |

`CachedVerdict<T>` is about the first axis (when was this value last evaluated). `DerivedMetric<T>` is about the second (does a value exist at all). They do not nest — nesting creates a third overlapping abstraction.

The staleness wrapper, when needed, is an outer envelope at the persistence layer:

```ts
// Hypothetical staleness envelope — NOT part of this spec
type Cached<T> = { value: T; evaluatedAt: string; stale: boolean }
// Usage: Cached<DerivedMetric<number>> — staleness wraps the availability result
```

Nothing in this mission requires persisting staleness; `CachedVerdict<T>` stays a spec concept. Do not implement it here. If a future task needs it, it is additive.

### 3. Render rule per reason

A rendered number MUST NOT be ambiguous between measured-zero and no-data.

| `reason` | UI shows | Never shows |
|---|---|---|
| `no_baseline` | em-dash (`—`) with tooltip from `detail` | any number, any percentage |
| `no_scope` | nothing (`null` / component renders empty) | `0`, `0%`, `0 tasks` |
| `not_evaluated` | pending indicator (`·` or "Pending") or nothing | pass/complete/100% |

**`no_baseline`** — an em-dash signals "there IS a concept here, but we have no data to populate it." Examples: release queue depth before the first release, session-pressure percentage before any sessions are recorded. The dash is neutral and explicitly different from zero.

**`no_scope`** — render nothing, not even a dash. A mission with no tasks should not show "0 tasks" (implies nothing has been done) or "—" (implies there is a measure that couldn't be read). The concept does not apply. `DerivedMetricDisplay` renders `null` by default when `unavailableLabel` is not supplied and the reason is `no_scope`.

**`not_evaluated`** — a criterion or KPI that has not been checked is not passing. Show a pending indicator or omit the value. Never roll it into a pass verdict. `evaluateGoalCriteria` must return `overall: 'UNVERIFIED'` (not `'pass'`) when criteria length is zero; the empty-criteria set is a `no_scope` signal, not an auto-pass.

`DerivedMetricDisplay` update required: the component must accept a `reasonLabel` prop (or a `renderUnavailable` render-prop) so callers can override the default for each reason. The default for `no_scope` is `null` (nothing); for `no_baseline`, an em-dash span; for `not_evaluated`, a pending indicator. Callers that override are responsible for maintaining the rule above.

### 4. Scope-growth behaviour

**Rule:** Initiative progress is the unweighted mean of each child mission's own completion ratio. A child with no countable tasks (`no_scope`) is excluded from the mean. Discovering new scope in one mission does not change another mission's ratio.

Implementation: replace the current `sum(completedTasks) / sum(totalTasks)` accumulation with:

```ts
const participating = children.filter(c => c.totalTasks > 0)
const progress = participating.length === 0
  ? derivedUnavailable<number>('no_scope')
  : derivedValue(
      Math.round(
        participating.reduce((sum, c) => sum + c.completedTasks / c.totalTasks, 0)
        / participating.length * 100
      )
    )
```

When a new mission plans its tasks (goes from 0 to N pending tasks), it enters the mean at 0%, which reduces the average — that is correct and intentional. What does NOT happen: adding an undecomposed mission (0 tasks) changes nothing; discovering MORE tasks in an existing mission does not retroactively reduce the ratios of sibling missions.

For mission-level progress, the same principle applies: `computeMissionProgress` currently returns `progress: 0` when `total === 0`. Callers that render this value must receive a `DerivedMetric<number>` signal:

```ts
// New helper — additive, does not change computeMissionProgress signature
export function deriveMissionProgressMetric(tasks: Parameters<typeof computeMissionProgress>[0]): DerivedMetric<number> {
  const { totalTasks, progress } = computeMissionProgress(tasks)
  return totalTasks > 0 ? derivedValue(progress) : derivedUnavailable('no_scope')
}
```

`computeMissionProgress` keeps its existing return type for backward compatibility.

### 5. Structural guard

`DerivedMetric<T>` is a discriminated union where neither `value` nor `reason` appear at the top level. TypeScript enforces narrowing before access:

```ts
const m: DerivedMetric<number> = computeX()
m.value    // TS2339: Property 'value' does not exist on type 'DerivedMetric<number>'
m.reason   // TS2339: Property 'reason' does not exist on type 'DerivedMetric<number>'
```

Any call site that does not branch on `kind` before accessing the inner fields will not compile. This is the guard.

`DerivedMetricDisplay` provides the reference implementation at the component layer: it accepts `renderValue: (value: T) => ReactNode` and forces the caller to supply a function for the value branch, making both branches explicit at the props level.

**Demonstrating the guard works** (required by mission goal criteria): add a test in `packages/core/__tests__/derived-metric.test.ts` that contains a deliberately unguarded call:

```ts
// This must produce a TypeScript error — the test runner invokes `tsc --noEmit`
function unguarded<T>(m: DerivedMetric<T>): T {
  return m.value // expected: TS2339
}
```

CI runs `tsc --noEmit` as part of the build. If the file compiles, the guard is broken. The test file commits this function behind a `// @ts-expect-error` comment — the comment itself is the assertion: if the comment is removed and the file still compiles, `tsc` emits TS2578 ("Unused '@ts-expect-error' directive"), which fails the build. This provides two-sided enforcement.

---

## Open Questions

**Q1: Should `DerivedMetricDisplay` dispatch on `reason` by default, or stay a single-branch component?**
Lean: add a `renderUnavailable?: (reason: DerivedMetricReason, detail?: string) => ReactNode` prop so callers can opt into reason-specific display without forcing all callers to update. The default remains the current dash/null per-reason behaviour described above.

**Q2: Does the `not_evaluated` case apply to the progress formula (a mission with all tasks pending)?**
No. A mission with 10 pending tasks is `no_scope` relative to completion (nothing done yet) but not `not_evaluated` — the evaluation was run and produced 0/10. Reserve `not_evaluated` for verdicts where the evaluation was never attempted.

---

## Non-goals

- New DB columns for derived state. All computation stays in memory from existing query results.
- Cron sweeps or background re-evaluation.
- Any change to what the metrics mean — this contract is purely about what to return when inputs are absent.
- `CachedVerdict<T>` implementation.
- iOS / mobile-specific rendering rules.

---

## Builder Task Breakdown

Tasks are grouped so no two touch the same file. The organizer creates these from this list; the three already-filed tasks (61c380cd, 4e08dd7c, c3ea1d05) are the implementation tasks for bugs B, C, and D below — they should incorporate the type shapes here.

### Task A — Core type upgrade + render primitive

**pathManifest:**
- `packages/core/derived-metric.ts`
- `packages/core/__tests__/derived-metric.test.ts`
- `apps/web/src/components/DerivedMetricDisplay.tsx`

**Work:**
1. Narrow `reason: string` → `reason: DerivedMetricReason` (add the typed union + `detail?: string`).
2. Add `// @ts-expect-error` guard test (see §5).
3. `DerivedMetricDisplay`: add `renderUnavailable?: (reason, detail?) => ReactNode`; default per-reason: `no_scope` → null, `no_baseline` → em-dash span, `not_evaluated` → "·" span with tooltip.

**Depends on:** nothing. Must merge before B, C, D.

---

### Task B — Mission progress formula (`computeMissionProgress` / `computeInitiativeProgress`)

Already filed as **4e08dd7c** (progress formulas / undiscovered denominator).

**pathManifest:**
- `packages/core/mission-helpers.ts`
- `packages/core/__tests__/mission-helpers.test.ts` (or co-located)

**Work:**
1. Add `deriveMissionProgressMetric` helper (see §4).
2. Fix `computeInitiativeProgress` to use mean-of-ratios, excluding missions with `totalTasks === 0`.
3. `InitiativeProgress.progress` field: keep the raw number for backward compat; add `progressMetric: DerivedMetric<number>` for callers that render.
4. Tests: `no_scope` when 0 tasks; progress does not fall when a 0-task mission is added; progress enters at 0% when a mission first acquires tasks.

**Depends on:** Task A merged.

---

### Task C — Goal criteria zero-set and NOT\_EVALUATED handling

Already filed as **61c380cd** (mission completion predicate).

**pathManifest:**
- `apps/web/src/app/api/missions/[id]/evaluate/route.ts`
- `packages/core/mission-criteria-eval.ts` (if the fix lands there)

**Work:**
1. `evaluateGoalCriteria` — change `results.length === 0 ? 'pass'` to `results.length === 0 ? 'UNVERIFIED'`. A mission with no criteria is not a passing mission.
2. Callers of `evaluateGoalCriteria` that propagate `overall` to the UI: ensure `UNVERIFIED` is displayed as pending, not as complete.
3. Test: zero-criteria mission evaluates as `UNVERIFIED`.

**Depends on:** none (does not use DerivedMetric directly, but should align with `not_evaluated` semantics).

---

### Task D — Release queue null baseline

Already filed as **c3ea1d05** (release queue null baseline).

**pathManifest:**
- `apps/web/src/app/app/(protected)/home/page.tsx` (or wherever `queueDepth` is assembled)
- `apps/web/src/lib/release-readiness.ts`

**Work:**
1. When no `releases` row exists, `queueDepth` must return `derivedUnavailable<number>('no_baseline')` instead of counting from epoch.
2. `computeReleaseWidgetDecision` receives `DerivedMetric<number>` for `queueDepth`; `'unavailable'` → `'hide'` unconditionally (do not show the widget when we have no baseline).
3. Test: null releases row → `hide`, not a large count.

**Depends on:** Task A merged.

---

### Path overlap check

| File | Task |
|---|---|
| `packages/core/derived-metric.ts` | A only |
| `packages/core/__tests__/derived-metric.test.ts` | A only |
| `apps/web/src/components/DerivedMetricDisplay.tsx` | A only |
| `packages/core/mission-helpers.ts` | B only |
| `packages/core/__tests__/mission-helpers.test.ts` | B only |
| `apps/web/src/app/api/missions/[id]/evaluate/route.ts` | C only |
| `packages/core/mission-criteria-eval.ts` | C only |
| `apps/web/src/app/app/(protected)/home/page.tsx` | D only |
| `apps/web/src/lib/release-readiness.ts` | D only |

No overlaps.
