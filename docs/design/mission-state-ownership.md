---
status: accessor
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "mission-state-accessor"
    type: "symbol"
    name: "deriveMissionStateView"
    path: "apps/web/src/lib/mission-state-view.ts"
  - id: "mission-state-view"
    type: "symbol"
    name: "MissionStateView"
    path: "apps/web/src/lib/mission-state-view.ts"
  - id: "mission-state-view-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-state-view.test.ts"
---
# Mission State Ownership

**Status:** Accessor implemented (`apps/web/src/lib/mission-state-view.ts`); panel adoption still pending — see "Implementation status" at the bottom. The `explain` MCP read consumes the accessor and its contract is documented in "The `explain` MCP contract" below.
**Related:**
- `apps/web/src/lib/mission-helpers.ts` — `deriveMissionDisplayState()` (line 137), `getMissionStateChip()` (line 165), `deriveTaskHealthSignal()` (line 95), `deriveDriveState()` (line 46)
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` — state assembly at lines 308–362; `criteriaBlockingReason` at lines 335–351; `allTasksCount` at line 293
- `apps/web/src/app/app/(protected)/missions/[id]/CondensedTimeline.tsx` — `SummaryView` guard (lines 583–596); waiting-on derivation (lines 544–568)
- `packages/core/mission-helpers.ts` — `computeMissionProgress`, `deriveMissionProgressMetric`, `deriveTaskType`
- `docs/design/derived-metric-availability.md` — opaque-type enforcement precedent
- `docs/design/task-tier-presentation.md` — `TieredCount` and `countByTier` contract
- PR #1948 — concrete display-bug fixes this spec generalises

---

## Problem

PR #1948 fixed four concrete display bugs: "No actions needed" shown for blocked missions, READY FOR REVIEW shown when criteria are failing, a missing above-fold blocking banner, and duplicated nested tabs. Despite those fixes, the mission detail page has no single source of truth for "what state is this mission in?" — which is why the bugs recurred in the first place and will recur again.

The audit that followed #1948 found five independent derivation paths for the same question:

1. **Header chip** — `deriveMissionDisplayState()` at `apps/web/src/lib/mission-helpers.ts:137`, called at `page.tsx:354`.
2. **Above-fold banner** — `criteriaBlockingReason` string assembled inline at `page.tsx:335–351`, passed as a separate prop.
3. **Summary "No actions needed" guard** — `!criteriaBlockingReason && !hasTasks` in `CondensedTimeline.tsx:SummaryView:583–596`.
4. **Summary "Waiting on" line** — derived independently from `groupChainUnits(...)` in `CondensedTimeline.tsx:544–568`.
5. **Goal criteria panel** — renders raw `mission.goalCriteriaState` from DB at `page.tsx:1030–1048`, completely isolated from `deriveMissionDisplayState()`.

Two active bugs remain from the audit:

**Bug A (dependency gate invisible in header):** When `mission.dependsOnMissionId` is set and `dependencyMetAt` is null, `deriveTaskHealthSignal()` returns `'BLOCKED'`. `deriveMissionDisplayState()` handles `health === 'FAILING'` but not `health === 'BLOCKED'` or `health === 'STALLED'` — both fall through to `'active'`. A dependency-blocked mission's header chip reads AUTO.

**Bug B (stalled mission invisible in header):** When all active tasks have no live worker, `deriveTaskHealthSignal()` returns `'STALLED'`. Same fall-through: header shows AUTO. A stalled mission looks identical to a healthy auto-running mission in the header.

The structural root: `deriveMissionDisplayState()` accepts raw boolean flags (`criteriaUnverified`, `isHeld`) instead of a typed shape that the compiler can enforce. Child panels accept raw mission fields as props. Adding a new health state or criteria condition requires finding and patching every panel independently — there is no single insertion point.

---

## Proposal

### Crux

Replace the scattered parallel derivations with one sealed accessor, `MissionStateView`, produced by a single factory `deriveMissionStateView()`. Every panel on the mission detail page that answers "what state is this mission in?" receives `MissionStateView`, not raw health/criteria fields. The branded type makes an unguarded field access a compile error, using the same discriminated-union pattern as `DerivedMetric<T>`.

If this crux is wrong — if any panel is allowed to re-derive state from raw fields — then the next bug will be filed the next time a new health signal is added, because the panel that doesn't know about it will keep rendering the wrong chip.

---

### 1. The `MissionStateView` Type

```typescript
// apps/web/src/lib/mission-state-view.ts (new file)

// Branded symbol prevents construction outside the factory.
declare const MissionStateViewBrand: unique symbol;

/**
 * The sealed state for a mission detail page.
 * Produced only by `deriveMissionStateView()`.
 * Every panel that answers "what is this mission doing?" reads from here.
 */
export type MissionStateView = {
  readonly [MissionStateViewBrand]: true;
  /** Single resolved display state — the header chip key. */
  readonly displayState: MissionDisplayState;
  /** Chip label + CSS class. Computed once; never reconstructed at call sites. */
  readonly chip: { label: string; cls: string };
  /**
   * Non-null when the mission is gated. Contains everything the 'waiting on'
   * banner needs: blocking kind, human label, and optional task/mission id.
   */
  readonly waitingOn: WaitingOnDescriptor | null;
  /**
   * Human-readable string for the above-fold banner.
   * Derived from waitingOn — not an independent computation.
   * Non-null when a criterion is failing or unverified and the mission is not terminal.
   */
  readonly criteriaBlockingReason: string | null;
};

export type WaitingOnDescriptor =
  | { kind: 'dependency'; label: string; missionId: string }
  | { kind: 'criterion_failing'; label: string; count: number }
  | { kind: 'criterion_unverified'; count: number }
  | { kind: 'human_decision'; label: string };
```

`MissionStateView` is a branded type: the `[MissionStateViewBrand]: true` field can only be set by code that holds the symbol, which is not exported. TypeScript will reject any object literal that attempts to satisfy the type without going through the factory.

`WaitingOnDescriptor` is a discriminated union. A switch on `kind` must be exhaustive to compile — adding a new blocking sub-case without updating all renderers is a type error.

---

### 2. Factory: `deriveMissionStateView()`

```typescript
// apps/web/src/lib/mission-state-view.ts (continued)

export function deriveMissionStateView(opts: {
  status: string;
  isHeld: boolean;
  orchestrationMode?: string | null;
  activeAgents: number;
  health: Health;              // from deriveTaskHealthSignal()
  progress?: number;           // from deriveMissionProgressMetric()
  criteriaUnverified: boolean;
  criteriaStateItems: Array<{ verdict: string; label?: string; type?: string }>;
  dependsOnMissionId?: string | null;
  dependencyMetAt?: Date | string | null;
}): MissionStateView {
  // Priority order (first match wins):
  // complete > held > blocked > stalled > running > failed >
  // awaiting_verification > review > manual > active
  let displayState: MissionDisplayState;

  if (opts.status === 'completed' || opts.status === 'archived') {
    displayState = 'complete';
  } else if (opts.isHeld) {
    displayState = 'held';
  } else if (opts.health === 'BLOCKED') {
    displayState = 'blocked';          // NEW — was falling through to 'active'
  } else if (opts.health === 'STALLED') {
    displayState = 'stalled';          // NEW — was falling through to 'active'
  } else if (opts.activeAgents > 0) {
    displayState = 'running';
  } else if (opts.health === 'FAILING') {
    displayState = 'failed';
  } else if (opts.criteriaUnverified && opts.progress !== undefined && opts.progress >= 100) {
    displayState = 'awaiting_verification';
  } else if (opts.progress !== undefined && opts.progress >= 100) {
    displayState = 'review';
  } else if (opts.orchestrationMode === 'manual') {
    displayState = 'manual';
  } else {
    displayState = 'active';
  }

  // Waiting-on descriptor
  let waitingOn: WaitingOnDescriptor | null = null;

  if (opts.health === 'BLOCKED' && opts.dependsOnMissionId) {
    waitingOn = {
      kind: 'dependency',
      label: 'dependency mission',
      missionId: opts.dependsOnMissionId,
    };
  } else if (opts.criteriaUnverified && !['completed', 'cancelled', 'archived'].includes(opts.status)) {
    const failing = opts.criteriaStateItems.filter(c => c.verdict === 'fail');
    if (failing.length > 0) {
      waitingOn = {
        kind: 'criterion_failing',
        label: failing[0].label ?? failing[0].type ?? 'criterion',
        count: failing.length,
      };
    } else {
      const notPassed = opts.criteriaStateItems.filter(c => c.verdict !== 'pass');
      if (notPassed.length > 0) {
        waitingOn = { kind: 'criterion_unverified', count: notPassed.length };
      }
    }
  }

  // criteriaBlockingReason is derived from waitingOn — not computed separately.
  let criteriaBlockingReason: string | null = null;
  if (waitingOn?.kind === 'criterion_failing') {
    criteriaBlockingReason = waitingOn.count === 1
      ? `criterion failing: ${waitingOn.label}`
      : `${waitingOn.count} criteria failing`;
  } else if (waitingOn?.kind === 'criterion_unverified') {
    criteriaBlockingReason = waitingOn.count === 1
      ? '1 criterion unverified — run verification'
      : `${waitingOn.count} criteria unverified — run verification`;
  }

  return {
    [MissionStateViewBrand]: true,
    displayState,
    chip: getMissionStateChip(displayState),
    waitingOn,
    criteriaBlockingReason,
  } as MissionStateView;
}
```

**Priority change:** `'blocked'` and `'stalled'` are inserted between `'held'` and `'running'`. A mission waiting on a dependency that also has active agents is still blocked — agents working in parallel do not clear the dependency gate.

**`criteriaBlockingReason` migration:** The current independent computation at `page.tsx:335–351` is deleted. The factory produces the same string from the same inputs in one place.

---

### 3. `MissionDisplayState` Additions

Add `'blocked'` and `'stalled'` to the union and update the chip map:

```typescript
// apps/web/src/lib/mission-helpers.ts

// Before:
export type MissionDisplayState = 'held' | 'running' | 'failed' | 'manual'
  | 'complete' | 'active' | 'review' | 'awaiting_verification';

// After:
export type MissionDisplayState = 'held' | 'blocked' | 'stalled' | 'running' | 'failed'
  | 'manual' | 'complete' | 'active' | 'review' | 'awaiting_verification';

// getMissionStateChip additions:
case 'blocked': return { label: 'BLOCKED', cls: 'border-status-error text-status-error' };
case 'stalled': return { label: 'STALLED', cls: 'border-status-warning text-status-warning' };
```

`deriveMissionDisplayState()` (the existing exported function) becomes a thin shim that calls `deriveMissionStateView()` and returns `.displayState`. It is deprecated in the same PR. Call sites that currently import `deriveMissionDisplayState` migrate to `deriveMissionStateView`.

---

### 4. Panel Prop Discipline

Every panel on the mission detail page that answers "what state is this mission in?" must receive `MissionStateView`, not raw health or criteria fields.

| Panel | Current props | Required change |
|---|---|---|
| Header chip | `stateChip` (pre-derived `{ label, cls }`) | Receive `state: MissionStateView`; render `state.chip` |
| Above-fold banner | `criteriaBlockingReason: string \| null` | Receive `state: MissionStateView`; render from `state.criteriaBlockingReason` |
| `CondensedTimeline` Summary view | `criteriaBlockingReason: string \| null`, task groups | Receive `state: MissionStateView`; use `state.criteriaBlockingReason` for the guard |
| `MissionSettings` | `displayState: MissionDisplayState` | Receive `state: MissionStateView`; read `state.displayState` |
| `MissionGoalCriteria` | `criteria`, `criteriaState` (raw DB) | **No change.** This panel renders the per-criterion verdict table — pass/fail/pending per row — not the aggregate mission state. It is a detail panel, not a state panel. Raw criterion props are correct for its purpose. |
| `MissionFeed` | fetches independently | No change. The feed renders activity; it has no state-question surface. |

The goal criteria panel is explicitly exempt: it answers "did criterion X pass?" not "what is the mission's overall state?" These are different questions with different inputs.

---

### 5. The 'Waiting On' Line

**What it is:** A single line above the fold that names what is blocking progress. Present only when `state.waitingOn !== null`. Silent when the mission is running normally.

**Location:** Between the chip row and the progress bar. Rendered in the page RSC (`page.tsx`), not inside a child panel — always visible regardless of which tab is active.

**Component:** `MissionWaitingOnBanner` (new, co-located with `page.tsx`). Accepts `waitingOn: WaitingOnDescriptor | null`. Returns `null` when `waitingOn` is null.

**Per-sub-case rendering:**

| `waitingOn.kind` | Text | Link? |
|---|---|---|
| `dependency` | "Waiting for [dependency mission title] to complete" | Link to the dependency mission detail page |
| `criterion_failing` | "1 criterion failing: [label]" or "N criteria failing" | No — criteria panel is already on the page |
| `criterion_unverified` | "1 criterion unverified — run verification" (N for plural) | No |
| `human_decision` | "Waiting for human decision: [label]" | No |
| `null` | *(nothing rendered)* | — |

`WaitingOnDescriptor` does not include task-level blocking ("waiting on task X's PR to merge"). That signal is already rendered by the existing waiting-on line in `CondensedTimeline.tsx:SummaryView:544–568`, which derives from `groupChainUnits(...)`. The two are complementary:
- **`MissionWaitingOnBanner`** (above fold, always visible): mission-level blockers — dependency gate, criteria
- **`SummaryView` waiting-on line** (inside Summary tab): task-chain-level state — "next queued: X", "blocked on Y's PR"

The `SummaryView` waiting-on line continues deriving from `groupChainUnits`. No change to its implementation.

---

### 6. Count Labelling

The task-tier-presentation contract (`docs/design/task-tier-presentation.md`) settles `TieredCount` and `countByTier()`. This spec consumes that contract without repeating it.

**Surviving raw-number count after PR #1948:**

`allTasksCount` at `page.tsx:293`:
```typescript
// Current — BUG: t.taskClass !== 'attempt' includes bookkeeping rows.
const allTasksCount = (mission.tasks || []).filter(t => t.taskClass !== 'attempt').length;
```

For a mission with 5 `work`, 8 `attempt`, and 33 `bookkeeping` tasks, this returns 38 instead of 5.

**Fix (once `countByTier` from task-tier-presentation Task A ships):**
```typescript
const tierCounts = countByTier(mission.tasks || [], { excludeCancelled: true });
const allTasksCount = tierCounts.work;
```

**Interim fix (before `countByTier` is available):**
```typescript
const allTasksCount = (mission.tasks || []).filter(t => t.taskClass === 'work').length;
```

**Invariant:** `allTasksCount` must equal `computeMissionProgress(mission.tasks || []).totalTasks`. These are the same concept — "how many deliverable tasks does this mission have?" Any divergence means the "View all N tasks" link and the progress bar denominator report different numbers for the same thing.

**Enforcement:** The banned-predicate test in `packages/core/__tests__/task-class-invariants.test.ts` (task-tier-presentation §4) will catch `taskClass !== 'attempt'` if reintroduced.

---

### 7. Information Hierarchy

**One tab level. One progress bar.**

PR #1948 removed nested sub-tabs and the duplicate progress bar. This spec locks that structure as an architectural ruling.

**Tab labels (in order):** Summary | Feed | Config

- **Summary:** task timeline, waiting-on line, no-actions state
- **Feed:** heartbeat activity, agent notes
- **Config:** schedule, heartbeat checklist, backend, budget, merge policy

"Timeline" does not appear as a tab label or sub-tab label after this spec. If a builder introduces it, it must replace one of the three above, not add a fourth.

**Progress bar:** One instance of `MissionProgressBar`, rendered between the chip row and the tab bar. Never rendered inside a tab. Receives `segments` from `computeMissionProgress()`. Only rendered when `progressMetric.kind === 'value'` (i.e., `totalTasks > 0`); absent for missions with no tasks (`no_scope` per DerivedMetric contract).

**Above fold on a 390px viewport (top to bottom):**
1. Breadcrumb (mission title + initiative link, if any)
2. Mission name (inline-editable h1)
3. Chip row: state chip | next-run text (when `displayState === 'active'`)
4. `MissionWaitingOnBanner` (when `state.waitingOn !== null`)
5. `MissionProgressBar` (when `progressMetric.kind === 'value'`)
6. Tab bar: Summary | Feed | Config
7. Tab content (Summary by default)

Nothing relevant to state or progress moves below the tab bar. The user sees the state, what is blocking it, and how far along it is without scrolling.

---

### 8. Proposed Layout — Three Cases (Mobile-first, 390px)

#### Case A: Blocked

Applies when `state.displayState === 'blocked'` (dependency) or `state.criteriaBlockingReason !== null` (criteria failing or unverified).

```
┌─────────────────────────────────────────┐
│  ← Missions / Initiative Name           │  breadcrumb
│                                         │
│  Mission: Build auth service            │  h1 (inline-editable)
│                                         │
│  [BLOCKED]                              │  chip — red border (dependency case)
│                                         │
│  ⚠ Waiting for "API Gateway" to         │  MissionWaitingOnBanner
│    complete before this can run         │    kind: 'dependency'
│                                         │
│  ████████████░░░░░░░░ 5/8 tasks         │  MissionProgressBar
│                                         │
│  [ Summary ]  Feed  Config              │  tab bar — Summary active
│ ─────────────────────────────────────── │
│  No actions needed.                     │  SummaryView (no tasks in flight)
│  Completion blocked — 2 criteria failing│    (criteria sub-case)
└─────────────────────────────────────────┘
```

When blocking is criteria-only and `progress < 100`: chip reads AUTO (see Open Questions Q1), `MissionWaitingOnBanner` shows the criteria reason, above-fold banner is present even though the chip does not say BLOCKED.

When `progress === 100` and criteria are failing: chip reads AWAITING VERIFICATION (existing PR #1948 behaviour; no change).

#### Case B: Running

Applies when `state.displayState === 'running'` (activeAgents > 0, not held, not blocked by dependency).

```
┌─────────────────────────────────────────┐
│  ← Missions                             │
│                                         │
│  Mission: Build auth service            │  h1
│                                         │
│  [RUNNING]  Next run in 4h              │  chip — green; drive detail
│                                         │
│  ████████░░░░░░░░░░░░ 3/8 tasks         │  MissionProgressBar
│                                         │
│  [ Summary ]  Feed  Config              │  tab bar
│ ─────────────────────────────────────── │
│  ▸ Implement login endpoint             │  running task (SummaryView)
│    Builder · 12m, 4 turns               │
│  Next: Write unit tests                 │  queued task
└─────────────────────────────────────────┘
```

No `MissionWaitingOnBanner` when `state.waitingOn === null`.

#### Case C: Complete

Applies when `state.displayState === 'complete'` (status is `completed` or `archived`).

```
┌─────────────────────────────────────────┐
│  ← Missions                             │
│                                         │
│  Mission: Build auth service            │  h1
│                                         │
│  [COMPLETE]                             │  chip — muted
│                                         │
│  ████████████████████ 8/8 tasks         │  MissionProgressBar
│                                         │
│  [ Summary ]  Feed  Config              │  tab bar
│ ─────────────────────────────────────── │
│  All deliverables complete.             │  SummaryView
│  3 PRs merged · 0 open                  │  MissionReviewSummary inline
└─────────────────────────────────────────┘
```

No `MissionWaitingOnBanner`. `criteriaBlockingReason` is null (mission is terminal).

---

## Enforcement

| Decision | Mechanism |
|---|---|
| `MissionStateView` branded — cannot be constructed without the factory | **Code-level:** TypeScript brand symbol is not exported; any object literal that tries to satisfy the type without the factory call will not compile (TS2322). |
| `WaitingOnDescriptor` switch must be exhaustive | **Code-level:** TypeScript `never` assertion on the default branch of any switch over `kind`. Adding a new `kind` without updating the switch is a compile error. |
| `deriveMissionStateView` handles BLOCKED and STALLED | **Code-level:** `MissionDisplayState` union is exhaustive; `getMissionStateChip` has a case for every member. A missing case is a TS2366 type error. |
| Panels receive `MissionStateView`, not raw fields | **Argued:** TypeScript cannot prevent a developer from reading `mission.isHeld` directly. Enforcement is PR review: no new panel prop named `isHeld`, `health`, `criteriaUnverified`, or `activeAgents` where the question is "what chip to show?". This spec is the authority. |
| `allTasksCount` uses `taskClass === 'work'` | **Code-level (partial):** `task-class-invariants.test.ts` (task-tier-presentation §4) bans the `taskClass !== 'attempt'` predicate. If reintroduced, CI fails. |
| One tab level | **Argued:** No type prevents a fourth tab. Enforced by this spec as the design authority; the builder is responsible for not introducing nested tabs. |
| One progress bar | **Argued:** Same — no type prevents a second `MissionProgressBar` instance. This spec is the ruling. |
| `MissionWaitingOnBanner` renders nothing when `waitingOn === null` | **Code-level:** Component accepts `waitingOn: WaitingOnDescriptor \| null` and returns `null` on the null branch. TypeScript prevents passing a raw string where the discriminated union is expected. |

---

## Open Questions

**Q1: Should `displayState === 'blocked'` take priority over `'running'` when a mission has both active agents and an uncleared dependency?**

Lean: yes. A dependency-blocked mission is blocked even if workers are doing parallel work — the dependency gate has not cleared, and showing RUNNING hides the block. The proposed priority chain places `'blocked'` before `'running'`.

Counter-argument: if agents are visibly running, BLOCKED may alarm the user unnecessarily. If PM feedback suggests confusion, `'blocked'` can be moved after `'running'` — the banner will still appear above fold via `MissionWaitingOnBanner`, so the block is not invisible.

**Q2: Should a mission with `criteriaUnverified && progress < 100` show a 'blocked' or 'awaiting' chip, or keep showing AUTO?**

Today (post-PR #1948): header shows AUTO, above-fold banner shows "BLOCKED." The banner is present; the chip is misleading. This spec adds `MissionWaitingOnBanner` which will surface the criteria reason, but the chip still says AUTO. A `'criteria_blocked'` display state that fires for this sub-case was considered and omitted — it would require distinguishing "blocked because criteria" from "blocked because dependency" in `MissionDisplayState`, creating two BLOCKED labels that render identically. Lean: leave the chip as AUTO for `progress < 100`; the banner is sufficient. Open to builder judgement.

**Q3: Does `'stalled'` in `MissionDisplayState` conflict with `'stalled'` in `MissionHealth`?**

`deriveTaskHealthSignal()` returns `Health.STALLED` (task-aggregate: active tasks have no live worker). `deriveMissionHealth()` returns `MissionHealth.'stalled'` (scheduling: mission has not run for 2× its cron interval). They are orthogonal axes with different inputs and different call sites. The label collision is cosmetic. If the chip label "STALLED" is ambiguous, the builder may use "IDLE" for the task-aggregate stall case. Decision deferred to the builder.

---

## Non-goals

- iOS native layout
- Desktop-only layout concerns beyond what the 390px mobile layout implies
- Redefining what any metric means (progress %, health signal, criteria verdict)
- `CachedVerdict<T>` implementation
- The `SummaryView` task-chain waiting-on line (`CondensedTimeline.tsx:544–568`) — continues as-is
- Retroactive renaming of `MissionDisplayState` label strings at existing call sites (e.g., AUTO → ACTIVE)
- Mission list page, home page, or initiative pages — those use `MissionBadges` and `healthToGroup`, which are out of scope

---

## Implementation Order

1. **`apps/web/src/lib/mission-state-view.ts`** (new) — `MissionStateView` branded type, `WaitingOnDescriptor`, `deriveMissionStateView()` factory.
2. **`apps/web/src/lib/mission-helpers.ts`** — add `'blocked'` and `'stalled'` to `MissionDisplayState`; update `getMissionStateChip`; keep `deriveMissionDisplayState` as a shim (deprecated).
3. **`apps/web/src/app/app/(protected)/missions/[id]/page.tsx`** — replace `deriveMissionDisplayState()` call and independent `criteriaBlockingReason` computation with a single `deriveMissionStateView()` call; thread `state: MissionStateView` to all panels.
4. **`MissionWaitingOnBanner`** (new, co-located with `page.tsx`) — renders from `state.waitingOn`.
5. **Update `CondensedTimeline` props** — replace `criteriaBlockingReason: string | null` with `state: MissionStateView`; use `state.criteriaBlockingReason` for the guard.
6. **Fix `allTasksCount` predicate** — interim: `taskClass === 'work'`; final: `countByTier(...).work` once task-tier-presentation Task A lands.
7. **Tests** — `deriveMissionStateView()`: BLOCKED health → `displayState === 'blocked'`; STALLED health → `displayState === 'stalled'`; BLOCKED with activeAgents > 0 → still `'blocked'`; criteriaUnverified with failing items → `waitingOn.kind === 'criterion_failing'`; criteriaUnverified without failing → `waitingOn.kind === 'criterion_unverified'`; terminal status → `waitingOn === null`.

---

## Implementation status

`deriveMissionStateView` and `WaitingOnDescriptor` ship in
`apps/web/src/lib/mission-state-view.ts`, with `MissionDisplayState` extended by
`'blocked'` and `'stalled'` per §3. Panel adoption (§4) is **not** done — the
mission detail page still calls `deriveMissionDisplayState`, so nothing on
screen has changed yet. That migration is the UI follow-up; the accessor's
signature was shaped so those panels adopt it without altering their props.

The first consumer is not a panel but the `explain` MCP read
(`apps/web/src/lib/explain.ts`, `GET /api/explain`), which answers the same
question for a task, a mission, a workspace or a PR.

### Deltas from the proposal above

Three things changed once the accessor had to consume all five existing
derivations rather than only health + criteria. The proposal is otherwise
implemented as written.

**1. The shape is a discriminated union, not a record with a nullable field.**
§1 proposed `waitingOn: WaitingOnDescriptor | null` on one record type. That
makes "blocked rendering as idle" a *runtime* mistake — a panel can still test
a field and get it wrong. The shipped type splits the union: `waitingOn: null`
exists only on the `complete` / `idle` / `running` variants, and every gated
variant carries a non-null descriptor. A renderer must narrow to a quiet
variant to say "nothing to do", which it cannot do while the mission is gated.
That is the §Enforcement row upgraded from argued to code-level.

**2. `MissionStateKind` is a separate axis from `MissionDisplayState`.** The
proposal reused the display-state union for both the chip and the state
question. They answer different things: the chip is presentation (and is kept,
as `displayState`, precisely so panels adopt the view unchanged), while `kind`
is the state. `kind` adds `waiting`, `awaiting_merge` and `awaiting_decision`,
which the chip vocabulary has no room for.

**3. Two precedence rulings the proposal left open.** Both are stated in the
module docstring and covered by tests:

- **Criteria never produce `blocked`.** `canCompleteMission` returns
  `criteria_failed` / `criteria_unverified` as refusals, while
  `deriveCriteriaGatePresentation` states that an unverified *or failing*
  criterion "must never render as BLOCKED". A criteria refusal yields
  `awaiting_verification`, and its tone escalates `neutral → warning → error`
  with the gate's own state — so Q2's "unverified criterion on a young mission"
  is quiet by construction rather than by a caller remembering to be quiet.
- **A benign wait outranks a stall.** When `deriveTaskHealthSignal` says
  `STALLED` and `classifyMissionWait` says "resumes at T", the wait wins. The
  two are opposite claims and only one is actionable.

Q1 is resolved as the proposal leaned: an unmet dependency outranks `running`.
Q3 is resolved by labelling the task-aggregate stall chip **IDLE**, leaving the
word "stalled" to `MissionHealth`'s scheduling axis.

---

## The `explain` MCP contract

This section documents `GET /api/explain` and the `explain` MCP action
(`apps/web/src/lib/explain.ts`, `explain-because.ts`, `explain-types.ts`,
`packages/core/mcp-tools.ts`) against what shipped, not the plan that preceded
it. It was written after the fact — the read that follows is of the merged
code, not a proposal.

`explain` answers one question — "what state is this subject in, what is it
waiting on, and what is the evidence?" — for one of four scopes (`task` /
`mission` / `workspace` / `pr`), in one shared response shape
(`ExplainResult` → `ExplainAnswer[]`). `state` and `waitingOn` are read
straight off `MissionStateView` (above); this section covers the three things
`MissionStateView` does not have: the `because[]` evidence chain, the
workspace ranking, and the not-found shapes.

### 1. `because[]`: element schema and ref kinds

Each element is a `CausalLink`:

```typescript
interface CausalLink {
  order: number;           // 1-based; the chain reads cause → effect
  claim: string;            // one line of evidence, in prose
  derivedFrom: ExplainSource; // the row or derivation this was read from
  refs: ExplainRefs;        // hard references — not parsed out of `claim`
}
```

`ExplainRefs` is the hard-reference bag every link carries a subset of:

| Field | Ref kind | Populated by |
|---|---|---|
| `taskId`, `parentTaskId` | task id | any task-scoped link |
| `missionId` | mission id | mission-scoped and dependency links |
| `workspaceId` | workspace id | every link (via `BecauseSubjectRefs.workspaceId`) |
| `prNumber`, `prUrl` | PR identity | merge and conflict links |
| `branch`, `baseRef` | git ref names | conflict links |
| `commitSha` | commit SHA | `openedBaseSha` and merge `headSha` on conflict links |
| `criterion` | criterion label | `criterion_failing` / `criterion_unverified` links |
| `errorSignature` | error signature | `task_failed` links, when the worker recorded one |
| `paths` | repo-relative file paths | conflict links naming the overlapping file set |

There is no ref kind for a bare error message or free-form text — a link
either carries one of the refs above or it carries none (e.g. the closing
"state is X" link, and the `human_decision` link, which points at
`missions.criteriaEscalatedAt` rather than a row with its own id).

### 2. The `derivedFrom` vocabulary — closed at one layer, free text at another

`ExplainSource` is declared as:

```typescript
export type ExplainSource = MissionStateSource | (string & {});
```

`(string & {})` is the "branded string" trick: it does not restrict the value
to `MissionStateSource` at all — any string type-checks. So the honest answer
is **two vocabularies, not one**:

**Closed (9 values).** `ExplainAnswer.state`'s provenance, `waitingOn`'s, and
`nextAction`'s are always exactly one of `MissionStateSource`: `mission.status`
| `mission.startMode` | `mission.criteriaEscalatedAt` | `workers.live` |
`deriveTaskHealthSignal` | `deriveCriteriaGatePresentation` |
`canCompleteMission` | `classifyMissionWait` | `evaluateMissionWorkState`.
These three fields are set once, straight from `MissionStateView.derivedFrom`,
and every value the factory can produce is in that union — the type is closed
even though `ExplainSource` itself isn't.

**Free text (per-link).** Every `CausalLink.derivedFrom` inside `because[]` —
and therefore `ExplainProvenance.because`, which is just
`[...new Set(because.map(b => b.derivedFrom))]` — is an ad hoc string authored
at each `link(...)` call site in `explain-because.ts`. In practice the call
sites draw from a small, enumerable set, but nothing enforces it:

- `missions.dependsOnMissionId`
- `tasks.status + workers.status`
- `tasks.status + tasks.result.errorType`
- `workers.mergedAt`
- `missions.goalCriteriaState`
- `missions.criteriaEscalatedAt + missionNotes`
- `classifyMissionWait`
- any `MissionStateSource` value (the closing link reuses `view.derivedFrom.kind`)
- four conflict-chain templates parameterized by `TouchSource` (`observedTouches`
  | `pathManifest` | `observedTouches+pathManifest` | `undeclared`), e.g.
  `` `workers.observedTouches ∪ tasks.pathManifest (${touchSource})` ``
- `workers.mergedAt (merges into this base recorded since the PR opened — a
  floor, not a rev-list)`
- `workers.observedTouches ∪ tasks.pathManifest (no intersection)`
- `workers.prLifecycleStatus + workers.conflictDetectedAt`
- `tasks.parentTaskId + tasks.taskClass (attachAttempts)` (the fixed value for
  `ExplainProvenance.history`)

Two of these bake a data value into the string itself (the `TouchSource`
parameter, and the base-SHA prefix in the floor-count link) rather than
carrying it as a structured ref. A consumer that wants to branch on "was this
computed from `observedTouches` or `pathManifest`?" today has to substring-match
the label.

**Proposed closed set, if this is worth tightening:** promote the per-link
vocabulary above to a real union (`CausalLinkSource = MissionStateSource | 'missions.dependsOnMissionId' | 'tasks.status + workers.status' | ...`)
so a new call site that invents a fresh string is a type error, and lift
`TouchSource` out of the label into a `refs.touchSource` field so the two
concerns — human-readable provenance and machine-checkable provenance — stop
sharing one string. Not done here: the task was to describe what shipped, and
what shipped is free text with a stable, small set of actual values.

### 3. Workspace-scope ranking rule

Implemented as `WAITING_ON_RANK` + `rankGatedSubjects` in `explain-types.ts`.
Fixed priority by `waitingOn.kind`, most-actionable first:

```
task_failed (0) > human_decision (1) > dependency (2) > merge (3)
  > criterion_failing (4) > task (5) > criterion_unverified (6)
  > self_resolving_wait (7)
```

Ties (same `kind`) break on `subject.label`, alphabetically — for stability
across calls, not for any semantic meaning. `self_resolving_wait` ranks last
deliberately: it resolves without anyone acting, so ranking it above a failed
task would reproduce the "everything shouted with equal confidence" failure
this whole line of work exists to fix, one level up.

Subjects considered are **active missions plus the workspace's mission-less
tasks** — a task that belongs to a mission is already represented through that
mission's chain, so it is not listed a second time as its own subject.

**Bound, in two different senses.** The `subjects` array returned is bounded
at `WORKSPACE_SUBJECT_LIMIT` (12), applied after ranking — a large workspace
never returns "everything," and `considered` / `quiet` on the result report
the true totals so the cap is visible, not silent. Before this task, the *work
performed* to reach that ranking was **not** symmetrically bounded: the
mission-less-tasks query already capped its scan at 200 rows, but the active-
missions query had no `limit` at all, so a workspace with hundreds of active
missions would call `explainMission()` — itself several sequential queries —
once per mission before the 12-subject cut ever applied. Fixed in this task:
`activeMissions` now caps at `MISSION_SCAN_LIMIT` (200), mirroring the tasks
query, with the same "no silent caps" log line firing when the cap is hit.

Left as a follow-up, not fixed here (filed as a task): the fan-out itself is
sequential (`for (const m of activeMissions) { await explainMission(m.id) }`),
not parallel. Bounding the *count* doesn't bound the *latency* — 200
sequential multi-query mission reads is still a slow request. Parallelizing
that loop is a real design decision (it changes the DB connection/query load
shape under concurrency), not a one-line bug fix, so it's out of scope here.

### 4. What `explain` returns when the accessor cannot answer

Every not-found and ambiguous case returns an explicit shape — none of the
paths checked for this task return a silent empty:

| Situation | Shape returned |
|---|---|
| `taskId` doesn't exist, or exists outside the caller's team | `404 { error: 'Task not found or not in your team' }` |
| `missionId` doesn't exist, or exists outside the caller's team | `404 { error: 'Mission not found or not in your team' }` |
| `prNumber` matches no worker | `404 { error: 'PR not found' }` (from `resolveWorkerByPrNumber`) |
| `prNumber` matches workers in more than one workspace, no `workspaceId` given | `409 { error: '...pass workspaceId to disambiguate', candidates: [...workspaceIds] }` |
| `prNumber` resolves to a worker with no `taskId` | `404 { error: 'PR #N has no task attached — nothing to explain.' }` |
| more than one of `taskId`/`missionId`/`workspaceId`/`prNumber` supplied | `400 { error: 'Pass exactly one subject — received ...' }` |
| mission exists but has zero tasks | **Not an error.** `explainMission` returns a normal `ExplainAnswer` — `deriveTaskHealthSignal` sees an empty task list and reports `NOMINAL`, and (absent any other signal) the mission resolves to `kind: 'idle'`, `waitingOn: null`, with a one-link `because[]` reading "State is idle: no source reports anything outstanding." |
| workspace has zero gated subjects | **Not an error.** `{ scope: 'workspace', subjects: [], considered: N, quiet: N }` |

None of these degrade to `null`/`undefined`/an empty 200 body without an
`error` key. The one place worth flagging rather than treating as settled: a
mission with no tasks reaching `idle` depends on every intermediate rule in
`deriveMissionStateView`'s chain declining to fire (no dependency, no held
gate, no criteria configured, etc.) — it is the *absence* of every other
signal, not a dedicated "empty mission" case, so a future rule inserted
earlier in the chain could change what an empty mission reports without
anyone touching this path directly.

### 5. Two things checked and found to be as documented, not bugs

**Tone on a refused-but-not-failing criterion is deliberately capped below
`error`.** The top-of-file module note says tone "comes straight from
`deriveCriteriaGatePresentation`." Read literally against the code, that's not
quite true: `deriveCriteriaGatePresentation` reports `tone: 'error'` for
*any* `state: 'refused'` gate, including one that's refused only because
criteria are unverified (never actually failing). `deriveMissionStateView`
does not propagate that tone as-is — it re-derives `criterion_unverified`'s
tone as `refused ? 'warning' : 'neutral'`, holding `error` in reserve for a
criterion that is actually `criterion_failing`. This is intentional and
covered by a test (`mission-state-view.test.ts`, "becomes newsworthy only once
completion was refused over it," asserting `tone === 'warning'` for exactly
this case) — the design choice is "unverified is never as loud as failing,
even when both are refused," which is a real severity ranking, just not the
literal "straight from" the comment claims. Left as-is; the comment overstates
its own mechanism but the behavior is correct and tested.

**The commits-behind-base floor label survives to the response.** The
conflict chain's first link carries `derivedFrom: 'workers.mergedAt (merges
into this base recorded since the PR opened — a floor, not a rev-list)'` —
that full string is returned verbatim inside `because[]`, not summarized or
dropped. (`ConflictExplanation.commitsBehindBase`, the numeric count computed
alongside it, is *not* surfaced anywhere in `ExplainAnswer` — only the labeled
prose form reaches the response. There is no bare integer floating around
without its caveat.) Covered by
`explain.test.ts`, "labels the commits-behind count as a floor, not a
rev-list."

### 6. Determinism

`explain` never evaluates criteria, calls a model, or attempts a merge, on any
scope including the workspace fan-out:

- `canCompleteMission` is always called with `evaluateCriteria: false` — the
  block that would dispatch verification (`mission-completion.ts`, gated on
  `if (evaluateCriteria)`) is unreachable from this module.
- `deriveCriteriaGatePresentation`, `classifyMissionWait`, and
  `evaluateMissionWorkState` are pure reads over already-loaded rows; none of
  the three performs I/O beyond the `db.query` calls `explain.ts` itself
  triggers.
- The conflicted-PR chain (`buildConflictBecause`) reads
  `workers.observedTouches` / `tasks.pathManifest` / `workers.mergedAt` and
  computes `intersectPaths` over them in memory. No git command, no GitHub
  API call, no merge attempt.
- `explainWorkspace` reuses `explainMission` / `explainTask` per subject, so
  the same guarantee holds at every fan-out level — there is no separate,
  less-careful code path for the workspace scope.

### 7. `intersectPaths` — coverage and honest limits

`packages/core/path-overlap.ts`'s `intersectPaths(a, b)`:

- **Empty or missing manifest on either side → `[]`.** `touchSetOf` maps a
  `null` `pathManifest`/`observedTouches` to `touches: []` before
  `intersectPaths` ever runs, and the function itself short-circuits to `[]`
  when either input array is empty. An undeclared scope never manufactures a
  conflicting path.
- **The repo-wide sentinel (`'**'`) is filtered out, not treated as
  overlapping everything.** Unlike `pathsOverlap` (used for claim-time
  serialization, where `'**'` deliberately means "could touch anything"),
  `intersectPaths` strips it from both sides first — reporting the sentinel as
  a "conflicting path" would name a file nobody touched.
- **Directory-vs-file overlap is handled** via the same prefix rule as
  `pathsOverlap` (`pb.startsWith(pa + '/') || pa.startsWith(pb + '/')`, after
  stripping trailing separators).
- **Renames are not handled, and nothing claims they are.** The touch sets are
  static path lists from `workers.observedTouches` / `tasks.pathManifest`; a
  file renamed between when a base-side PR merged and when the subject PR's
  touches were recorded won't match by string equality, so a real conflict
  through a rename can go unreported. This is a data-availability limit of
  "diff two path lists," not a bug in `intersectPaths` itself — and the
  caller never overclaims: when no path in either set intersects,
  `buildConflictBecause` says "no stored touch set... overlaps" rather than
  "no conflict," and when the subject's own scope is undeclared it says so
  explicitly instead of running the comparison at all.

### 8. `MissionStateViewBrand` — sole producer confirmed

`grep` across `apps/web/src` and `packages/core` for `as MissionStateView` or
`MissionStateViewBrand` outside `mission-state-view.ts` itself returns
nothing. `deriveMissionStateView` is the only function that returns the brand
key, tests construct views by calling it (never by casting a literal), and no
helper re-opens the type with an `as` escape hatch.
